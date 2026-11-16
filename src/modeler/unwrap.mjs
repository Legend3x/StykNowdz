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
 * every island scaled by the same factor, with a small margin between them. */
export function packIslands(islands, margin = .02) {
  const boxes = islands.map(corners => {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of corners) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    return {corners, lo, w: Math.max(hi[0] - lo[0], 1e-9), h: Math.max(hi[1] - lo[1], 1e-9)};
  });
  if (!boxes.length) return;
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0), maxW = Math.max(...boxes.map(b => b.w));
  // Try shelf widths from tight to loose and keep the layout that fills the square best.
  let best = null;
  for (let k = 0; k <= 12; k++) {
    const width = Math.max(maxW, Math.sqrt(total) * (0.8 + k * .1)), gap = margin * Math.sqrt(total);
    let x = 0, y = 0, shelf = 0, usedW = 0; const at = [];
    for (const b of [...boxes].sort((p, q) => q.h - p.h)) {
      if (x > 0 && x + b.w > width) { x = 0; y += shelf + gap; shelf = 0; }
      at.push([b, x, y]); x += b.w + gap; shelf = Math.max(shelf, b.h); usedW = Math.max(usedW, x - gap);
    }
    const side = Math.max(usedW, y + shelf);
    if (!best || side < best.side) best = {side, at};
  }
  const s = (1 - 2 * margin) / best.side;
  for (const [b, x, y] of best.at) for (const p of b.corners) { p[0] = margin + (p[0] - b.lo[0] + x) * s; p[1] = margin + (p[1] - b.lo[1] + y) * s; }
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
/** Unwrap several targets ({mesh, faces, points?}) into one square. Project
 * from View keeps all of them as one picture; the others pack every island. */
export function unwrapParts(kind, targets, {angle = 66, margin = .02, project} = {}) {
  if (kind === 'reset') { for (const t of targets) resetUVs(t.mesh, t.faces); return; }
  const islands = targets.flatMap(t => islandsOf(kind, t, {angle, project}));
  packIslands(kind === 'view' ? [islands.flat()] : islands, margin);
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
