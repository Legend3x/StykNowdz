// The Draw brush's blend modes (src/modeler/weight-paint.mjs): Blender's Mix, Add, Subtract, Lighten,
// Darken and Multiply, with the old Add, Remove and Set tools as presets of Draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel} from '../src/modeler/model.mjs';
import {startStroke, paintPoint, blendWeight, brushOf, invertedBrush, BLENDS} from '../src/modeler/weight-paint.mjs';
import {setStoredWeights} from '../src/modeler/weight-manager.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);
const weight = (pairs, id) => pairs?.find(([b]) => b === id)?.[1] ?? 0;
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-4, `${why}: ${a} is not ${b}`);

// Blender's own formulas (source/blender/editors/sculpt_paint/paint_weight.cc, wval_*), written out separately.
const BLENDER = {
  mix: (w, p, a) => p * a + w * (1 - a),
  add: (w, p, a) => w + p * a,
  subtract: (w, p, a) => w - p * a,
  lighten: (w, p, a) => (w < p ? p * a + w * (1 - a) : w),
  darken: (w, p, a) => (w > p ? p * a + w * (1 - a) : w),
  multiply: (w, p, a) => ((1 - a) + a * p) * w,
};

test('each blend gives Blender\'s result for a weight, Amount and dab strength', () => {
  assert.deepEqual([...BLENDS], Object.keys(BLENDER), 'the Blend menu has Blender\'s six, in its order');
  for (const blend of BLENDS) for (const w of [0, .1, .4, .75, 1]) for (const p of [0, .3, .5, 1]) for (const a of [0, .25, .6, 1])
    near(blendWeight(blend, w, p, a), BLENDER[blend](w, p, a), `${blend} w=${w} amount=${p} alpha=${a}`);
  assert.throws(() => blendWeight('screen', .5, .5, .5), /Unknown blend/);
  assert.throws(() => brushOf('draw', .5, 'overlay'), /Unknown blend/);
  assert.throws(() => brushOf('blur'), /Unknown paint mode/);
});

test('Add, Remove and Set are Draw with Mix at 1, 0 and the Amount: the same weights everywhere', async () => {
  for (const autoNormalize of [true, false]) for (const [preset, value] of [['add', 1], ['remove', 0], ['set', .35]]) {
    const a = await juniper(), b = await juniper();
    for (const m of [a, b]) if (!autoNormalize) m.weightPaint = {autoNormalize: false};
    const part = m => named(m, 'parts', 'Torso'), bone = m => named(m, 'bones', 'Chest').id;
    const sa = startStroke(a, part(a), bone(a)), sb = startStroke(b, part(b), bone(b));
    let changed = 0;
    for (let v = 0; v < part(a).mesh.verts.length; v++) {
      const amount = (v % 7 + 1) / 8;
      const x = paintPoint(sa, v, preset, amount, {value: .35}), y = paintPoint(sb, v, 'draw', amount, {value, blend: 'mix'});
      assert.equal(x, y, `${preset} point ${v} changed the same`);
      changed += x;
    }
    assert.ok(changed > 0, `${preset} painted something`);
    assert.deepEqual(sb.skin, sa.skin, `${preset}, Auto Normalize ${autoNormalize}: identical weights`);
  }
});

test('Auto Normalize off: each blend changes only the bone\'s own weight, kept within 0 to 1', async () => {
  const cases = [
    ['mix', .8, .5, .6], ['add', .3, .5, .55], ['subtract', .3, 1, .1], ['lighten', .2, 1, .4], ['lighten', .8, .5, .6],
    ['darken', .8, 1, .4], ['darken', .2, .5, .3], ['multiply', .5, 1, .2], ['add', 1, 1, 1], ['subtract', 1, 1, 0],
  ];
  for (const [blend, value, alpha, expect] of cases) {
    const model = await juniper(); model.weightPaint = {autoNormalize: false};
    const part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id;
    setStoredWeights(part.mesh, 0, [[chest, .4], [spine, .6]]);
    const stroke = startStroke(model, part, chest);
    const changed = paintPoint(stroke, 0, 'draw', alpha, {value, blend});
    near(weight(stroke.skin[0], chest), expect, `${blend} ${value} at ${alpha}`);
    assert.equal(changed, Math.abs(expect - .4) > 1e-4, `${blend} ${value}: reports whether it changed`);
    near(weight(stroke.skin[0], spine), .6, `${blend}: the other bone keeps its weight`);
  }
});

test('Auto Normalize on: every blend keeps the point adding up to 1', async () => {
  for (const blend of BLENDS) {
    const model = await juniper(), part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id;
    setStoredWeights(part.mesh, 0, [[chest, .2], [spine, .8]]);
    const stroke = startStroke(model, part, chest);
    paintPoint(stroke, 0, 'draw', 1, {value: .5, blend});
    const sum = stroke.skin[0].reduce((t, [, x]) => t + x, 0);
    near(sum, 1, `${blend}: sum`);
    near(weight(stroke.skin[0], chest), {mix: .5, add: .7, subtract: 0, lighten: .5, darken: .2, multiply: .1}[blend], `${blend}: Chest`);
  }
});

test('Accumulate off: Add adds once per stroke at a point, however often the brush passes', async () => {
  for (const accumulate of [false, true]) {
    const model = await juniper(); model.weightPaint = {autoNormalize: false};
    const part = named(model, 'parts', 'Torso'), chest = named(model, 'bones', 'Chest').id;
    setStoredWeights(part.mesh, 0, [[chest, .1]]);
    const stroke = startStroke(model, part, chest, {accumulate});
    for (let i = 0; i < 3; i++) paintPoint(stroke, 0, 'draw', .5, {value: .2, blend: 'add'});
    near(weight(stroke.skin[0], chest), accumulate ? .4 : .2, `Accumulate ${accumulate}`);
    // A stronger dab still reaches further, from where the stroke found the point.
    paintPoint(stroke, 0, 'draw', 1, {value: .2, blend: 'add'});
    near(weight(stroke.skin[0], chest), accumulate ? .6 : .3, `Accumulate ${accumulate}, stronger dab`);
  }
});

test('Multi-Paint: Multiply scales the bones together, keeping their share', async () => {
  const model = await juniper(), part = named(model, 'parts', 'Torso');
  const chest = named(model, 'bones', 'Chest').id, spine = named(model, 'bones', 'Spine').id, neck = named(model, 'bones', 'Neck').id;
  setStoredWeights(part.mesh, 0, [[chest, .3], [spine, .3], [neck, .4]]);
  const stroke = startStroke(model, part, [chest, spine]);
  assert.ok(paintPoint(stroke, 0, 'draw', 1, {bone: [chest, spine], value: .5, blend: 'multiply'}));
  near(weight(stroke.skin[0], chest), .15, 'Chest halved');
  near(weight(stroke.skin[0], spine), .15, 'Spine halved');
  near(weight(stroke.skin[0], neck), .7, 'Neck takes the rest');
});

test('Ctrl paints the opposite: Mix to 1 − Amount, Lighten and Darken swap, Add and Subtract swap', () => {
  assert.deepEqual(invertedBrush({blend: 'mix', value: 1}), {blend: 'mix', value: 0}, 'Add preset → Remove');
  assert.deepEqual(invertedBrush({blend: 'mix', value: 0}), {blend: 'mix', value: 1}, 'Remove preset → Add');
  near(invertedBrush({blend: 'mix', value: .8}).value, .2, 'Set .8 → .2');
  assert.deepEqual(invertedBrush({blend: 'lighten', value: .75}), {blend: 'darken', value: .25});
  assert.deepEqual(invertedBrush({blend: 'darken', value: .25}), {blend: 'lighten', value: .75});
  assert.deepEqual(invertedBrush({blend: 'add', value: .3}), {blend: 'subtract', value: .3});
  assert.deepEqual(invertedBrush({blend: 'subtract', value: .3}), {blend: 'add', value: .3});
  assert.deepEqual(invertedBrush({blend: 'multiply', value: .5}), {blend: 'multiply', value: .5});
  for (const blend of BLENDS) {
    const back = invertedBrush(invertedBrush({blend, value: .4}));
    assert.equal(back.blend, blend); near(back.value, .4, `${blend} twice is itself`);
  }
});
