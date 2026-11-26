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
 * - Blend (Blender's Draw brush): the draw mode takes a point's weight towards
 *   Amount with one of Blender's blends (BLENDS, blendWeight): Mix, Add,
 *   Subtract, Lighten, Darken or Multiply. The add, remove and set modes are
 *   Draw with Mix at 1, 0 and Amount (the brush's Add, Remove and Set presets).
 *
 * - Blur, Smear and Average (Blender's): blur mixes a point towards the average
 *   of the corners of the faces around it; smear towards one neighbour, the
 *   one behind it along the stroke (smearSource in paint-stroke.mjs); Average
 *   is Draw with the average under the brush (weightAt). Blur and Smear read
 *   the weights as they were when the dab began (startDab), as Blender's
 *   precomputed weights, so the order points are painted in doesn't matter.
 *   smooth (edge neighbours' average, read as they are) is kept for code.
 *
 * startStroke(model, part, bone) → stroke state for one part and bone (or an
 * array of bones: Multi-Paint); paintPoint(stroke, v, mode, amount, {value, blend, from})
 * changes one point (mode draw, blur, smear, smooth, or the presets add, remove
 * and set); clearPainted(part, verts?) returns points to automatic. */
import {completeSkin, autoWeights, otherSide, isMerged} from './armature.mjs';
import {transformMesh, objectMatrix} from './mesh.mjs';
import {setStoredWeights, clearStoredWeights, storedCount, storedWeights} from './weight-manager.mjs';
import {autoNormalizeOn, isGroupLocked} from './vertex-groups.mjs';

export const PAINT_MODES = Object.freeze(['draw', 'blur', 'smear', 'smooth', 'add', 'remove', 'set']);
/** Blender's weight paint blends, in the order of its Blend menu. */
export const BLENDS = Object.freeze(['mix', 'add', 'subtract', 'lighten', 'darken', 'multiply']);
const clamp01 = x => Math.max(0, Math.min(1, x));

/** A dab with `alpha` (its strength there, 0–1) on a weight, painting `value`: Blender's weight
 * blends (paint_weight's wval_*). Mix goes `alpha` of the way to value; Add and Subtract add or take
 * value × alpha; Lighten and Darken mix only where the weight is below or above value; Multiply
 * scales the weight by value, alpha of the way. Not clamped: the caller keeps it within 0–1. */
export function blendWeight(blend, weight, value, alpha) {
  switch (blend) {
    case 'mix': return weight + (value - weight) * alpha;
    case 'add': return weight + value * alpha;
    case 'subtract': return weight - value * alpha;
    case 'lighten': return weight < value ? weight + (value - weight) * alpha : weight;
    case 'darken': return weight > value ? weight + (value - weight) * alpha : weight;
    case 'multiply': return (1 - alpha + alpha * value) * weight;
  }
  throw new Error(`Unknown blend “${blend}”.`);
}

/** What a mode paints: {blend, value} (Draw, and its presets add, remove and set), or for the
 * brushes that take weight from around the point {blend: 'mix', from} (they always build up). */
export function brushOf(mode, value = 1, blend = 'mix', from = null) {
  if (mode === 'add') return {blend: 'mix', value: 1};
  if (mode === 'remove') return {blend: 'mix', value: 0};
  if (mode === 'set') return {blend: 'mix', value: clamp01(value)};
  if (mode === 'draw') { if (!BLENDS.includes(blend)) throw new Error(`Unknown blend “${blend}”.`); return {blend, value: clamp01(value)}; }
  if (mode === 'smooth') return {from: 'edges', blend: 'mix'};
  if (mode === 'blur') return {from: 'faces', blend: 'mix'};
  if (mode === 'smear') { if (!Number.isInteger(from)) throw new Error('Smear needs the point it takes weight from.'); return {from: 'point', point: from, blend: 'mix'}; }
  throw new Error(`Unknown paint mode “${mode}”.`);
}

/** The opposite of a Draw brush (Ctrl while painting): Mix paints 1 − Amount, Lighten and Darken
 * swap (at 1 − Amount), Add and Subtract swap; Multiply is its own opposite's undo, so it stays. */
export function invertedBrush({blend, value}) {
  if (blend === 'mix') return {blend, value: 1 - value};
  if (blend === 'lighten') return {blend: 'darken', value: 1 - value};
  if (blend === 'darken') return {blend: 'lighten', value: 1 - value};
  if (blend === 'add') return {blend: 'subtract', value};
  if (blend === 'subtract') return {blend: 'add', value};
  return {blend, value};
}
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
export function startStroke(model, part, bone, {accumulate = true} = {}) {
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
  return {model, part, bone, skin, neighbours, fallback, bones: new Set(model.bones.map(b => b.id)), locked, autoNormalize: autoNormalizeOn(model), handOff: handOffOn(model),
    // Accumulate (see reached); each changed point's stored weights from before the stroke, for its undo step.
    accumulate, start: new Map(), alpha: new Map(), before: new Map(), touched: new Set(),
    // The weights as they were when the dab began (startDab), for Blur and Smear; null: read them as they are.
    dabCopy: null};
}

/** A new dab begins: Blur and Smear read every point's weights as they are now until the next one
 * (a point's old weights are kept the first time the dab changes it). */
export function startDab(stroke) { stroke.dabCopy = new Map(); }

/** A point's weights as the dab found them. */
const pairsAt = (stroke, v) => (stroke.dabCopy?.has(v) ? stroke.dabCopy.get(v) : stroke.skin[v]);

/** A point's weight for `bone` as the dab found it, out of the whole point (several bones, Multi-Paint:
 * their sum, or their average with Auto Normalize off). */
export function weightAt(stroke, v, bone) {
  return Array.isArray(bone) && bone.length > 1 ? groupWeightIn(pairsAt(stroke, v), bone, stroke.autoNormalize === false) : weightIn(pairsAt(stroke, v), listOf(bone)[0]);
}

/** The faces around each point, by index (built once per stroke). */
function facesAround(stroke, v) {
  if (!stroke.vertFaces) {
    stroke.vertFaces = stroke.part.mesh.verts.map(() => []);
    stroke.part.mesh.faces.forEach((f, i) => { for (const u of new Set(f.v)) stroke.vertFaces[u].push(i); });
  }
  return stroke.vertFaces[v];
}

/** The other points of the faces around a point (Smear's candidates, as Blender's). */
export function pointsAround(stroke, v) {
  const out = new Set();
  for (const i of facesAround(stroke, v)) for (const u of stroke.part.mesh.faces[i].v) if (u !== v) out.add(u);
  return [...out];
}

/** Average's value for a dab: the mean weight of the points under it, as the dab found them.
 * `spots` lists [stroke, point, bone]. Null when there are none. */
export function dabAverage(spots) {
  if (!spots.length) return null;
  return spots.reduce((t, [stroke, v, bone]) => t + weightAt(stroke, v, bone), 0) / spots.length;
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

/** Paint one point with a dab of `amount` (0–1): Draw blends the weight with `value` by `blend`
 * (add, remove and set: Mix at 1, 0 and value); blur mixes it towards the average of the face corners
 * around it, smear towards point `from`, smooth towards its edge neighbours' average.
 * `bone` defaults to the stroke's bone (a Mirror copy paints the other side's bone). True if it changed. */
export function paintPoint(stroke, v, mode, amount, {bone = stroke.bone, value = 1, blend = 'mix', from = null} = {}) {
  const {skin, part} = stroke, brush = brushOf(mode, value, blend, from);
  // A locked group can't be painted (Blender refuses too).
  if (listOf(bone).some(b => stroke.locked?.has(b))) return false;
  if (Array.isArray(bone)) { if (bone.length > 1) return paintSeveral(stroke, v, brush, amount, bone); bone = bone[0]; }
  if (stroke.autoNormalize === false) return paintAlone(stroke, v, brush, amount, bone);
  // Weights in groups without a bone move nothing: painting a bone leaves them as they are.
  const aside = (skin[v] ?? []).filter(([b]) => !stroke.bones.has(b)), all = (skin[v] ?? []).filter(([b]) => stroke.bones.has(b));
  // A merged bone's weights are frozen, as are a locked group's: painting another bone shares only what they leave.
  const held = heldFor(stroke, [bone]);
  const kept = all.filter(([b]) => held.has(b)), free = 1 - kept.reduce((t, [, x]) => t + x, 0);
  if (free <= 1e-4) return false;
  const pairs = all.filter(([b]) => !held.has(b)).map(([b, x]) => [b, x / free]), now = weightIn(pairs, bone);
  let target = valueOf(stroke, v, brush, u => weightIn(pairsAt(stroke, u), bone));
  if (target === null) return false;
  // Weights are named out of the whole point; the free share is what can change (Multiply's value is a factor).
  if (brush.blend !== 'multiply') target = Math.min(1, target / free);
  const reach = reached(stroke, `${v}:${bone}`, brush, now, target, clamp01(amount));
  if (reach === null) return false;
  const next = clamp01(reach);
  if (Math.abs(next - now) * free < 1e-4) return false;
  const fallback = stroke.handOff === false ? () => [] : () => stroke.fallback(v, bone).filter(([b]) => !held.has(b));
  const changed = next < now ? lowered(stroke.model, pairs, bone, now - next, fallback, held, stroke.handOff !== false) ?? withWeight(pairs, bone, next, fallback) : withWeight(pairs, bone, next, fallback);
  const result = [...(kept.length ? [...kept, ...changed.map(([b, x]) => [b, Math.round(x * free * 1e5) / 1e5])].filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]) : changed), ...aside];
  // Nothing could take the weight (a bone alone on the point, Hand off off): unchanged.
  if (sameWeights(result, skin[v])) return false;
  remember(stroke, v);
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

/** The value a brush paints at point v, `valueAt` giving a point's weight: Draw's Amount; for smear
 * point `from`'s; for blur the average over every corner of every face around v (v's own corners
 * too, so a point on more faces counts more, as Blender's); for smooth the edge neighbours' average.
 * Null: nothing to take (a loose point). */
function valueOf(stroke, v, brush, valueAt) {
  if (!brush.from) return brush.value;
  if (brush.from === 'point') return valueAt(brush.point);
  if (brush.from === 'faces') {
    let sum = 0, n = 0;
    for (const i of facesAround(stroke, v)) for (const u of stroke.part.mesh.faces[i].v) { sum += valueAt(u); n++; }
    return n ? sum / n : null;
  }
  const around = [...stroke.neighbours[v]];
  return around.length ? around.reduce((t, u) => t + valueAt(u), 0) / around.length : null;
}

const round5 = x => Math.round(x * 1e5) / 1e5;

/** Where a brush takes a point's weight (`now`), painting `value` with this dab's `amount` (blendWeight).
 * With Accumulate on (startStroke's default, and painting from code), each dab goes on from
 * where the last left the point. Off (Blender's default for brush strokes; the brush passes it):
 * a stroke blends the weight the point had when the stroke first reached it, by the strongest
 * amount any dab has given it, so going over a spot again in the same stroke adds nothing unless
 * the dab is stronger. Blur, Smear and Smooth always go on from where the point is (Smear as
 * Blender's; Blur as Smooth always did). Null: nothing new. */
function reached(stroke, key, brush, now, value, amount) {
  if (stroke.accumulate !== false || brush.from) return blendWeight(brush.blend, now, value, amount);
  const had = stroke.alpha.get(key);
  if (had !== undefined && amount <= had) return null;
  if (had === undefined) stroke.start.set(key, now);
  stroke.alpha.set(key, amount);
  return blendWeight(brush.blend, stroke.start.get(key), value, amount);
}

/** Keep a point's stored weights from before the stroke changed it (null: it had none), and its
 * weights from before this dab (Blur and Smear read those). Weight lists are replaced, never changed. */
function remember(stroke, v) {
  if (stroke.dabCopy && !stroke.dabCopy.has(v)) stroke.dabCopy.set(v, stroke.skin[v]);
  if (stroke.before && !stroke.before.has(v)) stroke.before.set(v, storedWeights(stroke.part.mesh, v)?.map(p => p.slice()) ?? null);
}
/** Whether two weight lists give every bone the same weight (to 1e-5). */
function sameWeights(a, b) {
  const m = new Map((b ?? []).filter(([, x]) => x > 0));
  return (a ?? []).filter(([, x]) => x > 0).length === m.size && (a ?? []).every(([id, x]) => !(x > 0) || Math.abs((m.get(id) ?? -1) - x) < 1e-5);
}
function store(stroke, v, pairs) {
  remember(stroke, v);
  stroke.skin[v] = pairs.filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]);
  setStoredWeights(stroke.part.mesh, v, stroke.skin[v]);
  stroke.touched.add(v);
  return true;
}

/** Auto Normalize off: only the bone's own weight changes (0 to 1); every other weight stays. */
function paintAlone(stroke, v, brush, amount, bone) {
  const pairs = stroke.skin[v] ?? [], now = weightIn(pairs, bone);
  const target = valueOf(stroke, v, brush, u => weightIn(pairsAt(stroke, u), bone));
  if (target === null) return false;
  const reach = reached(stroke, `${v}:${bone}`, brush, now, target, clamp01(amount));
  if (reach === null) return false;
  const next = clamp01(reach);
  if (Math.abs(next - now) < 1e-4) return false;
  return store(stroke, v, [...pairs.filter(([b]) => b !== bone), ...(next > 1e-4 ? [[bone, round5(next)]] : [])]);
}

/** The least weight Multi-Paint leaves its bones together (it never takes them to zero). */
export const MULTI_PAINT_MIN = .001;

/** Multi-Paint: `bones` change together, each in proportion to what it has, as one weight: their
 * sum with Auto Normalize (the other bones then share the rest, Merged and locked ones kept), their
 * average without (the other bones untouched). A point where they have nothing is left alone. */
function paintSeveral(stroke, v, brush, amount, bones) {
  const average = stroke.autoNormalize === false, group = new Set(bones);
  const pairs = (stroke.skin[v] ?? []).map(p => p.slice()), mine = pairs.filter(([b]) => group.has(b) && stroke.bones.has(b));
  const now = groupWeightIn(mine, bones, average);
  if (now <= 0) return false;
  const target = valueOf(stroke, v, brush, u => groupWeightIn(pairsAt(stroke, u), bones, average));
  if (target === null) return false;
  const reach = reached(stroke, `${v}:${bones.join('+')}`, brush, now, target, clamp01(amount));
  if (reach === null) return false;
  let next = Math.max(MULTI_PAINT_MIN, reach);
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

