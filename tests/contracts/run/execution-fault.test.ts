import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, HostEvent } from '../../../packages/dsh-flow/src/core/index.js';
import type { AssignmentExecutionFault } from '../../../packages/dsh-flow/src/assignments/types.js';
import { runFixture } from '../../helpers/contract-run.js';
import { ContractHost, flush } from '../../helpers/contract-host.js';

function fail(host: ContractHost, agent: Agent, turnId: string, timestamp = 100) {
  host.status(agent, 'running'); host.status(agent, 'idle');
  host.emit({ agent: host.native(agent), type: 'turn-end', timestamp, reason: 'failed', turnId, error: 'Provider turn failed' });
}
function notices(agent: Agent) {
  return [...agent.getMailbox().getUnread()].filter(message => message.summary === '作业执行轮次失败');
}

test('a failed recipient turn reports only its delivered pending assignments once and preserves all assignment states', async t => {
  const faults: AssignmentExecutionFault[] = [], outcomes: string[] = [];
  const f = await runFixture(t, { onTopLevelExecutionFault: (_origin, _run, fault) => { faults.push(fault); }, onTopLevelOutcome: (_origin, _run, assignment) => { outcomes.push(assignment.id); } });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const one = await f.service.assign(f.origin(), run, f.spec(), 'one');
  const two = await f.service.assign(f.origin(), run, f.spec(), 'two');
  const done = await f.service.assign(f.origin(), run, f.spec(), 'done');
  await f.submit(run, root, run.assignments!.resolve(done.id), { answer: 'kept' });
  const cancelled = await f.service.assign(f.origin(), run, f.spec(), 'cancelled');
  await f.service.cancelAssignment(f.origin(), run, run.assignments!.resolve(cancelled.id), 'not needed');
  const prepared = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec() }, 'not-delivered');
  fail(host, root, 'first');
  host.emit({ agent: host.native(root), type: 'turn-end', timestamp: 101, reason: 'failed', turnId: 'first', error: 'Duplicate durable event' });
  assert.equal(faults.length, 1);
  assert.deepEqual(faults[0]!.assignmentIds, [one.id, two.id]);
  assert.equal(faults[0]!.error, 'Provider turn failed');
  assert.equal(root.getStatus(), 'idle');
  for (const record of [one, two]) assert.equal(f.service.readAssignment(f.origin(), run, run.assignments!.resolve(record.id)).status, 'pending');
  assert.equal(run.assignments!.read(run, prepared).status, 'pending');
  assert.deepEqual(f.service.readAssignment(f.origin(), run, run.assignments!.resolve(done.id)).result, { answer: 'kept' });
  assert.equal(f.service.readAssignment(f.origin(), run, run.assignments!.resolve(cancelled.id)).status, 'cancelled');
  assert.deepEqual(outcomes, [done.id]);
  fail(host, root, 'second', 100);
  assert.equal(faults.length, 2, 'a different native turn is distinct even with the same timestamp');
});

test('execution notices follow immutable senders after transfer and do not broadcast to current peers', async t => {
  const f = await runFixture(t), run = await f.createActive(), { root, host } = f.binding(run);
  const top = await f.service.assign(f.origin(), run, f.spec(), 'top');
  const a = await f.child(run), b = await f.child(run), unrelated = await f.child(run), worker = await f.child(run, a);
  const aJob = await run.assignments!.prepare({ sender: root, recipient: a, parentAssignment: run.assignments!.resolve(top.id), spec: f.spec() }, 'a');
  const bJob = await run.assignments!.prepare({ sender: root, recipient: b, parentAssignment: run.assignments!.resolve(top.id), spec: f.spec() }, 'b');
  const old = await run.assignments!.prepare({ sender: a, recipient: worker, parentAssignment: aJob, spec: f.spec() }, 'old');
  run.assignments!.deliver(old);
  a.transfer(worker, b);
  const current = await run.assignments!.prepare({ sender: b, recipient: worker, parentAssignment: bJob, spec: f.spec() }, 'current');
  run.assignments!.deliver(current);
  fail(host, worker, 'worker-failure'); await flush();
  const first = notices(a), second = notices(b);
  assert.equal(first.length, 1); assert.equal(second.length, 1);
  assert.deepEqual((first[0]!.payload as AssignmentExecutionFault).assignmentIds, [old.id]);
  assert.deepEqual((second[0]!.payload as AssignmentExecutionFault).assignmentIds, [current.id]);
  assert.equal(notices(root).length, 0); assert.equal(notices(unrelated).length, 0);
  assert.equal(run.assignments!.read(a, old).status, 'pending');
  assert.equal(run.assignments!.read(b, current).status, 'pending');
  await run.assignments!.cancel(a, old, 'replace old work');
  await f.submit(run, worker, current, { answer: 'recovered' });
  assert.equal(run.assignments!.read(b, current).status, 'submitted');
});

test('recovered errors, cancelled turns and logical termination keep their existing outcome paths', async t => {
  const faults: AssignmentExecutionFault[] = [];
  const f = await runFixture(t, { onTopLevelExecutionFault: (_origin, _run, fault) => { faults.push(fault); } });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const pending = await f.service.assign(f.origin(), run, f.spec(), 'pending');
  host.status(root, 'running');
  host.emit({ agent: host.native(root), type: 'error', timestamp: 1, message: 'Recovered within this turn' });
  host.emit({ agent: host.native(root), type: 'turn-end', timestamp: 2, reason: 'completed', turnId: 'recovered' });
  host.emit({ agent: host.native(root), type: 'turn-end', timestamp: 3, reason: 'cancelled', turnId: 'cancelled' });
  assert.equal(faults.length, 0);
  assert.equal(f.service.readAssignment(f.origin(), run, run.assignments!.resolve(pending.id)).status, 'pending');
  await root.recvSignal('SIGKILL');
  host.emit({ agent: host.native(root), type: 'turn-end', timestamp: 4, reason: 'failed', turnId: 'terminated' });
  assert.equal(faults.length, 0);
  assert.equal(f.service.readAssignment(f.origin(), run, run.assignments!.resolve(pending.id)).status, 'failed');
});

test('a releasing run suppresses failures from an outstanding native turn', async t => {
  const faults: AssignmentExecutionFault[] = [];
  const f = await runFixture(t, { onTopLevelExecutionFault: (_origin, _run, fault) => { faults.push(fault); } });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const pending = await f.service.assign(f.origin(), run, f.spec(), 'pending');
  const releasing = f.service.release(f.origin(), run);
  fail(host, root, 'shutdown'); await releasing;
  assert.equal(faults.length, 0);
  assert.equal(f.store.read(run.id)!.assignments[pending.id]!.status, 'cancelled');
});

test('adapters without a native turn id deduplicate one end event but allow the next execution round', async t => {
  const faults: AssignmentExecutionFault[] = [];
  const f = await runFixture(t, { onTopLevelExecutionFault: (_origin, _run, fault) => { faults.push(fault); } });
  const run = await f.createActive(), { root, host } = f.binding(run);
  await f.service.assign(f.origin(), run, f.spec(), 'pending');
  const event: HostEvent = { agent: host.native(root), type: 'turn-end', timestamp: 9, reason: 'failed' };
  host.status(root, 'running'); host.emit(event); host.emit(event);
  assert.equal(faults.length, 1);
  host.status(root, 'running'); host.emit(event);
  assert.equal(faults.length, 2);
});
