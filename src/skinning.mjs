/** Skinning: how a point bound to several bones moves (docs/SPATIAL-MESHES.md, "Skinning").
 * One module for the stage (spatial-mesh.mjs, rig-spatial.mjs) and 3D Nowdz's Pose preview
 * (modeler/pose.mjs), so a model bends in the preview exactly as it will in the animation.
 *
 * A bone's pose is a rigid motion: rotate by the unit quaternion q, then move by t. Two ways to
 * blend several, as Blender's Armature modifier offers:
 * - 'dual-quaternion' (Blender's Preserve Volume; the default): the bones' motions are blended as
 *   dual quaternions, so a bent or twisted joint keeps its thickness instead of pinching.
 * - 'linear' (Blender's default): the point is moved by each bone and the results are averaged
 *   by weight. Bent joints pinch a little ("candy wrapper" when twisted).
 * Either way the weights are divided by their total, as Blender does, so weights that add up to
 * less (or more) than 1 still move the point all the way with its bones.
 *
 * The stage keeps its own packed loops for speed; they call the formulas here. */

export const SKINNING_METHODS = Object.freeze(['dual-quaternion', 'linear']);
export const DEFAULT_SKINNING = 'dual-quaternion';

/** The dual part of "rotate by q, then move by t": ½·(t, 0)·q. */
export function rigidDual(q, t) {
  const [tx, ty, tz] = t, [x, y, z, w] = q;
  return [(tx * w + ty * z - tz * y) * .5, (-tx * z + ty * w + tz * x) * .5, (tx * y - ty * x + tz * w) * .5, (-tx * x - ty * y - tz * z) * .5];
}

/** Move the point (a, b, c) by a blended dual quaternion (real x y z w, dual dx dy dz dw, any
 * length: normalising divides by the total weight). Writes out[at…at+2]; returns the normalised
 * real part's length factor so callers can also turn normals by (x, y, z, w) / norm. */
export function moveByDual(x, y, z, w, dx, dy, dz, dw, a, b, c, out, at = 0) {
  const norm = Math.hypot(x, y, z, w);
  x /= norm; y /= norm; z /= norm; w /= norm; dx /= norm; dy /= norm; dz /= norm; dw /= norm;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  out[at] = a + w * tx + y * tz - z * ty + 2 * (-dw * x + dx * w - dy * z + dz * y);
  out[at + 1] = b + w * ty + z * tx - x * tz + 2 * (-dw * y + dx * z + dy * w - dz * x);
  out[at + 2] = c + w * tz + x * ty - y * tx + 2 * (-dw * z - dx * y + dy * x + dz * w);
  return norm;
}

/** A point moved by one rigid motion {q, t}. */
export function moveRigid(f, p) {
  const [x, y, z, w] = f.q, [a, b, c] = p, tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty + f.t[0], b + w * ty + z * tx - x * tz + f.t[1], c + w * tz + x * ty - y * tx + f.t[2]];
}

/** A point p moved by its bones: `motions` [{q, t, dual?}, …] with `weights` alongside (each > 0).
 * One bone moves it rigidly; several are blended by `method` (SKINNING_METHODS). */
export function skinPoint(motions, weights, p, method = DEFAULT_SKINNING) {
  if (!motions.length) return p.slice();
  if (motions.length === 1) return moveRigid(motions[0], p);
  if (method === 'linear') {
    let x = 0, y = 0, z = 0, total = 0;
    motions.forEach((f, k) => { const q = moveRigid(f, p), w = weights[k]; x += q[0] * w; y += q[1] * w; z += q[2] * w; total += w; });
    return [x / total, y / total, z / total];
  }
  // Dual quaternions: each bone's rotation is taken on the same side as the first bone's
  // (q and −q are the same rotation), so the blend goes the short way round.
  const first = motions[0].q;
  let x = 0, y = 0, z = 0, w = 0, dx = 0, dy = 0, dz = 0, dw = 0;
  motions.forEach((f, k) => {
    const q = f.q, d = f.dual ?? rigidDual(f.q, f.t), weight = weights[k] * (q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3] < 0 ? -1 : 1);
    x += q[0] * weight; y += q[1] * weight; z += q[2] * weight; w += q[3] * weight; dx += d[0] * weight; dy += d[1] * weight; dz += d[2] * weight; dw += d[3] * weight;
  });
  const out = [0, 0, 0];
  moveByDual(x, y, z, w, dx, dy, dz, dw, p[0], p[1], p[2], out);
  return out;
}
