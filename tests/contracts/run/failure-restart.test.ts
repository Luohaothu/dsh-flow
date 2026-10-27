import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent } from '../../../packages/dsh-flow/src/core/index.js';
import { deferred, flush, profile } from '../../helpers/contract-host.js';
import { runFixture, waitFor } from '../../helpers/contract-run.js';

test('C036-03 failing the initial save returns no successful Run and leaves existing teams usable', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const existing = await f.createActive({}, 'existing', owner);
  f.failWrites('write', new Error('fixture initial record save failed'));
  assert.throws(() => f.service.create(owner, {}, 'failed-create'), /storage failed|uncertain/i);
  f.clearFault();
  assert.deepEqual(f.service.list(owner).map(run => run.id), [existing.id]);
  assert.equal(existing.status, 'active');
  assert.equal(f.binding(existing).host.disposeCount, 0);
  assert.equal((await f.service.assign(owner, existing, f.spec(), 'unaffected')).status, 'pending');
});

test('C036-03 failed initialization disposes only its partially created resources', async t => {
  const f = await runFixture(t, {
    onInitialize: async (_run, defaults, { context }) => {
      if (defaults.preset !== 'fail') return;
      await Agent.create(context, profile('partial-initialization'), null);
      throw new Error('fixture initializer failed');
    },
  });
  const owner = f.origin();
  const kept = await f.createActive({}, 'existing', owner);
  const keptAssignment = await f.service.assign(owner, kept, f.spec(), 'existing-work');
  const broken = f.service.create(owner, { preset: 'fail' }, 'broken');
  await waitFor(() => broken.status !== 'starting');
  assert.equal(broken.status, 'failed');
  const brokenSnapshot = f.service.read(owner, broken);
  assert.match(brokenSnapshot.error ?? '', /fixture initializer failed/);
  assert.equal(brokenSnapshot.cleanup, 'complete');
  assert.equal(f.environment(broken).host.disposeCount, 1);
  assert.equal(f.environment(broken).host.releases.length, 1);
  assert.equal(kept.status, 'active');
  assert.equal(f.binding(kept).host.disposeCount, 0);
  assert.equal(f.binding(kept).context.has(f.binding(kept).root), true);
  assert.ok(kept.assignments);
  assert.equal(f.service.readAssignment(owner, kept, kept.assignments.resolve(keptAssignment.id)).status, 'pending');
  await assert.rejects(f.service.assign(owner, broken, f.spec(), 'cannot-use-failed'));
  const next = await f.service.assign(owner, kept, f.spec(), 'later-work');
  assert.equal(next.status, 'pending');
});

test('C036-03 initialization cleanup failure is queryable and cannot report completed cleanup', async t => {
  const f = await runFixture(t, {
    onInitialize: async (_run, _defaults, { context, host }) => {
      await Agent.create(context, profile('partial-cleanup-failure'), null);
      host.releaseHook = () => { throw new Error('fixture partial cleanup failed'); };
      throw new Error('fixture root unavailable');
    },
  });
  const owner = f.origin();
  const run = f.service.create(owner, {}, 'broken');
  await waitFor(() => run.status !== 'starting');
  const snapshot = f.service.read(owner, run);
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.cleanup, 'failed');
  assert.match(snapshot.error ?? '', /fixture root unavailable/);
  assert.match(snapshot.error ?? '', /cleanup|release/i);
  await assert.rejects(async () => f.service.release(owner, run));
  assert.notEqual(f.service.read(owner, run).cleanup, 'complete');
});

test('C036-03 failure to save initialization readiness cleans the Context and exposes failure', async t => {
  const f = await runFixture(t, {
    onInitialize: run => { f.failWrites('write', new Error('fixture activation save failed'), run.id); },
  });
  const owner = f.origin();
  const run = f.service.create(owner, {}, 'cannot-save-active');
  await flush();
  await waitFor(() => f.environment(run).host.disposeCount === 1);
  const snapshot = f.service.read(owner, run);
  assert.equal(snapshot.status, 'failed');
  assert.ok(snapshot.storageError);
  assert.notEqual(snapshot.cleanup, 'pending');
  await assert.rejects(f.service.assign(owner, run, f.spec(), 'blocked'));
});

test('C038-01 cleanup failure rejects the shared release and preserves saved results', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const { root, host } = f.binding(run);
  const done = await f.service.assign(owner, run, f.spec(), 'done');
  assert.ok(run.assignments);
  const doneHandle = run.assignments.resolve(done.id);
  await f.submit(run, root, doneHandle, { answer: '已存结果' });
  host.releaseHook = () => { throw new Error('fixture release cleanup failed'); };
  const releasing = f.service.release(owner, run);
  assert.equal(f.service.release(owner, run), releasing);
  await assert.rejects(releasing, /Run release failed/);
  assert.equal(f.service.read(owner, run).status, 'failed');
  assert.equal(f.service.read(owner, run).cleanup, 'failed');
  assert.deepEqual(f.service.readAssignment(owner, run, doneHandle).result, { answer: '已存结果' });
  assert.equal(f.service.release(owner, run), releasing);
  await assert.rejects(f.service.assign(owner, run, f.spec(), 'blocked'));
});

for (const stage of ['write', 'file-sync', 'rename', 'directory-sync'] as const) {
  test(`C038-01 ${stage} storage failure rejects release but still attempts Context disposal`, async t => {
    const f = await runFixture(t);
    const owner = f.origin();
    const run = await f.createActive({}, 'team', owner);
    const { root, host, context } = f.binding(run);
    const done = await f.service.assign(owner, run, f.spec(), 'done');
    const pending = await f.service.assign(owner, run, f.spec(), 'pending');
    assert.ok(run.assignments);
    const doneHandle = run.assignments.resolve(done.id);
    await f.submit(run, root, doneHandle, { answer: '安全保存' });
    f.failWrites(stage, new Error(`fixture ${stage} failed`), run.id);
    const releasing = f.service.release(owner, run);
    assert.equal(f.service.release(owner, run), releasing);
    await assert.rejects(f.service.assign(owner, run, f.spec(), 'blocked'));
    await assert.rejects(releasing, /Run release failed/);
    const snapshot = f.service.read(owner, run);
    assert.notEqual(snapshot.status, 'stopped');
    assert.notEqual(snapshot.cleanup, 'complete');
    assert.ok(snapshot.storageError);
    assert.equal(context.has(root), false);
    assert.equal(host.disposeCount, 1);
    assert.deepEqual(f.service.readAssignment(owner, run, doneHandle).result, { answer: '安全保存' });
    assert.equal(f.service.release(owner, run), releasing);
    assert.ok(f.store.read(run.id)?.assignments[pending.id]);
  });
}

for (const order of ['release-first', 'material-validation-first'] as const) {
  test(`C038-01 pending material preparation and release race: ${order}`, async t => {
    const entered = deferred();
    const validation = deferred();
    t.after(() => validation.resolve());
    const f = await runFixture(t, { validateMaterials: async () => { entered.resolve(); await validation.promise; } });
    const owner = f.origin();
    const run = await f.createActive({}, 'team', owner);
    const assigning = f.service.assign(owner, run, f.spec({ materials: [{
      id: 'material', sourceId: 'fixture', digest: 'fixture-digest', location: 'fixture://material', mediaType: 'text/plain',
    }] }), 'material-task');
    await entered.promise;
    if (order === 'release-first') {
      const rejected = assert.rejects(assigning);
      await f.service.release(owner, run);
      validation.resolve();
      await rejected;
      assert.equal(Object.keys(f.store.read(run.id)!.assignments).length, 0);
    } else {
      validation.resolve();
      const snapshot = await assigning;
      await f.service.release(owner, run);
      assert.ok(run.assignments);
      assert.equal(f.service.readAssignment(owner, run, run.assignments.resolve(snapshot.id)).status, 'cancelled');
    }
    await flush();
    assert.equal(run.status, 'stopped');
    assert.equal(f.environment(run).host.disposeCount, 1);
  });
}

test('C038-02 a new service expires old Run handles and keeps completed and interrupted assignment archives readable', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const oldRun = await f.createActive({}, 'team', owner);
  const done = await f.service.assign(owner, oldRun, f.spec({ name: '完成任务' }), 'done');
  const pending = await f.service.assign(owner, oldRun, f.spec({ name: '中断任务' }), 'pending');
  assert.ok(oldRun.assignments);
  await f.submit(oldRun, f.binding(oldRun).root, oldRun.assignments.resolve(done.id), { answer: '重启后可读' });
  const restarted = await runFixture(t, { directory: f.directory });
  const newOwner = restarted.origin();
  assert.throws(() => restarted.service.read(newOwner, oldRun), /该运行已随重启失效/);
  await assert.rejects(restarted.service.assign(newOwner, oldRun, f.spec(), 'expired'), /该运行已随重启失效/);
  await assert.rejects(async () => restarted.service.release(newOwner, oldRun), /该运行已随重启失效/);
  assert.deepEqual(restarted.service.list(newOwner), []);
  const archivedDone = restarted.service.readArchive(done.id);
  const archivedPending = restarted.service.readArchive(pending.id);
  assert.equal(archivedDone.kind, 'found');
  assert.equal(archivedPending.kind, 'found');
  if (archivedDone.kind !== 'found' || archivedPending.kind !== 'found') assert.fail('both historical assignments must exist');
  assert.equal(archivedDone.assignment.status, 'submitted');
  assert.deepEqual(archivedDone.assignment.result, { answer: '重启后可读' });
  assert.equal(archivedDone.interrupted, false);
  assert.equal(archivedPending.assignment.status, 'pending');
  assert.equal(archivedPending.interrupted, true);
  const archiveProcess = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./fixtures/read-archive.ts', import.meta.url)), f.directory, done.id, pending.id,
  ], { encoding: 'utf8' });
  assert.equal(archiveProcess.status, 0, archiveProcess.stderr);
  assert.deepEqual(JSON.parse(archiveProcess.stdout), [archivedDone, archivedPending]);
  const fresh = await restarted.createActive({}, 'team', newOwner);
  assert.notEqual(fresh.id, oldRun.id);
  assert.equal(fresh.status, 'active');
  assert.deepEqual(restarted.service.readArchive(done.id), archivedDone);
  assert.deepEqual(restarted.service.readArchive(pending.id), archivedPending);
});
