import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from '../controller/src/server.js';
import { Store } from '../controller/src/store.js';

const token = 'integration-token';
const node = (id, needs = [], value = id) => ({ id, kind: 'tool', needs, tool: { name: 'echo', args: { value } } });
const workflow = (id, nodes, maxConcurrency = 2) => ({ apiVersion: 'flow.dsh/v1alpha1', kind: 'Workflow', metadata: { id, revision: 1 }, spec: { limits: { maxConcurrency, maxAttempts: 2 }, nodes } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function spawnWorker(baseUrl, workerId) {
  const child = spawn(process.execPath, ['adapter/bin/worker.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, FLOW_URL: baseUrl, FLOW_TOKEN: token, WORKER_ID: workerId } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}

test('real HTTP controller and two worker CLIs execute graph and persist state', async t => {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'dsh-flow-e2e-'));
  const db = join(dir, 'flow.sqlite');
  const store = new Store(db);
  const server = createServer({ store, token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.child.exitCode === null) child.child.kill('SIGTERM');
    await Promise.all(children.map(({ child }) => child.exitCode !== null ? Promise.resolve() : once(child, 'exit')));
    await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const api = async (path, method = 'GET', body) => {
    const response = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(method === 'POST' && path === '/v1/workflows' ? { 'Idempotency-Key': 'integration-key' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  const id = `e2e-${Date.now()}`;
  await api('/v1/workflows', 'POST', workflow(id, [node('left', [], 'L'), node('right', [], 'R'), node('join', ['left', 'right'], 'done')], 2));
  children.push(spawnWorker(baseUrl, 'worker-alpha'), spawnWorker(baseUrl, 'worker-beta'));
  const deadline = Date.now() + 10000;
  let state;
  do {
    state = await api(`/v1/workflows/${id}`);
    if (state.status === 'succeeded') break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(state.status, 'succeeded');
  assert.deepEqual(state.nodes.map(n => n.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(state.nodes.map(n => n.output), ['L', 'R', 'done']);
  const events = await api(`/v1/workflows/${id}/events`);
  const claimedWorkers = new Set(events.filter(e => e.type === 'claimed').map(e => e.workerId));
  assert.deepEqual([...claimedWorkers].sort(), ['worker-alpha', 'worker-beta']);
  assert.equal(events.filter(e => e.type === 'result').length, 3);

  const persisted = new Store(db);
  assert.equal(persisted.get(id).status, 'succeeded');
  persisted.close();
  for (const item of children) item.child.kill('SIGTERM');
  await Promise.all(children.map(({ child }) => once(child, 'exit')));
});
