/** 3D Nowdz textures (docs/BLENDER-LITE.md, "Textures and UVs").
 *
 * A face may carry `uv`, one [u, v] per corner in the same order as `v`
 * (Blender's convention: 0..1 across the image, v pointing up), and `t`, the id
 * of one of `model.textures` ({id, name, src, width, height}; src is a PNG or
 * JPEG data URL). A face with both is drawn with its texture; any other face
 * keeps its flat palette colour `c`, which also stays the colour shown where
 * textures are hidden.
 *
 * Edits keep UVs without each tool knowing about them (keepUVs, run by every
 * atomic edit in mesh.mjs): a face whose corner list survived keeps its UVs as
 * they were, and a face made inside an old face (subdivide, inset, loop cut,
 * knife, triangulate, poke, dissolve, split...) takes each corner's UV from the
 * old face at that point, by mean value interpolation over the old face. A
 * face that lies in no old face (fill, bridge, the sides of an extrusion)
 * starts without UVs. */
// Local vector helpers: mesh.mjs imports this module, so it can't import them back.
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => { const l = length(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

export const TEXTURE_LIMIT = 16;
export const TEXTURE_MAX_SIDE = 4096;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** A face's own attributes for a copy: colour, texture and UVs. */
export function faceCopy(f, v = f.v) {
  const out = {v, c: f.c ?? 0};
  if (f.t !== undefined) out.t = f.t;
  if (f.uv && f.uv.length === v.length) out.uv = f.uv.map(p => p.slice());
  return out;
}
/** The same face turned around (corner order reversed), UVs following their corners. */
export function reversedFace(f, v) {
  const out = {v, c: f.c ?? 0};
  if (f.t !== undefined) out.t = f.t;
  if (f.uv && f.uv.length === f.v.length) out.uv = f.uv.slice().reverse().map(p => p.slice());
  return out;
}
/** Turn a face around in place, its UVs following their corners. */
export function flipFace(f) { f.v.reverse(); if (f.uv) f.uv.reverse(); return f; }
export const textured = f => f.t !== undefined && Array.isArray(f.uv) && f.uv.length === f.v.length;

/** Mean value coordinates of point x inside a planar polygon (3D points). Corners
 * on x get weight 1; returns null when x is off the polygon by more than `tol`. */
function meanValue(corners, normal, x, tol) {
  const n = corners.length, d = corners.map(c => sub(c, x)), r = d.map(length);
  for (let i = 0; i < n; i++) if (r[i] <= tol) return corners.map((_, j) => +(i === j));
  // On an edge: blend its two corners.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, e = sub(corners[j], corners[i]), el = length(e);
    if (el < 1e-12) continue;
    const t = dot(sub(x, corners[i]), e) / (el * el);
    if (t > 0 && t < 1 && length(sub(x, add(corners[i], scale(e, t)))) <= tol) return corners.map((_, k) => k === i ? 1 - t : k === j ? t : 0);
  }
  const w = new Array(n).fill(0), tanHalf = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, c = cross(d[i], d[j]), s = dot(c, normal) >= 0 ? 1 : -1;
    const angle = Math.atan2(length(c) * s, dot(d[i], d[j]));
    tanHalf[i] = Math.tan(angle / 2);
  }
  let total = 0;
  for (let i = 0; i < n; i++) { w[i] = (tanHalf[(i + n - 1) % n] + tanHalf[i]) / r[i]; total += w[i]; }
  if (!Number.isFinite(total) || Math.abs(total) < 1e-12) return null;
  return w.map(v => v / total);
}
/** Whether point x lies on face `corners` (within its plane, inside its outline). */
function insideFace(corners, normal, x, tol) {
  const p = corners[0];
  if (Math.abs(dot(sub(x, p), normal)) > tol) return false;
  // Winding test in the face's plane: an outside point sees the outline turn a total of 0.
  let turn = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = sub(corners[i], x), b = sub(corners[(i + 1) % corners.length], x);
    if (length(a) <= tol || length(b) <= tol) return true;
    turn += Math.atan2(dot(cross(a, b), normal), dot(a, b));
  }
  if (Math.abs(turn) > Math.PI) return true;
  // On an edge counts as inside.
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], e = sub(corners[(i + 1) % corners.length], a), el = length(e);
    if (el < 1e-12) continue;
    const t = dot(sub(x, a), e) / (el * el);
    if (t >= 0 && t <= 1 && length(sub(x, add(a, scale(e, t)))) <= tol) return true;
  }
  return false;
}
function faceNormal(corners) {
  let n = [0, 0, 0];
  for (let i = 0; i < corners.length; i++) { const a = corners[i], b = corners[(i + 1) % corners.length]; n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
  return normalize(n);
}

/** After an edit: faces that lost their UVs (new faces, or faces whose corners
 * changed) take them from the old textured face they lie in. `before` is the
 * mesh as it was ({verts, faces}); `origins` maps each face the edit started
 * from to the old face it copies. An old face kept by the edit keeps its UVs,
 * except at corners whose point the edit swapped (an inset or extrusion reuses
 * the face with new points): those take the UV at their new place on the old
 * face, or keep theirs if the point left the face (a merge). A face that lies
 * in no old textured face loses `uv` and `t`. */
export function keepUVs(before, mesh, origins = new Map()) {
  const old = before.faces.map((f, i) => textured(f) ? i : -1).filter(i => i >= 0);
  if (!old.length) { for (const f of mesh.faces) { delete f.uv; delete f.t; } return; }
  const info = old.map(i => {
    const f = before.faces[i], corners = f.v.map(k => before.verts[k]), normal = faceNormal(corners);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], size = 0;
    for (const p of corners) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    for (let k = 0; k < 3; k++) size = Math.max(size, hi[k] - lo[k]);
    return {f, corners, normal, lo, hi, tol: Math.max(1e-7, size * 1e-4)};
  });
  // A coarse grid over the old faces' boxes, so each lookup checks only nearby faces.
  let span = 0;
  for (const o of info) for (let k = 0; k < 3; k++) span = Math.max(span, o.hi[k] - o.lo[k]);
  const cell = Math.max(span, 1e-6), grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  for (const [n, o] of info.entries()) {
    const a = o.lo.map(v => Math.floor((v - o.tol) / cell)), b = o.hi.map(v => Math.floor((v + o.tol) / cell));
    for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) { const k = key(x, y, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
  }
  const near = p => grid.get(key(...p.map(v => Math.floor(v / cell)))) ?? [];
  for (const f of mesh.faces) {
    const was = origins.get(f);
    if (was && textured(was) && f.uv && f.uv.length === f.v.length && f.t !== undefined) {
      if (f.v.length === was.v.length && f.v.some((v, k) => v !== was.v[k])) {
        const corners = was.v.map(k => before.verts[k]), normal = faceNormal(corners);
        let size = 0; for (const p of corners) for (const q of corners) size = Math.max(size, length(sub(p, q)));
        const tol = Math.max(1e-7, size * 1e-4);
        f.v.forEach((v, k) => {
          if (v === was.v[k]) return;
          const p = mesh.verts[v], w = insideFace(corners, normal, p, tol * 10) ? meanValue(corners, normal, p, tol) : null;
          if (w) f.uv[k] = [w.reduce((s, x, i) => s + x * was.uv[i][0], 0), w.reduce((s, x, i) => s + x * was.uv[i][1], 0)];
        });
      }
      continue;
    }
    if (!was && f.uv && f.uv.length === f.v.length && f.t !== undefined) continue;
    delete f.uv;
    const corners = f.v.map(k => mesh.verts[k]), centre = scale(corners.reduce(add, [0, 0, 0]), 1 / corners.length);
    const home = near(centre).map(n => info[n]).find(o => insideFace(o.corners, o.normal, centre, o.tol));
    if (!home) { delete f.t; continue; }
    const uv = [];
    for (const p of corners) {
      const w = insideFace(home.corners, home.normal, p, home.tol * 10) ? meanValue(home.corners, home.normal, p, home.tol) : null;
      if (!w) { uv.length = 0; break; }
      uv.push([w.reduce((s, x, i) => s + x * home.f.uv[i][0], 0), w.reduce((s, x, i) => s + x * home.f.uv[i][1], 0)]);
    }
    if (uv.length === f.v.length) { f.uv = uv; f.t = home.f.t; } else delete f.t;
  }
}

/** Clean the textures list and every face's texture data of a stored model
 * (readModel). Bad entries are dropped; faces pointing at a missing texture,
 * or with UVs that don't match their corners, lose them. */
export function readTextures(model) {
  const list = Array.isArray(model.textures) ? model.textures : [], seen = new Set(), textures = [];
  for (const t of list) {
    if (textures.length >= TEXTURE_LIMIT || !t || !Number.isInteger(t.id) || t.id <= 0 || seen.has(t.id) || typeof t.src !== 'string' || !DATA_URL.test(t.src)) continue;
    const w = Math.round(Number(t.width)), h = Math.round(Number(t.height));
    if (!(w >= 1 && h >= 1 && w <= TEXTURE_MAX_SIDE && h <= TEXTURE_MAX_SIDE)) continue;
    seen.add(t.id); textures.push({id: t.id, name: String(t.name ?? 'Texture').slice(0, 120) || 'Texture', src: t.src, width: w, height: h});
  }
  if (textures.length) model.textures = textures; else delete model.textures;
  for (const part of model.parts ?? []) for (const f of part.mesh?.faces ?? []) {
    const uvOk = Array.isArray(f.uv) && f.uv.length === f.v?.length && f.uv.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (uvOk) f.uv = f.uv.map(p => [p[0], p[1]]); else delete f.uv;
    if (!(Number.isInteger(f.t) && seen.has(f.t))) delete f.t;
  }
}
/** The next free texture id. */
export const nextTextureId = model => Math.max(0, ...(model.textures ?? []).map(t => t.id)) + 1;
/** Add a texture ({name, src, width, height}); returns it. */
export function addTexture(model, {name = 'Texture', src, width, height}) {
  if ((model.textures?.length ?? 0) >= TEXTURE_LIMIT) throw Object.assign(new RangeError(`A model can hold ${TEXTURE_LIMIT} textures.`), {modelerMessage: true});
  const texture = {id: nextTextureId(model), name, src, width, height};
  (model.textures ??= []).push(texture);
  return texture;
}
/** Whether any part uses a texture. */
export const usesTextures = model => (model.parts ?? []).some(p => p.mesh?.faces?.some(textured));

/** Type and size of PNG, JPEG or WebP image bytes, read from their headers; null otherwise. */
export function imageInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return {mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20)};
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the first start-of-frame, which holds the size.
    for (let at = 2; at + 9 < b.length;) {
      if (b[at] !== 0xff) { at++; continue; }
      const marker = b[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const size = view.getUint16(at + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return {mime: 'image/jpeg', width: view.getUint16(at + 7), height: view.getUint16(at + 5)};
      at += 2 + size;
    }
    return null;
  }
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === 'VP8 ') return {mime: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
    if (kind === 'VP8L') { const bits = view.getUint32(21, true); return {mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1}; }
    if (kind === 'VP8X') return {mime: 'image/webp', width: 1 + (b[24] | b[25] << 8 | b[26] << 16), height: 1 + (b[27] | b[28] << 8 | b[29] << 16)};
  }
  return null;
}
/** Image bytes as a data URL. */
export function bytesToDataUrl(bytes, mime) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < b.length; i += 0x8000) text += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(text)}`;
}
/** The bytes and type of an image data URL. */
export function dataUrlBytes(src) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(src ?? '');
  if (!m) return null;
  const raw = atob(m[2]), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return {mime: m[1], bytes};
}
/** A texture entry for image bytes (name, data URL, size), or null when they are
 * not a PNG, JPEG or WebP of a usable size. */
export function textureFromBytes(bytes, name = 'Texture') {
  const info = imageInfo(bytes);
  if (!info || !(info.width >= 1 && info.height >= 1 && info.width <= TEXTURE_MAX_SIDE && info.height <= TEXTURE_MAX_SIDE)) return null;
  return {name, src: bytesToDataUrl(bytes, info.mime), width: info.width, height: info.height};
}
/** Add imported textures ({key, ...entry}) to the model, returning key → texture
 * id; those past the model's limit are left out (their faces show colours). */
export function adoptTextures(model, list) {
  const ids = new Map();
  for (const entry of list) {
    if ((model.textures?.length ?? 0) >= TEXTURE_LIMIT) break;
    const same = model.textures?.find(t => t.src === entry.src);
    ids.set(entry.key, same ? same.id : addTexture(model, entry).id);
  }
  return ids;
}
/** Point imported faces' texture keys at the model's texture ids (unknown keys drop the texture). */
export function remapFaceTextures(mesh, ids) {
  for (const f of mesh.faces) { if (f.t === undefined) continue; const id = ids.get(f.t); if (id === undefined) { delete f.t; delete f.uv; } else f.t = id; }
}
