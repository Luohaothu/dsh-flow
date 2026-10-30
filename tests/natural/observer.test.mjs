import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { apply } from './host.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sdkNames = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-skill'];

async function fixture(t, overrides = {}, catalog = { complete: true, skills: [{ name: 'agent-team', source: 'runtime', provider: 'fixture' }] }) {
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
  await writeFile(scenarioFile, JSON.stringify({ prompt: '/agent-team 核对订单。', workspace, maxRequests: 10, maxTotalTokens: 1000, maxDurationMs: 60000, noProgressMs: 60000, ...overrides }));
  const keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'NATURAL_PROFILE_NAME', 'NATURAL_SCENARIO_FILE', 'NATURAL_PROOF_DIR'];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, NATURAL_PROFILE_NAME: 'web', NATURAL_SCENARIO_FILE: scenarioFile, NATURAL_PROOF_DIR: proof });
  const handlers = new Map(), events = [], trace = [], exits = [];
  const state = { active: [], created: 0, invoked: 0, next: 0, catalog, registrySeq: 1, assignments: [{ id: 'assignment', parentAssignmentId: null, status: 'pending' }] };
  const main = { status: 'idle', session: { id: 'main', header: { cwd: workspace }, snapshotEvents() { trace.push('history'); return events; } } };
  state.active.push(main);
  const projector = { registry() { trace.push('registry'); return { seq: state.registrySeq, runs: [{ id: 'run', entry: { callerSessionId: 'main' } }] }; }, snapshot() { trace.push('snapshot'); return { nodes: [], groups: [], assignments: state.assignments }; } };
  const ctx = { on: (name, handler) => handlers.set(name, handler),
    get: name => name === 'profileContext' ? { installAnchor: profile } : undefined,
    agents: { list: () => state.active }, flow: { dashboardAddress: 'fixture', projector },
    skills: { async snapshot(options) { assert.equal(options, undefined, 'the SDK global view omits cwd and scope'); return state.catalog; } },
    sessionController: { async create() { state.created++; return { sessionId: 'main' }; }, async resolveAgent() { return { agent: main }; } },
    commands: { async execute() { state.invoked++; events.push({ seq: 1, type: 'user/message', data: { source: { kind: 'user' } } }); return { result: { kind: 'success' } }; } },
  };
  let cleared = false; const timer = { unref() {} }; const realClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', () => timer);
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
  const iterator = source => handlers.get('llm/stream')({ provider: 'fixture', model: 'fixture', sessionId: 'main', messages: [] }, () => { state.next++; return source; });
  const stream = async chunks => { for await (const _ of iterator((async function* () { yield* chunks; })())) {} };
  return { ctx, state, main, events, trace, handlers, agentsHome, evidence, bytes, iterator, stream, cleared: () => cleared, exit: () => exits[0]?.() };
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
