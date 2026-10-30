import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { register } from 'tsx/esm/api';
import { apply } from './host.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const first = '/agent-team 检查这份账目。';
const clarification = [{ id: 'scope', question: '这次需要怎样的退款汇总？', header: '明确需求', options: [{ label: '按订单和总额汇总', description: '保留现有输入格式。' }] }];

async function fixture(t, overrides = {}, mainCount = 1, projector) {
  await mkdir(join(root, '.artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, '.artifacts/observer-unit-'));
  const home = join(directory, 'home'), agentsHome = join(directory, 'agents-home'), proof = join(directory, 'proof');
  const scenarioFile = join(directory, 'scenario.json');
  const savedEnv = Object.fromEntries(['DSH_HOME', 'DSH_AGENTS_HOME', 'NATURAL_PROFILE_NAME', 'NATURAL_SCENARIO_FILE', 'NATURAL_PROOF_DIR'].map(key => [key, process.env[key]]));
  const handlers = new Map(), calls = [], creates = [], resolves = [], mains = [];
  const previousExits = new Set(process.listeners('exit'));
  let observerExits = [];
  t.after(async () => {
    handlers.get('dispose')?.();
    for (const listener of observerExits) process.removeListener('exit', listener);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(home, 'profiles/web'), { recursive: true });
  await mkdir(agentsHome);
  await writeFile(join(home, 'profiles/web/package.json'), '{"name":"observer-unit-profile"}');
  for (let index = 0; index < mainCount; index++) {
    const workspace = join(directory, index ? `workspace-${index + 1}` : 'workspace');
    await mkdir(workspace);
    const sessionId = index ? `main-${index + 1}` : 'main', runId = index ? `run-${index + 1}` : 'run';
    const events = [], assignments = [{ id: `assignment-${index + 1}`, runId, parentAssignmentId: null, status: 'pending' }];
    let turn = 1, step = 0;
    const append = (type, data) => {
      if (type === 'tool/call') data = { turn, step: ++step, ...data };
      const event = { seq: events.length + 1, time: Date.now(), type, data };
      events.push(event);
      return event;
    };
    const user = (text, source = { kind: 'user' }) => append('user/message', { source, content: [{ type: 'text', text }] });
    const endTurn = () => { const event = append('turn/end', { turn, reason: { kind: 'completed' } }); turn++; step = 0; return event; };
    const readback = (assignment, returned = assignment) => {
      const callId = `read-${events.length}`;
      const call = append('tool/call', { name: 'flow_team_assignment_read', callId, arguments: JSON.stringify({ runId: assignment.runId, assignmentId: assignment.id }) });
      return answer(call, { id: returned.id, runId: returned.runId, status: returned.status, result: returned.result });
    };
    const ask = (callId = `question-${events.length}`, extra = {}) => append('tool/call', { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions: clarification, ...extra }) });
    const answer = (call, value, error) => {
      const result = append('tool/result', { turn: call.data.turn, step: call.data.step, message: { role: 'tool', source: { kind: 'tool', callId: call.data.callId }, toolCallId: call.data.callId, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: error !== undefined, id: `result-${events.length}` }, ...(error === undefined ? {} : { error: typeof error === 'string' ? { message: error } : error }) });
      result.sourceEventSeqs = [call.seq]; result.surfaceOp = 'append';
      return result;
    };
    const main = { status: 'idle', session: { id: sessionId, header: { cwd: workspace }, snapshotEvents: () => events } };
    const member = { status: 'idle', session: { id: `member-${index + 1}`, header: { cwd: workspace }, snapshotEvents: () => [] } };
    mains.push({ sessionId, workspace, runId, events, assignments, append, user, endTurn, readback, ask, answer, main, member, runEnabled: true });
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
    skills: { async snapshot(options) { assert.equal(options, undefined); return { complete: true, skills: [{ name: 'agent-team', source: 'runtime', provider: 'fixture' }] }; } },
    flow: { dashboardAddress: 'http://127.0.0.1:1', projector: projector ?? {
      registry: () => ({ runs: mains.filter(main => main.runEnabled).map(main => ({ id: main.runId, entry: { backend: 'dsh', callerSessionId: main.sessionId } })) }),
      snapshot: id => {
        const main = mains.find(main => main.runId === id);
        return { version: { major: 1, minor: 1 }, seq: 1, run: { id, entry: { backend: 'dsh', callerSessionId: main.sessionId } }, prices: [], operations: [], nodes: [{ id: `node-${main.sessionId}`, sessionID: main.member.session.id, parentId: null }], groups: [], assignments: main.assignments };
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
  Object.assign(process.env, { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, NATURAL_PROFILE_NAME: 'web', NATURAL_SCENARIO_FILE: scenarioFile, NATURAL_PROOF_DIR: proof });
  apply(ctx);
  observerExits = process.listeners('exit').filter(listener => !previousExits.has(listener));
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
  const openStream = chunks => {
    const options = { sessionId: mains[0].sessionId, messages: [], tools: [] };
    const next = async function* () { yield* chunks; };
    return handlers.get('llm/stream')(options, next);
  };
  const stream = async chunks => { for await (const _chunk of openStream(chunks)) {} };
  await until(value => value.mains.length === mainCount && value.mains.every(main => main.userTimeline.length === 1));
  return { ...mains[0], mains, calls, creates, resolves, evidence, until, requestFinish, openStream, stream, initialInputs: () => calls.length };
}

test('a returned provider stream closes as cancelled and releases settlement only after actual closure', { timeout: 15000 }, async t => {
  const f = await fixture(t, { userPrompts: undefined, noProgressMs: 15000 });
  let providerClosed = false;
  const iterator = f.openStream((async function* () {
    try { yield { type: 'text-delta', text: 'partial' }; }
    finally { providerClosed = true; }
  })());
  assert.deepEqual(await iterator.next(), { value: { type: 'text-delta', text: 'partial' }, done: false });
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  f.readback(f.assignments[0]); f.endTurn();
  const open = await f.until(value => value.observation.taskComplete && value.observation.runningRequests === 1);
  assert.equal(open.requests[0].status, 'running');
  assert.equal(open.requests[0].endedAt, undefined);
  assert.equal(open.observation.qualifying, false);
  await pause(3300);
  assert.equal((await f.evidence()).status, 'OBSERVING');
  assert.equal(providerClosed, false);
  assert.deepEqual(await iterator.return(), { value: undefined, done: true });
  const closed = await f.evidence();
  assert.equal(providerClosed, true);
  assert.equal(closed.requests[0].status, 'cancelled');
  assert.equal(typeof closed.requests[0].endedAt, 'number');
  assert.equal(closed.requests[0].usage, undefined);
  assert.deepEqual(closed.usageMissingRequests, [1]);
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.observation.runningRequests, 0);
  assert.equal(settled.reason, 'terminal-assignments-read-back');
});

test('stream closure preserves reported usage and distinguishes provider completion and aborts', { timeout: 5000 }, async t => {
  await t.test('consumer cancellation keeps partial usage', async t => {
    const f = await fixture(t);
    const iterator = f.openStream([{ type: 'usage', usage: { totalTokens: 17 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    await iterator.next();
    await iterator.return();
    const closed = await f.evidence();
    assert.equal(closed.requests[0].status, 'cancelled');
    assert.deepEqual(closed.requests[0].usage, { totalTokens: 17 });
    assert.equal(closed.totalReportedTokens, 17);
    assert.deepEqual(closed.usageMissingRequests, []);
  });
  await t.test('completed provider stream remains completed', async t => {
    const f = await fixture(t);
    await f.stream([{ type: 'usage', usage: { totalTokens: 23 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    const closed = await f.evidence();
    assert.equal(closed.requests[0].status, 'completed');
    assert.equal(closed.totalReportedTokens, 23);
    assert.deepEqual(closed.usageMissingRequests, []);
  });
  await t.test('provider abort remains failed with unknown usage', async t => {
    const f = await fixture(t);
    const iterator = f.openStream((async function* () {
      yield { type: 'text-delta', text: 'partial' };
      throw new DOMException('Provider aborted', 'AbortError');
    })());
    await iterator.next();
    await assert.rejects(iterator.next(), { name: 'AbortError', message: 'Provider aborted' });
    const closed = await f.evidence();
    assert.equal(closed.requests[0].status, 'failed');
    assert.equal(closed.requests[0].error, 'Provider aborted');
    assert.equal(typeof closed.requests[0].endedAt, 'number');
    assert.deepEqual(closed.usageMissingRequests, [1]);
  });
});

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

test('operator completion retries a legitimate atomic replacement before accepting the finish request', { timeout: 10000 }, async t => {
  const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', noProgressMs: 15000 });
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  f.readback(f.assignments[0]); f.endTurn();
  await f.until(value => value.awaitingUser);
  const open = fs.openSync;
  let replaced = false, allowRead = false, controlPath;
  fs.openSync = (path, ...args) => {
    const fd = open(path, ...args);
    if (!allowRead && basename(String(path)) === 'finish-request.json') {
      replaced = true; controlPath = String(path);
      fs.writeFileSync(controlPath + '.replacement', JSON.stringify({ sessionId: f.sessionId, afterUserSeq: 1 }), { mode: 0o600 });
      fs.renameSync(controlPath + '.replacement', controlPath);
    }
    return fd;
  };
  syncBuiltinESMExports();
  try {
    await f.requestFinish(1);
    const skipped = await f.until(value => replaced && value.operatorRequests.length === 0);
    assert.equal(skipped.status, 'OBSERVING');
    assert.equal(skipped.observation.operatorFinished, false);
    allowRead = true;
    const settled = await f.until(value => value.status === 'SETTLED');
    assert.equal(settled.reason, 'operator-finish-after-terminal-readback');
    assert.deepEqual(settled.operatorRequests.map(({ sessionId, afterUserSeq }) => ({ sessionId, afterUserSeq })), [{ sessionId: f.sessionId, afterUserSeq: 1 }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(controlPath, 'utf8')), { sessionId: f.sessionId, afterUserSeq: 1 });
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
});

test('operator captures native question answers without inventing user messages and requires a fresh finish and turn', { timeout: 15000 }, async t => {
  const f = await fixture(t, { completion: 'operator', userPrompts: undefined, userTurnBoundary: 'main-idle', noProgressMs: 15000 });
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  f.readback(f.assignments[0]); f.endTurn();
  await f.until(value => value.observation.taskComplete);
  await f.requestFinish(1);
  await f.until(value => value.observation.operatorFinished);
  f.main.status = 'running';
  const call = f.ask();
  const pending = await f.until(value => value.observation.pendingQuestions.length === 1);
  assert.equal(pending.awaitingUser, true);
  assert.equal(pending.observation.idle, false);
  assert.equal(pending.observation.runningRequests, 0);
  assert.equal(pending.observation.operatorFinished, false);
  assert.equal(pending.observation.stableSince, undefined);
  const reply = f.answer(call, { answers: [{ id: 'scope', selected: [], custom: '这次只做按订单和总额的退款汇总，不做 CSV 导出。' }] });
  f.events.push(reply);
  const answered = await f.until(value => value.observation.lastInputSeq === reply.seq);
  assert.equal(answered.observation.ended, false);
  assert.equal(answered.observation.operatorFinished, false);
  assert.equal(answered.observation.qualifying, false);
  assert.deepEqual(answered.actualUserTimeline.map(item => item.seq), [1]);
  assert.deepEqual(answered.userTimeline.map(item => item.seq), [1]);
  assert.deepEqual(answered.questionTimeline[0].call, call.data);
  assert.deepEqual(answered.questionTimeline[0].result, reply.data);
  assert.equal(answered.questionTimeline[0].state, 'answered');
  assert.deepEqual(answered.inputBoundaryTimeline.map(item => [item.kind, item.seq]), [['user-message', 1], ['question-result', reply.seq]]);
  f.main.status = 'idle'; f.endTurn();
  const ended = await f.until(value => value.observation.ended);
  assert.equal(ended.observation.operatorFinished, false);
  assert.equal(ended.observation.qualifying, false);
  assert.equal(ended.observation.stableSince, undefined);
  await f.requestFinish(reply.seq);
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.reason, 'operator-finish-after-terminal-readback');
  assert.equal(settled.operatorRequests.at(-1).afterUserSeq, reply.seq);
  assert.equal(f.initialInputs(), 1);
});

test('question evidence distinguishes skips and errors and ignores question text in ordinary tool output', { timeout: 5000 }, async t => {
  const f = await fixture(t, { completion: 'operator', userPrompts: undefined });
  const catalogue = f.append('tool/call', { name: 'read_file', callId: 'catalogue', arguments: '{"path":"questions.md"}' });
  f.answer(catalogue, 'ask_user_question catalogue: {"answers":[{"id":"scope","selected":["继续"]}]}');
  f.user('ask_user_question: 继续', { kind: 'flow' });
  const plain = await f.until(value => value.histories.find(history => history.sessionId === f.sessionId).events.length === f.events.length);
  assert.deepEqual(plain.questionTimeline, []);
  assert.equal(plain.inputBoundaryTimeline.length, 1);
  assert.equal(plain.awaitingUser, false);
  for (const code of ['ASK_CANCELLED', 'NO_PROVIDER', 'DELEGATED_CALLER']) f.answer(f.ask(), 'Error: 继续', { name: 'UserQuestionError', code });
  const untyped = f.answer(f.ask(), { answers: [{ id: 'scope', selected: ['继续'] }] });
  untyped.data.message.isError = true;
  const skipped = f.answer(f.ask(), { answers: [{ id: 'scope', selected: [] }] });
  const captured = await f.until(value => value.questionTimeline.length === 5);
  assert.deepEqual(captured.questionTimeline.map(item => item.state), ['failed', 'failed', 'failed', 'failed', 'answered']);
  assert.deepEqual(captured.questionTimeline.slice(0, 3).map(item => item.result.error.code), ['ASK_CANCELLED', 'NO_PROVIDER', 'DELEGATED_CALLER']);
  assert.deepEqual(captured.questionTimeline[3].result, untyped.data);
  assert.deepEqual(captured.questionTimeline[4].result, skipped.data);
  assert.equal(captured.actualUserTimeline.length, 1);
  assert.equal(captured.inputBoundaryTimeline.length, 6);
  assert.equal(captured.awaitingUser, false);
});

test('timed pending and resumed questions wait until their own admitted native replies', { timeout: 10000 }, async t => {
  for (const completion of ['auto', 'operator']) await t.test(completion, async t => {
    const f = await fixture(t, { completion, userPrompts: undefined, userTurnBoundary: 'main-idle', noProgressMs: 100 });
    Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
    f.readback(f.assignments[0]);
    f.append('request/header', { header: { tools: [{ name: 'ask_user_question', parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'integer', minimum: 1 } } } }] } });
    const call = f.ask('timed-question', { timeout: 1 });
    f.answer(call, { pending: true, callId: call.data.callId, message: 'Question remains answerable.' });
    const resumed = f.ask('resumed-question', { timeout: 1 });
    const unknown = f.answer(resumed, 'Error: unknown tool outcome', { name: 'ToolError', code: 'TOOL_OUTCOME_UNKNOWN' });
    f.endTurn();
    if (completion === 'operator') await f.requestFinish(unknown.seq);
    const pending = await f.until(value => value.observation.pendingQuestions.length === 2 && value.operatorRequests.length === (completion === 'operator' ? 1 : 0));
    assert.equal(pending.observation.idle, true);
    assert.equal(pending.observation.ended, true);
    assert.equal(pending.observation.taskComplete, true);
    assert.equal(pending.observation.operatorFinished, completion === 'operator' ? false : undefined);
    assert.equal(pending.observation.qualifying, false);
    assert.equal(pending.observation.stableSince, undefined);
    await pause(650);
    const waiting = await f.evidence();
    assert.equal(waiting.status, 'OBSERVING');
    assert.equal(waiting.awaitingUser, true);
    assert.equal(waiting.checkpoints.length, completion === 'operator' ? 1 : 0);
    const reply = f.user(JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: call.data.callId, questions: clarification, answers: [{ id: 'scope', selected: [], custom: '按订单汇总。' }] }), { kind: 'user-question-reply', callId: call.data.callId, outcome: 'answered' });
    const partial = await f.until(value => value.observation.lastInputSeq === reply.seq);
    assert.deepEqual(partial.observation.pendingQuestions, [resumed.data.callId]);
    assert.equal(partial.awaitingUser, true);
    const second = f.user(JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: resumed.data.callId, questions: clarification, answers: [{ id: 'scope', selected: [] }] }), { kind: 'user-question-reply', callId: resumed.data.callId, outcome: 'answered' });
    const answered = await f.until(value => value.observation.lastInputSeq === second.seq);
    assert.equal(answered.actualUserTimeline.length, 1);
    assert.deepEqual(answered.questionTimeline.map(item => item.state), ['answered', 'answered']);
    assert.deepEqual(answered.questionTimeline[0].reply, reply.data);
    assert.deepEqual(answered.questionTimeline[1].reply, second.data);
    assert.equal(answered.observation.ended, false);
  });
});

test('native question matching never uses another main session with the same call ID and event sequences', { timeout: 5000 }, async t => {
  const f = await fixture(t, { completion: 'operator', userTurnBoundary: 'main-idle' }, 2), other = f.mains[1];
  const call = f.ask('same-question'), otherCall = other.ask('same-question');
  assert.equal(call.seq, otherCall.seq);
  const reply = f.answer(call, { answers: [{ id: 'scope', selected: ['按订单和总额汇总'] }] });
  const captured = await f.until(value => value.mains[0].questionTimeline[0]?.state === 'answered' && value.mains[1].questionTimeline.length === 1);
  assert.equal(captured.mains[0].observation.lastInputSeq, reply.seq);
  assert.equal(captured.mains[1].observation.lastInputSeq, 1);
  assert.equal(captured.mains[1].questionTimeline[0].state, 'pending');
  assert.equal(captured.mains[1].questionTimeline[0].result, undefined);
  assert.deepEqual(captured.mains[1].observation.pendingQuestions, ['same-question']);
  assert.equal(captured.mains[1].awaitingUser, true);
});

test('automatic native clarification waits for an answer and a new turn, then requires formal delivery and readback', { timeout: 20000 }, async t => {
  const f = await fixture(t, { userPrompts: undefined, noProgressMs: 15000 });
  f.main.status = 'running';
  const call = f.ask();
  const waiting = await f.until(value => value.awaitingUser && value.observation.pendingQuestions.length === 1);
  assert.equal(waiting.completion, 'auto');
  assert.equal(waiting.observation.matchedUserPrompts, 1);
  assert.equal(waiting.observation.expectedUserPrompts, 1);
  assert.equal(waiting.observation.idle, false);
  assert.equal(waiting.observation.runningRequests, 0);
  assert.equal(waiting.observation.qualifying, false);
  const reply = f.answer(call, { answers: [{ id: 'scope', selected: [], custom: '只按订单和总额汇总退款，保留原始格式。' }] });
  const answered = await f.until(value => value.observation.lastInputSeq === reply.seq);
  assert.equal(answered.awaitingUser, false);
  assert.equal(answered.observation.ended, false);
  assert.deepEqual(answered.userTimeline.map(item => item.seq), [1]);
  assert.deepEqual(answered.actualUserTimeline.map(item => item.seq), [1]);
  assert.deepEqual(answered.inputBoundaryTimeline.map(item => [item.kind, item.seq]), [['user-message', 1], ['question-result', reply.seq]]);
  assert.deepEqual(answered.questionTimeline[0].result, reply.data);
  f.main.status = 'idle'; f.endTurn();
  const incomplete = await f.until(value => value.observation.idle && value.observation.ended);
  assert.equal(incomplete.observation.taskComplete, false);
  assert.equal(incomplete.awaitingUser, false);
  await pause(3300);
  assert.equal((await f.evidence()).status, 'OBSERVING');
  Object.assign(f.assignments[0], { status: 'submitted', result: { complete: true } });
  const unread = await f.until(value => value.observation.terminalAssignments.length === 1);
  assert.equal(unread.observation.readback, false);
  assert.equal(unread.observation.qualifying, false);
  await pause(3300);
  assert.equal((await f.evidence()).status, 'OBSERVING');
  f.readback(f.assignments[0]); f.endTurn();
  const settled = await f.until(value => value.status === 'SETTLED');
  assert.equal(settled.reason, 'terminal-assignments-read-back');
  assert.equal(settled.observation.taskComplete, true);
  assert.equal(settled.operatorRequests.length, 0);
  assert.equal(f.initialInputs(), 1);
});

test('one native question does not suspend global no-progress for another genuinely stalled main', { timeout: 5000 }, async t => {
  const f = await fixture(t, { noProgressMs: 700 }, 2);
  f.main.status = 'running'; f.ask();
  const waiting = await f.until(value => value.mains[0].awaitingUser);
  assert.equal(waiting.mains[1].awaitingUser, false);
  assert.equal(waiting.mains[1].observation.qualifying, false);
  assert.equal(waiting.awaitingUser, false);
  const stopped = await f.until(value => value.status === 'ABORTED');
  assert.equal(stopped.reason, 'no-progress');
  assert.equal(stopped.mains[0].questionTimeline[0].state, 'pending');
  assert.equal(stopped.mains[1].observation.taskComplete, false);
});

test('a native question and an independently completed main pause global no-progress until the hard deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, { noProgressMs: 100, maxDurationMs: 1800 }, 2), other = f.mains[1];
  f.main.status = 'running'; f.ask();
  Object.assign(other.assignments[0], { status: 'submitted', result: { complete: true } });
  other.readback(other.assignments[0]); other.endTurn();
  const waiting = await f.until(value => value.mains[0].awaitingUser && value.mains[1].observation.qualifying);
  assert.equal(waiting.awaitingUser, true);
  assert.equal(waiting.mains[0].observation.taskComplete, false);
  assert.equal(waiting.mains[1].observation.readback, true);
  const stopped = await f.until(value => value.status === 'ABORTED');
  assert.equal(stopped.reason, 'duration-limit');
});

test('native question waits retain duration, request and reported-token limits', { timeout: 15000 }, async t => {
  for (const completion of ['auto', 'operator']) await t.test(completion, async t => {
    await t.test('duration', async t => {
      const f = await fixture(t, { completion, userPrompts: undefined, userTurnBoundary: 'main-idle', maxDurationMs: 1200, noProgressMs: 100 });
      f.main.status = 'running'; f.ask();
      const waiting = await f.until(value => value.awaitingUser && value.observation.pendingQuestions.length === 1);
      assert.equal(waiting.observation.idle, false);
      assert.equal(waiting.observation.runningRequests, 0);
      assert.equal((await f.until(value => value.status === 'ABORTED')).reason, 'duration-limit');
    });
    await t.test('requests', async t => {
      const f = await fixture(t, { completion, userPrompts: undefined, userTurnBoundary: 'main-idle', maxRequests: 1 });
      f.main.status = 'running'; f.ask();
      const waiting = await f.until(value => value.awaitingUser && value.observation.pendingQuestions.length === 1);
      assert.equal(waiting.observation.idle, false);
      assert.equal(waiting.observation.runningRequests, 0);
      await f.stream([{ type: 'finish', reason: { kind: 'stop' } }]);
      await assert.rejects(f.stream([]), /boundary reached/);
      assert.equal((await f.evidence()).reason, 'request-budget');
    });
    await t.test('tokens', async t => {
      const f = await fixture(t, { completion, userPrompts: undefined, userTurnBoundary: 'main-idle', maxTotalTokens: 10 });
      f.main.status = 'running'; f.ask();
      const waiting = await f.until(value => value.awaitingUser && value.observation.pendingQuestions.length === 1);
      assert.equal(waiting.observation.idle, false);
      assert.equal(waiting.observation.runningRequests, 0);
      await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
      const stopped = await f.evidence();
      assert.equal(stopped.reason, 'total-token-budget');
      assert.equal(stopped.requests[0].sessionId, f.sessionId);
    });
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
  const run = await domain.createActive({}, 'observer-projector', domain.origin('main', 'dsh')), root = domain.binding(run).root;
  const foreign = await domain.createActive({}, 'foreign-projector', domain.origin('main', 'other-backend'));
  const assignment = await run.assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: domain.spec() }, 'projected-assignment');
  assert.equal((await domain.submit(run, root, assignment, { answer: 'checked' })).kind, 'accepted');
  const actual = projector.snapshot(run.id);
  assert.equal(Object.hasOwn(actual, 'id'), false);
  assert.equal(Object.hasOwn(actual, 'runId'), false);
  assert.equal(actual.run.id, run.id);
  assert.equal(projector.registry().runs.some(item => item.id === foreign.id && item.entry.callerSessionId === 'main'), true);
  const f = await fixture(t, { userPrompts: undefined }, 1, { registry: () => projector.registry(), snapshot: id => {
    assert.notEqual(id, foreign.id, 'the actual foreign-backend Run must never be read by the DSH observer');
    return projector.snapshot(id);
  } });
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

async function clockedFixture(t, overrides = {}) {
  const realInterval = globalThis.setInterval;
  let tick;
  globalThis.setInterval = callback => { tick = callback; return realInterval(() => {}, 3_600_000); };
  let f;
  try { f = await fixture(t, { userPrompts: undefined, noProgressMs: 1000, maxDurationMs: 10000, ...overrides }); }
  finally { globalThis.setInterval = realInterval; }
  let now = (await f.evidence()).startedAt;
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return { ...f, advance: ms => { now += ms; }, tick: async () => { tick(); return f.evidence(); } };
}

test('a long stream gets one bounded tool continuation; successful work starts a new progress window', async t => {
  const f = await clockedFixture(t), stream = f.openStream([{ type: 'text-delta', text: 'working' }]);
  await stream.next(); f.advance(1500);
  assert.equal((await f.tick()).status, 'OBSERVING');
  await stream.next();
  const call = f.append('tool/call', { name: 'write', callId: 'write-after-stream', arguments: '{"path":"output.txt"}' });
  const handoff = await f.tick();
  assert.equal(handoff.status, 'OBSERVING'); assert.equal(handoff.observation.runningRequests, 0);
  assert.equal(handoff.noProgressContinuation.until, handoff.updatedAt + 1000);
  f.advance(9); f.answer(call, 'written');
  const progressed = await f.tick();
  assert.equal(progressed.status, 'OBSERVING'); assert.equal(progressed.lastProgressAt, progressed.updatedAt);
  assert.equal(progressed.noProgressContinuation, undefined);
  f.advance(1001);
  const stopped = await f.tick();
  assert.equal(stopped.reason, 'no-progress'); assert.equal(stopped.observation.runningRequests, 0);
});

test('errors, queries and another long generation cannot renew the same no-progress continuation', async t => {
  const f = await clockedFixture(t), firstStream = f.openStream([{ type: 'text-delta', text: 'first' }]);
  await firstStream.next(); f.advance(1500); await f.tick(); await firstStream.next();
  const handoff = await f.tick(), originalProgress = handoff.lastProgressAt, until = handoff.noProgressContinuation.until;
  f.advance(400);
  const query = f.append('tool/call', { name: 'flow_team_get', callId: 'query', arguments: '{}' }); f.answer(query, 'same');
  const error = f.append('tool/call', { name: 'flow_team_assign', callId: 'invalid-schema', arguments: '{}' }); f.answer(error, 'Unsupported schema keyword', 'invalid');
  const unchanged = await f.tick(); assert.equal(unchanged.lastProgressAt, originalProgress); assert.equal(unchanged.noProgressContinuation.until, until);
  const secondStream = f.openStream([{ type: 'text-delta', text: 'second' }]); await secondStream.next();
  f.advance(700); assert.equal((await f.tick()).status, 'OBSERVING'); await secondStream.next();
  const stopped = await f.tick();
  assert.equal(stopped.reason, 'no-progress'); assert.equal(stopped.lastProgressAt, originalProgress);
  assert.equal(stopped.noProgressContinuation.until, until); assert.equal(stopped.observation.runningRequests, 0);
});

test('an active stream and continuation never extend the absolute observation deadline', async t => {
  const f = await clockedFixture(t, { maxDurationMs: 2000 }), stream = f.openStream([{ type: 'text-delta', text: 'working' }]);
  await stream.next(); f.advance(2100);
  assert.equal((await f.tick()).reason, 'duration-limit'); await stream.return();
});

test('an owned cancellation receipt acknowledges that terminal while the replacement still needs actual result readback', async t => {
  const f = await clockedFixture(t, { noProgressMs: 5000 }), old = f.assignments[0];
  old.status = 'cancelled'; old.reason = 'superseded by updated business facts';
  const replacement = { id: 'replacement', runId: f.runId, parentAssignmentId: null, status: 'submitted', result: { summary: 'latest facts' } };
  f.assignments.push(replacement);
  const cancel = f.append('tool/call', { name: 'flow_team_assignment_cancel', callId: 'cancel-old', arguments: JSON.stringify({ runId: f.runId, assignmentId: old.id, reason: old.reason }) });
  f.answer(cancel, [{ assignmentId: old.id, status: 'cancelled', reason: old.reason }]);
  assert.equal((await f.tick()).observation.readback, false, 'cancellation cannot acknowledge the replacement result');
  f.readback(replacement); f.endTurn();
  const reviewed = await f.tick(); assert.equal(reviewed.observation.readback, true); assert.equal(reviewed.observation.taskComplete, true);
  f.advance(3001); assert.equal((await f.tick()).status, 'SETTLED');
});

test('cancellation acknowledgements require the exact owner Run, target, returned status and successful matching tool result', async t => {
  const f = await clockedFixture(t, { noProgressMs: 5000 }), old = f.assignments[0]; old.status = 'cancelled';
  for (const [index, input] of [
    { runId: 'foreign-run', assignmentId: old.id, response: [{ assignmentId: old.id, status: 'cancelled' }] },
    { runId: f.runId, assignmentId: 'other-target', response: [{ assignmentId: old.id, status: 'cancelled' }] },
    { runId: f.runId, assignmentId: old.id, response: [{ assignmentId: 'other-target', status: 'cancelled' }] },
    { runId: f.runId, assignmentId: old.id, response: [{ assignmentId: old.id, status: 'pending' }] },
    { runId: f.runId, assignmentId: old.id, response: [{ assignmentId: old.id, status: 'cancelled' }], error: 'rejected' },
    { runId: f.runId, assignmentId: old.id, response: 'cancelled' },
  ].entries()) {
    const call = f.append('tool/call', { name: 'flow_team_assignment_cancel', callId: `cancel-${index}`, arguments: JSON.stringify({ runId: input.runId, assignmentId: input.assignmentId, reason: 'update' }) });
    f.answer(call, input.response, input.error);
    assert.equal((await f.tick()).observation.readback, false, `rejected cancellation evidence ${index}`);
  }
});

test('rejected non-object read/cancel arguments cannot hide a later exact cancellation receipt', async t => {
  const f = await clockedFixture(t, { noProgressMs: 5000 }), old = f.assignments[0]; old.status = 'cancelled';
  for (const name of ['flow_team_assignment_read', 'flow_team_assignment_cancel']) for (const value of [null, [], 7, 'invalid', true]) {
    const call = f.append('tool/call', { name, callId: `invalid-${f.events.length}`, arguments: JSON.stringify(value) });
    f.answer(call, 'Invalid arguments', 'invalid');
  }
  const rejected = await f.tick(); assert.equal(rejected.status, 'OBSERVING'); assert.equal(rejected.observation.readback, false);
  const call = f.append('tool/call', { name: 'flow_team_assignment_cancel', callId: 'valid-after-rejections', arguments: JSON.stringify({ runId: f.runId, assignmentId: old.id, reason: 'update' }) });
  f.answer(call, [{ assignmentId: old.id, status: 'cancelled', reason: 'update' }]);
  assert.equal((await f.tick()).observation.readback, true);
});
