/** UV unwrapping for 3D Nowdz (docs/BLENDER-LITE.md, "UV tools").
 *
 * Each method writes `uv` on the chosen faces of a mesh and leaves the others
 * alone; the caller sets `t` (which texture) and wraps the change in an undo
 * step. Faces are split into islands (connected pieces laid flat together),
 * each island is flattened onto a plane, and the islands are packed into the
 * 0..1 square, scaled together so texture detail stays even across the model.
 *
 * - Project from View: the faces as the camera sees them, fitted to the square.
 * - Cube: each face onto the cube side its normal points at most.
 * - Smart UV Project: faces grouped while their normals stay within an angle of
 *   the group's first face, each group flattened along its average normal.
 * - Reset: every face fills the whole square (quads corner to corner).
 * - Unwrap: each connected piece of the faces lies flat in one piece, keeping
 *   its shape (least squares conformal map); see unwrapIslands.
 *
 * `unwrapParts` lays out several parts together (one texture for a whole
 * character): each target is {mesh, faces, points?}, points being the mesh's
 * points in world space so parts of different scale get even texture detail.
 *
 * The UV editor's moves (move, scale, rotate selected corners) are here too. */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 1e-12 ? a.map(v => v / l) : [0, 0, 1]; };

function normalOf(mesh, f) {
  let n = [0, 0, 0];
  for (let i = 0; i < f.v.length; i++) { const a = mesh.verts[f.v[i]], b = mesh.verts[f.v[(i + 1) % f.v.length]]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
  return unit(n);
}
const area = (mesh, f) => { let n = [0, 0, 0]; for (let i = 1; i + 1 < f.v.length; i++) { const c = cross(sub(mesh.verts[f.v[i]], mesh.verts[f.v[0]]), sub(mesh.verts[f.v[i + 1]], mesh.verts[f.v[0]])); n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]]; } return len(n) / 2; };
/** Two axes across a plane with normal n (u to the right, v up when n faces you). */
function planeAxes(n) {
  const up = Math.abs(n[1]) > .9 ? [0, 0, -Math.sign(n[1])] : [0, 1, 0];
  const u = unit(cross(up, n)), v = cross(n, u);
  return [u, v];
}

/** Faces connected through shared edges, within `faces` (indices), as arrays. */
function pieces(mesh, faces, joins = () => true) {
  const list = [...faces], inSet = new Set(list), byEdge = new Map(), key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (const fi of list) mesh.faces[fi].v.forEach((a, i, v) => { const k = key(a, v[(i + 1) % v.length]); if (!byEdge.has(k)) byEdge.set(k, []); byEdge.get(k).push(fi); });
  const seen = new Set(), out = [];
  for (const start of list) {
    if (seen.has(start)) continue;
    const island = [start]; seen.add(start);
    for (let q = 0; q < island.length; q++) {
      const fi = island[q], v = mesh.faces[fi].v;
      v.forEach((a, i) => { for (const g of byEdge.get(key(a, v[(i + 1) % v.length])) ?? []) if (!seen.has(g) && inSet.has(g) && joins(island[0], g, island)) { seen.add(g); island.push(g); } });
    }
    out.push(island);
  }
  return out;
}

/** Lay islands out in the square: shelves of islands sorted tallest first,
 * every island scaled by the same factor, with a small margin between them.
 * `width` narrows the box (0.5 for the half of a mirrored part); islands in
 * `pinned` start a shelf of their own at the box's left edge, with no margin there. */
export function packIslands(islands, margin = .02, {width = 1, pinned = new Set()} = {}) {
  const boxes = islands.map(corners => {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of corners) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    return {corners, lo, w: Math.max(hi[0] - lo[0], 1e-9), h: Math.max(hi[1] - lo[1], 1e-9), pin: pinned.has(corners)};
  });
  if (!boxes.length) return;
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0), maxW = Math.max(...boxes.map(b => b.w));
  const order = [...boxes].sort((p, q) => (q.pin - p.pin) || (q.h - p.h)), left = pinned.size ? 0 : margin;
  // Try shelf widths from tight to loose and keep the layout that fills the box best.
  let best = null;
  for (let k = 0; k <= 12; k++) {
    const shelfW = Math.max(maxW, Math.sqrt(total * width) * (0.8 + k * .1)), gap = margin * Math.sqrt(total);
    let x = 0, y = 0, shelf = 0, usedW = 0; const at = [];
    for (const b of order) {
      if (x > 0 && (b.pin || x + b.w > shelfW)) { x = 0; y += shelf + gap; shelf = 0; }
      at.push([b, x, y]); x += b.w + gap; shelf = Math.max(shelf, b.h); usedW = Math.max(usedW, x - gap);
    }
    const scale = Math.min((width - left - margin) / usedW, (1 - 2 * margin) / (y + shelf));
    if (!best || scale > best.scale) best = {scale, at};
  }
  const s = best.scale;
  for (const [b, x, y] of best.at) for (const p of b.corners) { p[0] = left + (p[0] - b.lo[0] + x) * s; p[1] = margin + (p[1] - b.lo[1] + y) * s; }
}

/** Flatten an island along normal n: one UV per corner, shared points shared. */
function flatten(mesh, island, n, points = mesh.verts) {
  const [u, v] = planeAxes(n), corners = [];
  for (const fi of island) { const f = mesh.faces[fi]; f.uv = f.v.map(i => { const p = points[i], c = [dot(p, u), dot(p, v)]; corners.push(c); return c; }); }
  return corners;
}
/** Turn an island so its widest direction lies along U (fills the square better). */
function upright(corners) {
  let best = null;
  for (let step = 0; step < 18; step++) {
    const a = step * Math.PI / 36, c = Math.cos(a), s = Math.sin(a);
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of corners) { const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c; lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
    const size = (hi[0] - lo[0]) * (hi[1] - lo[1]);
    if (!best || size < best.size - 1e-12) best = {size, a};
  }
  const c = Math.cos(best.a), s = Math.sin(best.a);
  for (const p of corners) { const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c; p[0] = x; p[1] = y; }
}
// ---------- Unwrap: one island per connected piece, laid flat conformally ----------

/** Least squares conformal map (Lévy et al. 2002) of triangles `tris` ([a, b, c] point ids) with
 * `points` in 3D. `pins`: Map id → [u, v]; `onLine`: ids held on u = 0 with v free. Returns
 * Map id → [u, v], or null when the system can't be solved. Solved by Jacobi-preconditioned
 * conjugate gradients on the normal equations, which stay small and sparse for a selection. */
export function conformalMap(points, tris, pins, onLine = new Set()) {
  const ids = [...new Set(tris.flat())], at = new Map(ids.map((id, i) => [id, i])), n = ids.length;
  // Unknown k = 2 * vertex + (0 for u, 1 for v); fixed ones carry their value instead of an index.
  const index = new Int32Array(2 * n).fill(-1), value = new Float64Array(2 * n);
  let free = 0;
  ids.forEach((id, i) => {
    const pin = pins.get(id);
    if (pin) { value[2 * i] = pin[0]; value[2 * i + 1] = pin[1]; return; }
    if (onLine.has(id)) value[2 * i] = 0; else index[2 * i] = free++;
    index[2 * i + 1] = free++;
  });
  if (!free) return new Map(ids.map((id, i) => [id, [value[2 * i], value[2 * i + 1]]]));
  const rows = Array.from({length: free}, () => new Map()), rhs = new Float64Array(free);
  const add = (coef) => {
    let fixed = 0;
    for (const [k, c] of coef) if (index[k] < 0) fixed += c * value[k];
    for (const [k, c] of coef) {
      const i = index[k]; if (i < 0) continue;
      rhs[i] -= c * fixed;
      for (const [k2, c2] of coef) { const j = index[k2]; if (j >= 0) rows[i].set(j, (rows[i].get(j) ?? 0) + c * c2); }
    }
  };
  for (const [a, b, c] of tris) {
    const pa = points[a], e1 = sub(points[b], pa), e2 = sub(points[c], pa), nrm = cross(e1, e2), d = len(nrm), l1 = len(e1);
    if (d < 1e-14 || l1 < 1e-12) continue;
    const x = e1.map(v => v / l1), y = unit(cross(nrm, x));
    const loc = [[0, 0], [l1, 0], [dot(e2, x), dot(e2, y)]], vs = [a, b, c].map(id => at.get(id)), w = 1 / Math.sqrt(d);
    const W = [0, 1, 2].map(j => { const k = loc[(j + 2) % 3], l = loc[(j + 1) % 3]; return [(k[0] - l[0]) * w, (k[1] - l[1]) * w]; });
    add(vs.flatMap((v, j) => [[2 * v, W[j][0]], [2 * v + 1, -W[j][1]]]));
    add(vs.flatMap((v, j) => [[2 * v, W[j][1]], [2 * v + 1, W[j][0]]]));
  }
  const cols = rows.map(r => [Int32Array.from(r.keys()), Float64Array.from(r.values())]);
  const diag = rows.map((r, i) => r.get(i) || 1), mul = (v, out) => { for (let i = 0; i < free; i++) { const [c, x] = cols[i]; let s = 0; for (let k = 0; k < c.length; k++) s += x[k] * v[c[k]]; out[i] = s; } };
  const sol = new Float64Array(free), r = Float64Array.from(rhs), z = r.map((v, i) => v / diag[i]), p = Float64Array.from(z), q = new Float64Array(free);
  let rz = r.reduce((s, v, i) => s + v * z[i], 0);
  const stop = 1e-20 * Math.max(1e-30, rhs.reduce((s, v) => s + v * v, 0));
  for (let it = 0; it < 4 * free + 200 && r.reduce((s, v) => s + v * v, 0) > stop; it++) {
    mul(p, q);
    const pq = p.reduce((s, v, i) => s + v * q[i], 0); if (!(pq > 0)) break;
    const alpha = rz / pq;
    for (let i = 0; i < free; i++) { sol[i] += alpha * p[i]; r[i] -= alpha * q[i]; z[i] = r[i] / diag[i]; }
    const next = r.reduce((s, v, i) => s + v * z[i], 0), beta = next / rz; rz = next;
    for (let i = 0; i < free; i++) p[i] = z[i] + beta * p[i];
  }
  if (!sol.every(Number.isFinite)) return null;
  return new Map(ids.map((id, i) => [id, [0, 1].map(k => (index[2 * i + k] < 0 ? value[2 * i + k] : sol[index[2 * i + k]]))]));
}

const triangles = (mesh, island) => island.flatMap(fi => { const v = mesh.faces[fi].v; return v.slice(1, -1).map((_, i) => [v[0], v[i + 1], v[i + 2]]); });
/** Points on the open border of a piece (edges used by one face of it). */
function borderOf(mesh, island) {
  const uses = new Map(), key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (const fi of island) mesh.faces[fi].v.forEach((a, i, v) => { const k = key(a, v[(i + 1) % v.length]); uses.set(k, (uses.get(k) ?? 0) + 1); });
  return new Set([...uses].filter(([, c]) => c === 1).flatMap(([k]) => k.split(',').map(Number)));
}
/** The two points of `ids` farthest apart (two sweeps). */
function farPair(points, ids) {
  const list = [...ids], far = from => list.reduce((b, id) => len(sub(points[id], points[from])) > len(sub(points[b], points[from])) ? id : b, list[0]);
  const a = far(list[0]); return [a, far(a)];
}
/** Turn a laid-out piece so the way up on the model is up in the texture, and size it to its area on the model. */
function settle(uv, points, island, mesh) {
  const ids = [...uv.keys()];
  // Fit world height y ≈ αu + βv + γ; (α, β) is where up points in the texture.
  let su = 0, sv = 0, sy = 0; for (const id of ids) { su += uv.get(id)[0]; sv += uv.get(id)[1]; sy += points[id][1]; }
  su /= ids.length; sv /= ids.length; sy /= ids.length;
  let uu = 0, uvv = 0, vv = 0, uy = 0, vy = 0;
  for (const id of ids) { const [u, v] = uv.get(id), du = u - su, dv = v - sv, dy = points[id][1] - sy; uu += du * du; uvv += du * dv; vv += dv * dv; uy += du * dy; vy += dv * dy; }
  const det = uu * vv - uvv * uvv;
  const turn = det > 1e-18 ? Math.PI / 2 - Math.atan2((uu * vy - uvv * uy) / det, (vv * uy - uvv * vy) / det) : 0;
  let flat = 0; for (const [a, b, c] of triangles(mesh, island)) flat += len(cross(sub(points[b], points[a]), sub(points[c], points[a]))) / 2;
  const turned = new Map(ids.map(id => { const [u, v] = uv.get(id); return [id, [u * Math.cos(turn) - v * Math.sin(turn), u * Math.sin(turn) + v * Math.cos(turn)]]; }));
  let laid = 0; for (const [a, b, c] of triangles(mesh, island)) { const p = turned.get(a), q = turned.get(b), r = turned.get(c); laid += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2; }
  const k = laid > 1e-18 ? Math.sqrt(flat / laid) : 1;
  for (const p of turned.values()) { p[0] *= k; p[1] *= k; }
  return turned;
}
/** Unwrap islands: each connected piece of the faces lies flat in one piece, keeping its shape
 * (conformal). On a mirrored part (`mirror`, points in world space with the middle at x = 0) a
 * piece reaching the middle keeps its middle points on one straight line, so the piece and its
 * mirrored copy meet there as one face. A closed piece can't lie flat in one piece and falls back
 * to Smart UV Project. Returns [corners, {middle, side}] per island. */
function unwrapIslands(mesh, faces, points, mirror, tolerance = 1e-4) {
  const out = [];
  for (const island of pieces(mesh, faces)) {
    const border = borderOf(mesh, island), tris = triangles(mesh, island);
    const middle = mirror ? new Set([...new Set(tris.flat())].filter(id => Math.abs(points[id][0]) <= tolerance)) : new Set();
    const onMiddle = middle.size >= 2 && [...border].some(id => !middle.has(id));
    let uv = null;
    if (onMiddle) {
      const ends = [...middle].sort((a, b) => points[a][1] - points[b][1]), lo = ends[0], hi = ends.at(-1);
      uv = conformalMap(points, tris, new Map([[lo, [0, 0]], [hi, [0, Math.max(len(sub(points[hi], points[lo])), 1e-6)]]]), middle);
    } else if (border.size >= 2) {
      const [a, b] = farPair(points, border);
      uv = conformalMap(points, tris, new Map([[a, [0, 0]], [b, [Math.max(len(sub(points[b], points[a])), 1e-6), 0]]]));
    }
    if (!uv) { for (const corners of islandsOf('smart', {mesh, faces: new Set(island), points})) out.push([corners, {middle: false}]); continue; }
    if (onMiddle) {
      // The pins already stand it upright with the middle on u = 0; only its size changes.
      let flat = 0, laid = 0;
      for (const [a, b, c] of tris) { flat += len(cross(sub(points[b], points[a]), sub(points[c], points[a]))) / 2; const p = uv.get(a), q = uv.get(b), r = uv.get(c); laid += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2; }
      const k = laid > 1e-18 ? Math.sqrt(flat / laid) : 1; for (const p of uv.values()) { p[0] *= k; p[1] *= k; }
    } else uv = settle(uv, points, island, mesh);
    for (const fi of island) { const f = mesh.faces[fi]; f.uv = f.v.map(i => uv.get(i)); }
    let side = 0; if (onMiddle) for (const p of uv.values()) side += p[0];
    out.push([[...uv.values()], {middle: onMiddle, side: Math.sign(side) || 1}]);
  }
  return out;
}

/** Shared corner arrays are fine while packing; each face then gets its own copies. */
function detach(mesh, faces) { for (const fi of faces) { const f = mesh.faces[fi]; if (f.uv) f.uv = f.uv.map(p => [p[0], p[1]]); } }

/** Islands of one target for a method (unpacked corner arrays, shared within each island). */
function islandsOf(kind, {mesh, faces, points = mesh.verts}, {angle = 66, project} = {}) {
  const view = {verts: points, faces: mesh.faces};
  if (kind === 'cube') {
    const side = fi => { const n = normalOf(view, mesh.faces[fi]), a = n.map(Math.abs), k = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2; return [k, Math.sign(n[k]) || 1]; };
    return pieces(mesh, faces, (seed, g) => String(side(seed)) === String(side(g))).map(island => { const [k, s] = side(island[0]), n = [0, 0, 0]; n[k] = s; return flatten(mesh, island, n, points); });
  }
  if (kind === 'smart') {
    const limit = Math.cos(angle * Math.PI / 180), normals = new Map([...faces].map(fi => [fi, normalOf(view, mesh.faces[fi])]));
    return pieces(mesh, faces, (seed, g) => dot(normals.get(seed), normals.get(g)) >= limit).map(island => {
      let n = [0, 0, 0]; for (const fi of island) { const w = area(view, mesh.faces[fi]), m = normals.get(fi); n = [n[0] + m[0] * w, n[1] + m[1] * w, n[2] + m[2] * w]; }
      const corners = flatten(mesh, island, unit(len(n) > 1e-12 ? n : normals.get(island[0])), points);
      upright(corners); return corners;
    });
  }
  if (kind === 'view') {
    const corners = [];
    for (const fi of faces) { const f = mesh.faces[fi]; f.uv = f.v.map(i => { const [x, y] = project(points[i]); const c = [x, -y]; corners.push(c); return c; }); }
    return [corners];
  }
  throw new Error(`Unknown unwrap method ${kind}`);
}
/** Unwrap several targets ({mesh, faces, points?, mirror?, mirrorU?}) into one square. Project
 * from View keeps all of them as one picture; the others pack every island. `unwrap` is Blender's
 * Unwrap: one island per connected piece (see unwrapIslands).
 *
 * A single target with `mirrorU` (Blender's Mirror U: the mirrored copy reads its UVs at 1 - u)
 * is laid out in the right half of the square, so the copy fills the left half: pieces reaching
 * the middle stand on u = 0.5, and one whose half lies on the left of its middle line is placed
 * by its reflection and reflected back, so it and its copy make one face across the middle. */
export function unwrapParts(kind, targets, {angle = 66, margin = .02, project} = {}) {
  if (kind === 'reset') { for (const t of targets) resetUVs(t.mesh, t.faces); return; }
  const half = targets.length === 1 && targets[0].mirrorU;
  let islands, pinned = new Set(), flipped = [];
  if (kind === 'unwrap') {
    const laid = targets.flatMap(t => unwrapIslands(t.mesh, t.faces, t.points ?? t.mesh.verts, Boolean(t.mirror)));
    islands = laid.map(([corners]) => corners);
    if (half) for (const [corners, {middle, side}] of laid) {
      if (!middle) continue;
      pinned.add(corners);
      if (side < 0) { for (const p of corners) p[0] = -p[0]; flipped.push(corners); }
    }
  } else islands = targets.flatMap(t => islandsOf(kind, t, {angle, project}));
  if (kind === 'view') islands = [islands.flat()];
  packIslands(islands, margin, half ? {width: .5, pinned} : {});
  if (half) {
    for (const corners of islands) for (const p of corners) p[0] += .5;
    for (const corners of flipped) for (const p of corners) p[0] = 1 - p[0];
  }
  for (const t of targets) detach(t.mesh, t.faces);
}
/** Cube projection: faces onto the cube side their normal points at most, islands packed. */
export const cubeProject = (mesh, faces) => unwrapParts('cube', [{mesh, faces}]);
/** Smart UV Project: faces join an island while their normal stays within
 * `angle` degrees of the island's first face; each island lies flat along its
 * average normal, turned to fill its box, then all are packed. */
export const smartProject = (mesh, faces, options = {}) => unwrapParts('smart', [{mesh, faces}], options);
/** Project from View: `project` maps a point to the screen ([x, y], y down), and
 * the faces are fitted to the square as the camera sees them (keeping shape). */
export const projectFromView = (mesh, faces, project, options = {}) => unwrapParts('view', [{mesh, faces}], {...options, project});
/** Reset: each face fills the square on its own (quads corner to corner, others as a regular shape). */
export function resetUVs(mesh, faces) {
  for (const fi of faces) {
    const f = mesh.faces[fi], n = f.v.length;
    f.uv = n === 4 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : f.v.map((_, i) => { const a = -Math.PI / 2 - Math.PI / n + i * 2 * Math.PI / n; return [.5 + .5 * Math.cos(a), .5 + .5 * Math.sin(a)]; });
  }
}

// ---------- the UV editor's selection and moves ----------

/** Corner ids ("face:corner") of `faces` whose UV is within `eps` of `uv` and,
 * with `point`, that belong to the same mesh point (Blender's shared location). */
export function cornersAt(mesh, faces, uv, eps = 1e-6) {
  const out = [];
  for (const fi of faces) { const f = mesh.faces[fi]; f.uv?.forEach((p, k) => { if (Math.abs(p[0] - uv[0]) <= eps && Math.abs(p[1] - uv[1]) <= eps) out.push(`${fi}:${k}`); }); }
  return out;
}
/** Every corner joined to `corners` through UV edges (Select linked, L). */
export function linkedCorners(mesh, faces, corners) {
  const at = (fi, k) => mesh.faces[fi].uv[k], key = (fi, k) => `${mesh.faces[fi].v[k]}@${at(fi, k).map(x => x.toFixed(6))}`;
  // Corners sharing a point and a UV are one UV point; a face joins its points together.
  const groups = new Map(), byPoint = new Map();
  for (const fi of faces) { const f = mesh.faces[fi]; if (!f.uv) continue; f.uv.forEach((_, k) => { const g = key(fi, k); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(`${fi}:${k}`); byPoint.set(`${fi}:${k}`, g); }); }
  const seen = new Set(), queue = [...corners].map(c => byPoint.get(c)).filter(Boolean);
  queue.forEach(g => seen.add(g));
  for (let q = 0; q < queue.length; q++) for (const c of groups.get(queue[q])) {
    const fi = Number(c.split(':')[0]);
    mesh.faces[fi].uv.forEach((_, k) => { const g = key(fi, k); if (!seen.has(g)) { seen.add(g); queue.push(g); } });
  }
  return new Set([...seen].flatMap(g => groups.get(g)));
}
/** The UVs of corner ids, as [face, corner, uv] for moving. */
export function cornerList(mesh, ids) {
  return [...ids].map(id => { const [fi, k] = id.split(':').map(Number); return [fi, k, mesh.faces[fi]?.uv?.[k]]; }).filter(([, , uv]) => uv);
}
/** Middle of the selected corners' UVs. */
export function cornerCentre(mesh, ids) {
  const list = cornerList(mesh, ids); if (!list.length) return [0, 0];
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [, , p] of list) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
}
/** Move, scale or rotate corners from their starting UVs (`start`: Map id → [u, v]). */
export function transformCorners(mesh, start, {move = [0, 0], scale = [1, 1], angle = 0, pivot = [0, 0]} = {}) {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (const [id, p] of start) {
    const [fi, k] = id.split(':').map(Number), f = mesh.faces[fi]; if (!f?.uv?.[k]) continue;
    let x = (p[0] - pivot[0]) * scale[0], y = (p[1] - pivot[1]) * scale[1];
    [x, y] = [x * c - y * s, x * s + y * c];
    f.uv[k] = [x + pivot[0] + move[0], y + pivot[1] + move[1]];
  }
}
