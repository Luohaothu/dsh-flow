/** Updating queued work must not require cancelling another task on the same standard Agent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until, tick } from './native-fixture.ts';

test('a queued task can be revised while its reusable native Agent continues separate work', async t => {
  const f = fixture(t), active = await f.startMember();
  const queued = await f.flow.task('owner', { team_id: active.team, action: 'delegate', member_id: active.member.id, objective: 'Second independent obligation' });
  const revised = await f.flow.task('owner', { team_id: active.team, action: 'update', task_id: queued.id, version: queued.version, objective: 'Revised second obligation' });
  assert.equal(revised.version, 2);
  assert.equal(active.native.running(), true);
  assert.equal(active.native.cancelled, 0);
  assert.equal(active.native.inputs.length, 1);
  assert.equal(f.flow.store.getTask(active.task.id)?.version, 1);
  active.native.finish('First obligation delivered.');
  await until(() => active.native.inputs.length === 2);
  const next = JSON.stringify(active.native.inputs[1]);
  assert.ok(next.includes(queued.id));
  assert.ok(next.includes('Revised second obligation'));
  assert.equal(next.includes('Second independent obligation'), false);
  assert.equal(active.native.cancelled, 0);
  assert.equal(f.created.filter(id => id === active.member.id).length, 1);
});

test('a standard native member can also own a team whose parent is its new root', async t => {
  const f = fixture(t), outer = await f.startMember();
  const inner = await f.flow.createTeam(outer.member.id, 'new-human-intent', { objective: 'A separate collaboration owned by this same standard Agent' });
  const child = await f.flow.task(outer.member.id, { team_id: inner.run.id, action: 'delegate', objective: 'Independent inner work' });
  assert.equal(child.parent_id, inner.run.root_task_id);
  assert.equal(child.owner_session_id, outer.member.id);
  assert.equal(f.flow.store.getMember(child.assignee_session_id)?.parent_id, outer.member.id);
  assert.equal(f.flow.store.getTask(outer.task.id)?.version, 1);
  assert.equal(outer.native.cancelled, 0);
  outer.native.finish('Outer obligation delivered.');
  await tick(); await tick(); await tick();
  assert.equal(outer.native.inputs.length, 1, 'owning another team never re-dispatches its root as a worker task');
  assert.notEqual(f.flow.store.getMember(outer.member.id)?.active_task_id, inner.run.root_task_id);
});

test('a paused membership constrains only that team, not a new human-owned team', async t => {
  const f = fixture(t), outer = await f.startMember();
  await f.flow.control('owner', { team_id: outer.team, target: 'member', id: outer.member.id, action: 'pause' });
  await until(() => !outer.native.running());
  const pausedOuterTask = f.flow.store.getTask(outer.task.id);
  const inner = await f.flow.createTeam(outer.member.id, 'independent-human-intent', { objective: 'Independent new collaboration' });
  const child = await f.flow.task(outer.member.id, { team_id: inner.run.id, action: 'delegate', objective: 'New independent obligation' });
  assert.equal(child.parent_id, inner.run.root_task_id);
  assert.equal(f.flow.store.getMember(outer.member.id)?.state, 'paused');
  assert.deepEqual(f.flow.store.getTask(outer.task.id), pausedOuterTask);
  await assert.rejects(f.flow.task(outer.member.id, { team_id: outer.team, action: 'delegate', objective: 'Old paused work' }), /closed or paused/);
});
