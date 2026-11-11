/** 3D Nowdz (docs/BLENDER-LITE.md): the polygon mesh and its edit
 * operations. A mesh is {verts: [[x, y, z]], faces: [{v: [i, j, k, ...], c}]}
 * in the object's local space: Y up, X right, +Z toward the front view.
 * Faces are counter-clockwise seen from outside and may have any number of
 * corners (quads mostly); `c` is a palette index.
 *
 * While tracing a shape point by point (Blender's "extrude a single vertex"),
 * a mesh may also have `edges` ([[a, b]]: wire edges, lines with no face yet)
 * and `loose` ([i]: single points kept on purpose). Filling or bridging turns
 * wires into faces; the stage only ever shows faces.
 *
 * Data integrity ("Data integrity" in the doc):
 * - Vertex transforms are pure: transformMesh() and the object transforms use
 *   the matrix module and return new values; nothing is changed in place.
 * - Every topology edit (extrude, inset, loop cut, merge, delete...) is
 *   atomic: it runs, then validateMesh() checks the half-edge rules. If any
 *   rule breaks, the mesh is restored exactly and a TopologyError (with the
 *   printed report) is thrown. Edits return the new selection where that
 *   matters. */
import {fromTRS, invert, transformPoint, transformDirection, determinant3} from './matrix.mjs';
import {assertValidMesh} from './topology.mjs';

/** Run a topology edit atomically: validate afterwards, roll back and throw if it broke a rule. */
function atomic(operation, edit) {
  const run = (mesh, ...args) => {
    const before = {verts: mesh.verts, faces: mesh.faces, edges: mesh.edges, loose: mesh.loose, vdata: mesh.vdata};
    // Work on fresh arrays so a failed edit can't leave half-written data behind.
    mesh.verts = mesh.verts.map(v => v.slice()); mesh.faces = mesh.faces.map(f => ({v: f.v.slice(), c: f.c ?? 0}));
    if (mesh.edges) mesh.edges = mesh.edges.map(e => e.slice());
    if (mesh.loose) mesh.loose = mesh.loose.slice();
    if (mesh.vdata) mesh.vdata = copyVData(mesh).vdata;
    try {
      const result = edit(mesh, ...args);
      tidyWires(mesh);
      // Vertex numbers in the report refer to the result the edit would have made.
      assertValidMesh(mesh, operation, {label: `${operation} (the result it would have made)`});
      return result;
    } catch (error) {
      mesh.verts = before.verts; mesh.faces = before.faces;
      for (const key of ['edges', 'loose', 'vdata']) { if (before[key] === undefined) delete mesh[key]; else mesh[key] = before[key]; }
      throw error;
    }
  };
  Object.defineProperty(run, 'name', {value: edit.name});
  return run;
}

export const EPS = 1e-6;
/** An edit that can't apply to this selection: shown to the user, nothing changes. */
const refused = message => Object.assign(new RangeError(message), {modelerMessage: true});
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = a => Math.hypot(a[0], a[1], a[2]);
export const normalize = a => { const l = length(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
export const keyVerts = key => key.split(',').map(Number);

export const emptyMesh = () => ({verts: [], faces: []});
/** Copies of a mesh's wire edges and loose points, for building a new mesh (only the keys it has). */
export const copyWires = mesh => ({...(mesh.edges?.length ? {edges: mesh.edges.map(e => e.slice())} : {}), ...(mesh.loose?.length ? {loose: mesh.loose.slice()} : {})});
export const cloneMesh = mesh => ({verts: mesh.verts.map(v => v.slice()), faces: mesh.faces.map(f => ({v: f.v.slice(), c: f.c ?? 0})), ...copyWires(mesh), ...copyVData(mesh)});
/** Just the surface (faces and the points they use, with their point data), as the stage and the modifiers see it. */
export const surfaceOf = mesh => ({verts: mesh.verts.map(v => v.slice()), faces: mesh.faces.map(f => ({v: f.v.slice(), c: f.c ?? 0})), ...copyVData(mesh)});

// ---------- per-point data (Blender's point attributes) ----------
// `mesh.vdata` holds optional sparse per-point values keyed by point index:
//   line:   {[i]: weight}    outline thickness factor (1 = the part's thickness, 0 = no line)
//   normal: {[i]: [x, y, z]} a custom shading normal (unit, in the mesh's space)
//   skin:   {[i]: [[boneId, weight], …]} skin weights kept from an imported rig
//           (points without them get automatic weights)
//   hide:   {[i]: 1} points hidden in Edit mode (H): faces using them aren't shown
//           or picked there, and the points can't be selected
//   crease: {['a,b']: c} edge crease 0..1 for Smooth (Shift+E): 1 keeps the edge
//           sharp, as Blender's Edge Crease; keyed by edge, not by point
// Points without an entry use the default. Edits that renumber points remap it
// (cleanup); edits that only add points leave the new points at the default.
export const VDATA_KEYS = Object.freeze(['line', 'normal', 'skin', 'hide', 'crease']);
const EDGE_KEYED = new Set(['crease']);
/** Renumber an edge key ('a,b'), or undefined when either end is gone. */
const remapKey = (key, f) => { const [a, b] = keyVerts(key), x = f(a), y = f(b); return x === undefined || y === undefined || x === y ? undefined : edgeKey(x, y); };
const hasVData = mesh => Boolean(mesh.vdata && VDATA_KEYS.some(k => mesh.vdata[k] && Object.keys(mesh.vdata[k]).length));
/** A copy of a mesh's per-point data (spread into new meshes). `matrix` turns custom normals with the points. */
export function copyVData(mesh, matrix = null) {
  if (!hasVData(mesh)) return {};
  const out = {};
  for (const key of VDATA_KEYS) {
    const src = mesh.vdata[key]; if (!src || !Object.keys(src).length) continue;
    out[key] = {};
    for (const [i, value] of Object.entries(src)) out[key][i] = key === 'normal' ? (matrix ? normalize([...transformDirection(matrix, value)]) : value.slice()) : key === 'skin' ? value.map(pair => pair.slice()) : value;
  }
  return {vdata: out};
}
/** Renumber per-point data with `map` (old index → new index); points not in the map lose theirs. */
function remapVData(mesh, map) {
  if (!mesh.vdata) return;
  for (const key of VDATA_KEYS) {
    const src = mesh.vdata[key]; if (!src) continue;
    const next = {};
    for (const [i, value] of Object.entries(src)) {
      const j = EDGE_KEYED.has(key) ? remapKey(i, v => map.get(v)) : map.get(Number(i));
      if (j !== undefined) next[j] = value;
    }
    if (Object.keys(next).length) mesh.vdata[key] = next; else delete mesh.vdata[key];
  }
  if (!hasVData(mesh)) delete mesh.vdata;
}
/** Give mirrored copies (map[i] = copy of i, across X) the same data, normals mirrored. */
function mirrorVData(mesh, map) {
  if (!hasVData(mesh)) return;
  for (const key of VDATA_KEYS) {
    // Skin weights name one side's bones; the mirrored copy gets automatic weights.
    const src = mesh.vdata[key]; if (!src || key === 'skin') continue;
    if (EDGE_KEYED.has(key)) { for (const [k, value] of Object.entries({...src})) { const j = remapKey(k, v => map[v] ?? v); if (j !== undefined) src[j] = value; } continue; }
    for (const [i, value] of Object.entries({...src})) { const j = map[Number(i)]; if (j === undefined || j === Number(i)) continue; src[j] = key === 'normal' ? [-value[0], value[1], value[2]] : value; }
  }
}
/** Set (or with value null, clear) one kind of per-point data on some points. Shape is untouched. */
export function setVData(mesh, key, verts, value) {
  if (!VDATA_KEYS.includes(key)) throw new Error(`Unknown point data “${key}”.`);
  mesh.vdata ??= {}; mesh.vdata[key] ??= {};
  for (const v of verts) {
    const each = typeof value === 'function' ? value(v) : value;
    if (each === null || each === undefined) delete mesh.vdata[key][v]; else mesh.vdata[key][v] = Array.isArray(each) ? each.slice() : each;
  }
  if (!Object.keys(mesh.vdata[key]).length) delete mesh.vdata[key];
  if (!hasVData(mesh)) delete mesh.vdata;
}
/** Area-weighted vertex normals of a mesh from its shape (faces wind
 * counter-clockwise seen from outside; Newell's method per face). */
export function vertexNormals(mesh) {
  const sums = mesh.verts.map(() => [0, 0, 0]);
  for (const face of mesh.faces) {
    let n = [0, 0, 0];
    for (let i = 0; i < face.v.length; i++) n = add(n, cross(mesh.verts[face.v[i]], mesh.verts[face.v[(i + 1) % face.v.length]]));
    for (const i of face.v) sums[i] = add(sums[i], n);
  }
  return sums.map(normalize);
}

/** Custom shading normals for anime faces (Blender's Normal Edit / Data
 * Transfer tricks), as {point: normal} for `verts`, in the mesh's space:
 *   'direction' all toward `direction` (e.g. the front, or the current view),
 *   'sphere'    away from `center`, as if the face were a smooth ball,
 *   'flatten'   the selection's average normal (one flat shadow plane).
 * `strength` 0..1 blends from the shape's own normal to the target. */
export function shadingNormals(mesh, verts, how, {direction = [0, 0, 1], center = null, strength = 1} = {}) {
  const own = vertexNormals(mesh), k = Math.max(0, Math.min(1, Number(strength)));
  const pick = [...verts].filter(v => mesh.faces.some(f => f.v.includes(v)));
  if (!pick.length) throw refused('Select points on faces to set their shading normals.');
  const middle = center ?? scale(pick.reduce((s, v) => add(s, mesh.verts[v]), [0, 0, 0]), 1 / pick.length);
  const average = normalize(pick.reduce((s, v) => add(s, own[v]), [0, 0, 0]));
  const out = {};
  for (const v of pick) {
    const target = how === 'sphere' ? normalize(sub(mesh.verts[v], middle)) : how === 'flatten' ? average : normalize(direction);
    const blended = normalize(add(scale(own[v], 1 - k), scale(length(target) > 0 ? target : own[v], k)));
    out[v] = length(blended) > 0 ? blended : own[v];
  }
  return out;
}

/** Line weights that taper along a selection (a hair strand, an eyelash):
 * full at its root (where it joins the rest of the mesh, or the point nearest
 * the mesh's middle) down to 0 at the point farthest from it, so the outline
 * ends in a sharp tip. Returns {point: weight}. */
export function taperWeights(mesh, verts) {
  const pick = [...verts];
  if (pick.length < 2) throw refused('Select a strand of at least two points to taper its line.');
  const chosen = new Set(pick), outside = v => { let n = 0; for (const f of mesh.faces) { const i = f.v.indexOf(v); if (i < 0) continue; for (const w of [f.v[(i + 1) % f.v.length], f.v[(i + f.v.length - 1) % f.v.length]]) if (!chosen.has(w)) n++; } return n; };
  const middle = scale(mesh.verts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / mesh.verts.length);
  let root = pick[0], best = -1;
  for (const v of pick) { const score = outside(v) * 1e6 - length(sub(mesh.verts[v], middle)); if (score > best) { best = score; root = v; } }
  const far = Math.max(...pick.map(v => length(sub(mesh.verts[v], mesh.verts[root])))) || 1;
  return Object.fromEntries(pick.map(v => [v, Math.max(0, 1 - length(sub(mesh.verts[v], mesh.verts[root])) / far)]));
}

/** A point's line weight (1 by default). */
export const lineWeightOf = (mesh, v) => mesh.vdata?.line?.[v] ?? 1;
/** A point's custom normal, or undefined. */
export const customNormalOf = (mesh, v) => mesh.vdata?.normal?.[v];

/** Keep wire data consistent after an edit, without renumbering points:
 * wires that became face edges (after a fill or bridge), joined a point to
 * itself, repeat, or point nowhere are dropped; loose points that now belong
 * to something stop being loose. Empty lists are removed. */
export function tidyWires(mesh) {
  const n = mesh.verts.length, faceEdges = new Set(), used = new Set();
  for (const f of mesh.faces) f.v.forEach((a, i) => { faceEdges.add(edgeKey(a, f.v[(i + 1) % f.v.length])); used.add(a); });
  if (mesh.edges) {
    const seen = new Set();
    mesh.edges = mesh.edges.filter(([a, b]) => {
      if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < n && b < n) || a === b) return false;
      const key = edgeKey(a, b); if (seen.has(key) || faceEdges.has(key)) return false;
      seen.add(key); return true;
    });
    for (const [a, b] of mesh.edges) { used.add(a); used.add(b); }
    if (!mesh.edges.length) delete mesh.edges;
  }
  if (mesh.loose) {
    mesh.loose = [...new Set(mesh.loose)].filter(i => Number.isInteger(i) && i >= 0 && i < n && !used.has(i));
    if (!mesh.loose.length) delete mesh.loose;
  }
  return mesh;
}

/** Points joined to each point by faces or wires: Map vertex → Set of neighbours. */
export function neighbours(mesh) {
  const out = new Map(), link = (a, b) => { if (!out.has(a)) out.set(a, new Set()); out.get(a).add(b); };
  for (const f of mesh.faces) f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; link(a, b); link(b, a); });
  for (const [a, b] of mesh.edges ?? []) { link(a, b); link(b, a); }
  return out;
}

/** Newell normal (unit), robust for non-planar polygons. */
export function faceNormal(mesh, face) {
  const n = [0, 0, 0], v = face.v;
  for (let i = 0; i < v.length; i++) {
    const a = mesh.verts[v[i]], b = mesh.verts[v[(i + 1) % v.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}
export function faceCenter(mesh, face) {
  const c = [0, 0, 0];
  for (const i of face.v) { const p = mesh.verts[i]; c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return scale(c, 1 / face.v.length);
}
export function centroid(mesh, verts) {
  const list = [...verts]; if (!list.length) return [0, 0, 0];
  return scale(list.reduce((s, i) => add(s, mesh.verts[i]), [0, 0, 0]), 1 / list.length);
}

/** Edge key → indices of the faces using it. */
/** Whether the mesh has open edges (a sheet, a band or a hole). Blender draws both
 * sides of every face; closed meshes can skip the far side, open ones can't. */
export function isOpenMesh(mesh) {
  // Runs every frame: number keys, no strings.
  const n = mesh.verts.length + 1, half = new Set();
  for (const f of mesh.faces) for (let i = 0; i < f.v.length; i++) half.add(f.v[i] * n + f.v[(i + 1) % f.v.length]);
  for (const f of mesh.faces) for (let i = 0; i < f.v.length; i++) if (!half.has(f.v[(i + 1) % f.v.length] * n + f.v[i])) return true;
  return false;
}

export function edgeFaces(mesh) {
  const map = new Map();
  mesh.faces.forEach((f, fi) => f.v.forEach((a, i) => {
    const key = edgeKey(a, f.v[(i + 1) % f.v.length]);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fi);
  }));
  return map;
}
export const meshEdges = mesh => [...edgeFaces(mesh).keys()].map(keyVerts);
/** Face edges and wire edges together. */
export const allEdges = mesh => [...meshEdges(mesh), ...(mesh.edges ?? []).map(e => e.slice())];

/** Vertex → indices of faces around it. */
export function vertexFaces(mesh) {
  const map = Array.from({length: mesh.verts.length}, () => []);
  mesh.faces.forEach((f, fi) => f.v.forEach(i => map[i].push(fi)));
  return map;
}

/** Fan triangles of every face: [[a, b, c, faceIndex]]. Faces are convex in practice. */
export function triangulate(mesh) {
  const out = [];
  mesh.faces.forEach((f, fi) => { for (let i = 1; i + 1 < f.v.length; i++) out.push([f.v[0], f.v[i], f.v[i + 1], fi]); });
  return out;
}

/** Faces whose every vertex is selected. */
export const facesFromVerts = (mesh, verts) => new Set(mesh.faces.flatMap((f, i) => f.v.every(v => verts.has(v)) ? [i] : []));
export const vertsFromFaces = (mesh, faces) => new Set([...faces].flatMap(i => mesh.faces[i].v));
/** Edges whose two vertices are selected. */
export const edgesFromVerts = (mesh, verts) => allEdges(mesh).filter(([a, b]) => verts.has(a) && verts.has(b));

/** Drop faces with repeated corners and vertices nothing uses (no face, wire
 * edge or loose-point entry), renumbering what remains: face points first in
 * face order, then wire points, then loose points. Returns old → new index map. */
export function cleanup(mesh) {
  mesh.faces = mesh.faces.map(f => {
    const v = f.v.filter((x, i) => x !== f.v[(i + 1) % f.v.length]);
    return {...f, v};
  }).filter(f => f.v.length >= 3 && new Set(f.v).size === f.v.length);
  tidyWires(mesh);
  const used = new Map(), verts = [], keep = i => { if (!used.has(i)) { used.set(i, verts.length); verts.push(mesh.verts[i]); } };
  for (const f of mesh.faces) for (const i of f.v) keep(i);
  for (const [a, b] of mesh.edges ?? []) { keep(a); keep(b); }
  for (const i of mesh.loose ?? []) keep(i);
  mesh.faces.forEach(f => { f.v = f.v.map(i => used.get(i)); });
  if (mesh.edges) mesh.edges = mesh.edges.map(([a, b]) => [used.get(a), used.get(b)]);
  if (mesh.loose) mesh.loose = mesh.loose.map(i => used.get(i));
  mesh.verts = verts;
  remapVData(mesh, used);
  return used;
}

/** The matrix that turns normals with a transform (inverse transpose of its 3×3 part). */
function normalMatrix(m) {
  const inv = invert(m);
  return [inv[0], inv[4], inv[8], 0, inv[1], inv[5], inv[9], 0, inv[2], inv[6], inv[10], 0, 0, 0, 0, 1];
}

/** A new mesh with `matrix` applied to the chosen vertices (all by default).
 * Pure: the input mesh is not touched. Topology is unchanged by construction. */
export function transformMesh(mesh, matrix, verts = null) {
  const chosen = verts ? new Set(verts) : null;
  return {verts: mesh.verts.map((p, i) => !chosen || chosen.has(i) ? [...transformPoint(matrix, p)] : p.slice()), faces: mesh.faces.map(f => ({v: f.v.slice(), c: f.c ?? 0})), ...copyWires(mesh), ...copyVData(mesh, chosen ? null : normalMatrix(matrix))};
}

/** Move each listed vertex by its own matrix (`matrices`: Map vertex → matrix).
 * Pure: returns a new mesh; topology is untouched. Used by soft selection,
 * where points near the selection move part of the way. */
export function transformMeshEach(mesh, matrices) {
  return {verts: mesh.verts.map((p, i) => matrices.has(i) ? [...transformPoint(matrices.get(i), p)] : p.slice()), faces: mesh.faces.map(f => ({v: f.v.slice(), c: f.c ?? 0})), ...copyWires(mesh), ...copyVData(mesh)};
}

/** Mirror clipping (the Mirror modifier's "Clipping"): for a part mirrored
 * across world X = 0, a moved point that started on that plane stays on it,
 * and no point crosses it, so the two halves stay joined. `objectMatrix` takes
 * the part's points into world space. Pure: returns a new mesh. */
export function clipToMirror(startMesh, mesh, objectMatrix, verts, tolerance = 1e-5) {
  const inverse = invert(objectMatrix), out = cloneMesh(mesh);
  for (const i of verts) {
    const before = transformPoint(objectMatrix, startMesh.verts[i]), after = [...transformPoint(objectMatrix, mesh.verts[i])];
    const onPlane = Math.abs(before[0]) <= tolerance, crossed = Math.sign(after[0]) !== Math.sign(before[0]) && Math.abs(after[0]) > tolerance;
    if (!onPlane && !crossed) continue;
    after[0] = 0;
    out.verts[i] = [...transformPoint(inverse, after)];
  }
  return out;
}

/** Soft select falloff curves (Blender's proportional editing): each maps
 * t (1 at the selection, 0 at the radius) to how far a point follows. */
export const SOFT_FALLOFFS = Object.freeze({
  smooth: t => t * t * (3 - 2 * t),
  sphere: t => Math.sqrt(Math.max(0, 2 * t - t * t)),
  root: t => Math.sqrt(t),
  inverseSquare: t => t * (2 - t),
  sharp: t => t * t,
  linear: t => t,
  constant: () => 1,
});

/** Soft selection (Blender's proportional editing): for every unselected point
 * within `radius` of the nearest selected point, a weight from 1 (touching) to
 * 0 (at the radius) on a smooth curve. `points` are positions to measure in
 * (world space, so the part's size doesn't matter). Returns Map vertex → weight. */
export function softWeights(points, selected, radius, falloff = 'smooth', {connected = null} = {}) {
  const out = new Map(), r = Number(radius), curve = SOFT_FALLOFFS[falloff] ?? SOFT_FALLOFFS.smooth;
  if (!(r > 0) || !selected.size) return out;
  if (connected) return connectedWeights(connected, points, selected, r, curve);
  const chosen = [...selected].map(i => points[i]).filter(Boolean);
  points.forEach((p, i) => {
    if (selected.has(i)) return;
    let d = Infinity;
    for (const q of chosen) { d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); if (d === 0) break; }
    if (d >= r) return;
    out.set(i, curve(1 - d / r));
  });
  return out;
}

/** Blender's "Connected Only" (Alt+O): distance measured along the mesh's edges
 * from the nearest selected point, so only points joined to the selection
 * follow: pulling an upper eyelid leaves the lower lid alone even where it
 * passes close by, and a lip moves without the other lip. */
function connectedWeights(mesh, points, selected, r, curve) {
  const next = new Map(), link = (a, b) => { if (!next.has(a)) next.set(a, new Set()); next.get(a).add(b); };
  for (const [a, b] of allEdges(mesh)) { link(a, b); link(b, a); }
  const dist = new Map([...selected].map(v => [v, 0])), queue = [...selected];
  // Dijkstra with a simple array queue: selections and radii are small.
  while (queue.length) {
    let k = 0; for (let i = 1; i < queue.length; i++) if (dist.get(queue[i]) < dist.get(queue[k])) k = i;
    const v = queue.splice(k, 1)[0], d = dist.get(v);
    for (const w of next.get(v) ?? []) {
      const nd = d + Math.hypot(points[v][0] - points[w][0], points[v][1] - points[w][1], points[v][2] - points[w][2]);
      if (nd < r && nd < (dist.get(w) ?? Infinity)) { if (!dist.has(w)) queue.push(w); dist.set(w, nd); }
    }
  }
  const out = new Map();
  for (const [v, d] of dist) if (!selected.has(v)) out.set(v, curve(1 - d / r));
  return out;
}

/** Where faces around a corner only touch at that corner (a "bow-tie", e.g. after
 * deleting faces in a checker pattern), give each extra fan its own copy of the
 * corner. Nothing moves; the mesh just stays one clean surface per fan.
 * Returns the copies made, as Map(copy → original). */
export function splitBowTies(mesh) {
  const around = new Map();
  mesh.faces.forEach((f, fi) => f.v.forEach((v, i) => { if (!around.has(v)) around.set(v, []); around.get(v).push({fi, prev: f.v[(i + f.v.length - 1) % f.v.length], next: f.v[(i + 1) % f.v.length]}); }));
  const made = new Map();
  for (const [v, uses] of around) {
    if (uses.length < 2) continue;
    const parent = uses.map((_, i) => i), root = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
      const a = uses[i], b = uses[j];
      if (a.next === b.prev || a.prev === b.next || a.next === b.next || a.prev === b.prev) parent[root(i)] = root(j);
    }
    const fans = [...new Set(uses.map((_, i) => root(i)))];
    for (const fan of fans.slice(1)) {
      const copy = mesh.verts.length; mesh.verts.push(mesh.verts[v].slice()); made.set(copy, v);
      uses.forEach((u, i) => { if (root(i) === fan) { const f = mesh.faces[u.fi].v; f[f.indexOf(v)] = copy; } });
    }
  }
  return made;
}

/** Delete vertices and every face and wire using them. A traced point left
 * with nothing joined to it stays as a loose point (as in Blender); points of
 * deleted faces go with them. */
function deleteVertsEdit(mesh, verts) {
  const onFaces = new Set(mesh.faces.flatMap(f => f.v)), wireOnly = new Set((mesh.edges ?? []).flat().filter(i => !onFaces.has(i) && !verts.has(i)));
  mesh.faces = mesh.faces.filter(f => !f.v.some(v => verts.has(v)));
  if (mesh.edges) mesh.edges = mesh.edges.filter(([a, b]) => !verts.has(a) && !verts.has(b));
  if (mesh.loose) mesh.loose = mesh.loose.filter(i => !verts.has(i));
  const still = new Set([...mesh.faces.flatMap(f => f.v), ...(mesh.edges ?? []).flat()]);
  const stranded = [...wireOnly].filter(i => !still.has(i));
  if (stranded.length) mesh.loose = [...(mesh.loose ?? []), ...stranded];
  cleanup(mesh);
  splitBowTies(mesh);
  return new Set();
}
/** Delete faces; vertices no remaining face uses go too. */
function deleteFacesEdit(mesh, faces) {
  mesh.faces = mesh.faces.filter((f, i) => !faces.has(i));
  cleanup(mesh);
  splitBowTies(mesh);
  return new Set();
}

/** Region extrude: selected faces move to new vertices, joined to the rest
 * by side walls along the region's border. Returns the new vertex selection. */
function extrudeFacesEdit(mesh, faces) {
  if (!faces.size) return new Set();
  const edges = new Map();
  for (const fi of faces) {
    const v = mesh.faces[fi].v;
    v.forEach((a, i) => { const b = v[(i + 1) % v.length], key = edgeKey(a, b); edges.set(key, (edges.get(key) ?? []).concat([[a, b, fi]])); });
  }
  // Like Blender: corners inside the region just move with it; only corners on the
  // region's border get a copy, so nothing is left behind unused. A corner where
  // parts of the region touch only at that point gets one copy per part, so each
  // part gets its own walls and the mesh stays one clean surface.
  const border = new Set();
  for (const [, uses] of edges) if (uses.length === 1) { border.add(uses[0][0]); border.add(uses[0][1]); }
  const parent = new Map(), key = (v, fi) => `${v}:${fi}`;
  const root = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  for (const fi of faces) for (const v of mesh.faces[fi].v) if (border.has(v)) parent.set(key(v, fi), key(v, fi));
  for (const [, uses] of edges) if (uses.length === 2) {
    const [[a, b, f1], [, , f2]] = uses;
    for (const v of [a, b]) if (border.has(v)) parent.set(root(key(v, f1)), root(key(v, f2)));
  }
  const copies = new Map(), moved = new Set();
  const copyOf = (v, fi) => {
    if (!border.has(v)) { moved.add(v); return v; }
    const r = root(key(v, fi));
    if (!copies.has(r)) { copies.set(r, mesh.verts.length); mesh.verts.push(mesh.verts[v].slice()); }
    return copies.get(r);
  };
  const next = new Map([...faces].map(fi => [fi, mesh.faces[fi].v.map(v => copyOf(v, fi))]));
  // Border edges are used once inside the region; their walls keep the face's winding.
  for (const [, uses] of edges) if (uses.length === 1) {
    const [a, b, fi] = uses[0], f = mesh.faces[fi].v, n = next.get(fi);
    mesh.faces.push({v: [a, b, n[f.indexOf(b)], n[f.indexOf(a)]], c: mesh.faces[fi].c});
  }
  for (const [fi, v] of next) mesh.faces[fi].v = v;
  return new Set([...copies.values(), ...moved]);
}

/** Average normal of a face region (for moving an extrusion outward). */
export function regionNormal(mesh, faces) {
  return normalize([...faces].reduce((s, fi) => add(s, faceNormal(mesh, mesh.faces[fi])), [0, 0, 0]));
}

/** Extrude open edges (a border, a strip, or traced wire edges) into new
 * quads. Returns the new vertex selection. The quads start flat (the copies sit
 * on the originals) and get their facing once moved, so wire quads are wound
 * afterwards with orientWireFaces(). */
function extrudeEdgesEdit(mesh, edges, {color = 0} = {}) {
  const uses = edgeFaces(mesh), copy = new Map(), dup = i => { if (!copy.has(i)) { copy.set(i, mesh.verts.length); mesh.verts.push(mesh.verts[i].slice()); } return copy.get(i); };
  const fromWires = [];
  for (const [a, b] of edges) {
    const owner = (uses.get(edgeKey(a, b)) ?? [])[0];
    // Wind the new quad opposite to the owning face across the shared edge.
    let [p, q] = [a, b];
    if (owner !== undefined) { const v = mesh.faces[owner].v, i = v.indexOf(a); if (v[(i + 1) % v.length] === b) [p, q] = [b, a]; }
    mesh.faces.push({v: [p, q, dup(q), dup(p)], c: owner !== undefined ? mesh.faces[owner].c : color});
    if (owner === undefined) fromWires.push(mesh.faces.length - 1);
  }
  // Quads grown from wires must agree with each other along shared edges.
  if (fromWires.length) windConsistently(mesh, new Set(fromWires));
  return new Set(copy.values());
}

/** Make the winding of `faces` agree with neighbours (existing faces first,
 * then each other), flipping whole connected groups. Then, for groups that
 * touch no older face, point them toward `facing` (a direction toward the
 * viewer) when given. */
function windConsistently(mesh, faces, facing = null) {
  const list = [...faces], fresh = new Set(list), half = new Map();
  mesh.faces.forEach((f, fi) => { if (!fresh.has(fi)) f.v.forEach((a, i) => half.set(`${a}>${f.v[(i + 1) % f.v.length]}`, fi)); });
  const groups = [], seen = new Set(), byEdge = new Map();
  for (const fi of list) mesh.faces[fi].v.forEach((a, i) => { const k = edgeKey(a, mesh.faces[fi].v[(i + 1) % mesh.faces[fi].v.length]); byEdge.set(k, [...(byEdge.get(k) ?? []), fi]); });
  for (const start of list) {
    if (seen.has(start)) continue;
    const group = [start]; seen.add(start);
    for (let k = 0; k < group.length; k++) {
      const v = mesh.faces[group[k]].v;
      v.forEach((a, i) => {
        const b = v[(i + 1) % v.length];
        for (const other of byEdge.get(edgeKey(a, b)) ?? []) {
          if (seen.has(other)) continue;
          const w = mesh.faces[other].v, j = w.indexOf(a);
          if (w[(j + 1) % w.length] === b) w.reverse();
          seen.add(other); group.push(other);
        }
      });
    }
    groups.push(group);
  }
  for (const group of groups) {
    // Against older faces: a shared edge must run the other way.
    let vote = 0;
    for (const fi of group) { const v = mesh.faces[fi].v; v.forEach((a, i) => { const b = v[(i + 1) % v.length]; if (half.has(`${a}>${b}`)) vote--; else if (half.has(`${b}>${a}`)) vote++; }); }
    if (vote < 0 || (vote === 0 && facing && dot(group.reduce((n, fi) => add(n, faceNormal(mesh, mesh.faces[fi])), [0, 0, 0]), facing) < 0)) for (const fi of group) mesh.faces[fi].v.reverse();
  }
}

/** Wind faces made from wires (by extrude, fill or bridge) so they face
 * `facing` where no neighbouring face decides; atomic. */
function orientWireFacesEdit(mesh, faces, facing) { windConsistently(mesh, faces, facing); return faces; }

/** Inset each selected face: a smaller copy inside a ring of quads. `amount` is 0..1 toward the center. */
function insetFacesEdit(mesh, faces, amount = 0.25) {
  const selected = new Set();
  for (const fi of [...faces]) {
    const face = mesh.faces[fi], center = faceCenter(mesh, face), inner = face.v.map(i => { mesh.verts.push(lerp(mesh.verts[i], center, amount)); return mesh.verts.length - 1; });
    face.v.forEach((a, i) => { const j = (i + 1) % face.v.length; mesh.faces.push({v: [a, face.v[j], inner[j], inner[i]], c: face.c}); });
    face.v = inner; inner.forEach(i => selected.add(i));
  }
  return selected;
}

/** Split selected faces: quads into four quads, others into quads around their center.
 * Neighbours gain the new edge midpoints so the surface stays closed. */
function subdivideFacesEdit(mesh, faces) {
  const mids = new Map(), mid = (a, b) => { const k = edgeKey(a, b); if (!mids.has(k)) { mids.set(k, mesh.verts.length); mesh.verts.push(lerp(mesh.verts[a], mesh.verts[b], .5)); } return mids.get(k); };
  const result = [], selected = new Set();
  mesh.faces.forEach((face, fi) => {
    if (!faces.has(fi)) { result.push(face); return; }
    const v = face.v, n = v.length, m = v.map((a, i) => mid(a, v[(i + 1) % n]));
    if (n === 3) { result.push({v: [v[0], m[0], m[2]], c: face.c}, {v: [m[0], v[1], m[1]], c: face.c}, {v: [m[2], m[1], v[2]], c: face.c}, {v: [m[0], m[1], m[2]], c: face.c}); }
    else {
      mesh.verts.push(faceCenter(mesh, face)); const c = mesh.verts.length - 1;
      for (let i = 0; i < n; i++) result.push({v: [v[i], m[i], c, m[(i + n - 1) % n]], c: face.c});
      selected.add(c);
    }
    v.forEach(i => selected.add(i)); m.forEach(i => selected.add(i));
  });
  // Unselected neighbours get the midpoints of edges they share with split faces.
  for (const face of result) {
    const out = [];
    face.v.forEach((a, i) => { out.push(a); const b = face.v[(i + 1) % face.v.length], k = mids.get(edgeKey(a, b)); if (k !== undefined && !face.v.includes(k)) out.push(k); });
    face.v = out;
  }
  mesh.faces = result;
  return selected;
}

/** The ring of quad edges across from `start` (each quad's opposite edge), both directions. */
export function edgeRing(mesh, start) {
  const uses = edgeFaces(mesh), seen = new Set([edgeKey(...start)]);
  const walk = (edge, from) => {
    const out = [];
    let current = edge, came = from;
    for (;;) {
      const next = (uses.get(edgeKey(...current)) ?? []).find(fi => fi !== came && mesh.faces[fi].v.length === 4);
      if (next === undefined) return out;
      const v = mesh.faces[next].v, i = v.indexOf(current[0]), j = v.indexOf(current[1]);
      // In a quad the opposite edge uses the other two corners; each corner's partner is
      // its neighbour along the quad's side, so the ring keeps one direction throughout.
      const forward = j === (i + 1) % 4, a = v[forward ? (i + 3) % 4 : (i + 1) % 4], b = v[forward ? (j + 1) % 4 : (j + 3) % 4], key = edgeKey(a, b);
      if (seen.has(key)) return out;
      seen.add(key); out.push([a, b]); current = [a, b]; came = next;
    }
  };
  const first = uses.get(edgeKey(...start)) ?? [];
  // Walk out through each face on the starting edge; the result runs end to end.
  const ahead = walk(start, first[1] ?? -1), behind = first.length > 1 ? walk(start, first[0]) : [];
  return [...behind.reverse(), start, ...ahead];
}

/** Loop cut: new edge loops across the quads of the ring through `start`. One cut
 * goes at `t` (0..1) along each ring edge, measured from the start edge's first
 * point; several (`cuts`) are spaced evenly. Returns the new loops' vertices. */
function loopCutEdit(mesh, start, t = 0.5, cuts = 1) {
  const n = Math.max(1, Math.min(LOOP_CUTS_MAX, Math.round(cuts) || 1));
  const at = n === 1 ? [Math.max(0, Math.min(1, t))] : Array.from({length: n}, (_, k) => (k + 1) / (n + 1));
  const ring = edgeRing(mesh, start), cut = new Map(), selected = new Set();
  for (const [a, b] of ring) {
    const key = edgeKey(a, b);
    if (cut.has(key)) continue;
    const points = at.map(f => { mesh.verts.push(lerp(mesh.verts[a], mesh.verts[b], f)); selected.add(mesh.verts.length - 1); return mesh.verts.length - 1; });
    cut.set(key, {from: a, points});
  }
  // The new points on edge a→b, in order from a.
  const along = (a, b) => { const c = cut.get(edgeKey(a, b)); return c ? (c.from === a ? c.points : [...c.points].reverse()) : null; };
  const result = [];
  for (const face of mesh.faces) {
    const v = face.v, hits = v.map((a, i) => along(a, v[(i + 1) % v.length]));
    const count = hits.filter(Boolean).length;
    if (v.length === 4 && count === 2 && Boolean(hits[0]) === Boolean(hits[2])) {
      // Split the quad into strips between its two cut (opposite) edges.
      const s = hits[0] ? 0 : 1, P = hits[s], Q = [...hits[s + 2]].reverse();
      const left = [v[s], ...P, v[s + 1]], right = [v[(s + 3) % 4], ...Q, v[(s + 2) % 4]];
      for (let k = 0; k + 1 < left.length; k++) result.push({v: [left[k], left[k + 1], right[k + 1], right[k]], c: face.c});
    } else if (count) {
      // Faces at the ends of an open ring keep the new points in their outline.
      const out = []; v.forEach((a, i) => { out.push(a); if (hits[i]) out.push(...hits[i]); });
      result.push({v: out, c: face.c});
    } else result.push(face);
  }
  mesh.faces = result;
  // A traced line (no faces) is cut into pieces, like Blender's Subdivide on an edge.
  if (mesh.edges) mesh.edges = mesh.edges.flatMap(([a, b]) => { const p = along(a, b); if (!p) return [[a, b]]; const chain = [a, ...p, b]; return chain.slice(1).map((x, k) => [chain[k], x]); });
  return selected;
}

/** Most loop cuts made at once. */
export const LOOP_CUTS_MAX = 16;

/** For edge slide: each selected point's neighbours along edges (face edges or
 * traced lines) that lead out of the selection. Map vertex → [neighbour]. */
export function slideNeighbours(mesh, verts) {
  const out = new Map([...verts].map(v => [v, new Set()]));
  const link = (a, b) => { if (verts.has(a) && !verts.has(b)) out.get(a).add(b); if (verts.has(b) && !verts.has(a)) out.get(b).add(a); };
  for (const key of edgeFaces(mesh).keys()) link(...keyVerts(key));
  for (const [a, b] of mesh.edges ?? []) link(a, b);
  return new Map([...out].map(([v, s]) => [v, [...s]]));
}

/** Edge slide: a copy of `mesh` with each point of `toward` (Map vertex → neighbour)
 * moved fraction `f` (0..1) of the way along its edge. Topology is untouched. */
export function slideMesh(mesh, toward, f) {
  const out = cloneMesh(mesh), k = Math.max(0, Math.min(1, f));
  for (const [v, n] of toward) out.verts[v] = lerp(mesh.verts[v], mesh.verts[n], k);
  return out;
}

/** The edge loop through an edge: continue straight through every 4-valent vertex. */
export function edgeLoop(mesh, start) {
  const uses = edgeFaces(mesh), startUses = uses.get(edgeKey(...start))?.length ?? 0;
  // A traced line: follow the chain of lines through points with exactly two of them.
  if (!startUses) return chainLoop(mesh, start, (mesh.edges ?? []).filter(([a, b]) => !uses.has(edgeKey(a, b))));
  // An open border (an edge with one face): follow the border all the way round.
  if (startUses === 1) return chainLoop(mesh, start, [...uses].filter(([, fs]) => fs.length === 1).map(([key]) => keyVerts(key)));
  const byVertex = new Map();
  for (const key of uses.keys()) { const [a, b] = keyVerts(key); for (const [p, q] of [[a, b], [b, a]]) { if (!byVertex.has(p)) byVertex.set(p, []); byVertex.get(p).push(q); } }
  const loop = new Set([edgeKey(...start)]), verts = new Set(start);
  const walk = (prev, at) => {
    for (;;) {
      const around = byVertex.get(at) ?? [];
      if (around.length !== 4) return;
      const shared = new Set(uses.get(edgeKey(prev, at)));
      const next = around.find(n => n !== prev && !(uses.get(edgeKey(at, n)) ?? []).some(f => shared.has(f)));
      if (next === undefined || loop.has(edgeKey(at, next))) return;
      loop.add(edgeKey(at, next)); verts.add(next); prev = at; at = next;
    }
  };
  walk(start[0], start[1]); walk(start[1], start[0]);
  return verts;
}

/** The points of the chain through `start` among `edges`: it carries on through
 * every point where exactly two of the edges meet, and stops at forks and ends. */
function chainLoop(mesh, start, edges) {
  const around = new Map();
  for (const [a, b] of edges) for (const [p, q] of [[a, b], [b, a]]) { if (!around.has(p)) around.set(p, []); around.get(p).push(q); }
  const verts = new Set(start), done = new Set([edgeKey(...start)]);
  if (!(around.get(start[0]) ?? []).includes(start[1])) return verts;
  const walk = (prev, at) => {
    for (;;) {
      const next = around.get(at) ?? [];
      if (next.length !== 2) return;
      const to = next[0] === prev ? next[1] : next[0];
      if (done.has(edgeKey(at, to))) return;
      done.add(edgeKey(at, to)); verts.add(to); prev = at; at = to;
    }
  };
  walk(start[0], start[1]); walk(start[1], start[0]);
  return verts;
}

/** Collapse selected vertices to their center (or `at`) and weld them. */
function mergeVertsEdit(mesh, verts, at = centroid(mesh, verts)) {
  const list = [...verts]; if (list.length < 2) return new Set(list);
  const keep = list[0]; mesh.verts[keep] = at.slice();
  const map = i => verts.has(i) ? keep : i;
  mesh.faces.forEach(f => { f.v = f.v.map(map); });
  if (mesh.edges) mesh.edges = mesh.edges.map(e => e.map(map));
  if (mesh.loose) mesh.loose = mesh.loose.map(map);
  // A merged point with nothing left but itself stays as a loose point.
  if (!mesh.faces.some(f => f.v.includes(keep)) && !(mesh.edges ?? []).some(([a, b]) => a !== b && (a === keep || b === keep))) mesh.loose = [...(mesh.loose ?? []), keep];
  const index = cleanup(mesh);
  return new Set([index.get(keep)].filter(i => i !== undefined));
}

/** Weld vertices closer than `distance`; only `verts` if given. Returns removed count. */
function mergeByDistanceEdit(mesh, distance = 1e-4, verts = null) {
  const cell = Math.max(distance, 1e-9), grid = new Map(), target = mesh.verts.map((_, i) => i);
  const key = p => p.map(x => Math.floor(x / cell)).join(',');
  mesh.verts.forEach((p, i) => {
    if (verts && !verts.has(i)) return;
    const [x, y, z] = p.map(v => Math.floor(v / cell));
    for (let dx = -1; dx <= 1 && target[i] === i; dx++) for (let dy = -1; dy <= 1 && target[i] === i; dy++) for (let dz = -1; dz <= 1 && target[i] === i; dz++)
      for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) if (length(sub(mesh.verts[j], p)) <= distance) { target[i] = j; break; }
    if (target[i] === i) { const k = key(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  });
  const before = mesh.verts.length;
  mesh.faces.forEach(f => { f.v = f.v.map(i => target[i]); });
  if (mesh.edges) mesh.edges = mesh.edges.map(e => e.map(i => target[i]));
  if (mesh.loose) mesh.loose = mesh.loose.map(i => target[i]);
  cleanup(mesh);
  return before - mesh.verts.length;
}

/** F: two points get a wire edge between them; three or more become one face.
 * A closed ring of traced edges is filled in its own order; other points are
 * ordered around their centre. `facing` (toward the viewer) winds a face that
 * touches no other face. Returns the face index, or null for an edge. */
function fillVertsEdit(mesh, verts, color = 0, {facing = null} = {}) {
  const list = [...verts];
  if (list.length === 2) {
    const [a, b] = list, key = edgeKey(a, b);
    if (!edgeFaces(mesh).has(key) && !(mesh.edges ?? []).some(e => edgeKey(...e) === key)) mesh.edges = [...(mesh.edges ?? []), [a, b]];
    return null;
  }
  if (list.length < 3) return null;
  const ring = closedRing(mesh, verts);
  if (ring) {
    mesh.faces.push({v: ring, c: color});
    windConsistently(mesh, new Set([mesh.faces.length - 1]), facing);
    return mesh.faces.length - 1;
  }
  const c = centroid(mesh, verts);
  // Best-fit plane normal from the spread of points (Newell over a rough angular order).
  let n = [0, 0, 0];
  for (let i = 0; i < list.length; i++) n = add(n, cross(sub(mesh.verts[list[i]], c), sub(mesh.verts[list[(i + 1) % list.length]], c)));
  if (length(n) < 1e-12) n = [0, 0, 1];
  n = normalize(n);
  const u = normalize(Math.abs(n[0]) < .9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), w = cross(n, u);
  list.sort((a, b) => { const pa = sub(mesh.verts[a], c), pb = sub(mesh.verts[b], c); return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u)); });
  // Face outward: match the winding of neighbouring faces if any share an edge.
  const uses = edgeFaces(mesh);
  for (let i = 0; i < list.length; i++) {
    const a = list[i], b = list[(i + 1) % list.length], f = (uses.get(edgeKey(a, b)) ?? [])[0];
    if (f === undefined) continue;
    const v = mesh.faces[f].v, k = v.indexOf(a);
    if (v[(k + 1) % v.length] === b) list.reverse();
    break;
  }
  mesh.faces.push({v: list, c: color});
  if (!list.some((a, i) => (uses.get(edgeKey(a, list[(i + 1) % list.length])) ?? []).length) && facing && dot(faceNormal(mesh, mesh.faces.at(-1)), facing) < 0) mesh.faces.at(-1).v.reverse();
  return mesh.faces.length - 1;
}

/** The selected points in order around a closed ring of wire / border edges
 * that uses exactly them, or null. */
function closedRing(mesh, verts) {
  if (verts.size < 3) return null;
  const uses = edgeFaces(mesh), links = new Map(), add2 = (a, b) => { links.set(a, [...(links.get(a) ?? []), b]); };
  const open = [...new Set([...(mesh.edges ?? []).map(([a, b]) => edgeKey(a, b)), ...[...uses].filter(([, fs]) => fs.length === 1).map(([k]) => k)])].map(keyVerts);
  for (const [a, b] of open) if (a !== b && verts.has(a) && verts.has(b)) { add2(a, b); add2(b, a); }
  if (links.size !== verts.size || [...links.values()].some(l => l.length !== 2)) return null;
  const start = [...verts][0], ring = [start];
  let prev = null, at = start;
  for (;;) {
    const next = links.get(at).find(x => x !== prev);
    if (next === start) break;
    if (ring.includes(next)) return null;
    ring.push(next); prev = at; at = next;
  }
  return ring.length === verts.size ? ring : null;
}

/** Extrude single points (Blender's E on a vertex): each selected point gets a
 * new point on top of it, joined by a wire edge. Returns the new points (to
 * move with the pointer). */
function extrudePointsEdit(mesh, verts) {
  const created = new Set();
  for (const v of verts) {
    mesh.verts.push(mesh.verts[v].slice());
    const k = mesh.verts.length - 1;
    mesh.edges = [...(mesh.edges ?? []), [v, k]]; created.add(k);
  }
  return created;
}

/** Ctrl+click: a new point at `at`, joined to `from` by a wire edge (or loose
 * when `from` is null). Returns the new point. */
function addPointEdit(mesh, at, from = null) {
  mesh.verts.push(at.slice());
  const k = mesh.verts.length - 1;
  if (from === null || from === undefined) mesh.loose = [...(mesh.loose ?? []), k];
  else mesh.edges = [...(mesh.edges ?? []), [from, k]];
  return k;
}

/** The selected edges (wire or open border) as connected chains: [{points, closed}]. */
export function selectedChains(mesh, verts) {
  const uses = edgeFaces(mesh), links = new Map(), link = (a, b) => { links.set(a, [...(links.get(a) ?? []), b]); };
  const open = [...new Set([...(mesh.edges ?? []).map(([a, b]) => edgeKey(a, b)), ...[...uses].filter(([, fs]) => fs.length === 1).map(([k]) => k)])].map(keyVerts);
  for (const [a, b] of open) if (a !== b && verts.has(a) && verts.has(b)) { link(a, b); link(b, a); }
  const seen = new Set(), chains = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    // Collect the component, then walk it from an end (or anywhere on a ring).
    const component = [start]; seen.add(start);
    for (let k = 0; k < component.length; k++) for (const n of links.get(component[k])) if (!seen.has(n)) { seen.add(n); component.push(n); }
    if (component.some(v => links.get(v).length > 2)) return null;
    const ends = component.filter(v => links.get(v).length === 1), first = ends[0] ?? component[0], points = [first];
    let prev = null, at = first;
    for (;;) { const next = links.get(at).find(x => x !== prev && (points.length < 2 || x !== points[points.length - 2])); if (next === undefined || next === first || points.includes(next)) break; points.push(next); prev = at; at = next; }
    chains.push({points, closed: !ends.length});
  }
  return chains;
}

/** Bridge: fill the strip between two selected chains of edges with faces
 * (quads where the chains have the same number of points, triangles where one
 * needs to catch up). Both chains open, or both closed rings. Returns the new
 * faces. */
function bridgeEdit(mesh, verts, {color = 0, facing = null} = {}) {
  const chains = selectedChains(mesh, verts);
  if (!chains || chains.length !== 2) throw refused('Bridge needs exactly two separate lines of edges selected (lines with no branches).');
  let [A, B] = chains;
  if (A.closed !== B.closed) throw refused('Bridge needs two open lines or two closed rings, not one of each.');
  const P = i => mesh.verts[i], gap = (x, y) => length(sub(P(x), P(y)));
  let a = A.points.slice(), b = B.points.slice();
  if (A.closed) {
    // Rings: line up B's start and direction with A's.
    let best = null;
    for (const dir of [b, b.slice().reverse()]) for (let s = 0; s < dir.length; s++) {
      const r = dir.slice(s).concat(dir.slice(0, s));
      const cost = a.reduce((sum, p, i) => sum + gap(p, r[Math.round(i * r.length / a.length) % r.length]), 0);
      if (!best || cost < best.cost) best = {r, cost};
    }
    b = best.r; a = [...a, a[0]]; b = [...b, b[0]];
  } else if (gap(a[0], b[0]) + gap(a.at(-1), b.at(-1)) > gap(a[0], b.at(-1)) + gap(a.at(-1), b[0])) b.reverse();
  // Walk both chains by how far along they are, so the faces stay even.
  const along = c => { const d = [0]; for (let i = 1; i < c.length; i++) d.push(d[i - 1] + gap(c[i - 1], c[i])); const total = d.at(-1) || 1; return d.map(x => x / total); };
  const ta = along(a), tb = along(b), made = [];
  let i = 0, j = 0;
  while (i < a.length - 1 || j < b.length - 1) {
    const stepA = i < a.length - 1 ? ta[i + 1] : Infinity, stepB = j < b.length - 1 ? tb[j + 1] : Infinity;
    if (a.length === b.length || Math.abs(stepA - stepB) < 1e-9) { mesh.faces.push({v: [a[i], a[i + 1], b[j + 1], b[j]], c: color}); i++; j++; }
    else if (stepA < stepB) { mesh.faces.push({v: [a[i], a[i + 1], b[j]], c: color}); i++; }
    else { mesh.faces.push({v: [a[i], b[j + 1], b[j]], c: color}); j++; }
    made.push(mesh.faces.length - 1);
  }
  windConsistently(mesh, new Set(made), facing);
  return new Set(made);
}

/** Shift+D on traced points: copy the selected points and the wires between them. */
function duplicatePointsEdit(mesh, verts) {
  const map = new Map();
  for (const v of verts) { mesh.verts.push(mesh.verts[v].slice()); map.set(v, mesh.verts.length - 1); }
  const wires = (mesh.edges ?? []).filter(([a, b]) => verts.has(a) && verts.has(b)).map(([a, b]) => [map.get(a), map.get(b)]);
  const joined = new Set(wires.flat());
  mesh.edges = [...(mesh.edges ?? []), ...wires];
  mesh.loose = [...(mesh.loose ?? []), ...[...map.values()].filter(k => !joined.has(k))];
  return new Set(map.values());
}



/** Turn faces inside out. A closed piece must keep one winding throughout
 * (rule H4), so every face of each connected piece the selection touches is
 * flipped. Returns the flipped faces. */
function flipFacesEdit(mesh, faces) {
  const around = vertexFaces(mesh), seen = new Set(), queue = [...faces];
  while (queue.length) {
    const fi = queue.pop(); if (seen.has(fi)) continue; seen.add(fi);
    for (const v of mesh.faces[fi].v) for (const other of around[v]) if (!seen.has(other)) queue.push(other);
  }
  for (const fi of seen) mesh.faces[fi].v.reverse();
  return seen;
}

/** Make winding consistent across each connected piece and point it outward (positive volume). */
function recalculateNormalsEdit(mesh) {
  const uses = edgeFaces(mesh), seen = new Set();
  for (let start = 0; start < mesh.faces.length; start++) {
    if (seen.has(start)) continue;
    const piece = [start]; seen.add(start);
    for (let k = 0; k < piece.length; k++) {
      const face = mesh.faces[piece[k]], v = face.v;
      v.forEach((a, i) => {
        const b = v[(i + 1) % v.length];
        for (const other of uses.get(edgeKey(a, b)) ?? []) {
          if (seen.has(other)) continue;
          const w = mesh.faces[other].v, j = w.indexOf(a);
          // Neighbours must run the shared edge the other way.
          if (w[(j + 1) % w.length] === b) w.reverse();
          seen.add(other); piece.push(other);
        }
      });
    }
    // Only a closed piece has an inside; open surfaces keep the winding they were given.
    const closed = piece.every(fi => mesh.faces[fi].v.every((a, i, v) => (uses.get(edgeKey(a, v[(i + 1) % v.length])) ?? []).length === 2));
    let volume = 0;
    for (const fi of piece) { const v = mesh.faces[fi].v, p0 = mesh.verts[v[0]]; for (let i = 1; i + 1 < v.length; i++) volume += dot(p0, cross(mesh.verts[v[i]], mesh.verts[v[i + 1]])); }
    if (closed && volume < 0) for (const fi of piece) mesh.faces[fi].v.reverse();
  }
}

/** Vertices connected to the selection through faces or wire edges. */
export function linkedVerts(mesh, verts) {
  const around = vertexFaces(mesh), wires = neighbours({faces: [], edges: mesh.edges}), out = new Set(verts), queue = [...verts];
  while (queue.length) {
    const at = queue.pop();
    for (const fi of around[at] ?? []) for (const v of mesh.faces[fi].v) if (!out.has(v)) { out.add(v); queue.push(v); }
    for (const v of wires.get(at) ?? []) if (!out.has(v)) { out.add(v); queue.push(v); }
  }
  return out;
}

/** Grow the selection by one ring of neighbours (through faces and wires). */
export function growSelection(mesh, verts) {
  const out = new Set(verts);
  for (const f of mesh.faces) if (f.v.some(v => verts.has(v))) f.v.forEach(v => out.add(v));
  for (const [a, b] of mesh.edges ?? []) if (verts.has(a) || verts.has(b)) { out.add(a); out.add(b); }
  return out;
}

/** Copy selected faces as a separate piece. Returns the copy's vertices. */
function duplicateFacesEdit(mesh, faces) {
  const map = new Map(), dup = i => { if (!map.has(i)) { map.set(i, mesh.verts.length); mesh.verts.push(mesh.verts[i].slice()); } return map.get(i); };
  for (const fi of [...faces]) mesh.faces.push({v: mesh.faces[fi].v.map(dup), c: mesh.faces[fi].c});
  const made = splitBowTies(mesh);
  return new Set([...map.values(), ...made.keys()]);
}

// ---------- grid fill (Blender's Face > Grid Fill) ----------

/** How sharp a corner of a closed ring is (0 for straight on). */
const cornerAngle = (mesh, ring, i) => {
  const n = ring.length, p = mesh.verts[ring[i]], a = normalize(sub(mesh.verts[ring[(i + n - 1) % n]], p)), b = normalize(sub(mesh.verts[ring[(i + 1) % n]], p));
  return Math.abs(Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(a, b)))));
};

/** The layout Grid Fill uses for a selected closed ring, as Blender works it out:
 * the sharpest corner (or `start`) first, `offset` turns it, and `span` (0 = work
 * it out from the next sharpest corner) is how many edges the first side has. */
export function gridFillLayout(mesh, verts, {span = 0, offset = 0, start = null} = {}) {
  const ring = closedRing(mesh, verts);
  if (!ring) throw refused('Grid Fill needs one closed ring of open edges selected, like the edge of a hole or a traced outline.');
  const n = ring.length;
  if (n < 4 || n % 2) throw refused(`Grid Fill needs an even number of points around the ring (this one has ${n}). Add or remove one point.`);
  let first = start !== null && ring.includes(start) ? ring.indexOf(start) : 0;
  if (start === null || !ring.includes(start)) { let best = -1; ring.forEach((_, i) => { const a = cornerAngle(mesh, ring, i); if (a > best + 1e-6) { best = a; first = i; } }); }
  let order = [...ring.slice(first), ...ring.slice(0, first)];
  const turn = ((Math.round(offset) % n) + n) % n; order = [...order.slice(turn), ...order.slice(0, turn)];
  let s = 0, a = Math.max(1, Math.min(n / 2 - 1, Math.round(span) || 0));
  if (!span) {
    a = Math.max(1, Math.min(Math.floor(n / 4), n / 2 - 1));
    const angles = order.map((_, i) => i === 0 || i === n / 2 ? 0 : cornerAngle(mesh, order, i)), sorted = [...angles].sort((x, y) => y - x);
    if (sorted[0] - sorted[n - 3] > .1) a = angles.indexOf(sorted[0]);
    if (a > n / 2) { a = n - a; s = n / 2 - a; }
    a = Math.max(1, Math.min(n / 2 - 1, a));
  }
  return {order, start: s, span: a, other: n / 2 - a};
}

/** Fill a closed ring with a grid of quads: `span` columns by (ring/2 − span) rows.
 * Inner points sit on a smooth blend of the four sides (a Coons patch). */
function gridFillEdit(mesh, verts, {span = 0, offset = 0, start = null, color = 0, facing = null} = {}) {
  const {order, start: s, span: a, other: b} = gridFillLayout(mesh, verts, {span, offset, start}), n = order.length;
  const L = i => order[((i % n) + n) % n];
  const grid = Array.from({length: b + 1}, () => new Array(a + 1));
  for (let x = 0; x <= a; x++) { grid[0][x] = L(s + x); grid[b][x] = L(s + n / 2 + a - x); }
  for (let y = 0; y <= b; y++) { grid[y][a] = L(s + a + y); grid[y][0] = L(s - y); }
  const P = i => mesh.verts[i], c0 = P(grid[0][0]), c1 = P(grid[0][a]), c2 = P(grid[b][a]), c3 = P(grid[b][0]);
  const made = new Set();
  for (let y = 1; y < b; y++) for (let x = 1; x < a; x++) {
    const u = x / a, v = y / b;
    const p = [0, 1, 2].map(k => (1 - v) * P(grid[0][x])[k] + v * P(grid[b][x])[k] + (1 - u) * P(grid[y][0])[k] + u * P(grid[y][a])[k]
      - ((1 - u) * (1 - v) * c0[k] + u * (1 - v) * c1[k] + (1 - u) * v * c3[k] + u * v * c2[k]));
    grid[y][x] = mesh.verts.length; mesh.verts.push(p); made.add(grid[y][x]);
  }
  const faces = new Set();
  for (let y = 0; y < b; y++) for (let x = 0; x < a; x++) { faces.add(mesh.faces.length); mesh.faces.push({v: [grid[y][x], grid[y][x + 1], grid[y + 1][x + 1], grid[y + 1][x]], c: color}); }
  // The ring's traced wires are now face edges.
  if (mesh.edges) { const ringKeys = new Set(order.map((v, i) => edgeKey(v, L(i + 1)))); mesh.edges = mesh.edges.filter(([p, q]) => !ringKeys.has(edgeKey(p, q))); }
  windConsistently(mesh, faces, facing);
  return {verts: new Set([...made, ...order]), span: a, offset, faces};
}

// ---------- rip (Blender's V) ----------

/** The two faces along each selected edge, split into the "left" faces (that run
 * the chain's way) and the "right" ones. Used to pick a side to rip. */
export function ripSides(mesh, edges) {
  const chains = selectedChainsOf(edges);
  if (!chains) return null;
  const half = new Map(); mesh.faces.forEach((f, fi) => f.v.forEach((a, i) => half.set(`${a}>${f.v[(i + 1) % f.v.length]}`, fi)));
  const left = new Set(), right = new Set();
  for (const {points, closed} of chains) for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (half.has(`${a}>${b}`)) left.add(half.get(`${a}>${b}`));
    if (half.has(`${b}>${a}`)) right.add(half.get(`${b}>${a}`));
  }
  return {chains, left, right};
}
/** Chains (ordered points) from a list of edges, or null where a point joins three or more. */
function selectedChainsOf(edges) {
  const links = new Map(), link = (a, b) => { links.set(a, [...(links.get(a) ?? []), b]); };
  for (const [a, b] of edges) { link(a, b); link(b, a); }
  if ([...links.values()].some(l => l.length > 2)) return null;
  const seen = new Set(), chains = [];
  for (const startAt of links.keys()) {
    if (seen.has(startAt)) continue;
    const comp = [startAt]; seen.add(startAt);
    for (let k = 0; k < comp.length; k++) for (const n of links.get(comp[k])) if (!seen.has(n)) { seen.add(n); comp.push(n); }
    const ends = comp.filter(v => links.get(v).length === 1), first = ends[0] ?? comp[0], points = [first];
    let prev = null, at = first;
    for (;;) { const next = links.get(at).find(x => x !== prev); if (next === undefined || next === first) break; points.push(next); prev = at; at = next; }
    chains.push({points, closed: !ends.length});
  }
  return chains;
}

/** Rip: tear the surface open along the selected edges. The faces on one side
 * (`side`: 'left' or 'right', see ripSides) get their own copies of the points,
 * except where the line ends inside the surface, so it opens like a slit.
 * Returns the copies (to move them away, as Blender does). */
function ripEdit(mesh, edges, side = 'left') {
  const keys = new Set(edges.map(([a, b]) => edgeKey(a, b))), uses = edgeFaces(mesh);
  const inner = edges.filter(([a, b]) => uses.get(edgeKey(a, b))?.length === 2);
  if (!inner.length) throw refused('Rip needs a line of edges with faces on both sides. Select the edges to tear open (in Edge mode), then press V.');
  const sides = ripSides(mesh, inner);
  if (!sides) throw refused('Rip works on lines of edges without branches.');
  const chosen = sides[side], verts = new Set(inner.flat()), copies = new Set();
  for (const v of verts) {
    const around = mesh.faces.flatMap((f, i) => f.v.includes(v) ? [i] : []);
    // Fans around v, split by the selected edges.
    const parent = new Map(around.map(f => [f, f])), root = f => { while (parent.get(f) !== f) { parent.set(f, parent.get(parent.get(f))); f = parent.get(f); } return f; };
    for (const [key, list] of uses) {
      if (list.length !== 2 || keys.has(key)) continue;
      const [a, b] = keyVerts(key); if (a !== v && b !== v) continue;
      parent.set(root(list[0]), root(list[1]));
    }
    const fans = new Map(); for (const f of around) { const r = root(f); if (!fans.has(r)) fans.set(r, []); fans.get(r).push(f); }
    if (fans.size < 2) continue;
    const pick = [...fans.values()].find(list => list.some(f => chosen.has(f)));
    if (!pick) continue;
    const copy = mesh.verts.length; mesh.verts.push(mesh.verts[v].slice()); copies.add(copy);
    for (const f of pick) { const w = mesh.faces[f].v; w[w.indexOf(v)] = copy; }
  }
  if (!copies.size) throw refused('Nothing to rip here: the line must cross the surface or reach its edge.');
  return copies;
}

// ---------- bevel (Blender's Ctrl+B and Ctrl+Shift+B) ----------

/** Fill the closed holes a bevel leaves around its corners: loops of open edges
 * that weren't open before. Returns the faces made. */
function fillNewHoles(mesh, wasOpen, color, onEdge = new Map()) {
  const half = new Set(); mesh.faces.forEach(f => f.v.forEach((a, i) => half.add(`${a}>${f.v[(i + 1) % f.v.length]}`)));
  // An open edge lying along an edge that was already open (the mesh's own border) is no hole.
  const incident = new Map(); for (const key of wasOpen) for (const v of keyVerts(key)) incident.set(v, [...(incident.get(v) ?? []), key]);
  const lines = v => onEdge.has(v) ? [edgeKey(...onEdge.get(v))].filter(k => wasOpen.has(k)) : incident.get(v) ?? [];
  const old = (a, b) => wasOpen.has(edgeKey(a, b)) || lines(a).some(k => lines(b).includes(k));
  const next = new Map();
  mesh.faces.forEach(f => f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (!half.has(`${b}>${a}`) && !old(a, b)) next.set(b, next.has(b) ? null : a); }));
  const made = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start) || next.get(start) === null) continue;
    const loop = []; let at = start, closed = false;
    while (at !== undefined && at !== null && !seen.has(at)) { seen.add(at); loop.push(at); at = next.get(at); if (at === start) { closed = true; break; } }
    if (closed && loop.length >= 3) { made.push(mesh.faces.length); mesh.faces.push({v: loop, c: color}); }
  }
  return made;
}

/** The profile from p to q bulging toward the old corner c (a circle-like curve,
 * Blender's default profile), `segments` pieces; the inner points only. */
function profilePoints(p, c, q, segments) {
  const out = [];
  for (let k = 1; k < segments; k++) { const t = k / segments; out.push([0, 1, 2].map(i => (1 - t) * (1 - t) * p[i] + 2 * t * (1 - t) * c[i] + t * t * q[i])); }
  return out;
}

/** Bevel edges: each selected edge between two faces becomes a strip `width`
 * wide (measured at right angles to the edge, as Blender's Offset), rounded
 * with `segments` pieces. Corners left open are closed with one face; a corner
 * left joining just two edges is dissolved, as Blender does at a cube corner.
 * Returns the new points. */
function bevelEdgesEdit(mesh, edges, {width = .1, segments = 1} = {}) {
  const uses = edgeFaces(mesh), keys = new Set(edges.map(([a, b]) => edgeKey(a, b)).filter(k => uses.get(k)?.length === 2));
  if (!keys.size) throw refused('Bevel needs edges with a face on each side. Select edges (in Edge mode), then press Ctrl+B.');
  const n = Math.max(1, Math.min(12, Math.round(segments))), wasOpen = new Set([...uses].filter(([, fs]) => fs.length === 1).map(([k]) => k));
  const corners = new Set([...keys].flatMap(keyVerts)), made = new Map(), fresh = new Set(), onEdge = new Map();
  const point = (key, p) => { if (!made.has(key)) { made.set(key, mesh.verts.length); mesh.verts.push(p); fresh.add(mesh.verts.length - 1); } return made.get(key); };
  const P = i => mesh.verts[i];
  const slideAmount = (a, along, other) => { const sin = length(cross(normalize(sub(P(along), P(a))), normalize(sub(P(other), P(a))))); return width / Math.max(.2, sin); };
  // 1. Each face touching a bevelled edge at a corner swaps the corner for a new point.
  const plan = [];
  mesh.faces.forEach((f, fi) => f.v.forEach((a, i) => {
    if (!corners.has(a)) return;
    const prev = f.v[(i + f.v.length - 1) % f.v.length], next = f.v[(i + 1) % f.v.length];
    const inPrev = keys.has(edgeKey(prev, a)), inNext = keys.has(edgeKey(a, next));
    if (!inPrev && !inNext) return;
    let at;
    if (inPrev && inNext) {
      // Both edges bevelled: the point where the two offset lines meet, inside the face.
      const d1 = normalize(sub(P(prev), P(a))), d2 = normalize(sub(P(next), P(a))), sin = Math.max(.2, length(cross(d1, d2)));
      at = point(`in:${fi}:${a}`, add(P(a), scale(add(d1, d2), width / sin)));
    } else {
      const along = inPrev ? next : prev, beside = inPrev ? prev : next, edgeLength = length(sub(P(along), P(a)));
      const d = Math.min(edgeLength * .95, slideAmount(a, along, beside));
      at = point(`on:${edgeKey(a, along)}:${a}`, add(P(a), scale(normalize(sub(P(along), P(a))), d))); onEdge.set(at, [a, along]);
    }
    plan.push({fi, a, at});
  }));
  // 2. Faces sharing a slid-along edge but not touching the bevel get the new point in that edge.
  const splits = [...made].filter(([k]) => k.startsWith('on:')).map(([k, v]) => { const [, key, a] = k.split(':'); return {edge: keyVerts(key), a: Number(a), v}; });
  for (const {fi, a, at} of plan) { const f = mesh.faces[fi].v; f[f.indexOf(a)] = at; }
  for (const {edge: [x, y], a, v} of splits) {
    const other = x === a ? y : x;
    for (const f of mesh.faces) {
      const w = f.v; for (let i = 0; i < w.length; i++) { const p = w[i], q = w[(i + 1) % w.length];
        if ((p === a && q === other) || (p === other && q === a)) { w.splice(i + 1, 0, v); break; } }
    }
  }
  // 3. A strip of faces along each bevelled edge, between the points that replaced its ends.
  const color = edge => mesh.faces[uses.get(edge)[0]].c ?? 0;
  const rails = new Map();
  for (const {fi, a, at} of plan) rails.set(`${fi}:${a}`, at);
  for (const key of keys) {
    const [a, b] = keyVerts(key), [f1, f2] = uses.get(key);
    const w1 = mesh.faces[f1].v;
    const a1 = rails.get(`${f1}:${a}`), b1 = rails.get(`${f1}:${b}`), a2 = rails.get(`${f2}:${a}`), b2 = rails.get(`${f2}:${b}`);
    // f1 runs a1→b1 or b1→a1; the strip runs the other way along that side.
    const i1 = w1.indexOf(a1), forward = w1[(i1 + 1) % w1.length] === b1;
    const side = (p, c, q) => {
      // The same corner's profile is shared by the strips on both sides of it.
      const lo = Math.min(p, q), hi = Math.max(p, q), inner = profilePoints(P(lo), P(c), P(hi), n).map((at, k) => point(`pr:${lo}:${hi}:${k}`, at));
      return [p, ...(p === lo ? inner : inner.reverse()), q];
    };
    const sideA = side(a1, a, a2), sideB = side(b1, b, b2);
    for (let k = 0; k < n; k++) mesh.faces.push({v: forward ? [sideB[k], sideA[k], sideA[k + 1], sideB[k + 1]] : [sideA[k], sideB[k], sideB[k + 1], sideA[k + 1]], c: color(key)});
  }
  // 4. Close the corners, then dissolve corners left joining just two edges.
  fillNewHoles(mesh, wasOpen, 0, onEdge).forEach(fi => { mesh.faces[fi].c = mesh.faces.find(f => f.v.some(v => fresh.has(v)))?.c ?? 0; });
  for (const a of corners) if (mesh.faces.some(f => f.v.includes(a)) && edgeCount(mesh, a) === 2) {
    const around = new Set(mesh.faces.flatMap((f, i) => f.v.includes(a) ? [i] : []));
    const face = joinRegion(mesh, around, new Set([a]));
    mesh.faces = [...mesh.faces.filter((_, i) => !around.has(i)), ...(face ? [face] : [])];
  }
  const index = cleanup(mesh);
  return new Set([...fresh].map(v => index.get(v)).filter(v => v !== undefined));
}

/** Bevel points (Ctrl+Shift+B): each selected point is cut off by a face whose
 * corners sit `width` along each of its edges. */
function bevelVertsEdit(mesh, verts, {width = .1} = {}) {
  const uses = edgeFaces(mesh), wasOpen = new Set([...uses].filter(([, fs]) => fs.length === 1).map(([k]) => k)), made = new Map(), fresh = new Set();
  const onEdge = new Map();
  const point = (a, b) => { const key = `${a}>${b}`; if (!made.has(key)) { const d = Math.min(width, length(sub(mesh.verts[b], mesh.verts[a])) * .45); made.set(key, mesh.verts.length); onEdge.set(mesh.verts.length, [a, b]); mesh.verts.push(add(mesh.verts[a], scale(normalize(sub(mesh.verts[b], mesh.verts[a])), d))); fresh.add(mesh.verts.length - 1); } return made.get(key); };
  let any = false;
  for (const f of mesh.faces) {
    if (!f.v.some(v => verts.has(v))) continue;
    const out = [];
    f.v.forEach((a, i) => {
      if (!verts.has(a)) { out.push(a); return; }
      const prev = f.v[(i + f.v.length - 1) % f.v.length], next = f.v[(i + 1) % f.v.length];
      out.push(point(a, prev), point(a, next)); any = true;
    });
    f.v = out;
  }
  if (!any) throw refused('Select points on faces to bevel them.');
  const color = mesh.faces.find(f => f.v.some(v => fresh.has(v)))?.c ?? 0;
  fillNewHoles(mesh, wasOpen, color, onEdge);
  const index = cleanup(mesh);
  return new Set([...fresh].map(v => index.get(v)).filter(v => v !== undefined));
}

// ---------- knife (Blender's K) ----------

/** Put a new point on edge a–b at `t` (0 at a), in every face and line using that
 * edge; t at either end returns that end. */
function pointOnEdge(mesh, a, b, t) {
  if (t <= 1e-4) return a; if (t >= 1 - 1e-4) return b;
  const v = mesh.verts.length; mesh.verts.push(lerp(mesh.verts[a], mesh.verts[b], t));
  for (const f of mesh.faces) { const w = f.v; for (let i = 0; i < w.length; i++) { const p = w[i], q = w[(i + 1) % w.length]; if ((p === a && q === b) || (p === b && q === a)) { w.splice(i + 1, 0, v); break; } } }
  if (mesh.edges) mesh.edges = mesh.edges.flatMap(([p, q]) => (p === a && q === b) || (p === b && q === a) ? [[p, v], [v, q]] : [[p, q]]);
  return v;
}
/** Split face fi along a new edge between two of its corners. */
function splitFace(mesh, fi, p, q) {
  const w = mesh.faces[fi].v, i = w.indexOf(p), j = w.indexOf(q), n = w.length;
  if (i < 0 || j < 0 || p === q || (i + 1) % n === j || (j + 1) % n === i) return;
  const one = [], two = [];
  for (let k = i; ; k = (k + 1) % n) { one.push(w[k]); if (k === j) break; }
  for (let k = j; ; k = (k + 1) % n) { two.push(w[k]); if (k === i) break; }
  mesh.faces[fi] = {v: one, c: mesh.faces[fi].c}; mesh.faces.push({v: two, c: mesh.faces[fi].c});
}
const segmentHit = (p, q, a, b) => {
  const r = {x: q.x - p.x, y: q.y - p.y}, s = {x: b.x - a.x, y: b.y - a.y}, den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den, u = ((a.x - p.x) * r.y - (a.y - p.y) * r.x) / den;
  return t > 1e-4 && t < 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 ? {t, u: Math.max(0, Math.min(1, u))} : null;
};
const insidePolygon = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };

/** Knife: cut new edges along a path of points, each on a corner ({v}) or on an
 * edge ({edge: [a, b], t}). Between two points the cut follows the straight line
 * on screen (`project`: local point → {x, y}) across the faces in between, as
 * Blender's knife does. Returns the points on the cut. */
function knifeEdit(mesh, path, project) {
  if (path.length < 2) throw refused('Click at least two points on edges or corners for the knife to cut between.');
  const resolve = point => point.v !== undefined ? point.v : pointOnEdge(mesh, point.edge[0], point.edge[1], point.t);
  const onFaceOf = (point, fi) => { const w = mesh.faces[fi].v; return point.v !== undefined ? w.includes(point.v) : w.includes(point.edge[0]) && w.includes(point.edge[1]); };
  const cut = new Set();
  let cur = resolve(path[0]); cut.add(cur);
  for (let k = 1; k < path.length; k++) {
    const target = path[k], goal = project(target.v !== undefined ? mesh.verts[target.v] : lerp(mesh.verts[target.edge[0]], mesh.verts[target.edge[1]], target.t));
    for (let guard = 0; ; guard++) {
      if (guard > 256) throw refused('The knife line is too long to follow; add points in between.');
      const faces = mesh.faces.flatMap((f, i) => f.v.includes(cur) ? [i] : []);
      const direct = faces.find(fi => onFaceOf(target, fi));
      if (direct !== undefined) {
        const end = resolve(target), fi = mesh.faces.findIndex(f => f.v.includes(cur) && f.v.includes(end));
        if (fi >= 0) splitFace(mesh, fi, cur, end);
        cur = end; cut.add(cur); break;
      }
      // Leave the current point through the face the line runs into.
      const from = project(mesh.verts[cur]);
      let best = null;
      for (const fi of faces) {
        const w = mesh.faces[fi].v, poly = w.map(v => project(mesh.verts[v]));
        for (let i = 0; i < w.length; i++) {
          const a = w[i], b = w[(i + 1) % w.length]; if (a === cur || b === cur) continue;
          const hit = segmentHit(from, goal, poly[i], poly[(i + 1) % w.length]); if (!hit) continue;
          const mid = {x: from.x + (goal.x - from.x) * hit.t / 2, y: from.y + (goal.y - from.y) * hit.t / 2};
          if (!insidePolygon(mid, poly)) continue;
          if (!best || hit.t < best.t) best = {t: hit.t, fi, a, b, u: hit.u};
        }
      }
      if (!best) throw refused('The knife line has to run across faces between the points you click.');
      const next = pointOnEdge(mesh, best.a, best.b, best.u);
      const fi = mesh.faces.findIndex(f => f.v.includes(cur) && f.v.includes(next));
      if (fi >= 0) splitFace(mesh, fi, cur, next);
      cur = next; cut.add(cur);
    }
  }
  return cut;
}

// ---------- batch 2 of Blender's mesh tools ----------

/** Smooth Vertices (Blender's Vertex > Smooth Vertices): each selected point
 * moves `factor` of the way toward the mean of its neighbours, `repeat` times.
 * Points on an open border only follow the border, and the two ends of a
 * traced line stay put, so outlines keep their shape while bumps relax. */
function smoothVertsEdit(mesh, verts, {factor = .5, repeat = 1} = {}) {
  const pick = [...verts].filter(v => mesh.verts[v]);
  if (!pick.length) throw refused('Select points to smooth.');
  const uses = edgeFaces(mesh), open = new Set([...uses].filter(([, fs]) => fs.length === 1).map(([k]) => k));
  const near = new Map(), border = new Map();
  for (const [a, b] of allEdges(mesh)) {
    for (const [x, y] of [[a, b], [b, a]]) { if (!near.has(x)) near.set(x, new Set()); near.get(x).add(y); }
    if (open.has(edgeKey(a, b))) for (const [x, y] of [[a, b], [b, a]]) { if (!border.has(x)) border.set(x, new Set()); border.get(x).add(y); }
  }
  const k = Math.max(-1, Math.min(1, Number(factor) || 0)), times = Math.max(1, Math.min(100, Math.round(repeat)));
  for (let r = 0; r < times; r++) {
    const next = new Map();
    for (const v of pick) {
      const around = [...(border.get(v) ?? near.get(v) ?? [])];
      if (around.length < 2) continue;
      const mean = scale(around.reduce((s, w) => add(s, mesh.verts[w]), [0, 0, 0]), 1 / around.length);
      next.set(v, add(mesh.verts[v], scale(sub(mean, mesh.verts[v]), k)));
    }
    for (const [v, p] of next) mesh.verts[v] = p;
  }
  return new Set(pick);
}

/** Triangulate Faces (Ctrl+T): quads split along their shorter diagonal (as
 * Blender's Beauty does for most quads), larger faces by ear clipping in their
 * own plane, so concave faces come out right. */
function triangulateFacesEdit(mesh, faces) {
  const pick = [...faces].filter(i => mesh.faces[i]?.v.length > 3);
  if (!pick.length) throw refused('Select faces with four or more corners to triangulate.');
  const out = [], keep = new Set(pick.flatMap(i => mesh.faces[i].v));
  mesh.faces.forEach((f, i) => {
    if (!pick.includes(i)) { out.push(f); return; }
    for (const tri of earClip(mesh, f.v)) out.push({v: tri, c: f.c});
  });
  mesh.faces = out;
  return keep;
}
/** Triangles covering a polygon, keeping its winding. */
function earClip(mesh, loop) {
  if (loop.length === 4) {
    const [a, b, c, d] = loop, P = i => mesh.verts[i];
    return length(sub(P(a), P(c))) <= length(sub(P(b), P(d))) ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
  }
  const n = faceNormalOf(mesh, loop), axis = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
  const [u, w] = [[1, 2], [2, 0], [0, 1]][axis], flip = n[axis] < 0 ? -1 : 1;
  const P2 = i => [mesh.verts[i][u], mesh.verts[i][w]];
  const area = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * flip;
  const inside = (p, a, b, c) => area(a, b, p) >= -1e-12 && area(b, c, p) >= -1e-12 && area(c, a, p) >= -1e-12;
  const rest = loop.slice(), tris = [];
  for (let guard = 0; rest.length > 3 && guard < 10000; guard++) {
    let cut = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[(i + rest.length - 1) % rest.length], b = rest[i], c = rest[(i + 1) % rest.length];
      if (area(P2(a), P2(b), P2(c)) <= 1e-14) continue;
      if (rest.some(x => x !== a && x !== b && x !== c && inside(P2(x), P2(a), P2(b), P2(c)))) continue;
      tris.push([a, b, c]); rest.splice(i, 1); cut = true; break;
    }
    if (!cut) { for (let i = 1; i + 1 < rest.length; i++) tris.push([rest[0], rest[i], rest[i + 1]]); rest.length = 0; }
  }
  if (rest.length === 3) tris.push(rest);
  return tris;
}
const faceNormalOf = (mesh, loop) => { let n = [0, 0, 0]; for (let i = 0; i < loop.length; i++) n = add(n, cross(mesh.verts[loop[i]], mesh.verts[loop[(i + 1) % loop.length]])); return normalize(n); };

/** Tris to Quads (Alt+J): join pairs of selected triangles across their shared
 * edge where the two lie nearly flat (`faceAngle`) and make a well-shaped,
 * convex quad (`shapeAngle`); the best pairs first, as Blender does. */
function trisToQuadsEdit(mesh, faces, {faceAngle = 40, shapeAngle = 40} = {}) {
  const tris = new Set([...faces].filter(i => mesh.faces[i]?.v.length === 3));
  if (tris.size < 2) throw refused('Select two or more triangles that share edges to join them into quads.');
  const P = i => mesh.verts[i], angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
  const pairs = [];
  for (const [key, list] of edgeFaces(mesh)) {
    if (list.length !== 2 || !tris.has(list[0]) || !tris.has(list[1])) continue;
    const [p, q] = keyVerts(key), t1 = mesh.faces[list[0]].v, t2 = mesh.faces[list[1]].v;
    // Order: t1 runs x→y along the shared edge; the quad is y, r, x, s.
    const i1 = t1.indexOf(p), forward = t1[(i1 + 1) % 3] === q, x = forward ? p : q, y = forward ? q : p;
    const r = t1.find(v => v !== p && v !== q), s2 = t2.find(v => v !== p && v !== q), quad = [y, r, x, s2];
    const bend = angle(faceNormalOf(mesh, t1), faceNormalOf(mesh, t2));
    if (bend > faceAngle) continue;
    // Shape: every corner of the quad near a right angle, and convex (same-side turns).
    const n = faceNormalOf(mesh, quad); let worst = 0, convex = true;
    for (let i = 0; i < 4; i++) {
      const a = P(quad[(i + 3) % 4]), b = P(quad[i]), c = P(quad[(i + 1) % 4]);
      worst = Math.max(worst, Math.abs(90 - angle(normalize(sub(a, b)), normalize(sub(c, b)))));
      if (dot(cross(sub(b, a), sub(c, b)), n) <= 0) convex = false;
    }
    if (!convex || worst > 45 + shapeAngle) continue;
    pairs.push({score: bend + worst, a: list[0], b: list[1], quad});
  }
  pairs.sort((u, v) => u.score - v.score);
  const used = new Set(), made = [];
  for (const pair of pairs) { if (used.has(pair.a) || used.has(pair.b)) continue; used.add(pair.a); used.add(pair.b); made.push({v: pair.quad, c: mesh.faces[pair.a].c}); }
  if (!made.length) throw refused('No pair of these triangles makes a good quad (they bend too much or would make a twisted shape).');
  mesh.faces = [...mesh.faces.filter((_, i) => !used.has(i)), ...made];
  return new Set(made.flatMap(f => f.v));
}

/** Poke Faces: a new point in the middle of each selected face, joined to its corners. */
function pokeFacesEdit(mesh, faces) {
  const pick = new Set([...faces].filter(i => mesh.faces[i]));
  if (!pick.size) throw refused('Select faces to poke.');
  const out = [], centres = new Set();
  mesh.faces.forEach((f, i) => {
    if (!pick.has(i)) { out.push(f); return; }
    const c = mesh.verts.length; mesh.verts.push(scale(f.v.reduce((s, v) => add(s, mesh.verts[v]), [0, 0, 0]), 1 / f.v.length)); centres.add(c);
    f.v.forEach((v, k) => out.push({v: [v, f.v[(k + 1) % f.v.length], c], c: f.c}));
  });
  mesh.faces = out;
  return centres;
}

/** Fill Holes: close every hole (loop of open edges) touching the selection
 * with `sides` corners or fewer (0 = any size) with one face. */
function fillHolesEdit(mesh, verts, {sides = 4} = {}) {
  const half = new Set(); mesh.faces.forEach(f => f.v.forEach((a, i) => half.add(`${a}>${f.v[(i + 1) % f.v.length]}`)));
  const next = new Map();
  mesh.faces.forEach(f => f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (!half.has(`${b}>${a}`)) next.set(b, next.has(b) ? null : a); }));
  const made = [], seen = new Set(), limit = Math.max(0, Math.round(sides));
  for (const start of next.keys()) {
    if (seen.has(start) || next.get(start) === null) continue;
    const loop = []; let at = start, closed = false;
    while (at !== undefined && at !== null && !seen.has(at)) { seen.add(at); loop.push(at); at = next.get(at); if (at === start) { closed = true; break; } }
    if (!closed || loop.length < 3 || (limit && loop.length > limit) || !loop.some(v => verts.has(v))) continue;
    const color = mesh.faces.find(f => f.v.includes(loop[0]))?.c ?? 0;
    made.push({v: loop, c: color});
  }
  if (!made.length) throw refused(limit ? `No hole with ${limit} corners or fewer touches the selection. Raise Sides, or set it to 0 for any size.` : 'No hole touches the selection.');
  mesh.faces.push(...made);
  if (mesh.edges) { const keys = new Set(made.flatMap(f => f.v.map((v, i) => edgeKey(v, f.v[(i + 1) % f.v.length])))); mesh.edges = mesh.edges.filter(([a, b]) => !keys.has(edgeKey(a, b))); }
  return new Set(made.flatMap(f => f.v));
}

/** The closest point to `p` on a triangle (Ericson, Real-Time Collision Detection). */
export function closestOnTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)));
}

/** Shrinkwrap (Blender's modifier, Nearest Surface Point), applied once: each of
 * `points` (world space) moves to the closest point on `surfaces` (world-space
 * meshes), then `offset` out along that face's normal. Returns the new points. */
export function shrinkwrapPoints(points, surfaces, offset = 0) {
  const tris = [];
  for (const s of surfaces) for (const [a, b, c] of triangulate(s)) { const A = s.verts[a], B = s.verts[b], C = s.verts[c], n = normalize(cross(sub(B, A), sub(C, A))); if (length(n) > 0) tris.push([A, B, C, n]); }
  if (!tris.length) throw refused('There is no other part to wrap onto. Add or show the part to press these points against.');
  return points.map(p => {
    let best = null, d = Infinity, normal = null;
    for (const [A, B, C, n] of tris) { const q = closestOnTriangle(p, A, B, C), e = length(sub(q, p)); if (e < d) { d = e; best = q; normal = n; } }
    return add(best, scale(normal, offset));
  });
}

// ---------- dissolve (Blender's Ctrl+X) ----------

/** The outline loops of a set of faces: each loop follows the faces' winding.
 * Returns null when the outline is ambiguous (the region touches itself at a point). */
function regionLoops(mesh, faces) {
  const half = new Set(), out = new Map();
  for (const fi of faces) { const v = mesh.faces[fi].v; v.forEach((a, i) => half.add(`${a}>${v[(i + 1) % v.length]}`)); }
  for (const fi of faces) {
    const v = mesh.faces[fi].v;
    v.forEach((a, i) => { const b = v[(i + 1) % v.length]; if (!half.has(`${b}>${a}`)) { if (out.has(a)) out.set(a, null); else out.set(a, b); } });
  }
  if ([...out.values()].includes(null)) return null;
  const loops = [], seen = new Set();
  for (const start of out.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let at = start;
    while (!seen.has(at)) { seen.add(at); loop.push(at); at = out.get(at); if (at === undefined) return null; }
    if (at !== start) return null;
    loops.push(loop);
  }
  return loops;
}

/** Drop `drop` from a closed loop, and fold back spurs (a→b→a) that dissolving leaves. */
function tidyLoop(loop, drop = new Set()) {
  let l = loop.filter(v => !drop.has(v)), changed = true;
  while (changed && l.length >= 3) {
    changed = false;
    for (let i = 0; i < l.length; i++) {
      const n = l.length, a = l[(i + n - 1) % n], c = l[(i + 1) % n];
      if (a === c) { l.splice(i, 1); l.splice(i % l.length, 1); changed = true; break; }
      if (l[i] === c) { l.splice(i, 1); changed = true; break; }
    }
  }
  return l;
}

/** Replace a connected set of faces with one face along its outline. */
function joinRegion(mesh, faces, drop = new Set()) {
  const loops = regionLoops(mesh, faces);
  if (!loops) throw refused('These faces touch each other at a single point, so they can\'t become one face.');
  if (loops.length !== 1) throw refused('These faces surround a hole, so they can\'t become one face. Dissolve part of them, or fill the hole first.');
  const loop = tidyLoop(loops[0], drop);
  const color = mesh.faces[Math.min(...faces)].c ?? 0;
  return loop.length >= 3 && new Set(loop).size === loop.length ? {v: loop, c: color} : null;
}

const faceGroups = (mesh, faces, joinable) => {
  const parent = new Map([...faces].map(f => [f, f])), root = f => { while (parent.get(f) !== f) { parent.set(f, parent.get(parent.get(f))); f = parent.get(f); } return f; };
  for (const [key, list] of edgeFaces(mesh)) if (list.length === 2 && parent.has(list[0]) && parent.has(list[1]) && joinable(key)) parent.set(root(list[0]), root(list[1]));
  const groups = new Map(); for (const f of faces) { const r = root(f); if (!groups.has(r)) groups.set(r, new Set()); groups.get(r).add(f); }
  return [...groups.values()];
};

/** Points used by exactly two edges (faces' or wires'), counting each edge once. */
function edgeCount(mesh, v) {
  const n = new Set();
  for (const f of mesh.faces) { const i = f.v.indexOf(v); if (i >= 0) { n.add(f.v[(i + 1) % f.v.length]); n.add(f.v[(i + f.v.length - 1) % f.v.length]); } }
  for (const [a, b] of mesh.edges ?? []) { if (a === v) n.add(b); if (b === v) n.add(a); }
  return n.size;
}

/** Take point v out of the faces and wires using it, joining its two edges into one. */
function collapsePoint(mesh, v) {
  const around = mesh.faces.filter(f => f.v.includes(v));
  if (around.some(f => f.v.length <= 3)) return false;
  around.forEach(f => { f.v = f.v.filter(x => x !== v); });
  const wires = (mesh.edges ?? []).filter(e => e.includes(v));
  if (wires.length === 2) { const ends = wires.map(([a, b]) => a === v ? b : a); mesh.edges = mesh.edges.filter(e => !e.includes(v)); if (ends[0] !== ends[1]) mesh.edges.push(ends); }
  return true;
}

/** Dissolve faces: each group of touching selected faces becomes one face. */
function dissolveFacesEdit(mesh, faces) {
  const made = [], gone = new Set();
  for (const group of faceGroups(mesh, faces, () => true)) {
    if (group.size < 2) continue;
    const face = joinRegion(mesh, group);
    group.forEach(f => gone.add(f)); if (face) made.push(face);
  }
  if (!gone.size) throw refused('Select two or more faces that share an edge to dissolve them into one.');
  mesh.faces = [...mesh.faces.filter((_, i) => !gone.has(i)), ...made];
  const index = cleanup(mesh);
  return new Set(made.flatMap(f => f.v.map(v => index.get(v))).filter(i => i !== undefined));
}

/** Dissolve edges: the faces on both sides of each edge become one face; wires
 * are removed. With `verts` (Blender's default), points left joining just two
 * edges in a line are taken out too. */
function dissolveEdgesEdit(mesh, edges, {verts = true} = {}) {
  const keys = new Set(edges.map(([a, b]) => edgeKey(a, b))), uses = edgeFaces(mesh);
  const faces = new Set([...keys].flatMap(k => (uses.get(k)?.length === 2 ? uses.get(k) : [])));
  const ends = new Set(edges.flat()), onFaces = new Set(mesh.faces.flatMap(f => f.v));
  let changed = false;
  if (mesh.edges) { const before = mesh.edges.length; mesh.edges = mesh.edges.filter(([a, b]) => !keys.has(edgeKey(a, b))); changed = mesh.edges.length !== before; }
  if (faces.size) {
    const made = [], gone = new Set();
    for (const group of faceGroups(mesh, faces, key => keys.has(key))) {
      const face = joinRegion(mesh, group); group.forEach(f => gone.add(f)); if (face) made.push(face);
    }
    mesh.faces = [...mesh.faces.filter((_, i) => !gone.has(i)), ...made]; changed = true;
  }
  if (!changed) throw refused('Select edges between two faces (or traced lines) to dissolve them.');
  if (verts) for (const v of ends) if (mesh.faces.some(f => f.v.includes(v)) && edgeCount(mesh, v) === 2) collapsePoint(mesh, v);
  // Traced points left with nothing stay as loose points.
  const used = new Set([...mesh.faces.flatMap(f => f.v), ...(mesh.edges ?? []).flat()]);
  const strand = [...ends].filter(v => !onFaces.has(v) && !used.has(v) && !(mesh.loose ?? []).includes(v));
  if (strand.length) mesh.loose = [...(mesh.loose ?? []), ...strand];
  cleanup(mesh);
  return new Set();
}

/** Dissolve points: the faces around each point become one face without it;
 * a point in the middle of a line joins its two edges into one. */
function dissolveVertsEdit(mesh, verts) {
  let changed = false;
  for (const v of verts) {
    const around = new Set(mesh.faces.flatMap((f, i) => f.v.includes(v) ? [i] : []));
    if (around.size >= 2) {
      const face = joinRegion(mesh, around, new Set([v]));
      mesh.faces = [...mesh.faces.filter((_, i) => !around.has(i)), ...(face ? [face] : [])];
      if (mesh.edges) mesh.edges = mesh.edges.filter(e => !e.includes(v));
      changed = true;
    } else if (around.size === 1) {
      const f = mesh.faces[[...around][0]];
      if (f.v.length > 3) f.v = f.v.filter(x => x !== v); else mesh.faces = mesh.faces.filter(x => x !== f);
      if (mesh.edges) mesh.edges = mesh.edges.filter(e => !e.includes(v));
      changed = true;
    } else {
      const wires = (mesh.edges ?? []).filter(e => e.includes(v));
      if (wires.length === 2) { collapsePoint(mesh, v); changed = true; }
      else if (wires.length) { mesh.edges = mesh.edges.filter(e => !e.includes(v)); changed = true; }
      else if ((mesh.loose ?? []).includes(v)) { mesh.loose = mesh.loose.filter(x => x !== v); changed = true; }
    }
  }
  if (!changed) throw refused('Select points to dissolve.');
  cleanup(mesh);
  return new Set();
}

/** Merge each connected group of selected points at its own centre (Blender's Collapse). */
function collapseVertsEdit(mesh, verts) {
  const parent = new Map([...verts].map(v => [v, v])), root = v => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
  for (const [a, b] of allEdges(mesh)) if (parent.has(a) && parent.has(b)) parent.set(root(a), root(b));
  const groups = new Map(); for (const v of verts) { const r = root(v); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); }
  const target = new Map();
  for (const list of groups.values()) { const at = centroid(mesh, new Set(list)); mesh.verts[list[0]] = at; for (const v of list) target.set(v, list[0]); }
  const map = i => target.get(i) ?? i;
  mesh.faces.forEach(f => { f.v = f.v.map(map); });
  if (mesh.edges) mesh.edges = mesh.edges.map(e => e.map(map));
  if (mesh.loose) mesh.loose = [...new Set(mesh.loose.map(map))];
  const keepers = [...groups.values()].map(l => l[0]);
  for (const k of keepers) if (!mesh.faces.some(f => f.v.includes(k)) && !(mesh.edges ?? []).some(([a, b]) => a !== b && (a === k || b === k)) && !(mesh.loose ?? []).includes(k)) mesh.loose = [...(mesh.loose ?? []), k];
  // Faces that now repeat another face's points go.
  const seen = new Set(); mesh.faces = mesh.faces.filter(f => { const k = [...new Set(f.v)].sort((a, b) => a - b).join(','); if (seen.has(k)) return false; seen.add(k); return true; });
  const index = cleanup(mesh);
  return new Set(keepers.map(k => index.get(k)).filter(i => i !== undefined));
}

/** Rebuild the -X half as a mirror of the +X half (or the reverse), welding the middle. */
/** Symmetrize: make one side of the middle (world X = 0, the plane the mirror uses)
 * a copy of the other. `fromPositive`: keep +X and copy it to -X, or 'auto' to keep
 * the side holding more of the mesh. `matrix`: the part's local → world matrix, so a
 * part placed off the middle still mirrors about the world middle. Lines and points
 * are copied too; anything crossing the middle on the side being replaced is dropped. */
function symmetrizeEdit(mesh, fromPositive = true, matrix = null, tolerance = 1e-4) {
  if (matrix) {
    const inverse = invert(matrix);
    mesh.verts = mesh.verts.map(p => [...transformPoint(matrix, p)]);
    if (mesh.vdata) Object.assign(mesh, copyVData(mesh, normalMatrix(matrix)));
    const result = symmetrizeEdit(mesh, fromPositive, null, tolerance);
    mesh.verts = mesh.verts.map(p => { const q = [...transformPoint(inverse, p)]; return q; });
    if (mesh.vdata) Object.assign(mesh, copyVData(mesh, normalMatrix(inverse)));
    return result;
  }
  if (fromPositive === 'auto') fromPositive = symmetrizeSide(mesh);
  const side = x => fromPositive ? x >= -tolerance : x <= tolerance;
  mesh.faces = mesh.faces.filter(f => f.v.every(i => side(mesh.verts[i][0])));
  if (mesh.edges) mesh.edges = mesh.edges.filter(e => e.every(i => side(mesh.verts[i][0])));
  if (mesh.loose) mesh.loose = mesh.loose.filter(i => side(mesh.verts[i][0]));
  cleanup(mesh);
  mesh.verts.forEach(p => { if (Math.abs(p[0]) <= tolerance) p[0] = 0; });
  const count = mesh.verts.length, map = mesh.verts.map((p, i) => {
    if (p[0] === 0) return i;
    mesh.verts.push([-p[0], p[1], p[2]]); return mesh.verts.length - 1;
  });
  const faces = mesh.faces.length;
  for (let i = 0; i < faces; i++) mesh.faces.push({v: mesh.faces[i].v.map(j => map[j]).reverse(), c: mesh.faces[i].c});
  mirrorVData(mesh, map);
  if (mesh.edges) mesh.edges = [...mesh.edges, ...mesh.edges.map(e => e.map(j => map[j]))];
  if (mesh.loose) mesh.loose = [...mesh.loose, ...mesh.loose.map(j => map[j])];
  cleanup(mesh);
  return count;
}

/** Which side Symmetrize keeps by default: the one with more points off the middle (+X on a tie). */
export function symmetrizeSide(mesh, tolerance = 1e-4) {
  let plus = 0, minus = 0;
  for (const p of mesh.verts) { if (p[0] > tolerance) plus++; else if (p[0] < -tolerance) minus++; }
  return plus >= minus;
}

/** Mirror a mesh across X (a copy, welded on the middle); used by the mirror modifier. */
export function mirrored(mesh, tolerance = 1e-4) {
  const out = surfaceOf(mesh);
  // Faces lying on the mirror plane would sit inside the whole; drop them.
  out.faces = out.faces.filter(f => !f.v.every(i => Math.abs(out.verts[i][0]) <= tolerance));
  const map = out.verts.map((p, i) => {
    if (Math.abs(p[0]) <= tolerance) { p[0] = 0; return i; }
    out.verts.push([-p[0], p[1], p[2]]); return out.verts.length - 1;
  });
  const faces = out.faces.length;
  for (let i = 0; i < faces; i++) out.faces.push({v: out.faces[i].v.map(j => map[j]).reverse(), c: out.faces[i].c});
  mirrorVData(out, map);
  cleanup(out);
  return out;
}

/** Axis-aligned bounds {min, max}. */
export function bounds(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return {min, max};
}

/** A part's local → world matrix (T · R · S). */
export const objectMatrix = object => fromTRS(object.position ?? [0, 0, 0], object.rotation ?? [0, 0, 0], object.scale ?? [1, 1, 1]);
/** True when a part's transform mirrors it (negative scale), turning faces inside out. */
export const objectMirrors = object => determinant3(objectMatrix(object)) < 0;
/** A part's local → world transform as a pure function of a point. */
export function objectTransform(object) { const m = objectMatrix(object); return p => [...transformPoint(m, p)]; }
/** World → local (the inverse of objectTransform), also pure. */
export function objectInverse(object) { const m = invert(objectMatrix(object)); return p => [...transformPoint(m, p)]; }

// The public, atomic edits (see atomic() above).
export const deleteVerts = atomic('Delete', deleteVertsEdit);
export const deleteFaces = atomic('Delete faces', deleteFacesEdit);
export const extrudeFaces = atomic('Extrude', extrudeFacesEdit);
export const extrudeEdges = atomic('Extrude edges', extrudeEdgesEdit);
export const insetFaces = atomic('Inset', insetFacesEdit);
export const subdivideFaces = atomic('Subdivide', subdivideFacesEdit);
export const loopCut = atomic('Loop cut', loopCutEdit);
export const mergeVerts = atomic('Merge', mergeVertsEdit);
export const mergeByDistance = atomic('Merge doubles', mergeByDistanceEdit);
export const fillVerts = atomic('Fill', fillVertsEdit);
export const flipFaces = atomic('Flip faces', flipFacesEdit);
export const recalculateNormals = atomic('Fix inside-out faces', recalculateNormalsEdit);
export const duplicateFaces = atomic('Duplicate', duplicateFacesEdit);
export const symmetrize = atomic('Symmetrize', symmetrizeEdit);
export const extrudePoints = atomic('Extrude point', extrudePointsEdit);
export const addPoint = atomic('Add point', addPointEdit);
export const bridge = atomic('Bridge', bridgeEdit);
export const orientWireFaces = atomic('Face the viewer', orientWireFacesEdit);
/** The same winding on a mesh copy being dragged (no validation: the move's own result is
 * checked when it's confirmed), so quads grown from traced lines face you while they grow. */
export const faceViewerDuringMove = orientWireFacesEdit;
export const duplicatePoints = atomic('Duplicate points', duplicatePointsEdit);
export const dissolveFaces = atomic('Dissolve faces', dissolveFacesEdit);
export const dissolveEdges = atomic('Dissolve edges', dissolveEdgesEdit);
export const dissolveVerts = atomic('Dissolve points', dissolveVertsEdit);
export const collapseVerts = atomic('Collapse', collapseVertsEdit);
export const gridFill = atomic('Grid Fill', gridFillEdit);
export const rip = atomic('Rip', ripEdit);
export const bevelEdges = atomic('Bevel', bevelEdgesEdit);
export const bevelVerts = atomic('Bevel points', bevelVertsEdit);
export const knife = atomic('Knife', knifeEdit);
export const smoothVerts = atomic('Smooth vertices', smoothVertsEdit);
export const triangulateFaces = atomic('Triangulate', triangulateFacesEdit);
export const trisToQuads = atomic('Tris to quads', trisToQuadsEdit);
export const pokeFaces = atomic('Poke faces', pokeFacesEdit);
export const fillHoles = atomic('Fill holes', fillHolesEdit);
