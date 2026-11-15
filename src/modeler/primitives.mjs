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

/** How a cap or a circle is filled, as Blender's Fill Type: one many-sided face
 * (N-gon), triangles from a middle point (Triangle fan), or left open (Nothing). */
export const FILL_TYPES = Object.freeze(['ngon', 'fan', 'none']);
const fillOf = cap => cap === false || cap === 'none' ? 'none' : cap === 'fan' ? 'fan' : 'ngon';

/** A flat disc facing the front (+Z), filled as `fill` says (one many-sided face by
 * default). Inset it for eye rings (iris, pupil, highlight), as anime eyes are built. */
export function circle(radius = .5, segments = 16, color = 0, {fill = 'ngon'} = {}) {
  const verts = Array.from({length: segments}, (_, i) => { const a = i / segments * Math.PI * 2; return [Math.cos(a) * radius, Math.sin(a) * radius, 0]; });
  const ring = verts.map((_, i) => i);
  if (fillOf(fill) === 'none') return {verts, faces: [], edges: ring.map(i => [i, (i + 1) % segments])};
  if (fillOf(fill) === 'fan') { verts.push([0, 0, 0]); return {verts, faces: ring.map(i => ({v: [segments, i, (i + 1) % segments], c: color}))}; }
  return {verts, faces: [{v: ring, c: color}]};
}

/** Rings of points around Y: `profile` is [[radius, y], ...] from bottom to top. Ends close
 * with a pole, or with a cap filled as `cap` says (true or 'ngon', 'fan', false or 'none'). */
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
  const fill = fillOf(cap);
  for (const [ring, bottom] of [[rings[0], true], [rings.at(-1), false]]) {
    if (!Array.isArray(ring) || fill === 'none') continue;
    if (fill === 'ngon') { faces.push(bottom ? ring.slice().reverse() : ring.slice()); continue; }
    // Triangle fan: a middle point, a triangle to each side.
    const y = verts[ring[0]][1], mid = verts.push([0, y, 0]) - 1;
    for (let i = 0; i < segments; i++) { const j = (i + 1) % segments; faces.push(bottom ? [mid, ring[j], ring[i]] : [mid, ring[i], ring[j]]); }
  }
  return finish(verts, faces, color);
}

export function uvSphere(radius = .5, segments = 16, rings = 8, color = 0) {
  const profile = [];
  for (let k = 0; k <= rings; k++) { const a = -Math.PI / 2 + k / rings * Math.PI; profile.push([Math.cos(a) * radius, Math.sin(a) * radius]); }
  profile[0][0] = 0; profile[rings][0] = 0;
  return lathe(profile, segments, color);
}

export function cylinder(radius = .5, depth = 1, segments = 12, color = 0, {rings = 1, cap = true} = {}) {
  const profile = [];
  for (let k = 0; k <= rings; k++) profile.push([radius, -depth / 2 + depth * k / rings]);
  return lathe(profile, segments, color, {cap});
}

export const cone = (radius = .5, depth = 1, segments = 12, color = 0, {cap = true} = {}) => lathe([[radius, -depth / 2], [0, depth / 2]], segments, color, {cap});

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

/** What each shape can be added with, as Blender's Add Mesh panel (Adjust Last
 * Operation): its settings with their defaults and limits, and how to build it.
 * Settings: [key, kind ('whole' | 'size' | 'fill'), default, min, max]. */
export const PRIMITIVE_SETTINGS = {
  cube: {settings: [['size', 'size', 1, .001, 1000]], build: o => cube(o.size)},
  plane: {settings: [['size', 'size', 1, .001, 1000]], build: o => plane(o.size)},
  circle: {settings: [['vertices', 'whole', 16, 3, 256], ['radius', 'size', .5, .001, 1000], ['fill', 'fill', 'ngon']], build: o => circle(o.radius, o.vertices, 0, {fill: o.fill})},
  sphere: {settings: [['segments', 'whole', 16, 3, 256], ['rings', 'whole', 8, 3, 128], ['radius', 'size', .5, .001, 1000]], build: o => uvSphere(o.radius, o.segments, o.rings)},
  cylinder: {settings: [['vertices', 'whole', 12, 3, 256], ['radius', 'size', .5, .001, 1000], ['depth', 'size', 1, .001, 1000], ['fill', 'fill', 'ngon']],
    build: o => cylinder(o.radius, o.depth, o.vertices, 0, {cap: o.fill})},
  cone: {settings: [['vertices', 'whole', 12, 3, 256], ['radius', 'size', .5, .001, 1000], ['depth', 'size', 1, .001, 1000], ['fill', 'fill', 'ngon']],
    build: o => cone(o.radius, o.depth, o.vertices, 0, {cap: o.fill})},
  capsule: {settings: [['segments', 'whole', 12, 3, 256], ['rings', 'whole', 3, 1, 64], ['radius', 'size', .25, .001, 1000], ['depth', 'size', 1, .001, 1000]],
    build: o => capsule(o.radius, Math.max(o.depth, o.radius * 2), o.segments, 0, {rings: o.rings})},
  torus: {settings: [['majorSegments', 'whole', 16, 3, 256], ['minorSegments', 'whole', 8, 3, 256], ['majorRadius', 'size', .4, .001, 1000], ['minorRadius', 'size', .12, .001, 1000]],
    build: o => torus(o.majorRadius, o.minorRadius, o.majorSegments, o.minorSegments)},
};
/** A shape's default settings. */
export const primitiveDefaults = kind => Object.fromEntries((PRIMITIVE_SETTINGS[kind]?.settings ?? []).map(([key, , value]) => [key, value]));
/** Settings brought into their limits (whole numbers where they must be, a known fill). */
export function primitiveSettings(kind, values = {}) {
  const out = primitiveDefaults(kind);
  for (const [key, type, , min, max] of PRIMITIVE_SETTINGS[kind]?.settings ?? []) {
    const v = values[key];
    if (type === 'fill') { if (FILL_TYPES.includes(v)) out[key] = v; continue; }
    if (!Number.isFinite(Number(v))) continue;
    const n = Math.max(min, Math.min(max, Number(v)));
    out[key] = type === 'whole' ? Math.round(n) : n;
  }
  return out;
}
export const PRIMITIVES = {
  ...Object.fromEntries(Object.entries(PRIMITIVE_SETTINGS).map(([kind, {build}]) => [kind, (values = {}) => build(primitiveSettings(kind, values))])),
  // One point, to trace a shape from (Blender's "extrude a single vertex").
  point: () => ({verts: [[0, 0, 0]], faces: [], loose: [0]}),
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
