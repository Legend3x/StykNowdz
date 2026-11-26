/** 3D Nowdz's weight paint stroke engine (docs/BLENDER-LITE.md, "Brush strokes"): where a stroke
 * puts its dabs, how hard each one presses, and which points face the viewer, as Blender's
 * Weight Paint strokes do.
 *
 * - Spacing (Blender's Space stroke): dabs fall a fixed distance apart along the pointer's path,
 *   the leftover carried from one pointer move to the next, so a stroke paints the same however
 *   fast it is drawn and however often the pointer reports. (Before, every pointer move painted
 *   at least one dab, so a slow stroke or a fast mouse painted harder.)
 * - Pressure: a pen's pressure (0–1) scales Strength and, if asked, the brush's size. A mouse or
 *   a finger counts as full pressure (browsers report 0.5 for a pressed mouse button).
 * - Front Faces Only: a point is painted only where its surface faces the viewer.
 *
 * A stroke here is any object; spacedDabs keeps `last` (the previous pointer position) and
 * `travel` (how far the pointer has gone since the last dab) on it. */

/** A pointer sample: {x, y, pressure}. A pen's pressure as reported; anything else 1. */
export function pointerSample(p, event) {
  const pen = event?.pointerType === 'pen', pressure = pen && Number.isFinite(event.pressure) ? Math.max(0, Math.min(1, event.pressure)) : 1;
  return {x: p.x, y: p.y, pressure};
}

/** The dabs a pointer move to `p` ({x, y, pressure}) makes: the first sample of a stroke is a
 * dab; after that, one every `spacing` pixels along the path from the last sample, pressure
 * blended along the way. Updates stroke.last and stroke.travel. */
export function spacedDabs(stroke, p, spacing) {
  const step = Math.max(1, spacing);
  if (!stroke.last) { stroke.last = p; stroke.travel = 0; return [{x: p.x, y: p.y, pressure: p.pressure ?? 1}]; }
  const from = stroke.last, d = Math.hypot(p.x - from.x, p.y - from.y), dabs = [];
  let at = step - (stroke.travel ?? 0);
  for (; at <= d + 1e-9; at += step) {
    const t = d > 0 ? at / d : 1, pa = from.pressure ?? 1, pb = p.pressure ?? 1;
    dabs.push({x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t, pressure: pa + (pb - pa) * t});
  }
  // How far past the last dab the pointer now is (all of this move and before, if none fell in it).
  stroke.travel = d - (at - step);
  stroke.last = p;
  return dabs;
}

/** Front Faces Only: whether a point whose surface turns `normal` faces the viewer (`toEye`, the
 * direction from the point toward the eye). A point with no normal (nothing around it) counts. */
export function facesViewer(normal, toEye) {
  if (!normal || !(normal[0] || normal[1] || normal[2])) return true;
  return normal[0] * toEye[0] + normal[1] * toEye[1] + normal[2] * toEye[2] > 0;
}

/** Smear's source for a point at `at`: of its neighbours (`around`, [id, position] pairs), the one behind
 * it along the stroke, whose weight it is dragged towards. As Blender's: both the stroke's direction
 * `dir` and each point − neighbour are flattened onto the view plane (`normal` towards the viewer), and
 * the neighbour that lines up best with the stroke, if any does at all, wins. Null: none (no movement
 * yet, or every neighbour is ahead). */
export function smearSource(at, around, dir, normal) {
  const n = unit(normal), flat = d => (n ? sub(d, scale(n, dot(d, n))) : d), way = unit(flat(dir ?? [0, 0, 0]));
  if (!way) return null;
  let best = 0, source = null;
  for (const [id, p] of around) {
    const o = unit(flat(sub(at, p)));
    if (!o) continue;
    const d = dot(o, way);
    if (d > best) { best = d; source = id; }
  }
  return source;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = d => { if (!d) return null; const l = Math.hypot(d[0], d[1], d[2]); return l > 1e-12 ? scale(d, 1 / l) : null; };
