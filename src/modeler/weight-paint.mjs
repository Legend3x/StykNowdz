/** 3D Nowdz weight painting (docs/BLENDER-LITE.md, "Weight painting"): paint
 * how much the selected bone moves each point, as in Blender's Weight Paint
 * mode. Red is all of it, blue none; the colours are the "Show what the
 * selected bone moves" view.
 *
 * Painted weights live on the part's own points (part.mesh.vdata.skin, the
 * same place an imported rig keeps its weights) as complete lists: a point
 * painted once keeps all its bones, so later automatic changes (a bone moved,
 * Strength changed) no longer reach it, until Back to automatic clears it.
 * A point always adds up to 1 across its bones (Blender's Auto Normalize):
 * taking weight from the bone gives it to the bones already sharing the point,
 * or, where the bone had it all, to the bones that would have it without it.
 *
 * startStroke(model, part, bone) → stroke state for one part and bone;
 * paintPoint(stroke, v, mode, amount) changes one point (mode add, remove,
 * smooth or set); clearPainted(part, verts?) returns points to automatic. */
import {completeSkin, autoWeights, otherSide, isMerged} from './armature.mjs';
import {transformMesh, objectMatrix} from './mesh.mjs';

export const PAINT_MODES = Object.freeze(['add', 'remove', 'smooth', 'set']);
const clamp01 = x => Math.max(0, Math.min(1, x));
const weightIn = (pairs, bone) => pairs?.find(([b]) => b === bone)?.[1] ?? 0;

/** The bone on the other side of the middle (Arm.R for Arm.L), or the bone itself. */
export function mirrorBone(model, bone) {
  const name = model.bones.find(b => b.id === bone)?.name;
  return model.bones.find(b => b.name === otherSide(name ?? ''))?.id ?? bone;
}

/** What a stroke needs for one part: every point's current weights, and (when
 * asked) where weight goes if a bone gives up a point it had alone. `bone` is the
 * one painted unless paintPoint names another (a mirrored side). */
export function startStroke(model, part, bone) {
  const skin = completeSkin(model, part);
  const neighbours = part.mesh.verts.map(() => new Set());
  for (const f of part.mesh.faces) for (let i = 0; i < f.v.length; i++) { const a = f.v[i], b = f.v[(i + 1) % f.v.length]; neighbours[a].add(b); neighbours[b].add(a); }
  const without = new Map(), cage = transformMesh(part.mesh, objectMatrix(part));
  const fallback = (v, b = bone) => {
    // The bones that would move this point if bone b moved nothing (its Strength 0).
    if (!without.has(b)) without.set(b, autoWeights({...model, bones: model.bones.map(x => x.id === b ? {...x, strength: 0} : x)}, cage, {...part, bone: part.bone === b ? 0 : part.bone}));
    const w = without.get(b), pairs = [];
    for (let k = 0; k < 4; k++) if (w.bones[v * 4 + k] && w.bones[v * 4 + k] !== b && w.weights[v * 4 + k] > 0) pairs.push([w.bones[v * 4 + k], w.weights[v * 4 + k]]);
    return pairs;
  };
  return {model, part, bone, skin, neighbours, fallback, touched: new Set()};
}

/** A point's weights with `bone` at `w`, the rest scaled to share what is left. */
export function withWeight(pairs, bone, w, fallback = () => []) {
  w = clamp01(w);
  let others = (pairs ?? []).filter(([b, x]) => b !== bone && x > 0);
  let rest = others.reduce((t, [, x]) => t + x, 0);
  if (rest <= 1e-9 && w < 1) { others = fallback().filter(([b, x]) => b !== bone && x > 0); rest = others.reduce((t, [, x]) => t + x, 0); }
  // Nothing else can take the point: the bone keeps it all.
  if (rest <= 1e-9) return [[bone, 1]];
  const out = others.map(([b, x]) => [b, x / rest * (1 - w)]);
  if (w > 0) out.push([bone, w]);
  const kept = out.filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), total = kept.reduce((t, [, x]) => t + x, 0);
  return kept.map(([b, x]) => [b, Math.round(x / total * 1e5) / 1e5]);
}

/** The bones that ride on `bone` (below it in the skeleton): they move whenever it turns. */
export function ridersOf(model, bone) {
  const out = new Set([bone]);
  for (let grew = true; grew;) { grew = false; for (const b of model.bones) if (out.has(b.parent) && !out.has(b.id)) { out.add(b.id); grew = true; } }
  out.delete(bone);
  return out;
}

/** A point's weights with `amount` taken from `bone` and given to bones that stay
 * still when it turns: never to a bone below it (a shoulder's upper arm), which
 * would carry the point along anyway. Bones below it keep what they had. Null
 * when no such bone can take it. */
function lowered(model, pairs, bone, amount, fallback, held = new Set()) {
  const riders = ridersOf(model, bone), still = ([b, x]) => b !== bone && !riders.has(b) && !held.has(b) && x > 0;
  let takers = (pairs ?? []).filter(still);
  if (!takers.length) takers = fallback().filter(still);
  if (!takers.length) { const parent = model.bones.find(b => b.id === bone)?.parent; if (model.bones.some(b => b.id === parent) && !held.has(parent)) takers = [[parent, 1]]; }
  if (!takers.length) return null;
  const total = takers.reduce((t, [, x]) => t + x, 0), out = new Map((pairs ?? []).filter(([, x]) => x > 0));
  out.set(bone, Math.max(0, (out.get(bone) ?? 0) - amount));
  for (const [b, x] of takers) out.set(b, (out.get(b) ?? 0) + amount * x / total);
  const kept = [...out].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4), sum = kept.reduce((t, [, x]) => t + x, 0);
  return kept.map(([b, x]) => [b, Math.round(x / sum * 1e5) / 1e5]);
}

/** Paint one point: `amount` (0–1) of the way towards all (add), none (remove),
 * its neighbours' average (smooth) or `value` (set). `bone` defaults to the
 * stroke's bone (a Mirror copy paints the other side's bone). True if it changed. */
export function paintPoint(stroke, v, mode, amount, {bone = stroke.bone, value = 1} = {}) {
  const {skin, part} = stroke, all = skin[v] ?? [];
  // A merged bone's weights are frozen: painting another bone shares only what they leave.
  const held = new Set(stroke.model.bones.filter(b => b.id !== bone && isMerged(b)).map(b => b.id));
  const kept = all.filter(([b]) => held.has(b)), free = 1 - kept.reduce((t, [, x]) => t + x, 0);
  if (free <= 1e-4) return false;
  const pairs = all.filter(([b]) => !held.has(b)).map(([b, x]) => [b, x / free]), now = weightIn(pairs, bone);
  let target;
  if (mode === 'add') target = 1;
  else if (mode === 'remove') target = 0;
  else if (mode === 'set') target = clamp01(value);
  else if (mode === 'smooth') {
    const around = [...stroke.neighbours[v]];
    if (!around.length) return false;
    target = around.reduce((t, u) => t + weightIn(skin[u], bone), 0) / around.length;
  } else throw new Error(`Unknown paint mode “${mode}”.`);
  // Smooth and Set name weights out of the whole point; the free share is what can change.
  if (mode !== 'add' && mode !== 'remove') target = Math.min(1, target / free);
  const next = now + (target - now) * clamp01(amount);
  if (Math.abs(next - now) * free < 1e-4) return false;
  const fallback = () => stroke.fallback(v, bone).filter(([b]) => !held.has(b));
  const changed = next < now ? lowered(stroke.model, pairs, bone, now - next, fallback, held) ?? withWeight(pairs, bone, next, fallback) : withWeight(pairs, bone, next, fallback);
  skin[v] = kept.length ? [...kept, ...changed.map(([b, x]) => [b, Math.round(x * free * 1e5) / 1e5])].filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 4) : changed;
  part.mesh.vdata ??= {};
  part.mesh.vdata.skin ??= {};
  part.mesh.vdata.skin[v] = skin[v].map(pair => pair.slice());
  stroke.touched.add(v);
  return true;
}

/** Points back to automatic weights (all of a part's points when `verts` is omitted). */
export function clearPainted(part, verts = null) {
  const kept = part.mesh.vdata?.skin; if (!kept) return 0;
  let cleared = 0;
  for (const v of verts ?? Object.keys(kept).map(Number)) if (kept[v] !== undefined) { delete kept[v]; cleared++; }
  if (!Object.keys(kept).length) delete part.mesh.vdata.skin;
  if (part.mesh.vdata && !Object.keys(part.mesh.vdata).length) delete part.mesh.vdata;
  return cleared;
}

/** How many of a part's points carry their own weights. */
export const paintedCount = part => Object.keys(part.mesh.vdata?.skin ?? {}).length;

