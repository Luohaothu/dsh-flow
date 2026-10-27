import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent, AgentHandle, AssistantStreamFrame, InboxTarget } from '@deepseek-ai/dsh-agent';
import { BlockAssembler, createUserMessage, lastAssistantStreamChunk,
  type LlmCallConfig, type RequestMessage, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed, snapshotSessionEvent, type SessionEvent } from '@deepseek-ai/dsh-session';
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
import { emitCore } from '../core/observation.js';
import { snapshotProfile } from '../core/profile.js';
import { isWaitCompletion, sessionID } from '../core/message.js';
import { decodeModelConfiguration } from './configuration.js';
import { AuxiliaryCallError, registerAuxiliaryUsageSink, awaitAuxiliaryUsageSettlements } from '../core/auxiliary-usage.js';
import { ExecutionCapacity } from './capacity.js';
import { NativePreparation, decodeNativeRecipe, nativeService } from './provisioning.js';
import type { NativePlan, NativeRecipe } from './native-types.js';
import { NativeFlowBindings } from './native-bindings.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { flow: { kind: 'flow'; purpose: SendPurpose; priority: 'high' | 'normal' | 'low'; waitCompletion: boolean } }
}
export interface DshHostAdaptorOptions {
  workspaceRoot: string;
  stateDirectory: string;
  afterTurnTimeoutMs?: number;
  immediateTimeoutMs?: number;
  capacity?: ExecutionCapacity;
  preparation?: NativePreparation;
  bindings?: NativeFlowBindings;
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
  deadline?: number;
  reason?: string;
}
interface OwnedAgent {
  public: HostAgent;
  native: NativeAgent;
  flow: Agent;
  handle?: AgentHandle;
  config: LlmCallConfig;
  workspaceRoot: string;
  recipe: NativeRecipe;
  commit(): void;
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
  attempts: Map<string, { callId: string; model?: { provider: string; id: string }; latest?: Usage }>;
  settlements: Map<number, { usage?: TokenUsage; model?: { provider: string; id: string }; timestamp: number }>;
  settledSeqs: Set<number>;
  approvals: Map<string, { toolName: string; reason?: string; automatic: boolean }>;
  auxiliary: Set<{ controller: AbortController; completion: Promise<unknown> }>;
}
interface SavedAgent {
  format: 'dsh-flow-agent'; version: 2; profile: AgentProfile; config: LlmCallConfig; workspaceRoot: string; recipe: NativeRecipe; pending: PendingInput[];
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
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return Object.fromEntries(Object.entries(value));
}
function dataKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`Unknown ${label} field`);
}
function dataText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid ${label}`);
  return value;
}
function decodeProfile(value: unknown): AgentProfile {
  const p = dataRecord(value, 'Profile');
  dataKeys(p, ['role', 'sessionID', 'permission', 'name', 'model', 'params', 'hostExtras'], 'Profile');
  const model = dataRecord(p.model, 'model'); dataKeys(model, ['provider', 'id'], 'model');
  const params = dataRecord(p.params, 'params'); dataKeys(params, ['version', 'reasoningEffort', 'temperature', 'maxTokens'], 'params');
  if (params.version !== 1 || (p.permission !== 'read-only' && p.permission !== 'workspace-write' && p.permission !== 'full-access')) throw new TypeError('Invalid Profile permission or params version');
  if (params.temperature !== undefined && (typeof params.temperature !== 'number' || !Number.isFinite(params.temperature))) throw new TypeError('Invalid Profile temperature');
  if (params.maxTokens !== undefined && (typeof params.maxTokens !== 'number' || !Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) throw new TypeError('Invalid Profile maxTokens');
  return snapshotProfile({ role: dataText(p.role, 'role'), name: dataText(p.name, 'name'), sessionID: sessionID(dataText(p.sessionID, 'sessionID')),
    permission: p.permission, model: { provider: dataText(model.provider, 'provider'), id: dataText(model.id, 'model id') },
    params: { version: 1, ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
      ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: dataText(params.reasoningEffort, 'reasoningEffort') }) },
    ...(p.hostExtras === undefined ? {} : { hostExtras: dataRecord(p.hostExtras, 'hostExtras') }) });
}
function positiveInteger(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function assertPendingMessage(value: unknown): asserts value is UserMessage {
  const m = dataRecord(value, 'pending message'); dataKeys(m, ['id', 'role', 'source', 'content'], 'pending message');
  dataText(m.id, 'message id');
  if (m.role !== 'user' || !Array.isArray(m.content)) throw new TypeError('Invalid pending message role or content');
  const source = dataRecord(m.source, 'message source'); dataText(source.kind, 'source kind');
  if (source.kind === 'model') { dataText(source.provider, 'model source provider'); dataText(source.model, 'model source route'); }
  if (source.kind === 'tool') dataText(source.callId, 'tool source callId');
  if (source.kind === 'skill-invocation' && (source.form !== 'instructions' || typeof source.name !== 'string' || !source.name.trim())) throw new TypeError('Invalid skill invocation source');
  if (source.kind === 'flow-outcome') { dataText(source.runId, 'outcome Run'); dataText(source.assignmentId, 'outcome assignment'); }
  if (source.form === 'notice' && typeof source.summary !== 'string') throw new TypeError('Invalid notice source summary');
  if (source.form === 'snapshot') {
    if (!Array.isArray(source.sections)) throw new TypeError('Invalid source snapshot sections');
    for (const entry of source.sections) {
      const section = dataRecord(entry, 'source snapshot section'); dataKeys(section, ['name', 'text'], 'source snapshot section');
      dataText(section.name, 'source section name'); if (typeof section.text !== 'string') throw new TypeError('Invalid source section text');
    }
  }
  if (source.kind === 'flow' && ((source.purpose !== 'input' && source.purpose !== 'notification')
    || !['high', 'normal', 'low'].includes(String(source.priority)) || typeof source.waitCompletion !== 'boolean')) throw new TypeError('Invalid pending Flow source');
  for (const raw of m.content) {
    const block = dataRecord(raw, 'message content block');
    if (block.type === 'text' || block.type === 'reasoning') {
      dataKeys(block, ['type', 'text'], 'text block'); if (typeof block.text !== 'string') throw new TypeError('Invalid content text');
    } else if (block.type === 'image' || block.type === 'file') {
      dataKeys(block, block.type === 'image' ? ['type', 'attachment', 'offloaded'] : ['type', 'attachment'], 'attachment block');
      const ref = dataRecord(block.attachment, 'attachment reference');
      dataText(ref.attachmentId, 'attachment identity');
      if (typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new TypeError('Invalid attachment bytes');
      if (block.type === 'image') {
        dataKeys(ref, ['attachmentId', 'bytes', 'mediaType', 'width', 'height', 'name', 'originalDimensions'], 'image reference');
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(ref.mediaType)) || !positiveInteger(ref.width) || !positiveInteger(ref.height)
          || (block.offloaded !== undefined && block.offloaded !== true)) throw new TypeError('Invalid image reference');
        if (ref.originalDimensions !== undefined) {
          const size = dataRecord(ref.originalDimensions, 'image dimensions'); dataKeys(size, ['width', 'height'], 'image dimensions');
          if (!positiveInteger(size.width) || !positiveInteger(size.height)) throw new TypeError('Invalid original image dimensions');
        }
        if (ref.name !== undefined) dataText(ref.name, 'image name');
      } else { dataKeys(ref, ['attachmentId', 'bytes', 'name'], 'file reference'); dataText(ref.name, 'file name'); }
    } else if (block.type === 'tool-call') {
      dataKeys(block, ['type', 'id', 'name', 'arguments'], 'tool-call block'); dataText(block.id, 'tool call id'); dataText(block.name, 'tool name');
      if (typeof block.arguments !== 'string') throw new TypeError('Invalid tool arguments');
    } else if (block.type === 'tool-addition' || block.type === 'tool-removal') {
      dataKeys(block, ['type', 'toolName'], 'tool change block'); dataText(block.toolName, 'tool name');
    } else throw new TypeError('Unsupported pending content block');
  }
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
  private readonly preparation: NativePreparation;
  private readonly nativeBindings: NativeFlowBindings;
  private readonly stateDirectory: string;
  private readonly removeUsageSink: () => void;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(readonly host: DshContext, private readonly context: Context, options: DshHostAdaptorOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.preparation = options.preparation ?? new NativePreparation(host, context, { cwd: resolve(options.workspaceRoot) });
    if (this.preparation.context !== context || this.preparation.host !== host) throw new Error('Native preparation belongs to another Context or host');
    this.nativeBindings = options.bindings ?? new NativeFlowBindings(host);
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
    this.reserve(profile.sessionID);
    let owned: OwnedAgent | undefined;
    let plan: NativePlan | undefined;
    let lease: { dispose(): void } | undefined;
    try {
      plan = this.preparation.consume(profile.sessionID, flow, profile);
      if (!plan) {
        const prepared = await this.preparation.prepare(profile, {});
        lease = this.preparation.reserve(prepared);
        plan = this.preparation.consume(profile.sessionID, flow, profile)!;
      }
      if (await this.host.get('sessionPersistence')?.stat(SessionId(profile.sessionID))) throw new Error('Session already exists; resume is required');
      const imported = history === undefined ? undefined : parseHistory(history);
      const last = imported?.events.at(-1);
      const seed = last === undefined ? undefined : buildForkSeed(imported!.events, last.seq);
      const creation = plan;
      const handle = await this.host.agents.create({ sessionId: SessionId(profile.sessionID),
        meta: { cwd: creation.cwd, origin: 'subagent', ...(seed ? { parentSession: SessionId(imported!.source.sessionID), isSeeded: true } : {}) },
        ...(seed ? { seed, inheritedEventCount: SessionLogOffset(imported!.events.length) } : {}), agentOptions: structuredClone(creation.config),
        setup: async (scope, native) => { owned = await this.bind(scope, native, flow, creation); return { commit: () => { this.assertOpen(); owned!.commit(); } }; },
      });
      if (!owned) { await handle.dispose(); throw new Error('DSH did not initialize the Agent scope'); }
      owned.handle = handle; this.owned.set(owned.public, owned);
      return owned.public;
    } catch (error) {
      if (owned) { this.unbind(owned); await owned.handle?.dispose(); this.owned.delete(owned.public); }
      if (plan) this.preparation.release(plan, flow);
      this.reserved.delete(profile.sessionID); throw error;
    } finally { lease?.dispose(); }
  }
  async resumeAgent(flow: Agent, id: SessionID): Promise<HostAgent> {
    this.assertOpen();
    if (!this.host.get('sessionPersistence')) throw new Error('DSH persistence is unavailable');
    this.reserve(id);
    let owned: OwnedAgent | undefined;
    let plan: NativePlan | undefined;
    let lease: { dispose(): void } | undefined;
    try {
      const saved = await this.readMetadata(id);
      plan = await this.preparation.prepareSaved(saved.profile, saved.config, saved.workspaceRoot, saved.recipe);
      lease = this.preparation.reserve(plan);
      this.preparation.consume(id, flow, saved.profile);
      const restoration = plan;
      const handle = await this.host.agents.resume({ resumeSessionId: SessionId(id), agentOptions: structuredClone(restoration.config),
        setup: async (scope, native) => {
          owned = await this.bind(scope, native, flow, restoration);
          if (resolve(native.session.header.cwd ?? '') !== saved.workspaceRoot) throw new Error('Persisted workspace differs from the saved permission boundary');
          for (const input of [...native.inbox.nextTurn, ...native.inbox.nextStep]) if (isNotification(input)) native.inbox.remove(input.id);
          const existing = new Set([...native.inbox.nextTurn, ...native.inbox.nextStep].map(message => message.id));
          for (const event of native.session.snapshotEvents()) if (event.type === 'user/message') existing.add(event.data.id);
          for (const pending of saved.pending) if (!isNotification(pending.message) && !existing.has(pending.message.id)) {
            native.inbox.append(pending.target, pending.message); existing.add(pending.message.id);
          }
          native.inject(createUserMessage({ source: { kind: 'flow', purpose: 'notification', priority: 'normal', waitCompletion: false },
            content: [{ type: 'text', text: recoveryInstruction }] }));
          return { commit: () => { this.assertOpen(); owned!.commit(); } };
        },
      });
      if (!owned) { await handle.dispose(); throw new Error('DSH did not initialize the resumed scope'); }
      owned.handle = handle; this.owned.set(owned.public, owned); return owned.public;
    } catch (error) {
      if (owned) { this.unbind(owned); await owned.handle?.dispose(); this.owned.delete(owned.public); }
      if (plan) this.preparation.release(plan, flow);
      this.reserved.delete(id); throw error;
    } finally { lease?.dispose(); }
  }
  private reserve(id: string): void {
    if (this.reserved.has(id) || this.host.agents.get(SessionId(id))) throw new Error('Session already has an active Agent');
    this.reserved.add(id);
  }
  private async bind(scope: DshContext, native: NativeAgent, flow: Agent, plan: NativePlan): Promise<OwnedAgent> {
    const binding = this.nativeBindings.bind(native, flow, plan);
    const releaseBinding = scope.effect(() => () => { this.nativeBindings.release(binding); this.preparation.release(plan, flow); });
    const { profile, cwd: workspaceRoot } = plan;
    const config = structuredClone(plan.config);
    const owned: OwnedAgent = { public: Object.freeze({ profile }), native, flow, config, workspaceRoot, recipe: plan.recipe, commit: () => { throw new Error('Native installation is incomplete'); }, listeners: new Set(), bindings: [releaseBinding],
      deferred: [], claimed: new Map(), completions: new Map(), capacityHeld: false, persistTail: Promise.resolve(), auxiliary: new Set(), attempts: new Map(), settlements: new Map(), settledSeqs: new Set(), approvals: new Map() };
    const installation = await this.preparation.install(scope, native, plan);
    owned.commit = installation.commit;
    const mode = profile.permission === 'full-access' ? 'danger-full-access' : profile.permission;
    setSandboxMode(native.session, mode); setApprovalPolicy(native.session, 'never');
    const installed = nativeService(this.host, scope, 'sandboxPolicy').resolve({ session: native.session });
    if (installed.mode !== mode || resolve(installed.workspaceRoot) !== workspaceRoot) throw new Error('Requested initial file permission could not be installed');
    owned.bindings.push(
      nativeService(this.host, scope, 'systemPrompt').section({ name: 'flow-role', order: 0, text: profile.role, interpolate: false }),
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
      scope.on('agent/assistant-stream', ({ frame }) => this.observeStream(owned, frame)),
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
    owned.bindings.push(...this.nativeBindings.installMember(scope, binding, execution => this.assertCaller(owned, execution), () => this.releaseCapacity(owned)));
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
    else if (event.type === 'approval/asked') owned.approvals.set(event.data.id, { toolName: event.data.toolName,
      ...(event.data.reason === undefined ? {} : { reason: event.data.reason }), automatic: this.host.approval.overrideOf(owned.native.session) === 'never' });
    else if (event.type === 'approval/decided') {
      const request = owned.approvals.get(event.data.id); owned.approvals.delete(event.data.id);
      if (request?.automatic && event.data.outcome === 'rejected') this.emit(owned,
        { type: 'auto-reject', message: `${request.toolName}: ${request.reason ?? 'Approval policy never rejected this request'}` }, event.time);
    }
    else if (event.type === 'turn/start') owned.turn = event.data.turn;
    else if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      if (text && !event.data.interrupted) this.emit(owned, { type: 'output', text }, event.time);
      this.observeSettlement(owned, event);
    } else if (event.type === 'assistant/attempt') {
      this.observeSettlement(owned, event);
    } else if (event.type === 'compaction/summary') {
      if (event.data.usage && !owned.settledSeqs.has(event.seq)) {
        owned.settledSeqs.add(event.seq);
        this.emit(owned, { type: 'usage', usage: { ...normalizeUsage(event.data.usage,
          { provider: event.data.provider, id: event.data.model }, event.time), callId: `compaction:${event.seq}`, kind: 'compaction' } }, event.time);
      }
    } else if (event.type === 'turn/end') {
      this.releaseCapacity(owned); owned.turn = undefined; owned.admittedTurn = undefined;
      const reason = event.data.reason.kind;
      queueMicrotask(() => {
        this.emit(owned, { type: 'turn-end', reason: reason === 'error' || reason === 'max-tokens' ? 'failed' : reason === 'aborted' ? 'cancelled' : 'completed' }, event.time);
        if (owned.close?.phase === 'after-turn') this.cleanup(owned);
      });
    }
  }
  /** rc.2 commits assistant settlement before its end frame; keep the seq until that correlation arrives. */
  private observeSettlement(owned: OwnedAgent, event: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>): void {
    if (owned.settledSeqs.has(event.seq)) return;
    const route = event.type === 'assistant/message'
      ? { provider: event.data.message.source.provider, id: event.data.message.source.model }
      : owned.native.session.requestContext();
    const usage = event.type === 'assistant/message' ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
    const model = route && { provider: route.provider, id: 'id' in route ? route.id : route.model };
    owned.settlements.set(event.seq, { ...(usage ? { usage } : {}), ...(model ? { model } : {}), timestamp: event.time });
    // Imported history is not observed; non-stream native producers still get a stable durable call identity.
    if (!owned.attempts.size) this.settleUsage(owned, event.seq, `main:seq:${event.seq}`);
  }
  private settleUsage(owned: OwnedAgent, seq: number, callId: string, latest?: Usage): void {
    const settled = owned.settlements.get(seq);
    if (!settled) return;
    owned.settlements.delete(seq); owned.settledSeqs.add(seq);
    if (!settled.usage || !settled.model) return;
    const usage: Usage = { ...normalizeUsage(settled.usage, settled.model, settled.timestamp), callId, kind: 'main' };
    if (!latest || !this.sameUsage(latest, usage)) this.emit(owned, { type: 'usage', usage }, settled.timestamp);
  }
  private sameUsage(a: Usage, b: Usage): boolean {
    return a.model.provider === b.model.provider && a.model.id === b.model.id
      && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.totalTokens === b.totalTokens
      && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens;
  }
  private observeStream(owned: OwnedAgent, frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      const route = owned.native.session.requestContext();
      owned.attempts.set(frame.attemptId, { callId: `main:${frame.attemptId}`,
        ...(route ? { model: { provider: route.provider, id: route.model } } : {}) });
      return;
    }
    const attempt = owned.attempts.get(frame.attemptId);
    if (!attempt) return;
    if (frame.type === 'chunk' && frame.chunk.type === 'usage' && attempt.model) {
      const usage: Usage = { ...normalizeUsage(frame.chunk.usage, attempt.model, frame.time), callId: attempt.callId, kind: 'main' };
      if (!attempt.latest || !this.sameUsage(attempt.latest, usage)) {
        attempt.latest = usage; this.emit(owned, { type: 'usage', usage }, frame.time);
      }
    } else if (frame.type === 'end') {
      if (frame.outcome.kind === 'committed') this.settleUsage(owned, frame.outcome.seq, attempt.callId, attempt.latest);
      owned.attempts.delete(frame.attemptId);
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
    const saved: SavedAgent = { format: 'dsh-flow-agent', version: 2, profile: structuredClone(owned.public.profile), config: structuredClone(owned.config),
      workspaceRoot: owned.workspaceRoot, recipe: structuredClone(owned.recipe), pending: structuredClone([...new Map(pending.map(input => [input.message.id, input])).values()]) };
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
    const value: unknown = JSON.parse(await readFile(this.metadataPath(id), 'utf8'));
    const input = dataRecord(value, 'saved Flow metadata');
    dataKeys(input, ['format', 'version', 'profile', 'config', 'workspaceRoot', 'recipe', 'pending'], 'saved Flow metadata');
    if (input.format !== 'dsh-flow-agent' || input.version !== 2 || typeof input.workspaceRoot !== 'string'
      || !isAbsolute(input.workspaceRoot) || resolve(input.workspaceRoot) !== input.workspaceRoot || !Array.isArray(input.pending)) throw new Error('Invalid saved Flow metadata');
    const profile = decodeProfile(input.profile);
    if (profile.sessionID !== id) throw new Error('Saved Profile identity does not match requested session');
    const pending = input.pending.map((item: unknown): PendingInput => {
      const entry = dataRecord(item, 'pending input'); dataKeys(entry, ['target', 'message'], 'pending input');
      if (entry.target !== 'next-step' && entry.target !== 'next-turn') throw new Error('Invalid pending input target');
      assertPendingMessage(entry.message);
      const event = snapshotSessionEvent({ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: entry.message });
      return { target: entry.target, message: event.data };
    });
    return { format: 'dsh-flow-agent', version: 2, profile, config: decodeModelConfiguration(input.config),
      workspaceRoot: input.workspaceRoot, recipe: decodeNativeRecipe(input.recipe), pending };
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
    const controller = new AbortController(), callId = `aux:${randomUUID()}`;
    const call = { controller, completion: Promise.resolve() as Promise<unknown> };
    const promise = (async () => {
      const assembler = new BlockAssembler();
      let actual: { provider: string; id: string } | undefined;
      const usage = () => assembler.usage && actual ? [{ ...normalizeUsage(assembler.usage, actual), callId, kind: 'auxiliary' as const }] : [];
      try {
        await this.capacity.acquire(call, controller.signal);
        const prepared = await nativeService(this.host, owned.native.ctx, 'llm').prepareCall(owned.config, controller.signal);
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
      if (mode === 'immediate' && owned.close.phase === 'after-turn') { owned.close.mode = mode; owned.close.reason = 'immediate-request'; this.cleanup(owned); }
      return owned.close.promise;
    }
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const close: CloseOperation = { phase: 'after-turn', mode, turn: owned.turn, promise, resolve: resolveClose, reject: rejectClose };
    owned.close = close;
    this.observeCleanup(owned, 'pending', mode === 'immediate' ? 'immediate-request' : 'release-request');
    if (mode === 'after-turn' && close.turn !== undefined && owned.admittedTurn === close.turn && owned.native.status === 'running') {
      close.deadline = Date.now() + this.afterTurnTimeoutMs;
      this.observeCleanup(owned, 'waiting', 'after-turn');
      close.timer = setTimeout(() => { close.mode = 'immediate'; close.reason = 'after-turn-timeout'; this.cleanup(owned); }, this.afterTurnTimeoutMs);
    } else this.cleanup(owned);
    return promise;
  }
  private cleanup(owned: OwnedAgent): void {
    const close = owned.close!;
    if (close.phase !== 'after-turn') return;
    clearTimeout(close.timer); close.phase = 'cleaning';
    close.deadline = Date.now() + this.immediateTimeoutMs;
    this.observeCleanup(owned, 'releasing', close.reason ?? (close.mode === 'immediate' ? 'immediate-request' : 'turn-completed'));
    close.timer = setTimeout(() => {
      if (close.phase !== 'cleaning') return;
      close.phase = 'abandoned';
      this.observeCleanup(owned, 'abandoned', 'immediate-cleanup-timeout');
      const error = new Error('Native cleanup abandoned: the immediate cleanup deadline elapsed; DSH cannot forcibly destroy in-process execution', { cause: close.persistenceError });
      this.emit(owned, { type: 'error', message: error.message }); this.unbind(owned); close.reject(error);
    }, this.immediateTimeoutMs);
    owned.native.cancel({ kind: 'disposed' }, { keepInbox: true });
    for (const call of owned.auxiliary) call.controller.abort(new Error('Flow Agent released'));
    void (async () => {
      await owned.native.whenIdle(); this.releaseCapacity(owned);
      await Promise.allSettled([...owned.auxiliary].map(call => call.completion));
      if (this.host.get('sessionPersistence')) await this.persistOwned(owned).catch(error => {
        close.persistenceError = error; this.observeCleanup(owned, 'releasing', 'persistence-failed'); this.emit(owned, { type: 'error', message: `Persistence failed during close: ${describeError(error)}` });
      });
      await awaitAuxiliaryUsageSettlements(this, owned.public);
      await owned.handle!.dispose();
    })().then(() => {
      if (close.phase === 'abandoned') return;
      clearTimeout(close.timer); close.phase = 'completed'; this.observeCleanup(owned, 'complete', 'resources-released'); this.reserved.delete(owned.public.profile.sessionID);
      owned.deferred.length = 0; owned.claimed.clear(); owned.completions.clear(); this.unbind(owned);
      this.terminal.set(owned.public, close.promise); this.owned.delete(owned.public); close.resolve();
    }, error => {
      if (close.phase === 'abandoned') return;
      clearTimeout(close.timer); close.phase = 'failed'; this.observeCleanup(owned, 'failed', describeError(error)); this.unbind(owned); close.reject(error);
    });
  }
  private observeCleanup(owned: OwnedAgent, phase: 'pending' | 'waiting' | 'releasing' | 'complete' | 'failed' | 'abandoned', reason: string): void {
    const close = owned.close!;
    emitCore(this.context, { type: 'host-cleanup', agent: owned.flow, timestamp: Date.now(), phase, reason,
      ...(close.deadline === undefined ? {} : { deadline: close.deadline }),
      ...(close.persistenceError === undefined ? {} : { persistenceError: describeError(close.persistenceError) }) });
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
