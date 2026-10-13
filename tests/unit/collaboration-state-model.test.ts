/** Bounded reachable cuts of the real collaboration controller, not a mirrored state machine. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FlowResult, FlowTask } from '../../packages/dsh-flow/src/types.ts';
import { ControlledNative, fixture, tick, until } from './native-fixture.ts';

const cuts = ['open', 'submitted-not-ready', 'ready-complete', 'ready-partial', 'ready-blocked', 'accepted', 'cancelled'] as const;
type Cut = typeof cuts[number];
type Fixture = ReturnType<typeof fixture>;
const discharged = (cut: Cut) => cut === 'accepted' || cut === 'cancelled';
const rows = ['teams', 'members', 'tasks', 'results', 'reviews', 'messages', 'events', 'commands', 'sqlite_sequence'] as const;
const evidence = {
  bound: {
    sibling_tasks: 2, sibling_cuts: [...cuts], state_construction_orders: ['left-right', 'right-left'],
    sibling_combinations: cuts.length ** 2, sibling_traces: cuts.length ** 2 * 2,
    recursive_shape: 'existing native owner -> parent member -> child member', recursive_child_cuts: [...cuts],
    recursive_parent_cuts: ['open', 'submitted-not-ready', 'ready-complete'],
    version_case: { task_versions: 2, result_records: 3, actor_classes: ['requester', 'assignee', 'sibling', 'outsider'] },
  },
  completed: { sibling_traces: 0, recursive_traces: 0, identity_version_traces: 0 },
  attempts: [] as { trace: string; action: string; expected: 'accept' | 'reject'; durable_unchanged?: boolean }[],
  traces: [] as { name: string; cuts: string[]; root_completed: boolean }[],
  limitations: [
    'All task/result/review/control operations execute the actual FlowController and SQLite transactions.',
    'Native scheduling is the existing controllable fixture; no model, HTTP or actual native business tool executes.',
    'Enumerates specified reachable cuts and two sibling construction orders, not every asynchronous interleaving or unbounded task tree.',
    'Checks collaboration authority, versions, atomic completion and native-owner independence, not artifact correctness or wall-time speedup.',
  ],
};

function durable(f: Fixture): unknown {
  return Object.fromEntries(rows.map(table => [table, f.flow.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function quiet(): Promise<void> { await tick(); await tick(); }
function attachOwner(f: Fixture): ControlledNative {
  const owner = new ControlledNative({ sessionId: 'owner', workspace: f.dir, setup() {}, onEvent: event => f.emit(owner.session, event) });
  owner.hold(); f.agents.set('owner', owner.agent); return owner;
}
function assertOwnerUntouched(f: Fixture, owner: ControlledNative): void {
  assert.equal(f.agents.get('owner'), owner.agent);
  assert.equal(owner.running(), true, 'logical root completion cannot finish the native owner turn');
  assert.equal(owner.cancelled, 0); assert.equal(owner.disposed, 0);
  assert.ok(!f.created.includes('owner'), 'Flow must not create a replacement owner');
}
async function refuse(f: Fixture, trace: string, action: string, fn: () => Promise<unknown>, error: RegExp): Promise<void> {
  await quiet();
  const before = durable(f);
  await assert.rejects(fn(), error);
  assert.deepEqual(durable(f), before, 'a refused mutation must leave all durable facts, commands and event sequence unchanged');
  evidence.attempts.push({ trace, action, expected: 'reject', durable_unchanged: true });
}
async function delegate(f: Fixture, actor: string, team: string, label: string): Promise<FlowTask> {
  const task = await f.flow.task(actor, { action: 'delegate', team_id: team, objective: `Opaque business obligation ${label}` }, `delegate:${label}`);
  await until(() => f.handles.get(task.assignee_session_id)?.running() === true);
  return task;
}
async function prepare(f: Fixture, actor: string, task: FlowTask, cut: Cut): Promise<void> {
  const native = f.handles.get(task.assignee_session_id)!;
  if (cut === 'open') return;
  if (cut === 'cancelled') {
    await f.flow.control(actor, { team_id: task.team_id, target: 'task', id: task.id, action: 'cancel' }, `cancel:${task.id}`);
    await until(() => native.cancelled > 0 && !native.running());
    await quiet();
    return;
  }
  const outcome = cut === 'ready-partial' ? 'partial' : cut === 'ready-blocked' ? 'blocked' : 'complete';
  const result = await f.flow.result(task.assignee_session_id, { task_id: task.id, summary: 'Opaque delivery', outcome }, `result:${task.id}`);
  assert.equal(result.ready, false, 'publishing while the standard member runs is not ready');
  if (cut === 'submitted-not-ready') return;
  native.finish();
  await until(() => f.flow.store.getResult(result.id)?.ready === true);
  await quiet();
  if (cut === 'accepted') await f.flow.review(actor, { result_id: result.id, accepted: true, notes: 'Business owner accepts this obligation' }, `review:${task.id}`);
}
function assertCut(f: Fixture, task: FlowTask, cut: Cut): void {
  const current = f.flow.store.getTask(task.id)!;
  const expected = cut === 'open' ? 'OPEN' : cut === 'accepted' ? 'ACCEPTED' : cut === 'cancelled' ? 'CANCELLED' : 'SUBMITTED';
  assert.equal(current.status, expected);
  if (expected === 'SUBMITTED') {
    const result = f.flow.store.getResult(current.result_id!)!;
    assert.equal(result.ready, cut !== 'submitted-not-ready');
    assert.equal(result.outcome, cut === 'ready-partial' ? 'partial' : cut === 'ready-blocked' ? 'blocked' : 'complete');
  }
}
async function complete(f: Fixture, owner: ControlledNative, root: FlowTask, trace: string, allowed: boolean): Promise<FlowResult | undefined> {
  const request = { task_id: root.id, summary: 'Owner explicitly declares the root business obligation complete' };
  if (!allowed) {
    await refuse(f, trace, 'root complete', () => f.flow.result('owner', request, `complete:${trace}`), /unfinished child/);
    assert.equal(f.flow.store.getTask(root.id)?.status, 'OPEN');
    assert.equal(f.flow.store.getTeam(root.team_id)?.state, 'running');
    assertOwnerUntouched(f, owner);
    return;
  }
  await quiet();
  const before = f.flow.teamRead('owner', root.team_id);
  const result = await f.flow.result('owner', request, `complete:${trace}`);
  const after = f.flow.teamRead('owner', root.team_id);
  assert.equal(after.run.state, 'completed');
  assert.equal(f.flow.store.getTask(root.id)?.status, 'ACCEPTED');
  assert.equal(f.flow.store.getTask(root.id)?.result_id, result.id);
  assert.equal(after.results.length, before.results.length + 1);
  assert.deepEqual(after.reviews, before.reviews, 'root completion records no fabricated self-review');
  assert.equal(after.results.filter(item => item.task_id === root.id).length, 1);
  await quiet();
  assertOwnerUntouched(f, owner);
  assert.ok(f.flow.store.members(root.team_id).every(member => member.state === 'closed'));
  evidence.attempts.push({ trace, action: 'root complete', expected: 'accept' });
  return result;
}

test('bounded sibling completion cuts: all 7 x 7 reachable states in both preparation orders', async t => {
  for (const left of cuts) for (const right of cuts) for (const reversed of [false, true]) {
    const name = `siblings:${left}/${right}:${reversed ? 'right-left' : 'left-right'}`;
    await t.test(name, async child => {
      const f = fixture(child), root = await f.startTeam(), owner = attachOwner(f);
      const a = await delegate(f, 'owner', root.team, 'left'), b = await delegate(f, 'owner', root.team, 'right');
      const steps = [{ task: a, cut: left }, { task: b, cut: right }];
      if (reversed) steps.reverse();
      for (const step of steps) await prepare(f, 'owner', step.task, step.cut);
      await quiet(); assertCut(f, a, left); assertCut(f, b, right);
      const allowed = discharged(left) && discharged(right);
      await complete(f, owner, root.rootTask, name, allowed);
      evidence.completed.sibling_traces++;
      evidence.traces.push({ name, cuts: [left, right], root_completed: allowed });
      owner.finish();
    });
  }
});

test('bounded recursive completion cuts: no ancestor can skip an unresolved child', async t => {
  for (const cut of cuts) await t.test(`recursive:${cut}`, async child => {
    const name = `recursive:${cut}`, f = fixture(child), root = await f.startTeam(), owner = attachOwner(f);
    const parent = await delegate(f, 'owner', root.team, 'parent');
    const descendant = await delegate(f, parent.assignee_session_id, root.team, 'child');
    assert.equal(descendant.parent_id, parent.id, 'recursive parent comes from the actual member active task');
    await prepare(f, parent.assignee_session_id, descendant, cut);
    await quiet(); assertCut(f, descendant, cut);
    await complete(f, owner, root.rootTask, `${name}:parent-open`, false);
    const result = await f.flow.result(parent.assignee_session_id, { task_id: parent.id, summary: 'Parent delivery with existing child obligation' }, `parent-result:${cut}`);
    assert.equal(result.ready, false);
    await complete(f, owner, root.rootTask, `${name}:parent-submitted-not-ready`, false);
    f.handles.get(parent.assignee_session_id)!.finish();
    await until(() => f.flow.store.getResult(result.id)?.ready === true);
    await complete(f, owner, root.rootTask, `${name}:parent-ready`, false);
    const review = () => f.flow.review('owner', { result_id: result.id, accepted: true, notes: 'Parent business decision' }, `parent-review:${cut}`);
    if (discharged(cut)) {
      await review(); evidence.attempts.push({ trace: name, action: 'parent accept', expected: 'accept' });
      await complete(f, owner, root.rootTask, `${name}:parent-accepted`, true);
    } else {
      await refuse(f, name, 'parent accept', review, /unfinished child/);
    }
    evidence.completed.recursive_traces++;
    evidence.traces.push({ name, cuts: [cut, 'parent-open', 'parent-submitted-not-ready', 'parent-ready'], root_completed: discharged(cut) });
    owner.finish();
  });
});

test('bounded identity and result history: real actor, two versions, current head and operation replay', async t => {
  const name = 'identity-version', f = fixture(t), root = await f.startTeam(), owner = attachOwner(f);
  const a = await delegate(f, 'owner', root.team, 'author'), b = await delegate(f, 'owner', root.team, 'sibling');
  for (const actor of ['owner', b.assignee_session_id, 'outsider']) {
    await refuse(f, name, `wrong result author:${actor === 'owner' ? 'requester' : actor === 'outsider' ? 'outsider' : 'sibling'}`,
      () => f.flow.result(actor, { task_id: a.id, summary: 'Unauthorized publication' }, `wrong-author:${actor}`), /Only the assignee|does not own or belong/);
  }
  const first = await f.flow.result(a.assignee_session_id, { task_id: a.id, summary: 'Version one' }, 'first-result');
  f.handles.get(a.assignee_session_id)!.finish();
  await until(() => f.flow.store.getResult(first.id)?.ready === true);
  for (const actor of [a.assignee_session_id, b.assignee_session_id, 'outsider']) {
    await refuse(f, name, `wrong reviewer:${actor === a.assignee_session_id ? 'author' : actor === 'outsider' ? 'outsider' : 'sibling'}`,
      () => f.flow.review(actor, { result_id: first.id, accepted: true, notes: 'Unauthorized decision' }, `wrong-reviewer:${actor}`), /Only the task owner|does not own or belong/);
    await refuse(f, name, `wrong root actor:${actor === a.assignee_session_id ? 'author' : actor === 'outsider' ? 'outsider' : 'sibling'}`,
      () => f.flow.result(actor, { task_id: root.rootTask.id, summary: 'Unauthorized completion' }, `wrong-root:${actor}`), /Only the assignee|does not own or belong/);
  }
  await f.flow.review('owner', { result_id: first.id, accepted: false, notes: 'Revise the opaque obligation' }, 'revise');
  assert.equal(f.flow.store.getTask(a.id)?.version, 2);
  await until(() => f.handles.get(a.assignee_session_id)!.running());
  const second = await f.flow.result(a.assignee_session_id, { task_id: a.id, summary: 'Version two, superseded publication' }, 'second-result');
  const native = f.handles.get(a.assignee_session_id)!;
  native.finish();
  await until(() => f.flow.store.getResult(second.id)?.ready === true);
  await quiet();
  const turn = native.session.append('turn/start', { turn: 3 });
  native.options.onEvent?.(turn); native.hold();
  await until(() => f.flow.store.getMember(a.assignee_session_id)?.state === 'running');
  const current = await f.flow.result(a.assignee_session_id, { task_id: a.id, summary: 'Version two, current publication' }, 'current-result');
  native.finish();
  await until(() => f.flow.store.getResult(current.id)?.ready === true);
  assert.equal(f.flow.store.getResult(first.id)?.ready, true);
  assert.equal(f.flow.store.getResult(second.id)?.ready, true, 'the superseded head was ready, so readiness alone cannot reject it');
  assert.equal(second.task_version, current.task_version, 'the old-head case isolates current result identity from task version');
  for (const [label, stale] of [['old-version', first], ['old-head', second]] as const) {
    await refuse(f, name, label, () => f.flow.review('owner', { result_id: stale.id, accepted: true, notes: 'Stale result cannot discharge the obligation' }, `accept:${label}`), /not current and ready/);
  }
  await f.flow.review('owner', { result_id: current.id, accepted: true, notes: 'Current complete result checked' }, 'accept-current');
  await prepare(f, 'owner', b, 'cancelled');
  const completed = await complete(f, owner, root.rootTask, name, true);
  assert.ok(completed);
  await quiet(); const before = durable(f);
  const retry = await f.flow.result('owner', { task_id: root.rootTask.id, summary: 'Owner explicitly declares the root business obligation complete' }, `complete:${name}`);
  assert.equal(retry.id, completed.id); assert.deepEqual(durable(f), before);
  evidence.attempts.push({ trace: name, action: 'same operation replay', expected: 'accept', durable_unchanged: true });
  await refuse(f, name, 'operation input conflict', () => f.flow.result('owner', { task_id: root.rootTask.id, summary: 'Different input under the same operation identity' }, `complete:${name}`), /Operation ID was reused/);
  assertOwnerUntouched(f, owner);
  evidence.completed.identity_version_traces++;
  evidence.traces.push({ name, cuts: ['version-one-rejected', 'version-two-old-head', 'version-two-current-accepted', 'sibling-cancelled'], root_completed: true });
  owner.finish();
});

after(() => {
  const output = process.env['FLOW_STATE_MODEL_REPORT'];
  if (!output) return;
  const sourceFiles = ['packages/dsh-flow/src/core/controller.ts', 'packages/dsh-flow/src/core/store.ts', 'tests/unit/native-fixture.ts', 'tests/unit/collaboration-state-model.test.ts'];
  const report = {
    scope: 'bounded real-controller collaboration checks',
    completed_all_traces: evidence.completed.sibling_traces === 98 && evidence.completed.recursive_traces === 7 && evidence.completed.identity_version_traces === 1,
    source_sha256: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    ...evidence,
    attempt_counts: { accepted: evidence.attempts.filter(item => item.expected === 'accept').length, rejected_without_durable_change: evidence.attempts.filter(item => item.expected === 'reject' && item.durable_unchanged).length },
  };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
});
