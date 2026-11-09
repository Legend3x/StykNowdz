// 3D Nowdz tools ported from Blender (docs/BLENDER-LITE.md, "Blender's modeling
// tools"): dissolve, merge options, grid fill, rip, bevel and knife. Each result
// is checked against what Blender makes for the same selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {validateMesh, TopologyError} from '../src/modeler/topology.mjs';
import {cube, uvSphere} from '../src/modeler/primitives.mjs';

const quiet = {print: false};
const valid = (mesh, label) => assert.ok(validateMesh(mesh, quiet).ok, label);
const sizes = mesh => mesh.faces.map(f => f.v.length).sort((a, b) => a - b).join('');
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} ≉ ${b}`);
/** An n×n grid of unit quads in the XY plane; vertex (x, y) is y*(n+1)+x. */
function grid(n) {
  const verts = [], faces = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) verts.push([x, y, 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = y * (n + 1) + x; faces.push({v: [i, i + 1, i + n + 2, i + n + 1], c: 0}); }
  return {verts, faces};
}
const volume = m => { let v = 0; for (const f of m.faces) for (let i = 1; i + 1 < f.v.length; i++) { const [a, b, c] = [f.v[0], f.v[i], f.v[i + 1]].map(k => m.verts[k]); v += M.dot(a, M.cross(b, c)) / 6; } return v; };
const quiet3 = fn => { const log = console.error; console.error = () => {}; try { return fn(); } finally { console.error = log; } };

test('dissolve points, edges and faces keep the surface, as Blender does', () => {
  let g = grid(2); M.dissolveVerts(g, new Set([4])); valid(g); assert.equal(sizes(g), '8', 'centre of a 2×2 grid: one 8-sided face');
  g = grid(2); M.dissolveEdges(g, [[1, 4]]); valid(g); assert.equal(g.verts.length, 8, 'the end left joining two edges goes too'); assert.equal(sizes(g), '445');
  g = grid(3); M.dissolveFaces(g, new Set([0, 1, 3, 4])); valid(g); assert.equal(sizes(g), '444448');
  let c = cube(); M.dissolveVerts(c, new Set([0])); valid(c); assert.equal(sizes(c), '4446');
  c = cube(); M.dissolveEdges(c, [M.meshEdges(c)[0]]); valid(c); assert.equal(sizes(c), '33444', 'a cube edge: the wedge Blender makes');
  const s = uvSphere(.5, 8, 6); M.dissolveVerts(s, new Set([0])); valid(s); assert.ok(s.faces.some(f => f.v.length === 8), 'a pole fan becomes one face');
  const line = {verts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], faces: [], edges: [[0, 1], [1, 2]]};
  M.dissolveVerts(line, new Set([1])); valid(line); assert.deepEqual(line.edges, [[0, 1]]);
  // A ring of faces around a hole can't become one face: refused, mesh untouched.
  g = grid(3); const before = JSON.stringify(g);
  assert.throws(() => M.dissolveFaces(g, new Set([0, 1, 2, 3, 5, 6, 7, 8])), error => error.modelerMessage);
  assert.equal(JSON.stringify(g), before);
});

test('merge at first, last and collapse', () => {
  let g = grid(2); M.mergeVerts(g, new Set([0, 1]), g.verts[1].slice()); valid(g);
  assert.ok(g.verts.some(p => p[0] === 1 && p[1] === 0)); assert.ok(!g.verts.some(p => p[0] === 0 && p[1] === 0), 'merged at the last point');
  g = grid(2); const kept = M.collapseVerts(g, new Set([0, 1, 3, 4, 8])); valid(g);
  assert.equal(kept.size, 2, 'two separate groups, each merged at its own centre');
});

test('grid fill: a closed ring becomes a grid of quads, Span and Offset as in Blender', () => {
  const circle = n => ({verts: Array.from({length: n}, (_, i) => [Math.cos(i / n * 2 * Math.PI), Math.sin(i / n * 2 * Math.PI), 0]), faces: [], edges: Array.from({length: n}, (_, i) => [i, (i + 1) % n])});
  let c = circle(12); let r = M.gridFill(c, new Set(c.verts.keys()), {facing: [0, 0, 1]});
  valid(c); assert.equal(r.span, 3); assert.equal(c.faces.length, 9); assert.ok(M.faceNormal(c, c.faces[0])[2] > .9, 'faces the viewer');
  assert.equal(c.edges?.length ?? 0, 0, 'the traced ring became face edges');
  c = circle(12); r = M.gridFill(c, new Set(c.verts.keys()), {span: 2}); valid(c); assert.equal(c.faces.length, 2 * 4);
  // A rectangle 3 by 2 edges: the corners give the span; inner points on the flat grid.
  const rect = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0], [3, 2, 0], [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 1, 0]];
  const m = {verts: rect, faces: [], edges: rect.map((_, i) => [i, (i + 1) % rect.length])};
  r = M.gridFill(m, new Set(m.verts.keys())); valid(m);
  assert.deepEqual(m.verts.slice(10).map(p => p.map(v => Math.round(v * 1e6) / 1e6)).sort(), [[1, 1, 0], [2, 1, 0]]);
  // Closing a hole in a sphere.
  const s = uvSphere(.5, 8, 6), top = new Set(s.faces.flatMap((f, i) => f.v.some(v => s.verts[v][1] > .4) ? [i] : []));
  M.deleteFaces(s, top); const uses = M.edgeFaces(s);
  M.gridFill(s, new Set(M.meshEdges(s).filter(([a, b]) => uses.get(M.edgeKey(a, b)).length === 1).flat())); valid(s);
  assert.ok([...M.edgeFaces(s).values()].every(fs => fs.length === 2), 'closed again');
  c = circle(7); assert.throws(() => M.gridFill(c, new Set(c.verts.keys())), /even number/);
});

test('rip tears a slit inside the surface and a cut across it', () => {
  let g = grid(4); let copies = M.rip(g, [[11, 12], [12, 13]], 'left'); valid(g);
  assert.equal(copies.size, 1, 'a slit: only the middle point splits, the ends stay joined');
  g = grid(4); copies = M.rip(g, [[10, 11], [11, 12], [12, 13], [13, 14]], 'right'); valid(g); assert.equal(copies.size, 5, 'across: every point splits');
  assert.throws(() => M.rip(grid(2), [[0, 1]]), /faces on both sides/);
});

test('bevel edges and points match Blender\'s counts', () => {
  let c = cube(); M.bevelEdges(c, [M.meshEdges(c)[0]], {width: .1}); valid(c);
  assert.equal(c.verts.length, 10); assert.equal(sizes(c), '4444455'); near(volume(c), 1 - .1 * .1 / 2);
  c = cube(); M.bevelEdges(c, M.meshEdges(c), {width: .1}); valid(c); assert.equal(c.verts.length, 24); assert.equal(c.faces.length, 26);
  c = cube(); const f = c.faces[0].v; M.bevelEdges(c, f.map((v, i) => [v, f[(i + 1) % f.length]]), {width: .1}); valid(c); assert.equal(c.verts.length, 12); assert.equal(c.faces.length, 10);
  c = cube(); M.bevelEdges(c, [M.meshEdges(c)[0]], {width: .1, segments: 3}); valid(c); assert.equal(c.faces.length, 9);
  c = cube(); M.bevelVerts(c, new Set([0]), {width: .2}); valid(c); assert.equal(sizes(c), '3444555');
  const tri = {verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [{v: [0, 1, 2], c: 0}]};
  M.bevelVerts(tri, new Set([0, 1]), {width: .2}); valid(tri); assert.equal(sizes(tri), '5', 'corners of an open face are just cut off');
  const g = grid(4); M.bevelEdges(g, [[11, 12], [12, 13], [7, 12]], {width: .2}); valid(g);
  assert.throws(() => M.bevelEdges(grid(1), [[0, 1]]), /face on each side/);
});

test('knife cuts along the clicked points across faces', () => {
  const project = p => ({x: p[0] * 100, y: -p[1] * 100});
  let g = grid(1); M.knife(g, [{edge: [0, 1], t: .5}, {edge: [2, 3], t: .5}], project); valid(g); assert.equal(g.faces.length, 2);
  g = grid(3); const cut = M.knife(g, [{edge: [0, 1], t: .5}, {edge: [12, 13], t: .5}], project); valid(g);
  assert.equal(cut.size, 4); assert.equal(g.faces.length, 12);
  g = grid(3); M.knife(g, [{edge: [0, 1], t: .3}, {edge: [7, 11], t: .6}, {edge: [13, 14], t: .5}], project); valid(g);
  assert.throws(() => M.knife(grid(1), [{v: 0}], project), /two points/);
});

test('open meshes are drawn and edited from both sides, as in Blender', () => {
  assert.equal(M.isOpenMesh(cube()), false);
  assert.equal(M.isOpenMesh(uvSphere(.5, 8, 6)), false);
  // A traced eye ring extruded into a band is open: its far half must not vanish.
  const n = 8, ring = {verts: Array.from({length: n}, (_, i) => [Math.cos(i / n * 2 * Math.PI), Math.sin(i / n * 2 * Math.PI) * .4, 0]), faces: [], edges: Array.from({length: n}, (_, i) => [i, (i + 1) % n])};
  M.extrudeEdges(ring, M.edgesFromVerts(ring, new Set(ring.verts.keys())));
  assert.equal(M.isOpenMesh(ring), true);
});

test('random runs of the Blender tools never leave a broken mesh', () => {
  quiet3(() => {
    for (let seedN = 1; seedN <= 8; seedN++) {
      let seed = seedN * 104729; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const mesh = [cube, () => uvSphere(.5, 8, 6), () => grid(4)][seedN % 3]();
      for (let step = 0; step < 80; step++) {
        const faces = new Set(mesh.faces.map((_, i) => i).filter(() => random() < .2)), verts = new Set([...mesh.verts.keys()].filter(() => random() < .15));
        const edges = M.edgesFromVerts(mesh, verts), all = M.meshEdges(mesh), pick = () => { const e = all[Math.floor(random() * all.length)]; return random() < .3 ? {v: e[0]} : {edge: e, t: random()}; };
        const ops = [() => M.dissolveVerts(mesh, verts), () => M.dissolveEdges(mesh, edges), () => M.dissolveFaces(mesh, faces), () => M.collapseVerts(mesh, verts),
          () => M.rip(mesh, edges, random() < .5 ? 'left' : 'right'), () => M.bevelEdges(mesh, edges, {width: random() * .3, segments: 1 + Math.floor(random() * 3)}),
          () => M.bevelVerts(mesh, verts, {width: random() * .3}), () => all.length > 1 && M.knife(mesh, [pick(), pick()], p => ({x: (p[0] + p[2] * .4) * 200, y: -p[1] * 200})),
          () => { const uses = M.edgeFaces(mesh); M.gridFill(mesh, new Set(all.filter(([a, b]) => uses.get(M.edgeKey(a, b)).length === 1).flat())); },
          () => M.extrudeFaces(mesh, faces), () => M.subdivideFaces(mesh, faces), () => M.deleteFaces(mesh, faces)];
        try { ops[Math.floor(random() * ops.length)](); } catch (error) { if (!(error instanceof TopologyError || error?.modelerMessage)) throw error; }
        assert.ok(validateMesh(mesh, quiet).ok, `seed ${seedN} step ${step}`);
        if (!mesh.faces.length || mesh.verts.length > 3000) break;
      }
    }
  });
});
