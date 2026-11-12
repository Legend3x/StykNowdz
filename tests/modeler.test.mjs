import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/modeler/mesh.mjs';
import {translation} from '../src/modeler/matrix.mjs';
import {PRIMITIVES, baseCharacter, cube, uvSphere, cylinder} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, evaluatePart, readModel, catmullClark} from '../src/modeler/model.mjs';
import {baseCharacterSkeleton, humanoidSkeleton, fitHumanoid, autoWeights, symmetrizeBones, deleteBones, addBone} from '../src/modeler/armature.mjs';
import {exportObj, importObj} from '../src/modeler/obj-format.mjs';
import {modelToFigure, modelDocument} from '../src/modeler/export-figure.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const volume = m => { let v = 0; for (const f of m.faces) { const p0 = m.verts[f.v[0]]; for (let i = 1; i + 1 < f.v.length; i++) v += M.dot(p0, M.cross(m.verts[f.v[i]], m.verts[f.v[i + 1]])); } return v / 6; };
const closed = m => [...M.edgeFaces(m).values()].every(f => f.length === 2);
/** Every directed edge is used once: neighbouring faces agree on their winding. */
const consistent = m => { const seen = new Set(); for (const f of m.faces) for (let i = 0; i < f.v.length; i++) { const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`; if (seen.has(k)) return false; seen.add(k); } return true; };
const solid = (m, message) => { assert.ok(closed(m), `${message}: closed`); assert.ok(consistent(m), `${message}: consistent`); assert.ok(volume(m) > 0, `${message}: outward`); };
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} ≉ ${b}`);

test('every closed primitive is solid and faces outward', () => {
  for (const [name, make] of Object.entries(PRIMITIVES)) if (!['plane', 'circle', 'point'].includes(name)) solid(make(), name);
  near(volume(cube(2)), 8);
});

test('extrude, inset, subdivide and loop cut keep a solid surface', () => {
  let a = cube(); const moved = M.extrudeFaces(a, new Set([0])); a = M.transformMesh(a, translation([0, 0, .5]), moved);
  solid(a, 'extrude'); near(volume(a), 1.5); assert.equal(a.faces.length, 10);
  const b = cube(); M.insetFaces(b, new Set([0]), .3); solid(b, 'inset'); near(volume(b), 1); assert.equal(b.faces.length, 10);
  const c = cube(); M.subdivideFaces(c, new Set([0])); solid(c, 'subdivide'); near(volume(c), 1);
  const d = cylinder(.5, 1, 8, 0, {rings: 2}), edge = M.meshEdges(d).find(([p, q]) => Math.abs(d.verts[p][1] - d.verts[q][1]) > .1);
  const faces = d.faces.length, v0 = volume(d), loop = M.loopCut(d, edge, .5);
  solid(d, 'loop cut'); near(volume(d), v0); assert.equal(loop.size, 8); assert.equal(d.faces.length, faces + 8);
});

test('edge loops, merge, fill, delete and normals', () => {
  const s = uvSphere(.5, 16, 8), equator = M.meshEdges(s).find(([a, b]) => Math.abs(s.verts[a][1]) < 1e-9 && Math.abs(s.verts[b][1]) < 1e-9);
  assert.equal(M.edgeLoop(s, equator).size, 16);
  const m = cube(); M.mergeVerts(m, new Set([0, 1])); assert.equal(m.verts.length, 7); assert.ok(consistent(m));
  const h = cube(); M.deleteFaces(h, new Set([0])); assert.ok(!closed(h));
  const border = new Set(M.meshEdges(h).filter(([a, b]) => M.edgeFaces(h).get(M.edgeKey(a, b)).length === 1).flat());
  M.fillVerts(h, border); solid(h, 'refilled');
  const flipped = cube(); M.flipFaces(flipped, new Set([0])); assert.ok(volume(flipped) < 0, 'the whole piece turned inside out'); M.recalculateNormals(flipped); solid(flipped, 'fixed normals');
  const inside = cube(); inside.faces.forEach(f => f.v.reverse()); M.recalculateNormals(inside); solid(inside, 'inside out fixed');
});

test('mirror and symmetrize weld the middle; smoothing keeps the surface closed', () => {
  const half = M.transformMesh(cube(), translation([.5, 0, 0]));
  const whole = M.mirrored(half); solid(whole, 'mirrored'); near(volume(whole), 2);
  const sphere = uvSphere(); const before = volume(sphere); M.symmetrize(sphere); solid(sphere, 'symmetrized'); near(volume(sphere), before, 1e-9);
  const smooth = catmullClark(cube()); solid(smooth, 'smoothed'); assert.equal(smooth.faces.length, 24);
  const part = {mesh: half, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: true, smooth: 2};
  solid(evaluatePart(part), 'mirror + smooth');
});

test('object transforms and negative scale keep faces outward', () => {
  const part = {mesh: cube(), position: [1, 2, 3], rotation: [.3, -.7, 1.1], scale: [1, -2, 1], mirror: false, smooth: 0};
  const mesh = evaluatePart(part); solid(mesh, 'mirrored by scale'); near(volume(mesh), 2, 1e-9);
  const inverse = M.objectInverse(part), forward = M.objectTransform(part);
  for (const p of [[.1, .2, .3], [-1, 4, 2]]) inverse(forward(p)).forEach((v, k) => near(v, p[k], 1e-9));
});

test('OBJ export and import round-trip parts, faces and colors', () => {
  const model = emptyModel(); addPart(model, {name: 'Body', mesh: cube(1, 1)}); addPart(model, {name: 'Head', mesh: uvSphere(.3, 8, 4, 2), position: [0, 1, 0]});
  const {obj, mtl} = exportObj(model, {name: 'test'}), palette = [];
  const parts = importObj(obj, {mtl, palette});
  assert.deepEqual(parts.map(p => p.name), ['Body', 'Head']);
  near(volume(parts[0].mesh), 1, 1e-4);
  assert.deepEqual(palette[parts[0].mesh.faces[0].c], model.palette[1]);
  assert.throws(() => importObj('v 0 0 0\nf 1 2 3\n'), /missing vertex/);
});

test('automatic weights: four bones at most, summing to one, and parts keep to their own bones', () => {
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  const byName = new Map(model.bones.map(b => [b.name, b.id]));
  for (const part of model.parts) {
    const mesh = evaluatePart(part), skin = autoWeights(model, mesh, part);
    for (let v = 0; v < mesh.verts.length; v++) {
      let sum = 0; for (let k = 0; k < 4; k++) { const id = skin.bones[v * 4 + k], w = skin.weights[v * 4 + k]; assert.equal(id === 0, w === 0); sum += w; }
      near(sum, 1, 1e-6);
    }
    if (part.name === 'Torso') assert.ok(!skin.bones.includes(byName.get('UpperArm.L')) && !skin.bones.includes(byName.get('UpperArm.R')), 'the torso never follows the arms');
    if (part.name === 'Arm') assert.ok(skin.bones.includes(byName.get('UpperArm.L')) && skin.bones.includes(byName.get('UpperArm.R')), 'mirrored arms follow both sides');
  }
  const head = model.parts.find(p => p.name === 'Hair'); head.bone = byName.get('Head');
  const rigid = autoWeights(model, evaluatePart(head), head); assert.ok(rigid.bones.every((id, i) => i % 4 ? id === 0 : id === byName.get('Head')));
});

test('skeleton tools: humanoid fit, mirroring and deleting keep a valid hierarchy', () => {
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p);
  humanoidSkeleton(model, model.parts.map(p => evaluatePart(p, {smooth: false})));
  assert.equal(model.bones.length, 19);
  const arm = model.bones.find(b => b.name === 'UpperArm.L'); arm.tail = [.9, 1, .1]; symmetrizeBones(model);
  assert.deepEqual(model.bones.find(b => b.name === 'UpperArm.R').tail, [-.9, 1, .1]);
  const shoulder = model.bones.find(b => b.name === 'Shoulder.L'); deleteBones(model, new Set([shoulder.id]));
  assert.equal(model.bones.find(b => b.name === 'UpperArm.L').parent, model.bones.find(b => b.name === 'Chest').id);
});

function characterModel() { const model = emptyModel(); model.name = 'Hero'; for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model); return model; }
function importModel(model) {
  const e = new Editor({demo: false}); e.load({...emptyDocument()});
  e.importFigure(modelDocument(model).document, {position: {x: 400, y: 400}});
  return e;
}
const meshOf = e => buildGeometry(e.report, e.frame).objects.get(e.selectedSlot).spatialMesh;
const boneIndex = (e, name) => e.figure.segments.findIndex(s => s.name === name);

test('a model becomes a valid, posable 3D figure that faces the camera', () => {
  const model = characterModel(), {figure, stats} = modelToFigure(model);
  assert.equal(stats.bones, 19); assert.equal(figure.segments[0].name, 'Figure rotation');
  assert.deepEqual(figure._styk.modelSource, model);
  const e = importModel(model); validateScene(e.report);
  const mesh = figure._styk.spatialMesh, evaluated = meshOf(e);
  // Visible triangles are the ones on the camera side (+Z in figure space).
  let visible = 0; for (let k = 0; k < evaluated.count; k++) visible += [0, 1, 2].reduce((s, j) => s + mesh.positions[evaluated.triangles[k * 3 + j] * 3 + 2], 0) / 3;
  assert.ok(visible / evaluated.count > 1, 'front faces show');
  assert.ok(Math.abs(evaluated.count - stats.triangles / 2) < stats.triangles * .1, 'about half the closed surface shows');
  // Turning the upper arm moves the arm and leaves the torso.
  const torso = mesh.groups.find(g => g.name === 'Torso'), torsoVerts = new Set();
  for (let t = torso.start; t < torso.start + torso.count; t++) for (let j = 0; j < 3; j++) torsoVerts.add(mesh.indices[t * 3 + j]);
  const before = Array.from(evaluated.positions);
  e.select(e.selectedUid, boneIndex(e, 'UpperArm.L')); const pose = e.getSpatialPose(); e.setSpatialPose({bend: pose.bend - 1});
  const after = meshOf(e).positions;
  let armMoved = 0, torsoMoved = 0;
  for (let v = 0; v < before.length / 2; v++) { const d = Math.hypot(before[v * 2] - after[v * 2], before[v * 2 + 1] - after[v * 2 + 1]); if (d > .5) torsoVerts.has(v) ? torsoMoved++ : armMoved++; }
  assert.ok(armMoved > 50); assert.equal(torsoMoved, 0);
});

test('editing a model again updates the figure in place and keeps its poses', () => {
  const model = characterModel(), e = importModel(model), typeId = e.figure.figure_type_id;
  const head = boneIndex(e, 'Head'); e.select(e.selectedUid, head);
  const pose = e.getSpatialPose(); e.setSpatialPose({turn: pose.turn + .6});
  const headId = e.figure.segments[head].segment_id, posed = e.getSpatialPose().turn;
  // Recolor, move a bone and add one, then update.
  const edited = structuredClone(e.figure._styk.modelSource);
  edited.palette[1] = [200, 30, 30];
  edited.bones.find(b => b.name === 'Hand.L').tail = [.45, .38, .05];
  addBone(edited, {name: 'Tail', head: [0, .9, -.1], tail: [0, .7, -.4], parent: edited.bones.find(b => b.name === 'Hips').id});
  const previous = e.report.figure_types.find(f => f.figure_type_id === typeId), {figure} = modelToFigure(edited, {figureTypeId: typeId, previous});
  e.replaceFigureDefinition(typeId, figure, {label: 'Edit 3D model'});
  const same = e.figure.segments.find(s => s.name === 'Head');
  assert.equal(same.segment_id, headId, 'joints keep their IDs');
  e.select(e.selectedUid, e.figure.segments.indexOf(same)); near(e.getSpatialPose().turn, posed, 1e-6);
  assert.ok(e.figure.segments.some(s => s.name === 'Tail'));
  assert.deepEqual(e.figure._styk.spatialMesh.colors.find(c => c[0] === 200), [200, 30, 30]);
  e.undo(); assert.ok(!e.figure.segments.some(s => s.name === 'Tail'));
});

test('stored models are checked before opening', () => {
  assert.throws(() => readModel({version: 9, parts: []}), /unknown format/);
  assert.throws(() => readModel({version: 1, parts: [{name: 'Bad', mesh: {verts: [[0, 0, 0]], faces: [{v: [0, 1, 2]}]}, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]}]}), /dangling vertex index/);
  assert.throws(() => modelToFigure(emptyModel()), /at least one visible part/);
  const model = emptyModel(); addPart(model, {name: 'Box', mesh: cube()});
  const {stats} = modelToFigure(model); assert.equal(stats.bones, 1, 'a model without a skeleton follows one Body bone');
});

test('posing on the stage: each bone hangs from its parent bone, thighs from the root, sleeves stay rigid', () => {
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  const {figure} = modelToFigure(model), byName = new Map(figure.segments.map(s => [s.name, s]));
  // Structural parents match the skeleton, so dragging a joint on the stage carries everything below it.
  assert.equal(byName.get('Spine').parent_id, byName.get('Hips').segment_id);
  assert.equal(byName.get('Chest').parent_id, byName.get('Spine').segment_id);
  assert.equal(byName.get('LowerArm.L').parent_id, byName.get('UpperArm.L').segment_id);
  assert.equal(byName.get('Hips').parent_id, 0);
  assert.equal(byName.get('Thigh.L').parent_id, 0, 'bending the hips leaves the legs where they are');
  for (const s of figure.segments.filter(s => s._stykRig?.spatial && s.name !== 'Figure rotation'))
    assert.ok(s.parent_id === 0 || s.parent_id === s._stykRig.spatial.parent, `${s.name}: structural and 3D parents agree`);
  // A part lying along one bone follows only that bone (per side), so it never pinches.
  const ids = new Map(model.bones.map(b => [b.name, b.id]));
  for (const [partName, bone] of [['Arm', 'UpperArm'], ['Forearm', 'LowerArm'], ['Thigh', 'Thigh'], ['Shin', 'Shin'], ['Head', 'Head']]) {
    const part = model.parts.find(p => p.name === partName), mesh = evaluatePart(part), skin = autoWeights(model, mesh, part);
    mesh.verts.forEach((p, v) => {
      const want = ids.get(bone) ?? ids.get(`${bone}.${p[0] > 0 ? 'L' : 'R'}`);
      assert.equal(skin.bones[v * 4], want, `${partName} vertex ${v}`); assert.equal(skin.weights[v * 4], 1);
    });
  }
  // The torso blends along the spine and never takes a thigh that only touches its edge.
  const torso = model.parts.find(p => p.name === 'Torso'), skin = autoWeights(model, evaluatePart(torso), torso);
  assert.ok(!skin.bones.includes(ids.get('Thigh.L')) && skin.bones.includes(ids.get('Spine')) && skin.bones.includes(ids.get('Chest')));
});

test('toon look: ink outlines are inverted hulls on the part skin, and shadows follow a light fixed to the viewer', async () => {
  const {outlineHull, vertexNormals} = await import('../src/modeler/toon.mjs');
  const {toonLight, shadowColor} = await import('../src/toon-shading.mjs');
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  // The hull is the same surface pushed out along its normals and turned inside out.
  const box = cube(1), hull = outlineHull(box, .05, 9), normals = vertexNormals(box);
  assert.ok(validateMesh(hull).ok);
  assert.equal(hull.verts.length, box.verts.length);
  hull.verts.forEach((p, i) => { assert.ok(Math.abs(M.length(M.sub(p, box.verts[i])) - .05) < 1e-9); assert.ok(M.dot(M.sub(p, box.verts[i]), normals[i]) > 0); });
  hull.faces.forEach((f, i) => { assert.deepEqual(f.v, box.faces[i].v.slice().reverse()); assert.equal(f.c, 9); });
  // Export: each outlined part adds a shell with the same skin, kept out of the shadows.
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  const plain = modelToFigure(model).figure._styk.spatialMesh;
  model.parts.find(p => p.name === 'Head').outline = {on: true, thickness: .02, color: 9};
  model.parts.find(p => p.name === 'Head').shadows = false;
  model.toon = {shadows: true, turn: -35, height: 35, size: .4, strength: .35};
  const {figure} = modelToFigure(model), mesh = figure._styk.spatialMesh;
  const head = mesh.groups.findIndex(g => g.name === 'Head'), outline = mesh.groups.findIndex(g => g.name === 'Head outline');
  assert.ok(outline === head + 1 && mesh.groups[outline].count === mesh.groups[head].count);
  assert.equal(mesh.positions.length - plain.positions.length, 3 * evaluatePart(model.parts.find(p => p.name === 'Head')).verts.length, 'the shell adds one point per head point');
  assert.deepEqual(mesh.toon.flat, [head, outline]);
  assert.deepEqual(mesh.toon.light, [...toonLight(-35, 35)]);
  // On the stage: lit faces keep their colour, faces turned from the light take its shadow twin.
  const e = new Editor({demo: false}); e.load({...emptyDocument(), ...modelDocument(model).document});
  const evaluated = e.geometry.objects.get(0).spatialMesh, base = mesh.colors.length;
  assert.equal(evaluated.colors.length, base * 2);
  evaluated.colors.slice(base).forEach((c, i) => assert.deepEqual(c, shadowColor(evaluated.colors[i], .35)));
  const shaded = [...evaluated.materials.subarray(0, evaluated.count)].filter(m => m >= base).length;
  assert.ok(shaded > 0 && shaded < evaluated.count, `${shaded} of ${evaluated.count} visible triangles in shadow`);
  // Outline and Head triangles never take shadows.
  const ink = mesh.colors.findIndex(c => c.join() === model.palette[9].join());
  assert.ok(![...evaluated.materials.subarray(0, evaluated.count)].includes(ink + base));
  // Turning the figure round moves the shadows: from behind, what was lit from the front-left is now in shadow.
  e.select(e.frame.objects[0].unique_id, 0); e.beginDrag('turn'); e.setSpatialPose({turn: Math.PI}); e.commitDrag();
  const back = e.geometry.objects.get(0).spatialMesh;
  assert.notDeepEqual([...back.materials.subarray(0, back.count)], [...evaluated.materials.subarray(0, evaluated.count)]);
});

test('modeling tools from the tutorials: shear, soft select, mirror clipping, circle', async () => {
  const X = await import('../src/modeler/matrix.mjs');
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  // Shear: points slide along X by k times their height; height itself is unchanged.
  const sh = X.shearing([1, 0, 0], [0, 1, 0], .5);
  assert.ok(Object.isFrozen(sh));
  assert.deepEqual([...X.transformPoint(sh, [0, 2, 0])], [1, 2, 0]);
  assert.deepEqual([...X.transformPoint(sh, [3, 0, 1])], [3, 0, 1]);
  // Soft select: full weight never given to unselected points; falls to 0 at the radius.
  const line = Array.from({length: 11}, (_, i) => [i / 10, 0, 0]);
  const w = M.softWeights(line, new Set([0]), .5);
  assert.ok(!w.has(0) && !w.has(5) && !w.has(10));
  assert.ok(w.get(1) > w.get(2) && w.get(2) > w.get(4) && w.get(4) > 0 && w.get(1) < 1);
  assert.equal(M.softWeights(line, new Set(), .5).size, 0);
  // Per-point transforms keep topology and leave other points alone.
  const box = cube(1), moved = M.transformMeshEach(box, new Map([[0, translation([0, 1, 0])], [1, translation([0, .5, 0])]]));
  assert.ok(validateMesh(moved).ok);
  assert.equal(moved.verts[0][1], box.verts[0][1] + 1); assert.equal(moved.verts[1][1], box.verts[1][1] + .5); assert.deepEqual(moved.verts[2], box.verts[2]);
  assert.notEqual(moved.verts, box.verts);
  // Mirror clipping, with the part moved and scaled: points on world X = 0 stay there, none cross it.
  const part = {position: [0, 1, 0], rotation: [0, 0, 0], scale: [2, 2, 2]}, om = M.objectMatrix(part);
  const half = {verts: [[0, 0, 0], [.25, 0, 0], [.25, 1, 0], [0, 1, 0]], faces: [{v: [0, 1, 2, 3], c: 0}]};
  const pushed = M.transformMesh(half, translation([-.4, 0, 0]));
  const clipped = M.clipToMirror(half, pushed, om, [0, 1, 2, 3]);
  for (const p of clipped.verts) assert.ok(Math.abs(X.transformPoint(om, p)[0]) < 1e-12);
  const nudged = M.clipToMirror(half, M.transformMesh(half, translation([.1, 0, 0])), om, [0, 1, 2, 3]);
  assert.equal(X.transformPoint(om, nudged.verts[0])[0], 0, 'a middle point stays in the middle');
  assert.ok(Math.abs(nudged.verts[1][0] - .35) < 1e-12, 'others move freely');
  // The circle faces the front and is one face, ready for insetting into eye rings.
  const disc = PRIMITIVES.circle();
  assert.ok(validateMesh(disc).ok); assert.equal(disc.faces.length, 1); assert.deepEqual(M.faceNormal(disc, disc.faces[0]), [0, 0, 1]);
  const rings = M.cloneMesh(disc); M.insetFaces(rings, new Set([0]), .1); M.insetFaces(rings, new Set([rings.faces.length - 1]), .1);
  assert.ok(validateMesh(rings).ok);
});

test('a toon-shaded, outlined model survives saving and reopening the project, and re-editing', async () => {
  const {buildContainerV2, decodeDocument} = await import('../src/native-container.mjs');
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p); baseCharacterSkeleton(model);
  for (const p of model.parts) p.outline = {on: true, thickness: .015, color: 9};
  model.parts.find(p => p.name === 'Head').shadows = false;
  model.toon = {shadows: true, turn: -60, height: 30, size: .5, strength: .4};
  const e = new Editor({demo: false}); e.load({...emptyDocument(), ...modelDocument(model).document});
  const {document} = await decodeDocument(await buildContainerV2(e.report, 'styk'), 'styk');
  const saved = e.report.figure_types[0]._styk.spatialMesh, opened = document.figure_types[0]._styk.spatialMesh;
  assert.deepEqual(opened.toon, saved.toon);
  assert.deepEqual(opened.groups, saved.groups);
  const again = new Editor({demo: false}); again.load(document);
  const before = e.geometry.objects.get(0).spatialMesh, after = again.geometry.objects.get(0).spatialMesh;
  assert.deepEqual([...after.materials.subarray(0, after.count)], [...before.materials.subarray(0, before.count)]);
  // Re-editing keeps the toon settings on the model source.
  const source = readModel(document.figure_types[0]._styk.modelSource);
  assert.deepEqual(source.toon, model.toon);
  assert.equal(source.parts.filter(p => p.outline?.on).length, model.parts.length);
  assert.equal(source.parts.find(p => p.name === 'Head').shadows, false);
});

test('tracing a shape from a single point: extrude points, join, bridge, fill (every step valid)', async () => {
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  const ok = (mesh, what) => { const r = validateMesh(mesh, {print: false}); assert.ok(r.ok, `${what}: ${r.errors.map(e => e.message).join('; ')}`); };
  // Start: one loose point.
  const mesh = PRIMITIVES.point(); ok(mesh, 'single point');
  // Trace a line of 4 points upward (E, move, E, move...).
  let at = new Set([0]);
  for (let k = 1; k <= 3; k++) { at = M.extrudePoints(mesh, at); const [v] = at; mesh.verts[v] = [0, k * .1, 0]; ok(mesh, `extrude ${k}`); }
  assert.equal(mesh.verts.length, 4); assert.equal(mesh.edges.length, 3); assert.equal(mesh.loose, undefined, 'the first point is no longer loose');
  // A second line beside it with Ctrl+click, starting fresh.
  const s0 = M.addPoint(mesh, [.1, 0, 0], null); let prev = s0;
  for (let k = 1; k <= 3; k++) prev = M.addPoint(mesh, [.1, k * .1, 0], prev);
  ok(mesh, 'second line');
  // Bridge the two lines: three quads, facing the viewer (+Z).
  const faces = M.bridge(mesh, new Set(mesh.verts.map((_, i) => i)), {facing: [0, 0, 1]});
  assert.equal(faces.size, 3); ok(mesh, 'bridge');
  for (const fi of faces) assert.ok(M.faceNormal(mesh, mesh.faces[fi])[2] > .99, 'bridged faces face the viewer');
  assert.equal(mesh.edges, undefined, 'the bridged lines became face edges');
  // Uneven lines bridge with triangles where one catches up.
  const uneven = {verts: [[0, 0, 0], [0, .1, 0], [0, .2, 0], [.1, 0, 0], [.1, .2, 0]], faces: [], edges: [[0, 1], [1, 2], [3, 4]]};
  M.bridge(uneven, new Set([0, 1, 2, 3, 4]), {facing: [0, 0, 1]}); ok(uneven, 'uneven bridge');
  // Two rings bridge into a tube.
  const ring = (r, z, base) => Array.from({length: 6}, (_, i) => [r * Math.cos(i / 6 * Math.PI * 2), r * Math.sin(i / 6 * Math.PI * 2), z]);
  const tube = {verts: [...ring(.5, 0), ...ring(.5, 1)], faces: [], edges: [...Array.from({length: 6}, (_, i) => [i, (i + 1) % 6]), ...Array.from({length: 6}, (_, i) => [6 + i, 6 + (i + 1) % 6])]};
  assert.equal(M.bridge(tube, new Set(tube.verts.map((_, i) => i))).size, 6); ok(tube, 'ring bridge');
  // F: two points get a line, a traced ring becomes one face in its own order.
  const square = {verts: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [], loose: [0, 1, 2, 3]};
  M.fillVerts(square, new Set([0, 1])); M.fillVerts(square, new Set([1, 2])); M.fillVerts(square, new Set([2, 3])); M.fillVerts(square, new Set([3, 0]));
  ok(square, 'ring of lines'); assert.equal(square.edges.length, 4); assert.equal(square.loose, undefined);
  const face = M.fillVerts(square, new Set([0, 1, 2, 3]), 0, {facing: [0, 0, -1]});
  ok(square, 'filled ring'); assert.ok(M.faceNormal(square, square.faces[face])[2] < -.99, 'faces the given viewer'); assert.equal(square.edges, undefined);
  // Deleting a middle point leaves its neighbours (the far end becomes a loose point).
  const line = {verts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], faces: [], edges: [[0, 1], [1, 2]]};
  M.deleteVerts(line, new Set([1])); ok(line, 'delete middle'); assert.equal(line.verts.length, 2); assert.deepEqual(line.loose?.length, 2);
  // Merging the two ends of a line leaves one loose point, not a broken edge.
  const pair = {verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1]]};
  M.mergeVerts(pair, new Set([0, 1])); ok(pair, 'merge a line'); assert.equal(pair.verts.length, 1); assert.deepEqual(pair.loose, [0]);
  // Rule checks catch broken wires.
  for (const [bad, rule] of [[{verts: [[0, 0, 0]], faces: [], edges: [[0, 0]]}, 'W1'], [{verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1], [1, 0]]}, 'W2'],
    [{verts: [[0, 0, 0], [1, 0, 0]], faces: [], edges: [[0, 1]], loose: [0]}, 'L1'], [{verts: [[0, 0, 0], [1, 0, 0]], faces: []}, 'H7'], [{verts: [[0, 0, 0]], faces: [], edges: [[0, 5]]}, 'W1']])
    assert.ok(validateMesh(bad, {print: false}).errors.some(e => e.rule === rule), rule);
  assert.ok(validateMesh(square, {print: false}).ok);
  // A failed edit rolls the wires back exactly.
  const keep = JSON.stringify(tube);
  assert.throws(() => M.bridge(tube, new Set([0, 1])));
  assert.equal(JSON.stringify(tube), keep);
});

test('traced lines stay out of the stage: evaluation, export, outlines, symmetrize, saving', async () => {
  const {validateMesh} = await import('../src/modeler/topology.mjs');
  const model = emptyModel(), part = addPart(model, {name: 'Face', mesh: cube(1), position: [0, 1, 0]});
  // A traced line hanging off the cube, plus a loose point.
  part.mesh.verts.push([0, 2, 0], [0, 2.5, 0], [.3, 2, 0]);
  part.mesh.edges = [[0, 8], [8, 9]]; part.mesh.loose = [10];
  assert.ok(validateMesh(part.mesh).ok);
  const surface = evaluatePart(part);
  assert.equal(surface.verts.length, 8, 'only the cube'); assert.equal(surface.edges, undefined);
  part.outline = {on: true, thickness: .02, color: 9}; part.mirror = true;
  humanoidSkeleton(model, [surface]);
  const {figure} = modelToFigure(model);
  assert.ok(figure._styk.spatialMesh.positions.length > 0);
  // Saving and opening keeps the tracing for later.
  const again = readModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(again.parts[0].mesh.edges, part.mesh.edges); assert.deepEqual(again.parts[0].mesh.loose, part.mesh.loose);
  // Symmetrize mirrors the lines on the kept side.
  const half = {verts: [[0, 0, 0], [.5, 0, 0], [.5, 1, 0]], faces: [], edges: [[0, 1], [1, 2]]};
  M.symmetrize(half, true); assert.ok(validateMesh(half).ok); assert.equal(half.edges.length, 4);
  // Transforms keep them.
  const moved = M.transformMesh(part.mesh, translation([1, 0, 0]));
  assert.deepEqual(moved.edges, part.mesh.edges); assert.notEqual(moved.edges, part.mesh.edges);
});

/** A cartoon figure in separate pieces, like a game export: a big head with
 * spikes out behind it, a short trunk, thin one-piece legs, large shoes
 * pointing +Z, arms out (raised by `armDrop` per unit out: 0 is a T pose) and
 * dense fists. */
function cartoon({armDrop = 0} = {}) {
  const box = (size, at, segs = 1) => M.transformMesh(segs > 1 ? uvSphere(size[0] / 2, segs, segs) : cube(1), translation(at));
  const scaled = (mesh, s) => ({...mesh, verts: mesh.verts.map(v => v.map((x, k) => x * s[k]))});
  const piece = (s, at, segs) => { const m = scaled(segs ? uvSphere(.5, segs, segs) : cube(1), s); return M.transformMesh(m, translation(at)); };
  void box;
  const parts = [
    piece([.5, .45, .45], [0, .95, .05], 12), // head
    piece([.08, .5, .3], [.14, .95, -.3]), piece([.08, .5, .3], [-.14, .95, -.3]), // spikes behind, out to the sides
    piece([.18, .22, .14], [0, .63, 0]), // trunk
    piece([.05, .3, .05], [.08, .38, 0]), piece([.05, .3, .05], [-.08, .38, 0]), // one-piece legs (hip to ankle)
    piece([.12, .14, .34], [.09, .07, .1]), piece([.12, .14, .34], [-.09, .07, .1]), // shoes, toes +Z
  ];
  for (const s of [1, -1]) {
    for (let i = 0; i < 6; i++) { const x = .13 + i * .055; parts.push(piece([.055, .05, .05], [s * x, .72 - armDrop * (x - .13), 0])); }
    const x = .5; parts.push(piece([.11, .12, .12], [s * x, .72 - armDrop * (x - .13), 0], 8)); // fist: many points
  }
  return parts;
}

test('humanoid skeleton fits a cartoon model: joints where its hands, crotch, ankles and toes are', () => {
  for (const armDrop of [0, .5]) {
    const fit = fitHumanoid(cartoon({armDrop})), {arm, leg, spine} = fit;
    assert.ok(fit, `armDrop ${armDrop}`);
    assert.equal(fit.front, 1, 'shoes point +Z');
    assert.ok(Math.abs(leg.hip[1] - .53) < .05, `crotch ${leg.hip[1]}`);
    assert.ok(leg.ankle[1] > .1 && leg.ankle[1] < .2, `ankle at the shoe top ${leg.ankle[1]}`);
    assert.ok(leg.toe[2] > .15, `toes forward ${leg.toe[2]}`);
    assert.ok(Math.abs(leg.hip[0] - .08) < .02, `leg x ${leg.hip[0]}`);
    // The arm's line, not the spikes beside the shoulder.
    const armY = x => .72 - armDrop * (x - .13);
    for (const [name, p] of Object.entries({shoulder: arm.shoulder, elbow: arm.elbow, wrist: arm.wrist})) assert.ok(Math.abs(p[1] - armY(p[0])) < .03, `${name} y ${p[1]} at x ${p[0]} (arm ${armY(p[0])})`);
    assert.ok(arm.wrist[0] > .38 && arm.wrist[0] < .47, `wrist before the fist ${arm.wrist[0]}`);
    assert.ok(arm.tip[0] > .54, `hand reaches the fist's end ${arm.tip[0]}`);
    assert.ok(spine[0][1] < spine[3][1] && spine[3][1] < spine[4][1] && spine[4][1] < spine[5][1], 'spine goes up');
  }
  // Arms down at the sides: the average-adult layout, fitted to the size.
  const model = emptyModel(); for (const p of baseCharacter()) addPart(model, p);
  assert.equal(fitHumanoid(model.parts.map(p => evaluatePart(p, {smooth: false}))), null);
});

test('automatic weights: one-piece legs bend at the knee, the head region follows the head', () => {
  const model = emptyModel(), parts = cartoon();
  parts.forEach((mesh, i) => addPart(model, {name: `Piece ${i}`, mesh}));
  humanoidSkeleton(model, model.parts.map(p => evaluatePart(p, {smooth: false})));
  const name = new Map(model.bones.map(b => [b.id, b.name]));
  const bonesOf = part => { const mesh = evaluatePart(part, {smooth: false}), w = autoWeights(model, mesh, part); return new Set(w.bones.filter((id, i) => id && w.weights[i] > .05).map(id => name.get(id))); };
  const leg = bonesOf(model.parts[4]);
  assert.ok(leg.has('Thigh.L') && leg.has('Shin.L'), `the leg bends at the knee: ${[...leg]}`);
  for (const spike of [model.parts[1], model.parts[2]]) {
    const got = bonesOf(spike);
    assert.ok([...got].every(n => n === 'Head' || n === 'Neck'), `spikes follow the head, not an arm or the chest: ${[...got]}`);
  }
  assert.deepEqual([...bonesOf(model.parts[8 + 6])], ['Hand.L'], 'the fist follows the hand');
});
