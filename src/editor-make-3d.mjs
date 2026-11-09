import {messageError} from './localized-error.mjs';
/** Make 3D and Free 3D joint commands (docs/PSEUDO-3D-PLAN.md). Both are one
 * topology edit: the definition and every instance's pose change together, in
 * every frame and frame source, and undo restores both exactly. */
import {make3DRefusal, make3DDefinition, make3DPose, sharedControlBones, freeJointDefinition} from './spatial-convert.mjs';
import {layerLocked} from './layers.mjs';
import {assemblySlots, layeredAssemblyDepths, sideViewAssemblyDepths, relativeDepths} from './spatial-convert-group.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {validateScene} from './pivot/model.mjs';
import {snapshotFigureDefinition} from './movieclips.mjs';

const clone = value => structuredClone(value);

/** The piece's current on-screen pose as a definition: rest = pose, so its
 * figure rotation is 0 and it turns about the same screen axes as every other
 * piece of the assembly. */
function bakedDefinition(figure, object, typeId) {
  const baked = snapshotFigureDefinition(figure);
  baked.figure_type_id = typeId;
  baked.segments = baked.segments.map((s, i) => ({...s,
    angle_rad: Number(object.angles?.[i] ?? s.angle_rad ?? 0),
    length: Number(object.len_flag ? object.lengths?.[i] ?? s.length : s.length),
    bend_rad: Number(object.bend_flag ? object.bends?.[i] ?? s.bend_rad ?? 0 : s.bend_rad ?? 0)}));
  return baked;
}

function instances(editor, typeId) {
  const list = [];
  for (const frame of editor._allSourceFrames()) for (const object of frame.objects) if (object.figure_type_id === typeId) list.push(object);
  return list;
}

export const editorMake3DMethods = {
  /** Message key explaining why the selected figure can't be made 3D, or null. */
  make3DRefusal() {
    if (!this.object || !this.figure) return 'errors.spatialConvert.selectAFigureToMake3D';
    if (this.report._styk?.movieclipSource) return 'errors.spatialConvert.movieclipsAndDrawingsCannotBeMade3D';
    if (this._frameDraftEnabled || this.report._styk?.simpleFrameDraft) return 'errors.spatialConvert.updateOrDiscardTheWorkingFrameFirst';
    if (layerLocked(this.report, this.object.unique_id)) return 'errors.spatialConvert.unlockTheFigureBeforeMakingIt3D';
    // IK no longer refuses: Make 3D switches it off (3D joints pose by turn and tilt instead), in the same undo step.
    return make3DRefusal(this.figure) ?? null;
  },
  canMakeFigure3D() { return !this.make3DRefusal(); },

  /** Convert the selected figure's definition (every instance) into a 3D rig
   * that looks and poses exactly as before at turn 0. */
  makeFigure3D({depth = 0.2, freeJoints} = {}) {
    if (this._drag) this.commitDrag();
    const refusal = this.make3DRefusal();
    if (refusal) throw messageError(new Error(''), refusal, {});
    const source = this.figure, typeId = source.figure_type_id, selected = source.segments[this.selectedJoint]?.segment_id;
    const result = make3DDefinition(source, {depth, freeJoints});
    const hadIK = instances(this, typeId).some(o => Object.values(o._stykIK ?? {}).some(c => c?.enabled));
    this._topologyEdit('Make 3D', next => {
      const flat = structuredClone(next);
      for (const key of Object.keys(next)) delete next[key];
      Object.assign(next, result.figure, {figure_type_id: typeId});
      for (const object of instances(this, typeId)) { make3DPose(object, flat, result); delete object._stykIK; }
      // Keep the same joint selected; indices moved by the inserted rotation joint.
      const index = next.segments.findIndex(s => s.segment_id === selected);
      this.selectedJoint = index < 0 ? 1 : index;
    });
    return {ikRemoved: hadIK, controls: result.controls, free: result.figure.segments.filter(s => {
      const r = s._stykRig?.spatial;
      return r?.parent && r.turn !== result.controls.restTurn;
    }).map(s => s.segment_id)};
  },

  /** True when the selected 3D joint shares its turn/tilt controls. */
  canMakeFree3DJoint() {
    const s = this.figure?.segments[this.selectedJoint];
    return Boolean(s && !layerLocked(this.report, this.object?.unique_id) && sharedControlBones(this.figure).has(s.segment_id));
  },

  /** Give the selected 3D joint its own turn/tilt so it can be posed in depth. */
  makeFree3DJoint() {
    if (this._drag) this.commitDrag();
    const figure = this.figure, s = figure?.segments[this.selectedJoint];
    if (!s || !this.canMakeFree3DJoint()) throw messageError(new Error(''), 'errors.spatialConvert.thisJointAlreadyTurnsFreelyIn3D', {});
    const typeId = figure.figure_type_id, rest = figure.segments.findIndex(v => v.segment_id === s._stykRig.spatial.turn);
    const restTilt = figure.segments.findIndex(v => v.segment_id === s._stykRig.spatial.pitch);
    const result = freeJointDefinition(figure, s.segment_id), bone = result.figure.segments[this.selectedJoint];
    this._topologyEdit('Make free 3D joint', next => {
      next.segments[this.selectedJoint] = bone;
      next.segments.push(...result.added);
      // The new pair starts where the shared pair is, so nothing moves.
      for (const object of instances(this, typeId)) {
        object.angles.push(object.angles[rest], object.angles[restTilt]);
        if (object.len_flag) object.lengths.push(0, 0);
        if (object.bend_flag) object.bends.push(0, 0);
        delete object.runtime_segments;
      }
    }, {appendOnly: false});
    return true;
  },
};

Object.assign(editorMake3DMethods, {
  /** The whole joined assembly around the selected figure, in this frame: {slots, refusal}. */
  assembly3D() {
    if (!this.object) return {slots: [], refusal: 'errors.spatialConvert.selectAFigureToMake3D'};
    const frame = this.frame, slots = assemblySlots(frame, this.object.unique_id);
    const report = this.report, types = new Map(report.figure_types.map(f => [f.figure_type_id, f]));
    if (report._styk?.movieclipSource || report._styk?.layerSheet || report._styk?.frameSources && Object.keys(report._styk.frameSources).length)
      return {slots, refusal: 'errors.spatialConvert.groupMake3DNeedsAPlainKeyframeAnimation'};
    if (this._frameDraftEnabled || report._styk?.simpleFrameDraft) return {slots, refusal: 'errors.spatialConvert.updateOrDiscardTheWorkingFrameFirst'};
    for (const slot of slots) {
      const object = frame.objects[slot], refusal = make3DRefusal(types.get(object.figure_type_id));
      if (refusal) return {slots, refusal};
      if (layerLocked(report, object.unique_id)) return {slots, refusal: 'errors.spatialConvert.unlockTheFigureBeforeMakingIt3D'};
    }
    return {slots, refusal: null};
  },
  canMakeGroup3D() { const a = this.assembly3D(); return !a.refusal && a.slots.length > 1; },

  /**
   * Make the whole joined assembly 3D in this frame. Each piece gets its own
   * definition baked from its current pose, so all pieces turn about the same
   * axes; joins, IDs and the look at turn 0 are kept. Depth comes from paint
   * order, or from `sideFrame` (a keyframe index showing the same assembly
   * from the side, as in a turnaround). One undo step.
   */
  makeGroup3D({sideFrame = null, depth = 0.2} = {}) {
    if (this._drag) this.commitDrag();
    const {slots, refusal} = this.assembly3D();
    if (refusal) throw messageError(new Error(''), refusal, {});
    const report = this.report, index = this.frameIndex, frame = this.frame, geometry = buildGeometry(report, frame);
    let absolute, info = {matched: 0, total: slots.length, facing: 1, source: 'layers'};
    if (sideFrame !== null && sideFrame !== undefined) {
      const other = report.keyframes[sideFrame];
      if (!other || sideFrame === index) throw messageError(new Error(''), 'errors.spatialConvert.chooseAnotherFrameShowingTheSideView', {});
      const side = sideViewAssemblyDepths(report, frame, slots, other, {geometry});
      if (!side.depths || !side.matched) throw messageError(new Error(''), 'errors.spatialConvert.theSideViewFrameHasNoMatchingParts', {});
      absolute = side.depths; info = {matched: side.matched, total: side.total, facing: side.facing, source: 'side'};
    } else absolute = layeredAssemblyDepths(report, frame, slots, {depth, geometry});
    const relative = relativeDepths(absolute), types = new Map(report.figure_types.map(f => [f.figure_type_id, f]));
    const uids = new Set(slots.map(slot => frame.objects[slot].unique_id));
    const touched = report.keyframes.flatMap((k, i) => i === index || k.objects.some(o => uids.has(o.unique_id)) ? [i] : []);
    const before = new Map(touched.map(i => [i, clone(report.keyframes[i])])), figureIndex = report.figure_types.length;
    let nextType = Math.max(0, ...report.figure_types.map(f => f.figure_type_id)) + 1;
    const definitions = [], beforeSelection = this._selectionState(), rootUid = frame.objects[slots[0]].unique_id;
    let ikRemoved = false;
    try {
      for (const slot of slots) {
        const object = frame.objects[slot], figure = types.get(object.figure_type_id);
        const baked = bakedDefinition(figure, object, nextType++), result = make3DDefinition(baked, {depths: relative.get(slot)});
        result.figure.name = String(figure.name || 'Figure').slice(0, 250) + ' 3D';
        definitions.push(result.figure);
        for (const i of touched) for (const o of report.keyframes[i].objects) if (o.unique_id === object.unique_id) {
          // Keep every frame's own lengths and bends, which used to come from the old definition.
          if (!o.len_flag) { o.lengths = figure.segments.map(s => s.length); o.len_flag = 1; }
          if (!o.bend_flag) { o.bends = figure.segments.map(s => s.bend_rad ?? 0); o.bend_flag = 1; }
          // In this frame the pose is the rest pose, drawn unmirrored, so the piece turns with the others.
          if (i === index) o.image_text_flags = 0;
          o.figure_type_id = baked.figure_type_id;
          if (Object.values(o._stykIK ?? {}).some(c => c?.enabled)) ikRemoved = true;
          delete o._stykIK;
          make3DPose(o, baked, result);
        }
      }
      report.figure_types.push(...definitions);
      validateScene({...report, keyframes: this._allSourceFrames()});
    } catch (error) {
      report.figure_types.splice(figureIndex);
      for (const [i, k] of before) report.keyframes[i] = k;
      this._invalidate(); throw error;
    }
    this.movieclipBatch('Make 3D group', () => {
      touched.forEach((i, n) => this._record({kind: 'frame', label: 'Make 3D group', index: i, before: before.get(i), after: clone(report.keyframes[i]),
        ...(n === 0 ? {figureDefinitionSplice: {index: figureIndex, figures: definitions.map(snapshotFigureDefinition)}} : {}),
        beforeSelection, afterSelection: beforeSelection, structural: true, timing: false}));
      this._invalidate();
      // Select the assembly's root at its Figure rotation joint: Rotate figure turns everything.
      this._selectIds([rootUid]); this.selectedJoint = 0;
    }, {beforeSelection});
    return {pieces: slots.length, ikRemoved, ...info};
  },
});

/** Guard for 3D posing: a bone sharing its turn/tilt controls with other bones
 * may only bend in its own plane. Returns true when turn/tilt must be kept. */
export function keepsSharedControls(figure, index) {
  const s = figure?.segments[index];
  return Boolean(s && sharedControlBones(figure).has(s.segment_id));
}

/** The Figure rotation bone Make 3D inserts first: {turn, tilt} segment indices, or null. */
export function figureRotation3D(figure) {
  const s = figure?.segments[0], r = s?._stykRig?.spatial;
  if (!r?.origin || r.parent || r.bindings || Math.abs(Number(s.length ?? 0)) > 1e-9) return null;
  const turn = figure.segments.findIndex(v => v.segment_id === r.turn), tilt = figure.segments.findIndex(v => v.segment_id === r.pitch);
  return turn < 0 || tilt < 0 ? null : {turn, tilt};
}

/** Apply a whole-figure turn/tilt (figure-space deltas of `owner`) to every 3D
 * piece joined below it in the current drag, so the assembly turns as one.
 * Yaw is the same in every piece; tilt follows each piece's reflection. */
export function turnJoinedPieces3D(editor, owner, turn, tilt) {
  if (!editor._drag || (!turn && !tilt)) return;
  const frame = editor.frame, types = new Map(editor.report.figure_types.map(f => [f.figure_type_id, f])), own = owner.image_text_flags ? -1 : 1;
  for (const before of editor._drag.before) {
    if (before.unique_id === owner.unique_id) continue;
    const object = frame.objects.find(o => o.unique_id === before.unique_id), controls = object && figureRotation3D(types.get(object.figure_type_id));
    if (!controls) continue;
    const sign = object.image_text_flags ? -1 : 1;
    object.angles = object.angles.slice();
    object.angles[controls.turn] += turn * sign;
    object.angles[controls.tilt] += tilt * own;
    delete object.runtime_segments;
  }
}
