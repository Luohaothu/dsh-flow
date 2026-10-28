import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { runFixture } from '../../helpers/contract-run.js';

async function fixture(t: TestContext) {
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const run = await f.createActive(), server = await DashboardServer.create({ projector, service: f.service });
  const sockets: Socket[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const reader of readers) void reader.cancel().catch(() => {});
    await server.dispose(); projector.dispose();
  });
  return { ...f, projector, run, server, sockets, readers };
}

for (const finishHeaders of [false, true]) test(`shutdown closes an accepted incomplete HTTP request${finishHeaders ? ' even when its headers finish during shutdown' : ' without waiting for more client bytes'}`, { timeout: 5_000 }, async t => {
  const f = await fixture(t), address = new URL(f.server.address);
  const credentials = await (await fetch(`${f.server.address}/api/token`, { headers: { Origin: 'dsh-app://app' } })).json() as { token: string };
  const snapshot = f.projector.snapshot(f.run.id);
  const http = Reflect.get(f.server, 'server') as Server;
  const accepted = once(http, 'connection');
  const socket = connect(Number(address.port), address.hostname); f.sockets.push(socket);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const [peer] = await accepted as [Socket];
  const received = once(peer, 'data');
  socket.write(`GET /api/runs/${f.run.id}/events?after=${snapshot.seq}&epoch=${f.service.epoch} HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: dsh-app://app\r\nAuthorization: Bearer ${credentials.token}\r\n`);
  await received;
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  const disposal = f.server.dispose();
  assert.equal(f.server.dispose(), disposal);
  if (finishHeaders) socket.write('\r\n');
  await disposal;
  await closed;
  assert.equal(f.run.status, 'active');
  assert.equal(f.binding(f.run).root.getStatus(), 'idle');
});

test('shutdown closes actual registry and Run SSE readers and leaves the Run alive', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const credentials = await (await fetch(`${f.server.address}/api/token`, { headers: { Origin: 'dsh-app://app' } })).json() as { token: string };
  const headers = { Origin: 'dsh-app://app', Authorization: `Bearer ${credentials.token}` };
  const registry = f.projector.registry(), snapshot = f.projector.snapshot(f.run.id);
  for (const path of [`/api/events?after=${registry.seq}&epoch=${f.service.epoch}`, `/api/runs/${f.run.id}/events?after=${snapshot.seq}&epoch=${f.service.epoch}`]) {
    const response = await fetch(`${f.server.address}${path}`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body!.getReader(); f.readers.push(reader);
    const opening = await reader.read();
    assert.equal(opening.done, false);
    assert.match(new TextDecoder().decode(opening.value), /: connected/);
  }
  const pending = f.readers.map(reader => reader.read().then(result => result.done ? 'closed' : 'data', () => 'closed'));
  await f.server.dispose();
  assert.deepEqual(await Promise.all(pending), ['closed', 'closed']);
  assert.equal(f.run.status, 'active');
  assert.equal(f.binding(f.run).root.getStatus(), 'idle');
});
