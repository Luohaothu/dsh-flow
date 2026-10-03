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
import { dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { AgentRecord, FlowStartInternals, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
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

function startCluster(runtime: ClusterRuntime, overrides: Partial<FlowStartRequest> = {}, internals: FlowStartInternals = {}): string {
  const snapshot = runtime.start({
    objective: 'test objective',
    workspace: '/tmp/workspace',
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 1000, tool_calls: 1000, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 4 },
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
  const outcome = runtime.command(actor, { command_id: `cmd-${counter}`, action, params, ...extra });
  return { deduped: outcome.deduped, revision: outcome.revision, result: jsonObject(outcome.result, 'command.result') };
}

// ==== CHUNK START ====
test('a waiting Worker is admitted even when every management slot is pending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-fairshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
    const spawned = command(runtime, allocator, 'spawn_management_node', {
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
  // The old rule — supervision first, then a Worker reserve subtracted again —
  // could only ever offer `window - live - 1`, which is why the Workers waited.
  const oldRule = ({ window, active }: { window: number; active: number }): number => Math.max(0, window - active - 1);
  assert.equal(oldRule({ window: 6, active: 6 }), 0, 'and that rule is what the fix replaces');
});

test('a receipt whose payer holds nothing is uncertain: nothing moves and the owner stops', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-holdmismatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
    'both ledgers hold the same bounded body (the effect used to hold the full output)');
  assert.ok(effectBody.text.length <= 8_200, `bounded, not unbounded: ${effectBody.text.length}`);
});

test('the inbox page shows the message a role must act on, not eight older notices', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inboxpriority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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

test('a child node is funded by the work it must do, and the parent keeps the rest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodeshare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = textOf(created.result.transaction_id, 'transaction_id');
  const rootBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'root node budget');
  const parentBefore = required(runtime.store.getBudget(rootBudget.id), 'parent budget');
  const spawned = command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that can work', acceptance_criteria: ['x'],
  });
  const childId = textOf(spawned.result.node_id, 'node_id');
  const childBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', childId), 'child node budget scope').id), 'child budget');
  const roleBudgets = runtime.store.all(
    "SELECT tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=?", childId);
  assert.ok(Number(childBudget.requests_limit) + roleBudgets.reduce((sum, row) => sum + Number(row.requests_limit), 0) >= 24,
    `the child can run its roles and a wave: ${JSON.stringify({ node: childBudget.requests_limit, roles: roleBudgets.length })}`);
  assert.ok(Number(childBudget.tokens_limit) + roleBudgets.reduce((sum, row) => sum + Number(row.tokens_limit), 0) >= 100_000,
    `and its turns are funded: ${childBudget.tokens_limit}`);
  // The parent keeps what its own roles need rather than handing a structural
  // share away: it is the scope those roles spend from.
  const parentAfter = required(runtime.store.getBudget(rootBudget.id), 'parent budget after delegation');
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
  const parent = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'root node budget');
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, {
      tokens_limit: 1000, requests_limit: 1, tool_calls_limit: 1,
    });
    for (const agent of runtime.store.listAgents(clusterId, { node_id: root.id, limit: 3 })) {
      const budget = required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
      runtime.store.updateBudget(budget.id, {
        tokens_limit: 0, requests_limit: 0, tool_calls_limit: 0,
      });
    }
  });
  assert.throws(() => command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { transaction_id: parent.id, scope: { objective: 'funded work' } }),
  error => rejectionStatus(error) === 409 && /fund|budget/i.test(messageOf(error)));
  assert.equal(runtime.store.listNodes(clusterId, {}).length, 1);
  assert.equal(runtime.store.listTransactions({ cluster_id: clusterId }).length, 1,
    'a failed funding decision creates no delegated task or management node');
});

test('a three-level delegation reserves capacity for the leaf after parent work', t => {
  const runtime = makeRuntime(t);
  const overrides = {
    capabilities: ['fs_read', 'fs_write'] as const,
    limits: { max_children: 8, max_depth: 4, max_active_agents: 6,
      max_llm_concurrency: 2, max_role_turns: 24, max_agents: 64 },
    budget: { tokens: 2_097_152, model_requests: 256, tool_calls: 2048,
      wall_time_ms: 1_800_000, agents: 64, max_active_agents: 6 },
  };
  const overridesInternals: FlowStartInternals = { delegation: [{ scope: 'deep/', objective: 'write deep/nested/result.txt',
      spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }] };
  const clusterId = startCluster(runtime, overrides, overridesInternals);
  let node = rootNode(runtime, clusterId);
  let transactionId = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction').id;
  for (let level = 1; level <= 3; level += 1) {
    const child = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { transaction_id: transactionId,
        scope: { objective: 'write deep/nested/result.txt' } }).result;
    node = required(runtime.store.getNode(textOf(child.node_id, 'node_id')), 'delegated node');
    transactionId = textOf(child.delegated_transaction_id, 'delegated transaction id');
    // In the strict live run, the first child had 520,873 tokens still
    // available against a 524,288-token *target*, only 3,415 short. Refusing
    // the whole delegation there sent its Allocator into 67 futile requests.
    // The parent may spend its own grant before the next child is ready.
    if (level < 3) {
      const budget = required(runtime.store.budgetForScope(clusterId, 'node', node.id), 'node budget scope');
      runtime.store.tx(() => runtime.store.updateBudget(budget.id, {
        tokens_spent: level === 1 ? 265_000 : 50_000, requests_spent: 5,
      }));
    }
  }
  const leafBudget = required(runtime.store.budgetForScope(clusterId, 'node', node.id), 'leaf node budget');
  const roles = firstOf(runtime.store.all(
    "SELECT SUM(tokens_limit) AS tokens, SUM(requests_limit) AS requests FROM budgets WHERE scope_kind='agent' AND node_id=?",
    node.id), 'leaf role budgets');
  assert.ok(Number(leafBudget.tokens_limit) + Number(roles.tokens) >= 262_144,
    'the deepest roles and Worker retain at least one eighth of the declared tokens');
  assert.ok(Number(leafBudget.requests_limit) + Number(roles.requests) >= 42,
    'the leaf retains capacity for management and a Worker request');
  assert.ok(dimensionAvailable(leafBudget, 'agents') >= 1,
    'the deepest management node still has an agent slot for its Worker');
  assert.deepEqual(jsonObject(required(runtime.store.getTransaction(transactionId), 'leaf transaction').inputs, 'transaction inputs').write_scope, ['deep/staging'],
    'the injected restriction is not erased to buy a pass');
});

test('a dry child draws only unallocated ancestor capacity, never a sibling grant', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nocrossbudget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = (objective: string, status: string): string => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status,
    });
    const id = textOf(created.result.transaction_id, 'transaction_id');
    return textOf(command(runtime, allocator, 'spawn_management_node', {
      transaction_id: id, objective, acceptance_criteria: ['x'],
    }).result.node_id, 'node_id');
  };
  const idleNodeId = spawn('a rich sibling branch', 'READY');
  const workNodeId = spawn('the branch with the work', 'READY');
  const idleNodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', idleNodeId), 'idle node budget');
  const workNode = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', workNodeId), 'work node budget scope').id), 'work node budget');

  // The branch with the work has nothing left; an active sibling keeps its
  // entire grant, while the shared parent still has unallocated capacity.
  runtime.store.tx(() => runtime.store.updateBudget(workNode.id, {
    tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1,
  }));
  runtime.store.tx(() => {
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE scope_kind='agent' AND node_id=?", workNodeId)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    }
  });
  const idleBefore = required(runtime.store.getBudget(idleNodeBudget.id), 'idle node budget');
  const parentBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'parent node budget scope');
  const parentBefore = required(runtime.store.getBudget(parentBudget.id), 'parent budget before top-up');
  const siblingBefore = runtime.store.all(
    "SELECT id, tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=? ORDER BY id", idleNodeId);
  const siblingAgentBudgets = () => runtime.store.all(
    "SELECT id, tokens_limit, requests_limit FROM budgets WHERE scope_kind='agent' AND node_id=? ORDER BY id", idleNodeId);
  const worker = firstOf(runtime.store.listAgents(clusterId, { node_id: workNodeId, role: 'orchestrator', limit: 1 }), 'work orchestrator');
  const granted = required(runtime.topUpBudgetForAgent(worker, { tokens: 20_000, model_requests: 1 }), 'budget top-up');
  assert.deepEqual(granted, { tokens: 20_000, model_requests: 1 },
    'only the measured request gap moves from an unallocated ancestor grant');
  const parentAfter = required(runtime.store.getBudget(parentBudget.id), 'parent budget after top-up');
  assert.equal(parentBefore.tokens_limit - parentAfter.tokens_limit, granted.tokens);
  assert.equal(parentBefore.requests_limit - parentAfter.requests_limit, granted.model_requests);
  const idleAfter = required(runtime.store.getBudget(idleNodeBudget.id), 'idle node budget after top-up');
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
  const runtime = await startFlowPlugin(host, {
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
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 }), 'orchestrator agent');
  // The cluster's capacity sits on the root scope, while this identity's node
  // holds nothing: the shape the observed run stopped on, at 22% of its budget.
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget scope');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id), 'agent budget scope');
  runtime.store.tx(() => {
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(agentBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
  });
  runtime.ensureTurnFunding(cluster, orchestrator);
  const agentAfter = required(runtime.store.getBudget(agentBudget.id), 'agent budget after funding');
  assert.ok(Number(agentAfter.tokens_limit) >= 16_384, `the identity can pay for a turn: ${agentAfter.tokens_limit}`);
  assert.ok(Number(agentAfter.requests_limit) >= 2, `and for its requests: ${agentAfter.requests_limit}`);
  const rootScope = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'root', clusterId), 'root budget scope').id), 'root budget');
  assert.ok(Number(rootScope.tokens_spent) >= 0 && Number(rootScope.tokens_limit) < 2_000_000,
    'the capacity came from the root scope rather than stranding there');
});

test('Workers holding the window do not starve a management role that is owed a turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-workerpressure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
    const text = turn.prompt?.content?.[0]?.text ?? '';
    if (text.startsWith('You are a Worker')) {
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

test('a refusal reclaims from idle siblings and never from a live one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-livegrant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const roles = runtime.store.listAgents(clusterId, { node_id: root.id, limit: 5 }).filter(agent => agent.role !== 'worker');
  const live = firstOf(roles.slice(0, 1), 'live sibling');
  const idle = firstOf(roles.slice(1, 2), 'idle sibling');
  const poor = firstOf(roles.slice(2, 3), 'poor agent');
  // One sibling is mid-turn; another is idle and holding a large unspent grant.
  runtime.store.tx(() => runtime.store.createLease({
    id: 'lease-live', cluster_id: clusterId, agent_id: live.id, node_id: live.node_id,
    epoch: live.epoch, purpose: 'role-turn', expires: runtime.timestamp() + 60_000,
  }));
  const budgetOf = (agent: AgentRecord) => required(runtime.store.budgetForScope(clusterId, 'agent', agent.id), 'agent budget');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', poor.node_id), 'node budget');
  runtime.store.tx(() => {
    runtime.store.updateBudget(budgetOf(live).id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 90, requests_spent: 0 });
    runtime.store.updateBudget(budgetOf(idle).id, { tokens_limit: 400_000, tokens_spent: 0, requests_limit: 60, requests_spent: 0 });
    runtime.store.updateBudget(budgetOf(poor).id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
    runtime.store.updateBudget(nodeBudget.id, { tokens_limit: 0, tokens_spent: 0, requests_limit: 0, requests_spent: 0 });
  });
  const granted = required(runtime.topUpBudgetForAgent(poor, { tokens: 20_000, model_requests: 4 }), 'top-up grant');
  assert.ok(granted, `the idle sibling funds the repair: ${JSON.stringify(granted)}`);
  // The idle donor was debited...
  const idleAfter = required(runtime.store.getBudget(budgetOf(idle).id), 'idle sibling budget after top-up');
  assert.equal(Number(idleAfter.requests_limit), 0, `the idle grant came home: ${idleAfter.requests_limit}`);
  assert.equal(Number(idleAfter.tokens_limit), 0, 'in both dimensions it held');
  // ...and the live one was not touched at all.
  const liveAfter = required(runtime.store.getBudget(budgetOf(live).id), 'live sibling budget after top-up');
  assert.equal(Number(liveAfter.requests_limit), 90, `the live turn keeps its grant: ${liveAfter.requests_limit}`);
  assert.equal(Number(liveAfter.tokens_limit), 400_000, 'and its tokens');
  const poorAfter = required(runtime.store.getBudget(budgetOf(poor).id), 'poor agent budget after top-up');
  assert.ok(Number(poorAfter.requests_limit) >= 4, `the identity can make its requests: ${poorAfter.requests_limit}`);
  void cluster;
});

test('a management node is created with room for a wave of Workers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-nodecapacity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'delegate', acceptance_criteria: ['x'], status: 'READY',
  });
  const delegatedId = textOf(created.result.transaction_id, 'transaction_id');
  const child = textOf(command(runtime, allocator, 'spawn_management_node', {
    transaction_id: delegatedId, objective: 'a child that can host Workers', acceptance_criteria: ['x'],
  }).result.node_id, 'node_id');
  const budget = required(runtime.store.budgetForScope(clusterId, 'node', child), 'child node budget');
  assert.ok(Number(budget.agents_limit) >= 3 + 3,
    `a child node can host its three roles and a wave of Workers: ${budget.agents_limit}`);
  // Its own roles are funded first, and the remainder is enough for the wave.
  const roleIds = runtime.store.all(
    "SELECT id FROM agents WHERE cluster_id=? AND node_id=?", clusterId, child);
  assert.equal(roleIds.length, 3, 'three management roles exist on the child');
  const childBudget = required(runtime.store.getBudget(budget.id), 'child node budget');
  const remaining = Number(childBudget.agents_limit) - Number(childBudget.agents_reserved);
  assert.ok(remaining >= 1, `and there is capacity left to allocate a Worker: ${remaining}`);
  // Its own roles must be able to run at all: a share of what is left over can
  // be one request or none, and then the node cannot run a single role turn.
  const requestWave = numberOf(firstOf(runtime.store.all(
    "SELECT SUM(requests_limit) AS c FROM budgets WHERE scope_kind='agent' AND node_id=?", child), 'role request total').c,
    0, 1_000_000, 'role request total');
  assert.ok(Number(requestWave) >= 6,
    `the child's three roles can make their turns: ${requestWave} requests granted to them`);
  const nodeAfterRoles = required(runtime.store.getBudget(budget.id), 'child node budget after role funding');
  assert.ok(Number(nodeAfterRoles.requests_limit) >= 2,
    `and the node keeps requests for its Worker wave: ${nodeAfterRoles.requests_limit}`);
});

test('a request is admitted when the node holds no requests and the pool no tokens', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-poolgap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const workerRole = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 1 }), 'orchestrator agent');
  const pool = required(runtime.store.getBudget(required(runtime.compactionBudgetId(clusterId), 'compaction budget id')), 'compaction budget');
  const node = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget scope');
  // The shape the run ended on: the node has tokens and no requests, the pool has
  // requests and no tokens, and the identity can pay for neither half.
  runtime.store.tx(() => {
    runtime.store.updateBudget(pool.id, { tokens_limit: 0, tokens_spent: 0, tokens_reserved: 0, requests_limit: 30, requests_spent: 7, requests_reserved: 0 });
    runtime.store.updateBudget(node.id, { tokens_limit: 900_000, tokens_spent: 0, tokens_reserved: 0, requests_limit: 2, requests_spent: 2, requests_reserved: 0 });
    // No identity on this node holds a request it could hand back either, so the
    // only scope that can be made payable is the pool — which needs tokens, the
    // one thing the node has.
    for (const row of runtime.store.all("SELECT id FROM budgets WHERE cluster_id=? AND scope_kind='agent'", clusterId)) {
      runtime.store.updateBudget(textOf(row.id, 'budget id'), { requests_limit: 0, requests_spent: 0, requests_reserved: 0 });
    }
  });
  // A real turn: its compaction request is the one that used to be refused, and
  // the receipt must name the pool as the scope that paid for it.
  let failure: unknown = null;
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
  const poolAfter = required(runtime.store.getBudget(pool.id), 'compaction budget after request');
  assert.equal(Number(poolAfter.tokens_spent) > 0 || Number(poolAfter.tokens_reserved) > 0, true,
    'the pool really paid the tokens, which is the funding the refusal lacked');
  assert.equal(Number(required(runtime.store.getBudget(node.id), 'node budget after request').requests_spent), 2,
    'and the token-rich node was not asked for requests it does not have');
});

test('the rebalance hint is executable by the identity that receives it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-rebalance-hint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawn = (objective: string): string => {
    const created = command(runtime, orchestrator, 'create_transaction', {
      objective, acceptance_criteria: ['x'], status: 'READY',
    });
    const id = textOf(created.result.transaction_id, 'transaction_id');
    return textOf(command(runtime, allocator, 'spawn_management_node', { transaction_id: id, objective }).result.node_id, 'node_id');
  };
  const dry = spawn('the node that runs out');
  const idle = spawn('the node that does not spend');
  const dryBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', dry), 'dry budget scope').id), 'dry budget');
  const idleBudget = required(runtime.store.getBudget(required(runtime.store.budgetForScope(clusterId, 'node', idle), 'idle budget scope').id), 'idle budget');
  runtime.store.tx(() => runtime.store.updateBudget(dryBudget.id, {
    tokens_limit: 1_000, tokens_spent: 1_000, requests_limit: 1, requests_spent: 1,
  }));
  assert.ok(dimensionAvailable(required(runtime.store.getBudget(idleBudget.id), 'idle budget before block'), 'tokens') > 65_536,
    'the sibling really holds idle capacity');

  const dryAllocator = firstOf(runtime.store.listAgents(clusterId, { node_id: dry, role: 'allocator', limit: 1 }), 'dry allocator');
  const rootAllocator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator', limit: 1 }), 'root allocator');
  assert.equal(runtime.pendingFor('allocator', root, cluster, rootAllocator)
    .some(item => {
      if (item.action !== 'rebalance_budget') return false;
      const pending = jsonObject(item, 'pending action');
      return pending.to !== undefined && jsonObject(pending.to, 'pending target').id === dry;
    }), false,
    'a zero balance alone cannot name the next request or justify a one-token model turn');
  runtime.blockNodeInternal(clusterId, dry, 'BUDGET: refused next role request', 'BUDGET_EXHAUSTED', {
    agent_id: dryAllocator.id, dimension: 'tokens', requested: 16_000,
    envelope: { tokens: 16_000, model_requests: 1, tool_calls: 0 },
  });
  // The dry subtree's own Allocator cannot move a sibling's capacity: the hint
  // must not be published to it, because `rebalance_budget` would answer 403.
  const ownActions = runtime.pendingFor('allocator', required(runtime.store.getNode(dry), 'dry node'), cluster, dryAllocator);
  // Whatever it is told must be executable by it: `rebalance_budget` allows an
  // actor to move capacity only inside its own domain, so the sibling branch may
  // never appear among its sources.
  for (const action of ownActions.filter(entry => entry.action === 'rebalance_budget')) {
    const options = jsonObject(action, 'rebalance action').from_options;
    assert.ok(Array.isArray(options), 'rebalance hints list candidate sources');
    assert.ok(options.every((option: unknown) => {
      const sourceOption = jsonObject(option, 'source option');
      return sourceOption.scope_kind === 'agent' || sourceOption.scope_id === dry;
    }), `only sources inside its own domain: ${JSON.stringify(options)}`);
    assert.equal(options.some((option: unknown) => jsonObject(option, 'source option').scope_id === idle), false,
      'never the sibling branch it cannot reach');
  }

  // The ancestor's Allocator owns both ends, and the hint is executable as it.
  const actions = runtime.pendingFor('allocator', root, cluster, rootAllocator);
  const hint = actions.find(action => action.action === 'rebalance_budget');
  assert.ok(hint, `the ancestor is told what to move: ${JSON.stringify(actions.map(a => a.action))}`);
  const hintFields = jsonObject(hint, 'rebalance hint');
  assert.deepEqual(jsonObject(hintFields.to, 'hint target'), { kind: 'node', id: dry }, 'into the node that is out');
  assert.equal(jsonObject(hintFields.required, 'required envelope').tokens, 16_000, 'the hint carries the refused envelope');
  const fromOptions = hintFields.from_options;
  assert.ok(Array.isArray(fromOptions), 'rebalance hints list candidate sources');
  const source = fromOptions.find((option: unknown) => jsonObject(option, 'source option').scope_id === idle);
  assert.ok(source, `and from the scope that holds it: ${JSON.stringify(fromOptions)}`);

  // Executing exactly that transfer as the notified identity succeeds, and the
  // capacity really moves.
  const moved = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'rebalance_budget', {
    from: { kind: 'node', id: idle }, to: { kind: 'node', id: dry },
    amounts: { tokens: 60_000, model_requests: 4 },
  });
  assert.ok(moved.result, `the suggested transfer runs: ${JSON.stringify(moved).slice(0, 200)}`);
  const after = required(runtime.store.getBudget(dryBudget.id), 'dry budget after rebalance');
  assert.equal(Number(after.tokens_limit), 61_000, 'the dry node can act again');
  assert.equal(runtime.store.readEvents(clusterId, { limit: 200 }).filter(event => event.type === 'budget-rebalanced').length, 1,
    'and the ledger shows the Allocator made that call');
  void source;
});

