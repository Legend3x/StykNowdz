import test from 'node:test';
import assert from 'node:assert/strict';
import {uvSphere} from '../src/modeler/primitives.mjs';
import * as Mesh from '../src/modeler/mesh.mjs';
import {faceUnwrap, uvAtFront, starterLayout, starterPlaces} from '../src/modeler/face-2d.mjs';
import {readFace} from '../src/face-rig.mjs';

const head = () => { const mesh = Mesh.cloneMesh(uvSphere(.5, 24, 12)); return {mesh, faces: new Set(mesh.faces.map((_, i) => i)), points: mesh.verts.map(v => [...v])}; };
const frame = {xc: 0, y0: -.5, H: 1, xHalf: .5, zFront: .5};

test('a head unwrapped for a face: the front fills the big square as seen; the back sits beside it', () => {
  const t = head(); assert.equal(faceUnwrap(t), true);
  for (const f of t.mesh.faces) { assert.ok(f.uv, 'every face has UVs'); for (const [u, v] of f.uv) assert.ok(u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9); }
  const middle = uvAtFront(t, 0, 0), right = uvAtFront(t, .3, 0), up = uvAtFront(t, 0, .3);
  assert.ok(Math.abs(middle[0] - .375) < .02 && Math.abs(middle[1] - .5) < .02, `the face's middle is the square's (${middle})`);
  assert.ok(right[0] > middle[0] + .1 && Math.abs(right[1] - middle[1]) < .01, 'right on the head is right on the texture');
  assert.ok(up[1] > middle[1] + .1, 'up is up (v up)');
  assert.ok(Math.abs((right[0] - middle[0]) - (up[1] - middle[1])) < .01, 'kept in proportion');
  assert.equal(uvAtFront(t, 2, 0), null, 'off the head');
});

test('the starter places land on the face, mirrored pairs and all', () => {
  const t = head(); faceUnwrap(t); for (const f of t.mesh.faces) f.t = 1;
  const face = readFace(starterLayout(t, frame, 1, {eyeL: 'Left eye'}));
  assert.deepEqual(face.features.map(f => f.id), starterPlaces(frame).map(p => p.id));
  const by = Object.fromEntries(face.features.map(f => [f.id, f]));
  assert.equal(by.eyeL.name, 'Left eye'); assert.equal(by.eyeR.mirrorOf, 'eyeL'); assert.equal(by.browR.mirrorOf, 'browL');
  assert.ok(by.eyeL.x < by.eyeR.x && Math.abs((by.eyeL.x + by.eyeR.x) / 2 - .375) < .01, 'eyes either side of the middle');
  assert.ok(by.browL.y > by.eyeL.y && by.eyeL.y > by.mouth.y, 'brows over eyes over the mouth');
  assert.ok(Math.abs(by.eyeL.w / by.eyeL.h - (.46 / .34)) < .2, 'boxes keep their shape on the texture');
  assert.equal(starterLayout(t, frame, 2).features.length, 0, 'another texture: nothing to place on');
});
