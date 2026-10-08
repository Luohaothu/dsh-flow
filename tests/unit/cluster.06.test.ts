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
import { budgetView, createBudget, dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';

import { correctionWitness } from '../acceptance/checks/recursion.ts';
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
    budget: { tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
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
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'do not schedule past an unresolved root budget stop',
    workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 2, max_llm_concurrency: 1 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 2 },
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

test('a node waits for its own roles to finish before it closes, and books their turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one transaction, accepted while a role is still working', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 4 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
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
    // Resolve the Auditor identity from its role and management node.
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
    // booked (the count the identity's next session and the smoke check read), or
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
  const clusterId = runtime.start({
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

  const auditor = firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor agent');
  const auditorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'auditor budget');
  assert.ok(auditorBudget, 'the root identity holds a grant');

  const childAvailable = dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tool_calls');
  const rootIdle = dimensionAvailable(required(runtime.store.getBudget(auditorBudget.id), 'auditor budget row'), 'tool_calls');
  assert.ok(childAvailable > 0 && rootIdle > 0, `both grants are idle: ${childAvailable} / ${rootIdle}`);

  const moved = required(runtime.reclaimAllIdleGrants(clusterId, nodeBudget.id), 'reclaimed grant');
  const movedTokens = moved.tool_calls ?? 0;
  assert.ok(movedTokens > 0, `the root funded identity came home: ${JSON.stringify(moved)}`);
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(childGrant.id), 'child grant'), 'tool_calls'), childAvailable,
    "the delegated subtree's grant is untouched");
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(auditorBudget.id), 'auditor budget row'), 'tool_calls'), 0,
    "the root's own identity gave everything back");
  assert.equal(required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget row')), 'budget view').tool_calls.limit, rootLimit + movedTokens,
    `the root node received exactly what it reclaimed: rootLimit=${rootLimit} moved=${JSON.stringify(moved)}`);
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
