/** 3D Nowdz viewport: orbit camera, projection and drawing on a 2D
 * canvas. Faces are lit from the camera and painted back to front; overlays
 * (grid, cage, bones, gizmos) draw on top. No app state lives here. */
import {sub, dot, cross, normalize, add, scale, length, isOpenMesh} from './mesh.mjs';
import {about, rotationAxis, transformPoint} from './matrix.mjs';
import {toonLight, toonThreshold, shadowColor, inkColor} from '../toon-shading.mjs';
import {vertexBatch} from './depth-pass.mjs';

export const VIEW_COLORS = Object.freeze({
  background: '#e8eaee', grid: 'rgba(40,48,60,.10)', gridStrong: 'rgba(40,48,60,.22)', axisX: 'rgba(214,72,72,.75)', axisZ: 'rgba(60,110,214,.75)',
  wire: 'rgba(20,24,32,.35)', cage: 'rgba(20,24,32,.75)', vertex: '#1d2230', selected: '#ff8a1f', active: '#ffd33d', faceSelected: 'rgba(255,138,31,.28)',
  outline: '#ff8a1f', bone: '#8b93a6', boneSelected: '#ff8a1f', boneHead: '#4a5163', hover: 'rgba(13,153,255,.9)', ring: '#0d99ff', wireTrace: '#1d2230',
});

export function defaultCamera() { return {yaw: .5, pitch: .25, dist: 4.2, target: [0, 1, 0], ortho: false, fov: .7}; }

/** Camera axes and projection for a canvas of size w×h. */
const NEAR = .02;
export function cameraFrame(camera, w, h) {
  const {yaw, pitch, dist, target} = camera;
  const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)], up = cross(back, right), eye = add(target, scale(back, dist));
  const focal = h / (2 * Math.tan(camera.fov / 2)), orthoScale = focal / dist;
  const toCamera = p => { const d = sub(p, target); return [dot(d, right), dot(d, up), dot(d, back)]; };
  // `d` is the depth-buffer value: 0 near … 1 far, affine in screen space (so
  // it interpolates exactly across a face): 1 − near/distance in perspective.
  const project = p => {
    const c = toCamera(p);
    if (camera.ortho) return {x: w / 2 + c[0] * orthoScale, y: h / 2 - c[1] * orthoScale, z: c[2], d: Math.max(0, Math.min(1, .5 - c[2] / (4 * dist + 200))), ok: true};
    const depth = dist - c[2];
    if (depth < NEAR) return {x: NaN, y: NaN, z: c[2], ok: false};
    return {x: w / 2 + c[0] * focal / depth, y: h / 2 - c[1] * focal / depth, z: c[2], d: 1 - NEAR / depth, ok: true};
  };
  /** World units per screen pixel at the depth of point p. */
  const unitsPerPixel = p => camera.ortho ? 1 / orthoScale : Math.max(.02, dist - toCamera(p)[2]) / focal;
  /** The direction from p toward the eye (for facing tests). */
  const toEye = p => camera.ortho ? back : normalize(sub(eye, p));
  return {right, up, back, eye, project, toCamera, unitsPerPixel, toEye, w, h, ortho: Boolean(camera.ortho)};
}

/** Named views: front looks at the model's front (+Z), right from +X, top from above. */
export const VIEWS = {front: [0, 0], back: [Math.PI, 0], right: [Math.PI / 2, 0], left: [-Math.PI / 2, 0], top: [0, Math.PI / 2 - 1e-4], bottom: [0, -Math.PI / 2 + 1e-4]};
/** Where a reference image stands (world corners: top-left, top-right, bottom-left).
 * The front image is a wall 2 units behind the middle, facing the Front view; the
 * side image a wall 2 units to the left (-X), facing the Right view. Left/right
 * and up/down move it as seen from its own view; its bottom edge is at up/down. */
export const REFERENCE_DISTANCE = 2;
export function referenceCorners(ref, aspect) {
  const height = ref.height ?? 2, width = height * aspect, x = ref.offsetX ?? 0, y = ref.offsetY ?? 0, d = REFERENCE_DISTANCE;
  // Left and right edges as seen from the image's own view (Flip swaps them).
  let [left, right] = ref.view === 'side' ? [[-d, 0, -x + width / 2], [-d, 0, -x - width / 2]] : [[x - width / 2, 0, -d], [x + width / 2, 0, -d]];
  if (ref.flip) [left, right] = [right, left];
  const at = (p, h) => [p[0], h, p[2]];
  return {tl: at(left, y + height), tr: at(right, y + height), bl: at(left, y)};
}

/** Draw an image on a flat quad in the scene. A flat view maps it with one affine
 * transform; a perspective view in small pieces (drawn opaque on a scratch canvas,
 * then laid on at the image's opacity, so the pieces' seams don't show). */
let scratch = null;
function drawImagePlane(ctx, frame, img, {tl, tr, bl}, opacity) {
  const iw = img.naturalWidth, ih = img.naturalHeight, n = frame.ortho ? 1 : 12;
  const across = sub(tr, tl), down = sub(bl, tl), at = (u, v) => frame.project(add(tl, add(scale(across, u), scale(down, v))));
  const grid = [];
  for (let j = 0; j <= n; j++) { const row = []; for (let i = 0; i <= n; i++) row.push(at(i / n, j / n)); grid.push(row); }
  if (grid.flat().every(p => !p.ok)) return;
  // The scratch canvas matches the screen's pixels (k: the canvas's device-pixel scale).
  const {w, h} = frame, k = ctx.getTransform?.().a || 1, W = Math.ceil(w * k), H = Math.ceil(h * k);
  if (!scratch) scratch = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), {width: W, height: H});
  if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; }
  const g = scratch.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(k, 0, 0, k, 0, 0);
  // One triangle of the image (source corners s) onto the screen (corners d).
  const piece = (s0, s1, s2, d0, d1, d2) => {
    if (!d0.ok || !d1.ok || !d2.ok) return;
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1.x - d0.x) * (s2[1] - s0[1]) - (d2.x - d0.x) * (s1[1] - s0[1])) / den;
    const b = ((d1.y - d0.y) * (s2[1] - s0[1]) - (d2.y - d0.y) * (s1[1] - s0[1])) / den;
    const c = ((d2.x - d0.x) * (s1[0] - s0[0]) - (d1.x - d0.x) * (s2[0] - s0[0])) / den;
    const d = ((d2.y - d0.y) * (s1[0] - s0[0]) - (d1.y - d0.y) * (s2[0] - s0[0])) / den;
    g.save();
    // Clip a hair outside the triangle so neighbouring pieces overlap instead of leaving gaps.
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3, grow = q => { const dx = q.x - cx, dy = q.y - cy, l = Math.hypot(dx, dy) || 1; return [q.x + dx / l * .75, q.y + dy / l * .75]; };
    g.beginPath(); g.moveTo(...grow(d0)); g.lineTo(...grow(d1)); g.lineTo(...grow(d2)); g.closePath(); g.clip();
    g.setTransform(a * k, b * k, c * k, d * k, (d0.x - a * s0[0] - c * s0[1]) * k, (d0.y - b * s0[0] - d * s0[1]) * k);
    g.drawImage(img, 0, 0);
    g.restore();
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const s = (u, v) => [u / n * iw, v / n * ih];
    const p00 = grid[j][i], p10 = grid[j][i + 1], p01 = grid[j + 1][i], p11 = grid[j + 1][i + 1];
    piece(s(i, j), s(i + 1, j), s(i, j + 1), p00, p10, p01);
    piece(s(i + 1, j), s(i + 1, j + 1), s(i, j + 1), p10, p11, p01);
  }
  ctx.save(); ctx.globalAlpha = opacity; ctx.drawImage(scratch, 0, 0, w, h); ctx.restore();
}

const shadeRgb = (rgb, k) => rgb.map(v => Math.max(0, Math.min(255, Math.round(v * k))));
const css = rgb => `rgb(${rgb.join(',')})`;
const WIRE_RGBA = (([r, g, b, a]) => [[+r, +g, +b], Math.round(+a * 255)])(VIEW_COLORS.wire.match(/[\d.]+/g));

/**
 * Paint the scene. `items` are {mesh, palette, partId, highlight, weights?}
 * with world-space meshes. Returns the painted polygon list (front last) for picking.
 */
// Area-weighted unit vertex normals (or custom ones), cached per (immutable) evaluated mesh.
const normalCache = new WeakMap();
function vertexNormalsOf(mesh) {
  let n = normalCache.get(mesh);
  if (!n) {
    n = mesh.verts.map(() => [0, 0, 0]);
    for (const f of mesh.faces) {
      let s = [0, 0, 0];
      for (let i = 0; i < f.v.length; i++) s = add(s, cross(mesh.verts[f.v[i]], mesh.verts[f.v[(i + 1) % f.v.length]]));
      for (const i of f.v) n[i] = add(n[i], s);
    }
    // Custom shading normals (Edit mode, Shading) replace the smooth ones.
    const custom = mesh.vdata?.normal;
    n = n.map((v, i) => custom?.[i] ? normalize(custom[i]) : normalize(v)); normalCache.set(mesh, n);
  }
  return n;
}

/** Split a screen polygon by per-corner values (≥ 0 lit, < 0 shadow) along the
 * line where the value is 0. Returns [[points, lit], ...]. */
export function splitByShadow(pts, side) {
  if (side.every(v => v >= 0)) return [[pts, true]];
  if (side.every(v => v < 0)) return [[pts, false]];
  const lit = [], dark = [];
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length, a = side[i], b = side[j];
    (a >= 0 ? lit : dark).push(pts[i]);
    if ((a >= 0) !== (b >= 0)) {
      const t = a / (a - b), p = {x: pts[i].x + (pts[j].x - pts[i].x) * t, y: pts[i].y + (pts[j].y - pts[i].y) * t, d: pts[i].d + (pts[j].d - pts[i].d) * t};
      lit.push(p); dark.push(p);
    }
  }
  return [[lit, true], [dark, false]];
}

/** Draw the model. With `toon` (the toon preview) faces are flat colours as on
 * the stage: lit or, when `toon.shadows`, in shadow (toon-shading.mjs), and
 * items marked `hull` are outline shells drawn with their far side only. */
export function paint(ctx, frame, items, {xray = false, wire = false, references = [], showGrid = true, refImages = new Map(), toon = null, depth = null} = {}) {
  const {w, h} = frame;
  ctx.fillStyle = VIEW_COLORS.background; ctx.fillRect(0, 0, w, h);
  // Reference images stand in the scene behind everything, as in Blender: both are
  // visible from any angle, and each faces you square-on in its own view.
  for (const ref of references) {
    const img = refImages.get(ref.id);
    if (!img || !img.complete || !img.naturalWidth) continue;
    const corners = referenceCorners(ref, img.naturalWidth / img.naturalHeight);
    drawImagePlane(ctx, frame, img, corners, ref.opacity ?? .5);
  }
  if (showGrid) drawGrid(ctx, frame);
  const light = normalize(add(add(scale(frame.back, .85), scale(frame.up, .45)), scale(frame.right, .25)));
  // The stage's toon light is fixed to the viewer: x right, y down, z toward the viewer.
  const toonDir = toon?.shadows ? (([x, y, z]) => add(add(scale(frame.right, x), scale(frame.up, -y)), scale(frame.back, z)))(toonLight(toon.turn, toon.height)) : null;
  const cut = toon ? toonThreshold(toon.size) : 0;
  const polys = [];
  for (const item of items) {
    const {mesh} = item, projected = mesh.verts.map(frame.project);
    // Toon shadows use smooth vertex normals, as the stage does.
    const smooth = toonDir ? vertexNormalsOf(mesh) : null;
    // Both sides of an open mesh show, as in Blender (a closed mesh hides its far side anyway).
    const twoSided = item.twoSided ?? openOf(mesh);
    mesh.faces.forEach((face, fi) => {
      const pts = face.v.map(i => projected[i]);
      if (pts.some(p => !p.ok)) return;
      const p0 = mesh.verts[face.v[0]];
      let n = [0, 0, 0];
      for (let i = 0; i < face.v.length; i++) { const a = mesh.verts[face.v[i]], b = mesh.verts[face.v[(i + 1) % face.v.length]]; n = add(n, cross(a, b)); }
      n = normalize(n);
      const facing = dot(n, frame.toEye(p0));
      if (!xray && facing <= 0 && !twoSided) return;
      const z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
      polys.push({pts, z, n, facing, face, fi, item, side: smooth ? face.v.map(i => dot(smooth[i], toonDir) - cut) : null});
    });
  }
  polys.sort((a, b) => a.z - b.z);
  // Opaque views go through the depth buffer, so surfaces passing through each
  // other (hair through a head) meet along the right line; X-ray (see-through)
  // and setups without WebGL fill sorted faces on the canvas instead.
  const zbuffer = depth && !xray && !depth.unavailable, tris = zbuffer ? vertexBatch() : null, lines = zbuffer && wire ? vertexBatch() : null;
  const sx = x => x / w * 2 - 1, sy = y => 1 - y / h * 2;
  ctx.lineJoin = 'round';
  for (const poly of polys) {
    const {item, face} = poly;
    let rgb = item.palette[face.c] ?? item.palette[0] ?? [200, 200, 200];
    if (face.ink !== undefined) rgb = inkColor(rgb, face.ink);
    if (item.weights) rgb = weightColor(item.weights[poly.fi] ?? 0);
    // Toon: flat lit colour, cut along the exact shadow line (as the stage does).
    const pieces = toon && !item.weights
      ? (toonDir && !item.flat && poly.side ? splitByShadow(poly.pts, poly.side) : [[poly.pts, true]]).map(([pts, lit]) => [pts, shadeRgb(lit ? rgb : shadowColor(rgb, toon.strength), 1)])
      : [[poly.pts, shadeRgb(rgb, .42 + .62 * Math.abs(dot(poly.n, light)))]];
    if (zbuffer) {
      for (const [pts, fill] of pieces) for (let i = 1; i + 1 < pts.length; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) tris.push(sx(p.x), sy(p.y), p.d, fill);
      if (lines) poly.pts.forEach((p, i) => { const q = poly.pts[(i + 1) % poly.pts.length]; lines.push(sx(p.x), sy(p.y), p.d, WIRE_RGBA[0], WIRE_RGBA[1]); lines.push(sx(q.x), sy(q.y), q.d, WIRE_RGBA[0], WIRE_RGBA[1]); });
      continue;
    }
    ctx.globalAlpha = xray ? .55 : 1;
    for (const [pts, rgbFill] of pieces) {
      if (pts.length < 3) continue;
      const fill = css(rgbFill);
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      // Hairline seams in the face colour hide gaps between neighbouring faces.
      ctx.strokeStyle = fill; ctx.lineWidth = .6; ctx.stroke();
    }
    if (wire) { ctx.beginPath(); poly.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.strokeStyle = VIEW_COLORS.wire; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (zbuffer) {
    const image = depth.draw(ctx.canvas.width, ctx.canvas.height, tris.done(), lines?.done());
    if (image) ctx.drawImage(image, 0, 0, w, h);
    else return paint(ctx, frame, items, {xray, wire, references, showGrid, refImages, toon, depth: null});
  }
  return polys;
}

// Open or closed is worked out again only when the mesh's faces change (edits
// mostly swap in a new face list or change its size; moving points keeps both).
const openMeshes = new WeakMap();
export function openOf(mesh) {
  let corners = 0; for (const f of mesh.faces) corners += f.v.length;
  const hit = openMeshes.get(mesh.faces);
  if (hit && hit.corners === corners && hit.verts === mesh.verts.length && hit.count === mesh.faces.length) return hit.open;
  const open = isOpenMesh(mesh);
  openMeshes.set(mesh.faces, {corners, verts: mesh.verts.length, count: mesh.faces.length, open});
  return open;
}

/** Blue (0) → green → red (1), as in weight painting. */
export function weightColor(w) {
  const t = Math.max(0, Math.min(1, w));
  return t < .5 ? [40, 80 + 340 * t, 255 - 300 * t] : [40 + 430 * (t - .5), 250 - 400 * (t - .5), 105 - 150 * (t - .5)].map(v => Math.max(0, Math.min(255, v)));
}

function drawGrid(ctx, frame) {
  const span = 6, step = .25;
  for (let i = -span; i <= span + 1e-9; i += step) {
    const strong = Math.abs(i % 1) < 1e-6;
    for (const [a, b] of [[[i, 0, -span], [i, 0, span]], [[-span, 0, i], [span, 0, i]]]) {
      const p = frame.project(a), q = frame.project(b);
      if (!p.ok || !q.ok) continue;
      ctx.strokeStyle = Math.abs(i) < 1e-9 ? (a[0] === i ? VIEW_COLORS.axisZ : VIEW_COLORS.axisX) : strong ? VIEW_COLORS.gridStrong : VIEW_COLORS.grid;
      ctx.lineWidth = Math.abs(i) < 1e-9 ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
  }
}

/** Topmost painted polygon under (x, y). */
/** The face under (x, y): the nearest at that pixel (so a strand of hair in
 * front of a cheek wins even where their whole faces overlap the other way). */
export function pickPolygon(polys, x, y) {
  let best = null, nearest = Infinity;
  for (let i = polys.length - 1; i >= 0; i--) {
    const pts = polys[i].pts;
    if (!insidePolygon(pts, x, y)) continue;
    const d = depthAt(pts, x, y);
    if (d === null) return best ?? polys[i];
    if (d < nearest - 1e-9) { nearest = d; best = polys[i]; }
  }
  return best;
}
/** Depth (0 near … 1 far) of a projected polygon at (x, y), or null if unknown. */
function depthAt(pts, x, y) {
  if (pts.some(p => p.d === undefined)) return null;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[0], b = pts[i], c = pts[i + 1], den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / den, v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / den;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return u * a.d + v * b.d + (1 - u - v) * c.d;
  }
  return pts.reduce((s, p) => s + p.d, 0) / pts.length;
}
export function insidePolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function segmentPixelDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Rotate p about an axis through `pivot` (pure, through the matrix module). */
export const rotateAbout = (p, pivot, axis, angle) => [...transformPoint(about(pivot, rotationAxis(axis, angle)), p)];
export const distance = (a, b) => length(sub(a, b));
