/**
 * Blender's Weights menu and Weight Gradient, as plain functions on numbers and weight lists
 * (a point's weights: [[bone id, weight], …]). The 3D Nowdz UI applies them: Invert, Levels and
 * Quantize change the painted bone through paintPoint (so Auto Normalize, locks and Multi-Paint
 * hold, as for Fill); Clean and Mirror rewrite whole weight lists.
 *
 * - Gradient (paint.weight_gradient): a point's place along the line (Linear) or its distance from
 *   the start over the line's length (Radial), 0 at the start, 1 at the end; the brush's falloff of
 *   that, times Strength, mixes the point's own weight towards Amount. Behind a linear start: all
 *   Amount; at and past the end: the point keeps its weight.
 * - Invert: 1 − weight. Levels: Gain × (weight + Offset). Quantize: to the nearest of Steps levels.
 *   Each kept within 0–1.
 * - Clean: weights at or below Limit leave the point (locked bones stay), keeping its largest with
 *   Keep single; with Auto Normalize the rest then add up to what they did (1, less the locked).
 * - Mirror (object.vertex_group_mirror, with Flip Names): a point takes its mirror image's weights
 *   (the point at −X), each bone swapped for its other side's (.L ↔ .R). Swap sides does both ways
 *   at once, as Blender; Left → Right and Right → Left copy one side over the other (left is +X).
 */

export const GRADIENT_TYPES = Object.freeze(['linear', 'radial']);
export const MIRROR_WAYS = Object.freeze(['swap', 'leftToRight', 'rightToLeft']);
const clamp01 = x => Math.max(0, Math.min(1, x));
const total = pairs => pairs.reduce((t, [, w]) => t + w, 0);

/** Where screen point `s` lies on the gradient from `a` to `b`: 0 at the start, 1 at the end (Linear:
 * along the line, negative behind the start; Radial: distance from the start). Null for a line too short. */
export function gradientFactor(type, s, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return null;
  if (type === 'radial') return Math.hypot(s.x - a.x, s.y - a.y) / Math.sqrt(len2);
  if (type === 'linear') return ((s.x - a.x) * dx + (s.y - a.y) * dy) / len2;
  throw new Error(`Unknown gradient type “${type}”.`);
}

/** The gradient's weight for a point whose own weight is `now`, at factor `t`, painting `amount` with
 * `strength`; `falloff` (0 → 1 at the start, 1 → 0 at the end) shapes the fade. Null: leave it as it is. */
export function gradientWeight(now, t, amount, {strength = 1, falloff = x => 1 - x} = {}) {
  if (t === null || t >= 1) return null;
  const alpha = falloff(clamp01(t)) * strength;
  if (!(alpha > 0)) return null;
  return clamp01(now + (amount - now) * Math.min(1, alpha));
}

export const invertWeight = w => clamp01(1 - w);
export const levelsWeight = (w, {offset = 0, gain = 1} = {}) => clamp01(gain * (w + offset));
/** Rounded to the nearest of `steps` equal levels (a half rounds up). */
export function quantizeWeight(w, steps = 4) {
  const n = Math.max(1, Math.round(steps));
  return clamp01(Math.floor(w * n + .5) / n);
}

/** A point's weights without those at or below `limit` (locked bones kept). With `keepSingle` a point
 * keeps its largest rather than none. With `normalize` the remaining unlocked ones are scaled to the
 * share they and the removed ones had. Returns the same array when nothing goes. */
export function cleanPairs(pairs, {limit = 0, keepSingle = false, locked = new Set(), normalize = false} = {}) {
  const gone = pairs.filter(([b, w]) => !locked.has(b) && w <= limit);
  if (!gone.length) return pairs;
  let kept = pairs.filter(p => !gone.includes(p));
  if (!kept.length && keepSingle) kept = [gone.reduce((a, p) => (p[1] > a[1] ? p : a))];
  if (!normalize) return kept;
  const free = kept.filter(([b]) => !locked.has(b)), had = total(pairs.filter(([b]) => !locked.has(b))), now = total(free);
  if (!(now > 0)) return kept;
  const scale = had / now;
  return kept.map(([b, w]) => [b, locked.has(b) ? w : w * scale]);
}

/** A point's weights as its mirror image has them: each bone exchanged for its other side's (`flip`). */
export function mirroredPairs(pairs, flip) {
  const out = new Map();
  for (const [b, w] of pairs) { const o = flip(b); out.set(o, (out.get(o) ?? 0) + w); }
  return [...out];
}

/** Each point's mirror image among `points` ({key, at: [x, y, z]}): the point nearest (−x, y, z) within
 * `eps`, itself for a point on the middle. Points with none are left out of the map. */
export function mirrorPartners(points, eps) {
  const cell = Math.max(eps, 1e-9), keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`, grid = new Map();
  for (const p of points) { const k = keyOf(...p.at); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const out = new Map();
  for (const p of points) {
    const f = [-p.at[0], p.at[1], p.at[2]], [cx, cy, cz] = f.map(x => Math.floor(x / cell));
    let best = null, d = eps;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++)
      for (const o of grid.get(`${cx + i},${cy + j},${cz + k}`) ?? []) { const e = Math.hypot(o.at[0] - f[0], o.at[1] - f[1], o.at[2] - f[2]); if (e <= d) { d = e; best = o; } }
    if (best) out.set(p.key, best.key);
  }
  return out;
}

/** Whether a point at x takes its mirror image's weights for this way of mirroring (`eps`: the middle). */
export function mirrorTakes(way, x, eps) {
  if (way === 'swap') return true;
  if (way === 'leftToRight') return x < -eps;
  if (way === 'rightToLeft') return x > eps;
  throw new Error(`Unknown mirror way “${way}”.`);
}
