/**
 * Mechanism tests for ClusterRuntime: the management tree, transaction
 * lifecycle, role permissions, business acceptance, budgets, communication, the
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

import { fixtureParams } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { budgetView, createBudget, dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';

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
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off',},
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


/** A JSON value read as an object; every command handler answers with one. */
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  return objectField(value, label);
}

/** One command's result, already narrowed to the object the handler returned. */
interface TestCommandOutcome extends Omit<FlowCommandOutcome, 'result'> {
  readonly result: Record<string, unknown>
}

function startCluster(runtime: ClusterRuntime, overrides: Partial<FlowStartRequest> = {}): string {
  const snapshot = runtime.start({ managementCapabilities: [],
    objective: 'test objective',
    acceptance_criteria: ['The requested fixture deliverable is provided.'],
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
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
  const outcome = runtime.command(actor, { command_id: `cmd-${counter}`, action, params: fixtureParams(runtime, actor, action, params), ...extra });
  return { deduped: outcome.deduped, revision: outcome.revision, result: jsonObject(outcome.result, 'command.result') };
}

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
  const child = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: original.id, scope: { objective: 'complete funded delegated work' },
  }).result;
  const childNodeId = textOf(child.node_id, 'child node id');
  const childDelegatedTxId = textOf(child.delegated_transaction_id, 'delegated transaction id');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: root needs more tokens',
    'BUDGET_EXHAUSTED', {
      agent_id: allocator.agent_id,
      envelope: { tool_calls: 0 },
    });
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING',
    'the still-funded child can finish independently and return its unspent grant');
  assert.equal(required(runtime.store.getNode(childNodeId), 'child node').status, 'ACTIVE');

  runtime.store.tx(() => runtime.store.updateTransaction(childDelegatedTxId, {
    status: 'ACCEPTED', __bump_revision: false,
  }));
  runtime.evaluateCompletion(clusterId);

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
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'do not schedule past an unresolved root budget stop',
    workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 2, max_llm_concurrency: 1 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 2 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: original.id, scope: { objective: 'pending child task' },
  }).result;
  assert.equal(required(runtime.store.getNode(textOf(child.node_id, 'child node id')), 'child node').status, 'ACTIVE');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: root cannot fund a 2m-token request',
    'BUDGET_EXHAUSTED', {
      agent_id: allocator.agent_id,
      envelope: { tool_calls: 0 },
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

test('a node retains the lease and accounts for its final management turn before completion', async t => {
  const host = createFakeHost(), dir = mkdtempSync(join(tmpdir(), 'dsh-flow-account-close-'));
  const runtime = await startFlowPlugin(host, { dataDir: dir, provider: 'local-fake', model: 'fake-model', tickMs: 10000, heartbeatMs: 10000, leaseTtlMs: 60000 });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const clusterId = runtime.start({ managementCapabilities: [], objective: 'Retain the live final turn.', acceptance_criteria: ['The delivery is complete.'], workspace: dir, capabilities: [], budget: { tool_calls: 400, agents: 16, max_active_agents: 1 }, limits: { max_active_agents: 1, max_llm_concurrency: 1 } }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root'), lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.rootTransactions(clusterId), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id }); runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: 'complete' }); command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: true });
  let sawLease = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id !== lead.agent_id) return;
    await turn.callTool('flow_transaction', { action: 'finish_cluster', params: {} });
    sawLease = runtime.store.leaseForAgent(lead.agent_id) !== null;
    assert.equal(runtime.store.getNode(root.id)?.status, 'ACTIVE');
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 12 && runtime.store.getCluster(clusterId)?.status === 'RUNNING'; pass++) {
    await runtime.tick(); await Promise.all(runtime.activeTurnIds().map(id => runtime.activeTurnFor(id)!.promise));
  }
  assert.equal(sawLease, true); assert.equal(runtime.store.getCluster(clusterId)?.status, 'COMPLETED');
  assert.ok((runtime.store.getAgent(lead.agent_id)?.turns ?? 0) > 0);
  assert.equal(runtime.store.leaseForAgent(lead.agent_id), null);
});

test('an identity that cannot fund its next tool call stops its node', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodestop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'one node', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const allocator = firstOf(runtime.store.listAgents(clusterId, { role: 'allocator' }), 'allocator agent');

  // A tool call nobody can fund stops the node, with the code the report reads.
  assert.equal(runtime.blockNodeOnBudget(allocator, 'tool call refused: budget exhausted for tool_calls: requested 1, available 0'), true);
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  const nodeBlocked = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'node-blocked').at(-1), 'node-blocked event');
  assert.equal(jsonObject(nodeBlocked.data, 'node-blocked data').code, 'BUDGET_EXHAUSTED');
  assert.match(String(jsonObject(nodeBlocked.data, 'node-blocked data').reason), /^BUDGET:/);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  const clusterBlocked = required(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1), 'cluster-blocked event');
  assert.equal(jsonObject(clusterBlocked.data, 'cluster-blocked data').code, 'BUDGET_EXHAUSTED');
});

test("reclaiming idle tool grants never sweeps another subtree's grants", t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 8, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 1, max_role_turns: 4 },
    budget: { tool_calls: 200, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const rootLimit = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget row')), 'budget view').tool_calls.limit;

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
    parent_budget_id: null, limit: { tool_calls: 60 },
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
    parent_budget_id: childBudget.id, limit: { tool_calls: 6 },
  });

  const validationOwner = firstOf(runtime.store.listAgents(clusterId, { role: 'orchestrator' }), 'validationOwner agent');
  const managerBudget = required(runtime.store.budgetForScope(clusterId, 'agent', validationOwner.id), 'validationOwner budget');
  assert.ok(managerBudget, 'the root identity holds a grant');

  const childAvailable = dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tool_calls');
  const rootIdle = dimensionAvailable(required(runtime.store.getBudget(managerBudget.id), 'validationOwner budget row'), 'tool_calls');
  assert.ok(childAvailable > 0 && rootIdle > 0, `both grants are idle: ${childAvailable} / ${rootIdle}`);

  const moved = required(runtime.reclaimAllIdleGrants(clusterId, nodeBudget.id), 'reclaimed grant');
  const movedTokens = moved.tool_calls ?? 0;
  assert.ok(movedTokens > 0, `the root funded identity came home: ${JSON.stringify(moved)}`);
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tool_calls'), childAvailable,
    "the delegated subtree's grant is untouched");
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(managerBudget.id), 'validationOwner budget row'), 'tool_calls'), 0,
    "the root's own identity gave everything back");
  assert.equal(required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget row')), 'budget view').tool_calls.limit, rootLimit + movedTokens,
    `the root node received exactly what it reclaimed: rootLimit=${rootLimit} moved=${JSON.stringify(moved)}`);
});

test('a business correction produces a new immutable plan instead of reusing the rejected plan', t => {
  const runtime = makeRuntime(t), clusterId = startCluster(runtime), root = rootNode(runtime, clusterId);
  const lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.rootTransactions(clusterId), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  const oldPlan = required(runtime.store.getTransaction(tx.id)?.current_plan_ref, 'old plan');
  command(runtime, lead, 'reopen_transaction', { transaction_id: tx.id, required_change: 'Name the actual depth-3 output.' });
  command(runtime, lead, 'adjust_transaction', { transaction_id: tx.id, inputs: { output: 'deep/nested/result.txt' } });
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  const current = required(runtime.store.getTransaction(tx.id), 'transaction');
  assert.equal(current.status, 'READY'); assert.notDeepEqual(current.current_plan_ref, oldPlan);
  assert.ok(runtime.store.getPlan(oldPlan));
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

  // Cancellation advances the observable revision too.
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

test('a successful first business repair closes its issue without consuming a failed round', t => {
  const runtime = makeRuntime(t), clusterId = startCluster(runtime), root = rootNode(runtime, clusterId);
  const lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.rootTransactions(clusterId), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { value: 6 } });
  command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: false, checks: [{ passed: false }] });
  const issue = firstOf(runtime.store.openIssues(clusterId, { transaction_id: tx.id }), 'issue');
  command(runtime, lead, 'adjust_transaction', { transaction_id: tx.id, inputs: { correction: 'Return the correct sum.' } });
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { value: 5 }, current_result_ref: null });
  command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: true });
  assert.equal(runtime.store.getTransaction(tx.id)?.status, 'ACCEPTED');
  assert.equal(runtime.store.getIssue(issue.id)?.status, 'CORRECTED'); assert.equal(runtime.store.getIssue(issue.id)?.corrections, 0);
});

test('a correction bound to a superseded revision cannot invalidate the new plan', t => {
  const runtime = makeRuntime(t), clusterId = startCluster(runtime), root = rootNode(runtime, clusterId);
  const lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.rootTransactions(clusterId), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id }); const old = required(runtime.store.getTransaction(tx.id), 'old transaction');
  command(runtime, lead, 'adjust_transaction', { transaction_id: tx.id, objective: 'A newer plan with a concrete deliverable' });
  command(runtime, lead, 'dispatch', { transaction_id: tx.id }); const current = required(runtime.store.getTransaction(tx.id), 'current transaction');
  assert.throws(() => command(runtime, lead, 'reopen_transaction', { transaction_id: tx.id, expected_transaction_revision: old.revision, required_change: 'Correct the stale plan.' }), /revision|stale/);
  assert.deepEqual(runtime.store.getTransaction(tx.id), current); assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 0);
});
