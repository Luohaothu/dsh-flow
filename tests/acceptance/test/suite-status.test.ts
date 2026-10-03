import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suiteJobStatus } from '../suite.ts';

test('a failed mechanism overrides a passing scenario in the suite verdict', () => {
  assert.equal(suiteJobStatus(0, 'PASSED', 'FAIL'), 'FAILED');
});

test('nonzero and signal exits cannot pass the suite even with a passing report', () => {
  assert.equal(suiteJobStatus(1, 'PASSED', 'PASS'), 'FAILED');
  assert.equal(suiteJobStatus(null, 'PASSED', 'PASS'), 'FAILED');
});

test('suite verdicts preserve passing and non-passing scenario outcomes', () => {
  assert.equal(suiteJobStatus(0, 'PASSED', 'PASS'), 'PASSED');
  assert.equal(suiteJobStatus(0, 'PASSED', null), 'PASSED');
  assert.equal(suiteJobStatus(0, 'FAILED', 'PASS'), 'FAILED');
  assert.equal(suiteJobStatus(0, 'BLOCKED', 'PASS'), 'BLOCKED');
  assert.equal(suiteJobStatus(0, null, 'PASS'), 'FAILED');
});
