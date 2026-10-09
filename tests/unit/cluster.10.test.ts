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

import { fixtureParams } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { checkWriteAccess } from '../../packages/dsh-flow/src/core/scope.ts';
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
  const snapshot = runtime.start({
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

test('a child is funded from the capacity its own node is holding in idle roles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-parentreclaim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the parent holds it in its roles', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tool_calls: 4_096, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  // The shape the run ended on: the node's own file is spent, its roles hold the
  // requests and are between turns.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tool_calls_limit: 33, tool_calls_spent: 33, tool_calls_reserved: 0 });
    roles.forEach((agent, index) => {
      runtime.store.updateBudget(required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'role budget').id, {
        tool_calls_limit: 96 - index * 20, tool_calls_spent: 10, tool_calls_reserved: 0,
      });
    });
  });
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate to a child', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = textOf(created.result.transaction_id, 'transaction_id');
  const spawned = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: delegatedId, objective: 'a child that must run', acceptance_criteria: ['x'],
  });
  const childId = textOf(spawned.result.node_id, 'node_id');
  const childBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', childId), 'child budget').id), 'child budget');
  const roleGrants = firstOf(runtime.store.all(
    "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", childId), 'role grants').c;
  assert.ok(Number(childBudget.tool_calls_limit) + Number(roleGrants) >= 30,
    `the child got a working file from the parent's own roles: ${childBudget.tool_calls_limit} + ${roleGrants}`);
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
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a repaired shortfall is not a refusal', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 }), 'orchestrator agent');
  const facts = { scope: 'scope-x', dimension: 'tool_calls', requested: 12_000, available: 0 };
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
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the injected scope must reach the deepest level', workspace: dir,
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
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
    return textOf(command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
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

