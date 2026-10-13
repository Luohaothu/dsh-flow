/** Persisted task order, not millisecond timestamp uniqueness, determines sequential member work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, until } from './native-fixture.ts';

test('same-millisecond tasks follow persisted FIFO and reuse an idle member before prior result acceptance', async t => {
  const f = fixture(t), a = await f.startMember();
  const initial = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'The initial member task is complete' });
  a.native.finish();
  await until(() => f.flow.store.getResult(initial.id)?.ready === true);
  await f.flow.review('owner', { result_id: initial.id, accepted: true, notes: 'Checked the initial work' });
  await tick(); await tick();

  const timestamp = Date.now();
  const clock = t.mock.method(Date, 'now', () => timestamp);
  const [first, second] = await (async () => {
    try {
      return [
        await f.flow.task('owner', { team_id: a.team, action: 'delegate', member_id: a.member.id, objective: 'First independently delegated task' }),
        await f.flow.task('owner', { team_id: a.team, action: 'delegate', member_id: a.member.id, objective: 'Second independently delegated task' }),
      ] as const;
    } finally { clock.mock.restore(); }
  })();
  assert.equal(first.created, second.created);
  assert.deepEqual(f.flow.store.tasks(a.team).slice(-2).map(task => task.id), [first.id, second.id], 'the actual insertion order is unambiguous');
  await until(() => a.native.running() && a.native.inputs.length === 2);
  assert.equal(f.flow.store.getMember(a.member.id)?.active_task_id, first.id);
  assert.equal(a.native.inputs.length, 2, 'the second task must not overlap the first native turn');
  a.native.finish('First task result awaits its owner review');
  await until(() => a.native.running() && a.native.inputs.length === 3);
  const firstResult = f.flow.store.getTask(first.id)?.result_id;
  assert.ok(firstResult);
  assert.equal(f.flow.store.getResult(firstResult)?.ready, true);
  assert.equal(f.flow.store.getTask(first.id)?.status, 'SUBMITTED');
  assert.equal(f.flow.store.getTask(second.id)?.status, 'OPEN');
  assert.equal(f.flow.store.reviews(a.team).some(review => review.result_id === firstResult), false);
  assert.equal(f.flow.store.getMember(a.member.id)?.active_task_id, second.id);
  assert.equal(f.created.filter(id => id === a.member.id).length, 1, 'subsequent tasks reuse the same standard Agent');
});

test('pausing one task drains its native turn without blocking another independent task on the same member', async t => {
  const f = fixture(t), a = await f.startMember();
  const next = await f.flow.task('owner', { team_id: a.team, action: 'delegate', member_id: a.member.id, objective: 'An independent obligation' });
  await tick();
  assert.equal(a.native.inputs.length, 1, 'a busy native Agent cannot start overlapping work');
  await f.flow.control('owner', { team_id: a.team, target: 'task', id: a.task.id, action: 'pause' });
  await until(() => a.native.cancelled === 1 && a.native.inputs.length === 2 && a.native.running());
  assert.equal(f.flow.store.getTask(a.task.id)?.paused, true);
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'OPEN');
  assert.equal(f.flow.store.getTask(next.id)?.paused, false);
  assert.equal(f.flow.store.getMember(a.member.id)?.active_task_id, next.id);
  const nextSource = a.native.inputs[1]?.message.source;
  assert.equal(nextSource?.kind, 'flow-task');
  assert.ok(nextSource?.kind === 'flow-task');
  assert.equal(nextSource.task_id, next.id);
  assert.equal(f.created.filter(id => id === a.member.id).length, 1);
  assert.equal(a.native.disposed, 0, 'a task pause keeps the reusable standard Agent');
});
