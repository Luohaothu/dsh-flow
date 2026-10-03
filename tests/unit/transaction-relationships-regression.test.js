import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClusterRuntime } from '../../src/adapter/cluster.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-relations-'));
  const runtime = new ClusterRuntime({ logger: { warn() {}, error() {}, info() {} }, get() {} }, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    model: { provider: 'local-sglang', model: 'Qwen3.8-7B', reasoningEffort: 'off', maxTokens: 512 },
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  let commandId = 0;
  function cluster() {
    const id = runtime.start({
      objective: 'check transaction relationships', workspace: dir, capabilities: ['fs_read'],
      budget: { tokens: 2_000_000, model_requests: 3000, tool_calls: 3000, agents: 64, max_active_agents: 4, wall_time_ms: 3_600_000 },
    }).cluster.id;
    const node = runtime.store.listNodes(id, { parent_id: null })[0];
    const agent = runtime.store.listAgents(id, { node_id: node.id, role: 'orchestrator' })[0];
    const actor = { cluster_id: id, node_id: node.id, agent_id: agent.id, role: 'orchestrator' };
    const send = (action, params) => runtime.command(actor, {
      command_id: `relationships-${++commandId}`, action, params,
    }).result;
    return { id, node, actor, send, root: runtime.store.rootTransactions(id)[0] };
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
      error => error.status === 403 || error.status === 404);
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
    }), error => error.status === 403 || error.status === 404);
    assert.equal(runtime.store.countTransactions(local.id), beforeCount);
    assert.equal(runtime.store.listBudgets(local.id).length, beforeBudgetCount);
    assert.equal(runtime.store.latestEventSeq(local.id), beforeSeq);
    assert.deepEqual(runtime.store.allDependencies(local.id), []);
  }
});

test('decomposition and explicit dependency changes retain shared cycle checks and valid child ordering', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const created = local.send('decompose', {
    transaction_id: local.root.id,
    children: [{ objective: 'first' }, { objective: 'second', depends_on: [0] }, { objective: 'third', after: [1] }],
  }).children.map(child => child.transaction_id);
  assert.deepEqual(runtime.store.dependenciesOf(created[1]), [created[0]]);
  assert.deepEqual(runtime.store.dependenciesOf(created[2]), [created[1]]);
  assert.throws(() => local.send('set_dependency', { transaction_id: created[0], depends_on: [created[2]] }), /cycle/i);
  assert.deepEqual(runtime.store.dependenciesOf(created[0]), []);
  const before = runtime.store.countTransactions(local.id);
  assert.throws(() => local.send('decompose', {
    transaction_id: local.root.id,
    children: [{ objective: 'first cyclic child', after: [1] }, { objective: 'second cyclic child', after: [0] }],
  }), /cycle/i);
  assert.equal(runtime.store.countTransactions(local.id), before);
});

test('command retries recover their receipt after the original expected cluster revision advances', t => {
  const { runtime, cluster } = fixture(t);
  const local = cluster();
  const agent = runtime.store.listAgents(local.id, { node_id: local.node.id, role: 'allocator' })[0];
  const actor = { cluster_id: local.id, node_id: local.node.id, agent_id: agent.id, role: 'allocator' };
  const command = {
    command_id: 'revision-retry', action: 'set_concurrency', params: { max_active_agents: 1 },
    expected_revision: runtime.store.getCluster(local.id).revision,
  };
  const first = runtime.command(actor, command);
  const afterFirst = runtime.store.getCluster(local.id).revision;
  assert.ok(afterFirst > command.expected_revision);
  const replay = runtime.command(actor, command);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(runtime.store.getCluster(local.id).revision, afterFirst);
  assert.throws(() => runtime.command(actor, { ...command, command_id: 'new-stale-command' }), /revision conflict/);
  assert.equal(runtime.store.findCommand('new-stale-command'), null);
});
