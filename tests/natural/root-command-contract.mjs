import assert from 'node:assert/strict';
import path from 'node:path';

export const ROOT_COMMAND_SCOPE_KEYS = Object.freeze([
  'namespaceId', 'containerId', 'generationId', 'accountingScope',
]);

// The publisher accepts this union; the runtime still enforces its selected phase.
export const ROOT_COMMAND_PHASE_ACTIONS = Object.freeze({
  'root-only-preflight': Object.freeze([
    'prepare-writer-domain', 'prepare-historical-accounting',
    'read-root-state', 'close-root-runtime',
  ]),
  'offline-qualification': Object.freeze([
    'prepare-installed-cases', 'prepare-historical-accounting',
    'materialize-offline-ui-input', 'qualify-offline',
    'freeze-offline-resource-close', 'read-offline-qualification-state',
    'read-root-state', 'close-root-runtime',
  ]),
  'live-wave': Object.freeze([
    'prepare-installed-cases', 'prepare-historical-accounting',
    'prepare-writer-domain', 'bootstrap-live-model-sockets',
    'prepare-live-readonly-cases', 'admit-and-run-live-wave',
    'read-live-wave-state', 'read-root-state', 'close-root-runtime',
  ]),
});

const actions = new Set(Object.values(ROOT_COMMAND_PHASE_ACTIONS).flat());

export function makeRootCommand(job, control, inputRecord) {
  assert.equal(job.schema, 'root-wave02-root-command-publication/v1');
  assert.equal(control.schema, 'root-wave02-root-runtime/v2');
  assert.equal(job.controlRoot, control.controlRoot);
  for (const key of ROOT_COMMAND_SCOPE_KEYS) assert.equal(job[key], control[key]);
  assert.ok(Number.isSafeInteger(job.sequence) && job.sequence >= 0 && job.sequence < 1_000_000);
  assert.ok(actions.has(job.action));
  const incoming = path.dirname(job.controlRoot) + '/incoming/' + String(job.sequence).padStart(6, '0');
  assert.equal(job.input.file, incoming + '/input.json');
  assert.equal(job.input.trustedRoot, incoming);
  assert.deepEqual([job.input.expectedUid, job.input.expectedGid], [0, 0]);
  assert.deepEqual(job.input.allowedModes, [0o444]);
  assert.deepEqual(job.input.forbiddenRoots, []);
  assert.deepEqual(job.input.forbiddenFiles, []);
  assert.equal(inputRecord.receipt.sha256, job.input.expectedSha256);
  return {
    schema: 'root-wave02-root-command/v1',
    ...Object.fromEntries(ROOT_COMMAND_SCOPE_KEYS.map(key => [key, control[key]])),
    sequence: job.sequence,
    action: job.action,
    input: job.input,
  };
}
