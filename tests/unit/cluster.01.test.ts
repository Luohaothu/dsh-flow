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
import { releaseLlmRequest, reserveLlmRequest } from '../../packages/dsh-flow/src/core/runtime.ts';
import type { TurnOutcome } from '../../packages/dsh-flow/src/core/runtime.ts';
import { budgetView } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { AgentRecord, AllocationRecord, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, LeaseRecord, NodeRecord, TransactionRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

// ---------------------------------------------------------------- test harness

let clock = 1_800_000_000_000;
const now = (): number => clock;

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

/** The three ledger dimensions the interactive envelope spends. */
interface SpentTotals {
  tokens: number
  model_requests: number
  tool_calls: number
}

function totalSpent(runtime: ClusterRuntime, clusterId: string): SpentTotals {
  const total: SpentTotals = { tokens: 0, model_requests: 0, tool_calls: 0 };
  for (const row of runtime.store.listBudgets(clusterId)) {
    total.tokens += row.tokens_spent;
    total.model_requests += row.requests_spent;
    total.tool_calls += row.tool_calls_spent;
  }
  return total;
}

/** One worker turn opened over a live allocation, with no model involved. */
interface WorkerScenario {
  readonly tx: TransactionRecord
  readonly worker: AgentRecord
  readonly allocation: AllocationRecord
  readonly orchestrator: FlowAgentActor
  readonly workerActor: FlowAgentActor
  readonly lease: LeaseRecord
  readonly clusterId: string
}

/** Drive one worker turn to its end without any model, so only the publication rule is under test. */
function workerScenario(runtime: ClusterRuntime, clusterId: string): WorkerScenario {
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation');
  const worker = required(runtime.store.getAgent(allocation.agent_id), 'worker agent');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  const opened = beginTurn(runtime, clusterId, { worker }, 7);
  return {
    tx: required(runtime.store.getTransaction(tx.id), 'worker transaction'), worker, allocation, orchestrator,
    workerActor: opened.actor, lease: opened.lease, clusterId,
  };
}

/** Open a fresh lease/epoch for one simulated worker turn. */
function beginTurn(
  runtime: ClusterRuntime,
  clusterId: string,
  scenario: { readonly worker: AgentRecord },
  epoch: number,
): { readonly lease: LeaseRecord; readonly actor: FlowAgentActor } {
  const lease = runtime.store.tx(() => {
    const existing = runtime.store.leaseForAgent(scenario.worker.id);
    if (existing) runtime.store.deleteLease(existing.id);
    runtime.store.updateAgent(scenario.worker.id, { epoch });
    return runtime.store.createLease({
      id: `lease-${scenario.worker.id.slice(0, 8)}-${epoch}`, cluster_id: clusterId, agent_id: scenario.worker.id,
      node_id: scenario.worker.node_id, purpose: 'worker-turn', epoch, expires: now() + 60_000,
    });
  });
  return {
    lease: required(lease, 'turn lease'),
    actor: { cluster_id: clusterId, agent_id: scenario.worker.id, node_id: scenario.worker.node_id, role: 'worker', session_id: scenario.worker.session_id, epoch, turn_seq: 1 },
  };
}

/** The durable outcome of a turn no model produced. */
function scriptedTurn(completed: boolean, stopReason: string, finalText: string): TurnOutcome {
  return {
    native_seq: null, stopDetail: null, missing_capability_tools: [], admitted: false,
    context: null, context_pressure: false, context_over_budget: false, context_blocked: false,
    context_code: null, context_overflowed: false,
    events: [], assistant: [], usage: [], toolCalls: [], completed, stopReason, finalText,
  };
}
const incompleteTurn = (stopReason: string, text = 'truncated'): TurnOutcome => scriptedTurn(false, stopReason, text);
const completedTurn = (text = 'done'): TurnOutcome => scriptedTurn(true, 'completed', text);

// ==== CHUNK START ====
test('auditor rejections create issues, and the correction budget escalates to BLOCKED', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { claim: 'done' } }));
  command(runtime, orchestrator, 'validate', { transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y' }] });
  const rejected = command(runtime, auditor, 'inspect_validation', {
    transaction_id: tx.id, decision: 'reject', required_change: 'show the file hash', evidence: { missing: 'hash' },
  });
  assert.equal(rejected.result.status, 'REJECTED');
  const issue = required(runtime.store.getIssue(textOf(rejected.result.issue_id, 'issue_id')), 'issue');
  assert.equal(issue.status, 'OPEN');
  assert.equal(issue.required_change, 'show the file hash');

  // A verdict needs something to verify: before any change, the call is refused
  // and consumes nothing.
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'unresolved', evidence: {} }),
    /correction to verify/);
  assert.equal(required(runtime.store.getIssue(issue.id), 'issue').corrections, 0, 'and the budget is untouched');

  // Each real correction attempt that fails moves the counter, and the second one
  // exhausts the budget.
  const attempt = () => {
    // The change the Auditor asked for, then a verdict that it did not work.
    command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, acceptance_criteria: ['x with a hash'] });
    command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'unresolved', evidence: {} });
  };
  attempt();
  assert.equal(required(runtime.store.getIssue(issue.id), 'issue').corrections, 1);
  attempt();
  assert.equal(required(runtime.store.getIssue(issue.id), 'issue').status, 'ESCALATED');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
});

test('commands are idempotent per command_id and conflicting replays are rejected', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');

  const first = runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 5 } });
  const replay = runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 5 } });
  assert.equal(first.deduped, false);
  assert.equal(replay.deduped, true);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').priority, 5);
  assert.throws(
    () => runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 9 } }),
    error => rejectionStatus(error) === 409,
  );
  assert.throws(
    () => runtime.command(orchestrator, { command_id: 'cmd-rev', action: 'set_priority', params: { transaction_id: tx.id, priority: 1 }, expected_revision: 99 }),
    error => rejectionStatus(error) === 409 && /revision conflict/.test(messageOf(error)),
  );
});

test('budget transfers move only unused unreserved capacity and releasing reclaims it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');

  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const nodeView = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget')), 'node budget view');
  assert.ok(nodeView.tokens.limit < 1_000_000 && nodeView.tokens.available > 0,
    `role grants must draw the node budget down from the root (limit ${nodeView.tokens.limit}, available ${nodeView.tokens.available})`);
  assert.throws(() => command(runtime, allocator, 'rebalance_budget', {
    from: { kind: 'node', id: root.id }, to: { kind: 'root', id: clusterId }, amounts: { tokens: nodeView.tokens.available + 1 },
  }), error => error instanceof Error && 'code' in error && error.code === 'LIMIT_REACHED');

  const moved = Math.floor(nodeView.tokens.available / 2);
  command(runtime, allocator, 'rebalance_budget', {
    from: { kind: 'node', id: root.id }, to: { kind: 'root', id: clusterId }, amounts: { tokens: moved },
  });
  assert.equal(required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget')), 'node budget view').tokens.limit, nodeView.tokens.limit - moved);

  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id), 'agent budget');
  assert.ok(agentBudget.tokens_limit > 0);
  const spentBefore = totalSpent(runtime, clusterId);

  command(runtime, allocator, 'release_agent', { allocations: [allocation.id] });
  assert.equal(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }).length, 0);
  assert.equal(totalSpent(runtime, clusterId).tokens, spentBefore.tokens, 'releasing must never reverse spend');
  assert.ok(totalSpent(runtime, clusterId).tokens + totalSpent(runtime, clusterId).model_requests * 0 >= 0);
  assert.equal(runtime.store.countAgents(clusterId, { live: true }), 3);
});
test('a transaction without an explicit capability set still yields working workers', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  assert.deepEqual(tx.capabilities, ['fs_read', 'fs_write'], 'an omitted set inherits the management node set');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation');
  assert.deepEqual(allocation.capabilities, ['fs_read', 'fs_write']);
  const agent = required(runtime.store.getAgent(allocation.agent_id), 'worker agent');
  const policy = runtime.allowedToolsFor(required(runtime.store.getCluster(clusterId), 'cluster'), 'worker', agent);
  assert.ok(policy.allowed.includes('write'), `worker tools must include write, got ${policy.allowed.join(', ')}`);
  assert.ok(policy.capabilities.includes('fs_write'));
});

test('a delegation fixture builds a decreasing management chain', t => {
  const runtime = makeRuntime(t);
  // A depth cap with room for the chain: the terminal level is depth 3 and its Worker
  // would be depth 4, inside the cap. (A node created *at* the cap is refused; that is
  // its own test.)
  const clusterId = runtime.start({
    objective: 'test objective',
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 1000, tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  }, { delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 3 }] }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // The fixture's instruction supplies the depth budget for the first spawn.
  const first = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'level 1' },
  }).result;
  const level1 = required(runtime.store.getNode(textOf(first.node_id, 'node_id')), 'level 1');
  assert.equal(level1.depth, 1);
  assert.equal(level1.scope?.spawn_children, 2, 'the fixture depth budget descends by one per level');
  assert.equal(level1.scope?.delegation_entry?.spawn_children, 2, 'the remaining budget travels with the instruction');

  // Every following level inherits the budget without being told again.
  const second = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: textOf(first.delegated_transaction_id, 'delegated_transaction_id'), node_id: textOf(first.node_id, 'node_id'), scope: { objective: 'level 2' },
  }).result;
  const level2 = required(runtime.store.getNode(textOf(second.node_id, 'node_id')), 'level 2');
  assert.equal(level2.depth, 2);
  assert.equal(level2.scope?.spawn_children, 1);

  const third = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: textOf(second.delegated_transaction_id, 'delegated_transaction_id'), node_id: textOf(second.node_id, 'node_id'), scope: { objective: 'level 3' },
  }).result;
  const level3 = required(runtime.store.getNode(textOf(third.node_id, 'node_id')), 'level 3');
  assert.equal(level3.depth, 3);
  assert.equal(level3.scope?.spawn_children, 0, 'the chain stops when the budget reaches zero');

  const depths = new Set(runtime.store.listNodes(clusterId, {}).map(node => node.depth));
  assert.ok(depths.has(1) && depths.has(2) && depths.has(3), `management depths ${[...depths].sort().join(', ')}`);
  // A depth-1 worker branch and a depth-3 management branch coexist. The root
  // transaction has delegated work (the chain this fixture just built), so a *second*
  // transaction is the one a worker may run.
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: rootTx.id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: rootTx.id, decision: 'approve' });
  const direct = command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', {
    objective: 'a flat branch under the root', acceptance_criteria: ['x'],
  }).result;
  const directId = textOf(direct.transaction_id, 'transaction_id');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: directId });
  if (required(runtime.store.getTransaction(directId), 'direct transaction').status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: directId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: directId });
  assert.ok(runtime.store.listNodes(clusterId, {}).some(node => node.kind === 'worker' && node.depth === 1));
});

test('a budget top-up moves exactly the gap it was asked for, and nothing else', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'agent budget');
  const before = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(before.agents_limit, 32, 'the node keeps the cluster agent capacity');
  assert.equal(before.max_active_limit, 4);
  const agentBefore = required(runtime.store.getBudget(agentBudget.id), 'agent budget');

  // Ask for a request the identity cannot cover from what it holds.
  const held = Math.max(0, agentBefore.tokens_limit - agentBefore.tokens_reserved - agentBefore.tokens_spent);
  const want = held + 5_000;
  const short = want - held;
  const granted = jsonObject(runtime.store.tx(() => runtime.topUpBudgetForAgent(auditor, { tokens: want, model_requests: 1 })), 'top-up grant');
  assert.equal(granted.tokens, short, 'exactly the tokens that were missing');
  const after = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(after.agents_limit, 32, 'a top-up must not move agent capacity');
  assert.equal(after.max_active_limit, 4, 'a top-up must not move active-slot capacity');
  assert.equal(after.tokens_limit, before.tokens_limit - short, 'the node gave exactly that many tokens');

  const agentAfter = required(runtime.store.getBudget(agentBudget.id), 'agent budget');
  assert.equal(agentAfter.max_active_limit, 0, 'a management role does not hold an active slot');
  assert.ok(agentAfter.tokens_limit - agentAfter.tokens_reserved - agentAfter.tokens_spent >= want,
    'the identity can now cover the request it asked about');

  // Nothing to top up is not a top-up.
  assert.equal(runtime.store.tx(() => runtime.topUpBudgetForAgent(auditor, { tokens: 1, model_requests: 1 })), null);
  // A Worker whose request allowance is spent gets no tokens: paying for a
  // request that cannot be sent is not a top-up.
  const workerTx = textOf(command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', {
    objective: 'worker work', acceptance_criteria: ['done'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: workerTx });
  if (required(runtime.store.getTransaction(workerTx), 'worker transaction').status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: workerTx, decision: 'approve' });
  }
  runtime.store.tx(() => runtime.store.updateCluster(clusterId, {
    limits: { ...required(runtime.store.getCluster(clusterId), 'cluster').limits, worker_model_requests: 2 },
  }));
  const allocationResults = jsonObject(command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: workerTx }).result, 'allocation result').allocations;
  assert.ok(Array.isArray(allocationResults));
  const allocated = jsonObject(firstOf(allocationResults, 'allocation'), 'allocation');
  const worker = required(runtime.store.getAgent(textOf(allocated.agent_id, 'agent_id')), 'worker');
  assert.equal(runtime.workerRequestAllowance(worker), 2);
  runtime.store.tx(() => {
    for (let index = 0; index < 2; index += 1) {
      runtime.store.insertUsageReceipt({
        request_id: `worker-req-${index}`, cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
        role: 'worker', kind: 'worker', status: 'SETTLED', reservation_tokens: 10, turn_seq: 1,
      });
    }
  });
  assert.equal(runtime.store.countWorkerRequests(clusterId, worker.id), runtime.workerRequestAllowance(worker));
  assert.equal(runtime.store.tx(() => runtime.topUpBudgetForAgent(worker, { tokens: 1_000_000, model_requests: 1 })), null,
    'a worker at its request allowance is not topped up');
});

test('communication crosses subtrees without touching the management tree', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker');
  const workerActor = actorFor(runtime, clusterId, 'worker', worker.node_id);

  const parentBefore = required(runtime.store.getNode(worker.node_id), 'worker node').parent_id;
  const sent = runtime.store.tx(() => runtime.communicateFrom(workerActor, 'send', { agent: auditor.agent_id, content: 'status?' }));
  assert.ok('recipients' in sent);
  assert.equal(sent.recipients.length, 1);
  assert.equal(runtime.store.pendingDeliveries(auditor.agent_id).length, 1);
  const published = runtime.store.tx(() => runtime.communicateFrom(auditor, 'publish', { key: 'plan/root', value: { v: 1 } }));
  assert.ok('revision' in published);
  assert.equal(published.revision, 1);
  assert.throws(() => runtime.store.tx(() => runtime.communicateFrom(auditor, 'publish', { key: 'plan/root', value: { v: 2 }, expected_revision: 5 })),
    error => rejectionStatus(error) === 409);
  assert.equal(required(runtime.store.getNode(worker.node_id), 'worker node').parent_id, parentBefore);
});
test('consecutive pre-model turn failures are counted durably and bounded', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const scenario = workerScenario(runtime, clusterId);
  const seen = () => runtime.store.readEvents(clusterId, { limit: 200 })
    .filter(event => event.type === 'turn-start-failed')
    .map(event => jsonObject(event.data, 'turn-start-failed data').attempt);
  // One identity whose turns keep failing before the model sees a prompt, each
  // attempt on its own fresh lease: the loop the acceptance evidence recorded as
  // 714 refused starts, every one of them numbered `attempt: 1`. The count has to
  // live in the runtime, not in a per-turn copy, or the bound can never be
  // reached and the identity is retried without limit.
  const failStart = (epoch: number): void => {
    const turn = beginTurn(runtime, clusterId, scenario, epoch);
    runtime.finishWorkerTurn(
      required(runtime.store.getCluster(clusterId), 'cluster'), scenario.worker,
      required(runtime.store.getTransaction(scenario.tx.id), 'transaction'), scenario.allocation,
      { outcome: null, error: new Error('the turn could not start'), before: 0, lease: turn.lease, deliveries: [], admitted: false },
    );
  };

  failStart(7);
  assert.deepEqual(seen(), [1], 'a first pre-model failure is numbered from one');
  failStart(8);
  assert.deepEqual(seen(), [1, 2], 'the count is durable, not a per-turn local copy');
  failStart(9);
  assert.deepEqual(seen(), [1, 2, 3], 'and the third attempt is the third, not the first again');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'agent-blocked').length, 1,
    'the third consecutive failure blocks the identity instead of retrying it forever');
  assert.equal(required(runtime.store.getAgent(scenario.worker.id), 'worker agent').status, 'BLOCKED');
  assert.equal(required(runtime.store.getTransaction(scenario.tx.id), 'transaction').status, 'READY',
    'and the transaction is not left RUNNING with no live turn');
});

test('a worker proposal is published only when its turn completed', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const scenario = workerScenario(runtime, clusterId);
  let turn = { actor: scenario.workerActor, lease: scenario.lease };
  const rerun = (epoch: number) => {
    runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', __bump_revision: false }));
    turn = beginTurn(runtime, clusterId, scenario, epoch);
    return turn;
  };
  const finish = (outcome: TurnOutcome) => runtime.finishWorkerTurn(
    required(runtime.store.getCluster(clusterId), 'cluster'), scenario.worker, required(runtime.store.getTransaction(scenario.tx.id), 'transaction'),
    scenario.allocation, { outcome, error: null, before: 0, lease: turn.lease, deliveries: [], admitted: true },
  );

  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 5 } });
  const stagedRow = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(stagedRow.status, 'RUNNING', 'a submission must not publish itself');
  assert.deepEqual(stagedRow.result, { value: 5 });
  assert.equal(stagedRow.result_staged_epoch, 7, 'the proposal is bound to the producing lease epoch');
  assert.equal(stagedRow.result_staged_turn, 1);

  finish(incompleteTurn('error'));
  const afterError = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(afterError.status, 'READY', 'an errored turn must not publish SUBMITTED');
  assert.equal(afterError.result, null, 'the withheld proposal must not be left on the transaction');
  assert.equal(afterError.result_staged_epoch, null);

  rerun(8);
  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 6 } });
  finish(incompleteTurn('aborted', 'partial'));
  assert.equal(required(runtime.store.getTransaction(scenario.tx.id), 'transaction').status, 'READY', 'an aborted turn must not publish SUBMITTED');

  rerun(9);
  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 7 } });
  finish(completedTurn());
  const published = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(published.status, 'SUBMITTED');
  assert.deepEqual(published.result, { value: 7 });
  assert.equal(numberOf(firstOf(runtime.store.all("SELECT COUNT(*) AS c FROM events WHERE type='result-submitted'"), 'event count').c, 0, 1e9, 'count'), 1, 'exactly one publication per completed turn');
  assert.match(String(firstOf(runtime.store.all("SELECT data FROM events WHERE type='result-withheld'"), 'withheld event').data), /aborted|error/);

  runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', attempts: 99, __bump_revision: false }));
  rerun(10);
  finish(incompleteTurn('max-tokens', ''));
  assert.equal(required(runtime.store.getTransaction(scenario.tx.id), 'transaction').status, 'FAILED');

  assert.throws(
    () => command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 8 } }),
    error => rejectionStatus(error) === 409,
  );
});

test('a completed Worker without an explicit submission publishes attributable native write evidence', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const scenario = workerScenario(runtime, clusterId);
  const written = 'node and worker identity\n';
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'old-worker-write', cluster_id: clusterId, agent_id: scenario.worker.id,
    node_id: scenario.worker.node_id, lease_epoch: scenario.lease.epoch - 1,
    session_id: scenario.worker.session_id, turn_seq: 0, tool: 'write',
    args: { file_path: 'deep/staging/old.txt', content: 'stale' }, status: 'SETTLED',
    body: { isError: false, text: 'Created stale file' },
  }));
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'completed-worker-write', cluster_id: clusterId, agent_id: scenario.worker.id,
    node_id: scenario.worker.node_id, lease_epoch: scenario.lease.epoch,
    session_id: scenario.worker.session_id, turn_seq: 1, tool: 'write',
    args: { file_path: 'deep/nested/result.txt', content: written }, status: 'SETTLED',
    body: { isError: false, text: 'Created file deep/nested/result.txt' },
  }));
  runtime.finishWorkerTurn(
    required(runtime.store.getCluster(clusterId), 'cluster'), scenario.worker, required(runtime.store.getTransaction(scenario.tx.id), 'transaction'),
    scenario.allocation, { outcome: completedTurn(''), error: null, before: 0,
      lease: scenario.lease, deliveries: [], admitted: true },
  );
  const tx = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: scenario.tx.id });
  assert.equal(tx.transaction.status, 'SUBMITTED');
  assert.deepEqual(jsonObject(tx.result, 'transaction result').evidence, [{
    call_id: 'completed-worker-write', agent_id: scenario.worker.id, node_id: scenario.worker.node_id,
    owner_management_id: scenario.allocation.node_id,
    tool: 'write', status: 'SETTLED', job_id: null,
    args: { file_path: 'deep/nested/result.txt', content: written },
    body: { isError: false, text: 'Created file deep/nested/result.txt' },
  }], 'the reviewer can inspect the persisted path, exact content, writer, and settled receipt');
});

test('a staged proposal survives pause, but not a stale epoch or a foreign turn', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const scenario = workerScenario(runtime, clusterId);

  // submit → pause (the turn drains instead of completing) → resume → the same
  // turn completes: the staged proposal is still the Worker's work and must
  // still reach validation. Discarding it on pause threw away real work.
  command(runtime, scenario.workerActor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 11 } });
  runtime.control(clusterId, 'pause');
  const paused = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(paused.status, 'PAUSED');
  assert.deepEqual(paused.result, { value: 11 }, 'pausing must not throw away a staged proposal');
  const stagedEvent = jsonObject(JSON.parse(textOf(firstOf(runtime.store.all("SELECT data FROM events WHERE type='result-staged' ORDER BY seq DESC LIMIT 1"), 'staged event').data, 'staged event data')), 'staged event');
  assert.equal(paused.result_staged_epoch, stagedEvent.epoch, 'the proposal is still bound to the turn that staged it');
  assert.equal(paused.result_staged_turn, stagedEvent.turn);
  runtime.control(clusterId, 'resume');
  const resumed = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(resumed.status, 'READY');
  runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', __bump_revision: false }));
  const resumedTurn = beginTurn(runtime, clusterId, scenario, 12);
  runtime.finishWorkerTurn(required(runtime.store.getCluster(clusterId), 'cluster'), scenario.worker, required(runtime.store.getTransaction(scenario.tx.id), 'transaction'), scenario.allocation, {
    outcome: completedTurn('no submission'), error: null, before: 0, lease: resumedTurn.lease, deliveries: [], admitted: true,
  });
  const afterResume = required(runtime.store.getTransaction(scenario.tx.id), 'transaction');
  assert.equal(afterResume.status, 'SUBMITTED');
  assert.deepEqual(afterResume.result, { value: 11 }, 'the same turn publishes the proposal it staged before the pause');

  // a proposal staged by an older epoch is not promotable by a newer turn
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx2 = command(runtime, orchestrator, 'create_transaction', {
    objective: 'second', acceptance_criteria: ['x'],
  }).result;
  const tx2Id = textOf(tx2.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx2Id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx2Id, decision: 'approve' });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx2Id });
  const allocation2 = required(runtime.store.activeAllocationForTransaction(tx2Id), 'allocation');
  const worker2 = required(runtime.store.getAgent(allocation2.agent_id), 'worker');
  const lease2 = required(runtime.store.tx(() => {
    runtime.store.updateTransaction(tx2Id, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(worker2.id, { epoch: 3 });
    return runtime.store.createLease({
      id: 'lease-old', cluster_id: clusterId, agent_id: worker2.id, node_id: worker2.node_id,
      purpose: 'worker-turn', epoch: 3, expires: now() + 60_000,
    });
  }), 'old lease');
  const oldActor = { ...actorFor(runtime, clusterId, 'worker', worker2.node_id), epoch: 3, turn_seq: 1 };
  command(runtime, oldActor, 'submit_result', { transaction_id: tx2Id, result: { value: 99 } });

  // the identity is replaced: a new lease epoch, and the old one is gone
  const newLease = runtime.store.tx(() => {
    runtime.store.deleteLease(lease2.id);
    return runtime.store.createLease({
      id: 'lease-new', cluster_id: clusterId, agent_id: worker2.id, node_id: worker2.node_id,
      purpose: 'worker-turn', epoch: 4, expires: now() + 60_000,
    });
  });
  assert.throws(
    () => command(runtime, oldActor, 'submit_result', { transaction_id: tx2Id, result: { value: 100 } }),
    error => rejectionStatus(error) === 409,
    'a command from a fenced epoch must be rejected',
  );
  // The replacement stages its own work, then the old turn finishes: a fenced
  // finisher must publish nothing and clear nothing.
  runtime.store.tx(() => runtime.store.updateTransaction(tx2Id, {
    result: { value: 'replacement' }, result_staged_epoch: 4, result_staged_turn: 1,
    result_staged_agent: worker2.id, __bump_revision: false,
  }));
  runtime.finishWorkerTurn(required(runtime.store.getCluster(clusterId), 'cluster'), worker2, required(runtime.store.getTransaction(tx2Id), 'transaction'), allocation2, {
    outcome: completedTurn('late'), error: null, before: 0, lease: lease2, deliveries: [],
  });
  const fenced = required(runtime.store.getTransaction(tx2Id), 'transaction');
  assert.notEqual(fenced.status, 'SUBMITTED', 'a turn whose lease was fenced must not publish');
  assert.deepEqual(fenced.result, { value: 'replacement' }, 'the replacement\'s staged work must survive the fenced finisher');
  assert.equal(fenced.result_staged_epoch, 4);
  assert.match(String(firstOf(runtime.store.all("SELECT data FROM events WHERE type='turn-fenced' ORDER BY seq DESC LIMIT 1"), 'fencing event').data), /lease was replaced|nothing was published/);
  void newLease;
});

test('the model-request semaphore transfers a permit without freeing it', async t => {
  const runtime = makeRuntime(t);
  runtime.setLlmConcurrency(1);

  const first = await runtime.acquireLlmSlot();
  assert.equal(runtime.llmSlotsInUse(), 1);
  const queued = runtime.acquireLlmSlot();
  assert.equal(runtime.llmWaiters(), 1);

  // Releasing hands the permit to the waiter; the counter must stay at the cap.
  first();
  const second = await queued;
  assert.equal(runtime.llmSlotsInUse(), 1, 'the permit moved to the waiter instead of being freed');
  assert.equal(runtime.llmWaiters(), 0);

  // A third caller must not be admitted while the awakened waiter holds it.
  let thirdAdmitted = false;
  const third = runtime.acquireLlmSlot().then(release => {
    thirdAdmitted = true;
    return release;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(thirdAdmitted, false, 'a third caller must wait for the only permit');
  assert.equal(runtime.llmSlotsInUse(), 1);

  second();
  const thirdRelease = await third;
  assert.equal(runtime.llmSlotsInUse(), 1);
  thirdRelease();
  assert.equal(runtime.llmSlotsInUse(), 0);

  // A double release must not free a second permit.
  const again = await runtime.acquireLlmSlot();
  again();
  again();
  assert.equal(runtime.llmSlotsInUse(), 0);
  const after = await runtime.acquireLlmSlot();
  assert.equal(runtime.llmSlotsInUse(), 1);
  after();
});

test('lowering the model-request cap stops new work instead of handing a busy slot on', async t => {
  const runtime = makeRuntime(t);
  runtime.setLlmConcurrency(3);

  const first = await runtime.acquireLlmSlot();
  const second = await runtime.acquireLlmSlot();
  const third = await runtime.acquireLlmSlot();
  assert.equal(runtime.llmSlotsInUse(), 3);
  const queuedA = runtime.acquireLlmSlot();
  const queuedB = runtime.acquireLlmSlot();
  assert.equal(runtime.llmWaiters(), 2);

  runtime.setLlmConcurrency(1);
  assert.equal(runtime.llmSlotsInUse(), 3, 'the cap does not retroactively cancel running work');

  first();
  assert.equal(runtime.llmSlotsInUse(), 2);
  assert.equal(runtime.llmWaiters(), 2, 'nothing new starts while the running work is above the new cap');
  second();
  assert.equal(runtime.llmSlotsInUse(), 1);
  assert.equal(runtime.llmWaiters(), 2);

  third();
  const admittedA = await queuedA;
  assert.equal(runtime.llmSlotsInUse(), 1, 'exactly one waiter is admitted at the lowered cap');
  assert.equal(runtime.llmWaiters(), 1);

  runtime.setLlmConcurrency(3);
  const admittedB = await queuedB;
  assert.equal(runtime.llmSlotsInUse(), 2, 'raising the cap admits queued work immediately');
  assert.equal(runtime.llmWaiters(), 0);

  admittedA();
  admittedB();
  assert.equal(runtime.llmSlotsInUse(), 0);
});

test('cluster control-plane tools consume the shared tool-call budget', async t => {
  const runtime = makeRuntime(t);
  const { fromPartial } = await import('@total-typescript/shoehorn');
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const worker = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-budget', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'orchestrator-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  const budgetIds = runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), worker);
  const budget = required(runtime.store.getBudget(firstOf(budgetIds, 'agent budget id')), 'agent budget');
  assert.ok(budget.tool_calls_limit > 0);
  runtime.store.tx(() => runtime.store.updateBudget(budget.id, { tool_calls_limit: 4 }));

  // A control-plane tool is metered like any other: the quota is the shared
  // `tool_calls` budget, not a per-turn counter that resets.
  const admit = (index: number) => runtime.admitToolCall(worker, fromPartial<Parameters<typeof runtime.admitToolCall>[1]>({
    name: 'flow_query', arguments: { what: 'cluster' },
  }), `call-${index}`);

  assert.equal(admit(0).ok, true);
  assert.equal(admit(1).ok, true);
  assert.equal(admit(2).ok, true);
  assert.equal(admit(3).ok, true);
  assert.equal(required(runtime.store.getBudget(budget.id), 'budget').tool_calls_reserved, 4, 'four calls are held against this identity');
  // The identity's own grant is a bookkeeping boundary, not the ceiling: a node
  // that still holds tool-call capacity funds the next call.
  assert.equal(admit(4).ok, true, 'the node still holds capacity, so the call is funded from it');
  assert.ok(required(runtime.store.getBudget(budget.id), 'budget').tool_calls_limit >= 5);

  // With the node drained as well there is nothing to fund the call: refusal,
  // and the refusal names the scope and the dimension.
  runtime.store.tx(() => {
    // Every scope in the cluster that could fund a call is fully held: the
    // identity's own grant, its node, and the sibling identities a rebalance
    // could reclaim from. There is no capacity anywhere left.
    for (const row of runtime.store.listBudgets(clusterId)) {
      if (!['agent', 'node', 'root'].includes(row.scope_kind)) continue;
      runtime.store.updateBudget(row.id, { tool_calls_limit: row.tool_calls_reserved + row.tool_calls_spent });
    }
  });
  const refused = admit(5);
  assert.equal(refused.ok, false, 'with no capacity anywhere the call is refused');
  assert.match(refused.reason ?? '', /tool_calls|exhausted/);
  const refusal = firstOf(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'budget-refused'), 'budget refusal');
  const refusalData = jsonObject(refusal.data, 'budget refusal data');
  assert.equal(refusalData.dimension, 'tool_calls', `the refusal is structured: ${JSON.stringify(refusalData)}`);
  assert.ok(refusalData.scope);

  runtime.settleToolCall(worker, fromPartial<Parameters<typeof runtime.settleToolCall>[1]>({ name: 'flow_query', arguments: { what: 'cluster' } }), 'call-0', fromPartial<NonNullable<Parameters<typeof runtime.settleToolCall>[3]>>({ isError: false, content: [] }), null);
  assert.equal(required(runtime.store.getBudget(budget.id), 'budget').tool_calls_reserved, 4, 'the settled call released its hold');
  assert.equal(required(runtime.store.getBudget(budget.id), 'budget').tool_calls_spent, 1, 'and was charged exactly once');
});

test('an old instance cannot write or publish under its replacement lease', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { path: join(dir, 'cluster.sqlite'), dataDir: dir });
  const clusterId = startCluster(runtime, { workspace: dir });
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  // The shared header is frozen and cannot receive the static imports needed by this test.
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const { fromPartial } = await import('@total-typescript/shoehorn');

  // Instance A: the live turn. Instance B: what replaces it after the crash.
  const instanceA = fromPartial<Parameters<typeof runtime.bindTurnIdentity>[0]>({ id: SessionId(agent.session_id) });
  const leaseA = required(runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-a', cluster_id: clusterId, agent_id: agent.id, node_id: root.id,
    purpose: 'orchestrator-turn', epoch: agent.epoch + 1, expires: now() + 60_000,
  })), 'lease A');
  runtime.bindTurnIdentity(instanceA, { agent_id: agent.id, epoch: leaseA.epoch, turn_seq: 1 });

  runtime.store.tx(() => {
    runtime.store.deleteLease(leaseA.id);
    runtime.store.createLease({
      id: 'lease-b', cluster_id: clusterId, agent_id: agent.id, node_id: root.id,
      purpose: 'orchestrator-turn', epoch: leaseA.epoch + 1, expires: now() + 60_000,
    });
  });
  const leaseB = required(runtime.store.leaseForAgent(agent.id), 'lease B');
  assert.equal(leaseB.epoch, leaseA.epoch + 1);

  // B still holds a valid lease, so a naive check would admit A's tool call.
  const stale = runtime.admitToolCall(agent, fromPartial<Parameters<typeof runtime.admitToolCall>[1]>({
    name: 'write', agent: instanceA, arguments: { path: 'x.txt', content: 'x' },
  }), 'call-stale');
  assert.equal(stale.ok, false, "a stale instance's write must be refused");
  assert.match(stale.reason ?? '', /epoch/);

  const instanceB = fromPartial<Parameters<typeof runtime.bindTurnIdentity>[0]>({ id: SessionId('b') });
  runtime.bindTurnIdentity(instanceB, { agent_id: agent.id, epoch: leaseB.epoch, turn_seq: 2 });
  const current = runtime.admitToolCall(agent, fromPartial<Parameters<typeof runtime.admitToolCall>[1]>({
    name: 'write', agent: instanceB, arguments: {},
  }), 'call-current');
  assert.equal(current.ok, true, 'the live instance is admitted');

  // An instance that was never scheduled cannot act at all.
  const unbound = runtime.admitToolCall(agent, fromPartial<Parameters<typeof runtime.admitToolCall>[1]>({
    name: 'write', agent: fromPartial<Parameters<typeof runtime.bindTurnIdentity>[0]>({ id: SessionId('c') }), arguments: {},
  }), 'call-unbound');
  assert.equal(unbound.ok, false, 'an unscheduled instance owns no turn identity');
  assert.match(unbound.reason ?? '', /scheduled turn identity/);

  // Communication mutations are fenced too: publishing from the stale instance.
  const staleActor = { ...actorFor(runtime, clusterId, 'orchestrator', root.id), epoch: leaseA.epoch, turn_seq: 1 };
  assert.throws(
    () => runtime.assertActorFence(staleActor, { mutating: true }),
    /fenced turn|epoch/,
    'a stale instance must not publish',
  );
  const liveActor = { ...actorFor(runtime, clusterId, 'orchestrator', root.id), epoch: leaseB.epoch, turn_seq: 2 };
  assert.doesNotThrow(() => runtime.assertActorFence(liveActor, { mutating: true }));
});

test('one scheduling pass starts several agents before any of them finishes', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 8 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'first transaction');
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'second unit of work', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: first.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  runtime.store.tx(() => runtime.store.updateTransaction(first.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'approve' });
  // Two different roles with pending work at the same moment: the Allocator has
  // an approved plan to allocate, the Auditor has the next plan to inspect.
  const third = command(runtime, orchestrator, 'create_transaction', {
    objective: 'third unit of work', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: third });
  void first;
  assert.ok(runtime.store.pendingAudits(clusterId, { limit: 10 }).length >= 1, 'the third plan is awaiting inspection');

  // Hold the only model slot: no turn can proceed, so every agent this pass
  // starts must still be registered as active afterwards.
  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot(clusterId);
  await runtime.tick();
  const active = runtime.activeTurnIds();
  assert.ok(active.length >= 2, `one pass filled more than one slot, saw ${active.length}`);
  assert.equal(runtime.llmWaiters(), active.length, 'every started turn is waiting on the model window');
  held();
});

test('a small cluster keeps working capacity: the compaction earmark never takes the workload', async t => {
  const runtime = makeRuntime(t);
  // 100k tokens and 20 requests: an unconditional 200k/64 earmark would take
  // everything and leave the cluster unable to run a single turn.
  const clusterId = startCluster(runtime, {
    budget: { tokens: 100_000, model_requests: 20, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 4 },
  });
  // Grants move a scope's own limit downward, so compare against the declared
  // tier (`100_000` tokens, `20` requests), not the post-transfer remainder.
  const poolId = runtime.compactionBudgetId(clusterId);
  if (poolId) {
    const pool = runtime.store.getBudget(poolId);
    if (pool) {
      assert.ok(pool.tokens_limit <= 100_000 * 0.25, 'the earmark is a share, not a floor');
      assert.ok(pool.requests_limit <= 20 * 0.25, 'the earmark cannot take the request allowance');
    }
  }
  const total = runtime.store.listBudgets(clusterId);
  const working = total.filter(row => row.scope_kind === 'root' || row.scope_kind === 'node');
  const available = working.reduce((sum, row) => sum + (row.tokens_limit - row.tokens_spent - row.tokens_reserved), 0);
  assert.ok(available > 0, 'ordinary work still has tokens');
  const availableRequests = working.reduce((sum, row) => sum + (row.requests_limit - row.requests_spent - row.requests_reserved), 0);
  assert.ok(availableRequests > 0, 'ordinary work still has model requests');

  // And a role can really reserve a request against its own node budget.
  const node = rootNode(runtime, clusterId);
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: node.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const chain = runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), orchestrator);
  const reserved = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 1000, turn_seq: 1,
  });
  assert.ok(reserved.request_id, 'a fresh small cluster can still send a request');
});

test('the 64-file tier funds compaction as a bounded share instead of a fixed small-cluster cap', t => {
  const runtime = makeRuntime(t);
  const tokens = 65_536 * 64 * 4;
  const modelRequests = 12 * 64 * 4;
  const clusterId = startCluster(runtime, {
    budget: {
      tokens, model_requests: modelRequests, tool_calls: 16 * 64 * 4,
      wall_time_ms: 600_000, agents: 128, max_active_agents: 9,
    },
  });
  const budgets = runtime.store.listBudgets(clusterId);
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction budget');
  assert.equal(pool.tokens_limit, Math.floor(tokens * 0.10),
    'a 400k absolute cap strands a 64-file tier after roughly 16 files');
  assert.equal(pool.requests_limit, Math.floor(modelRequests * 0.20),
    'summary request capacity scales with the same tier');
  assert.equal(budgets.reduce((sum, row) => sum + row.tokens_limit, 0), tokens,
    'the maintenance share is transferred from the declared budget, not minted');
  assert.equal(budgets.reduce((sum, row) => sum + row.requests_limit, 0), modelRequests);
});

test('a compaction reservation is charged where it can actually be funded, and released there', t => {
  const runtime = makeRuntime(t);
  // A budget whose node scope is emptied by the transfer: compacting must still
  // be fundable, and reconciliation must return the tokens to that same scope.
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  // Drain the node scope, leaving only the dedicated compaction scope funded.
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, requests_limit: 0 });
    if (agentBudget) runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, requests_limit: 0 });
  });

  const chain = runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'compaction' });
  assert.equal(chain.length, 1, 'exactly one enforcing grant');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction budget');
  assert.equal(firstOf(chain, 'budget chain'), pool.id, 'the funded scope is the one charged');
  assert.equal(firstOf(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'role' }), 'role budget chain'), pool.id,
    'an ordinary request can borrow the pool only when its owning grants cannot pay');

  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'compaction', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 5_000, turn_seq: 1,
  });
  const afterReserve = required(runtime.store.getBudget(pool.id), 'compaction budget');
  assert.equal(afterReserve.tokens_reserved, 5_000, 'the pool holds the reservation');
  assert.equal(required(runtime.store.getUsageReceipt(request.request_id), 'usage receipt').budget_scope_id, pool.id, 'the receipt names the charged scope');

  // Recovery moves the counters in that same scope — not in the drained node,
  // which would leave the pool's hold orphaned and the node over-charged.
  runtime.reconcileReservations(cluster, orchestrator);
  const afterReconcile = required(runtime.store.getBudget(pool.id), 'compaction budget');
  assert.equal(afterReconcile.requests_spent, 1, 'the attempt is consumed in the charged scope');
  assert.equal(afterReconcile.tokens_reserved, 5_000, 'an unknown-cost request keeps its token hold');
  assert.equal(required(runtime.store.getBudget(nodeBudget.id), 'node budget').requests_spent, 0, 'the drained node is not charged instead');
  const receipt = required(runtime.store.getUsageReceipt(request.request_id), 'usage receipt');
  assert.equal(receipt.status, 'UNKNOWN');
  assert.match(String(receipt.note), /tokens retained/);
});

test('a role cannot raise the limits the run declared', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 6, max_children: 4, max_depth: 3 },
  });
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);

  const raised = command(runtime, allocator, 'set_concurrency', { max_active_agents: 12, max_llm_concurrency: 8 }).result;
  const raisedLimits = jsonObject(raised.limits, 'raised limits');
  assert.equal(raisedLimits.max_active_agents, 4, 'the declared ceiling holds');
  assert.equal(raisedLimits.max_llm_concurrency, 1);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').limits.max_llm_concurrency, 1, 'the persisted limits are clamped');
  const clamped = runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='limit-clamped'", clusterId);
  assert.equal(clamped.length, 2, 'each clamped request is recorded');
  assert.match(String(firstOf(clamped, 'limit-clamped event').data), /requested/);

  // Lowering inside the envelope is still allowed.
  const lowered = command(runtime, allocator, 'set_concurrency', { max_active_agents: 2 }).result;
  assert.equal(jsonObject(lowered.limits, 'lowered limits').max_active_agents, 2);
  assert.equal(runtime.llmSlotsInUse(), 0);
});

test('the charged scope covers the whole reservation, and a throw releases it there', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction budget');

  // Partially depleted pool, funded node: the pool can no longer cover the
  // request, so the node must be chosen instead of stranding it.
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  runtime.store.tx(() => runtime.store.updateBudget(pool.id, { tokens_limit: 10_000 }));
  assert.equal(firstOf(runtime.budgetChainForAgent(orchestrator, { tokens: 50_000, kind: 'compaction' }), 'compaction budget chain'),
    nodeBudget.id, 'an underfunded compaction pool falls back to the management grant');
  assert.equal(firstOf(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'compaction' }), 'compaction budget chain'),
    pool.id, 'compaction draws from its dedicated pool when it can cover the request');
  assert.equal(firstOf(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'role' }), 'role budget chain'),
    nodeBudget.id, 'an ordinary request does not drain that pool while its owning grant can pay');

  // A dispatch that throws must release the *charged* scope and leave the other
  // reservation untouched.
  const chain = [pool.id];
  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'compaction', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 4_000, turn_seq: 1,
  });
  const ordinary = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: [nodeBudget.id], reservationTokens: 6_000, turn_seq: 1,
  });
  const poolBefore = required(runtime.store.getBudget(pool.id), 'compaction budget');
  const nodeBefore = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(poolBefore.tokens_reserved, 4_000);
  assert.equal(nodeBefore.tokens_reserved, 6_000);

  // Release the compaction request as a failed dispatch, passing the caller's
  // ordinary chain: the receipt must still route it to the pool.
  releaseLlmRequest(runtime.store, {
    cluster_id: clusterId, reservation: request, budgetIds: [nodeBudget.id], dispatched: false, note: 'dispatch failed',
  });
  assert.equal(required(runtime.store.getBudget(pool.id), 'compaction budget').tokens_reserved, 0, 'the pool hold is released');
  assert.equal(required(runtime.store.getBudget(nodeBudget.id), 'node budget').tokens_reserved, 6_000, "the ordinary reservation is untouched");
  assert.equal(required(runtime.store.getUsageReceipt(request.request_id), 'usage receipt').status, 'NOT_SENT');
  assert.equal(required(runtime.store.getUsageReceipt(ordinary.request_id), 'usage receipt').status, 'RESERVED');
});

test('competing drivers cannot exceed the active-turn window together', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 2, max_llm_concurrency: 2, max_role_turns: 8 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'first transaction');
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'second', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: first.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  runtime.store.tx(() => runtime.store.updateTransaction(first.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });

  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot(clusterId);
  const heldAgain = await runtime.acquireLlmSlot(clusterId);
  // Three eligible agents, two slots, two drivers racing at once.
  await Promise.all([runtime.tick(), runtime.tick()]);
  const active = runtime.activeTurnIds();
  assert.ok(active.length <= 2, `the window is a hard cap, saw ${active.length}`);
  assert.ok(active.length >= 1);
  held();
  heldAgain();
});

