// 3D Nowdz toon art: tapered and coloured outlines (line weights per point),
// custom shading normals for anime faces, and the per-point data behind them
// surviving edits, modifiers, saving and the trip to the stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {cube, uvSphere} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, evaluatePart, readModel, catmullClark} from '../src/modeler/model.mjs';
import {outlineHull, partOutline} from '../src/modeler/toon.mjs';
import {inkColor} from '../src/toon-shading.mjs';
import {modelToFigure, modelDocument} from '../src/modeler/export-figure.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {validateSpatialMesh} from '../src/spatial-mesh.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';

const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} ≉ ${b}`);

test('outlines taper with per-point line weights and can take each face\'s own colour', () => {
  const box = cube(1), normals = M.vertexNormals(box);
  M.setVData(box, 'line', [0], 0); M.setVData(box, 'line', [1], 2);
  const hull = outlineHull(box, .05, 9);
  assert.ok(validateMesh(hull).ok);
  near(M.length(M.sub(hull.verts[0], box.verts[0])), 0, 1e-12);
  near(M.length(M.sub(hull.verts[1], box.verts[1])), .1);
  near(M.length(M.sub(hull.verts[2], box.verts[2])), .05);
  assert.ok(M.dot(M.sub(hull.verts[1], box.verts[1]), normals[1]) > 0);
  // Coloured line art: each shell face keeps its face's colour and a darkening.
  box.faces[0].c = 3;
  const tinted = outlineHull(box, .05, 9, {fromPart: true, darken: .5});
  assert.deepEqual([tinted.faces[0].c, tinted.faces[0].ink], [3, .5]);
  assert.deepEqual(inkColor([200, 100, 50], 0), [200, 100, 50]);
  assert.deepEqual(inkColor([200, 100, 50], 1), [0, 0, 0]);
  const half = inkColor([200, 100, 50], .5);
  assert.ok(half.every((v, k) => v < [200, 100, 50][k]) && half[0] > half[1] && half[1] > half[2], 'darker, same hue order');
  // A mesh with traced lines and loose points (not yet evaluated) still gets a valid shell, point for point.
  const traced = cube(1); traced.verts.push([3, 0, 0], [4, 0, 0], [5, 5, 5]); traced.edges = [[8, 9]]; traced.loose = [10];
  const shell = outlineHull(traced, .05, 9, {fromPart: true});
  assert.ok(validateMesh(shell).ok); assert.equal(shell.verts.length, traced.verts.length);
  assert.deepEqual(shell.verts.slice(8), traced.verts.slice(8), 'points on no face get no line');
  assert.deepEqual(partOutline({outline: {on: true, thickness: .02, color: 2, fromPart: true, darken: 2}}, 10), {thickness: .02, color: 2, fromPart: true, darken: 1});
  // A strand tapers from its root (where it joins the rest) to a sharp tip.
  const g = {verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 2, 0], [1, 2, 0], [0, 3, 0], [1, 3, 0]], faces: [{v: [0, 1, 3, 2], c: 0}, {v: [2, 3, 5, 4], c: 0}, {v: [4, 5, 7, 6], c: 0}]};
  const w = M.taperWeights(g, new Set([4, 5, 6, 7]));
  assert.ok(w[4] === 1 || w[5] === 1, 'full at the root'); assert.ok(Math.min(w[6], w[7]) < .5, 'thin at the tip');
});

test('per-point data follows edits, modifiers and saving', () => {
  const box = cube(1);
  M.setVData(box, 'line', [0, 1], .25); M.setVData(box, 'normal', [0], [0, 0, 1]);
  M.extrudeFaces(box, new Set([0])); assert.equal(M.lineWeightOf(box, 0), .25);
  M.deleteFaces(box, new Set([1]));
  assert.ok(validateMesh(box).ok);
  const lines = Object.values(box.vdata.line); assert.deepEqual(lines, [.25, .25], 'renumbered with the points');
  // A refused edit leaves the data exactly as it was.
  const before = JSON.stringify(box.vdata);
  assert.throws(() => M.bevelEdges(box, []));
  assert.equal(JSON.stringify(box.vdata), before);
  // Smooth (Catmull-Clark) keeps it; new points in between take the mean.
  const smooth = catmullClark(box); assert.ok(Object.keys(smooth.vdata.line).length > 2);
  // Mirror and the part's transform turn custom normals with the points.
  const model = emptyModel(), part = addPart(model, {name: 'Face', mesh: cube(1), position: [1, 0, 0], rotation: [0, Math.PI / 2, 0], mirror: true});
  M.setVData(part.mesh, 'normal', [0], [0, 0, 1]);
  const world = evaluatePart(part), custom = Object.values(world.vdata.normal);
  assert.equal(custom.length, 2, 'the mirrored copy has one too');
  near(custom[0][0], -custom[1][0], 1e-9); near(custom[0][2], custom[1][2], 1e-9);
  assert.ok(Math.abs(custom[0][0]) > .99, 'turned a quarter round Y: front becomes ±X');
  // Saving keeps valid data and drops broken entries.
  part.mesh.vdata.line = {0: 9, 1: 'x', 999: .5};
  const read = readModel(model);
  assert.deepEqual(read.parts[0].mesh.vdata.line, {0: 4});
});

test('shading normals: face the front, like a sphere, flatten, with strength', () => {
  const s = uvSphere(.5, 8, 6), all = new Set(s.verts.keys()), own = M.vertexNormals(s);
  const front = M.shadingNormals(s, all, 'direction', {direction: [0, 0, 1]});
  for (const n of Object.values(front)) assert.deepEqual(n.map(v => Math.round(v * 1e9) / 1e9), [0, 0, 1]);
  const ball = M.shadingNormals(s, all, 'sphere', {center: [0, 0, 0]});
  for (const [v, n] of Object.entries(ball)) near(M.dot(n, own[v]), 1, 1e-2);
  const flat = Object.values(M.shadingNormals(s, new Set([10, 11, 12]), 'flatten'));
  assert.deepEqual(flat[0], flat[1]); assert.deepEqual(flat[1], flat[2]);
  const half = M.shadingNormals(s, new Set([20]), 'direction', {direction: [0, 0, 1], strength: .5})[20];
  assert.ok(M.dot(half, [0, 0, 1]) > M.dot(own[20], [0, 0, 1]) && M.dot(half, [0, 0, 1]) < 1);
});

test('custom normals shade the stage: a face pointed front stays lit from the front and darkens from behind', () => {
  const build = normals => {
    const model = emptyModel(), part = addPart(model, {name: 'Head', mesh: uvSphere(.5, 16, 12), position: [0, 1, 0]});
    if (normals) M.setVData(part.mesh, 'normal', [...part.mesh.verts.keys()], normals(part.mesh));
    model.toon = {shadows: true, turn: -40, height: 20, size: .5, strength: .35};
    return model;
  };
  const shadowed = (model, turn) => {
    const e = new Editor({demo: false}); e.load({...emptyDocument(), ...modelDocument(model).document});
    if (turn) { e.select(e.frame.objects[0].unique_id, 0); e.beginDrag('turn'); e.setSpatialPose({turn}); e.commitDrag(); }
    const m = e.geometry.objects.get(0).spatialMesh, base = m.colors.length / 2, visible = [...m.materials.subarray(0, m.count)];
    return {shadow: visible.filter(c => c >= base).length, count: visible.length};
  };
  const plain = shadowed(build(null));
  assert.ok(plain.shadow > 0 && plain.shadow < plain.count, 'a plain sphere is partly in shadow');
  // Custom normals equal to the shape's own shade (nearly) the same.
  const same = shadowed(build(mesh => { const own = M.vertexNormals(mesh); return v => own[v]; }));
  assert.ok(Math.abs(same.shadow - plain.shadow) <= plain.count * .1, `${same.shadow} vs ${plain.shadow}`);
  // All pointing front: no shadow from the front; seen from behind, all of it.
  const flat = build(() => [0, 0, 1]), exported = modelToFigure(flat).figure;
  assert.doesNotThrow(() => validateSpatialMesh(exported));
  assert.equal(exported._styk.spatialMesh.normals.length, exported._styk.spatialMesh.positions.length);
  assert.equal(shadowed(flat).shadow, 0);
  const back = shadowed(flat, Math.PI); assert.equal(back.shadow, back.count);
  // Without toon shadows nothing about normals is exported.
  const noToon = build(() => [0, 0, 1]); delete noToon.toon;
  assert.equal(modelToFigure(noToon).figure._styk.spatialMesh.normals, undefined);
});
