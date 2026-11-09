/** 3D Nowdz → StykNowdz figure. The result is an ordinary 3D figure of
 * the existing engine (docs/SPATIAL-MESHES.md): a hidden Figure rotation
 * joint, two hidden reference joints for the mesh's facing, one 3D bone per
 * skeleton bone (each with its own turn/tilt controls, so every joint poses
 * in depth), and the evaluated mesh skinned to those bones. The model itself
 * rides along in `_styk.modelSource` so the figure can be reopened. */
import {triangulate} from './mesh.mjs';
import {scaling, transformPoint} from './matrix.mjs';
import {assertValidMesh} from './topology.mjs';
import {outlineHull, partOutline, toonSettings} from './toon.mjs';
import {toonLight, toonThreshold} from '../toon-shading.mjs';
import {evaluateModel, readModel} from './model.mjs';
import {boneOrder, autoWeights, addBone} from './armature.mjs';
import {MESH_LIMITS} from '../spatial-mesh.mjs';
import {createObject, createFrame} from '../demo.mjs';

export const PIXELS_PER_UNIT = 100;
/** Model space (Y up, +Z toward the front view) → figure space (Y down, +Z
 * toward the camera: the mesh depth test keeps the larger depth). */
export const FIGURE_MATRIX = scaling([PIXELS_PER_UNIT, -PIXELS_PER_UNIT, PIXELS_PER_UNIT]);
export const toFigure = p => [...transformPoint(FIGURE_MATRIX, p)];

const segment = (id, parent, length, angle, name, extra = {}) => ({segment_id: id, parent_id: parent, length, angle_rad: angle, thickness: 0, bend_rad: 0,
  primitive_code: 0, aux_code: 1, flags: 256, is_static: true, segment_type: 'line', segment_kind: 'line', color_rgb: [13, 153, 255],
  transparency: 0, visible: false, z_order: 0, name, ...extra});

/** Error with a message the modeler shows as is. */
const problem = message => Object.assign(new Error(message), {modelerMessage: true});

/**
 * Build the figure definition. Returns {figure, stats}. `figureTypeId` is
 * the definition's ID inside the returned document.
 */
export function modelToFigure(source, {figureTypeId = 1, previous = null} = {}) {
  const model = readModel(source), parts = evaluateModel(model);
  if (!parts.length) throw problem('Add at least one visible part before adding the model to your animation.');
  const segments = [];
  // Re-editing a figure keeps each joint's ID (matched by name), so its poses in
  // every frame survive Editor.replaceFigureDefinition; new joints get fresh IDs.
  const reuse = new Map((previous?.segments ?? []).map(s => [s.name, s.segment_id])), taken = new Set();
  let fresh = Math.max(0, ...(previous?.segments ?? []).map(s => s.segment_id)) + 1;
  // Fresh IDs start above every previous ID, so they never collide with reused ones.
  const idFor = name => {
    const id = reuse.get(name);
    if (id !== undefined && !taken.has(id)) { taken.add(id); return id; }
    while (taken.has(fresh)) fresh++;
    taken.add(fresh); return fresh++;
  };
  const push = (parent, length, angle, name, extra) => { const s = segment(idFor(name), parent, length, angle, name, extra); segments.push(s); return s; };
  // The Figure rotation joint first: figure rotation is measured from segment 0.
  const rotation = push(0, 0, 0, 'Figure rotation');
  const figureTurn = push(0, 0, 0, 'Figure turn'), figureTilt = push(0, 0, 0, 'Figure tilt');
  rotation._stykRig = {spatial: {parent: 0, origin: [0, 0, 0], tip: [0, 0, 0], turn: figureTurn.segment_id, pitch: figureTilt.segment_id}};
  const surfaceX = push(0, 30, 0, 'Surface X'), surfaceY = push(0, 30, Math.PI / 2, 'Surface Y');
  // Without a skeleton the whole model follows one Body bone.
  let bones = boneOrder(model);
  if (!bones.length) {
    const ys = parts.flatMap(p => p.mesh.verts.map(v => v[1]));
    const temp = {...model, bones: [], nextId: model.nextId};
    addBone(temp, {name: 'Body', head: [0, Math.min(...ys), 0], tail: [0, Math.max(...ys), 0]});
    bones = temp.bones; model.bones = temp.bones;
  }
  const boneSegment = new Map();
  for (const bone of bones) {
    const origin = toFigure(bone.head), tip = toFigure(bone.tail), d = [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]];
    const full = Math.hypot(...d);
    if (full < 1e-6) throw problem(`The bone “${bone.name}” has no length. Move its tail away from its head.`);
    const turn = push(0, 0, 0, `${bone.name} turn`), tilt = push(0, 0, 0, `${bone.name} tilt`);
    const parentBone = boneSegment.get(bone.parent)?.segment_id ?? 0, parent = parentBone || rotation.segment_id;
    // Movable joint; its 2D angle is the bone's front-view direction (straight down when it points at the camera).
    // Its structural parent is its parent bone, so dragging a joint on the stage carries everything below it
    // (the whole arm with the upper arm, the upper body with the hips), as with any Pivot figure.
    const flat = Math.hypot(d[0], d[1]), s = segment(idFor(bone.name), parentBone, full, flat > 1e-6 ? Math.atan2(d[1], d[0]) : Math.PI / 2, bone.name,
      {aux_code: 0, flags: 0, is_static: false, _stykRig: {spatial: {parent, origin, tip, turn: turn.segment_id, pitch: tilt.segment_id}},
        // Face bones are face controls on the stage: hidden until the head's face badge opens them.
        ...(bone.face ? {_stykControl: {level: 'face'}} : {})});
    segments.push(s); boneSegment.set(bone.id, s);
  }
  // The mesh: every part's triangles, in part order, skinned to the bones.
  const positions = [], meshBones = [], weights = [], indices = [], materials = [], groups = [];
  const used = new Map(), colors = [];
  const color = c => { const key = Math.min(Math.max(0, c ?? 0), model.palette.length - 1); if (!used.has(key)) { used.set(key, colors.length); colors.push(model.palette[key].map(v => Math.max(0, Math.min(255, Math.round(v))))); } return used.get(key); };
  const toon = toonSettings(model), flat = [];
  // One surface (the part, or its outline shell) skinned like the part. Model faces
  // wind counter-clockwise seen from outside; the engine shows triangles that
  // look clockwise on screen (positive area with Y down), so each is reversed.
  const addSurface = (surface, skin, name, noShadow) => {
    const base = positions.length / 3, start = indices.length / 3;
    for (const p of surface.verts) positions.push(...toFigure(p).map(v => Math.fround(v)));
    for (let k = 0; k < skin.bones.length; k++) { const id = skin.bones[k]; meshBones.push(id ? boneSegment.get(id).segment_id : 0); weights.push(skin.weights[k]); }
    for (const [a, b, c, fi] of triangulate(surface)) { indices.push(base + a, base + c, base + b); materials.push(color(surface.faces[fi].c)); }
    const count = indices.length / 3 - start;
    if (count) { if (noShadow) flat.push(groups.length); groups.push({name: String(name).slice(0, 256), start, count}); }
  };
  for (const {part, mesh} of parts) {
    // The final, modified surface must be valid too (mirror and smooth included).
    assertValidMesh(mesh, `Adding part “${part.name}”`, {paletteSize: model.palette.length});
    const skin = autoWeights(model, mesh, part), name = part.name || 'Part';
    addSurface(mesh, skin, name, part.shadows === false);
    // Its ink outline: an inverted hull sharing the part's skin, never shaded.
    const outline = partOutline(part, model.palette.length);
    if (outline) addSurface(outlineHull(mesh, outline.thickness, outline.color), skin, `${name} outline`, true);
  }
  if (positions.length / 3 > MESH_LIMITS.vertices) throw problem(`The model has ${positions.length / 3} vertices after smoothing; the limit is ${MESH_LIMITS.vertices}. Lower Smooth on some parts.`);
  if (indices.length / 3 > MESH_LIMITS.triangles) throw problem(`The model has ${indices.length / 3} triangles after smoothing; the limit is ${MESH_LIMITS.triangles}. Lower Smooth on some parts.`);
  segments.forEach((s, i) => { s.z_order = i + 1; });
  const figure = {figure_type_id: figureTypeId, name: String(model.name || '3D model').slice(0, 250), segments, segment_count: segments.length, polyfills: [], image_assets: [], text_assets: [],
    _styk: {colorMode: 'segments', spatialMesh: {positions, bones: meshBones, weights, indices, colors, materials, basis: [0, surfaceX.segment_id, surfaceY.segment_id], groups,
      ...(toon.shadows ? {toon: {light: [...toonLight(toon.turn, toon.height)], threshold: toonThreshold(toon.size), strength: toon.strength, flat}} : {})}, modelSource: source}};
  return {figure, stats: {vertices: positions.length / 3, triangles: indices.length / 3, bones: bones.length, parts: parts.length}};
}

/** A one-figure document for Editor.importFigure. */
export function modelDocument(model) {
  const {figure, stats} = modelToFigure(model);
  const object = createObject(figure, 1, 0, 0);
  return {document: {figure_types: [figure], keyframes: [createFrame([object])]}, stats};
}
