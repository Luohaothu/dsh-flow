import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeRunEvent, decodeSnapshot } from '../../../packages/dsh-flow/src/dashboard/decoder.js';
import { PricingCatalog } from '../../../packages/dsh-flow/src/dashboard/pricing.js';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import type { TokenResponse, RunSnapshot } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { runFixture, waitFor } from '../../helpers/contract-run.js';

async function raw(base: string, path: string, headers: Record<string, string> = {}, localAddress?: string): Promise<number> {
  return new Promise((yes, no) => { const request = httpRequest({ hostname: new URL(base).hostname, port: new URL(base).port, path, headers, ...(localAddress ? { localAddress } : {}) }, response => { response.resume(); response.on('end', () => yes(response.statusCode!)); }); request.on('error', no); request.end(); });
}
async function setup(t: Parameters<typeof runFixture>[0], options: Partial<Parameters<typeof DashboardServer.create>[0]> = {},
  projection: Omit<ConstructorParameters<typeof DashboardProjector>[1], 'directory'> = {}) {
  const f = await runFixture(t); const projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events'), ...projection });
  const server = await DashboardServer.create({ projector, service: f.service, ...options });
  t.after(async () => { await server.dispose(); projector.dispose(); });
  const credentials = await fetch(server.address + '/api/token', { headers: { Origin: 'dsh-app://app' } }).then(response => response.json()) as TokenResponse;
  const auth = { Authorization: `Bearer ${credentials.token}` };
  return { ...f, projector, server, credentials, auth };
}

test('real HTTP checks exact Host with port, loopback remote address and exact declared origins', async t => {
  const f = await setup(t); assert.match(f.server.address, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await raw(f.server.address, '/api/token', { Host: 'localhost', Origin: 'dsh-app://app' }), 403);
  assert.equal(await raw(f.server.address, '/api/token', { Host: new URL(f.server.address).hostname, Origin: 'dsh-app://app' }), 403);
  for (const origin of ['null', 'https://evil.example', 'dsh-app://app.evil', 'dsh-app://app/', 'dsh-app://other']) assert.equal((await fetch(f.server.address + '/api/token', { headers: { Origin: origin } })).status, 403);
  const nonlocal = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  if (nonlocal) assert.equal(await raw(f.server.address, '/api/token', { Origin: 'dsh-app://app' }, nonlocal), 403);
  assert.equal((await fetch(f.server.address + '/api/token', { headers: { Origin: f.server.address } })).status, 200);
  const preflight = await fetch(f.server.address + '/api/runs/any/stop', { method: 'OPTIONS', headers: { Origin: 'dsh-app://app', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'dsh-app://app');
});

test('token source evidence and no-store; short Bearer expires; HTTP exposes six API routes only', async t => {
  const f = await setup(t, { tokenLifetimeMs: 25 });
  assert.equal((await fetch(f.server.address + '/api/token')).status, 403);
  for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { Referer: f.server.address + '/' }, { 'Sec-Fetch-Site': 'same-origin', Referer: 'https://evil.example/' }]) assert.equal((await fetch(f.server.address + '/api/token', { headers })).status, 403);
  const token = await fetch(f.server.address + '/api/token', { headers: { 'Sec-Fetch-Site': 'same-origin', Referer: f.server.address + '/index.html' } });
  assert.equal(token.status, 200); assert.equal(token.headers.get('cache-control'), 'no-store');
  const fresh = await token.json() as TokenResponse; const headers = { Authorization: `Bearer ${fresh.token}` };
  assert.equal((await fetch(f.server.address + '/api/runs', { headers })).status, 200);
  assert.equal((await fetch(f.server.address + '/api/runs')).status, 401);
  for (const path of ['/api/agents', '/api/runs/r/input', '/api/runs/r/messages', '/api/rpc']) assert.equal((await fetch(f.server.address + path, { headers })).status, 404);
  await delay(35); assert.equal((await fetch(f.server.address + '/api/runs', { headers })).status, 401);
});

test('real HTTP snapshot and fetch SSE continue cursor, reject stale epoch, and stop accepts separately from result', async t => {
  const f = await setup(t); const run = await f.createActive();
  const snapshot = await fetch(f.server.address + `/api/runs/${run.id}`, { headers: f.auth }).then(response => response.json()) as RunSnapshot;
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.server.address + `/api/runs/${run.id}/events?after=${snapshot.seq}&epoch=${f.credentials.epoch}`, { headers: f.auth, signal: abort.signal });
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader(); await reader.read();
  const stopBody = JSON.stringify({ operationId: 'release-http', targetEpoch: f.credentials.epoch, scope: 'run' });
  assert.equal((await fetch(f.server.address + `/api/runs/${run.id}/stop`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json' }, body: stopBody })).status, 403);
  const response = await fetch(f.server.address + `/api/runs/${run.id}/stop`, { method: 'POST', headers: { ...f.auth, Origin: 'dsh-app://app', 'Content-Type': 'application/json' }, body: stopBody });
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { operationId: 'release-http', status: 'accepted' });
  let text = ''; while (!text.includes('operation-result')) { const event = await reader.read(); if (event.done) break; text += new TextDecoder().decode(event.value); }
  assert.match(text, /operation-result/); await waitFor(() => run.status === 'stopped');
  assert.equal(f.projector.snapshot(run.id).operations[0]?.status, 'completed'); abort.abort();
  for (const suffix of [`after=${snapshot.seq}&epoch=wrong`, `after=999999&epoch=${f.credentials.epoch}`, `after=-1&epoch=${f.credentials.epoch}`]) assert.equal((await fetch(f.server.address + `/api/runs/${run.id}/events?${suffix}`, { headers: f.auth })).status, 409);
});

test('authenticated snapshots and event streams estimate observed calls without changing configured prices', async t => {
  const requested: string[] = [];
  const pricedModel = { provider: 'deepseek-official', id: 'deepseek-flash' };
  const overriddenModel = { provider: 'openrouter', id: 'qwen/custom' };
  const otherModel = { provider: 'openrouter', id: 'openai/example' };
  const pricing = new PricingCatalog(async input => {
    const url = String(input);
    requested.push(url);
    if (url === 'https://models.dev/api.json') return Response.json({
      deepseek: { models: { 'deepseek-flash': { canonical_model_id: 'deepseek/deepseek-flash', cost: { input: 2, output: 4, reasoning: 8 } } } },
      openrouter: { models: {
        'openai/example': { canonical_model_id: 'openai/example', cost: { input: 1, output: 2 } },
        'qwen/custom': { canonical_model_id: 'alibaba/example', cost: { input: 10, output: 20 } },
      } },
    });
    assert.equal(url, 'https://api.frankfurter.dev/v2/rate/USD/CNY');
    return Response.json({ base: 'USD', quote: 'CNY', rate: 8 });
  });
  const f = await setup(t, {}, { pricing, prices: [{ model: overriddenModel, currency: 'USD', input: 4, output: 2 }] });
  const run = await f.createActive();
  const { host, root } = f.binding(run);
  const emit = (callId: string, model: typeof pricedModel, reasoningTokens?: number) => {
    const timestamp = Date.now();
    host.emit({ type: 'usage', agent: host.native(root), timestamp, usage: {
      timestamp, callId, model, inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    } });
  };
  emit('catalog', pricedModel, 250_000);
  emit('override', overriddenModel);
  const url = f.server.address + `/api/runs/${run.id}`;
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(requested, []);

  const snapshot = decodeSnapshot(await fetch(url, { headers: f.auth }).then(response => response.json()), run.id);
  assert.deepEqual(snapshot.nodes[0]!.usage.map(call => [call.callId, call.amount, call.currency, call.reasoningTokens]), [
    ['catalog', 40, 'CNY', 250_000], ['override', 5, 'USD', undefined],
  ]);
  assert.equal(requested.length, 2);
  emit('before-subscribe', otherModel);
  const abort = new AbortController();
  try {
    const stream = await fetch(`${url}/events?after=${snapshot.seq}&epoch=${snapshot.run.epoch}`, {
      headers: f.auth, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    const nextUsage = async () => {
      for (;;) {
        const separator = buffered.indexOf('\n\n');
        if (separator < 0) {
          const chunk = await reader.read();
          assert.ok(!chunk.done, 'expected a usage event from the open stream');
          buffered += chunk.value;
          continue;
        }
        const block = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = decodeRunEvent(JSON.parse(data.slice(6)));
        if (event.type === 'node-usage') return event.node.usage.at(-1)!;
      }
    };
    const replayed = await nextUsage();
    assert.deepEqual([replayed.callId, replayed.amount, replayed.currency], ['before-subscribe', 2, 'USD']);
    emit('after-subscribe', pricedModel);
    const live = await nextUsage();
    assert.deepEqual([live.callId, live.amount, live.currency], ['after-subscribe', 32, 'CNY']);
    assert.equal(requested.length, 2);
  } finally {
    abort.abort();
  }
});

test('static realpath confines traversal and external symlinks while serving the independent page', async t => {
  const f = await setup(t); const root = join(f.directory, 'web'); await mkdir(root); await writeFile(join(root, 'index.html'), '<h1>Flow</h1>');
  const outside = join(f.directory, 'secret.txt'); await writeFile(outside, 'private'); await symlink(outside, join(root, 'escape.txt'));
  const server = await DashboardServer.create({ projector: f.projector, service: f.service, staticDirectory: root }); t.after(() => server.dispose());
  assert.equal(await fetch(server.address).then(response => response.text()), '<h1>Flow</h1>');
  assert.equal((await fetch(server.address + '/escape.txt')).status, 403);
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt']) assert.equal(await raw(server.address, path), 403);
});

test('SSE byte bounds disconnect oversized events and journal outage closes a live stream and rebaselines actual state', async t => {
  const f = await setup(t, { maxSseBytes: 2048 }); const run = await f.createActive();
  const open = async () => {
    const snapshot = f.projector.snapshot(run.id);
    const response = await fetch(f.server.address + `/api/runs/${run.id}/events?after=${snapshot.seq}&epoch=${f.credentials.epoch}`, { headers: f.auth });
    const reader = response.body!.getReader(); await reader.read(); return { reader, snapshot };
  };
  const first = await open(); f.projector.operation(run.id, { id: 'oversized', target: { agentId: 'x'.repeat(4000) }, status: 'failed', error: 'large' });
  await assert.rejects(first.reader.read());
  const second = await open(); const journalDirectory = join(f.directory, 'events', 'runs'); await rename(journalDirectory, journalDirectory + '.saved'); await writeFile(journalDirectory, 'blocked');
  f.projector.operation(run.id, { id: 'outage', target: { scope: 'run' }, status: 'completed' });
  await assert.rejects(second.reader.read());
  const degraded = f.projector.snapshot(run.id); assert.equal(degraded.degraded, true); assert.equal(degraded.operations.find(operation => operation.id === 'outage')?.status, 'completed');
  await rm(journalDirectory); await rename(journalDirectory + '.saved', journalDirectory); const recovered = f.projector.snapshot(run.id); assert.equal(recovered.degraded, undefined); assert.ok(recovered.seq > second.snapshot.seq);
  assert.equal((await fetch(f.server.address + `/api/runs/${run.id}/events?after=${second.snapshot.seq}&epoch=${f.credentials.epoch}`, { headers: f.auth })).status, 409);
});
