// The 3D Nowdz viewport draws faces through a depth buffer (depth-pass.mjs);
// these check the data it relies on, which run without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraFrame, defaultCamera, splitByShadow, pickPolygon} from '../src/modeler/viewport.mjs';
import {createDepthPass, vertexBatch} from '../src/modeler/depth-pass.mjs';

test('projected depth runs 0 near to 1 far and interpolates exactly across a face', () => {
  const frame = cameraFrame({...defaultCamera(), yaw: 0, pitch: 0}, 800, 600);
  const near = frame.project([0, 1, 1]), far = frame.project([0, 1, -1]);
  assert.ok(near.d >= 0 && far.d <= 1 && near.d < far.d);
  // A slanted plane: depth at the screen midpoint of an edge equals the depth of the
  // point that projects there (affine in screen space), not the mean of the ends.
  const a = [-1, 1, 1.5], b = [1, 1, -1.5], pa = frame.project(a), pb = frame.project(b);
  const mid = {x: (pa.x + pb.x) / 2};
  let lo = 0, hi = 1; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2, q = frame.project(a.map((v, i) => v + (b[i] - v) * m)); if (q.x < mid.x) lo = m; else hi = m; }
  const hit = frame.project(a.map((v, i) => v + (b[i] - v) * lo));
  assert.ok(Math.abs(hit.d - (pa.d + pb.d) / 2) < 1e-6, `${hit.d} vs ${(pa.d + pb.d) / 2}`);
  const flat = cameraFrame({...defaultCamera(), ortho: true}, 800, 600);
  assert.ok(flat.project([0, 1, 1]).d < flat.project([0, 1, -1]).d);
  // Toon shadow splits carry depth along.
  const [[lit], [dark]] = splitByShadow([{x: 0, y: 0, d: .2}, {x: 10, y: 0, d: .4}, {x: 10, y: 10, d: .4}, {x: 0, y: 10, d: .2}], [1, -1, -1, 1]);
  assert.ok([...lit, ...dark].every(p => p.d >= .2 && p.d <= .4));
});

test('picking takes the nearest face at the pixel, not the last one sorted', () => {
  // Two crossing faces: sorted by their middles, B is drawn last, but at x = 2 A is nearer.
  const A = {pts: [{x: 0, y: 0, d: .1}, {x: 10, y: 0, d: .9}, {x: 10, y: 10, d: .9}, {x: 0, y: 10, d: .1}], name: 'A'};
  const B = {pts: [{x: 0, y: 0, d: .45}, {x: 10, y: 0, d: .45}, {x: 10, y: 10, d: .45}, {x: 0, y: 10, d: .45}], name: 'B'};
  assert.equal(pickPolygon([A, B], 2, 5).name, 'A');
  assert.equal(pickPolygon([A, B], 8, 5).name, 'B');
});

test('without WebGL the depth pass says so, and the viewport falls back to sorting', () => {
  const pass = createDepthPass(() => null);
  assert.equal(pass.draw(10, 10, vertexBatch().done()), null);
  assert.equal(pass.unavailable, true);
  const batch = vertexBatch(); for (let i = 0; i < 10000; i++) batch.push(0, 0, .5, [10, 20, 30]);
  assert.equal(batch.count, 10000); assert.equal(batch.done().positions.length, 30000);
});
