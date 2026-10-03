import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ClusterStore } from '../../packages/dsh-flow/src/core/store.ts';
import { communicate } from '../../packages/dsh-flow/src/core/communication.ts';
import type {
  CommunicationActor,
  CommunicationNotice,
  CommunicationQueryResult,
  CommunicationResult,
  CommunicationSendResult,
  CommunicationSubscriptionResult,
  CommunicateOptions,
} from '../../packages/dsh-flow/src/core/communication.ts';
import type { ClusterRecord } from '../../packages/dsh-flow/src/core/model.ts';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

/** The send/multicast answer, which carries the recipients this call delivered. */
function sendOf(result: CommunicationResult): CommunicationSendResult {
  if ('recipients' in result) return result;
  throw new Error('expected a send result');
}

/** The blackboard query answer. */
function queryOf(result: CommunicationResult): CommunicationQueryResult {
  if ('entries' in result) return result;
  throw new Error('expected a query result');
}

/** The subscribe answer, which carries the snapshot and its cursor. */
function subscriptionOf(result: CommunicationResult): CommunicationSubscriptionResult {
  if ('subscription' in result) return result;
  throw new Error('expected a subscription result');
}

function fixture(t: TestContext) {
  const store = new ClusterStore(':memory:');
  t.after(() => store.close());
  const cluster = must(store.createCluster({
    id: 'cluster-a', objective: 'fixture', workspace: '/tmp/ws', capabilities: [], limits: {}, budget: {},
  }, {}), 'cluster');
  const actor: CommunicationActor = { cluster_id: cluster.id, agent_id: 'sender', node_id: 'node-a', role: 'worker' };
  const agents: Array<[string, string]> = [['sender', cluster.id], ['receiver', cluster.id], ['other', 'cluster-b']];
  for (const [id, cluster_id] of agents) {
    store.insertAgent({ id, cluster_id, node_id: 'node-a', role: 'worker', session_id: id, status: 'READY' });
  }
  const call = (action: string, params: Record<string, unknown>, options: CommunicateOptions = {}): CommunicationResult =>
    communicate(store, cluster, actor, action, params, options);
  return { store, cluster, actor, call };
}

test('message identity cannot replay another cluster, sender, kind or content', t => {
  const { store, cluster, actor, call } = fixture(t);
  const foreign = must(store.createCluster({
    id: 'cluster-b', objective: 'foreign', workspace: '/tmp/ws', capabilities: [], limits: {}, budget: {},
  }, {}), 'foreign cluster');
  call('send', { agent: 'receiver', message_id: 'same', content: { a: 1, b: 2 } });
  assert.equal(sendOf(call('send', { agent: 'receiver', message_id: 'same', content: { b: 2, a: 1 } })).deduped, true);
  const replays: Array<[ClusterRecord, CommunicationActor, string, Record<string, unknown>]> = [
    [foreign, { cluster_id: 'cluster-b', agent_id: 'other', node_id: 'node-a', role: 'worker' }, 'send', { agent: 'other', content: { a: 1, b: 2 } }],
    [cluster, { ...actor, agent_id: 'receiver' }, 'send', { agent: 'receiver', content: { a: 1, b: 2 } }],
    [cluster, actor, 'multicast', { agent: 'receiver', content: { a: 1, b: 2 } }],
    [cluster, actor, 'send', { agent: 'receiver', content: 'changed' }],
  ];
  for (const [c, a, action, params] of replays) {
    assert.throws(() => communicate(store, c, a, action, { ...params, message_id: 'same' }),
      error => rejectionStatus(error) === 409);
  }
  assert.equal(store.pendingDeliveries('other').length, 0);
  assert.equal(store.pendingDeliveries('receiver').length, 1);
});

test('communication owns atomic delivery and notification persistence', t => {
  const { store, call } = fixture(t);
  assert.throws(() => call('send', { agent: 'receiver', message_id: 'rollback', content: 'hi' }, {
    notify() { throw new Error('notification persistence failed'); },
  }), /notification persistence failed/);
  assert.equal(store.getMessage('rollback'), null);
  assert.equal(store.pendingDeliveries('receiver').length, 0);
  assert.equal(store.counter('recipient:receiver'), 0);
});

test('repaired recipients receive notification through the same delivery path', t => {
  const { store, call } = fixture(t);
  store.insertMessage({ id: 'repair', cluster_id: 'cluster-a', from_agent: 'sender', from_node: 'node-a', kind: 'direct', content: { text: 'hi' } });
  const notifications: Array<[string, CommunicationNotice]> = [];
  const result = call('send', { agent: 'receiver', message_id: 'repair', content: 'hi' },
    { notify: (recipient, notice) => { notifications.push([recipient, notice]); } });
  assert.equal(sendOf(result).deduped, true);
  assert.equal(sendOf(result).recipients.length, 1);
  assert.equal(notifications.length, 1);
});

test('blackboard prefix and exact subscriptions share literal case-sensitive matching', t => {
  const { call } = fixture(t);
  for (const key of ['plan/a', 'plan/ab', 'Plan/a', 'x_y/z', 'xay/z', 'x%y/z', 'x\\y/z']) call('publish', { key, value: key });
  assert.deepEqual((subscriptionOf(call('subscribe', { key: 'plan/a' })).snapshot ?? []).map(x => x.key), ['plan/a']);
  assert.deepEqual((subscriptionOf(call('subscribe', { prefix: 'plan/' })).snapshot ?? []).map(x => x.key), ['plan/a', 'plan/ab']);
  for (const prefix of ['x_y/', 'x%y/', 'x\\y/']) {
    assert.deepEqual(queryOf(call('query', { prefix })).entries.map(x => x.key), [`${prefix}z`]);
    assert.deepEqual((subscriptionOf(call('subscribe', { prefix })).snapshot ?? []).map(x => x.key), [`${prefix}z`]);
  }
});


test('communication rolls back a failed group even when an outer caller catches it', t => {
  const { store, call } = fixture(t);
  store.tx(() => {
    assert.throws(() => call('group', { operation: 'create', name: 'atomic', members: ['receiver', 'missing'] }), /Unknown group member/);
    call('publish', { key: 'outer-survived', value: true });
  });
  assert.equal(store.groupByName('cluster-a', 'atomic'), null);
  assert.equal(store.all('SELECT * FROM group_members').length, 0);
  assert.equal(queryOf(call('query', { key: 'outer-survived' })).entries.length, 1);
});

test('snapshot matching agrees with later subscription notifications', t => {
  const { call } = fixture(t);
  const seen: Array<[string, CommunicationNotice]> = [];
  call('subscribe', { key: 'plan/a' });
  call('publish', { key: 'plan/ab', value: 1 }, { notify: (recipient, notice) => { seen.push([recipient, notice]); } });
  call('publish', { key: 'Plan/a', value: 2 }, { notify: (recipient, notice) => { seen.push([recipient, notice]); } });
  assert.equal(seen.length, 0);
  call('publish', { key: 'plan/a', value: 3 }, { notify: (recipient, notice) => { seen.push([recipient, notice]); } });
  assert.equal(seen.length, 1);
  call('subscribe', { prefix: 'x_y/' });
  call('publish', { key: 'xay/z', value: 4 }, { notify: (recipient, notice) => { seen.push([recipient, notice]); } });
  assert.equal(seen.length, 1);
  call('publish', { key: 'x_y/z', value: 5 }, { notify: (recipient, notice) => { seen.push([recipient, notice]); } });
  assert.equal(seen.length, 2);
});