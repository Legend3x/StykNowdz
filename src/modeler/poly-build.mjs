// Edit mode's drawing tools (docs/BLENDER-LITE.md, "Drawing faces"):
//
// - Snap to surface (Shift+Tab, the magnet): new and moved points land on the
//   other parts where you see them (Blender's snapping with Face Project), so
//   faces drawn from the front sit on a head made in Build mode and take its
//   depth.
// - Poly build (Q): click to place a point joined to the last one; click a
//   point to join it (four joined points become a face); click it again to go
//   on from it; drag a point to move it; Shift+click a point to delete it.
//   On a mirrored part, points near the middle land on it and points on the
//   other side are mirrored over (Blender's Mirror modifier with Clipping).
//
// The mesh edits go through mesh.mjs (atomic, validated); this file is the
// interaction, the overlay and the tool rail, wired in by modeler-ui.mjs.

import * as M from './mesh.mjs';

/** World-space triangles of the surfaces points snap onto. */
export function snapTriangles(meshes) {
  const tris = [];
  for (const s of meshes) for (const [a, b, c] of M.triangulate(s)) tris.push([s.verts[a], s.verts[b], s.verts[c]]);
  return tris;
}
/** Where a ray first meets the triangles: {point, normal} (normal toward the ray's origin), or null. */
export function castOnto(tris, origin, direction) {
  const dir = M.normalize(direction);
  let best = Infinity, hit = null;
  for (const [A, B, C] of tris) { const d = M.rayTriangle(origin, dir, A, B, C); if (d < best) { best = d; hit = [A, B, C]; } }
  if (!hit) return null;
  let normal = M.normalize(M.cross(M.sub(hit[1], hit[0]), M.sub(hit[2], hit[0])));
  if (M.dot(normal, dir) > 0) normal = M.scale(normal, -1);
  return {point: M.add(origin, M.scale(dir, best)), normal};
}

/** How far points sit off the surface they snap onto, so the new faces show in front of it. */
const LIFT = .004;

/**
 * ctx: {S, part(), frame(), model(), evaluate(part), commit(fn), snapshot(), restore(snap), pushUndo(before),
 *   refresh(), draw(), toast(text), t, el, glyph(icon), screenToWorld(pt, through), cage(), setMirror(part, on),
 *   paintColor(part), localFacing(part)}
 */
export function createPolyBuild(ctx) {
  const {S, t, el} = ctx;
  S.polyBuild ??= false; S.snap ??= false;

  /** The surfaces to snap onto: every other part with faces that is showing, and
   * heads made in Build mode even when hidden (they're guides for drawing). */
  function surfaces(p) {
    const parts = ctx.model().parts.filter(q => q.id !== p.id && q.mesh.faces.length && (q.visible !== false || q.stick != null));
    return snapTriangles(parts.map(q => ctx.evaluate(q)));
  }
  /** The view's ray through a world point. */
  function rayThrough(world) {
    const f = ctx.frame(), toEye = f.toEye(world);
    return {origin: f.ortho ? M.add(world, M.scale(toEye, 1e3)) : f.eye, direction: M.scale(toEye, -1)};
  }
  /** On a mirrored part: near the middle lands on it; the other side is mirrored over. */
  function clip(p, world) {
    if (!p.mirror || p.clip === false) return world;
    const near = ctx.frame().unitsPerPixel(world) * 8;
    if (Math.abs(world[0]) < near) return [0, world[1], world[2]];
    return world[0] < 0 ? [-world[0], world[1], world[2]] : world;
  }
  /** Where a point placed at screen point `pt` goes, in the part's own space: on the
   * surface under the pointer when snapping, else on the plane through `through` facing the view. */
  function placeLocal(p, pt, through, tris = null) {
    let world = ctx.screenToWorld(pt, through);
    if (S.snap) {
      tris ??= surfaces(p);
      const ray = rayThrough(world), hit = tris.length ? castOnto(tris, ray.origin, ray.direction) : null;
      if (hit) world = M.add(hit.point, M.scale(hit.normal, LIFT));
    }
    return M.objectInverse(p)(clip(p, world));
  }
  /** Snap points moved by G (Edit mode) onto the surfaces where they are seen. */
  function snapMoved(target, mesh, moved) {
    if (!S.snap) return mesh;
    const p = target.part;
    target.snapTris ??= surfaces(p);
    if (!target.snapTris.length) return mesh;
    const to = M.objectTransform(p), back = M.objectInverse(p), out = {...mesh, verts: mesh.verts.slice()};
    for (const v of moved) {
      const ray = rayThrough(to(mesh.verts[v])), hit = castOnto(target.snapTris, ray.origin, ray.direction);
      if (hit) out.verts[v] = back(M.add(hit.point, M.scale(hit.normal, LIFT)));
    }
    return out;
  }

  /** The point under the pointer (shown, within 12 pixels), or null. */
  function pickVert(pt) {
    const c = ctx.cage(); if (!c) return null;
    let best = null, d = 12;
    c.pts.forEach((q, v) => { if (!q.ok || !c.visible[v]) return; const e = Math.hypot(q.x - pt.x, q.y - pt.y); if (e < d) { d = e; best = v; } });
    return best;
  }
  const pen = () => S.verts.size === 1 ? [...S.verts][0] : null;

  /** After joining a and b: faces for each ring of four joined points through them that has no face yet. */
  function closeQuads(p, a, b) {
    for (let guard = 0; guard < 2; guard++) {
      const nb = M.neighbours(p.mesh), uses = M.edgeFaces(p.mesh), full = (x, y) => (uses.get(M.edgeKey(x, y)) ?? []).length >= 2;
      const have = new Set(p.mesh.faces.map(f => [...f.v].sort((x, y) => x - y).join()));
      let ring = null;
      for (const x of nb.get(b) ?? []) {
        if (x === a) continue;
        for (const y of nb.get(a) ?? []) {
          if (y === b || y === x || !(nb.get(x)?.has(y))) continue;
          const quad = [a, b, x, y];
          if (have.has([...quad].sort((m, n) => m - n).join())) continue;
          if (full(a, b) || full(b, x) || full(x, y) || full(y, a)) continue;
          ring = quad; break;
        }
        if (ring) break;
      }
      if (!ring) return;
      try { M.fillVerts(p.mesh, new Set(ring), ctx.paintColor(p), {facing: ctx.localFacing(p)}); }
      catch { return; }
    }
  }

  /** A left press in Edit mode with Poly build on: returns a drag ({move, up, cancel}) or null. */
  function press(pt, e) {
    const p = ctx.part(); if (!p || p.stick != null) return null;
    const hit = pickVert(pt);
    if (e.shiftKey) {
      if (hit == null) return null;
      ctx.commit(() => { M.deleteVerts(p.mesh, new Set([hit])); S.verts = new Set(); S.cache.delete(p.id); });
      return null;
    }
    const before = ctx.snapshot(), start = {...pt};
    let moving = false, tris = null;
    return {
      move(q) {
        if (hit == null) return;
        if (!moving && Math.hypot(q.x - start.x, q.y - start.y) < 4) return;
        if (!moving) { moving = true; tris = S.snap ? surfaces(p) : null; p.mesh = {...p.mesh, verts: p.mesh.verts.map(v => v.slice())}; }
        p.mesh.verts[hit] = placeLocal(p, q, M.objectTransform(p)(p.mesh.verts[hit]), tris);
        S.verts = new Set([hit]); S.cache.delete(p.id); ctx.draw();
      },
      up(q) {
        if (moving) { ctx.pushUndo(before); ctx.refresh(); return; }
        click(p, hit, q ?? start);
      },
      cancel() { if (moving) ctx.restore(before); },
    };
  }
  function click(p, hit, pt) {
    const from = pen();
    if (hit != null) {
      // Start from a point, or go on from a point already joined to the last one.
      if (from == null || from === hit || M.neighbours(p.mesh).get(from)?.has(hit)) { S.verts = new Set([hit]); ctx.refresh(); return; }
      ctx.commit(() => { M.fillVerts(p.mesh, new Set([from, hit])); closeQuads(p, from, hit); S.verts = new Set([from]); S.cache.delete(p.id); });
      return;
    }
    const to = M.objectTransform(p), through = from != null ? to(p.mesh.verts[from]) : S.camera.target;
    ctx.commit(() => { const k = M.addPoint(p.mesh, placeLocal(p, pt, through), from); S.verts = new Set([k]); S.cache.delete(p.id); });
  }

  /** The line from the last point to the pointer, and a ring round the point a click would join. */
  function drawOverlay(c) {
    if (S.mode !== 'edit' || !S.polyBuild || !S.pointer) return;
    const cage = ctx.cage(); if (!cage) return;
    const from = pen(), hover = pickVert(S.pointer);
    c.save();
    if (from != null && cage.pts[from]?.ok) {
      const end = hover != null && cage.pts[hover].ok ? cage.pts[hover] : S.pointer;
      c.strokeStyle = 'rgba(255,138,0,.9)'; c.lineWidth = 1.5; c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(cage.pts[from].x, cage.pts[from].y); c.lineTo(end.x, end.y); c.stroke();
    }
    if (hover != null && cage.pts[hover].ok) { c.setLineDash([]); c.strokeStyle = '#ff8a00'; c.lineWidth = 2; c.beginPath(); c.arc(cage.pts[hover].x, cage.pts[hover].y, 7, 0, Math.PI * 2); c.stroke(); }
    c.restore();
  }

  // ---------- Edit mode's tool rail ----------
  const button = (iconName, label, onclick, data) => { const b = el('button', {type: 'button', class: 'ui-tool-button', 'aria-label': label, title: label, onclick}, [ctx.glyph(iconName)]); b.dataset.edit = data; return b; };
  const buttons = {
    select: button('cursor', t("modeler.editSelectTool"), () => { S.polyBuild = false; ctx.refresh(); }, 'select'),
    build: button('nodes', t("modeler.polyBuild"), () => { setBuild(true); }, 'build'),
    snap: button('magnet', t("modeler.snapSurface"), () => toggleSnap(), 'snap'),
    mirror: button('flip', t("modeler.mirrorX"), () => { const p = ctx.part(); if (p) ctx.setMirror(p, !p.mirror); }, 'mirror'),
    xray: button('eye', t("modeler.xray"), () => { S.xray = !S.xray; ctx.refresh(); }, 'xray'),
  };
  const rail = el('div', {class: 'modeler-rail', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': t("modeler.editTools")}, [
    buttons.select, buttons.build, el('span', {class: 'ui-rail-sep', 'aria-hidden': 'true'}), buttons.snap, buttons.mirror, buttons.xray]);
  function setBuild(on) {
    S.polyBuild = on;
    if (on) { ctx.toast(t("modeler.polyBuildHint")); S.selectMode = 'vert'; }
    ctx.refresh();
  }
  function toggleSnap() { S.snap = !S.snap; ctx.toast(t(S.snap ? "modeler.snapOn" : "modeler.snapOff")); ctx.refresh(); }
  function sync() {
    rail.hidden = S.mode !== 'edit';
    const p = ctx.part();
    buttons.select.setAttribute('aria-pressed', String(!S.polyBuild)); buttons.build.setAttribute('aria-pressed', String(Boolean(S.polyBuild)));
    buttons.snap.setAttribute('aria-pressed', String(Boolean(S.snap))); buttons.mirror.setAttribute('aria-pressed', String(Boolean(p?.mirror))); buttons.xray.setAttribute('aria-pressed', String(Boolean(S.xray)));
  }
  /** Keys in Edit mode: Q (Poly build), Shift+Tab (snapping), Esc (Poly build: start a new strip). True when handled. */
  function keydown(e, key) {
    if (key === 'q') { setBuild(!S.polyBuild); return true; }
    if (key === 'Escape' && S.polyBuild) { S.verts = new Set(); ctx.refresh(); return true; }
    if (key === 'Tab' && e.shiftKey) { toggleSnap(); return true; }
    return false;
  }

  return {press, drawOverlay, placeLocal, snapMoved, rail, sync, keydown, setBuild};
}
