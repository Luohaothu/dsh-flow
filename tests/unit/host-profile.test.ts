import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHostEnv, createRunLayout, ensureProfile, inheritEnv, PLUGIN_ROOT, sanitizeLog, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';

test('each profile run owns new evidence and cannot overwrite another run or escape its root', t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layout = createRunLayout(root, 'native-work');
  assert.equal(layout.workspace, join(root, 'native-work/workspace'));
  assert.throws(() => createRunLayout(root, 'native-work'), /EEXIST/);
  for (const id of ['../escape', '/absolute', 'x/child', 'x..y', '']) assert.throws(() => createRunLayout(root, id), /Invalid run/);
  const profile = ensureProfile(layout.home, 'native', { bundles: [...WEB_PROFILE_BUNDLES, 'dsh-flow'], providers: [] });
  const manifest = JSON.parse(readFileSync(profile.manifestPath, 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, [...WEB_PROFILE_BUNDLES, 'dsh-flow']);
  assert.equal(realpathSync(profile.link), realpathSync(PLUGIN_ROOT));
});

test('isolated host credentials are explicit and inherited environment has no provider or proxy secrets', () => {
  assert.deepEqual(inheritEnv({ PATH: '/bin', SECRET_KEY: 'hidden', HTTPS_PROXY: 'hidden', FLOW_MODEL_API_KEY: 'hidden' }), { PATH: '/bin' });
  const env = buildHostEnv({ home: '/isolated', tmpdir: '/isolated/tmp', dataDir: '/isolated/data', workspace: '/isolated/workspace',
    extra: { EXPLICIT_PROVIDER_KEY: 'selected', HOME: '/wrong' } });
  assert.equal(env.HOME, '/isolated');
  assert.equal(env.EXPLICIT_PROVIDER_KEY, 'selected');
  assert.equal(env.FLOW_IPC, undefined, 'normal host execution does not load an alternate Flow test driver');
  assert.equal(sanitizeLog('http://127.0.0.1:18791/?token=secret and Bearer credential'), 'http://127.0.0.1:18791/?token=[redacted] and Bearer [redacted]');
});
