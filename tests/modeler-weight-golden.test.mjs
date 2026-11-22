import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {goldenResults, summaryOf, sameSummary, FIXTURE} from './support/weight-golden.mjs';

// Weights, posed points, painting, saving, glTF export, merging and skeleton files give the
// same numbers as when the fixture was recorded (node tests/support/weight-golden.mjs write).
// A change here is a change in what people's models do: re-record only when that is intended,
// and say why in the commit.
test('weight painting golden results are unchanged', async () => {
  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')), results = await goldenResults();
  assert.deepEqual(Object.keys(results).sort(), Object.keys(expected).sort());
  const changed = Object.keys(expected).filter(k => !sameSummary(expected[k], summaryOf(results[k])));
  assert.deepEqual(changed, [], `changed: ${changed.join(', ')}`);
});
