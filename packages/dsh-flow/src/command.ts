/** Slash command and ordinary main-session follow-up, using the host command registry. */
import type { Context } from '@deepseek-ai/cordis';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { readFileSync } from 'node:fs';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-skill';
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill';
import { registerTeamTools, teamLaunches } from './team-tools.ts';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from './service.ts';
import { fail } from './errors.ts';

export const name = 'dsh-flow-agent-team-command';
export const inject = ['commands', 'flow', 'sessions', 'sessionController', 'tools', 'sessionProjections', 'agentDefaultModel', 'agents', 'systemPrompt', 'skills'];
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { '智能体团队': {kind:'智能体团队';run_id?:string;fingerprint?:string} & Extract<ContextFormed,{form:'notice'}> }
}

/** Raw public journal survives compaction; only the latest notice for this run counts. */
export function lastTeamNoticeFingerprint(events:readonly SessionEvent[],runId:string):string|undefined {
  for(const event of [...events].reverse()) {
    if(event.type==='user/message'&&event.data.source.kind==='智能体团队'&&event.data.source.run_id===runId)return event.data.source.fingerprint;
    if(event.type==='agent/inbox/spliced')for(const message of [...event.data.inserted].reverse()) {
      if(message.source.kind==='智能体团队'&&message.source.run_id===runId)return message.source.fingerprint;
    }
  }
  return undefined;
}

export { mainModel } from './main-model.ts';

/** Register one human command; no preset or alternate composer is installed. */
export function apply(ctx: Context): void {
  // The host main Agent owns human dialogue; the team's execution sessions keep
  // their own journals. Never copy engine messages into the human conversation.
  ctx.systemPrompt.section({
    name:'dsh-flow:main-coordinator',order:ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),interpolate:false,
    text:({agent})=>agent&&ctx.flow.teamRuns(agent.session.id).length?[
      '你是当前主会话中直接与用户交流的总调度代理，负责协调 dsh-flow 智能体团队。',
      '通过 agent-team skill 评估需求并调用 agent_team_create 创建后台团队；创建结果、启动检查和收尾均通过本会话的工具调用确认。',
      '向用户清楚回应收到的需求。查询进度、结果或执行状态时先调用 agent_team_read，以返回的真实证据为准。',
      '收到团队完成、失败、受阻或等待用户的通知时，输出普通对话正文：交付结果和可用文件，解释实际问题，或向用户提出需要回答的问题。',
      '用户的进度提问通过 agent_team_read 回答；执行要求和团队问题的答复先整理成自包含指令，再调用 agent_team_message。结束后的追问继续在本会话回答。',
      '只有用户明确要求暂停、恢复或取消时才调用 agent_team_control。终态结果核对后调用 agent_team_finalize 并读取确认，历史会保留。给用户输出简洁的普通对话正文。',
    ].join('\n'):'',
  });
  const skillBody=readFileSync(new URL('../skills/agent-team/SKILL.md',import.meta.url),'utf8').replace(/^---\n[\s\S]*?\n---\n/,'');
  ctx.skills.register({name:'agent-team',description:'在主会话中评估任务，创建、跟进并收尾智能体团队。',source:'bundled',provider:'dsh-flow',
    invocation:{modelInvocable:false,userInvocable:true},content:skillBody});
  // Thin host compositions may provide the registry without the generic skill
  // loader. Use its canonical source/renderer and reuse any native injection.
  ctx.on('agent/pre-step',async({agent,signal},next)=>{
    const decision=await next();
    if(decision.kind==='reject')return decision;
    const requested=decision.messages.some(message=>message.source.kind==='user'&&message.content.some(block=>block.type==='text'&&/^\/agent-team\s/.test(block.text)));
    if(!requested||decision.messages.some(message=>message.source.kind==='skill-invocation'&&message.source.name==='agent-team'))return decision;
    const skill=await ctx.skills.get('agent-team',{scope:agent,cwd:agent.session.header.cwd,signal});
    signal.throwIfAborted();
    if(!skill||!isUserInvocable(skill))fail('agent-team skill 不可用',503);
    return {...decision,messages:[...decision.messages,createUserMessage({content:[{type:'text',text:renderSkillContent(skill)}],source:{kind:'skill-invocation',name:'agent-team',form:'instructions'}})]};
  },true);
  const submitting=new Map<string,Promise<{kind:'success';text:string}>>();
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-flow/agent-team'), name: 'agent-team',
    description: '智能体团队 skill：由主会话评估、创建和跟进团队',
    input: { hint: '请描述希望团队完成的任务' },
    async handler(invocation) {
      invocation.signal.throwIfAborted();
      const objective=invocation.rawInput.trim();
      if(!objective)return {kind:'error',text:'请描述希望团队完成的任务'};
      if(ctx.flow.isTeamAgentSession(invocation.agent.session.id))return {kind:'error',text:'请在主会话中使用 agent-team skill'};
      const key=`${invocation.agent.session.id}:${invocation.commandId}`;
      const pending=submitting.get(key);
      if(pending)return pending;
      const task=(async()=>{
        const history=await ctx.sessionController.inspect(invocation.agent.session.id,invocation.signal);
        invocation.signal.throwIfAborted();
        const existing=teamLaunches(history.events).find(launch=>launch.launch_id===invocation.commandId);
        if(existing&&existing.request.content[0]?.type==='text'&&existing.request.content[0].text!==`/agent-team ${objective}`)fail('同一提交标识不能用于不同需求',409);
        const request:UserMessage=existing?.request??createUserMessage({content:[{type:'text',text:`/agent-team ${objective}`},...invocation.attachments],source:{kind:'user'}});
        if(!existing) {
          invocation.agent.session.append('flow/team-launch',{launch_id:invocation.commandId,request},{ignorable:true});
          await ctx.sessions.flush(invocation.agent.session);
        }
        const delivered=history.events.some(event=>event.type==='user/message'&&event.data.id===request.id||event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===request.id));
        if(!delivered)invocation.agent.followup(request);
        return {kind:'success' as const,text:'已提交团队需求，主会话将评估并创建团队'};
      })();
      submitting.set(key,task);
      try{return await task;}finally{submitting.delete(key);}
    },
  }), 'dsh-flow: agent-team skill command');
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if(event.type==='model/selection')ctx.flow.teamSelectModel(session.id,event.data);
  }), 'dsh-flow: main-session model selection');
  registerTeamTools(ctx);
  const announced=new Map<string,string>();
  let busy=false,closed=false;
  ctx.effect(()=>{
    const timer=setInterval(()=>{
      if(busy||closed)return;
      busy=true;
      void (async()=>{
        for(const owner of ctx.flow.teamOwners()) {
          try {
          if(closed)return;
          const sessionId=SessionId(owner);
          const runs=ctx.flow.teamRuns(owner);
          for(const run of runs) {
            if(closed)return;
            const team=ctx.flow.teamRead(owner,run.id);
            if(!['completed','failed','cancelled','blocked','waiting_user','paused'].includes(run.state))continue;
            const completed=team.agents.filter(agent=>agent.state==='completed').length;
            const waiting=team.agents.filter(agent=>agent.state==='waiting_user');
            const key=`${owner}:${run.id}`;
            const signature=JSON.stringify([2,run.state,team.agents.length,completed,waiting.map(agent=>[agent.id,agent.reason])]);
            if(announced.get(key)===signature)continue;
            // Official inspection safely reads attached and persisted sessions,
            // including queued input and notices hidden by compaction.
            const history=await ctx.sessionController.inspect(sessionId);
            const previous=lastTeamNoticeFingerprint(history.events,run.id);
            if(closed)return;
            if(previous===signature){announced.set(key,signature);continue;}
            const summary=`团队${run.state==='completed'?'已完成':run.state==='cancelled'?'已取消':run.state==='failed'?'失败':run.state==='paused'?'已暂停':'进展更新'}：${run.name}`;
            const body=[summary,`运行 ${run.id}。请调用 agent_team_read 核实状态和证据后向用户报告。`,
              ...waiting.map(agent=>`${agent.name} 等待你的答复：${agent.reason??'等待原因尚未提供'}`),
              ...(run.reason?[run.reason]:[]),
              ...(['completed','failed','cancelled'].includes(run.state)?['核对结果后调用 agent_team_finalize 收尾并保留历史。']:[])].join('\n');
            const message=createUserMessage({content:[{type:'text',text:body}],source:{kind:'智能体团队',run_id:run.id,fingerprint:signature,form:'notice',summary:boundContextSummary(summary)}});
            let session=ctx.sessions.get(sessionId);
            // Wake only for events that merit a human response. The official
            // inbox persists delivery before the model produces its own reply.
            if(['completed','failed','cancelled','blocked','paused'].includes(run.state)||waiting.length) {
              const resolved=await ctx.sessionController.resolveAgent(sessionId);
              if(closed)return;
              if('error' in resolved)throw resolved.error;
              resolved.agent.followup(message);
              session=resolved.agent.session;
            } else session?.append('user/message',message,{surfaceOp:'append'});
            if(session)await ctx.sessions.flush(session);
            announced.set(key,signature);
          }
          } catch(error) {ctx.logger.warn(error);}
        }
      })().catch(error=>ctx.logger.warn(error)).finally(()=>busy=false);
    },1500);
    return()=>{closed=true;clearInterval(timer);};
  },'dsh-flow: main-session progress and results');
}
