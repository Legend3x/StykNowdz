/** Blender's engine inside 3D Nowdz (docs/BLENDER-LITE.md, "Blender tools").
 *
 * The desktop app runs Blender with no window (desktop/blender-engine.cjs and
 * desktop/blender/styk_engine.py). A tool sends only the parts it works on, in
 * the link format Open in Blender uses, and gets them back the same way, so a
 * result is read exactly as a reply from Blender is (blender-link.mjs).
 *
 * engineRequest(model, tool, {parts, params}) → {request, session}
 * applyEngineResult(model, reply, session, {tool, parts, keepCutter}) merges the
 *   result inside the caller's undo step and says what changed.
 *
 * A part a tool changes keeps its name and its 3D Nowdz-only settings (outline,
 * shadows, the bone it moves with); its shape comes back final ("baked"), with
 * Mirror, Smooth and Solidify applied, since a Remesh or Boolean works on the
 * finished shape. Weights painted on its old points can't carry over to new
 * points, so it goes back to automatic weights. Text and tubes come back as new
 * parts. */
import {startBlenderLink, readBlenderReply, readBlenderPart, setExtras} from './blender-link.mjs';
import {addPart} from './model.mjs';

export const ENGINE_TOOLS = Object.freeze(['remesh', 'decimate', 'boolean', 'smooth', 'text', 'tube']);
/** How many parts each tool works on (the first is changed; a Boolean's second cuts it). */
const PARTS_NEEDED = {remesh: 1, decimate: 1, smooth: 1, boolean: 2, text: 0, tube: 0};
const fail = why => { throw Object.assign(new Error(why), {modelerMessage: true}); };

/** The request for one tool: the parts it needs as a link document (no bones or
 * reference images, which no tool uses), and the session that reads the result. */
export function engineRequest(model, tool, {parts = [], params = {}} = {}) {
  if (!ENGINE_TOOLS.includes(tool)) fail(`Unknown Blender tool “${tool}”.`);
  const chosen = parts.map(id => model.parts.find(p => p.id === id)).filter(Boolean);
  if (chosen.length < PARTS_NEEDED[tool]) fail(tool === 'boolean' ? 'Select the part to change, then Shift-click the part to cut or join it with.' : 'Select a part first.');
  if (chosen.some(p => !p.mesh.faces.length)) fail(`“${chosen.find(p => !p.mesh.faces.length).name}” has no faces for Blender to work on.`);
  const used = chosen.slice(0, PARTS_NEEDED[tool]);
  const {doc, session} = startBlenderLink({...model, parts: used, bones: [], references: []});
  const keyOf = id => [...session.parts].find(([, s]) => s.id === id)?.[0];
  const sent = {...params};
  if (used[0]) sent.target = keyOf(used[0].id);
  if (tool === 'boolean') sent.cutter = keyOf(used[1].id);
  return {request: {op: tool, params: sent, doc}, session};
}

/** Merge a tool's result. Returns {changed, added, removed, added ids}. */
export function applyEngineResult(model, rawReply, session, {tool, parts = [], keepCutter = false} = {}) {
  const reply = readBlenderReply(rawReply);
  const report = {changed: 0, added: 0, removed: 0, addedIds: []};
  const colorIndex = new Map(), rgbOf = m => reply.materials[m] ?? [200, 200, 200];
  const colorOf = m => {
    if (!colorIndex.has(m)) {
      const rgb = rgbOf(m); let i = model.palette.findIndex(c => c.every((v, k) => Math.abs(v - rgb[k]) <= 1));
      if (i < 0) { model.palette.push(rgb.slice()); i = model.palette.length - 1; }
      colorIndex.set(m, i);
    }
    return colorIndex.get(m);
  };
  const idOf = new Map([...session.parts].map(([key, s]) => [key, s.id]));
  const target = PARTS_NEEDED[tool] ? parts[0] : null, cutter = tool === 'boolean' ? parts[1] : null;
  let targetBack = false;
  for (const back of reply.parts) {
    const id = idOf.get(back.key);
    if (id !== undefined && id !== target) continue; // the cutter is a tool, not a result
    const {mesh, placed, settings, extra} = readBlenderPart(back, colorOf);
    if (!mesh.faces.length) fail(tool === 'boolean' ? 'Nothing is left after that Boolean: the parts don\'t overlap that way.' : `“${back.name}” came back with no faces.`);
    if (id !== undefined) {
      const part = model.parts.find(p => p.id === id);
      // Its name and 3D Nowdz-only settings stay; painted weights can't follow new points.
      Object.assign(part, {mesh}, placed, settings);
      setExtras(part, extra);
      report.changed++; targetBack = true;
    } else {
      const part = addPart(model, {name: back.name, mesh, ...placed, ...settings});
      setExtras(part, extra);
      report.added++; report.addedIds.push(part.id);
    }
  }
  if (target !== null && !targetBack) fail(tool === 'boolean' ? 'Nothing is left after that Boolean: the parts don\'t overlap that way.' : 'Blender gave the part back empty.');
  if (cutter !== null) {
    const part = model.parts.find(p => p.id === cutter);
    if (part && keepCutter) part.visible = false;
    else if (part) { model.parts = model.parts.filter(p => p !== part); report.removed++; }
  }
  return report;
}

/** The selected points of a part as one row along its edges, in order: what a
 * tube runs through. {order: [vertex], closed} or a message when the selection
 * is not a single row (it branches, or has gaps). */
export function chainOf(mesh, selected) {
  const chosen = new Set(selected);
  if (chosen.size < 2) return {error: 'Select two or more points in a row (Edit mode) to run a tube through.'};
  const next = new Map([...chosen].map(v => [v, new Set()]));
  const join = (a, b) => { if (a !== b && chosen.has(a) && chosen.has(b)) { next.get(a).add(b); next.get(b).add(a); } };
  for (const f of mesh.faces) for (let i = 0; i < f.v.length; i++) join(f.v[i], f.v[(i + 1) % f.v.length]);
  for (const [a, b] of mesh.edges ?? []) join(a, b);
  if ([...next.values()].some(n => n.size > 2)) return {error: 'The selected points branch. Select one row of points, one after another along the edges.'};
  const ends = [...next].filter(([, n]) => n.size === 1).map(([v]) => v);
  if ([...next.values()].some(n => n.size === 0)) return {error: 'Some selected points are not joined to the others. Select one row of points along the edges.'};
  const closed = ends.length === 0;
  if (!closed && ends.length !== 2) return {error: 'Select one row of points along the edges.'};
  const start = closed ? Math.min(...chosen) : Math.min(...ends), order = [start], seen = new Set([start]);
  for (let at = start; ;) {
    const step = [...next.get(at)].find(v => !seen.has(v));
    if (step === undefined) break;
    order.push(step); seen.add(step); at = step;
  }
  if (order.length !== chosen.size) return {error: 'Select one row of points along the edges.'};
  return {order, closed};
}
