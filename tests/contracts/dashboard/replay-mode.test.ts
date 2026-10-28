import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { DashboardClient, type DashboardUpdate } from '../../../packages/dsh-flow/src/dashboard/client.js';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { deferred, message } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';
import { until } from '../../helpers/contract-runtime.js';

test('actual SSE replay watermark separates initial and reconnect backlog from live message delivery', { timeout: 10_000 }, async t => {
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const run = await f.createActive(), { root } = f.binding(run);
  const server = await DashboardServer.create({ projector, service: f.service });
  const entered = [deferred(), deferred()], gates = [deferred(), deferred()];
  let subscriptions = 0, disconnect: (() => Promise<void>) | undefined;
  const updates: DashboardUpdate[] = [], headers: string[] = [];
  const client = new DashboardClient({ baseUrl: server.address, origin: 'dsh-app://app', reconnectDelayMs: 0,
    fetch: async (target, options) => {
      const url = new URL(String(target));
      if (url.pathname !== `/api/runs/${run.id}/events`) return fetch(target, options);
      const index = subscriptions++;
      if (index < 2) { entered[index]!.resolve(); await gates[index]!.promise; }
      const response = await fetch(target, options);
      headers.push(response.headers.get('access-control-expose-headers') ?? '');
      if (index !== 0) return response;
      const reader = response.body!.getReader(); let stop = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          disconnect = async () => { if (stop) return; stop = true; controller.close(); await reader.cancel(); };
          void (async () => {
            try { while (!stop) { const chunk = await reader.read(); if (stop) return; if (chunk.done) { stop = true; controller.close(); return; } controller.enqueue(chunk.value); } }
            catch (error) { if (!stop) controller.error(error); }
          })();
        },
        async cancel() { stop = true; await reader.cancel(); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    } });
  t.after(async () => { for (const gate of gates) gate.resolve(); client.dispose(); await server.dispose(); projector.dispose(); });
  client.subscribe(state => { if (state.update.kind !== 'state') updates.push(state.update); });
  await client.selectRun(run.id); await entered[0]!.promise;
  root.recvMessage(message('initial backlog'));
  gates[0]!.resolve();
  await until(() => client.getState().snapshot!.nodes.some(node => node.messages.some(m => m.summary === 'initial backlog')));
  const first = updates.filter(update => update.eventType === 'message-received').at(-1)!;
  assert.equal(first.kind, 'replay');
  root.recvMessage(message('first live'));
  await until(() => updates.filter(update => update.eventType === 'message-received').length === 2);
  assert.equal(updates.filter(update => update.eventType === 'message-received').at(-1)!.kind, 'live');
  await disconnect!(); await entered[1]!.promise;
  root.recvMessage(message('reconnect backlog'));
  gates[1]!.resolve();
  await until(() => updates.filter(update => update.eventType === 'message-received').length === 3);
  assert.equal(updates.filter(update => update.eventType === 'message-received').at(-1)!.kind, 'replay');
  root.recvMessage(message('second live'));
  await until(() => updates.filter(update => update.eventType === 'message-received').length === 4);
  const messages = updates.filter(update => update.eventType === 'message-received');
  assert.deepEqual(messages.map(update => update.kind), ['replay', 'live', 'replay', 'live']);
  assert.equal(new Set(messages.map(update => update.generation)).size, 1);
  assert.ok(headers.every(value => value.includes('X-Flow-Replay-Through')));
  assert.equal(updates[0]!.kind, 'snapshot');
});
