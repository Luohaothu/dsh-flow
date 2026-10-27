import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { DashboardClient, consumeSse } from '../../../packages/dsh-flow/src/dashboard/client.js';
import { PROTOCOL_VERSION, type RegistrySnapshot, type RunInfo, type RunSnapshot } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { until } from '../../helpers/contract-runtime.js';

const run = (id = 'one', epoch = 'epoch'): RunInfo => ({ id, epoch, name: id, entry: { backend: 'dsh', callerSessionId: 'main' }, rootSummary: null, status: 'active', startedAt: 1, pendingAssignmentCount: 0 });
const snapshot = (id = 'one', seq = 0, epoch = 'epoch'): RunSnapshot => ({ version: PROTOCOL_VERSION, seq, run: run(id, epoch), nodes: [], groups: [], assignments: [], prices: [], operations: [] });
async function fixture(t: TestContext) {
  const streams = new Map<string, ServerResponse>(), requests: { url: string; auth?: string }[] = [];
  let epoch = 'epoch', token = 'first', seq = 0, runSeq = 0, fail = '', tokens = 0, snapshots = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost'); requests.push({ url: request.url!, ...(request.headers.authorization ? { auth: request.headers.authorization } : {}) });
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/token') { tokens++; assert.equal(request.headers.origin, 'dsh-app://app'); json(200, { token, epoch, version: PROTOCOL_VERSION }); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { json(401, { error: { code: 'unauthorized', message: 'expired' } }); return; }
    if (url.pathname === '/api/runs') { const value: RegistrySnapshot = { version: PROTOCOL_VERSION, epoch, seq, runs: [run('one', epoch), run('two', epoch)] }; json(200, value); return; }
    if (url.pathname.endsWith('/events') || url.pathname === '/api/events') {
      assert.equal(url.searchParams.get('epoch'), epoch);
      if (fail === url.pathname) { fail = ''; json(409, { error: { code: 'reset-required', message: 'cursor outside journal' } }); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); streams.set(url.pathname, response);
      request.on('close', () => { if (streams.get(url.pathname) === response) streams.delete(url.pathname); }); return;
    }
    if (url.pathname.endsWith('/stop')) { assert.equal(request.headers.origin, 'dsh-app://app'); let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => json(202, { operationId: JSON.parse(body).operationId, status: 'accepted' })); return; }
    snapshots++; json(200, snapshot(url.pathname.split('/').at(-1), runSeq, epoch));
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new DashboardClient({ baseUrl: `http://127.0.0.1:${address.port}`, origin: 'dsh-app://app', reconnectDelayMs: 1 });
  t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const send = (path: string, value: unknown) => { const stream = streams.get(path); assert.ok(stream, `stream ${path}`); const text = `data: ${JSON.stringify(value)}\r\n\r\n`; for (const character of text) stream.write(character); };
  return { client, baseUrl: `http://127.0.0.1:${address.port}`, streams, requests, send, rotate: (nextEpoch = epoch) => { epoch = nextEpoch; token = `token-${tokens}`; }, reset: (path: string, registrySeq = seq, nextRunSeq = runSeq) => { seq = registrySeq; runSeq = nextRunSeq; fail = path; streams.get(path)?.end(); }, counts: () => ({ tokens, snapshots }) };
}

test('SSE parser preserves UTF-8, split CRLF, comments and multiline data across byte boundaries', async () => {
  const bytes = new TextEncoder().encode(':comment\r\nevent: future\r\ndata: {"text":\r\ndata: "汉字"}\r\n\r\n');
  const values: unknown[] = [];
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  await consumeSse(response, new AbortController().signal, value => values.push(value)); assert.deepEqual(values, [{ text: '汉字' }]);
});

test('real fetch SSE sends Bearer, independently advances unknown events, skips duplicates, replaces records and submits stop', async t => {
  const f = await fixture(t); await f.client.connect(); await f.client.selectRun('one');
  await until(() => f.streams.has('/api/events') && f.streams.has('/api/runs/one/events'));
  f.send('/api/events', { epoch: 'epoch', seq: 1, type: 'future-registry', node: { id: 'ignored' } });
  f.send('/api/runs/one/events', { timestamp: 1, runId: 'one', seq: 1, type: 'future-run', node: { id: 'ignored' } });
  f.send('/api/runs/one/events', { timestamp: 1, runId: 'one', seq: 1, type: 'future-run' });
  f.send('/api/runs/one/events', { timestamp: 1, runId: 'one', seq: 2, type: 'operation-result', operation: { id: 'stop-one', target: { scope: 'run' }, status: 'completed' } });
  await until(() => f.client.getState().snapshot?.seq === 2 && f.client.getState().registry?.seq === 1);
  assert.deepEqual(f.client.getState().snapshot!.nodes, []); assert.equal(f.client.getState().snapshot!.operations[0]!.status, 'completed');
  const copy = f.client.getState(); copy.snapshot!.seq = 1000; assert.equal(f.client.getState().snapshot!.seq, 2);
  assert.deepEqual(await f.client.stop('one', { operationId: 'stop-one', targetEpoch: 'epoch', scope: 'run' }), { operationId: 'stop-one', status: 'accepted' });
  assert.ok(f.requests.filter(request => request.url.includes('events')).every(request => request.auth === 'Bearer first'));
});

test('gap and server rejected old/future cursors reload snapshots while ordinary disconnect resumes its cursor', async t => {
  const f = await fixture(t); await f.client.selectRun('one'); await until(() => f.streams.has('/api/runs/one/events'));
  f.send('/api/runs/one/events', { timestamp: 1, runId: 'one', seq: 1, type: 'future' }); await until(() => f.client.getState().snapshot?.seq === 1);
  f.streams.get('/api/runs/one/events')!.end();
  await until(() => f.requests.some(request => request.url.includes('/one/events?after=1')));
  await until(() => f.streams.has('/api/runs/one/events'));
  f.send('/api/runs/one/events', { timestamp: 1, runId: 'one', seq: 3, type: 'future' });
  await until(() => f.counts().snapshots >= 2 && f.client.getState().snapshot?.seq === 0);
  await until(() => f.streams.has('/api/runs/one/events'));
  f.reset('/api/runs/one/events', 2, 10);
  await until(() => f.client.getState().snapshot?.seq === 10);
  assert.equal(f.client.getState().registry?.seq, 2);
});

test('401 reacquires token and restart epoch; switching run aborts the old subscription; dispose closes readers', async t => {
  const f = await fixture(t); await f.client.selectRun('one'); await until(() => f.streams.has('/api/runs/one/events'));
  await f.client.selectRun('two'); await until(() => !f.streams.has('/api/runs/one/events') && f.streams.has('/api/runs/two/events'));
  f.rotate('new-epoch'); f.streams.get('/api/runs/two/events')!.end();
  await until(() => f.counts().tokens >= 2 && f.client.getState().snapshot?.run.epoch === 'new-epoch');
  assert.equal(f.client.getState().selectedRunId, 'two'); assert.equal(f.client.getState().registry?.epoch, 'new-epoch');
  f.client.dispose(); await until(() => f.streams.size === 0); assert.equal(f.client.getState().connection, 'disposed');
});

test('incompatible major is rejected before registry reads and preserves a visible error', async () => {
  let requests = 0;
  const client = new DashboardClient({ baseUrl: 'http://localhost', fetch: async () => { requests++; return Response.json({ token: 't', epoch: 'e', version: { major: 999, minor: 0 } }); } });
  await assert.rejects(client.connect(), /Incompatible/); assert.equal(requests, 1); assert.equal(client.getState().connection, 'error'); client.dispose();
});

test('a late snapshot from a superseded selection cannot overwrite the selected run', async t => {
  const f = await fixture(t);
  let resolveLate!: (value: Response) => void, entered!: () => void;
  const late = new Promise<Response>(resolve => { resolveLate = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const baseUrl = f.baseUrl;
  const client = new DashboardClient({ baseUrl, origin: 'dsh-app://app', reconnectDelayMs: 1,
    fetch: (url, init) => { if (String(url).endsWith('/api/runs/one')) { entered(); return late; } return fetch(url, init); } });
  t.after(() => client.dispose());
  const old = client.selectRun('one'); await started;
  await client.selectRun('two'); resolveLate(Response.json(snapshot('one', 88))); await old;
  assert.equal(client.getState().selectedRunId, 'two'); assert.equal(client.getState().snapshot?.run.id, 'two'); assert.equal(client.getState().snapshot?.seq, 0);
});
