// glTF 2.0 (.glb / .gltf) import and export for 3D Nowdz: parts, colours,
// skeleton and skin weights survive the trip, and rigged imports reach the
// animation with the file's own weights.
import test from 'node:test';
import assert from 'node:assert/strict';
import {exportGlb, importGltf, readGlb} from '../src/modeler/gltf-format.mjs';
import {emptyModel, addPart, evaluatePart, readModel} from '../src/modeler/model.mjs';
import {baseCharacter, cube} from '../src/modeler/primitives.mjs';
import {baseCharacterSkeleton, addBone, partWeights} from '../src/modeler/armature.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';
import {validateSpatialMesh} from '../src/spatial-mesh.mjs';

const near = (a, b, t = 1e-5) => assert.ok(Math.abs(a - b) <= t, `${a} ≉ ${b}`);
/** Bring an import into a model the way the File menu does. */
function adopt(result, palette) {
  const model = emptyModel(); model.palette = palette.length ? palette : model.palette;
  const ids = new Map();
  for (const b of result.bones) ids.set(b.key, addBone(model, {name: b.name, head: b.head, tail: b.tail, parent: b.parent === null ? 0 : ids.get(b.parent) ?? 0}).id);
  for (const p of result.parts) {
    const skin = p.mesh.vdata?.skin;
    if (skin) for (const [i, pairs] of Object.entries(skin)) skin[i] = pairs.map(([key, w]) => [ids.get(key), w]);
    addPart(model, {name: p.name, mesh: p.mesh});
  }
  return model;
}

test('a rigged 3D Nowdz model goes out as .glb and comes back the same', () => {
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  const glb = exportGlb(model), {json} = readGlb(glb);
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.skins[0].joints.length, model.bones.length);
  assert.equal(json.meshes.length, model.parts.filter(p => p.visible !== false).length);
  const palette = model.palette.map(c => c.slice()), back = importGltf(glb, {palette});
  assert.equal(back.bones.length, model.bones.length);
  for (const b of model.bones) {
    const i = back.bones.find(x => x.name === b.name);
    b.head.forEach((v, k) => near(i.head[k], v)); b.tail.forEach((v, k) => near(i.tail[k], v));
  }
  const again = adopt(back, palette);
  model.parts.forEach((p, n) => {
    const out = evaluatePart(p), inn = again.parts[n].mesh;
    assert.equal(inn.verts.length, out.verts.length, `${p.name}: welded back to the same points`);
    assert.ok(validateMesh(inn, {print: false}).ok);
    assert.equal(Object.keys(inn.vdata.skin).length, inn.verts.length, 'every point keeps its weights');
  });
  // The kept weights are the ones the animation uses.
  const head = again.parts[0], skin = partWeights(again, head.mesh, head);
  const kept = head.mesh.vdata.skin[0].slice().sort((a, b) => b[1] - a[1]);
  near(skin.weights[0], kept[0][1]); assert.equal(skin.bones[0], kept[0][0]);
  assert.doesNotThrow(() => validateSpatialMesh(modelToFigure(again).figure));
  // Saving keeps the weights; ones naming missing bones are dropped.
  again.parts[0].mesh.vdata.skin[1] = [[9999, 1]];
  const saved = readModel(again);
  assert.ok(saved.parts[0].mesh.vdata.skin[0].length > 0); assert.equal(saved.parts[0].mesh.vdata.skin[1], undefined);
});

/** A hand-written .gltf (data-URI buffer): two bones up Y, a quad strip skinned to them,
 * plus an unskinned triangle on a moved node. */
function sampleGltf() {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0, 1, 2, 0], indices = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4];
  const joints = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const weights = [1, 0, 0, 0, 1, 0, 0, 0, .5, .5, 0, 0, .5, .5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  // Bone 2 sits 1 up: its inverse bind matrix (column-major) moves 1 down.
  const ibm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1];
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const parts = [new Float32Array(positions), new Uint16Array(indices), new Uint16Array(joints), new Float32Array(weights), new Float32Array(ibm), new Float32Array(tri)];
  const views = [], bytes = []; let offset = 0;
  for (const p of parts) { const b = new Uint8Array(p.buffer); views.push({buffer: 0, byteOffset: offset, byteLength: b.length}); bytes.push(...b); while (bytes.length % 4) bytes.push(0); offset = bytes.length; }
  const uri = 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes));
  return {
    asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0, 1, 3]}],
    nodes: [{name: 'Body', mesh: 0, skin: 0}, {name: 'Root', children: [2]}, {name: 'Upper', translation: [0, 1, 0]}, {name: 'Flag', mesh: 1, translation: [5, 0, 0]}],
    meshes: [{primitives: [{attributes: {POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3}, indices: 1, material: 0}]}, {primitives: [{attributes: {POSITION: 5}, material: 1}]}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [1, 0, 0, 1]}}, {pbrMetallicRoughness: {baseColorFactor: [0, 0, 1, 1]}}],
    skins: [{joints: [1, 2], inverseBindMatrices: 4}],
    accessors: [{bufferView: 0, componentType: 5126, count: 6, type: 'VEC3'}, {bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR'},
      {bufferView: 2, componentType: 5123, count: 6, type: 'VEC4'}, {bufferView: 3, componentType: 5126, count: 6, type: 'VEC4'},
      {bufferView: 4, componentType: 5126, count: 2, type: 'MAT4'}, {bufferView: 5, componentType: 5126, count: 3, type: 'VEC3'}],
    bufferViews: views, buffers: [{byteLength: bytes.length, uri}],
  };
}

test('a .gltf from another tool: rest pose, bones, weights, colours and node moves', () => {
  const palette = [], result = importGltf(sampleGltf(), {palette});
  assert.deepEqual(result.bones.map(b => [b.name, b.parent]), [['Root', null], ['Upper', 0]]);
  assert.deepEqual(result.bones[0].head, [0, 0, 0]); assert.deepEqual(result.bones[0].tail, [0, 1, 0]);
  near(result.bones[1].tail[1], 1.5, 1e-9); // no child: half its parent's length along its own Y
  const [body, flag] = result.parts;
  assert.equal(body.mesh.verts.length, 6); assert.ok(validateMesh(body.mesh, {print: false}).ok);
  assert.deepEqual(body.mesh.vdata.skin[2], [[0, .5], [1, .5]]);
  assert.ok(flag.mesh.verts.every(p => p[0] >= 5), 'an unskinned mesh takes its node\'s move');
  assert.deepEqual(palette, [[255, 0, 0], [0, 0, 255]]);
  const model = adopt(result, palette);
  assert.doesNotThrow(() => validateSpatialMesh(modelToFigure(model).figure));
});

test('files the importer can\'t read say why', () => {
  assert.throws(() => importGltf(new ArrayBuffer(24)), /not a binary glTF/);
  assert.throws(() => importGltf({...sampleGltf(), extensionsRequired: ['KHR_draco_mesh_compression']}), /without compression/);
  const missing = sampleGltf(); missing.buffers[0].uri = 'body.bin';
  assert.throws(() => importGltf(missing), /choose it together/);
  const empty = emptyModel(); addPart(empty, {name: 'Hidden', mesh: cube(), visible: false});
  assert.throws(() => exportGlb(empty), /nothing to export/);
});
