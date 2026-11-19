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

test('a part with points on both sides of the middle is cut there, keeps its +X side, and stays a valid mesh', async () => {
  const {uvSphere, cylinder, torus} = await import('../src/modeler/primitives.mjs');
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  // A whole head (or any whole shape with points on the middle) used to mirror into a second,
  // inside-out copy whose faces met the original's the same way round: "half-edge used twice".
  for (const [name, mesh] of [['sphere', uvSphere()], ['cylinder', cylinder()], ['torus', torus()]]) {
    const model = emptyModel(), p = addPart(model, {name, mesh}); p.mirror = true;
    const applied = appliedMirror(model, p), check = validateMesh(applied, {print: false});
    assert.ok(check.ok, `${name}: ${check.errors[0]?.message}`);
    assert.equal(validateMesh(evaluatePart(p, {smooth: false}), {print: false}).ok, true, `${name} shows a valid mesh too`);
  }
  // A shape crossing the middle with no point on it: the crossing faces are clipped at x = 0, and
  // the -X side is replaced by the copy of the +X side (a closed box made of ten quads).
  const model = emptyModel(), box = M.cloneMesh(cube(1));
  box.verts.forEach(v => { if (v[0] < 0) v[0] = -.2; });
  const p = addPart(model, {name: 'Box', mesh: box}); p.mirror = true;
  const applied = appliedMirror(model, p);
  assert.ok(validateMesh(applied, {print: false}).ok);
  assert.equal(applied.faces.length, 10);
  assert.deepEqual([...new Set(applied.verts.map(v => Math.abs(+v[0].toFixed(6))))].sort(), [0, .5], 'the -X side is the +X side mirrored');
  // A half on one side only mirrors as before.
  const half = M.cloneMesh(cube(1)); half.verts.forEach(v => { v[0] += 1; });
  const q = addPart(model, {name: 'Half', mesh: half}); q.mirror = true;
  assert.equal(appliedMirror(model, q).faces.length, 12);
});

test('a saved part whose mesh breaks the rules is repaired on open instead of refusing the whole file', async () => {
  const {uvSphere} = await import('../src/modeler/primitives.mjs');
  const {readModel} = await import('../src/modeler/model.mjs');
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  // What older versions saved after applying a mirror to a whole head.
  const model = emptyModel(), head = addPart(model, {name: 'face', mesh: uvSphere()});
  const fine = uvSphere();
  head.mesh = {verts: [...fine.verts.map(v => v.slice()), ...fine.verts.map(([x, y, z]) => [-x, y, z])], faces: [...fine.faces.map(f => ({...f, v: f.v.slice()})), ...fine.faces.map(f => ({...f, v: f.v.map(i => fine.verts[i][0] ? i + fine.verts.length : i).reverse()}))]};
  assert.equal(validateMesh(head.mesh, {print: false}).ok, false, 'the stored mesh is broken');
  addPart(model, {name: 'body', mesh: cube(1)});
  const repaired = [], opened = readModel(JSON.parse(JSON.stringify(model)), {repaired});
  assert.deepEqual(repaired, ['face']);
  assert.equal(opened.parts.length, 2);
  for (const part of opened.parts) assert.ok(validateMesh(part.mesh, {print: false}).ok, part.name);
});
