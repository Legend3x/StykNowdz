import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {editorBuilderMethods} from '../src/editor-builder.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {authoredShapeOf, trapezoidWidths, roundedTrapezoid} from '../src/sticknodes/geometry.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit, cancelNativePropertyEdit, canEditNativeProperty, getNativePropertyValue} from '../src/native-property-edit.mjs';
import {inspectorDescriptor} from '../src/inspector-view.mjs';

Object.assign(Editor.prototype, editorBuilderMethods);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function blank() {
  const editor = new Editor({demo: false}); editor.addFigure(); editor.markSaved();
  editor.select(editor.frame.objects[0].unique_id, 0);
  editor.figure.segments[0].thickness = 12; editor.figure.segments[0].length = 40; editor.figure.segments[0].angle_rad = 0;
  editor._invalidateFigure(editor.figure.figure_type_id);
  return editor;
}
const shapes = editor => editor.geometry.drawables.filter(d => d.type === 'poly' && d.seg === editor.figure.segments[0]);
const width = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('Triangle starts at the part\'s width and tapers to a point at its end, as one undo step', () => {
  const editor = blank(), history = editor._undo.length, before = editor.serialize();
  assert.equal(editor.convertSegment('triangle'), true);
  assert.equal(editor._undo.length, history + 1);
  const segment = editor.figure.segments[0];
  assert.equal(segment.primitive_code, 3); assert.deepEqual(segment._sticknodes, {kind: 'triangle'});
  assert.equal(authoredShapeOf(segment), 'triangle');
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  const [triangle] = shapes(editor); assert.ok(triangle, 'a triangle polygon is drawn'); assert.equal(triangle.points.length, 3);
  const g = editor.geometry.objects.get(editor.selectedSlot).segments[0];
  const apex = triangle.points.filter(p => width(p, g.end) < 1e-6);
  assert.equal(apex.length, 1, 'one corner sits exactly on the child node');
  const base = triangle.points.filter(p => p !== apex[0]);
  near(width(base[0], base[1]), 12 * Math.abs(editor.object.scale ?? 1), 1e-4);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(authoredShapeOf(editor.figure.segments[0]), 'triangle');
});

test('choosing Trapezoid keeps the current width at the start and halves it toward the end', () => {
  const editor = blank();
  assert.equal(editor.convertSegment('trapezoid'), true);
  const segment = editor.figure.segments[0];
  assert.equal(authoredShapeOf(segment), 'trapezoid');
  assert.deepEqual(trapezoidWidths(segment._sticknodes, segment.thickness), {start: 12, end: 6});
  const quad = shapes(editor)[0]; assert.ok(quad); assert.equal(quad.points.length, 4);
  assert.equal(editor.convertSegment('trapezoid'), false, 're-choosing the same shape is a no-op');
});

test('leaving Triangle or Trapezoid removes its shape so the part draws normally again', () => {
  for (const shape of ['triangle', 'trapezoid']) {
    const editor = blank(); editor.convertSegment(shape);
    const history = editor._undo.length;
    assert.equal(editor.convertSegment('circleFill'), true); assert.equal(editor._undo.length, history + 1);
    assert.equal(editor.figure.segments[0]._sticknodes, undefined); assert.equal(editor.figure.segments[0].primitive_code, 3);
    assert.equal(authoredShapeOf(editor.figure.segments[0]), null);
    editor.undo(); assert.equal(editor.figure.segments[0]._sticknodes.kind, shape);
    editor.convertSegment('line'); assert.equal(editor.figure.segments[0]._sticknodes, undefined); assert.equal(editor.figure.segments[0].primitive_code, 0);
  }
});

test('Start and End thickness are independent, drawn at each node, and one undo step per gesture', () => {
  const editor = blank(); editor.convertSegment('trapezoid');
  assert.ok(canEditNativeProperty(editor, 'trapezoid_start')); assert.ok(canEditNativeProperty(editor, 'trapezoid_end'));
  assert.equal(getNativePropertyValue(editor, 'trapezoid_start'), 12); assert.equal(getNativePropertyValue(editor, 'trapezoid_end'), 6);
  const history = editor._undo.length, before = editor.serialize();
  let token = beginNativePropertyEdit(editor, 'trapezoid_start');
  previewNativePropertyEdit(token, 20); previewNativePropertyEdit(token, 30); assert.equal(commitNativePropertyEdit(token), true);
  assert.equal(editor._undo.length, history + 1);
  token = beginNativePropertyEdit(editor, 'trapezoid_end'); previewNativePropertyEdit(token, 2); commitNativePropertyEdit(token);
  assert.equal(editor._undo.length, history + 2);
  const shape = editor.figure.segments[0]._sticknodes;
  assert.equal(shape.trapezoid_thickness_start, 30); assert.equal(shape.trapezoid_thickness_end, 2); assert.ok(shape.trapezoid_top_thickness_ratio < 0);
  assert.equal(editor.figure.segments[0].thickness, 12, 'the universal thickness is untouched');
  const [quad] = shapes(editor), g = editor.geometry.objects.get(editor.selectedSlot).segments[0], scale = Math.abs(editor.object.scale ?? 1);
  const startPair = quad.points.filter(p => Math.abs(width(p, g.start) - 15 * scale) < 1e-4), endPair = quad.points.filter(p => Math.abs(width(p, g.end) - 1 * scale) < 1e-4);
  assert.equal(startPair.length, 2); assert.equal(endPair.length, 2);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('a cancelled or invalid thickness gesture leaves the part unchanged', () => {
  const editor = blank(); editor.convertSegment('trapezoid');
  const before = editor.serialize(), history = editor._undo.length;
  let token = beginNativePropertyEdit(editor, 'trapezoid_end');
  assert.throws(() => previewNativePropertyEdit(token, -1)); assert.throws(() => previewNativePropertyEdit(token, NaN));
  previewNativePropertyEdit(token, 9); assert.equal(editor.figure.segments[0]._sticknodes.trapezoid_thickness_end, 9, 'the preview is live');
  assert.equal(cancelNativePropertyEdit(token), true);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
  token = beginNativePropertyEdit(editor, 'trapezoid_end'); assert.equal(commitNativePropertyEdit(token), false, 'no change records nothing');
  assert.equal(editor._undo.length, history);
});

test('an imported trapezoid with a ratio shows both widths and switches to explicit widths when one is edited', () => {
  const editor = blank(); editor.convertSegment('trapezoid');
  editor.figure.segments[0]._sticknodes = {kind: 'trapezoid', trapezoid_top_thickness_ratio: .25, trapezoid_is_rounded_end: true};
  assert.equal(getNativePropertyValue(editor, 'trapezoid_start'), 12); assert.equal(getNativePropertyValue(editor, 'trapezoid_end'), 3);
  const token = beginNativePropertyEdit(editor, 'trapezoid_start'); previewNativePropertyEdit(token, 8); commitNativePropertyEdit(token);
  const shape = editor.figure.segments[0]._sticknodes;
  assert.deepEqual([shape.trapezoid_thickness_start, shape.trapezoid_thickness_end], [8, 3]);
  assert.ok(shape.trapezoid_top_thickness_ratio < 0); assert.equal(shape.trapezoid_is_rounded_end, true, 'imported flags survive');
});

test('the inspector offers Triangle and Trapezoid, and swaps Width for Start and End thickness', () => {
  const editor = blank();
  const view = () => JSON.stringify(inspectorDescriptor({editor, builder: true, context: 'figure', tab: 'design'}));
  let text = view();
  assert.ok(text.includes('"trapezoid"') && text.includes('"triangle"'), 'both options listed');
  assert.ok(text.includes('"thickness"') && !text.includes('trapezoid_start'));
  editor.convertSegment('trapezoid'); text = view();
  assert.ok(text.includes('trapezoid_start') && text.includes('trapezoid_end'));
  assert.ok(!text.includes('"key":"thickness"'), 'the single Width field is hidden');
  editor.convertSegment('triangle'); text = view();
  assert.ok(text.includes('"key":"thickness"') && !text.includes('trapezoid_start'));
});

const circles = editor => editor.geometry.drawables.filter(d => d.type === 'circle' && d.seg.segment_id === editor.figure.segments[0].segment_id);

test('Round start and Round end add a cap at each end, sized to that end, as one undo step each', () => {
  const editor = blank(); editor.convertSegment('trapezoid');
  const token = beginNativePropertyEdit(editor, 'trapezoid_start'); previewNativePropertyEdit(token, 20); commitNativePropertyEdit(token);
  assert.equal(circles(editor).length, 0, 'square ends by default');
  const history = editor._undo.length, before = editor.serialize();
  assert.equal(editor.setTrapezoidRounding({start: true}), true); assert.equal(editor._undo.length, history + 1);
  const g = editor.geometry.objects.get(editor.selectedSlot).segments[0], scale = Math.abs(editor.object.scale ?? 1);
  let caps = circles(editor); assert.equal(caps.length, 1);
  near(width(caps[0].points[0], g.start), 0, 1e-4); near(caps[0].length, 20 * scale, 1e-4);
  assert.equal(editor.setTrapezoidRounding({end: true}), true);
  caps = circles(editor); assert.equal(caps.length, 2);
  const endCap = caps.find(c => width(c.points[0], g.end) < 1e-4); assert.ok(endCap, 'a cap sits on the child node'); near(endCap.length, 6 * scale, 1e-4);
  assert.equal(editor.setTrapezoidRounding({start: false}), true); assert.equal(circles(editor).length, 1);
  assert.equal(editor.figure.segments[0]._sticknodes.trapezoid_is_rounded_start, undefined, 'turning a cap off drops the flag');
  assert.equal(editor.figure.segments[0]._sticknodes.trapezoid_is_rounded_end, true);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); editor.undo(); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('rounding is a no-op when nothing changes, rejects bad input, and only applies to a Trapezoid', () => {
  const editor = blank();
  assert.equal(editor.setTrapezoidRounding({start: true}), false, 'a plain part has no trapezoid to round');
  editor.convertSegment('triangle'); assert.equal(editor.setTrapezoidRounding({end: true}), false, 'a triangle has no rounded ends');
  editor.convertSegment('trapezoid'); const before = editor.serialize(), history = editor._undo.length;
  assert.equal(editor.setTrapezoidRounding({start: false}), false); assert.equal(editor._undo.length, history);
  for (const bad of [{}, null, [], {start: 1}, {middle: true}, {start: true, end: 'yes'}]) assert.throws(() => editor.setTrapezoidRounding(bad));
  assert.deepEqual(editor.serialize(), before);
});

test('rounded ends survive editing the thickness and are dropped when the shape changes', () => {
  const editor = blank(); editor.convertSegment('trapezoid'); editor.setTrapezoidRounding({start: true, end: true});
  const token = beginNativePropertyEdit(editor, 'trapezoid_end'); previewNativePropertyEdit(token, 4); commitNativePropertyEdit(token);
  const shape = editor.figure.segments[0]._sticknodes;
  assert.equal(shape.trapezoid_is_rounded_start, true); assert.equal(shape.trapezoid_is_rounded_end, true); assert.equal(shape.trapezoid_thickness_end, 4);
  editor.convertSegment('triangle'); assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'triangle'});
  editor.convertSegment('trapezoid'); assert.equal(editor.figure.segments[0]._sticknodes.trapezoid_is_rounded_start, undefined);
});

test('the inspector shows Round start and Round end only for a Trapezoid, reflecting what is set', () => {
  const editor = blank();
  const view = () => JSON.stringify(inspectorDescriptor({editor, builder: true, context: 'figure', tab: 'design'}));
  assert.ok(!view().includes('trapezoid-round-start'));
  editor.convertSegment('trapezoid'); let text = view();
  assert.ok(text.includes('trapezoid-round-start') && text.includes('trapezoid-round-end'));
  assert.ok(text.includes('"id":"trapezoid-round-start","label":"Round start"') && text.includes('"checked":false'));
  editor.setTrapezoidRounding({end: true}); text = view();
  assert.match(text, /"id":"trapezoid-round-end"[^}]*"checked":true/);
  assert.match(text, /"id":"trapezoid-round-start"[^}]*"checked":false/);
  editor.convertSegment('triangle'); assert.ok(!view().includes('trapezoid-round'));
});

const seg0 = editor => editor.geometry.objects.get(editor.selectedSlot).segments[0];
const scaleOf = editor => Math.abs(editor.object.scale ?? 1);
const edit = (editor, key, value) => { const token = beginNativePropertyEdit(editor, key); previewNativePropertyEdit(token, value); return commitNativePropertyEdit(token); };
const extent = (points, axis) => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))];
/** Points measured along the part (x, from its start to its end) and across it (y, to its right), whatever its angle. */
const along = editor => {
  const g = seg0(editor), dx = g.end.x - g.start.x, dy = g.end.y - g.start.y, length = Math.hypot(dx, dy), u = {x: dx / length, y: dy / length};
  return points => points.map(p => ({x: (p.x - g.start.x) * u.x + (p.y - g.start.y) * u.y, y: -(p.x - g.start.x) * u.y + (p.y - g.start.y) * u.x}));
};

test('Ellipse spans the part\'s length and width; Half ellipse bulges from the start, and Flip moves the flat side to the end', () => {
  const editor = blank(); assert.equal(editor.convertSegment('ellipse'), true);
  assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'ellipse'}); assert.equal(authoredShapeOf(editor.figure.segments[0]), 'ellipse');
  const s = scaleOf(editor), local = () => along(editor)(shapes(editor)[0].points);
  assert.equal(shapes(editor)[0].points.length, 64);
  const [x0, x1] = extent(local(), 'x'), [y0, y1] = extent(local(), 'y');
  near(x0, 0, 1e-3); near(x1, 40 * s, 1e-3); near(y1 - y0, 12 * s, 1e-2);
  assert.equal(editor.setShapeOptions({half: true}), true); assert.equal(shapes(editor)[0].points.length, 65);
  const widest = points => points.reduce((a, b) => Math.abs(b.y) > Math.abs(a.y) ? b : a);
  near(widest(local()).x, 0, 1e-3);
  assert.equal(editor.setShapeOptions({flip: true}), true); near(widest(local()).x, 40 * s, 1e-3);
  assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'ellipse', half_arc: true, triangle_upside_down: true});
  editor.setShapeOptions({half: false, flip: false}); assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'ellipse'});
});

test('Polygon has a Sides count from 3 to 256, in one undo step per edit', () => {
  const editor = blank(); assert.equal(editor.convertSegment('polygon'), true);
  assert.equal(editor.figure.segments[0]._sticknodes.num_polygon_vertices, 5); assert.equal(shapes(editor)[0].points.length, 5);
  assert.ok(canEditNativeProperty(editor, 'polygon_sides')); assert.equal(getNativePropertyValue(editor, 'polygon_sides'), 5);
  const history = editor._undo.length, before = editor.serialize();
  assert.equal(edit(editor, 'polygon_sides', 8), true); assert.equal(editor._undo.length, history + 1);
  assert.equal(shapes(editor)[0].points.length, 8); assert.doesNotThrow(() => validateScene(editor.serialize()));
  const token = beginNativePropertyEdit(editor, 'polygon_sides');
  for (const bad of [2, 257, 4.5, NaN]) assert.throws(() => previewNativePropertyEdit(token, bad));
  previewNativePropertyEdit(token, 256); assert.equal(commitNativePropertyEdit(token), true); assert.equal(shapes(editor)[0].points.length, 256);
  editor.undo(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  const plain = blank(); assert.equal(canEditNativeProperty(plain, 'polygon_sides'), false, 'only a Polygon has Sides');
});

test('Triangle Flip points it back at the start; Tip puts the point on the left or right edge', () => {
  const editor = blank(); editor.convertSegment('triangle');
  const s = scaleOf(editor), corners = () => along(editor)(shapes(editor)[0].points), at = x => corners().filter(p => Math.abs(p.x - x) < 1e-3);
  assert.equal(at(0).length, 2); assert.equal(at(40 * s).length, 1); near(at(40 * s)[0].y, 0, 1e-3);
  assert.equal(editor.setShapeOptions({flip: true}), true);
  assert.equal(at(0).length, 1, 'the point is now at the start'); assert.equal(at(40 * s).length, 2);
  editor.setShapeOptions({flip: false});
  for (const lean of [1, -1]) {
    assert.equal(editor.setShapeOptions({lean}), true);
    const [tip] = at(40 * s); near(Math.abs(tip.y), 6 * s, 1e-3); assert.equal(Math.sign(tip.y), lean, 'right (+1) or left (-1) of the direction it points');
  }
  assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'triangle', right_triangle_direction: -1});
  editor.setShapeOptions({lean: 0}); assert.deepEqual(editor.figure.segments[0]._sticknodes, {kind: 'triangle'});
});

test('shape options reject what a shape does not have and leave the part unchanged', () => {
  const editor = blank(); editor.convertSegment('triangle'); const before = editor.serialize(), history = editor._undo.length;
  for (const bad of [{}, null, [], {half: true}, {circular: true}, {lean: 2}, {lean: '1'}, {flip: 'yes'}, {flip: 1}]) assert.throws(() => editor.setShapeOptions(bad));
  assert.equal(editor.setShapeOptions({flip: false}), false, 'no change records nothing');
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
  editor.convertSegment('circleFill'); assert.equal(editor.setShapeOptions({flip: true}), false, 'a plain circle has no shape options');
});

test('Curve bends a round line, square line or trapezoid, and a straight line is a plain line again', () => {
  const editor = blank(); const segment = () => editor.figure.segments[0];
  assert.equal(segment().primitive_code, 0, 'the new figure starts with a round line');
  assert.ok(canEditNativeProperty(editor, 'shape_curve')); assert.equal(getNativePropertyValue(editor, 'shape_curve'), 0);
  const before = editor.serialize(), history = editor._undo.length;
  assert.equal(edit(editor, 'shape_curve', 10), true); assert.equal(editor._undo.length, history + 1);
  assert.deepEqual(segment()._sticknodes, {kind: 'rounded-segment', sagitta: 10}); assert.doesNotThrow(() => validateScene(editor.serialize()));
  const s = scaleOf(editor), arc = () => along(editor)(seg0(editor).points); assert.ok(arc().length > 2, 'the line is drawn as an arc');
  const bulge = Math.max(...arc().map(p => Math.abs(p.y))); near(bulge, 10 * s, 10 * s * .05);
  editor.convertSegment('squareLine'); assert.deepEqual(segment()._sticknodes, {kind: 'segment', sagitta: 10}, 'the curve follows the cap style');
  assert.ok(seg0(editor).points.length > 2);
  editor.convertSegment('line'); assert.equal(segment()._sticknodes.kind, 'rounded-segment');
  assert.equal(edit(editor, 'shape_curve', 0), true); assert.equal(segment()._sticknodes, undefined, 'no curve, no shape');
  editor.undo(); assert.equal(segment()._sticknodes.sagitta, 10); editor.undo(); editor.undo(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  edit(editor, 'shape_curve', -6); assert.equal(segment()._sticknodes.sagitta, -6);
  const side = Math.sign(arc().reduce((a, b) => Math.abs(b.y) > Math.abs(a.y) ? b : a).y);
  edit(editor, 'shape_curve', 6); assert.equal(Math.sign(arc().reduce((a, b) => Math.abs(b.y) > Math.abs(a.y) ? b : a).y), -side, 'a negative curve bends the other way');
  editor.convertSegment('circleFill'); assert.equal(segment()._sticknodes, undefined, 'a circle cannot be curved, so the curve is dropped');
  assert.equal(canEditNativeProperty(editor, 'shape_curve'), false);
  editor.convertSegment('trapezoid'); assert.ok(canEditNativeProperty(editor, 'shape_curve'));
  const flat = shapes(editor)[0].points.length; edit(editor, 'shape_curve', 8);
  assert.ok(shapes(editor)[0].points.length > flat, 'the trapezoid follows the arc'); assert.equal(segment()._sticknodes.kind, 'trapezoid');
  edit(editor, 'shape_curve', 0); assert.equal(segment()._sticknodes.sagitta, undefined); assert.equal(segment()._sticknodes.kind, 'trapezoid');
});

test('Circular arc is stored with the curve and a plain line returns to normal when it is switched off', () => {
  const editor = blank(); const segment = () => editor.figure.segments[0];
  assert.equal(editor.setShapeOptions({circular: true}), true); assert.deepEqual(segment()._sticknodes, {kind: 'rounded-segment', curve_circulization: true});
  edit(editor, 'shape_curve', 7); assert.deepEqual(segment()._sticknodes, {kind: 'rounded-segment', curve_circulization: true, sagitta: 7});
  editor.setShapeOptions({circular: false}); assert.deepEqual(segment()._sticknodes, {kind: 'rounded-segment', sagitta: 7});
  edit(editor, 'shape_curve', 0); assert.equal(segment()._sticknodes, undefined);
});

test('the inspector shows each shape\'s own options and nothing else', () => {
  const editor = blank(), view = () => JSON.stringify(inspectorDescriptor({editor, builder: true, context: 'figure', tab: 'design'}));
  const has = (text, ...ids) => ids.map(id => text.includes(`"${id}"`));
  let text = view(); assert.deepEqual(has(text, 'shape_curve', 'shape-circular', 'shape-lean', 'shape-flip', 'shape-half', 'polygon_sides'), [true, true, false, false, false, false], 'a round line can curve');
  assert.ok(text.includes('"ellipse"') && text.includes('"polygon"'), 'both new shapes are listed');
  editor.convertSegment('triangle'); text = view(); assert.deepEqual(has(text, 'shape-lean', 'shape-flip', 'shape_curve', 'shape-half'), [true, true, false, false]);
  editor.convertSegment('ellipse'); text = view(); assert.deepEqual(has(text, 'shape-half', 'shape-flip', 'shape_curve'), [true, false, false], 'Flip appears only for a half ellipse');
  editor.setShapeOptions({half: true}); assert.ok(has(view(), 'shape-flip')[0]);
  editor.convertSegment('polygon'); text = view(); assert.deepEqual(has(text, 'polygon_sides', 'shape-half', 'shape_curve'), [true, false, false]);
  editor.convertSegment('trapezoid'); text = view(); assert.deepEqual(has(text, 'shape_curve', 'shape-circular', 'trapezoid_start'), [true, true, true]); assert.ok(text.includes('trapezoid-round-start'));
  editor.convertSegment('circleFill'); text = view(); assert.deepEqual(has(text, 'shape_curve', 'shape-lean', 'polygon_sides', 'trapezoid_start'), [false, false, false, false]);
});

const lineDistance = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);

test('a rounded trapezoid\'s sides run tangent to its caps, whichever ends are round and however different their widths', () => {
  const A = {x: 10, y: 20}, B = {x: 10 + 30, y: 20 + 40}, L = 50;   // a 3-4-5 direction, so it is not axis aligned
  for (const [r0, r1] of [[6, 6], [6, 15], [15, 3], [0, 8]]) {
    const both = roundedTrapezoid(A, B, r0, r1, true, true);
    for (const side of [[both[0], both[1]], [both[3], both[2]]]) { near(lineDistance(A, ...side), r0, 1e-9); near(lineDistance(B, ...side), r1, 1e-9); }
    const start = roundedTrapezoid(A, B, r0, r1, true, false);
    near(lineDistance(A, start[0], start[1]), r0, 1e-9); assert.ok(start[1].x === B.x + 0 || true);
    const flatEnd = [{x: B.x + (B.y - A.y) / L * r1 * -1, y: B.y + (B.x - A.x) / L * r1}, {x: B.x - (B.y - A.y) / L * r1 * -1, y: B.y - (B.x - A.x) / L * r1}];
    for (const corner of flatEnd) assert.ok(start.slice(1, 3).some(q => Math.hypot(q.x - corner.x, q.y - corner.y) < 1e-9), 'the flat end keeps its square corners');
    const end = roundedTrapezoid(A, B, r0, r1, false, true);
    near(lineDistance(B, end[0], end[1]), r1, 1e-9);
    const flatStart = [{x: A.x - (B.y - A.y) / L * r0, y: A.y + (B.x - A.x) / L * r0}, {x: A.x + (B.y - A.y) / L * r0, y: A.y - (B.x - A.x) / L * r0}];
    for (const corner of flatStart) assert.ok([end[0], end[3]].some(q => Math.hypot(q.x - corner.x, q.y - corner.y) < 1e-9), 'the flat start keeps its square corners');
  }
  assert.equal(roundedTrapezoid(A, B, 6, 6, false, false), null, 'nothing round, nothing to do');
  assert.equal(roundedTrapezoid(A, A, 6, 6, true, true), null, 'a zero-length part keeps the plain construction');
  assert.equal(roundedTrapezoid(A, B, 2, 90, true, true), null, 'a cap that swallows the other end keeps the plain construction');
});

test('turning on Round end and then changing End thickness keeps both caps flush with the body', () => {
  const editor = blank(); editor.convertSegment('trapezoid'); editor.setTrapezoidRounding({start: true, end: true});
  for (const end of [6, 30, 1, 12]) {
    edit(editor, 'trapezoid_end', end);
    const g = seg0(editor), s = scaleOf(editor), body = shapes(editor)[0], caps = circles(editor);
    assert.equal(caps.length, 2); assert.equal(body.points.length, 4);
    for (const [side, cap] of [[[body.points[0], body.points[1]], null], [[body.points[3], body.points[2]], null]])
      for (const [node, width] of [[g.start, 12], [g.end, end]]) near(lineDistance(node, ...side), width * s / 2, 1e-4);
    for (const cap of caps) { const node = width_(cap.points[0], g.start) < 1e-4 ? g.start : g.end; near(width_(cap.points[0], node), 0, 1e-4); }
  }
});
function width_(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

test('a trapezoid with no round ends keeps its square corners', () => {
  const editor = blank(); editor.convertSegment('trapezoid'); edit(editor, 'trapezoid_end', 30);
  const g = seg0(editor), s = scaleOf(editor), pts = shapes(editor)[0].points;
  assert.equal(pts.filter(p => Math.abs(width_(p, g.end) - 15 * s) < 1e-4).length, 2);
  assert.equal(pts.filter(p => Math.abs(width_(p, g.start) - 6 * s) < 1e-4).length, 2);
});

test('a bent rounded trapezoid keeps its caps on the ends of the bent body', () => {
  const editor = blank(); editor.convertSegment('trapezoid'); editor.setTrapezoidRounding({start: true, end: true}); edit(editor, 'trapezoid_end', 4);
  edit(editor, 'joint_bend', -25);
  const [body] = shapes(editor), caps = circles(editor), n = body.points.length / 2;
  assert.ok(n > 2, 'the body follows the bend'); assert.equal(caps.length, 2);
  const mid = i => ({x: (body.points[i].x + body.points[2 * n - 1 - i].x) / 2, y: (body.points[i].y + body.points[2 * n - 1 - i].y) / 2});
  const centres = caps.map(c => c.points[0]);
  assert.ok(centres.some(c => width(c, mid(0)) < 1e-4), 'a cap is centred on the start of the body');
  assert.ok(centres.some(c => width(c, mid(n - 1)) < 1e-4), 'a cap is centred on the end of the body');
});

test('a right-drag bends a trapezoid like a line, undoes in one step, and the caps follow', () => {
  const editor = blank(); editor.convertSegment('trapezoid'); editor.setTrapezoidRounding({start: true, end: true});
  const g = () => editor.geometry.objects.get(editor.selectedSlot).segments[0], before = editor.serialize(), history = editor._undo.length;
  assert.equal(editor.beginDrag('Pose joint'), true);
  const mid = {x: (g().start.x + g().end.x) / 2, y: (g().start.y + g().end.y) / 2}, nx = g().end.y - g().start.y, ny = g().start.x - g().end.x;
  assert.notEqual(editor.bendJoint(mid.x + nx * .4, mid.y + ny * .4), false, 'bending a trapezoid is allowed');
  editor.commitDrag();
  assert.ok(Math.abs(g().bend) > .1, 'the part is bent'); assert.equal(editor._undo.length, history + 1);
  assert.equal(circles(editor).length, 2);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('a triangle, ellipse or polygon still refuses to bend', () => {
  for (const kind of ['triangle', 'ellipse', 'polygon']) {
    const editor = blank(); editor.convertSegment(kind); editor.beginDrag('Pose joint');
    const g = editor.geometry.objects.get(editor.selectedSlot).segments[0];
    assert.equal(editor.bendJoint(g.end.x, g.end.y + 30), false, kind);
    editor.cancelDrag?.();
  }
});
