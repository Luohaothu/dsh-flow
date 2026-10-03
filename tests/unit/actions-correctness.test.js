import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClusterRuntime } from '../../src/adapter/cluster.js';
import { DIMENSIONS, dimensionAvailable, effectiveDeadline } from '../../src/adapter/budget.js';

const instant = 1_800_000_000_000;
let commandNumber = 0;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-actions-'));
  const runtime = new ClusterRuntime({ logger: { warn() {}, error() {}, info() {} }, get() {} }, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, now: () => instant, autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off', maxTokens: 512 },
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const id = runtime.start({
    objective: 'check governance actions', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 5, max_depth: 5, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 3000, tool_calls: 3000, agents: 64, max_active_agents: 4, wall_time_ms: 3_600_000 },
  }).cluster.id;
  const root = runtime.store.listNodes(id, { parent_id: null })[0];
  const role = (name, node = root) => {
    const agent = runtime.store.listAgents(id, { node_id: node.id, role: name })[0];
    return { cluster_id: id, agent_id: agent.id, node_id: node.id, role: name };
  };
  const send = (actor, action, params = {}) => runtime.command(actor, {
    command_id: `actions-${++commandNumber}`, action, params,
  }).result;
  const create = (params = {}) => send(role('orchestrator'), 'create_transaction', {
    objective: 'isolated task', acceptance_criteria: ['observable result'], ...params,
  }).transaction_id;
  return { runtime, id, root, role, send, create };
}

function managementTree(f) {
  const rootTx = f.runtime.store.listTransactions({ cluster_id: f.id })[0];
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: rootTx.id });
  const oldParent = f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'old parent' }, max_children: 5,
    budget: { tokens: 500_000, model_requests: 400, tool_calls: 400, agents: 20, max_active_agents: 2 },
  });
  const newParent = f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'new parent' }, max_children: 5,
  });
  const oldNode = f.runtime.store.getNode(oldParent.node_id);
  const newNode = f.runtime.store.getNode(newParent.node_id);
  const moving = f.send(f.role('allocator', oldNode), 'spawn_management_node', {
    transaction_id: oldParent.delegated_transaction_id, scope: { objective: 'moving branch' }, max_children: 5,
  });
  f.runtime.store.tx(() => {
    for (const id of [oldParent.delegated_transaction_id, newParent.delegated_transaction_id, moving.delegated_transaction_id]) {
      f.runtime.store.updateTransaction(id, { status: 'ACCEPTED' });
    }
  });
  return { oldNode, newNode, movingNode: f.runtime.store.getNode(moving.node_id) };
}

test('reparent reissues all five unused grants on the new branch and preserves the earliest deadline', t => {
  const f = fixture(t);
  const { oldNode, newNode, movingNode } = managementTree(f);
  const store = f.runtime.store;
  const old = store.budgetForScope(f.id, 'node', oldNode.id);
  const target = store.budgetForScope(f.id, 'node', newNode.id);
  const moved = store.budgetForScope(f.id, 'node', movingNode.id);
  const earlier = instant + 90_000;
  store.tx(() => {
    store.updateBudget(old.id, { wall_deadline: earlier });
    const patch = {};
    for (const dim of DIMENSIONS) patch[dim.limit] = store.getBudget(target.id)[dim.limit] + 50_000;
    store.updateBudget(target.id, patch);
  });
  const grant = Object.fromEntries(DIMENSIONS.map(dim => [dim.key, dimensionAvailable(store.getBudget(moved.id), dim.key)]));
  assert.ok(grant.tokens > 0);
  const baseline = Object.fromEntries(DIMENSIONS.map(dim => [dim.key,
    store.listBudgets(f.id).reduce((sum, row) => sum + row[dim.limit], 0)]));
  const oldBefore = store.getBudget(old.id);
  const targetBranchBefore = Object.fromEntries(DIMENSIONS.map(dim => [dim.key,
    store.listBudgets(f.id).filter(row => row.node_id === newNode.id)
      .reduce((sum, row) => sum + row[dim.limit], 0)]));
  const originalDeadline = effectiveDeadline(store, store.getBudget(moved.id));
  f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id });
  const after = store.getBudget(moved.id);
  assert.equal(after.parent_budget_id, target.id);
  assert.equal(effectiveDeadline(store, after), originalDeadline);
  assert.equal(after.wall_deadline, earlier);
  for (const dim of DIMENSIONS) {
    assert.equal(dimensionAvailable(after, dim.key), grant[dim.key], `${dim.key} was reissued`);
    assert.equal(store.getBudget(old.id)[dim.limit], oldBefore[dim.limit] + grant[dim.key], `${dim.key} returned`);
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
  const target = store.budgetForScope(f.id, 'node', newNode.id);
  store.tx(() => {
    const row = store.getBudget(target.id);
    store.updateBudget(target.id, { tokens_limit: row.tokens_reserved + row.tokens_spent });
    for (const agent of store.listAgents(f.id, { node_id: newNode.id })) {
      const grant = store.budgetForScope(f.id, 'agent', agent.id);
      if (grant) store.updateBudget(grant.id, { tokens_limit: grant.tokens_spent + grant.tokens_reserved });
    }
  });
  const before = store.listBudgets(f.id).map(row => [row.id, row.parent_budget_id, ...DIMENSIONS.map(dim => row[dim.limit])]);
  const path = store.getNode(movingNode.id).path;
  assert.throws(() => f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id }),
    error => error.status === 409 && /tokens|fund/.test(error.message));
  assert.deepEqual(store.listBudgets(f.id).map(row => [row.id, row.parent_budget_id, ...DIMENSIONS.map(dim => row[dim.limit])]), before);
  assert.equal(store.getNode(movingNode.id).path, path);
});

test('reparent preserves local transaction ownership for reassignment', t => {
  const f = fixture(t);
  const { newNode, movingNode } = managementTree(f);
  const store = f.runtime.store;
  // Fund the branch that takes the subtree on, exactly as the passing reparent
  // test does: this case is about ownership, not about the funding gate.
  const newBranch = store.budgetForScope(f.id, 'node', newNode.id);
  store.tx(() => {
    const patch = {};
    for (const dim of DIMENSIONS) patch[dim.limit] = store.getBudget(newBranch.id)[dim.limit] + 50_000;
    store.updateBudget(newBranch.id, patch);
  });
  const branchOrchestrator = f.role('orchestrator', movingNode);
  const branchAllocator = f.role('allocator', movingNode);

  // One task created inside the moving node *before* the move.
  const source = f.send(branchOrchestrator, 'create_transaction', {
    objective: 'task written inside the branch before the move',
    acceptance_criteria: ['observable result'],
    inputs: { write_scope: ['files'] },
  }).transaction_id;
  f.send(branchOrchestrator, 'dispatch', { transaction_id: source });
  f.send(f.role('allocator'), 'reparent', { node_id: movingNode.id, new_parent_id: newNode.id });

  // A peer task created inside the same node *after* the move.
  const peer = f.send(branchOrchestrator, 'create_transaction', {
    objective: 'peer task written inside the branch after the move',
    acceptance_criteria: ['observable result'],
    inputs: { write_scope: ['files/subdir'] },
  }).transaction_id;
  f.send(branchOrchestrator, 'dispatch', { transaction_id: peer });

  const allocated = f.send(branchAllocator, 'allocate_agent', { transaction_id: source, write_scope: ['files'] });
  const allocationId = allocated.allocations[0].allocation_id;
  const agentId = store.getAllocation(allocationId).agent_id;

  // Ownership is read through the public query, not through a private helper.
  const rootOrchestrator = f.role('orchestrator');
  for (const id of [source, peer]) {
    const row = f.runtime.query(rootOrchestrator, 'transaction', { id }).transaction;
    assert.equal(row.owner_management_id, movingNode.id,
      `transaction ${id} stays owned by the management node that hosts it`);
  }
  assert.equal(store.getNode(movingNode.id).owner_management_id, movingNode.id,
    'a management node owns itself');
  assert.equal(store.getNode(store.getNode(movingNode.id).parent_id).owner_management_id, newNode.id);

  // Reassignment is a within-domain move: both transactions still share one owner.
  const moved = f.send(branchAllocator, 'reassign_agent', { agent_id: agentId, transaction_id: peer });
  assert.equal(moved.transaction_id, peer);
  const allocation = store.getAllocation(allocationId);
  assert.equal(allocation.transaction_id, peer);
  assert.deepEqual(allocation.write_scope, ['files/subdir']);
  assert.deepEqual(allocation.write_scope_canonical, [join(store.getCluster(f.id).workspace, 'files/subdir')]);
});

test('scale_out and scale_in move the worker ladder inside the node child ceiling', t => {
  const f = fixture(t);
  const store = f.runtime.store;
  const orchestrator = f.role('orchestrator');
  const allocator = f.role('allocator');
  // The root may host at most five children in this fixture; more READY work
  // than that has to wait for a wave to finish rather than overrun the ceiling.
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    const id = f.create({ objective: `ladder task ${index}` });
    f.send(orchestrator, 'dispatch', { transaction_id: id });
    ids.push(id);
  }
  // An oversized wave is refused *atomically*: the ceiling is checked by the
  // first allocation that cannot fit, and nothing half-allocated survives.
  assert.throws(() => f.send(allocator, 'scale_out', { count: 6 }),
    error => error.status === 409 && /max_children/.test(error.message));
  assert.equal(store.childrenOf(f.root.id).length, 0, 'a refused wave leaves no worker node behind');
  assert.equal(store.listAllocations({ cluster_id: f.id, status: 'ACTIVE' }).length, 0);

  const first = f.send(allocator, 'scale_out', { count: 5 });
  assert.equal(first.allocations.length, 5, 'exactly the free slots are filled');
  assert.equal(new Set(first.allocations.map(entry => entry.agent_id)).size, 5, 'every Worker is its own identity');
  for (const entry of first.allocations) {
    const tx = store.getTransaction(entry.transaction_id);
    assert.equal(tx.status, 'READY');
    assert.equal(store.activeAllocationForTransaction(tx.id).agent_id, entry.agent_id);
  }
  // Re-running the same wave is idempotent per transaction: an already
  // allocated task is answered with its existing allocation, never with a
  // second Worker for the same piece of work.
  const repeat = f.send(allocator, 'scale_out', { count: 5 });
  assert.equal(repeat.allocations.length, 5);
  assert.ok(repeat.allocations.every(entry => store.activeAllocationForTransaction(entry.transaction_id)));
  assert.equal(store.childrenOf(f.root.id).length, 5, 'a repeat creates no second Worker for the same task');

  // The one task that did not fit is refused by the ceiling — and the whole
  // command rolls back, so no half-filled wave survives.
  assert.throws(() => f.send(allocator, 'scale_out', { count: 6 }),
    error => error.status === 409 && /max_children/.test(error.message),
    'the task beyond the child ceiling is refused');
  assert.equal(store.childrenOf(f.root.id).length, 5, 'and the refusal created no worker node');
  // The tasks are selected in the store's own order (`created, id`), so the one
  // that did not fit is identified by "has no allocation", not by position.
  assert.equal(ids.filter(id => !store.activeAllocationForTransaction(id)).length, 1,
    'exactly one task did not fit under the ceiling');

  // Finishing the first wave releases its slots; scale_in releases exactly the
  // allocations whose work is terminal, and the freed slots are reusable.
  store.tx(() => {
    for (const entry of first.allocations) store.updateTransaction(entry.transaction_id, { status: 'ACCEPTED' });
  });
  const scaledIn = f.send(allocator, 'scale_in', { count: 3 });
  assert.equal(scaledIn.released.length, 3, 'scale_in releases the requested count of finished Workers');
  assert.equal(store.allocationsForNode(f.root.id, { status: 'ACTIVE' }).length, 2);
  const second = f.send(allocator, 'scale_out', { count: 1 });
  assert.equal(second.allocations.length, 1, 'the freed slot carries the next wave');
  assert.ok(ids.includes(second.allocations[0].transaction_id));
  // A count beyond what is finished is not an error: it releases what exists,
  // and never touches an allocation whose work is still running.
  const over = f.send(allocator, 'scale_in', { count: 99 });
  assert.equal(over.released.length, 2, `scale_in releases exactly the finished allocations: ${JSON.stringify(over.released)}`);
  assert.equal(store.activeAllocationForTransaction(second.allocations[0].transaction_id)?.status, 'ACTIVE',
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
  const agentId = allocated.allocations[0].agent_id;
  const nodeBudget = store.budgetForScope(f.id, 'node', f.root.id);
  const agentBudget = store.budgetForScope(f.id, 'agent', agentId);
  const before = {
    agent: agentBudget.tokens_limit, node: nodeBudget.tokens_limit - nodeBudget.tokens_spent - nodeBudget.tokens_reserved,
  };
  const granted = f.send(allocator, 'allocate_budget', { scope: { kind: 'agent', id: agentId }, amounts: { tokens: 50_000, requests: 5 } });
  assert.equal(granted.budget.tokens.limit, before.agent + 50_000, 'the identity grant grew by exactly the amount');
  const afterNode = store.getBudget(nodeBudget.id);
  assert.equal(afterNode.tokens_limit - afterNode.tokens_spent - afterNode.tokens_reserved, before.node - 50_000,
    'and the node it came from gave up exactly that amount');

  // A scope outside the actor's domain is refused before anything moves.
  const other = f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: store.listTransactions({ cluster_id: f.id })[0].id, scope: { objective: 'other domain' }, max_children: 2,
  });
  const otherBudget = store.budgetForScope(f.id, 'node', other.node_id);
  assert.throws(() => f.send(f.role('allocator', store.getNode(other.node_id)), 'allocate_budget', {
    scope: { kind: 'node', id: f.root.id }, amounts: { tokens: 1000 },
  }), error => error.status === 403, 'a child Allocator cannot move capacity out of its domain');
  assert.equal(store.getBudget(otherBudget.id).tokens_limit, otherBudget.tokens_limit);
});

test('reject_result records a durable issue and refuses anything not awaiting a verdict', t => {
  const f = fixture(t);
  const store = f.runtime.store;
  const orchestrator = f.role('orchestrator');
  const draft = f.create();
  assert.throws(() => f.send(orchestrator, 'reject_result', { transaction_id: draft }),
    error => error.status === 409 && /nothing to reject/.test(error.message));
  const id = f.create();
  f.send(orchestrator, 'dispatch', { transaction_id: id });
  store.tx(() => store.updateTransaction(id, { status: 'SUBMITTED', result: { version: 1 } }));
  const rejected = f.send(orchestrator, 'reject_result', {
    transaction_id: id, reason: 'the result does not name the file it wrote', required_change: 'name the file and its hash',
  });
  assert.equal(rejected.status, 'REJECTED');
  const tx = store.getTransaction(id);
  assert.equal(tx.status, 'REJECTED');
  const issue = store.getIssue(rejected.issue_id);
  assert.equal(issue.transaction_id, id);
  assert.equal(issue.status, 'OPEN');
  assert.match(String(issue.required_change), /name the file and its hash/);
});

test('reassignment rejects disjoint contracts and narrows a valid target grant with a revision fence', t => {
  const f = fixture(t);
  const source = f.create({ inputs: { write_scope: ['files'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: source });
  const allocated = f.send(f.role('allocator'), 'allocate_agent', { transaction_id: source, write_scope: ['files'] });
  const allocation = f.runtime.store.getAllocation(allocated.allocations[0].allocation_id);
  const outside = f.create({ inputs: { write_scope: ['elsewhere'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: outside });
  assert.throws(() => f.send(f.role('allocator'), 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: outside,
  }), error => error.status === 409 && /scope/.test(error.message));
  const target = f.create({ inputs: { write_scope: ['files/subdir'] } });
  f.send(f.role('orchestrator'), 'dispatch', { transaction_id: target });
  f.send(f.role('allocator'), 'reassign_agent', { agent_id: allocation.agent_id, transaction_id: target });
  const moved = f.runtime.store.getAllocation(allocation.id);
  assert.deepEqual(moved.write_scope, ['files/subdir']);
  assert.deepEqual(moved.write_scope_canonical, [join(f.runtime.store.getCluster(f.id).workspace, 'files/subdir')]);
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
    const before = f.runtime.store.getTransaction(id);
    const audit = phase === 'VALIDATING'
      ? f.runtime.store.findAudit(f.id, id, 'validation', before.result_revision) : null;
    f.send(orchestrator, 'pause_transaction', { transaction_id: id });
    f.send(orchestrator, 'resume_transaction', { transaction_id: id });
    const after = f.runtime.store.getTransaction(id);
    assert.equal(after.status, phase);
    assert.equal(after.revision, before.revision + (['DRAFT', 'READY'].includes(phase) ? 2 : 0),
      'plan phases advance; pending result/validation reviews retain their target revision');
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.validation, before.validation);
    assert.equal(after.result_revision, before.result_revision);
    if (audit) assert.equal(f.runtime.store.getAudit(audit.id).decision, 'PENDING');
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
  assert.equal(f.runtime.store.getTransaction(id).status, 'ACCEPTED');
  const correction = f.send(auditor, 'request_replan', { transaction_id: id, required_change: 'replace version 1' });
  const reopened = f.runtime.store.getTransaction(id);
  assert.equal(reopened.status, 'REJECTED');
  assert.equal(reopened.result, null);
  assert.equal(reopened.result_revision, null);
  assert.equal(reopened.validation, null);
  assert.equal(reopened.plan_approved_revision, null);
  assert.equal(f.runtime.store.getTransaction(dependent).status, 'PAUSED');
  assert.equal(f.runtime.store.latestSummary(f.id, { transaction_id: id }).data.invalidated_by_issue, correction.issue_id);
  f.runtime.store.tx(() => f.runtime.store.updateIssue(correction.issue_id, { corrections: 2 }));
  assert.throws(() => f.send(auditor, 'request_replan', { transaction_id: id }),
    error => error.status === 409 && /correction budget exhausted/.test(error.message));
  const draft = f.create();
  assert.equal(f.send(auditor, 'request_replan', { transaction_id: draft }).status, 'DRAFT');
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
    }), error => error.status === 400);
  }
  for (const window of [0, -1, Infinity, 'yesterday', null]) {
    assert.throws(() => f.send(auditor, 'evaluate_health', {
      dimensions: { [metric]: 0.5 }, evaluation_window: window,
    }), error => error.status === 400);
  }
  const rootTx = f.runtime.store.listTransactions({ cluster_id: f.id })[0];
  f.runtime.store.tx(() => {
    const event = f.runtime.store.appendEvent(f.id, 'transaction-adjusted', {
      transaction_id: rootTx.id, fields: ['objective'], revision: rootTx.revision + 1,
    });
    f.runtime.store.run('UPDATE events SET at=? WHERE seq=?', instant - 5_000, event.seq);
  });
  const short = f.send(auditor, 'evaluate_health', { dimensions: { [metric]: 0.5 }, evaluation_window: 1000 });
  const long = f.send(auditor, 'evaluate_health', { dimensions: { [metric]: 0.5 }, evaluation_window: 10_000 });
  assert.equal(short.signals.planning_stability.revisions_per_transaction, 0);
  assert.equal(long.signals.planning_stability.revisions_per_transaction, 1);
  assert.equal(Number(f.runtime.store.get('SELECT evaluation_window FROM health WHERE id=?', short.health_id).evaluation_window), 1000);
  assert.throws(() => f.send(auditor, 'evaluate_health', {
    dimensions: { [metric]: 0.5 }, evaluation_window: 'subtree-close',
  }), error => error.status === 403);
  const dimensions = Object.fromEntries(f.runtime.healthMetricNames().map(name => [name, 0.5]));
  const closeout = f.send(auditor, 'evaluate_health', { dimensions, evaluation_window: 'subtree-close' });
  const row = f.runtime.store.get('SELECT * FROM health WHERE id=?', closeout.health_id);
  assert.equal(row.evaluation_window, 'subtree-close');
  assert.equal(row.decided, 1);
  assert.equal(row.decided_by, auditor.agent_id);
  assert.equal(row.node_id, f.root.id);
});
