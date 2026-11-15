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

// ---------- Swap sets on the stage ----------
import {makeSwapSet, swapSets, hiddenBySwap, showChoice, swapSetProblem, plainFolder, choiceKey, swapChoiceOf} from '../src/modeler/layers.mjs';
import {uvSphere} from '../src/modeler/primitives.mjs';
import {evaluatedNativeFrame} from '../src/pivot/geometry.mjs';
import {poseChoiceGroups} from '../src/rig-pose-choices.mjs';

/** The Base character with a Mouth swap set: three small discs in front of the face. */
function mouthModel() {
  const model = characterModel(), head = model.bones.find(b => b.name === 'Head') ?? model.bones.at(-1);
  const at = head.head.map((v, k) => (v + head.tail[k]) / 2), set = addFolder(model, {name: 'Mouth'});
  for (const [k, name] of ['Closed', 'Open', 'O'].entries()) {
    const p = addPart(model, {name, mesh: uvSphere(.03 + k * .01, 8, 4, 5), position: [at[0], at[1] - .05, at[2] + .2]});
    p.folder = set.id;
  }
  assert.ok(makeSwapSet(model, set.id));
  return {model, set};
}
const meshOf = (e, uid = e.selectedUid) => { const g = buildGeometry(e.report, e.frame); for (const o of g.objects.values()) if (o.obj.unique_id === uid) return o.spatialMesh; };
/** How spread out a named group of the stage mesh is on screen (stage positions are x, y per point; 0 when collapsed). */
function spreadOf(e, figure, name) {
  const mesh = meshOf(e), group = figure._styk.spatialMesh.groups.find(g => g.name === name), xs = [], ys = [];
  for (let t = group.start; t < group.start + group.count; t++) for (let k = 0; k < 3; k++) { const v = figure._styk.spatialMesh.indices[t * 3 + k]; xs.push(mesh.positions[v * 2]); ys.push(mesh.positions[v * 2 + 1]); }
  return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
}

test('a swap set: one choice shows in the view; the rest are left out of the view only', () => {
  const {model, set} = mouthModel(), [closed, open, o] = model.parts.filter(p => p.folder === set.id);
  assert.deepEqual(swapSets(model).map(x => [x.set.name, x.choices.length, x.shown]), [['Mouth', 3, choiceKey(closed)]]);
  assert.equal(hiddenBySwap(model, closed), false); assert.equal(hiddenBySwap(model, open), true);
  showChoice(model, choiceKey(o));
  assert.equal(hiddenBySwap(model, o), false); assert.equal(hiddenBySwap(model, closed), true);
  // Saved and reopened, the set and its shown choice stay.
  const again = readModel(JSON.parse(JSON.stringify(model)));
  assert.equal(swapSets(again)[0].shown, choiceKey(o));
  // A swap set can't sit inside another one.
  const inner = addFolder(model, {name: 'Inner', parent: set.id}); moveToFolder(model, [open.id], inner.id);
  assert.equal(swapSetProblem(model, inner.id), 'inside');
  plainFolder(model, set.id); assert.equal(swapSets(model).length, 0);
});

test('on the stage a swap set is a choice: only the shown one is drawn, picking another swaps them in one undo step', () => {
  const {model} = mouthModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  const {document} = modelDocument(model); e.importFigure(document, {position: {x: 400, y: 400}});
  const figure = e.figure, groups = poseChoiceGroups(e.figure, e.object).filter(g => g.kind === 'visibility');
  assert.deepEqual(groups.map(g => [g.name, g.choices.map(c => c.label)]), [['Mouth', ['Closed', 'Open', 'O']]]);
  const closed = groups[0].choices.find(c => c.label === 'Closed');
  assert.equal(groups[0].value, closed.id, 'the shown choice is picked at first');
  assert.ok(spreadOf(e, figure, 'Closed') > 1); assert.ok(spreadOf(e, figure, 'Open') < 1e-6); assert.ok(spreadOf(e, figure, 'O') < 1e-6);
  // The choice bones have no handles on the stage (the badge picks).
  const open = groups[0].choices.find(c => c.label === 'Open');
  assert.ok(e.setPoseChoice('Mouth', open.id));
  assert.ok(spreadOf(e, figure, 'Open') > 1); assert.ok(spreadOf(e, figure, 'Closed') < 1e-6);
  e.undo();
  assert.ok(spreadOf(e, figure, 'Closed') > 1); assert.ok(spreadOf(e, figure, 'Open') < 1e-6);
  // The mouth turns with the head: tilt the head and the choice moves with it.
  const before = meshOf(e).positions.slice();
  e.select(e.selectedUid, e.figure.segments.findIndex(s => s.name === 'Head'));
  const pose = e.getSpatialPose(); e.setSpatialPose({bend: pose.bend + .6, turn: pose.turn + .5, pitch: pose.pitch});
  const group = figure._styk.spatialMesh.groups.find(g => g.name === 'Closed'), v = figure._styk.spatialMesh.indices[group.start * 3];
  assert.ok(Math.hypot(meshOf(e).positions[v * 2] - before[v * 2], meshOf(e).positions[v * 2 + 1] - before[v * 2 + 1]) > 1, 'the mouth follows the head');
});

test('between two keys a swap changes at the next key, never growing or shrinking', () => {
  const {model} = mouthModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  const g = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Mouth'), open = g.choices.find(c => c.label === 'Open');
  e.duplicateFrame(); e.setPoseChoice('Mouth', open.id);
  const index = e.figure.segments.findIndex(s => s._stykPoseChoice?.label === 'Open'), uid = e.selectedUid, rest = e.figure.segments[index].length;
  // Keys hold by default; with the key eased (linear or auto) everything else blends, the swap doesn't.
  for (const interpolation of ['hold', 'linear', 'auto']) {
    e.report.keyframes[0]._styk = {...e.report.keyframes[0]._styk, easing: {interpolation}};
    for (const t of [.1, .5, .9]) {
      const sampled = evaluatedNativeFrame(e.report, 0, t).objects.find(o => o.unique_id === uid);
      assert.equal(sampled.lengths[index], 0, `still hidden at ${t} (${interpolation})`);
    }
  }
  assert.equal(evaluatedNativeFrame(e.report, 1, 0).objects.find(o => o.unique_id === uid).lengths[index], rest);
});

test('updating a placed figure keeps each frame\'s choice and hides choices it didn\'t have', () => {
  const {model, set} = mouthModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  const typeId = e.figure.figure_type_id, g = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Mouth');
  e.setPoseChoice('Mouth', g.choices.find(c => c.label === 'O').id);
  // Add a Smile choice and update the figure.
  const head = model.bones.find(b => b.name === 'Head');
  const smile = addPart(model, {name: 'Smile', mesh: uvSphere(.06, 8, 4, 5), position: head.tail.map((v, k) => k === 2 ? v + .2 : v)}); smile.folder = set.id;
  const previous = e.report.figure_types.find(f => f.figure_type_id === typeId), {figure, hiddenChoices} = modelToFigure(model, {figureTypeId: typeId, previous});
  e.replaceFigureDefinition(typeId, figure, {newLengths: new Map([...hiddenChoices].map(id => [id, 0]))});
  const after = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Mouth');
  assert.deepEqual(after.choices.map(c => c.label), ['Closed', 'Open', 'O', 'Smile']);
  assert.equal(after.choices.find(c => c.id === after.value)?.label, 'O', 'the frame keeps its O; Smile starts hidden');
});

// ---------- Face sets ----------
import {starterFace, stickToFace, facePart, faceFrame} from '../src/modeler/face-sets.mjs';

test('starter face: mouths and eyes on the face, valid, in swap sets on the head, and saved', () => {
  const model = characterModel(), out = starterFace(model);
  assert.deepEqual(Object.keys(out), ['mouth', 'eyes']);
  const sets = Object.fromEntries(swapSets(model).map(s => [s.set.name, s.choices.map(c => c.label)]));
  assert.deepEqual(sets, {Mouth: ['Closed', 'Open', 'A', 'O', 'Smile'], Eyes: ['Open', 'Closed', 'Happy']});
  const head = model.bones.find(b => b.name === 'Head'), f = faceFrame(model), face = facePart(model);
  assert.equal(face?.name, 'Head');
  for (const {set, choices} of swapSets(model)) {
    assert.equal(set.bone, head.id, `${set.name} rides the head`);
    for (const c of choices) for (const p of c.parts) {
      const mesh = evaluatePart(p);
      assert.ok(validateMesh(mesh, {print: false}).ok, `${p.name} is a valid mesh`);
      // On the face: inside the head's height, in front of its middle.
      for (const v of mesh.verts) { assert.ok(v[1] > f.y0 && v[1] < f.y0 + f.H, `${p.name} within the face's height`); assert.ok(v[2] > 0, `${p.name} on the front`); }
    }
  }
  // Mouths below eyes.
  const mid = name => { const p = model.parts.find(q => q.name === name), v = evaluatePart(p).verts; return v.reduce((t, q) => t + q[1], 0) / v.length; };
  assert.ok(mid('Smile') < mid('Happy'));
  // Saved and opened again (the model rides in the figure), the sets come back as they were.
  const {figure} = modelToFigure(model), again = readModel(JSON.parse(JSON.stringify(figure._styk.modelSource)));
  assert.deepEqual(Object.fromEntries(swapSets(again).map(s => [s.set.name, s.choices.map(c => c.label)])), sets);
  // A second starter face makes its own folders beside the first.
  starterFace(model);
  assert.deepEqual(swapSets(model).map(s => s.set.name), ['Mouth', 'Eyes', 'Mouth 2', 'Eyes 2']);
});

test('adopting a model\'s own eyes, mouth and brows keeps them as the first choice, without their face bones', async () => {
  const j = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  const eye = j.parts.find(p => p.name === 'Open' && swapChoiceOf(j, p)?.set.name === 'Eyes');
  assert.ok(eye?.mirror, 'her own mirrored eye is the Open choice');
  assert.ok(eye.mesh.faces.some(f => f.c !== eye.mesh.faces[0].c), 'with its own colours');
  // Angry turns the inner ends of the brows down, Worried up (as seen from the front, both sides).
  const brow = name => { const p = j.parts.find(q => q.name === name && swapChoiceOf(j, q)?.set.name === 'Brows'), v = evaluatePart(p).verts.filter(q => q[0] > 0);
    const xm = v.reduce((t, q) => t + q[0], 0) / v.length, mean = side => { const w = v.filter(q => (q[0] - xm) * side > 0); return w.reduce((t, q) => t + q[1], 0) / w.length; };
    return mean(-1) - mean(1); };
  assert.ok(brow('Angry') < brow('Normal') - .005, 'angry: inner end lower');
  assert.ok(brow('Worried') > brow('Normal') + .005, 'worried: inner end higher');
});

test('Stick to face presses a part onto the face from the view, just in front of the skin', () => {
  const model = characterModel(), f = faceFrame(model), face = facePart(model);
  const disc = addPart(model, {name: 'Freckles', mesh: uvSphere(.02, 6, 3, 5), position: [f.xc + .05, f.y0 + f.H * .35, f.zFront + .3]});
  const ray = p => ({origin: [p[0], p[1], p[2] + 10], direction: [0, 0, -1]});
  const before = evaluatePart(disc).verts.map(v => v[2]);
  assert.ok(stickToFace(model, [disc], ray, .004) > 0);
  const after = evaluatePart(disc).verts;
  assert.ok(Math.max(...after.map(v => v[2])) < Math.min(...before), 'it moved back onto the face');
  // Every point sits just in front of the face part (about the lift away).
  const surface = evaluatePart(face);
  const nearest = p => Math.min(...surface.verts.map(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])));
  assert.ok(after.every(p => nearest(p) < f.H * .15), 'on the face');
  assert.ok(validateMesh(disc.mesh, {print: false}).ok);
  // Nothing behind it: points stay put.
  const off = addPart(model, {name: 'Off', mesh: uvSphere(.02, 6, 3, 5), position: [5, 5, 5]});
  assert.equal(stickToFace(model, [off], ray, .004), 0);
});

test('a project with face sets saves and opens again with each frame\'s choices', () => {
  const {model} = mouthModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  const g = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Mouth');
  e.duplicateFrame(); e.setPoseChoice('Mouth', g.choices.find(c => c.label === 'O').id);
  const saved = JSON.parse(JSON.stringify(e.report)), again = new Editor({demo: false}); again.load(saved);
  const label = index => { again.selectFrame(index); again.select(again.frame.objects.find(o => o.figure_type_id === e.figure.figure_type_id).unique_id, -1); const x = poseChoiceGroups(again.figure, again.object).find(y => y.name === 'Mouth'); return x.choices.find(c => c.id === x.value)?.label; };
  assert.equal(label(0), 'Closed'); assert.equal(label(1), 'O');
});

test('renaming a choice or its set keeps the choice in every frame', () => {
  const {model, set} = mouthModel(), e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  const typeId = e.figure.figure_type_id, g = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Mouth');
  e.setPoseChoice('Mouth', g.choices.find(c => c.label === 'Open').id);
  model.parts.find(p => p.folder === set.id && p.name === 'Open').name = 'Wide open'; set.name = 'Lips';
  const previous = e.report.figure_types.find(f => f.figure_type_id === typeId), {figure, hiddenChoices} = modelToFigure(model, {figureTypeId: typeId, previous});
  e.replaceFigureDefinition(typeId, figure, {newLengths: new Map([...hiddenChoices].map(id => [id, 0]))});
  const after = poseChoiceGroups(e.figure, e.object).find(x => x.name === 'Lips');
  assert.equal(after.choices.find(c => c.id === after.value)?.label, 'Wide open');
});

test('a folder inside a swap set is one choice (both its parts swap together); a deleted shown choice falls back to the first', () => {
  const {model, set} = mouthModel(), head = model.bones.find(b => b.name === 'Head');
  const pair = addFolder(model, {name: 'Fangs', parent: set.id});
  for (const x of [-.03, .03]) { const p = addPart(model, {name: 'Fang', mesh: uvSphere(.01, 6, 3, 8), position: [head.head[0] + x, head.head[1], head.head[2] + .2]}); p.folder = pair.id; }
  assert.deepEqual(swapSets(model)[0].choices.map(c => c.label), ['Closed', 'Open', 'O', 'Fangs']);
  showChoice(model, choiceKey(pair));
  const {figure, hiddenChoices} = modelToFigure(model), bones = figure.segments.filter(s => s._stykPoseChoice);
  assert.equal(bones.length, 4); assert.equal(hiddenChoices.size, 3);
  const fangs = bones.find(s => s._stykPoseChoice.label === 'Fangs');
  assert.ok(!hiddenChoices.has(fangs.segment_id), 'the folder choice is the one shown');
  const mesh = figure._styk.spatialMesh, groups = mesh.groups.filter(g => g.name === 'Fang');
  assert.equal(groups.length, 2);
  for (const g of groups) { const v = mesh.indices[g.start * 3]; assert.equal(mesh.bones[v * 4], fangs.segment_id); assert.equal(mesh.weights[v * 4], 1); }
  // Delete the shown choice: the set shows its first again.
  model.parts = model.parts.filter(p => p.folder !== pair.id); dropEmptyFolders(model);
  assert.equal(swapSets(model)[0].shown, swapSets(model)[0].choices[0].key);
});

// ---------- Add Mesh settings ----------
import {PRIMITIVES, PRIMITIVE_SETTINGS, primitiveSettings, cylinder, circle} from '../src/modeler/primitives.mjs';

test('shapes are added with Blender\'s settings: vertices, sizes and cap fill, always valid', () => {
  for (const kind of Object.keys(PRIMITIVE_SETTINGS)) for (const fill of ['ngon', 'fan', 'none']) for (const n of [3, 7, 64]) {
    const mesh = PRIMITIVES[kind]({vertices: n, segments: n, rings: n, majorSegments: n, minorSegments: n, fill});
    assert.ok(validateMesh(mesh, {print: false}).ok, `${kind} ${n} ${fill}`);
  }
  // A cylinder's sides and caps: N-gon is one face a cap, Triangle fan a triangle a side, Nothing an open tube.
  const sides = n => n;
  assert.equal(cylinder(.5, 1, 8, 0, {cap: 'ngon'}).faces.length, sides(8) + 2);
  const fan = cylinder(.5, 1, 8, 0, {cap: 'fan'});
  assert.equal(fan.faces.length, sides(8) + 16); assert.equal(fan.verts.length, 18);
  assert.ok(fan.faces.slice(8).every(f => f.v.length === 3));
  const open = cylinder(.5, 1, 8, 0, {cap: 'none'});
  assert.equal(open.faces.length, 8); assert.equal(open.verts.length, 16);
  // Radius and depth.
  const tall = PRIMITIVES.cylinder({vertices: 6, radius: .25, depth: 3});
  assert.ok(Math.abs(Math.max(...tall.verts.map(v => v[1])) - 1.5) < 1e-9 && Math.abs(Math.max(...tall.verts.map(v => Math.hypot(v[0], v[2]))) - .25) < 1e-9);
  // A circle filled with nothing is a ring of lines, ready to extrude or bridge.
  const ring = circle(.5, 6, 0, {fill: 'none'});
  assert.equal(ring.faces.length, 0); assert.equal(ring.edges.length, 6);
  // Out-of-range settings come back inside their limits.
  assert.deepEqual(primitiveSettings('cylinder', {vertices: 1.6, radius: -2, fill: 'odd'}), {vertices: 3, radius: .001, depth: 1, fill: 'ngon'});
});
