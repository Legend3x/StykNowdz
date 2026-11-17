// Squash and stretch for 3D figures (docs/SQUASH-STRETCH.md): the whole
// figure (`_stykSquash`, squash.mjs) or one part, with or without the parts
// below it (the rig's own length and width, so the pose stays editable).
// Both keep the volume: stretching by k thins across by 1/√k.
import {messageError} from './localized-error.mjs';
import {readSquash, squashValues, SQUASH_MIN, SQUASH_MAX} from './squash.mjs';
import {spatialShape, validateSpatialPose} from './spatial-projection.mjs';
import {spatialBone} from './rig-spatial.mjs';

const WIDTH_MIN = .1, WIDTH_MAX = 5;
/** The bones a part squash moves: the selected bone, and with `below` every bone under it. */
function partBones(figure, index, below) {
  const ids = new Set([figure.segments[index].segment_id]);
  if (below) { let grew = true; while (grew) { grew = false; for (const s of figure.segments) if (spatialBone(s) && ids.has(s._stykRig.spatial.parent) && !ids.has(s.segment_id)) { ids.add(s.segment_id); grew = true; } } }
  return ids;
}

export const editorSquashMethods = {
  /** The selected figure's whole-figure squash ({amount, angle, from}), or null for a figure without 3D bones. */
  getSquash() { return this.object && this.figure?.segments.some(spatialBone) ? squashValues(this.object) : null; },
  /** Change the whole-figure squash: {amount} (1 is none), {angle} in degrees from up and down, {from} 0 bottom … 1 top. */
  setSquash(patch, {label = 'Squash and stretch'} = {}) {
    const before = this.getSquash(); if (!before) return false;
    const next = readSquash({...before, ...patch});
    if (JSON.stringify(next) === JSON.stringify(readSquash(this.object._stykSquash))) return false;
    return this._objectEdit(label, o => { if (next) o._stykSquash = next; else delete o._stykSquash; delete o.runtime_segments; });
  },
  resetSquash() { return this.setSquash({amount: 1}, {label: 'Reset squash and stretch'}); },
  /** The selected part's stretch (its length against the figure's), or null when it can't stretch. */
  getPartSquash() {
    const f = this.figure, i = this.selectedJoint, s = f?.segments[i];
    if (!this.object || !spatialBone(s) || !(s.length > 1e-9)) return null;
    return {amount: (this.object.len_flag ? this.object.lengths[i] : s.length) / s.length, name: s.name};
  },
  /** Stretch (above 1) or squash (below 1) the selected part to `amount`, keeping its
   * volume; `below` takes the parts under it along, each by the same factor. */
  setPartSquash(amount, {below = false, label = 'Squash and stretch part'} = {}) {
    const before = this.getPartSquash(); if (!before) return false;
    if (!Number.isFinite(amount) || amount < SQUASH_MIN || amount > SQUASH_MAX) throw messageError(new Error(''), "errors.editorSquash.outOfRange", {min: SQUASH_MIN, max: SQUASH_MAX});
    const factor = amount / before.amount; if (Math.abs(factor - 1) < 1e-9) return false;
    const f = this.figure, ids = partBones(f, this.selectedJoint, below), shape = {...this.object._stykSpatial?.shape};
    const lengths = this.object.len_flag ? this.object.lengths.slice() : f.segments.map(s => s.length);
    for (let i = 0; i < f.segments.length; i++) {
      const s = f.segments[i]; if (!ids.has(s.segment_id) || !(s.length > 1e-9)) continue;
      const current = spatialShape(this.object, s.segment_id), width = current.width / Math.sqrt(factor);
      lengths[i] *= factor;
      shape[s.segment_id] = {...current, width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width))};
    }
    const state = {...this.object._stykSpatial, shape}; validateSpatialPose({...this.object, _stykSpatial: state}, f);
    return this._objectEdit(label, o => { this._releaseSpatialChain(o); o._stykSpatial = state; o.lengths = lengths; o.len_flag = 1; delete o.runtime_segments; }, {posed: true});
  },
};
