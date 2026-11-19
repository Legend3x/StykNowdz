/** 3D Nowdz face sets (docs/BLENDER-LITE.md, "Face sets"): a face made of swap
 * sets, as a 2D puppet's replaceable mouths and eyes. `starterFace` adds a
 * Mouth set (Closed, Open, A, O, Smile) and an Eyes set (Open, Closed, Happy)
 * shaped to the model's face and pressed onto it; `stickToFace` presses parts
 * onto the face as they are seen, sitting just in front of the skin. */
import {shrinkwrapPoints, sub, objectMatrix, objectTransform} from './mesh.mjs';
import {invert, transformPoint} from './matrix.mjs';
import {assertValidMesh} from './topology.mjs';
import {evaluatePart, addPart} from './model.mjs';
import {headBone} from './armature.mjs';
import {addFolder, makeSwapSet, swapChoiceOf, showChoice, choiceKey} from './layers.mjs';

/** The palette index of a colour, adding it when nothing close is there. */
export function paletteIndex(model, rgb, near = 18) {
  let best = -1, d = Infinity;
  model.palette.forEach((c, i) => { const e = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]); if (e < d) { d = e; best = i; } });
  if (best >= 0 && d <= near) return best;
  model.palette.push(rgb.slice());
  return model.palette.length - 1;
}

/** The part that is the face: one named Head or Face (not hair), the one holding the head
 * bone's middle when there are several. Hair and hats in front of the forehead are not it. */
export function facePart(model) {
  const named = model.parts.filter(p => p.visible !== false && p.mesh.faces.length && !swapChoiceOf(model, p) && /\b(head|face)\b/i.test(p.name) && !/hair|hat|cap/i.test(p.name));
  if (named.length < 2) return named[0] ?? null;
  const head = headBone(model), mid = head ? head.head.map((v, k) => (v + head.tail[k]) / 2) : null;
  const inside = p => { const v = evaluatePart(p, {smooth: false}).verts; return [0, 1, 2].every(k => mid[k] >= Math.min(...v.map(q => q[k])) - 1e-6 && mid[k] <= Math.max(...v.map(q => q[k])) + 1e-6); };
  return (mid && named.find(inside)) ?? named[0];
}
/** The surfaces a face set sits on: the face part, else every visible part with faces not in a swap set. */
export function faceSurfaces(model) {
  const face = facePart(model);
  return face ? [evaluatePart(face)] : model.parts.filter(p => p.visible !== false && p.mesh.faces.length && !swapChoiceOf(model, p)).map(p => evaluatePart(p));
}

/** Where the face is: the head's middle (xc), bottom (y0) and height (H), its half width,
 * and the front of the face. From the head bone, else from the whole model (a head on its own). */
export function faceFrame(model, surfaces = faceSurfaces(model)) {
  const all = surfaces.flatMap(m => m.verts), head = headBone(model);
  if (!all.length) return null;
  const box = k => [Math.min(...all.map(p => p[k])), Math.max(...all.map(p => p[k]))];
  let xc, y0, H;
  // A face part gives the face's own bounds (the skull, not the hair on it).
  if (facePart(model)) { const [x0, x1] = box(0), [b0, b1] = box(1); xc = Math.abs(x0 + x1) < (x1 - x0) * .05 ? 0 : (x0 + x1) / 2; y0 = b0; H = Math.max(1e-3, b1 - b0); }
  else if (head) {
    const lo = head.head[1] <= head.tail[1] ? head.head : head.tail, hi = lo === head.head ? head.tail : head.head;
    xc = (head.head[0] + head.tail[0]) / 2; y0 = lo[1]; H = Math.max(1e-3, hi[1] - lo[1]);
    // The head reaches past its bone (hair, the crown): take the model's points above its bottom.
    const near = all.filter(p => p[1] >= y0 - H * .05 && p[1] <= hi[1] + H * .3 && Math.abs(p[0] - xc) <= H * .9);
    if (near.length) H = Math.max(1e-3, Math.max(hi[1], ...near.map(p => p[1])) - y0);
  } else { const [x0, x1] = box(0), [b0, b1] = box(1); xc = (x0 + x1) / 2; y0 = b0; H = Math.max(1e-3, b1 - b0); }
  const band = all.filter(p => p[1] >= y0 + H * .25 && p[1] <= y0 + H * .65 && Math.abs(p[0] - xc) <= H * .9);
  const xHalf = band.length ? Math.max(H * .15, ...band.map(p => Math.abs(p[0] - xc))) : H * .35;
  const zFront = band.length ? Math.max(...band.map(p => p[2])) : Math.max(...all.map(p => p[2]));
  return {xc, y0, H, xHalf, zFront, head};
}

// ---------- Flat shapes, in the face's plane (x, y), wound to face the front ----------
const ring = (cx, cy, rx, ry, n = 16, squash = null) => Array.from({length: n}, (_, i) => {
  const a = i / n * Math.PI * 2, s = Math.sin(a);
  return [cx + Math.cos(a) * rx, cy + s * ry * (squash && s > 0 ? squash : 1)];
});
/** A band along a centre line (a closed mouth, a closed eye): quads between its two edges. */
function band(points, thickness) {
  const top = [], bottom = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    // Thinner toward the ends, like a brush stroke.
    const t = thickness / 2 * (.35 + .65 * Math.sin(Math.PI * i / (points.length - 1)));
    top.push([p[0] - dy / l * t, p[1] + dx / l * t]); bottom.push([p[0] + dy / l * t, p[1] - dx / l * t]);
  });
  return {verts: [...bottom, ...top], faces: points.slice(0, -1).map((_, i) => [i, i + 1, points.length + i + 1, points.length + i])};
}
const curve = (x0, x1, y, bend, n = 12) => Array.from({length: n}, (_, i) => { const u = i / (n - 1), x = x0 + (x1 - x0) * u; return [x, y + bend * (1 - (2 * u - 1) ** 2)]; });
/** A filled shape as rings around its middle, so its inside is pressed onto a curved face as well as its edge. */
function polygon(points, rings = 3) {
  const n = points.length, mid = [points.reduce((t, p) => t + p[0], 0) / n, points.reduce((t, p) => t + p[1], 0) / n];
  const verts = [mid], faces = [];
  for (let r = 1; r <= rings; r++) for (const p of points) verts.push([mid[0] + (p[0] - mid[0]) * r / rings, mid[1] + (p[1] - mid[1]) * r / rings]);
  const at = (r, i) => 1 + (r - 1) * n + (i % n);
  for (let i = 0; i < n; i++) faces.push([0, at(1, i), at(1, i + 1)]);
  for (let r = 1; r < rings; r++) for (let i = 0; i < n; i++) faces.push([at(r, i), at(r + 1, i), at(r + 1, i + 1), at(r, i + 1)]);
  return {verts, faces};
}
const join = (...shapes) => { const verts = [], faces = []; for (const s of shapes) { const base = verts.length; verts.push(...s.verts); faces.push(...s.faces.map(f => f.map(v => v + base))); } return {verts, faces}; };

/** A flat shape pressed onto the face from the front, `lift` in front of the skin, as a part's mesh. */
function pressed(shape, colors, f, surfaces, lift) {
  const z = f.zFront + f.H;
  const flat = shape.verts.map(([x, y]) => [x, y, f.zFront]);
  const onto = surfaces.length ? shrinkwrapPoints(flat, surfaces, lift, {ray: p => ({origin: [p[0], p[1], z], direction: [0, 0, -1]})}) : flat;
  return {verts: onto, faces: shape.faces.map((v, i) => ({v, c: colors[i] ?? colors[0]}))};
}
/** Join pressed pieces into one part's mesh, placed at its middle (so it moves and scales about itself). */
function partFrom(meshes) {
  const verts = meshes.flatMap(m => m.verts), faces = [];
  let base = 0;
  for (const m of meshes) { faces.push(...m.faces.map(fc => ({v: fc.v.map(v => v + base), c: fc.c}))); base += m.verts.length; }
  const mid = [0, 1, 2].map(k => (Math.min(...verts.map(p => p[k])) + Math.max(...verts.map(p => p[k]))) / 2);
  const round = v => Math.round(v * 1e5) / 1e5, mesh = {verts: verts.map(p => sub(p, mid).map(round)), faces};
  assertValidMesh(mesh, 'Starter face');
  return {mesh, position: mid.map(round)};
}

/** The model's own eyes, mouth or brows (a part named Eye/Eyes, Mouth, Brow/Brows not in a swap set). */
const ownPart = (model, pattern) => model.parts.find(p => pattern.test(p.name.trim()) && p.mesh.faces.length && !swapChoiceOf(model, p)) ?? null;
/** Where a part's two sides sit (its points left and right of the middle): [{x, y, rx, ry}] left, right. */
function sidesOf(part, xc) {
  const v = evaluatePart(part).verts, out = [];
  for (const side of [-1, 1]) {
    const pts = v.filter(p => (p[0] - xc) * side > 1e-4); if (!pts.length) return null;
    const lo = [0, 1].map(k => Math.min(...pts.map(p => p[k]))), hi = [0, 1].map(k => Math.max(...pts.map(p => p[k])));
    out.push({x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, rx: (hi[0] - lo[0]) / 2, ry: (hi[1] - lo[1]) / 2});
  }
  return out;
}
/** A copy of a part with each side turned about its own middle (brows: angry, worried). A Mirror part's
 * own side is turned and the mirror follows, so both sides turn the opposite ways, as faces do. */
function turnedCopy(model, part, angle, drop) {
  // Turned as seen from the front (in the world, where Mirror reflects), then back into the part's own space.
  const world = part.mesh.verts.map(objectTransform(part)), back = invert(objectMatrix(part));
  const mid = [0, 1].map(k => (Math.min(...world.map(p => p[k])) + Math.max(...world.map(p => p[k]))) / 2);
  const side = Math.sign(mid[0]) || 1, c = Math.cos(angle * side), s = Math.sin(angle * side);
  const mesh = structuredClone(part.mesh);
  mesh.verts = world.map(p => [...transformPoint(back, [mid[0] + (p[0] - mid[0]) * c - (p[1] - mid[1]) * s, mid[1] + (p[0] - mid[0]) * s + (p[1] - mid[1]) * c + drop, p[2]])].map(v => Math.round(v * 1e5) / 1e5));
  const copy = addPart(model, {name: part.name, mesh, position: part.position, rotation: part.rotation, scale: part.scale, mirror: part.mirror, smooth: part.smooth});
  for (const key of ['shadows', 'outline']) if (part[key] !== undefined) copy[key] = structuredClone(part[key]);
  if (part.mirrorU) copy.mirrorU = true;
  return copy;
}

/** Add a starter face: a Mouth swap set (Closed, Open, A, O, Smile) and an Eyes swap
 * set (Open, Closed, Happy), shaped to the face and pressed onto it, attached to the
 * head. With `adopt`, the model's own eyes and mouth become the sets' Open and Closed
 * and the others are made where they are; `brows` adds a Brows set (Normal, Angry,
 * Worried) from the model's own brows. Returns the folders, or null when the model
 * has nothing to put a face on. */
export function starterFace(model, {mouth = true, eyes = true, brows = false, adopt = false} = {}) {
  const surfaces = faceSurfaces(model), f = faceFrame(model, surfaces);
  if (!f) return null;
  const {xc, y0, H, xHalf} = f, lift = H * .006, out = {};
  const ink = paletteIndex(model, [46, 30, 34]), inside = paletteIndex(model, [128, 40, 50]), white = paletteIndex(model, [246, 246, 246]), iris = paletteIndex(model, [52, 46, 78]);
  const make = (folder, name, pieces) => {
    const {mesh, position} = partFrom(pieces), part = addPart(model, {name, mesh, position});
    part.folder = folder.id; part.shadows = false;
    return part;
  };
  /** The model's own part as a set's first choice: in the folder, renamed, riding the set's bone. */
  const adopted = (folder, own, name) => { own.folder = folder.id; own.name = name; delete own.bone; return own; };
  const bone = f.head?.id ?? 0;
  if (mouth) {
    const own = adopt ? ownPart(model, /^mouth$/i) : null, set = addFolder(model, {name: 'Mouth'});
    const at = own ? evaluatePart(own).verts : null;
    const my = at ? (Math.min(...at.map(p => p[1])) + Math.max(...at.map(p => p[1]))) / 2 : y0 + H * .22, mw = xHalf * .3, mh = H * .035;
    if (own) adopted(set, own, 'Closed');
    else make(set, 'Closed', [pressed(band(curve(xc - mw * .5, xc + mw * .5, my, -mh * .35), mh * .4), [ink], f, surfaces, lift)]);
    make(set, 'Open', [pressed(polygon(ring(xc, my - mh * .2, mw * .3, mh * 1.1)), [inside], f, surfaces, lift)]);
    make(set, 'A', [pressed(polygon(ring(xc, my - mh * .4, mw * .36, mh * 1.9, 18, .55)), [inside], f, surfaces, lift)]);
    make(set, 'O', [pressed(polygon(ring(xc, my - mh * .2, mw * .17, mw * .21)), [inside], f, surfaces, lift)]);
    // A wide half moon: flat along the top, round below.
    const smile = [...Array.from({length: 13}, (_, i) => { const a = Math.PI + i / 12 * Math.PI; return [xc + Math.cos(a) * mw * .48, my + mh * .3 + Math.sin(a) * mh * 1.6]; }),
      ...Array.from({length: 5}, (_, i) => [xc + mw * .48 - (i + 1) / 6 * mw * .96, my + mh * .3])];
    make(set, 'Smile', [pressed(polygon(smile), [inside], f, surfaces, lift)]);
    makeSwapSet(model, set.id, {bone}); out.mouth = set;
  }
  if (eyes) {
    const own = adopt ? ownPart(model, /^eyes?$/i) : null, set = addFolder(model, {name: 'Eyes'});
    const sides = own ? sidesOf(own, xc) : null, ey = y0 + H * .45, ex = xHalf * .42;
    const at = sides ?? [-1, 1].map(s => ({x: xc + s * ex, y: ey, rx: xHalf * .15, ry: H * .075}));
    const both = build => at.flatMap((e, i) => build(e, i ? 1 : -1));
    if (own) adopted(set, own, 'Open');
    else make(set, 'Open', both((e, s) => [
      pressed(polygon(ring(e.x, e.y, e.rx, e.ry)), [white], f, surfaces, lift),
      pressed(polygon(ring(e.x - s * e.rx * .12, e.y - e.ry * .08, e.rx * .62, e.ry * .8)), [iris], f, surfaces, lift * 2.2)]));
    make(set, 'Closed', both(e => [pressed(band(curve(e.x - e.rx, e.x + e.rx, e.y - e.ry * .1, -e.ry * .35), H * .014), [ink], f, surfaces, lift)]));
    make(set, 'Happy', both(e => [pressed(band(curve(e.x - e.rx, e.x + e.rx, e.y - e.ry * .3, e.ry * .55), H * .016), [ink], f, surfaces, lift)]));
    makeSwapSet(model, set.id, {bone}); out.eyes = set;
  }
  const ownBrows = brows ? ownPart(model, /^brows?$/i) : null;
  if (ownBrows) {
    const set = addFolder(model, {name: 'Brows'});
    // Angry: the inner ends down; worried: the inner ends up (turned about each brow's middle).
    const angry = turnedCopy(model, ownBrows, .32, -H * .012), worried = turnedCopy(model, ownBrows, -.26, H * .01);
    adopted(set, ownBrows, 'Normal'); angry.name = 'Angry'; worried.name = 'Worried';
    for (const q of [angry, worried]) { q.folder = set.id; delete q.bone; }
    makeSwapSet(model, set.id, {bone}); out.brows = set;
  }
  return out;
}

/** Press parts onto the face as they are seen: each point moves along `ray(point)`
 * to the first surface it meets (a part not in a swap set, not these parts),
 * `lift` in front of it, so a mouth drawn in Front view lands where it is seen.
 * Points whose ray misses stay put. Returns how many points moved. */
export function stickToFace(model, parts, ray, lift) {
  const ids = new Set(parts.map(p => p.id));
  const surfaces = model.parts.filter(p => !ids.has(p.id) && p.visible !== false && p.mesh.faces.length && !swapChoiceOf(model, p)).map(p => evaluatePart(p));
  let moved = 0;
  for (const part of parts) {
    const to = objectTransform(part), back = invert(objectMatrix(part)), world = part.mesh.verts.map(to);
    const onto = shrinkwrapPoints(world, surfaces, lift, {ray});
    const mesh = {...part.mesh, verts: onto.map(p => [...transformPoint(back, p)])};
    assertValidMesh(mesh, 'Stick to face');
    moved += onto.filter((p, i) => Math.hypot(...sub(p, world[i])) > 1e-9).length;
    part.mesh = mesh;
  }
  return moved;
}
export {choiceKey, showChoice};
