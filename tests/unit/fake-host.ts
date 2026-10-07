/**
 * A fake DSH **host surface** for cluster tests: the services `runTurn` and
 * `ClusterRuntime` consume (an agent registry, a session service, the token
 * meter, the compaction engine, the tool registry) with a script instead of a
 * model.
 *
 * It stays a *fixture*. Two boundaries are deliberate:
 *
 *  - The context is a **real** Cordis `Context` with the scripted services
 *    provided on it, so `apply(host.ctx, config)` and `runTurn(host.ctx, …)`
 *    type-check and resolve services exactly as they do in a deployment. The
 *    fixture does not simulate Fiber state, and it never claims to: a test that
 *    needs the real Cordis lifecycle mounts the plugin with `ctx.plugin()` on
 *    its own context (see `lifecycle-regression.test.ts`).
 *  - Everything a test controls — the script, the session token count, the
 *    registered tools, the turns — lives on the object this function returns.
 *    Nothing is written onto the Context except ordinary public services and
 *    plain members the runtime already reads (`logger`).
 *
 * The scripted model is intentionally allowed to emit payloads outside the
 * host's declared unions (a text delta with the wrong tag, a mid-stream
 * failure): the negative tests exist to prove what the runtime does with them.
 * The one place that re-labels such a scripted payload as a host chunk is the
 * producer boundary inside this file.
 */
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent, SessionEventMap, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { fromPartial } from '@total-typescript/shoehorn';

import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, StreamChunk, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm';
import type {
  ToolDefinition,
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm';
import { isFlowJsonValue } from '../../packages/dsh-flow/src/validation.ts';

/** The logger surface the runtime consumes; the default is silent. */
export interface FakeLogger {
  debug(message: unknown, ...rest: unknown[]): void
  info(message: unknown, ...rest: unknown[]): void
  warn(message: unknown, ...rest: unknown[]): void
  error(message: unknown, ...rest: unknown[]): void
}

/** The token meter the context-pressure tests script. */
export interface FakeTokenMeter {
  measure(session?: unknown): { totalTokens: number; logRevision?: number }
}

/** The compaction engine the context-pressure tests script. */
export interface FakeCompaction {
  compactNow?(live?: unknown, reason?: unknown): Promise<unknown>
  compactIfNeeded?(live?: unknown, reason?: unknown): Promise<unknown>
}

/** The durable-session service the recovery tests script. */
export type FakePersistence = Pick<SessionPersistence, 'stat' | 'open'>

/** The session service `runTurn` flushes through. */
export interface FakeSessions {
  flush(session: Session): Promise<boolean>
}

/** One scripted provider payload; negative tests deliberately pass shapes outside the host union. */
export interface FakeProviderChunk {
  readonly type: string
  readonly text?: string
  readonly usage?: TokenUsage
  readonly reason?: unknown
  readonly index?: number
  readonly block?: unknown
  readonly blockType?: unknown
  readonly id?: unknown
  readonly name?: string
  readonly argumentsDelta?: string
  readonly replayState?: unknown
}

/** One `llm/stream` listener the runtime installed on its agent scope. */
export type FakeStreamHandler =
  (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

/** One `agent/pre-step` listener the runtime installed on its agent scope. */
export type FakePreStepHandler =
  (payload: FakePreStepPayload, next: () => Promise<FakePreStepDecision>) => Promise<FakePreStepDecision>

/** The waterfall payload `preStep()` hands a listener. */
export interface FakePreStepPayload {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** The waterfall decision a listener returns (only the fields the fixture branches on). */
export type FakePreStepDecision = PreStepDecision

/** One `tools/execute` wrapper the runtime installed on its agent scope. */
export type FakeToolExecuteHandler =
  (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>

/** One recorded provider round trip. */
export interface FakeRequestRecord {
  readonly purpose: string
  readonly usage: TokenUsage
  readonly dispatchFails: boolean
  error: unknown
}

/** The agent-scoped tool surface the runtime installs a policy onto. */
export interface FakeToolScope {
  restrict(options: { allow: readonly string[] }): void
  guard(check: (exec: { name: string }) => string | undefined): void
  get(name: string): string | undefined
  register(definition: ToolDefinition): unknown
}

/** The chat message a scripted turn was woken with. */
export type FakePrompt = Omit<UserMessage, 'content'> & { readonly content: readonly TextBlock[] };

/** The scripted live agent instance one scheduled turn drives. */
export interface FakeAgent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context
  cancel(reason?: unknown): void
  followup(message: UserMessage): void
  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
  whenIdle(): Promise<void>
}

/** The agent scope one scripted turn owns, with the fixture's dispatch tables. */
export interface FakeAgentScope {
  readonly ctx: Context
  readonly streamHandlers: FakeStreamHandler[]
  readonly listeners: Map<string, FakePreStepHandler[]>
}

/** Scripted model control: one function per admitted turn. */
export type FakeTurnScript = (turn: FakeTurn, agent: FakeAgent) => void | Promise<void>

/** Options for one scripted provider round trip. */
export interface FakeRequestOptions {
  readonly purpose?: string
  readonly usage?: TokenUsage
  readonly chunks?: readonly FakeProviderChunk[] | null
  readonly dispatchFails?: boolean
}

/** Options for one scripted tool call. */
export interface FakeCallToolOptions {
  readonly callId?: string | null
}

/** Options for one scripted `agent/pre-step` waterfall. */
export interface FakePreStepOptions {
  readonly step?: number
  readonly messages?: UserMessage[]
}

/** One scripted turn: the model round trips and tool calls a test drives. */
export interface FakeTurn {
  readonly agentId: string
  readonly session: Session
  readonly agentCtx: FakeAgentScope
  readonly requests: FakeRequestRecord[]
  readonly toolCalls: string[]
  concluded: boolean
  admitted: boolean
  flushed: boolean | null
  cancelled: boolean
  blocked: boolean
  prompt: FakePrompt | undefined
  readonly inputs: UserMessage[]
  readonly live: FakeAgent
  stopReason: string | undefined
  stopDetail: { kind: string; message: string; code: string | null; info: unknown } | undefined
  request(options?: FakeRequestOptions): Promise<{ text: string; usage: TokenUsage; error: unknown }>
  toolExecutionHook(): FakeToolExecuteHandler | null
  callTool(name: string, args: unknown, options?: FakeCallToolOptions): Promise<ToolExecutionResult>
  preStep(options?: FakePreStepOptions): Promise<FakePreStepDecision>
  emit(type: 'turn/end', data: SessionEventMap['turn/end']): void
}

/** Mutable fixture state shared by every scripted turn. */
export interface FakeHostState {
  script: FakeTurnScript | null
  agentOptions: AgentOptions
  current: FakeTurn | null
  turns: FakeTurn[]
  sessionTokens: number
  callSeq: number
}

/** Options for {@link createFakeHost}. */
export interface FakeHostOptions {
  readonly logger?: FakeLogger
  readonly tokenMeter?: FakeTokenMeter | null
  readonly compaction?: FakeCompaction | null
  readonly persistence?: FakePersistence | null
  readonly flushResult?: boolean | ((session: unknown) => boolean)
}

/** The fake host surface: the context plus the fixture's own control plane. */
export interface FakeHost {
  /** A real Cordis context carrying the scripted services. */
  readonly ctx: Context
  /** Every definition registered through the root registry. */
  readonly tools: Map<string, ToolDefinition>
  /** The services this fixture provided, falling back to the live context registry. */
  readonly provided: Map<string, unknown>
  /** The disposers for every service this fixture provided, in order. */
  readonly disposers: Array<() => void | Promise<void>>
  /** Every `session/event` listener currently installed by the runtime. */
  readonly sessionEventListeners: unknown[]
  /** Every scripted turn, oldest first. */
  readonly turns: FakeTurn[]
  setSessionTokens(value: number): number
  readonly sessionTokens: number
  registerTool(definition: ToolDefinition): ToolDefinition
  setScript(script: FakeTurnScript): FakeTurnScript
  toolExecutionHook(): FakeToolExecuteHandler | null
  readonly lastTurn: FakeTurn | null
  dispose(): Promise<void>
}

const SILENT_LOGGER: FakeLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A `Map` view of the context's services: provided ones first, then the live registry. */
class ServiceRegistry extends Map<string, unknown> {
  readonly #owner: Context;

  constructor(owner: Context) {
    super();
    this.#owner = owner;
  }

  override get(name: string): unknown {
    const local = super.get(name);
    if (local !== undefined) return local;
    return this.#owner.get(name);
  }

  override has(name: string): boolean {
    return super.has(name) || this.#owner.get(name) !== undefined;
  }
}

/**
 * Build one fake host.
 * @param options - the scripted services and the silent logger.
 * @returns the context plus the fixture control plane.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const logger = options.logger ?? SILENT_LOGGER;
  const flushResult = options.flushResult ?? true;

  const root = new Context();
  const tools = new Map<string, ToolDefinition>();
  const provided = new ServiceRegistry(root);
  const disposers: Array<() => void | Promise<void>> = [];
  const sessionEventListeners: unknown[] = [];
  const toolExecuteHandlers: FakeToolExecuteHandler[] = [
    (exec, next) => {
      const scope = state.current?.agentCtx.ctx;
      if (!scope) throw new Error('no active agent scope');
      return scope.waterfall('tools/execute', exec, next);
    },
  ];
  const state: FakeHostState = { script: null, agentOptions: {}, current: null, turns: [], sessionTokens: 0, callSeq: 0 };

  /** Provide one service on the root fiber and record it for `provided`. */
  const offer = (name: string, value: unknown): void => {
    disposers.push(root.provide(name, value));
    provided.set(name, value);
  };

  offer('tools', {
    register(definition: ToolDefinition): ToolDefinition { tools.set(definition.name, definition); return definition; },
    get(name: string): string | undefined { return tools.has(name) ? name : undefined; },
    schemas(): ToolDefinition[] { return [...tools.values()]; },
    restrict() {},
    guard() {},
  });
  offer('agentLoop', {});
  offer('sessions', {
    async flush(session: unknown): Promise<boolean> {
      const value = typeof flushResult === 'function' ? flushResult(session) : flushResult;
      const ok = Boolean(value);
      if (state.current) state.current.flushed = ok;
      return ok;
    },
  } satisfies FakeSessions);
  if (options.tokenMeter) offer('tokenMeter', options.tokenMeter);
  if (options.compaction) offer('compaction', options.compaction);
  const persistence = options.persistence === undefined
    ? { stat: async () => undefined, open: async () => { throw new Error('the fake persistence has no sessions'); } }
    : options.persistence;
  if (persistence) offer('sessionPersistence', persistence);

  const scopedTools = new Map<Context, Map<string, ToolDefinition>>();

  /** The agent-scoped context: a real child with the fixture's dispatch tables shadowing the runtime's seams. */
  const createAgentCtx = (owner: Context): FakeAgentScope => {
    const localTools = new Map<string, ToolDefinition>();
    const scope = owner.extend({
      tools: {
        restrict() {},
        guard() {},
        get(name: string): string | undefined { return localTools.has(name) || tools.has(name) ? name : undefined; },
        register(definition: ToolDefinition): unknown { localTools.set(definition.name, definition); return () => localTools.delete(definition.name); },
        schemas(): ToolDefinition[] { return [...tools.values(), ...localTools.values()]; },
      },
      systemPrompt: { section: () => () => {} },
    });
    scopedTools.set(scope, localTools);
    const streamHandlers: FakeStreamHandler[] = [(options, next) => scope.waterfall('llm/stream', options, next)];
    const listeners = new Map<string, FakePreStepHandler[]>([
      ['agent/pre-step', [(payload, next) => scope.waterfall('agent/pre-step', payload, next)]],
    ]);
    return { ctx: scope, streamHandlers, listeners };
  };

  class FakeTurnImpl implements FakeTurn {
    readonly agentId: string;
    readonly session: Session;
    readonly agentCtx: FakeAgentScope;
    readonly requests: FakeRequestRecord[] = [];
    readonly toolCalls: string[] = [];
    concluded = false;
    admitted = false;
    flushed: boolean | null = null;
    cancelled = false;
    blocked = false;
    prompt: FakePrompt | undefined;
    readonly inputs: UserMessage[] = [];
    #live: FakeAgent | undefined;
    get live(): FakeAgent {
      if (!this.#live) throw new Error('agent not initialized');
      return this.#live;
    }
    set live(value: FakeAgent) { this.#live = value; }
    stopReason: string | undefined;
    stopDetail: { kind: string; message: string; code: string | null; info: unknown } | undefined;

    constructor(agentId: string, session: Session, agentCtx: FakeAgentScope) {
      this.agentId = agentId;
      this.session = session;
      this.agentCtx = agentCtx;
    }

    /** One provider round trip, accounted exactly like a real one. */
    async request({
      purpose = 'worker',
      usage = { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      chunks = null,
      dispatchFails = false,
    }: FakeRequestOptions = {}): Promise<{ text: string; usage: TokenUsage; error: unknown }> {
      if (this.cancelled) throw new Error('turn aborted');
      const options: GenerateOptions = {
        provider: state.agentOptions.provider ?? 'local-fake',
        model: state.agentOptions.model ?? 'fake-model',
        sessionId: SessionId(this.session.id),
        system: 'system',
        // The provider prices the whole request, so the fake prompt is sized
        // from the session the meter reports: a compaction that shrinks the
        // session is then visible in the *next* request's estimate.
        messages: [
          createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(Math.max(1, state.sessionTokens) * 4) }], source: { kind: 'user' } }),
        ],
        tools: [],
        maxTokens: state.agentOptions.maxTokens ?? 512,
        ...(purpose === 'compaction' ? { purpose: 'compaction' as const } : {}),
      };
      const record: FakeRequestRecord = { purpose, usage, dispatchFails, error: null };
      this.requests.push(record);
      const handler = this.agentCtx.streamHandlers[0];
      if (!handler) throw new Error('no llm/stream accounting listener was installed for this turn');
      // A dispatch that throws *before* the request is produced is the only case
      // that may release everything: nothing provably reached the provider.
      const scripted: readonly FakeProviderChunk[] = chunks
        ?? [{ type: 'text', text: 'ok' }, { type: 'usage', usage }];
      const inner = dispatchFails
        ? (): AsyncIterable<StreamChunk> => { throw new Error('provider dispatch failed'); }
        : async function* (): AsyncGenerator<StreamChunk> {
          for (const chunk of scripted) {
            // This scripted producer deliberately emits tags outside the host union to test tolerant accounting.
            yield chunk as StreamChunk;
          }
        };
      let text = '';
      let failure: unknown = null;
      try {
        const generator = handler(options, inner);
        for await (const raw of generator) {
          const chunk: unknown = raw;
          if (chunk !== null && typeof chunk === 'object' && 'type' in chunk
            && chunk.type === 'text' && 'text' in chunk && typeof chunk.text === 'string') text += chunk.text;
        }
      } catch (error) {
        // A synchronous dispatch failure throws before a generator exists; a
        // mid-stream failure throws while it is consumed. The host loop catches
        // it, ends the turn with an error reason, and the caller sees the
        // failure — the same shape the real loop produces.
        failure = error;
        // A request cancelled before dispatch is not a failed turn: the loop
        // simply never sent it, and the turn may continue.
        if (!dispatchFails) {
          let message = String(error);
          let code: string | null = null;
          let info: unknown = null;
          if (error instanceof Error) {
            message = error.message;
            // The accounting seam attaches its own `code`/`info` fields to a
            // plain Error; narrow them instead of asserting a fabricated shape.
            if ('code' in error && typeof error.code === 'string') code = error.code;
            if ('info' in error) info = error.info;
          }
          this.stopReason = 'error';
          this.stopDetail = { kind: 'error', message, code, info };
        }
      }
      record.error = failure;
      return { text, usage, error: failure };
    }

    /** The plugin's tool-execution seam, for tests that drive it directly. */
    toolExecutionHook(): FakeToolExecuteHandler | null {
      return toolExecuteHandlers[0] ?? null;
    }

    /** One tool call through the host's real execution pipeline. */
    async callTool(name: string, args: unknown, { callId = null }: FakeCallToolOptions = {}): Promise<ToolExecutionResult> {
      const hook = toolExecuteHandlers[0];
      if (!hook) throw new Error('the tool execution seam was not installed');
      const definition = scopedTools.get(this.agentCtx.ctx)?.get(name) ?? tools.get(name);
      if (!definition) throw new Error(`unknown tool ${name}`);
      // Unique across turns: `toolCalls` resets with every FakeTurn, so a per-turn
      // counter reused the previous turn's call id — and `tool_call_receipts.call_id`
      // is a primary key, so the second call was refused and surfaced as a tool error.
      const resolvedCallId = ToolCallId(callId ?? `${this.session.id}:${(state.callSeq += 1)}`);
      const turn = this;
      const exec = fromPartial<ToolDispatchExecution>({
        name,
        callId: resolvedCallId,
        rootCallId: resolvedCallId,
        arguments: args,
        agent: fromPartial<Agent>(this.live),
        signal: new AbortController().signal,
      });
      const run = fromPartial<ToolRunContext>({
        name,
        callId: resolvedCallId,
        rootCallId: resolvedCallId,
        arguments: args,
        agent: fromPartial<Agent>(this.live),
        signal: exec.signal,
        concludeTurn() { turn.concluded = true; },
      });
      this.toolCalls.push(name);
      return hook(exec, async () => {
        const value = await definition.execute(args, run);
        if (value !== null && typeof value === 'object' && 'isError' in value && 'content' in value) {
          if (!Array.isArray(value.content)) throw new Error('scripted tool content must be an array');
          const content: ContentBlock[] = [];
          const blocks: unknown[] = value.content;
          for (const block of blocks) {
            if (block === null || typeof block !== 'object' || !('type' in block)
              || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') {
              throw new Error('scripted tool result requires text blocks');
            }
            content.push({ type: 'text', text: block.text });
          }
          if (value.isError === true) {
            if (!('error' in value) || value.error === null || typeof value.error !== 'object'
              || !('message' in value.error) || typeof value.error.message !== 'string') {
              throw new Error('scripted tool failure requires error.message');
            }
            return { isError: true, error: { message: value.error.message }, content };
          }
          if (value.isError !== false || !('value' in value) || !isFlowJsonValue(value.value)) {
            throw new Error('scripted tool success requires a JSON value');
          }
          return { isError: false, value: value.value, content };
        }
        if (!isFlowJsonValue(value)) throw new Error('scripted tool must return a JSON value');
        return { isError: false, value, content: definition.output.render(args, value) };
      });
    }

    /**
     * Dispatch one `agent/pre-step` waterfall, as the real loop does: the
     * registered listeners run in order, each receiving `next` as the rest of
     * the chain, and a `reject` decision ends the turn `blocked`.
     */
    async preStep({ step = 1, messages = [createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } })] }: FakePreStepOptions = {}): Promise<FakePreStepDecision> {
      const handlers = this.agentCtx.listeners.get('agent/pre-step') ?? [];
      let claimed = messages;
      let index = 0;
      const dispatch = async (): Promise<FakePreStepDecision> => {
        if (index >= handlers.length) return { kind: 'enter', messages: claimed };
        const handler = handlers[index];
        index += 1;
        if (!handler) return { kind: 'enter', messages: claimed };
        return handler({ agent: fromPartial<Agent>(this.live), messages: claimed, turn: 1, step, signal: new AbortController().signal }, dispatch);
      };
      const decision = await dispatch();
      if (decision.kind === 'reject') {
        this.blocked = true;
        this.stopReason = 'blocked';
      } else if (decision.kind === 'enter') {
        claimed = decision.messages ?? claimed;
      }
      return decision;
    }

    /** A native session event, as the host would append it. */
    emit(type: 'turn/end', data: SessionEventMap['turn/end']): void {
      root.emit('session/event', this.session, fromPartial<SessionEvent<'turn/end'>>({ type, data, time: Date.now() }));
    }
  }

  const agents = {
    async create({ sessionId, agentOptions, setup }: CreateAgentOptions): Promise<AgentHandle> {
      state.agentOptions = agentOptions ?? {};
      const id = sessionId;
      const session = fromPartial<Session>({ id: sessionId });
      let agentScope: FakeAgentScope | undefined;
      const fiber = root.plugin({
        name: `fake-agent-${id}-${state.turns.length}`,
        async apply(owner: Context) {
          agentScope = createAgentCtx(owner);
          const commit = await setup?.(agentScope.ctx, fromPartial<Agent>({ id: sessionId, session, ctx: agentScope.ctx }));
          commit?.commit();
        },
      });
      await fiber.await();
      const agentCtx = agentScope;
      if (!agentCtx) throw new Error('agent setup failed');
      const turn = new FakeTurnImpl(id, session, agentCtx);
      state.turns.push(turn);
      state.current = turn;
      let onCancel: (() => void) | undefined;
      const cancelled = new Promise<void>(resolvePromise => { onCancel = resolvePromise; });
      const live: FakeAgent = {
        id,
        session,
        ctx: agentCtx.ctx,
        cancel() {
          turn.cancelled = true;
          // The real loop ends the turn when it is cancelled: the host returns
          // from `whenIdle` with an aborted reason instead of waiting forever.
          onCancel?.();
        },
        send(message, _target, wakeup) {
          turn.inputs.push(message);
          turn.prompt ??= { ...message, content: message.content.filter(block => block.type === 'text') };
          if (wakeup) turn.admitted = true;
        },
        followup(message) {
          turn.inputs.unshift(message);
          turn.prompt = { ...message, content: message.content.filter(block => block.type === 'text') };
          turn.admitted = true;
        },
        async whenIdle() {
          await Promise.race([Promise.resolve().then(() => state.script?.(turn, live)), cancelled]);
          const reason: TurnEndReason = turn.cancelled
            ? { kind: 'aborted', reason: { kind: 'disposed' } }
            : turn.stopDetail
              ? { kind: 'error', error: { message: turn.stopDetail.message, code: turn.stopDetail.code ?? 'FAKE_PROVIDER' } }
              : turn.concluded ? { kind: 'completed' }
                : turn.blocked || turn.stopReason === 'blocked' ? { kind: 'blocked' } : { kind: 'max-tokens' };
          turn.emit('turn/end', { turn: 1, reason });
          state.current = null;
        },
      };
      turn.live = live;
      return fromPartial<AgentHandle>({ agent: fromPartial<Agent>(live), async dispose() { await fiber.dispose(); } });
    },
    async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
      return agents.create({
        sessionId: options.resumeSessionId,
        ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
        ...(options.setup === undefined ? {} : { setup: options.setup }),
      });
    },
  };
  offer('agents', agents);

  // The runtime reads `ctx.logger` directly; that is shadowed here so a test
  // can run quietly. `ctx.effect` is deliberately *not* shadowed: an effect must
  // be owned by the fiber that registers it, so the plugin's disposer runs when
  // the plugin unloads — delegating it to this fixture's root fiber would leak
  // the runtime past its own lifetime. The listener bookkeeping below forwards
  // to the real bus, so a registration keeps the host's own semantics.
  const ctx = root.extend({ logger });

  return {
    ctx,
    tools,
    provided,
    disposers,
    get sessionEventListeners(): unknown[] {
      sessionEventListeners.splice(0, sessionEventListeners.length,
        ...(root.events._hooks['session/event'] ?? []).map(hook => hook.callback));
      return sessionEventListeners;
    },
    turns: state.turns,
    setSessionTokens(value: number): number { state.sessionTokens = value; return value; },
    get sessionTokens(): number { return state.sessionTokens; },
    registerTool(definition: ToolDefinition): ToolDefinition { tools.set(definition.name, definition); return definition; },
    setScript(script: FakeTurnScript): FakeTurnScript { state.script = script; return script; },
    toolExecutionHook(): FakeToolExecuteHandler | null { return toolExecuteHandlers[0] ?? null; },
    get lastTurn(): FakeTurn | null { return state.turns[state.turns.length - 1] ?? null; },
    async dispose(): Promise<void> {
      await root.fiber.dispose();
      for (const disposer of disposers.splice(0)) await disposer();
    },
  };
}
