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
    members:[{id:'member-analysis',session_id:'member-analysis',team_id:id,parent_id:'owner',name:'资料分析',preset:null,state:state === 'running' ? 'running' : 'closed',active_task_id:'task-data',error:null,created:at,updated:at},{id:'member-verify',session_id:'member-verify',team_id:id,parent_id:'member-analysis',name:'来源核对',preset:null,state:'idle',active_task_id:'task-verify',error:null,created:at,updated:at}],
    tasks:[{id:'task-root',team_id:id,parent_id:null,owner_session_id:'owner',assignee_session_id:'owner',title:'完成研究报告',objective:'合并已核对的数据并说明统计限制。',paused:false,criteria:['来源可以追溯','交付报告文件'],depends_on:[],status:'OPEN',version:1,result_id:null,created:at,updated:at},{id:'task-data',team_id:id,parent_id:'task-root',owner_session_id:'owner',assignee_session_id:'member-analysis',title:'汇总数据',objective:'依据已核对的来源形成当前统计表。',paused:false,criteria:['保留出处'],depends_on:['task-verify'],status:'ACCEPTED',version:2,result_id:'result-current',created:at,updated:at},{id:'task-verify',team_id:id,parent_id:'task-data',owner_session_id:'member-analysis',assignee_session_id:'member-verify',title:'核对来源',objective:'检查资料发布日期与口径。',paused:false,criteria:[],depends_on:[],status:'ACCEPTED',version:1,result_id:'result-verify',created:at,updated:at}],
    results:[{id:'result-old',team_id:id,task_id:'task-data',task_version:1,author_session_id:'member-analysis',summary:'初稿：统计口径尚未统一。',artifacts:['output/draft.csv'],outcome:'partial',ready:true,created:at},{id:'result-current',team_id:id,task_id:'task-data',task_version:2,author_session_id:'member-analysis',summary:'已统一统计口径，并逐项保留原始来源。',artifacts:['output/data.csv'],outcome:'complete',ready:true,created:at+1000},{id:'result-verify',team_id:id,task_id:'task-verify',task_version:1,author_session_id:'member-verify',summary:'三个来源的日期与口径已核对。',artifacts:['output/sources.md'],outcome:'complete',ready:true,created:at+500}],
    reviews:[{id:'review-old',team_id:id,task_id:'task-data',result_id:'result-old',reviewer_session_id:'owner',accepted:false,notes:'请统一统计口径。',evidence:['初稿第 2 列的单位不一致'],created:at+100},{id:'review-current',team_id:id,task_id:'task-data',result_id:'result-current',reviewer_session_id:'owner',accepted:true,notes:'抽样核对通过，接受本次结果。',evidence:['重新读取 data.csv 并核对三个来源'],created:at+1100}],
    messages:[{id:'message-1',team_id:id,from_session_id:'member-verify',to_session_id:'member-analysis',task_id:'task-verify',content:'日期和来源口径已经确认，可继续汇总。',mode:'notice',state:'delivered',created:at+500,delivered_at:at+510}],
    events:[{seq:1,team_id:id,type:'result-accepted',data:{task_id:'task-data',result_id:'result-current'},at:at+1100}],
    usage:{responses:9,input_tokens:4200,output_tokens:1600,cache_read_tokens:500,total_tokens:5800},
  };
}

test('team UI renders current result reviews, member navigation, history, errors and narrow screens', {timeout:120_000}, async () => {
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
    await page.getByRole('button',{name:'完成研究报告 待完成 · 主会话',exact:true}).waitFor();
    assert.equal(await page.getByLabel('任务详情').locator('dd').filter({hasText:/^主会话$/}).count(),2);
    await page.getByRole('button',{name:'打开主会话',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'main');
    checks.push('root-task-owned-and-executed-by-main-session');
    await page.getByRole('button',{name:'汇总数据 已接受 · 资料分析'}).click();
    await page.getByText('抽样核对通过，接受本次结果。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-result-id="result-current"] [data-review-id="review-current"]').count(),1);
    assert.equal(await page.locator('[data-result-id="result-old"] [data-review-id="review-old"]').count(),1);
    assert.equal(await page.locator('[data-result-id="result-current"] [data-review-id="review-old"]').count(),0);
    checks.push('result-version-review-association','parent-and-cross-task-dependencies');
    await page.locator('[data-member-id="member-analysis"]').getByRole('button',{name:'打开会话',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'session:member-analysis');
    await page.locator('[data-member-id="member-verify"]').getByRole('button',{name:'侧栏查看',exact:true}).click();
    assert.equal(await page.evaluate(()=>Reflect.get(window,'teamUiFixture').action),'sidebar:member-verify');
    checks.push('member-session-and-sidebar-callbacks');
    await page.screenshot({path:resolve(dir,'desktop.png'),fullPage:true});
    await page.locator('[data-review-id="review-current"]').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(dir,'desktop-details.png'),fullPage:true});
    await page.evaluate(()=>{const value=Reflect.get(window,'teamUiFixture');value.current.members.forEach((member:{state:string})=>{member.state='idle';});});
    await page.locator('[data-member-id="member-analysis"]').getByText('空闲',{exact:true}).waitFor();
    checks.push('native-status-updates-with-unchanged-team-version');
    await page.getByLabel('团队记录').selectOption('history');
    await page.getByRole('heading',{name:'已完成的历史任务',exact:true}).waitFor();
    await page.getByLabel('团队记录').selectOption('current');
    await page.getByRole('heading',{name:'公开数据研究与报告',exact:true}).waitFor();
    checks.push('history-selection');
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').failing=true;});
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent() ?? '',/上次成功读取/);
    assert.equal(await page.getByRole('heading',{name:'公开数据研究与报告',exact:true}).count(),1);
    await page.evaluate(()=>{Reflect.get(window,'teamUiFixture').failing=false;});
    await page.getByRole('alert').waitFor({state:'detached'});
    checks.push('honest-stale-snapshot-and-recovery');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'汇总数据 已接受 · 资料分析'}).click();
    assert.equal(await page.evaluate(()=>document.querySelector('#flow-fixture')!.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:resolve(dir,'mobile-details.png'),fullPage:true});
    await page.locator('#flow-fixture').evaluate(element=>{element.scrollTop=0;});
    await page.screenshot({path:resolve(dir,'mobile.png'),fullPage:true});
    checks.push('390px-no-horizontal-overflow');
    assert.deepEqual(errors,[]);
    await writeFile(resolve(dir,'report.json'),JSON.stringify({status:'PASSED',kind:'production-components-in-native-web-host-with-explicit-fixture-data',checks,console_errors:errors,live_agent_execution:false},null,2));
  } finally {await browser.close();await host.stop();}
});
