import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {movieclipAsset} from '../src/movieclips.mjs';
import {joinLoops, repairJoinLoops} from '../src/movieclip-join-repair.mjs';
import {prepareEditorLoad} from '../src/editor-load.mjs';

const join = (slot, uid, handle = 0) => ({join: {target_object_slot: slot, target_unique_id: uid, target_handle_id: handle}});
const joins = frame => frame.objects.map(o => o.join ? [o.unique_id, frame.objects[o.join.target_object_slot].unique_id] : [o.unique_id, null]);

test('joinLoops finds self joins and rings once each', () => {
  const frame = {objects: [{join: {target_object_slot: 0}}, {join: {target_object_slot: 2}}, {join: {target_object_slot: 1}}, {join: {target_object_slot: 1}}, {}]};
  assert.deepEqual([...joinLoops(frame)].sort(), [0, 2]);
  assert.equal(joinLoops({objects: [{}, {join: {target_object_slot: 0}}]}).size, 0);
});

/** A movieclip as earlier versions stored it when a figure on another layer
 * came first: every join one figure too far (3 joined to itself, 2's child to 3). */
function brokenClipProject() {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [createFrame([createObject(figure, 1, 60, 200), createObject(figure, 2, 200, 200), createObject(figure, 3, 0, 0, join(1, 2)), createObject(figure, 4, 0, 0, join(2, 3))], 1)];
  const e = new Editor({demo: false, layerTimeline: true}).load(document);
  e.seek(0); e.select(2); e.createMovieclip({start: 0, end: 1});
  const report = structuredClone(e.report), clip = report.figure_types.find(f => movieclipAsset(f)), frame = movieclipAsset(clip).document.keyframes[0];
  assert.deepEqual(joins(frame), [[2, null], [3, 2], [4, 3]], 'captured correctly');
  // Damage it the way the old capture did: slots one on.
  for (const o of frame.objects) if (o.join) { o.join.target_object_slot += 1; o.join.target_unique_id = frame.objects[o.join.target_object_slot]?.unique_id; }
  frame.objects[2].join.target_object_slot = 2; frame.objects[2].join.target_unique_id = 4;
  return {report, clip};
}

test('a movieclip frame whose joins loop is rebuilt from the frames it was captured from', () => {
  const {report, clip} = brokenClipProject(), frame = () => movieclipAsset(clip).document.keyframes[0];
  assert.ok(joinLoops(frame()).size, 'damaged');
  assert.equal(repairJoinLoops(movieclipAsset(clip).document), 1);
  assert.deepEqual(joins(frame()), [[2, null], [3, 2], [4, 3]], 'the rig as it was captured');
  void report;
});

test('a project with looping joins in a movieclip opens, repaired, instead of being refused', () => {
  const {report, clip} = brokenClipProject();
  const prepared = prepareEditorLoad(report);
  assert.equal(prepared.repairedJoins, 1);
  const repaired = prepared.report.figure_types.find(f => f.figure_type_id === clip.figure_type_id);
  assert.deepEqual(joins(movieclipAsset(repaired).document.keyframes[0]), [[2, null], [3, 2], [4, 3]]);
});

test('without frames to rebuild from, only the joins closing a loop are dropped', () => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [createFrame([createObject(figure, 1, 0, 0, join(0, 1)), createObject(figure, 2, 0, 0, join(0, 1)), createObject(figure, 3, 50, 50)], 1)];
  assert.equal(repairJoinLoops(document), 1);
  assert.deepEqual(joins(document.keyframes[0]), [[1, null], [2, 1], [3, null]]);
  assert.equal(document.keyframes[0].objects[1].join.target_unique_id, 1);
});
