import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { Agent, Group } from '../../../packages/dsh-flow/src/core/index.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { issueHostOrigin } from '../../../packages/dsh-flow/src/run/internal.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { ContractPatternRoleProvisioner } from '../../helpers/contract-patterns.js';
import { ContractHost, flush, profile } from '../../helpers/contract-host.js';
import { spec, waitFor } from '../../helpers/contract-run.js';

async function assertOneMeasuredFrame(page: Page, members: number) {
  await page.waitForFunction(count => document.querySelectorAll('[role=treeitem]').length === count, members);
  assert.equal(await page.locator('.flow-group > rect').count(), 1);
  assert.equal(await page.locator('.flow-group-label').count(), 1);
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('[role=treeitem]')];
    if (items.some(item => item.getAnimations().some(animation => animation.playState === 'running' || animation.pending))) return false;
    const frame = document.querySelector('.flow-group > rect')?.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.flow-card-surface')].map(element => element.getBoundingClientRect());
    if (!frame || !cards.length) return false;
    const left = Math.min(...cards.map(card => card.left)), right = Math.max(...cards.map(card => card.right));
    const top = Math.min(...cards.map(card => card.top)), bottom = Math.max(...cards.map(card => card.bottom));
    return [left - frame.left, frame.right - right, top - frame.top, frame.bottom - bottom].every(gap => Math.abs(gap - 24) < 1);
  });
}

test('one real four-member Group renders one frame through resizing, card growth and folding', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-group-frame-'));
  const host = new ContractHost();
  const service = new RunService({ store: new RunStore(join(directory, 'runs')),
    patternCatalog: new PatternCatalog({ includeBuiltins: false }), patternRoleProvisioner: new ContractPatternRoleProvisioner(),
    getOriginDefaults: () => ({ model: { provider: 'contract', id: 'session-model' }, permission: 'workspace-write', params: { version: 1 } }),
    initialize: async (_run, _defaults, context) => { context.registerHostAdaptor(host); return Agent.create(context, profile('group-root', { name: '协调者' }), null); },
  });
  const projector = new DashboardProjector(service, { directory: join(directory, 'events') });
  const origin = issueHostOrigin({ backend: 'group-frame-contract', callerSessionId: 'fixture-main' });
  const run = service.create(origin, {}, 'four-member-group');
  t.after(async () => { await service.release(origin, run); projector.dispose(); await rm(directory, { recursive: true, force: true }); });
  await waitFor(() => run.status === 'active');
  const root = run.root!, context = run.context!;
  const children = await Promise.all(['整理人', '复核一', '复核二'].map((name, index) => Agent.create(context, profile(`group-child-${index}`, { name }), root)));
  const group = new Group(context, [root, ...children]);
  await service.assign(origin, run, spec({ name: '核对发布材料及其证据' }), 'root-assignment');
  await flush(); host.status(root, 'idle'); host.turnEnd(root); await flush();
  const snapshot = projector.snapshot(run.id);
  assert.equal(snapshot.nodes.length, 4);
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.groups[0]!.id, group.getID());
  assert.deepEqual([...snapshot.groups[0]!.members].sort(), snapshot.nodes.map(node => node.id).sort());
  const compiled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), loader: 'tsx', contents: `
    import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {AgentTree} from './packages/dsh-flow/src/ui/AgentTree.tsx';
    import {GroupDetails} from './packages/dsh-flow/src/ui/AgentDetails.tsx';
    import {DashboardStyles} from './packages/dsh-flow/src/ui/styles.tsx';
    import {initialRunView} from './packages/dsh-flow/src/ui/view-state.ts';
    const snapshot=${JSON.stringify(snapshot)}, joined=new Map();
    function App(){const [view,setView]=useState(initialRunView()),[theme,setTheme]=useState('light');
      const selected=snapshot.groups.find(group=>group.id===view.groupId);
      return <><button onClick={()=>setTheme(value=>value==='light'?'dark':'light')}>切换主题</button>
        <div className='flow-dashboard' data-theme={theme} style={{height:850,width:'100vw'}}><DashboardStyles/>
          <div className='flow-dashboard-body'><AgentTree snapshot={snapshot} view={view} now={Date.now()} deliveries={[]} joined={joined}
            onChange={update=>setView(previous=>({...previous,...update}))}
            onSelect={selectedId=>setView(previous=>({...previous,selectedId}))}
            onGroup={group=>setView(previous=>({...previous,groupId:group.id}))} onMarkers={()=>{}}/>
            {selected&&<aside className='flow-right-pane' aria-label='群详情'><GroupDetails group={selected} snapshot={snapshot} onSelect={()=>{}}/></aside>}
          </div></div></>;}
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1080, height: 920 } }), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(4_000);
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><div id="root"></div>');
  await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
  await page.locator('.flow-tree-surface[data-layout-ready=true]').waitFor();
  await assertOneMeasuredFrame(page, 4);
  const rootCard = page.getByRole('treeitem', { name: '协调者，空闲', exact: true });
  const labelBounds = (await page.locator('.flow-group-label').boundingBox())!, rootBounds = (await rootCard.boundingBox())!;
  assert.ok(Math.abs(labelBounds.x - (rootBounds.x - 12)) < 1);
  const runBounds = (await page.locator('.flow-run-label').boundingBox())!;
  assert.ok(runBounds.x + runBounds.width < labelBounds.x, 'the combined frame label must not move into the run heading');
  const initialHeight = (await rootCard.boundingBox())!.height;
  await rootCard.locator('.flow-card-jobs > summary').click();
  await page.waitForFunction(height => {
    const card = [...document.querySelectorAll('[role=treeitem]')].find(element => element.getAttribute('aria-label') === '协调者，空闲');
    return !!card && card.getBoundingClientRect().height > height;
  }, initialHeight);
  await assertOneMeasuredFrame(page, 4);
  for (const width of [559, 560, 561, 1080]) {
    await page.setViewportSize({ width, height: 920 });
    await page.locator(`.flow-tree-shell[data-layout=${width < 560 ? 'narrow' : 'wide'}]`).waitFor();
    if (width === 1080) await page.waitForFunction(() => {
      const root = document.querySelector('[role=treeitem][aria-level="1"]')!.getBoundingClientRect();
      const canvas = document.querySelector('.flow-canvas')!.getBoundingClientRect();
      return Math.abs(root.left + root.width / 2 - canvas.left - canvas.width / 2) < 1;
    });
    await assertOneMeasuredFrame(page, 4);
  }
  const evidence = process.env.GROUP_FRAME_EVIDENCE_DIR;
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'four-member-group-light.png') }); }
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await assertOneMeasuredFrame(page, 4);
  if (evidence) await page.screenshot({ path: join(evidence, 'four-member-group-dark.png') });
  await page.getByRole('button', { name: '折叠 协调者 的 3 个直接子代理', exact: true }).click();
  await assertOneMeasuredFrame(page, 1);
  assert.match((await page.locator('.flow-group-label').getAttribute('aria-label'))!, /4 个成员，3 个隐藏成员/);
  await page.getByRole('button', { name: '展开 协调者 的 3 个直接子代理', exact: true }).click();
  await assertOneMeasuredFrame(page, 4);
  await page.locator('.flow-group-label').click();
  await page.getByRole('heading', { name: '成员 · 4', exact: true }).waitFor();
  assert.equal(await page.locator('.flow-treeitem.is-group-member').count(), 4);
  assert.equal(await page.getByRole('complementary', { name: '群详情' }).locator('.flow-object-link').count(), 4);
  assert.deepEqual(errors, []);
});
