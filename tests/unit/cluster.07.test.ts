/**
 * Mechanism tests for ClusterRuntime: the management tree, transaction
 * lifecycle, role permissions, business acceptance, budgets, communication, the
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

import { fixtureParams } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

// ---------------------------------------------------------------- test harness

let clock = 1_800_000_000_000;
const now = (): number => clock;

/** The fake host this suite drives the plugin with. */
import type { FakeHost, FakeTurn } from './fake-host.ts';

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
  const snapshot = runtime.start({ managementCapabilities: [],
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

/**
 * A real, observable state change for a test turn: the blackboard entry *and* its
 * event. Writing the table alone is invisible to the progress accounting, which is
 * how a test turn can look stagnant.
 */
function touchBlackboard(runtime: ClusterRuntime, clusterId: string, key: string, agentId: string | null = null): void {
  runtime.store.tx(() => {
    runtime.store.setBlackboard(clusterId, key, { at: key }, null, agentId);
    runtime.store.appendEvent(clusterId, 'blackboard', { key, revision: 1, by: agentId });
  });
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

// ==== CHUNK START ====
import { fromPartial } from '@total-typescript/shoehorn';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

/** The JSON object one durable event row carries, narrowed from its data column. */
function eventData07(event: { readonly data: unknown }): Record<string, unknown> {
  return jsonObject(event.data, 'event data');
}

/** One event's `actions` list, empty when it recorded none. */
function eventActions07(event: { readonly data: unknown }): readonly unknown[] {
  const actions = eventData07(event).actions;
  return Array.isArray(actions) ? actions : [];
}

test('restore refuses a checkpoint the session is not at, and fences the instance it replaces', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = required(runtime.store.getAgent(firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation').agent_id), 'worker agent');

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
  const idleWorker = required(runtime.store.getAgent(firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation').agent_id), 'idle worker');
  const checkpointId = required(checkpoint, 'checkpoint').id;
  const before = required(runtime.store.getAgent(worker.id), 'worker before');

  // Ahead of the checkpoint: history was appended after it, so it cannot be
  // restored — and nothing may change while it is refused.
  runtime.sessionOffsetOf = () => 15;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: worker.id }), /cannot be rewound|session is at/);
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker').epoch, before.epoch, 'a refused restore does not advance the epoch');

  // Unknown: the session offset cannot be read, so nothing proves it is at the
  // checkpoint.
  runtime.sessionOffsetOf = () => null;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: worker.id }), /cannot be validated/);
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker').epoch, before.epoch, 'and a second refusal still changes nothing');

  // At the checkpoint: accepted, and the identity is fenced for real — the lease
  // the replaced instance holds is gone, which is what its finisher reads.
  runtime.sessionOffsetOf = () => 12;
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-old', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    epoch: before.epoch, purpose: 'worker-turn', expires: runtime.timestamp() + 60_000,
  }));
  const oldLease = required(runtime.store.getLease('lease-old'), 'old lease');
  assert.equal(runtime.leaseStillHeld(oldLease), true, 'the replaced instance holds a live lease');
  const restored = command(runtime, allocator, 'restore', { agent_id: worker.id, checkpoint_id: checkpointId }).result;
  assert.equal(restored.checkpoint_id, checkpointId);
  assert.equal(restored.native_offset, 12);
  assert.equal(runtime.store.getLease('lease-old'), null, 'the old lease is deleted');
  assert.equal(runtime.leaseStillHeld(oldLease), false, 'so the replaced instance can no longer publish');
  assert.ok(required(runtime.store.getAgent(worker.id), 'worker').epoch > before.epoch, 'and the epoch advanced');
  const fenced = runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'lease-fenced');
  assert.equal(fenced.length, 1, 'the fencing is recorded');
  assert.equal(eventData07(firstOf(fenced, 'lease-fenced')).lease_id, 'lease-old');

  // An idle identity with history and a checkpoint that records no offset: the
  // host has no live instance to ask, so nothing verifies the session — refused,
  // and again with no mutation.
  const idleCheckpoint = runtime.store.tx(() => runtime.store.insertCheckpoint({
    id: 'cp-idle', cluster_id: clusterId, agent_id: idleWorker.id, session_id: idleWorker.session_id,
    flushed_seq: null, events_seq: runtime.store.latestEventSeq(clusterId),
    transaction_id: null, transaction_revision: null, inbox_ack_cursor: null, usage_watermark: null,
    turn_seq: 4, data: { reason: 'idle checkout' },
  }));
  const idleCheckpointId = required(idleCheckpoint, 'idle checkpoint').id;
  const idleBefore = required(runtime.store.getAgent(idleWorker.id), 'idle worker before');
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-idle', cluster_id: clusterId, agent_id: idleWorker.id, node_id: idleWorker.node_id,
    epoch: idleBefore.epoch, purpose: 'worker-turn', expires: runtime.timestamp() + 60_000,
  }));
  runtime.sessionOffsetOf = () => null;
  assert.throws(() => command(runtime, allocator, 'restore', { agent_id: idleWorker.id, checkpoint_id: idleCheckpointId }), /cannot be validated/);
  assert.equal(required(runtime.store.getAgent(idleWorker.id), 'idle worker').epoch, idleBefore.epoch, 'no epoch bump for the unverified checkpoint');
  assert.ok(runtime.store.getLease('lease-idle'), 'and its lease is untouched');
});

test('a cluster tool call without a stable host call id is refused before anything is reserved', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-callid-'));
  const host = createFakeHost();
  const turnStarted = Promise.withResolvers<FakeTurn>();
  const finishTurn = Promise.withResolvers<void>();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => {
    finishTurn.resolve();
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'one refused tool call', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');

  // Hold the admitted turn and dispatch through its actual agent-scoped waterfall.
  host.setScript(async turn => {
    if (turn.session.id === agent.session_id) turnStarted.resolve(turn);
    await finishTurn.promise;
  });
  runtime.enableScheduling();
  await runtime.tick();
  const turn = await turnStarted.promise;

  const before = {
    effects: runtime.store.effectsAll(clusterId, {}).length,
    receipts: firstOf(runtime.store.all('SELECT COUNT(*) AS c FROM tool_call_receipts WHERE cluster_id=?', clusterId), 'receipt count').c,
    budget: required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id), 'node budget'),
  };
  let nextCalled = false;
  const result = await turn.agentCtx.ctx.waterfall('tools/execute', fromPartial<ToolDispatchExecution>({
    name: 'flow_query',
    agent: fromPartial<Agent>(turn.live),
    signal: new AbortController().signal,
  }), async (): Promise<ToolExecutionResult> => { nextCalled = true; return { isError: false, value: null, content: [] }; });

  assert.equal(nextCalled, false, 'the tool never dispatched');
  assert.equal(result?.isError, true, 'and the host is told why');
  assert.equal(result?.error?.info?.code, 'TOOL_IDENTITY_MISSING');
  const after = {
    effects: runtime.store.effectsAll(clusterId, {}).length,
    receipts: firstOf(runtime.store.all('SELECT COUNT(*) AS c FROM tool_call_receipts WHERE cluster_id=?', clusterId), 'receipt count').c,
    budget: required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget').id), 'node budget'),
  };
  assert.equal(after.effects, before.effects, 'no effect was created');
  assert.equal(after.receipts, before.receipts, 'no receipt was created');
  assert.deepEqual(after.budget, before.budget, 'and no quota moved');
  const refused = runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'tool-call-refused');
  assert.equal(refused.length, 1, 'the refusal is recorded');
  assert.equal(eventData07(firstOf(refused, 'refusal')).code, 'TOOL_IDENTITY_MISSING');
});

test('a critical notification alone wakes its role and is consumed exactly once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-critical-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'an idle role with one critical message', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'allocator');

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
  const turnsAfterNoise = runtime.store.readEvents(clusterId, { limit: 300 }).filter(event => event.type === 'turn-start' && eventData07(event).role === 'allocator').length;
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
  const actionEvents = runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'turn-actions' && eventData07(event).role === 'allocator');
  assert.ok(actionEvents.some(event => eventActions07(event).includes('inbox')), `the message was taken into a turn: ${JSON.stringify(actionEvents.map(event => eventActions07(event)))}`);
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
  assert.equal(firstOf(anomalies, 'anomaly').status, 'CONSUMED', 'and stays consumed');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === 'inbox-reopened' && Number(eventData07(event).count) >= 1).length, 0,
    'nothing hands it back');
});

test('an Allocator waits until the revised contract is dispatched before allocating it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, priority: 8 });
  assert.equal(runtime.store.getTransaction(tx.id)?.status, 'DRAFT');
  assert.equal(runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(allocator.agent_id)).some(item => item.action === 'allocate_agent'), false);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  assert.equal(runtime.pendingFor('allocator', root, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(allocator.agent_id)).some(item => item.action === 'allocate_agent'), true);
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = runtime.store.activeAllocationForTransaction(tx.id);
  assert.ok(allocation);
  assert.equal(runtime.store.getTransaction(tx.id)?.priority, 8);
});

test('a revalidation answers its issue with a new positive validation of the same publication', t => {
  const runtime = makeRuntime(t), clusterId = startCluster(runtime), root = rootNode(runtime, clusterId);
  const lead = actorFor(runtime, clusterId, 'orchestrator', root.id), tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, lead, 'dispatch', { transaction_id: tx.id });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { claim: 'done' } });
  command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: true });
  const accepted = required(runtime.store.getTransaction(tx.id), 'accepted');
  const requested = command(runtime, lead, 'reopen_transaction', { transaction_id: tx.id, mode: 'revalidate', required_change: 'Repeat the acceptance check against the published artifact.' });
  const issueId = textOf(requested.result.issue_id, 'issue');
  assert.equal(runtime.store.getTransaction(tx.id)?.status, 'SUBMITTED');
  assert.deepEqual(runtime.store.getTransaction(tx.id)?.current_result_ref, accepted.current_result_ref);
  assert.throws(() => command(runtime, lead, 'resolve_issue', { issue_id: issueId, decision: 'CORRECTED', evidence: { checked: 'No fresh validation exists yet.' } }), /validation|accepted|current/i);
  command(runtime, lead, 'validate', { transaction_id: tx.id, accepted: true });
  command(runtime, lead, 'resolve_issue', { issue_id: issueId, decision: 'CORRECTED', evidence: { checked: 'The repeated acceptance check passed against the same immutable publication.' } });
  assert.equal(runtime.store.getIssue(issueId)?.status, 'CORRECTED');
  assert.equal(runtime.store.getIssue(issueId)?.corrections, 0);
});
test('a turn that never admitted its prompt hands the critical message back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [],
    objective: 'a turn that fails before admitting', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const allocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 5 }), 'allocator');
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
  assert.equal(firstOf(queued, 'queued message').status, 'PENDING', 'and it is queued again rather than lost');

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
  assert.equal(firstOf(runtime.store.all("SELECT status FROM inbox WHERE cluster_id=? AND subject='agent-anomaly'", clusterId), 'anomaly').status, 'CONSUMED', 'and the retry consumes it exactly once');
});

test('a dispatched tool call is charged once at recovery, across two restarts', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tool_calls: 20, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const owner = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const scope = required(runtime.store.budgetForScope(clusterId, 'agent', owner.id), 'agent budget').id;

  runtime.store.tx(() => runtime.store.updateBudget(scope, { tool_calls_limit: 20, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  const seed = (callId: string, dispatchStatus: 'DISPATCHED' | 'ADMITTED') => {
    runtime.store.tx(() => {
      runtime.store.insertToolCallReceipt({
        call_id: callId, cluster_id: clusterId, agent_id: owner.id, session_id: owner.session_id,
        turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope,
        dispatch_status: dispatchStatus, result_body: null, error: null,
      });
      runtime.store.updateBudget(scope, { tool_calls_reserved: required(runtime.store.getBudget(scope), 'scope budget').tool_calls_reserved + 1 });
    });
  };
  const counters = () => ({
    reserved: required(runtime.store.getBudget(scope), 'scope budget').tool_calls_reserved,
    spent: required(runtime.store.getBudget(scope), 'scope budget').tool_calls_spent,
  });

  // A read that dispatched and whose outcome the restart made unknown: exactly one
  // call is consumed, with no effect row and no human decision.
  seed('read-dispatched', 'DISPATCHED');
  seed('read-admitted', 'ADMITTED');
  assert.deepEqual(counters(), { reserved: 2, spent: 0 });

  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'the dispatched read costs one call; the admitted one costs nothing');
  assert.equal(required(runtime.store.getToolCallReceipt('read-dispatched'), 'receipt').dispatch_status, 'UNKNOWN');
  assert.equal(required(runtime.store.getToolCallReceipt('read-admitted'), 'receipt').dispatch_status, 'CANCELLED');

  // A second restart changes nothing: the reconciliation is idempotent.
  runtime.recover({ deferScheduling: true });
  assert.deepEqual(counters(), { reserved: 0, spent: 1 }, 'the second restart charges nothing again');
});
