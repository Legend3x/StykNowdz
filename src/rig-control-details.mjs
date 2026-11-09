import {messageError} from './localized-error.mjs';

/** Handle detail is presentation metadata. The editor preference never becomes
 * a pose channel, changes a figure definition, or enters undo history. */
const details = new WeakMap();
export const rigControlIsDetail = segment => segment?._stykControl?.level === 'detail';
export const rigDetailsShown = editor => details.get(editor) === true;
export function setRigDetailsShown(editor, shown) { details.set(editor, Boolean(shown)); }

/** Face controls (a face rig's bones) are hidden per figure until its face badge
 * opens them; like details, this is presentation only and never a pose channel. */
const faces = new WeakMap(), NONE = new Set();
export const rigControlIsFace = segment => segment?._stykControl?.level === 'face';
export const rigFaceShownUids = editor => faces.get(editor) ?? NONE;
export const rigFaceShown = (editor, uid) => rigFaceShownUids(editor).has(uid);
export function setRigFaceShown(editor, uid, shown) {
  const next = new Set(rigFaceShownUids(editor));
  if (shown) next.add(uid); else next.delete(uid);
  faces.set(editor, next);
}

export function validateControlMetadata(segment) {
  const control = segment._stykControl;
  if (control === undefined) return;
  if (!control || typeof control !== 'object' || Array.isArray(control) ||
      Object.keys(control).some(key => key !== 'level') || !['detail', 'face'].includes(control.level))
    throw messageError(new Error(''), 'errors.rigConstraints.invalidRigBehavior', {});
}
