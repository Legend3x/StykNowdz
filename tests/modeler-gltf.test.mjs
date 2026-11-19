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

/** A rigged half model as Blender exports it with a control rig (Rigify) and the Mirror modifier left
 * unapplied: the right leg's deform bone exists but moves nothing, helper and control bones move nothing,
 * a second armature no mesh uses rides along, and the colour comes from an emissive image. */
function riggedHalfGltf() {
  // A box for the left leg, x 0.05 to 0.15, every point on DEF-thigh.L (joint 2 of skin 0).
  const positions = [], indices = [], joints = [], weights = [];
  for (const y of [0, 1]) for (const z of [-.05, .05]) for (const x of [.05, .15]) { positions.push(x, y, z); joints.push(2, 0, 0, 0); weights.push(1, 0, 0, 0); }
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  const uvs = Array.from({length: 8}, (_, i) => [i % 2, i >> 2]).flat();
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ibm = (x, y) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, 0, 1];
  const arrays = [new Float32Array(positions), new Uint16Array(indices), new Uint16Array(joints), new Float32Array(weights), new Float32Array([...id, ...id, ...ibm(.1, 1), ...ibm(-.1, 1), ...id]), new Float32Array(uvs)];
  const views = [], bytes = []; let offset = 0;
  for (const p of arrays) { const b = new Uint8Array(p.buffer); views.push({buffer: 0, byteOffset: offset, byteLength: b.length}); bytes.push(...b); while (bytes.length % 4) bytes.push(0); offset = bytes.length; }
  // A 1×1 PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return {
    asset: {version: '2.0', generator: 'Khronos glTF Blender I/O'}, scene: 0, scenes: [{nodes: [0, 1, 7]}],
    nodes: [
      {name: 'Body', mesh: 0, skin: 0},
      {name: 'rig', children: [2]}, {name: 'root', children: [3, 5, 6]},
      {name: 'ORG-thigh.L', translation: [.1, 1, 0], children: [4]}, {name: 'DEF-thigh.L', rotation: [1, 0, 0, 0]},
      {name: 'DEF-thigh.R', translation: [-.1, 1, 0], rotation: [1, 0, 0, 0]}, {name: 'thigh_ik.L', translation: [.1, 0, 0]},
      {name: 'Eye Control'},
    ],
    meshes: [{primitives: [{attributes: {POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3, TEXCOORD_0: 5}, indices: 1, material: 0}]}],
    materials: [{name: 'Toon', emissiveFactor: [1, 1, 1], emissiveTexture: {index: 0}, pbrMetallicRoughness: {baseColorFactor: [0, 0, 0, 1]}}],
    textures: [{source: 0}], images: [{uri: `data:image/png;base64,${png}`, name: 'Skin'}],
    skins: [{joints: [1, 2, 4, 5, 6], inverseBindMatrices: 4}, {joints: [7]}],
    accessors: [{bufferView: 0, componentType: 5126, count: 8, type: 'VEC3'}, {bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR'},
      {bufferView: 2, componentType: 5123, count: 8, type: 'VEC4'}, {bufferView: 3, componentType: 5126, count: 8, type: 'VEC4'},
      {bufferView: 4, componentType: 5126, count: 5, type: 'MAT4'}, {bufferView: 5, componentType: 5126, count: 8, type: 'VEC2'}],
    bufferViews: views, buffers: [{byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes))}],
  };
}

test('a rig with controls brings only the bones that move the model, both sides, and a half model gets Mirror', () => {
  const palette = [], result = importGltf(riggedHalfGltf(), {palette});
  // Controls, helpers (ORG-, IK targets, the rig's root) and the unused armature stay behind; DEF- is dropped from the names.
  assert.deepEqual(result.bones.map(b => b.name).sort(), ['thigh.L', 'thigh.R']);
  assert.ok(result.bones.every(b => b.parent === null));
  const [body] = result.parts;
  assert.equal(body.mirror, true, 'the left leg alone, moved by a bone whose right side moves nothing: half a mirrored model');
  // The colour comes from the emissive image, not the black base colour.
  assert.equal(result.textures.length, 1);
  assert.ok(body.mesh.faces.every(f => f.t === result.textures[0].key && f.uv));
  assert.deepEqual(palette, [[255, 255, 255]]);
  // In the model, the mirrored leg follows the right bone.
  const model = adopt(result, palette); model.parts[0].mirror = true;
  const mesh = evaluatePart(model.parts[0]), skin = partWeights(model, mesh, model.parts[0]), right = model.bones.find(b => b.name === 'thigh.R').id;
  mesh.verts.forEach((p, v) => { if (p[0] < 0) assert.equal(skin.bones[v * 4], right); });
});

test('a model with both sides of its own keeps them: Mirror stays off', () => {
  const gltf = riggedHalfGltf();
  // The same file with the right leg modelled too (a second mesh on DEF-thigh.R).
  gltf.nodes.push({name: 'RightLeg', mesh: 1, skin: 0}); gltf.scenes[0].nodes.push(8);
  gltf.meshes.push({primitives: [{...gltf.meshes[0].primitives[0], attributes: {...gltf.meshes[0].primitives[0].attributes, POSITION: 6, JOINTS_0: 7}}]});
  const right = new Float32Array(new Float32Array(Uint8Array.from(atob(gltf.buffers[0].uri.split(',')[1]), c => c.charCodeAt(0)).buffer, gltf.bufferViews[0].byteOffset, 24).map((v, i) => (i % 3 === 0 ? -v : v)));
  const joints = new Uint16Array(Array.from({length: 8}, () => [3, 0, 0, 0]).flat());
  const old = Uint8Array.from(atob(gltf.buffers[0].uri.split(',')[1]), c => c.charCodeAt(0)), bytes = [...old];
  for (const extra of [right, joints]) { gltf.bufferViews.push({buffer: 0, byteOffset: bytes.length, byteLength: extra.byteLength}); bytes.push(...new Uint8Array(extra.buffer)); while (bytes.length % 4) bytes.push(0); }
  gltf.accessors.push({bufferView: gltf.bufferViews.length - 2, componentType: 5126, count: 8, type: 'VEC3'}, {bufferView: gltf.bufferViews.length - 1, componentType: 5123, count: 8, type: 'VEC4'});
  gltf.buffers[0] = {byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes))};
  const result = importGltf(gltf, {palette: []});
  assert.ok(result.parts.length === 2 && result.parts.every(p => !p.mirror));
});
