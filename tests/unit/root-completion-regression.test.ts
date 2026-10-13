/** Root completion must avoid a model self-review while preserving collaboration boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlledNative, fixture, tick, until } from './native-fixture.ts';

test('the native owner completes its root by one explicit result without self-review or native lifecycle ownership', async t => {
  const f = fixture(t), root = await f.startTeam();
  const owner = new ControlledNative({ sessionId: 'owner', workspace: f.dir, setup() {} });
  owner.hold(); f.agents.set('owner', owner.agent);
  const request = { task_id: root.rootTask.id, summary: 'Checked report.md against the saved raw data', artifacts: ['report.md'] };
  const result = await f.flow.result('owner', request, 'root-complete');
  let snapshot = f.flow.teamRead('owner', root.team);
  assert.equal(snapshot.run.state, 'completed');
  assert.equal(snapshot.tasks[0]?.status, 'ACCEPTED');
  assert.equal(snapshot.tasks[0]?.result_id, result.id);
  assert.equal(result.author_session_id, 'owner');
  assert.equal(result.task_version, root.rootTask.version);
  assert.equal(result.ready, true);
  assert.deepEqual(snapshot.reviews, [], 'the author declaration is not a fabricated independent review');
  assert.equal((await f.flow.result('owner', request, 'root-complete')).id, result.id);
  await tick(); await tick();
  assert.equal(owner.cancelled, 0); assert.equal(owner.disposed, 0); assert.equal(owner.running(), true);
  assert.deepEqual(f.created, []); assert.deepEqual(owner.inputs, []);
  await f.reopen();
  assert.equal((await f.flow.result('owner', request, 'root-complete')).id, result.id, 'retry survives cold controller recovery');
  snapshot = f.flow.teamRead('owner', root.team);
  assert.equal(snapshot.results.length, 1); assert.equal(snapshot.reviews.length, 0);
  assert.equal(owner.cancelled, 0); assert.equal(owner.disposed, 0);
  owner.finish();
});

test('root completion rejects unfinished children atomically and accepts only after their requester review', async t => {
  const f = fixture(t), a = await f.startMember();
  const attempt = async (operation: string) => {
    const before = f.flow.teamRead('owner', a.team);
    await assert.rejects(f.flow.result('owner', { task_id: a.rootTask.id, summary: 'Finish too early' }, operation), /unfinished child/);
    const after = f.flow.teamRead('owner', a.team);
    assert.deepEqual(after.results, before.results, 'no result record survives a refused completion');
    assert.deepEqual(after.events, before.events, 'no completion event survives a refused transaction');
    assert.equal(after.run.state, 'running');
    assert.equal(f.flow.store.getTask(a.rootTask.id)?.status, 'OPEN');
  };
  await attempt('while-child-open');
  const child = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'Saved child artifact', artifacts: ['child.json'] }, 'child-result');
  await attempt('while-child-running');
  a.native.finish(); await until(() => f.flow.store.getResult(child.id)?.ready === true);
  await attempt('ready-is-not-accepted');
  await f.flow.review('owner', { result_id: child.id, accepted: true, notes: 'Checked child.json' }, 'child-review');
  const rootResult = await f.flow.result('owner', { task_id: a.rootTask.id, summary: 'Integrated accepted child' }, 'root-complete');
  const done = f.flow.teamRead('owner', a.team);
  assert.equal(done.run.state, 'completed');
  assert.equal(f.flow.store.getTask(a.rootTask.id)?.result_id, rootResult.id);
  assert.equal(done.reviews.length, 1, 'only the real delegatee acceptance review is recorded');
  assert.equal(done.reviews[0]?.result_id, child.id);
});

test('partial and blocked root declarations stay open for follow-up, while an authorized cancelled child does not block final completion', async t => {
  const f = fixture(t), a = await f.startMember();
  for (const outcome of ['partial', 'blocked'] as const) {
    const result = await f.flow.result('owner', { task_id: a.rootTask.id, summary: 'Source needs follow-up', outcome }, `root-${outcome}`);
    assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running');
    assert.equal(f.flow.store.getTask(a.rootTask.id)?.status, 'SUBMITTED');
    assert.equal(f.flow.store.getTask(a.rootTask.id)?.result_id, result.id);
  }
  await f.flow.control('owner', { team_id: a.team, target: 'task', id: a.task.id, action: 'cancel' }, 'cancel-unneeded-child');
  await f.flow.result('owner', { task_id: a.rootTask.id, summary: 'Completed the remaining work directly' }, 'root-complete');
  const done = f.flow.teamRead('owner', a.team);
  assert.equal(done.run.state, 'completed'); assert.equal(done.reviews.length, 0);
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'CANCELLED');
});

test('a natural member return publishes once only after native idle and flush, and still needs its requester review', async t => {
  const f = fixture(t), a = await f.startMember();
  let release!: () => void;
  const flush = new Promise<void>(resolve => { release = resolve; });
  a.native.flush = () => flush;
  a.native.finish('Saved child.json; checked its three dated values.');
  await tick();
  assert.equal(f.flow.store.getTask(a.task.id)?.result_id, null, 'native final text alone does not bypass durability');
  release();
  await until(() => !!f.flow.store.getTask(a.task.id)?.result_id);
  const resultId = f.flow.store.getTask(a.task.id)!.result_id!;
  const result = f.flow.store.getResult(resultId)!;
  assert.equal(result.ready, true); assert.equal(result.author_session_id, a.member.id);
  assert.equal(result.summary, 'Saved child.json; checked its three dated values.');
  assert.deepEqual(result.artifacts, [], 'ordinary text remains a summary rather than a new parsed artifact protocol');
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'SUBMITTED');
  assert.equal(f.flow.teamRead('owner', a.team).reviews.length, 0);
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running');
  await tick(); await tick();
  assert.equal(f.flow.teamRead('owner', a.team).results.length, 1);
  await f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Opened and checked child.json' });
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'ACCEPTED');
  assert.equal(f.flow.teamRead('owner', a.team).run.state, 'running', 'child acceptance cannot finish the owner root');
});

test('a natural return cannot overwrite an explicit blocked result or infer business completion from prose', async t => {
  const f = fixture(t), a = await f.startMember();
  const result = await f.flow.result(a.member.id, { task_id: a.task.id, summary: 'HTTP source unavailable', outcome: 'blocked' }, 'blocked-result');
  a.native.finish('Completed this attempt; source still unavailable.');
  await until(() => f.flow.store.getResult(result.id)?.ready === true);
  const after = f.flow.teamRead('owner', a.team);
  assert.equal(after.results.length, 1);
  assert.equal(after.results[0]?.outcome, 'blocked');
  assert.equal(after.results[0]?.summary, 'HTTP source unavailable');
  assert.equal(f.flow.store.getTask(a.task.id)?.status, 'SUBMITTED');
  await assert.rejects(f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Idle is not success' }), /partial or blocked/);
  assert.equal(after.run.state, 'running');
});
