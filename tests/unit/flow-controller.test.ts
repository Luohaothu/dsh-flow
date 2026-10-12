/** Test collaboration facts against the real controller/store; native execution is an injected boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { FlowController } from '../../packages/dsh-flow/src/core/controller.ts';
import { FlowStore } from '../../packages/dsh-flow/src/core/store.ts';

import { ControlledNative, fixture, tick, until } from './native-fixture.ts';

test('creation is scoped by owner and intent; changed input conflicts, while intentional duplicate work is distinct', async t => {
  const f = fixture(t), initial = await f.startTeam();
  const retry = await f.flow.createTeam('owner', 'start', { objective: 'Deliver a checked report' });
  assert.equal(retry.run.id, initial.team); assert.equal(retry.members.length, 0);
  await assert.rejects(f.flow.createTeam('owner', 'start', { objective: 'Different work' }), /different input/);
  const second = await f.flow.createTeam('owner', 'new-intent', { objective: 'Deliver a checked report' });
  assert.notEqual(second.run.id, initial.team);
  assert.throws(() => f.flow.teamRead('stranger', initial.team), /does not own/);
  const outsider = await f.startMember('outsider-team');
  assert.throws(() => f.flow.read(outsider.member.id, { team_id: initial.team }), /does not own/);
  assert.deepEqual(f.flow.teamRuns('stranger'), []);
});

test('the existing native owner holds the root task without an automatic Agent or Flow ownership of its lifecycle', async t => {
  const f = fixture(t);
  const owner = new ControlledNative({ sessionId: 'owner', workspace: f.dir, setup: () => {}, onEvent: event => f.emit(owner.session, event) });
  f.agents.set('owner', owner.agent); owner.hold();
  const root = await f.startTeam(); await tick(); await tick();
  const initial = f.flow.teamRead('owner', root.team);
  assert.equal(initial.members.length, 0);
  assert.equal(initial.tasks.length, 1);
  assert.equal(root.rootTask.owner_session_id, 'owner');
  assert.equal(root.rootTask.assignee_session_id, 'owner');
  assert.equal(root.rootTask.parent_id, null);
  assert.deepEqual(f.created, []);
  assert.equal(f.flow.agentSession('owner'), null);
  assert.equal(f.flow.isTeamAgentSession('owner'), false);
  assert.equal(owner.inputs.length, 0, 'creating collaboration facts must not redispatch the owner objective');
  await f.reopen(); await tick(); await tick();
  assert.deepEqual(f.created, [], 'recovery does not create a replacement owner');
  assert.equal(f.flow.teamRead('owner', root.team).tasks[0]?.id, root.rootTask.id);
  const partial = await f.flow.result('owner', { task_id: root.rootTask.id, summary: 'Still checking', outcome: 'partial' });
  await assert.rejects(f.flow.review('owner', { result_id: partial.id, accepted: true, notes: 'Incomplete' }), /partial or blocked/);
  const result = await f.flow.result('owner', { task_id: root.rootTask.id, summary: 'Main session completed and checked its own deliverable', artifacts: ['report.md'] });
  assert.equal(result.author_session_id, 'owner');
  assert.equal(result.task_version, root.rootTask.version);
  assert.equal(result.ready, true, 'an existing owner can complete its business result within its native turn');
  await assert.rejects(f.flow.review('owner', { result_id: partial.id, accepted: true, notes: 'Stale' }), /current/);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Checked final report', evidence: ['report.md'] });
  await tick(); await tick();
  assert.equal(f.flow.teamRead('owner', root.team).run.state, 'completed');
  assert.equal(f.flow.store.getTask(root.rootTask.id)?.status, 'ACCEPTED');
  await f.flow.dispose();
  assert.deepEqual(f.created, []);
  assert.equal(owner.cancelled, 0);
  assert.equal(owner.disposed, 0);
  assert.equal(owner.inputs.length, 0, 'no completion message wakes or steers the root author itself');
  assert.equal(owner.running(), true, 'native main turn completion belongs to DSH');
  owner.finish();
});

test('only the current complete result can be accepted by its requester, after native work becomes idle', async t => {
  const f = fixture(t), a = await f.startMember();
  await assert.rejects(f.flow.result('owner', { task_id: a.task.id, summary: 'impersonated' }), /Only the assignee/);
  const first = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'first output' }, 'result-first');
  assert.equal(first.ready, false);
  await assert.rejects(f.flow.review('owner', { result_id: first.id, accepted: true, notes: 'Too soon' }), /ready/);
  a.native.finish(); await until(() => f.flow.store.getResult(first.id)?.ready === true);
  const partial = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'missing sources', outcome: 'partial' });
  await assert.rejects(f.flow.review('owner', { result_id: first.id, accepted: true, notes: 'stale' }), /current/);
  await assert.rejects(f.flow.review('owner', { result_id: partial.id, accepted: true, notes: 'partial' }), /partial or blocked/);
  const current = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'checked output', artifacts: ['report.md'] });
  await assert.rejects(f.flow.review(a.member.id, { result_id: current.id, accepted: true, notes: 'self authorizes' }), /Only the task owner/);
  await f.flow.review('owner', { result_id: current.id, accepted: true, notes: 'Opened report and verified its sources', evidence: ['report.md'] });
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running', 'a delegated result does not complete the owner root task');
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'ACCEPTED');
  const rootResult = await f.flow.result('owner', { task_id: a.rootTask.id, summary: 'Integrated the checked child deliverable' });
  await f.flow.review('owner', { result_id: rootResult.id, accepted: true, notes: 'Verified the complete report and its accepted child' });
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'completed');
});

test('ordinary members can delegate recursively and the requester checks each child before the parent result', async t => {
  const f = fixture(t), a = await f.startMember();
  assert.equal(a.task.parent_id, a.rootTask.id);
  const child = await f.flow.task(a.member.id, { action: 'delegate', objective: 'Collect source data' }, 'child');
  const retried = await f.flow.task(a.member.id, { objective: 'Collect source data', action: 'delegate' }, 'child');
  assert.equal(retried.id, child.id);
  await until(() => f.handles.get(child.assignee_session_id)?.running() === true);
  const grandchild = await f.flow.task(child.assignee_session_id, { action: 'delegate', objective: 'Check source date' }, 'grandchild');
  assert.equal(grandchild.parent_id, child.id);
  await until(() => f.handles.get(grandchild.assignee_session_id)?.running() === true);
  const c = f.handles.get(child.assignee_session_id)!, g = f.handles.get(grandchild.assignee_session_id)!;
  c.finish(); g.finish(); await tick(); await tick();
  const childResult = await f.flow.result(child.assignee_session_id, { task_id: child.id, summary: 'source data' });
  await assert.rejects(f.flow.review(a.member.id, { result_id: childResult.id, accepted: true, notes: 'unchecked child' }), /unfinished child/);
  const grandResult = await f.flow.result(grandchild.assignee_session_id, { task_id: grandchild.id, summary: 'source date verified' });
  await f.flow.review(child.assignee_session_id, { result_id: grandResult.id, accepted: true, notes: 'Checked timestamp' });
  await f.flow.review(a.member.id, { result_id: childResult.id, accepted: true, notes: 'Checked raw file' });
  assert.equal(f.flow.teamRead('owner', a.team).members.length, 3, 'no fixed manager roles are created');
});

test('rejecting a result revises the same task; its old result cannot complete the correction', async t => {
  const f = fixture(t), a = await f.startMember();
  a.native.finish(); await tick(); await tick();
  const old = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'wrong date' });
  await f.flow.review('owner', { result_id: old.id, accepted: false, notes: 'Use the requested market date' });
  const updated = f.flow.store.getTask(a.task.id)!;
  assert.equal(updated.version, 2); assert.equal(updated.status, 'OPEN');
  assert.equal(f.flow.teamRead('owner', a.team).tasks.length, 2, 'the existing owner root and revised child remain distinct');
  await assert.rejects(f.flow.review('owner', { result_id: old.id, accepted: true, notes: 'stale retry' }), /current/);
  await until(() => a.native.inputs.length >= 2);
  a.native.finish(); await tick(); await tick();
  const corrected = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'correct date' });
  assert.equal(corrected.task_version, 2);
  await f.flow.review('owner', { result_id: corrected.id, accepted: true, notes: 'Date now matches' });
});

test('delegation returns while capacity is busy; native idle releases the slot without accepting business work', async t => {
  const f = fixture(t, 1), a = await f.startMember();
  const child = await f.flow.task(a.member.id, { action: 'delegate', objective: 'Independent work' });
  await tick(); assert.equal(f.handles.has(child.assignee_session_id), false);
  a.native.finish();
  await until(() => f.handles.get(child.assignee_session_id)?.running() === true);
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'OPEN');
  assert.equal(a.native.disposed, 0, 'an ordinary idle turn keeps the owned native handle');
  f.handles.get(child.assignee_session_id)!.finish(); await tick(); await tick();
  const inputs = a.native.inputs.length; await tick(); await tick();
  assert.equal(a.native.inputs.length, inputs, 'no new business event creates no synthetic query or repair turn');
});

test('Flow message retries preserve a concrete delivery and ordinary text does not cancel the member', async t => {
  const f = fixture(t), a = await f.startMember();
  const input = { team_id: a.team, to: a.member.id, content: 'Do not stop; include the word stop in the report', mode: 'request' as const };
  const sent = await f.flow.message('owner', input, 'send-one');
  const retried = await f.flow.message('owner', input, 'send-one');
  assert.equal(retried.id, sent.id);
  assert.equal(f.flow.store.getMessage(sent.id)?.state, 'delivered');
  assert.equal(a.native.inputs.filter(value => value.message.source.kind === 'flow-message' && value.message.source.message_id === sent.id).length, 1);
  assert.equal(a.native.cancelled, 0);
  await assert.rejects(f.flow.message('owner', { ...input, content: 'different' }, 'send-one'), /different input/);
});

test('cancellation closes task authority before native late callbacks can submit success', async t => {
  const f = fixture(t), a = await f.startMember();
  await f.flow.control('owner', { team_id: a.team, target: 'team', id: a.team, action: 'cancel' }, 'stop');
  a.native.finish('late output');
  await until(() => a.native.cancelled > 0);
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'CANCELLED');
  assert.equal(f.flow.teamRead('owner', a.team).results.length, 0);
  await assert.rejects(f.flow.result(a.member.id, { task_id: a.task.id, summary: 'late submit' }), /closed/);
  assert.equal(f.flow.agentSession(a.member.id)?.can_message, false);
});

test('cold recovery preserves current results and command identity without fabricating acceptance', async t => {
  const f = fixture(t), a = await f.startMember();
  a.native.finish(); await tick(); await tick();
  const result = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'saved report' }, 'saved-result');
  await f.reopen(); await tick(); await tick();
  const snapshot = f.flow.teamRead('owner', a.team);
  assert.equal(snapshot.run.state, 'running');
  assert.equal(snapshot.tasks.find(task => task.id === a.task.id)?.status, 'SUBMITTED');
  assert.equal(snapshot.tasks.find(task => task.id === a.rootTask.id)?.status, 'OPEN');
  assert.equal(snapshot.results[0]!.id, result.id);
  const retry = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'saved report' }, 'saved-result');
  assert.equal(retry.id, result.id); assert.equal(f.flow.teamRead('owner', a.team).results.length, 1);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Inspected saved report after restart' });
});

test('old schema is refused while its bytes and tables remain intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-schema-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE historical(id TEXT); INSERT INTO historical VALUES (\'preserve\'); PRAGMA user_version=5;'); db.close();
  const before = readFileSync(path);
  assert.throws(() => new FlowStore(path), /new dataDir/);
  assert.deepEqual(readFileSync(path), before);
  const reopened = new DatabaseSync(path, { readOnly: true });
  assert.equal(reopened.prepare('SELECT id FROM historical').get()?.id, 'preserve'); reopened.close();
});

test('a restored native task already in the Inbox is observed without a second task dispatch', async t => {
  const f = fixture(t, 1, native => {
    const member = f.flow.store.getMember(native.options.sessionId)!;
    const task = f.flow.store.tasks(member.team_id).find(task => task.assignee_session_id === member.id)!;
    native.nextTurn.push(createUserMessage({ source: { kind: 'flow-task', team_id: task.team_id, task_id: task.id, task_version: task.version }, content: [{ type: 'text', text: 'Original persisted task input' }] }));
    native.hold();
  });
  const a = await f.startMember(); await tick();
  assert.equal(a.native.inputs.length, 0, 'the factory restored pending input, so Flow must not append another');
  assert.equal(a.native.nextTurn.length, 1);
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'OPEN');
});

test('input arriving during the native idle flush keeps the result unready until the new work drains', async t => {
  const f = fixture(t), a = await f.startMember();
  const result = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'Result awaiting native quiescence' });
  let release: () => void = () => {};
  const checkpoint = new Promise<void>(resolve => { release = resolve; });
  let flushes = 0;
  a.native.flush = async () => { flushes++; if (flushes === 1) await checkpoint; };
  a.native.finish(); await until(() => flushes === 1);
  a.native.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish the additional native check' }] }), 'followup');
  release(); await tick(); await tick();
  assert.equal(a.native.running(), true);
  assert.equal(f.flow.store.getResult(result.id)?.ready, false);
  await assert.rejects(f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Still running' }), /ready/);
  a.native.finish(); await until(() => f.flow.store.getResult(result.id)?.ready === true);
  assert.ok(flushes >= 2, 'the second idle boundary is observed instead of dropping its activity');
});

test('a deliberately cancelled child does not permanently prevent review of the completed parent', async t => {
  const f = fixture(t), a = await f.startMember();
  const child = await f.flow.task(a.member.id, { action: 'delegate', objective: 'Optional investigation' });
  await f.flow.control(a.member.id, { target: 'task', id: child.id, action: 'cancel' });
  const result = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'Completed without the optional child' });
  a.native.finish(); await until(() => f.flow.store.getResult(result.id)?.ready === true);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Confirmed the optional work is unnecessary' });
  assert.equal(f.flow.store.getTask(child.id)?.status, 'CANCELLED');
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running', 'a delegated result does not complete the owner root task');
});

test('updating failed work clears the assignee failure so the corrected task can dispatch', async t => {
  const f = fixture(t), a = await f.startMember();
  const child = await f.flow.task(a.member.id, { action: 'delegate', objective: 'Child work' });
  await until(() => f.handles.get(child.assignee_session_id)?.running() === true);
  const childNative = f.handles.get(child.assignee_session_id)!;
  childNative.finish(); await tick(); await tick();
  const member = f.flow.store.getMember(child.assignee_session_id)!;
  f.flow.store.put('members', { ...member, state: 'failed', error: 'Native provider failed' });
  f.flow.store.put('tasks', { ...f.flow.store.getTask(child.id)!, status: 'FAILED' });
  const revised = await f.flow.task(a.member.id, { action: 'update', task_id: child.id, version: child.version, objective: 'Retry corrected work' });
  await until(() => childNative.running());
  assert.equal(revised.status, 'OPEN');
  assert.equal(f.flow.store.getMember(member.id)?.error, null);
  assert.equal(childNative.inputs.length, 2);
});

test('closed or paused members cannot mutate collaboration facts after cancellation begins', async t => {
  const f = fixture(t), a = await f.startMember();
  await f.flow.control('owner', { team_id: a.team, target: 'member', id: a.member.id, action: 'pause' });
  await assert.rejects(f.flow.task(a.member.id, { action: 'delegate', objective: 'Late delegation' }), /paused/);
  await assert.rejects(f.flow.message(a.member.id, { to: 'owner', content: 'Late mutation' }), /paused/);
  assert.equal(f.flow.read(a.member.id, { what: 'task' }).total, 2, 'passive reads of root and child remain available');
});

test('a legacy cluster.sqlite directory is rejected before a new Flow database is created', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-legacy-dir-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cluster.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE legacy(id TEXT); PRAGMA user_version=5;'); db.close();
  const before = readFileSync(path);
  assert.throws(() => new FlowController(fromPartial<Context>({}), { dataDir: dir, workspace: dir, preset: null, maxConcurrentAgents: 1 }), /new dataDir/);
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() => readFileSync(join(dir, 'flow.sqlite')), { code: 'ENOENT' });
});

test('a native UI turn on an idle member is observed and its result becomes ready only after that turn drains', async t => {
  const f = fixture(t), a = await f.startMember();
  a.native.finish(); await until(() => f.flow.store.getMember(a.member.id)?.state === 'idle');
  await tick();
  const originalDispatches = a.native.inputs.length;
  // A direct native entry emits synchronously before its running-state flip;
  // it does not call Flow.promptAgent or add another Flow task input.
  const event = a.native.session.append('turn/start', { turn: 2 });
  a.native.options.onEvent?.(event);
  a.native.hold();
  await until(() => f.flow.store.getMember(a.member.id)?.state === 'running');
  const result = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'Verified in a directly started native turn' });
  assert.equal(result.ready, false);
  await assert.rejects(f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Premature' }), /ready/);
  a.native.finish(); await until(() => f.flow.store.getResult(result.id)?.ready === true);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Native work has drained; checked its result' });
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running', 'a delegated result does not complete the owner root task');
  assert.equal(a.native.inputs.length, originalDispatches, 'observing a native turn must not re-dispatch its task');
  assert.equal(f.created.filter(id => id === a.member.id).length, 1, 'one native owner is retained');
});
