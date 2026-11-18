import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';

/** Two open sheets in one part with a gap between them (as after Join): A on the left, B on the right. */
function twoSheets() {
  return {verts: [[-1, 0, 0], [0, 0, 0], [0, 1, 0], [-1, 1, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]],
    faces: [{v: [0, 1, 2, 3], c: 0}, {v: [4, 5, 6, 7], c: 0}]};
}
const near = (mesh, pos) => mesh.verts.findIndex(v => v.every((c, k) => Math.abs(c - pos[k]) < 1e-9));

test('points of two pieces merge one pair at a time, as in Blender: first they touch at a point, then they share an edge', () => {
  const mesh = twoSheets();
  // A's bottom-right corner onto B's bottom-left (At Last): the pieces now touch at one point.
  M.mergeVerts(mesh, new Set([1, 4]), [1, 0, 0]);
  let check = validateMesh(mesh, {print: false});
  assert.ok(check.ok, 'allowed'); assert.ok(check.warnings.some(w => w.rule === 'H6'), 'noted as a bow-tie');
  // A's top-right corner onto B's top-left: now they share an edge and are one surface.
  M.mergeVerts(mesh, new Set([near(mesh, [0, 1, 0]), near(mesh, [1, 1, 0])]), [1, 1, 0]);
  check = validateMesh(mesh, {print: false});
  assert.ok(check.ok); assert.ok(!check.warnings.some(w => w.rule === 'H6'), 'one surface, no bow-tie left');
  assert.equal(mesh.verts.length, 6);
});
