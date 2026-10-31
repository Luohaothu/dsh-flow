import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { apply } from './host.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sdkNames = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tool-skill'];

async function fixture(t, overrides = {}, catalog = { complete: true, skills: [{ name: 'agent-team', source: 'runtime', provider: 'fixture' }] }, mainCount = 1) {
  await mkdir(join(root, '.artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, '.artifacts/b0-observer-stub-'));
  const home = join(directory, 'home'), agentsHome = join(directory, 'agents-home'), proof = join(directory, 'proof');
  const workspace = join(directory, 'workspace'), profile = join(home, 'profiles/web/package.json');
  for (const path of [dirname(profile), agentsHome, workspace]) await mkdir(path, { recursive: true });
  await writeFile(profile, '{}');
  for (const name of ['dsh-flow', ...sdkNames]) {
    const path = join(dirname(profile), 'node_modules', name, 'package.json');
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ name, version: '0.2.0-rc.2' }));
  }
  const scenarioFile = join(directory, 'scenario.json');
  const workspaces = [workspace];
  for (let index = 1; index < mainCount; index++) { const next = join(directory, `workspace-${index + 1}`); await mkdir(next); workspaces.push(next); }
  await writeFile(scenarioFile, JSON.stringify({ ...(mainCount > 1 ? { mains: workspaces.map(workspace => ({ prompt: '/agent-team 核对订单。', workspace })) } : {}), prompt: '/agent-team 核对订单。', workspace, maxRequests: 10, maxTotalTokens: 1000, maxDurationMs: 60000, noProgressMs: 60000, ...overrides }));
  const keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'NATURAL_PROFILE_NAME', 'NATURAL_SCENARIO_FILE', 'NATURAL_PROOF_DIR'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, NATURAL_PROFILE_NAME: 'web', NATURAL_SCENARIO_FILE: scenarioFile, NATURAL_PROOF_DIR: proof });
  const handlers = new Map(), events = [], trace = [], exits = [];
  const state = { active: [], created: 0, invoked: 0, next: 0, catalog, registrySeq: 1, snapshotReads: [], assignments: [{ id: 'assignment', parentAssignmentId: null, status: 'pending' }] };
  const main = { status: 'idle', session: { id: 'main', header: { cwd: workspace }, snapshotEvents() { trace.push('history'); return events; } } };
  const owners = [{ main, events, assignments: state.assignments, runId: 'run', workspace }];
  for (let index = 1; index < mainCount; index++) {
    const events = [], id = `main-${index + 1}`, runId = `run-${index + 1}`;
    const main = { status: 'idle', session: { id, header: { cwd: workspaces[index] }, snapshotEvents() { trace.push(`history:${id}`); return events; } } };
    owners.push({ main, events, assignments: [{ id: `assignment-${index + 1}`, runId, parentAssignmentId: null, status: 'pending' }], runId, workspace: workspaces[index] });
  }
  state.active.push(...owners.map(owner => owner.main));
  const projector = {
    registry() { trace.push('registry'); return { seq: state.registrySeq, runs: [...owners.map(owner => ({ id: owner.runId, entry: { backend: 'dsh', callerSessionId: owner.main.session.id } })),
      ...(state.foreignRun ? [{ id: 'foreign-run', entry: { backend: 'dsh', callerSessionId: 'foreign-main' } }] : []),
      ...(state.foreignBackendRun ? owners.map(owner => ({ id: `foreign-backend-${owner.runId}`, entry: { backend: 'other-backend', callerSessionId: owner.main.session.id } })) : [])] }; },
    snapshot(id) { trace.push('snapshot'); state.snapshotReads.push(id); const owner = owners.find(owner => owner.runId === id); assert.ok(owner, 'capture must exclude foreign owner runs'); return { run: { id, entry: { backend: 'dsh', callerSessionId: owner.main.session.id } }, nodes: [], groups: [], assignments: owner.assignments }; },
  };
  const ctx = { on: (name, handler) => handlers.set(name, handler),
    get: name => name === 'profileContext' ? { installAnchor: profile } : undefined,
    agents: { list: () => state.active }, flow: { dashboardAddress: 'fixture', projector },
    skills: { async snapshot(options) { assert.equal(options, undefined, 'the SDK global view omits cwd and scope'); return state.catalog; } },
    sessionController: { async create({ cwd }) { state.created++; return { sessionId: owners.find(owner => owner.workspace === cwd).main.session.id }; }, async resolveAgent(id) { return { agent: owners.find(owner => owner.main.session.id === id).main }; } },
    commands: { async execute(agent, prompt) { state.invoked++; owners.find(owner => owner.main === agent).events.push({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } }); return { result: { kind: 'success' } }; } },
  };
  let cleared = false, poll; const timer = { unref() {} }; const realClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', callback => { poll = callback; return timer; });
  t.mock.method(globalThis, 'clearInterval', value => { if (value === timer) { cleared = true; trace.push('clear-timer'); } else realClear(value); });
  const realOnce = process.once.bind(process);
  const once = t.mock.method(process, 'once', (name, handler) => { if (name === 'exit') { exits.push(handler); return process; } return realOnce(name, handler); });
  apply(ctx); once.mock.restore();
  const bytes = (name = 'evidence.json') => readFile(join(proof, name));
  const evidence = async (name = 'evidence.json') => JSON.parse(await bytes(name));
  const until = async predicate => {
    for (let i = 0; i < 200; i++) {
      try { const value = await evidence(); if (predicate(value)) return value; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(5);
    }
    assert.fail('Stub observer did not reach the expected state');
  };
  t.after(async () => {
    handlers.get('dispose')?.(); exits[0]?.();
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  await until(value => value.mainSessionId || value.status === 'ERROR');
  const iterator = (source, sessionId = 'main') => handlers.get('llm/stream')({ provider: 'fixture', model: 'fixture', sessionId, messages: [] }, () => { state.next++; return source; });
  const stream = async chunks => { for await (const _ of iterator((async function* () { yield* chunks; })())) {} };
  return { ctx, state, main, events, owners, trace, handlers, agentsHome, proof, evidence, bytes, iterator, stream, poll: () => poll(), cleared: () => cleared, exit: () => exits[0]?.() };
}

test('token boundary captures native events and projections before clearing the timer, then freezes business evidence', async t => {
  const f = await fixture(t, { maxTotalTokens: 10 });
  f.events.push({ seq: 2, type: 'tool/result', data: { late: 'before boundary' } });
  f.state.registrySeq = 2; f.state.assignments[0].status = 'submitted'; f.trace.length = 0;
  await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  const boundary = await f.evidence(), frozen = await f.bytes();
  assert.equal(boundary.reason, 'total-token-budget'); assert.equal(boundary.histories[0].events.at(-1).seq, 2);
  assert.equal(boundary.registry.seq, 2); assert.equal(boundary.snapshots[0].assignments[0].status, 'submitted');
  assert.ok(f.trace.indexOf('snapshot') < f.trace.indexOf('clear-timer')); assert.equal(f.cleared(), true);
  f.events.push({ seq: 3, type: 'turn/end', data: { reason: { kind: 'cancelled' } } });
  f.state.assignments[0].status = 'cancelled'; f.handlers.get('agent/disposed')({ agent: f.main }); f.state.active = [];
  f.handlers.get('dispose')(); f.ctx.flow = undefined;
  f.events.push({ seq: 4, type: 'turn/end', data: { finalShutdownEvent: true } }); f.exit();
  const shutdown = await f.evidence('shutdown-evidence.json');
  assert.equal(shutdown.phase, 'process-exit'); assert.equal(shutdown.scoringEligible, false);
  assert.equal(shutdown.histories[0].events.at(-1).seq, 4); assert.equal(shutdown.histories[0].status, 'disposed');
  assert.equal(shutdown.businessBoundary.sha256, createHash('sha256').update(frozen).digest('hex'));
  assert.deepEqual(await f.bytes(), frozen); assert.equal((await f.evidence()).snapshots[0].assignments[0].status, 'submitted');
});

test('publishing a new snapshot preserves a reader already holding the previous evidence inode', async t => {
  const f = await fixture(t);
  const held = await open(join(f.proof, 'evidence.json'), 'r');
  try {
    const readHeld = async () => {
      const buffer = Buffer.alloc((await held.stat()).size);
      const { bytesRead } = await held.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    };
    const previous = await readHeld();
    f.state.registrySeq += 1;
    f.events.push({ seq: 2, type: 'tool/result', data: { published: 'new observation' } });
    f.poll();
    const current = await f.bytes();
    assert.notDeepEqual(current, previous);
    assert.equal(JSON.parse(current).registry.seq, f.state.registrySeq);
    assert.deepEqual(await readHeld(), previous, 'An open reader must retain the previous complete snapshot');
  } finally { await held.close(); }
});

test('staging a snapshot does not bypass the existing proof file write permission', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), path = join(f.proof, 'evidence.json'), previous = await f.bytes();
  await chmod(path, 0o400);
  try {
    assert.throws(() => f.poll(), { code: 'EACCES' });
    assert.deepEqual(await f.bytes(), previous);
  } finally { await chmod(path, 0o600); }
});

test('request admission boundary refreshes a native event added after the last observation', async t => {
  const f = await fixture(t, { maxRequests: 1 });
  await f.stream([{ type: 'finish', reason: { kind: 'stop' } }]);
  f.events.push({ seq: 2, type: 'tool/result', data: { recent: true } });
  await assert.rejects(f.stream([]), /boundary reached/);
  const boundary = await f.evidence(); assert.equal(boundary.reason, 'request-budget');
  assert.equal(boundary.histories[0].events.at(-1).seq, 2); assert.equal(f.state.next, 1);
});

test('consumer return waits for upstream closure and records cancellation without inventing an error', async t => {
  const f = await fixture(t); let release, closing = false;
  const source = (async function* () { try { yield { type: 'text-delta', text: 'partial' }; } finally { closing = true; await new Promise(resolve => { release = resolve; }); } })();
  const stream = f.iterator(source); await stream.next(); const returned = stream.return();
  await pause(0); assert.equal(closing, true); assert.equal((await f.evidence()).requests[0].status, 'running');
  release(); await returned; const request = (await f.evidence()).requests[0];
  assert.equal(request.status, 'cancelled'); assert.equal(request.error, undefined); assert.ok(request.endedAt >= request.startedAt);
  assert.deepEqual((await f.evidence()).usageMissingRequests, [1]);
});

test('partial usage, completed streams and actual thrown errors retain distinct outcomes', async t => {
  const f = await fixture(t);
  const partial = f.iterator((async function* () { yield { type: 'usage', usage: { totalTokens: 4 } }; yield { type: 'text-delta', text: 'unused' }; })());
  await partial.next(); await partial.return();
  await f.stream([{ type: 'usage', usage: { totalTokens: 6 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  const error = new Error('actual upstream abort'); error.name = 'AbortError';
  await assert.rejects(async () => { for await (const _ of f.iterator((async function* () { throw error; })())) {} }, /actual upstream abort/);
  const evidence = await f.evidence(); assert.deepEqual(evidence.requests.map(request => request.status), ['cancelled', 'completed', 'failed']);
  assert.equal(evidence.totalReportedTokens, 10); assert.equal(evidence.requests[0].error, undefined);
  assert.equal(evidence.requests[2].error, 'actual upstream abort'); assert.deepEqual(evidence.usageMissingRequests, [3]);
});

for (const source of ['user-dsh', 'user-agents', 'custom']) test(`global ${source} skill origins are rejected before Main or model admission, regardless of skill name`, async t => {
  const f = await fixture(t, {}, { complete: true, skills: [{ name: 'agent-team', source, provider: 'filesystem' }] });
  const evidence = await f.evidence(); assert.equal(evidence.status, 'ERROR');
  assert.match(evidence.error, /Unexpected global skill origin/); assert.equal(f.state.created, 0); assert.equal(f.state.invoked, 0); assert.equal(evidence.requests.length, 0);
});

test('an incomplete global catalog is refused instead of treating skipped providers as empty', async t => {
  const f = await fixture(t, {}, { complete: false, skills: [] });
  assert.equal((await f.evidence()).status, 'ERROR'); assert.equal(f.state.created, 0); assert.equal(f.state.next, 0);
});

test('a changed global origin is rejected at the request boundary before the provider is entered', async t => {
  const f = await fixture(t); f.state.catalog = { complete: true, skills: [{ name: 'agent-team', source: 'user-agents', provider: 'filesystem' }] };
  await assert.rejects(f.stream([]), /Unexpected global skill origin/);
  const evidence = await f.evidence(); assert.equal(evidence.reason, 'global-skill-isolation'); assert.equal(evidence.requests.length, 0); assert.equal(f.state.next, 0);
});

test('a request still running at the business boundary settles only in the shutdown witness', async t => {
  const f = await fixture(t, { maxTotalTokens: 10 });
  const partial = f.iterator((async function* () { yield { type: 'text-delta', text: 'partial' }; })());
  await partial.next();
  await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  const boundary = await f.evidence(), frozen = await f.bytes();
  assert.deepEqual(boundary.requests.map(request => request.status), ['running', 'completed']);
  await partial.return();
  const shutdown = await f.evidence('shutdown-evidence.json');
  assert.equal(shutdown.schema, 'flow-natural-shutdown/v1'); assert.equal(shutdown.phase, 'post-boundary-stream');
  assert.deepEqual(shutdown.requests.map(request => request.status), ['cancelled', 'completed']);
  assert.deepEqual(shutdown.usageMissingRequests, [1]); assert.equal(shutdown.totalReportedTokens, 11);
  for (const key of ['number', 'startedAt', 'provider', 'model', 'promptSha256']) assert.equal(shutdown.requests[0][key], boundary.requests[0][key]);
  assert.deepEqual(await f.bytes(), frozen);
});

test('an agents home populated after startup is rejected before any model provider entry', async t => {
  const f = await fixture(t); await writeFile(join(f.agentsHome, 'unexpected'), 'fixture');
  await assert.rejects(f.stream([]), /must remain empty/);
  assert.equal((await f.evidence()).reason, 'global-skill-isolation'); assert.equal(f.state.next, 0);
});

test('a shared budget boundary captures both Main owners, excludes foreign runs and preserves B1 records', async t => {
  const f = await fixture(t, { maxTotalTokens: 10 }, undefined, 2), other = f.owners[1];
  f.events.push({ seq: 2, type: 'tool/result', data: { owner: 'main' } });
  other.events.push({ seq: 2, type: 'tool/result', data: { owner: other.main.session.id } });
  f.state.assignments[0].status = 'submitted'; other.assignments[0].status = 'cancelled'; f.state.foreignRun = true;
  const partial = f.iterator((async function* () { yield { type: 'text-delta', text: 'partial' }; })(), other.main.session.id);
  await partial.next();
  await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  const boundary = await f.evidence(), frozen = await f.bytes();
  assert.equal(boundary.reason, 'total-token-budget'); assert.equal(boundary.mains.length, 2);
  assert.deepEqual(boundary.histories.map(history => [history.sessionId, history.events.at(-1).seq]), [['main', 2], ['main-2', 2]]);
  assert.deepEqual(boundary.snapshots.map(snapshot => [snapshot.run.id, snapshot.assignments[0].status]), [['run', 'submitted'], ['run-2', 'cancelled']]);
  assert.deepEqual(boundary.mains.map(main => [main.sessionId, main.workspace, main.userTimeline[0].seq]), f.owners.map(owner => [owner.main.session.id, owner.workspace, 1]));
  assert.deepEqual(boundary.operatorRequests, []); assert.deepEqual(boundary.userTimeline, boundary.mains[0].userTimeline);
  assert.deepEqual(boundary.requests.map(request => [request.sessionId, request.status]), [['main-2', 'running'], ['main', 'completed']]);
  await partial.return();
  other.events.push({ seq: 3, type: 'turn/end', data: { reason: { kind: 'cancelled' } } });
  f.handlers.get('agent/disposed')({ agent: other.main });
  f.state.active = [f.main]; f.handlers.get('dispose')(); f.ctx.flow = undefined;
  other.events.push({ seq: 4, type: 'turn/end', data: { afterObserverDispose: true } }); f.exit();
  const shutdown = await f.evidence('shutdown-evidence.json');
  assert.equal(shutdown.phase, 'process-exit'); assert.equal(shutdown.scoringEligible, false);
  assert.equal(shutdown.histories.find(history => history.sessionId === 'main-2').events.at(-1).seq, 4);
  assert.equal(shutdown.requests[0].sessionId, 'main-2'); assert.equal(shutdown.requests[0].status, 'cancelled');
  assert.equal(shutdown.businessBoundary.sha256, createHash('sha256').update(frozen).digest('hex'));
  assert.deepEqual(await f.bytes(), frozen);
});

for (const phase of ['poll', 'finish', 'shutdown']) {
  test(`${phase} excludes another backend with the same caller session for both Main owners`, async t => {
    const f = await fixture(t, { maxTotalTokens: 10 }, undefined, 2);
    if (phase === 'shutdown') await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    const frozen = phase === 'shutdown' ? await f.bytes() : undefined;
    f.state.foreignBackendRun = true; f.state.snapshotReads.length = 0;
    if (phase === 'poll') f.poll();
    else if (phase === 'finish') await f.stream([{ type: 'usage', usage: { totalTokens: 11 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    else { f.handlers.get('dispose')(); f.exit(); }
    const captured = await f.evidence(phase === 'shutdown' ? 'shutdown-evidence.json' : 'evidence.json');
    assert.deepEqual(captured.captureErrors, []);
    assert.deepEqual(captured.snapshots.map(snapshot => [snapshot.run.id, snapshot.run.entry]), f.owners.map(owner => [owner.runId, { backend: 'dsh', callerSessionId: owner.main.session.id }]));
    assert.equal(captured.registry.runs.filter(run => run.entry.backend === 'other-backend').length, 2);
    assert.equal(f.state.snapshotReads.some(id => id.startsWith('foreign-backend-')), false, 'foreign snapshot lookup is a tripwire, not merely filtered after reading');
    if (phase === 'poll') {
      assert.equal(captured.status, 'OBSERVING');
      assert.deepEqual(captured.mains.map(main => main.runIds), [['run'], ['run-2']]);
      assert.deepEqual(captured.mains.map(main => main.observation.terminalAssignments), [[], []]);
    } else if (phase === 'finish') { assert.equal(captured.status, 'ABORTED'); assert.equal(captured.reason, 'total-token-budget'); }
    else { assert.equal(captured.phase, 'process-exit'); assert.deepEqual(await f.bytes(), frozen); }
  });
}
