import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny } from '@total-typescript/shoehorn';

import type { Context } from '@deepseek-ai/cordis';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowJsonValue } from '../../packages/dsh-flow/src/types.ts';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { fixtureParams, fixturePlan } from './task-fixtures.ts';

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

/** Narrow one command result field, which crosses the wire as JSON. */
function jsonRecord(value: FlowJsonValue | undefined, label: string): Record<string, FlowJsonValue> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error(`expected ${label} to be an object`);
}

function textField(value: FlowJsonValue | undefined, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`expected ${label} to be a string`);
}

function listField(value: FlowJsonValue | undefined, label: string): FlowJsonValue[] {
  if (Array.isArray(value)) return value;
  throw new Error(`expected ${label} to be a list`);
}

function relationParams(runtime: ClusterRuntime, actor: FlowAgentActor, action: string, params: Record<string, unknown>) {
  if (action !== 'decompose') return fixtureParams(runtime, actor, action, params);
  const parent = must(runtime.store.getTransaction(String(params.transaction_id)), 'decomposition parent');
  const raw = Array.isArray(params.children) ? params.children : [];
  const children = raw.map((value, index) => {
    const child: Record<string, unknown> = value;
    const convert = (refs: unknown) => Array.isArray(refs) ? refs.map(ref => typeof ref === 'number' ? `child-${ref}` : ref) : [];
    const acceptance_criteria = Array.isArray(child.acceptance_criteria) ? child.acceptance_criteria.map(String) : [];
    const base = fixturePlan({ objective: String(child.objective), expected_output: '', acceptance_criteria });
    return { ...child, key: `child-${index}`, acceptance_criteria, depends_on: convert(child.depends_on ?? child.after), plan: {
      ...base, criterion_responsibilities: [
        ...(Array.isArray(base.criterion_responsibilities) ? base.criterion_responsibilities : []),
        ...parent.acceptance_criteria.map((_, criterion_index) => ({ criterion: { transaction_id: 'parent', criterion_index }, evidence_provider: 'worker', validated_by: 'orchestrator', applies_to: ['worker'] })),
      ],
    } };
  });
  const plan = fixturePlan(parent, 'decompose');
  return { ...params, expected_transaction_revision: parent.revision, children, plan: { ...plan,
    criterion_responsibilities: children.flatMap(child => parent.acceptance_criteria.map((_, criterion_index) => ({ criterion: { transaction_id: 'self', criterion_index }, evidence_provider: child.key, validated_by: 'orchestrator', applies_to: [child.key] }))),
  } };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-relations-'));
  // The runtime only ever reads the logger and `ctx.get()` from its context;
  // this stub stands in for the Cordis context these mechanism tests never load.
  const ctx: Context = fromAny({ logger: { warn() {}, error() {}, info() {} }, get() {} });
  const runtime = new ClusterRuntime(ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off',},
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  let commandId = 0;
  function cluster() {
    const id = runtime.start({
      objective: 'check transaction relationships', workspace: dir, capabilities: ['fs_read'],
      budget: { tool_calls: 3000, agents: 64, max_active_agents: 4, wall_time_ms: 3_600_000 },
    }).cluster.id;
    const node = must(runtime.store.listNodes(id, { parent_id: null })[0], 'root node');
    const agent = must(runtime.store.listAgents(id, { node_id: node.id, role: 'orchestrator' })[0], 'orchestrator');
    const actor: FlowAgentActor = { cluster_id: id, node_id: node.id, agent_id: agent.id, session_id: agent.session_id, role: 'orchestrator' };
    const send = (action: string, params: Record<string, unknown>): FlowJsonValue => runtime.command(actor, {
      command_id: `relationships-${++commandId}`, action, params: relationParams(runtime, actor, action, params),
    }).result;
    return { id, node, actor, send, root: must(runtime.store.rootTransactions(id)[0], 'root transaction') };
  }
  return { runtime, cluster };
}

test('transaction creation refuses missing, foreign and already-completed parents without partial state', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const foreign = cluster();
  const before = runtime.store.countTransactions(local.id);
  for (const parent_transaction_id of ['missing', foreign.root.id]) {
    assert.throws(() => local.send('create_transaction', { objective: 'child', parent_transaction_id }),
      error => rejectionStatus(error) === 403 || rejectionStatus(error) === 404);
  }
  runtime.store.updateTransaction(local.root.id, { status: 'ACCEPTED' });
  assert.throws(() => local.send('create_transaction', { objective: 'child', parent_transaction_id: local.root.id }), /ACCEPTED/);
  assert.equal(runtime.store.countTransactions(local.id), before);
});

test('decomposition rejects missing and foreign dependencies atomically', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const foreign = cluster();
  for (const dependency of ['missing', foreign.root.id]) {
    const beforeCount = runtime.store.countTransactions(local.id);
    const beforeBudgetCount = runtime.store.listBudgets(local.id).length;
    const beforeSeq = runtime.store.latestEventSeq(local.id);
    assert.throws(() => local.send('decompose', {
      transaction_id: local.root.id,
      children: [{ objective: 'first' }, { objective: 'second', depends_on: [0, dependency] }],
    }), error => rejectionStatus(error) === 403 || rejectionStatus(error) === 404);
    assert.equal(runtime.store.countTransactions(local.id), beforeCount);
    assert.equal(runtime.store.listBudgets(local.id).length, beforeBudgetCount);
    assert.equal(runtime.store.latestEventSeq(local.id), beforeSeq);
    assert.deepEqual(runtime.store.allDependencies(local.id), []);
  }
});

test('decomposition and explicit dependency changes retain shared cycle checks and valid child ordering', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const created = listField(jsonRecord(local.send('decompose', {
    transaction_id: local.root.id,
    children: [{ objective: 'first' }, { objective: 'second', depends_on: [0] }, { objective: 'third', after: [1] }],
  }), 'decompose').children, 'children').map(child => textField(jsonRecord(child, 'child').transaction_id, 'transaction_id'));
  assert.deepEqual(runtime.store.dependenciesOf(must(created[1], 'second child')), [must(created[0], 'first child')]);
  assert.deepEqual(runtime.store.dependenciesOf(must(created[2], 'third child')), [must(created[1], 'second child')]);
  assert.throws(() => local.send('set_dependency', { transaction_id: created[0], depends_on: [created[2]] }), /cycle/i);
  assert.deepEqual(runtime.store.dependenciesOf(must(created[0], 'first child')), []);
  const before = runtime.store.countTransactions(local.id);
  runtime.store.updateTransaction(local.root.id, { status: 'DRAFT', __bump_revision: false });
  assert.throws(() => local.send('decompose', {
    transaction_id: local.root.id,
    children: [{ objective: 'first cyclic child', after: [1] }, { objective: 'second cyclic child', after: [0] }],
  }), /cycle/i);
  assert.equal(runtime.store.countTransactions(local.id), before);
});

test('command retries recover their receipt after the original expected cluster revision advances', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const agent = must(runtime.store.listAgents(local.id, { node_id: local.node.id, role: 'allocator' })[0], 'allocator');
  const actor: FlowAgentActor = { cluster_id: local.id, node_id: local.node.id, agent_id: agent.id, session_id: agent.session_id, role: 'allocator' };
  const command = {
    command_id: 'revision-retry', action: 'set_concurrency', params: { max_active_agents: 1 },
    expected_revision: must(runtime.store.getCluster(local.id), 'cluster').revision,
  };
  const first = runtime.command(actor, command);
  const afterFirst = must(runtime.store.getCluster(local.id), 'cluster').revision;
  assert.ok(afterFirst > command.expected_revision);
  const replay = runtime.command(actor, command);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(must(runtime.store.getCluster(local.id), 'cluster').revision, afterFirst);
  assert.throws(() => runtime.command(actor, { ...command, command_id: 'new-stale-command' }), /revision conflict/);
  assert.equal(runtime.store.findCommand('new-stale-command'), null);
});

