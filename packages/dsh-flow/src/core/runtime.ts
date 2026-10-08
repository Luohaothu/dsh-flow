/**
 * Runtime: drives real DSH agents for one scheduled turn, projects native session usage, enforces tool
 * call quotas against the hierarchical budget ledger, and keeps a
 * durable effect receipt per side-effecting tool call.
 *
 * There is no second agent loop here: every role and Worker runs through the
 * host's own `ctx.agents` registry.
 */
import { ReasoningEffortId, createUserMessage, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionEventMap, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { ContentBlock, TextBlock, TokenUsage, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolDispatchExecution, ToolExecution, ToolExecutionFailure, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
// Type-only imports for the context declarations of the optional service
// providers this module uses; none of them is a runtime dependency of the seam.
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-token-meter';

import { fail } from '../errors.ts';
import { reserveChain, settleChain } from './budget.ts';
import type { AgentRecord, FlowLogger, FlowModelSelection } from './model.ts';
import type { FlowAgentRole, FlowCapability } from '../types.ts';
import type { ClusterStore } from './store.ts';
import type { NativeContextSnapshot } from './native-usage.ts';
import { validateModelSelection } from './model-selection.ts';
import { CAPABILITY_PACKAGES, CAPABILITY_PACKAGE_CONFIG, CAPABILITY_TOOLS, FORBIDDEN_WORKER_TOOLS } from './protocol.ts';
import type { FlowCommunicationSource } from '../messages.ts';

const SIDE_EFFECT_TOOLS = new Set([
  'write', 'edit', 'bash', 'job_kill', 'job_output',
  'mcp__playwright-mcp__browser_click', 'mcp__playwright-mcp__browser_fill_form',
  'mcp__playwright-mcp__browser_type', 'mcp__playwright-mcp__browser_press_key',
  'mcp__playwright-mcp__browser_navigate',
]);

/** Source of subsequent runtime scheduling prompts; the initial task is user input. */
export const FLOW_SOURCE = { kind: 'flow' } as const;

// The host's message-source vocabulary is merge-extensible: a producer declares
// its own `kind` in its own module. Scheduling and communication after the
// initial task keep their producer identity instead of inventing human input.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    flow: { kind: 'flow' };
    'flow-message': FlowCommunicationSource;
  }
}

// -------------------------------------------------------------- shared shapes

/** One capability a mounted profile could not back with a real tool. */
export interface CapabilityToolGap {
  readonly capability: FlowCapability
  readonly tool: string
}

/** Error fields the tool seam reads from accounting failures. */
interface CodedError extends Error {
  readonly code?: string
}

/** The structured reason a turn stopped; free text is not evidence. */
export interface TurnStopDetail {
  kind: string
  message?: string
  code?: string | null
  info?: Record<string, unknown> | null
}

/** One assistant message event collected during a turn. */
type AssistantTurnEvent = SessionEventMap['assistant/message'];

/** One tool call the model requested during a turn. */
export interface TurnToolCall {
  readonly callId: ToolCallId
  readonly name: string
}

/** The durable facts one `runTurn` call produced. */
export interface TurnOutcome {
  readonly native_seq: number | null
  readonly stopDetail: TurnStopDetail | null
  readonly missing_capability_tools: readonly CapabilityToolGap[]
  readonly admitted: boolean
  readonly events: readonly SessionEvent[]
  readonly assistant: readonly AssistantTurnEvent[]
  readonly usage: readonly TokenUsage[]
  readonly toolCalls: readonly TurnToolCall[]
  readonly stopReason: string
  readonly completed: boolean
  readonly finalText: string
}

/** The narrow slice of the cluster runtime that the turn seam depends on. */
export interface FlowRuntimeHost {
  readonly store: ClusterStore
  sessionExists?(sessionId: string): Promise<boolean | null>
}

/** Resource grants retained for tools, identities and scheduling. */
export interface LedgerAmounts {
  readonly tool_calls?: number
  readonly agents?: number
  readonly max_active_agents?: number
}

/** The facts one budget refusal records on the ledger. */
export interface BudgetRefusalFacts {
  readonly scope?: string | null
  readonly dimension?: string | null
  readonly requested?: number | null
  readonly available?: number | null
  readonly terminal?: boolean
}

/** The facts one node stop records on the ledger. */
export interface BudgetBlockFacts {
  readonly dimension?: string | null
  readonly requested?: number | null
  readonly envelope?: { readonly tool_calls: number } | null
}

/** Options for {@link mountCapabilityTools}. */
export interface MountCapabilityOptions {
  readonly capabilities: readonly FlowCapability[]
  /** The native Agent is the scope key, even across separately installed packages. */
  readonly scope: Agent
  readonly logger?: FlowLogger | undefined
}

/** What {@link mountCapabilityTools} mounted and what stayed missing. */
export interface MountedCapabilities {
  readonly mounted: string[]
  readonly missing: CapabilityToolGap[]
}

/** Options for {@link installToolPolicy}. */
export interface ToolPolicyOptions {
  readonly role: FlowAgentRole
  readonly allowedTools: readonly string[]
  readonly globalTools: readonly string[]
  readonly onDenied?: ((exec: Readonly<ToolExecution>, reason: string) => void) | undefined
}

/** The result of the pre-dispatch admission check. */
export interface ToolAdmission {
  readonly ok: boolean
  readonly reason?: string
}

/** The dependencies the host tool pipeline hook is assembled from. */
export interface ToolExecutionHookDeps {
  readonly ctx: Context
  readonly store: ClusterStore
  readonly logger?: FlowLogger | undefined
  readonly lookupAgent: (sessionId: string) => AgentRecord | null | undefined
  readonly beforeTool: (agent: AgentRecord, exec: ToolDispatchExecution, callId: string) => ToolAdmission
  readonly afterTool: (agent: AgentRecord, exec: ToolDispatchExecution, callId: string, result: ToolExecutionResult | null, error?: unknown) => void
  readonly recheckTool: (agent: AgentRecord, exec: ToolDispatchExecution, callId: string) => ToolAdmission | null | undefined
  readonly dispatched: (agent: AgentRecord, exec: ToolDispatchExecution, callId: string) => void
  readonly refuseTool: (agent: AgentRecord, exec: ToolDispatchExecution, callId: string, reason?: string) => void
  readonly recordEvent: (clusterId: string, type: string, data: Record<string, unknown>) => void
}

/** Options for {@link runTurn}. */
export interface RunTurnOptions {
  readonly agent: AgentRecord
  readonly role: FlowAgentRole
  readonly prompt: string
  /** Individually attributed deliveries, admitted in the same native step. */
  readonly messages?: readonly UserMessage[] | undefined
  readonly systemInstructions?: string | null | undefined
  readonly allowedTools: readonly string[]
  readonly globalTools: readonly string[]
  readonly capabilities?: readonly FlowCapability[] | undefined
  readonly resume: boolean
  readonly cwd?: string | null | undefined
  readonly model: FlowModelSelection
  readonly signal?: AbortSignal | undefined
  readonly logger?: FlowLogger | undefined
  readonly transactionId?: string | null | undefined
  readonly turnSeq: number
  readonly flow: FlowRuntimeHost
  readonly onAgentReady?: ((agent: Agent) => void) | undefined
  readonly onAdmitted?: (() => void) | undefined
  readonly onFlushed?: ((durable: boolean) => void) | undefined
  readonly setup?: (agentCtx: Context) => void | Promise<void>
}

// -------------------------------------------------------------------- helpers

/** Session lineage follows recorded creation ownership, never the workspace name. */
export function nativeSessionParent(store: ClusterStore, agent: AgentRecord): { parentSession?: ReturnType<typeof SessionId> } {
  const meta = recordOf(agent.meta);
  const parentId = typeof meta.parent_agent_id === 'string' ? meta.parent_agent_id
    : typeof meta.allocated_by === 'string' ? meta.allocated_by : null;
  const parent = parentId ? store.getAgent(parentId)?.session_id : null;
  const owner = store.get('SELECT main_session_id FROM team_runs WHERE run_id=?', agent.cluster_id)?.main_session_id;
  const id = parent ?? (typeof owner === 'string' ? owner : null);
  return id ? { parentSession: SessionId(id) } : {};
}

/** A plain copy of an already-validated JSON object, or an empty one. */
function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

/** Narrow a caught value to an Error carrying this seam's own fields. */
function errorFields(value: unknown): CodedError | null {
  return value instanceof Error ? value : null;
}

/** Render a caught value for a message, without assuming it is an Error. */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** The native session offset (next event number) of a live instance, or null. */
export function sessionOffset(instance: Agent | null | undefined): number | null {
  const seq = instance?.session?.seq;
  return typeof seq === 'number' ? seq : null;
}

/** The declared plugin config for each capability package, keyed by specifier. */
const PACKAGE_CONFIGS: Record<string, unknown> = { ...CAPABILITY_PACKAGE_CONFIG };

/** How long one capability package may take to activate before its tools count as absent. */
const CAPABILITY_MOUNT_SETTLE_MS = 5_000;

/**
 * Wait for one mounted plugin fiber to finish loading, bounded.
 *
 * `ctx.plugin()` returns as soon as the fiber exists; a package whose injected
 * services are not all live yet stays PENDING and registers nothing. Waiting
 * for the fiber to settle is what makes the gap check mean "this host does not
 * provide the tool" instead of "the mount has not finished yet". The wait is
 * bounded because a capability this host can never activate is a gap to report,
 * not a reason to hold a turn open.
 * @param fiber - the fiber `ctx.plugin` returned.
 * @param timeoutMs - longest wait before the capability is judged unavailable.
 */
async function settleCapabilityFiber(fiber: Fiber, timeoutMs: number): Promise<void> {
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(() => deadline.resolve(), timeoutMs);
  try {
    await Promise.race([
      fiber.await().then(() => undefined, () => undefined),
      deadline.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a declared capability may stay unserved after the Agent is published.
 *
 * A profile provider may register a capability's tools when the Agent is
 * published rather than when it is created — the browser MCP provider mounts its
 * session tools on `agent/created` — so the set can only be judged after
 * publication, and only with a bounded wait.
 */
const CAPABILITY_PUBLISH_SETTLE_MS = 15_000;

/**
 * Wait, bounded, for every declared capability's tools to resolve in one scope.
 * Returns the gaps that remain, so the caller refuses before the prompt.
 * @param agentCtx - the agent-scope context whose view is judged.
 * @param capabilities - the capability set the turn declared.
 * @param timeoutMs - longest wait before the gaps are treated as final.
 */
async function awaitCapabilityTools(agentCtx: Context, capabilities: readonly FlowCapability[], scope: Agent, timeoutMs: number): Promise<CapabilityToolGap[]> {
  let gaps = missingCapabilityTools(agentCtx, capabilities, scope);
  if (gaps.length === 0) return gaps;
  const deadline = Date.now() + timeoutMs;
  while (gaps.length > 0 && Date.now() < deadline) {
    // The provider's own mount is asynchronous and offers no completion signal
    // through this seam, so the wait is a bounded poll of the resolved view.
    await new Promise(resolve => setTimeout(resolve, 100));
    gaps = missingCapabilityTools(agentCtx, capabilities, scope);
  }
  return gaps;
}

/**
 * Mount the host tool packages one capability needs into the agent's own
 * scope. A package that cannot be resolved is a hard error: silently running
 * without a declared capability would fake support for it.
 *
 * The specifier is selected at run time from `CAPABILITY_PACKAGES`, so a static
 * import cannot express it: which packages a turn needs depends on the
 * capability set its allocation carries.
 */
export async function mountCapabilityTools(agentCtx: Context, { capabilities, scope, logger }: MountCapabilityOptions): Promise<MountedCapabilities> {
  const packages = new Set<string>();
  for (const capability of capabilities ?? []) {
    for (const packageName of CAPABILITY_PACKAGES[capability] ?? []) packages.add(packageName);
  }
  const mounted: string[] = [];
  for (const packageName of packages) {
    let module;
    try {
      module = await import(packageName);
    } catch (caught) {
      throw Object.assign(new Error(`capability tool package ${packageName} is not loadable: ${errorMessage(caught)}`), { cause: caught, phase: 'start' });
    }
    const plugin = module.default ?? module;
    const fiber = agentCtx.plugin(plugin, PACKAGE_CONFIGS[packageName] ?? {});
    mounted.push(packageName);
    // A plugin whose injected services are all live registers its tools right
    // away; one that is still PENDING registers nothing yet, and only then is it
    // worth waiting for the fiber to settle. The wait is bounded because a
    // capability this host can never activate is a gap to report, not a reason
    // to hold a turn open.
    if (missingCapabilityTools(agentCtx, capabilities, scope).length > 0) {
      await settleCapabilityFiber(fiber, CAPABILITY_MOUNT_SETTLE_MS);
    }
  }
  if (packages.size && !mounted.length) logger?.warn?.('no capability tool package mounted');
  const missing = missingCapabilityTools(agentCtx, capabilities, scope);
  return { mounted, missing };
}

/**
 * Capability tools the profile does not actually provide are reported, never
 * silently dropped: a declaration without the tool behind it would fake
 * support for the capability.
 */
export function missingCapabilityTools(agentCtx: Context, capabilities: readonly FlowCapability[], scope: Agent): CapabilityToolGap[] {
  const missing: CapabilityToolGap[] = [];
  // The tool registry is ONE service with scope-keyed layers, and `get(name)`
  // without a scope reads the *global* layer only — which never holds a tool
  // registered into an agent's own scope (or into the preset scope above it).
  // The viewing scope is what makes this probe the surface the agent can really
  // call: dispatch resolves through the same scoped view.
  const present = (name: string): boolean => {
    try {
      return agentCtx.tools.get(name, scope) !== undefined;
    } catch {
      return false;
    }
  };
  for (const capability of capabilities ?? []) {
    const tools = CAPABILITY_TOOLS[capability] ?? [];
    // Every tool a declared capability maps to must be there before the prompt
    // is submitted. A capability served only in part is *not* an answer the
    // model can rely on: it would call the missing tool and fail mid-turn. The
    // gap is named per capability→tool, and the turn is refused rather than
    // pretending a capability the host does not serve.
    for (const tool of tools) {
      if (!present(tool)) missing.push({ capability, tool });
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
export function installToolPolicy(agentCtx: Context, { role, allowedTools, globalTools, onDenied }: ToolPolicyOptions): void {
  const allow = new Set(allowedTools);
  // The restriction is installed unconditionally: an empty intersection is a
  // real answer ("this agent inherits no global tool"), and skipping it is what
  // lets a scoped tool leak into an agent that has none.
  agentCtx.tools.restrict({ allow: globalTools });
  agentCtx.tools.guard(exec => {
    if (allow.has(exec.name)) return undefined;
    const reason = FORBIDDEN_WORKER_TOOLS.has(exec.name)
      ? `tool ${exec.name} is never available to a cluster ${role}`
      : `tool ${exec.name} is outside this cluster ${role}'s capability set`;
    onDenied?.(exec, reason);
    return reason;
  });
}

/** Consume native event facts through the same atomic, idempotent projection. */
export function projectNativeSessionUsage(
  store: ClusterStore,
  agent: AgentRecord,
  events: readonly SessionEvent[],
  transactionId: string | null = null,
  contextSnapshot?: NativeContextSnapshot,
): void {
  store.projectNativeUsage({
    clusterId: agent.cluster_id, nodeId: agent.node_id, agentId: agent.id,
    role: agent.role, nativeSessionId: agent.session_id, events,
    ...(transactionId === null ? {} : { transactionId }),
    ...(contextSnapshot === undefined ? {} : { contextSnapshot }),
  });
}

/** Read the host's existing context display, without measuring or resolving models. */
function nativeContextSnapshot(ctx: Context, session: Agent['session']): NativeContextSnapshot | undefined {
  const projections = ctx.get('sessionProjections');
  if (projections === undefined) return undefined;
  const snapshot = projections.snapshot(session, ['contextPressure']);
  const pressure = snapshot.values.contextPressure;
  if (pressure === undefined || snapshot.asOfSeq < 0) return undefined;
  return { nativeSeq: snapshot.asOfSeq, ...pressure };
}

/**
 * Run exactly one scheduled turn for one cluster agent and return the durable
 * facts of that turn. The handle is always disposed; the Session is flushed
 * before the caller records its checkpoint.
 */
export async function runTurn(ctx: Context, options: RunTurnOptions): Promise<TurnOutcome> {
  const {
    agent, role, prompt, messages = [], systemInstructions = null, allowedTools, globalTools, capabilities = [], resume, cwd, model, signal, logger,
    transactionId = null, flow,
    onAgentReady, onAdmitted, onFlushed, setup: setupScope,
  } = options;
  signal?.throwIfAborted();
  const collected: { events: SessionEvent[]; assistant: AssistantTurnEvent[]; usage: TokenUsage[]; toolCalls: TurnToolCall[] } = {
    events: [], assistant: [], usage: [], toolCalls: [],
  };
  const missingReport: CapabilityToolGap[] = [];
  // The agent-scope context, captured by the setup callback: the capability set
  // is judged through its view *after* publication, because a profile provider
  // may register a capability's tools when the Agent is published.
  let scopeCtx: Context | null = null;
  // Set only once the prompt has really been handed to the native session, so
  // delivery acks can be gated on it.
  let admitted = false;
  let taskPrompt: UserMessage | null = null;
  const selectedModel = validateModelSelection(model, 'agent model');
  const agentOptions: AgentOptions = {
    ...(selectedModel.provider === undefined ? {} : { provider: selectedModel.provider }),
    ...(selectedModel.model === undefined ? {} : { model: selectedModel.model }),
    ...(selectedModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selectedModel.reasoningEffort) }),
  };

  // Event notifications are the host's append stream; project only after its
  // durability barrier succeeds. The queued barrier also exposes persisted
  // incremental usage during a long turn without wrapping model requests.
  let projection: Promise<void> = Promise.resolve();
  const project = (session: Agent['session']): void => {
    projection = projection.then(async () => {
      const cursor = flow.store.nativeUsageCursor(session.id);
      const events = typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents(SessionLogOffset((cursor ?? -1) + 1))
        : collected.events.filter(event => event.seq > (cursor ?? -1));
      const snapshot = nativeContextSnapshot(ctx, session);
      const durable = await ctx.sessions.flush(session);
      if (durable === false) return;
      projectNativeSessionUsage(flow.store, agent, events, transactionId, snapshot);
    }).catch(error => { logger?.warn?.(error); });
  };
  const disposeSession = ctx.on('session/event', (session, event) => {
    if (agent.session_id && session.id !== agent.session_id) return;
    collected.events.push(event);
    if (event.type === 'assistant/message') {
      collected.assistant.push(event.data);
      if (event.data.usage) collected.usage.push(event.data.usage);
    } else if (event.type === 'assistant/attempt') {
      const usage = lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
      if (usage) collected.usage.push(usage);
    } else if (event.type === 'compaction/summary' && event.data.usage) {
      collected.usage.push(event.data.usage);
    }
    if (event.type === 'tool/call') collected.toolCalls.push({ callId: event.data.callId, name: event.data.name });
    project(session);
  });

  const setup = async (agentCtx: Context, nativeAgent: Agent): Promise<void> => {
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
    await setupScope?.(agentCtx);
    scopeCtx = agentCtx;
    // The native Inbox claims next-step injections before the waking prompt.
    // Keep the task first in model history while preserving each claim/source.
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter' || taskPrompt === null) return decision;
      const index = decision.messages.findIndex(message => message.id === taskPrompt?.id);
      if (index <= 0) return decision;
      const ordered = [...decision.messages];
      const [task] = ordered.splice(index, 1);
      return { ...decision, messages: [task!, ...ordered] };
    });
    const mounted = await mountCapabilityTools(agentCtx, { capabilities, scope: nativeAgent, logger });
    if (mounted.missing.length) {
      // Recorded, not fatal: the packages this turn mounted are not the whole
      // answer. The set is judged after the Agent is published, where a profile
      // provider's own (asynchronous) registration is also visible.
      logger?.warn?.(`cluster agent ${agent.id}: capability tools missing after mount: ${mounted.missing.map(entry => `${entry.capability}→${entry.tool}`).join(', ')}`);
      missingReport.push(...mounted.missing);
    }
    installToolPolicy(agentCtx, { role, allowedTools, globalTools });
    // Mirror the official preset's isolated compaction group. This installs
    // the default backend once for this native Agent scope while llm, sessions
    // and tokenMeter remain inherited host services. Its fiber is owned by the
    // Agent and unwinds together with the native handle.
    agentCtx.isolate('compaction').plugin(BasicCompactionEngine, {});
  };

  let handle: AgentHandle;
  let resumeSession = resume;
  try {
    // The authoritative answer is the session store; `turns > 0` is only the
    // fallback for a host without persistence. Keep the probe inside cleanup:
    // cancellation or a probe failure must release the session listener too.
    if (typeof flow.sessionExists === 'function') {
      const exists = await flow.sessionExists(agent.session_id);
      if (exists !== null) resumeSession = exists;
    }
    signal?.throwIfAborted();
    handle = resumeSession
      ? await ctx.agents.resume({ resumeSessionId: SessionId(agent.session_id), agentOptions, setup })
      : await ctx.agents.create({
        sessionId: SessionId(agent.session_id),
        meta: { ...(cwd ? { cwd } : {}), ...nativeSessionParent(flow.store, agent) },
        agentOptions,
        setup,
      });
  } catch (caught) {
    disposeSession();
    throw Object.assign(new Error(`agent turn could not start: ${errorMessage(caught)}`), { cause: caught, phase: 'start' });
  }

  const live = handle.agent;
  const cancel = (): void => {
    try {
      live.cancel({ kind: 'hook', reason: 'flow cancelled' });
    } catch (error) {
      logger?.warn?.(error);
    }
  };
  if (signal) signal.addEventListener('abort', cancel, { once: true });

  try {
    signal?.throwIfAborted();
    // Bind this turn's identity to the live instance before any tool can run.
    onAgentReady?.(live);
    project(live.session);
    await projection;
    // Every declared capability must be served before the prompt is submitted:
    // a partial or absent capability would have the model call a tool that does
    // not exist, and a compaction request issued first would already be a model
    // request. Judging it here rather than in the setup callback is what lets a
    // profile register a capability's tools at publication time.
    if (scopeCtx) {
      const gaps = await awaitCapabilityTools(scopeCtx, capabilities, live, CAPABILITY_PUBLISH_SETTLE_MS);
      if (gaps.length > 0) {
        missingReport.push(...gaps);
        throw Object.assign(new Error(`Capability tools unavailable: ${gaps.map(entry => `${entry.capability}→${entry.tool}`).join(', ')}`), {
          code: 'CAPABILITY_UNAVAILABLE', phase: 'start',
        });
      }
    }
    // Native cancel() only aborts existing activity. A subsequent followup()
    // wakes a fresh turn, so cancellation during preparation must stop here.
    signal?.throwIfAborted();
    // Session existence alone does not prove the initial task was admitted:
    // creation can be persisted before its first step. Read the native message
    // projection; small host fixtures may only expose create/resume identity.
    const hasPriorPrompt = typeof live.session.deriveMessages === 'function'
      ? live.session.deriveMessages().some(message => message.role === 'user') : resumeSession;
    taskPrompt = createUserMessage({ content: [{ type: 'text', text: prompt }], source: hasPriorPrompt ? FLOW_SOURCE : { kind: 'user' } });
    // Inject communication at the next step, then wake exactly one turn. Native
    // followup prompts each own a turn, so batching those would multiply turns.
    for (const input of messages) live.send(input, 'next-step', false);
    live.followup(taskPrompt);
    admitted = true;
    onAdmitted?.();
    await live.whenIdle();
    // Capture one synchronous cut before the durable barrier. Events appended
    // while flush is pending belong to a later cut and must not be projected
    // under this flush result.
    const cursor = flow.store.nativeUsageCursor(live.session.id);
    const events = typeof live.session.snapshotEvents === 'function'
      ? live.session.snapshotEvents(SessionLogOffset((cursor ?? -1) + 1))
      : collected.events.filter(event => event.seq > (cursor ?? -1));
    const contextSnapshot = nativeContextSnapshot(ctx, live.session);
    // Respect the host's durable flush result before acknowledging delivery.
    const flushed = await ctx.sessions.flush(live.session);
    if (flushed !== false) {
      projectNativeSessionUsage(flow.store, agent, events, transactionId, contextSnapshot);
    }
    await projection;
    onFlushed?.(flushed !== false);
  } finally {
    signal?.removeEventListener('abort', cancel);
    disposeSession();
    await projection;
    try {
      await handle.dispose();
    } catch (error) {
      logger?.warn?.(error);
    }
  }

  // The native offset after the turn, taken from the live instance: the
  // checkpoint records this, not the cluster's own event cursor.
  const nativeSeq = sessionOffset(live);
  const endEvent = [...collected.events].reverse().find((event): event is Extract<SessionEvent, { type: 'turn/end' }> => event.type === 'turn/end');
  const reason: TurnEndReason | undefined = endEvent?.data?.reason;
  const stopReason = reason?.kind ?? 'unknown';
  const stopDetail = describeStop(reason);
  return {
    native_seq: nativeSeq,
    stopDetail,
    missing_capability_tools: missingReport,
    admitted,
    events: collected.events,
    assistant: collected.assistant,
    usage: collected.usage,
    toolCalls: collected.toolCalls,
    stopReason,
    completed: stopReason === 'completed',
    finalText: lastAssistantText(collected.assistant),
  };
}

/** Human-readable detail for a TurnEndReason, so a failed turn is diagnosable. */
function describeStop(reason: TurnEndReason | null | undefined): TurnStopDetail | null {
  if (!reason) return null;
  if (reason.kind === 'error') {
    const failure = reason.error;
    const extraInfo = 'info' in failure ? failure.info : null;
    return {
      kind: reason.kind,
      message: failure.message ?? String(failure),
      code: failure.code ?? null,
      info: extraInfo === null || extraInfo === undefined ? null : recordOf(extraInfo),
    };
  }
  if (reason.kind === 'aborted') {
    const detail: TurnStopDetail = { kind: reason.kind };
    Object.assign(detail, reason.reason);
    return detail;
  }
  return { kind: reason.kind };
}

function lastAssistantText(messages: readonly AssistantTurnEvent[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks: readonly ContentBlock[] = messages[index]?.message?.content ?? [];
    const text = blocks.filter((block): block is TextBlock => block.type === 'text').map(block => block.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

/**
 * Host tool pipeline hook: hard tool-call quota, durable effect receipt before
 * the side effect, and result capture after it.
 */
export function createToolExecutionHook(deps: ToolExecutionHookDeps): (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult> {
  const { ctx, lookupAgent, recordEvent, logger } = deps;
  return async function flowToolExecution(exec, next) {
    if (exec.parent !== undefined) return next();
    const execAgent = exec.agent;
    if (!execAgent) return next();
    const agent = lookupAgent(execAgent.id);
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
    let admitted: ToolAdmission;
    try {
      admitted = deps.beforeTool(agent, exec, callId);
    } catch (caught) {
      const failure = errorFields(caught);
      if (failure?.code === 'LIMIT_REACHED') {
        return toolError(`Error: cluster budget exhausted for tool calls: ${failure.message}`, 'TOOL_CALL_QUOTA');
      }
      return toolError(`Error: ${errorMessage(caught)}`, 'FLOW_TOOL_GATE');
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
        flushed = await ctx.sessions.flush(execAgent.session);
      } catch (caught) {
        logger?.warn?.(caught);
        try { deps.refuseTool?.(agent, exec, callId, `the turn session could not be flushed: ${errorMessage(caught)}`); } catch (nested) { logger?.warn?.(nested); }
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
      let stillOwned: ToolAdmission | null = null;
      try {
        stillOwned = deps.recheckTool?.(agent, exec, callId) ?? null;
      } catch (caught) {
        try { deps.refuseTool?.(agent, exec, callId, 'lease lost during flush'); } catch (nested) { logger?.warn?.(nested); }
        return toolError(`Error: ${errorMessage(caught)}`, 'TOOL_CALL_FENCED');
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
      } catch (caught) {
        logger?.warn?.(caught);
        try { deps.refuseTool?.(agent, exec, callId, `the dispatch could not be recorded: ${errorMessage(caught)}`); } catch (nested) { logger?.warn?.(nested); }
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
    } catch (caught) {
      // Only a call that really started is charged for the failure; one that never
      // dispatched hands its reservation back.
      try {
        if (started) deps.afterTool(agent, exec, callId, null, caught);
        else deps.refuseTool?.(agent, exec, callId, `the call failed before dispatch: ${errorMessage(caught)}`);
      } catch (nested) {
        logger?.warn?.(nested);
      }
      throw caught;
    }
  };
}

export function effectTool(name: string): boolean {
  return SIDE_EFFECT_TOOLS.has(name) || name.startsWith('mcp__playwright-mcp__browser_');
}

export function toolError(text: string, code: string): ToolExecutionFailure {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    error: { message: text, info: { name: 'FlowToolError', code } },
  };
}

export { fail, settleChain, reserveChain };
