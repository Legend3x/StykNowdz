import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import {readModel, emptyModel, addPart, evaluatePart, catmullClark, solidify} from '../src/modeler/model.mjs';
import {textured, keepUVs, addTexture, TEXTURE_LIMIT, flipFace} from '../src/modeler/uv.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
// Each face's UVs are its points projected onto the face's own plane: a linear
// map, which every split or in-face rebuild must reproduce exactly.
const normalOf = (mesh, f) => M.faceNormal(mesh, f);
const project = (n, p) => { const a = n.map(Math.abs); return a[2] >= a[0] && a[2] >= a[1] ? [p[0], p[1]] : a[0] >= a[1] ? [p[2], p[1]] : [p[0], p[2]]; };
function texturedCube() { const mesh = M.cloneMesh(cube(2)); for (const f of mesh.faces) { const n = normalOf(mesh, f); f.uv = f.v.map(i => project(n, mesh.verts[i])); f.t = 1; } return mesh; }
const valid = mesh => { const r = validateMesh(mesh); assert.ok(r.ok, JSON.stringify(r.problems ?? r).slice(0, 400)); };
function exact(mesh, label) {
  valid(mesh);
  for (const f of mesh.faces.filter(textured)) {
    assert.equal(f.uv.length, f.v.length, `${label}: one UV per corner`);
    const n = normalOf(mesh, f);
    f.v.forEach((i, k) => { const want = project(n, mesh.verts[i]); assert.ok(Math.hypot(f.uv[k][0] - want[0], f.uv[k][1] - want[1]) < 1e-6, `${label}: corner ${i} has UV ${f.uv[k]} but lies at ${want}`); });
  }
}
const front = mesh => mesh.faces.findIndex(f => normalOf(mesh, f)[2] > .9);

test('copies, clones and reversals keep each corner’s UV with its corner', () => {
  const mesh = texturedCube(), copy = M.cloneMesh(mesh);
  assert.deepEqual(copy.faces, mesh.faces); assert.notEqual(copy.faces[0].uv, mesh.faces[0].uv);
  const f = {v: [0, 1, 2], uv: [[0, 0], [1, 0], [1, 1]], c: 0, t: 1}; flipFace(f);
  assert.deepEqual(f, {v: [2, 1, 0], uv: [[1, 1], [1, 0], [0, 0]], c: 0, t: 1});
});

test('splitting and rebuilding faces in place keeps the texture exactly where it was', () => {
  let mesh = texturedCube(); M.subdivideFaces(mesh, new Set(mesh.faces.map((_, i) => i))); exact(mesh, 'Subdivide');
  assert.equal(mesh.faces.filter(textured).length, 24);
  mesh = texturedCube(); M.insetFaces(mesh, new Set([front(mesh)]), .3); exact(mesh, 'Inset'); assert.ok(mesh.faces.every(textured), 'the inset ring lies inside the old face');
  mesh = texturedCube(); M.loopCut(mesh, mesh.faces[front(mesh)].v.slice(0, 2), .3, 2); exact(mesh, 'Loop cut'); assert.ok(mesh.faces.every(textured));
  mesh = texturedCube(); M.triangulateFaces(mesh, new Set(mesh.faces.map((_, i) => i))); exact(mesh, 'Triangulate'); assert.equal(mesh.faces.filter(textured).length, 12);
  mesh = texturedCube(); M.pokeFaces(mesh, new Set([front(mesh)])); exact(mesh, 'Poke'); assert.ok(mesh.faces.every(textured));
  mesh = texturedCube(); M.triangulateFaces(mesh, new Set(mesh.faces.map((_, i) => i))); M.trisToQuads(mesh, new Set(mesh.faces.map((_, i) => i))); exact(mesh, 'Tris to quads');
  mesh = texturedCube(); M.subdivideFaces(mesh, new Set([front(mesh)]));
  const inner = mesh.faces.filter(f => normalOf(mesh, f)[2] > .9).flatMap(f => f.v.map((a, k) => [a, f.v[(k + 1) % f.v.length]])).filter(([a, b]) => mesh.verts[a][2] > .99 && mesh.verts[b][2] > .99 && (Math.abs(mesh.verts[a][0]) < 1e-9 && Math.abs(mesh.verts[b][0]) < 1e-9));
  M.dissolveEdges(mesh, inner); exact(mesh, 'Dissolve edges');
});

test('faces that lie on no old face start untextured; others keep theirs', () => {
  let mesh = texturedCube(); const top = front(mesh); M.extrudeFaces(mesh, new Set([top])); exact(mesh, 'Extrude');
  // As in Blender, the sides of an extrusion start as strips along the old edge's UVs.
  assert.ok(mesh.faces.every(textured));
  const moved = new Set(mesh.faces[top].v); mesh.verts = mesh.verts.map((p, i) => moved.has(i) ? [p[0], p[1], p[2] + 1] : p);
  const sides = mesh.faces.filter(f => Math.abs(normalOf(mesh, f)[2]) < .1 && f.v.some(i => moved.has(i)));
  assert.equal(sides.length, 4); for (const f of sides) assert.ok(new Set(f.uv.map(String)).size <= 2, 'a side strip spans only its edge’s UVs');
  mesh = texturedCube(); M.deleteFaces(mesh, new Set([front(mesh)])); exact(mesh, 'Delete'); M.fillHoles(mesh, new Set(mesh.verts.map((_, i) => i))); valid(mesh);
  assert.equal(mesh.faces.filter(textured).length, 5, 'the filled hole is a new face without UVs');
  mesh = texturedCube(); M.flipFaces(mesh, new Set([0])); exact(mesh, 'Flip');
  mesh = texturedCube(); M.recalculateNormals(mesh); exact(mesh, 'Recalculate normals');
});

test('a mesh without textures never gains texture data from an edit', () => {
  const mesh = M.cloneMesh(cube(2)); M.subdivideFaces(mesh, new Set([0])); M.extrudeFaces(mesh, new Set([0]));
  assert.ok(mesh.faces.every(f => f.uv === undefined && f.t === undefined));
});

test('Smooth, Solidify and Mirror carry UVs into the evaluated mesh', () => {
  const smooth = catmullClark(texturedCube()); valid(smooth);
  assert.ok(smooth.faces.every(textured) && smooth.faces.length === 24);
  const quarter = smooth.faces[0]; assert.deepEqual(quarter.uv[0], texturedCube().faces[0].uv[0], 'original corners keep their UV');
  const half = texturedCube(); M.deleteFaces(half, new Set([front(half)]));
  const shell = solidify(half, .1); valid(shell);
  assert.ok(shell.faces.every(textured), 'outer, inner and rim faces are all textured');
  const model = emptyModel(); model.textures = [{id: 1, name: 'Skin', src: PNG, width: 1, height: 1}];
  const part = addPart(model, {mesh: texturedCube(), mirror: true, smooth: 1});
  const out = evaluatePart(part); valid(out); assert.ok(out.faces.every(textured));
});

test('saved models keep valid textures and UVs and drop broken ones', () => {
  const model = emptyModel(); addTexture(model, {name: 'Skin', src: PNG, width: 1, height: 1});
  const part = addPart(model, {mesh: texturedCube()});
  part.mesh.faces[1].uv = [[0, 0]]; part.mesh.faces[2].t = 99; part.mesh.faces[3].uv[0] = [NaN, 1];
  model.textures.push({id: 5, name: 'bad', src: 'https://example.com/x.png', width: 4, height: 4}, {id: 6, src: PNG, width: 0, height: 4});
  const read = readModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(read.textures.map(t => t.id), [1]);
  const faces = read.parts[0].mesh.faces;
  assert.ok(textured(faces[0]));
  assert.equal(faces[1].uv, undefined); assert.equal(faces[2].t, undefined); assert.equal(faces[3].uv, undefined);
  const plain = readModel(JSON.parse(JSON.stringify(emptyModel()))); assert.equal(plain.textures, undefined);
  const full = emptyModel(); for (let i = 0; i < TEXTURE_LIMIT; i++) addTexture(full, {src: PNG, width: 1, height: 1});
  assert.deepEqual(full.textures.map(t => t.id), Array.from({length: TEXTURE_LIMIT}, (_, i) => i + 1));
  assert.throws(() => addTexture(full, {src: PNG, width: 1, height: 1}), /16 textures/);
});

test('keepUVs on its own: a face moved off its old place loses its texture', () => {
  const before = texturedCube(), after = M.cloneMesh(before);
  after.verts = after.verts.map(p => [p[0] + 5, p[1], p[2]]); for (const f of after.faces) { delete f.uv; }
  keepUVs(before, after); assert.ok(after.faces.every(f => f.uv === undefined && f.t === undefined));
});

import {splitByShadow} from '../src/modeler/viewport.mjs';
import {vertexBatch} from '../src/modeler/depth-pass.mjs';
test('toon shadow cuts give textured corners perspective-correct UVs', () => {
  // A near corner (w 1) and a far one (w 3): the screen midpoint is a quarter of the way in UV.
  const pts = [{x: 0, y: 0, d: 0, w: 1, uv: [0, 0]}, {x: 10, y: 0, d: 0, w: 3, uv: [1, 0]}, {x: 10, y: 10, d: 0, w: 3, uv: [1, 1]}, {x: 0, y: 10, d: 0, w: 1, uv: [0, 1]}];
  const [[lit], [dark]] = splitByShadow(pts, [1, -1, -1, 1]);
  const cut = lit.find(p => p.x === 5 && p.y === 0);
  assert.ok(Math.abs(cut.uv[0] - .25) < 1e-9 && Math.abs(cut.w - 1.5) < 1e-9, JSON.stringify(cut));
  assert.ok(dark.includes(cut));
  const batch = vertexBatch({textured: true}); batch.push(0, 0, .5, [255, 255, 255], 255, .25, .75, 2);
  assert.deepEqual([...batch.done().surface], [.25, .75, 2]);
  assert.equal(vertexBatch().done().surface, undefined);
});

import {deflateSync} from 'node:zlib';
import {exportGlb, importGltf, readGlb} from '../src/modeler/gltf-format.mjs';
import {imageInfo, textureFromBytes, adoptTextures, remapFaceTextures, dataUrlBytes} from '../src/modeler/uv.mjs';
/** A real w×h RGBA PNG. */
export function png(w, h, rgba = (x, y) => [x * 40, y * 60, 200, 255]) {
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(rgba(x, y)).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('image headers give type and size; non-images are refused', () => {
  assert.deepEqual(imageInfo(png(5, 3)), {mime: 'image/png', width: 5, height: 3});
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 7, 0, 9, 3, 1, 1, 1]);
  assert.deepEqual(imageInfo(jpeg), {mime: 'image/jpeg', width: 9, height: 7});
  assert.equal(imageInfo(new Uint8Array([1, 2, 3])), null);
  const t = textureFromBytes(png(5, 3), 'Skin'); assert.equal(t.width, 5); assert.deepEqual([...dataUrlBytes(t.src).bytes], [...png(5, 3)]);
});

test('a textured model goes through .glb and comes back with its image and every UV', () => {
  const model = emptyModel(); const tex = addTexture(model, textureFromBytes(png(4, 2), 'Skin'));
  const mesh = texturedCube(); for (const f of mesh.faces) f.t = tex.id;
  // One face keeps its plain colour.
  delete mesh.faces[5].uv; delete mesh.faces[5].t; mesh.faces[5].c = 3;
  addPart(model, {name: 'Box', mesh});
  const glb = exportGlb(model), {json} = readGlb(glb);
  assert.equal(json.images.length, 1); assert.equal(json.materials.filter(m => m.pbrMetallicRoughness.baseColorTexture).length, 1);
  const back = importGltf(glb, {palette: model.palette.map(c => c.slice())});
  assert.equal(back.textures.length, 1); assert.equal(back.textures[0].src, tex.src); assert.equal(back.textures[0].name, 'Skin');
  const into = emptyModel(), ids = adoptTextures(into, back.textures), part = back.parts[0];
  remapFaceTextures(part.mesh, ids); valid(part.mesh);
  assert.equal(into.textures[0].src, tex.src);
  // Faces come back as triangles (welded); each corner's UV is still its point's projection on its plane.
  const texturedFaces = part.mesh.faces.filter(textured);
  assert.equal(texturedFaces.length, 10); assert.equal(part.mesh.faces.length - texturedFaces.length, 2);
  for (const f of texturedFaces) { const n = normalOf(part.mesh, f); f.v.forEach((i, k) => { const want = project(n, part.mesh.verts[i]); assert.ok(Math.hypot(f.uv[k][0] - want[0], f.uv[k][1] - want[1]) < 1e-5, `${f.uv[k]} vs ${want}`); }); }
  assert.equal(part.mesh.verts.length, 8, 'seam points are welded back into one surface');
  // A second import of the same image reuses the texture.
  assert.equal(adoptTextures(into, back.textures).get(1), into.textures[0].id); assert.equal(into.textures.length, 1);
});

import {startBlenderLink, applyBlenderLink} from '../src/modeler/blender-link.mjs';
import {bytesToDataUrl} from '../src/modeler/uv.mjs';
/** What desktop/blender/styk_link.py sends back for a scene nobody touched, textures included. */
function echo(doc) {
  const materials = [], index = new Map();
  const colorOf = c => { const rgb = doc.palette[c], k = rgb.join(); if (!index.has(k)) { index.set(k, materials.length); materials.push(rgb.slice()); } return index.get(k); };
  return JSON.parse(JSON.stringify({format: doc.format, version: doc.version, name: doc.name, materials, textures: doc.textures ?? [],
    parts: doc.parts.map(p => ({...p, colors: p.colors.map(colorOf), baked: false})), bones: doc.bones}));
}
function texturedModel() {
  const model = emptyModel(), tex = addTexture(model, textureFromBytes(png(4, 4), 'Skin'));
  const mesh = texturedCube(); for (const f of mesh.faces) f.t = tex.id; delete mesh.faces[0].uv; delete mesh.faces[0].t;
  addPart(model, {name: 'Box', mesh}); return model;
}
test('Open in Blender sends textures and UVs, and an untouched save changes nothing', () => {
  const model = texturedModel(), before = JSON.stringify(model), {doc, session} = startBlenderLink(model);
  assert.deepEqual(doc.textures.map(t => t.key), ['tex-1']); assert.equal(doc.textures[0].src, model.textures[0].src);
  assert.equal(doc.parts[0].uvs[0], null); assert.equal(doc.parts[0].textures[1], 'tex-1'); assert.deepEqual(doc.parts[0].uvs[1], model.parts[0].mesh.faces[1].uv);
  const report = applyBlenderLink(model, echo(doc), session);
  assert.equal(report.kept, 1); assert.equal(report.textures, 0); assert.equal(JSON.stringify(model), before);
});
test('a texture painted in Blender comes back; so do UVs moved there and a new image', () => {
  const model = texturedModel(), {doc, session} = startBlenderLink(model), reply = echo(doc);
  const painted = bytesToDataUrl(png(8, 4, () => [255, 0, 0, 255]), 'image/png');
  reply.textures[0].src = painted;
  let report = applyBlenderLink(model, reply, session);
  assert.equal(report.textures, 1); assert.equal(report.kept, 1, 'repainting the image leaves the mesh alone');
  assert.deepEqual([model.textures[0].src, model.textures[0].width, model.textures[0].height], [painted, 8, 4]);
  // Next save: UVs of one face moved, and another face given a new image Blender made.
  const next = startBlenderLink(model), again = echo(next.doc);
  again.parts[0].uvs[2] = again.parts[0].uvs[2].map(([u, v]) => [u / 2, v / 2]);
  again.textures.push({key: 'blender-abc', name: 'Eyes', src: bytesToDataUrl(png(2, 2), 'image/png')});
  again.parts[0].textures[3] = 'blender-abc';
  report = applyBlenderLink(model, again, next.session);
  assert.equal(report.changed, 1); assert.equal(report.textures, 1);
  const faces = model.parts[0].mesh.faces;
  assert.deepEqual(faces[2].uv, again.parts[0].uvs[2]); assert.equal(model.textures.find(t => t.id === faces[3].t).name, 'Eyes');
  assert.equal(faces[0].t, undefined, 'a plain colour face stays plain');
  // An image Blender couldn't read stays out; its faces show their colours.
  const third = startBlenderLink(model), bad = echo(third.doc); bad.textures.push({key: 'blender-x', name: 'x', src: 'data:image/png;base64,AAAA'}); bad.parts[0].textures[4] = 'blender-x';
  applyBlenderLink(model, bad, third.session); assert.equal(model.parts[0].mesh.faces[4].t, undefined);
});
