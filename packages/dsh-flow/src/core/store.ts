/**
 * ClusterStore: the single writer for the dsh-flow cluster state database.
 *
 * Every mutation path in the cluster goes through one SQLite transaction that
 * commits state + command idempotency record + events together. No transaction
 * body may await model, network or file IO; callers must do all IO outside.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
  StatementSync,
} from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAsyncFunction, isPromise } from 'node:util/types';

import { fail } from '../errors.ts';
import {
  BUDGET_KEYS,
  integer,
  isFlowJsonValue,
  normalizeLimit,
  rejectUnknownFields,
  objectField,
  textField,
  validateCapabilities,
} from '../validation.ts';
import { DEFAULT_LIMITS } from './protocol.ts';
import { nativeUsageEvents, summarizeNativeUsage, nativeContext } from './native-usage.ts';
import type { NativeUsageProjection, NativeSessionFact } from './native-usage.ts';
import type {
  FlowAuditDecision,
  FlowAuditKind,
  FlowAgentRole,
  FlowAgentStatus,
  FlowAllocationStatus,
  FlowBudgetInput,
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
  FlowUsageEvent,
  FlowUsageSummary,
  FlowNativeContext,
} from '../types.ts';
import type {
  AgentPatch,
  AgentRecord,
  AllocationPatch,
  AllocationRecord,
  AuditRecord,
  BlackboardRecord,
  BudgetPatch,
  BudgetRecord,
  ClusterPatch,
  ClusterRecord,
  EffectRecord,
  EventRecord,
  FlowActor,
  GroupPatch,
  GroupRecord,
  InboxRecord,
  IssueRecord,
  LeaseRecord,
  MessageRecord,
  NodePatch,
  NodeRecord,
  RecipientRecord,
  ToolCallReceiptRecord,
  TransactionPatch,
  TransactionRecord,
} from './model.ts';

export const SCHEMA_VERSION = 3;

/** One SQLite row as the driver returns it. */
type Row = Record<string, SQLOutputValue>;

/** One value bound into a statement; `undefined` is normalised to SQL `null`. */
type BindValue = SQLInputValue | undefined;

/** The wall clock the store stamps rows with; swappable in tests. */
export const nowMs = () => Date.now();

// ----------------------------------------------------------- row narrowing

/** Narrow one INTEGER column. */
function numOf(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  fail(`Invalid ${label}: expected integer`);
}

/** Narrow one nullable INTEGER column. */
function numOrNull(value: SQLOutputValue | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  return numOf(value, label);
}

/**
 * Decode a stored integer or ISO timestamp as epoch milliseconds. SQL retains
 * the stored representation for ordering; decoding does not discard text rows.
 */
function timestampOf(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  fail(`Invalid ${label}: expected an integer timestamp`);
}

/** Narrow one TEXT column. Empty text is legal: only the type is checked. */
function textOf(value: SQLOutputValue | undefined, label: string): string {
  if (typeof value === 'string') return value;
  fail(`Invalid ${label}: expected text`);
}

/** Narrow one nullable TEXT column. */
function textOrNull(value: SQLOutputValue | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  return textOf(value, label);
}

/** Narrow one enumerated TEXT column against its declared vocabulary. */
function oneOf<T extends string>(value: SQLOutputValue | undefined, allowed: readonly T[], label: string): T {
  for (const candidate of allowed) if (candidate === value) return candidate;
  fail(`Invalid ${label}: ${String(value)}`);
}

/** Narrow one non-JSON scalar column value bound into a patch. */
function scalarOf(value: unknown, label: string): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  fail(`Invalid ${label}: expected a scalar column value`);
}

/** Narrow one decoded JSON column. */
function jsonOf(value: unknown, label: string): FlowJsonValue {
  if (!isFlowJsonValue(value)) fail(`Invalid ${label}: expected lossless JSON`);
  return value;
}


/** Narrow one decoded JSON column that must be an object; `null` stays `null`. */
function objectOrNull(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return objectField(value, label);
}

/** Narrow one decoded JSON column that must be a list of strings. */
function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`Invalid ${label}: expected a list`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') fail(`Invalid ${label} entry`);
    out.push(entry);
  }
  return out;
}

/** Read one optional non-negative integer, falling back when absent or malformed. */
function limitOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Read one stored limits row tolerantly.
 *
 * Missing retained limits use their deployment defaults. Unsupported fields
 * are refused; no historical model-limit contract is decoded.
 */
function decodeLimits(value: unknown): FlowLimits {
  const source = objectField(value, 'limits');
  rejectUnknownFields(source, Object.keys(DEFAULT_LIMITS).concat('max_tool_calls_per_turn', 'max_scale_batch'), 'limits');
  return {
    max_children: limitOf(source.max_children, DEFAULT_LIMITS.max_children),
    max_depth: limitOf(source.max_depth, DEFAULT_LIMITS.max_depth),
    max_agents: limitOf(source.max_agents, DEFAULT_LIMITS.max_agents),
    max_active_agents: limitOf(source.max_active_agents, DEFAULT_LIMITS.max_active_agents),
    max_llm_concurrency: limitOf(source.max_llm_concurrency, DEFAULT_LIMITS.max_llm_concurrency),
    max_attempts: limitOf(source.max_attempts, DEFAULT_LIMITS.max_attempts),
    max_corrections: limitOf(source.max_corrections, DEFAULT_LIMITS.max_corrections),
    max_role_turns: limitOf(source.max_role_turns, DEFAULT_LIMITS.max_role_turns),
    ...(source.max_tool_calls_per_turn === undefined ? {} : {
      max_tool_calls_per_turn: limitOf(source.max_tool_calls_per_turn, DEFAULT_LIMITS.max_tool_calls_per_turn),
    }),
    ...(source.max_scale_batch === undefined ? {} : {
      max_scale_batch: limitOf(source.max_scale_batch, 1),
    }),
  };
}

/**
 * Read one stored budget row tolerantly.
 *
 * A budget is stored partial by design (`validateSpec` keeps only the
 * dimensions the caller named), so only the dimensions that are present and
 * non-negative survive; nothing is invented and completeness is never required.
 * Only a value that is not an object at all is refused.
 */
function decodeBudget(value: unknown): FlowBudgetInput {
  const source = objectField(value, 'budget');
  rejectUnknownFields(source, BUDGET_KEYS, 'budget');
  const out: { [K in (typeof BUDGET_KEYS)[number]]?: number } = {};
  for (const key of BUDGET_KEYS) {
    const entry = source[key];
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) out[key] = entry;
  }
  return out;
}

/** The enumerations the decoders accept, mirroring the wire vocabulary. */
const CLUSTER_STATUSES = ['RUNNING', 'PAUSED', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'] as const satisfies readonly FlowClusterStatus[];
const NODE_STATUSES = ['ACTIVE', 'DRAINING', 'PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RELEASED'] as const satisfies readonly FlowNodeStatus[];
const NODE_KINDS = ['management', 'worker'] as const satisfies readonly FlowNodeKind[];
const AGENT_STATUSES = ['CREATED', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'TERMINATED'] as const satisfies readonly FlowAgentStatus[];
const AGENT_ROLES = ['orchestrator', 'allocator', 'auditor', 'worker'] as const satisfies readonly FlowAgentRole[];
const TRANSACTION_STATUSES = [
  'DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'ACCEPTED', 'REJECTED',
  'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const satisfies readonly FlowTransactionStatus[];
const ALLOCATION_STATUSES = ['ACTIVE', 'RELEASED'] as const satisfies readonly FlowAllocationStatus[];
const INBOX_STATUSES = ['PENDING', 'CONSUMED'] as const satisfies readonly FlowInboxStatus[];
const GROUP_STATUSES = ['OPEN', 'CLOSED'] as const satisfies readonly FlowGroupStatus[];
const SCOPE_KINDS = ['cluster', 'root', 'node', 'transaction', 'agent'] as const satisfies readonly FlowScopeKind[];
const AUDIT_KINDS = ['plan', 'validation'] as const satisfies readonly FlowAuditKind[];
const AUDIT_DECISIONS = [
  'PENDING', 'APPROVED', 'REJECTED', 'OVERRIDDEN', 'STALE',
  'CORRECTION_REQUESTED', 'REPLAN_REQUESTED', 'REVALIDATION_REQUESTED',
] as const satisfies readonly FlowAuditDecision[];
const ISSUE_STATUSES = ['OPEN', 'VERIFYING', 'CORRECTED', 'ESCALATED', 'DISMISSED'] as const satisfies readonly FlowIssueStatus[];
const EFFECT_STATUSES = ['STARTED', 'SETTLED', 'FAILED', 'CANCELLED', 'UNKNOWN', 'EFFECT_UNCERTAIN'] as const satisfies readonly FlowEffectStatus[];
const DISPATCH_STATUSES = ['ADMITTED', 'DISPATCHED', 'SETTLED', 'FAILED', 'CANCELLED', 'UNKNOWN'] as const satisfies readonly FlowDispatchStatus[];
const DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'ACKED'] as const satisfies readonly FlowDeliveryStatus[];

// ------------------------------------------------------- operation vocabulary

/** One command as `runCommand` receives it: identity plus the apply callback. */
interface RunCommandInput {
  readonly cluster_id: string
  readonly command_id: string
  readonly actor: FlowActor
  readonly action: string
  readonly expected_revision: unknown
  readonly params: Record<string, unknown> | undefined
}

/** One recorded command row, its actor and result decoded. */
interface CommandRecord {
  readonly command_id: string
  readonly cluster_id: string
  readonly actor: FlowJsonValue
  readonly action: string
  readonly hash: string
  readonly revision: number | null
  readonly result: FlowJsonValue
  readonly at: number
}

/** The raw result one action handler returns; `#applyCommand` adds the revision. */
export interface CommandApplyResult {
  readonly revision: number
  readonly [key: string]: unknown
}

/** What `runCommand` returns: the applied outcome, or the stored one. */
interface CommandReceipt {
  readonly result: CommandApplyResult | FlowJsonValue
  readonly revision: number | null
  readonly deduped: boolean
}

/** One event as `readEvents` projects it (no cluster id: the caller named it). */
export interface StreamEventRow {
  readonly seq: number
  readonly type: string
  readonly data: FlowJsonValue
  readonly at: number
}

/** One write scope as `writeScopes` reports it. */
interface WriteScopeRow {
  readonly id: string
  readonly agent_id: string
  readonly node_id: string
  readonly write_scope: FlowJsonValue
}

/** One transaction-status tally. */
interface TransactionStatusCount {
  readonly status: FlowTransactionStatus
  readonly c: number
}

/** One per-role agent tally. */
interface AgentRoleCount {
  readonly role: FlowAgentRole
  readonly c: number
  readonly live: number
  readonly activated: number
  readonly turns: number
}

/** Direct descendants per node, without loading any node row. */
interface SubtreeSize {
  readonly node_id: string
  readonly size: number
}

/** The depth-1 ancestor of one node. */
interface DomainRootRow {
  readonly id: string
  readonly root: string
}

/** One management parent whose delegated children are all accepted. */
interface AggregatableParent {
  readonly parent_id: string
  readonly children: number
}

/** One dependency edge. */
interface DependencyRow {
  readonly transaction_id: string
  readonly depends_on: string
}

/** One pending delivery with its message envelope. */
interface PendingDeliveryRow {
  readonly message_id: string
  readonly recipient: string
  readonly delivery_seq: number | null
  readonly status: FlowDeliveryStatus
  readonly acked: number | null
  readonly created: number
  readonly content: FlowJsonValue
  readonly from_agent: string | null
  readonly from_node: string | null
  readonly kind: string
  readonly message_created: number
}

/** One effect row plus the management owner its node implies. */
interface EffectWithOwner extends EffectRecord {
  readonly owner_management_id: string | null
}

/** One orchestrator context fact from its native Session. */
interface OrchestratorContextRow {
  readonly data: FlowJsonValue
  readonly agent_id: string | null
  readonly tokens: number | null
}

/** Delivery traffic of one cluster: total, and those crossing a domain. */
interface DeliveryTraffic {
  readonly deliveries: number
  readonly cross_subtree: number
}

/** One health evaluation row, its JSON columns decoded. */
interface HealthRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly evaluation_window: string | null
  readonly signals: FlowJsonValue
  readonly scores: FlowJsonValue
  readonly weights: FlowJsonValue
  readonly decided: number
  readonly decided_by: string | null
  readonly created: number
}

/** One durable summary row, its data decoded. */
interface SummaryRecord {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly as_of_seq: number
  readonly data: FlowJsonValue
  readonly created: number
}

/** One source receipt row, full text included. */
interface SourceRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string | null
  readonly transaction_id: string | null
  readonly request_url: string
  readonly final_url: string
  readonly status_code: number | null
  readonly fetched_at: number
  readonly hash: string
  readonly bytes: number
  readonly text: string
}

/** One source row as a list carries it: metadata, not the fetched body. */
interface SourceListRow {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly transaction_id: string | null
  readonly request_url: string
  readonly final_url: string
  readonly status_code: number | null
  readonly fetched_at: number
  readonly hash: string
  readonly bytes: number
}

/** One checkpoint row, its data decoded. */
interface CheckpointRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly session_id: string
  readonly flushed_seq: number | null
  readonly events_seq: number | null
  readonly transaction_id: string | null
  readonly transaction_revision: number | null
  readonly inbox_ack_cursor: string | null
  readonly usage_watermark: number | null
  readonly turn_seq: number | null
  readonly data: FlowJsonValue
  readonly created: number
}

/** One subscription row. */
interface SubscriptionRecord {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly pattern: string
  readonly mode: string
  readonly active: number
  readonly cursor: string | null
  readonly created: number
}

// ------------------------------------------------------------- insert shapes

/** One cluster row to insert. */
interface ClusterInsert {
  readonly id?: string | undefined
  readonly objective: string
  readonly workspace: string
  readonly capabilities: readonly string[]
  readonly limits: FlowLimitsInput
  /**
   * Accepted so a caller can build a whole cluster from one spec object, but
   * the authoritative value is the separate argument to
   * {@link ClusterStore.createCluster}: the row's `budget` column and its
   * declared spec are both written from that argument.
   */
  readonly budget?: FlowBudgetInput | undefined
  readonly delegation?: readonly unknown[] | undefined
  readonly message_fixture?: readonly unknown[] | undefined
}

/** One node row to insert. */
interface NodeInsert {
  readonly id: string
  readonly cluster_id: string
  readonly parent_id?: string | null | undefined
  readonly kind: FlowNodeKind
  readonly depth: number
  readonly status: FlowNodeStatus
  readonly scope?: FlowJsonValue | undefined
  readonly capabilities?: FlowJsonValue | undefined
  readonly owner_management_id?: string | null | undefined
  readonly delegated_transaction_id?: string | null | undefined
  readonly max_children?: number | null | undefined
  readonly path: string
}

/** One agent row to insert. */
interface AgentInsert {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly role: FlowAgentRole
  readonly session_id: string
  readonly status: FlowAgentStatus
  readonly epoch?: number | undefined
  readonly capabilities?: FlowJsonValue | undefined
  readonly cwd?: string | null | undefined
  readonly meta?: FlowJsonValue | undefined
}

/** One transaction row to insert. */
interface TransactionInsert {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly owner_management_id: string
  readonly parent_transaction_id?: string | null | undefined
  readonly objective: string
  readonly inputs?: FlowJsonValue | undefined
  readonly constraints?: FlowJsonValue | undefined
  readonly expected_output?: string | undefined
  readonly acceptance_criteria?: FlowJsonValue | undefined
  readonly needs?: FlowJsonValue | undefined
  readonly priority?: number | undefined
  readonly capabilities?: FlowJsonValue | undefined
  readonly status?: FlowTransactionStatus | undefined
  readonly result?: FlowJsonValue | undefined
  readonly result_revision?: number | null | undefined
  readonly validation?: FlowJsonValue | undefined
}

/** One allocation row to insert. */
interface AllocationInsert {
  readonly id: string
  readonly cluster_id: string
  readonly node_id: string
  readonly agent_id: string
  readonly transaction_id?: string | null | undefined
  readonly capabilities?: FlowJsonValue | undefined
  readonly write_scope?: FlowJsonValue | undefined
  readonly write_scope_canonical?: FlowJsonValue | undefined
  readonly status?: FlowAllocationStatus | undefined
}

/** One lease row to insert. */
interface LeaseInsert {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id: string
  readonly purpose?: string | undefined
  readonly epoch: number
  readonly expires: number
  readonly event_upper_bound?: number | undefined
}

/** One inbox row to insert. */
interface InboxInsert {
  readonly id?: string | undefined
  readonly cluster_id: string
  readonly recipient: string
  readonly subject: string
  readonly payload?: FlowJsonValue | undefined
  readonly coalesce_key?: string | null | undefined
  readonly dedupe_key?: string | null | undefined
}

/** One budget row to insert. */
interface BudgetInsert {
  readonly id: string
  readonly cluster_id: string
  readonly scope_kind: FlowScopeKind
  readonly scope_id: string
  readonly node_id?: string | null | undefined
  readonly parent_budget_id?: string | null | undefined
  readonly tool_calls_limit?: number | undefined
  readonly tool_calls_reserved?: number | undefined
  readonly tool_calls_spent?: number | undefined
  readonly wall_limit_ms?: number | undefined
  readonly wall_deadline?: number | null | undefined
  readonly agents_limit?: number | undefined
  readonly agents_reserved?: number | undefined
  readonly max_active_limit?: number | undefined
  readonly max_active_reserved?: number | undefined
}

/** One message row to insert. */
interface MessageInsert {
  readonly id: string
  readonly cluster_id: string
  readonly from_agent?: string | null | undefined
  readonly from_node?: string | null | undefined
  readonly kind: string
  readonly content: FlowJsonValue
}

/** One communication group to insert. */
interface GroupInsert {
  readonly id: string
  readonly cluster_id: string
  readonly name: string
}

/** One subscription to insert. */
interface SubscriptionInsert {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly pattern: string
  readonly mode: string
  readonly cursor?: string | null | undefined
}

/** One checkpoint to insert. */
interface CheckpointInsert {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly session_id: string
  readonly flushed_seq?: number | null | undefined
  readonly events_seq?: number | null | undefined
  readonly transaction_id?: string | null | undefined
  readonly transaction_revision?: number | null | undefined
  readonly inbox_ack_cursor?: string | null | undefined
  readonly usage_watermark?: number | null | undefined
  readonly turn_seq?: number | null | undefined
  readonly data?: FlowJsonValue | undefined
}

/** One summary to insert. */
interface SummaryInsert {
  readonly id: string
  readonly cluster_id: string
  readonly node_id?: string | null | undefined
  readonly transaction_id?: string | null | undefined
  readonly as_of_seq?: number | undefined
  readonly data: FlowJsonValue
}

/** One durable effect receipt to insert. */
interface EffectInsert {
  readonly call_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id?: string | null | undefined
  readonly lease_epoch: number
  readonly session_id?: string | null | undefined
  readonly turn_seq?: number | null | undefined
  readonly tool: string
  readonly args?: FlowJsonValue | undefined
  readonly status?: FlowEffectStatus | undefined
  readonly body?: FlowJsonValue | undefined
  readonly error?: string | null | undefined
  readonly job_id?: string | null | undefined
}

/** One effect settlement patch. */
interface EffectSettlement {
  readonly status?: FlowEffectStatus | undefined
  readonly body?: FlowJsonValue | undefined
  readonly error?: string | null | undefined
  readonly job_id?: string | null | undefined
}

/** One tool-call admission receipt to insert. */
interface ToolCallReceiptInsert {
  readonly call_id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly session_id?: string | null | undefined
  readonly turn_seq?: number | null | undefined
  readonly tool: string
  readonly args_hash: string
  readonly command_id?: string | null | undefined
  readonly budget_scope_id?: string | null | undefined
  readonly dispatch_status?: FlowDispatchStatus | undefined
  readonly result_body?: string | null | undefined
  readonly error?: string | null | undefined
}

/** One tool-call receipt settlement patch. */
interface ToolCallSettlement {
  readonly dispatch_status?: FlowDispatchStatus | undefined
  readonly result_body?: string | null | undefined
  readonly error?: string | null | undefined
}

/** One health evaluation to insert. */
interface HealthInsert {
  readonly id: string
  readonly cluster_id: string
  readonly node_id?: string | null | undefined
  readonly evaluation_window?: string | null | undefined
  readonly signals?: FlowJsonValue | undefined
  readonly scores?: FlowJsonValue | undefined
  readonly weights?: FlowJsonValue | undefined
  readonly decided?: boolean | undefined
  readonly decided_by?: string | null | undefined
}

/** One source receipt to insert. */
interface SourceInsert {
  readonly id: string
  readonly cluster_id: string
  readonly agent_id: string
  readonly node_id?: string | null | undefined
  readonly transaction_id?: string | null | undefined
  readonly request_url: string
  readonly final_url: string
  readonly status_code?: number | null | undefined
  readonly fetched_at: number
  readonly hash: string
  readonly bytes: number
  readonly text: string
}

/** One audit gate to insert. */
interface AuditInsert {
  readonly id: string
  readonly cluster_id: string
  readonly transaction_id: string
  readonly node_id: string
  readonly kind: FlowAuditKind
  readonly target_revision: number
  readonly decision?: FlowAuditDecision | undefined
  readonly auditor_agent_id?: string | null | undefined
  readonly evidence?: FlowJsonValue | undefined
}

/** One issue to insert. */
interface IssueInsert {
  readonly id: string
  readonly cluster_id: string
  /** The node the issue is about, or `null` for an issue raised by an actor with no node (the host user). */
  readonly node_id: string | null
  readonly transaction_id?: string | null | undefined
  readonly reporter_agent_id?: string | null | undefined
  readonly target_revision?: number | undefined
  readonly severity?: string | undefined
  readonly evidence?: FlowJsonValue | undefined
  readonly required_change?: string | undefined
}

/** The issue keys a correction may change. */
interface IssueUpdate {
  readonly status?: FlowIssueStatus | undefined
  readonly severity?: string | undefined
  readonly required_change?: string | undefined
  readonly corrections?: number | undefined
  readonly target_revision?: number | undefined
  readonly reviewed_revision?: number | null | undefined
  readonly evidence?: FlowJsonValue | undefined
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clusters(
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, workspace TEXT NOT NULL,
  capabilities TEXT NOT NULL, limits TEXT NOT NULL, budget TEXT NOT NULL,
  spec TEXT NOT NULL, declared_limits TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_runs(
  run_id TEXT PRIMARY KEY REFERENCES clusters(id), main_session_id TEXT NOT NULL,
  intent_id TEXT NOT NULL, UNIQUE(main_session_id,intent_id));
CREATE INDEX IF NOT EXISTS team_runs_session ON team_runs(main_session_id);
CREATE TABLE IF NOT EXISTS team_observations(
  run_id TEXT NOT NULL REFERENCES clusters(id), agent_id TEXT NOT NULL,
  ended INTEGER, state TEXT, PRIMARY KEY(run_id,agent_id));
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
  depth INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  scope TEXT NOT NULL, capabilities TEXT NOT NULL, owner_management_id TEXT,
  delegated_transaction_id TEXT, max_children INTEGER, path TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(cluster_id,parent_id);
CREATE INDEX IF NOT EXISTS nodes_status ON nodes(cluster_id,status);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL,
  session_id TEXT NOT NULL, status TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0, stagnation INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL, cwd TEXT, meta TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agents_node ON agents(cluster_id,node_id,role);
CREATE INDEX IF NOT EXISTS agents_status ON agents(cluster_id,status);
CREATE TABLE IF NOT EXISTS transactions(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL,
  owner_management_id TEXT NOT NULL, parent_transaction_id TEXT,
  objective TEXT NOT NULL, inputs TEXT NOT NULL, constraints TEXT NOT NULL,
  expected_output TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, needs TEXT NOT NULL,
  priority INTEGER NOT NULL, capabilities TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
  result_revision INTEGER, validation TEXT, plan_approved_revision INTEGER,
  result_staged_epoch INTEGER, result_staged_turn INTEGER, result_staged_agent TEXT,
  pre_pause_status TEXT, pre_pause_revision INTEGER,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS transactions_owner ON transactions(cluster_id,node_id,status);
CREATE INDEX IF NOT EXISTS transactions_status ON transactions(cluster_id,status);
CREATE INDEX IF NOT EXISTS transactions_parent ON transactions(cluster_id,parent_transaction_id);
CREATE INDEX IF NOT EXISTS transactions_ready ON transactions(cluster_id,status,priority,created,id);
CREATE TABLE IF NOT EXISTS dependencies(
  transaction_id TEXT NOT NULL, depends_on TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(transaction_id, depends_on));
CREATE INDEX IF NOT EXISTS dependencies_dep ON dependencies(depends_on);
CREATE TABLE IF NOT EXISTS allocations(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  transaction_id TEXT, capabilities TEXT NOT NULL, write_scope TEXT NOT NULL,
  write_scope_canonical TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS allocations_tx ON allocations(transaction_id);
CREATE INDEX IF NOT EXISTS allocations_agent ON allocations(agent_id);
CREATE TABLE IF NOT EXISTS leases(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT NOT NULL,
  purpose TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL,
  event_upper_bound INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leases_agent ON leases(agent_id);
CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_cluster ON events(cluster_id,seq);
CREATE TABLE IF NOT EXISTS commands(
  command_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  hash TEXT NOT NULL, revision INTEGER, result TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commands_cluster ON commands(cluster_id,at);
CREATE TABLE IF NOT EXISTS inbox(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, coalesce_key TEXT, dedupe_key TEXT,
  created INTEGER NOT NULL, consumed INTEGER);
CREATE INDEX IF NOT EXISTS inbox_recipient ON inbox(cluster_id,recipient,status);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe ON inbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS budgets(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  node_id TEXT, parent_budget_id TEXT,
  tool_calls_limit INTEGER NOT NULL DEFAULT 0, tool_calls_reserved INTEGER NOT NULL DEFAULT 0, tool_calls_spent INTEGER NOT NULL DEFAULT 0,
  wall_limit_ms INTEGER NOT NULL DEFAULT 0, wall_deadline INTEGER,
  agents_limit INTEGER NOT NULL DEFAULT 0, agents_reserved INTEGER NOT NULL DEFAULT 0,
  max_active_limit INTEGER NOT NULL DEFAULT 0, max_active_reserved INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS budgets_scope ON budgets(cluster_id,scope_kind,scope_id);
CREATE INDEX IF NOT EXISTS budgets_node ON budgets(cluster_id,node_id);
CREATE TABLE IF NOT EXISTS native_session_events(
  native_session_id TEXT NOT NULL, native_seq INTEGER NOT NULL,
  cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT NOT NULL,
  transaction_id TEXT, role TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
  time INTEGER NOT NULL, PRIMARY KEY(native_session_id,native_seq));
CREATE INDEX IF NOT EXISTS native_events_cluster ON native_session_events(cluster_id,agent_id,time,native_seq);
CREATE TABLE IF NOT EXISTS native_usage_cursors(
  native_session_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  native_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_context_snapshots(
  native_session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  native_seq INTEGER NOT NULL, data TEXT NOT NULL, time INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, from_agent TEXT, from_node TEXT,
  kind TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_cluster ON messages(cluster_id,created);
CREATE TABLE IF NOT EXISTS recipients(
  message_id TEXT NOT NULL, recipient TEXT NOT NULL, delivery_seq INTEGER NOT NULL,
  status TEXT NOT NULL, created INTEGER NOT NULL, acked INTEGER,
  PRIMARY KEY(message_id, recipient));
CREATE INDEX IF NOT EXISTS recipients_pending ON recipients(recipient,status);
CREATE TABLE IF NOT EXISTS counters(
  scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name ON groups(cluster_id,name);
CREATE TABLE IF NOT EXISTS group_members(
  group_id TEXT NOT NULL, agent_id TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(group_id, agent_id));
CREATE TABLE IF NOT EXISTS blackboard(
  cluster_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL,
  updated_by TEXT, updated INTEGER NOT NULL, PRIMARY KEY(cluster_id, key));
CREATE TABLE IF NOT EXISTS subscriptions(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, pattern TEXT NOT NULL,
  mode TEXT NOT NULL, active INTEGER NOT NULL, cursor TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS subscriptions_agent ON subscriptions(cluster_id,agent_id,active);
CREATE TABLE IF NOT EXISTS checkpoints(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  flushed_seq INTEGER, events_seq INTEGER, transaction_id TEXT, transaction_revision INTEGER,
  inbox_ack_cursor TEXT, usage_watermark INTEGER, turn_seq INTEGER, data TEXT NOT NULL,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_agent ON checkpoints(cluster_id,agent_id,created);
CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT, transaction_id TEXT,
  as_of_seq INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS summaries_node ON summaries(cluster_id,node_id,created);
CREATE INDEX IF NOT EXISTS summaries_tx ON summaries(cluster_id,transaction_id,created);
CREATE TABLE IF NOT EXISTS tool_call_receipts(
  call_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT,
  turn_seq INTEGER, tool TEXT NOT NULL, args_hash TEXT NOT NULL, command_id TEXT,
  budget_scope_id TEXT, dispatch_status TEXT NOT NULL, result_body TEXT, error TEXT,
  created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS tool_call_agent ON tool_call_receipts(cluster_id,agent_id,dispatch_status);
CREATE TABLE IF NOT EXISTS health(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT, evaluation_window TEXT,
  signals TEXT NOT NULL, scores TEXT NOT NULL, weights TEXT NOT NULL,
  decided INTEGER NOT NULL, decided_by TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS health_cluster ON health(cluster_id,created);
CREATE TABLE IF NOT EXISTS effects(
  call_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT,
  lease_epoch INTEGER NOT NULL, session_id TEXT, turn_seq INTEGER, tool TEXT NOT NULL,
  args TEXT NOT NULL, status TEXT NOT NULL, body TEXT, error TEXT, job_id TEXT,
  created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS effects_agent ON effects(cluster_id,agent_id,status);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT,
  transaction_id TEXT, request_url TEXT NOT NULL, final_url TEXT NOT NULL, status_code INTEGER,
  fetched_at INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sources_cluster ON sources(cluster_id,fetched_at);
CREATE TABLE IF NOT EXISTS audits(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, transaction_id TEXT NOT NULL, node_id TEXT NOT NULL,
  kind TEXT NOT NULL, target_revision INTEGER NOT NULL, decision TEXT NOT NULL,
  auditor_agent_id TEXT, evidence TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER);
CREATE INDEX IF NOT EXISTS audits_target ON audits(cluster_id,transaction_id,kind,target_revision);
CREATE TABLE IF NOT EXISTS issues(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, transaction_id TEXT,
  reporter_agent_id TEXT, target_revision INTEGER NOT NULL, severity TEXT NOT NULL,
  evidence TEXT NOT NULL, required_change TEXT NOT NULL, status TEXT NOT NULL,
  corrections INTEGER NOT NULL DEFAULT 0, reviewed_revision INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issues_status ON issues(cluster_id,status);
`;

export class ClusterStore {
  readonly path: string;
  now: () => number;
  #db: DatabaseSync;
  #stmts: Map<string, StatementSync>;
  #txDepth = 0;

  constructor(path: string, { now = nowMs }: { now?: () => number } = {}) {
    this.path = path;
    this.now = now;
    this.#db = new DatabaseSync(path);
    this.#stmts = new Map();
    try {
      this.#assertFresh();
      this.#db.exec('PRAGMA journal_mode=WAL');
      this.#db.exec('PRAGMA foreign_keys=ON');
      this.#db.exec('PRAGMA busy_timeout=5000');
      this.#db.exec(SCHEMA);
      this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #assertFresh(): void {
    const version = numOf(this.#db.prepare('PRAGMA user_version').get()?.user_version, 'user_version');
    const names = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(row => textOf(row.name, 'table name'));
    if ((version !== 0 && version !== SCHEMA_VERSION) || (version === 0 && names.length > 0)) {
      fail(`cluster database schema ${version} is not the current resource contract ${SCHEMA_VERSION}; use a new dataDir (existing data is left untouched)`, 409);
    }
    if (version === SCHEMA_VERSION && names.length > 0) {
      // The current version must already be self-contained; opening it must
      // never repair an old or partially upgraded contract with CREATE/ALTER.
      const expected = new DatabaseSync(':memory:');
      try {
        expected.exec(SCHEMA);
        const tables = expected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        for (const entry of tables) {
          const table = textOf(entry.name, 'table name');
          const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all().map(row => textOf(row.name, 'column name'));
          const required = expected.prepare(`PRAGMA table_info(${table})`).all().map(row => textOf(row.name, 'column name'));
          if (columns.length !== required.length || required.some(column => !columns.includes(column))) {
            fail(`cluster database does not contain the current schema ${SCHEMA_VERSION} contract; use a new dataDir (existing data is left untouched)`, 409);
          }
        }
        if (names.includes('usage_receipts')) fail('old model receipts are not the current resource contract; use a new dataDir (existing data is left untouched)', 409);
      } finally { expected.close(); }
    }
  }

  close(): void {
    this.#stmts.clear();
    this.#db.close();
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * SQLite binds `null`, never `undefined`; a model-supplied hole in an
   * argument list must not turn into a driver-level crash.
   */
  #bind(args: readonly BindValue[]): SQLInputValue[] {
    return args.map(value => (value === undefined ? null : value));
  }

  run(sql: string, ...args: BindValue[]): StatementResultingChanges {
    return this.#stmt(sql).run(...this.#bind(args));
  }

  all(sql: string, ...args: BindValue[]): Row[] {
    return this.#stmt(sql).all(...this.#bind(args));
  }

  get(sql: string, ...args: BindValue[]): Row | undefined {
    return this.#stmt(sql).get(...this.#bind(args));
  }

  /** Whether a truthy value carries a callable `then`, exactly like `Promise` resolution. */
  #callSync<T>(fn: () => T): T {
    // Refuse declared async callbacks before they can start IO or schedule a
    // continuation. A promise-returning synchronous callback is also invalid;
    // its synchronous writes are rolled back by the owning transaction.
    if (isAsyncFunction(fn)) fail('Store callbacks must be synchronous');
    const value = fn();
    if (isThenable(value)) {
      if (isPromise(value)) value.catch(() => {});
      fail('Store callbacks must be synchronous');
    }
    return value;
  }

  /**
   * Run synchronous work atomically. Nested callers own a savepoint, so a
   * caught inner failure cannot leave half of that operation in the outer
   * commit. A successful inner operation still rolls back with its caller.
   */
  tx<T>(fn: () => T): T {
    const savepoint = this.#txDepth > 0 ? `cluster_store_tx_${this.#txDepth}` : null;
    this.#db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#txDepth += 1;
    try {
      const value = this.#callSync(fn);
      this.#db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      try {
        if (savepoint) {
          this.#db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else this.#db.exec('ROLLBACK');
      } catch {
        /* connection already unwound */
      }
      throw error;
    } finally {
      this.#txDepth -= 1;
    }
  }

  /** Whether a write transaction is currently open on this connection. */
  get inTransaction(): boolean {
    return this.#txDepth > 0;
  }

  // ---------------------------------------------------------------- clusters

  createCluster(spec: ClusterInsert, budget: FlowBudgetInput): ClusterRecord | null {
    const id = spec.id ?? randomUUID();
    const at = this.now();
    this.run(
      `INSERT INTO clusters(id,objective,workspace,capabilities,limits,budget,spec,declared_limits,status,revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, spec.objective, spec.workspace, j(spec.capabilities), j(spec.limits), j(budget), j(spec),
      j(spec.limits), 'RUNNING', 1, at, at,
    );
    return one(this.get('SELECT * FROM clusters WHERE id=?', id), decodeCluster);
  }

  getCluster(id: string): ClusterRecord | null {
    return one(this.get('SELECT * FROM clusters WHERE id=?', id), decodeCluster);
  }

  listClusters({ status, limit, offset }: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): ClusterRecord[] {
    const sql = `SELECT * FROM clusters ${status ? 'WHERE status=?' : ''} ORDER BY created, id LIMIT ? OFFSET ?`;
    const args = status ? [status, normalizeLimit(limit), offset ?? 0] : [normalizeLimit(limit), offset ?? 0];
    return this.all(sql, ...args).map(decodeCluster);
  }

  /** The limits the run declared: they are a ceiling, not a starting point. */
  declaredLimits(clusterId: string): FlowJsonValue {
    const row = this.get('SELECT limits, declared_limits FROM clusters WHERE id=?', clusterId);
    if (!row) return {};
    const declared = row.declared_limits === null || row.declared_limits === undefined
      ? '{}' : textOf(row.declared_limits, 'clusters.declared_limits');
    const limits = row.limits === null || row.limits === undefined
      ? '{}' : textOf(row.limits, 'clusters.limits');
    try {
      return jsonOf(JSON.parse(declared) ?? {}, 'clusters.declared_limits');
    } catch {
      try {
        return jsonOf(JSON.parse(limits) ?? {}, 'clusters.limits');
      } catch {
        return {};
      }
    }
  }

  updateCluster(id: string, patch: ClusterPatch): ClusterRecord | null {
    const row = this.get('SELECT revision FROM clusters WHERE id=?', id);
    if (!row) fail('Cluster not found', 404);
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of CLUSTER_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(CLUSTER_JSON_COLUMNS[key] === true ? j(value) : scalarOf(value, `clusters.${column}`));
    }
    if (!sets.length) return this.getCluster(id);
    sets.push('revision=?', 'updated=?');
    args.push(numOf(row.revision, 'clusters.revision') + 1, this.now(), id);
    this.run(`UPDATE clusters SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getCluster(id);
  }

  // ------------------------------------------------------------------ events

  appendEvent(clusterId: string, type: string, data: FlowJsonValue = {}): EventRecord {
    const at = this.now();
    const info = this.run('INSERT INTO events(cluster_id,type,data,at) VALUES(?,?,?,?)', clusterId, type, j(data), at);
    return { seq: Number(info.lastInsertRowid), cluster_id: clusterId, type, data, at };
  }

  readEvents(clusterId: string, { since = 0, limit }: { since?: number | undefined; limit?: number | undefined } = {}): StreamEventRow[] {
    const rows = this.all(
      'SELECT * FROM events WHERE cluster_id=? AND seq>? ORDER BY seq LIMIT ?',
      clusterId, integer(since, 0, Number.MAX_SAFE_INTEGER, 'since'), normalizeLimit(limit),
    );
    return rows.map(r => ({
      seq: numOf(r.seq, 'events.seq'),
      type: textOf(r.type, 'events.type'),
      data: jsonOf(p(r.data), 'events.data'),
      at: numOf(r.at, 'events.at'),
    }));
  }

  /** A reported refusal counts only when the guard recorded it for this transaction's Worker. */
  hasConfirmedWriteRefusal(clusterId: string, transactionId: string | null | undefined, evidence: unknown): boolean {
    if (!transactionId) return false;
    const source: object | null = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : null;
    const refusalSeqs: unknown = source === null ? undefined : Reflect.get(source, 'refusal_seqs');
    const seqs: unknown[] = Array.isArray(refusalSeqs) ? refusalSeqs : [source === null ? undefined : Reflect.get(source, 'refusal_seq')];
    return seqs.some(seq => typeof seq === 'number' && Number.isInteger(seq) && Boolean(this.get(
      `SELECT 1 AS present FROM events e JOIN allocations a
         ON a.cluster_id=e.cluster_id AND a.agent_id=json_extract(e.data,'$.agent_id')
        WHERE e.cluster_id=? AND e.seq=? AND e.type='write-refused'
          AND a.transaction_id=? LIMIT 1`, clusterId, seq, transactionId,
    )));
  }

  /** The latest Worker proposal preceding an issue is objective evidence of incomplete work. */
  issueHasIncompleteWorkerResult(clusterId: string, issue: IssueRecord): boolean {
    if (!issue.transaction_id) return false;
    const result = this.get(
      `SELECT json_extract(e.data,'$.result_completed') AS completed
         FROM events e
        WHERE e.cluster_id=? AND e.type='result-submitted'
          AND json_extract(e.data,'$.transaction_id')=?
          AND e.seq < (SELECT MIN(seq) FROM events opened
                        WHERE opened.cluster_id=? AND opened.type='issue-opened'
                          AND json_extract(opened.data,'$.issue_id')=?)
        ORDER BY e.seq DESC LIMIT 1`,
      clusterId, issue.transaction_id, clusterId, issue.id,
    );
    return result?.completed === 0;
  }

  /** A blocked Worker issue has a new executable grant or result, not just new prose. */
  issueHasNewWorkerEvidence(clusterId: string, issue: IssueRecord): boolean {
    if (!issue.transaction_id) return false;
    return Boolean(this.get(
      `SELECT 1 AS present FROM events e
        WHERE e.cluster_id=? AND e.seq > (
          SELECT MIN(seq) FROM events opened
           WHERE opened.cluster_id=? AND opened.type='issue-opened'
             AND json_extract(opened.data,'$.issue_id')=?
        )
          AND json_extract(e.data,'$.transaction_id')=?
          AND (e.type='agent-allocated'
            OR (e.type='result-submitted' AND json_extract(e.data,'$.result_completed') IS NOT 0))
        LIMIT 1`,
      clusterId, clusterId, issue.id, issue.transaction_id,
    ));
  }

  latestEventSeq(clusterId: string): number {
    return numOf(this.get('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=?', clusterId)?.seq, 'events.seq');
  }

  /**
   * Highest sequence of an event that represents cluster state, not scheduler
   * bookkeeping. Exhaustive by construction: it is one indexed MAX over the
   * whole event table, never a bounded page.
   */
  latestProgressSeq(clusterId: string, skipTypes: readonly string[] = []): number {
    const placeholders = skipTypes.map(() => '?').join(',');
    const sql = skipTypes.length
      ? `SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=? AND type NOT IN (${placeholders})`
      : 'SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=?';
    const row = this.get(sql, clusterId, ...skipTypes);
    return numOf(row?.seq, 'events.seq');
  }

  /** Every root transaction of a cluster, with no page limit. */
  rootTransactions(clusterId: string): TransactionRecord[] {
    return this.all('SELECT * FROM transactions WHERE cluster_id=? AND parent_transaction_id IS NULL', clusterId).map(decodeTransaction);
  }

  /** Number of transactions in a cluster, optionally restricted. */
  countTransactions(
    clusterId: string,
    { status, node_id, parent_transaction_id }: {
      status?: string | string[] | undefined
      node_id?: string | undefined
      parent_transaction_id?: string | null | undefined
    } = {},
  ): number {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status !== undefined) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (parent_transaction_id !== undefined) {
      where.push(parent_transaction_id === null ? 'parent_transaction_id IS NULL' : 'parent_transaction_id=?');
      if (parent_transaction_id !== null) args.push(parent_transaction_id);
    }
    return numOf(this.get(`SELECT COUNT(*) AS c FROM transactions WHERE ${where.join(' AND ')}`, ...args)?.c, 'transactions.count');
  }

  // ---------------------------------------------------------------- commands

  findCommand(commandId: string): CommandRecord | null {
    const row = this.get('SELECT * FROM commands WHERE command_id=?', commandId);
    if (!row) return null;
    return {
      command_id: textOf(row.command_id, 'commands.command_id'),
      cluster_id: textOf(row.cluster_id, 'commands.cluster_id'),
      actor: jsonOf(p(row.actor), 'commands.actor'),
      action: textOf(row.action, 'commands.action'),
      hash: textOf(row.hash, 'commands.hash'),
      revision: numOrNull(row.revision, 'commands.revision'),
      result: jsonOf(p(row.result), 'commands.result'),
      at: numOf(row.at, 'commands.at'),
    };
  }

  /**
   * Idempotent command execution. `apply` runs inside the same transaction that
   * records the command and its events. Synchronous only.
   */
  runCommand({ cluster_id, command_id, actor, action, params }: RunCommandInput, apply: () => CommandApplyResult): CommandReceipt {
    textField(command_id, 'command_id', 256);
    return this.tx(() => {
      const hash = canonical({ action, params: params ?? null });
      const existing = this.findCommand(command_id);
      if (existing) {
        // A command identity belongs to one cluster and authenticated actor.
        // The lease epoch is transient, so a retried turn can recover its own
        // receipt without letting another actor replay it across domains.
        const identity = (value: unknown): string => {
          const out: Record<string, unknown> = {};
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const key of ['role', 'agent_id', 'node_id']) {
              const entry: unknown = Reflect.get(value, key);
              if (entry !== undefined) out[key] = entry;
            }
          }
          return canonical(out);
        };
        if (existing.cluster_id !== cluster_id || identity(existing.actor) !== identity(actor)) {
          fail('command_id belongs to another cluster or actor', 409);
        }
        if (existing.hash !== hash) fail('command_id reused with different payload', 409);
        return { result: existing.result, revision: existing.revision, deduped: true };
      }
      const result = this.#callSync(apply);
      this.run(
        'INSERT INTO commands(command_id,cluster_id,actor,action,hash,revision,result,at) VALUES(?,?,?,?,?,?,?,?)',
        command_id, cluster_id, j(actor), action, hash, result?.revision ?? null, j(result), this.now(),
      );
      return { result, revision: result?.revision ?? null, deduped: false };
    });
  }

  // ------------------------------------------------------------------- nodes

  /**
   * A node's management owner is derived from its place in the tree, never
   * supplied: a management node owns itself, a Worker belongs to the
   * management node directly above it, and the standalone Worker of a
   * single-mode cluster has no management parent at all. This is the same
   * relation the effect queries already report, so storing anything else made
   * two readers of one fact disagree. A caller that passes a conflicting owner
   * is refused rather than silently overridden.
   */
  static nodeOwner(kind: FlowNodeKind, id: string, parentId: string | null): string | null {
    return kind === 'management' ? id : parentId ?? null;
  }

  insertNode(node: NodeInsert): NodeRecord | null {
    const at = this.now();
    const parentId = node.parent_id ?? null;
    const owner = ClusterStore.nodeOwner(node.kind, node.id, parentId);
    if (node.owner_management_id !== undefined && node.owner_management_id !== owner) {
      fail(`node ${node.id} declares owner ${String(node.owner_management_id)} but a ${node.kind} node is owned by ${String(owner)}`, 409);
    }
    this.run(
      `INSERT INTO nodes(id,cluster_id,parent_id,kind,depth,status,revision,scope,capabilities,owner_management_id,delegated_transaction_id,max_children,path,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      node.id, node.cluster_id, parentId, node.kind, node.depth, node.status, 1,
      j(node.scope ?? {}), j(node.capabilities ?? []), owner,
      node.delegated_transaction_id ?? null, node.max_children ?? null, node.path, at, at,
    );
    return one(this.get('SELECT * FROM nodes WHERE id=?', node.id), decodeNode);
  }

  getNode(id: string): NodeRecord | null {
    return one(this.get('SELECT * FROM nodes WHERE id=?', id), decodeNode);
  }

  listNodes(
    clusterId: string,
    { status, parent_id, limit }: { status?: string | undefined; parent_id?: string | null | undefined; limit?: number | undefined } = {},
  ): NodeRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    if (parent_id !== undefined) {
      where.push(parent_id === null ? 'parent_id IS NULL' : 'parent_id=?');
      if (parent_id !== null) args.push(parent_id);
    }
    args.push(normalizeLimit(limit));
    return this.all(`SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY path,id LIMIT ?`, ...args).map(decodeNode);
  }

  /** All active management roles, without the public list's page ceiling. */
  activeManagementNodes(clusterId: string): NodeRecord[] {
    return this.all(
      "SELECT * FROM nodes WHERE cluster_id=? AND status='ACTIVE' AND kind='management' ORDER BY path,id",
      clusterId,
    ).map(decodeNode);
  }

  childrenOf(nodeId: string): NodeRecord[] {
    return this.all('SELECT * FROM nodes WHERE parent_id=? ORDER BY created,id', nodeId).map(decodeNode);
  }

  updateNode(id: string, patch: NodePatch): NodeRecord | null {
    const row = this.get('SELECT revision, kind, parent_id FROM nodes WHERE id=?', id);
    if (!row) fail('Node not found', 404);
    const kind = oneOf(row.kind, NODE_KINDS, 'nodes.kind');
    // Moving a node is the one edit that can change who owns it, and the owner
    // follows the new parent deterministically. Deriving it here is what keeps
    // a reparented Worker pointing at the management node it really runs under
    // instead of the source branch it was created in.
    if (patch.parent_id !== undefined) {
      const owner = ClusterStore.nodeOwner(kind, id, patch.parent_id ?? null);
      if (patch.owner_management_id !== undefined && patch.owner_management_id !== owner) {
        fail(`node ${id} declares owner ${String(patch.owner_management_id)} but a ${kind} node moved under ${String(patch.parent_id)} is owned by ${String(owner)}`, 409);
      }
      patch = { ...patch, owner_management_id: owner };
    }
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of NODE_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(NODE_JSON_COLUMNS[key] === true ? j(value) : scalarOf(value, `nodes.${column}`));
    }
    if (!sets.length) return this.getNode(id);
    sets.push('revision=?', 'updated=?');
    args.push(numOf(row.revision, 'nodes.revision') + 1, this.now(), id);
    this.run(`UPDATE nodes SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getNode(id);
  }

  // ------------------------------------------------------------------ agents

  insertAgent(agent: AgentInsert): AgentRecord | null {
    const at = this.now();
    this.run(
      `INSERT INTO agents(id,cluster_id,node_id,role,session_id,status,epoch,turns,stagnation,capabilities,cwd,meta,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      agent.id, agent.cluster_id, agent.node_id, agent.role, agent.session_id, agent.status,
      agent.epoch ?? 0, 0, 0, j(agent.capabilities ?? []), agent.cwd ?? null, j(agent.meta ?? {}), at, at,
    );
    return one(this.get('SELECT * FROM agents WHERE id=?', agent.id), decodeAgent);
  }

  getAgent(id: string): AgentRecord | null {
    return one(this.get('SELECT * FROM agents WHERE id=?', id), decodeAgent);
  }

  getAgentBySession(sessionId: string): AgentRecord | null {
    return one(this.get('SELECT * FROM agents WHERE session_id=?', sessionId), decodeAgent);
  }

  listAgents(
    clusterId: string,
    { status, node_id, role, live, limit, offset }: {
      status?: string | string[] | undefined
      node_id?: string | undefined
      role?: string | undefined
      live?: boolean | undefined
      limit?: number | undefined
      offset?: number | undefined
    } = {},
  ): AgentRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    if (live) where.push("status<>'TERMINATED'");
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (role) {
      where.push('role=?');
      args.push(role);
    }
    args.push(normalizeLimit(limit, 200, 500), offset ?? 0);
    return this.all(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ? OFFSET ?`, ...args).map(decodeAgent);
  }

  countAgents(clusterId: string, { live = false, status }: { live?: boolean | undefined; status?: string | string[] | undefined } = {}): number {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (live) where.push("status<>'TERMINATED'");
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    return numOf(this.get(`SELECT COUNT(*) AS c FROM agents WHERE ${where.join(' AND ')}`, ...args)?.c, 'agents.count');
  }

  /** Execution evidence survives resource release and retains its original end time. */
  recordTeamEnd(agent: AgentRecord, state: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'): void {
    this.run(`INSERT INTO team_observations(run_id,agent_id,ended,state) VALUES(?,?,?,?)
      ON CONFLICT(run_id,agent_id) DO UPDATE SET state=CASE WHEN state='UNKNOWN' THEN excluded.state ELSE state END`,
      agent.cluster_id, agent.id, this.now(), state);
  }

  updateAgent(id: string, patch: AgentPatch): AgentRecord | null {
    if (patch.status && ['COMPLETED', 'FAILED', 'TERMINATED'].includes(patch.status)) {
      const previous = this.getAgent(id);
      if (previous) this.recordTeamEnd(previous, patch.status === 'TERMINATED'
        ? (previous.status === 'COMPLETED' || previous.status === 'FAILED' ? previous.status : 'UNKNOWN')
        : patch.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED');
    }
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of AGENT_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(AGENT_JSON_COLUMNS[key] === true ? j(value) : scalarOf(value, `agents.${column}`));
    }
    if (!sets.length) return this.getAgent(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE agents SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getAgent(id);
  }

  // ------------------------------------------------------------ transactions

  insertTransaction(tx: TransactionInsert): TransactionRecord | null {
    const at = this.now();
    this.run(
      `INSERT INTO transactions(id,cluster_id,node_id,owner_management_id,parent_transaction_id,objective,inputs,constraints,expected_output,acceptance_criteria,needs,priority,capabilities,status,revision,attempts,result,result_revision,validation,plan_approved_revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tx.id, tx.cluster_id, tx.node_id, tx.owner_management_id, tx.parent_transaction_id ?? null,
      tx.objective, j(tx.inputs ?? {}), j(tx.constraints ?? []), tx.expected_output ?? '',
      j(tx.acceptance_criteria ?? []), j(tx.needs ?? {}), tx.priority ?? 0, j(tx.capabilities ?? []),
      tx.status ?? 'DRAFT', 1, 0, tx.result === undefined ? null : j(tx.result), tx.result_revision ?? null,
      tx.validation === undefined ? null : j(tx.validation), null, at, at,
    );
    return one(this.get('SELECT * FROM transactions WHERE id=?', tx.id), decodeTransaction);
  }

  getTransaction(id: string): TransactionRecord | null {
    return one(this.get('SELECT * FROM transactions WHERE id=?', id), decodeTransaction);
  }

  listTransactions(
    { cluster_id, node_id, status, parent_transaction_id, limit, offset }: {
      cluster_id: string
      node_id?: string | undefined
      status?: string | string[] | undefined
      parent_transaction_id?: string | null | undefined
      limit?: number | undefined
      offset?: number | undefined
    },
  ): TransactionRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [cluster_id];
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    if (parent_transaction_id !== undefined) {
      where.push(parent_transaction_id === null ? 'parent_transaction_id IS NULL' : 'parent_transaction_id=?');
      if (parent_transaction_id !== null) args.push(parent_transaction_id);
    }
    args.push(normalizeLimit(limit), offset ?? 0);
    return this.all(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ? OFFSET ?`, ...args).map(decodeTransaction);
  }

  /** Filter by a role's subtree before applying a public page boundary. */
  transactionsForDomain(
    clusterId: string,
    { scope_node_id, node_id, parent_id, status, limit, offset = 0 }: {
      scope_node_id?: string | undefined
      node_id?: string | undefined
      parent_id?: string | null | undefined
      status?: string | string[] | undefined
      limit?: number | undefined
      offset?: number | undefined
    } = {},
  ): { items: TransactionRecord[]; total: number } {
    const scope = scope_node_id
      ? `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE cluster_id=? AND id=?
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.cluster_id=?
         ) `
      : '';
    const where = ['t.cluster_id=?'];
    const args: BindValue[] = scope_node_id ? [clusterId, scope_node_id, clusterId, clusterId] : [clusterId];
    if (scope_node_id) where.push('t.node_id IN (SELECT id FROM sub)');
    if (node_id) {
      where.push('t.node_id=?');
      args.push(node_id);
    }
    if (parent_id !== undefined) {
      where.push('t.parent_transaction_id IS ?');
      args.push(parent_id);
    }
    if (status) {
      where.push(Array.isArray(status) ? `t.status IN (${status.map(() => '?').join(',')})` : 't.status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    const filter = `FROM transactions t WHERE ${where.join(' AND ')}`;
    const total = numOf(this.get(`${scope}SELECT COUNT(*) AS c ${filter}`, ...args)?.c, 'transactions.count');
    const items = this.all(`${scope}SELECT t.* ${filter} ORDER BY t.created,t.id LIMIT ? OFFSET ?`,
      ...args, normalizeLimit(limit), offset).map(decodeTransaction);
    return { items, total };
  }

  updateTransaction(id: string, patch: TransactionPatch): TransactionRecord | null {
    const row = this.get('SELECT revision FROM transactions WHERE id=?', id);
    if (!row) fail('Transaction not found', 404);
    const sets: string[] = [];
    const args: BindValue[] = [];
    const bump = patch.__bump_revision !== false;
    for (const [key, column] of TRANSACTION_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(TRANSACTION_JSON_COLUMNS[key] === true && value !== null ? j(value) : scalarOf(value, `transactions.${column}`));
    }
    if (!sets.length) return this.getTransaction(id);
    if (bump) sets.push('revision=?'), args.push(numOf(row.revision, 'transactions.revision') + 1);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE transactions SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getTransaction(id);
  }

  // ------------------------------------------------------------ dependencies

  addDependency(transactionId: string, dependsOn: string): void {
    this.run('INSERT OR IGNORE INTO dependencies(transaction_id,depends_on,created) VALUES(?,?,?)', transactionId, dependsOn, this.now());
  }

  removeDependency(transactionId: string, dependsOn: string): void {
    this.run('DELETE FROM dependencies WHERE transaction_id=? AND depends_on=?', transactionId, dependsOn);
  }

  dependenciesOf(transactionId: string): string[] {
    return this.all('SELECT depends_on FROM dependencies WHERE transaction_id=? ORDER BY depends_on', transactionId)
      .map(r => textOf(r.depends_on, 'dependencies.depends_on'));
  }

  dependentsOf(transactionId: string): string[] {
    return this.all('SELECT transaction_id FROM dependencies WHERE depends_on=? ORDER BY transaction_id', transactionId)
      .map(r => textOf(r.transaction_id, 'dependencies.transaction_id'));
  }

  allDependencies(clusterId: string): DependencyRow[] {
    return this.all(
      'SELECT d.transaction_id,d.depends_on FROM dependencies d JOIN transactions t ON t.id=d.transaction_id WHERE t.cluster_id=?',
      clusterId,
    ).map(r => ({
      transaction_id: textOf(r.transaction_id, 'dependencies.transaction_id'),
      depends_on: textOf(r.depends_on, 'dependencies.depends_on'),
    }));
  }

  // ------------------------------------------------------------- allocations

  insertAllocation(allocation: AllocationInsert): AllocationRecord | null {
    const at = this.now();
    this.run(
      `INSERT INTO allocations(id,cluster_id,node_id,agent_id,transaction_id,capabilities,write_scope,write_scope_canonical,status,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      allocation.id, allocation.cluster_id, allocation.node_id, allocation.agent_id,
      allocation.transaction_id ?? null, j(allocation.capabilities ?? []), j(allocation.write_scope ?? []),
      j(allocation.write_scope_canonical ?? []),
      allocation.status ?? 'ACTIVE', at, at,
    );
    return one(this.get('SELECT * FROM allocations WHERE id=?', allocation.id), decodeAllocation);
  }

  getAllocation(id: string): AllocationRecord | null {
    return one(this.get('SELECT * FROM allocations WHERE id=?', id), decodeAllocation);
  }

  listAllocations(
    { cluster_id, agent_id, transaction_id, status, limit }: {
      cluster_id: string
      agent_id?: string | undefined
      transaction_id?: string | undefined
      status?: string | undefined
      limit?: number | undefined
    },
  ): AllocationRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [cluster_id];
    const filters: readonly (readonly [string, string | null | undefined])[] = [
      ['agent_id', agent_id], ['transaction_id', transaction_id], ['status', status],
    ];
    for (const [column, value] of filters) {
      if (value !== undefined && value !== null) {
        where.push(`${column}=?`);
        args.push(value);
      }
    }
    args.push(normalizeLimit(limit, 200, 500));
    return this.all(`SELECT * FROM allocations WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ?`, ...args).map(decodeAllocation);
  }

  activeAllocationForTransaction(transactionId: string): AllocationRecord | null {
    return one(this.get("SELECT * FROM allocations WHERE transaction_id=? AND status='ACTIVE' ORDER BY created DESC LIMIT 1", transactionId), decodeAllocation);
  }

  activeAllocationForAgent(agentId: string): AllocationRecord | null {
    return one(this.get("SELECT * FROM allocations WHERE agent_id=? AND status='ACTIVE' ORDER BY created DESC LIMIT 1", agentId), decodeAllocation);
  }

  /** An allocation binds to the transaction plan that existed at its grant event. */
  allocationOutdated(clusterId: string, allocation: AllocationRecord | null): boolean {
    if (!allocation?.transaction_id) return false;
    const events = this.get(
      `SELECT
         (SELECT MAX(seq) FROM events
           WHERE cluster_id=? AND type='transaction-adjusted'
             AND json_extract(data,'$.transaction_id')=?) AS revised,
         (SELECT MAX(seq) FROM events
           WHERE cluster_id=? AND type='agent-allocated'
             AND json_extract(data,'$.transaction_id')=?
             AND json_extract(data,'$.agent_id')=?) AS granted`,
      clusterId, allocation.transaction_id, clusterId, allocation.transaction_id, allocation.agent_id,
    );
    return Number(events?.revised ?? 0) > Number(events?.granted ?? 0);
  }

  updateAllocation(id: string, patch: AllocationPatch): AllocationRecord | null {
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of ALLOCATION_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(ALLOCATION_JSON_COLUMNS[key] === true ? j(value) : scalarOf(value, `allocations.${column}`));
    }
    if (!sets.length) return this.getAllocation(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE allocations SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getAllocation(id);
  }

  writeScopes(clusterId: string): WriteScopeRow[] {
    return this.all("SELECT id,agent_id,node_id,write_scope FROM allocations WHERE cluster_id=? AND status='ACTIVE'", clusterId)
      .map(r => ({
        id: textOf(r.id, 'allocations.id'),
        agent_id: textOf(r.agent_id, 'allocations.agent_id'),
        node_id: textOf(r.node_id, 'allocations.node_id'),
        write_scope: jsonOf(p(r.write_scope), 'allocations.write_scope'),
      }));
  }

  // ------------------------------------------------------------------ leases

  createLease(lease: LeaseInsert): LeaseRecord | null {
    this.run(
      'INSERT INTO leases(id,cluster_id,agent_id,node_id,purpose,epoch,expires,event_upper_bound,created) VALUES(?,?,?,?,?,?,?,?,?)',
      lease.id, lease.cluster_id, lease.agent_id, lease.node_id, lease.purpose ?? 'turn',
      lease.epoch, lease.expires, lease.event_upper_bound ?? 0, this.now(),
    );
    return one(this.get('SELECT * FROM leases WHERE id=?', lease.id), decodeLease);
  }

  getLease(id: string): LeaseRecord | null {
    return one(this.get('SELECT * FROM leases WHERE id=?', id), decodeLease);
  }

  leaseForAgent(agentId: string): LeaseRecord | null {
    return one(this.get('SELECT * FROM leases WHERE agent_id=?', agentId), decodeLease);
  }

  listLeases(clusterId: string, { expiredBefore }: { expiredBefore?: number | undefined } = {}): LeaseRecord[] {
    if (expiredBefore !== undefined) return this.all('SELECT * FROM leases WHERE cluster_id=? AND expires<=?', clusterId, expiredBefore).map(decodeLease);
    return this.all('SELECT * FROM leases WHERE cluster_id=?', clusterId).map(decodeLease);
  }

  expiredLeases(at: number): LeaseRecord[] {
    return this.all('SELECT * FROM leases WHERE expires<=?', at).map(decodeLease);
  }

  touchLease(id: string, expires: number): void {
    this.run('UPDATE leases SET expires=? WHERE id=?', expires, id);
  }

  deleteLease(id: string): void {
    this.run('DELETE FROM leases WHERE id=?', id);
  }

  // ------------------------------------------ exhaustive reads and aggregates
  //
  // Every method below answers an *exhaustive* question in SQL. Internal
  // traversal (scheduling, recovery, summaries, reports) must never take a
  // bounded page and treat it as the whole set: a page of 200 is a page of 200
  // whether or not a 201st row exists, and silently acting on the page is how a
  // large cluster loses work.

  /** Non-terminal clusters, one keyset page at a time. */
  listOpenClusters({ afterId = '', limit = 200 }: { afterId?: string | undefined; limit?: number | undefined } = {}): ClusterRecord[] {
    return this.all(
      `SELECT * FROM clusters WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') AND id > ?
       ORDER BY id LIMIT ?`, afterId, integer(limit, 1, 1000, 'limit'),
    ).map(decodeCluster);
  }

  countNodes(clusterId: string, { status, kind }: { status?: string | undefined; kind?: string | undefined } = {}): number {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) { where.push('status=?'); args.push(status); }
    if (kind) { where.push('kind=?'); args.push(kind); }
    return numOf(this.get(`SELECT COUNT(*) AS c FROM nodes WHERE ${where.join(' AND ')}`, ...args)?.c, 'nodes.count');
  }

  maxNodeDepth(clusterId: string): number {
    return numOf(this.get('SELECT COALESCE(MAX(depth),0) AS d FROM nodes WHERE cluster_id=?', clusterId)?.d, 'nodes.depth');
  }

  /** Node ids of a subtree (the whole cluster when `nodeId` is null). */
  nodesInSubtree(clusterId: string, nodeId: string | null = null): NodeRecord[] {
    if (!nodeId) return this.all('SELECT * FROM nodes WHERE cluster_id=? ORDER BY path,id', clusterId).map(decodeNode);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT n.* FROM nodes n JOIN sub ON sub.id = n.id ORDER BY n.path, n.id`, nodeId,
    ).map(decodeNode);
  }

  /** Direct children counts per node, without loading any node row. */
  subtreeSizes(clusterId: string): SubtreeSize[] {
    return this.all(
      `WITH RECURSIVE walk(ancestor, id) AS (
         SELECT parent_id, id FROM nodes WHERE cluster_id=? AND parent_id IS NOT NULL
         UNION ALL
         SELECT w.ancestor, n.id FROM nodes n JOIN walk w ON n.parent_id = w.id
       )
       SELECT ancestor AS node_id, COUNT(*) AS size FROM walk GROUP BY ancestor`, clusterId,
    ).map(r => ({ node_id: textOf(r.node_id, 'subtree.node_id'), size: numOf(r.size, 'subtree.size') }));
  }

  /** The depth-1 ancestor of every node: the management domain it belongs to. */
  domainRoots(clusterId: string): DomainRootRow[] {
    return this.all(
      `WITH RECURSIVE root_of(id, root) AS (
         SELECT id, id FROM nodes WHERE cluster_id=? AND (parent_id IS NULL OR depth = 0)
         UNION ALL
         SELECT n.id, r.root FROM nodes n JOIN root_of r ON n.parent_id = r.id WHERE n.cluster_id = ?
       )
       SELECT id, root FROM root_of`, clusterId, clusterId,
    ).map(r => ({ id: textOf(r.id, 'domain.id'), root: textOf(r.root, 'domain.root') }));
  }

  countTransactionsByStatus(clusterId: string, { nodeId = null }: { nodeId?: string | null | undefined } = {}): TransactionStatusCount[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (nodeId) { where.push('node_id=?'); args.push(nodeId); }
    return this.all(`SELECT status, COUNT(*) AS c FROM transactions WHERE ${where.join(' AND ')} GROUP BY status`, ...args)
      .map(r => ({ status: oneOf(r.status, TRANSACTION_STATUSES, 'transactions.status'), c: numOf(r.c, 'transactions.count') }));
  }

  childrenOfTransaction(clusterId: string, parentTransactionId: string): TransactionRecord[] {
    return this.all(
      'SELECT * FROM transactions WHERE cluster_id=? AND parent_transaction_id=? ORDER BY created, id',
      clusterId, parentTransactionId,
    ).map(decodeTransaction);
  }

  /** Status counts inside one subtree (the whole cluster when `nodeId` is null). */
  countTransactionsInSubtree(clusterId: string, nodeId: string | null = null): TransactionStatusCount[] {
    if (!nodeId) return this.countTransactionsByStatus(clusterId);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT t.status, COUNT(*) AS c FROM transactions t JOIN sub ON sub.id = t.node_id
        WHERE t.cluster_id=? GROUP BY t.status`, nodeId, clusterId,
    ).map(r => ({ status: oneOf(r.status, TRANSACTION_STATUSES, 'transactions.status'), c: numOf(r.c, 'transactions.count') }));
  }

  transactionsInSubtree(clusterId: string, nodeId: string | null = null, { status = null }: { status?: string | null | undefined } = {}): TransactionRecord[] {
    const where = ['t.cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) { where.push('t.status=?'); args.push(status); }
    const scope = nodeId
      ? 'AND t.node_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub)'
      : '';
    if (nodeId) args.push(nodeId);
    return this.all(`SELECT t.* FROM transactions t WHERE ${where.join(' AND ')} ${scope}`, ...args).map(decodeTransaction);
  }

  allocationsForNode(nodeId: string, { status = 'ACTIVE' }: { status?: string | undefined } = {}): AllocationRecord[] {
    return this.all('SELECT * FROM allocations WHERE node_id=? AND status=? ORDER BY created,id', nodeId, status).map(decodeAllocation);
  }

  allocationsInSubtree(clusterId: string, nodeId: string | null = null, { status = 'ACTIVE' }: { status?: string | undefined } = {}): AllocationRecord[] {
    if (!nodeId) return this.all('SELECT * FROM allocations WHERE cluster_id=? AND status=? ORDER BY created,id', clusterId, status).map(decodeAllocation);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT * FROM allocations WHERE cluster_id=? AND status=? AND node_id IN (SELECT id FROM sub)
       ORDER BY created, id`, nodeId, clusterId, status,
    ).map(decodeAllocation);
  }

  agentsInSubtree(clusterId: string, nodeId: string | null = null, { status = null, role = null }: { status?: string | null | undefined; role?: string | null | undefined } = {}): AgentRecord[] {
    const where = ['a.cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) { where.push('a.status=?'); args.push(status); }
    if (role) { where.push('a.role=?'); args.push(role); }
    const scope = nodeId
      ? 'AND a.node_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub)'
      : '';
    if (nodeId) args.push(nodeId);
    return this.all(`SELECT a.* FROM agents a WHERE ${where.join(' AND ')} ${scope} ORDER BY a.created, a.id`, ...args).map(decodeAgent);
  }

  countAgentsByRole(clusterId: string): AgentRoleCount[] {
    return this.all(
      `SELECT role, COUNT(*) AS c, SUM(CASE WHEN status<>'TERMINATED' THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN turns>0 THEN 1 ELSE 0 END) AS activated, SUM(turns) AS turns
       FROM agents WHERE cluster_id=? GROUP BY role`, clusterId,
    ).map(r => ({
      role: oneOf(r.role, AGENT_ROLES, 'agents.role'),
      c: numOf(r.c, 'agents.count'),
      live: numOf(r.live, 'agents.live'),
      activated: numOf(r.activated, 'agents.activated'),
      turns: numOf(r.turns, 'agents.turns'),
    }));
  }

  /** Every effect of a cluster in one state, with no page limit. */
  effectsAll(clusterId: string, { status = null }: { status?: string | null | undefined } = {}): EffectRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) { where.push('status=?'); args.push(status); }
    return this.all(`SELECT * FROM effects WHERE ${where.join(' AND ')} ORDER BY created`, ...args).map(decodeEffect);
  }

  /** Number of rows changed by the last `run`, for a caller that reports counts. */
  changed(): number {
    const row = this.#db.prepare('SELECT changes() AS c').get();
    return row === undefined ? 0 : numOf(row.c, 'changes');
  }

  /** Every effect call id in one state, with no page limit. */
  effectIds(clusterId: string, status: string): string[] {
    return this.all('SELECT call_id FROM effects WHERE cluster_id=? AND status=? ORDER BY created', clusterId, status)
      .map(row => textOf(row.call_id, 'effects.call_id'));
  }

  /**
   * READY transactions that already hold an ACTIVE allocation, in the order the
   * scheduler wants them. Keyset-paged on `(priority DESC, created, id)` so a
   * pass that starts turns while paging cannot skip the row a mutation pushed
   * across a page boundary.
   */
  readyForWorker(clusterId: string, { after = null, limit = 100 }: { after?: { priority: number; created: number; id: string } | null | undefined; limit?: number | undefined } = {}): TransactionRecord[] {
    const where = [
      't.cluster_id=?',
      "t.status='READY'",
      'EXISTS (SELECT 1 FROM allocations a WHERE a.transaction_id = t.id AND a.status=\'ACTIVE\')',
      // A delegated parent is always an aggregation task, not a Worker task;
      // accepting its last child must not revive a preexisting Worker grant.
      "NOT EXISTS (SELECT 1 FROM transactions c WHERE c.cluster_id=t.cluster_id AND c.parent_transaction_id=t.id)",
      // Dependencies gate Worker admission. Every dependency must be ACCEPTED;
      // pending, rejected and failed dependencies all keep the dependent queued.
      `NOT EXISTS (
         SELECT 1 FROM dependencies d
           LEFT JOIN transactions p ON p.id = d.depends_on AND p.cluster_id = t.cluster_id
          WHERE d.transaction_id = t.id
            AND (p.id IS NULL OR p.status <> 'ACCEPTED'))`,
    ];
    const args: BindValue[] = [clusterId];
    if (after) {
      where.push('(t.priority < ? OR (t.priority = ? AND (t.created > ? OR (t.created = ? AND t.id > ?))))');
      args.push(after.priority, after.priority, after.created, after.created, after.id);
    }
    args.push(integer(limit, 1, 500, 'limit'));
    return this.all(
      `SELECT t.* FROM transactions t WHERE ${where.join(' AND ')}
       ORDER BY t.priority DESC, t.created ASC, t.id ASC LIMIT ?`, ...args,
    ).map(decodeTransaction);
  }

  /**
   * Parents in one management node whose children have all been accepted
   * and whose own result has not yet been submitted. A SUBMITTED/VALIDATING
   * parent is waiting for its Auditor, not eligible for another aggregation.
   */
  aggregatableParents(clusterId: string, nodeId: string, { limit = 64 }: { limit?: number | undefined } = {}): AggregatableParent[] {
    return this.all(
      `SELECT p.id AS parent_id, COUNT(*) AS children
         FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
        WHERE c.cluster_id=? AND p.node_id=? AND p.status='READY'
        GROUP BY p.id
       HAVING SUM(CASE WHEN c.status='ACCEPTED' THEN 0 ELSE 1 END) = 0
        ORDER BY p.created, p.id LIMIT ?`, clusterId, nodeId, integer(limit, 1, 500, 'limit'),
    ).map(r => ({ parent_id: textOf(r.parent_id, 'transactions.parent_id'), children: numOf(r.children, 'transactions.children') }));
  }

  /**
   * Transactions that have delegated children still unfinished: their own work must
   * not be executed or validated while the delegation they handed out is open.
   */
  parentsAwaitingChildren(clusterId: string, nodeId: string | null = null): string[] {
    const where = ['c.cluster_id=?', "c.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED')",
      "p.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED')"];
    const args: BindValue[] = [clusterId];
    if (nodeId) {
      where.push('p.node_id=?');
      args.push(nodeId);
    }
    return this.all(
      `SELECT DISTINCT p.id AS parent_id FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
        WHERE ${where.join(' AND ')}`, ...args,
    ).map(row => textOf(row.parent_id, 'transactions.parent_id'));
  }

  /** Deliveries in one cluster, with the sender node and the recipient's node. */
  deliveryTraffic(clusterId: string): DeliveryTraffic {
    const total = numOf(this.get(
      `SELECT COUNT(*) AS c FROM recipients r JOIN messages m ON m.id=r.message_id WHERE m.cluster_id=?`, clusterId)?.c, 'deliveries.total');
    const cross = numOf(this.get(
      `WITH RECURSIVE root_of(id, root) AS (
         SELECT id, id FROM nodes WHERE cluster_id=? AND (parent_id IS NULL OR depth = 0)
         UNION ALL
         SELECT n.id, r.root FROM nodes n JOIN root_of r ON n.parent_id = r.id WHERE n.cluster_id = ?
       )
       SELECT COUNT(*) AS c
         FROM recipients rc
         JOIN messages m ON m.id = rc.message_id
         JOIN agents a ON a.id = rc.recipient
         LEFT JOIN root_of s ON s.id = m.from_node
         LEFT JOIN root_of t ON t.id = a.node_id
        WHERE m.cluster_id=? AND s.root IS NOT NULL AND t.root IS NOT NULL AND s.root <> t.root`,
      clusterId, clusterId, clusterId)?.c, 'deliveries.cross_subtree');
    return { deliveries: total, cross_subtree: cross };
  }

  /** Host-recorded context facts for orchestrators; Flow does not measure or budget their windows. */
  latestOrchestratorContext(clusterId: string): OrchestratorContextRow[] {
    return this.agentsInSubtree(clusterId, null, { role: 'orchestrator' }).map(agent => ({
      data: this.latestNativeContext(agent.id) as unknown as FlowJsonValue,
      agent_id: agent.id,
      tokens: this.latestNativeContext(agent.id).context_used,
    }));
  }

  /** Inbox rows one role received since a timestamp. */
  countInboxSince(clusterId: string, { role, since }: { role: string; since: number }): number {
    return numOf(this.get(
      `SELECT COUNT(*) AS c FROM inbox i
        WHERE i.cluster_id=? AND i.created>=?
          AND i.recipient IN (SELECT id FROM agents WHERE cluster_id=? AND role=?)`,
      clusterId, since, clusterId, role)?.c, 'inbox.count');
  }

  // ------------------------------------------------------------------ inbox

  insertInbox(item: InboxInsert): InboxRecord | null {
    const at = this.now();
    const id = item.id ?? randomUUID();
    const info = this.run(
      'INSERT OR IGNORE INTO inbox(id,cluster_id,recipient,subject,payload,status,coalesce_key,dedupe_key,created) VALUES(?,?,?,?,?,?,?,?,?)',
      id, item.cluster_id, item.recipient, item.subject, j(item.payload ?? {}), 'PENDING',
      item.coalesce_key ?? null, item.dedupe_key ?? null, at,
    );
    if (!info.changes) {
      const existing = this.get('SELECT * FROM inbox WHERE dedupe_key=?', item.dedupe_key);
      return existing ? decodeInbox(existing) : null;
    }
    if (item.coalesce_key) {
      this.run(
        "DELETE FROM inbox WHERE cluster_id=? AND recipient=? AND coalesce_key=? AND status='PENDING' AND id<>?",
        item.cluster_id, item.recipient, item.coalesce_key, id,
      );
    }
    return one(this.get('SELECT * FROM inbox WHERE id=?', id), decodeInbox);
  }

  getInbox(id: string): InboxRecord | null {
    return one(this.get('SELECT * FROM inbox WHERE id=?', id), decodeInbox);
  }

  listInbox(
    clusterId: string,
    { recipient, status = 'PENDING', limit, priority = null }: {
      recipient?: string | undefined
      status?: string | null | undefined
      limit?: number | undefined
      priority?: string | string[] | null | undefined
    } = {},
  ): InboxRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (recipient) {
      where.push('recipient=?');
      args.push(recipient);
    }
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    // Optional subject priority: the page is what a role sees, so the subjects
    // it must act on have to be inside it. Without this, a handful of older
    // informational rows (a `plan-approved` for an unrelated transaction) fill
    // every page and the later `message`/`agent-anomaly` rows behind them are
    // never shown — the page is a *window*, not a filter, so the ordering is
    // what decides who starves.
    let order = 'created,id';
    const ranked = (Array.isArray(priority) ? priority : []).filter(subject => /^[a-z][a-z0-9-]*$/.test(subject));
    if (ranked.length) {
      // Interpolated, not bound: the values are the plugin's own subject
      // constants, and the parameter order of the WHERE clause stays the
      // caller's — a bound CASE list would silently shift every argument.
      const cases = ranked.map((subject, index) => `WHEN '${subject}' THEN ${index}`).join(' ');
      order = `(CASE subject ${cases} ELSE ${ranked.length} END), created, id`;
    }
    args.push(normalizeLimit(limit, 200, 500));
    return this.all(`SELECT * FROM inbox WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...args).map(decodeInbox);
  }

  countInbox(clusterId: string, { recipient, status = 'PENDING' }: { recipient?: string | undefined; status?: string | undefined } = {}): number {
    const where = ['cluster_id=?', 'status=?'];
    const args: BindValue[] = [clusterId, status];
    if (recipient) {
      where.push('recipient=?');
      args.push(recipient);
    }
    return numOf(this.get(`SELECT COUNT(*) AS c FROM inbox WHERE ${where.join(' AND ')}`, ...args)?.c, 'inbox.count');
  }

  consumeInbox(ids: readonly string[]): void {
    for (const id of ids) this.run("UPDATE inbox SET status='CONSUMED',consumed=? WHERE id=?", this.now(), id);
  }

  /**
   * Put consumed messages back in the queue. A turn that consumed its inbox and
   * then never admitted its prompt did not answer them, and a consumed message is
   * never re-offered.
   */
  reopenInbox(ids: readonly string[]): number {
    let changed = 0;
    for (const id of ids) {
      this.run("UPDATE inbox SET status='PENDING', consumed=NULL WHERE id=? AND status='CONSUMED'", id);
      changed += this.changed();
    }
    return changed;
  }

  // ----------------------------------------------------------------- budgets

  insertBudget(budget: BudgetInsert): BudgetRecord | null {
    const at = this.now();
    this.run(
      `INSERT INTO budgets(id,cluster_id,scope_kind,scope_id,node_id,parent_budget_id,
        tool_calls_limit,tool_calls_reserved,tool_calls_spent,wall_limit_ms,wall_deadline,
        agents_limit,agents_reserved,max_active_limit,max_active_reserved,revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      budget.id, budget.cluster_id, budget.scope_kind, budget.scope_id, budget.node_id ?? null, budget.parent_budget_id ?? null,
      budget.tool_calls_limit ?? 0, budget.tool_calls_reserved ?? 0, budget.tool_calls_spent ?? 0,
      budget.wall_limit_ms ?? 0, budget.wall_deadline ?? null,
      budget.agents_limit ?? 0, budget.agents_reserved ?? 0, budget.max_active_limit ?? 0, budget.max_active_reserved ?? 0,
      1, at, at,
    );
    return one(this.get('SELECT * FROM budgets WHERE id=?', budget.id), decodeBudgetRow);
  }

  getBudget(id: string): BudgetRecord | null {
    return one(this.get('SELECT * FROM budgets WHERE id=?', id), decodeBudgetRow);
  }

  budgetForScope(clusterId: string, scopeKind: string, scopeId: string): BudgetRecord | null {
    return one(this.get('SELECT * FROM budgets WHERE cluster_id=? AND scope_kind=? AND scope_id=?', clusterId, scopeKind, scopeId), decodeBudgetRow);
  }

  listBudgets(clusterId: string, { parent_budget_id, scope_kind }: { parent_budget_id?: string | null | undefined; scope_kind?: string | undefined } = {}): BudgetRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (parent_budget_id !== undefined) {
      where.push(parent_budget_id === null ? 'parent_budget_id IS NULL' : 'parent_budget_id=?');
      if (parent_budget_id !== null) args.push(parent_budget_id);
    }
    if (scope_kind) {
      where.push('scope_kind=?');
      args.push(scope_kind);
    }
    return this.all(`SELECT * FROM budgets WHERE ${where.join(' AND ')} ORDER BY created`, ...args).map(decodeBudgetRow);
  }

  childBudgets(parentId: string): BudgetRecord[] {
    return this.all('SELECT * FROM budgets WHERE parent_budget_id=? ORDER BY created', parentId).map(decodeBudgetRow);
  }

  updateBudget(id: string, patch: BudgetPatch): BudgetRecord | null {
    const row = this.get('SELECT revision FROM budgets WHERE id=?', id);
    if (!row) fail('Budget not found', 404);
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const column of BUDGET_NUMERIC_KEYS) {
      const value = patch[column];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(value);
    }
    if (patch.parent_budget_id !== undefined) {
      sets.push('parent_budget_id=?');
      args.push(patch.parent_budget_id);
    }
    if (!sets.length) return this.getBudget(id);
    sets.push('revision=?', 'updated=?');
    args.push(numOf(row.revision, 'budgets.revision') + 1, this.now(), id);
    this.run(`UPDATE budgets SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getBudget(id);
  }

  bumpBudget(id: string, deltas: BudgetPatch, { reset = false }: { reset?: boolean } = {}): BudgetRecord | null {
    const row = this.getBudget(id);
    if (!row) fail('Budget not found', 404);
    const patch: { [K in (typeof BUDGET_NUMERIC_KEYS)[number]]?: number } = {};
    for (const column of BUDGET_NUMERIC_KEYS) {
      const delta = deltas[column];
      if (delta === undefined || delta === null) continue;
      patch[column] = reset ? delta : numOf(row[column], `budgets.${column}`) + delta;
    }
    return this.updateBudget(id, patch);
  }

  // ------------------------------------------------------ native usage facts

  /** Atomically persist host facts and advance their native session consumption cursor. */
  projectNativeUsage(input: NativeUsageProjection): number | null {
    return this.tx(() => {
      let cursor = this.nativeUsageCursor(input.nativeSessionId);
      const owner = this.get('SELECT cluster_id,agent_id FROM native_usage_cursors WHERE native_session_id=?', input.nativeSessionId);
      if (owner && (owner.cluster_id !== input.clusterId || owner.agent_id !== input.agentId)) {
        fail('Native session usage belongs to another cluster or identity', 409);
      }
      for (const event of input.events) {
        integer(event.seq, 0, Number.MAX_SAFE_INTEGER, 'native event seq');
        const existing = this.get('SELECT type,data,time FROM native_session_events WHERE native_session_id=? AND native_seq=?', input.nativeSessionId, event.seq);
        if (existing) {
          if (existing.type !== event.type || canonical(p(existing.data)) !== canonical(event.data) || existing.time !== event.time) {
            fail('Native event replay changed an already projected fact', 409);
          }
          continue;
        }
        if (event.seq !== (cursor === null ? 0 : cursor + 1)) fail('Native usage projection requires contiguous event replay', 409);
        this.run(`INSERT INTO native_session_events(native_session_id,native_seq,cluster_id,agent_id,node_id,transaction_id,role,type,data,time)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, input.nativeSessionId, event.seq, input.clusterId, input.agentId, input.nodeId,
          input.transactionId ?? null, input.role, event.type, j(event.data), event.time);
        cursor = event.seq;
      }
      if (cursor !== null) this.run(`INSERT INTO native_usage_cursors(native_session_id,cluster_id,agent_id,native_seq) VALUES(?,?,?,?)
        ON CONFLICT(native_session_id) DO UPDATE SET native_seq=excluded.native_seq`, input.nativeSessionId, input.clusterId, input.agentId, cursor);
      if (input.contextSnapshot) {
        const snapshot = input.contextSnapshot;
        integer(snapshot.nativeSeq, 0, Number.MAX_SAFE_INTEGER, 'native context seq');
        if (cursor === null || snapshot.nativeSeq > cursor) fail('Native context snapshot is ahead of durable usage facts', 409);
        const time = numOf(this.get('SELECT time FROM native_session_events WHERE native_session_id=? AND native_seq=?', input.nativeSessionId, snapshot.nativeSeq)?.time, 'native context time');
        this.run(`INSERT INTO native_context_snapshots(native_session_id,agent_id,native_seq,data,time) VALUES(?,?,?,?,?)
          ON CONFLICT(native_session_id) DO UPDATE SET native_seq=excluded.native_seq,data=excluded.data,time=excluded.time
          WHERE excluded.native_seq >= native_context_snapshots.native_seq`, input.nativeSessionId, input.agentId, snapshot.nativeSeq, j(snapshot), time);
      }
      return cursor;
    });
  }

  nativeUsageCursor(nativeSessionId: string): number | null {
    return numOrNull(this.get('SELECT native_seq FROM native_usage_cursors WHERE native_session_id=?', nativeSessionId)?.native_seq, 'native usage cursor');
  }

  nativeEventsForAgent(agentId: string): NativeSessionFact[] {
    return this.all('SELECT * FROM native_session_events WHERE agent_id=? ORDER BY native_session_id,native_seq', agentId).map(decodeNativeFact);
  }

  latestNativeContext(agentId: string): FlowNativeContext {
    const context = nativeContext(this.nativeEventsForAgent(agentId));
    const row = this.get('SELECT * FROM native_context_snapshots WHERE agent_id=? ORDER BY time DESC,native_seq DESC LIMIT 1', agentId);
    if (!row) return context;
    const snapshot = objectField(p(row.data), 'native context snapshot');
    const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const current = row.native_seq === this.nativeUsageCursor(textOf(row.native_session_id, 'native snapshot session'));
    return {
      ...context,
      // A snapshot that predates the consumed tail describes an older surface.
      context_used: current ? count(snapshot.projectedTokens) ?? count(snapshot.pressureTokens) : null,
      context_limit: context.context_limit ?? (current ? count(snapshot.contextWindow) : null),
    };
  }

  usageEventsForDomain(clusterId: string, { scope_node_id, nodeIds, agent_id, agentId, limit, offset = 0 }: {
    scope_node_id?: string | undefined; nodeIds?: readonly string[] | undefined;
    agent_id?: string | undefined; agentId?: string | undefined; limit?: number | undefined; offset?: number | undefined;
  } = {}): { items: FlowUsageEvent[]; total: number } {
    const facts = this.#usageFacts(clusterId, scope_node_id, agent_id ?? agentId, nodeIds);
    const events = nativeUsageEvents(facts);
    return { items: events.slice(offset, offset + normalizeLimit(limit)), total: events.length };
  }

  usageSummary(clusterId: string, { nodeId = null, agentId = null }: {
    nodeId?: string | null | undefined; agentId?: string | null | undefined;
  } = {}): FlowUsageSummary {
    return summarizeNativeUsage(this.#usageFacts(clusterId, nodeId ?? undefined, agentId ?? undefined));
  }

  #usageFacts(clusterId: string, nodeId?: string, agentId?: string, nodeIds?: readonly string[]): NativeSessionFact[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (nodeId) {
      where.push(`node_id IN (WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE cluster_id=? AND id=?
        UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.cluster_id=?) SELECT id FROM sub)`);
      args.push(clusterId, nodeId, clusterId);
    }
    if (nodeIds) {
      if (nodeIds.length === 0) return [];
      where.push(`node_id IN (${nodeIds.map(() => '?').join(',')})`);
      args.push(...nodeIds);
    }
    if (agentId) { where.push('agent_id=?'); args.push(agentId); }
    return this.all(`SELECT * FROM native_session_events WHERE ${where.join(' AND ')} ORDER BY native_session_id,native_seq`, ...args).map(decodeNativeFact);
  }

  // ------------------------------------------------- messages and recipients

  insertMessage(message: MessageInsert): string {
    this.run('INSERT INTO messages(id,cluster_id,from_agent,from_node,kind,content,created) VALUES(?,?,?,?,?,?,?)',
      message.id, message.cluster_id, message.from_agent ?? null, message.from_node ?? null, message.kind, j(message.content), this.now());
    return message.id;
  }

  getMessage(id: string): MessageRecord | null {
    return one(this.get('SELECT * FROM messages WHERE id=?', id), decodeMessage);
  }

  insertRecipient(messageId: string, recipient: string): number {
    const seq = this.nextCounter(`recipient:${recipient}`);
    this.run('INSERT INTO recipients(message_id,recipient,delivery_seq,status,created) VALUES(?,?,?,?,?)',
      messageId, recipient, seq, 'PENDING', this.now());
    return seq;
  }

  pendingDeliveries(agentId: string): PendingDeliveryRow[] {
    return this.all(
      "SELECT r.*,m.content,m.from_agent,m.from_node,m.kind,m.created AS message_created FROM recipients r JOIN messages m ON m.id=r.message_id WHERE r.recipient=? AND r.status='PENDING' ORDER BY r.delivery_seq",
      agentId,
    ).map(r => ({
      message_id: textOf(r.message_id, 'recipients.message_id'),
      recipient: textOf(r.recipient, 'recipients.recipient'),
      delivery_seq: numOrNull(r.delivery_seq, 'recipients.delivery_seq'),
      status: oneOf(r.status, DELIVERY_STATUSES, 'recipients.status'),
      acked: numOrNull(r.acked, 'recipients.acked'),
      created: numOf(r.created, 'recipients.created'),
      content: textOf(r.content, 'messages.content'),
      from_agent: textOrNull(r.from_agent, 'messages.from_agent'),
      from_node: textOrNull(r.from_node, 'messages.from_node'),
      kind: textOf(r.kind, 'messages.kind'),
      message_created: numOf(r.message_created, 'messages.created'),
    }));
  }

  deliveryFor(messageId: string, recipient: string): RecipientRecord | null {
    return one(this.get('SELECT * FROM recipients WHERE message_id=? AND recipient=?', messageId, recipient), decodeRecipient);
  }

  ackDelivery(messageId: string, recipient: string): void {
    this.run("UPDATE recipients SET status='ACKED',acked=? WHERE message_id=? AND recipient=? AND status<>'ACKED'", this.now(), messageId, recipient);
  }

  markDeliveryInjected(messageId: string, recipient: string): void {
    this.run("UPDATE recipients SET status='DELIVERED' WHERE message_id=? AND recipient=? AND status='PENDING'", messageId, recipient);
  }

  counter(name: string): number {
    const row = this.get('SELECT value FROM counters WHERE scope=?', name);
    return row === undefined ? 0 : numOf(row.value, 'counters.value');
  }

  nextCounter(name: string): number {
    this.run('INSERT INTO counters(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1', name);
    return numOf(this.get('SELECT value FROM counters WHERE scope=?', name)?.value, 'counters.value');
  }

  // ---------------------------------------------------------------- groups

  insertGroup(group: GroupInsert): GroupRecord | null {
    this.run('INSERT INTO groups(id,cluster_id,name,status,created,updated) VALUES(?,?,?,?,?,?)',
      group.id, group.cluster_id, group.name, 'OPEN', this.now(), this.now());
    return one(this.get('SELECT * FROM groups WHERE id=?', group.id), decodeGroup);
  }

  getGroup(id: string): GroupRecord | null {
    return one(this.get('SELECT * FROM groups WHERE id=?', id), decodeGroup);
  }

  groupByName(clusterId: string, name: string): GroupRecord | null {
    return one(this.get('SELECT * FROM groups WHERE cluster_id=? AND name=?', clusterId, name), decodeGroup);
  }

  listGroups(clusterId: string): GroupRecord[] {
    return this.all('SELECT * FROM groups WHERE cluster_id=? ORDER BY created', clusterId).map(decodeGroup);
  }

  updateGroup(id: string, patch: GroupPatch): GroupRecord | null {
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of GROUP_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(value);
    }
    if (!sets.length) return this.getGroup(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE groups SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getGroup(id);
  }

  addGroupMember(groupId: string, agentId: string): void {
    this.run('INSERT OR IGNORE INTO group_members(group_id,agent_id,created) VALUES(?,?,?)', groupId, agentId, this.now());
  }

  removeGroupMember(groupId: string, agentId: string): void {
    this.run('DELETE FROM group_members WHERE group_id=? AND agent_id=?', groupId, agentId);
  }

  groupMembers(groupId: string): string[] {
    return this.all('SELECT agent_id FROM group_members WHERE group_id=? ORDER BY created', groupId)
      .map(r => textOf(r.agent_id, 'group_members.agent_id'));
  }

  groupsOfAgent(agentId: string): GroupRecord[] {
    return this.all('SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.agent_id=?', agentId).map(decodeGroup);
  }

  // ------------------------------------------------------------ blackboard

  blackboardEntry(clusterId: string, key: string): BlackboardRecord | null {
    return one(this.get('SELECT * FROM blackboard WHERE cluster_id=? AND key=?', clusterId, key), decodeBlackboard);
  }

  blackboardList(clusterId: string, prefix: string | null): BlackboardRecord[] {
    // Match the same literal, case-sensitive prefix used for notifications.
    if (prefix) return this.all('SELECT * FROM blackboard WHERE cluster_id=? AND instr(key,?)=1 ORDER BY key', clusterId, prefix).map(decodeBlackboard);
    return this.all('SELECT * FROM blackboard WHERE cluster_id=? ORDER BY key', clusterId).map(decodeBlackboard);
  }

  setBlackboard(clusterId: string, key: string, value: FlowJsonValue, expectedRevision: number | null | undefined, updatedBy: string | null | undefined): BlackboardRecord | null {
    const row = this.blackboardEntry(clusterId, key);
    if (!row) {
      this.run('INSERT INTO blackboard(cluster_id,key,value,revision,updated_by,updated) VALUES(?,?,?,?,?,?)',
        clusterId, key, j(value), 1, updatedBy ?? null, this.now());
      return this.blackboardEntry(clusterId, key);
    }
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== row.revision) {
      fail(`blackboard revision conflict: expected ${expectedRevision}, current ${row.revision}`, 409);
    }
    this.run('UPDATE blackboard SET value=?,revision=?,updated_by=?,updated=? WHERE cluster_id=? AND key=?',
      j(value), row.revision + 1, updatedBy ?? null, this.now(), clusterId, key);
    return this.blackboardEntry(clusterId, key);
  }

  // ---------------------------------------------------------- subscriptions

  insertSubscription(sub: SubscriptionInsert): SubscriptionRecord | null {
    this.run('INSERT INTO subscriptions(id,cluster_id,agent_id,pattern,mode,active,cursor,created) VALUES(?,?,?,?,?,?,?,?)',
      sub.id, sub.cluster_id, sub.agent_id, sub.pattern, sub.mode, 1, sub.cursor ?? null, this.now());
    return one(this.get('SELECT * FROM subscriptions WHERE id=?', sub.id), decodeSubscription);
  }

  listSubscriptions(clusterId: string, { agent_id, active }: { agent_id?: string | undefined; active?: boolean | undefined } = {}): SubscriptionRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (agent_id) {
      where.push('agent_id=?');
      args.push(agent_id);
    }
    if (active !== undefined) {
      where.push('active=?');
      args.push(active ? 1 : 0);
    }
    return this.all(`SELECT * FROM subscriptions WHERE ${where.join(' AND ')} ORDER BY created`, ...args).map(decodeSubscription);
  }

  setSubscriptionActive(id: string, active: boolean): SubscriptionRecord | null {
    this.run('UPDATE subscriptions SET active=? WHERE id=?', active ? 1 : 0, id);
    return one(this.get('SELECT * FROM subscriptions WHERE id=?', id), decodeSubscription);
  }

  // ------------------------------------------------------------- checkpoints

  insertCheckpoint(checkpoint: CheckpointInsert): CheckpointRecord | null {
    this.run(
      `INSERT INTO checkpoints(id,cluster_id,agent_id,session_id,flushed_seq,events_seq,transaction_id,transaction_revision,inbox_ack_cursor,usage_watermark,turn_seq,data,created)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      checkpoint.id, checkpoint.cluster_id, checkpoint.agent_id, checkpoint.session_id,
      checkpoint.flushed_seq ?? null, checkpoint.events_seq ?? null,
      checkpoint.transaction_id ?? null, checkpoint.transaction_revision ?? null,
      checkpoint.inbox_ack_cursor ?? null, checkpoint.usage_watermark ?? null, checkpoint.turn_seq ?? null,
      j(checkpoint.data ?? {}), this.now(),
    );
    return one(this.get('SELECT * FROM checkpoints WHERE id=?', checkpoint.id), decodeCheckpoint);
  }

  getCheckpoint(id: string): CheckpointRecord | null {
    return one(this.get('SELECT * FROM checkpoints WHERE id=?', id), decodeCheckpoint);
  }

  latestCheckpoint(clusterId: string, agentId: string): CheckpointRecord | null {
    return one(this.get('SELECT * FROM checkpoints WHERE cluster_id=? AND agent_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, agentId), decodeCheckpoint);
  }

  listCheckpoints(clusterId: string, { limit }: { limit?: number | undefined } = {}): CheckpointRecord[] {
    return this.all('SELECT * FROM checkpoints WHERE cluster_id=? ORDER BY created DESC LIMIT ?', clusterId, normalizeLimit(limit, 100, 500)).map(decodeCheckpoint);
  }

  deleteCheckpointsAfter(clusterId: string, agentId: string, checkpointId: string): void {
    this.run('DELETE FROM checkpoints WHERE cluster_id=? AND agent_id=? AND id<>?', clusterId, agentId, checkpointId);
  }

  // --------------------------------------------------------------- summaries

  insertSummary(summary: SummaryInsert): SummaryRecord | null {
    this.run('INSERT INTO summaries(id,cluster_id,node_id,transaction_id,as_of_seq,data,created) VALUES(?,?,?,?,?,?,?)',
      summary.id, summary.cluster_id, summary.node_id ?? null, summary.transaction_id ?? null,
      summary.as_of_seq ?? 0, j(summary.data), this.now());
    return one(this.get('SELECT * FROM summaries WHERE id=?', summary.id), decodeSummary);
  }

  latestSummary(clusterId: string, { node_id, transaction_id }: { node_id?: string | null | undefined; transaction_id?: string | null | undefined } = {}): SummaryRecord | null {
    const row = transaction_id
      ? this.get('SELECT * FROM summaries WHERE cluster_id=? AND transaction_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, transaction_id)
      : this.get('SELECT * FROM summaries WHERE cluster_id=? AND node_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, node_id);
    return row ? decodeSummary(row) : null;
  }

  listSummaries(clusterId: string, { node_id, transaction_id, limit }: { node_id?: string | undefined; transaction_id?: string | undefined; limit?: number | undefined } = {}): SummaryRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (transaction_id) {
      where.push('transaction_id=?');
      args.push(transaction_id);
    }
    args.push(normalizeLimit(limit, 100, 500));
    return this.all(`SELECT * FROM summaries WHERE ${where.join(' AND ')} ORDER BY created DESC LIMIT ?`, ...args).map(decodeSummary);
  }

  // ----------------------------------------------------------------- effects

  insertEffect(effect: EffectInsert): EffectRecord | null {
    this.run(
      `INSERT INTO effects(call_id,cluster_id,agent_id,node_id,lease_epoch,session_id,turn_seq,tool,args,status,body,error,job_id,created,settled)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      effect.call_id, effect.cluster_id, effect.agent_id, effect.node_id ?? null, effect.lease_epoch,
      effect.session_id ?? null, effect.turn_seq ?? null, effect.tool, j(effect.args ?? {}),
      effect.status ?? 'STARTED', effect.body === undefined ? null : j(effect.body), effect.error ?? null,
      effect.job_id ?? null, this.now(), null,
    );
    return one(this.get('SELECT * FROM effects WHERE call_id=?', effect.call_id), decodeEffect);
  }

  getEffect(callId: string): EffectRecord | null {
    return one(this.get('SELECT * FROM effects WHERE call_id=?', callId), decodeEffect);
  }

  settleEffect(callId: string, settlement: EffectSettlement): EffectRecord | null {
    const row = this.getEffect(callId);
    if (!row) fail('Effect receipt not found', 404);
    const sets = ['status=?', 'settled=?'];
    const args: BindValue[] = [settlement.status ?? 'SETTLED', this.now()];
    for (const column of EFFECT_SETTLEMENT_COLUMNS) {
      const value = settlement[column];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(column === 'body' && value !== null ? j(value) : scalarOf(value, `effects.${column}`));
    }
    args.push(callId);
    this.run(`UPDATE effects SET ${sets.join(',')} WHERE call_id=?`, ...args);
    return this.getEffect(callId);
  }

  effects(clusterId: string, { agent_id, status, limit }: { agent_id?: string | undefined; status?: string | undefined; limit?: number | undefined } = {}): EffectWithOwner[] {
    const where = ['e.cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (agent_id) {
      where.push('e.agent_id=?');
      args.push(agent_id);
    }
    if (status) {
      where.push('e.status=?');
      args.push(status);
    }
    args.push(normalizeLimit(limit, 200, 500));
    // The physical author of a Worker effect lives on its child Worker node.
    // The management owner is the parent of that node, not e.node_id itself.
    return this.all(`SELECT e.*, CASE WHEN n.kind='worker' THEN n.parent_id ELSE n.id END AS owner_management_id
      FROM effects e LEFT JOIN nodes n ON n.id=e.node_id AND n.cluster_id=e.cluster_id
      WHERE ${where.join(' AND ')} ORDER BY e.created DESC LIMIT ?`, ...args)
      .map(row => ({ ...decodeEffect(row), owner_management_id: textOrNull(row.owner_management_id, 'effects.owner_management_id') }));
  }

  effectByCallIdPrefix(clusterId: string, callId: string): EffectRecord | null {
    return one(this.get('SELECT * FROM effects WHERE cluster_id=? AND call_id=?', clusterId, callId), decodeEffect);
  }

  // -------------------------------------------------- tool call receipts

  /**
   * A durable receipt per admitted tool call: which call, which turn, which
   * budget scope paid for it and how far it got. `dispatch_status` is the state
   * machine — `ADMITTED` (quota reserved, effect not started), `DISPATCHED`
   * (the tool is running), `SETTLED`/`FAILED`/`CANCELLED` (finished), or
   * `UNKNOWN` (the process died with it in flight).
   */
  insertToolCallReceipt(receipt: ToolCallReceiptInsert): ToolCallReceiptRecord | null {
    this.run(
      `INSERT INTO tool_call_receipts(call_id,cluster_id,agent_id,session_id,turn_seq,tool,args_hash,command_id,budget_scope_id,dispatch_status,result_body,error,created,settled)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      receipt.call_id, receipt.cluster_id, receipt.agent_id, receipt.session_id ?? null,
      receipt.turn_seq ?? null, receipt.tool, receipt.args_hash, receipt.command_id ?? null,
      receipt.budget_scope_id ?? null, receipt.dispatch_status ?? 'ADMITTED',
      receipt.result_body ?? null, receipt.error ?? null, this.now(), null,
    );
    return one(this.get('SELECT * FROM tool_call_receipts WHERE call_id=?', receipt.call_id), decodeToolCallReceipt);
  }

  getToolCallReceipt(callId: string): ToolCallReceiptRecord | null {
    return one(this.get('SELECT * FROM tool_call_receipts WHERE call_id=?', callId), decodeToolCallReceipt);
  }

  settleToolCallReceipt(callId: string, settlement: ToolCallSettlement = {}): ToolCallReceiptRecord | null {
    const row = this.getToolCallReceipt(callId);
    if (!row) fail('Tool call receipt not found', 404);
    const sets = ['settled=?'];
    const args: BindValue[] = [this.now()];
    for (const column of TOOL_CALL_SETTLEMENT_COLUMNS) {
      const value = settlement[column];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(value);
    }
    args.push(callId);
    this.run(`UPDATE tool_call_receipts SET ${sets.join(',')} WHERE call_id=?`, ...args);
    return this.getToolCallReceipt(callId);
  }

  toolCallReceipts(clusterId: string, { agent_id = null, status = null }: { agent_id?: string | null | undefined; status?: string | null | undefined } = {}): ToolCallReceiptRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (agent_id) { where.push('agent_id=?'); args.push(agent_id); }
    if (status) { where.push('dispatch_status=?'); args.push(status); }
    return this.all(`SELECT * FROM tool_call_receipts WHERE ${where.join(' AND ')} ORDER BY created, call_id`, ...args).map(decodeToolCallReceipt);
  }

  // ----------------------------------------------------------------- health

  insertHealth(row: HealthInsert): HealthRecord | null {
    this.run(
      'INSERT INTO health(id,cluster_id,node_id,evaluation_window,signals,scores,weights,decided,decided_by,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
      row.id, row.cluster_id, row.node_id ?? null, row.evaluation_window ?? null,
      j(row.signals ?? {}), j(row.scores ?? {}), j(row.weights ?? {}), row.decided ? 1 : 0,
      row.decided_by ?? null, this.now(),
    );
    return this.latestHealth(row.cluster_id, {});
  }

  latestHealth(clusterId: string, { node_id = null }: { node_id?: string | null | undefined } = {}): HealthRecord | null {
    const row = node_id
      ? this.get('SELECT * FROM health WHERE cluster_id=? AND node_id=? ORDER BY created DESC, rowid DESC LIMIT 1', clusterId, node_id)
      : this.get('SELECT * FROM health WHERE cluster_id=? ORDER BY created DESC, rowid DESC LIMIT 1', clusterId);
    return row ? decodeHealth(row) : null;
  }

  listHealth(clusterId: string, { limit = 20 }: { limit?: number | undefined } = {}): HealthRecord[] {
    return this.all('SELECT * FROM health WHERE cluster_id=? ORDER BY created DESC LIMIT ?', clusterId, normalizeLimit(limit, 20, 200))
      .map(decodeHealth);
  }

  // ----------------------------------------------------------------- sources

  insertSource(source: SourceInsert): SourceRecord | null {
    this.run(
      `INSERT INTO sources(id,cluster_id,agent_id,node_id,transaction_id,request_url,final_url,status_code,fetched_at,hash,bytes,text)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      source.id, source.cluster_id, source.agent_id, source.node_id ?? null, source.transaction_id ?? null,
      source.request_url, source.final_url, source.status_code ?? null, source.fetched_at,
      source.hash, source.bytes, source.text,
    );
    return one(this.get('SELECT * FROM sources WHERE id=?', source.id), decodeSource);
  }

  getSource(id: string): SourceRecord | null {
    return one(this.get('SELECT * FROM sources WHERE id=?', id), decodeSource);
  }

  listSources(clusterId: string, { limit, offset }: { limit?: number | undefined; offset?: number | undefined } = {}): SourceListRow[] {
    return this.all('SELECT id,cluster_id,agent_id,transaction_id,request_url,final_url,status_code,fetched_at,hash,bytes FROM sources WHERE cluster_id=? ORDER BY fetched_at,id LIMIT ? OFFSET ?',
      clusterId, normalizeLimit(limit, 200, 500), offset ?? 0)
      .map(decodeSourceList);
  }

  countSources(clusterId: string): number {
    return numOf(this.get('SELECT COUNT(*) AS c FROM sources WHERE cluster_id=?', clusterId)?.c, 'sources.count');
  }

  // ------------------------------------------------------------------ audits

  insertAudit(audit: AuditInsert): AuditRecord | null {
    this.run(
      `INSERT INTO audits(id,cluster_id,transaction_id,node_id,kind,target_revision,decision,auditor_agent_id,evidence,created,decided)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      audit.id, audit.cluster_id, audit.transaction_id, audit.node_id, audit.kind, audit.target_revision,
      audit.decision ?? 'PENDING', audit.auditor_agent_id ?? null, j(audit.evidence ?? {}), this.now(), null,
    );
    return one(this.get('SELECT * FROM audits WHERE id=?', audit.id), decodeAudit);
  }

  getAudit(id: string): AuditRecord | null {
    return one(this.get('SELECT * FROM audits WHERE id=?', id), decodeAudit);
  }

  auditsForTransaction(clusterId: string, transactionId: string, { limit }: { limit?: number | undefined } = {}): AuditRecord[] {
    return this.all(
      'SELECT * FROM audits WHERE cluster_id=? AND transaction_id=? ORDER BY created, rowid LIMIT ?',
      clusterId, transactionId, normalizeLimit(limit, 100, 500),
    ).map(decodeAudit);
  }

  findAudit(clusterId: string, transactionId: string, kind: string, targetRevision: number): AuditRecord | null {
    return one(this.get('SELECT * FROM audits WHERE cluster_id=? AND transaction_id=? AND kind=? AND target_revision=? ORDER BY created DESC, rowid DESC LIMIT 1',
      clusterId, transactionId, kind, targetRevision), decodeAudit);
  }

  decideAudit(id: string, decision: FlowAuditDecision, auditorAgentId: string | null | undefined, evidence: FlowJsonValue | null | undefined): AuditRecord | null {
    const row = this.getAudit(id);
    if (!row) fail('Audit not found', 404);
    if (row.decision !== 'PENDING') return row;
    const prior = objectField(row.evidence, 'audits.evidence');
    const patch = evidence === null || evidence === undefined ? {} : objectField(evidence, 'audits.evidence');
    this.run('UPDATE audits SET decision=?,auditor_agent_id=?,evidence=?,decided=? WHERE id=?',
      decision, auditorAgentId ?? null, j({ ...prior, ...patch }), this.now(), id);
    return this.getAudit(id);
  }

  pendingAudits(
    clusterId: string,
    { kind, node_id, limit, after = null }: {
      kind?: string | undefined
      node_id?: string | undefined
      limit?: number | undefined
      after?: { created: number; id: string } | null | undefined
    } = {},
  ): AuditRecord[] {
    const where = ["cluster_id=?", "decision='PENDING'"];
    const args: BindValue[] = [clusterId];
    if (kind) {
      where.push('kind=?');
      args.push(kind);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    // A keyset cursor, not an offset: the caller is the Auditor, and taking the
    // oldest eight pending decisions on every turn would starve the ninth
    // forever. `(created, id)` is stable under the decisions it makes.
    if (after) {
      where.push('(created > ? OR (created = ? AND id > ?))');
      args.push(after.created, after.created, after.id);
    }
    args.push(normalizeLimit(limit, 100, 500));
    return this.all(`SELECT * FROM audits WHERE ${where.join(' AND ')} ORDER BY created, id LIMIT ?`, ...args).map(decodeAudit);
  }

  // ------------------------------------------------------------------ issues

  insertIssue(issue: IssueInsert): IssueRecord | null {
    const at = this.now();
    this.run(
      `INSERT INTO issues(id,cluster_id,node_id,transaction_id,reporter_agent_id,target_revision,severity,evidence,required_change,status,corrections,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      issue.id, issue.cluster_id, issue.node_id, issue.transaction_id ?? null, issue.reporter_agent_id ?? null,
      issue.target_revision ?? 0, issue.severity ?? 'MAJOR', j(issue.evidence ?? {}), issue.required_change ?? '',
      'OPEN', 0, at, at,
    );
    return one(this.get('SELECT * FROM issues WHERE id=?', issue.id), decodeIssue);
  }

  getIssue(id: string): IssueRecord | null {
    return one(this.get('SELECT * FROM issues WHERE id=?', id), decodeIssue);
  }

  updateIssue(id: string, patch: IssueUpdate): IssueRecord | null {
    const sets: string[] = [];
    const args: BindValue[] = [];
    for (const [key, column] of ISSUE_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column}=?`);
      args.push(value);
    }
    if (patch.evidence !== undefined) {
      sets.push('evidence=?');
      args.push(j(patch.evidence));
    }
    if (!sets.length) return this.getIssue(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE issues SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getIssue(id);
  }

  openIssues(clusterId: string, { node_id, transaction_id, status = 'OPEN' }: { node_id?: string | undefined; transaction_id?: string | undefined; status?: string | string[] | undefined } = {}): IssueRecord[] {
    const where = ['cluster_id=?'];
    const args: BindValue[] = [clusterId];
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      if (Array.isArray(status)) args.push(...status); else args.push(status);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (transaction_id) {
      where.push('transaction_id=?');
      args.push(transaction_id);
    }
    return this.all(`SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY created`, ...args).map(decodeIssue);
  }

  /**
   * Count correction rounds spent on a transaction. verify_correction advances
   * issue.corrections when a correction fails verification; opening an issue
   * does not itself spend a correction round.
   */
  countCorrections(clusterId: string, transactionId: string): number {
    return numOf(this.get(
      `SELECT COALESCE(SUM(corrections), 0) AS c FROM issues
        WHERE cluster_id=? AND transaction_id=? AND status IN ('OPEN','VERIFYING','CORRECTED','ESCALATED')`,
      clusterId, transactionId,
    )?.c, 'issues.corrections');
  }
}

// ------------------------------------------------------------ patch columns

/** Which cluster keys carry JSON that must be encoded before binding. */
const CLUSTER_JSON_COLUMNS: Partial<Record<keyof ClusterPatch, true>> = {
  capabilities: true, limits: true, budget: true, spec: true,
};

/** Which node keys carry JSON that must be encoded before binding. */
const NODE_JSON_COLUMNS: Partial<Record<keyof NodePatch, true>> = {
  scope: true, capabilities: true,
};

/** Which agent keys carry JSON that must be encoded before binding. */
const AGENT_JSON_COLUMNS: Partial<Record<keyof AgentPatch, true>> = {
  capabilities: true, meta: true,
};

/** Which transaction keys carry JSON that must be encoded before binding. */
const TRANSACTION_JSON_COLUMNS: Partial<Record<keyof TransactionPatch, true>> = {
  inputs: true, constraints: true, acceptance_criteria: true, needs: true,
  capabilities: true, result: true, validation: true,
};

/** Which allocation keys carry JSON that must be encoded before binding. */
const ALLOCATION_JSON_COLUMNS: Partial<Record<keyof AllocationPatch, true>> = {
  write_scope: true, write_scope_canonical: true, capabilities: true,
};

/** The cluster keys `updateCluster` builds its SET clause from, in order. */
const CLUSTER_COLUMNS = [
  ['status', 'status'], ['capabilities', 'capabilities'], ['limits', 'limits'],
  ['budget', 'budget'], ['spec', 'spec'], ['declared_limits', 'declared_limits'],
] as const satisfies readonly (readonly [keyof ClusterPatch, string])[];

/** The node keys `updateNode` builds its SET clause from, in order. */
const NODE_COLUMNS = [
  ['status', 'status'], ['scope', 'scope'], ['capabilities', 'capabilities'],
  ['max_children', 'max_children'], ['delegated_transaction_id', 'delegated_transaction_id'],
  ['parent_id', 'parent_id'], ['depth', 'depth'], ['path', 'path'],
  ['owner_management_id', 'owner_management_id'],
] as const satisfies readonly (readonly [keyof NodePatch, string])[];

/** The agent keys `updateAgent` builds its SET clause from, in order. */
const AGENT_COLUMNS = [
  ['status', 'status'], ['epoch', 'epoch'], ['turns', 'turns'], ['stagnation', 'stagnation'],
  ['capabilities', 'capabilities'], ['session_id', 'session_id'], ['cwd', 'cwd'], ['meta', 'meta'],
] as const satisfies readonly (readonly [keyof AgentPatch, string])[];

/** The transaction keys `updateTransaction` builds its SET clause from, in order. */
const TRANSACTION_COLUMNS = [
  ['objective', 'objective'], ['inputs', 'inputs'], ['constraints', 'constraints'],
  ['expected_output', 'expected_output'], ['acceptance_criteria', 'acceptance_criteria'],
  ['needs', 'needs'], ['priority', 'priority'], ['capabilities', 'capabilities'],
  ['status', 'status'], ['attempts', 'attempts'], ['result', 'result'],
  ['result_revision', 'result_revision'], ['validation', 'validation'],
  ['plan_approved_revision', 'plan_approved_revision'], ['node_id', 'node_id'],
  ['pre_pause_status', 'pre_pause_status'], ['pre_pause_revision', 'pre_pause_revision'],
  ['owner_management_id', 'owner_management_id'], ['parent_transaction_id', 'parent_transaction_id'],
  ['result_staged_epoch', 'result_staged_epoch'], ['result_staged_turn', 'result_staged_turn'],
  ['result_staged_agent', 'result_staged_agent'],
] as const satisfies readonly (readonly [keyof TransactionPatch, string])[];

/** The allocation keys `updateAllocation` builds its SET clause from, in order. */
const ALLOCATION_COLUMNS = [
  ['status', 'status'], ['write_scope', 'write_scope'], ['write_scope_canonical', 'write_scope_canonical'],
  ['capabilities', 'capabilities'], ['transaction_id', 'transaction_id'], ['agent_id', 'agent_id'],
] as const satisfies readonly (readonly [keyof AllocationPatch, string])[];

/** The group keys `updateGroup` builds its SET clause from, in order. */
const GROUP_COLUMNS = [
  ['status', 'status'], ['name', 'name'],
] as const satisfies readonly (readonly [keyof GroupPatch, string])[];

/** The numeric budget columns `updateBudget`/`bumpBudget` write, in order. */
const BUDGET_NUMERIC_KEYS = [
  'tool_calls_limit', 'tool_calls_reserved', 'tool_calls_spent', 'wall_limit_ms', 'wall_deadline',
  'agents_limit', 'agents_reserved', 'max_active_limit', 'max_active_reserved',
] as const satisfies readonly (keyof BudgetPatch)[];

/** The effect columns `settleEffect` writes from a settlement, in order. */
const EFFECT_SETTLEMENT_COLUMNS = ['body', 'error', 'job_id'] as const satisfies readonly (keyof EffectSettlement)[];

/** The tool-call columns `settleToolCallReceipt` writes from a settlement, in order. */
const TOOL_CALL_SETTLEMENT_COLUMNS = ['dispatch_status', 'result_body', 'error'] as const satisfies readonly (keyof ToolCallSettlement)[];

/** The issue keys `updateIssue` writes, in order; evidence is encoded separately. */
const ISSUE_COLUMNS = [
  ['status', 'status'], ['severity', 'severity'], ['required_change', 'required_change'],
  ['corrections', 'corrections'], ['target_revision', 'target_revision'], ['reviewed_revision', 'reviewed_revision'],
] as const satisfies readonly (readonly [keyof IssueUpdate, string])[];

// ---------------------------------------------------------------- decoders

/** Decode one row, or `null` when the SELECT missed. */
function one<T>(row: Row | undefined, decode: (row: Row) => T): T | null {
  return row === undefined ? null : decode(row);
}

function decodeCluster(row: Row): ClusterRecord {
  return {
    id: textOf(row.id, 'clusters.id'),
    objective: textOf(row.objective, 'clusters.objective'),
    workspace: textOf(row.workspace, 'clusters.workspace'),
    capabilities: validateCapabilities(p(row.capabilities), 'clusters.capabilities'),
    limits: decodeLimits(p(row.limits)),
    budget: decodeBudget(p(row.budget)),
    spec: objectOrNull(p(row.spec), 'clusters.spec'),
    declared_limits: textOrNull(row.declared_limits, 'clusters.declared_limits'),
    status: oneOf(row.status, CLUSTER_STATUSES, 'clusters.status'),
    revision: numOf(row.revision, 'clusters.revision'),
    created: numOf(row.created, 'clusters.created'),
    updated: numOf(row.updated, 'clusters.updated'),
  };
}

function decodeNode(row: Row): NodeRecord {
  return {
    id: textOf(row.id, 'nodes.id'),
    cluster_id: textOf(row.cluster_id, 'nodes.cluster_id'),
    parent_id: textOrNull(row.parent_id, 'nodes.parent_id'),
    kind: oneOf(row.kind, NODE_KINDS, 'nodes.kind'),
    depth: numOf(row.depth, 'nodes.depth'),
    status: oneOf(row.status, NODE_STATUSES, 'nodes.status'),
    revision: numOf(row.revision, 'nodes.revision'),
    scope: objectOrNull(p(row.scope), 'nodes.scope'),
    capabilities: validateCapabilities(p(row.capabilities), 'nodes.capabilities'),
    owner_management_id: textOrNull(row.owner_management_id, 'nodes.owner_management_id'),
    delegated_transaction_id: textOrNull(row.delegated_transaction_id, 'nodes.delegated_transaction_id'),
    max_children: numOrNull(row.max_children, 'nodes.max_children'),
    path: textOf(row.path, 'nodes.path'),
    created: numOf(row.created, 'nodes.created'),
    updated: numOf(row.updated, 'nodes.updated'),
  };
}

function decodeAgent(row: Row): AgentRecord {
  return {
    id: textOf(row.id, 'agents.id'),
    cluster_id: textOf(row.cluster_id, 'agents.cluster_id'),
    node_id: textOf(row.node_id, 'agents.node_id'),
    role: oneOf(row.role, AGENT_ROLES, 'agents.role'),
    session_id: textOf(row.session_id, 'agents.session_id'),
    status: oneOf(row.status, AGENT_STATUSES, 'agents.status'),
    epoch: numOf(row.epoch, 'agents.epoch'),
    turns: numOf(row.turns, 'agents.turns'),
    stagnation: numOf(row.stagnation, 'agents.stagnation'),
    capabilities: validateCapabilities(p(row.capabilities), 'agents.capabilities'),
    cwd: textOrNull(row.cwd, 'agents.cwd'),
    meta: objectField(p(row.meta), 'agents.meta'),
    created: numOf(row.created, 'agents.created'),
    updated: numOf(row.updated, 'agents.updated'),
  };
}

function decodeTransaction(row: Row): TransactionRecord {
  return {
    id: textOf(row.id, 'transactions.id'),
    cluster_id: textOf(row.cluster_id, 'transactions.cluster_id'),
    node_id: textOf(row.node_id, 'transactions.node_id'),
    owner_management_id: textOf(row.owner_management_id, 'transactions.owner_management_id'),
    parent_transaction_id: textOrNull(row.parent_transaction_id, 'transactions.parent_transaction_id'),
    objective: textOf(row.objective, 'transactions.objective'),
    inputs: jsonOf(p(row.inputs), 'transactions.inputs'),
    constraints: jsonOf(p(row.constraints), 'transactions.constraints'),
    expected_output: textOf(row.expected_output, 'transactions.expected_output'),
    acceptance_criteria: stringList(p(row.acceptance_criteria), 'transactions.acceptance_criteria'),
    needs: jsonOf(p(row.needs), 'transactions.needs'),
    priority: numOf(row.priority, 'transactions.priority'),
    capabilities: validateCapabilities(p(row.capabilities), 'transactions.capabilities'),
    status: oneOf(row.status, TRANSACTION_STATUSES, 'transactions.status'),
    revision: numOf(row.revision, 'transactions.revision'),
    attempts: numOf(row.attempts, 'transactions.attempts'),
    result: jsonOf(p(row.result), 'transactions.result'),
    result_revision: numOrNull(row.result_revision, 'transactions.result_revision'),
    validation: objectOrNull(p(row.validation), 'transactions.validation'),
    plan_approved_revision: numOrNull(row.plan_approved_revision, 'transactions.plan_approved_revision'),
    result_staged_epoch: row.result_staged_epoch === undefined || row.result_staged_epoch === null
      ? null : numOf(row.result_staged_epoch, 'transactions.result_staged_epoch'),
    result_staged_turn: row.result_staged_turn === undefined || row.result_staged_turn === null
      ? null : numOf(row.result_staged_turn, 'transactions.result_staged_turn'),
    result_staged_agent: textOrNull(row.result_staged_agent, 'transactions.result_staged_agent'),
    pre_pause_status: row.pre_pause_status === undefined || row.pre_pause_status === null
      ? null : oneOf(row.pre_pause_status, TRANSACTION_STATUSES, 'transactions.pre_pause_status'),
    pre_pause_revision: numOrNull(row.pre_pause_revision, 'transactions.pre_pause_revision'),
    created: numOf(row.created, 'transactions.created'),
    updated: numOf(row.updated, 'transactions.updated'),
  };
}

function decodeAllocation(row: Row): AllocationRecord {
  return {
    id: textOf(row.id, 'allocations.id'),
    cluster_id: textOf(row.cluster_id, 'allocations.cluster_id'),
    node_id: textOf(row.node_id, 'allocations.node_id'),
    agent_id: textOf(row.agent_id, 'allocations.agent_id'),
    transaction_id: textOrNull(row.transaction_id, 'allocations.transaction_id'),
    capabilities: validateCapabilities(p(row.capabilities), 'allocations.capabilities'),
    write_scope: stringList(p(row.write_scope), 'allocations.write_scope'),
    write_scope_canonical: stringList(p(row.write_scope_canonical ?? '[]'), 'allocations.write_scope_canonical'),
    status: oneOf(row.status, ALLOCATION_STATUSES, 'allocations.status'),
    created: numOf(row.created, 'allocations.created'),
    updated: numOf(row.updated, 'allocations.updated'),
  };
}

function decodeInbox(row: Row): InboxRecord {
  return {
    id: textOf(row.id, 'inbox.id'),
    cluster_id: textOf(row.cluster_id, 'inbox.cluster_id'),
    recipient: textOf(row.recipient, 'inbox.recipient'),
    subject: textOf(row.subject, 'inbox.subject'),
    payload: jsonOf(p(row.payload), 'inbox.payload'),
    status: oneOf(row.status, INBOX_STATUSES, 'inbox.status'),
    coalesce_key: textOrNull(row.coalesce_key, 'inbox.coalesce_key'),
    dedupe_key: textOrNull(row.dedupe_key, 'inbox.dedupe_key'),
    created: timestampOf(row.created, 'inbox.created'),
    consumed: numOrNull(row.consumed, 'inbox.consumed'),
  };
}

function decodeBudgetRow(row: Row): BudgetRecord {
  return {
    id: textOf(row.id, 'budgets.id'),
    cluster_id: textOf(row.cluster_id, 'budgets.cluster_id'),
    scope_kind: oneOf(row.scope_kind, SCOPE_KINDS, 'budgets.scope_kind'),
    scope_id: textOf(row.scope_id, 'budgets.scope_id'),
    node_id: textOrNull(row.node_id, 'budgets.node_id'),
    parent_budget_id: textOrNull(row.parent_budget_id, 'budgets.parent_budget_id'),
    revision: numOf(row.revision, 'budgets.revision'),
    tool_calls_limit: numOf(row.tool_calls_limit, 'budgets.tool_calls_limit'),
    tool_calls_reserved: numOf(row.tool_calls_reserved, 'budgets.tool_calls_reserved'),
    tool_calls_spent: numOf(row.tool_calls_spent, 'budgets.tool_calls_spent'),
    agents_limit: numOf(row.agents_limit, 'budgets.agents_limit'),
    agents_reserved: numOf(row.agents_reserved, 'budgets.agents_reserved'),
    max_active_limit: numOf(row.max_active_limit, 'budgets.max_active_limit'),
    max_active_reserved: numOf(row.max_active_reserved, 'budgets.max_active_reserved'),
    wall_limit_ms: numOf(row.wall_limit_ms, 'budgets.wall_limit_ms'),
    wall_deadline: numOrNull(row.wall_deadline, 'budgets.wall_deadline'),
    created: numOf(row.created, 'budgets.created'),
    updated: numOf(row.updated, 'budgets.updated'),
  };
}

function decodeAudit(row: Row): AuditRecord {
  return {
    id: textOf(row.id, 'audits.id'),
    cluster_id: textOf(row.cluster_id, 'audits.cluster_id'),
    node_id: textOrNull(row.node_id, 'audits.node_id'),
    transaction_id: textOrNull(row.transaction_id, 'audits.transaction_id'),
    auditor_agent_id: textOrNull(row.auditor_agent_id, 'audits.auditor_agent_id'),
    kind: oneOf(row.kind, AUDIT_KINDS, 'audits.kind'),
    target_revision: numOrNull(row.target_revision, 'audits.target_revision'),
    decision: oneOf(row.decision, AUDIT_DECISIONS, 'audits.decision'),
    evidence: jsonOf(p(row.evidence), 'audits.evidence'),
    created: numOf(row.created, 'audits.created'),
    decided: numOrNull(row.decided, 'audits.decided'),
  };
}

function decodeIssue(row: Row): IssueRecord {
  return {
    id: textOf(row.id, 'issues.id'),
    cluster_id: textOf(row.cluster_id, 'issues.cluster_id'),
    node_id: textOrNull(row.node_id, 'issues.node_id'),
    transaction_id: textOrNull(row.transaction_id, 'issues.transaction_id'),
    reporter_agent_id: textOrNull(row.reporter_agent_id, 'issues.reporter_agent_id'),
    target_revision: numOrNull(row.target_revision, 'issues.target_revision'),
    severity: textOf(row.severity, 'issues.severity'),
    required_change: textOf(row.required_change, 'issues.required_change'),
    evidence: jsonOf(p(row.evidence), 'issues.evidence'),
    status: oneOf(row.status, ISSUE_STATUSES, 'issues.status'),
    corrections: numOf(row.corrections, 'issues.corrections'),
    reviewed_revision: numOrNull(row.reviewed_revision, 'issues.reviewed_revision'),
    created: numOf(row.created, 'issues.created'),
    updated: numOf(row.updated, 'issues.updated'),
  };
}

function decodeEffect(row: Row): EffectRecord {
  return {
    call_id: textOf(row.call_id, 'effects.call_id'),
    cluster_id: textOf(row.cluster_id, 'effects.cluster_id'),
    agent_id: textOf(row.agent_id, 'effects.agent_id'),
    node_id: textOrNull(row.node_id, 'effects.node_id'),
    lease_epoch: numOf(row.lease_epoch, 'effects.lease_epoch'),
    session_id: textOrNull(row.session_id, 'effects.session_id'),
    turn_seq: numOrNull(row.turn_seq, 'effects.turn_seq'),
    tool: textOf(row.tool, 'effects.tool'),
    args: textOrNull(row.args, 'effects.args'),
    status: oneOf(row.status, EFFECT_STATUSES, 'effects.status'),
    body: textOrNull(row.body, 'effects.body'),
    error: textOrNull(row.error, 'effects.error'),
    job_id: textOrNull(row.job_id, 'effects.job_id'),
    created: numOf(row.created, 'effects.created'),
    settled: numOrNull(row.settled, 'effects.settled'),
  };
}

function decodeToolCallReceipt(row: Row): ToolCallReceiptRecord {
  return {
    call_id: textOf(row.call_id, 'tool_call_receipts.call_id'),
    cluster_id: textOf(row.cluster_id, 'tool_call_receipts.cluster_id'),
    agent_id: textOf(row.agent_id, 'tool_call_receipts.agent_id'),
    session_id: textOrNull(row.session_id, 'tool_call_receipts.session_id'),
    turn_seq: numOrNull(row.turn_seq, 'tool_call_receipts.turn_seq'),
    tool: textOf(row.tool, 'tool_call_receipts.tool'),
    args_hash: textOrNull(row.args_hash, 'tool_call_receipts.args_hash'),
    command_id: textOrNull(row.command_id, 'tool_call_receipts.command_id'),
    budget_scope_id: textOrNull(row.budget_scope_id, 'tool_call_receipts.budget_scope_id'),
    dispatch_status: oneOf(row.dispatch_status, DISPATCH_STATUSES, 'tool_call_receipts.dispatch_status'),
    result_body: textOrNull(row.result_body, 'tool_call_receipts.result_body'),
    error: textOrNull(row.error, 'tool_call_receipts.error'),
    created: numOf(row.created, 'tool_call_receipts.created'),
    settled: numOrNull(row.settled, 'tool_call_receipts.settled'),
  };
}


function decodeLease(row: Row): LeaseRecord {
  return {
    id: textOf(row.id, 'leases.id'),
    cluster_id: textOf(row.cluster_id, 'leases.cluster_id'),
    agent_id: textOf(row.agent_id, 'leases.agent_id'),
    node_id: textOf(row.node_id, 'leases.node_id'),
    purpose: textOf(row.purpose, 'leases.purpose'),
    epoch: numOf(row.epoch, 'leases.epoch'),
    expires: numOf(row.expires, 'leases.expires'),
    event_upper_bound: numOf(row.event_upper_bound, 'leases.event_upper_bound'),
    created: numOf(row.created, 'leases.created'),
  };
}

function decodeMessage(row: Row): MessageRecord {
  return {
    id: textOf(row.id, 'messages.id'),
    cluster_id: textOf(row.cluster_id, 'messages.cluster_id'),
    from_agent: textOrNull(row.from_agent, 'messages.from_agent'),
    from_node: textOrNull(row.from_node, 'messages.from_node'),
    kind: textOf(row.kind, 'messages.kind'),
    content: jsonOf(p(row.content), 'messages.content'),
    created: numOf(row.created, 'messages.created'),
  };
}

function decodeRecipient(row: Row): RecipientRecord {
  return {
    message_id: textOf(row.message_id, 'recipients.message_id'),
    recipient: textOf(row.recipient, 'recipients.recipient'),
    delivery_seq: numOrNull(row.delivery_seq, 'recipients.delivery_seq'),
    status: oneOf(row.status, DELIVERY_STATUSES, 'recipients.status'),
    acked: numOrNull(row.acked, 'recipients.acked'),
    created: numOf(row.created, 'recipients.created'),
  };
}

function decodeBlackboard(row: Row): BlackboardRecord {
  return {
    cluster_id: textOf(row.cluster_id, 'blackboard.cluster_id'),
    key: textOf(row.key, 'blackboard.key'),
    value: textOf(row.value, 'blackboard.value'),
    revision: numOf(row.revision, 'blackboard.revision'),
    updated_by: textOrNull(row.updated_by, 'blackboard.updated_by'),
    updated: numOf(row.updated, 'blackboard.updated'),
  };
}

function decodeGroup(row: Row): GroupRecord {
  return {
    id: textOf(row.id, 'groups.id'),
    cluster_id: textOf(row.cluster_id, 'groups.cluster_id'),
    name: textOf(row.name, 'groups.name'),
    status: oneOf(row.status, GROUP_STATUSES, 'groups.status'),
    created: numOf(row.created, 'groups.created'),
    updated: numOf(row.updated, 'groups.updated'),
  };
}

function decodeSubscription(row: Row): SubscriptionRecord {
  return {
    id: textOf(row.id, 'subscriptions.id'),
    cluster_id: textOf(row.cluster_id, 'subscriptions.cluster_id'),
    agent_id: textOf(row.agent_id, 'subscriptions.agent_id'),
    pattern: textOf(row.pattern, 'subscriptions.pattern'),
    mode: textOf(row.mode, 'subscriptions.mode'),
    active: numOf(row.active, 'subscriptions.active'),
    cursor: textOrNull(row.cursor, 'subscriptions.cursor'),
    created: numOf(row.created, 'subscriptions.created'),
  };
}

function decodeCheckpoint(row: Row): CheckpointRecord {
  return {
    id: textOf(row.id, 'checkpoints.id'),
    cluster_id: textOf(row.cluster_id, 'checkpoints.cluster_id'),
    agent_id: textOf(row.agent_id, 'checkpoints.agent_id'),
    session_id: textOf(row.session_id, 'checkpoints.session_id'),
    flushed_seq: numOrNull(row.flushed_seq, 'checkpoints.flushed_seq'),
    events_seq: numOrNull(row.events_seq, 'checkpoints.events_seq'),
    transaction_id: textOrNull(row.transaction_id, 'checkpoints.transaction_id'),
    transaction_revision: numOrNull(row.transaction_revision, 'checkpoints.transaction_revision'),
    inbox_ack_cursor: textOrNull(row.inbox_ack_cursor, 'checkpoints.inbox_ack_cursor'),
    usage_watermark: numOrNull(row.usage_watermark, 'checkpoints.usage_watermark'),
    turn_seq: numOrNull(row.turn_seq, 'checkpoints.turn_seq'),
    data: jsonOf(p(row.data), 'checkpoints.data'),
    created: numOf(row.created, 'checkpoints.created'),
  };
}

function decodeSummary(row: Row): SummaryRecord {
  return {
    id: textOf(row.id, 'summaries.id'),
    cluster_id: textOf(row.cluster_id, 'summaries.cluster_id'),
    node_id: textOrNull(row.node_id, 'summaries.node_id'),
    transaction_id: textOrNull(row.transaction_id, 'summaries.transaction_id'),
    as_of_seq: numOf(row.as_of_seq, 'summaries.as_of_seq'),
    data: jsonOf(p(row.data), 'summaries.data'),
    created: numOf(row.created, 'summaries.created'),
  };
}

function decodeHealth(row: Row): HealthRecord {
  return {
    id: textOf(row.id, 'health.id'),
    cluster_id: textOf(row.cluster_id, 'health.cluster_id'),
    node_id: textOrNull(row.node_id, 'health.node_id'),
    evaluation_window: textOrNull(row.evaluation_window, 'health.evaluation_window'),
    signals: jsonOf(p(row.signals), 'health.signals'),
    scores: jsonOf(p(row.scores), 'health.scores'),
    weights: jsonOf(p(row.weights), 'health.weights'),
    decided: numOf(row.decided, 'health.decided'),
    decided_by: textOrNull(row.decided_by, 'health.decided_by'),
    created: numOf(row.created, 'health.created'),
  };
}

function decodeSource(row: Row): SourceRecord {
  const listed = decodeSourceList(row);
  return { ...listed, node_id: textOrNull(row.node_id, 'sources.node_id'), text: textOf(row.text, 'sources.text') };
}

function decodeSourceList(row: Row): SourceListRow {
  return {
    id: textOf(row.id, 'sources.id'),
    cluster_id: textOf(row.cluster_id, 'sources.cluster_id'),
    agent_id: textOf(row.agent_id, 'sources.agent_id'),
    transaction_id: textOrNull(row.transaction_id, 'sources.transaction_id'),
    request_url: textOf(row.request_url, 'sources.request_url'),
    final_url: textOf(row.final_url, 'sources.final_url'),
    status_code: numOrNull(row.status_code, 'sources.status_code'),
    fetched_at: numOf(row.fetched_at, 'sources.fetched_at'),
    hash: textOf(row.hash, 'sources.hash'),
    bytes: numOf(row.bytes, 'sources.bytes'),
  };
}

// ------------------------------------------------------------- shared helpers

/** Whether a truthy value carries a callable `then`, like promise resolution. */
function isThenable(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  return typeof Reflect.get(value, 'then') === 'function';
}

function j(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function p(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(entry => canonical(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`;
}

export { j as encodeJson, p as decodeJson, canonical };

function decodeNativeFact(row: Row): NativeSessionFact {
  return {
    native_session_id: textOf(row.native_session_id, 'native.session_id'),
    native_seq: numOf(row.native_seq, 'native.seq'),
    cluster_id: textOf(row.cluster_id, 'native.cluster_id'),
    agent_id: textOf(row.agent_id, 'native.agent_id'),
    node_id: textOf(row.node_id, 'native.node_id'),
    transaction_id: textOrNull(row.transaction_id, 'native.transaction_id'),
    role: oneOf(row.role, AGENT_ROLES, 'native.role'),
    type: textOf(row.type, 'native.type'),
    data: jsonOf(p(row.data), 'native.data'),
    time: numOf(row.time, 'native.time'),
  };
}
