import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny } from '@total-typescript/shoehorn';

import type { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { DIMENSIONS, dimensionAvailable, effectiveDeadline, BudgetError } from '../../packages/dsh-flow/src/core/budget.ts';
import type { BudgetDimension, DimensionSpec } from '../../packages/dsh-flow/src/core/budget.ts';
import type { AgentRecord, FlowActor, FlowAgentActor, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { BudgetPatch } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowJsonValue } from '../../packages/dsh-flow/src/types.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';

const instant = 1_800_000_000_000;
let commandNumber = 0;

/** The builder form of a budget patch: the wire patch is readonly. */
type MutableBudgetPatch = { -readonly [K in keyof BudgetPatch]: BudgetPatch[K] };

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

/** A command result is JSON on the wire; narrow one field for a typed assertion. */
function recordOf(value: FlowJsonValue | undefined, label: string): Record<string, FlowJsonValue> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error(`expected ${label} to be an object`);
}

function listOf(value: FlowJsonValue | undefined, label: string): FlowJsonValue[] {
  if (Array.isArray(value)) return value;
  throw new Error(`expected ${label} to be a list`);
}

function textOf(value: FlowJsonValue | undefined, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`expected ${label} to be a string`);
}

function transactionIdOf(result: FlowJsonValue): string {
  return textOf(recordOf(result, 'command result').transaction_id, 'transaction_id');
}

function allocationsOf(result: FlowJsonValue): Array<Record<string, FlowJsonValue>> {
  return listOf(recordOf(result, 'allocation result').allocations, 'allocations')
    .map(entry => recordOf(entry, 'allocation'));
}

function dimensionOf(key: BudgetDimension): DimensionSpec {
  const spec = DIMENSIONS.find(candidate => candidate.key === key);
  if (!spec) throw new Error(`unknown budget dimension ${key}`);
  return spec;
}

function dimensionMap(read: (key: BudgetDimension) => number): Record<BudgetDimension, number> {
  return {
    tokens: read('tokens'), model_requests: read('model_requests'), tool_calls: read('tool_calls'),
    agents: read('agents'), max_active_agents: read('max_active_agents'),
  };
}

interface Fixture {
  runtime: ClusterRuntime;
  id: string;
  root: NodeRecord;
  role(name: FlowAgentRole, node?: NodeRecord): FlowAgentActor;
  send(actor: FlowActor, action: string, params?: Record<string, unknown>): FlowJsonValue;
  create(params?: Record<string, unknown>): string;
}

function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-actions-'));
  // The runtime only reads the logger and `ctx.get()` from its context; this
  // stub stands in for the Cordis context these mechanism tests never load.
  const ctx: Context = fromAny({ logger: { warn() {}, error() {}, info() {} }, get() {} });
  const runtime = new ClusterRuntime(ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, now: () => instant, autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off', maxTokens: 512 },
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const id = runtime.start({
    objective: 'check governance actions', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 5, max_depth: 5, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 3000, tool_calls: 3000, agents: 64, max_active_agents: 4, wall_time_ms: 3_600_000 },
  }).cluster.id;
  const root = must(runtime.store.listNodes(id, { parent_id: null })[0], 'root node');
  const role = (name: FlowAgentRole, node: NodeRecord = root): FlowAgentActor => {
    const agent: AgentRecord = must(runtime.store.listAgents(id, { node_id: node.id, role: name })[0], `${name} agent`);
    return { cluster_id: id, agent_id: agent.id, node_id: node.id, session_id: agent.session_id, role: name };
  };
  const send = (actor: FlowActor, action: string, params: Record<string, unknown> = {}): FlowJsonValue => runtime.command(actor, {
    command_id: `actions-${++commandNumber}`, action, params,
  }).result;
  const create = (params: Record<string, unknown> = {}): string => transactionIdOf(send(role('orchestrator'), 'create_transaction', {
    objective: 'isolated task', acceptance_criteria: ['observable result'], ...params,
  }));
  return { runtime, id, root, role, send, create };
}

function managementTree(f: Fixture) {
  const rootTx = must(f.runtime.store.listTransactions({ cluster_id: f.id })[0], 'root transaction');
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: rootTx.id });
  const oldParent = recordOf(f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'old parent' }, max_children: 5,
    budget: { tokens: 500_000, model_requests: 400, tool_calls: 400, agents: 20, max_active_agents: 2 },
  }), 'spawn_management_node');
  const newParent = recordOf(f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'new parent' }, max_children: 5,
  }), 'spawn_management_node');
  const oldNode = must(f.runtime.store.getNode(textOf(oldParent.node_id, 'old node')), 'old node');
  const newNode = must(f.runtime.store.getNode(textOf(newParent.node_id, 'new node')), 'new node');
  const moving = recordOf(f.send(f.role('allocator', oldNode), 'spawn_management_node', {
    transaction_id: textOf(oldParent.delegated_transaction_id, 'old delegated transaction'),
    scope: { objective: 'moving branch' }, max_children: 5,
  }), 'spawn_management_node');
  f.runtime.store.tx(() => {
    for (const id of [
      textOf(oldParent.delegated_transaction_id, 'old delegated transaction'),
      textOf(newParent.delegated_transaction_id, 'new delegated transaction'),
      textOf(moving.delegated_transaction_id, 'moving delegated transaction'),
    ]) {
      f.runtime.store.updateTransaction(id, { status: 'ACCEPTED' });
    }
  });
  return {
    oldNode, newNode,
    movingNode: must(f.runtime.store.getNode(textOf(moving.node_id, 'moving node')), 'moving node'),
  };
}

test('reparent reissues all five unused grants on the new branch and preserves the earliest deadline', t => {
  const f = fixture(t);
  const { oldNode, newNode, movingNode } = managementTree(f);
  const store = f.runtime.store;
  const old = must(store.budgetForScope(f.id, 'node', oldNode.id), 'old budget');
  const target = must(store.budgetForScope(f.id, 'node', newNode.id), 'target budget');
  const moved = must(store.budgetForScope(f.id, 'node', movingNode.id), 'moved budget');
  const earlier = instant + 90_000;
  store.tx(() => {
    store.updateBudget(old.id, { wall_deadline: earlier });
    const patch: MutableBudgetPatch = {};
    for (const dim of DIMENSIONS) patch[dim.limit] = must(store.getBudget(target.id), 'target budget')[dim.limit] + 50_000;
    store.updateBudget(target.id, patch);
  });
  const grant = dimensionMap(key => dimensionAvailable(must(store.getBudget(moved.id), 'moved budget'), key));
  assert.ok(grant.tokens > 0);
  const baseline = dimensionMap(key => store.listBudgets(f.id).reduce((sum, row) => sum + row[dimensionOf(key).limit], 0));
  const oldBefore = must(store.getBudget(old.id), 'old budget');
  const targetBranchBefore = dimensionMap(key => store.listBudgets(f.id).filter(row => row.node_id === newNode.id)
    .reduce((sum, row) => sum + row[dimensionOf(key).limit], 0));
  const originalDeadline = effectiveDeadline(store, must(store.getBudget(moved.id), 'moved budget'));
  f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id });
  const after = must(store.getBudget(moved.id), 'moved budget');
  assert.equal(after.parent_budget_id, target.id);
  assert.equal(effectiveDeadline(store, after), originalDeadline);
  assert.equal(after.wall_deadline, earlier);
  for (const dim of DIMENSIONS) {
    assert.equal(dimensionAvailable(after, dim.key), grant[dim.key], `${dim.key} was reissued`);
    assert.equal(must(store.getBudget(old.id), 'old budget')[dim.limit], oldBefore[dim.limit] + grant[dim.key], `${dim.key} returned`);
    assert.equal(store.listBudgets(f.id).filter(row => row.node_id === newNode.id)
      .reduce((sum, row) => sum + row[dim.limit], 0),
    targetBranchBefore[dim.key] - grant[dim.key], `${dim.key} charged to new branch`);
    assert.equal(store.listBudgets(f.id).reduce((sum, row) => sum + row[dim.limit], 0), baseline[dim.key], `${dim.key} conserved`);
  }
});

test('an underfunded new parent rolls back every reparent budget and topology change', t => {
  const f = fixture(t);
  const { newNode, movingNode } = managementTree(f);
  const store = f.runtime.store;
  const target = must(store.budgetForScope(f.id, 'node', newNode.id), 'target budget');
  store.tx(() => {
    const row = must(store.getBudget(target.id), 'target budget');
    store.updateBudget(target.id, { tokens_limit: row.tokens_reserved + row.tokens_spent });
    for (const agent of store.listAgents(f.id, { node_id: newNode.id })) {
      const grant = store.budgetForScope(f.id, 'agent', agent.id);
      if (grant) store.updateBudget(grant.id, { tokens_limit: grant.tokens_spent + grant.tokens_reserved });
    }
  });
  const before = store.listBudgets(f.id).map(row => [row.id, row.parent_budget_id, ...DIMENSIONS.map(dim => row[dim.limit])]);
  const path = must(store.getNode(movingNode.id), 'moving node').path;
  // A funding shortfall is raised by the ledger's own local `BudgetError`
  // (409 + LIMIT_REACHED), not by the command vocabulary's `flow/rejected`.
  assert.throws(() => f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id }),
    error => error instanceof BudgetError && error.status === 409 && /tokens|fund/.test(messageOf(error)));
  assert.deepEqual(store.listBudgets(f.id).map(row => [row.id, row.parent_budget_id, ...DIMENSIONS.map(dim => row[dim.limit])]), before);
  assert.equal(must(store.getNode(movingNode.id), 'moving node').path, path);
});

test('reparent preserves local transaction ownership for reassignment', t => {
  const f = fixture(t);
  const { newNode, movingNode } = managementTree(f);
  const store = f.runtime.store;
  // Fund the branch that takes the subtree on, exactly as the passing reparent
  // test does: this case is about ownership, not about the funding gate.
  const newBranch = must(store.budgetForScope(f.id, 'node', newNode.id), 'new branch budget');
  store.tx(() => {
    const patch: MutableBudgetPatch = {};
    for (const dim of DIMENSIONS) patch[dim.limit] = must(store.getBudget(newBranch.id), 'new branch budget')[dim.limit] + 50_000;
    store.updateBudget(newBranch.id, patch);
  });
  const branchOrchestrator = f.role('orchestrator', movingNode);
  const branchAllocator = f.role('allocator', movingNode);

  // One task created inside the moving node *before* the move.
  const source = transactionIdOf(f.send(branchOrchestrator, 'create_transaction', {
    objective: 'task written inside the branch before the move',
    acceptance_criteria: ['observable result'],
    inputs: { write_scope: ['files'] },
  }));
  f.send(branchOrchestrator, 'dispatch', { transaction_id: source });
  f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id });

  // A peer task created inside the same node *after* the move.
  const peer = transactionIdOf(f.send(branchOrchestrator, 'create_transaction', {
    objective: 'peer task written inside the branch after the move',
    acceptance_criteria: ['observable result'],
    inputs: { write_scope: ['files/subdir'] },
  }));
  f.send(branchOrchestrator, 'dispatch', { transaction_id: peer });

  const allocated = f.send(branchAllocator, 'allocate_agent', { transaction_id: source, write_scope: ['files'] });
  const allocationId = textOf(must(allocationsOf(allocated)[0], 'allocation').allocation_id, 'allocation_id');
  const agentId = must(store.getAllocation(allocationId), 'allocation').agent_id;

  // Ownership is read through the public query, not through a private helper.
  const rootOrchestrator = f.role('orchestrator');
  for (const id of [source, peer]) {
    const row = f.runtime.query(rootOrchestrator, 'transaction', { id }).transaction;
    assert.equal(row.owner_management_id, movingNode.id,
      `transaction ${id} stays owned by the management node that hosts it`);
  }
  assert.equal(must(store.getNode(movingNode.id), 'moving node').owner_management_id, movingNode.id,
    'a management node owns itself');
  assert.equal(must(store.getNode(must(must(store.getNode(movingNode.id), 'moving node').parent_id, 'parent id')), 'parent node').owner_management_id, newNode.id);

  // Reassignment is a within-domain move: both transactions still share one owner.
  const moved = f.send(branchAllocator, 'reassign_agent', { agent_id: agentId, transaction_id: peer });
  assert.equal(textOf(recordOf(moved, 'reassign_agent').transaction_id, 'transaction_id'), peer);
  const allocation = must(store.getAllocation(allocationId), 'allocation');
  assert.equal(allocation.transaction_id, peer);
  assert.deepEqual(allocation.write_scope, ['files/subdir']);
  assert.deepEqual(allocation.write_scope_canonical, [join(must(store.getCluster(f.id), 'cluster').workspace, 'files/subdir')]);
});

test('scale_out and scale_in move the worker ladder inside the node child ceiling', t => {
  const f = fixture(t);
  const store = f.runtime.store;
  const orchestrator = f.role('orchestrator');
  const allocator = f.role('allocator');
  // The root may host at most five children in this fixture; more READY work
  // than that has to wait for a wave to finish rather than overrun the ceiling.
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const id = f.create({ objective: `ladder task ${index}` });
    f.send(orchestrator, 'dispatch', { transaction_id: id });
    ids.push(id);
  }
  // An oversized wave is refused *atomically*: the ceiling is checked by the
  // first allocation that cannot fit, and nothing half-allocated survives.
  assert.throws(() => f.send(allocator, 'scale_out', { count: 6 }),
    error => rejectionStatus(error) === 409 && /max_children/.test(messageOf(error)));
  assert.equal(store.childrenOf(f.root.id).length, 0, 'a refused wave leaves no worker node behind');
  assert.equal(store.listAllocations({ cluster_id: f.id, status: 'ACTIVE' }).length, 0);

  const first = f.send(allocator, 'scale_out', { count: 5 });
  const firstAllocations = allocationsOf(first);
  assert.equal(firstAllocations.length, 5, 'exactly the free slots are filled');
  assert.equal(new Set(firstAllocations.map(entry => textOf(entry.agent_id, 'agent_id'))).size, 5, 'every Worker is its own identity');
  for (const entry of firstAllocations) {
    const tx = must(store.getTransaction(textOf(entry.transaction_id, 'transaction_id')), 'transaction');
    assert.equal(tx.status, 'READY');
    assert.equal(must(store.activeAllocationForTransaction(tx.id), 'active allocation').agent_id, textOf(entry.agent_id, 'agent_id'));
  }
  // Re-running the same wave is idempotent per transaction: an already
  // allocated task is answered with its existing allocation, never with a
  // second Worker for the same piece of work.
  const repeat = f.send(allocator, 'scale_out', { count: 5 });
  const repeatAllocations = allocationsOf(repeat);
  assert.equal(repeatAllocations.length, 5);
  assert.ok(repeatAllocations.every(entry => store.activeAllocationForTransaction(textOf(entry.transaction_id, 'transaction_id'))));
  assert.equal(store.childrenOf(f.root.id).length, 5, 'a repeat creates no second Worker for the same task');

  // The one task that did not fit is refused by the ceiling — and the whole
  // command rolls back, so no half-filled wave survives.
  assert.throws(() => f.send(allocator, 'scale_out', { count: 6 }),
    error => rejectionStatus(error) === 409 && /max_children/.test(messageOf(error)),
    'the task beyond the child ceiling is refused');
  assert.equal(store.childrenOf(f.root.id).length, 5, 'and the refusal created no worker node');
  // The tasks are selected in the store's own order (`created, id`), so the one
  // that did not fit is identified by "has no allocation", not by position.
  assert.equal(ids.filter(id => !store.activeAllocationForTransaction(id)).length, 1,
    'exactly one task did not fit under the ceiling');

  // Finishing the first wave releases its slots; scale_in releases exactly the
  // allocations whose work is terminal, and the freed slots are reusable.
  store.tx(() => {
    for (const entry of firstAllocations) store.updateTransaction(textOf(entry.transaction_id, 'transaction_id'), { status: 'ACCEPTED' });
  });
  const scaledIn = f.send(allocator, 'scale_in', { count: 3 });
  assert.equal(listOf(recordOf(scaledIn, 'scale_in').released, 'released').length, 3,
    'scale_in releases the requested count of finished Workers');
  assert.equal(store.allocationsForNode(f.root.id, { status: 'ACTIVE' }).length, 2);
  const second = f.send(allocator, 'scale_out', { count: 1 });
  const secondAllocation = must(allocationsOf(second)[0], 'second allocation');
  assert.equal(allocationsOf(second).length, 1, 'the freed slot carries the next wave');
  const secondTransactionId = textOf(secondAllocation.transaction_id, 'transaction_id');
  assert.ok(ids.includes(secondTransactionId));
  // A count beyond what is finished is not an error: it releases what exists,
  // and never touches an allocation whose work is still running.
  const over = f.send(allocator, 'scale_in', { count: 99 });
  const overReleased = listOf(recordOf(over, 'scale_in').released, 'released');
  assert.equal(overReleased.length, 2, `scale_in releases exactly the finished allocations: ${JSON.stringify(overReleased)}`);
  assert.equal(store.activeAllocationForTransaction(secondTransactionId)?.status, 'ACTIVE',
    'the allocation whose task is still READY survives scale_in');
});

test('allocate_budget moves capacity from the node scope to an identity, and refuses a foreign target', t => {
  const f = fixture(t);
  const store = f.runtime.store;
  const orchestrator = f.role('orchestrator');
  const allocator = f.role('allocator');
  const id = f.create();
  f.send(orchestrator, 'dispatch', { transaction_id: id });
  const allocated = f.send(allocator, 'allocate_agent', { transaction_id: id });
  const agentId = textOf(must(allocationsOf(allocated)[0], 'allocation').agent_id, 'agent_id');
  const nodeBudget = must(store.budgetForScope(f.id, 'node', f.root.id), 'node budget');
  const agentBudget = must(store.budgetForScope(f.id, 'agent', agentId), 'agent budget');
  const before = {
    agent: agentBudget.tokens_limit, node: nodeBudget.tokens_limit - nodeBudget.tokens_spent - nodeBudget.tokens_reserved,
  };
  const granted = f.send(allocator, 'allocate_budget', { scope: { kind: 'agent', id: agentId }, amounts: { tokens: 50_000, requests: 5 } });
  const grantedBudget = recordOf(recordOf(granted, 'allocate_budget').budget, 'budget');
  assert.equal(recordOf(grantedBudget.tokens, 'granted tokens').limit, before.agent + 50_000, 'the identity grant grew by exactly the amount');
  const afterNode = must(store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(afterNode.tokens_limit - afterNode.tokens_spent - afterNode.tokens_reserved, before.node - 50_000,
    'and the node it came from gave up exactly that amount');

  // A scope outside the actor's domain is refused before anything moves.
  const other = recordOf(f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: must(store.listTransactions({ cluster_id: f.id })[0], 'root transaction').id,
    scope: { objective: 'other domain' }, max_children: 2,
  }), 'spawn_management_node');
  const otherNodeId = textOf(other.node_id, 'other node id');
  const otherBudget = must(store.budgetForScope(f.id, 'node', otherNodeId), 'other budget');
  assert.throws(() => f.send(f.role('allocator', must(store.getNode(otherNodeId), 'other node')), 'allocate_budget', {
    scope: { kind: 'node', id: f.root.id }, amounts: { tokens: 1000 },
  }), error => rejectionStatus(error) === 403, 'a child Allocator cannot move capacity out of its domain');
  assert.equal(must(store.getBudget(otherBudget.id), 'other budget').tokens_limit, otherBudget.tokens_limit);
});

test('reject_result records a durable issue and refuses anything not awaiting a verdict', t => {
  const f = fixture(t);
  const store = f.runtime.store;
  const orchestrator = f.role('orchestrator');
  const draft = f.create();
  assert.throws(() => f.send(orchestrator, 'reject_result', { transaction_id: draft }),
    error => rejectionStatus(error) === 409 && /nothing to reject/.test(messageOf(error)));
  const id = f.create();
  f.send(orchestrator, 'dispatch', { transaction_id: id });
  store.tx(() => store.updateTransaction(id, { status: 'SUBMITTED', result: { version: 1 } }));
  const rejected = recordOf(f.send(orchestrator, 'reject_result', {
    transaction_id: id, reason: 'the result does not name the file it wrote', required_change: 'name the file and its hash',
  }), 'reject_result');
  assert.equal(textOf(rejected.status, 'status'), 'REJECTED');
  const tx = must(store.getTransaction(id), 'transaction');
  assert.equal(tx.status, 'REJECTED');
  const issue = must(store.getIssue(textOf(rejected.issue_id, 'issue_id')), 'issue');
  assert.equal(issue.transaction_id, id);
  assert.equal(issue.status, 'OPEN');
  assert.match(String(issue.required_change), /name the file and its hash/);
});

test('reassignment rejects disjoint contracts and narrows a valid target grant with a revision fence', t => {
  const f = fixture(t);
  const source = f.create({ inputs: { write_scope: ['files'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: source });
  const allocated = f.send(f.role('allocator'), 'allocate_agent', { transaction_id: source, write_scope: ['files'] });
  const allocation = must(f.runtime.store.getAllocation(textOf(must(allocationsOf(allocated)[0], 'allocation').allocation_id, 'allocation_id')), 'allocation');
  const outside = f.create({ inputs: { write_scope: ['elsewhere'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: outside });
  assert.throws(() => f.send(f.role('allocator'), 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: outside,
  }), error => rejectionStatus(error) === 409 && /scope/.test(messageOf(error)));
  const target = f.create({ inputs: { write_scope: ['files/subdir'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: target });
  f.send(f.role('allocator'), 'reassign_agent', { agent_id: allocation.agent_id, transaction_id: target });
  const moved = must(f.runtime.store.getAllocation(allocation.id), 'allocation');
  assert.deepEqual(moved.write_scope, ['files/subdir']);
  assert.deepEqual(moved.write_scope_canonical, [join(must(f.runtime.store.getCluster(f.id), 'cluster').workspace, 'files/subdir')]);
  assert.equal(moved.transaction_id, target);
  assert.equal(f.runtime.store.allocationOutdated(f.id, moved), false);
  f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: target, priority: 2 });
  assert.equal(f.runtime.store.allocationOutdated(f.id, moved), true);
});

test('scoped pause/resume restores DRAFT, READY, SUBMITTED and VALIDATING without losing review identity', t => {
  const f = fixture(t);
  const orchestrator = f.role('orchestrator');
  for (const phase of ['DRAFT', 'READY', 'SUBMITTED', 'VALIDATING']) {
    const id = f.create();
    if (phase !== 'DRAFT') f.send(orchestrator, 'dispatch', { transaction_id: id });
    if (phase === 'SUBMITTED' || phase === 'VALIDATING') {
      f.runtime.store.tx(() => f.runtime.store.updateTransaction(id, { status: 'SUBMITTED', result: { value: phase } }));
    }
    if (phase === 'VALIDATING') f.send(orchestrator, 'validate', {
      transaction_id: id, accepted: true, checks: [{ criterion: 'observable result', passed: true, evidence: 'recorded value' }],
    });
    const before = must(f.runtime.store.getTransaction(id), 'transaction');
    const audit = phase === 'VALIDATING'
      ? f.runtime.store.findAudit(f.id, id, 'validation', must(before.result_revision, 'result_revision')) : null;
    f.send(orchestrator, 'pause_transaction', { transaction_id: id });
    f.send(orchestrator, 'resume_transaction', { transaction_id: id });
    const after = must(f.runtime.store.getTransaction(id), 'transaction');
    assert.equal(after.status, phase);
    assert.equal(after.revision, before.revision + (['DRAFT', 'READY'].includes(phase) ? 2 : 0),
      'plan phases advance; pending result/validation reviews retain their target revision');
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.validation, before.validation);
    assert.equal(after.result_revision, before.result_revision);
    if (audit) assert.equal(must(f.runtime.store.getAudit(audit.id), 'audit').decision, 'PENDING');
    if (phase === 'READY') {
      assert.equal(f.runtime.store.findAudit(f.id, id, 'plan', before.revision)?.decision, 'OVERRIDDEN');
      assert.equal(f.runtime.store.findAudit(f.id, id, 'plan', after.revision)?.decision, 'PENDING');
    }
  }
});

test('Auditor reopens accepted work as REJECTED, invalidates stale result, and respects correction cap', t => {
  const f = fixture(t);
  const orchestrator = f.role('orchestrator');
  const auditor = f.role('auditor');
  const id = f.create();
  const dependent = f.create();
  f.runtime.store.tx(() => f.runtime.store.addDependency(dependent, id));
  f.send(orchestrator, 'dispatch', { transaction_id: id });
  f.runtime.store.tx(() => f.runtime.store.updateTransaction(id, { status: 'SUBMITTED', result: { version: 1 } }));
  f.send(orchestrator, 'validate', {
    transaction_id: id, accepted: true, checks: [{ criterion: 'observable result', passed: true, evidence: 'version 1' }],
  });
  f.send(auditor, 'inspect_validation', { transaction_id: id, decision: 'approve' });
  assert.equal(must(f.runtime.store.getTransaction(id), 'transaction').status, 'ACCEPTED');
  const correction = recordOf(f.send(auditor, 'request_replan', { transaction_id: id, required_change: 'replace version 1' }), 'request_replan');
  const reopened = must(f.runtime.store.getTransaction(id), 'transaction');
  assert.equal(reopened.status, 'REJECTED');
  assert.equal(reopened.result, null);
  assert.equal(reopened.result_revision, null);
  assert.equal(reopened.validation, null);
  assert.equal(reopened.plan_approved_revision, null);
  assert.equal(must(f.runtime.store.getTransaction(dependent), 'transaction').status, 'PAUSED');
  const summary = recordOf(must(f.runtime.store.latestSummary(f.id, { transaction_id: id }), 'summary').data, 'summary data');
  assert.equal(summary.invalidated_by_issue, correction.issue_id);
  f.runtime.store.tx(() => f.runtime.store.updateIssue(textOf(correction.issue_id, 'issue_id'), { corrections: 2 }));
  assert.throws(() => f.send(auditor, 'request_replan', { transaction_id: id }),
    error => rejectionStatus(error) === 409 && /correction budget exhausted/.test(messageOf(error)));
  const draft = f.create();
  assert.equal(textOf(recordOf(f.send(auditor, 'request_replan', { transaction_id: draft }), 'request_replan').status, 'status'), 'DRAFT');
});

test('health evaluation validates weights and window; final closeout is scored by its owning Auditor', t => {
  const f = fixture(t);
  const auditor = f.role('auditor');
  const metric = 'planning_stability';
  for (const weights of [
    { [metric]: 'invalid' }, { [metric]: -1 }, { [metric]: Infinity },
    { invented: 1 }, { [metric]: 0.8 },
  ]) {
    assert.throws(() => f.send(auditor, 'evaluate_health', {
      dimensions: { [metric]: 0.5 }, weights,
    }), error => rejectionStatus(error) === 400);
  }
  for (const window of [0, -1, Infinity, 'yesterday', null]) {
    assert.throws(() => f.send(auditor, 'evaluate_health', {
      dimensions: { [metric]: 0.5 }, evaluation_window: window,
    }), error => rejectionStatus(error) === 400);
  }
  const rootTx = must(f.runtime.store.listTransactions({ cluster_id: f.id })[0], 'root transaction');
  f.runtime.store.tx(() => {
    const event = f.runtime.store.appendEvent(f.id, 'transaction-adjusted', {
      transaction_id: rootTx.id, fields: ['objective'], revision: rootTx.revision + 1,
    });
    f.runtime.store.run('UPDATE events SET at=? WHERE seq=?', instant - 5_000, event.seq);
  });
  const short = recordOf(f.send(auditor, 'evaluate_health', { dimensions: { [metric]: 0.5 }, evaluation_window: 1000 }), 'health');
  const long = recordOf(f.send(auditor, 'evaluate_health', { dimensions: { [metric]: 0.5 }, evaluation_window: 10_000 }), 'health');
  assert.equal(recordOf(recordOf(short.signals, 'signals').planning_stability, 'planning_stability').revisions_per_transaction, 0);
  assert.equal(recordOf(recordOf(long.signals, 'signals').planning_stability, 'planning_stability').revisions_per_transaction, 1);
  assert.equal(Number(must(f.runtime.store.get('SELECT evaluation_window FROM health WHERE id=?', textOf(short.health_id, 'health_id')), 'health row').evaluation_window), 1000);
  assert.throws(() => f.send(auditor, 'evaluate_health', {
    dimensions: { [metric]: 0.5 }, evaluation_window: 'subtree-close',
  }), error => rejectionStatus(error) === 403);
  const dimensions: Record<string, number> = Object.fromEntries(f.runtime.healthMetricNames().map(name => [name, 0.5]));
  const closeout = recordOf(f.send(auditor, 'evaluate_health', { dimensions, evaluation_window: 'subtree-close' }), 'health');
  const row = must(f.runtime.store.get('SELECT * FROM health WHERE id=?', textOf(closeout.health_id, 'health_id')), 'health row');
  assert.equal(row.evaluation_window, 'subtree-close');
  assert.equal(row.decided, 1);
  assert.equal(row.decided_by, auditor.agent_id);
  assert.equal(row.node_id, f.root.id);
});