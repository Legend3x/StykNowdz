/** Toon (cel) shading shared by the stage and 3D Nowdz's preview.
 *
 * A toon-shaded mesh has one light that stays fixed relative to the viewer, so
 * as a figure turns its shadows move across it. Each visible triangle is
 * either lit (its own colour) or in shadow (a darker, cooler version of the
 * same colour): a hard edge, no gradients, like anime cel shading. Shadow
 * colours are derived from the colours actually shown, so recolouring a figure
 * recolours its shadows too.
 *
 * Directions are in view space: x right, y DOWN (screen), z toward the viewer.
 * Everything here is pure. */

export const TOON_DEFAULTS = Object.freeze({turn: -60, height: 30, size: .5, strength: .35});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Unit light direction (toward the light) from a turn around the figure
 * (degrees; 0 = from the front, negative = from the viewer's left) and a
 * height (degrees; positive = from above). */
export function toonLight(turn = TOON_DEFAULTS.turn, height = TOON_DEFAULTS.height) {
  const a = clamp(Number(turn) || 0, -180, 180) * Math.PI / 180, h = clamp(Number(height) || 0, -89, 89) * Math.PI / 180;
  return Object.freeze([Math.sin(a) * Math.cos(h), -Math.sin(h), Math.cos(a) * Math.cos(h)]);
}

/** Shadow size 0..1 (none .. most of the figure) to the lit/shadow cut-off on
 * cos(angle between surface and light). */
export const toonThreshold = (size = TOON_DEFAULTS.size) => clamp(Number(size), 0, 1) * 1.3 - .65;

/** The shadow colour of `rgb` (0-255 each) for a strength 0..1: darker, with
 * blue kept a little more than red and green, as painted anime shadows are. */
export function shadowColor(rgb, strength = TOON_DEFAULTS.strength) {
  const s = clamp(Number(strength) || 0, 0, 1), keep = [1 - s, 1 - s * .92, 1 - s * .6];
  return [0, 1, 2].map(k => clamp(Math.round(rgb[k] * keep[k]), 0, 255));
}

/** True when a surface with outward unit-ish normal `n` (view space) is lit. */
export const toonLit = (n, light, threshold) => {
  const len = Math.hypot(n[0], n[1], n[2]);
  return !(len > 0) || (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / len >= threshold;
};
