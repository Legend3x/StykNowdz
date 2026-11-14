import test from 'node:test';
import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';
import {swapSets, swapChoiceOf} from '../src/modeler/layers.mjs';
import juniper from '../src/modeler/examples/juniper.mjs';
import kettle from '../src/modeler/examples/kettle.mjs';

const quiet = {print: false};

// Start > Examples: characters made in 3D Nowdz with its own tools. They open
// like a saved model, so they must pass the same checks, and each must still
// become an animatable figure.
for (const [file, data, name] of [['juniper', juniper, 'Juniper'], ['kettle', kettle, 'Kettle']]) {
  test(`example ${name} opens as a valid, riggable model`, () => {
    const model = readModel(data);
    assert.equal(model.name, name);
    for (const part of model.parts) {
      assert.ok(validateMesh(part.mesh, quiet).ok, `${part.name} follows the mesh rules`);
      assert.ok(validateMesh(evaluatePart(part), quiet).ok, `${part.name} with its mirror, solidify and smooth`);
    }
    for (const bone of ['Hips', 'Head', 'UpperArm.L', 'Hand.R', 'Thigh.L', 'Foot.R']) assert.ok(model.bones.some(b => b.name === bone), `${name} has ${bone}`);
    const {figure} = modelToFigure(model);
    assert.ok(figure._styk.spatialMesh.positions.length > 0);
    // Face set pieces are flat decals on the face, with no outline of their own.
    assert.ok(model.toon?.shadows && model.parts.filter(p => !swapChoiceOf(model, p)).every(p => p.outline?.on), 'toon shadows and outlines on');
    assert.ok(statSync(new URL(`../src/modeler/examples/${file}.mjs`, import.meta.url)).size < 120_000, 'small enough to load at once');
  });
}

test('example Juniper has a face made of swap sets, Kettle a starter face and his skeleton fitted to the A pose', () => {
  const j = readModel(juniper), k = readModel(kettle);
  const sets = model => Object.fromEntries(swapSets(model).map(s => [s.set.name, s.choices.map(c => c.label)]));
  assert.deepEqual(sets(j), {Mouth: ['Closed', 'Open', 'A', 'O', 'Smile'], Eyes: ['Open', 'Closed', 'Happy'], Brows: ['Normal', 'Angry', 'Worried']});
  assert.deepEqual(sets(k), {Mouth: ['Closed', 'Open', 'A', 'O', 'Smile'], Eyes: ['Open', 'Closed', 'Happy']});
  assert.ok(!j.bones.some(b => b.face), 'the face sets replace her face bones');
  // On the stage each choice is a pose choice, one shown per set.
  const {figure, hiddenChoices} = modelToFigure(j), choices = figure.segments.filter(s => s._stykPoseChoice);
  assert.equal(choices.length, 11); assert.equal(hiddenChoices.size, 8);
  assert.ok(choices.every(s => figure.segments.find(x => x.segment_id === s.parent_id)?.name === 'Head'), 'every choice rides the head');
  const arm = k.bones.find(b => b.name === 'UpperArm.L');
  assert.ok(arm.tail[1] < arm.head[1] - .15 && arm.tail[0] > arm.head[0] + .15, 'upper arm angled down and out');
});
