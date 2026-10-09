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
import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { fixtureParams } from './task-fixtures.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import { apply } from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import { createFakeHost } from './fake-host.ts';
import { communicate } from '../../packages/dsh-flow/src/core/communication.ts';
import { messageOf, rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { integer, objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import * as recursionChecks from '../acceptance/checks/recursion.ts';
import type { FlowStartInternals, FlowActor, FlowAgentActor, FlowCommandOutcome, FlowRuntimeConfig, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
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

/** Narrow an unknown JSON value to an array without leaking `any` into the reader. */
function isRowArray13(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Every element of one JSON array field a command answered with, read as an object. */
function objectRows13(value: unknown, label: string): Record<string, unknown>[] {
  if (!isRowArray13(value)) throw new Error(`${label} must be an array`);
  return value.map(item => objectField(item, label));
}

/** The blackboard view one communication query answers with. */
interface BlackboardView13 {
  readonly entries: readonly { readonly key: string; readonly value: unknown }[]
  readonly cursor: number | null
}

/** Narrow a communication answer to its query view. */
function queryView13(result: unknown, label = 'communication query'): BlackboardView13 {
  const row = objectField(result, label);
  if (!isRowArray13(row.entries)) throw new Error(`${label} must answer with entries`);
  return {
    entries: row.entries.map(entry => {
      const item = objectField(entry, `${label} entry`);
      return { key: textOf(item.key, `${label} entry key`), value: item.value };
    }),
    cursor: row.cursor === undefined || row.cursor === null
      ? null
      : numberOf(row.cursor, 0, Number.MAX_SAFE_INTEGER, `${label} cursor`),
  };
}

/** One pending action read as the budget hint the runtime attaches to a rebalance. */


test('a management node at the depth cap is refused, because no Worker could run', async t => {
  const runtime = makeRuntime(t);
  const startOverrides: Partial<FlowStartRequest> = {
    limits: { max_depth: 3 },
  };
  const startOverridesInternals: FlowStartInternals = { delegation: [{ scope: 'deep/', objective: 'deep branch', max_children: 4, spawn_children: 2 }] };
  const clusterId = startCluster(runtime, startOverrides, startOverridesInternals);
  const root = rootNode(runtime, clusterId);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const rootTx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  const first = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: rootTx.id, scope: { objective: 'level 1' },
  }).result;
  const second = command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
    transaction_id: first.delegated_transaction_id, node_id: first.node_id, scope: { objective: 'level 2' },
  }).result;
  const secondNodeId = textOf(second.node_id, 'node_id');
  assert.equal(required(runtime.store.getNode(secondNodeId), 'level 2 node').depth, 2, 'the chain reaches depth 2');
  // A node at depth 3 would need a Worker at depth 4, outside the cap: its roles would have
  // no identity to allocate, and the branch could never produce its artifact.
  const atCap = (() => {
    try {
      command(runtime, allocator, 'spawn_management_node', { fixture_prepare_management: true,
        transaction_id: second.delegated_transaction_id, node_id: second.node_id, scope: { objective: 'level 3' },
      });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(atCap, 'the spawn is refused');
  assert.match(messageOf(atCap), /could not run a Worker/);
  // ...while a level inside the cap really can allocate its Worker.
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId, node_id: secondNodeId }), 'level 3 transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', secondNodeId), 'adjust_transaction', { transaction_id: tx.id, priority: 1 });
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', secondNodeId), 'dispatch', { transaction_id: tx.id });
  const allocated = command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id, node_id: secondNodeId });
  const allocation = firstOf(objectRows13(allocated.result.allocations, 'allocations'), 'allocation');
  const workerNode = required(runtime.store.getNode(required(
    runtime.store.getAgent(textOf(allocation.agent_id, 'agent_id')), 'worker agent').node_id), 'worker node');
  assert.equal(workerNode.parent_id, secondNodeId, 'and its own Worker is legal inside the cap');
  assert.equal(workerNode.depth, 3, 'one level below its management node, still inside max_depth 3');
  const dataDir = path.dirname(runtime.store.path);
  const scenario = await recursionChecks.run({
    workspace: required(runtime.store.getCluster(clusterId), 'cluster').workspace,
    report: {
      run_id: 'test', case: 'recursion', mode: 'test', started_at: '',
      validation_mode: 'live-model', model_route: { baseURL: '', model: '', provider: '' },
      patches: [], profile: 'test', paths: {
        root: dataDir, home: dataDir, tmp: dataDir, data: dataDir,
        workspace: dataDir, artifacts: dataDir, logs: dataDir,
      },
      build_hashes: null, input_hashes: {}, mechanism_pass: '', scenario_status: '',
      quality_checks: [], failure_class: null, notes: [], cluster_id: clusterId,
    },
    layout: {
      root: dataDir, home: dataDir, tmp: dataDir, data: dataDir,
      workspace: dataDir, artifacts: dataDir, logs: dataDir,
    },
    events: [],
  });
  const depthCheck = scenario.checks.find(check => check.name === 'management-depth-three');
  assert.ok(depthCheck, 'the recursion checker reports its depth-three verdict');
  assert.equal(depthCheck.passed, false, 'a Worker at depth 3 does not make a depth-3 management branch');
});

test('delegated corrections cannot replace the contract their parent assigned', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, {
    capabilities: ['fs_read', 'fs_write'],
    initial_transactions: [{
      id: 'parent-deliverable', objective: 'write deep/nested/result.txt',
      expected_output: 'deep/nested/result.txt exists',
      acceptance_criteria: ['deep/nested/result.txt was written by this branch'], inputs: { write_scope: ['deep/staging'] },
    }],
  });
  const root = rootNode(runtime, clusterId);
  const parent = required(runtime.store.getTransaction('parent-deliverable'), 'parent transaction');
  const child = command(runtime, actorFor(runtime, clusterId, 'allocator', root.id),
    'spawn_management_node', { fixture_prepare_management: true, transaction_id: parent.id, scope: { objective: 'deliver the artifact' } }).result;
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', textOf(child.node_id, 'node_id'));
  const before = required(runtime.store.getTransaction(textOf(child.delegated_transaction_id, 'delegated_transaction_id')), 'child transaction');
  assert.deepEqual(before.acceptance_criteria, parent.acceptance_criteria);
  assert.throws(() => command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: before.id, expected_output: 'deep/staging/result.txt exists',
    acceptance_criteria: ['deep/staging/result.txt exists'],
  }), error => rejectionStatus(error) === 409 && /delegat|contract/i.test(messageOf(error)));
  const refused = required(runtime.store.getTransaction(before.id), 'refused transaction');
  assert.equal(refused.revision, before.revision);
  assert.deepEqual(refused.acceptance_criteria, parent.acceptance_criteria);
  assert.equal(refused.expected_output, parent.expected_output);
  const corrected = command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: before.id,
    inputs: { write_scope: ['deep/staging', 'deep/nested'] },
    acceptance_criteria: [...parent.acceptance_criteria, 'include a line identifying the deepest node'],
  }).result;
  assert.ok(numberOf(corrected.revision, 0, 1_000_000, 'revision') > before.revision);
  assert.deepEqual(required(runtime.store.getTransaction(before.id), 'corrected transaction').acceptance_criteria,
    [...parent.acceptance_criteria, 'include a line identifying the deepest node']);
});

test('a delegated depth counter cannot be revised to invent management levels', t => {
  const runtime = makeRuntime(t);
  const startOverrides: Partial<FlowStartRequest> = {
    capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 4, max_active_agents: 4, max_llm_concurrency: 2,
      max_corrections: 2, max_role_turns: 6 },
    budget: { tool_calls: 2_000,
      wall_time_ms: 3_600_000, agents: 64, max_active_agents: 4 },
  };
  const startOverridesInternals: FlowStartInternals = { delegation: [{ scope: 'deep/', objective: 'deliver the deep result', spawn_children: 3,
      inputs: { write_scope: ['deep/staging'] } }] };
  const clusterId = startCluster(runtime, startOverrides, startOverridesInternals);
  let node = rootNode(runtime, clusterId);
  let tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, actorFor(runtime, clusterId, 'orchestrator', node.id), 'adjust_transaction', { transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] } });
  for (const remaining of [2, 1, 0]) {
    const child = command(runtime, actorFor(runtime, clusterId, 'allocator', node.id),
      'spawn_management_node', { fixture_prepare_management: true, transaction_id: tx.id }).result;
    node = required(runtime.store.getNode(textOf(child.node_id, 'node_id')), 'child node');
    tx = required(runtime.store.getTransaction(textOf(child.delegated_transaction_id, 'delegated_transaction_id')), 'child transaction');
    assert.equal(jsonObject(tx.inputs, 'child transaction inputs').management_levels_remaining, remaining);
  }
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', node.id);
  assert.throws(() => command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { management_levels_remaining: 2, write_scope: ['deep/staging', 'deep/nested'] },
  }), error => rejectionStatus(error) === 409 && /remaining|delegat/i.test(messageOf(error)));
  assert.equal(required(runtime.store.getTransaction(tx.id), 'unchanged transaction').revision, tx.revision);
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  assert.deepEqual(required(runtime.store.getTransaction(tx.id), 'corrected transaction').inputs,
    { management_levels_remaining: 0, write_scope: ['deep/staging', 'deep/nested'] },
    'a legitimate write-scope correction preserves the fixture-owned level count');
});

test('a revised transaction requires its Allocator to replace an older Worker grant', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime, { capabilities: ['fs_read', 'fs_write'] });
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const first = firstOf(objectRows13(command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations, 'allocations'), 'grant');
  const firstId = textOf(first.allocation_id, 'allocation_id');
  assert.deepEqual(required(runtime.store.getAllocation(firstId), 'grant').write_scope, ['deep/staging']);
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const pending = runtime.pendingFor('allocator', root, required(runtime.store.getCluster(clusterId), 'cluster'), required(runtime.store.getAgent(allocator.agent_id), 'allocator'));
  assert.ok(pending.some(item => item.action === 'release_agent' && (item.allocations ?? []).includes(firstId)),
    'a changed transaction cannot silently reuse a grant fixed before the revision');
  command(runtime, allocator, 'release_agent', { allocation_id: firstId });
  const next = firstOf(objectRows13(command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations, 'allocations'), 'regrant');
  const nextId = textOf(next.allocation_id, 'allocation_id');
  assert.notEqual(textOf(next.agent_id, 'agent_id'), textOf(first.agent_id, 'agent_id'));
  assert.deepEqual(required(runtime.store.getAllocation(nextId), 'regrant').write_scope, ['deep/staging', 'deep/nested']);
});

test('the scheduler never runs a Worker granted before its transaction revision', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-stale-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = createFakeHost();
  // The fake host does not activate filesystem provider dependencies. Declare
  // the requested tools explicitly; this fixture scripts admission, not file IO.
  for (const name of ['read', 'glob', 'grep', 'write', 'edit']) {
    host.registerTool({
      name, description: 'filesystem admission fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute() { assert.fail('No filesystem tool execution is scripted in this grant-fencing test'); },
    });
  }
  const runtime = await startFlowPlugin(host, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model',
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => { await runtime.dispose(); });
  const clusterId = runtime.start({
    objective: 'write a scoped file', workspace: dir, capabilities: ['fs_read', 'fs_write'],
    limits: { max_children: 4, max_depth: 3, max_active_agents: 3, max_llm_concurrency: 2,
      max_role_turns: 6 },
    budget: { tool_calls: 100,
      wall_time_ms: 600_000, agents: 16, max_active_agents: 3 },
  }).cluster.id;
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'root transaction');
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  const old = firstOf(objectRows13(command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id }).result.allocations, 'allocations'), 'grant');
  const oldId = textOf(old.allocation_id, 'allocation_id');
  command(runtime, orchestrator, 'adjust_transaction', {
    transaction_id: tx.id, inputs: { write_scope: ['deep/staging', 'deep/nested'] },
  });
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  // This fixture tests Worker grant fencing, not management-role behavior.
  // With no fake management model supplied, retire those sessions so their
  // empty turns cannot block the root before Worker admission.
  runtime.store.tx(() => {
    for (const role of runtime.store.listAgents(clusterId, { node_id: root.id })) {
      runtime.store.updateAgent(role.id, { status: 'TERMINATED' });
    }
  });
  const workers: FakeTurn[] = [];
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.role !== 'worker') return;
    workers.push(turn);
    await turn.request({ purpose: 'worker' });
  });
  runtime.enableScheduling();
  for (let pass = 0; pass < 3; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.equal(workers.length, 0, 'a READY transaction cannot run under an obsolete write grant');
  command(runtime, allocator, 'release_agent', { allocation_id: oldId });
  command(runtime, allocator, 'allocate_agent', { transaction_id: tx.id });
  for (let pass = 0; pass < 10 && !workers.length; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.tick();
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.equal(workers.length, 1, 'a newly granted Worker may run the revised plan');
});

test('a Worker can discover its management roles without reading sibling Workers', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const first = firstOf(runtime.store.listTransactions({ cluster_id: clusterId }), 'first transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: first.id });
  command(runtime, allocator, 'allocate_agent', { transaction_id: first.id });
  const secondId = textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'unrelated sibling work', acceptance_criteria: ['sibling exists'],
  }).result.transaction_id, 'transaction_id');
  command(runtime, orchestrator, 'dispatch', { transaction_id: secondId });
  command(runtime, allocator, 'allocate_agent', { transaction_id: secondId });
  const own = required(runtime.store.activeAllocationForTransaction(first.id), 'own allocation');
  const sibling = required(runtime.store.activeAllocationForTransaction(secondId), 'sibling allocation');
  const worker = required(runtime.store.getAgent(own.agent_id), 'worker agent');
  const workerActor: FlowAgentActor = {
    cluster_id: clusterId, node_id: worker.node_id, agent_id: worker.id, role: 'worker', session_id: worker.session_id,
  };
  const visible = runtime.query(workerActor, 'agents', { limit: 10 }).items;
  assert.deepEqual(visible.filter(agent => agent.node_id === root.id).map(agent => agent.role).sort(),
    ['allocator', 'auditor', 'orchestrator'], 'the Worker can address all three owning roles');
  assert.equal(visible.some(agent => agent.id === sibling.agent_id), false,
    'discovering the managers does not expose other Workers in their domain');
});

test('acceptance closes an issue only when new Worker evidence answered it', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const first = firstOf(runtime.store.rootTransactions(clusterId), 'first transaction');
  const second = { id: textOf(command(runtime, orchestrator, 'create_transaction', {
    objective: 'a second deliverable that is repaired after its issue',
    acceptance_criteria: ['the deliverable exists'],
  }).result.transaction_id, 'transaction_id') };
  const correctedEvents = () => runtime.store.all(
    "SELECT json_extract(data,'$.issue_id') AS issue_id, json_extract(data,'$.reason') AS reason FROM events WHERE cluster_id=? AND type='issue-corrected'",
    clusterId,
  );

  for (const tx of [first, second]) {
    command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
    command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });
    runtime.store.tx(() => {
      runtime.store.appendEvent(clusterId, 'result-submitted', { transaction_id: tx.id, result_completed: 0, revision: 2 });
      runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { completed: false }, __bump_revision: false });
    });
  }
  const answered = required(runtime.store.insertIssue({
    id: 'issue-answered-by-acceptance', cluster_id: clusterId, node_id: root.id,
    transaction_id: second.id, target_revision: 2, required_change: 'produce the deliverable',
  }), 'answered issue');
  const unanswered = required(runtime.store.insertIssue({
    id: 'issue-awaiting-replacement', cluster_id: clusterId, node_id: root.id,
    transaction_id: first.id, target_revision: 2, required_change: 'produce the deliverable',
  }), 'unanswered issue');
  runtime.store.tx(() => {
    for (const issue of [answered, unanswered]) {
      runtime.store.appendEvent(clusterId, 'issue-opened', {
        issue_id: issue.id, transaction_id: issue.transaction_id, severity: issue.severity,
      });
    }
  });

  // The second transaction really does produce replacement work after its issue.
  runtime.store.tx(() => runtime.store.appendEvent(clusterId, 'result-submitted', {
    transaction_id: second.id, result_completed: 1, revision: 3,
  }));

  for (const tx of [first, second]) {
    command(runtime, orchestrator, 'validate', {
      transaction_id: tx.id, accepted: true,
      checks: [{ criterion: 'the deliverable exists', passed: true, evidence: 'recorded result checked' }],
    });
    command(runtime, auditor, 'inspect_validation', { transaction_id: tx.id, decision: 'approve' });
    assert.equal(required(runtime.store.getTransaction(tx.id), 'validated transaction').status, 'ACCEPTED');
  }

  assert.equal(required(runtime.store.getIssue(answered.id), 'answered issue').status, 'CORRECTED',
    'an accepted result submitted after the issue is the correction');
  assert.equal(required(runtime.store.getIssue(unanswered.id), 'unanswered issue').status, 'OPEN',
    'acceptance alone must not correct an issue raised against an incomplete Worker result');
  const closures = correctedEvents();
  assert.deepEqual(closures.map(row => row.issue_id), [answered.id],
    `only the issue with replacement evidence closes: ${JSON.stringify(closures)}`);
  assert.equal(firstOf(closures, 'issue-corrected event').reason, 'accepted-result-after-issue',
    'the closure records why it happened, rather than flipping the status silently');
});

test('a communication query returns the prefix view with the cursor of its read cut', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const cluster = required(runtime.store.getCluster(clusterId), 'cluster');
  const publish = (key: string, value: unknown) => runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'publish', { key, value }));
  publish('plan/alpha', { step: 1 });
  publish('result/beta', { ok: true });
  const before = runtime.store.latestEventSeq(clusterId);

  const byPrefix = queryView13(runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { prefix: 'plan/' })));
  assert.deepEqual(byPrefix.entries.map(entry => entry.key), ['plan/alpha'],
    'a prefix query returns that prefix and nothing else');
  assert.deepEqual(firstOf(byPrefix.entries, 'prefix entry').value, { step: 1 });
  assert.ok(required(byPrefix.cursor, 'cursor') >= before, 'the cursor is the read cut the snapshot came from');

  const byKey = queryView13(runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { key: 'result/beta' })));
  assert.deepEqual(byKey.entries.map(entry => entry.key), ['result/beta']);
  assert.deepEqual(firstOf(byKey.entries, 'key entry').value, { ok: true });

  const missing = queryView13(runtime.store.tx(() => communicate(runtime.store, cluster, auditor, 'query', { key: 'plan/absent' })));
  assert.deepEqual(missing.entries, [], 'an absent key is an empty view, not an error');
});

test('an authorized Allocator spawns a Worker through spawn_agent', t => {
  const runtime = makeRuntime(t);
  const clusterId = startCluster(runtime);
  const root = rootNode(runtime, clusterId);
  const orchestrator = actorFor(runtime, clusterId, 'orchestrator', root.id);
  const auditor = actorFor(runtime, clusterId, 'auditor', root.id);
  const allocator = actorFor(runtime, clusterId, 'allocator', root.id);
  const tx = firstOf(runtime.store.rootTransactions(clusterId), 'root transaction');
  command(runtime, orchestrator, 'dispatch', { transaction_id: tx.id });
  command(runtime, auditor, 'inspect_plan', { transaction_id: tx.id, decision: 'approve' });

  const spawned = command(runtime, allocator, 'spawn_agent', { transaction_id: tx.id }).result;
  assert.equal(spawned.count, 1);
  const allocation = firstOf(objectRows13(spawned.allocations, 'allocations'), 'allocation');
  assert.equal(allocation.transaction_id, tx.id);
  const worker = required(runtime.store.getAgent(textOf(allocation.agent_id, 'agent_id')), 'worker agent');
  assert.equal(worker.role, 'worker', 'spawn_agent grants a Worker, not another management role');
  const workerNode = required(runtime.store.getNode(worker.node_id), 'worker node');
  assert.equal(workerNode.parent_id, root.id, 'the Worker node hangs off the domain that granted it');
  assert.equal(required(workerNode.scope, 'worker scope').transaction_id, tx.id, 'and carries the transaction it was granted for');
  assert.equal(workerNode.owner_management_id, root.id);
  assert.equal(required(runtime.store.getTransaction(tx.id), 'worker transaction').status, 'READY');

  assert.throws(() => command(runtime, allocator, 'spawn_agent', {}),
    error => /transaction_id/.test(messageOf(error)), 'a grant without a transaction names nothing to execute');
});

