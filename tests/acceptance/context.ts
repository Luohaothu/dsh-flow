/**
 * The acceptance chain's own vocabulary: the runner's report, the durable-event
 * and snapshot views the checks read, and the context objects a checker is
 * handed.
 *
 * This module is development-only and deliberately depends on nothing from the
 * plugin package: the case fixtures and the report are shaped by the runner, and
 * the host/plugin contracts arrive through the dev-side types in
 * `src/host/types.ts`, `src/host/mock-model.ts` and `src/host/host.ts`.
 *
 * Every value that crossed a process or file boundary (an IPC reply, a JSON
 * column, an event payload) is `unknown` until one of the guards here narrows
 * it. The guards are checks, not casts: a malformed reply throws or yields
 * `null` at the boundary instead of being read as if it had the expected shape.
 */
import type { BuildHashes } from './build-fingerprint.ts';
import type { DshHost } from '../../src/host/host.ts';
import type { MockModelHandle } from '../../src/host/mock-model.ts';
import type { CaseDefinition, RunLayout } from '../../src/host/types.ts';

/** A JSON object at a boundary: its values have not been checked yet. */
export type JsonObject = { [key: string]: unknown };

/** One command-line argument, as the runner's `parseArgs` keeps it. */
export type ArgValue = string | number | true;

/** Every command-line argument one runner invocation was given. */
export type RunArgs = Record<string, ArgValue | undefined>;

/** The model route one run points at. */
export interface ModelRoute {
  baseURL: string;
  model: string;
  provider: string;
}

// ------------------------------------------------------------- durable events

/** One durable event, as the IPC `events` op serialises it. */
export interface RunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: JsonObject;
  readonly at?: number;
}

/** One page of durable events. */
export interface EventsPage {
  readonly events: RunEvent[];
}

// ---------------------------------------------------------------- projections

/** A transaction as a snapshot carries it. */
export interface SnapshotTransaction {
  readonly id: string;
  readonly status: string;
  readonly node_id?: string | null;
  readonly objective?: string;
  readonly result?: unknown;
  readonly inputs?: unknown;
  readonly revision?: number;
  readonly [key: string]: unknown;
}

/** A cluster agent as a snapshot carries it. */
export interface SnapshotAgent {
  readonly id: string;
  readonly role?: string;
  readonly turns?: number;
  readonly node_id?: string | null;
  readonly status?: string;
  readonly session_id?: string | null;
  readonly [key: string]: unknown;
}

/** The cluster summary a snapshot carries. */
export interface SnapshotCluster {
  readonly id?: string;
  readonly status?: string;
  readonly revision?: number;
  readonly counts?: JsonObject;
  readonly [key: string]: unknown;
}

/** One cluster snapshot, as the IPC `read` op returns it. */
export interface RunSnapshot {
  readonly cluster: SnapshotCluster;
  readonly transactions?: readonly SnapshotTransaction[];
  readonly agents?: readonly SnapshotAgent[];
  readonly events?: readonly RunEvent[];
  readonly latest_seq?: number;
  readonly counts?: JsonObject;
  readonly [key: string]: unknown;
}

// -------------------------------------------------------------- single-agent

/** One tool call a single-agent run made. */
export interface SingleToolCall {
  readonly name: string;
  readonly arguments?: unknown;
}

/** The usage a single-agent run consumed. */
export interface SingleUsage {
  readonly requests?: number | null;
  readonly total_tokens?: number | null;
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly cached_tokens?: number | null;
  readonly reasoning_tokens?: number | null;
  readonly unknown_requests?: number | null;
  readonly overshoot?: number | null;
  readonly [key: string]: unknown;
}

/** The IPC `single` op reply. */
export interface SingleReply {
  readonly cluster_id: string;
  readonly stop_reason: string;
  readonly stop_detail: unknown;
  readonly final_text: string;
  readonly finalText: string;
  readonly tool_calls: readonly SingleToolCall[];
  readonly usage: SingleUsage | null;
  readonly error: string | null;
  readonly [key: string]: unknown;
}

// ------------------------------------------------------------------- the spec

/** The frozen inputs one fixture transaction was created with. */
export interface SpecTransactionInputs {
  readonly path?: string | undefined;
  readonly file?: string | undefined;
  readonly hash?: string | undefined;
  readonly [key: string]: unknown;
}

/**
 * One fixture transaction in the runner's spec.
 *
 * The runner reads `id` by name (and refuses a transaction without one before
 * `start`); every other field is the case's own JSON and passes through
 * untouched, which is why the type is an index signature rather than a closed
 * interface.
 */
export type SpecTransaction = JsonObject & { id?: unknown };

/** The start spec the runner assembled for one run. */
export interface RunSpec {
  objective: string;
  workspace: string;
  capabilities: readonly string[];
  limits: Record<string, number>;
  budget: Record<string, number>;
  initial_transactions?: readonly SpecTransaction[];
  acceptance_criteria?: readonly string[];
  delegation?: readonly JsonObject[];
  message_fixture?: readonly JsonObject[];
  notes?: string;
  [key: string]: unknown;
}

// --------------------------------------------------------------- the ledger

/** One decoded SQLite scalar projected by the read-only ledger reader. */
export type LedgerScalar = string | number | null;

/** One decoded ledger row, keyed by column name. */
export type LedgerRow = Record<string, LedgerScalar>;

/** One structured budget refusal, as `readStoneLedger` projects it. */
export interface RefusalRow {
  readonly scope?: unknown;
  readonly dimension?: unknown;
  readonly [column: string]: unknown;
}

/** What triggered one recovery kill. */
export interface KillTrigger {
  event: string;
  observed: number;
  observed_seq: number | null;
  polls: number | null;
  poll_error?: string | null;
  cluster_id: string | null;
  observed_at_ms: number;
  note?: string;
  [key: string]: unknown;
}

/** The usage aggregate `readStoneLedger` computes for one cluster. */
export interface LedgerUsage {
  requests: number;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  unknown_requests: number | null;
  overshoot: number | null;
}

/** The durable facts `readStoneLedger` reads straight out of one cluster. */
export interface StoneLedger {
  available: boolean;
  reason?: string | undefined;
  cluster_status?: string | undefined;
  usage?: LedgerUsage | undefined;
  usage_by_role?: LedgerRow[] | undefined;
  usage_by_agent?: LedgerRow[] | undefined;
  usage_states?: LedgerRow[] | undefined;
  usage_rows?: LedgerRow[] | undefined;
  usage_unknown_without_note?: number | undefined;
  transactions_by_status?: LedgerRow[] | undefined;
  transactions_detail?: LedgerRow[] | undefined;
  agents?: LedgerRow | undefined;
  agent_sessions?: LedgerRow[] | undefined;
  allocations?: LedgerRow[] | undefined;
  allocations_with_scope?: number | undefined;
  agents_by_role?: LedgerRow[] | undefined;
  nodes?: LedgerRow | undefined;
  events?: LedgerRow | undefined;
  event_seq?: number | null | undefined;
  leases?: LedgerRow | undefined;
  lease_rows?: LedgerRow[] | undefined;
  effects?: LedgerRow[] | undefined;
  audits?: LedgerRow[] | undefined;
  issues?: LedgerRow[] | undefined;
  deliveries?: LedgerRow[] | undefined;
  budget_refusals?: number | null | undefined;
  structured_budget_refusals?: LedgerRow[] | undefined;
  blockers?: LedgerRow[] | undefined;
  blocked_reason?: string | null | undefined;
  duplicate_accepts?: number | undefined;
  duplicate_charges?: number | undefined;
  double_leases?: number | undefined;
  max_llm_inflight?: number | null | undefined;
  max_resident_turns?: number | null | undefined;
  terminal_transactions?: number | undefined;
  total_transactions?: number | undefined;
  blocked_nodes?: number | undefined;
  write_capable_calls?: number | null | undefined;
  write_scope_refusals?: number | null | undefined;
  write_allocations?: LedgerRow[] | undefined;
  write_effects?: LedgerRow[] | undefined;
  turn_events?: number | undefined;
  granted_scope_overlaps?: number | null | undefined;
  cross_scope_writes?: number | null | undefined;
  cross_scope_writes_state?: string | undefined;
  settled_writes?: number | undefined;
  write_scope_checked?: number | undefined;
  llm_inflight_over_limit?: boolean | null | undefined;
  resident_handles_over_limit?: boolean | null | undefined;
  unfinished_at_stop?: number | undefined;
  lost_transactions?: number | undefined;
  ceilings?: { active: number | null; llm: number | null } | undefined;
  [key: string]: unknown;
}

// ------------------------------------------------------------ classification

/** How close one run came to each declared ceiling, as a ratio. */
export interface BudgetProximity {
  readonly tokens: number | null;
  readonly requests: number | null;
  readonly wall: number | null;
}

/** Which consumable ceilings were actually reached. */
export interface LimitExhausted {
  readonly tokens: boolean;
  readonly requests: boolean;
  readonly wall: boolean;
}

/** The structured limit evidence one run produced. */
export interface LimitReached {
  readonly hitWall: boolean;
  readonly blockedOnBudget: boolean;
  readonly refusals: readonly LedgerRow[];
  readonly exhausted: LimitExhausted;
  readonly tokens: number;
  readonly requests: number;
  readonly cluster_reason: string | null;
  readonly proximity: BudgetProximity;
}

/** The runner's final classification of one run. */
export interface ClassificationOutcome {
  failure_class: string | null;
  limit_reached: LimitReached | null;
  budget_proximity: BudgetProximity;
}

// --------------------------------------------------------------- the report

/** One receipt dispatched but not settled when the host was killed. */
export interface RestartReceipt {
  readonly request_id: string;
  readonly agent_id: string | null;
  readonly role: string | null;
  readonly kind: string | null;
  readonly created: number | null;
}

/** The durable facts captured on both sides of a mid-flight restart. */
export interface RestartFacts {
  kill_after_ms: number;
  kill_at_ms: number;
  event_seq_at_kill: number | null;
  kill_trigger: KillTrigger | null;
  exit: unknown;
  usage_at_crash: LedgerUsage | null;
  usage_before_kill: LedgerUsage | null;
  accepted_at_crash: LedgerRow[] | null;
  uncertain_effects_at_crash: LedgerRow[] | null;
  leases_at_crash: LedgerRow[] | null;
  receipts_in_flight_at_crash: RestartReceipt[] | null;
  transactions_open_at_crash: LedgerRow[] | null;
  restarted: boolean;
}

/** One workspace-preparation fact the runner recorded. */
export interface Preparation {
  kind: string;
  details: string[];
  generated_corpus?: {
    dir: string;
    count: number;
    manifest: string;
  };
  pnpm_install?: { status: number | null; stderr: string };
  source_hashes?: { digest: string; files: number; excluded: readonly string[] };
  copy_integrity?: unknown;
  dataset?: { path: string; corpus: string; count: number };
  [key: string]: unknown;
}

/** One recorded provider request, summarised for the report. */
export interface MockRequestSummary {
  seq: number;
  kind: string;
  role: string | null;
  node_id: string | null;
  agent_id: string | null;
  transaction_id: string | null;
  barrier: string | null;
  authorized: boolean;
  max_tokens_field: string | null;
  tool_calls: readonly string[];
  finish_reason: string | null;
  usage: unknown;
}

/** The report fields the mechanism verdict writes. */
export interface MechanismReport {
  failure_class?: string | null | undefined;
  mechanism_notes?: readonly string[] | undefined;
  unmeasured_invariants?: readonly string[] | undefined;
  not_exercised_invariants?: readonly string[] | undefined;
}

/** The layout facts `readStoneLedger` needs. */
export interface LedgerLayout {
  data: string;
  workspace?: string | null;
}

/** One checker's verdict: `null` means "not measured", never "failed". */
export interface CheckEntry {
  name: string;
  passed: boolean | null;
  evidence: string;
}

/** The checks a live phase produced. */
export interface LiveChecks {
  checks?: CheckEntry[];
  error?: string | null;
  blocked?: readonly string[];
}

/** The report fields the live-check collector reads and writes. */
export interface LiveCheckReport {
  notes: string[];
  live_checks?: LiveChecks | null | undefined;
  failure_class?: string | null | undefined;
}

/**
 * One run's report, written to `report.json` beside its artifacts. The key set
 * is open because the report is a JSON artifact the checks read by name; every
 * field they read by name is declared here.
 */
export interface AcceptanceReport {
  run_id: string;
  case: string;
  mode: string;
  title?: string | undefined;
  started_at: string;
  validation_mode: 'mock-api' | 'live-model';
  model_route: ModelRoute;
  patch?: string | undefined;
  patches: readonly string[];
  profile: string;
  paths: RunLayout;
  build_hashes: BuildHashes | null;
  input_hashes: JsonObject;
  mechanism_pass: string;
  scenario_status: string;
  quality_checks: CheckEntry[];
  failure_class: string | null;
  notes: string[];
  finished_at?: string | undefined;
  wall_time_ms?: number | undefined;
  cluster_id?: string | null | undefined;
  web_url?: string | null | undefined;
  host_exit?: unknown;
  preparation?: Preparation | undefined;
  baseline?: unknown;
  mock?: { scenario?: string | undefined; base_url?: string | undefined; model?: string | undefined } | undefined;
  mock_fixture?: { ok?: boolean | undefined; problem?: string | undefined; errors?: readonly string[] | undefined } | undefined;
  mock_requests?: readonly MockRequestSummary[] | undefined;
  mock_concurrency?: { peak_concurrent_requests: number | null; requests: number } | undefined;
  fixture_id_map?: Record<string, string> | undefined;
  spec?: RunSpec | undefined;
  single?: SingleReply | undefined;
  report?: unknown;
  ledger?: StoneLedger | undefined;
  failure?: { message: string; stack: string } | null | undefined;
  concurrency_probe?: JsonObject | undefined;
  restart?: RestartFacts | undefined;
  kill_trigger?: KillTrigger | null | undefined;
  live_checks?: LiveChecks | null | undefined;
  limit_reached?: LimitReached | null | undefined;
  budget_proximity?: BudgetProximity | undefined;
  mechanism_notes?: readonly string[] | undefined;
  unmeasured_invariants?: readonly string[] | undefined;
  not_exercised_invariants?: readonly string[] | undefined;
  scale_validation?: string | undefined;
  scale_metrics?: JsonObject | null | undefined;
  measured_per_file?: unknown;
  build_drift?: string | null | undefined;
  not_comparable?: boolean | undefined;
  experiment?: JsonObject | undefined;
  [key: string]: unknown;
}

// ----------------------------------------------------------- check context

/** The inputs every phase of a checker receives. */
export interface CaseRunContext {
  caseDef: CaseDefinition;
  mode: string;
  layout: RunLayout;
  workspace: string;
  report: AcceptanceReport;
  args: RunArgs;
}

/** The context a checker's `before` phase receives. */
export type BeforeCheckContext = CaseRunContext;

/** The context a checker's `live` phase receives, while the host is still up. */
export interface LiveCheckContext extends CaseRunContext {
  host: DshHost;
  env: Record<string, string | undefined>;
  mock?: MockModelHandle | null;
  snapshot?: RunSnapshot | null;
  events?: readonly RunEvent[];
}

/** The context a checker's `run` phase receives. */
export interface CheckContext extends CaseRunContext {
  single?: SingleReply | null;
  snapshot?: RunSnapshot | null;
  events: readonly RunEvent[];
  host: DshHost;
  env: Record<string, string | undefined>;
  mock?: MockModelHandle | null;
}

/** One checker's verdict, with the extra facts a tier reports. */
export interface CheckOutcome {
  checks: CheckEntry[];
  scenario_status: string;
  failure_class?: string | null;
  scale_validation?: string;
  metrics?: JsonObject | null;
  measured_per_file?: unknown;
}

/** What one `checks/<id>.ts` module exports. */
export interface ChecksModule {
  before?(context: BeforeCheckContext): Promise<unknown>;
  live?(context: LiveCheckContext): Promise<LiveChecks>;
  run?(context: CheckContext): Promise<CheckOutcome>;
}

// ------------------------------------------------------------------ guards

/** Is this value a JSON object (a non-null, non-array object)? */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object view of a value, or `null` when it is not one. */
export function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

/** The array view of a value, or `null` when it is not one. */
export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** A string field of a value, or `null` when it is absent or not a string. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}: expected a string`);
  return value;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** A finite number field of a value, or `null`. */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Narrow one event as the IPC layer serialises it. */
function decodeEvent(value: unknown): RunEvent {
  const record = asObject(value);
  if (!record) throw new Error('events reply: an entry is not an object');
  const seq = asNumber(record.seq);
  const type = asString(record.type);
  if (seq === null || type === null) throw new Error('events reply: an entry has no seq/type');
  const at = asNumber(record.at);
  return {
    seq,
    type,
    data: asObject(record.data) ?? {},
    ...(at === null ? {} : { at }),
  };
}

/** Narrow one `events` reply. Throws when the reply is not the expected page. */
export function decodeEventsPage(value: unknown): EventsPage {
  const record = asObject(value);
  const events = record ? asArray(record.events) : null;
  if (!record || !events) throw new Error('events reply is not an event page');
  return { events: events.map(decodeEvent) };
}

/** Narrow one event array that arrived inside another envelope. */
export function decodeEvents(value: unknown): RunEvent[] | null {
  const events = asArray(value);
  return events ? events.map(decodeEvent) : null;
}

/** One cluster reference, with the id the reply really carried. */
export interface ClusterReference {
  readonly id: string;
  readonly status?: string;
  readonly revision?: number;
  readonly [key: string]: unknown;
}

/** The IPC `start` reply. */
export interface StartReply {
  readonly cluster: ClusterReference;
}

function isSnapshotTransaction(value: unknown): value is SnapshotTransaction {
  const row = asObject(value);
  if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') return false;
  return (row.node_id === undefined || row.node_id === null || typeof row.node_id === 'string')
    && (row.objective === undefined || typeof row.objective === 'string')
    && (row.revision === undefined || asNumber(row.revision) !== null);
}

function isSnapshotAgent(value: unknown): value is SnapshotAgent {
  const row = asObject(value);
  if (!row || typeof row.id !== 'string') return false;
  return ['role', 'status'].every(key => row[key] === undefined || typeof row[key] === 'string')
    && ['node_id', 'session_id'].every(key => row[key] === undefined || row[key] === null || typeof row[key] === 'string')
    && (row.turns === undefined || asNumber(row.turns) !== null);
}

function isSnapshotCluster(value: unknown): value is SnapshotCluster {
  const row = asObject(value);
  return row !== null
    && ['id', 'status'].every(key => row[key] === undefined || typeof row[key] === 'string')
    && (row.revision === undefined || asNumber(row.revision) !== null)
    && (row.counts === undefined || isObject(row.counts));
}

function isSingleUsage(value: unknown): value is SingleUsage {
  const row = asObject(value);
  return row !== null && [
    'requests', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'cached_tokens',
    'reasoning_tokens', 'unknown_requests', 'overshoot',
  ].every(key => row[key] === undefined || row[key] === null || asNumber(row[key]) !== null);
}

/** Narrow one `read` reply into a snapshot view. */
export function decodeSnapshot(value: unknown): RunSnapshot | null {
  const record = asObject(value);
  const cluster = record ? asObject(record.cluster) : null;
  if (!record || !isSnapshotCluster(cluster)) return null;
  const transactions = asArray(record.transactions);
  const agents = asArray(record.agents);
  const events = asArray(record.events);
  const latestSeq = asNumber(record.latest_seq);
  return {
    cluster,
    ...(transactions === null ? {} : { transactions: transactions.map(entry => {
      if (!isSnapshotTransaction(entry)) throw new Error('snapshot transaction: invalid fields');
      return entry;
    }) }),
    ...(agents === null ? {} : { agents: agents.map(entry => {
      if (!isSnapshotAgent(entry)) throw new Error('snapshot agent: invalid fields');
      return entry;
    }) }),
    ...(events === null ? {} : { events: events.map(decodeEvent) }),
    ...(latestSeq === null ? {} : { latest_seq: latestSeq }),
  };
}

/** Narrow one `start` reply into the created cluster reference. */
export function decodeStartReply(value: unknown): StartReply | null {
  const record = asObject(value);
  const cluster = record ? asObject(record.cluster) : null;
  const id = cluster ? asString(cluster.id) : null;
  if (!cluster || id === null) return null;
  return { cluster: { ...cluster, id } };
}

/** Narrow one `single` reply. */
export function decodeSingleReply(value: unknown): SingleReply | null {
  const record = asObject(value);
  if (!record) return null;
  const clusterId = asString(record.cluster_id);
  const finalText = asString(record.finalText) ?? asString(record.final_text) ?? '';
  if (clusterId === null) return null;
  const toolCalls = asArray(record.tool_calls) ?? [];
  const usageValue: unknown = record.usage;
  if (usageValue !== null && usageValue !== undefined && !isSingleUsage(usageValue)) throw new Error('single usage: invalid fields');
  const usage = usageValue === null || usageValue === undefined ? null : usageValue;
  return {
    cluster_id: clusterId,
    stop_reason: asString(record.stop_reason) ?? 'unknown',
    stop_detail: record.stop_detail ?? null,
    final_text: asString(record.final_text) ?? finalText,
    finalText,
    tool_calls: toolCalls.map(entry => {
      const call = asObject(entry);
      return { name: asString(call?.name) ?? '', ...(call && 'arguments' in call ? { arguments: call.arguments } : {}) };
    }),
    usage,
    error: asString(record.error),
  };
}

/** A compact textual description of an unknown error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BrowserCheckContext {
  report: Pick<AcceptanceReport, 'cluster_id' | 'web_url' | 'failure'>;
  layout: LedgerLayout;
  events: readonly Pick<RunEvent, 'type' | 'data'>[];
}

/** Validate case-file inputs before the runner reads their declared fields. */
export function decodeCaseDefinition(value: unknown, id: string): CaseDefinition {
  const source = asObject(value);
  if (source === null) throw new Error(`case ${id}: expected an object`);
  const candidate = { ...source, id };
  if (!isCaseDefinition(candidate)) throw new Error(`case ${id}: invalid case fields`);
  return candidate;
}

function optionalScalars(
  row: JsonObject,
  strings: readonly string[],
  numbers: readonly string[],
  booleans: readonly string[],
): boolean {
  return strings.every(key => !(key in row) || typeof row[key] === 'string')
    && numbers.every(key => !(key in row) || asNumber(row[key]) !== null)
    && booleans.every(key => !(key in row) || typeof row[key] === 'boolean');
}

function optionalStringArrays(row: JsonObject, keys: readonly string[]): boolean {
  return keys.every(key => {
    if (!(key in row)) return true;
    const values = asArray(row[key]);
    return values !== null && values.every(value => typeof value === 'string');
  });
}

function isCaseDefinition(value: unknown): value is CaseDefinition {
  const row = asObject(value);
  if (!row || typeof row.id !== 'string') return false;
  if (!optionalScalars(row,
    ['title', 'objective', 'patch', 'referenceClock'],
    ['timeout_ms', 'generated_tier', 'minimum_pages', 'minimum_pages_per_project'],
    ['live_first'])) return false;
  if (!optionalStringArrays(row, ['capabilities', 'acceptance_criteria', 'patches', 'modes', 'allowed_hosts', 'dimensions', 'seed_urls'])) return false;
  for (const key of ['limits', 'budget']) if (key in row && !isObject(row[key])) return false;
  for (const key of ['initial_transactions', 'delegation', 'message_fixture']) {
    if (!(key in row)) continue;
    const values = asArray(row[key]);
    if (!values || !values.every(isObject)) return false;
  }
  if ('env' in row) {
    const env = asObject(row.env);
    if (!env || !Object.values(env).every(value => typeof value === 'string')) return false;
  }
  if ('workspace' in row) {
    const workspace = asObject(row.workspace);
    if (!workspace || !optionalScalars(workspace, ['seed', 'source', 'prepare'], [], [])
      || !optionalStringArrays(workspace, ['exclude', 'hashExclude', 'allowedLinkRoots'])) return false;
    if ('kind' in workspace && !['empty', 'seed', 'generated-corpus', 'copy-repo'].some(kind => kind === workspace.kind)) return false;
  }
  if ('dataset' in row) {
    const dataset = asObject(row.dataset);
    if (!dataset || !optionalScalars(dataset, ['file'], ['count'], [])) return false;
  }
  if ('scale_fixture' in row) {
    const fixture = asObject(row.scale_fixture);
    if (!fixture || !optionalScalars(fixture, [],
      ['workers', 'worker_model_requests', 'worker_max_tokens', 'concurrency_probe_window_ms', 'generated_tier'],
      ['concurrency_probe'])) return false;
  }
  if ('recovery' in row) {
    const recovery = asObject(row.recovery);
    if (!recovery || !optionalScalars(recovery, ['kill_on_event', 'kill_on_hold'], ['kill_after_ms', 'restart_delay_ms'], ['require_restart'])) return false;
  }
  return true;
}

function isCheckEntry(value: unknown): value is CheckEntry {
  const row = asObject(value);
  return row !== null && typeof row.name === 'string' && typeof row.evidence === 'string'
    && (row.passed === null || typeof row.passed === 'boolean');
}

/** A dynamically loaded checker cannot bypass the report boundary. */
export function decodeLiveChecks(value: unknown): LiveChecks {
  if (!isLiveChecks(value)) throw new Error('live checker returned invalid evidence');
  return value;
}

function isLiveChecks(value: unknown): value is LiveChecks {
  const row = asObject(value);
  if (!row) return false;
  if ('checks' in row) {
    const checks = asArray(row.checks);
    if (!checks || !checks.every(isCheckEntry)) return false;
  }
  return (!('error' in row) || row.error === null || typeof row.error === 'string')
    && optionalStringArrays(row, ['blocked']);
}

export function decodeCheckOutcome(value: unknown): CheckOutcome {
  if (!isCheckOutcome(value)) throw new Error('checker returned invalid outcome evidence');
  return value;
}

function isCheckOutcome(value: unknown): value is CheckOutcome {
  const row = asObject(value);
  const checks = row === null ? null : asArray(row.checks);
  return row !== null && checks !== null && checks.every(isCheckEntry)
    && typeof row.scenario_status === 'string'
    && (!('failure_class' in row) || row.failure_class === null || typeof row.failure_class === 'string')
    && (!('scale_validation' in row) || typeof row.scale_validation === 'string')
    && (!('metrics' in row) || row.metrics === null || isObject(row.metrics));
}