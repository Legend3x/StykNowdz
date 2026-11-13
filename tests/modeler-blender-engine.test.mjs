import test from 'node:test';
import assert from 'node:assert/strict';
import {cube, uvSphere, baseCharacter} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, readModel, evaluatePart} from '../src/modeler/model.mjs';
import {baseCharacterSkeleton} from '../src/modeler/armature.mjs';
import {engineRequest, applyEngineResult, chainOf, ENGINE_TOOLS} from '../src/modeler/blender-engine.mjs';

/** What desktop/blender/styk_engine.py sends back: each part's final shape, plus new objects. */
function result(doc, {change = p => p, added = []} = {}) {
  const materials = [], index = new Map();
  const colorOf = rgb => { const k = rgb.join(); if (!index.has(k)) { index.set(k, materials.length); materials.push(rgb.slice()); } return index.get(k); };
  const parts = doc.parts.map(p => change({key: p.key, name: p.name, follows: 'skin', matrix: p.matrix.slice(), verts: p.verts.map(v => v.slice()), faces: p.faces.map(f => f.slice()),
    colors: p.colors.map(c => colorOf(doc.palette[c])), edges: [], loose: [], mirror: false, clip: true, smooth: 0, solidify: 0, visible: true, baked: true, crease: {}, line: {}, normal: {}, weights: {}}));
  for (const a of added) parts.push({...a, colors: a.colors.map(rgb => colorOf(rgb))});
  return JSON.parse(JSON.stringify({format: doc.format, version: doc.version, blender: '5.3.0', name: doc.name, materials, parts, bones: []}));
}
const shape = (name, mesh, position = [0, 0, 0]) => { const model = emptyModel(); addPart(model, {name, mesh, position}); return model; };

test('a tool sends only the parts it works on, with no bones or reference images', () => {
  const model = emptyModel();
  for (const p of baseCharacter()) addPart(model, p);
  baseCharacterSkeleton(model);
  model.references.push({id: 'f', view: 'front', src: 'data:image/png;base64,AAAA', opacity: .5, height: 2});
  const torso = model.parts.find(p => p.name === 'Torso');
  const {request} = engineRequest(model, 'remesh', {parts: [torso.id], params: {size: .02}});
  assert.equal(request.op, 'remesh');
  assert.equal(request.doc.parts.length, 1);
  assert.equal(request.doc.bones.length, 0);
  assert.equal(request.doc.references.length, 0);
  assert.equal(request.params.target, request.doc.parts[0].key);
  assert.equal(request.params.size, .02);
  assert.deepEqual(ENGINE_TOOLS, ['remesh', 'decimate', 'boolean', 'smooth', 'text', 'tube']);
  assert.throws(() => engineRequest(model, 'boolean', {parts: [torso.id]}), /Shift-click the part to cut/);
  assert.throws(() => engineRequest(model, 'remesh', {parts: []}), /Select a part first/);
});

test('a remeshed part keeps its name, outline and bone, and comes back final', () => {
  const model = shape('Head', cube(.5)), head = model.parts[0];
  head.mirror = true; head.smooth = 2; head.outline = {on: true, thickness: .02, color: 9}; head.bone = 7;
  const {request, session} = engineRequest(model, 'remesh', {parts: [head.id]});
  // Blender's Remesh: a denser sphere-ish shape in place of the cube.
  const ball = uvSphere(.3, 12, 8);
  const reply = result(request.doc, {change: p => ({...p, verts: ball.verts.map(v => v.slice()), faces: ball.faces.map(f => f.v.slice()), colors: ball.faces.map(() => p.colors[0])})});
  const report = applyEngineResult(model, reply, session, {tool: 'remesh', parts: [head.id]});
  assert.deepEqual(report, {changed: 1, added: 0, removed: 0, addedIds: []});
  assert.equal(head.name, 'Head');
  assert.equal(head.mesh.verts.length, ball.verts.length);
  assert.equal(head.mirror, false, 'Mirror is part of the final shape now');
  assert.equal(head.smooth, 0);
  assert.deepEqual(head.outline, {on: true, thickness: .02, color: 9});
  assert.equal(head.bone, 7);
  assert.ok(readModel(JSON.parse(JSON.stringify(model))), 'the model still opens');
});

test('Boolean: the cutter is removed, or kept hidden; nothing left is refused', () => {
  const make = () => { const model = emptyModel(); addPart(model, {name: 'Box', mesh: cube(1)}); addPart(model, {name: 'Cutter', mesh: cube(.4), position: [.5, .5, .5]}); return model; };
  let model = make(), [box, cutter] = model.parts, req = engineRequest(model, 'boolean', {parts: [box.id, cutter.id], params: {how: 'difference'}});
  assert.equal(req.request.params.cutter, req.request.doc.parts[1].key);
  // Blender leaves the cutter out of its reply.
  const onlyBox = doc => ({...doc, parts: doc.parts.slice(0, 1)});
  let report = applyEngineResult(model, result(onlyBox(req.request.doc)), req.session, {tool: 'boolean', parts: [box.id, cutter.id]});
  assert.equal(report.removed, 1);
  assert.deepEqual(model.parts.map(p => p.name), ['Box']);
  model = make(); [box, cutter] = model.parts; req = engineRequest(model, 'boolean', {parts: [box.id, cutter.id]});
  applyEngineResult(model, result(onlyBox(req.request.doc)), req.session, {tool: 'boolean', parts: [box.id, cutter.id], keepCutter: true});
  assert.equal(model.parts.length, 2);
  assert.equal(model.parts[1].visible, false);
  model = make(); [box, cutter] = model.parts; req = engineRequest(model, 'boolean', {parts: [box.id, cutter.id], params: {how: 'intersect'}});
  const empty = result(onlyBox(req.request.doc), {change: p => ({...p, verts: [], faces: [], colors: []})});
  assert.throws(() => applyEngineResult(model, empty, req.session, {tool: 'boolean', parts: [box.id, cutter.id]}), /Nothing is left after that Boolean/);
});

test('text and tubes come back as new parts in their own colours', () => {
  const model = shape('Body', cube(1)), before = model.palette.length;
  const {request, session} = engineRequest(model, 'text', {params: {text: 'HI', at: [0, 1, 0], color: [12, 34, 56]}});
  assert.equal(request.doc.parts.length, 0);
  const letters = cube(.1);
  const reply = result(request.doc, {added: [{key: 'blender-1', name: 'HI', follows: 'skin', matrix: [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1], verts: letters.verts, faces: letters.faces.map(f => f.v), colors: letters.faces.map(() => [12, 34, 56]),
    edges: [], loose: [], mirror: false, clip: true, smooth: 0, solidify: 0, visible: true, baked: true, crease: {}, line: {}, normal: {}, weights: {}}]});
  const report = applyEngineResult(model, reply, session, {tool: 'text'});
  assert.equal(report.added, 1);
  const text = model.parts.find(p => p.id === report.addedIds[0]);
  assert.equal(text.name, 'HI');
  assert.deepEqual(text.position, [0, 1, 0]);
  assert.equal(model.palette.length, before + 1);
  assert.deepEqual(model.palette[text.mesh.faces[0].c], [12, 34, 56]);
  assert.ok(evaluatePart(text).verts.length);
});

test('a tube runs through selected points in their order along the edges', () => {
  // A 4×1 strip of quads: its top row of points is one row along the edges.
  const verts = [], faces = [];
  for (let i = 0; i <= 4; i++) verts.push([i, 0, 0], [i, 1, 0]);
  for (let i = 0; i < 4; i++) faces.push({v: [i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1]});
  const mesh = {verts, faces};
  const top = [7, 1, 5, 3, 9];
  assert.deepEqual(chainOf(mesh, top), {order: [1, 3, 5, 7, 9], closed: false});
  assert.match(chainOf(mesh, [1]).error, /two or more/);
  assert.match(chainOf(mesh, [1, 3, 5, 2]).error, /branch/);
  assert.match(chainOf(mesh, [1, 5]).error, /not joined/);
  // A face's border all the way round is a closed loop.
  const ring = chainOf(cube(1), [0, 1, 2, 3].map(i => cube(1).faces[0].v[i]));
  assert.equal(ring.closed, true);
  assert.equal(ring.order.length, 4);
});
