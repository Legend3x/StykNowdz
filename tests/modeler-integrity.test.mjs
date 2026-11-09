// 3D Nowdz data integrity (docs/BLENDER-LITE.md, "Data integrity"): pure
// matrix transforms, atomic validated edits, and validateMesh's half-edge rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/modeler/matrix.mjs';
import * as M from '../src/modeler/mesh.mjs';
import {validateMesh, formatTopologyReport, TopologyError} from '../src/modeler/topology.mjs';
import {PRIMITIVES, cube, plane, uvSphere} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, readModel, evaluatePart} from '../src/modeler/model.mjs';
import {importObj} from '../src/modeler/obj-format.mjs';

const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, `${a} ≉ ${b}`);
const quiet = {print: false};
/** A 2×2 grid of quads around a centre vertex (4). */
function grid() {
  const verts = []; for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) verts.push([x - 1, y - 1, 0]);
  const q = (x, y) => ({v: [y * 3 + x, y * 3 + x + 1, (y + 1) * 3 + x + 1, (y + 1) * 3 + x], c: 0});
  return {verts, faces: [q(0, 0), q(1, 0), q(1, 1), q(0, 1)]};
}

test('matrix functions are pure: inputs untouched, results frozen', () => {
  const p = [1, 2, 3], axis = [0, 1, 0], pivot = [1, 0, 0], before = JSON.stringify([p, axis, pivot]);
  const m = X.compose(X.translation([1, 0, 0]), X.about(pivot, X.rotationAxis(axis, .7)), X.scaling([2, 2, 2]));
  const q = X.transformPoint(m, p);
  assert.equal(JSON.stringify([p, axis, pivot]), before);
  for (const value of [m, q, X.identity(), X.invert(m), X.decomposeTRS(X.fromTRS([1, 2, 3], [.1, .2, .3], [1, 2, 3]))]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { 'use strict'; m[0] = 5; }, TypeError);
  assert.deepEqual(X.transformPoint(m, p), q, 'same inputs, same result');
});

test('matrix algebra: inverse, about, decomposition and Euler round trips', () => {
  const trs = X.fromTRS([1, -2, 3], [.3, -.6, 1.2], [1.5, .5, -2]), back = X.compose(X.invert(trs), trs);
  back.forEach((v, i) => near(v, X.IDENTITY[i], 1e-12));
  const parts = X.decomposeTRS(trs), again = X.fromTRS(parts.position, parts.rotation, parts.scale);
  again.forEach((v, i) => near(v, trs[i], 1e-9));
  const pivot = [2, 0, 0]; X.transformPoint(X.about(pivot, X.rotationAxis([0, 0, 1], 1)), pivot).forEach((v, k) => near(v, pivot[k]));
  X.transformPoint(X.scalingAlong([1, 0, 0], 3), [1, 1, 1]).forEach((v, k) => near(v, [3, 1, 1][k]));
  assert.ok(X.determinant3(X.scaling([1, -1, 1])) < 0);
  assert.throws(() => X.invert(X.scaling([1, 0, 1])), /flattens space/);
  assert.throws(() => X.decomposeTRS(X.compose(X.scalingAlong([1, 1, 0], 2), X.eulerXYZ([0, 0, .4]))), /skews/);
  assert.throws(() => X.translation([1, NaN, 0]), /finite/);
});

test('transformMesh returns a new mesh and leaves the original and its topology alone', () => {
  const mesh = cube(), copy = JSON.stringify(mesh), moved = M.transformMesh(mesh, X.translation([0, 1, 0]), new Set([0, 1]));
  assert.equal(JSON.stringify(mesh), copy);
  assert.notEqual(moved.verts, mesh.verts); assert.notEqual(moved.faces, mesh.faces);
  assert.deepEqual(moved.faces, mesh.faces);
  near(moved.verts[0][1], mesh.verts[0][1] + 1); assert.deepEqual(moved.verts[5], mesh.verts[5]);
  const part = {position: [1, 2, 3], rotation: [.2, .4, .6], scale: [2, 1, -1]};
  M.objectInverse(part)(M.objectTransform(part)([.3, .2, .1])).forEach((v, k) => near(v, [.3, .2, .1][k]));
  assert.equal(M.objectMirrors(part), true);
});

test('validateMesh accepts every primitive and notes open borders', () => {
  for (const [name, make] of Object.entries(PRIMITIVES)) assert.ok(validateMesh(make(), quiet).ok, name);
  const sheet = validateMesh(plane(), quiet); assert.ok(sheet.ok); assert.equal(sheet.warnings[0].rule, 'border');
});

test('validateMesh reports each broken rule with details, and prints them', () => {
  const c = cube(), cases = {
    H1: {verts: [...c.verts, [0, NaN, 0]], faces: [...c.faces, {v: [0, 1, 8], c: 0}]},
    H2: {verts: c.verts, faces: [...c.faces, {v: [0, 1, 42], c: 0}]},
    H3: {verts: c.verts, faces: [...c.faces, {v: [0, 0, 1], c: 0}]},
    H4: {verts: c.verts, faces: c.faces.map((f, i) => i ? f : {v: f.v.slice().reverse(), c: 0})},
    H5: {verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]], faces: [{v: [0, 1, 2], c: 0}, {v: [1, 0, 3], c: 0}, {v: [1, 0, 4], c: 0}]},
    H6: (() => { const g = grid(); g.faces = [g.faces[0], g.faces[2]]; return g; })(),
    H7: {verts: [...c.verts, [5, 5, 5]], faces: c.faces},
    H8: {verts: c.verts, faces: [...c.faces, {v: c.faces[0].v.slice().reverse(), c: 0}]},
    H9: {verts: c.verts, faces: c.faces.map((f, i) => ({...f, c: i ? 0 : 3.5}))},
  };
  for (const [rule, mesh] of Object.entries(cases)) {
    const printed = [], result = validateMesh(mesh, {label: rule, log: text => printed.push(text)});
    assert.ok(!result.ok, rule);
    assert.ok(result.errors.some(e => e.rule === rule), `${rule}: ${result.errors.map(e => e.rule)}`);
    assert.equal(printed.length, 1, `${rule} prints its report`);
    assert.match(printed[0], new RegExp(`${rule} `)); assert.match(printed[0], /Topology check of/);
  }
  const report = formatTopologyReport(validateMesh(cases.H2, quiet), 'demo');
  assert.match(report, /Face 6 points at vertex 42, but the mesh has vertices 0–7/);
  assert.ok(!validateMesh(null, quiet).ok);
  const printed = []; validateMesh(cube(), {log: text => printed.push(text)}); assert.equal(printed.length, 0, 'valid meshes print nothing');
});

test('an edit that would break the mesh is undone and reported', () => {
  const printed = [], log = console.error; console.error = text => printed.push(text);
  try {
    // Extruding an edge between two faces would give it a third (H5).
    const c = cube(), before = JSON.stringify(c), [a, b] = c.faces[0].v;
    assert.throws(() => M.extrudeEdges(c, [[a, b]]), error => error instanceof TopologyError && error.result.errors.some(e => e.rule === 'H5'));
    assert.equal(JSON.stringify(c), before, 'mesh restored exactly');
    // A bow-tie in the data itself is still refused (H6)…
    const g = grid(), gridBefore = JSON.stringify(g);
    assert.throws(() => M.fillVerts(g, new Set([0, 1, 4, 3])), TopologyError);
    assert.equal(JSON.stringify(g), gridBefore);
    // Filling across a face that already exists duplicates it (H8 / H4).
    const f = cube(), fBefore = JSON.stringify(f);
    assert.throws(() => M.fillVerts(f, new Set(f.faces[0].v)), TopologyError);
    assert.equal(JSON.stringify(f), fBefore);
    assert.ok(printed.length >= 3 && printed.every(text => /Topology check of/.test(text)), 'each refusal printed its report');
  } finally { console.error = log; }
});

test('edits Blender allows go through: region extrude, checker deletes, cutting a traced line', () => {
  // Extruding a 2×2 patch: the inner corner moves with it, nothing is left unused.
  let g = grid(); let moved = M.extrudeFaces(g, new Set([0, 1, 2, 3]));
  assert.ok(validateMesh(g, quiet).ok); assert.equal(g.verts.length, 9 + 8); assert.ok(moved.has(4), 'inner corner moves');
  // Extruding every face of a closed box just moves it.
  const box = cube(); M.extrudeFaces(box, new Set(box.faces.keys())); assert.ok(validateMesh(box, quiet).ok); assert.equal(box.verts.length, 8);
  // Faces that touch only at a corner extrude as two pieces with their own walls.
  g = grid(); moved = M.extrudeFaces(g, new Set([0, 2]));
  assert.ok(validateMesh(g, quiet).ok); assert.equal(moved.size, 8, 'the shared corner is copied once per piece');
  // Deleting opposite quads leaves the other two touching at the centre; each keeps its own corner.
  g = grid(); M.deleteFaces(g, new Set([1, 3]));
  assert.ok(validateMesh(g, quiet).ok); assert.equal(g.faces.length, 2); assert.equal(g.verts.length, 8);
  assert.equal(g.verts.filter(p => M.length(p) < 1e-9).length, 2, 'the centre is split into two corners in the same place');
  g = grid(); M.deleteVerts(g, new Set([1, 7])); assert.ok(validateMesh(g, quiet).ok);
  g = grid(); const copy = M.duplicateFaces(g, new Set([0, 2])); assert.ok(validateMesh(g, quiet).ok); assert.equal(copy.size, 8);
  // Loop cut on a traced line cuts the line into pieces.
  const line = {verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1]]};
  M.loopCut(line, [0, 1], .5, 3); assert.ok(validateMesh(line, quiet).ok); assert.equal(line.edges.length, 4);
});

test('symmetrize works in world space for a part placed off the middle', () => {
  const part = {position: [.4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]};
  const mesh = M.transformMesh(cube(), X.translation([.3, 0, 0]));
  M.symmetrize(mesh, 'auto', M.objectMatrix(part));
  assert.ok(validateMesh(mesh, quiet).ok);
  const world = mesh.verts.map(p => p[0] + .4), min = Math.min(...world), max = Math.max(...world);
  near(min, -max, 1e-6);
  assert.equal(M.symmetrizeSide({verts: [[1, 0, 0], [2, 0, 0], [-1, 0, 0]], faces: []}), true);
});

test('random edit sequences never leave an invalid mesh behind', () => {
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const log = console.error; console.error = () => {};
  try {
    for (const make of [cube, () => uvSphere(.5, 8, 4), () => PRIMITIVES.cylinder(), () => PRIMITIVES.point()]) {
      const mesh = make();
      for (let step = 0; step < 90; step++) {
        const faces = new Set(mesh.faces.map((_, i) => i).filter(() => random() < .15));
        const verts = new Set([...mesh.verts.keys()].filter(() => random() < .1));
        const edge = M.meshEdges(mesh)[Math.floor(random() * M.meshEdges(mesh).length)];
        const ops = [() => M.extrudeFaces(mesh, faces), () => M.insetFaces(mesh, faces, .3), () => M.subdivideFaces(mesh, faces), () => edge && M.loopCut(mesh, edge),
          () => M.mergeVerts(mesh, verts), () => M.deleteFaces(mesh, faces), () => M.fillVerts(mesh, verts), () => M.flipFaces(mesh, faces), () => M.duplicateFaces(mesh, faces), () => M.mergeByDistance(mesh, .05),
          // Tracing edits: points, lines, bridges, deletes of traced points, symmetrize.
          () => { const made = M.extrudePoints(mesh, verts); for (const v of made) mesh.verts[v] = mesh.verts[v].map(x => x + random() * .3 - .15); },
          () => M.addPoint(mesh, [random(), random(), random()], verts.size ? [...verts][0] : null), () => M.fillVerts(mesh, new Set([...verts].slice(0, 2)), 0, {facing: [0, 0, 1]}),
          () => M.bridge(mesh, verts, {facing: [0, 0, 1]}), () => M.deleteVerts(mesh, verts), () => M.duplicatePoints(mesh, verts), () => M.symmetrize(mesh, true),
          () => { const uses = M.edgeFaces(mesh); M.extrudeEdges(mesh, M.edgesFromVerts(mesh, verts).filter(([a, b]) => (uses.get(M.edgeKey(a, b))?.length ?? 0) <= 1)); }];
        try { ops[Math.floor(random() * ops.length)](); } catch (error) { if (!(error instanceof TopologyError || error?.modelerMessage)) throw error; }
        const result = validateMesh(mesh, quiet);
        assert.ok(result.ok, `step ${step}: ${formatTopologyReport(result)}`);
        if (!mesh.verts.length || mesh.verts.length > 4000) break;
      }
    }
  } finally { console.error = log; }
});

test('imports, stored models and evaluated parts are checked too', () => {
  const log = console.error; console.error = () => {};
  try {
    // Inconsistent winding is fixed on import; a non-manifold edge is refused with its report.
    const flipped = importObj('o Box\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 5 6 7 8\nf 2 1 4 3\nf 1 5 8 4\nf 6 2 3 7\nf 8 7 3 4\nf 5 1 2 6\n'.replace('f 5 6 7 8', 'f 8 7 6 5'));
    assert.ok(validateMesh(flipped[0].mesh, quiet).ok);
    assert.throws(() => importObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 -1 0\nv 0 0 1\nf 1 2 3\nf 2 1 4\nf 2 1 5\n'), error => error instanceof TopologyError && /Importing part/.test(error.message));
    const model = emptyModel(); addPart(model, {name: 'Box', mesh: cube()});
    model.parts[0].mesh.faces.push({v: [0, 1, 99], c: 0});
    assert.throws(() => readModel(model), error => error instanceof TopologyError && error.result.errors.some(e => e.rule === 'H2'));
    const part = {mesh: M.transformMesh(cube(), X.translation([.5, 0, 0])), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, -1, 1], mirror: true, smooth: 1};
    assert.ok(validateMesh(evaluatePart(part), quiet).ok, 'mirror + negative scale + smooth stays valid');
  } finally { console.error = log; }
});
