// 3D stick building: Styk Builder's joints and lines, in 3D. Each line is a
// shape (capsule, tube, box, ball or a flat ribbon for hair) with a thickness
// at each end, a bulge, a width and depth, a roll and (ribbons) a twist. The
// lines are the skeleton: every line is a bone unless it is static, when it
// rides on the nearest posable line above it. Characters are built as pieces
// (a body, an arm, a hair lock) and a piece's first joint snaps onto a joint
// of another piece.
//
// The sticks live in `model.sticks`; `generateSticks(model)` turns them into
// ordinary parts and bones (marked with `stick`), bound exactly to their
// lines, so the viewport, toon look, outlines and Add to animation work on
// them as on any part.

import {add, sub, scale, cross, length, normalize, recalculateNormals} from './mesh.mjs';
import {uniqueName} from './armature.mjs';

export const STICK_SHAPES = ['capsule', 'tube', 'box', 'ball', 'ribbon'];
/** A new line's shape. Thicknesses are radii in model units (a ribbon's are half-widths). */
export const SHAPE_DEFAULTS = Object.freeze({kind: 'capsule', start: .05, end: .05, bulge: 0, width: 1, depth: 1, roll: 0, twist: 0});
const LIMITS = {start: [.002, 2], end: [.002, 2], bulge: [-1, 2], width: [.05, 8], depth: [.02, 8], roll: [-360, 360], twist: [-720, 720]};

export function emptySticks() { return {joints: [], lines: [], pieces: [], nextId: 1}; }
const stickId = sticks => sticks.nextId++;
export const jointOf = (sticks, id) => sticks.joints.find(j => j.id === id);
export const lineOf = (sticks, id) => sticks.lines.find(l => l.id === id);
export const pieceOf = (sticks, id) => sticks.pieces.find(p => p.id === id);
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/** Clean a shape: known kind, numbers in range; anything missing takes the default. */
export function readShape(value = {}) {
  const shape = {kind: STICK_SHAPES.includes(value.kind) ? value.kind : SHAPE_DEFAULTS.kind};
  for (const key of Object.keys(LIMITS)) { const v = Number(value[key]); shape[key] = Number.isFinite(v) ? clamp(v, LIMITS[key]) : SHAPE_DEFAULTS[key]; }
  return shape;
}

/** A new piece: its own first joint at `at`. */
export function addPiece(sticks, {name = '', at = [0, 0, 0]} = {}) {
  const joint = {id: stickId(sticks), at: at.slice(), piece: 0};
  const piece = {id: stickId(sticks), name: name || `Piece ${sticks.pieces.length + 1}`, root: joint.id, attach: null};
  joint.piece = piece.id;
  sticks.joints.push(joint); sticks.pieces.push(piece);
  return piece;
}

/** A line from joint `from` to a new joint at `at`, in the same piece. */
export function addLine(sticks, from, at, {shape = {}, color = 1, staticLine = false, name = ''} = {}) {
  const start = jointOf(sticks, from);
  if (!start) throw new Error('Start a line from a joint.');
  const joint = {id: stickId(sticks), at: at.slice(), piece: start.piece};
  // Named when drawn (Line 1, Line 2 …), so its bone keeps the name the animation knows it by.
  const taken = new Set(sticks.lines.map(l => l.name));
  if (!name) for (let n = sticks.lines.length + 1; ; n++) if (!taken.has(`Line ${n}`)) { name = `Line ${n}`; break; }
  const line = {id: stickId(sticks), from, to: joint.id, piece: start.piece, shape: readShape(shape), color, static: Boolean(staticLine), name};
  sticks.joints.push(joint); sticks.lines.push(line);
  return line;
}

/** The line ending at a joint (each joint but a piece's first has exactly one). */
export const lineInto = (sticks, joint) => sticks.lines.find(l => l.to === joint);
/** Lines starting at a joint. */
export const linesFrom = (sticks, joint) => sticks.lines.filter(l => l.from === joint);

/** The line above this one: the one ending where it starts, or, at an
 * attached piece's first joint, the line ending at the joint it is attached to. */
export function parentLine(sticks, line) {
  const up = lineInto(sticks, line.from);
  if (up) return up;
  const piece = pieceOf(sticks, line.piece);
  return piece?.root === line.from && piece.attach != null ? lineInto(sticks, piece.attach) ?? null : null;
}
/** The line whose bone moves this one: itself, or for a static line the nearest posable line above it. */
export function posableLine(sticks, line) {
  for (let l = line, guard = 0; l && guard <= sticks.lines.length; l = parentLine(sticks, l), guard++) if (!l.static) return l;
  return null;
}

/** Joints below a joint (not including it), within its piece and in pieces attached below. */
export function jointsBelow(sticks, joint) {
  const out = [], queue = [joint];
  for (let i = 0; i < queue.length; i++) {
    for (const l of linesFrom(sticks, queue[i])) { out.push(l.to); queue.push(l.to); }
    for (const p of sticks.pieces) if (p.attach === queue[i]) { out.push(p.root); queue.push(p.root); }
  }
  return out;
}

/** Move a joint to `at`; the joints below it move along unless `alone`. */
export function moveJoint(sticks, id, at, {alone = false} = {}) {
  const joint = jointOf(sticks, id); if (!joint) return;
  const delta = sub(at, joint.at);
  const piece = pieceOf(sticks, joint.piece);
  // A piece's first joint, attached, stays on its joint: move the joint it sits on instead.
  if (piece?.root === id && piece.attach != null) return;
  joint.at = at.slice();
  if (!alone) for (const j of jointsBelow(sticks, id)) { const q = jointOf(sticks, j); q.at = add(q.at, delta); }
  settlePieces(sticks);
}

/** Remove a line and everything below it (pieces attached below are let go, not deleted). */
export function deleteLine(sticks, id) {
  const line = lineOf(sticks, id); if (!line) return;
  const gone = new Set([line.to]), queue = [line.to];
  for (let i = 0; i < queue.length; i++) for (const l of linesFrom(sticks, queue[i])) { gone.add(l.to); queue.push(l.to); }
  sticks.lines = sticks.lines.filter(l => !gone.has(l.to));
  sticks.joints = sticks.joints.filter(j => !gone.has(j.id));
  for (const p of sticks.pieces) if (gone.has(p.attach)) p.attach = null;
}

/** Remove a whole piece, letting go of the pieces attached to it. */
export function deletePiece(sticks, id) {
  const joints = new Set(sticks.joints.filter(j => j.piece === id).map(j => j.id));
  sticks.joints = sticks.joints.filter(j => j.piece !== id);
  sticks.lines = sticks.lines.filter(l => l.piece !== id);
  sticks.pieces = sticks.pieces.filter(p => p.id !== id);
  for (const p of sticks.pieces) if (joints.has(p.attach)) p.attach = null;
}

/** Pieces hanging (directly or not) from this piece. */
function piecesBelow(sticks, pieceId) {
  const out = new Set([pieceId]);
  for (let grew = true; grew;) { grew = false; for (const p of sticks.pieces) if (!out.has(p.id) && p.attach != null && out.has(jointOf(sticks, p.attach)?.piece)) { out.add(p.id); grew = true; } }
  return out;
}

/** Snap a piece's first joint onto `joint` of another piece: the whole piece
 * (and what hangs from it) moves there and follows it from now on. */
export function attachPiece(sticks, pieceId, joint) {
  const piece = pieceOf(sticks, pieceId), target = jointOf(sticks, joint);
  if (!piece || !target) throw new Error('Pick a joint to attach the piece to.');
  if (piecesBelow(sticks, pieceId).has(target.piece)) throw new Error('A piece can’t hang from itself or from a piece hanging from it.');
  piece.attach = joint;
  settlePieces(sticks);
}
export function detachPiece(sticks, pieceId) { const piece = pieceOf(sticks, pieceId); if (piece) piece.attach = null; }

/** Keep every attached piece on its joint (after a move): shift each piece,
 * with what hangs from it, so its first joint sits on the joint it is attached to. */
export function settlePieces(sticks) {
  for (let pass = 0; pass <= sticks.pieces.length; pass++) {
    let moved = false;
    for (const piece of sticks.pieces) {
      if (piece.attach == null) continue;
      const root = jointOf(sticks, piece.root), target = jointOf(sticks, piece.attach);
      if (!root || !target) { piece.attach = null; continue; }
      const delta = sub(target.at, root.at);
      if (length(delta) < 1e-12) continue;
      const pieces = piecesBelow(sticks, piece.id);
      for (const j of sticks.joints) if (pieces.has(j.piece)) j.at = add(j.at, delta);
      root.at = target.at.slice(); // exactly on it, not off by rounding
      moved = true;
    }
    if (!moved) return;
  }
}

/** Copy a line and everything below it across X = 0, starting from the
 * mirrored joint (the same joint when it sits on the middle). Returns the new lines. */
export function mirrorLines(sticks, id) {
  const line = lineOf(sticks, id); if (!line) return [];
  const flip = p => [-p[0], p[1], p[2]];
  const start = jointOf(sticks, line.from);
  const mirrorStart = Math.abs(start.at[0]) < 1e-6 ? start
    : sticks.joints.filter(j => j.piece === start.piece && length(sub(j.at, flip(start.at))) < 1e-4)[0];
  if (!mirrorStart) throw new Error('There is no joint on the other side to start the copy from.');
  const made = [], copy = (l, from) => {
    const next = addLine(sticks, from, flip(jointOf(sticks, l.to).at), {shape: {...l.shape, roll: -l.shape.roll, twist: -l.shape.twist}, color: l.color, staticLine: l.static, name: mirrorName(l.name)});
    made.push(next);
    for (const child of linesFrom(sticks, l.to)) copy(child, next.to);
  };
  copy(line, mirrorStart.id);
  return made;
}
// Side names swap (Arm.L ↔ Arm.R); other copies get the next Line number.
const mirrorName = name => /\.L$/.test(name) ? name.replace(/\.L$/, '.R') : /\.R$/.test(name) ? name.replace(/\.R$/, '.L') : '';

// ---------- shapes ----------

/** Directions across a line from a to b: side (u, width) and front (v, depth), turned by `roll` degrees. */
export function lineFrame(a, b, roll = 0) {
  const d = normalize(sub(b, a));
  const ref = Math.abs(d[2]) < .9 ? [0, 0, 1] : [0, 1, 0];
  let u = normalize(cross(d, ref)); if (length(u) < .5) u = [1, 0, 0];
  let v = normalize(cross(u, d));
  const r = roll * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  [u, v] = [add(scale(u, c), scale(v, s)), add(scale(v, c), scale(u, -s))];
  return {d, u, v};
}

/** The 3D shape of a line from a to b, as a mesh in model space (faces colored `color`). */
export function shapeMesh(a, b, value, color = 1) {
  const shape = readShape(value), L = length(sub(b, a));
  if (!(L > 1e-6)) throw new Error('This line has no length.');
  const {kind, start, end, bulge, width, depth, roll, twist} = shape;
  const {d, u, v} = lineFrame(a, b, roll);
  const verts = [], faces = [];
  const along = t => add(a, scale(d, L * t));
  const radius = t => (start + (end - start) * t) * (1 + bulge * Math.sin(Math.PI * t));
  const ring = (centre, r, n, offset = 0, w = width, h = depth) => {
    const first = verts.length;
    for (let k = 0; k < n; k++) { const th = offset + k / n * Math.PI * 2; verts.push(add(centre, add(scale(u, Math.cos(th) * r * w), scale(v, Math.sin(th) * r * h)))); }
    return first;
  };
  const bridge = (p, q, n) => { for (let k = 0; k < n; k++) faces.push({v: [p + k, p + (k + 1) % n, q + (k + 1) % n, q + k], c: color}); };
  const fan = (ringStart, n, pole, reverse) => { for (let k = 0; k < n; k++) faces.push({v: reverse ? [ringStart + (k + 1) % n, ringStart + k, pole] : [ringStart + k, ringStart + (k + 1) % n, pole], c: color}); };
  const cap = (ringStart, n, reverse) => { const f = Array.from({length: n}, (_, k) => ringStart + k); faces.push({v: reverse ? f.reverse() : f, c: color}); };

  if (kind === 'ribbon') {
    // A flat strip, half-width `start` to `end`, curled sideways by `bulge`, twisted along its length.
    const rows = bulge || twist ? 8 : 1;
    for (let i = 0; i <= rows; i++) {
      const t = i / rows, tw = (twist * t) * Math.PI / 180, side = add(scale(u, Math.cos(tw)), scale(v, Math.sin(tw)));
      const centre = add(along(t), scale(v, bulge * L * .25 * Math.sin(Math.PI * t))), half = (start + (end - start) * t) * width;
      verts.push(add(centre, scale(side, -half)), add(centre, scale(side, half)));
      if (i) faces.push({v: [2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i], c: color});
    }
    return {verts, faces};
  }
  if (kind === 'ball') {
    // The line is the ball's diameter, as a Styk circle; width and depth squash it across.
    const rows = 8, n = 12, centre = along(.5), R = L / 2;
    verts.push(a.slice());
    const rings = [];
    for (let i = 1; i < rows; i++) { const phi = i / rows * Math.PI; rings.push(ring(add(centre, scale(d, -R * Math.cos(phi))), R * Math.sin(phi), n)); }
    verts.push(b.slice());
    fan(rings[0], n, 0, true);
    for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], n);
    fan(rings.at(-1), n, verts.length - 1, false);
    return finish({verts, faces});
  }
  const n = kind === 'box' ? 4 : 12, offset = kind === 'box' ? Math.PI / 4 : 0, scaleBox = kind === 'box' ? Math.SQRT2 : 1;
  const rows = bulge ? 6 : 1, rings = [];
  if (kind === 'capsule') {
    // Rounded ends: quarter circles of the end radius past each joint, as Styk's round line caps.
    const H = 3;
    verts.push(add(a, scale(d, -start)));
    const poleA = verts.length - 1;
    for (let j = H - 1; j >= 1; j--) { const phi = j / H * Math.PI / 2; rings.push(ring(add(a, scale(d, -start * Math.sin(phi))), start * Math.cos(phi), n)); }
    for (let i = 0; i <= rows; i++) rings.push(ring(along(i / rows), radius(i / rows), n));
    for (let j = 1; j < H; j++) { const phi = j / H * Math.PI / 2; rings.push(ring(add(b, scale(d, end * Math.sin(phi))), end * Math.cos(phi), n)); }
    verts.push(add(b, scale(d, end)));
    const poleB = verts.length - 1;
    fan(rings[0], n, poleA, true);
    for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], n);
    fan(rings.at(-1), n, poleB, false);
    return finish({verts, faces});
  }
  for (let i = 0; i <= rows; i++) rings.push(ring(along(i / rows), radius(i / rows) * scaleBox, n, offset));
  cap(rings[0], n, true);
  for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], n);
  cap(rings.at(-1), n, false);
  return finish({verts, faces});
}
/** Closed shapes face outward. */
function finish(mesh) { recalculateNormals(mesh); return mesh; }

// ---------- into parts and bones ----------

/**
 * Rebuild the parts and bones made from the sticks. Other parts and bones
 * (imported, added by hand) are kept. Ids stay with their lines, so
 * selection, outline and visibility settings carry over.
 */
export function generateSticks(model) {
  const sticks = model.sticks;
  if (!sticks) return model;
  settlePieces(sticks);
  const oldParts = new Map(model.parts.filter(p => p.stick != null).map(p => [p.stick, p]));
  const oldBones = new Map(model.bones.filter(b => b.stick != null).map(b => [b.stick, b]));
  model.parts = model.parts.filter(p => p.stick == null);
  model.bones = model.bones.filter(b => b.stick == null);
  const at = id => jointOf(sticks, id).at;
  // Bones first (parents before children), so each line knows its bone.
  const boneOf = new Map(), ordered = [], seen = new Set();
  const visit = line => { if (seen.has(line.id)) return; seen.add(line.id); const up = parentLine(sticks, line); if (up) visit(up); ordered.push(line); };
  sticks.lines.forEach(visit);
  for (const line of ordered) {
    if (line.static) continue;
    const old = oldBones.get(line.id), up = parentLine(sticks, line), upPosable = up ? posableLine(sticks, up) : null;
    const bone = {...(old ?? {}), id: old?.id ?? model.nextId++, name: '', head: at(line.from).slice(), tail: at(line.to).slice(), parent: upPosable ? boneOf.get(upPosable.id) ?? 0 : 0, stick: line.id};
    bone.name = uniqueName(model, line.name || old?.name || `Line ${line.id}`);
    model.bones.push(bone); boneOf.set(line.id, bone.id);
  }
  for (const line of sticks.lines) {
    const a = at(line.from), b = at(line.to);
    if (!(length(sub(b, a)) > 1e-6)) continue;
    const mesh = shapeMesh(a, b, line.shape, line.color);
    const posable = posableLine(sticks, line), bone = posable ? boneOf.get(posable.id) : null;
    if (bone) mesh.vdata = {skin: Object.fromEntries(mesh.verts.map((_, i) => [i, [[bone, 1]]]))};
    const old = oldParts.get(line.id);
    model.parts.push({...(old ?? {}), id: old?.id ?? model.nextId++, name: line.name || `${shapeName(line.shape.kind)} ${line.id}`, mesh,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: false, smooth: 0, visible: old?.visible !== false, stick: line.id});
  }
  return model;
}
const shapeName = kind => kind[0].toUpperCase() + kind.slice(1);

/** Clean stored sticks: joints with finite positions, lines between joints of
 * one piece forming trees, pieces with a first joint; attachments that would
 * loop are let go. Returns null when there is nothing usable. */
export function readSticks(value, paletteSize = Infinity) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.joints)) return null;
  const finite = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const sticks = emptySticks();
  const pieces = (Array.isArray(value.pieces) ? value.pieces : []).filter(p => Number.isInteger(p?.id));
  const pieceIds = new Set(pieces.map(p => p.id));
  sticks.joints = value.joints.filter(j => Number.isInteger(j?.id) && finite(j.at) && pieceIds.has(j.piece)).map(j => ({id: j.id, at: j.at.slice(), piece: j.piece}));
  const joints = new Map(sticks.joints.map(j => [j.id, j]));
  sticks.pieces = pieces.filter(p => joints.get(p.root)?.piece === p.id).map(p => ({id: p.id, name: String(p.name ?? '').slice(0, 80) || `Piece ${p.id}`, root: p.root, attach: Number.isInteger(p.attach) ? p.attach : null}));
  const ends = new Set(sticks.pieces.map(p => p.root));
  for (const l of Array.isArray(value.lines) ? value.lines : []) {
    const from = joints.get(l?.from), to = joints.get(l?.to);
    if (!Number.isInteger(l?.id) || !from || !to || from.piece !== to.piece || ends.has(to.id)) continue;
    ends.add(to.id);
    const color = Number.isInteger(l.color) && l.color >= 0 && l.color < paletteSize ? l.color : 1;
    sticks.lines.push({id: l.id, from: from.id, to: to.id, piece: from.piece, shape: readShape(l.shape), color, static: Boolean(l.static), name: String(l.name ?? '').slice(0, 80)});
  }
  // Every line must reach its piece's first joint going up (no loops, nothing floating).
  const pieceRoot = new Map(sticks.pieces.map(p => [p.id, p.root]));
  sticks.lines = sticks.lines.filter(l => { let j = l.from; for (let guard = 0; guard <= sticks.lines.length; guard++) { if (j === pieceRoot.get(l.piece)) return true; const up = sticks.lines.find(x => x.to === j); if (!up) return false; j = up.from; } return false; });
  const used = new Set([...sticks.pieces.map(p => p.root), ...sticks.lines.map(l => l.to)]);
  sticks.joints = sticks.joints.filter(j => used.has(j.id));
  for (const p of sticks.pieces) if (p.attach != null && (!joints.has(p.attach) || !used.has(p.attach) || piecesBelow(sticks, p.id).has(joints.get(p.attach).piece))) p.attach = null;
  const ids = [...sticks.joints, ...sticks.lines, ...sticks.pieces].map(x => x.id);
  sticks.nextId = Math.max(Number.isInteger(value.nextId) ? value.nextId : 1, ...ids.map(i => i + 1), 1);
  return sticks;
}
