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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { createBudget } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
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
/** A JSON array read as a list of elements whose own type is not assumed. */
function arrayOf00(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) assert.fail(`${label} is required`);
  return value;
}

/** The `offset` of a following page, omitted exactly when the list has ended. */
function pageParams00(nextOffset: number | null): { offset?: number } {
  return nextOffset === null ? {} : { offset: nextOffset };
}

test('start builds one root management node with three roles and a root transaction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const nodes = runtime.store.listNodes(clusterId, {});
  assert.equal(nodes.length, 1);
  const root = firstOf(nodes, 'root node');
  assert.equal(root.kind, 'management');
  assert.equal(root.depth, 0);
  const roles = runtime.store.listAgents(clusterId, { limit: 10 }).map(agent => agent.role).sort();
  assert.deepEqual(roles, ['allocator', 'auditor', 'orchestrator']);
  const transactions = runtime.store.listTransactions({ cluster_id: clusterId });
  assert.equal(transactions.length, 1);
  assert.equal(firstOf(transactions, 'root transaction').status, 'DRAFT');
  assert.ok(runtime.store.budgetForScope(clusterId, 'root', clusterId));
  assert.ok(runtime.store.budgetForScope(clusterId, 'node', root.id));
});

test('a management node hosts worker and management children at once, and rejects a cycle', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const spawned = command(runtime, allocator, 'spawn_management_node', { transaction_id: tx.id, scope: { objective: 'child domain' } });
  // A second transaction under the same node is the one a worker may run: the first
  // now has delegated work, and its own attempts wait for the child results.
  const flat = command(runtime, orchestrator, 'create_transaction', { objective: 'a flat sibling', acceptance_criteria: ['x'] });
  const flatId = textOf(flat.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: flatId });
  if (required(runtime.store.getTransaction(flatId), 'flat transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: flatId, decision: 'approve' });
  }
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: flatId });

  const children = runtime.store.childrenOf(root.id);
  assert.deepEqual(children.map(node => node.kind).sort(), ['management', 'worker']);
  const spawnedNodeId = textOf(spawned.result.node_id, 'node_id');
  assert.equal(required(runtime.store.getNode(spawnedNodeId), 'spawned node').parent_id, root.id);
  assert.equal(runtime.store.countAgents(clusterId, { live: true }), 7);

  const childTx = required(
    runtime.store.getTransaction(textOf(spawned.result.delegated_transaction_id, 'delegated_transaction_id')),
    'child transaction',
  );
  assert.equal(childTx.parent_transaction_id, tx.id);
  assert.equal(childTx.node_id, spawnedNodeId);

  command(runtime, orchestrator, 'set_dependency', { transaction_id: tx.id, depends_on: [childTx.id] });
  assert.throws(
    () => command(runtime, orchestrator, 'set_dependency', { transaction_id: childTx.id, depends_on: [tx.id] }),
    error => rejectionStatus(error) === 409 && /cycle/i.test(messageOf(error)),
  );
  assert.equal(allocator.role, 'allocator');
  assert.ok(textOf(jsonObject(firstOf(arrayOf00(allocated.result.allocations, 'allocations'), 'allocation'), 'allocation').agent_id, 'agent_id'));
});

test('a deep role sees its real management ancestors without reading their private transactions', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 4, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 4_000_000, model_requests: 1_000, tool_calls: 2_000,
      wall_time_ms: 3_600_000, agents: 64, max_active_agents: 4 },
  });
  let node = rootNode(runtime, clusterId);
  let tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  const ancestors: string[] = [];
  for (let level = 1; level <= 3; level += 1) {
    ancestors.push(node.id);
    const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { transaction_id: tx.id, scope: { objective: `depth ${level}` } }).result;
    node = required(runtime.store.getNode(textOf(spawned.node_id, 'node_id')), 'spawned node');
    tx = required(runtime.store.getTransaction(textOf(spawned.delegated_transaction_id, 'delegated_transaction_id')), 'delegated transaction');
  }
  const role = actorFor(runtime, clusterId, 'orchestrator', node.id);
  const details = runtime.query(role, 'node', { id: node.id });
  assert.deepEqual(details.ancestors.map(entry => entry.id), ancestors);
  assert.deepEqual(details.ancestors.map(entry => entry.depth), [0, 1, 2]);
  assert.equal(details.node.depth, 3);
  assert.equal(runtime.query(role, 'nodes').items.length, 1, 'the readable domain remains the local subtree');
  assert.throws(() => runtime.query(role, 'node', { id: firstOf(ancestors, 'ancestor') }),
    error => rejectionStatus(error) === 403, 'an ancestor reference must not expose its transactions or agents');
});

test('a child role cannot select another domain through context or summary references', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const parentTx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const childId = textOf(command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: parentTx.id, scope: { objective: 'private child' } }).result.node_id, 'node_id');
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
    error => rejectionStatus(error) === 403);
  assert.throws(() => runtime.query(child, 'context', { agent_id: child.agent_id, transaction_id: parentTx.id }),
    error => rejectionStatus(error) === 403);
  assert.throws(() => runtime.query(child, 'health', { node_id: root.id }),
    error => rejectionStatus(error) === 403);
  assert.throws(() => runtime.query(child, 'summary', { node_id: root.id }),
    error => rejectionStatus(error) === 403);
  assert.throws(() => runtime.query(child, 'summary', { transaction_id: parentTx.id }),
    error => rejectionStatus(error) === 403);
  assert.deepEqual(runtime.query(child, 'issues').items, []);
  assert.deepEqual(runtime.query(child, 'effects').items, []);
  assert.throws(() => runtime.query(child, 'issue', { id: 'root-private-issue' }),
    error => rejectionStatus(error) === 403);
  assert.throws(() => runtime.query(child, 'effect', { call_id: 'root-private-effect' }),
    error => rejectionStatus(error) === 403);
  const parentContext = runtime.query({ cluster_id: clusterId, role: 'user' }, 'context',
    { agent_id: rootAuditor.agent_id });
  assert.equal(textOf(jsonObject(required(parentContext.summary, 'parent summary'), 'summary').secret, 'secret'),
    'only the parent may read this conclusion');
  assert.equal(runtime.query(child, 'summary').summary, null);
});

test('scoped transaction, audit, issue and usage pages do not lose a child behind earlier root rows', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const rootTx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const rootRows: string[] = [];
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
  const child = required(runtime.store.getNode(textOf(spawned.node_id, 'node_id')), 'child node');
  const childRows: string[] = [];
  const childAgent = firstOf(runtime.store.listAgents(clusterId, { node_id: child.id, role: 'auditor' }), 'child auditor');
  const rootAgent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' }), 'root auditor');
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
        transaction_id: required(rootRows[index], 'root transaction row'), kind: 'plan', target_revision: 1,
      });
    }
    for (let index = 0; index < 13; index += 1) {
      runtime.store.insertAudit({
        id: `zzz-audit-${index}`, cluster_id: clusterId, node_id: child.id,
        transaction_id: required(childRows[index], 'child transaction row'), kind: 'plan', target_revision: 1,
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
  const nextIssues = runtime.query(actor, 'issues', pageParams00(issues.next_offset));
  const laterIssues = runtime.query(actor, 'issues', pageParams00(nextIssues.next_offset));
  const finalIssues = runtime.query(actor, 'issues', pageParams00(laterIssues.next_offset));
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
  const lastUsage = runtime.query(actor, 'usage', pageParams00(usage.next_offset));
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
  const parent = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  runtime.store.tx(() => {
    const rows: Array<readonly [string, string | null]> = [['first-child', parent.id], ['unrelated-child', null], ['second-child', parent.id]];
    for (const [id, parentId] of rows) {
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
  const second = runtime.query(auditor, 'transactions', { parent_id: parent.id, ...pageParams00(first.next_offset), limit: 1 });
  assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), new Set(['first-child', 'second-child']));
  assert.equal(second.next_offset, null);
});

test('list queries bound model context while per-id transaction evidence remains complete', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
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
  assert.equal(textOf(jsonObject(node.node.scope, 'node scope').objective, 'objective').length <= 160, true);
  assert.equal(textOf(jsonObject(runtime.query(auditor, 'node', { id: root.id, full: true }).node.scope, 'full node scope').objective, 'objective'), evidence,
    'the owning role can still inspect the complete scope explicitly');
  assert.equal(textOf(jsonObject(runtime.query({ cluster_id: clusterId, role: 'user' }, 'node', { id: root.id }).node.scope, 'user node scope').objective, 'objective'), evidence,
    'the host sees the full source of truth');
  const detail = runtime.query(auditor, 'transaction', { id: tx.id });
  assert.equal(textOf(jsonObject(detail.result, 'result').evidence, 'evidence'), evidence);
  assert.equal(textOf(jsonObject(firstOf(arrayOf00(jsonObject(detail.validation, 'validation').checks, 'checks'), 'check'), 'check').evidence, 'evidence'), evidence);
  assert.equal(firstOf(nodes.items, 'node').id, root.id);
  assert.equal(required(agents.items.find(agent => agent.id === auditor.agent_id), 'auditor agent').role, 'auditor');
  assert.equal(firstOf(transactions.items, 'transaction').id, tx.id);
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
  const second = runtime.query(actor, 'agents', pageParams00(first.next_offset));
  const third = runtime.query(actor, 'agents', pageParams00(second.next_offset));
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [8, 8, 2]);
  assert.equal(third.next_offset, null);
  const host = runtime.query({ cluster_id: clusterId, role: 'user' }, 'agents', { limit: 100 });
  assert.equal(host.items.length, 18, 'the host may still request a full identity page');
});

test('unresolved Auditor issues stay on the first bounded model page ahead of historical verdicts', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
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
  assert.equal(firstOf(page.items, 'issue').id, 'needs-review');
  assert.equal(firstOf(page.items, 'issue').status, 'OPEN');
  assert.equal(page.total, 6);
  assert.equal(runtime.query(actorFor(runtime, clusterId, 'auditor', root.id), 'issues',
    pageParams00(page.next_offset)).items.length, 2);
});

test('issue and effect list pages reference complete per-id evidence without replaying it into a role session', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const evidence = 'trace:'.repeat(3_500);
  const issue = required(runtime.store.insertIssue({
    id: 'issue-with-evidence', cluster_id: clusterId, node_id: root.id,
    transaction_id: tx.id, reporter_agent_id: auditor.agent_id,
    required_change: 'correct the write scope', evidence: { trace: evidence },
  }), 'issue');
  const effect = required(runtime.store.insertEffect({
    call_id: 'effect-with-evidence', cluster_id: clusterId, agent_id: auditor.agent_id,
    node_id: root.id, lease_epoch: 1, tool: 'read', status: 'SETTLED',
    args: { file_path: 'result.txt' }, body: { trace: evidence },
  }), 'effect');
  const issues = runtime.query(auditor, 'issues');
  const effects = runtime.query(auditor, 'effects');
  assert.ok(JSON.stringify(issues).length < 1_500, 'issue lists carry ids and change summaries, not the raw trace');
  assert.ok(JSON.stringify(effects).length < 1_500, 'effect lists carry ids and outcomes, not the raw tool body');
  assert.equal(firstOf(issues.items, 'issue').id, issue.id);
  assert.equal(firstOf(effects.items, 'effect').call_id, effect.call_id);
  const issueDetail = runtime.query(auditor, 'issue', { id: issue.id }).issue;
  assert.equal(textOf(jsonObject(jsonObject(issueDetail, 'issue').evidence, 'issue evidence').trace, 'trace'), evidence);
  const effectDetail = runtime.query(auditor, 'effect', { call_id: effect.call_id }).effect;
  assert.equal(jsonObject(JSON.parse(textOf(jsonObject(effectDetail, 'effect').body, 'body')), 'effect body').trace, evidence);
  const panelIssue = firstOf(runtime.query({ cluster_id: clusterId, role: 'user' }, 'issues').items, 'issue');
  assert.equal(textOf(jsonObject(jsonObject(panelIssue, 'issue').evidence, 'issue evidence').trace, 'trace'), evidence,
    'the host dashboard still reads complete issue details');
  const panelEffect = firstOf(runtime.query({ cluster_id: clusterId, role: 'user' }, 'effects').items, 'effect');
  assert.equal(jsonObject(JSON.parse(textOf(jsonObject(panelEffect, 'effect').body, 'body')), 'effect body').trace, evidence,
    'the host still reads complete effect receipts');
  assert.throws(() => runtime.query(actorFor(runtime, clusterId, 'allocator', root.id), 'effect', { call_id: 'missing' }),
    error => rejectionStatus(error) === 404);
});

test('transaction detail keeps current result evidence but references historical audits and issues for model roles', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const priorEvidence = 'prior audit transcript '.repeat(1_000);
  const audit = required(runtime.store.insertAudit({
    id: 'large-prior-audit', cluster_id: clusterId, transaction_id: tx.id,
    node_id: root.id, kind: 'plan', target_revision: tx.revision,
  }), 'prior audit');
  runtime.store.decideAudit(audit.id, 'APPROVED', auditor.agent_id, { trace: priorEvidence });
  const issue = required(runtime.store.insertIssue({
    id: 'large-prior-issue', cluster_id: clusterId, node_id: root.id,
    transaction_id: tx.id, reporter_agent_id: auditor.agent_id,
    evidence: { trace: priorEvidence }, required_change: 'check the current evidence',
  }), 'prior issue');
  runtime.store.updateTransaction(tx.id, {
    result: { output: 'real result' },
    validation: { checks: [{ criterion: 'result exists', passed: true, evidence: 'observed' }] },
    result_revision: tx.revision,
  });
  const detail = runtime.query(auditor, 'transaction', { id: tx.id });
  assert.ok(JSON.stringify(detail).length < 4_000,
    'a repeated per-id read does not replay every prior audit and issue trace');
  assert.deepEqual(detail.result, { output: 'real result' });
  assert.equal(textOf(jsonObject(firstOf(arrayOf00(jsonObject(detail.validation, 'validation').checks, 'checks'), 'check'), 'check').evidence, 'evidence'), 'observed');
  assert.equal(firstOf(detail.audits, 'audit').id, audit.id);
  assert.equal(firstOf(detail.issues, 'issue').id, issue.id);
  assert.equal(textOf(jsonObject(runtime.query(auditor, 'audit', { id: audit.id }).audit.evidence, 'audit evidence').trace, 'trace'), priorEvidence);
  const issueDetail = runtime.query(auditor, 'issue', { id: issue.id }).issue;
  assert.equal(textOf(jsonObject(jsonObject(issueDetail, 'issue').evidence, 'issue evidence').trace, 'trace'), priorEvidence);
  assert.throws(() => runtime.query(auditor, 'transaction', { id: tx.id, full: true }),
    error => rejectionStatus(error) === 400 && /audit.*id/.test(messageOf(error)),
    'model roles must request historical evidence by audit id rather than one unbounded transaction response');
  assert.throws(() => runtime.query(auditor, 'transaction', { transaction_id: tx.id }),
    error => rejectionStatus(error) === 400 && /params\.id/.test(messageOf(error)),
    'a model passing the mutation API key must get the query key, not an ambiguous missing transaction');
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: tx.id });
  assert.equal(textOf(jsonObject(firstOf(panel.audits, 'audit').evidence, 'audit evidence').trace, 'trace'), priorEvidence);
  assert.equal(textOf(jsonObject(jsonObject(firstOf(panel.issues, 'issue'), 'issue').evidence, 'issue evidence').trace, 'trace'), priorEvidence);
});

test('a role reads aggregated child evidence by child id instead of replaying the same child result inside its parent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const evidence = 'child witnessed the write '.repeat(1_000);
  runtime.store.updateTransaction(tx.id, {
    result: { kind: 'aggregate', summary: 'child result accepted',
      children: [{ transaction_id: 'child-transaction', result_revision: 3, conclusion: evidence, evidence: { trace: evidence } }] },
  });
  const detail = runtime.query(actorFor(runtime, clusterId, 'orchestrator', root.id), 'transaction', { id: tx.id });
  const aggregateChild = jsonObject(firstOf(arrayOf00(jsonObject(detail.result, 'result').children, 'children'), 'child'), 'child');
  assert.equal(textOf(aggregateChild.transaction_id, 'transaction_id'), 'child-transaction');
  assert.equal(numberOf(aggregateChild.result_revision, 0, 1_000_000, 'result_revision'), 3);
  assert.ok(!JSON.stringify(detail).includes(evidence),
    'a parent references the child result instead of copying it into every transaction read');
  assert.equal(arrayOf00(jsonObject(detail.transaction, 'transaction').acceptance_criteria, 'acceptance_criteria').length, tx.acceptance_criteria.length);
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'transaction', { id: tx.id });
  const panelChild = jsonObject(firstOf(arrayOf00(jsonObject(panel.result, 'result').children, 'children'), 'child'), 'child');
  assert.equal(textOf(jsonObject(panelChild.evidence, 'evidence').trace, 'trace'), evidence,
    'the host dashboard still has complete saved aggregate evidence');
});

test('a role pages budget ledgers without forcing the whole tree into one model tool result', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const actor = actorFor(runtime, clusterId, 'allocator', root.id);
  const parent = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'parent budget');
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
  const firstBudget = jsonObject(firstOf(first.items, 'budget'), 'budget');
  assert.ok(numberOf(jsonObject(firstBudget.available, 'available').tokens, 0, 1_000_000, 'tokens') >= 0, 'the Allocator can choose a source with sufficient tokens');
  assert.equal(firstBudget.tokens, undefined, 'a role does not receive the redundant full budget accounting in a list');
  const second = runtime.query(actor, 'budgets', pageParams00(first.next_offset));
  assert.equal(second.offset, 6);
  assert.equal(second.total, first.total);
  assert.equal(second.items.length, 6);
  assert.notEqual(firstOf(second.items, 'budget').id, firstOf(first.items, 'budget').id);
  const panel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'budgets', { limit: 20 });
  assert.equal(panel.limit, 20, 'host dashboard still requests a complete 20-row budget page');
  assert.equal(panel.items.length, 20);
  const nextPanel = runtime.query({ cluster_id: clusterId, role: 'user' }, 'budgets',
    { limit: 20, ...pageParams00(panel.next_offset) });
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
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: rootTx.id, scope: { objective: 'write deep/nested/result.txt' } }).result;
  const child = required(runtime.store.getNode(textOf(spawned.node_id, 'node_id')), 'child node');
  const tx = required(runtime.store.getTransaction(textOf(spawned.delegated_transaction_id, 'delegated_transaction_id')), 'child transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id), 'dispatch', { transaction_id: tx.id });
  const allocation = jsonObject(firstOf(arrayOf00(command(runtime, actorFor(runtime, clusterId, 'allocator', child.id),
    'allocate_agent', { transaction_id: tx.id, write_scope: ['deep/nested'] }).result.allocations, 'allocations'), 'allocation'), 'allocation');
  const worker = required(runtime.store.getAgent(textOf(allocation.agent_id, 'agent_id')), 'worker agent');
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'child-worker-write', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    lease_epoch: 1, tool: 'write', args: { file_path: 'deep/nested/result.txt' }, status: 'SETTLED',
  }));
  const result = runtime.query(actorFor(runtime, clusterId, 'auditor', child.id),
    'effects', { agent_id: worker.id });
  const effect = required(result.items.find(entry => entry.call_id === 'child-worker-write'), 'child write effect');
  assert.equal(effect.node_id, worker.node_id, 'the effect keeps the physical Worker node');
  assert.notEqual(worker.node_id, child.id, 'the agent runs in a child Worker node');
  assert.equal(textOf(jsonObject(effect, 'effect').owner_management_id, 'owner_management_id'), child.id, 'the Auditor can judge the parent-management ownership independently');
});

test('a parent cannot escalate unfinished delegated work before its child can correct', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const parent = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'parent transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: parent.id });
  const child = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parent.id, scope: { objective: 'child work' },
  }).result;
  const childTxId = textOf(child.delegated_transaction_id, 'delegated_transaction_id');
  assert.equal(required(runtime.store.getTransaction(childTxId), 'child transaction').status, 'DRAFT');
  assert.throws(() => command(runtime, orchestrator, 'escalate', {
    transaction_id: parent.id, reason: 'the child has not finished yet',
  }), error => rejectionStatus(error) === 409 && /child|delegat/i.test(messageOf(error)));
  assert.equal(required(runtime.store.getTransaction(parent.id), 'parent transaction').status, 'READY',
    'an active child does not make its parent terminal');
  runtime.store.tx(() => runtime.store.updateTransaction(childTxId, { status: 'FAILED' }));
  command(runtime, orchestrator, 'escalate', {
    transaction_id: parent.id, reason: 'the child failed and the parent cannot aggregate it',
  });
  assert.equal(required(runtime.store.getTransaction(parent.id), 'parent transaction').status, 'BLOCKED',
    'a terminal failed child may be reported as unresolvable');
});

test('role permissions reject cross-role actions and domain escapes', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  assert.throws(() => command(runtime, orchestrator, 'spawn_agent', { transaction_id: tx.id }), error => rejectionStatus(error) === 403);
  assert.throws(() => command(runtime, allocator, 'accept_result', { transaction_id: tx.id }), error => rejectionStatus(error) === 403);
  assert.throws(() => command(runtime, auditor, 'validate', { transaction_id: tx.id, accepted: true }), error => rejectionStatus(error) === 403);

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
  const workerActor = actorFor(runtime, clusterId, 'worker', worker.node_id);
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING' }));
  assert.throws(() => command(runtime, workerActor, 'dispatch', { transaction_id: tx.id }), error => rejectionStatus(error) === 403);
  assert.throws(() => command(runtime, workerActor, 'submit_result', { transaction_id: 'nope', result: 1 }), error => rejectionStatus(error) === 404);
});

test('an open correction requires a new plan revision before redispatch', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const issueId = textOf(command(runtime, auditor, 'request_replan', {
    transaction_id: tx.id, required_change: 'correct the write scope before sending another Worker',
  }).result.issue_id, 'issue_id');
  const issue = required(runtime.store.getIssue(issueId), 'issue');
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'DRAFT');
  const pending = runtime.pendingFor('orchestrator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(orchestrator.agent_id), 'orchestrator agent'));
  assert.equal(pending.find(item => item.transaction_id === tx.id)?.action, 'revise-plan',
    'the Orchestrator is offered a correction, not an identical redispatch');
  assert.throws(() => command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id }),
    error => rejectionStatus(error) === 409 && /issue|correct|revis/i.test(messageOf(error)));
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'DRAFT',
    'a rejected dispatch cannot move the transaction or reuse its old audit');
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['output'] },
  });
  assert.ok(required(runtime.store.getTransaction(tx.id), 'transaction').revision > required(issue.target_revision, 'target_revision'));
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'READY');
  assert.equal(runtime.store.findAudit(clusterId, tx.id, 'plan', required(runtime.store.getTransaction(tx.id), 'transaction').revision)?.decision, 'PENDING');

  const falseId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'a separate valid plan', acceptance_criteria: ['the separate output exists'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: falseId });
  command(runtime, auditor, 'inspect_plan', { transaction_id: falseId, decision: 'approve' });
  const oldAudit = required(runtime.store.findAudit(clusterId, falseId, 'plan', required(runtime.store.getTransaction(falseId), 'transaction').revision), 'old audit');
  const falseIssue = textOf(command(runtime, auditor, 'request_replan', {
    transaction_id: falseId, required_change: 'incorrectly claimed that criteria were absent',
  }).result.issue_id, 'issue_id');
  command(runtime, auditor, 'verify_correction', {
    issue_id: falseIssue, decision: 'dismissed',
    evidence: { rechecked: 'acceptance_criteria', found: ['the separate output exists'] },
  });
  assert.equal(runtime.query(auditor, 'issues', { status: 'DISMISSED' }).items
    .find(row => row.id === falseIssue)?.status, 'DISMISSED',
  'a dismissed issue remains readable through the role-scoped issue query');
  assert.equal(runtime.query(auditor, 'transaction', { id: falseId }).issues
    .find(row => row.id === falseIssue)?.status, 'DISMISSED',
  'transaction history preserves a dismissed audit issue');
  const sameRevision = required(runtime.store.getTransaction(falseId), 'transaction').revision;
  command(runtime, orchestrator, 'dispatch', { transaction_id: falseId });
  const rechecked = required(runtime.store.findAudit(clusterId, falseId, 'plan', sameRevision), 'rechecked audit');
  assert.notEqual(rechecked.id, oldAudit.id, 'a dismissed issue may proceed, but not by reusing its withdrawn audit');
  assert.equal(rechecked.decision, 'PENDING');
});

test('a rejected result gives its Orchestrator the actual scope and unchanged contract to repair', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const txId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'deliver deep/nested/result.txt',
    inputs: { write_scope: ['deep/staging'] },
    acceptance_criteria: ['deep/nested/result.txt exists'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  runtime.store.tx(() => runtime.store.updateTransaction(txId, {
    status: 'SUBMITTED', result: { file: 'deep/staging/result.txt' },
  }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: txId, accepted: true,
    checks: [{ criterion: 'deep/nested/result.txt exists', passed: true, evidence: 'Worker claimed its staging file was sufficient' }],
  });
  const issueId = textOf(command(runtime, auditor, 'request_correction', {
    transaction_id: txId,
    required_change: 'the accepted result must include deep/nested/result.txt',
  }).result.issue_id, 'issue_id');
  const offered = required(runtime.pendingFor('orchestrator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(orchestrator.agent_id), 'orchestrator agent'))
    .find(item => item.transaction_id === txId), 'offered action');
  const offeredAction = jsonObject(offered, 'offered action');
  assert.equal(textOf(offeredAction.action, 'action'), 'correct-result');
  assert.equal(textOf(offeredAction.issue_id, 'issue_id'), issueId);
  assert.deepEqual(offeredAction.write_scope, ['deep/staging']);
  assert.deepEqual(offeredAction.acceptance_criteria, ['deep/nested/result.txt exists']);
  assert.match(textOf(offeredAction.required_change, 'required_change'), /deep\/nested\/result\.txt/);
});

test('the Orchestrator dispatches, the Auditor supervises, and a stale validation is not accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // The Orchestrator owns the transaction: dispatching it makes it *ready*.
  // The Auditor's plan audit is observational supervision — if it never decides,
  // the work still runs, which is the difference between a supervisor and a
  // single point of failure.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const dispatched = required(runtime.store.getTransaction(tx.id), 'dispatched transaction');
  assert.equal(dispatched.status, 'READY', 'dispatch makes the plan dispatchable');
  assert.equal(dispatched.plan_approved_revision, null, 'without the Auditor, nothing is claimed as approved');
  const pending = runtime.store.pendingAudits(clusterId, { kind: 'plan', limit: 10 });
  assert.equal(pending.length, 1, 'and the Auditor still has a decision to make');

  // A Worker can claim it without any audit decision.
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 1, 'a silent Auditor does not stall the subtree');

  // The Auditor's approval is recorded as evidence when it does arrive.
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').plan_approved_revision, dispatched.revision);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'READY', 'observational: it was already ready');
  const audit = required(runtime.store.findAudit(clusterId, tx.id, 'plan', dispatched.revision), 'plan audit');
  assert.equal(audit.decision, 'APPROVED');

  // And its rejection still has teeth: the plan goes back to DRAFT.
  const second = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  assert.equal(required(runtime.store.getTransaction(second), 'transaction').status, 'READY');
  const rejected = command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'reject', required_change: 'the criteria are not checkable' });
  assert.equal(rejected.result.status, 'DRAFT', 'a rejected plan is pulled back before its allocation works');
  assert.equal(required(runtime.store.getTransaction(second), 'transaction').plan_approved_revision, null);
  assert.ok(rejected.result.issue_id);

  // A result published against a moved revision is not accepted by a stale audit.
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { value: 5 } }));
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true,
    checks: [{ criterion: 'result holds 5', passed: true, evidence: 'result.value' }],
  });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'VALIDATING');
  assert.throws(() => command(runtime, orchestrator, 'accept_result', { transaction_id: tx.id }), error => rejectionStatus(error) === 409);

  const approved = command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(approved.result.status, 'ACCEPTED');
  // The rejected plan is still open work: the cluster is not done until every
  // root transaction is decided.
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING');
  // A cancelled root cannot be reported as success: the cluster blocks with the
  // reason instead of claiming a completion it did not achieve.
  command(runtime, orchestrator, 'cancel_transaction', { transaction_id: second, reason: 'superseded by the first' });
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
  const blockedEvent = required(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked').at(-1), 'cluster-blocked event');
  assert.match(textOf(jsonObject(blockedEvent.data, 'event data').reason, 'reason'), /did not all reach ACCEPTED/);
  void worker;
});

test('a FAILED transaction cannot bypass its exhausted attempt cap by redispatching the same revision', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'FAILED', attempts: 2, __bump_revision: false,
  }));
  assert.throws(() => command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id }),
    error => rejectionStatus(error) === 409 && /FAILED/.test(messageOf(error)));
  const after = required(runtime.store.getTransaction(tx.id), 'failed transaction');
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
  // `fs_write` maps to `write` and `edit`; the turn is refused before its prompt
  // unless both resolve. The Worker only writes, so `edit` is inert.
  host.registerTool({
    name: 'edit', description: 'filesystem admission fixture', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute() { assert.fail('edit is not scripted in this fixture'); },
  });
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    maxTokens: 512, tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent',
    { transaction_id: tx.id, write_scope: ['result.txt'] });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
  let held = false;
  const capturedResults00: { readonly isError: boolean }[] = [];
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker')) return;
    await turn.request({ purpose: 'worker' });
    held = true;
    await gate;
    capturedResults00.push(await turn.callTool('write', { file_path: path, content: 'correct result\n' }));
    capturedResults00.push(await turn.callTool('flow_transaction', {
      action: 'submit_result', params: { transaction_id: tx.id, result: { file: 'result.txt', completed: true } },
    }));
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20 && !held; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const { promise: delay, resolve: resume } = Promise.withResolvers<void>();
    setTimeout(resume, 10);
    // eslint-disable-next-line no-await-in-loop
    await delay;
  }
  assert.equal(held, true, 'a real Worker turn holds the running transaction');
  const live = runtime.activeTurnFor(worker.id);
  assert.ok(live);
  const decision = command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', {
    transaction_id: tx.id, decision: 'reject', required_change: 'the output needs an independent review',
  }).result;
  assert.equal(decision.decision, 'REJECTED');
  assert.equal(required(runtime.store.getTransaction(tx.id), 'running transaction').status, 'RUNNING',
    'the independent verdict must not revoke the live submission contract mid-turn');
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id),
    'adjust_transaction', { transaction_id: tx.id, patch: { objective: 'a revised deliverable' } }),
  error => rejectionStatus(error) === 409 && /turn|lease|running/i.test(messageOf(error)),
  'the Orchestrator cannot change the running revision before the Worker submits its result');
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'auditor', root.id),
    'request_replan', { transaction_id: tx.id, required_change: 'revise the output path' }),
  error => rejectionStatus(error) === 409 && /turn|lease|running/i.test(messageOf(error)),
  'a second audit action cannot silently invalidate the same running Worker');
  release();
  await live.promise;
  const submission = capturedResults00[1];
  const writeResponse = capturedResults00[0];
  assert.ok(submission && !submission.isError, 'the running Worker can publish its durable result');
  assert.ok(writeResponse && !writeResponse.isError, `the native write settled: ${JSON.stringify(writeResponse)}`);
  assert.equal(existsSync(path), true);
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event => {
    const eventData = jsonObject(event.data, 'event data');
    return event.type === 'result-submitted' && eventData.transaction_id === tx.id && eventData.agent_id === worker.id;
  }));
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'DRAFT',
    'after the Worker finishes, the rejected revision waits for correction, not acceptance');
});

test('a restart fences a Worker without reviving its already rejected plan', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx.id });
  const allocation = required(runtime.store.activeAllocationForTransaction(tx.id), 'active allocation');
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
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'RUNNING');
  runtime.recover({ deferScheduling: true });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'DRAFT',
    'fencing a crashed Worker cannot redispatch a plan the Auditor already rejected');
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 0);
});