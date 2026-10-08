/** Main-conversation tools; launch authorization comes from the native journal. */
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { strictTool } from './tool-arguments.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from './service.ts';
import { fail } from './errors.ts';
import { integer, validateBudget } from './validation.ts';
import { validateLimits } from './core/protocol.ts';
import { mainModel } from './main-model.ts';
import type { FlowTeamSnapshot } from './types.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A human skill invocation is admitted before any model-created team. */
    'flow/team-launch': { launch_id: string; request: UserMessage }
  }
}

export function teamLaunches(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'flow/team-launch' ? [event.data] : []).reverse();
}

function owner(ctx: Context, agent: Agent | undefined): Agent {
  if (!agent || ctx.flow.isTeamAgentSession(agent.session.id)) fail('仅主会话可管理智能体团队', 403);
  return agent;
}
function runId(ctx: Context, agent: Agent, supplied?: string): string {
  return supplied ?? ctx.flow.teamRuns(agent.session.id)[0]?.id ?? fail('主会话尚未创建团队', 404);
}

/** Summary may be absent before cluster closeout; accepted results remain evidence. */
function executionEvidence(ctx: Context, id: string, transactionId?: string) {
  const snapshot=ctx.flow.read(id,{include_events:false,include_summary:true,limit:32});
  const transaction=transactionId?ctx.flow.queryCluster(id,'transaction',{id:transactionId,full:true}):null;
  return {counts:snapshot.counts,transactions:snapshot.transactions,issues:snapshot.issues,summary:snapshot.summary??null,
    truncated:snapshot.counts.transactions>snapshot.transactions.length,transaction};
}

/** Bounded, abortable polling lives inside a visible main-Agent read call. */
export async function pollTeam(read: () => FlowTeamSnapshot, afterVersion: number | undefined, waitMs: number, signal: AbortSignal): Promise<FlowTeamSnapshot> {
  const deadline = Date.now() + waitMs;
  let team = read();
  while (afterVersion !== undefined && team.run.version <= afterVersion && !['completed', 'failed', 'cancelled', 'blocked', 'waiting_user', 'paused'].includes(team.run.state) && Date.now() < deadline) {
    await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
    signal.throwIfAborted();
    team = read();
  }
  signal.throwIfAborted();
  return team;
}

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const present = (title: string, kind: 'read' | 'execute' = 'execute') => () => ({ card: 'generic' as const, title, kind });

export function registerTeamTools(ctx: Context): void {
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_create',
    description: 'Create this main conversation’s team after evaluating its task. Use launch_id from agent_team_read for the human /agent-team skill invocation. Returns confirmed startup state and effective parameters. Retries of one launch must use identical parameters.',
    parameters: {
      launch_id: { type: 'string', required: true },
      objective: { type: 'string', required: true, description: 'Self-contained objective, including relevant prior context, constraints and delivery location.' },
      assessment: { type: 'object', required: true, additionalProperties: false, properties: {
        complexity: { type: 'string', required: true, enum: ['simple', 'moderate', 'complex'] },
        rationale: { type: 'string', required: true, description: 'Brief reason for this complexity and execution plan.' },
      } },
      acceptance_criteria: { type: 'array', required: true, items: { type: 'string' } },
      workspace: { type: 'string', description: 'Defaults to the main conversation workspace.' },
      capabilities: { type: 'array', items: { type: 'string', enum: ['fs_read', 'fs_write', 'shell', 'web_fetch', 'browser'] } },
      budget: { type: 'json', description: 'Optional overrides: tool_calls, wall_time_ms, agents, max_active_agents. Omitted dimensions inherit deployment defaults.' },
      limits: { type: 'json', description: 'Optional overrides: max_children, max_depth, max_agents, max_active_agents, max_llm_concurrency, max_attempts, max_corrections, max_role_turns, max_tool_calls_per_turn, max_scale_batch.' },
    },
    output, presentCall: present('创建智能体团队'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent);
      const history = await ctx.sessionController.inspect(agent.session.id, exec.signal);
      if (!teamLaunches(history.events).some(launch => launch.launch_id === args.launch_id)) fail('启动意图不属于当前主会话，请先调用 agent_team_read 取得 /agent-team 请求', 403);
      exec.signal.throwIfAborted();
      const startWorkspace = args.workspace ?? agent.session.header.cwd;
      const team = ctx.flow.createTeam(agent.session.id, args.launch_id, {
        objective: args.objective, assessment: args.assessment, acceptance_criteria: args.acceptance_criteria,
        ...(startWorkspace === undefined ? {} : { workspace: startWorkspace }),
        ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
        ...(args.budget === undefined ? {} : { budget: validateBudget(args.budget) }),
        ...(args.limits === undefined ? {} : { limits: validateLimits(args.limits, 'limits') }),
      }, mainModel(ctx, agent.session));
      const { workspace, capabilities, budget, limits } = ctx.flow.read(team.run.id, { include_events: false }).cluster;
      return JSON.stringify({ ...team, run_id: team.run.id, version: team.run.version, parameters: { workspace, capabilities, budget, limits } });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_read',
    description: 'Read this main conversation’s launches, deployment defaults and actual team evidence. Before creation returns launch_id for the skill request. Use run_id or launch_id to disambiguate runs; after_version and wait_ms perform bounded polling (maximum 30000 ms).',
    parameters: { run_id: { type: 'string' }, launch_id: { type: 'string' }, after_version: { type: 'integer' }, wait_ms: { type: 'integer' }, transaction_id: {type:'string',description:'Optional result and independent validation detail; use when the cluster summary is still absent.'} },
    output, presentCall: present('读取团队状态', 'read'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent);
      const wait = integer(args.wait_ms ?? 0, 0, 30000, 'wait_ms');
      const after = args.after_version === undefined ? undefined : integer(args.after_version, 0, Number.MAX_SAFE_INTEGER, 'after_version');
      const history = await ctx.sessionController.inspect(agent.session.id, exec.signal);
      const launches = teamLaunches(history.events).slice(0, 5).map(launch => ({
        launch_id: launch.launch_id,
        objective: launch.request.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      }));
      const runs = ctx.flow.teamRuns(agent.session.id);
      const id = args.run_id ?? (args.launch_id ? runs.find(run => run.launch_id === args.launch_id)?.id : runs[0]?.id);
      if (!id) {
        if (args.launch_id && !launches.some(launch => launch.launch_id === args.launch_id)) fail('启动意图不属于当前主会话', 404);
        return JSON.stringify({ run: null, runs, launches, defaults: ctx.flow.teamStartDefaults() ?? null });
      }
      const team = await pollTeam(() => ctx.flow.teamRead(agent.session.id, id), after, wait, exec.signal);
      const { workspace, capabilities, budget, limits } = ctx.flow.read(id, { include_events: false }).cluster;
      return JSON.stringify({ ...team, run_id: id, version: team.run.version, runs, launches, defaults: ctx.flow.teamStartDefaults() ?? null, parameters: { workspace, capabilities, budget, limits }, execution: executionEvidence(ctx,id,args.transaction_id) });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_message', description: 'Send the main Agent’s self-contained instruction or human answer to an owned live team, then read state to confirm. Progress questions can be answered with agent_team_read.',
    parameters: { run_id: { type: 'string' }, text: { type: 'string', required: true } },
    output, presentCall: present('发送团队指令'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent), id = runId(ctx, agent, args.run_id);
      if (!args.text.trim()) fail('团队指令不能为空', 400);
      ctx.flow.teamRead(agent.session.id, id);
      ctx.flow.teamReply(agent.session.id, exec.callId, args.text, id);
      return JSON.stringify(ctx.flow.teamRead(agent.session.id, id));
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_control', description: 'Carry out the human’s explicit pause, resume or cancel instruction on an owned team. Read and report the confirmed state afterwards.',
    parameters: { run_id: { type: 'string' }, action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel'] } },
    output, presentCall: present('调整团队运行'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent), id = runId(ctx, agent, args.run_id);
      ctx.flow.teamRead(agent.session.id, id);
      ctx.flow.control(id, args.action);
      return JSON.stringify(ctx.flow.teamRead(agent.session.id, id));
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'agent_team_finalize', description: 'Release resources of an owned completed, failed or cancelled team after reading its result. Retains sessions, communications, audit evidence and results. Idempotent; refuses live teams or turns still exiting.',
    parameters: { run_id: { type: 'string', required: true } },
    output, presentCall: present('完成团队收尾'),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const agent = owner(ctx, exec.agent);
      return JSON.stringify(ctx.flow.finalizeTeam(agent.session.id, args.run_id));
    },
  })));
}
