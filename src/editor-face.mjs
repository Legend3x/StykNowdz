// Editor commands for a figure's 2D face (see docs/FACE-RIG.md).
// A face's values live on the posed object as `_stykFace`: per feature, a
// state index `s`, a look `x`/`y`, a brow `r`/`a` and an extra's opacity `o`.
// They key and tween like the rest of the pose.
import {readFace, readFaceValues, featureValue, drawingsOf} from './face-rig.mjs';

/** The face the selected (or given) object's figure carries, or null. */
function faceOf(editor, object = editor.object) {
  const figure = object && editor.report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
  return figure?._styk?.spatialMesh?.face ?? null;
}

const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

export const editorFaceMethods = {
  /** The selected figure's face definition, or null. */
  get face() { return faceOf(this); },
  /** The face values shown now (tweened), every feature spelled out. */
  faceValues(object = this.evaluatedFrame?.objects.find(o => o.unique_id === this.selectedUid)) {
    const face = faceOf(this, object); if (!face) return null;
    return Object.fromEntries(face.features.map(f => [f.id, featureValue(face, f, object?._stykFace?.[f.id])]));
  },
  /**
   * Change some face values on the selected figure: `{eyeL: {s: 2}, mouth: {x: .1}}`.
   * `linked` mirrors each change onto features that mirror (or are mirrored by)
   * the changed one, with the look's x reversed so both eyes look the same way.
   * Inside beginDrag/commitDrag a whole drag is one undo step.
   */
  setFaceValues(patch, {label = 'Face', linked = false} = {}) {
    const face = faceOf(this); if (!face || !patch) return false;
    const changes = {...patch};
    if (linked) for (const [id, v] of Object.entries(patch)) {
      const feature = face.features.find(f => f.id === id); if (!feature) continue;
      const source = drawingsOf(face, feature);
      for (const other of face.features) {
        if (other === feature || other.id in patch || drawingsOf(face, other) !== source || other.kind !== feature.kind) continue;
        changes[other.id] = {...v}; // the composer turns a flipped look, so equal values look the same way
      }
    }
    const current = this.object?._stykFace ?? {}, next = {...current};
    for (const [id, v] of Object.entries(changes)) next[id] = {...current[id], ...v};
    const clean = readFaceValues(face, next) ?? {};
    if (same(clean, current)) return false;
    return this._objectEdit(label, object => { if (Object.keys(clean).length) object._stykFace = clean; else delete object._stykFace; });
  },
  /**
   * Blink: each eye in `closed` ([feature id, closed state]) closed at the
   * playhead and back to its state two frames on, keyed at both (as auto key
   * would). The playhead stays where it was.
   */
  blinkFace(closed, frames = 2) {
    const face = faceOf(this), uid = this.selectedUid; if (!face || !this.object || !closed.length) return false;
    const shown = this.faceValues(), tick = this.tick, auto = this.autoKey;
    const shut = Object.fromEntries(closed.map(([id, s]) => [id, {s}])), back = Object.fromEntries(closed.map(([id]) => [id, {s: shown[id]?.s ?? 0}]));
    let changed = false;
    try {
      this.autoKey = true;
      changed = this.setFaceValues(shut, {label: 'Blink'});
      this.seek(tick + frames, {allowBeyondEnd: true}); this.select(uid);
      changed = this.setFaceValues(back, {label: 'Blink'}) || changed;
    } finally { this.autoKey = auto; this.seek(tick); this.select(uid); }
    return changed;
  },
  /** Put the face back to rest. */
  resetFace() { const face = faceOf(this); if (!face || !this.object?._stykFace) return false; return this._objectEdit('Reset face', object => { delete object._stykFace; }); },
};
