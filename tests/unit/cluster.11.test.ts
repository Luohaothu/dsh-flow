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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { fixtureParams, prepareFixtureTask } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { checkWriteAccess } from '../../packages/dsh-flow/src/core/scope.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import * as recursionChecks from '../acceptance/checks/recursion.ts';
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
function acceptanceContext11(
  clusterId: string,
  directory: string,
  rows: readonly { readonly seq: number; readonly type: string; readonly data: unknown; readonly at: number }[],
) {
  const layout = {
    root: directory, home: directory, tmp: directory, data: directory,
    workspace: directory, artifacts: directory, logs: directory,
  };
  const report = {
    run_id: `unit-${clusterId}`,
    case: 'cluster-unit',
    mode: 'unit',
    started_at: new Date(now()).toISOString(),
    validation_mode: 'mock-api' as const,
    model_route: { baseURL: 'http://127.0.0.1', model: 'unit-test', provider: 'local-fake' },
    patches: [],
    profile: 'unit',
    paths: layout,
    build_hashes: null,
    input_hashes: {},
    mechanism_pass: 'RUNNING',
    scenario_status: 'RUNNING',
    quality_checks: [],
    failure_class: null,
    notes: [],
    cluster_id: clusterId,
  };
  const events = rows.map(entry => ({
    seq: entry.seq,
    type: entry.type,
    data: jsonObject(entry.data, 'event data'),
    at: entry.at,
  }));
  return { report, layout, events };
}

test('the recursion checker accepts a no-attempt fault: denial, rejection, corrected allocation', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-nofault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'a well-behaved worker reports instead of attempting', workspace: dir,
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    }, { delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }] }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const spawnLevel = (parentNodeId: string, objective: string) => {
    const parentLead = actorFor(runtime, clusterId, 'orchestrator', parentNodeId);
    const parentAllocator = actorFor(runtime, clusterId, 'allocator', parentNodeId);
    const created = command(runtime, parentLead, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    prepareFixtureTask(runtime, txId, 'management');
    return textOf(command(runtime, parentAllocator, 'spawn_management_node', { fixture_prepare_management: true,
      transaction_id: txId,
    }).result.node_id, 'node_id');
  };
  const level1 = spawnLevel(root.id, 'level one');
  const level2 = spawnLevel(level1, 'level two');
  const level3 = spawnLevel(level2, 'level three');
  const deepestTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3 }), 'deepest transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  prepareFixtureTask(runtime, deepestTx.id);
  // A root Allocator can supervise the branch, but it cannot put its Worker
  // under the root: the delegated node owns this transaction and its effects.
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: deepestTx.id }),
    error => rejectionStatus(error) === 409 && /transaction.*node|node.*transaction/.test(messageOf(error)));
  const deepestAllocator = actorFor(runtime, clusterId, 'allocator', level3);
  const placed = command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id });
  const initial = required(runtime.store.activeAllocationForTransaction(deepestTx.id), 'initial allocation');
  assert.ok(initial, 'the faulty allocation exists');
  const workerNode = required(runtime.store.getNode(required(runtime.store.getAgent(initial.agent_id), 'worker agent').node_id), 'worker node');
  assert.equal(workerNode.parent_id, level3, `the deepest node owns its Worker: ${JSON.stringify(placed.result.allocations)}`);
  assert.equal(workerNode.depth, 4, 'the real terminal node can host its Worker within max_depth 4');
  // The worker *reports* the limitation: it never attempts the forbidden write, so
  // no `write-refused` event exists anywhere.
  assert.equal(runtime.store.readEvents(clusterId, { limit: 400 }).filter(event => event.type === 'write-refused').length, 0,
    'nothing attempted the prohibited write');
  // The Auditor rejects and a durable issue is recorded against the transaction…
  const worker = required(runtime.store.getAgent(initial.agent_id), 'worker agent');
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  runtime.store.tx(() => runtime.store.insertIssue({
    id: 'issue-nofault-1', cluster_id: clusterId, node_id: level3, transaction_id: deepestTx.id, severity: 'MAJOR',
    required_change: 'widen the write scope and re-allocate', target_revision: required(runtime.store.getTransaction(deepestTx.id), 'deepest transaction').revision,
  }));
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: deepestTx.id, patch: { inputs: { ...jsonObject(deepestTx.inputs, 'deepest transaction inputs'), write_scope: ['deep'] } },
  });
  runtime.store.tx(() => runtime.store.updateAllocation(initial.id, { status: 'RELEASED' }));
  // An adjusted transaction is a new revision and goes back through dispatch, as the
  // Orchestrator would take it.
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  command(runtime, deepestAllocator, 'allocate_agent', { transaction_id: deepestTx.id, write_scope: ['deep'] });
  const corrected = required(runtime.store.activeAllocationForTransaction(deepestTx.id), 'corrected allocation');
  assert.ok(corrected && corrected.id !== initial.id, 'the corrected allocation is a new one');
  const allowed = checkWriteAccess({
    tool: 'write', workspace: required(runtime.store.getCluster(clusterId), 'cluster').workspace,
    writeScope: corrected.write_scope, writeScopeCanonical: corrected.write_scope_canonical,
    arguments: { file_path: 'deep/nested/result.txt' },
  });
  assert.equal(allowed.allowed, true, `and it may write the target: ${JSON.stringify(allowed)}`);

  // The checker must accept this trace, called for real rather than simulated: the
  // *initial* allocation is denied by the guard, which is the proof the injected
  // fault is real — an attempt is not.
  const context = acceptanceContext11(clusterId, dir, runtime.store.readEvents(clusterId, { limit: 500 }));
  const result = await recursionChecks.run({ workspace: dir, ...context });
  const fault = required(result.checks.find(entry => entry.name === 'injected-fault-is-real'), 'injected-fault-is-real check');
  assert.equal(fault.passed, true, `a no-attempt fault with a real denial passes: ${fault.evidence}`);
  assert.equal(required(result.checks.find(entry => entry.name === 'independent-gate-acted'), 'independent-gate-acted').passed, false,
    'a manually seeded issue with no Auditor reporter cannot prove independent governance');
  // And it fails when the fault is not really there: with the initial allocation
  // removed, only the corrected (permissive) one remains.
  runtime.store.tx(() => runtime.store.run('DELETE FROM allocations WHERE id=?', initial.id));
  const second = await recursionChecks.run({ workspace: dir, ...context });
  const secondFault = required(second.checks.find(entry => entry.name === 'injected-fault-is-real'), 'second injected-fault-is-real check');
  assert.equal(secondFault.passed, false, `without the faulty allocation it fails: ${secondFault.evidence}`);
  void worker; void auditor;
});

test('a one-slot window lets both classes progress, one resident turn at a time', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-oneslot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'one slot, two classes owed', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tool_calls: 4_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 1 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // A Worker with work waiting, and management work owed at the same time.
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work for a worker', acceptance_criteria: ['x'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: txId });
  assert.equal(runtime.store.readyForWorker(clusterId, { limit: 1 }).length, 1, 'a Worker is ready');
  let published = 0;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role === 'worker') return;
    published += 1;
    touchBlackboard(runtime, clusterId, `oneslot/${published}`, null);
  });
  runtime.enableScheduling();
  const starts = () => runtime.store.all(
    "SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  let peak = 0;
  for (let pass = 0; pass < 30; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    peak = Math.max(peak, runtime.activeTurnIds().length);
    await Promise.all(runtime.activeTurnIds().map(agentId => (
      required(runtime.activeTurnFor(agentId), 'active turn').promise
    )));
    const roles = new Set(starts().map(row => row.role));
    if (roles.size >= 2) break;
  }
  const roles = starts();
  assert.ok(roles.some(row => row.role === 'worker'), `the Worker ran: ${JSON.stringify(roles)}`);
  assert.ok(roles.some(row => row.role !== 'worker'), `and so did management: ${JSON.stringify(roles)}`);
  assert.ok(peak <= 1, `never more than one resident turn: peak ${peak}`);
  void auditor;
});

test('a refused write reaches the Auditor as work it can act on', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-refusal-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'the Auditor hears about a refused write', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'produce a file it may not write', acceptance_criteria: ['x'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: txId });
  if (required(runtime.store.getTransaction(txId), 'transaction').status === 'DRAFT') {
    command(runtime, auditor, 'inspect_plan', { transaction_id: txId, decision: 'approve' });
  }
  command(runtime, allocator, 'allocate_agent', { transaction_id: txId, write_scope: ['elsewhere'] });
  const allocation = runtime.store.activeAllocationForTransaction(txId);
  assert.ok(allocation, 'the worker is allocated outside the target');
  // The guard refuses the write, exactly as it does in the live run.
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write',
    reason: 'write to deep/nested/result.txt is outside the allocation scope ["elsewhere"]',
  }));
  // ...and the Auditor's pending set names it, with the transaction it blocks.
  const actions = runtime.pendingFor('auditor', root, cluster,
    firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor agent'));
  const refusal = actions.find(action => action.refusal_seq !== undefined);
  assert.ok(refusal, `the Auditor is told: ${JSON.stringify(actions)}`);
  assert.equal(refusal.transaction_id, txId, 'about the transaction that cannot be produced');
  assert.match(String(refusal.note), /refused/);
  // Acting on it with the *real* command opens the durable issue the correction
  // round needs, and pulls the branch back for a corrected attempt.
  command(runtime, auditor, 'request_replan', {
    transaction_id: txId,
    evidence: { refusal_seq: refusal.refusal_seq, reason: refusal.note },
    required_change: 'widen the write scope and re-allocate before resubmitting',
  });
  const issues = runtime.store.all(
    "SELECT id, status, transaction_id FROM issues WHERE cluster_id=? AND transaction_id=?", clusterId, txId);
  assert.ok(issues.length >= 1, `the issue is durable: ${JSON.stringify(issues)}`);
  const issueId = textOf(firstOf(issues, 'durable issue').id, 'issue_id');
  assert.equal(required(runtime.store.getTransaction(txId), 'transaction').status, 'DRAFT', 'and the branch is back for a corrected revision');
  assert.throws(() => command(runtime, auditor, 'verify_correction', {
    issue_id: issueId, decision: 'dismissed',
    evidence: { rechecked: 'the denied target write', found: 'the scope remains unchanged' },
  }), error => rejectionStatus(error) === 409 && /refus|denied|write/i.test(messageOf(error)),
  'a denied write is objective evidence of an unresolved issue, not a mistaken report');
  assert.equal(required(runtime.store.getIssue(issueId), 'issue').status, 'OPEN');

  // The same refusal is still offered: nothing has handled it yet.
  const beforeHandling = runtime.pendingFor('auditor', root, cluster,
    firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor agent'));
  assert.ok(beforeHandling.some(action => action.refusal_seq === refusal.refusal_seq),
    'an unhandled refusal stays pending');
  // A turn that takes the action up is the only thing that acknowledges it: the
  // revert path in `#applyCommand` is exercised by the real `request_replan` above,
  // which is what removed it from this list on the next pass.
  const handledEvents = () => runtime.store.all(
    "SELECT json_extract(data,'$.seq') AS seq FROM events WHERE cluster_id=? AND type='refusal-handled'", clusterId);
  assert.equal(handledEvents().length, 0,
    'a direct command acknowledges nothing: only a turn that admitted the work can');

  // A terminal transaction gets the action its state allows, and that action is
  // *executed*: the node-level escalation records it without touching the terminal
  // transaction.
  runtime.store.tx(() => runtime.store.updateTransaction(txId, { status: 'FAILED' }));
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'write refused again after the repair attempt',
  }));
  const fresh = runtime.pendingFor('auditor', root, cluster,
    firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor agent'));
  const second = fresh.find(action => action.refusal_seq !== undefined && action.refusal_seq !== refusal.refusal_seq);
  assert.ok(second, `a new refusal is offered: ${JSON.stringify(fresh.map(a => a.action))}`);
  assert.equal(second.action, 'escalate', 'and it is an action a terminal transaction accepts');
  assert.equal(second.node_id, root.id, 'escalating the node, not the terminal transaction');
  command(runtime, auditor, 'escalate', { node_id: root.id, reason: second.note });
  const blockedForRefusal = runtime.store.all(
    "SELECT json_extract(data,'$.reason') AS reason FROM events WHERE cluster_id=? AND type='node-blocked'", clusterId);
  assert.ok(blockedForRefusal.some(row => /write/.test(String(row.reason))),
    `the advertised escalation really runs: ${JSON.stringify(blockedForRefusal)}`);
  assert.equal(required(runtime.store.getTransaction(txId), 'transaction').status, 'FAILED', 'and the terminal transaction is untouched');
});

test('a refused child write belongs to its own Auditor, not every ancestor Auditor', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = rootNode(runtime, clusterId);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', root.id), 'dispatch', { transaction_id: rootTx.id, fixture_execution: 'management' });
  const spawned = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id), 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: rootTx.id, scope: { objective: 'delegated file' },
  }).result;
  const child = required(runtime.store.getNode(textOf(spawned.node_id, 'node_id')), 'child node');
  const childTx = textOf(spawned.delegated_transaction_id, 'delegated_transaction_id');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', child.id), 'dispatch', { transaction_id: childTx });
  command(runtime, actorFor(runtime, clusterId, 'allocator', child.id), 'allocate_agent', {
    transaction_id: childTx, write_scope: ['staging'],
  });
  const allocation = required(runtime.store.activeAllocationForTransaction(childTx), 'child allocation');
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: allocation.agent_id, tool: 'write', reason: 'target outside staging',
  }));
  const own = runtime.pendingFor('auditor', child, cluster, firstOf(runtime.store.listAgents(clusterId, { node_id: child.id, role: 'auditor', limit: 1 }), 'child auditor'));
  const ancestor = runtime.pendingFor('auditor', root, cluster, firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'root auditor'));
  assert.equal(own.filter(item => item.refusal_seq !== undefined && item.transaction_id === childTx).length, 1);
  assert.equal(ancestor.filter(item => item.refusal_seq !== undefined && item.transaction_id === childTx).length, 0,
    'an ancestor cannot open a second issue on the same denied effect');
});

test('the Auditor issue retains the refused write it took up during its turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-issue-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'produce the scoped file', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1 },
    budget: { tool_calls: 2000, wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, write_scope: ['staging'] });
  const worker = required(runtime.store.activeAllocationForTransaction(tx.id), 'worker allocation').agent_id;
  const refusals = [1, 2].map(() => runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'write-refused', {
    agent_id: worker, tool: 'write', reason: 'target file outside staging',
  })).seq);
  // The refused effects belong to a completed Worker attempt; do not start
  // a new Worker turn while the Auditor is reviewing that finished attempt.
  runtime.store.tx(() => runtime.store.updateTransaction(tx.id, {
    status: 'SUBMITTED', result: { status: 'blocked' }, result_revision: tx.revision, __bump_revision: false,
  }));
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'auditor') return;
    const action = runtime.pendingFor('auditor', root, cluster, firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor agent'))
      .find(item => item.transaction_id === tx.id && item.refusal_seq !== undefined);
    if (action) command(runtime, auditor, 'request_replan', {
      transaction_id: tx.id, required_change: 'grant the target write scope',
    });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 5 && !runtime.store.openIssues(clusterId, { transaction_id: tx.id, status: 'OPEN' }).length; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    await Promise.all(runtime.activeTurnIds().map(agentId => (
      required(runtime.activeTurnFor(agentId), 'active turn').promise
    )));
  }
  const issue = runtime.store.openIssues(clusterId, { transaction_id: tx.id, status: 'OPEN' })[0];
  assert.ok(issue, 'the Auditor committed the correction in its own turn');
  const evidence = jsonObject(issue.evidence, 'issue evidence');
  const recordedRefusals = Array.isArray(evidence.refusal_seqs)
    ? [...evidence.refusal_seqs].map(seq => numberOf(seq, 0, 1e9, 'refusal_seq')).sort((a, b) => a - b)
    : null;
  assert.deepEqual(recordedRefusals, refusals,
    'the durable issue is linked to both denied effects without trusting model-supplied evidence');
  const verdicts = runtime.pendingFor('auditor', root, cluster, firstOf(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'auditor', limit: 1 }), 'auditor agent'))
    .filter(item => item.action === 'review_issue' && textOf(jsonObject(item, 'pending action').issue_id, 'issue_id') === issue.id);
  assert.equal(verdicts.length, 0, 'a proven write refusal is pending a repair, not a dismissal verdict');
});

test('all three management roles get turns under a small window, without exceeding it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-rolerotate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'every role must get a slot eventually', workspace: dir, capabilities: [],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: { tool_calls: 5_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 1 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  // Continuous work for every role: a DRAFT transaction to dispatch, a READY one to
  // allocate, and a plan audit for the auditor to decide.
  const draft = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work to dispatch', acceptance_criteria: ['x'],
  });
  const draftId = textOf(draft.result.transaction_id, 'transaction_id');
  const ready = command(runtime, orchestrator, 'create_transaction', {
    objective: 'work to allocate', acceptance_criteria: ['x'],
  });
  const readyId = textOf(ready.result.transaction_id, 'transaction_id');
  prepareFixtureTask(runtime, readyId);
  let published = 0;
  host.setScript(async () => {
    published += 1;
    touchBlackboard(runtime, clusterId, `rotate/${published}`, null);
  });
  runtime.enableScheduling();
  const starts = () => runtime.store.all(
    "SELECT json_extract(data,'$.role') AS role, COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' GROUP BY role", clusterId);
  let peak = 0;
  for (let pass = 0; pass < 40; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    peak = Math.max(peak, runtime.activeTurnIds().length);
    await Promise.all(runtime.activeTurnIds().map(agentId => (
      required(runtime.activeTurnFor(agentId), 'active turn').promise
    )));
    if (new Set(starts().map(row => row.role)).size >= 3) break;
  }
  const roles = new Set(starts().map(row => row.role));
  for (const role of ['orchestrator', 'allocator', 'auditor']) {
    assert.ok(roles.has(role), `the ${role} got a turn under a one-slot window: ${JSON.stringify(starts())}`);
  }
  assert.ok(peak <= 1, `and the window was never exceeded: peak ${peak}`);
  void allocator; void auditor; void readyId; void draftId;
});


test('escalating a node stops its unfinished transactions with it', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-escalate-branch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'an escalated branch leaves nothing dangling', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const created = command(runtime, orchestrator, 'create_transaction', {
    objective: 'the branch that will be escalated', acceptance_criteria: ['x'],
  });
  const txId = textOf(created.result.transaction_id, 'transaction_id');
  const child = textOf(command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: txId, objective: 'a branch that cannot finish', acceptance_criteria: ['x'],
  }).result.node_id, 'node_id');
  // The branch has a DRAFT and a READY transaction, neither of them able to complete.
  const childTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: child }), 'child transaction');
  const extra = command(runtime, actorFor(runtime, clusterId, 'orchestrator', child), 'create_transaction', {
    objective: 'more work in the branch', acceptance_criteria: ['x'], status: 'READY',
  });
  const extraId = textOf(extra.result.transaction_id, 'transaction_id');
  runtime.store.tx(() => runtime.store.updateTransaction(extraId, { node_id: child }));
  assert.equal(required(runtime.store.getTransaction(childTx.id), 'transaction').status, 'DRAFT', 'the branch has unfinished work');
  // A transaction created in the branch is DRAFT (the plan gate); take it to READY
  // through the ordinary route so both states are represented.
  if (required(runtime.store.getTransaction(extraId), 'transaction').status === 'DRAFT') {
    command(runtime, actorFor(runtime, clusterId, 'orchestrator', child), 'dispatch', { transaction_id: extraId });
    if (required(runtime.store.getTransaction(extraId), 'transaction').status === 'DRAFT') {
      command(runtime, actorFor(runtime, clusterId, 'auditor', child), 'inspect_plan', { transaction_id: extraId, decision: 'approve' });
    }
  }
  assert.equal(required(runtime.store.getTransaction(extraId), 'transaction').status, 'READY', 'in two states');
  command(runtime, actorFor(runtime, clusterId, 'auditor', child), 'escalate', {
    node_id: child, reason: 'the branch cannot produce its artifact',
  });
  assert.equal(required(runtime.store.getNode(child), 'child node').status, 'BLOCKED', 'the node is escalated');
  assert.equal(required(runtime.store.getTransaction(childTx.id), 'transaction').status, 'BLOCKED', 'and its DRAFT work is stopped with it');
  assert.equal(required(runtime.store.getTransaction(extraId), 'transaction').status, 'BLOCKED', 'as is its READY work');
  const events = runtime.store.readEvents(clusterId, { limit: 300 });
  assert.equal(events.filter(event => event.type === 'transaction-blocked').length >= 2, true,
    'each stop is recorded');
  void auditor;
});

test('the fault check fails when only a shallower level was allocated', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-shallow-fault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'only a shallow level was allocated', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    }, { delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep/staging'] } }] }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const spawnChild = (nodeId: string | null, objective: string) => {
    const ownerId = nodeId ?? root.id;
    const ownerLead = actorFor(runtime, clusterId, 'orchestrator', ownerId);
    const ownerAllocator = actorFor(runtime, clusterId, 'allocator', ownerId);
    const created = command(runtime, ownerLead, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    prepareFixtureTask(runtime, txId, 'management');
    return {
      txId,
      nodeId: textOf(command(runtime, ownerAllocator, 'spawn_management_node', { fixture_prepare_management: true,
        transaction_id: txId,
      }).result.node_id, 'node_id'),
    };
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1.nodeId, 'level two');
  const level3 = spawnChild(level2.nodeId, 'level three');
  // Only the shallow level is allocated — and denied, so the *shallow* fault is real.
  const level1Tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: level1.nodeId }), 'level one transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(level1Tx.id, { status: 'READY' }));
  command(runtime, actorFor(runtime, clusterId, 'allocator', level1.nodeId), 'allocate_agent', {
    transaction_id: level1Tx.id, write_scope: ['deep/staging'],
  });
  const shallow = runtime.store.activeAllocationForTransaction(level1Tx.id);
  assert.ok(shallow, 'the shallow level is allocated');
  const deepestTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3.nodeId }), 'deepest transaction');
  assert.equal(required(runtime.store.getTransaction(deepestTx.id), 'transaction').status, 'DRAFT', 'and the deepest level is not');

  const context = acceptanceContext11(clusterId, dir, runtime.store.readEvents(clusterId, { limit: 500 }));
  const result = await recursionChecks.run({ workspace: dir, ...context });
  const fault = required(result.checks.find(entry => entry.name === 'injected-fault-is-real'), 'injected-fault-is-real check');
  assert.equal(fault.passed, false, `a fault that never reached the deepest level is not a pass: ${fault.evidence}`);
});

test('the artifact check wants a settled write to this path by the deepest node', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-flow-writer-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  const runtime = await startFlowPlugin(host, {
    dataDir: dir,
    provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'who wrote the artifact', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
    budget: { tool_calls: 2_000, wall_time_ms: 600_000, agents: 32, max_active_agents: 3 },
    }, { delegation: [{ scope: 'deep/', objective: 'own the deep branch', max_children: 4, spawn_children: 3, inputs: { write_scope: ['deep'] } }] }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const spawnChild = (nodeId: string | null, objective: string) => {
    const ownerId = nodeId ?? root.id;
    const ownerLead = actorFor(runtime, clusterId, 'orchestrator', ownerId);
    const ownerAllocator = actorFor(runtime, clusterId, 'allocator', ownerId);
    const created = command(runtime, ownerLead, 'create_transaction', { objective, acceptance_criteria: ['x'] });
    const txId = textOf(created.result.transaction_id, 'transaction_id');
    prepareFixtureTask(runtime, txId, 'management');
    return {
      txId,
      nodeId: textOf(command(runtime, ownerAllocator, 'spawn_management_node', { fixture_prepare_management: true,
        transaction_id: txId,
      }).result.node_id, 'node_id'),
    };
  };
  const level1 = spawnChild(null, 'level one');
  const level2 = spawnChild(level1.nodeId, 'level two');
  const level3 = spawnChild(level2.nodeId, 'level three');
  const deepestTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: level3.nodeId }), 'deepest transaction');
  runtime.store.tx(() => runtime.store.updateTransaction(deepestTx.id, { status: 'READY' }));
  command(runtime, actorFor(runtime, clusterId, 'allocator', level3.nodeId), 'allocate_agent', { transaction_id: deepestTx.id });
  const allocation = required(runtime.store.activeAllocationForTransaction(deepestTx.id), 'allocation');
  const worker = required(runtime.store.getAgent(allocation.agent_id), 'worker agent');
  assert.equal(required(runtime.store.getNode(worker.node_id), 'worker node').parent_id, level3.nodeId, 'the deepest node owns the worker');

  // A settled, non-error write to exactly this path by that worker.
  runtime.store.tx(() => runtime.store.insertEffect({
    call_id: 'eff-deep', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
    lease_epoch: 1, session_id: worker.session_id, turn_seq: 1, tool: 'write',
    args: { file_path: 'deep/nested/result.txt' },
    status: 'SETTLED', body: { isError: false, text: '2 levels below the root' },
  }));
  mkdirSync(path.join(dir, 'deep/nested'), { recursive: true });
  writeFileSync(path.join(dir, 'deep/nested/result.txt'), '2 levels below the root');
  const runCheck = async () => {
    const context = acceptanceContext11(clusterId, dir, runtime.store.readEvents(clusterId, { limit: 500 }));
    const result = await recursionChecks.run({ workspace: dir, ...context });
    return required(result.checks.find(entry => entry.name === 'deep-artifact-written'), 'deep-artifact-written check');
  };
  const pass = await runCheck();
  assert.equal(pass.passed, true, `a settled write to the path passes: ${pass.evidence}`);

  // The same write to *another* file does not.
  runtime.store.tx(() => runtime.store.run("UPDATE effects SET args=? WHERE call_id='eff-deep'", JSON.stringify({ file_path: 'deep/other.txt' })));
  const wrongPath = await runCheck();
  assert.equal(wrongPath.passed, false, `a write to another file does not: ${wrongPath.evidence}`);

  // A failed write does not.
  runtime.store.tx(() => runtime.store.run("UPDATE effects SET args=?, body=? WHERE call_id='eff-deep'",
    JSON.stringify({ file_path: 'deep/nested/result.txt' }), JSON.stringify({ isError: true })));
  const failed = await runCheck();
  assert.equal(failed.passed, false, `a failed write does not: ${failed.evidence}`);
});

test('a management parent cannot allocate a Worker or enter its queue when its delegated child is accepted', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id, fixture_execution: 'management' });
  assert.throws(() => command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }), /management execution/);
  const spawned = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: tx.id, scope: { objective: 'child result' },
  }).result;
  const child = required(runtime.store.getTransaction(textOf(spawned.delegated_transaction_id, 'delegated_transaction_id')), 'child transaction');
  runtime.store.updateTransaction(child.id, { status: 'ACCEPTED', result: { completed: true } });
  const childNode = required(runtime.store.getNode(textOf(spawned.node_id, 'node_id')), 'child node');
  assert.equal(runtime.pendingFor('orchestrator', childNode, required(runtime.store.getCluster(clusterId), 'cluster'))
    .some(item => item.action === 'report-to-parent'), false,
  'an accepted delegated result is already visible to its parent and must not wake endless reporting turns');
  assert.equal(runtime.store.activeAllocationForTransaction(tx.id), null, 'the management parent has no Worker grant');
  assert.ok(runtime.store.aggregatableParents(clusterId, root.id).some(row => row.parent_id === tx.id),
    'the Orchestrator can now aggregate the accepted child');
  assert.ok(!runtime.store.readyForWorker(clusterId).some(row => row.id === tx.id),
    'the already-granted Worker is not woken to repeat delegated work');
});

