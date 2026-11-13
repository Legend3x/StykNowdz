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
import {completeSkin, autoWeights, otherSide} from './armature.mjs';
import {transformMesh, objectMatrix} from './mesh.mjs';

export const PAINT_MODES = Object.freeze(['add', 'remove', 'smooth', 'set']);
const clamp01 = x => Math.max(0, Math.min(1, x));
const weightIn = (pairs, bone) => pairs?.find(([b]) => b === bone)?.[1] ?? 0;

/** The bone on the other side of the middle (Arm.R for Arm.L), or the bone itself. */
export function mirrorBone(model, bone) {
  const name = model.bones.find(b => b.id === bone)?.name;
  return model.bones.find(b => b.name === otherSide(name ?? ''))?.id ?? bone;
}

/** What a stroke needs for one part and bone: every point's current weights,
 * and (when asked) where weight goes if the bone gives up a point it had alone. */
export function startStroke(model, part, bone) {
  const skin = completeSkin(model, part);
  const neighbours = part.mesh.verts.map(() => new Set());
  for (const f of part.mesh.faces) for (let i = 0; i < f.v.length; i++) { const a = f.v[i], b = f.v[(i + 1) % f.v.length]; neighbours[a].add(b); neighbours[b].add(a); }
  let without = null;
  const fallback = v => {
    // The bones that would move this point if this bone moved nothing (its Strength 0).
    without ??= autoWeights({...model, bones: model.bones.map(b => b.id === bone ? {...b, strength: 0} : b)}, transformMesh(part.mesh, objectMatrix(part)), {...part, bone: part.bone === bone ? 0 : part.bone});
    const pairs = [];
    for (let k = 0; k < 4; k++) if (without.bones[v * 4 + k] && without.bones[v * 4 + k] !== bone && without.weights[v * 4 + k] > 0) pairs.push([without.bones[v * 4 + k], without.weights[v * 4 + k]]);
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

/** Paint one point: `amount` (0–1) of the way towards all (add), none (remove),
 * its neighbours' average (smooth) or `value` (set). `bone` defaults to the
 * stroke's bone (a Mirror copy paints the other side's bone). True if it changed. */
export function paintPoint(stroke, v, mode, amount, {bone = stroke.bone, value = 1} = {}) {
  const {skin, part} = stroke, pairs = skin[v] ?? [], now = weightIn(pairs, bone);
  let target;
  if (mode === 'add') target = 1;
  else if (mode === 'remove') target = 0;
  else if (mode === 'set') target = clamp01(value);
  else if (mode === 'smooth') {
    const around = [...stroke.neighbours[v]];
    if (!around.length) return false;
    target = around.reduce((t, u) => t + weightIn(skin[u], bone), 0) / around.length;
  } else throw new Error(`Unknown paint mode “${mode}”.`);
  const next = now + (target - now) * clamp01(amount);
  if (Math.abs(next - now) < 1e-4) return false;
  const fallback = bone === stroke.bone ? () => stroke.fallback(v) : () => [];
  skin[v] = withWeight(pairs, bone, next, fallback);
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

