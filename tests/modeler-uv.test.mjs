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
