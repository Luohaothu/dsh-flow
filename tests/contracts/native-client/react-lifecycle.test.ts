import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { PROTOCOL_VERSION } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { card, run, snapshot } from '../ui/fixtures.js';

interface ProbeState { id: number; connection: string; selectedRunId: string | null; snapshotRunId: string | null; error: string | null }

test('Native React hook keeps its Client across Run changes, cancels old HTTP/SSE and disposes only its owned mount', { timeout: 30_000 }, async t => {
  const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: `
    import {useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useDashboard} from './packages/dsh-flow/src/native/client.tsx';
    const clients=[],observations=[],pair={};
    let current;
    function Probe({address,runId,label='single'}) {
      const value=useDashboard(address,runId);
      if(!clients.includes(value.client)) clients.push(value.client);
      const state={id:clients.indexOf(value.client),connection:value.state.connection,selectedRunId:value.state.selectedRunId,snapshotRunId:value.state.snapshot?.run.id??null,error:value.state.error};
      current=state;pair[label]=state;observations.push({requested:runId??null,...state});
      return <output>{JSON.stringify(state)}</output>;
    }
    const root=createRoot(document.getElementById('root'));
    window.__probe={render:(address,runId)=>root.render(<Probe address={address} runId={runId}/>),read:()=>current,
      renderPair:(address,first)=>root.render(<>{first&&<Probe key='first' label='first' address={address} runId='runA'/>}<Probe key='second' label='second' address={address} runId='runB'/></>),pair:()=>pair,
      observations:()=>observations,clients:()=>clients.map(c=>c.getState().connection),close:()=>root.unmount()};
  ` }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = compiled.outputFiles[0]!.text;
  const streams = new Map<ServerResponse, string>(), reads = new Map<string, number>();
  let slowRequests = 0, slowClosed = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture'), path = url.pathname;
    const json = (status: number, data: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<div id="root"></div><script src="/probe.js"></script>'); return; }
    if (path === '/probe.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); return; }
    const prefix = path.split('/')[1]!, api = path.slice(prefix.length + 1);
    reads.set(path, (reads.get(path) ?? 0) + 1);
    if (api === '/api/token') { json(200, { version: PROTOCOL_VERSION, epoch: 'epoch', token: 'fixture' }); return; }
    if (api === '/api/runs') { json(200, { version: PROTOCOL_VERSION, epoch: 'epoch', seq: 0, runs: ['runA', 'runB', 'runC', 'slow'].map(id => run(id)) }); return; }
    if (api === '/api/events' || /^\/api\/runs\/[^/]+\/events$/.test(api)) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Flow-Replay-Through': '0' }); response.write(': ready\n\n');
      streams.set(response, path); response.once('close', () => streams.delete(response)); return;
    }
    const match = /^\/api\/runs\/([^/]+)$/.exec(api);
    if (match) {
      if (match[1] === 'slow') { slowRequests++; response.once('close', () => slowClosed++); return; }
      if (match[1] === 'missing') { json(404, { error: { code: 'not-found', message: 'The requested run does not exist' } }); return; }
      json(200, snapshot([card(`${match[1]}-member`)], { run: run(match[1]) })); return;
    }
    json(404, { error: { code: 'not-found', message: path } });
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { for (const stream of streams.keys()) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const render = async (prefix: string, id: string) => { await page.evaluate(({ base, runId }) => (window as unknown as { __probe: { render(address: string, runId: string): void } }).__probe.render(base, runId), { base: `${origin}/${prefix}`, runId: id }); };
  const waitRun = (id: string) => page.waitForFunction(runId => (window as unknown as { __probe: { read(): ProbeState } }).__probe.read()?.snapshotRunId === runId, id, { timeout: 2_000 });
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 2_000; while (!condition()) { if (Date.now() > deadline) throw new Error('React transport resources did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  await render('one', 'runA'); await waitRun('runA');
  const initial = await page.evaluate<ProbeState>('window.__probe.read()');
  await until(() => [...streams.values()].includes('/one/api/runs/runA/events'));
  await render('one', 'runB'); await waitRun('runB');
  const second = await page.evaluate<ProbeState>('window.__probe.read()');
  assert.equal(second.id, initial.id); assert.notEqual(second.connection, 'disposed');
  await until(() => ![...streams.values()].includes('/one/api/runs/runA/events') && [...streams.values()].includes('/one/api/runs/runB/events'));
  assert.equal(reads.get('/one/api/token'), 1); assert.equal(reads.get('/one/api/events'), 1);
  await render('one', 'slow'); await until(() => slowRequests === 1);
  await render('one', 'runC'); await waitRun('runC'); await until(() => slowClosed === 1);
  await render('one', 'missing'); await page.waitForFunction('window.__probe.read()?.error?.includes("The requested run does not exist")', undefined, { timeout: 2_000 });
  assert.equal((await page.evaluate<ProbeState>('window.__probe.read()')).snapshotRunId, null);
  await render('two', 'runB'); await waitRun('runB');
  const replacement = await page.evaluate<ProbeState>('window.__probe.read()'); assert.notEqual(replacement.id, initial.id);
  await until(() => [...streams.values()].every(path => !path.startsWith('/one/')));
  assert.equal((await page.evaluate<string[]>('window.__probe.clients()'))[initial.id], 'disposed');
  await page.evaluate(`window.__probe.renderPair(${JSON.stringify(`${origin}/two`)},true)`);
  await page.waitForFunction('window.__probe.pair().first?.snapshotRunId==="runA" && window.__probe.pair().second?.snapshotRunId==="runB"', undefined, { timeout: 2_000 });
  const pair = await page.evaluate<Record<string, ProbeState>>('window.__probe.pair()');
  assert.notEqual(pair.first!.id, pair.second!.id);
  await until(() => [...streams.values()].filter(path => path === '/two/api/events').length === 2);
  await page.evaluate(`window.__probe.renderPair(${JSON.stringify(`${origin}/two`)},false)`);
  await until(() => [...streams.values()].filter(path => path === '/two/api/events').length === 1 && ![...streams.values()].includes('/two/api/runs/runA/events'));
  const retained = await page.evaluate<Record<string, ProbeState>>('window.__probe.pair()');
  assert.equal(retained.second!.id, pair.second!.id); assert.equal(retained.second!.snapshotRunId, 'runB');
  const clientStates = await page.evaluate<string[]>('window.__probe.clients()');
  assert.equal(clientStates[pair.first!.id], 'disposed'); assert.notEqual(clientStates[pair.second!.id], 'disposed');
  const observations = await page.evaluate<Array<ProbeState & { requested: string | null }>>('window.__probe.observations()');
  assert.ok(observations.every(item => item.snapshotRunId === null || item.snapshotRunId === item.requested), 'a new Run must never paint the old Run snapshot');
  await page.evaluate('window.__probe.close()'); await until(() => streams.size === 0);
  assert.ok((await page.evaluate<string[]>('window.__probe.clients()')).every(state => state === 'disposed'));
  assert.deepEqual(errors, []);
});
