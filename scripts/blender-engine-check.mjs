#!/usr/bin/env node
// Runs every 3D Nowdz Blender tool through the real engine (docs/BLENDER-LITE.md,
// "Blender tools") on the Juniper example, merging each result as the app does.
//   STYK_ENGINE_ROOT=<python with bpy>  the bundled-engine layout (python.exe, or bin/python3)
//   BLENDER=<blender executable>         or an installed Blender, run with no window
//   node scripts/blender-engine-check.mjs [report.json]
import os from 'node:os';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {readModel, addPart, evaluateModel} from '../src/modeler/model.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import {engineRequest, applyEngineResult, chainOf} from '../src/modeler/blender-engine.mjs';
import {objectTransform} from '../src/modeler/mesh.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {BlenderEngine} = createRequire(import.meta.url)('../desktop/blender-engine.cjs');
const engine = new BlenderEngine({
  bundledRoot: process.env.STYK_ENGINE_ROOT || null, tempRoot: os.tmpdir(), scriptsRoot: path.join(root, 'desktop', 'blender'),
  findBlender: async () => process.env.BLENDER ? {path: process.env.BLENDER} : null,
});
const model = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
const part = name => model.parts.find(p => p.name === name);
const steps = [], failures = [];

async function tool(label, name, options, check = () => true, merge = {}) {
  const started = performance.now();
  try {
    const before = JSON.stringify(model);
    const {request, session} = engineRequest(model, name, options);
    const answer = await engine.run(JSON.stringify(request));
    const report = applyEngineResult(model, JSON.parse(answer.text), session, {tool: name, parts: options.parts ?? [], ...merge});
    readModel(JSON.parse(JSON.stringify(model))); // the model still opens
    const ok = check(report);
    if (!ok) { failures.push(`${label}: unexpected result ${JSON.stringify(report)}`); model.parts = JSON.parse(before).parts; }
    steps.push({label, ok: Boolean(ok), engineSeconds: answer.seconds, ms: Math.round(performance.now() - started), report: {changed: report.changed, added: report.added, removed: report.removed}, blender: answer.blender});
    console.log(`${ok ? 'ok' : 'FAILED'} ${label} (${answer.seconds}s in Blender ${answer.blender})`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    steps.push({label, ok: false, error: error.message, ms: Math.round(performance.now() - started)});
    console.log(`FAILED ${label}: ${error.message}`);
  }
}

const points = id => model.parts.find(p => p.id === id).mesh.verts.length;
const status = await engine.status();
console.log('engine:', JSON.stringify(status));
if (!status.available) { console.error('No engine: set STYK_ENGINE_ROOT or BLENDER.'); process.exit(2); }

// Remesh: the head rebuilt as an even voxel surface (Mirror and Smooth included).
const head = part('Head').id, headBefore = points(head);
await tool('Remesh the head (voxel 0.008)', 'remesh', {parts: [head], params: {size: .008}}, r => r.changed === 1 && points(head) > headBefore);
// Decimate: half the points, then planar (flat areas merged).
const hair = part('Hair').id;
await tool('Remesh the hair, then Decimate to 30%', 'remesh', {parts: [hair], params: {size: .006}}, r => r.changed === 1);
const hairDense = points(hair);
await tool('Decimate the hair to 30%', 'decimate', {parts: [hair], params: {how: 'collapse', ratio: .3}}, () => points(hair) < hairDense * .45);
await tool('Decimate (planar) the skirt', 'decimate', {parts: [part('Skirt').id], params: {how: 'planar', angle: 5}}, r => r.changed === 1);
// Boolean: a window cut out of the torso with a box, kept hidden; a box joined to the hips.
const box = addPart(model, {name: 'Cutter', mesh: cube(.12), position: [0, 1.1, .12]});
await tool('Boolean: cut the torso with a box (kept hidden)', 'boolean', {parts: [part('Torso').id, box.id], params: {how: 'difference'}}, r => r.changed === 1 && part('Cutter')?.visible === false, {keepCutter: true});
const belt = addPart(model, {name: 'Belt buckle', mesh: cube(.06), position: [0, .9, .12]});
await tool('Boolean: join a buckle to the hips (cutter removed)', 'boolean', {parts: [part('Hips').id, belt.id], params: {how: 'union'}}, r => r.changed === 1 && r.removed === 1 && !part('Belt buckle'));
const ball = addPart(model, {name: 'Far ball', mesh: cube(.05), position: [3, 3, 3]});
await tool('Boolean: intersect with a part far away is refused', 'boolean', {parts: [part('Neck').id, ball.id], params: {how: 'intersect'}}, () => false);
if (failures.at(-1)?.includes('Nothing is left')) { failures.pop(); steps.at(-1).ok = true; steps.at(-1).expected = 'refused'; console.log('ok (refused as expected)'); }
model.parts = model.parts.filter(p => p.name !== 'Far ball');
// Smoothing family.
await tool('Smooth the forearm', 'smooth', {parts: [part('Forearm').id], params: {how: 'smooth', factor: .6, iterations: 8}}, r => r.changed === 1);
await tool('Laplacian smooth the hair', 'smooth', {parts: [hair], params: {how: 'laplacian', factor: .8, iterations: 4}}, r => r.changed === 1);
await tool('Corrective smooth the thigh', 'smooth', {parts: [part('Thigh').id], params: {how: 'corrective', factor: .5, iterations: 10}}, r => r.changed === 1);
await tool('Displace the remeshed head (clouds)', 'smooth', {parts: [head], params: {how: 'displace', texture: 'clouds', size: .05, strength: .004}}, r => r.changed === 1);
// New parts: text and a tube along a row of selected points.
await tool('Text: JUNIPER', 'text', {params: {text: 'JUNIPER', at: [0, .05, .25], size: .12, depth: .02, color: [230, 180, 40]}}, r => r.added === 1);
const collar = part('Collar'), chain = chainOf(collar.mesh, collar.mesh.faces[0].v), to = objectTransform(collar);
await tool('Tube through a row of points (a face border, closed)', 'tube', {params: {points: (chain.order ?? []).map(v => to(collar.mesh.verts[v])), closed: chain.closed, radius: .006, color: [200, 40, 60]}}, r => r.added === 1);
await tool('Tube: a tapered strand', 'tube', {params: {points: [[0, 1.6, -.05], [.05, 1.4, -.12], [.02, 1.2, -.15], [.08, 1.0, -.1]], radius: .02, taper: .9, color: [40, 160, 170]}}, r => r.added === 1);
// Bad requests are refused with a reason, and the engine keeps going.
await tool('Text with no text is refused', 'text', {params: {text: '  '}}, () => false);
if (/type the text/.test(failures.at(-1) ?? '')) { failures.pop(); steps.at(-1).ok = true; steps.at(-1).expected = 'refused'; console.log('ok (refused as expected)'); }
await tool('Still working after a refusal: decimate the shoe', 'decimate', {parts: [part('Shoe').id], params: {ratio: .8}}, r => r.changed === 1);

let figure = null;
try { figure = modelToFigure(model).stats; } catch (error) { failures.push(`figure: ${error.message}`); }
const shown = evaluateModel(model);
const report = {engine: status, steps, failures, figure, parts: model.parts.length, shownPoints: shown.reduce((n, {mesh}) => n + mesh.verts.length, 0)};
engine.dispose();
if (process.argv[2]) { await writeFile(process.argv[2], JSON.stringify(report, null, 1)); await writeFile(process.argv[2].replace(/\.json$/, '') + '-model.json', JSON.stringify(model)); }
console.log(JSON.stringify({figure, parts: report.parts, shownPoints: report.shownPoints, failures}, null, 1));
process.exit(failures.length ? 1 : 0);
