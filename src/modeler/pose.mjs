/** 3D Nowdz Pose mode (docs/BLENDER-LITE.md, "Pose mode"): turn bones and see
 * the model bend with them before it goes into an animation, as Blender's Pose
 * mode. A pose is a preview: it is never saved and never changes the bones' rest
 * positions or the model.
 *
 * A pose is a Map from bone id to a rotation (a quaternion [x, y, z, w]) about the
 * bone's own start, in the rest skeleton's frame. Each bone turns about its start
 * and carries the bones below it, as a figure's joints do on the stage.
 * poseFrames(model, pose) works out where every bone has gone; posedPoint and
 * posedMesh move points by their skin weights (linear blend skinning, as the stage). */

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const IDENTITY = Object.freeze([0, 0, 0, 1]);
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const normalizeQ = q => { const l = Math.hypot(...q) || 1; return q.map(v => v / l); };
/** A rotation of `angle` radians about a unit `axis`. */
export const axisAngle = (axis, angle) => { const l = Math.hypot(...axis) || 1, s = Math.sin(angle / 2) / l; return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
export function rotate(q, v) {
  const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** Where each bone has gone: {turn: total rotation, head: rest start, at: posed start}.
 * A point p carried by bone b goes to at + rotate(turn, p − head). */
export function poseFrames(model, pose) {
  const byId = new Map(model.bones.map(b => [b.id, b])), frames = new Map();
  const frameOf = (b, seen = new Set()) => {
    if (frames.has(b.id)) return frames.get(b.id);
    const parent = !seen.has(b.id) && byId.get(b.parent);
    seen.add(b.id);
    const up = parent ? frameOf(parent, seen) : null, own = pose.get(b.id) ?? IDENTITY;
    // The start rides on the parent; the turn is the parent's turn then this bone's own.
    const at = up ? carry(up, b.head) : b.head.slice(), turn = up ? normalizeQ(qmul(up.turn, own)) : own.slice();
    const frame = {turn, head: b.head, at};
    frames.set(b.id, frame);
    return frame;
  };
  for (const b of model.bones) frameOf(b);
  return frames;
}
const carry = (frame, p) => { const r = rotate(frame.turn, [p[0] - frame.head[0], p[1] - frame.head[1], p[2] - frame.head[2]]); return [frame.at[0] + r[0], frame.at[1] + r[1], frame.at[2] + r[2]]; };

/** A point moved by one bone. */
export const posedBy = (frames, bone, p) => frames.has(bone) ? carry(frames.get(bone), p) : p.slice();

/** A point moved by its weights ({bones, weights} four per point, as partWeights gives). */
export function posedPoint(frames, skin, v, p) {
  let x = 0, y = 0, z = 0, total = 0;
  for (let k = 0; k < 4; k++) {
    const b = skin.bones[v * 4 + k], w = skin.weights[v * 4 + k];
    if (!b || !(w > 0) || !frames.has(b)) continue;
    const q = carry(frames.get(b), p); x += q[0] * w; y += q[1] * w; z += q[2] * w; total += w;
  }
  if (total <= 0) return p.slice();
  // Weights add up to 1; any shortfall stays where it was.
  return [x + p[0] * (1 - total), y + p[1] * (1 - total), z + p[2] * (1 - total)];
}

/** A mesh with every point moved by its weights (faces and point data shared). */
export const posedMesh = (mesh, skin, frames) => ({...mesh, verts: mesh.verts.map((p, v) => posedPoint(frames, skin, v, p))});

/** The pose with `bone` turned by `delta` (a rotation in the scene's frame, about its posed start). */
export function turnBone(model, pose, bone, delta, from = pose) {
  const b = model.bones.find(x => x.id === bone); if (!b) return pose;
  const frames = poseFrames(model, from), parent = frames.get(b.parent);
  const up = parent ? parent.turn : IDENTITY, own = from.get(bone) ?? IDENTITY;
  // In the rest frame: own' = up⁻¹ · delta · up · own.
  const next = new Map(pose);
  next.set(bone, normalizeQ(qmul(qmul(qmul(conj(up), delta), up), own)));
  return next;
}

/** Whether any bone is turned. */
export const isPosed = pose => [...pose.values()].some(q => Math.abs(q[3]) < 1 - 1e-9);
