#!/usr/bin/env node
// Stress test for Open in Blender (docs/BLENDER-LITE.md). Needs a real Blender:
//   node scripts/blender-link-stress.mjs send <folder>
//   STYK_STRESS=detail blender -b --python desktop/blender/styk_link.py -- --styk-session <folder> --styk-test scripts/blender-link-stress.py
//   node scripts/blender-link-stress.mjs merge <folder> [--expect-unchanged]
// `send` writes Juniper (Start > Examples) as the link file, as the app does;
// `merge` brings Blender's reply back, checks the model, turns it into a
// posable figure, poses the sword arm, and writes merged.json + report.json
// (and next/outgoing.json for a second, untouched round trip).
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {readModel, evaluateModel} from '../src/modeler/model.mjs';
import {startBlenderLink, applyBlenderLink} from '../src/modeler/blender-link.mjs';
import {modelToFigure, modelDocument} from '../src/modeler/export-figure.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const [command, folder, flag] = process.argv.slice(2);
if (!['send', 'merge'].includes(command) || !folder) { console.error('usage: blender-link-stress.mjs send|merge <folder> [--expect-unchanged]'); process.exit(2); }
const sessionOut = session => ({parts: [...session.parts], bones: [...session.bones]});
const sessionIn = data => ({parts: new Map(data.parts), bones: new Map(data.bones)});
const write = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value));

async function send(model, into = folder) {
  await mkdir(into, {recursive: true});
  const {doc, session} = startBlenderLink(model);
  await writeFile(path.join(into, 'outgoing.json'), JSON.stringify(doc));
  await writeFile(path.join(into, 'state.json'), JSON.stringify({model, session: sessionOut(session)}));
  return doc;
}

if (command === 'send') {
  const juniper = readModel((await import('../src/modeler/examples/juniper.mjs')).default);
  const doc = await send(juniper);
  console.log(`sent ${doc.parts.length} parts, ${doc.bones.length} bones`);
  process.exit(0);
}

// ---------- merge ----------
const state = JSON.parse(await readFile(path.join(folder, 'state.json'), 'utf8'));
const model = readModel(state.model), session = sessionIn(state.session);
const replyText = await readFile(path.join(folder, 'incoming.json'), 'utf8');
const timings = {};
let t = performance.now();
const reply = JSON.parse(replyText); timings.parseMs = performance.now() - t;
const before = {parts: model.parts.length, bones: model.bones.length, points: model.parts.reduce((s, p) => s + p.mesh.verts.length, 0)};
t = performance.now();
const merge = applyBlenderLink(model, reply, session); timings.mergeMs = performance.now() - t;
t = performance.now();
const reopened = readModel(JSON.parse(JSON.stringify(model))); timings.validateMs = performance.now() - t;
const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };

if (flag === '--expect-unchanged') {
  expect(merge.changed + merge.added + merge.removed + merge.bones.changed + merge.bones.added + merge.bones.removed === 0, `an untouched round trip changed something: ${JSON.stringify(merge)}`);
  expect(JSON.stringify(reopened) === JSON.stringify(readModel(state.model)), 'an untouched round trip must leave the model byte-for-byte the same');
} else {
  const part = name => model.parts.find(p => p.name === name), bone = name => model.bones.find(b => b.name === name);
  expect(part('Head')?.smooth === 2, 'Head comes back with Smooth 2');
  expect(part('Sword') && part('Pauldron') && part('Pedestal') && part('Nameplate') && part('Scarf') && part('Studs'), 'every new object comes back');
  expect(!part('Pauldron cutter') && !part('Stud ring'), 'Boolean cutters and guide curves stay in Blender');
  expect(!part('Ahoge'), 'a part deleted in Blender is removed');
  expect(Object.keys(part('Skirt')?.mesh.vdata?.crease ?? {}).length > 0, 'creases come back');
  expect(part('Skirt')?.solidify > 0, 'the skirt keeps its live Solidify');
  expect(bone('Sword')?.parent === bone('Hand.R')?.id, 'the new Sword bone hangs from Hand.R');
  expect(bone('Jaw.Main') && !bone('Jaw'), 'a renamed bone is renamed, not replaced');
  expect(state.model.bones.find(b => b.name === 'Jaw')?.id === bone('Jaw.Main')?.id, 'a renamed bone keeps its id');
  expect(Math.abs((bone('Shoulder.L')?.strength ?? 1) - .3) < 1e-6, 'bone Strength set in Blender comes back');
  expect(Object.keys(part('Sword')?.mesh.vdata?.skin ?? {}).length > 0, "the sword keeps the weights painted in Blender");
  expect(merge.baked >= 6, 'Bevel/Boolean/Remesh/text/curve/array objects come back baked');
}

// The merged model as a posable figure on the stage.
t = performance.now();
let figureStats = null, pose = null;
try {
  const {stats} = modelToFigure(model); figureStats = stats; timings.figureMs = performance.now() - t;
  const e = new Editor({demo: false}); e.load({...emptyDocument()});
  t = performance.now();
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}}); timings.importFigureMs = performance.now() - t;
  validateScene(e.report);
  if (model.bones.some(b => b.name === 'Sword')) {
    const meshOf = () => buildGeometry(e.report, e.frame).objects.get(e.selectedSlot).spatialMesh;
    const groups = e.figure._styk.spatialMesh.groups, sword = groups.find(g => g.name === 'Sword'), pedestal = groups.find(g => g.name === 'Pedestal');
    const vertsOf = g => { const s = new Set(); for (let k = g.start; k < g.start + g.count; k++) for (let j = 0; j < 3; j++) s.add(e.figure._styk.spatialMesh.indices[k * 3 + j]); return s; };
    const swordVerts = vertsOf(sword), pedestalVerts = pedestal ? vertsOf(pedestal) : new Set();
    const beforePose = Array.from(meshOf().positions);
    e.select(e.selectedUid, e.figure.segments.findIndex(s => s.name === 'LowerArm.R'));
    const p0 = e.getSpatialPose(); t = performance.now(); e.setSpatialPose({bend: p0.bend - 1.2});
    const after = meshOf().positions; timings.poseMs = performance.now() - t;
    const moved = set => [...set].filter(v => Math.hypot(beforePose[v * 2] - after[v * 2], beforePose[v * 2 + 1] - after[v * 2 + 1]) > .5).length / Math.max(1, set.size);
    pose = {swordMoved: moved(swordVerts), pedestalMoved: moved(pedestalVerts)};
    expect(pose.swordMoved > .9, `bending the right forearm swings the sword (${(pose.swordMoved * 100).toFixed(0)}% moved)`);
  }
} catch (error) { failures.push(`figure: ${error.message}`); }

const evaluated = evaluateModel(model);
const report = {
  blender: reply.blender, merge, before,
  after: {parts: model.parts.length, bones: model.bones.length, palette: model.palette.length,
    points: model.parts.reduce((s, p) => s + p.mesh.verts.length, 0), faces: model.parts.reduce((s, p) => s + p.mesh.faces.length, 0),
    shownPoints: evaluated.reduce((s, {mesh}) => s + mesh.verts.length, 0), shownFaces: evaluated.reduce((s, {mesh}) => s + mesh.faces.length, 0)},
  parts: model.parts.map(p => ({name: p.name, points: p.mesh.verts.length, faces: p.mesh.faces.length, mirror: p.mirror, smooth: p.smooth, solidify: p.solidify ?? 0, painted: Object.keys(p.mesh.vdata?.skin ?? {}).length})),
  replyMB: +(replyText.length / 1048576).toFixed(2), figure: figureStats, pose,
  timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])), failures,
};
await write('merged.json', model);
await write('report.json', report);
if (flag !== '--expect-unchanged') { await send(model, path.join(folder, 'next')); await copyFile(path.join(folder, 'state.json'), path.join(folder, 'state-first.json')); }
console.log(JSON.stringify(report, null, 1));
if (failures.length) { console.error('FAILED:\n- ' + failures.join('\n- ')); process.exit(1); }
