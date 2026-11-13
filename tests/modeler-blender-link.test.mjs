import test from 'node:test';
import assert from 'node:assert/strict';
import {baseCharacter, cube} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, readModel, evaluatePart} from '../src/modeler/model.mjs';
import {baseCharacterSkeleton, setPull, pullOf} from '../src/modeler/armature.mjs';
import {startBlenderLink, applyBlenderLink, readBlenderReply} from '../src/modeler/blender-link.mjs';

/** What desktop/blender/styk_link.py sends back for a scene nobody touched. */
function untouched(doc) {
  const materials = [], index = new Map();
  const colorOf = c => { const rgb = doc.palette[c], k = rgb.join(); if (!index.has(k)) { index.set(k, materials.length); materials.push(rgb.slice()); } return index.get(k); };
  return {format: doc.format, version: doc.version, name: doc.name, materials,
    parts: doc.parts.map(p => ({key: p.key, name: p.name, follows: p.follows, matrix: p.matrix.slice(), verts: p.verts.map(v => v.slice()), faces: p.faces.map(f => f.slice()), colors: p.colors.map(colorOf),
      edges: p.edges, loose: p.loose, mirror: p.mirror, clip: p.clip, smooth: p.smooth, solidify: p.solidify, visible: p.visible, baked: false,
      crease: p.crease, line: p.line, normal: p.normal, weights: p.weights})),
    bones: doc.bones.map(b => ({...b}))};
}
function hero() { const model = emptyModel(); model.name = 'Hero'; for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model); return model; }

test('a model sent to Blender and saved untouched comes back exactly as it was', () => {
  const model = hero(), before = JSON.stringify(model), {doc, session} = startBlenderLink(model);
  assert.equal(doc.parts.length, model.parts.length);
  assert.ok(doc.parts.some(p => p.mirror), 'mirror stays a setting, not baked');
  assert.ok(doc.parts.every(p => Object.keys(p.weights).length), 'every part carries the weights the animation uses');
  const json = JSON.parse(JSON.stringify(untouched(doc)));
  const report = applyBlenderLink(model, json, session);
  assert.deepEqual(report, {changed: 0, added: 0, removed: 0, kept: model.parts.length, baked: 0, painted: 0, bones: {changed: 0, added: 0, removed: 0}});
  assert.equal(JSON.stringify(model), before);
});

test('Blender edits merge by key: changed, added, deleted and renamed objects and bones', () => {
  const model = hero(), {doc, session} = startBlenderLink(model), reply = untouched(doc);
  const torso = model.parts.find(p => p.name === 'Torso'), arm = model.parts.find(p => p.name === 'Arm'), hair = model.parts.find(p => p.name === 'Hair');
  torso.outline = {on: true, thickness: .02, color: 9};
  const startY = torso.position[1];
  const armBone = model.bones.find(b => b.name === 'UpperArm.L'), armBoneId = armBone.id;
  // In Blender: the torso is subdivided twice and moved up, the hair deleted, a new hat added,
  // a bone renamed and weakened, and a bone added.
  const t = reply.parts.find(p => p.key === `part-${torso.id}`);
  t.smooth = 2; t.matrix[7] += .1; t.verts[0] = [t.verts[0][0] + .01, t.verts[0][1], t.verts[0][2]];
  reply.parts = reply.parts.filter(p => p.key !== `part-${hair.id}`);
  const box = cube(.3); reply.materials.push([250, 10, 20]);
  reply.parts.push({key: 'blender-hat', name: 'Hat', matrix: [1, 0, 0, 0, 0, 1, 0, 1.9, 0, 0, 1, 0, 0, 0, 0, 1], verts: box.verts, faces: box.faces.map(f => f.v), colors: box.faces.map(() => reply.materials.length - 1), mirror: false, smooth: 0, solidify: 0, visible: true, baked: true});
  const b = reply.bones.find(x => x.key === `bone-${armBoneId}`); b.name = 'Bicep.L'; b.strength = .5;
  reply.bones.push({key: 'blender-tail', name: 'Tail', head: [0, 1, -.1], tail: [0, .8, -.4], parent: 'Hips', strength: 1, range: 0});
  const report = applyBlenderLink(model, JSON.parse(JSON.stringify(reply)), session);
  assert.equal(report.changed, 1); assert.equal(report.added, 1); assert.equal(report.removed, 1); assert.equal(report.baked, 1);
  assert.equal(report.bones.changed, 1); assert.equal(report.bones.added, 1);
  assert.equal(torso.smooth, 2); assert.ok(Math.abs(torso.position[1] - startY - .1) < 1e-9);
  assert.deepEqual(torso.outline, {on: true, thickness: .02, color: 9}, '3D Nowdz-only settings stay');
  assert.ok(!model.parts.includes(hair));
  assert.ok(model.parts.includes(arm), 'untouched parts are the same objects');
  const hat = model.parts.find(p => p.name === 'Hat');
  assert.deepEqual(model.palette[hat.mesh.faces[0].c], [250, 10, 20]);
  assert.equal(armBone.name, 'Bicep.L'); assert.equal(armBone.id, armBoneId, 'a renamed bone keeps its id, so animations stay attached');
  assert.equal(pullOf(armBone).strength, .5);
  assert.equal(model.bones.find(x => x.name === 'Tail').parent, model.bones.find(x => x.name === 'Hips').id);
  readModel(JSON.parse(JSON.stringify(model)));
  // Saving again in Blender without changes changes nothing more; the hat is now known by its key.
  const again = applyBlenderLink(model, JSON.parse(JSON.stringify(reply)), session);
  assert.equal(again.kept, model.parts.length); assert.equal(again.added + again.changed + again.removed, 0);
});

test('edits made in 3D Nowdz while Blender is open survive replies that did not touch them', () => {
  const model = hero(), {doc, session} = startBlenderLink(model), reply = untouched(doc);
  const head = model.parts.find(p => p.name === 'Head'); head.position = [0, .05, 0];
  const extra = addPart(model, {name: 'Made here', mesh: cube(.2)});
  const report = applyBlenderLink(model, reply, session);
  assert.deepEqual(head.position, [0, .05, 0]);
  assert.ok(model.parts.includes(extra));
  assert.equal(report.removed, 0);
});

test('weights painted in Blender are kept; unchanged automatic weights stay automatic', () => {
  const model = hero(), {doc, session} = startBlenderLink(model), reply = untouched(doc);
  const torso = model.parts.find(p => p.name === 'Torso'), t = reply.parts.find(p => p.key === `part-${torso.id}`);
  t.verts[1] = t.verts[1].map(v => v + 1e-3);
  t.weights = {...t.weights, 0: [['Head', 1]]};
  const report = applyBlenderLink(model, reply, session);
  assert.equal(report.painted, 1);
  assert.deepEqual(Object.keys(torso.mesh.vdata.skin), ['0']);
  const headId = model.bones.find(b => b.name === 'Head').id;
  assert.deepEqual(torso.mesh.vdata.skin[0], [[headId, 1]]);
});

test('bad replies are refused before anything changes', () => {
  assert.throws(() => readBlenderReply({format: 'x'}), /not from the 3D Nowdz Blender link/);
  const model = hero(), {doc, session} = startBlenderLink(model), reply = untouched(doc), before = JSON.stringify(model);
  reply.parts[0].faces[0] = [0, 1, 99999];
  assert.throws(() => applyBlenderLink(model, reply, session), /broken face/);
  assert.equal(JSON.stringify(model), before);
});

test('bone strength and reach travel to Blender as bone properties', () => {
  const model = hero(); setPull(model.bones.find(b => b.name === 'Shoulder.L'), {strength: 0, range: .1});
  const {doc} = startBlenderLink(model);
  assert.deepEqual(doc.bones.find(b => b.name === 'Shoulder.L'), {...doc.bones.find(b => b.name === 'Shoulder.L'), strength: 0, range: .1});
  assert.ok(evaluatePart(model.parts[0]).verts.length);
});

test('parts follow the skeleton as they did in Blender: bone parent, weights, or not attached', () => {
  const model = hero(), arm = model.parts.find(p => p.name === 'Arm'); arm.bone = model.bones.find(b => b.name === 'UpperArm.L').id;
  const {doc, session} = startBlenderLink(model);
  assert.deepEqual(doc.parts.find(p => p.key === `part-${arm.id}`).follows, {bone: 'UpperArm.L'}, 'Moves with goes to Blender as a bone parent');
  assert.equal(Object.keys(doc.parts.find(p => p.key === `part-${arm.id}`).weights).length, 0);
  const reply = untouched(doc), box = cube(.4);
  const add = (key, follows) => reply.parts.push({key, name: key, follows, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], verts: box.verts, faces: box.faces.map(f => f.v), colors: box.faces.map(() => 0), mirror: false, smooth: 0, solidify: 0, visible: true, baked: true});
  add('Pedestal', 'root'); add('Scarf', {bone: 'Neck'}); add('Cape', 'skin');
  applyBlenderLink(model, reply, session);
  const by = name => model.parts.find(p => p.name === name), id = name => model.bones.find(b => b.name === name).id;
  assert.equal(by('Pedestal').bone, id('Hips'), 'not attached to the armature: stays with the root');
  assert.equal(by('Scarf').bone, id('Neck'));
  assert.equal(by('Cape').bone, undefined, 'an Armature modifier means weights');
  assert.equal(arm.bone, id('UpperArm.L'), 'an untouched bound part keeps its bone');
});
