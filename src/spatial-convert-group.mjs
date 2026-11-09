/** Make 3D for a joined assembly (docs/PSEUDO-3D-PLAN.md, 1.4): which pieces
 * belong to it, and the depth of every joint, as absolute Z toward the camera
 * in screen units, measured from the assembly's root. Pure: reads geometry,
 * never edits the document. */
import {buildGeometry} from './pivot/geometry.mjs';
import {resolveJoinSelection, frameOrder} from './pivot/structure.mjs';

/** Slots of the whole joined assembly containing `uid` (its root and everything joined below), root first. */
export function assemblySlots(frame, uid) {
  const resolved = resolveJoinSelection(frame, [uid], true), slots = resolved.affectedSlots;
  const root = slots.find(slot => !frame.objects[slot].join || !slots.includes(frame.objects[slot].join.target_object_slot));
  // Parents before children, so attachment depths are known when a piece is reached.
  const children = new Map();
  for (const slot of slots) { const join = frame.objects[slot].join; if (join && slot !== root) children.set(join.target_object_slot, [...(children.get(join.target_object_slot) ?? []), slot]); }
  const ordered = [root];
  for (let i = 0; i < ordered.length; i++) ordered.push(...(children.get(ordered[i]) ?? []));
  return ordered;
}

/** A piece's place in its assembly: the chain of figure types and join handles from the root. */
export function joinSignatures(frame, slots) {
  const set = new Set(slots), out = new Map();
  const of = slot => {
    if (out.has(slot)) return out.get(slot);
    const o = frame.objects[slot], join = o.join, parent = join && set.has(join.target_object_slot) ? join.target_object_slot : null;
    const value = parent === null ? `R${o.figure_type_id}` : `${of(parent)}>${o.figure_type_id}@${join.target_handle_id}`;
    out.set(slot, value); return value;
  };
  for (const slot of slots) of(slot);
  return out;
}

const bounds = (geometry, slots) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const slot of slots) for (const p of geometry.objects.get(slot)?.joints.values() ?? []) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return {x0, y0, x1, y1, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0)};
};

/** Joint → absolute depth for one piece whose every joint sits at its attachment. */
function flatPiece(frame, slot, figure, depths) {
  const join = frame.objects[slot].join, at = join ? depths.get(join.target_object_slot)?.get(join.target_handle_id) ?? 0 : 0;
  return new Map([[0, at], ...figure.segments.map(s => [s.segment_id, at])]);
}

/** Layered depth across the assembly: later-drawn parts are closer, spread
 * over `depth` × the assembly's size. Returns Map slot → Map(joint → Z). */
export function layeredAssemblyDepths(report, frame, slots, {depth = 0.2, geometry = buildGeometry(report, frame)} = {}) {
  const types = new Map(report.figure_types.map(f => [f.figure_type_id, f])), order = frameOrder(frame), rank = new Map(order.map((uid, i) => [uid, i]));
  const pieces = [...slots].sort((a, b) => (rank.get(frame.objects[a].unique_id) ?? a) - (rank.get(frame.objects[b].unique_id) ?? b));
  const parts = [];
  for (const slot of pieces) {
    const figure = types.get(frame.objects[slot].figure_type_id);
    figure.segments.map((s, i) => [Number.isFinite(s.z_order) ? s.z_order : i + 1, s.segment_id]).sort((a, b) => a[0] - b[0]).forEach(([, id]) => parts.push([slot, id]));
  }
  const box = bounds(geometry, slots), n = parts.length, step = n > 1 ? Math.max(box.width, box.height) * depth / (n - 1) : 0, z = new Map();
  parts.forEach(([slot, id], i) => { if (!z.has(slot)) z.set(slot, new Map()); z.get(slot).set(id, (i - (n - 1) / 2) * step); });
  const depths = new Map();
  for (const slot of slots) {
    const join = frame.objects[slot].join, at = join ? depths.get(join.target_object_slot)?.get(join.target_handle_id) ?? 0 : 0;
    depths.set(slot, new Map([[0, at], ...(z.get(slot) ?? new Map())]));
  }
  return depths;
}

/**
 * Depth from a side view of the same assembly in another frame (a turnaround).
 * Pieces of the same figure type are matched by their height on the body. A matched joint's depth is its horizontal offset
 * from the side view's root, scaled to the front view's height; the facing is
 * chosen so later-drawn pieces come toward the camera. Unmatched pieces sit
 * flat at their attachment. Returns {depths, matched, total, facing}.
 */
export function sideViewAssemblyDepths(report, frame, slots, sideFrame, {geometry = buildGeometry(report, frame)} = {}) {
  const types = new Map(report.figure_types.map(f => [f.figure_type_id, f])), rootType = frame.objects[slots[0]].figure_type_id;
  // The side view's assembly: the largest one whose root has the same figure type.
  let side = null;
  for (const [slot, object] of sideFrame.objects.entries()) if (!object.join && object.figure_type_id === rootType) {
    const candidate = assemblySlots(sideFrame, object.unique_id);
    if (!side || candidate.length > side.length) side = candidate;
  }
  if (!side) return {depths: null, matched: 0, total: slots.length, facing: 1};
  // A turnaround keeps every part at the same height in every view, so pieces
  // of one figure type are paired by their height on the body (normalized to
  // each view's bounds), nearest first. Join paths often differ between views.
  const sideGeometry = buildGeometry(report, sideFrame), sideRoot = sideGeometry.objects.get(side[0]).root;
  const frontBox = bounds(geometry, slots), sideBox = bounds(sideGeometry, side);
  const height = (g, slot, box) => { const o = g.objects.get(slot), ys = [...(o?.joints.values() ?? [])].map(p => p.y); return ys.length ? (ys.reduce((a, b) => a + b, 0) / ys.length - box.y0) / box.height : 0; };
  const byType = new Map();
  for (const slot of side) { const t = sideFrame.objects[slot].figure_type_id; byType.set(t, [...(byType.get(t) ?? []), {slot, h: height(sideGeometry, slot, sideBox)}]); }
  const candidates = [];
  for (const slot of slots) {
    const h = height(geometry, slot, frontBox);
    for (const other of byType.get(frame.objects[slot].figure_type_id) ?? []) candidates.push([Math.abs(h - other.h), slot, other.slot]);
  }
  candidates.sort((a, b) => a[0] - b[0]);
  const match = new Map(), taken = new Set();
  for (const [gap, slot, other] of candidates) if (gap < 0.08 && !match.has(slot) && !taken.has(other)) { match.set(slot, other); taken.add(other); }
  const scale = frontBox.height / sideBox.height;
  const raw = new Map();
  for (const slot of slots) {
    const other = match.get(slot);
    if (other === undefined) { raw.set(slot, null); continue; }
    const g = sideGeometry.objects.get(other), z = new Map([[0, (g.root.x - sideRoot.x) * scale]]);
    for (const [id, p] of g.joints) if (id !== 0) z.set(id, (p.x - sideRoot.x) * scale);
    raw.set(slot, z);
  }
  // Facing: correlate matched pieces' mean depth with front draw order.
  const order = frameOrder(frame), rank = new Map(order.map((uid, i) => [uid, i])), pairs = [];
  for (const [slot, z] of raw) if (z) pairs.push([rank.get(frame.objects[slot].unique_id) ?? slot, [...z.values()].reduce((a, b) => a + b, 0) / z.size]);
  const mean = k => pairs.reduce((s, p) => s + p[k], 0) / Math.max(1, pairs.length), ma = mean(0), mb = mean(1);
  const facing = pairs.reduce((s, [a, b]) => s + (a - ma) * (b - mb), 0) < 0 ? -1 : 1;
  const depths = new Map();
  for (const slot of slots) {
    const z = raw.get(slot);
    depths.set(slot, z ? new Map([...z].map(([id, v]) => [id, v * facing])) : flatPiece(frame, slot, types.get(frame.objects[slot].figure_type_id), depths));
  }
  return {depths, matched: match.size, total: slots.length, facing};
}

/** Per-piece depths relative to the piece's own root (its attachment). */
export function relativeDepths(absolute) {
  const out = new Map();
  for (const [slot, z] of absolute) { const base = z.get(0) ?? 0; out.set(slot, new Map([...z].map(([id, v]) => [id, v - base]))); }
  return out;
}
