/**
 * The user-facing cluster tools.
 *
 * A separate, composable plugin, because a deployment chooses whether its
 * Session gets them: the shipped bundle adds this Consumer to the cluster
 * preset's plugin list, so a normal Session in the same profile has no cluster
 * command surface at all.
 *
 * These three tools are a thin front for `ctx.flow`. They read no environment
 * variable, hold no defaults and merge no budget: an omitted field is resolved
 * by the cluster service from the deployment configuration, exactly as it is
 * for a Remote caller. That is what removes the old disagreement where the tool
 * and the authenticated route filled in different interactive envelopes.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type {} from './service.ts';
import type { FlowBudgetInput, FlowLimitsInput } from './types.ts';
import { validateBudget, validateCapabilities } from './validation.ts';
import { validateLimits } from './core/protocol.ts';

/** Cordis identity for the cluster user tools. */
export const name = 'dsh-flow-tools';

/** The cluster service supplies the operations; the tool registry holds them. */
export const inject = ['flow', 'tools'];

/**
 * Register the cluster user tools on the Session that selected the cluster
 * preset.
 * @param ctx - context carrying the cluster service and the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'flow_start',
    description: [
      'Start a hierarchical agent cluster on one objective and return its id and initial state.',
      'The cluster decomposes the objective on a management tree (Orchestrator plans, Allocator grants',
      'identities and budgets, Auditor gates plans and results independently, Workers do the work).',
      'Use this when the user asks for a task to be carried out by the cluster; then report progress',
      'with flow_read and steer it with flow_control.',
    ].join(' '),
    parameters: {
      objective: { type: 'string', required: true, description: 'The objective the cluster must achieve, in the user\'s own terms.' },
      workspace: { type: 'string', description: 'Absolute path of the workspace the cluster may write to. Defaults to the deployment workspace.' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Worker capabilities: fs_read, fs_write, shell, web_fetch, browser.' },
      limits: { type: 'json', description: 'Optional limit overrides (max_children, max_depth, max_agents, max_active_agents, max_llm_concurrency, max_attempts, max_corrections).' },
      budget: { type: 'json', description: 'Optional root budget: tokens, model_requests, tool_calls, wall_time_ms, agents, max_active_agents.' },
      initial_transactions: { type: 'array', items: { type: 'json' }, description: 'Optional fixed transaction plan used as a reproducible control-plane baseline.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria for the implied root transaction.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      // The service merges the deployment envelope under whatever the caller
      // sent, per field: a model that passes `budget: {}` (measured: it did,
      // then cancelled its own cluster as "blocked with zero token budget") does
      // not get an unfunded cluster, and a caller that names `tokens` keeps its
      // own number.
      const limits: FlowLimitsInput | undefined = args.limits === undefined ? undefined : validateLimits(args.limits, 'limits');
      const budget: FlowBudgetInput | undefined = args.budget === undefined ? undefined : validateBudget(args.budget, 'budget');
      const snapshot = ctx.flow.start({
        objective: args.objective,
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.capabilities === undefined ? {} : { capabilities: validateCapabilities(args.capabilities) }),
        ...(limits === undefined ? {} : { limits }),
        ...(budget === undefined ? {} : { budget }),
        ...(args.initial_transactions === undefined ? {} : { initial_transactions: args.initial_transactions }),
        ...(args.acceptance_criteria === undefined ? {} : { acceptance_criteria: args.acceptance_criteria }),
      });
      return JSON.stringify({ cluster_id: snapshot.cluster.id, status: snapshot.cluster.status, counts: snapshot.counts });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'flow_read',
    description: 'Read one cluster: state, counts, transactions, budgets, issues and recent events.',
    parameters: {
      id: { type: 'string', required: true },
      include_events: { type: 'boolean' },
      event_limit: { type: 'number' },
      since: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return JSON.stringify(ctx.flow.read(args.id, {
        include_events: args.include_events !== false,
        ...(args.event_limit === undefined ? {} : { event_limit: args.event_limit }),
        ...(args.since === undefined ? {} : { since: args.since }),
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'flow_control',
    description: 'Control a running cluster: pause (stop dispatching new work), resume, or cancel (fence and abort the whole subtree).',
    parameters: {
      id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel'] },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const snapshot = ctx.flow.control(args.id, args.action);
      return JSON.stringify({ cluster_id: args.id, action: args.action, status: snapshot.cluster.status, counts: snapshot.counts });
    },
  }));
}