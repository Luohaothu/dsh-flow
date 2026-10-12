/** Persisted task order, not millisecond timestamp uniqueness, determines sequential member work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, until } from './native-fixture.ts';

test('tasks delegated to the same member in one millisecond wait for the preceding result to be accepted', async t => {
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
  const result = await f.flow.result(a.member.id, { task_id: first.id, summary: 'First task result awaits its owner review' });
  a.native.finish();
  await until(() => f.flow.store.getResult(result.id)?.ready === true);
  await tick(); await tick();
  assert.equal(f.flow.store.getTask(first.id)?.status, 'SUBMITTED');
  assert.equal(f.flow.store.getTask(second.id)?.status, 'OPEN');
  assert.equal(a.native.inputs.length, 2, 'the same-timestamp second task must remain queued while the first result is unaccepted');
  assert.equal(a.native.running(), false);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Verified the first task result' });
  await until(() => a.native.running() && a.native.inputs.length === 3);
  assert.equal(f.flow.store.getMember(a.member.id)?.active_task_id, second.id);
  assert.equal(f.created.filter(id => id === a.member.id).length, 1, 'subsequent tasks reuse the same standard Agent');
});
