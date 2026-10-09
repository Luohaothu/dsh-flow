/**
 * Host-only domain types: the persisted records, the actor and turn identities,
 * the resolved start spec, the action vocabulary and the runtime configuration.
 *
 * Nothing here may reach the Client. The browser gets the projections in
 * `../types.ts`; these are the shapes the store writes, the scheduler reasons
 * about and the command handlers mutate. Keeping them apart is what lets the
 * Client bundle stay free of the store and of every Node module it uses.
 */

import type {
  FlowActorRole,
  FlowAgentRole,
  FlowAgentStatus,
  FlowAllocationStatus,
  FlowAuditDecision,
  FlowAuditKind,
  FlowBudget,
  FlowBudgetInput,
  FlowCapability,
  FlowClusterStatus,
  FlowDeliveryStatus,
  FlowDispatchStatus,
  FlowEffectStatus,
  FlowGroupStatus,
  FlowInboxStatus,
  FlowIssueStatus,
  FlowJsonValue,
  FlowLimits,
  FlowLimitsInput,
  FlowNodeKind,
  FlowNodeStatus,
  FlowScopeKind,
  FlowTransactionStatus,
  FlowPlanRef, FlowCriterionRef, FlowValidationRef, FlowResultRef,
} from '../types.ts';

export type PlanRef = FlowPlanRef;
export type CriterionRef = FlowCriterionRef;
export type ValidationRef = FlowValidationRef;
export type ResultRef = FlowResultRef;

/** Business facts captured with a prepared plan. They never follow mutable rows. */
export interface TaskContract {
  readonly objective: string
  readonly inputs: FlowJsonValue
  readonly constraints: FlowJsonValue
  readonly expected_output: string
  readonly acceptance_criteria: readonly string[]
  readonly capabilities: readonly FlowCapability[]
  readonly needs: FlowJsonValue
  readonly dependencies: readonly string[]
}

export interface CriterionResponsibility {
  readonly criterion: CriterionRef
  readonly evidence_provider: string
  readonly validated_by: 'orchestrator'
  readonly applies_to: readonly string[]
}

export interface PlanRecord {
  readonly ref: PlanRef
  readonly cluster_id: string
  readonly author_role: FlowActorRole
  readonly author_agent_id: string | null
  readonly created: number
  readonly contract: TaskContract
  readonly understanding: string
  readonly execution: 'worker' | 'decompose' | 'management'
  readonly rationale: string
  readonly assignment: string
  readonly assignment_key: string
  readonly child_transaction_ids: readonly string[]
  readonly criterion_responsibilities: readonly CriterionResponsibility[]
  readonly integration: string | null
}

export interface ResultRecord {
  readonly ref: ResultRef
  readonly cluster_id: string
  readonly plan_ref: PlanRef
  readonly result: FlowJsonValue
  readonly producer_role: FlowActorRole
  readonly producer_agent_id: string | null
  readonly epoch: number | null
  readonly turn_seq: number | null
  readonly source_result_refs: readonly ResultRef[]
  readonly source_validation_refs: readonly ValidationRef[]
  readonly created: number
}

export interface ValidationRecord {
  readonly ref: ValidationRef
  readonly cluster_id: string
  readonly plan_ref: PlanRef
  readonly result_ref: ResultRef
  readonly author_role: FlowActorRole
  readonly author_agent_id: string | null
  readonly checks: readonly FlowValidationCheck[]
  readonly accepted: boolean
  readonly notes: string
  readonly limitations: readonly string[]
  readonly created: number
}

export interface MemberInputRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly session_id: string
  readonly delivery_key: string
  readonly kind: 'initial' | 'revision' | 'wake'
  readonly author: FlowJsonValue
  readonly plan_ref: PlanRef | null
  readonly previous_plan_ref: PlanRef | null
  readonly binding: FlowJsonValue
  readonly content: string
  readonly native_message_id: string
  readonly native_seq: number | null
  readonly status: 'PENDING' | 'ADMITTED'
  readonly created: number
  readonly admitted: number | null
}

// ------------------------------------------------------------------- actors

/** The host operator acting on a cluster, with no agent identity of its own. */
export interface FlowUserActor {
  readonly role: 'user'
  readonly cluster_id: string
}

/** A cluster agent acting inside its domain; `epoch`/`turn_seq` fence its turn. */
export interface FlowAgentActor {
  readonly role: FlowAgentRole
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string
  readonly session_id: string
  readonly epoch?: number
  readonly turn_seq?: number
}

/** Either actor a command may arrive from. */
export type FlowActor = FlowUserActor | FlowAgentActor;

/** The captured identity of one scheduled turn, never the lease that is live now. */
export interface TurnIdentity {
  readonly agent_id: string
  readonly epoch: number
  readonly turn_seq: number
}

// ---------------------------------------------------------- parsed JSON shapes

/**
 * One management node's stored scope. The declared keys are the ones the
 * scheduler and the command handlers read; anything else a caller tucked in
 * stays reachable through the index signature.
 */
export interface NodeScope {
  readonly team_model?: FlowModelSelection
  readonly team_model_options?: FlowModelSelection
  readonly transaction_id?: string | null
  readonly objective?: string
  readonly root?: boolean
  readonly spawn_children?: number
  readonly management_levels_remaining?: number
  readonly delegation_entry?: NodeDelegationEntry | null
  readonly delegation_contract?: NodeDelegationContract | null
  readonly [key: string]: unknown
}

/** The delegation instruction a management node still owes its fixture. */
export interface NodeDelegationEntry {
  readonly scope?: string
  readonly objective?: string
  readonly spawn_children?: number
  readonly inputs?: Record<string, FlowJsonValue>
  readonly max_children?: number
  readonly budget?: FlowBudgetInput
}

/** The deliverable a node assigned when it spawned a delegated child. */
export interface NodeDelegationContract {
  readonly expected_output: string
  readonly acceptance_criteria: readonly string[]
  readonly management_levels_remaining?: number
  readonly parent_plan_ref?: PlanRef
  readonly assignment_key?: string
}

/** One agent's stored meta: its model selection and provenance. */
export interface AgentMeta {
  readonly model?: FlowModelSelection
  readonly management?: boolean
  readonly transaction_id?: string | null
  readonly allocated_by?: string | null
  readonly replaced?: string
  readonly [key: string]: unknown
}

/** One check of a transaction's proposed validation. */
export interface FlowValidationCheck {
  readonly criterion: string
  readonly criterion_ref?: CriterionRef
  readonly method?: string
  readonly observation?: string
  readonly evidence_refs?: readonly FlowJsonValue[]
  readonly passed: boolean
  readonly evidence: string
}

/** A transaction's stored validation proposal. */
export interface FlowValidation {
  readonly checks?: readonly FlowValidationCheck[]
  readonly accepted?: boolean
  readonly notes?: string
  readonly at?: number
  readonly by?: string | null
}

/**
 * A cluster's persisted JSON specification. Fields are optional because a
 * stored request can omit them; decoding verifies the object shape only.
 */
export interface StoredSpec {
  readonly objective?: string
  readonly workspace?: string
  readonly capabilities?: readonly FlowCapability[]
  readonly limits?: FlowLimitsInput
  readonly budget?: FlowBudgetInput
  readonly delegation?: readonly DelegationFixtureEntry[]
  readonly message_fixture?: readonly MessageFixtureEntry[]
  readonly acceptance_criteria?: readonly string[]
  readonly initial_transactions?: readonly FlowJsonValue[]
  readonly [key: string]: unknown
}

// ------------------------------------------------------------------ records

/** One cluster row, JSON columns decoded. */
export interface ClusterRecord {
  readonly id: string
  readonly objective: string
  readonly workspace: string
  readonly capabilities: readonly FlowCapability[]
  readonly limits: FlowLimits
  readonly budget: FlowBudgetInput
  readonly spec: StoredSpec | null
  readonly declared_limits: string | null
  readonly status: FlowClusterStatus
  readonly revision: number
  readonly created: number
  readonly updated: number
}

/** One management-tree node row, JSON columns decoded. */
export interface NodeRecord {
  readonly id: string
  readonly cluster_id: string
  readonly parent_id: string | null
  readonly kind: FlowNodeKind
  readonly depth: number
  readonly status: FlowNodeStatus
  readonly revision: number
  readonly scope: NodeScope | null
  readonly capabilities: readonly FlowCapability[]
  readonly owner_management_id: string | null
  readonly delegated_transaction_id: string | null
  readonly max_children: number | null
  readonly path: string
  readonly created: number
  readonly updated: number
}

/** One cluster agent row, JSON columns decoded. */
export interface AgentRecord {
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
  readonly meta: AgentMeta
  readonly created: number
  readonly updated: number
}

/** One transaction row, JSON columns decoded. */
export interface TransactionRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly owner_management_id: string
  readonly parent_transaction_id: string | null
  readonly objective: string
  readonly inputs: FlowJsonValue
  readonly constraints: FlowJsonValue
  readonly expected_output: string
  readonly acceptance_criteria: readonly string[]
  readonly needs: FlowJsonValue
  readonly priority: number
  readonly capabilities: readonly FlowCapability[]
  readonly status: FlowTransactionStatus
  readonly revision: number
  readonly attempts: number
  readonly result: FlowJsonValue
  readonly result_revision: number | null
  readonly validation: FlowValidation | null
  readonly plan_approved_revision: number | null
  readonly current_plan_ref: PlanRef | null
  readonly current_result_ref: ResultRef | null
  readonly current_validation_ref: ValidationRef | null
  readonly result_staged_epoch: number | null
  readonly result_staged_turn: number | null
  readonly result_staged_agent: string | null
  readonly pre_pause_status: FlowTransactionStatus | null
  readonly pre_pause_revision: number | null
  readonly created: number
  readonly updated: number
}

/** One agent allocation row, JSON columns decoded. */
export interface AllocationRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly agent_id: string
  readonly transaction_id: string | null
  readonly plan_ref: PlanRef | null
  readonly capabilities: readonly FlowCapability[]
  readonly write_scope: readonly string[]
  readonly write_scope_canonical: readonly string[] | null
  readonly status: FlowAllocationStatus
  readonly created: number
  readonly updated: number
}

/** One inbox row, payload decoded. */
export interface InboxRecord {
  readonly id: string
  readonly cluster_id: string
  readonly recipient: string
  readonly subject: string
  readonly payload: FlowJsonValue
  readonly status: FlowInboxStatus
  readonly coalesce_key: string | null
  readonly dedupe_key: string | null
  readonly created: number
  readonly consumed: number | null
}

/** One budget row exactly as the ledger stores it. */
export interface BudgetRecord {
  readonly id: string
  readonly cluster_id: string
  readonly scope_kind: FlowScopeKind
  readonly scope_id: string
  readonly node_id: string | null
  readonly parent_budget_id: string | null
  readonly revision: number
  readonly tool_calls_limit: number
  readonly tool_calls_reserved: number
  readonly tool_calls_spent: number
  readonly agents_limit: number
  readonly agents_reserved: number
  readonly max_active_limit: number
  readonly max_active_reserved: number
  readonly wall_limit_ms: number
  readonly wall_deadline: number | null
  readonly created: number
  readonly updated: number
}

/** One audit row, evidence decoded. */
export interface AuditRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly auditor_agent_id: string | null
  readonly kind: FlowAuditKind
  readonly target_revision: number | null
  readonly plan_ref: PlanRef | null
  readonly validation_ref: ValidationRef | null
  readonly decision: FlowAuditDecision
  readonly evidence: FlowJsonValue
  readonly created: number
  readonly decided: number | null
}

/** One issue row, evidence decoded. */
export interface IssueRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly reporter_agent_id: string | null
  readonly target_revision: number | null
  readonly severity: string
  readonly required_change: string
  readonly evidence: FlowJsonValue
  readonly status: FlowIssueStatus
  readonly corrections: number
  readonly reviewed_revision: number | null
  readonly created: number
  readonly updated: number
}

/** One durable effect receipt row. */
export interface EffectRecord {
  readonly call_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string | null
  readonly lease_epoch: number
  readonly session_id: string | null
  readonly turn_seq: number | null
  readonly tool: string
  readonly args: string | null
  readonly status: FlowEffectStatus
  readonly body: string | null
  readonly error: string | null
  readonly job_id: string | null
  readonly created: number
  readonly settled: number | null
}

/** One tool-call admission receipt row. */
export interface ToolCallReceiptRecord {
  readonly call_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly session_id: string | null
  readonly turn_seq: number | null
  readonly tool: string
  readonly args_hash: string | null
  readonly command_id: string | null
  readonly budget_scope_id: string | null
  readonly dispatch_status: FlowDispatchStatus
  readonly result_body: string | null
  readonly error: string | null
  readonly created: number
  readonly settled: number | null
}

/** One durable event row. */
export interface EventRecord {
  readonly seq: number
  readonly cluster_id: string
  readonly type: string
  readonly data: FlowJsonValue
  readonly at: number
}

/** One recipient row of one message. */
export interface RecipientRecord {
  readonly message_id: string
  readonly recipient: string
  readonly delivery_seq: number | null
  readonly status: FlowDeliveryStatus
  readonly acked: number | null
  readonly created: number
}

/** One message row. */
export interface MessageRecord {
  readonly id: string
  readonly cluster_id: string
  readonly from_agent: string | null
  readonly from_node: string | null
  readonly kind: string
  readonly content: FlowJsonValue
  readonly created: number
}

/** One blackboard row. */
export interface BlackboardRecord {
  readonly cluster_id: string
  readonly key: string
  readonly value: string
  readonly revision: number
  readonly updated_by: string | null
  readonly updated: number
}

/** One communication group row. */
export interface GroupRecord {
  readonly id: string
  readonly cluster_id: string
  readonly name: string
  readonly status: FlowGroupStatus
  readonly created: number
  readonly updated: number
}

/** One blackboard subscription row. */
export interface SubscriptionRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly pattern: string
  readonly mode: string
  readonly active: number
  readonly cursor: string | null
  readonly created: number
}

/** One active lease row. */
export interface LeaseRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string
  readonly purpose: string
  readonly epoch: number
  readonly expires: number
  readonly event_upper_bound: number
  readonly created: number
}

// -------------------------------------------------------------- start input

/** A reproducible message fixture entry: a deterministic send for the delivery pipeline. */
export interface MessageFixtureEntry {
  readonly from: string
  readonly to: string
  readonly content: string
  readonly message_id: string
}

/** A reproducible topology fixture entry: management children the cluster must build. */
export interface DelegationFixtureEntry {
  readonly scope: string
  readonly objective: string
  readonly max_children: number
  readonly spawn_children: number
  readonly budget?: FlowBudgetInput
  readonly inputs?: Record<string, unknown>
}

/**
 * A start request resolved against the deployment configuration: every field
 * that configuration can supply is present, and only the genuinely internal
 * fixtures stay outside the wire request.
 */
export interface FlowStartSpec {
  readonly objective: string
  readonly id?: string
  readonly workspace: string
  readonly capabilities: readonly FlowCapability[]
  readonly budget: FlowBudgetInput
  readonly limits: FlowLimits
  readonly initial_transactions?: readonly FlowJsonValue[]
  readonly acceptance_criteria?: readonly string[]
  readonly delegation: readonly DelegationFixtureEntry[]
  readonly message_fixture: readonly MessageFixtureEntry[]
}

/**
 * The defaults a deployment contributes to a start request.
 *
 * Every service or main-Agent caller resolves omitted fields through this
 * same envelope.
 */
export interface FlowStartDefaults {
  readonly workspace: string
  readonly capabilities: readonly FlowCapability[]
  readonly budget: FlowBudget
  readonly limits: FlowLimits
}

/** Captured at admission and persisted in the root scope, including across restarts. */
export interface FlowExecutionDefaults {
  readonly start: FlowStartDefaults
  readonly model: FlowModelSelection | null
  readonly options: FlowModelSelection
  readonly dispatchMode: 'parallel' | 'serial'
}

/**
 * The two reproducible fixtures an acceptance run may pin.
 *
 * They are deliberately outside {@link FlowStartRequest}: a fixture pins the
 * control-plane's inputs so a run is deterministic, which is a development
 * concern, not part of the cluster's public start contract. Only the
 * development IPC bridge passes them.
 */
export interface FlowStartInternals {
  readonly delegation?: unknown
  readonly message_fixture?: unknown
}

// ---------------------------------------------------------------- mutations

/** Patch keys the node table accepts. */
export interface NodePatch {
  readonly status?: FlowNodeStatus
  readonly scope?: NodeScope | null
  readonly capabilities?: readonly FlowCapability[]
  readonly parent_id?: string | null
  readonly depth?: number
  readonly path?: string
  readonly kind?: FlowNodeKind
  readonly owner_management_id?: string | null
  readonly delegated_transaction_id?: string | null
  readonly max_children?: number | null
  readonly revision?: number
  readonly updated?: number
  readonly __bump_revision?: boolean
}

/** Patch keys the cluster table accepts. */
export interface ClusterPatch {
  readonly status?: FlowClusterStatus
  readonly capabilities?: readonly FlowCapability[]
  readonly limits?: FlowLimitsInput
  readonly budget?: FlowBudgetInput
  readonly spec?: StoredSpec
  readonly revision?: number
  readonly updated?: number
  readonly declared_limits?: string | null
  readonly __bump_revision?: boolean
}

/** Patch keys the agent table accepts. */
export interface AgentPatch {
  readonly status?: FlowAgentStatus
  readonly epoch?: number
  readonly turns?: number
  readonly stagnation?: number
  readonly capabilities?: readonly FlowCapability[]
  readonly cwd?: string | null
  readonly meta?: AgentMeta
  readonly session_id?: string
  readonly revision?: number
  readonly updated?: number
  readonly __bump_revision?: boolean
}

/** Patch keys the transaction table accepts. */
export interface TransactionPatch {
  readonly status?: FlowTransactionStatus
  readonly revision?: number
  readonly attempts?: number
  readonly result?: FlowJsonValue
  readonly result_revision?: number | null
  readonly validation?: FlowValidation | null
  readonly plan_approved_revision?: number | null
  readonly current_plan_ref?: PlanRef | null
  readonly current_result_ref?: ResultRef | null
  readonly current_validation_ref?: ValidationRef | null
  readonly priority?: number
  readonly owner_management_id?: string
  readonly parent_transaction_id?: string | null
  readonly node_id?: string
  readonly objective?: string
  readonly constraints?: FlowJsonValue
  readonly expected_output?: string
  readonly acceptance_criteria?: readonly string[]
  readonly inputs?: FlowJsonValue | undefined
  readonly needs?: FlowJsonValue
  readonly capabilities?: readonly FlowCapability[]
  readonly result_staged_epoch?: number | null
  readonly result_staged_turn?: number | null
  readonly result_staged_agent?: string | null
  readonly pre_pause_status?: FlowTransactionStatus | null
  readonly pre_pause_revision?: number | null
  readonly updated?: number
  readonly __bump_revision?: boolean
}

/** Patch keys the allocation table accepts. */
export interface AllocationPatch {
  readonly status?: FlowAllocationStatus
  readonly transaction_id?: string | null
  readonly plan_ref?: PlanRef | null
  readonly agent_id?: string
  readonly write_scope?: readonly string[]
  readonly write_scope_canonical?: readonly string[] | null
  readonly capabilities?: readonly FlowCapability[]
  readonly updated?: number
  readonly __bump_revision?: boolean
}

/** Patch keys the group table accepts. */
export interface GroupPatch {
  readonly status?: FlowGroupStatus
  readonly name?: string
  readonly updated?: number
  readonly __bump_revision?: boolean
}

/** Patch keys the budget table accepts: one numeric column per dimension. */
export interface BudgetPatch {
  readonly tool_calls_limit?: number
  readonly tool_calls_reserved?: number
  readonly tool_calls_spent?: number
  readonly agents_limit?: number
  readonly agents_reserved?: number
  readonly max_active_limit?: number
  readonly max_active_reserved?: number
  readonly wall_limit_ms?: number
  readonly wall_deadline?: number | null
  readonly parent_budget_id?: string | null
  readonly updated?: number
  readonly __bump_revision?: boolean
}

// ------------------------------------------------------------ runtime config

/** The model route one agent runs on. */
export interface FlowModelSelection {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
}

/** The structural logger the runtime uses; anything louder is the host's business. */
export interface FlowLogger {
  debug?(message: unknown, ...rest: unknown[]): void
  info?(message: unknown, ...rest: unknown[]): void
  warn?(message: unknown, ...rest: unknown[]): void
  error?(message: unknown, ...rest: unknown[]): void
}

/** Everything the runtime needs to run a cluster. */
export interface FlowRuntimeConfig {
  readonly dataDir?: string
  readonly path?: string
  readonly dbPath?: string
  readonly model?: FlowModelSelection
  readonly tickMs?: number
  readonly leaseTtlMs?: number
  readonly staleMs?: number
  readonly maxTurnMs?: number
  readonly heartbeatMs?: number
  readonly disposeTimeoutMs?: number
  readonly now?: () => number
  readonly routes?: Record<string, readonly string[]>
  readonly logger?: FlowLogger
  readonly autoTick?: boolean
  readonly startDefaults?: FlowStartDefaults
  readonly executionDefaults?: (() => FlowExecutionDefaults) | undefined
}

/** The runtime configuration after defaults are applied. */
export interface ResolvedRuntimeConfig {
  readonly dataDir: string | undefined
  readonly model: FlowModelSelection
  readonly tickMs: number
  readonly leaseTtlMs: number
  readonly staleMs: number
  readonly maxTurnMs: number
  readonly heartbeatMs: number
  readonly disposeTimeoutMs: number
  readonly now: (() => number) | undefined
  readonly routes: Record<string, readonly string[]>
  readonly autoTick: boolean
  readonly startDefaults: FlowStartDefaults | undefined
  readonly executionDefaults: (() => FlowExecutionDefaults) | undefined
}

// ------------------------------------------------------------------- actions

/** One command as it arrives from a role tool: an action name plus open parameters. */
export interface FlowCommand {
  readonly command_id: string
  readonly action: string
  readonly params: Record<string, unknown>
  readonly expected_revision?: unknown
}

/** The result of one command handler. */
export interface FlowCommandOutcome {
  readonly deduped: boolean
  readonly revision: number
  readonly result: FlowJsonValue
}

export type { FlowActorRole, FlowCapability, FlowLimitsInput, FlowLimits, FlowBudget };
