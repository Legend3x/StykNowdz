import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {emptyModel, addPart, readModel, evaluatePart} from '../src/modeler/model.mjs';
import {baseCharacter} from '../src/modeler/primitives.mjs';
import {baseCharacterSkeleton, partWeights, boneState, completeSkin} from '../src/modeler/armature.mjs';
import {modelToFigure, modelDocument, originShift} from '../src/modeler/export-figure.mjs';
import {spatialQuaternion, quatRotate} from '../src/rig-spatial.mjs';
import {animationRotation} from '../src/animation-origin.mjs';
import {startStroke, paintPoint} from '../src/modeler/weight-paint.mjs';
import * as M from '../src/modeler/mesh.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {addFolder, moveToFolder, partsIn, nestFolder, ungroupFolder, deleteFolder, dropEmptyFolders, mergeBone, unmergeBone, groupBone, looseBone,
  connections, setOrigin, originOf, tracedLines, otherEnd} from '../src/modeler/layers.mjs';

function characterModel() { const model = emptyModel(); model.name = 'Hero'; for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model); return model; }
const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const weightAt = (skin, v, bone) => { let w = 0; for (let k = 0; k < 4; k++) if (skin.bones[v * 4 + k] === bone) w += skin.weights[v * 4 + k]; return w; };

test('folders hold parts, nest, ungroup and delete, and are saved', () => {
  const model = characterModel(), skin = addFolder(model, {name: 'Skin'}), head = addFolder(model, {name: 'Head', parent: skin.id});
  moveToFolder(model, model.parts.slice(0, 3).map(p => p.id), skin.id);
  moveToFolder(model, [model.parts[0].id], head.id);
  assert.equal(partsIn(model, skin.id).length, 3);
  assert.equal(partsIn(model, head.id).length, 1);
  assert.equal(nestFolder(model, skin.id, head.id), false, 'a folder never goes inside itself');
  const again = readModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(again.folders.map(f => f.name), ['Skin', 'Head']);
  assert.equal(again.parts[0].folder, head.id);
  ungroupFolder(model, head.id);
  assert.equal(model.parts[0].folder, skin.id, 'its parts move up a level');
  const gone = deleteFolder(model, skin.id);
  assert.equal(gone.length, 3); assert.equal(model.folders, undefined);
  // A folder left empty disappears; a broken folder reference is dropped on opening.
  const m2 = characterModel(), f = addFolder(m2, {name: 'Empty'});
  dropEmptyFolders(m2); assert.equal(m2.folders, undefined);
  m2.parts[0].folder = f.id; assert.equal(readModel(JSON.parse(JSON.stringify(m2))).parts[0].folder, undefined);
});

test('a loose bone moves only what is painted for it; grouping it lets it take its share', async () => {
  const model = await juniper(), upper = model.bones.find(b => b.name === 'UpperArm.L'), arm = model.parts.find(p => p.name === 'Arm');
  const share = () => { const mesh = evaluatePart(arm), skin = partWeights(model, mesh, arm); return mesh.verts.reduce((t, _, v) => t + weightAt(skin, v, upper.id), 0); };
  const grouped = share(); assert.ok(grouped > 1);
  looseBone(model, upper.id); assert.equal(boneState(upper), 'loose');
  assert.equal(share(), 0, 'loose: nothing moves with it');
  // Paint one point for it: that point, and only it, follows.
  const stroke = startStroke(model, arm, upper.id), v = 0;
  paintPoint(stroke, v, 'add', 1);
  const mesh = evaluatePart(arm, {smooth: false}), skin = partWeights(model, mesh, arm, {cage: true});
  assert.ok(weightAt(skin, v, upper.id) > .99);
  assert.equal(mesh.verts.reduce((n, _, u) => n + (u !== v && weightAt(skin, u, upper.id) > 0 ? 1 : 0), 0), 0, 'no other point, on either side');
  groupBone(model, upper.id); assert.equal(boneState(upper), 'grouped');
  assert.ok(share() > 1);
  // With every other bone loose, a grouped bone still takes only its own region, not the whole model.
  for (const b of model.bones) if (b !== upper) looseBone(model, b.id);
  assert.ok(Math.abs(share() - grouped) < 1e-6, 'the arm takes what it took with all bones grouped');
  const torso = model.parts.find(p => p.name === 'Torso'), tm = evaluatePart(torso), tw = partWeights(model, tm, torso);
  assert.equal(tm.verts.reduce((t, _, u) => t + weightAt(tw, u, upper.id), 0), 0, 'the torso stays with the figure');
});

test('merging freezes a bone\'s weights: other bones changing, or painting them, leaves its share alone', async () => {
  const model = await juniper(), shoulder = model.bones.find(b => b.name === 'Shoulder.L'), chest = model.bones.find(b => b.name === 'Chest');
  const torso = model.parts.find(p => p.name === 'Torso');
  // The part's own points' weights (a Mirror part's other half follows from them).
  const shares = () => { const full = completeSkin(model, torso); return torso.mesh.verts.map((_, v) => (full[v] ?? []).reduce((t, [b, w]) => t + (b === shoulder.id ? w : 0), 0)); };
  const before = shares();
  assert.ok(mergeBone(model, shoulder.id) > 0);
  assert.equal(boneState(shoulder), 'merged');
  assert.deepEqual(shares().map(w => Math.round(w * 1e4)), before.map(w => Math.round(w * 1e4)), 'merging changes nothing by itself');
  // A neighbour made weaker no longer shifts the shoulder's share.
  chest.strength = .2;
  assert.deepEqual(shares().map(w => Math.round(w * 1e4)), before.map(w => Math.round(w * 1e4)));
  // Painting the chest everywhere the shoulder pulls keeps the shoulder's share too.
  const v = before.findIndex(w => w > .2 && w < .9), stroke = startStroke(model, torso, chest.id);
  paintPoint(stroke, v, 'add', 1);
  assert.ok(Math.abs(shares()[v] - before[v]) < 1e-3);
  assert.ok(unmergeBone(model, shoulder.id)); assert.equal(boneState(shoulder), 'grouped');
  // Saved and reopened, the state stays.
  mergeBone(model, shoulder.id);
  assert.equal(boneState(readModel(JSON.parse(JSON.stringify(model))).bones.find(b => b.name === 'Shoulder.L')), 'merged');
});

test('dashed connections join the origin to unattached bones and bones across gaps', () => {
  const model = characterModel(), roots = model.bones.filter(b => !b.parent);
  let lines = connections(model);
  assert.equal(lines.filter(l => l.kind === 'origin').length, roots.length);
  assert.ok(lines.filter(l => l.kind === 'origin').every(l => l.from.every(v => v === 0)));
  setOrigin(model, [0, .9, 0]); assert.deepEqual(originOf(model), [0, .9, 0]);
  lines = connections(model);
  assert.ok(lines.filter(l => l.kind === 'origin').every(l => l.from[1] === .9));
  const child = model.bones.find(b => b.parent), parent = model.bones.find(b => b.id === child.parent);
  child.head = parent.tail.map((v, k) => v + (k === 0 ? .1 : 0));
  assert.ok(connections(model).some(l => l.kind === 'gap' && l.bone === child.id));
  setOrigin(model, [0, 0, 0]); assert.equal(model.origin, undefined);
});

test('moving the origin keeps a placed, turned figure where it was on the stage', () => {
  const model = characterModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  // Turn the whole figure in 3D and on the stage, and size it, so the shift has to follow all three.
  e.select(e.selectedUid, e.figure.segments.findIndex(s => s.name === 'Figure rotation'));
  const pose = e.getSpatialPose(); e.setSpatialPose({bend: pose.bend + .4, turn: pose.turn + .7, pitch: pose.pitch + .3});
  const mesh = () => buildGeometry(e.report, e.frame).objects.get(e.selectedSlot).spatialMesh.positions;
  const before = Array.from(mesh()), typeId = e.figure.figure_type_id;
  const moved = structuredClone(model); setOrigin(moved, [.15, .9, .05]);
  const previous = e.report.figure_types.find(f => f.figure_type_id === typeId), {figure} = modelToFigure(moved, {figureTypeId: typeId, previous});
  e.replaceFigureDefinition(typeId, figure, {moveRoot: (obj, old) => originShift(old, obj, [0, 0, 0], moved.origin, {spatialQuaternion, quatRotate, animationRotation})});
  const after = mesh();
  let worst = 0; for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]));
  assert.ok(worst < .05, `the model stays put (moved ${worst.toFixed(3)} px)`);
  // The root handle (the orange dot) did move: to where the new origin is.
  e.undo();
  const restored = mesh(); assert.ok(before.every((v, i) => Math.abs(v - restored[i]) < 1e-6), 'one undo step');
});

test('traced lines: open with two ends, closed when the ends meet', () => {
  const mesh = {verts: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [5, 5, 5]], faces: [], edges: [[0, 1], [1, 2], [2, 3]], loose: [4]};
  let [line] = tracedLines(mesh);
  assert.deepEqual(line.points, [0, 1, 2, 3]); assert.equal(line.closed, false); assert.deepEqual(line.ends.sort(), [0, 3]);
  assert.equal(tracedLines(mesh).length, 1, 'a single point on its own is not a line');
  assert.equal(otherEnd(mesh, 3), 0); assert.equal(otherEnd(mesh, 0), 3); assert.equal(otherEnd(mesh, 1), null);
  mesh.edges.push([3, 0]);
  [line] = tracedLines(mesh);
  assert.equal(line.closed, true); assert.equal(line.points.length, 4);
  assert.equal(otherEnd(mesh, 3), null);
});

test('splitting a traced line opens a ring, or breaks a line in two, and stays valid', () => {
  const ring = {verts: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [], edges: [[0, 1], [1, 2], [2, 3], [3, 0]]};
  M.splitWire(ring, 1, 2);
  assert.ok(validateMesh(ring, {print: false}).ok);
  const [line] = tracedLines(ring);
  assert.equal(line.closed, false); assert.deepEqual(line.ends.sort(), [1, 2]);
  M.splitWire(ring, 3, 0);
  assert.ok(validateMesh(ring, {print: false}).ok);
  assert.equal(tracedLines(ring).length, 2);
  // An end split off on its own is kept as a single point.
  const stub = {verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1]]};
  M.splitWire(stub, 0, 1);
  assert.ok(validateMesh(stub, {print: false}).ok);
  assert.deepEqual([...stub.loose].sort(), [0, 1]); assert.equal(tracedLines(stub).length, 0);
});
