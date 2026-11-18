import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';

const front = p => ({x: p[0] * 100, y: -p[1] * 100});
const sheet = () => ({verts: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [{v: [0, 1, 2, 3], c: 0}]});

test('the knife cuts through points clicked inside a face, as in Blender', () => {
  const mesh = sheet();
  const cut = M.knife(mesh, [{edge: [3, 0], t: .5}, {face: 0, at: [.3, .7, 0]}, {face: 0, at: [.7, .3, 0]}, {edge: [1, 2], t: .5}], front);
  assert.ok(validateMesh(mesh, {print: false}).ok);
  assert.equal(mesh.faces.length, 2, 'split in two along the cut');
  assert.equal(mesh.verts.length, 8, 'two edge points and the two points inside');
  assert.equal(cut.size, 4);
  assert.ok(mesh.verts.some(v => Math.abs(v[0] - .3) < 1e-9 && Math.abs(v[1] - .7) < 1e-9), 'the clicked point is a corner now');
});

test('a point inside a face can be reached across other faces, and the line leaves it toward the next point', () => {
  const mesh = M.cloneMesh(cube(1)), z = .5, frontFace = mesh.faces.findIndex(f => f.v.every(v => Math.abs(mesh.verts[v][2] - z) < 1e-9));
  const edgeOf = (x, y) => { const ring = mesh.faces[frontFace].v; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], A = mesh.verts[a], B = mesh.verts[b]; if ((x === null ? Math.abs(A[1] - y) < 1e-9 && Math.abs(B[1] - y) < 1e-9 : Math.abs(A[0] - x) < 1e-9 && Math.abs(B[0] - x) < 1e-9)) return [a, b]; } };
  // From the left edge, through the middle of the front, out to the right edge (the line to it leaves the face there).
  M.knife(mesh, [{edge: edgeOf(-.5), t: .5}, {face: frontFace, at: [0, .2, z]}, {edge: edgeOf(.5), t: .5}], front);
  assert.ok(validateMesh(mesh, {print: false}).ok);
  assert.equal(mesh.faces.length, 7);
  assert.throws(() => M.knife(M.cloneMesh(cube(1)), [{face: frontFace, at: [0, 0, z]}, {edge: edgeOf(.5), t: .5}], front), /Start and end the cut on an edge/);
});

test('a notch, as in the tutorial: in from one edge to a point inside and back out to the same edge cuts a triangle', () => {
  const mesh = sheet();
  M.knife(mesh, [{edge: [1, 2], t: .3}, {face: 0, at: [.4, .5, 0]}, {edge: [1, 2], t: .7}], front);
  assert.ok(validateMesh(mesh, {print: false}).ok);
  assert.equal(mesh.faces.length, 2);
  assert.ok(mesh.faces.some(f => f.v.length === 3), 'a triangle pointing in from the edge');
  assert.equal(mesh.verts.length, 7);
});
