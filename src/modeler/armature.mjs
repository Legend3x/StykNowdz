/** 3D Nowdz skeleton: bones in model space (Y up) and automatic skin
 * weights. A bone is {id, name, head, tail, parent} where parent is another
 * bone's id or 0. Side bones end in ".L"/".R" as in Blender: the character
 * faces the front view, so its left (".L") is on +X. */
import {sub, dot, add, scale, length, bounds, transformMesh, objectMatrix} from './mesh.mjs';
import {evaluatePart} from './model.mjs';

export const sideOf = name => /\.L$/i.test(name) ? 'L' : /\.R$/i.test(name) ? 'R' : '';
export const otherSide = name => name.replace(/\.L$/, '.~').replace(/\.R$/, '.L').replace(/\.~$/, '.R').replace(/\.l$/, '.~').replace(/\.r$/, '.l').replace(/\.~$/, '.r');

export function addBone(model, {name = 'Bone', head, tail, parent = 0, face, strength, range}) {
  const bone = {id: model.nextId++, name: uniqueName(model, name), head: head.slice(), tail: tail.slice(), parent};
  if (face) setFace(bone, face);
  setPull(bone, {strength, range});
  model.bones.push(bone);
  return bone;
}
export function uniqueName(model, name) {
  const taken = new Set(model.bones.map(b => b.name));
  if (!taken.has(name)) return name;
  const side = name.match(/(\.[LR])$/i)?.[1] ?? '', base = side ? name.slice(0, -2) : name;
  for (let n = 2; ; n++) if (!taken.has(`${base}.${String(n).padStart(3, '0')}${side}`)) return `${base}.${String(n).padStart(3, '0')}${side}`;
}

/** How hard a bone pulls the skin around it in automatic weights. `strength`
 * scales its share against the bones beside it (0: it moves nothing, like a
 * bone with Deform off in Blender; 1 is the default; up to 2), and `range`, when
 * set, is the farthest a point can be from the bone and still follow it. */
export const STRENGTH_MAX = 2;
export function pullOf(bone) {
  const strength = Number.isFinite(bone?.strength) ? Math.max(0, Math.min(STRENGTH_MAX, bone.strength)) : 1;
  return {strength, range: Number.isFinite(bone?.range) && bone.range > 0 ? bone.range : 0};
}
export function setPull(bone, {strength, range} = {}) {
  if (strength !== undefined) { if (Number.isFinite(strength) && Math.abs(strength - 1) > 1e-9) bone.strength = Math.max(0, Math.min(STRENGTH_MAX, strength)); else delete bone.strength; }
  if (range !== undefined) { if (Number.isFinite(range) && range > 0) bone.range = Math.min(100, range); else delete bone.range; }
  return bone;
}

/** Bones ordered parents first. */
export function boneOrder(model) {
  const byId = new Map(model.bones.map(b => [b.id, b])), out = [], seen = new Set();
  const visit = (b, trail = new Set()) => {
    if (seen.has(b.id) || trail.has(b.id)) return;
    trail.add(b.id);
    const parent = byId.get(b.parent);
    if (parent) visit(parent, trail);
    seen.add(b.id); out.push(b);
  };
  model.bones.forEach(b => visit(b));
  return out;
}

/** Remove bones; children move up to the removed bone's parent. */
export function deleteBones(model, ids) {
  const byId = new Map(model.bones.map(b => [b.id, b]));
  const up = id => { let p = id; while (ids.has(p)) p = byId.get(p)?.parent ?? 0; return p; };
  for (const b of model.bones) if (!ids.has(b.id)) b.parent = up(b.parent);
  model.bones = model.bones.filter(b => !ids.has(b.id));
  for (const part of model.parts) if (ids.has(part.bone)) delete part.bone;
}

/** Make the -X side match the +X side (".L" → ".R"), creating missing bones. */
export function symmetrizeBones(model) {
  const byName = new Map(model.bones.map(b => [b.name, b])), byId = new Map(model.bones.map(b => [b.id, b]));
  for (const bone of boneOrder(model)) {
    if (sideOf(bone.name) !== 'L') continue;
    const name = otherSide(bone.name), parent = byId.get(bone.parent), parentName = parent ? (sideOf(parent.name) === 'L' ? otherSide(parent.name) : parent.name) : null;
    const mirror = p => [-p[0], p[1], p[2]], target = byName.get(name);
    const parentId = parentName ? byName.get(parentName)?.id ?? 0 : 0;
    const face = bone.face ? faceOf(bone) : null, {strength, range} = pullOf(bone);
    if (target) { target.head = mirror(bone.head); target.tail = mirror(bone.tail); target.parent = parentId; setFace(target, face); setPull(target, {strength, range}); }
    else { const created = addBone(model, {name, head: mirror(bone.head), tail: mirror(bone.tail), parent: parentId, face, strength, range}); byName.set(name, created); byId.set(created.id, created); }
  }
}

/** A humanoid skeleton fitted to the model, like the marker step of an
 * auto-rigger: `fitHumanoid` finds the hands, the crotch, the ankles, the toes
 * and the shoulders on the model itself, so cartoon proportions (a big head,
 * short legs, large shoes, arms out in a T or A) get bones where their joints
 * are. A model it can't read (arms down at the sides, no gap between the legs)
 * gets the proportions of an average adult fitted to its height and width. */
export function humanoidSkeleton(model, meshes) {
  const points = meshes.flatMap(m => m.verts);
  const fit = points.length ? fitHumanoid(meshes) : null;
  model.bones = [];
  const bone = (name, head, tail, parent = 0) => addBone(model, {name, head, tail, parent}).id;
  if (fit) {
    const {spine: [hipsAt, spineAt, chestAt, neckAt, headAt, top], arm, leg} = fit;
    const hips = bone('Hips', hipsAt, spineAt);
    const spine = bone('Spine', spineAt, chestAt, hips);
    const chest = bone('Chest', chestAt, neckAt, spine);
    const neck = bone('Neck', neckAt, headAt, chest);
    bone('Head', headAt, top, neck);
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const x = q => [q[0] * s, q[1], q[2]];
      const shoulder = bone(`Shoulder.${side}`, x(arm.clavicle), x(arm.shoulder), chest);
      const upper = bone(`UpperArm.${side}`, x(arm.shoulder), x(arm.elbow), shoulder);
      const lower = bone(`LowerArm.${side}`, x(arm.elbow), x(arm.wrist), upper);
      bone(`Hand.${side}`, x(arm.wrist), x(arm.tip), lower);
      const thigh = bone(`Thigh.${side}`, x(leg.hip), x(leg.knee));
      const shin = bone(`Shin.${side}`, x(leg.knee), x(leg.ankle), thigh);
      bone(`Foot.${side}`, x(leg.ankle), x(leg.toe), shin);
    }
    return model.bones;
  }
  const box = points.length ? bounds(points) : {min: [-.4, 0, -.2], max: [.4, 2, .2]};
  const h = Math.max(.1, box.max[1] - box.min[1]), y0 = box.min[1], w = Math.max(.1, (box.max[0] - box.min[0]) / 2), cz = (box.min[2] + box.max[2]) / 2;
  const at = (x, y) => [x * w, y0 + y * h, cz];
  // Proportions of an average adult; arms spread to the model's width.
  const hips = bone('Hips', at(0, .5), at(0, .57));
  const spine = bone('Spine', at(0, .57), at(0, .68), hips);
  const chest = bone('Chest', at(0, .68), at(0, .79), spine);
  const neck = bone('Neck', at(0, .79), at(0, .84), chest);
  bone('Head', at(0, .84), at(0, .98), neck);
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const shoulder = bone(`Shoulder.${side}`, at(s * .08, .79), at(s * .38, .79), chest);
    const upper = bone(`UpperArm.${side}`, at(s * .38, .79), at(s * .6, .6), shoulder);
    const lower = bone(`LowerArm.${side}`, at(s * .6, .6), at(s * .78, .41), upper);
    bone(`Hand.${side}`, at(s * .78, .41), at(s * .85, .33), lower);
    // Thighs hang from the figure's root, beside Hips, as in Pivot: bending the hips bends the body, not the legs.
    const thigh = bone(`Thigh.${side}`, at(s * .22, .5), at(s * .22, .27));
    const shin = bone(`Shin.${side}`, at(s * .22, .27), at(s * .22, .05), thigh);
    addBone(model, {name: `Foot.${side}`, head: at(s * .22, .05), tail: add(at(s * .22, .01), [0, 0, h * .07]), parent: shin});
  }
  return model.bones;
}

const median = values => { if (!values.length) return NaN; const v = values.slice().sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const quantile = (values, q) => { if (!values.length) return NaN; const v = values.slice().sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))]; };

/**
 * Joint positions read off a standing humanoid (feet down, +Y up, facing ±Z,
 * centred on X = 0 as the modeler mirrors it), for the left side (+X); the
 * right side is its mirror. Works from points alone, so a model in many
 * separate pieces (game exports) reads the same as one surface. Returns null
 * when the arms aren't held out from the body or the legs aren't apart.
 */
export function fitHumanoid(meshes) {
  const corners = meshes.flatMap(m => m.verts);
  if (!corners.length) return null;
  const box = bounds(corners), y0 = box.min[1], top = box.max[1], H = top - y0;
  if (!(H > 1e-6)) return null;
  // Read the surfaces, not just their corners: a low-poly box has no points in
  // its middle. Faces are sampled about every H/60.
  const points = corners.slice(), gap = H / 60;
  for (const m of meshes) for (const f of m.faces ?? []) for (let i = 1; i + 1 < f.v.length; i++) {
    const a = m.verts[f.v[0]], b = m.verts[f.v[i]], c = m.verts[f.v[i + 1]];
    const n = Math.min(40, Math.ceil(Math.max(length(sub(b, a)), length(sub(c, a)), length(sub(c, b))) / gap));
    if (n < 2) continue;
    for (let u = 0; u <= n; u++) for (let v = 0; u + v <= n; v++) if ((u && v) || u + v < n) points.push(add(a, add(scale(sub(b, a), u / n), scale(sub(c, a), v / n))));
  }
  const band = (lo, hi) => points.filter(p => p[1] >= y0 + lo * H && p[1] < y0 + hi * H);
  // Crotch: going up from the ankles, the first height where the middle (X ≈ 0)
  // fills in for good. Legs apart leave it empty below.
  const step = .02, mid = .025 * H, filled = [];
  for (let y = 0; y < .8; y += step) filled.push(band(y, y + step).some(p => Math.abs(p[0]) < mid));
  let crotch = -1;
  for (let i = Math.round(.25 / step); i + 3 < filled.length; i++) if (filled[i] && filled.slice(i, i + 4).filter(Boolean).length >= 3 && !filled.slice(Math.round(.12 / step), i).every(Boolean)) { crotch = i * step; break; }
  if (crotch < .25 || crotch > .65) return null;
  // Legs: the middle of each leg halfway up, and the torso's half-width just above the crotch.
  const legBand = band(crotch * .55, crotch * .9).filter(p => p[0] > mid * .5);
  const torso = band(crotch + .01, crotch + .08);
  if (legBand.length < 2 || torso.length < 2) return null;
  // The trunk is the run of points out from the middle with no wide gap (arms
  // held out start past one, even on a short cartoon trunk).
  const out = torso.map(p => Math.abs(p[0])).sort((a, b) => a - b);
  let reach = out[0]; for (const x of out) { if (x - reach > .04 * H) break; reach = x; }
  const legX = median(legBand.map(p => p[0])), torsoHalf = Math.max(legX, reach);
  // Arms: the hand tip is the widest point; held out (T or A pose) it reaches well past the torso.
  const tipX = box.max[0];
  if (tipX < torsoHalf * 2.4 || tipX < .18 * H) return null;
  const tipPts = points.filter(p => p[0] > tipX - .04 * H);
  const tip = [tipX, median(tipPts.map(p => p[1])), median(tipPts.map(p => p[2]))];
  // Follow the arm in from the hand, keeping to the points around the line so
  // hair or quills beside the shoulder don't pull it.
  const shoulderX = Math.min(tipX * .45, torsoHalf * 1.35), radius = .09 * H, slab = .025 * H, track = [];
  let c = [tip[1], tip[2]];
  for (let x = tipX; x > shoulderX; x -= slab) {
    const near = points.filter(p => p[0] <= x && p[0] > x - slab && Math.hypot(p[1] - c[0], p[2] - c[1]) < radius);
    if (near.length) c = [median(near.map(p => p[1])), median(near.map(p => p[2]))];
    track.push({x: x - slab / 2, y: c[0], z: c[1], n: near.length});
  }
  // Wrist: hands (fingers, a fist, a glove) are denser than forearms. From the
  // densest slab in the outer half, go in while it stays dense.
  const span = tipX - shoulderX, outer = track.filter(t => t.x > shoulderX + span * .5);
  const densest = outer.reduce((a, t) => t.n > a.n ? t : a, outer[0] ?? {n: 0, x: shoulderX + span * .8});
  // A hand no denser than the arm (a block on a robot) gives no clue: it is
  // then the usual quarter of the reach, as on a person.
  const armDensity = median(track.filter(t => t.x <= shoulderX + span * .5).map(t => t.n));
  let wristX = densest.x;
  if (densest.n >= Math.max(1, armDensity) * 1.5) {
    for (const t of track) if (t.x < densest.x) { if (t.n >= densest.n * .35) wristX = t.x; else break; }
    wristX = shoulderX + span * Math.min(.85, Math.max(.6, (wristX - slab / 2 - shoulderX) / span));
  } else wristX = shoulderX + span * .76;
  // The arm's line: a straight fit through the forearm and upper arm, leaving
  // out the hand and the slabs by the shoulder (hair or quills beside it would
  // pull the line up). Theil–Sen (the median of the slopes between slabs), so a
  // stray slab on a low-poly arm doesn't tilt it.
  const fitted = track.filter(t => t.n && t.x <= wristX && t.x >= shoulderX + span * .15);
  const line = k => {
    if (fitted.length < 2) { const v = median((fitted.length ? fitted : track).map(t => t[k])); return () => v; }
    const slopes = [];
    for (let a = 0; a < fitted.length; a++) for (let b = a + 1; b < fitted.length; b++) if (Math.abs(fitted[a].x - fitted[b].x) > 1e-9) slopes.push((fitted[a][k] - fitted[b][k]) / (fitted[a].x - fitted[b].x));
    const slope = median(slopes), base = median(fitted.map(t => t[k] - slope * t.x));
    return x => base + slope * x;
  };
  const ly = line('y'), lz = line('z'), on = x => [x, ly(x), lz(x)];
  const shoulder = on(shoulderX), elbow = on(shoulderX + (wristX - shoulderX) * .5), wrist = on(wristX);
  // Ankles: going up from the floor, where the foot (long front to back) narrows into the leg.
  const legDepth = (lo, hi) => { const q = band(lo, hi).filter(p => p[0] > 0 && p[0] < torsoHalf * 2.5).map(p => p[2]); return q.length > 1 ? Math.max(...q) - Math.min(...q) : 0; };
  const shin = legDepth(crotch * .55, crotch * .85) || .05 * H;
  let ankle = .05;
  for (let y = .02; y < crotch * .6; y += step) if (legDepth(y, y + step) > shin * 2.2) ankle = y + step;
  ankle = Math.min(ankle, crotch * .5);
  // Facing: the feet reach further toward the front than the heels.
  const feet = band(0, ankle).filter(p => p[0] > 0), legs = band(ankle, crotch).filter(p => p[0] > 0);
  const legZ = legs.length ? median(legs.map(p => p[2])) : (box.min[2] + box.max[2]) / 2;
  const toeFront = feet.length ? Math.max(...feet.map(p => p[2])) : legZ, toeBack = feet.length ? Math.min(...feet.map(p => p[2])) : legZ;
  const front = toeFront - legZ >= legZ - toeBack ? 1 : -1, toeZ = front > 0 ? toeFront : toeBack;
  const footX = feet.length ? median(feet.map(p => p[0])) : legX;
  const at = (x, y, z) => [x, y0 + y * H, z];
  const hip = at(legX, crotch, legZ), ankleAt = at(legX, ankle, legZ);
  const knee = add(scale(add(hip, ankleAt), .5), [0, 0, front * .01 * H]);
  const toe = [footX, y0 + Math.min(ankle * .4, .03) * H, legZ + (toeZ - legZ) * .8];
  // The body's line: the middle of the trunk front to back at each height.
  const trunkZ = (lo, hi) => { const q = band(lo, hi).filter(p => Math.abs(p[0]) < torsoHalf).map(p => p[2]); return q.length ? median(q) : legZ; };
  const shoulderY = (shoulder[1] - y0) / H, chestY = crotch + (shoulderY - crotch) * .6;
  const neckY = Math.min(.97, Math.max(shoulderY, crotch + .05) + (1 - Math.max(shoulderY, crotch + .05)) * .2), headY = Math.min(.985, neckY + (1 - neckY) * .12);
  const spineAt = (y, z) => at(0, y, z), hipsZ = trunkZ(crotch, crotch + .05);
  const chestZ = trunkZ(chestY - .03, chestY + .03), headZ = (chestZ + trunkZ(headY, 1.01)) / 2;
  const spine = [spineAt(crotch, hipsZ), spineAt(crotch + (shoulderY - crotch) * .3, trunkZ(crotch + .05, chestY)), spineAt(chestY, chestZ), spineAt(neckY, (chestZ + headZ) / 2), spineAt(headY, headZ)];
  spine.push(spineAt(1, spine[4][2]));
  const clavicle = [Math.min(shoulder[0] * .3, torsoHalf * .4), shoulder[1], shoulder[2]];
  return {spine, arm: {clavicle, shoulder, elbow, wrist, tip}, leg: {hip, knee, ankle: ankleAt, toe}, front};
}

/** Distance from p to the segment a→b. */
export function segmentDistance(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-12, dot(ab, ab))));
  return length(sub(p, add(a, scale(ab, t))));
}

/**
 * Skin weights for world-space vertices: up to four bones each, weights
 * summing to one. A part bound to a bone (`part.bone`) follows it rigidly (its
 * mirrored half follows the opposite-side bone), and so does a part whose
 * vertices are at least `rigidShare` nearest one bone. Otherwise each vertex blends
 * its nearest bones among those running through its part, limited to that
 * nearest bone's parent and children, so a torso never follows an arm hanging
 * beside it. Weights fall off with distance, skip bones on the other side of
 * the middle, and are smoothed over the surface so joints bend softly.
 */
/** A part's skin weights for `mesh` (the part evaluated: Mirror, Solidify and
 * Smooth applied, in model space): automatic (autoWeights), except where the
 * part's own points carry weights (part.mesh.vdata.skin), painted in Bones mode
 * or kept from an imported rig. Those travel with the shape through Mirror
 * (left and right bones swapped) and Smooth, and where a smoothed point lies
 * between carried and automatic ones it blends the two by how much of it comes
 * from carried points, so painting never changes weights away from the brush.
 * `{cage: true}`: `mesh` is the part's own points (model space), not evaluated. */
export function partWeights(model, mesh, part, options = {}) {
  const kept = part?.mesh?.vdata?.skin;
  if (!kept || !Object.keys(kept).length) return autoWeights(model, mesh, part, options);
  const full = completeSkin(model, part, options), n = mesh.verts.length, resolve = sideResolver(model);
  const out = {bones: new Array(n * 4).fill(0), weights: new Array(n * 4).fill(0)};
  const write = (v, pairs) => pairs.forEach(([b, w], k) => { out.bones[v * 4 + k] = b; out.weights[v * 4 + k] = w; });
  if (options.cage) { for (let v = 0; v < n; v++) if (full[v]) write(v, full[v]); return out; }
  // How much of each smoothed point comes from carried points: carried as a
  // point value (0 on carried points, as Smooth averages a missing value as 1).
  const share = Object.fromEntries(Object.keys(kept).map(v => [v, 0]));
  const shaped = evaluatePart({...part, mesh: {...part.mesh, vdata: {...part.mesh.vdata, skin: full, line: share}}});
  const auto = autoWeights(model, mesh, part, options);
  // Not this part's shape after all (some other evaluation): weights from its own surface.
  if (shaped.verts.length !== n) return auto;
  for (let v = 0; v < n; v++) {
    const from = shaped.vdata?.line?.[v], m = from === undefined ? 0 : Math.max(0, Math.min(1, 1 - from));
    const own = m > 1e-6 ? cleanPairs(model, shaped.vdata?.skin?.[v], resolve) : null;
    if (!own) { for (let k = 0; k < 4; k++) { out.bones[v * 4 + k] = auto.bones[v * 4 + k]; out.weights[v * 4 + k] = auto.weights[v * 4 + k]; } continue; }
    const mix = own.map(([b, w]) => [b, w * m]);
    for (let k = 0; k < 4; k++) if (auto.bones[v * 4 + k] && auto.weights[v * 4 + k] > 0) mix.push([auto.bones[v * 4 + k], auto.weights[v * 4 + k] * (1 - m)]);
    write(v, cleanPairs(model, mix, resolve) ?? []);
  }
  return out;
}

/** Bones mirrored across the middle: weights on a Mirror copy name a bone by
 * its negated id, meaning the same bone on the other side (Arm.L for Arm.R). */
export function sideResolver(model) {
  const byName = new Map(model.bones.map(b => [b.name, b.id])), byId = new Map(model.bones.map(b => [b.id, b]));
  return id => id >= 0 ? id : (byName.get(otherSide(byId.get(-id)?.name ?? '')) ?? -id);
}
/** A point's weights: real bones only, the four largest, adding up to 1; null when none. */
function cleanPairs(model, list, resolve = sideResolver(model)) {
  if (!Array.isArray(list)) return null;
  const ids = new Set(model.bones.map(b => b.id)), sum = new Map();
  for (const [b, w] of list) { const id = resolve(b); if (ids.has(id) && w > 0) sum.set(id, (sum.get(id) ?? 0) + w); }
  const pairs = [...sum].sort((x, y) => y[1] - x[1]).slice(0, 4), total = pairs.reduce((t, [, w]) => t + w, 0);
  return total > 0 ? pairs.map(([b, w]) => [b, w / total]) : null;
}

/** Weights for every point of a part's own points: those it carries, automatic
 * for the rest (worked out on its points in model space). {[i]: [[bone, w], …]}. */
export function completeSkin(model, part, options = {}) {
  const cage = transformMesh(part.mesh, objectMatrix(part)), kept = part.mesh.vdata?.skin ?? {}, auto = autoWeights(model, cage, part, options), out = {};
  for (let v = 0; v < cage.verts.length; v++) {
    const own = cleanPairs(model, kept[v]);
    if (own) { out[v] = own; continue; }
    const pairs = [];
    for (let k = 0; k < 4; k++) if (auto.bones[v * 4 + k] && auto.weights[v * 4 + k] > 0) pairs.push([auto.bones[v * 4 + k], auto.weights[v * 4 + k]]);
    if (pairs.length) out[v] = pairs;
  }
  return out;
}

export function autoWeights(model, mesh, part, options = {}) {
  const face = model.bones.filter(b => b.face);
  if (!face.length) return bodyWeights(model, mesh, part, options);
  // A part that follows a face bone (an eyeball on its Eye bone) follows it rigidly.
  if (part?.bone && face.some(b => b.id === part.bone)) return bodyWeights(model, mesh, part, options);
  const body = bodyWeights({...model, bones: model.bones.filter(b => !b.face)}, mesh, part, options);
  return part?.bone ? body : faceWeights(model, mesh, body);
}

/** A mesh's separate pieces: lists of point indices joined by faces or edges
 * (points on nothing are pieces of their own). */
export function piecesOf(mesh) {
  const n = mesh.verts.length, up = Int32Array.from({length: n}, (_, i) => i);
  const find = i => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) up[a] = b; };
  for (const f of mesh.faces) for (let i = 1; i < f.v.length; i++) join(f.v[0], f.v[i]);
  for (const [a, b] of mesh.edges ?? []) join(a, b);
  const pieces = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!pieces.has(r)) pieces.set(r, []); pieces.get(r).push(i); }
  return [...pieces.values()];
}

/** Whether bones weigh the skin by themselves (Automatic weights, on unless the model turns it off). */
export const automaticWeights = model => model.autoWeights !== false;

/** The bone points with no weights of their own follow when Automatic weights is
 * off: their part's "Moves with" bone, else the skeleton's root (they move only
 * with the whole figure), as unweighted points in Blender move only with the armature. */
export function holdingBone(model, part) {
  const body = model.bones.filter(b => !b.face), ids = new Set(body.map(b => b.id));
  if (part?.bone && model.bones.some(b => b.id === part.bone)) return part.bone;
  return (body.find(b => !ids.has(b.parent)) ?? body[0])?.id ?? 0;
}

function bodyWeights(model, mesh, part, {smoothing = 2, rigidShare = .7} = {}) {
  const n = mesh.verts.length, everyBone = new Map(model.bones.map(b => [b.id, b]));
  if (!automaticWeights(model)) {
    const hold = holdingBone(model, part), out = {bones: new Array(n * 4).fill(0), weights: new Array(n * 4).fill(0)};
    if (hold) for (let v = 0; v < n; v++) { out.bones[v * 4] = hold; out.weights[v * 4] = 1; }
    return out;
  }
  // Bones with no strength move nothing: weights go to the bones around them,
  // and their parent and children count as each other's neighbours.
  const pulls = new Map(model.bones.map(b => [b.id, pullOf(b)]));
  let bones = model.bones.filter(b => pulls.get(b.id).strength > 0);
  const bound = part?.bone && everyBone.get(part.bone);
  if (bound && !bones.includes(bound)) bones = [...bones, bound]; // a part bound to a bone always follows it
  if (!bones.length) return {bones: new Array(n * 4).fill(0), weights: new Array(n * 4).fill(0)};
  const byId = new Map(bones.map(b => [b.id, b])), byName = new Map(bones.map(b => [b.name, b]));
  const rigid = bound;
  const upOf = b => { let p = b.parent; const seen = new Set(); while (p && !byId.has(p) && everyBone.has(p) && !seen.has(p)) { seen.add(p); p = everyBone.get(p).parent; } return byId.has(p) ? p : 0; };
  const deformParent = new Map(bones.map(b => [b.id, upOf(b)]));
  const neighbours = new Map(bones.map(b => [b.id, new Set([b.id, deformParent.get(b.id), ...bones.filter(c => deformParent.get(c.id) === b.id).map(c => c.id)].filter(Boolean))]));
  const sideBones = p => { const side = p[0] > 1e-3 ? 'L' : p[0] < -1e-3 ? 'R' : ''; return bones.filter(b => !side || !sideOf(b.name) || sideOf(b.name) === side); };
  // A part can be several separate pieces (two legs, two hands, once Mirror is
  // applied or after an OBJ round trip): each piece is judged on its own.
  const islands = piecesOf(mesh);
  const islandOf = new Int32Array(n).fill(0);
  islands.forEach((members, k) => { for (const i of members) islandOf[i] = k; });
  // Bones that run through a piece (sampled along the bone, inside its slightly grown bounds).
  // A torso never takes the upper arm hanging beside it; a hip still takes the thighs that start inside it.
  // A bone that only touches the piece's edge (a thigh starting just under the shirt) is not one of its bones.
  const neckBone = byName.get('Neck'), headBone = byName.get('Head'), upperArms = bones.filter(b => /^UpperArm\./.test(b.name));
  const candidatesOf = members => {
    const box = members.length ? bounds(members.map(i => mesh.verts[i])) : {min: [0, 0, 0], max: [0, 0, 0]};
    const grow = Math.max(...[0, 1, 2].map(k => box.max[k] - box.min[k])) * .08;
    const inside = (q, g) => [0, 1, 2].every(k => q[k] >= box.min[k] - g && q[k] <= box.max[k] + g);
    let found = new Set(bones.filter(b => {
      const samples = Array.from({length: 9}, (_, i) => add(b.head, scale(sub(b.tail, b.head), i / 8)));
      return samples.some(q => inside(q, 0)) || samples.filter(q => inside(q, grow)).length >= 2;
    }).map(b => b.id));
    if (!found.size) found = new Set(bones.map(b => b.id));
    // A humanoid's head region: a piece centred above the base of the neck and
    // inside the shoulders (hair, quills, ears, a hat) moves with the head and
    // neck only, even where it hangs down beside an arm or behind the chest.
    if (neckBone && headBone && members.length) {
      const centre = scale(members.reduce((acc, i) => add(acc, mesh.verts[i]), [0, 0, 0]), 1 / members.length);
      const within = upperArms.length ? Math.min(...upperArms.map(b => Math.abs(b.head[0]))) : Infinity;
      if (centre[1] > neckBone.head[1] && Math.abs(centre[0]) < within) found = new Set([neckBone.id, headBone.id]);
    }
    return found;
  };
  const pieceCandidates = islands.map(candidatesOf);
  const candidates = new Set(pieceCandidates.flatMap(c => [...c]));
  const nearest = (p, pool) => sideBones(p).filter(b => !pool || pool.has(b.id)).reduce((best, b) => { const d = segmentDistance(p, b.head, b.tail); return d < best[1] ? [b.id, d] : best; }, [0, Infinity])[0];
  // Root bones (Hips and the thighs) meet at the figure's root, so a part centred on one of them blends with the others.
  const partCentre = byId.get(nearest(scale(mesh.verts.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / Math.max(1, n)), candidates));
  if (partCentre && !partCentre.parent) for (const b of bones) if (!b.parent) for (const c of bones) if (!c.parent) neighbours.get(b.id).add(c.id);
  // Each vertex blends its nearest bone (among those in the part) with that bone's parent and children.
  const allowedFor = mesh.verts.map((p, i) => {
    const own = pieceCandidates[islandOf[i]] ?? candidates, centre = nearest(p, own) || nearest(p);
    return new Set([...(neighbours.get(centre) ?? [centre])].filter(id => own.has(id) || id === centre));
  });
  // A part that lies along one bone (a sleeve, a forearm, a shoe, the head) follows that bone rigidly, so it
  // keeps its shape instead of pinching where it touches the next bone. Mirrored parts are judged per side.
  const sides = part?.mirror ? [v => v[0] > 1e-3, v => v[0] < -1e-3, v => Math.abs(v[0]) <= 1e-3] : [() => true];
  const groups = islands.flatMap((members, k) => sides.map(test => [members.filter(i => test(mesh.verts[i])), pieceCandidates[k]]));
  const singleOf = new Array(n).fill(null);
  const alongMiddle = (p, b) => { const ax = sub(b.tail, b.head), l2 = dot(ax, ax), t = l2 > 1e-12 ? dot(sub(p, b.head), ax) / l2 : -1; return t > .15 && t < .85; };
  if (!rigid) for (const [members, own] of groups) {
    if (!members.length) continue;
    const centre = scale(members.reduce((acc, i) => add(acc, mesh.verts[i]), [0, 0, 0]), 1 / members.length);
    const bone = byId.get(nearest(centre, own) || nearest(centre));
    if (!bone) continue;
    const axis = sub(bone.tail, bone.head), len = length(axis);
    if (len < 1e-9) continue;
    const margin = len * .35, along = members.filter(i => { const t = dot(sub(mesh.verts[i], bone.head), axis) / len; return t >= -margin && t <= len + margin; }).length;
    // ...unless a good share of it runs on past a joint onto the next bone (a
    // leg in one piece from hip to ankle, a shoe with the shin), which must bend there.
    // (A short parent, such as a neck under a head, carries no part of its own.)
    const hasChild = bones.some(c => deformParent.get(c.id) === bone.id), up = byId.get(deformParent.get(bone.id));
    const longUp = up && length(sub(up.tail, up.head)) >= len * .4, past = members.filter(i => {
      const p = mesh.verts[i], t = dot(sub(p, bone.head), axis) / len;
      // Beyond either end, or along the parent bone itself, not just by the
      // joint (a shoe in one piece with the shin).
      return (hasChild && t > len + margin) || (up && (t < -margin || longUp && alongMiddle(p, up) && segmentDistance(p, up.head, up.tail) < segmentDistance(p, bone.head, bone.tail)));
    }).length;
    if (along / members.length >= rigidShare && past / members.length < .12) for (const i of members) singleOf[i] = bone.id;
  }
  const lists = mesh.verts.map((p, v) => {
    if (rigid) {
      const opposite = p[0] < -1e-6 && sideOf(rigid.name) ? byName.get(otherSide(rigid.name)) : null;
      return new Map([[(opposite ?? rigid).id, 1]]);
    }
    if (singleOf[v]) return new Map([[singleOf[v], 1]]);
    const allowed = allowedFor[v];
    let scored = sideBones(p).filter(b => allowed.has(b.id)).map(b => [b.id, segmentDistance(p, b.head, b.tail)]).sort((a, b) => a[1] - b[1]);
    // A bone with a range lets go of points beyond it (unless no other bone is left to take them).
    const reached = scored.filter(([id, d]) => !pulls.get(id).range || d <= pulls.get(id).range);
    if (reached.length) scored = reached;
    scored = scored.slice(0, 4);
    const closest = scored[0]?.[1] ?? 0, out = new Map();
    for (const [id, d] of scored) {
      const {strength, range} = pulls.get(id);
      // Strength scales the bone's share (cubed, so the slider is felt against the steep distance falloff);
      // inside a range the pull also fades out towards its edge.
      const fade = range ? Math.min(1, Math.max(0, 1 - d / range) * 4) : 1;
      const w = strength ** 3 * fade / Math.pow(Math.max(1e-4, d) / Math.max(1e-4, closest), 6);
      if (w > .02) out.set(id, w);
    }
    if (!out.size) out.set(nearest(p) || bones[0].id, 1);
    return out;
  });
  if (!rigid) for (let k = 0; k < smoothing; k++) {
    // Average with neighbours over the faces, keeping each vertex's allowed bones.
    const next = lists.map(m => new Map(m));
    for (const f of mesh.faces) for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      for (const [x, y] of [[a, b], [b, a]]) if (!singleOf[x]) for (const [id, w] of lists[y]) if (allowedFor[x].has(id)) next[x].set(id, (next[x].get(id) ?? 0) + w * .25);
    }
    next.forEach((m, i) => { lists[i] = m; });
  }
  // Smoothing must not carry a bone past its range.
  if (!rigid && [...pulls.values()].some(q => q.range)) lists.forEach((m, v) => {
    if (singleOf[v]) return;
    for (const id of [...m.keys()]) { const {range} = pulls.get(id) ?? {}; if (range && m.size > 1 && segmentDistance(mesh.verts[v], byId.get(id).head, byId.get(id).tail) > range) m.delete(id); }
  });
  const outBones = [], outWeights = [];
  for (const m of lists) {
    let top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const raw = top.reduce((s, [, w]) => s + w, 0) || 1;
    top = top.filter(([, w]) => w / raw >= 1e-3);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const [id, w] = top[k] ?? [0, 0], value = k === top.length - 1 ? Math.max(0, 1 - total) : Math.round(w / sum * 1e6) / 1e6;
      outBones.push(id); outWeights.push(id ? value : 0); total += id ? value : 0;
    }
  }
  return {bones: outBones, weights: outWeights};
}

/** The skeleton that matches primitives.baseCharacter() exactly. */
export function baseCharacterSkeleton(model) {
  model.bones = [];
  const bone = (name, head, tail, parent = 0) => addBone(model, {name, head, tail, parent}).id;
  const hips = bone('Hips', [0, .86, 0], [0, 1.0, 0]);
  const spine = bone('Spine', [0, 1.0, 0], [0, 1.2, 0], hips);
  const chest = bone('Chest', [0, 1.2, 0], [0, 1.44, 0], spine);
  const neck = bone('Neck', [0, 1.44, 0], [0, 1.58, 0], chest);
  bone('Head', [0, 1.58, 0], [0, 1.95, 0], neck);
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const shoulder = bone(`Shoulder.${side}`, [s * .05, 1.42, 0], [s * .3, 1.44, 0], chest);
    const upper = bone(`UpperArm.${side}`, [s * .3, 1.44, 0], [s * .36, .95, 0], shoulder);
    const lower = bone(`LowerArm.${side}`, [s * .36, .95, 0], [s * .39, .57, 0], upper);
    bone(`Hand.${side}`, [s * .39, .57, 0], [s * .41, .42, 0], lower);
    const thigh = bone(`Thigh.${side}`, [s * .11, .86, 0], [s * .11, .43, 0]);
    const shin = bone(`Shin.${side}`, [s * .11, .43, 0], [s * .11, .07, 0], thigh);
    bone(`Foot.${side}`, [s * .11, .07, 0], [s * .11, .03, .16], shin);
  }
  return model.bones;
}

// ---------- face rig ----------
/** Face bones work like any other joint on the stage (they turn about their
 * head), but they are small controls laid over the head: they don't take part
 * in the body's weights, and each pulls the skin around its tip, fading out over
 * `reach`. `cut` keeps a bone to the skin below (a jaw, a lower lip) or above
 * (an upper lip) its own head, so opening the mouth doesn't drag the upper lip. */
export const FACE_CUTS = ['below', 'above'];
export function faceOf(bone) { return {reach: Number.isFinite(bone.reach) ? bone.reach : .05, ...(FACE_CUTS.includes(bone.cut) ? {cut: bone.cut} : {})}; }
export function setFace(bone, face) {
  if (!face) { delete bone.face; delete bone.reach; delete bone.cut; return bone; }
  const reach = Number(face.reach);
  bone.face = true; bone.reach = Number.isFinite(reach) ? Math.max(0, Math.min(10, reach)) : .05;
  if (FACE_CUTS.includes(face.cut)) bone.cut = face.cut; else delete bone.cut;
  return bone;
}
const smoothstep = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

/** Blend face bones into body weights (four bones per vertex, as autoWeights returns). */
function faceWeights(model, mesh, body) {
  const byId = new Map(model.bones.map(b => [b.id, b])), face = model.bones.filter(b => b.face && b.reach > 0);
  // The body bone a face bone sits on (the head): only skin that mostly follows it takes the face bones.
  const rootOf = b => { let at = b, guard = 0; while (at?.face && guard++ < 64) at = byId.get(at.parent); return at && !at.face ? at.id : 0; };
  const roots = new Map(face.map(b => [b.id, rootOf(b)]));
  const outBones = [], outWeights = [];
  mesh.verts.forEach((p, v) => {
    const base = new Map();
    for (let k = 0; k < 4; k++) { const id = body.bones[v * 4 + k], w = body.weights[v * 4 + k]; if (id && w > 0) base.set(id, (base.get(id) ?? 0) + w); }
    const side = p[0] > 1e-3 ? 'L' : p[0] < -1e-3 ? 'R' : '';
    const pulls = new Map();
    for (const b of face) {
      if (side && sideOf(b.name) && sideOf(b.name) !== side) continue;
      const root = roots.get(b.id);
      if (root && (base.get(root) ?? 0) < .5) continue;
      let w = smoothstep(1 - length(sub(p, b.tail)) / b.reach);
      if (!w) continue;
      if (b.cut) { const band = Math.max(1e-4, b.reach * .12), above = (p[1] - b.head[1]) / band; w *= smoothstep(b.cut === 'below' ? .5 - above : .5 + above); }
      if (w > .01) pulls.set(b.id, w);
    }
    let out = base;
    if (pulls.size) {
      // Overlapping pulls share the vertex (sharper ones win); the body keeps whatever they leave.
      const total = [...pulls.values()].reduce((a, w) => a + w, 0), share = Math.min(1, total);
      const squares = [...pulls].map(([id, w]) => [id, w * w]), sq = squares.reduce((a, [, w]) => a + w, 0);
      out = new Map([...base].map(([id, w]) => [id, w * (1 - share)]));
      for (const [id, w] of squares) out.set(id, (out.get(id) ?? 0) + share * w / sq);
    }
    let top = [...out].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (!top.length) top = [[0, 0]];
    const sum = top.reduce((a, [, w]) => a + w, 0) || 1;
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const [id, w] = top[k] ?? [0, 0], value = !id ? 0 : k === top.length - 1 ? Math.max(0, 1 - total) : Math.round(w / sum * 1e6) / 1e6;
      outBones.push(id); outWeights.push(value); total += value;
    }
  });
  return {bones: outBones, weights: outWeights};
}

/** The head bone face bones hang from: a bone named Head (the highest if several). */
export function headBone(model) {
  const heads = model.bones.filter(b => !b.face && /head/i.test(b.name));
  const exact = heads.filter(b => /^head(\.\d+)?$/i.test(b.name));
  return (exact.length ? exact : heads).sort((a, b) => Math.max(b.head[1], b.tail[1]) - Math.max(a.head[1], a.tail[1]))[0] ?? null;
}

/** Face bones fitted to the head: jaw, lips, lip corners, brows, upper lids and
 * eyes, placed on the face's surface (the head faces the front view, +Z). Any
 * face bones already there are replaced. With no Head bone, one is added through
 * the model (for a head modelled on its own). Returns the new face bones. */
export function faceSkeleton(model, meshes) {
  model.bones.filter(b => b.face).forEach(b => { for (const c of model.bones) if (c.parent === b.id && !c.face) c.parent = b.parent; });
  for (const part of model.parts) if (part.bone && model.bones.some(b => b.face && b.id === part.bone)) delete part.bone;
  model.bones = model.bones.filter(b => !b.face);
  const all = meshes.flatMap(m => m.verts);
  let head = headBone(model);
  if (!head) {
    const box = all.length ? bounds(all) : {min: [-.3, 0, -.3], max: [.3, .8, .3]}, cz = (box.min[2] + box.max[2]) / 2;
    head = addBone(model, {name: 'Head', head: [0, box.min[1], cz], tail: [0, box.max[1], cz]});
  }
  const lo = head.head[1] <= head.tail[1] ? head.head : head.tail, hi = lo === head.head ? head.tail : head.head;
  const xc = (head.head[0] + head.tail[0]) / 2;
  let y0 = lo[1], y1 = hi[1], H = Math.max(1e-3, y1 - y0);
  const near = all.filter(p => p[1] >= y0 - H * .05 && p[1] <= y1 + H * .3 && Math.abs(p[0] - xc) <= H * .9);
  if (near.length) { y1 = Math.max(y1, ...near.map(p => p[1])); H = Math.max(1e-3, y1 - y0); }
  const band = near.filter(p => p[1] >= y0 + H * .25 && p[1] <= y0 + H * .65);
  const xHalf = band.length ? Math.max(H * .15, ...band.map(p => Math.abs(p[0] - xc))) : H * .35;
  const zFront = band.length ? Math.max(...band.map(p => p[2])) : lo[2] + H * .4, zBack = band.length ? Math.min(...band.map(p => p[2])) : lo[2] - H * .4;
  const depth = Math.max(H * .2, zFront - zBack);
  // The face's surface in front of (x, y): the frontmost point nearby, else a rounded guess.
  const surf = (x, y) => {
    const close = near.filter(p => Math.abs(p[1] - y) < H * .07 && Math.abs(p[0] - x) < xHalf * .2);
    if (close.length) return Math.max(...close.map(p => p[2]));
    const u = Math.min(1, Math.abs(x - xc) / xHalf);
    return zBack + depth / 2 + depth / 2 * Math.sqrt(Math.max(0, 1 - u * u));
  };
  const mouthY = y0 + H * .22, eyeY = y0 + H * .45, browY = y0 + H * .58, inset = H * .02;
  const front = (x, y, back = inset) => [x, y, surf(x, y) - back];
  const added = [];
  const make = (name, from, to, parent, face) => { const b = addBone(model, {name, head: from, tail: to, parent, face}); added.push(b); return b; };
  const mouthBack = front(xc, mouthY, H * .12);
  const jaw = make('Jaw', [xc, mouthY, zBack + depth * .35], front(xc, y0 + H * .04, H * .03), head.id, {reach: H * .5, cut: 'below'});
  make('LipLower', mouthBack, front(xc, mouthY - H * .06), jaw.id, {reach: H * .07, cut: 'below'});
  make('LipUpper', mouthBack, front(xc, mouthY + H * .06), head.id, {reach: H * .07, cut: 'above'});
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const at = k => xc + s * k * xHalf;
    make(`LipCorner.${side}`, front(xc, mouthY, H * .14), front(at(.32), mouthY), head.id, {reach: H * .09});
    make(`Brow.${side}`, front(at(.16), browY, H * .05), front(at(.72), browY + H * .015), head.id, {reach: H * .14});
    const eye = front(at(.42), eyeY, H * .1);
    make(`Lid.${side}`, eye, front(at(.42), eyeY + H * .07), head.id, {reach: H * .07});
    make(`Eye.${side}`, eye, add(eye, [0, 0, H * .14]), head.id, {reach: 0});
  }
  return added;
}
