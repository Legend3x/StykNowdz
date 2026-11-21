import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyModel, addPart, readModel} from '../src/modeler/model.mjs';
import {addBone} from '../src/modeler/armature.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import {skeletonFile, readSkeletonFile, applySkeleton} from '../src/modeler/skeleton-file.mjs';

function rigged() {
  const model = emptyModel();
  const hips = addBone(model, {name: 'Hips', head: [0, 1, 0], tail: [0, 1.2, 0]});
  const thigh = addBone(model, {name: 'Thigh.L', head: [.1, 1, 0], tail: [.1, .5, 0], parent: hips.id, strength: 1.5});
  thigh.state = 'loose';
  const part = addPart(model, {name: 'Leg', mesh: cube(.2)});
  part.mesh.vdata = {skin: {0: [[thigh.id, .75], [hips.id, .25]], 1: [[thigh.id, 1]]}};
  model.origin = [0, .02, 0];
  return {model, hips, thigh, part};
}

test('a skeleton file keeps every bone with its settings and the origin, and reads back the same', () => {
  const {model} = rigged(), file = JSON.parse(JSON.stringify(skeletonFile(model)));
  assert.equal(file.format, 'stykNowdz.skeleton');
  assert.equal(file.parts, undefined, 'no model in it');
  const {bones, origin} = readSkeletonFile(file);
  assert.deepEqual(bones.map(b => [b.name, b.parent && bones.find(p => p.id === b.parent).name, b.strength, b.state]), [['Hips', 0, undefined, undefined], ['Thigh.L', 'Hips', 1.5, 'loose']]);
  assert.deepEqual(origin, [0, .02, 0]);
  assert.throws(() => readSkeletonFile({format: 'something else', bones: []}));
  assert.throws(() => readSkeletonFile({...file, bones: [{...file.bones[0], head: [0, 'x', 0]}]}));
});

test('loading a skeleton: same-named bones keep their painted weights, the rest go back to automatic', () => {
  const {model, thigh} = rigged();
  // The file: Thigh.L moved and a new Shin.L; no Hips.
  const other = emptyModel(), t2 = addBone(other, {name: 'Thigh.L', head: [.12, 1, 0], tail: [.12, .5, 0]});
  addBone(other, {name: 'Shin.L', head: [.12, .5, 0], tail: [.12, .05, 0], parent: t2.id});
  const result = applySkeleton(model, readSkeletonFile(skeletonFile(other)));
  assert.deepEqual(result, {kept: ['Thigh.L'], added: ['Shin.L'], removed: ['Hips']});
  const kept = model.bones.find(b => b.name === 'Thigh.L'), shin = model.bones.find(b => b.name === 'Shin.L');
  assert.equal(kept.id, thigh.id, 'the thigh keeps its place');
  assert.deepEqual(kept.head, [.12, 1, 0]);
  assert.equal(shin.parent, kept.id);
  assert.ok(new Set(model.bones.map(b => b.id)).size === 2 && model.bones.every(b => b.id < model.nextId));
  // The point shared with Hips is all thigh now; the model still opens.
  assert.deepEqual(model.parts[0].mesh.vdata.skin, {0: [[thigh.id, 1]], 1: [[thigh.id, 1]]});
  assert.equal(readModel(JSON.parse(JSON.stringify(model))).bones.length, 2);
});

test('a skeleton file with loops or missing parents still loads, every bone hanging from something real', () => {
  const {model} = rigged(), file = skeletonFile(model);
  file.bones[0].parent = file.bones[1].id; // Hips under Thigh.L, Thigh.L under Hips
  file.bones.push({id: 99, name: 'Lost', head: [0, 0, 0], tail: [0, .1, 0], parent: 1234});
  const {bones} = readSkeletonFile(file), byId = new Map(bones.map(b => [b.id, b]));
  for (const b of bones) { const seen = new Set(); for (let up = b; up; up = byId.get(up.parent)) { assert.ok(!seen.has(up.id)); seen.add(up.id); } }
  assert.equal(bones.find(b => b.name === 'Lost').parent, 0);
});
