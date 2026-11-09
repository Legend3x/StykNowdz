import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultFigure, createObject, createFrame, emptyDocument} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';
import {make3DDefinition, make3DRefusal, sharedControlBones, suggestedFreeJoints, restPositions} from '../src/spatial-convert.mjs';

const POSE = [0, 0, .4, -.3, .2, .5, -.2, .1, .3, -.4];
function walkerEditor({rotate = 0, frames = 1, figure = defaultFigure(1)} = {}) {
  const keyframes = Array.from({length: frames}, (_, f) => {
    const o = createObject(figure, 1, 400 + f * 10, 300);
    o.angles = o.angles.map((a, i) => a + (POSE[i] ?? 0) * (f + 1) + rotate);
    return createFrame([o]);
  });
  const e = new Editor({demo: false});
  e.load({...emptyDocument(), figure_types: [figure], keyframes});
  e.select(1, 0);
  return e;
}
const index = (e, id) => e.figure.segments.findIndex(s => s.segment_id === id);
const joints = e => Object.fromEntries([...e.geometry.objects.get(0).joints].filter(([id]) => id >= 1 && id <= 10).map(([id, p]) => [id, [p.x, p.y]]));
const maxGap = (a, b) => Math.max(...Object.keys(a).map(k => Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1])));
const near = (a, b, t = 1e-3) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);

test('Make 3D keeps every joint where it was, in every frame and figure rotation', () => {
  for (const rotate of [0, .9, -2.4]) {
    const e = walkerEditor({rotate, frames: 3}), before = [];
    for (let f = 0; f < 3; f++) { e.selectFrame(f); before.push(joints(e)); }
    e.selectFrame(0); e.select(1, 0);
    e.makeFigure3D();
    assert.ok(e.figure.segments.some(s => s._stykRig?.spatial));
    for (let f = 0; f < 3; f++) { e.selectFrame(f); assert.ok(maxGap(before[f], joints(e)) < 1e-3, `frame ${f} rotate ${rotate}`); }
  }
});

test('one undo step restores the exact flat figure and poses; redo returns the 3D rig', () => {
  const e = walkerEditor({frames: 2}), flat = structuredClone(e.report.figure_types[0]), poses = structuredClone(e.report.keyframes.map(k => k.objects));
  e.makeFigure3D();
  const made = structuredClone(e.report.figure_types[0]);
  e.undo();
  assert.deepEqual(e.report.figure_types[0], flat);
  assert.deepEqual(e.report.keyframes.map(k => k.objects.map(o => o.angles)), poses.map(f => f.map(o => o.angles)));
  e.redo();
  assert.deepEqual(e.report.figure_types[0], made);
});

test('turning the whole figure 180 degrees mirrors it around its root', () => {
  const e = walkerEditor(), flat = joints(e), root = e.geometry.objects.get(0).root;
  e.makeFigure3D(); e.select(1, 0);
  assert.equal(e.figure.segments[0].name, 'Figure rotation');
  e.setSpatialPose({turn: e.getSpatialPose().turn + Math.PI}, {wholeFigure: true});
  const turned = joints(e);
  for (const id of Object.keys(flat)) { near(turned[id][0], 2 * root.x - flat[id][0]); near(turned[id][1], flat[id][1]); }
  e.undo();
  assert.ok(maxGap(flat, joints(e)) < 1e-3);
});

test('a quarter turn gives the layered parts real depth', () => {
  const e = walkerEditor(); e.makeFigure3D(); e.select(1, 0);
  e.setSpatialPose({turn: e.getSpatialPose().turn + Math.PI / 2}, {wholeFigure: true});
  const xs = Object.values(joints(e)).map(p => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 5, 'parts at different depths separate when seen from the side');
});

test('ordinary 2D dragging of a converted part matches the flat figure', () => {
  for (const id of [1, 3, 4, 8]) {
    const flat = walkerEditor(), made = walkerEditor(); made.makeFigure3D();
    flat.select(1, index(flat, id)); flat.rotateJoint(.6);
    made.select(1, index(made, id)); made.rotateJoint(.6);
    assert.ok(maxGap(joints(flat), joints(made)) < 1e-3, `joint ${id}`);
  }
});

test('free 3D joints get their own controls; shared joints refuse depth posing until freed', () => {
  const e = walkerEditor(), result = e.makeFigure3D();
  assert.deepEqual(result.free.sort((a, b) => a - b), [1, 2, 3, 5, 7, 9], 'parts branching from the hips and the spine tip');
  // A free joint (upper arm) turns in depth without moving its sibling.
  e.select(1, index(e, 3));
  const other = joints(e)[6];
  e.setSpatialPose({turn: e.getSpatialPose().turn + .8});
  assert.deepEqual(joints(e)[6], other);
  // A shared joint (forearm) may bend but not turn.
  e.select(1, index(e, 4));
  assert.throws(() => e.setSpatialPose({turn: .5}), /Make free 3D joint/);
  assert.equal(e.canMakeFree3DJoint(), true);
  const before = joints(e), segments = e.figure.segments.length;
  e.makeFree3DJoint();
  assert.equal(e.figure.segments.length, segments + 2);
  assert.ok(maxGap(before, joints(e)) < 1e-6, 'freeing a joint moves nothing');
  assert.equal(e.canMakeFree3DJoint(), false);
  const elbow = joints(e)[3];
  e.setSpatialPose({turn: e.getSpatialPose().turn + .5});
  assert.deepEqual(joints(e)[3], elbow, 'turning the forearm leaves the upper arm');
  assert.notDeepEqual(joints(e)[4], before[4]);
});

test('a plain drag on a shared joint bends it in its own plane', () => {
  const e = walkerEditor(); e.makeFigure3D(); e.select(1, index(e, 4));
  const g = e.geometry.objects.get(0), s = g.segments[index(e, 4)];
  const a = .4, dx = s.end.x - s.start.x, dy = s.end.y - s.start.y;
  const target = {x: s.start.x + dx * Math.cos(a) - dy * Math.sin(a), y: s.start.y + dx * Math.sin(a) + dy * Math.cos(a)};
  e.beginDrag('Pose'); e.poseSpatialJoint(target.x, target.y); e.commitDrag();
  const end = e.geometry.objects.get(0).segments[index(e, 4)].end;
  near(end.x, target.x, .05); near(end.y, target.y, .05);
  assert.equal(sharedControlBones(e.figure).has(4), true, 'still shared, controls untouched');
});

test('shapes, colors and names survive; only rig data and 3D length are added', () => {
  const figure = defaultFigure(1);
  figure.segments[2]._sticknodes = {kind: 'trapezoid', trapezoid_thickness_start: 9, trapezoid_thickness_end: 3};
  figure.segments[4]._sticknodes = {kind: 'triangle', triangle_upside_down: true};
  const {figure: made} = make3DDefinition(figure);
  for (const s of figure.segments) {
    const m = made.segments.find(v => v.segment_id === s.segment_id), {_stykRig, length, ...rest} = m, {length: flatLength, ...flatRest} = s;
    assert.deepEqual(rest, flatRest);
    assert.ok(Math.abs(length) >= Math.abs(flatLength) - 1e-9);
  }
  assert.equal(made.segments[0].name, 'Figure rotation');
  assert.equal(made.segments.length, figure.segments.length + 1 + 4 + 2 * suggestedFreeJoints(figure).size);
});

test('rest positions follow absolute definition angles', () => {
  const p = restPositions(defaultFigure(1));
  near(p[0].end.x, 0); near(p[0].end.y, -78); near(p[1].start.y, -78);
});

test('refuses figures it cannot convert without changing anything', () => {
  const e = walkerEditor(); e.makeFigure3D();
  assert.equal(e.canMakeFigure3D(), false);
  assert.throws(() => e.makeFigure3D(), /already 3D/);
  const rigged = defaultFigure(1); rigged.segments[3]._stykRig = {stretch: {restLength: 50, min: 0, max: 2, width: 'keep'}};
  assert.equal(make3DRefusal(rigged), 'errors.spatialConvert.removeRigRelationshipsBeforeMaking3D');
});

test('native save round trip keeps the 3D rig', async () => {
  const e = walkerEditor(); e.makeFigure3D();
  const saved = e.serialize?.();
  if (!saved) return;
  const copy = new Editor({demo: false}); copy.load(typeof saved === 'string' ? JSON.parse(saved) : structuredClone(saved));
  assert.deepEqual(copy.report.figure_types[0].segments.map(s => s._stykRig ?? null), e.report.figure_types[0].segments.map(s => s._stykRig ?? null));
});

function curvedFigure() {
  const figure = defaultFigure(1);
  figure.segments[2].bend_rad = .5; figure.segments[3].bend_rad = -.7; figure.segments[7].bend_rad = .3;
  return figure;
}

test('curved parts keep their ends and arcs, including per-frame bends and mirrored figures', () => {
  for (const mirror of [0, 1]) {
    const flat = walkerEditor({figure: curvedFigure(), frames: 2}), made = walkerEditor({figure: curvedFigure(), frames: 2});
    for (const e of [flat, made]) for (const k of e.report.keyframes) {
      const o = k.objects[0]; o.image_text_flags = mirror;
      o.bend_flag = 1; o.bends = o.angles.map((_, i) => [0, 0, .9, -.2, 0, .4, 0, -.6, 0, 0][i]);
    }
    for (const e of [flat, made]) { e.load(structuredClone(e.report)); e.select(1, 0); }
    made.makeFigure3D();
    for (const f of [0, 1]) {
      flat.selectFrame(f); made.selectFrame(f);
      assert.ok(maxGap(joints(flat), joints(made)) < 1e-3, `frame ${f} mirror ${mirror}`);
      const arc = made.geometry.objects.get(0).segments[index(made, 3)];
      assert.ok(arc.points.length > 2 && Math.abs(arc.bend) > 1e-7, 'the bent arm is still drawn as an arc');
      const flatArc = flat.geometry.objects.get(0).segments[index(flat, 3)].points, mid = flatArc[Math.floor(flatArc.length / 2)];
      const near3D = Math.min(...arc.points.map(p => Math.hypot(p.x - mid.x, p.y - mid.y)));
      assert.ok(near3D < .5, 'the arc follows the same curve');
    }
  }
});

test('dragging a curved part matches the flat figure', () => {
  for (const id of [3, 4, 8]) {
    const flat = walkerEditor({figure: curvedFigure()}), made = walkerEditor({figure: curvedFigure()}); made.makeFigure3D();
    flat.select(1, index(flat, id)); flat.rotateJoint(.6);
    made.select(1, index(made, id)); made.rotateJoint(.6);
    assert.ok(maxGap(joints(flat), joints(made)) < 1e-3, `joint ${id}`);
  }
});

test('Make 3D switches IK off on the figure (one undo step brings it back)', () => {
  const figure = defaultFigure(), e = new Editor({demo: false});
  e.load({...emptyDocument(), figure_types: [figure], keyframes: [createFrame([createObject(figure, 1, 400, 300)])]});
  // IK on both arms and legs, like the app's starting stickman.
  for (const id of [4, 6, 8, 10]) { e.select(1, figure.segments.findIndex(s => s.segment_id === id)); e.setNodeIK({enabled: true, chainLength: 2}); }
  assert.ok(Object.values(e.object._stykIK ?? {}).some(c => c.enabled), 'IK is on');
  assert.equal(e.make3DRefusal(), null);
  const before = JSON.stringify([...e.geometry.objects.get(0).joints].filter(([id]) => id <= 10));
  const result = e.makeFigure3D();
  assert.equal(result.ikRemoved, true);
  assert.equal(e.object._stykIK, undefined);
  assert.ok(e.figure.segments.some(s => s._stykRig?.spatial));
  e.undo();
  assert.ok(Object.values(e.object._stykIK ?? {}).some(c => c.enabled), 'undo restores IK');
  assert.equal(JSON.stringify([...e.geometry.objects.get(0).joints].filter(([id]) => id <= 10)), before);
});

test('the rotation ball on Figure rotation turns a 3D figure smoothly (roll turns the whole figure)', async () => {
  const {createSpatialGizmo, startRotationGizmo, rotateGizmo} = await import('../src/spatial-gizmo.mjs');
  const figure = defaultFigure(), e = new Editor({demo: false});
  e.load({...emptyDocument(), figure_types: [figure], keyframes: [createFrame([createObject(figure, 1, 400, 300)])]});
  e.select(1, 0); e.makeFigure3D(); e.select(1, 0);
  assert.equal(e.figure.segments[0].name, 'Figure rotation');
  const g = createSpatialGizmo(e, p => ({x: p.x, y: p.y})), c = g.center;
  // Follow the joint farthest from the ball's centre.
  const start = [...e.geometry.objects.get(0).joints].reduce((best, [id, q]) => Math.hypot(q.x - c.x, q.y - c.y) > best[1] ? [id, Math.hypot(q.x - c.x, q.y - c.y)] : best, [0, -1])[0];
  const far = () => e.geometry.objects.get(0).joints.get(start);
  e.beginDrag('Rotate articulated joint');
  const drag = startRotationGizmo(g, {x: c.x + 10, y: c.y});
  let last = {...far()}, worst = 0;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400, r = 10 + 90 * t, a = t * Math.PI * 6;
    const pose = rotateGizmo(drag, {x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a)});
    e.setSpatialPose(pose);
    const got = e.getSpatialPose();
    for (const k of ['bend', 'turn', 'pitch']) near(Math.atan2(Math.sin(got[k] - pose[k]), Math.cos(got[k] - pose[k])), 0, 1e-6);
    const now = far(); worst = Math.max(worst, Math.hypot(now.x - last.x, now.y - last.y)); last = {...now};
  }
  e.commitDrag();
  // Small pointer steps make small turns: no jumps between orientations.
  assert.ok(worst < 15, `largest step ${worst.toFixed(1)} px`);
});
