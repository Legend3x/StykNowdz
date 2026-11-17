/** Squash and stretch for a whole 3D figure (docs/SQUASH-STRETCH.md).
 *
 * A posed object may hold `_stykSquash = {amount, angle}`: `amount` stretches
 * the figure along a direction on screen (above 1 stretches, below 1 squashes)
 * and thins or widens it across by 1/√amount, so it keeps its volume; `angle`
 * turns that direction from straight up and down (degrees, clockwise); `from`
 * is where it squashes from, 0 the figure's bottom (so a landing squashes into
 * the ground) to 1 its top, 0.5 its middle (a ball in the air). They key and tween with
 * the pose; a missing value is rest (amount 1). It is applied where the figure
 * meets the screen, after its bones and before perspective, so the pose itself
 * is unchanged: editing still edits the figure, and taking the squash off gives
 * back the same pose. Single parts squash with the rig's own proportions
 * (editor-squash.mjs). */

export const SQUASH_MIN = .2, SQUASH_MAX = 5, ANGLE_LIMIT = 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A stored value cleaned, or null for none (rest, or nothing valid). */
export function readSquash(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = Number.isFinite(value.amount) ? clamp(value.amount, SQUASH_MIN, SQUASH_MAX) : 1;
  const angle = Number.isFinite(value.angle) ? clamp(value.angle, -ANGLE_LIMIT, ANGLE_LIMIT) : 0;
  const from = Number.isFinite(value.from) ? clamp(value.from, 0, 1) : 0;
  if (Math.abs(amount - 1) < 1e-6) return null;
  return {amount, ...(angle ? {angle} : {}), ...(from ? {from} : {})};
}
/** What the panel shows: the amount, direction and where from, rest when none. */
export const squashValues = object => ({amount: 1, angle: 0, from: 0, ...readSquash(object?._stykSquash)});

const boxes = new WeakMap();
/** A figure's rest box in its own space (y down): its 3D mesh, else its 3D bones. */
function figureBox(figure) {
  if (!figure) return null;
  if (boxes.has(figure)) return boxes.get(figure);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  const positions = figure._styk?.spatialMesh?.positions;
  if (positions?.length) for (let i = 0; i + 2 < positions.length; i += 3) add(positions[i], positions[i + 1]);
  else for (const s of figure.segments ?? []) { const r = s._stykRig?.spatial; if (r?.origin) { add(r.origin[0], r.origin[1]); if (r.tip) add(r.tip[0], r.tip[1]); } }
  const box = x0 <= x1 ? {cx: (x0 + x1) / 2, top: y0, bottom: y1} : null;
  boxes.set(figure, box);
  return box;
}

/** The screen mapping for an object's squash, or null for none. It squashes
 * about the point `from` of the way up the figure (its root when the figure's
 * shape isn't known); `figure`, `figureAngle`, `scale` and `mirror` place that
 * point as the figure is drawn. */
export function squashTransform(object, root, {figure = null, figureAngle = 0, scale = 1, mirror = false} = {}) {
  const q = readSquash(object?._stykSquash);
  if (!q || !root) return null;
  let cx = root.x, cy = root.y;
  const box = figureBox(figure);
  if (box) {
    const px = box.cx, py = box.bottom + (box.top - box.bottom) * (q.from ?? 0), cs = Math.cos(figureAngle), sn = Math.sin(figureAngle), sign = mirror ? -1 : 1;
    cx = root.x + (px * cs - py * sign * sn) * scale; cy = root.y + (px * sn + py * sign * cs) * scale;
  }
  const a = (q.angle ?? 0) * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a), along = q.amount, across = 1 / Math.sqrt(q.amount);
  const map = (x, y) => {
    const dx = x - cx, dy = y - cy, d = dx * ux + dy * uy, px = dx - d * ux, py = dy - d * uy;
    return [cx + d * along * ux + px * across, cy + d * along * uy + py * across];
  };
  map.invert = (x, y) => {
    const dx = x - cx, dy = y - cy, d = dx * ux + dy * uy, px = dx - d * ux, py = dy - d * uy;
    return [cx + d / along * ux + px / across, cy + d / along * uy + py / across];
  };
  map.amount = q.amount; map.angle = q.angle ?? 0; map.from = q.from ?? 0;
  return map;
}

/** Between keys: the amount and the direction tween; a missing side is rest
 * (amount 1, keeping the other side's direction so it doesn't swing). */
export function interpolateSquash(a, b, t) {
  const x = readSquash(a), y = readSquash(b);
  if (!x && !y) return undefined;
  const ax = x?.amount ?? 1, bx = y?.amount ?? 1, pick = (k, rest) => [x?.[k] ?? (x ? rest : y?.[k] ?? rest), y?.[k] ?? (y ? rest : x?.[k] ?? rest)];
  const [angleA, angleB] = pick('angle', 0), [fromA, fromB] = pick('from', 0);
  // Amounts tween evenly in stretch and squash: halfway from 0.5 to 2 is 1.
  const amount = Math.exp(Math.log(ax) + (Math.log(bx) - Math.log(ax)) * t);
  return readSquash({amount, angle: angleA + (angleB - angleA) * t, from: fromA + (fromB - fromA) * t}) ?? undefined;
}
