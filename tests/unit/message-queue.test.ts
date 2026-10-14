import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue } from '../../packages/dsh-flow/src/core/message-queue.ts';
import type { FlowMessage } from '../../packages/dsh-flow/src/types.ts';

function message(id: string, to = 'recipient'): FlowMessage {
  return { id, team_id: 'team', from_session_id: 'sender', to_session_id: to,
    task_id: null, content: id, mode: 'request', state: 'queued', created: 1, delivered_at: null };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture(pending: FlowMessage[]) {
  const received: string[] = [], errors: unknown[] = [];
  const queue = new MessageQueue({ pending: () => pending,
    acknowledge: input => { received.push(input.id); }, onError: error => { errors.push(error); } });
  return { queue, received, errors };
}

test('submission completes while the receiver callback is still pending', async t => {
  const input = message('first'), hold = gate(), f = fixture([input]);
  t.after(async () => { hold.release(); await f.queue.dispose(); });
  let started = false;
  f.queue.listen('recipient', async () => { started = true; await hold.promise; });
  await f.queue.submit(input);
  await turn();
  assert.equal(started, true);
  assert.deepEqual(f.received, []);
  hold.release();
  await turn();
  assert.deepEqual(f.received, ['first']);
  assert.equal(input.state, 'queued', 'handoff does not claim native conversation delivery');
});

test('messages without a listener remain pending until registration', async t => {
  const input = message('first'), f = fixture([input]);
  t.after(() => f.queue.dispose());
  await f.queue.submit(input);
  await turn();
  assert.deepEqual(f.received, []);
  const seen: string[] = [];
  f.queue.listen('recipient', async input => { seen.push(input.id); });
  await turn();
  assert.deepEqual(seen, ['first']);
  assert.deepEqual(f.received, ['first']);
});

test('one address receives in order while other addresses proceed independently', async t => {
  const f = fixture([message('a1', 'a'), message('a2', 'a'), message('b1', 'b')]), hold = gate();
  t.after(async () => { hold.release(); await f.queue.dispose(); });
  const seen: string[] = [];
  f.queue.listen('a', async input => { seen.push(input.id); if (input.id === 'a1') await hold.promise; });
  f.queue.listen('b', async input => { seen.push(input.id); });
  await turn();
  assert.deepEqual(seen, ['a1', 'b1']);
  hold.release();
  await turn();
  assert.deepEqual(seen, ['a1', 'b1', 'a2']);
  f.queue.wake(); await turn();
  assert.deepEqual(seen, ['a1', 'b1', 'a2'], 'accepted ids are not handed off a second time');
});

test('failed handoff waits for another wake and preserves recipient order', async t => {
  const f = fixture([message('first'), message('second')]);
  t.after(() => f.queue.dispose());
  let attempts = 0;
  const seen: string[] = [];
  f.queue.listen('recipient', async input => {
    seen.push(input.id);
    if (++attempts === 1) throw new Error('receiver could not persist acceptance');
  });
  await turn(); await turn();
  assert.deepEqual(seen, ['first']);
  assert.equal(f.errors.length, 1);
  f.queue.wake(); await turn();
  assert.deepEqual(seen, ['first', 'first', 'second']);
  assert.deepEqual(f.received, ['first', 'second']);
});

test('listener registration identity protects replacement and cancellation', async t => {
  const input = message('first'), pending = [input], f = fixture(pending), seen: string[] = [];
  t.after(() => f.queue.dispose());
  const old = f.queue.listen('recipient', async () => { seen.push('old'); });
  f.queue.listen('recipient', async () => { seen.push('new'); });
  old();
  await turn();
  assert.deepEqual(seen, ['new']);
  const cancelled = message('cancelled', 'other');
  pending.push(cancelled);
  const unsubscribe = f.queue.listen('other', async () => { seen.push('cancelled'); });
  await f.queue.submit(cancelled); unsubscribe();
  await turn();
  assert.deepEqual(seen, ['new']);
});

test('a wake during a handoff does not lose newly persisted messages', async t => {
  const pending = [message('first')], f = fixture(pending), hold = gate(), seen: string[] = [];
  t.after(async () => { hold.release(); await f.queue.dispose(); });
  f.queue.listen('recipient', async input => { seen.push(input.id); if (input.id === 'first') await hold.promise; });
  await turn();
  const second = message('second'); pending.push(second);
  await f.queue.submit(second); await turn();
  assert.deepEqual(seen, ['first']);
  hold.release(); await turn();
  assert.deepEqual(seen, ['first', 'second']);
});

test('persistent acknowledgement retries without repeating an accepted callback', async t => {
  const input = message('first'), errors: unknown[] = [];
  let callbacks = 0, attempts = 0;
  const queue = new MessageQueue({ pending: () => [input],
    acknowledge: () => { if (++attempts === 1) throw new Error('transaction failed'); },
    onError: error => { errors.push(error); } });
  t.after(() => queue.dispose());
  queue.listen('recipient', async () => { callbacks++; });
  await turn(); await turn();
  assert.equal(callbacks, 1); assert.equal(attempts, 1);
  queue.wake(); await turn();
  assert.equal(callbacks, 1); assert.equal(attempts, 2); assert.equal(errors.length, 1);
});

test('dispose waits for an active handoff and prevents starting another callback', async () => {
  const f = fixture([message('first'), message('second')]), hold = gate(), seen: string[] = [];
  f.queue.listen('recipient', async input => { seen.push(input.id); await hold.promise; });
  await turn();
  let disposed = false;
  const disposal = f.queue.dispose().then(() => { disposed = true; });
  await turn(); assert.equal(disposed, false);
  hold.release(); await disposal;
  f.queue.wake(); await turn();
  assert.deepEqual(seen, ['first']);
  assert.deepEqual(f.received, ['first']);
  await assert.rejects(f.queue.submit(message('later')), /disposed/);
});
