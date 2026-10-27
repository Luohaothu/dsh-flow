import assert from 'node:assert/strict';
import test from 'node:test';
import { Group } from '../../../packages/dsh-flow/src/core/index.js';
import type { AssignmentSnapshot } from '../../../packages/dsh-flow/src/assignments/types.js';
import { deferred, flush, message } from '../../helpers/contract-host.js';
import { runFixture, waitFor } from '../../helpers/contract-run.js';

test('C037-01 C037-03 one session keeps independent teams and reuses members and groups after multiple assignments finish', async t => {
  const outcomes: AssignmentSnapshot[] = [];
  const f = await runFixture(t, { onTopLevelOutcome: (_origin, _run, assignment) => { outcomes.push(assignment); } });
  const owner = f.origin();
  const first = await f.createActive({}, 'first-team', owner);
  const second = await f.createActive({}, 'second-team', owner);
  const { root, context, host } = f.binding(first);
  const child = await f.child(first);
  const group = new Group(context, [root, child]);
  const a = await f.service.assign(owner, first, f.spec({ name: '任务甲' }), 'task-a');
  const b = await f.service.assign(owner, first, f.spec({ name: '任务乙' }), 'task-b');
  assert.equal(f.service.read(owner, first).pendingAssignments, 2);
  assert.equal(f.service.read(owner, second).pendingAssignments, 0);
  assert.deepEqual(a.sender, { kind: 'run', runId: first.id });
  assert.equal(a.recipientSessionID, root.getProfile().sessionID);
  assert.equal(a.parentAssignmentId, null);
  assert.ok(first.assignments);
  assert.equal((await f.submit(first, root, first.assignments.resolve(a.id), { answer: '甲完成' })).kind, 'accepted');
  assert.equal((await f.submit(first, root, first.assignments.resolve(b.id), { answer: '乙完成' })).kind, 'accepted');
  await flush();
  const mailboxBeforeReplay = root.getMailbox().count();
  const replay = await f.service.assign(f.origin(), first, f.spec({ name: '任务甲' }), 'task-a');
  assert.equal(replay.id, a.id);
  assert.equal(replay.status, 'submitted');
  assert.deepEqual(replay.result, { answer: '甲完成' });
  assert.equal(replay.submissionCount, 1);
  assert.equal(root.getMailbox().count(), mailboxBeforeReplay);
  assert.equal(f.service.read(owner, first).pendingAssignments, 0);
  assert.equal(first.status, 'active');
  assert.equal(second.status, 'active');
  assert.equal(context.has(root), true);
  assert.equal(context.has(child), true);
  assert.equal(context.has(group), true);
  assert.equal(child.getParent(), root);
  group.postToBlackboard(child, message('后续任务复用原有群'));
  assert.equal(group.readBlackboard().length, 1);
  const later = await f.service.assign(f.origin(), first, f.spec({ name: '后续任务' }), 'task-c');
  assert.equal(later.status, 'pending');
  assert.equal(later.recipientSessionID, root.getProfile().sessionID);
  assert.equal(f.service.read(owner, first).pendingAssignments, 1);
  assert.deepEqual(outcomes.map(item => item.id).sort(), [a.id, b.id].sort());
  assert.equal(host.disposeCount, 0);
  assert.equal(f.binding(second).host.disposeCount, 0);
});

test('C037-02 assign returns after persistence and mailbox delivery while native notification remains pending', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const { root, host } = f.binding(run);
  const notification = deferred();
  t.after(() => notification.resolve());
  host.sendHook = () => notification.promise;
  const snapshot = await f.service.assign(owner, run, f.spec(), 'assign');
  assert.equal(snapshot.status, 'pending');
  assert.equal(root.getMailbox().count(), 1);
  assert.equal(f.store.read(run.id)?.assignments[snapshot.id]?.status, 'pending');
  assert.equal(f.store.read(run.id)?.assignments[snapshot.id]?.submissionCount, 0);
  const again = await f.service.assign(f.origin(), run, f.spec(), 'assign');
  assert.equal(again.id, snapshot.id);
  assert.equal(root.getMailbox().count(), 1);
  await assert.rejects(f.service.assign(owner, run, f.spec({ requirements: '改动参数' }), 'assign'));
  notification.resolve();
  await flush();
  assert.equal(run.status, 'active');
});

test('C036-02 assignment read and cancel require the owning trusted session', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const snapshot = await f.service.assign(owner, run, f.spec(), 'assign');
  assert.ok(run.assignments);
  const assignment = run.assignments.resolve(snapshot.id);
  for (const outsider of [f.origin('other'), f.origin('main', 'other'), { ...owner }]) {
    assert.throws(() => f.service.readAssignment(outsider, run, assignment));
    await assert.rejects(async () => f.service.cancelAssignment(outsider, run, assignment, 'unauthorized'));
  }
  assert.equal(f.service.readAssignment(f.origin(), run, assignment).status, 'pending');
  await f.service.cancelAssignment(f.origin(), run, assignment, '由同会话的后续调用取消');
  assert.equal(f.service.readAssignment(owner, run, assignment).status, 'cancelled');
  assert.equal(run.status, 'active');
});

test('C037-02 failure to validate one assignment leaves existing work and team resources available', async t => {
  const f = await runFixture(t, { validateMaterials: async () => { throw new Error('fixture material validation failed'); } });
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const kept = await f.service.assign(owner, run, f.spec(), 'kept');
  await assert.rejects(f.service.assign(owner, run, f.spec({ materials: [{
    id: 'material', sourceId: 'fixture', digest: 'fixture-digest', location: 'fixture://material', mediaType: 'text/plain',
  }] }), 'invalid-material'), /fixture material validation failed/);
  assert.equal(run.status, 'active');
  assert.equal(f.service.read(owner, run).pendingAssignments, 1);
  assert.equal(f.binding(run).context.has(f.binding(run).root), true);
  assert.equal(f.binding(run).host.disposeCount, 0);
  assert.ok(run.assignments);
  assert.equal(f.service.readAssignment(owner, run, run.assignments.resolve(kept.id)).status, 'pending');
  const next = await f.service.assign(owner, run, f.spec(), 'next');
  assert.equal(next.status, 'pending');
});

test('C038-01 release synchronously closes admission, cancels pending work, and awaits shared resource cleanup', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const { root, host, context } = f.binding(run);
  const child = await f.child(run);
  const group = new Group(context, [root, child]);
  const completed = await f.service.assign(owner, run, f.spec(), 'done');
  const pending = await f.service.assign(owner, run, f.spec(), 'pending');
  assert.ok(run.assignments);
  const completedHandle = run.assignments.resolve(completed.id);
  const pendingHandle = run.assignments.resolve(pending.id);
  await f.submit(run, root, completedHandle, { answer: '持久结果' });
  const cleanup = deferred();
  t.after(() => cleanup.resolve());
  host.closeGates.set(host.native(root), cleanup);
  const releasing = f.service.release(owner, run);
  assert.equal(run.status, 'stopping');
  assert.equal(f.service.release(f.origin(), run), releasing);
  await assert.rejects(f.service.assign(owner, run, f.spec(), 'after-release'));
  await waitFor(() => f.service.readAssignment(owner, run, pendingHandle).status === 'cancelled');
  let finished = false;
  void releasing.then(() => { finished = true; }, () => { finished = true; });
  await flush();
  assert.equal(finished, false);
  assert.equal(host.disposeCount, 0);
  assert.equal(context.has(group), false);
  cleanup.resolve();
  await releasing;
  assert.equal(run.status, 'stopped');
  assert.equal(f.service.read(owner, run).cleanup, 'complete');
  assert.equal(f.service.read(owner, run).pendingAssignments, 0);
  assert.equal(context.has(root), false);
  assert.equal(context.has(child), false);
  assert.throws(() => group.readBlackboard());
  assert.equal(host.disposeCount, 1);
  assert.equal(f.service.release(owner, run), releasing);
  assert.deepEqual(f.service.readAssignment(owner, run, completedHandle).result, { answer: '持久结果' });
  assert.equal(f.service.readAssignment(owner, run, pendingHandle).status, 'cancelled');
});

for (const cleanup of ['complete', 'failed'] as const) {
  test(`C038-01 synchronous cancellation notification reentry shares one release with ${cleanup} cleanup`, async t => {
    const f = await runFixture(t);
    const owner = f.origin();
    const run = await f.createActive({}, 'reentrant-release', owner);
    const { root, host } = f.binding(run);
    assert.ok(run.assignments);
    const assignment = await run.assignments.prepare({
      sender: run, recipient: root, parentAssignment: null, spec: f.spec(),
    }, 'undelivered');
    const revision = f.service.read(owner, run).revision;
    let reentrant: Promise<void> | undefined;
    let notificationCount = 0;
    host.sendHook = () => {
      notificationCount++;
      reentrant = f.service.release(owner, run);
    };
    if (cleanup === 'failed') host.releaseHook = () => { throw new Error('fixture reentrant cleanup failed'); };
    const releasing = f.service.release(owner, run);
    const immediateStatus = run.status;
    const immediateAssignmentStatus = f.service.readAssignment(owner, run, assignment).status;
    const reenteredSynchronously = reentrant !== undefined;
    const results = await Promise.allSettled([releasing, reentrant]);
    assert.equal(reenteredSynchronously, true);
    assert.equal(notificationCount, 1);
    assert.equal(immediateStatus, 'stopping');
    assert.equal(immediateAssignmentStatus, 'cancelled');
    assert.equal(reentrant, releasing);
    assert.deepEqual(results.map(result => result.status), cleanup === 'complete' ? ['fulfilled', 'fulfilled'] : ['rejected', 'rejected']);
    if (results[0]!.status === 'rejected' && results[1]!.status === 'rejected') assert.equal(results[0].reason, results[1].reason);
    const snapshot = f.service.read(owner, run);
    assert.equal(snapshot.revision, revision + 3);
    assert.equal(snapshot.status, cleanup === 'complete' ? 'stopped' : 'failed');
    assert.equal(snapshot.cleanup, cleanup);
    assert.equal(host.disposeCount, cleanup === 'complete' ? 1 : 0);
    assert.equal(host.releases.length, 1);
    assert.equal(f.service.release(owner, run), releasing);
  });
}

for (const order of ['release-before-ready', 'ready-before-release'] as const) {
  test(`C038-01 controlled initialization race: ${order}`, async t => {
    const initialized = deferred();
    t.after(() => initialized.resolve());
    const f = await runFixture(t, { onInitialize: () => initialized.promise });
    const owner = f.origin();
    const run = f.service.create(owner, {}, 'team');
    await flush();
    if (order === 'ready-before-release') {
      initialized.resolve();
      await waitFor(() => run.status === 'active');
    }
    const releasing = f.service.release(owner, run);
    assert.equal(run.status, 'stopping');
    await assert.rejects(f.service.assign(owner, run, f.spec(), 'blocked'));
    initialized.resolve();
    await releasing;
    assert.equal(run.status, 'stopped');
    assert.equal(f.service.read(owner, run).cleanup, 'complete');
    assert.equal(f.environment(run).host.disposeCount, 1);
    assert.equal(f.environment(run).host.sent.length, 0);
  });
}
