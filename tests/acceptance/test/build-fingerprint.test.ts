/** The evidence contract is checked independently of the capture manifest. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PLUGIN_ROOT, PROJECT_ROOT } from '../../../src/host/host.ts';
import { buildDrift, completeBuildHashes, computeBuildHashes, hashTree } from '../build-fingerprint.ts';
import type { BuildHashes } from '../build-fingerprint.ts';

const complete: BuildHashes = {
  plugin_source: { digest: 'sha256:plugin', files: 2 },
  lib_index: 'sha256:index',
  lib_client: 'sha256:client',
  lib_command: 'sha256:command',
  lib_web: 'sha256:web',
  typert_host: 'sha256:host',
  typert_host_types: 'sha256:host-types',
  typert_remote_client: 'sha256:remote',
  typert_remote_client_types: 'sha256:remote-types',
  host_source: { digest: 'sha256:host-source', files: 3 },
  acceptance_source: { digest: 'sha256:acceptance', files: 4 },
  case_file: 'sha256:case',
  patches: [{ path: 'cluster.patch.yml', digest: 'sha256:patch' }],
};

test('every required fingerprint field participates in completeness and drift', () => {
  assert.equal(completeBuildHashes(complete), true);
  for (const key of Object.keys(complete)) {
    const changed = structuredClone(complete);
    changed[key] = 'different';
    assert.equal(buildDrift(complete, changed), key);
    const missing = structuredClone(complete);
    delete missing[key];
    assert.equal(completeBuildHashes(missing), false, `missing ${key}`);
    assert.equal(buildDrift(complete, missing), key, `missing ${key} changes the sample`);
    missing[key] = null;
    assert.equal(completeBuildHashes(missing), false, `null ${key}`);
  }
  const changed = structuredClone(complete);
  for (const key of Object.keys(complete)) changed[key] = 'different';
  assert.equal(buildDrift(complete, changed), Object.keys(complete).join(', '), 'drift follows the evidence contract order');
  assert.equal(buildDrift(complete, { ...complete, extra_measurement: 'unrelated' }), null);
  assert.equal(completeBuildHashes(null), false);
  assert.equal(completeBuildHashes(undefined), false);
});

test('source completeness needs measured files and absent patch samples compare as empty', () => {
  for (const key of ['plugin_source', 'host_source', 'acceptance_source']) {
    for (const value of [{ digest: null, files: 1 }, { digest: 'sha256:tree', files: 0 }]) {
      assert.equal(completeBuildHashes({ ...complete, [key]: value }), false, key);
    }
  }
  const missingPatches = structuredClone(complete);
  const patchKey: string = 'patches';
  delete missingPatches[patchKey];
  assert.equal(buildDrift(missingPatches, { ...complete, patches: [] }), null);
  assert.equal(completeBuildHashes({ ...complete, patches: [] }), false);
});

test('captured artifact fields identify the specified built files, case and ordered patches', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const patch = join(root, 'fixture.patch.yml');
  const missing = join(root, 'missing.patch.yml');
  writeFileSync(patch, '- id: fixture\n');
  const captured = computeBuildHashes({ id: 'smoke' }, [patch, missing]);
  assert.deepEqual(Object.keys(captured).sort(), Object.keys(complete).sort());
  for (const [key, path] of [
    ['lib_index', 'index.js'],
    ['lib_client', 'client.js'],
    ['lib_command', 'command.js'],
    ['lib_web', 'web.js'],
    ['typert_host', 'typert.host.js'],
    ['typert_host_types', 'typert.host.d.ts'],
    ['typert_remote_client', 'typert.remote-client.js'],
    ['typert_remote_client_types', 'typert.remote-client.d.ts'],
  ] as const) {
    const artifact = join(PLUGIN_ROOT, 'lib', path);
    assert.equal(captured[key], existsSync(artifact) ? digest(readFileSync(artifact)) : null, key);
  }
  assert.equal(captured.case_file, digest(readFileSync(join(PROJECT_ROOT, 'tests/acceptance/cases/smoke.json'))));
  assert.deepEqual(captured.patches, [{ path: patch, digest: digest('- id: fixture\n') }, { path: missing, digest: null }]);
  assert.equal(computeBuildHashes({ id: '' }, []).case_file, null);
});

test('source digests preserve the relative-path and content encoding across trees', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const host = join(root, 'host');
  mkdirSync(join(source, 'nested'), { recursive: true });
  mkdirSync(host);
  writeFileSync(join(source, 'index.ts'), 'main\n');
  writeFileSync(join(source, 'nested', 'view.tsx'), 'view\n');
  writeFileSync(join(source, 'ignored.txt'), 'not TypeScript\n');
  writeFileSync(join(host, 'index.ts'), 'host\n');
  const expected = [
    `host/index.ts:${digest('host\n')}`,
    `index.ts:${digest('main\n')}`,
    `nested/view.tsx:${digest('view\n')}`,
  ].join('\n');
  assert.deepEqual(hashTree(source, [{ prefix: 'host', root: host }], path => /\.tsx?$/.test(path)), {
    digest: digest(expected), files: 3,
  });
});

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
