import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {partWeights} from '../src/modeler/armature.mjs';
import {axisAngle, rotate, poseFrames, posedBy, posedMesh, turnBone, isPosed, IDENTITY} from '../src/modeler/pose.mjs';

const near = (a, b, e = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < e);

test('rotations turn points the right way', () => {
  assert.ok(near(rotate(axisAngle([0, 1, 0], Math.PI / 2), [0, 0, 1]), [1, 0, 0]));
  assert.ok(near(rotate(axisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0]));
  assert.ok(near(rotate(IDENTITY, [1, 2, 3]), [1, 2, 3]));
});

test('a turned bone carries the bones below it about its own start', async () => {
  const model = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  const upper = model.bones.find(b => b.name === 'UpperArm.L'), lower = model.bones.find(b => b.name === 'LowerArm.L'), hand = model.bones.find(b => b.name === 'Hand.L');
  let pose = new Map();
  assert.equal(isPosed(pose), false);
  // Swing the upper arm a quarter turn about the view axis (Z).
  pose = turnBone(model, pose, upper.id, axisAngle([0, 0, 1], Math.PI / 2));
  assert.equal(isPosed(pose), true);
  const frames = poseFrames(model, pose);
  assert.ok(near(frames.get(upper.id).at, upper.head), 'its start stays put');
  const arm = [0, 1, 2].map(k => upper.tail[k] - upper.head[k]), swung = rotate(axisAngle([0, 0, 1], Math.PI / 2), arm);
  assert.ok(near(posedBy(frames, upper.id, upper.tail), upper.head.map((v, k) => v + swung[k]), 1e-9), 'its end swings round');
  assert.ok(near(frames.get(lower.id).at, posedBy(frames, upper.id, lower.head), 1e-9), 'the forearm rides along');
  // Turning the forearm afterwards turns it about its own (moved) start, in the scene's frame.
  pose = turnBone(model, pose, lower.id, axisAngle([0, 0, 1], Math.PI / 2));
  const after = poseFrames(model, pose);
  const fore = [0, 1, 2].map(k => lower.tail[k] - lower.head[k]), twice = rotate(axisAngle([0, 0, 1], Math.PI), fore);
  assert.ok(near(posedBy(after, lower.id, lower.tail), after.get(lower.id).at.map((v, k) => v + twice[k]), 1e-9));
  assert.ok(near(after.get(hand.id).at, posedBy(after, lower.id, hand.head), 1e-9));
  // The rest skeleton is untouched: a pose is a preview.
  assert.deepEqual(upper.head, model.bones.find(b => b.name === 'UpperArm.L').head);
});

test('the model bends with the pose by its weights', async () => {
  const model = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  const arm = model.parts.find(p => p.name === 'Arm'), upper = model.bones.find(b => b.name === 'UpperArm.L');
  const mesh = evaluatePart(arm), skin = partWeights(model, mesh, arm);
  const pose = turnBone(model, new Map(), upper.id, axisAngle([0, 0, 1], -Math.PI / 4));
  const bent = posedMesh(mesh, skin, poseFrames(model, pose));
  assert.equal(bent.faces, mesh.faces, 'faces are shared, only points move');
  const moved = mesh.verts.map((p, v) => Math.hypot(...[0, 1, 2].map(k => bent.verts[v][k] - p[k])));
  const left = mesh.verts.map((p, v) => p[0] > .05 ? moved[v] : 0), right = mesh.verts.map((p, v) => p[0] < -.05 ? moved[v] : 0);
  assert.ok(Math.max(...left) > .1, 'the left arm swings');
  assert.ok(Math.max(...right) < 1e-9, 'the right arm stays');
});

test('rigging an imported OBJ: each limb follows its own bones, not the other side', async () => {
  const {exportObj, importObj} = await import('../src/modeler/obj-format.mjs');
  const {emptyModel, addPart, evaluateModel} = await import('../src/modeler/model.mjs');
  const {humanoidSkeleton} = await import('../src/modeler/armature.mjs');
  const {baseCharacter} = await import('../src/modeler/primitives.mjs');
  const src = emptyModel(); for (const p of baseCharacter()) addPart(src, p);
  const {obj, mtl} = exportObj(src);
  const model = emptyModel(); for (const p of importObj(obj, {mtl, palette: model.palette})) addPart(model, {name: p.name, mesh: p.mesh});
  humanoidSkeleton(model, evaluateModel(model, {smooth: false}).map(x => x.mesh));
  const pull = boneName => {
    const bone = model.bones.find(b => b.name === boneName), out = {left: 0, right: 0, parts: new Set()};
    for (const p of model.parts) {
      const mesh = evaluatePart(p), w = partWeights(model, mesh, p);
      mesh.verts.forEach((v, i) => { let s = 0; for (let k = 0; k < 4; k++) if (w.bones[i * 4 + k] === bone.id) s += w.weights[i * 4 + k]; if (s > .05) out.parts.add(p.name); if (v[0] > 0) out.left += s; else out.right += s; });
    }
    return out;
  };
  for (const [name, side] of [['Shin.L', 'left'], ['Shin.R', 'right'], ['Thigh.L', 'left'], ['Thigh.R', 'right']]) {
    const got = pull(name), other = side === 'left' ? 'right' : 'left';
    assert.ok(got[side] > 1, `${name} moves its own side`);
    assert.ok(got[other] < .05 * got[side], `${name} leaves the other side alone`);
  }
  // The hands hang near the thighs but must not follow the legs.
  for (const name of ['Shin.L', 'Shin.R', 'Thigh.L', 'Thigh.R']) assert.ok(![...pull(name).parts].some(n => /hand|arm/i.test(n)), `${name} does not move a hand or arm`);
});

test('loose bones move only painted points; old models with Automatic weights off open with loose bones', async () => {
  const {holdingBone, boneState, setBoneState} = await import('../src/modeler/armature.mjs');
  const model = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  assert.ok(model.bones.every(b => boneState(b) === 'grouped'), 'bones stored before layers are grouped');
  for (const b of model.bones) setBoneState(b, 'loose');
  const arm = model.parts.find(p => p.name === 'Arm'), mesh = evaluatePart(arm), hold = holdingBone(model, arm);
  assert.ok(model.bones.some(b => b.id === hold));
  const skin = partWeights(model, mesh, arm);
  // Juniper has no painted weights, so every point stays with the part's holding bone.
  assert.equal(Object.keys(arm.mesh.vdata?.skin ?? {}).length, 0);
  for (let v = 0; v < mesh.verts.length; v++) assert.equal(skin.bones[v * 4], hold);
  // States are saved; anything else is dropped. Automatic weights off becomes loose bones.
  assert.ok(readModel(JSON.parse(JSON.stringify(model))).bones.every(b => b.state === 'loose'));
  const old = JSON.parse(JSON.stringify((await import('../src/modeler/examples/juniper.mjs')).default));
  old.autoWeights = false; old.bones[0].state = 'nonsense';
  const opened = readModel(old);
  assert.equal('autoWeights' in opened, false);
  assert.ok(opened.bones.every(b => b.state === 'loose'));
  assert.equal(readModel({...JSON.parse(JSON.stringify(model)), bones: model.bones.map(b => ({...b, state: 'x'}))}).bones.every(b => !('state' in b)), true);
});
