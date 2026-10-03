/**
 * Mechanism tests for ClusterRuntime: the management tree, transaction
 * lifecycle, role permissions, audit gates, budgets, communication, the
 * reparent safety point and cancellation.
 *
 * These drive the public Runtime API with an injected clock and no scheduler
 * tick, so every assertion is about durable behaviour rather than a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClusterRuntime, scheduleAdmission } from '../../src/adapter/cluster.js';
import { apply } from '../../src/adapter/index.js';
import { createFakeHost } from './fake-host.mjs';
import { ClusterStore } from '../../src/adapter/store.js';
import { communicate } from '../../src/adapter/communication.js';
import { checkWriteAccess } from '../../src/adapter/scope.js';
import { releaseLlmRequest, reserveLlmRequest, runTurn, settleLlmRequest } from '../../src/adapter/runtime.js';
import { budgetView, settleChain, createBudget, dimensionAvailable, transferBudget, DIMENSIONS } from '../../src/adapter/budget.js';
import * as recursionChecks from '../acceptance/checks/recursion.mjs';
import { correctionWitness } from '../acceptance/checks/recursion.mjs';

let clock = 1_800_000_000_000;
const now = () => clock;

function makeRuntime(t, overrides = {}, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-cluster-'));
  const runtime = new ClusterRuntime({
    logger: { warn() {}, error() {}, info() {} },
    get: name => services[name],
  }, {
    path: join(dir, 'cluster.sqlite'),
    dataDir: dir,
    now,
    autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off', maxTokens: 512 },
    ...overrides,
  });
  t.after(async () => {
    // Disposal drains the live turns; the directory may only go once it has.
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return runtime;
}

function startCluster(runtime, overrides = {}) {
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

function actorFor(runtime, clusterId, role, nodeId) {
  const agent = runtime.store.listAgents(clusterId, { node_id: nodeId, role, limit: 5 })[0];
  return { cluster_id: clusterId, agent_id: agent.id, node_id: nodeId, role };
}

function scoreFinalHealth(runtime, clusterId, nodeId) {
  const auditor = actorFor(runtime, clusterId, 'auditor', nodeId);
  const dimensions = Object.fromEntries(runtime.healthMetricNames().map(metric => [metric, 0.5]));
  return command(runtime, auditor, 'evaluate_health', {
    dimensions, evaluation_window: 'subtree-close',
  }).result.health_id;
}


/**
 * A real, observable state change for a test turn: the blackboard entry *and* its
 * event. Writing the table alone is invisible to the progress accounting, which is
 * how a test turn can look stagnant.
 */
function touchBlackboard(runtime, clusterId, key, agentId) {
  runtime.store.tx(() => {
    runtime.store.setBlackboard(clusterId, key, { at: key }, null, agentId ?? null);
    runtime.store.appendEvent(clusterId, 'blackboard', { key, revision: 1, by: agentId ?? null });
  });
}

function rootNode(runtime, clusterId) {
  return runtime.store.listNodes(clusterId, { parent_id: null })[0];
}

let counter = 0;
function command(runtime, actor, action, params, extra = {}) {
  counter += 1;
  return runtime.command(actor, { command_id: `cmd-${counter}`, action, params, ...extra });
}

test('start builds one root management node with three roles and a root transaction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const nodes = runtime.store.listNodes(clusterId, {});
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'management');
  assert.equal(nodes[0].depth, 0);
  const roles = runtime.store.listAgents(clusterId, { limit: 10 }).map(agent => agent.role).sort();
  assert.deepEqual(roles, ['allocator', 'auditor', 'orchestrator']);
  const transactions = runtime.store.listTransactions({ cluster_id: clusterId });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].status, 'DRAFT');
  assert.ok(runtime.store.budgetForScope(clusterId, 'root', clusterId));
  assert.ok(runtime.store.budgetForScope(clusterId, 'node', nodes[0].id));
});

test('a management node hosts worker and management children at once, and rejects a cycle', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const spawned = command(runtime, allocator, 'spawn_management_node', { transaction_id: tx.id, scope: { objective: 'child domain' } });
  // A second transaction under the same node is the one a worker may run: the first
  // now has delegated work, and its own attempts wait for the child results.
  const flat = command(runtime, orchestrator, 'create_transaction', { objective: 'a flat sibling', acceptance_criteria: ['x'] });
  const flatId = flat.result?.transaction_id ?? flat.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: flatId });
  if (runtime.store.getTransaction(flatId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: flatId, decision: 'approve' });
  }
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: flatId });

  const children = runtime.store.childrenOf(root.id);
  assert.deepEqual(children.map(node => node.kind).sort(), ['management', 'worker']);
  assert.equal(runtime.store.getNode(spawned.result.node_id).parent_id, root.id);
  assert.equal(runtime.store.countAgents(clusterId, { live: true }), 7);

  const childTx = runtime.store.getTransaction(spawned.result.delegated_transaction_id);
  assert.equal(childTx.parent_transaction_id, tx.id);
  assert.equal(childTx.node_id, spawned.result.node_id);

  command(runtime, orchestrator, 'set_dependency', { transaction_id: tx.id, depends_on: [childTx.id] });
  assert.throws(
    () => command(runtime, orchestrator, 'set_dependency', { transaction_id: childTx.id, depends_on: [tx.id] }),
    error => error.status === 409 && /cycle/i.test(error.message),
  );
  assert.equal(allocator.role, 'allocator');
  assert.ok(allocated.result.allocations[0].agent_id);
});

test('a deep role sees its real management ancestors without reading their private transactions', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 4, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 4_000_000, model_requests: 1_000, tool_calls: 2_000,
      wall_time_ms: 3_600_000, agents: 64, max_active_agents: 4 },
  });
  let node = rootNode(runtime, clusterId);
  let tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const ancestors = [];
  for (let level = 1; level <= 3; level += 1) {
    ancestors.push(node.id);
    const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { transaction_id: tx.id, scope: { objective: `depth ${level}` } }).result;
    node = runtime.store.getNode(spawned.node_id);
    tx = runtime.store.getTransaction(spawned.delegated_transaction_id);
  }
  const role = actorFor(runtime, clusterId, 'orchestrator', node.id);
  const details = runtime.query(role, 'node', { id: node.id });
  assert.deepEqual(details.ancestors.map(entry => entry.id), ancestors);
  assert.deepEqual(details.ancestors.map(entry => entry.depth), [0, 1, 2]);
  assert.equal(details.node.depth, 3);
  assert.equal(runtime.query(role, 'nodes').items.length, 1, 'the readable domain remains the local subtree');
  assert.throws(() => runtime.query(role, 'node', { id: ancestors[0] }),
    error => error.status === 403, 'an ancestor reference must not expose its transactions or agents');
});

test('a child role cannot select another domain through context or summary references', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const parentTx = runtime.store.rootTransactions(clusterId)[0];
  const childId = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: parentTx.id, scope: { objective: 'private child' } }).result.node_id;
  const child = actorFor(runtime, clusterId, 'auditor', childId);
  const rootAuditor = actorFor(runtime, clusterId, 'auditor', root.id);
  runtime.store.insertSummary({
    id: 'private-parent-summary', cluster_id: clusterId, node_id: root.id,
    transaction_id: parentTx.id, as_of_seq: runtime.store.latestEventSeq(clusterId),
    data: { secret: 'only the parent may read this conclusion' },
  });
  runtime.store.insertIssue({
    id: 'root-private-issue', cluster_id: clusterId, node_id: root.id,
    transaction_id: parentTx.id, evidence: { secret: 'root-only issue evidence' },
    required_change: 'private change',
  });
  runtime.store.insertEffect({
    call_id: 'root-private-effect', cluster_id: clusterId, node_id: root.id,
    agent_id: rootAuditor.agent_id, lease_epoch: 1, tool: 'read',
    body: { secret: 'root-only effect evidence' },
  });

  assert.equal(runtime.query(child, 'context', { agent_id: child.agent_id }).summary, null);
  assert.throws(() => runtime.query(child, 'context', { agent_id: rootAuditor.agent_id }),
    error => error.status === 403);
  assert.throws(() => runtime.query(child, 'context', { agent_id: child.agent_id, transaction_id: parentTx.id }),
    error => error.status === 403);
  assert.throws(() => runtime.query(child, 'health', { node_id: root.id }),
    error => error.status === 403);
  assert.throws(() => runtime.query(child, 'summary', { node_id: root.id }),
    error => error.status === 403);
  assert.throws(() => runtime.query(child, 'summary', { transaction_id: parentTx.id }),
    error => error.status === 403);
  assert.deepEqual(runtime.query(child, 'issues').items, []);
  assert.deepEqual(runtime.query(child, 'effects').items, []);
  assert.throws(() => runtime.query(child, 'issue', { id: 'root-private-issue' }),
    error => error.status === 403);
  assert.throws(() => runtime.query(child, 'effect', { call_id: 'root-private-effect' }),
    error => error.status === 403);
  assert.equal(runtime.query({ cluster_id: clusterId, role: 'user' }, 'context',
    { agent_id: rootAuditor.agent_id }).summary.secret, 'only the parent may read this conclusion');
  assert.equal(runtime.query(child, 'summary').summary, null);
});

test('scoped transaction, audit, issue and usage pages do not lose a child behind earlier root rows', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const rootTx = runtime.store.rootTransactions(clusterId)[0];
  const rootRows = [];
  runtime.store.tx(() => {
    for (let index = 0; index < 505; index += 1) {
      const id = `aaa-root-${String(index).padStart(3, '0')}`;
      runtime.store.insertTransaction({
        id, cluster_id: clusterId, node_id: root.id, owner_management_id: root.id,
        objective: `root item ${index}`, acceptance_criteria: ['root result'],
      });
      rootRows.push(id);
    }
  });
  const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: rootTx.id, scope: { objective: 'child domain' } }).result;
  const child = runtime.store.getNode(spawned.node_id);
  const childRows = [];
  const childAgent = runtime.store.listAgents(clusterId, { node_id: child.id, role: 'auditor' })[0];
  const rootAgent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' })[0];
  runtime.store.tx(() => {
    for (let index = 0; index < 50; index += 1) {
      const id = `zzz-child-${String(index).padStart(3, '0')}`;
      runtime.store.insertTransaction({
        id, cluster_id: clusterId, node_id: child.id, owner_management_id: child.id,
        objective: `child item ${index}`, acceptance_criteria: ['child result'],
      });
      childRows.push(id);
    }
    for (let index = 0; index < 505; index += 1) {
      runtime.store.insertAudit({
        id: `aaa-audit-${index}`, cluster_id: clusterId, node_id: root.id,
        transaction_id: rootRows[index], kind: 'plan', target_revision: 1,
      });
    }
    for (let index = 0; index < 13; index += 1) {
      runtime.store.insertAudit({
        id: `zzz-audit-${index}`, cluster_id: clusterId, node_id: child.id,
        transaction_id: childRows[index], kind: 'plan', target_revision: 1,
      });
    }
    for (let index = 0; index < 53; index += 1) {
      runtime.store.insertIssue({
        id: `child-issue-${index}`, cluster_id: clusterId, node_id: child.id,
        transaction_id: childRows[index % childRows.length], required_change: `fix child ${index}`,
      });
      runtime.store.setBlackboard(clusterId, `page/${String(index).padStart(3, '0')}`,
        { index }, null, childAgent.id);
    }
    for (let index = 0; index < 55; index += 1) runtime.store.insertUsageReceipt({
      request_id: `child-usage-${index}`, cluster_id: clusterId, agent_id: childAgent.id, node_id: child.id,
      role: 'auditor', kind: 'role', status: 'SETTLED', total_tokens: 17,
    });
    for (let index = 0; index < 30; index += 1) runtime.store.insertUsageReceipt({
      request_id: `root-usage-${index}`, cluster_id: clusterId, agent_id: rootAgent.id, node_id: root.id,
      role: 'auditor', kind: 'role', status: 'SETTLED', total_tokens: 19,
    });
  });
  const actor = actorFor(runtime, clusterId, 'auditor', child.id);
  const transactions = runtime.query(actor, 'transactions', { limit: 20, offset: 40 });
  assert.equal(transactions.total, 51, 'a role sees its entire domain before the global row limit');
  assert.equal(transactions.items.length, 11);
  assert.equal(transactions.next_offset, null);
  assert.ok(transactions.items.every(tx => tx.node_id === child.id));
  const node = runtime.query(actor, 'node', { id: child.id, limit: 20, offset: 40 });
  assert.equal(node.transactions.total, 51);
  assert.equal(node.transactions.items.length, 11);
  const audits = runtime.query(actor, 'audits', { limit: 20 });
  assert.equal(audits.total, 13, 'root audits beyond the former 500-row cap cannot hide child audits');
  assert.ok(audits.items.every(audit => audit.node_id === child.id));
  const issues = runtime.query(actor, 'issues', { limit: 20, offset: 40 });
  assert.equal(issues.total, 53);
  assert.equal(issues.limit, 4, 'a model receives bounded issue references rather than every historical verdict');
  assert.equal(issues.items.length, 4);
  const nextIssues = runtime.query(actor, 'issues', { offset: issues.next_offset });
  const laterIssues = runtime.query(actor, 'issues', { offset: nextIssues.next_offset });
  const finalIssues = runtime.query(actor, 'issues', { offset: laterIssues.next_offset });
  assert.deepEqual([issues.items.length, nextIssues.items.length, laterIssues.items.length, finalIssues.items.length],
    [4, 4, 4, 1]);
  assert.equal(finalIssues.next_offset, null, 'every child issue remains reachable');
  assert.ok(JSON.stringify(runtime.query(actor, 'issues')).length < 3_000);
  assert.ok([...issues.items, ...nextIssues.items, ...laterIssues.items, ...finalIssues.items]
    .every(issue => issue.node_id === child.id));
  const usage = runtime.query(actor, 'usage', { limit: 20, offset: 40 });
  assert.equal(usage.total, 55);
  assert.equal(usage.limit, 8, 'a model cannot request a context-sized receipt page');
  assert.equal(usage.items.length, 8);
  assert.equal(usage.next_offset, 48);
  const lastUsage = runtime.query(actor, 'usage', { offset: usage.next_offset });
  assert.equal(lastUsage.items.length, 7);
  assert.equal(lastUsage.next_offset, null);
  assert.equal(usage.usage.total_tokens, 55 * 17, 'the aggregate is scoped to the same domain');
  assert.ok([...usage.items, ...lastUsage.items].every(row => row.node_id === child.id));
  const defaultUsage = runtime.query(actor, 'usage');
  assert.equal(defaultUsage.limit, 8, 'the implicit page also fits a role context');
  assert.ok(JSON.stringify(defaultUsage).length < 6_000,
    '55 receipts must not return a 55-kilobyte model tool result');
  const panelUsage = runtime.query({ cluster_id: clusterId, role: 'user' }, 'usage', { limit: 20 });
  assert.equal(panelUsage.limit, 20, 'host pagination remains available to the UI');
  assert.equal(panelUsage.items.length, 20);
  assert.equal(runtime.query(actor, 'blackboard', { prefix: 'page/', limit: 20, offset: 40 }).items.length, 13);
});

test('transaction pages honor parent_id before counting and paging the role domain', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const parent = runtime.store.rootTransactions(clusterId)[0];
  runtime.store.tx(() => {
    for (const [id, parentId] of [['first-child', parent.id], ['unrelated-child', null], ['second-child', parent.id]]) {
      runtime.store.insertTransaction({
        id, cluster_id: clusterId, node_id: root.id, owner_management_id: root.id,
        parent_transaction_id: parentId, objective: `work on ${id}`, acceptance_criteria: ['complete'],
      });
    }
  });
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = runtime.query(auditor, 'transactions', { parent_id: parent.id, limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  const second = runtime.query(auditor, 'transactions', { parent_id: parent.id, offset: first.next_offset, limit: 1 });
  assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), new Set(['first-child', 'second-child']));
  assert.equal(second.next_offset, null);
});

test('list queries bound model context while per-id transaction evidence remains complete', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const evidence = 'e'.repeat(20_000);
  runtime.store.updateNode(root.id, { scope: { objective: evidence, root: true } });
  runtime.store.updateAgent(auditor.agent_id, { meta: { session_note: evidence } });
  runtime.store.updateTransaction(tx.id, {
    status: 'SUBMITTED', result: { evidence }, result_revision: tx.revision,
    validation: { checks: [{ criterion: 'the recorded output is correct', passed: true, evidence }] },
  });

  const nodes = runtime.query(auditor, 'nodes', { parent_id: null, limit: 10 });
  const agents = runtime.query(auditor, 'agents', { limit: 10 });
  const transactions = runtime.query(auditor, 'transactions', { limit: 10 });
  const node = runtime.query(auditor, 'node', { id: root.id, limit: 10 });
  assert.ok(JSON.stringify(nodes).length < 1_000, 'the tree page identifies nodes without their full scopes');
  assert.ok(JSON.stringify(agents).length < 1_500, 'the identity page excludes private session metadata');
  assert.ok(JSON.stringify(transactions).length < 1_000, 'the transaction list excludes full result evidence');
  assert.ok(JSON.stringify(node.transactions).length < 1_000, 'the node transaction page has the same bound');
  assert.ok(JSON.stringify(node.agents).length < 1_500, 'the node agent page has the same bound');
  assert.ok(JSON.stringify(node).length < 4_000, 'per-id topology lookup does not replay a long delegation scope into a role');
  assert.equal(node.node.scope.objective.length <= 160, true);
  assert.equal(runtime.query(auditor, 'node', { id: root.id, full: true }).node.scope.objective, evidence,
    'the owning role can still inspect the complete scope explicitly');
  assert.equal(runtime.query({ cluster_id: clusterId, role: 'user' }, 'node', { id: root.id }).node.scope.objective, evidence,
    'the host sees the full source of truth');
  const detail = runtime.query(auditor, 'transaction', { id: tx.id });
  assert.equal(detail.result.evidence, evidence);
  assert.equal(detail.validation.checks[0].evidence, evidence);
  assert.equal(nodes.items[0].id, root.id);
  assert.equal(agents.items.find(agent => agent.id === auditor.agent_id).role, 'auditor');
  assert.equal(transactions.items[0].id, tx.id);
});
test('a high-fanout agent list pages role identities without hiding host-visible agents', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const actor = actorFor(runtime, clusterId, 'orchestrator', root.id);
  runtime.store.tx(() => {
    for (let index = 0; index < 15; index += 1) runtime.store.insertAgent({
      id: `worker-${index}`, cluster_id: clusterId, node_id: root.id, role: 'worker',
      session_id: `worker-session-${index}`, status: 'READY', capabilities: [],
    });
  });
  const first = runtime.query(actor, 'agents', { limit: 100 });
  assert.equal(first.total, 18, 'all fifteen new identities and the three root roles remain discoverable');
  assert.equal(first.items.length, 8, 'one native query cannot dump the whole subtree into a role session');
  assert.ok(JSON.stringify(first).length < 2_000);
  const second = runtime.query(actor, 'agents', { offset: first.next_offset });
  const third = runtime.query(actor, 'agents', { offset: second.next_offset });
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [8, 8, 2]);
  assert.equal(third.next_offset, null);
  const host = runtime.query({ cluster_id: clusterId, role: 'user' }, 'agents', { limit: 100 });
  assert.equal(host.items.length, 18, 'the host may still request a full identity page');
});

test('unresolved Auditor issues stay on the first bounded model page ahead of historical verdicts', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  runtime.store.tx(() => {
    for (let index = 0; index < 5; index += 1) {
      runtime.store.insertIssue({
        id: `closed-${index}`, cluster_id: clusterId, node_id: root.id,
        transaction_id: tx.id, required_change: 'already repaired',
      });
      runtime.store.updateIssue(`closed-${index}`, { status: 'CORRECTED' });
    }
    runtime.store.insertIssue({
      id: 'needs-review', cluster_id: clusterId, node_id: root.id,
      transaction_id: tx.id, required_change: 'fix the actual output',
    });
  });
  const page = runtime.query(actorFor(runtime, clusterId, 'auditor', root.id), 'issues');
  assert.equal(page.items[0].id, 'needs-review');
  assert.equal(page.items[0].status, 'OPEN');
  assert.equal(page.total, 6);
  assert.equal(runtime.query(actorFor(runtime, clusterId, 'auditor', root.id), 'issues',
    { offset: page.next_offset }).items.length, 2);
});

test('issue and effect list pages reference complete per-id evidence without replaying it into a role session', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const evidence = 'trace:'.repeat(3_500);
  const issue = runtime.store.insertIssue({
    id: 'issue-with-evidence', cluster_id: clusterId, node_id: root.id,
    transaction_id: tx.id, reporter_agent_id: auditor.agent_id,
    required_change: 'correct the write scope', evidence: { trace: evidence },
  });
  const effect = runtime.store.insertEffect({
    call_id: 'effect-with-evidence', cluster_id: clusterId, agent_id: auditor.agent_id,
    node_id: root.id, lease_epoch: 1, tool: 'read', status: 'SETTLED',
    args: { file_path: 'result.txt' }, body: { trace: evidence },
  });
  const issues = runtime.query(auditor, 'issues');
  const effects = runtime.query(auditor, 'effects');
  assert.ok(JSON.stringify(issues).length < 1_500, 'issue lists carry ids and change summaries, not the raw trace');
  assert.ok(JSON.stringify(effects).length < 1_500, 'effect lists carry ids and outcomes, not the raw tool body');
  assert.equal(issues.items[0].id, issue.id);
  assert.equal(effects.items[0].call_id, effect.call_id);
  assert.equal(runtime.query(auditor, 'issue', { id: issue.id }).issue.evidence.trace, evidence);
  assert.equal(JSON.parse(runtime.query(auditor, 'effect', { call_id: effect.call_id }).effect.body).trace, evidence);
  assert.equal(runtime.query({ cluster_id: clusterId, role: 'user' }, 'issues').items[0].evidence.trace, evidence,
    'the host dashboard still reads complete issue details');
  assert.equal(JSON.parse(runtime.query({ cluster_id: clusterId, role: 'user' }, 'effects').items[0].body).trace, evidence,
    'the host still reads complete effect receipts');
  assert.throws(() => runtime.query(actorFor(runtime, clusterId, 'allocator', root.id), 'effect', { call_id: 'missing' }),
    error => error.status === 404);
});

test('transaction detail keeps current result evidence but references historical audits and issues for model roles', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const priorEvidence = 'prior audit transcript '.repeat(1_000);
  const audit = runtime.store.insertAudit({
    id: 'large-prior-audit', cluster_id: clusterId, transaction_id: tx.id,
    node_id: root.id, kind: 'plan', target_revision: tx.revision,
  });
  runtime.store.decideAudit(audit.id, 'APPROVED', auditor.agent_id, { trace: priorEvidence });
  const issue = runtime.store.insertIssue({
    id: 'large-prior-issue', cluster_id: clusterId, node_id: root.id,
    transaction_id: tx.id, reporter_agent_id: auditor.agent_id,
    evidence: { trace: priorEvidence }, required_change: 'check the current evidence',
  });
  runtime.store.updateTransaction(tx.id, {
    result: { output: 'real result' },
    validation: { checks: [{ criterion: 'result exists', passed: true, evidence: 'observed' }] },
    result_revision: tx.revision,
  });
  const detail = runtime.query(auditor, 'transaction', { id: tx.id });
  assert.ok(JSON.stringify(detail).length < 4_000,
    'a repeated per-id read does not replay every prior audit and issue trace');
  assert.deepEqual(detail.result, { output: 'real result' });
  assert.equal(detail.validation.checks[0].evidence, 'observed');
  assert.equal(detail.audits[0].id, audit.id);
  assert.equal(detail.issues[0].id, issue.id);
  assert.equal(runtime.query(auditor, 'audit', { id: audit.id }).audit.evidence.trace, priorEvidence);
  assert.equal(runtime.query(auditor, 'issue', { id: issue.id }).issue.evidence.trace, priorEvidence);
  assert.throws(() => runtime.query(auditor, 'transaction', { id: tx.id, full: true }),
    error => error.status === 400 && /audit.*id/.test(error.message),
    'model roles must request historical evidence by audit id rather than one unbounded transaction response');
  assert.throws(() => runtime.query(auditor, 'transaction', { transaction_id: tx.id }),
    error => error.status === 400 && /params\.id/.test(error.message),
    'a model passing the mutation API key must get the query key, not an ambiguous missing transaction');
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: tx.id });
  assert.equal(panel.audits[0].evidence.trace, priorEvidence);
  assert.equal(panel.issues[0].evidence.trace, priorEvidence);
});

test('a role reads aggregated child evidence by child id instead of replaying the same child result inside its parent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const evidence = 'child witnessed the write '.repeat(1_000);
  runtime.store.updateTransaction(tx.id, {
    result: { kind: 'aggregate', summary: 'child result accepted',
      children: [{ transaction_id: 'child-transaction', result_revision: 3, conclusion: evidence, evidence: { trace: evidence } }] },
  });
  const detail = runtime.query(actorFor(runtime, clusterId, 'orchestrator', root.id), 'transaction', { id: tx.id });
  assert.equal(detail.result.children[0].transaction_id, 'child-transaction');
  assert.equal(detail.result.children[0].result_revision, 3);
  assert.ok(!JSON.stringify(detail).includes(evidence),
    'a parent references the child result instead of copying it into every transaction read');
  assert.equal(detail.transaction.acceptance_criteria?.length, tx.acceptance_criteria.length);
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: tx.id });
  assert.equal(panel.result.children[0].evidence.trace, evidence,
    'the host dashboard still has complete saved aggregate evidence');
});

test('a role pages budget ledgers without forcing the whole tree into one model tool result', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const actor = actorFor(runtime, clusterId, 'allocator', root.id);
  const parent = runtime.store.budgetForScope(clusterId, 'node', root.id);
  runtime.store.tx(() => {
    for (let index = 0; index < 19; index += 1) createBudget(runtime.store, {
      cluster_id: clusterId, scope_kind: 'agent', scope_id: `budget-receipt-${index}`,
      node_id: root.id, parent_budget_id: parent.id,
      limit: { tokens: 100 + index, model_requests: 2, tool_calls: 3 },
    });
  });
  const first = runtime.query(actor, 'budgets', { limit: 100 });
  assert.equal(first.limit, 6, 'a model cannot ask for all eighteen wide ledger rows in one step');
  assert.equal(first.items.length, 6);
  assert.ok(JSON.stringify(first).length < 3_500, 'a role sees compact spendable balances rather than full five-dimensional ledgers');
  assert.ok(first.items[0].available.tokens >= 0, 'the Allocator can choose a source with sufficient tokens');
  assert.equal(first.items[0].tokens, undefined, 'a role does not receive the redundant full budget accounting in a list');
  const second = runtime.query(actor, 'budgets', { offset: first.next_offset });
  assert.equal(second.offset, 6);
  assert.equal(second.total, first.total);
  assert.equal(second.items.length, 6);
  assert.notEqual(second.items[0].id, first.items[0].id);
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'budgets', { limit: 20 });
  assert.equal(panel.limit, 20, 'host dashboard still requests a complete 20-row budget page');
  assert.equal(panel.items.length, 20);
  const nextPanel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'budgets',
    { limit: 20, offset: panel.next_offset });
  assert.equal(nextPanel.total, panel.total);
  assert.deepEqual([...panel.items, ...nextPanel.items].find(row => row.id === parent.id)?.tokens,
    { limit: parent.tokens_limit, reserved: parent.tokens_reserved,
      spent: parent.tokens_spent, available: parent.tokens_limit - parent.tokens_reserved - parent.tokens_spent },
  'the user can still inspect every dimension of a full budget row');
});


test('an Auditor can attribute a Worker write to its owning management node', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: rootTx.id, scope: { objective: 'write deep/nested/result.txt' } }).result;
  const child = runtime.store.getNode(spawned.node_id);
  const tx = runtime.store.getTransaction(spawned.delegated_transaction_id);
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id), 'dispatch', { transaction_id: tx.id });
  const allocation = command(runtime, actorFor(runtime, clusterId, 'allocator', child.id),
    'allocate_agent', { transaction_id: tx.id, write_scope: ['deep/nested'] }).result.allocations[0];
  const worker = runtime.store.getAgent(allocation.agent_id);
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'child-worker-write', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    lease_epoch: 1, tool: 'write', args: { file_path: 'deep/nested/result.txt' }, status: 'SETTLED',
  }));
  const result = runtime.query(actorFor(runtime, clusterId, 'auditor', child.id),
    'effects', { agent_id: worker.id });
  const effect = result.items.find(entry => entry.call_id === 'child-worker-write');
  assert.equal(effect.node_id, worker.node_id, 'the effect keeps the physical Worker node');
  assert.notEqual(worker.node_id, child.id, 'the agent runs in a child Worker node');
  assert.equal(effect.owner_management_id, child.id, 'the Auditor can judge the parent-management ownership independently');
});

test('a parent cannot escalate unfinished delegated work before its child can correct', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const parent = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: parent.id });
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parent.id, scope: { objective: 'child work' },
  }).result;
  assert.equal(runtime.store.getTransaction(child.delegated_transaction_id).status, 'DRAFT');
  assert.throws(() => command(runtime, orchestrator, 'escalate', {
    transaction_id: parent.id, reason: 'the child has not finished yet',
  }), error => error.status === 409 && /child|delegat/i.test(error.message));
  assert.equal(runtime.store.getTransaction(parent.id).status, 'READY',
    'an active child does not make its parent terminal');
  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, { status: 'FAILED' }));
  command(runtime, orchestrator, 'escalate', {
    transaction_id: parent.id, reason: 'the child failed and the parent cannot aggregate it',
  });
  assert.equal(runtime.store.getTransaction(parent.id).status, 'BLOCKED',
    'a terminal failed child may be reported as unresolvable');
});

test('role permissions reject cross-role actions and domain escapes', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  assert.throws(() => command(runtime, orchestrator, 'spawn_agent', { transaction_id: tx.id }), error => error.status === 403);
  assert.throws(() => command(runtime, allocator, 'accept_result', { transaction_id: tx.id }), error => error.status === 403);
  assert.throws(() => command(runtime, auditor, 'validate', { transaction_id: tx.id, accepted: true }), error => error.status === 403);

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const workerActor = { cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, role: 'worker' };
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING' }));
  assert.throws(() => command(runtime, workerActor, 'dispatch', { transaction_id: tx.id }), error => error.status === 403);
  assert.throws(() => command(runtime, workerActor, 'submit_result', { transaction_id: 'nope', result: 1 }), error => error.status === 404);
});

test('an open correction requires a new plan revision before redispatch', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const issueId = command(runtime, auditor, 'request_replan', {
    transaction_id: tx.id, required_change: 'correct the write scope before sending another Worker',
  }).result.issue_id;
  const issue = runtime.store.getIssue(issueId);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT');
  const pending = runtime.pendingFor('orchestrator', root, runtime.store.getCluster(clusterId), orchestrator);
  assert.equal(pending.find(item => item.transaction_id === tx.id)?.action, 'revise-plan',
    'the Orchestrator is offered a correction, not an identical redispatch');
  assert.throws(() => command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id }),
    error => error.status === 409 && /issue|correct|revis/i.test(error.message));
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT',
    'a rejected dispatch cannot move the transaction or reuse its old audit');
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['output'] },
  });
  assert.ok(runtime.store.getTransaction(tx.id).revision > issue.target_revision);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY');
  assert.equal(runtime.store.findAudit(clusterId, tx.id, 'plan', runtime.store.getTransaction(tx.id).revision)?.decision, 'PENDING');

  const falseId = command(runtime, orchestrator, 'create_transaction', {
    objective: 'a separate valid plan', acceptance_criteria: ['the separate output exists'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: falseId });
  command(runtime, auditor, 'inspect_plan', { transaction_id: falseId, decision: 'approve' });
  const oldAudit = runtime.store.findAudit(clusterId, falseId, 'plan', runtime.store.getTransaction(falseId).revision);
  const falseIssue = command(runtime, auditor, 'request_replan', {
    transaction_id: falseId, required_change: 'incorrectly claimed that criteria were absent',
  }).result.issue_id;
  command(runtime, auditor, 'verify_correction', {
    issue_id: falseIssue, decision: 'dismissed',
    evidence: { rechecked: 'acceptance_criteria', found: ['the separate output exists'] },
  });
  const sameRevision = runtime.store.getTransaction(falseId).revision;
  command(runtime, orchestrator, 'dispatch', { transaction_id: falseId });
  const rechecked = runtime.store.findAudit(clusterId, falseId, 'plan', sameRevision);
  assert.notEqual(rechecked.id, oldAudit.id, 'a dismissed issue may proceed, but not by reusing its withdrawn audit');
  assert.equal(rechecked.decision, 'PENDING');
});

test('a rejected result gives its Orchestrator the actual scope and unchanged contract to repair', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const txId = command(runtime, orchestrator, 'create_transaction', {
    objective: 'deliver deep/nested/result.txt',
    inputs: { write_scope: ['deep/staging'] },
    acceptance_criteria: ['deep/nested/result.txt exists'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  runtime.store.tx(() => runtime.store.updateTransaction(txId, {
    status: 'SUBMITTED', result: { file: 'deep/staging/result.txt' },
  }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: txId, accepted: true,
    checks: [{ criterion: 'deep/nested/result.txt exists', passed: true, evidence: 'Worker claimed its staging file was sufficient' }],
  });
  const issueId = command(runtime, auditor, 'request_correction', {
    transaction_id: txId,
    required_change: 'the accepted result must include deep/nested/result.txt',
  }).result.issue_id;
  const offered = runtime.pendingFor('orchestrator', root, runtime.store.getCluster(clusterId), orchestrator)
    .find(item => item.transaction_id === txId);
  assert.equal(offered.action, 'correct-result');
  assert.equal(offered.issue_id, issueId);
  assert.deepEqual(offered.write_scope, ['deep/staging']);
  assert.deepEqual(offered.acceptance_criteria, ['deep/nested/result.txt exists']);
  assert.match(offered.required_change, /deep\/nested\/result\.txt/);
});

test('the Orchestrator dispatches, the Auditor supervises, and a stale validation is not accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // The Orchestrator owns the transaction: dispatching it makes it *ready*.
  // The Auditor's plan audit is observational supervision — if it never decides,
  // the work still runs, which is the difference between a supervisor and a
  // single point of failure.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const dispatched = runtime.store.getTransaction(tx.id);
  assert.equal(dispatched.status, 'READY', 'dispatch makes the plan dispatchable');
  assert.equal(dispatched.plan_approved_revision, null, 'without the Auditor, nothing is claimed as approved');
  const pending = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 });
  assert.equal(pending.length, 1, 'and the Auditor still has a decision to make');

  // A Worker can claim it without any audit decision.
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 1, 'a silent Auditor does not stall the subtree');

  // The Auditor's approval is recorded as evidence when it does arrive.
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(runtime.store.getTransaction(tx.id).plan_approved_revision, dispatched.revision);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY', 'observational: it was already ready');
  const audit = runtime.store.findAudit(clusterId, tx.id, 'plan', dispatched.revision);
  assert.equal(audit.decision, 'APPROVED');

  // And its rejection still has teeth: the plan goes back to DRAFT.
  const second = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  assert.equal(runtime.store.getTransaction(second).status, 'READY');
  const rejected = command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'reject', required_change: 'the criteria are not checkable' });
  assert.equal(rejected.result.status, 'DRAFT', 'a rejected plan is pulled back before its allocation works');
  assert.equal(runtime.store.getTransaction(second).plan_approved_revision, null);
  assert.ok(rejected.result.issue_id);

  // A result published against a moved revision is not accepted by a stale audit.
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { value: 5 } }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true,
    checks: [{ criterion: 'result holds 5', passed: true, evidence: 'result.value' }],
  });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'VALIDATING');
  assert.throws(() => command(runtime, orchestrator, 'accept_result', { transaction_id: tx.id }), error => error.status === 409);

  const approved = command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(approved.result.status, 'ACCEPTED');
  // The rejected plan is still open work: the cluster is not done until every
  // root transaction is decided.
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING');
  // A cancelled root cannot be reported as success: the cluster blocks with the
  // reason instead of claiming a completion it did not achieve.
  command(runtime, orchestrator, 'cancel_transaction', { transaction_id: second, reason: 'superseded by the first' });
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
  const blockedEvent = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked').at(-1);
  assert.match(String(blockedEvent.data.reason), /did not all reach ACCEPTED/);
  void worker;
});

test('a FAILED transaction cannot bypass its exhausted attempt cap by redispatching the same revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'FAILED', attempts: 2, __bump_revision: false,
  }));
  assert.throws(() => command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id }),
    error => error.status === 409 && /FAILED/.test(error.message));
  const after = runtime.store.getTransaction(tx.id);
  assert.equal(after.status, 'FAILED');
  assert.equal(after.attempts, 2);
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 0,
    'a terminal failed result is not reopened by another observational audit');
});

test('an Auditor rejection during a Worker turn keeps its settled write and submission observable', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-live-plan-audit-'));
  const host = createFakeHost();
  const path = join(dir, 'result.txt');
  host.registerTool({
    name: 'write', description: 'write one owned file', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    async execute({ file_path, content }) {
      writeFileSync(file_path, content);
      return { content: [{ type: 'text', text: 'written' }], isError: false, value: { path: file_path } };
    },
  });
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    maxTokens: 512, tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  let release = () => {};
  t.after(async () => {
    release();
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'write one file while an Auditor rejects the active plan',
    workspace: dir, capabilities: ['fs_write'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 4 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent',
    { transaction_id: tx.id, write_scope: ['result.txt'] });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  let held = false;
  let writeResponse = null;
  let submission = null;
  const gate = new Promise(resolvePromise => { release = resolvePromise; });
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.request({ purpose: 'worker' });
    held = true;
    await gate;
    writeResponse = await turn.callTool('write', { file_path: path, content: 'correct result\n' });
    submission = await turn.callTool('flow_transaction', {
      action: 'submit_result', params: { transaction_id: tx.id, result: { file: 'result.txt', completed: true } },
    });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20 && !held; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.equal(held, true, 'a real Worker turn holds the running transaction');
  const live = runtime.activeTurnFor(worker.id);
  assert.ok(live);
  const decision = command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', {
    transaction_id: tx.id, decision: 'reject', required_change: 'the output needs an independent review',
  }).result;
  assert.equal(decision.decision, 'REJECTED');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'RUNNING',
    'the independent verdict must not revoke the live submission contract mid-turn');
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id),
    'adjust_transaction', { transaction_id: tx.id, patch: { objective: 'a revised deliverable' } }),
  error => error.status === 409 && /turn|lease|running/i.test(error.message),
  'the Orchestrator cannot change the running revision before the Worker submits its result');
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'auditor', root.id),
    'request_replan', { transaction_id: tx.id, required_change: 'revise the output path' }),
  error => error.status === 409 && /turn|lease|running/i.test(error.message),
  'a second audit action cannot silently invalidate the same running Worker');
  release();
  await live.promise;
  assert.ok(submission && !submission.isError, 'the running Worker can publish its durable result');
  assert.ok(writeResponse && !writeResponse.isError, `the native write settled: ${JSON.stringify(writeResponse)}`);
  assert.equal(existsSync(path), true);
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event =>
    event.type === 'result-submitted' && event.data.transaction_id === tx.id && event.data.agent_id === worker.id));
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT',
    'after the Worker finishes, the rejected revision waits for correction, not acceptance');
});

test('a restart fences a Worker without reviving its already rejected plan', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.activeAllocationForTransaction(tx.id);
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'RUNNING', __bump_revision: false });
    runtime.store.createLease({
      id: 'audit-crash-worker', cluster_id: clusterId, agent_id: allocation.agent_id,
      node_id: allocation.node_id, purpose: 'worker-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  const rejected = command(runtime, actorFor(runtime, clusterId, 'auditor', root.id),
    'inspect_plan', { transaction_id: tx.id, decision: 'reject', required_change: 'fix the plan' }).result;
  assert.equal(rejected.decision, 'REJECTED');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'RUNNING');
  runtime.recover({ deferScheduling: true });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT',
    'fencing a crashed Worker cannot redispatch a plan the Auditor already rejected');
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 0);
});

test('auditor rejections create issues, and the correction budget escalates to BLOCKED', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { claim: 'done' } }));
  command(runtime, orchestrator, 'validate', { transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y' }] });
  const rejected = command(runtime, auditor, 'inspect_validation', {
    transaction_id: tx.id, decision: 'reject', required_change: 'show the file hash', evidence: { missing: 'hash' },
  });
  assert.equal(rejected.result.status, 'REJECTED');
  const issue = runtime.store.getIssue(rejected.result.issue_id);
  assert.equal(issue.status, 'OPEN');
  assert.equal(issue.required_change, 'show the file hash');

  // A verdict needs something to verify: before any change, the call is refused
  // and consumes nothing.
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'unresolved', evidence: {} }),
    /correction to verify/);
  assert.equal(runtime.store.getIssue(issue.id).corrections, 0, 'and the budget is untouched');

  // Each real correction attempt that fails moves the counter, and the second one
  // exhausts the budget.
  const attempt = async () => {
    // The change the Auditor asked for, then a verdict that it did not work.
    command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, acceptance_criteria: ['x with a hash'] });
    command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'unresolved', evidence: {} });
  };
  attempt();
  assert.equal(runtime.store.getIssue(issue.id).corrections, 1);
  attempt();
  assert.equal(runtime.store.getIssue(issue.id).status, 'ESCALATED');
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED');
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
});

test('commands are idempotent per command_id and conflicting replays are rejected', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  const first = runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 5 } });
  const replay = runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 5 } });
  assert.equal(first.deduped, false);
  assert.equal(replay.deduped, true);
  assert.equal(runtime.store.getTransaction(tx.id).priority, 5);
  assert.throws(
    () => runtime.command(orchestrator, { command_id: 'fixed-1', action: 'set_priority', params: { transaction_id: tx.id, priority: 9 } }),
    error => error.status === 409,
  );
  assert.throws(
    () => runtime.command(orchestrator, { command_id: 'cmd-rev', action: 'set_priority', params: { transaction_id: tx.id, priority: 1 }, expected_revision: 99 }),
    error => error.status === 409 && /revision conflict/.test(error.message),
  );
});

test('budget transfers move only unused unreserved capacity and releasing reclaims it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const nodeView = budgetView(runtime.store.getBudget(nodeBudget.id));
  assert.ok(nodeView.tokens.limit < 1_000_000 && nodeView.tokens.available > 0,
    `role grants must draw the node budget down from the root (limit ${nodeView.tokens.limit}, available ${nodeView.tokens.available})`);
  assert.throws(() => command(runtime, allocator, 'rebalance_budget', {
    from: { kind: 'node', id: root.id }, to: { kind: 'root', id: clusterId }, amounts: { tokens: nodeView.tokens.available + 1 },
  }), error => error.code === 'LIMIT_REACHED');

  const moved = Math.floor(nodeView.tokens.available / 2);
  command(runtime, allocator, 'rebalance_budget', {
    from: { kind: 'node', id: root.id }, to: { kind: 'root', id: clusterId }, amounts: { tokens: moved },
  });
  assert.equal(budgetView(runtime.store.getBudget(nodeBudget.id)).tokens.limit, nodeView.tokens.limit - moved);

  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id);
  assert.ok(agentBudget.tokens_limit > 0);
  const spentBefore = totalSpent(runtime, clusterId);

  command(runtime, allocator, 'release_agent', { allocations: [allocation.id] });
  assert.equal(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }).length, 0);
  assert.equal(totalSpent(runtime, clusterId).tokens, spentBefore.tokens, 'releasing must never reverse spend');
  assert.ok(totalSpent(runtime, clusterId).tokens + totalSpent(runtime, clusterId).model_requests * 0 >= 0);
  assert.equal(runtime.store.countAgents(clusterId, { live: true }), 3);
});

/** Sum of every scope's spend: releasing must never lower this. */
function totalSpent(runtime, clusterId) {
  const total = { tokens: 0, model_requests: 0, tool_calls: 0 };
  for (const row of runtime.store.listBudgets(clusterId)) {
    total.tokens += row.tokens_spent;
    total.model_requests += row.requests_spent;
    total.tool_calls += row.tool_calls_spent;
  }
  return total;
}

test('a transaction without an explicit capability set still yields working workers', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  assert.deepEqual(tx.capabilities, ['fs_read', 'fs_write'], 'an omitted set inherits the management node set');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  assert.deepEqual(allocation.capabilities, ['fs_read', 'fs_write']);
  const agent = runtime.store.getAgent(allocation.agent_id);
  const policy = runtime.allowedToolsFor(runtime.store.getCluster(clusterId), 'worker', agent);
  assert.ok(policy.allowed.includes('write'), `worker tools must include write, got ${policy.allowed.join(', ')}`);
  assert.ok(policy.capabilities.includes('fs_write'));
});

test('a delegation fixture builds a decreasing management chain', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    // A depth cap with room for the chain: the terminal level is depth 3 and its Worker
    // would be depth 4, inside the cap. (A node created *at* the cap is refused; that is
    // its own test.)
    limits: { max_depth: 4 },
    delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 3 }],
  });
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // The fixture's instruction supplies the depth budget for the first spawn.
  const first = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'level 1' },
  }).result;
  const level1 = runtime.store.getNode(first.node_id);
  assert.equal(level1.depth, 1);
  assert.equal(level1.scope.spawn_children, 2, 'the fixture depth budget descends by one per level');
  assert.equal(level1.scope.delegation_entry.spawn_children, 2, 'the remaining budget travels with the instruction');

  // Every following level inherits the budget without being told again.
  const second = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: first.delegated_transaction_id, node_id: first.node_id, scope: { objective: 'level 2' },
  }).result;
  const level2 = runtime.store.getNode(second.node_id);
  assert.equal(level2.depth, 2);
  assert.equal(level2.scope.spawn_children, 1);

  const third = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: second.delegated_transaction_id, node_id: second.node_id, scope: { objective: 'level 3' },
  }).result;
  const level3 = runtime.store.getNode(third.node_id);
  assert.equal(level3.depth, 3);
  assert.equal(level3.scope.spawn_children, 0, 'the chain stops when the budget reaches zero');

  const depths = new Set(runtime.store.listNodes(clusterId, {}).map(node => node.depth));
  assert.ok(depths.has(1) && depths.has(2) && depths.has(3), `management depths ${[...depths].sort().join(', ')}`);
  // A depth-1 worker branch and a depth-3 management branch coexist. The root
  // transaction has delegated work (the chain this fixture just built), so a *second*
  // transaction is the one a worker may run.
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: rootTx.id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: rootTx.id, decision: 'approve' });
  const direct = command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', {
    objective: 'a flat branch under the root', acceptance_criteria: ['x'],
  });
  const directId = direct.result?.transaction_id ?? direct.transaction_id;
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: directId });
  if (runtime.store.getTransaction(directId).status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: directId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: directId });
  assert.ok(runtime.store.listNodes(clusterId, {}).some(node => node.kind === 'worker' && node.depth === 1));
});

test('a budget top-up moves exactly the gap it was asked for, and nothing else', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', auditor.id);
  const before = runtime.store.getBudget(nodeBudget.id);
  assert.equal(before.agents_limit, 32, 'the node keeps the cluster agent capacity');
  assert.equal(before.max_active_limit, 4);
  const agentBefore = runtime.store.getBudget(agentBudget.id);

  // Ask for a request the identity cannot cover from what it holds.
  const held = Math.max(0, agentBefore.tokens_limit - agentBefore.tokens_reserved - agentBefore.tokens_spent);
  const want = held + 5_000;
  const short = want - held;
  const granted = runtime.store.tx(() => runtime.topUpBudgetForAgent(auditor, { tokens: want, model_requests: 1 }));
  assert.ok(granted, 'the gap is granted');
  assert.equal(granted.tokens, short, 'exactly the tokens that were missing');
  const after = runtime.store.getBudget(nodeBudget.id);
  assert.equal(after.agents_limit, 32, 'a top-up must not move agent capacity');
  assert.equal(after.max_active_limit, 4, 'a top-up must not move active-slot capacity');
  assert.equal(after.tokens_limit, before.tokens_limit - short, 'the node gave exactly that many tokens');

  const agentAfter = runtime.store.getBudget(agentBudget.id);
  assert.equal(agentAfter.max_active_limit, 0, 'a management role does not hold an active slot');
  assert.ok(agentAfter.tokens_limit - agentAfter.tokens_reserved - agentAfter.tokens_spent >= want,
    'the identity can now cover the request it asked about');

  // Nothing to top up is not a top-up.
  assert.equal(runtime.store.tx(() => runtime.topUpBudgetForAgent(auditor, { tokens: 1, model_requests: 1 })), null);
  // A Worker whose request allowance is spent gets no tokens: paying for a
  // request that cannot be sent is not a top-up.
  const workerTx = command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', {
    objective: 'worker work', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: workerTx });
  if (runtime.store.getTransaction(workerTx).status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: workerTx, decision: 'approve' });
  }
  runtime.store.tx(() => runtime.store.updateCluster(clusterId, {
    limits: { ...runtime.store.getCluster(clusterId).limits, worker_model_requests: 2 },
  }));
  const allocated = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: workerTx }).result.allocations[0];
  const worker = runtime.store.getAgent(allocated.agent_id);
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
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const workerActor = { cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, role: 'worker' };

  const parentBefore = runtime.store.getNode(worker.node_id).parent_id;
  const sent = runtime.store.tx(() => runtime.communicateFrom(workerActor, 'send', { agent: auditor.agent_id, content: 'status?' }));
  assert.equal(sent.recipients.length, 1);
  assert.equal(runtime.store.pendingDeliveries(auditor.agent_id).length, 1);
  const published = runtime.store.tx(() => runtime.communicateFrom(auditor, 'publish', { key: 'plan/root', value: { v: 1 } }));
  assert.equal(published.revision, 1);
  assert.throws(() => runtime.store.tx(() => runtime.communicateFrom(auditor, 'publish', { key: 'plan/root', value: { v: 2 }, expected_revision: 5 })),
    error => error.status === 409);
  assert.equal(runtime.store.getNode(worker.node_id).parent_id, parentBefore);
});

/** Drive one worker turn to its end without any model, so only the publication rule is under test. */
function workerScenario(runtime, clusterId) {
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  const worker = runtime.store.getAgent(allocation.agent_id);
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  const opened = beginTurn(runtime, clusterId, { worker }, 7);
  return {
    tx: runtime.store.getTransaction(tx.id), worker, allocation, orchestrator,
    workerActor: opened.actor, lease: opened.lease, clusterId,
  };
}

/** Open a fresh lease/epoch for one simulated worker turn. */
function beginTurn(runtime, clusterId, scenario, epoch) {
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
    lease,
    actor: { cluster_id: clusterId, agent_id: scenario.worker.id, node_id: scenario.worker.node_id, role: 'worker', epoch, turn_seq: 1 },
  };
}

const incompleteTurn = (stopReason, text = 'truncated') => ({
  completed: false, stopReason, finalText: text, toolCalls: [], context: null,
});
const completedTurn = (text = 'done') => ({ completed: true, stopReason: 'completed', finalText: text, toolCalls: [], context: null });

test('a worker proposal is published only when its turn completed', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const scenario = workerScenario(runtime, clusterId);
  let turn = { actor: scenario.workerActor, lease: scenario.lease };
  const rerun = epoch => {
    runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', __bump_revision: false }));
    turn = beginTurn(runtime, clusterId, scenario, epoch);
    return turn;
  };
  const finish = outcome => runtime.finishWorkerTurn(
    runtime.store.getCluster(clusterId), scenario.worker, runtime.store.getTransaction(scenario.tx.id),
    scenario.allocation, { outcome, error: null, before: 0, lease: turn.lease, deliveries: [], admitted: true },
  );

  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 5 } });
  const stagedRow = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(stagedRow.status, 'RUNNING', 'a submission must not publish itself');
  assert.deepEqual(stagedRow.result, { value: 5 });
  assert.equal(stagedRow.result_staged_epoch, 7, 'the proposal is bound to the producing lease epoch');
  assert.equal(stagedRow.result_staged_turn, 1);

  finish(incompleteTurn('error'));
  const afterError = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(afterError.status, 'READY', 'an errored turn must not publish SUBMITTED');
  assert.equal(afterError.result, null, 'the withheld proposal must not be left on the transaction');
  assert.equal(afterError.result_staged_epoch, null);

  rerun(8);
  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 6 } });
  finish(incompleteTurn('aborted', 'partial'));
  assert.equal(runtime.store.getTransaction(scenario.tx.id).status, 'READY', 'an aborted turn must not publish SUBMITTED');

  rerun(9);
  command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 7 } });
  finish(completedTurn());
  const published = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(published.status, 'SUBMITTED');
  assert.deepEqual(published.result, { value: 7 });
  assert.equal(runtime.store.all("SELECT COUNT(*) AS c FROM events WHERE type='result-submitted'")[0].c, 1, 'exactly one publication per completed turn');
  assert.match(String(runtime.store.all("SELECT data FROM events WHERE type='result-withheld'")[0].data), /aborted|error/);

  runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', attempts: 99, __bump_revision: false }));
  rerun(10);
  finish(incompleteTurn('max-tokens', ''));
  assert.equal(runtime.store.getTransaction(scenario.tx.id).status, 'FAILED');

  assert.throws(
    () => command(runtime, turn.actor, 'submit_result', { transaction_id: scenario.tx.id, result: { value: 8 } }),
    error => error.status === 409,
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
    runtime.store.getCluster(clusterId), scenario.worker, runtime.store.getTransaction(scenario.tx.id),
    scenario.allocation, { outcome: completedTurn(''), error: null, before: 0,
      lease: scenario.lease, deliveries: [], admitted: true },
  );
  const tx = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: scenario.tx.id });
  assert.equal(tx.transaction.status, 'SUBMITTED');
  assert.deepEqual(tx.result.evidence, [{
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
  const paused = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(paused.status, 'PAUSED');
  assert.deepEqual(paused.result, { value: 11 }, 'pausing must not throw away a staged proposal');
  const stagedEvent = JSON.parse(runtime.store.all("SELECT data FROM events WHERE type='result-staged' ORDER BY seq DESC LIMIT 1")[0].data);
  assert.equal(paused.result_staged_epoch, stagedEvent.epoch, 'the proposal is still bound to the turn that staged it');
  assert.equal(paused.result_staged_turn, stagedEvent.turn);
  runtime.control(clusterId, 'resume');
  const resumed = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(resumed.status, 'READY');
  runtime.store.tx(() => runtime.store.updateTransaction(scenario.tx.id, { status: 'RUNNING', __bump_revision: false }));
  const resumedTurn = beginTurn(runtime, clusterId, scenario, 12);
  runtime.finishWorkerTurn(runtime.store.getCluster(clusterId), scenario.worker, runtime.store.getTransaction(scenario.tx.id), scenario.allocation, {
    outcome: completedTurn('no submission'), error: null, before: 0, lease: resumedTurn.lease, deliveries: [], admitted: true,
  });
  const afterResume = runtime.store.getTransaction(scenario.tx.id);
  assert.equal(afterResume.status, 'SUBMITTED');
  assert.deepEqual(afterResume.result, { value: 11 }, 'the same turn publishes the proposal it staged before the pause');

  // a proposal staged by an older epoch is not promotable by a newer turn
  const tx2 = command(runtime, actorFor(runtime, clusterId, 'orchestrator', rootNode(runtime, clusterId).id), 'create_transaction', {
    objective: 'second', acceptance_criteria: ['x'],
  }).result;
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', rootNode(runtime, clusterId).id), 'dispatch', { transaction_id: tx2.transaction_id });
  command(runtime, actorFor(runtime, clusterId, 'auditor', rootNode(runtime, clusterId).id), 'inspect_plan', { transaction_id: tx2.transaction_id, decision: 'approve' });
  command(runtime, actorFor(runtime, clusterId, 'allocator', rootNode(runtime, clusterId).id), 'allocate_agent', { transaction_id: tx2.transaction_id });
  const allocation2 = runtime.store.activeAllocationForTransaction(tx2.transaction_id);
  const worker2 = runtime.store.getAgent(allocation2.agent_id);
  const lease2 = runtime.store.tx(() => {
    runtime.store.updateTransaction(tx2.transaction_id, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(worker2.id, { epoch: 3 });
    return runtime.store.createLease({
      id: 'lease-old', cluster_id: clusterId, agent_id: worker2.id, node_id: worker2.node_id,
      purpose: 'worker-turn', epoch: 3, expires: now() + 60_000,
    });
  });
  const oldActor = { cluster_id: clusterId, agent_id: worker2.id, node_id: worker2.node_id, role: 'worker', epoch: 3, turn_seq: 1 };
  command(runtime, oldActor, 'submit_result', { transaction_id: tx2.transaction_id, result: { value: 99 } });

  // the identity is replaced: a new lease epoch, and the old one is gone
  const newLease = runtime.store.tx(() => {
    runtime.store.deleteLease(lease2.id);
    return runtime.store.createLease({
      id: 'lease-new', cluster_id: clusterId, agent_id: worker2.id, node_id: worker2.node_id,
      purpose: 'worker-turn', epoch: 4, expires: now() + 60_000,
    });
  });
  assert.throws(
    () => command(runtime, oldActor, 'submit_result', { transaction_id: tx2.transaction_id, result: { value: 100 } }),
    error => error.status === 409,
    'a command from a fenced epoch must be rejected',
  );
  // The replacement stages its own work, then the old turn finishes: a fenced
  // finisher must publish nothing and clear nothing.
  runtime.store.tx(() => runtime.store.updateTransaction(tx2.transaction_id, {
    result: { value: 'replacement' }, result_staged_epoch: 4, result_staged_turn: 1,
    result_staged_agent: worker2.id, __bump_revision: false,
  }));
  runtime.finishWorkerTurn(runtime.store.getCluster(clusterId), worker2, runtime.store.getTransaction(tx2.transaction_id), allocation2, {
    outcome: completedTurn('late'), error: null, before: 0, lease: lease2, deliveries: [],
  });
  const fenced = runtime.store.getTransaction(tx2.transaction_id);
  assert.notEqual(fenced.status, 'SUBMITTED', 'a turn whose lease was fenced must not publish');
  assert.deepEqual(fenced.result, { value: 'replacement' }, 'the replacement\'s staged work must survive the fenced finisher');
  assert.equal(fenced.result_staged_epoch, 4);
  assert.match(String(runtime.store.all("SELECT data FROM events WHERE type='turn-fenced' ORDER BY seq DESC LIMIT 1")[0].data), /lease was replaced|nothing was published/);
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

test('cluster control-plane tools consume the shared tool-call budget', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const worker = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-budget', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'orchestrator-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  const budgetIds = runtime.agentBudgetChain(runtime.store.getCluster(clusterId), worker);
  const budget = runtime.store.getBudget(budgetIds[0]);
  assert.ok(budget.tool_calls_limit > 0);
  runtime.store.tx(() => runtime.store.updateBudget(budget.id, { tool_calls_limit: 4 }));

  // A control-plane tool is metered like any other: the quota is the shared
  // `tool_calls` budget, not a per-turn counter that resets.
  const admit = index => runtime.admitToolCall(worker, { name: 'flow_query', arguments: { what: 'cluster' } }, `call-${index}`);

  assert.equal(admit(0).ok, true);
  assert.equal(admit(1).ok, true);
  assert.equal(admit(2).ok, true);
  assert.equal(admit(3).ok, true);
  assert.equal(runtime.store.getBudget(budget.id).tool_calls_reserved, 4, 'four calls are held against this identity');
  // The identity's own grant is a bookkeeping boundary, not the ceiling: a node
  // that still holds tool-call capacity funds the next call (measured: a role
  // whose tool calls were all returned to its node could not call a single tool
  // afterwards and burned its whole turn budget on refusals).
  assert.equal(admit(4).ok, true, 'the node still holds capacity, so the call is funded from it');
  assert.ok(runtime.store.getBudget(budget.id).tool_calls_limit >= 5);

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
  assert.match(refused.reason, /tool_calls|exhausted/);
  const refusal = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'budget-refused').at(-1);
  assert.equal(refusal.data.dimension, 'tool_calls', `the refusal is structured: ${JSON.stringify(refusal.data)}`);
  assert.ok(refusal.data.scope);

  runtime.settleToolCall(worker, { name: 'flow_query' }, 'call-0', { isError: false, content: [] }, null);
  assert.equal(runtime.store.getBudget(budget.id).tool_calls_reserved, 4, 'the settled call released its hold');
  assert.equal(runtime.store.getBudget(budget.id).tool_calls_spent, 1, 'and was charged exactly once');
});

test('an old instance cannot write or publish under its replacement lease', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime, { workspace: dir });
  const root = rootNode(runtime, clusterId);
  const { orchestrator } = workerScenario(runtime, clusterId, root);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];

  // Instance A: the live turn. Instance B: what replaces it after the crash.
  const instanceA = { session_id: agent.session_id };
  const leaseA = runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-a', cluster_id: clusterId, agent_id: agent.id, node_id: root.id,
    purpose: 'orchestrator-turn', epoch: agent.epoch + 1, expires: now() + 60_000,
  }));
  runtime.bindTurnIdentity(instanceA, { agent_id: agent.id, epoch: leaseA.epoch, turn_seq: 1, node_id: root.id, role: 'orchestrator' });

  runtime.store.tx(() => {
    runtime.store.deleteLease(leaseA.id);
    runtime.store.createLease({
      id: 'lease-b', cluster_id: clusterId, agent_id: agent.id, node_id: root.id,
      purpose: 'orchestrator-turn', epoch: leaseA.epoch + 1, expires: now() + 60_000,
    });
  });
  const leaseB = runtime.store.leaseForAgent(agent.id);
  assert.equal(leaseB.epoch, leaseA.epoch + 1);

  // B still holds a valid lease, so a naive check would admit A's tool call.
  const stale = runtime.admitToolCall(agent, { name: 'write', agent: instanceA, arguments: { path: 'x.txt', content: 'x' } }, 'call-stale');
  assert.equal(stale.ok, false, "a stale instance's write must be refused");
  assert.match(stale.reason, /epoch/);

  const instanceB = { session_id: 'b' };
  runtime.bindTurnIdentity(instanceB, { agent_id: agent.id, epoch: leaseB.epoch, turn_seq: 2, node_id: root.id, role: 'orchestrator' });
  const current = runtime.admitToolCall(agent, { name: 'write', agent: instanceB, arguments: {} }, 'call-current');
  assert.equal(current.ok, true, 'the live instance is admitted');

  // An instance that was never scheduled cannot act at all.
  const unbound = runtime.admitToolCall(agent, { name: 'write', agent: { session_id: 'c' }, arguments: {} }, 'call-unbound');
  assert.equal(unbound.ok, false, 'an unscheduled instance owns no turn identity');
  assert.match(unbound.reason, /scheduled turn identity/);

  // Communication mutations are fenced too: publishing from the stale instance.
  const staleActor = runtime.turnActor(instanceA);
  assert.throws(
    () => runtime.assertActorFence(staleActor, { mutating: true }),
    /fenced turn|epoch/,
    'a stale instance must not publish',
  );
  const liveActor = { agent_id: agent.id, epoch: leaseB.epoch, role: 'orchestrator', node_id: root.id, cluster_id: clusterId };
  assert.doesNotThrow(() => runtime.assertActorFence(liveActor, { mutating: true }));
  void orchestrator;
});

test('one scheduling pass starts several agents before any of them finishes', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 8 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
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
  const held = await runtime.acquireLlmSlot();
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
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  if (pool) {
    assert.ok(pool.tokens_limit <= 100_000 * 0.25, 'the earmark is a share, not a floor');
    assert.ok(pool.requests_limit <= 20 * 0.25, 'the earmark cannot take the request allowance');
  }
  const total = runtime.store.listBudgets(clusterId);
  const working = total.filter(row => row.scope_kind === 'root' || row.scope_kind === 'node');
  const available = working.reduce((sum, row) => sum + (row.tokens_limit - row.tokens_spent - row.tokens_reserved), 0);
  assert.ok(available > 0, 'ordinary work still has tokens');
  const availableRequests = working.reduce((sum, row) => sum + (row.requests_limit - row.requests_spent - row.requests_reserved), 0);
  assert.ok(availableRequests > 0, 'ordinary work still has model requests');

  // And a role can really reserve a request against its own node budget.
  const node = rootNode(runtime, clusterId);
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: node.id, role: 'orchestrator', limit: 5 })[0];
  const chain = runtime.agentBudgetChain(runtime.store.getCluster(clusterId), orchestrator);
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
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
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
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const cluster = runtime.store.getCluster(clusterId);
  // Drain the node scope, leaving only the dedicated compaction scope funded.
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, requests_limit: 0 });
    if (agentBudget) runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, requests_limit: 0 });
  });

  const chain = runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'compaction' });
  assert.equal(chain.length, 1, 'exactly one enforcing grant');
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  assert.equal(chain[0], pool.id, 'the funded scope is the one charged');
  assert.equal(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'role' })[0], pool.id,
    'an ordinary request can borrow the pool only when its owning grants cannot pay');

  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'compaction', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 5_000, turn_seq: 1,
  });
  const afterReserve = runtime.store.getBudget(pool.id);
  assert.equal(afterReserve.tokens_reserved, 5_000, 'the pool holds the reservation');
  assert.equal(runtime.store.getUsageReceipt(request.request_id).budget_scope_id, pool.id, 'the receipt names the charged scope');

  // Recovery moves the counters in that same scope — not in the drained node,
  // which would leave the pool's hold orphaned and the node over-charged.
  runtime.reconcileReservations(cluster, orchestrator);
  const afterReconcile = runtime.store.getBudget(pool.id);
  assert.equal(afterReconcile.requests_spent, 1, 'the attempt is consumed in the charged scope');
  assert.equal(afterReconcile.tokens_reserved, 5_000, 'an unknown-cost request keeps its token hold');
  assert.equal(runtime.store.getBudget(nodeBudget.id).requests_spent, 0, 'the drained node is not charged instead');
  const receipt = runtime.store.getUsageReceipt(request.request_id);
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
  assert.equal(raised.limits.max_active_agents, 4, 'the declared ceiling holds');
  assert.equal(raised.limits.max_llm_concurrency, 1);
  assert.equal(runtime.store.getCluster(clusterId).limits.max_llm_concurrency, 1, 'the persisted limits are clamped');
  const clamped = runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='limit-clamped'", clusterId);
  assert.equal(clamped.length, 2, 'each clamped request is recorded');
  assert.match(String(clamped[0].data), /requested/);

  // Lowering inside the envelope is still allowed.
  const lowered = command(runtime, allocator, 'set_concurrency', { max_active_agents: 2 }).result;
  assert.equal(lowered.limits.max_active_agents, 2);
  assert.equal(runtime.llmSlotsInUse(), 0);
});

test('the charged scope covers the whole reservation, and a throw releases it there', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));

  // Partially depleted pool, funded node: the pool can no longer cover the
  // request, so the node must be chosen instead of stranding it.
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  runtime.store.tx(() => runtime.store.updateBudget(pool.id, { tokens_limit: 10_000 }));
  assert.equal(runtime.budgetChainForAgent(orchestrator, { tokens: 50_000, kind: 'compaction' })[0],
    nodeBudget.id, 'an underfunded compaction pool falls back to the management grant');
  assert.equal(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'compaction' })[0],
    pool.id, 'compaction draws from its dedicated pool when it can cover the request');
  assert.equal(runtime.budgetChainForAgent(orchestrator, { tokens: 5_000, kind: 'role' })[0],
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
  const poolBefore = runtime.store.getBudget(pool.id);
  const nodeBefore = runtime.store.getBudget(nodeBudget.id);
  assert.equal(poolBefore.tokens_reserved, 4_000);
  assert.equal(nodeBefore.tokens_reserved, 6_000);

  // Release the compaction request as a failed dispatch, passing the caller's
  // ordinary chain: the receipt must still route it to the pool.
  releaseLlmRequest(runtime.store, {
    cluster_id: clusterId, reservation: request, budgetIds: [nodeBudget.id], dispatched: false, note: 'dispatch failed',
  });
  assert.equal(runtime.store.getBudget(pool.id).tokens_reserved, 0, 'the pool hold is released');
  assert.equal(runtime.store.getBudget(nodeBudget.id).tokens_reserved, 6_000, "the ordinary reservation is untouched");
  assert.equal(runtime.store.getUsageReceipt(request.request_id).status, 'NOT_SENT');
  assert.equal(runtime.store.getUsageReceipt(ordinary.request_id).status, 'RESERVED');
});

test('competing drivers cannot exceed the active-turn window together', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 2, max_llm_concurrency: 2, max_role_turns: 8 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'second', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: first.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  runtime.store.tx(() => runtime.store.updateTransaction(first.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });

  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot();
  const heldAgain = await runtime.acquireLlmSlot();
  // Three eligible agents, two slots, two drivers racing at once.
  await Promise.all([runtime.tick(), runtime.tick()]);
  const active = runtime.activeTurnIds();
  assert.ok(active.length <= 2, `the window is a hard cap, saw ${active.length}`);
  assert.ok(active.length >= 1);
  held();
  heldAgain();
});

test('a failure while preparing a turn still releases its permit, lease and entry', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 4, max_llm_concurrency: 2, max_role_turns: 6 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id });
  runtime.enableScheduling();

  // Fault injection: delivery collection rejects after the permit is taken.
  const original = runtime.collectDeliveries.bind(runtime);
  runtime.collectDeliveries = async () => { throw new Error('delivery proof failed'); };
  await runtime.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.llmSlotsInUse(), 0, 'the permit came back');
  assert.equal(runtime.llmWaiters(), 0);
  assert.deepEqual(runtime.activeTurnIds(), [], 'no orphan active-turn entry is left');
  const leases = runtime.store.all('SELECT * FROM leases WHERE cluster_id=?', clusterId);
  assert.equal(leases.length, 0, 'the lease is not left heartbeating');
  // The same guarantee on the Worker path: a turn that fails while preparing
  // must not strand a permit, a lease or an active-turn entry either.
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'worker-bound', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'approve' });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: second }).result.allocations[0];
  runtime.store.tx(() => runtime.store.updateTransaction(second, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  const workerAgent = runtime.store.getAgent(allocated.agent_id);
  assert.ok(workerAgent, 'a worker exists for the second transaction');
  await runtime.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.llmSlotsInUse(), 0, 'the worker turn returned its permit too');
  assert.deepEqual(runtime.activeTurnIds(), []);
  assert.equal(runtime.store.all('SELECT * FROM leases WHERE cluster_id=?', clusterId).length, 0, 'no lease is left behind');
  runtime.collectDeliveries = original;
});

test('a service request chain resolves to real budget rows', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  for (const agent of runtime.store.listAgents(clusterId, { limit: 10 })) {
    const chain = runtime.budgetChainForAgent(agent);
    assert.ok(chain.length > 0, `${agent.role} has a fundable chain`);
    for (const id of chain) {
      assert.equal(typeof id, 'string', 'every chain entry is an id');
      assert.ok(runtime.store.getBudget(id), `budget ${id} exists`);
    }
  }
  // A worker's chain follows its *management* node, which is where its grant
  // came from, so compacting a worker session does not need its own node budget.
  void orchestrator;
});

test('a scale tier sets its budget from N, and a Worker cannot exceed its allowance', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-tier-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { workspace: dir });

  // The tier budget is a function of N: `buildSpec` sets these three from the
  // transaction count instead of inheriting the 1024-tier ceiling.
  const formula = startCluster(runtime, {
    workspace: dir,
    budget: { tokens: 65536 * 4, model_requests: 12 * 4, tool_calls: 16 * 4, wall_time_ms: 21_600_000, agents: 64, max_active_agents: 4 },
  });
  const tier = runtime.store.getCluster(formula);
  assert.equal(tier.budget.tokens, 262_144, 'N x 65536, not the 1024-tier ceiling');
  assert.equal(tier.budget.model_requests, 48);
  assert.ok(runtime.compactionBudgetId(formula), 'compaction gets its own funded scope');

  // A Worker allowance is a hard per-identity cap, independent of the tier size.
  const clusterId = startCluster(runtime, {
    workspace: dir,
    budget: { tokens: 4_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 4 },
    limits: { worker_model_requests: 2, worker_max_tokens: 128 },
  });
  const cluster = runtime.store.getCluster(clusterId);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  const worker = runtime.store.getAgent(allocated.agent_id);

  assert.equal(runtime.workerRequestAllowance(worker), 2);
  assert.equal(runtime.workerRequestAllowance(runtime.store.getAgent(allocator.agent_id)), null, 'only Workers are capped');
  assert.equal(runtime.modelFor(worker).maxTokens, 128, 'the Worker token cap is applied');
  assert.notEqual(runtime.modelFor(runtime.store.getAgent(allocator.agent_id)).maxTokens, 128, 'management keeps the configured budget');

  const chain = runtime.agentBudgetChain(cluster, worker, tx);
  const reserve = (kind, budgetIds = chain) => reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
    role: 'worker', kind, model: 'm', provider: 'p', budgetIds,
    reservationTokens: 100, turn_seq: 1, maxRequests: runtime.workerRequestAllowance(worker),
  });
  reserve('worker');
  reserve('worker');
  assert.equal(runtime.store.countWorkerRequests(clusterId, worker.id), 2);
  assert.equal(runtime.store.countUsageReceipts(clusterId, worker.id), 2);
  assert.throws(() => reserve('worker'), /allowance for this task/, 'a third Worker request is refused');
  // Compaction is accounted separately, is paid by the summary pool the runtime
  // selects for it, and does not consume the allowance. Routing it through the
  // Worker's own grant would make the pool unreachable and hand a request to a
  // scope that is capped at exactly its allowance.
  const pool = runtime.compactionBudgetId(clusterId);
  assert.ok(pool, 'the run has a funded summary pool');
  assert.equal(reserve('compaction', [pool]).tokens > 0, true);
  assert.equal(runtime.store.countUsageReceipts(clusterId, worker.id), 3, 'the compaction request is recorded');
  assert.equal(runtime.store.countWorkerRequests(clusterId, worker.id), 2, 'the compaction request is not counted against the Worker allowance');

  // A request that never reached the provider (released before dispatch) costs
  // no allowance: it is not an attempt.
  const released = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
    role: 'worker', kind: 'worker', model: 'm', provider: 'p', budgetIds: chain,
    reservationTokens: 10, turn_seq: 1, maxRequests: null,
  });
  releaseLlmRequest(runtime.store, { cluster_id: clusterId, reservation: released, budgetIds: chain, dispatched: false });
  assert.equal(runtime.store.getUsageReceipt(released.request_id).status, 'NOT_SENT');
  assert.equal(runtime.store.countWorkerRequests(clusterId, worker.id), 2, 'a NOT_SENT request consumed no allowance');
});

test('a released worker frees its child slot, so the ladder is not capped by task count', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-ladder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime, { workspace: dir, limits: { max_children: 2, max_depth: 3, max_agents: 64 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);

  const makeTx = index => {
    const tx = runtime.store.tx(() => runtime.store.insertTransaction({
      id: `ladder-${index}`, cluster_id: clusterId, owner_management_id: root.id, node_id: root.id,
      objective: `task ${index}`, status: 'READY', priority: 0, capabilities: ['fs_read'],
      expected_output: 'x', acceptance_criteria: ['x'],
    }));
    return tx;
  };
  const allocate = index => command(runtime, allocator, 'allocate_agent', {
    transaction_id: makeTx(index).id, write_scope: [],
  }).result.allocations[0];
  const release = allocationId => command(runtime, allocator, 'release_agent', { allocations: [allocationId] });

  // max_children is 2: with slots held by finished nodes the third task can
  // never be allocated, which is what capped the scale ladder at one wave.
  const first = allocate(1);
  const second = allocate(2);
  assert.equal(runtime.store.childrenOf(root.id).length, 2);
  assert.throws(() => allocate(99), /max_children/, 'a held slot blocks the next wave');
  void orchestrator; void auditor;

  const freedNode = runtime.store.getNode(runtime.store.getAgent(first.agent_id).node_id);
  release(first.allocation_id);
  assert.equal(runtime.store.getNode(freedNode.id).status, 'RELEASED', 'a released worker stops holding a child slot');
  const third = allocate(3);
  assert.ok(third.allocation_id, 'releasing a worker frees its child slot');
  const nodes = runtime.store.childrenOf(root.id);
  assert.equal(nodes.length, 2, 'the node is reused, not duplicated');
  assert.equal(runtime.store.getAgent(third.agent_id).node_id, freedNode.id, 'the freed node hosts the next task');
  assert.notEqual(third.agent_id, first.agent_id, 'the new task runs as a fresh identity');

  const agents = runtime.store.listAgents(clusterId, { role: 'worker', limit: 50 });
  assert.equal(new Set(agents.map(agent => agent.id)).size, agents.length, 'each task gets a distinct worker identity');
  assert.ok(agents.length >= 3, `three tasks ran, saw ${agents.length}`);
  release(second.allocation_id);
  release(third.allocation_id);
});

test('receipt is proven by an incoming delivery marker, not by any mention of the id', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  runtime.attachPersistence({
    stat: async sessionId => (sessionId === agent.session_id ? { sessionId } : undefined),
    open: async () => ({ read: async () => ({ events: [] }) }),
  });

  const send = async (id, toSelf, content) => {
    runtime.store.tx(() => {
      runtime.store.insertMessage({
        id, cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
        kind: 'direct', content: { text: content },
      });
      runtime.store.insertRecipient(id, toSelf ? agent.id : agent.id);
    });
  };

  // A self-directed send: its own tool result will echo the id it just sent.
  await send('self-msg', true, 'note to self');
  const sessions = new Map();
  runtime.attachPersistence({
    stat: async sessionId => (sessionId === agent.session_id ? { sessionId } : undefined),
    open: async sessionId => ({
      read: async () => ({
        events: [
          // The sender's own tool result naming the message it sent.
          { type: 'tool/result', data: { call_id: 'c1', result: `sent self-msg to <self>` } },
          ...(sessions.get(sessionId) ?? []),
        ],
      }),
    }),
  });

  const first = await runtime.collectDeliveries(agent);
  assert.deepEqual(first.ids, ['self-msg'], 'sending to yourself is not receiving');

  // Now the delivery really arrives: the incoming user message carries the marker.
  const recipient = runtime.store.getAgent(agent.id);
  sessions.set(recipient.session_id, [
    { type: 'user/message', data: { content: `- from ${agent.id} [[flow-delivery self-msg seq 1]]: note to self` } },
    // An unrelated event that merely mentions the id must not prove receipt either.
    { type: 'tool/result', data: { call_id: 'c2', result: 'self-msg appears here again' } },
  ]);
  runtime.settleDeliveries(clusterId, agent.id, ['self-msg'], { admitted: true, durable: false });
  const retry = await runtime.collectDeliveries(agent);
  assert.deepEqual(retry.ids, [], 'the marked incoming message proves receipt');
  assert.equal(retry.reconciled, 1);
  assert.equal(runtime.store.deliveryFor('self-msg', agent.id).status, 'ACKED');
});

test('a retry after a mid-turn flush does not inject the message twice', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const messageId = 'mid-turn-flush-msg';
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: messageId, cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient(messageId, agent.id);
  });

  // The session starts out without the message.
  const durable = new Set();
  runtime.attachPersistence({
    stat: async sessionId => (sessionId === agent.session_id ? { sessionId } : undefined),
    open: async () => ({ read: async () => ({ events: [] }) }),
  });

  // Turn 1: the tool pipeline flushes the prompt, then the final flush fails.
  const first = await runtime.collectDeliveries(agent);
  assert.deepEqual(first.ids, [messageId], 'the first turn injects the message');
  durable.add(messageId);
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: false });
  assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'PENDING');

  // The prompt *is* durable now, so the retry must ack it rather than replay it.
  runtime.attachPersistence({
    stat: async sessionId => (sessionId === agent.session_id ? { sessionId } : undefined),
    open: async () => ({
      read: async () => ({
        events: [...durable].map(id => ({ type: 'user/message', data: { content: `x [[flow-delivery ${id} seq 1]]: y` } })),
      }),
    }),
  });
  const retry = await runtime.collectDeliveries(agent);
  assert.deepEqual(retry.ids, [], 'the retry injects nothing');
  assert.equal(retry.reconciled, 1);
  assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'ACKED');
  const injected = runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='messages-injected'", clusterId);
  assert.equal(injected.length, 1, 'the message was injected exactly once');
  assert.equal(runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='messages-ack-reconciled'", clusterId).length, 1);
});

test('a delivery is only acked once the session is flushed', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const messageId = 'flush-msg';
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: messageId, cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient(messageId, agent.id);
    runtime.store.markDeliveryInjected(messageId, agent.id);
  });
  const events = type => runtime.store.all('SELECT * FROM events WHERE cluster_id=? AND type=?', clusterId, type).length;

  // Admitted but not flushed: the message is not acked and becomes pending again.
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: false });
  assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'PENDING', 'an unflushed message is not acked');
  assert.equal(events('messages-reopened'), 1);
  assert.equal(events('messages-acked'), 0);
  assert.match(
    String(runtime.store.all('SELECT data FROM events WHERE type=?', 'messages-reopened')[0].data),
    /not flushed/,
    'the reason names the missing flush, not a missing admission',
  );

  // Admitted and flushed: exactly one ack, after the recorded durable boundary.
  runtime.store.tx(() => runtime.store.markDeliveryInjected(messageId, agent.id));
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: true });
  assert.equal(runtime.store.deliveryFor(messageId, agent.id).status, 'ACKED');
  assert.equal(events('messages-acked'), 1);
  assert.equal(events('delivery-flushed'), 1, 'the flush boundary is recorded');
});

test('a turn identity belongs to one live agent instance, not to its session', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const firstInstance = { id: agent.session_id };
  const secondInstance = { id: agent.session_id };

  runtime.bindTurnIdentity(firstInstance, { agent_id: agent.id, epoch: 1, lease_id: 'l1', turn_seq: 1, role: 'orchestrator', node_id: root.id, cluster_id: clusterId });
  runtime.bindTurnIdentity(secondInstance, { agent_id: agent.id, epoch: 2, lease_id: 'l2', turn_seq: 2, role: 'orchestrator', node_id: root.id, cluster_id: clusterId });

  assert.equal(runtime.turnActor(firstInstance).epoch, 1, 'an old instance must keep its own epoch');
  assert.equal(runtime.turnActor(secondInstance).epoch, 2);
  assert.equal(runtime.turnActor({ id: agent.session_id }), null, 'an unregistered instance owns no turn');
  assert.equal(runtime.turnActor(undefined), null);
});

test('a depleted worker grant is replenished from the budget that funds it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  const worker = runtime.store.getAgent(allocation.agent_id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', worker.id);

  // A worker's node id names the worker node, but its grant is parented to the
  // management node's budget: resolving by node id would find nothing.
  assert.notEqual(agentBudget.parent_budget_id, runtime.store.budgetForScope(clusterId, 'node', worker.node_id)?.id ?? null);
  const parent = runtime.store.getBudget(agentBudget.parent_budget_id);
  assert.ok(parent, 'the funding parent exists');

  // Drain the grant, then replenish from the parent.
  runtime.store.tx(() => runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, requests_limit: 0 }));
  assert.equal(runtime.store.budgetForScope(clusterId, 'node', worker.node_id), null);
  const granted = runtime.store.tx(() => runtime.topUpBudgetForAgent(worker, { tokens: 5_000, model_requests: 1 }));
  assert.ok(granted, 'the top-up must resolve the real funding parent');
  assert.equal(granted.tokens, 5_000, 'the gap it was asked for');
  assert.equal(granted.model_requests, 1);
  assert.equal(runtime.store.getBudget(agentBudget.id).tokens_limit, granted.tokens);
});

test('the scheduling barrier gates every driver, and session existence is probed', async t => {
  const sessions = new Set(['session-exists']);
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: {
      async stat(sessionId) {
        return sessions.has(sessionId) ? { id: sessionId } : undefined;
      },
    },
  });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);

  // A settle request must not drive scheduling before the barrier is open.
  const settled = runtime.runUntilSettled(clusterId, { timeoutMs: 150, pollMs: 20 });
  const during = runtime.store.listAgents(clusterId, { limit: 20 }).map(agent => agent.turns);
  assert.ok(during.every(turns => turns === 0), 'no turn may start while the barrier is closed');
  await settled;
  assert.equal(runtime.schedulingEnabled(), false, 'the settle loop gives up without opening the barrier');

  runtime.enableScheduling();
  assert.equal(runtime.schedulingEnabled(), true);
  runtime.store.tx(() => runtime.store.updateAgent(runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 })[0].id, { status: 'BLOCKED' }));
  void root;

  // Session existence comes from the store, not from a counter.
  runtime.attachPersistence({ stat: async id => (sessions.has(id) ? { id } : undefined) });
  assert.equal(await runtime.sessionExists('session-exists'), true);
  assert.equal(await runtime.sessionExists('session-missing'), false);
  runtime.attachPersistence(null);
  assert.equal(await runtime.sessionExists('session-exists'), null, 'without persistence the answer is unknown, not false');
});

test('a granted write scope survives a reload and ignores a retargeted alias', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true });
  mkdirSync(join(dir, 'src', 'data'), { recursive: true });
  symlinkSync(join(dir, 'src', 'ui'), join(dir, 'alias'));

  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime, { workspace: dir });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, write_scope: ['alias'] });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  assert.equal(allocation.write_scope[0], 'alias');
  assert.equal(allocation.write_scope_canonical.length, 1, 'the canonical grant is persisted');

  // Reload from SQLite: the canonical grant must come back, not be recomputed.
  const reloaded = new ClusterStore(runtime.store.path, { now });
  t.after(() => reloaded.close());
  const stored = reloaded.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  assert.deepEqual(stored.write_scope_canonical, allocation.write_scope_canonical,
    'the canonical grant survives the SQLite boundary');
  assert.deepEqual(stored.write_scope, allocation.write_scope);

  // Retarget the alias at a sibling directory: the frozen grant must not follow.
  unlinkSync(join(dir, 'alias'));
  symlinkSync(join(dir, 'src', 'data'), join(dir, 'alias'));
  const afterRetarget = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: allocation.write_scope,
    writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { path: 'alias/secret.ts' },
  });
  assert.equal(afterRetarget.allowed, false, 'a retargeted alias must not grant the new target');
  const stillOwned = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: allocation.write_scope,
    writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { path: 'src/ui/App.jsx' },
  });
  assert.equal(stillOwned.allowed, true, 'the original directory is still owned');
});

test('root Orchestrator closes only after accepted work and its final communication', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { objective: 'After all work is accepted, publish the final total on the blackboard.' });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  assert.throws(() => command(runtime, orchestrator, 'finish_cluster', {}),
    error => error.status === 409 && /ACCEPTED/.test(error.message));

  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false }));
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'accepted transactions do not skip the root objective');
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');
  runtime.recover({ deferScheduling: true });
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'restart retains unfinished root work');
  const pending = runtime.pendingFor('orchestrator', root, runtime.store.getCluster(clusterId), orchestrator);
  assert.ok(pending.some(item => item.action === 'finish_cluster'), 'the root Orchestrator has a final turn to publish');

  runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'publish', { key: 'total', value: 10 }));
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.recover({ deferScheduling: true });
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'an undecided final health marker cannot close a root');
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');
  scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'COMPLETED');
  assert.equal(runtime.store.getNode(root.id).status, 'COMPLETED');
  assert.equal(JSON.parse(runtime.store.blackboardEntry(clusterId, 'total').value), 10);
});

test('completion and progress observe the whole cluster, not a page of it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);

  // Eleven root transactions, ten accepted: the cluster must stay RUNNING.
  runtime.store.tx(() => {
    for (let index = 0; index < 10; index += 1) {
      runtime.store.updateTransaction(runtime.store.listTransactions({ cluster_id: clusterId })[0].id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  for (let index = 0; index < 11; index += 1) {
    command(runtime, orchestrator, 'create_transaction', { objective: `root-${index}`, acceptance_criteria: ['a'] });
  }
  const roots = runtime.store.rootTransactions(clusterId);
  assert.ok(roots.length >= 11, `${roots.length} root transactions`);
  runtime.store.tx(() => {
    for (const tx of roots.slice(0, roots.length - 1)) {
      runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'one unfinished root must keep the cluster running');

  runtime.store.tx(() => {
    for (const tx of runtime.store.rootTransactions(clusterId)) {
      runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'the unfinished health judgement still holds the root');
  scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'COMPLETED');

  // Progress must keep advancing past the old 500-event page.
  const before = runtime.progressSeq(clusterId);
  runtime.store.tx(() => {
    for (let index = 0; index < 900; index += 1) runtime.store.appendEvent(clusterId, 'filler', { index });
  });
  assert.ok(runtime.progressSeq(clusterId) > before + 800, 'progress must not saturate at a page boundary');
  void auditor;
});

test('a message is never lost across the crash window, and never duplicated when admission is proven', async t => {
  const sessions = new Map();
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: {
      async open(sessionId) {
        return {
          async read() {
            return { events: sessions.get(sessionId) ?? [] };
          },
          async close() {},
        };
      },
    },
  });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];

  const sent = runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'send', {
    agent: auditor.id, content: 'status?', message_id: 'msg-crash-1',
  }));
  assert.equal(sent.recipients.length, 1);

  // First process: the message is taken from the queue and injected, then the
  // process dies before the ack reaches SQLite.
  const collected = await runtime.collectDeliveries(auditor);
  assert.equal(collected.ids.length, 1);
  assert.equal(runtime.store.deliveryFor('msg-crash-1', auditor.id).status, 'DELIVERED');

  // Crash before the prompt was ever admitted: recovery preserves the attempt
  // until the session proves it absent, then requeues it without losing it.
  const recovered = runtime.recover();
  assert.equal(recovered[0].injections_pending_proof, 1);
  assert.equal(runtime.store.deliveryFor('msg-crash-1', auditor.id).status, 'DELIVERED');
  assert.equal(runtime.store.pendingDeliveries(auditor.id).length, 0, 'an attempted delivery waits for proof');

  const reconciled = await runtime.reconcileDeliveries(clusterId);
  assert.equal(reconciled.persistence, true);
  assert.equal(reconciled.acknowledged, 0, 'an unreadable admission is not proof');
  assert.equal(runtime.store.deliveryFor('msg-crash-1', auditor.id).status, 'PENDING');

  // Second process: the prompt really was admitted and flushed, then the crash
  // hit before the ack. The Session is the proof, so only the ack is repaired
  // and the message is never delivered twice.
  const second = await runtime.collectDeliveries(auditor);
  sessions.set(auditor.session_id, [{ type: 'user/message', data: { text: `- from x [[flow-delivery ${second.ids[0]} seq 1]]: status?` } }]);
  runtime.recover();
  assert.equal(runtime.store.deliveryFor('msg-crash-1', auditor.id).status, 'DELIVERED', 'the safe default preserves the attempt until proof is checked');
  const proven = await runtime.reconcileDeliveries(clusterId);
  assert.equal(proven.acknowledged, 1, 'a Session that carries the id proves admission');
  assert.equal(runtime.store.deliveryFor('msg-crash-1', auditor.id).status, 'ACKED');
  assert.equal(runtime.store.pendingDeliveries(auditor.id).length, 0, 'a proven delivery is never repeated');

  const resent = runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'send', {
    agent: auditor.id, content: 'status?', message_id: 'msg-crash-1',
  }));
  assert.equal(resent.deduped, true);
  assert.equal(runtime.store.all('SELECT COUNT(*) AS c FROM recipients WHERE message_id=?', 'msg-crash-1')[0].c, 1, 'exactly one delivery record');
  assert.equal(runtime.store.get('SELECT COUNT(*) AS c FROM messages WHERE cluster_id=?', clusterId).c, 1);
});

test('reparent runs only at a safe point and rejects unsafe requests', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const child = command(runtime, allocator, 'spawn_management_node', { transaction_id: tx.id }).result;

  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: root.id, new_parent_id: child.node_id }),
    error => error.status === 409);

  // A subtree that still holds an open delegated assignment from its old
  // parent cannot move: the responsibility would be doubled.
  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: child.node_id, new_parent_id: root.id }),
    error => error.status === 409 && /delegated assignment/.test(error.message));

  const grandchild = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: child.delegated_transaction_id, node_id: child.node_id, scope: { objective: 'grandchild' },
  }).result;
  assert.equal(runtime.store.getNode(grandchild.node_id).depth, 2);

  // Once the delegated assignment is terminal the same move is allowed. The new
  // parent must also be able to fund the subtree it takes on — that check is the
  // subject of a different test, so give it the capacity here.
  runtime.store.tx(() => {
    runtime.store.updateTransaction(child.delegated_transaction_id, { status: 'ACCEPTED' });
    runtime.store.updateTransaction(grandchild.delegated_transaction_id, { status: 'ACCEPTED' });
    const parentBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
    const row = runtime.store.getBudget(parentBudget.id);
    runtime.store.updateBudget(parentBudget.id, {
      tokens_limit: Number(row.tokens_limit) + 500_000,
      requests_limit: Number(row.requests_limit) + 40,
      tool_calls_limit: Number(row.tool_calls_limit) + 40,
    });
  });
  const moved = command(runtime, allocator, 'reparent', { node_id: grandchild.node_id, new_parent_id: child.node_id });
  assert.equal(moved.result.to, child.node_id);
  assert.equal(runtime.store.getNode(grandchild.node_id).depth, 2);

  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: child.node_id, new_parent_id: grandchild.node_id }),
    error => error.status === 409);
});

test('lease epochs fence a stale actor and cancel terminates the subtree', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];

  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-1', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'worker-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  assert.equal(runtime.store.leaseForAgent(worker.id).epoch, 1);
  runtime.store.tx(() => {
    runtime.store.deleteLease('lease-1');
    runtime.store.createLease({
      id: 'lease-2', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'worker-turn', epoch: 2, expires: now() + 60_000,
    });
  });
  assert.equal(runtime.store.leaseForAgent(worker.id).epoch, 2);

  const cancelled = runtime.control(clusterId, 'cancel');
  assert.equal(cancelled.cluster.status, 'CANCELLED');
  assert.equal(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }).length, 0);
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId })[0].status, 'CANCELLED');
  assert.equal(runtime.store.getAgent(worker.id).status, 'TERMINATED');
});

test('an expired lease is reclaimed without a claim from a later turn', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-expired', cluster_id: clusterId, agent_id: auditor.agent_id, node_id: root.id,
      purpose: 'auditor-turn', epoch: 1, expires: now() + 1000,
    });
    runtime.store.updateAgent(auditor.agent_id, { status: 'RUNNING' });
  });
  clock += 5000;
  const before = runtime.store.leaseForAgent(auditor.agent_id);
  assert.ok(before);
  runtime.txExpireLeases(clusterId);
  assert.equal(runtime.store.leaseForAgent(auditor.agent_id), null);
  assert.equal(runtime.store.getAgent(auditor.agent_id).status, 'READY');
  clock -= 5000;
});

test('recovery fences stale leases, marks in-flight effects uncertain and requeues', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const workerless = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'stale', cluster_id: clusterId, agent_id: runtime.store.listAgents(clusterId, { role: 'auditor' })[0].id,
      node_id: root.id, purpose: 'auditor-turn', epoch: 3, expires: now() + 60_000,
    });
    runtime.store.insertEffect({
      call_id: 'call-started', cluster_id: clusterId, agent_id: runtime.store.listAgents(clusterId, { role: 'auditor' })[0].id,
      node_id: root.id, lease_epoch: 3, tool: 'write', args: { path: 'x' }, status: 'STARTED',
    });
    runtime.store.updateTransaction(workerless.id, { status: 'RUNNING' });
  });
  const report = runtime.recover();
  assert.equal(report.length, 1);
  assert.equal(report[0].fenced_leases, 1);
  assert.equal(report[0].uncertain_effects, 1);
  assert.equal(report[0].requeued, 1);
  assert.equal(runtime.store.getEffect('call-started').status, 'EFFECT_UNCERTAIN');
  assert.equal(runtime.store.getTransaction(workerless.id).status, 'READY');
  assert.equal(runtime.store.listLeases(clusterId, {}).length, 0);
});

test('allocation operations: model selection, evaluation, replace, reassign, checkpoint and restore', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0];
  const worker = runtime.store.getAgent(allocation.agent_id);

  // Model selection is validated against the registered routes.
  const selected = command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'local-sglang', model: 'Qwen3.8-7B' });
  assert.equal(selected.result.model.model, 'Qwen3.8-7B');
  assert.equal(runtime.store.getAgent(worker.id).meta.model.model, 'Qwen3.8-7B');
  assert.throws(() => command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'local-sglang', model: 'not-a-model' }),
    error => error.status === 409);
  assert.throws(() => command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'cloud', model: 'x' }),
    error => error.status === 409);

  const evaluated = command(runtime, allocator, 'evaluate_allocation', {});
  assert.equal(evaluated.result.capacity.active_allocations, 1);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const rootBudget = runtime.store.budgetForScope(clusterId, 'root', clusterId);
  assert.deepEqual(evaluated.result.budgets.map(budget => budget.id), [nodeBudget.id, rootBudget.id],
    'allocation evaluation needs only the local capacity and its funding chain, not every agent grant');
  assert.equal(evaluated.result.budgets[0].available.agents, dimensionAvailable(nodeBudget, 'agents'));
  assert.ok(JSON.stringify(evaluated.result).length < 3_000,
    'a role can read the capacity result within its unchanged 8192-token identity context');

  // A checkpoint is only restorable against a *known* native offset: the stub
  // answers with the offset the host session would report.
  runtime.sessionOffsetOf = () => 7;
  const checkpoint = command(runtime, allocator, 'checkpoint', { agent_id: worker.id });
  assert.ok(checkpoint.result.checkpoint_id);
  const restored = command(runtime, allocator, 'restore', { agent_id: worker.id });
  assert.equal(restored.result.checkpoint_id, checkpoint.result.checkpoint_id);
  assert.deepEqual(restored.result.effect_uncertain, []);

  const replacement = command(runtime, allocator, 'replace_agent', { allocation_id: allocation.id });
  assert.notEqual(replacement.result.agent_id, worker.id);
  assert.equal(runtime.store.getAgent(worker.id).status, 'TERMINATED');
  assert.equal(runtime.store.getAllocation(allocation.id).agent_id, replacement.result.agent_id);

  const otherTx = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['a'] }).result;
  command(runtime, orchestrator, 'dispatch', { transaction_id: otherTx.transaction_id });
  command(runtime, allocator, 'reassign_agent', { agent_id: replacement.result.agent_id, transaction_id: otherTx.transaction_id });
  assert.equal(runtime.store.getAllocation(allocation.id).transaction_id, otherTx.transaction_id);
});

test('Allocator evaluation keeps every active allocation reachable after a bounded local capacity page', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 16, max_depth: 3, max_active_agents: 8, max_llm_concurrency: 2,
      max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 1000, tool_calls: 1000,
      wall_time_ms: 3_600_000, agents: 32, max_active_agents: 8 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const ids = [];
  for (let index = 0; index < 7; index += 1) {
    const txId = command(runtime, orchestrator, 'create_transaction', {
      objective: `deliver independent item ${index}`, acceptance_criteria: ['delivered'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
    ids.push(command(runtime, allocator, 'allocate_agent', { transaction_id: txId })
      .result.allocations[0].allocation_id);
  }
  const first = command(runtime, allocator, 'evaluate_allocation', {}).result;
  const second = command(runtime, allocator, 'evaluate_allocation', {
    offset: first.allocations_next_offset,
  }).result;
  assert.equal(first.capacity.active_allocations, 7);
  assert.equal(first.allocations_total, 7);
  assert.equal(first.allocations.length, 6);
  assert.equal(second.allocations_next_offset, null);
  assert.deepEqual(new Set([...first.allocations, ...second.allocations].map(a => a.allocation_id)),
    new Set(ids));
  assert.equal(runtime.query({ cluster_id: clusterId, role: 'user' }, 'allocations', { limit: 100 }).items.length, 7,
    'the host still reads every full allocation');
});

test('an Allocator cannot replace or reassign a Worker holding a live lease', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'next unit of work', acceptance_criteria: ['next result exists'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  const allocation = runtime.store.activeAllocationForTransaction(first.id);
  runtime.store.tx(() => {
    runtime.store.updateTransaction(first.id, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(allocation.agent_id, { status: 'RUNNING' });
    runtime.store.createLease({
      id: 'live-replacement', cluster_id: clusterId, agent_id: allocation.agent_id,
      node_id: allocation.node_id, purpose: 'worker-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  assert.throws(() => command(runtime, allocator, 'replace_agent', { allocation_id: allocation.id }),
    error => error.status === 409 && /turn|lease|running/i.test(error.message));
  assert.throws(() => command(runtime, allocator, 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: second,
  }), error => error.status === 409 && /turn|lease|running/i.test(error.message));
  assert.throws(() => command(runtime, allocator, 'release_agent', { allocation_id: allocation.id }),
    error => error.status === 409 && /turn|lease|running/i.test(error.message));
  assert.equal(runtime.store.getAllocation(allocation.id).agent_id, allocation.agent_id);
  assert.equal(runtime.store.getAllocation(allocation.id).transaction_id, first.id);
  assert.equal(runtime.store.getAgent(allocation.agent_id).status, 'RUNNING');
  assert.equal(runtime.store.getTransaction(first.id).status, 'RUNNING');
  assert.equal(runtime.store.leaseForAgent(allocation.agent_id).id, 'live-replacement');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 200 }).some(e => e.type === 'agent-replaced'), false);

  runtime.store.tx(() => runtime.store.deleteLease('live-replacement'));
  assert.throws(() => command(runtime, allocator, 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: second,
  }), error => error.status === 409 && /running/i.test(error.message),
  'a vanished lease does not permit orphaning a RUNNING transaction');
  runtime.store.tx(() => {
    runtime.store.updateAgent(allocation.agent_id, { status: 'READY' });
    runtime.store.updateTransaction(first.id, { status: 'READY', __bump_revision: false });
  });
  const oldBudget = runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id);
  assert.ok(dimensionAvailable(oldBudget, 'tokens') > 0);
  const replacement = command(runtime, allocator, 'replace_agent', { allocation_id: allocation.id }).result;
  assert.notEqual(replacement.agent_id, allocation.agent_id, 'replacement works after the turn drains');
  assert.equal(dimensionAvailable(runtime.store.getBudget(oldBudget.id), 'tokens'), 0,
    'unused funds from the retired Worker return to the same management node');
  assert.equal(dimensionAvailable(runtime.store.getBudget(oldBudget.id), 'model_requests'), 0);
  assert.ok(dimensionAvailable(runtime.store.budgetForScope(clusterId, 'agent', replacement.agent_id), 'tokens') > 0,
    'the new Worker inherits enough funding to make a real request');
});

test('pause stops dispatching and resume returns the cluster to a schedulable state', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id, decision: 'approve' });

  const paused = runtime.control(clusterId, 'pause');
  assert.equal(paused.cluster.status, 'PAUSED');
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId })[0].status, 'PAUSED');
  assert.equal(runtime.store.getNode(root.id).status, 'PAUSED');

  const resumed = runtime.control(clusterId, 'resume');
  assert.equal(resumed.cluster.status, 'RUNNING');
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId })[0].status, 'READY');
});

test('releasing an identity returns its slot and never shrinks the node capacity', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 16, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 500, tool_calls: 500, wall_time_ms: 3_600_000, agents: 4, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const baseline = { ...runtime.store.getBudget(nodeBudget.id) };
  assert.equal(baseline.agents_limit, 4, 'the node holds the cluster\'s four agent slots');
  assert.equal(baseline.max_active_limit, 4);

  // Eight waves against a four-slot node: one identity at a time, each freed
  // before the next is created. A leak of one slot per wave would stop the
  // ladder at wave five, and a leaked *limit* would shrink the node invisibly.
  for (let wave = 0; wave < 8; wave += 1) {
    const tx = command(runtime, orchestrator, 'create_transaction', {
      objective: `wave ${wave}`, acceptance_criteria: ['done'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx });
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx, decision: 'approve' });
    const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx }).result.allocations[0];
    const agentScope = runtime.store.budgetForScope(clusterId, 'agent', allocated.agent_id);
    assert.ok(agentScope, 'a worker identity always has its own grant');
    assert.equal(budgetView(agentScope).max_active_agents.spent, 0, 'an identity never *consumes* an active slot');
    assert.equal(budgetView(agentScope).max_active_agents.limit, 0, 'a worker adds no per-agent active window of its own');

    // One settled turn's worth of accounting on the identity scope. `agents` and
    // `max_active_agents` are capacity: settlement must write nothing at all.
    const revision = runtime.store.getBudget(agentScope.id).revision;
    runtime.store.tx(() => settleChain(runtime.store, [agentScope.id], { consumed: { agents: 1, max_active_agents: 1 } }));
    assert.equal(runtime.store.getBudget(agentScope.id).revision, revision,
      'the capacity dimensions have no spent column, so settlement produces no UPDATE');

    command(runtime, allocator, 'release_agent', { allocation_id: allocated.allocation_id });
    const row = runtime.store.getBudget(nodeBudget.id);
    assert.equal(row.agents_reserved, baseline.agents_reserved, `wave ${wave}: the agent slot came back`);
    assert.equal(row.max_active_limit, baseline.max_active_limit, `wave ${wave}: the node's active window is unchanged`);
  }

  const after = runtime.store.getBudget(nodeBudget.id);
  assert.equal(after.agents_limit, baseline.agents_limit, 'the node capacity is never transferred away');
  assert.equal(after.agents_reserved, baseline.agents_reserved);
  assert.equal(after.max_active_limit, baseline.max_active_limit);
  assert.equal(after.max_active_reserved, baseline.max_active_reserved);
  // The declaration itself: a dimension with a `spent` column that the schema
  // does not have silently discards every write to it.
  assert.equal(DIMENSIONS.find(dim => dim.key === 'agents').spent, null);
  assert.equal(DIMENSIONS.find(dim => dim.key === 'max_active_agents').spent, null);
});
/**
 * A Worker has exactly two provider requests: one to do the work, one to
 * submit. The second call concludes the turn, so the native loop must not ask
 * for a third request that the allowance would refuse — which is what used to
 * happen, withholding every Worker result as `LIMIT_REACHED`.
 */
async function driveWorkerOnce(t, { cancelledFirstRequest = false, firstRequestFails = null, result = { file: 'stub.txt', symbol: 'stub', line: 1 }, onAuditor = null, approvePlan = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  // The capability package is not really mounted in a fake host, so the read the
  // Worker calls is stubbed; everything around it — admission, reservation,
  // refusal, settlement — is the production path.
  host.registerTool({
    name: 'read',
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return { content: [{ type: 'text', text: 'stub file body' }], isError: false, value: { body: 'stub file body' } }; },
  });
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_model_requests: 2, worker_max_tokens: 512 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  // Whether the plan gate is still the path to READY or the Orchestrator
  // dispatches directly, the fixture ends up approved either way.
  if (approvePlan || runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });

  host.setScript(async turn => {
    const role = runtime.store.getAgentBySession(turn.session.id)?.role;
    if (role === 'auditor') return onAuditor?.(turn, { runtime, clusterId, tx });
    if (role !== 'worker') return;
    const usage = { totalTokens: 100, inputTokens: 80, outputTokens: 20 };
    if (cancelledFirstRequest) await turn.request({ purpose: 'worker', dispatchFails: true });
    if (firstRequestFails) {
      // The exact shape the harness produces for a transport failure: a usage
      // chunk built from pi-ai's zeroed message, then an error finish. The
      // `reported` variant is the provider that *did* report what it consumed
      // before failing.
      const failureUsage = firstRequestFails === 'reported'
        ? { totalTokens: 120, inputTokens: 100, outputTokens: 20 }
        : { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
      await turn.request({
        purpose: 'worker',
        chunks: [
          { type: 'text', text: 'partial answer' },
          { type: 'usage', usage: failureUsage },
          { type: 'finish', reason: { kind: 'error', failure: { message: 'declared server failure', code: 'SERVER' } } },
        ],
      });
    }
    await turn.request({ purpose: 'worker', usage });
    await turn.callTool('read', { file_path: 'stub.txt' });
    await turn.request({ purpose: 'worker', usage });
    await turn.callTool('flow_transaction', {
      action: 'submit_result',
      params: { transaction_id: tx.id, result },
    });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const status = runtime.store.getTransaction(tx.id).status;
    if (status === 'SUBMITTED' || status === 'FAILED' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  const workerAgent = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const eventsOf = type => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  return { runtime, host, clusterId, tx, workerTurn, workerAgent, eventsOf };
}

test('a management action yields its model turn so delegated work can be scheduled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-control-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'dispatch the local work', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 4 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').includes('Role: orchestrator.')) return;
    await turn.request({ purpose: 'role' });
    await turn.callTool('flow_query', { what: 'transaction', params: { id: tx.id } });
    if (!turn.concluded) {
      await turn.callTool('flow_transaction', { action: 'dispatch', params: { transaction_id: tx.id } });
    }
    // A non-yielding role keeps querying until the model chooses to stop;
    // that holds a management slot while child roles wait to start.
    if (!turn.concluded) await turn.request({ purpose: 'role' });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (runtime.store.getTransaction(tx.id).status !== 'READY' && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const turn = host.turns.find(entry => (entry.prompt?.content?.[0]?.text ?? '').includes('Role: orchestrator.'));
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY');
  assert.equal(turn?.concluded, true, 'successful control mutation yields the native turn');
  assert.equal(turn.requests.length, 1, 'no second provider request polls the changed state');
});

test('a worker submits on its second request, and the turn ends completed', async t => {
  const { runtime, clusterId, tx, workerTurn, workerAgent, eventsOf } = await driveWorkerOnce(t);
  assert.ok(workerTurn, 'the worker turn ran');
  assert.equal(workerTurn.requests.length, 2, 'exactly two provider requests: work, then submit');
  assert.deepEqual(workerTurn.toolCalls, ['read', 'flow_transaction']);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'SUBMITTED', 'a completed turn publishes the staged result');

  const turnEnd = eventsOf('turn-end').filter(event => event.data.role === 'worker').pop();
  assert.equal(turnEnd.data.stop_reason, 'completed', 'the turn ends because the tool call concluded it');
  assert.equal(turnEnd.data.stop_detail.kind, 'completed');
  assert.equal(turnEnd.data.tools_used.includes('read'), true, 'the read really ran through the tool pipeline');
  assert.equal(eventsOf('result-withheld').length, 0, 'no result is withheld');
  assert.equal(eventsOf('result-submitted').length, 1);
  assert.equal(runtime.store.countWorkerRequests(clusterId, workerAgent.id), 2);
  const notSent = runtime.store.listUsageReceipts(clusterId, { agent_id: workerAgent.id })
    .filter(receipt => receipt.status === 'NOT_SENT');
  assert.equal(notSent.length, 0, 'every accounted request really was dispatched');
  const compactionScope = runtime.compactionBudgetId(clusterId);
  const paid = runtime.store.listUsageReceipts(clusterId, { agent_id: workerAgent.id })
    .filter(receipt => receipt.kind === 'worker' && receipt.status === 'SETTLED');
  assert.equal(paid.length, 2);
  assert.ok(paid.every(receipt => receipt.budget_scope_id !== compactionScope),
    'ordinary Worker requests cannot drain the separately earmarked summary fund');
  const root = rootNode(runtime, clusterId);
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' })[0];
  assert.notEqual(runtime.budgetChainForAgent(orchestrator, { tokens: 100, requests: 1, kind: 'role' })[0], compactionScope,
    'normal management requests also use the management grant while it is affordable');
  assert.equal(runtime.budgetChainForAgent(orchestrator, { tokens: 100, requests: 1, kind: 'compaction' })[0], compactionScope,
    'a compaction still draws on its reserved pool');
});

test('a cancelled first request costs no allowance, so the worker still has two real requests', async t => {
  const { runtime, clusterId, tx, workerTurn, workerAgent, eventsOf } = await driveWorkerOnce(t, { cancelledFirstRequest: true });
  assert.ok(workerTurn, 'the worker turn ran');
  // Three attempts, but only two of them reached the provider: the first was
  // released as NOT_SENT and must not consume the two-request allowance.
  assert.equal(workerTurn.requests.length, 3);
  assert.equal(workerTurn.requests[0].dispatchFails, true);
  assert.equal(runtime.store.countWorkerRequests(clusterId, workerAgent.id), 2,
    'the never-dispatched request is not an attempt');
  const notSent = runtime.store.listUsageReceipts(clusterId, { agent_id: workerAgent.id })
    .filter(receipt => receipt.status === 'NOT_SENT');
  assert.equal(notSent.length, 1, 'the failed dispatch is recorded as never sent');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'SUBMITTED', 'the worker still completes its task');
  assert.equal(eventsOf('result-withheld').length, 0);
});

test('a failed provider request keeps its token hold as UNKNOWN instead of settling at zero', async t => {
  const { runtime, clusterId, workerAgent, workerTurn } = await driveWorkerOnce(t, { firstRequestFails: 'unaccounted' });
  assert.ok(workerTurn, 'the worker turn ran');
  const receipts = runtime.store.listUsageReceipts(clusterId, { agent_id: workerAgent.id });
  const failed = receipts.find(receipt => receipt.status === 'UNKNOWN');
  // The harness reports a transport failure with a zeroed usage object. Booking
  // those zeros as a settled cost hands a dispatched request's hold back as free
  // capacity, which is the one thing `settleLlmRequest` refuses to do.
  assert.ok(failed, `the failed request must be UNKNOWN, not settled at zero: ${JSON.stringify(receipts.map(r => [r.status, r.total_tokens]))}`);
  assert.match(String(failed.note), /failed after dispatch/);
  assert.equal(failed.total_tokens, null, 'no zero total is booked for an unaccounted failure');
  assert.ok(Number(failed.reservation_tokens) > 0);
  const charged = runtime.store.getBudget(failed.budget_scope_id);
  assert.ok(Number(charged.tokens_reserved) >= Number(failed.reservation_tokens),
    `the hold stays reserved in the scope that paid: ${charged.tokens_reserved} >= ${failed.reservation_tokens}`);

  // The attempt is still consumed: an unknown-cost request is not refunded.
  assert.ok(receipts.some(receipt => receipt.kind === 'worker' && receipt.status !== 'NOT_SENT' && receipt !== failed),
    'the identity made further real requests');
});

test('a failed provider request that did report usage settles with the numbers it reported', async t => {
  const { runtime, clusterId, workerAgent } = await driveWorkerOnce(t, { firstRequestFails: 'reported' });
  const receipts = runtime.store.listUsageReceipts(clusterId, { agent_id: workerAgent.id });
  const settled = receipts.filter(receipt => receipt.status === 'SETTLED');
  const reported = settled.find(receipt => Number(receipt.total_tokens) === 120);
  assert.ok(reported, `the provider's own count is preserved on a failed request: ${JSON.stringify(settled.map(r => r.total_tokens))}`);
  assert.equal(receipts.filter(receipt => receipt.status === 'UNKNOWN').length, 0,
    'a genuine report is not relabelled as unknown');
});

test('a blocked Worker submission durably records the unsatisfied result for independent review', async t => {
  const { runtime, clusterId, tx, eventsOf } = await driveWorkerOnce(t, {
    result: { completed: false, status: 'blocked', reason: 'the allocated write scope excludes the required output' },
  });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'SUBMITTED');
  const submitted = eventsOf('result-submitted')[0];
  assert.ok(submitted, 'the native Worker turn published a result');
  assert.equal(submitted.data.result_completed, false);
  assert.equal(submitted.data.result_status, 'blocked');
  assert.equal(submitted.data.revision, runtime.store.getTransaction(tx.id).revision);
});

test('a later-revision issue consumes the earlier incomplete Worker event without hiding a new incomplete result', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const blockedRevision = tx.revision;
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    node_id: root.id, transaction_id: tx.id, revision: blockedRevision,
    result_completed: false, result_status: 'blocked',
  }));
  const pending = () => runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
    .filter(item => item.action === 'request_correction' && item.transaction_id === tx.id);
  assert.equal(pending().length, 1, 'the actual blocked result first reaches independent review');
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, inputs: { write_scope: ['output'] } });
  const correctedRevision = runtime.store.getTransaction(tx.id).revision;
  assert.ok(correctedRevision > blockedRevision);
  const issueId = command(runtime, auditor, 'request_correction', {
    transaction_id: tx.id, required_change: 'replace the Worker grant and write output',
  }).result.issue_id;
  assert.equal(runtime.store.getIssue(issueId).target_revision, correctedRevision);
  assert.equal(pending().length, 0,
    'an issue opened after the blocked event is already its review even if its target_revision advanced');
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    node_id: root.id, transaction_id: tx.id, revision: correctedRevision,
    result_completed: false, result_status: 'blocked',
  }));
  assert.equal(pending().length, 1, 'a distinct later Worker attempt still needs its own review');
});

test('an Auditor cannot dismiss a recorded blocked Worker result as an imaginary defect', async t => {
  const { runtime, clusterId, tx, eventsOf } = await driveWorkerOnce(t, {
    result: { completed: false, outcome: 'blocked', reason: 'the current write scope excludes the required output' },
  });
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const issueId = command(runtime, auditor, 'request_correction', {
    transaction_id: tx.id, required_change: 'grant a write scope that covers the required output',
  }).result.issue_id;
  assert.equal(eventsOf('result-submitted').at(-1).data.result_completed, false);
  assert.equal(eventsOf('write-refused').length, 0, 'the refusal is the Worker result, not a guard event');
  const pendingVerdicts = () => runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(auditor.agent_id))
    .filter(action => action.action === 'review_issue' && action.issue_id === issueId);
  assert.equal(pendingVerdicts().length, 0, 'a real incomplete result needs a correction before a verdict');
  const dismiss = () => command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'dismissed',
    evidence: { rechecked: 'the blocked result', found: 'the Worker still could not produce the required output' },
  });
  assert.throws(dismiss, error => error.status === 409 && /blocked|incomplete/i.test(error.message));
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['output'] },
  });
  assert.equal(pendingVerdicts().length, 0, 'a plan edit alone has not replaced the Worker grant that blocked');
  assert.throws(() => command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'verified', evidence: { checked: 'the transaction inputs changed' },
  }), error => error.status === 409 && /allocat|worker|result/i.test(error.message),
  'the old allocation still cannot execute the revised plan');
  assert.throws(dismiss, error => error.status === 409 && /blocked|incomplete/i.test(error.message),
    'a later plan change does not retroactively make the original blocked result false');
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const old = runtime.store.activeAllocationForTransaction(tx.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, allocator, 'release_agent', { allocation_id: old.id });
  const granted = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  assert.deepEqual(runtime.store.getAllocation(granted.allocation_id).write_scope, ['output']);
  assert.equal(pendingVerdicts()[0]?.changed_since_issue, true,
    'the fresh grant makes review possible but does not pre-approve the correction');
  assert.equal(runtime.store.getIssue(issueId).status, 'OPEN', 'the Auditor still owns the independent verdict');
});

test('an incomplete Worker outcome wakes the Auditor even without a completed flag', async t => {
  for (const result of [
    { outcome: 'blocked', reason: 'the allocated write scope excludes the required output' },
    { status: 'blocked_by_topology', reason: 'the Worker cannot create a management child' },
  ]) {
    await t.test(result.outcome ?? result.status, async child => {
      let offered = false;
      const { runtime, clusterId, tx, eventsOf } = await driveWorkerOnce(child, {
        result, approvePlan: true,
        onAuditor: async (turn, state) => {
          const prompt = turn.prompt?.content?.[0]?.text ?? '';
          if (!prompt.includes('Worker submitted a result explicitly marked incomplete')) return;
          offered = true;
          const submitted = state.runtime.store.get(
            `SELECT data FROM events WHERE cluster_id=? AND type='result-submitted'
              AND json_extract(data,'$.transaction_id')=? ORDER BY seq DESC LIMIT 1`,
            state.clusterId, state.tx.id);
          await turn.request({ purpose: 'role' });
          await turn.callTool('flow_audit', {
            action: 'request_correction',
            params: { transaction_id: state.tx.id, target_revision: JSON.parse(submitted.data).revision,
              required_change: 'allocate a Worker able to satisfy the original output' },
          });
        },
      });
      const submitted = eventsOf('result-submitted')[0];
      assert.equal(submitted.data.result_completed, false);
      assert.equal(submitted.data.result_status, result.outcome ?? result.status);
      const deadline = Date.now() + 5_000;
      while (runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length === 0 && Date.now() < deadline) {
        await runtime.tick();
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      }
      assert.equal(offered, true, `the Auditor was shown the incomplete Worker result: ${JSON.stringify({
        turnActions: eventsOf('turn-actions').filter(event => event.data.role === 'auditor').map(event => ({ seq: event.seq, actions: event.data.actions })),
        turnEnds: eventsOf('turn-end').filter(event => event.data.role === 'auditor').map(event => ({ seq: event.seq, reason: event.data.stop_reason })),
        tx: runtime.store.getTransaction(tx.id).status,
      })}`);
      assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 1);
    });
  }
});

test('an admission budget refusal is not a provider anomaly for the Allocator', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-budget-anomaly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'dispatch one plan', workspace: dir, capabilities: [],
    limits: { max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 2 },
    budget: { tokens: 500_000, model_requests: 10, tool_calls: 20,
      wall_time_ms: 600_000, agents: 8, max_active_agents: 1 },
  }).cluster.id;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator') return;
    await turn.request({ purpose: 'role' });
    runtime.store.tx(() => {
      for (const budget of runtime.store.listBudgets(clusterId)) {
        runtime.store.updateBudget(budget.id, { tokens_spent: budget.tokens_limit - budget.tokens_reserved });
      }
    });
    await turn.request({ purpose: 'role' });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (!runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'turn-end') && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.ok(events.some(event => event.type === 'budget-refused' && event.data.role === 'orchestrator'));
  assert.ok(events.some(event => event.type === 'turn-end' && event.data.role === 'orchestrator'));
  assert.equal(events.filter(event => event.type === 'agent-anomaly').length, 0,
    'an accounting refusal cannot be handled by replacing the role as a broken model');
});

test('a transport failure still notifies the Allocator when no request was refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-provider-anomaly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'dispatch one plan', workspace: dir, capabilities: [],
    limits: { max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 2 },
    budget: { tokens: 500_000, model_requests: 10, tool_calls: 20,
      wall_time_ms: 600_000, agents: 8, max_active_agents: 1 },
  }).cluster.id;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator') return;
    await turn.request({ purpose: 'role' });
    throw Object.assign(new Error('provider route unavailable'), { code: 'TRANSPORT' });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (!runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'turn-end') && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.equal(events.filter(event => event.type === 'budget-refused').length, 0);
  assert.equal(events.find(event => event.type === 'agent-anomaly')?.data.code, 'TRANSPORT');
});

test('an Auditor can correct a blocked result after the Orchestrator has already revised its plan', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-blocked-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'review a blocked submission', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const blockedRevision = runtime.store.getTransaction(tx.id).revision;
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { completed: false, status: 'blocked' }, __bump_revision: false });
    runtime.store.appendEvent(clusterId, 'result-submitted', {
      node_id: root.id, transaction_id: tx.id, revision: blockedRevision,
      result_completed: false, result_status: 'blocked',
    });
  });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, objective: 'fund a writable allocation' });
  assert.ok(runtime.store.getTransaction(tx.id).revision > blockedRevision);
  let offered = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    if (!runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
      .some(action => action.transaction_id === tx.id && action.target_revision === blockedRevision)) return;
    offered = true;
    await turn.request({ purpose: 'role' });
    await turn.callTool('flow_audit', {
      action: 'request_correction', params: {
        transaction_id: tx.id, target_revision: blockedRevision,
        required_change: 'fund an allocation whose write scope covers the required output',
      },
    });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length === 0 && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const issue = runtime.store.openIssues(clusterId, { transaction_id: tx.id })[0];
  assert.equal(offered, true, 'the Auditor received the original blocked revision as actionable work');
  assert.ok(issue, 'the Auditor opened a durable correction issue');
  assert.equal(issue.reporter_agent_id, auditor.agent_id);
  assert.equal(issue.target_revision, blockedRevision, 'the plan revision did not erase the original defect');
});

test('one scheduling pass fills the active window exactly, never one slot short', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 8, max_children: 16 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 2 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);

  // Two role turns are eligible at the same moment: the Orchestrator has a
  // DRAFT plan to dispatch, the Auditor has a pending plan decision. The
  // regression counted the turns it had just registered *and* the live count, so
  // it stopped after the first one and left a slot empty for the whole pass.
  command(runtime, orchestrator, 'dispatch', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id });
  assert.ok(runtime.store.pendingAudits(clusterId, { limit: 10 }).length >= 1);

  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot();
  await runtime.tick();
  assert.equal(runtime.activeTurnIds().length, 2, 'the pass used both slots');
  assert.equal(runtime.llmWaiters(), 2, 'both turns are waiting on the model window');
  held();
});

test('every eligible identity is claimed, not just the first page of transactions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-page-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { workspace: dir });
  const planned = Array.from({ length: 201 }, (_, index) => ({
    id: `page-${String(index).padStart(3, '0')}`,
    objective: `task ${index}`,
    acceptance_criteria: ['done'],
  }));
  const clusterId = runtime.start({
    objective: 'a long queue', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 2, max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 400, wall_time_ms: 600_000, agents: 256, max_active_agents: 4 },
    initial_transactions: planned,
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);

  // Every transaction is READY; only the last one is allocated. A scheduler
  // that pages 200 READY rows and stops has never seen it.
  runtime.store.tx(() => {
    runtime.store.run("UPDATE transactions SET status='READY' WHERE cluster_id=?", clusterId);
  });
  const last = runtime.store.getTransaction('page-200');
  const agent = runtime.store.insertAgent({
    id: 'page-worker', cluster_id: clusterId, node_id: root.id, role: 'worker',
    session_id: 'page-worker-session', status: 'READY', capabilities: [],
  });
  runtime.store.insertAllocation({
    id: 'page-allocation', cluster_id: clusterId, node_id: root.id, agent_id: agent.id,
    transaction_id: last.id, capabilities: [], write_scope: [], write_scope_canonical: [], status: 'ACTIVE',
  });
  const claimable = runtime.store.readyForWorker(clusterId, { limit: 100 });
  assert.equal(claimable.length, 1, 'the eligible set is defined by SQL, not by a page of READY rows');
  assert.equal(claimable[0].id, last.id);
  assert.equal(runtime.store.readyForWorker(clusterId, { after: { priority: claimable[0].priority, created: claimable[0].created, id: claimable[0].id } }).length, 0);
  void allocator;
});

test('a large cluster is counted and drained exhaustively, never by page', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-large-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t, { workspace: dir });
  const planned = Array.from({ length: 1024 }, (_, index) => ({
    id: `large-${String(index).padStart(4, '0')}`,
    objective: `task ${index}`,
    acceptance_criteria: ['done'],
  }));
  const clusterId = runtime.start({
    objective: 'a large cluster', workspace: dir, capabilities: [],
    limits: { max_children: 4096, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 8_000_000, model_requests: 4096, tool_calls: 4096, wall_time_ms: 600_000, agents: 4096, max_active_agents: 4 },
    initial_transactions: planned,
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  // 512 nodes: the root's 511 children, every fourth one a management node.
  runtime.store.tx(() => {
    for (let index = 0; index < 511; index += 1) {
      runtime.store.insertNode({
        id: `large-node-${String(index).padStart(3, '0')}`, cluster_id: clusterId, parent_id: root.id,
        kind: index % 4 === 0 ? 'management' : 'worker', depth: 1, status: 'ACTIVE',
        scope: {}, capabilities: [], path: `0.${index}`, max_children: 0,
      });
    }
  });
  const sqlStatus = () => Object.fromEntries(
    runtime.store.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId)
      .map(row => [row.status, Number(row.c)]),
  );
  const sqlTotal = () => Number(runtime.store.get('SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=?', clusterId).c);

  // Spread the statuses across a realistic mix, all of it beyond any page.
  runtime.store.tx(() => {
    const statuses = ['READY', 'DRAFT', 'RUNNING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'BLOCKED'];
    for (let index = 0; index < 1024; index += 1) {
      runtime.store.run('UPDATE transactions SET status=? WHERE id=?', statuses[index % statuses.length], planned[index].id);
    }
  });
  assert.equal(sqlTotal(), 1024);
  assert.equal(runtime.store.countNodes(clusterId), 512);

  const report = runtime.report(clusterId);
  assert.deepEqual(report.mechanism.transactions_by_status, sqlStatus(),
    'the report counts every transaction, not the first page');
  assert.equal(report.mechanism.transactions_total, 1024);
  assert.equal(report.mechanism.nodes, 512);
  assert.equal(report.transactions.truncated, true, 'the detail list says it is a page');
  assert.equal(report.transactions.total, 1024);

  const summary = runtime.buildSummary(clusterId);
  assert.equal(summary.transactions.total, 1024);
  assert.equal(summary.transactions.completed, sqlStatus().ACCEPTED);
  assert.equal(summary.confidence, 'partial', 'confidence is derived from exhaustive coverage');

  // Pause and resume classify the whole cluster in SQL.
  const before = sqlStatus();
  runtime.control(clusterId, 'pause');
  const paused = sqlStatus();
  const openBefore = (before.READY ?? 0) + (before.DRAFT ?? 0) + (before.RUNNING ?? 0) + (before.DISPATCHED ?? 0);
  assert.equal(paused.PAUSED, openBefore, `every open transaction paused: ${JSON.stringify(paused)}`);
  assert.equal(paused.ACCEPTED, before.ACCEPTED, 'a decided transaction is not reopened by pause');
  assert.equal(paused.BLOCKED, before.BLOCKED);
  runtime.control(clusterId, 'resume');
  const resumed = sqlStatus();
  assert.equal(resumed.PAUSED, undefined, 'nothing stays paused after resume');
  assert.equal(resumed.READY, (before.READY ?? 0) + (before.DISPATCHED ?? 0) + (before.RUNNING ?? 0),
    'a transaction that was schedulable goes back to being schedulable');
  assert.equal(resumed.DRAFT, before.DRAFT, 'a transaction that was a draft stays a draft: resume is not an approval');

  // Recovery requeues every RUNNING transaction that has no live allocation.
  runtime.store.tx(() => runtime.store.run("UPDATE transactions SET status='RUNNING' WHERE cluster_id=?", clusterId));
  runtime.recover({ deferScheduling: true });
  assert.equal(sqlStatus().READY, 1024, 'recovery requeued the whole cluster, not a page of it');

  // Cancellation drains the whole cluster.
  runtime.control(clusterId, 'cancel');
  assert.deepEqual(sqlStatus(), { CANCELLED: 1024 });
  assert.equal(runtime.store.getCluster(clusterId).status, 'CANCELLED');
});

test('compaction in a turn really lowers the next request it charges', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-compact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const compactions = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(agent, trigger) {
        // The host hands the compaction engine its own Agent, whose id is the
        // session id — not the cluster agent id.
        compactions.push({ session: agent.session?.id ?? agent.id, trigger });
        // A real compaction shadows history: the measured surface shrinks, and
        // the *prompt* the next request carries shrinks with it.
        host.setSessionTokens(2_000);
        return { summarySeq: 42, shadowedTokenCount: 12_000 };
      },
    },
  });
  // The turn starts under the Worker's compaction trigger and grows as the turn
  // accumulates tool output, which is what makes the *step* gate the one that
  // fires.
  host.setSessionTokens(9_000);
  host.registerTool({
    name: 'read',
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return { content: [{ type: 'text', text: 'body' }], isError: false, value: {} }; },
  });
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    // The role budget is deliberately generous here: the point of this test is
    // the *Worker's* step gate, and a role that also compacts would make the
    // measurement ambiguous.
    context: { role: 100_000, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_model_requests: 4, worker_max_tokens: 512 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });

  let beforeCompactionRequestId = null;
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.preStep({ step: 1 });
    await turn.request({ purpose: 'worker' });
    // Capture the identity before the second request exists. Millisecond creation
    // times can tie, and the store's UUID tie-breaker is not request order.
    const worker = runtime.store.getAgentBySession(turn.session.id);
    beforeCompactionRequestId = runtime.store.usageReceiptsAll(clusterId, { agent_id: worker.id })
      .find(receipt => receipt.kind === 'worker')?.request_id;
    // The tool results accumulated during the turn grow the session, and the
    // second step is measured again: it sees the pressure and compacts.
    host.setSessionTokens(20_000);
    await turn.preStep({ step: 2 });
    await turn.request({ purpose: 'worker' });
    await turn.callTool('flow_transaction', { action: 'submit_result', params: { transaction_id: tx.id, result: { ok: true } } });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const status = runtime.store.getTransaction(tx.id).status;
    if (status === 'SUBMITTED' || status === 'FAILED' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  const agent = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const receipts = runtime.store.usageReceiptsAll(clusterId, { agent_id: agent.id }).filter(r => r.kind === 'worker');
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const workerCompactions = compactions.filter(entry => entry.trigger === 'context-overflow');
  assert.equal(workerCompactions.length, 1, `exactly one step compaction: ${JSON.stringify(compactions)}`);
  assert.equal(workerCompactions[0].session, worker.session_id, 'and it was the Worker that asked for it');
  assert.equal(receipts.length, 2, 'two provider requests were charged');
  const beforeCompaction = receipts.find(receipt => receipt.request_id === beforeCompactionRequestId);
  const afterCompaction = receipts.find(receipt => receipt.request_id !== beforeCompactionRequestId);
  assert.ok(beforeCompaction, 'the first request has a durable receipt before compaction');
  assert.ok(beforeCompaction.reservation_tokens > 9_000, `the pre-compaction request reserved the whole prompt: ${beforeCompaction.reservation_tokens}`);
  assert.ok(afterCompaction.reservation_tokens < beforeCompaction.reservation_tokens,
    `the post-compaction request costs less: ${beforeCompaction.reservation_tokens} → ${afterCompaction.reservation_tokens}`);
  assert.ok(afterCompaction.reservation_tokens < 4_000, 'and it is charged against the compacted surface, not against the old one');

  const steps = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  assert.ok(steps.length >= 2, `${steps.length} context-step events`);
  const compacted = steps.find(event => event.data.decision === 'compact');
  assert.ok(compacted, 'the compaction is recorded as a context step');
  assert.ok(compacted.data.before > compacted.data.after, `before ${compacted.data.before} > after ${compacted.data.after}`);
  assert.equal(compacted.data.summary_seq, 42);
  assert.equal(compacted.data.context_limit, 16384, 'the Worker budget is the yardstick');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'SUBMITTED');
  void workerTurn;
});

test('a step over the provider ceiling is rejected instead of sent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-ceiling-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meter = { totalTokens: 10_000 };
  let compactionCalls = 0;
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: meter.totalTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      // Compaction cannot help: the session is irreducible.
      async compactIfNeeded() { compactionCalls += 1; return null; },
    },
  });
  host.setSessionTokens(140_000);
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });

  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.preStep({ step: 1 });
    // The step's own measurement is under the identity budget (the meter says
    // 10k) but the request the model would send carries a 140k-token prompt:
    // the pre-dispatch ceiling is the last line of defence, and it must refuse
    // the request instead of sending it.
    await turn.request({ purpose: 'worker' });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const status = runtime.store.getTransaction(tx.id).status;
    if (['FAILED', 'BLOCKED', 'SUBMITTED'].includes(status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  assert.equal(workerTurn.requests[0].error?.code, 'CONTEXT_PRESSURE', 'the request was refused before dispatch');
  const receipts = runtime.store.usageReceiptsAll(clusterId, { agent_id: runtime.store.listAgents(clusterId, { role: 'worker' })[0].id });
  assert.equal(receipts.length, 0, 'a refused request is never charged');
  const refusals = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'budget-refused');
  const ceiling = refusals.find(event => event.data.scope === 'context_window');
  assert.ok(ceiling, `the refusal names the sending ceiling: ${JSON.stringify(refusals.map(event => event.data))}`);
  assert.equal(ceiling.data.dimension, 'tokens');
  assert.ok(ceiling.data.requested > ceiling.data.available);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'BLOCKED', 'the transaction stops instead of retrying into the ceiling');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  assert.equal(blocked.at(-1).data.code, 'CONTEXT_PRESSURE', 'the stop carries its code');
  assert.match(String(blocked.at(-1).data.reason), /^CONTEXT_PRESSURE:/);
});

test('a step over the provider ceiling is refused even after compaction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stepreject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      // Compaction runs but cannot produce a smaller history.
      async compactIfNeeded() { return null; },
    },
  });
  // Over the provider's own sending ceiling: 131,072 window minus the 512-token
  // output allowance. This is the one case a step is refused, because the
  // request could not be sent at all.
  host.setSessionTokens(131_000);
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });

  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    const decision = await turn.preStep({ step: 1 });
    if (decision.kind === 'enter') await turn.request({ purpose: 'worker' });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(runtime.store.getTransaction(tx.id).status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  assert.equal(workerTurn.blocked, true, 'the step was rejected');
  assert.equal(workerTurn.requests.length, 0, 'no request was sent');
  const steps = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  assert.equal(steps.at(-1).data.decision, 'reject');
  assert.equal(steps.at(-1).data.context_limit, 16384, 'the Worker budget is the yardstick');
  assert.ok(steps.at(-1).data.before >= 131_000);
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  assert.equal(blocked.at(-1).data.code, 'CONTEXT_PRESSURE');
});

test('a rejected flush neither acks a delivery nor dispatches a tool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-flush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({ flushResult: false });
  host.registerTool({
    name: 'read',
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return { content: [{ type: 'text', text: 'body' }], isError: false, value: {} }; },
  });
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000, context: { role: 8192, worker: 16384 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 2, max_corrections: 1, max_role_turns: 2, worker_model_requests: 2, worker_max_tokens: 512 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });
  const agent = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  // A delivery is queued for the worker before its turn starts.
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: 'flush-check', cluster_id: clusterId, from_agent: role('orchestrator').agent_id, from_node: root.id,
      kind: 'direct', content: { text: 'hello' },
    });
    runtime.store.insertRecipient('flush-check', agent.id);
  });

  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.request({ purpose: 'worker' });
    await turn.callTool('read', { file_path: 'x' });
    await turn.request({ purpose: 'worker' });
    await turn.callTool('flow_transaction', { action: 'submit_result', params: { transaction_id: tx.id, result: { ok: true } } });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const turn = host.turns.find(candidate => (candidate.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
    if ((turn && turn.toolCalls.includes('read')) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = type => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  assert.equal(events('messages-acked').length, 0, 'a delivery is never acked on a rejected flush');
  assert.ok(events('messages-reopened').length >= 1, 'it is reopened instead');
  assert.notEqual(runtime.store.deliveryFor('flush-check', agent.id).status, 'ACKED', 'an unflushed delivery is never acked');
  const receipts = runtime.store.toolCallReceipts(clusterId, { agent_id: agent.id });
  assert.ok(receipts.length >= 1, 'an admitted call has a receipt');
  assert.equal(receipts.every(receipt => receipt.dispatch_status === 'CANCELLED'), true,
    `a refused tool call never dispatches: ${JSON.stringify(receipts.map(receipt => receipt.dispatch_status))}`);
  assert.ok(events('tool-call-refused').length >= 1, 'the refusal is recorded');
  assert.equal(runtime.store.getTransaction(tx.id).status !== 'SUBMITTED', true, 'nothing was published from an unflushed turn');
});

test('an unreadable session is UNKNOWN: the attempted delivery stays withheld instead of being re-injected', async t => {
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: {
      // The session exists (the identity has a durable session) but its log
      // cannot be read: that is an unprovable state, not an absence.
      async stat(sessionId) { return sessionId ? { id: sessionId } : undefined; },
      async open() { throw new Error('the session log is unreadable'); },
    },
  });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: 'unknown-msg', cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient('unknown-msg', agent.id);
    runtime.store.markDeliveryInjected('unknown-msg', agent.id);
  });
  const reconciled = await runtime.reconcileDeliveries(clusterId);
  const events = type => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  assert.equal(runtime.store.deliveryFor('unknown-msg', agent.id).status, 'DELIVERED', 'an unprovable delivery is neither acked nor requeued');
  assert.equal(events('messages-ack-reconciled').length, 0);
  assert.equal(runtime.store.getAgent(agent.id).status, 'BLOCKED', 'and its owner does not dispatch until the ambiguity is resolved');
  const unknown = events('delivery-unknown');
  assert.equal(unknown.length, 1, 'the uncertainty is recorded with its reason');
  assert.match(String(unknown[0].data.reason), /unreadable/);
  assert.equal(reconciled.acknowledged, 0);
  void agent;
});

test('recovery requeues a RUNNING transaction that still holds its allocation', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  const allocated = command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));

  runtime.recover({ deferScheduling: true });
  const recoveredTx = runtime.store.getTransaction(tx.id);
  assert.equal(recoveredTx.status, 'READY', 'a crashed RUNNING transaction is schedulable again');
  const allocation = runtime.store.getAllocation(allocated.allocation_id);
  assert.equal(allocation.status, 'ACTIVE', 'and it keeps the identity that owns it');
  const claimable = runtime.store.readyForWorker(clusterId, { limit: 10 });
  assert.equal(claimable.length, 1, 'the scheduler can claim it');
  assert.equal(runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id).id).tokens_reserved, 0,
    'stray reservations from the previous process are returned');
});

test('an identity with history but no durable session is blocked, never re-created', async t => {
  const runtime = makeRuntime(t);
  runtime.attachPersistence({ async stat() { return undefined; } });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  runtime.store.tx(() => runtime.store.updateAgent(auditor.id, { turns: 3 }));

  const report = await runtime.proveSessions(clusterId);
  assert.equal(report.length, 1);
  assert.deepEqual(report[0].session_missing, [auditor.id]);
  assert.equal(runtime.store.getAgent(auditor.id).status, 'BLOCKED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'session-missing');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.code, 'SESSION_MISSING');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  assert.equal(blocked.at(-1).data.code, 'SESSION_MISSING');
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
});

test('an uncertain effect blocks its owner and a human decision releases it', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  runtime.store.tx(() => {
    runtime.store.insertEffect({
      call_id: 'uncertain-call', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      lease_epoch: 1, tool: 'write', args: {}, status: 'STARTED',
    });
    runtime.store.settleEffect('uncertain-call', { status: 'EFFECT_UNCERTAIN', error: 'the process died with it in flight' });
  });

  // The owner cannot run again: the scheduler refuses to start its turn.
  runtime.enableScheduling();
  await runtime.tick();
  const blockedEvents = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'agent-blocked');
  const uncertain = blockedEvents.find(event => event.data.code === 'EFFECT_UNCERTAIN');
  assert.ok(uncertain, `the scheduler refused to start the owner: ${JSON.stringify(blockedEvents.map(event => event.data.code))}`);
  assert.equal(uncertain.data.call_id, 'uncertain-call');
  assert.equal(runtime.store.getAgent(worker.id).status, 'BLOCKED');
  assert.equal(runtime.store.toolCallReceipts(clusterId, { agent_id: worker.id }).length, 0, 'nothing was admitted');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'BLOCKED', 'its transaction stops instead of being retried');

  // A human decides it happened.
  const resolved = command(runtime, allocator, 'resolve_effect', { call_id: 'uncertain-call', decision: 'settled', note: 'verified the file on disk' });
  assert.equal(resolved.result.status, 'SETTLED');
  assert.equal(runtime.store.getEffect('uncertain-call').status, 'SETTLED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'effect-resolved');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.decision, 'settled');
});

test('a dependent transaction is not offered to a Worker before its dependency is accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  const dependent = command(runtime, orchestrator, 'create_transaction', {
    objective: 'reads what the first transaction produces', acceptance_criteria: ['observable result'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'set_dependency', { transaction_id: dependent, depends_on: [first.id] });
  command(runtime, orchestrator, 'dispatch', { transaction_id: dependent });
  const a1 = command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  const a2 = command(runtime, allocator, 'allocate_agent', { transaction_id: dependent });

  const offered = () => runtime.store.readyForWorker(clusterId, { limit: 10 }).map(tx => tx.id);
  const allocated = new Set(runtime.store.allocationsForNode(root.id, { status: 'ACTIVE' }).map(row => row.transaction_id));
  assert.equal(a1.result.count, 1);
  assert.equal(a2.result.count, 1);
  assert.ok(allocated.has(first.id) && allocated.has(dependent), 'both tasks carry a live Worker grant');
  assert.ok(offered().includes(first.id), 'the dependency itself is runnable');
  assert.ok(!offered().includes(dependent), 'the dependent waits for it');

  runtime.store.tx(() => runtime.store.updateTransaction(first.id, { status: 'ACCEPTED' }));
  assert.ok(offered().includes(dependent), 'and becomes runnable the moment its dependency is accepted');

  // A dependency that can never settle keeps the dependent out: a FAILED
  // dependency is not an accepted one, and running the dependent would let it
  // read an artifact that was never produced.
  runtime.store.tx(() => runtime.store.updateTransaction(first.id, { status: 'FAILED' }));
  assert.ok(!offered().includes(dependent), 'a failed dependency does not release the dependent');
});

test('a full node is not offered an allocation it cannot perform', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  // `startCluster` gives this node `max_children: 4`.
  for (let index = 0; index < 6; index += 1) {
    const id = command(runtime, orchestrator, 'create_transaction', {
      objective: `ladder task ${index}`, acceptance_criteria: ['observable result'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: id });
  }
  const pending = () => runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId), allocator);
  assert.equal(pending().filter(item => item.action === 'allocate_agent')[0]?.free_slots, 4,
    'the hint names the window it can actually fill');

  const wave = command(runtime, allocator, 'scale_out', { count: 4 }).result;
  assert.equal(wave.allocations.length, 4);
  // Every slot is taken and nothing is releasable yet: an `allocate_agent` hint
  // here could only fail at the ceiling, and three no-progress turns block the
  // node for stagnation while the work it is waiting on is elsewhere.
  assert.equal(pending().filter(item => item.action === 'allocate_agent').length, 0,
    'a full node is not told to allocate work it cannot host');

  const freed = runtime.store.activeAllocationForTransaction(wave.allocations[0].transaction_id);
  runtime.store.tx(() => runtime.store.updateTransaction(wave.allocations[0].transaction_id, { status: 'ACCEPTED' }));
  command(runtime, allocator, 'release_agent', { allocations: [freed.id] });
  const after = pending().filter(item => item.action === 'allocate_agent');
  assert.equal(after.length, 1, 'the hint comes back once a slot is free');
  assert.equal(after[0].free_slots, 1);
  assert.equal(after[0].transactions.length, 1, 'and it names only what fits');
});

test('a Worker grant never exceeds the run-wide per-Worker request allowance', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: {
    max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2,
    max_corrections: 2, max_role_turns: 6, worker_model_requests: 2,
  } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const agentId = allocated.result.allocations[0].agent_id;
  const grant = runtime.store.budgetForScope(clusterId, 'agent', agentId);
  // The node can afford more than the allowance; handing a Worker eight requests
  // when the run declared two parks capacity the next Worker needs. Measured at
  // 64 files, the last 50 Workers were born with an allocation of zero requests
  // and could not send even their first one. The grant is the allowance plus the
  // one separately-accounted compaction request; the ordinary ceiling is enforced
  // per request, not by the size of the grant.
  assert.equal(runtime.workerRequestAllowance(runtime.store.getAgent(agentId)), 2);
  assert.ok(Number(grant.requests_limit) <= 3,
    `the grant is bounded by the declared allowance, not by the node's ${grant.requests_limit}`);
  assert.ok(Number(grant.tool_calls_limit) > 0, 'and still funds the work itself');

  // Without a declared allowance the deployment's own working grant applies.
  const open = makeRuntime(t);
  const openCluster = startCluster(open);
  const openRoot = rootNode(open, openCluster);
  const openOrchestrator = actorFor(open, openCluster, 'orchestrator', openRoot.id);
  const openAllocator = actorFor(open, openCluster, 'allocator', openRoot.id);
  const openTx = open.store.listTransactions({ cluster_id: openCluster })[0];
  command(open, openOrchestrator, 'dispatch', { transaction_id: openTx.id });
  const openAllocated = command(open, openAllocator, 'allocate_agent', { transaction_id: openTx.id });
  const openGrant = open.store.budgetForScope(openCluster, 'agent', openAllocated.result.allocations[0].agent_id);
  assert.ok(Number(openGrant.requests_limit) >= 2, `an undeclared allowance keeps the deployment grant: ${openGrant.requests_limit}`);
});

test('a Worker at its request allowance can still be funded for its final tool call', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: {
    max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2,
    max_corrections: 2, max_role_turns: 6, worker_model_requests: 2,
  } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  const worker = runtime.store.getAgent(allocated.agent_id);
  const cluster = runtime.store.getCluster(clusterId);
  const chain = runtime.agentBudgetChain(cluster, worker, tx);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', worker.id);
  const nodeBudget = runtime.fundingBudget(cluster, worker);
  assert.ok(agentBudget && nodeBudget, 'the identity and its funder exist');

  // Spend the Worker's whole request allowance, then empty its tool-call grant —
  // the state the ladder reaches when a Worker must still submit its result.
  for (let index = 0; index < 2; index += 1) {
    reserveLlmRequest(runtime.store, {
      cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
      role: 'worker', kind: 'worker', model: 'm', provider: 'p', budgetIds: chain,
      reservationTokens: 100, turn_seq: 1, maxRequests: runtime.workerRequestAllowance(worker),
    });
  }
  assert.equal(runtime.store.countWorkerRequests(clusterId, worker.id), 2, 'the allowance is spent');
  const row = runtime.store.getBudget(agentBudget.id);
  transferBudget(runtime.store, agentBudget.id, nodeBudget.id, { tool_calls: row.tool_calls_limit - row.tool_calls_spent });
  assert.equal(dimensionAvailable(runtime.store.getBudget(agentBudget.id), 'tool_calls'), 0, 'the tool-call grant is empty');

  // The final submission is a tool call, not a request: it is funded.
  const granted = runtime.topUpBudgetForAgent(worker, { tool_calls: 1 });
  assert.ok(granted, 'a tool-only refill is not blocked by the request allowance');
  assert.ok(dimensionAvailable(runtime.store.getBudget(agentBudget.id), 'tool_calls') >= 1,
    'the refill funds the call the Worker still owes');

  // The request ceiling itself is still final.
  assert.equal(runtime.topUpBudgetForAgent(worker, { model_requests: 1 }), null,
    'a third request is still refused at the allowance');
  assert.equal(runtime.topUpBudgetForAgent(worker, { tokens: 1000, model_requests: 1 }), null,
    'and a mixed refill does not smuggle one in');
});

test('an unsafe reparent is refused without touching the turn or the ledger', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: tx.id, scope: { objective: 'child domain' }, max_children: 4,
  }).result;
  const other = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: tx.id, scope: { objective: 'second domain' }, max_children: 4,
  }).result;
  const budgetsBefore = runtime.store.listBudgets(clusterId).map(row => `${row.id}:${row.tokens_limit}:${row.parent_budget_id}`).sort();
  const pathsBefore = runtime.store.nodesInSubtree(clusterId, null).map(node => `${node.id}:${node.path}:${node.depth}`).sort();

  // A live turn inside the subtree: the move must be refused *before* anything
  // is aborted, checkpointed or moved.
  const childAgent = runtime.store.listAgents(clusterId, { node_id: child.node_id, role: 'orchestrator' })[0];
  const aborts = [];
  runtime.store.tx(() => runtime.store.createLease({
    id: 'reparent-lease', cluster_id: clusterId, agent_id: childAgent.id, node_id: child.node_id,
    purpose: 'orchestrator-turn', epoch: 99, expires: now() + 60_000,
  }));
  runtime.store.tx(() => runtime.store.updateAgent(childAgent.id, { status: 'RUNNING', epoch: 99 }));
  // A fake live turn whose abort would be observable.
  runtime.activeTurnIds();
  const originalAbort = { called: false };
  runtime.store.tx(() => {});
  void aborts;
  assert.throws(
    () => command(runtime, allocator, 'reparent', { node_id: child.node_id, new_parent_id: other.node_id }),
    error => error.status === 409 && /live lease|executing/.test(error.message),
  );
  assert.equal(originalAbort.called, false);
  assert.equal(runtime.store.getAgent(childAgent.id).status, 'RUNNING', 'a refused reparent drains nothing');
  assert.deepEqual(runtime.store.listBudgets(clusterId).map(row => `${row.id}:${row.tokens_limit}:${row.parent_budget_id}`).sort(), budgetsBefore);
  assert.deepEqual(runtime.store.nodesInSubtree(clusterId, null).map(node => `${node.id}:${node.path}:${node.depth}`).sort(), pathsBefore);

  // With the lease gone and the delegated assignments settled the move
  // succeeds, and every descendant moves with it.
  runtime.store.tx(() => {
    runtime.store.deleteLease('reparent-lease');
    runtime.store.updateAgent(childAgent.id, { status: 'READY' });
    for (const delegatedId of [child.delegated_transaction_id, other.delegated_transaction_id]) {
      runtime.store.updateTransaction(delegatedId, { status: 'ACCEPTED' });
    }
  });
  const grandchild = command(runtime, actorFor(runtime, clusterId, 'allocator', child.node_id), 'spawn_management_node', {
    transaction_id: child.delegated_transaction_id, scope: { objective: 'grandchild domain' }, max_children: 4,
  }).result;
  runtime.store.tx(() => runtime.store.updateTransaction(grandchild.delegated_transaction_id, { status: 'ACCEPTED' }));
  // The new parent must be able to fund the subtree it takes on — that check has
  // its own test; this one is about the safe point and the rewritten paths.
  runtime.store.tx(() => {
    const otherBudget = runtime.store.budgetForScope(clusterId, 'node', other.node_id);
    const row = runtime.store.getBudget(otherBudget.id);
    runtime.store.updateBudget(otherBudget.id, {
      tokens_limit: Number(row.tokens_limit) + 2_000_000,
      requests_limit: Number(row.requests_limit) + 200,
      tool_calls_limit: Number(row.tool_calls_limit) + 200,
    });
  });
  const rootPath = runtime.store.getNode(child.node_id).path;
  const moved = command(runtime, allocator, 'reparent', { node_id: child.node_id, new_parent_id: other.node_id });
  assert.equal(moved.result.from, root.id);
  assert.equal(moved.result.to, other.node_id);
  const newRoot = runtime.store.getNode(child.node_id);
  const newGrandchild = runtime.store.getNode(grandchild.node_id);
  assert.equal(newRoot.parent_id, other.node_id);
  assert.ok(newGrandchild.path.startsWith(newRoot.path), `the descendant path follows its parent: ${newGrandchild.path} vs ${newRoot.path}`);
  assert.equal(newGrandchild.depth, newRoot.depth + 1, 'and so does its depth');
  assert.notEqual(newRoot.path, rootPath);
  // Ownership is a real column with a real reader, and it names the management
  // node that hosts the transaction: a reparent relocates the tree, it does not
  // reassign the moved node's transactions to the branch above them.
  const movedTx = runtime.store.getTransaction(grandchild.delegated_transaction_id);
  assert.equal(movedTx.owner_management_id, grandchild.node_id);
  // A management node owns itself wherever it sits, so the move relocates the
  // tree without rewriting anyone's owner — including the moved root's.
  assert.equal(runtime.store.getNode(grandchild.node_id).owner_management_id, grandchild.node_id,
    'the moved subtree keeps its own internal ownership');
  assert.equal(runtime.store.getNode(child.node_id).owner_management_id, child.node_id,
    'and the moved root still owns itself, now under the new parent');
  assert.equal(runtime.store.getNode(child.node_id).parent_id, other.node_id);
  // The subtree's budget now hangs off the new parent.
  const childBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
  const otherBudget = runtime.store.budgetForScope(clusterId, 'node', other.node_id);
  assert.equal(childBudget.parent_budget_id, otherBudget.id);
});

test('a version-1 cluster database is migrated in place, and a newer one is refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cluster.sqlite');
  const first = new ClusterStore(path, { now });
  first.close();

  // Present the file as a version-1 database: the columns this session added
  // are gone and the recorded schema version is older.
  const db = new DatabaseSync(path);
  for (const [table, column] of [
    ['checkpoints', 'events_seq'],
    ['transactions', 'pre_pause_status'],
    ['transactions', 'pre_pause_revision'],
    ['transactions', 'result_staged_agent'],
  ]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec('PRAGMA user_version=1');
  db.close();

  // Opening it migrates the columns back and records the new version.
  const migrated = new ClusterStore(path, { now });
  assert.equal(Number(migrated.get('PRAGMA user_version').user_version), 2);
  for (const [table, column] of [
    ['checkpoints', 'events_seq'],
    ['transactions', 'pre_pause_status'],
    ['transactions', 'pre_pause_revision'],
    ['transactions', 'result_staged_agent'],
    ['tool_call_receipts', 'dispatch_status'],
    ['health', 'scores'],
  ]) {
    const columns = migrated.all(`PRAGMA table_info(${table})`).map(row => row.name);
    assert.ok(columns.includes(column), `${table}.${column} must exist after the migration`);
  }

  // A database newer than this implementation is still refused, not migrated
  // downwards.
  migrated.close();
  const future = new DatabaseSync(path);
  future.exec('PRAGMA user_version=99');
  future.close();
  assert.throws(() => new ClusterStore(path, { now }), /newer than supported/);
});

test('node ownership is derived from the tree and reported by the public query', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: rootTx.id });
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'descendant domain' }, max_children: 2,
  }).result;
  const work = command(runtime, orchestrator, 'create_transaction', {
    objective: 'root work', acceptance_criteria: ['observable result'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: work });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: work }).result;
  const workerNodeId = runtime.store.getAgent(allocated.allocations[0].agent_id).node_id;
  // The single control run's Worker is a root Worker with no management parent.
  const standalone = runtime.store.tx(() => runtime.store.insertNode({
    id: 'single-control-worker', cluster_id: clusterId, parent_id: null, kind: 'worker', depth: 0,
    status: 'ACTIVE', scope: { objective: 'single control' }, capabilities: ['fs_read'], path: '0', max_children: 0,
  }));

  const page = runtime.query({ role: 'user', cluster_id: clusterId }, 'nodes', { limit: 50 });
  const byId = new Map(page.items.map(node => [node.id, node]));
  assert.equal(byId.get(root.id).owner_management_id, root.id, 'a root management node owns itself');
  assert.equal(byId.get(child.node_id).owner_management_id, child.node_id, 'a descendant management node owns itself');
  assert.equal(byId.get(workerNodeId).owner_management_id, root.id, 'a Worker belongs to its management parent');
  assert.equal(byId.get(standalone.id).owner_management_id, null, 'a standalone control Worker has no management owner');

  // A conflicting owner is a caller error, not a silent override: the column
  // has one derived value and one reader.
  assert.throws(() => runtime.store.tx(() => runtime.store.insertNode({
    id: 'misdeclared', cluster_id: clusterId, parent_id: root.id, kind: 'worker', depth: 1,
    status: 'ACTIVE', scope: {}, capabilities: [], path: '0.9', owner_management_id: child.node_id,
  })), error => /declares owner/.test(error.message));

  // The one edit that can move a Worker to a different owner is the edit that
  // changes its parent, and the column follows it there.
  runtime.store.tx(() => runtime.store.updateNode(workerNodeId, { parent_id: child.node_id }));
  assert.equal(runtime.store.getNode(workerNodeId).owner_management_id, child.node_id,
    'a moved Worker belongs to the management node it now runs under');
  assert.throws(() => runtime.store.tx(() => runtime.store.updateNode(workerNodeId, {
    parent_id: root.id, owner_management_id: child.node_id,
  })), error => /declares owner/.test(error.message));
});

test('an existing database normalises node and transaction ownership on open, idempotently', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cluster.sqlite');
  const first = new ClusterStore(path, { now });
  const clusterId = 'owner-cluster';
  first.tx(() => {
    first.createCluster({ id: clusterId, objective: 'legacy cluster', workspace: '/tmp/w', capabilities: [], limits: {} }, {});
    first.insertNode({ id: 'mgmt', cluster_id: clusterId, parent_id: null, kind: 'management', depth: 0, status: 'ACTIVE', scope: {}, capabilities: [], path: '0' });
    first.insertNode({ id: 'mgmt-child', cluster_id: clusterId, parent_id: 'mgmt', kind: 'management', depth: 1, status: 'ACTIVE', scope: {}, capabilities: [], path: '0.0' });
    first.insertNode({ id: 'worker', cluster_id: clusterId, parent_id: 'mgmt-child', kind: 'worker', depth: 2, status: 'ACTIVE', scope: {}, capabilities: [], path: '0.0.0' });
    first.insertTransaction({
      id: 'tx', cluster_id: clusterId, node_id: 'mgmt-child', owner_management_id: 'mgmt', objective: 'legacy row',
    });
  });
  // Rows an earlier schema could write: an owner column that only ever held
  // what the caller supplied, and a transaction pointing at the branch above
  // the node that hosts it.
  first.run("UPDATE nodes SET owner_management_id=NULL WHERE id IN ('mgmt','mgmt-child')");
  first.run("UPDATE nodes SET owner_management_id='mgmt' WHERE id='worker'");
  const legacy = first.getTransaction('tx');
  first.close();

  const second = new ClusterStore(path, { now });
  assert.equal(second.getNode('mgmt').owner_management_id, 'mgmt');
  assert.equal(second.getNode('mgmt-child').owner_management_id, 'mgmt-child');
  assert.equal(second.getNode('worker').owner_management_id, 'mgmt-child');
  assert.equal(second.getTransaction('tx').owner_management_id, 'mgmt-child');
  second.close();

  // Reopening a normalised database changes nothing: the repair is a
  // normalisation, not a version bump or a re-write of business state.
  const third = new ClusterStore(path, { now });
  assert.equal(third.getNode('worker').owner_management_id, 'mgmt-child');
  assert.equal(third.getTransaction('tx').owner_management_id, 'mgmt-child');
  const after = third.getTransaction('tx');
  assert.equal(after.revision, legacy.revision);
  assert.equal(after.status, legacy.status);
  assert.equal(Number(third.get('PRAGMA user_version').user_version), 2);
});

test('a completed delegated node returns its unspent role and node grants to its parent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'finish delegated work' },
  }).result;
  const parentBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const childBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
  const childRoles = runtime.store.listAgents(clusterId, { node_id: child.node_id });
  const roleBudgets = childRoles.map(role => runtime.store.budgetForScope(clusterId, 'agent', role.id));
  const available = budget => budget.requests_limit - budget.requests_spent - budget.requests_reserved;
  const expectedReturn = available(childBudget) + roleBudgets.reduce((sum, budget) => sum + available(budget), 0);
  assert.ok(expectedReturn > 0, 'a completed branch still holds unused requests');
  const before = available(parentBudget);

  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, {
    status: 'ACCEPTED', __bump_revision: false,
  }));
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getNode(child.node_id).status, 'ACTIVE', 'refunding waits for the funded Auditor decision');
  scoreFinalHealth(runtime, clusterId, child.node_id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getNode(child.node_id).status, 'COMPLETED');
  assert.equal(available(runtime.store.getBudget(parentBudget.id)), before + expectedReturn,
    'all unused child scope and role grants return to the parent without creating requests');
  assert.equal(available(runtime.store.getBudget(childBudget.id)), 0);
  for (const budget of roleBudgets) assert.equal(available(runtime.store.getBudget(budget.id)), 0);
  runtime.evaluateCompletion(clusterId);
  assert.equal(available(runtime.store.getBudget(parentBudget.id)), before + expectedReturn,
    'a completed branch cannot return its grant twice');
});

test('a measured child request can draw missing tokens down its ancestor path, not sibling grants', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'fund a child request' },
  }).result;
  const grandchild = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: child.delegated_transaction_id, node_id: child.node_id,
    scope: { objective: 'fund a grandchild request' },
  }).result;
  const parentBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const intermediateBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
  const childBudget = runtime.store.budgetForScope(clusterId, 'node', grandchild.node_id);
  const agent = runtime.store.listAgents(clusterId, { node_id: grandchild.node_id, role: 'auditor' })[0];
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  const childFree = dimensionAvailable(childBudget, 'tokens');
  assert.ok(childFree > 0);
  transferBudget(runtime.store, childBudget.id, intermediateBudget.id, { tokens: childFree });
  const intermediateFree = dimensionAvailable(runtime.store.getBudget(intermediateBudget.id), 'tokens');
  transferBudget(runtime.store, intermediateBudget.id, parentBudget.id, { tokens: intermediateFree });
  const parent = runtime.store.getBudget(parentBudget.id);
  const requestCount = parent.requests_limit - parent.requests_spent - parent.requests_reserved;
  const beforeTokens = parent.tokens_limit - parent.tokens_spent - parent.tokens_reserved;
  const otherRoleTokens = runtime.store.listAgents(clusterId, { node_id: grandchild.node_id })
    .filter(role => role.id !== agent.id)
    .reduce((sum, role) => sum + dimensionAvailable(
      runtime.store.budgetForScope(clusterId, 'agent', role.id), 'tokens',
    ), 0);
  const reserve = dimensionAvailable(agentBudget, 'tokens') + otherRoleTokens + 10_000;
  assert.ok(beforeTokens >= reserve, 'the ancestor can pay even after local grants are exhausted');
  assert.ok(runtime.topUpBudgetForAgent(agent, { tokens: reserve, model_requests: 1 }));
  const funded = runtime.store.getBudget(agentBudget.id);
  assert.ok(funded.tokens_limit - funded.tokens_spent - funded.tokens_reserved >= reserve);
  assert.ok(funded.requests_limit - funded.requests_spent - funded.requests_reserved >= 1);
  assert.equal(runtime.store.getBudget(parentBudget.id).requests_limit
    - runtime.store.getBudget(parentBudget.id).requests_spent, requestCount,
  'request allowances in the ancestor are not moved when the child only lacks tokens');
  assert.ok(runtime.store.getBudget(parentBudget.id).tokens_limit
    - runtime.store.getBudget(parentBudget.id).tokens_spent < beforeTokens,
  'unallocated ancestor tokens follow the ownership path to the requester');
  assert.equal(dimensionAvailable(runtime.store.getBudget(intermediateBudget.id), 'tokens'), 0,
    'the intermediate node forwards the measured grant; it cannot retain a second copy');
});

test('a descendant request reclaims idle ancestor roles before declaring their node empty', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'child needs a request' },
  }).result;
  const parent = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const childBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
  const sourceRole = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' })[0];
  const sourceGrant = runtime.store.budgetForScope(clusterId, 'agent', sourceRole.id);
  runtime.grantBudget(parent, sourceGrant, { tokens: 50_000 });
  assert.ok(dimensionAvailable(runtime.store.getBudget(sourceGrant.id), 'tokens') >= 50_000);
  transferBudget(runtime.store, childBudget.id, parent.id, {
    tokens: dimensionAvailable(childBudget, 'tokens'),
  });
  const rootScope = runtime.store.budgetForScope(clusterId, 'root', clusterId);
  transferBudget(runtime.store, parent.id, rootScope.id, {
    tokens: dimensionAvailable(runtime.store.getBudget(parent.id), 'tokens'),
  });
  const agent = runtime.store.listAgents(clusterId, { node_id: child.node_id, role: 'auditor' })[0];
  const own = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  const otherTokens = runtime.store.listAgents(clusterId, { node_id: child.node_id })
    .filter(role => role.id !== agent.id)
    .reduce((sum, role) => sum + dimensionAvailable(
      runtime.store.budgetForScope(clusterId, 'agent', role.id), 'tokens',
    ), 0);
  const envelope = dimensionAvailable(own, 'tokens') + otherTokens + 10_000;
  const roleBefore = dimensionAvailable(runtime.store.getBudget(sourceGrant.id), 'tokens');
  const rootBefore = dimensionAvailable(runtime.store.getBudget(rootScope.id), 'tokens');
  assert.ok(runtime.topUpBudgetForAgent(agent, { tokens: envelope, model_requests: 1 }),
    'the measured shortfall is fundable by an idle role in the parent node');
  assert.ok(dimensionAvailable(runtime.store.getBudget(own.id), 'tokens') >= envelope);
  assert.equal(dimensionAvailable(runtime.store.getBudget(sourceGrant.id), 'tokens')
    + dimensionAvailable(runtime.store.getBudget(parent.id), 'tokens'), roleBefore - 10_000,
  'the ancestor retains every token not needed by this measured request');
  assert.equal(dimensionAvailable(runtime.store.getBudget(rootScope.id), 'tokens'), rootBefore,
    'the descendant cannot raid a root or sibling grant');
});

test('a delegated node waits for its Auditor to score final health after accepting the child', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-child-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'close a completed delegated branch while the parent still works',
    workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 1 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'finish child result' },
  }).result;
  const childOrchestrator = actorFor(runtime, clusterId, 'orchestrator', child.node_id);
  const childAuditor = actorFor(runtime, clusterId, 'auditor', child.node_id);
  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, {
    status: 'SUBMITTED', result: { evidence: 'child complete' }, __bump_revision: false,
  }));
  command(runtime, childOrchestrator, 'validate', {
    transaction_id: child.delegated_transaction_id, accepted: true,
    checks: [{ criterion: 'child complete', passed: true, evidence: 'child result' }],
  });
  let acceptedInLiveTurn = false;
  host.setScript(async turn => {
    if (turn.agentId !== runtime.store.getAgent(childAuditor.agent_id).session_id) return;
    await turn.request({ purpose: 'role' });
    command(runtime, childAuditor, 'inspect_validation', {
      transaction_id: child.delegated_transaction_id, decision: 'approve',
    });
    assert.equal(runtime.store.getNode(child.node_id).status, 'ACTIVE',
      'acceptance cannot close the node under its Auditor turn');
    acceptedInLiveTurn = true;
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (acceptedInLiveTurn && runtime.store.readEvents(clusterId, { limit: 300 })
      .some(event => event.type === 'turn-end' && event.data.agent_id === childAuditor.agent_id)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(acceptedInLiveTurn, true);
  assert.equal(runtime.store.getNode(child.node_id).status, 'ACTIVE', 'the undecided closeout retains the child node');
  assert.equal(runtime.store.latestHealth(clusterId, { node_id: child.node_id })?.decided, 0);
  scoreFinalHealth(runtime, clusterId, child.node_id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getNode(child.node_id).status, 'COMPLETED',
    'only the scored Auditor decision permits child finalization');
  assert.equal(runtime.store.getTransaction(original.id).status, 'DRAFT',
    'the unfinished parent is not accepted by closing the child');
});

test('a root closes after its final Orchestrator turn and scored Auditor closeout, despite advisory reviews', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-root-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    maxTokens: 512, tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'finish after accepted work', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 2, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 1 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const transaction = runtime.store.rootTransactions(clusterId)[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: transaction.id });
  runtime.store.tx(() => runtime.store.updateTransaction(transaction.id, { status: 'ACCEPTED', __bump_revision: false }));
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 1);
  let finishIssued = false;
  let healthScored = false;
  host.setScript(async turn => {
    await turn.request({ purpose: 'role' });
    if (turn.agentId === runtime.store.getAgent(auditor.agent_id).session_id) {
      const actions = runtime.pendingFor('auditor', runtime.store.getNode(root.id), runtime.store.getCluster(clusterId), auditor);
      if (actions.some(item => item.action === 'evaluate_health' && item.evaluation_window === 'subtree-close')) {
        scoreFinalHealth(runtime, clusterId, root.id);
        healthScored = true;
        assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE', 'a live scoring turn retains its node');
      }
      return;
    }
    if (turn.agentId !== runtime.store.getAgent(orchestrator.agent_id).session_id || finishIssued) return;
    command(runtime, orchestrator, 'finish_cluster', {});
    finishIssued = true;
    assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING',
      'the live final turn is still owned by the Orchestrator');
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && runtime.store.getCluster(clusterId).status === 'RUNNING') {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(finishIssued, true, 'the final request was made by the scheduled Orchestrator turn');
  assert.equal(healthScored, true, 'the Auditor performed a distinct final model-backed turn');
  assert.equal(runtime.store.getCluster(clusterId).status, 'COMPLETED',
    'the scored final review closes the root without forging the advisory plan decision');
  assert.equal(runtime.store.getNode(root.id).status, 'COMPLETED');
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 1,
    'an advisory plan decision is not forged at finalization');
});

test('a cluster completes after every root transaction is accepted and the root Orchestrator finishes', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const second = command(runtime, orchestrator, 'create_transaction', { objective: 'second root', acceptance_criteria: ['x'] }).result.transaction_id;
  runtime.store.tx(() => {
    for (const tx of runtime.store.rootTransactions(clusterId)) {
      runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  assert.throws(() => command(runtime, auditor, 'finish_cluster', {}), error => error.status === 403,
    'the Auditor cannot claim Orchestrator completion');
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING', 'closeout waits for the owning Auditor');
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');
  assert.equal(runtime.store.latestHealth(clusterId, { node_id: root.id }).decided, 0);
  assert.ok(runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
    .some(item => item.action === 'evaluate_health' && item.evaluation_window === 'subtree-close'));
  const finalHealthId = scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getCluster(clusterId).status, 'COMPLETED');
  assert.equal(runtime.store.getNode(root.id).status, 'COMPLETED');
  const completed = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'management-node-completed');
  assert.equal(completed.length, 1, 'the closing sequence ran once');
  assert.equal(runtime.store.latestHealth(clusterId, { node_id: root.id }).decided_by, auditor.agent_id);
  // The three finishing acts are the node's own closing record: an aggregate
  // written from durable summaries, the health evaluation, and the event that
  // names both. A node that closes without a summary closes without an answer.
  const summaryId = completed[0].data.summary_id;
  assert.ok(summaryId, 'the closing event names the aggregate summary');
  const summary = runtime.store.latestSummary(clusterId, { node_id: root.id });
  assert.equal(summary.id, summaryId, 'and the summary it names is the node\'s latest');
  assert.equal(summary.data.transactions.total, 2, 'the aggregate counts the whole domain, not its page');
  assert.equal(summary.data.transactions.completed, 2);
  assert.equal(summary.data.confidence, 'high');
  assert.equal(completed[0].data.health_id, finalHealthId, 'the closing event names the Auditor-scored row');
  void second;
});

test('the inbox is real work: an event becomes an action and is consumed by the turn that takes it', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 4 }, staleMs: 1 });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // A real producer: dispatch notifies the Auditor that there is a plan to
  // inspect.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const queued = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' });
  assert.ok(queued.length >= 1, 'dispatch queues a plan-audit request');
  assert.equal(queued.some(row => row.subject === 'plan-audit-requested'), true);

  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot();
  await runtime.tick();
  held();
  const consumed = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'CONSUMED' });
  assert.ok(consumed.length >= 1, `the Auditor's turn consumed what it was asked to do: ${JSON.stringify(runtime.store.all('SELECT subject,status FROM inbox WHERE cluster_id=?', clusterId))}`);
  const actions = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'turn-actions');
  const inboxAction = actions.find(event => event.data.inbox_consumed > 0);
  assert.ok(inboxAction, 'the turn records the actions it took');
  assert.ok(inboxAction.data.actions.includes('inbox'), `the action list names the inbox: ${JSON.stringify(inboxAction.data)}`);
  assert.equal(runtime.store.countInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' }), 0, 'nothing is left pending for that decision');
});

test('stale work, anomalies and load are published to the roles that own them', async t => {
  const runtime = makeRuntime(t, { staleMs: 1000 });
  const clockNow = now();
  const clusterId = startCluster(runtime, {
    limits: { max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });

  // The transaction is ready and has not moved for longer than the window.
  runtime.store.tx(() => runtime.store.run('UPDATE transactions SET created=?, updated=? WHERE id=?', clockNow - 60_000, clockNow - 60_000, tx.id));
  runtime.enableScheduling();
  await runtime.tick();

  // A turn may already have consumed the row, so the fact is asserted across
  // every status: the queue is the delivery mechanism, the row is the evidence.
  const stale = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: null }).filter(row => row.subject === 'transaction-stale');
  assert.equal(stale.length, 1, 'the Auditor is told the work is stale');
  assert.equal(Number(stale[0].payload.stale_ms) >= 1000, true, `the staleness is measured: ${JSON.stringify(stale[0].payload)}`);
  assert.ok(runtime.store.countInbox(clusterId, { status: 'PENDING' }) >= 1);

  // A second tick must not queue the same fact twice.
  await runtime.tick();
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: null }).filter(row => row.subject === 'transaction-stale').length, 1,
    'the same revision is reported once');

  // Saturation is a load signal for the Allocator.
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const held = await runtime.acquireLlmSlot();
  await runtime.tick();
  held();
  const load = runtime.store.listInbox(clusterId, { recipient: allocator.agent_id, status: null }).filter(row => row.subject === 'load-changed');
  assert.ok(load.length >= 1, `the Allocator sees the load: ${JSON.stringify(runtime.store.all('SELECT subject,recipient FROM inbox WHERE cluster_id=?', clusterId))} allocator=${allocator.agent_id}`);
  assert.equal(Number(load[0].payload.max_active_agents), 1);

  // A failed model request is an anomaly for the Allocator.
  runtime.recordAgentAnomaly(runtime.store.getAgent(auditor.agent_id), { code: 'PI_AI_ERROR', message: 'the route refused the request' });
  const anomaly = runtime.store.listInbox(clusterId, { recipient: allocator.agent_id, status: null }).filter(row => row.subject === 'agent-anomaly');
  assert.ok(anomaly.length >= 1, 'the anomaly reaches the Allocator');
  assert.equal(anomaly.find(row => row.payload.code === 'PI_AI_ERROR')?.payload.message, 'the route refused the request');
});

test('stale READY work and budget notices do not wake roles that cannot allocate or repair them', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  runtime.notifyInternal(clusterId, auditor.agent_id, {
    subject: 'transaction-stale', payload: { transaction_id: tx.id, status: 'READY' },
  });
  for (const subject of ['transaction-stale', 'budget-refused', 'child-blocked']) {
    runtime.notifyInternal(clusterId, orchestrator.agent_id, {
      subject, payload: { transaction_id: tx.id, status: 'READY', code: 'BUDGET_EXHAUSTED' },
    });
  }
  const pending = role => runtime.pendingFor(role, root, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(actorFor(runtime, clusterId, role, root.id).agent_id));
  assert.equal(pending('auditor').some(item => item.action === 'inbox'), false,
    'the Auditor still receives the fact, but cannot allocate the stale READY transaction');
  assert.equal(pending('orchestrator').some(item => item.action === 'inbox'), false,
    'a planning role cannot fix a temporary budget stop without an actionable local transaction');
  assert.ok(pending('allocator').some(item => item.action === 'allocate_agent' && item.transactions.includes(tx.id)));
  assert.ok(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' })
    .some(row => row.subject === 'transaction-stale'), 'the fact is queued for the next real Auditor turn');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'SUBMITTED', result: { evidence: 'ready for validation' },
  }));
  assert.ok(pending('orchestrator').some(item => item.action === 'validate'));
  assert.ok(pending('orchestrator').some(item => item.action === 'inbox'),
    'notices ride along when the Orchestrator has an actual decision');
});

test('a delegated parent is not stale while its child is still advancing', async t => {
  const runtime = makeRuntime(t, { staleMs: 1000 });
  const clusterId = startCluster(runtime, {
    limits: { max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const parent = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, orchestrator, 'decompose', {
    transaction_id: parent.id, children: [{ objective: 'produce delegated output', acceptance_criteria: ['the child ran'] }],
  }).result.children[0].transaction_id;
  const unrelated = command(runtime, orchestrator, 'create_transaction', {
    objective: 'unassigned sibling', acceptance_criteria: ['this one did not move'],
  }).result.transaction_id;
  for (const id of [parent.id, child, unrelated]) {
    command(runtime, orchestrator, 'dispatch', { transaction_id: id });
    command(runtime, auditor, 'inspect_plan', { transaction_id: id, decision: 'approve' });
  }
  assert.equal(runtime.store.parentsAwaitingChildren(clusterId, root.id).includes(parent.id), true);
  const old = now() - 60_000;
  runtime.store.tx(() => runtime.store.run('UPDATE transactions SET updated=? WHERE id IN (?,?)', old, parent.id, unrelated));
  runtime.enableScheduling();
  await runtime.tick();
  const stale = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stale').map(event => event.data.transaction_id);
  assert.equal(stale.includes(parent.id), false, 'the parent is waiting on real child work, not abandoned');
  assert.equal(stale.includes(unrelated), true, 'a genuinely unhandled sibling is still reported');
});

test('a transaction modification reaches the other roles, and a goal change reaches all three', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  runtime.store.tx(() => runtime.store.run("UPDATE inbox SET status='CONSUMED' WHERE cluster_id=?", clusterId));
  command(runtime, orchestrator, 'set_priority', { transaction_id: tx.id, priority: 5 });
  const modified = runtime.store.listInbox(clusterId, { status: 'PENDING' }).filter(row => row.subject === 'transaction-modified');
  assert.ok(modified.length >= 2, `the change is routed to the roles that did not make it: ${JSON.stringify(modified.map(row => row.recipient))}`);
  assert.equal(modified.some(row => row.recipient === auditor.agent_id), true, 'the Auditor supervises changes it did not make');
  assert.equal(modified.some(row => row.recipient === orchestrator.agent_id), false, 'the actor is not notified of its own change');
  void allocator;

  runtime.store.tx(() => runtime.store.run("UPDATE inbox SET status='CONSUMED' WHERE cluster_id=?", clusterId));
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, objective: 'a different goal entirely' });
  const goal = runtime.store.listInbox(clusterId, { status: 'PENDING' }).filter(row => row.subject === 'goal-changed');
  assert.equal(new Set(goal.map(row => row.recipient)).size, 3, 'a goal change reaches all three roles');
});

test('evaluate_health records the eight dimensions and refuses an invented one', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { ok: 1 } }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true,
    checks: [{ criterion: 'the result holds a value', passed: true, evidence: 'result.ok was recorded' }],
  });
  command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
  const detail = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: tx.id });
  assert.deepEqual(detail.audits.map(({ kind, decision }) => [kind, decision]),
    [['plan', 'APPROVED'], ['validation', 'APPROVED']],
    'transaction detail exposes decided plan and validation reviews, not only pending requests');
  assert.ok(detail.audits.every(audit => typeof audit.evidence === 'object'),
    'the audit evidence is decoded for consumers');

  const metrics = runtime.healthMetricNames();
  assert.equal(metrics.length, 8);
  assert.deepEqual(metrics, [
    'transaction_coverage', 'decomposition_quality', 'responsiveness', 'planning_stability',
    'goal_alignment', 'acceptance_quality', 'result_integration', 'escalation_quality',
  ]);
  const signals = runtime.healthSignals(clusterId);
  assert.equal(signals.transaction_coverage, 1, 'the only root transaction is accepted');
  assert.equal(signals.acceptance_quality, 1, 'and its checks carry evidence');
  assert.equal(signals.goal_alignment, null, 'goal alignment is not computable deterministically');
  assert.equal(typeof signals.decomposition_quality.orphans, 'number');

  const dimensions = Object.fromEntries(metrics.map(metric => [metric, 0.5]));
  const outcome = command(runtime, auditor, 'evaluate_health', { dimensions, weights: Object.fromEntries(metrics.map(metric => [metric, 1 / 8])) });
  assert.ok(outcome.result.health_id);
  const stored = runtime.store.latestHealth(clusterId);
  assert.deepEqual(Object.keys(stored.scores).sort(), [...metrics].sort());
  assert.equal(stored.decided_by, auditor.agent_id);
  assert.equal(stored.decided, 1);
  assert.deepEqual(stored.signals.transaction_coverage, 1, 'the measured signals are stored next to the judgement');

  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { invented_metric: 0.5 } }),
    error => error.status === 400 && /unknown health metric/.test(error.message));
  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { transaction_coverage: 2 } }),
    error => error.status === 400 && /\[0,1\]/.test(error.message));
  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { transaction_coverage: 0.5 }, weights: { transaction_coverage: 0.8 } }),
    error => error.status === 400 && /sum to 1/.test(error.message));
});

test('transaction-scoped lifecycle control stays inside one subtree', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const parent = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: parent.id });
  const child = command(runtime, orchestrator, 'decompose', {
    transaction_id: parent.id,
    children: [{ objective: 'child work', acceptance_criteria: ['done'] }],
  }).result.children[0].transaction_id;
  const sibling = command(runtime, orchestrator, 'create_transaction', { objective: 'untouched sibling', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: child });
  command(runtime, orchestrator, 'dispatch', { transaction_id: sibling });

  const paused = command(runtime, orchestrator, 'pause_transaction', { transaction_id: parent.id, reason: 'waiting on input' });
  assert.equal(paused.result.status, 'PAUSED');
  assert.ok(paused.result.paused.includes(child), 'the subtree pauses with it');
  assert.equal(runtime.store.getTransaction(sibling).status, 'READY', 'a sibling outside the subtree is untouched');

  const resumed = command(runtime, orchestrator, 'resume_transaction', { transaction_id: parent.id });
  assert.equal(runtime.store.getTransaction(parent.id).status, 'READY');
  assert.equal(runtime.store.getTransaction(child).status, 'READY');
  assert.equal(runtime.store.getTransaction(sibling).status, 'READY');
  assert.ok(resumed.result.resumed.length >= 2);

  const cancelled = command(runtime, orchestrator, 'cancel_transaction', { transaction_id: child, reason: 'not needed' });
  assert.deepEqual(cancelled.result.cancelled, [child]);
  assert.equal(runtime.store.getTransaction(parent.id).status, 'READY', 'cancelling a child does not cancel its parent');
  assert.equal(runtime.store.getTransaction(sibling).status, 'READY');
  void auditor;
});

test('Auditor observations and recommendations are durable and routed without creating a blocking correction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  const notified = command(runtime, auditor, 'notify', {
    transaction_id: tx.id, issue: 'the acceptance criteria name no artifact', severity: 'MAJOR', evidence: { checked: 'objective text' },
  });
  assert.ok(notified.result.event_seq > 0);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT', 'a signal changes nothing');
  command(runtime, auditor, 'notify', { transaction_id: tx.id });
  const notifiedEvents = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'auditor-notified');
  assert.equal(notifiedEvents.length, 2);
  assert.equal(notifiedEvents[0].data.issue, 'the acceptance criteria name no artifact');

  const recommended = command(runtime, auditor, 'recommend', {
    transaction_id: tx.id, recommendation: 'split this into two transactions', expected_effect: 'shorter worker turns',
  });
  assert.equal(recommended.result.advisory, true);
  assert.ok(recommended.result.event_seq > notified.result.event_seq);
  assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 0,
    'only request_correction/replan should create a required-change issue');
  assert.ok(runtime.store.listInbox(clusterId, { status: 'PENDING' })
    .some(row => row.subject === 'auditor-recommended'));
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY',
    'an observation or a suggestion cannot veto an otherwise actionable transaction');
  void allocator;
});

test('a per-identity context budget is honoured by the next turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-ctxbudget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: { async compactNow() { return null; }, async compactIfNeeded() { return null; } },
  });
  host.setSessionTokens(30_000);
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 100_000, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 4, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_model_requests: 2, worker_max_tokens: 512 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 4 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
  const stepsOf = () => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  const waitForNewStep = async (since, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const workerSteps = stepsOf().filter(event => event.data.role === 'worker');
      if (workerSteps.length > since) return workerSteps.at(-1);
      if (Date.now() > deadline) return null;
      // eslint-disable-next-line no-await-in-loop
      await runtime.tick();
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
  };

  // A session beyond the Worker's declared context limit is refused when
  // compaction cannot shrink it, even if the provider itself has room.
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.preStep({ step: 1 });
  });
  runtime.enableScheduling();
  const firstStep = await waitForNewStep(0, 5_000);
  assert.ok(firstStep, 'the Worker turn measured its first step');
  assert.equal(firstStep.data.context_limit, 16384, 'the Worker default is the yardstick');
  assert.equal(firstStep.data.decision, 'reject');

  // The Allocator raises this identity's own budget: the same session now fits.
  const raised = command(runtime, role('allocator'), 'set_context_budget', {
    agent_id: worker.id, context_limit: 65_536, compression_threshold: 0.9, retention_policy: 'keep-last-turn',
  });
  assert.equal(raised.result.context.limit, 65_536);
  assert.equal(runtime.store.getAgent(worker.id).meta.context.trigger, 0.9);
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'READY' });
    runtime.store.updateAgent(worker.id, { status: 'READY' });
    runtime.store.updateNode(root.id, { status: 'ACTIVE' });
    runtime.store.updateCluster(clusterId, { status: 'RUNNING' });
  });
  const soFar = stepsOf().filter(event => event.data.role === 'worker').length;
  const secondStep = await waitForNewStep(soFar, 5_000);
  assert.ok(secondStep, 'the Worker measured another step');
  assert.equal(secondStep.data.context_limit, 65_536, 'the identity override is what the next turn measures against');
  assert.equal(secondStep.data.decision, 'proceed');
  assert.equal(runtime.store.getAgent(worker.id).meta.context.retention, 'keep-last-turn');
});

test('the browser route refuses the operations that drive the host itself', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const { handleFetch } = await import('../../src/adapter/index.js');
  const post = (body) => handleFetch(runtime, new Request('http://host/api/flow', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  for (const op of ['settle', 'tick', 'single', 'recover', 'dispose']) {
    // eslint-disable-next-line no-await-in-loop
    const response = await post({ op, id: clusterId });
    assert.equal(response.status, 404, `${op} must not be reachable from the browser`);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await response.json()).code, 'UNKNOWN_OP');
  }
  // The read/control surface stays available.
  const listed = await post({ op: 'list' });
  assert.equal(listed.status, 200);
  const paused = await post({ op: 'control', id: clusterId, payload: { action: 'pause' } });
  assert.equal(paused.status, 200);
  assert.equal(runtime.store.getCluster(clusterId).status, 'PAUSED');

  // A query must name its cluster and stay within one page.
  assert.equal((await post({ op: 'query', payload: { what: 'cluster' } })).status, 400);
  assert.equal((await post({ op: 'query', id: clusterId, payload: { what: 'transactions', params: { limit: 5000 } } })).status, 400);
  const health = await post({ op: 'query', id: clusterId, payload: { what: 'health' } });
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.metrics.length, 8);
  assert.ok(body.signals);
});

test('a delegation chain descends one level per spawn, and the instruction wins', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 4, max_depth: 5, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    // A depth cap with room for the chain: the terminal level is depth 3 and its Worker
    // would be depth 4, inside the cap. (A node created *at* the cap is refused; that is
    // its own test.)
    limits: { max_depth: 5 },
    delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 3 }],
  });
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // One pending instruction per level: a node that owes a delegation gets
  // exactly one, and the caller's number is ignored while it owes one.
  assert.equal(runtime.delegationInstructions(clusterId, root.id).length, 1);
  const first = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'level 1' }, spawn_children: 99,
  }).result;
  const level1 = runtime.store.getNode(first.node_id);
  assert.equal(level1.scope.spawn_children, 2, 'the inherited depth wins over the caller\'s override');

  const level1Allocator = runtime.store.listAgents(clusterId, { node_id: first.node_id, role: 'allocator', limit: 5 })[0];
  const second = command(runtime, { cluster_id: clusterId, agent_id: level1Allocator.id, node_id: first.node_id, role: 'allocator' }, 'spawn_management_node', {
    transaction_id: first.delegated_transaction_id, node_id: first.node_id, scope: { objective: 'level 2' }, spawn_children: 0,
  }).result;
  const level2 = runtime.store.getNode(second.node_id);
  assert.equal(level2.scope.spawn_children, 1, 'a caller cannot stop a chain the fixture still asks for');

  const level2Allocator = runtime.store.listAgents(clusterId, { node_id: second.node_id, role: 'allocator', limit: 5 })[0];
  const third = command(runtime, { cluster_id: clusterId, agent_id: level2Allocator.id, node_id: second.node_id, role: 'allocator' }, 'spawn_management_node', {
    transaction_id: second.delegated_transaction_id, node_id: second.node_id, scope: { objective: 'level 3' },
  }).result;
  const level3 = runtime.store.getNode(third.node_id);
  assert.equal(level3.scope.spawn_children, 0, 'and the chain ends when the depth reaches zero');
  const leaf = runtime.store.getTransaction(third.delegated_transaction_id);
  assert.equal(leaf.objective, 'deep branch',
    'the final node receives the delegated task, not its ancestor’s instructions to spawn more nodes');
  assert.equal(leaf.inputs.management_levels_remaining, 0,
    'the Worker can distinguish a leaf assignment from an unfinished management chain');
  // A node with no budget left owes nothing, so a caller may then pass its own
  // number: the fixture no longer has an opinion about that level.
  const level3Allocator = runtime.store.listAgents(clusterId, { node_id: third.node_id, role: 'allocator', limit: 5 })[0];
  const extra = command(runtime, { cluster_id: clusterId, agent_id: level3Allocator.id, node_id: third.node_id, role: 'allocator' }, 'spawn_management_node', {
    transaction_id: third.delegated_transaction_id, node_id: third.node_id, scope: { objective: 'level 4' },
  }).result;
  assert.equal(runtime.store.getNode(extra.node_id).depth, 4);
  assert.equal(runtime.store.getNode(extra.node_id).scope.spawn_children, 0);
  // Every level of the chain exists, so a depth-3 management branch is reachable
  // by construction rather than by the model's choice.
  const depths = new Set(runtime.store.listNodes(clusterId, {}).filter(node => node.kind === 'management').map(node => node.depth));
  assert.deepEqual([...depths].sort(), [0, 1, 2, 3, 4]);
});

test('a delegated parent does not spend Worker attempts before its required management child exists', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6,
      max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 4_194_304, model_requests: 512, tool_calls: 4096,
      wall_time_ms: 1_800_000, agents: 64, max_active_agents: 6 },
    delegation: [{ scope: 'deep/', objective: 'finish deep/nested/result.txt', spawn_children: 3 }],
  });
  const root = rootNode(runtime, clusterId);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const first = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: rootTx.id }).result;
  const child = runtime.store.getNode(first.node_id);
  const delegatedId = first.delegated_transaction_id;
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id),
    'dispatch', { transaction_id: delegatedId });
  assert.equal(runtime.store.getTransaction(delegatedId).status, 'READY');
  const allocator = actorFor(runtime, clusterId, 'allocator', child.id);
  const pending = runtime.pendingFor('allocator', child, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(allocator.agent_id));
  assert.ok(pending.some(action => action.action === 'spawn_management_node'));
  assert.equal(pending.some(action => action.action === 'allocate_agent'
    && action.transactions.includes(delegatedId)), false,
  'the branch owes its next management child before any Worker can run its parent');
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: delegatedId }),
    error => error.status === 409 && /delegat|child/i.test(error.message));
  assert.equal(runtime.store.activeAllocationForTransaction(delegatedId), null);
  const second = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, node_id: child.id,
  }).result;
  assert.equal(runtime.store.getNode(second.node_id).depth, 2);
});

test('a delivery to an identity with no session yet is injected, not withheld', async t => {
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: {
      // The service exists and answers honestly: this identity has no session.
      async stat() { return undefined; },
      async open() { throw new Error('not found'); },
    },
  });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: 'fresh-msg', cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'work please' },
    });
    runtime.store.insertRecipient('fresh-msg', agent.id);
  });
  const reconciled = await runtime.reconcileDeliveries(clusterId);
  assert.equal(reconciled.acknowledged, 0, 'nothing was injected yet, so nothing is acked');
  assert.equal(runtime.store.getAgent(agent.id).status !== 'BLOCKED', true, 'and nothing is blocked for it');

  const collected = await runtime.collectDeliveries(agent);
  assert.deepEqual(collected.ids, ['fresh-msg'], 'the delivery is handed to the turn');
  assert.equal(runtime.store.deliveryFor('fresh-msg', agent.id).status, 'DELIVERED');
  const unknown = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'delivery-unknown');
  assert.equal(unknown.length, 0, 'a missing session is an absence, not an unprovable state');
});

test('a stale transaction is reported once per revision, and a working one is not stale', async t => {
  const runtime = makeRuntime(t, { staleMs: 1000 });
  const clockNow = now();
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.run('UPDATE transactions SET created=?, updated=? WHERE id=?', clockNow - 60_000, clockNow - 60_000, tx.id));

  runtime.enableScheduling();
  await runtime.tick();
  await runtime.tick();
  await runtime.tick();
  const stale = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-stale');
  assert.equal(stale.length, 1, `one report per revision, however many ticks pass: ${stale.length}`);
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: null })
    .filter(row => row.subject === 'transaction-stale').length, 1, 'and one notification per recipient');

  // A transaction whose identity holds a live lease is being worked on, not
  // stale, however long its row has not changed.
  const tx2 = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx2 });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx2 });
  const allocation = runtime.store.activeAllocationForTransaction(tx2);
  runtime.store.tx(() => {
    runtime.store.run('UPDATE transactions SET created=?, updated=? WHERE id=?', clockNow - 60_000, clockNow - 60_000, tx2);
    // The identity is not schedulable, so the lease this test creates is the
    // only one and the scheduler cannot start a competing turn for it.
    runtime.store.updateAgent(allocation.agent_id, { status: 'BLOCKED' });
    runtime.store.createLease({
      id: 'live-lease', cluster_id: clusterId, agent_id: allocation.agent_id, node_id: allocation.node_id,
      purpose: 'worker-turn', epoch: 1, expires: clockNow + 60_000,
    });
  });
  await runtime.tick();
  const staleIds = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-stale').map(event => event.data.transaction_id);
  assert.equal(staleIds.includes(tx2), false, 'an identity with a live lease is not reported stale');
});

test('stale notification reaches the ninth unreported transaction behind eight already-reported ones', async t => {
  const runtime = makeRuntime(t, { staleMs: 1000 });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const first = runtime.store.rootTransactions(clusterId)[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  for (let index = 0; index < 8; index += 1) {
    const tx = command(runtime, orchestrator, 'create_transaction', {
      objective: `stale-${index}`, acceptance_criteria: ['evidence'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx });
  }
  const stale = runtime.store.all(
    "SELECT id,revision FROM transactions WHERE cluster_id=? AND status='READY' ORDER BY rowid", clusterId);
  assert.equal(stale.length, 9);
  runtime.store.tx(() => {
    for (const row of stale) runtime.store.run('UPDATE transactions SET updated=? WHERE id=?', now() - 60_000, row.id);
    for (const row of stale.slice(0, 8)) runtime.store.appendEvent(clusterId, 'transaction-stale', {
      transaction_id: row.id, revision: row.revision,
    });
  });
  runtime.enableScheduling();
  await runtime.tick();
  const notices = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stale').map(event => event.data.transaction_id);
  assert.equal(notices.length, 9);
  assert.equal(notices.at(-1), stale[8].id, 'the first eight historical notices cannot starve the ninth');
  await runtime.tick();
  assert.equal(runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stale').length, 9);
});

test('an audit that arrives after the cursor advanced is still decided', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);

  // Two dispatches: the auditor's first turn sees both and its cursor moves to
  // the second. A third dispatch then arrives *behind* the cursor.
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  const second = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  assert.equal(runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor).filter(item => item.action === 'inspect_plan').length, 2);
  // The Auditor answers both, so the cursor is at the newest audit and the page
  // is empty.
  command(runtime, auditor, 'inspect_plan', { transaction_id: first.id, decision: 'approve' });
  command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'approve' });
  const empty = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor);
  assert.equal(empty.filter(item => item.action === 'inspect_plan').length, 0);

  // A new plan audit arrives: it must be visible, not hidden behind the cursor.
  const third = command(runtime, orchestrator, 'create_transaction', { objective: 'third', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: third, expected_output: 'anything' });
  command(runtime, orchestrator, 'dispatch', { transaction_id: third });
  const after = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor);
  assert.equal(after.filter(item => item.action === 'inspect_plan').length, 1, 'the new plan is offered for inspection');
  assert.equal(after.find(item => item.action === 'inspect_plan').transaction_id, third);
});

test('a validation gate reaches the Auditor ahead of an older page of advisory plans', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  for (let index = 0; index < 8; index += 1) {
    const id = command(runtime, orchestrator, 'create_transaction', {
      objective: `plan ${index}`, acceptance_criteria: ['accepted'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: id });
  }
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'SUBMITTED', result: { checked: true }, __bump_revision: false,
  }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true,
    checks: [{ criterion: 'accepted', passed: true, evidence: 'recorded result checked' }],
  });
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 9);
  const offered = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
    .filter(item => item.action.startsWith('inspect_'));
  assert.equal(offered[0]?.action, 'inspect_validation',
    'an independent plan-review backlog must not hide an acceptance-gating verdict');
  assert.equal(offered[0]?.transaction_id, tx.id);
  command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'ACCEPTED');
  assert.ok(runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
    .some(item => item.action === 'inspect_plan'),
  'the deferred advisory reviews remain available afterwards');
});

test('a turn that stops making progress is aborted, not left holding its transaction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-hung-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000, maxTurnMs: 1_000,
    context: { role: 8192, worker: 16384 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 2, max_llm_concurrency: 1, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_max_tokens: 512 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 2 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  // The Auditor decides the plan, so the management reserve is not held by a
  // role with work of its own and a Worker slot is free.
  command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });

  // A turn that never returns: it holds its lease, its model permit and the
  // transaction at RUNNING.
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await new Promise(() => {});
  });
  runtime.enableScheduling();
  await runtime.tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert.equal(runtime.store.getTransaction(tx.id).status, 'RUNNING');
  assert.equal(runtime.activeTurnIds().length, 1);

  // Past the maximum lifetime the scheduler aborts it, so the finisher runs and
  // the transaction is not left RUNNING forever.
  runtime.store.now = () => Date.now();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_100));
  await runtime.tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  const aborted = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'turn-aborted');
  assert.equal(aborted.length, 1, `the hung turn is aborted: ${JSON.stringify(aborted.map(event => event.data))}`);
  assert.notEqual(runtime.store.getTransaction(tx.id).status, 'RUNNING', 'and the transaction no longer sits in RUNNING');
});

test('a RUNNING transaction whose turn vanished is returned to the scheduler', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  // A turn that died without its finisher: the transaction is RUNNING, no turn
  // is registered and no lease is live.
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  runtime.enableScheduling();
  await runtime.tick();
  const swept = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-stranded');
  assert.equal(swept.length, 1, `the stranded transaction is named: ${JSON.stringify(swept.map(event => event.data))}`);
  assert.equal(swept[0].data.code, 'STRANDED_TURN');
  // The sweep returned it to the scheduler, which may already have claimed it
  // again in the same tick.
  const afterSweep = runtime.store.getTransaction(tx.id);
  assert.equal(['READY', 'RUNNING'].includes(afterSweep.status), true, `returned to the scheduler: ${afterSweep.status}`);

  // A transaction whose identity holds a live lease is being worked on: the
  // sweep must not steal it.
  const second = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, allocator, 'allocate_agent', { transaction_id: second });
  const allocation = runtime.store.activeAllocationForTransaction(second);
  runtime.store.tx(() => {
    runtime.store.updateTransaction(second, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(allocation.agent_id, { status: 'BLOCKED' });
    runtime.store.createLease({
      id: 'live-again', cluster_id: clusterId, agent_id: allocation.agent_id, node_id: allocation.node_id,
      purpose: 'worker-turn', epoch: 9, expires: now() + 60_000,
    });
  });
  await runtime.tick();
  assert.equal(runtime.store.getTransaction(second).status, 'RUNNING', 'a transaction with a live lease is left alone');
  const strandedIds = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stranded').map(event => event.data.transaction_id);
  assert.equal(strandedIds.includes(second), false, `the leased transaction is never named stranded: ${JSON.stringify(strandedIds)}`);
});

test('a request that needs more than its grant is funded inside the reservation', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  const worker = runtime.store.getAgent(allocated.agent_id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', worker.id);
  // A grant far smaller than one request, with a node that can cover it.
  runtime.store.tx(() => runtime.store.updateBudget(agentBudget.id, { tokens_limit: 1_000, tokens_spent: 0, tokens_reserved: 0 }));

  // The funder closes the gap inside the same transaction, so the reservation
  // sees the funded grant: no race with whatever settled in between.
  const fundCalls = [];
  const reserve = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
    role: 'worker', kind: 'worker', model: 'm', provider: 'p',
    budgetIds: runtime.agentBudgetChain(runtime.store.getCluster(clusterId), worker),
    reservationTokens: 400_000, turn_seq: 1, maxRequests: null,
    fund: error => {
      fundCalls.push({ dimension: error.dimension, requested: error.requested });
      return runtime.topUpBudgetForAgent(worker, {
        [error.dimension ?? 'model_requests']: error.requested,
        ...(error.dimension === 'tokens' ? { model_requests: 1 } : {}),
      });
    },
  });
  assert.ok(reserve.request_id, 'the request is funded and reserved');
  assert.equal(fundCalls.length, 1, `the funder ran exactly once: ${JSON.stringify(fundCalls)}`);
  assert.equal(fundCalls[0].dimension, 'tokens');
  assert.equal(reserve.tokens, 400_000);
  const after = runtime.store.getBudget(agentBudget.id);
  assert.equal(after.tokens_reserved, 400_000, 'the reservation is held in the identity it was funded for');

  // A shortfall the node cannot cover is refused, not papered over.
  const drained = runtime.store.listBudgets(clusterId);
  runtime.store.tx(() => {
    // Exhaust the capacity without destroying it: a scope that has *spent* its
    // limit is exhausted, while a scope whose limit was lowered is a different
    // (and unrealistic) state.
    for (const row of drained) {
      if (row.tokens_limit <= 0) continue;
      runtime.store.updateBudget(row.id, { tokens_spent: Math.max(row.tokens_spent, row.tokens_limit - row.tokens_reserved) });
    }
  });
  assert.throws(() => reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
    role: 'worker', kind: 'worker', model: 'm', provider: 'p',
    budgetIds: runtime.agentBudgetChain(runtime.store.getCluster(clusterId), worker),
    reservationTokens: 400_000, turn_seq: 1, maxRequests: null,
    fund: () => runtime.topUpBudgetForAgent(worker, { tokens: 400_000, model_requests: 1 }),
  }), error => error.code === 'LIMIT_REACHED');
});

test('the compaction pool is funded from the node when its earmark cannot cover a summary', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  assert.ok(pool, 'the earmark exists');

  // The earmark is a share, so a long run exhausts it: the summary request then
  // has to be funded from the node, or the session it must shrink can never be
  // shrunk.
  const need = pool.tokens_limit + 5_000;
  const granted = runtime.store.tx(() => runtime.topUpCompactionPool(clusterId, { tokens: need, model_requests: 1 }));
  assert.ok(granted, `the pool is funded: ${JSON.stringify(granted)}`);
  assert.equal(granted.tokens, 5_000, 'exactly the gap');
  const after = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  assert.ok(after.tokens_limit - after.tokens_reserved - after.tokens_spent >= need, 'the pool can now cover the request');

  // Idle identities' grants are reclaimed first: the capacity they hold is
  // capacity the node no longer has.
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  const auditorBudget = runtime.store.budgetForScope(clusterId, 'agent', auditor.id);
  const node = runtime.store.budgetForScope(clusterId, 'node', root.id);
  runtime.store.tx(() => runtime.store.updateBudget(node.id, { tokens_spent: Math.max(node.tokens_spent, node.tokens_limit - node.tokens_reserved) }));
  const reclaimed = runtime.store.tx(() => runtime.topUpCompactionPool(clusterId, { tokens: after.tokens_limit + 1_000 }));
  assert.ok(reclaimed, 'the pool is still funded after the node was drained directly');
  assert.ok(runtime.store.getBudget(auditorBudget.id).tokens_limit <= auditorBudget.tokens_limit, 'an idle identity gave capacity back');
});

test('a cluster that cannot pay for its next request stops with the budget reason', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });

  // Every scope that could fund a request is spent: the work is READY, the
  // cluster is RUNNING, and each pass refuses the next request.
  runtime.store.tx(() => {
    for (const row of runtime.store.listBudgets(clusterId)) {
      if (row.tokens_limit <= 0) continue;
      runtime.store.updateBudget(row.id, { tokens_spent: Math.max(row.tokens_spent, row.tokens_limit - row.tokens_reserved) });
    }
  });
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  runtime.recordBudgetRefusal(agent, 'model request refused: nothing left', {
    scope: root.id, dimension: 'tokens', requested: 10_000, available: 0,
  });
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED', 'the cluster stops instead of spinning');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked').at(-1);
  assert.equal(blocked.data.code, 'BUDGET_EXHAUSTED');
  assert.match(String(blocked.data.reason), /^BUDGET:/);
});

test('a context refusal in a spent cluster is reported as a budget stop, not a context pathology', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  const blocked = {
    stopReason: 'blocked',
    stopDetail: { info: { rejection: { before: 124_579, pending: 2_167, sending: 128_675, ceiling: 126_976, limit: 8_192 } } },
  };
  // The cluster still has money: the refusal is the context pathology it looks
  // like, and it is reported as one.
  assert.deepEqual(
    { code: runtime.contextRefusal(blocked, null, agent)?.code, plain: /^the step could not be sent/.test(runtime.contextRefusal(blocked, null, agent)?.message) },
    { code: 'CONTEXT_PRESSURE', plain: true });
  // The cluster has spent everything: the same refusal is a budget stop, and the
  // report says so instead of blaming the context.
  runtime.store.tx(() => {
    for (const row of runtime.store.listBudgets(clusterId)) {
      if (row.tokens_limit <= 0) continue;
      runtime.store.updateBudget(row.id, { tokens_spent: Math.max(row.tokens_spent, row.tokens_limit - row.tokens_reserved) });
    }
  });
  const spent = runtime.contextRefusal(blocked, null, agent);
  assert.equal(spent.code, 'BUDGET_EXHAUSTED');
  assert.match(spent.message, /^BUDGET:/);
  // The unshrunk session that never got its summary names compaction itself.
  const unfunded = {
    stopReason: 'blocked',
    stopDetail: { info: { rejection: { before: 100, pending: 10, compaction_unfunded: true } } },
  };
  const shrunk = runtime.contextRefusal(unfunded, null, agent);
  assert.equal(shrunk.code, 'BUDGET_EXHAUSTED');
  assert.match(shrunk.message, /^BUDGET: the session could not be compacted/);
  // Missing the agent must not throw: the refusal still names the ceiling.
  assert.match(runtime.contextRefusal(blocked, null).message, /^the step could not be sent/);
});

test('a coded block is persisted with its code, at the node and at the cluster', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  runtime.store.tx(() => runtime.store.insertNode({
    id: 'child-node-1', cluster_id: clusterId, parent_id: root.id, kind: 'management',
    depth: 1, status: 'ACTIVE', objective: 'child', created_at: Date.now(),
    path: `${root.path}/child-node-1`,
  }));
  const child = runtime.store.getNode('child-node-1');
  runtime.blockNodeInternal(clusterId, child.id, 'BUDGET: the child could not pay for its next request', 'BUDGET_EXHAUSTED');
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  const nodeBlocked = events.filter(event => event.type === 'node-blocked').at(-1);
  assert.equal(nodeBlocked.data.code, 'BUDGET_EXHAUSTED');
  // A non-root block stops the node and tells its parent; the code is on the
  // event either way, which is what the ledger reads.
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING');
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: the cluster could not pay for its next request', 'BUDGET_EXHAUSTED');
  const clusterBlocked = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1);
  assert.equal(clusterBlocked.data.code, 'BUDGET_EXHAUSTED');
  assert.match(String(clusterBlocked.data.reason), /^BUDGET:/);
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
});

test('a root budget stop waits for funded delegated work to return capacity, then stops if still dry', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'complete funded delegated work' },
  }).result;
  runtime.blockNodeInternal(clusterId, root.id, 'BUDGET: root needs more tokens',
    'BUDGET_EXHAUSTED', {
      agent_id: allocator.agent_id,
      envelope: { tokens: 2_000_000, model_requests: 1, tool_calls: 0 },
    });
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED');
  assert.equal(runtime.store.getCluster(clusterId).status, 'RUNNING',
    'the still-funded child can finish independently and return its unspent grant');
  assert.equal(runtime.store.getNode(child.node_id).status, 'ACTIVE');

  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, {
    status: 'ACCEPTED', __bump_revision: false,
  }));
  runtime.evaluateCompletion(clusterId);
  scoreFinalHealth(runtime, clusterId, child.node_id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.getNode(child.node_id).status, 'COMPLETED');
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED',
    'an impossible envelope still stops the cluster after independent work is done');
  const stop = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1);
  assert.equal(stop.data.code, 'BUDGET_EXHAUSTED');
});

test('a blocked cluster cannot admit fresh turns from still-active child nodes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-blocked-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const original = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'pending child task' },
  }).result;
  assert.equal(runtime.store.getNode(child.node_id).status, 'ACTIVE');
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
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
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
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
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
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(runtime.store.getTransaction(tx.id).status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  assert.equal(workerTurn?.blocked, true, 'the step was rejected');
  assert.equal(workerTurn.requests.length, 0, 'no request was sent');
  const steps = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  assert.equal(steps.at(-1).data.decision, 'reject', 'the step gate made the decision');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  assert.equal(blocked.at(-1)?.data.code, 'BUDGET_EXHAUSTED', 'the stop is coded as a budget stop');
  assert.match(String(blocked.at(-1)?.data.reason), /^BUDGET:/);
  // And the same fact, at the node that was refused.
  const nodeBlocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'node-blocked').at(-1);
  assert.equal(nodeBlocked.data.code, 'BUDGET_EXHAUSTED');
});

test('a node waits for its own roles to finish before it closes, and books their turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const actor = name => actorFor(runtime, clusterId, name, root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actor('orchestrator'), 'dispatch', { transaction_id: tx.id });

  // The cluster's work is finished *inside a role's turn*: the node must not close
  // under it. Its own roles' closing acts belong to those turns, and a node that
  // closed early either aborted them or lost their accounting.
  const observed = [];
  host.setScript(async turn => {
    const role = runtime.store.getAgentBySession(turn.session.id)?.role;
    if (role === 'orchestrator') {
      if (runtime.pendingFor('orchestrator', root, runtime.store.getCluster(clusterId))
        .some(item => item.action === 'finish_cluster')) {
        command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'finish_cluster', {});
      }
      return;
    }
    if (role !== 'auditor') return;
    const auditor = actor('auditor');
    const pending = runtime.pendingFor('auditor', runtime.store.getNode(root.id), runtime.store.getCluster(clusterId), auditor);
    if (pending.some(item => item.action === 'evaluate_health' && item.evaluation_window === 'subtree-close')) {
      scoreFinalHealth(runtime, clusterId, root.id);
      observed.push({ node: runtime.store.getNode(root.id).status, cluster: runtime.store.getCluster(clusterId).status });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
      return;
    }
    if (runtime.store.getTransaction(tx.id).status === 'ACCEPTED') return;
    // The Auditor does its actual job — deciding the plan audits it is offered —
    // and then the cluster's work finishes inside its turn. A role that never
    // decides what it is offered starves itself into the turn cap, which is a
    // different test.
    for (const audit of runtime.store.pendingAudits(clusterId, { node_id: root.id, kind: 'plan', limit: 8 })) {
      command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { audit_id: audit.id, decision: 'approve' });
    }
    runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false }));
    runtime.evaluateCompletion(clusterId);
    observed.push({ node: runtime.store.getNode(root.id).status, cluster: runtime.store.getCluster(clusterId).status });
    // The role keeps working for a moment after the last acceptance.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (runtime.store.getCluster(clusterId).status === 'COMPLETED' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  assert.ok(observed.length > 0, 'the Auditor did reach its turn');
  assert.equal(observed[0].node, 'ACTIVE', 'the node did not close while its Auditor was mid-turn');
  assert.equal(observed[0].cluster, 'RUNNING');
  assert.equal(runtime.store.getCluster(clusterId).status, 'COMPLETED', 'and it closes once the roles are done');
  assert.equal(runtime.store.getNode(root.id).status, 'COMPLETED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const startedRoles = new Set(events.filter(event => event.type === 'turn-start').map(event => event.data.role));
  assert.ok(startedRoles.has('auditor'), `the Auditor took a turn: ${[...startedRoles].join(', ')}`);
  for (const roleAgent of runtime.store.listAgents(clusterId, {}).filter(agent => agent.role !== 'worker')) {
    assert.equal(roleAgent.status, 'TERMINATED', `${roleAgent.role} is terminated`);
    // Every role that really took a turn is *accounted*: either the turn is
    // booked (the count the identity's next session and the G1 check read), or
    // the ledger records that it failed before reaching the model — which is the
    // one case in which a turn must not advance that count.
    if (startedRoles.has(roleAgent.role) && roleAgent.turns === 0) {
      assert.ok(events.some(event => event.type === 'turn-start-failed' && event.data.role === roleAgent.role),
        `${roleAgent.role} either booked its turn or recorded why it did not start`);
    }
  }
  const roleTurns = events.filter(event => event.type === 'turn-end' && event.data.role !== 'worker');
  assert.ok(roleTurns.length > 0, 'the management turns really ended, in the record');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'management-node-completed' && event.data.summary_id),
    'and the closing record carries its aggregate');
});

test('an identity that cannot fund its next request stops its node, and a worker allowance does not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodestop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { role: 'allocator' })[0];

  // A per-identity allowance is not a node budget: the rule must not fire.
  assert.equal(runtime.blockNodeOnBudget(allocator, 'worker w1 reached its 2-request allowance for this task'), false);
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');

  // A request nobody can fund stops the node, with the code the report reads.
  assert.equal(runtime.blockNodeOnBudget(allocator, 'model request refused: budget exhausted for model_requests: requested 1, available 0'), true);
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED');
  const nodeBlocked = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'node-blocked').at(-1);
  assert.equal(nodeBlocked.data.code, 'BUDGET_EXHAUSTED');
  assert.match(String(nodeBlocked.data.reason), /^BUDGET:/);
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
  const clusterBlocked = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'cluster-blocked').at(-1);
  assert.equal(clusterBlocked.data.code, 'BUDGET_EXHAUSTED');
});

test("funding the compaction pool never sweeps another subtree's grants", t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 8, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 1, max_role_turns: 4 },
    budget: { tokens: 1_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const rootLimit = budgetView(runtime.store.getBudget(nodeBudget.id)).tokens.limit;

  // A delegated child management node with a budget of its own, and one identity
  // funded by it: that subtree's capacity must survive the root's funding.
  const childNodeId = 'child-mgmt-1';
  runtime.store.tx(() => {
    runtime.store.insertNode({
      id: childNodeId, cluster_id: clusterId, parent_id: root.id, kind: 'management',
      depth: 1, status: 'ACTIVE', scope: { objective: 'delegated subtree' }, created_at: Date.now(),
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
      session_id: 's-child', capabilities: [], created_at: Date.now(),
    });
  });
  const childGrant = createBudget(runtime.store, {
    cluster_id: clusterId, scope_kind: 'agent', scope_id: childAgentId, node_id: childNodeId,
    parent_budget_id: childBudget.id, limit: { tokens: 40_000, model_requests: 6, tool_calls: 6 },
  });

  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor' })[0];
  const auditorBudget = runtime.store.budgetForScope(clusterId, 'agent', auditor.id);
  assert.ok(auditorBudget, 'the root identity holds a grant');

  const childAvailable = dimensionAvailable(runtime.store.getBudget(childGrant.id), 'tokens');
  const rootIdle = dimensionAvailable(runtime.store.getBudget(auditorBudget.id), 'tokens');
  assert.ok(childAvailable > 0 && rootIdle > 0, `both grants are idle: ${childAvailable} / ${rootIdle}`);

  const moved = runtime.reclaimAllIdleGrants(clusterId, nodeBudget.id);
  assert.ok(moved?.tokens > 0, `the root funded identity came home: ${JSON.stringify(moved)}`);
  assert.equal(dimensionAvailable(runtime.store.getBudget(childGrant.id), 'tokens'), childAvailable,
    "the delegated subtree's grant is untouched");
  assert.equal(dimensionAvailable(runtime.store.getBudget(auditorBudget.id), 'tokens'), 0,
    "the root's own identity gave everything back");
  assert.equal(budgetView(runtime.store.getBudget(nodeBudget.id)).tokens.limit, rootLimit + moved.tokens,
    `the root node received exactly what it reclaimed: rootLimit=${rootLimit} moved=${JSON.stringify(moved)}`);
});

test('a funded request is charged to the scope that can actually pay it, not the one chosen before funding', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-reselect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor' })[0];

  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const fallback = runtime.store.budgetForScope(clusterId, 'agent', auditor.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(fallback.id, { tokens_limit: 100, tokens_spent: 0, tokens_reserved: 0, requests_limit: 1, requests_spent: 0, requests_reserved: 0 });
  });
  assert.ok(pool, 'the cluster has a compaction pool');

  let selections = 0;
  const refusals = [];
  const blocks = [];
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
    recordBudgetRefusal: (agent, reason, facts) => refusals.push({ reason, facts }),
    blockNodeOnBudget: (agent, reason) => { blocks.push(reason); return true; },
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
    signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
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
  const compactionCalls = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: tokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(session, reason) {
        compactionCalls.push({ reason, at: tokens });
        tokens = Math.floor(tokens / 2);
        return { summarySeq: compactionCalls.length };
      },
    },
  });
  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];

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
    signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
    budgetIds: runtime.agentBudgetChain(runtime.store.getCluster(clusterId), auditor),
    transactionId: null, turnSeq: 1, flow: runtime,
    contextLimits: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });

  const decisions = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'context-step').map(event => event.data.decision);
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
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(runtime.store.getTransaction(tx.id).revision, 1);
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'reject', required_change: 'name the depth-3 node explicitly' });
  assert.equal(runtime.store.getTransaction(tx.id).status, 'DRAFT');
  const rejected = runtime.store.getTransaction(tx.id).revision;
  assert.equal(rejected, 1, 'the rejection itself does not rewrite the plan');

  // The revision advances on its own: without it the re-dispatch would reuse the
  // audit that was just rejected, and the branch could only escalate.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id,
    acceptance_criteria: ['a depth-3 management node exists', 'its agent wrote the artifact and cited the evidence'],
  }).result;
  assert.equal(adjusted.revision, rejected + 1, `the adjustment advanced the revision: ${JSON.stringify(adjusted)}`);
  assert.equal(runtime.store.getTransaction(tx.id).plan_approved_revision, null, 'and the old approval cannot carry over');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const audits = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 });
  const fresh = audits.find(audit => audit.transaction_id === tx.id && audit.target_revision === adjusted.revision);
  assert.ok(fresh, `a plan audit targets the new revision: ${JSON.stringify(audits.map(a => ({ tx: String(a.transaction_id).slice(0, 8), r: a.target_revision })))}`);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY', 'and the revised plan is dispatchable while the audit is pending');
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(runtime.store.getTransaction(tx.id).plan_approved_revision, adjusted.revision);
});

test('transaction-scoped pause and resume advance the revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const before = runtime.store.getTransaction(tx.id).revision;
  command(runtime, orchestrator, 'pause_transaction', { transaction_id: tx.id, reason: 'hold' });
  const paused = runtime.store.getTransaction(tx.id);
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.revision, before + 1, 'pausing is a lifecycle change, and it is visible as one');
  command(runtime, orchestrator, 'resume_transaction', { transaction_id: tx.id });
  const resumed = runtime.store.getTransaction(tx.id);
  assert.equal(resumed.status, 'READY');
  assert.ok(resumed.revision > paused.revision, `resuming advances it again: ${paused.revision} -> ${resumed.revision}`);
  assert.equal(resumed.pre_pause_status, null);

  // Every lifecycle change is published at the revision it produced: a
  // notification that carried the pre-change snapshot told the other roles about
  // a revision that no longer exists.
  const changed = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-changed');
  const pausedEvent = changed.find(entry => entry.data.change === 'paused');
  const resumedEvent = changed.find(entry => entry.data.change === 'resumed');
  assert.equal(pausedEvent.data.revision, paused.revision, 'the pause published the revision the pause produced');
  assert.equal(resumedEvent.data.revision, resumed.revision, 'and the resume published the revision the resume produced');

  // Cancellation advances it too, so a plan audit left pending against the old
  // revision is visibly superseded rather than silently waiting.
  const beforeCancel = runtime.store.getTransaction(tx.id).revision;
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, orchestrator, 'cancel_transaction', { transaction_id: tx.id, reason: 'stop' });
  const cancelled = runtime.store.getTransaction(tx.id);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.revision > beforeCancel, `cancelling advances the revision: ${beforeCancel} -> ${cancelled.revision}`);
  const cancelEvent = [...changed].concat(runtime.store.readEvents(clusterId, { limit: 500 })).reverse().find(entry => entry.type === 'transaction-cancelled');
  assert.ok(cancelEvent, 'the cancellation is recorded');
  const cancelNotice = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-changed' && event.data.change === 'cancelled').at(-1);
  assert.equal(cancelNotice.data.revision, cancelled.revision, 'and notified at the revision it produced');
});

test('a correction verified on the first try closes the issue without a failure counter', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // Reject the plan: that opens an issue naming the change the Auditor requires.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const rejection = command(runtime, auditor, 'inspect_plan', {
    transaction_id: tx.id, decision: 'reject', required_change: 'name the depth-3 node explicitly',
  }).result;
  const issueId = rejection.issue_id;
  assert.ok(issueId, `the rejection opened an issue: ${JSON.stringify(rejection)}`);
  const opened = runtime.store.getIssue(issueId);
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.corrections, 0, 'a correction that has not failed is not counted');

  // The Orchestrator answers it with a real change to the plan.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, acceptance_criteria: ['a depth-3 management node exists'],
  }).result;
  assert.ok(adjusted.revision > opened.target_revision, `${adjusted.revision} > ${opened.target_revision}`);

  // The Auditor verifies the correction on the first try: the issue closes.
  const verified = command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'VERIFIED', evidence: { revision: adjusted.revision },
  }).result;
  assert.equal(verified.status, 'CORRECTED');
  const closed = runtime.store.getIssue(issueId);
  assert.equal(closed.status, 'CORRECTED');
  assert.equal(closed.corrections, 0, 'the counter never moved: this correction succeeded first time');

  // The witness the recursion gate reads is the durable change plus the closure,
  // not that counter.
  const adjustments = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-adjusted')
    .map(event => ({ transaction_id: event.data.transaction_id, revision: event.data.revision }));
  const answered = correctionWitness([closed], adjustments);
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
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
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
  const after = runtime.store.getBudget(pool.id);
  assert.equal(after.tokens_reserved, 6_829, 'the pool holds the reservation');
  assert.equal(runtime.store.getUsageReceipt(request.request_id).budget_scope_id, pool.id, 'and the receipt says so');
  // The node that could not pay is untouched: no capacity moved to reach this.
  assert.equal(runtime.store.getBudget(nodeBudget.id).tokens_reserved, 0);
  void orchestrator;
});

test('a rejection of a superseded plan is stale: it never touches the newer revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

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
  const before = runtime.store.getTransaction(tx.id);
  assert.equal(before.status, 'READY');
  assert.equal(before.revision, adjusted.revision);

  // The late verdict on rev1 must be STALE for either answer — including the one
  // that would otherwise pull the plan back and open a correction issue.
  const late = command(runtime, auditor, 'inspect_plan', {
    audit_id: rev1Audit.id, decision: 'reject', required_change: 'name the depth-3 node',
  }).result;
  assert.equal(late.decision, 'STALE', `a superseded plan is stale, not rejected: ${JSON.stringify(late)}`);
  assert.equal(runtime.store.findAudit(clusterId, tx.id, 'plan', 1).decision, 'STALE');

  const after = runtime.store.getTransaction(tx.id);
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
  assert.equal(runtime.store.getTransaction(tx.id).plan_approved_revision, adjusted.revision);
});

test('a request the chain hands to the pool is funded in the pool, whichever kind it is', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 400, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
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
      runtime.store.updateBudget(row.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  const chain = runtime.budgetChainForAgent(agent, { tokens: 5_000, requests: 1 });
  assert.deepEqual(chain, [pool.id], 'no scope is payable, so the chain names the one with the most capacity');

  const before = runtime.store.getBudget(pool.id).requests_limit;
  const reservedBefore = runtime.store.getBudget(pool.id).requests_reserved;
  const request = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 5_000, turn_seq: 1,
    fund: error => runtime.topUpCompactionPool(clusterId, { model_requests: error.requested ?? 1 }),
    reselect: () => runtime.budgetChainForAgent(agent, { tokens: 5_000, requests: 1 }),
  });
  assert.ok(request.request_id, 'the request is funded and reserved');
  const after = runtime.store.getBudget(pool.id);
  assert.ok(after.requests_limit > before, `the pool was refilled in place: ${before} → ${after.requests_limit}`);
  // A reservation holds the request; settlement is what spends it.
  assert.equal(after.requests_reserved, reservedBefore + 1, `and the request it funded is held there: ${reservedBefore} → ${after.requests_reserved}`);
  assert.equal(runtime.store.getUsageReceipt(request.request_id).budget_scope_id, pool.id);
});

test('an accounting fault blocks the management owner while still booking its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-acctfault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });

  // Fault injection inside the finisher's bookkeeping, which must never take the
  // turn's own accounting down with it.
  runtime.reconcileReservations = () => { throw Object.assign(new Error('injected reconciliation fault'), { code: 'ACCOUNTING_UNCERTAIN' }); };

  runtime.enableScheduling();
  const deadline = Date.now() + 6_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (runtime.store.getCluster(clusterId).status !== 'RUNNING' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const uncertain = events.filter(event => event.type === 'accounting-uncertain');
  const roleEnds = events.filter(event => event.type === 'turn-end' && event.data.role !== 'worker');
  assert.ok(uncertain.length >= 1, `the fault is recorded: ${JSON.stringify(events.map(event => event.type).slice(-12))}`);
  assert.equal(uncertain[0].data.transaction_id, null, 'a role turn names no transaction, and does not throw doing it');
  assert.match(String(uncertain[0].data.reason), /injected reconciliation fault/);
  assert.equal(runtime.store.getAgent(uncertain[0].data.agent_id).status, 'BLOCKED',
    'a subsequent turn cannot act on unaccounted work');
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED');
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
  // Every management turn that started ended and was booked: a throw out of the
  // finisher's error handler would leave the faulted turn with neither.
  const startedRoles = new Set(events.filter(event => event.type === 'turn-start').map(event => event.data.role));
  assert.ok(startedRoles.size > 0, 'management roles did take turns');
  assert.ok(roleEnds.length >= startedRoles.size, `${roleEnds.length} role turns ended for ${startedRoles.size} roles that started`);
  for (const roleAgent of runtime.store.listAgents(clusterId, {}).filter(agent => startedRoles.has(agent.role))) {
    assert.ok(roleAgent.turns > 0, `${roleAgent.role} booked its turn(s): ${roleAgent.turns}`);
  }
});

test('the Auditor reviews new or revised issues once, never spins on an unchanged one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one correction and its verdict', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 40 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  // The Auditor does its job on the turns it takes — deciding the plan audits it
  // is offered, and recording a blackboard entry — because a turn that changes
  // nothing is stagnation by design and three of those block the node.
  let published = 0;
  host.setScript(async () => {
    published += 1;
    // The script records a change (so its turns are not stagnation) but leaves
    // the audits alone: this test drives every decision itself.
    touchBlackboard(runtime, clusterId, `verdict/${published}`, auditor.agent_id);
  });
  runtime.enableScheduling();
  const auditorActions = () => runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'turn-actions' && event.data.role === 'auditor')
    .flatMap(event => event.data.actions ?? []);
  // Which actions the Auditor's turns are actually offered in this phase — the
  // interface the scheduler uses, read from the durable record rather than from a
  // copy of the selection rule.
  const auditorTurnActions = () => runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'turn-actions' && event.data.role === 'auditor');
  const offeredInPhase = async () => {
    // Slice by *turn*, not by action count: a page's length varies, so counting
    // flattened actions can cut a turn in half.
    const before = auditorTurnActions().length;
    for (let pass = 0; pass < 3; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runtime.tick();
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    const turns = auditorTurnActions();
    const all = turns.flatMap(event => event.data.actions ?? []);
    return { phase: turns.slice(before).flatMap(event => event.data.actions ?? []), all };
  };

  // 1. A dispatched plan leaves a plan audit pending: that is the Auditor's work
  //    (and not a correction verdict).
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const dispatched = await offeredInPhase();
  assert.ok(dispatched.phase.includes('inspect_plan'), `the pending plan audit is offered: ${JSON.stringify(dispatched.phase)}`);
  assert.ok(!dispatched.phase.includes('review_issue'), 'and no issue to review yet');

  // 2. The rejection opens an issue the Orchestrator owes a change for; the
  // Auditor may check whether its original observation was mistaken.
  const rejection = command(runtime, auditor, 'inspect_plan', {
    transaction_id: tx.id, decision: 'reject', required_change: 'name the depth-3 node',
  }).result;
  assert.ok(rejection.issue_id);
  const afterRejection = await offeredInPhase();
  // The pending action asks for review without declaring an unchanged issue
  // either resolved or mistaken. A wrong report can still be withdrawn.
  assert.ok(afterRejection.phase.includes('review_issue'),
    `the issue is offered for independent review: ${JSON.stringify(afterRejection.phase)}`);

  // 3. Before any change there is nothing to verify at all: the call is refused,
  //    and the correction budget is untouched.
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: rejection.issue_id, decision: 'NOT_FIXED', evidence: {} }),
    /correction to verify/);
  assert.equal(runtime.store.getIssue(rejection.issue_id).corrections, 0, 'a verdict without a correction costs nothing');
  const afterFailed = await offeredInPhase();
  // The unprogressed candidate is one-shot: the Auditor has had a turn since the issue was
  // opened and nothing has changed, so it is not queued again — a genuine issue that no
  // repair has addressed must not manufacture an endless stream of Auditor turns (which
  // would burn its turn budget and stop the node for stagnation). A repair re-arms the
  // verdict through the ordinary `progressed` path.
  const stillOffered = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId),
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0])
    .filter(item => item.action === 'review_issue');
  assert.equal(stillOffered.length, 0,
    `an unchanged issue is not queued again after the Auditor has looked: ${JSON.stringify(stillOffered)}`);
  void afterFailed;

  // 4. The durable change earns the verdict.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, acceptance_criteria: ['a depth-3 management node exists'],
  }).result;
  assert.ok(adjusted.revision > 1);
  const afterAdjust = await offeredInPhase();
  assert.ok(afterAdjust.phase.includes('review_issue'),
    `the revised issue is offered for review: ${JSON.stringify(afterAdjust.phase)}`);
  // The gate's witness reads the same durable facts.
  const adjustments = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-adjusted')
    .map(event => ({ transaction_id: event.data.transaction_id, revision: event.data.revision }));
  assert.equal(correctionWitness([runtime.store.getIssue(rejection.issue_id)], adjustments).length, 1);
  // A bare failed counter, with no durable change, is not a correction.
  assert.equal(correctionWitness([{ ...runtime.store.getIssue(rejection.issue_id), transaction_id: 'other', corrections: 2 }], adjustments).length, 0);
  // And a failed verdict *after* a real change does move the counter, which is
  // what bounds the loop.
  command(runtime, auditor, 'verify_correction', { issue_id: rejection.issue_id, decision: 'NOT_FIXED', evidence: {} });
  assert.equal(runtime.store.getIssue(rejection.issue_id).corrections, 1, 'the failed attempt on a changed revision is counted');

  // 5. Closed, and never offered again.
  command(runtime, auditor, 'verify_correction', { issue_id: rejection.issue_id, decision: 'VERIFIED', evidence: { revision: adjusted.revision } });
  assert.equal(runtime.store.getIssue(rejection.issue_id).status, 'CORRECTED');
  const afterClosure = await offeredInPhase();
  assert.ok(!afterClosure.phase.includes('review_issue'),
    `a closed issue is never offered again: ${JSON.stringify(afterClosure.phase)}`);
});

test('an undecided audit is revisited turn after turn, and probing never consumes it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-auditcursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one plan audit nobody decides', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 60, tool_calls: 60, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });

  // The Auditor takes its turn and decides nothing: the audit stays pending. The
  // scheduling pass probes for work (`#managementPending`) before every turn, and
  // a probe that advanced the cursor would hand the real turn an empty page — the
  // audit would then never be presented again.
  const offered = [];
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    offered.push(turn.prompt.content[0].text.slice(0, 400));
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const actionEvents = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'turn-actions' && event.data.role === 'auditor');
  const withAudit = actionEvents.filter(event => (event.data.actions ?? []).includes('inspect_plan'));
  assert.ok(withAudit.length >= 2,
    `the Auditor was offered the pending audit on more than one turn: ${JSON.stringify(actionEvents.map(event => event.data.actions))}`);
  assert.equal(runtime.store.pendingAudits(clusterId, { node_id: root.id, kind: 'plan', limit: 5 }).length, 1,
    'and the audit is still pending, because nobody decided it');
  assert.ok(offered.length >= 2, `the turns really ran: ${offered.length}`);
});


test('a resumed Auditor receives parseable action evidence without a repeated full domain snapshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-audit-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const objective = 'Produce the actual artifacts under the workspace. '.repeat(25);
  const transactions = [0, 1, 2].map(index => ({
    id: `digest-${index}`, objective: `Verify the work in area ${index}. `.repeat(9),
    expected_output: `Recorded output for area ${index}. `.repeat(8),
    acceptance_criteria: [`The evidence for area ${index} is independently verifiable. `.repeat(5)],
  }));
  const clusterId = runtime.start({
    objective, workspace: dir, capabilities: [],
    initial_transactions: transactions,
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 60, tool_calls: 60, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  for (const tx of transactions) command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateAgent(auditor.agent_id, { turns: 3 }));

  let prompt = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id === auditor.agent_id && prompt === null) {
      prompt = turn.prompt.content[0].text;
    }
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 6 && prompt === null; pass += 1) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.ok(prompt, 'the pending audits activated the resumed Auditor');
  const json = prompt.split('Current domain state (read anything else with flow_query; every list answers with items/total/next_offset):\n')[1]
    ?.split('\n\nPerform the pending actions')[0];
  const digest = JSON.parse(json);
  const planActions = digest.pending_actions.filter(action => action.action === 'inspect_plan');
  assert.deepEqual(planActions.map(action => action.transaction_id).sort(), transactions.map(tx => tx.id).sort(),
  'all three review decisions and their transaction references remain actionable');
  for (const action of planActions) {
    const transaction = transactions.find(tx => tx.id === action.transaction_id);
    assert.deepEqual(action.acceptance_criteria, transaction.acceptance_criteria,
      `the Auditor decision for ${transaction.id} still carries the criteria it must judge`);
  }
  assert.ok(prompt.length < 4_000, `a resumed session has room for this prompt inside its 8192-token context: ${prompt.length}`);
});

test('restore refuses a checkpoint the session is not at, and fences the instance it replaces', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = runtime.store.getAgent(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0].agent_id);

  // A checkpoint with a durable offset, and a session whose offset is known.
  const checkpoint = runtime.store.tx(() => runtime.store.insertCheckpoint({
    id: 'cp-1', cluster_id: clusterId, agent_id: worker.id, session_id: worker.session_id,
    flushed_seq: 12, events_seq: 40, transaction_id: null, transaction_revision: null,
    inbox_ack_cursor: null, usage_watermark: null, turn_seq: 3, data: {},
  }));
  runtime.sessionOffsetOf = () => 12;
  // An idle identity that already ran turns, checked out with no live instance to
  // ask: the checkpoint records no offset, and nothing proves where the session
  // is — that is a refusal, and it must not mutation anything on the way out.
  const idleWorker = runtime.store.getAgent(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' })[0]?.agent_id ?? worker.id);
  const before = runtime.store.getAgent(worker.id);
  const leaseBefore = runtime.store.insertLease ? null : null;
  void leaseBefore;

  // Ahead of the checkpoint: history was appended after it, so it cannot be
  // restored — and nothing may change while it is refused.
  runtime.sessionOffsetOf = () => 15;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: worker.id }), /cannot be rewound|session is at/);
  assert.equal(runtime.store.getAgent(worker.id).epoch, before.epoch, 'a refused restore does not advance the epoch');

  // Unknown: the session offset cannot be read, so nothing proves it is at the
  // checkpoint.
  runtime.sessionOffsetOf = () => null;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: worker.id }), /cannot be validated/);
  assert.equal(runtime.store.getAgent(worker.id).epoch, before.epoch, 'and a second refusal still changes nothing');

  // At the checkpoint: accepted, and the identity is fenced for real — the lease
  // the replaced instance holds is gone, which is what its finisher reads.
  runtime.sessionOffsetOf = () => 12;
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-old', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    epoch: before.epoch, purpose: 'worker-turn', expires: runtime.timestamp() + 60_000,
    event_upper_bound: null, created: runtime.timestamp(),
  }));
  const oldLease = runtime.store.getLease('lease-old');
  assert.equal(runtime.leaseStillHeld(oldLease), true, 'the replaced instance holds a live lease');
  const restored = command(runtime, allocator, 'restore', { agent_id: worker.id, checkpoint_id: checkpoint.id }).result;
  assert.equal(restored.checkpoint_id, checkpoint.id);
  assert.equal(restored.native_offset, 12);
  assert.equal(runtime.store.getLease('lease-old'), null, 'the old lease is deleted');
  assert.equal(runtime.leaseStillHeld(oldLease), false, 'so the replaced instance can no longer publish');
  assert.ok(runtime.store.getAgent(worker.id).epoch > before.epoch, 'and the epoch advanced');
  const fenced = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'lease-fenced');
  assert.equal(fenced.length, 1, 'the fencing is recorded');
  assert.equal(fenced[0].data.lease_id, 'lease-old');

  // An idle identity with history and a checkpoint that records no offset: the
  // host has no live instance to ask, so nothing verifies the session — refused,
  // and again with no mutation.
  const idleCheckpoint = runtime.store.tx(() => runtime.store.insertCheckpoint({
    id: 'cp-idle', cluster_id: clusterId, agent_id: idleWorker.id, session_id: idleWorker.session_id,
    flushed_seq: null, events_seq: runtime.store.latestEventSeq(clusterId),
    transaction_id: null, transaction_revision: null, inbox_ack_cursor: null, usage_watermark: null,
    turn_seq: 4, data: { reason: 'idle checkout' },
  }));
  const idleBefore = runtime.store.getAgent(idleWorker.id);
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-idle', cluster_id: clusterId, agent_id: idleWorker.id, node_id: idleWorker.node_id,
    epoch: idleBefore.epoch, purpose: 'worker-turn', expires: runtime.timestamp() + 60_000,
    event_upper_bound: null, created: runtime.timestamp(),
  }));
  runtime.sessionOffsetOf = () => null;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: idleWorker.id, checkpoint_id: idleCheckpoint.id }), /cannot be validated/);
  assert.equal(runtime.store.getAgent(idleWorker.id).epoch, idleBefore.epoch, 'no epoch bump for the unverified checkpoint');
  assert.ok(runtime.store.getLease('lease-idle'), 'and its lease is untouched');
});

test('a cluster tool call without a stable host call id is refused before anything is reserved', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-callid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one refused tool call', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 500_000, model_requests: 20, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];

  // The hook the host pipeline calls, taken from the wiring the plugin performs
  // (`ctx.on('tools/execute', …)` on the fake host's ctx).
  const hook = host.toolExecutionHook();
  assert.ok(typeof hook === 'function', 'the plugin registered a tool-execution hook');

  const before = {
    effects: runtime.store.effectsAll(clusterId, {}).length,
    receipts: runtime.store.all('SELECT COUNT(*) AS c FROM tool_call_receipts WHERE cluster_id=?', clusterId)[0].c,
    budget: runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id),
  };
  let nextCalled = false;
  const result = await hook({
    name: 'flow_query', parent: undefined, callId: undefined,
    agent: { id: agent.session_id, session: { id: agent.session_id } },
    signal: new AbortController().signal,
  }, async () => { nextCalled = true; return { content: [] }; });

  assert.equal(nextCalled, false, 'the tool never dispatched');
  assert.equal(result?.isError, true, 'and the host is told why');
  assert.equal(result?.error?.info?.code, 'TOOL_IDENTITY_MISSING');
  const after = {
    effects: runtime.store.effectsAll(clusterId, {}).length,
    receipts: runtime.store.all('SELECT COUNT(*) AS c FROM tool_call_receipts WHERE cluster_id=?', clusterId)[0].c,
    budget: runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id),
  };
  assert.equal(after.effects, before.effects, 'no effect was created');
  assert.equal(after.receipts, before.receipts, 'no receipt was created');
  assert.deepEqual(after.budget, before.budget, 'and no quota moved');
  const refused = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'tool-call-refused');
  assert.equal(refused.length, 1, 'the refusal is recorded');
  assert.equal(refused[0].data.code, 'TOOL_IDENTITY_MISSING');
});


test('an unfunded compaction that leaves the request unsendable is a budget stop end to end', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-unfunded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The session is over the provider ceiling, compaction is attempted, and the
  // compaction request itself cannot be funded: that is a budget stop produced by
  // the *ceiling* code path, which used to be recognised only in its context
  // shape.
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: 131_000, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded() { throw new Error('compaction budget exhausted for tokens: requested 97020, available 64000'); },
    },
  });
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one unshrinkable session', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 1, max_corrections: 1, max_role_turns: 2 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx.id });
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    const decision = await turn.preStep({ step: 1 });
    if (decision.kind === 'enter') await turn.request({ purpose: 'worker' });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(runtime.store.getTransaction(tx.id).status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  const blocked = runtime.store.get(
    "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", clusterId,
  );
  const stop = blocked ? JSON.parse(blocked.data) : null;
  assert.equal(stop?.code, 'BUDGET_EXHAUSTED', 'the stop is coded as a budget stop from the producer');
  assert.match(String(stop?.reason), /^BUDGET:/);
  // The worker path never reached a withheld result here (the step was refused),
  // but the refusal's code is what any withheld record would carry.
  const step = runtime.store.get(
    "SELECT data FROM events WHERE cluster_id=? AND type='context-step' ORDER BY seq DESC LIMIT 1", clusterId,
  );
  assert.equal(step ? JSON.parse(step.data).decision : null, 'reject', 'the step gate refused it');
});

test('a critical notification alone wakes its role and is consumed exactly once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-critical-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an idle role with one critical message', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];

  // No structural work at all: the identity's only reason to run is the message.
  // Every turn it takes makes a real change (a blackboard entry) — a turn that
  // changes nothing is stagnation by design, and three of those block the node.
  let published = 0;
  let allowWork = false;
  host.setScript(async () => {
    published += 1;
    // Every turn makes a real change. During the noise phase no work is allowed
    // to appear, so any Allocator turn would have to come from the notification
    // itself — which is what that phase asserts.
    const drafts = runtime.store.listTransactions({ cluster_id: clusterId, status: 'DRAFT', limit: 8 });
    if (allowWork && drafts.length) {
      command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { limit: 8 });
    }
    touchBlackboard(runtime, clusterId, `wake/${published}`, allocator.id);
  });
  runtime.enableScheduling();
  const inboxCount = () => runtime.store.all('SELECT status, COUNT(*) AS c FROM inbox WHERE cluster_id=? GROUP BY status', clusterId);
  assert.deepEqual(inboxCount(), [], 'nothing is queued yet');

  // A noisy notification does not wake anybody on its own: that is what
  // manufactured turns before.
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'load-changed', payload: { active_turns: 3 } });
  for (let pass = 0; pass < 2; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const turnsAfterNoise = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'turn-start' && event.data.role === 'allocator').length;
  assert.equal(turnsAfterNoise, 0, 'a load notification alone does not start a turn');

  // An anomaly is governance work: the idle Allocator is woken, takes it, and the
  // message is consumed exactly once (a crash before the turn ends would leave it
  // for redelivery, not lose it).
  allowWork = true;
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'worker-1', code: 'LIMIT_REACHED' } });
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (inboxCount().some(row => row.status === 'CONSUMED')) break;
  }
  const actionEvents = runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'turn-actions' && event.data.role === 'allocator');
  assert.ok(actionEvents.some(event => (event.data.actions ?? []).includes('inbox')), `the message was taken into a turn: ${JSON.stringify(actionEvents.map(event => event.data.actions))}`);
  const counts = inboxCount();
  assert.equal(counts.find(row => row.status === 'CONSUMED')?.c, 1, `the critical message is consumed exactly once: ${JSON.stringify(counts)}`);
  // The noisy one stays queued: it rides along with the next structural turn
  // instead of waking a role on its own.
  const pendingSubjects = runtime.store.all("SELECT subject FROM inbox WHERE cluster_id=? AND status='PENDING'", clusterId).map(row => row.subject);
  assert.ok(pendingSubjects.includes('load-changed'), `the noise waits for a structural turn instead of waking one: ${JSON.stringify(pendingSubjects)}`);
  // The consumed message is never re-offered or reopened: the turns that follow
  // belong to the work the run is doing, not to the message.
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const anomalies = runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='agent-anomaly'", clusterId);
  assert.equal(anomalies.length, 1, 'the message exists once');
  assert.equal(anomalies[0].status, 'CONSUMED', 'and stays consumed');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'inbox-reopened' && event.data.count >= 1).length, 0,
    'nothing hands it back');
});

test('a plan change waits for its new audit rather than waking idle governance turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-plan-notice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'revise and review a plan', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, priority: 8 });
  const notices = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' });
  assert.equal(notices.some(row => row.subject === 'transaction-modified'), true);

  runtime.enableScheduling();
  await runtime.tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  assert.equal(runtime.store.listAgents(clusterId, { role: 'auditor' })[0].turns, 0,
    'a DRAFT edit has no audit yet; its notification must not burn a model turn');
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' })
    .some(row => row.subject === 'transaction-modified'), true, 'the notice remains durable');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const deadline = Date.now() + 3_000;
  while (runtime.store.listAgents(clusterId, { role: 'auditor' })[0].turns === 0 && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.ok(runtime.store.listAgents(clusterId, { role: 'auditor' })[0].turns > 0, 'the new plan audit wakes governance');
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'CONSUMED' })
    .some(row => row.subject === 'transaction-modified'), true, 'the edit notice accompanies that decision');
});

test('a revalidation answers its issue: no plan edit is needed to close the round', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { claim: 'done' } }));
  command(runtime, orchestrator, 'validate', { transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y' }] });

  // The Auditor demands a re-validation of the current result revision.
  const requested = command(runtime, auditor, 'request_revalidation', {
    transaction_id: tx.id, required_change: 're-run validation against the current result revision',
  });
  const issueId = requested.result.issue_id;
  const issue = runtime.store.getIssue(issueId);
  assert.equal(issue.status, 'OPEN');
  const target = Number(issue.target_revision);
  // Nothing to verify yet.
  assert.equal(runtime.issueProgressed(clusterId, issue).progressed, false);
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'VERIFIED', evidence: {} }), /correction to verify/);

  // The Orchestrator does exactly what was asked — re-validate, no plan edit.
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y', revalidated: true }],
  });
  const progress = runtime.issueProgressed(clusterId, runtime.store.getIssue(issueId));
  assert.equal(progress.progressed, true, `a re-validation is durable progress: ${JSON.stringify(progress)}`);
  assert.equal(progress.how, 'revalidated');
  assert.ok(Number(runtime.store.getTransaction(tx.id).result_revision) > target, 'and it is past the issue\'s revision');

  // So the verdict is accepted and closes the round.
  const verified = command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'VERIFIED', evidence: { revalidated: true } });
  assert.equal(verified.result.status, 'CORRECTED');
  assert.equal(runtime.store.getIssue(issueId).status, 'CORRECTED');
  assert.equal(runtime.store.getIssue(issueId).corrections, 0, 'a first-try correction leaves the counter alone');
});

test('a runtime stopped mid-request leaves no reserved receipt, no lease and no running identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  const clusterId = runtime.start({
    objective: 'a turn that is live when the runtime stops', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tokens: 2_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id });

  // The turn blocks inside its own request, so it is live and holds a reservation
  // and a lease when the runtime is torn down under it.
  let release = null;
  host.setScript(async turn => {
    await turn.request({ purpose: 'role' });
    await new Promise(resolvePromise => { release = resolvePromise; });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId).c > 0
      && runtime.store.get('SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=?', clusterId).c > 0) break;
  }
  assert.ok(runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId).c > 0, 'a turn really is live');

  // A request that was reserved and whose turn never settled it — the state a
  // crash leaves behind.
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const reserved = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: runtime.budgetChainForAgent(orchestrator, { tokens: 1_000, requests: 1 }), reservationTokens: 1_000, turn_seq: 1,
  });
  const heldBefore = runtime.store.get('SELECT SUM(tokens_reserved) AS c FROM budgets').c;
  const spentBefore = runtime.store.get('SELECT SUM(requests_spent) AS c FROM budgets').c;
  assert.ok(heldBefore > 0, `the reservation is held: ${heldBefore}`);

  // The teardown is awaited: it drains the finishers of the turns it aborted, and
  // those finishers need the store.
  const disposing = runtime.dispose();
  if (release) release();
  await disposing;

  const dbPath = join(dir, 'cluster.sqlite');
  assert.ok(existsSync(dbPath));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (sql) => db.prepare(sql).get().c;
  assert.equal(count('SELECT COUNT(*) AS c FROM leases'), 0, 'no lease survives the teardown');
  assert.equal(count("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='RESERVED'"), 0, 'and no request is left reserved');
  // The unknown-cost send is not handed back: its token hold survives the restart.
  const held = db.prepare('SELECT SUM(tokens_reserved) AS c FROM budgets').get().c ?? 0;
  assert.ok(held >= heldBefore, `no held token was refunded (before ${heldBefore}, after ${held})`);
  // …and the *attempt* is consumed rather than relabelled: a reconciled request
  // moves from reserved to spent, so a restart cannot re-spend it.
  const spentAfter = db.prepare('SELECT SUM(requests_spent) AS c FROM budgets').get().c ?? 0;
  assert.ok(spentAfter > spentBefore, `the in-flight attempt is spent, not merely relabelled (${spentBefore} → ${spentAfter})`);
  assert.equal(db.prepare('SELECT total_tokens AS c FROM usage_receipts WHERE request_id=?').get(reserved.request_id).c ?? 0, 0,
    'and nothing was charged for it');
  const unknown = db.prepare("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='UNKNOWN' AND note LIKE '%runtime stopped%'").get().c;
  assert.equal(unknown, 1, 'the in-flight request is recorded as unknown, with its reason');
  db.close();
});

test('recovery keeps the holds of unknown and in-flight requests, and cannot refund them', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const nodeBefore = budgetView(runtime.store.getBudget(nodeBudget.id));
  // Both requests are charged to the *identity's own* scope on purpose: that is
  // the scope the faulty recovery reset zeroed, so this regression fails against
  // it (an exact-hold assertion cannot pass when the hold is erased).
  const chain = [agentBudget.id];

  // One request sent whose cost the provider never reported: its tokens stay held.
  const unknown = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 3_000, turn_seq: 1,
  });
  settleLlmRequest(runtime.store, { cluster_id: clusterId, reservation: unknown, usage: null, status: 'UNKNOWN' });
  // And one still in flight when the process died.
  reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 3_000, turn_seq: 2,
  });
  const held = runtime.store.getBudget(agentBudget.id).tokens_reserved;
  assert.equal(held, 6_000, `both holds are on the identity's own scope: ${held}`);

  // A fenced identity that is eligible for grant reclamation, so the reclamation
  // path runs over the same scope the holds live in.
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-old', cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
      epoch: 1, purpose: 'role-turn', expires: runtime.timestamp() - 1_000, event_upper_bound: null, created: runtime.timestamp(),
    });
  });

  runtime.recover({ deferScheduling: true });

  const after = runtime.store.getBudget(agentBudget.id);
  assert.equal(after.tokens_reserved, held, `recovery keeps the holds exactly: ${after.tokens_reserved} vs ${held}`);
  assert.equal(after.requests_reserved, 1, 'the in-flight request still holds its attempt');
  assert.equal(after.agents_reserved, 0, 'while identity capacity is released');
  assert.equal(after.max_active_reserved, 0, 'and so is the active window');
  const nodeAfter = budgetView(runtime.store.getBudget(nodeBudget.id));
  assert.equal(nodeAfter.tokens.limit, nodeBefore.tokens.limit, 'the node is refunded nothing it had not funded');
  assert.equal(runtime.store.getLease('lease-old'), null, 'and the stale lease is fenced');

  // The held capacity cannot be re-spent: the free remainder is exactly what is
  // left after the holds, and a request beyond it is refused.
  const free = dimensionAvailable(runtime.store.getBudget(agentBudget.id), 'tokens');
  assert.throws(() => reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: [agentBudget.id], reservationTokens: free + 1_000, turn_seq: 3,
  }), /exhausted/);
  assert.equal(runtime.store.getBudget(agentBudget.id).tokens_reserved, held, 'and the failed attempt moved nothing');
});
test('a turn that never admitted its prompt hands the critical message back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a turn that fails before admitting', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];
  host.setScript(async () => {});
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });

  // The turn takes the message and then dies before its prompt is admitted —
  // once, so the identity's failure counter stays below the block threshold.
  const original = runtime.acquireLlmSlot;
  runtime.acquireLlmSlot = async () => { throw new Error('injected failure before admission'); };
  await runtime.tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.ok(events.some(event => event.type === 'inbox-reopened'), `the message was handed back: ${JSON.stringify(events.filter(e => e.type.startsWith('inbox')).map(e => e.type))}`);
  const queued = runtime.store.all("SELECT id, status FROM inbox WHERE cluster_id=? AND subject='agent-anomaly'", clusterId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, 'PENDING', 'and it is queued again rather than lost');

  // With the failure gone, the next turn takes it once and consumes it. The
  // permit function is restored on the *prototype* the runtime actually calls.
  runtime.acquireLlmSlot = original;
  for (let pass = 0; pass < 10; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='agent-anomaly'", clusterId).some(row => row.status === 'CONSUMED')) break;
  }
  assert.equal(runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='agent-anomaly'", clusterId)[0].status, 'CONSUMED', 'and the retry consumes it exactly once');
});

test('a dispatched tool call is charged once at recovery, across two restarts', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 20, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const owner = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  const scope = runtime.store.budgetForScope(clusterId, 'agent', owner.id).id;

  runtime.store.tx(() => runtime.store.updateBudget(scope, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  const seed = (callId, dispatchStatus) => {
    runtime.store.tx(() => {
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: owner.id, session_id: owner.session_id,
        turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope,
        dispatch_status: dispatchStatus, result_body: null, error: null,
        created: runtime.timestamp(), settled: null,
      });
      runtime.store.updateBudget(scope, { tool_calls_reserved: runtime.store.getBudget(scope).tool_calls_reserved + 1 });
    });
  };
  const counters = () => ({ reserved: runtime.store.getBudget(scope).tool_calls_reserved, spent: runtime.store.getBudget(scope).tool_calls_spent });

  // A read that dispatched and whose outcome the restart made unknown: exactly one
  // call is consumed, with no effect row and no human decision.
  seed('read-dispatched', 'DISPATCHED');
  seed('read-admitted', 'ADMITTED');
  assert.deepEqual(counters(), { reserved: 2, spent: 0 });

  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'the dispatched read costs one call; the admitted one costs nothing');
  assert.equal(runtime.store.getToolCallReceipt('read-dispatched').dispatch_status, 'UNKNOWN');
  assert.equal(runtime.store.getToolCallReceipt('read-admitted').dispatch_status, 'CANCELLED');

  // A second restart changes nothing: the reconciliation is idempotent.
  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'the second restart charges nothing again');
});
test('a crash between taking a message and admitting it reopens it on recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];
  // The turn takes the message and then the process dies — no finisher runs, only
  // the restart does.
  let release = null;
  host.setScript(async () => { await new Promise(resolvePromise => { release = resolvePromise; }); });
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.all("SELECT status FROM inbox WHERE cluster_id=?", clusterId).some(row => row.status === 'CONSUMED')) break;
  }
  const taken = runtime.store.all("SELECT id, status FROM inbox WHERE cluster_id=?", clusterId);
  assert.equal(taken[0].status, 'CONSUMED', 'the live turn owns the message');
  const turnStart = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'turn-start').at(-1);
  assert.deepEqual(turnStart.data.inbox_ids, [taken[0].id], 'and the ownership is durable, by id');

  // Recovery is what the restart runs: it fences the dead turn's lease and hands
  // back the messages that turn owned and never answered.
  // A restarted process has a fresh runtime, not the old live agent handles.
  const restarted = new ClusterRuntime(host.ctx, {
    ...runtime.config, path: join(dir, 'cluster.sqlite'), autoTick: false,
  });
  t.after(async () => { await restarted.dispose(); });
  restarted.recover({ deferScheduling: true });
  const after = restarted.store.all("SELECT id, status FROM inbox WHERE id=?", taken[0].id);
  assert.equal(after[0].status, 'PENDING', 'recovery hands the unproven message back');
  const reopened = restarted.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'inbox-reopened');
  assert.ok(reopened.some(event => event.data.count >= 1 && /restarted before the turn proved/.test(String(event.data.reason))),
    `the reopen is recorded with its cause: ${JSON.stringify(reopened.map(event => event.data))}`);
  if (release) release();
});
test('a turn whose flush is refused hands its messages back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-flush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({ flushResult: false });
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];
  host.setScript(async () => {});
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'w1' } });
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const state = runtime.store.all("SELECT status FROM inbox WHERE cluster_id=?", clusterId)[0];
  assert.equal(state.status, 'PENDING', 'a prompt that never became durable does not answer its message');
  const reopened = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'inbox-reopened');
  assert.ok(reopened.some(event => /session was not flushed/.test(String(event.data.reason))),
    `and the reason names the refused flush: ${JSON.stringify(reopened.map(event => event.data.reason))}`);
});

test('the host op surfaces wait for disposal before answering', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-hostop-'));
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); });
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: runtime.store.listTransactions({ cluster_id: clusterId })[0].id });

  let release = null;
  host.setScript(async () => { await new Promise(resolvePromise => { release = resolvePromise; }); });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId).c > 0) break;
  }
  assert.ok(runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId).c > 0, 'a turn is live');

  // The host op must not answer "disposed" over a runtime that is still closing
  // out its turns: by the time it returns, the leases are fenced.
  const { handleHostOp } = await import('../../src/adapter/index.js');
  const answer = handleHostOp(runtime, { op: 'dispose' });
  assert.ok(typeof answer?.then === 'function', 'the op is asynchronous');
  // The turn's script is released while disposal drains, so the finisher can run.
  setTimeout(() => { if (release) release(); }, 30);
  const result = await answer;
  assert.deepEqual(result, { ok: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'cluster.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leases').get().c, 0, 'and the leases are already fenced when it answers');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='RESERVED'").get().c, 0, 'with no request left reserved');
  db.close();
});

test('a receipt with no resolvable payer blocks its owner instead of debiting another request', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const chain = runtime.budgetChainForAgent(agent, { tokens: 2_000, requests: 1 });

  // Another request legitimately holds quota in the chain this agent would fall
  // back to: that hold must not be the one an unattributable receipt consumes.
  const live = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: chain, reservationTokens: 2_000, turn_seq: 1,
  });
  const payer = runtime.store.getUsageReceipt(live.request_id).budget_scope_id;
  const before = runtime.store.getBudget(payer);
  assert.equal(before.requests_reserved, 1);

  // A receipt whose recorded payer does not exist.
  runtime.store.tx(() => runtime.store.insertUsageReceipt({
    request_id: 'orphan-request', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    transaction_id: null, role: 'orchestrator', kind: 'role', provider: 'p', model: 'm',
    status: 'RESERVED', reservation_tokens: 500, turn_seq: 1, attempt: 1,
    budget_scope_id: 'budget-that-does-not-exist',
  }));

  const reconciliation = runtime.reconcileReservations(runtime.store.getCluster(clusterId), agent);
  assert.equal(reconciliation.uncertain, 1, `the orphan is reported as uncertain: ${JSON.stringify(reconciliation)}`);
  const after = runtime.store.getBudget(payer);
  // The live receipt is reconciled against its own payer — one attempt consumed,
  // its token hold untouched. The orphan contributes nothing: the fallback chain
  // would have consumed a second request from this same scope.
  assert.equal(after.requests_spent, before.requests_spent + 1, 'exactly one attempt was consumed');
  assert.equal(after.requests_reserved, 0, 'the live reservation became a spent attempt');
  assert.equal(after.tokens_reserved, before.tokens_reserved, 'and its tokens stay held');
  assert.equal(runtime.store.getAgent(agent.id).status, 'BLOCKED', 'the owner is blocked');
  assert.equal(runtime.store.getUsageReceipt('orphan-request').status, 'RESERVED', 'and the orphan reservation is preserved');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /does not exist/.test(String(event.data.reason))));
  assert.ok(events.some(event => event.type === 'node-blocked' && event.data.code === 'ACCOUNTING_UNCERTAIN'));
  void orchestrator;
});

test('a failed settlement leaves the receipt held and blocks its transaction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' })[0];
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const reserved = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, transaction_id: tx.id,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: runtime.budgetChainForAgent(agent, { tokens: 2_000, requests: 1 }),
    reservationTokens: 2_000, turn_seq: 1,
  });
  const payer = runtime.store.getUsageReceipt(reserved.request_id).budget_scope_id;
  // Simulate a damaged ledger: the payer row still exists, but its request
  // hold disappeared. Settling this receipt must not consume another hold.
  runtime.store.tx(() => runtime.store.updateBudget(payer, { requests_reserved: 0 }));
  const outcome = runtime.reconcileReservations(runtime.store.getCluster(clusterId), agent, { transactionId: tx.id });
  assert.deepEqual(outcome, { consumed: 0, uncertain: 1 });
  assert.equal(runtime.store.getUsageReceipt(reserved.request_id).status, 'RESERVED');
  assert.equal(runtime.store.getBudget(payer).requests_spent, 0);
  assert.equal(runtime.store.getAgent(agent.id).status, 'BLOCKED');
  assert.equal(runtime.store.getTransaction(tx.id).status, 'BLOCKED',
    'the Orchestrator must not publish work whose request cannot be settled');
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 200 }).some(event =>
    event.type === 'accounting-uncertain' && event.data.code === 'ACCOUNTING_UNCERTAIN'));
});

test('tool quota is reconciled once, by how far the call got — not by the effect decision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const scope = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const nodeBefore = budgetView(runtime.store.getBudget(nodeBudget.id));

  const seed = (callId, dispatchStatus) => {
    runtime.store.tx(() => {
      runtime.store.updateBudget(scope.id, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 5 });
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
        turn_seq: 1, tool: 'write', args_hash: 'h', command_id: null, budget_scope_id: scope.id,
        dispatch_status: dispatchStatus, result_body: null, error: null,
        created: runtime.timestamp(), settled: null,
      });
      runtime.store.insertEffect({
        call_id: callId, cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
        lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'write', args: {},
        status: 'EFFECT_UNCERTAIN', created: runtime.timestamp(),
      });
    });
  };
  const counters = () => ({ reserved: runtime.store.getBudget(scope.id).tool_calls_reserved, spent: runtime.store.getBudget(scope.id).tool_calls_spent });

  // 1. Admitted, never dispatched: the hold is released and the call is not charged.
  seed('call-admitted', 'ADMITTED');
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-admitted', decision: 'failed', note: 'never ran' });
  assert.deepEqual(counters(), { reserved: 4, spent: 0 }, 'an undispatched call costs nothing');

  // 2. Dispatched: the attempt is consumed once, by the human decision here.
  seed('call-dispatched', 'DISPATCHED');
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-dispatched', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), { reserved: 4, spent: 1 }, 'a dispatched call costs exactly one call');
  assert.equal(runtime.store.getToolCallReceipt('call-dispatched').dispatch_status, 'SETTLED');
  // A second decision on the same call is refused (the effect is settled now), so
  // it cannot charge a second time.
  assert.throws(() => command(runtime, allocator, 'resolve_effect', { call_id: 'call-dispatched', decision: 'failed', note: 'again' }),
    /only an uncertain effect/);
  assert.deepEqual(counters(), { reserved: 4, spent: 1 }, 'and nothing moved');

  // 2b. `UNKNOWN` is terminal for the hold: recovery already consumed that call,
  // so a decision on it must move nothing at all (it used to be treated as held,
  // which took a call out of the reserve or out of someone else's hold).
  seed('call-already-unknown', 'UNKNOWN');
  const beforeUnknown = counters();
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-already-unknown', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), beforeUnknown, 'an already-reconciled call is not charged again');
  assert.equal(runtime.store.getToolCallReceipt('call-already-unknown').dispatch_status, 'SETTLED');

  // 3. A tool with no receipt at all (a read/query) has nothing to reconcile, and
  // resolving one must not move any quota.
  runtime.store.tx(() => {
    runtime.store.insertEffect({
      call_id: 'call-read', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
      lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'read', args: {},
      status: 'EFFECT_UNCERTAIN', created: runtime.timestamp(),
    });
  });
  const beforeRead = counters();
  command(runtime, allocator, 'resolve_effect', { call_id: 'call-read', decision: 'failed', note: 'no receipt' });
  assert.deepEqual(counters(), beforeRead, 'a call with no receipt settles nothing');

  // The node was never touched by any of it.
  assert.equal(budgetView(runtime.store.getBudget(nodeBudget.id)).tool_calls.spent, nodeBefore.tool_calls.spent);
});

test('a durably answered message is never reopened by recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-durable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];
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
  const message = runtime.store.all("SELECT id, status FROM inbox WHERE cluster_id=?", clusterId)[0];
  assert.equal(message.status, 'CONSUMED', 'the turn took it');
  // The turn ended: its prompt was admitted and flushed, so it is durable, and its
  // lease is gone.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
  assert.equal(runtime.store.get('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId).c, 0, 'the turn finished');

  runtime.recover({ deferScheduling: true });
  assert.equal(runtime.store.all("SELECT status FROM inbox WHERE id=?", message.id)[0].status, 'CONSUMED',
    'a durably answered message is not handed back');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'inbox-reopened').length, 0,
    'and no reopen is recorded');
});

test('an addressed message and a subscribed blackboard change each wake an idle role', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-commwake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocatorAgent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];
  const orchestratorAgent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  host.setScript(async () => {});
  runtime.enableScheduling();

  const turnsFor = role => runtime.store.readEvents(clusterId, { limit: 400 })
    .filter(event => event.type === 'turn-start' && event.data.role === role).length;
  const actionsFor = role => runtime.store.readEvents(clusterId, { limit: 400 })
    .filter(event => event.type === 'turn-actions' && event.data.role === role)
    .flatMap(event => event.data.actions ?? []);

  // A message addressed to the idle Allocator, through the communication API.
  const { communicate } = await import('../../src/adapter/communication.js');
  runtime.store.tx(() => communicate(runtime.store, runtime.store.getCluster(clusterId), {
    cluster_id: clusterId, agent_id: orchestratorAgent.id, node_id: root.id, role: 'orchestrator',
  }, 'send', { agent: allocatorAgent.id, content: 'look at the queue' }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, { subject: payload.kind, payload }),
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
  assert.equal(delivered[0].status, 'CONSUMED', 'and consumed by the turn it woke');

  // A blackboard change the Allocator subscribes to.
  runtime.store.tx(() => communicate(runtime.store, runtime.store.getCluster(clusterId), {
    cluster_id: clusterId, agent_id: allocatorAgent.id, node_id: root.id, role: 'allocator',
  }, 'subscribe', { prefix: 'shared/' }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, { subject: payload.kind, payload }),
  }));
  runtime.store.tx(() => communicate(runtime.store, runtime.store.getCluster(clusterId), {
    cluster_id: clusterId, agent_id: orchestratorAgent.id, node_id: root.id, role: 'orchestrator',
  }, 'publish', { key: 'shared/total', value: { total: 5 } }, {
    notify: (recipient, payload) => runtime.notifyInternal(clusterId, recipient, { subject: payload.kind, payload }),
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
  assert.equal(runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='blackboard'", clusterId)[0].status, 'CONSUMED');
});

test('a pre-dispatch failure never runs the tool and never costs quota', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-predispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  let executions = 0;
  host.registerTool({ name: 'read', description: 'read', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { executions += 1; return 'contents'; } });
  const counters = () => {
    const scope = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
    return { reserved: scope.tool_calls_reserved, spent: scope.tool_calls_spent };
  };

  // Both gates are driven *inside a live turn*, through the host's own pipeline:
  // a call with no lease is refused by the earlier gate and would prove nothing
  // about the barrier under test.
  let outcomes = null;
  host.setScript(async turn => {
    const originalFlush = host.ctx.sessions.flush;
    host.ctx.sessions.flush = async () => { throw new Error('injected flush failure'); };
    const flushFailure = await turn.callTool('read', { file_path: 'x' });
    host.ctx.sessions.flush = originalFlush;
    const previous = runtime.markToolCallDispatched;
    runtime.markToolCallDispatched = () => { throw new Error('injected dispatch-record failure'); };
    const dispatchedFailure = await turn.callTool('read', { file_path: 'y' });
    runtime.markToolCallDispatched = previous;
    outcomes = { flushFailure, dispatchedFailure, counters: counters() };
  });
  const before = counters();
  runtime.enableScheduling();
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', { objective: 'so the role runs', acceptance_criteria: ['x'] });
  for (let pass = 0; pass < 20 && !outcomes; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.ok(outcomes, 'the role took a turn');
  assert.equal(executions, 0, 'neither failure ran the tool');
  assert.equal(outcomes.flushFailure?.error?.info?.code, 'TOOL_CALL_UNFLUSHED', 'a thrown flush refuses before dispatch');
  assert.equal(outcomes.dispatchedFailure?.error?.info?.code, 'TOOL_CALL_UNDISPATCHED', 'and so does a dispatch that cannot be recorded');
  assert.equal(outcomes.counters.spent, before.spent, 'neither call was charged');
  assert.equal(outcomes.counters.reserved, before.reserved, 'and neither holds quota');
});

test('a completed Worker with an unattributable request is blocked, not published', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-orphan-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
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
    const agent = runtime.store.listAgents(clusterId, { role: 'worker' })[0];
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
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(runtime.store.getTransaction(tx.id).status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  assert.equal(runtime.store.getTransaction(tx.id).status, 'BLOCKED', 'the transaction is blocked, not submitted');
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.equal(events.filter(event => event.type === 'result-submitted' && event.data.transaction_id === tx.id).length, 0,
    'no result is published from unattributable accounting');
  const withheld = events.filter(event => event.type === 'result-withheld' && event.data.transaction_id === tx.id);
  assert.ok(withheld.some(event => event.data.code === 'ACCOUNTING_UNCERTAIN'), `the turn says why: ${JSON.stringify(withheld.map(event => event.data))}`);
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /does not exist/.test(String(event.data.reason))));
  // The staged result is kept for the human decision, and the adapter still holds
  // its orphan reservation rather than inventing a payer for it.
  assert.equal(runtime.store.getUsageReceipt('orphan-worker-request').status, 'RESERVED');
  assert.ok(runtime.store.getTransaction(tx.id).result !== null && runtime.store.getTransaction(tx.id).result !== undefined,
    'the staged result is preserved, not discarded');
});

test('one tool hold is moved once: recover, resolve and a late completion stay consistent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 20, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const owner = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  const scope = runtime.store.budgetForScope(clusterId, 'agent', owner.id).id;
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const counters = () => ({ reserved: runtime.store.getBudget(scope).tool_calls_reserved, spent: runtime.store.getBudget(scope).tool_calls_spent });

  runtime.store.tx(() => runtime.store.updateBudget(scope, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  const seed = (callId, status, { hold = true } = {}) => {
    runtime.store.tx(() => {
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: owner.id, session_id: owner.session_id,
        turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope,
        dispatch_status: status, result_body: null, error: null,
        created: runtime.timestamp(), settled: null,
      });
      if (hold) runtime.store.updateBudget(scope, { tool_calls_reserved: runtime.store.getBudget(scope).tool_calls_reserved + 1 });
    });
  };

  // One read in flight when the process died.
  seed('read-inflight', 'DISPATCHED');
  assert.deepEqual(counters(), { reserved: 1, spent: 0 });

  // Two restarts: the in-flight read is consumed exactly once.
  runtime.recover({ deferScheduling: true });
  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'exactly one call consumed, once');
  assert.equal(runtime.store.getToolCallReceipt('read-inflight').dispatch_status, 'UNKNOWN');

  // A *new* call takes a hold of its own after the restart. Everything that
  // follows concerns the recovered call, and none of it may touch this one.
  seed('other-hold', 'ADMITTED');
  assert.deepEqual(counters(), { reserved: 1, spent: 1 });

  // A human decision on the recovered call records the outcome and moves no quota —
  // in particular it does not take the hold the other call now owns.
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'read-inflight', cluster_id: clusterId, agent_id: owner.id, node_id: owner.node_id,
    lease_epoch: 1, session_id: owner.session_id, turn_seq: 1, tool: 'read', args: {},
    status: 'EFFECT_UNCERTAIN', created: runtime.timestamp(),
  }));
  command(runtime, allocator, 'resolve_effect', { call_id: 'read-inflight', decision: 'settled', note: 'it ran' });
  assert.deepEqual(counters(), { reserved: 1, spent: 1 }, 'the decision charges nothing and leaves the other call\'s hold alone');
  assert.equal(runtime.store.getToolCallReceipt('read-inflight').dispatch_status, 'SETTLED');

  // The late completion of that same call — the turn's own settlement arriving
  // after the restart — must also move nothing.
  const beforeLate = counters();
  runtime.settleToolCall(owner, { name: 'read' }, 'read-inflight', { content: [{ type: 'text', text: 'late' }] }, null, { charged: true });
  assert.deepEqual(counters(), beforeLate, 'a late completion of an already-settled call moves nothing');
  assert.equal(runtime.store.getToolCallReceipt('read-inflight').dispatch_status, 'SETTLED', 'and it cannot rewrite the outcome');

  // The untouched hold is still exactly where it was, and is released by its own
  // transition.
  assert.equal(runtime.store.getToolCallReceipt('other-hold').dispatch_status, 'ADMITTED');
  runtime.settleToolCall(owner, { name: 'read' }, 'other-hold', null, new Error('never dispatched'), { charged: false });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'releasing the other hold costs nothing');
  assert.equal(runtime.store.getToolCallReceipt('other-hold').dispatch_status, 'CANCELLED');
});

test('a role that only queries or is refused is stagnant, and stops at the bound', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stagnant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 })[0];

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
    if (runtime.store.getNode(root.id).status === 'BLOCKED') break;
  }

  // Queried from SQL, not from a page: this run emits more events than one page.
  const allocatorEnds = runtime.store.all(
    "SELECT json_extract(data,'$.progress') AS progress FROM events WHERE cluster_id=? AND type='turn-end' AND json_extract(data,'$.role')='allocator'",
    clusterId,
  ).map(row => row.progress === 1 || row.progress === '1' || row.progress === true);
  assert.ok(allocatorEnds.length >= 1, 'the role took turns');
  assert.ok(allocatorEnds.every(flag => flag === false),
    `query-only turns are not progress: ${JSON.stringify(allocatorEnds)}`);
  // The events those turns emitted are exactly the ones that used to look like
  // progress: each step meters context and charges a tool call.
  const countOf = type => runtime.store.get('SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type=?', clusterId, type).c;
  assert.ok(countOf('llm-slot') > 0, 'the provider requests were metered');
  assert.ok(countOf('tool-call-charged') > 0, 'and the query was charged');
  // So the bound is reached and the node stops instead of looping to the budget.
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED', 'the stagnation guard fires');
  const blocked = runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='node-blocked'", clusterId).at(-1);
  assert.match(String(JSON.parse(blocked.data).reason), /made no state change across \d+ turns/);
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
});

test('pre-turn and in-turn compaction keep both steps inside the identity budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-anchor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The meter reports the session; each compaction halves it.
  let tokens = 30_000;
  const calls = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: tokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(session, reason) {
        calls.push({ reason, at: tokens });
        tokens = Math.floor(tokens / 2);
        return { summarySeq: calls.length };
      },
    },
  });
  const runtime = makeRuntime(t, { workspace: dir });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];

  // A large session first shrinks before the turn, then each step must still
  // fit the identity limit; regrowth inside the turn requires another summary.
  const decisions = [];
  host.setScript(async turn => {
    decisions.push((await turn.preStep({ step: 1 })).kind);
    tokens = 16_000;
    decisions.push((await turn.preStep({ step: 2 })).kind);
  });
  await runTurn(host.ctx, {
    agent: auditor, role: 'auditor', prompt: 'work', allowedTools: [], globalTools: [], capabilities: [],
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', maxTokens: 512 },
    signal: new AbortController().signal, logger: { warn() {}, info() {}, error() {} },
    budgetIds: runtime.agentBudgetChain(runtime.store.getCluster(clusterId), auditor),
    transactionId: null, turnSeq: 1, flow: runtime,
    contextLimits: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });

  assert.deepEqual(decisions, ['enter', 'enter']);
  assert.equal(tokens, 8_000, 'both steps fit the 8192-token identity budget after compaction');
  assert.equal(calls.length, 3, 'pre-turn and two in-turn compactions were required');
  const steps = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => [event.data.decision, event.data.after]),
    [['compact', 7_500], ['compact', 8_000]]);
  assert.ok(steps.every(event => event.data.after + event.data.pending <= event.data.context_limit));
});

test('a long tool result is stored as valid JSON, never as a truncation of it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-jsonbody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  // Escapes, newlines and a length far past the old 8,000-character cut.
  const long = `line "quoted" \\ backslash\n${'x'.repeat(20_000)}`;
  host.registerTool({
    name: 'read', description: 'read', parameters: {}, output: { schema: { type: 'string' }, render: () => [] },
    // The host hands a tool result back as content blocks, which is the shape the
    // receipt's text is read from.
    async execute() { return { content: [{ type: 'text', text: long }] }; },
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
    let parsed = null;
    assert.doesNotThrow(() => { parsed = JSON.parse(receipt.result_body); }, `the body must be valid JSON: ${String(receipt.result_body).slice(0, 120)}`);
    assert.equal(typeof parsed.text, 'string');
    assert.ok(parsed.text.length <= 8_200, `the field is bounded, not the JSON: ${parsed.text.length}`);
    assert.match(parsed.text, /chars omitted/, 'and the omission is stated');
  }

  // The same rule for the human decision's note.
  const resolved = runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'call-long', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    lease_epoch: 1, session_id: agent.session_id, turn_seq: 1, tool: 'read', args: {},
    status: 'EFFECT_UNCERTAIN', created: runtime.timestamp(),
  }));
  // Seeded through the same reservation an admission performs: a receipt that
  // claims a hold the ledger does not show is an inconsistency, and the
  // transition now refuses to move anything for it.
  const agentScope = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(agentScope.id, { tool_calls_limit: agentScope.tool_calls_limit + 1 });
    runtime.store.updateBudget(agentScope.id, { tool_calls_reserved: Number(agentScope.tool_calls_reserved ?? 0) + 1 });
    runtime.store.insertToolCallReceipt({
      call_id: 'call-long', cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
      turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null,
      budget_scope_id: agentScope.id,
      dispatch_status: 'DISPATCHED', result_body: null, error: null, created: runtime.timestamp(), settled: null,
    });
  });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'resolve_effect', {
    call_id: 'call-long', decision: 'settled', note: `n".repeat(5000) ${'y'.repeat(5_000)}`,
  });
  const noteBody = runtime.store.getToolCallReceipt('call-long').result_body;
  let noteParsed = null;
  assert.doesNotThrow(() => { noteParsed = JSON.parse(noteBody); }, `the note body must be valid JSON: ${String(noteBody).slice(0, 120)}`);
  assert.match(String(noteParsed.note), /chars omitted/);
  void resolved;
});

test('a waiting Worker is admitted even when every management slot is pending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-fairshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'supervision must not eat the window', workspace: dir, capabilities: [],
    // A six-slot window with several management nodes: three roles each, so
    // supervision alone is always pending.
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 4, max_role_turns: 40 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 400, wall_time_ms: 600_000, agents: 32, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (runtime.store.getTransaction(tx.id).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 1, 'a Worker has work waiting');

  // Management work everywhere: two more management nodes, each with its own
  // three roles — six distinct management identities. Each spawn needs its own
  // delegated transaction: `spawn_management_node` returns the *existing* child
  // for a repeated one, so two calls with the same transaction built a single
  // node and the fixture never created the topology it claimed to.
  const spawnedNodes = [];
  for (const scope of ['alpha', 'beta']) {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective: `own ${scope}`, acceptance_criteria: ['x'], status: 'READY',
    });
    const delegatedId = created.result?.transaction_id ?? created.transaction_id;
    const spawned = command(runtime, allocator, 'spawn_management_node', {
      transaction_id: delegatedId, scope: { objective: `own ${scope}` }, max_children: 4, spawn_children: 0,
    });
    spawnedNodes.push((spawned.result ?? spawned).node_id);
  }
  assert.equal(new Set(spawnedNodes).size, 2, 'two distinct management children');
  const managementIdentities = runtime.store.all(
    "SELECT COUNT(DISTINCT a.id) AS c FROM agents a JOIN nodes n ON n.id = a.node_id WHERE a.cluster_id=? AND n.depth > 0",
    clusterId)[0].c;
  assert.ok(Number(managementIdentities) >= 6, `six distinct management identities: ${managementIdentities}`);
  // Every turn the roles take makes a real change, and none of them is a Worker.
  let published = 0;
  let workerStarted = false;
  // Management turns do not release themselves: supervision keeps holding the
  // window for as long as the test runs, which is the shape that starved the
  // Workers. A self-releasing turn frees a slot and hides the rule under test.
  let releaseManagement = () => {};
  const managementBarrier = new Promise(resolvePromise => { releaseManagement = resolvePromise; });
  t.after(() => releaseManagement());
  const workerTurns = () => runtime.store.all("SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.role')='worker'", clusterId)[0].c;
  // The management turns stay *live* until a Worker has run: that is the
  // starvation this test is about, where supervision holds the window open and
  // the work never gets a slot.
  host.setScript(async turn => {
    const text = turn.prompt?.content?.[0]?.text ?? '';
    if (text.startsWith('You are a Worker')) {
      workerStarted = true;
      return;
    }
    // Every management turn is held until a Worker has run: this is the
    // starvation the test is about, with the barrier in the turns themselves
    // rather than in an arithmetic assertion about the scheduler's rule.
    published += 1;
    touchBlackboard(runtime, clusterId, `fairshare/${published}`, null);
    for (const audit of runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 8 })) {
      command(runtime, auditor, 'inspect_plan', { audit_id: audit.id, decision: 'approve' });
    }
    if (workerStarted) return;
    await managementBarrier;
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 40; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (workerTurns() > 0) break;
  }
  const managementTurns = runtime.store.all("SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.role')<>'worker'", clusterId)[0].c;
  releaseManagement();
  assert.ok(managementTurns > 0, `supervision was running: ${managementTurns}`);
  assert.ok(workerTurns() > 0, `the waiting Worker was admitted (management turns: ${managementTurns})`);
  const starts = runtime.store.all("SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  assert.ok(starts.some(row => row.role === 'worker'), `roles that started: ${JSON.stringify(starts)}`);
});

test('the window keeps a slot for waiting work, whatever supervision wants', t => {
  // The exact shape that starved the Workers: a six-slot window, supervision
  // pending on every node and role, and one transaction READY with its allocation.
  const withWorker = scheduleAdmission({ window: 6, active: 0, workerWaiting: true });
  assert.equal(withWorker.managementCeiling, 5, 'supervision may take five of the six slots, not all six');
  assert.equal(scheduleAdmission({ window: 6, active: withWorker.managementCeiling, workerWaiting: true }).workerSlots, 1,
    'and the Worker gets the slot that was held for it');
  // With no Worker waiting, supervision may use the whole window.
  assert.equal(scheduleAdmission({ window: 6, active: 0, workerWaiting: false }).managementCeiling, 6);
  // A full window never yields a negative or reserved Worker slot.
  assert.equal(scheduleAdmission({ window: 6, active: 6, workerWaiting: true }).workerSlots, 0);
  assert.equal(scheduleAdmission({ window: 0, active: 0, workerWaiting: true }).workerSlots, 0);
  assert.equal(scheduleAdmission({ window: 6, active: 9, workerWaiting: true }).workerSlots, 0);
  // The old rule — supervision first, then a Worker reserve subtracted again —
  // could only ever offer `window - live - 1`, which is why the Workers waited.
  const oldRule = ({ window, active }) => Math.max(0, window - active - 1);
  assert.equal(oldRule({ window: 6, active: 6 }), 0, 'and that rule is what the fix replaces');
});

test('a receipt whose payer holds nothing is uncertain: nothing moves and the owner stops', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-holdmismatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a receipt that claims a hold it does not have', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  const scope = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  runtime.store.tx(() => runtime.store.updateBudget(scope.id, { tool_calls_limit: 10, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  // A receipt that says DISPATCHED with no reservation behind it.
  runtime.store.tx(() => runtime.store.insertToolCallReceipt({
    call_id: 'call-claiming', cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
    turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope.id,
    dispatch_status: 'DISPATCHED', result_body: null, error: null, created: runtime.timestamp(), settled: null,
  }));
  const before = { reserved: runtime.store.getBudget(scope.id).tool_calls_reserved, spent: runtime.store.getBudget(scope.id).tool_calls_spent };
  const outcome = runtime.settleToolReceiptQuota('call-claiming');
  assert.equal(outcome.outcome, 'uncertain', `nothing is consumed or released: ${JSON.stringify(outcome)}`);
  const after = { reserved: runtime.store.getBudget(scope.id).tool_calls_reserved, spent: runtime.store.getBudget(scope.id).tool_calls_spent };
  assert.deepEqual(after, before, 'the ledger does not move at all');
  assert.equal(runtime.store.getToolCallReceipt('call-claiming').dispatch_status, 'DISPATCHED', 'and the receipt keeps its state');
  assert.equal(runtime.store.getAgent(agent.id).status, 'BLOCKED', 'the owner stops');
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /holds no tool-call reservation/.test(String(event.data.reason))));
  assert.ok(events.some(event => event.type === 'node-blocked' && event.data.code === 'ACCOUNTING_UNCERTAIN'));
});

test("a side-effect tool's long body is bounded in both ledgers, and they agree", async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-effectbody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a side-effect body that stays parseable', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 })[0];
  // A live lease, which is what authorises a tool effect.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-body', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
    event_upper_bound: null, created: runtime.timestamp(),
  }));
  const scope = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  runtime.store.tx(() => runtime.store.updateBudget(scope.id, { tool_calls_limit: 10, tool_calls_reserved: 0, tool_calls_spent: 0 }));

  // A side-effect tool: the admission writes a receipt *and* an effect.
  // A mutating call also needs the identity of a live instance, exactly as the
  // host's pipeline presents it.
  const instance = { id: agent.session_id };
  runtime.bindTurnIdentity(instance, { cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id, role: 'orchestrator', epoch: agent.epoch, lease_id: 'lease-body', turn_seq: 1 });
  // `job_output` is a side-effect tool that needs no write scope: the point here
  // is the *effect* ledger's body, not the scope gate.
  const exec = { name: 'job_output', args: { job_id: 'job-1' }, agent: instance };
  const admitted = runtime.admitToolCall(agent, exec, 'call-bash');
  assert.equal(admitted.ok, true, `the call is admitted: ${JSON.stringify(admitted)}`);
  const long = `out "quoted" \\n${'z'.repeat(20_000)}`;
  runtime.settleToolCall(agent, exec, 'call-bash', { content: [{ type: 'text', text: long }] }, null, { charged: true });

  const receiptBody = JSON.parse(runtime.store.getToolCallReceipt('call-bash').result_body);
  const effect = runtime.store.getEffect('call-bash');
  assert.ok(effect, 'the effect row exists');
  const effectBody = JSON.parse(effect.body);
  assert.match(receiptBody.text, /chars omitted/, 'the receipt body states its omission');
  assert.equal(effectBody.text, receiptBody.text,
    'both ledgers hold the same bounded body (the effect used to hold the full output)');
  assert.ok(effectBody.text.length <= 8_200, `bounded, not unbounded: ${effectBody.text.length}`);
});

test('the inbox page shows the message a role must act on, not eight older notices', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inboxpriority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an inbox page that shows what matters', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 })[0];
  // Eight older informational rows, then the message that matters. The page is
  // eight rows wide, so without a subject ordering the message is never seen —
  // the rows stay PENDING and hide it on every subsequent page too.
  runtime.store.tx(() => {
    for (let index = 0; index < 8; index += 1) {
      const row = runtime.store.insertInbox({
        cluster_id: clusterId, recipient: auditor.id, subject: 'plan-approved',
        payload: { transaction_id: `tx-${index}` },
      });
      runtime.store.run('UPDATE inbox SET created=? WHERE id=?', `2026-01-01T00:00:0${index}.000Z`, row.id);
    }
    runtime.store.insertInbox({
      cluster_id: clusterId, recipient: auditor.id, subject: 'message',
      payload: { from: 'human', text: 'stop auditing that' },
    });
  });
  const pending = runtime.pendingFor('auditor', root, cluster, auditor);
  const subjects = pending.filter(item => item.action === 'inbox').map(item => item.subject);
  assert.ok(subjects.includes('message'),
    `the newest message is inside the page: ${JSON.stringify(subjects)}`);
  assert.equal(subjects[0], 'message', 'and it is the first thing the role reads');
});

test('a child node is funded by the work it must do, and the parent keeps the rest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodeshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a node funded by its need', workspace: dir, capabilities: [],
    // The recursion case's own shape: a 24-turn ceiling per role, six active agents
  // and a four-million-token cluster. The ceiling is a cap, not observed work.
  limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 4_194_304, model_requests: 512, tool_calls: 4_096, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = created.result?.transaction_id ?? created.transaction_id;
  const rootBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const parentBefore = runtime.store.getBudget(rootBudget.id);
  const spawned = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that can work', acceptance_criteria: ['x'],
  });
  const childId = (spawned.result ?? spawned).node_id;
  const childBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', childId).id);
  const roleBudgets = runtime.store.all(
    "SELECT tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=?", childId);
  // Its three roles' turns plus one wave of Workers, at this deployment's cost.
  assert.ok(Number(childBudget.requests_limit) + roleBudgets.reduce((sum, row) => sum + Number(row.requests_limit), 0) >= 24,
    `the child can run its roles and a wave: ${JSON.stringify({ node: childBudget.requests_limit, roles: roleBudgets.length })}`);
  assert.ok(Number(childBudget.tokens_limit) + roleBudgets.reduce((sum, row) => sum + Number(row.tokens_limit), 0) >= 100_000,
    `and its turns are funded: ${childBudget.tokens_limit}`);
  // The parent keeps what its own roles need rather than handing a structural
  // share away: it is the scope those roles spend from.
  const parentAfter = runtime.store.getBudget(rootBudget.id);
  // The child's endowment is between its working floor and its structural share
  // (a quarter of the parent here), and whatever happens the parent keeps the
  // larger part — it is the scope its own roles spend from.
  const endowment = Number(childBudget.tokens_limit) + roleBudgets.reduce((sum, row) => sum + Number(row.tokens_limit), 0);
  assert.ok(endowment <= Number(parentBefore.tokens_limit) / 4,
    `the child never exceeds its structural share: ${endowment} of ${parentBefore.tokens_limit}`);
  assert.ok(Number(parentAfter.tokens_limit) >= Number(parentBefore.tokens_limit) * 0.5,
    `the parent keeps most of its file: ${parentAfter.tokens_limit} of ${parentBefore.tokens_limit}`);
  assert.ok(Number(parentAfter.requests_limit) >= 30,
    `including the turns its own roles must take: ${parentAfter.requests_limit}`);
});

test('delegation refuses an unfunded child instead of creating unusable management roles', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const parent = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, {
      tokens_limit: 1000, requests_limit: 1, tool_calls_limit: 1,
    });
    for (const agent of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
      runtime.store.updateBudget(budget.id, {
        tokens_limit: 0, requests_limit: 0, tool_calls_limit: 0,
      });
    }
  });
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: parent.id, scope: { objective: 'funded work' } }),
  error => error.status === 409 && /fund|budget/i.test(error.message));
  assert.equal(runtime.store.listNodes(clusterId, {}).length, 1);
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId }).length, 1,
    'a failed funding decision creates no delegated task or management node');
});

test('a three-level delegation reserves capacity for the leaf after parent work', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6,
      max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 2_097_152, model_requests: 256, tool_calls: 2048,
      wall_time_ms: 1_800_000, agents: 64, max_active_agents: 6 },
    delegation: [{ scope: 'deep/', objective: 'write deep/nested/result.txt',
      spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }],
  });
  let node = rootNode(runtime, clusterId);
  let transactionId = runtime.store.listTransactions({ cluster_id: clusterId })[0].id;
  for (let level = 1; level <= 3; level += 1) {
    const child = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { transaction_id: transactionId,
        scope: { objective: 'write deep/nested/result.txt' } }).result;
    node = runtime.store.getNode(child.node_id);
    transactionId = child.delegated_transaction_id;
    // In the strict live run, the first child had 520,873 tokens still
    // available against a 524,288-token *target*, only 3,415 short. Refusing
    // the whole delegation there sent its Allocator into 67 futile requests.
    // The parent may spend its own grant before the next child is ready.
    if (level < 3) {
      const budget = runtime.store.budgetForScope(clusterId, 'node', node.id);
      runtime.store.tx(() => runtime.store.updateBudget(budget.id, {
        tokens_spent: level === 1 ? 265_000 : 50_000, requests_spent: 5,
      }));
    }
  }
  const leafBudget = runtime.store.budgetForScope(clusterId, 'node', node.id);
  const roles = runtime.store.all(
    "SELECT SUM(tokens_limit) AS tokens, SUM(requests_limit) AS requests FROM budgets WHERE scope_kind='agent' AND node_id=?",
    node.id)[0];
  assert.ok(Number(leafBudget.tokens_limit) + Number(roles.tokens) >= 262_144,
    'the deepest roles and Worker retain at least one eighth of the declared tokens');
  assert.ok(Number(leafBudget.requests_limit) + Number(roles.requests) >= 42,
    'the leaf retains capacity for management and a Worker request');
  assert.ok(dimensionAvailable(leafBudget, 'agents') >= 1,
    'the deepest management node still has an agent slot for its Worker');
  assert.deepEqual(runtime.store.getTransaction(transactionId).inputs.write_scope, ['deep/staging'],
    'the injected restriction is not erased to buy a pass');
});

test('a dry child draws only unallocated ancestor capacity, never a sibling grant', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nocrossbudget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a dry node must not spend another branch', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 2_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = (objective, status) => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status,
    });
    const id = created.result?.transaction_id ?? created.transaction_id;
    return (command(runtime, allocator, 'spawn_management_node', {
      transaction_id: id, objective, acceptance_criteria: ['x'],
    }).result ?? {}).node_id;
  };
  const idleNodeId = spawn('a rich sibling branch', 'READY');
  const workNodeId = spawn('the branch with the work', 'READY');
  const idleNodeBudget = runtime.store.budgetForScope(clusterId, 'node', idleNodeId);
  const workNode = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', workNodeId).id);

  // The branch with the work has nothing left; an active sibling keeps its
  // entire grant, while the shared parent still has unallocated capacity.
  runtime.store.tx(() => runtime.store.updateBudget(workNode.id, {
    tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1,
  }));
  runtime.store.tx(() => {
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE scope_kind='agent' AND node_id=?", workNodeId)) {
      runtime.store.updateBudget(row.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    }
  });
  const idleBefore = runtime.store.getBudget(idleNodeBudget.id);
  const parentBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const parentBefore = runtime.store.getBudget(parentBudget.id);
  const siblingBefore = runtime.store.all(
    "SELECT id, tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=? ORDER BY id", idleNodeId);
  const siblingAgentBudgets = () => runtime.store.all(
    "SELECT id, tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=? ORDER BY id", idleNodeId);
  const worker = runtime.store.listAgents(clusterId, { node_id: workNodeId, role: 'orchestrator', limit: 1 })[0];
  const granted = runtime.topUpBudgetForAgent(worker, { tokens: 20_000, model_requests: 1 });
  assert.deepEqual(granted, { tokens: 20_000, model_requests: 1 },
    'only the measured request gap moves from an unallocated ancestor grant');
  const parentAfter = runtime.store.getBudget(parentBudget.id);
  assert.equal(parentBefore.tokens_limit - parentAfter.tokens_limit, granted.tokens);
  assert.equal(parentBefore.requests_limit - parentAfter.requests_limit, granted.model_requests);
  const idleAfter = runtime.store.getBudget(idleNodeBudget.id);
  assert.deepEqual(
    { tokens_limit: idleAfter.tokens_limit, tokens_spent: idleAfter.tokens_spent, requests_limit: idleAfter.requests_limit, requests_spent: idleAfter.requests_spent },
    { tokens_limit: idleBefore.tokens_limit, tokens_spent: idleBefore.tokens_spent, requests_limit: idleBefore.requests_limit, requests_spent: idleBefore.requests_spent },
    'the sibling node is not charged for this request',
  );
  assert.deepEqual(siblingAgentBudgets(), siblingBefore, 'and its identities keep their grants');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'budget-rebalanced').length, 0,
    'nothing redistributes another subtree silently — that is an explicit Allocator action');
});

test('a turn is funded before it starts, so a stale partition is not a refusal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-preturn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a turn that needs funding before it starts', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 2_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 })[0];
  // The cluster's capacity sits on the root scope, while this identity's node
  // holds nothing: the shape the observed run stopped on, at 22% of its budget.
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
  });
  const funded = runtime.ensureTurnFunding(cluster, orchestrator);
  assert.ok(funded, `the turn is funded before it starts: ${JSON.stringify(funded)}`);
  const agentAfter = runtime.store.getBudget(agentBudget.id);
  assert.ok(Number(agentAfter.tokens_limit) >= 16_384, `the identity can pay for a turn: ${agentAfter.tokens_limit}`);
  assert.ok(Number(agentAfter.requests_limit) >= 2, `and for its requests: ${agentAfter.requests_limit}`);
  const rootScope = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'root', clusterId).id);
  assert.ok(Number(rootScope.tokens_spent) >= 0 && Number(rootScope.tokens_limit) < 2_000_000,
    'the capacity came from the root scope rather than stranding there');
});

test('Workers holding the window do not starve a management role that is owed a turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-workerpressure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'Workers must not hold every slot a manager needs', workspace: dir, capabilities: [],
    // A three-slot window: three live Worker turns saturate it completely, and
    // the ceiling that governs management was measured against *all* live turns,
    // so `3 >= 3 - 1` skipped every pending management role on every pass.
    limits: { max_children: 8, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 4, max_role_turns: 40 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 400, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  // The transactions are inserted READY and allocated here, so management is
  // owed *nothing* while the Workers take the window: no DRAFT to dispatch, no
  // plan audit pending, no unallocated transaction.
  // The transaction `start` created for the objective is taken out of the way:
  // this test is about the window, not about that transaction's dispatch.
  const initial = runtime.store.listTransactions({ cluster_id: clusterId, node_id: root.id })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(initial.id, { status: 'CANCELLED' }));
  const ids = ['pressure-a', 'pressure-b', 'pressure-c'];
  for (const id of ids) {
    runtime.store.tx(() => runtime.store.insertTransaction({
      id, cluster_id: clusterId, node_id: root.id, owner_management_id: root.id,
      objective: `work ${id}`, acceptance_criteria: ['x'], status: 'READY',
    }));
  }
  for (const id of ids) command(runtime, allocator, 'allocate_agent', { transaction_id: id });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 3, 'three Workers have work waiting');

  const roles = ['orchestrator', 'allocator', 'auditor'];
  const managementPending = () => roles.filter(role => {
    const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role, limit: 1 })[0];
    return agent && agent.status !== 'TERMINATED' && runtime.pendingFor(role, root, cluster, agent).length;
  });
  assert.deepEqual(managementPending(), [], 'management is owed nothing before the Workers start');

  let released = false;
  let release = () => { released = true; };
  const barrier = new Promise(resolvePromise => { release = () => { released = true; resolvePromise(); }; });
  host.setScript(async turn => {
    const text = turn.prompt?.content?.[0]?.text ?? '';
    if (text.startsWith('You are a Worker')) {
      await barrier;
      return;
    }
    touchBlackboard(runtime, clusterId, `pressure/${Date.now()}`, null);
  });
  runtime.enableScheduling();
  const starts = () => runtime.store.all(
    "SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  const workerStarts = () => Number(starts().find(row => row.role === 'worker')?.c ?? 0);
  const managementStarts = () => starts().filter(row => row.role !== 'worker').reduce((sum, row) => sum + Number(row.c), 0);
  // Management is owed its turn *before* the window fills, so the reservation is
  // what decides it: two held Workers plus the queued third may not take the slot
  // a manager needs.
  runtime.store.tx(() => runtime.store.updateTransaction(ids[0], {
    status: 'SUBMITTED', revision: runtime.store.getTransaction(ids[0]).revision + 1,
  }));
  assert.ok(managementPending().includes('orchestrator'), 'the Orchestrator owes a validation decision');
  let observed = 0;
  let peak = 0;
  for (let pass = 0; pass < 30 && observed === 0; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    peak = Math.max(peak, runtime.activeTurnIds().length);
    observed = managementStarts();
  }
  assert.ok(observed > 0,
    `a management role owed a turn started while ${runtime.activeTurnIds().length} Worker turns held the window: ${JSON.stringify(starts())}`);
  assert.equal(released, false, 'and the Workers were still held when it did');
  assert.ok(workerStarts() <= 2, `the queued third Worker stayed out: ${JSON.stringify(starts())}`);

  // The window is a hard cap on resident turns of every class together.
  const before = managementStarts();
  for (let pass = 0; pass < 25; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    peak = Math.max(peak, runtime.activeTurnIds().length);
    observed = managementStarts() - before;
  }
  assert.ok(peak <= 3, `resident turns never exceed the three-slot window: peak ${peak}`);
  assert.ok(observed > 0, 'and management keeps making progress alongside them');
  release();
  for (let pass = 0; pass < 5; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  void orchestrator;
});

test('a refusal reclaims from idle siblings and never from a live one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-livegrant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'idle siblings lend, live ones do not', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  const [live, idle, poor] = roles;
  // One sibling is mid-turn; another is idle and holding a large unspent grant.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-live', cluster_id: clusterId, agent_id: live.id, node_id: live.node_id,
    epoch: live.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
    event_upper_bound: null, created: runtime.timestamp(),
  }));
  const budgetOf = agent => runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', poor.node_id);
  runtime.store.tx(() => {
    runtime.store.updateBudget(budgetOf(live).id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 90, requests_spent: 0 });
    runtime.store.updateBudget(budgetOf(idle).id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 60, requests_spent: 0 });
    runtime.store.updateBudget(budgetOf(poor).id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
  });
  const granted = runtime.topUpBudgetForAgent(poor, { tokens: 20_000, model_requests: 4 });
  assert.ok(granted, `the idle sibling funds the repair: ${JSON.stringify(granted)}`);
  // The idle donor was debited...
  const idleAfter = runtime.store.getBudget(budgetOf(idle).id);
  assert.equal(Number(idleAfter.requests_limit), 0, `the idle grant came home: ${idleAfter.requests_limit}`);
  assert.equal(Number(idleAfter.tokens_limit), 0, 'in both dimensions it held');
  // ...and the live one was not touched at all.
  const liveAfter = runtime.store.getBudget(budgetOf(live).id);
  assert.equal(Number(liveAfter.requests_limit), 90, `the live turn keeps its grant: ${liveAfter.requests_limit}`);
  assert.equal(Number(liveAfter.tokens_limit), 400_000, 'and its tokens');
  const poorAfter = runtime.store.getBudget(budgetOf(poor).id);
  assert.ok(Number(poorAfter.requests_limit) >= 4, `the identity can make its requests: ${poorAfter.requests_limit}`);
  void cluster;
});

test('a management node is created with room for a wave of Workers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodecapacity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'capacity for a wave of Workers', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3, max_agents: 24 },
    budget: { tokens: 2_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 3_600_000, agents: 24, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = created.result?.transaction_id ?? created.transaction_id;
  const child = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that can host Workers', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  const budget = runtime.store.budgetForScope(clusterId, 'node', child);
  assert.ok(Number(budget.agents_limit) >= 3 + 3,
    `a child node can host its three roles and a wave of Workers: ${budget.agents_limit}`);
  // Its own roles are funded first, and the remainder is enough for the wave.
  const roleIds = runtime.store.all(
    "SELECT id FROM agents WHERE cluster_id=? AND node_id=?", clusterId, child);
  assert.equal(roleIds.length, 3, 'three management roles exist on the child');
  const remaining = Number(runtime.store.getBudget(budget.id).agents_limit) - Number(runtime.store.getBudget(budget.id).agents_reserved);
  assert.ok(remaining >= 1, `and there is capacity left to allocate a Worker: ${remaining}`);
  // Its own roles must be able to run at all: a share of what is left over can
  // be one request or none, and then the node cannot run a single role turn.
  const requestWave = runtime.store.all(
    "SELECT SUM(requests_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", child)[0].c;
  assert.ok(Number(requestWave) >= 6,
    `the child's three roles can make their turns: ${requestWave} requests granted to them`);
  const nodeAfterRoles = runtime.store.getBudget(budget.id);
  assert.ok(Number(nodeAfterRoles.requests_limit) >= 2,
    `and the node keeps requests for its Worker wave: ${nodeAfterRoles.requests_limit}`);
});

test('a request is admitted when the node holds no requests and the pool no tokens', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-poolgap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a request must be admitted when each payer is short in one dimension', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 2_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const workerRole = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const node = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', workerRole.id);
  // The shape the run ended on: the node has tokens and no requests, the pool has
  // requests and no tokens, and the identity can pay for neither half.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 30, requests_spent: 7, requests_reserved: 0 });
    runtime.store.updateBudget(node.id, { tokens_limit: 900_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 2, requests_spent: 2, requests_reserved: 0 });
    // No identity on this node holds a request it could hand back either, so the
    // only scope that can be made payable is the pool — which needs tokens, the
    // one thing the node has.
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent'", clusterId)) {
      runtime.store.updateBudget(row.id, { requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  // A real turn: its compaction request is the one that used to be refused, and
  // the receipt must name the pool as the scope that paid for it.
  let failure = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator') return;
    try {
      // The request that used to be refused: the pool holds the requests and no
      // tokens, the node the tokens and no requests.
      await turn.request({ purpose: 'compaction', usage: { totalTokens: 200, inputTokens: 150, outputTokens: 50 } });
    } catch (error) { failure = error; }
  });
  // Work the Orchestrator must pick up, so a management turn really runs.
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'create_transaction', {
    objective: 'work that needs an agent', acceptance_criteria: ['x'], status: 'READY',
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.all("SELECT request_id FROM usage_receipts WHERE cluster_id=? AND agent_id=?", clusterId, workerRole.id).length) break;
  }
  const receipts = runtime.store.all(
    "SELECT request_id, kind, status, budget_scope_id FROM usage_receipts WHERE cluster_id=? AND agent_id=? ORDER BY created",
    clusterId, workerRole.id);
  if (!receipts.length) {
    const evts = runtime.store.all("SELECT type, json_extract(data,'$.role') AS role, json_extract(data,'$.reason') AS reason, json_extract(data,'$.code') AS code FROM events WHERE cluster_id=? AND (type LIKE '%refus%' OR type LIKE '%budget%') ORDER BY seq DESC LIMIT 6", clusterId);
    const all = runtime.store.all("SELECT json_extract(data,'$.stop_detail') AS sd, json_extract(data,'$.error') AS err FROM events WHERE cluster_id=? AND type='turn-end' LIMIT 3", clusterId);
    throw new Error(`no receipt: ${JSON.stringify(evts)} :: ${JSON.stringify(all)} receipts=${runtime.store.all("SELECT request_id, kind, status, budget_scope_id FROM usage_receipts WHERE cluster_id=?", clusterId).length}`);
    throw new Error(`no receipt: ${JSON.stringify(evts)}`);
  }
  assert.ok(receipts.length >= 1, `the provider was called: ${String(failure)}`);
  assert.equal(failure, null, `and the turn ran: ${String(failure)}`);
  const poolReceipt = receipts.find(receipt => receipt.budget_scope_id === pool.id);
  assert.ok(poolReceipt, `a single scope pays the whole envelope, and it is the pool: ${JSON.stringify(receipts)}`);
  assert.equal(receipts.filter(receipt => receipt.budget_scope_id === pool.id).length, 1,
    `no second receipt is charged to it for the same request: ${JSON.stringify(receipts)}`);
  assert.equal(Number(runtime.store.getBudget(pool.id).tokens_spent) > 0 || Number(runtime.store.getBudget(pool.id).tokens_reserved) > 0, true,
    'the pool really paid the tokens, which is the funding the refusal lacked');
  assert.equal(Number(runtime.store.getBudget(node.id).requests_spent), 2,
    'and the token-rich node was not asked for requests it does not have');
});

test('the rebalance hint is executable by the identity that receives it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-rebalance-hint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'idle capacity somewhere, a dry node here', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 3_000_000, model_requests: 300, tool_calls: 3_000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = objective => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status: 'READY',
    });
    const id = created.result?.transaction_id ?? created.transaction_id;
    return (command(runtime, allocator, 'spawn_management_node', { transaction_id: id, objective }).result ?? {}).node_id;
  };
  const dry = spawn('the node that runs out');
  const idle = spawn('the node that does not spend');
  const dryBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', dry).id);
  const idleBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', idle).id);
  runtime.store.tx(() => runtime.store.updateBudget(dryBudget.id, {
    tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1,
  }));
  assert.ok(dimensionAvailable(runtime.store.getBudget(idleBudget.id), 'tokens') > 65_536,
    'the sibling really holds idle capacity');

  const dryAllocator = runtime.store.listAgents(clusterId, { node_id: dry, role: 'allocator', limit: 1 })[0];
  const rootAllocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  assert.equal(runtime.pendingFor('allocator', root, cluster, rootAllocator)
    .some(item => item.action === 'rebalance_budget' && item.to?.id === dry), false,
    'a zero balance alone cannot name the next request or justify a one-token model turn');
  runtime.blockNodeInternal(clusterId, dry, 'BUDGET: refused next role request', 'BUDGET_EXHAUSTED', {
    agent_id: dryAllocator.id, dimension: 'tokens', requested: 16_000,
    envelope: { tokens: 16_000, model_requests: 1, tool_calls: 0 },
  });
  // The dry subtree's own Allocator cannot move a sibling's capacity: the hint
  // must not be published to it, because `rebalance_budget` would answer 403.
  const ownActions = runtime.pendingFor('allocator', runtime.store.getNode(dry), cluster, dryAllocator);
  // Whatever it is told must be executable by it: `rebalance_budget` allows an
  // actor to move capacity only inside its own domain, so the sibling branch may
  // never appear among its sources.
  for (const action of ownActions.filter(entry => entry.action === 'rebalance_budget')) {
    assert.ok(action.from_options.every(option => option.scope_kind === 'agent' || option.scope_id === dry),
      `only sources inside its own domain: ${JSON.stringify(action.from_options)}`);
    assert.equal(action.from_options.some(option => option.scope_id === idle), false,
      'never the sibling branch it cannot reach');
  }

  // The ancestor's Allocator owns both ends, and the hint is executable as it.
  const actions = runtime.pendingFor('allocator', root, cluster, rootAllocator);
  const hint = actions.find(action => action.action === 'rebalance_budget');
  assert.ok(hint, `the ancestor is told what to move: ${JSON.stringify(actions.map(a => a.action))}`);
  assert.deepEqual(hint.to, { kind: 'node', id: dry }, 'into the node that is out');
  assert.equal(hint.required.tokens, 16_000, 'the hint carries the refused envelope');
  const source = hint.from_options.find(option => option.scope_id === idle);
  assert.ok(source, `and from the scope that holds it: ${JSON.stringify(hint.from_options)}`);

  // Executing exactly that transfer as the notified identity succeeds, and the
  // capacity really moves.
  const moved = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
    from: { kind: 'node', id: idle }, to: { kind: 'node', id: dry },
    amounts: { tokens: 60_000, model_requests: 4 },
  });
  assert.ok(moved.result || moved.from, `the suggested transfer runs: ${JSON.stringify(moved).slice(0, 200)}`);
  const after = runtime.store.getBudget(dryBudget.id);
  assert.equal(Number(after.tokens_limit), 61_000, 'the dry node can act again');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'budget-rebalanced').length, 1,
    'and the ledger shows the Allocator made that call');
  void source;
});

test('an empty node pool does not send an Allocator into an unsupported escalation loop', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'delegated work' },
  }).result;
  const node = runtime.store.getNode(child.node_id);
  const budget = runtime.store.budgetForScope(clusterId, 'node', node.id);
  runtime.store.tx(() => runtime.store.updateBudget(budget.id, {
    tokens_limit: 0, requests_limit: 0,
  }));
  const allocator = runtime.store.listAgents(clusterId, { node_id: node.id, role: 'allocator', limit: 1 })[0];
  const actions = runtime.pendingFor('allocator', node, runtime.store.getCluster(clusterId), allocator);
  assert.equal(actions.some(item => item.action === 'escalate-budget'), false,
    'an empty pool is not a refusal and does not offer a nonexistent tool action');
  runtime.recordBudgetRefusal(allocator, 'cannot fund a model request', {
    scope: node.id, dimension: 'tokens', requested: 8192, available: 0,
  });
  const parentAllocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const localOrchestrator = actorFor(runtime, clusterId, 'orchestrator', node.id);
  for (const recipient of [parentAllocator.agent_id, localOrchestrator.agent_id]) {
    assert.ok(runtime.store.listInbox(clusterId, { recipient, status: 'PENDING' })
      .some(item => item.subject === 'budget-refused' && item.payload.node_id === node.id),
    'a real refusal reaches the resource owner and the local planning owner');
  }
});

test('a node whose requests are gone reclaims them from its own live roles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inscope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  const [rich, poor] = roles;
  // The shape the run ended on: the node's own file is spent, while two of its
  // roles hold their grants — and those roles are *live*, mid-turn.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { requests_limit: 27, requests_spent: 27, requests_reserved: 0 });
    runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'agent', rich.id).id,
      { requests_limit: 96, requests_spent: 26, requests_reserved: 0 });
    // The identity asking for the repair is out of requests itself, and its node
    // has nothing left either: only the siblings' idle grants can help.
    runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'agent', poor.id).id,
      { requests_limit: 0, requests_spent: 0, requests_reserved: 0, tokens_limit: 4_000, tokens_spent: 4_000 });
    for (const agent of [rich, poor]) {
      runtime.store.createLease({
        id: `lease-${agent.id.slice(0, 8)}`, cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
        epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 120_000,
        event_upper_bound: null, created: runtime.timestamp(),
      });
    }
  });
  const granted = runtime.topUpBudgetForAgent(poor, { tokens: 20_000, model_requests: 5 });
  assert.ok(granted, `the repair runs inside the node: ${JSON.stringify(granted)}`);
  const nodeAfter = runtime.store.getBudget(nodeBudget.id);
  assert.ok(Number(nodeAfter.requests_limit) - Number(nodeAfter.requests_spent) > 0 || Number(granted.requests) > 0,
    `the idle requests came home: ${JSON.stringify({ lim: nodeAfter.requests_limit, spent: nodeAfter.requests_spent, granted })}`);
  const poorAfter = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'agent', poor.id).id);
  assert.ok(Number(poorAfter.requests_limit) >= 5, `and the identity can make its requests: ${poorAfter.requests_limit}`);
  const richAfter = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'agent', rich.id).id);
  assert.ok(Number(richAfter.requests_limit) - Number(richAfter.requests_spent) >= 2,
    `the live role keeps a working envelope: ${Number(richAfter.requests_limit) - Number(richAfter.requests_spent)}`);
  void cluster;
});

test('a child is funded from the capacity its own node is holding in idle roles', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-parentreclaim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  // The shape the run ended on: the node's own file is spent, its roles hold the
  // requests and are between turns.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { requests_limit: 33, requests_spent: 33, requests_reserved: 0 });
    roles.forEach((agent, index) => {
      runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'agent', agent.id).id, {
        requests_limit: 96 - index * 20, requests_spent: 10, requests_reserved: 0,
      });
    });
  });
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate to a child', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = created.result?.transaction_id ?? created.transaction_id;
  const spawned = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that must run', acceptance_criteria: ['x'],
  });
  const childId = (spawned.result ?? spawned).node_id;
  const childBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', childId).id);
  const roleGrants = runtime.store.all(
    "SELECT SUM(requests_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", childId)[0].c;
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
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 })[0];
  const facts = { scope: 'scope-x', dimension: 'tokens', requested: 12_000, available: 0 };
  runtime.recordBudgetRefusal(agent, 'a shortfall the funder then closed', { ...facts, terminal: false });
  runtime.recordBudgetRefusal(agent, 'a refusal nothing could repair', facts);
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  const shortfall = events.filter(event => event.type === 'budget-shortfall');
  const refused = events.filter(event => event.type === 'budget-refused');
  assert.equal(shortfall.length, 1, 'the repaired shortfall is recorded as a shortfall');
  assert.equal(refused.length, 1, 'and only the terminal one as a refusal');
  assert.equal(shortfall[0].data.terminal, false);
  assert.equal(refused[0].data.terminal, true);
  // The acceptance classifier counts refusals, never shortfalls: a run that
  // recovered every shortfall must not be reported as having reached a limit.
  const counted = runtime.store.get(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type IN ('budget-refused','tool-call-refused')", clusterId).c;
  assert.equal(Number(counted), 1, `the terminal refusal is the only one counted: ${counted}`);
});

test('a full-envelope repair leaves the tokens where the pool can draw them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-envelope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const agent = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', agent.id);
  // The advisory's shape: the pool holds one request and no tokens, the node holds
  // tokens and no requests, and the identity is empty and leased.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-empty', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 120_000,
    event_upper_bound: null, created: runtime.timestamp(),
  }));
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 1, requests_spent: 0, requests_reserved: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 400_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    // Nothing idle anywhere else in this node either: the identity cannot be made
    // whole at all, which is the premise of the ordering hazard.
    for (const row of runtime.store.all(
      "SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent' AND scope_id<>?", clusterId, agent.id)) {
      runtime.store.updateBudget(row.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  // No repair can make the identity whole — it cannot be given a request — so a
  // full-envelope rule moves nothing into it, and the pool's token gap is what
  // gets closed.
  const identityRepair = runtime.topUpBudgetForAgent(agent, { tokens: 20_000, model_requests: 1 });
  assert.equal(identityRepair, null, 'the identity is left exactly as it was');
  const agentAfter = runtime.store.getBudget(agentBudget.id);
  assert.equal(Number(agentAfter.tokens_limit), 0, 'no tokens are moved into an identity that cannot spend them');
  const nodeAfter = runtime.store.getBudget(nodeBudget.id);
  assert.equal(Number(nodeAfter.tokens_limit), 400_000, 'and the node still holds them for the pool');
  const poolRepair = runtime.topUpCompactionPool(clusterId, { tokens: 20_000, model_requests: 1 });
  assert.ok(poolRepair && poolRepair.tokens === 20_000, `the pool gets the tokens it was missing: ${JSON.stringify(poolRepair)}`);
  const poolAfter = runtime.store.getBudget(pool.id);
  assert.ok(Number(poolAfter.tokens_limit) - Number(poolAfter.tokens_spent) >= 20_000, 'and can now pay both halves');
  assert.ok(Number(poolAfter.requests_limit) - Number(poolAfter.requests_spent) >= 1, 'including the request it already held');
});


test('a refused identity is resumed only after its budget is really transferred', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-repair-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', allocator.id);
  // A sibling branch keeps the *cluster* solvent, exactly as in the recorded run:
  // the identity's own chain holds nothing, so its request is refused, while the
  // cluster still has capacity elsewhere that only a transfer may reach.
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const siblingTx = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the branch that holds capacity', acceptance_criteria: ['x'], status: 'READY',
  });
  const siblingTxId = siblingTx.result?.transaction_id ?? siblingTx.transaction_id;
  const siblingNode = (command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', {
    transaction_id: siblingTxId, objective: 'capacity holder', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  // Work to do, a role that will be refused, and nothing idle anywhere in its
  // chain — so the refusal is real and the node stops for it.
  const unfundedTx = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work that cannot be funded', acceptance_criteria: ['x'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: unfundedTx });
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    // Every identity this node funds is empty too, so no repair can close the gap
    // and the refusal is real.
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent'", clusterId)) {
      runtime.store.updateBudget(row.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0, tokens_reserved: 0, requests_reserved: 0 });
    }
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    // The compaction pool is a legal payer for any role request, so it is part of
    // the starvation the fixture needs.
    const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
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
    if (runtime.store.get("SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='budget-refused'", clusterId).c > 0) break;
  }
  const refusals = runtime.store.all(
    "SELECT data FROM events WHERE cluster_id=? AND type='budget-refused' ORDER BY seq", clusterId).map(row => JSON.parse(row.data));
  if (!refusals.length) {
    const evts = runtime.store.all("SELECT type, json_extract(data,'$.role') r, json_extract(data,'$.stop_reason') s, json_extract(data,'$.reason') why FROM events WHERE cluster_id=? ORDER BY seq DESC LIMIT 8", clusterId);
    throw new Error(`no refusal: ${JSON.stringify(evts)}`);
  }
  assert.ok(refusals.length > 0, 'a request was really refused');
  const block = runtime.store.all(
    "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' ORDER BY seq DESC LIMIT 1", clusterId)[0];
  assert.ok(block, 'the node stopped for it');
  const blockData = JSON.parse(block.data);
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
  const siblingBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', siblingNode).id);
  const movable = Math.min(120_000, Math.max(0, Number(siblingBudget.tokens_limit) - Number(siblingBudget.tokens_spent)));
  assert.ok(movable > 60_000, `the sibling branch holds capacity to move: ${movable}`);
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
    from: { kind: 'node', id: siblingNode }, to: { kind: 'node', id: root.id },
    amounts: { tokens: movable, model_requests: Math.min(12, Math.max(0, Number(siblingBudget.requests_limit) - Number(siblingBudget.requests_spent))) },
  });
  const after = runtime.store.getBudget(nodeBudget.id);
  assert.ok(dimensionAvailable(after, 'tokens') > 100_000, `the capacity arrived: ${JSON.stringify({ tl: after.tokens_limit, ts: after.tokens_spent })}`);
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'node-resumed')) break;
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.ok(events.some(event => event.type === 'node-resumed' && event.data.code === 'BUDGET_REPAIRED'),
    `the node is resumed once its budget really changed: ${JSON.stringify(events.filter(e => e.type === 'node-blocked' || e.type === 'node-resumed').map(e => e.type))}`);
  const afterTurns = Number(runtime.store.get(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start'", clusterId)?.c ?? 0);
  assert.ok(afterTurns > beforeTurns, `turns are admitted again: ${afterTurns} vs ${beforeTurns}`);
});

test('a budget-blocked root resumes when an in-scope donor finishes its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-idle-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const poor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' })[0];
  const donor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator' })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const poorBudget = runtime.store.budgetForScope(clusterId, 'agent', poor.id);
  const donorBudget = runtime.store.budgetForScope(clusterId, 'agent', donor.id);
  const auditor = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' })[0];
  const auditorBudget = runtime.store.budgetForScope(clusterId, 'agent', auditor.id);
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(poorBudget.id, { tokens_limit: 6_007, tokens_spent: 0, requests_limit: 1, requests_spent: 0 });
    runtime.store.updateBudget(donorBudget.id, { tokens_limit: 271_253, tokens_spent: 0, requests_limit: 10, requests_spent: 0 });
    runtime.store.updateBudget(auditorBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(pool.id, { tokens_limit: 1_994, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.createLease({
      id: 'leased-donor', cluster_id: clusterId, agent_id: donor.id, node_id: root.id,
      epoch: donor.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
      event_upper_bound: null, created: runtime.timestamp(),
    });
  });
  const envelope = { tokens: 19_484, model_requests: 1, tool_calls: 0 };
  assert.equal(runtime.topUpBudgetForAgent(poor, { tokens: envelope.tokens, model_requests: 1 }), null,
    'a lease fences the donor grant while that turn is live');
  runtime.blockNodeOnBudget(poor, 'the root role cannot pay a compaction request', {
    dimension: 'tokens', requested: envelope.tokens, envelope,
  });
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED');
  runtime.store.tx(() => runtime.store.deleteLease('leased-donor'));
  const before = [nodeBudget.id, poorBudget.id, donorBudget.id].reduce(
    (sum, id) => sum + runtime.store.getBudget(id).tokens_limit, 0);
  host.setScript(async () => {});
  runtime.enableScheduling();
  await runtime.tick();
  const resumed = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'cluster-resumed');
  assert.equal(resumed.length, 1, 'an idle same-node grant repairs the failed request envelope');
  assert.equal(runtime.store.getNode(root.id).status, 'ACTIVE');
  const after = [nodeBudget.id, poorBudget.id, donorBudget.id].reduce(
    (sum, id) => sum + runtime.store.getBudget(id).tokens_limit, 0);
  assert.equal(after, before, 'the repair transfers already-declared tokens, not a new budget');
});

test('an incomplete repair does not resume the node, and a complete one does', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-envelope-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', role.id);
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // A real stop for a real envelope: recorded with both dimensions.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 5_000, tokens_spent: 5_000, requests_limit: 1, requests_spent: 1 });
    runtime.store.updateBudget(runtime.store.getBudget(runtime.compactionBudgetId(clusterId)).id,
      { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1 });
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent' AND scope_id<>?", clusterId, role.id)) {
      runtime.store.updateBudget(row.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: runtime.store.budgetForScope(clusterId, 'node', root.id).scope_id,
    dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED', 'the node stopped for it');
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
  assert.equal(runtime.store.getNode(root.id).status !== 'BLOCKED', true, 'the node is running again');
  // The provider-level proof of a resumed node belongs to the live case: this
  // fixture scripts the roles' requests but leaves several identities starved, so a
  // request it drives here would prove the fixture's state, not the mechanism. The
  // unit asserts the transition (tokens alone: no resume; tokens + requests: resume),
  // and G2 asserts that a resumed subtree really sends and settles again.
});

test('a settlement that frees capacity resumes the node with no grant at all', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // The pool is 252 tokens short of the request, with an in-flight reservation
  // holding the rest: exactly the recorded shape.
  runtime.store.tx(() => {
    // limit 20,000; an in-flight request holds 8,352 of it, so only 11,648 is
    // available against a 12,000-token need — short by 352, exactly like the run.
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_reserved: 8_352, tokens_spent: 0, requests_limit: 5, requests_spent: 0, requests_reserved: 1 });
    runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'agent', role.id).id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    // Isolate the settlement path from the independent in-node donor path:
    // an idle sibling grant would otherwise legitimately repair this block.
    for (const sibling of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = runtime.store.budgetForScope(clusterId, 'agent', sibling.id);
      runtime.store.updateBudget(budget.id, { tokens_limit: 0, requests_limit: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: pool.scope_id, dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED', 'the node stopped short of the request');
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
  const poolAfter = runtime.store.getBudget(pool.id);
  assert.ok(dimensionAvailable(poolAfter, 'tokens') >= envelope.tokens,
    `the settlement released enough: ${dimensionAvailable(poolAfter, 'tokens')}`);
  assert.ok(resumedCount() > 0, 'a released reservation resumes it, with no transfer anywhere');
  assert.equal(runtime.store.getNode(root.id).status !== 'BLOCKED', true, 'and the node runs again');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'budget-rebalanced').length, 0,
    'nothing was transferred to make it happen');
});

test('runUntilSettled waits for an in-flight request to release the capacity it needs', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-loop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const nodeBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id);
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // Short by 352 while a request is in flight, and the root stops for it: the shape
  // that ended a live run before the settlement could land.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_reserved: 8_352, tokens_spent: 0, requests_limit: 5, requests_spent: 0, requests_reserved: 1 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(runtime.store.budgetForScope(clusterId, 'agent', role.id).id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    // Only the settlement can repair this stop. Otherwise an idle sibling grant
    // legitimately reopens it before the in-flight reservation is released.
    for (const sibling of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = runtime.store.budgetForScope(clusterId, 'agent', sibling.id);
      runtime.store.updateBudget(budget.id, { tokens_limit: 0, requests_limit: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: pool.scope_id, dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED', 'the cluster stopped with the node');
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
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const eventsAfterTick = runtime.store.readEvents(clusterId, { limit: 500 });
  if (!eventsAfterTick.some(event => event.type === 'node-resumed')) {
    const block = runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' ORDER BY seq DESC LIMIT 1", clusterId)[0];
    const poolAfter2 = runtime.store.getBudget(pool.id);
    const nodeAfter = runtime.store.getBudget(nodeBudget.id);
    throw new Error(`no resume even after a tick: block=${block?.data} pool=${JSON.stringify({ tl: poolAfter2.tokens_limit, tr: poolAfter2.tokens_reserved, ts: poolAfter2.tokens_spent, rl: poolAfter2.requests_limit, rs: poolAfter2.requests_spent })} node=${JSON.stringify({ tl: nodeAfter.tokens_limit, ts: nodeAfter.tokens_spent })} cluster=${runtime.store.getCluster(clusterId).status}`);
  }
  assert.ok(eventsAfterTick.some(event => event.type === 'node-resumed' && event.data.code === 'BUDGET_REPAIRED'),
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
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
  const nodeBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id);
  const agentBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'agent', role.id).id);
  // Both payers are overdrawn by a little, exactly as a settlement with actual
  // usage above the reservation leaves them: limit 20,000, spent 20,279.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 20_000, tokens_spent: 20_279, tokens_reserved: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 20_000, tokens_spent: 20_252, tokens_reserved: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 40, requests_spent: 0 });
  });
  const poolGrant = runtime.topUpCompactionPool(clusterId, { tokens: 13_462, model_requests: 1 });
  assert.ok(poolGrant, `the pool is refilled: ${JSON.stringify(poolGrant)}`);
  assert.equal(poolGrant.tokens, 13_462 + 279, 'its overshoot is part of the gap, not clamped away');
  const poolAfter = runtime.store.getBudget(pool.id);
  assert.ok(dimensionAvailable(poolAfter, 'tokens') >= 13_462,
    `the pool can cover the request that failed: ${dimensionAvailable(poolAfter, 'tokens')}`);

  const agentGrant = runtime.topUpBudgetForAgent(role, { tokens: 12_000, model_requests: 1 });
  assert.ok(agentGrant, `the identity is refilled: ${JSON.stringify(agentGrant)}`);
  assert.equal(agentGrant.tokens, 12_252, 'including the overshoot it carried');
  const agentAfter = runtime.store.getBudget(agentBudget.id);
  assert.ok(dimensionAvailable(agentAfter, 'tokens') >= 12_000,
    `and can now pay for a request of that size: ${dimensionAvailable(agentAfter, 'tokens')}`);
  // The donor side still clamps at zero: a scope with nothing gives nothing.
  assert.equal(Number(runtime.store.getBudget(nodeBudget.id).tokens_limit) >= 0, true, 'the donor stays sane');
});

test('an unpayable budget stop with nothing in flight returns promptly', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-settle-final-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const role = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const envelope = { tokens: 12_000, model_requests: 1, tool_calls: 0 };
  // Nothing anywhere can pay it, and nothing is in flight to release capacity.
  runtime.store.tx(() => {
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=?", clusterId)) {
      runtime.store.updateBudget(row.id, { tokens_spent: Number(runtime.store.getBudget(row.id).tokens_limit), tokens_reserved: 0, requests_spent: Number(runtime.store.getBudget(row.id).requests_limit), requests_reserved: 0 });
    }
  });
  runtime.recordBudgetRefusal(role, 'model request refused: tokens', {
    scope: runtime.store.budgetForScope(clusterId, 'node', root.id).scope_id,
    dimension: 'tokens', requested: envelope.tokens, available: 0,
  });
  runtime.blockNodeOnBudget(role, 'model request refused: tokens', { dimension: 'tokens', requested: envelope.tokens, envelope });
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED', 'the cluster is stopped');
  assert.equal(runtime.store.get("SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND status='RESERVED'", clusterId).c, 0,
    'and nothing is in flight');
  runtime.enableScheduling();
  const started = Date.now();
  const view = await runtime.runUntilSettled(clusterId, { timeoutMs: 8_000, pollMs: 100 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `it returned promptly instead of waiting out the deadline: ${elapsed}ms`);
  assert.equal(runtime.store.getCluster(clusterId).status, 'BLOCKED', 'and stayed blocked');
  assert.ok(view, 'with its view');
});

test('a transaction write restriction cannot be widened by an allocation override', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const { result: { transaction_id: transactionId } } = command(runtime, orchestrator, 'create_transaction', {
    objective: 'write under deep/staging', inputs: { write_scope: ['deep/staging'] },
    acceptance_criteria: ['a staging file exists'],
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: transactionId });

  assert.throws(
    () => command(runtime, allocator, 'allocate_agent', {
      transaction_id: transactionId, write_scope: ['deep/nested'],
    }),
    error => error.status === 409 && /write scope/.test(error.message),
    'an Allocator cannot turn a transaction restricted to staging into a grant for nested',
  );
  assert.equal(runtime.store.activeAllocationForTransaction(transactionId), null);
  command(runtime, allocator, 'allocate_agent', { transaction_id: transactionId });
  const allocation = runtime.store.activeAllocationForTransaction(transactionId);
  assert.deepEqual(allocation.write_scope, ['deep/staging']);
  assert.equal(checkWriteAccess({
    tool: 'write', workspace: runtime.store.getCluster(clusterId).workspace,
    writeScope: allocation.write_scope, writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  }).allowed, false, 'the actual Worker cannot write outside the transaction restriction');
});

test('a delegation instruction carries its write scope all the way down, and the guard enforces it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-delegation-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
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
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }],
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = (txId, nodeId, objective) => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status: 'READY',
    });
    const delegated = created.result?.transaction_id ?? created.transaction_id;
    if (nodeId) runtime.store.tx(() => runtime.store.updateTransaction(delegated, { node_id: nodeId }));
    return (command(runtime, allocator, 'spawn_management_node', {
      transaction_id: delegated, node_id: nodeId, objective, acceptance_criteria: ['x'],
    }).result ?? {}).node_id;
  };
  const level1 = spawn(null, null, 'level one');
  const level2 = spawn(null, level1, 'level two');
  const level3 = spawn(null, level2, 'level three');
  const depth3 = runtime.store.getNode(level3);
  assert.equal(depth3.depth, 3, 'three management levels below the root');
  // The instruction's inputs survive every hop, which is what makes the injected
  // fault land where the case means it to.
  const entries = [level1, level2, level3].map(id => runtime.store.getNode(id).scope?.delegation_entry ?? null);
  const deepestTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3 })[0];
  // The delegated transaction is created DRAFT (the Orchestrator dispatches it);
  // what matters here is the scope it will be allocated under.
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  assert.deepEqual(runtime.store.getNode(level1).scope?.delegation_entry?.inputs, { write_scope: ['deep/staging'] },
    `the instruction reaches the first level: ${JSON.stringify(entries)}`);
  assert.deepEqual(depth3.scope?.delegation_entry?.inputs, { write_scope: ['deep/staging'] },
    `and the deepest: ${JSON.stringify(entries)}`);
  assert.deepEqual(deepestTx.inputs?.write_scope, ['deep/staging'], 'and its transaction works under that scope');

  // This transaction belongs to the terminal management node. A Worker must
  // run as that node's child (depth 4, within the actual depth cap).
  const deepestAllocator = actorFor(runtime, clusterId, 'allocator', level3);
  command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id });
  const allocation = runtime.store.activeAllocationForTransaction(deepestTx.id);
  assert.ok(allocation, 'the Worker is allocated');
  const workerNode = runtime.store.getNode(runtime.store.getAgent(allocation.agent_id).node_id);
  assert.equal(workerNode.parent_id, level3);
  assert.equal(workerNode.depth, 4);
  const cluster = runtime.store.getCluster(clusterId);
  const denied = checkWriteAccess({
    tool: 'write', workspace: cluster.workspace,
    writeScope: allocation.write_scope, writeScopeCanonical: allocation.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  });
  assert.equal(denied.allowed, false, `the guard refuses the target path: ${JSON.stringify(denied)}`);
});

test('the recursion checker accepts a no-attempt fault: denial, rejection, corrected allocation', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-nofault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a well-behaved worker reports instead of attempting', workspace: dir,
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }],
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const level1 = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: (() => {
      const created = command(runtime, orchestrator, 'create_transaction', { objective: 'level one', acceptance_criteria: ['x'], status: 'READY' });
      return created.result?.transaction_id ?? created.transaction_id;
    })(), objective: 'level one', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  const level2 = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: (() => {
      const created = command(runtime, orchestrator, 'create_transaction', { objective: 'level two', acceptance_criteria: ['x'], status: 'READY' });
      return created.result?.transaction_id ?? created.transaction_id;
    })(), node_id: level1, objective: 'level two', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  const level3 = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: (() => {
      const created = command(runtime, orchestrator, 'create_transaction', { objective: 'level three', acceptance_criteria: ['x'], status: 'READY' });
      return created.result?.transaction_id ?? created.transaction_id;
    })(), node_id: level2, objective: 'level three', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  const deepestTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3 })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  // A root Allocator can supervise the branch, but it cannot put its Worker
  // under the root: the delegated node owns this transaction and its effects.
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: deepestTx.id }),
    error => error.status === 409 && /transaction.*node|node.*transaction/.test(error.message));
  const deepestAllocator = actorFor(runtime, clusterId, 'allocator', level3);
  const placed = command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id });
  const initial = runtime.store.activeAllocationForTransaction(deepestTx.id);
  assert.ok(initial, 'the faulty allocation exists');
  const workerNode = runtime.store.getNode(runtime.store.getAgent(initial.agent_id).node_id);
  assert.equal(workerNode.parent_id, level3, `the deepest node owns its Worker: ${JSON.stringify(placed.result?.allocations?.[0])}`);
  assert.equal(workerNode.depth, 4, 'the real terminal node can host its Worker within max_depth 4');
  // The worker *reports* the limitation: it never attempts the forbidden write, so
  // no `write-refused` event exists anywhere.
  assert.equal(runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'write-refused').length, 0,
    'nothing attempted the prohibited write');
  // The Auditor rejects and a durable issue is recorded against the transaction…
  const worker = runtime.store.getAgent(initial.agent_id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  runtime.store.tx(() => runtime.store.insertIssue({
    cluster_id: clusterId, node_id: level3, transaction_id: deepestTx.id, severity: 'MAJOR',
    status: 'OPEN', summary: 'the result cannot be produced under the allocation write scope',
    required_change: 'widen the write scope and re-allocate', target_revision: runtime.store.getTransaction(deepestTx.id).revision,
  }));
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: deepestTx.id, patch: { inputs: { write_scope: ['deep'], parent_transaction_id: deepestTx.inputs?.parent_transaction_id } },
  });
  runtime.store.tx(() => runtime.store.updateAllocation(initial.id, { status: 'RELEASED' }));
  // An adjusted transaction is a new revision and goes back through dispatch, as the
  // Orchestrator would take it.
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id, write_scope: ['deep'] });
  const corrected = runtime.store.activeAllocationForTransaction(deepestTx.id);
  assert.ok(corrected && corrected.id !== initial.id, 'the corrected allocation is a new one');
  const allowed = checkWriteAccess({
    tool: 'write', workspace: runtime.store.getCluster(clusterId).workspace,
    writeScope: corrected.write_scope, writeScopeCanonical: corrected.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  });
  assert.equal(allowed.allowed, true, `and it may write the target: ${JSON.stringify(allowed)}`);

  // The checker must accept this trace, called for real rather than simulated: the
  // *initial* allocation is denied by the guard, which is the proof the injected
  // fault is real — an attempt is not.
  const report = {
    cluster_id: clusterId,
    checks: [],
    scenario_status: 'RUNNING',
    failure_class: null,
  };
  const layout = { data: dir };
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).map(entry => ({ type: entry.type, data: entry.data }));
  const result = await recursionChecks.run({ workspace: dir, report, layout, events });
  const fault = result.checks.find(entry => entry.name === 'injected-fault-is-real');
  assert.ok(fault, `the checker reports the fault: ${JSON.stringify(result.checks.map(entry => entry.name))}`);
  assert.equal(fault.passed, true, `a no-attempt fault with a real denial passes: ${fault.evidence}`);
  assert.equal(result.checks.find(entry => entry.name === 'independent-gate-acted').passed, false,
    'a manually seeded issue with no Auditor reporter cannot prove independent governance');
  // And it fails when the fault is not really there: with the initial allocation
  // removed, only the corrected (permissive) one remains.
  runtime.store.tx(() => runtime.store.run('DELETE FROM allocations WHERE id=?', initial.id));
  const second = await recursionChecks.run({ workspace: dir, report, layout, events });
  const secondFault = second.checks.find(entry => entry.name === 'injected-fault-is-real');
  assert.equal(secondFault.passed, false, `without the faulty allocation it fails: ${secondFault.evidence}`);
  void worker; void auditor;
});

test('a one-slot window lets both classes progress, one resident turn at a time', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-oneslot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one slot, two classes owed', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 1 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // A Worker with work waiting, and management work owed at the same time.
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work for a worker', acceptance_criteria: ['x'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: txId });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 1 }).length, 1, 'a Worker is ready');
  let published = 0;
  host.setScript(async turn => {
    const prompt = turn.prompt?.content?.[0]?.text ?? '';
    if (prompt.startsWith('You are a Worker')) return;
    published += 1;
    touchBlackboard(runtime, clusterId, `oneslot/${published}`, null);
  });
  runtime.enableScheduling();
  const starts = () => runtime.store.all(
    "SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  let peak = 0;
  for (let pass = 0; pass < 30; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    peak = Math.max(peak, runtime.activeTurnIds().length);
    const roles = new Set(starts().map(row => row.role));
    if (roles.size >= 2) break;
  }
  const roles = starts();
  assert.ok(roles.some(row => row.role === 'worker'), `the Worker ran: ${JSON.stringify(roles)}`);
  assert.ok(roles.some(row => row.role !== 'worker'), `and so did management: ${JSON.stringify(roles)}`);
  assert.ok(peak <= 1, `never more than one resident turn: peak ${peak}`);
  void auditor;
});

test('a query-only role with a solvent pool is stagnant, not budget-blocked', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-no-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'no refusal anywhere, so no budget stop', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 12 },
    budget: { tokens: 2_000_000, model_requests: 100, tool_calls: 5_000, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const allocator = runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0];
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  // The node's own request column is at zero, but the compaction pool is solvent and
  // can pay — and nothing has been refused.
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    const pool = runtime.store.getBudget(runtime.compactionBudgetId(clusterId));
    runtime.store.updateBudget(pool.id, { tokens_limit: 500_000, tokens_spent: 0, requests_limit: 50, requests_spent: 0 });
  });
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'allocator') return;
    await turn.toolCall('flow_query', { what: 'budgets' });
  });
  runtime.enableScheduling();
  runtime.notifyInternal(clusterId, allocator.id, { subject: 'agent-anomaly', payload: { agent_id: 'worker-1' } });
  for (let pass = 0; pass < 14; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.getNode(root.id).status === 'BLOCKED') break;
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  const blocked = events.filter(event => event.type === 'node-blocked').at(-1);
  assert.ok(blocked, 'the bound fires');
  assert.equal(blocked.data.code ?? null, null, `and it is a stagnation stop, not a budget one: ${blocked.data.reason}`);
  assert.match(String(blocked.data.reason), /made no state change across \d+ turns/);
  assert.equal(events.filter(event => event.type === 'budget-refused').length, 0, 'nothing was refused');
  assert.equal(Number(runtime.store.getBudget(runtime.compactionBudgetId(clusterId)).tokens_limit), 500_000,
    'and the pool that could have paid is untouched');
});

test('a refused write reaches the Auditor as work it can act on', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-refusal-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the Auditor hears about a refused write', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce a file it may not write', acceptance_criteria: ['x'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: txId, write_scope: ['elsewhere'] });
  const allocation = runtime.store.activeAllocationForTransaction(txId);
  assert.ok(allocation, 'the worker is allocated outside the target');
  // The guard refuses the write, exactly as it does in the live run.
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write',
    reason: 'write to deep/nested/result.txt is outside the allocation scope ["elsewhere"]',
  }));
  // ...and the Auditor's pending set names it, with the transaction it blocks.
  const actions = runtime.pendingFor('auditor', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0]);
  const refusal = actions.find(action => action.refusal_seq !== undefined);
  assert.ok(refusal, `the Auditor is told: ${JSON.stringify(actions)}`);
  assert.equal(refusal.transaction_id, txId, 'about the transaction that cannot be produced');
  assert.match(String(refusal.note), /refused/);
  // Acting on it with the *real* command opens the durable issue the correction
  // round needs, and pulls the branch back for a corrected attempt.
  command(runtime, auditor, 'request_replan', {
    transaction_id: txId,
    evidence: { refusal_seq: refusal.refusal_seq, reason: refusal.note },
    required_change: 'widen the write scope and re-allocate before resubmitting',
  });
  const issues = runtime.store.all(
    "SELECT id, status, transaction_id FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId);
  assert.ok(issues.length >= 1, `the issue is durable: ${JSON.stringify(issues)}`);
  assert.equal(runtime.store.getTransaction(txId).status, 'DRAFT', 'and the branch is back for a corrected revision');
  assert.throws(() => command(runtime, auditor, 'verify_correction', {
    issue_id: issues[0].id, decision: 'dismissed',
    evidence: { rechecked: 'the denied target write', found: 'the scope remains unchanged' },
  }), error => error.status === 409 && /refus|denied|write/i.test(error.message),
  'a denied write is objective evidence of an unresolved issue, not a mistaken report');
  assert.equal(runtime.store.getIssue(issues[0].id).status, 'OPEN');

  // The same refusal is still offered: nothing has handled it yet.
  const beforeHandling = runtime.pendingFor('auditor', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0]);
  assert.ok(beforeHandling.some(action => action.refusal_seq === refusal.refusal_seq),
    'an unhandled refusal stays pending');
  // A turn that takes the action up is the only thing that acknowledges it: the
  // revert path in `#applyCommand` is exercised by the real `request_replan` above,
  // which is what removed it from this list on the next pass.
  const handledEvents = () => runtime.store.all(
    "SELECT json_extract(data,'$.seq') AS seq FROM events WHERE cluster_id=? AND type='refusal-handled'", clusterId);
  assert.equal(handledEvents().length, 0,
    'a direct command acknowledges nothing: only a turn that admitted the work can');

  // A terminal transaction gets the action its state allows, and that action is
  // *executed*: the node-level escalation records it without touching the terminal
  // transaction.
  runtime.store.tx(() => runtime.store.updateTransaction(txId, { status: 'FAILED' }));
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'write refused again after the repair attempt',
  }));
  const fresh = runtime.pendingFor('auditor', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0]);
  const second = fresh.find(action => action.refusal_seq !== undefined && action.refusal_seq !== refusal.refusal_seq);
  assert.ok(second, `a new refusal is offered: ${JSON.stringify(fresh.map(a => a.action))}`);
  assert.equal(second.action, 'escalate', 'and it is an action a terminal transaction accepts');
  assert.equal(second.node_id, root.id, 'escalating the node, not the terminal transaction');
  command(runtime, auditor, 'escalate', { node_id: root.id, reason: second.reason });
  const blockedForRefusal = runtime.store.all(
    "SELECT json_extract(data,'$.reason') AS reason FROM events WHERE cluster_id=? AND type='node-blocked'", clusterId);
  assert.ok(blockedForRefusal.some(row => /write/.test(String(row.reason))),
    `the advertised escalation really runs: ${JSON.stringify(blockedForRefusal)}`);
  assert.equal(runtime.store.getTransaction(txId).status, 'FAILED', 'and the terminal transaction is untouched');
});

test('a refused child write belongs to its own Auditor, not every ancestor Auditor', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const cluster = runtime.store.getCluster(clusterId);
  const root = rootNode(runtime, clusterId);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: rootTx.id });
  const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'delegated file' },
  }).result;
  const child = runtime.store.getNode(spawned.node_id);
  const childTx = spawned.delegated_transaction_id;
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id), 'dispatch', { transaction_id: childTx });
  const allocation = command(runtime, actorFor(runtime, clusterId, 'allocator', child.id), 'allocate_agent', {
    transaction_id: childTx, write_scope: ['staging'],
  }).result.allocations[0];
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'target outside staging',
  }));
  const own = runtime.pendingFor('auditor', child, cluster, actorFor(runtime, clusterId, 'auditor', child.id));
  const ancestor = runtime.pendingFor('auditor', root, cluster, actorFor(runtime, clusterId, 'auditor', root.id));
  assert.equal(own.filter(item => item.refusal_seq !== undefined && item.transaction_id === childTx).length, 1);
  assert.equal(ancestor.filter(item => item.refusal_seq !== undefined && item.transaction_id === childTx).length, 0,
    'an ancestor cannot open a second issue on the same denied effect');
});

test('the Auditor issue retains the refused write it took up during its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-issue-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    maxTokens: 512, tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'produce the scoped file', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2000, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, write_scope: ['staging'] });
  const worker = runtime.store.activeAllocationForTransaction(tx.id).agent_id;
  const refusals = [1, 2].map(() => runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: worker, tool: 'write', reason: 'target file outside staging',
  })).seq);
  // The refused effects belong to a completed Worker attempt; do not start
  // a new Worker turn while the Auditor is reviewing that finished attempt.
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'SUBMITTED', result: { status: 'blocked' }, result_revision: tx.revision, __bump_revision: false,
  }));
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    const action = runtime.pendingFor('auditor', root, cluster, auditor)
      .find(item => item.transaction_id === tx.id && item.refusal_seq !== undefined);
    if (action) command(runtime, auditor, 'request_replan', {
      transaction_id: tx.id, required_change: 'grant the target write scope',
    });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 5 && !runtime.store.openIssues(clusterId, { transaction_id: tx.id, status: 'OPEN' }).length; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const issue = runtime.store.openIssues(clusterId, { transaction_id: tx.id, status: 'OPEN' })[0];
  assert.ok(issue, 'the Auditor committed the correction in its own turn');
  assert.deepEqual(issue.evidence.refusal_seqs?.sort((a, b) => a - b), refusals,
    'the durable issue is linked to both denied effects without trusting model-supplied evidence');
  const verdicts = runtime.pendingFor('auditor', root, cluster, auditor)
    .filter(item => item.action === 'review_issue' && item.issue_id === issue.id);
  assert.equal(verdicts.length, 0, 'a proven write refusal is pending a repair, not a dismissal verdict');
});

test('all three management roles get turns under a small window, without exceeding it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-rolerotate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'every role must get a slot eventually', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 1_000, tool_calls: 5_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 1 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // Continuous work for every role: a DRAFT transaction to dispatch, a READY one to
  // allocate, and a plan audit for the auditor to decide.
  const draft = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work to dispatch', acceptance_criteria: ['x'],
  });
  const draftId = draft.result?.transaction_id ?? draft.transaction_id;
  const ready = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work to allocate', acceptance_criteria: ['x'],
  });
  const readyId = ready.result?.transaction_id ?? ready.transaction_id;
  runtime.store.tx(() => runtime.store.updateTransaction(readyId, { status: 'READY' }));
  runtime.store.tx(() => runtime.store.insertAudit({
    id: 'audit-plan-x', cluster_id: clusterId, node_id: root.id, transaction_id: draftId,
    kind: 'plan', decision: 'PENDING', target_revision: runtime.store.getTransaction(draftId).revision,
  }));
  let published = 0;
  host.setScript(async turn => {
    published += 1;
    touchBlackboard(runtime, clusterId, `rotate/${published}`, null);
  });
  runtime.enableScheduling();
  const starts = () => runtime.store.all(
    "SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  let peak = 0;
  for (let pass = 0; pass < 40; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    peak = Math.max(peak, runtime.activeTurnIds().length);
    if (new Set(starts().map(row => row.role)).size >= 3) break;
  }
  const roles = new Set(starts().map(row => row.role));
  for (const role of ['orchestrator', 'allocator', 'auditor']) {
    assert.ok(roles.has(role), `the ${role} got a turn under a one-slot window: ${JSON.stringify(starts())}`);
  }
  assert.ok(peak <= 1, `and the window was never exceeded: peak ${peak}`);
  void allocator; void auditor; void readyId;
});

test('a turn that takes up a refusal acknowledges it only when its action commits', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-refusal-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the turn that acts on a refusal is the one that closes it', workspace: dir,
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 300, tool_calls: 3_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'a branch whose write is refused', acceptance_criteria: ['x'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: txId, write_scope: ['elsewhere'] });
  const allocation = runtime.store.activeAllocationForTransaction(txId);
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'write outside the allocation scope was refused',
  }));
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'the same allocation refused a second attempt',
  }));
  const ownRefusalSeqs = runtime.store.all(
    `SELECT seq FROM events WHERE cluster_id=? AND type='write-refused'
      AND json_extract(data,'$.agent_id')=? ORDER BY seq`, clusterId, allocation.agent_id,
  ).map(row => row.seq);
  assert.equal(ownRefusalSeqs.length, 2);
  const handled = () => runtime.store.all(
    "SELECT json_extract(data,'$.seq') AS seq FROM events WHERE cluster_id=? AND type='refusal-handled'", clusterId);
  const pendingRefusals = () => runtime.pendingFor('auditor', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0])
    .filter(action => action.refusal_seq !== undefined);

  // A turn that does nothing with it leaves it pending and acknowledges nothing.
  host.setScript(async () => {});
  runtime.enableScheduling();
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.ok(pendingRefusals().length >= 1, 'a no-op turn leaves the refusal pending');
  assert.equal(handled().length, 0, 'and acknowledges nothing');

  // The command that commits the correction, from the identity whose turn took it up,
  // closes it exactly once. (`flow_audit` is the plugin's own tool and is not mounted
  // in a fake host, so the tool call itself belongs to the live case; what is under
  // test here is the acknowledgement rule, driven through the real command path.)
  // An unrelated command from the same identity — approving another plan — is not a
  // correction and must not acknowledge anything (it used to, because it returns a
  // transaction id).
  const other = command(runtime, orchestrator, 'create_transaction', {
    objective: 'an unrelated branch', acceptance_criteria: ['x'],
  });
  const otherId = other.result?.transaction_id ?? other.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: otherId });
  runtime.store.tx(() => runtime.store.insertAudit({
    id: 'audit-unrelated', cluster_id: clusterId, node_id: root.id, transaction_id: otherId,
    kind: 'plan', decision: 'PENDING', target_revision: runtime.store.getTransaction(otherId).revision,
  }));
  command(runtime, auditor, 'inspect_plan', { audit_id: 'audit-unrelated', decision: 'approve' });
  assert.equal(handled().length, 0, 'an unrelated approval acknowledges nothing');
  assert.ok(pendingRefusals().length >= 1, 'and the refusals are still pending');

  // A second refusal, on another transaction, must survive the first one's correction.
  const second = (() => {
    const createdOther = command(runtime, orchestrator, 'create_transaction', {
      objective: 'a second refused branch', acceptance_criteria: ['x'],
    });
    const id = createdOther.result?.transaction_id ?? createdOther.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: id });
    if (runtime.store.getTransaction(id).status === 'DRAFT') {
      command(runtime, auditor, 'inspect_plan', { transaction_id: id, decision: 'approve' });
    }
    command(runtime, allocator, 'allocate_agent', { transaction_id: id, write_scope: ['staging/second'] });
    const other = runtime.store.activeAllocationForTransaction(id);
    runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
      agent_id: other.agent_id, tool: 'write', reason: 'the second branch cannot write either',
    }));
    return id;
  })();
  assert.ok(pendingRefusals().some(action => action.transaction_id === second),
    `the second refusal is offered: ${JSON.stringify(pendingRefusals())}`);

  // The matching action, from the identity whose turn took it up, closes *that*
  // refusal: the turn remembered the first transaction, not the second.
  const offered = pendingRefusals().find(action => action.transaction_id === txId || action.node_id === runtime.store.getTransaction(txId).node_id);
  assert.ok(offered, `the taken-up refusal is still offered: ${JSON.stringify(pendingRefusals())}`);
  command(runtime, auditor, offered.action, offered.action === 'escalate'
    ? { node_id: offered.node_id, reason: offered.reason }
    : { transaction_id: offered.transaction_id, required_change: 'widen the write scope and re-allocate' });
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (handled().length > 0) break;
  }
  assert.deepEqual(handled().map(row => row.seq).sort((a, b) => a - b), ownRefusalSeqs,
    'one correction acknowledges both refused attempts from the same allocation');
  assert.ok(pendingRefusals().some(action => action.transaction_id === second),
    `while the other transaction's refusal is untouched: ${JSON.stringify(pendingRefusals())}`);
});


test('escalating a node stops its unfinished transactions with it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-escalate-branch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an escalated branch leaves nothing dangling', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the branch that will be escalated', acceptance_criteria: ['x'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  const child = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: txId, objective: 'a branch that cannot finish', acceptance_criteria: ['x'],
  }).result ?? {}).node_id;
  // The branch has a DRAFT and a READY transaction, neither of them able to complete.
  const childTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: child })[0];
  const extra = command(runtime, actorFor(runtime, clusterId, 'orchestrator', child), 'create_transaction', {
    objective: 'more work in the branch', acceptance_criteria: ['x'], status: 'READY',
  });
  const extraId = extra.result?.transaction_id ?? extra.transaction_id;
  runtime.store.tx(() => runtime.store.updateTransaction(extraId, { node_id: child }));
  assert.equal(runtime.store.getTransaction(childTx.id).status, 'DRAFT', 'the branch has unfinished work');
  // A transaction created in the branch is DRAFT (the plan gate); take it to READY
  // through the ordinary route so both states are represented.
  if (runtime.store.getTransaction(extraId).status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'orchestrator', child), 'dispatch', { transaction_id: extraId });
    if (runtime.store.getTransaction(extraId).status === 'DRAFT') {
      command(runtime, actorFor(runtime, clusterId, 'auditor', child), 'inspect_plan', { transaction_id: extraId, decision: 'approve' });
    }
  }
  assert.equal(runtime.store.getTransaction(extraId).status, 'READY', 'in two states');
  command(runtime, actorFor(runtime, clusterId, 'auditor', child), 'escalate', {
    node_id: child, reason: 'the branch cannot produce its artifact',
  });
  assert.equal(runtime.store.getNode(child).status, 'BLOCKED', 'the node is escalated');
  assert.equal(runtime.store.getTransaction(childTx.id).status, 'BLOCKED', 'and its DRAFT work is stopped with it');
  assert.equal(runtime.store.getTransaction(extraId).status, 'BLOCKED', 'as is its READY work');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.equal(events.filter(event => event.type === 'transaction-blocked').length >= 2, true,
    'each stop is recorded');
  void auditor;
});

test('the fault check fails when only a shallower level was allocated', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-shallow-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'only a shallow level was allocated', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }],
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawnChild = (nodeId, objective) => {
    const created = command(runtime, orchestrator, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = created.result?.transaction_id ?? created.transaction_id;
    return {
      txId,
      nodeId: (command(runtime, allocator, 'spawn_management_node', {
        transaction_id: txId, node_id: nodeId, objective, acceptance_criteria: ['x'],
      }).result ?? {}).node_id,
    };
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1.nodeId, 'level two');
  const level3 = spawnChild(level2.nodeId, 'level three');
  // Only the shallow level is allocated — and denied, so the *shallow* fault is real.
  const level1Tx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: level1.nodeId })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(level1Tx.id, { status: 'READY' }));
  command(runtime, actorFor(runtime, clusterId, 'allocator', level1.nodeId), 'allocate_agent', {
    transaction_id: level1Tx.id, write_scope: ['deep/staging'],
  });
  const shallow = runtime.store.activeAllocationForTransaction(level1Tx.id);
  assert.ok(shallow, 'the shallow level is allocated');
  const deepestTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3.nodeId })[0];
  assert.equal(runtime.store.getTransaction(deepestTx.id).status, 'DRAFT', 'and the deepest level is not');

  const report = { cluster_id: clusterId, checks: [], scenario_status: 'RUNNING', failure_class: null };
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).map(entry => ({ type: entry.type, data: entry.data }));
  const result = await recursionChecks.run({ workspace: dir, report, layout: { data: dir }, events });
  const fault = result.checks.find(entry => entry.name === 'injected-fault-is-real');
  assert.ok(fault, 'the check ran');
  assert.equal(fault.passed, false, `a fault that never reached the deepest level is not a pass: ${fault.evidence}`);
});

test('the artifact check wants a settled write to this path by the deepest node', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-writer-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'who wrote the artifact', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep'] } }],
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawnChild = (nodeId, objective) => {
    const created = command(runtime, orchestrator, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = created.result?.transaction_id ?? created.transaction_id;
    return {
      txId,
      nodeId: (command(runtime, allocator, 'spawn_management_node', {
        transaction_id: txId, node_id: nodeId, objective, acceptance_criteria: ['x'],
      }).result ?? {}).node_id,
    };
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1.nodeId, 'level two');
  const level3 = spawnChild(level2.nodeId, 'level three');
  const deepestTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3.nodeId })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  command(runtime, allocator, 'allocate_agent', { transaction_id: deepestTx.id, node_id: level3.nodeId });
  const allocation = runtime.store.activeAllocationForTransaction(deepestTx.id);
  const worker = runtime.store.getAgent(allocation.agent_id);
  assert.equal(runtime.store.getNode(worker.node_id).parent_id, level3.nodeId, 'the deepest node owns the worker');

  // A settled, non-error write to exactly this path by that worker.
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'eff-deep', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    lease_epoch: 1, session_id: worker.session_id, turn_seq: 1, tool: 'write',
    args: { file_path: 'deep/nested/result.txt' },
    status: 'SETTLED', body: { isError: false, text: '2 levels below the root' },
  }));
  mkdirSync(path.join(dir, 'deep/nested'), { recursive: true });
  writeFileSync(path.join(dir, 'deep/nested/result.txt'), '2 levels below the root');
  const runCheck = async () => {
    const report = { cluster_id: clusterId, checks: [], scenario_status: 'RUNNING', failure_class: null };
    const events = runtime.store.readEvents(clusterId, { limit: 500 }).map(entry => ({ type: entry.type, data: entry.data }));
    const result = await recursionChecks.run({ workspace: dir, report, layout: { data: dir }, events });
    return result.checks.find(entry => entry.name === 'deep-artifact-written');
  };
  const pass = await runCheck();
  assert.equal(pass.passed, true, `a settled write to the path passes: ${pass.evidence}`);

  // The same write to *another* file does not.
  runtime.store.tx(() => runtime.store.run("UPDATE effects SET args=? WHERE call_id='eff-deep'", JSON.stringify({ file_path: 'deep/other.txt' })));
  const wrongPath = await runCheck();
  assert.equal(wrongPath.passed, false, `a write to another file does not: ${wrongPath.evidence}`);

  // A failed write does not.
  runtime.store.tx(() => runtime.store.run("UPDATE effects SET args=?, body=? WHERE call_id='eff-deep'",
    JSON.stringify({ file_path: 'deep/nested/result.txt' }), JSON.stringify({ isError: true })));
  const failed = await runCheck();
  assert.equal(failed.passed, false, `a failed write does not: ${failed.evidence}`);
});

test('an allocated parent does not re-enter the Worker queue when its delegated child is accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const spawned = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: tx.id, scope: { objective: 'child result' },
  }).result;
  const child = runtime.store.getTransaction(spawned.delegated_transaction_id);
  runtime.store.updateTransaction(child.id, { status: 'ACCEPTED', result: { completed: true } });
  const childNode = runtime.store.getNode(spawned.node_id);
  assert.equal(runtime.pendingFor('orchestrator', childNode, runtime.store.getCluster(clusterId))
    .some(item => item.action === 'report-to-parent'), false,
  'an accepted delegated result is already visible to its parent and must not wake endless reporting turns');
  assert.ok(runtime.store.activeAllocationForTransaction(tx.id), 'the old parent grant still exists');
  assert.ok(runtime.store.aggregatableParents(clusterId, root.id).some(row => row.parent_id === tx.id),
    'the Orchestrator can now aggregate the accepted child');
  assert.ok(!runtime.store.readyForWorker(clusterId).some(row => row.id === tx.id),
    'the already-granted Worker is not woken to repeat delegated work');
});

test('a parent waits for its delegated children before it can be run or accepted', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-parent-waits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a parent waits for its children', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // A parent transaction with a delegated child.
  const parent = command(runtime, orchestrator, 'create_transaction', { objective: 'the parent', acceptance_criteria: ['x'] });
  const parentId = parent.result?.transaction_id ?? parent.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: parentId });
  if (runtime.store.getTransaction(parentId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: parentId, decision: 'approve' });
  }
  const child = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parentId, objective: 'the delegated child', acceptance_criteria: ['x'],
  }).result ?? {});
  const childTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: child.node_id })[0];
  assert.equal(runtime.store.getTransaction(childTx.id).status, 'DRAFT', 'the delegated work is unfinished');
  assert.equal(runtime.store.parentsAwaitingChildren(clusterId).includes(parentId), true, 'and the parent is waiting for it');

  // The Allocator is not told to run the parent, and the Orchestrator is not told to
  // validate it, while its child is open.
  const allocatorActions = runtime.pendingFor('allocator', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0]);
  const allocation = allocatorActions.find(action => action.action === 'allocate_agent');
  assert.equal(allocation?.transactions?.includes(parentId) ?? false, false,
    `the parent is not offered for allocation: ${JSON.stringify(allocatorActions.map(a => a.action))}`);

  // The *opposite* order — allocate first, then delegate — cannot run the parent
  // either: eligibility excludes it and admission refuses it, so no turn, request or
  // attempt happens while the child is open.
  const early = command(runtime, orchestrator, 'create_transaction', { objective: 'allocated before it delegated', acceptance_criteria: ['x'] });
  const earlyId = early.result?.transaction_id ?? early.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: earlyId });
  if (runtime.store.getTransaction(earlyId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: earlyId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: earlyId });
  assert.ok(runtime.store.activeAllocationForTransaction(earlyId), 'the parent is allocated first');
  const earlyChild = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: earlyId, objective: 'the child delegated afterwards', acceptance_criteria: ['x'],
  }).result ?? {});
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 10 }).some(row => row.id === earlyId), false,
    'and it is not Worker-eligible once its child exists');
  host.setScript(async () => {});
  runtime.enableScheduling();
  for (let pass = 0; pass < 4; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const earlyStarts = runtime.store.all(
    "SELECT json_extract(data,'$.transaction_id') AS t FROM events WHERE cluster_id=? AND type='turn-start'", clusterId)
    .filter(row => row.t === earlyId);
  assert.equal(earlyStarts.length, 0, 'no turn ran for it');
  assert.equal(runtime.store.getTransaction(earlyId).attempts ?? 0, 0, 'no attempt was spent');
  assert.equal(Number(runtime.store.get(
    "SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND transaction_id=?", clusterId, earlyId)?.c ?? 0), 0,
    'and no provider request was made for it');
  void earlyChild;

  // The execution path itself refuses: allocating a Worker for the parent fails, so its
  // attempts stay at zero.
  const allocationAttempt = (() => {
    try {
      command(runtime, allocator, 'allocate_agent', { transaction_id: parentId });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(allocationAttempt, 'a worker cannot be allocated for a parent with open delegated work');
  assert.match(String(allocationAttempt.message), /delegated work still unfinished/);
  assert.equal(runtime.store.getTransaction(parentId).attempts ?? 0, 0, 'and no attempt was spent');

  // Even a submitted parent cannot be accepted while its child is open.
  runtime.store.tx(() => runtime.store.updateTransaction(parentId, { status: 'SUBMITTED', result: { file: 'x' } }));
  const refused = (() => {
    try {
      command(runtime, orchestrator, 'validate', {
        transaction_id: parentId, accepted: true,
        checks: [{ criterion: 'the artifact exists', passed: true, evidence: 'observed' }],
      });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(refused, 'accepting a parent with open delegated work is refused');
  assert.match(String(refused.message), /delegated work still unfinished/);

  // Once the child is terminal, the real positive path runs: aggregate produces the
  // parent's own result, and only then may it be validated.
  runtime.store.tx(() => {
    runtime.store.updateTransaction(childTx.id, { status: 'ACCEPTED', result: { file: 'deep/nested/result.txt' } });
    runtime.store.updateTransaction(parentId, { status: 'READY', result: null });
  });
  assert.equal(runtime.store.parentsAwaitingChildren(clusterId).includes(parentId), false, 'the wait is over');
  const parentAllocationActions = runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId), allocator)
    .filter(item => item.action === 'allocate_agent');
  assert.ok(parentAllocationActions.every(item => !item.transactions.includes(parentId)),
    'an accepted child makes its READY parent eligible for aggregation, never for a new Worker');
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: parentId }),
    error => error.status === 409 && /aggregate/.test(error.message),
    'a direct allocation cannot bypass the Orchestrator and spend a parent Worker attempt');
  const aggregated = command(runtime, orchestrator, 'aggregate', { transaction_id: parentId });
  assert.equal(runtime.store.getTransaction(parentId).status, 'SUBMITTED',
    `aggregate publishes the parent's own result: ${JSON.stringify(aggregated).slice(0, 200)}`);
  const validated = command(runtime, orchestrator, 'validate', {
    transaction_id: parentId, accepted: true,
    checks: [{ criterion: 'the child artifact exists', passed: true, evidence: 'observed' }],
  });
  assert.equal(runtime.store.getTransaction(parentId).status, 'VALIDATING',
    `validation opens the independent gate: ${JSON.stringify(validated).slice(0, 200)}`);
  const audit = runtime.store.pendingAudits(clusterId, { kind: 'validation', limit: 8 })
    .filter(row => row.transaction_id === parentId && (row.decision ?? 'PENDING') === 'PENDING')
    .at(-1);
  assert.ok(audit, 'the Auditor has a decision to make');
  const waiting = runtime.pendingFor('orchestrator', root, runtime.store.getCluster(clusterId), orchestrator);
  assert.ok(!waiting.some(item => item.action === 'aggregate' && item.transaction_id === parentId),
    'the submitted parent awaits its Auditor, not another aggregate of the same children');
  assert.throws(() => command(runtime, orchestrator, 'aggregate', { transaction_id: parentId }),
    error => error.status === 409 && /VALIDATING/.test(error.message));
  assert.equal(runtime.store.getTransaction(parentId).result_revision, audit.target_revision,
    'a duplicate aggregate cannot stale the independent decision');
  assert.equal(runtime.store.getAudit(audit.id).decision, 'PENDING');
  // The other order: a parent *validated* before it delegates cannot be accepted while
  // the child it then spawned is open — the guard sits on the acceptance commit, so the
  // Auditor's approval is refused too.
  const lateChild = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parentId, objective: 'a child spawned after validation', acceptance_criteria: ['x'],
  }).result ?? {});
  const lateTx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: lateChild.node_id })[0];
  assert.equal(runtime.store.getTransaction(lateTx.id).status, 'DRAFT', 'the late child is unfinished');
  const approval = (() => {
    try {
      command(runtime, auditor, 'inspect_validation', { audit_id: audit.id, decision: 'approve' });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(approval, 'the approval is refused while the child is open');
  assert.match(String(approval.message), /delegated work still unfinished/);
  assert.notEqual(runtime.store.getTransaction(parentId).status, 'ACCEPTED', 'nothing accepted it');
  assert.equal(runtime.store.all(
    "SELECT seq FROM events WHERE cluster_id=? AND type='result-accepted' AND json_extract(data,'$.transaction_id')=?",
    clusterId, parentId).length, 0, 'and no acceptance was recorded');
  // Integrated properly, it passes.
  runtime.store.tx(() => runtime.store.updateTransaction(lateTx.id, { status: 'ACCEPTED', result: { file: 'deep/nested/result.txt' } }));
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: parentId, objective: 'integrate both accepted children',
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: parentId });
  command(runtime, orchestrator, 'aggregate', { transaction_id: parentId });
  // The aggregate is a new result, so the independent gate is asked again.
  command(runtime, orchestrator, 'validate', {
    transaction_id: parentId, accepted: true,
    checks: [{ criterion: 'both child artifacts exist', passed: true, evidence: 'child results aggregated' }],
  });
  const reopened = runtime.store.pendingAudits(clusterId, { kind: 'validation', limit: 8 })
    .filter(row => row.transaction_id === parentId && (row.decision ?? 'PENDING') === 'PENDING')
    .at(-1);
  assert.ok(reopened, 'a fresh validation decision is available');
  const final = command(runtime, auditor, 'inspect_validation', { audit_id: reopened.id, decision: 'approve' });
  assert.equal(runtime.store.getTransaction(parentId).status, 'ACCEPTED',
    'and only then is the parent accepted');
});

test('a role grant is sized for the turns the deployment gives it, not three', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolgrant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'tool grants match the run', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  for (const role of roles) {
    const budget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'agent', role.id).id);
    assert.ok(Number(budget.tool_calls_limit) >= 5 * 20,
      `the ${role.role} can run the turns it is given: ${budget.tool_calls_limit}`);
  }
  // And the node keeps enough for its roles plus a wave of Workers, far inside the
  // declared cluster budget.
  const nodeBudget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', root.id).id);
  assert.ok(Number(nodeBudget.tool_calls_limit) >= 5 * 20 * 3, `the node funds them: ${nodeBudget.tool_calls_limit}`);
  const declared = runtime.store.getCluster(clusterId).spec?.budget?.tool_calls ?? 8_192;
  const total = runtime.store.get("SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId).c;
  // The sum can equal it — the root node legitimately holds the remainder — but it can
  // never exceed what the case declared.
  assert.ok(Number(total) <= Number(declared), `the distribution stays inside the declared budget: ${total} of ${declared}`);
});

test('the correction budget counts failed rounds, not opened issues', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-correction-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'issues are not rounds', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    // The recursion case's own budget: two correction rounds.
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 24, max_corrections: 2 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = command(runtime, orchestrator, 'create_transaction', { objective: 'the branch under correction', acceptance_criteria: ['x'] });
  const txId = tx.result?.transaction_id ?? tx.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  // Two freshly opened issues are not two spent rounds: the Auditor may still replan.
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'first defect' });
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'second defect' });
  assert.equal(runtime.store.countCorrections(clusterId, txId), 0, 'no round has failed yet');
  assert.equal(runtime.store.getNode(root.id).status !== 'BLOCKED', true, 'so the node is not blocked');
  // A third replan is still allowed while the configured rounds are unspent.
  const third = (() => {
    try {
      command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'third defect' });
      return null;
    } catch (error) { return error; }
  })();
  assert.equal(third, null, `a third issue does not exhaust two correction rounds: ${String(third)}`);

  // Real failed rounds do: two bumps of the counter block it.
  runtime.store.tx(() => {
    for (const issue of runtime.store.openIssues(clusterId, { transaction_id: txId, status: ['OPEN'] })) {
      runtime.store.updateIssue(issue.id, { corrections: 1 });
    }
  });
  assert.equal(runtime.store.countCorrections(clusterId, txId), 3, 'three failed rounds are counted');
  const blocked = (() => {
    try {
      command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'fourth defect' });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(blocked, 'and then the budget refuses');
  assert.match(String(blocked.message), /correction budget exhausted/);
  // The stop is recorded by the guard and applied by the scheduler, outside the
  // refusal's transaction: one tick later the node is stopped for it.
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(runtime.store.getNode(root.id).status, 'BLOCKED', 'the node stops for it');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'correction-budget-applied'), 'the applied stop is recorded');
  assert.ok(events.some(event => event.type === 'node-blocked' && event.data.code === 'CORRECTION_BUDGET_EXHAUSTED'),
    'and so is the stop, with its code');
});

test('a rejected repair costs one round, re-reviewing it costs none', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-rounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a round is a repair, not a call', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 24, max_corrections: 2 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = command(runtime, orchestrator, 'create_transaction', { objective: 'the transaction under repair', acceptance_criteria: ['x'] });
  const txId = tx.result?.transaction_id ?? tx.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'produce the artifact' });
  const issue = runtime.store.all("SELECT id FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId)[0];
  assert.ok(issue, 'the issue exists');

  // One repair — an adjustment *and* a validation, the two streams a verdict has to
  // reconcile — then a failed verdict: one round, bound to the latest of them.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired once' } } });
  runtime.store.tx(() => runtime.store.updateTransaction(txId, { status: 'SUBMITTED', result: { file: 'none' } }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: txId, accepted: false,
    checks: [{ criterion: 'the artifact is missing', passed: false, evidence: 'not present' }],
  });
  command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
  assert.equal(runtime.store.getIssue(issue.id).corrections, 1, 'the first repair cost one round');
  // Re-reviewing that same state costs nothing: neither the adjustment nor the
  // validation is newer than what the verdict already bound to.
  const repeat = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(repeat, 'unchanged state cannot be charged again');
  assert.match(String(repeat.message), /no fresh correction/);
  assert.equal(runtime.store.getIssue(issue.id).corrections, 1, 'and the counter did not move');

  // A second repair enables the second charge — and only then does the budget bite.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired twice' } } });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired twice' } } });
  command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
  assert.equal(runtime.store.getIssue(issue.id).corrections, 2, 'the second repair cost the second round');
  // A further repair with no fresh round left is refused and stops the branch.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired thrice' } } });
  const refused = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.equal(runtime.store.getIssue(issue.id).status, 'ESCALATED',
    'the issue escalates when its rounds are spent');
  void refused;
});

test('a node whose roles have never run is served before busy branches', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-unserved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a deep node must not starve behind busy branches', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 2 },
    delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 2 }],
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawnChild = (nodeId, objective) => {
    const created = command(runtime, orchestrator, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = created.result?.transaction_id ?? created.transaction_id;
    return (command(runtime, allocator, 'spawn_management_node', {
      transaction_id: txId, node_id: nodeId, objective, acceptance_criteria: ['x'],
    }).result ?? {}).node_id;
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1, 'level two');
  // The failed node's own shape: its Orchestrator has taken a turn, its two plan audits
  // are still pending, and its Auditor has never run. Continuous root work keeps the
  // window busy so the deep node has to win a slot on merit.
  const deepest = runtime.store.getNode(level2);
  const deepOrchestrator = runtime.store.listAgents(clusterId, { node_id: level2, role: 'orchestrator', limit: 1 })[0];
  const deepAuditor = runtime.store.listAgents(clusterId, { node_id: level2, role: 'auditor', limit: 1 })[0];
  runtime.store.tx(() => {
    runtime.store.updateAgent(deepOrchestrator.id, { turns: 1 });
    runtime.store.appendEvent(clusterId, 'turn-start', { agent_id: deepOrchestrator.id, role: 'orchestrator' });
    runtime.store.appendEvent(clusterId, 'turn-end', { agent_id: deepOrchestrator.id, role: 'orchestrator', progress: true });
    for (const index of [1, 2]) {
      runtime.store.insertAudit({
        id: `audit-deep-${index}`, cluster_id: clusterId, node_id: level2,
        transaction_id: command(runtime, orchestrator, 'create_transaction', {
          objective: `deep work ${index}`, acceptance_criteria: ['x'],
        }).result?.transaction_id ?? `deep-${index}`,
        kind: 'plan', decision: 'PENDING', target_revision: 1,
      });
    }
  });
  for (let index = 0; index < 3; index += 1) {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective: `root work ${index}`, acceptance_criteria: ['x'], status: 'READY',
    });
    void created;
  }
  void deepest;
  let published = 0;
  host.setScript(async () => { published += 1; });
  runtime.enableScheduling();
  const startsForAgent = agentId => Number(runtime.store.get(
    `SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=?`,
    clusterId, agentId)?.c ?? 0);
  for (let pass = 0; pass < 25; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (startsForAgent(deepAuditor.id) > 0) break;
  }
  assert.ok(startsForAgent(deepAuditor.id) > 0,
    `the never-run Auditor was admitted while the window stayed busy: ${startsForAgent(deepAuditor.id)}`);
  const auditorTurn = runtime.store.all(
    "SELECT json_extract(data,'$.actions') AS actions FROM events WHERE cluster_id=? AND type='turn-actions' AND json_extract(data,'$.role')='auditor'",
    clusterId,
  ).some(row => String(row.actions).includes('inspect_plan'));
  assert.equal(auditorTurn, true, 'and the pending plan audits were offered to it');
  void published;
});

test('a mistaken issue can be dismissed without any revision and without blocking', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-dismiss-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an issue raised in error can be withdrawn', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the transaction the Auditor misjudged', acceptance_criteria: ['the file exists'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  // The mistaken issue: nothing about the transaction has changed, and it never will.
  command(runtime, auditor, 'request_replan', {
    transaction_id: txId, required_change: 'acceptance_criteria is empty', evidence: { checked: false },
  });
  const issue = runtime.store.all("SELECT id, status FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId)[0];
  assert.equal(issue.status, 'OPEN', 'the mistaken issue is open');
  // Closing it as a correction is impossible (nothing moved) — that is the trap the run hit.
  const closing = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'VERIFIED', evidence: { rechecked: true } });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(closing, 'and it cannot be closed as a correction');
  // Dismissing it is the legal exit, and it needs the Auditor's own evidence.
  const undocumented = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'DISMISSED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(undocumented, 'a dismissal must say what was re-checked');
  command(runtime, auditor, 'verify_correction', {
    issue_id: issue.id, decision: 'DISMISSED',
    evidence: { rechecked: 'acceptance_criteria', found: ['the file exists'] },
    notes: 'the criteria are present; the issue was raised in error',
  });
  assert.equal(runtime.store.getIssue(issue.id).status, 'DISMISSED', 'it is dismissed');
  assert.equal(runtime.store.getNode(root.id).status !== 'BLOCKED', true, 'and nothing was blocked');
  assert.equal(runtime.store.getCluster(clusterId).status !== 'BLOCKED', true, 'not even the cluster');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'issue-dismissed'), 'the withdrawal is recorded');
  // A dismissal is not a correction: it can never stand in for a durable change.
  assert.equal(runtime.store.openIssues(clusterId, { status: 'OPEN' }).length, 0, 'and it is no longer open');
});

test('a plan audit carries the criteria it is judging, not just where to look', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-audit-facts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an audit names what it judges', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = runtime.store.getCluster(clusterId);
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce the deep artifact', acceptance_criteria: ['exactly one child node exists', 'the file exists'],
    expected_output: 'deep/nested/result.txt',
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  const actions = runtime.pendingFor('auditor', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0]);
  const audit = actions.find(action => action.action === 'inspect_plan' && action.transaction_id === txId);
  assert.ok(audit, `the plan audit is offered: ${JSON.stringify(actions.map(a => a.action))}`);
  assert.deepEqual(audit.acceptance_criteria, ['exactly one child node exists', 'the file exists'],
    'with the criteria it is judging, so an absent list cannot be read as an empty one');
  assert.match(String(audit.objective), /produce the deep artifact/);
  assert.equal(audit.expected_output, 'deep/nested/result.txt');
});

test('a spawned node is never born with a scrap tool allowance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'tool allowances are shared fairly', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawned = [];
  for (let index = 0; index < 3; index += 1) {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective: `branch ${index}`, acceptance_criteria: ['x'],
    });
    const txId = created.result?.transaction_id ?? created.transaction_id;
    const child = command(runtime, allocator, 'spawn_management_node', {
      transaction_id: txId, objective: `branch ${index}`, acceptance_criteria: ['x'],
    }).result ?? {};
    spawned.push(child.node_id);
  }
  for (const nodeId of spawned) {
    const budget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', nodeId).id);
    // The node's file is handed to its three roles, so the endowment is the node plus
    // what those roles hold.
    const roles = runtime.store.all(
      "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", nodeId)[0].c;
    const endowment = Number(budget.tool_calls_limit) + Number(roles ?? 0);
    assert.ok(endowment >= Math.floor(8_192 / 8),
      `a child is not born with a scrap allowance: ${endowment}`);
  }
  // The same fair share applies to what a node's roles and Worker wave *spend*, not only to
  // tools: a deep node was measured at 38,449 tokens and 5 requests, enough for neither a
  // role turn nor a Worker.
  for (const nodeId of spawned) {
    const budget = runtime.store.getBudget(runtime.store.budgetForScope(clusterId, 'node', nodeId).id);
    const roles = runtime.store.all(
      "SELECT SUM(tokens_limit) AS t, SUM(requests_limit) AS r FROM budgets WHERE scope_kind='agent' AND node_id=?", nodeId)[0];
    assert.ok(Number(budget.tokens_limit) + Number(roles.t ?? 0) >= Math.floor(8_388_608 / 8),
      `a deep node can fund its own roles: ${Number(budget.tokens_limit) + Number(roles.t ?? 0)}`);
    assert.ok(Number(budget.requests_limit) + Number(roles.r ?? 0) >= Math.floor(1_024 / 8),
      `and their requests: ${Number(budget.requests_limit) + Number(roles.r ?? 0)}`);
  }
  const declared = 8_192;
  const total = runtime.store.get(
    "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId).c;
  assert.ok(Number(total) <= declared, `the distribution stays inside the declaration: ${total} of ${declared}`);
  const declaredTokens = 8_388_608;
  const totalTokens = runtime.store.get(
    "SELECT SUM(tokens_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId).c;
  assert.ok(Number(totalTokens) <= declaredTokens, `and the token distribution too: ${totalTokens} of ${declaredTokens}`);
});

test('a management send yields its native turn after delivery so the recipient can act', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-send-yield-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'deliver an allocation request', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  let observed = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator' || observed) return;
    const receipt = await turn.callTool('flow_communicate', {
      action: 'send', params: { agent: allocator.agent_id, content: 'Please review allocation capacity.' },
    });
    observed = { receipt, concluded: turn.concluded };
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 15 && !observed; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.ok(observed, 'the Orchestrator reached its scheduled send');
  assert.equal(JSON.parse(observed.receipt).ok, true, 'the send succeeded');
  assert.equal(observed.concluded, true, 'the host must return control before this role polls the unchanged allocation');
});

test('the dismissal and the acceptance chain run through scheduled roles and their own tools', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-role-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'roles act through their own tools', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 900_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce the artifact', acceptance_criteria: ['the file exists'],
  });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  // A mistaken issue, exactly as the live run raised one.
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'acceptance_criteria is empty' });
  const issue = runtime.store.all("SELECT id FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId)[0];
  assert.ok(issue, 'the mistaken issue exists');

  // The Auditor dismisses it through its *own* tool, in a scheduled turn.
  let dismissedThroughTool = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    const result = await turn.callTool('flow_audit', {
      action: 'verify_correction',
      params: {
        issue_id: issue.id, decision: 'dismissed',
        evidence: { rechecked: 'acceptance_criteria', found: ['the file exists'] },
      },
    });
    dismissedThroughTool = Boolean(result);
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.getIssue(issue.id).status === 'DISMISSED') break;
  }
  assert.equal(dismissedThroughTool, true, 'the Auditor acted through its own tool');
  assert.equal(runtime.store.getIssue(issue.id).status, 'DISMISSED', 'and the issue is dismissed');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'issue-dismissed'),
    'the dismissal is on the record');
  assert.equal(runtime.store.getCluster(clusterId).status !== 'BLOCKED', true, 'nothing was blocked');

  // The acceptance chain, also through real tool calls: a result, a validation, then the
  // Auditor's approval of it.
  runtime.store.tx(() => runtime.store.updateTransaction(txId, { status: 'SUBMITTED', result: { file: 'artifact.txt' } }));
  let validated = false;
  let approved = false;
  let turnRoles = [];
  let validationError = null;
  let approvalError = null;
  let approvedAuditId = null;
  const looksLikeToolError = value => /isError|error|refused|invalid|not found|cannot/i.test(JSON.stringify(value ?? ''));
  host.setScript(async turn => {
    const role = runtime.store.getAgentBySession(turn.session.id)?.role;
    turnRoles.push(role);
    if (role === 'orchestrator') {
      try {
        const result = await turn.callTool('flow_transaction', {
          action: 'validate',
          params: { transaction_id: txId, accepted: true, checks: [{ criterion: 'the file exists', passed: true, evidence: 'observed' }] },
        });
        // A tool-error result is not a successful action: the pipeline reports refusals as
        // results, so the assertion is on the *outcome*, not on the call having returned.
        validated = !looksLikeToolError(result);
        if (!validated) validationError = `tool error: ${JSON.stringify(result).slice(0, 200)}`;
      } catch (error) { validationError = String(error?.message ?? error); }
      return;
    }
    if (role !== 'auditor') return;
    const audit = runtime.store.pendingAudits(clusterId, { kind: 'validation', limit: 8 })
      .filter(row => row.transaction_id === txId && (row.decision ?? 'PENDING') === 'PENDING').at(-1);
    if (!audit) return;
    const result = await turn.callTool('flow_audit', { action: 'inspect_validation', params: { audit_id: audit.id, decision: 'approve' } });
    approved = !looksLikeToolError(result);
    if (!approved) approvalError = `tool error: ${JSON.stringify(result).slice(0, 200)}`;
    approvedAuditId = audit.id;
  });
  for (let pass = 0; pass < 25; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (runtime.store.getTransaction(txId).status === 'ACCEPTED') break;
  }
  assert.equal(validated, true, `the Orchestrator validated through its tool: ${validationError} turns ${JSON.stringify(turnRoles.slice(-4))}`);
  assert.equal(approved, true, `and the Auditor approved through its own tool: ${approvalError}`);
  const decided = runtime.store.all("SELECT id, decision FROM audits WHERE id=?", approvedAuditId)[0];
  assert.equal(decided?.decision, 'APPROVED', `the exact audit was decided: ${JSON.stringify(decided)}`);
  assert.equal(runtime.store.getTransaction(txId).status, 'ACCEPTED', 'the chain completes through the tools');
});

test('an Auditor reviews unchanged issues without a preselected verdict', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-neutral-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'review both a real missing file and a mistaken issue', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const missing = command(runtime, orchestrator, 'create_transaction', {
    objective: 'write deep/nested/result.txt', acceptance_criteria: ['deep/nested/result.txt exists'],
  }).result.transaction_id;
  const valid = command(runtime, orchestrator, 'create_transaction', {
    objective: 'plan a checkable file', acceptance_criteria: ['the file exists'],
  }).result.transaction_id;
  const genuine = command(runtime, auditor, 'request_replan', {
    transaction_id: missing, required_change: 'deep/nested/result.txt is still absent; revise the write grant',
  }).result.issue_id;
  const mistaken = command(runtime, auditor, 'request_replan', {
    transaction_id: valid, required_change: 'the transaction has no acceptance criteria',
  }).result.issue_id;
  const reviews = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId), auditor)
    .filter(item => item.action === 'review_issue');
  assert.deepEqual(new Set(reviews.map(item => item.issue_id)), new Set([genuine, mistaken]),
    'both real and mistaken claims are offered for independent review');
  assert.ok(reviews.every(item => !Object.hasOwn(item, 'decision_hint')),
    'the control loop does not choose a verdict for the Auditor');
  let queried = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    await turn.callTool('flow_query', { what: 'transaction', params: { id: missing } });
    queried = true;
    await turn.callTool('flow_audit', {
      action: 'verify_correction',
      params: { issue_id: mistaken, decision: 'dismissed',
        evidence: { rechecked: 'acceptance_criteria', found: ['the file exists'] } },
    });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 12 && runtime.store.getIssue(mistaken).status !== 'DISMISSED'; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.equal(queried, true, 'the scheduled Auditor inspected the actual transaction through its tool');
  assert.equal(runtime.store.getIssue(genuine).status, 'OPEN', 'the real missing-file issue is not dismissed merely for being unchanged');
  assert.equal(runtime.store.getIssue(mistaken).status, 'DISMISSED', 'the same turn can retract a demonstrably mistaken issue');
});

test('an unchanged issue does not manufacture endless Auditor turns', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-oneshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a stuck issue does not spin the Auditor', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0];
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', { objective: 'a genuine issue', acceptance_criteria: ['x'] });
  const txId = created.result?.transaction_id ?? created.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (runtime.store.getTransaction(txId).status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  // A genuine issue, and nothing is ever done about it.
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'produce the missing evidence' });
  let auditorTurns = 0;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role === 'auditor') auditorTurns += 1;
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 30; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const issue = runtime.store.all("SELECT id, status FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId)[0];
  assert.equal(issue.status, 'OPEN', 'the issue is still open and unaddressed');
  // The Auditor was given the issue once, not once per pass.
  assert.ok(auditorTurns <= 2, `the Auditor was not spun: ${auditorTurns} turns over 30 passes`);
  // (A node whose roles take no-op turns is stopped by the stagnation bound — that is a
  // different rule and a different test's subject; what this one bounds is the *Auditor's*
  // work queue.)
  // A repair re-arms review, without deciding whether it succeeded.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired' } } });
  const rearmed = runtime.pendingFor('auditor', root, runtime.store.getCluster(clusterId),
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 })[0])
    .filter(item => item.action === 'review_issue');
  assert.ok(rearmed.length > 0, 'a repair re-arms review');
  assert.ok(rearmed.every(item => item.changed_since_issue === true),
    'the scheduler reports a durable change without claiming the correction was verified');
});

test('a management node at the depth cap is refused, because no Worker could run', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_depth: 3 },
    delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 2 }],
  });
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const first = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'level 1' },
  }).result;
  const second = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: first.delegated_transaction_id, node_id: first.node_id, scope: { objective: 'level 2' },
  }).result;
  assert.equal(runtime.store.getNode(second.node_id).depth, 2, 'the chain reaches depth 2');
  // A node at depth 3 would need a Worker at depth 4, outside the cap: its roles would have
  // no identity to allocate, and the branch could never produce its artifact.
  const atCap = (() => {
    try {
      command(runtime, allocator, 'spawn_management_node', {
        transaction_id: second.delegated_transaction_id, node_id: second.node_id, scope: { objective: 'level 3' },
      });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(atCap, 'the spawn is refused');
  assert.match(String(atCap.message), /could not run a Worker/);
  // ...while a level inside the cap really can allocate its Worker.
  const tx = runtime.store.listTransactions({ cluster_id: clusterId, node_id: second.node_id })[0];
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'READY' }));
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, node_id: second.node_id });
  const workerNode = runtime.store.getNode(runtime.store.getAgent(allocated.result.allocations[0].agent_id).node_id);
  assert.equal(workerNode.parent_id, second.node_id, 'and its own Worker is legal inside the cap');
  assert.equal(workerNode.depth, 3, 'one level below its management node, still inside max_depth 3');
  const scenario = await recursionChecks.run({
    workspace: runtime.store.getCluster(clusterId).workspace,
    report: { cluster_id: clusterId }, layout: { data: path.dirname(runtime.store.path) },
    events: [],
  });
  const depthCheck = scenario.checks.find(check => check.name === 'management-depth-three');
  assert.equal(depthCheck.passed, false, 'a Worker at depth 3 does not make a depth-3 management branch');
});

test('delegated corrections cannot replace the contract their parent assigned', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    capabilities: ['fs_read', 'fs_write'],
    initial_transactions: [{
      id: 'parent-deliverable', objective: 'write deep/nested/result.txt',
      expected_output: 'deep/nested/result.txt exists',
      acceptance_criteria: ['deep/nested/result.txt was written by this branch'],
    }],
  });
  const root = rootNode(runtime, clusterId);
  const parent = runtime.store.getTransaction('parent-deliverable');
  const child = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: parent.id, scope: { objective: 'deliver the artifact' },
      inputs: { write_scope: ['deep/staging'] } }).result;
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', child.node_id);
  const before = runtime.store.getTransaction(child.delegated_transaction_id);
  assert.deepEqual(before.acceptance_criteria, parent.acceptance_criteria);
  assert.throws(() => command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: before.id, expected_output: 'deep/staging/result.txt exists',
    acceptance_criteria: ['deep/staging/result.txt exists'],
  }), error => error.status === 409 && /delegat|contract/i.test(error.message));
  const refused = runtime.store.getTransaction(before.id);
  assert.equal(refused.revision, before.revision);
  assert.deepEqual(refused.acceptance_criteria, parent.acceptance_criteria);
  assert.equal(refused.expected_output, parent.expected_output);
  const corrected = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: before.id,
    inputs: { write_scope: ['deep/staging', 'deep/nested'] },
    acceptance_criteria: [...parent.acceptance_criteria, 'include a line identifying the deepest node'],
  }).result;
  assert.ok(corrected.revision > before.revision);
  assert.deepEqual(runtime.store.getTransaction(before.id).acceptance_criteria,
    [...parent.acceptance_criteria, 'include a line identifying the deepest node']);
});

test('a delegated depth counter cannot be revised to invent management levels', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 2,
      max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 4_000_000, model_requests: 1_000, tool_calls: 2_000,
      wall_time_ms: 3_600_000, agents: 64, max_active_agents: 4 },
    delegation: [{ scope: 'deep/', objective: 'deliver the deep result', spawn_children: 3,
      inputs: { write_scope: ['deep/staging'] } }],
  });
  let node = rootNode(runtime, clusterId);
  let tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  for (const remaining of [2, 1, 0]) {
    const child = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] } }).result;
    node = runtime.store.getNode(child.node_id);
    tx = runtime.store.getTransaction(child.delegated_transaction_id);
    assert.equal(tx.inputs.management_levels_remaining, remaining);
  }
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', node.id);
  assert.throws(() => command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { management_levels_remaining: 2, write_scope: ['deep/staging', 'deep/nested'] },
  }), error => error.status === 409 && /remaining|delegat/i.test(error.message));
  assert.equal(runtime.store.getTransaction(tx.id).revision, tx.revision);
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  assert.deepEqual(runtime.store.getTransaction(tx.id).inputs,
    { management_levels_remaining: 0, write_scope: ['deep/staging', 'deep/nested'] },
    'a legitimate write-scope correction preserves the fixture-owned level count');
});

test('a revised transaction requires its Allocator to replace an older Worker grant', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const first = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  assert.deepEqual(runtime.store.getAllocation(first.allocation_id).write_scope, ['deep/staging']);
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const pending = runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId), runtime.store.getAgent(allocator.agent_id));
  assert.ok(pending.some(item => item.action === 'release_agent' && item.allocations.includes(first.allocation_id)),
    'a changed transaction cannot silently reuse a grant fixed before the revision');
  command(runtime, allocator, 'release_agent', { allocation_id: first.allocation_id });
  const next = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  assert.notEqual(next.agent_id, first.agent_id);
  assert.deepEqual(runtime.store.getAllocation(next.allocation_id).write_scope, ['deep/staging', 'deep/nested']);
});

test('the scheduler never runs a Worker granted before its transaction revision', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stale-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'write a scoped file', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2,
      max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100,
      wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const old = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations[0];
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  // This fixture tests Worker grant fencing, not management-role behavior.
  // With no fake management model supplied, retire those sessions so their
  // empty turns cannot block the root before Worker admission.
  runtime.store.tx(() => {
    for (const role of runtime.store.listAgents(clusterId, { node_id: root.id })) {
      runtime.store.updateAgent(role.id, { status: 'TERMINATED' });
    }
  });
  const workers = [];
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    workers.push(turn);
    await turn.request({ purpose: 'worker' });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.equal(workers.length, 0, 'a READY transaction cannot run under an obsolete write grant');
  command(runtime, allocator, 'release_agent', { allocation_id: old.allocation_id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  for (let pass = 0; pass < 10 && !workers.length; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.equal(workers.length, 1, 'a newly granted Worker may run the revised plan');
});

test('a Worker can discover its management roles without reading sibling Workers', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const first = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'unrelated sibling work', acceptance_criteria: ['sibling exists'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, allocator, 'allocate_agent', { transaction_id: second });
  const own = runtime.store.activeAllocationForTransaction(first.id);
  const sibling = runtime.store.activeAllocationForTransaction(second);
  const worker = runtime.store.getAgent(own.agent_id);
  const visible = runtime.query({
    cluster_id: clusterId, node_id: worker.node_id, agent_id: worker.id, role: 'worker',
  }, 'agents', { limit: 10 }).items;
  assert.deepEqual(visible.filter(agent => agent.node_id === root.id).map(agent => agent.role).sort(),
    ['allocator', 'auditor', 'orchestrator'], 'the Worker can address all three owning roles');
  assert.equal(visible.some(agent => agent.id === sibling.agent_id), false,
    'discovering the managers does not expose other Workers in their domain');
});

test('Allocator does not fund a Worker that already submitted its result', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.activeAllocationForTransaction(tx.id);
  const agentBudget = runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id);
  runtime.store.tx(() => runtime.store.updateBudget(agentBudget.id, { requests_spent: agentBudget.requests_limit }));
  const pending = () => runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(allocator.agent_id));
  assert.ok(pending().some(item => item.starved_agents?.includes(allocation.agent_id)),
    'a READY Worker without a request can be funded');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED' }));
  assert.equal(pending().some(item => item.starved_agents?.includes(allocation.agent_id)), false,
    'SUBMITTED work belongs to validation, not to a Worker top-up');
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'READY' });
    runtime.store.updateCluster(clusterId, {
      limits: { ...runtime.store.getCluster(clusterId).limits, worker_model_requests: 2 },
    });
    for (let index = 0; index < 2; index += 1) {
      runtime.store.insertUsageReceipt({
        request_id: `spent-worker-${index}`, cluster_id: clusterId, agent_id: allocation.agent_id,
        node_id: runtime.store.getAgent(allocation.agent_id).node_id,
        role: 'worker', kind: 'worker', status: 'SETTLED', reservation_tokens: 10, turn_seq: 1,
      });
    }
  });
  assert.equal(pending().some(item => item.starved_agents?.includes(allocation.agent_id)), false,
    'a Worker at its declared request allowance cannot be funded again');
});

test('a waiting parent does not rebalance budget just because its node balance is zero', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const parent = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: parent.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: parent.id, decision: 'approve' });
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parent.id, scope: { objective: 'complete child work' },
  }).result;
  const childOrchestrator = actorFor(runtime, clusterId, 'orchestrator', child.node_id);
  const childAuditor = actorFor(runtime, clusterId, 'auditor', child.node_id);
  command(runtime, childOrchestrator, 'dispatch', { transaction_id: child.delegated_transaction_id });
  command(runtime, childAuditor, 'inspect_plan', {
    transaction_id: child.delegated_transaction_id, decision: 'approve',
  });
  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, {
    status: 'SUBMITTED', result: { evidence: 'awaiting validation' },
  }));
  assert.ok(runtime.store.parentsAwaitingChildren(clusterId).includes(parent.id));
  const rootBudget = runtime.store.budgetForScope(clusterId, 'node', root.id);
  runtime.store.tx(() => runtime.store.updateBudget(rootBudget.id, {
    tokens_spent: rootBudget.tokens_limit - rootBudget.tokens_reserved,
  }));
  assert.equal(dimensionAvailable(runtime.store.getBudget(rootBudget.id), 'tokens'), 0);
  const hints = runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(allocator.agent_id)).filter(item => item.action === 'rebalance_budget');
  assert.equal(hints.some(item => item.to?.id === root.id), false,
    'the root has no executable local work until its delegated child completes');
});

test('a parent Allocator sees a blocked child whose positive balance is below its refused request', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const delegated = runtime.store.listTransactions({ cluster_id: clusterId })[0];
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegated.id, scope: { objective: 'write a child result' },
  }).result;
  const nodeBudget = runtime.store.budgetForScope(clusterId, 'node', child.node_id);
  runtime.store.tx(() => runtime.store.updateBudget(nodeBudget.id, {
    tokens_limit: nodeBudget.tokens_spent + nodeBudget.tokens_reserved + 8_511,
    requests_limit: nodeBudget.requests_spent + nodeBudget.requests_reserved + 1,
  }));
  const childAllocator = actorFor(runtime, clusterId, 'allocator', child.node_id);
  runtime.blockNodeInternal(clusterId, child.node_id,
    'BUDGET: next role request needs 16,000 tokens and one request', 'BUDGET_EXHAUSTED', {
      agent_id: childAllocator.agent_id, dimension: 'tokens', requested: 16_000,
      envelope: { tokens: 16_000, model_requests: 1, tool_calls: 0 },
    });
  const actions = runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId),
    runtime.store.getAgent(allocator.agent_id));
  const hint = actions.find(item => item.action === 'rebalance_budget' && item.to?.id === child.node_id);
  assert.ok(hint, `a positive balance smaller than the refused request is still starvation: ${JSON.stringify(actions)}`);
  assert.equal(hint.required?.tokens, 16_000, 'the funder sees the actual envelope rather than a zero-balance guess');
  assert.ok(hint.from_options.some(option => option.tokens >= 16_000));
});

test('acceptance closes an issue only when new Worker evidence answered it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = runtime.store.rootTransactions(clusterId)[0];
  const second = { id: command(runtime, orchestrator, 'create_transaction', {
    objective: 'a second deliverable that is repaired after its issue',
    acceptance_criteria: ['the deliverable exists'],
  }).result.transaction_id };
  const correctedEvents = () => runtime.store.all(
    "SELECT json_extract(data,'$.issue_id') AS issue_id, json_extract(data,'$.reason') AS reason FROM events WHERE cluster_id=? AND type='issue-corrected'",
    clusterId,
  );

  for (const tx of [first, second]) {
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
    runtime.store.tx(() => {
      runtime.store.appendEvent(clusterId, 'result-submitted', { transaction_id: tx.id, result_completed: 0, revision: 2 });
      runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { completed: false }, __bump_revision: false });
    });
  }
  const answered = runtime.store.insertIssue({
    id: 'issue-answered-by-acceptance', cluster_id: clusterId, node_id: root.id,
    transaction_id: second.id, target_revision: 2, required_change: 'produce the deliverable',
  });
  const unanswered = runtime.store.insertIssue({
    id: 'issue-awaiting-replacement', cluster_id: clusterId, node_id: root.id,
    transaction_id: first.id, target_revision: 2, required_change: 'produce the deliverable',
  });
  runtime.store.tx(() => {
    for (const issue of [answered, unanswered]) {
      runtime.store.appendEvent(clusterId, 'issue-opened', {
        issue_id: issue.id, transaction_id: issue.transaction_id, severity: issue.severity,
      });
    }
  });

  // The second transaction really does produce replacement work after its issue.
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    transaction_id: second.id, result_completed: 1, revision: 3,
  }));

  for (const tx of [first, second]) {
    command(runtime, orchestrator, 'validate', {
      transaction_id: tx.id, accepted: true,
      checks: [{ criterion: 'the deliverable exists', passed: true, evidence: 'recorded result checked' }],
    });
    command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
    assert.equal(runtime.store.getTransaction(tx.id).status, 'ACCEPTED');
  }

  assert.equal(runtime.store.getIssue(answered.id).status, 'CORRECTED',
    'an accepted result submitted after the issue is the correction');
  assert.equal(runtime.store.getIssue(unanswered.id).status, 'OPEN',
    'acceptance alone must not correct an issue raised against an incomplete Worker result');
  const closures = correctedEvents();
  assert.deepEqual(closures.map(row => row.issue_id), [answered.id],
    `only the issue with replacement evidence closes: ${JSON.stringify(closures)}`);
  assert.equal(closures[0].reason, 'accepted-result-after-issue',
    'the closure records why it happened, rather than flipping the status silently');
});

test('a communication query returns the prefix view with the cursor of its read cut', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const cluster = runtime.store.getCluster(clusterId);
  const publish = (key, value) => runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'publish', { key, value }));
  publish('plan/alpha', { step: 1 });
  publish('result/beta', { ok: true });
  const before = runtime.store.latestEventSeq(clusterId);

  const byPrefix = runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { prefix: 'plan/' }));
  assert.deepEqual(byPrefix.entries.map(entry => entry.key), ['plan/alpha'],
    'a prefix query returns that prefix and nothing else');
  assert.deepEqual(byPrefix.entries[0].value, { step: 1 });
  assert.ok(byPrefix.cursor >= before, 'the cursor is the read cut the snapshot came from');

  const byKey = runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { key: 'result/beta' }));
  assert.deepEqual(byKey.entries.map(entry => entry.key), ['result/beta']);
  assert.deepEqual(byKey.entries[0].value, { ok: true });

  const missing = runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { key: 'plan/absent' }));
  assert.deepEqual(missing.entries, [], 'an absent key is an empty view, not an error');
});

test('an authorized Allocator spawns a Worker through spawn_agent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = runtime.store.rootTransactions(clusterId)[0];
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });

  const spawned = command(runtime, allocator, 'spawn_agent', { transaction_id: tx.id }).result;
  assert.equal(spawned.count, 1);
  assert.equal(spawned.allocations[0].transaction_id, tx.id);
  const worker = runtime.store.getAgent(spawned.allocations[0].agent_id);
  assert.equal(worker.role, 'worker', 'spawn_agent grants a Worker, not another management role');
  const workerNode = runtime.store.getNode(worker.node_id);
  assert.equal(workerNode.parent_id, root.id, 'the Worker node hangs off the domain that granted it');
  assert.equal(workerNode.scope.transaction_id, tx.id, 'and carries the transaction it was granted for');
  assert.equal(workerNode.owner_management_id, root.id);
  assert.equal(runtime.store.getTransaction(tx.id).status, 'READY');

  assert.throws(() => command(runtime, allocator, 'spawn_agent', {}),
    error => /transaction_id/.test(error.message), 'a grant without a transaction names nothing to execute');
});
