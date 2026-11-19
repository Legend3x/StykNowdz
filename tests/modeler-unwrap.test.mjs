import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {cube, PRIMITIVES} from '../src/modeler/primitives.mjs';
import {cubeProject, smartProject, projectFromView, resetUVs, packIslands, cornersAt, linkedCorners, transformCorners, cornerCentre} from '../src/modeler/unwrap.mjs';

const all = mesh => new Set(mesh.faces.map((_, i) => i));
const uvArea = f => { let s = 0; f.uv.forEach((p, i) => { const q = f.uv[(i + 1) % f.uv.length]; s += p[0] * q[1] - q[0] * p[1]; }); return Math.abs(s) / 2; };
const box = f => { const xs = f.uv.map(p => p[0]), ys = f.uv.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const overlap = (a, b) => a[0] < b[2] - 1e-9 && b[0] < a[2] - 1e-9 && a[1] < b[3] - 1e-9 && b[1] < a[3] - 1e-9;
function inSquare(mesh) { for (const f of mesh.faces) for (const p of f.uv ?? []) assert.ok(p.every(x => x >= -1e-9 && x <= 1 + 1e-9), `UV ${p} lies outside the square`); }

test('Cube and Smart UV Project lay a cube out as six islands, apart and evenly sized', () => {
  for (const method of [cubeProject, smartProject]) {
    const mesh = M.cloneMesh(cube(2)); method(mesh, all(mesh)); inSquare(mesh);
    const boxes = mesh.faces.map(box);
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${method.name}: islands ${i} and ${j} overlap`);
    const areas = mesh.faces.map(uvArea); assert.ok(Math.max(...areas) - Math.min(...areas) < 1e-9, 'equal faces get equal room');
    assert.ok(areas[0] > .08, `${method.name} uses the square well (${areas[0]})`);
    assert.notEqual(mesh.faces[0].uv[0], mesh.faces[1].uv[1], 'each face has its own UV arrays');
  }
});

test('Smart UV Project keeps smooth curves in one island and splits at sharp corners', () => {
  const mesh = M.cloneMesh(PRIMITIVES.cylinder({sides: 16})); const sides = new Set(mesh.faces.map((f, i) => f.v.length === 4 ? i : -1).filter(i => i >= 0));
  smartProject(mesh, sides, {angle: 66}); inSquare(mesh);
  // Sixteen sides turn 22.5° each: neighbours within 66° of an island's first face join it.
  const islands = new Set([...sides].map(fi => [...linkedCorners(mesh, sides, [`${fi}:0`])].sort().join()));
  assert.ok(islands.size >= 3 && islands.size <= 6, `${islands.size} islands`);
  const flat = M.cloneMesh(cube(2)); M.subdivideFaces(flat, all(flat)); smartProject(flat, all(flat));
  const front = new Set(flat.faces.map((f, i) => M.faceNormal(flat, f)[2] > .9 ? i : -1).filter(i => i >= 0));
  assert.equal(linkedCorners(flat, all(flat), [`${[...front][0]}:0`]).size, 16, 'the four front quarters are one island');
});

test('Project from View fits the faces as seen, keeping their shape', () => {
  const mesh = M.cloneMesh(cube(2)), front = mesh.faces.findIndex(f => M.faceNormal(mesh, f)[2] > .9);
  projectFromView(mesh, new Set([front]), p => [p[0] * 100 + 300, -p[1] * 50 + 200]);
  const [x0, y0, x1, y1] = box(mesh.faces[front]); inSquare(mesh);
  assert.ok(Math.abs((x1 - x0) / (y1 - y0) - 2) < 1e-9, 'twice as wide on screen, twice as wide in UV');
  const pairs = mesh.faces[front].uv.map((p, k) => [p[1], mesh.verts[mesh.faces[front].v[k]][1]]);
  const low = Math.max(...pairs.filter(([, y]) => y < 0).map(([v]) => v)), high = Math.min(...pairs.filter(([, y]) => y > 0).map(([v]) => v));
  assert.ok(high > low, 'up on screen is up in UV');
});

test('Reset fills the square per face; packing scales islands together', () => {
  const mesh = M.cloneMesh(cube(2)); resetUVs(mesh, all(mesh));
  assert.deepEqual(mesh.faces[0].uv, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const big = [[0, 0], [2, 0], [2, 2], [0, 2]], small = [[5, 5], [6, 5], [6, 6], [5, 6]];
  packIslands([big, small], 0);
  const side = c => c[1][0] - c[0][0]; assert.ok(Math.abs(side(big) / side(small) - 2) < 1e-9, 'sizes keep their ratio');
});

test('UV editor moves: pick shared corners, linked islands, move, scale and rotate', () => {
  const mesh = M.cloneMesh(cube(2)); smartProject(mesh, all(mesh));
  const f = mesh.faces[0], hit = cornersAt(mesh, all(mesh), f.uv[0]);
  assert.ok(hit.includes('0:0'));
  const island = linkedCorners(mesh, all(mesh), hit); assert.equal(island.size, 4, 'a cube side is its own island');
  const start = new Map([...island].map(id => { const [fi, k] = id.split(':').map(Number); return [id, mesh.faces[fi].uv[k].slice()]; }));
  const c = cornerCentre(mesh, island);
  transformCorners(mesh, start, {move: [.1, 0]}); assert.ok(Math.abs(cornerCentre(mesh, island)[0] - c[0] - .1) < 1e-9);
  transformCorners(mesh, start, {scale: [2, 2], pivot: c}); assert.ok(Math.abs(uvArea(f) - 4 * uvArea({uv: [...start.values()]})) < 1e-9);
  transformCorners(mesh, start, {angle: Math.PI / 2, pivot: c});
  const [a, b] = [f.uv[0], start.get('0:0')]; assert.ok(Math.abs((a[0] - c[0]) + (b[1] - c[1])) < 1e-9 && Math.abs((a[1] - c[1]) - (b[0] - c[0])) < 1e-9);
});

import {unwrapParts} from '../src/modeler/unwrap.mjs';
test('several parts unwrap into one shared square, sized by their world size', () => {
  const a = M.cloneMesh(cube(2)), b = M.cloneMesh(cube(2));
  // b stands in for a part scaled 2× in the scene: its points are given in world space.
  unwrapParts('smart', [{mesh: a, faces: all(a)}, {mesh: b, faces: all(b), points: b.verts.map(p => p.map(x => x * 2))}]);
  const boxes = [...a.faces, ...b.faces].map(box);
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) assert.ok(!overlap(boxes[i], boxes[j]), `islands ${i} and ${j} overlap`);
  assert.ok(Math.abs(uvArea(b.faces[0]) / uvArea(a.faces[0]) - 4) < 1e-6, 'twice the size, four times the room');
  for (const m of [a, b]) for (const f of m.faces) for (const p of f.uv) assert.ok(p.every(x => x >= 0 && x <= 1));
});

import {createBlankDocument} from '../src/startup-document.mjs';
import {prepareEditorLoad} from '../src/editor-load.mjs';
test('Paint texture opens on an empty one-frame project the size of the texture', () => {
  const doc = createBlankDocument({canvas: {width: 512, height: 256}}); prepareEditorLoad(doc);
  assert.deepEqual([doc.canvas_width, doc.canvas_height, doc.keyframes.length, doc.figure_types.length], [512, 256, 1, 0]);
  assert.equal(doc._styk.layerSheet.duration, 1);
  assert.throws(() => createBlankDocument({canvas: {width: 0, height: 4}}), RangeError);
});

test('Unwrap lays each connected selection flat in one piece, upright, keeping its shape', async () => {
  const {uvSphere} = await import('../src/modeler/primitives.mjs');
  const sphere = uvSphere(), faces = new Set(sphere.faces.flatMap((f, i) => f.v.every(v => sphere.verts[v][2] > .1) ? [i] : []));
  unwrapParts('unwrap', [{mesh: sphere, faces}]);
  const at = new Map(); // one UV per point: the piece is never cut apart
  for (const fi of faces) sphere.faces[fi].v.forEach((v, k) => { const uv = sphere.faces[fi].uv[k].map(x => x.toFixed(9)).join(); assert.ok(!at.has(v) || at.get(v) === uv, 'a point has one place'); at.set(v, uv); });
  const signed = f => f.uv.reduce((a, p, i) => { const q = f.uv[(i + 1) % f.uv.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0);
  assert.ok([...faces].every(fi => signed(sphere.faces[fi]) > 0), 'no face turned over');
  const corners = [...faces].flatMap(fi => sphere.faces[fi].v.map((v, k) => [sphere.verts[v], sphere.faces[fi].uv[k]]));
  const top = corners.reduce((a, b) => (b[0][1] > a[0][1] ? b : a)), bottom = corners.reduce((a, b) => (b[0][1] < a[0][1] ? b : a));
  const right = corners.reduce((a, b) => (b[0][0] > a[0][0] ? b : a)), left = corners.reduce((a, b) => (b[0][0] < a[0][0] ? b : a));
  assert.ok(top[1][1] > bottom[1][1] + .5 && right[1][0] > left[1][0] + .5, 'up is up and the piece fills the square, unmirrored');
  for (const [, uv] of corners) assert.ok(uv.every(x => x >= 0 && x <= 1));
});

test('Unwrap on a Mirror part: the half meets its mirrored copy along u = 0.5, each with its own half of the texture', async () => {
  const {uvSphere} = await import('../src/modeler/primitives.mjs');
  const {mirrored} = await import('../src/modeler/mesh.mjs');
  for (const facing of [1, -1]) { // the front of a head lands right of the middle, the back left of it
    const s = uvSphere(), faces = new Set(s.faces.flatMap((f, i) => f.v.every(v => s.verts[v][2] * facing > .1 && s.verts[v][0] >= -1e-9) ? [i] : []));
    unwrapParts('unwrap', [{mesh: s, faces, mirror: true, mirrorU: true}]);
    const us = [...faces].flatMap(fi => s.faces[fi].uv.map(p => p[0]));
    const middle = [...faces].flatMap(fi => s.faces[fi].v.flatMap((v, k) => Math.abs(s.verts[v][0]) < 1e-9 ? [s.faces[fi].uv[k][0]] : []));
    assert.ok(middle.length && middle.every(u => Math.abs(u - .5) < 1e-9), 'the middle stands on u = 0.5');
    assert.ok(facing > 0 ? Math.min(...us) >= .5 - 1e-9 : Math.max(...us) <= .5 + 1e-9);
    // The mirrored copy reads the other half (Mirror U), so together they make one face without overlap.
    const whole = mirrored({verts: s.verts, faces: [...faces].map(fi => s.faces[fi])}, 1e-4, {mirrorU: true});
    const copies = whole.faces.slice(faces.size).flatMap(f => f.uv.map(p => p[0]));
    assert.ok(facing > 0 ? Math.max(...copies) <= .5 + 1e-9 : Math.min(...copies) >= .5 - 1e-9);
  }
});

test('Unwrap falls back to Smart UV Project for a closed piece, which cannot lie flat in one', async () => {
  const {uvSphere} = await import('../src/modeler/primitives.mjs');
  const s = uvSphere(), faces = new Set(s.faces.keys());
  unwrapParts('unwrap', [{mesh: s, faces}]);
  assert.ok(s.faces.every(f => f.uv?.every(p => p.every(x => x >= 0 && x <= 1))));
});
