/** Main-conversation conveniences over the same collaboration service as members. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from './service.ts';
import { strictTool } from './tool-arguments.ts';
import { fail } from './errors.ts';
import { mainModel } from './main-model.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'flow/team-intent': { intent_id: string; request: UserMessage } }
}
export function teamIntents(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'flow/team-intent' ? [event.data] : []).reverse();
}
function owner(ctx: Context, agent: Agent | undefined): Agent {
  if (!agent || ctx.flow.isTeamAgentSession(agent.session.id)) fail('仅主会话可使用团队入口工具', 403);
  return agent;
}
function teamId(ctx: Context, agent: Agent, supplied?: string): string {
  return supplied ?? ctx.flow.teamRuns(agent.session.id)[0]?.id ?? fail('主会话尚未创建团队', 404);
}
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const present = (title: string, kind: 'read' | 'execute' = 'execute') => () => ({ card: 'generic' as const, title, kind });

export function registerTeamTools(ctx: Context): void {
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_create',
    description: 'Create a team for this conversation’s explicit /agent-team intent; read intent_id first. Identical retries are idempotent. The root task belongs to this main Agent; flow_task creates members only for independent business subtasks with explicit artifacts and ownership. Keep integration here and avoid duplicating members’ full work or writing their files concurrently. The requester verifies existing deliverables with native tools against agreed criteria, without creating a reviewer merely for separation or adding source-count requirements. Further delegation remains available for real business needs. Continue independent work or return naturally for result messages; use flow_review for child results, then flow_result and flow_review for the root.',
    parameters: {
      intent_id: { type: 'string', required: true },
      objective: { type: 'string', required: true, description: 'Self-contained task, user constraints and delivery requirements.' },
      title: { type: 'string' }, workspace: { type: 'string' }, preset: { type: 'string' },
      criteria: { type: 'array', items: { type: 'string' } },
      deadline_ms: { type: 'integer', description: 'Only set when the user explicitly requests a deadline; no default duration.' },
    },
    output, presentCall: present('创建团队'),
    async execute(args, exec) {
      const agent = owner(ctx, exec.agent);
      const history = await ctx.sessionController.inspect(agent.session.id, exec.signal);
      if (!teamIntents(history.events).some(intent => intent.intent_id === args.intent_id)) fail('启动意图不属于当前主会话，请先读取 /agent-team 请求', 403);
      exec.signal.throwIfAborted();
      const workspace = args.workspace ?? agent.session.header.cwd;
      return JSON.stringify(await ctx.flow.createTeam(agent.session.id, args.intent_id, {
        objective: args.objective,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.criteria === undefined ? {} : { criteria: args.criteria }),
        ...(args.deadline_ms === undefined ? {} : { deadline_ms: args.deadline_ms }),
      }, mainModel(ctx, agent.session)));
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_read', description: 'Read current team facts and explicit startup intents from this conversation. Returns members, tasks, concrete results and their acceptance records. Reading never wakes an Agent.',
    parameters: { team_id: { type: 'string' }, intent_id: { type: 'string' } },
    output, presentCall: present('读取团队', 'read'),
    async execute(args, exec) {
      const agent = owner(ctx, exec.agent);
      const history = await ctx.sessionController.inspect(agent.session.id, exec.signal);
      exec.signal.throwIfAborted();
      const allIntents = teamIntents(history.events);
      const intents = allIntents.slice(0, 5);
      const runs = ctx.flow.teamRuns(agent.session.id);
      const id = args.team_id ?? (args.intent_id ? runs.find(run => run.intent_id === args.intent_id)?.id : runs[0]?.id);
      if (!id) {
        if (args.intent_id && !allIntents.some(intent => intent.intent_id === args.intent_id)) fail('启动意图不属于当前主会话', 404);
        return JSON.stringify({ run: null, runs, intents });
      }
      return JSON.stringify({ ...ctx.flow.teamRead(agent.session.id, id), runs, intents });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_message', description: 'Send a self-contained instruction to a specific member of this conversation’s team. A notice records information without waking an idle recipient.',
    parameters: { team_id: { type: 'string' }, to: { type: 'string', required: true }, content: { type: 'string', required: true }, task_id: { type: 'string' }, mode: { type: 'string', enum: ['request', 'notice'] } },
    output, presentCall: present('发送成员消息'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent), id = teamId(ctx, agent, args.team_id);
      ctx.flow.teamRead(agent.session.id, id);
      return JSON.stringify(await ctx.flow.message(agent.session.id, { team_id: id, to: args.to, content: args.content,
        ...(args.task_id === undefined ? {} : { task_id: args.task_id }), ...(args.mode === undefined ? {} : { mode: args.mode }),
      }, exec.callId));
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_control', description: 'Apply an explicit user request to pause, resume or cancel an owned team. Cancellation retains task results and native session history.',
    parameters: { team_id: { type: 'string' }, action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel'] } },
    output, presentCall: present('调整团队运行'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent), id = teamId(ctx, agent, args.team_id);
      ctx.flow.teamRead(agent.session.id, id);
      return JSON.stringify(await ctx.flow.control(agent.session.id, { team_id: id, target: 'team', id, action: args.action }, exec.callId));
    },
  })));
}
