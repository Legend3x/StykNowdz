// Golden results for weight painting (docs/BLENDER-LITE.md, "Weight painting"): what the
// examples' weights, posed points, painting, saving, glTF export, merging and skeleton files
// give, recorded before the weight data layer changed, so a change that should keep results
// the same can be checked number for number.
//
// node tests/support/weight-golden.mjs write   → records tests/fixtures/weight-golden.json
// node tests/support/weight-golden.mjs dump F  → writes the full (unhashed) results to F
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {readModel, evaluatePart, emptyModel, addPart} from '../../src/modeler/model.mjs';
import {partWeights, addBone} from '../../src/modeler/armature.mjs';
import {poseFrames, posedMesh, axisAngle} from '../../src/modeler/pose.mjs';
import {startStroke, paintPoint} from '../../src/modeler/weight-paint.mjs';
import {mergeBone} from '../../src/modeler/layers.mjs';
import {skeletonFile, readSkeletonFile, applySkeleton} from '../../src/modeler/skeleton-file.mjs';
import {exportGlb, importGltf} from '../../src/modeler/gltf-format.mjs';

export const FIXTURE = new URL('../fixtures/weight-golden.json', import.meta.url);
const round = x => Math.round(x * 1e6) / 1e6;
const bone = (model, name) => model.bones.find(b => b.name === name)?.id;
const part = (model, name) => model.parts.find(p => p.name === name);

/** Every shown part's weights (four per point) as the stage, export and colours get them. */
export function weightsOf(model) {
  return Object.fromEntries(model.parts.filter(p => p.mesh.faces.length).map(p => {
    const skin = partWeights(model, evaluatePart(p), p);
    return [`${p.id}:${p.name}`, {bones: [...skin.bones], weights: skin.weights.map(round)}];
  }));
}

/** Every part's points moved by a fixed pose (the modeler's Pose preview). */
export function posedOf(model) {
  const turns = [['UpperArm.L', [0, 0, 1], .6], ['LowerArm.L', [1, 0, 0], .8], ['Thigh.R', [1, 0, 0], -.5], ['Spine', [0, 1, 0], .3], ['Head', [1, 0, 0], .25]];
  const pose = new Map(turns.filter(([n]) => bone(model, n)).map(([n, axis, angle]) => [bone(model, n), axisAngle(axis, angle)]));
  if (!pose.size && model.bones.length) pose.set(model.bones.at(-1).id, axisAngle([1, 0, 0], .5));
  const frames = poseFrames(model, pose);
  return Object.fromEntries(model.parts.filter(p => p.mesh.faces.length).map(p => {
    const mesh = evaluatePart(p);
    return [`${p.id}:${p.name}`, posedMesh(mesh, partWeights(model, mesh, p), frames).verts.map(q => q.map(round))];
  }));
}

/** Every part's stored (painted or imported) weights, as saved. */
export const storedOf = model => Object.fromEntries(model.parts.map(p => [`${p.id}:${p.name}`, Object.fromEntries(Object.entries(p.mesh.vdata?.skin ?? {}).map(([v, pairs]) => [v, pairs.map(([b, w]) => [b, round(w)])]))]));

/** A fixed series of brush changes: each mode, on a smoothed part, a Mirror part and beside a merged bone. */
export function paintSeries(model) {
  const jobs = [['Torso', 'Shoulder.L'], ['Thigh', 'Thigh.L'], ['Arm', 'UpperArm.L'], ['Hips', 'Hips']];
  const modes = [['add', .35], ['remove', .5], ['smooth', .6], ['set', .7, .4], ['add', .9], ['remove', .25]];
  for (const [p, b] of jobs) {
    const q = part(model, p), id = bone(model, b); if (!q || !id) continue;
    const stroke = startStroke(model, q, id);
    for (let v = 0, k = 0; v < q.mesh.verts.length; v += 3, k++) { const [mode, amount, value] = modes[k % modes.length]; paintPoint(stroke, v, mode, amount, {value}); }
  }
}

/** A model made from a glTF file the way the modeler's File → Import does it. */
export function modelFromGltf(source) {
  const result = importGltf(source), model = emptyModel(), ids = new Map();
  for (const b of result.bones) { const made = addBone(model, {name: b.name, head: b.head, tail: b.tail, parent: b.parent === null ? 0 : ids.get(b.parent) ?? 0}); ids.set(b.key, made.id); }
  for (const p of result.parts) {
    const skin = p.mesh.vdata?.skin;
    if (skin) for (const [i, pairs] of Object.entries(skin)) skin[i] = pairs.map(([key, w]) => [ids.get(key), w]).filter(([id]) => id !== undefined);
    addPart(model, {name: p.name, mesh: p.mesh, mirror: Boolean(p.mirror)});
  }
  return readModel(model);
}

const example = async name => readModel((await import(`../../src/modeler/examples/${name}.mjs`)).default);
const roundTrip = model => readModel(JSON.parse(JSON.stringify(model)));

/** Every golden result, in full. */
export async function goldenResults() {
  const out = {};
  for (const name of ['juniper', 'kettle']) {
    const model = await example(name);
    out[`${name}.weights`] = weightsOf(model);
    out[`${name}.posed`] = posedOf(model);
    out[`${name}.gltf`] = storedOf(modelFromGltf(exportGlb(model)));
  }
  const painted = await example('juniper');
  paintSeries(painted);
  out['painted.stored'] = storedOf(painted);
  out['painted.weights'] = weightsOf(painted);
  out['painted.posed'] = posedOf(painted);
  out['painted.saved'] = weightsOf(roundTrip(painted));
  out['painted.gltf'] = storedOf(modelFromGltf(exportGlb(painted)));
  const merged = await example('juniper');
  mergeBone(merged, bone(merged, 'Chest'));
  paintSeries(merged);
  out['merged.stored'] = storedOf(merged);
  out['merged.weights'] = weightsOf(merged);
  const skeleton = await example('juniper');
  paintSeries(skeleton);
  const file = skeletonFile(skeleton);
  file.bones = file.bones.filter(b => b.name !== 'Shoulder.L').map(b => (b.name === 'Thigh.L' ? {...b, name: 'Leg.L'} : b));
  applySkeleton(skeleton, readSkeletonFile(file));
  out['skeleton.stored'] = storedOf(skeleton);
  out['skeleton.weights'] = weightsOf(skeleton);
  return out;
}

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const results = await goldenResults();
  if (process.argv[2] === 'write') writeFileSync(FIXTURE, JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, digest(v)])), null, 2) + '\n');
  else if (process.argv[2] === 'dump') writeFileSync(process.argv[3], JSON.stringify(results));
  else {
    // Which results differ from the recorded fixture.
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    for (const [k, v] of Object.entries(results)) console.log(digest(v) === expected[k] ? 'same   ' : 'CHANGED', k);
  }
}
