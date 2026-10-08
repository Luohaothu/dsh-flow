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
import type { StreamEventRow } from '../../packages/dsh-flow/src/core/store.ts';

import { budgetView, settleChain, DIMENSIONS } from '../../packages/dsh-flow/src/core/budget.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import type { AgentRecord, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord, TransactionRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

// ---------------------------------------------------------------- test harness

let clock = 1_800_000_000_000;
const now = (): number => clock;

/** The fake host this suite drives the plugin with. */
import type { FakeHost } from './fake-host.ts';

/** One of the fake host's turns. */
import type { FakeTurn } from './fake-host.ts';

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

/** What {@link driveWorkerOnce} hands back to its callers. */
interface DrivenWorker {
  readonly runtime: ClusterRuntime
  readonly host: FakeHost
  readonly clusterId: string
  readonly tx: TransactionRecord
  readonly workerTurn: FakeTurn | undefined
  readonly workerAgent: AgentRecord
  readonly eventsOf: (type: string) => StreamEventRow[]
}

/** The knobs one driven worker turn accepts. */
interface DriveWorkerOptions {
  readonly cancelledFirstRequest?: boolean
  readonly firstRequestFails?: 'unaccounted' | 'reported' | null
  readonly result?: unknown
  readonly onAuditor?: ((turn: FakeTurn, context: { runtime: ClusterRuntime; clusterId: string; tx: TransactionRecord }) => void) | null
  readonly approvePlan?: boolean
}

/**
 * Drive one Worker transaction through the real plugin wiring with a scripted
 * host, and return everything a caller needs to assert on the settled turn.
 */
async function driveWorkerOnce(t: TestContext, {
  cancelledFirstRequest = false,
  firstRequestFails = null,
  result = { file: 'stub.txt', symbol: 'stub', line: 1 },
  onAuditor = null,
  approvePlan = false,
}: DriveWorkerOptions = {}): Promise<DrivenWorker> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  // The capability package is not really mounted in a fake host, so the read the
  // Worker calls is stubbed; everything around it — admission, reservation,
  // refusal, settlement — is the production path.
  host.registerTool({
    name: 'read',
    description: 'read one owned file',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return { content: [{ type: 'text', text: 'stub file body' }], isError: false, value: { body: 'stub file body' } }; },
  });
  // `fs_read` maps to `read`, `glob` and `grep`; a cluster turn is refused
  // before its prompt unless every one of them resolves. The scripted Worker
  // only ever calls `read`, so the rest are declared inert — and loud, so a
  // call they did not script cannot pass unnoticed.
  for (const name of ['glob', 'grep']) {
    host.registerTool({
      name, description: 'filesystem admission fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute() { assert.fail(`${name} is not scripted in this fixture`); },
    });
  }
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one worker transaction', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_attempts: 1, max_corrections: 1, max_role_turns: 2,},
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'worker transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  // Whether the plan gate is still the path to READY or the Orchestrator
  // dispatches directly, the fixture ends up approved either way.
  if (approvePlan || required(runtime.store.getTransaction(tx.id), 'worker transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });

  host.setScript(async turn => {
    const role = runtime.store.getAgentBySession(turn.session.id)?.role;
    if (role === 'auditor') return onAuditor?.(turn, { runtime, clusterId, tx });
    if (role !== 'worker') return;
    const usage = { totalTokens: 100, inputTokens: 80, outputTokens: 20 };
    if (cancelledFirstRequest) await turn.request({ purpose: 'worker', dispatchFails: true });
    if (firstRequestFails) {
      // The exact shape the harness produces for a transport failure: a usage
      // chunk built from pi-ai's zeroed message, then an error finish. The
      // `reported` variant is the provider that *did* report what it consumed
      // before failing.
      const failureUsage = firstRequestFails === 'reported'
        ? { totalTokens: 120, inputTokens: 100, outputTokens: 20 }
        : { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
      await turn.request({
        purpose: 'worker',
        chunks: [
          { type: 'text', text: 'partial answer' },
          { type: 'usage', usage: failureUsage },
          { type: 'finish', reason: { kind: 'error', failure: { message: 'declared server failure', code: 'SERVER' } } },
        ],
      });
    }
    await turn.request({ purpose: 'worker', usage });
    await turn.callTool('read', { file_path: 'stub.txt' });
    await turn.request({ purpose: 'worker', usage });
    await turn.callTool('flow_transaction', {
      action: 'submit_result',
      params: { transaction_id: tx.id, result },
    });
  });

  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    const status = required(runtime.store.getTransaction(tx.id), 'worker transaction').status;
    if (status === 'SUBMITTED' || status === 'FAILED' || Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const workerTurn = host.turns.find(turn => (turn.prompt?.content?.[0]?.text ?? '').startsWith('You are a Worker'));
  const workerAgent = firstOf(runtime.store.listAgents(clusterId, { role: 'worker' }), 'worker agent');
  const eventsOf = (type: string): StreamEventRow[] => runtime.store.readEvents(clusterId, { limit: 500 }).filter(event => event.type === type);
  return { runtime, host, clusterId, tx, workerTurn, workerAgent, eventsOf };
}

// ==== CHUNK START ====
test('pause stops dispatching and resume returns the cluster to a schedulable state', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').id, decision: 'approve' });

  const paused = runtime.control(clusterId, 'pause');
  assert.equal(paused.cluster.status, 'PAUSED');
  assert.equal(firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').status, 'PAUSED');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'PAUSED');

  const resumed = runtime.control(clusterId, 'resume');
  assert.equal(resumed.cluster.status, 'RUNNING');
  assert.equal(required(runtime.store.getNode(root.id), 'root node').status, 'ACTIVE');
  assert.equal(firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').status, 'READY');
});

test('releasing an identity returns its slot and never shrinks the node capacity', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_children: 16, max_depth: 3, max_active_agents: 4, max_llm_concurrency: 2, max_corrections: 2, max_role_turns: 6 },
    budget: { tool_calls: 500, wall_time_ms: 3_600_000, agents: 4, max_active_agents: 4 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const nodeBudget = required(runtime.store.budgetForScope(clusterId, 'node', root.id), 'node budget');
  const baseline = { ...required(runtime.store.getBudget(nodeBudget.id), 'node budget') };
  assert.equal(baseline.agents_limit, 4, 'the node holds the cluster\'s four agent slots');
  assert.equal(baseline.max_active_limit, 4);

  // Eight waves against a four-slot node: one identity at a time, each freed
  // before the next is created. A leak of one slot per wave would stop the
  // ladder at wave five, and a leaked *limit* would shrink the node invisibly.
  for (let wave = 0; wave < 8; wave += 1) {
    const tx = command(runtime, orchestrator, 'create_transaction', {
      objective: `wave ${wave}`, acceptance_criteria: ['done'],
    }).result.transaction_id;
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx });
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx, decision: 'approve' });
    const allocations = command(runtime, allocator, 'allocate_agent', { transaction_id: tx }).result.allocations;
    assert.ok(Array.isArray(allocations), 'allocate_agent returns the granted allocations');
    const allocated = jsonObject(firstOf(allocations, 'allocation'), 'allocation');
    const agentScope = required(runtime.store.budgetForScope(clusterId, 'agent', textOf(allocated.agent_id, 'agent_id')), 'agent budget');
    assert.ok(agentScope, 'a worker identity always has its own grant');
    assert.equal(required(budgetView(agentScope), 'budget view').max_active_agents.spent, 0, 'an identity never *consumes* an active slot');
    assert.equal(required(budgetView(agentScope), 'budget view').max_active_agents.limit, 0, 'a worker adds no per-agent active window of its own');

    // One settled turn's worth of accounting on the identity scope. `agents` and
    // `max_active_agents` are capacity: settlement must write nothing at all.
    const revision = required(runtime.store.getBudget(agentScope.id), 'agent budget').revision;
    runtime.store.tx(() => settleChain(runtime.store, [agentScope.id], { consumed: { agents: 1, max_active_agents: 1 } }));
    assert.equal(required(runtime.store.getBudget(agentScope.id), 'agent budget').revision, revision,
      'the capacity dimensions have no spent column, so settlement produces no UPDATE');

    command(runtime, allocator, 'release_agent', { allocation_id: textOf(allocated.allocation_id, 'allocation_id') });
    const row = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
    assert.equal(row.agents_reserved, baseline.agents_reserved, `wave ${wave}: the agent slot came back`);
    assert.equal(row.max_active_limit, baseline.max_active_limit, `wave ${wave}: the node's active window is unchanged`);
  }

  const after = required(runtime.store.getBudget(nodeBudget.id), 'node budget');
  assert.equal(after.agents_limit, baseline.agents_limit, 'the node capacity is never transferred away');
  assert.equal(after.agents_reserved, baseline.agents_reserved);
  assert.equal(after.max_active_limit, baseline.max_active_limit);
  assert.equal(after.max_active_reserved, baseline.max_active_reserved);
  // The declaration itself: a dimension with a `spent` column that the schema
  // does not have silently discards every write to it.
  assert.equal(required(DIMENSIONS.find(dim => dim.key === 'agents'), 'agents dimension').spent, null);
  assert.equal(required(DIMENSIONS.find(dim => dim.key === 'max_active_agents'), 'max_active_agents dimension').spent, null);
});
test('a management action yields its model turn so delegated work can be scheduled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-control-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'dispatch the local work', workspace: dir, capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 4 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  host.setScript(async turn => {
    if (!(turn.prompt?.content?.[0]?.text ?? '').includes('Role: orchestrator.')) return;
    await turn.request({ purpose: 'role' });
    await turn.callTool('flow_query', { what: 'transaction', params: { id: tx.id } });
    if (!turn.concluded) {
      await turn.callTool('flow_transaction', { action: 'dispatch', params: { transaction_id: tx.id } });
    }
    // A non-yielding role keeps querying until the model chooses to stop;
    // that holds a management slot while child roles wait to start.
    if (!turn.concluded) await turn.request({ purpose: 'role' });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (required(runtime.store.getTransaction(tx.id), 'transaction').status !== 'READY' && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const turn = host.turns.find(entry => (entry.prompt?.content?.[0]?.text ?? '').includes('Role: orchestrator.'));
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'READY');
  assert.equal(turn?.concluded, true, 'successful control mutation yields the native turn');
  assert.equal(turn.requests.length, 1, 'no second provider request polls the changed state');
});

test('a worker submits on its second request, and the turn ends completed', async t => {
  const { runtime, clusterId, tx, workerTurn, workerAgent, eventsOf } = await driveWorkerOnce(t);
  assert.ok(workerTurn, 'the worker turn ran');
  assert.equal(workerTurn.requests.length, 2, 'exactly two provider requests: work, then submit');
  assert.deepEqual(workerTurn.toolCalls, ['read', 'flow_transaction']);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'SUBMITTED', 'a completed turn publishes the staged result');

  const turnEnd = required(eventsOf('turn-end').filter(event => jsonObject(event.data, 'event.data').role === 'worker').pop(), 'worker turn-end');
  const turnEndData = jsonObject(turnEnd.data, 'turn-end data');
  assert.equal(turnEndData.stop_reason, 'completed', 'the turn ends because the tool call concluded it');
  assert.equal(jsonObject(turnEndData.stop_detail, 'stop_detail').kind, 'completed');
  const toolsUsed = turnEndData.tools_used;
  assert.equal(Array.isArray(toolsUsed) && toolsUsed.includes('read'), true, 'the read really ran through the tool pipeline');
  assert.equal(eventsOf('result-withheld').length, 0, 'no result is withheld');
  assert.equal(eventsOf('result-submitted').length, 1);
  assert.equal(runtime.store.usageSummary(clusterId, {agentId: workerAgent.id}).requests, 2);
});

test('a blocked Worker submission durably records the unsatisfied result for independent review', async t => {
  const { runtime, tx, eventsOf } = await driveWorkerOnce(t, {
    result: { completed: false, status: 'blocked', reason: 'the allocated write scope excludes the required output' },
  });
  assert.equal(required(runtime.store.getTransaction(tx.id), 'transaction').status, 'SUBMITTED');
  const submitted = firstOf(eventsOf('result-submitted'), 'result-submitted');
  assert.ok(submitted, 'the native Worker turn published a result');
  const submittedData = jsonObject(submitted.data, 'event.data');
  assert.equal(submittedData.result_completed, false);
  assert.equal(submittedData.result_status, 'blocked');
  assert.equal(submittedData.revision, required(runtime.store.getTransaction(tx.id), 'transaction').revision);
});

test('a later-revision issue consumes the earlier incomplete Worker event without hiding a new incomplete result', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const blockedRevision = tx.revision;
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    node_id: root.id, transaction_id: tx.id, revision: blockedRevision,
    result_completed: false, result_status: 'blocked',
  }));
  const pending = () => runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id))
    .filter(item => item.action === 'request_correction' && item.transaction_id === tx.id);
  assert.equal(pending().length, 1, 'the actual blocked result first reaches independent review');
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, inputs: { write_scope: ['output'] } });
  const correctedRevision = required(runtime.store.getTransaction(tx.id), 'transaction').revision;
  assert.ok(correctedRevision > blockedRevision);
  const issueId = textOf(command(runtime, auditor, 'request_correction', {
    transaction_id: tx.id, required_change: 'replace the Worker grant and write output',
  }).result.issue_id, 'issue_id');
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').target_revision, correctedRevision);
  assert.equal(pending().length, 0,
    'an issue opened after the blocked event is already its review even if its target_revision advanced');
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    node_id: root.id, transaction_id: tx.id, revision: correctedRevision,
    result_completed: false, result_status: 'blocked',
  }));
  assert.equal(pending().length, 1, 'a distinct later Worker attempt still needs its own review');
});

test('an Auditor cannot dismiss a recorded blocked Worker result as an imaginary defect', async t => {
  const { runtime, clusterId, tx, eventsOf } = await driveWorkerOnce(t, {
    result: { completed: false, outcome: 'blocked', reason: 'the current write scope excludes the required output' },
  });
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const issueId = textOf(command(runtime, auditor, 'request_correction', {
    transaction_id: tx.id, required_change: 'grant a write scope that covers the required output',
  }).result.issue_id, 'issue_id');
  assert.equal(jsonObject(required(eventsOf('result-submitted').at(-1), 'result-submitted').data, 'event.data').result_completed, false);
  assert.equal(eventsOf('write-refused').length, 0, 'the refusal is the Worker result, not a guard event');
  const pendingVerdicts = () => runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'),
    runtime.store.getAgent(auditor.agent_id))
    .filter(action => action.action === 'review_issue' && jsonObject(action, 'pending action').issue_id === issueId);
  assert.equal(pendingVerdicts().length, 0, 'a real incomplete result needs a correction before a verdict');
  const dismiss = () => command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'dismissed',
    evidence: { rechecked: 'the blocked result', found: 'the Worker still could not produce the required output' },
  });
  assert.throws(dismiss, error => rejectionStatus(error) === 409 && /blocked|incomplete/i.test(messageOf(error)));
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['output'] },
  });
  assert.equal(pendingVerdicts().length, 0, 'a plan edit alone has not replaced the Worker grant that blocked');
  assert.throws(() => command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'verified', evidence: { checked: 'the transaction inputs changed' },
  }), error => rejectionStatus(error) === 409 && /allocat|worker|result/i.test(messageOf(error)),
  'the old allocation still cannot execute the revised plan');
  assert.throws(dismiss, error => rejectionStatus(error) === 409 && /blocked|incomplete/i.test(messageOf(error)),
    'a later plan change does not retroactively make the original blocked result false');
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const old = required(runtime.store.activeAllocationForTransaction(tx.id), 'active allocation');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, allocator, 'release_agent', { allocation_id: old.id });
  const allocationsAfter = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations;
  assert.ok(Array.isArray(allocationsAfter), 'allocate_agent returns the granted allocations');
  const granted = jsonObject(firstOf(allocationsAfter, 'allocation'), 'allocation');
  assert.deepEqual(required(runtime.store.getAllocation(textOf(granted.allocation_id, 'allocation_id')), 'allocation').write_scope, ['output']);
  assert.equal(jsonObject(required(pendingVerdicts()[0], 'pending verdict'), 'pending verdict').changed_since_issue, true,
    'the fresh grant makes review possible but does not pre-approve the correction');
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').status, 'OPEN', 'the Auditor still owns the independent verdict');
});

test('an incomplete Worker outcome wakes the Auditor even without a completed flag', async t => {
  for (const result of [
    { outcome: 'blocked', reason: 'the allocated write scope excludes the required output' },
    { status: 'blocked_by_topology', reason: 'the Worker cannot create a management child' },
  ]) {
    await t.test(result.outcome ?? result.status, async child => {
      let offered = false;
      const { runtime, clusterId, tx, eventsOf } = await driveWorkerOnce(child, {
        result, approvePlan: true,
        onAuditor: async (turn, state) => {
          const prompt = turn.prompt?.content?.[0]?.text ?? '';
          if (!prompt.includes('Worker submitted a result explicitly marked incomplete')) return;
          offered = true;
          const submittedRow = required(state.runtime.store.get(
            `SELECT data FROM events WHERE cluster_id=? AND type='result-submitted'
              AND json_extract(data,'$.transaction_id')=? ORDER BY seq DESC LIMIT 1`,
            state.clusterId, state.tx.id), 'submitted event row');
          await turn.request({ purpose: 'role' });
          await turn.callTool('flow_audit', {
            action: 'request_correction',
            params: { transaction_id: state.tx.id, target_revision: jsonObject(JSON.parse(textOf(submittedRow.data, 'event data')), 'result-submitted').revision,
              required_change: 'allocate a Worker able to satisfy the original output' },
          });
        },
      });
      const submitted = firstOf(eventsOf('result-submitted'), 'result-submitted');
      const submittedData = jsonObject(submitted.data, 'event.data');
      assert.equal(submittedData.result_completed, false);
      assert.equal(submittedData.result_status, result.outcome ?? result.status);
      const deadline = Date.now() + 5_000;
      while (runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length === 0 && Date.now() < deadline) {
        await runtime.tick();
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      }
      assert.equal(offered, true, `the Auditor was shown the incomplete Worker result: ${JSON.stringify({
        turnActions: eventsOf('turn-actions').filter(event => jsonObject(event.data, 'event.data').role === 'auditor').map(event => ({ seq: event.seq, actions: jsonObject(event.data, 'event.data').actions })),
        turnEnds: eventsOf('turn-end').filter(event => jsonObject(event.data, 'event.data').role === 'auditor').map(event => ({ seq: event.seq, reason: jsonObject(event.data, 'event.data').stop_reason })),
        tx: required(runtime.store.getTransaction(tx.id), 'transaction').status,
      })}`);
      assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length, 1);
    });
  }
});

test('a transport failure still notifies the Allocator when no request was refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-provider-anomaly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'dispatch one plan', workspace: dir, capabilities: [],
    limits: { max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 2 },
    budget: { tool_calls: 20,
      wall_time_ms: 600_000, agents: 8, max_active_agents: 1 },
  }).cluster.id;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'orchestrator') return;
    await turn.request({ purpose: 'role' });
    throw Object.assign(new Error('provider route unavailable'), { code: 'TRANSPORT' });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (!runtime.store.readEvents(clusterId, { limit: 500 }).some(event => event.type === 'turn-end') && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const events = runtime.store.readEvents(clusterId, { limit: 500 });
  assert.equal(events.filter(event => event.type === 'budget-refused').length, 0);
  assert.equal(jsonObject(required(events.find(event => event.type === 'agent-anomaly'), 'agent-anomaly').data, 'agent-anomaly data').code, 'TRANSPORT');
});

test('an Auditor can correct a blocked result after the Orchestrator has already revised its plan', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-blocked-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'review a blocked submission', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2, max_role_turns: 6 },
    budget: { tool_calls: 40, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  const blockedRevision = required(runtime.store.getTransaction(tx.id), 'transaction').revision;
  runtime.store.tx(() => {
    runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { completed: false, status: 'blocked' }, __bump_revision: false });
    runtime.store.appendEvent(clusterId, 'result-submitted', {
      node_id: root.id, transaction_id: tx.id, revision: blockedRevision,
      result_completed: false, result_status: 'blocked',
    });
  });
  command(runtime, orchestrator, 'adjust_transaction', { transaction_id: tx.id, objective: 'fund a writable allocation' });
  assert.ok(required(runtime.store.getTransaction(tx.id), 'transaction').revision > blockedRevision);
  let offered = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    if (!runtime.pendingFor('auditor', root, required(runtime.store.getCluster(clusterId), 'cluster'), runtime.store.getAgent(auditor.agent_id))
      .some(action => action.transaction_id === tx.id && action.target_revision === blockedRevision)) return;
    offered = true;
    await turn.request({ purpose: 'role' });
    await turn.callTool('flow_audit', {
      action: 'request_correction', params: {
        transaction_id: tx.id, target_revision: blockedRevision,
        required_change: 'fund an allocation whose write scope covers the required output',
      },
    });
  });
  runtime.enableScheduling();
  const deadline = Date.now() + 5_000;
  while (runtime.store.openIssues(clusterId, { transaction_id: tx.id }).length === 0 && Date.now() < deadline) {
    await runtime.tick();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  const issue = runtime.store.openIssues(clusterId, { transaction_id: tx.id })[0];
  assert.equal(offered, true, 'the Auditor received the original blocked revision as actionable work');
  assert.ok(issue, 'the Auditor opened a durable correction issue');
  assert.equal(issue.reporter_agent_id, auditor.agent_id);
  assert.equal(issue.target_revision, blockedRevision, 'the plan revision did not erase the original defect');
});

test('one scheduling pass fills the active window exactly, never one slot short', async t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    limits: { max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 8, max_children: 16 },
    budget: { tool_calls: 200, wall_time_ms: 3_600_000, agents: 32, max_active_agents: 2 },
  });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);

  // Two role turns are eligible at the same moment: the Orchestrator has a
  // DRAFT plan to dispatch, the Auditor has a pending plan decision. Admission
  // must count each active turn once and fill both available slots.
  command(runtime, orchestrator, 'dispatch', { transaction_id: firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction').id });
  assert.ok(runtime.store.pendingAudits(clusterId, { limit: 10 }).length >= 1);

  runtime.enableScheduling();
  const releaseSlot = await runtime.acquireLlmSlot(clusterId);
  await runtime.tick();
  assert.equal(runtime.activeTurnIds().length, 2, 'the pass used both slots');
  assert.equal(runtime.llmWaiters(), 2, 'both turns are waiting on the model window');
  releaseSlot();
});

test('every eligible identity is claimed, not just the first page of transactions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-page-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t);
  const planned = Array.from({ length: 201 }, (_, index) => ({
    id: `page-${String(index).padStart(3, '0')}`,
    objective: `task ${index}`,
    acceptance_criteria: ['done'],
  }));
  const clusterId = runtime.start({
    objective: 'a long queue', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 2, max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tool_calls: 400, wall_time_ms: 600_000, agents: 256, max_active_agents: 4 },
    initial_transactions: planned,
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);

  // Every transaction is READY; only the last one is allocated. A scheduler
  // that pages 200 READY rows and stops has never seen it.
  runtime.store.tx(() => {
    runtime.store.run("UPDATE transactions SET status='READY' WHERE cluster_id=?", clusterId);
  });
  const last = required(runtime.store.getTransaction('page-200'), 'page-200');
  const agent = required(runtime.store.insertAgent({
    id: 'page-worker', cluster_id: clusterId, node_id: root.id, role: 'worker',
    session_id: 'page-worker-session', status: 'READY', capabilities: [],
  }), 'page worker');
  runtime.store.insertAllocation({
    id: 'page-allocation', cluster_id: clusterId, node_id: root.id, agent_id: agent.id,
    transaction_id: last.id, capabilities: [], write_scope: [], write_scope_canonical: [], status: 'ACTIVE',
  });
  const claimable = runtime.store.readyForWorker(clusterId, { limit: 100 });
  assert.equal(claimable.length, 1, 'the eligible set is defined by SQL, not by a page of READY rows');
  const claimableFirst = firstOf(claimable, 'claimable transaction');
  assert.equal(claimableFirst.id, last.id);
  assert.equal(runtime.store.readyForWorker(clusterId, { after: { priority: claimableFirst.priority, created: claimableFirst.created, id: claimableFirst.id } }).length, 0);
  void allocator;
});

test('a large cluster is counted and drained exhaustively, never by page', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-large-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = makeRuntime(t);
  const planned = Array.from({ length: 1024 }, (_, index) => ({
    id: `large-${String(index).padStart(4, '0')}`,
    objective: `task ${index}`,
    acceptance_criteria: ['done'],
  }));
  const clusterId = runtime.start({
    objective: 'a large cluster', workspace: dir, capabilities: [],
    limits: { max_children: 4096, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 1, max_role_turns: 4 },
    budget: { tool_calls: 4096, wall_time_ms: 600_000, agents: 4096, max_active_agents: 4 },
    initial_transactions: planned,
  }).cluster.id;
  const root = firstOf(runtime.store.listNodes(clusterId, { parent_id: null }), 'root node');
  // 512 nodes: the root's 511 children, every fourth one a management node.
  runtime.store.tx(() => {
    for (let index = 0; index < 511; index += 1) {
      runtime.store.insertNode({
        id: `large-node-${String(index).padStart(3, '0')}`, cluster_id: clusterId, parent_id: root.id,
        kind: index % 4 === 0 ? 'management' : 'worker', depth: 1, status: 'ACTIVE',
        scope: {}, capabilities: [], path: `0.${index}`, max_children: 0,
      });
    }
  });
  const sqlStatus = () => Object.fromEntries(
    runtime.store.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId)
      .map(row => [row.status, Number(row.c)]),
  );
  const sqlTotal = () => Number(required(runtime.store.get('SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=?', clusterId), 'count row').c);

  // Spread the statuses across a realistic mix, all of it beyond any page.
  runtime.store.tx(() => {
    const statuses = ['READY', 'DRAFT', 'RUNNING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'BLOCKED'];
    for (let index = 0; index < 1024; index += 1) {
      runtime.store.run('UPDATE transactions SET status=? WHERE id=?', required(statuses[index % statuses.length], 'status'), required(planned[index], 'planned transaction').id);
    }
  });
  assert.equal(sqlTotal(), 1024);
  assert.equal(runtime.store.countNodes(clusterId), 512);

  const report = runtime.report(clusterId);
  assert.deepEqual(report.mechanism.transactions_by_status, sqlStatus(),
    'the report counts every transaction, not the first page');
  assert.equal(report.mechanism.transactions_total, 1024);
  assert.equal(report.mechanism.nodes, 512);
  assert.equal(report.transactions.truncated, true, 'the detail list says it is a page');
  assert.equal(report.transactions.total, 1024);

  const summary = runtime.buildSummary(clusterId);
  assert.equal(required(summary.transactions, 'summary transactions').total, 1024);
  assert.equal(required(summary.transactions, 'summary transactions').completed, sqlStatus().ACCEPTED);
  assert.equal(summary.confidence, 'partial', 'confidence is derived from exhaustive coverage');

  // Pause and resume classify the whole cluster in SQL.
  const before = sqlStatus();
  runtime.control(clusterId, 'pause');
  const paused = sqlStatus();
  const openBefore = (before.READY ?? 0) + (before.DRAFT ?? 0) + (before.RUNNING ?? 0) + (before.DISPATCHED ?? 0);
  assert.equal(paused.PAUSED, openBefore, `every open transaction paused: ${JSON.stringify(paused)}`);
  assert.equal(paused.ACCEPTED, before.ACCEPTED, 'a decided transaction is not reopened by pause');
  assert.equal(paused.BLOCKED, before.BLOCKED);
  runtime.control(clusterId, 'resume');
  const resumed = sqlStatus();
  assert.equal(resumed.PAUSED, undefined, 'nothing stays paused after resume');
  assert.equal(resumed.READY, (before.READY ?? 0) + (before.DISPATCHED ?? 0) + (before.RUNNING ?? 0),
    'a transaction that was schedulable goes back to being schedulable');
  assert.equal(resumed.DRAFT, before.DRAFT, 'a transaction that was a draft stays a draft: resume is not an approval');

  // Recovery requeues every RUNNING transaction that has no live allocation.
  runtime.store.tx(() => runtime.store.run("UPDATE transactions SET status='RUNNING' WHERE cluster_id=?", clusterId));
  runtime.recover({ deferScheduling: true });
  assert.equal(sqlStatus().READY, 1024, 'recovery requeued the whole cluster, not a page of it');

  // Cancellation drains the whole cluster.
  runtime.control(clusterId, 'cancel');
  assert.deepEqual(sqlStatus(), { CANCELLED: 1024 });
  assert.equal(required(runtime.store.getCluster(clusterId), 'cluster').status, 'CANCELLED');
});

