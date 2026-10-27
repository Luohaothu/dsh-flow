import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { readJournal } from '../../../packages/dsh-flow/src/dashboard/events.js';
import { runServiceControl } from '../../../packages/dsh-flow/src/run/internal.js';
import { deferred, profile } from '../../helpers/contract-host.js';
import { runFixture, waitFor } from '../../helpers/contract-run.js';

test('initialization failure is visible before slow cleanup and release preserves the original failure and end time', async t => {
  const cleanupEntered = deferred(); const cleanup = deferred(); t.after(() => cleanup.resolve());
  const f = await runFixture(t, { onInitialize: async (_run, _defaults, { context, host }) => {
    await Agent.create(context, profile('partial-failure'), null);
    host.dispose = async () => { host.disposeCount++; cleanupEntered.resolve(); await cleanup.promise; };
    throw new Error('original initializer failure');
  } });
  const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const owner = f.origin(); const run = f.service.create(owner, {}, 'failed-before-cleanup');
  await cleanupEntered.promise;
  const failed = f.service.read(owner, run);
  assert.equal(failed.status, 'failed'); assert.equal(failed.cleanup, 'pending'); assert.match(failed.error!, /original initializer failure/); assert.ok(failed.endedAt);
  assert.equal(projector.snapshot(run.id).run.status, 'failed'); assert.equal(projector.registry().runs[0]?.endedAt, failed.endedAt);
  cleanup.resolve(); await waitFor(() => f.service.read(owner, run).cleanup === 'complete');
  const saved = f.store.read(run.id)!; assert.equal(saved.status, 'failed'); assert.equal(saved.endedAt, failed.endedAt);
  await delay(5); const released = f.service.release(owner, run);
  assert.equal(run.status, 'failed'); await released;
  const final = f.service.read(owner, run); assert.equal(final.status, 'failed'); assert.equal(final.endedAt, failed.endedAt); assert.equal(final.error, failed.error);
  assert.equal(f.environment(run).context.list().length, 0); assert.equal(f.environment(run).host.disposeCount, 1);
  assert.equal(f.store.read(run.id)?.endedAt, failed.endedAt); assert.equal(projector.snapshot(run.id).run.status, 'failed');
  const events = readJournal(join(f.directory, 'events', 'runs'), run.id, f.service.epoch).events;
  const ended = events.filter(event => event.type === 'run-ended'); assert.ok(ended.length > 0);
  for (const event of ended) { assert.ok(event.run && typeof event.run === 'object'); assert.equal('status' in event.run && event.run.status, 'failed'); assert.equal('endedAt' in event.run && event.run.endedAt, failed.endedAt); }
});

test('release after a settled initialization failure cannot turn failed into stopping or rewrite its historical end time', async t => {
  const f = await runFixture(t, { onInitialize: async (_run, _defaults, { context }) => { await Agent.create(context, profile('failed-root'), null); throw new Error('settled initializer failure'); } });
  const owner = f.origin(); const run = f.service.create(owner, {}, 'settled-failure');
  await waitFor(() => f.service.read(owner, run).cleanup === 'complete');
  const before = f.service.read(owner, run); await delay(5); const release = f.service.release(owner, run);
  assert.equal(run.status, 'failed'); await release;
  const after = f.service.read(owner, run); assert.equal(after.status, 'failed'); assert.equal(after.endedAt, before.endedAt); assert.equal(after.error, before.error);
  const persisted = f.store.read(run.id)!; assert.equal(persisted.status, 'failed'); assert.equal(persisted.endedAt, before.endedAt); assert.equal(persisted.error, before.error);
});

test('read-only storage preserves actual initialization failure in snapshots and journal while release reports the real storage failure', async t => {
  const f = await runFixture(t, { onInitialize: async (run, _defaults, { context }) => {
    await Agent.create(context, profile('storage-failed-root'), null);
    f.failWrites('write', new Error('storage is read-only'), run.id); throw new Error('root initialization failed before storage failure');
  } });
  const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') }); t.after(() => projector.dispose());
  const owner = f.origin(); const run = f.service.create(owner, {}, 'read-only-failure');
  await waitFor(() => f.service.read(owner, run).cleanup === 'complete');
  const before = f.service.read(owner, run); assert.equal(before.status, 'failed'); assert.match(before.error!, /root initialization failed before storage failure/); assert.ok(before.storageError); assert.ok(before.endedAt);
  await delay(5); await assert.rejects(f.service.release(owner, run), /Run release failed/);
  const after = f.service.read(owner, run); assert.equal(after.status, 'failed'); assert.equal(after.endedAt, before.endedAt); assert.match(after.error!, /root initialization failed before storage failure/); assert.ok(after.storageError);
  assert.equal(f.environment(run).context.list().length, 0); assert.equal(f.environment(run).host.disposeCount, 1);
  const projection = projector.snapshot(run.id).run; assert.equal(projection.status, 'failed'); assert.equal(projection.endedAt, before.endedAt); assert.match(projection.error!, /root initialization failed before storage failure/);
  const events = readJournal(join(f.directory, 'events', 'runs'), run.id, f.service.epoch).events;
  const last = events.filter(event => event.type === 'run-ended' || event.type === 'run-changed').at(-1)!; assert.ok(last.run && typeof last.run === 'object'); assert.equal('status' in last.run && last.run.status, 'failed'); assert.equal('endedAt' in last.run && last.run.endedAt, before.endedAt);
});

test('failed initialization retains its primary failure when cleanup also fails and later release rejects the same cleanup', async t => {
  const f = await runFixture(t, { onInitialize: async (_run, _defaults, { context, host }) => {
    await Agent.create(context, profile('cleanup-failed-root'), null); host.releaseHook = () => { throw new Error('cleanup failed separately'); }; throw new Error('primary initialization failure');
  } });
  const owner = f.origin(); const run = f.service.create(owner, {}, 'cleanup-failure');
  await waitFor(() => f.service.read(owner, run).cleanup === 'failed'); const before = f.service.read(owner, run);
  await assert.rejects(f.service[runServiceControl].release(run.id, f.service.epoch), /Run release failed/);
  const after = f.service.read(owner, run); assert.equal(after.status, 'failed'); assert.equal(after.endedAt, before.endedAt); assert.match(after.error!, /primary initialization failure/); assert.match(after.error!, /cleanup|release/);
});
