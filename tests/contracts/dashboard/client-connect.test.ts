import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { DashboardClient, DashboardRequestError } from '../../../packages/dsh-flow/src/dashboard/client.js';
import { PROTOCOL_VERSION } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { until } from '../../helpers/contract-runtime.js';

const registry = { version: PROTOCOL_VERSION, epoch: 'epoch', seq: 0, runs: [] };
const token = { version: PROTOCOL_VERSION, epoch: 'epoch', token: 'token' };
function stream() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': ready\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream', 'X-Flow-Replay-Through': '0' } }); }

test('real HTTP initial 503 and consecutive failures release the same-instance connect slot for a successful retry', async () => {
  let tokens = 0, reads = 0, subscriptions = 0;
  const server = createServer((request, response) => {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/api/token') { tokens++; json(200, token); return; }
    if (request.url === '/api/runs') { reads++; json(reads <= 2 ? 503 : 200, reads <= 2 ? { error: 'temporary' } : registry); return; }
    subscriptions++; response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Flow-Replay-Through': '0' }); response.write(': ready\n\n');
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new DashboardClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const connecting = client.connect(); assert.equal(client.connect(), connecting);
      await assert.rejects(connecting, /503/); assert.equal(client.getState().registry, null); assert.equal(client.getState().connection, 'error');
    }
    const connecting = client.connect(); assert.equal(client.connect(), connecting); await connecting;
    assert.deepEqual(client.getState().registry, registry); assert.equal(client.getState().connection, 'connected');
    await until(() => subscriptions === 1); await client.connect(); assert.equal(tokens, 3); assert.equal(reads, 3); assert.equal(subscriptions, 1);
  } finally { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('connect subscribers reenter one installed promise and simultaneous callers cannot start duplicate initialization', async () => {
  let tokens = 0, reads = 0, streams = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const client = new DashboardClient({ baseUrl: 'http://localhost', fetch: async url => {
    if (String(url).endsWith('/api/token')) { tokens++; await ready; return Response.json(token); }
    if (String(url).endsWith('/api/runs')) { reads++; return Response.json(registry); }
    streams++; return stream();
  } });
  let reentrant: Promise<void> | undefined;
  client.subscribe(state => { if (state.connection === 'connecting') reentrant = client.connect(); });
  try {
    const one = client.connect(), two = client.connect(); assert.equal(one, two);
    await until(() => tokens === 1); assert.equal(reentrant, one); release(); await Promise.all([one, two]);
    await until(() => streams === 1); assert.equal(reads, 1); assert.equal(tokens, 1);
  } finally { release(); client.dispose(); }
});

test('dispose aborts in-flight initialization, rejects its shared promise and prevents later retries', async () => {
  let entered = false, aborted = false;
  const client = new DashboardClient({ baseUrl: 'http://localhost', fetch: async (_url, init) => {
    entered = true;
    return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true }); });
  } });
  const one = client.connect(), two = client.connect(); assert.equal(one, two);
  const rejected = assert.rejects(one); await until(() => entered); client.dispose(); await rejected;
  assert.equal(aborted, true); assert.equal(client.getState().connection, 'disposed'); await assert.rejects(client.connect(), /disposed/);
});

test('dispose before the initialization microtask sends no request, and incompatible major never becomes a successful retry', async () => {
  let requests = 0;
  const disposed = new DashboardClient({ baseUrl: 'http://localhost', fetch: async () => { requests++; return Response.json(token); } });
  const pending = disposed.connect(), rejected = assert.rejects(pending); disposed.dispose(); await rejected; assert.equal(requests, 0);
  const incompatible = new DashboardClient({ baseUrl: 'http://localhost', fetch: async () => { requests++; return Response.json({ ...token, version: { major: 999, minor: 0 } }); } });
  try { await assert.rejects(incompatible.connect(), /Incompatible/); await assert.rejects(incompatible.connect(), /Incompatible/); assert.equal(requests, 2); assert.equal(incompatible.getState().registry, null); }
  finally { incompatible.dispose(); }
});


test('malformed error bodies retain safe status fallback without inventing a server code or snapshot reset', async () => {
  for (const body of ['not JSON', 'null', '{"error":{"code":123,"message":{"text":"bad"}}}']) {
    let requests = 0;
    const client = new DashboardClient({ baseUrl: 'http://localhost', fetch: async () => { requests++; return new Response(body, { status: 409 }); } });
    try {
      await assert.rejects(client.stop('run', { operationId: 'malformed', targetEpoch: 'epoch', scope: 'run' }), error =>
        error instanceof DashboardRequestError && error.status === 409 && error.code === undefined && error.message === 'Dashboard request failed (409)');
      assert.equal(requests, 1);
    } finally { client.dispose(); }
  }
});
