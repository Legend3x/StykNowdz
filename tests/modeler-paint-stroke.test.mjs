// The weight paint stroke engine (src/modeler/paint-stroke.mjs) and Accumulate (weight-paint.mjs):
// a stroke paints the same however fast it is drawn and however often the pointer reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pointerSample, spacedDabs, facesViewer} from '../src/modeler/paint-stroke.mjs';
import {readModel} from '../src/modeler/model.mjs';
import {startStroke, paintPoint} from '../src/modeler/weight-paint.mjs';
import {setStoredWeights, storedWeights} from '../src/modeler/weight-manager.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const weight = (pairs, id) => pairs?.find(([b]) => b === id)?.[1] ?? 0;

/** A pointer path from (0, 0) to (200, 60) and back to (40, 100), reported as `events` samples (an even number, so one lands on the corner). */
function path(events) {
  const corners = [[0, 0], [200, 60], [40, 100]], out = [];
  for (let i = 0; i <= events; i++) {
    const t = i / events * 2, k = Math.min(1, Math.floor(t)), f = t - k, a = corners[k], b = corners[k + 1] ?? corners[k];
    out.push({x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, pressure: 1});
  }
  return out;
}
const dabsOf = (samples, spacing) => { const stroke = {}; return samples.flatMap(s => spacedDabs(stroke, s, spacing)); };

test('dabs fall a fixed distance apart along the path, however often the pointer reports', () => {
  const spacing = 15, a = dabsOf(path(30), spacing), b = dabsOf(path(60), spacing), c = dabsOf(path(240), spacing), d = dabsOf(path(6), spacing);
  const length = Math.hypot(200, 60) + Math.hypot(160, 40);
  assert.equal(a.length, Math.floor(length / spacing) + 1, 'one at the start, then one every 15 pixels');
  for (const other of [b, c, d]) {
    assert.equal(other.length, a.length);
    other.forEach((p, i) => assert.ok(Math.hypot(p.x - a[i].x, p.y - a[i].y) < 1e-6, `dab ${i}`));
  }
  // Tiny moves add up: 100 moves of 0.3 pixels make 2 dabs (after the first), not 100.
  const stroke = {}, tiny = [];
  for (let i = 0; i <= 100; i++) tiny.push(...spacedDabs(stroke, {x: i * .3, y: 0, pressure: 1}, 15));
  assert.equal(tiny.length, 3);
});

test('pressure: a pen\'s is blended along the way; a mouse counts as full pressure', () => {
  assert.equal(pointerSample({x: 1, y: 2}, {pointerType: 'mouse', pressure: .5}).pressure, 1, 'browsers report 0.5 for a pressed mouse button');
  assert.equal(pointerSample({x: 1, y: 2}, {pointerType: 'touch', pressure: .3}).pressure, 1);
  assert.equal(pointerSample({x: 1, y: 2}, {pointerType: 'pen', pressure: .25}).pressure, .25);
  assert.equal(pointerSample({x: 1, y: 2}, {pointerType: 'pen', pressure: 7}).pressure, 1);
  const stroke = {};
  spacedDabs(stroke, {x: 0, y: 0, pressure: 0}, 10);
  const dabs = spacedDabs(stroke, {x: 40, y: 0, pressure: 1}, 10);
  assert.deepEqual(dabs.map(d => d.pressure), [.25, .5, .75, 1]);
});

test('Front Faces Only: a point counts when its surface turns towards the viewer', () => {
  assert.equal(facesViewer([0, 0, 1], [0, 0, 1]), true);
  assert.equal(facesViewer([0, 0, -1], [0, 0, 1]), false);
  assert.equal(facesViewer([1, 0, 0], [0, 0, 1]), false, 'edge-on is not facing');
  assert.equal(facesViewer([0, 0, 0], [0, 0, 1]), true, 'no normal: painted');
});

test('Accumulate off: going over a point again adds nothing unless the dab is stronger', async () => {
  const model = await juniper(), part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id;
  setStoredWeights(part.mesh, 0, [[chest, .2], [spine, .8]]);
  setStoredWeights(part.mesh, 1, [[chest, .2], [spine, .8]]);
  const off = startStroke(model, part, chest, {accumulate: false}), on = startStroke(model, part, chest);
  for (let i = 0; i < 10; i++) { paintPoint(off, 0, 'add', .5); paintPoint(on, 1, 'add', .5); }
  assert.ok(Math.abs(weight(storedWeights(part.mesh, 0), chest) - .6) < 1e-4, 'off: halfway from 0.2 to 1, once');
  assert.ok(weight(storedWeights(part.mesh, 1), chest) > .99, 'on: ten dabs build up');
  // A stronger dab later in the same stroke goes further, still from where the stroke began.
  assert.equal(paintPoint(off, 0, 'add', .3), false);
  paintPoint(off, 0, 'add', .75);
  assert.ok(Math.abs(weight(storedWeights(part.mesh, 0), chest) - .8) < 1e-4);
  // A new stroke starts again from where the point is.
  paintPoint(startStroke(model, part, chest, {accumulate: false}), 0, 'add', .5);
  assert.ok(Math.abs(weight(storedWeights(part.mesh, 0), chest) - .9) < 1e-4);
});

test('a stroke keeps each point\'s weights from before it changed them, for its undo step', async () => {
  const model = await juniper(), part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id;
  setStoredWeights(part.mesh, 0, [[chest, .2], [spine, .8]]);
  const stroke = startStroke(model, part, chest);
  paintPoint(stroke, 0, 'add', .5); paintPoint(stroke, 0, 'add', .5); paintPoint(stroke, 1, 'add', .5);
  assert.deepEqual(stroke.before.get(0), [[chest, .2], [spine, .8]], 'the first change\'s, not a later one');
  assert.equal(stroke.before.get(1), null, 'it had none: automatic');
  assert.equal(stroke.before.size, 2);
});

/** Paint Juniper's torso along a path as the brush does: points seen from the front (x, y), a
 * 40-pixel brush with Smooth falloff, Strength 0.5, Add. Returns every point's Chest weight. */
async function brushStroke(samples, {accumulate, dabsPerEvent = false}) {
  const model = await juniper(), part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id;
  const stroke = startStroke(model, part, chest, {accumulate}), screen = part.mesh.verts.map(([x, y]) => ({x: 300 + x * 400, y: 300 - y * 400})), dragged = {};
  const dab = (d, radius = 40) => screen.forEach((p, v) => { const t = Math.hypot(p.x - d.x, p.y - d.y) / radius; if (t <= 1) paintPoint(stroke, v, 'add', .5 * (1 - t * t) ** 2); });
  for (const s of samples) {
    // The old way, for comparison: at least one dab every pointer move.
    if (dabsPerEvent) { dab(s); continue; }
    for (const d of spacedDabs(dragged, s, 10)) dab(d);
  }
  return part.mesh.verts.map((_, v) => weight(storedWeights(part.mesh, v), chest));
}

test('the same brush stroke paints the same weights at 30, 60 or 240 pointer events', async () => {
  const across = n => path(n).map(p => ({x: 160 + p.x, y: 200 + p.y * .4, pressure: 1}));
  for (const accumulate of [false, true]) {
    const a = await brushStroke(across(30), {accumulate}), b = await brushStroke(across(60), {accumulate}), c = await brushStroke(across(240), {accumulate});
    assert.ok(a.some(w => w > .1), 'the stroke reached the torso');
    for (const other of [b, c]) other.forEach((w, v) => assert.ok(Math.abs(w - a[v]) < 1e-4, `Accumulate ${accumulate}, point ${v}: ${w} vs ${a[v]}`));
  }
  // Before: one dab per pointer move, so more pointer events painted harder.
  const slow = await brushStroke(across(240), {accumulate: true, dabsPerEvent: true}), quick = await brushStroke(across(30), {accumulate: true, dabsPerEvent: true});
  assert.ok(slow.reduce((t, w) => t + w, 0) > quick.reduce((t, w) => t + w, 0) * 1.2, 'the old way depended on the pointer');
});
