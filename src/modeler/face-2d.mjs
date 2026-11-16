/** 3D Nowdz's 2D face (docs/FACE-RIG.md): where a painted face goes on a head.
 *
 * `faceUnwrap` lays the head out for painting a face: what looks to the front
 * fills most of the texture as seen from the front (so drawings keep their
 * shape), the rest of the head packed in a strip beside it. `uvAtFront` finds
 * the texture point under a spot on the front of the head, and
 * `starterLayout` places a starter set of eyes, brows, a mouth and extras on
 * the face from those, sized to the head. Drawings come separately (they need a
 * canvas): see face-starter-art.mjs. */
import {unwrapParts} from './unwrap.mjs';

const FRONT = [0, .125, .75, .875], REST = [.77, 0, 1, 1]; // [u0, v0, u1, v1]

/** Fit the UVs of `faces` into a box, keeping their shape. */
function fitInto(mesh, faces, [u0, v0, u1, v1]) {
  const all = [...faces].flatMap(fi => mesh.faces[fi].uv ?? []);
  if (!all.length) return;
  const lo = [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1]))], hi = [Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))];
  const s = Math.min((u1 - u0) / Math.max(1e-9, hi[0] - lo[0]), (v1 - v0) / Math.max(1e-9, hi[1] - lo[1]));
  const off = [u0 + ((u1 - u0) - (hi[0] - lo[0]) * s) / 2, v0 + ((v1 - v0) - (hi[1] - lo[1]) * s) / 2];
  for (const fi of faces) { const f = mesh.faces[fi]; if (f.uv) f.uv = f.uv.map(([u, v]) => [off[0] + (u - lo[0]) * s, off[1] + (v - lo[1]) * s]); }
}
/** The normal's z of a face in world space (front is +z). */
function facing(points, f) {
  let nx = 0, ny = 0, nz = 0; const n = f.v.length;
  for (let i = 0; i < n; i++) { const a = points[f.v[i]], b = points[f.v[(i + 1) % n]]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
  return nz / (Math.hypot(nx, ny, nz) || 1);
}

/** Unwrap a head for a face: `target` is {mesh, faces, points} as the UV tools
 * use (points in world space). Faces turned towards the front (more than about
 * 25°) are projected from the front; the rest are smart-unwrapped beside them. */
export function faceUnwrap(target) {
  const front = new Set(), rest = new Set();
  for (const fi of target.faces) (facing(target.points, target.mesh.faces[fi]) > .42 ? front : rest).add(fi);
  if (!front.size) return false;
  unwrapParts('view', [{...target, faces: front}], {project: p => [p[0], -p[1]], margin: 0});
  fitInto(target.mesh, front, FRONT);
  if (rest.size) { unwrapParts('smart', [{...target, faces: rest}]); fitInto(target.mesh, rest, REST); }
  return true;
}

/** The texture point ([u, v]) under (x, y) on the front of `target`'s faces
 * that have UVs, with `textureId` when given; null when nothing is there. */
export function uvAtFront(target, x, y, textureId) {
  let best = null, bestZ = -Infinity;
  for (const fi of target.faces) {
    const f = target.mesh.faces[fi]; if (!f.uv || (textureId !== undefined && f.t !== textureId)) continue;
    if (facing(target.points, f) <= 0) continue;
    const P = f.v.map(i => target.points[i]);
    for (let k = 1; k + 1 < P.length; k++) {
      const a = P[0], b = P[k], c = P[k + 1];
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(d) < 1e-12) continue;
      const l0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d, l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const z = l0 * a[2] + l1 * b[2] + l2 * c[2]; if (z <= bestZ) continue;
      const ua = f.uv[0], ub = f.uv[k], uc = f.uv[k + 1];
      bestZ = z; best = [l0 * ua[0] + l1 * ub[0] + l2 * uc[0], l0 * ua[1] + l1 * ub[1] + l2 * uc[1]];
    }
  }
  return best;
}

/** Where a feature centred at (x, y), w × h in the model, lies on the texture:
 * {x, y, w, h} in UV units, or null when its middle misses the head. */
export function featureBox(target, frame, x, y, w, h, textureId) {
  const at = (px, py) => uvAtFront(target, px, py, textureId), mid = at(x, y);
  if (!mid) return null;
  const span = (p, q, whole) => { const a = at(...p), b = at(...q); return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) * whole : null; };
  // Measured across a short reach (curved heads), scaled to the feature's size.
  const rx = Math.min(w / 2, frame.xHalf * .2), ry = Math.min(h / 2, frame.H * .08);
  const uw = span([x - rx, y], [x + rx, y], w / (2 * rx)) ?? w, vh = span([x, y - ry], [x, y + ry], h / (2 * ry)) ?? h;
  return {x: mid[0], y: mid[1], w: uw, h: vh};
}

/** The starter features' places on a face (from 3D Nowdz's faceFrame): in the
 * model's units, centred on the face, the viewer's left first. */
export function starterPlaces(frame) {
  const {xc, y0, H, xHalf} = frame, eyeY = y0 + H * .5, eyeX = xHalf * .4;
  return [
    {id: 'eyeL', kind: 'eye', x: xc - eyeX, y: eyeY, w: xHalf * .46, h: xHalf * .34},
    {id: 'eyeR', kind: 'eye', x: xc + eyeX, y: eyeY, w: xHalf * .46, h: xHalf * .34, mirrorOf: 'eyeL'},
    {id: 'browL', kind: 'brow', x: xc - eyeX, y: eyeY + H * .105, w: xHalf * .5, h: xHalf * .16},
    {id: 'browR', kind: 'brow', x: xc + eyeX, y: eyeY + H * .105, w: xHalf * .5, h: xHalf * .16, mirrorOf: 'browL'},
    {id: 'mouth', kind: 'mouth', x: xc, y: y0 + H * .25, w: xHalf * .7, h: xHalf * .42},
    {id: 'blush', kind: 'extra', x: xc, y: eyeY - H * .13, w: xHalf * 1.5, h: xHalf * .26},
    {id: 'sweat', kind: 'extra', x: xc + xHalf * .72, y: y0 + H * .7, w: xHalf * .2, h: xHalf * .3},
  ];
}

/** A face for `target` (the head, unwrapped onto `textureId`): the starter
 * places measured onto its texture. `names` maps ids to display names; drawings
 * are added by the caller. Features whose middle misses the head are left out. */
export function starterLayout(target, frame, textureId, names = {}) {
  const features = [];
  for (const p of starterPlaces(frame)) {
    const box = featureBox(target, frame, p.x, p.y, p.w, p.h, textureId);
    if (!box) continue;
    if (p.mirrorOf && !features.some(f => f.id === p.mirrorOf)) delete p.mirrorOf;
    features.push({id: p.id, kind: p.kind, name: names[p.id] ?? p.id, ...box, angle: 0, states: [], ...(p.mirrorOf ? {mirrorOf: p.mirrorOf} : {})});
  }
  return {texture: textureId, features};
}
