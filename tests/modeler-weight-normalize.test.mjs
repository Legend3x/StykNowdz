// Weight paint options as in Blender (weight-paint.mjs, weight-manager.mjs): locked groups, Auto
// Normalize off, Multi-Paint, Normalize All (with Lock Active), Lock-Relative, and Hand off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {groupWeights, completeSkin} from '../src/modeler/armature.mjs';
import {startStroke, paintPoint, groupWeightIn, MULTI_PAINT_MIN, handOffOn} from '../src/modeler/weight-paint.mjs';
import {setStoredWeights, storedWeights, normalizeStoredWeights} from '../src/modeler/weight-manager.mjs';
import {setGroupLock, addGroup, autoNormalizeOn} from '../src/modeler/vertex-groups.mjs';
import {mergeBone} from '../src/modeler/layers.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const sum = pairs => pairs.reduce((t, [, w]) => t + w, 0);
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;
const weight = (pairs, id) => pairs?.find(([b]) => b === id)?.[1] ?? 0;

/** Juniper with the torso's first points weighted to Chest 0.5, Spine 0.3, Hips 0.2. */
async function torso() {
  const model = await juniper(), part = named(model, 'parts', 'Torso'), [chest, spine, hips] = ['Chest', 'Spine', 'Hips'].map(n => named(model, 'bones', n).id);
  for (let v = 0; v < 6; v++) setStoredWeights(part.mesh, v, [[chest, .5], [spine, .3], [hips, .2]]);
  return {model, part, chest, spine, hips};
}

test('a locked bone can\'t be painted, and painting others leaves its weights exactly as they were', async () => {
  const {model, part, chest, spine, hips} = await torso();
  setGroupLock(model, spine, true);
  let stroke = startStroke(model, part, spine);
  assert.equal(paintPoint(stroke, 0, 'add', 1), false, 'painting the locked bone itself is refused');
  assert.deepEqual(storedWeights(part.mesh, 0), [[chest, .5], [spine, .3], [hips, .2]]);
  for (const mode of ['add', 'remove', 'set', 'smooth']) {
    stroke = startStroke(model, part, chest);
    paintPoint(stroke, 1, mode, .7, {value: .1});
    const after = storedWeights(part.mesh, 1);
    assert.equal(weight(after, spine), .3, `${mode}: the locked Spine keeps 0.3`);
    assert.ok(near(sum(after), 1), `${mode}: still adds up to 1`);
  }
  // Add to Chest can only take what Hips has: Spine's 0.3 is out of reach.
  stroke = startStroke(model, part, chest);
  paintPoint(stroke, 2, 'add', 1);
  assert.deepEqual(storedWeights(part.mesh, 2), [[chest, .7], [spine, .3]]);
});

test('Merged bones and locked groups are both kept while painting', async () => {
  const {model, part, chest, spine, hips} = await torso();
  setGroupLock(model, spine, true);
  mergeBone(model, hips);
  // The only bones that could take Chest's weight there are Spine (locked) and Hips (merged):
  // painting Chest down changes nothing, whatever Hand off says.
  for (const handOff of [true, false]) {
    model.weightPaint = handOff ? undefined : {handOff: false};
    const before = storedWeights(part.mesh, 0).map(p => p.slice());
    assert.equal(paintPoint(startStroke(model, part, chest), 0, 'remove', 1), false);
    assert.deepEqual(storedWeights(part.mesh, 0), before);
  }
  assert.deepEqual(storedWeights(part.mesh, 0), [[chest, .5], [spine, .3], [hips, .2]]);
});

test('Auto Normalize off: only the painted bone changes, from 0 to 1, and the rest stay', async () => {
  const {model, part, chest, spine, hips} = await torso();
  model.weightPaint = {autoNormalize: false};
  assert.equal(autoNormalizeOn(model), false);
  let stroke = startStroke(model, part, spine);
  paintPoint(stroke, 0, 'add', .5);
  assert.deepEqual(storedWeights(part.mesh, 0), [[spine, .65], [chest, .5], [hips, .2]], 'Spine 0.3 halfway to 1; no rescaling');
  paintPoint(stroke, 1, 'set', 1, {value: .9});
  assert.equal(weight(storedWeights(part.mesh, 1), spine), .9);
  assert.equal(weight(storedWeights(part.mesh, 1), chest), .5);
  paintPoint(stroke, 2, 'remove', 1);
  assert.deepEqual(storedWeights(part.mesh, 2), [[chest, .5], [hips, .2]], 'removed all the way, the others untouched');
  // Un-normalized weights reach painting as they are (not read as shares of 1).
  setStoredWeights(part.mesh, 3, [[chest, .2], [spine, .2]]);
  stroke = startStroke(model, part, chest);
  assert.deepEqual(completeSkin(model, part)[3], [[chest, .2], [spine, .2]]);
  // And saving keeps the option and the weights.
  const back = readModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(back.weightPaint, {autoNormalize: false});
  assert.deepEqual(named(back, 'parts', 'Torso').mesh.vdata.skin[0], [[spine, .65], [chest, .5], [hips, .2]]);
});

test('Hand off: on, a bone alone on a point gives it away when painted down; off, it keeps it (as Blender)', async () => {
  const model = await juniper(), part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id;
  setStoredWeights(part.mesh, 0, [[chest, 1]]);
  assert.equal(handOffOn(model), true);
  assert.equal(paintPoint(startStroke(model, part, chest), 0, 'remove', .5), true);
  assert.ok(weight(storedWeights(part.mesh, 0), chest) < 1, 'on: other bones took half');
  setStoredWeights(part.mesh, 0, [[chest, 1]]);
  model.weightPaint = {handOff: false};
  assert.equal(handOffOn(model), false);
  assert.equal(paintPoint(startStroke(model, part, chest), 0, 'remove', .5), false, 'off: nothing can take it, so it stays at 1');
  assert.deepEqual(storedWeights(part.mesh, 0), [[chest, 1]]);
  assert.deepEqual(readModel(JSON.parse(JSON.stringify(model))).weightPaint, {handOff: false});
});

test('Multi-Paint with Auto Normalize: the bones change together in proportion, and others share the rest', async () => {
  const {model, part, chest, spine, hips} = await torso();
  const stroke = startStroke(model, part, [chest, spine]);
  assert.equal(groupWeightIn(stroke.skin[0], [chest, spine]), .8, 'shown as their sum');
  paintPoint(stroke, 0, 'add', .5, {bone: [chest, spine]});
  let after = storedWeights(part.mesh, 0);
  assert.ok(near(weight(after, chest) + weight(after, spine), .9), 'their sum went halfway from 0.8 to 1');
  assert.ok(near(weight(after, chest) / weight(after, spine), .5 / .3), 'in the same proportion');
  assert.ok(near(sum(after), 1));
  // Never all the way to zero; a point where they have nothing can't be painted.
  paintPoint(stroke, 1, 'remove', 1, {bone: [chest, spine]});
  after = storedWeights(part.mesh, 1);
  assert.ok(near(weight(after, chest) + weight(after, spine), MULTI_PAINT_MIN, 2e-5), 'down to the least Multi-Paint leaves');
  setStoredWeights(part.mesh, 2, [[hips, 1]]);
  assert.equal(paintPoint(startStroke(model, part, [chest, spine]), 2, 'add', 1, {bone: [chest, spine]}), false);
  // A locked bone in the group: refused.
  setGroupLock(model, spine, true);
  assert.equal(paintPoint(startStroke(model, part, [chest, spine]), 3, 'add', 1, {bone: [chest, spine]}), false);
});

test('Multi-Paint without Auto Normalize: their average, in proportion, the others untouched', async () => {
  const {model, part, chest, spine, hips} = await torso();
  model.weightPaint = {autoNormalize: false};
  const stroke = startStroke(model, part, [chest, spine]);
  assert.equal(groupWeightIn(stroke.skin[0], [chest, spine], true), .4, 'shown as their average');
  paintPoint(stroke, 0, 'set', 1, {bone: [chest, spine], value: .2});
  const after = storedWeights(part.mesh, 0);
  assert.ok(near((weight(after, chest) + weight(after, spine)) / 2, .2));
  assert.ok(near(weight(after, chest) / weight(after, spine), .5 / .3));
  assert.equal(weight(after, hips), .2, 'Hips untouched');
  // No bone of the group goes past 1.
  paintPoint(stroke, 1, 'set', 1, {bone: [chest, spine], value: 1});
  assert.ok(near(weight(storedWeights(part.mesh, 1), chest), 1));
});

test('Normalize All: unlocked bones scaled so each point adds up to 1; Lock Active keeps the painted bone too', () => {
  const deform = new Set([1, 2, 3]), mesh = {verts: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], faces: []};
  setStoredWeights(mesh, 0, [[1, .5], [2, .3], [3, .4], [9, .7]]);
  setStoredWeights(mesh, 1, [[1, .25], [2, .25]]);
  setStoredWeights(mesh, 2, [[3, .6], [1, .6]]);
  setStoredWeights(mesh, 3, [[3, 1]]);
  assert.equal(normalizeStoredWeights(mesh, {deform, locked: new Set([3])}), 3);
  const p0 = storedWeights(mesh, 0);
  assert.equal(weight(p0, 3), .4, 'locked bone 3 kept');
  assert.equal(weight(p0, 9), .7, 'a group that moves nothing is left alone');
  assert.ok(near(weight(p0, 1), .375, 1e-12) && near(weight(p0, 2), .225, 1e-12), 'bones 1 and 2 share the 0.6 left, in proportion');
  assert.deepEqual(storedWeights(mesh, 1), [[1, .5], [2, .5]]);
  assert.deepEqual(storedWeights(mesh, 2), [[3, .6], [1, .4]]);
  assert.deepEqual(storedWeights(mesh, 3), [[3, 1]], 'nothing unlocked to scale');
  // Lock Active: bone 1 kept as well.
  setStoredWeights(mesh, 1, [[1, .25], [2, .25], [3, .25]]);
  normalizeStoredWeights(mesh, {deform, locked: new Set([1])});
  assert.ok(near(weight(storedWeights(mesh, 1), 1), .25, 1e-12) && near(weight(storedWeights(mesh, 1), 2), .375, 1e-12));
  // Locked bones already reaching 1: the others go to nothing.
  setStoredWeights(mesh, 2, [[3, 1.0], [1, .3]]);
  normalizeStoredWeights(mesh, {deform, locked: new Set([3])});
  assert.deepEqual(storedWeights(mesh, 2), [[3, 1]]);
  assert.equal(normalizeStoredWeights(mesh, {deform, locked: new Set([3])}), 0, 'a second run changes nothing');
});

test('Lock-Relative colours: weights as if locked bones were gone; Multi-Paint shows the sum or average', async () => {
  const {model, part, chest, spine, hips} = await torso();
  // Every torso point the same, so smoothing doesn't blend in automatic weights.
  for (let v = 0; v < part.mesh.verts.length; v++) setStoredWeights(part.mesh, v, [[chest, .5], [spine, .3], [hips, .2]]);
  const mesh = evaluatePart(part), at = (group, options) => groupWeights(model, mesh, part, group, options)[0];
  assert.ok(near(at(spine), .3, 1e-9));
  assert.ok(near(at(spine, {relative: new Set([chest])}), .6, 1e-9), 'Spine 0.3 of the 0.5 left without Chest');
  assert.ok(near(at(chest, {relative: new Set([chest])}), .5, 1e-9), 'a locked bone shows as it is');
  assert.ok(near(at([spine, hips]), .5, 1e-9));
  assert.ok(near(at([spine, hips], {average: true}), .25, 1e-9));
  assert.ok(near(at([spine, hips], {relative: new Set([chest])}), 1, 1e-9));
});

test('locks belong to vertex groups and survive saving; groups without a bone are never touched', async () => {
  const {model, part, chest, spine} = await torso(), mask = addGroup(model, 'Mask');
  setStoredWeights(part.mesh, 0, [[chest, .5], [spine, .5], [mask.id, .3]]);
  setGroupLock(model, chest, true);
  const back = readModel(JSON.parse(JSON.stringify(model)));
  assert.equal(back.groups.find(g => g.id === chest).lock, true);
  paintPoint(startStroke(model, part, spine), 0, 'remove', .5);
  assert.equal(weight(storedWeights(part.mesh, 0), mask.id), .3);
  assert.equal(weight(storedWeights(part.mesh, 0), chest), .5);
});
