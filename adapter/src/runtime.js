/**
 * Runtime: drives real DSH agents for one scheduled turn, accounts every model
 * request and tool call against the hierarchical budget ledger, and keeps a
 * durable effect receipt per side-effecting tool call.
 *
 * There is no second agent loop here: every role and Worker runs through the
 * host's own `ctx.agents` registry.
 */
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { fail } from './store.js';
import { BudgetError, reserveChain, settleChain, releaseChain } from './budget.js';
import { CAPABILITY_PACKAGES, CAPABILITY_PACKAGE_CONFIG, CAPABILITY_TOOLS, FORBIDDEN_WORKER_TOOLS } from './protocol.js';

const SIDE_EFFECT_TOOLS = new Set([
  'write', 'edit', 'bash', 'job_kill', 'job_output',
  'mcp__playwright-mcp__browser_click', 'mcp__playwright-mcp__browser_fill_form',
  'mcp__playwright-mcp__browser_type', 'mcp__playwright-mcp__browser_press_key',
  'mcp__playwright-mcp__browser_navigate',
]);

export const FLOW_SOURCE = { kind: 'flow', form: 'turn' };

/** The native session offset (next event number) of a live instance, or null. */
export function sessionOffset(instance) {
  const seq = instance?.session?.seq;
  return typeof seq === 'number' ? seq : null;
}

/**
 * Measure the durable session through the host's own token meter and, when the
 * measured pressure crosses the configured threshold, ask the host's
 * compaction engine to compact. Nothing here truncates text by hand.
 */
async function measureAndCompact(ctx, live, model, role, signal, logger, contextLimits = {}, { force = false, agent = null } = {}) {
  const meter = ctx.get?.('tokenMeter');
  if (!meter) return null;
  const measure = () => meter.measure(live.session);
  let measurement;
  try {
    // Canonical call: the meter prices the logged envelope together with the
    // live surface, so a partial header override would price neither the tools
    // nor the usage anchor correctly.
    measurement = measure();
  } catch (error) {
    logger?.warn?.(error);
    return null;
  }
  const result = { totalTokens: measurement.totalTokens, logRevision: measurement.logRevision, compacted: false, compaction: null };
  // The cluster patch re-enables the host-plane compaction backend for the
  // sessions this plugin drives (the shipped web bundle keeps it inside the
  // agent preset, which a cluster agent never mounts).
  const compaction = ctx.get?.('compaction') ?? live.ctx?.get?.('compaction');
  if (!compaction) {
    result.compaction_unavailable = true;
    return result;
  }
  // The backend's resolved configuration decides what a summarization request may
  // reserve (its output ceiling) and when it fires. It is reported once per
  // session: the numbers a run is judged on — a 70 k reservation against a 6 k
  // session — are not diagnosable without them.
  if (!ctx.__flowCompactionReported) {
    ctx.__flowCompactionReported = true;
    try {
      ctx.get?.('events')?.emit?.('flow/compaction-config', {
        maxTokens: compaction.config?.maxTokens ?? null,
        headroomTokens: compaction.config?.headroomTokens ?? null,
        thresholdRatio: compaction.config?.thresholdRatio ?? null,
      });
    } catch { /* diagnostics only */ }
  }
  const budget = contextBudget(agent, role, contextLimits);
  // `limit` is the *sending* ceiling: the declared window minus what the model
  // may generate. It is enforced per request in `installRequestAccounting`; here
  // it is the outer yardstick only.
  const limit = budget.window - (model.maxTokens ?? 4096);
  // The measured surface is what the session *carries*: it has no floor derived
  // from the last settled request (that floor made every compaction look
  // ineffective, because the next charge could never fall below the previous
  // one), and it does *not* include the output allowance — that is room the
  // provider needs, not pressure the session holds.
  const measuredTokens = measurement.totalTokens;
  result.request_tokens_estimate = measuredTokens;
  result.sending_estimate = measuredTokens + (model.maxTokens ?? 4096);
  result.sending_ceiling = limit;
  // Compress at the identity's fraction, not at a provider-window fraction:
  // the latter made 0.8 mean 100k tokens for an 8k role budget.
  const trigger = Math.min(budget.limit, Math.max(1, Math.floor(budget.limit * budget.trigger)));
  result.context_budget = budget.limit;
  if (!force && measuredTokens < trigger) return result;
  const abortSignal = signal ?? new AbortController().signal;
  try {
    // Idle compaction is `compactNow`: the automatic path (`compactIfNeeded`)
    // emits compaction events that must be enclosed in an open turn, and this
    // call sits outside one.
    result.maintenance_available = typeof live.runMaintenance === 'function';
    let outcome = null;
    // The host contract is `compactNow(agent, signal, sourceCommandId?)`: it takes
    // the Agent itself and starts its own idle task. Passing a dependency object
    // made the selection read an undefined session and the whole call fail as a
    // summary-stage error.
    if (result.maintenance_available) {
      outcome = await compaction.compactNow(live, abortSignal);
    } else {
      // No idle window available: the policy gate is the only remaining route,
      // and it must run inside a turn.
      outcome = await compaction.compactIfNeeded(live, force ? 'context-overflow' : 'pressure', abortSignal);
    }
    if (outcome) {
      result.compacted = true;
      result.compaction = { compactionId: outcome.compactionId, shadowedTokens: outcome.shadowedTokenCount, summarySeq: outcome.summarySeq };
      const flushed = await ctx.sessions.flush(live.session);
      // A compaction that could not be made durable is reported: the summary
      // exists only in memory and the next turn will pay for it again.
      result.flush_ok = flushed !== false;
      // Re-measure so the reported pressure is the post-compaction one — and so
      // `totalTokens` *is* the size the session has now. Leaving it at the
      // pre-compaction value made the caller's "what did the last compaction
      // leave behind" anchor the size *before* it: the session was then allowed
      // to grow a further `trigger` beyond a number it had already passed, which
      // is how an orchestrator session reached 47k-57k against an 8,192 window
      // while every step reported `proceed-ineffective`.
      try {
        const after = measure();
        result.tokens_after_compaction = after.totalTokens;
        result.request_tokens_estimate = after.totalTokens;
        result.sending_estimate = after.totalTokens + (model.maxTokens ?? 4096);
        result.totalTokens = after.totalTokens;
      } catch (error) {
        logger?.warn?.(error);
      }
    }
  } catch (error) {
    // `busy`, `changed`, `summary` and `cancelled` are the manual-compaction
    // contract's benign refusals; only a persistence or commit failure leaves
    // the session in a state the cluster must surface.
    const code = error?.code;
    // `busy` and `changed` are the contract's concurrency refusals — the next
    // turn retries them. `summary` means compaction ran and could not produce a
    // smaller history, which is exactly the pressure the cluster must not ignore.
    if (code === 'busy' || code === 'changed' || code === 'cancelled') {
      result.compaction_skipped = code;
      if (code === 'cancelled') result.compaction_cancelled = true;
    } else {
      const cause = error?.cause?.message ?? error?.cause ?? null;
      const text = `${error?.message ?? error}${cause ? ` (cause: ${String(cause)})` : ''}`;
      result.compaction_error = `${code ?? 'unknown'}: ${text.slice(0, 400)}`;
      // A summary that could not be produced because the scope had no budget is
      // a budget denial, not a context pathology: naming it keeps the run's
      // classification honest and points at what to widen.
      result.compaction_unfunded = /budget exhausted/i.test(text);
      logger?.warn?.(error);
    }
  }
  return result;
}

/**
 * The effective context budget for one identity: the Allocator's per-agent
 * override (`agents.meta.context`) when it set one, the cluster's declared
 * role/worker budget otherwise, and the provider's own window as the outer
 * sending ceiling.
 */
export function contextBudget(agent, role, contextLimits = {}) {
  const override = agent?.meta?.context ?? null;
  const key = role === 'worker' ? 'worker' : 'role';
  const declared = Number(contextLimits[key]) > 0 ? Number(contextLimits[key]) : Number(contextLimits.role) || 8192;
  const limit = Number(override?.limit) > 0 ? Number(override.limit) : declared;
  const trigger = Number(override?.trigger) > 0
    ? Number(override.trigger)
    : Number(contextLimits.compaction_threshold ?? 0.8);
  return {
    limit,
    trigger,
    window: Math.min(Number(contextLimits.model ?? 131072), Number(contextLimits.server_input ?? 142074)),
  };
}

/**
 * In-turn pressure: a step is measured *before* it is sent, and at the
 * identity's compaction threshold the host gets one chance to shrink its
 * session. A sent request must fit both the identity budget and the provider
 * input ceiling after compaction.
 */
function installContextPressure(agentCtx, { ctx, flow, agent, role, model, contextLimits = {}, logger, turnSeq = 0, turnState: turnStateArg = null, rejections = null }) {
  const turnState = turnStateArg ?? { compacted: false };
  const pendingRejection = rejections ?? new Map();
  agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== 'enter') return decision;
    const meter = ctx.get?.('tokenMeter');
    if (!meter) return decision;
    const budget = contextBudget(agent, role, contextLimits);
    const maxOutput = model.maxTokens ?? 4096;
    const ceiling = budget.window - maxOutput;
    const live = payload.agent ?? null;
    const measure = () => {
      try {
        return Number(meter.measure(live.session).totalTokens);
      } catch (error) {
        logger?.warn?.(error);
        return null;
      }
    };
    // The *input* this step adds. The output allowance is deliberate room the
    // provider needs, not pressure the session carries: counting it against the
    // identity budget rejected ordinary steps whose prompt plus a 4k completion
    // crossed the role budget.
    const pending = estimateTokens({ messages: decision.messages ?? [] });
    const before = measure();
    const pressure = (before ?? 0) + pending;
    const trigger = Math.min(budget.limit, Math.max(1, Math.floor(budget.limit * budget.trigger)));
    const step = Number(payload.step ?? 0);
    const record = (fields) => {
      try {
        flow?.store?.appendEvent(agent.cluster_id, 'context-step', {
          agent_id: agent.id, role, turn_seq: turnSeq, step,
          native_seq: live?.session?.seq ?? null,
          before, after: fields.after ?? before, pending,
          threshold: trigger,
          context_limit: budget.limit, sending_ceiling: ceiling,
          summary_seq: fields.summary_seq ?? null, charged_scope: fields.charged_scope ?? null,
          compacted_at: turnState.compactedAt ?? null,
          decision: fields.decision,
        });
      } catch (error) {
        logger?.warn?.(error);
      }
    };
    // Host/system and tool schemas may be irreducible. A compaction that did not
    // shrink the session is not paid for again until it grows materially, but
    // neither the identity nor provider ceiling may be crossed on any step.
    const sendingLimit = Math.min(budget.limit, ceiling);
    if (pressure < trigger && pressure <= sendingLimit) {
      record({ decision: 'proceed' });
      return decision;
    }
    // One compaction per *shrink cycle*, not one per turn. A session that was
    // compacted and then grew past the trigger again is a session that needs
    // compacting again — that is what a long turn with big tool results looks
    // like, and refusing it let a role session reach 54,614 tokens against an
    // 8,192 budget, so every one of its requests reserved ~40k and a 2M-token
    // case could not finish. A session that did *not* shrink stops here instead:
    // paying for a second attempt that cannot reduce anything is the pathology
    // this rule was added for.
    if (turnState.compacted) {
      const compactedAt = turnState.compactedAt ?? null;
      const grewAgain = compactedAt !== null && pressure >= compactedAt + trigger;
      if (!grewAgain && pressure <= sendingLimit) {
        record({ decision: 'proceed-ineffective' });
        return decision;
      }
    }
    // Over the identity's budget: one compaction attempt, inside the turn, then
    // re-measure. Compaction is funded from its own pool, never from the grant
    // of the session it is about to shrink.
    const compaction = ctx.get?.('compaction') ?? live?.ctx?.get?.('compaction');
    const receiptBefore = Number(flow?.store?.get(
      "SELECT COALESCE(MAX(rowid),0) AS watermark FROM usage_receipts WHERE cluster_id=? AND agent_id=? AND kind='compaction'",
      agent.cluster_id, agent.id)?.watermark ?? 0);
    let summarySeq = null;
    let compactionUnfunded = false;
    if (compaction && live && !payload.signal?.aborted) {
      turnState.compacted = true;
      try {
        const outcome = await compaction.compactIfNeeded(live, 'context-overflow', payload.signal);
        summarySeq = outcome?.summarySeq ?? null;
      } catch (error) {
        // A summary the budget could not pay for is a budget stop, not a context
        // pathology: the reason chain must say so, or the run is classified as a
        // mechanism failure when its cause is an exhausted tier budget.
        compactionUnfunded = /budget exhausted|LIMIT_REACHED/i.test(String(error?.message ?? error));
        if (compactionUnfunded) turnState.compactionUnfunded = true;
        logger?.warn?.(`cluster agent ${agent.id}: step compaction failed: ${error?.message ?? error}`);
      }
    }
    const after = measure();
    const chargedScope = flow?.store?.get(
      `SELECT budget_scope_id FROM usage_receipts
        WHERE cluster_id=? AND agent_id=? AND kind='compaction' AND status='SETTLED' AND rowid>?
        ORDER BY rowid DESC LIMIT 1`, agent.cluster_id, agent.id, receiptBefore)?.budget_scope_id ?? null;
    // Include this step's not-yet-persisted messages against both the
    // identity budget and the provider's declared input ceiling.
    const sending = (after ?? before ?? 0) + pending;
    const stillOver = sending > sendingLimit;
    if (stillOver) {
      record({ decision: 'reject', after, summary_seq: summarySeq, charged_scope: chargedScope });
      // The rejection carries its numbers: a blocked turn must be diagnosable
      // from the report without guessing which limit was crossed.
      payload.signal?.throwIfAborted?.();
      pendingRejection.set(`${agent.cluster_id}:${agent.id}:${step}`, {
        before: after ?? pressure, pending, sending, ceiling, limit: budget.limit,
        exceeded: sending > budget.limit ? 'identity' : 'provider',
        compaction_unfunded: compactionUnfunded,
      });
      return { kind: 'reject' };
    }
    // Remember the size this session was reduced to: growth beyond it is what
    // earns another compaction inside the same turn.
    turnState.compactedAt = after ?? before ?? null;
    record({ decision: summarySeq === null ? 'proceed' : 'compact', after, summary_seq: summarySeq, charged_scope: chargedScope });
    return decision;
  });
}

/**
 * A coarse *input* estimate: characters over four. It measures what the prompt
 * costs, which is what the context budget governs.
 */
export function estimateTokens(value) {
  let chars = 0;
  const add = item => {
    if (typeof item === 'string') chars += item.length;
    else if (Array.isArray(item)) for (const part of item) add(part);
    else if (item && typeof item === 'object') for (const part of Object.values(item)) add(part);
  };
  add(value);
  return Math.ceil(chars / 4);
}

/**
 * Estimated request tokens before send: the input plus the output the request
 * may generate. The output allowance is room the *provider* needs, not pressure
 * the session carries, so the context budget uses {@link estimateTokens} and
 * only the sending ceiling uses this.
 */
export function estimateRequestTokens(options) {
  return estimateTokens({ system: options.system, messages: options.messages, tools: options.tools }) + (options.maxTokens ?? 0);
}

/**
 * Reserve model-request budget and persist the request receipt before send.
 * Synchronous on purpose: the reservation must be durable at the moment the
 * provider call is dispatched, and no SQLite transaction may await IO.
 */
export function reserveLlmRequest(store, { cluster_id, agent_id, node_id, transaction_id, role, kind, model, provider, budgetIds: initialBudgetIds, reservationTokens, turn_seq, maxRequests, fund = null, reselect = null, onShortfall = null }) {
  const requestId = randomUUID();
  // The chain is mutable on purpose: a funding step can make a *different*
  // scope payable (the compaction pool is refilled, the node is not), and
  // charging the scope chosen before that step refused a request the pool could
  // now pay — and, with the node-stop rule, stopped the node for it.
  let budgetIds = initialBudgetIds;
  // An empty chain enforces nothing: `reserveChain([])` succeeds, the request is
  // sent, and its receipt carries no scope — a free request that cannot be
  // settled afterwards. It is refused as a budget failure instead.
  if (!Array.isArray(budgetIds) || !budgetIds.length) {
    const error = new Error(`no budget scope funds a request from ${agent_id}; the request cannot be accounted`);
    error.code = 'LIMIT_REACHED';
    error.scope = node_id ?? agent_id;
    error.dimension = 'model_requests';
    error.requested = 1;
    error.available = 0;
    throw error;
  }
  if (maxRequests && role === 'worker' && kind !== 'compaction') {
    // A hard per-identity ceiling on top of the budget: top-ups must not be able
    // to turn a two-request Worker into an unbounded one.
    const spent = store.countWorkerRequests(cluster_id, agent_id);
    if (spent >= maxRequests) {
      const error = new Error(`worker ${agent_id} reached its ${maxRequests}-request allowance for this task`);
      error.code = 'LIMIT_REACHED';
      throw error;
    }
  }
  store.tx(() => {
    // Funding and reserving happen in one transaction. A gap computed before
    // the transaction, then re-checked after an await, races with whatever the
    // previous request settled in between: the observed failure was a top-up of
    // exactly the gap followed by a refusal that was still 2,802 tokens short.
    const wanted = { tokens: reservationTokens, model_requests: 1 };
    const take = () => {
      // Settlement may exceed a request's reservation. Other scopes still have
      // local grants, but none may send once that actual spend consumed the
      // cluster-wide allowance. Check in the same transaction as the hold.
      const total = store.get(
        `SELECT COALESCE(SUM(tokens_limit),0) AS capacity,
                COALESCE(SUM(tokens_spent),0) AS spent,
                COALESCE(SUM(tokens_reserved),0) AS held
           FROM budgets WHERE cluster_id=?`, cluster_id);
      const available = total.capacity - total.spent - total.held;
      if (available < reservationTokens) {
        const error = new BudgetError(
          `cluster ${cluster_id} cannot fund ${reservationTokens} tokens with ${Math.max(0, available)} remaining`,
        );
        Object.assign(error, {
          scope: cluster_id, scope_kind: 'cluster', dimension: 'tokens',
          requested: reservationTokens, available: Math.max(0, available),
        });
        throw error;
      }
      reserveChain(store, budgetIds, wanted, { label: `${kind} model request` });
    };
    try {
      take();
    } catch (error) {
      if (error?.code !== 'LIMIT_REACHED' || typeof fund !== 'function') throw error;
      if (error.scope_kind === 'cluster') throw error;
      // Recorded before the repair: the ledger must show the shortfall *and* the
      // funding that closed it, not only the refusals nothing could repair.
      onShortfall?.(error, budgetIds);
      const granted = fund(error);
      if (!granted) throw error;
      if (typeof reselect === 'function') {
        const next = reselect(error);
        if (Array.isArray(next) && next.length) budgetIds = next;
      }
      take();
    }
    store.insertUsageReceipt({
      request_id: requestId, cluster_id, agent_id, node_id, transaction_id, role, kind,
      provider, model, status: 'RESERVED', reservation_tokens: reservationTokens, turn_seq, attempt: 1,
      // The exact grant that was charged: settlement, release and recovery must
      // all move budget in the same scope the reservation took it from.
      budget_scope_id: budgetIds?.length === 1 ? budgetIds[0] : null,
    });
  });
  return { request_id: requestId, tokens: reservationTokens };
}

export function settleLlmRequest(store, { cluster_id, reservation, usage, status = 'SETTLED', note }) {
  const actual = usage ? actualTokens(usage) : null;
  const consumed = actual === null ? 0 : actual;
  store.tx(() => {
    // The receipt is the state machine: a replay must not move budget at all,
    // or it would debit whatever reservation is outstanding now.
    const receipt = store.getUsageReceipt(reservation.request_id);
    if (!receipt || receipt.status !== 'RESERVED') return;
    // The scope that was charged is the receipt's own recorded scope, never the
    // caller's current chain: a compaction request must settle against the pool
    // that paid for it.
    const budgetIds = receiptBudgetScope(store, receipt, reservation);
    if (actual === null) {
      // No provider accounting: the request was sent, so its token reservation
      // is *retained* rather than handed back as free capacity. Only the
      // request attempt is consumed. Releasing tokens here would let an
      // unknown-cost request be re-spent.
      settleChain(store, budgetIds, {
        reservedAmounts: { model_requests: 1 },
        consumed: { model_requests: 1 },
      });
      store.settleUsageReceipt(reservation.request_id, {
        status: 'UNKNOWN',
        note: note ?? `no provider usage reported; ${reservation.tokens} tokens retained`,
      });
    } else {
      settleChain(store, budgetIds, {
        reservedAmounts: { tokens: reservation.tokens, model_requests: 1 },
        consumed: { tokens: consumed, model_requests: 1 },
      });
      store.settleUsageReceipt(reservation.request_id, {
        status, prompt_tokens: promptTokens(usage), completion_tokens: usage.outputTokens ?? 0,
        cached_tokens: usage.cacheReadTokens ?? 0, reasoning_tokens: usage.reasoningTokens ?? 0,
        total_tokens: usage.totalTokens ?? consumed,
        overshoot: Math.max(0, consumed - reservation.tokens), note,
      });
    }
  });
  return { consumed, overshoot: actual === null ? 0 : Math.max(0, actual - reservation.tokens) };
}

/**
 * Settle a request whose outcome is unknown. A request that was dispatched may
 * have consumed provider tokens, so its token reservation is retained and only
 * the request attempt is consumed; a request that provably never left the
 * client releases everything.
 */
export function releaseLlmRequest(store, { cluster_id, reservation, note, dispatched = true }) {
  store.tx(() => {
    const receipt = store.getUsageReceipt(reservation.request_id);
    if (!receipt || receipt.status !== 'RESERVED') return;
    // Release where the reservation was actually taken. An account whose scope
    // cannot be resolved is *not* silently debited somewhere else: the hold
    // stays and the caller is told the accounting is uncertain.
    const budgetIds = receiptBudgetScope(store, receipt, reservation);
    if (dispatched) {
      settleChain(store, budgetIds, {
        reservedAmounts: { model_requests: 1 },
        consumed: { model_requests: 1 },
      });
      store.settleUsageReceipt(reservation.request_id, {
        status: 'UNKNOWN',
        note: note ?? `request outcome unknown; ${reservation.tokens} tokens retained`,
      });
    } else {
      releaseChain(store, budgetIds, { tokens: reservation.tokens, model_requests: 1 });
      store.settleUsageReceipt(reservation.request_id, { status: 'NOT_SENT', note: note ?? 'request never reached the provider' });
    }
  });
}

/**
 * The one scope a receipt was charged to. A reservation whose scope is missing,
 * or names a budget that no longer exists, is an accounting defect: the hold is
 * kept and the caller is told, rather than moving money in a scope that never
 * paid it.
 */
function receiptBudgetScope(store, receipt, reservation) {
  if (receipt.budget_scope_id) {
    if (store.getBudget(receipt.budget_scope_id)) return [receipt.budget_scope_id];
    const error = new Error(`ACCOUNTING_UNCERTAIN: receipt ${receipt.request_id} was charged to a scope that no longer exists (${receipt.budget_scope_id})`);
    error.code = 'ACCOUNTING_UNCERTAIN';
    throw error;
  }
  if (receipt.status === 'RESERVED' && reservation?.tokens > 0) {
    const error = new Error(`ACCOUNTING_UNCERTAIN: reserved receipt ${receipt.request_id} carries no budget scope`);
    error.code = 'ACCOUNTING_UNCERTAIN';
    throw error;
  }
  return [];
}

const actualTokens = usage => usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
const promptTokens = usage => (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);

/**
 * Mount the host tool packages one capability needs into the agent's own
 * scope. A package that cannot be resolved is a hard error: silently running
 * without a declared capability would fake support for it.
 */
export async function mountCapabilityTools(agentCtx, { capabilities, logger }) {
  const packages = new Set();
  for (const capability of capabilities ?? []) {
    for (const packageName of CAPABILITY_PACKAGES[capability] ?? []) packages.add(packageName);
  }
  const mounted = [];
  for (const packageName of packages) {
    let module;
    try {
      module = await import(packageName);
    } catch (error) {
      throw Object.assign(new Error(`capability tool package ${packageName} is not loadable: ${error.message}`), { cause: error, phase: 'start' });
    }
    const plugin = module.default ?? module;
    await agentCtx.plugin(plugin, CAPABILITY_PACKAGE_CONFIG[packageName] ?? {});
    mounted.push(packageName);
  }
  if (packages.size && !mounted.length) logger?.warn?.('no capability tool package mounted');
  const missing = missingCapabilityTools(agentCtx, capabilities);
  return { mounted, missing };
}

/**
 * Capability tools the profile does not actually provide are reported, never
 * silently dropped: a declaration without the tool behind it would fake
 * support for the capability.
 */
export function missingCapabilityTools(agentCtx, capabilities) {
  const missing = [];
  for (const capability of capabilities ?? []) {
    for (const name of CAPABILITY_TOOLS[capability] ?? []) {
      let present = false;
      try {
        present = agentCtx.tools.get(name) !== undefined;
      } catch {
        present = false;
      }
      if (!present) missing.push({ capability, tool: name });
    }
  }
  return missing;
}

/**
 * Install one turn's agent-scoped tool policy: visibility restriction over the
 * inherited (global) layer plus a final allowlist guard over *every* tool the
 * scope resolves, including packages mounted into this scope.
 *
 * `restrict` filters only what a scope inherits — a scope's own registrations
 * are exempt by design — so the guard, not the restriction, is the barrier.
 */
export function installToolPolicy(agentCtx, { role, allowedTools, globalTools, onDenied }) {
  const allow = new Set(allowedTools);
  if (globalTools?.length) agentCtx.tools.restrict({ allow: globalTools });
  agentCtx.tools.guard(exec => {
    if (allow.has(exec.name)) return undefined;
    const reason = FORBIDDEN_WORKER_TOOLS.has(exec.name)
      ? `tool ${exec.name} is never available to a cluster ${role}`
      : `tool ${exec.name} is outside this cluster ${role}'s capability set`;
    onDenied?.(exec, reason);
    return reason;
  });
}

/**
 * Run exactly one scheduled turn for one cluster agent and return the durable
 * facts of that turn. The handle is always disposed; the Session is flushed
 * before the caller records its checkpoint.
 */
export async function runTurn(ctx, {
  agent, role, prompt, systemInstructions = null, allowedTools, globalTools, capabilities = [], resume, cwd, model, signal, logger,
  transactionId = null, budgetIds, modelAccounting = true, turnSeq, flow, contextLimits = {}, forceCompact = false,
  onAgentReady, onAdmitted, onFlushed,
}) {
  const collected = { events: [], assistant: [], usage: [], toolCalls: [] };
  const missingReport = [];
  let context = null;
  // Set only once the prompt has really been handed to the native session, so
  // delivery acks can be gated on it.
  let admitted = false;
  const agentOptions = {
    provider: model.provider, model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  };

  const disposeSession = ctx.on('session/event', function (session, event) {
    if (agent.session_id && session.id !== agent.session_id) return;
    collected.events.push(event);
    if (event.type === 'assistant/message') {
      collected.assistant.push(event.data);
      if (event.data.usage) collected.usage.push(event.data.usage);
    }
    if (event.type === 'tool/call') collected.toolCalls.push({ callId: event.data.callId, name: event.data.name });
  });

  // One compaction budget for the whole turn: the pre-turn check and the step
  // check share it, so a turn pays for at most one compaction request.
  const turnState = { compacted: false, compactedAt: null };
  const rejections = new Map();
  const setup = async agentCtx => {
    if (systemInstructions !== null) {
      // The agent scope is recreated on resume, while the native Session keeps
      // its system head. Registering identical instructions here retains them
      // across compaction without appending another copy as a user message on
      // every role turn.
      if (typeof agentCtx.systemPrompt?.section !== 'function') {
        throw new Error('cluster role requires the native system-prompt service');
      }
      agentCtx.systemPrompt.section({
        name: 'dsh-flow:role', order: 100, text: systemInstructions, interpolate: false,
      });
    }
    const mounted = await mountCapabilityTools(agentCtx, { capabilities, logger });
    if (mounted.missing.length) {
      logger?.warn?.(`cluster agent ${agent.id}: capability tools missing after mount: ${mounted.missing.map(entry => `${entry.capability}→${entry.tool}`).join(', ')}`);
      missingReport.push(...mounted.missing);
    }
    installToolPolicy(agentCtx, { role, allowedTools, globalTools });
    // The cluster's own in-turn pressure gate and its per-identity budget: a
    // session that grows *during* a turn must be measured between steps, not
    // only before the turn starts.
    installContextPressure(agentCtx, { ctx, flow, agent, role, model, contextLimits, logger, turnSeq, turnState, rejections });
    if (modelAccounting) installRequestAccounting(agentCtx, ctx, { agent, role, transactionId, budgetIds, model, flow, contextLimits, turnState });
  };

  // The authoritative answer is the session store; `turns > 0` is only the
  // fallback for a host without persistence.
  let resumeSession = resume;
  if (typeof flow?.sessionExists === 'function') {
    const exists = await flow.sessionExists(agent.session_id);
    if (exists !== null) resumeSession = exists;
  }

  let handle;
  try {
    handle = resumeSession
      ? await ctx.agents.resume({ resumeSessionId: agent.session_id, agentOptions, setup })
      : await ctx.agents.create({ sessionId: agent.session_id, meta: cwd ? { cwd } : undefined, agentOptions, setup });
  } catch (error) {
    disposeSession();
    throw Object.assign(new Error(`agent turn could not start: ${error.message}`), { cause: error, phase: 'start' });
  }

  const live = handle.agent;
  // Bind this turn's identity to the live instance before any tool can run.
  onAgentReady?.(live);
  const cancel = () => {
    try {
      live.cancel({ kind: 'hook', reason: 'flow cancelled' });
    } catch (error) {
      logger?.warn?.(error);
    }
  };
  if (signal) signal.addEventListener('abort', cancel, { once: true });

  try {
    if (signal?.aborted) cancel();
    // Compact *before* driving the turn: a session that already overflowed the
    // provider's window must be reduced before the next request is sent.
    context = await measureAndCompact(ctx, live, model, role, signal, logger, contextLimits, { force: forceCompact, agent });
    if (context?.compacted) {
      turnState.compacted = true;
      if (typeof context.totalTokens === 'number') turnState.compactedAt = context.totalTokens;
    }
    live.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: FLOW_SOURCE }));
    admitted = true;
    onAdmitted?.();
    await live.whenIdle();
    // The host returns whether the session really reached its durable store.
    // Treating a rejected flush as success is what let a delivery be acked
    // while the message it carried was not on disk.
    const flushed = await ctx.sessions.flush(live.session);
    onFlushed?.(flushed !== false);
  } finally {
    signal?.removeEventListener('abort', cancel);
    disposeSession();
    try {
      await handle.dispose();
    } catch (error) {
      logger?.warn?.(error);
    }
  }

  // The native offset after the turn, taken from the live instance: the
  // checkpoint records this, not the cluster's own event cursor.
  const nativeSeq = sessionOffset(live);
  const endEvent = [...collected.events].reverse().find(event => event.type === 'turn/end');
  const reason = endEvent?.data?.reason;
  const stopReason = reason?.kind ?? 'unknown';
  const budget = contextBudget(agent, role, contextLimits);
  const pressure = context === null ? null : context.totalTokens / budget.limit;
  const contextPressure = pressure !== null && pressure >= budget.trigger;
  // The host's compaction policy decides when compaction is *needed*: a null
  // result below the model's window means "nothing to do", not "failed". The
  // session is only unusable when it approaches the declared model window and
  // compaction still could not reduce it, or when compaction threw.
  // The outer ceiling is about what the *provider* receives, so it is judged on
  // the sending estimate; the role budget is about what the session carries, so
  // it is judged on the measured surface.
  const hardLimit = budget.window - (model.maxTokens ?? 4096);
  const contextOverBudget = context !== null && (context.sending_estimate ?? context.totalTokens) >= hardLimit;
  const compactionFailed = Boolean(context?.compaction_error);
  // "Compaction could not produce a smaller summary" is a real failure only when
  // the request itself could not be sent: being over the *role* budget is the
  // normal state of a management session on this host, and blocking a cluster
  // for it (observed: `CONTEXT_PRESSURE (compaction could not be funded):
  // orchestrator holds 9089 tokens`) stops work the provider would have served.
  const overSendingCeiling = context !== null && (context.sending_estimate ?? context.totalTokens) >= hardLimit;
  // A rejected step records why, so the turn's own stop detail carries it.
  const rejection = [...rejections.entries()].map(([, value]) => value).pop() ?? null;
  const stopDetail = describeStop(reason);
  if (rejection && stopDetail) stopDetail.info = { ...(stopDetail.info ?? {}), rejection };
  return {
    native_seq: nativeSeq,
    stopDetail,
    missing_capability_tools: missingReport,
    admitted,
    context,
    context_pressure: contextPressure,
    context_over_budget: contextOverBudget,
    context_blocked: (contextOverBudget && !context?.compacted) || (compactionFailed && overSendingCeiling),
    // Which *stop* this is, decided by the producer: an unshrinkable session the
    // budget could not pay to compact is a budget stop, and the durable block
    // must carry that code rather than the symptom's.
    context_code: (contextOverBudget && !context?.compacted) || (compactionFailed && overSendingCeiling)
      ? (context?.compaction_unfunded || /budget exhausted|LIMIT_REACHED/i.test(String(context?.compaction_error ?? ''))
        ? 'BUDGET_EXHAUSTED'
        : 'CONTEXT_PRESSURE')
      : null,
    context_overflowed: Boolean(context?.compaction_error && /overflow/i.test(String(context.compaction_error))),
    events: collected.events,
    assistant: collected.assistant,
    usage: collected.usage,
    toolCalls: collected.toolCalls,
    stopReason,
    completed: stopReason === 'completed',
    finalText: lastAssistantText(collected.assistant),
  };
}

function installRequestAccounting(agentCtx, ctx, { agent, role, transactionId, budgetIds, model, flow, contextLimits = {}, turnState = null }) {
  const store = flow.store;
  agentCtx.on('llm/stream', function (options, next) {
    // `llm/stream` is bound to the LLM runtime, not to an Agent scope: one
    // listener sees every cluster agent's request. Only the request whose
    // session identity is this agent's may be charged here, or concurrent
    // agents would settle the same response more than once.
    if (options.sessionId !== agent.session_id) return next();
    if (options.provider !== model.provider || options.model !== model.model) return next();
    if (options.purpose === 'compaction') {
      // The native summarizer replays the role's system head and tools to
      // reuse its provider prefix. Neither is part of the shadowed history:
      // the system head survives compaction, and tools cannot run inside this
      // auxiliary call. Qwen has returned tool calls or a near-verbatim copy
      // of the static rules instead of a small text checkpoint. Exclude those
      // inputs before estimating/reserving the real summary request. The
      // normal role request keeps the unchanged system head and tools.
      if (options.messages[0]?.role === 'system') options.messages = options.messages.slice(1);
      options.tools = [];
      options.toolHistory = undefined;
      if (model.reasoningEffort === 'off') options.reasoningEffort = 'off';
    }
    const kind = options.purpose === 'compaction' ? 'compaction' : role === 'worker' ? 'worker' : 'role';
    // Compaction has its own request kind and never consumes a Worker's
    // allowance. The payer selector prefers the reserved summary pool for
    // compaction and the owning management grant for ordinary turns.
    const reservationTokens = estimateRequestTokens(options);
    // The pre-dispatch ceiling: a request above what the provider will accept is
    // never sent. Failing here costs one turn with a coded reason; sending it
    // costs a rejected request *and* a turn, and both look the same afterwards.
    const budget = contextBudget(agent, role, contextLimits);
    const ceiling = budget.window - (model.maxTokens ?? 4096);
    if (reservationTokens > ceiling) {
      // Why the session is this big decides which stop it is: a session that
      // could not be compacted because the budget could not pay for the summary
      // — or because the cluster has spent everything — is a budget stop. The
      // provider ceiling is only where it became visible.
      const budgetStarved = turnState?.compactionUnfunded === true;
      const detail = `request of ${reservationTokens} tokens exceeds the sending ceiling ${ceiling} (${kind})`;
      const error = new Error(budgetStarved
        ? `BUDGET: the session could not be compacted: ${detail}`
        : `CONTEXT_PRESSURE: ${detail}`);
      error.code = budgetStarved ? 'BUDGET_EXHAUSTED' : 'CONTEXT_PRESSURE';
      error.requested = reservationTokens;
      error.window = ceiling;
      error.compaction_unfunded = turnState?.compactionUnfunded === true;
      flow?.recordBudgetRefusal?.(agent, `pre-dispatch hard ceiling: ${detail}`, {
        scope: 'context_window', dimension: 'tokens', requested: reservationTokens, available: ceiling,
      });
      throw error;
    }
    // Select after the funder runs inside the reservation transaction: a
    // repaired scope may be newly payable. Every request must reserve its
    // complete envelope against one scope, never a partial chain.
    const selectChain = () => (flow?.budgetChainForAgent?.(
      agent,
      { tokens: reservationTokens, requests: 1, kind },
    ) ?? budgetIds);
    // The funder runs *inside* the reservation transaction, so the gap it
    // closes is the gap the reservation then sees.
    const funder = error => {
      // Every candidate is offered the *complete* envelope, never only the
      // dimension that happened to fail. A refusal names one dimension, but the
      // payer a request needs is the one that can cover both halves, and the repair
      // helpers move only the dimension actually missing: passing
      // `{model_requests: 1}` alone asked a token-rich, request-less node for the
      // one thing it could not give, while the pool that held 23 spare requests and
      // no tokens was never offered the tokens it needed.
      const amounts = { tokens: reservationTokens, model_requests: 1 };
      const poolId = flow?.compactionBudgetId?.(agent.cluster_id) ?? null;
      const selected = selectChain()[0] ?? null;
      const chain = () => flow?.budgetChainForAgent?.(agent, { tokens: reservationTokens, requests: 1, kind }) ?? [];
      // The retry only succeeds if some candidate can cover *both* halves, so the
      // repairs are tried until one of them makes a candidate payable — not once
      // each. A repair that moves one dimension into a scope that still lacks the
      // other leaves the request refused, and stopping there was the original
      // failure: the node gained tokens it already had, while the pool that held
      // the requests was never given the tokens it was missing.
      const payable = chainId => {
        const row = flow?.store?.getBudget?.(chainId);
        if (!row) return false;
        return Number(row.tokens_limit) - Number(row.tokens_spent) - Number(row.tokens_reserved) >= reservationTokens
          && Number(row.requests_limit) - Number(row.requests_spent) - Number(row.requests_reserved) >= 1;
      };
      const selectedIsPool = Boolean(selected && poolId && selected === poolId);
      const repairPool = () => flow?.topUpCompactionPool?.(agent.cluster_id, amounts) ?? null;
      const repairIdentity = () => flow?.topUpBudgetForAgent?.(agent, amounts) ?? null;
      const order = selectedIsPool ? [repairPool, repairIdentity] : [repairIdentity, repairPool];
      let moved = null;
      for (const repair of order) {
        const granted = repair();
        if (!granted) continue;
        moved = moved ?? granted;
        if (chain().some(payable)) return granted;
      }
      return moved;
    };
    const reserve = (budgetIdsForAttempt = selectChain()) => reserveLlmRequest(store, {
      cluster_id: agent.cluster_id, agent_id: agent.id, node_id: agent.node_id,
      transaction_id: transactionId, role, kind, model: options.model, provider: options.provider,
      budgetIds: budgetIdsForAttempt, reservationTokens, turn_seq: agent.turns ?? 0,
      maxRequests: flow?.workerRequestAllowance?.(agent) ?? null,
      // Compaction uses its earmarked pool first, with the owning node as
      // fallback when that pool cannot pay. An unfunded compaction can leave a
      // session above the provider ceiling with no way to shrink it.
      fund: funder,
      reselect: () => selectChain(),
      onShortfall: (shortfall, ids) => flow?.recordBudgetRefusal?.(
        agent,
        `model request short of budget: ${shortfall?.message ?? shortfall}`,
        { ...refusalFacts(shortfall, ids), terminal: false },
      ),
    });
    let reservation;
    try {
      reservation = reserve();
    } catch (error) {
      // A per-identity allowance is final: a top-up must not extend it, and the
      // error already names the identity and the ceiling.
      if (/allowance for this task/.test(String(error?.message))) throw error;
      // A grant that ran dry while the node still holds capacity is a
      // bookkeeping state, not a reason to fail the model request: top up the
      // *gap this request actually needs* once, then retry. Only a refusal that
      // survives that is reported, with the scope and dimension that were short.
      if (error?.code !== 'LIMIT_REACHED' || !flow?.topUpBudgetForAgent) {
        flow?.recordBudgetRefusal?.(agent, `model request refused: ${error?.message ?? error}`, refusalFacts(error, selectChain()));
        throw error;
      }
      const granted = flow.topUpBudgetForAgent(agent, { tokens: reservationTokens, model_requests: 1 });
      // Every refusal is recorded with the scope and dimension that were short —
      // including one a top-up then repaired, so the ledger shows the repair
      // rather than only the ones that failed.
      flow?.recordBudgetRefusal?.(agent, `model request refused: ${error?.message ?? error}`, refusalFacts(error, selectChain()));
      if (!granted) {
        // The top-up did not cover the gap: this identity cannot pay for its
        // next request from anywhere it is allowed to draw on. That is a stop,
        // not a per-turn error — measured: 49 of 63 role turns in one recursion
        // run ended in `error ... budget exhausted` while the cluster kept
        // scheduling turns that could never be funded.
        // The whole envelope, not the dimension that happened to fail: what a
        // resume must make affordable is the request this identity could not send.
        flow?.blockNodeOnBudget?.(agent, `model request refused: ${error?.message ?? error}`, {
          dimension: error?.dimension ?? null, requested: error?.requested ?? null,
          envelope: { tokens: reservationTokens, model_requests: 1, tool_calls: 0 },
        });
        throw error;
      }
      try {
        reservation = reserve(selectChain());
      } catch (retryError) {
        flow?.recordBudgetRefusal?.(agent, `model request refused after a top-up of ${JSON.stringify(granted)}: ${retryError?.message ?? retryError}`, refusalFacts(retryError, selectChain()));
        flow?.blockNodeOnBudget?.(agent, `model request refused after a top-up of ${JSON.stringify(granted)}: ${retryError?.message ?? retryError}`, {
          dimension: retryError?.dimension ?? null, requested: retryError?.requested ?? null,
          envelope: { tokens: reservationTokens, model_requests: 1, tool_calls: 0 },
        });
        throw retryError;
      }
    }
    let inner;
    try {
      inner = next();
    } catch (error) {
      // The dispatch itself failed: provably nothing was sent. Release in the
      // scope that was charged (`chain`), not the caller's ordinary chain.
      releaseLlmRequest(store, {
        cluster_id: agent.cluster_id, reservation, dispatched: false,
        note: `dispatch failed: ${error?.message ?? error}`,
      });
      throw error;
    }
    return (async function* accounted() {
      let settled = false;
      // The usage chunk is buffered, not settled on: the harness emits usage
      // *before* the terminal `finish` chunk, and on a transport failure that
      // usage is a zeroed object built from pi-ai's initialised message — not a
      // provider report. Settling it would hand a dispatched request's token
      // hold back as free capacity, which is exactly what `settleLlmRequest`
      // refuses to do for a request whose cost is unknown.
      let reported = null;
      try {
        for await (const chunk of inner) {
          if (chunk.type === 'usage') {
            reported = chunk.usage;
          } else if (chunk.type === 'finish' && !settled) {
            settled = true;
            const failure = chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted' ? chunk.reason : null;
            if (failure && !reportsTokens(reported)) {
              // The request reached the provider and failed without accounting;
              // the hold is retained (UNKNOWN), never released as free capacity.
              releaseLlmRequest(store, {
                cluster_id: agent.cluster_id, reservation, dispatched: true,
                note: `request failed after dispatch (${failure.kind}${failure.failure?.code ? `: ${failure.failure.code}` : ''}) without provider usage; ${reservation.tokens} tokens retained`,
              });
            } else {
              settleLlmRequest(store, { cluster_id: agent.cluster_id, reservation, usage: reported ?? undefined });
            }
          }
          yield chunk;
        }
      } catch (error) {
        if (!settled) {
          releaseLlmRequest(store, {
            cluster_id: agent.cluster_id, reservation, dispatched: true,
            note: `request failed after dispatch: ${error?.message ?? error}`,
          });
          settled = true;
        }
        throw error;
      } finally {
        if (!settled) {
          // A stream that ended without a terminal chunk: the buffered usage (if
          // any) is the request's own report, otherwise the cost is unknown and
          // the hold is retained. Both are settled here rather than left RESERVED.
          if (reportsTokens(reported)) {
            settleLlmRequest(store, { cluster_id: agent.cluster_id, reservation, usage: reported });
          } else {
            releaseLlmRequest(store, {
              cluster_id: agent.cluster_id, reservation, dispatched: true,
              note: reported ? 'stream ended without a finish reason' : 'stream ended without usage',
            });
          }
        }
      }
    })();
  });
}

/**
 * Whether a usage object is a provider report rather than the zeroed object a
 * failed stream carries. Any non-zero dimension counts: a response that
 * genuinely cost nothing is indistinguishable from a missing report, and the
 * safe reading of an unknown cost is to keep the hold.
 */
export function reportsTokens(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .some(key => Number(usage[key] ?? 0) > 0);
}

/**
 * The structured facts behind a budget refusal: the scope that was short, the
 * dimension, and what was asked for against what was available. Free text is
 * not evidence, so a refusal without these is not a refusal the ledger can act
 * on.
 */
function refusalFacts(error, chain) {
  return {
    scope: error?.scope ?? (Array.isArray(chain) && chain.length === 1 ? chain[0] : null),
    dimension: error?.dimension ?? 'model_requests',
    requested: error?.requested ?? null,
    available: error?.available ?? null,
  };
}

/** Human-readable detail for a TurnEndReason, so a failed turn is diagnosable. */
function describeStop(reason) {
  if (!reason) return null;
  if (reason.error) {
    const failure = reason.error;
    return { kind: reason.kind, message: failure.message ?? String(failure), code: failure.code ?? null, info: failure.info ?? null };
  }
  if (reason.reason) return { kind: reason.kind, ...reason.reason };
  return { kind: reason.kind };
}

function lastAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.message?.content ?? [];
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

/**
 * Host tool pipeline hook: hard tool-call quota, durable effect receipt before
 * the side effect, and result capture after it.
 */
export function createToolExecutionHook(deps) {
  const { ctx, store, lookupAgent, recordEvent, logger } = deps;
  return async function flowToolExecution(exec, next) {
    if (exec.parent !== undefined) return next();
    const sessionId = exec.agent?.id;
    if (!sessionId) return next();
    const agent = lookupAgent(sessionId);
    if (!agent) return next();
    // Cluster control-plane calls are metered like any other tool call: the
    // `tool_calls` budget covers them, while the durable *effect* receipt stays
    // reserved for tools with an external effect.

    // The host's call id is the durable identity of this tool call — the receipt
    // key, the effect key and the fencing key all read it. Substituting one when
    // it is missing would make every retry a *new* effect with no record of the
    // first, so a call without a stable id is refused before any reservation.
    const callId = typeof exec.callId === 'string' && exec.callId ? exec.callId : null;
    if (!callId) {
      try {
        recordEvent(agent.cluster_id, 'tool-call-refused', {
          agent_id: agent.id, tool: exec.name ?? null, code: 'TOOL_IDENTITY_MISSING',
          reason: 'the host did not provide a stable callId; the call cannot be receipted or fenced',
        });
      } catch (error) {
        logger?.warn?.(error);
      }
      return toolError('Error: the tool call carries no stable host call id, so it cannot be recorded or fenced', 'TOOL_IDENTITY_MISSING');
    }
    let admitted;
    try {
      admitted = deps.beforeTool(agent, exec, callId);
    } catch (error) {
      if (error?.code === 'LIMIT_REACHED') {
        return toolError(`Error: cluster budget exhausted for tool calls: ${error.message}`, 'TOOL_CALL_QUOTA');
      }
      return toolError(`Error: ${error?.message ?? error}`, 'FLOW_TOOL_GATE');
    }
    if (!admitted.ok) return toolError(`Error: ${admitted.reason}`, 'TOOL_CALL_DENIED');

    // Whether `next()` really started decides what the error path is allowed to
    // do with the quota: a call that never dispatched is released, never charged.
    let started = false;
    try {
      // A tool call may only be dispatched once its turn's session is durable.
      // The host answers with a boolean; a rejected flush means the effect would
      // land with no record of what authorised it, so it is refused and its
      // reservation returned without charging. A flush that *throws* is the same
      // fact: the trail is not durable, so the call must not run — falling through
      // to the outer handler charged it as if it had.
      let flushed = false;
      try {
        flushed = await ctx.sessions.flush(exec.agent.session);
      } catch (error) {
        logger?.warn?.(error);
        try { deps.refuseTool?.(agent, exec, callId, `the turn session could not be flushed: ${error?.message ?? error}`); } catch (nested) { logger?.warn?.(nested); }
        return toolError('Error: the turn session could not be flushed before this tool call', 'TOOL_CALL_UNFLUSHED');
      }
      if (flushed === false) {
        try { deps.refuseTool?.(agent, exec, callId, 'the turn session could not be flushed'); } catch (error) { logger?.warn?.(error); }
        return toolError('Error: the turn session could not be flushed before this tool call', 'TOOL_CALL_UNFLUSHED');
      }
      if (exec.signal.aborted) {
        // The call never dispatched: hand the reservation back without charging.
        try { deps.refuseTool?.(agent, exec, callId, 'cancelled before dispatch'); } catch (error) { logger?.warn?.(error); }
        return toolError('Error: tool call cancelled before dispatch', 'TOOL_CANCELLED');
      }
      // The lease was validated before an awaited flush. A lease that expired or
      // was replaced during that await must not execute: the effect would land
      // under a fence that no longer belongs to this instance.
      let stillOwned = null;
      try {
        stillOwned = deps.recheckTool?.(agent, exec, callId) ?? null;
      } catch (error) {
        try { deps.refuseTool?.(agent, exec, callId, 'lease lost during flush'); } catch (nested) { logger?.warn?.(nested); }
        return toolError(`Error: ${error?.message ?? error}`, 'TOOL_CALL_FENCED');
      }
      if (stillOwned && stillOwned.ok === false) {
        try { deps.refuseTool?.(agent, exec, callId, stillOwned.reason); } catch (error) { logger?.warn?.(error); }
        return toolError(`Error: ${stillOwned.reason}`, 'TOOL_CALL_FENCED');
      }
      // Past this fence the tool really dispatches: from here on the call is
      // consumed even if it fails. Recording that dispatch is part of the fence —
      // if it cannot be recorded, the call must not run, or a real effect would
      // exist with nothing but an ADMITTED receipt behind it.
      try {
        deps.dispatched?.(agent, exec, callId);
      } catch (error) {
        logger?.warn?.(error);
        try { deps.refuseTool?.(agent, exec, callId, `the dispatch could not be recorded: ${error?.message ?? error}`); } catch (nested) { logger?.warn?.(nested); }
        return toolError('Error: the tool call could not be recorded as dispatched, so it was not run', 'TOOL_CALL_UNDISPATCHED');
      }
      started = true;
      const result = await next();
      try {
        deps.afterTool(agent, exec, callId, result);
      } catch (error) {
        logger?.warn?.(error);
      }
      return result;
    } catch (error) {
      // Only a call that really started is charged for the failure; one that never
      // dispatched hands its reservation back.
      try {
        if (started) deps.afterTool(agent, exec, callId, null, error);
        else deps.refuseTool?.(agent, exec, callId, `the call failed before dispatch: ${error?.message ?? error}`);
      } catch (nested) {
        logger?.warn?.(nested);
      }
      throw error;
    }
  };
}

export function effectTool(name) {
  return SIDE_EFFECT_TOOLS.has(name) || name.startsWith('mcp__playwright-mcp__browser_');
}

export function toolError(text, code) {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    error: { message: text, info: { name: 'FlowToolError', code } },
  };
}

export { fail, settleChain, reserveChain };