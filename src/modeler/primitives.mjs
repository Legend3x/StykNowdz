/** 3D Nowdz primitives, all centred on the origin, Y up, faces wound
 * counter-clockwise from outside. Sizes are in model units (1 unit = 100 px
 * when added to an animation). */
import {recalculateNormals} from './mesh.mjs';

const finish = (verts, faces, color = 0) => {
  const mesh = {verts, faces: faces.map(v => ({v, c: color}))};
  recalculateNormals(mesh);
  return mesh;
};

export function cube(size = 1, color = 0) {
  const h = size / 2, verts = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  return finish(verts, [[4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3], [5, 1, 2, 6], [7, 6, 2, 3], [0, 1, 5, 4]], color);
}

export function plane(size = 1, color = 0) {
  const h = size / 2;
  return {verts: [[-h, 0, h], [h, 0, h], [h, 0, -h], [-h, 0, -h]], faces: [{v: [0, 1, 2, 3], c: color}]};
}

/** A flat disc facing the front (+Z): one many-sided face. Inset it for eye
 * rings (iris, pupil, highlight), as anime eyes are built. */
export function circle(radius = .5, segments = 16, color = 0) {
  const verts = Array.from({length: segments}, (_, i) => { const a = i / segments * Math.PI * 2; return [Math.cos(a) * radius, Math.sin(a) * radius, 0]; });
  return {verts, faces: [{v: verts.map((_, i) => i), c: color}]};
}

/** Rings of points around Y: `profile` is [[radius, y], ...] from bottom to top. Ends close with a pole or a cap. */
export function lathe(profile, segments = 12, color = 0, {cap = true} = {}) {
  const verts = [], faces = [], rings = [];
  for (const [r, y] of profile) {
    if (r <= 1e-9) { verts.push([0, y, 0]); rings.push(verts.length - 1); continue; }
    const ring = [];
    for (let i = 0; i < segments; i++) { const a = i / segments * Math.PI * 2; ring.push(verts.length); verts.push([Math.sin(a) * r, y, Math.cos(a) * r]); }
    rings.push(ring);
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    const a = rings[k], b = rings[k + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      if (Array.isArray(a) && Array.isArray(b)) faces.push([a[i], a[j], b[j], b[i]]);
      else if (Array.isArray(b)) faces.push([a, b[j], b[i]]);
      else if (Array.isArray(a)) faces.push([a[i], a[j], b]);
    }
  }
  if (cap) {
    if (Array.isArray(rings[0])) faces.push(rings[0].slice().reverse());
    if (Array.isArray(rings.at(-1))) faces.push(rings.at(-1).slice());
  }
  return finish(verts, faces, color);
}

export function uvSphere(radius = .5, segments = 16, rings = 8, color = 0) {
  const profile = [];
  for (let k = 0; k <= rings; k++) { const a = -Math.PI / 2 + k / rings * Math.PI; profile.push([Math.cos(a) * radius, Math.sin(a) * radius]); }
  profile[0][0] = 0; profile[rings][0] = 0;
  return lathe(profile, segments, color);
}

export function cylinder(radius = .5, depth = 1, segments = 12, color = 0, {rings = 1} = {}) {
  const profile = [];
  for (let k = 0; k <= rings; k++) profile.push([radius, -depth / 2 + depth * k / rings]);
  return lathe(profile, segments, color);
}

export const cone = (radius = .5, depth = 1, segments = 12, color = 0) => lathe([[radius, -depth / 2], [0, depth / 2]], segments, color);

/** A cylinder with rounded ends: good for arms, legs and fingers. */
export function capsule(radius = .25, depth = 1, segments = 12, color = 0, {rings = 3} = {}) {
  const profile = [], half = Math.max(0, depth / 2 - radius);
  for (let k = 0; k <= rings; k++) { const a = -Math.PI / 2 + k / rings * Math.PI / 2; profile.push([Math.cos(a) * radius, -half + Math.sin(a) * radius]); }
  for (let k = 0; k <= rings; k++) { const a = k / rings * Math.PI / 2; profile.push([Math.cos(a) * radius, half + Math.sin(a) * radius]); }
  profile[0][0] = 0; profile.at(-1)[0] = 0;
  return lathe(profile, segments, color);
}

export function torus(major = .4, minor = .12, segments = 16, sides = 8, color = 0) {
  const verts = [], faces = [];
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const b = j / sides * Math.PI * 2, r = major + Math.cos(b) * minor;
      verts.push([Math.sin(a) * r, Math.sin(b) * minor, Math.cos(a) * r]);
    }
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < sides; j++) {
    const i2 = (i + 1) % segments, j2 = (j + 1) % sides;
    faces.push([i * sides + j, i2 * sides + j, i2 * sides + j2, i * sides + j2]);
  }
  return finish(verts, faces, color);
}

export const PRIMITIVES = {
  cube: () => cube(1),
  plane: () => plane(1),
  circle: () => circle(.5, 16),
  // One point, to trace a shape from (Blender's "extrude a single vertex").
  point: () => ({verts: [[0, 0, 0]], faces: [], loose: [0]}),
  sphere: () => uvSphere(.5, 16, 8),
  cylinder: () => cylinder(.5, 1, 12),
  cone: () => cone(.5, 1, 12),
  capsule: () => capsule(.25, 1, 12),
  torus: () => torus(.4, .12, 16, 8),
};

/** A low-poly starter character, about 2 units tall with its feet on Y = 0.
 * One half per limb with the mirror modifier on, so editing one side edits both.
 * Colors index the default palette: 0 skin, 1 shirt, 2 trousers, 3 shoes, 4 hair. */
export function baseCharacter() {
  const part = (name, mesh, position, {rotation = [0, 0, 0], scale = [1, 1, 1], mirror = false} = {}) =>
    ({name, mesh, position, rotation, scale, mirror, smooth: 1, visible: true});
  return [
    part('Head', uvSphere(.17, 12, 8, 0), [0, 1.73, 0], {scale: [1, 1.12, 1.02]}),
    part('Hair', uvSphere(.18, 12, 6, 4), [0, 1.8, -.025], {scale: [1.08, .92, 1.1]}),
    part('Neck', cylinder(.06, .12, 8, 0), [0, 1.53, 0]),
    part('Torso', capsule(.2, .62, 12, 1), [0, 1.18, 0], {scale: [1.15, 1, .7]}),
    part('Hips', capsule(.19, .32, 12, 2), [0, .88, 0], {scale: [1.1, 1, .72]}),
    part('Arm', capsule(.065, .55, 8, 1), [.33, 1.19, 0], {rotation: [0, 0, .12], mirror: true}),
    part('Forearm', capsule(.055, .5, 8, 0), [.38, .78, 0], {rotation: [0, 0, .04], mirror: true}),
    part('Hand', capsule(.05, .17, 8, 0), [.4, .5, 0], {scale: [1.2, 1, .7], mirror: true}),
    part('Thigh', capsule(.09, .5, 10, 2), [.11, .6, 0], {mirror: true}),
    part('Shin', capsule(.075, .48, 10, 2), [.11, .25, 0], {mirror: true}),
    part('Shoe', capsule(.07, .26, 8, 3), [.11, .04, .05], {rotation: [Math.PI / 2, 0, 0], scale: [1.1, 1, .8], mirror: true}),
  ];
}

export const DEFAULT_PALETTE = [[236, 188, 152], [64, 110, 196], [52, 56, 74], [40, 32, 30], [74, 52, 40], [220, 60, 60], [250, 210, 70], [90, 170, 90], [240, 240, 240], [30, 30, 34]];
