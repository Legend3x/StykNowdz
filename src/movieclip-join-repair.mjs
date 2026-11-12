// Joins that loop (a figure joined to itself, or a ring of figures) make a
// scene impossible to lay out, so validation refuses the whole project. Earlier
// versions could store them in captured movieclips: capturing left figures out
// (another layer's figures, say) but kept their slot numbers, so each join
// landed one or more figures further on. Opening repairs such frames instead of
// refusing the project.
//
// A captured movieclip keeps the frames it was captured from (its source
// document), so a looping frame's joins are rebuilt from the source frame at
// the same tick, matched by unique id: the rig comes back as it was. When that
// isn't possible, only the joins closing a loop are dropped (those figures stay
// where they were stored).

import {evaluatedFrame, timeline} from './pivot/geometry.mjs';

/** Slots whose join closes a loop (each loop once). */
export function joinLoops(frame) {
  const objects = frame.objects, state = new Map(), closing = new Set(); // 1 on the current chain, 2 done
  for (let start = 0; start < objects.length; start++) {
    const chain = [];
    let slot = start;
    while (objects[slot] && !state.has(slot)) {
      state.set(slot, 1); chain.push(slot);
      const join = objects[slot].join;
      if (!join) break;
      const next = join.target_object_slot;
      if (state.get(next) === 1) { closing.add(slot); break; }
      slot = next;
    }
    for (const s of chain) state.set(s, 2);
  }
  return closing;
}

/** Joins of the clip's source frame at `tick`, by unique id: uid → {target uid, handle}. */
function sourceJoins(report, tick) {
  const source = report._styk?.movieclipSource;
  if (!source?.document || !Number.isInteger(tick)) return null;
  const document = source.inheritFigures ? {...source.document, figure_types: report.figure_types} : source.document;
  try {
    const rows = timeline(document);
    if (!rows.length) return null;
    let low = 0, high = rows.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
    const row = rows[low], frame = evaluatedFrame(document, low, row.count ? (tick - row.start) / row.count : 0, tick), out = new Map();
    for (const object of frame.objects) {
      const join = object.join; if (!join) continue;
      const target = frame.objects[join.target_object_slot]?.unique_id;
      // Only joins whose slot and unique id agree are trusted.
      if (target !== undefined && target === join.target_unique_id) out.set(object.unique_id, {target, handle: join.target_handle_id});
    }
    return out;
  } catch { return null; }
}

/** Repair looping joins in one document's frames (not nested clips). Returns how many frames changed. */
export function repairJoinLoops(report) {
  let repaired = 0;
  const frames = [...(report.keyframes ?? []), ...Object.values(report._styk?.frameSources ?? {})];
  for (const frame of frames) {
    if (!Array.isArray(frame?.objects) || !joinLoops(frame).size) continue;
    repaired++;
    const slotOf = new Map(frame.objects.map((object, slot) => [object.unique_id, slot]));
    const from = sourceJoins(report, frame._styk?.movieclipSourceTick);
    if (from) {
      const rebuilt = frame.objects.map(object => {
        const join = object.join, original = from.get(object.unique_id);
        if (!join || !original || !slotOf.has(original.target)) return join;
        return {...join, target_object_slot: slotOf.get(original.target), target_unique_id: original.target, target_handle_id: original.handle};
      });
      if (!joinLoops({objects: frame.objects.map((object, slot) => ({...object, join: rebuilt[slot]}))}).size) {
        frame.objects.forEach((object, slot) => { object.join = rebuilt[slot]; });
        continue;
      }
    }
    for (let loops = joinLoops(frame); loops.size; loops = joinLoops(frame)) for (const slot of loops) frame.objects[slot].join = null;
    for (const object of frame.objects) if (object.join) object.join.target_unique_id = frame.objects[object.join.target_object_slot]?.unique_id;
  }
  return repaired;
}
