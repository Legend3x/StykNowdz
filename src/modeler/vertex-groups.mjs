/** 3D Nowdz vertex groups (docs/BLENDER-LITE.md, "Vertex groups and stored weights"): the named
 * sets of point weights Blender keeps on a mesh, kept on the model as `model.groups`.
 *
 * - Every bone has a group with the bone's own id: {id, bone: id}. Its name is the bone's name.
 *   Because the ids match, a stored weight [id, w] names the group and the bone at once, and models
 *   saved before groups existed open with nothing to convert.
 * - A group with no bone ({id, name}) holds weights that move nothing (Blender's non-deforming
 *   groups, kept for masks and tools). Its id comes from model.nextId, so it never matches a bone.
 * - `lock: true` marks a locked group (Blender's lock icon). Painting does not use locks yet.
 *
 * A bone's group is made when it is first asked for (syncGroups); a deleted bone's group goes with
 * it, as its weights already stop counting. */

/** A clean group list for bones with these ids: each bone's group (with any lock it had), then the
 * groups without a bone, in the order given. */
export function readGroups(list, boneIds) {
  const given = Array.isArray(list) ? list : [], byBone = new Map(), plain = [], seen = new Set();
  for (const g of given) {
    if (!g || typeof g !== 'object' || !Number.isInteger(g.id) || g.id <= 0 || seen.has(g.id)) continue;
    if (g.bone !== undefined) {
      // A bone's group has the bone's id; one for a bone that is gone is dropped.
      if (g.bone !== g.id || !boneIds.has(g.id)) continue;
      byBone.set(g.id, g.lock === true);
    } else {
      if (boneIds.has(g.id) || typeof g.name !== 'string') continue;
      plain.push({id: g.id, name: g.name.slice(0, 120) || 'Group', ...(g.lock === true ? {lock: true} : {})});
    }
    seen.add(g.id);
  }
  return [...[...boneIds].map(id => ({id, bone: id, ...(byBone.get(id) ? {lock: true} : {})})), ...plain];
}

/** Bring model.groups up to date with the bones (a group for each, none for bones that are gone). */
export function syncGroups(model) {
  model.groups = readGroups(model.groups, new Set(model.bones.map(b => b.id)));
  return model.groups;
}

/** The model's groups, up to date. */
export const vertexGroups = model => syncGroups(model);

/** One group, or null. */
export const groupOf = (model, id) => vertexGroups(model).find(g => g.id === id) ?? null;

/** A group's name: its bone's name, or its own. */
export const groupName = (model, group) => (group.bone !== undefined ? model.bones.find(b => b.id === group.bone)?.name : group.name) ?? '';

/** Whether weights in this group move the model (it belongs to a bone). */
export const deformsGroup = (model, id) => model.bones.some(b => b.id === id);

/** Whether a group is locked. */
export const isGroupLocked = (model, id) => groupOf(model, id)?.lock === true;

/** Lock or unlock a group. */
export function setGroupLock(model, id, lock) {
  const group = groupOf(model, id); if (!group) return false;
  if (lock) group.lock = true; else delete group.lock;
  return true;
}

/** A new group with no bone (its weights move nothing), at the end of the list. */
export function addGroup(model, name = 'Group') {
  vertexGroups(model);
  const group = {id: model.nextId++, name: String(name).slice(0, 120) || 'Group'};
  model.groups.push(group);
  return group;
}

/** The ids of every group (bones' and others'). */
export const groupIds = model => new Set(vertexGroups(model).map(g => g.id));

/** Auto Normalize (Blender's weight paint option): painting keeps a point's bone weights adding up
 * to 1. Stored with the model as weightPaint.autoNormalize = false when off; on by default. There is
 * no switch for it yet, so it is always on while painting. */
export const autoNormalizeOn = model => model.weightPaint?.autoNormalize !== false;
