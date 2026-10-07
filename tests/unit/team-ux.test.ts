/** Ownership, truthful projection and concurrent native team observation. */
import {fromPartial} from '@total-typescript/shoehorn';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {ClusterRuntime} from '../../packages/dsh-flow/src/core/cluster.ts';
import {PreferenceStore,DEFAULT_PREFERENCES} from '../../packages/dsh-flow/src/client/preferences.ts';
import {PreferenceNavigation} from '../../packages/dsh-flow/src/client/navigation.ts';
import {TeamObserver} from '../../packages/dsh-flow/src/client/observer.ts';
import {treeRows,visibleEndedRows,formatMetric,duration} from '../../packages/dsh-flow/src/client/tree.ts';
import type {FlowTeamAgent,FlowTeamRun,FlowTeamSnapshot} from '../../packages/dsh-flow/src/types.ts';
import {lastTeamNoticeFingerprint} from '../../packages/dsh-flow/src/command.ts';
import {Session,SessionId,SessionSeq} from '@deepseek-ai/dsh-session';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import {boundContextSummary,createUserMessage} from '@deepseek-ai/dsh-llm';
import {nativeSessionParent,missingCapabilityTools} from '../../packages/dsh-flow/src/core/runtime.ts';
import type {Agent} from '@deepseek-ai/dsh-agent';

test('capability probes use the native Agent key across separately installed scope modules',()=>{
  const nativeAgent=fromPartial<Agent>({id:SessionId('native-worker')});
  const served=new Set(['read','glob','grep','write','edit']);
  const ctx=fromPartial<Context>({tools:fromPartial<Context['tools']>({
    get(name:string,scope?:object){return scope===nativeAgent&&served.has(name)?fromPartial<ReturnType<Context['tools']['get']>>({name}):undefined;},
  })});
  assert.deepEqual(missingCapabilityTools(ctx,['fs_read','fs_write'],nativeAgent),[]);
});

test('native Flow session lineage preserves owner and actual allocating parent',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-lineage-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const team=runtime.startTeam('main-session','lineage','Hello World',dir);
  const lead=runtime.store.listAgents(team.cluster.id,{role:'orchestrator'})[0]!;
  const allocator=runtime.store.listAgents(team.cluster.id,{role:'allocator'})[0]!;
  assert.deepEqual(nativeSessionParent(runtime.store,lead),{parentSession:'main-session'});
  assert.deepEqual(nativeSessionParent(runtime.store,allocator),{parentSession:lead.session_id});
  const other=runtime.start({objective:'standalone',workspace:dir});
  assert.deepEqual(nativeSessionParent(runtime.store,runtime.store.listAgents(other.cluster.id,{role:'orchestrator'})[0]!),{});
});

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const run:FlowTeamRun={id:'run',main_session_id:'main',name:'同一标题',state:'running',raw_state:'RUNNING',reason:null,created:1000,ended:null,updated:1000,version:1,result:null};
const snapshot:FlowTeamSnapshot={run,agents:[],communications:[],tokens:{value:null,unit:'Token',scope:'self',estimated:false}};
test('a ready agent with completed turns stands by instead of appearing unstarted',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-ready-display-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const team=runtime.startTeam('main','ready','Hello World',dir);
  const allocator=runtime.store.listAgents(team.cluster.id,{role:'allocator'})[0]!;
  assert.equal(runtime.teamRead('main',team.cluster.id).agents.find(agent=>agent.id===allocator.id)?.state,'pending');
  runtime.store.updateAgent(allocator.id,{status:'READY',turns:1});
  const shown=runtime.teamRead('main',team.cluster.id).agents.find(agent=>agent.id===allocator.id)!;
  assert.equal(shown.state,'ready');
  assert.equal(shown.reason,'等待调度');
  assert.equal(shown.waiting_for,null,'no collaborator is invented for an idle role');
  assert.equal(shown.waiting_since,null);
});
test('a blocked team and its agents show blocked instead of unknown',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-blocked-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const started=runtime.startTeam('main','blocked','启动失败',dir);
  const node=runtime.store.nodesInSubtree(started.cluster.id,null)[0]!;
  runtime.store.updateCluster(started.cluster.id,{status:'BLOCKED'});
  runtime.store.updateNode(node.id,{status:'BLOCKED'});
  runtime.store.appendEvent(started.cluster.id,'node-blocked',{node_id:node.id,reason:'orchestrator made no state change across 3 turns'});
  const team=runtime.teamRead('main',started.cluster.id);
  assert.equal(team.run.state,'blocked');
  assert.ok(team.agents.every(agent=>agent.state==='blocked'));
});
test('a model transport failure explains a stalled team in Chinese',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-transport-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const started=runtime.startTeam('main','transport','连接失败',dir);
  const lead=runtime.store.listAgents(started.cluster.id,{role:'orchestrator'})[0]!;
  runtime.store.appendEvent(started.cluster.id,'turn-end',{agent_id:lead.id,stop_reason:'error',stop_detail:{kind:'error',message:'Connection error.',code:'TRANSPORT'}});
  runtime.blockNodeInternal(started.cluster.id,lead.node_id,'orchestrator made no state change across 3 turns');
  const allocator=runtime.store.listAgents(started.cluster.id,{role:'allocator'})[0]!;
  runtime.store.appendEvent(started.cluster.id,'turn-end',{agent_id:allocator.id,stop_reason:'error',stop_detail:{kind:'error',code:'AUTHENTICATION'}});
  runtime.store.appendEvent(started.cluster.id,'turn-end',{agent_id:lead.id,stop_reason:'done'});
  const team=runtime.teamRead('main',started.cluster.id);
  assert.equal(team.run.reason,'模型服务连接失败');
  assert.equal(team.agents.find(agent=>agent.id===lead.id)?.reason,'模型服务连接失败');
});

test('teams inherit each main model and later choices stay confined to the owner',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-model-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false,model:{provider:'local',model:'offline',reasoningEffort:'high'},logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const a=runtime.startTeam('main-a','a','任务A',dir,{provider:'online-a',model:'selected-a',reasoningEffort:'high'});
  const b=runtime.startTeam('main-b','b','任务B',dir,{provider:'online-b',model:'selected-b'});
  const leadA=runtime.store.listAgents(a.cluster.id,{role:'orchestrator'})[0]!;
  const leadB=runtime.store.listAgents(b.cluster.id,{role:'orchestrator'})[0]!;
  assert.equal(runtime.modelFor(leadA).model,'selected-a');
  assert.equal(runtime.modelFor(leadB).model,'selected-b');
  assert.equal(runtime.modelFor(leadB).reasoningEffort,undefined,'an owner without explicit effort uses its adapter default');
  runtime.teamSelectModel('main-a',{provider:'online-a',model:'replacement'});
  for(const agent of runtime.store.listAgents(a.cluster.id))assert.equal(runtime.modelFor(agent).model,'replacement');
  assert.equal(runtime.modelFor(leadB).model,'selected-b');
  assert.equal(runtime.startTeam('main-a','a','任务A',dir,{provider:'local',model:'offline'}).cluster.id,a.cluster.id);
  assert.equal(runtime.modelFor(leadA).model,'replacement','a replay cannot reset an existing run route');
});

test('team rows display the latest recorded model per agent, preserving history after route changes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-model-display-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const team=runtime.startTeam('main','models','任务',dir,{provider:'fixture',model:'configured'});
  const lead=runtime.store.listAgents(team.cluster.id,{role:'orchestrator'})[0]!;
  const allocator=runtime.store.listAgents(team.cluster.id,{role:'allocator'})[0]!;
  const shown=(id:string)=>runtime.teamRead('main',team.cluster.id).agents.find(agent=>agent.id===id)!;
  assert.equal(Reflect.get(shown(lead.id),'model'),'configured');
  for(const [request_id,agent_id,model] of [['old',lead.id,'old-model'],['allocator',allocator.id,'allocator-model'],['new',lead.id,'actual-model']]) {
    runtime.store.insertUsageReceipt({request_id:request_id!,cluster_id:team.cluster.id,agent_id:agent_id!,node_id:lead.node_id,role:'orchestrator',kind:'model',model:model!,reasoning_effort:'high',status:'SETTLED'});
  }
  runtime.teamSelectModel('main',{provider:'fixture',model:'next-route',reasoningEffort:'low'});
  assert.equal(Reflect.get(shown(lead.id),'model'),'actual-model','the next route does not relabel a recorded request');
  assert.equal(Reflect.get(shown(allocator.id),'model'),'allocator-model','model names cannot leak between agents');
  assert.equal(shown(lead.id).reasoning_effort,'high','a next-request preference cannot relabel recorded reasoning');
});

function agent(id:string,parent_id:string|null=null):FlowTeamAgent {
  return {id,parent_id,run_id:run.id,role:'worker',session_id:`session-${id}`,name:'名称'.repeat(40),responsibility:'职责',state:'running',raw_state:'RUNNING',reason:null,waiting_for:null,waiting_since:null,recycled:false,created:1000,ended:null,version:1,tokens:{value:null,unit:'Token',scope:'self',estimated:false},model:null,reasoning_effort:null,allowances:[],context_used:null,context_limit:null,compacted_at:null};
}

test('one command intent starts once, same-name runs stay separate and owning sessions fence reads',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  assert.throws(()=>runtime.startTeam('main','empty','   ',dir),/描述/);
  assert.equal(runtime.teamRuns('main').length,0);
  const first=runtime.startTeam('main','intent','同一标题',dir);
  assert.equal(runtime.startTeam('main','intent',' 同一标题 ',dir).cluster.id,first.cluster.id);
  assert.throws(()=>runtime.startTeam('main','intent','其他需求',dir),/不同任务/);
  const second=runtime.startTeam('main','intent-2','同一标题',dir);
  assert.notEqual(first.cluster.id,second.cluster.id);
  assert.equal(runtime.teamRuns('main').length,2);
  assert.deepEqual(runtime.teamOwners(),['main'],'cold owners are found from durable bindings, independently of the host live-session registry');
  assert.equal(runtime.teamRuns('other').length,0);
  assert.throws(()=>runtime.teamRead('other',first.cluster.id),/不属于/);
  const before=runtime.store.latestEventSeq(first.cluster.id);
  const team=runtime.teamRead('main',first.cluster.id);
  assert.equal(runtime.store.latestEventSeq(first.cluster.id),before,'observing adds no execution event');
  assert.equal(team.agents.length,3);
  const root=team.agents.find(a=>a.parent_id===null)!;
  assert.equal(root.role,'orchestrator');
  assert.deepEqual(team.agents.filter(a=>a.parent_id===root.id).map(a=>a.role).sort(),['allocator','auditor'],'role colours use authoritative types rather than translated names');
  assert.equal(team.agents.filter(a=>a.parent_id===root.id).length,2);
  assert.equal(root.tokens.value,null,'absent usage is never zero');
  assert.equal(root.context_used,null);
  runtime.control(first.cluster.id,'cancel');
  const cancelled=runtime.teamRead('main',first.cluster.id);
  assert.equal(cancelled.run.state,'cancelled');
  for(const identity of cancelled.agents){assert.equal(identity.state,'cancelled');assert.equal(identity.recycled,true);assert.ok(identity.ended);}
  assert.deepEqual(cancelled.agents.map(a=>a.parent_id),team.agents.map(a=>a.parent_id));
  assert.equal(runtime.teamRead('main',second.cluster.id).run.state,'running');
});

test('a later team cannot enlarge or drain another run model-request window',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-slots-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const first=runtime.start({objective:'第一运行',workspace:dir,limits:{max_llm_concurrency:1}}).cluster.id;
  const held=await runtime.acquireLlmSlot(first);
  let admitted=false;
  const queued=runtime.acquireLlmSlot(first).then(release=>{admitted=true;return release;});
  const second=runtime.start({objective:'第二运行',workspace:dir,limits:{max_llm_concurrency:3}}).cluster.id;
  const other=await runtime.acquireLlmSlot(second);
  runtime.setLlmConcurrency(4,second);
  await Promise.resolve();
  assert.equal(admitted,false);assert.equal(runtime.llmSlotsInUse(first),1);assert.equal(runtime.llmWaiters(first),1);
  other();await Promise.resolve();assert.equal(admitted,false,'another run release cannot transfer its permit');
  held();const release=await queued;assert.equal(runtime.llmSlotsInUse(first),1);release();
  assert.equal(runtime.llmSlotsInUse(first),0);
});

test('a concrete user question waits for an ordinary main-session reply and deduplicates delivery',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-wait-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const id=runtime.startTeam('main','question','任务',dir).cluster.id;
  const lead=runtime.store.listAgents(id,{role:'orchestrator'})[0]!;
  runtime.command({cluster_id:id,agent_id:lead.id,session_id:lead.session_id,node_id:lead.node_id,role:'orchestrator'}, {command_id:'ask',action:'request_user',params:{question:'请选择输出位置'}});
  assert.equal(runtime.teamRead('main',id).run.state,'waiting_user');
  assert.equal(runtime.teamRead('main',id).agents.find(a=>a.id===lead.id)?.reason,'请选择输出位置');
  runtime.teamReply('main','reply','写入当前工作区');
  runtime.teamReply('main','reply','写入当前工作区');
  assert.equal(runtime.teamRead('main',id).run.state,'waiting_user','queued answer needs execution confirmation');
  assert.equal(runtime.store.getAgent(lead.id)?.meta.reply_pending,true);
  assert.equal(runtime.teamRead('main',id).communications.filter(m=>String(m.content).includes('no-such')).length,0);
  assert.equal(runtime.store.all("SELECT id FROM messages WHERE cluster_id=? AND id LIKE 'main:%'",id).length,1);
});

test('terminal execution and recycled resources remain distinct; unknown statuses never imply running',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-state-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const id=runtime.startTeam('main','states','任务',dir).cluster.id;
  const identities=runtime.store.listAgents(id);
  const first=identities[0]!;
  runtime.store.updateAgent(first.id,{status:'COMPLETED'});
  const ended=runtime.teamRead('main',id).agents.find(a=>a.id===first.id)!.ended;
  runtime.store.updateAgent(first.id,{status:'TERMINATED'});
  const read=runtime.teamRead('main',id).agents.find(a=>a.id===first.id)!;
  assert.equal(read.state,'completed');assert.equal(read.recycled,true);assert.equal(read.ended,ended);
  const other=identities[1]!;
  runtime.store.updateAgent(other.id,{status:'BLOCKED'});
  assert.equal(runtime.teamRead('main',id).agents.find(a=>a.id===other.id)?.state,'blocked');
  runtime.store.updateAgent(other.id,{status:'TERMINATED'});
  assert.equal(runtime.teamRead('main',id).agents.find(a=>a.id===other.id)?.state,'unknown');
});

test('agent compaction time comes from the native summary event rather than token pressure',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-compaction-time-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const id=runtime.startTeam('main','compaction-time','任务',dir).cluster.id;
  const agent=runtime.store.listAgents(id)[0]!;
  const read=()=>runtime.teamRead('main',id).agents.find(row=>row.id===agent.id)!;
  runtime.store.appendEvent(id,'context-step',{agent_id:agent.id,compacted_at:6109,summary_seq:null,after:6109,context_limit:8192});
  assert.equal(read().compacted_at,null,'a token anchor is never a timestamp');
  const summary=runtime.store.appendEvent(id,'context-step',{agent_id:agent.id,compacted_at:3500,summary_seq:19,after:3500,context_limit:8192});
  runtime.store.appendEvent(id,'context-step',{agent_id:agent.id,compacted_at:3500,summary_seq:null,after:5000,context_limit:8192});
  assert.equal(read().compacted_at,summary.at);
  assert.equal(read().context_used,5000,'later pressure updates do not change the compaction date');
});

test('ended waiting identities never receive instructions; all 601 live waiting identities do',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-many-wait-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const id=runtime.startTeam('main','many-wait','任务',dir).cluster.id;
  const lead=runtime.store.listAgents(id,{role:'orchestrator'})[0]!;
  runtime.store.tx(()=>{
    for(let index=0;index<601;index++)runtime.store.insertAgent({id:`waiting-${index}`,cluster_id:id,node_id:lead.node_id,role:'worker',session_id:`waiting-session-${index}`,status:'READY',meta:{parent_agent_id:lead.id,ui_state:'waiting_user',status_reason:'请选择输出位置'}});
    runtime.store.insertAgent({id:'ended-waiting',cluster_id:id,node_id:lead.node_id,role:'worker',session_id:'ended-waiting-session',status:'READY',meta:{parent_agent_id:lead.id,ui_state:'waiting_user'}});
    runtime.store.updateAgent('ended-waiting',{status:'COMPLETED'});
    runtime.store.updateAgent('ended-waiting',{status:'TERMINATED'});
  });
  runtime.teamReply('main','all-reply','使用当前目录');
  assert.equal(runtime.store.all("SELECT recipient FROM recipients WHERE message_id LIKE 'main:all-reply:%'").length,602);
  assert.equal(runtime.store.get("SELECT recipient FROM recipients WHERE recipient='ended-waiting'"),undefined);
  for(let index=0;index<601;index++)runtime.store.updateAgent(`waiting-${index}`,{status:'TERMINATED'});
  assert.equal(runtime.teamRead('main',id).run.state,'running');
});

test('authoritative budget block reasons survive the observing projection',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-team-block-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),autoTick:false,logger:{warn(){},error(){},info(){}}});
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  const id=runtime.startTeam('main','block','任务',dir).cluster.id;
  const lead=runtime.store.listAgents(id,{role:'orchestrator'})[0]!;
  runtime.blockNodeInternal(id,lead.node_id,'模型请求额度已耗尽','BUDGET_EXHAUSTED',{agent_id:lead.id});
  const view=runtime.teamRead('main',id);
  assert.equal(view.run.reason,'模型请求额度已耗尽');
  assert.equal(view.agents.find(agent=>agent.id===lead.id)?.reason,view.run.reason);
  assert.equal(view.agents.find(agent=>agent.id===lead.id)?.state,'blocked');
});

test('notice recovery compares the latest raw notification, including compacted journal entries',()=>{
  const notice=(seq:number,runId:string,fingerprint:string):SessionEvent<'user/message'>=>({type:'user/message',seq:SessionSeq(seq),time:seq,data:createUserMessage({content:[{type:'text',text:'通知'}],source:{kind:'智能体团队',run_id:runId,fingerprint,form:'notice',summary:boundContextSummary('通知')}}),surfaceOp:'append'});
  const native=Session.create(SessionId('notice-validation'));
  const persisted=native.append('user/message',notice(0,'run','one').data,{surfaceOp:'append'});
  assert.equal(lastTeamNoticeFingerprint([persisted],'run'),'one');
  const history:SessionEvent[]=[notice(0,'run','paused'),notice(1,'run','running'),notice(2,'another','paused')];
  assert.equal(lastTeamNoticeFingerprint(history,'run'),'running','an earlier equal state cannot suppress a new transition');
  // A surface-replacing compaction record does not remove raw journal history.
  history.push({...notice(3,'another','compaction'),surfaceOp:{op:'replace',startSeq:SessionSeq(0),endSeq:SessionSeq(2)},sourceEventSeqs:[SessionSeq(0),SessionSeq(1),SessionSeq(2)]});
  assert.equal(lastTeamNoticeFingerprint(history,'run'),'running');
  history.push(notice(4,'run','paused'));assert.equal(lastTeamNoticeFingerprint(history,'run'),'paused');
  history.push({type:'agent/inbox/spliced',seq:SessionSeq(5),time:5,data:{target:'next-turn',start:0,inserted:[notice(5,'run','completed').data]}});
  assert.equal(lastTeamNoticeFingerprint(history,'run'),'completed','durably queued completion is not re-delivered while its model reply is pending');
});

test('saving failures preserve drafts; navigation waits for the actual outcome',async()=>{
  let writes=0;let pending=deferred<void>();
  const store=new PreferenceStore({read:()=>null,write:()=>{writes++;return pending.promise;}});
  store.edit('view','list');
  const gate=new PreferenceNavigation(store);let navigated=0;
  assert.equal(gate.request(()=>navigated++),true);
  const saving=gate.saveAndLeave();await Promise.resolve();
  store.edit('tokens','exact');assert.equal(store.getSnapshot().draft.tokens,'short','saving locks the captured draft');
  pending.reject(new Error('quota'));await saving;
  assert.equal(navigated,0);assert.equal(store.getSnapshot().dirty,true);assert.equal(gate.getSnapshot(),true);
  assert.deepEqual(store.getSnapshot().saved,DEFAULT_PREFERENCES);
  pending=deferred<void>();
  const retry=store.save();assert.equal(store.save(),retry);
  assert.equal(gate.request(()=>navigated++),true);pending.resolve();await retry;await Promise.resolve();
  assert.equal(writes,2);assert.equal(navigated,1);assert.equal(store.getSnapshot().saved.view,'list');
  store.defaults();assert.equal(store.getSnapshot().saved.view,'list');
  assert.equal(gate.request(()=>navigated++),true);gate.continueEditing();assert.equal(store.getSnapshot().dirty,true);
  assert.equal(gate.request(()=>navigated++),true);gate.discardAndLeave();assert.equal(navigated,2);assert.equal(store.getSnapshot().dirty,false);
});

test('read failure keeps temporary defaults until explicit save',async()=>{
  let written='';const store=new PreferenceStore({read(){throw new Error('denied');},async write(value){written=value;}});
  assert.ok(store.getSnapshot().readError);assert.equal(written,'');
  await store.save();assert.deepEqual(JSON.parse(written),DEFAULT_PREFERENCES);assert.equal(store.getSnapshot().readError,null);
});

test('reconnect fences late replies, follows the current run and rejects cross-session snapshots',async()=>{
  const delayed=deferred<FlowTeamSnapshot>();let readCount=0;
  let runs=[run];
  let current:FlowTeamSnapshot={...snapshot,run:{...run,id:'next',version:2}};
  const source=new TeamObserver('main',{async runs(){return runs;},async read(){readCount++;return readCount===1?delayed.promise:current;}},100000);
  const first=source.refresh();await Promise.resolve();
  runs=[current.run,run];source.reset();await source.refresh();delayed.resolve(snapshot);await first;
  assert.equal(source.getSnapshot().team?.run.id,'next');
  current={...current,run:{...current.run,version:1}};await source.refresh();assert.equal(source.getSnapshot().team?.run.version,2);
  current={...current,run:{...current.run,main_session_id:'other',version:3}};await source.refresh();assert.match(source.getSnapshot().error??'',/其他会话/);assert.equal(source.getSnapshot().team?.run.version,2);
  source.reset();current={...snapshot,run:{...run,id:'next',version:4}};await source.refresh();assert.equal(source.getSnapshot().team?.run.version,4);assert.equal(source.getSnapshot().error,null);source.dispose();
});

test('1000 stable identities, depth 10, repeated 80-character titles and incomplete relationships remain accessible',()=>{
  const agents=Array.from({length:1000},(_,index)=>agent(`agent-${index}`,index===0?null:`agent-${index<11?index-1:0}`));
  agents.push(agent('orphan','missing'));
  const collapsed=new Set(['agent-0']);
  assert.equal(treeRows(agents,collapsed).length,2,'collapsed descendants stay hidden; unresolved roots remain');
  const all=treeRows(agents);assert.equal(new Set(all.map(row=>row.agent.id)).size,1001);
  assert.equal(all.find(row=>row.agent.id==='agent-10')?.depth,10,'expansion restores the complete derivation depth');
  assert.equal(all.find(row=>row.agent.id==='orphan')?.incomplete,true);
  assert.equal(formatMetric({value:0,unit:'Token',scope:'self',estimated:false}),'0');
  assert.equal(formatMetric({value:null,unit:'Token',scope:'self',estimated:false}),'—');
  assert.equal(formatMetric({value:1500,unit:'Token',scope:'descendants',estimated:true},'short'),'约 1.5k（含子代理）');
  assert.equal(duration(1000,5000,999999),'00:04');
});


test('the current run follows the authoritative directory and retains readable data on failure',async()=>{
  let runs=[run];let unavailable=true;
  const next={...run,id:'next'};
  const source=new TeamObserver('main',{async runs(){return runs;},async read(_session,id){if(id==='next'&&unavailable)throw new Error('暂时无法读取');return {...snapshot,run:runs.find(item=>item.id===id)!};}},100000);
  await source.refresh();assert.equal(source.getSnapshot().team?.run.id,'run');
  runs=[next,run];await source.refresh();
  assert.equal(source.getSnapshot().team?.run.id,'run','a failed read leaves the loaded snapshot available');
  assert.deepEqual(source.getSnapshot().runs.map(item=>item.id),['next','run']);assert.match(source.getSnapshot().error??'',/无法读取/);
  unavailable=false;await source.refresh();assert.equal(source.getSnapshot().team?.run.id,'next');assert.equal(source.getSnapshot().error,null);
  runs=[{...next,state:'completed',version:2},run];await source.refresh();assert.equal(source.getSnapshot().team?.run.id,'run','an active run is preferred over a completed entry');
  runs=[{...next,state:'completed',version:2},{...run,state:'cancelled',version:2}];await source.refresh();assert.equal(source.getSnapshot().team?.run.id,'next','the newest run is shown when all teams are terminal');
  runs=[];await source.refresh();assert.equal(source.getSnapshot().team,null);source.dispose();
});


test('ended collapse hides wholly ended branches but keeps ended ancestors of live descendants',()=>{
  const root=agent('root');const old={...agent('old','root'),state:'completed' as const};
  const leaf={...agent('old-leaf','old'),state:'completed' as const};
  const live=agent('live','old');const ended=[root,old,leaf];
  assert.deepEqual(visibleEndedRows(treeRows(ended),ended,false).map(row=>row.agent.id),['root']);
  const agents=[...ended,live];assert.deepEqual(visibleEndedRows(treeRows(agents),agents,false).map(row=>row.agent.id),['root','old','live']);
  assert.deepEqual(visibleEndedRows(treeRows(agents,new Set(['old'])),agents,false).map(row=>row.agent.id),['root','old']);
});
