import { fixtureParams } from './task-fixtures.ts';
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
import { SessionId } from '@deepseek-ai/dsh-session';
import { fromPartial } from '@total-typescript/shoehorn';

import { ClusterRuntime, scheduleAdmission } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { FlowStartInternals, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
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

function startCluster(runtime: ClusterRuntime, overrides: Partial<FlowStartRequest> = {}, internals: FlowStartInternals = {}): string {
  const snapshot = runtime.start({
    objective: 'test objective',
    acceptance_criteria: ['The requested fixture deliverable is provided.'],
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
    ...overrides,
  }, internals);
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
test('a waiting Worker is admitted even when every management slot is pending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-fairshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'supervision must not eat the window', workspace: dir, capabilities: [],
    // A six-slot window with several management nodes: three roles each, so
    // supervision alone is always pending.
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6, max_llm_concurrency: 4, max_role_turns: 40 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 32, max_active_agents: 6 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'root transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 1, 'a Worker has work waiting');

  // Management work everywhere: two more management nodes, each with its own
  // three roles — six distinct management identities. Each spawn needs its own
  // delegated transaction: `spawn_management_node` returns the *existing* child
  // for a repeated one, so two calls with the same transaction built a single
  // node and the fixture never created the topology it claimed to.
  const spawnedNodes: string[] = [];
  for (const scope of ['alpha', 'beta']) {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective: `own ${scope}`, acceptance_criteria: ['x'], status: 'READY',
    });
    const delegatedId = textOf(created.result.transaction_id, 'transaction_id');
    const spawned = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
      transaction_id: delegatedId, scope: { objective: `own ${scope}` }, max_children: 4, spawn_children: 0,
    });
    spawnedNodes.push(textOf(spawned.result.node_id, 'node_id'));
  }
  assert.equal(new Set(spawnedNodes).size, 2, 'two distinct management children');
  const managementIdentities = numberOf(firstOf(runtime.store.all(
    "SELECT COUNT(DISTINCT a.id) AS c FROM agents a JOIN nodes n ON n.id = a.node_id WHERE a.cluster_id=? AND n.depth > 0",
    clusterId), 'management identities').c, 0, 1_000_000, 'management identities');
  assert.ok(managementIdentities >= 6, `six distinct management identities: ${managementIdentities}`);
  // Every turn the roles take makes a real change, and none of them is a Worker.
  let published = 0;
  let workerStarted = false;
  // Management turns do not release themselves: supervision keeps holding the
  // window for as long as the test runs, which is the shape that starved the
  // Workers. A self-releasing turn frees a slot and hides the rule under test.
  const managementBarrier = Promise.withResolvers<void>();
  const releaseManagement = (): void => { managementBarrier.resolve(undefined); };
  t.after(() => releaseManagement());
  const workerTurns = (): number => numberOf(firstOf(runtime.store.all(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.role')='worker'", clusterId), 'worker turns').c,
    0, 1_000_000, 'worker turns');
  // The management turns stay *live* until a Worker has run: that is the
  // starvation this test is about, where supervision holds the window open and
  // the work never gets a slot.
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role === 'worker') {
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
  const managementTurns = numberOf(firstOf(runtime.store.all(
    "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.role')<>'worker'", clusterId), 'management turns').c,
    0, 1_000_000, 'management turns');
  releaseManagement();
  assert.ok(managementTurns > 0, `supervision was running: ${managementTurns}`);
  assert.ok(workerTurns() > 0, `the waiting Worker was admitted (management turns: ${managementTurns})`);
  const starts = runtime.store.all("SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  assert.ok(starts.some(row => row.role === 'worker'), `roles that started: ${JSON.stringify(starts)}`);
});

test('the window keeps a slot for waiting work, whatever supervision wants', () => {
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
});

test('a receipt whose payer holds nothing is uncertain: nothing moves and the owner stops', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-holdmismatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a receipt that claims a hold it does not have', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  const scope = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget scope');
  runtime.store.tx(() => runtime.store.updateBudget(scope.id, { tool_calls_limit: 10, tool_calls_spent: 0, tool_calls_reserved: 0 }));
  // A receipt that says DISPATCHED with no reservation behind it.
  runtime.store.tx(() => runtime.store.insertToolCallReceipt({
    call_id: 'call-claiming', cluster_id: clusterId, agent_id: agent.id, session_id: agent.session_id,
    turn_seq: 1, tool: 'read', args_hash: 'h', command_id: null, budget_scope_id: scope.id,
    dispatch_status: 'DISPATCHED', result_body: null, error: null,
  }));
  const before = { reserved: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_reserved, spent: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_spent };
  const outcome = runtime.settleToolReceiptQuota('call-claiming');
  assert.equal(outcome.outcome, 'uncertain', `nothing is consumed or released: ${JSON.stringify(outcome)}`);
  const after = { reserved: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_reserved, spent: required(runtime.store.getBudget(scope.id), 'budget').tool_calls_spent };
  assert.deepEqual(after, before, 'the ledger does not move at all');
  assert.equal(required(runtime.store.getToolCallReceipt('call-claiming'), 'receipt').dispatch_status, 'DISPATCHED', 'and the receipt keeps its state');
  assert.equal(required(runtime.store.getAgent(agent.id), 'agent').status, 'BLOCKED', 'the owner stops');
  const events = runtime.store.readEvents(clusterId, { limit: 200 });
  assert.ok(events.some(event => event.type === 'accounting-uncertain' && /holds no tool-call reservation/.test(String(jsonObject(event.data, 'event.data').reason))));
  assert.ok(events.some(event => event.type === 'node-blocked' && jsonObject(event.data, 'event.data').code === 'ACCOUNTING_UNCERTAIN'));
});

test("a side-effect tool's long body is bounded in both ledgers, and they agree", async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-effectbody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a side-effect body that stays parseable', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator agent');
  // A live lease, which is what authorises a tool effect.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-body', cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    epoch: agent.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
  }));
  const scope = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget scope');
  runtime.store.tx(() => runtime.store.updateBudget(scope.id, { tool_calls_limit: 10, tool_calls_reserved: 0, tool_calls_spent: 0 }));

  // A side-effect tool: the admission writes a receipt *and* an effect.
  // A mutating call also needs the identity of a live instance, exactly as the
  // host's pipeline presents it.
  const instance = fromPartial<Parameters<typeof runtime.bindTurnIdentity>[0]>({ id: SessionId(agent.session_id) });
  const turnIdentity = {
    cluster_id: clusterId, agent_id: agent.id, node_id: agent.node_id,
    role: 'orchestrator', epoch: agent.epoch, lease_id: 'lease-body', turn_seq: 1,
  };
  runtime.bindTurnIdentity(instance, turnIdentity);
  // `job_output` is a side-effect tool that needs no write scope: the point here
  // is the *effect* ledger's body, not the scope gate.
  const exec = fromPartial<Parameters<typeof runtime.admitToolCall>[1]>({
    name: 'job_output', arguments: { job_id: 'job-1' }, agent: instance,
  });
  const admitted = runtime.admitToolCall(agent, exec, 'call-bash');
  assert.equal(admitted.ok, true, `the call is admitted: ${JSON.stringify(admitted)}`);
  const long = `out "quoted" \\n${'z'.repeat(20_000)}`;
  runtime.settleToolCall(agent, exec, 'call-bash',
    fromPartial<NonNullable<Parameters<typeof runtime.settleToolCall>[3]>>({ content: [{ type: 'text', text: long }] }),
    null, { charged: true });

  const receiptBody = JSON.parse(textOf(required(runtime.store.getToolCallReceipt('call-bash'), 'receipt').result_body, 'receipt body'));
  const effect = runtime.store.getEffect('call-bash');
  assert.ok(effect, 'the effect row exists');
  const effectBody = JSON.parse(textOf(effect.body, 'effect body'));
  assert.match(receiptBody.text, /chars omitted/, 'the receipt body states its omission');
  assert.equal(effectBody.text, receiptBody.text,
    'both ledgers hold the same bounded body');
  assert.ok(effectBody.text.length <= 8_200, `bounded, not unbounded: ${effectBody.text.length}`);
});

test('the inbox page shows the message a role must act on, not eight older notices', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inboxpriority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an inbox page that shows what matters', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const auditor = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor agent');
  // Eight older informational rows, then the message that matters. The page is
  // eight rows wide, so without a subject ordering the message is never seen —
  // the rows stay PENDING and hide it on every subsequent page too.
  runtime.store.tx(() => {
    for (let index = 0; index < 8; index += 1) {
      const row = runtime.store.insertInbox({
        cluster_id: clusterId, recipient: auditor.id, subject: 'plan-approved',
        payload: { transaction_id: `tx-${index}` },
      });
      runtime.store.run('UPDATE inbox SET created=? WHERE id=?', `2026-01-01T00:00:0${index}.000Z`, required(row, 'inbox row').id);
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

test('delegation refuses an unfunded child instead of creating unusable management roles', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const parent = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'root node budget');
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, {
      tool_calls_limit: 1,
    });
    for (const agent of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
      runtime.store.updateBudget(budget.id, {
        tool_calls_limit: 0,
      });
    }
  });
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { fixture_prepare_management: true, transaction_id: parent.id, scope: { objective: 'funded work' } }),
  error => rejectionStatus(error) === 409 && /fund|budget/i.test(messageOf(error)));
  assert.equal(runtime.store.listNodes(clusterId, {}).length, 1);
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId }).length, 1,
    'a failed funding decision creates no delegated task or management node');
});

test('Workers holding the window do not starve a management role that is owed a turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-workerpressure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 120_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'Workers must not hold every slot a manager needs', workspace: dir, capabilities: [],
    // A three-slot window must retain admission capacity for a management
    // role while Workers are eligible to fill it.
    limits: { max_children: 8, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 4, max_role_turns: 40 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  // The transactions are inserted READY and allocated here, so management is
  // owed *nothing* while the Workers take the window: no DRAFT to dispatch, no
  // plan audit pending, no unallocated transaction.
  // The transaction `start` created for the objective is taken out of the way:
  // this test is about the window, not about that transaction's dispatch.
  const initial = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: root.id }), 'initial transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(initial.id, { status: 'CANCELLED' }));
  const ids = ['pressure-a', 'pressure-b', 'pressure-c'];
  for (const id of ids) {
    runtime.store.tx(() => runtime.store.insertTransaction({
      id, cluster_id: clusterId, node_id: root.id, owner_management_id: root.id,
      objective: `work ${id}`, acceptance_criteria: ['x'], status: 'READY',
    }));
  }
  for (const id of ids) command(runtime, allocator, 'allocate_agent', { transaction_id: id });
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  for (const id of ids) command(runtime, auditor, 'inspect_plan', { transaction_id: id, decision: 'approve' });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 5 }).length, 3, 'three Workers have work waiting');

  const roles: FlowAgentRole[] = ['orchestrator', 'allocator', 'auditor'];
  const managementPending = () => roles.filter(role => {
    const agent = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role, limit: 1 }), `${role} agent`);
    return agent && agent.status !== 'TERMINATED' && runtime.pendingFor(role, root, cluster, agent).length;
  });
  assert.deepEqual(managementPending(), [], 'management is owed nothing before the Workers start');

  let released = false;
  const barrier = Promise.withResolvers<void>();
  const release = (): void => {
    released = true;
    barrier.resolve(undefined);
  };
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role === 'worker') {
      await barrier.promise;
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
  const firstId = firstOf(ids, 'first worker transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(firstId, {
    status: 'SUBMITTED', revision: required(runtime.store.getTransaction(firstId), 'first worker transaction').revision + 1,
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

