/** The UV editor panel of 3D Nowdz (docs/BLENDER-LITE.md, "UV tools").
 *
 * Shows the texture with the UV layout of the faces being edited on top, and
 * edits it as Blender's UV editor does: click a point (Shift adds), drag a box,
 * A all, Alt+A none, L the island under the pointer, Ctrl+L islands of the
 * selection; drag a selected point or press G, S or R and move the mouse (X or
 * Y keeps one direction; click or Enter keeps, right-click or Esc puts back).
 * Wheel zooms, middle drag pans, Home fits the square.
 *
 * The host owns the model: `source()` gives {mesh, faces, image} (faces: the
 * face indices shown), and the hooks `begin()` (before a change, for undo),
 * `changed()` (UVs moved: redraw the model) and `end(keep)` (keep or put back)
 * wrap every change. Keys reach the editor through `key(event)` while the
 * pointer is over it. */
import {cornersAt, linkedCorners, cornerCentre, transformCorners} from './unwrap.mjs';

const POINT_HIT = 8;

export function createUVEditor({source, begin, changed, end, header = [], t = key => key}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'modeler-uv-canvas';
  const bar = document.createElement('div');
  bar.className = 'modeler-uv-bar';
  bar.append(...header);
  const root = document.createElement('div');
  root.className = 'modeler-uv';
  root.hidden = true;
  root.append(bar, canvas);

  const S = {sel: new Set(), zoom: 1, pan: [0, 0], hover: false, pointer: null, modal: null, drag: null, mesh: null};
  // ---------- view ----------
  const view = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight, size = Math.max(40, Math.min(w, h) - 40) * S.zoom;
    return {w, h, size, ox: (w - size) / 2 + S.pan[0], oy: (h - size) / 2 + S.pan[1]};
  };
  const toScreen = ([u, v], V = view()) => [V.ox + u * V.size, V.oy + (1 - v) * V.size];
  const toUV = (x, y, V = view()) => [(x - V.ox) / V.size, 1 - (y - V.oy) / V.size];
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  function current() {
    const src = source();
    if (!src?.mesh) { S.sel.clear(); S.mesh = null; return null; }
    if (src.mesh !== S.mesh) { S.mesh = src.mesh; S.sel = new Set([...S.sel].filter(id => valid(src, id))); }
    return src;
  }
  const valid = (src, id) => { const [fi, k] = id.split(':').map(Number); return src.faces.has(fi) && Boolean(src.mesh.faces[fi]?.uv?.[k]); };

  // ---------- drawing ----------
  let checker = null;
  function checkerPattern(ctx) {
    if (checker) return checker;
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d'); g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#bdbdbd'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    return (checker = ctx.createPattern(c, 'repeat'));
  }
  function draw() {
    if (root.hidden) return;
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const src = current(), V = view();
    ctx.fillStyle = checkerPattern(ctx); ctx.fillRect(V.ox, V.oy, V.size, V.size);
    if (src?.image?.complete !== false && (src?.image?.naturalWidth || src?.image?.width)) { ctx.imageSmoothingEnabled = V.size < (src.image.naturalWidth ?? src.image.width); ctx.drawImage(src.image, V.ox, V.oy, V.size, V.size); }
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.strokeRect(V.ox + .5, V.oy + .5, V.size, V.size);
    if (!src) return;
    // Faces: selected ones tinted, every edge drawn.
    for (const fi of src.faces) {
      const f = src.mesh.faces[fi]; if (!f?.uv) continue;
      const pts = f.uv.map(p => toScreen(p, V)), all = f.uv.every((_, k) => S.sel.has(`${fi}:${k}`));
      ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
      if (all) { ctx.fillStyle = 'rgba(255,140,30,.18)'; ctx.fill(); }
      ctx.strokeStyle = 'rgba(20,20,20,.85)'; ctx.lineWidth = 2.2; ctx.stroke();
      ctx.strokeStyle = all ? '#ff9a2e' : 'rgba(255,255,255,.9)'; ctx.lineWidth = 1; ctx.stroke();
    }
    for (const fi of src.faces) src.mesh.faces[fi]?.uv?.forEach((p, k) => {
      const [x, y] = toScreen(p, V), on = S.sel.has(`${fi}:${k}`);
      ctx.fillStyle = on ? '#ff9a2e' : '#1d1d1d'; ctx.fillRect(x - (on ? 3 : 2), y - (on ? 3 : 2), on ? 6 : 4, on ? 6 : 4);
    });
    if (S.drag?.kind === 'box') {
      const [a, b] = [S.drag.from, S.drag.to]; ctx.setLineDash([4, 3]); ctx.strokeStyle = '#333'; ctx.strokeRect(Math.min(a[0], b[0]) + .5, Math.min(a[1], b[1]) + .5, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); ctx.setLineDash([]);
    }
    if (S.modal) { ctx.fillStyle = 'rgba(30,30,30,.85)'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(S.modal.label(), 8, h - 8); }
  }

  // ---------- picking ----------
  function nearest(x, y) {
    const src = current(); if (!src) return null;
    const V = view(); let best = null;
    for (const fi of src.faces) src.mesh.faces[fi]?.uv?.forEach((p, k) => { const [sx, sy] = toScreen(p, V), d = Math.hypot(sx - x, sy - y); if (d <= POINT_HIT && (!best || d < best.d)) best = {d, fi, k, uv: p}; });
    return best ? cornersAt(src.mesh, src.faces, best.uv).filter(id => { const [fi, k] = id.split(':').map(Number); return src.mesh.faces[fi].v[k] === src.mesh.faces[best.fi].v[best.k]; }) : null;
  }
  const selectAll = on => { const src = current(); S.sel = new Set(); if (on && src) for (const fi of src.faces) src.mesh.faces[fi]?.uv?.forEach((_, k) => S.sel.add(`${fi}:${k}`)); draw(); };
  function boxSelect(a, b, extend) {
    const src = current(); if (!src) return;
    const V = view(), [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])], [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    if (!extend) S.sel = new Set();
    for (const fi of src.faces) src.mesh.faces[fi]?.uv?.forEach((p, k) => { const [x, y] = toScreen(p, V); if (x >= x0 && x <= x1 && y >= y0 && y <= y1) S.sel.add(`${fi}:${k}`); });
  }

  // ---------- moves ----------
  function startMove(kind, at) {
    const src = current(); if (!src || !S.sel.size || S.modal) return false;
    begin();
    const start = new Map([...S.sel].map(id => { const [fi, k] = id.split(':').map(Number); return [id, src.mesh.faces[fi].uv[k].slice()]; }));
    const pivot = cornerCentre(src.mesh, S.sel), from = at ?? S.pointer ?? toScreen(pivot);
    S.modal = {kind, start, pivot, from, axis: null, mesh: src.mesh,
      label: () => t(S.modal.axis ? `modeler.uv.${kind}Along` : `modeler.uv.${kind}`, {axis: S.modal.axis?.toUpperCase()})};
    return true;
  }
  function applyMove(x, y) {
    const m = S.modal, V = view(), [px, py] = toScreen(m.pivot, V);
    if (m.kind === 'grab') {
      let d = [(x - m.from[0]) / V.size, -(y - m.from[1]) / V.size];
      if (m.axis === 'x') d[1] = 0; if (m.axis === 'y') d[0] = 0;
      transformCorners(m.mesh, m.start, {move: d});
    } else if (m.kind === 'scale') {
      const s = Math.hypot(x - px, y - py) / Math.max(1, Math.hypot(m.from[0] - px, m.from[1] - py));
      transformCorners(m.mesh, m.start, {scale: [m.axis === 'y' ? 1 : s, m.axis === 'x' ? 1 : s], pivot: m.pivot});
    } else {
      const a = Math.atan2(-(y - py), x - px) - Math.atan2(-(m.from[1] - py), m.from[0] - px);
      transformCorners(m.mesh, m.start, {angle: a, pivot: m.pivot});
    }
    changed(); draw();
  }
  function finishMove(keep) {
    const m = S.modal; if (!m) return;
    if (!keep) transformCorners(m.mesh, m.start, {});
    S.modal = null; end(keep); draw();
  }

  // ---------- input ----------
  canvas.addEventListener('pointerenter', () => { S.hover = true; });
  canvas.addEventListener('pointerleave', () => { S.hover = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [x, y] = local(e), before = toUV(x, y), f = Math.exp(-e.deltaY * .0015);
    S.zoom = Math.min(40, Math.max(.2, S.zoom * f));
    const after = toScreen(before); S.pan = [S.pan[0] + x - after[0], S.pan[1] + y - after[1]]; draw();
  }, {passive: false});
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture?.(e.pointerId);
    const [x, y] = local(e); S.pointer = [x, y];
    if (S.modal) { finishMove(e.button === 0); return; }
    if (e.button === 1) { S.drag = {kind: 'pan', from: [x, y], pan: S.pan.slice()}; return; }
    if (e.button !== 0) return;
    const hit = nearest(x, y);
    if (hit && !e.shiftKey && hit.every(id => S.sel.has(id))) { S.drag = {kind: 'press', from: [x, y], moved: false}; return; }
    if (hit) { if (!e.shiftKey) S.sel = new Set(); const on = !(e.shiftKey && hit.every(id => S.sel.has(id))); for (const id of hit) on ? S.sel.add(id) : S.sel.delete(id); S.drag = {kind: 'press', from: [x, y], moved: false}; draw(); return; }
    S.drag = {kind: 'box', from: [x, y], to: [x, y], extend: e.shiftKey};
  });
  canvas.addEventListener('pointermove', e => {
    const [x, y] = local(e); S.pointer = [x, y];
    if (S.modal) { applyMove(x, y); return; }
    const d = S.drag; if (!d) return;
    if (d.kind === 'pan') { S.pan = [d.pan[0] + x - d.from[0], d.pan[1] + y - d.from[1]]; draw(); }
    else if (d.kind === 'box') { d.to = [x, y]; draw(); }
    else if (d.kind === 'press' && Math.hypot(x - d.from[0], y - d.from[1]) > 3) { S.drag = null; if (startMove('grab', d.from)) { S.modal.dragged = true; applyMove(x, y); } }
  });
  canvas.addEventListener('pointerup', e => {
    const d = S.drag; S.drag = null;
    if (S.modal?.dragged) { finishMove(true); return; }
    if (d?.kind === 'box') { const [x, y] = local(e); if (Math.hypot(x - d.from[0], y - d.from[1]) < 3) { if (!d.extend) S.sel = new Set(); } else boxSelect(d.from, [x, y], d.extend); draw(); }
  });

  /** Keys while the pointer is over the editor; true when the editor used it. */
  function key(e) {
    if (root.hidden || (!S.hover && !S.modal)) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl = e.ctrlKey || e.metaKey;
    if (S.modal) {
      if (k === 'Escape') finishMove(false);
      else if (k === 'Enter' || k === ' ') finishMove(true);
      else if (k === 'x' || k === 'y') { S.modal.axis = S.modal.axis === k ? null : k; if (S.pointer) applyMove(...S.pointer); }
      else if (['g', 's', 'r'].includes(k)) { const at = S.modal.from; finishMove(false); startMove({g: 'grab', s: 'scale', r: 'rotate'}[k], at); }
      else return false;
      return true;
    }
    const src = current();
    if (ctrl && k === 'l') { if (src) S.sel = linkedCorners(src.mesh, src.faces, S.sel); }
    else if (ctrl) return false;
    else if (k === 'a' && e.altKey) selectAll(false);
    else if (k === 'a') selectAll(true);
    else if (k === 'l') { const hit = S.pointer && nearest(...S.pointer); if (hit && src) S.sel = new Set([...S.sel, ...linkedCorners(src.mesh, src.faces, hit)]); }
    else if (k === 'g' || k === 's' || k === 'r') startMove({g: 'grab', s: 'scale', r: 'rotate'}[k]);
    else if (k === 'Home') { S.zoom = 1; S.pan = [0, 0]; }
    else return false;
    draw(); return true;
  }

  return {
    root, canvas, draw, key,
    get open() { return !root.hidden; },
    show(on) { root.hidden = !on; if (on) requestAnimationFrame(draw); else if (S.modal) finishMove(false); },
    /** Selected corners ("face:corner"), e.g. for tests and the host's status line. */
    get selection() { return S.sel; },
    select(ids) { S.sel = new Set(ids); draw(); },
    get moving() { return Boolean(S.modal); },
  };
}
