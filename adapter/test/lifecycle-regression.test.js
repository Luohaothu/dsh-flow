import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { apply, handleHostOp } from '../src/index.js';
import { ClusterRuntime } from '../src/cluster.js';
import { reserveLlmRequest, runTurn } from '../src/runtime.js';
import { createFakeHost } from './fake-host.mjs';

function mountRuntime(t, { ready = true, limits = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-lifecycle-'));
  const host = createFakeHost();
  const get = host.ctx.get.bind(host.ctx);
  let onReady;
  host.ctx.get = name => {
    if (name === 'agentLoop') return ready ? {} : undefined;
    if (name === 'agents') return ready ? host.ctx.agents : undefined;
    if (name === 'appReady') return { onReady(callback) { onReady = callback; } };
    return get(name);
  };
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 60_000,
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'Exercise the mounted runtime scheduling lifecycle',
    workspace: dir, capabilities: [],
    limits: { max_active_agents: 1, max_llm_concurrency: 1, ...limits },
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, agents: 16, max_active_agents: limits.max_active_agents ?? 1 },
  }).cluster.id;
  return {
    host, runtime, clusterId,
    makeReady() {
      ready = true;
      assert.equal(typeof onReady, 'function', 'the runtime subscribed to host readiness');
      onReady();
    },
  };
}

test('plugin recovery opens scheduling when the host is already ready', async t => {
  const { host, runtime } = mountRuntime(t);
  await setImmediate();
  assert.equal(runtime.schedulingEnabled(), true,
    'recovery completion must open the barrier even when host readiness preceded it');
  await runtime.tick();
  await setImmediate();
  assert.ok(host.turns.length > 0, 'the mounted runtime admits a turn without manually enabling scheduling');
});

test('plugin recovery waits for host readiness before admitting turns', async t => {
  const { host, runtime, makeReady } = mountRuntime(t, { ready: false });
  await setImmediate();
  assert.equal(runtime.schedulingEnabled(), false);
  await runtime.tick();
  assert.equal(host.turns.length, 0);

  makeReady();
  assert.equal(runtime.schedulingEnabled(), true);
  await runtime.tick();
  await setImmediate();
  assert.ok(host.turns.length > 0);
});

test('deferred recovery closes an already-open scheduling gate until proofs finish', async t => {
  const { host, runtime } = mountRuntime(t);
  await setImmediate();
  assert.equal(runtime.schedulingEnabled(), true);

  for (let pass = 0; pass < 2; pass += 1) {
    runtime.recover({ deferScheduling: true });
    assert.equal(runtime.schedulingEnabled(), false, 'each deferred recovery closes admission before it fences leases');
    await runtime.tick();
    await setImmediate();
    assert.equal(host.turns.length, 0, 'no driver may admit work while session proofs are pending');
  }

  runtime.resumeScheduling();
  assert.equal(runtime.schedulingEnabled(), true);
  await runtime.tick();
  await setImmediate();
  assert.ok(host.turns.length > 0, 'explicit proof completion resumes the ready host');
});

test('an older host-readiness callback cannot reopen a newer recovery barrier', async t => {
  const { runtime, makeReady } = mountRuntime(t, { ready: false });
  await setImmediate();
  runtime.recover({ deferScheduling: true });
  makeReady();
  assert.equal(runtime.schedulingEnabled(), false, 'readiness from the previous recovery is stale');
  runtime.resumeScheduling();
  assert.equal(runtime.schedulingEnabled(), true, 'current proof completion may open the gate');
});

test('recovery rejects an active scheduling pass without changing persisted state or its gate', async t => {
  const { runtime, clusterId } = mountRuntime(t);
  await setImmediate();
  runtime.control(clusterId, 'pause');
  const ticking = runtime.tick();
  const before = runtime.read(clusterId);
  assert.equal(runtime.inFlight(clusterId), 0, 'only the scheduling pass is still active');
  assert.throws(() => runtime.recover({ deferScheduling: true }), error => error.status === 409 && /pause.*drain.*recover/i.test(error.message));
  assert.deepEqual(runtime.read(clusterId), before, 'a rejected recovery performs no durable writes');
  assert.equal(runtime.schedulingEnabled(), true, 'a rejected request does not change admission');
  await ticking;
  runtime.recover({ deferScheduling: true });
  assert.equal(runtime.schedulingEnabled(), false);
});

test('a paused cluster can drain its live turn before recovery proceeds', async t => {
  const { runtime, host, clusterId } = mountRuntime(t);
  await setImmediate();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  host.setScript(async () => { await held; });
  await runtime.tick();
  await setImmediate();
  assert.ok(runtime.inFlight(clusterId) > 0);
  runtime.control(clusterId, 'pause');
  const before = runtime.read(clusterId);
  assert.throws(() => runtime.recover({ deferScheduling: true }), error => error.status === 409);
  assert.deepEqual(runtime.read(clusterId), before);
  release();
  await setImmediate();
  assert.equal(runtime.inFlight(clusterId), 0, 'pause permits the current native turn to finish');
  const turns = host.turns.length;
  await runtime.tick();
  assert.equal(host.turns.length, turns, 'pause prevents replacement turns');
  runtime.recover({ deferScheduling: true });
  assert.equal(runtime.schedulingEnabled(), false);
  assert.equal(runtime.store.getCluster(clusterId).status, 'PAUSED');
  runtime.resumeScheduling();
  await runtime.tick();
  assert.equal(host.turns.length, turns, 'proof completion does not implicitly resume a paused cluster');
});

test('overlapping IPC recovery requests share one proof lifecycle and cannot open its gate early', async t => {
  const { runtime } = mountRuntime(t);
  await setImmediate();
  let release;
  const proof = new Promise(resolve => { release = resolve; });
  let proofs = 0;
  runtime.proveSessions = async () => { proofs += 1; await proof; return []; };
  const first = handleHostOp(runtime, { op: 'recover' });
  const second = handleHostOp(runtime, { op: 'recover' });
  assert.equal(proofs, 1, 'concurrent callers must not create independent proof passes');
  assert.equal(runtime.schedulingEnabled(), false);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, 'both callers receive the result of the same recovery');
  assert.equal(runtime.schedulingEnabled(), true);
});

for (const outcome of ['succeeds', 'fails']) {
  test(`startup and IPC share recovery when the session-proof pass ${outcome}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-startup-proof-'));
    const seed = new ClusterRuntime({}, { path: join(dir, 'cluster.sqlite'), autoTick: false });
    seed.store.createCluster({ id: 'recover-me', objective: 'Recover persisted work', workspace: dir, capabilities: [], limits: {} }, {});
    await seed.dispose();
    const proof = Promise.withResolvers();
    let calls = 0;
    const original = ClusterRuntime.prototype.proveSessions;
    const probe = t.mock.method(ClusterRuntime.prototype, 'proveSessions', async () => {
      calls += 1;
      await proof.promise;
      return [];
    });
    const host = createFakeHost();
    const get = host.ctx.get.bind(host.ctx);
    host.ctx.get = name => ['agentLoop', 'agents'].includes(name) ? {} : get(name);
    const runtime = apply(host.ctx, { dataDir: dir, tickMs: 60_000 });
    t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
    const ipc = handleHostOp(runtime, { op: 'recover' });
    assert.equal(calls, 1, 'the IPC request joins startup instead of starting another proof pass');
    assert.equal(runtime.schedulingEnabled(), false);
    if (outcome === 'succeeds') {
      proof.resolve();
      assert.equal((await ipc).recovered.length, 1);
      assert.equal(runtime.schedulingEnabled(), true);
    } else {
      proof.reject(new Error('unexpected proof failure'));
      await assert.rejects(ipc, /unexpected proof failure/);
      await setImmediate();
      assert.equal(runtime.schedulingEnabled(), false, 'startup must not reopen admission after a failed proof');
      probe.mock.restore();
      assert.equal(ClusterRuntime.prototype.proveSessions, original);
      await handleHostOp(runtime, { op: 'recover' });
      assert.equal(runtime.schedulingEnabled(), true, 'a successful explicit retry can finish recovery');
    }
  });
}

test('proof completion cannot reopen a gate belonging to a newer recovery generation', async t => {
  const { runtime } = mountRuntime(t);
  await setImmediate();
  const proof = Promise.withResolvers();
  runtime.proveSessions = async () => { await proof.promise; return []; };
  const previous = runtime.recoverAndReconcile();
  runtime.recover({ deferScheduling: true });
  proof.resolve();
  await previous;
  assert.equal(runtime.schedulingEnabled(), false);
  runtime.resumeScheduling();
  assert.equal(runtime.schedulingEnabled(), true);
});

for (const proof of ['found', 'absent', 'unreadable', 'unavailable']) {
  test(`recovery preserves attempted delivery until its session proof is ${proof}`, async t => {
    const { runtime, clusterId } = mountRuntime(t, { ready: false });
    await setImmediate();
    const agent = runtime.store.listAgents(clusterId, { role: 'auditor' })[0];
    const messageId = `recovery-${proof}`;
    runtime.store.tx(() => {
      runtime.store.insertMessage({ id: messageId, cluster_id: clusterId, kind: 'direct', content: 'Please inspect this' });
      runtime.store.insertRecipient(messageId, agent.id);
      runtime.store.markDeliveryInjected(messageId, agent.id);
    });
    if (proof !== 'unavailable') runtime.attachPersistence({
      async stat() { return { id: agent.session_id }; },
      async open() {
        if (proof === 'unreadable') throw new Error('session temporarily unreadable');
        return {
          async read() {
            return { events: proof === 'found'
              ? [{ type: 'user/message', data: { text: `[[flow-delivery ${messageId} seq 1]]` } }]
              : [] };
          },
          async close() {},
        };
      },
    });

    runtime.recover({ deferScheduling: true });
    assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'DELIVERED',
      'recovery must retain the durable evidence that injection was attempted');
    const result = await runtime.reconcileDeliveries(clusterId);
    if (proof === 'found') {
      assert.equal(result.acknowledged, 1);
      assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'ACKED');
    } else if (proof === 'absent') {
      assert.equal(result.requeued, 1);
      assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'PENDING');
      assert.deepEqual((await runtime.collectDeliveries(agent)).ids, [messageId]);
    } else {
      assert.equal(runtime.store.getAgent(agent.id).status, 'BLOCKED');
      assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'DELIVERED');
      assert.deepEqual((await runtime.collectDeliveries(agent)).ids, [], 'an unproven injection cannot be repeated');
      runtime.recover({ deferScheduling: true });
      assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'DELIVERED',
        'a second recovery must preserve the same ambiguity');
    }
  });
}

test('disposal terminates recorded jobs across every page of open clusters', async t => {
  const stopped = [];
  const runtime = new ClusterRuntime({
    get: name => name === 'jobs' ? { kill(jobId) { stopped.push(jobId); } } : undefined,
  }, { path: ':memory:', autoTick: false });
  let disposed = false;
  t.after(async () => { if (!disposed) await runtime.dispose(); });
  runtime.store.tx(() => {
    for (let index = 0; index < 201; index += 1) {
      const id = `cluster-${String(index).padStart(3, '0')}`;
      runtime.store.createCluster({ id, objective: id, workspace: '/tmp', capabilities: [], limits: {} }, {});
      runtime.store.insertNode({ id: `node-${id}`, cluster_id: id, kind: 'worker', depth: 0, status: 'ACTIVE', path: '0' });
      runtime.store.insertAgent({ id: `agent-${id}`, cluster_id: id, node_id: `node-${id}`, role: 'worker', session_id: `session-${id}`, status: 'READY' });
      runtime.store.insertEffect({ call_id: `call-${id}`, cluster_id: id, agent_id: `agent-${id}`, lease_epoch: 1, tool: 'bash', status: 'SETTLED', job_id: `job-${id}` });
    }
  });

  await runtime.dispose();
  disposed = true;
  assert.equal(stopped.length, 201, 'shutdown must visit clusters beyond both the old 50-row limit and the 200-row page');
  assert.equal(new Set(stopped).size, 201, 'each recorded job is terminated once');
});

test('concurrent and repeated disposal share completion and close the store once', async () => {
  const runtime = new ClusterRuntime({}, { path: ':memory:', autoTick: false });
  const close = runtime.store.close.bind(runtime.store);
  let closed = 0;
  runtime.store.close = () => { closed += 1; close(); };
  const first = runtime.dispose();
  const second = runtime.dispose();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'fulfilled'), 'each caller waits for the same successful teardown');
  assert.equal(first, second, 'concurrent callers share the in-progress disposal');
  await runtime.dispose();
  assert.equal(closed, 1);
});

test('disposal wakes callers already waiting for a scheduling event', async () => {
  const runtime = new ClusterRuntime({}, { path: ':memory:', autoTick: false });
  let woke = false;
  void runtime.waitForWake().then(() => { woke = true; });
  await runtime.dispose();
  await setImmediate();
  assert.equal(woke, true, 'a pending wake cannot be stranded when scheduling stops permanently');
});

test('disposal settles stranded request attempts even when no turn is registered', async t => {
  const { runtime, clusterId } = mountRuntime(t, { ready: false });
  await setImmediate();
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  const budgetIds = runtime.budgetChainForAgent(agent, { tokens: 1000, requests: 1 });
  const receipt = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    role: agent.role, kind: 'role', provider: 'local-fake', model: 'fake-model',
    budgetIds, reservationTokens: 1000, turn_seq: 1,
  });
  assert.equal(runtime.inFlight(clusterId), 0);
  const close = runtime.store.close.bind(runtime.store);
  let final;
  runtime.store.close = () => {
    final = { budget: runtime.store.getBudget(budgetIds[0]), receipt: runtime.store.getUsageReceipt(receipt.request_id) };
    close();
  };
  await runtime.dispose();
  assert.equal(final.receipt.status, 'UNKNOWN');
  assert.equal(final.budget.requests_reserved, 0);
  assert.equal(final.budget.requests_spent, 1);
  assert.equal(final.budget.tokens_reserved, 1000, 'unknown token cost remains held');
});

for (const phase of ['before-start', 'session-probe', 'agent-create', 'compaction']) {
  test(`cancellation during ${phase} never admits a new native turn`, async () => {
    const ac = new AbortController();
    const reason = new Error(`cancelled during ${phase}`);
    const abort = () => ac.abort(reason);
    const host = createFakeHost(phase === 'compaction' ? {
      tokenMeter: { measure: () => ({ totalTokens: 10_000, logRevision: 1 }) },
      compaction: { async compactIfNeeded() { abort(); return null; } },
    } : {});
    const create = host.ctx.agents.create.bind(host.ctx.agents);
    let disposed = 0;
    host.ctx.agents.create = async options => {
      const handle = await create(options);
      if (phase === 'agent-create') abort();
      return { ...handle, async dispose() { disposed += 1; await handle.dispose(); } };
    };
    let admitted = 0;
    if (phase === 'before-start') abort();
    await assert.rejects(runTurn(host.ctx, {
      agent: { id: 'agent', session_id: 'session', cluster_id: 'cluster', role: 'worker' },
      role: 'worker', prompt: 'Do not run after cancellation',
      allowedTools: [], globalTools: [], capabilities: [],
      model: { provider: 'local-fake', model: 'fake-model', maxTokens: 512 },
      modelAccounting: false, signal: ac.signal,
      flow: { async sessionExists() { if (phase === 'session-probe') abort(); return false; } },
      onAdmitted() { admitted += 1; },
    }), /cancelled during/);
    assert.equal(admitted, 0);
    assert.ok(host.turns.every(turn => !turn.admitted), 'cancel must not be followed by a fresh wake');
    assert.equal(host.turns.length, ['agent-create', 'compaction'].includes(phase) ? 1 : 0);
    assert.equal(disposed, host.turns.length, 'any acquired handle is released');
    assert.equal(host.sessionEventListeners.length, 0, 'turn listeners are released on every abort path');
  });
}

test('cancelling a cluster aborts its allocated Worker after marking the identity terminal', async t => {
  const { runtime, host, clusterId } = mountRuntime(t, {
    ready: false, limits: { max_active_agents: 3, max_llm_concurrency: 2 },
  });
  await setImmediate();
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const command = (role, action, params) => {
    const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role })[0];
    return runtime.command({ cluster_id: clusterId, node_id: root.id, agent_id: agent.id, role }, {
      command_id: `cancel-test-${action}`, action, params,
    });
  };
  command('orchestrator', 'dispatch', { transaction_id: tx.id });
  command('auditor', 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command('allocator', 'allocate_agent', { transaction_id: tx.id });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id).role === 'worker') await held;
  });
  runtime.enableScheduling();
  let worker;
  for (let pass = 0; pass < 20 && !worker; pass += 1) {
    await runtime.tick();
    await setImmediate();
    worker = host.turns.find(turn => runtime.store.getAgentBySession(turn.session.id).role === 'worker' && turn.admitted);
  }
  assert.ok(worker, 'a real allocated Worker is running');
  runtime.control(clusterId, 'cancel');
  await setImmediate();
  assert.equal(runtime.store.getAgentBySession(worker.session.id).status, 'TERMINATED');
  assert.equal(worker.cancelled, true, 'the persisted terminal state must not suppress native cancellation');
  assert.equal(runtime.inFlight(clusterId), 0, 'cancelled work drains instead of holding a live turn');
});
