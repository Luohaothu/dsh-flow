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
import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { checkWriteAccess } from '../../packages/dsh-flow/src/core/scope.ts';
import { dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
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
test('an empty node pool does not send an Allocator into an unsupported escalation loop', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'delegated work' },
  }).result;
  const node = required(runtime.store.getNode(textOf(child.node_id, 'node_id')), 'node');
  const budget = required(runtime.store.budgetForScope(clusterId, 'node', node.id), 'node budget');
  runtime.store.tx(() => runtime.store.updateBudget(budget.id, {
    tokens_limit: 0, requests_limit: 0,
  }));
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: node.id, role: 'allocator', limit: 1 }), 'node allocator');
  const actions = runtime.pendingFor('allocator', node, required(runtime.store.getCluster(clusterId), 'cluster'), allocator);
  assert.equal(actions.some(item => item.action === 'escalate-budget'), false,
    'an empty pool is not a refusal and does not offer a nonexistent tool action');
  runtime.recordBudgetRefusal(allocator, 'cannot fund a model request', {
    scope: node.id, dimension: 'tokens', requested: 8192, available: 0,
  });
  const parentAllocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const localOrchestrator = actorFor(runtime, clusterId, 'orchestrator', node.id);
  for (const recipient of [parentAllocator.agent_id, localOrchestrator.agent_id]) {
    assert.ok(runtime.store.listInbox(clusterId, { recipient, status: 'PENDING' })
      .some(item => item.subject === 'budget-refused' && item.payload !== null && jsonObject(item.payload, 'inbox payload').node_id === node.id),
    'a real refusal reaches the resource owner and the local planning owner');
  }
});

test('a node whose requests are gone reclaims them from its own live roles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inscope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'requests idle in the node\'s own roles', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 4_194_304, model_requests: 512, tool_calls: 4_096, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  const rich = firstOf(roles, 'rich role');
  const poor = required(roles[1], 'poor role');
  // The shape the run ended on: the node's own file is spent, while two of its
  // roles hold their grants — and those roles are *live*, mid-turn.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { requests_limit: 27, requests_spent: 27, requests_reserved: 0 });
    runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', rich.id), 'rich budget').id,
      { requests_limit: 96, requests_spent: 26, requests_reserved: 0 });
    // The identity asking for the repair is out of requests itself, and its node
    // has nothing left either: only the siblings' idle grants can help.
    runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', poor.id), 'poor budget').id,
      { requests_limit: 0, requests_spent: 0, requests_reserved: 0, tokens_limit: 4_000, tokens_spent: 4_000 });
    for (const agent of [rich, poor]) {
      runtime.store.createLease({
        id: `lease-${agent.id.slice(0, 8)}`, cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
        epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 120_000,
        event_upper_bound: undefined,
      });
    }
  });
  const granted = runtime.topUpBudgetForAgent(poor, { tokens: 20_000, model_requests: 5 });
  assert.ok(granted, `the repair runs inside the node: ${JSON.stringify(granted)}`);
  const nodeAfter = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.ok(Number(nodeAfter.requests_limit) - Number(nodeAfter.requests_spent) > 0 || Number(jsonObject(granted, 'grant').requests) > 0,
    `the idle requests came home: ${JSON.stringify({ lim: nodeAfter.requests_limit, spent: nodeAfter.requests_spent, granted })}`);
  const poorAfter = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'agent', poor.id), 'poor budget').id), 'poor budget');
  assert.ok(Number(poorAfter.requests_limit) >= 5, `and the identity can make its requests: ${poorAfter.requests_limit}`);
  const richAfter = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'agent', rich.id), 'rich budget').id), 'rich budget');
  assert.ok(Number(richAfter.requests_limit) - Number(richAfter.requests_spent) >= 2,
    `the live role keeps a working envelope: ${Number(richAfter.requests_limit) - Number(richAfter.requests_spent)}`);
  void cluster;
});

test('a child is funded from the capacity its own node is holding in idle roles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-parentreclaim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the parent holds it in its roles', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 4_194_304, model_requests: 512, tool_calls: 4_096, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  // The shape the run ended on: the node's own file is spent, its roles hold the
  // requests and are between turns.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { requests_limit: 33, requests_spent: 33, requests_reserved: 0 });
    roles.forEach((agent, index) => {
      runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'role budget').id, {
        requests_limit: 96 - index * 20, requests_spent: 10, requests_reserved: 0,
      });
    });
  });
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate to a child', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = textOf(created.result.transaction_id, 'transaction_id');
  const spawned = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that must run', acceptance_criteria: ['x'],
  });
  const childId = textOf(spawned.result.node_id, 'node_id');
  const childBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', childId), 'child budget').id), 'child budget');
  const roleGrants = firstOf(runtime.store.all(
    "SELECT SUM(requests_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", childId), 'role grants').c;
  assert.ok(Number(childBudget.requests_limit) + Number(roleGrants) >= 30,
    `the child got a working file from the parent's own roles: ${childBudget.requests_limit} + ${roleGrants}`);
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'budget-rebalanced' || event.type === 'budget-topup' || event.type === 'budget-granted'),
    'and the movement is recorded');
});

test('a repaired shortfall is recorded as one, and a terminal refusal as a refusal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-shortfall-'));
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
    objective: 'a repaired shortfall is not a refusal', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 }), 'orchestrator agent');
  const facts = { scope: 'scope-x', dimension: 'tokens', requested: 12_000, available: 0 };
  runtime.recordBudgetRefusal(agent, 'a shortfall the funder then closed', { ...facts, terminal: false });
  runtime.recordBudgetRefusal(agent, 'a refusal nothing could repair', facts);
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  const shortfall = events.filter(event => event.type === 'budget-shortfall');
  const refused = events.filter(event => event.type === 'budget-refused');
  assert.equal(shortfall.length, 1, 'the repaired shortfall is recorded as a shortfall');
  assert.equal(refused.length, 1, 'and only the terminal one as a refusal');
  assert.equal(jsonObject(firstOf(shortfall, 'shortfall').data, 'shortfall data').terminal, false);
  assert.equal(jsonObject(firstOf(refused, 'refusal').data, 'refusal data').terminal, true);
  // The acceptance classifier counts refusals, never shortfalls: a run that
  // recovered every shortfall must not be reported as having reached a limit.
  const counted = required(runtime.store.get(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type IN ('budget-refused','tool-call-refused')", clusterId), 'refusal count').c;
  assert.equal(Number(counted), 1, `the terminal refusal is the only one counted: ${counted}`);
});

test('a full-envelope repair leaves the tokens where the pool can draw them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-envelope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the pool must keep what it needs', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 }), 'orchestrator agent');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  // The advisory's shape: the pool holds one request and no tokens, the node holds
  // tokens and no requests, and the identity is empty and leased.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-empty', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 120_000,
    event_upper_bound: undefined,
  }));
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 1, requests_spent: 0, requests_reserved: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 400_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    // Nothing idle anywhere else in this node either: the identity cannot be made
    // whole at all, which is the premise of the ordering hazard.
    for (const row of runtime.store.all(
      "SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent' AND scope_id<>?", clusterId, agent.id)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  // No repair can make the identity whole — it cannot be given a request — so a
  // full-envelope rule moves nothing into it, and the pool's token gap is what
  // gets closed.
  const identityRepair = runtime.topUpBudgetForAgent(agent, { tokens: 20_000, model_requests: 1 });
  assert.equal(identityRepair, null, 'the identity is left exactly as it was');
  const agentAfter = required(runtime.store.getBudget(agentBudget.id), 'agent budget');
  assert.equal(Number(agentAfter.tokens_limit), 0, 'no tokens are moved into an identity that cannot spend them');
  const nodeAfter = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(Number(nodeAfter.tokens_limit), 400_000, 'and the node still holds them for the pool');
  const poolRepair = runtime.topUpCompactionPool(clusterId, { tokens: 20_000, model_requests: 1 });
  assert.ok(poolRepair && jsonObject(poolRepair, 'pool repair').tokens === 20_000, `the pool gets the tokens it was missing: ${JSON.stringify(poolRepair)}`);
  const poolAfter = required(runtime.store.getBudget(pool.id), 'pool budget');
  assert.ok(Number(poolAfter.tokens_limit) - Number(poolAfter.tokens_spent) >= 20_000, 'and can now pay both halves');
  assert.ok(Number(poolAfter.requests_limit) - Number(poolAfter.requests_spent) >= 1, 'including the request it already held');
});


test('a refused identity is resumed only after its budget is really transferred', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-repair-resume-'));
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
    objective: 'a real refusal, then a real repair', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', allocator.id), 'allocator budget');
  // A sibling branch keeps the *cluster* solvent, exactly as in the recorded run:
  // the identity's own chain holds nothing, so its request is refused, while the
  // cluster still has capacity elsewhere that only a transfer may reach.
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const siblingTx = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the branch that holds capacity', acceptance_criteria: ['x'], status: 'READY',
  });
  const siblingTxId = textOf(siblingTx.result.transaction_id, 'sibling transaction_id');
  const siblingNode = textOf(command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', {
    transaction_id: siblingTxId, objective: 'capacity holder', acceptance_criteria: ['x'],
  }).result.node_id, 'sibling node_id');
  // Work to do, a role that will be refused, and nothing idle anywhere in its
  // chain — so the refusal is real and the node stops for it.
  const unfundedTx = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'work that cannot be funded', acceptance_criteria: ['x'],
  }).result.transaction_id, 'unfunded transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: unfundedTx });
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    // Every identity this node funds is empty too, so no repair can close the gap
    // and the refusal is real.
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent'", clusterId)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0, tokens_reserved: 0, requests_reserved: 0 });
    }
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    // The compaction pool is a legal payer for any role request, so it is part of
    // the starvation the fixture needs.
    const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
    if (pool) runtime.store.updateBudget(pool.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
  });
  // The role really asks the provider, which is how a refusal is produced.
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'allocator') return;
    await turn.request({ purpose: 'role', usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 14; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (Number(required(runtime.store.get("SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='budget-refused'", clusterId), 'refusal count').c) > 0) break;
  }
  const refusals = runtime.store.all(
    "SELECT data FROM events WHERE cluster_id=? AND type='budget-refused' ORDER BY seq", clusterId).map(row => JSON.parse(textOf(row.data, 'event data')));
  if (!refusals.length) {
    const evts = runtime.store.all("SELECT type, json_extract(data,'$.role') r, json_extract(data,'$.stop_reason') s, json_extract(data,'$.reason') why FROM events WHERE cluster_id=? ORDER BY seq DESC LIMIT 8", clusterId);
    throw new Error(`no refusal: ${JSON.stringify(evts)}`);
  }
  assert.ok(refusals.length > 0, 'a request was really refused');
  const block = firstOf(runtime.store.all(
    "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' ORDER BY seq DESC LIMIT 1", clusterId), 'node-blocked event');
  assert.ok(block, 'the node stopped for it');
  const blockData = jsonObject(JSON.parse(textOf(block.data, 'event data')), 'block data');
  assert.equal(blockData.code, 'BUDGET_EXHAUSTED');
  assert.ok(blockData.agent_id, `the stop names the identity that was refused: ${JSON.stringify(blockData)}`);
  const excludeAgent = blockData.agent_id;
  void excludeAgent;

  // Balances that did not change keep it stopped.
  assert.equal(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'node-resumed').length, 0,
    'no resume while nothing has been moved');
  const beforeTurns = Number(runtime.store.get(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start'", clusterId)?.c ?? 0);

  // A real transfer into the node, by the identity that owns it.
  const rich = (() => {
    const other = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
      from: { kind: 'root', id: clusterId }, to: { kind: 'node', id: root.id }, amounts: { tokens: 0 },
    });
    void other;
    return null;
  })();
  void rich;
  // The root scope handed everything down, so the capacity for the repair comes
  // from another node; with only one node here, mint it through the pool's parent
  // by transferring from the *agent* grants the node itself funds — the plugin's
  // own in-scope reclaim does this, so instead the test funds the node directly and
  // records the transfer event the resume requires.
  const siblingBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', siblingNode), 'sibling budget').id), 'sibling budget');
  const movable = Math.min(120_000, Math.max(0, Number(siblingBudget.tokens_limit) - Number(siblingBudget.tokens_spent)));
  assert.ok(movable > 60_000, `the sibling branch holds capacity to move: ${movable}`);
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
    from: { kind: 'node', id: siblingNode }, to: { kind: 'node', id: root.id },
    amounts: { tokens: movable, model_requests: Math.min(12, Math.max(0, Number(siblingBudget.requests_limit) - Number(siblingBudget.requests_spent))) },
  });
  const after = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.ok(dimensionAvailable(after, 'tokens') > 100_000, `the capacity arrived: ${JSON.stringify({ tl: after.tokens_limit, ts: after.tokens_spent })}`);
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'node-resumed')) break;
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.ok(events.some(event => event.type === 'node-resumed' && jsonObject(event.data, 'event data').code === 'BUDGET_REPAIRED'),
    `the node is resumed once its budget really changed: ${JSON.stringify(events.filter(e => e.type === 'node-blocked' || e.type === 'node-resumed').map(e => e.type))}`);
  const afterTurns = Number(runtime.store.get(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start'", clusterId)?.c ?? 0);
  assert.ok(afterTurns > beforeTurns, `turns are admitted again: ${afterTurns} vs ${beforeTurns}`);
});

test('a budget-blocked root resumes when an in-scope donor finishes its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-idle-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an idle grant can fund the root', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1 },
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const poor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' }), 'poor role');
  const donor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator' }), 'donor role');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const poorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', poor.id), 'poor budget');
  const donorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', donor.id), 'donor budget');
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' }), 'auditor role');
  const auditorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'auditor budget');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(poorBudget.id, { tokens_limit: 6_007, tokens_spent: 0, requests_limit: 1, requests_spent: 0 });
    runtime.store.updateBudget(donorBudget.id, { tokens_limit: 271_253, tokens_spent: 0, requests_limit: 10, requests_spent: 0 });
    runtime.store.updateBudget(auditorBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(pool.id, { tokens_limit: 1_994, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.createLease({
      id: 'leased-donor', cluster_id: clusterId, agent_id: donor.id, node_id: root.id,
      epoch: donor.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
      event_upper_bound: undefined,
    });
  });
  const envelope = { tokens: 19_484, model_requests: 1, tool_calls: 0 };
  assert.equal(runtime.topUpBudgetForAgent(poor, { tokens: envelope.tokens, model_requests: 1 }), null,
    'a lease fences the donor grant while that turn is live');
  runtime.blockNodeOnBudget(poor, 'the root role cannot pay a compaction request', {
    dimension: 'tokens', requested: envelope.tokens, envelope,
  });
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  runtime.store.tx(() => runtime.store.deleteLease('leased-donor'));
  const before = [nodeBudget.id, poorBudget.id, donorBudget.id].reduce(
    (sum, id) => sum + required(runtime.store.getBudget(id), 'budget').tokens_limit, 0);
  host.setScript(async () => {});
  runtime.enableScheduling();
  await runtime.tick();
  const resumed = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'cluster-resumed');
  assert.equal(resumed.length, 1, 'an idle same-node grant repairs the failed request envelope');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');
  const after = [nodeBudget.id, poorBudget.id, donorBudget.id].reduce(
    (sum, id) => sum + required(runtime.store.getBudget(id), 'budget').tokens_limit, 0);
  assert.equal(after, before, 'the repair transfers already-declared tokens, not a new budget');
});

test('an incomplete repair does not resume the node, and a complete one does', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-envelope-resume-'));
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
    objective: 'only a whole envelope may resume a node', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator role');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'agent budget');
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // A real stop for a real envelope: recorded with both dimensions.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 5_000, tokens_spent: 5_000, requests_limit: 1, requests_spent: 1 });
    runtime.store.updateBudget(required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool').id,
      { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent' AND scope_id<>?", clusterId, role.id)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').scope_id,
    dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED', 'the node stopped for it');
  const resumed = () => runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'node-resumed').length;

  // Repair one dimension only: tokens arrive, requests stay at zero.
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
    from: { kind: 'agent', id: role.id }, to: { kind: 'node', id: root.id }, amounts: { tokens: 0 },
  });
  runtime.store.tx(() => runtime.store.updateBudget(agentBudget.id, { tokens_limit: 200_000, tokens_spent: 0, requests_limit: 0, requests_spent: 0 }));
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'budget-topup', {
    agent_id: role.id, node_id: root.id, granted: { tokens: 200_000 }, mode: 'request-gap',
  }));
  runtime.enableScheduling();
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.equal(resumed(), 0, 'tokens alone do not resume a request-less node');

  // Now the request half arrives as well: the envelope is whole, and the node runs.
  runtime.store.tx(() => {
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 200_000, tokens_spent: 0, requests_limit: 6, requests_spent: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 30, requests_spent: 0 });
  });
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'budget-topup', {
    agent_id: role.id, node_id: root.id, granted: { model_requests: 6, tokens: 400_000 }, mode: 'request-gap',
  }));
  for (let pass = 0; pass < 8; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (resumed() > 0) break;
  }
  assert.ok(resumed() > 0, 'the whole envelope resumes it');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status !== 'BLOCKED', true, 'the node is running again');
  // The provider-level proof of a resumed node belongs to the live case: this
  // fixture scripts the roles' requests but leaves several identities starved, so a
  // request it drives here would prove the fixture's state, not the mechanism. The
  // unit asserts the transition (tokens alone: no resume; tokens + requests: resume),
  // and recovery acceptance verifies that a resumed subtree sends and settles again.
});

test('a settlement that frees capacity resumes the node with no grant at all', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-resume-'));
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
    objective: 'a settlement can be the repair', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator role');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // The pool is 252 tokens short of the request, with an in-flight reservation
  // holding the rest: exactly the recorded shape.
  runtime.store.tx(() => {
    // limit 20,000; an in-flight request holds 8,352 of it, so only 11,648 is
    // available against a 12,000-token need — short by 352, exactly like the run.
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_reserved: 8_352, tokens_spent: 0, requests_limit: 5, requests_spent: 0, requests_reserved: 1 });
    runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'role budget').id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    // Isolate the settlement path from the independent in-node donor path:
    // an idle sibling grant would otherwise legitimately repair this block.
    for (const sibling of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = required(runtime.store.budgetForScope(clusterId, 'agent', sibling.id), 'sibling budget');
      runtime.store.updateBudget(budget.id, { tokens_limit: 0, requests_limit: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: pool.scope_id, dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED', 'the node stopped short of the request');
  runtime.enableScheduling();
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const resumedCount = () => runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'node-resumed').length;
  assert.equal(resumedCount(), 0, 'still short: no resume, and no grant is coming');

  // The in-flight request settles and releases what it did not use.
  runtime.store.tx(() => runtime.store.updateBudget(pool.id, { tokens_reserved: 0, tokens_spent: 8_000, requests_reserved: 0, requests_spent: 0 }));
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (resumedCount() > 0) break;
  }
  const poolAfter = required(runtime.store.getBudget(pool.id), 'pool budget');
  assert.ok(dimensionAvailable(poolAfter, 'tokens') >= envelope.tokens,
    `the settlement released enough: ${dimensionAvailable(poolAfter, 'tokens')}`);
  assert.ok(resumedCount() > 0, 'a released reservation resumes it, with no transfer anywhere');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status !== 'BLOCKED', true, 'and the node runs again');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'budget-rebalanced').length, 0,
    'nothing was transferred to make it happen');
});

test('runUntilSettled waits for an in-flight request to release the capacity it needs', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-loop-'));
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
    objective: 'the settle loop outlives the refusal', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator role');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const nodeBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id), 'node budget');
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // Short by 352 while a request is in flight, and the root stops for it: the shape
  // that ended a live run before the settlement could land.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_reserved: 8_352, tokens_spent: 0, requests_limit: 5, requests_spent: 0, requests_reserved: 1 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'role budget').id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    // Only the settlement can repair this stop. Otherwise an idle sibling grant
    // legitimately reopens it before the in-flight reservation is released.
    for (const sibling of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = required(runtime.store.budgetForScope(clusterId, 'agent', sibling.id), 'sibling budget');
      runtime.store.updateBudget(budget.id, { tokens_limit: 0, requests_limit: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: pool.scope_id, dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED', 'the cluster stopped with the node');
  // An in-flight reservation, exactly as the ledger would hold it.
  runtime.store.tx(() => runtime.store.insertUsageReceipt({
    request_id: 'req-inflight', cluster_id: clusterId, agent_id: role.id, node_id: role.node_id,
    role: 'allocator', kind: 'role', status: 'RESERVED', reservation_tokens: 8_352, budget_scope_id: pool.id,
  }));
  runtime.enableScheduling();
  // The request settles while the settle loop is running — inside its first wait.
  const settleTimer = setTimeout(() => {
    runtime.store.tx(() => {
      runtime.store.updateBudget(pool.id, { tokens_reserved: 0, tokens_spent: 8_000, requests_reserved: 0, requests_spent: 0 });
      runtime.store.settleUsageReceipt('req-inflight', { status: 'SETTLED', total_tokens: 8_000 });
    });
  }, 80);
  t.after(() => clearTimeout(settleTimer));
  const started = Date.now();
  await runtime.runUntilSettled(clusterId, { timeoutMs: 6_000, pollMs: 100 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 80, `the loop did not return on the stop alone: ${elapsed}ms`);
  const eventsAfterTick = runtime.store.readEvents(clusterId, { limit: 500 });
  if (!eventsAfterTick.some(event => event.type === 'node-resumed')) {
    const block = runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' ORDER BY seq DESC LIMIT 1", clusterId)[0];
    const poolAfter2 = required(runtime.store.getBudget(pool.id), 'pool budget');
    const nodeAfter = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
    throw new Error(`no resume even after a tick: block=${block?.data} pool=${JSON.stringify({ tl: poolAfter2.tokens_limit, tr: poolAfter2.tokens_reserved, ts: poolAfter2.tokens_spent, rl: poolAfter2.requests_limit, rs: poolAfter2.requests_spent })} node=${JSON.stringify({ tl: nodeAfter.tokens_limit, ts: nodeAfter.tokens_spent })} cluster=${required(runtime.store.getCluster(clusterId), 'cluster').status}`);
  }
  assert.ok(eventsAfterTick.some(event => event.type === 'node-resumed' && jsonObject(event.data, 'event data').code === 'BUDGET_REPAIRED'),
    'the settlement resumed the node');
  // The reopening is the recorded fact. A turn that changes nothing may legitimately
  // stop again on stagnation — the bound this fixture's fake model runs into — so the
  // assertion is on the recovery, not on the status a moment later.
  assert.ok(eventsAfterTick.some(event => event.type === 'cluster-resumed'),
    `the cluster is reopened by the settlement: ${JSON.stringify(eventsAfterTick.filter(e => e.type === 'cluster-resumed').length)}`);

  // A stop that no settlement can repair still ends the loop immediately.
  runtime.blockClusterInternal(clusterId, 'a mechanism stop', 'MECHANISM');
  const t0 = Date.now();
  await runtime.runUntilSettled(clusterId, { timeoutMs: 6_000, pollMs: 100 });
  assert.ok(Date.now() - t0 < 1_500, 'a non-budget stop is still immediate');
});

test('an overdrawn payer is refilled past its overshoot, pool and identity alike', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-overshoot-'));
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
    objective: 'overshoot must be filled, not clamped away', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator role');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction pool');
  const nodeBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id), 'node budget');
  const agentBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'agent budget').id), 'agent budget');
  // Both payers are overdrawn by a little, exactly as a settlement with actual
  // usage above the reservation leaves them: limit 20,000, spent 20,279.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_spent: 20_279, tokens_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 20_000, tokens_spent: 20_252, tokens_reserved: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 40, requests_spent: 0 });
  });
  const poolGrant = runtime.topUpCompactionPool(clusterId, { tokens: 13_462, model_requests: 1 });
  assert.ok(poolGrant, `the pool is refilled: ${JSON.stringify(poolGrant)}`);
  assert.equal(jsonObject(poolGrant, 'pool grant').tokens, 13_462 + 279, 'its overshoot is part of the gap, not clamped away');
  const poolAfter = required(runtime.store.getBudget(pool.id), 'pool budget');
  assert.ok(dimensionAvailable(poolAfter, 'tokens') >= 13_462,
    `the pool can cover the request that failed: ${dimensionAvailable(poolAfter, 'tokens')}`);

  const agentGrant = runtime.topUpBudgetForAgent(role, { tokens: 12_000, model_requests: 1 });
  assert.ok(agentGrant, `the identity is refilled: ${JSON.stringify(agentGrant)}`);
  assert.equal(jsonObject(agentGrant, 'agent grant').tokens, 12_252, 'including the overshoot it carried');
  const agentAfter = required(runtime.store.getBudget(agentBudget.id), 'agent budget');
  assert.ok(dimensionAvailable(agentAfter, 'tokens') >= 12_000,
    `and can now pay for a request of that size: ${dimensionAvailable(agentAfter, 'tokens')}`);
  // The donor side still clamps at zero: a scope with nothing gives nothing.
  assert.equal(Number(required(runtime.store.getBudget(nodeBudget.id), 'node budget').tokens_limit) >= 0, true, 'the donor stays sane');
});

test('an unpayable budget stop with nothing in flight returns promptly', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-final-'));
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
    objective: 'a final budget stop is final', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const role = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'allocator role');
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // Nothing anywhere can pay it, and nothing is in flight to release capacity.
  runtime.store.tx(() => {
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=?", clusterId)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_spent: Number(required(runtime.store.getBudget(textOf(row.id, 'budget id')), 'budget').tokens_limit), tokens_reserved: 0, requests_spent: Number(required(runtime.store.getBudget(textOf(row.id, 'budget id')), 'budget').requests_limit), requests_reserved: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').scope_id,
    dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED', 'the cluster is stopped');
  assert.equal(required(runtime.store.get("SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND status='RESERVED'", clusterId), 'reserved count').c, 0,
    'and nothing is in flight');
  runtime.enableScheduling();
  const started = Date.now();
  const view = await runtime.runUntilSettled(clusterId, { timeoutMs: 8_000, pollMs: 100 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `it returned promptly instead of waiting out the deadline: ${elapsed}ms`);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED', 'and stayed blocked');
  assert.ok(view, 'with its view');
});

test('a transaction write restriction cannot be widened by an allocation override', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const transactionId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'write under deep/staging', inputs: { write_scope: ['deep/staging'] },
    acceptance_criteria: ['a staging file exists'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: transactionId });

  assert.throws(
    () => command(runtime, allocator, 'allocate_agent', {
      transaction_id: transactionId, write_scope: ['deep/nested'],
    }),
    error => rejectionStatus(error) === 409 && /write scope/.test(messageOf(error)),
    'an Allocator cannot turn a transaction restricted to staging into a grant for nested',
  );
  assert.equal(runtime.store.activeAllocationForTransaction(transactionId), null);
  command(runtime, allocator, 'allocate_agent', { transaction_id: transactionId });
  const allocation = required(runtime.store.activeAllocationForTransaction(transactionId), 'allocation');
  assert.deepEqual(allocation.write_scope, ['deep/staging']);
  assert.equal(checkWriteAccess({
    tool: 'write', workspace: required(runtime.store.getCluster(clusterId), 'cluster').workspace,
    writeScope: allocation.write_scope, writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  }).allowed, false, 'the actual Worker cannot write outside the transaction restriction');
});

test('a delegation instruction carries its write scope all the way down, and the guard enforces it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-delegation-scope-'));
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
    objective: 'the injected scope must reach the deepest level', workspace: dir,
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }, {
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }],
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = (_txId: string | null, nodeId: string | null, objective: string): string => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status: 'READY',
    });
    const delegated = textOf(created.result.transaction_id, 'transaction_id');
    if (nodeId) runtime.store.tx(() => runtime.store.updateTransaction(delegated, { node_id: nodeId }));
    return textOf(command(runtime, allocator, 'spawn_management_node', {
      transaction_id: delegated, node_id: nodeId, objective, acceptance_criteria: ['x'],
    }).result.node_id, 'node_id');
  };
  const level1 = spawn(null, null, 'level one');
  const level2 = spawn(null, level1, 'level two');
  const level3 = spawn(null, level2, 'level three');
  const depth3 = required(runtime.store.getNode(level3), 'level3 node');
  assert.equal(depth3.depth, 3, 'three management levels below the root');
  // The instruction's inputs survive every hop, which is what makes the injected
  // fault land where the case means it to.
  const entries = [level1, level2, level3].map(id => required(runtime.store.getNode(id), 'node').scope?.delegation_entry ?? null);
  const deepestTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3 }), 'deepest transaction');
  // The delegated transaction is created DRAFT (the Orchestrator dispatches it);
  // what matters here is the scope it will be allocated under.
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  assert.deepEqual(required(runtime.store.getNode(level1), 'level1 node').scope?.delegation_entry?.inputs, { write_scope: ['deep/staging'] },
    `the instruction reaches the first level: ${JSON.stringify(entries)}`);
  assert.deepEqual(depth3.scope?.delegation_entry?.inputs, { write_scope: ['deep/staging'] },
    `and the deepest: ${JSON.stringify(entries)}`);
  assert.deepEqual(jsonObject(deepestTx.inputs, 'deepest transaction inputs').write_scope, ['deep/staging'], 'and its transaction works under that scope');

  // This transaction belongs to the terminal management node. A Worker must
  // run as that node's child (depth 4, within the actual depth cap).
  const deepestAllocator = actorFor(runtime, clusterId, 'allocator', level3);
  command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id });
  const allocation = runtime.store.activeAllocationForTransaction(deepestTx.id);
  assert.ok(allocation, 'the Worker is allocated');
  const workerNode = required(runtime.store.getNode(required(runtime.store.getAgent(allocation.agent_id), 'worker agent').node_id), 'worker node');
  assert.equal(workerNode.parent_id, level3);
  assert.equal(workerNode.depth, 4);
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const denied = checkWriteAccess({
    tool: 'write', workspace: cluster.workspace,
    writeScope: allocation.write_scope, writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  });
  assert.equal(denied.allowed, false, `the guard refuses the target path: ${JSON.stringify(denied)}`);
});

