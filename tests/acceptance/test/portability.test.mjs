import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureProfile, inheritEnv } from '../../../src/host/host.mjs';
import { browserExecutablePath } from '../../../src/host/browser.mjs';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'flow-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function packageAt(root, name = 'fixture') {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  return root;
}
const provider = '@fixture/browser-provider';
const relative = 'packages/browser/provider';

test('isolated profiles resolve provider packages from a published npm installation', t => {
  const root = scratch(t);
  const plugin = packageAt(join(root, 'plugin'));
  const target = packageAt(join(plugin, 'node_modules', provider), provider);
  const result = ensureProfile(join(root, 'home'), 'npm', {
    packagePath: plugin, installPath: join(root, 'dsh'), providers: [[provider, relative]],
  });
  assert.deepEqual(result.linked, [provider]);
  assert.equal(readlinkSync(join(result.dir, 'node_modules', provider)), target);
  assert.equal(readlinkSync(result.link), plugin);
});

test('an explicit monorepo installation keeps precedence over the plugin npm installation', t => {
  const root = scratch(t);
  const plugin = packageAt(join(root, 'plugin'));
  packageAt(join(plugin, 'node_modules', provider), provider);
  const harness = join(root, 'harness');
  const target = packageAt(join(harness, relative), provider);
  const result = ensureProfile(join(root, 'home'), 'source', {
    packagePath: plugin, installPath: join(harness, 'apps/cli'), providers: [[provider, relative]],
  });
  assert.deepEqual(result.linked, [provider]);
  assert.equal(readlinkSync(join(result.dir, 'node_modules', provider)), target);
});

test('provider resolution also checks the selected DSH installation and omits absent optional packages', t => {
  const root = scratch(t);
  const plugin = packageAt(join(root, 'plugin'));
  const dsh = packageAt(join(root, 'dsh'));
  const target = packageAt(join(dsh, 'node_modules', provider), provider);
  const result = ensureProfile(join(root, 'home'), 'installed', {
    packagePath: plugin, installPath: dsh,
    providers: [[provider, relative], ['@fixture/missing', 'packages/missing']],
  });
  assert.deepEqual(result.linked, [provider]);
  assert.equal(readlinkSync(join(result.dir, 'node_modules', provider)), target);
});

test('browser location is explicit and cannot inherit provider credentials or case overrides', () => {
  assert.deepEqual(inheritEnv({ FLOW_CHROMIUM_PATH: '/opt/chromium',
    PLAYWRIGHT_MCP_TOKEN: 'secret', FLOW_MODEL_API_KEY: 'secret', FLOW_MODEL_BASE_URL: 'remote' }),
  { FLOW_CHROMIUM_PATH: '/opt/chromium' });
});

test('browser selection rejects an invalid explicit executable instead of falling back', t => {
  const root = scratch(t);
  assert.equal(browserExecutablePath({}), undefined);
  assert.throws(() => browserExecutablePath({ FLOW_CHROMIUM_PATH: 'relative/chrome' }), /absolute/);
  assert.throws(() => browserExecutablePath({ FLOW_CHROMIUM_PATH: '' }), /absolute/);
  assert.throws(() => browserExecutablePath({ FLOW_CHROMIUM_PATH: root }), /executable file/);
  const executable = join(root, 'chromium');
  assert.throws(() => browserExecutablePath({ FLOW_CHROMIUM_PATH: executable }), /executable file/);
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o644);
  assert.throws(() => browserExecutablePath({ FLOW_CHROMIUM_PATH: executable }), /executable file/);
  chmodSync(executable, 0o755);
  assert.equal(browserExecutablePath({ FLOW_CHROMIUM_PATH: executable }), executable);
});
