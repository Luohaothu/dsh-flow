import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FlowPlugin } from '../../../packages/dsh-flow/src/plugin.js';
import { resolveConfig } from '../../../packages/dsh-flow/src/config.js';
import { runtime } from '../../helpers/contract-runtime.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';

test('P6 default DSH origins obtain real tokens, while explicit origin arrays override the Web defaults', async t => {
  assert.deepEqual(resolveConfig({}).connection.allowedOrigins, ['http://127.0.0.1:3080', 'http://localhost:3080']);
  assert.deepEqual(resolveConfig({ connection: { allowedOrigins: [] } }).connection.allowedOrigins, []);
  for (const origin of ['https://example.test/path', 'file:///tmp', 'https://example.test/']) assert.throws(() => resolveConfig({ connection: { allowedOrigins: [origin] } }));
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  const plugin = await FlowPlugin.create(f.host, { stateDirectory: join(f.directory, 'defaults') });
  t.after(() => plugin.dispose());
  for (const origin of ['http://127.0.0.1:3080', 'http://localhost:3080', 'dsh-app://app', plugin.dashboardAddress]) {
    const token = await fetch(`${plugin.dashboardAddress}/api/token`, { headers: { Origin: origin } });
    assert.equal(token.status, 200); assert.equal(token.headers.get('access-control-allow-origin'), origin);
    const body = await token.json() as { token: string };
    const runs = await fetch(`${plugin.dashboardAddress}/api/runs`, { headers: { Origin: origin, Authorization: `Bearer ${body.token}` } }); assert.equal(runs.status, 200);
  }
  assert.equal((await fetch(`${plugin.dashboardAddress}/api/token`, { headers: { Origin: 'http://127.0.0.1:3081' } })).status, 403);
  await plugin.dispose();
  const explicit = await FlowPlugin.create(f.host, { stateDirectory: join(f.directory, 'explicit'), connection: { allowedOrigins: [] } });
  t.after(() => explicit.dispose());
  assert.equal((await fetch(`${explicit.dashboardAddress}/api/token`, { headers: { Origin: 'http://127.0.0.1:3080' } })).status, 403);
  assert.equal((await fetch(`${explicit.dashboardAddress}/api/token`, { headers: { Origin: 'http://localhost:3080' } })).status, 403);
  assert.equal((await fetch(`${explicit.dashboardAddress}/api/token`, { headers: { Origin: 'dsh-app://app' } })).status, 200);
});
