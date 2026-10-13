/** Closed collaboration owners must release native resources; task cancellation keeps the member reusable. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, until, type ControlledNative } from './native-fixture.ts';

for (const target of ['team', 'member', 'root-task'] as const) test(`cancelling a ${target} drains and disposes its closed native member`, async t => {
  const f = fixture(t), a = await f.startMember();
  const operations: string[] = [];
  const cancel = a.native.cancel.bind(a.native), flush = a.native.flush.bind(a.native), dispose = a.native.dispose.bind(a.native);
  a.native.cancel = async () => { operations.push('cancel'); await cancel(); };
  a.native.flush = async () => { operations.push('flush'); await flush(); };
  a.native.dispose = async () => { operations.push('dispose'); await dispose(); };
  await f.flow.control('owner', { team_id: a.team, target: target === 'root-task' ? 'task' : target, id: target === 'team' ? a.team : target === 'root-task' ? a.rootTask.id : a.member.id, action: 'cancel' });
  await until(() => a.native.cancelled > 0 && !a.native.running());
  await tick(); await tick();
  assert.equal(f.flow.store.getMember(a.member.id)?.state, 'closed');
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'CANCELLED');
  assert.equal(a.native.disposed, 1, `closed members must release their owned native resources; observed ${operations.join(' → ')}`);
  assert.ok(operations.indexOf('cancel') < operations.lastIndexOf('flush'));
  assert.ok(operations.lastIndexOf('flush') < operations.indexOf('dispose'));
});

test('cancelling only a task preserves the native member for explicitly delegated subsequent work', async t => {
  const f = fixture(t), a = await f.startMember();
  await f.flow.control('owner', { team_id: a.team, target: 'task', id: a.task.id, action: 'cancel' });
  await until(() => a.native.cancelled > 0 && !a.native.running());
  await tick(); await tick();
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'CANCELLED');
  assert.notEqual(f.flow.store.getMember(a.member.id)?.state, 'closed');
  assert.equal(a.native.disposed, 0);
  const next = await f.flow.task('owner', { team_id: a.team, action: 'delegate', member_id: a.member.id, objective: 'A separate task after the earlier task was cancelled' });
  await until(() => a.native.running() && a.native.inputs.length === 2);
  assert.equal(next.assignee_session_id, a.member.id);
  assert.equal(f.created.filter(id => id === a.member.id).length, 1);
  assert.equal(a.native.disposed, 0);
});

for (const closure of ['team-cancel', 'member-cancel', 'root-task-cancel', 'root-completed'] as const) test(`${closure} releases an owned member whose native factory has not returned yet`, async t => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending: ControlledNative | undefined;
  t.after(release);
  const f = fixture(t, 1, async native => { pending = native; await gate; });
  const root = await f.startTeam();
  const task = await f.flow.task('owner', { team_id: root.team, action: 'delegate', objective: 'A member whose native setup is still pending' });
  await until(() => pending !== undefined);
  assert.equal(f.handles.has(task.assignee_session_id), false);
  if (closure === 'root-completed') {
    await f.flow.control('owner', { team_id: root.team, target: 'task', id: task.id, action: 'cancel' });
    await f.flow.result('owner', { task_id: root.rootTask.id, summary: 'The optional child was cancelled; the actual root work is complete and checked' });
  } else if (closure === 'root-task-cancel') {
    await f.flow.control('owner', { team_id: root.team, target: 'task', id: root.rootTask.id, action: 'cancel' });
  } else {
    const target = closure === 'team-cancel' ? 'team' : 'member';
    await f.flow.control('owner', { team_id: root.team, target, id: target === 'team' ? root.team : task.assignee_session_id, action: 'cancel' });
  }
  await until(() => f.flow.store.getMember(task.assignee_session_id)?.state === 'closed');
  await tick(); // Let the asynchronous close path observe the still-pending factory.
  release();
  await until(() => f.handles.has(task.assignee_session_id));
  await tick(); await tick();
  assert.equal(pending?.inputs.length, 0, 'closed work must never dispatch after setup returns');
  assert.equal(pending?.disposed, 1, 'the eventual owned Agent must be released even when close started before handles.set');
  assert.ok((pending?.cancelled ?? 0) > 0);
});
