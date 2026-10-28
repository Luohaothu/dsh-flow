import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DashboardClient } from '../../../packages/dsh-flow/src/dashboard/client.js';
import { IncompatibleProtocol } from '../../../packages/dsh-flow/src/dashboard/decoder.js';
import { card, run, snapshot } from '../ui/fixtures.js';

for (const stage of ['token', 'registry', 'snapshot'] as const) {
  test(`real HTTP protocol 1.0 at ${stage} rejects explicitly and cannot enter a watermark reset loop`, async t => {
    const paths: string[] = [];
    const version = (part: typeof stage) => ({ major: 1, minor: part === stage ? 0 : 1 });
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname; paths.push(path);
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/token') { response.end(JSON.stringify({ version: version('token'), epoch: 'epoch', token: 'fixture' })); return; }
      if (path === '/api/runs') { response.end(JSON.stringify({ version: version('registry'), epoch: 'epoch', seq: 0, runs: [run()] })); return; }
      if (path === '/api/runs/run') { response.end(JSON.stringify(snapshot(undefined, { version: version('snapshot') }))); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      if (stage !== 'token') response.setHeader('X-Flow-Replay-Through', '0');
      response.write(': ready\n\n');
    });
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new DashboardClient({ baseUrl: `http://127.0.0.1:${address.port}`, reconnectDelayMs: 0 });
    t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await assert.rejects(client.selectRun('run'), error => error instanceof IncompatibleProtocol && /1\.0/.test(error.message) && /1\.1/.test(error.message));
    assert.equal(client.getState().connection, 'error'); assert.match(client.getState().error!, /Incompatible dashboard protocol/);
    const settled = [...paths]; await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(paths, settled);
    assert.equal(paths.filter(path => path === '/api/runs/run/events').length, 0);
    assert.equal(paths.filter(path => path === '/api/runs/run').length, stage === 'snapshot' ? 1 : 0);
    assert.equal(paths.filter(path => path === '/api/events').length <= (stage === 'snapshot' ? 1 : 0), true);
  });
}

for (const minor of [1, 9]) {
  test(`real HTTP protocol 1.${minor} accepts replay watermarks and additive fields/events`, async t => {
    const version = { major: 1, minor }, paths: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname; paths.push(path);
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/token') { response.end(JSON.stringify({ version, epoch: 'epoch', token: 'fixture', future: true })); return; }
      if (path === '/api/runs') { response.end(JSON.stringify({ version, epoch: 'epoch', seq: 0, runs: [{ ...run(), future: true }], future: true })); return; }
      if (path === '/api/runs/run') { const futureNode = { ...card('root'), future: true }; response.end(JSON.stringify({ ...snapshot([futureNode], { version }), future: true })); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Flow-Replay-Through': '0' });
      response.write(': ready\n\n');
      if (path === '/api/runs/run/events') response.write(`data: ${JSON.stringify({ runId: 'run', seq: 1, timestamp: 1, type: 'future-additive-event', future: true })}\n\n`);
    });
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new DashboardClient({ baseUrl: `http://127.0.0.1:${address.port}`, reconnectDelayMs: 0 });
    t.after(async () => { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await client.selectRun('run');
    for (let attempt = 0; client.getState().snapshot?.seq !== 1 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(client.getState().snapshot!.seq, 1); assert.deepEqual(client.getState().version, version);
    assert.equal(client.getState().runConnection, 'connected'); assert.equal(client.getState().error, null);
    assert.equal(paths.filter(path => path === '/api/runs/run').length, 1);
    assert.equal(paths.filter(path => path === '/api/runs/run/events').length, 1);
  });
}
