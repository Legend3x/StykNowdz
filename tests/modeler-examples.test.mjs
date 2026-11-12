import test from 'node:test';
import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {readModel, evaluatePart} from '../src/modeler/model.mjs';
import {validateMesh} from '../src/modeler/topology.mjs';
import {modelToFigure} from '../src/modeler/export-figure.mjs';
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
    assert.ok(model.toon?.shadows && model.parts.every(p => p.outline?.on), 'toon shadows and outlines on');
    assert.ok(statSync(new URL(`../src/modeler/examples/${file}.mjs`, import.meta.url)).size < 120_000, 'small enough to load at once');
  });
}

test('example Juniper keeps her face rig, Kettle his skeleton fitted to the A pose', () => {
  const j = readModel(juniper), k = readModel(kettle);
  assert.ok(j.bones.some(b => b.face), 'face bones');
  const arm = k.bones.find(b => b.name === 'UpperArm.L');
  assert.ok(arm.tail[1] < arm.head[1] - .15 && arm.tail[0] > arm.head[0] + .15, 'upper arm angled down and out');
});
