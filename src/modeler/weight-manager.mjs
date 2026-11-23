/** 3D Nowdz Weight Manager (docs/BLENDER-LITE.md, "Vertex groups and stored weights"): the one
 * place that reads, writes, clears, relabels and checks the weights a mesh keeps on its own
 * points (mesh.vdata.skin: {point: [[group, weight], …]}).
 *
 * Stored weights are kept as they were given, as Blender keeps vertex group weights: any number of
 * groups per point, each weight 0–1, and no rescaling to add up to 1 here. Two things happen only
 * where weights are used, never where they are stored:
 * - Auto Normalize (always on for now) makes painting share a point's bone weights out to 1.
 * - Deformation and glTF export use at most DEFORM_LIMIT bones per point (limitTotal): the
 *   strongest ones, scaled to add up to 1, as Blender's Limit Total and the Armature modifier do.
 *
 * Functions take a mesh, not a part, so they work as well on an imported or evaluated mesh. */

/** The most bones one point is moved by (the stage's and glTF's four joints per point). */
export const DEFORM_LIMIT = 4;

/** A point's stored weights, or null when it has none (it uses automatic weights). */
export const storedWeights = (mesh, v) => mesh.vdata?.skin?.[v] ?? null;

/** How many of a mesh's points keep weights of their own. */
export const storedCount = mesh => Object.keys(mesh.vdata?.skin ?? {}).length;

/** A clean copy of a weight list: valid groups only (`isGroup`), weights finite and above 0, at most 1,
 * a group named twice counted once (its weights added). Order kept. Never rescaled. */
export function cleanWeights(list, isGroup = () => true) {
  if (!Array.isArray(list)) return [];
  const sum = new Map();
  for (const pair of list) {
    if (!Array.isArray(pair)) continue;
    const [id, w] = pair;
    if (!isGroup(id) || !Number.isFinite(w) || w <= 0) continue;
    sum.set(id, (sum.get(id) ?? 0) + w);
  }
  return [...sum].map(([id, w]) => [id, Math.min(1, w)]);
}

const dropEmpty = mesh => {
  if (mesh.vdata?.skin && !Object.keys(mesh.vdata.skin).length) delete mesh.vdata.skin;
  if (mesh.vdata && !Object.keys(mesh.vdata).length) delete mesh.vdata;
};

/** Store a point's weights (cleaned). An empty list clears the point back to automatic weights. */
export function setStoredWeights(mesh, v, pairs) {
  const clean = cleanWeights(pairs);
  if (!clean.length) { clearStoredWeights(mesh, [v]); return; }
  mesh.vdata ??= {};
  mesh.vdata.skin ??= {};
  mesh.vdata.skin[v] = clean;
}

/** Points back to automatic weights (every point when `verts` is null). Returns how many were cleared. */
export function clearStoredWeights(mesh, verts = null) {
  const kept = mesh.vdata?.skin; if (!kept) return 0;
  let cleared = 0;
  for (const v of verts ?? Object.keys(kept).map(Number)) if (kept[v] !== undefined) { delete kept[v]; cleared++; }
  dropEmpty(mesh);
  return cleared;
}

/** Relabel every stored weight: `map(id)` gives the new group id, or undefined to drop that weight.
 * `normalize` (a Set of ids, after relabelling): those groups' weights at each point are scaled to add
 * up to 1 together, as Auto Normalize would leave them. A point left with nothing goes back to automatic. */
export function remapStoredWeights(mesh, map, {normalize = null} = {}) {
  const kept = mesh.vdata?.skin; if (!kept) return;
  for (const [v, pairs] of Object.entries(kept)) {
    let next = pairs.map(([id, w]) => [map(id), w]).filter(([id]) => id !== undefined);
    if (normalize) {
      const sum = next.filter(([id]) => normalize.has(id)).reduce((t, [, w]) => t + w, 0);
      if (sum > 0) next = next.map(([id, w]) => [id, normalize.has(id) ? w / sum : w]);
    }
    if (next.length) kept[v] = next; else delete kept[v];
  }
  dropEmpty(mesh);
}

/** A mesh's stored weights as read from a file: points that exist (0 ≤ point < `count`), each list
 * cleaned (cleanWeights) and kept as saved: not trimmed, not rescaled. */
export function readStoredWeights(raw, count, isGroup) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [i, list] of Object.entries(raw)) {
    if (!(Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < count)) continue;
    const clean = cleanWeights(list, isGroup);
    if (clean.length) out[i] = clean;
  }
  return out;
}

/** Blender's Weights > Normalize All on a mesh's stored weights: at every point, the weights in
 * `deform` groups that aren't `locked` are scaled so the deform weights add up to 1, locked ones
 * kept as they are (when they alone reach 1 or more, the others go to 0). Groups outside `deform`
 * (weights that move nothing) are left alone, as is a point with nothing unlocked to scale.
 * Points without stored weights are automatic, and add up to 1 already. Returns how many
 * points changed. */
export function normalizeStoredWeights(mesh, {deform, locked = new Set()}) {
  const kept = mesh.vdata?.skin; if (!kept) return 0;
  let changed = 0;
  for (const [v, pairs] of Object.entries(kept)) {
    const free = ([id]) => deform.has(id) && !locked.has(id);
    const fixed = pairs.filter(([id]) => deform.has(id) && locked.has(id)).reduce((t, [, w]) => t + w, 0), loose = pairs.filter(free).reduce((t, [, w]) => t + w, 0);
    if (loose <= 0) continue;
    const scale = Math.max(0, 1 - fixed) / loose;
    if (Math.abs(scale - 1) < 1e-9) continue;
    setStoredWeights(mesh, Number(v), pairs.map(([id, w]) => [id, free([id]) ? w * scale : w]));
    changed++;
  }
  return changed;
}

/** Weights scaled to add up to 1 (all of them kept); [] when they add up to nothing. */
export function normalizedWeights(pairs) {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  return total > 0 ? pairs.map(([id, w]) => [id, w / total]) : [];
}

/** The `limit` strongest weights, scaled to add up to 1 (Blender's Limit Total, then the Armature
 * modifier dividing by the total): what deformation and export use. Null when there are none.
 * Weights within 1e-9 of each other count as equal and go by group id, so every computer keeps the
 * same four (another Node version can make two all but equal weights differ in the last digit). */
export function limitTotal(pairs, limit = DEFORM_LIMIT) {
  const kept = [...pairs].sort((a, b) => (Math.abs(b[1] - a[1]) > 1e-9 ? b[1] - a[1] : a[0] - b[0])).slice(0, limit), total = kept.reduce((t, [, w]) => t + w, 0);
  return total > 0 ? kept.map(([id, w]) => [id, w / total]) : null;
}
