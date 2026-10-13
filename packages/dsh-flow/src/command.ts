/** Slash command and ordinary main-session follow-up, using the host command registry. */
import type { Context } from '@deepseek-ai/cordis';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { readFileSync } from 'node:fs';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-skill';
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { mainModel } from './main-model.ts';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from './service.ts';
import { fail } from './errors.ts';

export const name = 'dsh-flow-agent-team-command';
export const inject = ['commands', 'flow', 'sessions', 'sessionController', 'sessionProjections', 'agentDefaultModel', 'agents', 'systemPrompt', 'skills'];
export { mainModel } from './main-model.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'flow/team-intent': { intent_id: string; request: UserMessage } }
}
export function teamIntents(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'flow/team-intent' ? [event.data] : []).reverse();
}

/** Register one human command; no preset or alternate composer is installed. */
export function apply(ctx: Context): void {
  // The host main Agent owns human dialogue; the team's execution sessions keep
  // their own journals. Never copy engine messages into the human conversation.
  ctx.systemPrompt.section({
    name:'dsh-flow:main-coordinator',order:ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),interpolate:false,
    text:({agent})=>{
      const runs=agent?ctx.flow.teamRuns(agent.session.id).filter(run=>run.state==='running'||run.state==='paused'):[];
      if(!runs.length)return '';
      return `你在当前团队承担协调者（Orchestrator）角色，负责分工、验收、汇总和最终交付；使用完整的标准 DSH Agent 能力。当前团队与根任务：${JSON.stringify(runs.map(run=>({team_id:run.id,root_task_id:run.root_task_id,state:run.state})))}。根任务由你执行。\nflow_task 委派互补工作，并用 profile 声明所需角色、职责及可选原生 preset、模型和 skills；按需创建角色，简单任务可直接完成。用已有产物核验并 flow_review 接受成员交付。你完成最终检查后，用 flow_result 的 complete 声明完成根任务，随后正常向用户交付。`;
    },
  });
  const skillBody=readFileSync(new URL('../skills/agent-team/SKILL.md',import.meta.url),'utf8').replace(/^---\n[\s\S]*?\n---\n/,'');
  ctx.skills.register({name:'agent-team',description:'在主会话中评估任务，创建并协作完成智能体团队任务。',source:'bundled',provider:'dsh-flow',
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
  const submitting=new Map<string,{contentKey:string;promise:Promise<{kind:'success';text:string}>}>();
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-flow/agent-team'), name: 'agent-team',
    description: '智能体团队 skill：由主会话评估、创建和跟进团队',
    input: { hint: '请描述希望团队完成的任务', attachments: true },
    async handler(invocation) {
      invocation.signal.throwIfAborted();
      const objective=invocation.rawInput.trim();
      if(!objective)return {kind:'error',text:'请描述希望团队完成的任务'};
      if(ctx.flow.isTeamAgentSession(invocation.agent.session.id))return {kind:'error',text:'请在主会话中使用 agent-team skill'};
      const content = [{type:'text' as const,text:`/agent-team ${objective}`},...invocation.attachments];
      const contentKey = JSON.stringify(content);
      // RPC retries share the domain intent identity; every native command
      // execution still has a unique run/done pairing in the V4 journal.
      const intentId=invocation.submissionId ? `cmd-client-${invocation.submissionId}` : invocation.commandId;
      const key=`${invocation.agent.session.id}:${intentId}`;
      const pending=submitting.get(key);
      if(pending){
        if(pending.contentKey!==contentKey)fail('同一提交标识不能用于不同需求',409);
        return pending.promise;
      }
      const task=(async()=>{
        const history=await ctx.sessionController.inspect(invocation.agent.session.id,invocation.signal);
        invocation.signal.throwIfAborted();
        const existing=teamIntents(history.events).find(intent=>intent.intent_id===intentId);
        if(existing&&JSON.stringify(existing.request.content)!==contentKey)fail('同一提交标识不能用于不同需求',409);
        const request:UserMessage=existing?.request??createUserMessage({content,source:{kind:'user'}});
        if(!existing) {
          invocation.agent.session.append('flow/team-intent',{intent_id:intentId,request},{ignorable:true});
          await ctx.sessions.flush(invocation.agent.session);
        }
        const priorRun=ctx.flow.teamRuns(invocation.agent.session.id).find(run=>run.intent_id===intentId);
        await ctx.flow.createTeam(invocation.agent.session.id,intentId,{
          objective,
          ...(invocation.agent.session.header.cwd===undefined?{}:{workspace:invocation.agent.session.header.cwd}),
        },priorRun?.model??mainModel(ctx,invocation.agent.session));
        invocation.signal.throwIfAborted();
        const delivered=history.events.some(event=>event.type==='user/message'&&event.data.id===request.id||event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===request.id));
        if(!delivered)invocation.agent.followup(request);
        return {kind:'success' as const,text:'团队已创建，主会话开始推进任务'};
      })();
      submitting.set(key,{contentKey,promise:task});
      try{return await task;}finally{submitting.delete(key);}
    },
  }), 'dsh-flow: agent-team skill command');
}
