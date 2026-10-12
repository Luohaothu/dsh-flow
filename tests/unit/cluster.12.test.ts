/**
 * Mechanism tests for ClusterRuntime: the management tree, transaction
 * lifecycle, role permissions, business acceptance, budgets, communication, the
 * reparent safety point and cancellation.
 *
 * These drive the public Runtime API with an injected clock and no scheduler
 * tick, so every assertion is about durable behaviour rather than a model.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureParams, publishFixtureResult } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';

import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { FlowActor, FlowAgentActor, FlowCommandOutcome, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole } from '../../packages/dsh-flow/src/types.ts';

// ---------------------------------------------------------------- test harness

/** The fake host this suite drives the plugin with. */
import type { FakeHost } from './fake-host.ts';

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


function correctionFixture12(t: TestContext) {
  const host = createFakeHost(), runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [], objective: 'Repair the arithmetic deliverable.', workspace: '/tmp', capabilities: [], acceptance_criteria: ['The answer equals 5.'],
    budget: { tool_calls: 2000, agents: 16, max_active_agents: 2 }, limits: { max_active_agents: 2, max_corrections: 2 } }).cluster.id;
  const root = rootNode(runtime, clusterId), lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.rootTransactions(clusterId), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  const publish = (value: number) => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { value }, current_result_ref: null, current_validation_ref: null });
  const reject = () => command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: false, checks: [{ passed: false }] });
  const repair = (value: number) => { command(runtime, lead, 'adjust_transaction', { transaction_id: tx.id, inputs: { candidate: value } }); command(runtime, lead, 'dispatch', { transaction_id: tx.id }); publish(value); };
  return { host, runtime, clusterId, root, lead, tx, publish, reject, repair };
}

// ==== CHUNK START ====
/**
 * Read string-list fields carried by pending actions but absent from their
 * current interface. Non-array values remain absent; entries are narrowed.
 */
function pendingStrings12(action: { readonly action: string } | undefined, key: string): readonly string[] {
  if (action === undefined) return [];
  const value = objectField(action, 'pending action')[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item: unknown): item is string => typeof item === 'string');
}

test('a parent waits for its declared delegated generation before aggregation and acceptance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-parent-waits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'a parent waits for its children', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const parentId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'the parent', acceptance_criteria: ['x'],
  }).result.transaction_id, 'parent id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: parentId, fixture_execution: 'management' });
  const child = command(runtime, allocator, 'spawn_management_node', { transaction_id: parentId }).result;
  const childNodeId = textOf(child.node_id, 'child node id');
  const childTxId = textOf(child.delegated_transaction_id, 'delegated transaction id');
  assert.equal(required(runtime.store.getTransaction(childTxId), 'child').status, 'DRAFT');
  assert.ok(runtime.store.parentsAwaitingChildren(clusterId).includes(parentId));
  const allocatorActions = runtime.pendingFor('allocator', root, required(runtime.store.getCluster(clusterId), 'cluster'),
    required(runtime.store.getAgent(allocator.agent_id), 'allocator'));
  assert.ok(allocatorActions.filter(item => item.action === 'allocate_agent')
    .every(item => !pendingStrings12(item, 'transactions').includes(parentId)));
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: parentId }), /requires worker/);
  assert.throws(() => command(runtime, orchestrator, 'aggregate', { transaction_id: parentId }), /not ACCEPTED/);

  // The execution choice is immutable: allocation cannot later become delegation.
  const earlyId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'one direct worker', acceptance_criteria: ['x'],
  }).result.transaction_id, 'worker task');
  command(runtime, orchestrator, 'dispatch', { transaction_id: earlyId });
  command(runtime, allocator, 'allocate_agent', { transaction_id: earlyId });
  assert.throws(() => command(runtime, allocator, 'spawn_management_node', { transaction_id: earlyId }), /requires management/);
  assert.equal(runtime.store.childrenOfTransaction(clusterId, earlyId).length, 0);
  assert.equal(required(runtime.store.getTransaction(earlyId), 'worker task').attempts, 0);

  // A fixture publication still cannot bypass unfinished delegated work.
  runtime.store.updateTransaction(parentId, { status: 'SUBMITTED', result: { file: 'x' } });
  publishFixtureResult(runtime, parentId);
  assert.throws(() => command(runtime, orchestrator, 'validate', { transaction_id: parentId, accepted: true }), /unfinished child work/);
  runtime.store.updateTransaction(parentId, { status: 'READY', result: null, current_result_ref: null, result_revision: null });

  // Complete the child with its real formal plan, immutable publication and direct business validation.
  const childOrchestrator = actorFor(runtime, clusterId, 'orchestrator', childNodeId);
  command(runtime, childOrchestrator, 'dispatch', { transaction_id: childTxId });
  runtime.store.updateTransaction(childTxId, { status: 'SUBMITTED', result: { file: 'deep/nested/result.txt' } });
  command(runtime, childOrchestrator, 'validate', { transaction_id: childTxId, accepted: true });
  assert.equal(required(runtime.store.getTransaction(childTxId), 'child').status, 'ACCEPTED');
  assert.ok(!runtime.store.parentsAwaitingChildren(clusterId).includes(parentId));
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: parentId }), /requires worker/);
  command(runtime, orchestrator, 'aggregate', { transaction_id: parentId });
  command(runtime, orchestrator, 'validate', { transaction_id: parentId, accepted: true });
  assert.equal(runtime.store.getTransaction(parentId)?.status, 'ACCEPTED');

  // A late child cannot be appended to the formal generation under review.
  assert.throws(() => command(runtime, orchestrator, 'create_transaction', {
    parent_transaction_id: parentId, objective: 'undeclared late child', acceptance_criteria: ['x'],
  }), /ACCEPTED|prepared task child assignments/);
  assert.throws(() => command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parentId, assignment_key: 'late-child',
  }), /assignment_key/);
  assert.equal(runtime.store.currentChildrenOfTransaction(clusterId, parentId).length, 1);
  assert.equal(required(runtime.store.getTransaction(parentId), 'parent').status, 'ACCEPTED');
  const publication = required(runtime.store.getResult(required(runtime.store.getTransaction(parentId), 'parent').current_result_ref), 'aggregate publication');
  assert.deepEqual(publication.source_validation_refs, [required(required(runtime.store.getTransaction(childTxId), 'child').current_validation_ref, 'child validation')]);
});

test('a role grant is sized for the turns the deployment gives it, not three', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolgrant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'tool grants match the run', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  for (const role of roles) {
    const budget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'agent budget').id), 'agent budget');
    assert.ok(Number(budget.tool_calls_limit) >= 5 * 20,
      `the ${role.role} can run the turns it is given: ${budget.tool_calls_limit}`);
  }
  // And the node keeps enough for its roles plus a wave of Workers, far inside the
  // declared cluster budget.
  const nodeBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id), 'node budget');
  assert.ok(Number(nodeBudget.tool_calls_limit) >= 5 * 20 * 3, `the node funds them: ${nodeBudget.tool_calls_limit}`);
  const declared = required(runtime.store.getCluster(clusterId), 'cluster').spec?.budget?.tool_calls ?? 8_192;
  const total = required(runtime.store.get("SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId), 'total').c;
  // The sum can equal it — the root node legitimately holds the remainder — but it can
  // never exceed what the case declared.
  assert.ok(Number(total) <= Number(declared), `the distribution stays inside the declared budget: ${total} of ${declared}`);
});

test('the correction budget counts newly rejected repairs instead of issue creation', t => {
  const f = correctionFixture12(t); f.publish(6); f.reject();
  const issue = firstOf(f.runtime.store.openIssues(f.clusterId, { transaction_id: f.tx.id }), 'business issue');
  assert.equal(issue.corrections, 0); assert.equal(f.runtime.store.getNode(f.root.id)?.status, 'ACTIVE');
  f.repair(7); f.reject(); assert.equal(f.runtime.store.getIssue(issue.id)?.corrections, 1);
  f.repair(8); f.reject(); assert.equal(f.runtime.store.getIssue(issue.id)?.corrections, 2);
  assert.equal(f.runtime.store.getIssue(issue.id)?.status, 'ESCALATED');
});

test('replaying the same rejected repair cannot consume another correction round', t => {
  const f = correctionFixture12(t); f.publish(6); f.reject();
  const issue = firstOf(f.runtime.store.openIssues(f.clusterId, { transaction_id: f.tx.id }), 'issue');
  f.repair(7);
  const params = fixtureParams(f.runtime, f.lead, 'validate', { transaction_id: f.tx.id, accepted: false, checks: [{ passed: false }] });
  const request = { command_id: 'repeat-repair-rejection', action: 'validate', params };
  f.runtime.command(f.lead, request); const revision = f.runtime.store.getTransaction(f.tx.id)?.revision;
  assert.equal(f.runtime.command(f.lead, request).deduped, true);
  assert.equal(f.runtime.store.getTransaction(f.tx.id)?.revision, revision);
  assert.equal(f.runtime.store.getIssue(issue.id)?.corrections, 1);
});

test('a node whose roles have never run is served before busy branches', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-unserved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'a deep node must not starve behind busy branches', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 2 },
  }, { delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 2 }] }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const spawnChild = (nodeId: string | null, objective: string): string => {
    const owningNode = nodeId ?? root.id;
    const manager = actorFor(runtime, clusterId, 'orchestrator', owningNode);
    const domainAllocator = actorFor(runtime, clusterId, 'allocator', owningNode);
    const created = command(runtime, manager, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    return textOf(command(runtime, domainAllocator, 'spawn_management_node', { fixture_prepare_management: true,
      transaction_id: txId, node_id: owningNode, objective, acceptance_criteria: ['x'],
    }).result.node_id, 'node_id');
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1, 'level two');
  // The deep Orchestrator has taken a turn while its Allocator has never run.
  // Continuous root work keeps the
  // window busy so the deep node has to win a slot on merit.
  const deepest = required(runtime.store.getNode(level2), 'deep node');
  const deepOrchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: level2, role: 'orchestrator', limit: 1 }), 'deep orchestrator');
  const deepAllocator = firstOf(runtime.store.listAgents(clusterId, { node_id: level2, role: 'allocator', limit: 1 }), 'deep allocator');
  runtime.store.tx(() => {
    runtime.store.updateAgent(deepOrchestrator.id, { turns: 1 });
    runtime.store.appendEvent(clusterId, 'turn-start', { agent_id: deepOrchestrator.id, role: 'orchestrator' });
    runtime.store.appendEvent(clusterId, 'turn-end', { agent_id: deepOrchestrator.id, role: 'orchestrator', progress: true });
    const deepManager = actorFor(runtime, clusterId, 'orchestrator', level2);
    for (const index of [1, 2]) {
      const id = textOf(command(runtime, deepManager, 'create_transaction', {
        objective: `deep work ${index}`, acceptance_criteria: ['x'],
      }).result.transaction_id, 'transaction_id');
      command(runtime, deepManager, 'dispatch', { transaction_id: id });
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
  const startsForAgent = (agentId: string): number => Number(required(runtime.store.get(
    `SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=?`,
    clusterId, agentId), 'turn start count').c ?? 0);
  for (let pass = 0; pass < 25; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (startsForAgent(deepAllocator.id) > 0) break;
  }
  assert.ok(startsForAgent(deepAllocator.id) > 0,
    `the never-run Allocator was admitted while the window stayed busy: ${startsForAgent(deepAllocator.id)}`);
  void published;
});

test('a mistaken issue can be dismissed without any revision and without blocking', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-dismiss-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'an issue raised in error can be withdrawn', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const validationOwner = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the transaction the Orchestrator misjudged', acceptance_criteria: ['the file exists'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  // The mistaken issue: nothing about the transaction has changed, and it never will.
  command(runtime, validationOwner, 'reopen_transaction', {
    transaction_id: txId, required_change: 'acceptance_criteria is empty', evidence: { checked: false },
  });
  const issue = firstOf(runtime.store.all("SELECT id, status FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId), 'issue');
  assert.equal(issue.status, 'OPEN', 'the mistaken issue is open');
  // Closing it as a correction is impossible (nothing moved) — that is the trap the run hit.
  const closing = (() => {
    try {
      command(runtime, validationOwner, 'resolve_issue', { issue_id: textOf(issue.id, 'issue_id'), decision: 'CORRECTED', evidence: { rechecked: true } });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(closing, 'and it cannot be closed as a correction');
  // Dismissing it is the legal exit, and it needs the Orchestrator's own evidence.
  const undocumented = (() => {
    try {
      command(runtime, validationOwner, 'resolve_issue', { issue_id: textOf(issue.id, 'issue_id'), decision: 'DISMISSED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(undocumented, 'a dismissal must say what was re-checked');
  command(runtime, validationOwner, 'resolve_issue', {
    issue_id: textOf(issue.id, 'issue_id'), decision: 'DISMISSED',
    evidence: { rechecked: 'acceptance_criteria', found: ['the file exists'] },
    notes: 'the criteria are present; the issue was raised in error',
  });
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').status, 'DISMISSED', 'it is dismissed');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status !== 'BLOCKED', true, 'and nothing was blocked');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status !== 'BLOCKED', true, 'not even the cluster');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'issue-dismissed'), 'the withdrawal is recorded');
  // A dismissal is not a correction: it can never stand in for a durable change.
  assert.equal(runtime.store.openIssues(clusterId, { status: 'OPEN' }).length, 0, 'and it is no longer open');
});

test('a spawned node is never born with a scrap tool allowance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'tool allowances are shared fairly', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawned: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective: `branch ${index}`, acceptance_criteria: ['x'],
    });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    const child = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
      transaction_id: txId, objective: `branch ${index}`, acceptance_criteria: ['x'],
    });
    spawned.push(textOf(child.result.node_id, 'node_id'));
  }
  for (const nodeId of spawned) {
    const budget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', nodeId), 'node budget').id), 'node budget');
    // The node's file is handed to its two roles, so the endowment is the node plus
    // what those roles hold.
    const roles = required(firstOf(runtime.store.all(
      "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", nodeId), 'agent budget sum'), 'agent budget sum').c;
    const endowment = Number(budget.tool_calls_limit) + Number(roles ?? 0);
    assert.ok(endowment >= Math.floor(8_192 / 8),
      `a child is not born with a scrap allowance: ${endowment}`);
  }
  const declared = 8_192;
  const total = required(runtime.store.get(
    "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId), 'tool budget total').c;
  assert.ok(Number(total) <= declared, `the distribution stays inside the declaration: ${total} of ${declared}`);

});

test('a management send yields its native turn after delivery so the recipient can act', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-send-yield-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'deliver an allocation request', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 100, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const observed: { receipt: { isError: boolean; value?: unknown }; concluded: boolean }[] = [];
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator' || observed.length > 0) return;
    const receipt = await turn.callTool('flow_communicate', {
      action: 'send', params: { agent: allocator.agent_id, content: 'Please review allocation capacity.' },
    });
    observed.push({ receipt, concluded: turn.concluded });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 15 && observed.length === 0; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const seen = firstOf(observed, 'scheduled send');
  assert.equal(seen.receipt.isError, false, 'the send succeeded');
  assert.equal(jsonObject(JSON.parse(textOf(seen.receipt.value, 'send result')), 'send result').ok, true);
  assert.equal(seen.concluded, true, 'the host must return control before this role polls the unchanged allocation');
});

test('issue resolution and business validation run through the scheduled Orchestrator tool', async t => {
  const f = correctionFixture12(t); f.publish(5);
  const issue = required(f.runtime.store.insertIssue({ id: 'mistaken-business-report', cluster_id: f.clusterId, node_id: f.root.id, transaction_id: f.tx.id,
    reporter_agent_id: f.lead.agent_id, required_change: 'Check whether the answer is absent.' }), 'issue');
  let dismissed = false, accepted = false;
  f.host.setScript(async turn => {
    if (f.runtime.store.getAgentBySession(turn.session.id)?.id !== f.lead.agent_id) return;
    const resolution = await turn.callTool('flow_transaction', { action: 'resolve_issue', params: { issue_id: issue.id, decision: 'DISMISSED', evidence: { observed: 'The current publication contains the answer 5.' } } });
    dismissed = !resolution.isError;
    const validation = await turn.callTool('flow_transaction', { action: 'validate', params: fixtureParams(f.runtime, f.lead, 'validate', { transaction_id: f.tx.id, accepted: true }) });
    accepted = !validation.isError;
  });
  f.runtime.enableScheduling();
  await f.runtime.tick(); await Promise.all(f.runtime.activeTurnIds().map(id => f.runtime.activeTurnFor(id)!.promise));
  assert.equal(dismissed, true); assert.equal(accepted, true);
  assert.equal(f.runtime.store.getIssue(issue.id)?.status, 'DISMISSED'); assert.equal(f.runtime.store.getTransaction(f.tx.id)?.status, 'ACCEPTED');
});

