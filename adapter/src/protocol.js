/**
 * Protocol: the frozen vocabulary of the cluster — roles, actions, statuses,
 * capability → host-tool mapping, and input validation shared by every
 * command path. No side effects, no IO.
 */
import { fail, integer, objectField, textField } from './store.js';

export const CLUSTER_STATUSES = ['RUNNING', 'PAUSED', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'];
export const CLUSTER_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
export const NODE_STATUSES = ['ACTIVE', 'DRAINING', 'PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RELEASED'];
export const AGENT_STATUSES = ['CREATED', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'TERMINATED'];
export const AGENT_TERMINAL = new Set(['TERMINATED']);
export const TRANSACTION_STATUSES = [
  'DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'ACCEPTED', 'REJECTED',
  'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
];
export const TRANSACTION_TERMINAL = new Set(['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED']);
export const TRANSACTION_OPEN = new Set(['DRAFT', 'READY', 'DISPATCHED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'REJECTED', 'BLOCKED', 'PAUSED']);
export const MANAGEMENT_ROLES = ['orchestrator', 'allocator', 'auditor'];
export const WORKER_ROLE = 'worker';
export const ROLES = [...MANAGEMENT_ROLES, WORKER_ROLE];

/** Orchestrator: transaction/decomposition/validation authority inside its domain. */
export const ORCHESTRATOR_ACTIONS = [
  'create_transaction', 'decompose', 'set_dependency', 'set_priority', 'dispatch', 'adjust_transaction',
  'validate', 'accept_result', 'reject_result', 'aggregate', 'escalate', 'finish_cluster',
  // Transaction-scoped lifecycle control: the cluster-level `pause`/`resume`/
  // `cancel` are the operator's whole-cluster switch, these are the
  // Orchestrator's inside its own domain.
  'pause_transaction', 'resume_transaction', 'cancel_transaction',
];

/** Allocator: agent/资源 authority inside its domain. */
export const ALLOCATOR_ACTIONS = [
  'allocate_agent', 'spawn_agent', 'spawn_management_node', 'release_agent',
  'allocate_budget', 'rebalance_budget', 'set_concurrency', 'scale_out', 'scale_in',
  'select_model', 'evaluate_allocation', 'replace_agent', 'reassign_agent', 'reparent',
  'checkpoint', 'restore', 'resolve_effect',
  // Per-identity context budget: the Allocator's answer to a session that
  // outgrows the role default without changing it for every identity.
  'set_context_budget',
];

/** Auditor: independent planning/validation gate inside its domain. */
export const AUDITOR_ACTIONS = [
  'inspect_plan', 'inspect_validation', 'request_correction', 'request_replan',
  'request_revalidation', 'verify_correction', 'escalate',
  // Section 18's supervision surface: record a signal, recommend a change, and
  // score the eight health dimensions on the record.
  'notify', 'recommend', 'evaluate_health',
];

export const WORKER_ACTIONS = ['submit_result'];

const ROLE_ACTION_MAP = {
  orchestrator: new Set(ORCHESTRATOR_ACTIONS),
  allocator: new Set(ALLOCATOR_ACTIONS),
  auditor: new Set(AUDITOR_ACTIONS),
  worker: new Set(WORKER_ACTIONS),
  user: new Set(['pause', 'resume', 'cancel', 'start', 'list', 'read', 'events', 'report']),
};

export const ROLE_TOOL = {
  orchestrator: 'flow_transaction',
  allocator: 'flow_allocation',
  auditor: 'flow_audit',
  worker: 'flow_transaction',
};

export function roleAllows(role, action) {
  return Boolean(ROLE_ACTION_MAP[role]?.has(action));
}

export function authorize(actor, action) {
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
    'mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_snapshot',
    'mcp__playwright-mcp__browser_click', 'mcp__playwright-mcp__browser_fill_form',
    'mcp__playwright-mcp__browser_type', 'mcp__playwright-mcp__browser_press_key',
    'mcp__playwright-mcp__browser_reload', 'mcp__playwright-mcp__browser_resize',
    'mcp__playwright-mcp__browser_take_screenshot', 'mcp__playwright-mcp__browser_console_messages',
    'mcp__playwright-mcp__browser_wait_for', 'mcp__playwright-mcp__browser_close',
  ],
};

export const ALL_CAPABILITIES = Object.keys(CAPABILITY_TOOLS);

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
};

/** Required configuration for the capability packages that have no usable default. */
export const CAPABILITY_PACKAGE_CONFIG = {
  '@deepseek-ai/dsh-tool-fs-search': { sampleOverCapGlobResults: false },
  '@deepseek-ai/dsh-tool-web': { fetch: true, search: false },
};

/** Never granted to a cluster Worker: agent-spawning, host-config or messaging escape hatches. */
export const FORBIDDEN_WORKER_TOOLS = new Set([
  'subagent', 'subagent_fork', 'workflow', 'run_code', 'spawn_teammate', 'plugin_manager',
  'bash_plugin_manager', 'settings_write', 'settings_read', 'credentials', 'hook', 'schedule',
  'skill', 'mcp_add', 'mcp_remove', 'terminal_new', 'ssh_run',
]);

export function toolsForCapabilities(capabilities) {
  const tools = new Set();
  for (const capability of capabilities) {
    const mapped = CAPABILITY_TOOLS[capability];
    if (!mapped) fail(`Unsupported capability: ${capability}`);
    for (const tool of mapped) tools.add(tool);
  }
  for (const tool of tools) if (FORBIDDEN_WORKER_TOOLS.has(tool)) fail(`Forbidden worker tool: ${tool}`);
  return [...tools].sort();
}

export function validateCapabilities(value, label = 'capabilities', { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(`Missing ${label}`);
    return [];
  }
  if (!Array.isArray(value)) fail(`Invalid ${label}`);
  if (value.length > 32) fail(`${label} exceeds 32 entries`);
  for (const item of value) {
    if (typeof item !== 'string' || !ALL_CAPABILITIES.includes(item)) fail(`Unsupported capability: ${String(item)}`);
  }
  return [...new Set(value)];
}

export function validateIdentifier(value, label = 'identifier', max = 128) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.length > max) fail(`Invalid ${label}`);
  return value;
}

export function validateText(value, label, max = 32768) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Invalid ${label}`);
  return value;
}

export function validateList(value, label, max = 64, itemMax = 4096) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${label}`);
  return value.map(item => validateText(item, `${label} entry`, itemMax));
}

export function validateStatusTransition(table, from, to) {
  const allowed = TRANSITIONS[table]?.[from];
  if (allowed && allowed.has(to)) return true;
  return false;
}

/** Legal transaction transitions. Self transitions are no-ops handled by callers. */
export const TRANSITIONS = {
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

export function assertTransition(from, to) {
  if (from === to) return;
  if (!validateStatusTransition('transaction', from, to)) fail(`Illegal transaction transition ${from} → ${to}`, 409);
}

/** Overlap check for allocation write scopes (file or directory owner). */
export function scopesOverlap(a, b) {
  return a.some(x => b.some(y => x === y || y.startsWith(`${x.replace(/\/+$/, '')}/`) || x.startsWith(`${y.replace(/\/+$/, '')}/`)));
}

export function validateWriteScope(value, label = 'write_scope') {
  if (value === undefined) return [];
  // A model may legitimately send one path instead of a list.
  if (typeof value === 'string') value = [value];
  if (!Array.isArray(value) || value.length > 64) fail(`Invalid ${label}: expected a list of file or directory paths`);
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.length || entry.length > 512) fail(`Invalid ${label} entry`);
    if (entry.includes('\0') || entry.split('/').includes('..')) fail(`Invalid ${label} entry: ${entry}`);
  }
  return [...new Set(value)];
}

export function validateBudget(value, label = 'budget') {
  objectField(value, label);
  const out = {};
  for (const key of ['tokens', 'model_requests', 'tool_calls', 'wall_time_ms', 'agents', 'max_active_agents']) {
    if (value[key] === undefined) continue;
    out[key] = integer(value[key], 1, 2 ** 40, `${label}.${key}`);
  }
  return out;
}

export function validateLimits(value, label = 'limits') {
  objectField(value, label);
  const out = {};
  const bounds = {
    max_children: [1, 4096], max_depth: [1, 32], max_agents: [1, 100000],
    max_active_agents: [1, 512], max_llm_concurrency: [1, 64],
    max_attempts: [1, 16], max_corrections: [0, 16], max_role_turns: [1, 512],
    max_tool_calls_per_turn: [1, 4096], max_scale_batch: [1, 100000],
    // V6's per-Worker allowances: a scale tier fixes how many model requests one
    // Worker may send and how many tokens it may generate.
    worker_model_requests: [1, 64], worker_max_tokens: [64, 32768],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (value[key] === undefined) continue;
    out[key] = integer(value[key], min, max, `${label}.${key}`);
  }
  return out;
}

export const DEFAULT_LIMITS = {
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
export const DEFAULT_CONTEXT_LIMITS = {
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

export function validateSpec(spec) {
  objectField(spec, 'spec');
  const objective = validateText(spec.objective, 'spec.objective', 16384);
  const workspace = validateText(spec.workspace, 'spec.workspace', 4096);
  const capabilities = validateCapabilities(spec.capabilities ?? ['fs_read'], 'spec.capabilities');
  const limits = { ...DEFAULT_LIMITS, ...validateLimits(spec.limits ?? {}, 'spec.limits') };
  const budget = { ...validateBudget(spec.budget ?? {}, 'spec.budget') };
  validateText(spec.id ?? 'x', 'spec.id', 128);
  const delegation = validateDelegation(spec.delegation);
  const message_fixture = validateMessageFixture(spec.message_fixture);
  if (spec.initial_transactions !== undefined) {
    if (!Array.isArray(spec.initial_transactions)) fail('Invalid spec.initial_transactions');
    if (spec.initial_transactions.length > 4096) fail('spec.initial_transactions exceeds 4096 entries');
  }
  return { objective, workspace, capabilities, limits, budget, delegation, message_fixture };
}

/**
 * Reproducible message fixture: deterministic sends that exercise the delivery
 * pipeline (inject → flush → ack, and its crash repair) without depending on
 * the model choosing to call `flow_communicate`.
 */
export function validateMessageFixture(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail('Invalid spec.message_fixture: expected at most 32 entries');
  return value.map(entry => {
    objectField(entry, 'message_fixture entry');
    return {
      from: validateText(entry.from, 'message_fixture.from', 256),
      to: validateText(entry.to, 'message_fixture.to', 256),
      content: validateText(entry.content ?? 'fixture message', 'message_fixture.content', 4096),
      message_id: validateText(entry.message_id ?? `fixture:${entry.from}->${entry.to}`, 'message_fixture.message_id', 256),
    };
  });
}

/**
 * Reproducible topology fixture: management children the cluster must build
 * before it can claim the decomposition is complete. A fixture pins the
 * *responsibility structure* only; every role and worker still runs for real.
 */
export function validateDelegation(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) fail('Invalid spec.delegation: expected at most 8 entries');
  return value.map(entry => {
    objectField(entry, 'delegation entry');
    return {
      scope: entry.scope ?? entry.name ?? 'delegated domain',
      objective: validateText(entry.objective ?? entry.scope ?? 'delegated domain', 'delegation.objective', 4096),
      max_children: Number.isInteger(entry.max_children) ? entry.max_children : 4,
      spawn_children: Number.isInteger(entry.spawn_children) ? entry.spawn_children : 0,
      ...(entry.budget === undefined ? {} : { budget: validateBudget(entry.budget, 'delegation.budget') }),
      // The inputs the delegated levels must work under — a write scope the fixture
      // injects, for instance. They travel with the instruction down the chain, so
      // the fault lands on the node the fixture names and not on its first child.
      ...(entry.inputs === undefined ? {} : { inputs: objectField(entry.inputs, 'delegation.inputs') }),
    };
  });
}

export function commandIdFor({ session_id, turn_seq, tool_call_id }) {
  if (typeof session_id !== 'string' || !session_id) fail('command requires a session identity', 403);
  if (!Number.isInteger(turn_seq)) fail('command requires a turn sequence', 403);
  if (typeof tool_call_id !== 'string' || !tool_call_id) fail('command requires a tool_call_id', 403);
  return `${session_id}:${turn_seq}:${tool_call_id}`;
}

export { fail, textField, integer };