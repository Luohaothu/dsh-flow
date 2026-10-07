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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { reserveLlmRequest, settleLlmRequest } from '../../packages/dsh-flow/src/core/runtime.ts';
import { budgetView, dimensionAvailable } from '../../packages/dsh-flow/src/core/budget.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import { correctionWitness } from '../acceptance/checks/recursion.ts';
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
test('the Auditor reviews new or revised issues once, never spins on an unchanged one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-verdict-'));
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
    objective: 'one correction and its verdict', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 40 },
    budget: { tokens: 2_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');

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
  // Which actions the Auditor's turns are actually offered in this phase — the
  // interface the scheduler uses, read from the durable record rather than from a
  // copy of the selection rule.
  const auditorTurnActions = () => runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'turn-actions' && eventData07(event).role === 'auditor');
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
    const all = turns.flatMap(event => eventActions07(event));
    return { phase: turns.slice(before).flatMap(event => eventActions07(event)), all };
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
  const issueId = textOf(rejection.issue_id, 'issue_id');
  const afterRejection = await offeredInPhase();
  // The pending action asks for review without declaring an unchanged issue
  // either resolved or mistaken. A wrong report can still be withdrawn.
  assert.ok(afterRejection.phase.includes('review_issue'),
    `the issue is offered for independent review: ${JSON.stringify(afterRejection.phase)}`);

  // 3. Before any change there is nothing to verify at all: the call is refused,
  //    and the correction budget is untouched.
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'NOT_FIXED', evidence: {} }),
    /correction to verify/);
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').corrections, 0, 'a verdict without a correction costs nothing');
  const afterFailed = await offeredInPhase();
  // The unprogressed candidate is one-shot: the Auditor has had a turn since the issue was
  // opened and nothing has changed, so it is not queued again — a genuine issue that no
  // repair has addressed must not manufacture an endless stream of Auditor turns (which
  // would burn its turn budget and stop the node for stagnation). A repair re-arms the
  // verdict through the ordinary `progressed` path.
  const stillOffered = runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'),
    firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor'))
    .filter(item => item.action === 'review_issue');
  assert.equal(stillOffered.length, 0,
    `an unchanged issue is not queued again after the Auditor has looked: ${JSON.stringify(stillOffered)}`);
  void afterFailed;

  // 4. The durable change earns the verdict.
  const adjusted = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, acceptance_criteria: ['a depth-3 management node exists'],
  }).result;
  assert.ok(Number(adjusted.revision) > 1);
  const afterAdjust = await offeredInPhase();
  assert.ok(afterAdjust.phase.includes('review_issue'),
    `the revised issue is offered for review: ${JSON.stringify(afterAdjust.phase)}`);
  // The gate's witness reads the same durable facts.
  const adjustments = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'transaction-adjusted')
    .map(event => {
      const data = eventData07(event);
      return {
        transaction_id: textOf(data.transaction_id, 'transaction_id'),
        revision: numberOf(data.revision, 0, Number.MAX_SAFE_INTEGER, 'revision'),
      };
    });
  const issueForWitness = required(runtime.store.getIssue(issueId), 'issue');
  const witnessIssue = {
    transaction_id: issueForWitness.transaction_id,
    target_revision: issueForWitness.target_revision,
    corrections: issueForWitness.corrections,
  };
  assert.equal(correctionWitness([witnessIssue], adjustments).length, 1);
  // A bare failed counter, with no durable change, is not a correction.
  assert.equal(correctionWitness([{ ...witnessIssue, transaction_id: 'other', corrections: 2 }], adjustments).length, 0);
  // And a failed verdict *after* a real change does move the counter, which is
  // what bounds the loop.
  command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'NOT_FIXED', evidence: {} });
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').corrections, 1, 'the failed attempt on a changed revision is counted');

  // 5. Closed, and never offered again.
  command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'VERIFIED', evidence: { revision: adjusted.revision } });
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').status, 'CORRECTED');
  const afterClosure = await offeredInPhase();
  assert.ok(!afterClosure.phase.includes('review_issue'),
    `a closed issue is never offered again: ${JSON.stringify(afterClosure.phase)}`);
});

test('an undecided audit is revisited turn after turn, and probing never consumes it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-auditcursor-'));
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
    objective: 'one plan audit nobody decides', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 2_000_000, model_requests: 60, tool_calls: 60, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });

  // The Auditor takes its turn and decides nothing: the audit stays pending. The
  // scheduling pass probes for work (`#managementPending`) before every turn, and
  // a probe that advanced the cursor would hand the real turn an empty page — the
  // audit would then never be presented again.
  const offered = [];
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    const promptText = required(firstOf(required(required(turn.prompt, 'prompt').content, 'prompt content'), 'prompt content item').text, 'prompt text');
    offered.push(promptText.slice(0, 400));
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 6; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  const actionEvents = runtime.store.readEvents(clusterId, { limit: 500 })
    .filter(event => event.type === 'turn-actions' && eventData07(event).role === 'auditor');
  const withAudit = actionEvents.filter(event => eventActions07(event).includes('inspect_plan'));
  assert.ok(withAudit.length >= 2,
    `the Auditor was offered the pending audit on more than one turn: ${JSON.stringify(actionEvents.map(event => eventActions07(event)))}`);
  assert.equal(runtime.store.pendingAudits(clusterId, { node_id: root.id, kind: 'plan', limit: 5 }).length, 1,
    'and the audit is still pending, because nobody decided it');
  assert.ok(offered.length >= 2, `the turns really ran: ${offered.length}`);
});


test('a resumed Auditor receives parseable action evidence without a repeated full domain snapshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-audit-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  for (const tx of transactions) command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateAgent(auditor.agent_id, { turns: 3 }));

  let prompt: string | null = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id === auditor.agent_id && prompt === null) {
      prompt = required(firstOf(required(required(turn.prompt, 'prompt').content, 'prompt content'), 'prompt content item').text, 'prompt text');
    }
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 6 && prompt === null; pass += 1) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.ok(prompt, 'the pending audits activated the resumed Auditor');
  const resumedPrompt = textOf(prompt, 'resumed prompt');
  const json = resumedPrompt.split('Current domain state (read anything else with flow_query; every list answers with items/total/next_offset):\n')[1]
    ?.split('\n\nPerform the pending actions')[0];
  const digest = jsonObject(JSON.parse(required(json, 'digest json')), 'digest');
  const pendingActions: readonly unknown[] = Array.isArray(digest.pending_actions) ? digest.pending_actions : [];
  const planActions = pendingActions
    .map(entry => jsonObject(entry, 'pending action'))
    .filter(action => action.action === 'inspect_plan');
  assert.deepEqual(planActions.map(action => action.transaction_id).sort(), transactions.map(tx => tx.id).sort(),
  'all three review decisions and their transaction references remain actionable');
  for (const action of planActions) {
    const transaction = required(transactions.find(tx => tx.id === textOf(action.transaction_id, 'transaction_id')), 'transaction');
    assert.deepEqual(action.acceptance_criteria, transaction.acceptance_criteria,
      `the Auditor decision for ${transaction.id} still carries the criteria it must judge`);
  }
  assert.ok(resumedPrompt.length < 4_000, `a resumed session has room for this prompt inside its 8192-token context: ${resumedPrompt.length}`);
});

test('restore refuses a checkpoint the session is not at, and fences the instance it replaces', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
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
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    context: { role: 8192, worker: 16384, compaction_threshold: 0.8, model: 131072, server_input: 142074 },
  });
  t.after(async () => {
    finishTurn.resolve();
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'one refused tool call', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 3 },
    budget: { tokens: 500_000, model_requests: 20, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
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


test('an unfunded compaction that leaves the request unsendable is a budget stop end to end', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-unfunded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The session is over the provider ceiling, compaction is attempted, and the
  // compaction request itself cannot be funded. The provider-ceiling path must
  // report this as a budget stop.
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: 131_000, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded() { throw new Error('compaction budget exhausted for tokens: requested 97020, available 64000'); },
    },
  });
  const runtime = await startFlowPlugin(host, {
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
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: tx.id });
  if (required(runtime.store.getTransaction(tx.id), 'transaction').status === 'DRAFT') {
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
    if (['BLOCKED', 'FAILED', 'SUBMITTED'].includes(required(runtime.store.getTransaction(tx.id), 'transaction').status) || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }

  const blocked = runtime.store.get(
    "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", clusterId,
  );
  const stop = blocked ? jsonObject(JSON.parse(textOf(blocked.data, 'blocked data')), 'cluster-blocked') : null;
  assert.equal(stop?.code, 'BUDGET_EXHAUSTED', 'the stop is coded as a budget stop from the producer');
  assert.match(String(stop?.reason), /^BUDGET:/);
  // The worker path never reached a withheld result here (the step was refused),
  // but the refusal's code is what any withheld record would carry.
  const step = runtime.store.get(
    "SELECT data FROM events WHERE cluster_id=? AND type='context-step' ORDER BY seq DESC LIMIT 1", clusterId,
  );
  assert.equal(step ? jsonObject(JSON.parse(textOf(step.data, 'step data')), 'context-step').decision : null, 'reject', 'the step gate refused it');
});

test('a critical notification alone wakes its role and is consumed exactly once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-critical-'));
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
    objective: 'an idle role with one critical message', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
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

test('a plan change waits for its new audit rather than waking idle governance turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-plan-notice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
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
  assert.equal(firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor').turns, 0,
    'a DRAFT edit has no audit yet; its notification must not burn a model turn');
  assert.equal(runtime.store.listInbox(clusterId, { recipient: auditor.agent_id, status: 'PENDING' })
    .some(row => row.subject === 'transaction-modified'), true, 'the notice remains durable');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const deadline = Date.now() + 3_000;
  while (firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor').turns === 0 && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.ok(firstOf(runtime.store.listAgents(clusterId, { role: 'auditor' }), 'auditor').turns > 0, 'the new plan audit wakes governance');
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
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');

  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { claim: 'done' } }));
  command(runtime, orchestrator, 'validate', { transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y' }] });

  // The Auditor demands a re-validation of the current result revision.
  const requested = command(runtime, auditor, 'request_revalidation', {
    transaction_id: tx.id, required_change: 're-run validation against the current result revision',
  });
  const issueId = textOf(requested.result.issue_id, 'issue_id');
  const issue = required(runtime.store.getIssue(issueId), 'issue');
  assert.equal(issue.status, 'OPEN');
  const target = Number(issue.target_revision);
  // Nothing to verify yet.
  const noProgress = runtime.issueProgressed(clusterId, issue);
  assert.equal(noProgress.progressed, false);
  assert.throws(() => command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'VERIFIED', evidence: {} }), /correction to verify/);

  // The Orchestrator does exactly what was asked — re-validate, no plan edit.
  command(runtime, orchestrator, 'validate', {
    transaction_id: tx.id, accepted: true, checks: [{ criterion: 'x', passed: true, evidence: 'y', revalidated: true }],
  });
  const progress = runtime.issueProgressed(clusterId, required(runtime.store.getIssue(issueId), 'issue'));
  assert.equal(progress.progressed, true, `a re-validation is durable progress: ${JSON.stringify(progress)}`);
  assert.equal(progress.how, 'revalidated');
  assert.ok(Number(required(runtime.store.getTransaction(tx.id), 'transaction').result_revision) > target, 'and it is past the issue\'s revision');

  // So the verdict is accepted and closes the round.
  const verified = command(runtime, auditor, 'verify_correction', { issue_id: issueId, decision: 'VERIFIED', evidence: { revalidated: true } });
  assert.equal(verified.result.status, 'CORRECTED');
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').status, 'CORRECTED');
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').corrections, 0, 'a first-try correction leaves the counter alone');
});

test('a runtime stopped mid-request leaves no reserved receipt, no lease and no running identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
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
  const root = rootNode(runtime, clusterId);
  const scalar = (sql: string, ...args: (string | number | null)[]): number =>
    Number(required(runtime.store.get(sql, ...args), 'scalar row').c);
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').id });

  // The turn blocks inside its own request, so it is live and holds a reservation
  // and a lease when the runtime is torn down under it.
  let release: () => void = () => {};
  host.setScript(async turn => {
    await turn.request({ purpose: 'role' });
    await new Promise<void>(resolvePromise => { release = () => resolvePromise(undefined); });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 20; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    if (scalar('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId) > 0
      && scalar('SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=?', clusterId) > 0) break;
  }
  assert.ok(scalar('SELECT COUNT(*) AS c FROM leases WHERE cluster_id=?', clusterId) > 0, 'a turn really is live');

  // A request that was reserved and whose turn never settled it — the state a
  // crash leaves behind.
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const reserved = reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: runtime.budgetChainForAgent(orchestrator, { tokens: 1_000, requests: 1 }), reservationTokens: 1_000, turn_seq: 1,
  });
  const heldBefore = scalar('SELECT SUM(tokens_reserved) AS c FROM budgets');
  const spentBefore = scalar('SELECT SUM(requests_spent) AS c FROM budgets');
  assert.ok(heldBefore > 0, `the reservation is held: ${heldBefore}`);

  // The teardown is awaited: it drains the finishers of the turns it aborted, and
  // those finishers need the store.
  const disposing = runtime.dispose();
  release();
  await disposing;

  const dbPath = join(dir, 'cluster.sqlite');
  assert.ok(existsSync(dbPath));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (sql: string): number => Number(required(db.prepare(sql).get(), 'count row').c);
  assert.equal(count('SELECT COUNT(*) AS c FROM leases'), 0, 'no lease survives the teardown');
  assert.equal(count("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='RESERVED'"), 0, 'and no request is left reserved');
  // The unknown-cost send is not handed back: its token hold survives the restart.
  const held = Number(required(db.prepare('SELECT SUM(tokens_reserved) AS c FROM budgets').get(), 'held row').c ?? 0);
  assert.ok(held >= heldBefore, `no held token was refunded (before ${heldBefore}, after ${held})`);
  // …and the *attempt* is consumed rather than relabelled: a reconciled request
  // moves from reserved to spent, so a restart cannot re-spend it.
  const spentAfter = Number(required(db.prepare('SELECT SUM(requests_spent) AS c FROM budgets').get(), 'spent row').c ?? 0);
  assert.ok(spentAfter > spentBefore, `the in-flight attempt is spent, not merely relabelled (${spentBefore} → ${spentAfter})`);
  assert.equal(Number(required(db.prepare('SELECT total_tokens AS c FROM usage_receipts WHERE request_id=?').get(reserved.request_id), 'usage row').c ?? 0), 0,
    'and nothing was charged for it');
  const unknown = Number(required(db.prepare("SELECT COUNT(*) AS c FROM usage_receipts WHERE status='UNKNOWN' AND note LIKE '%runtime stopped%'").get(), 'unknown row').c);
  assert.equal(unknown, 1, 'the in-flight request is recorded as unknown, with its reason');
  db.close();
});

test('recovery keeps the holds of unknown and in-flight requests, and cannot refund them', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator', limit: 5 }), 'orchestrator');
  const agentBudget = required(runtime.store.budgetForScope(clusterId, 'agent', orchestrator.id), 'agent budget');
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const nodeBefore = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget')), 'node budget view');
  // Charge both requests to the identity scope so recovery must preserve its
  // exact outstanding reservations independently of the node scope.
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
  const held = required(runtime.store.getBudget(agentBudget.id), 'agent budget').tokens_reserved;
  assert.equal(held, 6_000, `both holds are on the identity's own scope: ${held}`);

  // A fenced identity that is eligible for grant reclamation, so the reclamation
  // path runs over the same scope the holds live in.
  runtime.store.tx(() => {
    runtime.store.createLease({
      id: 'lease-old', cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id,
      epoch: 1, purpose: 'role-turn', expires: runtime.timestamp() - 1_000,
    });
  });

  runtime.recover({ deferScheduling: true });

  const after = required(runtime.store.getBudget(agentBudget.id), 'agent budget after');
  assert.equal(after.tokens_reserved, held, `recovery keeps the holds exactly: ${after.tokens_reserved} vs ${held}`);
  assert.equal(after.requests_reserved, 1, 'the in-flight request still holds its attempt');
  assert.equal(after.agents_reserved, 0, 'while identity capacity is released');
  assert.equal(after.max_active_reserved, 0, 'and so is the active window');
  const nodeAfter = required(budgetView(required(runtime.store.getBudget(nodeBudget.id), 'node budget')), 'node budget after view');
  assert.equal(nodeAfter.tokens.limit, nodeBefore.tokens.limit, 'the node is refunded nothing it had not funded');
  assert.equal(runtime.store.getLease('lease-old'), null, 'and the stale lease is fenced');

  // The held capacity cannot be re-spent: the free remainder is exactly what is
  // left after the holds, and a request beyond it is refused.
  const free = dimensionAvailable(required(runtime.store.getBudget(agentBudget.id), 'agent budget'), 'tokens');
  assert.throws(() => reserveLlmRequest(runtime.store, {
    cluster_id: clusterId, agent_id: orchestrator.id, node_id: orchestrator.node_id, transaction_id: null,
    role: 'orchestrator', kind: 'role', model: 'm', provider: 'p',
    budgetIds: [agentBudget.id], reservationTokens: free + 1_000, turn_seq: 3,
  }), /exhausted/);
  assert.equal(required(runtime.store.getBudget(agentBudget.id), 'agent budget').tokens_reserved, held, 'and the failed attempt moved nothing');
});
test('a turn that never admitted its prompt hands the critical message back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inbox-atomic-'));
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
    objective: 'a turn that fails before admitting', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 8 },
    budget: { tokens: 1_000_000, model_requests: 40, tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
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
    budget: { tokens: 1_000_000, model_requests: 100, tool_calls: 20, wall_time_ms: 3_600_000, agents: 16, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const owner = firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 5 }), 'auditor');
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
