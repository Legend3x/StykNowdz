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
