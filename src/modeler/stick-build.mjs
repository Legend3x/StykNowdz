// Build mode of 3D Nowdz: Styk Builder in 3D. Drag from a joint to draw a
// line of the chosen shape; drag on empty space to start a new piece; drag a
// joint with Move to reshape (what hangs below follows; Alt moves it alone).
// The selected line's shape is set in the panel. A piece's first joint snaps
// onto a joint of another piece with Attach. The sticks themselves and the
// parts and bones made from them are in sticks.mjs; this file is only the
// interaction and the panel, wired in by modeler-ui.mjs.

import * as K from './sticks.mjs';
import {segmentPixelDistance} from './viewport.mjs';

const SHAPE_TOOLS = K.STICK_SHAPES;
const ROOT_COLOR = '#ff8a00', JOINT_COLOR = '#1f6feb', LINE_COLOR = 'rgba(20,24,32,.75)', SELECTED = '#ff3b6b';

/**
 * ctx: {S, model(), frame(), commit(fn), refresh(), draw(), toast(text), t(key, params),
 *   el, section, field, actions, colorRow, segmented, screenToWorld(pt, through),
 *   snapshot(), restore(text), pushUndo(before), setStatus()}
 */
export function createStickBuild(ctx) {
  const {S, t, el, section, field, actions} = ctx;
  S.stick ??= {tool: 'capsule', line: null, joint: null, attachPick: null};
  const sticks = () => { const m = ctx.model(); m.sticks ??= K.emptySticks(); return m.sticks; };
  const regenerate = () => { K.generateSticks(ctx.model()); S.cache.clear(); };
  /** Change the sticks as one undo step, then rebuild their shapes. */
  const change = fn => ctx.commit(() => { fn(sticks()); regenerate(); });
  const project = p => ctx.frame().project(p);

  function pick(x, y) {
    const s = ctx.model().sticks; if (!s) return null;
    let best = null;
    for (const j of s.joints) {
      const q = project(j.at); if (!q.ok) continue;
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < 10 && (!best || d < best.d)) best = {joint: j.id, d};
    }
    if (best) return best;
    for (const l of s.lines) {
      const a = project(K.jointOf(s, l.from).at), b = project(K.jointOf(s, l.to).at); if (!a.ok || !b.ok) continue;
      const d = segmentPixelDistance({x, y}, a, b);
      if (d < 8 && (!best || d < best.d)) best = {line: l.id, d};
    }
    return best;
  }
  const select = hit => { S.stick.line = hit?.line ?? null; S.stick.joint = hit?.joint ?? null; };

  /** A press in the view: returns a drag ({move, up, cancel}) or null. */
  function press(p, e) {
    const hit = pick(p.x, p.y);
    if (S.stick.attachPick) {
      const piece = S.stick.attachPick; S.stick.attachPick = null;
      if (hit?.joint != null) {
        try { change(s => K.attachPiece(s, piece, hit.joint)); ctx.toast(t("modeler.stickAttached")); }
        catch (error) { ctx.toast(error.message); ctx.refresh(); }
      } else { ctx.toast(t("modeler.stickAttachCancelled")); ctx.refresh(); }
      return null;
    }
    const before = ctx.snapshot(), start = {...p};
    let live = null; // what the drag made or is moving
    const begin = () => {
      if (S.stick.tool === 'move') {
        if (hit?.joint == null) return null;
        const joint = K.jointOf(sticks(), hit.joint), piece = K.pieceOf(sticks(), joint.piece);
        // An attached piece's first joint sits on its joint: move that one.
        const id = piece?.root === joint.id && piece.attach != null ? piece.attach : joint.id;
        select({joint: id});
        return {kind: 'move', joint: id, through: K.jointOf(sticks(), id).at.slice()};
      }
      // Shape tools draw: from a joint, or from empty space as a new piece.
      const s = sticks();
      let from = hit?.joint ?? null;
      if (from == null && hit?.line != null) return null;
      if (from == null) { const piece = K.addPiece(s, {at: ctx.screenToWorld(start, ctx.S.camera.target)}); from = piece.root; }
      const through = K.jointOf(s, from).at.slice();
      const line = K.addLine(s, from, ctx.screenToWorld(p, through), {shape: shapeFor(S.stick.tool, s, from), color: S.stick.color ?? 1});
      select({line: line.id});
      return {kind: 'draw', line: line.id, joint: line.to, through};
    };
    return {
      move(q, ev) {
        if (!live && Math.hypot(q.x - start.x, q.y - start.y) < 4) return;
        if (!live) { live = begin(); if (!live) return; }
        K.moveJoint(sticks(), live.joint, ctx.screenToWorld(q, live.through), {alone: live.kind === 'move' && ev.altKey});
        regenerate(); ctx.draw();
      },
      up(q, ev) {
        if (!live) { select(hit); ctx.refresh(); return; }
        const s = sticks();
        if (live.kind === 'draw') {
          const l = K.lineOf(s, live.line), a = K.jointOf(s, l.from).at, b = K.jointOf(s, l.to).at;
          if (Math.hypot(...a.map((v, k) => v - b[k])) < 1e-4) { ctx.restore(before); return; }
        }
        regenerate(); ctx.pushUndo(before); ctx.refresh();
      },
      cancel() { if (live) ctx.restore(before); },
    };
  }

  /** A new line keeps the look of the line it grows from, in the chosen shape. */
  function shapeFor(kind, s, from) {
    const up = K.lineInto(s, from);
    const base = up ? {...up.shape, start: up.shape.end, bulge: 0, roll: 0, twist: 0} : {...K.SHAPE_DEFAULTS};
    if (kind === 'ribbon' && up?.shape.kind !== 'ribbon') Object.assign(base, {start: .05, end: .03, width: 1, depth: 1});
    if (up && up.color != null) S.stick.color ??= up.color;
    return {...base, kind};
  }

  function drawOverlay(c) {
    const s = ctx.model().sticks; if (!s) return;
    c.save(); c.lineCap = 'round';
    for (const l of s.lines) {
      const a = project(K.jointOf(s, l.from).at), b = project(K.jointOf(s, l.to).at); if (!a.ok || !b.ok) continue;
      const on = S.stick.line === l.id;
      c.strokeStyle = on ? SELECTED : LINE_COLOR; c.lineWidth = on ? 3 : 1.5; c.setLineDash(l.static ? [4, 3] : []);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    c.setLineDash([]);
    const roots = new Map(s.pieces.map(p => [p.root, p]));
    for (const j of s.joints) {
      const q = project(j.at); if (!q.ok) continue;
      const piece = roots.get(j.id), on = S.stick.joint === j.id;
      if (piece?.attach != null) continue; // drawn by the joint it sits on
      c.fillStyle = on ? SELECTED : piece ? ROOT_COLOR : JOINT_COLOR;
      c.beginPath(); c.arc(q.x, q.y, piece ? 5.5 : 4, 0, Math.PI * 2); c.fill();
      if (S.stick.attachPick) { c.strokeStyle = ROOT_COLOR; c.lineWidth = 1.5; c.beginPath(); c.arc(q.x, q.y, 8, 0, Math.PI * 2); c.stroke(); }
    }
    c.restore();
  }

  const shapeField = (line, key, label, options) => field(label, line.shape[key], v => change(s => { K.lineOf(s, line.id).shape = K.readShape({...line.shape, [key]: v}); }), options);

  function props() {
    const s = ctx.model().sticks, blocks = [];
    const line = s && S.stick.line != null ? K.lineOf(s, S.stick.line) : null;
    const joint = s && S.stick.joint != null ? K.jointOf(s, S.stick.joint) : null;
    blocks.push(section(t("modeler.stickBuild"), [
      ctx.segmented([['move', t("modeler.stickMove"), t("modeler.stickMoveHint")], ...SHAPE_TOOLS.map(k => [k, t(`modeler.stickShape.${k}`), t("modeler.stickDrawHint")])], S.stick.tool, k => { S.stick.tool = k; ctx.refresh(); }),
      el('p', {class: 'modeler-hint', text: s?.lines.length ? t("modeler.stickHint") : t("modeler.stickStartHint")})]));
    if (line) {
      const kind = line.shape.kind, ribbon = kind === 'ribbon', ball = kind === 'ball';
      blocks.push(section(t("modeler.stickLine"), [
        el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.name")}), el('input', {type: 'text', value: line.name, placeholder: t("modeler.stickLineName", {id: line.id}), maxlength: '80', onchange: e => change(st => { K.lineOf(st, line.id).name = e.target.value.trim(); })})]),
        el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: t("modeler.stickShape")}), el('select', {onchange: e => change(st => { K.lineOf(st, line.id).shape = K.readShape({...line.shape, kind: e.target.value}); })},
          SHAPE_TOOLS.map(k => el('option', {value: k, text: t(`modeler.stickShape.${k}`), selected: k === kind})))]),
        ball ? null : shapeField(line, 'start', ribbon ? t("modeler.stickHalfWidthStart") : t("modeler.stickThicknessStart"), {step: .005, min: .002}),
        ball ? null : shapeField(line, 'end', ribbon ? t("modeler.stickHalfWidthEnd") : t("modeler.stickThicknessEnd"), {step: .005, min: .002}),
        ball ? null : shapeField(line, 'bulge', ribbon ? t("modeler.stickCurl") : t("modeler.stickBulge"), {step: .05}),
        shapeField(line, 'width', t("modeler.stickWidth"), {step: .05, min: .05}),
        ribbon ? null : shapeField(line, 'depth', t("modeler.stickDepth"), {step: .05, min: .02}),
        shapeField(line, 'roll', t("modeler.stickRoll"), {step: 5}),
        ribbon ? shapeField(line, 'twist', t("modeler.stickTwist"), {step: 5}) : null,
        ctx.colorRow(line.color, i => { S.stick.color = i; change(st => { K.lineOf(st, line.id).color = i; }); }),
        el('label', {class: 'modeler-check', title: t("modeler.stickStaticHint")}, [el('input', {type: 'checkbox', checked: line.static, onchange: e => change(st => { K.lineOf(st, line.id).static = e.target.checked; })}), t("modeler.stickStatic")]),
        actions([[t("modeler.stickMirror"), () => mirror(line.id), t("modeler.stickMirrorHint")], [t("modeler.deleteSelected"), () => remove(), 'X']])]));
    }
    if (joint) {
      const piece = K.pieceOf(s, joint.piece), isRoot = piece?.root === joint.id;
      blocks.push(section(t("modeler.stickJoint"), [
        ctx.vector(t("modeler.position"), joint.at, (k, v) => change(st => { const at = K.jointOf(st, joint.id).at.slice(); at[k] = v; K.moveJoint(st, joint.id, at); })),
        el('p', {class: 'modeler-hint', text: isRoot ? t("modeler.stickRootHint") : t("modeler.stickJointHint")})]));
    }
    if (s?.pieces.length) {
      const current = joint ? joint.piece : line ? line.piece : null;
      blocks.push(section(t("modeler.stickPieces"), [
        ...s.pieces.map(p => {
          const on = p.id === current, attachedTo = p.attach != null ? K.jointOf(s, p.attach) : null;
          return el('div', {class: 'modeler-piece-row'}, [
            el('input', {type: 'text', value: p.name, maxlength: '80', 'aria-label': t("modeler.name"), onchange: e => change(st => { K.pieceOf(st, p.id).name = e.target.value.trim() || p.name; })}),
            ctx.button(on ? '●' : '○', () => { select({joint: p.root}); ctx.refresh(); }, {title: t("modeler.stickSelectPiece")}),
            p.attach != null
              ? ctx.button(t("modeler.stickDetach"), () => change(st => K.detachPiece(st, p.id)), {title: t("modeler.stickAttachedTo", {piece: K.pieceOf(s, attachedTo?.piece)?.name ?? ''})})
              : ctx.button(t("modeler.stickAttach"), () => { S.stick.attachPick = p.id; ctx.toast(t("modeler.stickPickJoint")); ctx.refresh(); }, {title: t("modeler.stickAttachHint")}),
            ctx.button('✕', () => change(st => { K.deletePiece(st, p.id); select(null); }), {title: t("modeler.stickDeletePiece")})]);
        }),
        el('p', {class: 'modeler-hint', text: t("modeler.stickPiecesHint")})]));
    }
    return blocks;
  }

  function mirror(id) {
    try { change(s => { const made = K.mirrorLines(s, id); if (made[0]) S.stick.line = made[0].id; }); }
    catch (error) { ctx.toast(error.message); }
  }
  function remove() {
    const s = ctx.model().sticks; if (!s) return false;
    if (S.stick.line != null) { const id = S.stick.line; change(st => K.deleteLine(st, id)); select(null); ctx.refresh(); return true; }
    if (S.stick.joint != null) {
      const joint = K.jointOf(s, S.stick.joint), piece = K.pieceOf(s, joint?.piece);
      if (piece?.root === joint.id) { change(st => K.deletePiece(st, piece.id)); select(null); ctx.refresh(); return true; }
      const into = K.lineInto(s, joint.id); if (into) { change(st => K.deleteLine(st, into.id)); select(null); ctx.refresh(); return true; }
    }
    return false;
  }

  /** Keys in Build mode; true when handled. */
  function keydown(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape' && S.stick.attachPick) { S.stick.attachPick = null; ctx.toast(t("modeler.stickAttachCancelled")); ctx.refresh(); return true; }
    if (key === 'Escape') { select(null); ctx.refresh(); return true; }
    if ((key === 'x' || key === 'Delete') && !e.ctrlKey && !e.metaKey) return remove();
    if (key === 'm' && !e.ctrlKey && !e.metaKey && S.stick.line != null) { mirror(S.stick.line); return true; }
    const tools = {v: 'move', '1': 'capsule', '2': 'tube', '3': 'box', '4': 'ball', '5': 'ribbon'};
    if (tools[key] && !e.ctrlKey && !e.metaKey && !e.altKey) { S.stick.tool = tools[key]; ctx.refresh(); return true; }
    return false;
  }

  /** Forget a selection the sticks no longer have (after undo). */
  function tidy() {
    const s = ctx.model().sticks;
    if (S.stick.line != null && !s?.lines.some(l => l.id === S.stick.line)) S.stick.line = null;
    if (S.stick.joint != null && !s?.joints.some(j => j.id === S.stick.joint)) S.stick.joint = null;
  }

  return {pick, press, drawOverlay, props, keydown, tidy, select, regenerate, remove};
}
