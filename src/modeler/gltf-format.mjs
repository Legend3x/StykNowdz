/** glTF 2.0 (.glb, .gltf) in and out for 3D Nowdz, so rigged models travel to
 * and from Blender, VRoid, Mixamo and game tools.
 *
 * Import: every mesh primitive's triangles (rest pose, skinning applied with the
 * file's own bind matrices), joined per mesh into one part, welded where the
 * file split points for normals or UVs; base colours become palette colours;
 * a skin's joints become bones (head at the joint; tail from 3D Nowdz's own
 * `extras.tail`, else at its children, else along the joint's own Y axis, as
 * Blender's importer guesses) and the file's skin
 * weights are kept on the points (mesh.vdata.skin). Textures and animations are
 * not read.
 *
 * Export: the evaluated parts (mirror and smooth applied) as triangles with
 * smooth (or custom) normals, one material per palette colour, and, with a
 * skeleton, a skin: one joint per bone, +Y along the bone like Blender's
 * exporter, with the same weights the animation uses (partWeights).
 */
import {evaluatePart} from './model.mjs';
import {add, sub, scale, normalize, cross, length, triangulate, vertexNormals, recalculateNormals, repairImportedMesh} from './mesh.mjs';
import {partWeights, boneOrder} from './armature.mjs';
import * as X from './matrix.mjs';
import {validateMesh, TopologyError} from './topology.mjs';

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENTS = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
const TYPED = {5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array};
const NORMALIZE = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535};
const fail = why => { throw new Error(`This glTF file can't be imported: ${why}.`); };

// glTF matrices are column-major; ours (matrix.mjs) are row-major.
const fromColumns = m => X.multiply(X.IDENTITY, [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]]);
const toColumns = m => [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
/** Rotation matrix from a unit quaternion [x, y, z, w]. */
function quatMatrix([x, y, z, w]) {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
}
/** Unit quaternion [x, y, z, w] of a rotation matrix (row-major 4×4). */
function matrixQuat(m) {
  const t = m[0] + m[5] + m[10];
  let q;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(m[9] - m[6]) / s, (m[2] - m[8]) / s, (m[4] - m[1]) / s, s / 4]; }
  else if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; q = [s / 4, (m[1] + m[4]) / s, (m[2] + m[8]) / s, (m[9] - m[6]) / s]; }
  else if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; q = [(m[1] + m[4]) / s, s / 4, (m[6] + m[9]) / s, (m[2] - m[8]) / s]; }
  else { const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2; q = [(m[2] + m[8]) / s, (m[6] + m[9]) / s, s / 4, (m[4] - m[1]) / s]; }
  const l = Math.hypot(...q); return q.map(v => v / l);
}
const nodeMatrix = node => node.matrix ? fromColumns(node.matrix)
  : X.compose(X.translation(node.translation ?? [0, 0, 0]), quatMatrix(node.rotation ?? [0, 0, 0, 1]), X.scaling(node.scale ?? [1, 1, 1]));
const toSrgb = v => Math.max(0, Math.min(255, Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055))));
const toLinear = v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };

// ---------- reading ----------

/** Split a .glb into its JSON and binary chunk. */
export function readGlb(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) fail('it is not a binary glTF (.glb) file');
  if (view.getUint32(4, true) !== 2) fail('only glTF version 2 is supported');
  let at = 12, json = null, bin = null;
  while (at + 8 <= buffer.byteLength) {
    const size = view.getUint32(at, true), type = view.getUint32(at + 4, true), body = new Uint8Array(buffer, at + 8, size);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN && !bin) bin = body.slice().buffer;
    at += 8 + size;
  }
  if (!json) fail('it has no scene description');
  return {json, bin};
}

function bufferData(json, bin, files) {
  return (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) { if (i === 0 && bin) return bin; fail('a data buffer is missing'); }
    const data = /^data:[^,]*;base64,(.*)$/.exec(b.uri);
    if (data) { const raw = atob(data[1]), out = new Uint8Array(raw.length); for (let k = 0; k < raw.length; k++) out[k] = raw.charCodeAt(k); return out.buffer; }
    const name = decodeURIComponent(b.uri).split('/').pop(), file = files.get(name);
    if (!file) fail(`it needs “${name}”; choose it together with the .gltf file`);
    return file;
  });
}

function accessorReader(json, buffers) {
  return index => {
    const a = json.accessors?.[index]; if (!a) fail('an accessor is missing');
    const width = COMPONENTS[a.type], Typed = TYPED[a.componentType];
    if (!width || !Typed) fail('a data type is not supported');
    const out = new Float64Array(a.count * width);
    if (a.bufferView !== undefined) {
      const view = json.bufferViews[a.bufferView], buffer = buffers[view.buffer];
      const size = Typed.BYTES_PER_ELEMENT, stride = view.byteStride || size * width, base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
      const data = new DataView(buffer);
      const get = {5120: o => data.getInt8(o), 5121: o => data.getUint8(o), 5122: o => data.getInt16(o, true), 5123: o => data.getUint16(o, true), 5125: o => data.getUint32(o, true), 5126: o => data.getFloat32(o, true)}[a.componentType];
      for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = get(base + i * stride + k * size);
    }
    if (a.sparse) {
      const idx = a.sparse.indices, val = a.sparse.values, read = (bv, offset, type, n, w) => {
        const view = json.bufferViews[bv], data = new DataView(buffers[view.buffer]), size = TYPED[type].BYTES_PER_ELEMENT, base = (view.byteOffset ?? 0) + (offset ?? 0);
        const get = {5121: o => data.getUint8(o), 5123: o => data.getUint16(o, true), 5125: o => data.getUint32(o, true), 5126: o => data.getFloat32(o, true), 5120: o => data.getInt8(o), 5122: o => data.getInt16(o, true)}[type];
        return Array.from({length: n * w}, (_, i) => get(base + i * size));
      };
      const at = read(idx.bufferView, idx.byteOffset, idx.componentType, a.sparse.count, 1), values = read(val.bufferView, val.byteOffset, a.componentType, a.sparse.count, width);
      at.forEach((i, k) => { for (let c = 0; c < width; c++) out[i * width + c] = values[k * width + c]; });
    }
    if (a.normalized && NORMALIZE[a.componentType]) for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, out[i] / NORMALIZE[a.componentType]);
    return {data: out, count: a.count, width};
  };
}

/** Parse glTF 2.0 into {parts: [{name, mesh}], bones: [{key, name, head, tail, parent}]},
 * adding material colours to `palette`. `source` is an ArrayBuffer (.glb) or the
 * parsed JSON of a .gltf; `files` maps other chosen file names to their data. */
export function importGltf(source, {palette = [], files = new Map()} = {}) {
  const {json, bin} = source instanceof ArrayBuffer ? readGlb(source) : {json: source, bin: null};
  if (!json.asset || String(json.asset.version).split('.')[0] !== '2') fail('only glTF version 2 is supported');
  if ((json.extensionsRequired ?? []).length) fail(`it needs extensions this importer can't read (${json.extensionsRequired.join(', ')}); export it again without compression`);
  const buffers = bufferData(json, bin, files), read = accessorReader(json, buffers), nodes = json.nodes ?? [];
  // World matrices of every node in the default scene, parent first.
  const parentOf = new Map(); nodes.forEach((n, i) => (n.children ?? []).forEach(c => parentOf.set(c, i)));
  const world = new Map(), worldOf = i => { if (!world.has(i)) world.set(i, parentOf.has(i) ? X.multiply(worldOf(parentOf.get(i)), nodeMatrix(nodes[i])) : nodeMatrix(nodes[i])); return world.get(i); };
  const scene = json.scenes?.[json.scene ?? 0], inScene = new Set(), walk = i => { inScene.add(i); (nodes[i].children ?? []).forEach(walk); };
  (scene?.nodes ?? nodes.map((_, i) => i).filter(i => !parentOf.has(i))).forEach(walk);

  // Bones: one per joint of every skin (a joint shared by two skins is one bone).
  const bones = [], boneOf = new Map();
  for (const skin of json.skins ?? []) for (const j of skin.joints) if (!boneOf.has(j)) { boneOf.set(j, bones.length); bones.push({node: j}); }
  for (const b of bones) {
    const m = worldOf(b.node), head = [...X.transformPoint(m, [0, 0, 0])];
    const kids = (nodes[b.node].children ?? []).filter(c => boneOf.has(c)).map(c => [...X.transformPoint(worldOf(c), [0, 0, 0])]);
    const saved = nodes[b.node].extras?.tail;
    let tail = Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite) ? saved.slice()
      : kids.length ? scale(kids.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / kids.length) : null;
    if (!tail || length(sub(tail, head)) < 1e-6) {
      // No child: along the joint's own Y axis, as long as its parent bone (or a small default).
      const parent = parentOf.get(b.node), from = boneOf.has(parent) ? [...X.transformPoint(worldOf(parent), [0, 0, 0])] : null;
      const size = from ? Math.max(length(sub(head, from)) * .5, 1e-3) : .1, axis = normalize([...X.transformDirection(m, [0, 1, 0])]);
      tail = add(head, scale(length(axis) > 0 ? axis : [0, 1, 0], size));
    }
    let up = parentOf.get(b.node); while (up !== undefined && !boneOf.has(up)) up = parentOf.get(up);
    Object.assign(b, {key: bones.indexOf(b), name: nodes[b.node].name || `Bone ${bones.indexOf(b) + 1}`, head, tail, parent: up === undefined ? null : boneOf.get(up)});
  }

  const colorOf = material => {
    const factor = json.materials?.[material]?.pbrMetallicRoughness?.baseColorFactor ?? [.8, .8, .8, 1];
    const rgb = factor.slice(0, 3).map(toSrgb);
    let i = palette.findIndex(c => c.every((v, k) => Math.abs(v - rgb[k]) <= 1));
    if (i < 0) { palette.push(rgb); i = palette.length - 1; }
    return i;
  };

  const parts = [];
  for (const ni of [...inScene].filter(i => nodes[i].mesh !== undefined)) {
    const node = nodes[ni], meshDef = json.meshes?.[node.mesh]; if (!meshDef) continue;
    const skin = node.skin !== undefined ? json.skins[node.skin] : null;
    const jointMats = skin ? skin.joints.map((j, k) => {
      const ibm = skin.inverseBindMatrices !== undefined ? read(skin.inverseBindMatrices) : null;
      return X.multiply(worldOf(j), ibm ? fromColumns(Array.from(ibm.data.subarray(k * 16, k * 16 + 16))) : X.IDENTITY);
    }) : null;
    const verts = [], faces = [], kept = {};
    for (const prim of meshDef.primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue; // triangles only (no lines or points)
      if (prim.attributes?.POSITION === undefined) continue;
      const pos = read(prim.attributes.POSITION), base = verts.length;
      const joints = skin && prim.attributes.JOINTS_0 !== undefined ? read(prim.attributes.JOINTS_0) : null, weights = joints && prim.attributes.WEIGHTS_0 !== undefined ? read(prim.attributes.WEIGHTS_0) : null;
      for (let i = 0; i < pos.count; i++) {
        const p = [pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]];
        if (jointMats && joints && weights) {
          // Rest pose: the skinning sum with the file's bind matrices.
          let q = [0, 0, 0], total = 0; const pairs = [];
          for (let k = 0; k < 4; k++) {
            const w = weights.data[i * 4 + k], j = joints.data[i * 4 + k]; if (!(w > 0) || !jointMats[j]) continue;
            q = add(q, scale([...X.transformPoint(jointMats[j], p)], w)); total += w;
            pairs.push([boneOf.get(skin.joints[j]), w]);
          }
          verts.push(total > 0 ? scale(q, 1 / total) : [...X.transformPoint(worldOf(ni), p)]);
          if (pairs.length) kept[verts.length - 1] = pairs;
        } else verts.push([...X.transformPoint(worldOf(ni), p)]);
      }
      const color = colorOf(prim.material);
      const index = prim.indices !== undefined ? read(prim.indices).data : Float64Array.from({length: pos.count}, (_, i) => i);
      for (let t = 0; t + 2 < index.length; t += 3) {
        const v = [index[t], index[t + 1], index[t + 2]].map(i => base + i);
        if (new Set(v).size === 3 && length(cross(sub(verts[v[1]], verts[v[0]]), sub(verts[v[2]], verts[v[0]]))) > 1e-12) faces.push({v, c: color});
      }
    }
    if (!faces.length) continue;
    const mesh = {verts, faces, ...(Object.keys(kept).length ? {vdata: {skin: kept}} : {})};
    parts.push({name: node.name || meshDef.name || `Part ${parts.length + 1}`, mesh});
  }
  if (!parts.length) fail('it has no triangle meshes');
  // Files split points along UV and normal seams; weld them back so the surface
  // is one piece, split apart anything that breaks the rules, then check it as
  // any edit is checked.
  for (const p of parts) {
    repairImportedMesh(p.mesh, {weld: 1e-6});
    try { recalculateNormals(p.mesh); }
    catch (error) {
      if (!(error instanceof TopologyError)) throw error;
      const check = validateMesh(p.mesh, {label: `imported part “${p.name}”`, print: false});
      throw new TopologyError(`Importing part “${p.name}”`, check.ok ? error.result : check);
    }
  }
  return {parts, bones: bones.map(({key, name, head, tail, parent}) => ({key, name, head, tail, parent}))};
}

// ---------- writing ----------

/** The model as a binary glTF (.glb) ArrayBuffer: visible evaluated parts, palette
 * colours as materials, and the skeleton as a skin with the animation's weights. */
export function exportGlb(model, {name = model.name || '3D Nowdz model'} = {}) {
  const chunks = [], views = [], accessors = [];
  let offset = 0;
  const addView = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    views.push({buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? {target} : {})});
    offset += bytes.length + pad; return views.length - 1;
  };
  const addAccessor = (typed, type, componentType, target, extra = {}) => {
    accessors.push({bufferView: addView(typed, target), componentType, count: typed.length / COMPONENTS[type], type, ...extra});
    return accessors.length - 1;
  };
  const bones = boneOrder(model), boneIndex = new Map(bones.map((b, i) => [b.id, i]));
  const nodes = [], meshes = [], materials = [], materialOf = new Map(), sceneNodes = [];
  const material = c => {
    if (!materialOf.has(c)) { const rgb = model.palette[c] ?? [200, 200, 200]; materialOf.set(c, materials.length); materials.push({name: `Color ${c}`, pbrMetallicRoughness: {baseColorFactor: [...rgb.map(toLinear), 1], metallicFactor: 0, roughnessFactor: .9}}); }
    return materialOf.get(c);
  };
  const skinIndex = bones.length ? 0 : undefined;
  for (const part of model.parts.filter(p => p.visible !== false && p.mesh.faces.length)) {
    const mesh = evaluatePart(part), n = mesh.verts.length;
    const normals = vertexNormals(mesh).map((v, i) => mesh.vdata?.normal?.[i] ?? v);
    const attributes = {
      POSITION: addAccessor(Float32Array.from(mesh.verts.flat()), 'VEC3', 5126, 34962, {min: [0, 1, 2].map(k => Math.min(...mesh.verts.map(p => p[k]))), max: [0, 1, 2].map(k => Math.max(...mesh.verts.map(p => p[k])))}),
      NORMAL: addAccessor(Float32Array.from(normals.flat().map(v => Number.isFinite(v) ? v : 0)), 'VEC3', 5126, 34962),
    };
    if (bones.length) {
      const skin = partWeights(model, mesh, part), joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) { joints[i] = boneIndex.get(skin.bones[i]) ?? 0; weights[i] = skin.bones[i] && boneIndex.has(skin.bones[i]) ? skin.weights[i] : 0; }
      for (let v = 0; v < n; v++) { let s = 0; for (let k = 0; k < 4; k++) s += weights[v * 4 + k]; if (s > 0) for (let k = 0; k < 4; k++) weights[v * 4 + k] /= s; else { weights[v * 4] = 1; joints[v * 4] = 0; } }
      attributes.JOINTS_0 = addAccessor(joints, 'VEC4', 5123, 34962);
      attributes.WEIGHTS_0 = addAccessor(weights, 'VEC4', 5126, 34962);
    }
    const byColor = new Map();
    for (const [a, b, c, fi] of triangulate(mesh)) { const k = mesh.faces[fi].c ?? 0; if (!byColor.has(k)) byColor.set(k, []); byColor.get(k).push(a, b, c); }
    const primitives = [...byColor].map(([c, list]) => ({attributes, indices: addAccessor(n > 65535 ? Uint32Array.from(list) : Uint16Array.from(list), 'SCALAR', n > 65535 ? 5125 : 5123, 34963), material: material(c)}));
    meshes.push({name: part.name || 'Part', primitives});
    nodes.push({name: part.name || 'Part', mesh: meshes.length - 1, ...(skinIndex !== undefined ? {skin: skinIndex} : {})});
    sceneNodes.push(nodes.length - 1);
  }
  if (!meshes.length) throw new Error('There is nothing to export: show at least one part with faces.');
  let skins;
  if (bones.length) {
    // Joints: +Y along the bone (as Blender's exporter does), positioned at the head.
    const worldOf = new Map(), first = nodes.length;
    for (const b of bones) {
      const y = normalize(sub(b.tail, b.head)), helper = Math.abs(y[1]) < .9 ? [0, 1, 0] : [1, 0, 0];
      const x = normalize(cross(y, helper)), z = cross(x, y);
      worldOf.set(b.id, [x[0], y[0], z[0], b.head[0], x[1], y[1], z[1], b.head[1], x[2], y[2], z[2], b.head[2], 0, 0, 0, 1]);
    }
    bones.forEach(b => {
      const local = b.parent && worldOf.has(b.parent) ? X.multiply(X.invert(worldOf.get(b.parent)), worldOf.get(b.id)) : worldOf.get(b.id);
      // glTF joints have no length; the tail rides along in `extras` so 3D Nowdz gets it back exactly.
      nodes.push({name: b.name, translation: [local[3], local[7], local[11]], rotation: matrixQuat(local), extras: {tail: b.tail.slice()}});
    });
    bones.forEach((b, i) => { const kids = bones.map((c, k) => c.parent === b.id ? first + k : -1).filter(k => k >= 0); if (kids.length) nodes[first + i].children = kids; });
    const roots = bones.map((b, i) => (!b.parent || !worldOf.has(b.parent)) ? first + i : -1).filter(i => i >= 0);
    const ibm = Float32Array.from(bones.flatMap(b => toColumns(X.invert(worldOf.get(b.id)))));
    skins = [{name: 'Armature', joints: bones.map((_, i) => first + i), inverseBindMatrices: addAccessor(ibm, 'MAT4', 5126), skeleton: roots[0]}];
    sceneNodes.push(...roots);
  }
  const json = {asset: {version: '2.0', generator: 'StykNowdz 3D Nowdz'}, scene: 0, scenes: [{name, nodes: sceneNodes}], nodes, meshes, materials,
    accessors, bufferViews: views, buffers: [{byteLength: offset}], ...(skins ? {skins} : {})};
  const text = new TextEncoder().encode(JSON.stringify(json)), jsonPad = (4 - (text.length % 4)) % 4;
  const total = 12 + 8 + text.length + jsonPad + 8 + offset, out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, text.length + jsonPad, true); view.setUint32(16, CHUNK_JSON, true); out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + text.length + jsonPad);
  let at = 20 + text.length + jsonPad;
  view.setUint32(at, offset, true); view.setUint32(at + 4, CHUNK_BIN, true); at += 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

