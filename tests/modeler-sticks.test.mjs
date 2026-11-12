import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyModel, readModel, evaluatePart} from '../src/modeler/model.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {partWeights} from '../src/modeler/armature.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';
import * as K from '../src/modeler/sticks.mjs';
import * as M from '../src/modeler/mesh.mjs';

const quiet = {print: false};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('every shape is a valid mesh, sized by its line and settings', () => {
  const a = [0, 1, 0], b = [0, 0, 0];
  const variants = [{}, {start: .1, end: .02, bulge: .6}, {width: 2, depth: .3, roll: 30, twist: 90}, {curve: .3, bend: 40}, {curve: -.4, arc: true},
    {roundStart: true, roundEnd: true, curve: .2}, {tip: 1}, {tip: -1, flip: true}, {half: true}, {half: true, flip: true}, {sides: 3}, {sides: 12}];
  for (const kind of K.STICK_SHAPES) for (const extra of variants) {
    const mesh = K.shapeMesh(a, b, {kind, ...extra}, 3);
    const check = validateMesh(mesh, quiet);
    assert.ok(check.ok, `${kind} ${JSON.stringify(extra)}: ${JSON.stringify(check.errors?.slice(0, 2))}`);
    assert.ok(mesh.faces.every(f => f.c === 3));
    if (kind !== 'plane') assert.ok(!M.isOpenMesh(mesh), `${kind} is closed`);
  }
  const ys = m => m.verts.map(v => v[1]);
  // A round line reaches its radius past each joint (round caps); a trapezoid stops at them unless its ends are rounded.
  const line = K.shapeMesh(a, b, {kind: 'line', start: .1});
  near(Math.max(...ys(line)), 1.1); near(Math.min(...ys(line)), -.1);
  const trapezoid = K.shapeMesh(a, b, {kind: 'trapezoid', start: .2, end: .05});
  near(Math.max(...ys(trapezoid)), 1); near(Math.min(...ys(trapezoid)), 0);
  const widthAt = (m, y) => Math.max(...m.verts.filter(v => Math.abs(v[1] - y) < 1e-6).map(v => Math.hypot(v[0], v[2])));
  near(widthAt(trapezoid, 1), .2); near(widthAt(trapezoid, 0), .05);
  near(Math.max(...ys(K.shapeMesh(a, b, {kind: 'trapezoid', start: .2, end: .05, roundStart: true}))), 1.2);
  // A circle's diameter is the line, as in Build; width squashes it across.
  const ball = K.shapeMesh(a, b, {kind: 'circleFill', width: .5});
  near(Math.max(...ys(ball)), 1); near(Math.max(...ball.verts.map(v => Math.abs(v[0]))), .25, 1e-6); near(Math.max(...ball.verts.map(v => Math.abs(v[2]))), .5, 1e-6);
  // A clear circle is a ring around the middle, as thick as its line.
  const ring = K.shapeMesh(a, b, {kind: 'circleClear', start: .05});
  near(Math.max(...ys(ring)), 1.05, 1e-6); assert.ok(ring.verts.every(v => Math.hypot(v[0], v[1] - .5) > .4), 'hollow in the middle');
  // An ellipse is as wide as its thickness; a half ellipse keeps one side of the line.
  const ellipse = K.shapeMesh(a, b, {kind: 'ellipse', start: .1});
  near(Math.max(...ellipse.verts.map(v => Math.abs(v[0]))), .1, 1e-6);
  const half = K.shapeMesh(a, b, {kind: 'ellipse', start: .1, half: true}), halfFlip = K.shapeMesh(a, b, {kind: 'ellipse', start: .1, half: true, flip: true});
  const side = m => Math.sign(m.verts.reduce((acc, v) => acc + v[0], 0));
  assert.notEqual(side(half), side(halfFlip)); assert.ok(half.verts.every(v => side(half) * v[0] >= -1e-9));
  // A triangle is a cone, its tip at the end (Flip: at the start).
  const cone = K.shapeMesh(a, b, {kind: 'triangle', start: .1});
  assert.equal(cone.verts.filter(v => Math.abs(v[1]) < 1e-9).length, 1, 'one tip point at the end');
  const flipped = K.shapeMesh(a, b, {kind: 'triangle', start: .1, flip: true});
  assert.equal(flipped.verts.filter(v => Math.abs(v[1] - 1) < 1e-9).length, 1, 'tip at the start');
  // A polygon of n sides has n points round its middle.
  assert.equal(K.shapeMesh(a, b, {kind: 'polygon', sides: 5}).verts.filter(v => Math.abs(v[1] - .5) < 1e-9).length, 0, 'odd sides: rows between');
  // A plane is a flat strip of the given half-width; twist turns it along the line.
  const plane = K.shapeMesh(a, b, {kind: 'plane', start: .1, end: .1});
  assert.equal(plane.verts.length, 4); assert.ok(M.isOpenMesh(plane));
  const twisted = K.shapeMesh(a, b, {kind: 'plane', start: .1, end: .1, twist: 90});
  const endPts = twisted.verts.slice(-2);
  near(Math.abs(endPts[0][0]), 0, 1e-9); near(Math.abs(endPts[0][2]), .1, 1e-9);
  assert.throws(() => K.shapeMesh(a, a, {}), /no length/);
  // Shapes saved by the first Build mode open as their Build names.
  assert.deepEqual(['capsule', 'tube', 'box', 'ball', 'ribbon'].map(kind => K.readShape({kind}).kind), ['line', 'trapezoid', 'squareLine', 'circleFill', 'plane']);
});

test('a curved line bows out by its curve: a parabola, or a circular arc through both joints', () => {
  const a = [0, 0, 0], b = [0, 1, 0];
  const parabola = K.linePath(a, b, {kind: 'line', curve: .25});
  assert.deepEqual(parabola(.5).map(v => +v.toFixed(9)), [.25, .5, 0]);
  assert.deepEqual(parabola(1).map(v => +v.toFixed(9)), [0, 1, 0]);
  const arc = K.linePath(a, b, {kind: 'line', curve: .25, arc: true}), R = (.5 ** 2 + .25 ** 2) / (2 * .25), centre = [.25 - R, .5, 0];
  for (const t of [0, .2, .5, .8, 1]) near(Math.hypot(...arc(t).map((v, k) => v - centre[k])), R, 1e-9);
  // Bend direction turns the bow around the line; shapes that don't bend stay straight.
  const behind = K.linePath(a, b, {kind: 'line', curve: .25, bend: 90})(.5);
  near(Math.abs(behind[2]), .25, 1e-9); near(behind[0], 0, 1e-9);
  assert.deepEqual(K.linePath(a, b, {kind: 'circleFill', curve: .25})(.5), [0, .5, 0]);
  // The shape follows the bow.
  const bent = K.shapeMesh(a, b, {kind: 'line', start: .05, curve: .25});
  near(Math.max(...bent.verts.map(v => v[0])), .3, .01);
});

/** A small figure: a body piece (hips, spine, neck, head) and an arm built as its own piece. */
function figure() {
  const model = emptyModel(), s = model.sticks = K.emptySticks();
  const body = K.addPiece(s, {name: 'Body', at: [0, 1, 0]});
  const spine = K.addLine(s, body.root, [0, 1.5, 0], {name: 'Spine', shape: {kind: 'trapezoid', start: .12, end: .1}});
  const neck = K.addLine(s, spine.to, [0, 1.6, 0], {name: 'Neck', staticLine: true});
  const head = K.addLine(s, neck.to, [0, 1.9, 0], {name: 'Head', shape: {kind: 'circleFill'}});
  const shoulder = K.addLine(s, spine.to, [.15, 1.48, 0], {name: 'Shoulder.L', staticLine: true});
  const arm = K.addPiece(s, {name: 'Arm', at: [2, 2, 0]});
  const upper = K.addLine(s, arm.root, [2, 1.7, 0], {name: 'UpperArm.L'});
  const lower = K.addLine(s, upper.to, [2, 1.4, 0], {name: 'LowerArm.L'});
  const hair = K.addLine(s, head.to, [0, 1.95, -.15], {name: 'Hair', shape: {kind: 'plane', start: .06, end: .02, twist: 40}});
  return {model, s, body, spine, neck, head, shoulder, arm, upper, lower, hair};
}

test('lines are bones; a static line rides on the posable line above it', () => {
  const {model, spine, neck, head, shoulder} = figure();
  K.generateSticks(model);
  const bone = name => model.bones.find(b => b.name === name);
  assert.deepEqual(model.bones.map(b => b.name).sort(), ['Hair', 'Head', 'LowerArm.L', 'Spine', 'UpperArm.L']);
  assert.equal(bone('Head').parent, bone('Spine').id, 'the static neck passes its place to the spine');
  assert.deepEqual(bone('Spine').head, [0, 1, 0]); assert.deepEqual(bone('Spine').tail, [0, 1.5, 0]);
  const partOf = line => model.parts.find(p => p.stick === line.id);
  for (const p of model.parts) assert.ok(validateMesh(p.mesh, quiet).ok, p.name);
  // Weights are exact: every point of a line's shape follows its bone, or the bone of the line above a static one.
  const skinOf = line => { const p = partOf(line), w = partWeights(model, evaluatePart(p), p); return new Set(w.bones.filter((id, i) => w.weights[i] > 0)); };
  assert.deepEqual(skinOf(spine), new Set([bone('Spine').id]));
  assert.deepEqual(skinOf(neck), new Set([bone('Spine').id]));
  assert.deepEqual(skinOf(shoulder), new Set([bone('Spine').id]));
  assert.deepEqual(skinOf(head), new Set([bone('Head').id]));
  // Ids, and settings set on the parts, stay with their lines when the shapes are rebuilt.
  const ids = model.parts.map(p => p.id).join(), boneIds = model.bones.map(b => b.id).join();
  partOf(head).outline = {on: true, thickness: .01, color: 9};
  head.shape.width = 1.2; K.generateSticks(model);
  assert.equal(model.parts.map(p => p.id).join(), ids); assert.equal(model.bones.map(b => b.id).join(), boneIds);
  assert.equal(partOf(head).outline.on, true);
});

test('pieces snap onto a joint and follow it; the arm hangs from the shoulder', () => {
  const {model, s, shoulder, arm, upper, lower} = figure();
  K.attachPiece(s, arm.id, shoulder.to);
  assert.deepEqual(K.jointOf(s, arm.root).at, [.15, 1.48, 0], 'the arm moved onto the shoulder');
  assert.deepEqual(K.jointOf(s, lower.to).at.map(v => +v.toFixed(9)), [.15, .88, 0], 'and its whole length came with it');
  K.generateSticks(model);
  const bone = name => model.bones.find(b => b.name === name);
  assert.equal(bone('UpperArm.L').parent, bone('Spine').id, 'the arm bone hangs from the spine (the shoulder line is static)');
  // Moving the spine's end moves the shoulder, and the attached arm follows.
  K.moveJoint(s, K.lineOf(s, shoulder.id).from, [0, 1.6, 0]);
  assert.deepEqual(K.jointOf(s, arm.root).at.map(v => +v.toFixed(9)), [.15, 1.58, 0]);
  // No loops: the body can't hang from its own arm.
  assert.throws(() => K.attachPiece(s, K.jointOf(s, shoulder.to).piece, upper.to), /hang from itself/);
  // Letting go keeps the arm where it is.
  K.detachPiece(s, arm.id); K.generateSticks(model);
  assert.equal(model.bones.find(b => b.name === 'UpperArm.L').parent, 0);
});

test('lines are named as they are drawn, and mirrored copies swap side names', () => {
  const s = K.emptySticks(), piece = K.addPiece(s);
  const a = K.addLine(s, piece.root, [0, 1, 0]), b = K.addLine(s, a.to, [.2, 1, 0]), c = K.addLine(s, a.to, [0, 1.3, 0], {name: 'Arm.L'});
  K.deleteLine(s, b.id);
  const d = K.addLine(s, a.to, [0, 1.6, 0]);
  assert.deepEqual([a.name, c.name, d.name], ['Line 1', 'Arm.L', 'Line 3']);
  assert.deepEqual(K.mirrorLines(s, c.id).map(l => l.name), ['Arm.R']);
  const off = K.addLine(s, a.to, [.3, 1.1, 0]);
  assert.match(K.mirrorLines(s, off.id)[0].name, /^Line \d+$/);
});

test('mirror copies a line and what hangs below it across the middle', () => {
  const {s, spine} = figure();
  const arm = K.addLine(s, spine.to, [.3, 1.3, .05], {name: 'Arm.L', shape: {kind: 'trapezoid', roll: 20}});
  K.addLine(s, arm.to, [.4, 1.0, .1], {name: 'Hand.L'});
  const made = K.mirrorLines(s, arm.id);
  assert.deepEqual(made.map(l => l.name), ['Arm.R', 'Hand.R']);
  assert.equal(made[0].from, spine.to, 'starts from the same joint on the middle');
  assert.deepEqual(K.jointOf(s, made[1].to).at, [-.4, 1.0, .1]);
  assert.equal(made[0].shape.roll, -20);
});

test('deleting a line takes what hangs below it and lets go of attached pieces', () => {
  const {model, s, spine, head, hair, shoulder, arm} = figure();
  K.attachPiece(s, arm.id, shoulder.to);
  K.deleteLine(s, spine.id);
  assert.ok(!K.lineOf(s, head.id) && !K.lineOf(s, hair.id) && !K.lineOf(s, shoulder.id));
  assert.equal(K.pieceOf(s, arm.id).attach, null);
  K.generateSticks(model);
  assert.deepEqual(model.bones.map(b => b.name).sort(), ['LowerArm.L', 'UpperArm.L']);
});

test('stored sticks are checked on open, and the figure still animates', () => {
  const {model, s, shoulder, arm} = figure();
  K.attachPiece(s, arm.id, shoulder.to); K.generateSticks(model);
  const back = readModel(JSON.parse(JSON.stringify(model)));
  assert.equal(back.sticks.lines.length, s.lines.length);
  assert.ok(back.parts.every(p => p.stick != null));
  const {figure: fig} = modelToFigure(back);
  assert.ok(fig._styk.spatialMesh.positions.length > 0);
  // Broken data is dropped, not trusted: a loop, a line between pieces, a bad attachment.
  const bad = JSON.parse(JSON.stringify(model));
  bad.sticks.lines.push({id: 999, from: bad.sticks.lines[0].to, to: bad.sticks.pieces[0].root, piece: bad.sticks.pieces[0].id, shape: {}});
  bad.sticks.pieces[0].attach = bad.sticks.joints.find(j => j.piece === bad.sticks.pieces[1].id).id;
  bad.sticks.pieces[1].attach = bad.sticks.joints.find(j => j.piece === bad.sticks.pieces[0].id).id;
  bad.sticks.lines[0].shape = {kind: 'spiral', start: -5, twist: 1e9};
  const cleaned = readModel(bad);
  assert.ok(!cleaned.sticks.lines.some(l => l.id === 999));
  assert.ok(cleaned.sticks.pieces.filter(p => p.attach != null).length <= 1, 'the loop is broken');
  assert.deepEqual(cleaned.sticks.lines[0].shape, {...K.SHAPE_DEFAULTS, start: .002, twist: 720});
});

test('poly fills: a solid through their joints, as thick as the lines there, following their curves and bones', () => {
  const {model, s, spine, shoulder} = figure();
  const hip = K.addLine(s, K.lineOf(s, spine.id).from, [.12, .95, 0], {name: 'Hip.L', shape: {kind: 'line', start: .06}, staticLine: true});
  const fill = K.addFill(s, [K.lineOf(s, spine.id).from, hip.to, shoulder.to, spine.to], {color: 4, inflate: .5});
  assert.throws(() => K.addFill(s, [spine.to, shoulder.to]), /three joints/);
  K.generateSticks(model);
  const part = model.parts.find(p => p.stick === fill.id);
  assert.ok(validateMesh(part.mesh, quiet).ok); assert.ok(!M.isOpenMesh(part.mesh), 'closed');
  assert.ok(part.mesh.faces.every(f => f.c === 4));
  // As thick as the lines meeting its joints at the rim (here, facing Z), and fuller in the middle.
  const zs = part.mesh.verts.map(v => v[2]);
  assert.ok(Math.max(...zs) > .1, `thick: ${Math.max(...zs)}`); assert.ok(Math.max(...zs) < .5);
  near(Math.max(...zs), -Math.min(...zs), 1e-9);
  // Its points lean on the bones that move its joints.
  const w = partWeights(model, evaluatePart(part), part), bones = new Set(w.bones.filter((id, i) => w.weights[i] > 0));
  assert.ok(bones.has(model.bones.find(b => b.name === 'Spine').id));
  // It follows a curved line between two of its joints.
  K.lineOf(s, spine.id).shape.curve = -.2; K.generateSticks(model);
  const curved = model.parts.find(p => p.stick === fill.id);
  assert.ok(Math.min(...curved.mesh.verts.map(v => v[0])) < -.15, 'the edge bows out with the spine');
  // Deleting a joint it needs takes it away; stored fills are checked on open.
  const stored = readModel(JSON.parse(JSON.stringify(model)));
  assert.equal(stored.sticks.fills.length, 1); assert.ok(stored.parts.some(p => p.stick === fill.id));
  K.deleteLine(s, hip.id); assert.equal(s.fills[0].joints.length, 3, 'one joint fewer');
  K.deleteLine(s, spine.id); assert.equal(s.fills.length, 0, 'under three joints: gone');
});

test('split, duplicate and flip a branch, as Build does', () => {
  const {model, s, spine, shoulder} = figure();
  const arm = K.addLine(s, shoulder.to, [.4, 1.2, 0], {shape: {kind: 'trapezoid', start: .06, end: .02}});
  const hand = K.addLine(s, arm.to, [.5, 1.0, 0]);
  const second = K.splitLine(s, arm.id);
  assert.equal(second.to, hand.from, 'what hung from the end still does');
  assert.deepEqual(K.jointOf(s, K.lineOf(s, arm.id).to).at.map(v => +v.toFixed(9)), [.275, 1.34, 0]);
  near(K.lineOf(s, arm.id).shape.end, .04); near(second.shape.start, .04);
  const copies = K.duplicateBranch(s, arm.id, {axis: [0, 0, 1], angle: 90});
  assert.equal(copies.length, 3, 'the line and both below it');
  assert.equal(copies[0].from, K.lineOf(s, arm.id).from, 'from the same joint');
  K.flipBranch(s, arm.id, [1, 0, 0]);
  const pivot = K.jointOf(s, shoulder.to).at;
  assert.ok(K.jointOf(s, hand.to).at[0] < pivot[0], 'flipped to the other side of its joint');
  K.generateSticks(model);
  assert.ok(model.parts.every(p => validateMesh(p.mesh, quiet).ok));
  void spine;
});
