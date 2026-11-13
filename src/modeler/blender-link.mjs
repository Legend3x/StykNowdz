/** "Open in Blender" (docs/BLENDER-LITE.md, "Open in Blender"): the exchange
 * between 3D Nowdz and a real Blender, both ways, keeping what glTF would lose:
 * quads and n-gons, Mirror, Smooth and Solidify as live Blender modifiers,
 * creases, line weights, custom normals, bone strength and reach, and the ids
 * that keep animations attached to bones.
 *
 * startBlenderLink(model) → {doc, session}: `doc` is the JSON the Blender
 * script (desktop/blender/styk_link.py) builds its scene from. Every object and
 * bone carries a `key` (the script gives new ones their own); `session` maps
 * keys to part and bone ids and remembers what Blender last had, so a reply
 * only touches what was really changed in Blender.
 *
 * applyBlenderLink(model, reply, session) merges a reply into the model (inside
 * the caller's undo step): an object Blender left alone leaves its part exactly
 * as it is here, so edits made in 3D Nowdz meanwhile survive; a changed object
 * replaces its part's mesh, transform and modifiers and keeps the 3D Nowdz-only
 * settings (outline, shadows). It follows the skeleton as it did in Blender:
 * parented to a bone, it moves with that bone (Moves with); with an Armature
 * modifier, by weights; not attached to the armature at all, with the root
 * bone (a pedestal or a prop doesn't bend with the feet); objects and bones deleted in
 * Blender are removed and new ones added. Objects Blender can't express as
 * Mirror + Solidify + Smooth (a Boolean, Remesh, a text or curve object) come
 * back "baked": their final shape as plain faces.
 *
 * Everything here is in 3D Nowdz's space (Y up, metres); the script converts
 * to and from Blender's Z up. Colours are 0–255 sRGB. */
import {objectMatrix, transformMesh, recalculateNormals, repairImportedMesh, normalize} from './mesh.mjs';
import {decomposeTRS} from './matrix.mjs';
import {addPart} from './model.mjs';
import {addBone, deleteBones, boneOrder, partWeights, autoWeights, pullOf, setPull} from './armature.mjs';
import {validateMesh, TopologyError} from './topology.mjs';

export const LINK_FORMAT = 'styk-blender-link';
export const LINK_VERSION = 1;
export const LINK_LIMITS = Object.freeze({verts: 2_000_000, faces: 2_000_000});
const fail = why => { throw new Error(`Blender's changes can't be brought back: ${why}.`); };
const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const close = (a, b, e) => Math.abs((a ?? 0) - (b ?? 0)) <= e;
const closeList = (a, b, e) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => close(v, b[i], e));

/** Point weights a part gets here, by bone name: {vertex: [[name, weight]]}. */
function weightsByName(model, mesh, part, names) {
  const skin = partWeights(model, transformMesh(mesh, objectMatrix(part)), part, {cage: true}), out = {};
  for (let v = 0; v < mesh.verts.length; v++) {
    const pairs = [];
    for (let k = 0; k < 4; k++) { const id = skin.bones[v * 4 + k], w = skin.weights[v * 4 + k]; if (id && w > 1e-4 && names.has(id)) pairs.push([names.get(id), Math.round(w * 1e5) / 1e5]); }
    if (pairs.length) out[v] = pairs;
  }
  return out;
}

/** A part as the link carries it (object space, its own colour indices). */
function partData(model, part, names) {
  const mesh = part.mesh, vdata = mesh.vdata ?? {};
  // How it follows the skeleton: a bone (Moves with) becomes a Blender bone parent; else an Armature modifier.
  const follows = part.bone && names.has(part.bone) ? {bone: names.get(part.bone)} : 'skin';
  return {
    follows,
    key: `part-${part.id}`, name: part.name || 'Part', matrix: [...objectMatrix(part)],
    verts: mesh.verts.map(p => p.slice()), faces: mesh.faces.map(f => f.v.slice()), colors: mesh.faces.map(f => f.c ?? 0),
    edges: (mesh.edges ?? []).map(e => e.slice()), loose: (mesh.loose ?? []).slice(),
    mirror: Boolean(part.mirror), clip: part.clip !== false, smooth: part.smooth ?? 0, solidify: part.solidify ?? 0, visible: part.visible !== false,
    crease: {...(vdata.crease ?? {})}, line: {...(vdata.line ?? {})}, normal: Object.fromEntries(Object.entries(vdata.normal ?? {}).map(([i, n]) => [i, n.slice()])),
    // Blender gets the weights the animation uses, so posing there matches posing here.
    weights: model.bones.length && follows === 'skin' ? weightsByName(model, mesh, part, names) : {},
  };
}

/** The model as the document the Blender script reads, and the session that
 * reads Blender's replies. */
export function startBlenderLink(model) {
  const names = new Map(model.bones.map(b => [b.id, b.name])), byId = new Map(model.bones.map(b => [b.id, b]));
  const parts = model.parts.map(part => partData(model, part, names));
  const ordered = boneOrder(model);
  const bones = ordered.map(b => ({key: `bone-${b.id}`, name: b.name, head: b.head.slice(), tail: b.tail.slice(), parent: byId.get(b.parent)?.name ?? null, ...pullOf(b)}));
  const references = (model.references ?? []).filter(r => r && /^data:image\/(png|jpeg|webp);base64,/.test(r.src ?? ''))
    .map(r => ({view: r.view === 'side' ? 'side' : 'front', src: r.src, opacity: r.opacity ?? .5, height: r.height ?? 2, offsetX: r.offsetX ?? 0, offsetY: r.offsetY ?? 0, flip: r.flip === true}));
  const doc = {format: LINK_FORMAT, version: LINK_VERSION, name: model.name || '3D model', palette: model.palette.map(c => c.slice()), parts, bones, references};
  const session = {
    parts: new Map(model.parts.map((part, i) => [parts[i].key, {id: part.id, last: {...parts[i], colors: parts[i].colors.map(c => model.palette[c] ?? [200, 200, 200])}}])),
    bones: new Map(bones.map((b, i) => [b.key, {id: ordered[i].id, last: b}])),
  };
  return {doc, session};
}

/** Check the reply's shape and limits before anything is merged. */
export function readBlenderReply(reply) {
  if (!reply || reply.format !== LINK_FORMAT) fail('the reply is not from the 3D Nowdz Blender link');
  if (reply.version !== LINK_VERSION) fail(`the reply is version ${reply.version}; this app reads version ${LINK_VERSION}`);
  if (!Array.isArray(reply.parts) || !Array.isArray(reply.bones) || !Array.isArray(reply.materials)) fail('it is incomplete');
  const materials = reply.materials.map(c => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every(Number.isFinite) ? c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v)))) : [200, 200, 200]);
  let verts = 0, faces = 0;
  const keys = new Set();
  for (const p of reply.parts) {
    if (!p || typeof p.key !== 'string' || keys.has(p.key)) fail(`object “${p?.name ?? '?'}” has no key of its own`);
    keys.add(p.key);
    if (!Array.isArray(p.verts) || !Array.isArray(p.faces) || !Array.isArray(p.matrix) || p.matrix.length !== 16 || !p.matrix.every(Number.isFinite)) fail(`object “${p.name}” is incomplete`);
    if (!p.verts.every(finite3)) fail(`object “${p.name}” has a broken point`);
    if (!p.faces.every(f => Array.isArray(f) && f.length >= 3 && f.every(i => Number.isInteger(i) && i >= 0 && i < p.verts.length))) fail(`object “${p.name}” has a broken face`);
    verts += p.verts.length; faces += p.faces.length;
  }
  if (verts > LINK_LIMITS.verts || faces > LINK_LIMITS.faces) fail(`it has ${verts.toLocaleString('en')} points and ${faces.toLocaleString('en')} faces, more than 3D Nowdz takes (${LINK_LIMITS.verts.toLocaleString('en')}); a Decimate modifier in Blender brings it down`);
  for (const b of reply.bones) if (!b || typeof b.key !== 'string' || typeof b.name !== 'string' || !finite3(b.head) || !finite3(b.tail)) fail('a bone is incomplete');
  return {...reply, materials};
}

/** True when Blender's object is what Blender had last time (so it was not edited there). */
function sameAsLast(back, last, rgbOf) {
  if (!last || Boolean(back.baked) !== Boolean(last.baked) || back.name !== last.name) return false;
  if (Boolean(back.mirror) !== last.mirror || (back.smooth ?? 0) !== last.smooth || !close(back.solidify, last.solidify, 1e-6) || (back.visible !== false) !== last.visible || (back.clip !== false) !== last.clip) return false;
  if (JSON.stringify(back.follows ?? 'skin') !== JSON.stringify(last.follows ?? 'skin')) return false;
  if (!closeList(back.matrix, last.matrix, 1e-5) || back.verts.length !== last.verts.length || back.faces.length !== last.faces.length) return false;
  for (let i = 0; i < back.verts.length; i++) if (!closeList(back.verts[i], last.verts[i], 1e-5)) return false;
  for (let i = 0; i < back.faces.length; i++) {
    const a = back.faces[i], b = last.faces[i];
    if (a.length !== b.length || a.some((v, k) => v !== b[k]) || !closeList(rgbOf(back.colors?.[i]), last.colors[i], 1)) return false;
  }
  const sameMap = (x = {}, y = {}, same) => { const kx = Object.keys(x); return kx.length === Object.keys(y).length && kx.every(k => k in y && same(x[k], y[k])); };
  return sameMap(back.crease, last.crease, (p, q) => close(p, q, 1e-3)) && sameMap(back.line, last.line, (p, q) => close(p, q, 1e-3))
    && sameMap(back.normal, last.normal, (p, q) => closeList(p, q, 1e-3))
    && (back.edges?.length ?? 0) === (last.edges?.length ?? 0) && (back.loose?.length ?? 0) === (last.loose?.length ?? 0);
}

/** A 3D Nowdz mesh from one object in the reply (object space), with its point data. */
function meshFrom(back, colorOf, boneId) {
  const n = back.verts.length, inRange = i => Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < n;
  const mesh = {verts: back.verts.map(p => p.slice()), faces: back.faces.map((v, i) => ({v: v.slice(), c: colorOf(back.colors?.[i])}))};
  const edges = (back.edges ?? []).filter(e => Array.isArray(e) && e.length === 2 && e.every(inRange) && e[0] !== e[1]);
  if (edges.length) mesh.edges = edges.map(e => e.slice());
  const loose = (back.loose ?? []).filter(inRange);
  if (loose.length) mesh.loose = [...new Set(loose)];
  const vdata = {}, crease = {}, line = {}, normal = {}, skin = {};
  for (const [k, c] of Object.entries(back.crease ?? {})) { const [a, b] = k.split(',').map(Number); if (inRange(a) && inRange(b) && a !== b && Number.isFinite(c) && c > 0) crease[a < b ? `${a},${b}` : `${b},${a}`] = Math.min(1, c); }
  for (const [i, w] of Object.entries(back.line ?? {})) if (inRange(i) && Number.isFinite(w)) line[i] = Math.max(0, Math.min(4, w));
  for (const [i, v] of Object.entries(back.normal ?? {})) if (inRange(i) && finite3(v) && Math.hypot(...v) > 1e-9) normal[i] = normalize(v);
  for (const [i, pairs] of Object.entries(back.weights ?? {})) {
    if (!inRange(i) || !Array.isArray(pairs)) continue;
    const kept = pairs.filter(p => Array.isArray(p) && boneId.has(p[0]) && Number.isFinite(p[1]) && p[1] > 1e-4).map(([name, w]) => [boneId.get(name), w]).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = kept.reduce((s, [, w]) => s + w, 0); if (sum > 0) skin[i] = kept.map(([b, w]) => [b, w / sum]);
  }
  if (Object.keys(crease).length) vdata.crease = crease;
  if (Object.keys(line).length) vdata.line = line;
  if (Object.keys(normal).length) vdata.normal = normal;
  if (Object.keys(skin).length) vdata.skin = skin;
  if (Object.keys(vdata).length) mesh.vdata = vdata;
  return mesh;
}

/** Points whose Blender weights are what 3D Nowdz would give them anyway stay
 * automatic (so Strength, Reach and later bone moves keep applying); points
 * painted differently in Blender keep Blender's weights. Returns how many did. */
function keepPaintedWeights(model, part) {
  const skin = part.mesh.vdata?.skin; if (!skin) return 0;
  const plain = {...part.mesh, vdata: {...part.mesh.vdata}}; delete plain.vdata.skin;
  const auto = autoWeights(model, transformMesh(plain, objectMatrix(part)), part);
  let painted = 0;
  for (const [i, pairs] of Object.entries(skin)) {
    const v = Number(i), mine = new Map();
    for (let k = 0; k < 4; k++) { const id = auto.bones[v * 4 + k]; if (id) mine.set(id, (mine.get(id) ?? 0) + auto.weights[v * 4 + k]); }
    const theirs = new Map(pairs), ids = new Set([...mine.keys(), ...theirs.keys()]);
    if ([...ids].every(id => Math.abs((mine.get(id) ?? 0) - (theirs.get(id) ?? 0)) <= .1)) delete skin[i]; else painted++;
  }
  if (!Object.keys(skin).length) { delete part.mesh.vdata.skin; if (!Object.keys(part.mesh.vdata).length) delete part.mesh.vdata; }
  return painted;
}

/** One object of a reply as a 3D Nowdz part: its mesh (object space, rules
 * checked), placement, and the settings that ride along (Mirror, Smooth,
 * Solidify, clipping). Throws a TopologyError when the shape can't be used. */
export function readBlenderPart(back, colorOf, boneId = new Map()) {
  const mesh = meshFrom(back, colorOf, boneId);
  let transform;
  try { transform = decomposeTRS(back.matrix); }
  catch {
    // A skewed transform (a parent scaled unevenly in Blender) is baked into the points.
    transform = {position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]};
    mesh.verts = transformMesh({verts: mesh.verts, faces: []}, back.matrix).verts;
    if (mesh.vdata?.normal) mesh.vdata.normal = Object.fromEntries(Object.entries(mesh.vdata.normal).map(([i, n]) => [i, normalize([0, 4, 8].map(r => back.matrix[r] * n[0] + back.matrix[r + 1] * n[1] + back.matrix[r + 2] * n[2]))]));
  }
  // Blender can hand back faces that break 3D Nowdz's rules (a Boolean's leftovers,
  // a Remesh's inner shell): split those apart as an import does, then check.
  repairImportedMesh(mesh);
  try { recalculateNormals(mesh); }
  catch (error) {
    if (!(error instanceof TopologyError)) throw error;
    const check = validateMesh(mesh, {label: `object “${back.name}” from Blender`, print: false});
    throw new TopologyError(`Bringing back “${back.name}” from Blender`, check.ok ? error.result : check);
  }
  const settings = {mirror: Boolean(back.mirror) && !back.baked, smooth: back.baked ? 0 : Math.max(0, Math.min(3, Math.round(back.smooth ?? 0))), visible: back.visible !== false};
  const placed = {position: [...transform.position], rotation: [...transform.rotation], scale: [...transform.scale]};
  const extra = {solidify: !back.baked && Number.isFinite(back.solidify) && back.solidify !== 0 ? Math.max(-1, Math.min(1, back.solidify)) : 0, clip: back.clip !== false};
  return {mesh, placed, settings, extra};
}

/** Solidify and clipping are stored only when they differ from the default. */
export function setExtras(part, {solidify, clip}) {
  if (solidify) part.solidify = solidify; else delete part.solidify;
  if (clip === false) part.clip = false; else delete part.clip;
}

/** Merge Blender's reply into the model. Returns what happened:
 * {changed, added, removed, kept, baked, painted, bones: {changed, added, removed}}. */
export function applyBlenderLink(model, rawReply, session) {
  const reply = readBlenderReply(rawReply);
  const report = {changed: 0, added: 0, removed: 0, kept: 0, baked: 0, painted: 0, bones: {changed: 0, added: 0, removed: 0}};

  // Colours: Blender's materials become palette colours (a match within rounding is reused).
  const colorIndex = new Map(), rgbOf = m => reply.materials[m] ?? [200, 200, 200];
  const colorOf = m => {
    if (!colorIndex.has(m)) {
      const rgb = rgbOf(m); let i = model.palette.findIndex(c => c.every((v, k) => Math.abs(v - rgb[k]) <= 1));
      if (i < 0) { model.palette.push(rgb.slice()); i = model.palette.length - 1; }
      colorIndex.set(m, i);
    }
    return colorIndex.get(m);
  };

  // Bones first (weights refer to them): by key, then by name for a bone Blender made.
  const byId = new Map(model.bones.map(b => [b.id, b])), claimed = new Set(), boneOf = new Map(), nextBones = new Map();
  const sentIds = new Set([...session.bones.values()].map(s => s.id));
  for (const back of reply.bones) {
    const known = session.bones.get(back.key), own = known && byId.get(known.id);
    let bone = own && !claimed.has(own.id) ? own : !known ? model.bones.find(b => b.name === back.name && !claimed.has(b.id) && !sentIds.has(b.id)) ?? null : null;
    const last = known?.last, pull = pullOf(back);
    const edited = !last || last.name !== back.name || !closeList(last.head, back.head, 1e-5) || !closeList(last.tail, back.tail, 1e-5) || last.parent !== (back.parent ?? null)
      || !close(last.strength, pull.strength, 1e-6) || !close(last.range, pull.range, 1e-6);
    const remember = id => nextBones.set(back.key, {id, last: {key: back.key, name: back.name, head: back.head.slice(), tail: back.tail.slice(), parent: back.parent ?? null, ...pull}});
    if (!bone && known && !edited) { remember(known.id); continue; } // deleted here, untouched there: stays deleted
    if (!bone) { bone = addBone(model, {name: back.name, head: back.head, tail: back.tail}); report.bones.added++; }
    else if (edited) { bone.name = back.name; bone.head = back.head.slice(); bone.tail = back.tail.slice(); report.bones.changed++; }
    if (edited) setPull(bone, pull);
    claimed.add(bone.id); boneOf.set(back.name, {bone, edited}); remember(bone.id);
  }
  for (const back of reply.bones) {
    const entry = boneOf.get(back.name); if (!entry?.edited) continue;
    entry.bone.parent = back.parent && boneOf.has(back.parent) ? boneOf.get(back.parent).bone.id : 0;
  }
  // Only bones Blender had can have been deleted there; bones added here meanwhile stay.
  const gone = new Set(model.bones.filter(b => !claimed.has(b.id) && sentIds.has(b.id)).map(b => b.id));
  if (gone.size) { deleteBones(model, gone); report.bones.removed = gone.size; }
  const boneId = new Map([...boneOf].map(([name, {bone}]) => [name, bone.id]));

  // Parts, by key.
  const partById = new Map(model.parts.map(p => [p.id, p])), claimedParts = new Set(), order = [], nextParts = new Map();
  for (const back of reply.parts) {
    const known = session.parts.get(back.key);
    let part = known ? partById.get(known.id) : null;
    if (part && claimedParts.has(part.id)) part = null;
    const remember = id => nextParts.set(back.key, {id, last: {...back, colors: (back.colors ?? []).map(rgbOf), mirror: Boolean(back.mirror), smooth: back.smooth ?? 0, visible: back.visible !== false, clip: back.clip !== false}});
    if (known && sameAsLast(back, known.last, rgbOf)) {
      // Untouched in Blender: the part stays exactly as it is here (or stays deleted).
      if (part) { claimedParts.add(part.id); order.push(part); report.kept++; }
      remember(known.id);
      continue;
    }
    const {mesh, placed, settings, extra} = readBlenderPart(back, colorOf, boneId);
    if (part) { Object.assign(part, {name: back.name, mesh}, placed, settings); report.changed++; }
    else { part = addPart(model, {name: back.name, mesh, ...placed, ...settings}); model.parts.pop(); report.added++; }
    if (back.baked) report.baked++;
    setExtras(part, extra);
    // Following the skeleton as it did in Blender: parented to a bone moves with that bone; an
    // object not attached to the armature at all stays with the body's root; otherwise weights.
    const follows = back.follows ?? 'skin', root = boneOrder(model).find(b => !b.parent);
    const bound = follows === 'root' ? root : typeof follows?.bone === 'string' ? model.bones.find(b => b.id === boneId.get(follows.bone)) : null;
    if (bound) { part.bone = bound.id; if (part.mesh.vdata?.skin) { delete part.mesh.vdata.skin; if (!Object.keys(part.mesh.vdata).length) delete part.mesh.vdata; } }
    else { delete part.bone; report.painted += keepPaintedWeights(model, part); }
    claimedParts.add(part.id); order.push(part); remember(part.id);
  }
  // Parts deleted in Blender go; parts made here while Blender was open stay, after the rest.
  const sentParts = new Set([...session.parts.values()].map(s => s.id));
  report.removed = model.parts.filter(p => !claimedParts.has(p.id) && sentParts.has(p.id)).length;
  model.parts = [...order, ...model.parts.filter(p => !claimedParts.has(p.id) && !sentParts.has(p.id))];
  session.parts = nextParts; session.bones = nextBones;
  return report;
}
