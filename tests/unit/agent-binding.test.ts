/** A native binding is published independently of its complete execution job. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, until } from './native-fixture.ts';

test('a queued member binding resolves as its existing job publishes the native Agent', async t => {
  const f = fixture(t, 1), active = await f.startMember();
  const child = await f.flow.task(active.member.id, { action: 'delegate', objective: 'Independent work waiting for execution' });
  await tick();
  assert.equal(f.handles.has(child.assignee_session_id), false);

  let bound = false;
  const binding = f.flow.ensureAgent(child.assignee_session_id).then(agent => { bound = true; return agent; });
  active.native.finish();
  await until(() => f.handles.get(child.assignee_session_id)?.running() === true);
  await until(() => bound);
  const childNative = f.handles.get(child.assignee_session_id)!;
  assert.equal(await binding, childNative.agent);
  assert.equal(childNative.running(), true, 'obtaining a binding does not wait for the native turn to finish');
  assert.equal(f.created.filter(id => id === child.assignee_session_id).length, 1, 'the task and SessionDriver share one native owner');
});

test('cancelling a queued member rejects its pending native binding without creating an Agent', async t => {
  const f = fixture(t, 1), active = await f.startMember();
  const child = await f.flow.task(active.member.id, { action: 'delegate', objective: 'Optional work waiting for execution' });
  await tick();

  let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
  let reason: unknown;
  const binding = f.flow.ensureAgent(child.assignee_session_id).then(
    () => { outcome = 'resolved'; },
    error => { outcome = 'rejected'; reason = error; },
  );
  await f.flow.control(active.member.id, { target: 'member', id: child.assignee_session_id, action: 'cancel' });
  await until(() => outcome !== 'pending');
  await binding;
  assert.equal(outcome, 'rejected', 'a removed execution job cannot leave its binding promise unresolved');
  assert.ok(reason instanceof Error);
  active.native.finish();
  await tick(); await tick();
  assert.equal(f.handles.has(child.assignee_session_id), false);
  assert.equal(f.flow.store.getMember(child.assignee_session_id)?.state, 'closed');
});

test('binding an idle member does not publish its previous reply as a revised task result', async t => {
  const f = fixture(t, 1), active = await f.startMember();
  active.native.finish('First draft that needs correction.');
  await until(() => !!f.flow.store.getTask(active.task.id)?.result_id);
  const previous = f.flow.store.getTask(active.task.id)!.result_id!;
  await tick(); await tick();

  const binding = f.flow.ensureAgent(active.member.id);
  await f.flow.review('owner', { result_id: previous, accepted: false, notes: 'Correct the rejected draft' });
  assert.equal(await binding, active.native.agent);
  await until(() => active.native.inputs.length === 2);
  assert.equal(f.flow.store.getTask(active.task.id)?.version, 2);
  assert.equal(f.flow.store.getTask(active.task.id)?.status, 'OPEN');
  assert.equal(f.flow.store.getTask(active.task.id)?.result_id, null, 'the previous completed native return cannot finish the revised work');
  assert.equal(f.flow.teamRead('owner', active.team).results.length, 1);
});
