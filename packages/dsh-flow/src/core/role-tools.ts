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
import { strictTool } from '../tool-arguments.ts';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

import { fail } from '../errors.ts';
import type { FlowAgentActor } from './model.ts';
import type { FlowAgentRole } from '../types.ts';
import type { ClusterRuntime } from './cluster.ts';
import { ROLE_TOOL, commandIdFor, ORCHESTRATOR_ACTIONS, ALLOCATOR_ACTIONS, AUDITOR_ACTIONS, WORKER_ACTIONS } from './protocol.ts';
import { COMMUNICATION_ACTIONS } from './communication.ts';
import { COMMUNICATION_CATEGORIES } from '../messages.ts';

/** What each role command does, in the model's own terms. */
const ROLE_TOOL_DESCRIPTIONS: Record<string, string> = {
  flow_transaction:
    'Orchestrator: plan, decompose, dispatch, validate and aggregate. '
    + 'Worker: only submit_result for the transaction allocated to you; no planning or delegation actions.',
  flow_allocation:
    'Allocator control: agent identity, write scopes, tool-call and capacity budgets, Agent scheduling concurrency and scaling inside your own management domain.',
  flow_audit:
    'Auditor: independently review the Orchestrator\'s planning and actual validation behavior; record compliance decisions and correction requests inside your management domain. Business validation remains the Orchestrator\'s responsibility.',
};

const PLAN_PARAMETERS = 'plan: {understanding, execution: "worker"|"management"|"decompose", rationale, assignment, '
  + 'criterion_responsibilities: [{criterion: {transaction_id: "self", criterion_index: 0}, '
  + 'evidence_provider: "worker"|"orchestrator"|child_key, validated_by: "orchestrator", applies_to: ["worker"]}], '
  + 'integration?: string, assignment_key?: string}. Cover every formal criterion by its stable reference. '
  + 'Management/decompose plans require integration. applies_to contains actual participant roles (worker, orchestrator, allocator, auditor) or child keys; it declares applicability, not who produces evidence. In a parent decompose plan, evidence_provider must be the exact child key for each delegated criterion, for example {criterion:{transaction_id:"self",criterion_index:0},evidence_provider:"multiply",validated_by:"orchestrator",applies_to:["multiply"]}. Use evidence_provider:"orchestrator" for integration criteria. '
  + 'The child keyed multiply must cover that criterion with {criterion:{transaction_id:"parent",criterion_index:0},evidence_provider:"worker",validated_by:"orchestrator",applies_to:["worker"]}, AND separately cover every one of its own acceptance_criteria using transaction_id:"self". Parent references do not replace child self references. Reference existing criteria using their transaction_id/prepared_revision/criterion_index. '
  + 'In a management plan, use evidence_provider:"orchestrator" for the integrated delivery you will receive, check and hand upward; child_key is only available for children declared in the same atomic decompose call. Do not invent a key for the future delegated domain. '
  + 'A management assignment is addressed to the new child manager that the Allocator will create. State that recipient\'s own business objective, boundaries and remaining downstream work. Do not ask the recipient to create itself or repeat the parent\'s domain-creation action: creation is already performed by the Allocator. Each child manager then prepares its own execution plan. Inherited criteria describe the contribution to the end-to-end delivery; read the actual node and parent relations to distinguish already completed upstream structure from remaining work in your domain. '
  + 'Text instructions explain work; authorization and independent governance remain enforced by the runtime.';

/** Operation arguments live with the tool, leaving role instructions stable. */
function commandParameters(role: FlowAgentRole): string {
  if (role === 'worker') return 'submit_result: {transaction_id, result: actual deliverable and execution evidence}. Read assignment to obtain the bound transaction and current authorization. The result is staged until this native turn finishes successfully.';
  if (role === 'orchestrator') return [
    'Execution types describe actual runtime effects: worker assigns one executor; decompose creates business child transactions in this same management domain, still planned and validated by you; management delegates a transaction through the Allocator to a new management node with its own Orchestrator, Allocator and Auditor. A decompose child does not create an autonomous management domain. Choose management for work requiring a child manager to plan independently, and let the Allocator create that domain from the saved plan.',
    'Use transaction_id from assignment/agenda and expected_transaction_revision from binding.current_revision or a freshly read transaction.revision for mutations. The captured binding.revision and plan_ref.prepared_revision describe older snapshots and are not a current compare-and-swap version. After a conflict read current state and decide again.',
    `dispatch: {transaction_id, expected_transaction_revision, plan?}; an existing valid plan may be reused. Batch: {transactions: [{transaction_id, expected_transaction_revision, plan?}]}. ${PLAN_PARAMETERS}`,
    'decompose: {transaction_id, expected_transaction_revision, plan (execution=decompose), children: [{key, objective, inputs, constraints, expected_output, acceptance_criteria, capabilities?, depends_on?: [child_key|transaction_id], plan}]}. Saves parent and child plans atomically; prepared children remain DRAFT until dispatched. Every child needs an executable worker/management plan or its own further decomposition. Keep parent integration in the parent plan.integration with evidence_provider:"orchestrator"; do not create an empty decompose child just for integration. A child criterion can use transaction_id:"parent" without a revision, or the actual parent ID without a revision inside this atomic call; do not guess the new prepared revision.',
    'adjust_transaction: {transaction_id, expected_transaction_revision, objective?, inputs?, constraints?, expected_output?, acceptance_criteria?, plan?}. Read current state after a conflict and explicitly revise; business changes invalidate the old plan.',
    'validate: {transaction_id, expected_transaction_revision, accepted, checks: [{criterion_ref: {transaction_id, prepared_revision, criterion_index}, criterion, method, observation, passed, evidence, evidence_refs: [{kind: "result", ref: current_result_ref}]}], notes?, plan_ref?, result_ref?}. Perform actual checks against all formal criteria; a positive proposal must cover each one with passing findings and evidence. Read transaction fields requirements/plan/result/validation for references. Validation is independently audited before acceptance.',
    'Describe the checks you actually performed. An explicit plain-text calculation can be a business check; a claimed tool-based check must correspond to a real tool call and result. Read evidence for native tool receipts and name their call IDs in check.evidence alongside the result reference. Supported evidence_refs kinds are result, historical_result, effect and source. result must identify the current publication. historical_result may identify an earlier publication of this same task only when its exact ref was explicitly preserved in the current formal plan inputs, for example a rejected candidate referenced by a correction task; read it with transaction {id, result_ref, fields:["result"]}. Historical evidence does not replace the current result or validation binding. Effects records cover external side effects; pure tools such as flow_sum do not create side effects and must not be labeled as effect evidence.',
    'aggregate: {transaction_id, summary?}; accepted child deliverables are required. accept_result: {transaction_id}; requires a passing current validation, matching compliant audit and completed children. reject_result: {transaction_id, reason}; use when the business deliverable is wrong. Audit rejection of your checking calls for a new validate using the preserved result.',
    'create_transaction: {objective, inputs?, constraints?, expected_output, acceptance_criteria, capabilities?}. set_dependency: {transaction_id, expected_transaction_revision, depends_on}. set_priority: {transaction_id, priority}. pause_transaction/resume_transaction/cancel_transaction: {transaction_id, reason?}. request_user: {question, transaction_id?}. finish_cluster: {summary?}. escalate: {reason, transaction_id?}.',
  ].join('\n');
  if (role === 'allocator') return [
    'allocate_agent/spawn_agent: {transaction_id, capabilities?, write_scope?, budget?}; only a READY worker plan permits a worker allocation. The execution type is fixed by the saved manager plan.',
    'spawn_management_node: {transaction_id, plan_ref, assignment_key?, capabilities?, max_children?, budget?}; only a READY management plan permits delegation. The child objective is the saved assignment; retries reuse the same delegation.',
    'release_agent: {agent_id} or {all:true,node_id?} to release all eligible members of a draining domain. replace_agent/reassign_agent: {agent_id, transaction_id?}; require a safe lease/turn boundary. allocate_budget/rebalance_budget: read budgets for scope and available dimensions. select_model: {agent_id, model}. set_concurrency: {max_active_agents?, max_llm_concurrency?}. Read allocation/budget details as needed; retain work and evidence while releasing resources.',
  ].join('\n');
  return [
    'inspect_plan/inspect_validation: {audit_id, decision: "approve"|"reject", evidence: {checks: [{rule, method, observation, passed, evidence_refs: [{kind: "plan"|"validation", ref: audit.plan_ref|audit.validation_ref}]}], issues?: [string], notes?: string}, required_change?}. Cover every governance rule. Plan rules: goal_coverage, responsibility, dependencies, handoff, acceptance_arrangement. Validation rules: standard_coverage, checks_performed, evidence_applicability, conclusion_support, authority. Approval requires all checks passed; rejection identifies a failed check and required correction. Read the audit, bound immutable plan/validation and relevant execution evidence. Approval asserts compliance of the manager\'s behavior, rather than substituting your own business checks.',
    'Reject insufficient validation with a precise required_change: the runtime returns the preserved result to SUBMITTED for the Orchestrator to revalidate. Inspect the replacement validation before closing its issue.',
    'Validation ordering: the Orchestrator first records actual business checks and its acceptance proposal; you then audit that immutable validation; only then may the runtime accept it. Do not demand your own not-yet-issued approval of this same proposal as evidence required to create the proposal. Already audited child deliverables can be evidence for a parent integration check. Every accepted proposal still requires its own matching independent audit.',
    'Read native tool call/result receipts through the object evidence projection when reviewing a claimed tool-based check. effects/effect records track external side effects, so an empty effects list does not mean that pure tools such as flow_sum were never called. A Worker reporting manual calculation does not rule out a later tool-based check by its Orchestrator; check the actual actor and call/result. Plain-text reasoning can support a check when its actual steps are recorded truthfully.',
    'Interpret plan fields correctly: criterion_responsibilities.validated_by is always orchestrator, because it names business validation; your independent audit is a separate record and must not replace that field. Child plans retain inherited parent criterion references alongside their own self criteria. child_transaction_ids is an immutable runtime-owned snapshot populated by atomic decomposition, not a list managers can edit. A management plan keeps its initial empty list even after Allocator creates a delegated domain; query transactions with {parent_id:transaction_id} or nodes to inspect actual delegation. Review the planned handoff and acceptance arrangement without demanding that future allocation or execution already be completed at plan-review time.',
    'request_replan/request_revalidation/request_correction: {transaction_id, reason, required_change?, evidence?}. verify_correction: {issue_id, decision: "CORRECTED"|"REJECTED"|"DISMISSED", evidence}; correction closure requires a matching new audited validation or actual repair evidence. notify/recommend/escalate: record actual observations and reasons; query the corresponding agenda/audit/issue for operation references.',
    'evaluate_health: {dimensions: {metric: score}, weights?: {metric: weight}, evaluation_window?: "subtree-close", evidence?}. Scores are in [0,1]; weights sum to 1. Read health for measured signals and metric names. For a closeout agenda item, score all eight dimensions and use evaluation_window: "subtree-close" so the domain can finish.',
  ].join('\n');
}

/**
 * Register this role's own tools on its agent Context.
 * @param agentCtx - the cluster agent's Context, created for this turn.
 * @param runtime - the cluster runtime the tools command.
 * @param role - the role whose tools to register.
 */
export function registerRoleTools(agentCtx: Context, runtime: ClusterRuntime, role: FlowAgentRole): void {
  const roleTool = ROLE_TOOL[role];
  if (roleTool === undefined) fail(`Unknown role: ${String(role)}`, 403);
  registerCommandTool(agentCtx, runtime, roleTool, role);
  registerCommunicationTool(agentCtx, runtime);
  registerQueryTool(agentCtx, runtime);
  registerSumTool(agentCtx);
}

/** The role's command surface: one action plus the parameters it consumes. */
function registerCommandTool(agentCtx: Context, runtime: ClusterRuntime, toolName: string, role: FlowAgentRole): void {
  const actions = role === 'worker' ? WORKER_ACTIONS : role === 'orchestrator' ? ORCHESTRATOR_ACTIONS
    : role === 'allocator' ? ALLOCATOR_ACTIONS : AUDITOR_ACTIONS;
  agentCtx.tools.register(strictTool(defineTool({
    name: toolName,
    description: ROLE_TOOL_DESCRIPTIONS[toolName] ?? 'Cluster command surface.',
    parameters: {
      action: { type: 'string', required: true, enum: [...actions], description: 'The authorized action to perform.' },
      params: { type: 'json', description: commandParameters(role) },
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
  })));
}

/** Cluster messaging, groups and the blackboard. */
function registerCommunicationTool(agentCtx: Context, runtime: ClusterRuntime): void {
  agentCtx.tools.register(strictTool(defineTool({
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
  })));
}

/** The read-only, domain-scoped view of the cluster. */
function registerQueryTool(agentCtx: Context, runtime: ClusterRuntime): void {
  agentCtx.tools.register(strictTool(defineTool({
    name: 'flow_query',
    description: 'Read bound work and domain-scoped evidence. assignment returns this native turn\'s actual work object and binding (references, revision and staleness), without requiring IDs in prose. agenda {limit, snapshot_id?, offset?} lists role-specific work; retain snapshot_id when reading later pages. transaction/audit/issue/effect use {id, fields?}; fields are per-object allowlists, omitted fields remain present in the authoritative contract. Read requirements, plan, result and validation to obtain immutable criterion, result and validation references. Read fields:["evidence"] for native_tools call/result references; follow the returned read.params, including native_session_id and native_call_id, to read the actual receipt. Native receipts describe actual actor and turn, not business correctness. effects/effect covers external side effects and excludes pure calls such as flow_sum. Evidence and large inputs expose explicit references and continuation instead of truncating formal constraints. Other reads: cluster, nodes, node, transactions, agents, allocations, budgets, issues, audits, effects, usage, deliveries, context, health, summary, blackboard. context retains its native host context/compaction meaning. Read-only results never grant permission or replace actor identity.',
    parameters: {
      what: { type: 'string', required: true },
      params: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const actor = actorFor(runtime, exec, { requireLease: args.what === 'assignment' });
      return JSON.stringify(runtime.query(actor, args.what, coerceParams(args.params)));
    },
  })));
}

/** The deterministic local helper the acceptance fixtures assert on. */
function registerSumTool(agentCtx: Context): void {
  agentCtx.tools.register(strictTool(defineTool({
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
  })));
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
