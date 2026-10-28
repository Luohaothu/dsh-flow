import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server, ServerResponse } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runFixture } from '../../helpers/contract-run.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';

test('HTTP/1 Native menu shares registry beside a full Flow view and refreshes all Run members without extra streams', { timeout: 20_000 }, async t => {
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const runs = await Promise.all(Array.from({ length: 4 }, () => f.createActive()));
  await f.createActive({}, 'other-owner', f.origin('other'));
  const directory = join(f.directory, 'static'); await mkdir(directory);
  const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {TeamHeader,useDashboard,nativeStyles} from './packages/dsh-flow/src/native/client.tsx';
    import {DashboardApp} from './packages/dsh-flow/src/ui/DashboardApp.tsx';
    import {DashboardStyles} from './packages/dsh-flow/src/ui/styles.tsx';
    import {createDashboardViewStore} from './packages/dsh-flow/src/ui/view-state.ts';
    const base=location.origin,viewStore=createDashboardViewStore();
    function Pressure(){const{state}=useDashboard(base,${JSON.stringify(runs[1]!.id)});return <output id='pressure'>{state.snapshot?.run.id}</output>;}
    function App(){const[caller,setCaller]=useState('main');const[pressure,setPressure]=useState(false);const{client}=useDashboard(base,${JSON.stringify(runs[0]!.id)});
      window.__caller=setCaller;window.__pressure=()=>setPressure(true);
      return <><DashboardStyles/><style>{nativeStyles}</style>{pressure&&<Pressure/>}<header style={{position:'relative',zIndex:100,height:40}}><TeamHeader address={base} callerSessionId={caller} theme='light' host={{}} openView={()=>{}}/></header>
        <div style={{height:650}}><DashboardApp client={client} scope={{kind:'global'}} viewStore={viewStore} theme='light'/></div></>;
    } const root=createRoot(document.getElementById('root'));root.render(<App/>);window.__close=()=>root.unmount();
  ` }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(directory, 'app.js'), compiled.outputFiles[0]!.text);
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  const server = await DashboardServer.create({ service: f.service, projector, port: 0, staticDirectory: directory });
  t.after(async () => { await server.dispose(); projector.dispose(); });
  const streams = new Map<ServerResponse, string>(), reads = new Map<string, number>(), protocols = new Set<string>();
  const http = Reflect.get(server, 'server') as Server;
  http.on('request', (request, response) => {
    protocols.add(request.httpVersion); const path = new URL(request.url ?? '/', server.address).pathname;
    reads.set(path, (reads.get(path) ?? 0) + 1);
    if (path.endsWith('/events')) { streams.set(response, path); response.once('close', () => streams.delete(response)); }
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.address);
  const trigger = page.getByRole('button', { name: '当前会话 4 个团队运行' }); await trigger.click();
  const members = page.locator('.flow-native-team-menu .flow-native-member');
  await page.waitForFunction(() => document.querySelectorAll('.flow-native-team-menu .flow-native-member').length === 4, undefined, { timeout: 3_000 });
  assert.equal(streams.size, 3, 'one header registry plus the main view registry and selected Run');
  assert.deepEqual([...protocols], ['1.1']);
  // A second independent view adds the same two real Flow subscriptions as
  // an open observer, leaving only one of Chrome's six HTTP/1 seats for reads.
  await page.evaluate('window.__pressure()');
  await page.locator('#pressure').getByText(runs[1]!.id, { exact: true }).waitFor({ timeout: 3_000 });
  assert.equal(streams.size, 5);
  const child = await f.child(runs[0]!, undefined, { name: 'Live menu member' });
  await members.filter({ hasText: 'Live menu member' }).waitFor({ timeout: 3_000 });
  await child.recvSignal('SIGTERM');
  await members.filter({ hasText: 'Live menu member' }).locator('.flow-status-stopped').waitFor({ timeout: 3_000 });
  assert.equal(streams.size, 5);
  const root = f.binding(runs[0]!);
  root.host.emit({ type: 'auto-reject', agent: root.host.native(root.root), timestamp: Date.now(), message: 'navigation marker' });
  await members.filter({ hasText: root.root.getProfile().name }).locator('.flow-status[aria-label*="1 条持续标记"]').waitFor({ timeout: 3_000 });
  await trigger.click(); await page.locator('.flow-native-team-menu').waitFor({ state: 'detached' });
  const before = [...reads.values()].reduce((a, b) => a + b, 0);
  await f.child(runs[1]!, undefined, { name: 'Closed menu member' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal([...reads.values()].reduce((a, b) => a + b, 0), before, 'closed menus do not refresh member snapshots');
  await trigger.click(); await members.filter({ hasText: 'Closed menu member' }).waitFor({ timeout: 3_000 });
  let startGate: (() => void) | undefined, releaseGate: (() => void) | undefined, gate = false;
  const pattern = '**/api/runs/*';
  await page.route(pattern, async route => {
    if (!gate || !/^\/api\/runs\/[^/]+$/.test(new URL(route.request().url()).pathname)) { await route.continue(); return; }
    gate = false; startGate?.(); await new Promise<void>(resolve => { releaseGate = resolve; });
    await route.continue().catch(() => {});
  });
  const delayed = async (index: number) => {
    const started = new Promise<void>(resolve => { startGate = resolve; }); gate = true;
    await f.child(runs[index]!, undefined, { name: 'Pending menu snapshot' }); await started;
  };
  await delayed(2);
  const closedRequest = page.waitForEvent('requestfailed', { predicate: request => /^\/api\/runs\/[^/]+$/.test(new URL(request.url()).pathname), timeout: 3_000 });
  await trigger.click(); releaseGate!(); await closedRequest;
  await trigger.click(); await members.filter({ hasText: 'Pending menu snapshot' }).waitFor({ timeout: 3_000 });
  await delayed(3);
  const oldCallerRequest = page.waitForEvent('requestfailed', { predicate: request => /^\/api\/runs\/[^/]+$/.test(new URL(request.url()).pathname), timeout: 3_000 });
  await page.evaluate('window.__caller("other")'); releaseGate!(); await oldCallerRequest;
  await page.unroute(pattern);
  await page.locator('.flow-native-team-menu').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '当前会话 1 个团队运行' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.flow-native-team-menu .flow-native-member').length === 1, undefined, { timeout: 3_000 });
  assert.equal(await members.filter({ hasText: 'Live menu member' }).count(), 0);
  assert.equal(streams.size, 5);
  await page.evaluate('window.__close()');
  for (let attempt = 0; streams.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(streams.size, 0); assert.deepEqual(errors, []);
});
