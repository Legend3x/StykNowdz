// A 3D Nowdz model on the stage, posed as the modeler's Pose preview poses it: the figure
// export-figure.mjs makes, each bone's stage frame worked out from the preview's frame, and the
// stage mesh evaluated (spatial-mesh.mjs) with no camera, turn or scale, so a vertex's stage X and
// Y are its figure-space X and Y. Lets a test check that preview and stage put points in the same place.
import {modelToFigure, toFigure} from '../../src/modeler/export-figure.mjs';
import {readModel} from '../../src/modeler/model.mjs';
import {originOf} from '../../src/modeler/layers.mjs';
import {poseFrames, rotate} from '../../src/modeler/pose.mjs';
import {spatialMeshPlan, evaluateSpatialMesh} from '../../src/spatial-mesh.mjs';
import {quatMultiply} from '../../src/rig-spatial.mjs';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);

/** The stage figure for a model, and its mesh. */
export function stageOf(source) {
  const model = readModel(source), {figure} = modelToFigure(model), mesh = figure._styk.spatialMesh;
  const ids = new Map(figure.segments.map((s, i) => [s.segment_id, i]));
  return {model, figure, mesh, ids, origin: originOf(model)};
}

/** Stage frames (indexed like figure.segments) for a preview pose. Figure space is model space
 * scaled by (100, −100, 100) about the model's origin, so a rotation q becomes (−x, y, −z, w) and
 * a bone's move follows: rest start head, posed start at → t = place(at) − R·place(head). */
export function stageFrames({model, figure, origin}, pose) {
  const frames = poseFrames(model, pose), byName = new Map(model.bones.map(b => [b.name, b]));
  const place = p => toFigure(sub(p, origin));
  return figure.segments.map(s => {
    const spatial = s._stykRig?.spatial, bone = byName.get(s.name), f = bone && frames.get(bone.id);
    const q = f ? [-f.turn[0], f.turn[1], -f.turn[2], f.turn[3]] : [0, 0, 0, 1];
    const head = f ? place(f.head) : spatial?.origin ?? [0, 0, 0], at = f ? place(f.at) : head;
    const t = sub(at, rotate(q, head)), tip = spatial?.tip ?? head, d = sub(tip, head), length = Math.hypot(...d);
    return {q, t, dual: quatMultiply([...t, 0], q).map(v => v / 2), origin: head, axis: length > 1e-9 ? d.map(v => v / length) : [0, 1, 0], stretch: 1, restLength: length || 1, nativeBend: 0};
  });
}

/** The stage's posed mesh: [x, y] per vertex in figure space. */
export function evaluateOnStage(stage, pose) {
  const plan = spatialMeshPlan(stage.figure, stage.ids);
  return evaluateSpatialMesh(plan, stageFrames(stage, pose), {root: {x: 0, y: 0}, scale: 1, figureAngle: 0, mirror: false, camera: null, joints: new Map(), colorOf: c => c, slot: 0}, null);
}

/** Each stage vertex back in model space with its weights (bone ids), for the preview to move. */
export function stageVertices({model, figure, mesh, origin}) {
  const boneOf = new Map(figure.segments.map(s => [s.segment_id, model.bones.find(b => b.name === s.name)?.id ?? 0]));
  const n = mesh.positions.length / 3, bones = new Int32Array(n * 4), weights = new Float64Array(n * 4), points = [];
  for (let v = 0; v < n; v++) {
    const P = mesh.positions.slice(v * 3, v * 3 + 3);
    points.push(add([P[0] / 100, -P[1] / 100, P[2] / 100], origin));
    for (let k = 0; k < 4; k++) { bones[v * 4 + k] = boneOf.get(mesh.bones[v * 4 + k]) ?? 0; weights[v * 4 + k] = mesh.weights[v * 4 + k]; }
  }
  return {points, skin: {bones, weights}};
}

export {toFigure, sub};
