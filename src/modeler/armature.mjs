/** Blender lite skeleton: bones in model space (Y up) and automatic skin
 * weights. A bone is {id, name, head, tail, parent} where parent is another
 * bone's id or 0. Side bones end in ".L"/".R" as in Blender: the character
 * faces the front view, so its left (".L") is on +X. */
import {sub, dot, add, scale, length, bounds} from './mesh.mjs';

export const sideOf = name => /\.L$/i.test(name) ? 'L' : /\.R$/i.test(name) ? 'R' : '';
export const otherSide = name => name.replace(/\.L$/, '.~').replace(/\.R$/, '.L').replace(/\.~$/, '.R').replace(/\.l$/, '.~').replace(/\.r$/, '.l').replace(/\.~$/, '.r');

export function addBone(model, {name = 'Bone', head, tail, parent = 0, face}) {
  const bone = {id: model.nextId++, name: uniqueName(model, name), head: head.slice(), tail: tail.slice(), parent};
  if (face) setFace(bone, face);
  model.bones.push(bone);
  return bone;
}
export function uniqueName(model, name) {
  const taken = new Set(model.bones.map(b => b.name));
  if (!taken.has(name)) return name;
  const side = name.match(/(\.[LR])$/i)?.[1] ?? '', base = side ? name.slice(0, -2) : name;
  for (let n = 2; ; n++) if (!taken.has(`${base}.${String(n).padStart(3, '0')}${side}`)) return `${base}.${String(n).padStart(3, '0')}${side}`;
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
    const face = bone.face ? faceOf(bone) : null;
    if (target) { target.head = mirror(bone.head); target.tail = mirror(bone.tail); target.parent = parentId; setFace(target, face); }
    else { const created = addBone(model, {name, head: mirror(bone.head), tail: mirror(bone.tail), parent: parentId, face}); byName.set(name, created); byId.set(created.id, created); }
  }
}

/** A humanoid skeleton fitted to the model's height and width (feet at the lowest point). */
export function humanoidSkeleton(model, meshes) {
  const points = meshes.flatMap(m => m.verts), box = points.length ? bounds(points) : {min: [-.4, 0, -.2], max: [.4, 2, .2]};
  const h = Math.max(.1, box.max[1] - box.min[1]), y0 = box.min[1], w = Math.max(.1, (box.max[0] - box.min[0]) / 2), cz = (box.min[2] + box.max[2]) / 2;
  const at = (x, y) => [x * w, y0 + y * h, cz];
  model.bones = [];
  const bone = (name, head, tail, parent = 0) => addBone(model, {name, head, tail, parent}).id;
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
    const foot = addBone(model, {name: `Foot.${side}`, head: at(s * .22, .05), tail: add(at(s * .22, .01), [0, 0, h * .07]), parent: shin});
    void foot;
  }
  return model.bones;
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
export function autoWeights(model, mesh, part, options = {}) {
  const face = model.bones.filter(b => b.face);
  if (!face.length) return bodyWeights(model, mesh, part, options);
  // A part that follows a face bone (an eyeball on its Eye bone) follows it rigidly.
  if (part?.bone && face.some(b => b.id === part.bone)) return bodyWeights(model, mesh, part, options);
  const body = bodyWeights({...model, bones: model.bones.filter(b => !b.face)}, mesh, part, options);
  return part?.bone ? body : faceWeights(model, mesh, body);
}

function bodyWeights(model, mesh, part, {smoothing = 2, rigidShare = .7} = {}) {
  const bones = model.bones, n = mesh.verts.length;
  if (!bones.length) return {bones: new Array(n * 4).fill(0), weights: new Array(n * 4).fill(0)};
  const byId = new Map(bones.map(b => [b.id, b])), byName = new Map(bones.map(b => [b.name, b]));
  const rigid = part?.bone && byId.get(part.bone);
  const neighbours = new Map(bones.map(b => [b.id, new Set([b.id, b.parent, ...bones.filter(c => c.parent === b.id).map(c => c.id)].filter(Boolean))]));
  const sideBones = p => { const side = p[0] > 1e-3 ? 'L' : p[0] < -1e-3 ? 'R' : ''; return bones.filter(b => !side || !sideOf(b.name) || sideOf(b.name) === side); };
  // Bones that run through this part (sampled along the bone, inside its slightly grown bounds).
  // A torso never takes the upper arm hanging beside it; a hip still takes the thighs that start inside it.
  const box = mesh.verts.length ? bounds(mesh.verts) : {min: [0, 0, 0], max: [0, 0, 0]};
  const grow = Math.max(...[0, 1, 2].map(k => box.max[k] - box.min[k])) * .08;
  const inside = (q, g) => [0, 1, 2].every(k => q[k] >= box.min[k] - g && q[k] <= box.max[k] + g);
  // A bone that only touches the part's edge (a thigh starting just under the shirt) is not one of its bones.
  let candidates = new Set(bones.filter(b => {
    const samples = Array.from({length: 9}, (_, i) => add(b.head, scale(sub(b.tail, b.head), i / 8)));
    return samples.some(q => inside(q, 0)) || samples.filter(q => inside(q, grow)).length >= 2;
  }).map(b => b.id));
  if (!candidates.size) candidates = new Set(bones.map(b => b.id));
  const nearest = (p, pool) => sideBones(p).filter(b => !pool || pool.has(b.id)).reduce((best, b) => { const d = segmentDistance(p, b.head, b.tail); return d < best[1] ? [b.id, d] : best; }, [0, Infinity])[0];
  // Root bones (Hips and the thighs) meet at the figure's root, so a part centred on one of them blends with the others.
  const partCentre = byId.get(nearest(scale(mesh.verts.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / Math.max(1, n)), candidates));
  if (partCentre && !partCentre.parent) for (const b of bones) if (!b.parent) for (const c of bones) if (!c.parent) neighbours.get(b.id).add(c.id);
  // Each vertex blends its nearest bone (among those in the part) with that bone's parent and children.
  const allowedFor = mesh.verts.map(p => {
    const centre = nearest(p, candidates) || nearest(p);
    return new Set([...(neighbours.get(centre) ?? [centre])].filter(id => candidates.has(id) || id === centre));
  });
  // A part that lies along one bone (a sleeve, a forearm, a shoe, the head) follows that bone rigidly, so it
  // keeps its shape instead of pinching where it touches the next bone. Mirrored parts are judged per side.
  const groups = part?.mirror ? [v => v[0] > 1e-3, v => v[0] < -1e-3, v => Math.abs(v[0]) <= 1e-3] : [() => true];
  const singleOf = new Array(n).fill(null);
  if (!rigid) for (const test of groups) {
    const members = mesh.verts.map((p, i) => i).filter(i => test(mesh.verts[i]));
    if (!members.length) continue;
    const centre = scale(members.reduce((acc, i) => add(acc, mesh.verts[i]), [0, 0, 0]), 1 / members.length);
    const bone = byId.get(nearest(centre, candidates) || nearest(centre));
    if (!bone) continue;
    const axis = sub(bone.tail, bone.head), len = length(axis);
    if (len < 1e-9) continue;
    const margin = len * .35, along = members.filter(i => { const t = dot(sub(mesh.verts[i], bone.head), axis) / len; return t >= -margin && t <= len + margin; }).length;
    if (along / members.length >= rigidShare) for (const i of members) singleOf[i] = bone.id;
  }
  const lists = mesh.verts.map((p, v) => {
    if (rigid) {
      const opposite = p[0] < -1e-6 && sideOf(rigid.name) ? byName.get(otherSide(rigid.name)) : null;
      return new Map([[(opposite ?? rigid).id, 1]]);
    }
    if (singleOf[v]) return new Map([[singleOf[v], 1]]);
    const allowed = allowedFor[v];
    const scored = sideBones(p).filter(b => allowed.has(b.id)).map(b => [b.id, segmentDistance(p, b.head, b.tail)]).sort((a, b) => a[1] - b[1]).slice(0, 4);
    const closest = scored[0]?.[1] ?? 0, out = new Map();
    for (const [id, d] of scored) { const w = 1 / Math.pow(Math.max(1e-4, d) / Math.max(1e-4, closest), 6); if (w > .02) out.set(id, w); }
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
