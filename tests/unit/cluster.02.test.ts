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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { ClusterStore } from '../../packages/dsh-flow/src/core/store.ts';
import { checkWriteAccess } from '../../packages/dsh-flow/src/core/scope.ts';
import { dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
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

// -------------------------------------------------------- part-local doubles

import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent';
// Historical persistence envelopes intentionally omit modern SessionEvent fields.
import { fromAny, fromPartial } from '@total-typescript/shoehorn';

/** The session-persistence members a test scripts; the runtime calls nothing else. */
type PersistenceDouble02 = Partial<FlowPersistenceSeam>;

/** The runtime seam needs no nominal service state. Unscripted reads fail honestly. */
function fakePersistence02(double: PersistenceDouble02): FlowPersistenceSeam {
  return {
    // A double that does not model session existence must not *claim* the
    // session is absent: answering `undefined` is the store saying "there is no
    // such session", which turns a delivery whose prompt may be durable into a
    // proven absence and requeues it. Throwing is the honest answer — the
    // runtime reads it as "the probe could not tell" and scans the session
    // instead.
    stat: double.stat ?? (async () => { throw new Error('the delivery double does not model session existence'); }),
    open: double.open ?? (async () => { throw new Error('not found'); }),
  };
}

/**
 * A stand-in for one live Agent instance. `bindTurnIdentity` keys turn identity
 * on the object itself, so a test only needs a distinct identity per instance.
 */
function fakeAgent02(sessionId: string): Agent {
  const id = SessionId(sessionId);
  const inbox: Inbox = {
    nextTurn: [],
    nextStep: [],
    clear() {},
    append() {},
    prepend() {},
    replace() { return false; },
    remove() { return false; },
    splice() { return []; },
  };
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox,
    status: 'idle',
    ctx: new Context(),
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
}

/** A JSON array field of a command result, each element narrowed to an object. */
function jsonArray02(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) assert.fail(`${label} must be an array`);
  return value.map((item: unknown) => jsonObject(item, label));
}

/** The first object of a JSON array field of a command result. */
function jsonFirst02(value: unknown, label: string): Record<string, unknown> {
  return firstOf(jsonArray02(value, label), label);
}

test('a failure while preparing a turn still releases its permit, lease and entry', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { limits: { max_active_agents: 4, max_llm_concurrency: 2, max_role_turns: 6 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction').id });
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
  const second = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'worker-bound', status: 'DRAFT', acceptance_criteria: ['done'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: second });
  command(runtime, auditor, 'inspect_plan', { transaction_id: second, decision: 'approve' });
  const allocated = jsonFirst02(command(runtime, allocator, 'allocate_agent', { transaction_id: second }).result.allocations, 'allocations');
  runtime.store.tx(() => runtime.store.updateTransaction(second, { status: 'RUNNING', attempts: 1, __bump_revision: false }));
  const workerAgent = runtime.store.getAgent(textOf(allocated.agent_id, 'agent_id'));
  assert.ok(workerAgent, 'a worker exists for the second transaction');
  await runtime.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.llmSlotsInUse(), 0, 'the worker turn returned its permit too');
  assert.deepEqual(runtime.activeTurnIds(), []);
  assert.equal(runtime.store.all('SELECT * FROM leases WHERE cluster_id=?', clusterId).length, 0, 'no lease is left behind');
  runtime.collectDeliveries = original;
});

test('a released worker frees its child slot, so the ladder is not capped by task count', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-ladder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { workspace: dir, limits: { max_children: 2, max_depth: 3, max_agents: 64 } });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);

  const makeTx = (index: number) => {
    const tx = runtime.store.tx(() => runtime.store.insertTransaction({
      id: `ladder-${index}`, cluster_id: clusterId, owner_management_id: root.id, node_id: root.id,
      objective: `task ${index}`, status: 'READY', priority: 0, capabilities: ['fs_read'],
      expected_output: 'x', acceptance_criteria: ['x'],
    }));
    return required(tx, 'ladder transaction');
  };
  const allocate = (index: number) => jsonFirst02(command(runtime, allocator, 'allocate_agent', {
    transaction_id: makeTx(index).id, write_scope: [],
  }).result.allocations, 'allocations');
  const release = (allocationId: string) => command(runtime, allocator, 'release_agent', { allocations: [allocationId] });

  // max_children is 2: with slots held by finished nodes the third task can
  // never be allocated, which is what capped the scale ladder at one wave.
  const first = allocate(1);
  const second = allocate(2);
  assert.equal(runtime.store.childrenOf(root.id).length, 2);
  assert.throws(() => allocate(99), /max_children/, 'a held slot blocks the next wave');
  void orchestrator; void auditor;

  const firstAgentId = textOf(first.agent_id, 'first agent_id');
  const firstAllocationId = textOf(first.allocation_id, 'first allocation_id');
  const freedNode = required(runtime.store.getNode(required(runtime.store.getAgent(firstAgentId), 'first worker').node_id), 'freed node');
  release(firstAllocationId);
  assert.equal(required(runtime.store.getNode(freedNode.id), 'freed node').status, 'RELEASED', 'a released worker stops holding a child slot');
  const third = allocate(3);
  assert.ok(third.allocation_id, 'releasing a worker frees its child slot');
  const nodes = runtime.store.childrenOf(root.id);
  assert.equal(nodes.length, 2, 'the node is reused, not duplicated');
  assert.equal(required(runtime.store.getAgent(textOf(third.agent_id, 'third agent_id')), 'third worker').node_id, freedNode.id, 'the freed node hosts the next task');
  assert.notEqual(third.agent_id, firstAgentId, 'the new task runs as a fresh identity');

  const agents = runtime.store.listAgents(clusterId, { role: 'worker', limit: 50 });
  assert.equal(new Set(agents.map(agent => agent.id)).size, agents.length, 'each task gets a distinct worker identity');
  assert.ok(agents.length >= 3, `three tasks ran, saw ${agents.length}`);
  release(textOf(second.allocation_id, 'second allocation_id'));
  release(textOf(third.allocation_id, 'third allocation_id'));
});

test('receipt is proven by an incoming delivery marker, not by any mention of the id', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  runtime.attachPersistence(fakePersistence02({
    stat: async sessionId => (sessionId === agent.session_id ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
    open: async () => fromPartial<SessionHandle>({ read: async () => ({ eventState: 'detached', events: [] }) }),
  }));

  const send = async (id: string, toSelf: boolean, content: string) => {
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
  const sessions = new Map<string, readonly SessionEvent[]>();
  runtime.attachPersistence(fakePersistence02({
    stat: async sessionId => (sessionId === agent.session_id ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
    open: async sessionId => fromPartial<SessionHandle>({
      read: async () => ({ eventState: 'detached',
        events: [
          fromAny<SessionEvent, unknown>({ type: 'tool/result', data: { call_id: 'c1', result: `sent self-msg to <self>` } }),
          ...(sessions.get(sessionId) ?? []),
        ],
      }),
    }),
  }));

  const first = await runtime.collectDeliveries(agent);
  assert.deepEqual(first.ids, ['self-msg'], 'sending to yourself is not receiving');

  // Now the delivery really arrives: the incoming user message carries the marker.
  const recipient = required(runtime.store.getAgent(agent.id), 'recipient agent');
  sessions.set(recipient.session_id, [
    fromAny<SessionEvent, unknown>({ type: 'user/message', data: { content: `- from ${agent.id} [[flow-delivery self-msg seq 1]]: note to self` } }),
    // An unrelated event that merely mentions the id must not prove receipt either.
    fromAny<SessionEvent, unknown>({ type: 'tool/result', data: { call_id: 'c2', result: 'self-msg appears here again' } }),
  ]);
  runtime.settleDeliveries(clusterId, agent.id, ['self-msg'], { admitted: true, durable: false });
  const retry = await runtime.collectDeliveries(agent);
  assert.deepEqual(retry.ids, [], 'the marked incoming message proves receipt');
  assert.equal(retry.reconciled, 1);
  assert.equal(required(runtime.store.deliveryFor('self-msg', agent.id), 'self delivery').status, 'ACKED');
});

test('a retry after a mid-turn flush does not inject the message twice', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const messageId = 'mid-turn-flush-msg';
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: messageId, cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient(messageId, agent.id);
  });

  // The session starts out without the message.
  const durable = new Set<string>();
  runtime.attachPersistence(fakePersistence02({
    stat: async sessionId => (sessionId === agent.session_id ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
    open: async () => fromPartial<SessionHandle>({ read: async () => ({ eventState: 'detached', events: [] }) }),
  }));

  // Turn 1: the tool pipeline flushes the prompt, then the final flush fails.
  const first = await runtime.collectDeliveries(agent);
  assert.deepEqual(first.ids, [messageId], 'the first turn injects the message');
  durable.add(messageId);
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: false });
  assert.equal(required(runtime.store.deliveryFor(messageId, agent.id), 'delivery').status, 'PENDING');

  // The prompt *is* durable now, so the retry must ack it rather than replay it.
  runtime.attachPersistence(fakePersistence02({
    stat: async sessionId => (sessionId === agent.session_id ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
    open: async () => fromPartial<SessionHandle>({
      read: async () => ({ eventState: 'detached',
        events: [...durable].map(id => (fromAny<SessionEvent, unknown>({ type: 'user/message', data: { content: `x [[flow-delivery ${id} seq 1]]: y` } }))),
      }),
    }),
  }));
  const retry = await runtime.collectDeliveries(agent);
  assert.deepEqual(retry.ids, [], 'the retry injects nothing');
  assert.equal(retry.reconciled, 1);
  assert.equal(required(runtime.store.deliveryFor(messageId, agent.id), 'delivery').status, 'ACKED');
  const injected = runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='messages-injected'", clusterId);
  assert.equal(injected.length, 1, 'the message was injected exactly once');
  assert.equal(runtime.store.all("SELECT * FROM events WHERE cluster_id=? AND type='messages-ack-reconciled'", clusterId).length, 1);
});

test('a delivery is only acked once the session is flushed', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const messageId = 'flush-msg';
  runtime.store.tx(() => {
    runtime.store.insertMessage({
      id: messageId, cluster_id: clusterId, from_agent: agent.id, from_node: root.id,
      kind: 'direct', content: { text: 'x' },
    });
    runtime.store.insertRecipient(messageId, agent.id);
    runtime.store.markDeliveryInjected(messageId, agent.id);
  });
  const events = (type: string) => runtime.store.all('SELECT * FROM events WHERE cluster_id=? AND type=?', clusterId, type).length;

  // Admitted but not flushed: the message is not acked and becomes pending again.
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: false });
  assert.equal(required(runtime.store.deliveryFor(messageId, agent.id), 'delivery').status, 'PENDING', 'an unflushed message is not acked');
  assert.equal(events('messages-reopened'), 1);
  assert.equal(events('messages-acked'), 0);
  assert.match(
    String(firstOf(runtime.store.all('SELECT data FROM events WHERE type=?', 'messages-reopened'), 'reopened event').data),
    /not flushed/,
    'the reason names the missing flush, not a missing admission',
  );

  // Admitted and flushed: exactly one ack, after the recorded durable boundary.
  runtime.store.tx(() => runtime.store.markDeliveryInjected(messageId, agent.id));
  runtime.settleDeliveries(clusterId, agent.id, [messageId], { admitted: true, durable: true });
  assert.equal(required(runtime.store.deliveryFor(messageId, agent.id), 'delivery').status, 'ACKED');
  assert.equal(events('messages-acked'), 1);
  assert.equal(events('delivery-flushed'), 1, 'the flush boundary is recorded');
});

test('a turn identity belongs to one live agent instance, not to its session', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const firstInstance = fakeAgent02(agent.session_id);
  const secondInstance = fakeAgent02(agent.session_id);

  runtime.bindTurnIdentity(firstInstance, { agent_id: agent.id, epoch: 1, turn_seq: 1 });
  runtime.bindTurnIdentity(secondInstance, { agent_id: agent.id, epoch: 2, turn_seq: 2 });

  assert.equal(required(runtime.turnActor(firstInstance), 'first turn identity').epoch, 1, 'an old instance must keep its own epoch');
  assert.equal(required(runtime.turnActor(secondInstance), 'second turn identity').epoch, 2);
  assert.equal(runtime.turnActor(fakeAgent02(agent.session_id)), null, 'an unregistered instance owns no turn');
  assert.equal(runtime.turnActor(undefined), null);
});

test('the scheduling barrier gates every driver, and session existence is probed', async t => {
  const sessions = new Set(['session-exists']);
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: fakePersistence02({
      stat: async sessionId => (sessions.has(sessionId) ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
    }),
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
  runtime.store.tx(() => runtime.store.updateAgent(firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }), 'root agent').id, { status: 'BLOCKED' }));
  void root;

  // Session existence comes from the store, not from a counter.
  runtime.attachPersistence(fakePersistence02({
    stat: async sessionId => (sessions.has(sessionId) ? fromPartial<SessionPersistenceSnapshot>({ header: { id: sessionId } }) : undefined),
  }));
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

  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { workspace: dir });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, write_scope: ['alias'] });
  const allocation = firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation');
  const canonicalScope = required(allocation.write_scope_canonical, 'canonical write scope');
  assert.equal(allocation.write_scope[0], 'alias');
  assert.equal(canonicalScope.length, 1, 'the canonical grant is persisted');

  // Reload from SQLite: the canonical grant must come back, not be recomputed.
  const reloaded = new ClusterStore(runtime.store.path, { now });
  t.after(() => reloaded.close());
  const stored = firstOf(reloaded.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'stored allocation');
  assert.deepEqual(stored.write_scope_canonical, canonicalScope,
    'the canonical grant survives the SQLite boundary');
  assert.deepEqual(stored.write_scope, allocation.write_scope);

  // Retarget the alias at a sibling directory: the frozen grant must not follow.
  unlinkSync(join(dir, 'alias'));
  symlinkSync(join(dir, 'src', 'data'), join(dir, 'alias'));
  const afterRetarget = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: allocation.write_scope,
    writeScopeCanonical: canonicalScope,
    arguments: { path: 'alias/secret.ts' },
  });
  assert.equal(afterRetarget.allowed, false, 'a retargeted alias must not grant the new target');
  const stillOwned = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: allocation.write_scope,
    writeScopeCanonical: canonicalScope,
    arguments: { path: 'src/ui/App.jsx' },
  });
  assert.equal(stillOwned.allowed, true, 'the original directory is still owned');
});

test('root Orchestrator closes only after accepted work and its final communication', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { objective: 'After all work is accepted, publish the final total on the blackboard.' });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  assert.throws(() => command(runtime, orchestrator, 'finish_cluster', {}),
    error => rejectionStatus(error) === 409 && /ACCEPTED/.test(messageOf(error)));

  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false }));
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'accepted transactions do not skip the root objective');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');
  runtime.recover({ deferScheduling: true });
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'restart retains unfinished root work');
  const pending = runtime.pendingFor('orchestrator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(orchestrator.agent_id), 'orchestrator agent'));
  assert.ok(pending.some(item => item.action === 'finish_cluster'), 'the root Orchestrator has a final turn to publish');

  runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'publish', { key: 'total', value: 10 }));
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.recover({ deferScheduling: true });
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'an undecided final health marker cannot close a root');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');
  scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'COMPLETED');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'COMPLETED');
  assert.equal(JSON.parse(textOf(required(runtime.store.blackboardEntry(clusterId, 'total'), 'total blackboard entry').value, 'total value')), 10);
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
      runtime.store.updateTransaction(firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction').id, { status: 'ACCEPTED', __bump_revision: false });
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
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'one unfinished root must keep the cluster running');

  runtime.store.tx(() => {
    for (const tx of runtime.store.rootTransactions(clusterId)) {
      runtime.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
    }
  });
  command(runtime, orchestrator, 'finish_cluster', {});
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'RUNNING', 'the unfinished health judgement still holds the root');
  scoreFinalHealth(runtime, clusterId, root.id);
  runtime.evaluateCompletion(clusterId);
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'COMPLETED');

  // Progress must advance beyond a single 500-event page.
  const before = runtime.progressSeq(clusterId);
  runtime.store.tx(() => {
    for (let index = 0; index < 900; index += 1) runtime.store.appendEvent(clusterId, 'filler', { index });
  });
  assert.ok(runtime.progressSeq(clusterId) > before + 800, 'progress must not saturate at a page boundary');
  void auditor;
});

test('a message is never lost across the crash window, and never duplicated when admission is proven', async t => {
  const sessions = new Map<string, readonly unknown[]>();
  const runtime = makeRuntime(t, {}, {
    sessionPersistence: fakePersistence02({
      open: async sessionId => fromPartial<SessionHandle>({
        read: async () => ({ eventState: 'detached', events: sessions.get(sessionId) ?? [] }),
        close: async () => {},
      }),
    }),
  });
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');

  const sent = runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'send', {
    agent: auditor.id, content: 'status?', message_id: 'msg-crash-1',
  }));
  if (!('recipients' in sent)) assert.fail('send result must include recipients');
  assert.equal(sent.recipients.length, 1);

  // First process: the message is taken from the queue and injected, then the
  // process dies before the ack reaches SQLite.
  const collected = await runtime.collectDeliveries(auditor);
  assert.equal(collected.ids.length, 1);
  assert.equal(required(runtime.store.deliveryFor('msg-crash-1', auditor.id), 'delivery').status, 'DELIVERED');

  // Crash before the prompt was ever admitted: recovery preserves the attempt
  // until the session proves it absent, then requeues it without losing it.
  const recovered = runtime.recover();
  assert.equal(firstOf(recovered, 'recovery facts').injections_pending_proof, 1);
  assert.equal(required(runtime.store.deliveryFor('msg-crash-1', auditor.id), 'delivery').status, 'DELIVERED');
  assert.equal(runtime.store.pendingDeliveries(auditor.id).length, 0, 'an attempted delivery waits for proof');

  const reconciled = await runtime.reconcileDeliveries(clusterId);
  assert.equal(reconciled.persistence, true);
  assert.equal(reconciled.acknowledged, 0, 'an unreadable admission is not proof');
  assert.equal(required(runtime.store.deliveryFor('msg-crash-1', auditor.id), 'delivery').status, 'PENDING');

  // Second process: the prompt really was admitted and flushed, then the crash
  // hit before the ack. The Session is the proof, so only the ack is repaired
  // and the message is never delivered twice.
  const second = await runtime.collectDeliveries(auditor);
  // Deliberately replay the historical text-only event envelope at the persistence boundary.
  sessions.set(auditor.session_id, [fromAny<SessionEvent, unknown>({ type: 'user/message', data: { text: `- from x [[flow-delivery ${second.ids[0]} seq 1]]: status?` } })]);
  runtime.recover();
  assert.equal(required(runtime.store.deliveryFor('msg-crash-1', auditor.id), 'delivery').status, 'DELIVERED', 'the safe default preserves the attempt until proof is checked');
  const proven = await runtime.reconcileDeliveries(clusterId);
  assert.equal(proven.acknowledged, 1, 'a Session that carries the id proves admission');
  assert.equal(required(runtime.store.deliveryFor('msg-crash-1', auditor.id), 'delivery').status, 'ACKED');
  assert.equal(runtime.store.pendingDeliveries(auditor.id).length, 0, 'a proven delivery is never repeated');

  const resent = runtime.store.tx(() => runtime.communicateFrom(orchestrator, 'send', {
    agent: auditor.id, content: 'status?', message_id: 'msg-crash-1',
  }));
  if (!('deduped' in resent)) assert.fail('send result must include deduplication status');
  assert.equal(resent.deduped, true);
  assert.equal(firstOf(runtime.store.all('SELECT COUNT(*) AS c FROM recipients WHERE message_id=?', 'msg-crash-1'), 'recipient count').c, 1, 'exactly one delivery record');
  assert.equal(required(runtime.store.get('SELECT COUNT(*) AS c FROM messages WHERE cluster_id=?', clusterId), 'message count').c, 1);
});

test('reparent runs only at a safe point and rejects unsafe requests', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const child = command(runtime, allocator, 'spawn_management_node', { transaction_id: tx.id }).result;
  const childNodeId = textOf(child.node_id, 'child node_id');
  const childTransactionId = textOf(child.delegated_transaction_id, 'child transaction_id');

  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: root.id, new_parent_id: childNodeId }),
    error => rejectionStatus(error) === 409);

  // A subtree that still holds an open delegated assignment from its old
  // parent cannot move: the responsibility would be doubled.
  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: childNodeId, new_parent_id: root.id }),
    error => rejectionStatus(error) === 409 && /delegated assignment/.test(messageOf(error)));

  const grandchild = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: childTransactionId, node_id: childNodeId, scope: { objective: 'grandchild' },
  }).result;
  const grandchildNodeId = textOf(grandchild.node_id, 'grandchild node_id');
  const grandchildTransactionId = textOf(grandchild.delegated_transaction_id, 'grandchild transaction_id');
  assert.equal(required(runtime.store.getNode(grandchildNodeId), 'grandchild node').depth, 2);

  // Once the delegated assignment is terminal the same move is allowed. The new
  // parent must also be able to fund the subtree it takes on — that check is the
  // subject of a different test, so give it the capacity here.
  runtime.store.tx(() => {
    runtime.store.updateTransaction(childTransactionId, { status: 'ACCEPTED' });
    runtime.store.updateTransaction(grandchildTransactionId, { status: 'ACCEPTED' });
    const parentBudget = required(runtime.store.budgetForScope(clusterId, 'node', childNodeId), 'parent node budget');
    const row = required(runtime.store.getBudget(parentBudget.id), 'parent budget');
    runtime.store.updateBudget(parentBudget.id, {
      tool_calls_limit: Number(row.tool_calls_limit) + 40,
    });
  });
  const moved = command(runtime, allocator, 'reparent', { node_id: grandchildNodeId, new_parent_id: childNodeId });
  assert.equal(moved.result.to, childNodeId);
  assert.equal(required(runtime.store.getNode(grandchildNodeId), 'grandchild node').depth, 2);

  assert.throws(() => command(runtime, allocator, 'reparent', { node_id: childNodeId, new_parent_id: grandchildNodeId }),
    error => rejectionStatus(error) === 409);
});

test('lease epochs fence a stale actor and cancel terminates the subtree', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const worker = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');

  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-1', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'worker-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  assert.equal(required(runtime.store.leaseForAgent(worker.id), 'worker lease').epoch, 1);
  runtime.store.tx(() => {
    runtime.store.deleteLease('lease-1');
    runtime.store.createLease({
      id: 'lease-2', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
      purpose: 'worker-turn', epoch: 2, expires: now() + 60_000,
    });
  });
  assert.equal(required(runtime.store.leaseForAgent(worker.id), 'worker lease').epoch, 2);

  const cancelled = runtime.control(clusterId, 'cancel');
  assert.equal(cancelled.cluster.status, 'CANCELLED');
  assert.equal(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }).length, 0);
  assert.equal(firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction').status, 'CANCELLED');
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker agent').status, 'TERMINATED');
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
  assert.equal(required(runtime.store.getAgent(auditor.agent_id), 'auditor agent').status, 'READY');
  clock -= 5000;
});

test('recovery fences stale leases, marks in-flight effects uncertain and requeues', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const workerless = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'workerless transaction');
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'stale', cluster_id: clusterId, agent_id: firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor agent').id,
      node_id: root.id, purpose: 'auditor-turn', epoch: 3, expires: now() + 60_000,
    });
    runtime.store.insertEffect({
      call_id: 'call-started', cluster_id: clusterId, agent_id: firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor agent').id,
      node_id: root.id, lease_epoch: 3, tool: 'write', args: { path: 'x' }, status: 'STARTED',
    });
    runtime.store.updateTransaction(workerless.id, { status: 'RUNNING' });
  });
  const report = runtime.recover();
  assert.equal(report.length, 1);
  const recovery = firstOf(report, 'recovery facts');
  assert.equal(recovery.fenced_leases, 1);
  assert.equal(recovery.uncertain_effects, 1);
  assert.equal(recovery.requeued, 1);
  assert.equal(required(runtime.store.getEffect('call-started'), 'call effect').status, 'EFFECT_UNCERTAIN');
  assert.equal(runtime.query(actorFor(runtime, clusterId, 'auditor', root.id), 'effects', {}).items
    .find(row => row.call_id === 'call-started')?.status, 'EFFECT_UNCERTAIN',
  'the role query can inspect an uncertain effect before resolving it');
  assert.equal(required(runtime.store.getTransaction(workerless.id), 'workerless transaction').status, 'READY');
  assert.equal(runtime.store.listLeases(clusterId, {}).length, 0);
});

test('allocation operations: model selection, evaluation, replace, reassign, checkpoint and restore', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  const allocation = firstOf(runtime.store.listAllocations({ cluster_id: clusterId, status: 'ACTIVE' }), 'active allocation');
  const worker = required(runtime.store.getAgent(allocation.agent_id), 'worker');

  // Model selection is validated against the registered routes.
  const selected = command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'local-sglang', model: 'Qwen3.8-7B' });
  assert.equal(jsonObject(selected.result.model, 'model').model, 'Qwen3.8-7B');
  assert.equal(required(runtime.store.getAgent(worker.id), 'worker agent').meta.model?.model, 'Qwen3.8-7B');
  assert.throws(() => command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'local-sglang', model: 'not-a-model' }),
    error => rejectionStatus(error) === 409);
  assert.throws(() => command(runtime, allocator, 'select_model', { agent_id: worker.id, provider: 'cloud', model: 'x' }),
    error => rejectionStatus(error) === 409);

  const evaluated = command(runtime, allocator, 'evaluate_allocation', {});
  const capacity = jsonObject(evaluated.result.capacity, 'allocation capacity');
  assert.equal(numberOf(capacity.active_allocations, 0, 1_000_000, 'active_allocations'), 1);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const rootBudget = required(runtime.store.budgetForScope(clusterId, 'root', clusterId), 'root budget');
  const evaluatedBudgets = jsonArray02(evaluated.result.budgets, 'budgets');
  assert.deepEqual(evaluatedBudgets.map(budget => textOf(budget.id, 'budget id')), [nodeBudget.id, rootBudget.id],
    'allocation evaluation needs only the local capacity and its funding chain, not every agent grant');
  assert.equal(numberOf(jsonObject(firstOf(evaluatedBudgets, 'evaluated budget').available, 'budget availability').agents, 0, 1_000_000, 'agents'), dimensionAvailable(nodeBudget, 'agents'));
  assert.ok(JSON.stringify(evaluated.result).length < 3_000,
    'a role can read the capacity result in its next prompt');

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
  assert.equal(required(runtime.store.getAgent(worker.id), 'retired worker').status, 'TERMINATED');
  assert.equal(required(runtime.store.getAllocation(allocation.id), 'allocation').agent_id, replacement.result.agent_id);

  const otherTx = command(runtime, orchestrator, 'create_transaction', { objective: 'second', acceptance_criteria: ['a'] }).result;
  command(runtime, orchestrator, 'dispatch', { transaction_id: otherTx.transaction_id });
  command(runtime, allocator, 'reassign_agent', { agent_id: replacement.result.agent_id, transaction_id: otherTx.transaction_id });
  assert.equal(required(runtime.store.getAllocation(allocation.id), 'allocation').transaction_id, otherTx.transaction_id);
});

test('Allocator evaluation keeps every active allocation reachable after a bounded local capacity page', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 16, max_depth: 3, max_active_agents: 8, max_llm_concurrency: 2,
      max_corrections: 2, max_role_turns: 6 },
    budget: { tool_calls: 1000,
      wall_time_ms: 3_600_000, agents: 32, max_active_agents: 8 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const ids: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const txId = textOf(command(runtime, orchestrator, 'create_transaction', {
      objective: `deliver independent item ${index}`, acceptance_criteria: ['delivered'],
    }).result.transaction_id, 'transaction_id');
    command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
    ids.push(textOf(jsonFirst02(command(runtime, allocator, 'allocate_agent', { transaction_id: txId }).result.allocations, 'allocations').allocation_id, 'allocation_id'));
  }
  const first = command(runtime, allocator, 'evaluate_allocation', {}).result;
  const firstCapacity = jsonObject(first.capacity, 'first capacity');
  const firstAllocations = jsonArray02(first.allocations, 'first allocations');
  const second = command(runtime, allocator, 'evaluate_allocation', {
    offset: first.allocations_next_offset,
  }).result;
  const secondAllocations = jsonArray02(second.allocations, 'second allocations');
  assert.equal(numberOf(firstCapacity.active_allocations, 0, 1_000_000, 'active_allocations'), 7);
  assert.equal(numberOf(first.allocations_total, 0, 1_000_000, 'allocations_total'), 7);
  assert.equal(firstAllocations.length, 6);
  assert.equal(second.allocations_next_offset, null);
  assert.deepEqual(new Set([...firstAllocations, ...secondAllocations].map(allocation => textOf(allocation.allocation_id, 'allocation_id'))),
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
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'first transaction');
  const second = command(runtime, orchestrator, 'create_transaction', {
    objective: 'next unit of work', acceptance_criteria: ['next result exists'],
  }).result.transaction_id;
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  const allocation = required(runtime.store.activeAllocationForTransaction(first.id), 'active allocation');
  runtime.store.tx(() => {
    runtime.store.updateTransaction(first.id, { status: 'RUNNING', attempts: 1, __bump_revision: false });
    runtime.store.updateAgent(allocation.agent_id, { status: 'RUNNING' });
    runtime.store.createLease({
      id: 'live-replacement', cluster_id: clusterId, agent_id: allocation.agent_id,
      node_id: allocation.node_id, purpose: 'worker-turn', epoch: 1, expires: now() + 60_000,
    });
  });
  assert.throws(() => command(runtime, allocator, 'replace_agent', { allocation_id: allocation.id }),
    error => rejectionStatus(error) === 409 && /turn|lease|running/i.test(messageOf(error)));
  assert.throws(() => command(runtime, allocator, 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: second,
  }), error => rejectionStatus(error) === 409 && /turn|lease|running/i.test(messageOf(error)));
  assert.throws(() => command(runtime, allocator, 'release_agent', { allocation_id: allocation.id }),
    error => rejectionStatus(error) === 409 && /turn|lease|running/i.test(messageOf(error)));
  assert.equal(required(runtime.store.getAllocation(allocation.id), 'allocation').agent_id, allocation.agent_id);
  assert.equal(required(runtime.store.getAllocation(allocation.id), 'allocation').transaction_id, first.id);
  assert.equal(required(runtime.store.getAgent(allocation.agent_id), 'worker').status, 'RUNNING');
  assert.equal(required(runtime.store.getTransaction(first.id), 'transaction').status, 'RUNNING');
  assert.equal(required(runtime.store.leaseForAgent(allocation.agent_id), 'worker lease').id, 'live-replacement');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 200 }).some(e => e.type === 'agent-replaced'), false);

  runtime.store.tx(() => runtime.store.deleteLease('live-replacement'));
  assert.throws(() => command(runtime, allocator, 'reassign_agent', {
    agent_id: allocation.agent_id, transaction_id: second,
  }), error => rejectionStatus(error) === 409 && /running/i.test(messageOf(error)),
  'a vanished lease does not permit orphaning a RUNNING transaction');
  runtime.store.tx(() => {
    runtime.store.updateAgent(allocation.agent_id, { status: 'READY' });
    runtime.store.updateTransaction(first.id, { status: 'READY', __bump_revision: false });
  });
  const oldBudget = required(runtime.store.budgetForScope(clusterId, 'agent', allocation.agent_id), 'old worker budget');
  assert.ok(dimensionAvailable(oldBudget, 'tool_calls') > 0);
  const replacement = command(runtime, allocator, 'replace_agent', { allocation_id: allocation.id }).result;
  const replacementAgentId = textOf(replacement.agent_id, 'replacement agent_id');
  assert.notEqual(replacementAgentId, allocation.agent_id, 'replacement works after the turn drains');
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(oldBudget.id), 'old worker budget'), 'tool_calls'), 0,
    'unused funds from the retired Worker return to the same management node');
  assert.equal(dimensionAvailable(required(runtime.store.getBudget(oldBudget.id), 'old worker budget'), 'tool_calls'), 0);
  assert.ok(dimensionAvailable(required(runtime.store.budgetForScope(clusterId, 'agent', replacementAgentId), 'replacement budget'), 'tool_calls') > 0,
    'the new Worker inherits enough funding to make a real request');
});
