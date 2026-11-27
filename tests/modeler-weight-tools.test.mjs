// Blender's Weights menu and Weight Gradient as plain functions (src/modeler/weight-tools.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readModel} from '../src/modeler/model.mjs';
import {completeSkin} from '../src/modeler/armature.mjs';
import {objectTransform} from '../src/modeler/mesh.mjs';
import {mirrorBone} from '../src/modeler/weight-paint.mjs';
import {gradientFactor, gradientWeight, invertWeight, levelsWeight, quantizeWeight, cleanPairs, mirroredPairs, mirrorPartners, mirrorTakes, GRADIENT_TYPES, MIRROR_WAYS} from '../src/modeler/weight-tools.mjs';

const near = (a, b, why, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${why}: ${a} is not ${b}`);
const weight = (pairs, id) => pairs?.find(([b]) => b === id)?.[1] ?? 0;
const sum = pairs => pairs.reduce((t, [, w]) => t + w, 0);

test('Gradient: where a point lies, along the line (Linear) or out from its start (Radial)', () => {
  assert.deepEqual([...GRADIENT_TYPES], ['linear', 'radial']);
  const a = {x: 0, y: 0}, b = {x: 100, y: 0};
  near(gradientFactor('linear', {x: 50, y: 30}, a, b), .5, 'linear: halfway along, whatever the side');
  near(gradientFactor('linear', {x: -20, y: 0}, a, b), -.2, 'linear: behind the start');
  near(gradientFactor('radial', {x: 30, y: 40}, a, b), .5, 'radial: 50 away out of 100');
  near(gradientFactor('radial', {x: 0, y: -100}, a, b), 1, 'radial: any direction');
  assert.equal(gradientFactor('linear', {x: 1, y: 1}, a, a), null, 'no line');
  assert.throws(() => gradientFactor('spiral', a, a, b), /Unknown gradient type/);
});

test('Gradient: all Amount at the start, the point\'s own weight at the end, no seam', () => {
  const linear = x => 1 - x;
  near(gradientWeight(.2, 0, .9, {falloff: linear}), .9, 'start: Amount');
  near(gradientWeight(.2, -3, .9, {falloff: linear}), .9, 'behind the start: Amount');
  near(gradientWeight(.2, .5, .9, {falloff: linear}), .55, 'halfway: halfway to Amount');
  assert.equal(gradientWeight(.2, 1, .9), null, 'the end: kept');
  assert.equal(gradientWeight(.2, 1.4, .9), null, 'past the end: kept');
  assert.equal(gradientWeight(.2, null, .9), null, 'no line: kept');
  // Just before the end the weight is all but the point's own: no jump where the gradient stops.
  near(gradientWeight(.2, .999, .9, {falloff: linear}), .2, 'just before the end', 1e-3);
  near(gradientWeight(.2, .5, .9, {strength: .5, falloff: linear}), .375, 'Strength scales the mix');
  // Shaped by a falloff: smooth stays near Amount longer than linear.
  const smooth = x => (1 - x * x) ** 2;
  assert.ok(gradientWeight(0, .3, 1, {falloff: smooth}) > gradientWeight(0, .3, 1, {falloff: linear}));
});

test('Invert, Levels and Quantize, kept within 0 to 1', () => {
  near(invertWeight(.2), .8, 'invert'); near(invertWeight(0), 1, 'invert none'); near(invertWeight(1), 0, 'invert all');
  near(levelsWeight(.3), .3, 'levels as is');
  near(levelsWeight(.3, {offset: .1, gain: 2}), .8, 'Gain × (weight + Offset)');
  near(levelsWeight(.3, {offset: -.5}), 0, 'below 0 stops at 0');
  near(levelsWeight(.6, {gain: 3}), 1, 'above 1 stops at 1');
  near(quantizeWeight(.1), 0, 'quantize .1 to 4 steps'); near(quantizeWeight(.13), .25, '.13');
  near(quantizeWeight(.125), .25, 'a half rounds up'); near(quantizeWeight(.62), .5, '.62'); near(quantizeWeight(.9), 1, '.9');
  near(quantizeWeight(.4, 1), 0, 'one step: 0 or 1'); near(quantizeWeight(.5, 1), 1, 'one step, a half');
  near(quantizeWeight(.33, 10), .3, 'ten steps');
});

test('Clean: weights at or below Limit leave, locked bones stay, Keep single and closing up', () => {
  const pairs = [[1, .6], [2, .38], [3, .02]];
  assert.equal(cleanPairs(pairs, {limit: .01}), pairs, 'nothing at or below: the same list');
  assert.deepEqual(cleanPairs(pairs, {limit: .02}), [[1, .6], [2, .38]], 'at the limit goes too');
  assert.deepEqual(cleanPairs(pairs, {limit: .05, locked: new Set([3])}), pairs, 'a locked bone stays');
  const closed = cleanPairs(pairs, {limit: .05, normalize: true});
  near(sum(closed), 1, 'Auto Normalize: they still add up to 1');
  near(weight(closed, 1) / weight(closed, 2), .6 / .38, 'the rest keep their shares');
  const locked = cleanPairs([[1, .5], [2, .45], [3, .05]], {limit: .1, normalize: true, locked: new Set([1])});
  near(weight(locked, 1), .5, 'locked stays'); near(weight(locked, 2), .5, 'the free share closes up');
  assert.deepEqual(cleanPairs([[1, .01], [2, .03]], {limit: .05}), [], 'all go');
  assert.deepEqual(cleanPairs([[1, .01], [2, .03]], {limit: .05, keepSingle: true}), [[2, .03]], 'Keep single: the largest stays');
});

test('Mirror: partners found by position, bones swapped by side, which points take', () => {
  const flip = b => ({1: 2, 2: 1})[b] ?? b;
  assert.deepEqual(mirroredPairs([[1, .7], [3, .3]], flip), [[2, .7], [3, .3]]);
  assert.deepEqual(mirroredPairs([[1, .4], [2, .6]], flip), [[2, .4], [1, .6]], 'both sides exchange');
  const points = [{key: 'a', at: [1, 2, 0]}, {key: 'b', at: [-1.0004, 2, 0]}, {key: 'c', at: [0, 1, 1]}, {key: 'd', at: [3, 0, 0]}];
  const partners = mirrorPartners(points, .001);
  assert.equal(partners.get('a'), 'b'); assert.equal(partners.get('b'), 'a');
  assert.equal(partners.get('c'), 'c', 'a point on the middle is its own');
  assert.equal(partners.has('d'), false, 'no point at its mirror image');
  assert.deepEqual([...MIRROR_WAYS], ['swap', 'leftToRight', 'rightToLeft']);
  assert.deepEqual([1, 0, -1].map(x => mirrorTakes('leftToRight', x, .01)), [false, false, true], 'left (+X) onto right');
  assert.deepEqual([1, 0, -1].map(x => mirrorTakes('rightToLeft', x, .01)), [true, false, false]);
  assert.deepEqual([1, 0, -1].map(x => mirrorTakes('swap', x, .01)), [true, true, true]);
});

test('Mirror on Juniper\'s torso: Swap sides twice is where it began; Left → Right leaves both sides matching', async () => {
  const model = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  const torso = model.parts.find(q => q.name === 'Torso'), to = objectTransform(torso);
  const flip = id => mirrorBone(model, id), skin = completeSkin(model, torso);
  // Make it lopsided: the left side (+X) leans on Shoulder.L.
  const shoulder = model.bones.find(b => b.name === 'Shoulder.L').id;
  const points = torso.mesh.verts.map((v, i) => ({key: i, at: to(v)}));
  const lean = pairs => { const out = new Map(pairs.map(([b, w]) => [b, w * .5])); out.set(shoulder, (out.get(shoulder) ?? 0) + .5); return [...out]; };
  const lopsided = points.map(p => (p.at[0] > .01 ? lean(skin[p.key] ?? []) : skin[p.key] ?? []));
  const partners = mirrorPartners(points, 1e-3);
  assert.ok(partners.size >= points.length * .9, `most torso points have a mirror image (${partners.size}/${points.length})`);
  const apply = (weights, way) => points.map(p => (partners.has(p.key) && mirrorTakes(way, p.at[0], 1e-3) ? mirroredPairs(weights[partners.get(p.key)], flip) : weights[p.key]));
  const twice = apply(apply(lopsided, 'swap'), 'swap');
  for (const p of points) for (const [b, w] of lopsided[p.key]) near(weight(twice[p.key], b), w, `point ${p.key}`, 1e-12);
  const copied = apply(lopsided, 'leftToRight');
  for (const p of points) {
    if (!partners.has(p.key)) continue;
    const o = partners.get(p.key);
    for (const [b, w] of copied[p.key]) near(weight(copied[o], flip(b)), w, `point ${p.key} matches ${o}`, 1e-12);
    if (p.at[0] < -1e-3) near(sum(copied[p.key]), sum(lopsided[o]), 'a copied point adds up to what its source did', 1e-12);
  }
  const right = points.filter(p => p.at[0] < -.01 && partners.has(p.key));
  assert.ok(right.length && right.every(p => weight(copied[p.key], flip(shoulder)) >= .5), 'the right side now leans on Shoulder.R');
});
