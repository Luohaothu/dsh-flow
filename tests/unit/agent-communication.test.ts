/** Communication handoff remains independent of native execution scheduling. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, until } from './native-fixture.ts';

function handoffs(f: ReturnType<typeof fixture>, team: string, id: string) {
  return f.flow.store.events(team).filter(event => event.type === 'message-received'
    && (event.data as { message_id?: string }).message_id === id);
}

test('a cold recipient accepts a message while all execution units are occupied', async t => {
  const f = fixture(t, 1), busy = await f.startMember();
  const task = await f.flow.task(busy.member.id, { action: 'delegate', objective: 'Work after the current execution completes' });
  await tick();
  assert.equal(f.handles.has(task.assignee_session_id), false);
  let returned: Awaited<ReturnType<typeof f.flow.message>> | undefined;
  const submission = f.flow.message('owner', { team_id: busy.team, to: task.assignee_session_id,
    task_id: task.id, content: 'Include the supplied supplementary evidence' }, 'cold-message')
    .then(message => { returned = message; });
  await until(() => returned !== undefined);
  await submission;
  const sent = returned!;
  assert.ok(sent.id, 'the submission returns its persistent message identifier');
  await until(() => handoffs(f, busy.team, sent.id).length === 1);
  assert.equal(f.handles.has(task.assignee_session_id), false, 'handoff creates no native Agent outside the execution queue');
  assert.equal(f.flow.store.getMessage(sent.id)?.state, 'queued', 'acceptance is distinct from native delivery');
  assert.equal(f.flow.store.events(busy.team).filter(event => event.type === 'message-delivered'
    && (event.data as { message_id?: string }).message_id === sent.id).length, 0);
  busy.native.finish();
  await until(() => f.flow.store.getMessage(sent.id)?.state === 'delivered');
  const native = f.handles.get(task.assignee_session_id)!;
  assert.equal(native.inputs.filter(input => input.message.source.kind === 'flow-message'
    && input.message.source.message_id === sent.id).length, 1);
});

for (const mode of ['request', 'notice'] as const) test(`a full execution queue permits ${mode} delivery to a running Agent`, async t => {
  const f = fixture(t, 1), busy = await f.startMember();
  const queued = await f.flow.task(busy.member.id, { action: 'delegate', objective: 'Remain queued while the parent executes' });
  const sent = await f.flow.message('owner', { team_id: busy.team, to: busy.member.id,
    task_id: busy.task.id, content: 'Supplement the current work without waiting for another execution unit', mode }, `active-${mode}`);
  await until(() => f.flow.store.getMessage(sent.id)?.state === 'delivered');
  const inputs = busy.native.inputs.filter(input => input.message.source.kind === 'flow-message'
    && input.message.source.message_id === sent.id);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.mode, mode === 'request' ? 'steer' : 'notice');
  assert.equal(handoffs(f, busy.team, sent.id).length, 1);
  assert.equal(f.handles.has(queued.assignee_session_id), false);
  assert.equal(busy.native.running(), true);
  assert.equal(busy.native.cancelled, 0);
});

test('recovery dispatches an accepted pending message once without a second communication handoff', async t => {
  const f = fixture(t, 1), busy = await f.startMember();
  const task = await f.flow.task(busy.member.id, { action: 'delegate', objective: 'Continue the accepted communication after restart' });
  const request = { team_id: busy.team, to: task.assignee_session_id,
    task_id: task.id, content: 'Persist this instruction before execution begins' };
  const sent = await f.flow.message('owner', request, 'persisted-accepted-message');
  await until(() => handoffs(f, busy.team, sent.id).length === 1);
  assert.equal(f.handles.has(task.assignee_session_id), false);
  assert.equal(f.flow.store.getMessage(sent.id)?.state, 'queued');
  // Pause the team through its public control interface to keep the accepted
  // receiver cold until the new runtime has reconstructed its registrations.
  await f.flow.control('owner', { team_id: busy.team, target: 'team', id: busy.team, action: 'pause' });
  await until(() => !busy.native.running());
  await f.reopen(); await tick();
  assert.equal(f.handles.has(task.assignee_session_id), false);
  assert.equal(handoffs(f, busy.team, sent.id).length, 1);
  assert.equal(f.flow.store.getMessage(sent.id)?.state, 'queued');
  await f.flow.control('owner', { team_id: busy.team, target: 'team', id: busy.team, action: 'resume' });
  await until(() => f.created.filter(id => id === busy.member.id).length === 2 && f.handles.get(busy.member.id)?.running() === true);
  f.handles.get(busy.member.id)!.finish();
  await until(() => f.flow.store.getMessage(sent.id)?.state === 'delivered');
  const native = f.handles.get(task.assignee_session_id)!;
  const retries = await f.flow.message('owner', request, 'persisted-accepted-message');
  assert.equal(retries.id, sent.id);
  await tick(); await tick();
  assert.equal(handoffs(f, busy.team, sent.id).length, 1, 'recovery uses the accepted message record rather than repeating its callback');
  assert.equal(native.inputs.filter(input => input.message.source.kind === 'flow-message'
    && input.message.source.message_id === sent.id).length, 1);
});
