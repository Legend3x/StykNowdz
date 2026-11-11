/** 3D Nowdz model document: parts (mesh objects), a skeleton, a color
 * palette and reference images. Plain JSON, stored on exported figures as
 * `_styk.modelSource` so a 3D figure can be reopened and edited. */
import {cleanup, mirrored, transformMesh, surfaceOf, objectMatrix, objectMirrors, edgeKey, add, scale, normalize, VDATA_KEYS} from './mesh.mjs';
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
      out.verts.push(scale(add(add(F, scale(R, 2)), scale(p, n - 3)), 1 / n));
    }
  });
  const faceBase = out.verts.length;
  facePoints.forEach(p => out.verts.push(p));
  const edgeIndex = new Map();
  for (const [key, e] of edges) {
    edgeIndex.set(key, out.verts.length);
    const mid = scale(add(verts[e.a], verts[e.b]), .5);
    out.verts.push(e.faces.length === 2 ? scale(add(add(verts[e.a], verts[e.b]), add(facePoints[e.faces[0]], facePoints[e.faces[1]])), .25) : mid);
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
      return normalize(sources.reduce((sum, i) => add(sum, src[i]), [0, 0, 0]));
    };
    for (const key of VDATA_KEYS) {
      if (!mesh.vdata[key]) continue;
      const data = {...mesh.vdata[key]};
      faces.forEach((f, fi) => { const value = blend(key, f.v); if (value !== undefined) data[faceBase + fi] = value; });
      for (const [k, e] of edges) { const value = blend(key, [e.a, e.b]); if (value !== undefined) data[edgeIndex.get(k)] = value; }
      if (Object.keys(data).length) out.vdata[key] = data;
    }
    if (!Object.keys(out.vdata).length) delete out.vdata;
  }
  return out;
}

/** A part's final world-space mesh: transform, then mirror, then smooth. */
export function evaluatePart(part, {smooth = true} = {}) {
  // Pure matrix transform into world space (a new mesh; the part is not touched).
  // Only the surface: traced wires and loose points are editing aids, never shown or exported.
  let mesh = surfaceOf(transformMesh(part.mesh, objectMatrix(part)));
  // A negative scale turns faces inside out; flip them back.
  if (objectMirrors(part)) mesh.faces.forEach(f => f.v.reverse());
  if (part.mirror) mesh = mirrored(mesh);
  if (smooth) for (let k = 0; k < (part.smooth ?? 0); k++) mesh = catmullClark(mesh);
  cleanup(mesh);
  return mesh;
}

/** Every visible part, evaluated, with its part id. */
export const evaluateModel = (model, options) => model.parts.filter(p => p.visible !== false && p.mesh.faces.length).map(part => ({part, mesh: evaluatePart(part, options)}));
