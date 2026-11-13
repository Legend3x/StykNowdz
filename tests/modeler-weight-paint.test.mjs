import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePart, readModel} from '../src/modeler/model.mjs';
import {partWeights} from '../src/modeler/armature.mjs';
import {objectTransform} from '../src/modeler/mesh.mjs';
import {startStroke, paintPoint, withWeight, clearPainted, paintedCount, mirrorBone} from '../src/modeler/weight-paint.mjs';

/** The Juniper example: a smoothed torso the shoulders pull on, mirrored legs. */
const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const near = (verts, p, r) => verts.map((q, i) => [i, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])]).filter(([, d]) => d <= r).map(([i]) => i);
const weightAt = (skin, v, bone) => { let w = 0; for (let k = 0; k < 4; k++) if (skin.bones[v * 4 + k] === bone) w += skin.weights[v * 4 + k]; return w; };
const sums = (skin, n) => Array.from({length: n}, (_, v) => [0, 1, 2, 3].reduce((t, k) => t + skin.weights[v * 4 + k], 0));
const nearest = (verts, p) => verts.reduce((best, q, i) => (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < Math.hypot(verts[best][0] - p[0], verts[best][1] - p[1], verts[best][2] - p[2]) ? i : best), 0);

test('a point keeps adding up to 1: taking weight from a bone gives it to the others', () => {
  assert.deepEqual(withWeight([[1, .5], [2, .5]], 1, 0), [[2, 1]]);
  assert.deepEqual(withWeight([[1, .5], [2, .3], [3, .2]], 1, .8), [[1, .8], [2, .12], [3, .08]]);
  // The bone had it all: the bones that would have it without it take over.
  assert.deepEqual(withWeight([[1, 1]], 1, .25, () => [[2, 1]]), [[2, .75], [1, .25]]);
  // Nothing else can take it: it stays.
  assert.deepEqual(withWeight([[1, 1]], 1, 0), [[1, 1]]);
});

test('painting a bone off the chest stops it pulling there; Back to automatic restores it', async () => {
  const model = await juniper(), torso = named(model, 'parts', 'Torso'), shoulder = named(model, 'bones', 'Shoulder.L');
  const shaped0 = evaluatePart(torso), before = partWeights(model, shaped0, torso);
  // The torso point the left shoulder pulls hardest.
  const stroke = startStroke(model, torso, shoulder.id);
  const v = Object.keys(stroke.skin).map(Number).sort((a, b) => (stroke.skin[b].find(([id]) => id === shoulder.id)?.[1] ?? 0) - (stroke.skin[a].find(([id]) => id === shoulder.id)?.[1] ?? 0))[0];
  assert.ok((stroke.skin[v].find(([id]) => id === shoulder.id)?.[1] ?? 0) > .2, 'the shoulder pulls this torso point to start with');
  for (let i = 0; i < 30; i++) paintPoint(stroke, v, 'remove', .5);
  const shaped = evaluatePart(torso), after = partWeights(model, shaped, torso);
  const at = nearest(shaped.verts, shaped0.verts[nearest(shaped0.verts, torso.mesh.verts[v])]);
  assert.ok(weightAt(after, at, shoulder.id) < .05, `the shoulder no longer pulls there (${weightAt(after, at, shoulder.id)})`);
  assert.ok(sums(after, shaped.verts.length).every(s => Math.abs(s - 1) < 1e-6), 'every point still adds up to 1');
  assert.equal(paintedCount(torso), 1);
  assert.ok(readModel(JSON.parse(JSON.stringify(model))).parts.find(p => p.name === 'Torso').mesh.vdata.skin, 'painted weights are saved');
  clearPainted(torso);
  assert.equal(paintedCount(torso), 0);
  const back = partWeights(model, evaluatePart(torso), torso);
  assert.deepEqual(back.weights.map(w => Math.round(w * 1e6)), before.weights.map(w => Math.round(w * 1e6)), 'automatic again, exactly as before');
});

test('with Smooth on, painting a bone off an area never leaves a stronger pull at its edge', async () => {
  const model = await juniper(), torso = named(model, 'parts', 'Torso'), shoulder = named(model, 'bones', 'Shoulder.L');
  const shaped0 = evaluatePart(torso), before = partWeights(model, shaped0, torso);
  const stroke = startStroke(model, torso, shoulder.id);
  const hot = Object.keys(stroke.skin).map(Number).filter(v => (stroke.skin[v].find(([id]) => id === shoulder.id)?.[1] ?? 0) > .1);
  const centre = torso.mesh.verts[hot[0]], region = near(torso.mesh.verts, centre, .08);
  for (const v of region) paintPoint(stroke, v, 'remove', .8);
  const shaped = evaluatePart(torso), after = partWeights(model, shaped, torso);
  assert.equal(shaped.verts.length, shaped0.verts.length);
  assert.ok(sums(after, shaped.verts.length).every(s => Math.abs(s - 1) < 1e-6), 'every smoothed point has weights');
  // Removing pull can only lower it, everywhere (no automatic spike at the seam).
  for (let v = 0; v < shaped.verts.length; v++) assert.ok(weightAt(after, v, shoulder.id) <= weightAt(before, v, shoulder.id) + .05, `point ${v}: ${weightAt(before, v, shoulder.id).toFixed(3)} → ${weightAt(after, v, shoulder.id).toFixed(3)}`);
});

test('Mirror: painting one side paints the other side\'s bone on the mirrored half', async () => {
  const model = await juniper(), thigh = named(model, 'parts', 'Thigh'), left = named(model, 'bones', 'Thigh.L'), right = named(model, 'bones', 'Thigh.R');
  assert.ok(thigh.mirror);
  assert.equal(mirrorBone(model, left.id), right.id);
  const stroke = startStroke(model, thigh, left.id);
  const v = Object.keys(stroke.skin).map(Number).find(i => thigh.mesh.verts[i][0] > .02 && (stroke.skin[i].find(([id]) => id === left.id)?.[1] ?? 0) > .5);
  for (let i = 0; i < 30; i++) paintPoint(stroke, v, 'remove', .5);
  const shaped = evaluatePart(thigh), skin = partWeights(model, shaped, thigh), p = objectTransform(thigh)(thigh.mesh.verts[v]);
  const here = nearest(shaped.verts, p), there = nearest(shaped.verts, [-p[0], p[1], p[2]]);
  assert.ok(weightAt(skin, here, left.id) < .05);
  assert.ok(weightAt(skin, there, right.id) < .05, 'the mirrored point lost Thigh.R the same way');
  assert.equal(weightAt(skin, there, left.id), 0, 'and never takes the left bone');
  assert.ok(sums(skin, shaped.verts.length).every(s => Math.abs(s - 1) < 1e-6));
});

test('smooth and set brushes', async () => {
  const model = await juniper(), torso = named(model, 'parts', 'Torso'), shoulder = named(model, 'bones', 'Shoulder.L');
  const stroke = startStroke(model, torso, shoulder.id), v = 5;
  paintPoint(stroke, v, 'set', 1, {value: .3});
  assert.ok(Math.abs((stroke.skin[v].find(([b]) => b === shoulder.id)?.[1] ?? 0) - .3) < 1e-3);
  const around = [...stroke.neighbours[v]], mean = around.reduce((t, u) => t + (stroke.skin[u]?.find(([b]) => b === shoulder.id)?.[1] ?? 0), 0) / around.length;
  paintPoint(stroke, v, 'smooth', 1);
  assert.ok(Math.abs((stroke.skin[v].find(([b]) => b === shoulder.id)?.[1] ?? 0) - mean) < 1e-3);
  assert.throws(() => paintPoint(stroke, v, 'blur', 1), /Unknown paint mode/);
});
