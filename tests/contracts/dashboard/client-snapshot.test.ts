import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runFixture } from '../../helpers/contract-run.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';
import { DashboardClient } from '../../../packages/dsh-flow/src/dashboard/client.js';

test('finite snapshot reads preserve panel selection, own cancellation and recover one same-epoch 401 without opening streams', async t => {
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const one = await f.createActive(), two = await f.createActive();
  const server = await DashboardServer.create({ projector, service: f.service, port: 0 });
  const paths: string[] = []; let rejectOnce = false, held: (() => void) | undefined, block = false, pending = false;
  const client = new DashboardClient({ baseUrl: server.address, origin: 'dsh-app://app', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (rejectOnce && path === `/api/runs/${two.id}`) { rejectOnce = false; return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'expired fixture token' } }), { status: 401 }); }
    const response = await fetch(url, init);
    if (block && path === `/api/runs/${two.id}`) { pending = true; await new Promise<void>(resolve => { held = resolve; }); }
    return response;
  } });
  t.after(async () => { held?.(); client.dispose(); await server.dispose(); projector.dispose(); });
  await assert.rejects(client.readRunSnapshot(one.id, new AbortController().signal), /connect/);
  await client.selectRun(one.id); const before = client.getState();
  rejectOnce = true;
  assert.equal((await client.readRunSnapshot(two.id, new AbortController().signal)).run.id, two.id);
  assert.deepEqual(client.getState(), before);
  assert.equal(paths.filter(path => path.endsWith('/events')).length, 2);
  assert.equal(paths.filter(path => path === '/api/token').length, 2);
  const requests = paths.length;
  await assert.rejects(client.readRunSnapshot('missing', new AbortController().signal), /Run is unavailable/);
  assert.equal(paths.length, requests);
  await f.service.release(f.origin(), two);
  for (let attempt = 0; client.getState().registry?.runs.find(run => run.id === two.id)?.status !== 'stopped' && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await client.readRunSnapshot(two.id, new AbortController().signal)).run.status, 'stopped');
  block = true; const abort = new AbortController();
  const abandoned = client.readRunSnapshot(two.id, abort.signal);
  while (!pending) await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error('menu closed')); held!(); await assert.rejects(abandoned, /menu closed/);
  pending = false; const lifetime = client.readRunSnapshot(two.id, new AbortController().signal);
  while (!pending) await new Promise(resolve => setImmediate(resolve));
  client.dispose(); held!(); await assert.rejects(lifetime, /abort|disposed/i);
});

test('snapshot token epoch changes never combine a new process token with the prior registry', async t => {
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const team = await f.createActive(), server = await DashboardServer.create({ projector, service: f.service, port: 0 });
  let reset = false, tokens = 0;
  const client = new DashboardClient({ baseUrl: server.address, origin: 'dsh-app://app', fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/token' && ++tokens > 1) return Response.json({ version: { major: 1, minor: 0 }, epoch: 'new-process', token: 'fixture-next' });
    if (reset && path === `/api/runs/${team.id}`) return Response.json({ error: { code: 'unauthorized', message: 'old process' } }, { status: 401 });
    return fetch(url, init);
  } });
  t.after(async () => { client.dispose(); await server.dispose(); projector.dispose(); });
  await client.connect(); reset = true;
  await assert.rejects(client.readRunSnapshot(team.id, new AbortController().signal), /epoch changed/);
  assert.equal(client.getState().selectedRunId, null); assert.equal(client.getState().snapshot, null);
  assert.notEqual(client.getState().epoch, client.getState().registry!.epoch);
});
