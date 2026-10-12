/** Slash command and ordinary main-session follow-up, using the host command registry. */
import type { Context } from '@deepseek-ai/cordis';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { readFileSync } from 'node:fs';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-skill';
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill';
import { registerTeamTools, teamIntents } from './team-tools.ts';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from './service.ts';
import { fail } from './errors.ts';

export const name = 'dsh-flow-agent-team-command';
export const inject = ['commands', 'flow', 'sessions', 'sessionController', 'tools', 'sessionProjections', 'agentDefaultModel', 'agents', 'systemPrompt', 'skills'];
export { mainModel } from './main-model.ts';

/** Register one human command; no preset or alternate composer is installed. */
export function apply(ctx: Context): void {
  // The host main Agent owns human dialogue; the team's execution sessions keep
  // their own journals. Never copy engine messages into the human conversation.
  ctx.systemPrompt.section({
    name:'dsh-flow:main-coordinator',order:ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),interpolate:false,
    text:({agent})=>agent&&ctx.flow.teamRuns(agent.session.id).some(run=>run.state==='running'||run.state==='paused')?[
      '团队根任务已归当前主会话执行；创建团队不会另启根任务成员。你负责直接完成工作、按需委派普通成员，并汇总交付。',
      '只委派独立的业务部分，明确产物路径和负责范围；你保留整合与核验责任，避免与成员重复执行完整目标或同时写同一文件。',
      '通过 agent_team_read 核对成员、任务、结果和接受记录，以实际证据回答进度问题。',
      '团队指令或用户答复通过 agent_team_message 发给具体成员。业务任务与结果使用 flow_task、flow_result、flow_review；接受针对具体结果版本。',
      '委派返回任务和成员身份后，继续不依赖该结果的工作；若只剩等待，自然结束当前回合，真实结果消息会唤醒你继续验收。不要为等待成员启动 shell 轮询或阻塞等待进程。',
      '由委派者亲自用原生工具核验已有交付，按用户要求和任务已有完成条件接受结果；不为形式独立另启评审 Agent 或自行增加来源数量门槛。真实业务需要时仍可递归委派。',
      '接受必要子任务后，汇总和检查最终产物，用 flow_result 提交根任务，再用 flow_review 接受该具体根结果，最后向用户交付。',
      '只有用户明确要求暂停、恢复或取消时，才调用 agent_team_control。终态已自动清理执行资源，无需额外收尾工具；向用户输出普通对话正文。',
    ].join('\n'):'',
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
    input: { hint: '请描述希望团队完成的任务' },
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
        const delivered=history.events.some(event=>event.type==='user/message'&&event.data.id===request.id||event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===request.id));
        if(!delivered)invocation.agent.followup(request);
        return {kind:'success' as const,text:'已提交团队需求，主会话将评估并创建团队'};
      })();
      submitting.set(key,{contentKey,promise:task});
      try{return await task;}finally{submitting.delete(key);}
    },
  }), 'dsh-flow: agent-team skill command');
  registerTeamTools(ctx);
}
