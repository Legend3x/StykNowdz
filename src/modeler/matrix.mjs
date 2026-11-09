/** Blender lite matrix math (docs/BLENDER-LITE.md, "Data integrity").
 *
 * Every vertex transformation in the modeler goes through these functions.
 * They are pure: each returns a new, frozen value and never reads or writes
 * anything but its arguments, so a transform can't change a mesh, a part or a
 * camera behind the caller's back.
 *
 * A matrix is 16 numbers, row-major, acting on column vectors: p' = M · p, so
 * multiply(A, B) applies B first, then A. Points are [x, y, z] (w = 1);
 * directions use w = 0. */

const freeze = values => Object.freeze(values);
const finite = (value, what) => { if (!Number.isFinite(value)) throw new TypeError(`Matrix math: ${what} must be a finite number.`); return value; };
const vec3 = (v, what = 'a point') => { if (!Array.isArray(v) || v.length !== 3) throw new TypeError(`Matrix math: ${what} must be [x, y, z].`); return v.map(x => finite(x, what)); };
const mat = (m, what = 'a matrix') => { if (!m || m.length !== 16) throw new TypeError(`Matrix math: ${what} must have 16 numbers.`); return m; };

export const IDENTITY = freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export const identity = () => IDENTITY;

export function translation(v) { const [x, y, z] = vec3(v, 'a translation'); return freeze([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]); }
export function scaling(v) { const [x, y, z] = vec3(v, 'a scale'); return freeze([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); }

/** Scale by `factor` along one direction only (I + (f − 1)·a·aᵀ). */
export function scalingAlong(axis, factor) {
  const [ax, ay, az] = vec3(axis, 'a scale axis'), len = Math.hypot(ax, ay, az);
  if (len < 1e-12) throw new RangeError('Matrix math: a scale axis cannot be zero.');
  const a = [ax / len, ay / len, az / len], k = finite(factor, 'a scale factor') - 1;
  return freeze([1 + k * a[0] * a[0], k * a[0] * a[1], k * a[0] * a[2], 0, k * a[1] * a[0], 1 + k * a[1] * a[1], k * a[1] * a[2], 0, k * a[2] * a[0], k * a[2] * a[1], 1 + k * a[2] * a[2], 0, 0, 0, 0, 1]);
}

/** Shear: points slide along `along` by `factor` times their distance along
 * `by` (I + f·along·byᵀ). Both directions are normalized; they should be
 * perpendicular, as Blender's shear tool uses the view's right and up. */
export function shearing(along, by, factor) {
  const [ax, ay, az] = vec3(along, 'a shear direction'), [bx, by_, bz] = vec3(by, 'a shear reference'), la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by_, bz);
  if (la < 1e-12 || lb < 1e-12) throw new RangeError('Matrix math: shear directions cannot be zero.');
  const a = [ax / la, ay / la, az / la], b = [bx / lb, by_ / lb, bz / lb], k = finite(factor, 'a shear factor');
  return freeze([1 + k * a[0] * b[0], k * a[0] * b[1], k * a[0] * b[2], 0, k * a[1] * b[0], 1 + k * a[1] * b[1], k * a[1] * b[2], 0, k * a[2] * b[0], k * a[2] * b[1], 1 + k * a[2] * b[2], 0, 0, 0, 0, 1]);
}

/** Rotation by `angle` radians about a unit-normalized `axis` (right-handed). */
export function rotationAxis(axis, angle) {
  const [ax, ay, az] = vec3(axis, 'a rotation axis'), len = Math.hypot(ax, ay, az);
  if (len < 1e-12) throw new RangeError('Matrix math: a rotation axis cannot be zero.');
  const x = ax / len, y = ay / len, z = az / len, c = Math.cos(finite(angle, 'an angle')), s = Math.sin(angle), C = 1 - c;
  return freeze([c + x * x * C, x * y * C - z * s, x * z * C + y * s, 0, y * x * C + z * s, c + y * y * C, y * z * C - x * s, 0, z * x * C - y * s, z * y * C + x * s, c + z * z * C, 0, 0, 0, 0, 1]);
}

/** Euler XYZ (radians) as R = Rz · Ry · Rx, the rotation order parts use. */
export function eulerXYZ(rotation) {
  const [rx, ry, rz] = vec3(rotation, 'a rotation');
  return multiply(rotationAxis([0, 0, 1], rz), multiply(rotationAxis([0, 1, 0], ry), rotationAxis([1, 0, 0], rx)));
}

/** A ∘ B: apply B, then A. */
export function multiply(a, b) {
  mat(a); mat(b);
  const out = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  return freeze(out);
}
/** compose(A, B, C) = A · B · C: C applies first. */
export const compose = (...matrices) => matrices.reduce((acc, m) => multiply(acc, m), IDENTITY);

/** The same transform performed about `pivot` instead of the origin. */
export const about = (pivot, m) => compose(translation(pivot), m, translation(vec3(pivot, 'a pivot').map(v => -v)));

/** Position, Euler rotation and per-axis scale of a part: T · R · S. */
export const fromTRS = (position, rotation, size) => compose(translation(position), eulerXYZ(rotation), scaling(size));

export function transformPoint(m, p) {
  mat(m); const [x, y, z] = vec3(p);
  const w = m[12] * x + m[13] * y + m[14] * z + m[15];
  if (Math.abs(w) < 1e-12) throw new RangeError('Matrix math: the point maps to infinity.');
  return freeze([(m[0] * x + m[1] * y + m[2] * z + m[3]) / w, (m[4] * x + m[5] * y + m[6] * z + m[7]) / w, (m[8] * x + m[9] * y + m[10] * z + m[11]) / w]);
}
export function transformDirection(m, v) {
  mat(m); const [x, y, z] = vec3(v, 'a direction');
  return freeze([m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z]);
}

/** Determinant of the 3×3 part: negative when the transform mirrors (and turns faces inside out). */
export function determinant3(m) {
  mat(m);
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Inverse of an affine matrix. Throws when the matrix flattens space (a zero scale). */
export function invert(m) {
  mat(m);
  if (Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]) > 1e-12 || Math.abs(m[15] - 1) > 1e-12) throw new RangeError('Matrix math: only affine matrices can be inverted.');
  const det = determinant3(m);
  if (Math.abs(det) < 1e-15) throw new RangeError('Matrix math: this transform flattens space and has no inverse.');
  const i = [
    (m[5] * m[10] - m[6] * m[9]) / det, (m[2] * m[9] - m[1] * m[10]) / det, (m[1] * m[6] - m[2] * m[5]) / det,
    (m[6] * m[8] - m[4] * m[10]) / det, (m[0] * m[10] - m[2] * m[8]) / det, (m[2] * m[4] - m[0] * m[6]) / det,
    (m[4] * m[9] - m[5] * m[8]) / det, (m[1] * m[8] - m[0] * m[9]) / det, (m[0] * m[5] - m[1] * m[4]) / det];
  const t = [m[3], m[7], m[11]];
  return freeze([i[0], i[1], i[2], -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]), i[3], i[4], i[5], -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6], i[7], i[8], -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]), 0, 0, 0, 1]);
}

/** Euler XYZ of a pure rotation matrix (the inverse of eulerXYZ). */
export function toEulerXYZ(m) {
  mat(m);
  const sy = Math.max(-1, Math.min(1, -m[8])), ry = Math.asin(sy);
  return freeze(Math.abs(sy) < .99999 ? [Math.atan2(m[9], m[10]), ry, Math.atan2(m[4], m[0])] : [Math.atan2(-m[6], m[5]), ry, 0]);
}

/** Split T · R · S back into position, Euler rotation and per-axis scale.
 * Throws when the matrix has shear, which a part's TRS can't hold. */
export function decomposeTRS(m) {
  mat(m);
  const column = c => [m[c], m[4 + c], m[8 + c]], size = [0, 1, 2].map(c => Math.hypot(...column(c)));
  if (size.some(s => s < 1e-12)) throw new RangeError('Matrix math: a part cannot have a zero size.');
  if (determinant3(m) < 0) size[0] = -size[0];
  const r = [0, 1, 2].map(c => column(c).map(v => v / size[c]));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (Math.abs(dot(r[0], r[1])) > 1e-6 || Math.abs(dot(r[0], r[2])) > 1e-6 || Math.abs(dot(r[1], r[2])) > 1e-6) throw new RangeError('Matrix math: this transform skews the part and cannot be kept as position, rotation and size.');
  const rotation = freeze([r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, 0, 0, 0, 1]);
  return freeze({position: freeze([m[3], m[7], m[11]]), rotation: toEulerXYZ(rotation), scale: freeze(size)});
}
