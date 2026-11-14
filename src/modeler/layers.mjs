/** 3D Nowdz layers (docs/BLENDER-LITE.md, "Layers"): the Layers panel's model
 * side. Parts sit in folders (an imported model in one folder of its own), bones
 * are layers that are loose, grouped or merged with the model, and the origin is
 * the point the figure stands on and turns about on the stage. */
import {completeSkin, boneState, setBoneState, isMerged, otherSide, sideOf} from './armature.mjs';

// ---------- Folders ----------

/** A new folder (inside `parent` when given). */
export function addFolder(model, {name = 'Folder', parent = 0, open = false} = {}) {
  model.folders ??= [];
  const folder = {id: model.nextId++, name: uniqueFolderName(model, name), ...(parent ? {parent} : {}), ...(open ? {open: true} : {})};
  model.folders.push(folder);
  return folder;
}
function uniqueFolderName(model, name) {
  const taken = new Set((model.folders ?? []).map(f => f.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}
export const folderOf = (model, id) => (model.folders ?? []).find(f => f.id === id) ?? null;
/** The folder and every folder inside it, however deep. */
export function foldersWithin(model, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of model.folders ?? []) if (out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } }
  return out;
}
/** Every part inside a folder, however deep, in model order. */
export const partsIn = (model, id) => { const within = foldersWithin(model, id); return model.parts.filter(p => within.has(p.folder)); };
/** Put parts (ids) into a folder (0 takes them out of any folder). */
export function moveToFolder(model, partIds, folder) {
  const ids = new Set(partIds);
  for (const p of model.parts) if (ids.has(p.id)) { if (folder) p.folder = folder; else delete p.folder; }
}
/** Put a folder inside another (0: at the top). Refused when that would put it inside itself. */
export function nestFolder(model, id, parent) {
  const folder = folderOf(model, id);
  if (!folder || (parent && foldersWithin(model, id).has(parent))) return false;
  if (parent) folder.parent = parent; else delete folder.parent;
  return true;
}
/** Remove a folder; what was in it moves up to the folder around it. */
export function ungroupFolder(model, id) {
  const folder = folderOf(model, id); if (!folder) return;
  for (const p of model.parts) if (p.folder === id) { if (folder.parent) p.folder = folder.parent; else delete p.folder; }
  for (const f of model.folders) if (f.parent === id) { if (folder.parent) f.parent = folder.parent; else delete f.parent; }
  model.folders = model.folders.filter(f => f.id !== id);
  if (!model.folders.length) delete model.folders;
}
/** Remove a folder with everything in it. Returns the ids of the parts removed. */
export function deleteFolder(model, id) {
  const within = foldersWithin(model, id), gone = model.parts.filter(p => within.has(p.folder)).map(p => p.id);
  model.parts = model.parts.filter(p => !within.has(p.folder));
  model.folders = (model.folders ?? []).filter(f => !within.has(f.id));
  if (!model.folders.length) delete model.folders;
  return gone;
}
/** Folders with nothing in them (left by deleting or joining parts) are removed. */
export function dropEmptyFolders(model) {
  if (!model.folders) return;
  for (let changed = true; changed;) {
    changed = false;
    const used = new Set([...model.parts.map(p => p.folder), ...model.folders.map(f => f.parent)]);
    const kept = model.folders.filter(f => used.has(f.id));
    if (kept.length !== model.folders.length) { model.folders = kept; changed = true; }
  }
  if (!model.folders.length) delete model.folders;
}

// ---------- Bone layers ----------

/** The bones that ride on `bone` (below it in the skeleton). */
export function bonesBelow(model, bone) {
  const out = new Set([bone]);
  for (let grew = true; grew;) { grew = false; for (const b of model.bones) if (out.has(b.parent) && !out.has(b.id)) { out.add(b.id); grew = true; } }
  out.delete(bone);
  return out;
}

/** Group a bone to the model: it takes its share of the skin by itself (automatic weights). */
export function groupBone(model, id) {
  const bone = model.bones.find(b => b.id === id); if (!bone) return false;
  setBoneState(bone, 'grouped');
  return true;
}
/** Make a bone loose: it moves only what is painted for it. */
export function looseBone(model, id) {
  const bone = model.bones.find(b => b.id === id); if (!bone) return false;
  setBoneState(bone, 'loose');
  return true;
}

/** Merge a bone with the model: every point it moves keeps its weights exactly
 * as they are now (frozen into painted weights, as a painted point is), and the
 * bone is locked in place. A Mirror part's own points are frozen where the bone
 * or its other side moves them, so its mirrored half keeps its weights too.
 * Returns how many points were frozen. */
export function mergeBone(model, id) {
  const bone = model.bones.find(b => b.id === id); if (!bone || isMerged(bone)) return 0;
  const partner = sideOf(bone.name) ? model.bones.find(b => b.name === otherSide(bone.name))?.id : null;
  let frozen = 0;
  for (const part of model.parts) {
    const full = completeSkin(model, part), kept = part.mesh.vdata?.skin ?? {};
    for (const [v, pairs] of Object.entries(full)) {
      if (kept[v] !== undefined) continue;
      if (!pairs.some(([b, w]) => w > 0 && (b === id || (part.mirror && b === partner)))) continue;
      part.mesh.vdata ??= {};
      part.mesh.vdata.skin ??= {};
      part.mesh.vdata.skin[v] = pairs.map(([b, w]) => [b, Math.round(w * 1e5) / 1e5]);
      frozen++;
    }
  }
  setBoneState(bone, 'merged');
  return frozen;
}
/** Unmerge: the bone can be moved and painted again (its frozen weights stay until repainted). */
export function unmergeBone(model, id) {
  const bone = model.bones.find(b => b.id === id); if (!bone || !isMerged(bone)) return false;
  setBoneState(bone, 'grouped');
  return true;
}
export {boneState};

// ---------- Origin ----------

/** The origin in model space (the floor in the middle unless moved). */
export const originOf = model => model.origin ?? [0, 0, 0];
export function setOrigin(model, p) {
  if (p.some(v => !Number.isFinite(v))) return;
  if (p.every(v => Math.abs(v) < 1e-9)) delete model.origin; else model.origin = p.slice();
}

/** What the dashed lines in Bones mode join: the origin to each bone attached
 * to nothing, and a bone to the bone it is attached to across a gap.
 * [{from, to, bone, kind: 'origin' | 'gap'}] in model space. */
export function connections(model) {
  const byId = new Map(model.bones.map(b => [b.id, b])), origin = originOf(model), out = [];
  for (const b of model.bones) {
    const parent = byId.get(b.parent);
    if (!parent) { if (!b.face) out.push({from: origin, to: b.head, bone: b.id, kind: 'origin'}); continue; }
    if (Math.hypot(...[0, 1, 2].map(k => parent.tail[k] - b.head[k])) > 1e-6) out.push({from: parent.tail, to: b.head, bone: b.id, kind: 'gap'});
  }
  return out;
}

// ---------- Traced lines ----------

/** A part's traced lines: the pieces of its wire edges (lines with no faces
 * yet), each {points (in order along it), closed, ends}. A single point on its
 * own is not a line. */
export function tracedLines(mesh) {
  const edges = mesh.edges ?? [], around = new Map();
  for (const [a, b] of edges) { for (const [x, y] of [[a, b], [b, a]]) { if (!around.has(x)) around.set(x, []); around.get(x).push(y); } }
  const seen = new Set(), lines = [];
  for (const start of around.keys()) {
    if (seen.has(start)) continue;
    // Gather the piece, then walk it from an end (or anywhere on a ring).
    const piece = [], stack = [start]; seen.add(start);
    while (stack.length) { const v = stack.pop(); piece.push(v); for (const u of around.get(v)) if (!seen.has(u)) { seen.add(u); stack.push(u); } }
    const ends = piece.filter(v => around.get(v).length === 1);
    const simple = piece.every(v => around.get(v).length <= 2);
    const closed = simple && !ends.length && piece.length >= 3;
    let points = piece;
    if (simple) {
      points = [];
      const from = ends[0] ?? Math.min(...piece), walked = new Set();
      for (let v = from, prev = -1; v !== undefined && !walked.has(v);) { points.push(v); walked.add(v); const next = around.get(v).find(u => u !== prev && !walked.has(u)); prev = v; v = next; }
    }
    lines.push({points, closed, ends: simple ? ends : piece.filter(v => around.get(v).length !== 2)});
  }
  return lines;
}
/** The line a point is on, or null. */
export const lineOf = (mesh, v) => tracedLines(mesh).find(l => l.points.includes(v)) ?? null;
/** The other end of an open line from point `v` (its first point when `v` is the last), or null. */
export function otherEnd(mesh, v) {
  const line = lineOf(mesh, v);
  if (!line || line.closed || line.ends.length !== 2 || !line.ends.includes(v) || line.points.length < 3) return null;
  return line.ends.find(e => e !== v);
}
