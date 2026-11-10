// Stage mesh skinning (spatial-mesh.mjs blendedVertex) must move every vertex
// exactly as rig-spatial's skinPoint moves a skinned joint: dual-quaternion
// skinning with each bone's shape, choice scale and stretch blended in bind space.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spatialMeshPlan, evaluateSpatialMesh} from '../src/spatial-mesh.mjs';
import {evaluateSpatial, quatMultiply, spatialQuaternion} from '../src/rig-spatial.mjs';

const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} ≉ ${b}`);

function frame(random, {stretch = 1, choiceScale, shape} = {}) {
  const q = spatialQuaternion(random() * 6, random() * 6, random() * 6), t = [random() * 30, random() * 40, random() * 50];
  return {q, t, dual: quatMultiply([...t, 0], q).map(v => v / 2), axis: [0, 1, 0], origin: [0, 20, 0], stretch, restLength: 40,
    ...(choiceScale === undefined ? {} : {choiceScale}), ...(shape ? {shape} : {})};
}

test('mesh vertices skin exactly like skinned joints, with stretch, scale and shape', () => {
  let seed = 991; const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  for (let sample = 0; sample < 120; sample++) {
    const kind = sample % 4;
    const frames = [frame(random, kind === 1 ? {stretch: 1.6} : {}), frame(random, kind === 1 ? {stretch: .7} : kind === 2 ? {choiceScale: 1.3} : kind === 3 ? {shape: {width: 1.4, taper: -.3}} : {})];
    const weight = .2 + random() * .6, points = [[random() * 20, random() * 40, random() * 10], [random() * 20, 5 + random() * 40, random() * 10], [random() * 20, 10 + random() * 40, 5 + random() * 10]];
    const mesh = {positions: points.flat(), bones: points.flatMap(() => [11, 12, 0, 0]), weights: points.flatMap(() => [weight, 1 - weight, 0, 0]),
      indices: [0, 1, 2], materials: [0], colors: [[200, 100, 50]], basis: [0, 13, 14]};
    const plan = spatialMeshPlan({_styk: {spatialMesh: mesh}}, new Map([[11, 0], [12, 1]]));
    const result = evaluateSpatialMesh(plan, frames, {root: {x: 0, y: 0}, scale: 1, figureAngle: 0, mirror: false, camera: null, joints: new Map(), colorOf: c => c, slot: 0}, null);
    points.forEach((point, v) => {
      const joint = evaluateSpatial({point, bindings: [{joint: 1, weight}, {joint: 2, weight: 1 - weight}]},
        {segment: {angle_rad: 0}, input: {start: {x: 0, y: 0}, angle: 0}, get: id => ({spatial: frames[id - 1]}), root: {x: 0, y: 0}, scale: 1, figureAngle: 0, mirror: false});
      near(result.positions[v * 2], joint.handle.x, 1e-3); near(result.positions[v * 2 + 1], joint.handle.y, 1e-3);
    });
  }
});

test('blending matches the fully normalised dual quaternion, even for extreme twists', () => {
  // A unit dual quaternion also has its dual part made orthogonal to the real
  // part: d' = (d − r̂(r̂·d)) / |r|. blendedVertex only divides by |r|; the part it
  // skips lies along r̂ and adds nothing to the translation (the vector part of
  // 2·d·r̂*), so both give the same point. Checked here on near-opposite twists.
  let seed = 4242; const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  for (let sample = 0; sample < 200; sample++) {
    const twist = Math.PI * (.9 + random() * .099), axis = [random() - .5, random() - .5, random() - .5], l = Math.hypot(...axis);
    const q1 = [0, 0, 0, 1], q2 = [...axis.map(a => a / l * Math.sin(twist / 2)), Math.cos(twist / 2)];
    const frames = [q1, q2].map((q, k) => { const t = [k * 30, 40 + k * 10, random() * 20]; return {q, t, dual: quatMultiply([...t, 0], q).map(v => v / 2), axis: [0, 1, 0], origin: [0, 0, 0], stretch: 1 + random()}; });
    const weight = .3 + random() * .4, point = [random() * 20, random() * 40, random() * 20];
    const mesh = {positions: [...point, point[0] + 1, point[1], point[2], point[0], point[1] + 1, point[2]], bones: Array(3).fill([11, 12, 0, 0]).flat(), weights: Array(3).fill([weight, 1 - weight, 0, 0]).flat(),
      indices: [0, 1, 2], materials: [0], colors: [[1, 2, 3]], basis: [0, 13, 14]};
    const result = evaluateSpatialMesh(spatialMeshPlan({_styk: {spatialMesh: mesh}}, new Map([[11, 0], [12, 1]])), frames, {root: {x: 0, y: 0}, scale: 1, figureAngle: 0, mirror: false, camera: null, joints: new Map(), colorOf: c => c, slot: 0}, null);
    // Reference: stretch blended in bind space, then the fully normalised dual quaternion.
    const moved = point.slice(); for (const [f, w] of [[frames[0], weight], [frames[1], 1 - weight]]) moved[1] += point[1] * (f.stretch - 1) * w;
    const sgn = q2.reduce((s, v, i) => s + v * q1[i], 0) < 0 ? -1 : 1, r = [0, 1, 2, 3].map(i => q1[i] * weight + q2[i] * (1 - weight) * sgn), d = [0, 1, 2, 3].map(i => frames[0].dual[i] * weight + frames[1].dual[i] * (1 - weight) * sgn);
    const n = Math.hypot(...r), rh = r.map(v => v / n), dot = rh.reduce((s, v, i) => s + v * d[i], 0), dh = d.map((v, i) => (v - rh[i] * dot) / n);
    const t = quatMultiply(dh, [-rh[0], -rh[1], -rh[2], rh[3]]).slice(0, 3).map(v => 2 * v);
    const [x, y, z, w] = rh, [a, b, c] = moved, tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
    near(result.positions[0], a + w * tx + y * tz - z * ty + t[0], 1e-3); near(result.positions[1], b + w * ty + z * tx - x * tz + t[1], 1e-3);
  }
});
