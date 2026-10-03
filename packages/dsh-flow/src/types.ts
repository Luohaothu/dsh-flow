/**
 * The plugin's wire vocabulary: everything that crosses a boundary — a model
 * tool parameter, a Remote argument, a panel form field, an IPC envelope — is
 * described here, and nothing in this module may reach for Node, the store or a
 * Host Context. The published `./types` subpath is exactly this file, so the
 * browser panel and the Host share one declaration of every shape.
 *
 * Two rules keep the generated Remote codec representable:
 *   1. every member is a concrete interface, a literal union, an array, or a
 *      concrete instantiation of {@link FlowPage};
 *   2. free-form JSON is {@link FlowJsonValue} rather than `unknown` or `any`,
 *      so a codec can be generated for it.
 * Type operators (mapped, indexed-access, conditional, `typeof` queries) are
 * deliberately absent from this module.
 */
// --------------------------------------------------------------- vocabulary

/**
 * One JSON value, as a free-form payload crossing the wire.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-util-values`: the
 * Typert generator reconstructs a recursive type inside the face that owns it,
 * so a borrowed recursive alias cannot be represented in a Remote codec. The
 * name and the shape are the same contract, so no conversion or deep copy is
 * involved anywhere — this is the same type, spelled in the face that must
 * encode it.
 */
export type FlowJsonValue =
  | null
  | boolean
  | number
  | string
  | FlowJsonValue[]
  | { [key: string]: FlowJsonValue };

/** Cluster lifecycle state. */
export type FlowClusterStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

/** Management-tree node lifecycle state. */
export type FlowNodeStatus =
  | 'ACTIVE' | 'DRAINING' | 'PAUSED' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RELEASED';

/** Cluster agent identity state. */
export type FlowAgentStatus =
  | 'CREATED' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'TERMINATED';

/** Transaction lifecycle state. */
export type FlowTransactionStatus =
  | 'DRAFT' | 'READY' | 'DISPATCHED' | 'RUNNING' | 'SUBMITTED' | 'VALIDATING' | 'ACCEPTED'
  | 'REJECTED' | 'BLOCKED' | 'PAUSED' | 'FAILED' | 'CANCELLED' | 'SUPERSEDED';

/** A node that owns management roles. */
export type FlowManagementRole = 'orchestrator' | 'allocator' | 'auditor';

/** A role a cluster agent can hold. */
export type FlowAgentRole = FlowManagementRole | 'worker';

/** A command actor: a cluster agent, or the host user operating the cluster. */
export type FlowActorRole = FlowAgentRole | 'user';

/** A worker capability the cluster can grant. */
export type FlowCapability = 'fs_read' | 'fs_write' | 'shell' | 'web_fetch' | 'browser';

/** Management-tree node kind. */
export type FlowNodeKind = 'management' | 'worker';

/** Audit-record lifecycle state. `DISMISSED` closes an issue found to be mistaken. */
export type FlowIssueStatus = 'OPEN' | 'VERIFYING' | 'CORRECTED' | 'ESCALATED' | 'DISMISSED';

/** Durable effect receipt state. `EFFECT_UNCERTAIN` marks an effect that may have run before a restart and needs a human decision. */
export type FlowEffectStatus = 'STARTED' | 'SETTLED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN' | 'EFFECT_UNCERTAIN';

/** Durable tool-call receipt state. */
export type FlowDispatchStatus = 'ADMITTED' | 'DISPATCHED' | 'SETTLED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

/** Model-request receipt state. */
export type FlowUsageStatus = 'RESERVED' | 'SETTLED' | 'NOT_SENT' | 'UNKNOWN';

/** Injected-message delivery state. */
export type FlowDeliveryStatus = 'PENDING' | 'DELIVERED' | 'ACKED';

/** Agent allocation state. */
export type FlowAllocationStatus = 'ACTIVE' | 'RELEASED';

/** Inbox row lifecycle state. */
export type FlowInboxStatus = 'PENDING' | 'CONSUMED';

/** Communication group lifecycle state. */
export type FlowGroupStatus = 'OPEN' | 'CLOSED';

/** Which gate an audit record belongs to. */
export type FlowAuditKind = 'plan' | 'validation';

/** An auditor's verdict on one plan or result revision. */
export type FlowAuditDecision =
  | 'PENDING' | 'APPROVED' | 'REJECTED' | 'OVERRIDDEN' | 'STALE'
  | 'CORRECTION_REQUESTED' | 'REPLAN_REQUESTED' | 'REVALIDATION_REQUESTED';

/** The kind of scope a budget row funds. */
export type FlowScopeKind = 'cluster' | 'root' | 'node' | 'transaction' | 'agent' | 'compaction';

/** The three operations a cluster may be told to perform on its own state. */
export type FlowControlAction = 'pause' | 'resume' | 'cancel';

/** Section 18's eight health dimensions, in the Auditor's vocabulary. */
export type FlowHealthMetric =
  | 'transaction_coverage' | 'decomposition_quality' | 'responsiveness' | 'planning_stability'
  | 'goal_alignment' | 'acceptance_quality' | 'result_integration' | 'escalation_quality';

/** The kind of payload a transaction's saved result holds. */
export type FlowResultKind = 'text' | 'structured' | 'aggregate' | 'submission';

/** Every query a caller may ask of one cluster. */
export type FlowQueryKind =
  | 'cluster' | 'nodes' | 'node' | 'transactions' | 'transaction' | 'audit' | 'agents' | 'allocations'
  | 'budgets' | 'issues' | 'issue' | 'audits' | 'effects' | 'effect' | 'usage' | 'deliveries'
  | 'context' | 'health' | 'summary' | 'blackboard';

// ------------------------------------------------------------------ budgets

/**
 * A complete root or scope budget: every dimension the ledger funds. `agents`
 * and `max_active_agents` are capacity, not consumable resources.
 */
export interface FlowBudget {
  readonly tokens: number
  readonly model_requests: number
  readonly tool_calls: number
  readonly wall_time_ms: number
  readonly agents: number
  readonly max_active_agents: number
}

/** A partial budget: only the dimensions a caller actually named. */
export interface FlowBudgetInput {
  readonly tokens?: number
  readonly model_requests?: number
  readonly tool_calls?: number
  readonly wall_time_ms?: number
  readonly agents?: number
  readonly max_active_agents?: number
}

/** One dimension of a budget row: what it may spend, has promised, and has used. */
export interface FlowBudgetDimensionView {
  readonly limit: number
  readonly reserved: number
  readonly spent: number
  readonly available: number
}

/** One budget row, projected for reading: the six dimensions plus wall time. */
export interface FlowBudgetView {
  readonly id: string
  readonly scope_kind: FlowScopeKind
  readonly scope_id: string
  readonly node_id: string | null
  readonly parent_budget_id: string | null
  readonly revision: number
  readonly tokens: FlowBudgetDimensionView
  readonly model_requests: FlowBudgetDimensionView
  readonly tool_calls: FlowBudgetDimensionView
  readonly agents: FlowBudgetDimensionView
  readonly max_active_agents: FlowBudgetDimensionView
  readonly wall_limit_ms: number
  readonly wall_deadline: number | null
}

// ------------------------------------------------------------------- limits

/** Every declared cluster limit. */
export interface FlowLimits {
  readonly max_children: number
  readonly max_depth: number
  readonly max_agents: number
  readonly max_active_agents: number
  readonly max_llm_concurrency: number
  readonly max_attempts: number
  readonly max_corrections: number
  readonly max_role_turns: number
  readonly worker_model_requests: number
  readonly worker_max_tokens: number
}

/** A partial limit patch: only the keys a caller overrode. */
export interface FlowLimitsInput {
  readonly max_children?: number
  readonly max_depth?: number
  readonly max_agents?: number
  readonly max_active_agents?: number
  readonly max_llm_concurrency?: number
  readonly max_attempts?: number
  readonly max_corrections?: number
  readonly max_role_turns?: number
  readonly max_tool_calls_per_turn?: number
  readonly max_scale_batch?: number
  readonly worker_model_requests?: number
  readonly worker_max_tokens?: number
}

/**
 * Per-role context pressure thresholds.
 *
 * `role`/`worker` are the compaction windows for a management identity and a
 * Worker; `model`/`server_input` are the served model's declared window and the
 * deployment's input cap, which are hard ceilings rather than compaction
 * triggers.
 */
export interface FlowContextLimits {
  readonly role: number
  readonly worker: number
  readonly model: number
  readonly compaction_threshold: number
  readonly server_input: number
}

// -------------------------------------------------------------- start input

/**
 * One cluster start request.
 *
 * Everything after `objective` is optional because the deployment configuration
 * supplies the rest: an omitted `workspace`, `capabilities`, `budget` or
 * `limits` is filled from the resolved configuration, while an explicitly empty
 * `capabilities` list stays empty. Free-form initial transactions travel
 * verbatim so a caller can pin a reproducible control-plane baseline.
 */
export interface FlowStartRequest {
  readonly objective: string
  readonly id?: string
  readonly workspace?: string
  readonly capabilities?: readonly FlowCapability[]
  readonly budget?: FlowBudgetInput
  readonly limits?: FlowLimitsInput
  readonly initial_transactions?: readonly FlowJsonValue[]
  readonly acceptance_criteria?: readonly string[]
}

// -------------------------------------------------------------- projections

/** A management-tree node as a list carries it: topology, not full scope. */
export interface FlowNodeReference {
  readonly id: string
  readonly parent_id: string | null
  readonly path: string
  readonly depth: number
  readonly kind: FlowNodeKind
  readonly status: FlowNodeStatus
  readonly owner_management_id: string | null
  readonly max_children: number | null
  readonly delegated_transaction_id: string | null
  readonly scope: FlowNodeScopeReference
}

/** The truncated scope a node reference carries. */
export interface FlowNodeScopeReference {
  readonly objective: string
}

/**
 * One management ancestor of a node.
 *
 * The lineage projection carries topology only: a nested delegation scope
 * repeats a long objective on every ancestor, and one real Auditor could not
 * fit its validation under its identity budget after fetching two such
 * details.
 */
export interface FlowNodeAncestor {
  readonly id: string
  readonly depth: number
  readonly path: string
  readonly kind: FlowNodeKind
}

/** A cluster agent as a list carries it. */
export interface FlowAgentReference {
  readonly id: string
  readonly node_id: string
  readonly role: FlowAgentRole
  readonly status: FlowAgentStatus
  readonly capabilities: readonly FlowCapability[]
  readonly model?: string
  readonly turns: number
}

/** A transaction as a list carries it: provenance, not evidence. */
export interface FlowTransactionReference {
  readonly id: string
  readonly node_id: string
  readonly owner_management_id: string
  readonly status: FlowTransactionStatus
  readonly revision: number
  readonly result_revision: number | null
  readonly priority: number
  readonly parent_transaction_id: string | null
  readonly objective: string
}

/**
 * One page of a list, always carrying whether it is the whole answer.
 *
 * `next_offset` is `null` exactly when this page ends the list, so a caller can
 * never mistake a first page for a complete domain.
 */
export interface FlowPage<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** Cluster-wide counts, computed from SQL aggregates rather than from a page. */
export interface FlowCounts {
  readonly nodes: number
  readonly agents: number
  readonly agents_live: number
  readonly active_turns: number
  readonly transactions: number
  readonly ready: number
  readonly running: number
  readonly accepted: number
  readonly blocked: number
  readonly open_issues: number
}

/** The cluster projection every read carries. */
export interface FlowClusterSummary {
  readonly id: string
  readonly status: FlowClusterStatus
  readonly objective: string
  readonly workspace: string
  readonly capabilities: readonly FlowCapability[]
  readonly limits: FlowLimits
  readonly budget: FlowBudgetInput
  readonly revision: number
  readonly created: number
  readonly updated: number
}

/** One row of the cluster list: the summary plus this cluster's counts. */
export interface FlowClusterListItem {
  readonly id: string
  readonly status: FlowClusterStatus
  readonly objective: string
  readonly workspace: string
  readonly revision: number
  readonly created: number
  readonly nodes: number
  readonly agents: number
  readonly agents_live: number
  readonly active_turns: number
  readonly transactions: number
  readonly ready: number
  readonly running: number
  readonly accepted: number
  readonly blocked: number
  readonly open_issues: number
}

/**
 * One durable event. `data` is the producer's own payload, so it is a JSON value
 * rather than a fixed shape; `seq` is the cluster's own event cursor.
 */
export interface FlowEventRecord {
  readonly seq: number
  readonly cluster_id: string
  readonly type: string
  readonly data: FlowJsonValue
  readonly at: number
}

/** One budget row of the evaluated management tree, with its scope path. */
export interface FlowBudgetEvaluation {
  readonly id: string
  readonly scope_kind: FlowScopeKind
  readonly scope_id: string
  readonly node_id: string | null
  readonly parent_budget_id: string | null
  readonly revision: number
  readonly tokens: FlowBudgetDimensionView
  readonly model_requests: FlowBudgetDimensionView
  readonly tool_calls: FlowBudgetDimensionView
  readonly agents: FlowBudgetDimensionView
  readonly max_active_agents: FlowBudgetDimensionView
  readonly wall_limit_ms: number
  readonly wall_deadline: number | null
  readonly effective_deadline: number | null
  readonly depth: number
}

/** One open issue, as a page carries it. */
export interface FlowIssueRecord {
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

/** One audit record, with its evidence decoded. */
export interface FlowAuditRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly auditor_agent_id: string | null
  readonly kind: FlowAuditKind
  readonly target_revision: number | null
  readonly decision: FlowAuditDecision
  readonly evidence: FlowJsonValue
  readonly created: number
  readonly decided: number | null
}

/** One durable effect receipt. */
export interface FlowEffectRecord {
  readonly call_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string | null
  readonly tool: string
  readonly status: FlowEffectStatus
  readonly error: string | null
  readonly created: number
  readonly settled: number | null
}

/** One agent allocation. */
export interface FlowAllocationRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly agent_id: string
  readonly transaction_id: string | null
  readonly capabilities: readonly FlowCapability[]
  readonly write_scope: readonly string[]
  readonly write_scope_canonical: readonly string[]
  readonly status: FlowAllocationStatus
  readonly created: number
  readonly updated: number
}

/** One model-request receipt. */
export interface FlowUsageReceipt {
  readonly request_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly role: FlowAgentRole
  readonly kind: string
  readonly provider: string | null
  readonly model: string | null
  readonly status: FlowUsageStatus
  readonly total_tokens: number | null
  readonly prompt_tokens: number | null
  readonly completion_tokens: number | null
  readonly created: number
  readonly settled: number | null
}

/** Aggregate model usage for one cluster or subtree. */
export interface FlowUsageSummary {
  readonly requests: number
  readonly total_tokens: number
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly cached_tokens: number
  readonly reasoning_tokens: number
  readonly unknown_requests: number
  readonly overshoot: number
  readonly api_cost: FlowUsageCost
}

/**
 * The cost line of a usage summary. This deployment is locally served, so there
 * is no price to multiply by: the field says so instead of inventing a number.
 */
export interface FlowUsageCost {
  readonly amount: number
  readonly currency: string
  readonly pricing: string
}

/** One injected-message delivery row. */
export interface FlowDeliveryRow {
  readonly message_id: string
  readonly recipient: string
  readonly delivery_seq: number | null
  readonly status: FlowDeliveryStatus
  readonly acked: number | null
  readonly kind: string
  readonly from_agent: string | null
  readonly from_node: string | null
  readonly recipient_node: string | null
}

/** One blackboard entry. */
export interface FlowBlackboardEntry {
  readonly key: string
  readonly value: FlowJsonValue
  readonly revision: number
  readonly updated_by: string | null
}

/**
 * One context step: the event's own `seq` plus the payload the runtime
 * appended for it.
 */
export interface FlowContextStep {
  readonly seq: number
  readonly agent_id: string
  readonly role: FlowAgentRole
  readonly turn_seq: number
  readonly step: number
  readonly native_seq: number | null
  readonly before: number | null
  readonly after: number
  readonly pending: number
  readonly threshold: number
  readonly context_limit: number
  readonly sending_ceiling: number
  readonly summary_seq: number | null
  readonly charged_scope: string | null
  readonly compacted_at: number | null
  readonly decision: string
}

/** The latest saved summary for a scope. */
export interface FlowSummary {
  readonly as_of_seq: number
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly objective?: string
  readonly transactions?: FlowSummaryProgress
  readonly conclusions?: readonly FlowSummaryConclusion[]
  readonly evidence?: readonly FlowSummaryEvidence[]
  readonly unresolved_questions?: readonly FlowSummaryQuestion[]
  readonly resource_state?: FlowUsageSummary
  readonly management_health?: FlowSummaryManagementHealth
  readonly confidence?: 'high' | 'partial'
  readonly note?: string
  readonly kind?: string
}

/** The progress block of a summary. */
export interface FlowSummaryProgress {
  readonly total: number
  readonly progress: number
  readonly completed: number
  readonly failed: number
}

/** One accepted conclusion of a summary. */
export interface FlowSummaryConclusion {
  readonly transaction_id: string
  readonly result: string
}

/** One piece of recorded evidence of a summary. */
export interface FlowSummaryEvidence {
  readonly transaction_id: string
  readonly criterion: string
  readonly evidence: string
}

/** One unresolved question of a summary. */
export interface FlowSummaryQuestion {
  readonly issue_id: string
  readonly transaction_id: string | null
  readonly required_change: string
}

/** The management-health block of a summary. */
export interface FlowSummaryManagementHealth {
  readonly open_issues: number
  readonly corrections: number
  readonly blocked_nodes: readonly string[]
}

/** Section 18's derived signals, as the ledger measures them. */
export interface FlowHealthSignals {
  readonly window_ms: number
  readonly transaction_coverage: number | null
  readonly decomposition_quality: FlowHealthDecomposition
  readonly responsiveness: FlowHealthResponsiveness
  readonly planning_stability: FlowHealthPlanningStability
  readonly goal_alignment: number | null
  readonly acceptance_quality: number | null
  readonly result_integration: number | null
  readonly escalation_quality: number | null
  readonly transactions_by_status: FlowTransactionStatusTally
}

/** Decomposition quality signals. */
export interface FlowHealthDecomposition {
  readonly ratio: number | null
  readonly decomposed: number
  readonly orphans: number
}

/** Responsiveness signals. */
export interface FlowHealthResponsiveness {
  readonly median_issue_age_ms: number | null
  readonly open_major_issues: number
  readonly stale_submitted: number
}

/** Planning stability signals. */
export interface FlowHealthPlanningStability {
  readonly revisions_per_transaction: number
  readonly rejection_cycles: number
}

/** One stored health evaluation, exactly as the `health` row holds it. */
export interface FlowHealthEvaluation {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly evaluation_window: string | null
  readonly scores: FlowJsonValue
  readonly signals: FlowJsonValue
  readonly weights: FlowJsonValue
  readonly decided: number
  readonly decided_by: string | null
  readonly created: number
}

/** The transaction-status tally the runtime builds from SQL counts. */
export interface FlowTransactionStatusTally {
  readonly DRAFT?: number
  readonly READY?: number
  readonly DISPATCHED?: number
  readonly RUNNING?: number
  readonly SUBMITTED?: number
  readonly VALIDATING?: number
  readonly ACCEPTED?: number
  readonly REJECTED?: number
  readonly BLOCKED?: number
  readonly PAUSED?: number
  readonly FAILED?: number
  readonly CANCELLED?: number
  readonly SUPERSEDED?: number
}

/** The role tally the runtime builds from SQL counts. */
export interface FlowRoleTally {
  readonly orchestrator?: number
  readonly allocator?: number
  readonly auditor?: number
  readonly worker?: number
}

/** The subtree-size map: one node id to the number of nodes below it. */
export interface FlowSubtreeSizeTally {
  readonly [node_id: string]: number
}

// ----------------------------------------------------------------- results

/** The complete snapshot one cluster read returns. */
export interface FlowSnapshot {
  readonly cluster: FlowClusterSummary
  readonly counts: FlowCounts
  readonly nodes: readonly FlowNodeRecord[]
  readonly agents: readonly FlowAgentRecord[]
  readonly transactions: readonly FlowTransactionRecord[]
  readonly allocations: readonly FlowAllocationRecord[]
  readonly budgets: readonly FlowBudgetEvaluation[]
  readonly issues: readonly FlowIssueRecord[]
  readonly usage: FlowUsageSummary
  readonly latest_seq: number
  readonly events?: readonly FlowEventRecord[]
  readonly summary?: FlowSummary
}

/** One management-tree node, complete. */
export interface FlowNodeRecord {
  readonly id: string
  readonly cluster_id: string
  readonly parent_id: string | null
  readonly kind: FlowNodeKind
  readonly depth: number
  readonly status: FlowNodeStatus
  readonly revision: number
  readonly scope: FlowJsonValue
  readonly capabilities: readonly FlowCapability[]
  readonly owner_management_id: string | null
  readonly delegated_transaction_id: string | null
  readonly max_children: number | null
  readonly path: string
  readonly created: number
  readonly updated: number
}

/** One cluster agent identity, complete. */
export interface FlowAgentRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly role: FlowAgentRole
  readonly session_id: string
  readonly status: FlowAgentStatus
  readonly epoch: number
  readonly turns: number
  readonly stagnation: number
  readonly capabilities: readonly FlowCapability[]
  readonly cwd: string | null
  readonly meta: FlowJsonValue
  readonly created: number
  readonly updated: number
}

/** One transaction, complete except for the fields the reader narrows. */
export interface FlowTransactionRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly owner_management_id: string
  readonly parent_transaction_id: string | null
  readonly objective: string
  readonly inputs: FlowJsonValue
  readonly constraints: FlowJsonValue
  readonly expected_output: string
  readonly acceptance_criteria: FlowJsonValue
  readonly needs: FlowJsonValue
  readonly priority: number
  readonly capabilities: readonly FlowCapability[]
  readonly status: FlowTransactionStatus
  readonly revision: number
  readonly attempts: number
  readonly result: FlowJsonValue
  readonly result_revision: number | null
  readonly validation: FlowJsonValue
  readonly plan_approved_revision: number | null
  readonly result_staged_epoch: number | null
  readonly result_staged_turn: number | null
  readonly result_staged_agent: string | null
  readonly pre_pause_status: FlowTransactionStatus | null
  readonly pre_pause_revision: number | null
  readonly created: number
  readonly updated: number
}

/** The cluster list. */
export interface FlowListResult {
  readonly clusters: readonly FlowClusterListItem[]
}

/** One page of durable events. */
export interface FlowEventsResult {
  readonly events: readonly FlowEventRecord[]
}

// ------------------------------------------------------------------ report

/** The exhaustive mechanism report one cluster produces. */
export interface FlowReport {
  readonly cluster: FlowReportCluster
  readonly mechanism: FlowReportMechanism
  readonly transactions: FlowReportTransactions
}

/** The cluster header of a report. */
export interface FlowReportCluster {
  readonly id: string
  readonly status: FlowClusterStatus
  readonly objective: string
  readonly workspace: string
  readonly limits: FlowLimits
}

/** One page of report transactions, with an explicit truncation flag. */
export interface FlowReportTransactions {
  readonly items: readonly FlowReportTransactionItem[]
  readonly total: number
  readonly truncated: boolean
}

/** One transaction row of a report. */
export interface FlowReportTransactionItem {
  readonly id: string
  readonly status: FlowTransactionStatus
  readonly revision: number
  readonly result_revision: number | null
  readonly objective: string
  readonly parent: string | null
  readonly node: string
  readonly priority: number
  readonly validation: FlowReportValidation | null
}

/**
 * The validation summary a report row carries.
 *
 * Both members are read straight off the stored `validation` JSON, which a
 * peer-reviewed result may not have filled in: `accepted` is genuinely absent
 * for a validation that recorded only checks, and the report says so rather
 * than inventing `false`.
 */
export interface FlowReportValidation {
  readonly accepted?: boolean | undefined
  readonly checks: number
}

/** Section 18/19's measured mechanism block. */
export interface FlowReportMechanism {
  readonly nodes: number
  readonly management_nodes: number
  readonly worker_nodes: number
  readonly max_depth: number
  readonly max_fan_out: number
  readonly agents_ever_created: number
  readonly agents_live: number
  readonly agents_activated: number
  readonly agents_by_role: FlowRoleTally
  readonly transactions_by_status: FlowTransactionStatusTally
  readonly transactions_total: number
  readonly audits_pending: number
  readonly issues_open: number
  readonly issues_total: number
  readonly corrections: number
  readonly usage: FlowUsageSummary
  readonly budgets: readonly FlowBudgetEvaluation[]
  readonly leases_active: number
  readonly effects: number
  readonly effects_by_status: FlowEffectStatusTally
  readonly sources_captured: number
  readonly message_deliveries: number
  readonly events: number
  readonly subtree_size: FlowSubtreeSizeTally
  readonly orchestrator_context: readonly FlowOrchestratorContext[]
  readonly agent_utilization: FlowAgentUtilization
  readonly auditor_event_rate: FlowAuditorEventRate
  readonly communication_traffic: FlowCommunicationTraffic
}

/** The effect-status tally of a report. */
export interface FlowEffectStatusTally {
  readonly STARTED?: number
  readonly SETTLED?: number
  readonly FAILED?: number
  readonly CANCELLED?: number
  readonly UNKNOWN?: number
}

/** One management identity's latest measured context size. */
export interface FlowOrchestratorContext {
  readonly agent_id: string
  readonly total_tokens: number | null
}

/** How much of the live identity pool is actually running. */
export interface FlowAgentUtilization {
  readonly live_agents: number
  readonly active_turns: number
  readonly ratio: number | null
}

/** How often an Auditor is woken. */
export interface FlowAuditorEventRate {
  readonly window_ms: number
  readonly inbox_rows: number
  readonly per_second: number
}

/** Message traffic, including how much of it crossed a subtree boundary. */
export interface FlowCommunicationTraffic {
  readonly deliveries: number
  readonly cross_subtree: number
  readonly cross_subtree_ratio: number | null
}

// ------------------------------------------------------------------- query

/** The cluster-list request. */
export interface FlowListQuery {
  readonly status?: FlowClusterStatus
  readonly limit?: number
  readonly offset?: number
}

/** One cluster read request. */
export interface FlowReadQuery {
  readonly limit?: number
  readonly offset?: number
  readonly node_id?: string
  readonly status?: string | readonly string[]
  readonly since?: number
  readonly event_limit?: number
  readonly include_events?: boolean
  readonly include_summary?: boolean
}

/** One event-page request. */
export interface FlowEventQuery {
  readonly since?: number
  readonly limit?: number
}

/**
 * One cluster query request.
 *
 * Only the parameters the current branches consume are declared. `status`
 * accepts one value or a list, and `parent_id` accepts `null` because "root
 * children" is a different question from "unset".
 */
export interface FlowQueryParams {
  readonly limit?: number
  readonly offset?: number
  readonly id?: string
  readonly call_id?: string
  readonly agent_id?: string
  readonly node_id?: string
  readonly transaction_id?: string
  readonly parent_id?: string | null
  readonly status?: string | readonly string[]
  readonly role?: FlowAgentRole
  readonly prefix?: string
  readonly full?: boolean
  readonly cluster_id?: string
}

/** The cluster projection a query returns. */
export interface FlowClusterQueryData {
  readonly cluster: FlowClusterSummary
  readonly counts: FlowCounts
}

/** Canonical management-tree nodes, as references. */
export interface FlowClusterNodesQueryData {
  readonly items: readonly FlowNodeReference[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** One node's topology, transactions and agents. */
export interface FlowClusterNodeQueryData {
  readonly ancestors: readonly FlowNodeAncestor[]
  readonly node: FlowNodeReference | FlowNodeRecord
  readonly transactions: FlowPage<FlowTransactionReference>
  readonly agents: FlowPage<FlowAgentReference>
  readonly subtree_size: number
}

/** Transactions inside the actor's domain. */
export interface FlowClusterTransactionsQueryData {
  readonly items: readonly FlowTransactionReference[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** One transaction with its gates, evidence references and saved result. */
export interface FlowClusterTransactionQueryData {
  readonly transaction: FlowTransactionReference | FlowTransactionDetail
  readonly dependencies: readonly string[]
  readonly dependents: readonly string[]
  readonly audits: readonly FlowAuditRecord[]
  readonly issues: readonly FlowIssueRecord[]
  readonly allocation: FlowAllocationRecord | FlowAllocationReference | null
  readonly validation: FlowJsonValue
  readonly result: FlowJsonValue
  readonly result_revision: number | null
}

/** The extra transaction fields a model role may read. */
export interface FlowTransactionDetail {
  readonly id: string
  readonly node_id: string
  readonly owner_management_id: string
  readonly status: FlowTransactionStatus
  readonly revision: number
  readonly result_revision: number | null
  readonly priority: number
  readonly parent_transaction_id: string | null
  readonly objective: string
  readonly inputs: FlowJsonValue
  readonly expected_output: string
  readonly acceptance_criteria: FlowJsonValue
  readonly capabilities: readonly FlowCapability[]
  readonly attempts: number
  readonly plan_approved_revision: number | null
}

/** The allocation fields a model role may read. */
export interface FlowAllocationReference {
  readonly id: string
  readonly node_id: string
  readonly agent_id: string
  readonly write_scope: readonly string[]
  readonly status: FlowAllocationStatus
}

/** One audit record by id. */
export interface FlowClusterAuditQueryData {
  readonly audit: FlowAuditRecord
}

/** Agents inside the actor's domain. */
export interface FlowClusterAgentsQueryData {
  readonly items: readonly FlowAgentReference[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** Active allocations inside the actor's domain. */
export interface FlowClusterAllocationsQueryData {
  readonly items: readonly FlowAllocationRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** The budget rows in the actor's domain. */
export interface FlowClusterBudgetsQueryData {
  readonly items: readonly FlowBudgetEvaluation[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** Issues inside the actor's domain. */
export interface FlowClusterIssuesQueryData {
  readonly items: readonly FlowIssueRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** One issue by id, with its evidence. */
export interface FlowClusterIssueQueryData {
  readonly issue: FlowIssueRecord
}

/** Audits still awaiting a decision. */
export interface FlowClusterAuditsQueryData {
  readonly items: readonly FlowAuditRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** Durable effect receipts. */
export interface FlowClusterEffectsQueryData {
  readonly items: readonly FlowEffectRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** One effect receipt by call id. */
export interface FlowClusterEffectQueryData {
  readonly effect: FlowEffectRecord
}

/** Model-request receipts plus the aggregate usage they roll up to. */
export interface FlowClusterUsageQueryData {
  readonly usage: FlowUsageSummary
  readonly items: readonly FlowUsageReceipt[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** Message deliveries. */
export interface FlowClusterDeliveriesQueryData {
  readonly items: readonly FlowDeliveryRow[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/** One identity's recent context steps and latest summary. */
export interface FlowClusterContextQueryData {
  readonly agent_id: string
  readonly steps: readonly FlowContextStep[]
  readonly summary: FlowSummary | null
}

/** The latest health evaluation plus the signals it was scored against. */
export interface FlowClusterHealthQueryData {
  readonly health: FlowHealthEvaluation | null
  readonly metrics: readonly FlowHealthMetric[]
  readonly signals: FlowHealthSignals
}

/** The latest summary of a scope. */
export interface FlowClusterSummaryQueryData {
  readonly summary: FlowSummary | null
}

/** Blackboard entries. */
export interface FlowClusterBlackboardQueryData {
  readonly items: readonly FlowBlackboardEntry[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly next_offset: number | null
}

/**
 * One answered query.
 *
 * The `what` tag is part of the answer — not a copy of the request — so a
 * consumer narrows `data` by branch instead of asserting the shape it expected.
 */
export type FlowQueryResult =
  | { readonly what: 'cluster'; readonly data: FlowClusterQueryData }
  | { readonly what: 'nodes'; readonly data: FlowClusterNodesQueryData }
  | { readonly what: 'node'; readonly data: FlowClusterNodeQueryData }
  | { readonly what: 'transactions'; readonly data: FlowClusterTransactionsQueryData }
  | { readonly what: 'transaction'; readonly data: FlowClusterTransactionQueryData }
  | { readonly what: 'audit'; readonly data: FlowClusterAuditQueryData }
  | { readonly what: 'agents'; readonly data: FlowClusterAgentsQueryData }
  | { readonly what: 'allocations'; readonly data: FlowClusterAllocationsQueryData }
  | { readonly what: 'budgets'; readonly data: FlowClusterBudgetsQueryData }
  | { readonly what: 'issues'; readonly data: FlowClusterIssuesQueryData }
  | { readonly what: 'issue'; readonly data: FlowClusterIssueQueryData }
  | { readonly what: 'audits'; readonly data: FlowClusterAuditsQueryData }
  | { readonly what: 'effects'; readonly data: FlowClusterEffectsQueryData }
  | { readonly what: 'effect'; readonly data: FlowClusterEffectQueryData }
  | { readonly what: 'usage'; readonly data: FlowClusterUsageQueryData }
  | { readonly what: 'deliveries'; readonly data: FlowClusterDeliveriesQueryData }
  | { readonly what: 'context'; readonly data: FlowClusterContextQueryData }
  | { readonly what: 'health'; readonly data: FlowClusterHealthQueryData }
  | { readonly what: 'summary'; readonly data: FlowClusterSummaryQueryData }
  | { readonly what: 'blackboard'; readonly data: FlowClusterBlackboardQueryData }