/** How 3D Nowdz shows weights (docs/BLENDER-LITE.md, "Weight colours"), as Blender's Weight
 * Paint mode does: each point's weight in the selected bone's group, blended smoothly across
 * every face, and only then turned into a colour, pixel by pixel. So halfway between a point at
 * 0 and one at 1 is green, not a muddy mix of blue and red, and a face runs through the whole
 * rainbow between its corners.
 *
 * - The colours: Blender's weight ramp (weight_to_rgb in Blender's source, as recalled: blue,
 *   cyan, green, yellow, red at 0, ¼, ½, ¾ and 1, each also brighter as the weight rises).
 * - Zero weights (Blender's Overlays > Zero Weights > Active): points with no weight in the
 *   group show black, fading into the colours of the points around them.
 *
 * The WebGL viewport draws weights as a texture lookup (WEIGHT_RAMP: the ramp in one row, black
 * in the other; weightUv gives a point's texture coordinates), so the GPU blends the weight and
 * looks up its colour per pixel. Without WebGL (and in X-ray) fillWeightPolygon gives the canvas a
 * linear gradient per triangle that does the same: a weight blended across a triangle changes at
 * one steady rate in one direction, so a gradient along that direction through the ramp's colours
 * (GRADIENT_STOPS, close enough that the gentle curve between them is under half a step of 255) matches. */

/** Blender's weight colour (0–255 RGB) for a weight 0–1. */
export function weightRgb(weight) {
  const w = Math.max(0, Math.min(1, Number(weight) || 0)), blend = w / 2 + .5;
  const rgb = w <= .25 ? [0, blend * w * 4, blend]
    : w <= .5 ? [0, blend, blend * (1 - (w - .25) * 4)]
      : w <= .75 ? [blend * (w - .5) * 4, blend, 0]
        : [blend, blend * (1 - (w - .75) * 4), 0];
  return rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
}

/** The weights where the ramp changes from one pair of colours to the next. Between them it
 * curves gently (each colour also brightens as the weight rises). */
export const RAMP_STOPS = Object.freeze([0, .25, .5, .75, 1]);

/** Canvas gradient stops: every 1/16, close enough that straight lines between them stay within
 * half a step of the ramp's 0–255 values (the curve is 2w² + 2w at most: error h²/2 for a step h). */
export const GRADIENT_STOPS = Object.freeze(Array.from({length: 17}, (_, i) => i / 16));

/** A triangle whose weights differ by less than this is one colour (no visible step: under half
 * a step of 0–255 anywhere on the ramp), so most faces skip the gradient. */
const EVEN = 1 / 1024;

/** Texture size of the WebGL ramp: 256 weights across, two rows (black above the colours). */
export const RAMP_WIDTH = 256;

/** The ramp as RGBA pixels (RAMP_WIDTH × 2): row 0 black (zero weights), row 1 the colours,
 * texel i holding the colour of weight i / 255. */
export function rampPixels() {
  const data = new Uint8ClampedArray(RAMP_WIDTH * 2 * 4);
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const [r, g, b] = weightRgb(i / (RAMP_WIDTH - 1)), at = (RAMP_WIDTH + i) * 4;
    data[i * 4 + 3] = 255;
    data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
  }
  return data;
}

let rampImage = null;
/** The ramp as an image the WebGL pass can use as a texture (one, made on first use); null
 * where there is no ImageData (outside a browser). */
export function weightRampImage() {
  if (!rampImage && typeof ImageData !== 'undefined') rampImage = new ImageData(rampPixels(), RAMP_WIDTH, 2);
  return rampImage;
}

/** A point's texture coordinates on the ramp: u lands on the texel centre for its weight; v is
 * the colours row (0.25), or the black row (0.75) for a zero weight shown black. The viewport's
 * texture lookup flips v (1 − v), and blends linearly between rows as between texels. */
export function weightUv(weight, black = false) {
  const w = Math.max(0, Math.min(1, Number(weight) || 0));
  return [(w * (RAMP_WIDTH - 1) + .5) / RAMP_WIDTH, black ? .75 : .25];
}

/** Where a value given at a triangle's three screen corners (each {x, y}) is 0 and where it is 1,
 * along the line it changes fastest: {from: [x, y], to: [x, y]}, or null when it doesn't change
 * across the triangle (or the triangle has no area). A canvas linear gradient between them gives
 * every pixel its blended value. */
export function gradientLine(pts, values) {
  const [a, b, c] = pts, [va, vb, vc] = values;
  const x1 = b.x - a.x, y1 = b.y - a.y, x2 = c.x - a.x, y2 = c.y - a.y, det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-9) return null;
  // value = va + gx·(x − a.x) + gy·(y − a.y), solved from the other two corners.
  const d1 = vb - va, d2 = vc - va, gx = (d1 * y2 - d2 * y1) / det, gy = (x1 * d2 - x2 * d1) / det, g2 = gx * gx + gy * gy;
  if (g2 < 1e-18) return null;
  // The point on the gradient line through a where the value is 0, then a value of 1 further on.
  const back = va / g2, from = [a.x - gx * back, a.y - gy * back];
  return {from, to: [from[0] + gx / g2, from[1] + gy / g2]};
}

const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`;
const shaded = (rgb, light) => rgb.map(v => Math.max(0, Math.min(255, Math.round(v * light))));

/** Fill a screen polygon (corners {x, y}) whose corners have `weights`, lit by `light` (the
 * viewport's brightness factor), as the WebGL pass would: per triangle of its fan, a gradient
 * through the ramp's stops; with `black` (zero weights shown), a second gradient fading to black
 * towards the points with none. Each triangle's edge is stroked thinly in the same paint so
 * neighbouring triangles leave no seam. `weights` and `black` (0 or 1 per corner) are in corner order. */
export function fillWeightPolygon(ctx, pts, weights, light, black = null) {
  // An even face (most of them) is one colour: filled once, as a whole polygon.
  const ws = weights.map(w => Math.max(0, Math.min(1, w)));
  if (Math.max(...ws) - Math.min(...ws) < EVEN && (!black || black.every(b => b === black[0]))) {
    polygon(ctx, pts, black?.[0] ? 'rgb(0,0,0)' : rgbCss(shaded(weightRgb(ws.reduce((t, w) => t + w, 0) / ws.length), light)));
    return;
  }
  for (let i = 1; i + 1 < pts.length; i++) {
    const tri = [pts[0], pts[i], pts[i + 1]], ws = [weights[0], weights[i], weights[i + 1]].map(w => Math.max(0, Math.min(1, w)));
    const line = Math.max(...ws) - Math.min(...ws) < EVEN ? null : gradientLine(tri, ws);
    let paint;
    if (!line) paint = rgbCss(shaded(weightRgb((ws[0] + ws[1] + ws[2]) / 3), light));
    else {
      paint = ctx.createLinearGradient(line.from[0], line.from[1], line.to[0], line.to[1]);
      for (const s of GRADIENT_STOPS) paint.addColorStop(s, rgbCss(shaded(weightRgb(s), light)));
    }
    triangle(ctx, tri, paint);
    if (!black) continue;
    const bs = [black[0], black[i], black[i + 1]].map(Number);
    if (!bs.some(Boolean)) continue;
    const fade = bs.every(Boolean) ? null : gradientLine(tri, bs);
    let dark;
    if (!fade) dark = 'rgb(0,0,0)';
    else { dark = ctx.createLinearGradient(fade.from[0], fade.from[1], fade.to[0], fade.to[1]); dark.addColorStop(0, 'rgba(0,0,0,0)'); dark.addColorStop(1, 'rgba(0,0,0,1)'); }
    // Not stroked: see-through black drawn twice along an edge would show as a darker line.
    triangle(ctx, tri, dark, false);
  }
}

const triangle = (ctx, tri, paint, seam = true) => polygon(ctx, tri, paint, seam);
function polygon(ctx, pts, paint, seam = true) {
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
  ctx.fillStyle = paint; ctx.fill();
  if (seam) { ctx.strokeStyle = paint; ctx.lineWidth = .6; ctx.stroke(); }
}
