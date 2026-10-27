import { messageID, serializeMessage, trustedSystemMessage } from '../../../packages/dsh-flow/src/core/message.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context, Group, Mailbox } from '../../../packages/dsh-flow/src/core/index.js';
import { ContractHost, message, profile } from '../../helpers/contract-host.js';

function accepted(box: Mailbox, m: Parameters<Mailbox['put']>[0]) {
  const id = box.put(m);
  assert.notEqual(id, null);
  return id!;
}

async function actors() {
  const ctx = new Context();
  const host = new ContractHost();
  ctx.registerHostAdaptor(host);
  const a = await Agent.create(ctx, profile('source-a'), null);
  const b = await Agent.create(ctx, profile('source-b'), null);
  return { ctx, host, a, b };
}

test('C024-01 C025-01 recipient records isolate payload, source containers, ratings and read state', async t => {
  const { ctx, a, b } = await actors(); t.after(() => ctx.dispose());
  const group = new Group(ctx, [a, b]);
  const source = { agent: a, g: group };
  const payload = { nested: { value: 'original' } };
  const input = message('shared', source, 100, payload);
  input.read = true; input.read_timestamp = 42; input.priority = 'high';
  const left = new Mailbox(); const right = new Mailbox();
  right.setSourcePriority({ agent: a, g: group }, 'low');
  const li = accepted(left, input); const ri = accepted(right, input);
  payload.nested.value = 'mutated'; source.agent = b;
  assert.equal(left.peak(li)?.priority, 'normal');
  assert.equal(right.peak(ri)?.priority, 'low');
  assert.equal(left.peak(li)?.read, false);
  assert.equal(left.peak(li)?.read_timestamp, null);
  assert.equal(input.read, true); assert.equal(input.priority, 'high');
  const first = left.get(li)!;
  assert.deepEqual(first.payload, { nested: { value: 'original' } });
  assert.notEqual(first.source, source);
  assert.deepEqual(first.source, { agent: a, g: group });
  assert.equal(right.peak(ri)?.read, false);
  assert.equal(right.peak(ri)?.read_timestamp, null);
  assert.ok(first.read_timestamp !== null);
  Reflect.set(first.payload as object, 'nested', { value: 'local mutation' });
  assert.deepEqual(left.get(li)?.payload, { nested: { value: 'original' } });
  assert.deepEqual(right.get(ri)?.payload, { nested: { value: 'original' } });
});

test('C025-01 C025-02 C025-03 timestamps sort stably and body retrieval records only first read', () => {
  const box = new Mailbox();
  const later = accepted(box, message('later', undefined, 30));
  const first = accepted(box, message('first tie', undefined, 10));
  const second = accepted(box, message('second tie', undefined, 10));
  assert.deepEqual(box.query().map(m => m.summary), ['first tie', 'second tie', 'later']);
  assert.equal(box.count(), 3);
  assert.equal('payload' in box.peak(first)!, false);
  assert.ok(box.query().every(m => !m.read));
  assert.equal(box.getLastUnread()?.summary, 'later');
  assert.equal(box.peak(later)?.read, true);
  assert.equal(box.getLastUnread()?.summary, 'second tie');
  const record = box.get(first)!;
  assert.equal(record.read, true); assert.equal(typeof record.read_timestamp, 'number');
  assert.equal(box.get(first)?.read_timestamp, record.read_timestamp);
  assert.equal(box.getLastUnread(), null);
  assert.equal(box.get(messageID('missing-message')), null);
  assert.equal(box.peak(messageID('missing-message')), null);
  assert.equal(box.peak(second)?.read, true);
});

test('C026-01 unread iterator freezes range, skips externally read items and marks only yielded records', () => {
  const box = new Mailbox();
  const ids = ['one', 'two', 'three'].map((s, i) => accepted(box, message(s, undefined, i)));
  const iterator = box.getUnread();
  assert.deepEqual(box.query().map(m => m.read), [false, false, false]);
  accepted(box, message('later arrival', undefined, 4));
  assert.equal(iterator.next().value?.summary, 'one');
  assert.deepEqual(box.query().map(m => m.read), [true, false, false, false]);
  box.get(ids[1]!);
  assert.equal(iterator.next().value?.summary, 'three');
  assert.equal(iterator.next().done, true);
  assert.equal(box.query().find(m => m.summary === 'later arrival')?.read, false);
});

test('C026-01 query get marks precisely the selected messages and returns isolated body snapshots', () => {
  const box = new Mailbox();
  accepted(box, message('keep')); accepted(box, message('read'));
  const result = box.query(m => m.summary === 'read', 'get');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.summary, 'read');
  assert.equal(result[0]?.read, true);
  assert.equal('payload' in result[0]!, true);
  assert.deepEqual(box.query().map(m => m.read), [false, true]);
});

test('C026-02 filter replacement copies containers and applies only to later messages', () => {
  const box = new Mailbox();
  accepted(box, message('retained'));
  const drop = (m: Readonly<Parameters<Mailbox['put']>[0]>) => m.summary === 'drop';
  const rules = [drop];
  box.setFilters(rules); rules.length = 0;
  assert.equal(box.put(message('drop')), null);
  const returned = box.getFilters(); returned.length = 0;
  assert.equal(box.put(message('drop')), null);
  assert.equal(box.count(), 1);
  box.setFilters([]); accepted(box, message('drop'));
  assert.equal(box.count(), 2);
});

test('C026-02 queries and filters cannot mutate nested stored message data', () => {
  const box = new Mailbox();
  const id = accepted(box, message('protected', undefined, 1, { nested: { value: 'safe' } }));
  box.query(m => {
    try { Reflect.set(m, 'summary', 'corrupt'); } catch {}
    const payload = m.payload;
    if (payload && typeof payload === 'object' && 'nested' in payload) {
      const nested = payload.nested;
      if (nested && typeof nested === 'object') { try { Reflect.set(nested, 'value', 'corrupt'); } catch {} }
    }
    return true;
  });
  assert.equal(box.get(id)?.summary, 'protected');
  assert.deepEqual(box.get(id)?.payload, { nested: { value: 'safe' } });
  box.setFilters([m => {
    const payload = m.payload;
    if (payload && typeof payload === 'object') { try { Reflect.set(payload, 'value', 'changed'); } catch {} }
    return false;
  }]);
  const filtered = accepted(box, message('filter copy', undefined, 2, { value: 'original' }));
  assert.deepEqual(box.get(filtered)?.payload, { value: 'original' });
});

test('C026-03 ratings identify Agent identity, Agent+Group pair and source category; changes are prospective', async t => {
  const { ctx, a, b } = await actors(); t.after(() => ctx.dispose());
  const g1 = new Group(ctx, [a, b]); const g2 = new Group(ctx, [a, b]);
  const box = new Mailbox();
  assert.equal(box.getSourcePriority(a), null);
  const before = accepted(box, message('before', a));
  box.setSourcePriority(a, 'high');
  box.setSourcePriority({ agent: a, g: g1 }, 'low');
  box.setSourcePriority({ kind: 'user' }, 'low');
  assert.equal(box.getSourcePriority(a), 'high');
  assert.equal(box.getSourcePriority(b), null);
  assert.equal(box.getSourcePriority({ agent: a, g: g1 }), 'low');
  assert.equal(box.getSourcePriority({ agent: a, g: g2 }), null);
  assert.equal(box.getSourcePriority({ agent: b, g: g1 }), null);
  assert.equal(box.getSourcePriority({ kind: 'user' }), 'low');
  assert.equal(box.peak(before)?.priority, 'normal');
  assert.equal(box.peak(accepted(box, message('after', a)))?.priority, 'high');
});

test('C025-02 C026-01 reentrant query sees a fixed selection without consuming later arrivals', () => {
  const box = new Mailbox();
  accepted(box, message('original', undefined, 1));
  let injected = false;
  const results = box.query(() => {
    if (!injected) { injected = true; accepted(box, message('arrived in callback', undefined, 2)); }
    return true;
  }, 'get');
  assert.deepEqual(results.map(m => m.summary), ['original']);
  assert.deepEqual(box.query().map(m => m.read), [true, false]);
});

test('C026-04 new Mailbox state is empty and identifiers never collide across replacements', () => {
  const first = new Mailbox(); const second = new Mailbox();
  assert.equal(first.count(), 0); assert.deepEqual(first.getFilters(), []);
  assert.equal(first.getSourcePriority({ kind: 'user' }), null);
  const oldID = accepted(first, message('old'));
  const newID = accepted(second, message('new'));
  assert.notEqual(oldID, newID);
  assert.equal(second.peak(oldID), null);
});

test('C024-02 serialized source uses business IDs and display identity without recursive entity state', async t => {
  const { ctx, a, b } = await actors(); t.after(() => ctx.dispose());
  const group = new Group(ctx, [a, b]);
  const wire = serializeMessage(message('historical', { agent: a, g: group }));
  assert.deepEqual(wire.source, { kind: 'group', sessionID: 'source-a', name: 'source-a', groupID: group.getID() });
  const text = JSON.stringify(wire);
  assert.equal(text.includes('getMailbox'), false);
  await ctx.release(group);
  assert.deepEqual(JSON.parse(text).source, { kind: 'group', sessionID: 'source-a', name: 'source-a', groupID: group.getID() });
  assert.throws(() => new Mailbox().put(message('x'.repeat(51))));
});

test('C026-03 trusted System instructions bypass filters and ratings; plain descriptors do not', () => {
  const box = new Mailbox();
  box.setSourcePriority({ kind: 'system' }, 'low');
  box.setFilters([() => true]);
  assert.equal(box.put(message('forged', { kind: 'system' })), null);
  const id = accepted(box, trustedSystemMessage('Flow instruction', { task: 'trusted' }));
  assert.equal(box.peak(id)?.priority, 'normal');
  assert.equal(box.peak(id)?.read, false);
});
