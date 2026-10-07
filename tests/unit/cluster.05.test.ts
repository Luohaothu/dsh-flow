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
import { reserveLlmRequest } from '../../packages/dsh-flow/src/core/runtime.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import { DEFAULT_CONTEXT_LIMITS } from '../../packages/dsh-flow/src/core/protocol.ts';
import type { FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowContextLimits, FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

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

/** Fill a partial per-role context limit set from the deployment defaults. */
function contextLimits(overrides: Partial<FlowContextLimits>): FlowContextLimits {
  return { ...DEFAULT_CONTEXT_LIMITS, ...overrides };
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
import type { FlowStartInternals } from '../../packages/dsh-flow/src/core/model.ts';

/** Read one JSON array field a command result carries, without weakening its elements. */
function arrayOf05(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}


/** {@link startCluster} plus the reproducible fixtures the development IPC bridge passes. */
function startClusterWithInternals05(
  runtime: ClusterRuntime,
  overrides: Partial<FlowStartRequest>,
  internals: FlowStartInternals,
): string {
  const request = {
    objective: 'test objective',
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'] as const,
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 1000, tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
    ...overrides,
  };
  const snapshot = runtime.start(request, internals);
  return snapshot.cluster.id;
}

test('the inbox is real work: an event becomes an action and is consumed by the turn that takes it', async t => {
  const runtime = makeRuntime(t, { staleMs: 1 });
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 4 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // A real producer: dispatch notifies the Auditor that there is a plan to
  // inspect.
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const queued = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' });
  assert.ok(queued.length >= 1, 'dispatch queues a plan-audit request');
  assert.equal(queued.some(row => row.subject === 'plan-audit-requested'), true);

  runtime.enableScheduling();
  const held = await runtime.acquireLlmSlot(clusterId);
  await runtime.tick();
  held();
  const consumed = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'CONSUMED' });
  assert.ok(consumed.length >= 1, `the Auditor's turn consumed what it was asked to do: ${JSON.stringify(runtime.store.all('SELECT subject,status FROM inbox WHERE cluster_id=?', clusterId))}`);
  const actions = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'turn-actions');
  const inboxAction = actions.find(event => numberOf(jsonObject(event.data, 'turn-actions data').inbox_consumed, 0, 1e9, 'inbox_consumed') > 0);
  assert.ok(inboxAction, 'the turn records the actions it took');
  assert.ok(arrayOf05(jsonObject(inboxAction.data, 'turn-actions data').actions, 'actions').includes('inbox'), `the action list names the inbox: ${JSON.stringify(inboxAction.data)}`);
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });

  // The transaction is ready and has not moved for longer than the window.
  runtime.store.tx(() => runtime.store.run('UPDATE transactions SET created=?, updated=? WHERE id=?', clockNow - 60_000, clockNow - 60_000, tx.id));
  runtime.enableScheduling();
  await runtime.tick();

  // A turn may already have consumed the row, so the fact is asserted across
  // every status: the queue is the delivery mechanism, the row is the evidence.
  const stale = runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: null }).filter(row => row.subject === 'transaction-stale');
  assert.equal(stale.length, 1, 'the Auditor is told the work is stale');
  assert.equal(numberOf(jsonObject(firstOf(stale, 'stale inbox row').payload, 'stale payload').stale_ms, 0, 1e9, 'stale_ms') >= 1000, true, `the staleness is measured: ${JSON.stringify(firstOf(stale, 'stale inbox row').payload)}`);
  assert.ok(runtime.store.countInbox(clusterId, { status: 'PENDING' }) >= 1);

  // A second tick must not queue the same fact twice.
  await runtime.tick();
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: null }).filter(row => row.subject === 'transaction-stale').length, 1,
    'the same revision is reported once');

  // Saturation is a load signal for the Allocator.
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const held = await runtime.acquireLlmSlot(clusterId);
  await runtime.tick();
  held();
  const load = runtime.store.listInbox(clusterId, { recipient: allocator.agent_id, status: null }).filter(row => row.subject === 'load-changed');
  assert.ok(load.length >= 1, `the Allocator sees the load: ${JSON.stringify(runtime.store.all('SELECT subject,recipient FROM inbox WHERE cluster_id=?', clusterId))} allocator=${allocator.agent_id}`);
  assert.equal(numberOf(jsonObject(firstOf(load, 'load inbox row').payload, 'load payload').max_active_agents, 0, 1e9, 'max_active_agents'), 1);

  // A failed model request is an anomaly for the Allocator.
  runtime.recordAgentAnomaly(runtime.store.getAgent(auditor.agent_id), { code: 'PI_AI_ERROR', message: 'the route refused the request' });
  const anomaly = runtime.store.listInbox(clusterId, { recipient: allocator.agent_id, status: null }).filter(row => row.subject === 'agent-anomaly');
  assert.ok(anomaly.length >= 1, 'the anomaly reaches the Allocator');
  const anomalyFound = anomaly.find(row => jsonObject(row.payload, 'anomaly payload').code === 'PI_AI_ERROR');
  assert.equal(anomalyFound && jsonObject(anomalyFound.payload, 'anomaly payload').message, 'the route refused the request');
});

test('stale READY work and budget notices do not wake roles that cannot allocate or repair them', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
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
  const pending = (role: FlowAgentRole) => runtime.pendingFor(role, root, required(runtime.store.getCluster(clusterId), 'cluster'),
    runtime.store.getAgent(actorFor(runtime, clusterId, role, root.id).agent_id));
  assert.equal(pending('auditor').some(item => item.action === 'inbox'), false,
    'the Auditor still receives the fact, but cannot allocate the stale READY transaction');
  assert.equal(pending('orchestrator').some(item => item.action === 'inbox'), false,
    'a planning role cannot fix a temporary budget stop without an actionable local transaction');
  assert.ok(pending('allocator').some(item => item.action === 'allocate_agent'
    && 'transactions' in item && arrayOf05(item.transactions, 'allocatable transactions').includes(tx.id)));
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
  const parent = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'parent transaction');
  const child = textOf(jsonObject(firstOf(arrayOf05(command(runtime, orchestrator, 'decompose', {
    transaction_id: parent.id, children: [{ objective: 'produce delegated output', acceptance_criteria: ['the child ran'] }],
  }).result.children, 'children'), 'child'), 'child').transaction_id, 'child.transaction_id');
  const unrelated = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'unassigned sibling', acceptance_criteria: ['this one did not move'],
  }).result.transaction_id, 'unrelated transaction');
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
    .filter(event => event.type === 'transaction-stale').map(event => jsonObject(event.data, 'transaction-stale data').transaction_id);
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
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
  const stored = required(runtime.store.latestHealth(clusterId), 'stored health');
  assert.deepEqual(Object.keys(jsonObject(stored.scores, 'health scores')).sort(), [...metrics].sort());
  assert.equal(stored.decided_by, auditor.agent_id);
  assert.equal(stored.decided, 1);
  assert.deepEqual(jsonObject(stored.signals, 'health signals').transaction_coverage, 1, 'the measured signals are stored next to the judgement');

  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { invented_metric: 0.5 } }),
    error => rejectionStatus(error) === 400 && /unknown health metric/.test(messageOf(error)));
  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { transaction_coverage: 2 } }),
    error => rejectionStatus(error) === 400 && /\[0,1\]/.test(messageOf(error)));
  assert.throws(() => command(runtime, auditor, 'evaluate_health', { dimensions: { transaction_coverage: 0.5 }, weights: { transaction_coverage: 0.8 } }),
    error => rejectionStatus(error) === 400 && /sum to 1/.test(messageOf(error)));
});

test('transaction-scoped lifecycle control stays inside one subtree', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const parent = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'parent transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: parent.id });
  const child = textOf(jsonObject(firstOf(arrayOf05(command(runtime, orchestrator, 'decompose', {
    transaction_id: parent.id,
    children: [{ objective: 'child work', acceptance_criteria: ['done'] }],
  }).result.children, 'children'), 'child'), 'child').transaction_id, 'child.transaction_id');
  const sibling = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'untouched sibling', acceptance_criteria: ['x'] }).result.transaction_id, 'sibling transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: child });
  command(runtime, orchestrator, 'dispatch', { transaction_id: sibling });

  const paused = command(runtime, orchestrator, 'pause_transaction', { transaction_id: parent.id, reason: 'waiting on input' });
  assert.equal(paused.result.status, 'PAUSED');
  assert.ok(arrayOf05(paused.result.paused, 'paused').includes(child), 'the subtree pauses with it');
  assert.equal(required(runtime.store.getTransaction(sibling), 'sibling transaction').status, 'READY', 'a sibling outside the subtree is untouched');

  const resumed = command(runtime, orchestrator, 'resume_transaction', { transaction_id: parent.id });
  assert.equal(required(runtime.store.getTransaction(parent.id), 'parent transaction').status, 'READY');
  assert.equal(required(runtime.store.getTransaction(child), 'child transaction').status, 'READY');
  assert.equal(required(runtime.store.getTransaction(sibling), 'sibling transaction').status, 'READY');
  assert.ok(arrayOf05(resumed.result.resumed, 'resumed').length >= 2);

  const cancelled = command(runtime, orchestrator, 'cancel_transaction', { transaction_id: child, reason: 'not needed' });
  assert.deepEqual(cancelled.result.cancelled, [child]);
  assert.equal(required(runtime.store.getTransaction(parent.id), 'parent transaction').status, 'READY', 'cancelling a child does not cancel its parent');
  assert.equal(required(runtime.store.getTransaction(sibling), 'sibling transaction').status, 'READY');
  void auditor;
});

test('Auditor observations and recommendations are durable and routed without creating a blocking correction', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  const notified = command(runtime, auditor, 'notify', {
    transaction_id: tx.id, issue: 'the acceptance criteria name no artifact', severity: 'MAJOR', evidence: { checked: 'objective text' },
  });
  assert.ok(numberOf(notified.result.event_seq, 0, 1e9, 'event_seq') > 0);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'DRAFT', 'a signal changes nothing');
  command(runtime, auditor, 'notify', { transaction_id: tx.id });
  const notifiedEvents = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'auditor-notified');
  assert.equal(notifiedEvents.length, 2);
  assert.equal(jsonObject(firstOf(notifiedEvents, 'auditor-notified event').data, 'auditor-notified data').issue, 'the acceptance criteria name no artifact');

  const recommended = command(runtime, auditor, 'recommend', {
    transaction_id: tx.id, recommendation: 'split this into two transactions', expected_effect: 'shorter worker turns',
  });
  assert.equal(recommended.result.advisory, true);
  assert.ok(numberOf(recommended.result.event_seq, 0, 1e9, 'event_seq') > numberOf(notified.result.event_seq, 0, 1e9, 'event_seq'));
  assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 0,
    'only request_correction/replan should create a required-change issue');
  assert.ok(runtime.store.listInbox(clusterId, { status: 'PENDING' })
    .some(row => row.subject === 'auditor-recommended'));
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'READY',
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
  const runtime = await startFlowPlugin(host, {
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
  const root = rootNode(runtime, clusterId);
  const role = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
  const stepsOf = () => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'context-step');
  const waitForNewStep = async (since: number, deadlineMs: number) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const workerSteps = stepsOf().filter(event => jsonObject(event.data, 'context-step data').role === 'worker');
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
  const firstStepData = jsonObject(firstStep.data, 'first context step');
  assert.equal(firstStepData.context_limit, 16384, 'the Worker default is the yardstick');
  assert.equal(firstStepData.decision, 'reject');

  // The Allocator raises this identity's own budget: the same session now fits.
  const raised = command(runtime, role('allocator'), 'set_context_budget', {
    agent_id: worker.id, context_limit: 65_536, compression_threshold: 0.9, retention_policy: 'keep-last-turn',
  });
  assert.equal(numberOf(jsonObject(raised.result.context, 'raised context').limit, 0, 1e9, 'context limit'), 65_536);
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker agent').meta.context?.trigger, 0.9);
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'READY' });
    runtime.store.updateAgent(worker.id, { status: 'READY' });
    runtime.store.updateNode(root.id, { status: 'ACTIVE' });
    runtime.store.updateCluster(clusterId, { status: 'RUNNING' });
  });
  const soFar = stepsOf().filter(event => jsonObject(event.data, 'context-step data').role === 'worker').length;
  const secondStep = await waitForNewStep(soFar, 5_000);
  assert.ok(secondStep, 'the Worker measured another step');
  const secondStepData = jsonObject(secondStep.data, 'second context step');
  assert.equal(secondStepData.context_limit, 65_536, 'the identity override is what the next turn measures against');
  assert.equal(secondStepData.decision, 'proceed');
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker agent').meta.context?.retention, 'keep-last-turn');
});

test('a delegation chain descends one level per spawn, and the instruction wins', t => {
  const runtime = makeRuntime(t);
  const clusterId = startClusterWithInternals05(runtime, {
    // A depth cap with room for the chain: the terminal level is depth 3 and its Worker
    // would be depth 4, inside the cap. (A node created *at* the cap is refused; that is
    // its own test.)
    limits: { max_depth: 5 },
  }, {
    delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 3 }],
  });
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');

  // One pending instruction per level: a node that owes a delegation gets
  // exactly one, and the caller's number is ignored while it owes one.
  assert.equal(runtime.delegationInstructions(clusterId, root.id).length, 1);
  const first = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'level 1' }, spawn_children: 99,
  }).result;
  const firstNodeId = textOf(first.node_id, 'node_id');
  const level1 = required(runtime.store.getNode(firstNodeId), 'level 1 node');
  assert.equal(level1.scope?.spawn_children, 2, 'the inherited depth wins over the caller\'s override');

  const second = command(runtime, actorFor(runtime, clusterId, 'allocator', firstNodeId), 'spawn_management_node', {
    transaction_id: textOf(first.delegated_transaction_id, 'delegated_transaction_id'), node_id: firstNodeId, scope: { objective: 'level 2' }, spawn_children: 0,
  }).result;
  const secondNodeId = textOf(second.node_id, 'node_id');
  const level2 = required(runtime.store.getNode(secondNodeId), 'level 2 node');
  assert.equal(level2.scope?.spawn_children, 1, 'a caller cannot stop a chain the fixture still asks for');

  const third = command(runtime, actorFor(runtime, clusterId, 'allocator', secondNodeId), 'spawn_management_node', {
    transaction_id: textOf(second.delegated_transaction_id, 'delegated_transaction_id'), node_id: secondNodeId, scope: { objective: 'level 3' },
  }).result;
  const thirdNodeId = textOf(third.node_id, 'node_id');
  const level3 = required(runtime.store.getNode(thirdNodeId), 'level 3 node');
  assert.equal(level3.scope?.spawn_children, 0, 'and the chain ends when the depth reaches zero');
  const leaf = required(runtime.store.getTransaction(textOf(third.delegated_transaction_id, 'delegated_transaction_id')), 'leaf transaction');
  assert.equal(leaf.objective, 'deep branch',
    'the final node receives the delegated task, not its ancestor’s instructions to spawn more nodes');
  assert.equal(jsonObject(leaf.inputs, 'leaf transaction inputs').management_levels_remaining, 0,
    'the Worker can distinguish a leaf assignment from an unfinished management chain');
  // A node with no budget left owes nothing, so a caller may then pass its own
  // number: the fixture no longer has an opinion about that level.
  const extra = command(runtime, actorFor(runtime, clusterId, 'allocator', thirdNodeId), 'spawn_management_node', {
    transaction_id: textOf(third.delegated_transaction_id, 'delegated_transaction_id'), node_id: thirdNodeId, scope: { objective: 'level 4' },
  }).result;
  const extraNode = required(runtime.store.getNode(textOf(extra.node_id, 'node_id')), 'level 4 node');
  assert.equal(extraNode.depth, 4);
  assert.equal(extraNode.scope?.spawn_children, 0);
  // Every level of the chain exists, so a depth-3 management branch is reachable
  // by construction rather than by the model's choice.
  const depths = new Set(runtime.store.listNodes(clusterId, {}).filter(node => node.kind === 'management').map(node => node.depth));
  assert.deepEqual([...depths].sort(), [0, 1, 2, 3, 4]);
});

test('a delegated parent does not spend Worker attempts before its required management child exists', t => {
  const runtime = makeRuntime(t);
  const clusterId = startClusterWithInternals05(runtime, {
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6,
      max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 4_194_304, model_requests: 512, tool_calls: 4096,
      wall_time_ms: 1_800_000, agents: 64, max_active_agents: 6 },
  }, {
    delegation: [{ scope: 'deep/', objective: 'finish deep/nested/result.txt', spawn_children: 3 }],
  });
  const root = rootNode(runtime, clusterId);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const first = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: rootTx.id }).result;
  const child = required(runtime.store.getNode(textOf(first.node_id, 'node_id')), 'delegated child');
  const delegatedId = textOf(first.delegated_transaction_id, 'delegated_transaction_id');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id),
    'dispatch', { transaction_id: delegatedId });
  assert.equal(required(runtime.store.getTransaction(delegatedId), 'delegated transaction').status, 'READY');
  const allocator = actorFor(runtime, clusterId, 'allocator', child.id);
  const pending = runtime.pendingFor('allocator', child, required(runtime.store.getCluster(clusterId), 'cluster'),
    runtime.store.getAgent(allocator.agent_id));
  assert.ok(pending.some(action => action.action === 'spawn_management_node'));
  assert.equal(pending.some(action => action.action === 'allocate_agent'
    && 'transactions' in action && arrayOf05(action.transactions, 'allocatable transactions').includes(delegatedId)), false,
  'the branch owes its next management child before any Worker can run its parent');
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: delegatedId }),
    error => rejectionStatus(error) === 409 && /delegat|child/i.test(messageOf(error)));
  assert.equal(runtime.store.activeAllocationForTransaction(delegatedId), null);
  const second = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, node_id: child.id,
  }).result;
  assert.equal(required(runtime.store.getNode(textOf(second.node_id, 'node_id')), 'second child').depth, 2);
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
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: 'fresh-msg', cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'work please' },
    });
    runtime.store.insertRecipient('fresh-msg', agent.id);
  });
  const reconciled = await runtime.reconcileDeliveries(clusterId);
  assert.equal(reconciled.acknowledged, 0, 'nothing was injected yet, so nothing is acked');
  assert.equal(required(runtime.store.getAgent(agent.id), 'auditor agent').status !== 'BLOCKED', true, 'and nothing is blocked for it');

  const collected = await runtime.collectDeliveries(agent);
  assert.deepEqual(collected.ids, ['fresh-msg'], 'the delivery is handed to the turn');
  assert.equal(required(runtime.store.deliveryFor('fresh-msg', agent.id), 'message delivery').status, 'DELIVERED');
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
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
  const tx2 = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id, 'second transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx2 });
  command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'allocate_agent', { transaction_id: tx2 });
  const allocation = required(runtime.store.activeAllocationForTransaction(tx2), 'second allocation');
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
  const staleIds = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'transaction-stale').map(event => jsonObject(event.data, 'transaction-stale data').transaction_id);
  assert.equal(staleIds.includes(tx2), false, 'an identity with a live lease is not reported stale');
});

test('stale notification reaches the ninth unreported transaction behind eight already-reported ones', async t => {
  const runtime = makeRuntime(t, { staleMs: 1000 });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const first = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  for (let index = 0; index < 8; index += 1) {
    const tx = textOf(command(runtime, orchestrator, 'create_transaction', {
      objective: `stale-${index}`, acceptance_criteria: ['evidence'],
    }).result.transaction_id, 'stale transaction');
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx });
  }
  const stale = runtime.store.all(
    "SELECT id,revision FROM transactions WHERE cluster_id=? AND status='READY' ORDER BY rowid", clusterId);
  assert.equal(stale.length, 9);
  runtime.store.tx(() => {
    for (const row of stale) runtime.store.run('UPDATE transactions SET updated=? WHERE id=?', now() - 60_000, textOf(row.id, 'transaction id'));
    for (const row of stale.slice(0, 8)) runtime.store.appendEvent(clusterId, 'transaction-stale', {
      transaction_id: textOf(row.id, 'transaction id'), revision: numberOf(row.revision, 0, 1e9, 'revision'),
    });
  });
  runtime.enableScheduling();
  await runtime.tick();
  const notices = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stale').map(event => jsonObject(event.data, 'transaction-stale data').transaction_id);
  assert.equal(notices.length, 9);
  assert.equal(notices.at(-1), textOf(stale[8]?.id, 'ninth transaction id'), 'the first eight historical notices cannot starve the ninth');
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
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  const second = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id, 'second transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  assert.equal(runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id)).filter(item => item.action === 'inspect_plan').length, 2);
  // The Auditor answers both, so the cursor is at the newest audit and the page
  // is empty.
  command(runtime, auditor, 'inspect_plan', { transaction_id: first.id, decision: 'approve' });
  command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'approve' });
  const empty = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id));
  assert.equal(empty.filter(item => item.action === 'inspect_plan').length, 0);

  // A new plan audit arrives: it must be visible, not hidden behind the cursor.
  const third = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'third', acceptance_criteria: ['x'] }).result.transaction_id, 'third transaction');
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: third, expected_output: 'anything' });
  command(runtime, orchestrator, 'dispatch', { transaction_id: third });
  const after = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id));
  assert.equal(after.filter(item => item.action === 'inspect_plan').length, 1, 'the new plan is offered for inspection');
  assert.equal(required(after.find(item => item.action === 'inspect_plan'), 'new plan audit').transaction_id, third);
});

test('a validation gate reaches the Auditor ahead of an older page of advisory plans', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  for (let index = 0; index < 8; index += 1) {
    const id = textOf(command(runtime, orchestrator, 'create_transaction', {
      objective: `plan ${index}`, acceptance_criteria: ['accepted'],
    }).result.transaction_id, 'plan transaction');
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
  const offered = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id))
    .filter(item => item.action.startsWith('inspect_'));
  assert.equal(offered[0]?.action, 'inspect_validation',
    'an independent plan-review backlog must not hide an acceptance-gating verdict');
  assert.equal(offered[0]?.transaction_id, tx.id);
  command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'ACCEPTED');
  assert.ok(runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id))
    .some(item => item.action === 'inspect_plan'),
  'the deferred advisory reviews remain available afterwards');
});

test('a turn that stops making progress is aborted, not left holding its transaction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-hung-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000, maxTurnMs: 1_000,
    context: contextLimits({ role: 8192, worker: 16384 }),
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 2, max_llm_concurrency: 1, max_attempts: 1, max_corrections: 1, max_role_turns: 2, worker_max_tokens: 512 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 2 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const role = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
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
  assert.equal(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'RUNNING');
  assert.equal(runtime.activeTurnIds().length, 1);

  // Past the maximum lifetime the scheduler aborts it, so the finisher runs and
  // the transaction is not left RUNNING forever.
  runtime.store.now = () => Date.now();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_100));
  await runtime.tick();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  const aborted = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'turn-aborted');
  assert.equal(aborted.length, 1, `the hung turn is aborted: ${JSON.stringify(aborted.map(event => event.data))}`);
  assert.notEqual(required(runtime.store.getTransaction(tx.id), 'root transaction').status, 'RUNNING', 'and the transaction no longer sits in RUNNING');
});

test('a RUNNING transaction whose turn vanished is returned to the scheduler', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
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
  assert.equal(jsonObject(firstOf(swept, 'stranded event').data, 'stranded event data').code, 'STRANDED_TURN');
  // The sweep returned it to the scheduler, which may already have claimed it
  // again in the same tick.
  const afterSweep = required(runtime.store.getTransaction(tx.id), 'root transaction');
  assert.equal(['READY', 'RUNNING'].includes(afterSweep.status), true, `returned to the scheduler: ${afterSweep.status}`);

  // A transaction whose identity holds a live lease is being worked on: the
  // sweep must not steal it.
  const second = textOf(command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['x'] }).result.transaction_id, 'second transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, allocator, 'allocate_agent', { transaction_id: second });
  const allocation = required(runtime.store.activeAllocationForTransaction(second), 'second allocation');
  runtime.store.tx(() => {
    runtime.store.updateTransaction(second, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(allocation.agent_id, { status: 'BLOCKED' });
    runtime.store.createLease({
      id: 'live-again', cluster_id: clusterId, agent_id: allocation.agent_id, node_id: allocation.node_id,
      purpose: 'worker-turn', epoch: 9, expires: now() + 60_000,
    });
  });
  await runtime.tick();
  assert.equal(required(runtime.store.getTransaction(second), 'second transaction').status, 'RUNNING', 'a transaction with a live lease is left alone');
  const strandedIds = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-stranded').map(event => jsonObject(event.data, 'transaction-stranded data').transaction_id);
  assert.equal(strandedIds.includes(second), false, `the leased transaction is never named stranded: ${JSON.stringify(strandedIds)}`);
});

test('a request that needs more than its grant is funded inside the reservation', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const allocated = jsonObject(firstOf(arrayOf05(command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations, 'allocations'), 'worker allocation'), 'worker allocation');
  const worker = required(runtime.store.getAgent(textOf(allocated.agent_id, 'agent_id')), 'worker agent');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', worker.id), 'agent budget');
  // A grant far smaller than one request, with a node that can cover it.
  runtime.store.tx(() => runtime.store.updateBudget(agentBudget.id, { tokens_limit: 1_000, tokens_spent: 0, tokens_reserved: 0 }));

  // The funder closes the gap inside the same transaction, so the reservation
  // sees the funded grant: no race with whatever settled in between.
  const fundCalls: { dimension: string | undefined; requested: number | undefined }[] = [];
  const reserve = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id, transaction_id: tx.id,
    role: 'worker', kind: 'worker', model: 'm', provider: 'p',
    budgetIds: runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), worker),
    reservationTokens: 400_000, turn_seq: 1, maxRequests: null,
    fund: error => {
      fundCalls.push({ dimension: error.dimension, requested: error.requested });
      return runtime.topUpBudgetForAgent(worker, {
        [error.dimension ?? 'model_requests']: numberOf(error.requested, 0, 1e9, 'requested'),
        ...(error.dimension === 'tokens' ? { model_requests: 1 } : {}),
      });
    },
  });
  assert.ok(reserve.request_id, 'the request is funded and reserved');
  assert.equal(fundCalls.length, 1, `the funder ran exactly once: ${JSON.stringify(fundCalls)}`);
  assert.equal(firstOf(fundCalls, 'budget funding call').dimension, 'tokens');
  assert.equal(reserve.tokens, 400_000);
  const after = required(runtime.store.getBudget(agentBudget.id), 'funded agent budget');
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
    budgetIds: runtime.agentBudgetChain(required(runtime.store.getCluster(clusterId), 'cluster'), worker),
    reservationTokens: 400_000, turn_seq: 1, maxRequests: null,
    fund: () => runtime.topUpBudgetForAgent(worker, { tokens: 400_000, model_requests: 1 }),
  }), error => error instanceof Error && 'code' in error && error.code === 'LIMIT_REACHED');
});

test('the compaction pool is funded from the node when its earmark cannot cover a summary', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const poolId = required(runtime.compactionBudgetId(clusterId), 'compaction budget id');
  const pool = required(runtime.store.getBudget(poolId), 'compaction budget');

  // The earmark is a share, so a long run exhausts it: the summary request then
  // has to be funded from the node, or the session it must shrink can never be
  // shrunk.
  const need = pool.tokens_limit + 5_000;
  const granted = runtime.store.tx(() => runtime.topUpCompactionPool(clusterId, { tokens: need, model_requests: 1 }));
  assert.ok(granted, `the pool is funded: ${JSON.stringify(granted)}`);
  assert.equal(numberOf(jsonObject(granted, 'compaction pool grant').tokens, 0, 1e9, 'tokens'), 5_000, 'exactly the gap');
  const after = required(runtime.store.getBudget(poolId), 'compaction budget');
  assert.ok(after.tokens_limit - after.tokens_reserved - after.tokens_spent >= need, 'the pool can now cover the request');

  // Idle identities' grants are reclaimed first: the capacity they hold is
  // capacity the node no longer has.
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');
  const auditorBudget = required(runtime.store.budgetForScope(clusterId, 'agent', auditor.id), 'auditor budget');
  const node = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  runtime.store.tx(() => runtime.store.updateBudget(node.id, { tokens_spent: Math.max(node.tokens_spent, node.tokens_limit - node.tokens_reserved) }));
  const reclaimed = runtime.store.tx(() => runtime.topUpCompactionPool(clusterId, { tokens: after.tokens_limit + 1_000 }));
  assert.ok(reclaimed, 'the pool is still funded after the node was drained directly');
  assert.ok(required(runtime.store.getBudget(auditorBudget.id), 'auditor budget').tokens_limit <= auditorBudget.tokens_limit, 'an idle identity gave capacity back');
});

test('a cluster that cannot pay for its next request stops with the budget reason', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
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
  const agent = firstOf(runtime.store.listAgents(clusterId, { role: 'orchestrator' }), 'orchestrator agent');
  runtime.recordBudgetRefusal(agent, 'model request refused: nothing left', {
    scope: root.id, dimension: 'tokens', requested: 10_000, available: 0,
  });
  runtime.enableScheduling();
  await runtime.tick();
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED', 'the cluster stops instead of spinning');
  const blockedEvents = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  const blockedData = jsonObject(firstOf(blockedEvents.slice(-1), 'cluster-blocked event').data, 'cluster-blocked data');
  assert.equal(blockedData.code, 'BUDGET_EXHAUSTED');
  assert.match(String(blockedData.reason), /^BUDGET:/);
});

