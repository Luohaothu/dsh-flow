/** Replays and delayed native ingress must not restart, cancel or duplicate work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledNative, fixture, tick, until } from './native-fixture.ts';

function attachOwner(f: ReturnType<typeof fixture>): ControlledNative {
  const owner = new ControlledNative({ sessionId: 'owner', workspace: f.dir, setup: () => {}, onEvent: event => f.emit(owner.session, event) });
  f.agents.set('owner', owner.agent);
  return owner;
}

test('replaying a cached pause after resume cannot cancel the newly running native turn', async t => {
  const f = fixture(t), a = await f.startMember();
  const pause = { team_id: a.team, target: 'member' as const, id: a.member.id, action: 'pause' as const };
  await f.flow.control('owner', pause, 'pause-once');
  await until(() => a.native.cancelled === 1 && !a.native.running());
  await f.flow.control('owner', { ...pause, action: 'resume' }, 'resume-once');
  await until(() => a.native.running() && a.native.inputs.length === 2);
  await f.flow.control('owner', pause, 'pause-once');
  await tick(); await tick();
  assert.equal(a.native.cancelled, 1, 'a cached receipt must not repeat native cancellation');
  assert.equal(a.native.running(), true);
  assert.equal(f.flow.store.getMember(a.member.id)?.state, 'running');
  assert.equal(f.flow.store.getTask(a.task.id)?.paused, false);
});

test('pausing a queued task while its native factory is pending prevents the eventual dispatch', async t => {
  let pending: ControlledNative | undefined;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let creations = 0;
  const f = fixture(t, 2, async native => {
    if (++creations === 1) return;
    pending = native;
    await gate;
  });
  t.after(release);
  const a = await f.startMember();
  const child = await f.flow.task(a.member.id, { action: 'delegate', objective: 'Independent child' });
  await until(() => pending !== undefined);
  await f.flow.control(a.member.id, { target: 'task', id: child.id, action: 'pause' });
  assert.equal(f.flow.store.getTask(child.id)?.paused, true);
  release();
  await until(() => f.handles.has(child.assignee_session_id));
  await tick(); await tick();
  assert.equal(pending?.inputs.length, 0, 'post-creation admission must recheck the durable task pause');
  assert.equal(pending?.running(), false);
  await f.flow.control(a.member.id, { target: 'task', id: child.id, action: 'resume' });
  await until(() => pending?.running() === true);
  assert.equal(pending?.inputs.length, 1, 'an explicit resume dispatches the task exactly once');
});

test('a cached already-delivered owner message does not send a second native input', async t => {
  const f = fixture(t), a = await f.startMember(), owner = attachOwner(f);
  const request = { to: 'owner', content: 'The requested result is available', task_id: a.task.id };
  const first = await f.flow.message(a.member.id, request, 'owner-message');
  assert.equal(first.state, 'delivered', 'native ingress was observed by the real controller');
  const retry = await f.flow.message(a.member.id, request, 'owner-message');
  assert.equal(retry.id, first.id);
  assert.equal(owner.inputs.length, 1);
  assert.equal(f.flow.teamRead('owner', a.team).messages.length, 1);
});

for (const recipient of ['owner', 'member'] as const) test(`a ${recipient} message claimed from native Inbox is not duplicated before user/message append`, async t => {
  const f = fixture(t), a = await f.startMember();
  const native = recipient === 'owner' ? attachOwner(f) : a.native;
  // Native ingress commits an insertion, then claims/removes it before adding
  // the model-visible user/message. Reproduce that real rc2 durability window.
  native.send = (message, mode) => {
    native.inputs.push({ message, mode });
    const target = mode === 'followup' ? 'next-turn' : 'next-step';
    const inserted = native.session.append('agent/inbox/spliced', { target, start: 0, inserted: [message] });
    native.options.onEvent?.(inserted);
    const claimed = native.session.append('agent/inbox/spliced', { target, start: 0, removedCount: 1, inserted: [] });
    native.options.onEvent?.(claimed);
    if (mode !== 'notice') native.hold();
  };
  const request = { team_id: a.team, to: recipient === 'owner' ? 'owner' : a.member.id, content: 'One meaningful follow-up' };
  const actor = recipient === 'owner' ? a.member.id : 'owner';
  const first = await f.flow.message(actor, request, 'claimed-message');
  assert.equal(native.nextTurn.length + native.nextStep.length, 0);
  assert.equal(native.events().filter(event => event.type === 'user/message' && event.data.source.kind === 'flow-message').length, 0);
  await f.flow.message(actor, request, 'claimed-message');
  await tick();
  const matchingInputs = native.inputs.filter(input => input.message.source.kind === 'flow-message' && input.message.source.message_id === first.id);
  assert.equal(matchingInputs.length, 1, 'native committed ingress proves this business message was already sent');
});


test('work revised during native creation is dispatched at its current version without a lost wake', async t => {
  const f = fixture(t, 1, native => {
    const member = f.flow.store.getMember(native.options.sessionId)!;
    const task = f.flow.store.tasks(member.team_id).find(task => task.assignee_session_id === member.id)!;
    if (task.version === 1) void f.flow.task('owner', { action: 'update', task_id: task.id, version: task.version, objective: 'Use the revised actual task' }, 'revise-during-create');
  });
  const started = await f.startMember();
  await until(() => started.native.inputs.length === 1);
  assert.equal(started.native.inputs[0]!.message.source.kind, 'flow-task');
  const source = started.native.inputs[0]!.message.source;
  assert.ok(source.kind === 'flow-task');
  assert.equal(source.task_version, 2);
  assert.match(started.native.inputs[0]!.message.content[0]!.type === 'text' ? started.native.inputs[0]!.message.content[0]!.text : '', /revised actual task/);
});
