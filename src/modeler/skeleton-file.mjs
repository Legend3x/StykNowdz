// Skeleton files (.nowdzskel): a model's bones on their own, to keep a rig in case or to bring it to
// another model. Painted weights stay with the model: they belong to its points.
import {readModel, emptyModel} from './model.mjs';
import {remapStoredWeights} from './weight-manager.mjs';
import {syncGroups} from './vertex-groups.mjs';

export const SKELETON_FILE_FORMAT = 'stykNowdz.skeleton';
const BONE_KEYS = ['id', 'name', 'head', 'tail', 'parent', 'state', 'face', 'reach', 'cut', 'strength', 'range'];

/** The file for a model's skeleton: every bone (with its layer state, Strength and Reach) and the origin. */
export function skeletonFile(model) {
  const bones = model.bones.map(b => Object.fromEntries(BONE_KEYS.filter(k => b[k] !== undefined).map(k => [k, structuredClone(b[k])])));
  return {format: SKELETON_FILE_FORMAT, version: 1, bones, ...(model.origin ? {origin: model.origin.slice()} : {})};
}

/** Check a skeleton file and return {bones, origin}, cleaned as a model's bones are. Throws on bad data. */
export function readSkeletonFile(data) {
  if (data?.format !== SKELETON_FILE_FORMAT || !Array.isArray(data.bones) || !data.bones.length) throw new Error('not a skeleton file');
  const ids = new Set(), bones = data.bones.map(b => {
    if (!b || !Number.isInteger(b.id) || b.id <= 0 || ids.has(b.id)) throw new Error('not a skeleton file');
    ids.add(b.id);
    return {...Object.fromEntries(BONE_KEYS.filter(k => b[k] !== undefined).map(k => [k, structuredClone(b[k])])), name: String(b.name ?? 'Bone').slice(0, 120) || 'Bone'};
  });
  for (const b of bones) if (!ids.has(b.parent) || b.parent === b.id) b.parent = 0;
  // No bone below itself, however deep.
  const byId = new Map(bones.map(b => [b.id, b]));
  for (const b of bones) { const seen = new Set([b.id]); for (let up = byId.get(b.parent); up; up = byId.get(up.parent)) { if (seen.has(up.id)) { b.parent = 0; break; } seen.add(up.id); } }
  const checked = readModel({...emptyModel(), bones, ...(data.origin ? {origin: data.origin} : {})});
  return {bones: checked.bones, origin: checked.origin ?? null};
}

/** Put a skeleton in place of a model's bones (in place). A bone named like one the model has takes
 * that bone's place, so points painted for it keep their weights; weights for bones that are gone are
 * dropped (a point left with none goes back to automatic), and so are parts' and folders' links to them.
 * Returns {kept, added, removed} bone names. */
export function applySkeleton(model, {bones, origin}) {
  const byName = new Map(model.bones.map(b => [b.name, b.id])), used = new Set(), map = new Map();
  for (const b of bones) {
    const id = byName.get(b.name);
    if (id !== undefined && !used.has(id)) { map.set(b.id, id); used.add(id); } else map.set(b.id, model.nextId++);
  }
  const before = model.bones;
  model.bones = bones.map(b => ({...structuredClone(b), id: map.get(b.id), parent: map.get(b.parent) ?? 0}));
  const ids = new Set(model.bones.map(b => b.id)), plain = new Set((model.groups ?? []).filter(g => g.bone === undefined).map(g => g.id));
  for (const part of model.parts) {
    // Groups of bones that are gone go with them; the bones left share the point out to 1 again.
    // A point left with no bone weights goes back to automatic bones (completeSkin).
    remapStoredWeights(part.mesh, id => (ids.has(id) || plain.has(id) ? id : undefined), {normalize: ids});
    if (part.bone !== undefined && !ids.has(part.bone)) delete part.bone;
  }
  syncGroups(model);
  for (const f of model.folders ?? []) if (f.bone && !ids.has(f.bone)) delete f.bone;
  if (origin) model.origin = origin.slice();
  model.nextId = Math.max(model.nextId, ...model.bones.map(b => b.id + 1));
  const names = new Set(model.bones.map(b => b.name));
  return {kept: model.bones.filter(b => before.some(o => o.id === b.id)).map(b => b.name), added: model.bones.filter(b => !before.some(o => o.id === b.id)).map(b => b.name), removed: before.filter(b => !names.has(b.name)).map(b => b.name)};
}
