import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Config,resolveConfig} from '../../packages/dsh-flow/src/config.ts';
import type {ResolvedConfig} from '../../packages/dsh-flow/src/config.ts';
import {ClusterRuntime} from '../../packages/dsh-flow/src/core/cluster.ts';
import {agentGivenName,agentEmoji,modelBrand,reasoningLabel} from '../../packages/dsh-flow/src/identity.ts';
import {topologyLayout,NODE_WIDTH,NODE_HEIGHT,treeRows} from '../../packages/dsh-flow/src/client/tree.ts';
import {fromPartial} from '@total-typescript/shoehorn';
import type {FlowTeamAgent} from '../../packages/dsh-flow/src/types.ts';

test('official volatile defaults capture new teams without relabelling active or recovered teams',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-live-defaults-')),path=join(dir,'ledger.sqlite');
  const initial=Config({provider:'fixture',model:'base',workspace:dir,dataDir:dir,defaultLimits:{max_depth:2,max_children:3}});
  let budget=initial.defaultBudget.get(),limits=initial.defaultLimits.get(),mode:'parallel'|'serial'='parallel';
  let route:{provider:string;model:string}|null=null,output=2048,effort:'inherit'|'high'='inherit';
  const config:ResolvedConfig={...initial,defaultBudget:{get:()=>budget},defaultLimits:{get:()=>limits},defaultDispatchMode:{get:()=>mode},defaultModel:{get:()=>route},maxTokens:{get:()=>output},defaultReasoningEffort:{get:()=>effort}};
  const deployment=resolveConfig(config);
  let runtime=new ClusterRuntime(new Context(),{...deployment.runtime,startDefaults:deployment.startDefaults,path,autoTick:false});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const first=runtime.startTeam('main','first','First',dir,{provider:'owner',model:'owner-model',reasoningEffort:'low'});
  const lead=runtime.store.listAgents(first.cluster.id,{role:'orchestrator'})[0]!;
  assert.equal(runtime.modelFor(lead).model,'owner-model');assert.equal(runtime.modelFor(lead).maxTokens,2048);
  budget={...budget,tokens:123456,wall_time_ms:180000,agents:12};limits={...limits,max_depth:1,max_children:2,max_agents:12};
  mode='serial';route={provider:'fixture',model:'fixed'};output=1024;effort='high';
  assert.equal(runtime.startTeam('main','first','First',dir).cluster.id,first.cluster.id,'acknowledgment retry keeps its original snapshot');
  const second=runtime.startTeam('main','second','Second',dir,{provider:'owner',model:'ignored'});
  const secondLead=runtime.store.listAgents(second.cluster.id,{role:'orchestrator'})[0]!;
  assert.equal(second.cluster.budget.tokens,123456);assert.equal(second.cluster.budget.wall_time_ms,180000);
  assert.equal(second.cluster.limits.max_depth,1);assert.equal(second.cluster.limits.max_children,2);
  assert.equal(second.cluster.limits.max_agents,12);assert.equal(second.cluster.limits.max_active_agents,1);assert.equal(second.cluster.limits.max_llm_concurrency,1);
  assert.equal(runtime.modelFor(secondLead).model,'fixed');assert.equal(runtime.modelFor(secondLead).reasoningEffort,'high');
  runtime.teamSelectModel('main',{provider:'owner',model:'new-owner',reasoningEffort:'medium'});
  assert.equal(runtime.modelFor(secondLead).model,'fixed','explicit team model survives a main-dialogue selection');
  assert.equal(runtime.modelFor(lead).model,'new-owner');assert.equal(runtime.modelFor(lead).maxTokens,2048,'old output cap remains captured');
  assert.equal(runtime.store.getCluster(first.cluster.id)!.limits.max_depth,2);
  await runtime.dispose();output=8192;route=null;mode='parallel';
  runtime=new ClusterRuntime(new Context(),{...deployment.runtime,path,autoTick:false});
  assert.equal(runtime.modelFor(secondLead).model,'fixed');assert.equal(runtime.modelFor(secondLead).maxTokens,1024,'cold restart uses persisted model options');
  const third=runtime.startTeam('main','third','Third',dir,{provider:'owner',model:'latest'});
  assert.equal(runtime.modelFor(runtime.store.listAgents(third.cluster.id,{role:'orchestrator'})[0]!).maxTokens,8192);
});

test('editable Config validates defaults while preserving deployment-specific budgets',()=>{
  const config=Config({provider:'fixture',model:'model',defaultBudget:{tokens:456789},defaultLimits:{max_depth:3,max_children:2}});
  const defaults=resolveConfig(config).runtime.executionDefaults();
  assert.equal(defaults.start.budget.tokens,456789);assert.equal(defaults.start.limits.max_depth,3);
  for(const input of [{defaultLimits:{max_depth:0}},{defaultBudget:{tokens:0}},{defaultDispatchMode:'unknown'},{maxTokens:-1}])assert.throws(()=>Reflect.apply(Config,undefined,[{provider:'fixture',model:'model',...input}]));
});

test('topology centers parents, prevents overlap and keeps unresolved roots accessible',()=>{
  const agent=(id:string,parent_id:string|null)=>fromPartial<FlowTeamAgent>({id,parent_id,name:agentGivenName(id),state:'running'});
  const rows=treeRows([agent('root',null),agent('a','root'),agent('b','root'),agent('aa','a'),agent('ab','a')]);
  const layout=topologyLayout(rows),p=(id:string)=>layout.positions.get(id)!;
  assert.equal(p('root').x+NODE_WIDTH/2,layout.width/2);
  assert.equal(p('a').x+NODE_WIDTH/2,(p('aa').x+p('ab').x+NODE_WIDTH)/2);
  for(const left of rows)for(const right of rows)if(left.agent.id!==right.agent.id&&left.depth===right.depth)assert.ok(Math.abs(p(left.agent.id).x-p(right.agent.id).x)>=NODE_WIDTH);
  assert.ok(p('aa').y>=p('a').y+NODE_HEIGHT);
  assert.deepEqual(topologyLayout(treeRows([agent('orphan','missing'),agent('cycle-a','cycle-b'),agent('cycle-b','cycle-a')])).positions.size,3);
});

test('agent identities stay stable and model branding uses a neutral fallback',()=>{
  for(const id of ['agent-a','agent-b','agent-c']) {assert.match(agentGivenName(id),/^[\p{Script=Han}]{2}$/u);assert.equal(agentGivenName(id),agentGivenName(id));assert.ok(agentEmoji(id,'worker'));}
  for(const [model,brand] of [['deepseek-flash','DeepSeek'],['gpt-5.4','OpenAI'],['claude-sonnet-4','Anthropic'],['gemini-3-pro','Google'],['qwen3','Alibaba'],['llama-4','Meta'],['unknown-fixture','unknown']])assert.equal(modelBrand(model!),brand);
  assert.equal(reasoningLabel('high'),'高');assert.equal(reasoningLabel('off'),null);assert.equal(reasoningLabel(null),null);
});
