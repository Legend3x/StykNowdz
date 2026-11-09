import {messageError} from './localized-error.mjs';
import {isMovieclip} from './movieclips.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {spatialBone, chordScale} from './rig-spatial.mjs';

/** Make 3D (docs/PSEUDO-3D-PLAN.md): turn a flat stick definition into
 * spatial bones of the existing rig engine, so Rotate figure, Turn / tilt,
 * perspective and the depth key work on it. Nothing new is rendered or saved:
 * the result is ordinary `_stykRig.spatial` definition data.
 *
 * Every bone keeps its segment ID, shape, colors and rest pose. At turn 0 the
 * figure looks and poses exactly as before. Depth comes from paint order
 * ("layered"): earlier parts sit further back, later parts further forward.
 *
 * Figure rotation is measured from segment 0, so a hidden zero-length
 * "Figure rotation" joint is inserted first, as in the engine's own spatial
 * fixtures. It is itself the root 3D bone, driven by the Figure turn/tilt
 * pair, and every original root part hangs from it, so turning it turns the
 * whole figure rigidly. Controls are hidden static joints on the figure origin
 * (a bone can't own the controls that drive it).
 * Other bones share one Rest pair unless they are free 3D joints, which get
 * their own pair: posing a bone in 3D writes its controls, so sharing bones
 * would turn together (tests/spatial-shared-controls.test.mjs). */

export const FREE_JOINT_NAME = /\b(neck|head|shoulder|upper ?arm|arm|elbow|fore ?arm|hand|wrist|hip|thigh|upper ?leg|leg|knee|shin|lower ?leg|foot|ankle|chest|torso|spine|waist)\b/i;
const CONTROL_NAMES = {figureTurn: 'Figure turn', figureTilt: 'Figure tilt', restTurn: 'Rest turn', restTilt: 'Rest tilt'};

/** Why a definition can't be converted, as a message key, or null. */
export function make3DRefusal(figure) {
  if (!figure?.segments?.length) return 'errors.spatialConvert.selectAFigureToMake3D';
  if (isMovieclip(figure) || drawingMetadata(figure)) return 'errors.spatialConvert.movieclipsAndDrawingsCannotBeMade3D';
  if (figure.segments.some(s => spatialBone(s) || s._stykRig?.spatial)) return 'errors.spatialConvert.thisFigureIsAlready3D';
  if (figure.segments.some(s => s._stykRig)) return 'errors.spatialConvert.removeRigRelationshipsBeforeMaking3D';
  if (figure._styk?.spatialMesh) return 'errors.spatialConvert.thisFigureIsAlready3D';
  if (figure._styk?.animationOrigin) return 'errors.spatialConvert.resetTheAnimationOriginBeforeMaking3D';
  if (figure.segments.length * 3 + 5 > 30000) return 'errors.spatialConvert.thisFigureHasTooManyPartsToMake3D';
  return null;
}

/** Rest start/end of every segment in figure space (definition angles are
 * absolute). A bent segment ends where its native arc ends: on the chord
 * turned bend/2 from its angle, shortened by sinc(bend/2). */
export function restPositions(figure) {
  const byId = new Map(figure.segments.map((s, i) => [s.segment_id, i])), ends = new Map([[0, {x: 0, y: 0}]]), out = new Array(figure.segments.length);
  const end = (id, trail = new Set()) => {
    if (ends.has(id)) return ends.get(id);
    const i = byId.get(id);
    if (i === undefined || trail.has(id)) return {x: 0, y: 0};
    trail.add(id);
    const s = figure.segments[i], start = end(s.parent_id ?? 0, trail), bend = Number(s.bend_rad ?? 0);
    const angle = Number(s.angle_rad ?? 0) + bend / 2, length = Number(s.length ?? 0) * chordScale(bend);
    const tip = {x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle)};
    ends.set(id, tip); out[i] = {start, end: tip};
    return tip;
  };
  figure.segments.forEach(s => end(s.segment_id));
  return out;
}

/** Joint depth from paint order: rank of z_order, centred on 0, spread over
 * `depth` × the figure's largest rest extent. */
export function layeredDepth(figure, positions, depth = 0.2) {
  const xs = [], ys = [];
  for (const p of positions) xs.push(p.start.x, p.end.x), ys.push(p.start.y, p.end.y);
  const extent = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const order = figure.segments.map((s, i) => [Number.isFinite(s.z_order) ? s.z_order : i + 1, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = order.length, step = n > 1 ? extent * depth / (n - 1) : 0, z = new Map([[0, 0]]);
  // Pivot draws later parts on top, so they face the viewer: +Z is toward the camera here.
  order.forEach(([, i], rank) => z.set(figure.segments[i].segment_id, (rank - (n - 1) / 2) * step));
  return z;
}

/** Bones that get their own turn/tilt pair by default. */
export function suggestedFreeJoints(figure) {
  const children = new Map();
  for (const s of figure.segments) children.set(s.parent_id ?? 0, (children.get(s.parent_id ?? 0) ?? 0) + 1);
  return new Set(figure.segments.filter(s => (children.get(s.parent_id ?? 0) ?? 0) >= 2 || FREE_JOINT_NAME.test(String(s.name ?? ''))).map(s => s.segment_id));
}

/**
 * The 3D definition. Returns {figure, rotation, added, controls}: `rotation`
 * is the joint inserted at index 0 and `added` the controls appended in order.
 * Callers extend every instance with `angle_rad` + that instance's current
 * figure rotation for each new joint (see make3DPose).
 */
export function make3DDefinition(source, {depth = 0.2, freeJoints, depths} = {}) {
  const refusal = make3DRefusal(source);
  if (refusal) throw messageError(new Error(''), refusal, {});
  if (!Number.isFinite(depth) || depth < 0 || depth > 5) throw messageError(new Error(''), 'errors.spatialConvert.chooseADepthBetween0And5', {});
  const figure = structuredClone(source), positions = restPositions(figure);
  // `depths` (joint ID → Z, toward the camera) replaces the layered guess, e.g. from a side view.
  const z = depths ? new Map([[0, 0], ...[...depths].filter(([, v]) => Number.isFinite(v))]) : layeredDepth(figure, positions, depth);
  if (depths) for (const s of figure.segments) if (!z.has(s.segment_id)) z.set(s.segment_id, z.get(s.parent_id ?? 0) ?? 0);
  const free = freeJoints ? new Set(freeJoints) : suggestedFreeJoints(figure);
  let next = Math.max(0, ...figure.segments.map(s => s.segment_id)) + 1, order = Math.max(0, ...figure.segments.map((s, i) => Number.isFinite(s.z_order) ? s.z_order : i + 1));
  if (next + figure.segments.length * 2 + 5 > 65535) throw messageError(new Error(''), 'errors.spatialConvert.thisFigureHasTooManyPartsToMake3D', {});
  const rotation = {segment_id: next++, parent_id: 0, length: 0, angle_rad: 0, bend_rad: 0, thickness: 0,
    primitive_code: 0, aux_code: 1, flags: 256, is_static: true, segment_type: 'line', segment_kind: 'line',
    color_rgb: [13, 153, 255], transparency: 0, visible: false, z_order: 0, name: 'Figure rotation'};
  const added = [];
  const control = name => {
    const segment = {segment_id: next++, parent_id: 0, length: 0, angle_rad: 0, bend_rad: 0, thickness: 0,
      primitive_code: 0, aux_code: 1, flags: 256, is_static: true, segment_type: 'line', segment_kind: 'line',
      color_rgb: [13, 153, 255], transparency: 0, visible: false, z_order: ++order, name};
    added.push(segment); return segment.segment_id;
  };
  const ratios = new Array(figure.segments.length).fill(1);
  const controls = Object.fromEntries(Object.entries(CONTROL_NAMES).map(([key, name]) => [key, control(name)]));
  rotation._stykRig = {spatial: {parent: 0, origin: [0, 0, 0], tip: [0, 0, 0], turn: controls.figureTurn, pitch: controls.figureTilt}};
  figure.segments.forEach((s, i) => {
    const parent = s.parent_id ?? 0, p = positions[i];
    let turn = controls.restTurn, pitch = controls.restTilt;
    if (free.has(s.segment_id)) {
      const label = String(s.name || `Joint ${s.segment_id}`).slice(0, 200);
      turn = control(`${label} turn`); pitch = control(`${label} tilt`);
    }
    const origin = [p.start.x, p.start.y, z.get(parent) ?? 0], tip = [p.end.x, p.end.y, z.get(s.segment_id)];
    // `curve` makes the engine follow native bends (chord direction and length) and draw the arc.
    s._stykRig = {spatial: {parent: parent || rotation.segment_id, origin, tip, turn, pitch, curve: true}};
    // Stretch is chord length / rest chord, and a bone leaning in depth has a
    // longer 3D chord: scale the length channel so it keeps its exact
    // projected length at turn 0.
    const flat = Math.hypot(p.end.x - p.start.x, p.end.y - p.start.y), full = Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
    ratios[i] = flat > 1e-9 ? full / flat : 1;
    if (Math.abs(Number(s.length ?? 0)) > 1e-9) s.length = Number(s.length) * ratios[i];
  });
  figure.segments.unshift(rotation); figure.segments.push(...added);
  figure.segment_count = figure.segments.length;
  return {figure, rotation, added, controls, ratios};
}

/** An instance's pose for the 3D definition: the same joints, with the
 * rotation joint first and the controls last, all at zero turn. */
export function make3DPose(object, source, {added, ratios}) {
  const rotation = Number(object.angles?.[0] ?? 0) - Number(source.segments[0]?.angle_rad ?? 0);
  object.angles = [rotation, ...object.angles, ...added.map(s => s.angle_rad + rotation)];
  if (object.len_flag) object.lengths = [0, ...object.lengths.map((v, i) => v * (ratios?.[i] ?? 1)), ...added.map(() => 0)];
  if (object.bend_flag) object.bends = [0, ...object.bends, ...added.map(() => 0)];
  delete object.runtime_segments;
  return object;
}

/** Bones whose turn/tilt controls are also used by another bone. */
export function sharedControlBones(figure) {
  const uses = new Map();
  for (const s of figure?.segments ?? []) {
    const r = s._stykRig?.spatial;
    if (!r?.origin || r.motion) continue;
    for (const id of [r.turn, r.pitch]) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return new Set((figure?.segments ?? []).filter(s => {
    const r = s._stykRig?.spatial;
    return r?.origin && !r.motion && r.parent && (uses.get(r.turn) > 1 || uses.get(r.pitch) > 1);
  }).map(s => s.segment_id));
}

/** Give one bone its own turn/tilt pair: {figure, added}. */
export function freeJointDefinition(source, segmentId) {
  const figure = structuredClone(source), s = figure.segments.find(v => v.segment_id === segmentId);
  if (!s || !sharedControlBones(figure).has(segmentId)) throw messageError(new Error(''), 'errors.spatialConvert.thisJointAlreadyTurnsFreelyIn3D', {});
  let next = Math.max(0, ...figure.segments.map(v => v.segment_id)) + 1, order = Math.max(0, ...figure.segments.map((v, i) => Number.isFinite(v.z_order) ? v.z_order : i + 1));
  const rest = figure.segments.find(v => v.segment_id === s._stykRig.spatial.turn), label = String(s.name || `Joint ${segmentId}`).slice(0, 200);
  const added = ['turn', 'tilt'].map(kind => ({...structuredClone(rest), segment_id: next++, angle_rad: 0, z_order: ++order, name: `${label} ${kind}`}));
  s._stykRig = {...s._stykRig, spatial: {...s._stykRig.spatial, turn: added[0].segment_id, pitch: added[1].segment_id}};
  figure.segments.push(...added); figure.segment_count = figure.segments.length;
  return {figure, added};
}
