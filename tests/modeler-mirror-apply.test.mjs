import test from 'node:test';
import assert from 'node:assert/strict';
import {appliedMirror} from '../src/modeler/modeler-ui.mjs';
import {emptyModel, addPart, evaluatePart} from '../src/modeler/model.mjs';
import {addBone} from '../src/modeler/armature.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import * as M from '../src/modeler/mesh.mjs';

test('applying a mirror keeps both halves as real points, in the part’s own space, with the other side’s bones', () => {
  const model = emptyModel(), left = addBone(model, {name: 'Arm.L', head: [.5, 1, 0], tail: [1, 1, 0]}), right = addBone(model, {name: 'Arm.R', head: [-.5, 1, 0], tail: [-1, 1, 0]});
  const mesh = M.cloneMesh(cube(1)); mesh.vdata = {skin: Object.fromEntries(mesh.verts.map((_, i) => [i, [[left.id, 1]]]))};
  const p = addPart(model, {name: 'Arm', mesh}); p.position = [1.5, 1, 0]; p.scale = [2, 1, 1]; p.mirror = true;
  const shown = evaluatePart(p).verts.map(v => v.map(n => +n.toFixed(6)).join()).sort();
  const applied = appliedMirror(model, p); p.mesh = applied; p.mirror = false;
  assert.equal(applied.verts.length, 16); assert.equal(applied.faces.length, 12);
  assert.deepEqual(evaluatePart(p).verts.map(v => v.map(n => +n.toFixed(6)).join()).sort(), shown, 'looks exactly as it did mirrored');
  const bones = new Set(Object.values(applied.vdata.skin).flatMap(pairs => pairs.map(([b]) => b)));
  assert.deepEqual([...bones].sort(), [left.id, right.id].sort(), 'the copy follows Arm.R, by its real id');
});
