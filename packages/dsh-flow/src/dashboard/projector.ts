import type { JsonValue } from '../assignments/types.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Agent } from '../core/agent.js';
import { getAgentAppearance, getAgentInstanceId, observeCore, hasCoreObservations, type CoreObservation } from '../core/observation.js';
import { isAgentSource, isGroupSource } from '../core/message.js';
import type { MessageSource, Usage } from '../core/types.js';
import { runServiceControl, type RunReadView } from '../run/internal.js';
import type { RunService } from '../run/run.js';
import { EventJournal } from './events.js';
import { PROTOCOL_VERSION, type AgentCard, type GroupView, type MessageSourceView, type OperationView, type PriceTable, type RegistryEvent, type RegistrySnapshot, type RunEvent, type RunInfo, type RunSnapshot, type UsageView } from './protocol.js';

type Projection = { navigation: Map<string, string>; view: RunReadView; info: RunInfo; nodes: Map<string, AgentCard>; agents: Map<string, Agent>; groups: Map<string, GroupView>; operations: Map<string, OperationView>; journal: EventJournal<RunEvent>; unsubscribe: () => void; assignments: Map<string, RunReadView['assignments'][number]> };
const copy = <T>(value: T): T => structuredClone(value);
export class DashboardProjector {
  private readonly projections = new Map<string, Projection>();
  private readonly journal: EventJournal<RegistryEvent>;
  private readonly unsubscribe: () => void;
  private readonly prices: PriceTable;
  private readonly unkeyedUsageIds = new WeakMap<Usage, string>();
  private readonly directory: string;
  private disposed = false;
  private readonly epoch: string;
  private readonly resetDisposers: (() => void)[] = [];
  private readonly resetListeners = new Set<(runId?: string) => void>();
  constructor(service: RunService, options: { directory: string; prices?: PriceTable }) {
    this.epoch = service.epoch;
    this.directory = options.directory; this.prices = copy(options.prices ?? []);
    this.journal = new EventJournal({ directory: options.directory, name: 'registry', epoch: service.epoch });
    this.resetDisposers.push(this.journal.observeReset(() => { for (const listener of this.resetListeners) listener(); }));
    this.unsubscribe = service[runServiceControl].observe(view => this.update(view));
    try { for (const view of service[runServiceControl].enumerate()) this.update(view); }
    catch (error) { this.dispose(); throw error; }
  }
  registry(): RegistrySnapshot {
    this.assertOpen();
    const snapshot: RegistrySnapshot = copy({ version: PROTOCOL_VERSION, epoch: this.epoch, seq: this.journal.seq, runs: [...this.projections.values()].map(p => p.info) });
    this.rebaseline(this.journal, snapshot);
    return { ...snapshot, seq: this.journal.seq, ...(this.journal.degraded ? { degraded: true } : {}) };
  }
  snapshot(runId: string): RunSnapshot {
    this.assertOpen(); const p = this.require(runId);
    const snapshot: RunSnapshot = copy({ version: PROTOCOL_VERSION, seq: p.journal.seq, run: p.info, nodes: [...p.nodes.values()], groups: [...p.groups.values()], assignments: [...p.assignments.values()], prices: this.prices, operations: [...p.operations.values()] });
    this.rebaseline(p.journal, snapshot);
    return { ...snapshot, seq: p.journal.seq, ...(p.journal.degraded ? { degraded: true } : {}) };
  }
  subscribeRegistry(after: number, epoch: string, listener: (event: RegistryEvent) => void): () => void { this.assertOpen(); return this.journal.subscribe(after, epoch, event => listener(copy(event))); }
  subscribeRun(runId: string, after: number, epoch: string, listener: (event: RunEvent) => void): () => void { this.assertOpen(); return this.require(runId).journal.subscribe(after, epoch, event => listener(copy(event))); }
  operation(runId: string, operation: OperationView): void { const p = this.require(runId); p.operations.set(operation.id, copy(operation)); this.publish(p, { type: 'operation-result', operation: copy(operation) }); }
  observeReset(listener: (runId?: string) => void): () => void { this.resetListeners.add(listener); return () => { this.resetListeners.delete(listener); }; }
  lookupAgent(runId: string, instanceId: string): Agent { const agent = this.require(runId).agents.get(instanceId); if (!agent) throw new Error('Unknown Agent instance'); return agent; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribe(); for (const p of this.projections.values()) p.unsubscribe(); for (const dispose of this.resetDisposers) dispose(); this.resetDisposers.length = 0; this.resetListeners.clear(); }
  private assertOpen(): void { if (this.disposed) throw new Error('Dashboard projector is disposed'); }
  private require(id: string): Projection { const p = this.projections.get(id); if (!p) throw new Error('Unknown run'); return p; }
  private rebaseline<T extends { seq: number }>(journal: EventJournal<T>, snapshot: RegistrySnapshot | RunSnapshot): void { if (journal.degraded) { try { journal.rebaseline(snapshot); } catch { /* The snapshot reports the actual degraded state. */ } } }
  private append<T extends { seq: number }>(journal: EventJournal<T>, make: (seq: number) => T): void { try { journal.append(make); } catch { /* Projection remains authoritative while the journal is degraded. */ } }
  private info(view: RunReadView, p?: Projection): RunInfo {
    const rootId = view.root ? getAgentInstanceId(view.root) : undefined;
    const root = rootId ? p?.nodes.get(rootId) : undefined;
    return { id: view.run.id, epoch: view.run.epoch, name: root?.name ?? '团队运行', entry: copy(view.run.origin), rootSummary: root ? { id: root.id, name: root.name, sessionID: root.sessionID } : null, status: view.run.status, startedAt: view.run.startedAt, ...(view.run.endedAt === undefined ? {} : { endedAt: view.run.endedAt }), pendingAssignmentCount: view.run.pendingAssignments, ...(view.run.error ? { error: view.run.error } : {}), ...(view.run.storageError ? { storageError: view.run.storageError } : {}) };
  }
  private update(view: RunReadView): void {
    if (this.disposed) return;
    let p = this.projections.get(view.run.id);
    if (p && p.view.revision >= view.revision) return;
    const appeared = !p;
    if (!p) {
      if (hasCoreObservations(view.context)) throw new Error('Dashboard projector must attach before Context initialization');
      p = { navigation: new Map(), view, info: this.info(view), nodes: new Map(), agents: new Map(), groups: new Map(), operations: new Map(), assignments: new Map(), journal: new EventJournal({ directory: join(this.directory, 'runs'), name: view.run.id, epoch: view.run.epoch, tolerateInitializationFailure: true }), unsubscribe: () => {} };
      this.projections.set(view.run.id, p);
      this.resetDisposers.push(p.journal.observeReset(() => { for (const listener of this.resetListeners) listener(view.run.id); }));
      const projection = p;
      p.unsubscribe = observeCore(view.context, event => this.observe(projection, event));

    }
    p.view = view;
    if (view.root) this.ensure(p, view.root);
    for (const assignment of view.assignments) {
      if (JSON.stringify(p.assignments.get(assignment.id)) === JSON.stringify(assignment)) continue;
      p.assignments.set(assignment.id, copy(assignment));
      const recipient = p.nodes.get(assignment.recipientInstanceId);
      if (recipient) {
        if (!recipient.assignmentIds.includes(assignment.id)) recipient.assignmentIds.push(assignment.id);
        recipient.task = assignment.spec.name;
        if (assignment.schemaFailures) this.marker(recipient, `schema:${assignment.id}`, 'schema-failure', Date.now(), `${assignment.schemaFailures} 次结果校验失败`);
        this.node(p, recipient);
      }
      this.publish(p, { type: 'assignment-changed', assignment: copy(assignment) });
    }
    const previous = p.info; p.info = this.info(view, p);
    const ended = p.info.status === 'stopped' || p.info.status === 'failed';
    if (appeared || JSON.stringify(previous) !== JSON.stringify(p.info)) {
      this.append<RegistryEvent>(this.journal, seq => ({ epoch: p.info.epoch, seq, type: appeared ? 'run-appeared' : ended ? 'run-ended' : 'run-changed', run: copy(p.info) }));
      this.publish(p, { type: ended ? 'run-ended' : 'run-changed', run: copy(p.info) });
    }
  }
  private ensure(p: Projection, agent: Agent): AgentCard | undefined {
    const appearance = getAgentAppearance(agent); if (!appearance) return;
    const existing = p.nodes.get(appearance.id); if (existing) return existing;
    const node: AgentCard = { id: appearance.id, parentId: appearance.parentId, sessionID: appearance.profile.sessionID, name: appearance.profile.name, role: appearance.profile.role, model: copy(appearance.profile.model), permission: appearance.profile.permission, task: '', status: 'idle', source: { kind: appearance.origin, sourceIds: [...appearance.sourceIds], ...(appearance.resumeSessionID ? { resumeSessionID: appearance.resumeSessionID } : {}) }, waiting: null, outcome: null, termination: null, cleanup: null, markers: [], usage: [], createdAt: appearance.createdAt, terminatedAt: null, messages: [], blackboardWrites: [], assignmentIds: [], groups: [], outputs: [], errors: [] };
    p.nodes.set(node.id, node); p.agents.set(node.id, agent);
    for (const assignment of p.assignments.values()) if (assignment.recipientInstanceId === node.id) { node.assignmentIds.push(assignment.id); node.task = assignment.spec.name; }
    this.node(p, node, 'node-appeared'); return node;
  }
  private source(p: Projection, source: MessageSource): MessageSourceView {
    if (isAgentSource(source) || isGroupSource(source)) {
      const agent = isAgentSource(source) ? source : source.agent;
      const node = this.ensure(p, agent); const appearance = getAgentAppearance(agent);
      if (!node || !appearance) throw new Error('Unpublished message source');
      const actor = { agentId: node.id, sessionID: appearance.profile.sessionID, name: appearance.profile.name };
      return isGroupSource(source) ? { kind: 'group', ...actor, groupId: source.g.getID() } : { kind: 'agent', ...actor };
    }
    return { kind: source.kind };
  }
  private group(p: Projection, id: string): GroupView { let group = p.groups.get(id); if (!group) { group = { id, members: [], dissolved: false, blackboard: [] }; p.groups.set(id, group); } return group; }
  private observe(p: Projection, event: Readonly<CoreObservation>): void {
    if (this.disposed) return;
    const node = 'agent' in event ? this.ensure(p, event.agent) : undefined;
    if ('agent' in event && !node) return;
    if (event.type === 'group-created') {
      const group = this.group(p, event.group.getID());
      if (group.dissolved) return;
      group.members = event.members.flatMap(agent => { const member = this.ensure(p, agent); if (!member) return []; if (!member.groups.includes(group.id)) member.groups.push(group.id); this.node(p, member); return [member.id]; });
      this.publish(p, { type: 'group-changed', group: copy(group) }); return;
    }
    if (event.type === 'group-member-left') {
      const group = this.group(p, event.group.getID()); group.members = group.members.filter(id => id !== node!.id);
      this.publish(p, { type: 'group-changed', group: copy(group) }); return;
    }
    if (event.type === 'group-released') { const group = this.group(p, event.group.getID()); group.dissolved = true; group.members = []; this.publish(p, { type: 'group-changed', group: copy(group) }); return; }
    if (event.type === 'group-blackboard') {
      const group = this.group(p, event.group.getID()); const message = event.message;
      group.blackboard.push({ id: `${group.id}:${message.timestamp}`, source: this.source(p, message.source), timestamp: message.timestamp, summary: message.summary, payload: wireData(message.payload) });
      this.publish(p, { type: 'group-changed', group: copy(group) }); return;
    }
    if (event.type === 'context-release') return;
    if (!node) return;
    let kind: Extract<RunEvent, { node: AgentCard }>['type'] = 'node-changed';
    switch (event.type) {
      case 'agent-created': return;
      case 'agent-status': if (node.status !== 'terminated') node.status = event.status; break;
      case 'agent-parent': if (node.status !== 'terminated') { this.ensure(p, event.parent); node.parentId = getAgentInstanceId(event.parent); } break;
      case 'agent-wait': if (node.status !== 'terminated') node.waiting = copy(event.waiting); break;
      case 'agent-terminated':
        if (node.terminatedAt !== null) return;
        node.status = 'terminated'; node.outcome = event.outcome; node.terminatedAt = event.timestamp; node.waiting = null; node.blackboardWrites = [];
        node.termination = { signal: event.signal, initiator: event.initiator, mode: event.mode, propagated: event.propagated }; kind = 'node-terminated'; break;
      case 'host-cleanup':
        node.cleanup = { phase: event.phase, timestamp: event.timestamp, ...(event.reason === undefined ? {} : { reason: event.reason }), ...(event.deadline === undefined ? {} : { deadline: event.deadline }), ...(event.persistenceError === undefined ? {} : { persistenceError: event.persistenceError }) };
        if (event.phase === 'abandoned' || event.persistenceError) this.marker(node, `cleanup:${event.timestamp}:${event.phase}`, event.phase === 'abandoned' ? 'cleanup-abandoned' : 'persistence-error', event.timestamp, event.persistenceError ?? event.reason ?? event.phase);
        kind = 'node-cleanup'; break;
      case 'message-received': case 'message-read': {
        const message = event.message; const entry = { id: message.id, source: this.source(p, message.source), recipientId: node.id, timestamp: message.timestamp, summary: message.summary, priority: message.priority, read: message.read, readTimestamp: message.read_timestamp };
        const at = node.messages.findIndex(value => value.id === entry.id); if (at < 0) node.messages.push(entry); else node.messages[at] = entry;
        node.messages.sort((a, b) => b.timestamp - a.timestamp); kind = event.type; break;
      }
      case 'blackboard-write':
        if (event.active && node.status !== 'terminated') node.blackboardWrites.push({ id: event.id, groupId: event.group.getID(), startedAt: event.timestamp });
        else node.blackboardWrites = node.blackboardWrites.filter(write => write.id !== event.id);
        kind = 'blackboard-write'; break;
      case 'host-event': {
        const host = event.event;
        if (host.type === 'output') node.outputs.push({ timestamp: host.timestamp, text: host.text });
        if (host.type === 'error') { node.errors.push({ timestamp: host.timestamp, message: host.message }); this.marker(node, `error:${host.timestamp}:${node.errors.length}`, 'error', host.timestamp, host.message); }
        if (host.type === 'auto-reject') this.marker(node, `auto-reject:${host.timestamp}:${node.markers.length}`, 'auto-reject', host.timestamp, host.message);
        if (host.type === 'turn-end') this.marker(node, `turn:${host.timestamp}`, `turn-${host.reason}`, host.timestamp, host.reason);
        if (host.type === 'usage') { const usage = this.usage(host.usage); const at = node.usage.findIndex(item => item.callId === usage.callId); if (at < 0) node.usage.push(usage); else node.usage[at] = usage; kind = 'node-usage'; }
        break;
      }
    }
    this.node(p, node, kind);
  }
  private usage(usage: Usage): UsageView {
    const price = this.prices.find(item => item.model.provider === usage.model.provider && item.model.id === usage.model.id);
    let amount: number | null = null;
    if (price && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      const cached = usage.cacheReadTokens ?? 0; const written = usage.cacheWriteTokens ?? 0;
      if ((!cached || price.cacheRead !== undefined) && (!written || price.cacheWrite !== undefined)) amount = ((usage.inputTokens - cached - written) * price.input + usage.outputTokens * price.output + cached * (price.cacheRead ?? 0) + written * (price.cacheWrite ?? 0)) / 1_000_000;
    }
    let callId = usage.callId ?? this.unkeyedUsageIds.get(usage);
    if (!callId) { callId = `unkeyed:${randomUUID()}`; this.unkeyedUsageIds.set(usage, callId); }
    return { ...copy(usage), callId, amount, currency: amount === null ? null : price!.currency };
  }
  private marker(node: AgentCard, id: string, kind: string, timestamp: number, message: string): void { if (!node.markers.some(marker => marker.id === id)) node.markers.push({ id, kind, timestamp, message }); }
  private node(p: Projection, node: AgentCard, type: Extract<RunEvent, { node: AgentCard }>['type'] = 'node-changed'): void {
    this.publish(p, { type, node: copy(node) });
    const fingerprint = JSON.stringify([node.id, node.sessionID, node.name, node.model.provider, node.model.id, node.status, node.outcome,
      node.waiting, node.cleanup?.phase, node.cleanup?.reason, node.markers.length]);
    if (p.navigation.get(node.id) === fingerprint) return;
    p.navigation.set(node.id, fingerprint);
    this.append<RegistryEvent>(this.journal, seq => ({ epoch: p.info.epoch, seq, type: 'run-changed', run: copy(p.info) }));
  }
  private publish(p: Projection, payload: Omit<Extract<RunEvent, { node: AgentCard }>, 'seq' | 'runId' | 'timestamp'> | Omit<Extract<RunEvent, { group: GroupView }>, 'seq' | 'runId' | 'timestamp'> | Omit<Extract<RunEvent, { assignment: unknown }>, 'seq' | 'runId' | 'timestamp'> | Omit<Extract<RunEvent, { operation: OperationView }>, 'seq' | 'runId' | 'timestamp'> | Omit<Extract<RunEvent, { run: RunInfo }>, 'seq' | 'runId' | 'timestamp'>): void { this.append(p.journal, seq => ({ runId: p.info.id, seq, timestamp: Date.now(), ...payload })); }
}

function wireData(value: unknown): JsonValue {
  const seen = new WeakMap<object, string>();
  const visit = (item: unknown, path: string): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : { $type: 'number', value: String(item) };
    if (typeof item === 'undefined') return { $type: 'undefined' };
    if (typeof item === 'bigint') return { $type: 'bigint', value: String(item) };
    if (typeof item !== 'object') throw new TypeError('Unsupported display data');
    const prior = seen.get(item); if (prior !== undefined) return { $ref: prior }; seen.set(item, path);
    if (item instanceof Date) return { $type: 'date', value: Number.isFinite(item.getTime()) ? item.toISOString() : 'Invalid Date' };
    if (item instanceof Map) return { $type: 'map', entries: [...item.entries()].map(([key, entry], i) => [visit(key, `${path}/entries/${i}/0`), visit(entry, `${path}/entries/${i}/1`)]) };
    if (item instanceof Set) return { $type: 'set', values: [...item].map((entry, i) => visit(entry, `${path}/values/${i}`)) };
    if (item instanceof ArrayBuffer) return { $type: 'bytes', encoding: 'base64', value: Buffer.from(item).toString('base64') };
    if (ArrayBuffer.isView(item)) return { $type: item.constructor.name, encoding: 'base64', value: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') };
    if (Array.isArray(item)) return item.map((entry, i) => visit(entry, `${path}/${i}`));
    const record: Record<string, JsonValue> = Object.create(null);
    for (const [key, entry] of Object.entries(item)) record[key] = visit(entry, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    return record;
  };
  return visit(value, '#');
}
