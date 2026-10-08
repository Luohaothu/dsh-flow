import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {fromPartial} from '@total-typescript/shoehorn';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
import type {ToolDefinition,ToolRunContext} from '@deepseek-ai/dsh-tools';
import {Config,resolveConfig} from '../../packages/dsh-flow/src/config.ts';
import {ClusterRuntime} from '../../packages/dsh-flow/src/core/cluster.ts';
import {projectAgentSession} from '../../packages/dsh-flow/src/agent-session.ts';
import {registerTeamTools,pollTeam} from '../../packages/dsh-flow/src/team-tools.ts';
import type {FlowTeamCreateRequest} from '../../packages/dsh-flow/src/types.ts';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'flow-team-lifecycle-'));
  const deployment=resolveConfig(Config({provider:'fixture',model:'fixture',workspace:dir,dataDir:dir}));
  const runtime=new ClusterRuntime(new Context(),{...deployment.runtime,startDefaults:deployment.startDefaults,path:join(dir,'ledger.sqlite'),autoTick:false});
  const session=Session.create(SessionId('main'),[],{version:4,id:SessionId('main'),cwd:dir,createdAt:Date.now(),isSeeded:false});
  session.append('flow/team-launch',{launch_id:'launch',request:createUserMessage({content:[{type:'text',text:'/agent-team Sum [2,3]'}],source:{kind:'user'}})});
  const tools=new Map<string,ToolDefinition>();
  const ctx=fromPartial<Context>({flow:runtime,tools:fromPartial<Context['tools']>({register(tool:ToolDefinition){tools.set(tool.name,tool);return()=>{};}}),
    sessionController:fromPartial<Context['sessionController']>({async inspect(id:SessionId){return fromPartial<Awaited<ReturnType<Context['sessionController']['inspect']>>>({events:id===session.id?session.snapshotEvents():[],meta:session.header});}}),
    sessionProjections:fromPartial<Context['sessionProjections']>({stateOf(){return undefined;}}),agentDefaultModel:fromPartial<Context['agentDefaultModel']>({currentSelection(){return {provider:'fixture',model:'fixture',maxTokens:4096};}}),
  });
  registerTeamTools(ctx);
  const agent=fromPartial<Agent>({id:session.id,session});
  const request:FlowTeamCreateRequest={objective:'Sum [2,3]',assessment:{complexity:'simple',rationale:'One numerical check and independent review'},acceptance_criteria:['The verified total is 5'],capabilities:[],budget:{tool_calls:600},limits:{max_depth:2}};
  const exec=(caller=agent,signal=new AbortController().signal)=>fromPartial<ToolRunContext>({agent:caller,callId:ToolCallId('call'),signal});
  const call=async(name:string,args:unknown,caller=agent)=>{const result=await tools.get(name)!.execute(args,exec(caller));assert.ok(typeof result==='string');return JSON.parse(result);};
  t.after(async()=>{await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  return {runtime,session,agent,request,call,tools,exec};
}

test('main Agent reads a launch, creates with assessed overrides and checks actual startup',async t=>{
  const f=fixture(t);
  const before=await f.call('agent_team_read',{});
  assert.equal(before.run,null);assert.equal(before.launches[0].launch_id,'launch');assert.equal(before.defaults.limits.max_active_agents,4);
  const created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  assert.equal(created.run.state,'running');assert.equal(created.agents.length,3);
  assert.deepEqual(created.parameters.capabilities,[]);assert.equal(created.parameters.budget.tool_calls,600);assert.equal(created.parameters.limits.max_depth,2);
  const checked=await f.call('agent_team_read',{launch_id:'launch'});
  assert.equal(checked.run_id,created.run_id);
  assert.equal(f.runtime.store.listTransactions({cluster_id:created.run_id})[0]?.acceptance_criteria[0],'The verified total is 5');
  const replay=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  assert.equal(replay.run_id,created.run_id);assert.equal(f.runtime.teamRuns('main').length,1);
  await assert.rejects(f.call('agent_team_create',{launch_id:'launch',...f.request,budget:{}}),/参数已确定/);
  assert.equal(f.runtime.teamRuns('main').length,1);
});

test('creation rejects missing assessment and foreign launch before starting execution',async t=>{
  const f=fixture(t);
  await assert.rejects(f.call('agent_team_create',{launch_id:'other',...f.request}),/启动意图/);
  await assert.rejects(f.call('agent_team_create',{launch_id:'launch',...f.request,assessment:undefined}));
  await assert.rejects(f.call('agent_team_create',{launch_id:'launch',...f.request,acceptance_criteria:[]}));
  assert.equal(f.runtime.teamRuns('main').length,0);
});

test('team service rejects retired fields before creating durable state', async t=>{
  const f=fixture(t);
  for(const key of ['maxTokens','context']) {
    assert.throws(()=>f.runtime.createTeam('main',`retired-${key}`,{...f.request,[key]:1}), /不受支持/);
    await assert.rejects(f.call('agent_team_create',{launch_id:'launch',...f.request,[key]:1}), new RegExp(`Unsupported agent_team_create argument: ${key}`));
  }
  const retiredModel={provider:'fixture',model:'fixture',maxTokens:1};
  assert.throws(()=>f.runtime.createTeam('main','retired-model',f.request,retiredModel), /Unsupported model selection field: maxTokens/);
  assert.throws(()=>f.runtime.startTeam('main','retired-start','任务',undefined,retiredModel), /Unsupported model selection field: maxTokens/);
  assert.equal(f.runtime.teamRuns('main').length,0);
});

test('a blocked closeout still exposes accepted transaction results and validation',async t=>{
  const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  const transaction=f.runtime.store.listTransactions({cluster_id:created.run_id})[0]!;
  f.runtime.store.updateTransaction(transaction.id,{status:'ACCEPTED',result:{total:5},validation:{accepted:true,notes:'independent sum'}});
  f.runtime.store.updateCluster(created.run_id,{status:'BLOCKED'});
  const evidence=await f.call('agent_team_read',{run_id:created.run_id,transaction_id:transaction.id});
  assert.equal(evidence.run.result,null,'cluster summary has not been written');
  assert.equal(evidence.execution.transactions[0].status,'ACCEPTED');
  assert.equal(evidence.execution.transactions[0].result.total,5);
  assert.equal(evidence.execution.transaction.data.validation.accepted,true);
  assert.equal(evidence.execution.truncated,false);
});

test('only explicit main-Agent message tools dispatch instructions, with call identity deduplication',async t=>{
  const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  const before=f.runtime.teamRead('main',created.run_id).communications.length;
  await f.call('agent_team_read',{run_id:created.run_id});
  assert.equal(f.runtime.teamRead('main',created.run_id).communications.length,before);
  await f.call('agent_team_message',{run_id:created.run_id,text:'Check the inverse too'});
  await f.call('agent_team_message',{run_id:created.run_id,text:'Check the inverse too'});
  const messages=f.runtime.teamRead('main',created.run_id).communications;
  assert.equal(messages.length,before+1);assert.equal(messages.at(-1)?.category,'task_instruction');
});

test('finalize fences active and foreign teams, retains evidence and is idempotent',async t=>{
  const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  await assert.rejects(f.call('agent_team_finalize',{run_id:created.run_id}),/尚未结束/);
  const foreign=fromPartial<Agent>({session:Session.create(SessionId('foreign'))});
  await assert.rejects(f.call('agent_team_read',{run_id:created.run_id},foreign),/不属于/);
  await assert.rejects(f.call('agent_team_control',{run_id:created.run_id,action:'cancel'},foreign),/不属于/);
  await assert.rejects(f.call('agent_team_finalize',{run_id:created.run_id},foreign),/不属于/);
  const lead=f.runtime.store.listAgents(created.run_id,{role:'orchestrator'})[0]!;
  const child=fromPartial<Agent>({session:Session.create(SessionId(lead.session_id))});
  await assert.rejects(f.call('agent_team_create',{launch_id:'launch',...f.request},child),/仅主会话/);
  await f.call('agent_team_control',{run_id:created.run_id,action:'cancel'});
  const finalized=await f.call('agent_team_finalize',{run_id:created.run_id});
  assert.equal(finalized.run.state,'cancelled');assert.ok(finalized.run.finalized_at);
  const version=finalized.run.version;
  const twice=await f.call('agent_team_finalize',{run_id:created.run_id});assert.equal(twice.run.version,version);
  const history=await f.call('agent_team_read',{run_id:created.run_id});
  assert.equal(history.agents.length,3);assert.equal(history.run.name,'Sum [2,3]');assert.ok(history.agents.every((agent:{recycled:boolean})=>agent.recycled));
  assert.ok(f.runtime.store.get("SELECT seq FROM events WHERE cluster_id=? AND type='team-created'",created.run_id));
});

test('bounded read waits for a version change, respects terminal state and aborts promptly',async t=>{
  const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  const read=()=>f.runtime.teamRead('main',created.run_id),version=read().run.version;
  const pending=pollTeam(read,version,1000,new AbortController().signal);
  f.runtime.store.appendEvent(created.run_id,'fixture-progress',{});
  assert.ok((await pending).run.version>version);
  const controller=new AbortController();
  const aborted=pollTeam(read,read().run.version,30000,controller.signal);controller.abort(new Error('human interrupted'));
  await assert.rejects(aborted,/abort|interrupted/i);
  await assert.rejects(f.call('agent_team_read',{run_id:created.run_id,wait_ms:30001}),/wait_ms/);
  f.runtime.control(created.run_id,'cancel');
  assert.equal((await pollTeam(read,read().run.version,30000,new AbortController().signal)).run.state,'cancelled');
});

test('a selected native Agent receives one human prompt, with retry and recycling fences',async t=>{
  const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
  const selected=f.runtime.store.listAgents(created.run_id,{role:'auditor'})[0]!;
  assert.equal(f.runtime.agentSession('main'),null);
  assert.equal(f.runtime.agentSession(selected.session_id)?.can_message,true);
  f.runtime.promptAgent(selected.session_id,'rpc','Check 5-3=2','Asia/Shanghai');
  f.runtime.promptAgent(selected.session_id,'rpc','Check 5-3=2','Asia/Shanghai');
  assert.equal(f.runtime.store.pendingDeliveries(selected.id).length,1);
  for(const other of f.runtime.store.listAgents(created.run_id).filter(agent=>agent.id!==selected.id)) assert.equal(f.runtime.store.pendingDeliveries(other.id).length,0);
  assert.equal(f.runtime.store.getAgent(selected.id)?.meta.reply_pending,true);
  await assert.rejects(async()=>f.runtime.promptAgent(selected.session_id,'rpc','Changed text','Asia/Shanghai'),/请求标识/);
  const sibling=f.runtime.store.listAgents(created.run_id,{role:'allocator'})[0]!;
  assert.throws(()=>f.runtime.promptAgent(sibling.session_id,'rpc','Check 5-3=2','Asia/Shanghai'),/请求标识/);
  await f.call('agent_team_control',{run_id:created.run_id,action:'cancel'});
  await f.call('agent_team_finalize',{run_id:created.run_id});
  assert.equal(f.runtime.agentSession(selected.session_id)?.can_message,false);
  assert.match(f.runtime.agentSession(selected.session_id)?.message_block_reason??'',/回收/);
  f.runtime.promptAgent(selected.session_id,'rpc','Check 5-3=2','Asia/Shanghai');
  assert.throws(()=>f.runtime.promptAgent(selected.session_id,'new-rpc','New input'),/回收/);
  assert.equal(f.runtime.store.all("SELECT id FROM messages WHERE id LIKE 'human:%'").length,1);
});

for (const status of ['RUNNING','PAUSED','BLOCKED','COMPLETED','FAILED','CANCELLED'] as const) {
  test(`native continuation and browser seeding agree for a ${status} team and completed Agent`,async t=>{
    const f=fixture(t),created=await f.call('agent_team_create',{launch_id:'launch',...f.request});
    const selected=f.runtime.store.listAgents(created.run_id,{role:'auditor'})[0]!;
    f.runtime.store.updateAgent(selected.id,{status:'COMPLETED'});
    f.runtime.store.updateCluster(created.run_id,{status});
    const team=f.runtime.teamRead('main',created.run_id),agent=team.agents.find(agent=>agent.id===selected.id)!;
    const terminal=['COMPLETED','FAILED','CANCELLED'].includes(status);
    const expected={run:team.run,agent,can_message:!terminal,message_block_reason:terminal?'团队已结束，不再接受消息。历史对话和轨迹仍可查看。':null};
    assert.equal(agent.state,'completed');assert.equal(agent.recycled,false);
    assert.deepEqual(f.runtime.agentSession(selected.session_id),expected);
    assert.deepEqual(projectAgentSession(team.run,agent),expected);

    f.runtime.store.recordTeamEnd(selected,'COMPLETED');
    f.runtime.store.updateAgent(selected.id,{status:'TERMINATED'});
    const recycled=f.runtime.teamRead('main',created.run_id),retained=recycled.agents.find(agent=>agent.id===selected.id)!;
    const history={run:recycled.run,agent:retained,can_message:false,message_block_reason:'该智能体已回收，不再接受消息。可在这里查看完整执行记录。'};
    assert.equal(retained.state,'completed');assert.equal(retained.recycled,true);
    assert.deepEqual(f.runtime.agentSession(selected.session_id),history,'resource recycling determines the message even for a terminal team');
    assert.deepEqual(projectAgentSession(recycled.run,retained),history);
  });
}
