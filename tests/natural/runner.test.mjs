import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { drainFlow } from './flow-drain.mjs';
import { createDrainEvidenceReader } from './evidence-view.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const source = fileURLToPath(new URL('./run.mjs', import.meta.url));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

async function fixture(t, body, preexisting = {}, environment = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flow-runner-')));
  const runner = join(root, 'tests/natural/run.mjs');
  const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const home = join(root, '.artifacts/home');
  const proof = join(root, '.artifacts/proof');
  const scenario = join(root, '.artifacts/scenario.json');
  for (const path of [dirname(runner), dirname(cli), join(home, 'profiles/web'), proof]) await mkdir(path, { recursive: true });
  await copyFile(source, runner);
  await copyFile(fileURLToPath(new URL('./flow-drain.mjs', import.meta.url)), join(dirname(runner), 'flow-drain.mjs'));
  await copyFile(fileURLToPath(new URL('./evidence-view.mjs', import.meta.url)), join(dirname(runner), 'evidence-view.mjs'));
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: { 'dsh-flow': '0.1.0' }, dsh: { profile: { bundles: ['dsh-flow'] } } }));
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '[]\n');
  await writeFile(scenario, JSON.stringify({ maxDurationMs: 1000 }));
  await writeFile(cli, `const fs = require('node:fs');\nconst { join } = require('node:path');\nconst proof = process.env.NATURAL_PROOF_DIR;\nfs.writeFileSync(join(proof, 'host.json'), JSON.stringify({ pid: process.pid }));\n${body}\n`);
  for (const [name, content] of Object.entries(preexisting)) await writeFile(join(proof, name), content);
  const child = spawn(process.execPath, [runner], { cwd: root, env: { ...process.env, DSH_HOME: home, NATURAL_SCENARIO_FILE: scenario, NATURAL_PROOF_DIR: proof, NATURAL_PROFILE_NAME: 'web', NATURAL_UI_HOLD_MS: '0', NATURAL_PORT: '3191', NATURAL_FLOW_DRAIN_MS: '150000', ...environment } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => {
    for (const name of ['host.json', 'descendant.json']) {
      try {
        const { pid } = JSON.parse(await readFile(join(proof, name), 'utf8'));
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
    await rm(root, { recursive: true, force: true });
  });
  return { child, ended, proof, output: () => output };
}

async function completed(fixture) {
  let timer;
  try {
    return await Promise.race([fixture.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runner did not close its owned process pipes')), 4000); })]);
  } finally { clearTimeout(timer); }
}

async function stopped(pid) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await pause(20);
  assert.equal(alive(pid), false, `Owned process ${pid} must no longer exist`);
}

test('runner closes inherited stdio and terminates a descendant after the CLI exits', { skip: process.platform === 'win32', timeout: 7000 }, async t => {
  const f = await fixture(t, `
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(process.env.NATURAL_PROOF_DIR,'descendant.json'),JSON.stringify({pid:process.pid}));console.log('descendant ready');setInterval(()=>{},1000)"], { stdio: 'inherit' });
descendant.unref();
const ready = setInterval(() => { if (fs.existsSync(join(proof, 'descendant.json'))) { clearInterval(ready); process.exit(0); } }, 10);
`);
  const code = await completed(f);
  assert.equal(code, 1, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(receipt.runnerReason, 'host-exited-before-runner-stop');
  assert.equal(receipt.runnerOwnedStop, true);
  assert.equal(receipt.forced, false);
  const descendant = JSON.parse(await readFile(join(f.proof, 'descendant.json'), 'utf8'));
  await stopped(descendant.pid);
  await stopped(receipt.pid);
});

test('runner settles and stops its live CLI without forcing termination', { timeout: 7000 }, async t => {
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(join(proof, 'evidence.json'), JSON.stringify({ status: 'SETTLED', reason: 'plain-main-ended', requests: [] }));
setInterval(() => {}, 1000);
`);
  const code = await completed(f);
  assert.equal(code, 0, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(receipt.observerStatus, 'SETTLED');
  assert.equal(receipt.runnerReason, 'observer-settled');
  assert.equal(receipt.runnerOwnedStop, true);
  assert.equal(receipt.forced, false);
  await stopped(receipt.pid);
});


test('runner rejects a stale operator finish request before launching the host', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);', { 'finish-request.json': JSON.stringify({ sessionId: 'old-main', afterUserSeq: 1 }) });
  assert.equal(await completed(f), 1, f.output());
  assert.equal(JSON.parse(f.output().trim()).errorCode, 'ERR_ASSERTION');
  await assert.rejects(readFile(join(f.proof, 'host.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.proof, 'process.json')), { code: 'ENOENT' });
});

const fixtureToken = 'fixture-transient-dashboard-token';
const runInfo = (id, callerSessionId = 'main-1', backend = 'dsh') => ({ id, epoch: 'epoch-1', name: id, entry: { backend, callerSessionId }, rootSummary: { id: `${id}-root`, name: 'root', sessionID: `${id}-session` }, status: 'active', startedAt: 1, pendingAssignmentCount: 1 });
const runSnapshot = run => ({ version: { major: 1, minor: 1 }, seq: 1, run,
  nodes: [{ id: `${run.id}-root`, parentId: null, sessionID: `${run.id}-session`, name: 'root', role: 'fixture role', model: { provider: 'fixture', id: 'fixture' }, permission: 'read-only', task: 'fixture task', status: 'idle', source: { kind: 'create', sourceIds: [] }, waiting: null, outcome: null, termination: null, cleanup: null, markers: [], usage: [], createdAt: 1, terminatedAt: null, messages: [], blackboardWrites: [], assignmentIds: [`${run.id}-job`], groups: [`${run.id}-group`], outputs: [], errors: [] }],
  groups: [{ id: `${run.id}-group`, members: [`${run.id}-root`], dissolved: false, blackboard: [] }],
  assignments: [{ id: `${run.id}-job`, runId: run.id, spec: { name: 'fixture', type: 'fixture', background: 'fixture', requirements: 'fixture', acceptanceCriteria: 'fixture', resultSchema: true }, sender: { kind: 'run', runId: run.id }, recipientSessionID: `${run.id}-session`, recipientInstanceId: `${run.id}-root`, parentAssignmentId: null, status: 'pending', submissions: [], submissionCount: 0, schemaFailures: 0, schemaDialect: 'https://json-schema.org/draft/2020-12/schema', schemaDigest: 'fixture-digest', continuingChildren: [] }], prices: [], operations: [] });
const boundary = (address, runs = [runInfo('owned')], status = 'ABORTED', reason = 'total-token-budget') => ({ status, reason, endedAt: 10, dashboardAddress: address, mains: [{ sessionId: 'main-1' }], requests: [{ number: 1, status: 'completed', usage: { totalTokens: 20 } }], totalReportedTokens: 20, usageMissingRequests: [], snapshots: runs.map(runSnapshot) });
const evidenceRecord = value => ({ value, bytes: Buffer.from(JSON.stringify(value, null, 2)) });
const shutdownFor = (record, requests) => ({ schema: 'flow-natural-shutdown/v1', phase: 'post-boundary-stream', scoringEligible: false, observedAt: 30, capturedAt: 30,
  businessBoundary: { file: 'evidence.json', sha256: createHash('sha256').update(record.bytes).digest('hex'), status: record.value.status, reason: record.value.reason, endedAt: record.value.endedAt },
  requests, histories: [{ sessionId: 'main-1', events: [{ seq: 99, type: 'turn/end', data: { reason: { kind: 'completed' } } }] }], registry: null, snapshots: [], captureErrors: [] });

async function dashboard(t, mode = 'complete', extra = []) {
  const state = { reads: 0, paths: [], stops: [], rejectedStops: [], tokenRequests: 0, token: fixtureToken, authFailures: 0, snapshots: new Map([runInfo('owned'), ...extra].map(run => [run.id, runSnapshot(run)])), terminalReads: [], lateAdded: false };
  const server = createServer(async (request, response) => {
    const send = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    state.paths.push(request.url);
    try {
      assert.equal(request.headers.origin, 'http://127.0.0.1:3191');
      assert.equal(request.headers.host, new URL(state.address).host);
      if (request.url === '/api/token') {
        if (mode === 'hang') return;
        if (mode === 'redirect') { response.writeHead(302, { Location: state.address + '/redirect-target' }); response.end(); return; }
        state.tokenRequests++;
        state.token = state.tokenRequests === 1 ? fixtureToken : `${fixtureToken}-${state.tokenRequests}`;
        send(200, { token: mode === 'auth-invalid' && state.tokenRequests > 1 ? undefined : state.token, epoch: mode === 'epoch' || mode === 'auth-epoch' && state.tokenRequests > 1 ? 'epoch-2' : 'epoch-1', version: { major: 1, minor: 1 } }); return;
      }
      assert.equal(request.headers.authorization, `Bearer ${state.token}`);
      const expiryPath = mode === 'auth-stop' ? request.url.endsWith('/stop') : mode === 'auth-snapshot' ? request.url === '/api/runs/owned' : request.url === '/api/runs';
      if (mode.startsWith('auth-') && expiryPath && (state.authFailures === 0 || mode === 'auth-repeat')) {
        state.authFailures++;
        if (request.url.endsWith('/stop')) {
          let raw = ''; for await (const chunk of request) raw += chunk;
          state.rejectedStops.push(JSON.parse(raw));
        }
        send(401, { error: 'expired fixture authentication' }); return;
      }
      if (request.url === '/api/runs') { send(200, { version: { major: 1, minor: 1 }, epoch: 'epoch-1', seq: state.stops.length + 1, runs: [...state.snapshots.values()].map(snapshot => snapshot.run) }); return; }
      const match = request.url.match(/^\/api\/runs\/([^/]+)(\/stop)?$/);
      if (!match || !state.snapshots.has(decodeURIComponent(match[1]))) { send(404, {}); return; }
      const id = decodeURIComponent(match[1]), snapshot = state.snapshots.get(id);
      if (match[2]) {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers['content-type'], 'application/json');
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        assert.deepEqual(Object.keys(body).sort(), ['operationId', 'scope', 'targetEpoch']);
        assert.equal(body.scope, 'run'); assert.equal(body.targetEpoch, 'epoch-1'); assert.equal(typeof body.operationId, 'string');
        state.stops.push({ id, body, at: Date.now() });
        if (mode === 'http-error') { send(500, { error: fixtureToken }); return; }
        snapshot.operations = [{ id: body.operationId, target: { scope: 'run' }, status: mode === 'failed' ? 'failed' : mode === 'timeout' ? 'accepted' : 'completed' }];
        snapshot.run = { ...snapshot.run, status: 'stopped', pendingAssignmentCount: 0, endedAt: Date.now() };
        snapshot.nodes[0] = { ...snapshot.nodes[0], status: 'terminated', terminatedAt: Date.now(), outcome: 'stopped', termination: { signal: 'SIGTERM', initiator: 'user', mode: 'after-turn', propagated: false }, cleanup: { phase: mode === 'cleanup-failed' ? 'failed' : 'complete', timestamp: Date.now() } };
        snapshot.groups[0].dissolved = true; snapshot.assignments[0].status = 'cancelled'; snapshot.seq++;
        if (mode === 'late' && !state.lateAdded) { state.lateAdded = true; state.snapshots.set('late-owned', runSnapshot(runInfo('late-owned'))); }
        send(202, { operationId: body.operationId, status: 'accepted' }); return;
      }
      if (++state.reads >= 2 && mode.startsWith('identity-')) {
        if (mode === 'identity-empty') { snapshot.nodes = []; snapshot.assignments = []; snapshot.groups = []; }
        if (mode === 'identity-duplicate') snapshot.nodes.push(structuredClone(snapshot.nodes[0]));
        if (mode === 'identity-session') snapshot.nodes[0].sessionID = 'changed-session';
        if (mode === 'identity-recipient') snapshot.assignments[0].recipientInstanceId = 'changed-recipient';
        if (mode === 'identity-first-get') snapshot.nodes = [];
      }
      if (snapshot.operations.some(operation => operation.status === 'completed')) state.terminalReads.push({ id, at: Date.now() });
      send(200, mode === 'partial' ? { run: snapshot.run, nodes: snapshot.nodes } : snapshot);
    } catch (error) { state.error = error; send(500, {}); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.address = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (state.error) throw state.error; });
  return state;
}

async function drainFixture(t, mode = 'complete', evidencePatch = {}) {
  const server = await dashboard(t, mode);
  const evidence = { ...boundary(server.address), ...evidencePatch }, original = JSON.stringify(evidence);
  const files = new Map();
  const receipt = await drainFlow({ evidence, origin: 'http://127.0.0.1:3191', write: (name, value) => files.set(name, value), timeoutMs: 450, stableMs: 10 });
  assert.equal(JSON.stringify(evidence), original);
  assert.equal([...files.values()].join('').includes(fixtureToken), false);
  return { server, receipt, files };
}

for (const mode of ['auth-registry', 'auth-snapshot', 'auth-stop']) {
  test(`drain renews expired authentication for ${mode.slice(5)} and preserves the operation identity`, async t => {
    const server = await dashboard(t, mode), evidence = boundary(server.address), original = JSON.stringify(evidence), files = new Map();
    const receipt = await drainFlow({ evidence, origin: 'http://127.0.0.1:3191', write: (name, value) => files.set(name, value), timeoutMs: 2000, stableMs: 10 });
    assert.equal(receipt.status, 'completed'); assert.equal(server.tokenRequests, 2); assert.equal(receipt.tokenRefreshes, 1);
    assert.equal(server.stops.length, 1); assert.equal(JSON.stringify(evidence), original);
    assert.equal([...files.values()].join('').includes(fixtureToken), false);
    if (mode === 'auth-stop') assert.deepEqual(server.rejectedStops, [server.stops[0].body]);
  });
}

for (const [mode, reason] of [['auth-epoch', 'dashboard-token-epoch-changed'], ['auth-invalid', 'dashboard-token-protocol-invalid'], ['auth-repeat', 'dashboard-http-401']]) {
  test(`drain keeps failed authentication renewal ${mode.slice(5)} pending without looping or stopping another epoch`, async t => {
    const server = await dashboard(t, mode), evidence = boundary(server.address), original = JSON.stringify(evidence), files = new Map();
    const receipt = await drainFlow({ evidence, origin: 'http://127.0.0.1:3191', write: (name, value) => files.set(name, value), timeoutMs: 2000, stableMs: 10 });
    assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, reason); assert.equal(server.tokenRequests, 2);
    assert.equal(server.stops.length, 0); assert.equal(JSON.stringify(evidence), original);
    assert.equal([...files.values()].join('').includes(fixtureToken), false);
  });
}

test('budget abort drains exact owned runs and late registry additions before SIGINT while retaining ABORTED', { timeout: 7000 }, async t => {
  const server = await dashboard(t, 'late', [runInfo('other-main', 'other-main'), runInfo('other-backend', 'main-1', 'other-backend')]);
  const evidence = boundary(server.address), raw = JSON.stringify(evidence);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (alive(unrelated.pid)) unrelated.kill('SIGKILL'); });
  const f = await fixture(t, `
process.on('SIGINT', () => {
  fs.writeFileSync(join(proof, 'signal.json'), JSON.stringify({ at: Date.now(), drain: JSON.parse(fs.readFileSync(join(proof, 'flow-drain.json'), 'utf8')).status }));
  process.exit(130);
});
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setInterval(() => {}, 1000);
`, {}, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: server.address, HTTPS_PROXY: server.address, ALL_PROXY: server.address, NO_PROXY: '' });
  assert.equal(await completed(f), 1, f.output());
  assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
  const receipt = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  const processReceipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  const signal = JSON.parse(await readFile(join(f.proof, 'signal.json'), 'utf8'));
  assert.equal(await readFile(join(f.proof, receipt.boundaryEvidence.file), 'utf8'), raw);
  assert.equal(receipt.boundaryEvidence.bytes, Buffer.byteLength(raw));
  assert.equal(receipt.boundaryEvidence.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(receipt.status, 'completed'); assert.equal(processReceipt.observerStatus, 'ABORTED');
  assert.equal(processReceipt.runnerReason, 'observer-ended-without-settling'); assert.equal(processReceipt.forced, false);
  assert.deepEqual(server.stops.map(stop => stop.id).sort(), ['late-owned', 'owned']);
  assert.equal(server.stops.every(stop => stop.body.targetEpoch === 'epoch-1'), true);
  assert.equal(signal.drain, 'completed'); assert.ok(receipt.endedAt <= processReceipt.stopRequestedAt);
  assert.ok(server.terminalReads.every(read => read.at <= signal.at));
  assert.equal(alive(unrelated.pid), true);
  for (const target of receipt.targets) {
    const snapshot = JSON.parse(await readFile(join(f.proof, target.terminalSnapshotFile), 'utf8'));
    assert.equal(snapshot.run.id, target.runId); assert.equal(snapshot.nodes[0].cleanup.phase, 'complete');
    assert.equal(snapshot.operations.find(operation => operation.id === target.operationId).status, 'completed');
  }
  const allFiles = await Promise.all((await readdir(f.proof)).map(name => readFile(join(f.proof, name), 'utf8')));
  assert.equal(allFiles.join('').includes(fixtureToken), false); assert.equal(f.output().includes(fixtureToken), false);
});

for (const status of ['completed', 'cancelled']) {
  test(`runner drains a frozen business boundary after shutdown request becomes ${status}`, { timeout: 7000 }, async t => {
    const server = await dashboard(t), evidence = boundary(server.address);
    const original = { number: 1, sessionId: 'main-1', afterEventSeq: 5, startedAt: 1, provider: 'fixture', model: 'fixture', promptSha256: 'fixture-digest', tools: ['fixture-tool'], status: 'running', usage: { totalTokens: 4 } };
    evidence.requests = [original]; evidence.totalReportedTokens = 4;
    const record = evidenceRecord(evidence), raw = record.bytes.toString();
    const terminal = { ...original, status, endedAt: 30 };
    if (status === 'completed') terminal.usage = { totalTokens: 9 }; else delete terminal.usage;
    const shutdown = JSON.stringify(shutdownFor(record, [terminal]));
    const finalShutdown = JSON.stringify({ ...shutdownFor(record, [terminal]), phase: 'process-exit', observedAt: 31, histories: [{ sessionId: 'main-1', events: [{ seq: 100, type: 'agent/disposed' }] }] });
    const f = await fixture(t, `
process.on('SIGINT', () => {
  fs.writeFileSync(join(proof, 'shutdown-evidence.json'), ${JSON.stringify(finalShutdown)});
  process.exit(130);
});
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setTimeout(() => fs.writeFileSync(join(proof, 'shutdown-evidence.json'), '{'), 150);
setTimeout(() => fs.writeFileSync(join(proof, 'shutdown-evidence.json'), ${JSON.stringify(shutdown)}), 450);
setInterval(() => {}, 1000);
`);
    assert.equal(await completed(f), 1, f.output());
    assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
    assert.equal(await readFile(join(f.proof, 'flow-drain-boundary-evidence.json'), 'utf8'), raw);
    const drain = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
    const processReceipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
    assert.equal(drain.status, 'completed'); assert.equal(drain.runningRequests, 0);
    assert.equal(drain.requestBoundary.source.file, 'shutdown-evidence.json');
    assert.equal(drain.requestBoundary.source.sha256, createHash('sha256').update(shutdown).digest('hex'));
    assert.equal(await readFile(join(f.proof, drain.requestBoundary.source.frozenFile), 'utf8'), shutdown);
    assert.equal(await readFile(join(f.proof, 'shutdown-evidence.json'), 'utf8'), finalShutdown);
    assert.equal(drain.requestBoundary.totalReportedTokens, status === 'completed' ? 9 : 0);
    assert.deepEqual(drain.requestBoundary.usageMissingRequests, status === 'completed' ? [] : [1]);
    assert.equal(processReceipt.observerStatus, 'ABORTED'); assert.equal(processReceipt.runnerReason, 'observer-ended-without-settling');
    assert.equal(JSON.parse(f.output().trim()).status, 'INCOMPLETE');
  });
}

test('runner keeps frozen requests running without a shutdown witness', { timeout: 7000 }, async t => {
  const server = await dashboard(t), evidence = boundary(server.address);
  evidence.requests = [{ number: 1, status: 'running' }];
  const raw = JSON.stringify(evidence);
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(130));
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setInterval(() => {}, 1000);
`, {}, { NATURAL_FLOW_DRAIN_MS: '350' });
  assert.equal(await completed(f), 1, f.output());
  const drain = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  assert.equal(drain.status, 'pending'); assert.equal(drain.reason, 'drain-timeout'); assert.equal(drain.runningRequests, 1);
  assert.equal(drain.requestBoundary.source.mode, 'legacy-observer');
  assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
});

test('drain rejects an invalid bound shutdown instead of completing already terminal business requests', async t => {
  const server = await dashboard(t), record = evidenceRecord(boundary(server.address));
  const shutdown = shutdownFor(record, record.value.requests); shutdown.businessBoundary.sha256 = '0'.repeat(64);
  const files = new Map([['evidence.json', record], ['shutdown-evidence.json', evidenceRecord(shutdown)]]);
  const refreshEvidence = createDrainEvidenceReader({ boundary: record, read: name => files.get(name) });
  const receipt = await drainFlow({ evidence: record.value, origin: 'http://127.0.0.1:3191', write: () => {}, timeoutMs: 450, stableMs: 10, refreshEvidence });
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'evidence-shutdown-boundary-mismatch');
  assert.equal(receipt.targets.every(target => target.status === 'pending'), true);
});

test('runner refuses a shutdown symlink through the same no-follow evidence reader', { timeout: 7000 }, async t => {
  const server = await dashboard(t), record = evidenceRecord(boundary(server.address));
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(130));
fs.writeFileSync(join(proof, 'other.json'), ${JSON.stringify(JSON.stringify(shutdownFor(record, record.value.requests)))});
fs.symlinkSync(join(proof, 'other.json'), join(proof, 'shutdown-evidence.json'));
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(record.bytes.toString())});
setInterval(() => {}, 1000);
`);
  assert.equal(await completed(f), 1, f.output());
  const drain = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  assert.equal(drain.status, 'pending'); assert.equal(drain.reason, 'drain-request-or-output-error');
});

test('runner rejects preexisting shutdown evidence before starting its owned CLI', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);', { 'shutdown-evidence.json': '{}' });
  assert.equal(await completed(f), 1, f.output());
  await assert.rejects(readFile(join(f.proof, 'host.json')), { code: 'ENOENT' });
});

test('drain rejects noncanonical or nonloopback endpoints before any request', async () => {
  for (const dashboardAddress of ['https://127.0.0.1:54321', 'http://localhost:54321', 'http://127.0.0.2:54321', 'http://127.0.0.1:54321/', 'http://127.0.0.1:54321/api', 'http://user@127.0.0.1:54321', 'http://127.0.0.1:54321?x=1', 'http://127.0.0.1:54321#x', 'http://2130706433:54321', 'http://[::1]:54321']) {
    const files = new Map();
    const receipt = await drainFlow({ evidence: boundary(dashboardAddress), origin: 'http://127.0.0.1:3191', write: (name, value) => files.set(name, value), timeoutMs: 20 });
    assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'dashboard-address-invalid'); assert.equal(receipt.responses.length, 0);
  }
});

for (const [mode, reason] of [['hang', 'drain-timeout'], ['timeout', 'drain-timeout'], ['failed', 'stop-operation-failed'], ['http-error', 'dashboard-http-500'], ['epoch', 'observed-epoch-mismatch'], ['partial', 'snapshot-protocol-or-owner-invalid'], ['cleanup-failed', 'drain-timeout'], ['redirect', 'dashboard-http-302']]) {
  test(`drain keeps ${mode} pending without changing original business evidence or storing token`, async t => {
    const { server, receipt } = await drainFixture(t, mode);
    assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, reason);
    assert.equal(receipt.targets.some(target => target.status === 'completed'), false);
    if (mode === 'redirect') assert.deepEqual(server.paths, ['/api/token']);
    if (mode === 'epoch') assert.equal(server.stops.length, 0);
  });
}

test('drain refuses unowned observed identity and does not issue a stop', async t => {
  const { server, receipt } = await drainFixture(t, 'complete', { snapshots: [runSnapshot(runInfo('owned', 'foreign-main'))] });
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'observed-run-owner-invalid'); assert.equal(server.stops.length, 0);
});

test('a failed business Run can still drain when cleanup and persistence succeed', async t => {
  const server = await dashboard(t);
  server.snapshots.get('owned').run.error = 'original business failure';
  const receipt = await drainFlow({ evidence: boundary(server.address), origin: 'http://127.0.0.1:3191', write: () => {}, timeoutMs: 450, stableMs: 10 });
  assert.equal(receipt.status, 'completed');
});

test('runner records timeout pending and then stops only its host, preserving usage and ABORTED', { timeout: 7000 }, async t => {
  const server = await dashboard(t, 'timeout');
  const evidence = boundary(server.address), raw = JSON.stringify({ ...evidence, requests: [{ number: 1, status: 'cancelled' }], usageMissingRequests: [1] });
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(130));
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setInterval(() => {}, 1000);
`, {}, { NATURAL_FLOW_DRAIN_MS: '200' });
  assert.equal(await completed(f), 1, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'drain-timeout');
  assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
  assert.deepEqual(receipt.requestBoundary.usageMissingRequests, [1]);
  const processReceipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(processReceipt.flowDrain.status, 'pending'); assert.equal(processReceipt.forced, false); await stopped(processReceipt.pid);
});

test('external runner signal interrupts pending HTTP drain and promptly stops the owned host', { timeout: 7000 }, async t => {
  const server = await dashboard(t, 'timeout');
  const raw = JSON.stringify(boundary(server.address));
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(130));
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setInterval(() => {}, 1000);
`);
  const deadline = Date.now() + 2000;
  while (!server.stops.length && Date.now() < deadline) await pause(10);
  assert.equal(server.stops.length, 1);
  f.child.kill('SIGTERM');
  assert.equal(await completed(f), 1, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'drain-interrupted');
  const processReceipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(processReceipt.runnerReason, 'runner-interrupted'); assert.equal(processReceipt.interruptedBy, 'SIGTERM');
  assert.equal(processReceipt.forced, false); await stopped(processReceipt.pid);
});

for (const [status, reason] of [['ABORTED', 'no-progress'], ['ERROR', 'observer-error']]) {
  test(`runner safely exits ${status} without Flow and preserves its failure status`, { timeout: 7000 }, async t => {
    const raw = JSON.stringify({ status, reason, requests: [], snapshots: [] });
    const f = await fixture(t, `
process.on('SIGINT', () => process.exit(130));
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setInterval(() => {}, 1000);
`);
    assert.equal(await completed(f), 1, f.output());
    const receipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
    assert.equal(receipt.flowDrain.status, 'skipped'); assert.equal(receipt.observerStatus, status);
    assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
  });
}


test('host exit during a pending HTTP request interrupts drain without fabricating terminal snapshots', { timeout: 7000 }, async t => {
  const server = await dashboard(t, 'hang');
  const raw = JSON.stringify(boundary(server.address));
  const f = await fixture(t, `
fs.writeFileSync(join(proof, 'evidence.json'), ${JSON.stringify(raw)});
setTimeout(() => process.exit(0), 300);
`);
  assert.equal(await completed(f), 1, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'flow-drain.json'), 'utf8'));
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'drain-interrupted');
  assert.equal(receipt.responses.length, 0); assert.equal(receipt.targets.length, 0);
  const processReceipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(processReceipt.runnerReason, 'host-exited-before-runner-stop');
  assert.equal(await readFile(join(f.proof, 'evidence.json'), 'utf8'), raw);
});

test('drain waits for original in-flight requests to become terminal and keeps missing usage explicit', async t => {
  const server = await dashboard(t);
  const evidence = boundary(server.address);
  evidence.requests = [{ number: 1, status: 'running' }];
  const later = { ...evidence, requests: [{ number: 1, status: 'cancelled' }], usageMissingRequests: [1] };
  let samples = 0;
  const receipt = await drainFlow({ evidence, origin: 'http://127.0.0.1:3191', write: () => {}, timeoutMs: 650, stableMs: 10, refreshEvidence: () => ++samples >= 3 ? later : evidence });
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.runningRequests, 0);
  assert.deepEqual(receipt.requestBoundary.usageMissingRequests, [1]); assert.equal(evidence.requests[0].status, 'running');
});


for (const [mode, reason] of [['identity-empty', 'snapshot-observed-identity-missing'], ['identity-duplicate', 'snapshot-identity-invalid-or-duplicate'], ['identity-session', 'snapshot-identity-changed'], ['identity-recipient', 'snapshot-identity-changed']]) {
  test(`drain keeps ${mode} pending instead of accepting vacuous or drifting terminal membership`, async t => {
    const { receipt } = await drainFixture(t, mode);
    assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, reason);
    assert.equal(receipt.targets.some(target => target.status === 'completed'), false);
  });
}

test('drain preserves identities first seen by the HTTP reader when observer membership is empty', async t => {
  const server = await dashboard(t, 'identity-first-get');
  const evidence = boundary(server.address);
  evidence.snapshots[0].nodes = [];
  const receipt = await drainFlow({ evidence, origin: 'http://127.0.0.1:3191', write: () => {}, timeoutMs: 450, stableMs: 10 });
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.reason, 'snapshot-observed-identity-missing');
});
