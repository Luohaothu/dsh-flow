/**
 * The agent-scoped cluster tools.
 *
 * A cluster role sees exactly three kinds of tool in its own scope: the one
 * command surface its role owns (`flow_transaction` / `flow_allocation` /
 * `flow_audit`), the shared read-and-talk pair (`flow_query`,
 * `flow_communicate`), and the deterministic `flow_sum` helper the acceptance
 * fixtures use to prove a tool round trip.
 *
 * They are registered on the **agent's** Context during its turn setup, not in
 * the root registry. That is the whole point: a normal Session in the same
 * deployment must not see a role command surface it cannot use, and the tools
 * that a role does use must not be visible as inherited globals.
 *
 * `flow_sum` keeps its current meaning — add a list of finite numbers — because
 * the acceptance suite asserts the native call → result → answer chain on it.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

import { fail } from '../errors.ts';
import type { FlowAgentActor } from './model.ts';
import type { FlowAgentRole } from '../types.ts';
import type { ClusterRuntime } from './cluster.ts';
import { ROLE_TOOL, commandIdFor } from './protocol.ts';
import { COMMUNICATION_ACTIONS } from './communication.ts';
import { COMMUNICATION_CATEGORIES } from '../messages.ts';

/** What each role command does, in the model's own terms. */
const ROLE_TOOL_DESCRIPTIONS: Record<string, string> = {
  flow_transaction:
    'Orchestrator: plan, decompose, dispatch, validate and aggregate. '
    + 'Worker: only submit_result for the transaction allocated to you; no planning or delegation actions.',
  flow_allocation:
    'Allocator control: agent identity, write scopes, budget ledger, concurrency and scaling inside your own management domain.',
  flow_audit:
    'Auditor control: plan supervision, independent result acceptance and durable correction requests inside your own management domain.',
};

/**
 * Register this role's own tools on its agent Context.
 * @param agentCtx - the cluster agent's Context, created for this turn.
 * @param runtime - the cluster runtime the tools command.
 * @param role - the role whose tools to register.
 */
export function registerRoleTools(agentCtx: Context, runtime: ClusterRuntime, role: FlowAgentRole): void {
  const roleTool = ROLE_TOOL[role];
  if (roleTool === undefined) fail(`Unknown role: ${String(role)}`, 403);
  registerCommandTool(agentCtx, runtime, roleTool);
  registerCommunicationTool(agentCtx, runtime);
  registerQueryTool(agentCtx, runtime);
  registerSumTool(agentCtx);
}

/** The role's command surface: one action plus the parameters it consumes. */
function registerCommandTool(agentCtx: Context, runtime: ClusterRuntime, toolName: string): void {
  agentCtx.tools.register(defineTool({
    name: toolName,
    description: ROLE_TOOL_DESCRIPTIONS[toolName] ?? 'Cluster command surface.',
    parameters: {
      action: { type: 'string', required: true, description: 'The action to perform.' },
      params: { type: 'json', description: 'Action parameters.' },
      expected_revision: { type: 'number', description: 'Optional optimistic concurrency check against the cluster revision.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const resolved = coerceParams(args.params);
      const actor = actorFor(runtime, exec);
      runtime.admitFlowCall({ id: actor.agent_id });
      const command_id = commandIdFor({
        session_id: actor.session_id,
        turn_seq: actor.turn_seq,
        tool_call_id: String(exec.callId),
      });
      const outcome = runtime.command(actor, {
        command_id, action: args.action, params: resolved, expected_revision: args.expected_revision,
      });
      // A successful management decision yields so the scheduler can run its
      // recipients before this role reads their state again. Workers continue
      // their task until submit_result.
      if (outcome.deduped !== true
        && (actor.role !== 'worker' || args.action === 'submit_result')) {
        exec.concludeTurn();
      }
      return JSON.stringify({
        ok: true, action: args.action, deduped: outcome.deduped, revision: outcome.revision, result: outcome.result,
      });
    },
  }));
}

/** Cluster messaging, groups and the blackboard. */
function registerCommunicationTool(agentCtx: Context, runtime: ClusterRuntime): void {
  agentCtx.tools.register(defineTool({
    name: 'flow_communicate',
    description: `Cluster communication: send/multicast messages to any agent in the cluster, manage groups, and read or publish blackboard keys. For send/multicast, explicitly choose category: ${COMMUNICATION_CATEGORIES.join(', ')}. Use result_report for outputs/evidence, review_feedback for audit decisions/corrections, progress_update for interim progress, task_instruction for revised requirements/rework, collaboration_request for questions/dependencies, blocker_report for failures/escalation, resource_coordination for budgets/models/tools, discussion for other conversation.`,
    parameters: {
      action: { type: 'string', required: true, enum: [...COMMUNICATION_ACTIONS] },
      params: { type: 'json', description: 'send/multicast: {agent|group|node, category, content, transaction_id?}; group: {operation, name|id, members}; publish: {key, value, expected_revision}; query: {key|prefix}; subscribe: {operation, key|prefix, id}.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      // Read-only queries may run without a turn; every mutation (send,
      // multicast, group, publish, subscribe) is fenced to the captured turn.
      const mutating = args.action !== 'query';
      const actor = actorFor(runtime, exec, { requireLease: mutating });
      if (mutating) runtime.assertActorFence(actor, { mutating: true });
      const result = runtime.communicateFrom(actor, args.action, coerceParams(args.params));
      runtime.wake();
      // A management send yields to the scheduler so the recipient can act.
      // Group-operation deduplication does not suppress direct or multicast sends.
      const deduped = 'deduped' in result && result.deduped === true;
      if (actor.role !== 'worker' && (args.action === 'send' || args.action === 'multicast') && !deduped) {
        exec.concludeTurn();
      }
      return JSON.stringify({ ok: true, action: args.action, result });
    },
  }));
}

/** The read-only, domain-scoped view of the cluster. */
function registerQueryTool(agentCtx: Context, runtime: ClusterRuntime): void {
  agentCtx.tools.register(defineTool({
    name: 'flow_query',
    description: 'Read-only cluster state scoped to your domain: cluster, nodes, node, transactions, transaction, agents, allocations, budgets, issues, issue, audits, audit, effects, effect, usage, summary, blackboard. Lists are paged references; transactions {parent_id} filters delegated children. Transaction {id} includes its current result and validation; aggregate child results and historical audit/issue evidence are referenced by id. Read the child transaction {id}, audit {id}, issue {id}, or effect {call_id} for complete evidence.',
    parameters: {
      what: { type: 'string', required: true },
      params: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const actor = actorFor(runtime, exec, { requireLease: false });
      return JSON.stringify(runtime.query(actor, args.what, coerceParams(args.params)));
    },
  }));
}

/** The deterministic local helper the acceptance fixtures assert on. */
function registerSumTool(agentCtx: Context): void {
  agentCtx.tools.register(defineTool({
    name: 'flow_sum',
    description: 'Add a list of finite numbers. Deterministic local tool used to verify the host tool-call round trip.',
    parameters: { values: { type: 'array', items: { type: 'number' }, required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!Array.isArray(args.values) || args.values.some(value => !Number.isFinite(value))) {
        fail('values must be finite numbers');
      }
      return args.values.reduce((total, value) => total + value, 0);
    },
  }));
}

/**
 * `params` is an open JSON parameter, so a model may legitimately send it as a
 * JSON string; accept that spelling instead of failing the call.
 * @param value - the raw parameter value.
 * @returns the decoded parameter object.
 */
export function coerceParams(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      fail(`flow tool params is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('flow tool params must decode to a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof value !== 'object' || Array.isArray(value)) fail('flow tool params must be a JSON object');
  return value as Record<string, unknown>;
}

/**
 * Resolve the acting identity from the executing agent, never from the model's
 * parameters.
 *
 * The actor is the *turn's* captured identity, never the lease that happens to
 * be live now: borrowing a newer epoch is exactly how a zombie turn would pass
 * fencing.
 * @param runtime - the cluster runtime.
 * @param exec - the tool execution the call arrived on.
 * @param options - `requireLease` refuses a call with no scheduled turn.
 * @returns the actor for this call.
 */
export function actorFor(
  runtime: ClusterRuntime,
  exec: ToolRunContext,
  { requireLease = true }: { requireLease?: boolean } = {},
): FlowAgentActor {
  const sessionId = exec.agent?.id;
  if (!sessionId) fail('flow tool requires an executing agent identity', 403);
  const agent = runtime.store.getAgentBySession(String(sessionId));
  if (!agent) fail('this session is not a cluster agent', 403);
  const turn = runtime.turnActor(exec.agent);
  if (requireLease) {
    if (!turn) fail('this agent instance does not own a scheduled cluster turn', 409);
    if (turn.agent_id !== agent.id) fail('this turn identity belongs to another agent', 409);
  }
  return {
    role: agent.role,
    cluster_id: agent.cluster_id,
    agent_id: agent.id,
    node_id: agent.node_id,
    session_id: agent.session_id,
    ...(turn === null || turn === undefined ? {} : { epoch: turn.epoch }),
    turn_seq: turn?.turn_seq ?? agent.turns + 1,
  };
}
