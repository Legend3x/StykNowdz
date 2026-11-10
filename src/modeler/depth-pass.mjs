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

const VERTEX = `
attribute vec3 position;
attribute vec4 color;
varying vec4 tint;
void main() { tint = color; gl_Position = vec4(position.xy, position.z * 2.0 - 1.0, 1.0); }`;
const FRAGMENT = `
precision mediump float;
varying vec4 tint;
void main() { gl_FragColor = tint; }`;

export function createDepthPass(makeCanvas = () => (typeof document === 'undefined' ? null : document.createElement('canvas'))) {
  let canvas = null, gl = null, program = null, buffers = null, broken = false;

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
    buffers = {position: gl.createBuffer(), color: gl.createBuffer()};
    return true;
  }

  function upload(positions, colors) {
    const at = gl.getAttribLocation(program, 'position'), tint = gl.getAttribLocation(program, 'color');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(tint); gl.vertexAttribPointer(tint, 4, gl.UNSIGNED_BYTE, true, 0, 0);
  }

  return {
    /** True once WebGL turned out to be unavailable (callers sort faces instead). */
    get unavailable() { return broken; },
    /** Draw `triangles` and optional `lines` (each {positions: Float32Array xyz,
     * colors: Uint8Array rgba} in clip x/y and 0..1 depth) at `width`×`height`
     * pixels. Returns the canvas to lay over the view, or null. */
    draw(width, height, triangles, lines = null) {
      if (broken || (!gl && !setup())) return null;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
      // Fills sit a hair behind their own wire lines.
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
      if (triangles.positions.length) { upload(triangles.positions, triangles.colors); gl.drawArrays(gl.TRIANGLES, 0, triangles.positions.length / 3); }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (lines?.positions.length) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        upload(lines.positions, lines.colors); gl.drawArrays(gl.LINES, 0, lines.positions.length / 3);
        gl.depthMask(true);
      }
      return canvas;
    },
  };
}

/** Growable buffers of coloured vertices for one draw. */
export function vertexBatch() {
  let positions = new Float32Array(3 * 4096), colors = new Uint8Array(4 * 4096), n = 0;
  const grow = () => { const p = new Float32Array(positions.length * 2), c = new Uint8Array(colors.length * 2); p.set(positions); c.set(colors); positions = p; colors = c; };
  return {
    push(x, y, d, [r, g, b], a = 255) {
      if ((n + 1) * 3 > positions.length) grow();
      positions[n * 3] = x; positions[n * 3 + 1] = y; positions[n * 3 + 2] = d;
      // Premultiplied, as the canvas is.
      colors[n * 4] = r * a / 255; colors[n * 4 + 1] = g * a / 255; colors[n * 4 + 2] = b * a / 255; colors[n * 4 + 3] = a; n++;
    },
    get count() { return n; },
    done() { return {positions: positions.subarray(0, n * 3), colors: colors.subarray(0, n * 4)}; },
  };
}
