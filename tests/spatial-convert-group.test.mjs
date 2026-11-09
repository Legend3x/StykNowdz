import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultFigure, createObject, createFrame, emptyDocument} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';

/** A body with three joined pieces: a hat on the head, a sleeve on the right
 * forearm, and a badge joined to the hat (two levels deep). */
function assembly({frames = 1, mirrorSleeve = false} = {}) {
  const body = defaultFigure(1);
  const piece = (id, name, segments) => ({figure_type_id: id, name, segment_count: segments.length, polyfills: [], image_assets: [], text_assets: [],
    segments: segments.map(([sid, parent, length, angle, extra = {}]) => ({segment_id: sid, parent_id: parent, length, angle_rad: angle, thickness: 6, bend_rad: 0,
      primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [200, 40, 40], transparency: 0, visible: true, z_order: sid, ...extra}))});
  const hat = piece(2, 'Hat', [[1, 0, 30, 0], [2, 1, 20, -1.2, {bend_rad: .4}], [3, 0, 25, Math.PI]]);
  const sleeve = piece(3, 'Sleeve', [[1, 0, 20, 1.4], [2, 1, 12, .2]]);
  const badge = piece(4, 'Badge', [[1, 0, 8, -.5]]);
  const keyframes = Array.from({length: frames}, (_, f) => {
    const b = createObject(body, 1, 400 + f * 30, 300), h = createObject(hat, 2, 0, 0), s = createObject(sleeve, 3, 0, 0), g = createObject(badge, 4, 0, 0);
    b.angles = b.angles.map((a, i) => a + [0, 0, .4, -.3, .2, .5, -.2, .1, .3, -.4][i] * (f + 1));
    h.angles = h.angles.map(a => a + .3 * f); s.angles = s.angles.map(a => a - .2);
    if (mirrorSleeve) s.image_text_flags = 1;
    const frame = createFrame([b, h, s, g]);
    h.join = {target_object_slot: 0, target_handle_id: 2, target_unique_id: 1};
    s.join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
    g.join = {target_object_slot: 1, target_handle_id: 2, target_unique_id: 2};
    return frame;
  });
  const e = new Editor({demo: false});
  e.load({...emptyDocument(), figure_types: [body, hat, sleeve, badge], keyframes});
  e.select(3, 0);
  return e;
}
/** Every joint as [x, y, depth]. A joined piece reports depth from its own
 * attachment, so the attachment's depth is added for assembly-wide depth. */
const points = e => {
  const out = new Map(), objects = [...e.geometry.objects.values()], byUid = new Map(objects.map(g => [g.obj.unique_id, g]));
  const base = g => {
    const join = g.obj.join, parent = join && byUid.get(join.target_unique_id);
    if (!parent) return 0;
    return base(parent) + (parent.joints.get(join.target_handle_id)?.depthOffset?.x ?? 0);
  };
  for (const g of objects) { const b = base(g); for (const [id, p] of g.joints) out.set(`${g.obj.unique_id}:${id}`, [p.x, p.y, b + (p.depthOffset?.x ?? 0)]); }
  return out;
};
const maxGap = (a, b) => Math.max(...[...a.keys()].map(k => Math.hypot(a.get(k)[0] - b.get(k)[0], a.get(k)[1] - b.get(k)[1])));
const turnGroup = (e, angle, tilt = 0) => { e.select(1, 0); const p = e.getSpatialPose(); e.setSpatialPose({turn: p.turn + angle, pitch: p.pitch + tilt}, {wholeFigure: true}); };

test('the whole joined group is found from any piece and converts without moving', () => {
  for (const mirrorSleeve of [false, true]) {
    const e = assembly({frames: 2, mirrorSleeve}), before = points(e), types = e.report.figure_types.length;
    assert.equal(e.assembly3D().slots.length, 4);
    assert.equal(e.canMakeGroup3D(), true);
    const result = e.makeGroup3D();
    assert.equal(result.pieces, 4);
    assert.equal(e.report.figure_types.length, types + 4, 'each piece gets its own 3D definition');
    assert.ok(maxGap(before, points(e)) < 1e-3, `mirror ${mirrorSleeve}`);
    assert.equal(e.selectedUid, 1, 'the root is selected so Rotate figure turns everything');
    e.selectFrame(1); e.select(1, 1);
    assert.ok(e.figure.segments.some(s => s._stykRig?.spatial), 'the same pieces are 3D in other frames too');
  }
});

test('one undo restores the flat group exactly in every frame', () => {
  const e = assembly({frames: 3}), report = structuredClone({types: e.report.figure_types, frames: e.report.keyframes});
  e.makeGroup3D();
  e.undo();
  assert.deepEqual(e.report.figure_types, report.types);
  assert.deepEqual(e.report.keyframes, report.frames);
  e.redo();
  assert.equal(e.report.figure_types.length, report.types.length + 4);
});

test('turning the root turns every joined piece rigidly, in one undo step', () => {
  const e = assembly({mirrorSleeve: true}); e.makeGroup3D();
  // A piece's root point (joint 0) carries no depth of its own; bone ends do.
  const rest = points(e), keys = [...rest.keys()].filter(k => !k.endsWith(':0')), history = e._undo.length;
  for (const [turn, tilt] of [[Math.PI / 2, 0], [.7, 0], [Math.PI, .3]]) {
    turnGroup(e, turn, tilt);
    const now = points(e);
    let worst = 0;
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const d = (m, a, b) => Math.hypot(...[0, 1, 2].map(k => m.get(a)[k] - m.get(b)[k]));
      worst = Math.max(worst, Math.abs(d(rest, keys[i], keys[j]) - d(now, keys[i], keys[j])));
    }
    assert.ok(worst < .01, `3D distances kept within ${worst} at turn ${turn} tilt ${tilt}`);
    e.undo();
  }
  assert.equal(e._undo.length, history);
  assert.ok(maxGap(rest, points(e)) < 1e-6);
});

test('turning a piece turns the pieces joined below it, not the ones above', () => {
  const e = assembly(); e.makeGroup3D();
  const rest = points(e);
  e.select(2, 0); const p = e.getSpatialPose(); e.setSpatialPose({turn: p.turn + 1}, {wholeFigure: true});
  const now = points(e), moved = uid => [...rest.keys()].filter(k => k.startsWith(`${uid}:`) && !k.endsWith(':0'))
    .some(k => Math.hypot(rest.get(k)[0] - now.get(k)[0], rest.get(k)[1] - now.get(k)[1]) > .01);
  assert.equal(moved(1), false, 'body stays');
  assert.equal(moved(2), true, 'hat turns');
  assert.equal(moved(4), true, 'badge on the hat turns with it');
  assert.equal(moved(3), false, 'sleeve stays');
});

test('depth from a side-view frame: matched joints sit at their side-view offset', () => {
  const e = assembly({frames: 2}), side = e.report.keyframes[1];
  // Frame 2 as a "side view": same pieces; each joint's x there becomes depth.
  e.selectFrame(1); const sideJoints = points(e), sideRoot = e.geometry.objects.get(0).root;
  e.selectFrame(0); e.select(1, 0);
  const before = points(e), result = e.makeGroup3D({sideFrame: 1});
  assert.equal(result.source, 'side'); assert.equal(result.matched, 4);
  assert.ok(maxGap(before, points(e)) < 1e-3, 'still nothing moves at turn 0');
  const now = points(e), ratio = [...sideJoints.keys()].filter(k => !k.endsWith(':0') && Math.abs(sideJoints.get(k)[0] - sideRoot.x) > 5)
    .map(k => now.get(k)[2] / (sideJoints.get(k)[0] - sideRoot.x));
  assert.ok(ratio.length > 5);
  for (const r of ratio) assert.ok(Math.abs(Math.abs(r) - Math.abs(ratio[0])) < .02 && Math.sign(r) === Math.sign(ratio[0]), 'one consistent scale and facing');
  assert.equal(side, e.report.keyframes[1], 'the side-view frame itself is not touched');
});

test('refuses a side-view frame without matching parts, changing nothing', () => {
  const e = assembly({frames: 2});
  for (const o of e.report.keyframes[1].objects) o.figure_type_id = 1;
  const types = e.report.figure_types.length;
  assert.throws(() => e.makeGroup3D({sideFrame: 0}), /another frame/);
  assert.equal(e.report.figure_types.length, types);
});
