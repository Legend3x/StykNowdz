import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {partWeights, completeSkin, addBone, deleteBones} from '../src/modeler/armature.mjs';
import {startStroke, paintPoint} from '../src/modeler/weight-paint.mjs';
import {exportGlb, importGltf} from '../src/modeler/gltf-format.mjs';
import {skeletonFile, readSkeletonFile, applySkeleton} from '../src/modeler/skeleton-file.mjs';
import {cleanWeights, setStoredWeights, storedWeights, storedCount, clearStoredWeights, remapStoredWeights, readStoredWeights, limitTotal, normalizedWeights, DEFORM_LIMIT} from '../src/modeler/weight-manager.mjs';
import {readGroups, syncGroups, vertexGroups, groupOf, groupName, deformsGroup, isGroupLocked, setGroupLock, addGroup, autoNormalizeOn} from '../src/modeler/vertex-groups.mjs';
import {modelFromGltf} from './support/weight-golden.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const roundTrip = model => readModel(JSON.parse(JSON.stringify(model)));
const sum = pairs => pairs.reduce((t, [, w]) => t + w, 0);

test('Weight Manager: lists are cleaned but never trimmed or rescaled', () => {
  // A group named twice counts once; nothing above 1, nothing at or below 0, unknown groups out.
  assert.deepEqual(cleanWeights([[1, .25], [2, .5], [1, .25], [3, 0], [4, -1], [5, NaN], [6, 3], 'x', [9, .1]], id => id !== 9), [[1, .5], [2, .5], [6, 1]]);
  const seven = [[1, .3], [2, .2], [3, .1], [4, .1], [5, .05], [6, .05], [7, .02]];
  assert.deepEqual(cleanWeights(seven), seven, 'seven groups adding up to 0.82 stay exactly as given');
  // limitTotal is the only place the four-bone limit happens.
  assert.equal(DEFORM_LIMIT, 4);
  const top = limitTotal(seven);
  assert.deepEqual(top.map(([id]) => id), [1, 2, 3, 4]);
  assert.ok(Math.abs(sum(top) - 1) < 1e-12);
  assert.equal(limitTotal([]), null);
  assert.deepEqual(normalizedWeights([[1, .2], [2, .2]]), [[1, .5], [2, .5]]);
  // Only points that exist are read from a file.
  assert.deepEqual(readStoredWeights({0: seven, 3: [[1, .5]], 9: [[1, 1]], x: [[1, 1]], 1: 'bad'}, 4, () => true), {0: seven, 3: [[1, .5]]});
});

test('Weight Manager: storing, clearing and relabelling a mesh\'s weights', () => {
  const mesh = {verts: [[0, 0, 0], [1, 0, 0]], faces: []};
  setStoredWeights(mesh, 0, [[1, .6], [2, .6]]);
  assert.deepEqual(storedWeights(mesh, 0), [[1, .6], [2, .6]], 'kept as given, even adding up to 1.2');
  assert.equal(storedWeights(mesh, 1), null);
  setStoredWeights(mesh, 1, [[3, 0]]);
  assert.equal(storedCount(mesh), 1, 'an empty list leaves the point automatic');
  remapStoredWeights(mesh, id => (id === 1 ? 10 : id), {normalize: new Set([10, 2])});
  assert.deepEqual(storedWeights(mesh, 0), [[10, .5], [2, .5]]);
  remapStoredWeights(mesh, () => undefined);
  assert.equal(storedCount(mesh), 0);
  assert.equal(mesh.vdata, undefined, 'no empty containers left behind');
  setStoredWeights(mesh, 0, [[1, 1]]);
  assert.equal(clearStoredWeights(mesh), 1);
  assert.equal(mesh.vdata, undefined);
});

test('every bone has a vertex group with its own id; groups without a bone and locks are kept', async () => {
  const model = await juniper();
  assert.deepEqual(model.groups.map(g => g.id), model.bones.map(b => b.id), 'opening a model gives each bone its group');
  assert.ok(model.groups.every(g => g.bone === g.id));
  const hand = named(model, 'bones', 'Hand.L');
  assert.equal(groupName(model, groupOf(model, hand.id)), 'Hand.L');
  assert.ok(deformsGroup(model, hand.id));
  // Locks and a group with no bone are part of the model and survive saving.
  assert.equal(isGroupLocked(model, hand.id), false);
  setGroupLock(model, hand.id, true);
  const mask = addGroup(model, 'Mask');
  assert.ok(!model.bones.some(b => b.id === mask.id), 'a group without a bone never shares a bone\'s id');
  assert.equal(deformsGroup(model, mask.id), false);
  const back = roundTrip(model);
  assert.equal(isGroupLocked(back, hand.id), true);
  assert.deepEqual(groupOf(back, mask.id), {id: mask.id, name: 'Mask'});
  assert.ok(back.nextId > mask.id);
  // A new bone gets a group; a deleted bone's group goes with it.
  const made = addBone(back, {name: 'Tail', head: [0, 1, -.2], tail: [0, .8, -.4], parent: named(back, 'bones', 'Hips').id});
  assert.ok(groupOf(back, made.id));
  deleteBones(back, new Set([hand.id]));
  assert.equal(groupOf(back, hand.id), null);
  assert.ok(groupOf(back, mask.id), 'groups without a bone stay');
});

test('readGroups drops broken entries', () => {
  const groups = readGroups([{id: 2, bone: 2, lock: true}, {id: 3, bone: 4}, {id: 5, name: 'Mask', lock: 'yes'}, {id: 2, name: 'Twin'}, {id: 1, name: 'Bone id'}, {id: -1, name: 'Bad'}, null, {id: 6}], new Set([1, 2]));
  assert.deepEqual(groups, [{id: 1, bone: 1}, {id: 2, bone: 2, lock: true}, {id: 5, name: 'Mask'}]);
  const model = {bones: [{id: 7}], groups: [{id: 2, bone: 2}]};
  syncGroups(model);
  assert.deepEqual(vertexGroups(model), [{id: 7, bone: 7}]);
});

test('Auto Normalize is stored with the model and on by default', async () => {
  const model = await juniper();
  assert.equal(model.weightPaint, undefined);
  assert.equal(autoNormalizeOn(model), true);
  model.weightPaint = {autoNormalize: false, junk: 1};
  const back = roundTrip(model);
  assert.deepEqual(back.weightPaint, {autoNormalize: false});
  assert.equal(autoNormalizeOn(back), false);
  assert.equal(roundTrip({...back, weightPaint: {autoNormalize: true}}).weightPaint, undefined, 'the default is not stored');
});

/** Juniper with one torso point weighted to 8 groups (7 bones and a group with no bone), adding up to 0.9. */
async function eightGroups() {
  const model = await juniper(), torso = named(model, 'parts', 'Torso');
  const bones = ['Chest', 'Spine', 'Shoulder.L', 'Shoulder.R', 'Neck', 'Hips', 'UpperArm.L'].map(n => named(model, 'bones', n).id), mask = addGroup(model, 'Mask');
  const pairs = [[bones[0], .3], [bones[1], .2], [bones[2], .12], [bones[3], .08], [bones[4], .06], [bones[5], .04], [bones[6], .02], [mask.id, .08]];
  setStoredWeights(torso.mesh, 0, pairs);
  return {model, torso, bones, mask, pairs};
}

test('a point with 8 groups and un-normalized weights survives saving and opening exactly', async () => {
  const {model, pairs} = await eightGroups();
  const back = roundTrip(model);
  assert.deepEqual(named(back, 'parts', 'Torso').mesh.vdata.skin[0], pairs);
  // And again: nothing drifts.
  assert.deepEqual(named(roundTrip(back), 'parts', 'Torso').mesh.vdata.skin[0], pairs);
});

test('deformation and glTF export use the strongest four bones, scaled to add up to 1', async () => {
  const {model, torso, bones} = await eightGroups();
  // The weights the Pose preview, the stage and the colours get for the stored point itself.
  const cage = partWeights(model, evaluatePart(torso, {smooth: false}), {...torso, smooth: 0}, {cage: true});
  const ids = [0, 1, 2, 3].map(k => cage.bones[k]), ws = [0, 1, 2, 3].map(k => cage.weights[k]);
  assert.deepEqual(ids, bones.slice(0, 4), 'the four strongest bones; the group with no bone moves nothing');
  assert.ok(Math.abs(ws.reduce((t, w) => t + w, 0) - 1) < 1e-9);
  assert.ok(Math.abs(ws[0] - .3 / .7) < 1e-9);
  // The smoothed part (what the stage gets): every point at most four bones adding up to 1.
  const shaped = evaluatePart(torso), skin = partWeights(model, shaped, torso);
  for (let v = 0; v < shaped.verts.length; v++) assert.ok(Math.abs([0, 1, 2, 3].reduce((t, k) => t + skin.weights[v * 4 + k], 0) - 1) < 1e-6);
  // glTF export: four joints per point, adding up to 1.
  const back = modelFromGltf(exportGlb(model));
  for (const part of back.parts) for (const list of Object.values(part.mesh.vdata?.skin ?? {})) {
    assert.ok(list.length <= 4);
    assert.ok(Math.abs(sum(list) - 1) < 1e-5);
  }
});

test('painting keeps every bone a point has, and leaves groups without a bone alone', async () => {
  const {model, torso, bones, mask} = await eightGroups();
  const stroke = startStroke(model, torso, bones[6]);
  assert.equal(stroke.skin[0].length, 8, 'the stroke sees all 8 groups (Auto Normalize shares the bones out to 1)');
  assert.ok(Math.abs(sum(stroke.skin[0].filter(([g]) => g !== mask.id)) - 1) < 1e-9);
  assert.ok(paintPoint(stroke, 0, 'add', .5));
  const after = torso.mesh.vdata.skin[0];
  assert.equal(after.length, 8, 'no bone was dropped');
  assert.deepEqual(after.find(([g]) => g === mask.id), [mask.id, .08], 'the mask group is unchanged');
  const deform = after.filter(([g]) => g !== mask.id), painted = deform.find(([g]) => g === bones[6])[1];
  assert.ok(painted > .45, `UpperArm.L went up (${painted})`);
  assert.ok(Math.abs(sum(deform) - 1) < 1e-4, 'the bones still add up to 1');
  // The smallest bone (Hips, 0.04 of 0.9) is still there: before, it would have been cut to make room.
  assert.ok(deform.some(([g]) => g === bones[5]));
});

test('applying a skeleton keeps groups without a bone and shares a removed bone\'s weight out', async () => {
  const {model, torso, bones, mask} = await eightGroups();
  const file = skeletonFile(model);
  file.bones = file.bones.filter(b => b.name !== 'Chest');
  applySkeleton(model, readSkeletonFile(file));
  const left = torso.mesh.vdata.skin[0];
  assert.ok(!left.some(([g]) => g === bones[0]), 'Chest is gone');
  assert.deepEqual(left.find(([g]) => g === mask.id), [mask.id, .08]);
  assert.ok(Math.abs(sum(left.filter(([g]) => g !== mask.id)) - 1) < 1e-9);
  assert.equal(groupOf(model, bones[0]), null);
  assert.ok(groupOf(model, mask.id));
});

test('completeSkin: a point storing only a group without a bone keeps its automatic bones', async () => {
  const model = await juniper(), torso = named(model, 'parts', 'Torso'), mask = addGroup(model, 'Mask');
  const auto = completeSkin(model, torso)[5];
  setStoredWeights(torso.mesh, 5, [[mask.id, .5]]);
  assert.deepEqual(completeSkin(model, torso)[5], [...auto, [mask.id, .5]]);
});

/** A box (centred, so not half a model) on a chain of six bones, every point weighted to all six
 * across two sets of joints (JOINTS_0/WEIGHTS_0 and JOINTS_1/WEIGHTS_1). */
function sixBoneGltf() {
  const positions = [], indices = [], j0 = [], w0 = [], j1 = [], w1 = [];
  for (const y of [0, 1]) for (const z of [-.1, .1]) for (const x of [-.1, .1]) { positions.push(x, y, z); j0.push(0, 1, 2, 3); w0.push(.3, .2, .15, .15); j1.push(4, 5, 0, 0); w1.push(.1, .1, 0, 0); }
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  // Each bone 0.2 above the last; inverse bind matrices undo that, so the rest pose is the box itself.
  const ibm = Array.from({length: 6}, (_, k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -.2 * k, 0, 1]).flat();
  const arrays = [new Float32Array(positions), new Uint16Array(indices), new Uint16Array(j0), new Float32Array(w0), new Uint16Array(j1), new Float32Array(w1), new Float32Array(ibm)];
  const views = [], bytes = []; let offset = 0;
  for (const p of arrays) { const b = new Uint8Array(p.buffer); views.push({buffer: 0, byteOffset: offset, byteLength: b.length}); bytes.push(...b); while (bytes.length % 4) bytes.push(0); offset = bytes.length; }
  return {
    asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0, 1]}],
    nodes: [{name: 'Body', mesh: 0, skin: 0}, {name: 'b0', children: [2]}, {name: 'b1', translation: [0, .2, 0], children: [3]}, {name: 'b2', translation: [0, .2, 0], children: [4]}, {name: 'b3', translation: [0, .2, 0], children: [5]}, {name: 'b4', translation: [0, .2, 0], children: [6]}, {name: 'b5', translation: [0, .2, 0]}],
    meshes: [{primitives: [{attributes: {POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3, JOINTS_1: 4, WEIGHTS_1: 5}, indices: 1}]}],
    skins: [{joints: [1, 2, 3, 4, 5, 6], inverseBindMatrices: 6}],
    accessors: [{bufferView: 0, componentType: 5126, count: 8, type: 'VEC3'}, {bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR'},
      {bufferView: 2, componentType: 5123, count: 8, type: 'VEC4'}, {bufferView: 3, componentType: 5126, count: 8, type: 'VEC4'},
      {bufferView: 4, componentType: 5123, count: 8, type: 'VEC4'}, {bufferView: 5, componentType: 5126, count: 8, type: 'VEC4'},
      {bufferView: 6, componentType: 5126, count: 6, type: 'MAT4'}],
    bufferViews: views, buffers: [{byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes))}],
  };
}

test('glTF import keeps every bone from every set of joints', () => {
  const result = importGltf(sixBoneGltf());
  assert.equal(result.bones.length, 6);
  const skin = result.parts[0].mesh.vdata.skin;
  for (const list of Object.values(skin)) assert.equal(list.length, 6);
  const model = modelFromGltf(sixBoneGltf()), part = model.parts[0];
  for (const list of Object.values(part.mesh.vdata.skin)) {
    assert.equal(list.length, 6, 'all six bones are stored');
    assert.ok(Math.abs(sum(list) - 1) < 1e-6);
  }
  // The rest pose is the box as drawn (every joint's bind undone), and posing uses the strongest four.
  assert.ok(part.mesh.verts.every(p => p.every(Number.isFinite)));
  const cage = partWeights(model, evaluatePart(part, {smooth: false}), part, {cage: true});
  assert.ok(Math.abs([0, 1, 2, 3].reduce((t, k) => t + cage.weights[k], 0) - 1) < 1e-9);
});
