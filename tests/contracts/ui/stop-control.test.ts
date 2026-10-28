import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { DashboardOperations, decodeStopRequest } from '../../../packages/dsh-flow/src/dashboard/operations.js';
import type { StopRequest } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { getAgentInstanceId } from '../../../packages/dsh-flow/src/core/observation.js';
import { deferred } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

type Mode = 'failed' | 'unknown' | 'accepted' | 'failed-then-unknown';
async function harness(t: TestContext, mode: Mode) {
  const gate = deferred(); t.after(() => gate.resolve());
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  t.after(() => projector.dispose());
  const run = await f.createActive(), child = await f.child(run), childId = getAgentInstanceId(child), host = f.binding(run).host;
  if (mode === 'accepted') host.closeGates.set(host.native(child), gate);
  let executions = 0;
  const lookup = projector.lookupAgent.bind(projector);
  projector.lookupAgent = (runId, instanceId) => {
    executions++;
    if ((mode === 'failed' || mode === 'failed-then-unknown') && executions === 1) throw new Error('transient instance lookup failed');
    return lookup(runId, instanceId);
  };
  const operations = new DashboardOperations(projector, f.service), requests: StopRequest[] = [];
  const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: `
    import {useEffect,useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {AgentDetails} from './packages/dsh-flow/src/ui/AgentDetails.tsx';
    function App(){const[snapshot,setSnapshot]=useState(null),[mount,setMount]=useState(0);
      const refresh=async()=>{const response=await fetch('/snapshot');setSnapshot(await response.json());};
      useEffect(()=>{void refresh();},[]);
      const stop=async request=>{const response=await fetch('/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});if(!response.ok)throw new Error('Stop HTTP '+response.status);const accepted=await response.json();await refresh();return accepted;};
      return <><button onClick={()=>{void refresh();}}>刷新快照</button><button onClick={()=>setMount(value=>value+1)}>重新挂载详情</button>
        {snapshot&&<AgentDetails key={mount} node={snapshot.nodes.find(node=>node.id===${JSON.stringify(childId)})} group={null} snapshot={snapshot} tab='overview' connected={true} onTab={()=>{}} onClose={()=>{}} onSelect={()=>{}} onGroup={()=>{}} onReplay={()=>{}} onStop={stop}/>}</>;
    }createRoot(document.getElementById('root')).render(<App/>);
  ` }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = compiled.outputFiles[0]!.text;
  const server = createServer((request, response) => { void (async () => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); return; }
    if (request.url === '/snapshot') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(projector.snapshot(run.id))); return; }
    if (request.url === '/stop' && request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value = decodeStopRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); requests.push(value);
      const accepted = operations.stop(run.id, value), body = JSON.stringify(accepted);
      if (mode === 'unknown' && requests.length === 1 || mode === 'failed-then-unknown' && requests.length === 2) {
        response.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        response.write(body.slice(0, Math.floor(body.length / 2))); setImmediate(() => response.destroy()); return;
      }
      if (mode !== 'accepted') await operations.settled();
      response.setHeader('Content-Type', 'application/json'); response.writeHead(202); response.end(body); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { gate.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: !process.env.P6_STOP_HEADED, ...(process.env.CI ? {} : { channel: 'chrome' }) }); t.after(() => browser.close());
  const page = await browser.newPage(), pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.getByRole('button', { name: '停止成员', exact: true }).waitFor();
  const proof = async () => {
    const directory = process.env.P6_STOP_EVIDENCE_DIR; if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${t.name.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify({ name: t.name, mode, requests, executions, hostReleases: host.releases.length, childStatus: child.getStatus(), operations: projector.snapshot(run.id).operations, pageErrors }, null, 2));
  };
  return { page, requests, operations, projector, run, child, host, gate, executions: () => executions, pageErrors, proof };
}

test('a definitive failed stop retries with a new ID and executes successfully', { timeout: 20_000 }, async t => {
  const f = await harness(t, 'failed');
  await f.page.getByRole('button', { name: '停止成员', exact: true }).click();
  await f.page.getByRole('button', { name: '重试停止', exact: true }).waitFor();
  assert.equal(f.projector.snapshot(f.run.id).operations[0]?.status, 'failed'); assert.equal(f.child.getStatus(), 'idle');
  await Promise.all([f.page.waitForResponse(response => response.url().endsWith('/stop') && response.status() === 202), f.page.getByRole('button', { name: '重试停止', exact: true }).click()]);
  assert.notEqual(f.requests[1]?.operationId, f.requests[0]?.operationId);
  await f.page.getByRole('button', { name: '操作完成', exact: true }).waitFor();
  assert.equal(f.executions(), 2); assert.equal(f.child.getStatus(), 'terminated');
  assert.deepEqual(f.projector.snapshot(f.run.id).operations.map(operation => operation.status), ['failed', 'completed']); assert.deepEqual(f.pageErrors, []); await f.proof();
});

test('remounting a failed stop still creates a new operation rather than replaying the failed ID', { timeout: 20_000 }, async t => {
  const f = await harness(t, 'failed');
  await f.page.getByRole('button', { name: '停止成员', exact: true }).click(); await f.page.getByRole('button', { name: '重试停止', exact: true }).waitFor();
  await f.page.getByRole('button', { name: '重新挂载详情', exact: true }).click();
  await Promise.all([f.page.waitForResponse(response => response.url().endsWith('/stop') && response.status() === 202), f.page.getByRole('button', { name: '重试停止', exact: true }).click()]);
  assert.notEqual(f.requests[1]?.operationId, f.requests[0]?.operationId);
  await f.page.getByRole('button', { name: '操作完成', exact: true }).waitFor(); assert.equal(f.executions(), 2); assert.equal(f.child.getStatus(), 'terminated'); assert.deepEqual(f.pageErrors, []); await f.proof();
});

test('unknown transport outcome replays the same ID and the real backend executes exactly once', { timeout: 20_000 }, async t => {
  const f = await harness(t, 'unknown');
  await f.page.getByRole('button', { name: '停止成员', exact: true }).click(); await f.page.getByRole('button', { name: '重试停止', exact: true }).waitFor();
  await f.operations.settled(); assert.equal(f.executions(), 1); assert.equal(f.child.getStatus(), 'terminated');
  await f.page.getByRole('button', { name: '重试停止', exact: true }).click(); await f.page.getByRole('button', { name: '操作完成', exact: true }).waitFor();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1]?.operationId, f.requests[0]?.operationId); assert.equal(f.executions(), 1); assert.equal(f.host.releases.length, 1); assert.deepEqual(f.pageErrors, []); await f.proof();
});

test('an accepted operation waits without resubmission and completion disables the action', { timeout: 20_000 }, async t => {
  const f = await harness(t, 'accepted');
  try {
    await f.page.getByRole('button', { name: '停止成员', exact: true }).click();
    const waiting = f.page.getByRole('button', { name: '已提交 · 等待结果', exact: true }); await waiting.waitFor();
    assert.equal(await waiting.isDisabled(), true); assert.equal(f.requests.length, 1); assert.equal(f.executions(), 1);
    f.gate.resolve(); await f.operations.settled(); await f.page.getByRole('button', { name: '刷新快照', exact: true }).click();
    const done = f.page.getByRole('button', { name: '操作完成', exact: true }); await done.waitFor(); assert.equal(await done.isDisabled(), true); assert.equal(f.requests.length, 1); assert.deepEqual(f.pageErrors, []); await f.proof();
  } finally { f.gate.resolve(); }
});

test('a failed retry with a lost response can replay its new ID without inheriting old acceptance', { timeout: 20_000 }, async t => {
  const f = await harness(t, 'failed-then-unknown');
  await f.page.getByRole('button', { name: '停止成员', exact: true }).click(); await f.page.getByRole('button', { name: '重试停止', exact: true }).waitFor();
  await f.page.getByRole('button', { name: '重试停止', exact: true }).click();
  await f.page.getByRole('alert').filter({ hasText: /fetch|JSON|network|load|abort|terminated/i }).waitFor();
  const retry = f.page.getByRole('button', { name: '重试停止', exact: true }); assert.equal(await retry.isEnabled(), true);
  assert.notEqual(f.requests[1]?.operationId, f.requests[0]?.operationId);
  await retry.click(); await f.page.getByRole('button', { name: '操作完成', exact: true }).waitFor();
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2]?.operationId, f.requests[1]?.operationId); assert.equal(f.executions(), 2); assert.equal(f.host.releases.length, 1); assert.deepEqual(f.pageErrors, []); await f.proof();
});
