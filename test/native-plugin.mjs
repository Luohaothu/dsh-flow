// Explicit installed-runtime integration check; no model requests.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../controller/src/store.js';
import { createServer } from '../controller/src/server.js';
const root = process.env.DSH_INSTALL_PATH || '/opt/dsh/app';
const mod = name => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await mod('cordis');
const { default: Prompt } = await mod('dsh-system-prompt');
const { default: Tools } = await mod('dsh-tools');
const plugin = await import('../adapter/src/index.js');
const token = randomUUID();
const store = new Store(':memory:');
const server = createServer({ store, token });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const prior = { url: process.env.FLOW_URL, token: process.env.FLOW_TOKEN, enabled: process.env.FLOW_WORKER_ENABLED };
process.env.FLOW_URL = `http://127.0.0.1:${server.address().port}`;
process.env.FLOW_TOKEN = token;
process.env.FLOW_WORKER_ENABLED = '0';
const ctx = new Context();
try {
  ctx.plugin(Prompt);
  ctx.plugin(Tools, { mode: 'native', maxParallelSubCalls: 1 });
  ctx.plugin(plugin);
  await new Promise(setImmediate);
  assert.ok(ctx.flow);
  assert.ok(ctx.tools.get('flow_submit'));
  assert.ok(ctx.tools.get('flow_read'));
  const workflow = { apiVersion: 'flow.dsh/v1alpha1', kind: 'Workflow', metadata: { id: 'native-plugin-check', revision: 1 }, spec: { nodes: [{ id: 'echo', kind: 'tool', needs: [], tool: { name: 'echo', args: { value: 'NATIVE_OK' } } }], limits: { maxConcurrency: 1, maxAttempts: 1 } } };
  const execute = (name, args) => ctx.tools.execute({ name, arguments: args, callId: randomUUID(), signal: new AbortController().signal });
  const submitted = await execute('flow_submit', { workflow_json: JSON.stringify(workflow), idempotency_key: workflow.metadata.id });
  assert.ok(!submitted.isError, JSON.stringify(submitted));
  assert.equal(store.get(workflow.metadata.id).status, 'running');
  const read = await execute('flow_read', { id: workflow.metadata.id });
  assert.ok(!read.isError, JSON.stringify(read));
  assert.ok(JSON.stringify(read).includes('native-plugin-check'));
  const worker = new plugin.Worker(ctx.flow.client, node => plugin.deterministic(node.tool.name, node.tool.args), { workerId: 'native-plugin-worker' });
  assert.equal(await worker.runOnce(), true);
  assert.equal(store.get(workflow.metadata.id).nodes[0].output, 'NATIVE_OK');
  assert.equal(store.get(workflow.metadata.id).status, 'succeeded');
  const invalid = await execute('flow_submit', { workflow_json: '{}', idempotency_key: 'invalid' });
  assert.equal(invalid.isError, true);
  console.log('PASS: real Cordis + DSH ToolRuntime + flow plugin + HTTP controller + worker; tools validated and outputs persisted. No model calls.');
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close();
  for (const [key, value] of [['FLOW_URL', prior.url], ['FLOW_TOKEN', prior.token], ['FLOW_WORKER_ENABLED', prior.enabled]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
