import {rigControlIsFace,rigFaceShown,setRigFaceShown} from './rig-control-details.mjs';
import {poseChoiceGroups} from './rig-pose-choices.mjs';

/** Face badges: a figure whose rig has face controls (a 3D Nowdz face rig) or
 * swap choices (a 3D Nowdz face set: mouths, eyes) shows a small face icon at its
 * head. With swap choices, clicking it opens a menu to pick each set's choice
 * (a pose change, one undo step) and to show the face joints; with face joints
 * only, it shows or hides them. Showing joints is presentation only: it never
 * changes the pose or the figure, and is not an undo step. */
const RADIUS = 9, OFFSET = {x: 15, y: -15};
const segmentId = segment => Number(segment.seg?.segment_id ?? segment.id ?? segment.index + 1);
const onFace = seg => rigControlIsFace(seg) || Boolean(seg?._stykPoseChoice);

/** Where each figure's badge sits on screen: beside the joint its face controls hang from. */
export function faceBadges(editor, project, {hidden} = {}) {
  const out = [];
  for (const g of editor?.geometry?.objects?.values?.() ?? []) {
    const uid = g?.obj?.unique_id;
    if (!g?.segments?.length || hidden?.has?.(uid)) continue;
    const face = g.segments.find(s => onFace(s.seg));
    if (!face) continue;
    const byId = new Map(g.segments.map(s => [segmentId(s), s]));
    // The first non-face joint above the face controls (the head).
    let anchor = byId.get(Number(face.seg.parent_id)), guard = 0;
    while (anchor && onFace(anchor.seg) && guard++ < 64) anchor = byId.get(Number(anchor.seg.parent_id));
    const point = anchor ? anchor.handle ?? anchor.end : face.start ?? face.handle ?? face.end;
    if (!point) continue;
    const at = project(point);
    if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) continue;
    out.push({uid, x: at.x + OFFSET.x, y: at.y + OFFSET.y, shown: rigFaceShown(editor, uid), joints: g.segments.some(s => rigControlIsFace(s.seg)),
      choices: g.segments.some(s => s.seg?._stykPoseChoice)});
  }
  return out;
}

export function drawFaceBadges(ctx, editor, project, options) {
  const badges = faceBadges(editor, project, options);
  if (!badges.length) return;
  ctx.save();
  for (const {x, y, shown} of badges) {
    ctx.beginPath(); ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = shown ? '#0d99ff' : '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = shown ? '#ffffff' : '#0d99ff'; ctx.stroke();
    // A tiny face: two eyes and a smile.
    const ink = shown ? '#ffffff' : '#0d99ff';
    ctx.fillStyle = ink;
    for (const dx of [-3, 3]) { ctx.beginPath(); ctx.arc(x + dx, y - 2, 1.3, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, y + .5, 4, Math.PI * .2, Math.PI * .8); ctx.strokeStyle = ink; ctx.lineWidth = 1.4; ctx.stroke();
  }
  ctx.restore();
}

/** The badge under a screen point, if any. */
export function pickFaceBadge(editor, point, project, options) {
  return faceBadges(editor, project, options).find(b => Math.hypot(b.x - point.x, b.y - point.y) <= RADIUS + 3) ?? null;
}

export function toggleFaceControls(editor, uid) {
  const shown = !rigFaceShown(editor, uid);
  setRigFaceShown(editor, uid, shown);
  return shown;
}

/** The face badge's menu for a figure with swap choices: each set's choices (the
 * one showing checked), then showing the face joints when it has any. Picking a
 * choice selects the figure and changes its pose in this frame (one undo step). */
export function faceMenuItems(editor, uid, {text, changed = () => {}} = {}) {
  if (editor.selectedUid !== uid) editor.select(uid, -1);
  const groups = poseChoiceGroups(editor.figure, editor.object).filter(g => g.kind === 'visibility'), items = [];
  for (const group of groups) {
    if (items.length) items.push(null);
    items.push({label: group.name});
    for (const choice of group.choices) items.push({label: choice.label, radio: true, group: group.name, checked: group.value === choice.id,
      run: () => { if (editor.selectedUid !== uid) editor.select(uid, -1); if (editor.setPoseChoice(group.name, choice.id)) changed(); }});
  }
  if (editor.figure?.segments.some(s => rigControlIsFace(s))) {
    const shown = rigFaceShown(editor, uid);
    items.push(null, {label: shown ? text?.('spatialControls.hideFaceJoints') ?? 'Hide face joints' : text?.('spatialControls.showFaceJoints') ?? 'Show face joints',
      labelKey: shown ? 'spatialControls.hideFaceJoints' : 'spatialControls.showFaceJoints', run: () => { setRigFaceShown(editor, uid, !shown); changed(); }});
  }
  return items;
}
