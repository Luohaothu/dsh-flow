import type { Context } from './context.js';
import type { Group } from './group.js';
import { Mailbox } from './mailbox.js';
import { agentControl, contextControl, groupControl, mailboxControl, createOwned, type AgentControl, type TerminationInitiator } from './internals.js';
import { deadlineAfter, scheduleDeadline, type DeadlineTimer } from './deadline.js';
import { AuxiliaryCallError, beginAuxiliaryUsageSettlement, settleAuxiliaryUsage } from './auxiliary-usage.js';
import { checkPermission, snapshotProfile } from './profile.js';
import { formatSource, isTrustedSystemMessage, markWaitCompletion, newSessionID, sameSource, snapshotMessage, snapshotSource, sourceAgent, trustedSystemMessage, waitDescription } from './message.js';
import { assertConstructionAccess, assertConstructionParticipant, assertNoPendingConstruction, assertConstructionScope, assertConstructionSource, beginConstructionAttempt, hasNoPendingConstruction, ownConstructionResource, recordConstructionCleanupFailure, type ConstructionScope } from './construction.js';
import { emitCore, getAgentInstanceId, setAgentAppearance, findRetrySource, recordAgentTermination, type AgentOutcome } from './observation.js';
import type { AgentProfile, AgentStatus, ContextSummary, HostAdaptor, HostAgent, HostEvent, MailboxQuery, Message, MessageID, MessageMeta, MessageSource, SessionID, Signal, Usage, WaitResult } from './types.js';

type Binding = { kind: 'initializing' } | { kind: 'bound'; host: HostAgent; unsubscribe?: () => void } | { kind: 'released'; host?: HostAgent };
type WaitRecord = { condition: MailboxQuery; startedAt: number; timeout: number; deadline: number; timer?: DeadlineTimer; evaluating: boolean; registered: boolean; examined: Set<MessageID> };
type Batch = { entries: MessageMeta[]; prompted: MessageSource[]; message: Message; mode: 'followup' | 'steer' };

export class Agent {
  private binding: Binding = { kind: 'initializing' };
  private readonly mailbox = new Mailbox();
  private parent: Agent | null = null;
  private readonly children = new Set<Agent>();
  private readonly groups = new Set<Group>();
  private status: AgentStatus = 'idle';
  private published = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private strongestSignal: Signal = 'SIGTERM';
  private nativeRound = false;
  private temporaryRun = false;
  private pendingWait: WaitRecord | undefined;
  private pending = new Map<MessageID, MessageMeta>();
  private submitting = new Set<MessageID>();
  private prompted: MessageSource[] = [];
  private prompting: MessageSource[] = [];
  private lastResult: AgentOutcome | undefined;
  private roundError = false;
  private lastAssignmentResult: AgentOutcome | undefined;
  private queuedEvents: Readonly<HostEvent>[] = [];
  readonly [agentControl]: AgentControl;

  private constructor(private readonly context: Context, private readonly adaptor: HostAdaptor, scope?: ConstructionScope) {
    getAgentInstanceId(this);
    const self = this;
    this[agentControl] = {
      get context() { return self.context; },
      get host() { return self.host(); },
      get status() { return self.status; },
      assertAvailable: owner => this.assertAvailable(owner),
      join: (group, owner) => this.associateGroup(group, owner),
      leave: group => { this.groups.delete(group); },
      release: (signal, initiator = 'context', propagated = false) => this.terminate(signal, initiator, propagated),
      kill: (child, initiator) => this.killWithInitiator(child, initiator),
      getRetrySource: retryOf => { this.assertAvailable(); return findRetrySource(this.context, getAgentInstanceId(this), retryOf); },
      retry: (profile, retryOf, initmsg, history) => {
        try {
          this.assertAvailable(); const source = findRetrySource(this.context, getAgentInstanceId(this), retryOf);
          return Agent.createFrom(this.context, profile, this, initmsg, history, [this], 'retry', undefined, [source.id]);
        } catch (error) { return Promise.reject(error); }
      },
      recordAssignmentOutcome: status => { this.lastAssignmentResult = status === 'pending' ? undefined : status === 'submitted' ? 'completed' : status === 'failed' ? 'failed' : 'stopped'; },
    };
    this.mailbox[mailboxControl].bind(context);
    if (scope) { ownConstructionResource(scope, this, 'agent'); ownConstructionResource(scope, this.mailbox, 'mailbox'); }
    this.mailbox[mailboxControl].onRead(message => emitCore(context, { type: 'message-read', timestamp: Date.now(), agent: this, message }));
  }
  getProfile(): Readonly<AgentProfile> { return this.host().profile; }
  getParent(): Agent | null { return hasNoPendingConstruction(this) && (!this.parent || hasNoPendingConstruction(this.parent)) ? this.parent : null; }
  getChildren(): Agent[] { return hasNoPendingConstruction(this) ? [...this.children].filter(hasNoPendingConstruction) : []; }
  getStatus(): AgentStatus { return this.status; }
  hasPendingWait(): boolean { return this.pendingWait !== undefined; }
  getMailbox(): Mailbox { return this.mailbox; }

  static create(ctx: Context, p: AgentProfile, parent: Agent | null, initmsg?: Message, history?: string): Promise<Agent> {
    return Agent.createFrom(ctx, p, parent, initmsg, history, parent ? [parent] : [], 'create');
  }
  static [createOwned](scope: ConstructionScope, profile: AgentProfile, parent: Agent): Promise<Agent> {
    try {
      assertConstructionParticipant(scope, parent);
      return Agent.createFrom(scope.context, profile, parent, undefined, undefined, [parent], 'create', scope);
    } catch (error) { return Promise.reject(error); }
  }
  private static createFrom(ctx: Context, profile: AgentProfile, parent: Agent | null, initmsg: Message | undefined, history: string | undefined, sources: Agent[], origin: 'create' | 'fork' | 'herb' | 'retry', scope?: ConstructionScope, sourceIds?: readonly string[]): Promise<Agent> {
    let p: Readonly<AgentProfile>;
    let input: Message | undefined;
    try {
      ctx[contextControl].assertOpen();
      if (parent) ctx[contextControl].assertAvailable(parent, scope);
      for (const source of sources) ctx[contextControl].assertAvailable(source, scope);
      p = snapshotProfile(profile);
      checkPermission(p, parent?.getProfile() ?? null);
      input = initmsg === undefined ? undefined : snapshotMessage(initmsg);
      if (input) assertConstructionSource(input.source);
    } catch (error) { return Promise.reject(error); }
    return Agent.assemble(ctx, parent, agent => agent.adaptor.createAgent(agent, p, history), sources, origin, input, scope, undefined, sourceIds);
  }
  static resume(ctx: Context, parent: Agent | null, session: SessionID): Promise<Agent> {
    return Agent.assemble(ctx, parent, agent => agent.adaptor.resumeAgent(agent, session), parent ? [parent] : [], 'resume', undefined, undefined, session);
  }
  private static async assemble(ctx: Context, parent: Agent | null, initialize: (agent: Agent) => Promise<HostAgent>, sources: Agent[], origin: 'create' | 'resume' | 'fork' | 'herb' | 'retry', input?: Message, scope?: ConstructionScope, resumeSessionID?: string, sourceIds?: readonly string[]): Promise<Agent> {
    ctx[contextControl].assertOpen();
    if (parent) ctx[contextControl].assertAvailable(parent, scope);
    for (const source of sources) ctx[contextControl].assertAvailable(source, scope);
    const adaptor = ctx.getHostAdaptor();
    const finishCreation = ctx[contextControl].beginCreation();
    const finishOwned = scope ? beginConstructionAttempt(scope) : undefined;
    const agent = new Agent(ctx, adaptor, scope);
    const createdAt = Date.now();
    try {
      const host = await initialize(agent);
      if (agent.closing) {
        agent.binding = { kind: 'released', host };
        const release = Promise.resolve().then(() => adaptor.releaseAgent(host, 'immediate'));
        ctx[contextControl].trackRelease(agent, release);
        try { await release; } catch (error) { recordConstructionCleanupFailure(scope, agent, error); throw error; }
        throw new Error('Agent terminated during initialization');
      }
      agent.binding = { kind: 'bound', host };
      if (scope) assertConstructionScope(scope, ctx);
      snapshotProfile(host.profile);
      checkPermission(host.profile, parent?.getProfile() ?? null);
      agent.nativeRound = adaptor.getStatus(host) === 'running';
      agent.binding.unsubscribe = adaptor.subscribe(host, event => agent.onHostEvent(event));
      ctx[contextControl].publish(agent, agent.mailbox, sources, () => {
        if (agent.closing) throw new Error('Agent terminated during initialization');
        agent.parent = parent;
        parent?.children.add(agent);
        agent.published = true;
        setAgentAppearance(agent, host.profile, parent, origin, sources, createdAt, resumeSessionID, !scope, sourceIds);
      }, scope);
      emitCore(ctx, { type: 'agent-created', timestamp: Date.now(), agent, parent, origin, sources: origin === 'retry' ? [] : sources.slice(), sourceIds: sourceIds ? [...sourceIds] : sources.map(getAgentInstanceId) });
      for (const event of agent.queuedEvents.splice(0)) agent.onHostEvent(event);
      agent.assertAvailable(scope);
      for (const source of sources) ctx[contextControl].assertAvailable(source, scope);
      if (input) {
        agent.nativeRound = true;
        agent.setStatus('running');
        agent.assertAvailable(scope);
        assertConstructionSource(input.source);
        await adaptor.send(host, input, 'followup', 'input');
        agent.assertAvailable(scope);
      } else agent.syncStatus();
      return agent;
    } catch (error) {
      const cleanup: unknown[] = [];
      agent.lastResult = 'failed';
      try { await agent.terminate('SIGKILL', 'self'); } catch (failure) { cleanup.push(failure); recordConstructionCleanupFailure(scope, agent, failure); }
      agent.parent?.children.delete(agent);
      agent.parent = null;
      ctx[contextControl].rollback(agent, agent.mailbox);
      if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Agent initialization and rollback failed');
      throw error;
    } finally { finishOwned?.(); finishCreation(); }
  }
  async fork(): Promise<Agent> {
    this.assertAvailable();
    const history = await this.adaptor.exportHistory(this.host());
    this.assertAvailable();
    return Agent.createFrom(this.context, { ...this.getProfile(), sessionID: newSessionID() }, this, undefined, history, [this], 'fork');
  }
  async herb(other: Agent): Promise<Agent> {
    this.assertAvailable(); this.context[contextControl].assertAvailable(other);
    const mother = this.host();
    const finishUsage = beginAuxiliaryUsageSettlement(this.adaptor, mother);
    const ledger: Usage[] = [];
    let target = mother;
    const capture = (result: PromiseSettledResult<ContextSummary>): string | undefined => {
      if (result.status === 'fulfilled') { ledger.push(...result.value.usage); return result.value.summary; }
      if (result.reason instanceof AuxiliaryCallError) ledger.push(...result.reason.usage);
      return undefined;
    };
    try {
      const summarize = (source: HostAgent): Promise<ContextSummary> => {
        try { return this.adaptor.summarizeContext(source); } catch (error) { return Promise.reject(error); }
      };
      const summaries = await Promise.allSettled([summarize(mother), summarize(other.host())]);
      const own = capture(summaries[0]!); const another = capture(summaries[1]!);
      const errors = summaries.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Context summarization failed');
      this.assertAvailable(); this.context[contextControl].assertAvailable(other);
      let merged: ContextSummary;
      try { merged = await this.adaptor.mergeContextSummaries(mother, own!, another!); }
      catch (error) { if (error instanceof AuxiliaryCallError) ledger.push(...error.usage); throw error; }
      ledger.push(...merged.usage);
      this.assertAvailable(); this.context[contextControl].assertAvailable(other);
      const child = await Agent.createFrom(this.context, { ...this.getProfile(), sessionID: newSessionID() }, this,
        trustedSystemMessage('合并上下文', merged.summary), undefined, [this, other], 'herb');
      target = child.host();
      return child;
    } finally {
      try { settleAuxiliaryUsage(this.adaptor, target, ledger); }
      finally { finishUsage(); }
    }
  }
  kill(agent: Agent): Promise<void> { return this.killWithInitiator(agent, 'parent'); }
  private killWithInitiator(agent: Agent, initiator: TerminationInitiator): Promise<void> {
    this.assertLive();
    if (agent.parent !== this || !this.children.has(agent)) return Promise.reject(new Error('Target is not a direct child'));
    return agent.terminate('SIGTERM', initiator);
  }
  transfer(child: Agent, adopt: Agent): void {
    this.context[contextControl].assertAvailable(this);
    this.context[contextControl].assertAvailable(child);
    this.context[contextControl].assertAvailable(adopt);
    if (child.parent !== this || !this.children.has(child)) throw new Error('Target is not a direct child');
    for (let node: Agent | null = adopt; node; node = node.parent) if (node === child) throw new Error('Transfer would create a cycle');
    if (adopt === this) return;
    this.children.delete(child); adopt.children.add(child); child.parent = adopt;
    emitCore(this.context, { type: 'agent-parent', timestamp: Date.now(), agent: child, previous: this, parent: adopt });
  }
  joinGroup(group: Group): void { this.associateGroup(group); }
  private associateGroup(group: Group, scope?: ConstructionScope): void {
    this.assertAvailable(scope);
    assertConstructionAccess(group, scope);
    if (group[groupControl].context !== this.context || !group[groupControl].members().includes(this)) throw new Error('Invalid Group association');
    this.groups.add(group);
  }
  quitGroup(group: Group): void {
    assertNoPendingConstruction(this); assertNoPendingConstruction(group);
    group[groupControl].leave(this);
  }
  recvSignal(signal: Signal): Promise<void> {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return Promise.reject(new TypeError('Unknown signal'));
    return this.terminate(signal);
  }
  recvMessage(message: Message): void {
    this.assertAvailable();
    assertConstructionSource(message.source);
    const sender = sourceAgent(message.source);
    if (sender && sender[agentControl].context !== this.context) throw new Error('Message source belongs to another Context');
    if ('g' in message.source && message.source.g[groupControl].context !== this.context) throw new Error('Message Group belongs to another Context');
    const id = this.mailbox.put(message);
    if (id === null) return;
    this.assertAvailable();
    const meta = this.mailbox.peak(id)!;
    this.pending.set(id, meta);
    const wait = this.pendingWait;
    if (wait && !wait.evaluating) {
      if (Date.now() >= wait.deadline) this.timeoutWait(wait);
      else this.matchArrival(wait);
    }
    emitCore(this.context, { type: 'message-received', timestamp: Date.now(), agent: this, message: meta });
    if (this.closing) return;
    this.flushHigh(); this.flushNormal();
  }
  wait(condition: MailboxQuery, timeout: number): WaitResult {
    this.assertAvailable();
    if (typeof condition !== 'function' || !Number.isFinite(timeout) || timeout <= 0) throw new TypeError('Wait requires a condition and finite positive timeout');
    if (this.pendingWait) throw new Error('Agent already has a pending wait');
    const startedAt = Date.now();
    const record: WaitRecord = { condition, startedAt, timeout, deadline: deadlineAfter(timeout, startedAt), evaluating: true, registered: false, examined: new Set() };
    this.pendingWait = record;
    try {
      const match = this.findMatch(record);
      this.assertAvailable();
      if (this.pendingWait !== record) throw new Error('Wait was cancelled during matching');
      if (match) {
        this.clearWait(record); this.pending.delete(match.id);
        return { kind: 'matched', message: match };
      }
      record.evaluating = false; record.registered = true;
      record.startedAt = Date.now(); record.deadline = deadlineAfter(timeout, record.startedAt);
      record.timer = scheduleDeadline(record.deadline, () => this.timeoutWait(record));
      emitCore(this.context, { type: 'agent-wait', timestamp: record.startedAt, agent: this, waiting: { target: waitDescription(condition) ?? 'unknown', startedAt: record.startedAt, deadline: record.deadline } });
      this.temporaryRun = false; this.setStatus('waiting');
      return { kind: 'registered' };
    } catch (error) {
      if (this.pendingWait === record) this.clearWait(record);
      this.syncStatus();
      throw error;
    } finally { this.flushHigh(); }
  }
  private findMatch(record: WaitRecord): MessageMeta | null {
    for (;;) {
      const candidates = this.mailbox.query(message => !message.read && sourceAgent(message.source) !== null).filter(meta => !record.examined.has(meta.id));
      if (!candidates.length) return null;
      for (const candidate of candidates) {
        if (this.pendingWait !== record || this.closing) return null;
        record.examined.add(candidate.id);
        const message = this.mailbox[mailboxControl].inspect(candidate.id);
        if (!message || message.read) continue;
        const matched = record.condition(message);
        if (this.pendingWait !== record || this.closing) return null;
        const current = this.mailbox.peak(candidate.id);
        if (matched && current && !current.read) return current;
      }
    }
  }
  private matchArrival(record: WaitRecord): void {
    record.evaluating = true;
    try {
      const match = this.findMatch(record);
      if (this.pendingWait !== record || !match) return;
      if (Date.now() >= record.deadline) { this.timeoutWait(record); return; }
      this.clearWait(record);
      const deferred = [...this.pending.values()].filter(meta => meta.id !== match.id && meta.priority !== 'high' && !this.submitting.has(meta.id));
      this.submitEntries([match, ...deferred], match.priority === 'high' ? 'steer' : 'followup', match);
    } catch (error) {
      this.reportError(error);
    } finally { record.evaluating = false; this.flushHigh(); }
  }
  private clearWait(record: WaitRecord): void {
    if (this.pendingWait !== record) return;
    record.timer?.cancel(); this.pendingWait = undefined; this.temporaryRun = false;
    if (record.registered) emitCore(this.context, { type: 'agent-wait', timestamp: Date.now(), agent: this, waiting: null });
  }
  private timeoutWait(record: WaitRecord): void {
    if (this.pendingWait !== record || this.closing) return;
    this.clearWait(record);
    const message = markWaitCompletion(trustedSystemMessage('等待超时', `等待目标超时未返回。目标：${waitDescription(record.condition) ?? '此前指定的消息条件'}；发起时间：${record.startedAt}；超时时长：${record.timeout} 毫秒。`));
    message.priority = 'high';
    this.sendBatch({ entries: [], prompted: [], message, mode: 'steer' });
  }
  private flushHigh(): void {
    if (!this.published || this.closing || this.pendingWait?.evaluating) return;
    for (const entry of [...this.pending.values()]) {
      if (entry.priority === 'high' && !this.submitting.has(entry.id)) this.submitEntries([entry], 'steer');
    }
  }
  private flushNormal(): void {
    if (!this.published || this.closing || this.pendingWait || this.nativeRound) return;
    const entries = [...this.pending.values()].filter(meta => meta.priority !== 'high' && !this.submitting.has(meta.id));
    if (entries.length) this.submitEntries(entries, 'followup');
    else this.syncStatus();
  }
  private submitEntries(entries: MessageMeta[], mode: 'followup' | 'steer', match?: MessageMeta): void {
    if (this.closing || entries.length === 0) return;
    const included = entries.filter(meta => !this.submitting.has(meta.id));
    if (!included.length && !match) return;
    const prompts: MessageSource[] = [];
    const lines: string[] = [];
    let low = 0;
    for (const entry of included) {
      if (entry.priority === 'low' && entry.id !== match?.id) low++;
      else lines.push(`[${entry.id}] ${formatSource(entry.source)}：${entry.summary}`);
      if (this.mailbox.getSourcePriority(entry.source) === null && !this.prompted.some(source => sameSource(source, entry.source)) && !this.prompting.some(source => sameSource(source, entry.source)) && !prompts.some(source => sameSource(source, entry.source))) {
        const stored = this.mailbox[mailboxControl].inspect(entry.id);
        if (!stored || isTrustedSystemMessage(stored)) continue;
        prompts.push(snapshotSource(entry.source));
      }
    }
    if (low) lines.push(`不重要消息：${low} 条`);
    for (const source of prompts) lines.push(`请根据当前任务通过 setSourcePriority 评定 ${formatSource(source)} 的重要性。该来源的优先级后续可随时调整。`);
    const message = trustedSystemMessage(match ? '等待完成' : '收件箱通知', `${match ? '等待已匹配：\n' : ''}${lines.join('\n')}`);
    message.priority = mode === 'steer' ? 'high' : 'normal';
    if (match) markWaitCompletion(message);
    for (const entry of included) this.submitting.add(entry.id);
    this.prompting.push(...prompts);
    this.sendBatch({ entries: included, prompted: prompts, message, mode });
  }
  private sendBatch(batch: Batch): void {
    if (this.closing) return;
    const finishBatch = () => {
      for (const entry of batch.entries) this.submitting.delete(entry.id);
      this.prompting = this.prompting.filter(source => !batch.prompted.includes(source));
    };
    if (!this.nativeRound) this.roundError = false;
    this.nativeRound = true;
    if (this.pendingWait) this.temporaryRun = true;
    this.setStatus('running');
    if (this.closing) { finishBatch(); return; }
    let sent: Promise<void>;
    try { this.assertAvailable(); sent = this.adaptor.send(this.host(), batch.message, batch.mode, 'notification'); }
    catch (error) { sent = Promise.reject(error); }
    void sent.then(() => {
      for (const entry of batch.entries) this.pending.delete(entry.id);
      for (const source of batch.prompted) if (!this.prompted.some(existing => sameSource(existing, source))) this.prompted.push(source);
    }, error => {
      if (!this.closing) {
        try { this.nativeRound = this.adaptor.getStatus(this.host()) === 'running'; } catch {}
        this.syncStatus();
      }
      this.reportError(error);
    }).finally(finishBatch);
  }
  private onHostEvent(event: Readonly<HostEvent>): void {
    if (!this.published) { this.queuedEvents.push(event); return; }
    if (event.agent !== this.host()) return;
    if (event.type === 'error') { this.roundError = true; this.lastResult = 'failed'; }
    if (event.type === 'turn-end') { this.lastResult = event.reason === 'failed' || this.roundError ? 'failed' : event.reason === 'completed' ? 'completed' : 'stopped'; this.roundError = false; }
    if (event.type === 'status' && event.status === 'running' && !this.nativeRound) this.roundError = false;
    if (!this.closing) {
      if (event.type === 'status') {
        if (event.status === 'running') this.nativeRound = true;
        this.syncStatus();
      } else if (event.type === 'turn-end') {
        this.nativeRound = false; this.temporaryRun = false; this.syncStatus();
        queueMicrotask(() => this.flushNormal());
      }
    }
    emitCore(this.context, { type: 'host-event', timestamp: event.timestamp, agent: this, event });
  }
  private host(): HostAgent {
    if (this.binding.kind === 'initializing' || !this.binding.host) throw new Error('Agent HostAgent is not initialized');
    return this.binding.host;
  }
  private assertAvailable(scope?: ConstructionScope): void {
    assertConstructionAccess(this, scope); this.assertLive();
  }
  private assertLive(): void {
    if (this.closing || !this.published || !this.context[contextControl].has(this) || this.binding.kind !== 'bound') throw new Error('Agent is not available');
  }
  private syncStatus(): void {
    if (this.closing) return;
    this.setStatus(this.pendingWait && !this.temporaryRun ? 'waiting' : this.nativeRound ? 'running' : 'idle');
  }
  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (this.published) emitCore(this.context, { type: 'agent-status', timestamp: Date.now(), agent: this, status });
  }
  private reportError(error: unknown): void {
    if (!this.published) return;
    this.roundError = true; this.lastResult = 'failed';
    const event: HostEvent = { agent: this.host(), timestamp: Date.now(), type: 'error', message: error instanceof Error ? error.message : String(error) };
    emitCore(this.context, { type: 'host-event', timestamp: event.timestamp, agent: this, event });
  }
  private terminationOutcome(): AgentOutcome {
    if (this.lastResult === 'failed' || this.roundError || this.lastAssignmentResult === 'failed') return 'failed';
    if (this.lastResult === 'completed' || this.lastAssignmentResult === 'completed') return 'completed';
    return 'stopped';
  }
  private terminate(signal: Signal, initiator: 'user' | 'parent' | 'context' | 'self' = 'user', propagated = false): Promise<void> {
    if (signal === 'SIGKILL') this.strongestSignal = signal;
    if (this.closePromise) {
      if (this.binding.kind === 'bound') void this.adaptor.releaseAgent(this.binding.host, this.strongestSignal === 'SIGKILL' ? 'immediate' : 'after-turn').catch(() => {});
      for (const child of [...this.children]) void child.terminate(this.strongestSignal, initiator, true).catch(() => {});
      return this.closePromise;
    }
    let resolve!: () => void; let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.context[contextControl].trackRelease(this, this.closePromise);
    this.closing = true; this.status = 'terminated';
    const terminatedAt = Date.now();
    const outcome = initiator === 'user' || initiator === 'parent' || initiator === 'context' ? 'stopped' : this.terminationOutcome();
    recordAgentTermination(this.context, this, this.parent ? getAgentInstanceId(this.parent) : null, outcome, terminatedAt);
    this.mailbox[mailboxControl].stopReceiving();
    if (this.pendingWait) this.clearWait(this.pendingWait);
    this.context[contextControl].markReleasing(this);
    this.context[contextControl].markReleasing(this.mailbox);
    this.pending.clear();
    for (const group of [...this.groups]) group[groupControl].leave(this);
    const children = [...this.children];
    const childClosures = children.map(child => child.terminate(this.strongestSignal, initiator, true));
    this.context[contextControl].terminated(this);
    if (this.published) emitCore(this.context, { type: 'agent-terminated', timestamp: terminatedAt, agent: this, signal: this.strongestSignal, outcome, initiator, mode: this.strongestSignal === 'SIGKILL' ? 'immediate' : 'after-turn', propagated });
    const finishOwn = async () => {
      if (this.binding.kind === 'bound') {
        const binding = this.binding;
        await this.adaptor.releaseAgent(binding.host, this.strongestSignal === 'SIGKILL' ? 'immediate' : 'after-turn');
        binding.unsubscribe?.();
        this.binding = { kind: 'released', host: binding.host };
      } else this.binding = { kind: 'released' };
      const mailboxClose = this.mailbox[mailboxControl].close();
      this.context[contextControl].trackRelease(this.mailbox, mailboxClose);
      await mailboxClose;
    };
    void Promise.allSettled([finishOwn(), ...childClosures]).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) { reject(new AggregateError(errors.map(result => result.reason), 'Agent release failed')); return; }
      this.parent?.children.delete(this); this.parent = null; this.children.clear();
      this.context[contextControl].rollback(this, this.mailbox);
      resolve();
    });
    return this.closePromise;
  }
}
