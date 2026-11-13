/** 3D Nowdz model document: parts (mesh objects), a skeleton, a color
 * palette and reference images. Plain JSON, stored on exported figures as
 * `_styk.modelSource` so a 3D figure can be reopened and edited. */
import {cleanup, mirrored, transformMesh, surfaceOf, objectMatrix, objectMirrors, edgeKey, add, scale, normalize, vertexNormals, VDATA_KEYS} from './mesh.mjs';
import {validateMesh, TopologyError} from './topology.mjs';
import {DEFAULT_PALETTE} from './primitives.mjs';

export const MODEL_VERSION = 1;
export const SMOOTH_MAX = 3;

export function emptyModel() {
  return {version: MODEL_VERSION, name: '3D model', parts: [], bones: [], palette: DEFAULT_PALETTE.map(c => c.slice()), references: [], nextId: 1};
}

export function addPart(model, {name = 'Part', mesh, position = [0, 0, 0], rotation = [0, 0, 0], scale: size = [1, 1, 1], mirror = false, smooth = 0, visible = true}) {
  const part = {id: model.nextId++, name, mesh, position: position.slice(), rotation: rotation.slice(), scale: size.slice(), mirror, smooth, visible};
  model.parts.push(part);
  return part;
}

/** Validate and normalize a stored model (from a figure or a file). Throws on bad data. */
export function readModel(value) {
  const fail = why => { throw new Error(`This 3D model can't be opened: ${why}.`); };
  if (!value || typeof value !== 'object' || value.version !== MODEL_VERSION || !Array.isArray(value.parts)) fail('unknown format');
  const model = structuredClone(value);
  const finite = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  for (const part of model.parts) {
    if (!part?.mesh || !Array.isArray(part.mesh.verts) || !Array.isArray(part.mesh.faces)) fail('a part has no mesh');
    for (const key of ['position', 'rotation', 'scale']) if (!finite(part[key], 3)) fail(`a part has no ${key}`);
    // Stored meshes must follow the same topology rules as edits.
    const check = validateMesh(part.mesh, {label: `part “${part.name}”`, paletteSize: Array.isArray(model.palette) && model.palette.length ? model.palette.length : Infinity});
    if (!check.ok) throw new TopologyError(`Opening part “${part.name}”`, check);
    part.smooth = Math.max(0, Math.min(SMOOTH_MAX, Math.round(part.smooth ?? 0)));
    part.mirror = Boolean(part.mirror); part.visible = part.visible !== false;
    // Toon look: outline settings and whether the part takes shadows.
    if (part.outline !== undefined) {
      const o = part.outline;
      if (!o || typeof o !== 'object') delete part.outline;
      else part.outline = {on: Boolean(o.on), thickness: Number.isFinite(o.thickness) ? Math.max(.001, Math.min(.2, o.thickness)) : .012, color: Number.isInteger(o.color) && o.color >= 0 ? o.color : 9,
        ...(o.fromPart === true ? {fromPart: true} : {}), ...(Number.isFinite(o.darken) ? {darken: Math.max(0, Math.min(1, o.darken))} : {})};
    }
    if (part.shadows !== undefined) part.shadows = part.shadows !== false;
    if (part.solidify !== undefined) { const t = Number(part.solidify); if (Number.isFinite(t) && t !== 0) part.solidify = Math.max(-1, Math.min(1, t)); else delete part.solidify; }
    // Per-point data: line weights 0..4 and unit custom normals, on existing points only.
    if (part.mesh.vdata !== undefined) {
      const raw = part.mesh.vdata, n = part.mesh.verts.length, clean = {};
      if (raw && typeof raw === 'object') {
        const line = {}, normal = {}, skin = {}, boneIds = new Set((value.bones ?? []).map(b => b.id));
        for (const [i, list] of Object.entries(raw.skin ?? {})) {
          if (!(Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < n) || !Array.isArray(list)) continue;
          const pairs = list.filter(pair => Array.isArray(pair) && boneIds.has(pair[0]) && Number.isFinite(pair[1]) && pair[1] > 0).slice(0, 4), sum = pairs.reduce((t, pair) => t + pair[1], 0);
          if (sum > 0) skin[i] = pairs.map(([b, w]) => [b, w / sum]);
        }
        if (Object.keys(skin).length) clean.skin = skin;
        for (const [i, w] of Object.entries(raw.line ?? {})) if (Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < n && Number.isFinite(w)) line[i] = Math.max(0, Math.min(4, w));
        for (const [i, v] of Object.entries(raw.normal ?? {})) if (Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < n && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && Math.hypot(...v) > 1e-9) normal[i] = normalize(v);
        const hide = {}, crease = {};
        for (const i of Object.keys(raw.hide ?? {})) if (Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < n) hide[i] = 1;
        for (const [k, c] of Object.entries(raw.crease ?? {})) { const [a, b] = k.split(',').map(Number); if (Number.isInteger(a) && Number.isInteger(b) && a !== b && a >= 0 && b >= 0 && a < n && b < n && Number.isFinite(c) && c > 0) crease[a < b ? `${a},${b}` : `${b},${a}`] = Math.min(1, c); }
        if (Object.keys(hide).length) clean.hide = hide;
        if (Object.keys(crease).length) clean.crease = crease;
        if (Object.keys(line).length) clean.line = line;
        if (Object.keys(normal).length) clean.normal = normal;
      }
      if (Object.keys(clean).length) part.mesh.vdata = clean; else delete part.mesh.vdata;
    }
    if (part.clip !== undefined) part.clip = part.clip !== false;
  }
  if (model.toon !== undefined && (!model.toon || typeof model.toon !== 'object')) delete model.toon;
  model.bones = Array.isArray(model.bones) ? model.bones : [];
  for (const b of model.bones) {
    if (!finite(b.head, 3) || !finite(b.tail, 3)) fail('a bone is broken');
    // Face bones: a flag, how far each pulls the skin, and an optional cut.
    if (b.face === true) { b.reach = Number.isFinite(b.reach) ? Math.max(0, Math.min(10, b.reach)) : .05; if (!['below', 'above'].includes(b.cut)) delete b.cut; }
    else { delete b.face; delete b.reach; delete b.cut; }
    // How hard the bone pulls in automatic weights (armature.mjs pullOf); defaults are not stored.
    if (b.strength !== undefined) { if (Number.isFinite(b.strength) && b.strength !== 1) b.strength = Math.max(0, Math.min(2, b.strength)); else delete b.strength; }
    if (b.range !== undefined) { if (Number.isFinite(b.range) && b.range > 0) b.range = Math.min(100, b.range); else delete b.range; }
  }
  model.palette = Array.isArray(model.palette) && model.palette.length ? model.palette : DEFAULT_PALETTE.map(c => c.slice());
  model.references = Array.isArray(model.references) ? model.references : [];
  for (const ref of model.references) if (ref && typeof ref === 'object' && ref.flip !== true) delete ref.flip;
  model.nextId = Math.max(model.nextId ?? 1, ...model.parts.map(p => p.id + 1), ...model.bones.map(b => b.id + 1));
  return model;
}

/** Catmull-Clark subdivision, keeping face colors; open borders stay sharp-ish (boundary rules). */
export function catmullClark(mesh) {
  const verts = mesh.verts, faces = mesh.faces, edges = new Map(), out = {verts: [], faces: []};
  const facePoints = faces.map(f => scale(f.v.reduce((s, i) => add(s, verts[i]), [0, 0, 0]), 1 / f.v.length));
  faces.forEach((f, fi) => f.v.forEach((a, i) => {
    const b = f.v[(i + 1) % f.v.length], key = edgeKey(a, b);
    if (!edges.has(key)) edges.set(key, {a, b, faces: []});
    edges.get(key).faces.push(fi);
  }));
  const vertexFaces = verts.map(() => []), vertexEdges = verts.map(() => []);
  faces.forEach((f, fi) => f.v.forEach(i => vertexFaces[i].push(fi)));
  for (const e of edges.values()) { vertexEdges[e.a].push(e); vertexEdges[e.b].push(e); }
  // Edge creases (Blender's Edge Crease): 1 = sharp, between = blended toward sharp.
  const creases = mesh.vdata?.crease, creaseOf = e => e.faces.length === 2 ? Math.max(0, Math.min(1, creases?.[edgeKey(e.a, e.b)] ?? 0)) : 0;
  // New vertex points.
  verts.forEach((p, i) => {
    const border = vertexEdges[i].filter(e => e.faces.length === 1);
    if (border.length >= 2) {
      const [e1, e2] = border, n1 = verts[e1.a === i ? e1.b : e1.a], n2 = verts[e2.a === i ? e2.b : e2.a];
      out.verts.push(scale(add(add(scale(p, 6), n1), n2), 1 / 8));
    } else if (!vertexFaces[i].length) out.verts.push(p.slice());
    else {
      const n = vertexFaces[i].length, F = scale(vertexFaces[i].reduce((s, fi) => add(s, facePoints[fi]), [0, 0, 0]), 1 / n);
      const R = scale(vertexEdges[i].reduce((s, e) => add(s, scale(add(verts[e.a], verts[e.b]), .5)), [0, 0, 0]), 1 / vertexEdges[i].length);
      const smoothPoint = scale(add(add(F, scale(R, 2)), scale(p, n - 3)), 1 / n);
      // Creased edges at this point: two make a sharp line through it, three or more a corner.
      const sharp = vertexEdges[i].filter(e => creaseOf(e) > 0);
      if (sharp.length < 2) { out.verts.push(smoothPoint); return; }
      const strongest = sharp.sort((x, y) => creaseOf(y) - creaseOf(x)), weight = strongest.slice(0, sharp.length >= 3 ? sharp.length : 2).reduce((t, e) => t + creaseOf(e), 0) / (sharp.length >= 3 ? sharp.length : 2);
      const other = e => verts[e.a === i ? e.b : e.a];
      const target = sharp.length >= 3 ? p : scale(add(add(scale(p, 6), other(strongest[0])), other(strongest[1])), 1 / 8);
      out.verts.push(add(scale(smoothPoint, 1 - weight), scale(target, weight)));
    }
  });
  const faceBase = out.verts.length;
  facePoints.forEach(p => out.verts.push(p));
  const edgeIndex = new Map();
  for (const [key, e] of edges) {
    edgeIndex.set(key, out.verts.length);
    const mid = scale(add(verts[e.a], verts[e.b]), .5);
    const smoothPoint = e.faces.length === 2 ? scale(add(add(verts[e.a], verts[e.b]), add(facePoints[e.faces[0]], facePoints[e.faces[1]])), .25) : mid, c = creaseOf(e);
    out.verts.push(c > 0 ? add(scale(smoothPoint, 1 - c), scale(mid, c)) : smoothPoint);
  }
  faces.forEach((f, fi) => {
    const n = f.v.length;
    for (let i = 0; i < n; i++) {
      const a = f.v[i], next = edgeIndex.get(edgeKey(a, f.v[(i + 1) % n])), prev = edgeIndex.get(edgeKey(f.v[(i + n - 1) % n], a));
      out.faces.push({v: [a, next, faceBase + fi, prev], c: f.c});
    }
  });
  // Per-point data follows: original points keep theirs; new points take the mean
  // of the points they come from (a custom normal only where all of them have one).
  if (mesh.vdata) {
    out.vdata = {};
    const blend = (key, sources) => {
      const src = mesh.vdata[key]; if (!src) return undefined;
      if (key === 'line') return sources.some(i => src[i] !== undefined) ? sources.reduce((sum, i) => sum + (src[i] ?? 1), 0) / sources.length : undefined;
      if (!sources.every(i => src[i])) return undefined;
      if (key === 'skin') {
        // Mean of the sources' weights per bone, the four largest kept.
        const sum = new Map(); for (const i of sources) for (const [b, w] of src[i]) sum.set(b, (sum.get(b) ?? 0) + w / sources.length);
        const pairs = [...sum].sort((x, y) => y[1] - x[1]).slice(0, 4), total = pairs.reduce((t, [, w]) => t + w, 0);
        return total > 0 ? pairs.map(([b, w]) => [b, w / total]) : undefined;
      }
      if (key === 'hide') return 1;
      return normalize(sources.reduce((sum, i) => add(sum, src[i]), [0, 0, 0]));
    };
    for (const key of VDATA_KEYS) {
      if (!mesh.vdata[key]) continue;
      if (key === 'crease') {
        // Each creased edge's two halves keep its crease.
        const data = {};
        for (const [k, e] of edges) { const c = creaseOf(e); if (c > 0) { const m = edgeIndex.get(k); data[edgeKey(e.a, m)] = c; data[edgeKey(m, e.b)] = c; } }
        if (Object.keys(data).length) out.vdata.crease = data;
        continue;
      }
      const data = {...mesh.vdata[key]};
      faces.forEach((f, fi) => { const value = blend(key, f.v); if (value !== undefined) data[faceBase + fi] = value; });
      for (const [k, e] of edges) { const value = blend(key, [e.a, e.b]); if (value !== undefined) data[edgeIndex.get(k)] = value; }
      if (Object.keys(data).length) out.vdata[key] = data;
    }
    if (!Object.keys(out.vdata).length) delete out.vdata;
  }
  return out;
}

/** Solidify (Blender's modifier, default Offset −1): the surface gets a second
 * layer `thickness` inside it along the point normals, faces reversed, joined
 * to the first along every open edge by a rim, so clothes and hair cards get
 * real thickness. A closed surface gets an inner shell and no rim. */
export function solidify(mesh, thickness) {
  const t = Number(thickness);
  if (!t || !mesh.faces.length) return mesh;
  const n = mesh.verts.length, normals = vertexNormals(mesh), out = {verts: mesh.verts.map(p => p.slice()), faces: mesh.faces.map(f => ({v: f.v.slice(), c: f.c}))};
  mesh.verts.forEach((p, i) => out.verts.push(add(p, scale(normals[i], -t))));
  for (const f of mesh.faces) out.faces.push({v: f.v.map(i => i + n).reverse(), c: f.c});
  const half = new Set(); mesh.faces.forEach(f => f.v.forEach((a, i) => half.add(`${a}>${f.v[(i + 1) % f.v.length]}`)));
  for (const f of mesh.faces) f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (!half.has(`${b}>${a}`)) out.faces.push({v: [b, a, a + n, b + n], c: f.c}); });
  // Point data: the inner layer copies its outer point's (its custom normal turned inward).
  if (mesh.vdata) {
    out.vdata = {};
    for (const key of VDATA_KEYS) {
      const src = mesh.vdata[key]; if (!src) continue;
      if (key === 'crease') { out.vdata.crease = {...src}; continue; }
      const data = {...src};
      for (const [i, value] of Object.entries(src)) data[Number(i) + n] = key === 'normal' ? value.map(v => -v) : value;
      out.vdata[key] = data;
    }
  }
  return out;
}

/** A part's final world-space mesh: transform, then mirror, then solidify, then smooth. */
export function evaluatePart(part, {smooth = true} = {}) {
  // Pure matrix transform into world space (a new mesh; the part is not touched).
  // Only the surface: traced wires and loose points are editing aids, never shown or exported.
  let mesh = surfaceOf(transformMesh(part.mesh, objectMatrix(part)));
  // A negative scale turns faces inside out; flip them back.
  if (objectMirrors(part)) mesh.faces.forEach(f => f.v.reverse());
  if (part.mirror) mesh = mirrored(mesh);
  if (part.solidify) mesh = solidify(mesh, part.solidify * (Math.abs(part.scale?.[0] ?? 1) + Math.abs(part.scale?.[1] ?? 1) + Math.abs(part.scale?.[2] ?? 1)) / 3);
  if (smooth) for (let k = 0; k < (part.smooth ?? 0); k++) mesh = catmullClark(mesh);
  cleanup(mesh);
  return mesh;
}

/** Every visible part, evaluated, with its part id. */
export const evaluateModel = (model, options) => model.parts.filter(p => p.visible !== false && p.mesh.faces.length).map(part => ({part, mesh: evaluatePart(part, options)}));
