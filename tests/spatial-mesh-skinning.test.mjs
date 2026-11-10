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
