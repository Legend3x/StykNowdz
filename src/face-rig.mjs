/** The 2D face rig (docs/FACE-RIG.md): a painted face, rebuilt on a 3D model's
 * texture for every pose.
 *
 * A face belongs to one of the model's textures (the head's) and lists
 * features, each a rectangle on that texture (centre x, y and size w, h in UV
 * units, v up; angle in degrees) holding drawn states:
 *   eye:   each state has `under` (the eye white, which is also where the pupil
 *          may show) and `over` (lids and lashes); `pupil` is one drawing that
 *          slides inside the white, `range` far at most (fractions of w, h).
 *   brow:  states with `over`; raise and tilt move the drawing.
 *   mouth: states with `over` (named for lip-sync shapes in the starter set).
 *   extra: states with `over`; fades in and out (blush, sweat, tears).
 * A feature with `mirrorOf` shows another feature's drawings flipped, so a
 * right eye or brow follows the left one until it is drawn on its own.
 *
 * An animated object holds `_stykFace`: per feature {s: state index, x, y: look
 * (-1..1), r: raise (-1..1), a: tilt (-1..1), o: opacity (0..1)}. States hold
 * from key to key; the numbers tween. Missing values mean the feature's rest:
 * first state, looking ahead, level, shown (extras hidden).
 *
 * Each distinct set of values is one picture: `faceRecipe` describes it with a
 * key naming exactly that picture, and `composeFace` paints it on any 2D canvas
 * (the page's, a worker's OffscreenCanvas, 3D Nowdz's preview). */

export const FACE_KINDS = Object.freeze(['eye', 'brow', 'mouth', 'extra']);
export const FACE_FEATURES = 24, FACE_STATES = 24;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => Number.isFinite(v) ? v : d;
const image = v => typeof v === 'string' && DATA_URL.test(v) ? v : undefined;

/** A face as stored, cleaned: unknown kinds, broken images and dangling mirrors
 * dropped; numbers kept in range. Returns null when nothing usable is left. */
export function readFace(face, textureIds = null) {
  if (!face || typeof face !== 'object' || !Number.isInteger(face.texture)) return null;
  if (textureIds && !textureIds.has(face.texture)) return null;
  const features = [], ids = new Set();
  for (const f of Array.isArray(face.features) ? face.features : []) {
    if (features.length >= FACE_FEATURES || !f || !FACE_KINDS.includes(f.kind) || typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(f.id) || ids.has(f.id)) continue;
    const states = (Array.isArray(f.states) ? f.states : []).slice(0, FACE_STATES).map(s => {
      const out = {name: String(s?.name ?? '').slice(0, 40) || 'State'};
      const over = image(s?.over), under = image(s?.under);
      if (over) out.over = over; if (under && f.kind === 'eye') out.under = under;
      return out;
    });
    const out = {id: f.id, kind: f.kind, name: String(f.name ?? f.id).slice(0, 60),
      x: clamp(num(f.x, .5), -1, 2), y: clamp(num(f.y, .5), -1, 2), w: clamp(num(f.w, .1), .001, 2), h: clamp(num(f.h, .1), .001, 2), angle: clamp(num(f.angle, 0), -360, 360), states};
    if (typeof f.mirrorOf === 'string') out.mirrorOf = f.mirrorOf;
    if (f.kind === 'eye') {
      const pupil = image(f.pupil?.src);
      out.pupil = {...(pupil ? {src: pupil} : {}), size: clamp(num(f.pupil?.size, .45), .05, 1.5), range: [clamp(num(f.pupil?.range?.[0], .28), 0, 1), clamp(num(f.pupil?.range?.[1], .2), 0, 1)]};
    }
    ids.add(f.id); features.push(out);
  }
  // A mirror shows another feature of the same kind that is not itself a mirror.
  for (const f of features) if (f.mirrorOf !== undefined) {
    const source = features.find(g => g.id === f.mirrorOf);
    if (!source || source === f || source.kind !== f.kind || source.mirrorOf !== undefined) delete f.mirrorOf;
  }
  return features.length ? {texture: face.texture, features} : null;
}
/** The feature whose drawings a feature shows (itself, or the one it mirrors). */
export const drawingsOf = (face, f) => (f.mirrorOf !== undefined && face.features.find(g => g.id === f.mirrorOf)) || f;
export const statesOf = (face, f) => drawingsOf(face, f).states;

/** One feature's values with its rest filled in. */
export function featureValue(face, f, v = {}) {
  const n = Math.max(1, statesOf(face, f).length);
  return {s: clamp(Math.round(num(v?.s, 0)), 0, n - 1), x: clamp(num(v?.x, 0), -1, 1), y: clamp(num(v?.y, 0), -1, 1),
    r: clamp(num(v?.r, 0), -1, 1), a: clamp(num(v?.a, 0), -1, 1), o: clamp(num(v?.o, f.kind === 'extra' ? 0 : 1), 0, 1)};
}
/** Clean an object's stored values against a face: unknown features and fields go. */
export function readFaceValues(face, values) {
  if (!face || !values || typeof values !== 'object') return undefined;
  const out = {};
  for (const f of face.features) {
    const v = values[f.id]; if (!v || typeof v !== 'object') continue;
    // Rest values (all zero) are left out, so a face at rest stores nothing.
    const keep = {};
    for (const k of ['s', 'x', 'y', 'r', 'a', 'o']) {
      if (!Number.isFinite(v[k])) continue;
      const n = k === 's' ? Math.max(0, Math.round(v[k])) : k === 'o' ? Math.min(1, Math.max(0, v[k])) : Math.min(1, Math.max(-1, v[k]));
      if (n !== 0) keep[k] = n;
    }
    if (Object.keys(keep).length) out[f.id] = keep;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Between two keys: states hold until the next key, the numbers move with `t` (already eased). A missing value is rest (0). */
export function interpolateFace(a, b, t) {
  if (!b || t <= 0) return a;
  const out = {};
  for (const id of new Set([...Object.keys(a ?? {}), ...Object.keys(b)])) {
    const p = a?.[id] ?? {}, q = b[id] ?? {}, v = {};
    for (const k of ['x', 'y', 'r', 'a', 'o']) {
      if (p[k] === undefined && q[k] === undefined) continue;
      const f0 = p[k] ?? 0, f1 = q[k] ?? 0, n = f0 + (f1 - f0) * t;
      if (n !== 0) v[k] = n;
    }
    const s = t >= 1 ? q.s : p.s; if (s) v.s = s;
    if (Object.keys(v).length) out[id] = v;
  }
  return out;
}

/** The picture for a face, a base image (`base`: {src, width, height}) and an
 * object's values: what to draw and a key naming exactly that picture. */
export function faceRecipe(face, base, values) {
  const features = face.features.map(f => {
    const v = featureValue(face, f, values?.[f.id]), d = drawingsOf(face, f), state = d.states[v.s] ?? {};
    const flip = d !== f;
    return {kind: f.kind, x: f.x, y: f.y, w: f.w, h: f.h, angle: f.angle, flip, under: state.under, over: state.over,
      pupil: f.kind === 'eye' && d.pupil?.src ? {src: d.pupil.src, size: d.pupil.size, range: d.pupil.range} : null, v};
  });
  // Identity: the drawings in use (by position in the face) and the values, rounded finely enough to look smooth.
  const round = x => Math.round(x * 256);
  const key = `${faceId(face, base)}:${face.features.map((f, i) => { const r = features[i], v = r.v; return `${v.s}.${round(v.x)}.${round(v.y)}.${round(v.r)}.${round(v.a)}.${round(v.o)}`; }).join('|')}`;
  return {key, width: base.width, height: base.height, base: base.src, features};
}
/** A short identity of a face's drawings and placement (and its base image). */
const ids = new WeakMap();
export function faceId(face, base) {
  let id = ids.get(face);
  if (!id) {
    // FNV-1a over the definition with each image replaced by its length and ends: quick, and a changed drawing changes it.
    const brief = s => typeof s === 'string' ? `${s.length}:${s.slice(-48)}` : s;
    const text = JSON.stringify(face, (k, v) => typeof v === 'string' && v.startsWith('data:') ? brief(v) : v);
    let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    id = (h >>> 0).toString(36); ids.set(face, id);
  }
  return `${id}.${base.src.length.toString(36)}${base.src.slice(-24).replace(/[^A-Za-z0-9]/g, '')}`;
}
export const faceUrl = recipe => `stykface:${recipe.key}`;

/** Paint a recipe on `ctx` (a 2D context the size of the base image). `images`
 * maps each data URL used to a decoded image; `scratch(w, h)` gives a spare
 * 2D context for masking pupils. Draws whatever has decoded. */
export function composeFace(ctx, recipe, images, scratch) {
  const W = recipe.width, H = recipe.height;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  const base = images.get(recipe.base); if (base) ctx.drawImage(base, 0, 0, W, H);
  for (const f of recipe.features) {
    const fw = f.w * W, fh = f.h * H, v = f.v;
    if (f.kind === 'extra' && v.o <= 0) continue;
    ctx.save();
    ctx.translate(f.x * W, (1 - f.y) * H); ctx.rotate(-f.angle * Math.PI / 180); if (f.flip) ctx.scale(-1, 1);
    if (f.kind === 'brow') { ctx.translate(0, -v.r * .3 * fh); ctx.rotate(v.a * 18 * Math.PI / 180); }
    ctx.globalAlpha = f.kind === 'extra' ? v.o : 1;
    const draw = (g, src) => { const img = src && images.get(src); if (img) g.drawImage(img, -fw / 2, -fh / 2, fw, fh); };
    if (f.kind === 'eye') {
      draw(ctx, f.under);
      const pupil = f.pupil && images.get(f.pupil.src), mask = f.under && images.get(f.under);
      if (pupil && mask && scratch) {
        // The pupil inside the white: drawn on its own, cut to the white's shape, then laid down.
        const w = Math.max(1, Math.ceil(fw)), h = Math.max(1, Math.ceil(fh)), g = scratch(w, h);
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h);
        // A flipped eye looks the same way on screen: its look turns with it.
        const lx = (f.flip ? -v.x : v.x) * f.pupil.range[0] * w, ly = -v.y * f.pupil.range[1] * h, ps = f.pupil.size * w;
        g.drawImage(pupil, w / 2 + lx - ps / 2, h / 2 + ly - ps / 2, ps, ps);
        g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, 0, 0, w, h); g.restore();
        ctx.drawImage(g.canvas, 0, 0, w, h, -fw / 2, -fh / 2, fw, fh);
      }
      draw(ctx, f.over);
    } else draw(ctx, f.over);
    ctx.restore();
  }
  ctx.restore();
}
/** Every image a recipe needs. */
export const recipeImages = recipe => [...new Set([recipe.base, ...recipe.features.flatMap(f => [f.under, f.over, f.pupil?.src])].filter(Boolean))];
