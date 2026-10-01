/**
 * The scale tier's oracle: a result counts only when it answers the question its
 * own transaction asked. The regression is the circular reading — a Worker that
 * read one file and answered for another was graded against the file it named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultMatchesGrant } from '../checks/scale.mjs';

const fileA = { symbol: 'alpha', line: 3 };
const fileB = { symbol: 'beta', line: 7 };

test('a result is graded against its transaction\'s granted file, not the file it names', () => {
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'alpha', line: 3, grantedFile: 'src/a.mjs', expected: fileA }), true);
  // An accurate description of a *different* corpus file is still a wrong answer.
  assert.equal(resultMatchesGrant({ file: 'src/b.mjs', symbol: 'beta', line: 7, grantedFile: 'src/a.mjs', expected: fileA }), false);
  // Right file, declaration from elsewhere.
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'beta', line: 3, grantedFile: 'src/a.mjs', expected: fileA }), false);
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'alpha', line: 4, grantedFile: 'src/a.mjs', expected: fileA }), false);
  // A transaction with no frozen file, or a file with no readable declaration,
  // cannot be certified.
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'alpha', line: 3, grantedFile: null, expected: fileA }), false);
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'alpha', line: 3, grantedFile: 'src/a.mjs', expected: null }), false);
  // The line arrives as submitted JSON, so a numeric string is the same answer.
  assert.equal(resultMatchesGrant({ file: 'src/a.mjs', symbol: 'alpha', line: '3', grantedFile: 'src/a.mjs', expected: fileA }), true);
});
test('a Worker answering for two transactions is not a distinct Worker per file', async () => {
  const { distinctWorkersCoverFiles } = await import('../checks/scale.mjs');
  assert.equal(distinctWorkersCoverFiles(['a', 'b', 'c'], ['w1', 'w2', 'w3']), true);
  assert.equal(distinctWorkersCoverFiles(['a', 'b', 'c'], ['w1', 'w1', 'w3']), false, 'one identity covering two files');
  assert.equal(distinctWorkersCoverFiles(['a', 'b'], ['w1', null]), false, 'a file with no Worker at all');
  assert.equal(distinctWorkersCoverFiles([], []), false, 'an empty tier proves nothing');
});
