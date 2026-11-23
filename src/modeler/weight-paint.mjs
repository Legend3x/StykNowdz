/** 3D Nowdz weight painting (docs/BLENDER-LITE.md, "Weight painting"): paint
 * how much the selected bone moves each point, as in Blender's Weight Paint
 * mode. Red is all of it, blue none; the colours are the "Show what the
 * selected bone moves" view.
 *
 * Painted weights live on the part's own points (part.mesh.vdata.skin, the
 * same place an imported rig keeps its weights) as complete lists: a point
 * painted once keeps all its bones, so later automatic changes (a bone moved,
 * Strength changed) no longer reach it, until Back to automatic clears it.
 * Stored weights go through weight-manager.mjs and keep every bone a point has
 * (deformation uses the strongest four). As in Blender's Weight Paint options:
 * - Auto Normalize (model.weightPaint.autoNormalize, on by default): a point's
 *   bones always add up to 1: taking weight from the bone gives it to the bones
 *   already sharing the point, or, where the bone had it all and Hand off is on
 *   (weightPaint.handOff, on by default; not in Blender, which keeps it at 1),
 *   to the bones that would have it without it. Off: only the painted bone's
 *   weight changes, 0 to 1, and deformation divides by the total.
 * - Locked groups (vertex-groups.mjs): a locked bone can't be painted, and
 *   painting others never changes its weights, as a Merged bone's.
 * - Multi-Paint (several bones at once): their weights change together in
 *   proportion, as one: their sum with Auto Normalize, their average without.
 *   A point where they have no weight can't be painted, and they never go
 *   all the way to zero (Blender's rules).
 *
 * startStroke(model, part, bone) → stroke state for one part and bone (or an
 * array of bones: Multi-Paint); paintPoint(stroke, v, mode, amount) changes one
 * point (mode add, remove, smooth or set); clearPainted(part, verts?) returns
 * points to automatic. */
import {completeSkin, autoWeights, otherSide, isMerged} from './armature.mjs';
import {transformMesh, objectMatrix} from './mesh.mjs';
import {setStoredWeights, clearStoredWeights, storedCount} from './weight-manager.mjs';
import {autoNormalizeOn, isGroupLocked} from './vertex-groups.mjs';

export const PAINT_MODES = Object.freeze(['add', 'remove', 'smooth', 'set']);
const clamp01 = x => Math.max(0, Math.min(1, x));
const weightIn = (pairs, bone) => pairs?.find(([b]) => b === bone)?.[1] ?? 0;

/** The bone on the other side of the middle (Arm.R for Arm.L), or the bone itself. For
 * several bones (Multi-Paint) each one's; the same array when none has another side. */
export function mirrorBone(model, bone) {
  if (Array.isArray(bone)) { const other = bone.map(b => mirrorBone(model, b)); return other.every((b, i) => b === bone[i]) ? bone : other; }
  const name = model.bones.find(b => b.id === bone)?.name;
  return model.bones.find(b => b.name === otherSide(name ?? ''))?.id ?? bone;
}

/** Hand off (not in Blender): where the painted bone moved a point on its own, lowering it gives
 * the rest to the bones automatic weighting would choose (or the bone's parent). On by default,
 * stored as weightPaint.handOff = false when off; off, as in Blender, the bone keeps the point. */
export const handOffOn = model => model.weightPaint?.handOff !== false;

/** A bone, or several (Multi-Paint), as a list of ids. */
const listOf = bone => (Array.isArray(bone) ? bone : [bone]);
/** The bones' weight at a point: their sum (Auto Normalize) or average (off), as Blender shows Multi-Paint. */
export const groupWeightIn = (pairs, bones, average = false) => {
  const ids = listOf(bones), sum = ids.reduce((t, b) => t + weightIn(pairs, b), 0);
  return average ? sum / ids.length : sum;
};

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
  const locked = new Set(model.bones.filter(b => isGroupLocked(model, b.id)).map(b => b.id));
  return {model, part, bone, skin, neighbours, fallback, bones: new Set(model.bones.map(b => b.id)), locked, autoNormalize: autoNormalizeOn(model), handOff: handOffOn(model), touched: new Set()};
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
  // Every bone sharing the point is kept (deformation, not storage, limits it to four).
  const kept = out.filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]), total = kept.reduce((t, [, x]) => t + x, 0);
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
function lowered(model, pairs, bone, amount, fallback, held = new Set(), handOff = true) {
  const riders = ridersOf(model, bone), still = ([b, x]) => b !== bone && !riders.has(b) && !held.has(b) && x > 0;
  let takers = (pairs ?? []).filter(still);
  if (!takers.length) takers = fallback().filter(still);
  if (!takers.length && handOff) { const parent = model.bones.find(b => b.id === bone)?.parent; if (model.bones.some(b => b.id === parent) && !held.has(parent)) takers = [[parent, 1]]; }
  if (!takers.length) return null;
  const total = takers.reduce((t, [, x]) => t + x, 0), out = new Map((pairs ?? []).filter(([, x]) => x > 0));
  out.set(bone, Math.max(0, (out.get(bone) ?? 0) - amount));
  for (const [b, x] of takers) out.set(b, (out.get(b) ?? 0) + amount * x / total);
  const kept = [...out].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]), sum = kept.reduce((t, [, x]) => t + x, 0);
  return kept.map(([b, x]) => [b, Math.round(x / sum * 1e5) / 1e5]);
}

/** Paint one point: `amount` (0–1) of the way towards all (add), none (remove),
 * its neighbours' average (smooth) or `value` (set). `bone` defaults to the
 * stroke's bone (a Mirror copy paints the other side's bone). True if it changed. */
export function paintPoint(stroke, v, mode, amount, {bone = stroke.bone, value = 1} = {}) {
  const {skin, part} = stroke;
  // A locked group can't be painted (Blender refuses too).
  if (listOf(bone).some(b => stroke.locked?.has(b))) return false;
  if (Array.isArray(bone)) { if (bone.length > 1) return paintSeveral(stroke, v, mode, amount, bone, value); bone = bone[0]; }
  if (stroke.autoNormalize === false) return paintAlone(stroke, v, mode, amount, bone, value);
  // Weights in groups without a bone move nothing: painting a bone leaves them as they are.
  const aside = (skin[v] ?? []).filter(([b]) => !stroke.bones.has(b)), all = (skin[v] ?? []).filter(([b]) => stroke.bones.has(b));
  // A merged bone's weights are frozen, as are a locked group's: painting another bone shares only what they leave.
  const held = heldFor(stroke, [bone]);
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
  const fallback = stroke.handOff === false ? () => [] : () => stroke.fallback(v, bone).filter(([b]) => !held.has(b));
  const changed = next < now ? lowered(stroke.model, pairs, bone, now - next, fallback, held, stroke.handOff !== false) ?? withWeight(pairs, bone, next, fallback) : withWeight(pairs, bone, next, fallback);
  const result = [...(kept.length ? [...kept, ...changed.map(([b, x]) => [b, Math.round(x * free * 1e5) / 1e5])].filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]) : changed), ...aside];
  // Nothing could take the weight (a bone alone on the point, Hand off off): unchanged.
  if (sameWeights(result, skin[v])) return false;
  skin[v] = result;
  setStoredWeights(part.mesh, v, skin[v]);
  stroke.touched.add(v);
  return true;
}

/** The bones whose weights painting `bones` must not change: Merged bones and locked groups. */
function heldFor(stroke, bones) {
  const painted = new Set(bones);
  return new Set(stroke.model.bones.filter(b => !painted.has(b.id) && (isMerged(b) || stroke.locked?.has(b.id))).map(b => b.id));
}

/** Where a mode takes a weight `now` (smooth: the neighbours' average of `valueAt`). Null: no target. */
function targetOf(stroke, v, mode, value, valueAt) {
  if (mode === 'add') return 1;
  if (mode === 'remove') return 0;
  if (mode === 'set') return clamp01(value);
  if (mode === 'smooth') { const around = [...stroke.neighbours[v]]; return around.length ? around.reduce((t, u) => t + valueAt(u), 0) / around.length : null; }
  throw new Error(`Unknown paint mode “${mode}”.`);
}

const round5 = x => Math.round(x * 1e5) / 1e5;
/** Whether two weight lists give every bone the same weight (to 1e-5). */
function sameWeights(a, b) {
  const m = new Map((b ?? []).filter(([, x]) => x > 0));
  return (a ?? []).filter(([, x]) => x > 0).length === m.size && (a ?? []).every(([id, x]) => !(x > 0) || Math.abs((m.get(id) ?? -1) - x) < 1e-5);
}
function store(stroke, v, pairs) {
  stroke.skin[v] = pairs.filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]);
  setStoredWeights(stroke.part.mesh, v, stroke.skin[v]);
  stroke.touched.add(v);
  return true;
}

/** Auto Normalize off: only the bone's own weight changes (0 to 1); every other weight stays. */
function paintAlone(stroke, v, mode, amount, bone, value) {
  const pairs = stroke.skin[v] ?? [], now = weightIn(pairs, bone);
  const target = targetOf(stroke, v, mode, value, u => weightIn(stroke.skin[u], bone));
  if (target === null) return false;
  const next = clamp01(now + (target - now) * clamp01(amount));
  if (Math.abs(next - now) < 1e-4) return false;
  return store(stroke, v, [...pairs.filter(([b]) => b !== bone), ...(next > 1e-4 ? [[bone, round5(next)]] : [])]);
}

/** The least weight Multi-Paint leaves its bones together (it never takes them to zero). */
export const MULTI_PAINT_MIN = .001;

/** Multi-Paint: `bones` change together, each in proportion to what it has, as one weight: their
 * sum with Auto Normalize (the other bones then share the rest, Merged and locked ones kept), their
 * average without (the other bones untouched). A point where they have nothing is left alone. */
function paintSeveral(stroke, v, mode, amount, bones, value) {
  const average = stroke.autoNormalize === false, group = new Set(bones);
  const pairs = (stroke.skin[v] ?? []).map(p => p.slice()), mine = pairs.filter(([b]) => group.has(b) && stroke.bones.has(b));
  const now = groupWeightIn(mine, bones, average);
  if (now <= 0) return false;
  const target = targetOf(stroke, v, mode, value, u => groupWeightIn(stroke.skin[u], bones, average));
  if (target === null) return false;
  let next = Math.max(MULTI_PAINT_MIN, now + (target - now) * clamp01(amount));
  // No bone of the group past 1.
  const most = Math.max(...mine.map(([, x]) => x));
  next = Math.min(next, now / most);
  let others = [], free = 1;
  if (!average) {
    // Auto Normalize: what the group leaves, the other free bones share; held ones keep theirs.
    const held = heldFor(stroke, bones);
    free = 1 - pairs.filter(([b]) => held.has(b) && stroke.bones.has(b)).reduce((t, [, x]) => t + x, 0);
    others = pairs.filter(([b]) => !group.has(b) && !held.has(b) && stroke.bones.has(b));
    const rest = others.reduce((t, [, x]) => t + x, 0);
    // Nothing else can take what the group gives up: it keeps the point.
    next = Math.min(next, free);
    if (rest <= 1e-9) next = free;
  }
  if (Math.abs(next - now) < 1e-4) return false;
  const k = next / now, scaled = new Map(mine.map(([b, x]) => [b, round5(x * k)]));
  const rest = others.reduce((t, [, x]) => t + x, 0), share = rest > 0 ? (free - next) / rest : 0, moved = new Set(others.map(([b]) => b));
  return store(stroke, v, pairs.map(([b, x]) => [b, scaled.has(b) ? scaled.get(b) : moved.has(b) ? round5(x * share) : x]));
}

/** Points back to automatic weights (all of a part's points when `verts` is omitted). */
export const clearPainted = (part, verts = null) => clearStoredWeights(part.mesh, verts);

/** How many of a part's points carry their own weights. */
export const paintedCount = part => storedCount(part.mesh);

