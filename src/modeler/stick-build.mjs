// Build mode of 3D Nowdz: Styk Builder in 3D, laid out like Build. A tool rail
// floats on the view (Select, Line, Circle, Poly fill, Pan, then Split,
// Duplicate, Flip H, Flip V, Delete), and the panel shows the picked line as
// Build's inspector does (Style, 3D, Geometry), with sliders.
//
// - Line and Circle: drag from a joint to draw; drag on empty space to start a new piece.
// - Select: click to pick; drag a joint to move it (what hangs below follows, Alt: alone).
// - Right-drag (or Alt+right-drag) a line to bend it, as in Build; on empty space it orbits.
// - Poly fill: click joints in turn, then the first again (or Enter), as Pivot's poly fill.
// - Head: click the front outline, then the side profile (two traced pieces): a head made to match both.
// - Guide lines (the rail's toggle): lines for tracing, with no shape and no bone.
// - Convert to mesh: a line's shape, a poly fill or a head becomes an ordinary part for Edit mode.
//
// The sticks and the parts and bones made from them are in sticks.mjs; this
// file is only the interaction and the panel, wired in by modeler-ui.mjs.

import * as K from './sticks.mjs';
import {segmentPixelDistance} from './viewport.mjs';

const ROOT_COLOR = '#ff8a00', JOINT_COLOR = '#1f6feb', LINE_COLOR = 'rgba(20,24,32,.75)', SELECTED = '#ff3b6b', FILL_LINE = 'rgba(255,59,107,.85)';
/** The rail's tools: [tool, icon, label key, key]. */
const TOOLS = [['select', 'cursor', "modeler.stickSelect", 'V'], ['line', 'line', "modeler.stickLineTool", 'L'], ['circle', 'circle', "modeler.stickCircleTool", 'C'],
  ['polygon', 'polygon', "modeler.stickPolyFill", 'P'], ['head', 'person', "modeler.stickHeadTool", 'E'], ['hand', 'hand', "modeler.stickPan", 'H']];
/** Actions on the picked line: [action, icon, label key]. */
const LINE_ACTIONS = [['split', 'builder-split', "modeler.stickSplit"], ['duplicate', 'duplicate', "modeler.stickDuplicate"], ['flipH', 'flip', "modeler.stickFlipH"],
  ['flipV', 'flip-vertical', "modeler.stickFlipV"], ['delete', 'trash', "modeler.stickDelete"]];
const ROUND_KINDS = new Set(['circle', 'circleFill', 'circleClear', 'ellipse', 'polygon']);
const GUIDE_COLOR = 'rgba(0,150,170,.9)', HEAD_PICK = '#ff8a00';

/**
 * ctx: {S, model(), frame(), commit(fn), refresh(), draw(), toast(text), t(key, params),
 *   el, section, glyph(icon), colorRow, button, screenToWorld(pt, through),
 *   snapshot(), restore(snap), pushUndo(before), editPart(id)}
 */
export function createStickBuild(ctx) {
  const {S, t, el, section} = ctx;
  S.stick ??= {tool: 'line', line: null, joint: null, fill: null, head: null, attachPick: null, fillDraft: null, headPick: null, guide: false, lineKind: 'line'};
  if (!TOOLS.some(([tool]) => tool === S.stick.tool)) S.stick.tool = 'line';
  const sticks = () => { const m = ctx.model(); m.sticks ??= K.emptySticks(); m.sticks.fills ??= []; return m.sticks; };
  const regenerate = () => { K.generateSticks(ctx.model()); S.cache.clear(); };
  /** Change the sticks as one undo step, then rebuild their shapes. */
  const change = fn => ctx.commit(() => { fn(sticks()); regenerate(); });
  const project = p => ctx.frame().project(p);
  const at = id => K.jointOf(ctx.model().sticks, id).at;

  // ---------- picking ----------
  /** Screen points along a line's path, so a bent line is picked and drawn where it is. */
  const screenPath = (l, steps) => { const path = K.linePath(at(l.from), at(l.to), l.shape); return Array.from({length: steps + 1}, (_, i) => project(path(i / steps))); };
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
      const pts = screenPath(l, K.CURVED_SHAPES.has(l.shape.kind) && l.shape.curve ? 8 : 1);
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i - 1].ok || !pts[i].ok) continue;
        const d = segmentPixelDistance({x, y}, pts[i - 1], pts[i]);
        if (d < 8 && (!best || d < best.d)) best = {line: l.id, d};
      }
    }
    if (best) return best;
    for (const f of s.fills ?? []) {
      const poly = f.joints.map(id => project(at(id)));
      if (poly.every(q => q.ok) && inside({x, y}, poly)) return {fill: f.id, d: 0};
    }
    for (const h of s.heads ?? []) {
      const part = ctx.model().parts.find(p => p.stick === h.id); if (!part) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of part.mesh.verts) { const q = project(v); if (!q.ok) continue; x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return {head: h.id, d: 0};
    }
    return null;
  }
  const inside = (p, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const select = hit => { S.stick.line = hit?.line ?? null; S.stick.joint = hit?.joint ?? null; S.stick.fill = hit?.fill ?? null; S.stick.head = hit?.head ?? null; };

  // ---------- pointer ----------
  /** A left press in the view: returns a drag ({move, up, cancel}) or null. */
  function press(p) {
    const hit = pick(p.x, p.y), tool = S.stick.tool;
    if (S.stick.attachPick) { attachTo(hit); return null; }
    if (tool === 'polygon') { fillClick(hit); return null; }
    if (tool === 'head') { headClick(hit); return null; }
    const before = ctx.snapshot(), start = {...p};
    let live = null; // what the drag made or is moving
    const begin = () => {
      if (tool === 'select') {
        if (hit?.joint == null) return null;
        const joint = K.jointOf(sticks(), hit.joint), piece = K.pieceOf(sticks(), joint.piece);
        // An attached piece's first joint sits on its joint: move that one.
        const id = piece?.root === joint.id && piece.attach != null ? piece.attach : joint.id;
        select({joint: id});
        return {kind: 'move', joint: id, through: at(id).slice()};
      }
      // Line and Circle draw: from a joint, or from empty space as a new piece.
      const s = sticks();
      let from = hit?.joint ?? null;
      if (from == null && hit?.line != null) return null;
      if (from == null) { const piece = K.addPiece(s, {at: ctx.screenToWorld(start, S.camera.target)}); from = piece.root; }
      const through = at(from).slice();
      const guide = S.stick.guide || Boolean(K.lineInto(s, from)?.guide);
      const line = K.addLine(s, from, ctx.screenToWorld(p, through), {shape: shapeFor(tool === 'circle' ? 'circleFill' : S.stick.lineKind, s, from), color: S.stick.color ?? 1, guide});
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
      up() {
        if (!live) { select(hit); ctx.refresh(); return; }
        if (live.kind === 'draw') {
          const l = K.lineOf(sticks(), live.line), a = at(l.from), b = at(l.to);
          if (Math.hypot(...a.map((v, k) => v - b[k])) < 1e-4) { ctx.restore(before); return; }
        }
        regenerate(); ctx.pushUndo(before); ctx.refresh();
      },
      cancel() { if (live) ctx.restore(before); },
    };
  }

  /** A right press (or Alt+right) on a line, or the joint it ends at: bend it,
   * as in Build. Null elsewhere, so the view orbits. */
  function bendPress(p) {
    const hit = pick(p.x, p.y), s = ctx.model().sticks;
    if (!s || S.mode !== 'build') return null;
    const line = hit?.line != null ? K.lineOf(s, hit.line) : hit?.joint != null ? K.lineInto(s, hit.joint) : null;
    if (!line) return null;
    if (!K.CURVED_SHAPES.has(line.shape.kind)) { ctx.toast(t("modeler.stickNoBend")); return null; }
    const before = ctx.snapshot();
    select({line: line.id}); ctx.refresh();
    let moved = false;
    return {
      move(q) {
        moved = true;
        const l = K.lineOf(sticks(), line.id), a = at(l.from), b = at(l.to), mid = a.map((v, k) => (v + b[k]) / 2);
        // The bow passes under the pointer: its middle stands that far off the line, toward it.
        const w = ctx.screenToWorld(q, mid).map((v, k) => v - mid[k]), {d, u, v} = K.lineFrame(a, b, l.shape.roll);
        const along = w[0] * d[0] + w[1] * d[1] + w[2] * d[2], off = w.map((x, k) => x - d[k] * along);
        const size = Math.hypot(...off), x = off[0] * u[0] + off[1] * u[1] + off[2] * u[2], y = off[0] * v[0] + off[1] * v[1] + off[2] * v[2];
        l.shape = K.readShape({...l.shape, curve: size, bend: size > 1e-6 ? Math.round(Math.atan2(y, x) * 180 / Math.PI) : l.shape.bend});
        regenerate(); ctx.draw();
      },
      up() { if (moved) ctx.pushUndo(before); ctx.refresh(); },
      cancel() { if (moved) ctx.restore(before); },
    };
  }

  /** A new line keeps the look of the line it grows from, in the chosen shape. */
  function shapeFor(kind, s, from) {
    const up = K.lineInto(s, from);
    const base = up ? {...up.shape, start: K.TWO_ENDS.has(up.shape.kind) ? up.shape.end : up.shape.start, curve: 0, bulge: 0, roll: 0, twist: 0, half: false, flip: false, tip: 0} : {...K.SHAPE_DEFAULTS};
    if (kind === 'plane' && up?.shape.kind !== 'plane') Object.assign(base, {start: .05, width: 1, depth: 1});
    if (up && up.color != null) S.stick.color ??= up.color;
    return {...base, end: kind === 'plane' && up?.shape.kind !== 'plane' ? .03 : base.start, kind};
  }

  // ---------- poly fill (as Pivot's) ----------
  function fillClick(hit) {
    const draft = S.stick.fillDraft ??= [];
    if (hit?.joint == null) { ctx.toast(t("modeler.stickFillPickJoint")); return; }
    if (draft.length >= 3 && hit.joint === draft[0]) { finishFill(); return; }
    if (draft.includes(hit.joint)) { ctx.toast(t("modeler.stickFillAgain")); return; }
    draft.push(hit.joint); ctx.refresh();
  }
  function finishFill() {
    const draft = S.stick.fillDraft ?? [];
    if (draft.length < 3) { ctx.toast(t("modeler.stickFillThree")); return; }
    S.stick.fillDraft = null;
    let made = null;
    change(s => { made = K.addFill(s, draft, {color: S.stick.color ?? 1}); });
    if (made) select({fill: made.id});
    ctx.refresh();
  }

  // ---------- head from outlines ----------
  function headClick(hit) {
    const s = ctx.model().sticks;
    const piece = hit?.joint != null ? K.jointOf(s, hit.joint)?.piece : hit?.line != null ? K.lineOf(s, hit.line)?.piece : null;
    if (piece == null) { ctx.toast(t(S.stick.headPick == null ? "modeler.stickHeadPickFront" : "modeler.stickHeadPickSide")); return; }
    if (S.stick.headPick == null) { S.stick.headPick = piece; ctx.toast(t("modeler.stickHeadPickSide")); ctx.refresh(); return; }
    if (piece === S.stick.headPick) { ctx.toast(t("modeler.stickHeadSamePiece")); return; }
    const front = S.stick.headPick; S.stick.headPick = null;
    let made = null;
    try { change(st => { made = K.addHead(st, front, piece, {color: 0}); }); }
    catch (error) { ctx.toast(error.message); ctx.refresh(); return; }
    if (!ctx.model().parts.some(p => p.stick === made?.id)) ctx.toast(t("modeler.stickHeadEmpty"));
    else ctx.toast(t("modeler.stickHeadMade"));
    select({head: made.id}); S.stick.tool = 'select'; ctx.refresh();
  }

  /** A line's shape, a poly fill or a head into an ordinary part, opened in Edit mode. */
  function convert(id) {
    let part = null;
    ctx.commit(() => { part = K.convertToMesh(ctx.model(), id); S.cache.clear(); });
    if (!part) return;
    select(null); ctx.toast(t("modeler.stickConverted", {name: part.name}));
    ctx.editPart(part.id);
  }

  function attachTo(hit) {
    const piece = S.stick.attachPick; S.stick.attachPick = null;
    if (hit?.joint != null) {
      try { change(s => K.attachPiece(s, piece, hit.joint)); ctx.toast(t("modeler.stickAttached")); }
      catch (error) { ctx.toast(error.message); ctx.refresh(); }
    } else { ctx.toast(t("modeler.stickAttachCancelled")); ctx.refresh(); }
  }

  // ---------- overlay ----------
  function drawOverlay(c) {
    const s = ctx.model().sticks; if (!s) return;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    const polyline = (pts, close) => { c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)); if (close) c.closePath(); c.stroke(); };
    for (const f of s.fills ?? []) {
      const pts = f.joints.map(id => project(at(id))); if (!pts.every(q => q.ok)) continue;
      const on = S.stick.fill === f.id;
      c.strokeStyle = on ? SELECTED : 'rgba(20,24,32,.35)'; c.lineWidth = on ? 2 : 1; c.setLineDash([5, 4]);
      polyline(pts, true);
    }
    for (const l of s.lines) {
      const pts = screenPath(l, 12); if (!pts.every(q => q.ok)) continue;
      const on = S.stick.line === l.id, picked = S.stick.headPick === l.piece;
      c.strokeStyle = on ? SELECTED : picked ? HEAD_PICK : l.guide ? GUIDE_COLOR : LINE_COLOR; c.lineWidth = on || picked ? 3 : l.guide ? 1.25 : 1.5; c.setLineDash(l.guide ? [2, 3] : l.static ? [4, 3] : []);
      polyline(pts, false);
    }
    c.setLineDash([]);
    // The poly fill being drawn, to the pointer.
    const draft = S.stick.tool === 'polygon' ? S.stick.fillDraft : null;
    if (draft?.length) {
      const pts = draft.map(id => project(at(id)));
      if (S.pointer) pts.push(S.pointer);
      c.strokeStyle = FILL_LINE; c.lineWidth = 2; polyline(pts, false);
    }
    const roots = new Map(s.pieces.map(p => [p.root, p]));
    for (const j of s.joints) {
      const q = project(j.at); if (!q.ok) continue;
      const piece = roots.get(j.id), on = S.stick.joint === j.id || draft?.includes(j.id);
      if (piece?.attach != null) continue; // drawn by the joint it sits on
      c.fillStyle = on ? SELECTED : piece ? ROOT_COLOR : JOINT_COLOR;
      c.beginPath(); c.arc(q.x, q.y, piece ? 5.5 : 4, 0, Math.PI * 2); c.fill();
      // Rings: where an attach can snap, and the joint that closes a poly fill.
      if (S.stick.attachPick || (draft?.length >= 3 && draft[0] === j.id)) { c.strokeStyle = ROOT_COLOR; c.lineWidth = 1.5; c.beginPath(); c.arc(q.x, q.y, 8, 0, Math.PI * 2); c.stroke(); }
    }
    c.restore();
  }

  // ---------- the tool rail (as Build's) ----------
  const toolButtons = new Map(), actionButtons = new Map();
  const railButton = (iconName, label, onclick) => el('button', {type: 'button', class: 'ui-tool-button', 'aria-label': label, title: label, onclick}, [ctx.glyph(iconName)]);
  const guideButton = railButton('onion', t("modeler.stickGuideMode"), () => { S.stick.guide = !S.stick.guide; ctx.toast(t(S.stick.guide ? "modeler.stickGuideOn" : "modeler.stickGuideOff")); ctx.refresh(); });
  guideButton.dataset.toggle = 'guide';
  const rail = el('div', {class: 'modeler-rail', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': t("modeler.stickTools")}, [
    ...TOOLS.map(([tool, iconName, key, shortcut]) => { const b = railButton(iconName, `${t(key)} (${shortcut})`, () => setTool(tool)); b.dataset.tool = tool; toolButtons.set(tool, b); return b; }),
    guideButton,
    el('span', {class: 'ui-rail-sep', 'aria-hidden': 'true'}),
    ...LINE_ACTIONS.map(([action, iconName, key]) => { const b = railButton(iconName, t(key), () => run(action)); b.dataset.action = action; actionButtons.set(action, b); return b; }),
  ]);
  function setTool(tool) {
    S.stick.tool = tool;
    if (tool !== 'polygon') S.stick.fillDraft = null;
    if (tool !== 'head') S.stick.headPick = null;
    else ctx.toast(t("modeler.stickHeadPickFront"));
    ctx.refresh();
  }
  /** Show the rail in Build mode, with the current tool pressed and the line actions ready when a line is picked. */
  function sync() {
    rail.hidden = S.mode !== 'build';
    for (const [tool, b] of toolButtons) b.setAttribute('aria-pressed', String(S.stick.tool === tool));
    guideButton.setAttribute('aria-pressed', String(Boolean(S.stick.guide)));
    const lineOn = S.stick.line != null, anything = lineOn || S.stick.fill != null || S.stick.joint != null || S.stick.head != null;
    for (const [action, b] of actionButtons) b.disabled = action === 'delete' ? !anything : !lineOn;
  }

  /** Split, Duplicate, Flip H, Flip V, Delete. */
  function run(action) {
    if (action === 'delete') { remove(); return; }
    if (action === 'convert') { const target = S.stick.line ?? S.stick.fill ?? S.stick.head; if (target != null) convert(target); return; }
    const id = S.stick.line; if (id == null) return;
    if (action === 'split') change(s => { const made = K.splitLine(s, id); if (made) S.stick.line = made.id; });
    else if (action === 'duplicate') change(s => { const made = K.duplicateBranch(s, id, {axis: ctx.frame().back}); if (made[0]) S.stick.line = made[0].id; });
    else if (action === 'flipH') change(s => K.flipBranch(s, id, [1, 0, 0]));
    else if (action === 'flipV') change(s => K.flipBranch(s, id, [0, 1, 0]));
    ctx.refresh();
  }

  // ---------- the panel (as Build's inspector, with sliders) ----------
  const show = (v, digits) => String(+Number(v).toFixed(digits));
  /** A slider: the shape follows while dragging; letting go is one undo step. */
  const slide = (label, value, {min, max, step, unit = '', digits = 3}, apply) => {
    let before = null;
    const out = el('output', {class: 'modeler-slider-value', text: show(value, digits) + unit});
    const input = el('input', {type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label,
      oninput: e => { before ??= ctx.snapshot(); const v = Number(e.target.value); out.textContent = show(v, digits) + unit; apply(sticks(), v); regenerate(); ctx.draw(); },
      onchange: () => { if (before) ctx.pushUndo(before); before = null; ctx.refresh(); }});
    return el('label', {class: 'modeler-slider'}, [el('span', {class: 'modeler-slider-label', text: label}), input, out]);
  };
  const toggle = (label, checked, apply, title) => el('label', {class: 'modeler-check', title}, [el('input', {type: 'checkbox', checked, onchange: () => change(apply)}), label]);
  const choose = (label, value, options, apply) => el('label', {class: 'modeler-field modeler-wide'}, [el('span', {text: label}),
    el('select', {onchange: e => { change(s => apply(s, e.target.value)); ctx.refresh(); }}, options.map(([v, text]) => el('option', {value: String(v), text, selected: String(v) === String(value)})))]);
  const setShape = (id, patch) => s => { const line = K.lineOf(s, id); line.shape = K.readShape({...line.shape, ...patch}); };

  function header(title, rename, quick) {
    return el('div', {class: 'modeler-inspector-head'}, [
      el('input', {type: 'text', class: 'modeler-inspector-title', value: title, maxlength: '80', 'aria-label': t("modeler.name"), onchange: e => rename(e.target.value.trim())}),
      el('div', {class: 'modeler-quick'}, quick.map(([action, iconName, key]) => {
        const b = el('button', {type: 'button', class: 'modeler-quick-button', title: t(key), onclick: () => run(action)}, [ctx.glyph(iconName), el('span', {text: t(key)})]);
        return b;
      }))]);
  }

  function props() {
    const s = ctx.model().sticks, blocks = [];
    const line = s && S.stick.line != null ? K.lineOf(s, S.stick.line) : null;
    const joint = s && S.stick.joint != null ? K.jointOf(s, S.stick.joint) : null;
    const fill = s && S.stick.fill != null ? K.fillOf(s, S.stick.fill) : null;
    const head = s && S.stick.head != null ? K.headOf(s, S.stick.head) : null;
    if (!line && !joint && !fill && !head) blocks.push(section(t("modeler.stickBuild"), [el('p', {class: 'modeler-hint', text: toolHint()})]));
    if (line) blocks.push(...linePanel(line));
    if (fill) blocks.push(...fillPanel(fill));
    if (head) blocks.push(...headPanel(head));
    if (joint) {
      const piece = K.pieceOf(s, joint.piece), isRoot = piece?.root === joint.id;
      blocks.push(section(t("modeler.stickJoint"), [
        ...['X', 'Y', 'Z'].map((axis, k) => slide(axis, joint.at[k], {min: -3, max: 3, step: .005}, (st, v) => { const p = K.jointOf(st, joint.id).at.slice(); p[k] = v; K.moveJoint(st, joint.id, p); })),
        el('p', {class: 'modeler-hint', text: isRoot ? t("modeler.stickRootHint") : t("modeler.stickJointHint")})]));
    }
    if (s?.pieces.length) blocks.push(piecesPanel(s, line?.piece ?? joint?.piece ?? (fill ? K.jointOf(s, fill.joints[0])?.piece : null)));
    return blocks;
  }
  function toolHint() {
    const tool = S.stick.tool;
    if (tool === 'polygon') return S.stick.fillDraft?.length ? t("modeler.stickFillGoing", {count: S.stick.fillDraft.length}) : t("modeler.stickFillHint");
    if (tool === 'select') return t("modeler.stickSelectHint");
    if (tool === 'hand') return t("modeler.stickPanHint");
    if (tool === 'head') return S.stick.headPick != null ? t("modeler.stickHeadPickSide") : t("modeler.stickHeadHint");
    return ctx.model().sticks?.lines.length ? t("modeler.stickHint") : t("modeler.stickStartHint");
  }

  function linePanel(line) {
    const sh = line.shape, kind = sh.kind, id = line.id, plane = kind === 'plane', round = ROUND_KINDS.has(kind);
    const a = at(line.from), b = at(line.to), len = Math.hypot(...a.map((v, k) => v - b[k]));
    const size = {min: .002, max: .5, step: .002};
    const thickness = K.TWO_ENDS.has(kind)
      ? [slide(plane ? t("modeler.stickHalfWidthStart") : t("modeler.stickThicknessStart"), sh.start, size, (st, v) => setShape(id, {start: v})(st)),
        slide(plane ? t("modeler.stickHalfWidthEnd") : t("modeler.stickThicknessEnd"), sh.end, size, (st, v) => setShape(id, {end: v})(st))]
      // A circle's size is the line's length; a ring's and a line's is their thickness.
      : kind === 'circle' || kind === 'circleFill' || kind === 'polygon' || kind === 'ellipse' ? []
      : [slide(t("modeler.stickThickness"), sh.start, size, (st, v) => setShape(id, {start: v, end: v})(st))];
    const kindRows = kind === 'trapezoid' ? [toggle(t("modeler.stickRoundStart"), sh.roundStart, setShape(id, {roundStart: !sh.roundStart})), toggle(t("modeler.stickRoundEnd"), sh.roundEnd, setShape(id, {roundEnd: !sh.roundEnd}))]
      : kind === 'triangle' ? [choose(t("modeler.stickTip"), sh.tip, [[-1, t("modeler.stickTipStart")], [0, t("modeler.stickTipCenter")], [1, t("modeler.stickTipEnd")]], (st, v) => setShape(id, {tip: Number(v)})(st)),
        toggle(t("modeler.stickFlip"), sh.flip, setShape(id, {flip: !sh.flip}))]
      : kind === 'ellipse' ? [toggle(t("modeler.stickHalfEllipse"), sh.half, setShape(id, {half: !sh.half})), sh.half ? toggle(t("modeler.stickFlip"), sh.flip, setShape(id, {flip: !sh.flip})) : null]
      : kind === 'polygon' ? [slide(t("modeler.stickSides"), sh.sides, {min: 3, max: 12, step: 1, digits: 0}, (st, v) => setShape(id, {sides: v})(st))] : [];
    const curveRows = K.CURVED_SHAPES.has(kind) ? [
      slide(t("modeler.stickCurve"), sh.curve, {min: -Math.max(.5, len), max: Math.max(.5, len), step: .005}, (st, v) => setShape(id, {curve: v})(st)),
      toggle(t("modeler.stickCircularArc"), sh.arc, setShape(id, {arc: !sh.arc})),
      slide(t("modeler.stickBendDirection"), sh.bend, {min: -180, max: 180, step: 1, unit: '°', digits: 0}, (st, v) => setShape(id, {bend: v})(st)),
      el('p', {class: 'modeler-hint', text: t("modeler.stickBendHint")})] : [];
    return [
      header(line.name || t("modeler.stickLineName", {id}), name => change(st => { K.lineOf(st, id).name = name; }), LINE_ACTIONS),
      section(t("modeler.stickStyle"), [
        ctx.colorRow(line.color, i => { S.stick.color = i; change(st => { K.lineOf(st, id).color = i; }); }),
        choose(t("modeler.stickShape"), kind, K.STICK_SHAPES.map(k => [k, t(`modeler.stickShape.${k}`)]), (st, v) => {
          setShape(id, {kind: v})(st);
          if (!ROUND_KINDS.has(v)) S.stick.lineKind = v; // the Line tool draws the last line shape picked
        }),
        ...thickness, ...kindRows, ...curveRows]),
      section(t("modeler.stick3d"), [
        slide(t("modeler.stickWidth"), sh.width, {min: .05, max: 4, step: .05, unit: '×', digits: 2}, (st, v) => setShape(id, {width: v})(st)),
        plane ? null : slide(t("modeler.stickDepth"), sh.depth, {min: .02, max: 4, step: .02, unit: '×', digits: 2}, (st, v) => setShape(id, {depth: v})(st)),
        slide(t("modeler.stickRoll"), sh.roll, {min: -180, max: 180, step: 1, unit: '°', digits: 0}, (st, v) => setShape(id, {roll: v})(st)),
        round ? null : slide(plane ? t("modeler.stickCurl") : t("modeler.stickBulge"), sh.bulge, {min: -1, max: 2, step: .02, digits: 2}, (st, v) => setShape(id, {bulge: v})(st)),
        plane ? slide(t("modeler.stickTwist"), sh.twist, {min: -360, max: 360, step: 1, unit: '°', digits: 0}, (st, v) => setShape(id, {twist: v})(st)) : null]),
      section(t("modeler.stickGeometry"), [
        slide(t("modeler.stickLength"), len, {min: .01, max: Math.max(1, Math.ceil(len * 20) / 10), step: .005}, (st, v) => {
          const l = K.lineOf(st, id), p = K.jointOf(st, l.from).at, q = K.jointOf(st, l.to).at, d = q.map((x, k) => x - p[k]), n = Math.hypot(...d) || 1;
          K.moveJoint(st, l.to, p.map((x, k) => x + d[k] / n * v));
        }),
        toggle(t("modeler.stickStatic"), line.static, st => { K.lineOf(st, id).static = !line.static; }, t("modeler.stickStaticHint")),
        toggle(t("modeler.stickGuide"), Boolean(line.guide), st => { const l = K.lineOf(st, id); if (line.guide) delete l.guide; else l.guide = true; }, t("modeler.stickGuideHint")),
        line.noMesh
          ? el('div', {}, [el('p', {class: 'modeler-hint', text: t("modeler.stickConvertedHint")}), ctx.button(t("modeler.stickShapeAgain"), () => change(st => { delete K.lineOf(st, id).noMesh; }), {title: t("modeler.stickShapeAgainHint")})])
          : line.guide ? null : ctx.button(t("modeler.stickConvert"), () => convert(id), {title: t("modeler.stickConvertHint")})]),
    ];
  }

  function headPanel(head) {
    const id = head.id, set = patch => st => { const h = K.headOf(st, id); Object.assign(h, K.readHeadShape({...h, ...patch})); };
    const whole = Boolean(head.whole);
    return [
      header(head.name || t("modeler.stickHead"), name => change(st => { K.headOf(st, id).name = name; }), [['convert', 'combine', "modeler.stickConvert"], ['delete', 'trash', "modeler.stickDelete"]]),
      section(t("modeler.stickStyle"), [
        ctx.colorRow(head.color, i => change(st => { K.headOf(st, id).color = i; })),
        choose(t("modeler.stickHeadSide"), whole ? 'whole' : 'face', [['face', t("modeler.stickHeadFace")], ['whole', t("modeler.stickHeadWhole")]], (st, v) => set({whole: v === 'whole'})(st)),
        slide(t("modeler.stickHeadSquare"), head.square, {min: 0, max: 1, step: .02, digits: 2}, (st, v) => set({square: v})(st)),
        slide(t("modeler.stickHeadBack"), head.back, {min: 0, max: 3, step: .02, digits: 2}, (st, v) => set({back: v})(st)),
        slide(t("modeler.stickHeadTop"), head.top, {min: 0, max: 3, step: .02, digits: 2}, (st, v) => set({top: v})(st)),
        slide(t("modeler.stickHeadBottom"), head.bottom, {min: 0, max: 3, step: .02, digits: 2}, (st, v) => set({bottom: v})(st))]),
      section(t("modeler.stickHeadDetail"), [
        slide(t("modeler.stickHeadRows"), head.rows, {min: 4, max: 32, step: 1, digits: 0}, (st, v) => set({rows: v})(st)),
        slide(t("modeler.stickHeadAround"), head.around, {min: 8, max: 32, step: 4, digits: 0}, (st, v) => set({around: v})(st)),
        slide(t("modeler.stickSmooth"), head.smooth, {min: 0, max: 2, step: 1, digits: 0}, (st, v) => set({smooth: v})(st)),
        el('p', {class: 'modeler-hint', text: t("modeler.stickHeadPanelHint")})])];
  }

  function fillPanel(fill) {
    const id = fill.id;
    return [
      header(fill.name || t("modeler.stickPolyFill"), name => change(st => { K.fillOf(st, id).name = name; }), [['convert', 'combine', "modeler.stickConvert"], ['delete', 'trash', "modeler.stickDelete"]]),
      section(t("modeler.stickStyle"), [
        ctx.colorRow(fill.color, i => change(st => { K.fillOf(st, id).color = i; })),
        slide(t("modeler.stickInflate"), fill.inflate ?? 0, {min: 0, max: 2, step: .02, digits: 2}, (st, v) => { K.fillOf(st, id).inflate = v; }),
        slide(t("modeler.stickSmooth"), fill.smooth ?? 1, {min: 0, max: 2, step: 1, digits: 0}, (st, v) => { K.fillOf(st, id).smooth = v; }),
        el('p', {class: 'modeler-hint', text: t("modeler.stickFillPanelHint")})])];
  }

  function piecesPanel(s, current) {
    return section(t("modeler.stickPieces"), [
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
      el('p', {class: 'modeler-hint', text: t("modeler.stickPiecesHint")})]);
  }

  function mirror(id) {
    try { change(s => { const made = K.mirrorLines(s, id); if (made[0]) S.stick.line = made[0].id; }); }
    catch (error) { ctx.toast(error.message); }
  }
  function remove() {
    const s = ctx.model().sticks; if (!s) return false;
    const done = fn => { change(fn); select(null); ctx.refresh(); return true; };
    if (S.stick.fill != null) { const id = S.stick.fill; return done(st => K.deleteFill(st, id)); }
    if (S.stick.head != null) { const id = S.stick.head; return done(st => K.deleteHead(st, id)); }
    if (S.stick.line != null) { const id = S.stick.line; return done(st => K.deleteLine(st, id)); }
    if (S.stick.joint != null) {
      const joint = K.jointOf(s, S.stick.joint), piece = K.pieceOf(s, joint?.piece);
      if (piece?.root === joint.id) return done(st => K.deletePiece(st, piece.id));
      const into = K.lineInto(s, joint.id); if (into) return done(st => K.deleteLine(st, into.id));
    }
    return false;
  }

  /** Keys in Build mode; true when handled. */
  function keydown(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key, plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (key === 'Escape') {
      if (S.stick.attachPick) { S.stick.attachPick = null; ctx.toast(t("modeler.stickAttachCancelled")); }
      else if (S.stick.headPick != null) S.stick.headPick = null;
      else if (S.stick.fillDraft?.length) S.stick.fillDraft = null;
      else select(null);
      ctx.refresh(); return true;
    }
    if (key === 'Enter' && S.stick.fillDraft?.length) { finishFill(); return true; }
    if (key === 'Backspace' && S.stick.fillDraft?.length) { S.stick.fillDraft.pop(); ctx.refresh(); return true; }
    if ((key === 'x' || key === 'Delete') && plain) return remove();
    if (key === 'm' && plain && S.stick.line != null) { mirror(S.stick.line); return true; }
    const tools = {v: 'select', l: 'line', c: 'circle', p: 'polygon', e: 'head', h: 'hand'};
    if (tools[key] && plain) { setTool(tools[key]); return true; }
    return false;
  }

  /** Forget a selection the sticks no longer have (after undo). */
  function tidy() {
    const s = ctx.model().sticks;
    if (S.stick.line != null && !s?.lines.some(l => l.id === S.stick.line)) S.stick.line = null;
    if (S.stick.joint != null && !s?.joints.some(j => j.id === S.stick.joint)) S.stick.joint = null;
    if (S.stick.fill != null && !s?.fills?.some(f => f.id === S.stick.fill)) S.stick.fill = null;
    if (S.stick.head != null && !s?.heads?.some(h => h.id === S.stick.head)) S.stick.head = null;
    if (S.stick.headPick != null && !s?.pieces.some(p => p.id === S.stick.headPick)) S.stick.headPick = null;
    if (S.stick.fillDraft) S.stick.fillDraft = S.stick.fillDraft.filter(id => s?.joints.some(j => j.id === id));
  }

  return {pick, press, bendPress, drawOverlay, props, keydown, tidy, select, regenerate, remove, rail, sync, run};
}
