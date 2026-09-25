// Controller and Harness below are explicitly TEST DOUBLES; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, deterministic, executeAgent, ControllerClient } from '../src/runtime.js';

const lease = { id: 'l1', epoch: 2, workerId: 'w', workflowId: 'wf', nodeId: 'n', node: { kind: 'tool', tool: { name: 'sum', args: { values: [2, 3] } } } };
function controller() {
  return { results: [], beats: [], claims: 0,
    async claim() { return { lease: this.claims++ === 0 ? lease : null }; },
    async heartbeat(l) { this.beats.push(l); },
    async result(l, r) { this.results.push({ l, r }); },
  };
}
test('deterministic capabilities reject arbitrary tool dispatch', () => {
  assert.equal(deterministic('sum', { values: [1, 2, 3] }), 6);
  assert.deepEqual(deterministic('echo', { value: { a: 1 } }), { a: 1 });
  assert.throws(() => deterministic('fail', {}), /requested failure/);
  assert.throws(() => deterministic('bash', { command: 'id' }), /not allowed/);
  assert.throws(() => deterministic('sum', { values: [Infinity] }), /finite/);
});
test('worker reports fenced success and failure', async () => {
  for (const fail of [false, true]) {
    const c = controller();
    const w = new Worker(c, async () => { if (fail) throw Error('test failure'); return 5; }, { workerId: 'w', ttlMs: 90 });
    await w.runOnce();
    assert.equal(c.results[0].l.epoch, 2);
    assert.equal(c.results[0].r.status, fail ? 'failed' : 'succeeded');
  }
});
test('heartbeat runs while execution is pending and drains before result', async () => {
  const c = controller();
  const w = new Worker(c, async () => { await delay(65); return 5; }, { workerId: 'w', ttlMs: 60 });
  await w.runOnce();
  assert.ok(c.beats.length >= 2);
  const count = c.beats.length; await delay(30); assert.equal(c.beats.length, count);
});
test('lost heartbeat cancels work and never submits stale result', async () => {
  const c = controller(); c.heartbeat = async () => { throw Error('lease lost'); };
  const w = new Worker(c, async (_, signal) => { await delay(2000, null, { signal }); }, { workerId: 'w', ttlMs: 30 });
  await w.runOnce();
  assert.equal(c.results.length, 0);
});
test('stop aborts active work, waits for drain, leaves lease to expire', async () => {
  const c = controller(); let drained = false;
  const w = new Worker(c, async (_, signal) => { try { await delay(2000, null, { signal }); } finally { drained = true; } }, { workerId: 'w', ttlMs: 60, pollMs: 5 });
  w.start(); await delay(15); await w.stop();
  assert.equal(drained, true); assert.equal(c.results.length, 0);
});
function harness(reason = { kind: 'completed' }, blocking = false) {
  const seen = { disposed: 0, guards: [], filters: [] }; let unblock;
  const events = [];
  const agent = { id: 'test-session', session: { snapshotEvents: () => events },
    followup(message) { seen.message = message; events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'test-double answer' }] } } }, { type: 'turn/end', data: { reason } }); },
    whenIdle() { if (!seen.message || !blocking) return Promise.resolve(); return new Promise(r => { unblock = r; }); },
    cancel(cause) { seen.cancel = cause; unblock?.(); },
  };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) }, agents: {
    async create(options) { seen.options = options; options.setup({ tools: { restrict: x => seen.filters.push(x), guard: x => seen.guards.push(x), presentAs: x => { seen.mode = x; } } }); return { agent, async dispose() { seen.disposed++; } }; },
  } };
  return { ctx, seen };
}
const api = { createUserMessage: x => x, installModelSelection() {} };
test('agent uses public factory/followup/whenIdle, bounds tools and disposes handle', async () => {
  const { ctx, seen } = harness();
  const output = await executeAgent(ctx, { agent: { objective: 'hello' } }, new AbortController().signal, api);
  assert.equal(output.text, 'test-double answer'); assert.equal(seen.disposed, 1);
  assert.deepEqual(seen.filters, [{ allow: [] }]); assert.equal(seen.mode, 'native');
  assert.ok(seen.guards[0]({ name: 'bash' }));
  assert.equal(seen.message.source.kind, 'plugin');
});
test('agent failed turn disposes; abort cancels and disposes', async () => {
  const a = harness({ kind: 'error', error: { message: 'model double failed' } });
  await assert.rejects(executeAgent(a.ctx, { agent: { objective: 'x' } }, new AbortController().signal, api), /not completed/);
  assert.equal(a.seen.disposed, 1);
  const b = harness(undefined, true); const ac = new AbortController();
  const p = executeAgent(b.ctx, { agent: { objective: 'x' } }, ac.signal, api);
  await delay(5); ac.abort(); await assert.rejects(p); assert.equal(b.seen.disposed, 1); assert.ok(b.seen.cancel);
});
test('HTTP client authenticates, encodes identifiers, suppresses controller error body', async () => {
  const calls = []; const c = new ControllerClient({ token: 'test-token', fetch: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } });
  await c.read('a/b'); assert.match(calls[0].url, /a%2Fb$/); assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  const bad = new ControllerClient({ token: 'x', fetch: async () => new Response('SECRET', { status: 403 }) });
  await assert.rejects(bad.read('id'), e => !e.message.includes('SECRET') && e.message.includes('403'));
});
