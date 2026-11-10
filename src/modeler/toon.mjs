// Cel-shading helpers for 3D Nowdz: the outline "inverted hull" and the
// toon settings a model carries. Pure: nothing here changes its inputs.
//
// The inverted hull is the classic anime outline trick (Blender's Solidify
// modifier with flipped normals and a black, back-face-culled material): a copy
// of the surface pushed out along its normals and turned inside out. Only its
// far side faces the viewer, so it is hidden behind the model everywhere except
// a thin rim around the silhouette (and along deep creases), which reads as an
// ink line. It uses the same skin as the part, so it bends with the bones.

import {add, sub, scale, lineWeightOf, vertexNormals} from './mesh.mjs';
import {assertValidMesh} from './topology.mjs';
import {TOON_DEFAULTS} from '../toon-shading.mjs';

export const OUTLINE_DEFAULTS = Object.freeze({thickness: .012, color: 9, fromPart: false, darken: .6});
export const OUTLINE_MAX = .2;
/** Most a point's line weight can scale the outline (Edit mode, Line weight). */
export const LINE_WEIGHT_MAX = 4;

/** Area-weighted vertex normals (shape only; custom normals don't move outlines). */
export {vertexNormals};

/** The outline shell of `mesh`: every vertex pushed out along its (geometric)
 * normal by `thickness` × its line weight (mesh.vdata.line, 1 by default; 0
 * means no line there, so lines taper to sharp tips), every face reversed.
 * Ink colour: palette index `color`, or with `fromPart` each face keeps its own
 * colour and carries `ink: darken`, drawn as a darker shade of it (inkColor in
 * toon-shading.mjs), for coloured line art. Vertex i of the shell is vertex i
 * of the mesh, so the shell can share the mesh's skin weights. */
export function outlineHull(mesh, thickness = OUTLINE_DEFAULTS.thickness, color = OUTLINE_DEFAULTS.color, {fromPart = false, darken = OUTLINE_DEFAULTS.darken} = {}) {
  const normals = vertexNormals(mesh), t = Math.max(0, Math.min(OUTLINE_MAX, Number(thickness) || 0));
  const weight = i => Math.max(0, Math.min(LINE_WEIGHT_MAX, lineWeightOf(mesh, i)));
  const ink = Math.max(0, Math.min(1, Number(darken) || 0));
  const hull = {
    verts: mesh.verts.map((p, i) => add(p, scale(normals[i], t * weight(i)))),
    faces: mesh.faces.map(f => fromPart ? {v: f.v.slice().reverse(), c: f.c ?? 0, ink} : {v: f.v.slice().reverse(), c: color}),
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
  const thickness = Number(o.thickness), darken = Number(o.darken);
  const color = Number.isInteger(o.color) && o.color >= 0 && o.color < paletteSize ? o.color : Math.min(OUTLINE_DEFAULTS.color, paletteSize - 1);
  return {thickness: Number.isFinite(thickness) ? Math.max(.001, Math.min(OUTLINE_MAX, thickness)) : OUTLINE_DEFAULTS.thickness, color,
    fromPart: o.fromPart === true, darken: Number.isFinite(darken) ? Math.max(0, Math.min(1, darken)) : OUTLINE_DEFAULTS.darken};
}

/** Distance between two points (for tests and the UI). */
export const distance = (a, b) => Math.hypot(...sub(a, b));
