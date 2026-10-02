/**
 * dsh-flow: hierarchical agent cluster plugin for the DSH host.
 *
 * Registers the `flow` service (ClusterRuntime), the cluster control tools the
 * host user and cluster roles call, the durable tool-execution seam, and the
 * authenticated `/api/flow` host route. All model traffic is routed explicitly
 * to the configured local provider by each agent's own `agentOptions`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { ClusterRuntime } from './cluster.js';
import { DEFAULT_CONTEXT_LIMITS } from './protocol.js';
import { COMMUNICATION_ACTIONS } from './communication.js';
import { createToolExecutionHook } from './runtime.js';
import { commandIdFor, fail, ROLE_TOOL } from './protocol.js';

export const name = 'dsh-flow';

/**
 * The cluster control plane drives real agents and flushes their sessions, so
 * it injects the tool registry, the agent registry and the session service.
 * Optional services (the client connection route) are awaited separately.
 */
export const inject = ['tools', 'agents', 'sessions'];

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  mkdirSync(settings.dataDir, { recursive: true });

  const runtime = new ClusterRuntime(ctx, {
    dataDir: settings.dataDir,
    path: join(settings.dataDir, 'cluster.sqlite'),
    logger: ctx.logger,
    model: { provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort, maxTokens: settings.maxTokens },
    routes: { [settings.provider]: [settings.model] },
    context: settings.context,
    tickMs: settings.tickMs,
    staleMs: settings.staleMs,
    maxTurnMs: settings.maxTurnMs,
    heartbeatMs: settings.heartbeatMs,
    leaseTtlMs: settings.leaseTtlMs,
  });
  ctx.provide('flow', runtime);
  ctx.effect(() => () => runtime.dispose(), 'dsh-flow: cluster runtime');

  registerHostTools(ctx, runtime);
  registerRoleTools(ctx, runtime);
  registerSmokeTools(ctx);

  ctx.effect(() => {
    const hook = createToolExecutionHook({
      ctx,
      store: runtime.store,
      logger: ctx.logger,
      lookupAgent: sessionId => runtime.store.getAgentBySession(sessionId),
      beforeTool: (agent, exec, callId) => runtime.admitToolCall(agent, exec, callId),
      afterTool: (agent, exec, callId, result, error) => runtime.settleToolCall(agent, exec, callId, result, error),
      // Re-validate the captured lease after the awaited flush, and release a
      // reservation whose call never dispatched.
      recheckTool: (agent, exec, callId) => runtime.recheckToolCall(agent, exec, callId),
      // The call really dispatched past the fences: from here it is consumed.
      dispatched: (agent, exec, callId) => runtime.markToolCallDispatched(agent, exec, callId),
      refuseTool: (agent, exec, callId, reason) => runtime.refuseToolCall(agent, exec, callId, reason),
      recordEvent: (clusterId, type, data) => runtime.store.appendEvent(clusterId, type, data),
    });
    ctx.on('tools/execute', hook);
  }, 'dsh-flow: tool execution seam');

  // The durable Session is the only proof that an injected message was really
  // admitted, so recovery needs the persistence service to reconcile with it.
  ctx.inject(['sessionPersistence'], persistenceCtx => {
    runtime.attachPersistence(persistenceCtx.sessionPersistence);
  });

  ctx.inject(['connection'], connectionCtx => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: '/api/flow',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => handleFetch(runtime, request),
    }), 'dsh-flow: /api/flow');
  });

  // Recovery preserves unproven injections and *withholds scheduling* until the
  // proof has been read from the durable Sessions: re-injecting while the proof
  // is still being collected would be a duplicate.
  // Scheduling stays off until the host is ready and the injections have been
  // reconciled; a turn started against a half-mounted profile would be an
  // infrastructure rejection charged to a Worker's attempts.
  void runtime.recoverAndReconcile().then(({ recovered }) => {
    if (recovered.length) ctx.logger?.info?.(`dsh-flow: recovered ${recovered.length} unfinished cluster(s)`);
  }).catch(error => ctx.logger?.warn?.(error));

  installIpcBridge(runtime);
  return runtime;
}

// ------------------------------------------------------------------- config

function resolveSettings(config) {
  const dataDir = config.dataDir ?? process.env.FLOW_DATA_DIR ?? join(process.cwd(), '.dsh-flow');
  const provider = config.provider ?? process.env.FLOW_MODEL_PROVIDER ?? process.env.FLOW_QWEN_PROVIDER ?? 'local-sglang';
  const model = config.model ?? process.env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-FP8';
  const expectedBaseUrl = process.env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1';
  return {
    dataDir,
    provider,
    model,
    expectedBaseUrl,
    reasoningEffort: config.reasoningEffort ?? process.env.FLOW_REASONING_EFFORT ?? 'off',
    maxTokens: Number(config.maxTokens ?? process.env.FLOW_MAX_TOKENS ?? 4096),
    context: {
      // The approved per-role context budgets (V4): these are the compaction
      // window, so they are what keeps a management session from growing into
      // six figures and pricing every turn at tens of thousands of tokens.
      role: Number(process.env.FLOW_CONTEXT_ROLE ?? DEFAULT_CONTEXT_LIMITS.role),
      worker: Number(process.env.FLOW_CONTEXT_WORKER ?? DEFAULT_CONTEXT_LIMITS.worker),
      model: Number(process.env.FLOW_CONTEXT_MODEL ?? DEFAULT_CONTEXT_LIMITS.model),
      compaction_threshold: Number(process.env.FLOW_CONTEXT_TRIGGER ?? DEFAULT_CONTEXT_LIMITS.compaction_threshold),
      server_input: Number(process.env.FLOW_CONTEXT_SERVER_INPUT ?? 142074),
      ...(config.context ?? {}),
    },
    tickMs: Number(config.tickMs ?? 250),
    // How long work may sit unchanged before the Auditor and the Orchestrator
    // are told it is stale.
    staleMs: Number(config.staleMs ?? process.env.FLOW_STALE_MS ?? 120_000),
    // How long one turn may stay in flight before the cluster aborts it.
    maxTurnMs: Number(config.maxTurnMs ?? process.env.FLOW_MAX_TURN_MS ?? 900_000),
    heartbeatMs: Number(config.heartbeatMs ?? 20_000),
    leaseTtlMs: Number(config.leaseTtlMs ?? 60_000),
  };
}

// --------------------------------------------------------------- host tools

function registerHostTools(ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'flow_start',
    description: [
      'Start a hierarchical agent cluster on one objective and return its id and initial state.',
      'The cluster decomposes the objective on a management tree (Orchestrator plans, Allocator grants',
      'identities and budgets, Auditor gates plans and results independently, Workers do the work).',
      'Use this when the user asks for a task to be carried out by the cluster; then report progress',
      'with flow_read and steer it with flow_control.',
    ].join(' '),
    parameters: {
      objective: { type: 'string', required: true, description: 'The objective the cluster must achieve, in the user\'s own terms.' },
      workspace: { type: 'string', description: 'Absolute path of the workspace the cluster may write to. Defaults to the deployment workspace.' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Worker capabilities: fs_read, fs_write, shell, web_fetch, browser.' },
      limits: { type: 'json', description: 'Optional limit overrides (max_children, max_depth, max_agents, max_active_agents, max_llm_concurrency, max_attempts, max_corrections).' },
      budget: { type: 'json', description: 'Optional root budget: tokens, model_requests, tool_calls, wall_time_ms, agents, max_active_agents.' },
      initial_transactions: { type: 'array', items: { type: 'json' }, description: 'Optional fixed transaction plan used as a reproducible control-plane baseline.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria for the implied root transaction.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      // A session names the task, not the deployment's filesystem or the
      // envelope shape. The interactive profile is merged *under* whatever the
      // caller sent, so an omitted field still has a workable value: a model
      // that passes `budget: {}` (measured: it did, then cancelled its own
      // cluster as "blocked with zero token budget") does not get an unfunded
      // cluster, and a caller that names `tokens` keeps its own number.
      const snapshot = runtime.start({
        objective: args.objective,
        workspace: args.workspace ?? process.env.FLOW_WORKSPACE ?? process.cwd(),
        capabilities: args.capabilities ?? ['fs_read', 'fs_write'],
        limits: { ...INTERACTIVE_LIMITS, ...(args.limits ?? {}) },
        budget: { ...INTERACTIVE_BUDGET, ...(args.budget ?? {}) },
        initial_transactions: args.initial_transactions,
        acceptance_criteria: args.acceptance_criteria,
      });
      return JSON.stringify({ cluster_id: snapshot.cluster.id, status: snapshot.cluster.status, counts: snapshot.counts });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'flow_read',
    description: 'Read one cluster: state, counts, transactions, budgets, issues and recent events.',
    parameters: {
      id: { type: 'string', required: true },
      include_events: { type: 'boolean' },
      event_limit: { type: 'number' },
      since: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return JSON.stringify(runtime.read(args.id, {
        include_events: args.include_events !== false,
        event_limit: args.event_limit,
        since: args.since,
      }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'flow_control',
    description: 'Control a running cluster: pause (stop dispatching new work), resume, or cancel (fence and abort the whole subtree).',
    parameters: {
      id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel'] },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const snapshot = runtime.control(args.id, args.action);
      return JSON.stringify({ cluster_id: args.id, action: args.action, status: snapshot.cluster.status, counts: snapshot.counts });
    },
  }));
}

// --------------------------------------------------------------- role tools

const ROLE_TOOL_DESCRIPTIONS = {
  flow_transaction: 'Orchestrator: plan, decompose, dispatch, validate and aggregate. Worker: only submit_result for the transaction allocated to you; no planning or delegation actions.',
  flow_allocation: 'Allocator control: agent identity, write scopes, budget ledger, concurrency and scaling inside your own management domain.',
  flow_audit: 'Auditor control: independent plan/validation gates and durable correction requests inside your own management domain.',
};

function registerRoleTools(ctx, runtime) {
  for (const toolName of new Set(Object.values(ROLE_TOOL))) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: ROLE_TOOL_DESCRIPTIONS[toolName],
      parameters: {
        action: { type: 'string', required: true, description: 'The action to perform.' },
        params: { type: 'json', description: 'Action parameters.' },
        expected_revision: { type: 'number', description: 'Optional optimistic concurrency check against the cluster revision.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        if (typeof args.action !== 'string' || !args.action) fail('flow tool requires a string action');
        const resolved = coerceParams(args.params);
        const actor = actorFor(runtime, exec, args);
        runtime.admitFlowCall({ id: actor.agent_id });
        const command_id = commandIdFor({
          session_id: actor.session_id,
          turn_seq: actor.turn_seq,
          tool_call_id: String(exec.callId ?? ''),
        });
        const outcome = runtime.command(actor, {
          command_id, action: args.action, params: resolved, expected_revision: args.expected_revision,
        });
        // A successful management decision changes the pending state. Yield to
        // the scheduler so child roles can act before this session polls their
        // state again. A single Allocator turn previously made 104 provider
        // requests, mostly queries and reminders, after it had already spawned
        // the child it was waiting for. Workers only yield on submit_result:
        // their earlier tool calls are still part of the same task.
        if (outcome.deduped !== true && typeof exec.concludeTurn === 'function'
          && (actor.role !== 'worker' || args.action === 'submit_result')) {
          exec.concludeTurn();
        }
        return JSON.stringify({ ok: true, action: args.action, deduped: outcome.deduped, revision: outcome.revision, result: outcome.result });
      },
    }));
  }

  ctx.tools.register(defineTool({
    name: 'flow_communicate',
    description: 'Cluster communication: send/multicast messages to any agent in the cluster, manage groups, and read or publish blackboard keys.',
    parameters: {
      action: { type: 'string', required: true, enum: COMMUNICATION_ACTIONS },
      params: { type: 'json', description: 'send/multicast: {agent|group|node, content}; group: {operation, name|id, members}; publish: {key, value, expected_revision}; query: {key|prefix}; subscribe: {operation, key|prefix, id}.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      // Read-only queries may run without a turn; every mutation (send,
      // multicast, group, publish, subscribe) is fenced to the captured turn.
      const mutating = args.action !== 'query';
      const actor = actorFor(runtime, exec, args, { requireLease: mutating });
      if (mutating) runtime.assertActorFence(actor, { mutating: true });
      const result = runtime.communicateFrom(actor, args.action, coerceParams(args.params));
      runtime.wake();
      // A management send hands work to another role. Let the scheduler run
      // that recipient before this session polls the same unchanged allocation:
      // continuing immediately once drove a single Orchestrator through 40
      // query steps into its hard identity context limit.
      if (actor.role !== 'worker' && (args.action === 'send' || args.action === 'multicast')
        && result.deduped !== true && typeof exec.concludeTurn === 'function') {
        exec.concludeTurn();
      }
      return JSON.stringify({ ok: true, action: args.action, result });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'flow_query',
    description: 'Read-only cluster state scoped to your domain: cluster, nodes, node, transactions, transaction, agents, allocations, budgets, issues, issue, audits, audit, effects, effect, usage, summary, blackboard. Lists are paged references; transactions {parent_id} filters delegated children. Transaction {id} includes its current result and validation; aggregate child results and historical audit/issue evidence are referenced by id. Read the child transaction {id}, audit {id}, issue {id}, or effect {call_id} for complete evidence.',
    parameters: {
      what: { type: 'string', required: true },
      params: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const actor = actorFor(runtime, exec, args, { requireLease: false });
      return JSON.stringify(runtime.query(actor, args.what, coerceParams(args.params)));
    },
  }));
}

function registerSmokeTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'flow_sum',
    description: 'Add a list of finite numbers. Deterministic local tool used to verify the host tool-call round trip.',
    parameters: { values: { type: 'array', items: { type: 'number' }, required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!Array.isArray(args.values) || args.values.some(value => !Number.isFinite(value))) fail('values must be finite numbers');
      return args.values.reduce((total, value) => total + value, 0);
    },
  }));
}

/**
 * `params` is an open JSON parameter, so a model may legitimately send it as a
 * JSON string; accept that spelling instead of failing the call.
 */
function coerceParams(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      fail('flow tool params must decode to a JSON object');
    } catch (error) {
      fail(`flow tool params is not valid JSON: ${error.message}`);
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) fail('flow tool params must be a JSON object');
  return value;
}

function actorFor(runtime, exec, args, { requireLease = true } = {}) {
  const sessionId = exec.agent?.id;
  if (!sessionId) fail('flow tool requires an executing agent identity', 403);
  const agent = runtime.store.getAgentBySession(sessionId);
  if (!agent) fail('this session is not a cluster agent', 403);
  // The actor is the *turn's* captured identity, never the lease that happens
  // to be live now: borrowing a newer epoch is exactly how a zombie turn would
  // pass fencing.
  const turn = runtime.turnActor(exec.agent);
  if (requireLease) {
    if (!turn) fail('this agent instance does not own a scheduled cluster turn', 409);
    if (turn.agent_id !== agent.id) fail('this turn identity belongs to another agent', 409);
  }
  return {
    cluster_id: agent.cluster_id,
    agent_id: agent.id,
    node_id: agent.node_id,
    role: agent.role,
    epoch: turn?.epoch ?? undefined,
    session_id: agent.session_id,
    turn_seq: turn?.turn_seq ?? agent.turns + 1,
  };
}

// ------------------------------------------------------------- host surface

/**
 * The envelope a cluster started from a page gets when the page names none.
 *
 * Sized for an interactive task rather than a tier: enough tokens and requests
 * for a management tree to decompose, run its Workers and close out, with the
 * Worker request allowance the scheduler needs (the default `0` would refuse a
 * Worker's first request and a `tool_calls`-only task could never submit).
 * Every value is overridable per start; the plan's own runs pass their own.
 */
export const INTERACTIVE_BUDGET = {
  tokens: 2_097_152,
  model_requests: 256,
  tool_calls: 2048,
  wall_time_ms: 900_000,
  agents: 64,
  max_active_agents: 4,
};

export const INTERACTIVE_LIMITS = {
  max_children: 8,
  max_depth: 4,
  max_agents: 64,
  max_active_agents: 4,
  max_llm_concurrency: 2,
  max_attempts: 2,
  max_corrections: 2,
  max_role_turns: 12,
  worker_model_requests: 8,
  worker_max_tokens: 4096,
};

export async function handleHostOp(runtime, message) {
  const { op, id, payload } = message ?? {};
  switch (op) {
    case 'ping':
      return { ok: true, pid: process.pid, data_dir: runtime.config.dataDir };
    case 'start': {
      // A browser session knows the task, not the server's filesystem or the
      // run's envelope. The deployment names its workspace (`FLOW_WORKSPACE`),
      // and a page that omits the envelope gets the interactive profile below
      // rather than an empty one: a cluster started with `budget: {}` and
      // `worker_model_requests: 0` blocks on its very first request with
      // "cannot fund … tokens with 0 remaining", which is not a usable answer to
      // a prompt. Callers that pass their own values are untouched.
      const startPayload = { ...(message?.payload ?? {}) };
      if (startPayload.workspace === undefined || startPayload.workspace === null || startPayload.workspace === '') {
        startPayload.workspace = process.env.FLOW_WORKSPACE ?? process.cwd();
      }
      if (!startPayload.capabilities) startPayload.capabilities = ['fs_read', 'fs_write'];
      if (!startPayload.budget) startPayload.budget = INTERACTIVE_BUDGET;
      if (!startPayload.limits) startPayload.limits = INTERACTIVE_LIMITS;
      return runtime.start(startPayload);
    }
    case 'list':
      return runtime.list(payload ?? {});
    case 'read':
      return runtime.read(id ?? payload?.id, payload ?? {});
    case 'events':
      return runtime.events(id ?? payload?.id, payload ?? {});
    case 'control':
      return runtime.control(id ?? payload?.id, (payload?.action ?? 'pause'));
    case 'report':
      return runtime.report(id ?? payload?.id);
    case 'query':
      return runtime.query({ role: 'user', cluster_id: id ?? payload?.cluster_id }, payload?.what ?? 'cluster', payload?.params ?? {});
    case 'settle': {
      await runtime.runUntilSettled(id ?? payload?.id, {
        timeoutMs: payload?.timeout_ms ?? 3_600_000,
        pollMs: payload?.poll_ms ?? 250,
      });
      return runtime.read(id ?? payload?.id, { include_events: false });
    }
    case 'tick':
      await runtime.tick();
      return runtime.read(id ?? payload?.id, { include_events: false });
    case 'single':
      return runtime.runSingleAgent(payload ?? {});
    case 'recover':
      return runtime.recoverAndReconcile();
    case 'dispose':
      // Disposal drains the live turns before it closes the store: the caller
      // waits for it, or it would answer "disposed" over a runtime still
      // finishing its turns.
      await runtime.dispose();
      return { ok: true };
    default:
      fail(`Unknown flow op: ${String(op)}`);
  }
}

/**
 * The operations the authenticated web route may perform. `settle`, `tick`,
 * `single`, `recover` and `dispose` drive the host itself: they are reachable
 * only through the IPC bridge the runner owns, never from a page — an
 * authenticated browser must not be able to close the database and abort every
 * turn with one POST.
 */
export const BROWSER_OPS = ['ping', 'start', 'list', 'read', 'events', 'control', 'report', 'query'];

async function handleFetch(runtime, request) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      return json(200, { ok: true, op: url.searchParams.get('op') ?? 'ping', clusters: runtime.list({}).clusters });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json(400, { error: 'invalid JSON body' });
    if (!BROWSER_OPS.includes(body.op)) {
      return json(404, { error: `unknown flow op: ${String(body.op)}`, code: 'UNKNOWN_OP' });
    }
    if (body.op === 'query') {
      // A browser client reads as the host user, one page at a time: the panel
      // must not be able to ask for the whole ledger in one request.
      const params = body.payload?.params ?? {};
      if (params.limit !== undefined && Number(params.limit) > 500) {
        return json(400, { error: 'query limit must be at most 500', code: 'LIMIT_TOO_LARGE' });
      }
      const clusterId = body.id ?? body.payload?.cluster_id;
      if (typeof clusterId !== 'string' || !clusterId) {
        return json(400, { error: 'query needs a cluster id', code: 'CLUSTER_REQUIRED' });
      }
    }
    const result = await handleHostOp(runtime, body);
    return json(200, result);
  } catch (error) {
    return json(error?.status ?? 500, { error: String(error?.message ?? error), code: error?.code ?? null });
  }
}

function installIpcBridge(runtime) {
  if (process.env.FLOW_IPC !== '1' || typeof process.send !== 'function') return;
  // A killed runner must not leave an orphaned host holding the workspace,
  // the ports and the cluster database.
  process.on('disconnect', () => {
    // The same drain, awaited, before the process goes: exiting first left the
    // turns' bookkeeping half-written.
    void Promise.resolve(runtime.dispose())
      .catch(error => console.error(String(error?.message ?? error)))
      .finally(() => process.exit(0));
  });
  process.on('message', message => {
    if (!message || message.flow !== true || typeof message.requestId !== 'string') return;
    Promise.resolve()
      .then(() => handleHostOp(runtime, { op: message.op, id: message.cluster, payload: message.payload }))
      .then(result => process.send({ flow: true, requestId: message.requestId, ok: true, result }))
      .catch(error => process.send({
        flow: true, requestId: message.requestId, ok: false,
        error: { message: String(error?.message ?? error), status: error?.status ?? 500, code: error?.code ?? null },
      }));
  });
  process.send({ flow: true, ready: true, pid: process.pid, data_dir: runtime.config.dataDir });
}

export { handleFetch, actorFor, coerceParams };
