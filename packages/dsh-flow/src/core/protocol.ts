/**
 * Protocol: the frozen vocabulary of the cluster — roles, actions, statuses,
 * capability → host-tool mapping, and input validation shared by every
 * command path. No side effects, no IO.
 */
import { fail } from '../errors.ts';
import { objectField, validateBudget, validateCapabilities, validateLimits } from '../validation.ts';
import type {
  FlowActorRole,
  FlowAgentRole,
  FlowAgentStatus,
  FlowBudgetInput,
  FlowCapability,
  FlowClusterStatus,
  FlowContextLimits,
  FlowLimits,
  FlowManagementRole,
  FlowNodeStatus,
  FlowTransactionStatus,
} from '../types.ts';
import type { DelegationFixtureEntry, FlowActor, MessageFixtureEntry } from './model.ts';

/** Every cluster status, in the documented order. */
export const CLUSTER_STATUSES = [
  'RUNNING', 'PAUSED', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED',
] as const satisfies readonly FlowClusterStatus[];
export const CLUSTER_TERMINAL: ReadonlySet<FlowClusterStatus> = new Set<FlowClusterStatus>(
  ['COMPLETED', 'FAILED', 'CANCELLED'] as const satisfies readonly FlowClusterStatus[],
);

export const NODE_STATUSES = [
  'ACTIVE', 'DRAINING', 'PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RELEASED',
] as const satisfies readonly FlowNodeStatus[];

export const AGENT_STATUSES = [
  'CREATED', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'TERMINATED',
] as const satisfies readonly FlowAgentStatus[];
export const AGENT_TERMINAL: ReadonlySet<FlowAgentStatus> = new Set<FlowAgentStatus>(
  ['TERMINATED'] as const satisfies readonly FlowAgentStatus[],
);

export const TRANSACTION_STATUSES = [
  'DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'ACCEPTED', 'REJECTED',
  'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const satisfies readonly FlowTransactionStatus[];
export const TRANSACTION_TERMINAL: ReadonlySet<FlowTransactionStatus> = new Set<FlowTransactionStatus>(
  ['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'] as const satisfies readonly FlowTransactionStatus[],
);
export const TRANSACTION_OPEN: ReadonlySet<FlowTransactionStatus> = new Set<FlowTransactionStatus>(
  ['DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'REJECTED', 'BLOCKED', 'PAUSED'] as const satisfies readonly FlowTransactionStatus[],
);

export const MANAGEMENT_ROLES = ['orchestrator', 'allocator', 'auditor'] as const satisfies readonly FlowManagementRole[];
export const WORKER_ROLE = 'worker';
export const ROLES: readonly FlowAgentRole[] = [...MANAGEMENT_ROLES, WORKER_ROLE];

/** Orchestrator: transaction/decomposition/validation authority inside its domain. */
export const ORCHESTRATOR_ACTIONS = [
  'create_transaction', 'decompose', 'set_dependency', 'set_priority', 'dispatch', 'adjust_transaction',
  'validate', 'accept_result', 'reject_result', 'aggregate', 'escalate', 'finish_cluster', 'request_user',
  // Transaction-scoped lifecycle control: the cluster-level `pause`/`resume`/
  // `cancel` are the operator's whole-cluster switch, these are the
  // Orchestrator's inside its own domain.
  'pause_transaction', 'resume_transaction', 'cancel_transaction',
] as const satisfies readonly string[];

/** Allocator: agent/资源 authority inside its domain. */
export const ALLOCATOR_ACTIONS = [
  'allocate_agent', 'spawn_agent', 'spawn_management_node', 'release_agent',
  'allocate_budget', 'rebalance_budget', 'set_concurrency', 'scale_out', 'scale_in',
  'select_model', 'evaluate_allocation', 'replace_agent', 'reassign_agent', 'reparent',
  'checkpoint', 'restore', 'resolve_effect',
  // Per-identity context budget: the Allocator's answer to a session that
  // outgrows the role default without changing it for every identity.
  'set_context_budget',
] as const satisfies readonly string[];

/** Auditor: independent planning/validation gate inside its domain. */
export const AUDITOR_ACTIONS = [
  'inspect_plan', 'inspect_validation', 'request_correction', 'request_replan',
  'request_revalidation', 'verify_correction', 'escalate',
  // Section 18's supervision surface: record a signal, recommend a change, and
  // score the eight health dimensions on the record.
  'notify', 'recommend', 'evaluate_health',
] as const satisfies readonly string[];

export const WORKER_ACTIONS = ['submit_result'] as const satisfies readonly string[];

const ROLE_ACTION_MAP: Record<FlowActorRole, ReadonlySet<string>> = {
  orchestrator: new Set(ORCHESTRATOR_ACTIONS),
  allocator: new Set(ALLOCATOR_ACTIONS),
  auditor: new Set(AUDITOR_ACTIONS),
  worker: new Set(WORKER_ACTIONS),
  user: new Set(['pause', 'resume', 'cancel', 'start', 'list', 'read', 'events', 'report']),
};

export const ROLE_TOOL: Record<FlowAgentRole, string> = {
  orchestrator: 'flow_transaction',
  allocator: 'flow_allocation',
  auditor: 'flow_audit',
  worker: 'flow_transaction',
};

export function roleAllows(role: FlowActorRole, action: string): boolean {
  return Boolean(ROLE_ACTION_MAP[role]?.has(action));
}

export function authorize(actor: FlowActor, action: string): void {
  if (!actor || typeof actor.role !== 'string') fail('Command requires an actor identity', 403);
  if (actor.role === 'user') return;
  if (!ROLES.includes(actor.role)) fail(`Unknown role: ${actor.role}`, 403);
  if (!roleAllows(actor.role, action)) fail(`Role ${actor.role} may not perform ${action}`, 403);
}

/** Worker capability → host tool names. Unmapped capabilities are rejected loudly. */
export const CAPABILITY_TOOLS = {
  fs_read: ['read', 'glob', 'grep'],
  fs_write: ['write', 'edit'],
  shell: ['bash', 'job_output', 'job_kill'],
  web_fetch: ['web_fetch'],
  browser: [
    // The surface `@playwright/mcp` actually advertises over `tools/list` —
    // verified against the installed upstream (0.0.80), whose names are the
    // raw names behind the `mcp__playwright-mcp__` prefix. A name upstream does
    // not expose must not be required here: the capability gate would refuse
    // every browser cluster on a tool that can never exist.
    'mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_snapshot',
    'mcp__playwright-mcp__browser_click', 'mcp__playwright-mcp__browser_fill_form',
    'mcp__playwright-mcp__browser_type', 'mcp__playwright-mcp__browser_press_key',
    'mcp__playwright-mcp__browser_resize', 'mcp__playwright-mcp__browser_take_screenshot',
    'mcp__playwright-mcp__browser_console_messages',
    'mcp__playwright-mcp__browser_wait_for', 'mcp__playwright-mcp__browser_close',
  ],
} as const satisfies Record<FlowCapability, readonly string[]>;

/**
 * Host tool packages mounted into an agent's own scope for each capability.
 * A cluster Worker sees exactly the packages its capability set needs; the
 * final allowlist guard still denies anything outside {@link CAPABILITY_TOOLS}.
 */
export const CAPABILITY_PACKAGES = {
  fs_read: ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search'],
  fs_write: ['@deepseek-ai/dsh-tool-fs'],
  shell: ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs'],
  web_fetch: ['@deepseek-ai/dsh-tool-web'],
  browser: [],
} as const satisfies Record<FlowCapability, readonly string[]>;

/** Required configuration for the capability packages that have no usable default. */
export const CAPABILITY_PACKAGE_CONFIG = {
  '@deepseek-ai/dsh-tool-fs-search': { sampleOverCapGlobResults: false },
  '@deepseek-ai/dsh-tool-web': { fetch: true, search: false },
} as const satisfies Readonly<Record<string, Readonly<Record<string, boolean>>>>;

/** Never granted to a cluster Worker: agent-spawning, host-config or messaging escape hatches. */
const FORBIDDEN_WORKER_TOOL_NAMES = [
  'subagent', 'subagent_fork', 'workflow', 'run_code', 'spawn_teammate', 'plugin_manager',
  'bash_plugin_manager', 'settings_write', 'settings_read', 'credentials', 'hook', 'schedule',
  'skill', 'mcp_add', 'mcp_remove', 'terminal_new', 'ssh_run',
] as const satisfies readonly string[];
export const FORBIDDEN_WORKER_TOOLS: ReadonlySet<string> = new Set(FORBIDDEN_WORKER_TOOL_NAMES);

export function toolsForCapabilities(capabilities: readonly FlowCapability[]): string[] {
  const tools = new Set<string>();
  for (const capability of capabilities) {
    const mapped = CAPABILITY_TOOLS[capability];
    if (!mapped) fail(`Unsupported capability: ${capability}`);
    for (const tool of mapped) tools.add(tool);
  }
  for (const tool of tools) if (FORBIDDEN_WORKER_TOOLS.has(tool)) fail(`Forbidden worker tool: ${tool}`);
  return [...tools].sort();
}

export function validateIdentifier(value: unknown, label = 'identifier', max = 128): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.length > max) fail(`Invalid ${label}`);
  return value;
}

export function validateText(value: unknown, label: string, max = 32768): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Invalid ${label}`);
  return value;
}

export function validateList(value: unknown, label: string, max = 64, itemMax = 4096): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${label}`);
  return value.map((item: unknown) => validateText(item, `${label} entry`, itemMax));
}

export function validateStatusTransition(table: 'transaction', from: FlowTransactionStatus, to: FlowTransactionStatus): boolean {
  const allowed = TRANSITIONS[table][from];
  if (allowed && allowed.has(to)) return true;
  return false;
}

/** Legal transaction transitions. Self transitions are no-ops handled by callers. */
export const TRANSITIONS: Record<'transaction', Record<FlowTransactionStatus, ReadonlySet<FlowTransactionStatus>>> = {
  transaction: {
    DRAFT: new Set(['READY', 'BLOCKED', 'PAUSED', 'CANCELLED', 'SUPERSEDED', 'FAILED', 'DRAFT']),
    READY: new Set(['DISPATCHED', 'RUNNING', 'BLOCKED', 'PAUSED', 'CANCELLED', 'SUPERSEDED', 'FAILED', 'DRAFT', 'READY']),
    DISPATCHED: new Set(['RUNNING', 'READY', 'DRAFT', 'BLOCKED', 'PAUSED', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'DISPATCHED']),
    RUNNING: new Set(['SUBMITTED', 'READY', 'DRAFT', 'BLOCKED', 'PAUSED', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'RUNNING']),
    SUBMITTED: new Set(['VALIDATING', 'REJECTED', 'DRAFT', 'BLOCKED', 'PAUSED', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'SUBMITTED']),
    VALIDATING: new Set(['ACCEPTED', 'REJECTED', 'SUBMITTED', 'DRAFT', 'BLOCKED', 'PAUSED', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'VALIDATING']),
    REJECTED: new Set(['READY', 'DRAFT', 'DISPATCHED', 'BLOCKED', 'PAUSED', 'CANCELLED', 'SUPERSEDED', 'FAILED', 'REJECTED']),
    ACCEPTED: new Set(['REJECTED', 'SUPERSEDED', 'ACCEPTED']),
    BLOCKED: new Set(['READY', 'DRAFT', 'DISPATCHED', 'RUNNING', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'BLOCKED']),
    PAUSED: new Set(['READY', 'DRAFT', 'DISPATCHED', 'SUBMITTED', 'VALIDATING', 'REJECTED', 'BLOCKED', 'CANCELLED', 'FAILED', 'SUPERSEDED', 'PAUSED']),
    FAILED: new Set(['READY', 'SUPERSEDED', 'CANCELLED', 'FAILED']),
    CANCELLED: new Set(['CANCELLED']),
    SUPERSEDED: new Set(['SUPERSEDED']),
  },
};

export function assertTransition(from: FlowTransactionStatus, to: FlowTransactionStatus): void {
  if (from === to) return;
  if (!validateStatusTransition('transaction', from, to)) fail(`Illegal transaction transition ${from} → ${to}`, 409);
}

/** Overlap check for allocation write scopes (file or directory owner). */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some(x => b.some(y => x === y || y.startsWith(`${x.replace(/\/+$/, '')}/`) || x.startsWith(`${y.replace(/\/+$/, '')}/`)));
}

export function validateWriteScope(value: unknown, label = 'write_scope'): string[] {
  if (value === undefined) return [];
  // A model may legitimately send one path instead of a list.
  const entries: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  if (!Array.isArray(value) && typeof value !== 'string') fail(`Invalid ${label}: expected a list of file or directory paths`);
  if (Array.isArray(value) && value.length > 64) fail(`Invalid ${label}: expected a list of file or directory paths`);
  const unique = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.length || entry.length > 512) fail(`Invalid ${label} entry`);
    if (entry.includes('\0') || entry.split('/').includes('..')) fail(`Invalid ${label} entry: ${entry}`);
    unique.add(entry);
  }
  return [...unique];
}

export { validateLimits } from '../validation.ts';

/** The protocol defaults: the declared limits plus the per-turn tool-call cap. */
export interface FlowDefaultLimits extends FlowLimits {
  readonly max_tool_calls_per_turn: number;
}

export const DEFAULT_LIMITS: FlowDefaultLimits = {
  worker_model_requests: 0,
  worker_max_tokens: 0,
  max_children: 8,
  max_depth: 6,
  max_agents: 2048,
  max_active_agents: 8,
  max_llm_concurrency: 2,
  max_attempts: 2,
  max_corrections: 2,
  max_role_turns: 24,
  max_tool_calls_per_turn: 24,
};

/**
 * Context pressure thresholds per role.
 *
 * Measured on this host: a management role's session already carries ~6-8k
 * tokens of system prompt and tool schemas before any work, so the design's
 * raw 8192/16384 numbers would flag ordinary fixed prompts. Measure with
 * `tokenMeter`, compact at a fraction of the identity budget, and block only
 * when the resulting request still exceeds the provider's input window.
 */
export const DEFAULT_CONTEXT_LIMITS: FlowContextLimits = {
  /**
   * The approved per-role context budgets. These are the compaction window:
   * they are what keeps a management session from growing to six figures and
   * making every turn cost tens of thousands of prompt tokens.
   */
  role: 8192,
  worker: 16384,
  /** Fraction of the role/identity compaction budget. */
  compaction_threshold: 0.8,
  /**
   * The conservative declared window of the served model (the patch routes
   * `local-sglang/Qwen3.8-27B-FP8` with `contextWindow: 131072`). Reaching it
   * is the real overflow risk; the per-role numbers above are the point at
   * which the session is worth compacting.
   */
  model: 131072,
  /**
   * The served deployment's own input cap (`max_req_input_len` from
   * `/get_server_info`). A request above it is rejected outright, so it is a
   * harder ceiling than the model's nominal window.
   */
  server_input: 142074,
};

/** A validated start spec: every field narrowed for the cluster to consume. */
export interface FlowSpecValidation {
  readonly objective: string;
  readonly workspace: string;
  readonly capabilities: FlowCapability[];
  readonly limits: FlowDefaultLimits;
  readonly budget: FlowBudgetInput;
  readonly delegation: readonly DelegationFixtureEntry[];
  readonly message_fixture: readonly MessageFixtureEntry[];
}

export function validateSpec(spec: unknown): FlowSpecValidation {
  const source = objectField(spec, 'spec');
  const objective = validateText(source.objective, 'spec.objective', 16384);
  const workspace = validateText(source.workspace, 'spec.workspace', 4096);
  const capabilities = validateCapabilities(source.capabilities ?? ['fs_read'], 'spec.capabilities');
  const limits: FlowDefaultLimits = { ...DEFAULT_LIMITS, ...validateLimits(source.limits ?? {}, 'spec.limits') };
  const budget = { ...validateBudget(source.budget ?? {}, 'spec.budget') };
  validateText(source.id ?? 'x', 'spec.id', 128);
  const delegation = validateDelegation(source.delegation);
  const message_fixture = validateMessageFixture(source.message_fixture);
  if (source.initial_transactions !== undefined) {
    if (!Array.isArray(source.initial_transactions)) fail('Invalid spec.initial_transactions');
    if (source.initial_transactions.length > 4096) fail('spec.initial_transactions exceeds 4096 entries');
  }
  return { objective, workspace, capabilities, limits, budget, delegation, message_fixture };
}

/**
 * Reproducible message fixture: deterministic sends that exercise the delivery
 * pipeline (inject → flush → ack, and its crash repair) without depending on
 * the model choosing to call `flow_communicate`.
 */
export function validateMessageFixture(value: unknown): readonly MessageFixtureEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail('Invalid spec.message_fixture: expected at most 32 entries');
  return value.map((entry: unknown): MessageFixtureEntry => {
    const source = objectField(entry, 'message_fixture entry');
    return {
      from: validateText(source.from, 'message_fixture.from', 256),
      to: validateText(source.to, 'message_fixture.to', 256),
      content: validateText(source.content ?? 'fixture message', 'message_fixture.content', 4096),
      message_id: validateText(source.message_id ?? `fixture:${source.from}->${source.to}`, 'message_fixture.message_id', 256),
    };
  });
}

/**
 * Reproducible topology fixture: management children the cluster must build
 * before it can claim the decomposition is complete. A fixture pins the
 * *responsibility structure* only; every role and worker still runs for real.
 */
export function validateDelegation(value: unknown): readonly DelegationFixtureEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) fail('Invalid spec.delegation: expected at most 8 entries');
  return value.map((entry: unknown): DelegationFixtureEntry => {
    const source = objectField(entry, 'delegation entry');
    const scope = source.scope ?? source.name ?? 'delegated domain';
    const maxChildren = typeof source.max_children === 'number' && Number.isInteger(source.max_children) ? source.max_children : 4;
    const spawnChildren = typeof source.spawn_children === 'number' && Number.isInteger(source.spawn_children) ? source.spawn_children : 0;
    return {
      scope: validateText(scope, 'delegation.scope', 4096),
      objective: validateText(source.objective ?? source.scope ?? 'delegated domain', 'delegation.objective', 4096),
      max_children: maxChildren,
      spawn_children: spawnChildren,
      ...(source.budget === undefined ? {} : { budget: validateBudget(source.budget, 'delegation.budget') }),
      // The inputs the delegated levels must work under — a write scope the fixture
      // injects, for instance. They travel with the instruction down the chain, so
      // the fault lands on the node the fixture names and not on its first child.
      ...(source.inputs === undefined ? {} : { inputs: objectField(source.inputs, 'delegation.inputs') }),
    };
  });
}

export function commandIdFor({ session_id, turn_seq, tool_call_id }: {
  readonly session_id: unknown;
  readonly turn_seq: unknown;
  readonly tool_call_id: unknown;
}): string {
  if (typeof session_id !== 'string' || !session_id) fail('command requires a session identity', 403);
  if (!Number.isInteger(turn_seq)) fail('command requires a turn sequence', 403);
  if (typeof tool_call_id !== 'string' || !tool_call_id) fail('command requires a tool_call_id', 403);
  return `${session_id}:${turn_seq}:${tool_call_id}`;
}