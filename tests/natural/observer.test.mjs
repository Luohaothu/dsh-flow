import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { apply } from './host.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const first = '/agent-team 检查这份账目。';

async function fixture(t, overrides = {}) {
  await mkdir(join(root, '.artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, '.artifacts/observer-unit-'));
  const home = join(directory, 'home'), proof = join(directory, 'proof');
  const workspace = join(directory, 'workspace'), scenarioFile = join(directory, 'scenario.json');
  const savedEnv = Object.fromEntries(['DSH_HOME', 'NATURAL_PROFILE_NAME', 'NATURAL_SCENARIO_FILE', 'NATURAL_PROOF_DIR'].map(key => [key, process.env[key]]));
  const handlers = new Map(), events = [], assignments = [{ id: 'assignment-1', parentAssignmentId: null, status: 'pending' }];
  t.after(async () => {
    handlers.get('dispose')?.();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(home, 'profiles/web'), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(home, 'profiles/web/package.json'), '{"name":"observer-unit-profile"}');
  const scenario = { prompt: first, userPrompts: [first, first], workspace, maxRequests: 3, maxTotalTokens: 1000, maxDurationMs: 20000, noProgressMs: 5000, ...overrides };
  await writeFile(scenarioFile, JSON.stringify(scenario));
  const append = (type, data) => {
    const event = { seq: events.length + 1, time: Date.now(), type, data };
    events.push(event);
    return event;
  };
  const user = (text, source = { kind: 'user' }) => append('user/message', { source, content: [{ type: 'text', text }] });
  const endTurn = () => append('turn/end', { reason: { kind: 'completed' } });
  const readback = assignment => {
    const callId = `read-${events.length}`;
    append('tool/call', { name: 'flow_team_assignment_read', callId, arguments: JSON.stringify({ assignmentId: assignment.id }) });
    append('tool/result', { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: assignment.status, result: assignment.result }) }] } });
  };
  const main = { status: 'idle', session: { id: 'main', header: {}, snapshotEvents: () => events } };
  const member = { status: 'idle', session: { id: 'member', header: {}, snapshotEvents: () => [] } };
  let initialInputs = 0;
  const ctx = {
    on: (name, handler) => handlers.set(name, handler),
    get: name => name === 'profileContext' ? { installAnchor: join(root, 'package.json') } : undefined,
    agents: { list: () => [main, member] },
    flow: { dashboardAddress: 'http://127.0.0.1:1', projector: {
      registry: () => ({ runs: [{ id: 'run', entry: { callerSessionId: 'main' } }] }),
      snapshot: () => ({ id: 'run', nodes: [{ id: 'node', sessionID: 'member', parentId: null }], groups: [], assignments }),
    } },
    sessionController: { create: async () => ({ sessionId: 'main' }), resolveAgent: async () => ({ agent: main }) },
    commands: { async execute() { initialInputs++; user(scenario.prompt); endTurn(); return { result: { kind: 'success' } }; } },
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
      if (value?.status === 'ERROR') assert.fail(value.error);
      if (value && predicate(value)) return value;
      await pause(25);
    }
    assert.fail('Observer did not reach the expected boundary');
  };
  await until(value => value.mainSessionId === 'main' && value.userTimeline.length === 1);
  return { assignments, events, user, endTurn, readback, evidence, until, initialInputs: () => initialInputs };
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
  f.user('团队作业已完成，请读取实际结果。');
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
