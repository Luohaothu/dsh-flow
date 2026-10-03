import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterStore } from '../../src/adapter/store.js';
import { communicate } from '../../src/adapter/communication.js';

function fixture(t) {
  const store = new ClusterStore(':memory:');
  t.after(() => store.close());
  const cluster = { id: 'cluster-a' };
  const actor = { agent_id: 'sender', node_id: 'node-a' };
  for (const [id, cluster_id] of [['sender', cluster.id], ['receiver', cluster.id], ['other', 'cluster-b']]) {
    store.insertAgent({ id, cluster_id, node_id: 'node-a', role: 'worker', session_id: id, status: 'READY' });
  }
  const call = (action, params, options) => communicate(store, cluster, actor, action, params, options);
  return { store, cluster, actor, call };
}

test('message identity cannot replay another cluster, sender, kind or content', t => {
  const { store, cluster, actor, call } = fixture(t);
  call('send', { agent: 'receiver', message_id: 'same', content: { a: 1, b: 2 } });
  assert.equal(call('send', { agent: 'receiver', message_id: 'same', content: { b: 2, a: 1 } }).deduped, true);
  for (const [c, a, action, params] of [
    [{ id: 'cluster-b' }, { agent_id: 'other', node_id: 'node-a' }, 'send', { agent: 'other', content: { a: 1, b: 2 } }],
    [cluster, { ...actor, agent_id: 'receiver' }, 'send', { agent: 'receiver', content: { a: 1, b: 2 } }],
    [cluster, actor, 'multicast', { agent: 'receiver', content: { a: 1, b: 2 } }],
    [cluster, actor, 'send', { agent: 'receiver', content: 'changed' }],
  ]) {
    assert.throws(() => communicate(store, c, a, action, { ...params, message_id: 'same' }), error => error.status === 409);
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
  const notifications = [];
  const result = call('send', { agent: 'receiver', message_id: 'repair', content: 'hi' }, { notify: (...args) => notifications.push(args) });
  assert.equal(result.deduped, true);
  assert.equal(result.recipients.length, 1);
  assert.equal(notifications.length, 1);
});

test('blackboard prefix and exact subscriptions share literal case-sensitive matching', t => {
  const { call } = fixture(t);
  for (const key of ['plan/a', 'plan/ab', 'Plan/a', 'x_y/z', 'xay/z', 'x%y/z', 'x\\y/z']) call('publish', { key, value: key });
  assert.deepEqual(call('subscribe', { key: 'plan/a' }).snapshot.map(x => x.key), ['plan/a']);
  assert.deepEqual(call('subscribe', { prefix: 'plan/' }).snapshot.map(x => x.key), ['plan/a', 'plan/ab']);
  for (const prefix of ['x_y/', 'x%y/', 'x\\y/']) {
    assert.deepEqual(call('query', { prefix }).entries.map(x => x.key), [`${prefix}z`]);
    assert.deepEqual(call('subscribe', { prefix }).snapshot.map(x => x.key), [`${prefix}z`]);
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
  assert.equal(call('query', { key: 'outer-survived' }).entries.length, 1);
});

test('snapshot matching agrees with later subscription notifications', t => {
  const { call } = fixture(t);
  const seen = [];
  call('subscribe', { key: 'plan/a' });
  call('publish', { key: 'plan/ab', value: 1 }, { notify: (...args) => seen.push(args) });
  call('publish', { key: 'Plan/a', value: 2 }, { notify: (...args) => seen.push(args) });
  assert.equal(seen.length, 0);
  call('publish', { key: 'plan/a', value: 3 }, { notify: (...args) => seen.push(args) });
  assert.equal(seen.length, 1);
  call('subscribe', { prefix: 'x_y/' });
  call('publish', { key: 'xay/z', value: 4 }, { notify: (...args) => seen.push(args) });
  assert.equal(seen.length, 1);
  call('publish', { key: 'x_y/z', value: 5 }, { notify: (...args) => seen.push(args) });
  assert.equal(seen.length, 2);
});
