/** Native input and inbox delivery boundaries for the human-facing coordinator. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fromPartial} from '@total-typescript/shoehorn';
import {Context} from '@deepseek-ai/cordis';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-skill';
import type {SkillRegistration} from '@deepseek-ai/dsh-skill';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import {apply,lastTeamNoticeFingerprint} from '../../packages/dsh-flow/src/command.ts';
import {ClusterRuntime} from '../../packages/dsh-flow/src/core/cluster.ts';

test('the skill command admits a human request once without creating a team',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'flow-main-dialog-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false});
  const session=Session.create(SessionId('human-main'),[],{version:4,id:SessionId('human-main'),cwd:dir,createdAt:Date.now(),isSeeded:false});
  const messages:UserMessage[]=[];
  type Definition={name:string;handler:(invocation:{agent:Agent;commandId:string;submissionId?:string;rawInput:string;attachments:[];signal:AbortSignal})=>{kind:string}|Promise<{kind:string}>};
  const definitions:Definition[]=[];
  const disposers:(()=>unknown)[]=[];
  const agent=fromPartial<Agent>({id:session.id,session,followup(message:UserMessage){messages.push(message);session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]});}});
  const fixture={
    flow:runtime,
    skills:fromPartial<Context['skills']>({register(skill:SkillRegistration){assert.equal(skill.invocation?.modelInvocable,false);assert.match(skill.content,/agent_team_create/);return()=>{};}}),
    commands:{register(definition:Definition){definitions.push(definition);return()=>{};}},
    tools:fromPartial<Context['tools']>({register(){return()=>{};}}),
    systemPrompt:fromPartial<Context['systemPrompt']>({section(){return()=>{};},getSectionOrder(){return 600;}}),
    sessions:fromPartial<Context['sessions']>({list(){return[];},async flush(){return true;}}),
    sessionController:fromPartial<Context['sessionController']>({async inspect(){return fromPartial<Awaited<ReturnType<Context['sessionController']['inspect']>>>({events:session.snapshotEvents(),meta:session.header});}}),
    sessionProjections:fromPartial<Context['sessionProjections']>({stateOf(){return undefined;}}),
    agentDefaultModel:{currentSelection(){return {provider:'fixture',model:'fixture'};}},
    effect(operation:()=>unknown){const disposer=operation();if(typeof disposer==='function')disposers.push(()=>disposer());return()=>{};},
    on(){return()=>{};},
  };
  const ctx=fromPartial<Context>(fixture);
  t.after(async()=>{for(const dispose of disposers)dispose();await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  apply(ctx);
  const command=definitions.find(definition=>definition.name==='agent-team')!;
  const invocation=fromPartial<Parameters<typeof command.handler>[0]>({agent,commandId:'attempt-1',submissionId:'intent',rawInput:'写一个 Hello World',attachments:[],signal:new AbortController().signal});
  const pending=command.handler(invocation);
  await assert.rejects(Promise.resolve(command.handler({...invocation,commandId:'attempt-conflict',rawInput:'另一个需求'})),/同一提交标识不能用于不同需求/);
  assert.equal((await pending)?.kind,'success');
  assert.equal(messages.length,1);
  assert.deepEqual(messages[0]!.source,{kind:'user'});
  assert.deepEqual(messages[0]!.content,[{type:'text',text:'/agent-team 写一个 Hello World'}]);
  assert.equal(runtime.teamRuns(session.id).length,0,'the model has not called create');
  assert.equal(session.snapshotEvents().find(event=>event.type==='flow/team-launch')?.ignorable,true,'plugin metadata must remain cold-readable');
  await command.handler({...invocation,commandId:'attempt-2'});
  assert.equal(messages.length,1,'a repeated startup intent cannot invent a second human message');
});

test('a durable native inbox notice suppresses duplicate completion delivery after restart',()=>{
  const session=Session.create(SessionId('pending-completion'));
  // This is the public inbox event the native Agent commits before consuming input.
  const source={kind:'智能体团队',run_id:'run',fingerprint:'terminal',form:'notice',summary:'团队已完成'} as const;
  const queued=fromPartial<UserMessage>({id:'completion',role:'user',source,content:[{type:'text',text:'Hello World 已通过审核'}]});
  const event=session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[queued]});
  assert.equal(lastTeamNoticeFingerprint([event],'run'),'terminal');
  const unrelated=fromPartial<SessionEvent<'agent/inbox/spliced'>>({type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[]}});
  assert.equal(lastTeamNoticeFingerprint([event,unrelated],'run'),'terminal');
  assert.equal(lastTeamNoticeFingerprint([event],'other'),undefined);
});

test('a completed team wakes its cold owning Agent through the official controller, once across restart',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const dir=mkdtempSync(join(tmpdir(),'flow-cold-main-'));
  const runtime=new ClusterRuntime(new Context(),{path:join(dir,'ledger.sqlite'),dataDir:dir,autoTick:false});
  const id=SessionId('cold-human-main');
  const session=Session.create(id,[],{version:4,id,cwd:dir,createdAt:Date.now(),isSeeded:false});
  const run=runtime.startTeam(id,'cold','Hello World',dir);
  runtime.control(run.cluster.id,'cancel');
  const events:SessionEvent[]=[];
  const delivered:UserMessage[]=[];
  let activations=0;
  const agent=fromPartial<Agent>({id,session,followup(message:UserMessage){
    delivered.push(message);
    events.push(session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]}));
  }});
  const mount=()=>{
    const disposers:(()=>unknown)[]=[];
    const fixture={
      flow:fromPartial<Context['flow']>({teamOwners:runtime.teamOwners.bind(runtime),teamRuns:runtime.teamRuns.bind(runtime),teamRead:runtime.teamRead.bind(runtime)}),
      commands:{register(){return()=>{};}},tools:{register(){return()=>{};}},skills:{register(){return()=>{};}},
      systemPrompt:{section(){return()=>{};},getSectionOrder(){return 600;}},
      // The owner is deliberately absent from the live Session and Agent registry.
      sessions:{get(){return undefined;},async flush(){return true;}},
      sessionController:{async inspect(){return {events,meta:session.header};},async resolveAgent(){activations++;return {agent};}},
      logger:{warn(error:unknown){throw error;}},
      effect(operation:()=>unknown){const dispose=operation();if(typeof dispose==='function')disposers.push(()=>dispose());return()=>{};},
      on(){return()=>{};},
    };
    apply(fromPartial<Context>(fixture));
    return()=>{for(const dispose of disposers)dispose();};
  };
  let dispose=mount();
  t.after(async()=>{dispose();await runtime.dispose();rmSync(dir,{recursive:true,force:true});});
  t.mock.timers.tick(1500);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(activations,1,'cold activation comes from resolveAgent, not an observer or copied journal');
  assert.equal(delivered.length,1);
  assert.equal(delivered[0]!.source.kind,'智能体团队');
  assert.match(delivered[0]!.content.filter(b=>b.type==='text').map(b=>b.text).join(''),/已取消/);
  dispose();dispose=mount();
  t.mock.timers.tick(1500);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(activations,1,'durably queued notification suppresses a second wake after plugin restart');
  assert.equal(delivered.length,1);
});
