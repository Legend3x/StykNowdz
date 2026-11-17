import test from 'node:test';
import assert from 'node:assert/strict';
import {readSquash, squashTransform, interpolateSquash} from '../src/squash.mjs';
import {Editor} from '../src/editor.mjs';
import {createBlankDocument} from '../src/startup-document.mjs';
import {modelDocument} from '../src/modeler/export-figure.mjs';
import {emptyModel, addPart} from '../src/modeler/model.mjs';
import {addBone} from '../src/modeler/armature.mjs';
import {uvSphere, cube} from '../src/modeler/primitives.mjs';
import * as Mesh from '../src/modeler/mesh.mjs';

test('stored values are cleaned; rest is nothing', () => {
  assert.equal(readSquash({amount: 1, angle: 30}), null);
  assert.deepEqual(readSquash({amount: 99, angle: 500, from: -1, junk: 1}), {amount: 5, angle: 180});
  assert.deepEqual(readSquash({amount: .5, from: .5}), {amount: .5, from: .5});
});

test('the mapping keeps the volume and the point it squashes from', () => {
  const map = squashTransform({_stykSquash: {amount: 4}}, {x: 10, y: 100});
  assert.deepEqual(map(10, 100), [10, 100], 'the root stays');
  assert.deepEqual(map(10, 90), [10, 60], 'up is stretched by 4');
  assert.deepEqual(map(14, 100), [12, 100], 'across is thinned by 1/√4');
  const side = squashTransform({_stykSquash: {amount: 4, angle: 90}}, {x: 0, y: 0});
  assert.deepEqual(side(1, 0).map(n => +n.toFixed(9) + 0), [4, 0], 'turned 90°: stretches sideways');
});

test('between keys the amount tweens evenly in squash and stretch; a missing side is rest', () => {
  assert.ok(Math.abs(interpolateSquash({amount: .5}, {amount: 2}, .5) ?? 1) === 1 || interpolateSquash({amount: .5}, {amount: 2}, .5) === undefined, 'halfway from 0.5 to 2 is rest');
  assert.equal(interpolateSquash({amount: 2, angle: 40}, undefined, .5).angle, 40, 'the direction holds while easing to rest');
  assert.ok(Math.abs(interpolateSquash({amount: 2, from: 0}, {amount: 2, from: 1}, .25).from - .25) < 1e-9);
});

function sceneWith(model) {
  const e = new Editor({demo: false, layerTimeline: true}); e.load(createBlankDocument({canvas: {width: 400, height: 400}}), 'S');
  e.importFigure(modelDocument(model).document); return e;
}
const meshBox = e => {
  for (const o of e.geometry.objects.values()) {
    const d = (o.drawables ?? []).find(d => d.type === 'mesh'), P = d?.positions ?? d?.spatialMesh?.positions; if (!P) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 2) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); }
    return {w: x1 - x0, h: y1 - y0, top: y0, bottom: y1};
  }
};

test('the whole figure: a ball stretches up from where it stands, or about its middle, and back', () => {
  const m = emptyModel(); addPart(m, {name: 'Ball', mesh: Mesh.cloneMesh(uvSphere(.5, 16, 8))}).position = [0, .5, 0];
  const e = sceneWith(m), rest = meshBox(e);
  assert.equal(e.setSquash({amount: 2}), true);
  let b = meshBox(e);
  assert.ok(Math.abs(b.h - rest.h * 2) < .5 && Math.abs(b.w - rest.w / Math.SQRT2) < .5, 'twice as tall, thinner by √2');
  assert.ok(Math.abs(b.bottom - rest.bottom) < .5, 'standing where it stood');
  e.setSquash({from: .5}); b = meshBox(e);
  assert.ok(Math.abs((b.top + b.bottom) / 2 - (rest.top + rest.bottom) / 2) < .5, 'about its middle');
  assert.equal(e.setSquash({amount: 2}), false, 'no change, no step');
  e.resetSquash(); assert.ok(Math.abs(meshBox(e).h - rest.h) < .01);
  assert.deepEqual(e.getSquash(), {amount: 1, angle: 0, from: 0});
});

test('one part: an arm stretches with its volume kept, alone or with the parts below it', () => {
  const m = emptyModel();
  const upper = addBone(m, {name: 'Upper', head: [0, 1, 0], tail: [0, .5, 0]}), lower = addBone(m, {name: 'Lower', head: [0, .5, 0], tail: [0, 0, 0], parent: upper.id});
  const mesh = Mesh.cloneMesh(cube(.2)); addPart(m, {name: 'Arm', mesh});
  const e = sceneWith(m), f = e.figure, at = name => f.segments.findIndex(s => s.name === name);
  e.select(e.selectedUid, at('Upper'));
  assert.equal(e.getPartSquash().amount, 1);
  e.setPartSquash(2);
  const lengths = () => ['Upper', 'Lower'].map(n => e.object.lengths[at(n)] / f.segments[at(n)].length);
  assert.deepEqual(lengths().map(n => +n.toFixed(6)), [2, 1]);
  assert.ok(Math.abs(e.object._stykSpatial.shape[f.segments[at('Upper')].segment_id].width - 1 / Math.SQRT2) < 1e-9, 'thinner by √2');
  e.undo(); e.select(e.selectedUid, at('Upper'));
  e.setPartSquash(.5, {below: true});
  assert.deepEqual(lengths().map(n => +n.toFixed(6)), [.5, .5], 'the part below goes along');
  assert.throws(() => e.setPartSquash(50));
});

test('a squashed figure still poses under the pointer: a dragged joint turns toward it on screen', () => {
  const m = emptyModel();
  const upper = addBone(m, {name: 'Upper', head: [0, 1, 0], tail: [.5, 1, 0]}); addBone(m, {name: 'Lower', head: [.5, 1, 0], tail: [1, 1, 0], parent: upper.id});
  addPart(m, {name: 'Arm', mesh: Mesh.cloneMesh(cube(.2))});
  const e = sceneWith(m), f = e.figure, at = name => f.segments.findIndex(s => s.name === name), uid = e.selectedUid;
  e.setSquash({amount: 2, angle: 30});
  e.select(uid, at('Lower'));
  const g = () => e.geometry.objects.get(e.selectedSlot), joint = name => g().joints.get(f.segments[at(name)].segment_id);
  assert.ok(g().squash, 'the geometry keeps its squash');
  const elbow = {...joint('Upper')}, hand = joint('Lower'), pointer = {x: elbow.x + (hand.y - elbow.y) * .8 + (hand.x - elbow.x) * .6, y: elbow.y - (hand.x - elbow.x) * .8 + (hand.y - elbow.y) * .6};
  e.beginDrag('Pose'); e.poseJoint(pointer.x, pointer.y); e.commitDrag();
  const now = joint('Lower'), a = [now.x - elbow.x, now.y - elbow.y], b = [pointer.x - elbow.x, pointer.y - elbow.y];
  const sin = (a[0] * b[1] - a[1] * b[0]) / Math.hypot(...a) / Math.hypot(...b);
  assert.ok(Math.abs(sin) < .01 && a[0] * b[0] + a[1] * b[1] > 0, `the hand points at the pointer on screen (off by ${(Math.asin(sin) * 180 / Math.PI).toFixed(2)}°)`);
});
