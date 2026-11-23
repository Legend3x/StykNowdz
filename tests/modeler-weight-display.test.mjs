// Weight colours as Blender's Weight Paint shows them (src/modeler/weight-display.mjs): the weight
// blended from point to point, then coloured per pixel with Blender's ramp.
import test from 'node:test';
import assert from 'node:assert/strict';
import {weightRgb, RAMP_STOPS, GRADIENT_STOPS, RAMP_WIDTH, rampPixels, weightUv, gradientLine, fillWeightPolygon} from '../src/modeler/weight-display.mjs';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {partWeights, groupWeights} from '../src/modeler/armature.mjs';
import {setStoredWeights} from '../src/modeler/weight-manager.mjs';
import {startStroke, paintPoint} from '../src/modeler/weight-paint.mjs';

const juniper = async () => readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const named = (model, kind, name) => model[kind].find(x => x.name === name);

test('Blender\'s weight ramp: dark blue, cyan, green, yellow, red, brighter as the weight rises', () => {
  assert.deepEqual(weightRgb(0), [0, 0, 128]);
  assert.deepEqual(weightRgb(.25), [0, 159, 159]);
  assert.deepEqual(weightRgb(.5), [0, 191, 0]);
  assert.deepEqual(weightRgb(.75), [223, 223, 0]);
  assert.deepEqual(weightRgb(1), [255, 0, 0]);
  assert.deepEqual(weightRgb(-1), weightRgb(0));
  assert.deepEqual(weightRgb(7), weightRgb(1));
  assert.deepEqual(weightRgb(NaN), weightRgb(0));
  assert.deepEqual(RAMP_STOPS, [0, .25, .5, .75, 1]);
});

test('a gradient through the canvas stops matches the ramp everywhere (within rounding)', () => {
  // Unrounded ramp, to measure the straight-line error itself.
  const raw = w => { const b = w / 2 + .5; return (w <= .25 ? [0, b * w * 4, b] : w <= .5 ? [0, b, b * (1 - (w - .25) * 4)] : w <= .75 ? [b * (w - .5) * 4, b, 0] : [b, b * (1 - (w - .75) * 4), 0]).map(v => v * 255); };
  let worst = 0;
  for (let i = 0; i + 1 < GRADIENT_STOPS.length; i++) {
    const a = GRADIENT_STOPS[i], b = GRADIENT_STOPS[i + 1];
    for (let t = 0; t <= 1; t += .05) {
      const exact = raw(a + (b - a) * t), between = raw(a).map((v, k) => v + (raw(b)[k] - v) * t);
      exact.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - between[k])); });
    }
  }
  assert.ok(worst < .51, `straight lines between stops stay within ${worst} of 255`);
  // Five stops would not do: the ramp curves between its colours.
  const mid = raw(.125), five = raw(0).map((v, k) => (v + raw(.25)[k]) / 2);
  assert.ok(Math.abs(mid[1] - five[1]) > 3);
});

test('the WebGL ramp texture: black row, colour row, one texel per weight step', () => {
  const px = rampPixels();
  assert.equal(px.length, RAMP_WIDTH * 2 * 4);
  for (const i of [0, 100, 255]) {
    assert.deepEqual([...px.slice(i * 4, i * 4 + 4)], [0, 0, 0, 255], 'row 0 is black');
    assert.deepEqual([...px.slice((RAMP_WIDTH + i) * 4, (RAMP_WIDTH + i) * 4 + 3)], weightRgb(i / 255), 'row 1 is the ramp');
  }
  // u lands on the texel centre for the weight; v picks the row (the shader samples 1 − v).
  const [u0] = weightUv(0), [u1] = weightUv(1), [uh] = weightUv(.5);
  assert.equal(u0, .5 / RAMP_WIDTH);
  assert.equal(u1, (RAMP_WIDTH - .5) / RAMP_WIDTH);
  assert.ok(u1 < 1, 'a weight of 1 never wraps round to blue');
  assert.ok(Math.abs(uh - .5) < 1 / RAMP_WIDTH);
  assert.equal(weightUv(.3)[1], .25);
  assert.equal(weightUv(.3, true)[1], .75);
});

test('the canvas gradient puts 0 and 1 where the blended weight is 0 and 1', () => {
  const tri = [{x: 0, y: 0}, {x: 100, y: 0}, {x: 0, y: 50}], ws = [0, 1, .5];
  const {from, to} = gradientLine(tri, ws);
  // The weight blended across the triangle: w(x, y) = x / 100 + y / 100.
  const w = (x, y) => x / 100 + y / 100;
  assert.ok(Math.abs(w(...from)) < 1e-12 && Math.abs(w(...to) - 1) < 1e-12);
  // The gradient runs the way the weight rises fastest (perpendicular to its contour lines).
  const d = [to[0] - from[0], to[1] - from[1]];
  assert.ok(Math.abs(d[0] - d[1]) < 1e-12);
  assert.equal(gradientLine(tri, [.4, .4, .4]), null, 'an even weight is one colour');
  assert.equal(gradientLine([{x: 0, y: 0}, {x: 1, y: 1}, {x: 2, y: 2}], ws), null, 'a triangle with no area');
});

test('fillWeightPolygon: one gradient through the ramp per triangle, black faded in where there is no weight', () => {
  const calls = [], gradients = [];
  const ctx = {
    createLinearGradient: (...line) => { const g = {line, stops: [], addColorStop: (o, c) => g.stops.push([o, c])}; gradients.push(g); return g; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { calls.push(['fill', this.fillStyle]); }, stroke() { calls.push(['stroke', this.strokeStyle]); },
  };
  const quad = [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}];
  fillWeightPolygon(ctx, quad, [0, 1, 1, 0], 1, [1, 0, 0, 1]);
  const ramps = gradients.filter(g => g.stops.length === GRADIENT_STOPS.length), fades = gradients.filter(g => g.stops.length === 2);
  assert.equal(ramps.length, 2, 'a quad is two triangles');
  assert.deepEqual(ramps[0].stops, GRADIENT_STOPS.map(s => [s, `rgb(${weightRgb(s).join(',')})`]));
  assert.equal(fades.length, 2);
  assert.deepEqual(fades[0].stops, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,1)']]);
  assert.equal(calls.filter(([k]) => k === 'stroke').length, 2, 'colours are seamed, the black overlay is not');
  // Lighting darkens the stops; without zero weights there is no black overlay.
  gradients.length = 0; calls.length = 0;
  fillWeightPolygon(ctx, quad.slice(0, 3), [0, 1, 1], .5, null);
  assert.equal(gradients.length, 1);
  assert.equal(gradients[0].stops.at(-1)[1], 'rgb(128,0,0)');
});

test('groupWeights shows the weights deformation uses wherever a point has four bones or fewer', async () => {
  const model = await juniper();
  for (const part of model.parts.filter(p => ['Torso', 'Thigh', 'Arm'].includes(p.name))) {
    const mesh = evaluatePart(part), skin = partWeights(model, mesh, part);
    for (const bone of model.bones) {
      const shown = groupWeights(model, mesh, part, bone.id);
      for (let v = 0; v < mesh.verts.length; v++) {
        let w = 0; for (let k = 0; k < 4; k++) if (skin.bones[v * 4 + k] === bone.id) w += skin.weights[v * 4 + k];
        assert.ok(Math.abs(shown[v] - w) < 1e-9, `${part.name} ${bone.name} point ${v}: ${shown[v]} vs ${w}`);
      }
    }
  }
});

test('groupWeights shows a bone\'s stored weight even where a point has more than four bones', async () => {
  const model = await juniper(), torso = named(model, 'parts', 'Torso');
  const ids = ['Chest', 'Spine', 'Shoulder.L', 'Shoulder.R', 'Neck', 'Hips'].map(n => named(model, 'bones', n).id);
  // Six bones on every point of the torso, so smoothing doesn't blend in automatic weights.
  for (let v = 0; v < torso.mesh.verts.length; v++) setStoredWeights(torso.mesh, v, ids.map((id, k) => [id, [.3, .25, .15, .12, .1, .08][k]]));
  const mesh = evaluatePart(torso), hips = groupWeights(model, mesh, torso, ids[5]), skin = partWeights(model, mesh, torso);
  for (let v = 0; v < mesh.verts.length; v++) {
    assert.ok(Math.abs(hips[v] - .08) < 1e-9, `the sixth bone shows its own 0.08 (${hips[v]})`);
    assert.ok(![0, 1, 2, 3].some(k => skin.bones[v * 4 + k] === ids[5]), 'deformation still leaves it out');
  }
});

test('groupWeights follows painting and Mirror parts', async () => {
  const model = await juniper(), thigh = named(model, 'parts', 'Thigh'), left = named(model, 'bones', 'Thigh.L'), right = named(model, 'bones', 'Thigh.R');
  // The Thigh part is a Mirror part: its copy is moved by Thigh.R.
  const mesh = evaluatePart(thigh), before = [left, right].map(b => Math.max(...groupWeights(model, mesh, thigh, b.id)));
  assert.ok(before.every(w => w > .5), `both thigh bones move their half (${before})`);
  const stroke = startStroke(model, thigh, left.id);
  for (let v = 0; v < thigh.mesh.verts.length; v++) paintPoint(stroke, v, 'remove', 1);
  const after = [left, right].map(b => Math.max(...groupWeights(model, evaluatePart(thigh), thigh, b.id)));
  assert.ok(after[0] < before[0], 'painting Thigh.L off shows');
  assert.ok(after[1] < before[1], 'and its mirrored copy shows Thigh.R painted off too');
});
