import { agentSession, promptAgent, startTeam, createTeam, finalizeTeam, teamRuns, readTeam, replyTeam } from './team.ts';
/**
 * ClusterRuntime: the control loop, scheduler, and command surface of the
 * hierarchical agent cluster.
 *
 * Every durable mutation runs through `ClusterStore` in one SQLite
 * transaction (state + command receipt + events together). Model turns are
 * scheduled, never awaited from inside a transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { COMMUNICATION_LABELS, DELIVERY_MARKER, NOTIFICATION_LABELS, communicationBody, communicationCategory, communicationContent, communicationHeadline, notificationCategory, notificationHeadline, notificationTone } from '../messages.ts';
import { agentGivenName, ROLE_LABELS } from '../identity.ts';
import type { SQLOutputValue } from 'node:sqlite';

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { JobId } from '@deepseek-ai/dsh-jobs';
import type { JobRegistry } from '@deepseek-ai/dsh-jobs';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
export type FlowPersistenceSeam = Pick<SessionPersistence, 'stat' | 'open'>;
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
// Type-only: brings the `ctx.tools` service declaration into this program so the
// root registry's schema list is a typed read rather than an unchecked lookup.
import type {} from '@deepseek-ai/dsh-tools';
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { registerRoleTools } from './role-tools.ts';
import { prepareModelSelection } from './model-selection.ts';

import { ClusterStore, decodeJson } from './store.ts';
import type { CommandApplyResult } from './store.ts';
import { fail, messageOf } from '../errors.ts';
import { integer, isFlowJsonValue, normalizeLimit, objectField, textField, validateCapabilities } from '../validation.ts';
import {
  AGENT_TERMINAL, CAPABILITY_PACKAGES, DEFAULT_CONTEXT_LIMITS, DEFAULT_LIMITS, ROLE_TOOL, TRANSACTION_TERMINAL,
  authorize, roleAllows, toolsForCapabilities, validateSpec, validateText, MANAGEMENT_ROLES,
} from './protocol.ts';
import { resolveStartRequest } from '../config.ts';
import {
  BudgetError, createBudget, dimensionAvailable, effectiveDeadline, evaluateTree,
  reserveChain, rollupBudgets, settleChain, transferBudget,
} from './budget.ts';
import { communicate } from './communication.ts';
import type { CommunicationActor, CommunicationResult } from './communication.ts';
import { checkWriteAccess, canonicalScopeEntry } from './scope.ts';
import { createToolExecutionHook, runTurn, effectTool, sessionOffset, settleLlmRequest } from './runtime.ts';
import type {
  BudgetBlockFacts, BudgetChainRequest, BudgetRefusalFacts, LedgerAmounts, ToolAdmission, TurnOutcome,
} from './runtime.ts';
import { HANDLERS, setTransactionStatus, writeNodeSummary } from './actions.ts';
import type { ActionName } from './actions.ts';

import type { FlowService } from '../service.ts';
import type { FlowStartInternals } from './model.ts';
import type {
  FlowAgentRecord, FlowAgentReference, FlowAgentRole, FlowAllocationRecord, FlowCapability, FlowClusterAgentsQueryData,
  FlowClusterAllocationsQueryData, FlowClusterAuditQueryData, FlowClusterAuditsQueryData,
  FlowClusterBlackboardQueryData, FlowClusterBudgetsQueryData, FlowClusterContextQueryData,
  FlowClusterDeliveriesQueryData, FlowClusterEffectQueryData, FlowClusterEffectsQueryData,
  FlowClusterHealthQueryData, FlowClusterIssueQueryData, FlowClusterIssuesQueryData,
  FlowClusterNodeQueryData, FlowClusterNodesQueryData, FlowClusterQueryData, FlowClusterStatus,
  FlowClusterSummaryQueryData, FlowClusterTransactionQueryData,
  FlowClusterTransactionsQueryData, FlowClusterUsageQueryData,
  FlowControlAction, FlowCounts, FlowEventQuery,
  FlowEventsResult, FlowHealthSignals, FlowJsonValue,
  FlowBudgetInput, FlowIssueStatus, FlowLimits, FlowListQuery, FlowListResult, FlowNodeAncestor, FlowNodeKind, FlowNodeRecord, FlowNodeReference,
  FlowQueryKind, FlowQueryParams, FlowQueryResult, FlowReadQuery, FlowReport, FlowSnapshot, FlowStartRequest, FlowSummary, FlowTransactionStatus, FlowUsageSummary,
  FlowTransactionRecord, FlowTransactionReference, FlowTeamCreateRequest,
} from '../types.ts';
import type {
  AgentRecord, AllocationRecord, AuditRecord, BudgetRecord, ClusterRecord,
  DelegationFixtureEntry, FlowActor, FlowAgentActor, FlowCommand, FlowCommandOutcome,
  FlowLogger, FlowModelSelection, FlowRuntimeConfig, FlowUserActor, InboxRecord, IssueRecord, LeaseRecord,
  MessageFixtureEntry, NodeRecord, ResolvedRuntimeConfig, TransactionRecord, TurnIdentity, UsageReceiptRecord,
} from './model.ts';

/**
 * Inbox subjects a role must act on, ordered by importance: these sort into the
 * page a role actually sees, so an informational row cannot hide one of them.
 */
const INBOX_PRIORITY_SUBJECTS = [
  // Human and peer messages, and the notices that say a role's own work is
  // blocked, ahead of the informational ones.
  'message', 'escalation', 'agent-anomaly', 'transaction-stale', 'result-withheld',
  'context-pressure', 'context-pressure-notice', 'issue-opened', 'plan-audit-requested',
  'validation-audit-requested', 'result-submitted', 'child-blocked',
];

export const MUTATING_EFFECT_TOOLS = new Set(['write', 'edit', 'bash', 'job_kill']);
const INCOMPLETE_WORKER_RESULT = /^(?:blocked|failed|incomplete)(?:[_-]|$)/i;

/** The eight health dimensions scored by the Auditor. */
export const HEALTH_METRICS = [
  'transaction_coverage',
  'decomposition_quality',
  'responsiveness',
  'planning_stability',
  'goal_alignment',
  'acceptance_quality',
  'result_integration',
  'escalation_quality',
];
const CLUSTER_EVENTS_SKIP_PROGRESS = new Set([
  'turn-start', 'turn-end', 'lease-heartbeat', 'inbox-created',
  // Scheduling bookkeeping is not a state change: a role that only consumed a
  // notification must not look like it made progress, or it can never be
  // recognised as stagnant.
  'turn-actions', 'load-changed', 'transaction-stale',
  // Metering, context management and refusals do not count as state changes.
  // Otherwise a role that only queries or repeats rejected actions could evade
  // the stagnation guard merely by spending requests and tool calls.
  'context-step', 'llm-slot', 'tool-call-charged', 'tool-call-released', 'tool-call-refused',
  'usage-reconciled', 'budget-topup', 'budget-refused', 'budget-shortfall', 'budget-grandtotal',
  'agent-anomaly', 'turn-start-failed', 'inbox-reopened', 'delivery-unknown',
  // Stop and fencing events do not establish productive work by a role.
  'node-blocked', 'cluster-blocked', 'agent-blocked', 'lease-fenced',
  'turn-aborted', 'turn-fenced', 'transaction-stranded',
]);

/**
 * Notifications ride with a role's next structural decision. Only an event
 * the idle role can independently resolve should start a management turn:
 * stale READY work belongs to the Allocator, and a budget refusal is handled
 * by the funder after a concrete blocked-request envelope is recorded.
 */
const CRITICAL_NOTIFICATION_SUBJECTS = new Set([
  'agent-anomaly',
  'child-blocked', 'issue-opened', 'result-withheld', 'delivery-unknown',
  'escalation', 'context-pressure',
  // Addressed messages and subscribed blackboard changes are pending work
  // that must wake their recipient.
  'message', 'blackboard',
]);

const ROLE_INSTRUCTIONS = {
  orchestrator: [
    'You are the Orchestrator of one management node in a hierarchical agent cluster.',
    'You own planning, decomposition, dispatch, validation and aggregation for the transactions in your domain.',
    'Actions available through the flow_transaction tool:',
    '  create_transaction, decompose, set_dependency, set_priority, dispatch, adjust_transaction, validate, accept_result, reject_result, aggregate, escalate, finish_cluster, request_user.',
    'Rules:',
    '- Write acceptance_criteria that a third party can check against concrete evidence (files, command exit codes, sources).',
    '- dispatch makes the transaction ready for allocation itself and *also* requests an independent plan audit of that exact revision. The audit is supervision: if the Auditor never decides, your work still runs. If it rejects, the transaction returns to DRAFT and its dependents pause until you answer the issue with adjust_transaction (a new revision is what clears the rejection).',
    '- A rejected result needs a correction to the actual plan fields, not just explanatory prose: if inputs.write_scope excludes a required output, adjust_transaction with inputs.write_scope covering that output, retain the acceptance criteria and expected output assigned by the parent, then dispatch for a fresh allocation. Do not claim the original criterion was superseded by changing objective text.',
    '- validate must compare the submitted result against the acceptance criteria of the recorded result revision; the Auditor then approves or rejects it independently.',
    '- Never declare your own result accepted: worker results become SUBMITTED, and only an auditor decision turns a validation into ACCEPTED.',
    '- aggregate a parent only after every child transaction is ACCEPTED.',
    '- When information from the human is required, call request_user with params.question. Stop after the question; wait for a main-conversation reply. For an unresolvable execution conflict use escalate with the concrete reason.',
    '- At the root, acceptance of every transaction starts the final cluster-objective turn. Perform remaining post-acceptance work (for example publish the required blackboard result with flow_communicate publish) before calling finish_cluster. Never finish merely because the transaction rows are accepted.',
    'Use flow_query to read the current state of your domain before acting.',
    'Exact shapes (params is a JSON object, never a string):',
    '  dispatch: {"action":"dispatch","params":{"transaction_id":"<tx id>"}} or {"action":"dispatch","params":{"limit":8}} for every DRAFT transaction in your domain',
    '  adjust_transaction (repair a write grant): {"action":"adjust_transaction","params":{"transaction_id":"<tx id>","inputs":{"write_scope":["<required output directory>"]}}}',
    '  decompose: {"action":"decompose","params":{"transaction_id":"<tx id>","children":[{"objective":"...","acceptance_criteria":["..."],"after":[0]}]}}',
    '  validate: {"action":"validate","params":{"transaction_id":"<tx id>","accepted":true,"checks":[{"criterion":"...","passed":true,"evidence":"<tool result, file hash, exit code or source>"}]}}',
    '  create_transaction: {"action":"create_transaction","params":{"objective":"...","acceptance_criteria":["..."],"priority":1}}',
    '  aggregate: {"action":"aggregate","params":{"transaction_id":"<parent tx id>"}}',
    '  finish_cluster: {"action":"finish_cluster","params":{}} — root Orchestrator only, after all required communication and other objective outputs are durable',
  ].join('\n'),
  allocator: [
    'You are the Allocator of one management node in a hierarchical agent cluster.',
    'You own agent identities, write scopes, concurrency and the budget ledger of your domain.',
    'Actions available through the flow_allocation tool:',
    '  allocate_agent, spawn_agent, spawn_management_node, release_agent, allocate_budget, rebalance_budget,',
    '  set_concurrency, scale_out, scale_in, select_model, evaluate_allocation, replace_agent, reassign_agent,',
    '  reparent, checkpoint, restore.',
    'Rules:',
    '- Allocate an agent for every READY transaction in your domain; a READY transaction with no allocation never runs.',
    '- Give disjoint write scopes: one file or directory per agent, never overlapping scopes.',
    '- A transaction input write_scope is an enforced ceiling. If it excludes the required output, an identical replacement grant cannot repair it: tell the Orchestrator to revise the transaction inputs before you allocate again.',
    '- Reserve at least one active slot for the management roles when you set concurrency.',
    '- Move only unused, unreserved budget between scopes; spent budget is never reversible.',
    '- Release agents whose transactions reached a terminal state so their slot and unspent grant return to the node.',
    'Use flow_query to inspect ready transactions, allocations and the budget ledger.',
    'Exact shapes (params is a JSON object, never a string):',
    '  allocate_agent: {"action":"allocate_agent","params":{"transactions":["<tx id>","<tx id>"],"write_scope":["<absolute path>"]}}',
    '  allocate_agent (all ready work): {"action":"allocate_agent","params":{"limit":8}}',
    '  release_agent: {"action":"release_agent","params":{"allocations":["<allocation id>"]}}',
    '  spawn_management_node: {"action":"spawn_management_node","params":{"transaction_id":"<tx id>","scope":{"objective":"..."},"max_children":4,"spawn_children":<levels this child must still delegate>}}',
    '  allocate_budget: {"action":"allocate_budget","params":{"scope":{"kind":"agent","id":"<agent id>"},"amounts":{"tokens":200000,"model_requests":40}}}',
    '  rebalance_budget: {"action":"rebalance_budget","params":{"from":{"kind":"node","id":"<node id>"},"to":{"kind":"node","id":"<node id>"},"amounts":{"model_requests":20}}}',
    '  set_concurrency: {"action":"set_concurrency","params":{"max_active_agents":6,"max_llm_concurrency":2}}',
  ].join('\n'),
  auditor: [
    'You are the Auditor of one management node in a hierarchical agent cluster.',
    'Judge evidence, not prose: approve an exact result revision when the recorded checks name concrete evidence (a tool result, a file hash, a command exit code, a source) for every acceptance criterion.',
    'Do not reject for style, verbosity or because you would have written it differently, and do not demand evidence beyond the recorded criteria. Use flow_query to verify a claim yourself before rejecting it.',
    'You are independent of the Orchestrator. Plan audits are supervision, not a gate: dispatch already made the revision dispatchable, so approving a plan or leaving one undecided neither starts nor stops the work. A rejection interrupts a live plan: it returns to DRAFT and pauses dependents until the Orchestrator answers the issue. A replan of an already ACCEPTED result instead invalidates that result as REJECTED. The result gate decides acceptance: a validation only becomes ACCEPTED through your decision.',
    'Actions available through the flow_audit tool:',
    '  inspect_plan, inspect_validation, request_correction, request_replan, request_revalidation, verify_correction, notify, recommend, evaluate_health, escalate.',
    'Rules:',
    '- inspect_plan decides on the exact transaction revision submitted for audit; approve only if the plan covers the objective, the acceptance criteria are checkable, and the dependencies are coherent.',
    '- inspect_validation decides on an exact result_revision; approve only when the recorded evidence actually satisfies every acceptance criterion. Judge the evidence, not the prose.',
    '- For a Worker write, effect.node_id is the child Worker node, while effect.owner_management_id is its owning management node. Check the settled write path and that owner via flow_query what:"effects"; requiring the Worker agent to live on the management node itself misattributes valid work.',
    '- request_correction / request_replan / request_revalidation create a durable issue with a concrete required change; each issue allows at most two correction rounds.',
    '- verify_correction is a judgement on evidence, not a revision counter: changed does not mean fixed; unchanged does not mean mistaken. Leave a real unresolved issue OPEN for the Orchestrator to repair. Choose "verified" only when a later correction satisfies the recorded criterion; choose "dismissed" only if a re-check contradicts the original claim. Objective prose cannot supersede a still-recorded acceptance criterion. A dismissal needs concrete evidence of what was checked and found.',
    '- If your own issue turns out to be wrong, dismiss it rather than escalating: an escalation for a defect that does not exist stops the domain.',
    '- escalate when corrections are exhausted or the plan cannot be repaired inside this domain.',
    '- When pending_actions includes evaluate_health for subtree-close, judge the eight named metrics against the measured signals; score each as a number from 0 to 1. An undecided request is not a score and the node cannot close until its own Auditor records a scored row.',
    'Use flow_query to read transactions, validations, evidence and issues in your domain.',
    'Exact shapes (params is a JSON object, never a string):',
    '  inspect_plan: {"action":"inspect_plan","params":{"transaction_id":"<tx id>","decision":"approve"}} or decision "reject" with required_change',
    '  inspect_validation: {"action":"inspect_validation","params":{"transaction_id":"<tx id>","decision":"approve","evidence":{"checked":"<what you verified>"}}}',
    '  request_correction: {"action":"request_correction","params":{"transaction_id":"<tx id>","severity":"MAJOR","required_change":"<the concrete missing evidence>"}}',
    '  verify_correction: {"action":"verify_correction","params":{"issue_id":"<issue id>","decision":"verified"}} or, for an issue that turned out to be wrong, {"decision":"dismissed","evidence":{"rechecked":"<what>","found":"<what it showed>"}}',
    '  evaluate_health: action "evaluate_health", params with evaluation_window:"subtree-close" and dimensions mapping all eight pending metric names to your own evidence-based numeric scores in [0,1]; omit weights for equal weighting.',
  ].join('\n'),
};

const WORKER_PROMPT_HEADER = [
  'You are a Worker in a hierarchical agent cluster. Complete exactly one transaction.',
  'Do the work with the tools you have; do not describe work you did not do.',
  'When the transaction is complete, call flow_transaction with action "submit_result" and params',
  '{"transaction_id": "<id>", "result": {...}, "notes": "<short summary>"} where result records the concrete outcome',
  'and evidence (file paths with hashes, command exit codes, sources) a reviewer can check.',
  'If the work cannot be completed, submit a result that states precisely what blocked you instead of inventing success.',
].join('\n');

type LedgerDimension = 'tokens' | 'model_requests' | 'tool_calls';
const LEDGER_DIMENSIONS: readonly LedgerDimension[] = ['tokens', 'model_requests', 'tool_calls'];

function positiveLedgerAmounts(amounts: LedgerAmounts): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of LEDGER_DIMENSIONS) {
    const amount = amounts[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) result[key] = amount;
  }
  return result;
}

function budgetDimensionAmounts(row: BudgetRecord, dimension: LedgerDimension): { limit: number; reserved: number; spent: number } {
  switch (dimension) {
    case 'tokens':
      return { limit: row.tokens_limit, reserved: row.tokens_reserved, spent: row.tokens_spent };
    case 'model_requests':
      return { limit: row.requests_limit, reserved: row.requests_reserved, spent: row.requests_spent };
    case 'tool_calls':
      return { limit: row.tool_calls_limit, reserved: row.tool_calls_reserved, spent: row.tool_calls_spent };
  }
}

// ------------------------------------------------------- wire projections

/** Narrow one node-kind literal read back from a row. */
function nodeKindOf(value: unknown, label: string): FlowNodeKind {
  if (value === 'management' || value === 'worker') return value;
  return fail(`Invalid ${label}: ${String(value)}`);
}

/** A nullable TEXT column: an absent value stays null rather than failing. */
function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return textField(value, label);
}

/** A nullable INTEGER column: an absent value stays null rather than failing. */
function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, -(2 ** 53), 2 ** 53, label);
}

/** One enumerated literal read back from a row. */
function literalOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  for (const candidate of allowed) if (value === candidate) return candidate;
  return fail(`Invalid ${label}: ${String(value)}`);
}

/**
 * A decoded value re-spelled as the wire JSON vocabulary. A JSON column cannot
 * hold `undefined` or a function, so those members are JSON-absent and are
 * skipped exactly as `JSON.stringify` would skip them.
 */
function asJson(value: unknown): FlowJsonValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(item => asJson(item) ?? null);
  if (typeof value === 'object') {
    const out: Record<string, FlowJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = asJson(item);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return undefined;
}

/** A JSON value that must exist, as the wire vocabulary spells it. */
function asJsonValue(value: unknown): FlowJsonValue {
  if (isFlowJsonValue(value)) return value;
  return asJson(value) ?? null;
}

/** The machine-readable code a thrown value may carry, when it carries one. */
function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
}

/** A JSON object value, or null when the value is not one. */
function jsonRecordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

/** One stored summary row as the wire summary, re-read field by field. */
function summaryOfData(clusterId: string, asOfSeq: number, data: FlowJsonValue): FlowSummary {
  const record = jsonRecordOf(data) ?? {};
  const progress = jsonRecordOf(record.transactions);
  const resource = jsonRecordOf(record.resource_state);
  const health = jsonRecordOf(record.management_health);
  const entries = (value: unknown): readonly Record<string, unknown>[] => {
    if (!Array.isArray(value)) return [];
    const result: Record<string, unknown>[] = [];
    for (const item of value) {
      const entry = jsonRecordOf(item);
      if (entry !== null) result.push(entry);
    }
    return result;
  };
  return {
    as_of_seq: asOfSeq,
    cluster_id: clusterId,
    node_id: optionalText(record.node_id, 'summary.node_id'),
    transaction_id: optionalText(record.transaction_id, 'summary.transaction_id'),
    ...(typeof record.objective === 'string' ? { objective: record.objective } : {}),
    ...(progress === null ? {} : {
      transactions: {
        total: optionalInteger(progress.total, 'summary.transactions.total') ?? 0,
        progress: optionalInteger(progress.progress, 'summary.transactions.progress') ?? 0,
        completed: optionalInteger(progress.completed, 'summary.transactions.completed') ?? 0,
        failed: optionalInteger(progress.failed, 'summary.transactions.failed') ?? 0,
      },
    }),
    ...(record.conclusions === undefined ? {} : {
      conclusions: entries(record.conclusions).map(entry => ({
        transaction_id: textField(entry.transaction_id, 'summary.conclusion.transaction_id', 128),
        result: textField(entry.result, 'summary.conclusion.result', 8192),
      })),
    }),
    ...(record.evidence === undefined ? {} : {
      evidence: entries(record.evidence).map(entry => ({
        transaction_id: textField(entry.transaction_id, 'summary.evidence.transaction_id', 128),
        criterion: textField(entry.criterion, 'summary.evidence.criterion', 4096),
        evidence: textField(entry.evidence, 'summary.evidence.evidence', 8192),
      })),
    }),
    ...(record.unresolved_questions === undefined ? {} : {
      unresolved_questions: entries(record.unresolved_questions).map(entry => ({
        issue_id: textField(entry.issue_id, 'summary.question.issue_id', 128),
        transaction_id: optionalText(entry.transaction_id, 'summary.question.transaction_id'),
        required_change: textField(entry.required_change, 'summary.question.required_change', 4096),
      })),
    }),
    ...(resource === null ? {} : {
      resource_state: {
        requests: optionalInteger(resource.requests, 'summary.resource.requests') ?? 0,
        total_tokens: optionalInteger(resource.total_tokens, 'summary.resource.total_tokens') ?? 0,
        prompt_tokens: optionalInteger(resource.prompt_tokens, 'summary.resource.prompt_tokens') ?? 0,
        completion_tokens: optionalInteger(resource.completion_tokens, 'summary.resource.completion_tokens') ?? 0,
        cached_tokens: optionalInteger(resource.cached_tokens, 'summary.resource.cached_tokens') ?? 0,
        reasoning_tokens: optionalInteger(resource.reasoning_tokens, 'summary.resource.reasoning_tokens') ?? 0,
        unknown_requests: optionalInteger(resource.unknown_requests, 'summary.resource.unknown_requests') ?? 0,
        overshoot: optionalInteger(resource.overshoot, 'summary.resource.overshoot') ?? 0,
        api_cost: {
          amount: optionalInteger(jsonRecordOf(resource.api_cost)?.amount, 'summary.resource.amount') ?? 0,
          currency: textField(jsonRecordOf(resource.api_cost)?.currency ?? 'USD', 'summary.resource.currency', 16),
          pricing: textField(jsonRecordOf(resource.api_cost)?.pricing ?? 'unpriced', 'summary.resource.pricing', 64),
        },
      },
    }),
    ...(health === null ? {} : {
      management_health: {
        open_issues: optionalInteger(health.open_issues, 'summary.health.open_issues') ?? 0,
        corrections: optionalInteger(health.corrections, 'summary.health.corrections') ?? 0,
        blocked_nodes: (Array.isArray(health.blocked_nodes) ? health.blocked_nodes : []).map(node => String(node)),
      },
    }),
    // Stored summaries accept status words or numeric 1/0 representations.
    ...(record.confidence === 'high' || record.confidence === 'partial'
      ? { confidence: record.confidence }
      : record.confidence === 1 ? { confidence: 'high' as const }
        : record.confidence === 0 ? { confidence: 'partial' as const } : {}),
    ...(typeof record.note === 'string' ? { note: record.note } : {}),
    ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
  };
}

/** The required status filter as the store's mutable list accepts it. */
function statusFilter(status: string | readonly string[] | undefined): string | string[] | undefined {
  if (typeof status === 'string') return status;
  return Array.isArray(status) ? [...status] : undefined;
}

const AGENT_ROLES = ['orchestrator', 'allocator', 'auditor', 'worker'] as const satisfies readonly FlowAgentRole[];
const AUDIT_KINDS = ['plan', 'validation'] as const;
const AUDIT_DECISIONS = [
  'PENDING', 'APPROVED', 'REJECTED', 'OVERRIDDEN', 'STALE',
  'CORRECTION_REQUESTED', 'REPLAN_REQUESTED', 'REVALIDATION_REQUESTED',
] as const;
const ISSUE_STATUSES = ['OPEN', 'VERIFYING', 'CORRECTED', 'ESCALATED', 'DISMISSED'] as const;
const EFFECT_STATUSES = ['STARTED', 'SETTLED', 'FAILED', 'CANCELLED', 'UNKNOWN', 'EFFECT_UNCERTAIN'] as const;
const DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'ACKED'] as const;

/** The stored JSON columns are already decoded and narrowed by the store, so a
 * record read back can be handed to a caller directly. Only the raw `all()`/`get()`
 * rows still need per-column narrowing, and only the record fields whose value
 * type is an interface need re-spelling as the wire JSON vocabulary. */
function projectNodeRecord(node: NodeRecord): FlowNodeRecord {
  return { ...node, scope: asJsonValue(node.scope) };
}

function projectAgentRecord(agent: AgentRecord): FlowAgentRecord {
  return { ...agent, meta: asJsonValue(agent.meta) };
}

function projectTransactionRecord(tx: TransactionRecord): FlowTransactionRecord {
  return {
    ...tx,
    inputs: asJsonValue(tx.inputs),
    acceptance_criteria: [...tx.acceptance_criteria],
    validation: tx.validation === null ? null : asJsonValue(tx.validation),
  };
}

function projectAllocationRecord(allocation: AllocationRecord): FlowAllocationRecord {
  return {
    ...allocation,
    capabilities: [...allocation.capabilities],
    write_scope: [...allocation.write_scope],
    write_scope_canonical: [...(allocation.write_scope_canonical ?? allocation.write_scope)],
  };
}

/** One live scheduled turn, as the scheduler tracks it in memory. */
interface ActiveTurnEntry {
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string
  readonly role: FlowAgentRole
  readonly started: number
  readonly promise: Promise<void>
  readonly ac: AbortController
  lease: LeaseRecord | null
  instance: Agent | null
  humanDeliveries?: string[]
  settled: boolean
}

/** One refusal this turn took up, acknowledged only when a matching action commits. */
interface PendingRefusalEntry {
  readonly seq: number
  readonly action: string
  readonly transaction_id: string | null
  readonly node_id: string | null
}

/** One correction-budget stop awaiting application, kept out of the rolled-back transaction. */
interface CorrectionStop {
  readonly node_id: string
  readonly transaction_id: string | null
  readonly used: number
  readonly max_corrections: number
}

/** A per-cluster LLM permit pool: the concurrency semaphore and its queue. */
interface LlmSlots {
  limit: number
  inUse: number
  waiters: Array<() => void>
}

/** One pending action a role still owes, as the prompt and the turn consume it. */
interface PendingAction {
  readonly action: string
  readonly node_id?: string | null
  readonly role?: FlowAgentRole
  readonly kind?: string
  readonly objective?: string | null
  readonly note?: string
  readonly status?: string | null
  readonly tool?: string | null
  readonly subject?: string
  readonly transaction_id?: string | null
  readonly inbox_id?: string
  readonly audit_id?: string | null
  readonly target_revision?: number | null
  readonly revision?: number
  readonly children?: number
  readonly allocations?: readonly string[]
  readonly starved_agents?: readonly string[]
  readonly from?: { readonly kind: string; readonly id: string }
  readonly to?: { readonly kind: string; readonly id: string }
  readonly from_options?: FlowJsonValue
  readonly required?: FlowJsonValue
  readonly instruction?: FlowJsonValue
  readonly refusal_seq?: number
  readonly refusal_seqs?: number[]
  readonly issue_id?: string
  readonly required_change?: string
  readonly write_scope?: FlowJsonValue
  readonly acceptance_criteria?: readonly string[]
  readonly count?: number
  readonly transactions?: readonly string[]
  readonly free_slots?: number
  readonly unallocated_total?: number
  readonly evaluation_window?: string
  readonly dimensions?: readonly string[]
  readonly signals?: FlowJsonValue
  readonly reason?: string
  readonly payload?: string
  readonly wakes_role?: boolean
  readonly changed_since_issue?: boolean
  readonly severity?: string | null
  readonly review?: string
  readonly result_status?: string | null
  readonly expected_output?: string | null
}

/** One budget scope's remaining capacity, as a rebalance hint names it. */
interface BudgetHeadroom {
  readonly scope_kind: 'node' | 'agent'
  readonly scope_id: string
  readonly node_id: string | null
  readonly tokens: number
  readonly model_requests: number
  readonly tool_calls: number
}

/** A budget row that was reached through its owning agent's node. */
type BudgetRowWithNode = BudgetRecord & { readonly via_node_id?: string }


/** One cluster's recovery facts, durable with the `recovered` event. */
interface RecoveryFacts {
  cluster_id: string
  status: FlowClusterStatus
  fenced_leases: number
  uncertain_effects: number
  requeued: number
  blocked_agents: number
  inbox_reopened?: number
  agents_requeued?: number
  returned?: unknown
  tool_receipts_uncertain?: number
  tool_receipts_reconciled?: number
  injections_reopened?: number
  injections_pending_proof?: number
}

/** One cluster's session proof. */
interface SessionProofReport {
  readonly cluster_id: string
  readonly session_missing: readonly string[]
}

/** One cluster's delivery reconciliation result. */
interface DeliveryReconciliation {
  readonly acknowledged: number
  readonly requeued: number
  readonly unknown: number
  readonly persistence: boolean
}

/** One cluster's full post-recovery reconciliation. */
interface ReconciledCluster extends DeliveryReconciliation {
  readonly cluster_id: string
  readonly sessions: readonly SessionProofReport[]
}

/** What one restart lifecycle pass proved. */
export interface RecoveryOutcome {
  readonly recovered: readonly RecoveryFacts[]
  readonly reconciled: readonly ReconciledCluster[]
}

type IssueProgress =
  | { readonly progressed: false; readonly how: null }
  | { readonly progressed: true; readonly how: 'plan-adjusted' | 'revalidated'; readonly revision: number };

interface CollectedDeliveries {
  readonly messages: readonly DeliveryPromptMessage[]
  readonly ids: string[]
  readonly reconciled: number
}
export interface SingleAgentResult {
  readonly cluster_id: string
  readonly stop_reason: string
  readonly stop_detail: TurnOutcome['stopDetail']
  readonly final_text: string
  readonly finalText: string
  readonly tool_calls: TurnOutcome['toolCalls']
  readonly usage: FlowUsageSummary
  readonly error: string | null
}

function isActionName(action: string): action is ActionName {
  return Object.hasOwn(HANDLERS, action);
}

/** A stored JSON list of strings, as a prompt renders it. */
function jsonStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A JSON column that must be a JSON value when it is present at all. */
function jsonColumn(value: unknown, label: string): FlowJsonValue | undefined {
  if (value === undefined) return undefined;
  if (!isFlowJsonValue(value)) fail(`${label} must be a JSON value`);
  return value;
}

/** Ordinary TEXT columns allow empty strings; identity validators do not. */
function stringColumn(value: unknown, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`Invalid ${label}`);
  return value;
}

/** A nullable TEXT column: absent stays absent, and any string (even empty) is kept. */
function stringColumnOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`Invalid ${label}`);
  return value;
}

const TRANSACTION_STATUSES = [
  'DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING',
  'ACCEPTED', 'REJECTED', 'FAILED', 'CANCELLED', 'BLOCKED', 'SUPERSEDED',
] as const satisfies readonly FlowTransactionStatus[];


/** One initial transaction as a start request carries it: open JSON, narrowed per field. */
interface TransactionSeedInput {
  readonly objective?: unknown
  readonly id?: unknown
  readonly parent_transaction_id?: unknown
  readonly inputs?: unknown
  readonly constraints?: unknown
  readonly expected_output?: unknown
  readonly acceptance_criteria?: unknown
  readonly needs?: unknown
  readonly priority?: unknown
  readonly capabilities?: unknown
  readonly status?: unknown
  readonly [key: string]: unknown
}

/** What one turn's finisher needs to close the turn out. */
interface TurnFinishOptions {
  readonly node?: NodeRecord | null
  readonly outcome: TurnOutcome | null
  readonly error: unknown
  readonly before: number
  readonly lease: LeaseRecord
  readonly deliveries?: readonly string[] | undefined
  readonly admitted?: boolean
  readonly durable?: boolean
  readonly failures?: number
  readonly turnSeq?: number | null
  readonly inboxIds?: readonly string[]
}

/** The verdict of proving one injected message against its durable Session. */
interface DeliveryProof {
  readonly state: 'FOUND' | 'ABSENT' | 'UNKNOWN'
  readonly found: boolean
  readonly reason?: string
  readonly scanned?: number
}

/** One issue as a model role reads it: references and the requested change, no evidence. */
interface IssueReference {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly reporter_agent_id: string | null
  readonly target_revision: number | null
  readonly severity: string
  readonly required_change: string
  readonly status: FlowIssueStatus
  readonly corrections: number
  readonly created: number
  readonly updated: number
}

/** The user-shaped answer for each query kind: the tagged `what` names one of these. */
export interface QueryDataMap {
  cluster: FlowClusterQueryData
  nodes: FlowClusterNodesQueryData
  node: FlowClusterNodeQueryData
  transactions: FlowClusterTransactionsQueryData
  transaction: FlowClusterTransactionQueryData
  audit: FlowClusterAuditQueryData
  agents: FlowClusterAgentsQueryData
  allocations: FlowClusterAllocationsQueryData
  budgets: FlowClusterBudgetsQueryData
  issues: FlowClusterIssuesQueryData
  issue: FlowClusterIssueQueryData
  audits: FlowClusterAuditsQueryData
  effects: FlowClusterEffectsQueryData
  effect: FlowClusterEffectQueryData
  usage: FlowClusterUsageQueryData
  deliveries: FlowClusterDeliveriesQueryData
  context: FlowClusterContextQueryData
  health: FlowClusterHealthQueryData
  summary: FlowClusterSummaryQueryData
  blackboard: FlowClusterBlackboardQueryData
}

export class ClusterRuntime implements FlowService {
  readonly ctx: Context;
  readonly logger: FlowLogger;
  readonly config: ResolvedRuntimeConfig;
  readonly store: ClusterStore;

  constructor(ctx: Context, config: FlowRuntimeConfig = {}) {
    this.ctx = ctx;
    this.logger = config.logger ?? ctx.logger;
    const model = config.model ?? {};
    // The deployment's own route is always selectable; a caller may widen the
    // registry explicitly.
    const routes = config.routes && Object.keys(config.routes).length
      ? config.routes
      : (model.provider && model.model ? { [model.provider]: [model.model] } : {});
    this.config = {
      dataDir: config.dataDir,
      model,
      context: { ...DEFAULT_CONTEXT_LIMITS, ...(config.context ?? {}) },
      tickMs: config.tickMs ?? 250,
      leaseTtlMs: config.leaseTtlMs ?? 60_000,
      // How long a transaction may sit unchanged before it counts as stale.
      staleMs: config.staleMs ?? 120_000,
      // How long one turn may stay in flight before it is aborted. The provider
      // has its own request timeouts; this is the cluster's backstop for a turn
      // that stopped making progress while still holding its lease.
maxTurnMs: config.maxTurnMs ?? 900_000,
      heartbeatMs: config.heartbeatMs ?? 20_000,
      disposeTimeoutMs: config.disposeTimeoutMs ?? 5_000,
      now: config.now,
      routes,
      autoTick: config.autoTick ?? true,
      startDefaults: config.startDefaults,
      executionDefaults: config.executionDefaults,
    };
    this.store = new ClusterStore(config.path ?? config.dbPath ?? ':memory:', { now: config.now ?? Date.now });
    this.#activeTurns = new Map();
    /** One scheduling pass per cluster at a time, across every driver. */
    this.#scheduling = new Set();
    this.#llmSlots = { limit: 2, inUse: 0, waiters: [] };
    this.#rotation = new Map();
    this.#lastAdmittedClass = new Map();
    this.#roleRotation = new Map();
    this.#pendingRefusals = new Map();
    this.#correctionStops = new Map();
    this.#timer = null;
    this.#disposed = false;
  }

  #activeTurns: Map<string, ActiveTurnEntry>;
  #scheduling: Set<string>;
  #llmSlots: LlmSlots;
  #runLlmSlots = new Map<string,LlmSlots>();
  #rotation: Map<string, number>;
  /** Which class took a one-slot window last: with one slot, the classes alternate. */
  #lastAdmittedClass: Map<string, 'management' | 'worker'>;
  /** The role each node admitted last, per node: management roles rotate on starts. */
  #roleRotation: Map<string, number>;
  /** Refusals the current turn took up, acknowledged only when its action commits. */
  #pendingRefusals: Map<string, PendingRefusalEntry[]>;
  /** Correction-budget stops awaiting application, kept out of the rolled-back transaction. */
  #correctionStops: Map<string, CorrectionStop[]>;
  #timer: NodeJS.Timeout | null;
  #disposed: boolean;
  #disposePromise: Promise<void> | null = null;
  #recoveryPromise: Promise<RecoveryOutcome> | null = null;
  #persistenceAbort = new AbortController();
  #schedulingGeneration = 0;
  #ticking = false;
  #wakeups: Array<() => void> = [];
  #wakePromise: Promise<void> | null = null;
  #wakeResolve: (() => void) | null = null;

  /** Start exactly one main-session intent, including retries after lost acknowledgments. */
  startTeam(sessionId: string, intentId: string, objective: string, workspace?: string,model?:FlowModelSelection): FlowSnapshot {
    return startTeam(this, sessionId, intentId, objective, workspace,model);
  }

  createTeam(sessionId: string, launchId: string, request: FlowTeamCreateRequest, model?: FlowModelSelection) {
    return createTeam(this, sessionId, launchId, request, model);
  }

  teamStartDefaults() { return this.config.executionDefaults?.().start ?? this.config.startDefaults; }

  isTeamAgentSession(sessionId: string): boolean { return Boolean(this.store.getAgentBySession(sessionId)); }

  agentSession(sessionId: string) { return agentSession(this,sessionId); }
  promptAgent(sessionId: string, requestId: string, text: string, clientTimeZone?: string, mode: 'queue' | 'steer' = 'queue'): void {
    promptAgent(this,sessionId,requestId,text,clientTimeZone,mode);
    const agent=this.store.getAgentBySession(sessionId);if(agent)this.#injectHumanPrompts(agent);
  }
  /** Active native turns retain their role scope; cold turns remain in the durable Flow inbox. */
  #injectHumanPrompts(agent: AgentRecord): void {
    const entry=this.#activeTurns.get(agent.id);
    if(!entry?.instance || entry.settled || entry.ac.signal.aborted)return;
    for(const row of this.store.pendingDeliveries(agent.id)) {
      const human=communicationContent(communicationContent(row.content).human_prompt);
      if(row.from_agent!==null || typeof human.rpc_id!=='string')continue;
      const input=this.#communicationMessages(agent,[row])[0]!;
      this.store.tx(()=>this.store.markDeliveryInjected(row.message_id,agent.id));
      (entry.humanDeliveries??=[]).push(row.message_id);
      entry.instance.send(input,human.mode==='steer'?'next-step':'next-turn',true);
    }
  }
  #settleHumanPrompts(clusterId:string,agentId:string,admitted:boolean,durable:boolean):void {
    const entry=this.#activeTurns.get(agentId),ids=entry?.humanDeliveries??[];
    if(ids.length)this.settleDeliveries(clusterId,agentId,ids,{admitted,durable});
  }
  interruptAgent(sessionId: string): void {
    const agent=this.store.getAgentBySession(sessionId);
    if (!agent) fail('智能体会话不存在',404);
    this.#activeTurns.get(agent.id)?.ac.abort(new Error('用户停止当前智能体轮次'));
  }

  finalizeTeam(sessionId: string, runId: string) { return finalizeTeam(this, sessionId, runId); }

  /** Forward an ordinary main-session instruction once. */
  teamReply(sessionId: string, messageId: string, content: string, runId?: string): void { replyTeam(this, sessionId, messageId, content, runId); }

  /** Read the runs belonging to one main conversation. */
  teamRuns(sessionId: string) { return teamRuns(this, sessionId); }

  /** Main owners survive release of the host's live Session and Agent. */
  teamOwners(): readonly string[] {
    return this.store.all('SELECT DISTINCT main_session_id FROM team_runs ORDER BY main_session_id').map(row=>String(row.main_session_id));
  }

  /** Read one consistent observing snapshot without mutating execution. */
  teamRead(sessionId: string, runId: string) { return readTeam(this, sessionId, runId); }

  // ------------------------------------------------------------ public API

  start(request: FlowStartRequest, internals: FlowStartInternals = {}): FlowSnapshot {
    const execution = this.config.executionDefaults?.();
    const defaults = execution?.start ?? this.config.startDefaults;
    // A deployment's defaults fill every field the caller omitted; a pure
    // business test that constructed the runtime directly has none, and its
    // request is validated as it stands.
    const spec = defaults ? resolveStartRequest(request, defaults, internals)
      : internals.delegation === undefined && internals.message_fixture === undefined
        ? request : { ...request, ...internals };
    const normalized = validateSpec(spec);
    const clusterId = spec.id ?? randomUUID();
    const cluster = this.store.tx(() => {
      this.store.createCluster({
        id: clusterId,
        objective: normalized.objective,
        workspace: normalized.workspace,
        capabilities: normalized.capabilities,
        limits: normalized.limits,
        budget: normalized.budget,
        delegation: normalized.delegation,
        message_fixture: normalized.message_fixture,
      }, normalized.budget);

      const rootBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'root', scope_id: clusterId,
        limit: {
          tokens: normalized.budget.tokens ?? 0,
          model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
          agents: normalized.budget.agents ?? normalized.limits.max_agents,
          max_active_agents: normalized.budget.max_active_agents ?? normalized.limits.max_active_agents,
        },
        wall_limit_ms: normalized.budget.wall_time_ms ?? 3_600_000,
      });

      const root = this.store.insertNode({
        id: randomUUID(), cluster_id: clusterId, parent_id: null, kind: 'management', depth: 0,
        status: 'ACTIVE', scope: asJsonValue({ objective: normalized.objective, ...(execution ? {
          team_model: { ...this.config.model, ...(execution.model ?? {}), ...execution.options },
          team_model_fixed: execution.model !== null,
          team_model_options: { ...execution.options },
          team_dispatch_mode: execution.dispatchMode,
        } : {}) }), capabilities: normalized.capabilities,
        path: '0', max_children: normalized.limits.max_children,
      });
      if (!root) fail('Root node could not be created', 500);
      this.store.updateNode(root.id, { scope: { ...root.scope, root: true } });

      const rootNodeBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'node', scope_id: root.id, node_id: root.id,
        parent_budget_id: rootBudget.id, limit: {}, wall_limit_ms: 0,
      });
      const rootRow = this.store.getBudget(rootBudget.id);
      if (!rootRow) fail('Root budget not found', 500);
      // Seed the preferred compaction payer before funding the management tree.
      // The shared payer selector also permits ordinary requests to use this
      // pool when their own scopes cannot cover the full request.
      const share = (limit: number, floor: number, fraction: number): number => {
        if (!Number.isFinite(limit) || limit <= 0) return 0;
        const bounded = Math.min(Math.max(floor, Math.floor(limit * fraction)), Math.floor(limit * 0.25));
        return bounded >= Math.min(floor, limit) ? bounded : 0;
      };
      // Allocate a tenth of declared tokens and a fifth of requests, with
      // minimum envelopes capped at a quarter of each root dimension.
      // These grants are transferred from the root budget, not added to it.
      const compactionTokens = share(rootRow.tokens_limit, 64_000, 0.10);
      const compactionRequests = share(rootRow.requests_limit, 4, 0.20);
      if (compactionTokens > 0 || compactionRequests > 0) {
        const compactionBudget = createBudget(this.store, {
          cluster_id: clusterId, scope_kind: 'compaction', scope_id: clusterId,
          parent_budget_id: rootBudget.id, limit: {}, wall_limit_ms: 0,
        });
        this.grantBudget(rootBudget, compactionBudget, { tokens: compactionTokens, model_requests: compactionRequests });
      }
      this.grantBudget(rootBudget, rootNodeBudget, {
        tokens: rootRow.tokens_limit, model_requests: rootRow.requests_limit,
        tool_calls: rootRow.tool_calls_limit, agents: rootRow.agents_limit,
        max_active_agents: rootRow.max_active_limit,
      });
      const budgets = new Map();
      budgets.set(root.id, rootNodeBudget);
      this.ensureRoles(clusterId, root, budgets);

      if (normalized.delegation.length) {
        this.store.appendEvent(clusterId, 'delegation-fixture', { entries: normalized.delegation.length, scopes: normalized.delegation.map(entry => entry.scope) });
      }
      if (normalized.message_fixture.length) {
        this.store.appendEvent(clusterId, 'message-fixture', { entries: normalized.message_fixture.map(entry => entry.message_id) });
      }
      const planned = Array.isArray(spec.initial_transactions) && spec.initial_transactions.length
        ? spec.initial_transactions
        : [{ objective: normalized.objective, acceptance_criteria: spec.acceptance_criteria ?? [] }];
      for (const entry of planned) this.createTransactionInternal(clusterId, root, entry, { local: true, parent: null });

      this.store.appendEvent(clusterId, 'cluster-started', {
        objective: normalized.objective, workspace: normalized.workspace,
        limits: { ...normalized.limits }, initial_transactions: planned.length,
      });
      return this.store.getCluster(clusterId);
    });

    if (!cluster) fail('Cluster not found', 404);
    this.setLlmConcurrency(cluster.limits.max_llm_concurrency,cluster.id);
    this.#ensureTicking();
    this.wake();
    return this.read(clusterId, { include_events: false });
  }

  list(query: FlowListQuery = {}): FlowListResult {
    const clusters = this.store.listClusters({ status: query.status, limit: query.limit, offset: query.offset });
    return {
      clusters: clusters.map(cluster => {
        const counts = this.countsOf(cluster.id);
        return {
          id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace,
          revision: cluster.revision, created: cluster.created, ...counts,
        };
      }),
    };
  }

  read(id: string, query: FlowReadQuery = {}): FlowSnapshot {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    const base: FlowSnapshot = {
      cluster: {
        id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace,
        capabilities: cluster.capabilities, limits: cluster.limits, budget: cluster.budget,
        revision: cluster.revision, created: cluster.created, updated: cluster.updated,
      },
      counts: this.countsOf(id),
      nodes: this.store.listNodes(id, { limit: normalizeLimit(query.limit) }).map(projectNodeRecord),
      agents: this.store.listAgents(id, { limit: normalizeLimit(query.limit, 200) }).map(projectAgentRecord),
      transactions: this.store.listTransactions({
        cluster_id: id, node_id: query.node_id, status: statusFilter(query.status),
        limit: normalizeLimit(query.limit), offset: query.offset,
      }).map(projectTransactionRecord),
      allocations: this.store.listAllocations({ cluster_id: id, status: 'ACTIVE', limit: normalizeLimit(query.limit, 200) })
        .map(projectAllocationRecord),
      budgets: evaluateTree(this.store, id),
      issues: this.store.openIssues(id, {}),
      usage: this.store.usageSummary(id),
      latest_seq: this.store.latestEventSeq(id),
    };
    const withEvents: FlowSnapshot = query.include_events === false ? base : {
      ...base,
      events: this.store.readEvents(id, { since: query.since ?? 0, limit: normalizeLimit(query.event_limit, 100) })
        .map(event => ({ ...event, cluster_id: id })),
    };
    return query.include_summary ? { ...withEvents, summary: this.latestSummaryOf(id) } : withEvents;
  }

  events(id: string, query: FlowEventQuery = {}): FlowEventsResult {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    return {
      events: this.store.readEvents(id, { since: query.since ?? 0, limit: normalizeLimit(query.limit, 200) })
        .map(event => ({ ...event, cluster_id: id })),
    };
  }

  control(id: string, action: FlowControlAction): FlowSnapshot {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    const next = { pause: 'PAUSED', resume: 'RUNNING', cancel: 'CANCELLED' } satisfies Record<FlowControlAction, FlowClusterStatus>;
    if (!(action in next)) fail(`Unknown control action: ${action}`);
    const result = this.store.tx(() => {
      const at = this.timestamp();
      const nextStatus = next[action];
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(cluster.status)) fail('Cluster is terminal', 409);
      if (action === 'resume' && !['PAUSED', 'BLOCKED'].includes(cluster.status)) fail('Cluster is not paused', 409);
      this.store.updateCluster(id, { status: nextStatus });
      if (action === 'pause') {
        for (const node of this.store.nodesInSubtree(id, null)) {
          if (node.status === 'ACTIVE') this.store.updateNode(node.id, { status: 'PAUSED' });
        }
        for (const agent of this.store.agentsInSubtree(id, null)) {
          if (['READY', 'RUNNING', 'WAITING'].includes(agent.status)) this.store.updateAgent(agent.id, { status: 'PAUSED' });
        }
        // One exhaustive statement per status: a page of transactions is not
        // "every transaction that was in flight". The status a transaction came
        // from is remembered, so `resume` restores *that* rather than promoting
        // an unapproved DRAFT to READY. A staged proposal is left alone: it is
        // real work, and the turn that produced it may still be the turn that
        // finishes it.
        for (const status of ['READY', 'DISPATCHED', 'RUNNING', 'DRAFT']) {
          this.store.run(
            `UPDATE transactions SET status='PAUSED', pre_pause_status=?, pre_pause_revision=revision, updated=?
              WHERE cluster_id=? AND status=?`,
            status, this.timestamp(), id, status,
          );
        }
      }
      if (action === 'resume') {
        for (const node of this.store.nodesInSubtree(id, null)) {
          if (node.status === 'PAUSED') this.store.updateNode(node.id, { status: 'ACTIVE' });
        }
        for (const agent of this.store.agentsInSubtree(id, null)) {
          if (agent.status === 'PAUSED') this.store.updateAgent(agent.id, { status: 'READY' });
        }
        // The pre-pause status decides where each transaction goes back to, and
        // the dependencies decide whether going back is legal yet. Both are SQL
        // predicates, so the whole cluster is classified regardless of size.
        this.store.run(
          `UPDATE transactions SET status='READY', pre_pause_status=NULL, pre_pause_revision=NULL, updated=?
            WHERE cluster_id=? AND status='PAUSED' AND pre_pause_status IN ('READY','DISPATCHED','RUNNING')
              AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN transactions o ON o.id = d.depends_on
                              WHERE d.transaction_id = transactions.id AND o.status <> 'ACCEPTED')`,
          this.timestamp(), id,
        );
        this.store.run(
          `UPDATE transactions SET status='DRAFT', pre_pause_status=NULL, pre_pause_revision=NULL, updated=?
            WHERE cluster_id=? AND status='PAUSED' AND pre_pause_status IN ('READY','DISPATCHED','RUNNING')`,
          this.timestamp(), id,
        );
        this.store.run(
          "UPDATE transactions SET status=COALESCE(pre_pause_status,'DRAFT'), pre_pause_status=NULL, pre_pause_revision=NULL, updated=? WHERE cluster_id=? AND status='PAUSED'",
          this.timestamp(), id,
        );
      }
      if (action === 'cancel') {
        this.cancelSubtree(id, null, at);
        this.terminateClusterJobs(id, 'cluster cancelled');
      }
      this.store.appendEvent(id, `cluster-${action}`, { at });
      return this.read(id, { include_events: false });
    });
    this.wake();
    return result;
  }

  /**
   * Role command entry: `actor` carries the authenticated role and management
   * domain, `command` carries the caller-minted command identity.
   */
  command(actor: FlowActor, command: FlowCommand): FlowCommandOutcome {
    const { command_id, action, params, expected_revision } = command;
    if (typeof action !== 'string' || !action) fail('Invalid command action');
    const paramCluster = params?.cluster_id;
    const clusterId = actor.cluster_id || (typeof paramCluster === 'string' ? paramCluster : '');
    if (!clusterId) fail('Command requires a cluster id');
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) fail('Cluster not found', 404);
    authorize(actor, action);
    if (actor.role !== 'user' && actor.epoch !== undefined) {
      // A command is only valid while the exact lease epoch that produced it is
      // still the live one for that identity.
      const lease = this.store.leaseForAgent(actor.agent_id);
      if (!lease || lease.epoch !== actor.epoch || lease.expires <= this.timestamp()) {
        fail(`command from a fenced turn: agent ${actor.agent_id} does not hold epoch ${actor.epoch}`, 409);
      }
    }
    const outcome = this.store.runCommand(
      { cluster_id: clusterId, command_id, actor, action, expected_revision, params },
      () => {
        // The precondition guards new work. A completed command already has
        // its answer, even if that work advanced the cluster revision itself.
        const current = this.store.getCluster(clusterId);
        if (!current) fail('Cluster not found', 404);
        if (expected_revision !== undefined && expected_revision !== null && expected_revision !== current.revision) {
          fail(`revision conflict: expected ${expected_revision}, current ${current.revision}`, 409);
        }
        return { ...this.#applyCommand(current, actor, action, params ?? {}) };
      },
    );
    this.wake();
    return { deduped: outcome.deduped, revision: outcome.revision ?? 0, result: asJsonValue(outcome.result) };
  }

  /**
   * Run one communication action on behalf of an actor. The communication
   * module commits its delivery notifications with the action atomically.
   */
  communicateFrom(actor: CommunicationActor, action: string, params: Record<string, unknown>): CommunicationResult {
    const cluster = this.store.getCluster(actor.cluster_id);
    if (!cluster) fail('Cluster not found', 404);
    const result = communicate(this.store, cluster, actor, action, params ?? {}, {
      notify: (recipient, payload) => this.notifyInternal(actor.cluster_id, recipient, { subject: payload.kind, payload: asJsonValue(payload) }),
    });
    return result;
  }

  /**
   * Cancel every background job this cluster registered. An unknown or foreign
   * process is never killed by guesswork: only jobs the host still owns.
   */
  terminateClusterJobs(clusterId: string, reason: string): string[] {
    let jobs: JobRegistry | undefined;
    try {
      jobs = this.ctx.get('jobs');
    } catch {
      jobs = undefined;
    }
    if (!jobs) return [];
    const stopped: string[] = [];
    for (const effect of this.store.effectsAll(clusterId)) {
      if (!effect.job_id) continue;
      const agent = this.store.getAgent(effect.agent_id);
      if (!agent) continue;
      try {
        jobs.kill(JobId(effect.job_id), SessionId(agent.session_id), reason);
        stopped.push(effect.job_id);
      } catch (error) {
        this.logger?.warn?.(error);
      }
    }
    if (stopped.length) this.store.appendEvent(clusterId, 'jobs-terminated', { jobs: stopped, reason });
    return stopped;
  }

  /**
   * Prove injections against the recipient's own durable Session: a message id
   * that is present there was admitted, so only its ack is missing. Everything
   * else stays queued for a real delivery.
   */
  /**
   * The session persistence service, when the profile mounts one. Without it a
   * crash window between injection and ack cannot be proven and the attempted
   * delivery stays withheld until its durable session can be read.
   */
  attachPersistence(service: FlowPersistenceSeam | null): FlowPersistenceSeam | null {
    this.#persistence = service ?? null;
    return this.#persistence;
  }

  /**
   * Whether this runtime has already been torn down.
   *
   * A loader that loses one of the services this instance was built on unloads
   * the fiber, which runs the disposer; the entry point asks this before
   * publishing, because a runtime that is already closed must not become the
   * service other plugins consume.
   */
  get closed(): boolean {
    return this.#disposed;
  }

  persistenceAvailable(): boolean {
    return Boolean(this.#persistence);
  }

  /**
   * Whether a Session really exists on disk. `agent.turns > 0` is a proxy that
   * is wrong on both sides of Session materialization: a crash after the first
   * Session was written but before its finisher ran leaves `turns === 0` while
   * the Session exists, and a failed first turn can leave `turns > 0` with no
   * Session at all.
   * @returns true/false when the store can answer, or null when it cannot.
   */
  async sessionExists(sessionId: string): Promise<boolean | null> {
    if (this.#disposed || !this.#persistence || typeof this.#persistence.stat !== 'function') return null;
    const signal = this.#persistenceAbort.signal;
    try {
      const snapshot = await waitForProof(this.#persistence.stat(SessionId(sessionId), { signal }), signal);
      return Boolean(snapshot);
    } catch (error) {
      if (!signal.aborted) this.logger?.warn?.(`dsh-flow: session existence probe failed: ${messageOf(error)}`);
      return null;
    }
  }

  async reconcileDeliveries(clusterId: string, { sessionIdFor = (agent: AgentRecord | null) => agent?.session_id } = {}): Promise<DeliveryReconciliation> {
    // Settle anything still reserved from the previous process before any
    // scheduling resumes, so held tokens are visible to the first decision.
    // Only identities that really hold a reservation are visited: the set comes
    // from the ledger, so a cluster with more identities than one page still
    // settles every stranded request before scheduling resumes.
    for (const facts of this.store.agentsWithReservedReceipts(clusterId)) {
      if (this.#disposed) return { acknowledged: 0, requeued: 0, unknown: 0, persistence: Boolean(this.#persistence) };
      const cluster = this.store.getCluster(clusterId) ?? fail('Cluster not found', 404);
      this.reconcileReservations(cluster, facts);
    }
    let persistence: FlowPersistenceSeam | null = this.#persistence;
    if (!persistence) {
      // Fall back to a direct lookup: `ctx.inject` is the documented path, but
      // a profile may expose the service without going through it.
      try {
        persistence = this.ctx.get('sessionPersistence') ?? null;
      } catch (error) {
        this.logger?.warn?.(`dsh-flow: session persistence is not reachable: ${messageOf(error)}`);
        persistence = null;
      }
      if (persistence) this.#persistence = persistence;
    }
    const rows = this.store.all(
      `SELECT r.message_id, r.recipient, r.status FROM recipients r JOIN messages m ON m.id=r.message_id
       WHERE m.cluster_id=? AND r.status IN ('DELIVERED','PENDING')`, clusterId);
    if (!rows.length) return { acknowledged: 0, requeued: 0, unknown: 0, persistence: Boolean(persistence) };
    let acknowledged = 0;
    let requeued = 0;
    let unknown = 0;
    for (const row of rows) {
      // Each row awaits a session probe; disposal can land between rows.
      if (this.#disposed) break;
      const messageId = textField(row.message_id, 'recipient.message_id', 128);
      const recipient = textField(row.recipient, 'recipient.recipient', 128);
      const status = textField(row.status, 'recipient.status', 32);
      const agent = this.store.getAgent(recipient);
      const sessionId = sessionIdFor(agent);
      // A missing durable session proves no admission. An unreadable session
      // remains uncertain and needs a different recovery decision.
      const exists = sessionId ? await this.sessionExists(sessionId) : false;
      if (this.#disposed) break;
      const proof: DeliveryProof = !persistence || !sessionId
        ? { state: 'UNKNOWN', found: false, reason: persistence ? 'no session id' : 'no session persistence service' }
        : exists === false
          ? { state: 'ABSENT', found: false, reason: 'the recipient has no session yet, so nothing was injected' }
          : await sessionCarries(persistence, sessionId, messageId, this.#persistenceAbort.signal);
      if (this.#disposed) break;
      const admitted = proof.state === 'FOUND';
      this.store.tx(() => this.store.appendEvent(clusterId, 'messages-reconcile', {
        message_id: messageId, recipient, session_id: sessionId ?? null,
        state: proof.state, found: admitted, reason: proof.reason ?? null, events_scanned: proof.scanned ?? null,
      }));
      if (proof.state === 'UNKNOWN') {
        // An unprovable state is preserved and named. It blocks its owner
        // only when the delivery *had been injected*: that is the case where a
        // dispatch could duplicate it. A delivery that was still queued has not
        // been handed over at all, so there is nothing ambiguous to resolve and
        // blocking the cluster for it stops work for no reason.
        const owner = status === 'DELIVERED' ? this.store.getAgent(recipient) : null;
        this.store.tx(() => {
          // Keep DELIVERED: changing it to PENDING would erase the only durable
          // distinction between a fresh message and one that may already be in
          // the session, allowing a later restart to re-inject it without proof.
          this.store.appendEvent(clusterId, 'delivery-unknown', {
            message_id: messageId, recipient, session_id: sessionId ?? null,
            was_injected: status === 'DELIVERED', reason: proof.reason ?? null,
          });
          if (owner) {
            this.store.updateAgent(owner.id, { status: 'BLOCKED' });
            this.blockNodeInternal(clusterId, owner.node_id,
              `DELIVERY_UNKNOWN: delivery ${messageId} to ${owner.id} cannot be proven either way`, 'DELIVERY_UNKNOWN');
          }
        });
        unknown += 1;
        continue;
      }
      if (admitted) {
        this.store.tx(() => {
          this.store.ackDelivery(messageId, recipient);
          this.store.appendEvent(clusterId, 'messages-ack-reconciled', { message_id: messageId, recipient, session_id: sessionId ?? null });
        });
        acknowledged += 1;
      } else {
        this.store.tx(() => this.store.run(
          "UPDATE recipients SET status='PENDING', acked=NULL WHERE message_id=? AND recipient=? AND status='DELIVERED'",
          messageId, recipient,
        ));
        requeued += 1;
      }
    }
    return { acknowledged, requeued, unknown, persistence: Boolean(persistence) };
  }

  /** Reclaim leases whose TTL passed. Exposed for tests and for the boot sweep. */
  txExpireLeases(clusterId: string): void {
    return this.#expireLeases(clusterId);
  }

  /**
   * Node ids one actor may read. A management role sees its own subtree; a
   * worker sees its own node; the host user sees everything.
   */
  domainNodeIds(actor: FlowActor, clusterId: string): Set<string> {
    if (actor.role === 'user' || !actor.node_id) {
      return new Set(this.store.all('SELECT id FROM nodes WHERE cluster_id=?', clusterId)
        .map(row => textField(row.id, 'node.id', 128)));
    }
    // A recursive CTE includes every node in the domain without pagination limits.
    const rows = this.store.all(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       SELECT id FROM sub`, actor.node_id);
    return new Set(rows.map(row => textField(row.id, 'node.id', 128)));
  }

  /** Topology only: ancestors are context, not an extension of the role's read domain. */
  managementAncestors(clusterId: string, nodeId: string): FlowNodeAncestor[] {
    return this.store.all(
      `WITH RECURSIVE lineage(id,parent_id,depth,path,kind) AS (
         SELECT id,parent_id,depth,path,kind FROM nodes WHERE cluster_id=? AND id=?
         UNION ALL
         SELECT parent.id,parent.parent_id,parent.depth,parent.path,parent.kind
           FROM nodes parent JOIN lineage child ON parent.id=child.parent_id
          WHERE parent.cluster_id=?
       )
       SELECT id,depth,path,kind FROM lineage WHERE id<>? ORDER BY depth`,
      clusterId, nodeId, clusterId, nodeId,
    ).map(row => ({
      id: textField(row.id, 'ancestor.id', 128),
      depth: integer(row.depth, 0, 64, 'ancestor.depth'),
      path: textField(row.path, 'ancestor.path', 512),
      kind: nodeKindOf(row.kind, 'ancestor.kind'),
    }));
  }

  /**
   * Read-only query surface shared by every role and the host API.
   *
   * Two overloads: a host user gets the complete user-shaped answer, while a
   * cluster role gets the trimmed answer its own domain and context budget
   * allow. The implementation signature is deliberately the widest — the
   * model-trimmed branches return deliberately lighter projections than the
   * wire types — so callers rely on the overload they matched.
   */
  query<K extends FlowQueryKind>(actor: FlowUserActor, what: K, params?: FlowQueryParams): QueryDataMap[K];
  query<K extends FlowQueryKind>(actor: FlowActor, what: K, params?: FlowQueryParams): QueryDataMap[K];
  /** A runtime-named kind (the model's `flow_query` tool) gets the whole union. */
  query(actor: FlowActor, what: string, params?: FlowQueryParams): QueryDataMap[FlowQueryKind];
  query(actor: FlowActor, what: string, params: FlowQueryParams = {}): unknown {
    const clusterId = actor.cluster_id ?? params.cluster_id;
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) fail('Cluster not found', 404);
    const limit = normalizeLimit(params.limit);
    const rawOffset = params.offset;
    const offset = typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const domain = this.domainNodeIds(actor, clusterId);
    const inDomain = (tx: TransactionRecord) => domain.has(tx.node_id);
    const agentId = actor.role === 'user' ? null : actor.agent_id;
    const canReadTransaction = (tx: TransactionRecord) => inDomain(tx)
      || this.store.listAllocations({ cluster_id: clusterId, ...(agentId ? { agent_id: agentId } : {}), status: 'ACTIVE', limit: 5 })
        .some(allocation => allocation.transaction_id === tx.id);
    /**
     * One envelope for every list: the caller always learns whether it is
     * looking at the whole answer, and `next_offset` is `null` exactly when it
     * is. A list that silently stops at the first page is how a client comes to
     * believe a 1024-row domain holds 200 rows.
     */
    const pageList = <T>(items: readonly T[], total: number | null = null) => {
      const count = total === null ? items.length : total;
      const next = offset + items.length < count ? offset + items.length : null;
      return { items, total: count, offset, limit, next_offset: next };
    };
    switch (what) {
      case 'cluster':
        return { cluster: this.read(clusterId, { include_events: false }).cluster, counts: this.countsOf(clusterId) };
      case 'nodes': {
        const nodes = scopeNodes(this.store, actor, clusterId).filter(node => params.parent_id === undefined || node.parent_id === params.parent_id);
        return pageList(nodes.slice(offset, offset + limit).map(nodeReference), nodes.length);
      }
      case 'node': {
        if (typeof params.id !== 'string' || !params.id) fail('query "node" needs params.id, the node id (see what:"nodes")');
        const node = this.store.getNode(params.id);
        if (!node || node.cluster_id !== clusterId) fail(`Node not found: ${params.id}`, 404);
        if (!domain.has(node.id)) fail('node is outside this agent\'s domain', 403);
        const transactions = this.store.transactionsForDomain(clusterId, {
          ...(actor.role === 'user' ? {} : { scope_node_id: actor.node_id }),
          node_id: node.id, limit, offset,
        });
        const agents = this.store.listAgents(clusterId, { node_id: node.id, limit, offset });
        const agentsTotal = Number(this.store.get(
          'SELECT COUNT(*) AS c FROM agents WHERE cluster_id=? AND node_id=?', clusterId, node.id)?.c ?? 0);
        return {
          ancestors: this.managementAncestors(clusterId, node.id),
          // A topology lookup normally needs path, depth and child references.
          // Compact references bound repeated delegation data in model context;
          // complete scope remains available by id when explicitly requested.
          node: actor.role === 'user' || params.full === true ? node : nodeReference(node),
          transactions: pageList(transactions.items.map(transactionReference), transactions.total),
          agents: pageList(agents.map(agentReference), agentsTotal),
          subtree_size: this.store.nodesInSubtree(clusterId, node.id).length - 1,
        };
      }
      case 'transactions': {
        const { items, total } = this.store.transactionsForDomain(clusterId, {
          ...(actor.role === 'user' ? {} : { scope_node_id: actor.node_id }),
          node_id: params.node_id, parent_id: params.parent_id, status: statusFilter(params.status), limit, offset,
        });
        return pageList(items.map(transactionReference), total);
      }
      case 'transaction': {
        if (typeof params.id !== 'string' || !params.id) {
          fail('query "transaction" needs params.id; transaction_id is the mutation parameter, not the query parameter');
        }
        const tx = this.store.getTransaction(params.id);
        if (!tx || tx.cluster_id !== clusterId) fail('Transaction not found', 404);
        if (!canReadTransaction(tx)) fail('transaction is outside this agent\'s domain', 403);
        if (actor.role !== 'user' && params.full === true) {
          fail('A model cannot load every historical audit in one transaction response; read each audit by id with what:"audit" (or each issue with what:"issue")');
        }
        const { result, validation, ...transaction } = tx;
        // The current validation and direct result remain complete; an
        // aggregate's child evidence is independently addressable through its
        // child transaction. Historical audits/issues are references too:
        // replaying all earlier traces can strand a native role session.
        const full = actor.role === 'user';
        const visibleTransaction = full ? transaction : {
          ...transactionReference(tx),
          objective: tx.objective,
          inputs: tx.inputs,
          expected_output: tx.expected_output,
          acceptance_criteria: tx.acceptance_criteria,
          capabilities: tx.capabilities,
          attempts: tx.attempts,
          plan_approved_revision: tx.plan_approved_revision,
        };
        // An aggregate embeds each child's full result a second time. The
        // child is itself a domain-checked transaction readable by id; keep
        // its provenance here without replaying that evidence into the role's
        // session. The host-facing detail retains the complete saved result.
        const resultRecord = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : null;
        const children = resultRecord === null ? null : resultRecord.children;
        const visibleResult = full || resultRecord?.kind !== 'aggregate' || !Array.isArray(children)
          ? result : {
            ...resultRecord,
            children: children.map(child => {
              const entry = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : null;
              return entry === null ? { transaction_id: null, result_revision: null, accepted_by: null } : {
                transaction_id: entry.transaction_id ?? null,
                result_revision: entry.result_revision ?? null,
                accepted_by: entry.accepted_by ?? null,
              };
            }),
          };
        const audits = full ? this.store.auditsForTransaction(clusterId, tx.id, { limit })
          : this.store.all(
            `SELECT id,node_id,kind,target_revision,decision,auditor_agent_id,created,decided
               FROM audits WHERE cluster_id=? AND transaction_id=? ORDER BY created,rowid LIMIT ?`,
            clusterId, tx.id, limit,
          ).map(row => ({
            id: textField(row.id, 'audit.id', 128),
            node_id: optionalText(row.node_id, 'audit.node_id'),
            kind: literalOf(row.kind, AUDIT_KINDS, 'audit.kind'),
            target_revision: optionalInteger(row.target_revision, 'audit.target_revision'),
            decision: literalOf(row.decision, AUDIT_DECISIONS, 'audit.decision'),
            auditor_agent_id: optionalText(row.auditor_agent_id, 'audit.auditor_agent_id'),
            created: integer(row.created, 0, 2 ** 53, 'audit.created'),
            decided: optionalInteger(row.decided, 'audit.decided'),
          }));
        const issues = full ? this.store.openIssues(clusterId, { transaction_id: tx.id })
          : this.store.all(
            `SELECT id,node_id,target_revision,severity,SUBSTR(required_change,1,200) AS required_change,
                    status,corrections,created,updated
               FROM issues WHERE cluster_id=? AND transaction_id=? ORDER BY created`,
            clusterId, tx.id,
          ).map(row => ({
            id: textField(row.id, 'issue.id', 128),
            node_id: optionalText(row.node_id, 'issue.node_id'),
            target_revision: optionalInteger(row.target_revision, 'issue.target_revision'),
            severity: textField(row.severity, 'issue.severity', 64),
            required_change: textField(row.required_change, 'issue.required_change', 4096),
            status: literalOf(row.status, ISSUE_STATUSES, 'issue.status'),
            corrections: integer(row.corrections, 0, 2 ** 31, 'issue.corrections'),
            created: integer(row.created, 0, 2 ** 53, 'issue.created'),
            updated: integer(row.updated, 0, 2 ** 53, 'issue.updated'),
          }));
        const active = this.store.activeAllocationForTransaction(tx.id);
        return {
          transaction: visibleTransaction,
          dependencies: this.store.dependenciesOf(tx.id),
          dependents: this.store.dependentsOf(tx.id),
          audits,
          issues,
          allocation: full || !active ? active : {
            id: active.id, node_id: active.node_id, agent_id: active.agent_id,
            write_scope: active.write_scope, status: active.status,
          },
          validation: validation ?? null,
          result: visibleResult ?? null,
          result_revision: tx.result_revision ?? null,
        };
      }
      case 'audit': {
        if (typeof params.id !== 'string' || !params.id) fail('query "audit" needs params.id');
        const audit = this.store.getAudit(params.id);
        if (!audit || audit.cluster_id !== clusterId) fail('Audit not found', 404);
        const tx = audit.transaction_id ? this.store.getTransaction(audit.transaction_id) : null;
        if (!tx || !canReadTransaction(tx)) fail('audit is outside this agent\'s domain', 403);
        return { audit };
      }
      case 'agents': {
        // A Worker has one transaction, not its manager's whole subtree. It
        // must still be able to address the three roles that own its allocation
        // when a write restriction or execution blocker needs escalation.
        const ownerNodeId = actor.role === 'worker'
          ? this.store.activeAllocationForAgent(actor.agent_id)?.node_id : null;
        const agents = this.store.agentsInSubtree(clusterId, null, {
          status: typeof params.status === 'string' ? params.status : null,
          role: params.role === null || params.role === undefined ? null : literalOf(params.role, AGENT_ROLES, 'agent.role'),
        })
          .filter(agent => actor.role === 'user' || domain.has(agent.node_id)
            || (agent.node_id === ownerNodeId && agent.role !== 'worker'));
        // Bound model pages while retaining exact totals and cursors. Agent
        // references expose identity and topology without consuming the whole context.
        const agentLimit = actor.role === 'user' ? limit : Math.min(limit, 8);
        return { ...pageList(agents.slice(offset, offset + agentLimit).map(agentReference), agents.length), limit: agentLimit };
      }
      case 'allocations': {
        const allocations = this.store.allocationsInSubtree(clusterId, null, {
          status: typeof params.status === 'string' ? params.status : 'ACTIVE',
        })
          .filter(allocation => (actor.role === 'user' ? true : domain.has(allocation.node_id)));
        return pageList(allocations.slice(offset, offset + limit), allocations.length);
      }
      case 'budgets': {
        // Models receive spendable scope IDs and available amounts in bounded
        // pages. Host readers retain every dimension of the full budget ledger.
        const budgetLimit = actor.role === 'user' ? limit : Math.min(limit, 6);
        const rows = evaluateTree(this.store, clusterId)
          .filter(row => row.node_id === null || domain.has(row.node_id))
          .sort((a, b) => a.id.localeCompare(b.id));
        const page = rows.slice(offset, offset + budgetLimit);
        const visible = actor.role === 'user' ? page : page.map(row => ({
          id: row.id, scope_kind: row.scope_kind, scope_id: row.scope_id,
          node_id: row.node_id, parent_budget_id: row.parent_budget_id,
          available: {
            tokens: row.tokens.available, model_requests: row.model_requests.available,
            tool_calls: row.tool_calls.available, agents: row.agents.available,
            max_active_agents: row.max_active_agents.available,
          },
          effective_deadline: row.effective_deadline,
        }));
        const result: unknown = { ...pageList<unknown>(visible, rows.length), limit: budgetLimit };
        return result;
      }
      case 'issues': {
        // The model sees stable references and the requested change, not the
        // full evidence of every open issue. Read the evidence by id below.
        const issues: readonly (IssueRecord | IssueReference)[] = actor.role === 'user'
          ? this.store.openIssues(clusterId, {})
          : this.store.all(
            `SELECT id,cluster_id,node_id,transaction_id,reporter_agent_id,target_revision,
                    severity,SUBSTR(required_change,1,200) AS required_change,status,corrections,created,updated
               FROM issues WHERE cluster_id=? ORDER BY created`, clusterId,
          ).map(row => ({
            id: textField(row.id, 'issue.id', 128),
            cluster_id: textField(row.cluster_id, 'issue.cluster_id', 128),
            node_id: optionalText(row.node_id, 'issue.node_id'),
            transaction_id: optionalText(row.transaction_id, 'issue.transaction_id'),
            reporter_agent_id: optionalText(row.reporter_agent_id, 'issue.reporter_agent_id'),
            target_revision: optionalInteger(row.target_revision, 'issue.target_revision'),
            severity: textField(row.severity, 'issue.severity', 64),
            required_change: textField(row.required_change, 'issue.required_change', 4096),
            status: literalOf(row.status, ISSUE_STATUSES, 'issue.status'),
            corrections: integer(row.corrections, 0, 2 ** 31, 'issue.corrections'),
            created: integer(row.created, 0, 2 ** 53, 'issue.created'),
            updated: integer(row.updated, 0, 2 ** 53, 'issue.updated'),
          })).filter(issue => !params.status || (Array.isArray(params.status)
            ? params.status.includes(issue.status) : issue.status === params.status));
        const scoped = issues.filter(issue => !issue.node_id || domain.has(issue.node_id));
        // Offer unresolved issues first in bounded model pages. Stable cursors
        // keep all remaining issue records accessible without loading their evidence.
        if (actor.role !== 'user') scoped.sort((a, b) =>
          Number(b.status === 'OPEN') - Number(a.status === 'OPEN')
          || a.created - b.created || a.id.localeCompare(b.id));
        const issueLimit = actor.role === 'user' ? limit : Math.min(limit, 4);
        return { ...pageList(scoped.slice(offset, offset + issueLimit), scoped.length), limit: issueLimit };
      }
      case 'issue': {
        if (typeof params.id !== 'string' || !params.id) fail('query "issue" needs params.id');
        const issue = this.store.getIssue(params.id);
        if (!issue || issue.cluster_id !== clusterId) fail('Issue not found', 404);
        if (issue.node_id && !domain.has(issue.node_id)) fail('issue is outside this agent\'s domain', 403);
        return { issue };
      }
      case 'audits': {
        const audits = this.store.all(
          "SELECT * FROM audits WHERE cluster_id=? AND decision='PENDING' ORDER BY created,id", clusterId)
          .map(row => ({
            id: textField(row.id, 'audit.id', 128),
            cluster_id: textField(row.cluster_id, 'audit.cluster_id', 128),
            node_id: optionalText(row.node_id, 'audit.node_id'),
            transaction_id: optionalText(row.transaction_id, 'audit.transaction_id'),
            auditor_agent_id: optionalText(row.auditor_agent_id, 'audit.auditor_agent_id'),
            kind: literalOf(row.kind, AUDIT_KINDS, 'audit.kind'),
            target_revision: optionalInteger(row.target_revision, 'audit.target_revision'),
            decision: literalOf(row.decision, AUDIT_DECISIONS, 'audit.decision'),
            evidence: decodeJson(row.evidence),
            created: integer(row.created, 0, 2 ** 53, 'audit.created'),
            decided: optionalInteger(row.decided, 'audit.decided'),
          }))
          .filter(audit => audit.node_id !== null && domain.has(audit.node_id));
        return pageList(audits.slice(offset, offset + limit), audits.length);
      }
case 'effects': {
        const userView = actor.role === 'user';
        const columns = userView
          ? 'e.*'
          : 'e.call_id,e.cluster_id,e.agent_id,e.node_id,e.tool,e.status,SUBSTR(e.error,1,200) AS error,e.created,e.settled';
        const effects = this.store.all(
          `SELECT ${columns}, CASE WHEN n.kind='worker' THEN n.parent_id ELSE n.id END AS owner_management_id
             FROM effects e LEFT JOIN nodes n ON n.id=e.node_id AND n.cluster_id=e.cluster_id
            WHERE e.cluster_id=?${params.agent_id ? ' AND e.agent_id=?' : ''}
            ORDER BY e.created DESC`,
          ...(params.agent_id ? [clusterId, params.agent_id] : [clusterId]),
        ).map(row => ({
          call_id: textField(row.call_id, 'effect.call_id', 128),
          cluster_id: textField(row.cluster_id, 'effect.cluster_id', 128),
          agent_id: textField(row.agent_id, 'effect.agent_id', 128),
          node_id: optionalText(row.node_id, 'effect.node_id'),
          tool: textField(row.tool, 'effect.tool', 128),
          status: literalOf(row.status, EFFECT_STATUSES, 'effect.status'),
          error: optionalText(row.error, 'effect.error'),
          created: integer(row.created, 0, 2 ** 53, 'effect.created'),
          settled: optionalInteger(row.settled, 'effect.settled'),
          owner_management_id: optionalText(row.owner_management_id, 'effect.owner_management_id'),
          // A host reader gets the whole receipt — the settled body and the
          // arguments it was called with — because the panel judges evidence
          // from it. A model role's page is deliberately cropped by the SQL
          // above, so those members stay absent rather than reading as null.
          ...(userView
            ? {
              lease_epoch: integer(row.lease_epoch, 0, 2 ** 53, 'effect.lease_epoch'),
              session_id: optionalText(row.session_id, 'effect.session_id'),
              turn_seq: optionalInteger(row.turn_seq, 'effect.turn_seq'),
              args: asJsonValue(decodeJson(optionalText(row.args, 'effect.args'))),
              body: optionalText(row.body, 'effect.body'),
              job_id: optionalText(row.job_id, 'effect.job_id'),
            }
            : {}),
        }))
          .filter(effect => effect.node_id === null || domain.has(effect.node_id));
        return pageList(effects.slice(offset, offset + limit), effects.length);
      }
      case 'effect': {
        if (typeof params.call_id !== 'string' || !params.call_id) fail('query "effect" needs params.call_id');
        const effect = this.store.getEffect(params.call_id);
        if (!effect || effect.cluster_id !== clusterId) fail('Effect receipt not found', 404);
        if (effect.node_id && !domain.has(effect.node_id)) fail('effect is outside this agent\'s domain', 403);
        const node = effect.node_id ? this.store.getNode(effect.node_id) : null;
        return { effect: { ...effect, owner_management_id: node?.kind === 'worker' ? node.parent_id : node?.id ?? null } };
      }
      case 'usage': {
        // Receipts are substantially wider than tree references. A role's
        // default 100-row page can exceed its entire context budget in one
        // tool result; the host-facing API retains its requested page size.
        const receiptLimit = actor.role === 'user' ? limit : Math.min(limit, 8);
        const { items, total } = this.store.usageReceiptsForDomain(clusterId, {
          ...(actor.role === 'user' ? {} : { scope_node_id: actor.node_id }),
          ...(typeof params.agent_id === 'string' ? { agent_id: params.agent_id } : {}),
          ...(typeof params.status === 'string' ? { status: params.status } : {}),
          limit: receiptLimit, offset,
        });
        return {
          usage: this.store.usageSummary(clusterId, { nodeId: actor.role === 'user' ? null : actor.node_id }),
          ...pageList(items, total),
          limit: receiptLimit,
        };
      }
      case 'deliveries': {
        const rows = this.store.all(
          `SELECT r.message_id, r.recipient, r.delivery_seq, r.status, r.acked, m.kind, m.from_agent, m.from_node,
                  COALESCE(a.node_id, m.from_node) AS recipient_node
             FROM recipients r JOIN messages m ON m.id=r.message_id LEFT JOIN agents a ON a.id=r.recipient
            WHERE m.cluster_id=? ORDER BY r.created, r.message_id, r.recipient`, clusterId)
          .map(row => ({
            message_id: textField(row.message_id, 'delivery.message_id', 128),
            recipient: textField(row.recipient, 'delivery.recipient', 128),
            delivery_seq: optionalInteger(row.delivery_seq, 'delivery.delivery_seq'),
            status: literalOf(row.status, DELIVERY_STATUSES, 'delivery.status'),
            acked: optionalInteger(row.acked, 'delivery.acked'),
            kind: textField(row.kind, 'delivery.kind', 64),
            from_agent: optionalText(row.from_agent, 'delivery.from_agent'),
            from_node: optionalText(row.from_node, 'delivery.from_node'),
            recipient_node: optionalText(row.recipient_node, 'delivery.recipient_node'),
          }))
          .filter(row => actor.role === 'user'
            || (row.recipient_node !== null && domain.has(row.recipient_node))
            || (row.from_node !== null && domain.has(row.from_node)));
        return pageList(rows.slice(offset, offset + limit), rows.length);
      }
      case 'context': {
        const agentId = params.agent_id ?? (actor.role === 'user' ? null : actor.agent_id);
        if (agentId === null) fail('query "context" needs params.agent_id for the host user');
        const contextAgent = this.store.getAgent(agentId);
        if (!contextAgent || contextAgent.cluster_id !== clusterId) fail('Context agent not found', 404);
        if (actor.role !== 'user' && !domain.has(contextAgent.node_id) && contextAgent.id !== actor.agent_id) {
          fail('context is outside this agent\'s domain', 403);
        }
        if (params.transaction_id && actor.role !== 'user') {
          const transaction = this.store.getTransaction(params.transaction_id);
          if (!transaction || transaction.cluster_id !== clusterId || !domain.has(transaction.node_id)) {
            fail('context transaction is outside this agent\'s domain', 403);
          }
        }
        const steps = this.store.all(
          `SELECT e.seq, e.data FROM events e WHERE e.cluster_id=? AND e.type='context-step'
             AND json_extract(e.data,'$.agent_id')=? ORDER BY e.seq DESC LIMIT 50`, clusterId, agentId);
        const summaryScope = params.transaction_id
          ? { transaction_id: params.transaction_id }
          : { node_id: actor.role === 'user' && contextAgent.role === 'worker'
            ? this.store.getNode(contextAgent.node_id)?.parent_id ?? contextAgent.node_id
            : contextAgent.node_id };
        return {
          agent_id: agentId,
          steps: steps.map(row => ({
            seq: integer(row.seq, 0, 2 ** 53, 'context-step.seq'),
            ...objectField(decodeJson(row.data), 'context-step.data'),
          })),
          summary: this.store.latestSummary(clusterId, summaryScope)?.data ?? null,
        };
      }
      case 'health': {
        // The latest evaluation, with the measured signals it was scored
        // against, plus the node's own closing evaluation when one exists.
        const nodeId = params.node_id ?? (actor.role === 'user' ? null : actor.node_id);
        if (actor.role !== 'user' && (!nodeId || !domain.has(nodeId))) fail('health is outside this agent\'s domain', 403);
        const latest = this.store.latestHealth(clusterId, { node_id: nodeId });
        return {
          health: latest,
          metrics: this.healthMetricNames(),
          signals: this.healthSignals(clusterId, { windowMs: this.config.staleMs }),
        };
      }
      case 'summary': {
        if (actor.role === 'user') return { summary: this.latestSummaryOf(clusterId, params) };
        const nodeId = params.node_id ?? actor.node_id;
        if (!domain.has(nodeId)) fail('summary is outside this agent\'s domain', 403);
        if (params.transaction_id) {
          const transaction = this.store.getTransaction(params.transaction_id);
          if (!transaction || transaction.cluster_id !== clusterId || !domain.has(transaction.node_id)) {
            fail('summary transaction is outside this agent\'s domain', 403);
          }
        }
        const row = this.store.latestSummary(clusterId, params.transaction_id
          ? { transaction_id: params.transaction_id } : { node_id: nodeId });
        const summary = row ? jsonRecordOf(row.data) : null;
        return { summary: row && summary ? { ...summary, as_of_seq: row.as_of_seq } : null };
      }
      case 'blackboard': {
        const entries = this.store.blackboardList(clusterId, params.prefix ?? null);
        return pageList(entries.slice(offset, offset + limit).map(row => ({
          key: row.key,
          value: asJsonValue(decodeJson(row.value)),
          revision: row.revision,
          updated_by: row.updated_by ?? null,
        })), entries.length);
      }
      default:
        fail(`Unknown query: ${String(what)}`);
    }
  }

  /**
   * The one user-facing query entry point: the same questions `query` answers,
   * tagged with the branch that produced them so a Remote consumer narrows
   * `data` instead of asserting the shape it hoped for.
   *
   * Validate the cluster identifier and page limit for both local and Remote
   * callers before entering the query branch.
   */
  queryCluster(id: string, what: FlowQueryKind, params: FlowQueryParams = {}): FlowQueryResult {
    const clusterId = typeof id === 'string' ? id.trim() : '';
    if (!clusterId) fail('query requires a cluster id', 400);
    if (typeof params.limit === 'number' && params.limit > 500) fail('query limit must not exceed 500', 400);
    const actor: FlowUserActor = { role: 'user', cluster_id: clusterId };
    switch (what) {
      case 'cluster': return { what: 'cluster', data: this.query(actor, 'cluster', params) };
      case 'nodes': return { what: 'nodes', data: this.query(actor, 'nodes', params) };
      case 'node': return { what: 'node', data: this.query(actor, 'node', params) };
      case 'transactions': return { what: 'transactions', data: this.query(actor, 'transactions', params) };
      case 'transaction': return { what: 'transaction', data: this.query(actor, 'transaction', params) };
      case 'audit': return { what: 'audit', data: this.query(actor, 'audit', params) };
      case 'agents': return { what: 'agents', data: this.query(actor, 'agents', params) };
      case 'allocations': return { what: 'allocations', data: this.query(actor, 'allocations', params) };
      case 'budgets': return { what: 'budgets', data: this.query(actor, 'budgets', params) };
      case 'issues': return { what: 'issues', data: this.query(actor, 'issues', params) };
      case 'issue': return { what: 'issue', data: this.query(actor, 'issue', params) };
      case 'audits': return { what: 'audits', data: this.query(actor, 'audits', params) };
      case 'effects': return { what: 'effects', data: this.query(actor, 'effects', params) };
      case 'effect': return { what: 'effect', data: this.query(actor, 'effect', params) };
      case 'usage': return { what: 'usage', data: this.query(actor, 'usage', params) };
      case 'deliveries': return { what: 'deliveries', data: this.query(actor, 'deliveries', params) };
      case 'context': return { what: 'context', data: this.query(actor, 'context', params) };
      case 'health': return { what: 'health', data: this.query(actor, 'health', params) };
      case 'summary': return { what: 'summary', data: this.query(actor, 'summary', params) };
      case 'blackboard': return { what: 'blackboard', data: this.query(actor, 'blackboard', params) };
    }
  }

  report(id: string): FlowReport {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    // Every number here is an exhaustive SQL aggregate. Detail lists are paged
    // explicitly and say so (`truncated` + `total`), because a report that
    // silently listed the first 500 rows of 1024 transactions would be read as
    // "there are 500".
    const transactionCounts = this.store.countTransactionsByStatus(id);
    const statusCounts = Object.fromEntries(transactionCounts.map(row => [row.status, Number(row.c)]));
    const totalTransactions = transactionCounts.reduce((sumTotal, row) => sumTotal + Number(row.c), 0);
    const nodes = this.store.nodesInSubtree(id, null);
    const agentsByRole = this.store.countAgentsByRole(id);
    const agentsTotal = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.c), 0);
    const liveAgents = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.live), 0);
    const activatedAgents = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.activated), 0);
    const audits = this.store.all('SELECT kind, decision, COUNT(*) AS c FROM audits WHERE cluster_id=? GROUP BY kind, decision', id);
    const issues = this.store.all('SELECT status, COUNT(*) AS c, SUM(corrections) AS corrections FROM issues WHERE cluster_id=? GROUP BY status', id);
    const effects = this.store.all('SELECT status, COUNT(*) AS c FROM effects WHERE cluster_id=? GROUP BY status', id);
    const subtree = new Map(this.store.subtreeSizes(id).map(row => [row.node_id, Number(row.size)]));
    const contextByAgent = this.store.latestOrchestratorContext(id)
      .map(row => ({ agent_id: String(row.agent_id ?? ''), total_tokens: row.tokens === null ? null : Number(row.tokens) }));
    const traffic = this.store.deliveryTraffic(id);
    const windowMs = 5 * 60_000;
    const txPage = this.store.listTransactions({ cluster_id: id, limit: 200 });
    return {
      cluster: { id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace, limits: cluster.limits },
      mechanism: {
        nodes: nodes.length,
        management_nodes: nodes.filter(n => n.kind === 'management').length,
        worker_nodes: nodes.filter(n => n.kind === 'worker').length,
        max_depth: this.store.maxNodeDepth(id),
        max_fan_out: Math.max(0, ...[...nodes.reduce((map, node) => map.set(node.parent_id ?? 'root', (map.get(node.parent_id ?? 'root') ?? 0) + 1), new Map()).values()]),
        agents_ever_created: agentsTotal,
        agents_live: liveAgents,
        agents_activated: activatedAgents,
        agents_by_role: Object.fromEntries(agentsByRole.map(row => [row.role, Number(row.c)])),
        transactions_by_status: statusCounts,
        transactions_total: totalTransactions,
        audits_pending: audits.filter(row => row.decision === 'PENDING').reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        issues_open: issues.filter(row => row.status === 'OPEN').reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        issues_total: issues.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        corrections: issues.reduce((sumTotal, row) => sumTotal + Number(row.corrections ?? 0), 0),
        usage: this.store.usageSummary(id),
        budgets: evaluateTree(this.store, id),
        leases_active: this.store.listLeases(id, {}).length,
        effects: effects.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        effects_by_status: Object.fromEntries(effects.map(row => [row.status, Number(row.c)])),
        sources_captured: this.store.countSources(id),
        message_deliveries: traffic.deliveries,
        events: this.store.latestEventSeq(id),
        // Control-plane scale indicators.
        subtree_size: Object.fromEntries(subtree),
        orchestrator_context: contextByAgent,
        agent_utilization: {
          live_agents: liveAgents,
          active_turns: this.#activeTurnCount(id),
          ratio: liveAgents > 0 ? Number((this.#activeTurnCount(id) / liveAgents).toFixed(4)) : null,
        },
        auditor_event_rate: {
          window_ms: windowMs,
          inbox_rows: this.store.countInboxSince(id, { role: 'auditor', since: this.timestamp() - windowMs }),
          per_second: Number((this.store.countInboxSince(id, { role: 'auditor', since: this.timestamp() - windowMs }) / (windowMs / 1000)).toFixed(4)),
        },
        communication_traffic: { ...traffic, cross_subtree_ratio: traffic.deliveries > 0 ? Number((traffic.cross_subtree / traffic.deliveries).toFixed(4)) : null },
      },
      transactions: {
        items: txPage.map(tx => ({
          id: tx.id, status: tx.status, revision: tx.revision, result_revision: tx.result_revision,
          objective: tx.objective.slice(0, 200), parent: tx.parent_transaction_id, node: tx.node_id, priority: tx.priority,
          validation: tx.validation ? { accepted: tx.validation.accepted, checks: tx.validation.checks?.length ?? 0 } : null,
        })),
        total: totalTransactions,
        truncated: txPage.length < totalTransactions,
      },
    };
  }

  dispose() {
    // Plugin teardown, IPC shutdown and disconnect can overlap. Every caller
    // waits for the same drain; none may close the store beneath another.
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose() {
    this.#disposed = true;
    this.#schedulingEnabled = false;
    this.#schedulingGeneration += 1;
    this.#persistenceAbort.abort(new Error('cluster runtime disposed'));
    this.#persistence = null;
    this.wake();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const live = [...this.#activeTurns.values()];
    for (const entry of live) entry.ac.abort(new Error('cluster runtime disposed'));
    // Keep the store open while asynchronous abort finishers settle, up to the
    // disposal deadline. Reconcile any remaining leases and reservations before
    // closing the database.
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), this.config.disposeTimeoutMs);
    let settled = false;
    try {
      settled = await Promise.race([
        Promise.allSettled([
          ...live.map(entry => entry.promise),
          ...(this.#recoveryPromise ? [this.#recoveryPromise] : []),
        ]).then(() => true),
        // A bounded deadline must be able to fire: an `unref`'d timer lets the
        // event loop drain while this promise is still pending — the teardown
        // then never reaches `store.close()`, and a caller awaiting disposal
        // waits forever for a bound that was supposed to end. The configured
        // deadline is the longest this instance can hold a caller.
        deadline.promise,
      ]);
    } finally {
      // The timer is referenced while it guards the race, so it must not outlive
      // it: a disposal whose turns settled immediately would otherwise hold the
      // event loop for the whole deadline.
      clearTimeout(timer);
    }
    try {
      this.#drainLiveTurns(live, { unresponsive: !settled });
    } catch (error) {
      this.logger?.warn?.(error);
    }
    let afterId = '';
    for (;;) {
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      for (const cluster of page) {
        try {
          this.terminateClusterJobs(cluster.id, 'cluster runtime disposed');
        } catch (error) {
          this.logger?.warn?.(error);
        }
      }
      const lastCluster = page.at(-1);
      if (!lastCluster) break;
      afterId = lastCluster.id;
      if (page.length < 200) break;
    }
    this.#activeTurns.clear();
    this.store.close();
  }

  /**
   * Close out the turns that were live at teardown, deterministically: their
   * leases are fenced and their identity returned to a schedulable state, and a
   * request that was reserved and never settled is recorded as unknown *without*
   * handing its token hold back — an unknown-cost send is not free capacity.
   */
  #drainLiveTurns(live: readonly ActiveTurnEntry[], { unresponsive = true }: { unresponsive?: boolean } = {}): void {
    const leases = live.map(entry => entry.lease).filter((lease): lease is LeaseRecord => lease !== null);
    // The receipt owns its accounting even if its turn is already gone. Visit
    // every remaining reservation through the same transition; a status-only
    // update would strand requests_reserved instead of consuming the attempt.
    const held = this.store.all("SELECT request_id, cluster_id, reservation_tokens FROM usage_receipts WHERE status='RESERVED'");
    for (const row of held) {
      const requestId = textField(row.request_id, 'usage_receipts.request_id', 128);
      const receiptCluster = textField(row.cluster_id, 'usage_receipts.cluster_id', 128);
      const reserved = integer(row.reservation_tokens ?? 0, 0, 2 ** 40, 'usage_receipts.reservation_tokens');
      try {
        settleLlmRequest(this.store, {
          cluster_id: receiptCluster,
          reservation: { request_id: requestId, tokens: reserved },
          usage: null,
          status: 'UNKNOWN',
          note: `the runtime stopped while this request was in flight; ${reserved} tokens stay held`,
        });
      } catch (error) {
        this.logger?.warn?.(error);
        this.store.tx(() => this.store.settleUsageReceipt(requestId, {
          status: 'UNKNOWN',
          note: `the runtime stopped while this request was in flight; ${reserved} tokens stay held`,
        }));
      }
    }
    this.store.tx(() => {
      for (const lease of leases) {
        const current = this.store.getLease(lease.id);
        if (!current) continue;
        // The messages this turn owned were never answered: its prompt did not
        // become durable, so they go back to the queue rather than dying with it.
        const taken = this.store.get(
          "SELECT json_extract(data,'$.inbox_ids') AS ids FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1",
          lease.cluster_id, lease.agent_id,
        );
        const rawIds = taken === undefined ? '[]' : stringColumn(taken.ids, 'turn-start.inbox_ids');
        let decodedIds: unknown;
        try { decodedIds = JSON.parse(rawIds); } catch { decodedIds = []; }
        const ids = Array.isArray(decodedIds)
          ? decodedIds.filter((id): id is string => typeof id === 'string')
          : [];
        if (Array.isArray(ids) && ids.length) {
          const reopened = this.store.reopenInbox(ids);
          if (reopened) {
            this.store.appendEvent(lease.cluster_id, 'inbox-reopened', {
              agent_id: lease.agent_id, count: reopened,
              reason: 'the runtime stopped before the turn proved its prompt durable',
            });
          }
        }
        this.store.deleteLease(lease.id);
        this.store.appendEvent(lease.cluster_id, 'lease-fenced', {
          agent_id: lease.agent_id, lease_id: lease.id, epoch: lease.epoch,
          reason: unresponsive
            ? 'the runtime stopped while this turn was live'
            : 'the turn was aborted during shutdown',
        });
        const agent = this.store.getAgent(lease.agent_id);
        if (agent && !AGENT_TERMINAL.has(agent.status)) this.store.updateAgent(lease.agent_id, { status: 'READY' });
      }
    });
  }

  // --------------------------------------------------------- wake/schedule

  wake() {
    const shared = this.#wakeResolve;
    this.#wakePromise = null;
    this.#wakeResolve = null;
    for (const resolve of this.#wakeups.splice(0)) resolve();
    shared?.();
  }

  /**
   * Resolve on the next scheduling event. One shared promise is reused, so a
   * settle loop that polls for hours cannot accumulate resolvers.
   */
  waitForWake() {
    if (this.#disposed) return Promise.resolve();
    if (!this.#wakePromise) {
      this.#wakePromise = new Promise(resolve => {
        this.#wakeResolve = resolve;
      });
    }
    return this.#wakePromise;
  }

  #ensureTicking() {
    if (this.#timer || this.#disposed || this.config.autoTick === false) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(error => this.logger?.error?.(error));
    }, this.config.tickMs);
    this.#timer.unref?.();
  }

  async tick() {
    if (this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      this.#reapTurns();
      this.#abortHungTurns();
      this.#sweepStrandedTransactions();
      // Every non-terminal cluster, in keyset pages: a fixed page of 50 would
      // stop scheduling the 51st cluster while claiming to tick them all.
      let afterId = '';
      for (;;) {
        const page = this.store.listOpenClusters({ afterId, limit: 200 });
        if (!page.length) break;
        for (const cluster of page) {
          this.#expireLeases(cluster.id);
          // eslint-disable-next-line no-await-in-loop
          await this.#scheduleCluster(cluster);
        }
        const lastCluster = page.at(-1);
        if (!lastCluster) break;
        afterId = lastCluster.id;
        if (page.length < 200) break;
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Drive the cluster until it reaches a terminal or blocked state, or the deadline passes. */
  async runUntilSettled(id: string, { timeoutMs = 3_600_000, pollMs = 250 }: { timeoutMs?: number | undefined; pollMs?: number | undefined } = {}): Promise<FlowSnapshot> {
    const deadline = Date.now() + timeoutMs;
    // A settle request must not drive scheduling past the readiness barrier.
    while (!this.#schedulingEnabled && !this.#disposed && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (;;) {
      if (this.#disposed) return this.read(id, { include_events: false });
      const cluster = this.store.getCluster(id);
      if (!cluster) fail('Cluster not found', 404);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(cluster.status)) return this.read(id, { include_events: false });
      // In-flight requests can release enough capacity to clear BUDGET_EXHAUSTED.
      // Keep scheduling within this wait's deadline so reconciliation can resume
      // the cluster. Other stop reasons return immediately.
      const blockedForBudget = cluster.status === 'BLOCKED' && this.#recoverableBudgetStop(id);
      if (cluster.status === 'BLOCKED' && !blockedForBudget) return this.read(id, { include_events: false });
      if (blockedForBudget) {
        // Give the recovery its chance first — the resume, and one scheduling pass,
        // which is where a released reservation reopens the cluster…
        this.#resumeBudgetRepaired(cluster);
        // eslint-disable-next-line no-await-in-loop
        await this.#scheduleCluster(cluster);
        const after = this.store.getCluster(id) ?? fail('Cluster not found', 404);
        if (after.status === 'BLOCKED') {
          // …and only then decide. If nothing in flight can change capacity — no
          // reservation outstanding and no live turn — a budget stop is final, and
          // waiting on it would consume the whole settle deadline for nothing.
          const inFlight = Number(this.store.get(
            "SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND status='RESERVED'", id)?.c ?? 0) > 0
            || this.#activeTurnCount(id) > 0;
          if (!inFlight) return this.read(id, { include_events: false });
        }
      }
      if (Date.now() > deadline) return this.read(id, { include_events: false });
      this.#reapTurns();
      this.#expireLeases(id);
      // eslint-disable-next-line no-await-in-loop
      await this.#scheduleCluster(cluster);
      if (blockedForBudget) {
        const after = this.store.getCluster(id);
        if (!after || ['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(after.status)) return this.read(id, { include_events: false });
        if (after.status === 'BLOCKED' && !this.#recoverableBudgetStop(id)) return this.read(id, { include_events: false });
      }
      // One outstanding wakeup at a time: a long settle loop must not
      // accumulate resolvers it will never call.
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([this.waitForWake(), new Promise(resolve => setTimeout(resolve, pollMs))]);
    }
  }

  /**
   * Is this cluster's stop one that a settling request could still repair? True only
   * for a `BUDGET_EXHAUSTED` stop with a reservation outstanding somewhere in the
   * cluster: an in-flight request is the one thing that can release capacity without
   * anybody acting. Anything else — a mechanism failure, an uncertain effect, a
   * stagnation stop — returns false, so those remain immediate.
   */
  #recoverableBudgetStop(clusterId: string): boolean {
    const blocked = this.store.get(
      "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", clusterId);
    const data = blocked ? jsonRecordOf(decodeJson(textField(blocked.data, 'cluster-blocked.data'))) : null;
    return data?.code === 'BUDGET_EXHAUSTED';
  }

  async #scheduleCluster(cluster: ClusterRecord): Promise<void> {
    // One barrier for every driver: the interval, `tick()` and `runUntilSettled`
    // all reach scheduling through here.
    if (!this.#schedulingEnabled) return;
    const id = cluster.id;
    // Two drivers (the interval `tick()` and a `runUntilSettled` loop) can reach
    // this method concurrently. Without a per-cluster gate each snapshots the
    // active count, registers turns, and together they exceed the window.
    if (this.#scheduling.has(id)) return;
    this.#scheduling.add(id);
    try {
      // Restore budget-blocked nodes to ACTIVE once their request is affordable.
      // A balance change alone cannot make a BLOCKED node schedulable.
      this.#resumeBudgetRepaired(cluster);
      this.#applyCorrectionBudgetStops(cluster);
      await this.#scheduleClusterLocked(cluster);
    } finally {
      this.#scheduling.delete(id);
    }
  }

  /**
   * Resume what a budget repair has made runnable again — and nothing else.
   *
   * Only a node whose last stop was `BUDGET_EXHAUSTED` is considered, and only when
   * its own file can pay a turn: every other stop reason (a mechanism failure, an
   * uncertain effect, an exhausted role) keeps the node blocked, which is what makes
   * this transition safe rather than a general unblock. The cluster itself is
   * reopened the same way, since scheduling iterates RUNNING clusters only.
   */
  /**
   * Apply a recorded correction-budget stop. The guard refuses the round, and the node
   * stop is applied here so the refusal's rollback cannot take it with it.
   */
  #applyCorrectionBudgetStops(cluster: ClusterRecord): void {
    // The stops are remembered in memory, not in the ledger: the guard refuses the round
    // by throwing, which rolls its transaction back, and an event written inside it would
    // be rolled back with it.
    const stops = this.#correctionStops.get(cluster.id) ?? [];
    if (!stops.length) return;
    this.#correctionStops.delete(cluster.id);
    for (const stop of stops) {
      this.blockNodeInternal(cluster.id, stop.node_id,
        `correction budget exhausted for transaction ${stop.transaction_id}: ${stop.used} of ${stop.max_corrections} rounds failed`,
        'CORRECTION_BUDGET_EXHAUSTED');
      this.store.tx(() => this.store.appendEvent(cluster.id, 'correction-budget-applied', {
        node_id: stop.node_id, transaction_id: stop.transaction_id,
      }));
    }
  }

  /** The guard's refusal cannot write to the ledger (it throws); the stop is noted here. */
  noteCorrectionBudgetStop(clusterId: string, { nodeId, transactionId, used, maxCorrections }: { nodeId: string | null; transactionId: string | null; used: number; maxCorrections: number }): void {
    if (!nodeId) return;
    const stops = this.#correctionStops.get(clusterId) ?? [];
    stops.push({ node_id: nodeId, transaction_id: transactionId ?? null, used, max_corrections: maxCorrections });
    this.#correctionStops.set(clusterId, stops);
  }

  #resumeBudgetRepaired(cluster: ClusterRecord): void {
    const lastEvent = (type: string, nodeId: string) => this.store.get(
      `SELECT seq, data FROM events WHERE cluster_id=? AND type=? AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1`,
      cluster.id, type, nodeId,
    );
    /**
     * Resume only budget-blocked nodes whose failed request is fully affordable.
     * Recheck the recorded envelope against an authorized payer and its deadline.
     */
    /**
     * Read the failed identity's complete request envelope. Its payer can be
     * an Agent or compaction pool, independently of the node's own scope.
     */
    const envelopeOf = (block: Record<string, SQLOutputValue>) => {
      const data = jsonRecordOf(JSON.parse(textField(block.data, 'event.data', 1 << 20)));
      const agentId = typeof data?.agent_id === 'string' ? data.agent_id : null;
      if (!agentId) return null;
      // Resume requires every dimension of the recorded request envelope.
      // The dimension named by a refusal alone cannot establish affordability.
      const recorded = jsonRecordOf(data?.envelope);
      const refusal = this.store.get(
        `SELECT data FROM events WHERE cluster_id=? AND type='budget-refused' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1`,
        cluster.id, agentId,
      );
      const refused = refusal ? jsonRecordOf(JSON.parse(textField(refusal.data, 'event.data', 1 << 20))) : null;
      const tokens = Number(recorded?.tokens ?? (refused?.dimension === 'tokens' ? refused?.requested : 0));
      const modelRequests = Number(recorded?.model_requests ?? (refused?.dimension === 'model_requests' ? refused?.requested : 0));
      const toolCalls = Number(recorded?.tool_calls ?? (refused?.dimension === 'tool_calls' ? refused?.requested : 0));
      if (![tokens, modelRequests, toolCalls].some(value => Number.isFinite(value) && value > 0)) return null;
      return {
        agentId,
        tokens: Number.isFinite(tokens) ? tokens : 0,
        modelRequests: Number.isFinite(modelRequests) ? modelRequests : 0,
        toolCalls: Number.isFinite(toolCalls) ? toolCalls : 0,
      };
    };
    /**
     * One legal payer must cover the whole envelope under a live deadline.
     * Settlement can release unused reservations without a transfer event,
     * so current available capacity determines whether the node can resume.
     */
    const affordable = (envelope: { readonly agentId: string; readonly tokens: number; readonly modelRequests: number; readonly toolCalls: number }) => {
      const agent = this.store.getAgent(envelope.agentId);
      if (!agent) return false;
      // Every scope the request could legally be charged to, whichever kind it is:
      // the chain the runtime builds depends on the request's kind (the pool is
      // preferred for compactions), and a resume must not miss the pool just because
      // it does not know what the retried request will be.
      const candidates = [...new Set([
        ...this.budgetChainForAgent(agent, { tokens: envelope.tokens, requests: envelope.modelRequests }),
        this.compactionBudgetId(cluster.id),
        this.store.budgetForScope(cluster.id, 'agent', agent.id)?.id,
        this.fundingBudget(cluster, agent)?.id,
      ].filter((id): id is string => typeof id === 'string'))];
      const now = this.timestamp();
      return candidates.some(id => {
        const row = this.store.getBudget(id);
        if (!row) return false;
        const deadline = effectiveDeadline(this.store, row);
        if (deadline !== null && deadline <= now) return false;
        return dimensionAvailable(row, 'tokens') >= envelope.tokens
          && dimensionAvailable(row, 'model_requests') >= envelope.modelRequests
          && dimensionAvailable(row, 'tool_calls') >= envelope.toolCalls;
      });
    };
    const repaired = new Set();
    for (const row of this.store.all("SELECT id FROM nodes WHERE cluster_id=? AND status='BLOCKED'", cluster.id)) {
      const nodeId = textField(row.id, 'node.id', 128);
      const block = lastEvent('node-blocked', nodeId);
      if (!block) continue;
      const blockData = jsonRecordOf(JSON.parse(textField(block.data, 'event.data', 1 << 20)));
      if ((typeof blockData?.code === 'string' ? blockData.code : null) !== 'BUDGET_EXHAUSTED') continue;
      const envelope = envelopeOf(block);
      if (!envelope) continue;
      if (!affordable(envelope)) {
        // Admission already tried to reclaim this node's idle grants. A sibling
        // may still have held a live lease *then* and released it since. Retry
        // that same in-node transfer at the repair point; never take capacity
        // from a different subtree or mint quota. In a strict recursion run the
        // root Allocator finished with 271k free tokens while the root
        // Orchestrator stayed blocked for a 19k compaction request.
        const agent = this.store.getAgent(envelope.agentId);
        if (agent) this.topUpBudgetForAgent(agent, {
          tokens: envelope.tokens,
          model_requests: envelope.modelRequests,
          tool_calls: envelope.toolCalls,
        });
        if (!affordable(envelope)) continue;
      }
      repaired.add(nodeId);
      this.store.tx(() => {
        this.store.updateNode(nodeId, { status: 'ACTIVE' });
        this.store.appendEvent(cluster.id, 'node-resumed', { node_id: nodeId, code: 'BUDGET_REPAIRED' });
      });
      // The agents of a resumed node were blocked with it: they are the ones whose
      // turns the repair exists to make possible.
      this.store.tx(() => {
        for (const agent of this.store.listAgents(cluster.id, { node_id: nodeId, limit: 64 })) {
          if (agent.status !== 'BLOCKED') continue;
          this.store.updateAgent(agent.id, { status: 'READY' });
        }
      });
    }
    const blockedCluster = this.store.getCluster(cluster.id);
    if (!blockedCluster || blockedCluster.status !== 'BLOCKED') return;
    const clusterCode = (() => {
      const row = this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", cluster.id);
      return row ? jsonRecordOf(JSON.parse(textField(row.data, 'event.data', 1 << 20)))?.code ?? null : null;
    })();
    if (clusterCode !== 'BUDGET_EXHAUSTED') return;
    // The cluster reopens for the node whose stop *was* the cluster's stop — the
    // root — and only once that node passed the same tests. A nonblocked node with
    // tokens somewhere else says nothing about the reason this cluster stopped.
    const clusterBlock = this.store.get(
      "SELECT seq, data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", cluster.id);
    const blockData = clusterBlock
      ? jsonRecordOf(JSON.parse(textField(clusterBlock.data, 'event.data', 1 << 20))) : null;
    const causeNode = typeof blockData?.node_id === 'string' ? blockData.node_id : null;
    const rootNode = this.store.listNodes(cluster.id, { parent_id: null })[0]?.id ?? null;
    if (!repaired.has(causeNode ?? rootNode)) return;
    this.store.tx(() => {
      this.store.updateCluster(cluster.id, { status: 'RUNNING' });
      this.store.appendEvent(cluster.id, 'cluster-resumed', { code: 'BUDGET_REPAIRED' });
    });
  }

  async #scheduleClusterLocked(cluster: ClusterRecord): Promise<void> {
    const id = cluster.id;
    // The caller may hold a stale RUNNING snapshot: a role can block the root
    // between that snapshot and admission. Only a successfully repaired cluster
    // may launch more turns, even if its child nodes are still ACTIVE.
    if (this.store.getCluster(id)?.status !== 'RUNNING') return;
    const limits = cluster.limits;
    const budget = this.store.budgetForScope(id, 'root', id);
    // Grants move `limit` down the tree, so the cluster's remaining capacity is
    // the sum over every scope, never the root row alone.
    const rollup = rollupBudgets(this.store, id);
    const requestsLeft = rollup.model_requests.limit - rollup.model_requests.reserved - rollup.model_requests.spent;
    const toolsLeft = rollup.tool_calls.limit - rollup.tool_calls.reserved - rollup.tool_calls.spent;
    // The whole cluster's remaining capacity, not one scope's: a node that
    // still holds tokens while the cluster's total is spent cannot fund a
    // request, and starting one would only overshoot the declared budget.
    const tokensLeft = rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent;
    // Coded reasons: the reader (and the acceptance ledger) classifies a stop
    // without parsing the sentence that explains it.
    if (rollup.tokens.limit > 0 && tokensLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (tokens)', 'BUDGET_EXHAUSTED');
      return;
    }
    if (rollup.model_requests.limit > 0 && requestsLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (model requests)', 'BUDGET_EXHAUSTED');
      return;
    }
    if (rollup.tool_calls.limit > 0 && toolsLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (tool calls)', 'BUDGET_EXHAUSTED');
      return;
    }
    const deadline = budget ? effectiveDeadline(this.store, budget) : null;
    if (deadline !== null && deadline <= this.timestamp()) {
      this.blockClusterInternal(id, 'LIMIT_REACHED: cluster wall-time deadline passed', 'DEADLINE_PASSED');
      return;
    }

    // The message fixture is idempotent by message id, so it can be attempted
    // on every tick until its target exists.
    this.deliverFixtureMessages(cluster);

    const nodes = this.store.activeManagementNodes(id);
    const root = this.store.listNodes(id, { parent_id: null })[0];
    if (root?.status === 'BLOCKED'
      && !this.#hasActiveDelegatedWork(this.store.nodesInSubtree(id), root.id)
      && this.#activeTurnCount(id) === 0) {
      // A root budget refusal was deferred only while independent descendants
      // could finish and return capacity. Nothing remains to repair it now.
      const stopped = this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        id, root.id,
      );
      const detail = jsonRecordOf(stopped ? JSON.parse(textField(stopped.data, 'event.data', 1 << 20)) : null);
      this.blockClusterInternal(id, typeof detail?.reason === 'string' ? detail.reason : 'BUDGET: root could not fund its next request',
        typeof detail?.code === 'string' ? detail.code : 'BUDGET_EXHAUSTED', { node_id: root.id });
      return;
    }
    if (!nodes.length) {
      this.evaluateCompletion(id);
      return;
    }

    const rotation = this.#rotation.get(id) ?? 0;
    // Prioritize nodes with roles that have never been admitted, then rotate.
    // Readiness is checked per role: an admitted Orchestrator does not establish
    // that its Allocator and Auditor have had a chance to run.
    const freshRoles = (nodeId: string) => {
      const roles: FlowAgentRole[] = [];
      for (const role of MANAGEMENT_ROLES) {
        const agent = this.roleAgentOf(id, nodeId, role);
        if (!agent || agent.status !== 'READY' || this.#activeTurns.has(agent.id)) continue;
        const started = Number(this.store.get(
          `SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=?`,
          id, agent.id)?.c ?? 0);
        if (started === 0) roles.push(role);
      }
      return roles;
    };
    const withFreshRoles = nodes.filter(node => freshRoles(node.id).length > 0);
    const ordered = [
      ...rotate(withFreshRoles, rotation),
      ...rotate(nodes.filter(node => !withFreshRoles.includes(node)), rotation),
    ];
    const refusalsBefore = this.#refusals.get(id) ?? 0;
    let registered = 0;

    // Management and Worker turns share the active window. Reserve a slot
    // for a waiting Worker so supervision cannot consume the entire window.
    const workerWaiting = this.store.readyForWorker(id, { limit: 1 }).length > 0;
    // A one-slot window is a serialization: management work is effectively endless
    // (a role always has something to look at), so taking the slot every pass starves
    // the Worker for as long as management keeps finding work. The slot alternates.
    const singleSlot = limits.max_active_agents === 1;
    const lastClass = this.#lastAdmittedClass.get(id) ?? null;
    const { managementCeiling } = scheduleAdmission({ window: limits.max_active_agents, workerWaiting });
    const yieldSlotToWorker = singleSlot && workerWaiting && lastClass === 'management';
    // Read the active count before every admission. Starts registered in this
    // pass are already included; rotation counters must not add them again.
    for (const node of ordered) {
      if (yieldSlotToWorker) break;
      // The total active-turn count enforces the hard capacity limit.
      // The management count separately enforces its class share, leaving room
      // for a waiting Worker without excluding management behind active Workers.
      if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
      if (this.#activeTurnCount(id, 'management') >= managementCeiling) break;
      // Roles with no admitted turn take priority; otherwise rotate from the
      // node's last actual start so a tight window gives each role a turn.
      const fresh = freshRoles(node.id);
      const roleOrder = fresh.length
        ? [...fresh, ...MANAGEMENT_ROLES.filter(role => !fresh.includes(role))]
        : MANAGEMENT_ROLES;
      const offset = (this.#roleRotation.get(node.id) ?? 0) % roleOrder.length;
      for (let index = 0; index < roleOrder.length; index += 1) {
        const role = roleOrder[(offset + index) % roleOrder.length];
        if (!role) continue;
        if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
        if (this.#activeTurnCount(id, 'management') >= managementCeiling) break;
        const agent = this.roleAgentOf(id, node.id, role);
        if (!agent || agent.status === 'TERMINATED' || agent.status === 'BLOCKED' || (agent.meta.ui_state === 'waiting_user' && agent.meta.reply_pending !== true) || this.#activeTurns.has(agent.id)) continue;
        if (agent.turns >= limits.max_role_turns) {
          this.blockNodeInternal(id, node.id, `role ${role} exhausted its turn budget (${limits.max_role_turns})`);
          continue;
        }
        const pending = this.#pendingFor(role, node, cluster, agent);
        if (!pending.length) continue;
        const outcome = await this.#startTurn(cluster, agent, role, { node, pending });
        if (outcome?.started) {
          registered += 1;
          if (singleSlot) this.#lastAdmittedClass.set(id, 'management');
          // Next pass starts where this one left off, so a later role gets the slot.
          this.#roleRotation.set(node.id, (offset + index + 1) % roleOrder.length);
        }
      }
    }

    // Workers fill the remaining slots. The management reserve is already
    // expressed by the ceiling above, so subtracting it here again would leave
    // the window one slot short of what the pass actually admitted.
    const managementPending = ordered.some(node => MANAGEMENT_ROLES.some(role => {
      const agent = this.roleAgentOf(id, node.id, role);
      return agent !== null && agent.status !== 'TERMINATED' && agent.status !== 'BLOCKED' && (agent.meta.ui_state !== 'waiting_user' || agent.meta.reply_pending === true)
        && !this.#activeTurns.has(agent.id) && agent.turns < limits.max_role_turns
        && this.#pendingFor(role, node, cluster, agent).length > 0;
    }));
    const { workerSlots } = scheduleAdmission({
      window: limits.max_active_agents,
      active: this.#activeTurnCount(id),
      workerWaiting,
      managementActive: this.#activeTurnCount(id, 'management'),
      managementPending,
    });
    if (workerSlots > 0) {
      const workersStarted = await this.#scheduleWorkers(cluster, Math.min(workerSlots, limits.max_active_agents));
      registered += workersStarted;
      if (singleSlot && workersStarted > 0) this.#lastAdmittedClass.set(id, 'worker');
    }

    // The scheduler produces transaction-stall, provider-failure and load
    // notifications for the roles responsible for resolving them.
    this.#publishStaleTransactions(cluster);
    this.#publishLoad(cluster, limits);

    this.#rotation.set(id, (rotation + 1) % Math.max(1, ordered.length));
    void refusalsBefore;
    if (!registered) this.evaluateCompletion(id);
    else if (this.#activeTurns.size === 0) this.wake();
  }

  /**
   * `transaction-stale`: work that has not moved for longer than the staleness
   * window. Deduplicated per revision, so the notify is an event rather than a
   * per-tick stream.
   */
  #publishStaleTransactions(cluster: ClusterRecord): void {
    const staleBefore = this.timestamp() - this.config.staleMs;
    const now = this.timestamp();
    const rows = this.store.all(
      `SELECT id, revision, status, node_id, updated FROM transactions t
        WHERE t.cluster_id=? AND t.status IN ('READY','DISPATCHED','SUBMITTED','RUNNING') AND t.updated < ?
          AND NOT EXISTS (
            SELECT 1 FROM transactions child
              WHERE child.cluster_id=t.cluster_id AND child.parent_transaction_id=t.id
                AND child.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED'))
          AND NOT EXISTS (SELECT 1 FROM allocations a JOIN leases l ON l.agent_id = a.agent_id
                           WHERE a.transaction_id = t.id AND a.status='ACTIVE' AND l.expires > ?)
          AND NOT EXISTS (
            SELECT 1 FROM events e WHERE e.cluster_id=t.cluster_id AND e.type='transaction-stale'
              AND json_extract(e.data,'$.transaction_id')=t.id
              AND json_extract(e.data,'$.revision')=t.revision)
        ORDER BY t.updated LIMIT 8`, cluster.id, staleBefore, now);
    for (const row of rows) {
      const staleMs = Math.max(0, this.timestamp() - Number(row.updated));
      const transactionId = textField(row.id, 'transaction.id', 128);
      const nodeId = textField(row.node_id, 'transaction.node_id', 128);
      const revision = integer(row.revision, 0, Number.MAX_SAFE_INTEGER, 'transaction.revision');
      const status = textField(row.status, 'transaction.status', 128);
      // A transaction revision produces one stall notification, independently
      // of how many scheduler ticks observe the same stalled state.
      this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, nodeId, 'auditor')?.id, {
        subject: 'transaction-stale', payload: { transaction_id: transactionId, status, stale_ms: staleMs, revision },
        dedupeKey: `stale:${transactionId}:${revision}`,
      });
      this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, nodeId, 'orchestrator')?.id, {
        subject: 'transaction-stale', payload: { transaction_id: transactionId, status, stale_ms: staleMs, revision },
        dedupeKey: `stale:${transactionId}:${revision}`,
      });
      this.store.appendEvent(cluster.id, 'transaction-stale', {
        transaction_id: transactionId, status, stale_ms: staleMs, revision,
      });
    }
  }

  /**
   * `load-changed`: the window is saturated or work is queued for the model.
   * One report per time bucket, and the *fact* is notified and recorded
   * together: a saturated window is true on every tick, and a scan that wrote
   * an event each time buried the run's real events under thousands of rows.
   */
  #publishLoad(cluster: ClusterRecord, limits: FlowLimits): void {
    const active = this.#activeTurnCount(cluster.id);
    const waiting = this.llmWaiters(cluster.id);
    if (active < limits.max_active_agents && waiting === 0) return;
    const bucket = Math.floor(this.timestamp() / Math.max(1000, this.config.staleMs / 4));
    const key = `load:${cluster.id}:${bucket}`;
    const recipient = this.roleAgentOf(cluster.id, this.store.listNodes(cluster.id, { parent_id: null })[0]?.id, 'allocator')?.id ?? null;
    if (this.#alreadyNotified(key, recipient)) return;
    this.notifyInternal(cluster.id, recipient, {
      subject: 'load-changed',
      payload: { active_turns: active, max_active_agents: limits.max_active_agents, llm_waiters: waiting, llm_in_use: this.llmSlotsInUse(cluster.id) },
      dedupeKey: key,
    });
    this.store.appendEvent(cluster.id, 'load-changed', {
      active_turns: active, max_active_agents: limits.max_active_agents, llm_waiters: waiting,
    });
  }

  /** Whether this exact notification was already queued for this recipient. */
  #alreadyNotified(dedupeKey: string, recipient: string | null): boolean {
    return Boolean(this.store.get('SELECT id FROM inbox WHERE dedupe_key=?', `${dedupeKey}:${recipient ?? 'none'}`));
  }

  /** Registered turns for one cluster, read live rather than from a snapshot. */
  #activeTurnCount(id: string, klass: 'worker' | 'management' | null = null): number {
    let count = 0;
    for (const entry of this.#activeTurns.values()) {
      if (entry.cluster_id !== id) continue;
      if (klass === 'worker' && entry.role === 'worker') { count += 1; continue; }
      if (klass === 'management' && entry.role !== 'worker') { count += 1; continue; }
      if (klass === null) count += 1;
    }
    return count;
  }

  async #scheduleWorkers(cluster: ClusterRecord, slots: number): Promise<number> {
    const id = cluster.id;
    const limits = cluster.limits;
    let started = 0;
    // The eligible set is asked for in keyset pages and the pass stops when the
    // window is full, not when a fixed page runs out: a READY, allocated
    // transaction behind the first 200 still gets a Worker.
    let cursor = null;
    for (;;) {
      if (started >= slots) break;
      const page = this.store.readyForWorker(id, { after: cursor, limit: 100 });
      if (!page.length) break;
      for (const tx of page) {
        cursor = { priority: tx.priority, created: tx.created, id: tx.id };
        if (started >= slots) break;
        // The total resident-turn count enforces the hard capacity limit,
        // independently of the class allowance for this pass.
        if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
        const allocation = this.store.activeAllocationForTransaction(tx.id);
        if (!allocation) continue;
        // A revised transaction is a different plan. Its old Worker grant
        // cannot silently acquire authority over the new revision; the owning
        // Allocator must drain and replace it before scheduling another turn.
        if (this.store.allocationOutdated(id, allocation)) continue;
        const agent = this.store.getAgent(allocation.agent_id);
        if (!agent || agent.status === 'TERMINATED' || agent.status === 'BLOCKED' || (agent.meta.ui_state === 'waiting_user' && agent.meta.reply_pending !== true) || this.#activeTurns.has(agent.id)) continue;
        // eslint-disable-next-line no-await-in-loop
        const outcome = await this.#startWorkerTurn(cluster, agent, tx, allocation);
        if (outcome?.started) started += 1;
      }
      if (page.length < 100) break;
    }
    return started;
  }

  /** The pending actions for one role/node, exposed for tests and diagnostics. */
  pendingFor(role: FlowAgentRole, node: NodeRecord, cluster: ClusterRecord, agent: AgentRecord | null = null): readonly PendingAction[] {
    return this.#pendingFor(role, node, cluster, agent);
  }

  /** The delegation instructions a node still owes, for tests and diagnostics. */
  delegationInstructions(clusterId: string, nodeId: string): readonly DelegationFixtureEntry[] {
    const cluster = this.store.getCluster(clusterId);
    const node = this.store.getNode(nodeId);
    return cluster && node ? this.#requiredDelegation(cluster, node) : [];
  }

  /** The delegation instruction this node still owes, or null when none is due. */
  pendingDelegationInstruction(cluster: ClusterRecord, node: NodeRecord): DelegationFixtureEntry | null {
    const required = this.#requiredDelegation(cluster, node);
    const have = this.store.childrenOf(node.id).filter(child => child.kind === 'management').length;
    return have < required.length ? (required[have] ?? null) : null;
  }

  /**
   * A fixture entry is ready once its target has a live allocation and its
   * source is actually being worked on. Waiting for full acceptance would make
   * the delivery pipeline's exercise depend on the model converging.
   */
  #fixtureReady(cluster: ClusterRecord, entry: MessageFixtureEntry): boolean {
    const source = this.store.getTransaction(entry.from);
    if (!source) return false;
    return Boolean(this.#fixtureRecipient(cluster, entry));
  }

  /**
   * Who receives a fixture message: a Worker of another allocation (a different
   * worker node, so the delivery really crosses subtrees), or, when no sibling
   * is allocated yet, the Auditor of the source's management node. The fixture
   * must not depend on the model allocating one particular transaction.
   */
  #fixtureRecipient(cluster: ClusterRecord, entry: MessageFixtureEntry): AgentRecord | null {
    // A stable identity first: the Auditor of the source's management node
    // exists from cluster start, so the fixture fires once and always targets
    // the same agent. A sibling Worker is the fallback when no Auditor exists
    // (a Worker node is a different node from the source's, so the delivery
    // still crosses subtrees).
    const source = this.store.getTransaction(entry.from);
    // Prefer a Worker whose own node differs from the source's: that is the
    // cross-subtree delivery the fixture exists to exercise.
    const sourceNode = source ? this.store.getNode(source.node_id)?.parent_id ?? source.node_id : null;
    for (const allocation of this.store.listAllocations({ cluster_id: cluster.id, status: 'ACTIVE', limit: 500 })) {
      if (allocation.transaction_id === entry.from) continue;
      const agent = this.store.getAgent(allocation.agent_id);
      if (!agent || agent.status === 'TERMINATED') continue;
      const node = this.store.getNode(agent.node_id);
      if (node && node.parent_id === sourceNode) return agent;
    }
    // No sibling branch exists yet: the source's own management Auditor is a
    // different node, but the same management node as the sender.
    const rootId = source?.node_id ?? this.store.listNodes(cluster.id, { parent_id: null })[0]?.id;
    const auditor = rootId ? this.roleAgentOf(cluster.id, rootId, 'auditor') : null;
    return auditor && auditor.status !== 'TERMINATED' ? auditor : null;
  }

  /** Management children a node must still build according to the topology fixture. */
  #requiredDelegation(cluster: ClusterRecord, node: NodeRecord): readonly DelegationFixtureEntry[] {
    const fixture = cluster.spec?.delegation ?? [];
    if (!node.parent_id) return fixture;
    const spawn = node.scope?.spawn_children ?? 0;
    if (!spawn) return [];
    const entry = node.scope?.delegation_entry;
    if (!entry) return [];
    if (typeof entry.objective !== 'string' || typeof entry.max_children !== 'number'
      || typeof entry.spawn_children !== 'number') fail('Invalid delegation fixture', 409);
    const scope = `${node.scope?.objective ?? 'child'} / nested`;
    return [{
      scope,
      objective: entry.objective,
      max_children: entry.max_children,
      spawn_children: entry.spawn_children,
      ...(entry.budget ? { budget: entry.budget } : {}),
      ...(entry.inputs ? { inputs: jsonRecordOf(asJsonValue(entry.inputs)) ?? {} } : {}),
    }];
  }

  async #startTurn(
    cluster: ClusterRecord,
    agent: AgentRecord,
    role: FlowAgentRole,
    { node, pending }: { node: NodeRecord | null; pending: readonly PendingAction[] },
  ): Promise<{ readonly started: boolean; readonly agent_id?: string; readonly turn?: Promise<void> }> {
    if (!node) return { started: false };
    const id = cluster.id;
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      // An uncertain effect really stops the owner: a model turn can repeat the
      // same non-idempotent work through any tool it holds.
      this.store.tx(() => {
        this.store.updateAgent(agent.id, { status: 'BLOCKED' });
        this.store.appendEvent(id, 'agent-blocked', {
          agent_id: agent.id, role, code: 'EFFECT_UNCERTAIN', call_id: uncertain.call_id, tool: uncertain.tool,
          reason: `an earlier ${uncertain.tool} call may or may not have executed before the restart; resolve it with flow_allocation action "resolve_effect"`,
        });
        this.blockNodeInternal(id, node?.id ?? agent.node_id,
          `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) needs a decision before this identity runs again`,
          'EFFECT_UNCERTAIN');
      });
      return { started: false };
    }
    // Fund every required dimension before starting the turn. Reclaim or
    // transfer available capacity before classifying a genuine exhaustion.
    this.ensureTurnFunding(cluster, agent);
    const ac = new AbortController();
    this.#flowCalls.set(agent.id, 0);
    this.#toolCallLog.set(agent.id, []);
    // The notifications this turn is answering are consumed in the *same
    // transaction* that takes the lease and records the turn's start, so a crash
    // before the turn leaves them queued; a turn that took them and then failed
    // before admitting its prompt hands them back (see the finisher).
    const inboxIds = pending.flatMap(item => item.inbox_id ? [item.inbox_id] : []);
    // Acting on a refusal is once: the event is acknowledged in the same transaction
    // that takes the turn, so the pending action disappears — and a *new* refusal
    // (a higher seq) still surfaces.
    const refusalItems = (pending ?? []).filter(item => item.refusal_seq !== undefined).flatMap(item =>
      (item.refusal_seqs ?? [item.refusal_seq]).map(seq => ({
        seq: Number(seq), action: item.action,
        transaction_id: item.transaction_id ?? null, node_id: item.node_id ?? null,
      })));
    if (refusalItems.length) {
      // Remembered against the identity, with what each one is *about*, and not
      // acknowledged yet: a turn that fails or does nothing leaves the refusal
      // pending, and only a command that commits the matching correction or
      // escalation acknowledges it. Remembering just the seq dropped every refusal
      // whenever any unrelated command returned a transaction id — approving an
      // audit is not a correction.
      this.#pendingRefusals.set(agent.id, refusalItems);
    }
    // The paging cursor moves only for work this turn really took: the page the
    // Auditor is about to decide.
    if (role === 'auditor') {
      const taken = (pending ?? []).map(item => item.audit_id).filter((auditId): auditId is string => typeof auditId === 'string');
      if (taken.length) {
        const rows = taken.map(auditId => this.store.getAudit(auditId)).filter((audit): audit is AuditRecord => audit !== null);
        const last = rows.at(-1);
        if (last) {
          this.#auditCursor.set(node.id, { created: last.created, id: last.id });
        }
      } else if (this.#auditCursor.has(node.id)) {
        // Restart the audit scan from the oldest pending decision once the current
        // page sequence is exhausted, including audits inserted behind the cursor.
        this.#auditCursor.delete(node.id);
      }
    }
    this.store.appendEvent(id, 'turn-actions', {
      agent_id: agent.id, role, actions: (pending ?? []).map(item => item.action).slice(0, 16),
      inbox_consumed: inboxIds.length,
    });
    const lease = this.#acquireLease(cluster, agent, `${role}-turn`, inboxIds);
    // A refusal this turn took up is handled once: the acknowledgement is written
    // before the turn runs, in the same pass that admitted it.

    const turnSeq = agent.turns + 1;
    const identity = {
      cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, role,
      epoch: lease.epoch, lease_id: lease.id, turn_seq: turnSeq,
    };
    // Admission is an event, not a return value: a turn that admits the prompt
    // and then throws must still count as admitted, or its deliveries would be
    // reopened and injected a second time.
    let admittedThisTurn = false;
    let flushedThisTurn = false;
    let failures = this.#startFailures.get(agent.id) ?? 0;
    // Binding records both the identity and the live instance: the checkpoint
    // needs the instance to read its native session offset.
    const bind = (live: Agent) => {
      this.bindTurnIdentity(live, identity);
      const entry = this.#activeTurns.get(agent.id);
      if (entry) {entry.instance = live;this.#injectHumanPrompts(agent);}
    };
    const onAdmitted = () => {
      admittedThisTurn = true;
    };
    // A delivery is durable only when the host flush returns true.
    // Keep rejected flushes unacknowledged so their messages can be retried.
    const onFlushed = (ok: boolean) => {
      flushedThisTurn = ok !== false;
    };
    const budgetIds = this.agentBudgetChain(cluster, agent);
    // Deliveries are taken before the prompt is built: they are part of this
    // turn's input, and the prompt must name each message's stable id.
    const policy = this.allowedToolsFor(cluster, role, agent);
    const before = this.progressSeq(id);
    const turn = (async () => {
      let deliveries: CollectedDeliveries = {
        messages: [], ids: [], reconciled: 0,
      };
      let outcome: TurnOutcome | null = null;
      let error: unknown = null;
      let slot: (() => void) | null = null;
      // Permit acquisition, delivery collection and prompt construction all
      // belong inside the cleanup boundary. Every failure must book the turn,
      // release its lease and return unanswered messages to the queue.
      try {
        slot = await this.acquireLlmSlot(id);
        // Delivery collection happens inside the turn: it may have to prove
        // messages against the Session, and that wait must not hold the
        // scheduling pass that is filling the rest of the window.
        deliveries = await this.collectDeliveries(agent);
        const prompt = this.#rolePrompt(cluster, node, agent, role, pending);
        outcome = await runTurn(this.ctx, {
          agent, role, prompt,
          messages: this.#communicationMessages(agent, deliveries.messages, inboxIds),
          systemInstructions: role === 'worker' ? WORKER_PROMPT_HEADER : ROLE_INSTRUCTIONS[role],
          allowedTools: policy.allowed, globalTools: policy.global,
          capabilities: policy.capabilities, resume: agent.turns > 0, cwd: cluster.workspace,
          model: this.modelFor(agent), signal: ac.signal, logger: this.logger,
          budgetIds, turnSeq, flow: this, contextLimits: this.config.context,
          setup: agentCtx => this.#setupAgentScope(agentCtx, agent, role),
          forceCompact: this.#forceCompact.has(agent.id), onAgentReady: bind, onAdmitted, onFlushed,
        });
      } catch (cause) {
        error = cause;
      } finally {
        if (slot) slot();
      }
      this.#startFailures.set(agent.id, failures);
      this.#finishTurn(cluster, agent, role, { turnSeq, inboxIds,
        node, outcome, error, before, lease, deliveries: deliveries.ids, admitted: admittedThisTurn,
        durable: admittedThisTurn && flushedThisTurn, failures,
      });
    })();
    this.#activeTurns.set(agent.id, {
      promise: turn, ac, lease, cluster_id: id, agent_id: agent.id, node_id: node.id, role,
      started: this.timestamp(), instance: null, settled: false,
    });
    turn.catch(error => this.logger?.error?.(error));
    // Return after *registration*, not after completion: the scheduling pass
    // exists to fill the window, and awaiting the whole turn here would let one
    // driver start exactly one agent at a time.
    return { started: true, agent_id: agent.id, turn };
  }

  async #startWorkerTurn(cluster: ClusterRecord, agent: AgentRecord, tx: TransactionRecord, allocation: AllocationRecord): Promise<{ readonly started: boolean; readonly agent_id?: string; readonly turn?: Promise<void> }> {
    const turnSeq = agent.turns + 1;
    const id = cluster.id;
    // The last line of defence for a delegated parent that already holds an
    // allocation: eligibility excludes it, and admission refuses it too, so no path
    // can spend its attempts on work the children have not reported yet.
    if (this.store.parentsAwaitingChildren(id).includes(tx.id)) {
      this.store.appendEvent(id, 'worker-deferred', {
        transaction_id: tx.id, agent_id: agent.id,
        reason: 'delegated work is still unfinished; the parent waits for the child results',
      });
      return { started: false };
    }
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      this.store.tx(() => {
        this.store.updateAgent(agent.id, { status: 'BLOCKED' });
        this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        this.store.appendEvent(id, 'agent-blocked', {
          agent_id: agent.id, role: 'worker', code: 'EFFECT_UNCERTAIN', call_id: uncertain.call_id, tool: uncertain.tool,
          transaction_id: tx.id,
          reason: `an earlier ${uncertain.tool} call may or may not have executed before the restart; resolve it with flow_allocation action "resolve_effect"`,
        });
        this.blockNodeInternal(id, allocation.node_id,
          `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) needs a decision before this identity runs again`,
          'EFFECT_UNCERTAIN');
      });
      return { started: false };
    }
    // Fund every required dimension before starting the turn. Reclaim or
    // transfer available capacity before classifying a genuine exhaustion.
    this.ensureTurnFunding(cluster, agent);
    const ac = new AbortController();
    this.#flowCalls.set(agent.id, 0);
    this.#toolCallLog.set(agent.id, []);
    const lease = this.#acquireLease(cluster, agent, 'worker-turn');
    const identity = {
      cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, role: 'worker' as const,
      epoch: lease.epoch, lease_id: lease.id, turn_seq: agent.turns + 1,
    };
    // Admission is an event, not a return value: a turn that admits the prompt
    // and then throws must still count as admitted, or its deliveries would be
    // reopened and injected a second time. Durability is tracked separately:
    // admission alone does not make the message replay-safe.
    let admittedThisTurn = false;
    let flushedThisTurn = false;
    let failures = this.#startFailures.get(agent.id) ?? 0;
    const bind = (live: Agent) => {
      this.bindTurnIdentity(live, identity);
      const entry = this.#activeTurns.get(agent.id);
      if (entry) {entry.instance = live;this.#injectHumanPrompts(agent);}
    };
    const budgetIds = this.agentBudgetChain(cluster, agent);
    const policy = this.allowedToolsFor(cluster, 'worker', agent);
    const before = this.progressSeq(id);
    this.store.tx(() => {
      const current = this.store.getTransaction(tx.id) ?? fail('Transaction not found', 404);
      if (current.status === 'READY') setTransactionStatus(this.store, this, cluster, current, 'RUNNING');
      // The attempt is counted when the prompt is really admitted (see
      // `onAdmitted`), so an infrastructure rejection costs nothing.
    });
    const onAdmitted = () => {
      admittedThisTurn = true;
      this.store.tx(() => {
        const current = this.store.getTransaction(tx.id);
        if (!current || current.status !== 'RUNNING') return;
        this.store.updateTransaction(tx.id, { attempts: current.attempts + 1, __bump_revision: false });
      });
    };
    // A delivery is durable only when the host flush returns true.
    // Keep rejected flushes unacknowledged so their messages can be retried.
    const onFlushed = (ok: boolean) => {
      flushedThisTurn = ok !== false;
    };
    const turn = (async () => {
      let deliveries: CollectedDeliveries = { messages: [], ids: [], reconciled: 0 };
      let outcome: TurnOutcome | null = null;
      let error: unknown = null;
      let slot: (() => void) | null = null;
      try {
        slot = await this.acquireLlmSlot(id);
        deliveries = await this.collectDeliveries(agent);
        const prompt = this.#workerPrompt(cluster, tx, allocation);
        outcome = await runTurn(this.ctx, {
          agent, role: 'worker', prompt, allowedTools: policy.allowed, globalTools: policy.global,
          messages: this.#communicationMessages(agent, deliveries.messages),
          capabilities: policy.capabilities, resume: agent.turns > 0, cwd: cluster.workspace,
          model: this.modelFor(agent), signal: ac.signal, logger: this.logger,
          budgetIds, transactionId: tx.id, turnSeq, flow: this, contextLimits: this.config.context,
          forceCompact: this.#forceCompact.has(agent.id), onAgentReady: bind, onAdmitted, onFlushed,
          setup: agentCtx => this.#setupAgentScope(agentCtx, agent, 'worker'),
        });
      } catch (cause) {
        error = cause;
      } finally {
        if (slot) slot();
      }
      this.#startFailures.set(agent.id, failures);
      this.finishWorkerTurn(cluster, agent, tx, allocation, {
        outcome, error, before, lease, deliveries: deliveries.ids, admitted: admittedThisTurn,
        durable: admittedThisTurn && flushedThisTurn, failures, turnSeq,
      });
    })();
    this.#activeTurns.set(agent.id, {
      promise: turn, ac, lease, cluster_id: id, agent_id: agent.id, node_id: agent.node_id,
      role: 'worker', started: this.timestamp(), instance: null, settled: false,
    });
    turn.catch(error => this.logger?.error?.(error));
    // Registered, not awaited: the pass must be able to fill the remaining slots.
    return { started: true, agent_id: agent.id, turn };
  }

  #finishTurn(cluster: ClusterRecord, agent: AgentRecord, role: FlowAgentRole, options: TurnFinishOptions): void {
    const { node, outcome, error, before, lease, deliveries, admitted = false, durable = false, turnSeq = null, inboxIds = [] } = options;
    // Read the fencing verdict first: releasing the lease is what makes a later
    // read say "not held".
    const leaseValid = this.leaseStillHeld(lease);
    if (!leaseValid) {
      // The identity was replaced or the lease expired: this turn owns nothing
      // any more, so it must not touch the agent, the transaction or the budget.
      this.#forgetLease(lease);
      this.#activeTurns.delete(agent.id);
      try {
        this.store.appendEvent(cluster.id, 'turn-fenced', {
          agent_id: agent.id, role, turn: agent.turns + 1, lease_epoch: lease.epoch,
          note: 'the turn finished after its lease was replaced',
        });
      } catch (cause) {
        this.logger?.warn?.(cause);
      }
      this.wake();
      return;
    }
    this.#releaseLease(cluster.id, agent.id, lease);
    try {
      // The turn's decisions already happened, so a failed reconciliation
      // cannot undo them. It can, and must, fence the owner against acting
      // again until its accounting has a resolvable payer. Always book the
      // completed turn and its delivery facts below.
      let accountingUncertain = false;
      try {
        accountingUncertain = (this.reconcileReservations(cluster, agent)?.uncertain ?? 0) > 0;
      } catch (cause) {
        accountingUncertain = true;
        this.store.tx(() => this.store.appendEvent(cluster.id, 'accounting-uncertain', {
          agent_id: agent.id, transaction_id: null, reason: messageOf(cause).slice(0, 300),
          code: 'ACCOUNTING_UNCERTAIN',
        }));
      }
      if (accountingUncertain) {
        this.store.tx(() => this.store.updateAgent(agent.id, { status: 'BLOCKED' }));
        this.blockNodeInternal(cluster.id, agent.node_id,
          `ACCOUNTING_UNCERTAIN: ${role} cannot attribute the request from its last turn`,
          'ACCOUNTING_UNCERTAIN');
      }
      if (deliveries?.length) this.settleDeliveries(cluster.id, agent.id, deliveries, { admitted, durable });
      this.#settleHumanPrompts(cluster.id,agent.id,admitted,durable);
      // A turn that took messages and never made its prompt *durable* did not
      // answer them: not admitted, or admitted and then refused at the flush. They
      // go back to the queue, where the next pass offers them again.
      if (!durable && inboxIds.length) {
        const reopened = this.store.tx(() => this.store.reopenInbox(inboxIds));
        if (reopened) {
          this.store.appendEvent(cluster.id, 'inbox-reopened', {
            agent_id: agent.id, role, count: reopened,
            reason: admitted ? 'the prompt was admitted but its session was not flushed' : 'the prompt was never admitted',
          });
        }
      }
      this.store.tx(() => {
        const progress = this.progressSeq(cluster.id) !== before;
        const turns = agent.turns + 1;
        const overflowed = ['CONTEXT_WINDOW_EXCEEDED', 'PI_AI_ERROR'].includes(outcome?.stopDetail?.code ?? '')
          && /overflow|exceeds the maximum allowed length/i.test(String(outcome?.stopDetail?.message ?? ''));
        if (overflowed) {
          // A provider overflow is not the model's stagnation: ask for a forced
          // compaction before the next turn instead of counting it against it.
          this.#forceCompact.add(agent.id);
          this.store.appendEvent(cluster.id, 'context-overflow', { agent_id: agent.id, role, turn: turns });
        } else if (outcome?.stopReason === 'completed') {
          this.#forceCompact.delete(agent.id);
        }
        const stagnation = progress || overflowed ? 0 : agent.stagnation + 1;
        // A blocked accounting owner must not be made schedulable again merely
        // because the finisher booked its turn.
        const currentStatus = this.store.getAgent(agent.id)?.status ?? agent.status;
        this.store.updateAgent(agent.id, {
          turns: this.#bookTurn(agent, turnSeq, turns), stagnation,
          status: AGENT_TERMINAL.has(currentStatus) || currentStatus === 'BLOCKED' ? currentStatus : 'READY',
          epoch: lease.epoch,
        });
        this.store.insertCheckpoint({
          id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, session_id: agent.session_id,
          // Two different logs, recorded separately: the native session offset
          // is where the agent's own history stands, the event cursor is where
          // the cluster's own log stands.
          flushed_seq: outcome?.native_seq ?? null,
          events_seq: this.store.latestEventSeq(cluster.id),
          transaction_id: null, transaction_revision: null,
          inbox_ack_cursor: null, usage_watermark: this.usageWatermark(cluster.id), turn_seq: turns,
          data: { role, node_id: node?.id ?? null, stop_reason: outcome?.stopReason ?? 'error', model_requests: outcome?.usage?.length ?? 0 },
        });
        this.store.appendEvent(cluster.id, 'turn-end', {
          agent_id: agent.id, role, turn: turns,
          tools_used: [...new Set(this.#toolCallLog.get(agent.id) ?? [])].sort(),
          stop_reason: outcome?.stopReason ?? 'error',
          stop_detail: asJsonValue(outcome?.stopDetail ?? null),
          context: asJsonValue(outcome?.context ?? null),
          progress, error: error ? messageOf(error) : null,
        });
        if ((error || outcome?.stopReason === 'error')
          && !this.modelRequestRefusedThisTurn(cluster.id, agent.id, lease, outcome, error)) {
          this.recordAgentAnomaly({ ...agent, role }, {
            code: errorCode(error) ?? outcome?.stopDetail?.code ?? null,
            message: error ? messageOf(error).slice(0, 200) : (outcome?.stopDetail?.message ?? 'the model request failed'),
          });
        }
        if (!progress && stagnation >= 3) {
          // Only a terminal admission refusal since this identity's last progress
          // establishes budget starvation. Use its recorded payer and dimension;
          // a single empty scope or a repaired shortfall does not prove exhaustion.
          // With no qualifying refusal, the turn remains subject to stagnation limits.
          const progressSeq = this.store.get(
            `SELECT seq FROM events WHERE cluster_id=? AND type='turn-end'
              AND json_extract(data,'$.agent_id')=? AND json_extract(data,'$.progress') IN (1,'true')
              ORDER BY seq DESC LIMIT 1`, cluster.id, agent.id)?.seq ?? 0;
          const lastRefusal = this.store.get(
            `SELECT seq, data FROM events WHERE cluster_id=? AND type='budget-refused'
              AND json_extract(data,'$.agent_id')=? AND seq > ? ORDER BY seq DESC LIMIT 1`,
            cluster.id, agent.id, Number(progressSeq));
          const refused = lastRefusal ? jsonRecordOf(decodeJson(lastRefusal.data)) : null;
          const named = typeof refused?.dimension === 'string' ? refused.dimension : null;
          const scopeId = typeof refused?.scope === 'string' ? refused.scope : null;
          const scopeRow = scopeId ? this.store.get(
            "SELECT id FROM budgets WHERE cluster_id=? AND (scope_id=? OR id=?)", cluster.id, scopeId, scopeId,
          ) : undefined;
          const refusedScope = scopeRow ? this.store.getBudget(textField(scopeRow.id, 'budget.id', 256)) : null;
          const starved = named && (!refusedScope || dimensionAvailable(refusedScope, named) <= 0) ? [named] : [];
          const envelope = refused
            ? { tokens: named === 'tokens' ? Number(refused.requested ?? 0) || 0 : 0,
              model_requests: named === 'model_requests' ? Number(refused.requested ?? 0) || 0 : 0,
              tool_calls: named === 'tool_calls' ? Number(refused.requested ?? 0) || 0 : 0 }
            : null;
          const reason = starved.length
            ? `${role} could not act: its scope has no ${starved.join(' or ')} left`
            : `${role} made no state change across ${stagnation} turns`;
          // A starved role is a budget stop and is coded as one, so the report
          // classifies it without reading the sentence.
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            starved.length ? `BUDGET: ${reason}` : reason,
            starved.length ? 'BUDGET_EXHAUSTED' : null,
            starved.length ? { agent_id: agent.id, dimension: starved[0] ?? null, requested: asJsonValue(refused?.requested ?? null), envelope } : null);
        }
        if (outcome?.context_pressure && !outcome?.context_blocked) {
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, node?.id ?? agent.node_id, 'allocator')?.id, {
            subject: 'context-pressure-notice', payload: { agent_id: agent.id, tokens: outcome.context?.totalTokens ?? null },
          });
        }
        const refusal = this.contextRefusal(outcome, error, agent);
        if (refusal) {
          // A request refused before dispatch is not a model failure: name it
          // and stop the node instead of spending the turn budget of an identity
          // that cannot make its next request. The code decides the class — a
          // refusal the budget caused is a budget stop.
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            refusal.message.startsWith('BUDGET: ') ? refusal.message : `CONTEXT_PRESSURE: ${refusal.message}`,
            refusal.code);
        }
        if (outcome?.context_blocked) {
          const unfunded = Boolean(outcome.context?.compaction_unfunded);
          if (unfunded) {
            this.recordBudgetRefusal(agent, `compaction refused for lack of budget: ${outcome.context?.compaction_error}`);
          }
          const cause = unfunded ? ' (compaction could not be funded)' : '';
          // The producer knows which stop this is: an unfunded compaction is a
          // budget stop, and `context_blocked` carries that fact in its own
          // fields rather than leaving the reader to infer it from the message.
          const contextCode = outcome.context_code ?? (unfunded ? 'BUDGET_EXHAUSTED' : 'CONTEXT_PRESSURE');
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            contextCode === 'BUDGET_EXHAUSTED'
              ? `BUDGET: the session could not be compacted${cause} — ${role} holds ${outcome.context?.totalTokens ?? null} tokens`
              : `CONTEXT_PRESSURE${cause}: ${role} holds ${outcome.context?.totalTokens ?? null} tokens and compaction did not reduce it`,
            contextCode);
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, node?.id ?? agent.node_id, 'allocator')?.id, {
            subject: 'context-pressure', payload: { agent_id: agent.id, tokens: outcome.context?.totalTokens ?? null },
          });
        }
      });
    } finally {
      this.#activeTurns.delete(agent.id);
      try {
        // A management node can finish only after its last live role turn
        // releases. Retry both delegated acceptance and the root's explicit
        // finish request here, before a still-pending advisory audit admits
        // another turn and starves root closure.
        const finishedNode = this.store.getNode(agent.node_id);
        const rootFinished = finishedNode?.kind === 'management' && !finishedNode.parent_id
          && this.store.get(
            "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
            cluster.id, finishedNode.id,
          );
        if (finishedNode?.kind === 'management' && finishedNode.status !== 'COMPLETED'
          && (rootFinished || (finishedNode.delegated_transaction_id
            && this.store.getTransaction(finishedNode.delegated_transaction_id)?.status === 'ACCEPTED'))) {
          this.evaluateCompletion(cluster.id);
        }
      } finally {
        this.wake();
      }
    }
  }

  /**
   * Publish a Worker proposal only when its turn really completed. Every other
   * ending — provider error, abort, max-tokens, interrupted — withholds the
   * proposal, records why, and leaves the transaction re-dispatchable while
   * attempts remain.
   */
  finishWorkerTurn(cluster: ClusterRecord, agent: AgentRecord, tx: TransactionRecord, allocation: AllocationRecord, options: TurnFinishOptions): void {
    const { outcome, error, before, lease, deliveries, admitted = false, durable = false, turnSeq = null } = options;
    // Carry the runtime retry count across turns for this agent identity.
    let failures = options.failures ?? this.#startFailures.get(agent.id) ?? 0;
    const leaseValid = this.leaseStillHeld(lease);
    if (!leaseValid) {
      // A replacement may already have staged its own work on this
      // transaction; a fenced finisher clears nothing and publishes nothing.
      this.#forgetLease(lease);
      this.#activeTurns.delete(agent.id);
      try {
        this.store.appendEvent(cluster.id, 'turn-fenced', {
          agent_id: agent.id, role: 'worker', transaction_id: tx.id, lease_epoch: lease.epoch,
          note: 'the worker finished after its lease was replaced; nothing was published or cleared',
        });
      } catch (cause) {
        this.logger?.warn?.(cause);
      }
      this.wake();
      return;
    }
    this.#releaseLease(cluster.id, agent.id, lease);
    let accountingBlocked = false;
    try {
      // Bookkeeping must never stop the turn's result from being published — an
      // accounting anomaly is recorded and named and the work still lands — with
      // one exception: a reservation that cannot be attributed to a payer leaves
      // the turn's own accounting unknown, and a result published from it would
      // be a claim nothing can be charged to. That case blocks the transaction
      // and withholds the result.
      try {
        const reconciliation = this.reconcileReservations(cluster, agent, { transactionId: tx.id }) ?? {};
        accountingBlocked = Number(reconciliation.uncertain ?? 0) > 0;
      } catch (cause) {
        this.store.tx(() => this.store.appendEvent(cluster.id, 'accounting-uncertain', {
          agent_id: agent.id, transaction_id: tx.id, reason: messageOf(cause).slice(0, 300),
          code: errorCode(cause) ?? 'ACCOUNTING_UNCERTAIN',
        }));
        accountingBlocked = true;
      }
      if (deliveries?.length) this.settleDeliveries(cluster.id, agent.id, deliveries, { admitted, durable });
      this.#settleHumanPrompts(cluster.id,agent.id,admitted,durable);
      this.store.tx(() => {
        const current = this.store.getTransaction(tx.id);
        const rejectedRevision = current?.status === 'RUNNING'
          && this.store.findAudit(cluster.id, tx.id, 'plan', current.revision)?.decision === 'REJECTED';
        const progress = this.progressSeq(cluster.id) !== before;
        const started = admitted || error === null;
        if (!started) {
          // The same rule as a role turn: a failure before the model saw
          // anything must not advance the counter that selects create versus
          // resume, and must not consume the transaction's attempts.
          failures = (failures ?? 0) + 1;
          // Persist capability failures so the next attempt observes the retry
          // count and the bound can stop an unserviceable capability.
          this.#startFailures.set(agent.id, failures);
          this.store.appendEvent(cluster.id, 'turn-start-failed', {
            agent_id: agent.id, role: 'worker', transaction_id: tx.id, attempt: failures,
            error: error ? messageOf(error).slice(0, 300) : null,
          });
          const blocked = failures >= 3;
          if (blocked) {
            this.store.appendEvent(cluster.id, 'agent-blocked', {
              agent_id: agent.id, role: 'worker',
              reason: `three consecutive turns failed before reaching the model: ${error ? messageOf(error).slice(0, 200) : 'unknown'}`,
            });
            this.store.updateTransaction(tx.id, { status: 'READY', __bump_revision: false });
          }
          this.store.updateAgent(agent.id, { status: blocked ? 'BLOCKED' : 'READY' });
          if (rejectedRevision && this.store.getTransaction(tx.id)?.status === 'RUNNING') {
            setTransactionStatus(this.store, this, cluster, current, 'DRAFT');
          }
          return;
        }
        failures = 0;
        this.#startFailures.set(agent.id, failures);
        const turns = agent.turns + 1;
        const workerStatus = this.store.getAgent(agent.id)?.status ?? agent.status;
        this.store.updateAgent(agent.id, {
          turns: this.#bookTurn(agent, turnSeq, turns), stagnation: progress ? 0 : agent.stagnation + 1,
          status: AGENT_TERMINAL.has(workerStatus) ? workerStatus : 'READY',
        });

        // A fallback submission must carry the same native proof an explicit
        // result could cite. Tool names and statuses alone do not identify the
        // path, bytes, writer, or successful receipt an Auditor needs to judge.
        // Do not attribute effects from a previous turn of this Worker to this
        // result; the original receipts remain queryable through flow_query effects.
        const evidence = this.store.effects(cluster.id, { agent_id: agent.id, limit: 50 })
          .filter(effect => effect.lease_epoch === lease.epoch && effect.turn_seq === turns)
          .map(effect => ({
            call_id: effect.call_id, agent_id: effect.agent_id, node_id: effect.node_id,
            owner_management_id: effect.owner_management_id,
            tool: effect.tool, status: effect.status, job_id: effect.job_id ?? null,
            args: asJsonValue(decodeJson(effect.args)), body: asJsonValue(decodeJson(effect.body)),
          }));
        const blocked = current && ['PAUSED', 'BLOCKED', 'CANCELLED'].includes(current.status);
        const completed = outcome !== null && error === null && outcome.completed === true && leaseValid && !accountingBlocked;
        const stagedForThisTurn = current
          && current.result !== null && current.result !== undefined
          && current.result_staged_epoch === lease.epoch
          && current.result_staged_turn === turns;
        // The *identity* that staged the proposal is what makes it this Worker's
        // work; the turn counter is diagnosis, not permission. A paused Worker
        // that resumes is the same identity finishing the same job, and throwing
        // its staged result away — or replacing it with a prose summary —
        // destroys the only concrete evidence the Auditor could judge. A fenced
        // or replaced identity is blocked before this point.
        const stagedByThisWorker = current !== null
          && current.result !== null && current.result !== undefined
          && (current.result_staged_agent ?? null) === agent.id;
        const staged = stagedByThisWorker;

        if (current && current.status === 'RUNNING' && !blocked) {
          if (completed) {
            const result = staged
              ? current.result
              : { kind: 'worker-output', summary: outcome?.finalText ?? '', tool_calls: outcome?.toolCalls?.length ?? 0, evidence };
            const resultFields = jsonRecordOf(result);
            this.store.updateTransaction(tx.id, {
              status: 'SUBMITTED', result, result_revision: null, validation: null,
              result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null, __bump_revision: false,
            });
            // Models report inability through `completed: false`, `status`, or
            // `outcome`. Preserve all three spellings as one durable signal: the
            // Auditor must see the original blocked revision even if the
            // Orchestrator revises it before the validation audit is inspected.
            const incomplete = resultFields?.completed === false
              || (typeof resultFields?.status === 'string' && INCOMPLETE_WORKER_RESULT.test(resultFields.status))
              || (typeof resultFields?.outcome === 'string' && INCOMPLETE_WORKER_RESULT.test(resultFields.outcome));
            this.store.appendEvent(cluster.id, 'result-submitted', {
              transaction_id: tx.id, agent_id: agent.id, node_id: allocation.node_id,
              source: staged ? 'worker-tool' : 'turn-output',
              staged_for_this_turn: stagedForThisTurn,
              revision: current.revision,
              result_completed: incomplete ? false : asJsonValue(resultFields?.completed ?? null),
              result_status: asJsonValue(resultFields?.status ?? resultFields?.outcome ?? null),
            });
            this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
              subject: 'result-submitted', payload: { transaction_id: tx.id },
            });
            this.deliverFixtureMessages(cluster, this.store.getTransaction(tx.id));
          } else {
            const stopReason = error ? `exception: ${messageOf(error)}` : outcome?.stopReason ?? 'unknown';
            if ((error || outcome?.stopReason === 'error')
              && !this.modelRequestRefusedThisTurn(cluster.id, agent.id, lease, outcome, error)) {
              this.recordAgentAnomaly({ ...agent, role: 'worker' }, {
                transaction_id: tx.id,
                code: errorCode(error) ?? outcome?.stopDetail?.code ?? null,
                message: error ? messageOf(error).slice(0, 200) : (outcome?.stopDetail?.message ?? 'the model request failed'),
              });
            }
            // A request the provider would have refused is a context pathology:
            // the transaction is blocked with its coded reason rather than
            // retried into the same ceiling.
            const refusal = this.contextRefusal(outcome, error, agent);
            const contextBlocked = refusal !== null;
            const furtherAttempts = !contextBlocked && current.attempts < cluster.limits.max_attempts;
            if (contextBlocked) {
              this.blockNodeInternal(cluster.id, allocation.node_id,
                refusal.message.startsWith('BUDGET: ') ? refusal.message : `CONTEXT_PRESSURE: ${refusal.message}`,
                refusal.code);
            }
            this.store.updateTransaction(tx.id, {
              status: contextBlocked ? 'BLOCKED' : furtherAttempts ? 'READY' : 'FAILED',
              result: null, result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
              result_revision: null, validation: null, __bump_revision: false,
            });
            this.store.appendEvent(cluster.id, 'result-withheld', {
              transaction_id: tx.id, agent_id: agent.id, stop_reason: stopReason,
              had_submission: current.result !== null && current.result !== undefined,
              staged_binding_match: staged, attempts: current.attempts,
              next_status: contextBlocked ? 'BLOCKED' : furtherAttempts ? 'READY' : 'FAILED',
              // The producer's code, not a hardcoded one: a refusal the budget
              // caused is a budget stop even on this path.
              ...(contextBlocked ? { code: refusal.code } : {}),
            });
            this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
              subject: 'result-withheld', payload: { transaction_id: tx.id, stop_reason: stopReason },
            });
          }
        } else if (current && current.status === 'RUNNING') {
          this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        } else if (accountingBlocked) {
          // The transaction was blocked by the reconciliation itself: say so in
          // the turn's own record, and keep the staged result for the human
          // decision that resolves the accounting. Nothing is published.
          this.store.appendEvent(cluster.id, 'result-withheld', {
            transaction_id: tx.id, agent_id: agent.id, stop_reason: 'accounting-uncertain',
            had_submission: current?.result !== null && current?.result !== undefined,
            staged_binding_match: staged, attempts: current?.attempts ?? 0,
            next_status: 'BLOCKED', code: 'ACCOUNTING_UNCERTAIN',
          });
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
            subject: 'result-withheld', payload: { transaction_id: tx.id, stop_reason: 'accounting-uncertain' },
          });
        }
        if (rejectedRevision) {
          const finished = this.store.getTransaction(tx.id);
          if (finished && !TRANSACTION_TERMINAL.has(finished.status)
            && !['DRAFT', 'BLOCKED'].includes(finished.status)) {
            // The Worker finished under its original revision. Its native
            // write receipts and result remain evidence, but a rejected plan
            // cannot enter validation until the Orchestrator corrects it.
            setTransactionStatus(this.store, this, cluster, finished, 'DRAFT');
          }
        }
        this.store.insertCheckpoint({
          id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, session_id: agent.session_id,
          flushed_seq: outcome?.native_seq ?? null,
          events_seq: this.store.latestEventSeq(cluster.id), transaction_id: tx.id,
          transaction_revision: current?.revision ?? null, inbox_ack_cursor: null,
          usage_watermark: this.usageWatermark(cluster.id), turn_seq: turns,
          data: { role: 'worker', stop_reason: outcome?.stopReason ?? 'error', tool_calls: outcome?.toolCalls?.length ?? 0 },
        });
        this.store.appendEvent(cluster.id, 'turn-end', {
          agent_id: agent.id, role: 'worker', turn: turns, transaction_id: tx.id,
          tools_used: [...new Set(this.#toolCallLog.get(agent.id) ?? [])].sort(),
          stop_reason: outcome?.stopReason ?? 'error',
          stop_detail: asJsonValue(outcome?.stopDetail ?? null),
          error: error ? messageOf(error) : null,
          progress,
        });
      });
    } finally {
      this.#activeTurns.delete(agent.id);
    }
    this.wake();
  }

  /**
   * Request cancellation of a turn that exceeds its lifetime bound. Resource
   * release depends on the turn settling and running its cleanup handlers.
   */
  #abortHungTurns() {
    const cutoff = this.timestamp() - this.config.maxTurnMs;
    for (const [agentId, entry] of this.#activeTurns) {
      if ((entry.started ?? this.timestamp()) > cutoff) continue;
      try {
        this.store.appendEvent(entry.cluster_id, 'turn-aborted', {
          agent_id: agentId, role: entry.role, reason: 'the turn exceeded the maximum lifetime',
          age_ms: this.timestamp() - (entry.started ?? this.timestamp()),
        });
      } catch (error) {
        this.logger?.warn?.(error);
      }
      entry.ac.abort(new Error('turn exceeded the maximum lifetime'));
    }
  }

  /**
   * Return a transaction that is `RUNNING` with no live turn and no live lease
   * to the schedulable set.
   *
   * This is the recovery rule applied *during* a run: a turn whose identity
   * vanished (a killed stream, an expired lease, a finisher that never ran)
   * leaves its transaction RUNNING forever, and nothing else in the system will
   * ever look at it again. The event names it, so the sweep is evidence rather
   * than a silent cleanup.
   */
  #sweepStrandedTransactions() {
    const now = this.timestamp();
    const rows = this.store.all(
      `SELECT t.id, t.attempts, t.node_id FROM transactions t
        JOIN allocations a ON a.transaction_id = t.id AND a.status='ACTIVE'
        WHERE t.status='RUNNING' AND t.cluster_id = a.cluster_id
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.agent_id = a.agent_id AND l.expires > ?)
        LIMIT 100`, now);
    for (const row of rows) {
      const transactionId = textField(row.id, 'transaction.id', 128);
      const allocation = this.store.activeAllocationForTransaction(transactionId);
      if (!allocation || this.#activeTurns.has(allocation.agent_id)) continue;
      const cluster = this.store.getCluster(this.store.getTransaction(transactionId)?.cluster_id ?? '');
      if (!cluster) continue;
      const attempts = integer(row.attempts ?? 0, 0, 2 ** 20, 'transaction.attempts');
      const furtherAttempts = attempts < (cluster.limits.max_attempts ?? 2);
      this.store.tx(() => {
        this.store.updateTransaction(transactionId, {
          status: furtherAttempts ? 'READY' : 'BLOCKED',
          result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
          __bump_revision: false,
        });
        this.store.appendEvent(cluster.id, 'transaction-stranded', {
          transaction_id: transactionId, node_id: optionalText(row.node_id, 'transaction.node_id'),
          agent_id: allocation.agent_id,
          attempts, next_status: furtherAttempts ? 'READY' : 'BLOCKED',
          reason: 'the transaction was RUNNING with no live turn and no live lease', code: 'STRANDED_TURN',
        });
      });
    }
  }

  #reapTurns() {
    for (const [agentId, entry] of this.#activeTurns) {
      if (entry.settled) this.#activeTurns.delete(agentId);
    }
  }

  // -------------------------------------------------------------- leases

  #acquireLease(cluster: ClusterRecord, agent: AgentRecord, purpose: string, inboxIds: readonly string[] = []): LeaseRecord {
    return this.store.tx(() => {
      const existing = this.store.leaseForAgent(agent.id);
      if (existing && existing.expires > this.timestamp()) fail(`agent ${agent.id} already holds a live lease`, 409);
      if (existing) this.store.deleteLease(existing.id);
      const epoch = (existing?.epoch ?? agent.epoch) + 1;
      const at = this.timestamp();
      const lease = this.store.createLease({
        id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, purpose,
        epoch, expires: at + this.config.leaseTtlMs, event_upper_bound: this.store.latestEventSeq(cluster.id),
      });
      if (!lease) fail(`agent ${agent.id} could not take a turn lease`, 409);
      this.store.updateAgent(agent.id, { status: 'RUNNING', epoch, ...(agent.meta.reply_pending===true?{meta:{...agent.meta,ui_state:null,status_reason:null,waiting_since:null,reply_pending:false}}:{}) });
      // Ownership of the inbox rides with the same transaction as the lease: a
      // message is either still queued or owned by a turn that exists.
      if (inboxIds.length) this.store.consumeInbox(inboxIds);
      this.store.appendEvent(cluster.id, 'turn-start', {
        agent_id: agent.id, role: agent.role, purpose, epoch,
        inbox_taken: inboxIds.length, inbox_ids: inboxIds.slice(0, 16),
      });
      const beat = setInterval(() => {
        try {
          this.store.tx(() => this.store.touchLease(lease.id, this.timestamp() + this.config.leaseTtlMs));
        } catch (error) {
          this.logger?.warn?.(error);
        }
      }, this.config.heartbeatMs);
      beat.unref?.();
      this.#heartbeats.set(lease.id, beat);
      return lease;
    });
  }

  /**
   * Drop this turn's local traces without touching anything another turn now
   * owns: used when the lease was fenced before the turn finished.
   */
  #forgetLease(lease: LeaseRecord): void {
    this.#clearLeaseLocal(lease);
  }

  #clearLeaseLocal(lease: LeaseRecord): void {
    const beat = this.#heartbeats.get(lease.id);
    if (beat) {
      clearInterval(beat);
      this.#heartbeats.delete(lease.id);
    }
  }

  /**
   * Whether the exact lease this turn captured is still live and current. Must
   * be read before the lease is released.
   */
  leaseStillHeld(lease: LeaseRecord): boolean {
    const live = this.store.getLease(lease.id);
    return live !== null && live.epoch === lease.epoch;
  }

  #releaseLease(_clusterId: string, agentId: string, lease: LeaseRecord): void {
    this.#clearLeaseLocal(lease);
    const beat = this.#heartbeats.get(lease.id);
    if (beat) {
      clearInterval(beat);
      this.#heartbeats.delete(lease.id);
    }
    this.store.tx(() => {
      const current = this.store.getLease(lease.id);
      if (current) this.store.deleteLease(lease.id);
      const agent = this.store.getAgent(agentId);
      if (agent && !AGENT_TERMINAL.has(agent.status)) this.store.updateAgent(agentId, { status: 'READY' });
    });
  }

  #expireLeases(clusterId: string): void {
    const now = this.timestamp();
    const expired = this.store.expiredLeases(now).filter(lease => lease.cluster_id === clusterId);
    if (!expired.length) return;
    this.store.tx(() => {
      for (const lease of expired) {
        this.store.deleteLease(lease.id);
        const agent = this.store.getAgent(lease.agent_id);
        if (agent && agent.status === 'RUNNING') this.store.updateAgent(agent.id, { status: 'READY' });
        this.store.appendEvent(clusterId, 'lease-expired', { agent_id: lease.agent_id, epoch: lease.epoch });
      }
    });
  }

  usageWatermark(clusterId: string): number | null {
    const rows = this.store.listUsageReceipts(clusterId, { limit: 1 });
    return rows[0]?.created ?? null;
  }

  // ---------------------------------------------------------- llm slots

  /** Public: the Allocator's set_concurrency action adjusts the live semaphore. */
  setLlmConcurrency(limit: number | null | undefined, clusterId:string|null=null): void {
    const slots=this.#slotsFor(clusterId);
    slots.limit = Math.max(1, limit ?? 2);
    // Raising the cap must let queued work in immediately; lowering it must not
    // admit anything new until the running work drops below the new cap.
    this.#pumpLlmSlots(slots);
  }

  /** The declared per-Worker model-request allowance, or null when unlimited. */
  workerRequestAllowance(agent: AgentRecord | null): number | null {
    if (agent?.role !== 'worker') return null;
    return Number(this.store.getCluster(agent.cluster_id)?.limits?.worker_model_requests) || null;
  }

  /** Identities with a registered, unfinished turn. */
  activeTurnIds() {
    return [...this.#activeTurns.keys()];
  }

  /** Permits currently held by the concurrency gate. */
  llmSlotsInUse(clusterId?:string) {
    return clusterId?this.#slotsFor(clusterId).inUse:this.#llmSlots.inUse+[...this.#runLlmSlots.values()].reduce((sum,slots)=>sum+slots.inUse,0);
  }

  /** Waiters queued for a permit. */
  llmWaiters(clusterId?:string) {
    return clusterId?this.#slotsFor(clusterId).waiters.length:this.#llmSlots.waiters.length+[...this.#runLlmSlots.values()].reduce((sum,slots)=>sum+slots.waiters.length,0);
  }

  /** Number of in-flight cluster turns for one cluster. */
  inFlight(clusterId: string): number {
    return [...this.#activeTurns.values()].filter(entry => entry.cluster_id === clusterId).length;
  }

  /**
   * Bound the control-plane calls one turn may make. A model that keeps
   * retrying a rejected action burns tokens without changing state; the cap
   * turns that into one clear instruction instead of an unbounded loop.
   */
  admitFlowCall(agent: { readonly id: string }): number {
    const limit = DEFAULT_LIMITS.max_tool_calls_per_turn;
    const used = (this.#flowCalls.get(agent.id) ?? 0) + 1;
    this.#flowCalls.set(agent.id, used);
    if (used > limit) {
      fail(`control-plane call budget for this turn is exhausted (${limit} calls); stop calling tools, summarise what you changed and end the turn`, 409);
    }
    return used;
  }

  /**
   * The identity of the turn that owns one *live agent instance*. Keyed by the
   * object, not by session id: a later turn resumes a new instance, so an old
   * handle keeps its own stale identity and is fenced instead of borrowing the
   * new epoch.
   */
  turnActor(agentInstance: object | undefined | null): TurnIdentity | null {
    if (!agentInstance || (typeof agentInstance !== 'object' && typeof agentInstance !== 'function')) return null;
    return this.#turnIdentity.get(agentInstance) ?? null;
  }

  /** Register the identity of a live agent instance for the duration of its turn. */
  bindTurnIdentity(agentInstance: Agent, identity: TurnIdentity): void {
    this.#turnIdentity.set(agentInstance, identity);
  }

  /**
   * The native session offset of the live instance of one identity, or null
   * when it has no live instance to ask. Callers use it for checkpoints; it
   * never guesses.
   */
  sessionOffsetOf(sessionId: string): number | null {
    for (const entry of this.#activeTurns.values()) {
      const agent = this.store.getAgent(entry.agent_id);
      if (agent?.session_id === sessionId) return sessionOffset(entry.instance ?? null);
    }
    return null;
  }

  healthMetricNames() {
    return [...HEALTH_METRICS];
  }

  /**
   * Derive health signals from the durable ledger. The Auditor supplies its
   * judgement through evaluate_health; measurement remains deterministic.
   */
  healthSignals(clusterId: string, { windowMs = this.config.staleMs }: { windowMs?: number } = {}): FlowHealthSignals {
    if (!Number.isFinite(windowMs) || windowMs <= 0) fail('Health evaluation window must be a finite positive number');
    const at = this.timestamp();
    const windowStart = at - windowMs;
    const staleBefore = at - this.config.staleMs;
    const rootTotal = this.store.countTransactions(clusterId, { parent_transaction_id: null });
    const rootAccepted = this.store.countTransactions(clusterId, { parent_transaction_id: null, status: ['ACCEPTED'] });
    const statuses = Object.fromEntries(this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]));
    const total = Object.values(statuses).reduce((sum, count) => sum + count, 0);

    // decomposition quality: a unit of work is decomposed when it carries
    // checkable criteria and either children or dependencies.
    const decomposed = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM transactions t
        WHERE t.cluster_id=? AND json_array_length(t.acceptance_criteria) > 0
          AND (EXISTS (SELECT 1 FROM transactions c WHERE c.parent_transaction_id = t.id)
               OR EXISTS (SELECT 1 FROM dependencies d WHERE d.transaction_id = t.id))`, clusterId)?.c ?? 0);
    const orphans = Number(this.store.get(
      'SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND json_array_length(acceptance_criteria) = 0', clusterId)?.c ?? 0);

    // responsiveness: the median age of open MAJOR+ issues, and how many
    // submitted results have waited past the staleness window for a decision.
    const issueAges = this.store.all(
      `SELECT (? - created) AS age FROM issues
        WHERE cluster_id=? AND status='OPEN' AND severity IN ('MAJOR','CRITICAL','BLOCKER')
          AND created >= ?
        ORDER BY created`, at, clusterId, windowStart).map(row => Number(row.age));
    const median = (ages: readonly number[]): number | null => ages[Math.floor(ages.length / 2)] ?? null;
    const staleSubmitted = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='SUBMITTED' AND updated < ?", clusterId, staleBefore)?.c ?? 0);

    // planning stability: how often plans moved, and how often a rejected plan
    // came back only to be rejected again.
    const churn = this.store.all(
      "SELECT json_extract(data,'$.transaction_id') AS id, COUNT(*) AS c FROM events WHERE cluster_id=? AND at>=? AND type IN ('transaction-adjusted','decomposed') GROUP BY 1",
      clusterId, windowStart);
    const churnPerSurvey = churn.length ? Number((churn.reduce((sum, row) => sum + Number(row.c), 0) / churn.length).toFixed(4)) : 0;
    const rejectionCycles = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM (
         SELECT json_extract(data,'$.transaction_id') AS id, COUNT(*) AS c
           FROM events WHERE cluster_id=? AND at>=? AND type='transaction-status' AND json_extract(data,'$.to')='REJECTED'
          GROUP BY 1 HAVING COUNT(*) > 1)`, clusterId, windowStart)?.c ?? 0);

    // acceptance quality: accepted work whose recorded checks all carry evidence.
    const acceptedWithEvidence = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM transactions
        WHERE cluster_id=? AND status='ACCEPTED' AND validation IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(validation,'$.checks')) AS criterion
                           WHERE COALESCE(json_extract(criterion.value,'$.evidence'),'') = '')`, clusterId)?.c ?? 0);

    // result integration: accepted parents whose children have all settled.
    const acceptedParents = this.store.all(
      `SELECT id FROM transactions WHERE cluster_id=? AND status='ACCEPTED'
        AND EXISTS (SELECT 1 FROM transactions c WHERE c.parent_transaction_id = transactions.id)`, clusterId);
    const integrated = acceptedParents.filter(row => this.store.all(
      "SELECT status FROM transactions WHERE cluster_id=? AND parent_transaction_id=?", clusterId, row.id)
      .every(child => typeof child.status === 'string' && ['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(child.status))).length;

    const blockedStale = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='BLOCKED' AND updated < ?", clusterId, staleBefore)?.c ?? 0);
    const escalations = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='escalated' AND at >= ?", clusterId, windowStart)?.c ?? 0);

    const ratio = (numerator: number, denominator: number): number | null => (denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null);
    return {
      window_ms: windowMs,
      transaction_coverage: ratio(rootAccepted, rootTotal),
      decomposition_quality: { ratio: ratio(decomposed, total), decomposed, orphans },
      responsiveness: { median_issue_age_ms: median(issueAges), open_major_issues: issueAges.length, stale_submitted: staleSubmitted },
      planning_stability: { revisions_per_transaction: churnPerSurvey, rejection_cycles: rejectionCycles },
      goal_alignment: null,
      acceptance_quality: ratio(acceptedWithEvidence, statuses.ACCEPTED ?? 0),
      result_integration: ratio(integrated, acceptedParents.length),
      escalation_quality: blockedStale > 0 ? Math.min(1, Number((escalations / blockedStale).toFixed(4))) : (escalations > 0 ? 1 : null),
      transactions_by_status: statuses,
    };
  }

  /** Measured health signals projected for role prompts. */
  #healthDigest(clusterId: string): unknown {
    try {
      const signals = this.healthSignals(clusterId);
      return {
        transaction_coverage: signals.transaction_coverage,
        decomposition_quality: signals.decomposition_quality,
        responsiveness: signals.responsiveness,
        planning_stability: signals.planning_stability,
        acceptance_quality: signals.acceptance_quality,
        result_integration: signals.result_integration,
        escalation_quality: signals.escalation_quality,
      };
    } catch (error) {
      this.logger?.warn?.(error);
      return null;
    }
  }

  /** Live turn entry for one agent, or null. */
  activeTurnFor(agentId: string): ActiveTurnEntry | null {
    return this.#activeTurns.get(agentId) ?? null;
  }

  /**
   * Counting semaphore over a fixed number of permits. A released permit is
   * *transferred* to the next waiter: decrementing and re-incrementing across
   * the handoff would let a third caller in while the waiter is still running.
   */
  /** Each run owns its own cap and queue; a new main session cannot enlarge another run's window. */
  #slotsFor(clusterId:string|null):LlmSlots {
    if(clusterId===null)return this.#llmSlots;
    let slots=this.#runLlmSlots.get(clusterId);
    if(!slots){slots={limit:Math.max(1,this.store.getCluster(clusterId)?.limits.max_llm_concurrency??2),inUse:0,waiters:[]};this.#runLlmSlots.set(clusterId,slots);}
    return slots;
  }

  acquireLlmSlot(clusterId: string | null = null): Promise<() => void> {
    const slots=this.#slotsFor(clusterId);
    if (slots.inUse < slots.limit) {
      slots.inUse += 1;
      this.#noteLlmSlot(clusterId, 'acquired');
      return Promise.resolve(this.slotReleaser(clusterId));
    }
    return new Promise(resolve => {
      slots.waiters.push(() => {
        this.#noteLlmSlot(clusterId, 'acquired-after-wait');
        resolve(this.slotReleaser(clusterId));
      });
    });
  }

  /**
   * A permit receipt: how many permits were held when one was taken. It is the
   * durable evidence for the "provider requests in flight never exceed the
   * concurrency window" invariant, which is otherwise inferred from request
   * intervals that a cancelled request can stretch.
   */
  #noteLlmSlot(clusterId: string | null, kind: string): void {
    if (!clusterId) return;
    try {
      const slots=this.#slotsFor(clusterId);
      this.store.appendEvent(clusterId, 'llm-slot', { kind, in_use: slots.inUse, limit: slots.limit });
    } catch {
      /* the receipt is diagnostic: it must never fail a turn */
    }
  }

  /**
   * Admit queued work while the current limit allows it. The permit count is
   * owned here: `acquireLlmSlot` increments, `release` decrements, and this pump
   * moves permits to waiters only while `inUse` stays below the limit — so
   * lowering the cap stops new work instead of handing a busy slot on.
   */
  #pumpLlmSlots(slots:LlmSlots) {
    while (slots.inUse < slots.limit) {
      const next = slots.waiters.shift();
      if (!next) return;
      slots.inUse += 1;
      next();
    }
  }

  slotReleaser(clusterId: string | null = null): () => void {
    const slots=this.#slotsFor(clusterId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slots.inUse = Math.max(0, slots.inUse - 1);
      this.#noteLlmSlot(clusterId, 'released');
      this.#pumpLlmSlots(slots);
    };
  }

  /**
   * Non-cluster control run: one DSH agent, the same Worker prompt shape, the
   * same capability tools, the same budget ledger and the same accounting.
   * No management role is started and no scheduler is involved.
   */
  async runSingleAgent({ objective, workspace, capabilities, budget = {}, acceptance_criteria = [], timeoutMs = 3_600_000 }: {
    objective: string
    workspace?: string | undefined
    capabilities?: readonly FlowCapability[] | undefined
    budget?: FlowBudgetInput
    acceptance_criteria?: readonly string[]
    timeoutMs?: number
  }): Promise<SingleAgentResult> {
    const normalized = validateSpec({
      objective, workspace,
      capabilities: capabilities ?? ['fs_read'],
      limits: { max_depth: 1, max_children: 1, max_agents: 2, max_active_agents: 1, max_llm_concurrency: 1 },
      budget: { ...budget, wall_time_ms: budget.wall_time_ms ?? timeoutMs },
    });
    const clusterId = randomUUID();
    const prepared = this.store.tx(() => {
      const cluster = this.store.createCluster({
        id: clusterId, objective: normalized.objective, workspace: normalized.workspace,
        capabilities: normalized.capabilities, limits: normalized.limits, budget: normalized.budget,
      }, normalized.budget) ?? fail('Cluster could not be created', 500);
      const rootBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'root', scope_id: clusterId,
        limit: {
          tokens: normalized.budget.tokens ?? 0, model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
          agents: normalized.limits.max_agents, max_active_agents: normalized.limits.max_active_agents,
        },
        wall_limit_ms: normalized.budget.wall_time_ms ?? timeoutMs,
      });
      const node = this.store.insertNode({
        id: randomUUID(), cluster_id: clusterId, parent_id: null, kind: 'worker', depth: 0,
        status: 'ACTIVE', scope: { objective: normalized.objective.slice(0, 200), single: true },
        capabilities: normalized.capabilities, path: '0', max_children: 0,
      }) ?? fail('Node could not be created', 500);
      const nodeBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'node', scope_id: node.id, node_id: node.id,
        parent_budget_id: rootBudget.id,
        limit: {
          tokens: normalized.budget.tokens ?? 0, model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
        },
      });
      const agent = this.store.insertAgent({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, role: 'worker',
        session_id: randomUUID(), status: 'READY', capabilities: normalized.capabilities, cwd: normalized.workspace,
        meta: { single: true },
      }) ?? fail('Agent could not be created', 500);
      this.grantAgentBudget(clusterId, node, nodeBudget, agent, 'worker');
      const tx = this.createTransactionInternal(clusterId, node, {
        objective: normalized.objective, acceptance_criteria,
        capabilities: normalized.capabilities, status: 'RUNNING',
      }, { parent: null, local: true });
      // The single control *is* the whole cluster, so it owns the entire
      // workspace exclusively: its Worker prompt asks it to produce files, and
      // the write-scope check must permit exactly that.
      this.store.insertAllocation({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, agent_id: agent.id,
        transaction_id: tx.id, capabilities: normalized.capabilities,
        write_scope: ['.'], write_scope_canonical: [canonicalScopeEntry(cluster.workspace, '.')], status: 'ACTIVE',
      });
      this.store.appendEvent(clusterId, 'single-control-started', { agent_id: agent.id, transaction_id: tx.id });
      return { cluster: this.store.getCluster(clusterId) ?? fail('Cluster not found', 404), agent, tx, node };
    });

    const lease = this.#acquireLease(prepared.cluster, prepared.agent, 'single-turn');
    const identity = {
      cluster_id: clusterId, agent_id: prepared.agent.id, node_id: prepared.node.id, role: 'worker' as const,
      epoch: lease.epoch, lease_id: lease.id, turn_seq: 1,
    };
    const budgetIds = this.agentBudgetChain(prepared.cluster, prepared.agent);
    const policy = this.allowedToolsFor(prepared.cluster, 'worker', prepared.agent);
    const allocation = this.store.activeAllocationForTransaction(prepared.tx.id) ?? fail('Allocation not found', 404);
    const prompt = this.#workerPrompt(prepared.cluster, prepared.tx, allocation);
    let outcome: TurnOutcome | null = null;
    let error: unknown = null;
    try {
      outcome = await runTurn(this.ctx, {
        agent: prepared.agent, role: 'worker', prompt, allowedTools: policy.allowed,
        globalTools: policy.global, capabilities: policy.capabilities, resume: false,
        cwd: prepared.cluster.workspace, model: this.modelFor(prepared.agent), signal: undefined,
        logger: this.logger, budgetIds, transactionId: prepared.tx.id, turnSeq: 1, flow: this,
        contextLimits: this.config.context,
        // The control's tools resolve their actor from the bound instance, the
        // same rule as a cluster turn.
        onAgentReady: live => this.bindTurnIdentity(live, identity),
        setup: agentCtx => this.#setupAgentScope(agentCtx, prepared.agent, 'worker'),
      });
    } catch (cause) {
      error = cause;
    } finally {
      this.#releaseLease(clusterId, prepared.agent.id, lease);
    }
    const completed = outcome !== null && error === null && outcome.completed === true;
    this.store.tx(() => {
      // The single control follows the same rule as a cluster Worker: only a
      // completed turn publishes a result.
      this.store.updateTransaction(prepared.tx.id, {
        status: completed ? 'SUBMITTED' : 'FAILED',
        ...(completed
          ? { result: (this.store.getTransaction(prepared.tx.id) ?? fail('Transaction not found', 404)).result ?? { summary: outcome?.finalText ?? '', tool_calls: outcome?.toolCalls.length ?? 0 } }
          : { result: null }),
        __bump_revision: false,
      });
      this.store.recordTeamEnd(prepared.agent,completed?'COMPLETED':'FAILED');
      this.store.updateAgent(prepared.agent.id, { turns: 1, status: 'TERMINATED' });
      this.store.updateCluster(clusterId, { status: completed ? 'COMPLETED' : 'FAILED' });
      this.store.appendEvent(clusterId, 'single-control-finished', {
        stop_reason: outcome?.stopReason ?? 'error', completed, error: error ? messageOf(error) : null,
      });
    });
    return {
      cluster_id: clusterId,
      stop_reason: outcome?.stopReason ?? 'error',
      stop_detail: outcome?.stopDetail ?? null,
      final_text: outcome?.finalText ?? '',
      finalText: outcome?.finalText ?? '',
      tool_calls: outcome?.toolCalls ?? [],
      usage: this.store.usageSummary(clusterId),
      error: error ? messageOf(error) : null,
    };
  }

  /**
   * Durable tool-call admission: hard quota plus an effect receipt before the
   * side effect. Runs outside any SQLite transaction on the caller's side.
   */
  admitToolCall(agent: AgentRecord, exec: ToolDispatchExecution, callId: string): ToolAdmission {
    const lease = this.store.leaseForAgent(agent.id);
    if (!lease || lease.expires <= this.timestamp()) return { ok: false, reason: 'this agent holds no valid turn lease' };
    // The *captured* identity of the live instance is what authorises a tool
    // effect: an old instance must not act under its replacement's lease.
    const captured = exec.agent ? this.turnActor(exec.agent) : null;
    if (captured && captured.epoch !== lease.epoch) {
      return { ok: false, reason: `this instance belongs to lease epoch ${captured.epoch}, but the live lease is ${lease.epoch}` };
    }
    if (!captured && MUTATING_EFFECT_TOOLS.has(exec.name)) {
      return { ok: false, reason: `${exec.name} requires a scheduled turn identity on this agent instance` };
    }
    const cluster = this.store.getCluster(agent.cluster_id) ?? fail('Cluster not found', 404);
    // Per-allocation write isolation, checked against the canonical target the
    // tool is about to touch rather than against the scope strings alone.
    const allocation = this.store.activeAllocationForAgent(agent.id);
    const writeDecision = checkWriteAccess({
      tool: exec.name, workspace: cluster.workspace,
      writeScope: allocation?.write_scope ?? [], writeScopeCanonical: allocation?.write_scope_canonical ?? null,
      arguments: exec.arguments,
    });
    if (!writeDecision.allowed) {
      this.store.appendEvent(agent.cluster_id, 'write-refused', {
        agent_id: agent.id, tool: exec.name, reason: writeDecision.reason,
      });
      return { ok: false, reason: writeDecision.reason };
    }
    const budgetIds = this.agentBudgetChain(cluster, agent);
    const argumentsJson = safeJson(exec.arguments);
    // A side effect still in flight from a previous run may not be repeated by
    // guesswork: the identity that would repeat it is blocked until a human
    // decides (see `#effectUncertainFor`).
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      return { ok: false, reason: `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) may or may not have executed before the restart; it cannot be repeated without a decision (flow_query what:"effects")` };
    }
    const reserve = () => this.store.tx(() => {
      reserveChain(this.store, budgetIds, { tool_calls: 1 }, { label: `tool call ${exec.name}` });
        // The receipt and its reservation are written together: a crash between
        // them would either leak a quota slot or lose the fact that the call was
        // admitted at all.
      this.store.insertToolCallReceipt({
        call_id: callId, cluster_id: agent.cluster_id, agent_id: agent.id, session_id: agent.session_id,
        turn_seq: agent.turns + 1, tool: exec.name, args_hash: sha1(JSON.stringify(argumentsJson)),
        budget_scope_id: budgetIds.length === 1 ? budgetIds[0] : null, dispatch_status: 'ADMITTED',
      });
      if (effectTool(exec.name)) {
        this.store.insertEffect({
          call_id: callId, cluster_id: agent.cluster_id, agent_id: agent.id, node_id: agent.node_id,
          lease_epoch: lease.epoch, session_id: agent.session_id, turn_seq: agent.turns + 1,
          tool: exec.name, args: argumentsJson, status: 'STARTED',
        });
        this.store.appendEvent(agent.cluster_id, 'effect-started', { agent_id: agent.id, call_id: callId, tool: exec.name });
      }
    });
    try {
      reserve();
    } catch (error) {
      if (!(error instanceof BudgetError) || error.code !== 'LIMIT_REACHED') throw error;
      // A grant that ran dry while its node still holds capacity is a
      // bookkeeping state, not a refusal: the tool-call path tops up the gap
      // once, exactly like the model-request path.
      const granted = this.topUpBudgetForAgent(agent, { tool_calls: 1 });
      if (!granted) {
        this.recordBudgetRefusal(agent, `tool call refused: ${error.message}`, {
          scope: error.scope ?? agent.node_id, dimension: error.dimension ?? 'tool_calls',
          requested: error.requested ?? 1, available: error.available ?? 0,
        });
        return { ok: false, reason: error.message };
      }
      try {
        reserve();
      } catch (retryError) {
        if (retryError instanceof BudgetError && retryError.code === 'LIMIT_REACHED') {
          this.recordBudgetRefusal(agent, `tool call refused after a top-up: ${retryError.message}`, {
            scope: retryError.scope ?? agent.node_id, dimension: retryError.dimension ?? 'tool_calls',
            requested: retryError.requested ?? 1, available: retryError.available ?? 0,
          });
          return { ok: false, reason: retryError.message };
        }
        throw retryError;
      }
    }
    return { ok: true };
  }

  /**
   * A role's turn needs one request's envelope *before* it starts, not after a
   * refusal. A node that is dry for one dimension at the moment a turn begins
   * would otherwise stop the node on budget — the case's mechanism stop — while
   * the cluster still holds its budget in another branch; the refill is bounded
   * to a working envelope and moves capacity that already exists.
   */
  ensureTurnFunding(cluster: ClusterRecord, agent: AgentRecord): FlowBudgetInput | null {
    const perTurn = Math.max(16_384, Number(this.config?.context?.role) * 2 || 16_384);
    const envelope = { tokens: perTurn, model_requests: 2, tool_calls: 4 };
    try {
      const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
      const nodeBudget = this.fundingBudget(cluster, agent);
      if (!agentBudget || !nodeBudget) return null;
      const nodeRow = this.store.getBudget(nodeBudget.id) ?? fail('Budget not found', 404);
      const short: Record<string, number> = {};
      for (const [key, need] of Object.entries(envelope)) {
        const available = dimensionAvailable(nodeRow, key);
        if (available < need) short[key] = need - available;
      }
      for (const [key, need] of Object.entries(envelope)) {
        const current = this.store.getBudget(agentBudget.id) ?? fail('Budget not found', 404);
        const available = dimensionAvailable(current, key);
        if (available < need) short[key] = Math.max(short[key] ?? 0, need - available);
      }
      if (!Object.keys(short).length) return null;
      return this.topUpBudgetForAgent(agent, short);
    } catch (error) {
      this.store.appendEvent(cluster.id, 'budget-preturn-refill-failed', {
        agent_id: agent.id, error: messageOf(error).slice(0, 400),
      });
      return null;
    }
  }

  /**
   * An effect whose outcome is unknown, for this identity. `EFFECT_UNCERTAIN`
   * must really stop the owner: a replay of a non-idempotent write is not
   * recoverable, and changing a table's state without blocking the caller is
   * not a barrier.
   */
  #effectUncertainFor(agent: AgentRecord): { readonly call_id: string; readonly tool: string } | null {
    const uncertain = this.store.all(
      "SELECT call_id, tool FROM effects WHERE cluster_id=? AND agent_id=? AND status='EFFECT_UNCERTAIN' LIMIT 1",
      agent.cluster_id, agent.id);
    const row = uncertain[0];
    return row ? { call_id: textField(row.call_id, 'effect.call_id', 256), tool: textField(row.tool, 'effect.tool', 256) } : null;
  }

  /**
   * A refused admission is an accounting stop, not a provider failure. The
   * native host can wrap its error as UNKNOWN, so match the durable terminal
   * refusal for this identity *after this lease began* to the error it returned.
   * A separate transport failure later in the turn remains an anomaly.
   */
  modelRequestRefusedThisTurn(clusterId: string, agentId: string, lease: LeaseRecord, outcome: TurnOutcome | null, error: unknown): boolean {
    const detail = error === null || error === undefined ? outcome?.stopDetail?.message ?? '' : messageOf(error);
    if (!detail) return false;
    const refusal = this.store.get(
      `SELECT data FROM events WHERE cluster_id=? AND type='budget-refused'
        AND json_extract(data,'$.agent_id')=? AND seq>?
        AND json_extract(data,'$.reason') LIKE 'model request refused%'
        ORDER BY seq DESC LIMIT 1`,
      clusterId, agentId, lease.event_upper_bound);
    if (!refusal) return false;
    const reason = jsonRecordOf(decodeJson(refusal.data))?.reason;
    return errorCode(error) === 'LIMIT_REACHED' || outcome?.stopDetail?.code === 'LIMIT_REACHED'
      || (typeof reason === 'string' && reason.includes(detail));
  }

  /**
   * `agent-anomaly`: a provider or model failure is the Allocator's signal — it
   * owns the identities and the model routes.
   */
  recordAgentAnomaly(agent: AgentRecord | null, { code = null, message = null, transaction_id = null }: { code?: string | null; message?: string | null; transaction_id?: string | null } = {}): InboxRecord | null {
    if (!agent?.cluster_id) return null;
    this.store.appendEvent(agent.cluster_id, 'agent-anomaly', {
      agent_id: agent.id, role: agent.role ?? null, transaction_id, code,
    });
    return this.notifyInternal(agent.cluster_id, this.roleAgentOf(agent.cluster_id, agent.node_id, 'allocator')?.id, {
      subject: 'agent-anomaly',
      payload: { agent_id: agent.id, role: agent.role ?? null, transaction_id, code, message },
    });
  }

  /** The tool really dispatched: from here the call is consumed even if it fails. */
  markToolCallDispatched(_agent: AgentRecord, _exec: ToolDispatchExecution, callId: string): void {
    this.store.tx(() => {
      const receipt = this.store.getToolCallReceipt(callId);
      if (!receipt || receipt.dispatch_status !== 'ADMITTED') return;
      this.store.settleToolCallReceipt(callId, { dispatch_status: 'DISPATCHED', error: null });
    });
  }

  /**
   * A turn that died with a model request still reserved may have sent it.
   * Charge one attempt if the recorded payer still owns the hold, retain the
   * unknown token hold, and block the owner if settlement cannot be attributed.
   */
  reconcileReservations(cluster: ClusterRecord, agent: AgentRecord, { transactionId = null }: { transactionId?: string | null } = {}): { consumed: number; uncertain: number } {
    const stale = this.store.usageReceiptsAll(cluster.id, { agent_id: agent.id, status: 'RESERVED' });
    if (!stale.length) return { consumed: 0, uncertain: 0 };
    let uncertain = 0;
    let consumed = 0;
    const blockUncertain = (receipt: UsageReceiptRecord, reason: unknown): void => {
      uncertain += 1;
      this.store.appendEvent(cluster.id, 'accounting-uncertain', {
        request_id: receipt.request_id, agent_id: agent.id,
        code: 'ACCOUNTING_UNCERTAIN', reason: String(reason).slice(0, 300),
      });
      this.store.updateAgent(agent.id, { status: 'BLOCKED' });
      const txId = transactionId ?? receipt.transaction_id;
      if (txId) {
        const tx = this.store.getTransaction(txId);
        if (tx && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)) {
          this.store.updateTransaction(txId, { status: 'BLOCKED' });
        }
      }
      this.blockNodeInternal(cluster.id, agent.node_id,
        `ACCOUNTING_UNCERTAIN: request ${receipt.request_id} cannot be settled; its reservation is kept`,
        'ACCOUNTING_UNCERTAIN');
    };
    this.store.tx(() => {
      for (const receipt of stale) {
        const live = this.store.getUsageReceipt(receipt.request_id);
        if (!live || live.status !== 'RESERVED') continue;
        // The scope that was charged is the receipt's own recorded scope — the
        // same rule settlement uses. There is *no* fallback to the identity's
        // current chain: a receipt whose payer is missing or dangling would then
        // debit whatever request holds quota there now, which is another
        // request's reservation, not this one's.
        const budgetIds = live.budget_scope_id && this.store.getBudget(live.budget_scope_id) ? [live.budget_scope_id] : null;
        if (!budgetIds) {
          blockUncertain(live, live.budget_scope_id
            ? `the recorded payer ${live.budget_scope_id} does not exist; the reservation is kept`
            : 'the receipt records no payer scope; the reservation is kept');
          continue;
        }
        // A receipt still reserved when its turn ended belongs to a request
        // that may have been sent: its tokens stay held, only the attempt is
        // consumed.
        try {
          settleChain(this.store, budgetIds, {
            reservedAmounts: { model_requests: 1 },
            consumed: { model_requests: 1 },
          });
          consumed += 1;
        } catch (error) {
          // The payer row exists but no longer owns this attempt's hold. Do
          // not debit another request, nor publish work from an unpayable turn.
          blockUncertain(live, messageOf(error));
          continue;
        }
        this.store.settleUsageReceipt(receipt.request_id, {
          status: 'UNKNOWN',
          note: `turn ended with the request still reserved; ${receipt.reservation_tokens} tokens retained`,
        });
        this.store.appendEvent(cluster.id, 'usage-reconciled', { request_id: receipt.request_id, agent_id: agent.id });
      }
    });
    return { consumed, uncertain };
  }

  /**
   * The one transition a tool call's *quota* goes through, owned by the receipt.
   *
   * Only a receipt that is `ADMITTED` (admitted, never dispatched) or
   * `DISPATCHED` (may have run) holds quota. Every other state is terminal for the
   * hold, which is what makes this replay-safe: settling an `UNKNOWN` or
   * `SETTLED` receipt again would take one call out of a reserve it no longer
   * owns, or out of another call's hold in the same scope. There is no fallback to
   * the identity's current chain: a receipt whose payer is gone keeps its hold and
   * is reported as uncertain.
   *
   * Returns `{ outcome, payer }` with outcome in
   * `consumed | released | none | uncertain`.
   */
  settleToolReceiptQuota(callId: string, { dispatched = null, status = null, error = null }: { dispatched?: boolean | null; status?: 'SETTLED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN' | null; error?: string | null } = {}): { outcome: string; payer: string | null } {
    const receipt = this.store.getToolCallReceipt(callId);
    if (!receipt) return { outcome: 'none', payer: null };
    const current = String(receipt.dispatch_status ?? '').toUpperCase();
    if (!['ADMITTED', 'DISPATCHED'].includes(current)) return { outcome: 'none', payer: receipt.budget_scope_id ?? null };
    const payer = receipt.budget_scope_id && this.store.getBudget(receipt.budget_scope_id) ? receipt.budget_scope_id : null;
    if (!payer) {
      this.store.appendEvent(receipt.cluster_id, 'accounting-uncertain', {
        call_id: callId, agent_id: receipt.agent_id, code: 'ACCOUNTING_UNCERTAIN',
        reason: receipt.budget_scope_id
          ? `the recorded payer ${receipt.budget_scope_id} does not exist; the tool hold is kept`
          : 'the tool receipt records no payer scope; the hold is kept',
      });
      return { outcome: 'uncertain', payer: null };
    }
    const ran = dispatched === null ? current === 'DISPATCHED' : Boolean(dispatched);
    // The scope must actually hold the call. A receipt that says it holds one
    // while the ledger shows none is an inconsistency, and *nothing* may move on
    // it: consuming the call anyway would overshoot a quota the payer never
    // reserved (settlement has no upper-limit check of its own), and releasing
    // would drive the counter negative or take another call's hold. The receipt
    // and its hold are preserved, the owner is blocked, and the reason is named —
    // the human exit is the same one every other uncertain accounting uses.
    const budget = this.store.getBudget(payer) ?? fail('Budget not found', 404);
    if (budget.tool_calls_reserved < 1) {
      const allocation = this.store.activeAllocationForAgent(receipt.agent_id);
      if (allocation?.transaction_id) {
        const tx = this.store.getTransaction(allocation.transaction_id);
        if (tx && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)) {
          this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        }
      }
      this.store.updateAgent(receipt.agent_id, { status: 'BLOCKED' });
      const nodeId = allocation?.node_id ?? this.store.getAgent(receipt.agent_id)?.node_id ?? null;
      this.blockNodeInternal(receipt.cluster_id, nodeId,
        `ACCOUNTING_UNCERTAIN: tool call ${callId} is ${current} but its payer holds no reservation; nothing is charged`,
        'ACCOUNTING_UNCERTAIN');
      this.store.appendEvent(receipt.cluster_id, 'accounting-uncertain', {
        call_id: callId, agent_id: receipt.agent_id, code: 'ACCOUNTING_UNCERTAIN', payer,
        reason: `the receipt is ${current} but its payer holds no tool-call reservation; the receipt and hold are preserved`,
      });
      return { outcome: 'uncertain', payer };
    }
    settleChain(this.store, [payer], ran
      ? { reservedAmounts: { tool_calls: 1 }, consumed: { tool_calls: 1 } }
      : { reservedAmounts: { tool_calls: 1 }, consumed: {} });
    this.store.settleToolCallReceipt(callId, {
      dispatch_status: status ?? (ran ? 'UNKNOWN' : 'CANCELLED'),
      ...(error ? { error: String(error).slice(0, 2000) } : {}),
    });
    this.store.appendEvent(receipt.cluster_id, ran ? 'tool-call-charged' : 'tool-call-released', {
      // What was charged, not only who paid: the ledger has to be able to say which
      // tool ran for which identity, or evidence about who produced an artifact
      // cannot be read out of it.
      call_id: callId, payer, tool: receipt.tool ?? null, agent_id: receipt.agent_id ?? null,
    });
    return { outcome: ran ? 'consumed' : 'released', payer };
  }

  /**
   * The human decision's effect on a tool receipt: the quota is reconciled through
   * the same receipt-owned transition as everywhere else (so it can never be taken
   * twice), and the receipt records the outcome the human chose.
   */
  resolveReceiptQuotaAfterEffect(callId: string, { decision, actor, params = {} }: { decision: string; actor: FlowActor; params?: Record<string, unknown> }): { outcome: string } {
    const receipt = this.store.getToolCallReceipt(callId);
    if (!receipt) return { outcome: 'none' };
    const status = decision === 'settled' ? 'SETTLED' : 'FAILED';
    const outcome = this.settleToolReceiptQuota(callId, { status });
    // The decision is recorded even when there was no hold left to move: the
    // receipt is the record of what the human decided.
    if (outcome.outcome === 'none') this.store.settleToolCallReceipt(callId, { dispatch_status: status });
    this.store.settleToolCallReceipt(callId, {
      result_body: this.boundReceiptBody({ resolved_by: actor.role === 'user' ? null : actor.agent_id, note: params.note ?? 'resolved by hand' }, 2_000),
    });
    return outcome;
  }


  /**
   * Serialize receipts as valid JSON by bounding strings and collection sizes
   * before encoding. The shape remains readable even when evidence is long.
   */
  boundReceiptBody(value: unknown, maxString = 8_000, maxItems = 50): string {
    try {
      return JSON.stringify(this.boundBody(value, maxString, maxItems));
    } catch (error) {
      return JSON.stringify({ unserializable: messageOf(error).slice(0, 500) });
    }
  }

  /** The same bounding, as a structure: both ledgers hold the same one. */
  boundBody(value: unknown, maxString = 8_000, maxItems = 50): FlowJsonValue {
    const bound = (item: unknown): FlowJsonValue => {
      if (typeof item === 'string') return item.length > maxString ? `${item.slice(0, maxString)}…[${item.length - maxString} chars omitted]` : item;
      if (Array.isArray(item)) return item.slice(0, maxItems).map(bound);
      if (item && typeof item === 'object') {
        const out: Record<string, FlowJsonValue> = {};
        for (const [key, entry] of Object.entries(item)) out[key] = bound(entry);
        return out;
      }
      return asJsonValue(item);
    };
    return bound(value);
  }

  /** Settle the quota reservation and the effect receipt after the tool ran. */
  settleToolCall(agent: AgentRecord, exec: ToolDispatchExecution, callId: string, result: ToolExecutionResult | null, error: unknown, { charged = true }: { charged?: boolean } = {}): void {
    const log = this.#toolCallLog.get(agent.id) ?? [];
    log.push(exec.name);
    this.#toolCallLog.set(agent.id, log);
    // The scope that paid is the receipt's own recorded scope: recomputing the
    // chain here could settle a reservation in a scope that never held it.
    // The text is bounded *once*, before either ledger is written — the tool
    // receipt and the effect row hold the same body — and the bound states what it
    // omitted, which a pre-truncated string cannot.
    const body = result ? { isError: result.isError === true, text: boundText(textOfResult(result), 8_000) } : null;
    const source = result && result.isError !== true ? captureSource(agent, exec, result) : null;
    this.store.tx(() => {
      if (source) this.store.insertSource(source);
      // Through the receipt-owned transition, once: `charged` means the call
      // really ran (consumed), anything else means it never dispatched
      // (released), and a receipt that is already terminal moves nothing.
      this.settleToolReceiptQuota(callId, {
        dispatched: charged,
        // A call that never dispatched was cancelled, whatever error text
        // explains the refusal: `FAILED` is reserved for a tool that really ran
        // and failed.
        status: charged ? (error ? 'FAILED' : 'SETTLED') : 'CANCELLED',
      });
      // One bounded body, both ledgers: the tool receipt and the effect row hold
      // the same text, and neither holds the full unbounded output.
      const boundedBody = body === null ? null : this.boundBody(body, 8_000);
      if (this.store.getToolCallReceipt(callId)) {
        this.store.settleToolCallReceipt(callId, {
          result_body: boundedBody === null ? null : JSON.stringify(boundedBody),
          error: error ? messageOf(error).slice(0, 2000) : null,
        });
      }
      const effect = this.store.getEffect(callId);
      if (effect) {
        const jobId = jobIdOf(result);
        this.store.settleEffect(callId, error
          ? { status: 'FAILED', error: messageOf(error).slice(0, 2000) }
          : { status: 'SETTLED', body: boundedBody ?? body, ...(jobId ? { job_id: jobId } : {}) });
        this.store.appendEvent(agent.cluster_id, 'effect-settled', { call_id: callId, tool: exec.name, ok: !error, ...(jobId ? { job_id: jobId } : {}) });
      }
    });
  }

  /**
   * Restart recovery: fence stale leases, mark in-flight effects uncertain,
   * return abandoned work to a schedulable state, and resume unfinished
   * clusters. Sessions are never re-created under an existing identity.
   */
  recover({ deferScheduling = false }: { deferScheduling?: boolean } = {}): readonly RecoveryFacts[] {
    if (this.#activeTurns.size || this.#scheduling.size || this.#ticking) {
      fail('Cannot recover while turns or a scheduling pass are active; pause the clusters, let active turns drain, then retry recover', 409);
    }
    // Recovery may be requested again over an already-ready runtime. Close
    // admission before fencing leases; deferral is a barrier, not merely a
    // request to skip opening an initially closed gate at the end.
    this.#schedulingEnabled = false;
    this.#schedulingGeneration += 1;
    const report: RecoveryFacts[] = [];
    // Every non-terminal cluster, in keyset pages: recovery is the one pass that
    // must never leave a cluster behind.
    const clusters: ClusterRecord[] = [];
    let afterId = '';
    for (;;) {
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      clusters.push(...page);
      const last = page.at(-1);
      if (!last) break;
      afterId = last.id;
      if (page.length < 200) break;
    }
    for (const cluster of clusters) {
      const facts: RecoveryFacts = { cluster_id: cluster.id, status: cluster.status, fenced_leases: 0, uncertain_effects: 0, requeued: 0, blocked_agents: 0 };
      this.store.tx(() => {
        for (const lease of this.store.listLeases(cluster.id, {})) {
          // The messages the fenced turn owned go back to the queue: the process
          // died between taking them and proving its prompt durable, so nothing
          // answered them and a consumed message is never re-offered. The ids are
          // read from the turn-start event, which is what records the ownership.
          const taken = this.store.get(
            "SELECT json_extract(data,'$.inbox_ids') AS ids FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1",
            cluster.id, lease.agent_id,
          );
          const decoded: unknown = taken === undefined ? [] : decodeJson(stringColumn(taken.ids, 'turn-start.inbox_ids'));
          const ids = Array.isArray(decoded) ? decoded.filter((id): id is string => typeof id === 'string') : [];
          if (ids.length) {
            const reopened = this.store.reopenInbox(ids);
            if (reopened) {
              facts.inbox_reopened = (facts.inbox_reopened ?? 0) + reopened;
              this.store.appendEvent(cluster.id, 'inbox-reopened', {
                agent_id: lease.agent_id, count: reopened, reason: 'the process restarted before the turn proved its prompt durable',
              });
            }
          }
          this.store.deleteLease(lease.id);
          facts.fenced_leases += 1;
        }
        for (const callId of this.store.effectIds(cluster.id, 'STARTED')) {
          this.store.settleEffect(callId, { status: 'EFFECT_UNCERTAIN', error: 'process restarted while the effect was in flight' });
          facts.uncertain_effects += 1;
        }
        this.store.run(
          "UPDATE agents SET status='READY', updated=? WHERE cluster_id=? AND status IN ('RUNNING','CREATED','WAITING')",
          this.store.now(), cluster.id,
        );
        facts.agents_requeued = this.store.changed();
        // Exhaustive, including RUNNING transactions with an ACTIVE allocation.
        // An unreviewed plan resumes under the same identity; a plan the Auditor
        // rejected while that identity was live returns to DRAFT instead, so
        // recovery cannot dispatch work whose old turn lost its lease.
        this.store.run(
          `UPDATE transactions SET
             status=CASE WHEN (
               SELECT a.decision FROM audits a
                WHERE a.cluster_id=transactions.cluster_id AND a.transaction_id=transactions.id
                  AND a.kind='plan' AND a.target_revision=transactions.revision
                ORDER BY a.created DESC, a.rowid DESC LIMIT 1
             )='REJECTED' THEN 'DRAFT' ELSE 'READY' END,
             updated=?
           WHERE cluster_id=? AND status='RUNNING'`,
          this.store.now(), cluster.id,
        );
        facts.requeued = this.store.changed();
        // Return structural identity and concurrency reservations after process
        // loss. Economic holds remain until their receipt is settled: RESERVED
        // and UNKNOWN requests still own their tokens and request allowance.
        // Recompute those counters from receipts instead of clearing them.
        this.store.run(
          `UPDATE budgets SET
             agents_reserved=0, max_active_reserved=0,
             tokens_reserved=COALESCE((
               SELECT SUM(r.reservation_tokens) FROM usage_receipts r
                WHERE r.budget_scope_id = budgets.id AND r.status IN ('RESERVED','UNKNOWN')), 0),
             requests_reserved=COALESCE((
               SELECT COUNT(*) FROM usage_receipts r
                WHERE r.budget_scope_id = budgets.id AND r.status='RESERVED'), 0),
             tool_calls_reserved=COALESCE((
               SELECT COUNT(*) FROM tool_call_receipts t
                WHERE t.budget_scope_id = budgets.id AND t.dispatch_status IN ('ADMITTED','DISPATCHED')), 0),
             revision=revision+1, updated=?
           WHERE cluster_id=? AND scope_kind='agent'`,
          this.store.now(), cluster.id,
        );
        // A fenced turn's unspent, unreserved grant goes back to the scope that
        // funded it: the process that held it is gone.
        facts.returned = this.returnFencedGrants(cluster.id);
        // Every tool call leaves a receipt, including the ones with no effect row
        // (a read, a query), so the quota is reconciled here from the receipt —
        // not from an effect decision, which a read never has. ADMITTED means the
        // call never dispatched: its hold is released and nothing is charged.
        // DISPATCHED means it may have run: one call is consumed, once.
        for (const receipt of this.store.all(
          "SELECT call_id, agent_id, budget_scope_id, dispatch_status FROM tool_call_receipts WHERE cluster_id=? AND dispatch_status IN ('ADMITTED','DISPATCHED')",
          cluster.id,
        )) {
          const callId = textField(receipt.call_id, 'tool_call_receipts.call_id', 128);
          const outcome = this.settleToolReceiptQuota(callId, {
            error: 'the process restarted while the call was in flight',
          }).outcome;
          if (outcome === 'uncertain') facts.tool_receipts_uncertain = (facts.tool_receipts_uncertain ?? 0) + 1;
          else facts.tool_receipts_reconciled = (facts.tool_receipts_reconciled ?? 0) + 1;
        }
        // Preserve attempted injections until the asynchronous session proof:
        // FOUND is acked, ABSENT is requeued, and UNKNOWN remains withheld.
        // Reopening here made reconciliation mistake an uncertain prior send
        // for a fresh queued message and skip its owner fence.
        facts.injections_reopened = 0;
        facts.injections_pending_proof = Number(this.store.get(
          `SELECT COUNT(*) AS count FROM recipients r JOIN messages m ON m.id=r.message_id
           WHERE m.cluster_id=? AND r.status='DELIVERED'`, cluster.id)?.count ?? 0);
        this.store.appendEvent(cluster.id, 'recovered', asJsonValue(facts));
      });
      report.push(facts);
    }
    if (report.some(facts => facts.status === 'RUNNING') && !deferScheduling) this.enableScheduling();
    return report;
  }

  /**
   * The complete restart lifecycle, shared by startup and IPC. Concurrent
   * callers join the same proof pass, and only its own successful completion
   * may reopen scheduling. Failed proof leaves admission closed for a retry.
   */
  recoverAndReconcile() {
    if (!this.#recoveryPromise) {
      this.#recoveryPromise = this.#recoverAndReconcile().finally(() => {
        this.#recoveryPromise = null;
      });
    }
    return this.#recoveryPromise;
  }

  async #recoverAndReconcile() {
    const recovered = this.recover({ deferScheduling: true });
    const generation = this.#schedulingGeneration;
    const reconciled: ReconciledCluster[] = [];
    let afterId = '';
    for (;;) {
      // Recovery spans awaited session proofs, so disposal can land between two
      // of them: a late proof must never reach a closed store, and it must not
      // reopen admission for an instance that is already gone.
      if (this.#disposed) break;
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      for (const cluster of page) {
        const sessions = await this.proveSessions(cluster.id);
        if (this.#disposed) return { recovered, reconciled };
        const deliveries = await this.reconcileDeliveries(cluster.id);
        if (this.#disposed) return { recovered, reconciled };
        reconciled.push({ cluster_id: cluster.id, sessions, ...deliveries });
      }
      const last = page.at(-1);
      if (!last) break;
      afterId = last.id;
      if (page.length < 200) break;
    }
    this.#resumeScheduling(generation);
    return { recovered, reconciled };
  }

  /**
   * Prove every identity's durable session, outside any transaction because the
   * probe awaits the persistence service.
   *
   * An identity with turn history and no session is a real defect: re-creating
   * a session under the same id would silently present a blank history as the
   * agent's memory, so its work is blocked with `SESSION_MISSING` instead and a
   * human decides. An identity with no history is simply new, and an
   * unanswerable probe (no persistence mounted) is not evidence of absence.
   */
  async proveSessions(clusterId: string | null = null): Promise<readonly SessionProofReport[]> {
    if (this.#disposed) return [];
    const clusters = clusterId === null
      ? this.store.listOpenClusters({ limit: 1000 })
      : [this.store.getCluster(clusterId)].flatMap(cluster => cluster === null ? [] : [cluster]);
    const report: SessionProofReport[] = [];
    for (const cluster of clusters) {
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(cluster.status)) continue;
      const missing: AgentRecord[] = [];
      for (const facts of this.store.agentsInSubtree(cluster.id, null)) {
        if (facts.turns <= 0 || facts.status === 'TERMINATED') continue;
        // eslint-disable-next-line no-await-in-loop
        const exists = await this.sessionExists(facts.session_id);
        if (this.#disposed) return report;
        if (exists !== false) continue;
        missing.push(facts);
      }
      if (!missing.length) continue;
      // The probe awaited the persistence service, so the instance may have been
      // disposed while it was in flight: a proof that arrives after teardown is
      // discarded rather than written into a closed store or a new instance's
      // state.
      if (this.#disposed) return report;
      this.store.tx(() => {
        for (const facts of missing) {
          for (const tx of this.store.transactionsInSubtree(cluster.id, facts.node_id)) {
            if (['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED', 'BLOCKED'].includes(tx.status)) continue;
            this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
          }
          this.store.updateAgent(facts.id, { status: 'BLOCKED' });
          this.store.appendEvent(cluster.id, 'session-missing', {
            agent_id: facts.id, session_id: facts.session_id, turns: facts.turns,
            code: 'SESSION_MISSING',
            note: 'the identity has turn history but no durable session; it is not re-created under the same id',
          });
        }
        this.blockClusterInternal(cluster.id,
          `SESSION_MISSING: ${missing.length} identities have turn history but no durable session`, 'SESSION_MISSING');
      });
      report.push({ cluster_id: cluster.id, session_missing: missing.map(facts => facts.id) });
    }
    return report;
  }

  /**
   * Whether the readiness and reconciliation barriers have been cleared.
   */
  schedulingEnabled(): boolean {
    return this.#schedulingEnabled;
  }

  /** Open the barrier. Called only once proofs are read. */
  enableScheduling(): void {
    if (this.#disposed) return;
    this.#schedulingEnabled = true;
    this.#ensureTicking();
    this.wake();
  }

  resumeScheduling(): void {
    this.#resumeScheduling(this.#schedulingGeneration);
  }

  /**
   * Resume scheduling once recovery has finished proving which injections were
   * really admitted. `agentLoop`, `sessions` and `sessionPersistence` are
   * required injected dependencies, so a half-mounted profile keeps the whole
   * instance PENDING instead of being polled for; a stale generation is a
   * recovery that has already been superseded, and a failed recovery must not
   * reopen the barrier.
   */
  #resumeScheduling(generation: number): void {
    if (this.#disposed || generation !== this.#schedulingGeneration) return;
    this.enableScheduling();
  }

  /** The compaction scope, funded separately from the tree it keeps affordable. */
  compactionBudgetId(clusterId: string): string | null {
    const row = this.store.get('SELECT id FROM budgets WHERE cluster_id=? AND scope_kind=? LIMIT 1', clusterId, 'compaction');
    return row ? textField(row.id, 'budget.id', 128) : null;
  }

  /**
   * Select one scope that can cover the entire request. Compaction draws from
   * its reserved pool first; ordinary turns draw from their management grant
   * first. Either can fall back to the other's scope when its own grants cannot
   * pay, so funded capacity does not become stranded.
   */
  budgetChainForAgent(agent: AgentRecord, { tokens = 0, requests = 1, kind = 'role' }: BudgetChainRequest = {}): readonly string[] {
    const cluster = this.store.getCluster(agent.cluster_id) ?? fail('Cluster not found', 404);
    const agentBudgetId = this.store.budgetForScope(agent.cluster_id, 'agent', agent.id)?.id;
    const agentBudget = agentBudgetId ? this.store.getBudget(agentBudgetId) : null;
    const compactionId = this.compactionBudgetId(agent.cluster_id);
    const pool = compactionId ? this.store.getBudget(compactionId) : null;
    const management = this.fundingBudget(cluster, agent);
    const candidates = (kind === 'compaction'
      ? [pool, management, agentBudget]
      : [management, agentBudget, pool]).filter((row): row is BudgetRecord => row !== null);
    const now = this.timestamp();
    // A scope is payable only when it covers the *whole* reservation in every
    // dimension the request needs, under a live deadline. Choosing a scope
    // because it holds *something* strands the request while the rest of the
    // budget sits elsewhere.
    const payable = (row: BudgetRecord): boolean => {
      if (dimensionAvailable(row, 'tokens') < tokens || dimensionAvailable(row, 'model_requests') < requests) return false;
      const deadline = effectiveDeadline(this.store, row);
      return deadline === null || deadline > now;
    };
    const chosen = candidates.find(payable);
    if (chosen) return [chosen.id];
    // Nothing can pay it: name the scope with the most capacity, so the refusal
    // points at the scope that is really short — and never answer with an empty
    // chain, which reserves nothing and would send the request for free.
    if (candidates.length) {
      const best = candidates.reduce((a, b) => (dimensionAvailable(a, 'tokens') >= dimensionAvailable(b, 'tokens') ? a : b));
      return [best.id];
    }
    const fallback = this.agentBudgetChain(cluster, agent);
    if (fallback.length) return fallback;
    const error = Object.assign(new Error(`no budget scope exists for agent ${agent.id}; a request from it cannot be accounted`), {
      code: 'LIMIT_REACHED',
      scope: agent.node_id ?? agent.id,
      dimension: 'model_requests',
    });
    throw error;
  }

  /**
   * A refused admission is the only durable evidence that a limit was really
   * hit; proximity to the ceiling is not.
   */
  /**
   * A request that could not be funded anywhere its identity is allowed to draw
   * on stops the *node* it belongs to, with the coded reason. Retrying it as a
   * per-turn error burned 49 turns in one recursion run and moved nothing.
   *
   * A Worker's own request allowance is deliberately not covered here: that is a
   * per-task limit, and exhaust it does not mean the node is out of money.
   */
  blockNodeOnBudget(agent: AgentRecord | null, reason: string, facts: BudgetBlockFacts = {}): boolean {
    if (!agent?.cluster_id || !agent.node_id) return false;
    if (/allowance for this task/.test(String(reason))) return false;
    const node = this.store.getNode(agent.node_id);
    if (!node || node.status === 'BLOCKED') return false;
    // The identity is part of the record: a resume has to know whose envelope was
    // refused, and a refusal is scoped to that identity (or to the pool it drew
    // from), never to the node.
    this.blockNodeInternal(agent.cluster_id, agent.node_id, `BUDGET: ${String(reason).slice(0, 300)}`,
      'BUDGET_EXHAUSTED', {
        agent_id: agent.id, dimension: facts.dimension ?? null, requested: facts.requested ?? null,
        envelope: facts.envelope ?? null,
      });
    return true;
  }

  recordBudgetRefusal(agent: AgentRecord | null, reason: string, facts: BudgetRefusalFacts = {}): unknown {
    if (!agent?.cluster_id) return null;
    this.#refusals.set(agent.cluster_id, (this.#refusals.get(agent.cluster_id) ?? 0) + 1);
    // A cluster that cannot fund one complete request must stop rather than
    // keep dispatching requests that will fail until its wall deadline.
    if (facts.dimension === 'tokens' && facts.available === 0) {
      const rollup = rollupBudgets(this.store, agent.cluster_id);
      const left = rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent;
      if (rollup.tokens.limit > 0 && left < 4096) {
        this.blockClusterInternal(agent.cluster_id,
          `BUDGET: ${String(reason).slice(0, 200)} (only ${left} tokens remain in the cluster)`, 'BUDGET_EXHAUSTED');
      }
    }
    // A funded shortfall belongs to an admitted request. Record it as repaired
    // so consumers can distinguish successful funding from a terminal refusal.
    const type = facts.terminal === false ? 'budget-shortfall' : 'budget-refused';
    return this.store.tx(() => {
      const event = this.store.appendEvent(agent.cluster_id, type, {
        agent_id: agent.id, node_id: agent.node_id ?? null, role: agent.role ?? null,
        scope: facts.scope ?? null, dimension: facts.dimension ?? null,
        requested: facts.requested ?? null, available: facts.available ?? null,
        terminal: facts.terminal ?? true, reason: String(reason).slice(0, 300),
      });
      if (type === 'budget-refused' && agent.node_id) {
        const node = this.store.getNode(agent.node_id);
        const payload = { node_id: agent.node_id, agent_id: agent.id,
          dimension: facts.dimension ?? null, requested: facts.requested ?? null,
          available: facts.available ?? null, scope: facts.scope ?? null };
        const dedupeKey = `budget-refused:${agent.node_id}:${node?.revision ?? 0}:${facts.dimension ?? ''}`;
        this.notifyInternal(agent.cluster_id, this.roleAgentOf(agent.cluster_id, agent.node_id, 'orchestrator')?.id ?? null,
          { subject: 'budget-refused', payload, dedupeKey });
        if (node?.parent_id) this.notifyInternal(agent.cluster_id,
          this.roleAgentOf(agent.cluster_id, node.parent_id, 'allocator')?.id ?? null,
          { subject: 'budget-refused', payload, dedupeKey });
      }
      return event;
    });
  }

  /**
   * The same admission test as `admitToolCall`, re-run after the awaited flush.
   * Returns `{ok}` and never mutates the reservation.
   */
  recheckToolCall(agent: AgentRecord, exec: ToolDispatchExecution, callId: string): ToolAdmission {
    const lease = this.store.leaseForAgent(agent.id);
    if (!lease || lease.expires <= this.timestamp()) return { ok: false, reason: 'the turn lease expired while the tool call was being prepared' };
    const captured = exec.agent ? this.turnActor(exec.agent) : null;
    if (captured && captured.epoch !== lease.epoch) {
      return { ok: false, reason: `this instance belongs to lease epoch ${captured.epoch}, but the live lease is ${lease.epoch}` };
    }
    void callId;
    return { ok: true };
  }

  /**
   * A tool call refused at the post-flush fence never dispatched, so its
   * reservation is returned without charging and the refusal is recorded.
   */
  refuseToolCall(agent: AgentRecord, exec: ToolDispatchExecution, callId: string, reason: string): void {
    this.store.tx(() => {
      this.store.appendEvent(agent.cluster_id, 'tool-call-refused', {
        agent_id: agent.id, call_id: callId, tool: exec?.name ?? null, reason: reason ?? 'refused before dispatch',
      });
    });
    return this.settleToolCall(agent, exec, callId, null, new Error(reason ?? 'refused before dispatch'), { charged: false });
  }

  /**
   * Validate an actor fenced to a captured turn. Mutating actions require a
   * captured epoch that is still the live one; read-only work may proceed
   * without one.
   */
  assertActorFence(actor: FlowAgentActor, { mutating = true }: { mutating?: boolean } = {}): void {
    const lease = this.store.leaseForAgent(actor.agent_id);
    if (actor.epoch === undefined) {
      if (mutating) fail(`this agent instance does not own a scheduled cluster turn; its identity cannot be fenced`, 409);
      return;
    }
    if (!lease || lease.epoch !== actor.epoch || lease.expires <= this.timestamp()) {
      fail(`command from a fenced turn: agent ${actor.agent_id} does not hold epoch ${actor.epoch}`, 409);
    }
    if (mutating && actor.epoch !== lease.epoch) fail('fenced actor', 409);
  }


  #heartbeats: Map<string, NodeJS.Timeout> = new Map();
  #flowCalls: Map<string, number> = new Map();
  #toolCallLog: Map<string, string[]> = new Map();
  #turnIdentity: WeakMap<object, TurnIdentity> = new WeakMap();
  #persistence: FlowPersistenceSeam | null = null;
  #startFailures: Map<string, number> = new Map();
  #schedulingEnabled = false;
  #forceCompact: Set<string> = new Set();

  // ----------------------------------------------------------- inventory

  roleAgentOf(clusterId: string, nodeId: string | null | undefined, role: FlowAgentRole): AgentRecord | null {
    const nodeFilter = nodeId === null || nodeId === undefined ? undefined : nodeId;
    return this.store.listAgents(clusterId, { node_id: nodeFilter, role, limit: 5 })
      .find(agent => agent.status !== 'TERMINATED') ?? null;
  }

  ensureRoles(clusterId: string, node: NodeRecord, budgets: ReadonlyMap<string, BudgetRecord>, parentAgentId: string | null = null): Record<'orchestrator' | 'allocator' | 'auditor', string> {
    const created: Record<'orchestrator' | 'allocator' | 'auditor', string> = {
      orchestrator: '', allocator: '', auditor: '',
    };
    const managementRoles: readonly ('orchestrator' | 'allocator' | 'auditor')[] = ['orchestrator', 'allocator', 'auditor'];
    for (const role of managementRoles) {
      const nodeBudget = budgets.get(node.id);
      if (!nodeBudget) fail('Node budget not found', 404);
      const agent = this.store.insertAgent({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, role,
        session_id: randomUUID(), status: 'READY', capabilities: [...node.capabilities],
        meta: { management: true, parent_agent_id: role === 'orchestrator' ? parentAgentId : created.orchestrator },
      });
      if (!agent) fail('Agent could not be created', 500);
      this.grantAgentBudget(clusterId, node, nodeBudget, agent, role);
      created[role] = agent.id;
    }
    this.store.appendEvent(clusterId, 'roles-created', { node_id: node.id, agents: created });
    return created;
  }

  grantAgentBudget(clusterId: string, node: NodeRecord, nodeBudget: BudgetRecord, agent: AgentRecord, role: FlowAgentRole): BudgetRecord {
    const fresh = this.store.getBudget(nodeBudget.id) ?? fail('Budget not found', 404);
    const limits: Record<string, number> = { tokens: 0, model_requests: 0, tool_calls: 0, agents: 0, max_active_agents: 0 };
    if (role === 'worker') {
      // Bound each Worker's initial grant so management roles retain capacity
      // to plan, review and close the transaction.
      const workerGrant: { tokens: number; model_requests: number; tool_calls: number } = { tokens: 65_536, model_requests: 8, tool_calls: 32 };
      // Grant at most the per-Worker task-request allowance plus one reservation
      // for compaction or a send released before dispatch. The hard allowance
      // remains enforced on every task request.
      const perWorkerAllowance = Number(this.store.getCluster(clusterId)?.limits?.worker_model_requests) || 0;
      if (perWorkerAllowance > 0) {
        workerGrant.model_requests = Math.min(workerGrant.model_requests, perWorkerAllowance + 1);
      }
      for (const key of ['tokens', 'model_requests', 'tool_calls'] as const) {
        limits[key] = Math.max(1, Math.min(workerGrant[key], dimensionAvailable(fresh, key)));
      }
      // Enforce concurrency at the cluster window. An Agent can hold only one
      // active turn, so it needs no separate max_active_agents grant.
    } else {
      // Each management role receives an initial working allowance, bounded by
      // one quarter of the node's available capacity. Further turns can draw
      // from the node through agentBudgetChain.
      const cluster = this.store.getCluster(clusterId);
      const perTurn = Math.max(16_384, (Number(this.config?.context?.role) || 8192) * 2);
      const turns = Math.max(1, Number(cluster?.limits?.max_role_turns) || 3);
      const working = Math.min(perTurn * turns, Math.floor(dimensionAvailable(fresh, 'tokens') / 4));
      limits.tokens = Math.max(1, working);
      limits.model_requests = Math.max(1, Math.min(turns * 4, Math.floor(dimensionAvailable(fresh, 'model_requests') / 4)));
      // Size tool grants for the role's allowed turns and bound them by a
      // quarter of the node's available tool-call capacity.
      limits.tool_calls = Math.max(1, Math.min(turns * 20, Math.floor(dimensionAvailable(fresh, 'tool_calls') / 4)));
    }
    const budget = createBudget(this.store, {
      cluster_id: clusterId, scope_kind: 'agent', scope_id: agent.id, node_id: node.id,
      parent_budget_id: nodeBudget.id, limit: {},
    });
    this.grantBudget(nodeBudget, budget, limits);
    const granted = this.store.getBudget(budget.id) ?? fail('Budget not found', 404);
    this.store.appendEvent(clusterId, 'budget-granted', {
      agent_id: agent.id, node_id: node.id, role, grant: asJsonValue(granted),
    });
    return granted;
  }

  /**
   * Send the deterministic fixture messages whose source transaction just
   * reached acceptance. The send goes through the same communication graph a
   * model call would use, so the delivery pipeline itself is what gets tested.
   */
  deliverFixtureMessages(cluster: ClusterRecord, tx: TransactionRecord | null = null): readonly { message_id: string; recipient: string }[] {
    const fixture = cluster.spec?.message_fixture ?? [];
    const entries = fixture.filter(entry => (tx ? entry.from === tx.id : this.#fixtureReady(cluster, entry)));
    if (!entries.length) return [];
    const firstEntry = entries[0];
    if (!firstEntry) return [];
    const senderNode = tx?.node_id ?? this.store.getTransaction(firstEntry.from)?.node_id
      ?? this.store.listNodes(cluster.id, { parent_id: null })[0]?.id ?? fail('Fixture sender node not found', 404);
    const sent: { message_id: string; recipient: string }[] = [];
    const sender = this.roleAgentOf(cluster.id, senderNode, 'orchestrator');
    for (const entry of entries) {
      const recipient = this.#fixtureRecipient(cluster, entry);
      if (!recipient) {
        this.store.appendEvent(cluster.id, 'fixture-message-undeliverable', { message_id: entry.message_id, to: entry.to });
        continue;
      }
      const result = this.store.tx(() => this.communicateFrom(
        { cluster_id: cluster.id, agent_id: sender?.id ?? null, node_id: senderNode, role: 'orchestrator' },
        'send',
        { agent: recipient.id, content: entry.content, message_id: entry.message_id },
      ));
      if ('deduped' in result && !result.deduped) {
        const recipientNode = this.store.getNode(recipient.node_id);
        this.store.appendEvent(cluster.id, 'fixture-message-sent', {
          message_id: entry.message_id, from: entry.from, recipient: recipient.id,
          recipient_node: recipient.node_id, sender_node: senderNode,
          cross_subtree: Boolean(recipientNode && recipientNode.parent_id === senderNode),
        });
        sent.push({ message_id: entry.message_id, recipient: recipient.id });
      }
      void tx;
    }
    return sent;
  }

  /**
   * Take this agent's undelivered messages out of the queue and mark them
   * injected. A delivery is only acked after the turn's session is flushed, so
   * the crash window between injection and ack can be repaired without a
   * second copy: recovery acks what was already injected and never re-injects.
   */
  /**
   * Take on this agent's pending deliveries.
   *
   * A delivery can be pending while its prompt is *already durable* in the
   * recipient's session — the tool pipeline flushes the session mid-turn, so a
   * turn that dies at its final flush leaves the message written but unacked.
   * Such a delivery is acked here instead of injected again: replaying it would
   * put the same message in the session twice.
   */
  async collectDeliveries(agent: AgentRecord): Promise<CollectedDeliveries> {
    if (this.#disposed) return { messages: [], ids: [], reconciled: 0 };
    const pending = this.store.pendingDeliveries(agent.id);
    if (!pending.length) return { messages: [], ids: [], reconciled: 0 };
    const persistence = this.#persistence ?? (() => {
      try { return this.ctx.get?.('sessionPersistence') ?? null; } catch { return null; }
    })();
    if (persistence) this.#persistence = persistence;
    const toInject = [];
    let reconciled = 0;
    for (const row of pending) {
      if (!persistence || !agent.session_id) {
        toInject.push(row);
        continue;
      }
      // A session that does not exist has never been injected: that is a proven
      // absence, so the message is delivered rather than withheld. Only a
      // session that exists but cannot be read is UNKNOWN.
      const exists = await this.sessionExists(agent.session_id);
      const proof: DeliveryProof = exists === false
        ? { state: 'ABSENT', found: false, reason: 'the recipient has no session yet, so nothing has been injected' }
        : await sessionCarries(persistence, agent.session_id, row.message_id, this.#persistenceAbort.signal);
      if (this.#disposed) return { messages: [], ids: [], reconciled };
      if (proof.state === 'UNKNOWN') {
        // Unprovable: keep it queued, record why, and do not inject a possible
        // second copy.
        this.store.tx(() => this.store.appendEvent(agent.cluster_id, 'delivery-unknown', {
          agent_id: agent.id, message_id: row.message_id, session_id: agent.session_id, reason: proof.reason ?? null,
        }));
        continue;
      }
      if (proof.state !== 'FOUND') {
        toInject.push(row);
        continue;
      }
      reconciled += 1;
      this.store.tx(() => {
        this.store.ackDelivery(row.message_id, agent.id);
        this.store.appendEvent(agent.cluster_id, 'messages-ack-reconciled', {
          agent_id: agent.id, message_id: row.message_id, session_id: agent.session_id,
          reason: 'the prompt was already durable in the session', scanned: proof.scanned ?? null,
        });
      });
    }
    if (!toInject.length) return { messages: [], ids: [], reconciled };
    const ids = toInject.map(row => row.message_id);
    this.store.tx(() => {
      for (const id of ids) this.store.markDeliveryInjected(id, agent.id);
      this.store.appendEvent(agent.cluster_id, 'messages-injected', { agent_id: agent.id, message_ids: [...ids] });
    });
    return { messages: toInject, ids, reconciled };
  }

  /**
   * Ack deliveries whose turn was *provably* admitted and flushed. A turn that
   * never reached the model reopens them instead, so a startup failure cannot
   * consume a message.
   */
  settleDeliveries(clusterId: string, agentId: string, ids: readonly string[], { admitted, durable = false }: { admitted: boolean; durable?: boolean }): number {
    if (!ids?.length) return 0;
    // A message may only be acked when its prompt was admitted *and* the
    // session was flushed: `followup` alone does not make it durable.
    if (!admitted || !durable) {
      this.store.tx(() => {
        for (const id of ids) {
          this.store.run("UPDATE recipients SET status='PENDING', acked=NULL WHERE message_id=? AND recipient=? AND status='DELIVERED'", id, agentId);
        }
        this.store.appendEvent(clusterId, 'messages-reopened', {
          agent_id: agentId, message_ids: [...ids],
          reason: admitted ? 'the session was not flushed before the turn ended' : 'the turn never reached the model',
        });
      });
      return 0;
    }
    // The durable-flush boundary: recorded so a fault trigger can land exactly
    // between "the session is durable" and "the delivery is acked".
    this.store.tx(() => this.store.appendEvent(clusterId, 'delivery-flushed', { agent_id: agentId, message_ids: [...ids] }));
    this.store.tx(() => {
      for (const id of ids) this.store.ackDelivery(id, agentId);
      this.store.appendEvent(clusterId, 'messages-acked', { agent_id: agentId, message_ids: [...ids] });
    });
    return ids.length;
  }

  /**
   * Keep a live identity supplied from its node's remaining budget. The grant
   * is a real transfer, so the ledger stays hierarchical and the Allocator can
   * still move budget explicitly with `rebalance_budget`.
   */
  /**
   * Top-up entry point for the request path. The request path names the *gap*
   * it is short of, in the dimensions it needs; nothing else moves.
   *
   * Two rules make this honest rather than generous:
   * - a Worker whose request allowance is spent gets no tokens — paying for a
   *   request that cannot be sent is not a top-up;
   * - the node is asked for the gap, and siblings are reclaimed only when the
   *   node really cannot cover it.
   */
  topUpBudgetForAgent(agent: AgentRecord, amounts: LedgerAmounts = {}): FlowBudgetInput | null {
    const cluster = this.store.getCluster(agent.cluster_id) ?? fail('Cluster not found', 404);
    const agentBudgetId = this.store.budgetForScope(agent.cluster_id, 'agent', agent.id)?.id;
    const agentBudget = agentBudgetId ? this.store.getBudget(agentBudgetId) : null;
    const nodeBudget = this.fundingBudget(cluster, agent);
    if (!agentBudget || !nodeBudget) return null;
    const wanted = positiveLedgerAmounts(amounts);
    const allowance = this.workerRequestAllowance(agent);
    // Top-ups cannot extend a Worker's per-identity request allowance.
    // Tool calls remain fundable so a Worker can submit its final result after
    // using its last model request.
    const wantsRequests = Number(wanted.model_requests ?? 0) > 0;
    if (allowance !== null && wantsRequests && this.store.countWorkerRequests(cluster.id, agent.id) >= allowance) return null;
    const row = this.store.getBudget(agentBudget.id) ?? fail('Budget not found', 404);
    const gap: Record<string, number> = {};
    for (const key of LEDGER_DIMENSIONS) {
      const need = wanted[key];
      if (need === undefined) continue;
      // Measure the recipient deficit against its limit, including any usage
      // that overshot the reservation.
      const { limit, reserved, spent } = budgetDimensionAmounts(row, key);
      const short = need + reserved + spent - limit;
      if (short > 0) gap[key] = short;
    }
    if (!Object.keys(gap).length) return null;
    const node = this.store.getBudget(nodeBudget.id) ?? fail('Budget not found', 404);
    const shortAtNode = Object.entries(gap).some(([key, need]) => dimensionAvailable(node, key) < need);
    // Reclaim only idle identities funded by this node. If its own file still
    // cannot cover the measured gap, unallocated capacity held by an ancestor
    // node may follow the parent_budget_id path down. No sibling's node grant
    // moves automatically; cross-subtree rebalances remain Allocator actions.
    if (shortAtNode) this.reclaimSiblingGrants(cluster, agent, nodeBudget.id);
    const afterReclaim = this.store.getBudget(nodeBudget.id) ?? fail('Budget not found', 404);
    const missing: Record<string, number> = {};
    for (const [key, need] of Object.entries(gap)) {
      const short = Math.max(0, need - dimensionAvailable(afterReclaim, key));
      if (short > 0) missing[key] = short;
    }
    if (Object.keys(missing).length) {
      const path = [nodeBudget.id];
      let source = afterReclaim.parent_budget_id ? this.store.getBudget(afterReclaim.parent_budget_id) : null;
      while (source !== null && source.scope_kind === 'node') {
        // The ancestor may look empty because its own idle roles hold the
        // unused grant. Bring it back to that node (never from a sibling node)
        // before deciding whether the whole measured gap can follow this path.
        const ancestor = source;
        if (Object.entries(missing).some(([key, need]) => dimensionAvailable(ancestor, key) < need)) {
          this.reclaimIdleRoleGrants(cluster, ancestor.id);
        }
        const refreshed = this.store.getBudget(ancestor.id) ?? fail('Budget not found', 404);
        source = refreshed;
        if (Object.entries(missing).every(([key, need]) => dimensionAvailable(refreshed, key) >= need)) {
          // Down the path one hop at a time: each transfer moves the capacity
          // from the scope that now holds it into the next one below, so no
          // intermediate node keeps a second copy while the requester goes
          // short.
          let carrier = refreshed;
          for (let index = path.length - 1; index >= 0; index -= 1) {
            const targetBudgetId = path[index] ?? fail('Budget path is empty', 500);
            transferBudget(this.store, carrier.id, targetBudgetId, missing);
            source = this.store.getBudget(targetBudgetId) ?? fail('Budget not found', 404);
            carrier = source;
          }
          this.store.appendEvent(cluster.id, 'budget-topup', {
            agent_id: agent.id, node_id: agent.node_id, granted: asJsonValue(missing), mode: 'ancestor-request-gap',
          });
          break;
        }
        path.push(refreshed.id);
        source = refreshed.parent_budget_id ? this.store.getBudget(refreshed.parent_budget_id) : null;
      }
    }
    const available = this.store.getBudget(nodeBudget.id) ?? fail('Budget not found', 404);
    // All or nothing, over the *whole* envelope. A partial grant is the worst of
    // both worlds: the request it was meant to fund still cannot be reserved, and
    // the capacity it moved is now held by an identity that cannot spend it.
    for (const [key, need] of Object.entries(gap)) {
      if (dimensionAvailable(available, key) < need) return null;
    }
    const give = { ...gap };
    const agentBudgetCurrent = this.store.getBudget(agentBudget.id) ?? fail('Budget not found', 404);
    const granted = this.grantBudget(nodeBudget, agentBudgetCurrent, give);
    if (granted) {
      const after = this.store.getBudget(agentBudget.id) ?? fail('Budget not found', 404);
      this.store.appendEvent(cluster.id, 'budget-topup', {
        agent_id: agent.id, node_id: agent.node_id, granted: asJsonValue(granted), mode: 'request-gap',
        // The resulting state is recorded with the grant: a top-up that does not
        // move the identity's availability is a bookkeeping defect, and the
        // numbers are what makes that visible.
        available_after: {
          tokens: dimensionAvailable(after, 'tokens'),
          model_requests: dimensionAvailable(after, 'model_requests'),
          tool_calls: dimensionAvailable(after, 'tool_calls'),
        },
      });
    }
    return granted;
  }

  /**
   * Fund the compaction pool's measured deficit from the root node budget.
   * Reclaim that node's idle identity grants while retaining live reservations.
   */
  topUpCompactionPool(clusterId: string, amounts: LedgerAmounts = {}): unknown {
    const poolId = this.compactionBudgetId(clusterId);
    const pool = poolId ? this.store.getBudget(poolId) : null;
    const rootId = this.store.listNodes(clusterId, { parent_id: null })[0]?.id ?? null;
    const node = rootId ? this.store.budgetForScope(clusterId, 'node', rootId) : null;
    if (!pool || !node) return null;
    const wanted = positiveLedgerAmounts(amounts);
    if (!Object.keys(wanted).length) return null;
    const gap: Record<string, number> = {};
    for (const key of LEDGER_DIMENSIONS) {
      const need = wanted[key];
      if (need === undefined) continue;
      // Refill against the limit, including any prior overshoot.
      const { limit, reserved, spent } = budgetDimensionAmounts(pool, key);
      const short = need + reserved + spent - limit;
      if (short > 0) gap[key] = short;
    }
    if (!Object.keys(gap).length) return null;
    const before = this.store.getBudget(node.id) ?? fail('Budget not found', 404);
    if (Object.entries(gap).some(([key, need]) => dimensionAvailable(before, key) < need)) {
      this.reclaimAllIdleGrants(clusterId, node.id);
    }
    const available = this.store.getBudget(node.id) ?? fail('Budget not found', 404);
    const give: Record<string, number> = {};
    for (const [key, need] of Object.entries(gap)) {
      const movable = Math.min(need, dimensionAvailable(available, key));
      if (movable > 0) give[key] = movable;
    }
    if (!Object.keys(give).length) return null;
    const nodeBudget = this.store.getBudget(node.id) ?? fail('Budget not found', 404);
    const poolBudget = this.store.getBudget(pool.id) ?? fail('Budget not found', 404);
    const granted = this.grantBudget(nodeBudget, poolBudget, give);
    if (granted) {
      this.store.appendEvent(clusterId, 'budget-topup', { scope: pool.id, granted: asJsonValue(granted), mode: 'compaction-pool' });
    }
    return granted;
  }

  /**
   * Every idle identity's unused, unreserved grant, back to *the scope that
   * funded it*.
   *
   * The parent check confines reclamation to identities funded by this node.
   * Other subtrees retain their capacity; reclamation never crosses a
   * `parent_budget_id`.
   */
  reclaimAllIdleGrants(clusterId: string, nodeBudgetId: string): Record<string, number> | null {
    const moved: Record<string, number> = {};
    for (const sibling of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      if (sibling.parent_budget_id !== nodeBudgetId) continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      if (!row) continue;
      const give: Record<string, number> = {};
      for (const key of LEDGER_DIMENSIONS) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  /**
   * Move every *idle* sibling identity's unused, unreserved surplus back to the
   * node. Idle means "not running a turn": a live turn's grant is what the node
   * must keep funding, and reclaiming it mid-request would strand the request
   * that is already reserved. There is no fixed floor — a reserve that is never
   * spent is exactly the capacity the starving identity needed.
   */
  /**
   * Reclaim idle identity grants before this node funds a child. The capacity
   * remains inside the granting node's domain, and live turns retain theirs.
   */
  /** Idle identities funded by one node hand their unspent, unreserved grants back to it. */
  reclaimIdleRoleGrants(cluster: ClusterRecord | string, nodeBudgetId: string): Record<string, number> | null {
    // Callers pass either the cluster row or its id; taking `cluster.id` from a
    // string silently matched nothing, which is exactly the failure this method
    // exists to prevent.
    const clusterId = typeof cluster === 'string' ? cluster : cluster.id;
    if (!clusterId) return null;
    const node = this.store.getBudget(nodeBudgetId);
    if (!node) return null;
    const moved: Record<string, number> = {};
    for (const budget of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      if (budget.parent_budget_id !== nodeBudgetId) continue;
      // Reclaim only idle identities. Live-turn grants require an explicit
      // Allocator rebalance; reclaiming them here could unfund an imminent request.
      // Return the full idle grant so the request's actual gap can be funded.
      if (this.store.leaseForAgent(budget.scope_id)) continue;
      const row = this.store.getBudget(budget.id);
      if (!row) continue;
      const give: Record<string, number> = {};
      for (const key of LEDGER_DIMENSIONS) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  reclaimSiblingGrants(cluster: ClusterRecord, agent: AgentRecord, nodeBudgetId: string): Record<string, number> | null {
    const moved: Record<string, number> = {};
    for (const sibling of this.store.listBudgets(cluster.id, { scope_kind: 'agent' })) {
      // Siblings are the identities funded by the same parent budget.
      if (sibling.scope_id === agent.id || sibling.parent_budget_id !== nodeBudgetId) continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      if (!row) continue;
      const give: Record<string, number> = {};
      for (const key of LEDGER_DIMENSIONS) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }


  /**
   * Move every identity grant that no live turn can spend back to the scope
   * that funded it. Run at recovery, when the identities that held those grants
   * belong to a process that no longer exists.
   */
  returnFencedGrants(clusterId: string): Record<string, number> | null {
    const moved: Record<string, number> = {};
    for (const sibling of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      // Worker grants belong to one transaction turn and return to their node
      // after process loss. Management identities retain their grants because
      // they continue after restart.
      const owner = this.store.getAgent(sibling.scope_id);
      if (!owner || owner.role !== 'worker') continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      if (!row) continue;
      const parent = row.parent_budget_id ? this.store.getBudget(row.parent_budget_id) : null;
      if (!parent) continue;
      const give: Record<string, number> = {};
      for (const key of LEDGER_DIMENSIONS) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, parent.id, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  /**
   * The budget that actually funds an identity: its agent budget's own parent.
   * A Worker's node id points at the worker node, while its grant is parented
   * to the management node's budget, so resolving by `agent.node_id` would look
   * for a node budget that never exists.
   */
  fundingBudget(cluster: ClusterRecord, agent: AgentRecord): BudgetRecord | null {
    const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
    if (!agentBudget) return null;
    const parent = agentBudget.parent_budget_id ? this.store.getBudget(agentBudget.parent_budget_id) : null;
    if (parent) return parent;
    return this.store.budgetForScope(cluster.id, 'node', agent.node_id) ?? null;
  }



  /**
   * The enforcing scope for one agent's requests is its own grant. Budget moves
   * downward as a transfer (`limit` leaves the parent), so reserving on the
   * whole lineage would double-count the same tokens.
   */
  agentBudgetChain(cluster: ClusterRecord, agent: AgentRecord): readonly string[] {
    const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
    if (agentBudget) return [agentBudget.id];
    const nodeBudget = this.store.budgetForScope(cluster.id, 'node', agent.node_id);
    return nodeBudget ? [nodeBudget.id] : [];
  }

  /** Transfer a node's unused, unreserved capacity to a child budget. */
  grantBudget(parentBudget: BudgetRecord, childBudget: BudgetRecord, amounts: FlowBudgetInput = {}): FlowBudgetInput | null {
    if (!parentBudget || !childBudget) return null;
    // Always work from the current rows: a caller's budget object is a
    // snapshot, and a stale snapshot would grant the same capacity twice.
    const parent = this.store.getBudget(parentBudget.id ?? parentBudget);
    const child = this.store.getBudget(childBudget.id ?? childBudget);
    if (!parent || !child) return null;
    const transfer: Record<string, number> = {};
    // Only the dimensions the caller names move. An omitted dimension is not
    // "grant everything": a budget top-up must never hand over the node's
    // agent or active-slot capacity.
    for (const [key, wanted] of Object.entries(amounts)) {
      if (!['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents'].includes(key)) {
        fail(`Unknown budget dimension: ${key}`);
      }
      const available = dimensionAvailable(parent, key);
      if (available <= 0) continue;
      const give = Math.min(available, Math.floor(wanted));
      if (give > 0) transfer[key] = give;
    }
    if (!Object.keys(transfer).length) return null;
    transferBudget(this.store, parent.id, child.id, transfer);
    return transfer;
  }

  teamSelectModel(sessionId:string,model:FlowModelSelection):void {
    if(!model.provider||!model.model)return;
    for(const run of this.teamRuns(sessionId).filter(run=>!['completed','cancelled','failed'].includes(run.state))) {
      const root=this.store.nodesInSubtree(run.id,null).find(node=>node.parent_id===null);
      if(!root||root.scope?.team_model_fixed===true||JSON.stringify(root.scope?.team_model)===JSON.stringify(model))continue;
      this.store.tx(()=>{
        this.store.updateNode(root.id,{scope:{...root.scope,team_model:{...model}}});
        this.store.appendEvent(run.id,'team-model-selected',asJsonValue({main_session_id:sessionId,model}));
      });
    }
  }

  modelFor(agent: AgentRecord): FlowModelSelection {
    const root=this.store.nodesInSubtree(agent.cluster_id,null).find(node=>node.parent_id===null);
    return prepareModelSelection(this.config.model, root?.scope,
      this.store.getCluster(agent.cluster_id)?.limits.worker_max_tokens)(agent);
  }

  /**
   * Two surfaces for one turn: `allowed` is the enforced allowlist the guard
   * applies (capability tools plus this role's own agent-scoped flow tools), and
   * `global` is only the subset that must be inherited from the **root** tool
   * registry, which is all `tools.restrict()` may name.
   *
   * A capability that has host packages is mounted into the agent's own scope
   * and is therefore enforced by the guard alone; a capability with no packages
   * (today: `browser`) is provided by the root composition and inherits. The
   * inherited subset is intersected with the names the root registry really
   * holds, so a not-yet-registered tool is never restricted by name.
   */
  allowedToolsFor(cluster: ClusterRecord, role: FlowAgentRole, agent: AgentRecord): { allowed: string[]; global: string[]; capabilities: readonly FlowCapability[] } {
    const flowTools = role === 'worker'
      ? ['flow_transaction', 'flow_query', 'flow_communicate', 'flow_sum']
      : [ROLE_TOOL[role], 'flow_query', 'flow_communicate', 'flow_sum'];
    const allocation = role === 'worker' ? this.store.activeAllocationForAgent(agent.id) : null;
    const capabilities: readonly FlowCapability[] = role === 'worker'
      ? (allocation !== null && allocation.capabilities.length
        ? allocation.capabilities
        : agent.capabilities.length ? agent.capabilities : cluster.capabilities)
      : [];
    const tools = role === 'worker' ? toolsForCapabilities(capabilities) : [];
    const inherited = new Set(capabilities
      .filter(capability => CAPABILITY_PACKAGES[capability].length === 0)
      .flatMap(capability => toolsForCapabilities([capability])));
    const rootNames = new Set(this.ctx.root.get('tools')?.schemas().map(schema => schema.name) ?? []);
    const global = inherited.size
      ? [...inherited].filter(name => rootNames.has(name)).sort()
      : [];
    return { allowed: [...new Set([...tools, ...flowTools])].sort(), global, capabilities };
  }

  #setupAgentScope(agentCtx: Context, agent: AgentRecord, role: FlowAgentRole): void {
    registerRoleTools(agentCtx, this, role);
    agentCtx.on('tools/execute', createToolExecutionHook({
      ctx: agentCtx, store: this.store, logger: this.logger,
      lookupAgent: sessionId => sessionId === agent.session_id ? this.store.getAgentBySession(sessionId) : null,
      beforeTool: (row, exec, callId) => this.admitToolCall(row, exec, callId),
      afterTool: (row, exec, callId, result, error) => this.settleToolCall(row, exec, callId, result, error),
      recheckTool: (row, exec, callId) => this.recheckToolCall(row, exec, callId),
      dispatched: (row, exec, callId) => this.markToolCallDispatched(row, exec, callId),
      refuseTool: (row, exec, callId, reason) => this.refuseToolCall(row, exec, callId, reason ?? 'refused before dispatch'),
      recordEvent: (clusterId, type, data) => { this.store.appendEvent(clusterId, type, asJsonValue(data)); },
    }));
  }

  // -------------------------------------------------------- pending work

  #pendingFor(role: FlowAgentRole, node: NodeRecord, cluster: ClusterRecord, agent: AgentRecord | null = null): readonly PendingAction[] {
    const id = cluster.id;
    const items: PendingAction[] = [];
    // Notifications first: an event a role subscribed to is an action it must
    // take, and consuming it here (in the same transaction that starts the
    // turn) is what makes the inbox a queue rather than a log.
    const recipient = agent?.id ?? this.roleAgentOf(id, node.id, role)?.id ?? null;
    const notifications: PendingAction[] = [];
    if (recipient) {
      // Queue notifications for the next useful turn. The wakes_role flag below
      // identifies critical messages that can independently wake an idle role.
      for (const row of this.store.listInbox(id, {
        recipient, status: 'PENDING', limit: 8, priority: INBOX_PRIORITY_SUBJECTS,
      })) {
        const payload = jsonRecordOf(row.payload);
        notifications.push({
          kind: 'notification', action: 'inbox', subject: row.subject, inbox_id: row.id,
          audit_id: typeof payload?.audit_id === 'string' ? payload.audit_id : null,
          payload: truncate(JSON.stringify(row.payload ?? {}), 400),
          // A budget-blocked child is awaiting an authorized Allocator
          // transfer. Waking its parent's Orchestrator cannot fund it.
          wakes_role: CRITICAL_NOTIFICATION_SUBJECTS.has(row.subject)
            && !(row.subject === 'child-blocked' && payload?.code === 'BUDGET_EXHAUSTED'),
        });
      }
    }
    if (role === 'orchestrator') {
      // Query each status directly so pagination cannot hide pending work.
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'DRAFT', limit: 64 })) {
        const unanswered = this.store.openIssues(id, { transaction_id: tx.id, status: 'OPEN' })
          .find(issue => !this.issueProgressed(id, issue).progressed);
        const planInputs = jsonRecordOf(tx.inputs);
        items.push(unanswered
          ? { action: 'revise-plan', transaction_id: tx.id, revision: tx.revision, issue_id: unanswered.id,
            required_change: String(unanswered.required_change ?? '').slice(0, 300),
            write_scope: asJsonValue(planInputs?.write_scope ?? []), acceptance_criteria: tx.acceptance_criteria }
          : { action: 'dispatch', transaction_id: tx.id, objective: tx.objective.slice(0, 120), revision: tx.revision });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'REJECTED', limit: 32 })) {
        const unanswered = this.store.openIssues(id, { transaction_id: tx.id, status: 'OPEN' })
          .find(issue => !this.issueProgressed(id, issue).progressed);
        const resultInputs = jsonRecordOf(tx.inputs);
        items.push(unanswered
          ? { action: 'correct-result', transaction_id: tx.id, revision: tx.revision, issue_id: unanswered.id,
            required_change: String(unanswered.required_change ?? '').slice(0, 300),
            write_scope: asJsonValue(resultInputs?.write_scope ?? []), acceptance_criteria: tx.acceptance_criteria }
          : { action: 'replan-or-redispatch', transaction_id: tx.id, revision: tx.revision, objective: tx.objective.slice(0, 120) });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'BLOCKED', limit: 32 })) {
        items.push({ action: 'escalate-or-unblock', transaction_id: tx.id, revision: tx.revision });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'SUBMITTED', limit: 32 })) {
        // Validation is about a parent's *own* result: while its delegated work is
        // open, the honest action is `aggregate`, not accepting the parent's answer.
        if (this.store.parentsAwaitingChildren(id, node.id).includes(tx.id)) continue;
        items.push({ action: 'validate', transaction_id: tx.id, revision: tx.revision, objective: tx.objective.slice(0, 120) });
      }
      for (const row of this.store.aggregatableParents(id, node.id, { limit: 32 })) {
        items.push({ action: 'aggregate', transaction_id: row.parent_id, children: Number(row.children) });
      }
      if (node.delegated_transaction_id) {
        const delegated = this.store.getTransaction(node.delegated_transaction_id);
        // Notify the parent while submission or validation is pending. Accepted
        // child results are already visible through aggregatableParents and do
        // not require additional reporting turns.
        if (delegated && ['SUBMITTED', 'VALIDATING'].includes(delegated.status)) {
          items.push({ action: 'report-to-parent', transaction_id: delegated.id, status: delegated.status });
        }
      }
      if (!items.length && this.store.countTransactions(id, { node_id: node.id }) === 0) {
        items.push({ action: 'decompose', transaction_id: node.delegated_transaction_id ?? null, note: 'node has no transactions yet' });
      }
      if (!node.parent_id && !this.store.get(
        "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        id, node.id,
      )) {
        const total = this.store.countTransactions(id, { parent_transaction_id: null });
        const accepted = this.store.countTransactions(id, { parent_transaction_id: null, status: ['ACCEPTED'] });
        if (total > 0 && accepted === total) {
          items.push({ action: 'finish_cluster', note: 'all root transactions are ACCEPTED; complete outstanding cluster-objective work before requesting closure' });
        }
      }
    } else if (role === 'allocator') {
      // Delegated parents are Orchestrator aggregation work, even after the
      // last child is accepted. The Worker frontier only includes leaf work.
      const owesChild = node.delegated_transaction_id && this.pendingDelegationInstruction(cluster, node)
        ? node.delegated_transaction_id : null;
      const unallocated = this.store.all(
        `SELECT id, revision FROM transactions t
          WHERE t.cluster_id=? AND t.node_id=? AND t.status='READY'
            AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.transaction_id = t.id AND a.status='ACTIVE')
            AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.cluster_id=t.cluster_id AND c.parent_transaction_id=t.id)
          ORDER BY t.priority DESC, t.created, t.id LIMIT 32`, id, node.id,
      ).filter(row => row.id !== owesChild);
      // A hint the node cannot execute is not work. `allocate_agent` fails at the
      // child ceiling, so offering it to a full node booked three no-progress
      // Allocator turns and then blocked the node for stagnation — while the
      // Workers that would have freed a slot were still waiting on the Auditor.
      // The ceiling is the same one `createWorkerForTransaction` enforces.
      const occupiedChildren = this.store.childrenOf(node.id).filter(child => child.status !== 'RELEASED').length;
      const childCeiling = node.max_children ?? cluster.limits.max_children;
      const freeSlots = Math.max(0, childCeiling - occupiedChildren);
      if (unallocated.length && freeSlots > 0) {
        items.push({
          action: 'allocate_agent',
          transactions: unallocated.slice(0, freeSlots).map(row => textField(row.id, 'transaction.id', 128)),
          count: Math.min(unallocated.length, freeSlots),
          free_slots: freeSlots,
          // What the window can fill *now* is not what the node still owes: a
          // caller that can see only the executable slice cannot tell a node
          // that is nearly done from one that is about to run out of the
          // capacity its remaining work needs.
          unallocated_total: unallocated.length,
        });
      }
      const releasable = this.store.allocationsForNode(node.id, { status: 'ACTIVE' }).filter(allocation => {
        const tx = allocation.transaction_id ? this.store.getTransaction(allocation.transaction_id) : null;
        return !tx || ['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)
          || (this.store.allocationOutdated(id, allocation) && !this.activeTurnFor(allocation.agent_id));
      });
      if (releasable.length) items.push({ action: 'release_agent', allocations: releasable.map(a => a.id).slice(0, 64) });
      const nodeBudget = this.store.budgetForScope(id, 'node', node.id);
      {
        // A rebalance hint must name an Allocator whose domain owns both ends.
        // Capacity outside the requesting subtree belongs to an ancestor's decision.
        const within = this.store.nodesInSubtree(id, node.id).map(entry => entry.id);
        // Include idle role grants as candidate sources as well as node scopes.
        // The responsible Allocator decides whether to move the capacity.
        const budgets = new Map<string, BudgetRowWithNode>();
        for (const row of this.store.listBudgets(id, {})) {
          // Only scopes this allocator owns: its own node and the subtree below.
          if (row.scope_kind === 'node') {
            if (within.includes(row.scope_id)) budgets.set(row.scope_id, row);
          }
          else if (row.scope_kind === 'agent') {
            const agent = this.store.getAgent(row.scope_id);
            if (agent && within.includes(agent.node_id)) budgets.set(row.scope_id, { ...row, via_node_id: agent.node_id });
          }
        }
        // Include every spendable dimension so a tool-call shortfall is visible
        // even when the node has ample tokens and model requests.
        const headroomOf = (row: BudgetRowWithNode): BudgetHeadroom => ({
          scope_kind: row.scope_kind === 'agent' ? 'agent' : 'node', scope_id: row.scope_id,
          node_id: row.node_id ?? row.via_node_id ?? null,
          tokens: Math.max(0, row.tokens_limit - row.tokens_spent - row.tokens_reserved),
          model_requests: Math.max(0, row.requests_limit - row.requests_spent - row.requests_reserved),
          tool_calls: Math.max(0, row.tool_calls_limit - row.tool_calls_spent - row.tool_calls_reserved),
        });
        const enough = (row: BudgetHeadroom): boolean => row.tokens > 4 * Math.max(16_384, Number(this.config.context.role ?? 8192) * 2)
          || row.model_requests > 4 || row.tool_calls > 16;
        const spenders = ['tokens', 'model_requests', 'tool_calls'] as const;
        for (const candidate of within) {
          const short = budgets.get(candidate);
          if (!short) continue;
          const owner = this.store.getNode(candidate);
          if (owner?.kind !== 'management' || owner.status !== 'BLOCKED') continue;
          // A zero balance has no request size. Waking an ancestor to fund it
          // led to repeated one-token transfers; admission will first try the
          // local grant and record an exact refusal if the node really cannot
          // run. Only then may the ancestor move capacity across subtrees.
          const stopped = this.store.get(
            `SELECT data FROM events WHERE cluster_id=? AND type='node-blocked'
              AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1`, id, candidate);
          const stoppedData = stopped === undefined ? null : textField(stopped.data, 'node-blocked.data');
          const block = stoppedData === null ? null : jsonRecordOf(decodeJson(stoppedData));
          if (block?.code !== 'BUDGET_EXHAUSTED') continue;
          const envelope = jsonRecordOf(block.envelope);
          const dimension = typeof block.dimension === 'string' ? block.dimension : null;
          const requested = typeof block.requested === 'number' ? block.requested : 0;
          const requiredOf = (key: string): number => {
            const direct = envelope?.[key];
            if (typeof direct === 'number') return Math.max(0, direct);
            return dimension === key ? Math.max(0, requested) : 0;
          };
          const required: Record<string, number> = {
            tokens: requiredOf('tokens'), model_requests: requiredOf('model_requests'), tool_calls: requiredOf('tool_calls'),
          };
          if (!spenders.some(key => dimensionAvailable(short, key) < (required[key] ?? 0))) continue;
          const sources = [...budgets.values()]
            .filter(other => other.scope_id !== candidate)
            .map(headroomOf)
            .filter(row => enough(row))
            .sort((a, b) => (b.tokens + b.model_requests * 16_384) - (a.tokens + a.model_requests * 16_384))
            .slice(0, 3);
          if (!sources.length) continue;
          items.push({
            action: 'rebalance_budget', to: { kind: 'node', id: candidate }, from_options: asJsonValue(sources),
            required: asJsonValue(required),
            note: 'a node with actionable local work cannot afford its next request; fund the full refused envelope',
          });
          break;
        }
      }
      const required = this.#requiredDelegation(cluster, node);
      const have = this.store.childrenOf(node.id).filter(child => child.kind === 'management').length;
      if (have < required.length) {
        const instruction = required[have];
        if (instruction) items.push({
          action: 'spawn_management_node',
          node_id: node.id,
          instruction: asJsonValue({
            scope: instruction.scope, objective: instruction.objective,
            max_children: instruction.max_children, spawn_children: instruction.spawn_children,
            budget: instruction.budget === undefined ? null : asJsonValue(instruction.budget),
          }),
          note: 'the topology fixture requires this management child; call flow_allocation spawn_management_node with scope, max_children and spawn_children from this instruction',
        });
      }
      // Only an unfinished Worker's *owner* can fund it, and a declared
      // per-Worker request allowance is a ceiling, not a request for a top-up.
      const starved = this.store.all(
        `SELECT b.scope_id AS agent_id FROM budgets b
           JOIN agents a ON a.id = b.scope_id
           JOIN allocations al ON al.agent_id = a.id AND al.status='ACTIVE'
           JOIN transactions t ON t.id = al.transaction_id
          WHERE b.cluster_id=? AND b.scope_kind='agent' AND al.node_id=? AND a.status<>'TERMINATED'
            AND a.role='worker' AND t.status IN ('READY','RUNNING')
            AND (b.requests_limit - b.requests_reserved - b.requests_spent) <= 0
          LIMIT 16`, id, node.id).map(row => textField(row.agent_id, 'starved.agent_id', 128))
        .filter(agentId => !cluster.limits.worker_model_requests
          || this.store.countWorkerRequests(id, agentId) < cluster.limits.worker_model_requests);
      if (starved.length && nodeBudget && dimensionAvailable(nodeBudget, 'model_requests') > 0) {
        items.push({ action: 'rebalance_budget', starved_agents: starved, from: { kind: 'node', id: node.id } });
      }
    } else if (role === 'auditor') {
      const auditorId = recipient;
      const healthId = `${id}:${node.id}:final`;
      const requested = this.store.get('SELECT id FROM health WHERE id=? AND cluster_id=?', healthId, id);
      if (requested && !this.#finalHealthDecision(id, node.id, auditorId)) {
        return [{
          action: 'evaluate_health', evaluation_window: 'subtree-close',
          node_id: node.id, dimensions: this.healthMetricNames(),
          signals: asJsonValue(this.healthSignals(id, { windowMs: this.config.staleMs })),
        }, ...notifications];
      }
      // Validation is the acceptance gate; advisory plan reviews must not fill
      // its entire eight-item page while finished Worker results wait behind
      // them. Keep the same keyset rotation within each kind, and return to the
      // oldest pending item of that kind when its cursor has passed the end.
      // A capacity probe only reads; #startTurn moves the cursor on admission.
      const cursor = this.#auditCursor.get(node.id) ?? null;
      let pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'validation', limit: 8, after: cursor });
      if (!pending.length && cursor) {
        pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'validation', limit: 8 });
      }
      if (!pending.length) {
        pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'plan', limit: 8, after: cursor });
        if (!pending.length && cursor) {
          pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'plan', limit: 8 });
        }
      }
      for (const audit of pending) {
        // Carry the transaction's actual acceptance criteria with each audit
        // action so the verdict refers to the exact contract being reviewed.
        const subject = audit.transaction_id === null ? null : this.store.getTransaction(audit.transaction_id);
        items.push({
          action: audit.kind === 'plan' ? 'inspect_plan' : 'inspect_validation',
          audit_id: audit.id, transaction_id: audit.transaction_id, target_revision: audit.target_revision,
          objective: subject ? String(subject.objective ?? '').slice(0, 200) : null,
          acceptance_criteria: subject ? (subject.acceptance_criteria ?? []) : [],
          expected_output: subject ? String(subject.expected_output ?? '').slice(0, 200) : null,
        });
      }
      // A Worker that submits "blocked" instead of attempting a forbidden effect
      // has supplied evidence of an unsatisfied result, not a write-refused event.
      // Keep that original revision visible after the Orchestrator adjusts the
      // plan: an independent Auditor can still open and verify the correction.
      const blockedResults = this.store.all(
        `SELECT e.seq, e.data FROM events e
          WHERE e.cluster_id=? AND e.type='result-submitted'
            AND json_extract(e.data,'$.node_id')=?
            AND json_extract(e.data,'$.result_completed')=0
            -- A later plan revision may be the issue's target even though the
            -- original blocked Worker event retains its own earlier revision.
            -- Match the issue-opened event *after* that result, so an old issue
            -- does not hide a genuinely new blocked Worker attempt.
            AND NOT EXISTS (
              SELECT 1 FROM issues i
                JOIN events opened ON opened.cluster_id=i.cluster_id AND opened.type='issue-opened'
                  AND json_extract(opened.data,'$.issue_id')=i.id AND opened.seq>e.seq
               WHERE i.cluster_id=e.cluster_id
                 AND i.transaction_id=json_extract(e.data,'$.transaction_id')
                 AND i.target_revision>=json_extract(e.data,'$.revision'))
          ORDER BY e.seq DESC LIMIT 8`, id, node.id);
      for (const row of blockedResults) {
        const result = jsonRecordOf(decodeJson(textField(row.data, 'result-submitted.data')));
        if (!result) continue;
        const transactionId = textField(result.transaction_id, 'result-submitted.transaction_id', 128);
        const tx = this.store.getTransaction(transactionId);
        if (!tx || TRANSACTION_TERMINAL.has(tx.status)) continue;
        items.push({
          action: 'request_correction', transaction_id: tx.id,
          target_revision: integer(result.revision ?? 0, 0, 2 ** 20, 'result-submitted.revision'),
          result_status: typeof result.result_status === 'string' ? result.result_status : null,
          reason: 'the Worker submitted a result explicitly marked incomplete',
          required_change: 'correct the plan or allocation so the Worker can satisfy the transaction acceptance criteria',
        });
      }
      // A refused write is the owning management node's Auditor's work, not
      // every ancestor's: exposing one Worker refusal to the whole subtree
      // opened several independent issues for one denied effect.
      const refusals = this.store.all(
        `SELECT e.seq, e.data, a.transaction_id FROM events e
           JOIN allocations a ON a.cluster_id=e.cluster_id
             AND a.agent_id=json_extract(e.data,'$.agent_id')
           JOIN transactions t ON t.id=a.transaction_id AND t.cluster_id=e.cluster_id
          WHERE e.cluster_id=? AND e.type='write-refused' AND t.node_id=?
          ORDER BY e.seq DESC LIMIT 8`,
        id, node.id,
      );
      // Only refusals nobody has taken up yet: a handled refusal must not reopen the
      // same issue on every pass, while a genuinely new refusal still surfaces.
      const handled = new Set(this.store.all(
        "SELECT json_extract(data,'$.seq') AS seq FROM events WHERE cluster_id=? AND type='refusal-handled'",
        id,
      ).map(row => Number(row.seq)));
      const seenRefusals = new Map<string, { refusal_seqs: number[] }>();
      for (const refusal of refusals) {
        const data = jsonRecordOf(decodeJson(textField(refusal.data, 'write-refused.data')));
        if (!data) continue;
        const sequence = integer(refusal.seq, 0, 2 ** 53, 'write-refused.seq');
        const transactionId = optionalText(refusal.transaction_id, 'write-refused.transaction_id');
        if (!transactionId || handled.has(sequence)) continue;
        // Several denied attempts by one allocation have one corrective decision.
        // Keep every sequence on that decision so committing it acknowledges all
        // the refusals it saw, rather than reopening the same issue next turn.
        const previous = seenRefusals.get(transactionId);
        if (previous) {
          previous.refusal_seqs.push(sequence);
          continue;
        }
        // The action must be executable in the state the transaction is really in.
        // Before a result is submitted there is no validation audit, a rejected
        // `validate` leaves its audit OVERRIDDEN (so `inspect_validation` answers
        // deduped and opens nothing), and `request_replan` transitions to DRAFT —
        // which a terminal transaction forbids. A failed branch is escalated, not
        // replanned.
        const transaction = this.store.getTransaction(transactionId);
        if (!transaction) continue;
        const refusalSeqs = [sequence];
        seenRefusals.set(transactionId, { refusal_seqs: refusalSeqs });
        const refusalTool = typeof data.tool === 'string' ? data.tool : null;
        const terminal = ['FAILED', 'CANCELLED', 'ACCEPTED', 'SUPERSEDED'].includes(transaction.status);
        const note = `a write with ${refusalTool ?? 'a tool'} was refused under the current plan: ${String(data.reason ?? '').slice(0, 200)}`;
        items.push(terminal
          ? {
            // A terminal transaction cannot be replanned or blocked again: the
            // escalation that no status forbids is the *node-level* one, which records
            // the refusal for the domain above without touching the transaction.
            action: 'escalate', node_id: transaction.node_id, transaction_id: transactionId,
            refusal_seq: sequence, refusal_seqs: refusalSeqs, tool: refusalTool, status: transaction.status,
            reason: note, note,
          }
          : {
            action: 'request_replan', transaction_id: transactionId,
            refusal_seq: sequence, refusal_seqs: refusalSeqs,
            tool: refusalTool, status: transaction.status,
            reason: note, required_change: 'widen the write scope and re-allocate before resubmitting',
            note,
          });
      }
      // An open issue is review work, not an automatic verdict. A later plan
      // revision or validation is evidence of activity, never evidence that the
      // required change was satisfied; an unchanged issue may also be a real
      // defect awaiting its Orchestrator rather than a mistaken report.
      for (const issue of this.#issuesAwaitingVerdict(id, node.id, agent)) {
        items.push({
          action: 'review_issue', issue_id: issue.id, transaction_id: issue.transaction_id,
          changed_since_issue: issue.progressed,
          required_change: String(issue.required_change ?? '').slice(0, 200),
          severity: issue.severity ?? null,
          review: issue.progressed
            ? 'A later transaction revision exists. Re-check the recorded criterion and new evidence before deciding whether it addresses this issue.'
            : 'No durable correction exists. Re-check the original claim: leave a genuine issue open for the Orchestrator; dismiss only a mistaken claim with contrary evidence.',
        });
      }
    }
    // Notifications accompany pending work. Only critical messages wake an
    // otherwise idle role; load and context notices are coalesced by producers.
    if (items.length) return [...items, ...notifications];
    const critical = notifications.filter(item => item.wakes_role);
    return critical;
  }

  /** Offer actionable review candidates, including one review of a newly raised issue. */
  #issuesAwaitingVerdict(clusterId: string, nodeId: string, agent: AgentRecord | null = null): readonly (IssueRecord & { progressed: boolean })[] {
    // Open issues can be verified after correction or dismissed on contrary
    // evidence. Offer an unchanged issue once, after it is raised; durable
    // progress makes it eligible again without scheduling idle review loops.
    const lastTurnSeq = agent ? Number(this.store.get(
      `SELECT MAX(seq) AS seq FROM events WHERE cluster_id=? AND type='turn-start'
        AND json_extract(data,'$.agent_id')=?`, clusterId, agent.id)?.seq ?? 0) : 0;
    const opened = new Map(this.store.all(
      "SELECT json_extract(data,'$.issue_id') AS issue_id, seq FROM events WHERE cluster_id=? AND type='issue-opened'",
      clusterId,
    ).map(row => [row.issue_id, Number(row.seq)]));
    return this.store.openIssues(clusterId, { node_id: nodeId, status: 'OPEN' })
      .map(issue => ({ ...issue, progressed: this.issueProgressed(clusterId, issue).progressed }))
      .filter(issue => {
        if (issue.progressed) {
          return !this.store.issueHasIncompleteWorkerResult(clusterId, issue)
            || this.store.issueHasNewWorkerEvidence(clusterId, issue);
        }
        if (Number(issue.corrections ?? 0) !== 0 || issue.reviewed_revision || (opened.get(issue.id) ?? 0) < lastTurnSeq) return false;
        // Only a mistaken observation can be withdrawn without a correction.
        // A guard-confirmed denied write on unfinished work is still a defect,
        // so offering a dismissal here sends the Auditor into a false verdict.
        if (this.store.issueHasIncompleteWorkerResult(clusterId, issue)) return false;
        return !this.store.hasConfirmedWriteRefusal(clusterId, issue.transaction_id, issue.evidence)
          || (issue.transaction_id !== null && this.store.getTransaction(issue.transaction_id)?.status === 'ACCEPTED');
      });
  }

  /**
   * Compare the issue with later durable plan adjustments and validation
   * result revisions. issue.corrections counts failed verdicts and cannot
   * itself establish progress.
   */
  issueProgressed(clusterId: string, issue: IssueRecord, { since = 'reviewed' }: { since?: 'raised' | 'reviewed' } = {}): IssueProgress {
    const target = Number(issue.target_revision ?? 0);
    // A closing verdict needs progress since the issue was raised. A failed
    // verdict charges a round only for a revision later than reviewed_revision,
    // so repeated review of the same correction cannot consume another round.
    const reviewed = Number(issue.reviewed_revision ?? 0);
    const lowest = since === 'raised' ? target : Math.max(target, reviewed);
    const adjustment = this.store.get(
      "SELECT MAX(CAST(json_extract(data,'$.revision') AS INTEGER)) AS revision FROM events WHERE cluster_id=? AND type='transaction-adjusted' AND json_extract(data,'$.transaction_id')=?",
      clusterId, issue.transaction_id,
    );
    const validation = this.store.get(
      "SELECT MAX(CAST(json_extract(data,'$.result_revision') AS INTEGER)) AS revision FROM events WHERE cluster_id=? AND type='validation-proposed' AND json_extract(data,'$.transaction_id')=?",
      clusterId, issue.transaction_id,
    );
    // Compare the latest adjustment and validation together so each durable
    // correction revision can consume at most one review round.
    const adjusted = Number(adjustment?.revision ?? 0);
    const revalidated = Number(validation?.revision ?? 0);
    const latest = Math.max(adjusted, revalidated);
    if (latest <= lowest) return { progressed: false, how: null };
    return {
      progressed: true,
      how: adjusted >= revalidated ? 'plan-adjusted' : 'revalidated',
      revision: latest,
    };
  }

  #auditCursor = new Map();
  /** Structured refusals per cluster, so a pass can tell "nothing to do" from
   *  "everything was refused". */
  #refusals = new Map();

  #rolePrompt(cluster: ClusterRecord, node: NodeRecord, agent: AgentRecord, role: FlowAgentRole, pending: readonly PendingAction[]): string {
    // Prompts carry pending actions and references. Models load full evidence
    // through flow_query when needed, keeping each management turn bounded.
    const statusCounts = Object.fromEntries(
      this.store.countTransactionsByStatus(cluster.id, { nodeId: node.id }).map(row => [row.status, Number(row.c)]),
    );
    const actions = pending.filter(item => item.kind !== 'notification');
    const recent = role === 'auditor' && actions.length
      ? [] : this.store.listTransactions({ cluster_id: cluster.id, node_id: node.id, limit: 20 });
    const openIssues = role === 'auditor' && actions.length
      ? [] : this.store.openIssues(cluster.id, { node_id: node.id, status: 'OPEN' });
    // The prompt carries decisions and notification references. Full incoming
    // messages are separately attributed native inputs, so a notification
    // queue cannot displace the role's actionable decisions.
    // The decisions themselves carry current criteria and issues. An Auditor
    // with decisions to make need not receive the same transactions, issues,
    // topology and budget as another copy of the queue on every resumed turn.
    const auditIds = new Set(actions.map(item => item.audit_id).filter(Boolean));
    const notifications = pending.filter(item => item.kind === 'notification'
      && !(item.audit_id && auditIds.has(item.audit_id)
        && (item.subject === 'plan-audit-requested' || item.subject === 'validation-audit-requested')));
    const nodeBudget = this.store.budgetForScope(cluster.id, 'node', node.id);
    // The initial turn establishes the node's objective and delegation
    // contract; its native session (and genuine checkpoints) retain them.
    // Later turns carry current actions instead of repeating the full
    // objective. The authoritative scope remains queryable by node id.
    const scope = node.scope ?? {};
    const initialScope = agent.turns === 0;
    const digest = {
      cluster: { id: cluster.id, status: cluster.status },
      node: {
        id: node.id, depth: node.depth,
        scope: initialScope ? {
          objective: scope.objective,
          ...(scope.spawn_children === undefined ? {} : { spawn_children: scope.spawn_children }),
          ...(scope.delegation_contract ? { delegation_contract: scope.delegation_contract } : {}),
          ...(scope.delegation_entry?.inputs ? { inputs: scope.delegation_entry.inputs } : {}),
        } : {
          ...(actions.some(action => action.action === 'spawn_management_node') && scope.spawn_children !== undefined
            ? { spawn_children: scope.spawn_children } : {}),
        },
        delegated_transaction_id: node.delegated_transaction_id, max_children: node.max_children,
      },
      ancestors: this.managementAncestors(cluster.id, node.id),
      pending_actions: actions.slice(0, 8),
      unread_notifications: notifications.slice(0, 8).map(item => ({
        inbox_id: item.inbox_id, subject: item.subject,
      })),
      transactions: {
        by_status: statusCounts,
        ...(recent.length ? { recent: recent.map(tx => ({
          id: tx.id, status: tx.status, revision: tx.revision, parent: tx.parent_transaction_id,
          priority: tx.priority,
        })) } : {}),
      },
      issues: openIssues.slice(0, 8).map(issue => ({
        id: issue.id, transaction_id: issue.transaction_id, severity: issue.severity,
        required_change: issue.required_change.slice(0, 200),
      })),
      ...(role === 'auditor' && actions.length ? {} : {
        children_of_node: this.store.childrenOf(node.id).slice(0, 16)
          .map(child => ({ id: child.id, kind: child.kind, status: child.status, depth: child.depth })),
      }),
      // A turn only needs available capacity to choose its next action; the
      // full ledger (including scope ids and reservations) is a flow_query away.
      ...(role === 'auditor' && actions.length ? {} : {
        budget_available: nodeBudget ? {
          tokens: dimensionAvailable(nodeBudget, 'tokens'),
          model_requests: dimensionAvailable(nodeBudget, 'model_requests'),
          tool_calls: dimensionAvailable(nodeBudget, 'tool_calls'),
          agents: dimensionAvailable(nodeBudget, 'agents'),
          max_active_agents: dimensionAvailable(nodeBudget, 'max_active_agents'),
        } : null,
        limits: cluster.limits,
      }),
      // Health scoring needs measured signals, not a generic full-domain digest.
      ...(role === 'auditor' && actions.some(action => action.action === 'evaluate_health')
        ? { health: this.#healthDigest(cluster.id) } : {}),
    };
    return [
      `Role: ${role}. Node: ${node.id} (depth ${node.depth}). Agent id: ${agent.id}.`,
      `Workspace: ${cluster.workspace}`,
      '',
      'Current domain state (read anything else with flow_query; every list answers with items/total/next_offset):',
      JSON.stringify(digest),
      '',
      `Perform the pending actions now using the ${ROLE_TOOL[role]} tool, one call per state change.`,
      'Finish your reply with a single line "STATUS: <one sentence>" describing what you changed. Do not claim success for an action you did not actually perform.',
    ].join('\n');
  }

  #workerPrompt(cluster: ClusterRecord, tx: TransactionRecord, allocation: AllocationRecord): string {
    const criteria = jsonStringList(tx.acceptance_criteria);
    const constraints = jsonStringList(tx.constraints);
    const inputs = tx.inputs;
    const hasInputs = inputs === null || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).length > 0;
    return [
      WORKER_PROMPT_HEADER,
      '',
      `Transaction id: ${tx.id}`,
      `Objective: ${tx.objective}`,
      tx.expected_output ? `Expected output: ${tx.expected_output}` : '',
      criteria.length ? `Acceptance criteria:\n${criteria.map(c => `- ${c}`).join('\n')}` : '',
      constraints.length ? `Constraints:\n${constraints.map(c => `- ${c}`).join('\n')}` : '',
      hasInputs ? `Inputs:\n${JSON.stringify(inputs, null, 1).slice(0, 4000)}` : '',
      `Workspace root: ${cluster.workspace}`,
      allocation.write_scope.length ? `You own these paths (do not write outside them): ${allocation.write_scope.join(', ')}` : 'You own no file paths; do not write files.',
      '',
      'Use the tools you have to actually perform the work, then submit the result.',
    ].filter(Boolean).join('\n');
  }

  /** One model-facing message per communication, with durable source attribution. */
  #communicationMessages(agent: AgentRecord, deliveries: readonly DeliveryPromptMessage[], inboxIds: readonly string[] = []): UserMessage[] {
    const nameOf = (identity: AgentRecord): string => `${typeof identity.meta.display_name === 'string' ? identity.meta.display_name : agentGivenName(identity.id)} · ${ROLE_LABELS[identity.role]}`;
    const recipientName = nameOf(agent);
    const message = (id: string, senderId: string | null, senderName: string, content: unknown, at: number, marker = '', eventSubject?: string): UserMessage => {
      const envelope = communicationContent(content);
      const human = communicationContent(envelope.human_prompt);
      if (senderId === null && typeof human.rpc_id === 'string') return createUserMessage({
        content:[{type:'text',text:typeof envelope.text==='string'?envelope.text:''}],
        source:{kind:'user',rpcId:human.rpc_id,...(typeof human.client_time_zone==='string'?{clientTimeZone:human.client_time_zone}:{})},
      });
      const category = communicationCategory(envelope);
      const subject = typeof envelope.subject === 'string' ? envelope.subject : COMMUNICATION_LABELS[category];
      const transactionId = typeof envelope.transaction_id === 'string' ? envelope.transaction_id : null;
      const headline = eventSubject ? notificationHeadline(eventSubject, envelope) : communicationHeadline(envelope);
      const tone = eventSubject ? notificationTone(eventSubject) : category === 'blocker_report' ? 'warning' : 'neutral';
      const header = `[${COMMUNICATION_LABELS[category]}] ${senderName} → ${recipientName}\n${subject}${transactionId ? ` · Transaction ${transactionId}` : ''}\n${marker ? `${marker}\n` : ''}\n`;
      return createUserMessage({
        content: [{ type: 'text', text: `${header}${communicationBody(envelope)}` }],
        source: { kind: 'flow-message', presentation: 'communication', category, run_id: agent.cluster_id, message_id: id,
          sender_id: senderId, sender_name: senderName, recipient_id: agent.id, recipient_name: recipientName,
          transaction_id: transactionId, subject, sent_at: at, body_offset: header.length, form: 'notice',
          summary: headline, display_summary: headline, tone,
        },
      });
    };
    const messages = deliveries.map(row => {
      const sender = row.from_agent ? this.store.getAgent(row.from_agent) : null;
      const senderName = sender ? nameOf(sender) : row.from_agent ? row.from_agent : '主会话用户';
      return message(row.message_id, row.from_agent, senderName, row.content, row.message_created,
        `${DELIVERY_MARKER} ${row.message_id} seq ${row.delivery_seq}]]`);
    });
    for (const id of inboxIds) {
      const row = this.store.getInbox(id);
      if (!row || row.recipient !== agent.id || row.cluster_id !== agent.cluster_id || row.subject === 'message') continue;
      // Runtime-derived facts name the system; they do not impersonate a role.
      const payload = jsonRecordOf(row.payload) ?? {};
      messages.push(message(row.id, null, '系统', { ...payload, category: notificationCategory(row.subject),
        subject: NOTIFICATION_LABELS[row.subject] ?? row.subject }, row.created, '', row.subject));
    }
    return messages;
  }

  // ------------------------------------------------- commands / handlers

  #applyCommand(cluster: ClusterRecord, actor: FlowActor, action: string, params: Record<string, unknown>): CommandApplyResult {
    const id = cluster.id;
    if (!isActionName(action)) fail(`Unknown action: ${action}`, 400);
    const handler = this.#handlers[action];
    if (!roleAllows(actor.role ?? 'user', action) && actor.role !== 'user') fail(`Role ${actor.role} may not perform ${action}`, 403);
    const result = jsonRecordOf(handler(this, cluster, actor, params)) ?? {};
    const actorAgentId = actor.role === 'user' ? null : actor.agent_id;
    // A refusal the current turn took up is acknowledged *here*: the command that
    // commits the correction or the escalation is the one that handled it. A turn that
    // failed or did nothing never reaches this point, so the work stays pending.
    const pendingRefusals = actorAgentId === null ? null : this.#pendingRefusals.get(actorAgentId) ?? null;
    if (actorAgentId !== null && pendingRefusals?.length && result.deduped !== true) {
      // A corrective action for the *same* target closes a refusal: the action the
      // pending set advertises can change with the transaction's state (a branch that
      // fails between the turn and the command moves from `request_replan` to
      // `escalate`), so the test is the target and the kind of act, never the exact
      // name — while an unrelated approval is not a correction at all.
      const corrective = new Set(['request_replan', 'revise-plan', 'escalate']);
      const matches = pendingRefusals.filter(entry => {
        if (!corrective.has(action)) return false;
        // Match either the transaction carried by a replan or the node carried
        // by an escalation; node-level actions need no transaction identifier.
        const targetsTransaction = Boolean(entry.transaction_id)
          && (entry.transaction_id === result.transaction_id || entry.transaction_id === params.transaction_id);
        const targetsNode = Boolean(entry.node_id)
          && (entry.node_id === result.node_id || entry.node_id === params.node_id);
        return targetsTransaction || targetsNode;
      });
      if (matches.length) {
        const rest = pendingRefusals.filter(entry => !matches.includes(entry));
        if (rest.length) this.#pendingRefusals.set(actorAgentId, rest);
        else this.#pendingRefusals.delete(actorAgentId);
        this.store.tx(() => {
          const issueId = typeof result.issue_id === 'string' ? result.issue_id : null;
          const issue = issueId === null ? null : this.store.getIssue(issueId);
          if (issue?.transaction_id) {
            const refusalSeqs = matches.filter(entry => entry.transaction_id === issue.transaction_id)
              .map(entry => entry.seq).sort((a, b) => a - b);
            if (refusalSeqs.length) this.store.updateIssue(issue.id, {
              evidence: { ...(jsonRecordOf(issue.evidence) ?? {}), refusal_seqs: refusalSeqs },
            });
          }
          for (const entry of matches) {
            this.store.appendEvent(id, 'refusal-handled', {
              agent_id: actorAgentId, role: actor.role ?? null, seq: entry.seq, action,
              issue_id: issueId,
              transaction_id: entry.transaction_id, node_id: entry.node_id,
            });
          }
        });
      }
    }
    return { revision: this.store.getCluster(id)?.revision ?? cluster.revision, ...result };
  }

  get #handlers() {
    return HANDLERS;
  }

  // helpers used by handlers
  /** Current wall clock, injectable for deterministic tests. */
  timestamp(): number {
    return this.store.now();
  }

  progressSeq(clusterId: string): number {
    // One indexed MAX over the whole event table: a bounded page would stop
    // observing progress once a cluster passes the page size.
    return this.store.latestProgressSeq(clusterId, [...CLUSTER_EVENTS_SKIP_PROGRESS]);
  }

  createTransactionInternal(clusterId: string, node: NodeRecord, entry: TransactionSeedInput, { parent = null, local = false }: { parent?: string | null; local?: boolean } = {}): TransactionRecord {
    const objective = validateText(entry.objective, 'transaction.objective', 16384);
    for (const key of ['needs', 'constraints', 'acceptance_criteria']) {
      if (entry[key] !== undefined && !Array.isArray(entry[key])) fail(`Invalid transaction.${key}`);
    }
    const tx = this.store.insertTransaction({
      id: typeof entry.id === 'string' ? entry.id : randomUUID(),
      cluster_id: clusterId, node_id: node.id, owner_management_id: node.id,
      parent_transaction_id: stringColumnOrNull(entry.parent_transaction_id, 'transaction.parent_transaction_id') ?? parent,
      objective,
      inputs: jsonColumn(entry.inputs, 'transaction.inputs') ?? {},
      constraints: jsonColumn(entry.constraints, 'transaction.constraints') ?? [],
      expected_output: stringColumn(entry.expected_output, 'transaction.expected_output'),
      acceptance_criteria: jsonColumn(entry.acceptance_criteria, 'transaction.acceptance_criteria') ?? [],
      needs: jsonColumn(entry.needs, 'transaction.needs') ?? {},
      priority: typeof entry.priority === 'number' && Number.isInteger(entry.priority) ? entry.priority : 0,
      // A transaction inherits its management node's capability set unless it
      // restricts it explicitly.
      capabilities: validateCapabilities(entry.capabilities ?? node.capabilities ?? [], 'transaction.capabilities'),
      status: entry.status === undefined ? 'DRAFT' : literalOf(entry.status, TRANSACTION_STATUSES, 'transaction.status'),
    }) ?? fail('Transaction could not be created', 500);
    const nodeBudget = this.store.budgetForScope(clusterId, 'node', node.id);
    if (nodeBudget) {
      createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'transaction', scope_id: tx.id, node_id: node.id,
        parent_budget_id: nodeBudget.id, limit: {},
      });
    }
    if (local) this.store.appendEvent(clusterId, 'transaction-created', { transaction_id: tx.id, node_id: node.id, parent });
    return tx;
  }

  settledDependencies(tx: TransactionRecord): boolean {
    const deps = this.store.dependenciesOf(tx.id);
    if (!deps.length) return true;
    return deps.every(dep => {
      const other = this.store.getTransaction(dep);
      return other && other.status === 'ACCEPTED';
    });
  }

  notifyInternal(clusterId: string, recipient: string | null | undefined, { subject, payload, dedupeKey = null }: { subject: string; payload: JsonValue; dedupeKey?: string | null }): InboxRecord | null {
    if (!recipient) return null;
    const fields = jsonRecordOf(payload);
    return this.store.insertInbox({
      id: randomUUID(), cluster_id: clusterId, recipient, subject, payload,
      // Coalescing keeps one live row per subject+subject-entity; the dedupe key
      // makes a repeated notification of the *same fact* (one revision's
      // staleness, one half-minute of saturation) a single row. It is scoped to
      // the recipient: one fact told to two roles is two notifications.
      coalesce_key: `${subject}:${fields?.transaction_id ?? fields?.issue_id ?? ''}`,
      dedupe_key: dedupeKey ? `${dedupeKey}:${recipient}` : null,
    });
  }

  /**
   * A context refusal that stopped a turn, from either shape the host can
   * produce: an exception out of the turn, or a turn that ended with the
   * refusal as its failure reason. Returns the message, or null.
   */
  contextRefusal(outcome: TurnOutcome | null, error: unknown, agent: AgentRecord | null = null): { readonly code: string; readonly message: string } | null {
    // The shape is the point: the *code* travels with the message, so the
    // durable event carries a machine-readable reason and a reader is never
    // asked to parse a sentence to find out whether a stop was a budget stop.
    // A refusal the *pre-dispatch ceiling* raises after it could not fund the
    // compaction carries `BUDGET_EXHAUSTED`, and it is recognised here too: the
    // producer's code decides the class, not the gate that noticed.
    if (errorCode(error) === 'BUDGET_EXHAUSTED') return { message: messageOf(error), code: 'BUDGET_EXHAUSTED' };
    if (errorCode(error) === 'CONTEXT_PRESSURE') return { message: messageOf(error), code: 'CONTEXT_PRESSURE' };
    const detail = outcome?.stopDetail ?? null;
    if (detail?.code === 'BUDGET_EXHAUSTED') return { message: String(detail.message ?? 'budget exhausted'), code: 'BUDGET_EXHAUSTED' };
    if (detail?.code === 'CONTEXT_PRESSURE') return { message: String(detail.message ?? 'context ceiling'), code: 'CONTEXT_PRESSURE' };
    if (typeof detail?.message === 'string' && detail.message.startsWith('BUDGET: ')) {
      return { message: detail.message, code: 'BUDGET_EXHAUSTED' };
    }
    if (typeof detail?.message === 'string' && detail.message.includes('CONTEXT_PRESSURE')) {
      return { message: detail.message, code: 'CONTEXT_PRESSURE' };
    }
    // The scoped pre-step listener rejects requests that remain over either
    // the identity budget or the provider input ceiling after compaction. The
    // rejection carries its measurements and identifies the exceeded ceiling.
    if (outcome?.stopReason === 'blocked') {
      const rejection = jsonRecordOf(outcome.stopDetail?.info?.rejection);
      if (rejection?.compaction_unfunded) {
        // The session could not be shrunk because the budget could not pay for
        // the summary: the stop is a budget stop, and it is reported as one.
        return { message: `BUDGET: the session could not be compacted — ${JSON.stringify(rejection)}`, code: 'BUDGET_EXHAUSTED' };
      }
      // A session above either sending limit whose cluster budget is spent
      // cannot fund further compaction; report the budget stop rather than
      // attributing it to a provider or context malfunction.
      const rollup = agent?.cluster_id ? rollupBudgets(this.store, agent.cluster_id) : null;
      const tokensLeft = rollup ? rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent : null;
      if (rollup && rollup.tokens.limit > 0 && tokensLeft !== null && tokensLeft <= 0 && rejection) {
        return {
          message: `BUDGET: the session could not be compacted because the cluster budget is exhausted — ${JSON.stringify(rejection)}`,
          code: 'BUDGET_EXHAUSTED',
        };
      }
      return {
        message: rejection
          ? `the step could not be sent inside its ${rejection.exceeded === 'identity' ? 'identity budget' : 'provider ceiling'}: ${JSON.stringify(rejection)}`
          : 'the step could not be sent inside its identity budget or provider ceiling, and compaction did not reduce it',
        code: 'CONTEXT_PRESSURE',
      };
    }
    return null;
  }

  #hasActiveDelegatedWork(nodes: readonly NodeRecord[], rootId: string): boolean {
    return nodes.some(node => node.id !== rootId && node.status === 'ACTIVE'
      && (node.kind === 'worker' || (node.kind === 'management' && node.delegated_transaction_id)));
  }

  blockNodeInternal(clusterId: string, nodeId: string | null, reason: string, code: string | null = null, facts: Record<string, JsonValue> | null = null): void {
    if (!nodeId) return;
    this.store.tx(() => {
      const node = this.store.getNode(nodeId);
      if (!node || node.status === 'BLOCKED') return;
      this.store.updateNode(nodeId, { status: 'BLOCKED' });
      // The identity whose request failed is part of the record: a node stops
      // *for* something specific, and only its own record can say what the repair
      // would have to make affordable again. A refusal is not scoped to the node —
      // it names the agent, or the compaction pool.
      this.store.appendEvent(clusterId, 'node-blocked', {
        node_id: nodeId, reason, code, agent_id: facts?.agent_id ?? null,
        dimension: facts?.dimension ?? null, requested: facts?.requested ?? null,
        // The envelope a resume would have to make affordable, in every dimension
        // the request needed.
        envelope: facts?.envelope ?? null,
      });
      if (!node.parent_id) {
        // The root cannot run its own role, but a delegated child with a live
        // grant may still finish and return capacity. Do not stop the cluster
        // before that independent work has a chance to resolve the shortfall.
        if (code !== 'BUDGET_EXHAUSTED'
          || !this.#hasActiveDelegatedWork(this.store.nodesInSubtree(clusterId, nodeId), nodeId)) {
          this.blockClusterInternal(clusterId, reason, code, { node_id: nodeId });
        }
      } else {
        this.notifyInternal(clusterId, this.roleAgentOf(clusterId, node.parent_id, 'orchestrator')?.id,
          { subject: 'child-blocked', payload: { node_id: nodeId, reason, code } });
      }
    });
  }

  /**
   * Stop the whole cluster with a *coded* reason: the code is what lets a
   * reader (and the acceptance ledger) classify the stop without parsing the
   * sentence that explains it.
   */
  blockClusterInternal(clusterId: string, reason: string, code: string | null = null, facts: Record<string, JsonValue> | null = null): void {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(cluster.status)) return;
    this.store.updateCluster(clusterId, { status: 'BLOCKED' });
    // The node whose stop became the cluster's stop: reopening must be about *that*
    // reason, not about capacity appearing anywhere.
    this.store.appendEvent(clusterId, 'cluster-blocked', { reason, code, node_id: facts?.node_id ?? null });
  }

  evaluateCompletion(clusterId: string): void {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster || !['RUNNING', 'BLOCKED'].includes(cluster.status)) return;
    // A management node is done when its whole subtree has accepted. Its
    // closing sequence is the design's three finishing acts, in order: the
    // Orchestrator's aggregation, the Allocator's capacity return, and the
    // Auditor's final health evaluation. Only then is the node COMPLETED.
    for (const node of this.store.nodesInSubtree(clusterId, null)) {
      if (node.kind !== 'management' || node.status === 'COMPLETED' || node.status === 'CANCELLED') continue;
      const counts = Object.fromEntries(this.store.countTransactionsInSubtree(clusterId, node.id).map(row => [row.status, Number(row.c)]));
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (total === 0 || (counts.ACCEPTED ?? 0) !== total) continue;
      this.#completeManagementNode(cluster, node, total);
    }
    // Exhaustive predicates: a page of ten roots must never complete a cluster
    // that has an eleventh still running.
    const root = this.store.listNodes(clusterId, { parent_id: null })[0];
    const total = this.store.countTransactions(clusterId, { parent_transaction_id: null });
    if (total === 0) return;
    const accepted = this.store.countTransactions(clusterId, { parent_transaction_id: null, status: ['ACCEPTED'] });
    if (accepted === total) {
      // Finalization waits for management turns to finish and book their own
      // closing actions. The next scheduling pass retries.
      if (root?.status !== 'COMPLETED') return;
      if (this.#activeTurns.size > 0 && this.#activeTurnsForCluster(clusterId)) return;
      this.store.tx(() => {
        this.store.updateCluster(clusterId, { status: 'COMPLETED' });
        this.store.appendEvent(clusterId, 'cluster-completed', { transactions: total });
      });
      return;
    }
    const settled = this.store.countTransactions(clusterId, {
      parent_transaction_id: null, status: ['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED'],
    });
    if (settled === total) {
      // A root transaction blocked by the same refusal that stopped its node
      // cannot be accepted by finishing other descendants. Preserve the
      // producer's code instead of replacing it with an uncoded aggregate stop.
      const root = this.store.listNodes(clusterId, { parent_id: null })[0];
      const cause = root?.status === 'BLOCKED' && this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        clusterId, root.id,
      );
      const detail = cause ? JSON.parse(textField(cause.data, 'event.data', 1 << 20)) : null;
      this.blockClusterInternal(clusterId, detail?.reason ?? 'root transactions did not all reach ACCEPTED',
        detail?.code ?? null, detail && root ? { node_id: root.id } : null);
    }
  }

  /** Whether any live turn belongs to this cluster. */
  #activeTurnsForCluster(clusterId: string): boolean {
    for (const agentId of this.#activeTurns.keys()) {
      const agent = this.store.getAgent(agentId);
      if (agent?.cluster_id === clusterId) return true;
    }
    return false;
  }

  /**
   * Compute the finished-turn count from the stored count and supplied sequence.
   * A positive turnSeq advances to their maximum; otherwise increment once.
   */
  #bookTurn(agent: AgentRecord, turnSeq: number | null, fallback: number): number {
    const current = this.store.getAgent(agent.id);
    if (!current) return fallback;
    const booked = Number(current.turns ?? 0);
    if (typeof turnSeq === 'number' && Number.isInteger(turnSeq) && turnSeq > 0) return Math.max(booked, turnSeq);
    return booked + 1;
  }

  /** A closeout counts only when this node's own Auditor scored all eight metrics after its request. */
  #finalHealthDecision(clusterId: string, nodeId: string, auditorId: string | null): string | null {
    if (!auditorId) return null;
    const marker = this.store.get('SELECT rowid FROM health WHERE id=? AND cluster_id=?',
      `${clusterId}:${nodeId}:final`, clusterId);
    if (!marker) return null;
    const scored = this.store.get(
      `SELECT h.* FROM health h WHERE h.cluster_id=? AND h.node_id=?
         AND h.evaluation_window='subtree-close' AND h.decided=1 AND h.decided_by=? AND h.rowid>?
         ORDER BY h.rowid DESC LIMIT 1`,
      clusterId, nodeId, auditorId, marker.rowid);
    const scores = jsonRecordOf(scored ? decodeJson(scored.scores) : null);
    return scores && HEALTH_METRICS.every(metric => typeof scores[metric] === 'number' && Number.isFinite(scores[metric]))
      ? textField(scored?.id, 'health.id', 128) : null;
  }

  #completeManagementNode(cluster: ClusterRecord, node: NodeRecord, total: number): void {
    if (!node.parent_id && !this.store.get(
      "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
      cluster.id, node.id,
    )) return;
    if (node.delegated_transaction_id) {
      const delegated = this.store.getTransaction(node.delegated_transaction_id);
      // A delegated assignment that is not accepted yet means the parent still
      // owes a report: finishing the node now would hide unfinished work.
      if (delegated && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED'].includes(delegated.status)) return;
    }
    // Wait for the node's roles to finish their closing actions: capacity
    // return, health evaluation and result aggregation. The next scheduling
    // pass retries; #abortHungTurns still bounds stalled turns.
    const managementRoles: readonly FlowAgentRole[] = ['orchestrator', 'allocator', 'auditor'];
    const liveRoles = managementRoles
      .map(role => this.roleAgentOf(cluster.id, node.id, role))
      .filter(roleAgent => roleAgent && this.#activeTurns.has(roleAgent.id));
    if (liveRoles.length) return;
    const healthId = `${cluster.id}:${node.id}:final`;
    if (!this.store.get('SELECT id FROM health WHERE id=?', healthId)) {
      // The summary is durable before the request. Leave the Auditor's grant
      // and its parent node pool intact until the real final judgement settles.
      this.store.tx(() => {
        const summary = writeNodeSummary(this, cluster, node.id);
        this.store.insertHealth({
          id: healthId, cluster_id: cluster.id, node_id: node.id,
          evaluation_window: 'subtree-close', signals: asJsonValue(this.healthSignals(cluster.id)),
          scores: {}, weights: {}, decided: false, decided_by: null,
        });
        this.store.appendEvent(cluster.id, 'management-closeout-requested', {
          node_id: node.id, health_id: healthId, summary_id: summary?.id ?? null,
        });
      });
      return;
    }
    const auditor = this.roleAgentOf(cluster.id, node.id, 'auditor');
    const scored = this.#finalHealthDecision(cluster.id, node.id, auditor?.id ?? null);
    if (!scored) return;
    this.store.tx(() => {
      // Only after the Auditor's turn ends can the Allocator refund its idle
      // grant. Returning it on the request pass would make scoring impossible.
      const budget = this.store.budgetForScope(cluster.id, 'node', node.id);
      if (budget) this.reclaimAllIdleGrants(cluster.id, budget.id);
      const remaining = budget ? this.store.getBudget(budget.id) : null;
      const returned: Record<string, number> = {};
      if (remaining?.parent_budget_id) {
        for (const key of ['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents']) {
          const amount = dimensionAvailable(remaining, key);
          if (amount > 0) returned[key] = amount;
        }
        if (Object.keys(returned).length) {
          transferBudget(this.store, remaining.id, remaining.parent_budget_id, returned);
        }
      }
      for (const allocation of this.store.allocationsInSubtree(cluster.id, node.id, { status: 'ACTIVE' })) {
        this.store.updateAllocation(allocation.id, { status: 'RELEASED' });
        const identity = this.store.getAgent(allocation.agent_id);
        if (identity) this.store.recordTeamEnd(identity, 'COMPLETED');
        this.store.updateAgent(allocation.agent_id, { status: 'TERMINATED' });
      }
      const summary = this.store.latestSummary(cluster.id, { node_id: node.id });
      for (const role of managementRoles) {
        const roleAgent = this.roleAgentOf(cluster.id, node.id, role);
        if (!roleAgent) continue;
        // Live role turns have settled before closeout reaches this point.
        // Preserve their completed outcome and prevent further admission.
        this.store.recordTeamEnd(roleAgent, 'COMPLETED');
        this.store.updateAgent(roleAgent.id, { status: 'TERMINATED' });
      }
      this.store.updateNode(node.id, { status: 'COMPLETED' });
      this.store.appendEvent(cluster.id, 'management-node-completed', {
        node_id: node.id, transactions: total, returned_budget: returned,
        health_id: scored, summary_id: summary?.id ?? null,
      });
    });
  }

  cancelSubtree(clusterId: string, nodeId: string | null, at: number): void {
    const nodes = nodeId ? this.store.nodesInSubtree(clusterId, nodeId) : this.store.nodesInSubtree(clusterId, null);
    const nodeIds = new Set(nodes.filter(Boolean).map(node => node.id));
    for (const tx of this.store.transactionsInSubtree(clusterId, nodeId)) {
      if (!nodeIds.has(tx.node_id)) continue;
      if (TRANSACTION_TERMINAL.has(tx.status)) continue;
      this.store.updateTransaction(tx.id, { status: 'CANCELLED' });
    }
    for (const allocation of this.store.allocationsInSubtree(clusterId, nodeId, { status: 'ACTIVE' })) {
      if (!nodeIds.has(allocation.node_id)) continue;
      this.store.updateAllocation(allocation.id, { status: 'RELEASED' });
      const identity = this.store.getAgent(allocation.agent_id);
      if (identity) this.store.recordTeamEnd(identity, 'CANCELLED');
      this.store.updateAgent(allocation.agent_id, { status: 'TERMINATED' });
    }
    for (const agent of this.store.agentsInSubtree(clusterId, nodeId)) {
      if (!nodeIds.has(agent.node_id)) continue;
      // Allocation release above may already have marked a Worker terminal.
      // Its native turn must still be aborted before skipping persisted state.
      const turn = this.#activeTurns.get(agent.id);
      if (turn) turn.ac.abort(new Error('subtree cancelled'));
      if (AGENT_TERMINAL.has(agent.status)) continue;
      this.store.recordTeamEnd(agent, 'CANCELLED');
      this.store.updateAgent(agent.id, { status: 'TERMINATED' });
    }
    for (const id of nodeIds) this.store.updateNode(id, { status: 'CANCELLED' });
    this.store.appendEvent(clusterId, 'subtree-cancelled', { nodes: [...nodeIds], at });
  }

  countsOf(clusterId: string): FlowCounts {
    const statusCounts = Object.fromEntries(
      this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]),
    );
    const total = Object.values(statusCounts).reduce((sumTotal, count) => sumTotal + count, 0);
    const agentsByRole = this.store.countAgentsByRole(clusterId);
    return {
      nodes: this.store.countNodes(clusterId),
      agents: agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
      agents_live: agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.live), 0),
      active_turns: [...this.#activeTurns.values()].filter(entry => entry.cluster_id === clusterId).length,
      transactions: total,
      ready: statusCounts.READY ?? 0,
      running: (statusCounts.DISPATCHED ?? 0) + (statusCounts.RUNNING ?? 0),
      accepted: statusCounts.ACCEPTED ?? 0,
      blocked: statusCounts.BLOCKED ?? 0,
      open_issues: this.store.openIssues(clusterId, {}).length,
    };
  }

  latestSummaryOf(clusterId: string, params: FlowQueryParams = {}): FlowSummary {
    const row = params.node_id
      ? this.store.latestSummary(clusterId, { node_id: params.node_id })
      : this.store.latestSummary(clusterId, { transaction_id: params.transaction_id });
    if (row) return summaryOfData(clusterId, row.as_of_seq, row.data);
    return this.buildSummary(clusterId);
  }

  /** Root summary: business conclusions from accepted transactions, resources from the ledger. */
  buildSummary(clusterId: string): FlowSummary {
    // Counts come from SQL, never from the rows a page happened to hold: the
    // root summary is what a reader uses to decide whether the work is done.
    const counts = Object.fromEntries(
      this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]),
    );
    const total = Object.values(counts).reduce((sumTotal, count) => sumTotal + count, 0);
    const acceptedCount = counts.ACCEPTED ?? 0;
    const accepted = this.store.transactionsInSubtree(clusterId, null, { status: 'ACCEPTED' });
    const issues = this.store.openIssues(clusterId, {});
    return {
      cluster_id: clusterId,
      node_id: null,
      transaction_id: null,
      transactions: {
        total,
        progress: total - acceptedCount - (counts.CANCELLED ?? 0) - (counts.SUPERSEDED ?? 0),
        completed: acceptedCount,
        failed: (counts.FAILED ?? 0) + (counts.BLOCKED ?? 0),
      },
      conclusions: accepted.filter(tx => !tx.parent_transaction_id).map(tx => ({ transaction_id: tx.id, result: truncate(JSON.stringify(tx.result ?? null), 2000) })),
      evidence: accepted.flatMap(tx => (tx.validation?.checks ?? []).map(check => ({ transaction_id: tx.id, criterion: check.criterion, evidence: truncate(String(check.evidence ?? ''), 400) }))).slice(0, 50),
      unresolved_questions: issues.filter(issue => issue.status === 'OPEN').map(issue => ({ issue_id: issue.id, transaction_id: issue.transaction_id, required_change: truncate(issue.required_change, 300) })),
      resource_state: this.store.usageSummary(clusterId),
      management_health: {
        open_issues: issues.filter(issue => issue.status === 'OPEN').length,
        corrections: issues.reduce((totalCorrections, issue) => totalCorrections + issue.corrections, 0),
        blocked_nodes: this.store.all("SELECT id FROM nodes WHERE cluster_id=? AND status='BLOCKED'", clusterId)
          .map(row => textField(row.id, 'node.id', 128)),
      },
      // `confidence` is a statement about coverage, so it is derived from
      // exhaustive counts — not from the page a caller happened to read.
      confidence: total > 0 && acceptedCount === total ? 'high' : 'partial',
      as_of_seq: this.store.latestEventSeq(clusterId),
    };
  }
}

// ------------------------------------------------------------------ helpers


/** Reserve space for a waiting Worker while management turns supervise the run. */
/**
 * Share one scheduling window between management and Worker turns.
 * Management uses a class ceiling. Workers reserve a slot only when a
 * management turn is owed and none is running, avoiding an unused reservation
 * for a class already making progress or with no pending work.
 */
export function scheduleAdmission({
  window, active = 0, workerWaiting = false,
  managementActive = 0, managementPending = false,
}: {
  window: number;
  active?: number;
  workerWaiting?: boolean;
  managementActive?: number;
  managementPending?: boolean;
}) {
  const total = Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
  const live = Math.max(0, Math.min(active, total));
  // A single slot serializes the classes. Reserve capacity for another
  // class only when the window has more than one slot to share.
  const managementCeiling = total <= 1 ? total : Math.max(0, total - (workerWaiting ? 1 : 0));
  const reserveForManagement = Boolean(managementPending) && managementActive === 0 && total > 1;
  const workerSlots = Math.max(0, total - live - (reserveForManagement ? 1 : 0));
  return { managementCeiling, workerSlots, reserveForManagement };
}

function rotate<T>(items: readonly T[], offset: number): readonly T[] {
  if (!items.length) return items;
  const index = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(index), ...items.slice(0, index)];
}


function scopeNodes(store: ClusterStore, actor: FlowActor, clusterId: string): NodeRecord[] {
  if (actor.role === 'user' || !actor.node_id) return store.nodesInSubtree(clusterId, null);
  return store.nodesInSubtree(clusterId, actor.node_id);
}

// List queries carry bounded references, not every saved result, session or
// node objective. Full transaction evidence is available via the per-id
// detail query; inlining six full rows already overflowed a role's 8192 tokens.
function nodeReference(node: NodeRecord): FlowNodeReference {
  return {
    id: node.id, parent_id: node.parent_id, path: node.path, depth: node.depth,
    kind: node.kind, status: node.status, owner_management_id: node.owner_management_id,
    max_children: node.max_children, delegated_transaction_id: node.delegated_transaction_id,
    scope: { objective: String(node.scope?.objective ?? '').slice(0, 160) },
  };
}

function agentReference(agent: AgentRecord): FlowAgentReference {
  return {
    id: agent.id, node_id: agent.node_id, role: agent.role, status: agent.status,
    capabilities: agent.capabilities, turns: agent.turns,
  };
}

function transactionReference(tx: TransactionRecord): FlowTransactionReference {
  return {
    id: tx.id, node_id: tx.node_id, owner_management_id: tx.owner_management_id,
    status: tx.status, revision: tx.revision, result_revision: tx.result_revision,
    priority: tx.priority, parent_transaction_id: tx.parent_transaction_id,
    objective: tx.objective.slice(0, 160),
  };
}


/**
 * Capture a real web_fetch receipt: the runtime, not the model, records what
 * was actually fetched, when, its hash and the returned text.
 */
function captureSource(agent: AgentRecord, exec: ToolDispatchExecution, result: ToolExecutionResult) {
  if (exec.name !== 'web_fetch') return null;
  const value = jsonRecordOf(result.value);
  if (!value) return null;
  const url = value.url;
  if (typeof url !== 'string') return null;
  const body = jsonRecordOf(value.body);
  const text = typeof body?.content === 'string' ? body.content : '';
  const argumentsFields = jsonRecordOf(exec.arguments);
  const requestUrl = typeof argumentsFields?.url === 'string' ? argumentsFields.url : url;
  return {
    id: randomUUID(), cluster_id: agent.cluster_id, agent_id: agent.id, node_id: agent.node_id,
    transaction_id: agent.meta?.transaction_id ?? null,
    request_url: requestUrl, final_url: url,
    status_code: typeof value.statusCode === 'number' ? value.statusCode : null,
    fetched_at: Date.now(), hash: sha1(text), bytes: Buffer.byteLength(text), text: text.slice(0, 512 * 1024),
  };
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Background jobs a tool started are owned by this cluster; record the id. */
function jobIdOf(result: ToolExecutionResult | null): string | null {
  const value = result?.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const job = jsonRecordOf(value.job);
  const candidates: unknown[] = [job?.id, value.job_id, value.id, value.jobId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Join a persistence operation only while this instance is live. Backends may
 * ignore cancellation, so still observe their late failure and release any
 * late resource without handing the result back to recovery.
 */
function waitForProof<T>(pending: Promise<T>, signal: AbortSignal, discard?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        if (discard) void Promise.resolve().then(() => discard(value)).catch(() => {});
      } else {
        resolve(value);
      }
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/**
 * Whether a durable Session already contains one message id. The injected
 * prompt names every message id, so the Session itself is the proof of
 * admission; a session that cannot be read is not proof.
 */
async function sessionCarries(persistence: FlowPersistenceSeam, sessionId: string, messageId: string, signal: AbortSignal): Promise<DeliveryProof> {
  const marker = `${DELIVERY_MARKER} ${messageId} seq `;
  let handle: SessionHandle | undefined;
  try {
    signal.throwIfAborted();
    handle = await waitForProof(persistence.open(SessionId(sessionId), 'read', { signal }), signal, late => late.close());
  } catch (error) {
    // "I could not look" is not "it is not there": an unreadable session leaves
    // the delivery PENDING rather than injecting a second copy.
    return { state: 'UNKNOWN', found: false, reason: `open failed: ${messageOf(error)}` };
  }
  try {
    // Paginate: a bound that stops at the first page would report "absent" for
    // a long session and re-inject a message that was already delivered.
    const pageSize = 5_000;
    let scanned = 0;
    for (let offset = 0; offset < 500_000; offset += pageSize) {
      signal.throwIfAborted();
      const page = await waitForProof(handle.read(offset, pageSize, { signal }), signal);
      const events = page?.events ?? [];
      scanned += events.length;
      for (const event of events) {
        // Only an *incoming* user message that carries this delivery's own
        // marker proves receipt. Matching any event's text would accept the
        // sender's tool result for the message it just sent.
        const type = String(event?.type ?? '');
        if (messageId.startsWith('human:')) {
          const data=jsonRecordOf(event.data);
          const sources=/user\/message|user_message/i.test(type)?[data?.source]
            :type==='agent/inbox/spliced'&&Array.isArray(data?.inserted)?data.inserted.map(message=>jsonRecordOf(message)?.source):[];
          if(sources.some(value=>{const source=jsonRecordOf(value);return source?.kind==='user'&&source.rpcId===messageId.slice('human:'.length);})) return {state:'FOUND',found:true,scanned};
        }
        if (!/user\/message|user_message/i.test(type)) continue;
        if (JSON.stringify(event?.data ?? event).includes(marker)) return { state: 'FOUND', found: true, scanned };
      }
      if (events.length < pageSize) break;
    }
    return { state: 'ABSENT', found: false, scanned };
  } catch (error) {
    return { state: 'UNKNOWN', found: false, reason: `read failed: ${messageOf(error)}` };
  } finally {
    try {
      await waitForProof(handle.close(), signal);
    } catch {
      /* a read handle that refuses to close is not a delivery failure */
    }
  }
}

/** Render the messages one agent received, with their stable ids. */
/**
 * The exact marker a delivery carries into the recipient's session. Proof of
 * receipt matches this, not a bare id: a sender's own tool result also contains
 * the message id it just sent, so an id-substring search would treat "I sent it"
 * as "I received it".
 */
export { DELIVERY_MARKER };
interface DeliveryPromptMessage {
  readonly message_id: string
  readonly delivery_seq: number | null
  readonly from_agent: string | null
  readonly content: unknown
  readonly message_created: number
}

function safeJson(value: unknown): FlowJsonValue {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
    if (!isFlowJsonValue(parsed)) throw new Error('arguments did not serialize to JSON');
    return parsed;
  } catch {
    return { note: 'arguments were not serialisable' };
  }
}

/** Truncate a string with an explicit marker: the reader can tell a cut from a short answer. */
function boundText(text: unknown, max = 8_000): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…[${value.length - max} chars omitted]` : value;
}

function textOfResult(result: ToolExecutionResult | null): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}
 
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export { truncate, rotate, scopeNodes };
