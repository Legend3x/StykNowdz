// Cel-shading helpers for Blender lite: the outline "inverted hull" and the
// toon settings a model carries. Pure: nothing here changes its inputs.
//
// The inverted hull is the classic anime outline trick (Blender's Solidify
// modifier with flipped normals and a black, back-face-culled material): a copy
// of the surface pushed out along its normals and turned inside out. Only its
// far side faces the viewer, so it is hidden behind the model everywhere except
// a thin rim around the silhouette (and along deep creases), which reads as an
// ink line. It uses the same skin as the part, so it bends with the bones.

import {add, sub, cross, scale, normalize} from './mesh.mjs';
import {assertValidMesh} from './topology.mjs';
import {TOON_DEFAULTS} from '../toon-shading.mjs';

export const OUTLINE_DEFAULTS = Object.freeze({thickness: .012, color: 9});
export const OUTLINE_MAX = .2;

/** Area-weighted vertex normals of a mesh (faces wind counter-clockwise seen from outside). */
export function vertexNormals(mesh) {
  const sums = mesh.verts.map(() => [0, 0, 0]);
  for (const face of mesh.faces) {
    const p = face.v.map(i => mesh.verts[i]);
    // Newell's method: a polygon's normal with length = twice its area.
    let n = [0, 0, 0];
    for (let i = 0; i < p.length; i++) n = add(n, cross(p[i], p[(i + 1) % p.length]));
    for (const i of face.v) sums[i] = add(sums[i], n);
  }
  return sums.map(normalize);
}

/** The outline shell of `mesh`: every vertex pushed out by `thickness` along
 * its normal, every face reversed and given `color`. Vertex i of the shell is
 * vertex i of the mesh, so the shell can share the mesh's skin weights. */
export function outlineHull(mesh, thickness = OUTLINE_DEFAULTS.thickness, color = OUTLINE_DEFAULTS.color) {
  const normals = vertexNormals(mesh), t = Math.max(0, Math.min(OUTLINE_MAX, Number(thickness) || 0));
  const hull = {
    verts: mesh.verts.map((p, i) => add(p, scale(normals[i], t))),
    faces: mesh.faces.map(f => ({v: f.v.slice().reverse(), c: color})),
  };
  assertValidMesh(hull, 'Outline', {});
  return hull;
}

/** Settings read from a stored model, filled with defaults and clamped. */
export function toonSettings(model) {
  const t = model?.toon ?? {};
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return {
    shadows: Boolean(t.shadows),
    turn: num(t.turn, -180, 180, TOON_DEFAULTS.turn),
    height: num(t.height, -89, 89, TOON_DEFAULTS.height),
    size: num(t.size, 0, 1, TOON_DEFAULTS.size),
    strength: num(t.strength, 0, 1, TOON_DEFAULTS.strength),
  };
}

/** A part's outline settings, or null when it has none. */
export function partOutline(part, paletteSize = Infinity) {
  const o = part?.outline;
  if (!o || !o.on) return null;
  const thickness = Number(o.thickness);
  const color = Number.isInteger(o.color) && o.color >= 0 && o.color < paletteSize ? o.color : Math.min(OUTLINE_DEFAULTS.color, paletteSize - 1);
  return {thickness: Number.isFinite(thickness) ? Math.max(.001, Math.min(OUTLINE_MAX, thickness)) : OUTLINE_DEFAULTS.thickness, color};
}

/** Distance between two points (for tests and the UI). */
export const distance = (a, b) => Math.hypot(...sub(a, b));
