/** 3D Nowdz topology rules (docs/BLENDER-LITE.md, "Data integrity").
 *
 * Meshes are stored as a face-vertex list ({verts, faces: [{v, c}]}), which is
 * simple to save, undo and export. validateMesh() builds the half-edge view of
 * that list on every check and enforces what a half-edge (BMesh-style) mesh
 * guarantees by construction:
 *
 *   H1 structure       verts are finite [x, y, z]; faces are {v: int[], c: int}
 *   H2 dangling        every corner points at an existing vertex
 *   H3 face            a face has at least 3 corners, none repeated
 *   H4 half-edge       each directed edge (a→b) belongs to one face only, so
 *                      neighbours agree on winding and every half-edge has at
 *                      most one twin (b→a)
 *   H5 manifold edge   an edge joins at most two faces
 *   H6 manifold vertex the faces around a vertex form one fan (no bow-ties)
 *   H7 orphan          every vertex is used by a face, a wire edge, or is
 *                      listed as a loose point
 *   H8 duplicate face  no two faces use the same set of vertices
 *   H9 color           a face's color is a palette index
 *   W1 wire edge       optional `edges` ([[a, b]]): lines drawn while tracing
 *                      a shape, not yet filled; two different existing points
 *   W2 duplicate wire  a wire edge appears once and is not also a face edge
 *                      (once filled, the face owns the edge)
 *   L1 loose point     optional `loose` ([i]): single points kept on purpose
 *                      (the start of a trace); existing, listed once, and used
 *                      by nothing else
 *
 * Open borders (an edge with one face) are allowed and reported as notes, as
 * are faces with no area. Everything is pure: the mesh is only read. */

export const TOPOLOGY_RULES = Object.freeze({
  H1: 'structure', H2: 'dangling vertex index', H3: 'degenerate face', H4: 'half-edge used twice (winding or duplicate)',
  H5: 'non-manifold edge', H6: 'non-manifold vertex', H7: 'orphan vertex', H8: 'duplicate face', H9: 'invalid color index',
  W1: 'wire edge', W2: 'duplicate wire edge', L1: 'loose point',
});

const MAX_DETAILS = 40;

/**
 * Check a mesh. Returns {ok, errors, warnings, stats}; each problem is
 * {rule, message, face?, vertex?, edge?}. With `print` (the default when the
 * mesh is broken), a readable report goes to `log` (console.error).
 */
export function validateMesh(mesh, {label = 'mesh', print, log = console.error, paletteSize = Infinity} = {}) {
  const errors = [], warnings = [];
  let usable = 0;
  const error = (rule, message, at = {}) => { errors.push({rule, message, ...at}); };
  if (!mesh || typeof mesh !== 'object' || !Array.isArray(mesh.verts) || !Array.isArray(mesh.faces)) {
    error('H1', 'The mesh needs a verts array and a faces array.');
    return finish();
  }
  const n = mesh.verts.length;
  mesh.verts.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) error('H1', `Vertex ${i} is not three finite numbers: ${JSON.stringify(p)}.`, {vertex: i});
  });
  // Half-edges: one per face corner, from v[i] to v[i+1].
  const half = new Map(), around = Array.from({length: n}, () => []), faceKeys = new Map(), edges = new Map();
  mesh.faces.forEach((face, f) => {
    if (!face || typeof face !== 'object' || !Array.isArray(face.v)) { error('H1', `Face ${f} has no corner list.`, {face: f}); return; }
    const v = face.v;
    if (!Number.isInteger(face.c ?? 0) || (face.c ?? 0) < 0 || (face.c ?? 0) >= paletteSize) error('H9', `Face ${f} has color ${JSON.stringify(face.c)}, which is not a palette index.`, {face: f});
    if (v.length < 3) { error('H3', `Face ${f} has ${v.length} corner(s); a face needs at least 3.`, {face: f}); return; }
    const bad = v.filter(i => !Number.isInteger(i) || i < 0 || i >= n);
    if (bad.length) { error('H2', `Face ${f} points at vertex ${bad.map(String).join(', ')}, but the mesh has vertices 0–${n - 1}.`, {face: f}); return; }
    if (new Set(v).size !== v.length) { error('H3', `Face ${f} repeats a vertex: [${v.join(', ')}].`, {face: f}); return; }
    usable++;
    const key = [...v].sort((a, b) => a - b).join(',');
    if (faceKeys.has(key)) error('H8', `Faces ${faceKeys.get(key)} and ${f} use the same vertices [${v.join(', ')}].`, {face: f});
    else faceKeys.set(key, f);
    v.forEach((a, i) => {
      const b = v[(i + 1) % v.length], k = `${a}>${b}`, edge = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
      if (half.has(k)) error('H4', `Half-edge ${a}→${b} belongs to faces ${half.get(k).face} and ${f}: their windings disagree or one face is doubled.`, {face: f, edge: [a, b]});
      else { const he = {from: a, to: b, face: f}; half.set(k, he); around[a].push(he); }
    });
    if (faceArea(mesh, v) < 1e-12) warnings.push({rule: 'area', message: `Face ${f} has no area (its corners are in a line or on one point).`, face: f});
  });
  // Edges: how many faces each joins (counted from every corner, duplicates included).
  let border = 0;
  for (const [k, count] of edges) {
    if (count > 2) error('H5', `Edge ${k.replace(',', '–')} joins ${count} faces; an edge can join at most two.`, {edge: k.split(',').map(Number)});
    else if (count === 1) border++;
  }
  if (border) warnings.push({rule: 'border', message: `${border} open border edge(s): the surface has a hole or is a sheet.`});
  // Wire edges and loose points (tracing): checked like faces, then they count as uses.
  const wired = new Set(), loose = new Set();
  if (mesh.edges !== undefined) {
    if (!Array.isArray(mesh.edges)) error('W1', 'The wire edges must be a list of [a, b] pairs.');
    else {
      const seen = new Set();
      mesh.edges.forEach((e, k) => {
        if (!Array.isArray(e) || e.length !== 2 || !e.every(i => Number.isInteger(i) && i >= 0 && i < n)) { error('W1', `Wire edge ${k} is not two existing vertices: ${JSON.stringify(e)}.`, {edge: e}); return; }
        if (e[0] === e[1]) { error('W1', `Wire edge ${k} joins vertex ${e[0]} to itself.`, {edge: e}); return; }
        const key = e[0] < e[1] ? `${e[0]},${e[1]}` : `${e[1]},${e[0]}`;
        if (seen.has(key)) error('W2', `Wire edge ${key.replace(',', '–')} is listed twice.`, {edge: e});
        else if (edges.has(key)) error('W2', `Wire edge ${key.replace(',', '–')} is also a face edge.`, {edge: e});
        seen.add(key); wired.add(e[0]); wired.add(e[1]);
      });
    }
  }
  if (mesh.loose !== undefined) {
    if (!Array.isArray(mesh.loose)) error('L1', 'The loose points must be a list of vertex numbers.');
    else mesh.loose.forEach(i => {
      if (!Number.isInteger(i) || i < 0 || i >= n) error('L1', `Loose point ${JSON.stringify(i)} is not an existing vertex.`, {vertex: i});
      else if (loose.has(i)) error('L1', `Loose point ${i} is listed twice.`, {vertex: i});
      else if (around[i].length || wired.has(i)) error('L1', `Vertex ${i} is listed as loose but is part of a face or a wire edge.`, {vertex: i});
      loose.add(i);
    });
  }
  // Vertices: the faces around a vertex must form one fan. Two faces are
  // neighbours around v when one has the half-edge v→a and the other its twin
  // a→v; union-find over every outgoing half-edge counts the fans.
  for (let v = 0; v < n; v++) {
    const out = around[v];
    if (!out.length) { if (Array.isArray(mesh.verts[v]) && !wired.has(v) && !loose.has(v)) error('H7', `Vertex ${v} is not used by any face or wire edge, and is not a loose point.`, {vertex: v}); continue; }
    const parent = new Map(out.map(he => [he.face, he.face]));
    const root = f => { while (parent.get(f) !== f) { parent.set(f, parent.get(parent.get(f))); f = parent.get(f); } return f; };
    for (const he of out) {
      const twin = half.get(`${he.to}>${v}`);
      if (twin && parent.has(twin.face)) parent.set(root(he.face), root(twin.face));
    }
    const fans = new Set([...parent.keys()].map(root)).size;
    if (fans > 1) error('H6', `Vertex ${v} joins ${fans} separate fans of faces (a bow-tie); faces around a vertex must form one fan.`, {vertex: v});
  }
  return finish();

  function finish() {
    const result = {ok: errors.length === 0, errors, warnings, stats: {vertices: mesh?.verts?.length ?? 0, faces: mesh?.faces?.length ?? 0, usableFaces: usable ?? 0,
      wires: Array.isArray(mesh?.edges) ? mesh.edges.length : 0, loose: Array.isArray(mesh?.loose) ? mesh.loose.length : 0}};
    if (print ?? !result.ok) { const report = formatTopologyReport(result, label); if (report) log(report); }
    return result;
  }
}

function faceArea(mesh, v) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < v.length; i++) {
    const a = mesh.verts[v[i]], b = mesh.verts[v[(i + 1) % v.length]];
    if (!a || !b) return 1;
    x += a[1] * b[2] - a[2] * b[1]; y += a[2] * b[0] - a[0] * b[2]; z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
}

/** A readable report of a validateMesh result (empty when there is nothing to say). */
export function formatTopologyReport(result, label = 'mesh') {
  if (!result.errors.length && !result.warnings.length) return '';
  const lines = [`Topology check of ${label}: ${result.errors.length ? `${result.errors.length} error(s)` : 'valid'}` +
    `${result.warnings.length ? `, ${result.warnings.length} note(s)` : ''} (${result.stats.vertices} vertices, ${result.stats.faces} faces).`];
  const byRule = new Map();
  for (const e of result.errors) byRule.set(e.rule, [...(byRule.get(e.rule) ?? []), e]);
  for (const [rule, list] of byRule) {
    lines.push(`  ${rule} ${TOPOLOGY_RULES[rule]} × ${list.length}`);
    for (const e of list.slice(0, MAX_DETAILS)) lines.push(`    - ${e.message}`);
    if (list.length > MAX_DETAILS) lines.push(`    … and ${list.length - MAX_DETAILS} more.`);
  }
  for (const w of result.warnings.slice(0, MAX_DETAILS)) lines.push(`  note: ${w.message}`);
  return lines.join('\n');
}

/** Thrown when an operation would break the mesh; the mesh is left as it was. */
export class TopologyError extends Error {
  constructor(operation, result) {
    const first = result.errors[0];
    super(`${operation} was undone because it would break the mesh: ${first ? `${TOPOLOGY_RULES[first.rule]} (${first.message})` : 'invalid mesh'}${result.errors.length > 1 ? ` and ${result.errors.length - 1} more problem(s)` : ''}.`);
    this.name = 'TopologyError'; this.operation = operation; this.result = result;
  }
}

/** Throw a TopologyError (after printing the report) unless the mesh is valid. */
export function assertValidMesh(mesh, operation = 'This change', options = {}) {
  const result = validateMesh(mesh, {label: `${operation}`, ...options});
  if (!result.ok) throw new TopologyError(operation, result);
  return result;
}
