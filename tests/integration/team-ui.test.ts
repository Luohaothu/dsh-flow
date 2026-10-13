/** Browser rendering of production team components; no inference of live Agent execution. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';
import type { FlowTeamSnapshot } from '../../packages/dsh-flow/src/types.ts';

function snapshot(id: string, state: 'running' | 'completed' = 'running'): FlowTeamSnapshot {
  const at = Date.UTC(2026, 9, 13, 2);
  return {
    run: {id, owner_session_id:'owner', intent_id:`intent-${id}`, title:state === 'running' ? '公开数据研究与报告' : '已完成的历史任务', objective:'核对公开来源，整理结论并交付可复查的报告。', workspace:'/workspace/research', preset:null, model:null, state, version:2, root_task_id:'task-root', deadline:null, created:at, updated:at},
    members:[{id:'member-analysis',session_id:'member-analysis',team_id:id,parent_id:'owner',name:'资料分析',role:'orchestrator',instructions:'协调来源核对并汇总统计。',skills:['research'],preset:'standard',state:state === 'running' ? 'running' : 'closed',active_task_id:'task-data',error:null,created:at,updated:at},{id:'member-verify',session_id:'member-verify',team_id:id,parent_id:'member-analysis',name:'来源核对',role:'worker',preset:null,state:'idle',active_task_id:'task-verify',error:null,created:at,updated:at}],
    tasks:[{id:'task-root',team_id:id,parent_id:null,owner_session_id:'owner',assignee_session_id:'owner',title:'完成研究报告',objective:'合并已核对的数据并说明统计限制。',paused:false,status:'OPEN',version:1,result_id:null,created:at,updated:at},{id:'task-data',team_id:id,parent_id:'task-root',owner_session_id:'owner',assignee_session_id:'member-analysis',title:'汇总数据',objective:'依据已核对的来源形成当前统计表。',paused:false,status:'ACCEPTED',version:2,result_id:'result-current',created:at,updated:at},{id:'task-verify',team_id:id,parent_id:'task-data',owner_session_id:'member-analysis',assignee_session_id:'member-verify',title:'核对来源',objective:'检查资料发布日期与口径。',paused:false,status:'ACCEPTED',version:1,result_id:'result-verify',created:at,updated:at}],
    results:[{id:'result-old',team_id:id,task_id:'task-data',task_version:1,author_session_id:'member-analysis',summary:'初稿：统计口径尚未统一。',artifacts:['output/draft.csv'],outcome:'partial',ready:true,created:at},{id:'result-current',team_id:id,task_id:'task-data',task_version:2,author_session_id:'member-analysis',summary:'已统一统计口径，并逐项保留原始来源。',artifacts:['output/data.csv'],outcome:'complete',ready:true,created:at+1000},{id:'result-verify',team_id:id,task_id:'task-verify',task_version:1,author_session_id:'member-verify',summary:'三个来源的日期与口径已核对。',artifacts:['output/sources.md'],outcome:'complete',ready:true,created:at+500}],
    reviews:[{id:'review-old',team_id:id,task_id:'task-data',result_id:'result-old',reviewer_session_id:'owner',accepted:false,notes:'请统一统计口径。',evidence:['初稿第 2 列的单位不一致'],created:at+100},{id:'review-current',team_id:id,task_id:'task-data',result_id:'result-current',reviewer_session_id:'owner',accepted:true,notes:'抽样核对通过，接受本次结果。',evidence:['重新读取 data.csv 并核对三个来源'],created:at+1100}],
    messages:[{id:'message-1',team_id:id,from_session_id:'member-verify',to_session_id:'member-analysis',task_id:'task-verify',content:'日期和来源口径已经确认，可继续汇总。',mode:'notice',state:'delivered',created:at+500,delivered_at:at+510}],
    events:[{seq:1,team_id:id,type:'result-accepted',data:{task_id:'task-data',result_id:'result-current'},at:at+1100}],
    usage:{responses:9,input_tokens:4200,output_tokens:1600,cache_read_tokens:500,total_tokens:5800},
  };
}

test('team topology, native navigation callbacks, result details, history and narrow screens', {timeout:120_000}, async () => {
  const layout = createRunLayout(resolve('.artifacts/native-agent-simplification'), `team-ui-${Date.now()}`);
  const dir = layout.artifacts;
  const fixturePackage = join(layout.root,'fixture-package');
  await mkdir(fixturePackage,{recursive:true});
  await writeFile(join(fixturePackage,'package.json'),JSON.stringify({name:'flow-team-ui-fixture',version:'1.0.0',type:'module',main:'host.js',exports:{'.':'./host.js','./client':'./client.js','./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web',inject:['@deepseek-ai/dsh-client-ui-primitives']}}}));
  await writeFile(join(fixturePackage,'host.js'),'export function apply() {}');
  await writeFile(join(fixturePackage,'cordis.patch.yml'),'- insert:\n    - id: flow-team-ui-fixture\n      name: flow-team-ui-fixture\n');
  await build({entryPoints:[resolve('tests/helpers/team-ui-fixture.tsx')],outfile:join(fixturePackage,'client.js'),bundle:true,platform:'browser',format:'cjs',jsx:'automatic',external:['@deepseek-ai/*','react','react/jsx-runtime','react-dom/client'],banner:{js:'window.__ModuleLoader__.load({id:"flow-team-ui-fixture",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'},logLevel:'silent'});
  const profile=ensureProfile(layout.home,'team-ui',{bundles:[...WEB_PROFILE_BUNDLES,'flow-team-ui-fixture']});
  await symlink(fixturePackage,join(profile.dir,'node_modules','flow-team-ui-fixture'),'dir');
  const patch=join(layout.root,'ui.patch.yml');
  await writeFile(patch,'- id: hmr\n  disabled: true\n');
  const host=new DshWebHost({profile:'team-ui',patches:[patch],cwd:layout.workspace,env:buildHostEnv({home:layout.home,tmpdir:layout.tmp,dataDir:layout.data,workspace:layout.workspace}),logPath:join(layout.logs,'host.log')});
  await host.start();
  const executable = process.env.FLOW_CHROMIUM_PATH ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({headless:process.env.CI === 'true',...(executable ? {executablePath:executable} : {})}).catch(async error=>{await host.stop();throw error;});
  const checks: string[]=[];
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    await host.authenticateBrowser(context);
    await context.addInitScript(`window.teamUiFixture = ${JSON.stringify({current:snapshot('current'),historical:snapshot('history','completed'),failing:false,action:''})};`);
    const page=await context.newPage();
    const errors: string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(host.origin!);
    await page.getByRole('heading',{name:'公开数据研究与报告',exact:true}).waitFor();
    assert.equal(await page.locator('#flow-fixture').getAttribute('data-team-tab'),'true');
    const graph=page.getByLabel('团队拓扑',{exact:true});
    assert.equal(await graph.locator('.flow-node').count(),3);
    assert.equal(await graph.locator('.flow-lines path').count(),2);
    const bounds=await page.locator('.flow-content').boundingBox();
    assert.ok(bounds && bounds.y<80 && bounds.height>900,'topology fills the available native content area');
    assert.deepEqual(await graph.locator('.flow-node-role').allTextContents(),['协调者','协调者','执行者']);
    checks.push('recorded-roles-independent-of-native-session-topology');
    await page.screenshot({path:resolve(dir,'desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'智能体团队 3',exact:false}).click();
    const popup=page.getByRole('dialog',{name:'智能体团队',exact:true});
    assert.equal(await popup.getByRole('treeitem').count(),3);
    assert.deepEqual(await popup.locator('.flow-tree-role').allTextContents(),['协调者','协调者','执行者']);
    await popup.getByRole('button',{name:'折叠 资料分析 的子代理',exact:true}).click();
    assert.equal(await popup.getByRole('treeitem').count(),2);
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'');
    await popup.getByRole('button',{name:'展开 资料分析 的子代理',exact:true}).click();
    await popup.getByRole('treeitem').first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-tree-id'),'member-analysis');
    await page.keyboard.press('Escape');
    await popup.waitFor({state:'detached'});
    assert.equal(await page.locator(':focus').getAttribute('aria-haspopup'),'dialog');
    checks.push('header-tree-collapse-keyboard-and-focus-return');
    await graph.locator('[data-agent-id="owner"]').click();
    await page.getByLabel('任务详情').waitFor();
    assert.equal(await page.getByLabel('任务详情').locator('dd').filter({hasText:/^主会话$/}).count(),2);
    await page.getByRole('button',{name:'打开完整会话',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'main');
    await page.locator('.flow-detail-heading').getByRole('button',{name:'关闭详情',exact:true}).click();
    checks.push('root-task-owned-and-executed-by-existing-main-session');
    const world=graph.locator('.flow-graph-world');
    const original=await world.getAttribute('style');
    await page.getByRole('button',{name:'放大',exact:true}).click();
    assert.notEqual(await world.getAttribute('style'),original);
    const zoomed=await world.getAttribute('style');
    const canvas=await page.getByLabel('拓扑画布，拖动空白处平移，使用工具栏缩放',{exact:true}).boundingBox();
    assert.ok(canvas);
    await page.mouse.move(canvas.x+20,canvas.y+220);
    await page.mouse.down();await page.mouse.move(canvas.x+120,canvas.y+260);await page.mouse.up();
    assert.notEqual(await world.getAttribute('style'),zoomed);
    await page.getByRole('button',{name:'适应视口',exact:true}).click();
    await graph.getByRole('button',{name:'折叠 资料分析 的子代理',exact:true}).click();
    assert.equal(await graph.locator('.flow-node').count(),2);
    await graph.getByRole('button',{name:'展开 资料分析 的子代理',exact:true}).click();
    await page.getByRole('button',{name:'适应视口',exact:true}).click();
    checks.push('canvas-zoom-pan-fit-and-collapse');
    await graph.locator('[data-agent-id="member-analysis"]').click();
    await page.getByText('抽样核对通过，接受本次结果。',{exact:true}).waitFor();
    await page.getByText('角色：协调者',{exact:true}).waitFor();
    await page.getByText('协调来源核对并汇总统计。',{exact:true}).waitFor();
    await page.locator('.flow-profile summary').click();
    await page.getByText('角色 skills：research',{exact:true}).waitFor();
    await page.getByText('创建 preset：standard',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-result-id="result-current"] [data-review-id="review-current"]').count(),1);
    assert.equal(await page.locator('[data-result-id="result-old"] [data-review-id="review-old"]').count(),1);
    assert.equal(await page.locator('[data-result-id="result-current"] [data-review-id="review-old"]').count(),0);
    await page.getByText('上级任务 · 完成研究报告',{exact:true}).waitFor();
    await page.getByRole('button',{name:'打开完整会话',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'session:member-analysis');
    await page.getByRole('button',{name:'侧栏查看',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'sidebar:member-analysis');
    await page.screenshot({path:resolve(dir,'desktop-details.png'),fullPage:true});
    checks.push('selected-node-details-versioned-reviews-and-native-navigation-callbacks');
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').current.members[0].state='idle';});
    await graph.locator('[data-agent-id="member-analysis"]').getByText('空闲',{exact:true}).waitFor();
    checks.push('native-status-updates-with-unchanged-team-version');
    await page.locator('.flow-detail-heading').getByRole('button',{name:'关闭详情',exact:true}).click();
    await page.getByLabel('团队记录').selectOption('history');
    await page.getByRole('heading',{name:'已完成的历史任务',exact:true}).waitFor();
    await page.getByRole('checkbox',{name:'显示已结束成员',exact:true}).uncheck();
    // The live grandchild keeps its closed real parent visible.
    assert.equal(await graph.locator('.flow-node').count(),3);
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').historical.members[1].state='closed';});
    await graph.locator('[data-agent-id="member-verify"]').waitFor({state:'detached'});
    assert.equal(await graph.locator('.flow-node').count(),1);
    await page.getByRole('checkbox',{name:'显示已结束成员',exact:true}).check();
    await graph.locator('[data-agent-id="member-analysis"]').waitFor();
    assert.equal(await graph.locator('.flow-node').count(),3);
    await page.getByLabel('团队记录').selectOption('current');
    await page.getByRole('heading',{name:'公开数据研究与报告',exact:true}).waitFor();
    await graph.locator('[data-agent-id="member-analysis"]').waitFor();
    checks.push('history-selection-closed-filter-and-live-ancestor-preservation');
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').failing=true;});
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent() ?? '',/上次成功读取/);
    assert.equal(await graph.locator('.flow-node').count(),3);
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').failing=false;});
    await page.getByRole('alert').waitFor({state:'detached'});
    checks.push('honest-stale-snapshot-and-recovery');
    await page.setViewportSize({width:390,height:844});
    await page.getByLabel('智能体层级列表',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.querySelector('#flow-fixture')!.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:resolve(dir,'mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'查看 资料分析 详情',exact:true}).click();
    await page.getByRole('tab',{name:'信息',exact:true}).click();
    await page.getByText('抽样核对通过，接受本次结果。',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.querySelector('#flow-fixture')!.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:resolve(dir,'mobile-details.png'),fullPage:true});
    await page.getByRole('button',{name:'返回团队',exact:true}).click();
    await page.getByRole('button',{name:'拓扑图',exact:true}).click();
    await graph.waitFor();
    await page.getByRole('button',{name:'适应视口',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.querySelector('#flow-fixture')!.scrollWidth<=window.innerWidth),true);
    checks.push('390px-auto-list-full-details-back-and-manual-topology');
    assert.deepEqual(errors,[]);
    await writeFile(resolve(dir,'report.json'),JSON.stringify({status:'PASSED',kind:'production-components-in-native-web-host-with-explicit-fixture-data',checks,console_errors:errors,live_agent_execution:false},null,2));
  } finally {await browser.close();await host.stop();}
});
