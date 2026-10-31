import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRootCommand, ROOT_COMMAND_PHASE_ACTIONS, ROOT_COMMAND_SCOPE_KEYS,
} from './root-command-contract.mjs';

const expectedPhases = {
  'root-only-preflight': [
    'prepare-writer-domain', 'prepare-historical-accounting',
    'read-root-state', 'close-root-runtime',
  ],
  'offline-qualification': [
    'prepare-installed-cases', 'prepare-historical-accounting',
    'materialize-offline-ui-input', 'qualify-offline',
    'freeze-offline-resource-close', 'read-offline-qualification-state',
    'read-root-state', 'close-root-runtime',
  ],
  'live-wave': [
    'prepare-installed-cases', 'prepare-historical-accounting',
    'prepare-writer-domain', 'bootstrap-live-model-sockets',
    'prepare-live-readonly-cases', 'admit-and-run-live-wave',
    'read-live-wave-state', 'read-root-state', 'close-root-runtime',
  ],
};
function fixture(action = 'read-root-state', sequence = 0) {
  const control = {
    schema: 'root-wave02-root-runtime/v2', controlRoot: '/control/runtime',
    namespaceId: 'example-root', containerId: 'a'.repeat(64),
    generationId: 'example-generation', accountingScope: 'qualification-offline',
  };
  const incoming = '/control/incoming/' + String(sequence).padStart(6, '0');
  const job = {
    schema: 'root-wave02-root-command-publication/v1', controlRoot: control.controlRoot,
    ...Object.fromEntries(ROOT_COMMAND_SCOPE_KEYS.map(key => [key, control[key]])),
    sequence, action,
    input: {
      file: incoming + '/input.json', trustedRoot: incoming,
      expectedUid: 0, expectedGid: 0, allowedModes: [0o444],
      forbiddenRoots: [], forbiddenFiles: [], expectedSha256: 'b'.repeat(64),
    },
  };
  return {job, control, record: {receipt: {sha256: job.input.expectedSha256}}};
}
function build(f) {return makeRootCommand(f.job, f.control, f.record);}

test('all thirteen implemented actions can be published', () => {
  const actions = [...new Set(Object.values(expectedPhases).flat())];
  assert.equal(actions.length, 13);
  for (const action of actions) assert.equal(build(fixture(action)).action, action);
});
test('writer-domain and explicit resource-freeze actions preserve input and scope', () => {
  for (const [action, scope] of [['prepare-writer-domain', 'live-case'], ['freeze-offline-resource-close', 'qualification-offline']]) {
    const f = fixture(action);f.control.accountingScope = scope;f.job.accountingScope = scope;
    const command = build(f);
    assert.deepEqual(command, {schema: 'root-wave02-root-command/v1',
      ...Object.fromEntries(ROOT_COMMAND_SCOPE_KEYS.map(key => [key, f.control[key]])),
      sequence: 0, action, input: f.job.input});
  }
});
test('unknown action is rejected', () => {
  for (const action of ['unknown-action', '', 'qualify-offline ', undefined]) {const f = fixture();f.job.action = action;assert.throws(() => build(f));}
});
test('phase scopes exactly preserve the implemented runtime boundaries', () => {
  assert.deepEqual(ROOT_COMMAND_PHASE_ACTIONS, expectedPhases);
  assert.equal(ROOT_COMMAND_PHASE_ACTIONS['root-only-preflight'].includes('qualify-offline'), false);
  assert.equal(ROOT_COMMAND_PHASE_ACTIONS['offline-qualification'].includes('admit-and-run-live-wave'), false);
  assert.equal(ROOT_COMMAND_PHASE_ACTIONS['live-wave'].includes('qualify-offline'), false);
});
test('phase table, phase lists and scope keys are immutable', () => {
  assert.equal(Object.isFrozen(ROOT_COMMAND_PHASE_ACTIONS), true);
  for (const actions of Object.values(ROOT_COMMAND_PHASE_ACTIONS)) assert.throws(() => actions.push('unknown-action'), TypeError);
  assert.throws(() => {ROOT_COMMAND_PHASE_ACTIONS.extra = [];}, TypeError);
  assert.throws(() => ROOT_COMMAND_SCOPE_KEYS.push('extra'), TypeError);
});
test('publication and control schemas remain required', () => {
  const f = fixture();f.job.schema = 'wrong';assert.throws(() => build(f));
  const g = fixture();g.control.schema = 'wrong';assert.throws(() => build(g));
});
test('all four Root identity fields must match the control', () => {
  assert.deepEqual(ROOT_COMMAND_SCOPE_KEYS, ['namespaceId', 'containerId', 'generationId', 'accountingScope']);
  for (const key of ['namespaceId', 'containerId', 'generationId', 'accountingScope']) {const f = fixture();f.job[key] = 'foreign';assert.throws(() => build(f), key);}
});
test('control directory must match the retained control', () => {
  const f = fixture();f.job.controlRoot = '/another/runtime';assert.throws(() => build(f));
});
test('sequence must be a safe integer in the existing six-digit range', () => {
  for (const sequence of [-1, 1.5, 1_000_000, Number.MAX_SAFE_INTEGER + 1, NaN, undefined]) {const f = fixture();f.job.sequence = sequence;assert.throws(() => build(f));}
  assert.equal(build(fixture('read-root-state', 999_999)).sequence, 999_999);
});
test('input file and trusted root are bound to the exact sequence slot', () => {
  const f = fixture();f.job.input.file = '/control/incoming/000001/input.json';assert.throws(() => build(f));
  const g = fixture();g.job.input.trustedRoot = '/control/incoming/000001';assert.throws(() => build(g));
});
test('input ownership and mode remain Root0 and readonly', () => {
  for (const [key, value] of [['expectedUid', 1000], ['expectedGid', 1000], ['allowedModes', [0o600]]]) {
    const f = fixture();f.job.input[key] = value;assert.throws(() => build(f));
  }
});
test('input exclusions and SHA binding are retained', () => {
  for (const key of ['forbiddenRoots', 'forbiddenFiles']) {const f = fixture();f.job.input[key] = ['/excluded'];assert.throws(() => build(f));}
  const f = fixture();f.record.receipt.sha256 = 'c'.repeat(64);assert.throws(() => build(f));
});

test('matching absent or malformed SHA values cannot satisfy the input pin', () => {
  for (const value of [undefined, null, '', 'a'.repeat(63), 'g'.repeat(64), 7]) {
    const f = fixture();f.job.input.expectedSha256 = value;f.record.receipt.sha256 = value;
    assert.throws(() => build(f));
  }
});
test('both sides of the SHA equality independently require a valid digest', () => {
  for (const key of ['input', 'receipt']) {
    const f = fixture();if (key === 'input') f.job.input.expectedSha256 = undefined;
    else f.record.receipt.sha256 = undefined;
    assert.throws(() => build(f));
  }
});
