import {rigControlIsFace,rigFaceShown,setRigFaceShown} from './rig-control-details.mjs';

/** Face badges: a figure whose rig has face controls (a Blender lite face rig)
 * shows a small face icon at its head. Its face joints stay hidden, so the head
 * isn't crowded, until the badge is clicked; clicking again hides them. Like the
 * Show / hide joints setting, this is presentation only: it never changes the
 * pose or the figure, and is not an undo step. */
const RADIUS = 9, OFFSET = {x: 15, y: -15};
const segmentId = segment => Number(segment.seg?.segment_id ?? segment.id ?? segment.index + 1);

/** Where each figure's badge sits on screen: beside the joint its face controls hang from. */
export function faceBadges(editor, project, {hidden} = {}) {
  const out = [];
  for (const g of editor?.geometry?.objects?.values?.() ?? []) {
    const uid = g?.obj?.unique_id;
    if (!g?.segments?.length || hidden?.has?.(uid)) continue;
    const face = g.segments.find(s => rigControlIsFace(s.seg));
    if (!face) continue;
    const byId = new Map(g.segments.map(s => [segmentId(s), s]));
    // The first non-face joint above the face controls (the head).
    let anchor = byId.get(Number(face.seg.parent_id)), guard = 0;
    while (anchor && rigControlIsFace(anchor.seg) && guard++ < 64) anchor = byId.get(Number(anchor.seg.parent_id));
    const point = anchor ? anchor.handle ?? anchor.end : face.start ?? face.handle ?? face.end;
    if (!point) continue;
    const at = project(point);
    if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) continue;
    out.push({uid, x: at.x + OFFSET.x, y: at.y + OFFSET.y, shown: rigFaceShown(editor, uid)});
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
