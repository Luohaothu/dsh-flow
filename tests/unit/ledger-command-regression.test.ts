import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fromAny } from '@total-typescript/shoehorn';

import { ClusterStore } from '../../packages/dsh-flow/src/core/store.ts';
import {
  createBudget, reserveChain, settleChain, releaseChain, spendChain, transferBudget,
} from '../../packages/dsh-flow/src/core/budget.ts';
import type { BudgetPatch, BudgetRecord, FlowAgentActor, FlowUserActor } from '../../packages/dsh-flow/src/core/model.ts';

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

function fixture(t: TestContext) {
  const store = new ClusterStore(':memory:');
  t.after(() => store.close());
  const budget = (id: string, limit = 100, cluster = 'cluster'): BudgetRecord => createBudget(store, {
    cluster_id: cluster, scope_kind: 'node', scope_id: id, limit: { tokens: limit },
  });
  return { store, budget };
}

test('nested transaction failure rolls back only its work even when its caller catches it', t => {
  const { store } = fixture(t);
  store.tx(() => {
    store.appendEvent('cluster', 'before');
    assert.throws(() => store.tx(() => {
      store.appendEvent('cluster', 'must-rollback');
      throw new Error('nested failure');
    }), /nested failure/);
    assert.equal(store.inTransaction, true);
    store.appendEvent('cluster', 'after');
  });
  assert.equal(store.inTransaction, false);
  assert.deepEqual(store.readEvents('cluster').map(event => event.type), ['before', 'after']);
  assert.throws(() => store.tx(() => {
    store.tx(() => store.appendEvent('cluster', 'inner-success'));
    throw new Error('outer failure');
  }), /outer failure/);
  assert.deepEqual(store.readEvents('cluster').map(event => event.type), ['before', 'after']);
});

test('command receipt owns atomicity and binds replay to its cluster and authenticated actor', t => {
  const { store } = fixture(t);
  const actor: FlowAgentActor = { role: 'orchestrator', cluster_id: 'cluster', agent_id: 'agent', node_id: 'node', session_id: 'session', epoch: 1 };
  const command = {
    cluster_id: 'cluster', command_id: 'command', actor, action: 'create_transaction',
    params: { objective: 'task' }, expected_revision: undefined,
  };
  let calls = 0;
  const apply = (): { revision: number; transaction_id: string } => {
    calls += 1;
    store.appendEvent('cluster', 'applied');
    return { revision: 1, transaction_id: 'transaction' };
  };
  const first = store.runCommand(command, apply);
  const replay = store.runCommand({ ...command, actor: { ...actor, epoch: 2 } }, apply);
  assert.equal(first.deduped, false);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.result, first.result);
  const changes: Array<{ cluster_id?: string; actor?: FlowAgentActor }> = [
    { cluster_id: 'other-cluster' },
    { actor: { ...actor, agent_id: 'other-agent' } },
    { actor: { ...actor, node_id: 'other-node' } },
    { actor: { ...actor, role: 'allocator' } },
  ];
  for (const changed of changes) {
    assert.throws(() => store.runCommand({ ...command, ...changed }, apply), /another cluster or actor/);
  }
  assert.throws(() => store.runCommand({ ...command, params: { objective: 'changed' } }, apply), /different payload/);
  assert.equal(calls, 1);
  assert.equal(store.readEvents('cluster').length, 1);

  assert.throws(() => store.runCommand({ ...command, command_id: 'failed' }, () => {
    store.appendEvent('cluster', 'must-rollback');
    throw new Error('handler failed');
  }), /handler failed/);
  assert.equal(store.findCommand('failed'), null);
  assert.deepEqual(store.readEvents('cluster').map(event => event.type), ['applied']);
});

test('ledger refuses duplicate scope ids before any reservation or settlement', t => {
  const { store, budget } = fixture(t);
  const row = budget('payer');
  assert.throws(() => reserveChain(store, [row.id, row.id], { tokens: 60 }), /Duplicate budget scope/);
  assert.equal(must(store.getBudget(row.id), 'budget row').tokens_reserved, 0);
  reserveChain(store, [row.id], { tokens: 60 });
  assert.throws(() => settleChain(store, [row.id, row.id], {
    reservedAmounts: { tokens: 20 }, consumed: { tokens: 20 },
  }), /Duplicate budget scope/);
  assert.equal(must(store.getBudget(row.id), 'budget row').tokens_reserved, 60);
  assert.equal(must(store.getBudget(row.id), 'budget row').tokens_spent, 0);
});

test('ledger settlement and release roll back all scopes on underflow, including inside a caught nested failure', t => {
  const { store, budget } = fixture(t);
  const first = budget('first');
  const second = budget('second');
  reserveChain(store, [first.id], { tokens: 20 });
  reserveChain(store, [second.id], { tokens: 10 });
  const before = store.listBudgets('cluster');
  const settle = () => settleChain(store, [first.id, second.id], {
    reservedAmounts: { tokens: 20 }, consumed: { tokens: 15 },
  });
  assert.throws(settle, /go negative/);
  assert.deepEqual(store.listBudgets('cluster'), before);
  store.tx(() => {
    assert.throws(settle, /go negative/);
    assert.throws(() => releaseChain(store, [first.id, second.id], { tokens: 20 }), /go negative/);
    store.appendEvent('cluster', 'continued');
  });
  assert.deepEqual(store.listBudgets('cluster'), before);
  assert.equal(must(store.readEvents('cluster')[0], 'event').type, 'continued');
});

test('ledger rejects invalid numeric and unknown dimensions consistently', t => {
  const { store, budget } = fixture(t);
  const first = budget('first');
  const second = budget('second');
  const operations: Array<(amounts: Record<string, unknown>) => unknown> = [
    amounts => reserveChain(store, [first.id], amounts),
    amounts => settleChain(store, [first.id], { reservedAmounts: amounts }),
    amounts => releaseChain(store, [first.id], amounts),
    amounts => spendChain(store, [first.id], amounts),
    amounts => transferBudget(store, first.id, second.id, amounts),
  ];
  const before = store.listBudgets('cluster');
  for (const apply of operations) {
    for (const tokens of [-1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => apply({ tokens }), /Invalid/);
    }
    assert.throws(() => apply({ token: 1 }), /Unknown budget dimension/);
  }
  assert.deepEqual(store.listBudgets('cluster'), before);
});

test('transfers own atomicity when the recipient write fails and cannot cross clusters', t => {
  const { store, budget } = fixture(t);
  const first = budget('first');
  const second = budget('second');
  const foreign = budget('foreign', 100, 'foreign-cluster');
  const before = store.listBudgets('cluster');
  const original = store.updateBudget.bind(store);
  store.updateBudget = (id: string, patch: BudgetPatch): BudgetRecord | null => {
    if (id === second.id) throw new Error('recipient write failed');
    return original(id, patch);
  };
  assert.throws(() => transferBudget(store, first.id, second.id, { tokens: 20 }), /recipient write failed/);
  assert.deepEqual(store.listBudgets('cluster'), before);
  assert.throws(() => transferBudget(store, first.id, foreign.id, { tokens: 20 }), /between clusters/);
  assert.deepEqual(store.listBudgets('cluster'), before);
});

test('ledger permits honest overshoot but rejects accounting overflow and missing scopes atomically', t => {
  const { store, budget } = fixture(t);
  const first = budget('first');
  reserveChain(store, [first.id], { tokens: 20 });
  settleChain(store, [first.id], { reservedAmounts: { tokens: 20 }, consumed: { tokens: 120 } });
  assert.equal(must(store.getBudget(first.id), 'budget row').tokens_spent, 120);
  assert.equal(must(store.getBudget(first.id), 'budget row').tokens_reserved, 0);
  const before = store.getBudget(first.id);
  assert.throws(() => spendChain(store, [first.id], { tokens: Number.MAX_SAFE_INTEGER }), /safe integer range/);
  assert.throws(() => spendChain(store, [first.id, 'missing'], { tokens: 1 }), /Budget not found/);
  assert.deepEqual(store.getBudget(first.id), before);
});

test('store refuses asynchronous callbacks before execution and rolls back promise-returning callbacks', async t => {
  const { store } = fixture(t);
  let started = false;
  assert.throws(() => store.tx(async () => {
    started = true;
    await Promise.resolve();
    store.appendEvent('cluster', 'async-write');
  }), /must be synchronous/);
  assert.equal(started, false);
  assert.throws(() => store.tx(() => {
    store.appendEvent('cluster', 'must-rollback');
    return Promise.reject(new Error('async failure'));
  }), /must be synchronous/);
  const actor: FlowUserActor = { role: 'user', cluster_id: 'cluster' };
  const command = {
    cluster_id: 'cluster', command_id: 'async', actor,
    action: 'test', params: {}, expected_revision: undefined,
  };
  // The apply slot is declared synchronous; these two deliberately wrong values
  // prove the store refuses an async callback before it runs and a promise
  // returned from a synchronous one.
  assert.throws(() => store.runCommand(command, fromAny(async () => { started = true; })), /must be synchronous/);
  assert.throws(() => store.runCommand(command, fromAny(() => {
    store.appendEvent('cluster', 'promise-command');
    return Promise.resolve({ done: true });
  })), /must be synchronous/);
  await Promise.resolve();
  assert.equal(started, false);
  assert.equal(store.findCommand('async'), null);
  assert.deepEqual(store.readEvents('cluster'), []);
});