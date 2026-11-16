// Per-pixel depth for the 3D Nowdz viewport.
//
// The viewport works out every face's colour on the CPU (lighting, toon
// shadows split along the exact shadow line, outline shells) and used to fill
// the faces back to front on a 2D canvas. Sorting whole faces can't draw
// surfaces that pass through each other (hair through a head, a collar through
// a neck): one face is always entirely in front. This pass draws the same
// coloured triangles with a hardware depth buffer (WebGL, antialiased) onto a
// scratch canvas that the viewport lays over its background, so every pixel
// shows the nearest surface, as Blender's viewport does.
//
// Depth comes in already mapped to 0 (near) … 1 (far) and affine in screen
// space (1 − near/distance in perspective), so plain interpolation is exact.
// Without WebGL (or after a lost context) draw() returns null and the caller
// falls back to sorting faces.
//
// Textured faces (docs/BLENDER-LITE.md, "Textures and UVs") come in batches,
// one per image: the image times the face's lighting colour, so lighting and
// toon shadows fall across textures as across colours. Each vertex also carries
// its distance from the eye (w; 1 in orthographic views), so UVs are
// interpolated with perspective and textures don't warp across large faces;
// depth is unchanged by it. Untextured faces use a white image. Texels below
// half alpha are cut out (hair cards, lace) instead of blended.

const VERTEX = `
attribute vec3 position;
attribute vec4 color;
attribute vec3 surface;
varying vec4 tint;
varying vec2 uv;
void main() { tint = color; uv = surface.xy; gl_Position = vec4(position.xy, position.z * 2.0 - 1.0, 1.0) * surface.z; }`;
const FRAGMENT = `
precision mediump float;
uniform sampler2D image;
varying vec4 tint;
varying vec2 uv;
void main() {
  vec4 texel = texture2D(image, vec2(fract(uv.x), 1.0 - fract(uv.y)));
  if (texel.a < 0.5) discard;
  gl_FragColor = vec4(texel.rgb * tint.rgb, tint.a);
}`;

export function createDepthPass(makeCanvas = () => (typeof document === 'undefined' ? null : document.createElement('canvas'))) {
  let canvas = null, gl = null, program = null, buffers = null, broken = false, white = null, images = new WeakMap();

  function setup() {
    canvas = makeCanvas();
    gl = canvas?.getContext('webgl', {antialias: true, depth: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false}) ?? null;
    if (!gl) { broken = true; return false; }
    canvas.addEventListener?.('webglcontextlost', event => { event.preventDefault(); broken = true; gl = null; });
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = shader(gl.VERTEX_SHADER, VERTEX), fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    program = vs && fs ? gl.createProgram() : null;
    if (!program) { broken = true; return false; }
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { broken = true; return false; }
    buffers = {position: gl.createBuffer(), color: gl.createBuffer(), surface: gl.createBuffer()};
    white = texture(new Uint8Array([255, 255, 255, 255]));
    images = new WeakMap();
    return true;
  }
  // A GL texture for a 1×1 pixel array or an image (cached per image object; a
  // changed texture is a new image, so stale entries simply stop being used).
  function texture(source) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (source instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Any size works in WebGL 1 without mipmaps; repeat is done in the shader.
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  function imageTexture(img) {
    let t = images.get(img);
    if (!t) { t = texture(img); images.set(img, t); }
    return t;
  }

  function upload(batch) {
    const at = gl.getAttribLocation(program, 'position'), tint = gl.getAttribLocation(program, 'color'), surface = gl.getAttribLocation(program, 'surface');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position); gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color); gl.bufferData(gl.ARRAY_BUFFER, batch.colors, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(tint); gl.vertexAttribPointer(tint, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    if (batch.surface) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.surface); gl.bufferData(gl.ARRAY_BUFFER, batch.surface, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(surface); gl.vertexAttribPointer(surface, 3, gl.FLOAT, false, 0, 0);
    } else { gl.disableVertexAttribArray(surface); gl.vertexAttrib3f(surface, 0, 0, 1); }
  }

  return {
    /** True once WebGL turned out to be unavailable (callers sort faces instead). */
    get unavailable() { return broken; },
    /** Draw `triangles` and optional `lines` (each {positions: Float32Array xyz,
     * colors: Uint8Array rgba} in clip x/y and 0..1 depth) at `width`×`height`
     * pixels, then each of `textured` ([{image, batch}], batches with `surface`:
     * u, v, w per vertex). Returns the canvas to lay over the view, or null. */
    draw(width, height, triangles, lines = null, textured = []) {
      if (broken || (!gl && !setup())) return null;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
      // Fills sit a hair behind their own wire lines.
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
      gl.bindTexture(gl.TEXTURE_2D, white);
      if (triangles.positions.length) { upload(triangles); gl.drawArrays(gl.TRIANGLES, 0, triangles.positions.length / 3); }
      for (const {image, batch} of textured) {
        if (!batch.positions.length) continue;
        gl.bindTexture(gl.TEXTURE_2D, imageTexture(image)); upload(batch); gl.drawArrays(gl.TRIANGLES, 0, batch.positions.length / 3);
      }
      gl.bindTexture(gl.TEXTURE_2D, white);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (lines?.positions.length) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        upload(lines); gl.drawArrays(gl.LINES, 0, lines.positions.length / 3);
        gl.depthMask(true);
      }
      return canvas;
    },
  };
}

/** Growable buffers of coloured vertices for one draw. With `textured`, each
 * vertex also takes its UV and eye distance w (push(..., u, v, w)). */
export function vertexBatch({textured = false} = {}) {
  let positions = new Float32Array(3 * 4096), colors = new Uint8Array(4 * 4096), surface = textured ? new Float32Array(3 * 4096) : null, n = 0;
  const grow = () => {
    const p = new Float32Array(positions.length * 2), c = new Uint8Array(colors.length * 2); p.set(positions); c.set(colors); positions = p; colors = c;
    if (surface) { const s = new Float32Array(surface.length * 2); s.set(surface); surface = s; }
  };
  return {
    push(x, y, d, [r, g, b], a = 255, u = 0, v = 0, w = 1) {
      if ((n + 1) * 3 > positions.length) grow();
      positions[n * 3] = x; positions[n * 3 + 1] = y; positions[n * 3 + 2] = d;
      // Premultiplied, as the canvas is.
      colors[n * 4] = r * a / 255; colors[n * 4 + 1] = g * a / 255; colors[n * 4 + 2] = b * a / 255; colors[n * 4 + 3] = a;
      if (surface) { surface[n * 3] = u; surface[n * 3 + 1] = v; surface[n * 3 + 2] = w; }
      n++;
    },
    get count() { return n; },
    done() { return {positions: positions.subarray(0, n * 3), colors: colors.subarray(0, n * 4), ...(surface ? {surface: surface.subarray(0, n * 3)} : {})}; },
  };
}
