import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

async function harness(t: TestContext, nodes = "card('root',null,{name:'根'}),card('a','root',{name:'研究员'})") {
  const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {AgentTree} from './packages/dsh-flow/src/ui/AgentTree.tsx';
    import {DashboardStyles} from './packages/dsh-flow/src/ui/styles.tsx';
    import {initialRunView} from './packages/dsh-flow/src/ui/view-state.ts';
    import {card,snapshot} from './tests/contracts/ui/fixtures.ts';
    const data=snapshot([${nodes}]);
    const joined=new Map();
    function Tree(){const [view,setView]=useState({...initialRunView(),selectedId:'a'});
      return <div className='flow-dashboard' data-theme='light' style={{width:559,height:800}}><DashboardStyles/>
        <AgentTree snapshot={data} view={view} now={1000} deliveries={[]} joined={joined}
          onChange={update=>setView(previous=>({...previous,...update}))}
          onSelect={selectedId=>setView(previous=>({...previous,selectedId}))} onGroup={()=>{}} onMarkers={()=>{}}/>
      </div>;
    }
    function App(){const [scope,setScope]=useState(0);return <><button onClick={()=>setScope(value=>value+1)}>切换范围</button><Tree key={scope}/></>;}
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = compiled.outputFiles[0]!.text;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/app.js' ? 'application/javascript' : 'text/html; charset=utf-8');
    response.end(request.url === '/app.js' ? script : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 559, height: 900 } }), errors: string[] = [];
  page.setDefaultTimeout(2_000); page.on('pageerror', error => errors.push(error.message));
  t.after(() => { if (errors.length) t.diagnostic(JSON.stringify(errors)); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const root = page.getByRole('treeitem', { name: '根，空闲', exact: true });
  await root.waitFor(); await page.locator('.flow-tree-surface[data-layout-ready=true]').waitFor();
  return { page, root, errors };
}

test('a selected branch can fold and reopen during its exit transition without unmounting the React tree', { timeout: 15_000 }, async t => {
  const { page, root, errors } = await harness(t);
  await root.focus();
  for (let index = 0; index < 30; index++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 1);
    assert.equal(await root.getAttribute('aria-selected'), 'true');
    if (index === 0) assert.equal(await page.locator('.flow-exiting-card').count(), 1, 'folding preserves the real exit animation');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 2);
    assert.equal(await page.locator('.flow-exiting-card').count(), 0, 'reopened members cannot retain exit duplicates');
  }
  await page.waitForTimeout(320);
  assert.equal(await page.getByRole('treeitem').count(), 2);
  assert.equal(await page.locator('[role=treeitem][tabindex="0"]').count(), 1);
  await root.focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 1);
  assert.equal(await page.locator('.flow-exiting-card').count(), 1);
  await page.getByRole('button', { name: '切换范围', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 2);
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.flow-exiting-card').count(), 0, 'the previous owner cannot retain exits in the new scope');
  assert.equal(await page.getByRole('treeitem', { name: '研究员，空闲', exact: true }).getAttribute('aria-selected'), 'true');
  await root.focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 1);
  await page.locator('.flow-exiting-card').waitFor({ state: 'detached' });
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 1);
  assert.equal(await page.locator('.flow-exiting-card').isVisible(), false, 'reduced motion hides exits immediately rather than waiting for the exit timer');
  assert.equal(await page.locator('.flow-exiting-relation').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('independent exit batches retain their own timing and an old timer cannot remove a reopened member', { timeout: 15_000 }, async t => {
  const { page, errors } = await harness(t, "card('root',null,{name:'根'}),card('a','root',{name:'研究员'}),card('a1','a',{name:'甲执行者'}),card('b','root',{name:'审查员'}),card('b1','b',{name:'乙执行者'}),card('b2','b1',{name:'乙后代'})");
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time }); await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  const fold = async (name: string) => { await page.getByRole('button', { name, exact: true }).focus(); await page.keyboard.press('Space'); };
  const firstGhost = page.locator('.flow-exiting-card').filter({ hasText: '甲执行者' });
  await fold('折叠 研究员 的 1 个直接子代理');
  assert.equal(await firstGhost.count(), 1);
  const firstTiming = await firstGhost.evaluate(element => ({ delay: getComputedStyle(element).animationDelay, duration: getComputedStyle(element).animationDuration }));
  await page.clock.runFor(80);
  await fold('折叠 审查员 的 1 个直接子代理');
  assert.equal(await page.locator('.flow-exiting-card').count(), 3, 'an independent batch must not replace unfinished exits');
  assert.deepEqual(await firstGhost.evaluate(element => ({ delay: getComputedStyle(element).animationDelay, duration: getComputedStyle(element).animationDuration })), firstTiming, 'a deeper batch cannot change the first batch animation');
  await page.clock.runFor(200);
  assert.equal(await firstGhost.count(), 0);
  assert.equal(await page.locator('.flow-exiting-card').count(), 2, 'the second batch still owns its remaining 80ms');
  await page.clock.runFor(80);
  assert.equal(await page.locator('.flow-exiting-card').count(), 0);
  await fold('展开 研究员 的 1 个直接子代理');
  await fold('折叠 研究员 的 1 个直接子代理');
  await page.clock.runFor(80);
  await fold('展开 研究员 的 1 个直接子代理');
  assert.equal(await firstGhost.count(), 0);
  await page.clock.runFor(40);
  await fold('折叠 研究员 的 1 个直接子代理');
  await page.clock.runFor(160);
  assert.equal(await firstGhost.count(), 1, 'the old batch deadline cannot remove the new exit for the same member');
  await page.clock.runFor(120);
  assert.equal(await firstGhost.count(), 0);
  assert.deepEqual(errors, []);
});
