import test from 'node:test';
import assert from 'node:assert/strict';
import {readFace, featureValue, readFaceValues, interpolateFace, faceRecipe, faceUrl, composeFace, recipeImages, drawingsOf} from '../src/face-rig.mjs';

const PNG = n => `data:image/png;base64,AAAAAAAAQ${String(n).padStart(3, '0')}AA=`;
const face = () => ({texture: 1, features: [
  {id: 'eyeL', kind: 'eye', name: 'Left eye', x: .4, y: .55, w: .12, h: .08, angle: 0, states: [{name: 'Open', under: PNG(1), over: PNG(2)}, {name: 'Closed', over: PNG(3)}], pupil: {src: PNG(4), size: .5, range: [.3, .2]}},
  {id: 'eyeR', kind: 'eye', name: 'Right eye', x: .6, y: .55, w: .12, h: .08, angle: 0, mirrorOf: 'eyeL', states: []},
  {id: 'brow', kind: 'brow', name: 'Brow', x: .4, y: .65, w: .12, h: .04, angle: 0, states: [{name: 'Normal', over: PNG(5)}]},
  {id: 'mouth', kind: 'mouth', name: 'Mouth', x: .5, y: .35, w: .15, h: .08, angle: 0, states: [{name: 'Rest', over: PNG(6)}, {name: 'A', over: PNG(7)}]},
  {id: 'blush', kind: 'extra', name: 'Blush', x: .5, y: .45, w: .4, h: .1, angle: 0, states: [{name: 'Blush', over: PNG(8)}]}]});

test('stored faces are cleaned: bad images, kinds, ids and mirrors go; numbers stay in range', () => {
  const f = face();
  f.features.push({id: 'bad id!', kind: 'eye', states: []}, {id: 'nose', kind: 'nose', states: []}, {id: 'brow', kind: 'brow', states: []});
  f.features[0].states[0].over = 'https://example.com/x.png'; f.features[2].x = 99; f.features[3].mirrorOf = 'eyeL';
  const read = readFace(f, new Set([1]));
  assert.deepEqual(read.features.map(x => x.id), ['eyeL', 'eyeR', 'brow', 'mouth', 'blush']);
  assert.equal(read.features[0].states[0].over, undefined); assert.equal(read.features[2].x, 2);
  assert.equal(read.features[3].mirrorOf, undefined, 'a mouth cannot mirror an eye');
  assert.equal(drawingsOf(read, read.features[1]), read.features[0], 'the right eye shows the left one');
  assert.equal(readFace(face(), new Set([2])), null, 'a face on a missing texture is dropped');
  assert.deepEqual(readFace(read, new Set([1])), read, 'reading again changes nothing');
});

test('values: rest by default, stored values cleaned, states hold and numbers tween', () => {
  const f = readFace(face());
  assert.deepEqual(featureValue(f, f.features[4]), {s: 0, x: 0, y: 0, r: 0, a: 0, o: 0}, 'extras start hidden');
  assert.deepEqual(featureValue(f, f.features[1], {s: 5}).s, 1, 'a mirror has its source’s states');
  assert.deepEqual(readFaceValues(f, {eyeL: {x: .5, y: 0, s: 0, o: 7, junk: 1}, mouth: {x: 0}, ghost: {s: 1}}), {eyeL: {x: .5, o: 1}}, 'rest values are left out; numbers clamp');
  const a = {eyeL: {s: 0, x: -1}, mouth: {s: 0}}, b = {eyeL: {s: 1, x: 1}, mouth: {s: 1}, blush: {o: 1}};
  const half = interpolateFace(a, b, .5);
  assert.deepEqual(half, {blush: {o: .5}}, 'states hold until the next key; a missing value is rest');
  assert.deepEqual(interpolateFace(a, b, 1).eyeL, {x: 1, s: 1});
  assert.deepEqual(interpolateFace({mouth: {s: 2, x: .4}}, {}, .5), {mouth: {s: 2, x: .2}}, 'easing back to rest');
  assert.equal(interpolateFace(a, null, .5), a);
});

test('a recipe names its picture: same values, same key; any visible change, a new one', () => {
  const f = readFace(face()), base = {src: PNG(20), width: 512, height: 512};
  const k = v => faceRecipe(f, base, v).key;
  assert.equal(k({}), k({eyeL: {x: 0}}), 'rest equals spelled-out rest');
  assert.notEqual(k({}), k({eyeL: {x: .2}}));
  assert.notEqual(k({}), k({mouth: {s: 1}}));
  assert.notEqual(k({}), faceRecipe(f, {...base, src: PNG(21)}, {}).key, 'another base image is another picture');
  const g = readFace(face()); g.features[0].x = .41;
  assert.notEqual(faceRecipe(g, base, {}).key, k({}), 'moving a feature is another picture');
  const r = faceRecipe(f, base, {eyeL: {s: 1}, eyeR: {s: 1}});
  assert.ok(faceUrl(r).startsWith('stykface:'));
  assert.equal(r.features[1].flip, true); assert.equal(r.features[1].over, r.features[0].over, 'the mirror draws the source’s state, flipped');
  assert.notEqual(faceRecipe(f, base, {eyeL: {s: 1}}).features[1].over, PNG(3), 'each eye keeps its own state (a wink)');
  assert.deepEqual(new Set(recipeImages(r)), new Set([base.src, PNG(3), PNG(4), PNG(5), PNG(6), PNG(8)]));
});

test('composing: base, then each feature; pupils masked by the white, lids on top; hidden extras skipped', () => {
  const f = readFace(face()), base = {src: PNG(20), width: 512, height: 512}, log = [];
  const fake = name => new Proxy({canvas: {name}}, {get: (o, p) => p in o ? o[p] : (...args) => { if (p === 'drawImage') log.push(['draw', name, args[0]]); }, set: (o, p, v) => { if (p === 'globalCompositeOperation') log.push(['op', name, v]); o[p] = v; return true; }});
  const images = new Map(recipeImages(faceRecipe(f, base, {})).map(src => [src, src]));
  const scratch = fake('scratch');
  composeFace(fake('face'), faceRecipe(f, base, {}), images, () => scratch);
  const draws = log.filter(([kind]) => kind === 'draw').map(([, c, x]) => `${c}:${typeof x === 'string' ? x.slice(-6) : x.name}`);
  const index = s => draws.findIndex(d => d.endsWith(s));
  assert.ok(draws[0].startsWith('face:') && draws[0].endsWith(PNG(20).slice(-6)), 'the base comes first');
  assert.ok(index(PNG(1).slice(-6)) < index('scratch') && index('scratch') < index(PNG(2).slice(-6)), 'white, masked pupil, then lids');
  assert.ok(log.some(([kind, c, v]) => kind === 'op' && c === 'scratch' && v === 'destination-in'), 'the pupil is cut to the white');
  assert.ok(!draws.some(d => d.endsWith(PNG(8).slice(-6))), 'a hidden blush is not drawn');
});

import * as Mesh from '../src/modeler/mesh.mjs';
import {cube} from '../src/modeler/primitives.mjs';
import {emptyModel, addPart, readModel} from '../src/modeler/model.mjs';
import {addTexture} from '../src/modeler/uv.mjs';
import {modelDocument} from '../src/modeler/export-figure.mjs';
import {Editor} from '../src/editor.mjs';
import {createBlankDocument} from '../src/startup-document.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {faceRecipeOf} from '../src/face-compose.mjs';

const REAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
function facedModel() {
  const model = emptyModel(), tex = addTexture(model, {name: 'Head', src: REAL_PNG, width: 1, height: 1});
  const mesh = Mesh.cloneMesh(cube(1)); for (const f of mesh.faces) { f.uv = [[0, 0], [1, 0], [1, 1], [0, 1]]; f.t = tex.id; }
  addPart(model, {name: 'Head', mesh});
  const f = face(); f.texture = tex.id;
  for (const feature of f.features) for (const s of feature.states) { if (s.over) s.over = REAL_PNG; if (s.under) s.under = REAL_PNG; }
  f.features[0].pupil.src = REAL_PNG;
  model.face = f;
  return readModel(JSON.parse(JSON.stringify(model)));
}
/** A scene holding the model, placed by the editor as Add to animation does. */
function sceneWith(model) {
  const e = new Editor({demo: false, layerTimeline: true}); e.load(createBlankDocument({canvas: {width: 400, height: 400}}), 'Face');
  e.importFigure(modelDocument(model).document);
  return e;
}

test('a model with a face reaches the stage: its picture follows each object’s values', () => {
  const model = facedModel();
  assert.ok(model.face && model.face.features.length === 5, 'the face survives reading the model');
  const e = sceneWith(model);
  assert.equal(e.face.texture, 0, 'the face draws on texture slot 0');
  const urlOf = () => { const g = e.geometry, items = [...(g.drawables ?? [])].concat(...[...g.objects.values()].map(o => o.drawables ?? [])); return items.find(d => d.type === 'mesh')?.textureUrls?.[0]; };
  const rest = urlOf();
  assert.ok(rest?.startsWith('stykface:'), String(rest));
  assert.equal(e.setFaceValues({eyeL: {s: 1}}), true); const closed = urlOf();
  assert.equal(e.setFaceValues({eyeL: {x: 0}}), false, 'rest values change nothing');
  assert.notEqual(rest, closed);
  assert.equal(faceRecipeOf(closed).features[0].v.s, 1, 'the loaders can find what to paint');
  e.undo(); assert.equal(urlOf(), rest, 'one undo step');
  e.setFaceValues({eyeL: {x: .5, s: 1}}, {linked: true});
  assert.deepEqual(e.faceValues().eyeR, e.faceValues().eyeL, 'linked eyes move together'); assert.equal(e.faceValues().eyeR.x, .5);
  assert.equal(e.setFaceValues({ghost: {s: 1}}), false, 'unknown features are ignored');
  const saved = e.serialize(), again = new Editor({demo: false, layerTimeline: true}); again.load(JSON.parse(JSON.stringify(saved)), 'Again'); again.select(e.selectedUid);
  assert.deepEqual(again.faceValues(), e.faceValues(), 'a saved project keeps the face and its values');
  e.resetFace(); assert.equal(urlOf(), rest);
});

test('between keys the look tweens and states hold', () => {
  const e = sceneWith(facedModel()), uid = e.selectedUid; e.setFrameDuration(20); e.select(uid); e.autoKey = true;
  const key = (tick, values) => { e.seek(tick, {allowBeyondEnd: true}); e.select(uid); e.setFaceValues(values); };
  key(0, {eyeL: {x: -1}, mouth: {s: 0}}); key(10, {eyeL: {x: 1}, mouth: {s: 1}});
  e.sheetSetEasing([e.layerForUid(uid)], 0, 20, {interpolation: 'linear'});
  const at = tick => { e.seek(tick, {allowBeyondEnd: true}); e.select(uid); return e.faceValues(); };
  assert.equal(at(10).mouth.s, 1, 'the second key took'); assert.equal(at(0).eyeL.x, -1, 'the first key kept its look');
  const mid = at(5);
  assert.ok(Math.abs(mid.eyeL.x) < .5, `look halfway (${mid.eyeL.x})`); assert.equal(mid.mouth.s, 0, 'the mouth holds until the next key');
});

test('blink: closed at the playhead, back as it was two frames on, the playhead kept', () => {
  const e = sceneWith(facedModel()), uid = e.selectedUid; e.setFrameDuration(20); e.select(uid);
  e.seek(6); e.select(uid);
  assert.equal(e.blinkFace([['eyeL', 1]]), true);
  assert.equal(e.tick, 6); assert.equal(e.selectedUid, uid);
  const s = tick => { e.seek(tick); e.select(uid); return e.faceValues().eyeL.s; };
  assert.deepEqual([s(5), s(6), s(7), s(8), s(12)], [0, 1, 1, 0, 0]);
  assert.equal(Boolean(e.autoKey), false, 'auto key as it was');
});
