/**
 * The scale tier's oracle: a result counts only when it answers the question its
 * own transaction asked. The regression is the circular reading — a Worker that
 * read one file and answered for another was graded against the file it named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  distinctWorkersCoverFiles, frozenGrantedFile, resultMatchesGrant, successfulReadPath,
} from '../checks/scale.ts';

const fileA: { symbol: string; line: number } = { symbol: 'alpha', line: 3 };

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
test('a Worker answering for two transactions is not a distinct Worker per file', () => {
  assert.equal(distinctWorkersCoverFiles(['a', 'b', 'c'], ['w1', 'w2', 'w3']), true);
  assert.equal(distinctWorkersCoverFiles(['a', 'b', 'c'], ['w1', 'w1', 'w3']), false, 'one identity covering two files');
  assert.equal(distinctWorkersCoverFiles(['a', 'b'], ['w1', null]), false, 'a file with no Worker at all');
  assert.equal(distinctWorkersCoverFiles([], []), false, 'an empty tier proves nothing');
});

test('the graded file comes from the frozen spec, not from the live inputs', async () => {
  // `adjust_transaction` may legally replace `inputs` mid-run, so a transaction
  // whose live row says B while the spec assigned A must still be graded against
  // A — otherwise the run could move the question instead of failing the answer.
  const spec = [
    { id: 'tx-a', inputs: { path: 'group-00/module-000.js', file: 'corpus/group-00/module-000.js', hash: 'sha256:aaa' } },
    { id: 'tx-b', inputs: { file: 'corpus/group-01/module-003.js', hash: 'sha256:bbb' } },
  ];
  assert.equal(frozenGrantedFile(spec, 'tx-a'), 'corpus/group-00/module-000.js');
  assert.equal(frozenGrantedFile(spec, 'tx-b'), 'corpus/group-01/module-003.js');
  // Prefers `file`, falls back to `path`, and never invents a grant.
  assert.equal(frozenGrantedFile([{ id: 'tx-c', inputs: { path: 'plain.js' } }], 'tx-c'), 'plain.js');
  assert.equal(frozenGrantedFile(spec, 'tx-unknown'), null, 'a transaction the spec does not name has no grant to grade against');
  assert.equal(frozenGrantedFile(null, 'tx-a'), null);
  assert.equal(frozenGrantedFile([{ id: 'tx-d', inputs: {} }], 'tx-d'), null);

  // A submission that answers the live row instead of the frozen grant is wrong.
  const expectedForA = { symbol: 'alpha', line: 3 };
  const granted = frozenGrantedFile(spec, 'tx-a');
  assert.equal(resultMatchesGrant({ file: 'corpus/group-01/module-003.js', symbol: 'beta', line: 7, grantedFile: granted, expected: expectedForA }), false,
    'the live row pointing at B does not make B the question');
});

test('a settled read receipt that errored proves no path', () => {
  const ok = { result_body: JSON.stringify({ isError: false, text: '<path>/w/corpus/a.js</path>\n1: x' }), error: null };
  assert.equal(successfulReadPath(ok), '/w/corpus/a.js', 'a successful read reports the path it read');
  // SETTLED covers error results too: the call finished, the tool did not.
  const errored = { result_body: JSON.stringify({ isError: true, text: 'Error: invalid arguments' }), error: 'ToolArgsError' };
  assert.equal(successfulReadPath(errored), null);
  assert.equal(successfulReadPath({ result_body: JSON.stringify({ isError: true, text: '<path>/w/corpus/a.js</path>' }), error: null }), null,
    'a path inside an errored body is not evidence the file was read');
  assert.equal(successfulReadPath({ result_body: JSON.stringify({ text: '<path>/w/corpus/a.js</path>' }), error: null }), null,
    'a receipt that never states success is not a successful read');
  assert.equal(successfulReadPath({ result_body: 'not json', error: null }), null);
  assert.equal(successfulReadPath({ result_body: JSON.stringify({ isError: false, text: 'no path here' }), error: null }), null);
  assert.equal(successfulReadPath({ result_body: JSON.stringify({ isError: false, text: '<path>/w/a.js</path>' }), error: 'transport' }), null);
  assert.equal(successfulReadPath(null), null);
});
