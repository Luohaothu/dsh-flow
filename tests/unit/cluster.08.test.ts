/**
 * Mechanism tests for ClusterRuntime: the management tree, transaction
 * lifecycle, role permissions, audit gates, budgets, communication, the
 * reparent safety point and cancellation.
 *
 * These drive the public Runtime API with an injected clock and no scheduler
 * tick, so every assertion is about durable behaviour rather than a model.
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { communicate } from '../../packages/dsh-flow/src/core/communication.ts';
import { reserveLlmRequest, runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { budgetView } from '../../packages/dsh-flow/src/core/budget.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';

import type { FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

// ---------------------------------------------------------------- test harness

let clock = 1_800_000_000_000;
const now = (): number => clock;

/** The fake host this suite drives the plugin with. */
import type { FakeHost } from './fake-host.ts';

/** The silent logger every directly constructed runtime gets. */
const silentLogger = { warn() {}, error() {}, info() {} };

/** The one service a hand-built context may carry. */
interface TestServices {
  readonly sessionPersistence?: FlowPersistenceSeam;
}

/**
 * A real Cordis context for a directly constructed runtime.
 *
 * Persistence is attached through the runtime seam on the root Context.
 */
function testContext(): Context {
  return new Context();
}

/**
 * A runtime with an injected clock and no scheduler tick, torn down with the test.
 */
function makeRuntime(t: TestContext, overrides: FlowRuntimeConfig = {}, services: TestServices = {}): ClusterRuntime {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-cluster-'));
  const runtime = new ClusterRuntime(testContext(), {
    logger: silentLogger,
    path: join(dir, 'cluster.sqlite'),
    dataDir: dir,
    now,
    autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off', maxTokens: 512 },
    ...overrides,
  });
  if (services.sessionPersistence !== undefined) runtime.attachPersistence(services.sessionPersistence);
  t.after(async () => {
    // Disposal drains the live turns; the directory may only go once it has.
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return runtime;
}

/**
 * Run the plugin against the fake host and hand back the runtime it provided.
 *
 * `apply` is the real entry point — the tool definitions under test are the
 * ones the host would load — and the runtime is the service it publishes.
 */
async function startFlowPlugin(host: FakeHost, config: Config): Promise<ClusterRuntime> {
  await apply(host.ctx, config);
  const runtime = host.provided.get('flow');
  assert.ok(runtime instanceof ClusterRuntime, 'apply must provide the flow runtime');
  return runtime;
}

/** Assert a required value exists, without weakening the type at the call site. */
function required<T>(value: T | null | undefined, label: string): T {
  assert.ok(value !== null && value !== undefined, `${label} is required`);
  return value;
}

/** The first item of a page the test just created. */
function firstOf<T>(items: readonly T[], label: string): T {
  return required(items[0], label);
}

/** A required string field of a JSON value. */
function textOf(value: unknown, label: string): string {
  return textField(value, label, 2 ** 31);
}

/** A required integer field of a JSON value. */
function numberOf(value: unknown, min: number, max: number, label: string): number {
  return integer(value, min, max, label);
}

/** A JSON value read as an object; every command handler answers with one. */
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  return objectField(value, label);
}

/** One command's result, already narrowed to the object the handler returned. */
interface TestCommandOutcome extends Omit<FlowCommandOutcome, 'result'> {
  readonly result: Record<string, unknown>
}

function startCluster(runtime: ClusterRuntime, overrides: Partial<FlowStartRequest> = {}): string {
  const snapshot = runtime.start({
    objective: 'test objective',
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 1000, tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
    ...overrides,
  });
  return snapshot.cluster.id;
}

function actorFor(runtime: ClusterRuntime, clusterId: string, role: FlowAgentRole, nodeId: string): FlowAgentActor {
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: nodeId, role, limit: 5 }), `agent ${role}`);
  return { cluster_id: clusterId, agent_id: agent.id, node_id: nodeId, role, session_id: agent.session_id };
}

function rootNode(runtime: ClusterRuntime, clusterId: string): NodeRecord {
  return firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
}

let counter = 0;
function command(
  runtime: ClusterRuntime,
  actor: FlowActor,
  action: string,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): TestCommandOutcome {
  counter += 1;
  const outcome = runtime.command(actor, { command_id: `cmd-${counter}`, action, params, ...extra });
  return { deduped: outcome.deduped, revision: outcome.revision, result: jsonObject(outcome.result, 'command.result') };
}

// ==== CHUNK START ====
import { fromPartial as fromPartial08 } from '@total-typescript/shoehorn';

test('a crash between taking a message and admitting it reopens it on recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a turn that dies between taking and admitting', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'agent');
  // The turn takes the message and then the process dies — no finisher runs, only
  // the restart does.
  const gate = Promise.withResolvers<void>();
  const release = (): void => gate.resolve();
  host.setScript(async () => { await gate.promise; });
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.all("SELECT status FROM inbox WHERE cluster_id=?", clusterId).some(row => row.status === 'CONSUMED')) break;
  }
  const taken = firstOf(runtime.store.all("SELECT id, status FROM inbox WHERE cluster_id=?", clusterId), 'inbox row');
  assert.equal(taken.status, 'CONSUMED', 'the live turn owns the message');
  const turnStart = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'turn-start').at(-1), 'turn-start event');
  assert.deepEqual(jsonObject(turnStart.data, 'turn-start data').inbox_ids, [taken.id], 'and the ownership is durable, by id');

  // Recovery is what the restart runs: it fences the dead turn's lease and hands
  // back the messages that turn owned and never answered.
  // A restarted process has a fresh runtime, not the old live agent handles.
  const { dataDir: restartDataDir, now: restartNow, startDefaults: restartDefaults, ...restartRest } = runtime.config;
  const restarted = new ClusterRuntime(host.ctx, {
    ...restartRest,
    ...(restartDataDir === undefined ? {} : { dataDir: restartDataDir }),
    ...(restartNow === undefined ? {} : { now: restartNow }),
    ...(restartDefaults === undefined ? {} : { startDefaults: restartDefaults }),
    path: join(dir, 'cluster.sqlite'), autoTick: false,
  });
  t.after(async () => { await restarted.dispose(); });
  restarted.recover({ deferScheduling: true });
  const after = firstOf(restarted.store.all("SELECT id, status FROM inbox WHERE id=?", textOf(taken.id, 'inbox id')), 'reopened row');
  assert.equal(after.status, 'PENDING', 'recovery hands the unproven message back');
  const reopened = restarted.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'inbox-reopened');
  assert.ok(reopened.some(event => {
    const data = jsonObject(event.data, 'inbox-reopened data');
    return numberOf(data.count, 0, 1e9, 'count') >= 1 && /restarted before the turn proved/.test(String(data.reason));
  }),
    `the reopen is recorded with its cause: ${JSON.stringify(reopened.map(event => event.data))}`);
  if (release) release();
});
test('a turn whose flush is refused hands its messages back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-flush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({ flushResult: false });
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a turn whose flush is refused', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 2 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'agent');
  host.setScript(async () => {});
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const state = firstOf(runtime.store.all("SELECT status FROM inbox WHERE cluster_id=?", clusterId), 'inbox row');
  assert.equal(state.status, 'PENDING', 'a prompt that never became durable does not answer its message');
  const reopened = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'inbox-reopened');
  assert.ok(reopened.some(event => /session was not flushed/.test(String(jsonObject(event.data, 'inbox-reopened data').reason))),
    `and the reason names the refused flush: ${JSON.stringify(reopened.map(event => jsonObject(event.data, 'inbox-reopened data').reason))}`);
});

test('disposal drains the live turns before it resolves', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-hostop-'));
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); });
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  const clusterId = runtime.start({
    objective: 'a live turn at disposal', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').id });

  const leaseCount = (): number => numberOf(required(runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId), 'lease count').c, 0, 1e9, 'lease count');
  const gate = Promise.withResolvers<void>();
  const release = (): void => gate.resolve();
  host.setScript(async () => { await gate.promise; });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (leaseCount() > 0) break;
  }
  assert.ok(leaseCount() > 0, 'a turn is live');

  // Disposal must not resolve over a runtime that is still closing out its turns:
  // by the time the returned promise settles, the leases are fenced.
  const answer = runtime.dispose();
  assert.ok(typeof answer?.then === 'function', 'disposal is asynchronous');
  // The turn's script is released while disposal drains, so the finisher can run.
  setTimeout(() => { if (release) release(); }, 30);
  await answer;
  const db = new DatabaseSync(join(dir, 'cluster.sqlite'), { readOnly: true });
  const dbCount = (sql: string): number => numberOf(jsonObject(required(db.prepare(sql).get(), 'db row'), 'db row').c, 0, 1e9, 'count');
  assert.equal(dbCount('SELECT COUNT(*) AS c FROM leases'), 0, 'and the leases are already fenced when it resolves');
  assert.equal(dbCount("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='RESERVED'"), 0, 'with no request left reserved');
  db.close();
});

test('a receipt with no resolvable payer blocks its owner instead of debiting another request', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'agent');
  const chain = runtime.budgetChainForAgent(agent, { tokens: 2_000, requests: 1 });

  // Another request legitimately holds quota in the chain this agent would fall
  // back to: that hold must not be the one an unattributable receipt consumes.
  const live = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 2_000, turn_seq: 1,
  });
  const payer = required(required(runtime.store.getUsageReceipt(live.request_id), 'receipt').budget_scope_id, 'payer');
  const before = required(runtime.store.getBudget(payer), 'budget');
  assert.equal(before.requests_reserved, 1);

  // A receipt whose recorded payer does not exist.
  runtime.store.tx(() => runtime.store.insertUsageReceipt({
    request_id: 'orphan-request', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'role', provider: 'p', model: 'm',
    status: 'RESERVED', reservation_tokens: 500, turn_seq: 1, attempt: 1,
    budget_scope_id: 'budget-that-does-not-exist',
  }));

  const reconciliation = runtime.reconcileReservations(required(runtime.store.getCluster(clusterId), 'cluster'), agent);
  assert.equal(reconciliation.uncertain, 1, `the orphan is reported as uncertain: ${JSON.stringify(reconciliation)}`);
  const after = required(runtime.store.getBudget(payer), 'budget');
  // The live receipt is reconciled against its own payer — one attempt consumed,
  // its token hold untouched. The orphan contributes nothing: the fallback chain
  // would have consumed a second request from this same scope.
  assert.equal(after.requests_spent, before.requests_spent + 1, 'exactly one attempt was consumed');
  assert.equal(after.requests_reserved, 0, 'the live reservation became a spent attempt');
  assert.equal(after.tokens_reserved, before.tokens_reserved, 'and its tokens stay held');
  assert.equal(required(runtime.store.getAgent(agent.id), 'agent').status, 'BLOCKED', 'the owner is blocked');
  assert.equal(required(runtime.store.getUsageReceipt('orphan-request'), 'receipt').status, 'RESERVED', 'and the orphan reservation is preserved');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /does not exist/.test(String(jsonObject(event.data, 'accounting-uncertain data').reason))));
  assert.ok(events.some(event => event.type === 'node-blocked' && jsonObject(event.data, 'node-blocked data').code === 'ACCOUNTING_UNCERTAIN'));
  void orchestrator;
});

test('a failed settlement leaves the receipt held and blocks its transaction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' }), 'agent');
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  const reserved = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: tx.id,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: runtime.budgetChainForAgent(agent, { tokens: 2_000, requests: 1 }),
    reservationTokens: 2_000, turn_seq: 1,
  });
  const payer = required(required(runtime.store.getUsageReceipt(reserved.request_id), 'receipt').budget_scope_id, 'payer');
  // Simulate a damaged ledger: the payer row still exists, but its request
  // hold disappeared. Settling this receipt must not consume another hold.
  runtime.store.tx(() => runtime.store.updateBudget(payer, { requests_reserved: 0 }));
  const outcome = runtime.reconcileReservations(required(runtime.store.getCluster(clusterId), 'cluster'), agent, { transactionId: tx.id });
  assert.deepEqual(outcome, { consumed: 0, uncertain: 1 });
  assert.equal(required(runtime.store.getUsageReceipt(reserved.request_id), 'receipt').status, 'RESERVED');
  assert.equal(required(runtime.store.getBudget(payer), 'budget').requests_spent, 0);
  assert.equal(required(runtime.store.getAgent(agent.id), 'agent').status, 'BLOCKED');
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'BLOCKED',
    'the Orchestrator must not publish work whose request cannot be settled');
  assert.equal(required(runtime.store.getNode(root.id), 'node').status, 'BLOCKED');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 200 }).some(event =>
    event.type === 'accounting-uncertain' && jsonObject(event.data, 'accounting-uncertain data').code === 'ACCOUNTING_UNCERTAIN'));
});

test('tool quota is reconciled once, by how far the call got — not by the effect decision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'agent');
  const scope = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const nodeBefore = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'budget')), 'node budget view');

  const seed = (callId: string, dispatchStatus: 'ADMITTED' | 'DISPATCHED' | 'SETTLED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN') => {
    runtime.store.tx(() => {
      runtime.store.updateBudget(scope.id, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 5 });
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
        turn_seq: 1, tool: 'write', args_hash: 'h', command_id: null, budget_scope_id: scope.id,
        dispatch_status: dispatchStatus, result_body: null, error: null,
      });
      runtime.store.insertEffect({
        call_id: callId, cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
        lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'write', args: {},
        status: 'EFFECT_UNCERTAIN',
      });
    });
  };
  const counters = () => ({ reserved: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_reserved, spent: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_spent });

  // 1. Admitted, never dispatched: the hold is released and the call is not charged.
  seed('call-admitted', 'ADMITTED');
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-admitted', decision: 'failed', note: 'never ran' });
  assert.deepEqual(counters(), { reserved: 4, spent: 0 }, 'an undispatched call costs nothing');

  // 2. Dispatched: the attempt is consumed once, by the human decision here.
  seed('call-dispatched', 'DISPATCHED');
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-dispatched', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), { reserved: 4, spent: 1 }, 'a dispatched call costs exactly one call');
  assert.equal(required(runtime.store.getToolCallReceipt('call-dispatched'), 'receipt').dispatch_status, 'SETTLED');
  // A second decision on the same call is refused (the effect is settled now), so
  // it cannot charge a second time.
  assert.throws(() => command(runtime, allocator, 'resolve_effect', { call_id: 'call-dispatched', decision: 'failed', note: 'again' }),
    /only an uncertain effect/);
  assert.deepEqual(counters(), { reserved: 4, spent: 1 }, 'and nothing moved');

  // 2b. `UNKNOWN` is terminal for the hold: recovery already consumed that call,
  // so a decision on it must not consume any reservation again.
  seed('call-already-unknown', 'UNKNOWN');
  const beforeUnknown = counters();
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-already-unknown', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), beforeUnknown, 'an already-reconciled call is not charged again');
  assert.equal(required(runtime.store.getToolCallReceipt('call-already-unknown'), 'receipt').dispatch_status, 'SETTLED');

  // 3. A tool with no receipt at all (a read/query) has nothing to reconcile, and
  // resolving one must not move any quota.
  runtime.store.tx(() => {
    runtime.store.insertEffect({
      call_id: 'call-read', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
      lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'read', args: {},
      status: 'EFFECT_UNCERTAIN',
    });
  });
  const beforeRead = counters();
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-read', decision: 'failed', note: 'no receipt' });
  assert.deepEqual(counters(), beforeRead, 'a call with no receipt settles nothing');

  // The node was never touched by any of it.
  assert.equal(required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'budget')), 'node budget view').tool_calls.spent, nodeBefore.tool_calls.spent);
});

test('a durably answered message is never reopened by recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-durable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a message that is really answered', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'agent');
  host.setScript(async () => {});
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.all("SELECT status FROM inbox WHERE cluster_id=?", clusterId).some(row => row.status === 'CONSUMED')) break;
  }
  const message = firstOf(runtime.store.all("SELECT id, status FROM inbox WHERE cluster_id=?", clusterId), 'inbox row');
  assert.equal(message.status, 'CONSUMED', 'the turn took it');
  // The turn ended: its prompt was admitted and flushed, so it is durable, and its
  // lease is gone.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
  assert.equal(numberOf(required(runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId), 'lease count').c, 0, 1e9, 'lease count'), 0, 'the turn finished');

  runtime.recover({ deferScheduling: true });
  assert.equal(firstOf(runtime.store.all("SELECT status FROM inbox WHERE id=?", textOf(message.id, 'inbox id')), 'inbox row').status, 'CONSUMED',
    'a durably answered message is not handed back');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'inbox-reopened').length, 0,
    'and no reopen is recorded');
});

test('an addressed message and a subscribed blackboard change each wake an idle role', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-commwake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'communication as work', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocatorAgent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'agent');
  const orchestratorAgent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'agent');
  host.setScript(async () => {});
  runtime.enableScheduling();

  const turnsFor = (role: string): number => runtime.store.readEvents(clusterId, { limit: 400 })
    .filter(event => event.type === 'turn-start' && jsonObject(event.data, 'turn-start data').role === role).length;
  const actionsFor = (role: string): string[] => runtime.store.readEvents(clusterId, { limit: 400 })
    .filter(event => event.type === 'turn-actions' && jsonObject(event.data, 'turn-actions data').role === role)
    .flatMap(event => {
      const actions = jsonObject(event.data, 'turn-actions data').actions;
      return Array.isArray(actions) ? actions.filter((item: unknown): item is string => typeof item === 'string') : [];
    });

  // A message addressed to the idle Allocator, through the communication API.
  runtime.store.tx(() => communicate(runtime.store, required(runtime.store.getCluster(clusterId), 'cluster'), {
    cluster_id: clusterId, agent_id: orchestratorAgent.id, node_id: root.id, role: 'orchestrator',
  }, 'send', { agent: allocatorAgent.id, content: 'look at the queue' }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, {
      subject: payload.kind,
      payload: {
        kind: payload.kind,
        ...(payload.message_id === undefined ? {} : { message_id: payload.message_id }),
        ...(payload.from === undefined ? {} : { from: payload.from }),
        ...(payload.key === undefined ? {} : { key: payload.key }),
      },
    }),
  }));
  const beforeMessage = turnsFor('allocator');
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (turnsFor('allocator') > beforeMessage) break;
  }
  assert.ok(turnsFor('allocator') > beforeMessage, 'a message alone wakes its recipient');
  assert.ok(actionsFor('allocator').includes('inbox'), `and it is taken as inbox work: ${JSON.stringify(actionsFor('allocator'))}`);
  const delivered = runtime.store.all("SELECT subject, status FROM inbox WHERE cluster_id=? AND subject='message'", clusterId);
  assert.equal(delivered.length, 1, 'the message notification is queued');
  assert.equal(firstOf(delivered, 'inbox row').status, 'CONSUMED', 'and consumed by the turn it woke');

  // A blackboard change the Allocator subscribes to.
  runtime.store.tx(() => communicate(runtime.store, required(runtime.store.getCluster(clusterId), 'cluster'), {
    cluster_id: clusterId, agent_id: allocatorAgent.id, node_id: root.id, role: 'allocator',
  }, 'subscribe', { prefix: 'shared/' }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, {
      subject: payload.kind,
      payload: {
        kind: payload.kind,
        ...(payload.message_id === undefined ? {} : { message_id: payload.message_id }),
        ...(payload.from === undefined ? {} : { from: payload.from }),
        ...(payload.key === undefined ? {} : { key: payload.key }),
      },
    }),
  }));
  runtime.store.tx(() => communicate(runtime.store, required(runtime.store.getCluster(clusterId), 'cluster'), {
    cluster_id: clusterId, agent_id: orchestratorAgent.id, node_id: root.id, role: 'orchestrator',
  }, 'publish', { key: 'shared/total', value: { total: 5 } }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, {
      subject: payload.kind,
      payload: {
        kind: payload.kind,
        ...(payload.message_id === undefined ? {} : { message_id: payload.message_id }),
        ...(payload.from === undefined ? {} : { from: payload.from }),
        ...(payload.key === undefined ? {} : { key: payload.key }),
      },
    }),
  }));
  const beforeBoard = turnsFor('allocator');
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (turnsFor('allocator') > beforeBoard) break;
  }
  assert.ok(turnsFor('allocator') > beforeBoard, 'a subscribed blackboard change wakes the subscriber too');
  assert.equal(firstOf(runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='blackboard'", clusterId), 'inbox row').status, 'CONSUMED');
});

test('a pre-dispatch failure never runs the tool and never costs quota', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-predispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a barrier that fails closed', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'agent');
  let executions = 0;
  host.registerTool({ name: 'read', description: 'read', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { executions += 1; return 'contents'; } });
  // `fs_read` maps to `read`, `glob` and `grep`; every one of them must resolve
  // before the role's prompt is submitted. The script only calls `read`, so the
  // others are inert — and loud if some other path ever reaches them.
  for (const name of ['glob', 'grep']) {
    host.registerTool({ name, description: 'filesystem admission fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute() { assert.fail(`${name} is not scripted in this fixture`); } });
  }
  const counters = () => {
    const scope = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
    return { reserved: scope.tool_calls_reserved, spent: scope.tool_calls_spent };
  };

  // Both gates are driven *inside a live turn*, through the host's own pipeline:
  // a call with no lease is refused by the earlier gate and would prove nothing
  // about the barrier under test.
  type FailureResult = { readonly error?: { readonly info?: { readonly code: string } } };
  const outcomes: {
    value: {
      readonly flushFailure: FailureResult;
      readonly dispatchedFailure: FailureResult;
      readonly counters: { readonly reserved: number; readonly spent: number };
    } | null;
  } = { value: null };
  host.setScript(async turn => {
    const originalFlush = host.ctx.sessions.flush;
    host.ctx.sessions.flush = async () => { throw new Error('injected flush failure'); };
    const flushFailure = await turn.callTool('read', { file_path: 'x' });
    host.ctx.sessions.flush = originalFlush;
    const previous = runtime.markToolCallDispatched;
    runtime.markToolCallDispatched = () => { throw new Error('injected dispatch-record failure'); };
    const dispatchedFailure = await turn.callTool('read', { file_path: 'y' });
    runtime.markToolCallDispatched = previous;
    outcomes.value = { flushFailure, dispatchedFailure, counters: counters() };
  });
  const before = counters();
  runtime.enableScheduling();
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', { objective: 'so the role runs', acceptance_criteria: ['x'] });
  for (let pass = 0; pass < 20 && outcomes.value === null; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.ok(outcomes.value, 'the role took a turn');
  const outcome = required(outcomes.value, 'tool outcomes');
  assert.equal(executions, 0, 'neither failure ran the tool');
  assert.equal(outcome.flushFailure.error?.info?.code, 'TOOL_CALL_UNFLUSHED', 'a thrown flush refuses before dispatch');
  assert.equal(outcome.dispatchedFailure.error?.info?.code, 'TOOL_CALL_UNDISPATCHED', 'and so does a dispatch that cannot be recorded');
  assert.equal(outcome.counters.spent, before.spent, 'neither call was charged');
  assert.equal(outcome.counters.reserved, before.reserved, 'and neither holds quota');
});

test('a completed Worker with an unattributable request is blocked, not published', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-orphan-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a worker whose accounting cannot be attributed', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx.id });

  // The Worker stages a result, and an orphan receipt (a payer that does not
  // exist) is left behind by the same turn.
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.callTool('flow_transaction', {
      action: 'submit_result', params: { transaction_id: tx.id, result: { claim: 'sum is 5' } },
    });
    const agent = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'agent');
    runtime.store.tx(() => runtime.store.insertUsageReceipt({
      request_id: 'orphan-worker-request', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
      transaction_id: tx.id, role: 'worker', kind: 'worker', provider: 'p', model: 'm',
      status: 'RESERVED', reservation_tokens: 500, turn_seq: 1, attempt: 1,
      budget_scope_id: 'budget-that-does-not-exist',
    }));
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(required(runtime.store.getTransaction(tx.id), 'transaction').status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'BLOCKED', 'the transaction is blocked, not submitted');
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.equal(events.filter(event => event.type === 'result-submitted' && jsonObject(event.data, 'result-submitted data').transaction_id === tx.id).length, 0,
    'no result is published from unattributable accounting');
  const withheld = events.filter(event => event.type === 'result-withheld' && jsonObject(event.data, 'result-withheld data').transaction_id === tx.id);
  assert.ok(withheld.some(event => jsonObject(event.data, 'result-withheld data').code === 'ACCOUNTING_UNCERTAIN'), `the turn says why: ${JSON.stringify(withheld.map(event => event.data))}`);
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /does not exist/.test(String(jsonObject(event.data, 'accounting-uncertain data').reason))));
  // The staged result is kept for the human decision, and the adapter still holds
  // its orphan reservation rather than inventing a payer for it.
  assert.equal(required(runtime.store.getUsageReceipt('orphan-worker-request'), 'receipt').status, 'RESERVED');
  assert.ok(required(runtime.store.getTransaction(tx.id), 'transaction').result !== null && required(runtime.store.getTransaction(tx.id), 'transaction').result !== undefined,
    'the staged result is preserved, not discarded');
});

test('one tool hold is moved once: recover, resolve and a late completion stay consistent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 20, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const owner = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'agent');
  const scope = required(runtime.store.budgetForScope(clusterId, 'agent', owner.id), 'agent budget').id;
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const counters = () => ({ reserved: required(runtime.store.getBudget(scope), 'budget').tool_calls_reserved, spent: required(runtime.store.getBudget(scope), 'budget').tool_calls_spent });

  runtime.store.tx(() => runtime.store.updateBudget(scope, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  const seed = (callId: string, status: 'ADMITTED' | 'DISPATCHED' | 'SETTLED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN', { hold = true }: { readonly hold?: boolean } = {}) => {
    runtime.store.tx(() => {
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: owner.id, session_id: owner.session_id,
        turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope,
        dispatch_status: status, result_body: null, error: null,
      });
      if (hold) runtime.store.updateBudget(scope, { tool_calls_reserved: required(runtime.store.getBudget(scope), 'budget').tool_calls_reserved + 1 });
    });
  };

  // One read in flight when the process died.
  seed('read-inflight', 'DISPATCHED');
  assert.deepEqual(counters(), { reserved: 1, spent: 0 });

  // Two restarts: the in-flight read is consumed exactly once.
  runtime.recover({ deferScheduling: true });
  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'exactly one call consumed, once');
  assert.equal(required(runtime.store.getToolCallReceipt('read-inflight'), 'receipt').dispatch_status, 'UNKNOWN');

  // A *new* call takes a hold of its own after the restart. Everything that
  // follows concerns the recovered call, and none of it may touch this one.
  seed('other-hold', 'ADMITTED');
  assert.deepEqual(counters(), { reserved: 1, spent: 1 });

  // A human decision on the recovered call records the outcome and moves no quota —
  // in particular it does not take the hold the other call now owns.
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'read-inflight', cluster_id: clusterId, agent_id: owner.id, node_id: owner.node_id,
    lease_epoch: 1, session_id: owner.session_id, turn_seq: 1, tool: 'read', args: {},
    status: 'EFFECT_UNCERTAIN',
  }));
  command(runtime, allocator, 'resolve_effect', { call_id: 'read-inflight', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), { reserved: 1, spent: 1 }, 'the decision charges nothing and leaves the other call\'s hold alone');
  assert.equal(required(runtime.store.getToolCallReceipt('read-inflight'), 'receipt').dispatch_status, 'SETTLED');

  // The late completion of that same call — the turn's own settlement arriving
  // after the restart — must also move nothing.
  const beforeLate = counters();
  const exec = fromPartial08<Parameters<typeof runtime.settleToolCall>[1]>({ name: 'read' });
  const lateResult = fromPartial08<NonNullable<Parameters<typeof runtime.settleToolCall>[3]>>({
    content: [{ type: 'text', text: 'late' }],
  });
  runtime.settleToolCall(owner, exec, 'read-inflight', lateResult, null, { charged: true });
  assert.deepEqual(counters(), beforeLate, 'a late completion of an already-settled call moves nothing');
  assert.equal(required(runtime.store.getToolCallReceipt('read-inflight'), 'receipt').dispatch_status, 'SETTLED', 'and it cannot rewrite the outcome');

  // The untouched hold is still exactly where it was, and is released by its own
  // transition.
  assert.equal(required(runtime.store.getToolCallReceipt('other-hold'), 'receipt').dispatch_status, 'ADMITTED');
  runtime.settleToolCall(owner, exec, 'other-hold', null, new Error('never dispatched'), { charged: false });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'releasing the other hold costs nothing');
  assert.equal(required(runtime.store.getToolCallReceipt('other-hold'), 'receipt').dispatch_status, 'CANCELLED');
});

test('a role that only queries or is refused is stagnant, and stops at the bound', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stagnant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a role that changes nothing', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 2_000_000, model_requests: 100, tool_calls: 5_000, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'agent');

  // Every turn queries state and takes no action — the shape of a guessing loop —
  // and keeps a critical notification queued so it is woken again and again.
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'allocator') return;
    await turn.callTool('flow_query', { what: 'budgets' });
    runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'worker-x' } });
  });
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'worker-1' } });
  for (let pass = 0; pass < 12; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (required(runtime.store.getNode(root.id), 'node').status === 'BLOCKED') break;
  }

  // Queried from SQL, not from a page: this run emits more events than one page.
  const allocatorEnds = runtime.store.all(
    "SELECT json_extract(data,'$.progress') AS progress FROM events WHERE cluster_id=? AND type='turn-end' AND json_extract(data,'$.role')='allocator'",
    clusterId,
  ).map(row => row.progress === 1 || row.progress === '1');
  assert.ok(allocatorEnds.length >= 1, 'the role took turns');
  assert.ok(allocatorEnds.every(flag => flag === false),
    `query-only turns are not progress: ${JSON.stringify(allocatorEnds)}`);
  // Context metering and tool charging must not count as domain progress.
  const countOf = (type: string): number => numberOf(required(runtime.store.get('SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type=?', clusterId, type), 'event count').c, 0, 1e9, 'count');
  assert.ok(countOf('llm-slot') > 0, 'the provider requests were metered');
  assert.ok(countOf('tool-call-charged') > 0, 'and the query was charged');
  // So the bound is reached and the node stops instead of looping to the budget.
  assert.equal(required(runtime.store.getNode(root.id), 'node').status, 'BLOCKED', 'the stagnation guard fires');
  const blocked = required(runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='node-blocked'", clusterId).at(-1), 'node-blocked event');
  assert.match(textOf(jsonObject(JSON.parse(textOf(blocked.data, 'event data')), 'node-blocked data').reason, 'reason'), /made no state change across \d+ turns/);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
});

test('pre-turn and in-turn compaction keep both steps inside the identity budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-anchor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The meter reports the session; each compaction halves it.
  let tokens = 30_000;
  const calls: { readonly reason: unknown; readonly at: number }[] = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: tokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(_session, reason) {
        calls.push({ reason, at: tokens });
        tokens = Math.floor(tokens / 2);
        return { summarySeq: calls.length };
      },
    },
  });
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'agent');

  // A large session first shrinks before the turn, then each step must still
  // fit the identity limit; regrowth inside the turn requires another summary.
  const decisions: string[] = [];
  host.setScript(async turn => {
    decisions.push((await turn.preStep({ step: 1 })).kind);
    tokens = 16_000;
    decisions.push((await turn.preStep({ step: 2 })).kind);
  });
  await runTurn(host.ctx, {
    agent: auditor, role: 'auditor', prompt: 'work', allowedTools: [], globalTools: [], capabilities: [],
    resume: false,
    model: runtime.config.model,
    signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
    budgetIds: runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), auditor),
    transactionId: null, turnSeq: 1, flow: runtime,
    contextLimits: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });

  assert.deepEqual(decisions, ['enter', 'enter']);
  assert.equal(tokens, 8_000, 'both steps fit the 8192-token identity budget after compaction');
  assert.equal(calls.length, 3, 'pre-turn and two in-turn compactions were required');
  const steps = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => {
    const data = jsonObject(event.data, 'context-step data');
    return [data.decision, numberOf(data.after, 0, 1e9, 'after')];
  }), [['compact', 7_500], ['compact', 8_000]]);
  assert.ok(steps.every(event => {
    const data = jsonObject(event.data, 'context-step data');
    return numberOf(data.after, 0, 1e9, 'after') + numberOf(data.pending, 0, 1e9, 'pending')
      <= numberOf(data.context_limit, 0, 1e9, 'context_limit');
  }));
});

test('a long tool result is stored as valid JSON, never as a truncation of it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-jsonbody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a receipt that stays parseable', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'agent');
  // Preserve escapes, newlines and message bodies longer than 8,000 characters.
  const long = `line "quoted" \\ backslash\n${'x'.repeat(20_000)}`;
  host.registerTool({
    name: 'read', description: 'read', parameters: {}, output: { schema: { type: 'string' }, render: () => [] },
    // The host hands a tool result back as content blocks, which is the shape the
    // receipt's text is read from.
    async execute() { return { isError: false, value: long, content: [{ type: 'text', text: long }] }; },
  });
  let threw = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator') return;
    try { await turn.callTool('read', { file_path: 'big.txt' }); } catch (error) { threw = error; }
  });
  runtime.enableScheduling();
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', { objective: 'so the role runs', acceptance_criteria: ['x'] });
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.all("SELECT call_id FROM tool_call_receipts WHERE cluster_id=?", clusterId).length) break;
  }
  assert.equal(threw, null, `the tool ran: ${String(threw)}`);
  const receipts = runtime.store.all("SELECT call_id, result_body, error FROM tool_call_receipts WHERE cluster_id=?", clusterId);
  assert.ok(receipts.length >= 1, 'a receipt was written');
  for (const receipt of receipts) {
    if (receipt.result_body === null) continue;
    const parsed: { value: Record<string, unknown> | null } = { value: null };
    assert.doesNotThrow(() => {
      parsed.value = jsonObject(JSON.parse(textOf(receipt.result_body, 'result_body')), 'receipt body');
    }, `the body must be valid JSON: ${String(receipt.result_body).slice(0, 120)}`);
    const receiptBody = required(parsed.value, 'receipt body');
    assert.equal(typeof receiptBody.text, 'string');
    const text = textOf(receiptBody.text, 'receipt text');
    assert.ok(text.length <= 8_200, `the field is bounded, not the JSON: ${text.length}`);
    assert.match(text, /chars omitted/, 'and the omission is stated');
  }

  // The same rule for the human decision's note.
  const resolved = runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'call-long', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'read', args: {},
    status: 'EFFECT_UNCERTAIN',
  }));
  // Seeded through the same reservation an admission performs: a receipt that
  // claims a hold the ledger does not show is an inconsistency, and the
  // transition now refuses to move anything for it.
  const agentScope = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  runtime.store.tx(() => {
    runtime.store.updateBudget(agentScope.id, { tool_calls_limit: agentScope.tool_calls_limit + 1 });
    runtime.store.updateBudget(agentScope.id, { tool_calls_reserved: Number(agentScope.tool_calls_reserved ?? 0) + 1 });
    runtime.store.insertToolCallReceipt({
      call_id: 'call-long', cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
      turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null,
      budget_scope_id: agentScope.id,
      dispatch_status: 'DISPATCHED', result_body: null, error: null, 
    });
  });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'resolve_effect', {
    call_id: 'call-long', decision: 'settled', note: `n".repeat(5000) ${'y'.repeat(5_000)}`,
  });
  const noteBody = required(runtime.store.getToolCallReceipt('call-long'), 'receipt').result_body;
  const noteParsed: { value: Record<string, unknown> | null } = { value: null };
  assert.doesNotThrow(() => {
    noteParsed.value = jsonObject(JSON.parse(textOf(noteBody, 'note body')), 'note body');
  }, `the note body must be valid JSON: ${String(noteBody).slice(0, 120)}`);
  const parsedNote = required(noteParsed.value, 'note body');
  assert.match(String(parsedNote.note), /chars omitted/);
  void resolved;
});

