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
  for (const kind of K.STICK_SHAPES) for (const extra of [{}, {start: .1, end: .02, bulge: .6}, {width: 2, depth: .3, roll: 30, twist: 90}]) {
    const mesh = K.shapeMesh(a, b, {kind, ...extra}, 3);
    const check = validateMesh(mesh, quiet);
    assert.ok(check.ok, `${kind} ${JSON.stringify(extra)}: ${JSON.stringify(check.errors?.slice(0, 2))}`);
    assert.ok(mesh.faces.every(f => f.c === 3));
    if (kind !== 'ribbon') assert.ok(!M.isOpenMesh(mesh), `${kind} is closed`);
  }
  // A capsule reaches its end radius past each joint (round caps), a tube stops at them.
  const ys = m => m.verts.map(v => v[1]);
  const capsule = K.shapeMesh(a, b, {kind: 'capsule', start: .1, end: .2});
  near(Math.max(...ys(capsule)), 1.1); near(Math.min(...ys(capsule)), -.2);
  const tube = K.shapeMesh(a, b, {kind: 'tube'});
  near(Math.max(...ys(tube)), 1); near(Math.min(...ys(tube)), 0);
  // A ball's diameter is the line, as a Styk circle; width squashes it across.
  const ball = K.shapeMesh(a, b, {kind: 'ball', width: .5});
  const xs = ball.verts.map(v => Math.abs(v[0])), zs = ball.verts.map(v => Math.abs(v[2]));
  near(Math.max(...ys(ball)), 1); near(Math.max(...xs), .25, 1e-6); near(Math.max(...zs), .5, 1e-6);
  // Taper: thick at the start, thin at the end; bulge: wider in the middle.
  const taper = K.shapeMesh(a, b, {kind: 'tube', start: .2, end: .05});
  const widthAt = (m, y) => Math.max(...m.verts.filter(v => Math.abs(v[1] - y) < 1e-6).map(v => Math.hypot(v[0], v[2])));
  near(widthAt(taper, 1), .2); near(widthAt(taper, 0), .05);
  const bulge = K.shapeMesh(a, b, {kind: 'tube', start: .1, end: .1, bulge: 1});
  near(widthAt(bulge, .5), .2, 1e-6);
  // A ribbon is a flat strip of the given half-width; twist turns it along the line.
  const ribbon = K.shapeMesh(a, b, {kind: 'ribbon', start: .1, end: .1});
  assert.equal(ribbon.verts.length, 4); assert.ok(M.isOpenMesh(ribbon));
  const twisted = K.shapeMesh(a, b, {kind: 'ribbon', start: .1, end: .1, twist: 90});
  const endPts = twisted.verts.slice(-2);
  near(Math.abs(endPts[0][0]), 0, 1e-9); near(Math.abs(endPts[0][2]), .1, 1e-9);
  assert.throws(() => K.shapeMesh(a, a, {}), /no length/);
});

/** A small figure: a body piece (hips, spine, neck, head) and an arm built as its own piece. */
function figure() {
  const model = emptyModel(), s = model.sticks = K.emptySticks();
  const body = K.addPiece(s, {name: 'Body', at: [0, 1, 0]});
  const spine = K.addLine(s, body.root, [0, 1.5, 0], {name: 'Spine', shape: {kind: 'capsule', start: .12, end: .1}});
  const neck = K.addLine(s, spine.to, [0, 1.6, 0], {name: 'Neck', staticLine: true});
  const head = K.addLine(s, neck.to, [0, 1.9, 0], {name: 'Head', shape: {kind: 'ball'}});
  const shoulder = K.addLine(s, spine.to, [.15, 1.48, 0], {name: 'Shoulder.L', staticLine: true});
  const arm = K.addPiece(s, {name: 'Arm', at: [2, 2, 0]});
  const upper = K.addLine(s, arm.root, [2, 1.7, 0], {name: 'UpperArm.L'});
  const lower = K.addLine(s, upper.to, [2, 1.4, 0], {name: 'LowerArm.L'});
  const hair = K.addLine(s, head.to, [0, 1.95, -.15], {name: 'Hair', shape: {kind: 'ribbon', start: .06, end: .02, twist: 40}});
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
  const arm = K.addLine(s, spine.to, [.3, 1.3, .05], {name: 'Arm.L', shape: {kind: 'tube', roll: 20}});
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
