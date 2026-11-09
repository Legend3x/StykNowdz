import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {baseCharacter, uvSphere} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, evaluatePart, evaluateModel, readModel} from '../src/modeler/model.mjs';
import {baseCharacterSkeleton, autoWeights, faceSkeleton, symmetrizeBones, headBone, setFace} from '../src/modeler/armature.mjs';
import {modelToFigure, modelDocument} from '../src/modeler/export-figure.mjs';
import {validateControlMetadata, rigControlIsFace, rigFaceShown, setRigFaceShown} from '../src/rig-control-details.mjs';
import {faceBadges, toggleFaceControls} from '../src/face-badges.mjs';
import {getPivotHandles} from '../src/canvas-interactions.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';

/** An eye ring: inner points 0..n-1, outer n..2n-1, one quad between each pair. */
function eyeRing(n = 12) {
  const verts = [], faces = [];
  for (const r of [1, 2]) for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; verts.push([Math.cos(a) * r, Math.sin(a) * r, 0]); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push({v: [i, j, n + j, n + i], c: 0}); }
  return {verts, faces};
}
const wireLoop = (n = 12) => ({verts: Array.from({length: n}, (_, i) => [Math.cos(i / n * 6.283), Math.sin(i / n * 6.283), 0]), faces: [], edges: Array.from({length: n}, (_, i) => [i, (i + 1) % n])});

test('Alt+click loops follow traced lines and whole open borders', () => {
  assert.equal(M.edgeLoop(wireLoop(), [0, 1]).size, 12, 'a traced ring');
  const open = wireLoop(); open.edges.pop();
  assert.deepEqual([...M.edgeLoop(open, [4, 5])].sort((a, b) => a - b), [...Array(12).keys()], 'an open traced line, end to end');
  const ring = eyeRing();
  assert.equal(M.edgeLoop(ring, [12, 13]).size, 12, 'the outer border of the eye ring');
  assert.equal(M.edgeLoop(ring, [0, 1]).size, 12, 'the inner border');
  // A fork stops the walk: a third line leaving point 3.
  const fork = wireLoop(); fork.verts.push([3, 3, 0]); fork.edges.push([3, 12]);
  const loop = M.edgeLoop(fork, [0, 1]);
  assert.ok(loop.has(3) && !loop.has(12), 'it stops at the fork from both sides');
  const branch = M.edgeLoop(fork, [3, 12]);
  assert.deepEqual([...branch].sort((a, b) => a - b), [3, 12]);
});

test('loop cuts: several at once, evenly spaced, and one at any point along the ring', () => {
  const ring = eyeRing(), before = ring.faces.length;
  const made = M.loopCut(ring, [0, 12], .5, 3);
  assert.equal(made.size, 36); assert.equal(ring.faces.length, before * 4);
  assert.deepEqual(validateMesh(ring).problems ?? [], []);
  // The radius of each new loop: 1.25, 1.5, 1.75.
  const radii = [...new Set([...made].map(v => Math.hypot(...ring.verts[v]).toFixed(2)))].sort();
  assert.deepEqual(radii, ['1.25', '1.50', '1.75']);
  const one = eyeRing(); const at = M.loopCut(one, [0, 12], .2);
  [...at].forEach(v => assert.ok(Math.abs(Math.hypot(...one.verts[v]) - 1.2) < 1e-9));
  // The ring runs end to end (the preview draws it as one line).
  const r = M.edgeRing(eyeRing(), [3, 15]);
  for (let k = 1; k < r.length; k++) assert.ok(eyeRing().faces.some(f => [...r[k - 1], ...r[k]].every(v => f.v.includes(v))), `ring step ${k} shares a face`);
});

test('soft select falloffs and edge slide', () => {
  const line = Array.from({length: 11}, (_, i) => [i / 10, 0, 0]), at = (f, i) => M.softWeights(line, new Set([0]), 1, f).get(i);
  assert.equal(at('constant', 5), 1); assert.equal(at('linear', 5), .5); assert.equal(at('sharp', 5), .25);
  assert.ok(at('sharp', 3) < at('smooth', 3) && at('smooth', 3) < at('root', 3));
  assert.equal(M.softWeights(line, new Set([0]), 1, 'nonsense').get(5), at('smooth', 5));
  // Edge slide keeps points on their edges: the inner loop slides toward the outer one.
  const ring = eyeRing(), inner = new Set([...Array(12).keys()]);
  const toward = new Map([...M.slideNeighbours(ring, inner)].map(([v, list]) => [v, list[0]]));
  assert.equal(toward.size, 12);
  const slid = M.slideMesh(ring, toward, .25);
  inner.forEach(v => assert.ok(Math.abs(Math.hypot(...slid.verts[v]) - 1.25) < 1e-9));
  assert.deepEqual(ring.verts[0], [1, 0, 0], 'the original is untouched');
});

function faceModel() {
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  model.parts.find(p => p.name === 'Head').smooth = 2;
  const added = faceSkeleton(model, evaluateModel(model, {smooth: false}).map(x => x.mesh));
  return {model, added};
}

test('face bones sit on the head and pull only the skin around their tips', () => {
  const {model, added} = faceModel(), byName = new Map(model.bones.map(b => [b.name, b]));
  assert.deepEqual(added.map(b => b.name).sort(), ['Brow.L', 'Brow.R', 'Eye.L', 'Eye.R', 'Jaw', 'Lid.L', 'Lid.R', 'LipCorner.L', 'LipCorner.R', 'LipLower', 'LipUpper']);
  assert.ok(added.every(b => b.face && b.reach >= 0));
  const head = headBone(model);
  assert.equal(head.name, 'Head');
  assert.equal(byName.get('LipLower').parent, byName.get('Jaw').id);
  assert.ok(added.filter(b => b.name !== 'LipLower').every(b => b.parent === head.id));
  // Mirrored pairs and in front of the head.
  assert.equal(byName.get('Brow.R').tail[0], -byName.get('Brow.L').tail[0]);
  assert.ok(byName.get('Eye.L').tail[2] > byName.get('Eye.L').head[2], 'eyes look forward');
  // Running it again replaces them instead of adding more.
  faceSkeleton(model, evaluateModel(model, {smooth: false}).map(x => x.mesh));
  assert.equal(model.bones.filter(b => b.face).length, 11);

  const part = model.parts.find(p => p.name === 'Head'), mesh = evaluatePart(part), skin = autoWeights(model, mesh, part);
  const jaw = model.bones.find(b => b.name === 'Jaw'), weightOf = (v, id) => [0, 1, 2, 3].reduce((s, k) => s + (skin.bones[v * 4 + k] === id ? skin.weights[v * 4 + k] : 0), 0);
  for (let v = 0; v < mesh.verts.length; v++) {
    const sum = [0, 1, 2, 3].reduce((s, k) => s + skin.weights[v * 4 + k], 0);
    assert.ok(Math.abs(sum - 1) < 1e-5, `weights of ${v} sum to one`);
  }
  const pulled = mesh.verts.map((p, v) => [p, weightOf(v, jaw.id)]).filter(([, w]) => w > .05);
  assert.ok(pulled.length > 10, `${pulled.length} points follow the jaw`);
  assert.ok(pulled.every(([p]) => p[1] < jaw.head[1] + jaw.reach * .07), 'the jaw takes nothing above the mouth');
  // Body parts never take face bones; a part pinned to Head (a hat, the hair) takes none either.
  const torso = model.parts.find(p => p.name === 'Torso'), tskin = autoWeights(model, evaluatePart(torso), torso);
  assert.ok(!tskin.bones.some(id => model.bones.find(b => b.id === id)?.face));
  const hair = model.parts.find(p => p.name === 'Hair'); hair.bone = head.id;
  assert.ok(autoWeights(model, evaluatePart(hair), hair).bones.every(id => !id || id === head.id));
  // An eyeball that follows Eye.L goes rigidly with it (its mirrored half with Eye.R).
  const now = new Map(model.bones.map(b => [b.name, b]));
  const eye = addPart(model, {name: 'Eyeball', mesh: uvSphere(.02, 8, 6), position: now.get('Eye.L').head, mirror: true});
  eye.bone = now.get('Eye.L').id;
  const eskin = autoWeights(model, evaluatePart(eye), eye), used = new Set(eskin.bones.filter(Boolean));
  assert.deepEqual([...used].map(id => model.bones.find(b => b.id === id).name).sort(), ['Eye.L', 'Eye.R']);
});

test('face bone settings survive saving, symmetry and export, and become face controls', () => {
  const {model} = faceModel();
  const brow = model.bones.find(b => b.name === 'Brow.L');
  setFace(brow, {reach: .08, cut: 'above'}); symmetrizeBones(model);
  const twin = model.bones.find(b => b.name === 'Brow.R');
  assert.equal(twin.reach, .08); assert.equal(twin.cut, 'above');
  const back = readModel(JSON.parse(JSON.stringify(model)));
  assert.equal(back.bones.find(b => b.name === 'Brow.L').reach, .08);
  const broken = JSON.parse(JSON.stringify(model)); broken.bones[0].face = 'yes'; broken.bones[1].reach = 3;
  const fixed = readModel(broken);
  assert.ok(!('face' in fixed.bones[0]) && !('reach' in fixed.bones[1]), 'stray face fields are dropped');

  const {figure} = modelToFigure(model);
  const face = figure.segments.filter(rigControlIsFace);
  assert.equal(face.length, 11);
  face.forEach(s => assert.doesNotThrow(() => validateControlMetadata(s)));
  assert.throws(() => validateControlMetadata({_stykControl: {level: 'mouth'}}), /rig/i);
  const e = new Editor({demo: false}); e.load({...emptyDocument(), ...modelDocument(model).document});
  validateScene(e.report);
});

test('on the stage face joints hide behind the head badge, and posing the jaw moves the chin', () => {
  const {model} = faceModel();
  const e = new Editor({demo: false}); e.load({...emptyDocument(), ...modelDocument(model).document});
  const g = e.geometry.objects.get(0), uid = g.obj.unique_id, project = p => ({x: p.x, y: p.y});
  const handles = () => getPivotHandles(e.geometry, {faceShownUids: new Set([...[uid]].filter(u => rigFaceShown(e, u)))}).filter(h => h.uid === uid);
  const faceHandles = () => handles().filter(h => rigControlIsFace(g.segments[h.joint]?.seg)).length;
  assert.equal(faceHandles(), 0, 'hidden at first');
  const badges = faceBadges(e, project);
  assert.equal(badges.length, 1); assert.equal(badges[0].shown, false);
  // The badge sits by the head joint.
  const head = g.segments.find(s => s.seg.name === 'Head'), at = head.handle ?? head.end;
  assert.ok(Math.hypot(badges[0].x - at.x, badges[0].y - at.y) < 30);
  assert.equal(toggleFaceControls(e, uid), true);
  assert.equal(faceHandles(), 11, 'shown after a click');
  setRigFaceShown(e, uid, false);
  assert.equal(faceHandles(), 0);
  // Posing a face joint is ordinary posing: the jaw opens and the skin follows.
  const before = [...e.geometry.objects.get(0).spatialMesh.positions ?? []];
  e.select(uid, g.segments.findIndex(s => s.seg.name === 'Jaw'));
  e.beginDrag('jaw'); e.setSpatialPose({bend: .5}); e.commitDrag();
  const after = [...e.geometry.objects.get(0).spatialMesh.positions ?? []];
  if (before.length) assert.notDeepEqual(after, before);
  assert.notEqual(e.getSpatialPose().bend, 0);
});

test('reference images stand in the scene: both visible from any angle, each square-on in its own view', async () => {
  const {referenceCorners, cameraFrame, defaultCamera, VIEWS} = await import('../src/modeler/viewport.mjs');
  const front = referenceCorners({view: 'front', height: 2, offsetX: .5, offsetY: .1}, .5), side = referenceCorners({view: 'side', height: 2}, .5);
  assert.deepEqual(front, {tl: [0, 2.1, -2], tr: [1, 2.1, -2], bl: [0, .1, -2]}, 'a wall behind the middle');
  assert.ok([side.tl, side.tr, side.bl].every(p => p[0] === -2), 'a wall to the left');
  const seen = (view, c) => { const camera = {...defaultCamera(), yaw: VIEWS[view][0], pitch: VIEWS[view][1], ortho: true}, f = cameraFrame(camera, 800, 600);
    const [a, b, d] = [c.tl, c.tr, c.bl].map(f.project); return {width: b.x - a.x, height: d.y - a.y}; };
  // Square-on and the right way round in its own view (left edge on the left, top on top)...
  for (const [view, c] of [['front', front], ['right', side]]) { const s = seen(view, c); assert.ok(s.width > 50 && s.height > 50, `${view}: ${JSON.stringify(s)}`); }
  // ...edge-on (out of the way) in the other one, and Flip mirrors it.
  assert.ok(Math.abs(seen('right', front).width) < 1e-6 && Math.abs(seen('front', side).width) < 1e-6);
  assert.ok(seen('right', referenceCorners({view: 'side', height: 2, flip: true}, .5)).width < -50);
  // A stored flip survives reading; anything else is dropped.
  const model = readModel({...emptyModel(), references: [{id: 'a', view: 'side', src: 'data:,', flip: true}, {id: 'b', view: 'front', src: 'data:,', flip: 'yes'}]});
  assert.equal(model.references[0].flip, true); assert.ok(!('flip' in model.references[1]));
});
