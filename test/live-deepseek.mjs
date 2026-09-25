// Opt-in paid smoke test. NOT included in npm test. Real DSH transport, no Agent loop.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../controller/src/store.js';
import { createServer } from '../controller/src/server.js';
import { ControllerClient, Worker } from '../adapter/src/runtime.js';

assert.equal(process.env.FLOW_LIVE_TEST, '1', 'Explicit opt-in required');
assert.ok(process.env.DEEPSEEK_API_KEY, 'Credential required');
const dshRoot = process.env.DSH_INSTALL_PATH || '/opt/dsh/app';
const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(join(dshRoot, 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')));
const { createUserMessage } = await import(pathToFileURL(join(dshRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')));
const scratch = process.env.TMPDIR;
assert.ok(scratch, 'TMPDIR required');
const dir = await mkdtemp(join(scratch, 'flow-live-'));
const database = join(dir, 'flow.sqlite');
const token = randomUUID();
let store = new Store(database);
const server = createServer({ store, token });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const client = new ControllerClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
const realFetch = globalThis.fetch;
const report = { scope: 'real HTTP controller -> worker -> installed DSH DeepSeekAdapter -> Flash -> SQLite; NOT full Agent loop', model: 'deepseek-v4-flash', maxRequests: 2, requests: 0, maxOutputTokens: 128, thinking: 'disabled', retries: 0, passed: false };
const connection = resolveAdapterOptions({
  apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 128,
  streamIdleTimeoutMs: 20000, models: [{ id: report.model, maxTokens: 128, inputModalities: ['text'] }], retryPolicy: { mode: 'normal', maxRetries: 0 },
});
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') {
    assert.equal(parsed.origin, 'https://api.deepseek.com');
    assert.equal(parsed.pathname, '/chat/completions');
    assert.ok(report.requests < report.maxRequests, 'Paid request budget exhausted');
    const body = JSON.parse(options.body);
    assert.equal(body.model, report.model);
    assert.equal(body.max_tokens, 128);
    assert.equal(body.thinking.type, 'disabled');
    assert.ok(!body.tools?.length, 'No tools allowed');
    assert.ok(JSON.stringify(body.messages).length < 2000, 'Input size budget exceeded');
    report.requests++;
    options = { ...options, redirect: 'error' };
  }
  return realFetch(url, options);
};
const adapter = new DeepSeekAdapter({ options: () => connection, resolveApiKey: async () => process.env.DEEPSEEK_API_KEY, resolveUserId: () => 'dsh-flow-budgeted-smoke', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
const workflowId = `live-${randomUUID()}`;
try {
  await client.submit({ apiVersion: 'flow.dsh/v1alpha1', kind: 'Workflow', metadata: { id: workflowId, revision: 1 }, spec: { nodes: [{ id: 'flash', kind: 'agent', needs: [], agent: { objective: 'Reply with exactly FLOW_OK and nothing else.' }, maxAttempts: 1 }], limits: { maxConcurrency: 1, maxAttempts: 1 } } }, workflowId);
  const worker = new Worker(client, async (node, signal) => {
    let text = '', usage, finish;
    for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: report.model, messages: [createUserMessage({ content: [{ type: 'text', text: node.agent.objective }], source: { kind: 'plugin', plugin: 'dsh-flow-test' } })], tools: [], maxTokens: 128, reasoningEffort: 'off', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    assert.equal(finish?.kind, 'stop');
    assert.equal(text.trim(), 'FLOW_OK');
    assert.ok(usage && usage.outputTokens <= 128);
    report.usage = usage;
    return { text: text.trim(), usage, model: report.model };
  }, { workerId: 'live-flash-worker', ttlMs: 60000 });
  assert.equal(await worker.runOnce(), true);
  const result = await client.read(workflowId);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.nodes[0].output.text, 'FLOW_OK');
  assert.ok(store.events(workflowId).some(e => e.type === 'result' && e.status === 'succeeded'));
  await new Promise(resolve => server.close(resolve));
  store.close();
  store = new Store(database);
  assert.equal(store.get(workflowId).nodes[0].output.text, 'FLOW_OK');
  report.passed = true;
  report.result = 'FLOW_OK';
  report.persistedAfterReopen = true;
} catch (error) {
  report.error = String(error.message).replaceAll(process.env.DEEPSEEK_API_KEY, '[REDACTED]');
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  if (server.listening) await new Promise(resolve => server.close(resolve));
  store.close();
  const receipt = process.env.FLOW_LIVE_REPORT || join(scratch, 'dsh-flow-live-report.json');
  await writeFile(receipt, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
