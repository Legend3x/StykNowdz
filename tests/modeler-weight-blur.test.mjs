// Blur, Smear and Average (src/modeler/weight-paint.mjs, smearSource in paint-stroke.mjs), as Blender's
// weight paint brushes: they read the weights as each dab found them (startDab).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel} from '../src/modeler/model.mjs';
import {startStroke, startDab, paintPoint, pointsAround, weightAt, dabAverage} from '../src/modeler/weight-paint.mjs';
import {smearSource} from '../src/modeler/paint-stroke.mjs';
import {setStoredWeights} from '../src/modeler/weight-manager.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const weight = (pairs, id) => pairs?.find(([b]) => b === id)?.[1] ?? 0;
const near = (a, b, why, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${why}: ${a} is not ${b}`);

/** Juniper's torso with Chest painted in a ramp from 0 to 1 by height, Auto Normalize off. */
async function ramp() {
  const model = await juniper(); model.weightPaint = {autoNormalize: false};
  const part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id;
  const ys = part.mesh.verts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
  part.mesh.verts.forEach((p, v) => setStoredWeights(part.mesh, v, [[chest, Math.round((p[1] - lo) / (hi - lo) * 1e5) / 1e5]]));
  return {model, part, chest};
}

test('Blur reads the dab\'s starting weights: the order points are painted in no longer matters', async () => {
  const results = [];
  for (const [order, copy] of [['forward', true], ['backward', true], ['forward', false], ['backward', false]]) {
    const {model, part, chest} = await ramp(), stroke = startStroke(model, part, chest);
    const points = part.mesh.verts.map((_, v) => v);
    if (order === 'backward') points.reverse();
    for (let dab = 0; dab < 3; dab++) {
      if (copy) startDab(stroke);
      for (const v of points) paintPoint(stroke, v, 'blur', .8);
    }
    results.push(points.map(() => 0).map((_, v) => weight(stroke.skin[v], chest)));
  }
  const [forward, backward, liveForward, liveBackward] = results;
  assert.deepEqual(backward, forward, 'with the dab\'s copy, either order gives the same weights');
  assert.notDeepEqual(liveBackward, liveForward, 'reading the weights as they change (as Smooth did) depends on the order');
});

test('Blur takes a point towards the average of every corner of the faces around it, its own included', async () => {
  const {model, part, chest} = await ramp(), stroke = startStroke(model, part, chest);
  const v = part.mesh.faces[Math.floor(part.mesh.faces.length / 2)].v[0];
  const corners = part.mesh.faces.filter(f => f.v.includes(v)).flatMap(f => f.v);
  const expected = corners.reduce((t, u) => t + weight(stroke.skin[u], chest), 0) / corners.length, was = weight(stroke.skin[v], chest);
  startDab(stroke);
  assert.equal(paintPoint(stroke, v, 'blur', 1), Math.abs(expected - was) >= 1e-4);
  near(weight(stroke.skin[v], chest), expected, 'full strength: the corners\' average', 2e-5);
  // Even weights stay as they are.
  const flat = await juniper(); flat.weightPaint = {autoNormalize: false};
  const torso = named(flat, 'parts', 'Torso'), bone = named(flat, 'bones', 'Chest').id;
  torso.mesh.verts.forEach((_, u) => setStoredWeights(torso.mesh, u, [[bone, .5]]));
  const even = startStroke(flat, torso, bone); startDab(even);
  assert.equal(torso.mesh.verts.some((_, u) => paintPoint(even, u, 'blur', 1)), false, 'nothing to soften');
});

test('Blur keeps each point adding up to 1 with Auto Normalize, and works on several bones (Multi-Paint)', async () => {
  const model = await juniper(), part = named(model, 'parts', 'Torso');
  const chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id;
  let changed = 0;
  for (const bone of [chest, [chest, spine]]) {
    const stroke = startStroke(model, part, bone);
    startDab(stroke);
    for (let v = 0; v < part.mesh.verts.length; v++) changed += paintPoint(stroke, v, 'blur', 1, {bone});
    for (let v = 0; v < part.mesh.verts.length; v++) near(stroke.skin[v].reduce((t, [, x]) => t + x, 0), 1, `point ${v} sums to 1`, 2e-4);
  }
  assert.ok(changed > 0, 'blur softened something');
});

test('Blur and Smear build up over a stroke, even with Accumulate off', async () => {
  const {model, part, chest} = await ramp(), stroke = startStroke(model, part, chest, {accumulate: false});
  // A point with a neighbour of quite another weight (across the ramp).
  const w = u => weight(stroke.skin[u], chest);
  const v = part.mesh.verts.findIndex((_, u) => pointsAround(stroke, u).some(n => Math.abs(w(n) - w(u)) > .05)), first = w(v);
  const neighbour = pointsAround(stroke, v).find(u => Math.abs(w(u) - first) > .05);
  assert.ok(neighbour !== undefined, 'a neighbour with another weight');
  const target = weight(stroke.skin[neighbour], chest);
  startDab(stroke); paintPoint(stroke, v, 'smear', .5, {from: neighbour});
  const once = weight(stroke.skin[v], chest);
  startDab(stroke); paintPoint(stroke, v, 'smear', .5, {from: neighbour});
  const twice = weight(stroke.skin[v], chest);
  near(once, first + (target - first) * .5, 'one dab: halfway');
  near(twice, first + (target - first) * .75, 'two dabs: three-quarters (it builds up)');
});

test('Smear\'s source is the neighbour behind the point along the stroke, as the view shows them', () => {
  const at = [0, 0, 0], around = [[1, [-1, 0, 0]], [2, [1, 0, 0]], [3, [0, -1, 0]], [4, [-.7, .7, 0]]], toward = [0, 0, 1];
  assert.equal(smearSource(at, around, [1, 0, 0], toward), 1, 'moving right: the neighbour on the left');
  assert.equal(smearSource(at, around, [-1, 0, 0], toward), 2, 'moving left: the neighbour on the right');
  assert.equal(smearSource(at, around, [0, 1, 0], toward), 3, 'moving up: the one below');
  assert.equal(smearSource(at, around, [1, -1, 0], toward), 4, 'moving down-right: the one up-left');
  assert.equal(smearSource(at, around, [0, 0, 0], toward), null, 'no movement yet');
  assert.equal(smearSource(at, around, [0, 0, 1], toward), null, 'moving straight at the viewer moves nothing across the view');
  assert.equal(smearSource(at, [[2, [1, 0, 0]]], [1, 0, 0], toward), null, 'every neighbour ahead: none');
  // Depth doesn't count: a neighbour behind on screen but far off in depth still wins.
  assert.equal(smearSource(at, [[5, [-.2, 0, 9]], [6, [-1, 1, 0]]], [1, 0, 0], toward), 5);
});

test('Smear drags weight from behind, read as the dab found it', async () => {
  const {model, part, chest} = await ramp(), stroke = startStroke(model, part, chest);
  // A chain a ← b ← c in the stroke's direction: b takes a's weight, c takes b's weight from before the dab.
  // Three points whose weights all differ, so each step shows where the weight came from.
  const w = u => weight(stroke.skin[u], chest), apart = (x, y) => Math.abs(w(x) - w(y)) > .02;
  let a, b, c;
  for (let u = 0; u < part.mesh.verts.length && c === undefined; u++) {
    const around = pointsAround(stroke, u), x = around.find(n => apart(n, u)), y = x === undefined ? undefined : around.find(n => apart(n, u) && apart(n, x));
    if (y !== undefined) [a, b, c] = [x, u, y];
  }
  assert.ok(c !== undefined, 'three points with different weights');
  const was = [a, b, c].map(w);
  startDab(stroke);
  paintPoint(stroke, b, 'smear', 1, {from: a});
  paintPoint(stroke, c, 'smear', 1, {from: b});
  near(weight(stroke.skin[b], chest), was[0], 'b takes a\'s weight');
  near(weight(stroke.skin[c], chest), was[1], 'c takes b\'s weight as the dab found it, not a\'s');
  assert.throws(() => paintPoint(stroke, b, 'smear', 1), /Smear needs/);
});

test('Average evens the points under the brush out towards their mean', async () => {
  const {model, part, chest} = await ramp(), stroke = startStroke(model, part, chest);
  const points = part.mesh.verts.map((_, v) => v).filter(v => v % 3 === 0);
  startDab(stroke);
  const mean = dabAverage(points.map(v => [stroke, v, chest]));
  near(mean, points.reduce((t, v) => t + weight(stroke.skin[v], chest), 0) / points.length, 'the mean weight');
  for (const v of points) paintPoint(stroke, v, 'draw', 1, {value: mean});
  for (const v of points) near(weight(stroke.skin[v], chest), mean, `point ${v}`, 2e-5);
  // weightAt reads the dab's copy: the weights from before this dab.
  assert.notEqual(weightAt(stroke, points.find(v => Math.abs(weight(stroke.before.get(v), chest) - mean) > .01), chest), mean);
  assert.equal(dabAverage([]), null, 'nothing under the brush');
});
