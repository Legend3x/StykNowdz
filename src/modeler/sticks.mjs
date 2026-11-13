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

import {add, sub, scale, dot, cross, length, normalize, recalculateNormals} from './mesh.mjs';
import {uniqueName} from './armature.mjs';

/** Shapes, as in Build's segment Shape list (Stick Nodes' Triangle, Trapezoid,
 * Ellipse and Polygon included), plus Plane: a flat strip for hair. */
export const STICK_SHAPES = ['line', 'squareLine', 'circle', 'circleFill', 'circleClear', 'triangle', 'trapezoid', 'ellipse', 'polygon', 'plane'];
/** Shapes that bend along a curve (Build curves lines and trapezoids; a plane bends for hair). */
export const CURVED_SHAPES = new Set(['line', 'squareLine', 'trapezoid', 'plane']);
/** Shapes with a thickness for each end. */
export const TWO_ENDS = new Set(['trapezoid', 'plane', 'triangle']);
/** Names stored by the first version of Build mode. */
const OLD_KINDS = {capsule: 'line', tube: 'trapezoid', box: 'squareLine', ball: 'circleFill', ribbon: 'plane'};
/**
 * A new line's shape. Thicknesses are radii in model units (a plane's are
 * half-widths). Curve is how far the middle of the line bows out (model
 * units), toward Bend direction (degrees around the line); Circular arc bends
 * it along a circle instead of a smooth parabola.
 */
export const SHAPE_DEFAULTS = Object.freeze({kind: 'line', start: .04, end: .04, bulge: 0, width: 1, depth: 1, roll: 0, twist: 0,
  curve: 0, bend: 0, arc: false, roundStart: false, roundEnd: false, tip: 0, flip: false, half: false, sides: 6});
const LIMITS = {start: [.002, 2], end: [.002, 2], bulge: [-1, 2], width: [.05, 8], depth: [.02, 8], roll: [-360, 360], twist: [-720, 720], curve: [-20, 20], bend: [-360, 360], sides: [3, 12]};
const FLAGS = ['arc', 'roundStart', 'roundEnd', 'flip', 'half'];

export function emptySticks() { return {joints: [], lines: [], pieces: [], fills: [], heads: [], nextId: 1}; }
const stickId = sticks => sticks.nextId++;
export const jointOf = (sticks, id) => sticks.joints.find(j => j.id === id);
export const lineOf = (sticks, id) => sticks.lines.find(l => l.id === id);
export const pieceOf = (sticks, id) => sticks.pieces.find(p => p.id === id);
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/** Clean a shape: known kind, numbers in range; anything missing takes the default. */
export function readShape(value = {}) {
  const kind = OLD_KINDS[value.kind] ?? value.kind;
  const shape = {kind: STICK_SHAPES.includes(kind) ? kind : SHAPE_DEFAULTS.kind};
  for (const key of Object.keys(LIMITS)) { const v = Number(value[key]); shape[key] = Number.isFinite(v) ? clamp(v, LIMITS[key]) : SHAPE_DEFAULTS[key]; }
  shape.sides = Math.round(shape.sides);
  for (const key of FLAGS) shape[key] = Boolean(value[key]);
  shape.tip = [-1, 0, 1].includes(Math.sign(Number(value.tip) || 0)) ? Math.sign(Number(value.tip) || 0) : 0;
  if (value.kind === 'capsule') { shape.roundStart = shape.roundEnd = true; }
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
export function addLine(sticks, from, at, {shape = {}, color = 1, staticLine = false, guide = false, name = ''} = {}) {
  const start = jointOf(sticks, from);
  if (!start) throw new Error('Start a line from a joint.');
  const joint = {id: stickId(sticks), at: at.slice(), piece: start.piece};
  // Named when drawn (Line 1, Line 2 …), so its bone keeps the name the animation knows it by.
  const taken = new Set(sticks.lines.map(l => l.name));
  if (!name) for (let n = sticks.lines.length + 1; ; n++) if (!taken.has(`Line ${n}`)) { name = `Line ${n}`; break; }
  const line = {id: stickId(sticks), from, to: joint.id, piece: start.piece, shape: readShape(shape), color, static: Boolean(staticLine), name};
  if (guide) line.guide = true;
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
/** Whether a line has a bone of its own: not static, not a guide. */
export const posable = line => !line.static && !line.guide;
/** The line whose bone moves this one: itself, or for a static line or a
 * guide the nearest posable line above it. */
export function posableLine(sticks, line) {
  for (let l = line, guard = 0; l && guard <= sticks.lines.length; l = parentLine(sticks, l), guard++) if (posable(l)) return l;
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
  tidyFills(sticks);
}

/** Remove a whole piece, letting go of the pieces attached to it. */
export function deletePiece(sticks, id) {
  const joints = new Set(sticks.joints.filter(j => j.piece === id).map(j => j.id));
  sticks.joints = sticks.joints.filter(j => j.piece !== id);
  sticks.lines = sticks.lines.filter(l => l.piece !== id);
  sticks.pieces = sticks.pieces.filter(p => p.id !== id);
  for (const p of sticks.pieces) if (joints.has(p.attach)) p.attach = null;
  tidyFills(sticks);
  tidyHeads(sticks);
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
  const made = [], twin = new Map([[start.id, mirrorStart.id]]), copy = (l, from) => {
    const next = addLine(sticks, from, flip(jointOf(sticks, l.to).at), {shape: {...l.shape, roll: -l.shape.roll, twist: -l.shape.twist, bend: -l.shape.bend, tip: -l.shape.tip}, color: l.color, staticLine: l.static, guide: l.guide, name: mirrorName(l.name)});
    made.push(next); twin.set(l.to, next.to);
    for (const child of linesFrom(sticks, l.to)) copy(child, next.to);
  };
  copy(line, mirrorStart.id);
  // Poly fills within the copied branch come along too.
  for (const f of [...(sticks.fills ?? [])]) if (f.joints.every(j => twin.has(j)) && f.joints.some(j => j !== start.id)) addFill(sticks, f.joints.map(j => twin.get(j)), {color: f.color, inflate: f.inflate, smooth: f.smooth});
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

/** The direction a line bows toward: `bend` degrees around the line from its side direction. */
export function bendDirection(a, b, shape) {
  const {u, v} = lineFrame(a, b, shape.roll), angle = shape.bend * Math.PI / 180;
  return add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle)));
}

/** Where the middle of a line runs, t from 0 (start joint) to 1 (end joint):
 * straight, or bowed by its curve (a parabola, or a circular arc). */
export function linePath(a, b, value) {
  const shape = readShape(value), D = sub(b, a), L = length(D), curve = CURVED_SHAPES.has(shape.kind) ? shape.curve : 0;
  if (Math.abs(curve) < 1e-9 || !(L > 1e-9)) return t => add(a, scale(D, t));
  const side = scale(bendDirection(a, b, shape), Math.sign(curve)), h = Math.abs(curve), d = scale(D, 1 / L);
  if (!shape.arc) return t => add(add(a, scale(D, t)), scale(side, h * 4 * t * (1 - t)));
  // The circle through both joints whose middle stands h off the line between them.
  const c = L / 2, R = (c * c + h * h) / (2 * h), mid = add(a, scale(D, .5));
  const end = Math.atan2(R - h, c), first = Math.PI - end, sweep = 2 * end - Math.PI;
  return t => { const angle = first + sweep * t; return add(mid, add(scale(d, R * Math.cos(angle)), scale(side, h - R + R * Math.sin(angle)))); };
}

/** Points along a path with a frame that turns with it (no twisting): rows+1 samples. */
function pathFrames(path, u0, rows) {
  const out = [], e = 1e-4;
  let u = u0;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, p = path(t), T = normalize(sub(path(Math.min(1, t + e)), path(Math.max(0, t - e))));
    u = normalize(sub(u, scale(T, dot(T, u)))); if (length(u) < .5) u = normalize(cross(T, Math.abs(T[2]) < .9 ? [0, 0, 1] : [0, 1, 0]));
    out.push({t, p, T, u, v: cross(u, T)});
  }
  return out;
}

/** The 3D shape of a line from a to b, as a mesh in model space (faces colored `color`). */
export function shapeMesh(a, b, value, color = 1) {
  const shape = readShape(value), L = length(sub(b, a));
  if (!(L > 1e-6)) throw new Error('This line has no length.');
  const {kind, start, end, bulge, width, depth, roll, twist} = shape;
  const {d, u, v} = lineFrame(a, b, roll);
  const verts = [], faces = [];
  const push = p => { verts.push(p); return verts.length - 1; };
  const ringAt = (centre, U, V, r, n, offset = 0, w = width, h = depth, from = 0, to = Math.PI * 2, closed = true) => {
    const first = verts.length, count = closed ? n : n + 1;
    for (let k = 0; k < count; k++) { const th = from + offset + k / n * (to - from); verts.push(add(centre, add(scale(U, Math.cos(th) * r * w), scale(V, Math.sin(th) * r * h)))); }
    return first;
  };
  // Quads between two rings of n points (closed), or two arcs of n + 1 points (open).
  const bridge = (p, q, n, closed = true) => { for (let k = 0; k < n; k++) { const k1 = closed ? (k + 1) % n : k + 1; faces.push({v: [p + k, p + k1, q + k1, q + k], c: color}); } };
  const fan = (ringStart, n, pole) => { for (let k = 0; k < n; k++) faces.push({v: [ringStart + k, ringStart + (k + 1) % n, pole], c: color}); };
  const cap = (ringStart, n) => faces.push({v: Array.from({length: n}, (_, k) => ringStart + k), c: color});
  const done = () => { const mesh = {verts, faces}; recalculateNormals(mesh); return mesh; };
  const bulgeAt = t => 1 + bulge * Math.sin(Math.PI * t);

  if (kind === 'plane') {
    // A flat strip, half-width start to end, curled sideways by Bulge, twisted along its length, bent by its curve.
    const rows = bulge || twist || shape.curve ? 10 : 1, frames = pathFrames(linePath(a, b, shape), u, rows);
    for (const f of frames) {
      const tw = twist * f.t * Math.PI / 180, side = add(scale(f.u, Math.cos(tw)), scale(f.v, Math.sin(tw)));
      const centre = add(f.p, scale(f.v, bulge * L * .25 * Math.sin(Math.PI * f.t))), half = (start + (end - start) * f.t) * width;
      verts.push(add(centre, scale(side, -half)), add(centre, scale(side, half)));
      const i = verts.length / 2 - 1;
      if (i) faces.push({v: [2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i], c: color});
    }
    return {verts, faces};
  }
  if (['circle', 'circleFill', 'ellipse', 'polygon'].includes(kind)) {
    // The line is the diameter, as a Styk circle. An ellipse is as wide as its
    // thickness; a polygon is a faceted ball of that many sides; a half ellipse
    // keeps one side of the line.
    const ellipse = kind === 'ellipse', n = kind === 'polygon' ? shape.sides : 12, rows = kind === 'polygon' ? Math.max(2, Math.ceil(shape.sides / 2)) : 8;
    const R = L / 2, across = ellipse ? start / R : 1, centre = add(a, scale(d, R));
    const half = ellipse && shape.half, arcFrom = half ? (shape.flip ? Math.PI / 2 : -Math.PI / 2) : 0, arcTo = half ? arcFrom + Math.PI : Math.PI * 2, m = half ? 6 : n;
    const poleA = push(a.slice()), rings = [];
    for (let i = 1; i < rows; i++) { const phi = i / rows * Math.PI; rings.push(ringAt(add(centre, scale(d, -R * Math.cos(phi))), u, v, R * Math.sin(phi) * across, m, 0, width, depth, arcFrom, arcTo, !half)); }
    const poleB = push(b.slice());
    if (!half) {
      fan(rings[0], n, poleA);
      for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], n);
      fan(rings.at(-1), n, poleB);
      return done();
    }
    // Half: arcs of m+1 points; the cut is one flat face through both poles.
    for (let k = 0; k < m; k++) faces.push({v: [rings[0] + k, rings[0] + k + 1, poleA], c: color});
    for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], m, false);
    for (let k = 0; k < m; k++) faces.push({v: [rings.at(-1) + k, rings.at(-1) + k + 1, poleB], c: color});
    faces.push({v: [poleA, ...rings.map(r => r), poleB, ...rings.map(r => r + m).reverse()], c: color});
    return done();
  }
  if (kind === 'circleClear') {
    // A ring: the line is its diameter, in the plane of the line and its side; Width is how thick the band is.
    const R = L / 2, centre = add(a, scale(d, R)), N = 24, n = 8, rings = [];
    for (let i = 0; i < N; i++) {
      const th = i / N * Math.PI * 2, dir = add(scale(d, Math.cos(th)), scale(u, Math.sin(th) * width));
      rings.push(ringAt(add(centre, scale(dir, R)), normalize(dir), v, start, n, 0, 1, depth));
    }
    for (let i = 0; i < N; i++) bridge(rings[i], rings[(i + 1) % N], n);
    return done();
  }
  if (kind === 'triangle') {
    // A cone: its base at the start joint (Flip: at the end), its tip at the other, leaning to one side with Tip.
    const [base, apex] = shape.flip ? [b, a] : [a, b], rows = 4;
    const tipAt = add(apex, scale(u, shape.tip * start * width));
    const rings = [];
    for (let i = 0; i < rows; i++) { const t = i / rows; rings.push(ringAt(add(base, scale(sub(tipAt, base), t)), u, v, start * (1 - t), 12)); }
    cap(rings[0], 12);
    for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], 12);
    fan(rings.at(-1), 12, push(tipAt));
    return done();
  }
  // Lines along their path: Round line (round ends), Square line (four sides,
  // flat ends), Trapezoid (a thickness per end, round ends when asked).
  const square = kind === 'squareLine', n = square ? 4 : 12, offset = square ? Math.PI / 4 : 0, k = square ? Math.SQRT2 : 1;
  const r0 = start, r1 = kind === 'trapezoid' ? end : start;
  const round = {start: kind === 'line' || (kind === 'trapezoid' && shape.roundStart), end: kind === 'line' || (kind === 'trapezoid' && shape.roundEnd)};
  const rows = Math.max(bulge ? 6 : 1, shape.curve ? 10 : 1), frames = pathFrames(linePath(a, b, shape), u, rows), rings = [];
  const radius = t => (r0 + (r1 - r0) * t) * bulgeAt(t), H = 3;
  let poleA = null;
  if (round.start) {
    const f = frames[0]; poleA = push(add(f.p, scale(f.T, -r0)));
    for (let j = H - 1; j >= 1; j--) { const phi = j / H * Math.PI / 2; rings.push(ringAt(add(f.p, scale(f.T, -r0 * Math.sin(phi))), f.u, f.v, r0 * Math.cos(phi) * k, n, offset)); }
  }
  for (const f of frames) rings.push(ringAt(f.p, f.u, f.v, radius(f.t) * k, n, offset));
  let poleB = null;
  if (round.end) {
    const f = frames.at(-1);
    for (let j = 1; j < H; j++) { const phi = j / H * Math.PI / 2; rings.push(ringAt(add(f.p, scale(f.T, r1 * Math.sin(phi))), f.u, f.v, r1 * Math.cos(phi) * k, n, offset)); }
    poleB = push(add(f.p, scale(f.T, r1)));
  }
  if (poleA != null) fan(rings[0], n, poleA); else cap(rings[0], n);
  for (let i = 1; i < rings.length; i++) bridge(rings[i - 1], rings[i], n);
  if (poleB != null) fan(rings.at(-1), n, poleB); else cap(rings.at(-1), n);
  return done();
}

/** A line's radius at one of its joints, for poly fills: as thick as the line is there. */
export function radiusAt(line, end) {
  const s = line.shape;
  if (['circle', 'circleFill', 'circleClear', 'ellipse', 'polygon'].includes(s.kind)) return null;
  const r = s.kind === 'trapezoid' || s.kind === 'triangle' || s.kind === 'plane' ? (end === 'start' ? s.start : s.end) : s.start;
  if (s.kind === 'triangle') return (s.flip ? end === 'end' : end === 'start') ? s.start : s.start * .1;
  return r * Math.sqrt(s.width * s.depth) * (s.kind === 'plane' ? .25 : 1);
}

// ---------- poly fills ----------

/** A fill through these joints, in order (Pivot's poly fill). */
export function addFill(sticks, joints, {color = 1, inflate = .3, smooth = 1, name = ''} = {}) {
  const ids = joints.filter((id, i) => jointOf(sticks, id) && joints.indexOf(id) === i);
  if (ids.length < 3) throw new Error('A poly fill needs at least three joints.');
  sticks.fills ??= [];
  const fill = {id: stickId(sticks), joints: ids, color, inflate, smooth, name};
  sticks.fills.push(fill);
  return fill;
}
export const fillOf = (sticks, id) => sticks.fills?.find(f => f.id === id);
export function deleteFill(sticks, id) { if (sticks.fills) sticks.fills = sticks.fills.filter(f => f.id !== id); }
/** Fills lose joints that are gone; a fill left with under three goes. */
function tidyFills(sticks) {
  if (!sticks.fills) return;
  const have = new Set(sticks.joints.map(j => j.id));
  for (const f of sticks.fills) f.joints = f.joints.filter(id => have.has(id));
  sticks.fills = sticks.fills.filter(f => f.joints.length >= 3);
}
/** The line between two joints, either way round, and whether it runs from the first to the second. */
function lineBetween(sticks, p, q) {
  const l = sticks.lines.find(x => (x.from === p && x.to === q) || (x.from === q && x.to === p));
  return l ? {line: l, forward: l.from === p} : null;
}
/** How thick a poly fill is at a joint: as the lines meeting there (the thickest), or a default. */
function jointRadius(sticks, joint) {
  const radii = [...linesFrom(sticks, joint).map(l => radiusAt(l, 'start')), ...sticks.lines.filter(l => l.to === joint).map(l => radiusAt(l, 'end'))].filter(r => r != null);
  return radii.length ? Math.max(...radii) : .03;
}

/**
 * A poly fill as a solid: its outline runs through its joints (along the
 * lines between them, curves included), its edge is rounded and as thick as
 * the lines meeting each joint, and its middle swells by Inflate. Built as
 * rings from the edge in to the middle on both faces, joined round the rim,
 * so it is a closed surface like the lines' shapes.
 */
export function fillMesh(sticks, fill) {
  const outline = [], radii = [];
  const ids = fill.joints;
  for (let i = 0; i < ids.length; i++) {
    const p = ids[i], q = ids[(i + 1) % ids.length], A = jointOf(sticks, p).at, B = jointOf(sticks, q).at;
    const rp = jointRadius(sticks, p), rq = jointRadius(sticks, q), between = lineBetween(sticks, p, q);
    const path = between ? linePath(jointOf(sticks, between.line.from).at, jointOf(sticks, between.line.to).at, between.line.shape) : null;
    const steps = between && between.line.shape.curve ? 8 : 3;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      outline.push(path ? path(between.forward ? t : 1 - t) : add(A, scale(sub(B, A), t)));
      radii.push(rp + (rq - rp) * t);
    }
  }
  return slabMesh(outline, radii, fill.inflate ?? 0, fill.color ?? 1);
}

/** Points along an open polyline at even spacing: `count` segments, ends kept. */
function resample(points, radii, count) {
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + length(sub(points[i], points[i - 1])));
  const total = along.at(-1), out = [], outR = [];
  for (let k = 0, i = 1; k <= count; k++) {
    const d = total * k / count;
    while (i < points.length - 1 && along[i] < d) i++;
    const span = along[i] - along[i - 1], t = span > 1e-12 ? Math.min(1, Math.max(0, (d - along[i - 1]) / span)) : 0;
    out.push(add(points[i - 1], scale(sub(points[i], points[i - 1]), t))); outR.push(radii[i - 1] + (radii[i] - radii[i - 1]) * t);
  }
  return {points: out, radii: outR, total};
}

/**
 * A closed outline made into a rounded slab of four-sided faces (Blender's
 * Grid fill, then given thickness): the outline is split into four sides at
 * its corners, a grid is stretched between them (a Coons patch, relaxed so
 * dents in the outline don't fold it), both faces are lifted off the outline's
 * plane, and a half-round rim as thick as the outline joins them.
 */
function slabMesh(outline, radii, inflate, color) {
  const m = outline.length, C = scale(outline.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / m);
  // The fill's facing (Newell's method).
  let n = [0, 0, 0];
  for (let i = 0; i < m; i++) { const p = outline[i], q = outline[(i + 1) % m]; n = add(n, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); }
  n = length(n) > 1e-12 ? normalize(n) : [0, 0, 1];
  // Across and up in its plane, from the world axis least along the facing (X for a fill drawn in Front view).
  const axis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].sort((a, b) => Math.abs(dot(a, n)) - Math.abs(dot(b, n)))[0];
  const e1 = normalize(sub(axis, scale(n, dot(axis, n)))), e2 = cross(n, e1);
  // Corners: the outline points furthest toward each diagonal, in the outline's order.
  const flat = outline.map(p => [dot(sub(p, C), e1), dot(sub(p, C), e2)]);
  let corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => flat.reduce((best, q, i) => q[0] * a + q[1] * b > flat[best][0] * a + flat[best][1] * b ? i : best, 0));
  corners = [...new Set(corners)].sort((a, b) => a - b);
  if (corners.length < 4) corners = [0, 1, 2, 3].map(k => Math.floor(k * m / 4));
  const sides = corners.map((c, k) => {
    const to = corners[(k + 1) % 4], pts = [], rs = [];
    for (let i = c; ; i = (i + 1) % m) { pts.push(outline[i]); rs.push(radii[i]); if (i === to) break; }
    return {pts, rs, len: resample(pts, rs, 1).total};
  });
  const P = sides.reduce((a, side) => a + side.len, 0) || 1, cells = 14;
  const A = Math.max(2, Math.min(cells - 2, Math.round(cells * (sides[0].len + sides[2].len) / P))), B = cells - A;
  const [s0, s1, s2, s3] = sides.map((side, k) => resample(side.pts, side.rs, k % 2 ? B : A));
  // The grid G[i][j] (i across 0..A, j up 0..B), its sides on the outline.
  const G = [], R = [];
  for (let i = 0; i <= A; i++) { G.push([]); R.push([]); }
  for (let i = 0; i <= A; i++) { G[i][0] = s0.points[i]; R[i][0] = s0.radii[i]; G[i][B] = s2.points[A - i]; R[i][B] = s2.radii[A - i]; }
  for (let j = 0; j <= B; j++) { G[A][j] = s1.points[j]; R[A][j] = s1.radii[j]; G[0][j] = s3.points[B - j]; R[0][j] = s3.radii[B - j]; }
  const coons = (F, i, j, mix) => {
    const u = i / A, v = j / B;
    return mix(mix(mix(mix(F[i][0], 1 - v, F[i][B], v), 1, F[0][j], 1 - u), 1, F[A][j], u), 1,
      mix(mix(mix(F[0][0], (1 - u) * (1 - v), F[A][0], u * (1 - v)), 1, F[0][B], (1 - u) * v), 1, F[A][B], u * v), -1);
  };
  const mixP = (a, wa, b, wb) => add(scale(a, wa), scale(b, wb)), mixR = (a, wa, b, wb) => a * wa + b * wb;
  for (let i = 1; i < A; i++) for (let j = 1; j < B; j++) { G[i][j] = coons(G, i, j, mixP); R[i][j] = Math.max(.001, coons(R, i, j, mixR)); }
  for (let pass = 0; pass < 24; pass++) for (let i = 1; i < A; i++) for (let j = 1; j < B; j++) {
    const mean = scale(add(add(G[i - 1][j], G[i + 1][j]), add(G[i][j - 1], G[i][j + 1])), .25);
    G[i][j] = add(scale(G[i][j], .4), scale(mean, .6));
  }
  // Lifted off the plane: as thick as the outline at the edge, domed toward the middle by Inflate.
  const spread = outline.reduce((a, p) => a + length(sub(p, C)), 0) / m, dome = Math.max(0, inflate) * spread * .5;
  const verts = [], faces = [];
  const top = [], bottom = [];
  for (let i = 0; i <= A; i++) { top.push([]); bottom.push([]); for (let j = 0; j <= B; j++) {
    const bump = Math.pow(Math.max(0, Math.sin(Math.PI * i / A) * Math.sin(Math.PI * j / B)), .6), h = R[i][j] + dome * bump;
    top[i][j] = verts.push(add(G[i][j], scale(n, h))) - 1; bottom[i][j] = verts.push(add(G[i][j], scale(n, -h))) - 1;
  } }
  for (let i = 0; i < A; i++) for (let j = 0; j < B; j++) {
    faces.push({v: [top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]], c: color});
    faces.push({v: [bottom[i][j + 1], bottom[i + 1][j + 1], bottom[i + 1][j], bottom[i][j]], c: color});
  }
  // The rim: half circles from the top face round the outline to the bottom face.
  const loop = [];
  for (let i = 0; i < A; i++) loop.push([i, 0]);
  for (let j = 0; j < B; j++) loop.push([A, j]);
  for (let i = A; i > 0; i--) loop.push([i, B]);
  for (let j = B; j > 0; j--) loop.push([0, j]);
  const L = loop.length, M = 4, rings = [loop.map(([i, j]) => top[i][j])];
  const outward = loop.map(([i, j], k) => { const [pi, pj] = loop[(k - 1 + L) % L], [qi, qj] = loop[(k + 1) % L]; const o = cross(sub(G[qi][qj], G[pi][pj]), n); return length(o) > 1e-12 ? normalize(o) : normalize(sub(G[i][j], C)); });
  for (let r = 1; r < M; r++) { const phi = r / M * Math.PI; rings.push(loop.map(([i, j], k) => verts.push(add(add(G[i][j], scale(outward[k], R[i][j] * Math.sin(phi))), scale(n, R[i][j] * Math.cos(phi)))) - 1)); }
  rings.push(loop.map(([i, j]) => bottom[i][j]));
  for (let r = 1; r < rings.length; r++) for (let k = 0; k < L; k++) faces.push({v: [rings[r - 1][k], rings[r - 1][(k + 1) % L], rings[r][(k + 1) % L], rings[r][k]], c: color});
  const mesh = {verts, faces}; recalculateNormals(mesh);
  return mesh;
}

// ---------- heads from a front and a side outline ----------

/** Defaults for a head: rows up, points around, how boxy the cross-section is,
 * how far the back of the head goes, the top and bottom domes, smoothing. */
export const HEAD_DEFAULTS = {rows: 12, around: 16, square: .25, back: 1, top: 1, bottom: 1, smooth: 1, whole: false};
const HEAD_LIMITS = {rows: [4, 32], around: [8, 32], square: [0, 1], back: [0, 3], top: [0, 3], bottom: [0, 3], smooth: [0, 2]};
export function readHeadShape(value = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(HEAD_DEFAULTS)) {
    if (typeof fallback === 'boolean') { out[key] = Boolean(value[key] ?? fallback); continue; }
    const v = Number(value[key]);
    out[key] = Number.isFinite(v) ? clamp(v, HEAD_LIMITS[key]) : fallback;
  }
  out.rows = Math.round(out.rows); out.around = Math.round(out.around / 4) * 4; out.smooth = Math.round(out.smooth);
  return out;
}

/** A head made from two traced pieces: `front` (its outline in Front view)
 * and `side` (its profile in Side view). The pieces' lines become guides. */
export function addHead(sticks, front, side, {color = 0, name = '', ...shape} = {}) {
  if (front === side) throw new Error('Pick two different pieces: the front outline, then the side profile.');
  for (const id of [front, side]) if (!sticks.lines.some(l => l.piece === id)) throw new Error('Each outline needs at least one line.');
  for (const l of sticks.lines) if (l.piece === front || l.piece === side) l.guide = true;
  sticks.heads ??= [];
  const head = {id: stickId(sticks), front, side, color, name, ...readHeadShape(shape)};
  sticks.heads.push(head);
  return head;
}
export const headOf = (sticks, id) => sticks.heads?.find(h => h.id === id);
export function deleteHead(sticks, id) { if (sticks.heads) sticks.heads = sticks.heads.filter(h => h.id !== id); }
function tidyHeads(sticks) {
  if (!sticks.heads) return;
  const have = new Set(sticks.pieces.map(p => p.id));
  sticks.heads = sticks.heads.filter(h => have.has(h.front) && have.has(h.side));
}

/** A piece's lines along their paths, flattened to [across, up]: X and Y (front), or Z and Y (side). */
function traced(sticks, piece, across) {
  const out = [];
  for (const l of sticks.lines) {
    if (l.piece !== piece) continue;
    const path = linePath(jointOf(sticks, l.from).at, jointOf(sticks, l.to).at, l.shape), steps = l.shape.curve ? 8 : 1;
    for (let k = 0; k < steps; k++) { const a = path(k / steps), b = path((k + 1) / steps); out.push([[a[across], a[1]], [b[across], b[1]]]); }
  }
  return out;
}
/** Where a traced piece crosses height y: its lowest and highest `across`. */
function spanAt(segments, y) {
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of segments) {
    if ((y - a[1]) * (y - b[1]) > 0 || a[1] === b[1]) continue;
    const h = a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return lo <= hi ? {lo, hi} : null;
}
/** Fill gaps (heights a piece doesn't reach) from the nearest row that has a value. */
function fillGaps(rows) {
  const have = rows.map((r, i) => r ? i : -1).filter(i => i >= 0);
  if (!have.length) return null;
  return rows.map((r, i) => r ?? rows[have.reduce((best, k) => Math.abs(k - i) < Math.abs(best - i) ? k : best, have[0])]);
}

/**
 * The head's mesh: rings of four-sided faces up the height of the front
 * outline, as wide as the front outline at each height and as deep as the side
 * profile, mirrored left and right, with domes at the top and bottom.
 * Front is +Z (the side profile's front is its furthest point toward +Z).
 * "Face only" (the default) reads the side outline as the face, from the ear
 * line forward; "whole" reads it as the whole head, front and back.
 */
export function headMesh(sticks, head) {
  const front = traced(sticks, head.front, 0), side = traced(sticks, head.side, 2);
  if (!front.length || !side.length) return null;
  const ys = front.flat().map(p => p[1]), yMin = Math.min(...ys), yMax = Math.max(...ys), tall = yMax - yMin;
  if (!(tall > 1e-4)) return null;
  // Rows run between the heights where the outline is still a third of its widest; above and
  // below, domes close the head up to the outline's top and down to its chin.
  const scan = Array.from({length: 121}, (_, i) => { const y = yMin + tall * (.005 + .99 * i / 120), w = spanAt(front, y); return {y, w: w ? w.hi - w.lo : 0}; });
  const widest = Math.max(...scan.map(r => r.w)), wide = scan.filter(r => r.w >= widest / 3);
  if (!wide.length) return null;
  const yLo = wide[0].y, yHi = wide.at(-1).y;
  // Rows closer together toward the ends, where the outline turns fastest.
  const rows = head.rows, N = head.around, heights = Array.from({length: rows}, (_, i) => yLo + (yHi - yLo) * (1 - Math.cos(Math.PI * i / (rows - 1))) / 2);
  const widths = fillGaps(heights.map(y => spanAt(front, y))), depths = fillGaps(heights.map(y => spanAt(side, y)));
  if (!widths || !depths) return null;
  const cx = widths.reduce((a, w) => a + (w.lo + w.hi) / 2, 0) / rows;
  const curve = t => Math.sign(t) * Math.pow(Math.abs(t), 2 / (2 + 2 * head.square));
  const verts = [], faces = [], color = head.color ?? 0, rings = [];
  const ring = (y, W, zm, df, db) => { const first = verts.length; for (let k = 0; k < N; k++) { const a = 2 * Math.PI * k / N, s = Math.sin(a), c = Math.cos(a); verts.push([cx + W * curve(s), y, zm + (c >= 0 ? df : db) * curve(c)]); } return first; };
  const sections = heights.map((y, i) => {
    const W = Math.max(.002, (widths[i].hi - widths[i].lo) / 2), {lo, hi} = depths[i];
    if (head.whole) { const zm = (lo + hi) / 2, d = Math.max(.002, (hi - lo) / 2); return {y, W, zm, df: d, db: d * head.back}; }
    // Face only: the traced face runs from the ear line (its back edge) forward; an open profile line has no depth, so the ear line sits a head-width back.
    const zm = hi - lo > W * .15 ? lo : hi - W;
    return {y, W, zm, df: Math.max(.002, hi - zm), db: Math.max(.002, W * head.back)};
  });
  // Domes: three shrinking rings, then a point, above the top row and below the bottom one,
  // reaching the outline's top and bottom (Top dome and Chin dome scale how far).
  const dome = (sec, up, amount) => {
    const out = [], H = amount * Math.max(1e-3, up > 0 ? yMax - sec.y : sec.y - yMin);
    for (let k = 1; k <= 3; k++) { const a = k / 4 * Math.PI / 2, f = Math.cos(a); out.push({...sec, y: sec.y + up * H * Math.sin(a), W: sec.W * f, df: sec.df * f, db: sec.db * f}); }
    return {rings: out, pole: [cx, sec.y + up * H, sec.zm]};
  };
  const below = dome(sections[0], -1, head.bottom), above = dome(sections.at(-1), 1, head.top);
  for (const sec of [...below.rings.reverse(), ...sections, ...above.rings]) rings.push(ring(sec.y, sec.W, sec.zm, sec.df, sec.db));
  const poleB = verts.push(below.pole) - 1, poleT = verts.push(above.pole) - 1;
  for (let r = 1; r < rings.length; r++) for (let k = 0; k < N; k++) faces.push({v: [rings[r - 1] + k, rings[r - 1] + (k + 1) % N, rings[r] + (k + 1) % N, rings[r] + k], c: color});
  for (let k = 0; k < N; k++) { faces.push({v: [rings[0] + (k + 1) % N, rings[0] + k, poleB], c: color}); faces.push({v: [rings.at(-1) + k, rings.at(-1) + (k + 1) % N, poleT], c: color}); }
  const mesh = {verts, faces}; recalculateNormals(mesh);
  return mesh;
}

// ---------- branch edits (Build's Split, Duplicate, Flip) ----------

/** Split a line in two at its middle (on its curve): a new joint, the second half a new line. */
export function splitLine(sticks, id) {
  const line = lineOf(sticks, id); if (!line) return null;
  const a = jointOf(sticks, line.from).at, b = jointOf(sticks, line.to).at, at = linePath(a, b, line.shape)(.5);
  const mid = {id: stickId(sticks), at, piece: line.piece}, oldTo = line.to;
  sticks.joints.push(mid);
  const s = line.shape, halfway = (s.start + s.end) / 2;
  line.to = mid.id;
  line.shape = readShape({...s, curve: s.curve / 4, end: s.kind === 'trapezoid' || s.kind === 'plane' ? halfway : s.end, roundEnd: false});
  const taken = new Set(sticks.lines.map(l => l.name));
  let name = ''; for (let k = sticks.lines.length + 1; ; k++) if (!taken.has(`Line ${k}`)) { name = `Line ${k}`; break; }
  const second = {id: stickId(sticks), from: mid.id, to: oldTo, piece: line.piece, shape: readShape({...s, curve: s.curve / 4, start: s.kind === 'trapezoid' || s.kind === 'plane' ? halfway : s.start, roundStart: false}), color: line.color, static: line.static, name};
  if (line.guide) second.guide = true;
  sticks.lines.push(second);
  for (const f of sticks.fills ?? []) for (let i = 0; i < f.joints.length; i++) {
    const p = f.joints[i], q = f.joints[(i + 1) % f.joints.length];
    if ((p === line.from && q === oldTo) || (p === oldTo && q === line.from)) { f.joints.splice(i + 1, 0, mid.id); break; }
  }
  return second;
}

/** Joints of a line's branch: its end joint and everything hanging below it. */
const branchJoints = (sticks, line) => [line.to, ...jointsBelow(sticks, line.to)];

/** Copy a line and what hangs below it from the same joint, turned `angle`
 * degrees about `axis` (the view's) through that joint. Returns the new lines. */
export function duplicateBranch(sticks, id, {axis = [0, 0, 1], angle = 20} = {}) {
  const line = lineOf(sticks, id); if (!line) return [];
  const pivot = jointOf(sticks, line.from).at, turn = p => rotateAbout(p, pivot, normalize(axis), angle * Math.PI / 180);
  const made = [], copy = (l, from) => {
    const next = addLine(sticks, from, turn(jointOf(sticks, l.to).at), {shape: {...l.shape}, color: l.color, staticLine: l.static, guide: l.guide});
    made.push(next);
    for (const child of linesFrom(sticks, l.to)) copy(child, next.to);
  };
  copy(line, line.from);
  return made;
}
function rotateAbout(p, pivot, k, angle) {
  const v = sub(p, pivot), c = Math.cos(angle), s = Math.sin(angle);
  return add(pivot, add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c))));
}

/** Flip a line's branch in place across the plane through its start joint
 * facing `axis` (X: horizontally, Y: vertically). */
export function flipBranch(sticks, id, axis = [1, 0, 0]) {
  const line = lineOf(sticks, id); if (!line) return;
  const pivot = jointOf(sticks, line.from).at, n = normalize(axis);
  const flipped = new Set(branchJoints(sticks, line));
  for (const j of sticks.joints) if (flipped.has(j.id)) j.at = sub(j.at, scale(n, 2 * dot(sub(j.at, pivot), n)));
  for (const l of sticks.lines) if (flipped.has(l.to)) l.shape = readShape({...l.shape, roll: -l.shape.roll, twist: -l.shape.twist, bend: -l.shape.bend, tip: -l.shape.tip});
  settlePieces(sticks);
}

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
    if (!posable(line)) continue;
    const old = oldBones.get(line.id), up = parentLine(sticks, line), upPosable = up ? posableLine(sticks, up) : null;
    const bone = {...(old ?? {}), id: old?.id ?? model.nextId++, name: '', head: at(line.from).slice(), tail: at(line.to).slice(), parent: upPosable ? boneOf.get(upPosable.id) ?? 0 : 0, stick: line.id};
    bone.name = uniqueName(model, line.name || old?.name || `Line ${line.id}`);
    model.bones.push(bone); boneOf.set(line.id, bone.id);
  }
  for (const line of sticks.lines) {
    const a = at(line.from), b = at(line.to);
    // Guides are for tracing; a line converted to a mesh keeps its bone, its shape is a part of its own now.
    if (line.guide || line.noMesh || !(length(sub(b, a)) > 1e-6)) continue;
    const mesh = shapeMesh(a, b, line.shape, line.color);
    const mover = posableLine(sticks, line), bone = mover ? boneOf.get(mover.id) : null;
    if (bone) mesh.vdata = {skin: Object.fromEntries(mesh.verts.map((_, i) => [i, [[bone, 1]]]))};
    const old = oldParts.get(line.id);
    model.parts.push({...(old ?? {}), id: old?.id ?? model.nextId++, name: line.name || `${shapeName(line.shape.kind)} ${line.id}`, mesh,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: false, smooth: 0, visible: old?.visible !== false, stick: line.id});
  }
  // Poly fills follow their joints: each point leans on the bones that move
  // the nearest joints (the line ending at a joint moves it).
  const jointBone = joint => { const into = lineInto(sticks, joint), mover = into ? posableLine(sticks, into) : null; const from = mover ? null : linesFrom(sticks, joint).find(l => posable(l)); return boneOf.get((mover ?? from)?.id) ?? null; };
  (sticks.fills ?? []).forEach((fill, index) => {
    if (fill.joints.length < 3) return;
    const mesh = fillMesh(sticks, fill), corners = fill.joints.map(j => ({at: jointOf(sticks, j).at, bone: jointBone(j)})).filter(c => c.bone != null);
    if (corners.length) mesh.vdata = {skin: Object.fromEntries(mesh.verts.map((p, i) => {
      const near = corners.map(c => ({bone: c.bone, w: 1 / (length(sub(p, c.at)) ** 2 + 1e-6)})).sort((x, y) => y.w - x.w);
      const by = new Map(); for (const c of near) by.set(c.bone, (by.get(c.bone) ?? 0) + c.w);
      const top = [...by].sort((x, y) => y[1] - x[1]).slice(0, 4), sum = top.reduce((a, [, w]) => a + w, 0);
      return [i, top.map(([bone, w]) => [bone, w / sum])];
    }))};
    const old = oldParts.get(fill.id);
    model.parts.push({...(old ?? {}), id: old?.id ?? model.nextId++, name: fill.name || `Poly fill ${index + 1}`, mesh,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: false, smooth: fill.smooth ?? 1, visible: old?.visible !== false, stick: fill.id});
  });
  // Heads follow the bone of the joint their front outline is attached to (a neck).
  (sticks.heads ?? []).forEach((head, index) => {
    const mesh = headMesh(sticks, head); if (!mesh) return;
    const bone = [head.front, head.side].map(id => pieceOf(sticks, id)).map(p => p?.attach != null ? lineInto(sticks, p.attach) : null).map(l => l ? posableLine(sticks, l) : null).map(l => l ? boneOf.get(l.id) : null).find(b => b != null);
    if (bone != null) mesh.vdata = {skin: Object.fromEntries(mesh.verts.map((_, i) => [i, [[bone, 1]]]))};
    const old = oldParts.get(head.id);
    model.parts.push({...(old ?? {}), id: old?.id ?? model.nextId++, name: head.name || `Head ${index + 1}`, mesh,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: false, smooth: head.smooth, visible: old?.visible !== false, stick: head.id});
  });
  return model;
}

/**
 * Convert a part made in Build mode (a line's shape, a poly fill or a head)
 * into an ordinary part, to edit point by point. The part keeps its weights,
 * so it still moves with its bones. A poly fill or head is removed (its
 * joints stay); a line keeps its bone and stops making a shape.
 */
export function convertToMesh(model, stickId) {
  const sticks = model.sticks, made = model.parts.find(p => p.stick === stickId);
  if (!sticks || !made) return null;
  if (fillOf(sticks, stickId)) deleteFill(sticks, stickId);
  else if (headOf(sticks, stickId)) deleteHead(sticks, stickId);
  else { const line = lineOf(sticks, stickId); if (!line) return null; line.noMesh = true; }
  generateSticks(model);
  const part = structuredClone(made);
  delete part.stick; part.id = model.nextId++;
  model.parts.push(part);
  return part;
}
const SHAPE_NAMES = {line: 'Line', squareLine: 'Square line', circle: 'Circle', circleFill: 'Filled circle', circleClear: 'Clear circle', triangle: 'Triangle', trapezoid: 'Trapezoid', ellipse: 'Ellipse', polygon: 'Polygon', plane: 'Plane'};
const shapeName = kind => SHAPE_NAMES[kind] ?? kind;

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
    const line = {id: l.id, from: from.id, to: to.id, piece: from.piece, shape: readShape(l.shape), color, static: Boolean(l.static), name: String(l.name ?? '').slice(0, 80)};
    if (l.guide) line.guide = true;
    if (l.noMesh) line.noMesh = true;
    sticks.lines.push(line);
  }
  // Every line must reach its piece's first joint going up (no loops, nothing floating).
  const pieceRoot = new Map(sticks.pieces.map(p => [p.id, p.root]));
  sticks.lines = sticks.lines.filter(l => { let j = l.from; for (let guard = 0; guard <= sticks.lines.length; guard++) { if (j === pieceRoot.get(l.piece)) return true; const up = sticks.lines.find(x => x.to === j); if (!up) return false; j = up.from; } return false; });
  const used = new Set([...sticks.pieces.map(p => p.root), ...sticks.lines.map(l => l.to)]);
  sticks.joints = sticks.joints.filter(j => used.has(j.id));
  for (const p of sticks.pieces) if (p.attach != null && (!joints.has(p.attach) || !used.has(p.attach) || piecesBelow(sticks, p.id).has(joints.get(p.attach).piece))) p.attach = null;
  const kept = new Set(sticks.joints.map(j => j.id)), taken = new Set([...kept, ...sticks.lines.map(l => l.id), ...sticks.pieces.map(p => p.id)]);
  for (const f of Array.isArray(value.fills) ? value.fills : []) {
    if (!Number.isInteger(f?.id) || taken.has(f.id) || !Array.isArray(f.joints)) continue;
    const ids = [...new Set(f.joints.filter(j => kept.has(j)))];
    if (ids.length < 3) continue;
    taken.add(f.id);
    const inflate = Number(f.inflate), color = Number.isInteger(f.color) && f.color >= 0 && f.color < paletteSize ? f.color : 1;
    const smooth = Number(f.smooth);
    sticks.fills.push({id: f.id, joints: ids, color, inflate: Number.isFinite(inflate) ? clamp(inflate, [0, 2]) : .3, smooth: Number.isFinite(smooth) ? Math.round(clamp(smooth, [0, 2])) : 1, name: String(f.name ?? '').slice(0, 80)});
  }
  const pieceSet = new Set(sticks.pieces.map(p => p.id));
  for (const h of Array.isArray(value.heads) ? value.heads : []) {
    if (!Number.isInteger(h?.id) || taken.has(h.id) || !pieceSet.has(h.front) || !pieceSet.has(h.side) || h.front === h.side) continue;
    taken.add(h.id);
    const color = Number.isInteger(h.color) && h.color >= 0 && h.color < paletteSize ? h.color : 0;
    sticks.heads.push({id: h.id, front: h.front, side: h.side, color, name: String(h.name ?? '').slice(0, 80), ...readHeadShape(h)});
  }
  const ids = [...sticks.joints, ...sticks.lines, ...sticks.pieces, ...sticks.fills, ...sticks.heads].map(x => x.id);
  sticks.nextId = Math.max(Number.isInteger(value.nextId) ? value.nextId : 1, ...ids.map(i => i + 1), 1);
  return sticks;
}
