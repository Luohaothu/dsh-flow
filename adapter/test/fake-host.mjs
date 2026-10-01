/**
 * A fake DSH host for cluster tests: the same service surface `runTurn` uses
 * (an agent registry, a session service, the token meter, the compaction
 * engine, the tool registry and its execution pipeline) with a script instead
 * of a model.
 *
 * It exists so mechanism assertions can be made against the *real* runtime and
 * the *real* plugin wiring — `apply()` is driven with this context, so the tool
 * definitions under test are the ones the host would load — while every model
 * round trip, every flush result and every accounting decision stays under the
 * test's control.
 */

export function createFakeHost({
  logger = { warn() {}, error() {}, info() {} },
  tokenMeter = null,
  compaction = null,
  persistence = null,
  flushResult = true,
} = {}) {
  const sessionEventListeners = [];
  const toolExecuteHandlers = [];
  const tools = new Map();
  const provided = new Map();
  const effects = [];
  const injectors = new Map();
  const state = { script: null, agentOptions: {}, current: null, turns: [], sessionTokens: 0 };

  const host = {
    logger,
    tools: {
      register(definition) { tools.set(definition.name, definition); return definition; },
      get(name) { return tools.has(name) ? name : undefined; },
      restrict() {},
      guard() {},
    },
    on(type, listener) {
      const list = type === 'session/event' ? sessionEventListeners : type === 'tools/execute' ? toolExecuteHandlers : null;
      if (!list) return () => {};
      list.push(listener);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    provide(name, value) { provided.set(name, value); },
    effect(factory) { effects.push(factory()); },
    inject(names, callback) { injectors.set(names.join(','), callback); return callback; },
    get(name) {
      if (name === 'tokenMeter') return tokenMeter;
      if (name === 'compaction') return compaction;
      if (name === 'sessionPersistence') return persistence;
      if (name === 'flow') return provided.get('flow');
      // Not mounted: the runtime treats an absent agent loop as "the host is not
      // ready yet", which is the state a test wants unless it says otherwise.
      return undefined;
    },
    agents: null,
    sessions: {
      async flush(session) {
        const value = typeof flushResult === 'function' ? flushResult(session) : flushResult;
        const ok = Boolean(value);
        if (state.current) state.current.flushed = ok;
        return ok;
      },
    },
  };

  class FakeTurn {
    constructor(agentId, session, agentCtx) {
      this.agentId = agentId;
      this.session = session;
      this.agentCtx = agentCtx;
      this.requests = [];
      this.toolCalls = [];
      this.concluded = false;
      this.admitted = false;
      this.flushed = null;
      this.cancelled = false;
    }

    /** One provider round trip, accounted exactly like a real one. */
    async request({ purpose = 'worker', usage = { totalTokens: 100, inputTokens: 80, outputTokens: 20 }, chunks = null, dispatchFails = false } = {}) {
      const options = {
        sessionId: this.session.id,
        provider: state.agentOptions.provider,
        model: state.agentOptions.model,
        purpose,
        system: 'system',
        // The provider prices the whole request, so the fake prompt is sized
        // from the session the meter reports: a compaction that shrinks the
        // session is then visible in the *next* request's estimate.
        messages: [{ role: 'user', content: 'x'.repeat(Math.max(1, state.sessionTokens) * 4) }],
        tools: [],
        maxTokens: state.agentOptions.maxTokens ?? 512,
      };
      const record = { purpose, usage, dispatchFails, error: null };
      this.requests.push(record);
      const handler = this.agentCtx.streamHandlers[0];
      if (!handler) throw new Error('no llm/stream accounting listener was installed for this turn');
      // A dispatch that throws *before* the request is produced is the only case
      // that may release everything: nothing provably reached the provider.
      const inner = dispatchFails
        ? () => { throw new Error('provider dispatch failed'); }
        : async function* () {
          for (const chunk of chunks ?? [{ type: 'text', text: 'ok' }, { type: 'usage', usage }]) yield chunk;
        };
      let text = '';
      let failure = null;
      try {
        const generator = handler(options, inner);
        for await (const chunk of generator) if (chunk?.type === 'text') text += chunk.text ?? '';
      } catch (error) {
        // A synchronous dispatch failure throws before a generator exists; a
        // mid-stream failure throws while it is consumed. The host loop catches
        // it, ends the turn with an error reason, and the caller sees the
        // failure — the same shape the real loop produces.
        failure = error;
        // A request cancelled before dispatch is not a failed turn: the loop
        // simply never sent it, and the turn may continue.
        if (!dispatchFails) {
          this.stopReason = 'error';
          this.stopDetail = { kind: 'error', message: String(error?.message ?? error), code: error?.code ?? null, info: error?.info ?? null };
        }
      }
      record.error = failure;
      return { text, usage, error: failure };
    }

    /** The plugin's tool-execution seam, for tests that drive it directly. */
    toolExecutionHook() {
      return toolExecuteHandlers[0] ?? null;
    }

    /** One tool call through the host's real execution pipeline. */
    async callTool(name, args, { callId = null } = {}) {
      const hook = toolExecuteHandlers[0];
      if (!hook) throw new Error('the tool execution seam was not installed');
      const definition = tools.get(name);
      if (!definition) throw new Error(`unknown tool ${name}`);
      const exec = {
        name,
        // Unique across turns: `toolCalls` resets with every FakeTurn, so a per-turn
        // counter reused the previous turn's call id — and `tool_call_receipts.call_id`
        // is a primary key, so the second call was refused and surfaced as a tool error.
        callId: callId ?? `${this.session.id}:${(state.callSeq = (state.callSeq ?? 0) + 1)}`,
        arguments: args,
        agent: this.live,
        signal: new AbortController().signal,
        __concluded: false,
        concludeTurn() { this.__concluded = true; },
      };
      this.toolCalls.push(name);
      const result = await hook(exec, () => definition.execute(args, exec));
      if (exec.__concluded) this.concluded = true;
      return result;
    }

    /**
     * Dispatch one `agent/pre-step` waterfall, as the real loop does: the
     * registered listeners run in order, each receiving `next` as the rest of
     * the chain, and a `reject` decision ends the turn `blocked`.
     */
    async preStep({ step = 1, messages = [{ role: 'user', content: 'prompt' }] } = {}) {
      const handlers = this.agentCtx.listeners.get('agent/pre-step') ?? [];
      let claimed = messages;
      let index = 0;
      const dispatch = async () => {
        if (index >= handlers.length) return { kind: 'enter', messages: claimed };
        const handler = handlers[index];
        index += 1;
        return handler({ agent: this.live, messages: claimed, turn: 1, step, signal: new AbortController().signal }, dispatch);
      };
      const decision = await dispatch();
      if (decision?.kind === 'reject') {
        this.blocked = true;
        this.stopReason = 'blocked';
      } else if (decision?.kind === 'enter') {
        claimed = decision.messages ?? claimed;
      }
      return decision;
    }

    /** A native session event, as the host would append it. */
    emit(type, data = {}) {
      for (const listener of sessionEventListeners) listener(this.session, { type, data });
    }
  }

  host.agents = {
    async create({ sessionId, agentOptions, setup }) {
      state.agentOptions = agentOptions ?? {};
      const session = { id: sessionId };
      const agentCtx = createAgentCtx();
      await setup?.(agentCtx);
      const turn = new FakeTurn(sessionId, session, agentCtx);
      state.turns.push(turn);
      state.current = turn;
      let onCancel = null;
      const cancelled = new Promise(resolvePromise => { onCancel = resolvePromise; });
      const live = {
        id: sessionId,
        session,
        ctx: { get: name => (name === 'compaction' ? compaction : undefined) },
        cancel() {
          turn.cancelled = true;
          // The real loop ends the turn when it is cancelled: the host returns
          // from `whenIdle` with an aborted reason instead of waiting forever.
          onCancel();
        },
        followup(message) { turn.prompt = message; turn.admitted = true; },
        async whenIdle() {
          await Promise.race([Promise.resolve().then(() => state.script?.(turn, live)), cancelled]);
          const reason = turn.cancelled
            ? { kind: 'aborted' }
            : turn.stopDetail
              ? { kind: turn.stopDetail.kind, error: { message: turn.stopDetail.message, code: turn.stopDetail.code, info: turn.stopDetail.info } }
              : { kind: turn.concluded ? 'completed' : (turn.stopReason ?? 'max-tokens') };
          turn.emit('turn/end', { reason });
          state.current = null;
        },
      };
      turn.live = live;
      return { agent: live, async dispose() {} };
    },
    async resume(options) {
      // The real host names the session `sessionId` in both entry points; the plugin
      // passes `resumeSessionId` to `resume`, and forwarding it unchanged into `create`
      // left `live.id` undefined — which surfaced as “flow tool requires an executing
      // agent identity” on the *second* and later turns of any agent.
      const { resumeSessionId, ...rest } = options ?? {};
      return host.agents.create({ ...rest, sessionId: options?.sessionId ?? resumeSessionId });
    },
  };

  return {
    ctx: host,
    tools,
    setSessionTokens(value) { state.sessionTokens = value; return value; },
    get sessionTokens() { return state.sessionTokens; },
    provided,
    effects,
    injectors,
    sessionEventListeners,
    turns: state.turns,
    /** Register a tool definition as if a capability package had mounted it. */
    registerTool(definition) { tools.set(definition.name, definition); return definition; },
    setScript(script) { state.script = script; return script; },
    /** The plugin's tool-execution seam, for tests that drive it directly. */
    toolExecutionHook() { return toolExecuteHandlers[0] ?? null; },
    get lastTurn() { return state.turns[state.turns.length - 1] ?? null; },
    runInjector(name, ...args) { return injectors.get(name)?.(...args); },
    dispose() { for (const effect of effects) effect?.(); },
  };
}

function createAgentCtx() {
  const streamHandlers = [];
  const listeners = new Map();
  return {
    streamHandlers,
    tools: { restrict() {}, guard() {}, get(name) { return name; }, register() {} },
    systemPrompt: { section() { return () => {}; } },
    plugin: async () => {},
    on(type, listener) {
      if (type === 'llm/stream') streamHandlers.push(listener);
      else {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      }
      return () => {};
    },
    listeners,
    get() { return undefined; },
  };
}