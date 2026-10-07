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
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';

import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import { DEFAULT_CONTEXT_LIMITS } from '../../packages/dsh-flow/src/core/protocol.ts';
import type { FlowActor, FlowAgentActor, FlowCommandOutcome, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowContextLimits } from '../../packages/dsh-flow/src/types.ts';

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

/** Fill a partial per-role context limit set from the deployment defaults. */
function contextLimits(overrides: Partial<FlowContextLimits>): FlowContextLimits {
  return { ...DEFAULT_CONTEXT_LIMITS, ...overrides };
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

test('a parent waits for its delegated children before it can be run or accepted', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-parent-waits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a parent waits for its children', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // A parent transaction with a delegated child.
  const parent = command(runtime, orchestrator, 'create_transaction', { objective: 'the parent', acceptance_criteria: ['x'] });
  const parentId = textOf(parent.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: parentId });
  if (required(runtime.store.getTransaction(parentId), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: parentId, decision: 'approve' });
  }
  const child = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parentId, objective: 'the delegated child', acceptance_criteria: ['x'],
  }).result ?? {});
  const childTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: textOf(child.node_id, 'node_id') }), 'child transaction');
  assert.equal(required(runtime.store.getTransaction(childTx.id), 'transaction').status, 'DRAFT', 'the delegated work is unfinished');
  assert.equal(runtime.store.parentsAwaitingChildren(clusterId).includes(parentId), true, 'and the parent is waiting for it');

  // The Allocator is not told to run the parent, and the Orchestrator is not told to
  // validate it, while its child is open.
  const allocatorActions = runtime.pendingFor('allocator', root, cluster,
    runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 })[0]);
  const allocation = allocatorActions.find(action => action.action === 'allocate_agent');
  assert.equal(pendingStrings12(allocation, 'transactions').includes(parentId), false,
    `the parent is not offered for allocation: ${JSON.stringify(allocatorActions.map(a => a.action))}`);

  // The *opposite* order — allocate first, then delegate — cannot run the parent
  // either: eligibility excludes it and admission refuses it, so no turn, request or
  // attempt happens while the child is open.
  const early = command(runtime, orchestrator, 'create_transaction', { objective: 'allocated before it delegated', acceptance_criteria: ['x'] });
  const earlyId = textOf(early.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: earlyId });
  if (required(runtime.store.getTransaction(earlyId), 'transaction').status === 'DRAFT') {
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
  assert.equal(required(runtime.store.getTransaction(earlyId), 'transaction').attempts ?? 0, 0, 'no attempt was spent');
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
  assert.match(messageOf(allocationAttempt), /delegated work still unfinished/);
  assert.equal(required(runtime.store.getTransaction(parentId), 'transaction').attempts ?? 0, 0, 'and no attempt was spent');

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
  assert.match(messageOf(refused), /delegated work still unfinished/);

  // Once the child is terminal, the real positive path runs: aggregate produces the
  // parent's own result, and only then may it be validated.
  runtime.store.tx(() => {
    runtime.store.updateTransaction(childTx.id, { status: 'ACCEPTED', result: { file: 'deep/nested/result.txt' } });
    runtime.store.updateTransaction(parentId, { status: 'READY', result: null });
  });
  assert.equal(runtime.store.parentsAwaitingChildren(clusterId).includes(parentId), false, 'the wait is over');
  const parentAllocationActions = runtime.pendingFor('allocator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(allocator.agent_id), 'allocator agent'))
    .filter(item => item.action === 'allocate_agent');
  assert.ok(parentAllocationActions.every(item => !pendingStrings12(item, 'transactions').includes(parentId)),
    'an accepted child makes its READY parent eligible for aggregation, never for a new Worker');
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: parentId }),
    error => rejectionStatus(error) === 409 && /aggregate/.test(messageOf(error)),
    'a direct allocation cannot bypass the Orchestrator and spend a parent Worker attempt');
  const aggregated = command(runtime, orchestrator, 'aggregate', { transaction_id: parentId });
  assert.equal(required(runtime.store.getTransaction(parentId), 'transaction').status, 'SUBMITTED',
    `aggregate publishes the parent's own result: ${JSON.stringify(aggregated).slice(0, 200)}`);
  const validated = command(runtime, orchestrator, 'validate', {
    transaction_id: parentId, accepted: true,
    checks: [{ criterion: 'the child artifact exists', passed: true, evidence: 'observed' }],
  });
  assert.equal(required(runtime.store.getTransaction(parentId), 'transaction').status, 'VALIDATING',
    `validation opens the independent gate: ${JSON.stringify(validated).slice(0, 200)}`);
  const audit = runtime.store.pendingAudits(clusterId, { kind: 'validation', limit: 8 })
    .filter(row => row.transaction_id === parentId && (row.decision ?? 'PENDING') === 'PENDING')
    .at(-1);
  assert.ok(audit, 'the Auditor has a decision to make');
  const waiting = runtime.pendingFor('orchestrator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(orchestrator.agent_id), 'orchestrator agent'));
  assert.ok(!waiting.some(item => item.action === 'aggregate' && item.transaction_id === parentId),
    'the submitted parent awaits its Auditor, not another aggregate of the same children');
  assert.throws(() => command(runtime, orchestrator, 'aggregate', { transaction_id: parentId }),
    error => rejectionStatus(error) === 409 && /VALIDATING/.test(messageOf(error)));
  assert.equal(required(runtime.store.getTransaction(parentId), 'transaction').result_revision, audit.target_revision,
    'a duplicate aggregate cannot stale the independent decision');
  assert.equal(required(runtime.store.getAudit(audit.id), 'audit').decision, 'PENDING');
  // The other order: a parent *validated* before it delegates cannot be accepted while
  // the child it then spawned is open — the guard sits on the acceptance commit, so the
  // Auditor's approval is refused too.
  const lateChild = (command(runtime, allocator, 'spawn_management_node', {
    transaction_id: parentId, objective: 'a child spawned after validation', acceptance_criteria: ['x'],
  }).result ?? {});
  const lateTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: textOf(lateChild.node_id, 'node_id') }), 'late child transaction');
  assert.equal(required(runtime.store.getTransaction(lateTx.id), 'transaction').status, 'DRAFT', 'the late child is unfinished');
  const approval = (() => {
    try {
      command(runtime, auditor, 'inspect_validation', { audit_id: audit.id, decision: 'approve' });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(approval, 'the approval is refused while the child is open');
  assert.match(messageOf(approval), /delegated work still unfinished/);
  assert.notEqual(required(runtime.store.getTransaction(parentId), 'transaction').status, 'ACCEPTED', 'nothing accepted it');
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
  command(runtime, auditor, 'inspect_validation', { audit_id: reopened.id, decision: 'approve' });
  assert.equal(required(runtime.store.getTransaction(parentId), 'transaction').status, 'ACCEPTED',
    'and only then is the parent accepted');
});

test('a role grant is sized for the turns the deployment gives it, not three', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolgrant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'tool grants match the run', workspace: dir, capabilities: [],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
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

test('the correction budget counts failed rounds, not opened issues', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-correction-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'issues are not rounds', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    // The recursion case's own budget: two correction rounds.
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 24, max_corrections: 2 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = command(runtime, orchestrator, 'create_transaction', { objective: 'the branch under correction', acceptance_criteria: ['x'] });
  const txId = textOf(tx.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  // Two freshly opened issues are not two spent rounds: the Auditor may still replan.
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'first defect' });
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'second defect' });
  assert.equal(runtime.store.countCorrections(clusterId, txId), 0, 'no round has failed yet');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status !== 'BLOCKED', true, 'so the node is not blocked');
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
  assert.match(messageOf(blocked), /correction budget exhausted/);
  // The stop is recorded by the guard and applied by the scheduler, outside the
  // refusal's transaction: one tick later the node is stopped for it.
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'BLOCKED', 'the node stops for it');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.ok(events.some(event => event.type === 'correction-budget-applied'), 'the applied stop is recorded');
  assert.ok(events.some(event => event.type === 'node-blocked' && event.data !== null
    && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.code === 'CORRECTION_BUDGET_EXHAUSTED'),
    'and so is the stop, with its code');
});

test('a rejected repair costs one round, re-reviewing it costs none', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-rounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a round is a repair, not a call', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 24, max_corrections: 2 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = command(runtime, orchestrator, 'create_transaction', { objective: 'the transaction under repair', acceptance_criteria: ['x'] });
  const txId = textOf(tx.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
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
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').corrections, 1, 'the first repair cost one round');
  // Re-reviewing that same state costs nothing: neither the adjustment nor the
  // validation is newer than what the verdict already bound to.
  const repeat = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(repeat, 'unchanged state cannot be charged again');
  assert.match(messageOf(repeat), /no fresh correction/);
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').corrections, 1, 'and the counter did not move');

  // A second repair enables the second charge — and only then does the budget bite.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired twice' } } });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired twice' } } });
  command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').corrections, 2, 'the second repair cost the second round');
  // A further repair with no fresh round left is refused and stops the branch.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired thrice' } } });
  const refused = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: issue.id, decision: 'NOT_FIXED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').status, 'ESCALATED',
    'the issue escalates when its rounds are spent');
  void refused;
});

test('a node whose roles have never run is served before busy branches', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-unserved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a deep node must not starve behind busy branches', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 2 },
  }, { delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 2 }] }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawnChild = (nodeId: string | null, objective: string): string => {
    const created = command(runtime, orchestrator, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    return textOf(command(runtime, allocator, 'spawn_management_node', {
      transaction_id: txId, node_id: nodeId, objective, acceptance_criteria: ['x'],
    }).result.node_id, 'node_id');
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1, 'level two');
  // The failed node's own shape: its Orchestrator has taken a turn, its two plan audits
  // are still pending, and its Auditor has never run. Continuous root work keeps the
  // window busy so the deep node has to win a slot on merit.
  const deepest = required(runtime.store.getNode(level2), 'deep node');
  const deepOrchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: level2, role: 'orchestrator', limit: 1 }), 'deep orchestrator');
  const deepAuditor = firstOf(runtime.store.listAgents(clusterId, { node_id: level2, role: 'auditor', limit: 1 }), 'deep auditor');
  runtime.store.tx(() => {
    runtime.store.updateAgent(deepOrchestrator.id, { turns: 1 });
    runtime.store.appendEvent(clusterId, 'turn-start', { agent_id: deepOrchestrator.id, role: 'orchestrator' });
    runtime.store.appendEvent(clusterId, 'turn-end', { agent_id: deepOrchestrator.id, role: 'orchestrator', progress: true });
    for (const index of [1, 2]) {
      runtime.store.insertAudit({
        id: `audit-deep-${index}`, cluster_id: clusterId, node_id: level2,
        transaction_id: textOf(command(runtime, orchestrator, 'create_transaction', {
          objective: `deep work ${index}`, acceptance_criteria: ['x'],
        }).result.transaction_id, 'transaction_id'),
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
  const startsForAgent = (agentId: string): number => Number(required(runtime.store.get(
    `SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=?`,
    clusterId, agentId), 'turn start count').c ?? 0);
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
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an issue raised in error can be withdrawn', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the transaction the Auditor misjudged', acceptance_criteria: ['the file exists'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  // The mistaken issue: nothing about the transaction has changed, and it never will.
  command(runtime, auditor, 'request_replan', {
    transaction_id: txId, required_change: 'acceptance_criteria is empty', evidence: { checked: false },
  });
  const issue = firstOf(runtime.store.all("SELECT id, status FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId), 'issue');
  assert.equal(issue.status, 'OPEN', 'the mistaken issue is open');
  // Closing it as a correction is impossible (nothing moved) — that is the trap the run hit.
  const closing = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: textOf(issue.id, 'issue_id'), decision: 'VERIFIED', evidence: { rechecked: true } });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(closing, 'and it cannot be closed as a correction');
  // Dismissing it is the legal exit, and it needs the Auditor's own evidence.
  const undocumented = (() => {
    try {
      command(runtime, auditor, 'verify_correction', { issue_id: textOf(issue.id, 'issue_id'), decision: 'DISMISSED', evidence: {} });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(undocumented, 'a dismissal must say what was re-checked');
  command(runtime, auditor, 'verify_correction', {
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

test('a plan audit carries the criteria it is judging, not just where to look', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-audit-facts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an audit names what it judges', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce the deep artifact', acceptance_criteria: ['exactly one child node exists', 'the file exists'],
    expected_output: 'deep/nested/result.txt',
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  const actions = runtime.pendingFor('auditor', root, cluster,
    required(runtime.store.getAgent(firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor').id), 'auditor agent'));
  const audit = actions.find(action => action.action === 'inspect_plan' && action.transaction_id === txId);
  assert.ok(audit, `the plan audit is offered: ${JSON.stringify(actions.map(a => a.action))}`);
  assert.deepEqual(pendingStrings12(audit, 'acceptance_criteria'), ['exactly one child node exists', 'the file exists'],
    'with the criteria it is judging, so an absent list cannot be read as an empty one');
  assert.match(String(audit.objective), /produce the deep artifact/);
  assert.equal(objectField(audit, 'pending action').expected_output, 'deep/nested/result.txt');
});

test('a spawned node is never born with a scrap tool allowance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-toolshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'tool allowances are shared fairly', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 8_388_608, model_requests: 1_024, tool_calls: 8_192, wall_time_ms: 3_600_000, agents: 64, max_active_agents: 6 },
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
    const child = command(runtime, allocator, 'spawn_management_node', {
      transaction_id: txId, objective: `branch ${index}`, acceptance_criteria: ['x'],
    });
    spawned.push(textOf(child.result.node_id, 'node_id'));
  }
  for (const nodeId of spawned) {
    const budget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', nodeId), 'node budget').id), 'node budget');
    // The node's file is handed to its three roles, so the endowment is the node plus
    // what those roles hold.
    const roles = required(firstOf(runtime.store.all(
      "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", nodeId), 'agent budget sum'), 'agent budget sum').c;
    const endowment = Number(budget.tool_calls_limit) + Number(roles ?? 0);
    assert.ok(endowment >= Math.floor(8_192 / 8),
      `a child is not born with a scrap allowance: ${endowment}`);
  }
  // The same fair share funds a node's management turns and Worker wave
  // across tokens, model requests and tool calls.
  for (const nodeId of spawned) {
    const budget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', nodeId), 'node budget').id), 'node budget');
    const roles = firstOf(runtime.store.all(
      "SELECT SUM(tokens_limit) AS t, SUM(requests_limit) AS r FROM budgets WHERE scope_kind='agent' AND node_id=?", nodeId), 'agent budget sums');
    assert.ok(Number(budget.tokens_limit) + Number(roles.t ?? 0) >= Math.floor(8_388_608 / 8),
      `a deep node can fund its own roles: ${Number(budget.tokens_limit) + Number(roles.t ?? 0)}`);
    assert.ok(Number(budget.requests_limit) + Number(roles.r ?? 0) >= Math.floor(1_024 / 8),
      `and their requests: ${Number(budget.requests_limit) + Number(roles.r ?? 0)}`);
  }
  const declared = 8_192;
  const total = required(runtime.store.get(
    "SELECT SUM(tool_calls_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId), 'tool budget total').c;
  assert.ok(Number(total) <= declared, `the distribution stays inside the declaration: ${total} of ${declared}`);
  const declaredTokens = 8_388_608;
  const totalTokens = required(runtime.store.get(
    "SELECT SUM(tokens_limit) AS c FROM budgets WHERE cluster_id=? AND scope_kind IN ('node','agent')", clusterId), 'token budget total').c;
  assert.ok(Number(totalTokens) <= declaredTokens, `and the token distribution too: ${totalTokens} of ${declaredTokens}`);
});

test('a management send yields its native turn after delivery so the recipient can act', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-send-yield-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'deliver an allocation request', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
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

test('the dismissal and the acceptance chain run through scheduled roles and their own tools', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-role-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'roles act through their own tools', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 4_000_000, model_requests: 400, tool_calls: 4_000, wall_time_ms: 900_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce the artifact', acceptance_criteria: ['the file exists'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  // A mistaken issue, exactly as the live run raised one.
  command(runtime, auditor, 'request_replan', { transaction_id: txId, required_change: 'acceptance_criteria is empty' });
  const issue = firstOf(runtime.store.all("SELECT id FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId), 'issue');
  assert.ok(issue, 'the mistaken issue exists');

  // The Auditor dismisses it through its *own* tool, in a scheduled turn.
  let dismissedThroughTool = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    const result = await turn.callTool('flow_audit', {
      action: 'verify_correction',
      params: {
        issue_id: textOf(issue.id, 'issue_id'), decision: 'dismissed',
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
    if (required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').status === 'DISMISSED') break;
  }
  assert.equal(dismissedThroughTool, true, 'the Auditor acted through its own tool');
  assert.equal(required(runtime.store.getIssue(textOf(issue.id, 'issue_id')), 'issue').status, 'DISMISSED', 'and the issue is dismissed');
  assert.ok(runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'issue-dismissed'),
    'the dismissal is on the record');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status !== 'BLOCKED', true, 'nothing was blocked');

  // The acceptance chain, also through real tool calls: a result, a validation, then the
  // Auditor's approval of it.
  runtime.store.tx(() => runtime.store.updateTransaction(txId, { status: 'SUBMITTED', result: { file: 'artifact.txt' } }));
  let validated = false;
  let approved = false;
  let turnRoles: (FlowAgentRole | undefined)[] = [];
  let validationError: string | null = null;
  let approvalError: string | null = null;
  let approvedAuditId: string | null = null;
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
        validated = !result.isError;
        if (!validated) validationError = `tool error: ${JSON.stringify(result).slice(0, 200)}`;
      } catch (error) { validationError = messageOf(error); }
      return;
    }
    if (role !== 'auditor') return;
    const audit = runtime.store.pendingAudits(clusterId, { kind: 'validation', limit: 8 })
      .filter(row => row.transaction_id === txId && (row.decision ?? 'PENDING') === 'PENDING').at(-1);
    if (!audit) return;
    const result = await turn.callTool('flow_audit', { action: 'inspect_validation', params: { audit_id: audit.id, decision: 'approve' } });
    approved = !result.isError;
    if (!approved) approvalError = `tool error: ${JSON.stringify(result).slice(0, 200)}`;
    approvedAuditId = audit.id;
  });
  for (let pass = 0; pass < 25; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (required(runtime.store.getTransaction(txId), 'transaction').status === 'ACCEPTED') break;
  }
  assert.equal(validated, true, `the Orchestrator validated through its tool: ${validationError} turns ${JSON.stringify(turnRoles.slice(-4))}`);
  assert.equal(approved, true, `and the Auditor approved through its own tool: ${approvalError}`);
  const decided = firstOf(runtime.store.all("SELECT id, decision FROM audits WHERE id=?", approvedAuditId), 'decided audit');
  assert.equal(decided?.decision, 'APPROVED', `the exact audit was decided: ${JSON.stringify(decided)}`);
  assert.equal(required(runtime.store.getTransaction(txId), 'transaction').status, 'ACCEPTED', 'the chain completes through the tools');
});

test('an Auditor reviews unchanged issues without a preselected verdict', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-neutral-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'review both a real missing file and a mistaken issue', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const missing = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'write deep/nested/result.txt', acceptance_criteria: ['deep/nested/result.txt exists'],
  }).result.transaction_id, 'transaction_id');
  const valid = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'plan a checkable file', acceptance_criteria: ['the file exists'],
  }).result.transaction_id, 'transaction_id');
  const genuine = textOf(command(runtime, auditor, 'request_replan', {
    transaction_id: missing, required_change: 'deep/nested/result.txt is still absent; revise the write grant',
  }).result.issue_id, 'issue_id');
  const mistaken = textOf(command(runtime, auditor, 'request_replan', {
    transaction_id: valid, required_change: 'the transaction has no acceptance criteria',
  }).result.issue_id, 'issue_id');
  const reviews = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(auditor.agent_id), 'auditor agent'))
    .filter(item => item.action === 'review_issue');
  assert.deepEqual(new Set(reviews.map(item => textOf(objectField(item, 'pending action').issue_id, 'issue_id'))), new Set([genuine, mistaken]),
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
  for (let pass = 0; pass < 12 && required(runtime.store.getIssue(textOf(mistaken, 'issue_id')), 'mistaken issue').status !== 'DISMISSED'; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.equal(queried, true, 'the scheduled Auditor inspected the actual transaction through its tool');
  assert.equal(required(runtime.store.getIssue(textOf(genuine, 'issue_id')), 'genuine issue').status, 'OPEN', 'the real missing-file issue is not dismissed merely for being unchanged');
  assert.equal(required(runtime.store.getIssue(textOf(mistaken, 'issue_id')), 'mistaken issue').status, 'DISMISSED', 'the same turn can retract a demonstrably mistaken issue');
});

test('an unchanged issue does not manufacture endless Auditor turns', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-oneshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a stuck issue does not spin the Auditor', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', { objective: 'a genuine issue', acceptance_criteria: ['x'] });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
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
  const issue = firstOf(runtime.store.all("SELECT id, status FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId), 'issue');
  assert.equal(issue.status, 'OPEN', 'the issue is still open and unaddressed');
  // The Auditor was given the issue once, not once per pass.
  assert.ok(auditorTurns <= 2, `the Auditor was not spun: ${auditorTurns} turns over 30 passes`);
  // (A node whose roles take no-op turns is stopped by the stagnation bound — that is a
  // different rule and a different test's subject; what this one bounds is the *Auditor's*
  // work queue.)
  // A repair re-arms review, without deciding whether it succeeded.
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: txId, patch: { inputs: { note: 'repaired' } } });
  const rearmed = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'),
    required(runtime.store.getAgent(firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor').id), 'auditor agent'))
    .filter(item => item.action === 'review_issue');
  assert.ok(rearmed.length > 0, 'a repair re-arms review');
  assert.ok(rearmed.every(item => objectField(item, 'pending action').changed_since_issue === true),
    'the scheduler reports a durable change without claiming the correction was verified');
});

