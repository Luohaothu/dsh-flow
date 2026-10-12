/** Real native settings CRUD against an isolated web profile; no model request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHostEnv, createRunLayout, ensureProfile, WEB_PROFILE_BUNDLES, PROJECT_ROOT, LAUNCHER } from '../../src/host/host.ts';
import { initializeOmlxProfile, omlxProfileOptions } from '../../src/host/profile-models.ts';
const asObject = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asArray = (value: unknown): unknown[] | null => Array.isArray(value) ? value : null;

// A normal web CLI is important: its completed startup owns the editable profile.
async function startWeb(profile: string, env: Record<string, string | undefined>, cwd: string, logPath: string, patch: string) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), LAUNCHER, '--profile', profile,
    '--patch', patch, '--patch', join(PROJECT_ROOT, 'examples/cluster.web.patch.yml'), '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const collect = (chunk: string) => { output += chunk; writeFileSync(logPath, output.replace(/token=[^\s&]+/g, 'token=[redacted]')); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web profile did not become ready; inspect redacted host log')), 30_000);
      const inspect = () => { const match = /dsh web: (http:\/\/\S+)/u.exec(output); if (match?.[1]) { clearTimeout(timer); resolve(match[1]); } };
      child.stdout.on('data', inspect);
      child.once('close', () => { clearTimeout(timer); reject(new Error('Web profile exited before readiness')); });
      inspect();
    });
    const response = await fetch(url, { redirect: 'manual' });
    const cookie = response.headers.getSetCookie().map(header => header.split(';')[0]).join('; ');
    assert.ok(cookie, 'the real token bootstrap creates the native cookie');
    const origin = new URL(url).origin;
    const rpc = async (method: string, args: unknown) => {
      const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
      const envelope = asObject(await response.json());
      const result = asObject(envelope?.result);
      assert.equal(result?.ok, true, JSON.stringify(result));
      return result?.value;
    };
    return { stop, rpc };
  } catch (error) { await stop(); throw error; }
}

test('profile-owned model settings support create edit delete and cold reload without losing existing providers', { timeout: 120_000 }, async t => {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts/provider-settings-debug'), `crud-${Date.now()}`);
  const profile = 'provider-settings';
  let modelCalls = 0;
  const endpoint = createServer((_request, response) => { modelCalls++; response.writeHead(500); response.end('Unexpected model request during settings CRUD'); });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve())));
  const address = endpoint.address();
  assert.ok(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const prepared = ensureProfile(layout.home, profile, { bundles: [...WEB_PROFILE_BUNDLES, 'dsh-flow'] });
  const options = omlxProfileOptions({ FLOW_QWEN_BASE_URL: baseURL });
  const initialized = initializeOmlxProfile(prepared.dir, options);
  const initialFile = readFileSync(initialized.path, 'utf8');
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { provider: 'omlx', model: options.model, baseURL: options.baseURL }, modelApiKey: 'test-only-no-model-request' });
  delete env.FLOW_IPC;
  env.FLOW_CHROMIUM_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const patch = join(PROJECT_ROOT, 'examples/instance-runtime.patch.yml');
  let web = await startWeb(profile, env, layout.workspace, join(layout.logs, 'before.log'), patch);
  t.after(async () => web.stop());
  const describe = async () => {
    const reply = asObject(await web.rpc('settings/describe', {}));
    const result = asArray(reply?.namespaces)?.map(asObject).find(row => row?.ns === 'llm-pi-ai');
    assert.ok(result); return result;
  };
  const initial = await describe();
  const originalOmlx = asObject(asObject(initial.value)?.providers)?.omlx;
  const originalDefault = (asArray(asObject(await web.rpc('settings/describe', {}))?.namespaces) ?? []).map(asObject).find(row => row?.ns === 'agent-default-model')?.value;
  const mutate = async (ops: unknown[]) => web.rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: (await describe()).revision, ops });
  const id = 'temporary-settings-probe';
  await mutate([{ op: 'set', path: ['providers', id], value: { api: 'openai-completions', baseURL, models: [{ id: 'no-request' }] } }]);
  await mutate([{ op: 'set', path: ['providers', id, 'displayName'], value: 'Edited settings probe' }]);
  assert.ok(readFileSync(initialized.path, 'utf8').includes('Edited settings probe'));
  await web.stop();
  web = await startWeb(profile, env, layout.workspace, join(layout.logs, 'after.log'), patch);
  const restored = await describe();
  assert.equal(asObject(asObject(asObject(restored.value)?.providers)?.[id])?.displayName, 'Edited settings probe');
  assert.deepEqual(asObject(asObject(restored.value)?.providers)?.omlx, originalOmlx);
  const restoredDefault = (asArray(asObject(await web.rpc('settings/describe', {}))?.namespaces) ?? []).map(asObject).find(row => row?.ns === 'agent-default-model')?.value;
  assert.deepEqual(restoredDefault, originalDefault);
  await mutate([{ op: 'unset', path: ['providers', id] }]);
  assert.equal(asObject(asObject((await describe()).value)?.providers)?.[id], undefined);
  assert.deepEqual(asObject(asObject((await describe()).value)?.providers)?.omlx, originalOmlx);
  await web.stop();
  assert.equal(initializeOmlxProfile(prepared.dir, options).changed, false);
  assert.ok(initialFile.includes('apiKeyEnv: FLOW_MODEL_API_KEY'));
  assert.equal(readFileSync(initialized.path, 'utf8').includes('test-only-no-model-request'), false);
  assert.equal(modelCalls, 0);
  writeFileSync(join(layout.root, 'report.json'), JSON.stringify({ status: 'PASSED', operations: ['create', 'edit', 'cold-reload', 'delete'], original_provider_preserved: true, original_default_preserved: true, model_calls: modelCalls }, null, 2));
});
