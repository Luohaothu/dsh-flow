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

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { reserveLlmRequest, runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import type { TurnOutcome } from '../../packages/dsh-flow/src/core/runtime.ts';
import { budgetView, createBudget, dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';

import { correctionWitness } from '../acceptance/checks/recursion.ts';
import type { AgentRecord, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
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
 * `ClusterRuntime` takes a `Context`, so a plain object no longer matches: the
 * context is the real root context; persistence is attached through the runtime seam.
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

function scoreFinalHealth(runtime: ClusterRuntime, clusterId: string, nodeId: string): string {
  const auditor = actorFor(runtime, clusterId, 'auditor', nodeId);
  const dimensions = Object.fromEntries(runtime.healthMetricNames().map(metric => [metric, 0.5]));
  const outcome = command(runtime, auditor, 'evaluate_health', {
    dimensions, evaluation_window: 'subtree-close',
  });
  return textOf(outcome.result.health_id, 'health_id');
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
test('a context refusal in a spent cluster is reported as a budget stop, not a context pathology', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const agent = firstOf(runtime.store.listAgents(clusterId, { role: 'orchestrator' }), 'orchestrator agent');
  // `contextRefusal` reads only the stop reason and its rejection detail, so the
  // rest of the turn outcome is filled from its own zero shape.
  const blockedTurn = (rejection: Record<string, unknown>): TurnOutcome => ({
    native_seq: null,
    stopDetail: { kind: 'blocked', info: { rejection } },
    missing_capability_tools: [], admitted: false, context: null,
    context_pressure: false, context_over_budget: false, context_blocked: false, context_code: null,
    context_overflowed: false, events: [], assistant: [], usage: [], toolCalls: [],
    stopReason: 'blocked', completed: false, finalText: '',
  });
  const blocked = blockedTurn({ before: 124_579, pending: 2_167, sending: 128_675, ceiling: 126_976, limit: 8_192 });
  // The cluster still has money: the refusal is the context pathology it looks
  // like, and it is reported as one.
  assert.deepEqual(
    { code: runtime.contextRefusal(blocked, null, agent)?.code, plain: /^the step could not be sent/.test(String(runtime.contextRefusal(blocked, null, agent)?.message)) },
    { code: 'CONTEXT_PRESSURE', plain: true });
  // The cluster has spent everything: the same refusal is a budget stop, and the
  // report says so instead of blaming the context.
  runtime.store.tx(() => {
    for (const row of runtime.store.listBudgets(clusterId)) {
      if (row.tokens_limit <= 0) continue;
      runtime.store.updateBudget(row.id, { tokens_spent: Math.max(row.tokens_spent, row.tokens_limit - row.tokens_reserved) });
    }
  });
  const spent = required(runtime.contextRefusal(blocked, null, agent), 'spent refusal');
  assert.equal(spent.code, 'BUDGET_EXHAUSTED');
  assert.match(spent.message, /^BUDGET:/);
  // The unshrunk session that never got its summary names compaction itself.
  const unfunded = blockedTurn({ before: 100, pending: 10, compaction_unfunded: true });
  const shrunk = required(runtime.contextRefusal(unfunded, null, agent), 'unfunded refusal');
  assert.equal(shrunk.code, 'BUDGET_EXHAUSTED');
  assert.match(shrunk.message, /^BUDGET: the session could not be compacted/);
  // Missing the agent must not throw: the refusal still names the ceiling.
  assert.match(required(runtime.contextRefusal(blocked, null), 'agentless refusal').message, /^the step could not be sent/);
});

test('a coded block is persisted with its code, at the node and at the cluster', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  runtime.store.tx(() => runtime.store.insertNode({
    id: 'child-node-1', cluster_id: clusterId, parent_id: root.id, kind: 'management',
    depth: 1, status: 'ACTIVE',
    path: `${root.path}/child-node-1`,
  }));
  const child = required(runtime.store.getNode('child-node-1'), 'child node');
  runtime.blockNodeInternal(clusterId, child.id, 'BUDGET: the child could not pay for its next request', 'BUDGET_EXHAUSTED');
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  const nodeBlocked = required(events.filter(event => event.type === 'node-blocked').at(-1), 'node-blocked event');
  assert.equal(jsonObject(nodeBlocked.data, 'node-blocked data').code, 'BUDGET_EXHAUSTED');
  // A non-root block stops the node and tells its parent; the code is on the
  // event either way, which is what the ledger reads.
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: the cluster could not pay for its next request', 'BUDGET_EXHAUSTED');
  const clusterBlocked = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1), 'cluster-blocked event');
  assert.equal(jsonObject(clusterBlocked.data, 'cluster-blocked data').code, 'BUDGET_EXHAUSTED');
  assert.match(String(jsonObject(clusterBlocked.data, 'cluster-blocked data').reason), /^BUDGET:/);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
});

test('a root budget stop waits for funded delegated work to return capacity, then stops if still dry', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'complete funded delegated work' },
  }).result;
  const childNodeId = textOf(child.node_id, 'child node id');
  const childDelegatedTxId = textOf(child.delegated_transaction_id, 'delegated transaction id');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: root needs more tokens',
    'BUDGET_EXHAUSTED', {
      agent_id: allocator.agent_id,
      envelope: { tokens: 2_000_000, model_requests: 1, tool_calls: 0 },
    });
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING',
    'the still-funded child can finish independently and return its unspent grant');
  assert.equal(required(runtime.store.getNode(childNodeId), 'child node').status, 'ACTIVE');

  runtime.store.tx(() => runtime.store.updateTransaction(childDelegatedTxId, {
    status: 'ACCEPTED', __bump_revision: false,
  }));
  runtime.evaluateCompletion(clusterId);
  scoreFinalHealth(runtime, clusterId, childNodeId);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getNode(childNodeId), 'child node').status, 'COMPLETED');
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED',
    'an impossible envelope still stops the cluster after independent work is done');
  const stop = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1), 'cluster-blocked event');
  assert.equal(jsonObject(stop.data, 'cluster-blocked data').code, 'BUDGET_EXHAUSTED');
});



test('a blocked cluster cannot admit fresh turns from still-active child nodes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-blocked-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    maxTokens: 512, tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'do not schedule past an unresolved root budget stop',
    workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 2, max_llm_concurrency: 1 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 2 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'pending child task' },
  }).result;
  assert.equal(required(runtime.store.getNode(textOf(child.node_id, 'child node id')), 'child node').status, 'ACTIVE');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: root cannot fund a 2m-token request',
    'BUDGET_EXHAUSTED', {
      agent_id: allocator.agent_id,
      envelope: { tokens: 2_000_000, model_requests: 1, tool_calls: 0 },
    });
  // An explicit cluster stop is terminal even if the root's own budget stop
  // would otherwise wait for this independently funded child.
  runtime.blockClusterInternal(clusterId, 'BUDGET: no more delegated work', 'BUDGET_EXHAUSTED');
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 100 })
    .filter(event => event.type === 'turn-start').length, 0,
  'unresolved root budget stop forbids admitting child management turns');
  assert.equal(host.turns.length, 0);
});

test('a step refused in a cluster that has spent its budget stops with the budget code', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stepbudget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The session only crosses the provider ceiling during the Worker's turn: the
  // roles measure small, so the blockage under test is the Worker's step.
  let overCeiling = false;
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: overCeiling ? 131_000 : 500, logRevision: 1 }) },
    compaction: { async compactNow() { return null; }, async compactIfNeeded() { return null; } },
  });
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_model_requests: 2, worker_max_tokens: 512 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'root transaction').status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });

  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    // The session is over the ceiling *and* the cluster has spent everything it
    // was given, so the compaction that would have made the request sendable
    // could not have been paid for. The durable event must name the budget, not
    // the context pressure that made it visible.
    overCeiling = true;
    runtime.store.tx(() => {
      for (const row of runtime.store.listBudgets(clusterId)) {
        if (row.tokens_limit <= 0) continue;
        runtime.store.updateBudget(row.id, { tokens_spent: Math.max(row.tokens_spent, row.tokens_limit - row.tokens_reserved) });
      }
    });
    const decision = await turn.preStep({ step: 1 });
    if (decision.kind === 'enter') await turn.request({ purpose: 'worker' });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(required(runtime.store.getTransaction(tx.id), 'root transaction').status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  assert.equal(workerTurn?.blocked, true, 'the step was rejected');
  assert.equal(workerTurn.requests.length, 0, 'no request was sent');
  const steps = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  assert.equal(jsonObject(required(steps.at(-1), 'context-step event').data, 'context-step data').decision, 'reject', 'the step gate made the decision');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  const clusterBlocked = required(blocked.at(-1), 'cluster-blocked event');
  assert.equal(jsonObject(clusterBlocked.data, 'cluster-blocked data').code, 'BUDGET_EXHAUSTED', 'the stop is coded as a budget stop');
  assert.match(String(jsonObject(clusterBlocked.data, 'cluster-blocked data').reason), /^BUDGET:/);
  // And the same fact, at the node that was refused.
  const nodeBlocked = required(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'node-blocked').at(-1), 'node-blocked event');
  assert.equal(jsonObject(nodeBlocked.data, 'node-blocked data').code, 'BUDGET_EXHAUSTED');
});

test('a node waits for its own roles to finish before it closes, and books their turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-close-'));
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
    objective: 'one transaction, accepted while a role is still working', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 4 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const actor = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actor('orchestrator'), 'dispatch', { transaction_id: tx.id });

  // The cluster's work is finished *inside a role's turn*: the node must not close
  // under it. Its own roles' closing acts belong to those turns, and a node that
  // closed early either aborted them or lost their accounting.
  const observed: Array<{ node: string; cluster: string }> = [];
  host.setScript(async turn => {
    const role = runtime.store.getAgentBySession(turn.session.id)?.role;
    if (role === 'orchestrator') {
      if (runtime.pendingFor('orchestrator', root, required(runtime.store.getCluster(clusterId), 'cluster'))
        .some(item => item.action === 'finish_cluster')) {
        command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'finish_cluster', {});
      }
      return;
    }
    if (role !== 'auditor') return;
    // The old call handed `pendingFor` a `FlowAgentActor`, which has no `id`, so
    // it always fell back to the role's own agent; `null` asks for that same
    // resolution explicitly.
    const pending = runtime.pendingFor('auditor', required(runtime.store.getNode(root.id), 'root node'), required(runtime.store.getCluster(clusterId), 'cluster'));
    if (pending.some(item => item.action === 'evaluate_health' && 'evaluation_window' in item && item.evaluation_window === 'subtree-close')) {
      scoreFinalHealth(runtime, clusterId, root.id);
      observed.push({ node: required(runtime.store.getNode(root.id), 'root node').status, cluster: required(runtime.store.getCluster(clusterId), 'cluster').status });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
      return;
    }
    if (required(runtime.store.getTransaction(tx.id), 'root transaction').status === 'ACCEPTED') return;
    // The Auditor does its actual job — deciding the plan audits it is offered —
    // and then the cluster's work finishes inside its turn. A role that never
    // decides what it is offered starves itself into the turn cap, which is a
    // different test.
    for (const audit of runtime.store.pendingAudits(clusterId, { node_id: root.id, kind: 'plan', limit: 8 })) {
      command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { audit_id: audit.id, decision: 'approve' });
    }
    runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false }));
    runtime.evaluateCompletion(clusterId);
    observed.push({ node: required(runtime.store.getNode(root.id), 'root node').status, cluster: required(runtime.store.getCluster(clusterId), 'cluster').status });
    // The role keeps working for a moment after the last acceptance.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (required(runtime.store.getCluster(clusterId), 'cluster').status === 'COMPLETED' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  assert.ok(observed.length > 0, 'the Auditor did reach its turn');
  const firstObserved = firstOf(observed, 'observed state');
  assert.equal(firstObserved.node, 'ACTIVE', 'the node did not close while its Auditor was mid-turn');
  assert.equal(firstObserved.cluster, 'RUNNING');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'COMPLETED', 'and it closes once the roles are done');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'COMPLETED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const startedRoles = new Set(events.filter(event => event.type === 'turn-start').map(event => jsonObject(event.data, 'turn-start data').role));
  assert.ok(startedRoles.has('auditor'), `the Auditor took a turn: ${[...startedRoles].join(', ')}`);
  for (const roleAgent of runtime.store.listAgents(clusterId, {}).filter(agent => agent.role !== 'worker')) {
    assert.equal(roleAgent.status, 'TERMINATED', `${roleAgent.role} is terminated`);
    // Every role that really took a turn is *accounted*: either the turn is
    // booked (the count the identity's next session and the G1 check read), or
    // the ledger records that it failed before reaching the model — which is the
    // one case in which a turn must not advance that count.
    if (startedRoles.has(roleAgent.role) && roleAgent.turns === 0) {
      assert.ok(events.some(event => event.type === 'turn-start-failed' && jsonObject(event.data, 'turn-start-failed data').role === roleAgent.role),
        `${roleAgent.role} either booked its turn or recorded why it did not start`);
    }
  }
  const roleTurns = events.filter(event => event.type === 'turn-end' && jsonObject(event.data, 'turn-end data').role !== 'worker');
  assert.ok(roleTurns.length > 0, 'the management turns really ended, in the record');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'management-node-completed' && jsonObject(event.data, 'management-node-completed data').summary_id),
    'and the closing record carries its aggregate');
});

test('an identity that cannot fund its next request stops its node, and a worker allowance does not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodestop-'));
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
    objective: 'one node', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 500_000, model_requests: 20, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const allocator = firstOf(runtime.store.listAgents(clusterId, { role: 'allocator' }), 'allocator agent');

  // A per-identity allowance is not a node budget: the rule must not fire.
  assert.equal(runtime.blockNodeOnBudget(allocator, 'worker w1 reached its 2-request allowance for this task'), false);
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');

  // A request nobody can fund stops the node, with the code the report reads.
  assert.equal(runtime.blockNodeOnBudget(allocator, 'model request refused: budget exhausted for model_requests: requested 1, available 0'), true);
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  const nodeBlocked = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'node-blocked').at(-1), 'node-blocked event');
  assert.equal(jsonObject(nodeBlocked.data, 'node-blocked data').code, 'BUDGET_EXHAUSTED');
  assert.match(String(jsonObject(nodeBlocked.data, 'node-blocked data').reason), /^BUDGET:/);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  const clusterBlocked = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1), 'cluster-blocked event');
  assert.equal(jsonObject(clusterBlocked.data, 'cluster-blocked data').code, 'BUDGET_EXHAUSTED');
});

test("funding the compaction pool never sweeps another subtree's grants", t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 8, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 1, max_role_turns: 4 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const rootLimit = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget row')), 'budget view').tokens.limit;

  // A delegated child management node with a budget of its own, and one identity
  // funded by it: that subtree's capacity must survive the root's funding.
  const childNodeId = 'child-mgmt-1';
  runtime.store.tx(() => {
    runtime.store.insertNode({
      id: childNodeId, cluster_id: clusterId, parent_id: root.id, kind: 'management',
      depth: 1, status: 'ACTIVE', scope: { objective: 'delegated subtree' },
      path: `${root.path}.0`, max_children: 4,
    });
  });
  const childBudget = createBudget(runtime.store, {
    cluster_id: clusterId, scope_kind: 'node', scope_id: childNodeId, node_id: childNodeId,
    parent_budget_id: null, limit: { tokens: 300_000, model_requests: 60, tool_calls: 60 },
  });
  const childAgentId = 'agent-in-child';
  runtime.store.tx(() => {
    runtime.store.insertAgent({
      id: childAgentId, cluster_id: clusterId, node_id: childNodeId, role: 'worker', status: 'READY',
      session_id: 's-child', capabilities: [],
    });
  });
  const childGrant = createBudget(runtime.store, {
    cluster_id: clusterId, scope_kind: 'agent', scope_id: childAgentId, node_id: childNodeId,
    parent_budget_id: childBudget.id, limit: { tokens: 40_000, model_requests: 6, tool_calls: 6 },
  });

  const auditor = firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor agent');
  const auditorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'auditor budget');
  assert.ok(auditorBudget, 'the root identity holds a grant');

  const childAvailable = dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tokens');
  const rootIdle = dimensionAvailable(required(runtime.store.getBudget(auditorBudget.id), 'auditor budget row'), 'tokens');
  assert.ok(childAvailable > 0 && rootIdle > 0, `both grants are idle: ${childAvailable} / ${rootIdle}`);

  const moved = required(runtime.reclaimAllIdleGrants(clusterId, nodeBudget.id), 'reclaimed grant');
  const movedTokens = moved.tokens ?? 0;
  assert.ok(movedTokens > 0, `the root funded identity came home: ${JSON.stringify(moved)}`);
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tokens'), childAvailable,
    "the delegated subtree's grant is untouched");
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(auditorBudget.id), 'auditor budget row'), 'tokens'), 0,
    "the root's own identity gave everything back");
  assert.equal(required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget row')), 'budget view').tokens.limit, rootLimit + movedTokens,
    `the root node received exactly what it reclaimed: rootLimit=${rootLimit} moved=${JSON.stringify(moved)}`);
});

test('a funded request is charged to the scope that can actually pay it, not the one chosen before funding', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-reselect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const auditor = firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor agent');

  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const fallback = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'auditor budget');
  runtime.store.tx(() => {
    runtime.store.updateBudget(fallback.id, { tokens_limit: 100, tokens_spent: 0, tokens_reserved: 0, requests_limit: 1, requests_spent: 0, requests_reserved: 0 });
  });
  assert.ok(pool, 'the cluster has a compaction pool');

  let selections = 0;
  const refusals: Array<{ reason: string; facts: unknown }> = [];
  const blocks: string[] = [];
  const flow = {
    store: runtime.store,
    // The funder must top up the scope the chain selected, so it asks which
    // scope that is: the stub answers exactly as the runtime does.
    compactionBudgetId: () => pool.id,
    budgetChainForAgent: () => {
      selections += 1;
      return selections === 1 ? [fallback.id] : [pool.id];
    },
    topUpCompactionPool: () => {
      runtime.store.tx(() => runtime.store.updateBudget(pool.id, { tokens_limit: 200_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 8, requests_spent: 0, requests_reserved: 0 }));
      return { tokens: 200_000, model_requests: 8 };
    },
    recordBudgetRefusal: (_agent: AgentRecord, reason: string, facts?: unknown) => refusals.push({ reason, facts }),
    blockNodeOnBudget: (_agent: AgentRecord, reason: string) => { blocks.push(reason); return true; },
    workerRequestAllowance: () => null,
    sessionExists: async () => false,
  };

  host.setScript(async turn => {
    if (turn.requests.length) return;
    await turn.request({ purpose: 'compaction' });
  });
  await runTurn(host.ctx, {
    agent: auditor, role: 'auditor', prompt: 'summarise the session', allowedTools: [], globalTools: [],
    capabilities: [], model: { provider: 'local-sglang', model: 'Qwen3.8-7B', maxTokens: 512 },
    resume: false, signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
    budgetIds: [fallback.id], transactionId: null, turnSeq: 1, flow,
    contextLimits: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });

  assert.ok(selections >= 2, `the payable scope was resolved again after funding: ${selections} selections`);
  const receipt = runtime.store.usageReceiptsAll(clusterId, { agent_id: auditor.id }).at(-1);
  assert.ok(receipt, 'the request was reserved');
  assert.equal(receipt.budget_scope_id, pool.id, 'the receipt names the scope that actually paid');
  assert.notEqual(receipt.status, 'NOT_SENT', `the request was sent: ${receipt.status}`);
  assert.deepEqual(blocks, [], 'and the node was not stopped for a request that could be funded');
  assert.ok(refusals.length >= 1, 'the first, repaired refusal is still recorded');
});

test('a session that grows past the trigger again is compacted again inside the same turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-recompact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let tokens = 2_000;
  const compactionCalls: Array<{ reason: unknown; at: number }> = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: tokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(_session: unknown, reason: unknown) {
        compactionCalls.push({ reason, at: tokens });
        tokens = Math.floor(tokens / 2);
        return { summarySeq: compactionCalls.length };
      },
    },
  });
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');

  host.setScript(async turn => {
    for (let step = 1; step <= 4; step += 1) {
      const decision = await turn.preStep({ step });
      if (decision.kind !== 'enter') return;
      tokens += 8_000;
    }
  });
  await runTurn(host.ctx, {
    agent: auditor, role: 'auditor', prompt: 'work', allowedTools: [], globalTools: [], capabilities: [],
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', maxTokens: 512 },
    resume: false, signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
    budgetIds: runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), auditor),
    transactionId: null, turnSeq: 1, flow: runtime,
    contextLimits: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });

  const decisions = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'context-step').map(event => jsonObject(event.data, 'context-step data').decision);
  assert.ok(compactionCalls.length >= 2, `the session was compacted again after it grew: ${JSON.stringify(compactionCalls)}`);
  assert.ok(decisions.filter(value => value === 'compact').length >= 2, `two compactions are recorded: ${JSON.stringify(decisions)}`);
  assert.ok(tokens < 20_000, `the session did not grow without bound: ${tokens}`);
});

test('a revised plan is a new revision, and the Auditor re-decides it instead of the same rejection', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').revision, 1);
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'reject', required_change: 'name the depth-3 node explicitly' });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'DRAFT');
  const rejected = required(runtime.store.getTransaction(tx.id), 'root transaction').revision;
  assert.equal(rejected, 1, 'the rejection itself does not rewrite the plan');

  // The revision advances on its own: without it the re-dispatch would reuse the
  // audit that was just rejected, and the branch could only escalate.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id,
    acceptance_criteria: ['a depth-3 management node exists', 'its agent wrote the artifact and cited the evidence'],
  }).result;
  assert.equal(adjusted.revision, rejected + 1, `the adjustment advanced the revision: ${JSON.stringify(adjusted)}`);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').plan_approved_revision, null, 'and the old approval cannot carry over');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const audits = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 });
  const fresh = audits.find(audit => audit.transaction_id === tx.id && audit.target_revision === adjusted.revision);
  assert.ok(fresh, `a plan audit targets the new revision: ${JSON.stringify(audits.map(a => ({ tx: String(a.transaction_id).slice(0, 8), r: a.target_revision })))}`);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'READY', 'and the revised plan is dispatchable while the audit is pending');
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').plan_approved_revision, adjusted.revision);
});

test('transaction-scoped pause and resume advance the revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const before = required(runtime.store.getTransaction(tx.id), 'root transaction').revision;
  command(runtime, orchestrator, 'pause_transaction', { transaction_id: tx.id, reason: 'hold' });
  const paused = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.revision, before + 1, 'pausing is a lifecycle change, and it is visible as one');
  command(runtime, orchestrator, 'resume_transaction', { transaction_id: tx.id });
  const resumed = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(resumed.status, 'READY');
  assert.ok(resumed.revision > paused.revision, `resuming advances it again: ${paused.revision} -> ${resumed.revision}`);
  assert.equal(resumed.pre_pause_status, null);

  // Every lifecycle change is published at the revision it produced: a
  // notification that carried the pre-change snapshot told the other roles about
  // a revision that no longer exists.
  const changed = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-changed');
  const pausedEvent = required(changed.find(entry => jsonObject(entry.data, 'transaction-changed data').change === 'paused'), 'paused event');
  const resumedEvent = required(changed.find(entry => jsonObject(entry.data, 'transaction-changed data').change === 'resumed'), 'resumed event');
  assert.equal(jsonObject(pausedEvent.data, 'paused event data').revision, paused.revision, 'the pause published the revision the pause produced');
  assert.equal(jsonObject(resumedEvent.data, 'resumed event data').revision, resumed.revision, 'and the resume published the revision the resume produced');

  // Cancellation advances it too, so a plan audit left pending against the old
  // revision is visibly superseded rather than silently waiting.
  const beforeCancel = required(runtime.store.getTransaction(tx.id), 'root transaction').revision;
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, orchestrator, 'cancel_transaction', { transaction_id: tx.id, reason: 'stop' });
  const cancelled = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.revision > beforeCancel, `cancelling advances the revision: ${beforeCancel} -> ${cancelled.revision}`);
  const cancelEvent = [...changed].concat(runtime.store.readEvents(clusterId, { limit: 500 })).reverse().find(entry => entry.type === 'transaction-cancelled');
  assert.ok(cancelEvent, 'the cancellation is recorded');
  const cancelNotice = required(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-changed' && jsonObject(event.data, 'transaction-changed data').change === 'cancelled').at(-1), 'cancel notification');
  assert.equal(jsonObject(cancelNotice.data, 'cancel notification data').revision, cancelled.revision, 'and notified at the revision it produced');
});

test('a correction verified on the first try closes the issue without a failure counter', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // Reject the plan: that opens an issue naming the change the Auditor requires.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const rejection = command(runtime, auditor, 'inspect_plan', {
    transaction_id: tx.id, decision: 'reject', required_change: 'name the depth-3 node explicitly',
  }).result;
  const issueId = textOf(rejection.issue_id, 'issue id');
  assert.ok(issueId, `the rejection opened an issue: ${JSON.stringify(rejection)}`);
  const opened = required(runtime.store.getIssue(issueId), 'opened issue');
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.corrections, 0, 'a correction that has not failed is not counted');

  // The Orchestrator answers it with a real change to the plan.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, acceptance_criteria: ['a depth-3 management node exists'],
  }).result;
  const adjustedRevision = numberOf(adjusted.revision, 0, 1_000_000, 'adjusted revision');
  assert.ok(adjustedRevision > (opened.target_revision ?? 0), `${adjustedRevision} > ${opened.target_revision}`);

  // The Auditor verifies the correction on the first try: the issue closes.
  const verified = command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'VERIFIED', evidence: { revision: adjustedRevision },
  }).result;
  assert.equal(verified.status, 'CORRECTED');
  const closed = required(runtime.store.getIssue(issueId), 'closed issue');
  assert.equal(closed.status, 'CORRECTED');
  assert.equal(closed.corrections, 0, 'the counter never moved: this correction succeeded first time');

  // The witness the recursion gate reads is the durable change plus the closure,
  // not that counter.
  const adjustments = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-adjusted')
    .map(event => ({ transaction_id: jsonObject(event.data, 'transaction-adjusted data').transaction_id, revision: jsonObject(event.data, 'transaction-adjusted data').revision }));
  const answered = correctionWitness([{ ...closed }], adjustments);
  assert.equal(answered.length, 1, `a first-try correction is still a correction: ${JSON.stringify(adjustments)}`);
  // And a plan that was never changed is not mistaken for one.
  assert.equal(correctionWitness([{ ...closed, transaction_id: 'other-tx', corrections: 0 }], adjustments).length, 0);
});

test('an ordinary request is funded by the pool when the scopes around it are short', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  assert.ok(pool && nodeBudget && agentBudget);

  // The shape the recursion run was refused in: the node holds 2,595 tokens and
  // the identity nothing, while the pool holds 63,644.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 2_595, tokens_spent: 0, tokens_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0 });
    runtime.store.updateBudget(pool.id, { tokens_limit: 63_644, tokens_spent: 0, tokens_reserved: 0, requests_limit: 9, requests_spent: 0, requests_reserved: 0 });
  });

  const chain = runtime.budgetChainForAgent(agent, { tokens: 6_829, requests: 1 });
  assert.deepEqual(chain, [pool.id], 'the pool is the scope that can pay it');
  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 6_829, turn_seq: 1,
  });
  const after = required(runtime.store.getBudget(pool.id), 'pool budget');
  assert.equal(after.tokens_reserved, 6_829, 'the pool holds the reservation');
  assert.equal(required(runtime.store.getUsageReceipt(request.request_id), 'usage receipt').budget_scope_id, pool.id, 'and the receipt says so');
  // The node that could not pay is untouched: no capacity moved to reach this.
  assert.equal(required(runtime.store.getBudget(nodeBudget.id), 'node budget row').tokens_reserved, 0);
  void orchestrator;
});

test('a rejection of a superseded plan is stale: it never touches the newer revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // Revision 1 is dispatched and pending the Auditor's verdict.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const rev1Audit = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 })
    .find(audit => audit.transaction_id === tx.id && audit.target_revision === 1);
  assert.ok(rev1Audit, 'the first plan audit is pending');

  // The Orchestrator revises it before the Auditor gets to rev1.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, acceptance_criteria: ['a depth-3 management node exists'],
  }).result;
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const before = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(before.status, 'READY');
  assert.equal(before.revision, adjusted.revision);

  // The late verdict on rev1 must be STALE for either answer — including the one
  // that would otherwise pull the plan back and open a correction issue.
  const late = command(runtime, auditor, 'inspect_plan', {
    audit_id: rev1Audit.id, decision: 'reject', required_change: 'name the depth-3 node',
  }).result;
  assert.equal(late.decision, 'STALE', `a superseded plan is stale, not rejected: ${JSON.stringify(late)}`);
  assert.equal(required(runtime.store.findAudit(clusterId, tx.id, 'plan', 1), 'rev1 audit').decision, 'STALE');

  const after = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(after.status, 'READY', 'the newer revision is untouched');
  assert.equal(after.revision, adjusted.revision, 'and it is still the revision that was dispatched');
  assert.equal(after.plan_approved_revision, null, 'a stale verdict cannot clear or grant an approval it never reviewed');
  assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 0, 'and it opens no correction for work that moved on');

  // The current revision still has its own plan audit to decide, and deciding it
  // works normally.
  const rev2Audit = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 })
    .find(audit => audit.transaction_id === tx.id && audit.target_revision === adjusted.revision);
  assert.ok(rev2Audit, 'the new revision has a pending audit of its own');
  const verdict = command(runtime, auditor, 'inspect_plan', { audit_id: rev2Audit.id, decision: 'approve' }).result;
  assert.equal(verdict.decision, 'APPROVED');
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').plan_approved_revision, adjusted.revision);
});

test('a request the chain hands to the pool is funded in the pool, whichever kind it is', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  assert.ok(pool && nodeBudget && agentBudget, 'the pool, its funding node and the identity grant exist');

  // The pool holds the most capacity but has spent its whole request allowance,
  // and the node can cover that one request — the shape that blocked the
  // recursion run, where every later request (including the compactions the pool
  // exists for) was refused while the node still had requests to lend.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 100_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 1, requests_spent: 1, requests_reserved: 0 });
    // The node is short of *tokens* for this request but holds requests to lend,
    // so no candidate is payable and the chain falls back to the pool — the scope
    // the funder must then replenish.
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 10, requests_spent: 0, requests_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    // Nothing idle anywhere else in this node either: the identity cannot be made
    // whole at all, which is the premise of the ordering hazard.
    for (const row of runtime.store.all(
      "SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent' AND scope_id<>?", clusterId, agent.id)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  const chain = runtime.budgetChainForAgent(agent, { tokens: 5_000, requests: 1 });
  assert.deepEqual(chain, [pool.id], 'no scope is payable, so the chain names the one with the most capacity');

  const before = required(runtime.store.getBudget(pool.id), 'pool budget').requests_limit;
  const reservedBefore = required(runtime.store.getBudget(pool.id), 'pool budget').requests_reserved;
  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 5_000, turn_seq: 1,
    fund: error => runtime.topUpCompactionPool(clusterId, { model_requests: error.requested ?? 1 }),
    reselect: () => runtime.budgetChainForAgent(agent, { tokens: 5_000, requests: 1 }),
  });
  assert.ok(request.request_id, 'the request is funded and reserved');
  const after = required(runtime.store.getBudget(pool.id), 'pool budget');
  assert.ok(after.requests_limit > before, `the pool was refilled in place: ${before} → ${after.requests_limit}`);
  // A reservation holds the request; settlement is what spends it.
  assert.equal(after.requests_reserved, reservedBefore + 1, `and the request it funded is held there: ${reservedBefore} → ${after.requests_reserved}`);
  assert.equal(required(runtime.store.getUsageReceipt(request.request_id), 'usage receipt').budget_scope_id, pool.id);
});

test('an accounting fault blocks the management owner while still booking its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-acctfault-'));
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
    objective: 'a role turn whose reconciliation throws', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });

  // Fault injection inside the finisher's bookkeeping, which must never take the
  // turn's own accounting down with it.
  runtime.reconcileReservations = () => { throw Object.assign(new Error('injected reconciliation fault'), { code: 'ACCOUNTING_UNCERTAIN' }); };

  runtime.enableScheduling();
  const deadline = Date.now() + 6_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (required(runtime.store.getCluster(clusterId), 'cluster').status !== 'RUNNING' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const uncertain = events.filter(event => event.type === 'accounting-uncertain');
  const roleEnds = events.filter(event => event.type === 'turn-end' && jsonObject(event.data, 'turn-end data').role !== 'worker');
  assert.ok(uncertain.length >= 1, `the fault is recorded: ${JSON.stringify(events.map(event => event.type).slice(-12))}`);
  const uncertainData = jsonObject(required(uncertain[0], 'accounting-uncertain event').data, 'accounting-uncertain data');
  assert.equal(uncertainData.transaction_id, null, 'a role turn names no transaction, and does not throw doing it');
  assert.match(String(uncertainData.reason), /injected reconciliation fault/);
  assert.equal(required(runtime.store.getAgent(textOf(uncertainData.agent_id, 'agent id')), 'blocked agent').status, 'BLOCKED',
    'a subsequent turn cannot act on unaccounted work');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  // Every management turn that started ended and was booked: a throw out of the
  // finisher's error handler would leave the faulted turn with neither.
  const startedRoles = new Set(events.filter(event => event.type === 'turn-start').map(event => jsonObject(event.data, 'turn-start data').role));
  assert.ok(startedRoles.size > 0, 'management roles did take turns');
  assert.ok(roleEnds.length >= startedRoles.size, `${roleEnds.length} role turns ended for ${startedRoles.size} roles that started`);
  for (const roleAgent of runtime.store.listAgents(clusterId, {}).filter(agent => startedRoles.has(agent.role))) {
    assert.ok(roleAgent.turns > 0, `${roleAgent.role} booked its turn(s): ${roleAgent.turns}`);
  }
});

