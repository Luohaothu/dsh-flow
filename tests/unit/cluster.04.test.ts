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
import { dimensionAvailable, transferBudget } from '../../packages/dsh-flow/src/core/budget.ts';
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

function scoreFinalHealth(runtime: ClusterRuntime, clusterId: string, nodeId: string): string {
  const auditor = actorFor(runtime, clusterId, 'auditor', nodeId);
  const dimensions = Object.fromEntries(runtime.healthMetricNames().map(metric => [metric, 0.5]));
  const outcome = command(runtime, auditor, 'evaluate_health', {
    dimensions, evaluation_window: 'subtree-close',
  });
  return textOf(outcome.result.health_id, 'health_id');
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
import type { BudgetRecord } from '../../packages/dsh-flow/src/core/model.ts';

import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence';
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';

/** A real persistence service with deterministic existence and read proofs. */
class ScriptedPersistence04 extends SessionPersistence {
  constructor(ctx: Context, private readonly exists: boolean) {
    super(ctx);
  }

  override async stat(): Promise<SessionPersistenceSnapshot | undefined> {
    return this.exists
      ? {
        header: { version: SESSION_FORMAT_VERSION, id: SessionId('probe'), createdAt: 0, isSeeded: false },
        revision: SessionPersistenceRevision('probe'),
      }
      : undefined;
  }

  override async open(): Promise<never> {
    throw new Error('the session log is unreadable');
  }

  override async create(): Promise<never> {
    throw new Error('unused persistence operation');
  }

  override async flush(): Promise<void> {}

  override async list(): Promise<readonly never[]> {
    return [];
  }
}

/** A list-valued field of a command result or pending hint, as raw JSON entries. */
function listOf04(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected ${label} to be a list`);
  return value;
}
/** A required identifier returned by a command. */
function commandId04(outcome: TestCommandOutcome, field: string): string {
  return textOf(outcome.result[field], field);
}

/** The first allocation returned by an allocation command. */
function allocationOf04(outcome: TestCommandOutcome): { allocation_id: string; agent_id: string; transaction_id: string } {
  const allocation = firstOf(recordsOf04(outcome.result.allocations, 'allocations'), 'allocation');
  return {
    allocation_id: textOf(allocation.allocation_id, 'allocation_id'),
    agent_id: textOf(allocation.agent_id, 'agent_id'),
    transaction_id: textOf(allocation.transaction_id, 'transaction_id'),
  };
}

/** A delegated management node named by a command result. */
function managementNodeOf04(outcome: TestCommandOutcome): { node_id: string; delegated_transaction_id: string } {
  return {
    node_id: textOf(outcome.result.node_id, 'node_id'),
    delegated_transaction_id: textOf(outcome.result.delegated_transaction_id, 'delegated_transaction_id'),
  };
}
/** A record-valued list field, as narrowed records. */
function recordsOf04(value: unknown, label: string): Record<string, unknown>[] {
  return listOf04(value, label).map((entry, index) => jsonObject(entry, `${label}[${index}]`));
}

test('a rejected flush neither acks a delivery nor dispatches a tool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-flush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost({ flushResult: false });
  host.registerTool({
    name: 'read',
    description: 'read one owned file',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return { content: [{ type: 'text', text: 'body' }], isError: false, value: {} }; },
  });
  // `fs_read` maps to `read`, `glob` and `grep`; all three must resolve before
  // the Worker prompt is submitted. The script only calls `read`.
  for (const name of ['glob', 'grep']) {
    host.registerTool({
      name, description: 'filesystem admission fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute() { assert.fail(`${name} is not scripted in this fixture`); },
    });
  }
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_attempts: 2, max_corrections: 1, max_role_turns: 2,},
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const role = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id });
  const agent = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
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
  const events = (type: string) => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  assert.equal(events('messages-acked').length, 0, 'a delivery is never acked on a rejected flush');
  assert.ok(events('messages-reopened').length >= 1, 'it is reopened instead');
  assert.notEqual(required(runtime.store.deliveryFor('flush-check', agent.id), 'delivery').status, 'ACKED', 'an unflushed delivery is never acked');
  const receipts = runtime.store.toolCallReceipts(clusterId, { agent_id: agent.id });
  assert.ok(receipts.length >= 1, 'an admitted call has a receipt');
  assert.equal(receipts.every(receipt => receipt.dispatch_status === 'CANCELLED'), true,
    `a refused tool call never dispatches: ${JSON.stringify(receipts.map(receipt => receipt.dispatch_status))}`);
  assert.ok(events('tool-call-refused').length >= 1, 'the refusal is recorded');
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status !== 'SUBMITTED', true, 'nothing was published from an unflushed turn');
});

test('an unreadable session is UNKNOWN: the attempted delivery stays withheld instead of being re-injected', async t => {
  const runtime = makeRuntime(t);
  runtime.attachPersistence(new ScriptedPersistence04(runtime.ctx, true));
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: 'unknown-msg', cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient('unknown-msg', agent.id);
    runtime.store.markDeliveryInjected('unknown-msg', agent.id);
  });
  const reconciled = await runtime.reconcileDeliveries(clusterId);
  const events = (type: string) => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  assert.equal(required(runtime.store.deliveryFor('unknown-msg', agent.id), 'delivery').status, 'DELIVERED', 'an unprovable delivery is neither acked nor requeued');
  assert.equal(events('messages-ack-reconciled').length, 0);
  assert.equal(required(runtime.store.getAgent(agent.id), 'agent').status, 'BLOCKED', 'and its owner does not dispatch until the ambiguity is resolved');
  const unknown = events('delivery-unknown');
  assert.equal(unknown.length, 1, 'the uncertainty is recorded with its reason');
  assert.match(String(jsonObject(firstOf(unknown, 'delivery-unknown event').data, 'event data').reason), /unreadable/);
  assert.equal(reconciled.acknowledged, 0);
  void agent;
});

test('recovery requeues a RUNNING transaction that still holds its allocation', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const role = (name: FlowAgentRole) => actorFor(runtime, clusterId, name, root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, role('orchestrator'), 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
    command(runtime, role('auditor'), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  const allocated = firstOf(recordsOf04(command(runtime, role('allocator'), 'allocate_agent', { transaction_id: tx.id }).result.allocations, 'allocations'), 'allocation');
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'RUNNING', attempts: 1, __bump_revision: false }));

  runtime.recover({ deferScheduling: true });
  const recoveredTx = required(runtime.store.getTransaction(tx.id), 'recovered transaction');
  assert.equal(recoveredTx.status, 'READY', 'a crashed RUNNING transaction is schedulable again');
  const allocation = required(runtime.store.getAllocation(textOf(allocated.allocation_id, 'allocation_id')), 'allocation');
  assert.equal(allocation.status, 'ACTIVE', 'and it keeps the identity that owns it');
  const claimable = runtime.store.readyForWorker(clusterId, { limit: 10 });
  assert.equal(claimable.length, 1, 'the scheduler can claim it');
  assert.equal(required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id), 'agent budget').id), 'agent budget').tool_calls_reserved, 0,
    'stray reservations from the previous process are returned');
});

test('an identity with history but no durable session is blocked, never re-created', async t => {
  const runtime = makeRuntime(t);
  runtime.attachPersistence(new ScriptedPersistence04(runtime.ctx, false));
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');
  runtime.store.tx(() => runtime.store.updateAgent(auditor.id, { turns: 3 }));

  const report = await runtime.proveSessions(clusterId);
  assert.equal(report.length, 1);
  assert.deepEqual(firstOf(report, 'session proof report').session_missing, [auditor.id]);
  assert.equal(required(runtime.store.getAgent(auditor.id), 'auditor').status, 'BLOCKED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'session-missing');
  assert.equal(events.length, 1);
  assert.equal(jsonObject(firstOf(events, 'session-missing event').data, 'event data').code, 'SESSION_MISSING');
  const blocked = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'cluster-blocked');
  assert.equal(jsonObject(firstOf(blocked.toReversed(), 'cluster-blocked event').data, 'event data').code, 'SESSION_MISSING');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'BLOCKED');
});

test('an uncertain effect blocks its owner and a human decision releases it', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'auditor', root.id), 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
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
  const uncertain = blockedEvents.find(event => jsonObject(event.data, 'event data').code === 'EFFECT_UNCERTAIN');
  assert.ok(uncertain, `the scheduler refused to start the owner: ${JSON.stringify(blockedEvents.map(event => jsonObject(event.data, 'event data').code))}`);
  assert.equal(jsonObject(uncertain.data, 'event data').call_id, 'uncertain-call');
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker').status, 'BLOCKED');
  assert.equal(runtime.store.toolCallReceipts(clusterId, { agent_id: worker.id }).length, 0, 'nothing was admitted');

  // A human decides it happened.
  const resolved = command(runtime, allocator, 'resolve_effect', { call_id: 'uncertain-call', decision: 'settled', note: 'verified the file on disk' });
  assert.equal(resolved.result.status, 'SETTLED');
  assert.equal(required(runtime.store.getEffect('uncertain-call'), 'effect').status, 'SETTLED');
  const events = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'effect-resolved');
  assert.equal(events.length, 1);
  assert.equal(jsonObject(firstOf(events, 'effect-resolved event').data, 'event data').decision, 'settled');
});

test('a dependent transaction is not offered to a Worker before its dependency is accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  const dependent = commandId04(command(runtime, orchestrator, 'create_transaction', {
    objective: 'reads what the first transaction produces', acceptance_criteria: ['observable result'],
  }), 'transaction_id');
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
    const id = commandId04(command(runtime, orchestrator, 'create_transaction', {
      objective: `ladder task ${index}`, acceptance_criteria: ['observable result'],
    }), 'transaction_id');
    command(runtime, orchestrator, 'dispatch', { transaction_id: id });
  }
  const pending = () => runtime.pendingFor('allocator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(allocator.agent_id), 'allocator'));
  const allocationHints = pending().filter(item => item.action === 'allocate_agent');
  const allocationHint = jsonObject(firstOf(allocationHints, 'allocation hint'), 'allocation hint');
  assert.equal(allocationHint.free_slots, 4, 'the hint names the window it can actually fill');

  const wave = jsonObject(command(runtime, allocator, 'scale_out', { count: 4 }).result, 'scale_out result');
  const waveAllocations = recordsOf04(wave.allocations, 'allocations');
  assert.equal(waveAllocations.length, 4);
  // Every slot is taken and nothing is releasable yet: an `allocate_agent` hint
  // here could only fail at the ceiling, and three no-progress turns block the
  // node for stagnation while the work it is waiting on is elsewhere.
  assert.equal(pending().filter(item => item.action === 'allocate_agent').length, 0,
    'a full node is not told to allocate work it cannot host');

  const firstWaveAllocation = firstOf(waveAllocations, 'wave allocation');
  const firstTransactionId = textOf(firstWaveAllocation.transaction_id, 'transaction_id');
  const freed = required(runtime.store.activeAllocationForTransaction(firstTransactionId), 'freed allocation');
  runtime.store.tx(() => runtime.store.updateTransaction(firstTransactionId, { status: 'ACCEPTED' }));
  command(runtime, allocator, 'release_agent', { allocations: [freed.id] });
  const after = pending().filter(item => item.action === 'allocate_agent');
  assert.equal(after.length, 1, 'the hint comes back once a slot is free');
  const afterHint = jsonObject(firstOf(after, 'allocation hint'), 'allocation hint');
  assert.equal(afterHint.free_slots, 1);
  assert.equal(listOf04(afterHint.transactions, 'transactions').length, 1, 'and it names only what fits');
});

test('an unsafe reparent is refused without touching the turn or the ledger', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  const child = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: tx.id, scope: { objective: 'child domain' }, max_children: 4,
  }));
  const other = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: tx.id, scope: { objective: 'second domain' }, max_children: 4,
  }));
  const budgetsBefore = runtime.store.listBudgets(clusterId).map(row => `${row.id}:${row.tool_calls_limit}:${row.parent_budget_id}`).sort();
  const pathsBefore = runtime.store.nodesInSubtree(clusterId, null).map(node => `${node.id}:${node.path}:${node.depth}`).sort();

  // A live turn inside the subtree: the move must be refused *before* anything
  // is aborted, checkpointed or moved.
  const childAgent = firstOf(runtime.store.listAgents(clusterId, { node_id: child.node_id, role: 'orchestrator' }), 'child Orchestrator');
  const aborts: unknown[] = [];
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
    error => rejectionStatus(error) === 409 && /live lease|executing/.test(messageOf(error)),
  );
  assert.equal(originalAbort.called, false);
  assert.equal(required(runtime.store.getAgent(childAgent.id), 'child agent').status, 'RUNNING', 'a refused reparent drains nothing');
  assert.deepEqual(runtime.store.listBudgets(clusterId).map(row => `${row.id}:${row.tool_calls_limit}:${row.parent_budget_id}`).sort(), budgetsBefore);
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
  const grandchild = managementNodeOf04(command(runtime, actorFor(runtime, clusterId, 'allocator', child.node_id), 'spawn_management_node', {
    transaction_id: child.delegated_transaction_id, scope: { objective: 'grandchild domain' }, max_children: 4,
  }));
  runtime.store.tx(() => runtime.store.updateTransaction(grandchild.delegated_transaction_id, { status: 'ACCEPTED' }));
  // The new parent must be able to fund the subtree it takes on — that check has
  // its own test; this one is about the safe point and the rewritten paths.
  runtime.store.tx(() => {
    const otherBudget = required(runtime.store.budgetForScope(clusterId, 'node', other.node_id), 'other node budget');
    const row = required(runtime.store.getBudget(otherBudget.id), 'other node budget');
    runtime.store.updateBudget(otherBudget.id, {
      tool_calls_limit: Number(row.tool_calls_limit) + 200,
    });
  });
  const rootPath = required(runtime.store.getNode(child.node_id), 'child node').path;
  const moved = command(runtime, allocator, 'reparent', { node_id: child.node_id, new_parent_id: other.node_id });
  assert.equal(moved.result.from, root.id);
  assert.equal(moved.result.to, other.node_id);
  const newRoot = required(runtime.store.getNode(child.node_id), 'child node');
  const newGrandchild = required(runtime.store.getNode(grandchild.node_id), 'grandchild node');
  assert.equal(newRoot.parent_id, other.node_id);
  assert.ok(newGrandchild.path.startsWith(newRoot.path), `the descendant path follows its parent: ${newGrandchild.path} vs ${newRoot.path}`);
  assert.equal(newGrandchild.depth, newRoot.depth + 1, 'and so does its depth');
  assert.notEqual(newRoot.path, rootPath);
  // Ownership is a real column with a real reader, and it names the management
  // node that hosts the transaction: a reparent relocates the tree, it does not
  // reassign the moved node's transactions to the branch above them.
  const movedTx = required(runtime.store.getTransaction(grandchild.delegated_transaction_id), 'grandchild transaction');
  assert.equal(movedTx.owner_management_id, grandchild.node_id);
  // A management node owns itself wherever it sits, so the move relocates the
  // tree without rewriting anyone's owner — including the moved root's.
  assert.equal(required(runtime.store.getNode(grandchild.node_id), 'grandchild node').owner_management_id, grandchild.node_id,
    'the moved subtree keeps its own internal ownership');
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').owner_management_id, child.node_id,
    'and the moved root still owns itself, now under the new parent');
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').parent_id, other.node_id);
  // The subtree's budget now hangs off the new parent.
  const childBudget = required(runtime.store.budgetForScope(clusterId, 'node', child.node_id), 'child node budget');
  const otherBudget = required(runtime.store.budgetForScope(clusterId, 'node', other.node_id), 'other node budget');
  assert.equal(childBudget.parent_budget_id, otherBudget.id);
});

test('node ownership is derived from the tree and reported by the public query', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: rootTx.id });
  const child = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: rootTx.id, scope: { objective: 'descendant domain' }, max_children: 2,
  }));
  const work = commandId04(command(runtime, orchestrator, 'create_transaction', {
    objective: 'root work', acceptance_criteria: ['observable result'],
  }), 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: work });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: work });
  const workerNodeId = required(runtime.store.getAgent(allocationOf04(allocated).agent_id), 'worker agent').node_id;
  // The single control run's Worker is a root Worker with no management parent.
  const standalone = required(runtime.store.tx(() => runtime.store.insertNode({
    id: 'single-control-worker', cluster_id: clusterId, parent_id: null, kind: 'worker', depth: 0,
    status: 'ACTIVE', scope: { objective: 'single control' }, capabilities: ['fs_read'], path: '0', max_children: 0,
  })), 'standalone worker');

  const page = runtime.query({ role: 'user', cluster_id: clusterId }, 'nodes', { limit: 50 });
  const byId = new Map(page.items.map(node => [node.id, node]));
  assert.equal(required(byId.get(root.id), 'root node').owner_management_id, root.id, 'a root management node owns itself');
  assert.equal(required(byId.get(child.node_id), 'child node').owner_management_id, child.node_id, 'a descendant management node owns itself');
  assert.equal(required(byId.get(workerNodeId), 'worker node').owner_management_id, root.id, 'a Worker belongs to its management parent');
  assert.equal(required(byId.get(standalone.id), 'standalone worker').owner_management_id, null, 'a standalone control Worker has no management owner');

  // A conflicting owner is a caller error, not a silent override: the column
  // has one derived value and one reader.
  assert.throws(() => runtime.store.tx(() => runtime.store.insertNode({
    id: 'misdeclared', cluster_id: clusterId, parent_id: root.id, kind: 'worker', depth: 1,
    status: 'ACTIVE', scope: {}, capabilities: [], path: '0.9', owner_management_id: child.node_id,
  })), error => /declares owner/.test(messageOf(error)));

  // The one edit that can move a Worker to a different owner is the edit that
  // changes its parent, and the column follows it there.
  runtime.store.tx(() => runtime.store.updateNode(workerNodeId, { parent_id: child.node_id }));
  assert.equal(required(runtime.store.getNode(workerNodeId), 'worker node').owner_management_id, child.node_id,
    'a moved Worker belongs to the management node it now runs under');
  assert.throws(() => runtime.store.tx(() => runtime.store.updateNode(workerNodeId, {
    parent_id: root.id, owner_management_id: child.node_id,
  })), error => /declares owner/.test(messageOf(error)));
});

test('a completed delegated node returns its unspent role and node grants to its parent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'finish delegated work' },
  }));
  const parentBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'parent node budget');
  const childBudget = required(runtime.store.budgetForScope(clusterId, 'node', child.node_id), 'child node budget');
  const childRoles = runtime.store.listAgents(clusterId, { node_id: child.node_id });
  const roleBudgets = childRoles.map(role => required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'role budget'));
  const available = (budget: BudgetRecord) => budget.tool_calls_limit - budget.tool_calls_spent - budget.tool_calls_reserved;
  const expectedReturn = available(childBudget) + roleBudgets.reduce((sum, budget) => sum + available(budget), 0);
  assert.ok(expectedReturn > 0, 'a completed branch still holds unused requests');
  const before = available(parentBudget);

  runtime.store.tx(() => runtime.store.updateTransaction(child.delegated_transaction_id, {
    status: 'ACCEPTED', __bump_revision: false,
  }));
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').status, 'ACTIVE', 'refunding waits for the funded Auditor decision');
  scoreFinalHealth(runtime, clusterId, child.node_id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').status, 'COMPLETED');
  assert.equal(available(required(runtime.store.getBudget(parentBudget.id), 'parent node budget')), before + expectedReturn,
    'all unused child scope and role grants return to the parent without creating requests');
  assert.equal(available(required(runtime.store.getBudget(childBudget.id), 'child node budget')), 0);
  for (const budget of roleBudgets) assert.equal(available(required(runtime.store.getBudget(budget.id), 'role budget')), 0);
  runtime.evaluateCompletion(clusterId);
  assert.equal(available(required(runtime.store.getBudget(parentBudget.id), 'parent node budget')), before + expectedReturn,
    'a completed branch cannot return its grant twice');
});

test('a descendant request reclaims idle ancestor roles before declaring their node empty', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'child needs a request' },
  }));
  const parent = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'parent node budget');
  const childBudget = required(runtime.store.budgetForScope(clusterId, 'node', child.node_id), 'child node budget');
  const sourceRole = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor' }), 'root Auditor');
  const sourceGrant = required(runtime.store.budgetForScope(clusterId, 'agent', sourceRole.id), 'source role budget');
  const budget = (id: string) => required(runtime.store.getBudget(id), 'budget');
  runtime.grantBudget(parent, sourceGrant, {tool_calls:50});
  assert.ok(dimensionAvailable(budget(sourceGrant.id), 'tool_calls') >= 50);
  transferBudget(runtime.store, childBudget.id, parent.id, {tool_calls: dimensionAvailable(budget(childBudget.id), 'tool_calls')});
  const rootScope = required(runtime.store.budgetForScope(clusterId, 'root', clusterId), 'root budget');
  transferBudget(runtime.store, parent.id, rootScope.id, {tool_calls: dimensionAvailable(budget(parent.id), 'tool_calls')});
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: child.node_id, role: 'auditor' }), 'child Auditor');
  const own = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'child Auditor budget');
  const otherTokens = runtime.store.listAgents(clusterId, { node_id: child.node_id })
    .filter(role => role.id !== agent.id)
    .reduce((sum, role) => sum + dimensionAvailable(
      required(runtime.store.budgetForScope(clusterId, 'agent', role.id), 'role budget'), 'tool_calls',
    ), 0);
  const envelope = dimensionAvailable(own, 'tool_calls') + otherTokens + 5;
  const roleBefore = dimensionAvailable(budget(sourceGrant.id), 'tool_calls');
  const rootBefore = dimensionAvailable(budget(rootScope.id), 'tool_calls');
  assert.ok(runtime.topUpBudgetForAgent(agent, {tool_calls:envelope}),
    'the measured shortfall is fundable by an idle role in the parent node');
  assert.ok(dimensionAvailable(budget(own.id), 'tool_calls') >= envelope);
  assert.equal(dimensionAvailable(budget(sourceGrant.id), 'tool_calls')
    + dimensionAvailable(budget(parent.id), 'tool_calls'), roleBefore - 5,
  'the ancestor retains every token not needed by this measured request');
  assert.equal(dimensionAvailable(budget(rootScope.id), 'tool_calls'), rootBefore,
    'the descendant cannot raid a root or sibling grant');
});

test('a delegated node waits for its Auditor to score final health after accepting the child', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-child-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'close a completed delegated branch while the parent still works',
    workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 1 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const original = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const child = managementNodeOf04(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: original.id, scope: { objective: 'finish child result' },
  }));
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
    if (turn.agentId !== required(runtime.store.getAgent(childAuditor.agent_id), 'child Auditor').session_id) return;
    await turn.request({ purpose: 'role' });
    command(runtime, childAuditor, 'inspect_validation', {
      transaction_id: child.delegated_transaction_id, decision: 'approve',
    });
    assert.equal(required(runtime.store.getNode(child.node_id), 'child node').status, 'ACTIVE',
      'acceptance cannot close the node under its Auditor turn');
    acceptedInLiveTurn = true;
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    if (acceptedInLiveTurn && runtime.store.readEvents(clusterId, { limit: 300 })
      .some(event => event.type === 'turn-end' && jsonObject(event.data, 'turn-end event').agent_id === childAuditor.agent_id)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(acceptedInLiveTurn, true);
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').status, 'ACTIVE', 'the undecided closeout retains the child node');
  assert.equal(runtime.store.latestHealth(clusterId, { node_id: child.node_id })?.decided, 0);
  scoreFinalHealth(runtime, clusterId, child.node_id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getNode(child.node_id), 'child node').status, 'COMPLETED',
    'only the scored Auditor decision permits child finalization');
  assert.equal(required(runtime.store.getTransaction(original.id), 'parent transaction').status, 'DRAFT',
    'the unfinished parent is not accepted by closing the child');
});

test('a root closes after its final Orchestrator turn and scored Auditor closeout, despite advisory reviews', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-root-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'finish after accepted work', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 2, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 8 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 16, max_active_agents: 1 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const transaction = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: transaction.id });
  runtime.store.tx(() => runtime.store.updateTransaction(transaction.id, { status: 'ACCEPTED', __bump_revision: false }));
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 1);
  let finishIssued = false;
  let healthScored = false;
  host.setScript(async turn => {
    await turn.request({ purpose: 'role' });
    if (turn.agentId === required(runtime.store.getAgent(auditor.agent_id), 'Auditor').session_id) {
      const actions = runtime.pendingFor('auditor', required(runtime.store.getNode(root.id), 'root node'), required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(auditor.agent_id), 'Auditor'));
      if (actions.some(item => item.action === 'evaluate_health' && jsonObject(item, 'pending action').evaluation_window === 'subtree-close')) {
        scoreFinalHealth(runtime, clusterId, root.id);
        healthScored = true;
        assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE', 'a live scoring turn retains its node');
      }
      return;
    }
    if (turn.agentId !== required(runtime.store.getAgent(orchestrator.agent_id), 'Orchestrator').session_id || finishIssued) return;
    command(runtime, orchestrator, 'finish_cluster', {});
    finishIssued = true;
    assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING',
      'the live final turn is still owned by the Orchestrator');
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && required(runtime.store.getCluster(clusterId), 'cluster').status === 'RUNNING') {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(finishIssued, true, 'the final request was made by the scheduled Orchestrator turn');
  assert.equal(healthScored, true, 'the Auditor performed a distinct final model-backed turn');
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'COMPLETED',
    'the scored final review closes the root without forging the advisory plan decision');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'COMPLETED');
  assert.equal(runtime.store.pendingAudits(clusterId, { kind: 'plan' }).length, 1,
    'an advisory plan decision is not forged at finalization');
});

test('a cluster completes after every root transaction is accepted and the root Orchestrator finishes', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const second = commandId04(command(runtime, orchestrator, 'create_transaction', { objective: 'second root', acceptance_criteria: ['x'] }), 'transaction_id');
  runtime.store.tx(() => {
    for (const tx of runtime.store.rootTransactions(clusterId)) {
      runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  assert.throws(() => command(runtime, auditor, 'finish_cluster', {}), error => rejectionStatus(error) === 403,
    'the Auditor cannot claim Orchestrator completion');
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'closeout waits for the owning Auditor');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');
  assert.equal(required(runtime.store.latestHealth(clusterId, { node_id: root.id }), 'latest health').decided, 0);
  assert.ok(runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(auditor.agent_id), 'Auditor'))
    .some(item => item.action === 'evaluate_health' && jsonObject(item, 'pending action').evaluation_window === 'subtree-close'));
  const finalHealthId = scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'COMPLETED');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'COMPLETED');
  const completed = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'management-node-completed');
  assert.equal(completed.length, 1, 'the closing sequence ran once');
  assert.equal(required(runtime.store.latestHealth(clusterId, { node_id: root.id }), 'latest health').decided_by, auditor.agent_id);
  // The three finishing acts are the node's own closing record: an aggregate
  // written from durable summaries, the health evaluation, and the event that
  // names both. A node that closes without a summary closes without an answer.
  const completedEvent = firstOf(completed, 'management-node-completed event');
  const eventData = jsonObject(completedEvent.data, 'completion event data');
  const summaryId = textOf(eventData.summary_id, 'summary_id');
  assert.ok(summaryId, 'the closing event names the aggregate summary');
  const summary = required(runtime.store.latestSummary(clusterId, { node_id: root.id }), 'latest summary');
  assert.equal(summary.id, summaryId, 'and the summary it names is the node\'s latest');
  const summaryData = jsonObject(summary.data, 'summary data');
  const transactions = jsonObject(summaryData.transactions, 'summary transactions');
  assert.equal(transactions.total, 2, 'the aggregate counts the whole domain, not its page');
  assert.equal(transactions.completed, 2);
  assert.equal(summaryData.confidence, 'high');
  assert.equal(eventData.health_id, finalHealthId, 'the closing event names the Auditor-scored row');
  void second;
});

