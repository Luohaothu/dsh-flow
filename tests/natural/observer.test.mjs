import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { register } from 'tsx/esm/api';
import { apply } from './host.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const first = '/agent-team 检查这份账目。';

async function fixture(t, overrides = {}, mainCount = 1, projector) {
  await mkdir(join(root, '.artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, '.artifacts/observer-unit-'));
  const home = join(directory, 'home'), proof = join(directory, 'proof');
  const scenarioFile = join(directory, 'scenario.json');
  const savedEnv = Object.fromEntries(['DSH_HOME', 'NATURAL_PROFILE_NAME', 'NATURAL_SCENARIO_FILE', 'NATURAL_PROOF_DIR'].map(key => [key, process.env[key]]));
  const handlers = new Map(), calls = [], creates = [], resolves = [], mains = [];
  t.after(async () => {
    handlers.get('dispose')?.();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(home, 'profiles/web'), { recursive: true });
  await writeFile(join(home, 'profiles/web/package.json'), '{"name":"observer-unit-profile"}');
  for (let index = 0; index < mainCount; index++) {
    const workspace = join(directory, index ? `workspace-${index + 1}` : 'workspace');
    await mkdir(workspace);
    const sessionId = index ? `main-${index + 1}` : 'main', runId = index ? `run-${index + 1}` : 'run';
    const events = [], assignments = [{ id: `assignment-${index + 1}`, runId, parentAssignmentId: null, status: 'pending' }];
    const append = (type, data) => {
      const event = { seq: events.length + 1, time: Date.now(), type, data };
      events.push(event);
      return event;
    };
    const user = (text, source = { kind: 'user' }) => append('user/message', { source, content: [{ type: 'text', text }] });
    const endTurn = () => append('turn/end', { reason: { kind: 'completed' } });
    const readback = (assignment, returned = assignment) => {
      const callId = `read-${events.length}`;
      append('tool/call', { name: 'flow_team_assignment_read', callId, arguments: JSON.stringify({ assignmentId: assignment.id }) });
      append('tool/result', { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ id: returned.id, runId: returned.runId, status: returned.status, result: returned.result }) }] } });
    };
    const main = { status: 'idle', session: { id: sessionId, header: { cwd: workspace }, snapshotEvents: () => events } };
    const member = { status: 'idle', session: { id: `member-${index + 1}`, header: { cwd: workspace }, snapshotEvents: () => [] } };
    mains.push({ sessionId, workspace, runId, events, assignments, user, endTurn, readback, main, member, runEnabled: true });
  }
  const scenario = { prompt: first, userPrompts: [first, first], workspace: mains[0].workspace, maxRequests: 3, maxTotalTokens: 1000, maxDurationMs: 20000, noProgressMs: 5000, ...overrides };
  if (mainCount > 1) {
    scenario.mains = mains.map(main => ({ workspace: main.workspace, prompt: first }));
    delete scenario.prompt;
    delete scenario.workspace;
    delete scenario.userPrompts;
  }
  await writeFile(scenarioFile, JSON.stringify(scenario));
  const ctx = {
    on: (name, handler) => handlers.set(name, handler),
    get: name => name === 'profileContext' ? { installAnchor: join(root, 'package.json') } : undefined,
    agents: { list: () => mains.flatMap(main => [main.main, main.member]) },
    flow: { dashboardAddress: 'http://127.0.0.1:1', projector: projector ?? {
      registry: () => ({ runs: mains.filter(main => main.runEnabled).map(main => ({ id: main.runId, entry: { callerSessionId: main.sessionId } })) }),
      snapshot: id => {
        const main = mains.find(main => main.runId === id);
        return { version: { major: 1, minor: 1 }, seq: 1, run: { id, entry: { callerSessionId: main.sessionId } }, prices: [], operations: [], nodes: [{ id: `node-${main.sessionId}`, sessionID: main.member.session.id, parentId: null }], groups: [], assignments: main.assignments };
      },
    } },
    sessionController: {
      async create({ cwd }) { creates.push(cwd); return { sessionId: mains.find(main => main.workspace === cwd).sessionId }; },
      async resolveAgent(sessionId) { resolves.push(sessionId); return { agent: mains.find(main => main.sessionId === sessionId).main }; },
    },
    commands: { async execute(agent, prompt) {
      calls.push({ sessionId: agent.session.id, prompt, created: creates.length, resolved: resolves.length });
      const main = mains.find(main => main.sessionId === agent.session.id);
      main.user(prompt); main.endTurn(); return { result: { kind: 'success' } };
    } },
  };
  Object.assign(process.env, { DSH_HOME: home, NATURAL_PROFILE_NAME: 'web', NATURAL_SCENARIO_FILE: scenarioFile, NATURAL_PROOF_DIR: proof });
  apply(ctx);
  const evidence = async () => {
    try { return JSON.parse(await readFile(join(proof, 'evidence.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  };
  const until = async (predicate, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await evidence();
      if (value && predicate(value)) return value;
      if (value?.status === 'ERROR') assert.fail(value.error);
      await pause(25);
    }
    assert.fail('Observer did not reach the expected boundary');
  };
  const requestFinish = async (seq, sessionId = mains[0].sessionId) => {
    const pending = join(proof, 'finish-request.pending');
    await writeFile(pending, JSON.stringify({ sessionId, afterUserSeq: seq }), { mode: 0o600 });
    await rename(pending, join(proof, 'finish-request.json'));
  };
  const stream = async chunks => {
    const options = { sessionId: mains[0].sessionId, messages: [], tools: [] };
    const next = async function* () { yield* chunks; };
    for await (const _chunk of handlers.get('llm/stream')(options, next)) {}
  };
  await until(value => value.mains.length === mainCount && value.mains.every(main => main.userTimeline.length === 1));
  return { ...mains[0], mains, calls, creates, resolves, evidence, until, requestFinish, stream, initialInputs: () => calls.length };
}

test('observer treats idle members with a pending assignment as stalled work, not a user wait', { timeout: 5000 }, async t => {
  const f = await fixture(t, { noProgressMs: 700 });
  const pending = await f.evidence();
  assert.equal(pending.awaitingUser, false);
  assert.equal(pending.snapshots[0].assignments[0].status, 'pending');
  const stopped = await f.until(value => value.status === 'ABORTED');
  assert.equal(stopped.reason, 'no-progress');
  assert.deepEqual(stopped.checkpoints, []);
  assert.equal(f.initialInputs(), 1);
});

test('observer waits after actual readback, excludes notification and replay events, and needs a new final turn', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  f.readback(f.assignments[0]);
  f.endTurn();
  await f.until(value => value.awaitingUser);
  f.events.push(f.events[0]);
  f.user(first, { kind: 'flow' });
  f.user(first, { kind: 'skill-invocation', name: 'agent-team', form: 'instructions' });
  f.user('团队作业已完成，请读取实际结果。', { kind: 'flow' });
  await pause(5200);
  const waiting = await f.evidence();
  assert.equal(waiting.status, 'OBSERVING');
  assert.equal(waiting.awaitingUser, true);
  assert.deepEqual(waiting.userTimeline.map(item => item.seq), [1]);
  assert.equal(waiting.checkpoints.length, 1);
  assert.equal(f.initialInputs(), 1);
  const followup = f.user(first);
  const received = await f.until(value => value.userTimeline.length === 2);
  assert.equal(received.awaitingUser, false);
  assert.equal(received.observation.ended, false);
  assert.equal(received.observation.stableSince, undefined);
  f.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.reason, 'terminal-assignments-read-back');
  assert.deepEqual(settled.userTimeline.map(item => item.seq), [1, followup.seq]);
  assert.equal(f.initialInputs(), 1);
});

test('observer allows an explicit clarification wait while keeping the overall deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, { userTurnBoundary: 'main-idle', maxDurationMs: 1200, noProgressMs: 100 });
  await f.until(value => value.awaitingUser);
  const stopped = await f.until(value => value.status === 'ABORTED');
  assert.equal(stopped.reason, 'duration-limit');
  assert.equal(stopped.snapshots[0].assignments[0].status, 'pending');
  assert.equal(f.initialInputs(), 1);
});

test('operator completion records unplanned business replies and cannot bypass pending work or the latest user turn', { timeout: 20000 }, async t => {
  const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', noProgressMs: 15000 });
  Object.assign(f.assignments[0], { status: 'submitted', result: { needsInformation: true } });
  f.readback(f.assignments[0]); f.endTurn();
  await f.until(value => value.awaitingUser);
  await pause(3300);
  assert.equal((await f.evidence()).status, 'OBSERVING');
  await f.requestFinish(1);
  const reply = f.user('只做本地退款汇总，保持当前文件格式。');
  f.events.push(reply);
  f.user(reply.data.content[0].text, { kind: 'flow' });
  f.user(reply.data.content[0].text, { kind: 'skill-invocation', name: 'agent-team' });
  const next = { id: 'implementation', runId: 'run', parentAssignmentId: null, status: 'pending' };
  f.assignments.push(next);
  const received = await f.until(value => value.userTimeline.length === 2);
  assert.equal(received.observation.ended, false);
  assert.equal(received.observation.operatorFinished, false);
  assert.deepEqual(received.userTimeline[1].content, reply.data.content);
  f.endTurn();
  await f.requestFinish(reply.seq);
  await f.until(value => value.observation.operatorFinished);
  await pause(3300);
  assert.equal((await f.evidence()).status, 'OBSERVING');
  Object.assign(next, { status: 'submitted', result: { complete: true } });
  f.readback(next); f.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.reason, 'operator-finish-after-terminal-readback');
  assert.deepEqual(settled.userTimeline.map(item => item.seq), [1, reply.seq]);
  assert.equal(settled.operatorRequests.length, 2);
  assert.equal(f.initialInputs(), 1);
});

test('operator clarification retains duration, request and reported-token limits', { timeout: 10000 }, async t => {
  await t.test('duration', async t => {
    const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', maxDurationMs: 1200, noProgressMs: 100 });
    await f.until(value => value.awaitingUser);
    assert.equal((await f.until(value => value.status === 'ABORTED')).reason, 'duration-limit');
  });
  await t.test('requests', async t => {
    const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', maxRequests: 1 });
    await f.until(value => value.awaitingUser);
    await f.stream([{ type: 'finish', reason: { kind: 'stop' } }]);
    await assert.rejects(f.stream([]), /boundary reached/);
    assert.equal((await f.evidence()).reason, 'request-budget');
  });
  await t.test('tokens', async t => {
    const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', maxTotalTokens: 10 });
    await f.until(value => value.awaitingUser);
    await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    const stopped = await f.evidence();
    assert.equal(stopped.reason, 'total-token-budget');
    assert.equal(stopped.requests[0].sessionId, f.sessionId);
  });
});

test('multiple ordinary mains keep runs and readbacks separate, with both prepared before either input', { timeout: 15000 }, async t => {
  const f = await fixture(t, { noProgressMs: 15000 }, 2), other = f.mains[1];
  assert.deepEqual(f.calls.map(call => [call.sessionId, call.prompt, call.created, call.resolved]), [['main', first, 2, 2], ['main-2', first, 2, 2]]);
  Object.assign(f.assignments[0], { status: 'submitted', result: { business: 'one' } });
  f.readback(f.assignments[0]); f.endTurn();
  await f.until(value => value.mains[0].observation.taskComplete);
  assert.equal((await f.evidence()).mains[1].observation.taskComplete, false);
  Object.assign(other.assignments[0], { status: 'submitted', result: { business: 'two' } });
  f.readback(other.assignments[0]);
  other.readback(other.assignments[0], { ...other.assignments[0], id: 'wrong-result' });
  other.endTurn();
  await pause(3300);
  const wrong = await f.evidence();
  assert.equal(wrong.status, 'OBSERVING');
  assert.equal(wrong.mains[1].observation.readback, false);
  other.readback(other.assignments[0]); other.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.snapshots.length, 2);
  assert.deepEqual(settled.mains.map(main => main.runIds), [['run'], ['run-2']]);
  assert.deepEqual(settled.mains.map(main => main.userTimeline[0].seq), [1, 1]);
  assert.deepEqual(settled.mains.map(main => main.workspace), f.mains.map(main => main.workspace));
  assert.equal(f.initialInputs(), 2);
});

test('observer consumes a real DashboardProjector snapshot with nested run identity', { timeout: 15000 }, async t => {
  const loader = register({ namespace: 'natural-observer-projector' });
  const { runFixture } = await loader.import('../helpers/contract-run.ts', import.meta.url);
  const { DashboardProjector } = await loader.import('../../packages/dsh-flow/src/dashboard/projector.ts', import.meta.url);
  const domain = await runFixture(t);
  const projector = new DashboardProjector(domain.service, { directory: join(domain.directory, 'dashboard') });
  t.after(() => projector.dispose());
  const run = await domain.createActive(), root = domain.binding(run).root;
  const assignment = await run.assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: domain.spec() }, 'projected-assignment');
  assert.equal((await domain.submit(run, root, assignment, { answer: 'checked' })).kind, 'accepted');
  const actual = projector.snapshot(run.id);
  assert.equal(Object.hasOwn(actual, 'id'), false);
  assert.equal(Object.hasOwn(actual, 'runId'), false);
  assert.equal(actual.run.id, run.id);
  const f = await fixture(t, { userPrompts: undefined }, 1, projector);
  f.readback(actual.assignments[0]); f.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.deepEqual(settled.mains[0].runIds, [run.id]);
  assert.equal(settled.snapshots[0].run.id, run.id);
  assert.equal(settled.mains[0].observation.readback, true);
  t.after(() => loader.unregister());
});

test('sequential followups need new terminal work before waiting for the next user or settling', { timeout: 15000 }, async t => {
  const f = await fixture(t, { userPrompts: [first, first, first], requireNewTerminalAfterUserWait: true, noProgressMs: 15000 });
  Object.assign(f.assignments[0], { status: 'submitted', result: { phase: 'first' } });
  f.readback(f.assignments[0]); f.endTurn();
  const waiting = await f.until(value => value.awaitingUser);
  assert.deepEqual(waiting.checkpoints[0].terminalAssignmentIds, ['assignment-1']);
  f.user(first); f.readback(f.assignments[0]); f.endTurn();
  await f.until(value => value.userTimeline.length === 2);
  const old = await f.evidence();
  assert.equal(old.observation.sequential, false);
  assert.equal(old.awaitingUser, false);
  assert.equal(old.checkpoints.length, 1);
  const next = { id: 'second-task', runId: 'run', parentAssignmentId: null, status: 'submitted', result: { phase: 'second' } };
  f.assignments.push(next); f.readback(next); f.endTurn();
  const second = await f.until(value => value.awaitingUser && value.checkpoints.length === 2);
  assert.deepEqual(second.checkpoints[1].terminalAssignmentIds, ['assignment-1', 'second-task']);
  f.user(first); f.readback(next); f.endTurn();
  await pause(3300);
  const repeated = await f.evidence();
  assert.equal(repeated.status, 'OBSERVING');
  assert.equal(repeated.observation.sequential, false);
  const final = { id: 'third-task', runId: 'run', parentAssignmentId: null, status: 'submitted', result: { phase: 'third' } };
  f.assignments.push(final); f.endTurn();
  await f.until(value => value.observation.terminalAssignments.length === 3);
  assert.equal((await f.evidence()).observation.readback, false);
  f.readback(final); f.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.observation.sequential, true);
  assert.deepEqual(settled.checkpoints[0].terminalAssignmentIds, ['assignment-1']);
});

test('sequential followup without an observed completed checkpoint cannot synthesize its baseline', { timeout: 5000 }, async t => {
  const f = await fixture(t, { requireNewTerminalAfterUserWait: true, noProgressMs: 700 });
  f.user(first);
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  f.readback(f.assignments[0]); f.endTurn();
  const stopped = await f.until(value => value.status === 'ABORTED');
  assert.equal(stopped.reason, 'no-progress');
  assert.equal(stopped.mains[0].observation.sequentialBaselineMissing, true);
  assert.deepEqual(stopped.checkpoints, []);
});

test('default continuation permits the existing assignment to finish or cancel after the followup', { timeout: 15000 }, async t => {
  for (const status of ['submitted', 'cancelled']) await t.test(status, async t => {
    const f = await fixture(t);
    f.user(first);
    Object.assign(f.assignments[0], { status, result: status === 'submitted' ? { complete: true } : undefined });
    f.readback(f.assignments[0]); f.endTurn();
    const settled = await f.until(value => value.status === 'SETTLED');
    assert.equal(settled.observation.sequential, true);
    assert.equal(settled.snapshots[0].assignments.length, 1);
    assert.equal(settled.snapshots[0].assignments[0].id, 'assignment-1');
  });
});
