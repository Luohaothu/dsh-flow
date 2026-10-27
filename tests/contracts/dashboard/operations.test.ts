import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { readJournal } from '../../../packages/dsh-flow/src/dashboard/events.js';
import { DashboardOperations, decodeStopRequest } from '../../../packages/dsh-flow/src/dashboard/operations.js';
import { getAgentInstanceId } from '../../../packages/dsh-flow/src/core/observation.js';
import { runServiceControl } from '../../../packages/dsh-flow/src/run/internal.js';
import { deferred, flush } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

test('stop registers acceptance before async effects, shares concurrent replay and rejects conflicts', async t => {
  const f = await runFixture(t); const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const run = await f.createActive(); const child = await f.child(run); const operations = new DashboardOperations(projector, f.service);
  const request = { operationId: 'kill-child', targetEpoch: f.service.epoch, agentId: getAgentInstanceId(child) };
  const first = operations.stop(run.id, request); const replay = operations.stop(run.id, { ...request });
  assert.deepEqual(first, { operationId: request.operationId, status: 'accepted' }); assert.deepEqual(replay, first);
  assert.equal(child.getStatus(), 'idle'); assert.equal(projector.snapshot(run.id).operations[0]?.status, 'accepted');
  assert.throws(() => operations.stop(run.id, { ...request, agentId: getAgentInstanceId(f.binding(run).root) }), /different target/);
  await operations.settled(); assert.equal(child.getStatus(), 'terminated'); assert.equal(run.status, 'active');
  assert.equal(projector.snapshot(run.id).operations[0]?.status, 'completed'); assert.deepEqual(operations.stop(run.id, request), first);
});

test('failed stop remains failed on replay and a new operation may retry', async t => {
  const f = await runFixture(t); const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose()); const run = await f.createActive();
  const operations = new DashboardOperations(projector, f.service); const request = { operationId: 'missing', targetEpoch: f.service.epoch, agentId: 'missing-instance' };
  operations.stop(run.id, request); await operations.settled();
  assert.equal(projector.snapshot(run.id).operations.find(op => op.id === 'missing')?.status, 'failed');
  operations.stop(run.id, request); await operations.settled(); assert.equal(projector.snapshot(run.id).operations.length, 1);
  operations.stop(run.id, { operationId: 'retry', targetEpoch: f.service.epoch, scope: 'run' }); await operations.settled(); assert.equal(run.status, 'stopped');
  assert.throws(() => operations.stop(run.id, { ...request, operationId: 'old', targetEpoch: 'old-epoch' }), /expired/);
});

test('scope run accepts starting no-root release, waits initialization, and publishes final result', async t => {
  const gate = deferred(); const f = await runFixture(t, { onInitialize: () => gate.promise }); t.after(() => gate.resolve());
  const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const observed: string[] = [];
  const unsubscribe = f.service[runServiceControl].observe(view => observed.push(view.run.status)); t.after(unsubscribe);
  const run = f.service.create(f.origin(), {}, 'starting'); const operations = new DashboardOperations(projector, f.service);
  assert.equal(projector.snapshot(run.id).nodes.length, 0);
  operations.stop(run.id, { operationId: 'release', targetEpoch: f.service.epoch, scope: 'run' }); await flush();
  assert.equal(run.status, 'stopping'); assert.equal(projector.snapshot(run.id).operations[0]?.status, 'accepted');
  gate.resolve(); await operations.settled(); assert.equal(run.status, 'stopped'); assert.ok(projector.snapshot(run.id).run.endedAt);
  assert.deepEqual(observed.slice(0, 2), ['starting', 'stopping']); assert.equal(observed.at(-1), 'stopped');
});

test('Run observes Context before any creation; snapshots isolate assignments and persist UUID and real times', async t => {
  const f = await runFixture(t); let initialContext = false;
  f.service[runServiceControl].observe(view => { if (view.run.status === 'starting') initialContext = view.context.list().length === 0; });
  const before = Date.now(); const run = await f.createActive(); assert.equal(initialContext, true);
  const root = f.binding(run).root; const assignment = await f.service.assign(f.origin(), run, f.spec(), 'a');
  const view = f.service[runServiceControl].snapshot(run.id); assert.equal(assignment.recipientInstanceId, getAgentInstanceId(root));
  view.assignments[0]!.spec.name = 'mutated'; assert.notEqual(f.service[runServiceControl].snapshot(run.id).assignments[0]!.spec.name, 'mutated');
  assert.ok(view.run.startedAt >= before); assert.deepEqual(f.store.read(run.id)?.assignments[assignment.id], assignment);
  await f.service[runServiceControl].release(run.id, f.service.epoch); const terminal = f.store.read(run.id)!; assert.ok(terminal.endedAt! >= terminal.startedAt);
});

test('stop decoder requires exactly one target and complete request identity', () => {
  for (const value of [null, {}, { operationId: 'x', targetEpoch: 'e' }, { operationId: 'x', targetEpoch: 'e', agentId: 'a', scope: 'run' }, { operationId: 'x', targetEpoch: 'e', scope: 'run', extra: true }]) assert.throws(() => decodeStopRequest(value));
  assert.deepEqual(decodeStopRequest({ operationId: 'x', targetEpoch: 'e', scope: 'run' }), { operationId: 'x', targetEpoch: 'e', scope: 'run' });
});

test('stop release failure publishes one failed result and concurrent replay retains it', async t => {
  const f = await runFixture(t); const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const run = await f.createActive(); const host = f.binding(run).host; host.dispose = async () => { host.disposeCount++; throw new Error('cleanup failure'); };
  const operations = new DashboardOperations(projector, f.service); const request = { operationId: 'cleanup', targetEpoch: f.service.epoch, scope: 'run' as const };
  const accepted = operations.stop(run.id, request); assert.deepEqual(operations.stop(run.id, request), accepted); await operations.settled();
  const operation = projector.snapshot(run.id).operations[0]!; assert.equal(operation.status, 'failed'); assert.match(operation.error!, /Run release failed/); assert.equal(host.disposeCount, 1);
  operations.stop(run.id, request); await operations.settled(); assert.equal(host.disposeCount, 1); assert.equal(projector.snapshot(run.id).operations.length, 1);
});

test('scope run stop during failing initialization completes cleanup while Run remains failed in snapshots and journal', async t => {
  const initialization = deferred(); t.after(() => initialization.resolve());
  const f = await runFixture(t, { onInitialize: async () => { await initialization.promise; throw new Error('initializer rejected during stop'); } });
  const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const owner = f.origin(); const run = f.service.create(owner, {}, 'starting-will-fail'); const operations = new DashboardOperations(projector, f.service);
  const accepted = operations.stop(run.id, { operationId: 'stop-initializer', targetEpoch: f.service.epoch, scope: 'run' }); assert.equal(accepted.status, 'accepted');
  await flush(); assert.equal(run.status, 'stopping'); initialization.resolve(); await operations.settled();
  const actual = f.service.read(owner, run); assert.equal(actual.status, 'failed'); assert.match(actual.error!, /initializer rejected during stop/); assert.equal(actual.cleanup, 'complete');
  const snapshot = projector.snapshot(run.id); assert.equal(snapshot.run.status, 'failed'); assert.equal(snapshot.run.endedAt, actual.endedAt); assert.equal(snapshot.operations[0]?.status, 'completed');
  assert.equal(f.environment(run).host.disposeCount, 1); assert.equal(f.store.read(run.id)?.status, 'failed');
  assert.equal(projector.registry().runs.find(entry => entry.id === run.id)?.status, 'failed');
  const journal = readJournal(join(f.directory, 'events', 'runs'), run.id, f.service.epoch);
  const runEvents = journal.events.filter(event => event.type === 'run-ended'); assert.ok(runEvents.length > 0);
  for (const event of runEvents) { assert.ok(event.run && typeof event.run === 'object'); assert.equal('status' in event.run && event.run.status, 'failed'); assert.equal('endedAt' in event.run && event.run.endedAt, actual.endedAt); }
  const result = journal.events.filter(event => event.type === 'operation-result').at(-1)!; assert.ok(result.operation && typeof result.operation === 'object'); assert.equal('status' in result.operation && result.operation.status, 'completed');
});
