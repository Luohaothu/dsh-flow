import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent, AgentHandle, InboxTarget } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, createUserMessage, freezeMessage, lastAssistantStreamChunk,
  type LlmCallConfig, type RequestMessage, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset, buildForkSeed, snapshotSessionEvent, type SessionEvent } from '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-session-persistence';
import '@deepseek-ai/dsh-system-prompt';
import '@deepseek-ai/dsh-compaction';
import '@deepseek-ai/dsh-commands';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Agent, AgentProfile, Context, ContextSummary, HostAdaptor, HostAgent, HostEvent,
  Message, ReleaseMode, SendMode, SendPurpose, SessionID, Usage } from '../core/index.js';
import { assertNoPendingConstruction } from '../core/construction.js';
import { snapshotProfile } from '../core/profile.js';
import { isWaitCompletion } from '../core/message.js';
import { AuxiliaryCallError, registerAuxiliaryUsageSink, awaitAuxiliaryUsageSettlements } from '../core/auxiliary-usage.js';
import { ExecutionCapacity } from './capacity.js';
import { DshConfigurationResolver } from './configuration.js';
import { installFlowTools } from './tools.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { flow: { kind: 'flow'; purpose: SendPurpose; priority: 'high' | 'normal' | 'low'; waitCompletion: boolean } }
}
export interface DshHostAdaptorOptions {
  workspaceRoot: string;
  stateDirectory: string;
  afterTurnTimeoutMs?: number;
  immediateTimeoutMs?: number;
  capacity?: ExecutionCapacity;
}
interface PendingInput { target: InboxTarget; message: UserMessage }
interface CloseOperation {
  phase: 'after-turn' | 'cleaning' | 'completed' | 'failed' | 'abandoned';
  mode: ReleaseMode;
  turn?: number | undefined;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  persistenceError?: unknown;
}
interface OwnedAgent {
  public: HostAgent;
  native: NativeAgent;
  flow: Agent;
  handle?: AgentHandle;
  config: LlmCallConfig;
  workspaceRoot: string;
  listeners: Set<(event: Readonly<HostEvent>) => void>;
  bindings: (() => void)[];
  deferred: PendingInput[];
  claimed: Map<string, UserMessage>;
  completions: Map<string, UserMessage>;
  turn?: number | undefined;
  admittedTurn?: number | undefined;
  capacityHeld: boolean;
  close?: CloseOperation;
  persistTail: Promise<void>;
  auxiliary: Set<{ controller: AbortController; completion: Promise<unknown> }>;
}
interface SavedAgent {
  format: 'dsh-flow-agent'; version: 1; profile: AgentProfile; config: LlmCallConfig; workspaceRoot: string; pending: PendingInput[];
}
interface History {
  format: 'dsh-flow-history'; version: 1; backend: 'dsh'; source: { sessionID: string; name: string }; events: SessionEvent[];
}
type EventBody<T = HostEvent> = T extends HostEvent ? Omit<T, 'agent' | 'timestamp'> : never;
const summaryHeadings = ['## 目标与约束', '## 已知事实与关键决策', '## 当前进展与已有产物', '## 关键文件、资源及定位信息', '## 未完成事项与后续步骤', '## 分歧、风险与待确认信息'];
function parseContextSummary(text: string): { source: string; body: string } {
  const lines = text.trim().replace(/\r\n/g, '\n').split('\n');
  const invalid = () => new Error('Summary was empty, incomplete, truncated, or violated Flow summary v1');
  if (lines[0] !== 'Flow 上下文总结 v1') throw invalid();
  const source = lines[1]?.match(/^来源：[ \t]*(\S[^\r\n]*)$/)?.[1]?.trim();
  if (!source) throw invalid();
  const sections = lines.flatMap((line, index) => /^##(?:[ \t]|$)/.test(line) ? [{ line, index }] : []);
  if (sections.length !== summaryHeadings.length || sections.some((section, index) => section.line !== summaryHeadings[index])) throw invalid();
  if (lines.slice(2, sections[0]!.index).some(line => line.trim())) throw invalid();
  if (sections.some((section, index) => !lines.slice(section.index + 1, sections[index + 1]?.index).join('\n').trim())) throw invalid();
  return { source, body: lines.slice(sections[0]!.index).join('\n') };
}
const summaryInstruction = `输出完整的纯文字总结。没有内容写“无”，信息不足写“未知”。不得调用工具。\nFlow 上下文总结 v1\n来源：实际 Agent 名称及 SessionID\n\n${summaryHeadings.join('\n')}`;
const recoveryInstruction = '会话历史已恢复。Mailbox 和通信关系已重新初始化。历史消息编号在当前 Mailbox 中无效，历史协作者不保证仍然可用。请通过当前 Flow 工具确认目标；用户指令和任务输入已保留。';
const managementWrites = new Set(['set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'set_version_exemption']);
const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isNotification = (message: UserMessage): boolean => message.source.kind === 'flow' && message.source.purpose === 'notification';
const admissible = (message: UserMessage): boolean => message.source.kind === 'flow' && message.source.purpose === 'notification'
  && (message.source.priority === 'high' || message.source.waitCompletion);
function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Cleanup timeout must be finite and positive');
  return value;
}
/** DSH reports uncached input separately; Flow input includes cache and preserves provider totals. */
export function normalizeUsage(usage: TokenUsage, model: { provider: string; id: string }, timestamp = Date.now()): Usage {
  return { timestamp, model: { ...model }, inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    outputTokens: usage.outputTokens, ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }) };
}
function parseHistory(text: string): History {
  const value = JSON.parse(text) as History;
  if (!value || value.format !== 'dsh-flow-history' || value.version !== 1 || value.backend !== 'dsh'
    || typeof value.source?.sessionID !== 'string' || typeof value.source.name !== 'string' || !Array.isArray(value.events)) throw new Error('Unsupported DSH history envelope');
  value.events.forEach((event, index) => { if (event.seq !== index) throw new Error('History must have contiguous events'); snapshotSessionEvent(event); });
  return value;
}
function contextText(messages: readonly RequestMessage[]): string {
  return messages.map(message => `${message.role}:\n${message.content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'reasoning') return '';
    if (block.type === 'tool-call') return `[已记录的工具调用，不重放] ${block.name} ${block.arguments}`;
    return `[${block.type}] ${JSON.stringify(block)}`;
  }).filter(Boolean).join('\n')}`).join('\n\n');
}

export class DshHostAdaptor implements HostAdaptor {
  readonly backend = 'dsh';
  readonly capabilities = Object.freeze({ usage: true });
  private readonly owned = new Map<HostAgent, OwnedAgent>();
  private readonly terminal = new WeakMap<HostAgent, Promise<void>>();
  private readonly reserved = new Set<string>();
  private readonly capacity: ExecutionCapacity;
  private readonly afterTurnTimeoutMs: number;
  private readonly immediateTimeoutMs: number;
  private readonly workspaceRoot: string;
  private readonly stateDirectory: string;
  private readonly removeUsageSink: () => void;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(readonly host: DshContext, private readonly context: Context, options: DshHostAdaptorOptions,
    private readonly configurationResolver = new DshConfigurationResolver(host.llm)) {
    this.workspaceRoot = resolve(options.workspaceRoot); this.stateDirectory = resolve(options.stateDirectory);
    this.capacity = options.capacity ?? new ExecutionCapacity();
    this.afterTurnTimeoutMs = timeout(options.afterTurnTimeoutMs, 120_000); this.immediateTimeoutMs = timeout(options.immediateTimeoutMs, 10_000);
    for (const service of ['agents', 'llm', 'tools', 'sessions', 'systemPrompt', 'sandboxPolicy', 'approval']) {
      if (!host.get(service)) throw new Error(`DSH service ${service} is required`);
    }
    this.removeUsageSink = registerAuxiliaryUsageSink(this, (target, usage) => {
      const owned = this.record(target);
      for (const item of usage) this.emit(owned, { type: 'usage', usage: item }, item.timestamp);
    });
  }
  async createAgent(flow: Agent, input: AgentProfile, history?: string): Promise<HostAgent> {
    this.assertOpen();
    const profile = snapshotProfile(input);
    const config = await this.configurationResolver.configuration(profile);
    this.reserve(profile.sessionID);
    let owned: OwnedAgent | undefined;
    try {
      if (await this.host.get('sessionPersistence')?.stat(SessionId(profile.sessionID))) throw new Error('Session already exists; resume is required');
      const imported = history === undefined ? undefined : parseHistory(history);
      const last = imported?.events.at(-1);
      const seed = last === undefined ? undefined : buildForkSeed(imported!.events, last.seq);
      const handle = await this.host.agents.create({ sessionId: SessionId(profile.sessionID),
        meta: { cwd: this.workspaceRoot, ...(seed ? { parentSession: SessionId(imported!.source.sessionID), isSeeded: true } : {}) },
        ...(seed ? { seed, inheritedEventCount: SessionLogOffset(imported!.events.length) } : {}), agentOptions: config,
        setup: (scope, native) => { owned = this.bind(scope, native, flow, profile, config, this.workspaceRoot); },
      });
      if (!owned) { await handle.dispose(); throw new Error('DSH did not initialize the Agent scope'); }
      owned.handle = handle; this.owned.set(owned.public, owned);
      return owned.public;
    } catch (error) {
      if (owned) { this.unbind(owned); await owned.handle?.dispose(); this.owned.delete(owned.public); }
      this.reserved.delete(profile.sessionID); throw error;
    }
  }
  async resumeAgent(flow: Agent, id: SessionID): Promise<HostAgent> {
    this.assertOpen();
    if (!this.host.get('sessionPersistence')) throw new Error('DSH persistence is unavailable');
    this.reserve(id);
    let owned: OwnedAgent | undefined;
    try {
      const saved = await this.readMetadata(id);
      const profile = snapshotProfile(saved.profile);
      const config = await this.configurationResolver.configuration(profile, saved.config);
      const handle = await this.host.agents.resume({ resumeSessionId: SessionId(id), agentOptions: config,
        setup: (scope, native) => {
          if (resolve(native.session.header.cwd ?? '') !== saved.workspaceRoot) throw new Error('Persisted workspace differs from the saved permission boundary');
          owned = this.bind(scope, native, flow, profile, config, saved.workspaceRoot);
          for (const input of [...native.inbox.nextTurn, ...native.inbox.nextStep]) if (isNotification(input)) native.inbox.remove(input.id);
          const existing = new Set([...native.inbox.nextTurn, ...native.inbox.nextStep].map(message => message.id));
          for (const event of native.session.snapshotEvents()) if (event.type === 'user/message') existing.add(event.data.id);
          for (const pending of saved.pending) if (!isNotification(pending.message) && !existing.has(pending.message.id)) {
            native.inbox.append(pending.target, pending.message); existing.add(pending.message.id);
          }
          native.inject(createUserMessage({ source: { kind: 'flow', purpose: 'notification', priority: 'normal', waitCompletion: false },
            content: [{ type: 'text', text: recoveryInstruction }] }));
        },
      });
      if (!owned) { await handle.dispose(); throw new Error('DSH did not initialize the resumed scope'); }
      owned.handle = handle; this.owned.set(owned.public, owned); return owned.public;
    } catch (error) {
      if (owned) { this.unbind(owned); await owned.handle?.dispose(); this.owned.delete(owned.public); }
      this.reserved.delete(id); throw error;
    }
  }
  private reserve(id: string): void {
    if (this.reserved.has(id) || this.host.agents.get(SessionId(id))) throw new Error('Session already has an active Agent');
    this.reserved.add(id);
  }
  private bind(scope: DshContext, native: NativeAgent, flow: Agent, profile: Readonly<AgentProfile>, config: LlmCallConfig, workspaceRoot: string): OwnedAgent {
    const owned: OwnedAgent = { public: Object.freeze({ profile }), native, flow, config, workspaceRoot, listeners: new Set(), bindings: [],
      deferred: [], claimed: new Map(), completions: new Map(), capacityHeld: false, persistTail: Promise.resolve(), auxiliary: new Set() };
    const mode = profile.permission === 'full-access' ? 'danger-full-access' : profile.permission;
    setSandboxMode(native.session, mode); setApprovalPolicy(native.session, 'never');
    const installed = this.host.sandboxPolicy.resolve({ session: native.session });
    if (installed.mode !== mode || resolve(installed.workspaceRoot) !== workspaceRoot) throw new Error('Requested initial file permission could not be installed');
    owned.bindings.push(
      scope.systemPrompt.section({ name: 'flow-role', order: 0, text: profile.role, interpolate: false }),
      scope.on('agent/request', async () => ({ ...config })),
      scope.on('agent/inbox/claimed', ({ message }) => { owned.claimed.set(message.id, message); }),
      scope.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject') { this.defer(owned, payload.messages); return decision; }
        const close = owned.close;
        if (close) {
          this.defer(owned, decision.messages);
          return close.phase === 'after-turn' && close.turn === payload.turn ? { kind: 'enter', messages: [] } : { kind: 'reject' };
        }
        const completions: UserMessage[] = [];
        for (const [id, message] of owned.completions) {
          if (decision.messages.some(input => input.id === id) || native.inbox.remove(message.id)) {
            completions.push(message); owned.completions.delete(id);
          }
        }
        const ids = new Set(completions.map(message => message.id));
        let messages = [...completions, ...decision.messages.filter(message => !ids.has(message.id))];
        if (flow.hasPendingWait()) {
          this.defer(owned, messages.filter(message => !admissible(message)));
          messages = messages.filter(admissible);
          if (!messages.length && owned.admittedTurn !== payload.turn) return { kind: 'reject' };
        } else {
          messages.push(...owned.deferred.splice(0).map(input => input.message));
        }
        if (!owned.capacityHeld) { await this.capacity.acquire(owned, payload.signal); owned.capacityHeld = true; }
        payload.signal.throwIfAborted();
        owned.admittedTurn = payload.turn;
        return { ...decision, messages };
      }),
      scope.on('agent/status', ({ status }) => this.emit(owned, { type: 'status', status })),
      scope.on('agent/error', ({ error }) => this.emit(owned, { type: 'error', message: describeError(error) })),
      scope.on('session/event', (session, event) => { if (session === native.session) this.observe(owned, event); }),
      scope.tools.guard(execution => {
        const close = owned.close;
        if (close && !(close.phase === 'after-turn' && close.turn !== undefined && close.turn === owned.turn)) return 'This Flow Agent is closing';
        if (execution.name !== 'plugin_manager') return undefined;
        const args = execution.arguments;
        const action = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).action : undefined;
        return typeof action === 'string' && managementWrites.has(action) ? 'Flow does not expose permission-affecting profile management writes' : undefined;
      }),
    );
    const commands = scope.get('commands');
    if (commands) owned.bindings.push(commands.register({ name: 'permission', description: 'Flow permissions are selected at creation',
      handler: () => { throw new Error('Flow does not expose permission changes'); } }));
    owned.bindings.push(...installFlowTools(scope, this.context, flow, execution => this.assertCaller(owned, execution), () => this.releaseCapacity(owned)));
    return owned;
  }
  private assertCaller(owned: OwnedAgent, execution: ToolRunContext): void {
    assertNoPendingConstruction(owned.flow);
    if (execution.agent !== owned.native) throw new Error('Tool caller does not match the bound native Agent');
    if (owned.close) {
      if (owned.close.phase === 'after-turn' && owned.close.turn !== undefined && owned.close.turn === owned.turn) return;
      throw new Error('Flow Agent no longer accepts business tools');
    }
    if (!this.context.has(owned.flow)) throw new Error('Flow Agent is not registered');
  }
  private defer(owned: OwnedAgent, messages: readonly UserMessage[]): void {
    const known = new Set(owned.deferred.map(input => input.message.id));
    for (const message of messages) if (!known.has(message.id)) { owned.deferred.push({ target: 'next-step', message }); known.add(message.id); }
  }
  private releaseCapacity(owned: OwnedAgent): void { owned.capacityHeld = false; this.capacity.release(owned); }
  private observe(owned: OwnedAgent, event: SessionEvent): void {
    if (event.type === 'user/message') owned.claimed.delete(event.data.id);
    else if (event.type === 'turn/start') owned.turn = event.data.turn;
    else if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      if (text && !event.data.interrupted) this.emit(owned, { type: 'output', text }, event.time);
      if (event.data.usage) this.emit(owned, { type: 'usage', usage: normalizeUsage(event.data.usage,
        { provider: event.data.message.source.provider, id: event.data.message.source.model }, event.time) }, event.time);
    } else if (event.type === 'assistant/attempt') {
      const usage = lastAssistantStreamChunk(event.data.stream, 'usage');
      const route = owned.native.session.requestContext();
      if (usage && route) this.emit(owned, { type: 'usage', usage: normalizeUsage(usage.usage, { provider: route.provider, id: route.model }, event.time) }, event.time);
    } else if (event.type === 'compaction/summary') {
      if (event.data.usage) this.emit(owned, { type: 'usage', usage: normalizeUsage(event.data.usage, { provider: event.data.provider, id: event.data.model }, event.time) }, event.time);
    } else if (event.type === 'turn/end') {
      this.releaseCapacity(owned); owned.turn = undefined; owned.admittedTurn = undefined;
      const reason = event.data.reason.kind;
      queueMicrotask(() => {
        this.emit(owned, { type: 'turn-end', reason: reason === 'error' || reason === 'max-tokens' ? 'failed' : reason === 'aborted' ? 'cancelled' : 'completed' }, event.time);
        if (owned.close?.phase === 'after-turn') this.cleanup(owned);
      });
    }
  }
  async send(agent: HostAgent, message: Message, mode: SendMode = 'followup', purpose: SendPurpose = 'input'): Promise<void> {
    const owned = this.active(agent);
    const input = createUserMessage({ source: { kind: 'flow', purpose, priority: message.priority ?? 'normal', waitCompletion: isWaitCompletion(message) },
      content: [{ type: 'text', text: typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload) }] });
    if (purpose === 'notification' && isWaitCompletion(message)) {
      owned.completions.set(input.id, input);
      for (const pending of [...owned.native.inbox.nextStep, ...owned.native.inbox.nextTurn]) if (!admissible(pending)) {
        this.defer(owned, [pending]); owned.native.inbox.remove(pending.id);
      }
    }
    if (mode === 'notice') owned.native.inject(input);
    else if (mode === 'steer') owned.native.steer(input);
    else owned.native.followup(input);
  }
  getStatus(agent: HostAgent): 'idle' | 'running' { return this.active(agent).native.status; }
  whenIdle(agent: HostAgent): Promise<void> { return this.active(agent).native.whenIdle(); }
  subscribe(agent: HostAgent, listener: (event: Readonly<HostEvent>) => void): () => void {
    const owned = this.active(agent); owned.listeners.add(listener); return () => { owned.listeners.delete(listener); };
  }
  private emit(owned: OwnedAgent, body: EventBody, timestamp = Date.now()): void {
    const event = Object.freeze({ ...body, agent: owned.public, timestamp }) as HostEvent;
    for (const listener of owned.listeners) try { listener(event); } catch {}
  }
  persist(agent: HostAgent): Promise<void> { return this.persistOwned(this.active(agent)); }
  private persistOwned(owned: OwnedAgent): Promise<void> {
    const pending: PendingInput[] = [
      ...[...owned.claimed.values()].map(message => ({ target: 'next-step' as const, message })), ...owned.deferred,
      ...owned.native.inbox.nextStep.map(message => ({ target: 'next-step' as const, message })),
      ...owned.native.inbox.nextTurn.map(message => ({ target: 'next-turn' as const, message })),
    ].filter(input => !isNotification(input.message));
    const saved: SavedAgent = { format: 'dsh-flow-agent', version: 1, profile: structuredClone(owned.public.profile), config: structuredClone(owned.config),
      workspaceRoot: owned.workspaceRoot, pending: structuredClone([...new Map(pending.map(input => [input.message.id, input])).values()]) };
    const operation = owned.persistTail.catch(() => {}).then(async () => {
      if (!this.host.get('sessionPersistence')) throw new Error('DSH persistence is unavailable');
      if (!await this.host.sessions.flush(owned.native.session)) throw new Error('DSH session has no successful durability listener');
      await mkdir(this.stateDirectory, { recursive: true });
      const path = this.metadataPath(saved.profile.sessionID), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }); await rename(temporary, path);
    });
    owned.persistTail = operation; return operation;
  }
  private metadataPath(id: string): string { return resolve(this.stateDirectory, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private async readMetadata(id: SessionID): Promise<SavedAgent> {
    const value = JSON.parse(await readFile(this.metadataPath(id), 'utf8')) as SavedAgent;
    if (!value || value.format !== 'dsh-flow-agent' || value.version !== 1 || value.profile?.sessionID !== id
      || !isAbsolute(value.workspaceRoot) || !value.config || !Array.isArray(value.pending)) throw new Error('Invalid saved Flow metadata');
    snapshotProfile(value.profile);
    for (const input of value.pending) {
      if (input.target !== 'next-step' && input.target !== 'next-turn') throw new Error('Invalid pending input target');
      if (input.message?.role !== 'user') throw new Error('Invalid pending input');
      input.message = freezeMessage(input.message);
    }
    return value;
  }
  async exportHistory(agent: HostAgent): Promise<string> {
    const owned = this.active(agent);
    const history: History = { format: 'dsh-flow-history', version: 1, backend: 'dsh', source: { sessionID: agent.profile.sessionID, name: agent.profile.name }, events: [...owned.native.session.snapshotEvents()] };
    return JSON.stringify(history);
  }
  summarizeContext(agent: HostAgent): Promise<ContextSummary> {
    const owned = this.business(agent), source = `${agent.profile.name} ${agent.profile.sessionID}`;
    const snapshot = contextText(owned.native.session.deriveMessages());
    return this.auxiliaryCall(owned, `${summaryInstruction}\n来源必须写为：${source}\n以下为调用时上下文快照。\n\n${snapshot}`, source);
  }
  mergeContextSummaries(agent: HostAgent, own: string, other: string): Promise<ContextSummary> {
    const owned = this.business(agent);
    const sources = [own, other].map(summary => parseContextSummary(summary).source);
    return this.auxiliaryCall(owned, `${summaryInstruction}\n合并、去重并归纳以下两份总结。保留双方来源、约束、未完成事项和矛盾。无法消解的分歧列为待确认事项。\n\n${own}\n\n${other}`, sources.join('；'));
  }
  private auxiliaryCall(owned: OwnedAgent, text: string, sources: string): Promise<ContextSummary> {
    const controller = new AbortController();
    const call = { controller, completion: Promise.resolve() as Promise<unknown> };
    const promise = (async () => {
      const assembler = new BlockAssembler();
      let actual: { provider: string; id: string } | undefined;
      const usage = () => assembler.usage && actual ? [normalizeUsage(assembler.usage, actual)] : [];
      try {
        await this.capacity.acquire(call, controller.signal);
        const prepared = await this.host.llm.prepareCall(owned.config, controller.signal);
        actual = { provider: prepared.config.provider, id: prepared.config.model };
        for await (const chunk of prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text }] }], signal: controller.signal })) assembler.push(chunk);
        const blocks = assembler.blocks(), result = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim();
        if (assembler.finish.kind !== 'stop' || blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
          throw new Error('Summary was empty, incomplete, truncated, or violated Flow summary v1');
        }
        const parsed = parseContextSummary(result);
        return { summary: `Flow 上下文总结 v1\n来源：${sources}\n\n${parsed.body}`, usage: usage() };
      } catch (error) { throw new AuxiliaryCallError(describeError(error), usage(), { cause: error }); }
      finally { this.capacity.release(call); owned.auxiliary.delete(call); }
    })();
    call.completion = promise; owned.auxiliary.add(call); return promise;
  }
  releaseAgent(agent: HostAgent, mode: ReleaseMode = 'after-turn'): Promise<void> {
    const terminal = this.terminal.get(agent);
    if (terminal) return terminal;
    const owned = this.record(agent);
    if (owned.close) {
      if (mode === 'immediate' && owned.close.phase === 'after-turn') { owned.close.mode = mode; this.cleanup(owned); }
      return owned.close.promise;
    }
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const close: CloseOperation = { phase: 'after-turn', mode, turn: owned.turn, promise, resolve: resolveClose, reject: rejectClose };
    owned.close = close;
    if (mode === 'after-turn' && close.turn !== undefined && owned.admittedTurn === close.turn && owned.native.status === 'running') {
      close.timer = setTimeout(() => { close.mode = 'immediate'; this.cleanup(owned); }, this.afterTurnTimeoutMs);
    } else this.cleanup(owned);
    return promise;
  }
  private cleanup(owned: OwnedAgent): void {
    const close = owned.close!;
    if (close.phase !== 'after-turn') return;
    clearTimeout(close.timer); close.phase = 'cleaning';
    close.timer = setTimeout(() => {
      if (close.phase !== 'cleaning') return;
      close.phase = 'abandoned';
      const error = new Error('Native cleanup abandoned: the immediate cleanup deadline elapsed; DSH cannot forcibly destroy in-process execution', { cause: close.persistenceError });
      this.emit(owned, { type: 'error', message: error.message }); this.unbind(owned); close.reject(error);
    }, this.immediateTimeoutMs);
    owned.native.cancel({ kind: 'disposed' }, { keepInbox: true });
    for (const call of owned.auxiliary) call.controller.abort(new Error('Flow Agent released'));
    void (async () => {
      await owned.native.whenIdle(); this.releaseCapacity(owned);
      await Promise.allSettled([...owned.auxiliary].map(call => call.completion));
      if (this.host.get('sessionPersistence')) await this.persistOwned(owned).catch(error => {
        close.persistenceError = error; this.emit(owned, { type: 'error', message: `Persistence failed during close: ${describeError(error)}` });
      });
      await awaitAuxiliaryUsageSettlements(this, owned.public);
      await owned.handle!.dispose();
    })().then(() => {
      if (close.phase === 'abandoned') return;
      clearTimeout(close.timer); close.phase = 'completed'; this.reserved.delete(owned.public.profile.sessionID);
      owned.deferred.length = 0; owned.claimed.clear(); owned.completions.clear(); this.unbind(owned);
      this.terminal.set(owned.public, close.promise); this.owned.delete(owned.public); close.resolve();
    }, error => {
      if (close.phase === 'abandoned') return;
      clearTimeout(close.timer); close.phase = 'failed'; this.unbind(owned); close.reject(error);
    });
  }
  private unbind(owned: OwnedAgent): void {
    if (owned.native.status === 'idle') this.releaseCapacity(owned);
    for (const dispose of owned.bindings.splice(0)) try { dispose(); } catch { }
    owned.listeners.clear();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = Promise.allSettled([...this.owned.keys()].map(agent => this.releaseAgent(agent))).then(results => {
      this.removeUsageSink();
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'DSH Agent bindings failed to release');
    });
    return this.disposal;
  }
  private assertOpen(): void { if (this.disposed) throw new Error('DSH adaptor is disposed'); }
  private record(agent: HostAgent): OwnedAgent {
    const owned = this.owned.get(agent);
    if (!owned) throw new Error(this.terminal.has(agent) ? 'HostAgent is released' : 'HostAgent belongs to another adaptor');
    return owned;
  }
  private active(agent: HostAgent): OwnedAgent {
    const owned = this.record(agent);
    if (owned.close) throw new Error('HostAgent is closing or released');
    return owned;
  }
  private business(agent: HostAgent): OwnedAgent {
    const owned = this.record(agent);
    if (owned.close && !(owned.close.phase === 'after-turn' && owned.close.turn !== undefined && owned.close.turn === owned.turn)) throw new Error('HostAgent is closing or released');
    return owned;
  }
}
