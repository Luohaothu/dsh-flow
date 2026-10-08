/**
 * Deployment configuration and start-request resolution.
 *
 * Config defines the schemastery schema and defaults. resolveStartRequest
 * merges schema defaults, deployment configuration and request overrides per
 * field for all start callers. Production code reads no environment variables;
 * acceptance launchers express environment choices through profile patches.
 */
import { resolve } from 'node:path';

import Schema from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';

import type {
  FlowBudget,
  FlowBudgetInput,
  FlowCapability,
  FlowJsonValue,
  FlowLimits,
  FlowLimitsInput,
  FlowStartRequest,
} from './types.ts';
import { fail } from './errors.ts';
import { validateModelSelection } from './core/model-selection.ts';
import {
  integer,
  isFlowJsonValue,
  textField,
  validateBudget,
  validateCapabilities,
  validateLimits,
} from './validation.ts';
import {
  DEFAULT_LIMITS,
  validateDelegation,
  validateMessageFixture,
  validateText,
} from './core/protocol.ts';
import type {
  DelegationFixtureEntry,
  FlowStartDefaults,
  FlowStartInternals,
  FlowStartSpec,
  FlowLogger,
  MessageFixtureEntry,
} from './core/model.ts';

/**
 * One deployment's configuration, as a profile row writes it.
 *
 * Every member accepts `null` as well as `undefined`: a schemastery member with
 * a default is typed `T | null` on the input side (the schema callable itself
 * accepts `null` and substitutes the default), and a patch file may legitimately
 * write an explicit `null` to mean "the default". Omitting the member is the
 * usual spelling.
 */
export interface Config {
  /** Directory holding the cluster database and its runtime files; relative paths resolve against `process.cwd()`. */
  readonly dataDir?: string | null
  /** Default workspace a cluster may write to; relative paths resolve against `process.cwd()`. */
  readonly workspace?: string | null
  /** LLM provider every cluster agent routes to. */
  readonly provider?: string | null
  /** Model every cluster agent requests. */
  readonly model?: string | null
  /** Optional reasoning effort; an omitted value is not written into the agent's options. */
  readonly reasoningEffort?: string | null
  /** New teams follow the main conversation unless an explicit route is saved. */
  readonly defaultModel?: { provider: string; model: string } | null
  readonly defaultReasoningEffort?: 'inherit' | 'off' | 'low' | 'medium' | 'high' | null
  readonly defaultDispatchMode?: 'parallel' | 'serial' | null
  /** Scheduler tick interval. */
  readonly tickMs?: number | null
  /** Age at which unfinished work is reported stale. */
  readonly staleMs?: number | null
  /** Deadline for one turn before the cluster aborts it. */
  readonly maxTurnMs?: number | null
  /** Lease heartbeat interval; must be shorter than the lease TTL. */
  readonly heartbeatMs?: number | null
  /** Lease time to live. */
  readonly leaseTtlMs?: number | null
  /** Bounded deadline for teardown: drains the live turns, then closes the store. */
  readonly disposeTimeoutMs?: number | null
  /** Capabilities a start request that names none receives. */
  readonly defaultCapabilities?: FlowCapability[] | null
  /** Root budget a start request that names none receives. */
  readonly defaultBudget?: FlowBudgetInput | null
  /** Limits a start request that names none receives. */
  readonly defaultLimits?: FlowLimitsInput | null
}

/** {@link Config} after the schema has applied every declared default. */
export interface ResolvedConfig {
  readonly dataDir: string
  readonly workspace: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | undefined
  readonly defaultModel: Volatile<{ provider: string; model: string } | null>
  readonly defaultReasoningEffort: Volatile<'inherit' | 'off' | 'low' | 'medium' | 'high'>
  readonly defaultDispatchMode: Volatile<'parallel' | 'serial'>
  readonly tickMs: number
  readonly staleMs: number
  readonly maxTurnMs: number
  readonly heartbeatMs: number
  readonly leaseTtlMs: number
  readonly disposeTimeoutMs: number
  readonly defaultCapabilities: FlowCapability[]
  readonly defaultBudget: Volatile<FlowBudget>
  readonly defaultLimits: Volatile<FlowLimits>
}

/**
 * The interactive envelope a cluster started from a page gets when it names
 * none, and the limits its management tree needs to close out.
 *
 * Gives a management tree enough tools, identities and runtime to close out.
 * Every value is overridable per start.
 */
export const INTERACTIVE_BUDGET: FlowBudget = {
  tool_calls: 2048,
  wall_time_ms: 900_000,
  agents: 64,
  max_active_agents: 4,
};

/** The management-tree limits that envelope comes with. */
export const INTERACTIVE_LIMITS: FlowLimits = {
  max_children: 8,
  max_depth: 4,
  max_agents: 64,
  max_active_agents: 4,
  max_llm_concurrency: 2,
  max_attempts: 2,
  max_corrections: 2,
  max_role_turns: 12,
  max_tool_calls_per_turn: DEFAULT_LIMITS.max_tool_calls_per_turn,
};

const CAPABILITY_NAMES: readonly FlowCapability[] = ['fs_read', 'fs_write', 'shell', 'web_fetch', 'browser'];

// Every member carries its interactive default so a deployment may state only
// the dimensions it wants to change: a schema object with required members
// would reject `defaultBudget: {tool_calls: 37}` outright, which is the
// documented "the rest keep their usual values" spelling.
const budgetSchema = Schema.object({
  tool_calls: Schema.number().step(1).min(1).max(2 ** 40).default(INTERACTIVE_BUDGET.tool_calls),
  wall_time_ms: Schema.number().step(1).min(1).max(2 ** 40).default(INTERACTIVE_BUDGET.wall_time_ms),
  agents: Schema.number().step(1).min(1).max(2 ** 40).default(INTERACTIVE_BUDGET.agents),
  max_active_agents: Schema.number().step(1).min(1).max(2 ** 40).default(INTERACTIVE_BUDGET.max_active_agents),
});

const limitsSchema = Schema.object({
  max_children: Schema.number().step(1).min(1).max(4096).default(INTERACTIVE_LIMITS.max_children),
  max_depth: Schema.number().step(1).min(1).max(32).default(INTERACTIVE_LIMITS.max_depth),
  max_agents: Schema.number().step(1).min(1).max(100_000).default(INTERACTIVE_LIMITS.max_agents),
  max_active_agents: Schema.number().step(1).min(1).max(512).default(INTERACTIVE_LIMITS.max_active_agents),
  max_llm_concurrency: Schema.number().step(1).min(1).max(64).default(INTERACTIVE_LIMITS.max_llm_concurrency),
  max_attempts: Schema.number().step(1).min(1).max(16).default(INTERACTIVE_LIMITS.max_attempts),
  max_corrections: Schema.number().step(1).min(0).max(16).default(INTERACTIVE_LIMITS.max_corrections),
  max_role_turns: Schema.number().step(1).min(1).max(512).default(INTERACTIVE_LIMITS.max_role_turns),
  max_tool_calls_per_turn: Schema.number().step(1).min(1).max(4096).default(DEFAULT_LIMITS.max_tool_calls_per_turn),
  max_scale_batch: Schema.number().step(1).min(1).max(100_000),
});

/**
 * Loader defaults and validation for a profile row.
 *
 * `provider` and `model` are required: a deployment that does not state its
 * route cannot be guessed, and the shipped bundle row derives them from the
 * host's default-model provider rather than from a local constant.
 */
const deploymentSchema: Schema<Config, ResolvedConfig> = Schema.object({
  dataDir: Schema.string().default('.dsh-flow'),
  workspace: Schema.string().default('.'),
  provider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.union([Schema.string(), Schema.const(undefined)]),
  defaultModel: Schema.union([Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }), Schema.const(null)]).default(null).volatile(),
  defaultReasoningEffort: Schema.union(['inherit', 'off', 'low', 'medium', 'high']).default('inherit').volatile(),
  defaultDispatchMode: Schema.union(['parallel', 'serial']).default('parallel').volatile(),
  tickMs: Schema.number().step(1).min(1).default(250),
  staleMs: Schema.number().step(1).min(1).default(120_000),
  maxTurnMs: Schema.number().step(1).min(1).default(900_000),
  heartbeatMs: Schema.number().step(1).min(1).default(20_000),
  leaseTtlMs: Schema.number().step(1).min(1).default(60_000),
  disposeTimeoutMs: Schema.number().step(1).min(1).default(5_000),
  defaultCapabilities: Schema.array(Schema.union(CAPABILITY_NAMES)).default(['fs_read', 'fs_write']),
  defaultBudget: budgetSchema.default({ ...INTERACTIVE_BUDGET }).volatile(),
  defaultLimits: limitsSchema.default({ ...INTERACTIVE_LIMITS }).volatile(),
});

/** Reject retired controls before schema defaults or Loader can hide them. */
export function rejectRemovedConfig(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const fields = input as Record<string, unknown>;
  for (const key of ['maxTokens', 'context']) {
    if (Object.hasOwn(fields, key)) fail(`Removed configuration field: ${key}`);
  }
  const defaultModel = fields.defaultModel;
  if (defaultModel !== undefined && defaultModel !== null) {
    const model = typeof defaultModel === 'object' && 'get' in defaultModel && typeof defaultModel.get === 'function'
      ? defaultModel.get() : defaultModel;
    if (model !== null && model !== undefined) validateModelSelection(model, 'defaultModel');
  }
  for (const name of ['defaultBudget', 'defaultLimits']) {
    const nested = fields[name];
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested) || 'get' in nested) continue;
    const removed = name === 'defaultBudget' ? ['tokens', 'model_requests', 'requests'] : ['worker_max_tokens', 'worker_model_requests'];
    for (const key of removed) {
      if (Object.hasOwn(nested, key)) fail(`Removed configuration field: ${name}.${key}`);
    }
  }
}

// Preserve the native object schema and its fixed Volatile paths. Callable
// validation checks the raw row first; Loader-normalized input is checked again
// in resolveConfig, including live budget/limit values on every new start.
export const Config: Schema<Config, ResolvedConfig> = new Proxy(deploymentSchema, {
  apply(schema, receiver, args) {
    rejectRemovedConfig(args[0]);
    return Reflect.apply(schema, receiver, args);
  },
  construct(schema, args) {
    rejectRemovedConfig(args[0]);
    return Reflect.construct(schema, args);
  },
});

/**
 * Everything the runtime and the tools need, resolved once per instance.
 *
 * Paths are resolved against `process.cwd()` exactly once, here, so no other
 * module has to reason about a relative deployment path.
 */
export interface ResolvedDeployment {
  /** Absolute data directory. */
  readonly dataDir: string
  /** Absolute default workspace. */
  readonly workspace: string
  /** The defaults every start request is merged against. */
  readonly startDefaults: FlowStartDefaults
  /** The runtime configuration, ready to construct a `ClusterRuntime`. */
  readonly runtime: RuntimeSettings
}

/** The subset of resolved settings the runtime constructor consumes. */
export interface RuntimeSettings {
  /** Read the live Config references once for each start; existing runs use their persisted snapshot. */
  readonly executionDefaults: () => import('./core/model.ts').FlowExecutionDefaults
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: string | undefined
  }
  readonly tickMs: number
  readonly staleMs: number
  readonly maxTurnMs: number
  readonly heartbeatMs: number
  readonly leaseTtlMs: number
  readonly disposeTimeoutMs: number
  readonly routes: Record<string, readonly string[]>
}

/**
 * Validate a resolved configuration and turn it into what the plugin needs.
 *
 * The schema already applied every default; this pass enforces the rules a
 * single field cannot express (NaN-free integers, `heartbeatMs < leaseTtlMs`,
 * a known capability inventory) and resolves the two paths.
 * @param config - the schema-resolved configuration.
 * @param options - `cwd` and `logger` are injectable so a test can pin them.
 * @returns the resolved deployment.
 */
export function resolveConfig(
  config: ResolvedConfig,
  { cwd = process.cwd(), logger }: { cwd?: string; logger?: FlowLogger } = {},
): ResolvedDeployment {
  rejectRemovedConfig(config);
  const dataDir = resolve(cwd, textField(config.dataDir, 'dataDir', 4096));
  const workspace = resolve(cwd, textField(config.workspace, 'workspace', 4096));
  const provider = textField(config.provider, 'provider', 512);
  const model = textField(config.model, 'model', 512);

  const heartbeatMs = integer(config.heartbeatMs, 1, 2 ** 31, 'heartbeatMs');
  const leaseTtlMs = integer(config.leaseTtlMs, 1, 2 ** 31, 'leaseTtlMs');
  if (heartbeatMs >= leaseTtlMs) {
    fail(`heartbeatMs (${heartbeatMs}) must be shorter than leaseTtlMs (${leaseTtlMs})`);
  }

  const defaultCapabilities = validateCapabilities([...config.defaultCapabilities], 'defaultCapabilities');
  const defaultBudget = completeBudget(config.defaultBudget.get(), 'defaultBudget');
  const defaultLimits = completeLimits(config.defaultLimits.get(), 'defaultLimits');

  if (config.reasoningEffort !== undefined) {
    textField(config.reasoningEffort, 'reasoningEffort', 128);
  }
  if (logger && defaultCapabilities.length === 0) {
    logger.warn?.('dsh-flow: defaultCapabilities is empty; a cluster started without capabilities has no worker tools');
  }

  return {
    dataDir,
    workspace,
    startDefaults: { workspace, capabilities: defaultCapabilities, budget: defaultBudget, limits: defaultLimits },
    runtime: {
      executionDefaults: () => {
        const budget = completeBudget(config.defaultBudget.get(), 'defaultBudget');
        const limits = completeLimits(config.defaultLimits.get(), 'defaultLimits');
        const serial = config.defaultDispatchMode.get() === 'serial';
        const configured = config.defaultModel.get() ?? null;
        const route = configured === null ? null : validateModelSelection(configured, 'defaultModel');
        const effort = config.defaultReasoningEffort.get();
        return {
          start: { workspace, capabilities: defaultCapabilities, budget: serial ? { ...budget, max_active_agents: 1 } : budget,
            limits: serial ? { ...limits, max_active_agents: 1, max_llm_concurrency: 1 } : limits },
          model: route === null ? null : { provider: textField(route.provider, 'defaultModel.provider', 512), model: textField(route.model, 'defaultModel.model', 512) },
          options: effort === 'inherit' ? {} : { reasoningEffort: effort },
          dispatchMode: serial ? 'serial' : 'parallel',
        };
      },
      model: {
        provider,
        model,
        reasoningEffort: config.reasoningEffort,
      },
      tickMs: integer(config.tickMs, 1, 2 ** 31, 'tickMs'),
      staleMs: integer(config.staleMs, 1, 2 ** 31, 'staleMs'),
      maxTurnMs: integer(config.maxTurnMs, 1, 2 ** 31, 'maxTurnMs'),
      heartbeatMs,
      leaseTtlMs,
      disposeTimeoutMs: integer(config.disposeTimeoutMs, 1, 2 ** 31, 'disposeTimeoutMs'),
      routes: { [provider]: [model] },
    },
  };
}

/**
 * Resolve one start request against the deployment defaults.
 *
 * Per field: an omitted value takes the default, an explicit value wins, and an
 * explicit illegal value is refused by the same validator a command path uses.
 * `capabilities: []` is a named empty set and stays empty; `budget` and
 * `limits` merge key by key rather than wholesale, so naming one dimension
 * keeps the other dimensions.
 * @param request - the caller's request.
 * @param defaults - the deployment's defaults.
 * @param internals - development-only reproducible fixtures.
 * @returns the resolved, validated spec the runtime stores.
 */
export function resolveStartRequest(
  request: FlowStartRequest,
  defaults: FlowStartDefaults,
  internals: FlowStartInternals = {},
): FlowStartSpec {
  rejectRemovedConfig(request);
  const objective = validateText(request.objective, 'spec.objective', 16_384);

  const workspace = request.workspace === undefined
    ? defaults.workspace
    : validateText(request.workspace, 'spec.workspace', 4096);

  const capabilities = request.capabilities === undefined
    ? [...defaults.capabilities]
    : validateCapabilities(request.capabilities, 'spec.capabilities');

  const budget: FlowBudgetInput = {
    ...defaults.budget,
    ...(request.budget === undefined ? {} : validateBudget(request.budget, 'spec.budget')),
  };
  const limits: FlowLimits = {
    ...defaults.limits,
    ...(request.limits === undefined ? {} : validateLimits(request.limits, 'spec.limits')),
  };

  const id = request.id === undefined ? undefined : validateText(request.id, 'spec.id', 128);
  const acceptanceCriteria = validateAcceptanceCriteria(request.acceptance_criteria);
  const initialTransactions = validateInitialTransactions(request.initial_transactions);
  const delegation: readonly DelegationFixtureEntry[] = validateDelegation(internals.delegation);
  const messageFixture: readonly MessageFixtureEntry[] = validateMessageFixture(internals.message_fixture);

  return {
    objective,
    ...(id === undefined ? {} : { id }),
    workspace,
    capabilities,
    budget,
    limits,
    ...(initialTransactions === undefined ? {} : { initial_transactions: initialTransactions }),
    ...(acceptanceCriteria === undefined ? {} : { acceptance_criteria: acceptanceCriteria }),
    delegation,
    message_fixture: messageFixture,
  };
}

/**
 * A deployment's budget defaults, completed against the interactive envelope.
 *
 * A profile row may name one dimension (`defaultBudget: {tool_calls: 37}`)
 * and mean "this, and the usual values for the rest": the schema fills each
 * omitted member with the interactive default, and this pass keeps an explicit
 * value over it. Nothing is invented beyond the documented defaults.
 */
function completeBudget(input: FlowBudgetInput, label: string): FlowBudget {
  const validated = validateBudget({ ...input }, label);
  return {
    tool_calls: validated.tool_calls ?? INTERACTIVE_BUDGET.tool_calls,
    wall_time_ms: validated.wall_time_ms ?? INTERACTIVE_BUDGET.wall_time_ms,
    agents: validated.agents ?? INTERACTIVE_BUDGET.agents,
    max_active_agents: validated.max_active_agents ?? INTERACTIVE_BUDGET.max_active_agents,
  };
}

/**
 * A deployment's limit defaults, completed against the *interactive* limits.
 *
 * `DEFAULT_LIMITS` is the protocol's own fallback for a request that names no
 * limits at all (a directly constructed runtime, a pure business test); a
 * deployment that names some limits means the interactive envelope with those
 * replaced, with omitted collaboration limits keeping their interactive value.
 */
function completeLimits(input: FlowLimitsInput, label: string): FlowLimits {
  const merged = { ...INTERACTIVE_LIMITS, ...validateLimits({ ...input }, label) };
  return { ...merged };
}

function validateAcceptanceCriteria(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('Invalid spec.acceptance_criteria');
  if (value.length > 64) fail('spec.acceptance_criteria exceeds 64 entries');
  return value.map((entry, index) => validateText(entry, `spec.acceptance_criteria[${String(index)}]`, 4096));
}

function validateInitialTransactions(value: unknown): readonly FlowJsonValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('Invalid spec.initial_transactions');
  if (value.length > 4096) fail('spec.initial_transactions exceeds 4096 entries');
  for (const entry of value) {
    if (!isFlowJsonValue(entry)) fail('Invalid spec.initial_transactions entry: expected a JSON value');
  }
  return value;
}
