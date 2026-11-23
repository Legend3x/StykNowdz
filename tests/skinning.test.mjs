// One skinning for the stage and 3D Nowdz's Pose preview (src/skinning.mjs): the preview bends a
// model exactly as the animation will, with Preserve Volume (dual quaternion) or without (linear).
import test from 'node:test';
import assert from 'node:assert/strict';
import {skinPoint, rigidDual, moveRigid, SKINNING_METHODS, DEFAULT_SKINNING} from '../src/skinning.mjs';
import {quatMultiply} from '../src/rig-spatial.mjs';
import {validateSpatialMesh} from '../src/spatial-mesh.mjs';
import {readModel} from '../src/modeler/model.mjs';
import {skinningMethod} from '../src/modeler/armature.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';
import {poseFrames, posedPoint, axisAngle} from '../src/modeler/pose.mjs';
import {stageOf, evaluateOnStage, stageVertices, toFigure, sub} from './support/stage-pose.mjs';

const example = async name => (await import(`../src/modeler/examples/${name}.mjs`)).default;
const close = (a, b, e = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= e);
const motion = (q, t) => ({q, t, dual: rigidDual(q, t)});

test('the two methods, and the default', () => {
  assert.deepEqual(SKINNING_METHODS, ['dual-quaternion', 'linear']);
  assert.equal(DEFAULT_SKINNING, 'dual-quaternion');
});

test('one bone moves a point rigidly; no bones leave it where it is', () => {
  const f = motion(axisAngle([0, 0, 1], Math.PI / 2), [1, 2, 3]);
  for (const method of SKINNING_METHODS) {
    assert.ok(close(skinPoint([f], [1], [1, 0, 0], method), [1, 3, 3]));
    assert.ok(close(skinPoint([f], [.3], [1, 0, 0], method), [1, 3, 3]), 'a single weight below 1 still moves the point all the way');
    assert.deepEqual(skinPoint([], [], [4, 5, 6], method), [4, 5, 6]);
  }
});

test('weights are divided by their total, as Blender does', () => {
  const a = motion([0, 0, 0, 1], [0, 0, 0]), b = motion(axisAngle([1, 0, 0], 1.2), [0, .5, 0]), p = [.3, 1, .2];
  for (const method of SKINNING_METHODS) {
    assert.ok(close(skinPoint([a, b], [.3, .3], p, method), skinPoint([a, b], [.5, .5], p, method)), method);
    assert.ok(close(skinPoint([a, b], [.6, .2], p, method), skinPoint([a, b], [.75, .25], p, method)), method);
  }
});

test('Preserve Volume keeps a twisted joint\'s thickness; linear pinches it', () => {
  // A point 1 from the X axis, halfway between a bone at rest and one twisted half a turn about X.
  const rest = motion([0, 0, 0, 1], [0, 0, 0]), twisted = motion(axisAngle([1, 0, 0], Math.PI * .9), [0, 0, 0]), p = [0, 1, 0];
  const dq = skinPoint([rest, twisted], [.5, .5], p, 'dual-quaternion'), lin = skinPoint([rest, twisted], [.5, .5], p, 'linear');
  assert.ok(Math.abs(Math.hypot(dq[1], dq[2]) - 1) < 1e-9, 'dual quaternion: still 1 from the axis');
  assert.ok(Math.hypot(lin[1], lin[2]) < .2, `linear: pinched to ${Math.hypot(lin[1], lin[2]).toFixed(3)} (the candy wrapper)`);
});

test('dual parts match the stage\'s own formula bit for bit', () => {
  let seed = 31; const r = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32 - .5) * 20;
  for (let i = 0; i < 2000; i++) {
    const q = [r(), r(), r(), r()], l = Math.hypot(...q), u = q.map(v => v / l), t = [r(), r(), r()];
    assert.deepEqual(rigidDual(u, t), quatMultiply([...t, 0], u).map(n => n * .5));
  }
  assert.ok(close(moveRigid(motion([0, 0, 0, 1], [1, 2, 3]), [1, 1, 1]), [2, 3, 4]));
});

/** The largest distance (stage pixels, figure space) between the Pose preview and the stage. */
async function gap(name, preserveVolume) {
  const source = readModel(await example(name));
  if (!preserveVolume) source.preserveVolume = false;
  const stage = stageOf(source), model = stage.model, bone = n => model.bones.find(b => b.name === n)?.id;
  const turns = [['UpperArm.L', [0, 0, 1], .9], ['LowerArm.L', [1, 0, 0], 1.4], ['LowerArm.R', [0, 1, 0], -1.2], ['Thigh.R', [1, 0, 0], -.8], ['Shin.L', [1, 0, 0], 1.1], ['Spine', [0, 1, 0], .5], ['Head', [1, 0, 0], .4]];
  const pose = new Map(turns.filter(([n]) => bone(n)).map(([n, a, t]) => [bone(n), axisAngle(a, t)]));
  if (!pose.size) model.bones.forEach((b, i) => pose.set(b.id, axisAngle([1, i % 2, 0], .3 + i * .1)));
  const onStage = evaluateOnStage(stage, pose).positions, {points, skin} = stageVertices(stage), frames = poseFrames(model, pose), method = skinningMethod(model);
  assert.equal(stage.mesh.skinning, preserveVolume ? undefined : 'linear', 'the stage mesh says how to blend');
  let worst = 0, multi = 0;
  points.forEach((p, v) => {
    const P = toFigure(sub(posedPoint(frames, skin, v, p, method), stage.origin));
    worst = Math.max(worst, Math.hypot(P[0] - onStage[v * 2], P[1] - onStage[v * 2 + 1]));
    if (skin.weights[v * 4 + 1] > 0) multi++;
  });
  assert.ok(multi > 100, `${name} has points between bones (${multi})`);
  return worst;
}

for (const name of ['juniper', 'kettle']) for (const preserveVolume of [true, false]) {
  test(`the Pose preview bends ${name} exactly as the stage does (Preserve Volume ${preserveVolume ? 'on' : 'off'})`, async () => {
    // Stage positions are single precision: 0.001 stage pixels is 0.00001 model units.
    const worst = await gap(name, preserveVolume);
    assert.ok(worst < 1e-3, `largest gap ${worst} stage pixels`);
  });
}

test('the two methods really differ on the stage at a bent joint', async () => {
  const on = stageOf(readModel(await example('juniper'))), offSource = readModel(await example('juniper'));
  offSource.preserveVolume = false;
  // Juniper's arms are rigid pieces; its spine blends into the hips.
  const off = stageOf(offSource), spine = on.model.bones.find(b => b.name === 'Spine').id, pose = new Map([[spine, axisAngle([1, 0, 0], 1.5)]]);
  const a = evaluateOnStage(on, pose).positions, b = evaluateOnStage(off, pose).positions;
  let most = 0; for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs(a[i] - b[i]));
  assert.ok(most > 1, `a bent waist moves differently (${most} stage pixels)`);
});

test('Preserve Volume is stored with the model only when off, and reaches the stage mesh', async () => {
  const model = readModel(await example('juniper'));
  assert.equal(model.preserveVolume, undefined);
  assert.equal(skinningMethod(model), 'dual-quaternion');
  assert.equal(modelToFigure(model).figure._styk.spatialMesh.skinning, undefined, 'figures made before keep the same mesh');
  const off = readModel({...model, preserveVolume: false});
  assert.equal(off.preserveVolume, false);
  assert.equal(skinningMethod(off), 'linear');
  assert.equal(modelToFigure(off).figure._styk.spatialMesh.skinning, 'linear');
  assert.equal(readModel({...model, preserveVolume: true}).preserveVolume, undefined, 'the default is not stored');
  assert.equal(readModel({...model, preserveVolume: 'no'}).preserveVolume, undefined);
});

test('a stage mesh may say linear, and nothing else', async () => {
  const {figure} = modelToFigure(readModel(await example('kettle')));
  validateSpatialMesh(figure);
  figure._styk.spatialMesh.skinning = 'linear';
  validateSpatialMesh(figure);
  for (const bad of ['dual-quaternion', 'Linear', 1, null]) {
    figure._styk.spatialMesh.skinning = bad;
    assert.throws(() => validateSpatialMesh(figure));
  }
});

test('the preview\'s dual quaternion with one bone is exactly that bone\'s motion', async () => {
  const model = readModel(await example('juniper')), upper = model.bones.find(b => b.name === 'UpperArm.L');
  const frames = poseFrames(model, new Map([[upper.id, axisAngle([0, 0, 1], .7)]])), skin = {bones: [upper.id, 0, 0, 0], weights: [1, 0, 0, 0]};
  const f = frames.get(upper.id), p = upper.tail, r = sub(p, f.head), turned = skinPoint([motion(f.turn, [0, 0, 0])], [1], r);
  assert.ok(close(posedPoint(frames, skin, 0, p), turned.map((v, i) => v + f.at[i]), 1e-12));
});
