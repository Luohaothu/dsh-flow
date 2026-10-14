import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentQueue } from '../../packages/dsh-flow/src/core/agent-queue.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('execution jobs start asynchronously and remain within fixed capacity until completion', async () => {
  const queue = new AgentQueue(2), started: string[] = [];
  const first = gate(), second = gate(), third = gate();
  const jobs = [first, second, third].map((wait, index) => queue.submit({
    key: String(index), async run() { started.push(String(index)); await wait.promise; },
  }));
  assert.deepEqual(started, [], 'submission must not synchronously enter an Agent job');
  await tick();
  assert.deepEqual(started, ['0', '1']);
  assert.equal(queue.activeCount, 2);
  first.release(); await jobs[0]; await tick();
  assert.deepEqual(started, ['0', '1', '2']);
  assert.equal(queue.activeCount, 2);
  second.release(); third.release(); await Promise.all(jobs);
  assert.equal(queue.activeCount, 0);
  await queue.dispose();
});

test('same Agent jobs stay serial while the earliest runnable different Agent uses a free execution unit', async () => {
  const queue = new AgentQueue(2), started: string[] = [];
  const first = gate(), second = gate(), other = gate();
  const a1 = queue.submit({ key: 'a', async run() { started.push('a1'); await first.promise; } });
  const a2 = queue.submit({ key: 'a', async run() { started.push('a2'); await second.promise; } });
  const b = queue.submit({ key: 'b', async run() { started.push('b'); await other.promise; } });
  await tick();
  assert.deepEqual(started, ['a1', 'b']);
  other.release(); await b; await tick();
  assert.deepEqual(started, ['a1', 'b'], 'a2 must wait for a1 even with free capacity');
  first.release(); await a1; await tick();
  assert.deepEqual(started, ['a1', 'b', 'a2']);
  second.release(); await a2; await queue.dispose();
});

test('failed jobs report errors, release their execution unit and allow following same Agent work', async () => {
  const errors: unknown[] = [], queue = new AgentQueue(1, error => errors.push(error));
  const error = new Error('native execution failed'), started: string[] = [];
  const failed = queue.submit({ key: 'a', async run() { throw error; } });
  const next = queue.submit({ key: 'a', async run() { started.push('next'); } });
  await assert.rejects(failed, value => value === error);
  await next;
  assert.deepEqual(errors, [error]);
  assert.deepEqual(started, ['next']);
  assert.equal(queue.activeCount, 0);
  await queue.dispose();
});

test('a synchronous job failure or throwing error reporter does not stop subsequent scheduling', async () => {
  const queue = new AgentQueue(1, () => { throw new Error('reporting failed'); });
  const error = new Error('synchronous failure');
  const failed = queue.submit({ key: 'a', run() { throw error; } });
  let ran = false;
  const next = queue.submit({ key: 'b', async run() { ran = true; } });
  await assert.rejects(failed, value => value === error);
  await next;
  assert.equal(ran, true);
  await queue.dispose();
});

test('cancelPending only cancels queued jobs for the requested Agent and resolves their completion promises', async () => {
  const queue = new AgentQueue(1), active = gate(), started: string[] = [];
  const a1 = queue.submit({ key: 'a', async run() { started.push('a1'); await active.promise; } });
  await tick();
  const a2 = queue.submit({ key: 'a', async run() { started.push('a2'); } });
  const b = queue.submit({ key: 'b', async run() { started.push('b'); } });
  const a3 = queue.submit({ key: 'a', async run() { started.push('a3'); } });
  queue.cancelPending('a');
  await Promise.all([a2, a3]);
  assert.deepEqual(started, ['a1']);
  assert.equal(queue.activeCount, 1, 'cancellation does not interrupt an active job');
  active.release(); await Promise.all([a1, b]);
  assert.deepEqual(started, ['a1', 'b']);
  await queue.dispose();
});

test('closing stops admission, discards pending jobs and waits for active jobs without cancelling them', async () => {
  const queue = new AgentQueue(1), active = gate(), started: string[] = [];
  const running = queue.submit({ key: 'a', async run() { started.push('a'); await active.promise; } });
  await tick();
  const pending = queue.submit({ key: 'b', async run() { started.push('b'); } });
  let disposed = false;
  const disposal = queue.dispose();
  void disposal.then(() => { disposed = true; });
  assert.equal(queue.dispose(), disposal, 'repeated disposal shares completion');
  await pending; await tick();
  assert.equal(disposed, false);
  await assert.rejects(queue.submit({ key: 'c', async run() { started.push('c'); } }), /closed/);
  active.release(); await running; await disposal;
  assert.equal(disposed, true);
  assert.deepEqual(started, ['a']);
  assert.equal(queue.activeCount, 0);
});

test('closing before dispatch prevents queued jobs from starting', async () => {
  const queue = new AgentQueue(1);
  let ran = false;
  const job = queue.submit({ key: 'a', async run() { ran = true; } });
  await queue.dispose(); await job; await tick();
  assert.equal(ran, false);
});

test('execution capacity must be a positive safe integer', () => {
  for (const capacity of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new AgentQueue(capacity), RangeError);
  }
});
