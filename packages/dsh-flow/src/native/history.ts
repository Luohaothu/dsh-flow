import type { Context } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream';
import { assistantStreamChunks } from '@deepseek-ai/dsh-llm';
import { SessionLogOffset, SessionSeq, isAppendSurfaceEvent, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { assertSessionHeadersCompatible } from '@deepseek-ai/dsh-session-query';
import type { SessionObservation } from '@deepseek-ai/dsh-session-query';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionAssistantStreamAttempt, SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SessionAttachmentValue, SessionHistoryRecord, SessionPage, SessionProjectionBaseline, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '../core/agent.js';
import { getAgentAppearance, getAgentInstanceId } from '../core/observation.js';
import type { FlowNativeAttachmentInput, FlowNativeFollowInput, FlowNativeFrame, FlowNativePageInput, FlowNativeTarget } from './protocol.js';

interface SourceRecord {
  format: 'dsh-flow-native-source'; version: 1;
  target: FlowNativeTarget; header: SessionHeader; inheritedEventCount: number;
  phase: 'live' | 'closing' | 'complete' | 'failed' | 'abandoned';
  published: boolean;
  endSeq?: number; reason?: string;
}
interface ActiveSource { record: SourceRecord; flow: Agent; native: NativeAgent; epoch: string; tail: Promise<void>; stream: AssistantBaseline }
type Item = { kind: 'event'; event: SessionEvent } | { kind: 'assistant'; frame: SessionAssistantStreamFrame; ordinal: number } | { kind: 'state' };
const unavailable = (reason: string, phase = 'unavailable'): never => { throw new RemoteError('flow/native-unavailable', reason, { reason, phase }); };
const keyOf = (target: FlowNativeTarget): string => JSON.stringify([target.runId, target.instanceId]);
const cursorOf = (native: NativeAgent): number => native.session.seq - 1;

class AssistantBaseline {
  revision = 0;
  active?: { attempt: Omit<SessionAssistantStreamAttempt, 'stream'>; stream: AssistantStreamAccumulator };
  accept(frame: AssistantStreamFrame, cursor: number): void {
    if (frame.type === 'start' && frame.revision === 1) this.revision = 0;
    if (frame.revision !== this.revision + 1) { delete this.active; this.revision = frame.revision; return; }
    this.revision = frame.revision;
    if (frame.type === 'start') this.active = { attempt: { attemptId: frame.attemptId, startedAfterSeq: cursor < 0 ? -1 : SessionSeq(cursor), turn: frame.turn, step: frame.step, nextIndex: 0 }, stream: new AssistantStreamAccumulator() };
    else if (frame.type === 'end') delete this.active;
    else if (!this.active || this.active.attempt.attemptId !== frame.attemptId || this.active.attempt.nextIndex !== frame.index) delete this.active;
    else { this.active.stream.push({ time: frame.time, chunk: frame.chunk }); this.active.attempt = { ...this.active.attempt, nextIndex: frame.index + 1 }; }
  }
  snapshot(): SessionAssistantStreamBaseline {
    return { revision: this.revision, ...(this.active ? { activeAttempt: { ...this.active.attempt, stream: JSON.parse(JSON.stringify(this.active.stream.snapshot())) } } : {}) };
  }
}
function assistantFrame(frame: AssistantStreamFrame, cursor: number): SessionAssistantStreamFrame {
  return frame.type === 'start' ? { ...frame, startedAfterSeq: cursor < 0 ? -1 : SessionSeq(cursor) } : JSON.parse(JSON.stringify(frame));
}
function records(events: readonly SessionEvent[]): SessionHistoryRecord[] { return events.map(event => ({ type: 'event', event: JSON.parse(JSON.stringify(event)) })); }
function window(events: readonly SessionEvent[], request: { maxMessages?: number; beforeSeq?: number; turnWindow?: { minMessages: number; minTurns: number } }, throughSeq: number): SessionPage {
  const max = request.maxMessages ?? 50;
  if (!Number.isSafeInteger(max) || max <= 0 || !Number.isSafeInteger(throughSeq) || throughSeq < -1 || throughSeq >= events.length
    || (request.beforeSeq !== undefined && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || request.beforeSeq > throughSeq + 1))) throw new RemoteError('gateway/bad-request', 'Invalid native history page window', {});
  const turns = request.turnWindow;
  if (turns && (!Number.isSafeInteger(turns.minMessages) || turns.minMessages < 0 || turns.minMessages > max || !Number.isSafeInteger(turns.minTurns) || turns.minTurns < 1)) throw new RemoteError('gateway/bad-request', 'Invalid native turn window', {});
  const end = Math.min(throughSeq + 1, request.beforeSeq ?? throughSeq + 1);
  let count = 0, crossed = 0, cut = 0;
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index]!;
    if (turns && event.type === 'turn/start' && ++crossed >= turns.minTurns && count >= turns.minMessages) { cut = index; break; }
    if ((event.type !== 'user/message' && event.type !== 'assistant/message') || !isAppendSurfaceEvent(event)) continue;
    if (++count >= max) { cut = Math.min(event.seq, ...(event.sourceEventSeqs ?? [])); break; }
  }
  return { records: records(events.slice(cut, end)), hasMore: cut > 0 };
}
function imageReference(events: readonly SessionEvent[], id: string): ImageAttachmentRef | undefined {
  const blocks = (value: unknown): ImageAttachmentRef | undefined => {
    if (!Array.isArray(value)) return;
    for (const block of value) if (block?.type === 'image' && block.attachment?.attachmentId === id) return block.attachment as ImageAttachmentRef;
  };
  for (const event of events) {
    let result: ImageAttachmentRef | undefined;
    switch (event.type) {
      case 'user/message': case 'tool/ptc-dispatch': result = blocks(event.data.content); break;
      case 'system/message': case 'developer/message': case 'tool/result': result = blocks(event.data.message.content); break;
      case 'agent/inbox/spliced': for (const message of event.data.inserted) { result = blocks(message.content); if (result) break; } break;
      case 'compaction/summary': result = blocks(event.data.summary) ?? blocks(event.data.rawOutput); break;
      case 'assistant/message': result = blocks(event.data.message.content); if (result) break;
      case 'assistant/attempt': for (const chunk of assistantStreamChunks(event.data.stream, 'block-end')) { result = blocks([chunk.block]); if (result) break; } break;
    }
    if (result) return result;
  }
}

export class NativeHistory {
  private readonly active = new Map<string, ActiveSource>();
  private readonly barriers = new Map<string, Promise<void>>();
  private readonly followers = new Set<{ notify(): void; close(): void }>();
  private readonly processEpoch = randomUUID();
  private readonly controller = new AbortController();
  private readonly disposers: (() => void)[] = [];
  private closed = false;
  private leases = 0;
  constructor(private readonly host: Context, private readonly directory: string) {
    this.disposers.push(host.on('agent/assistant-stream', ({ agent, frame }) => {
      for (const source of this.active.values()) if (source.native === agent && source.record.phase !== 'complete' && source.record.phase !== 'abandoned' && source.record.phase !== 'failed') source.stream.accept(frame, cursorOf(agent));
    }, { global: true }));
  }
  diagnostics(): { followers: number; leases: number; sources: number } { return { followers: this.followers.size, leases: this.leases, sources: this.active.size }; }
  async beforeReuse(sessionId: string): Promise<void> {
    await this.barriers.get(sessionId);
    for (const source of this.active.values()) if (source.record.target.sessionId === sessionId && source.record.phase !== 'complete') unavailable('Native Session still belongs to an unfinished instance', source.record.phase);
  }
  async bind(runId: string, flow: Agent, native: NativeAgent): Promise<void> {
    this.assertOpen();
    const target: FlowNativeTarget = { runId, instanceId: getAgentInstanceId(flow), sessionId: native.session.id };
    const record: SourceRecord = { format: 'dsh-flow-native-source', version: 1, target, header: structuredClone(native.session.header), inheritedEventCount: native.session.inheritedEventCount, phase: 'live', published: false };
    const source: ActiveSource = { record, flow, native, epoch: `${this.processEpoch}/${target.instanceId}`, tail: Promise.resolve(), stream: new AssistantBaseline() };
    if (this.active.has(keyOf(target))) throw new Error('Native instance is already registered');
    this.active.set(keyOf(target), source);
    try { await this.persist(source); } catch (error) { this.active.delete(keyOf(target)); throw error; }
  }
  closing(runId: string, flow: Agent): void { const source = this.active.get(JSON.stringify([runId, getAgentInstanceId(flow)])); if (source?.record.phase === 'live') source.record.phase = 'closing'; }
  async complete(runId: string, flow: Agent): Promise<void> {
    const source = this.requireActive(runId, flow);
    if (source.record.phase === 'abandoned' || source.record.phase === 'failed') return;
    if (!getAgentAppearance(flow)) { await this.rollback(runId, flow); return; }
    const completed: SourceRecord = { ...source.record, published: true, phase: 'complete', endSeq: cursorOf(source.native), header: structuredClone(source.native.session.header), inheritedEventCount: source.native.session.inheritedEventCount };
    const barrier = this.persist(source, completed);
    this.barriers.set(source.record.target.sessionId, barrier);
    await barrier;
    if (!['abandoned', 'failed'].includes(source.record.phase)) {
      source.record = completed;
      this.active.delete(keyOf(completed.target));
    }
    this.wake();
  }
  fail(runId: string, flow: Agent, phase: 'failed' | 'abandoned', reason: string): void {
    const source = this.active.get(JSON.stringify([runId, getAgentInstanceId(flow)])); if (!source) return;
    source.record = { ...source.record, phase, reason }; delete source.record.endSeq;
    const barrier = this.persist(source); this.barriers.set(source.record.target.sessionId, barrier); void barrier.catch(() => {}); this.wake();
  }
  async rollback(runId: string, flow: Agent): Promise<void> {
    const key = JSON.stringify([runId, getAgentInstanceId(flow)]), source = this.active.get(key);
    if (!source) return;
    this.active.delete(key); await source.tail.catch(() => {}); await rm(this.path(source.record.target), { force: true });
  }
  private wake(): void { for (const follower of this.followers) follower.notify(); }
  private requireActive(runId: string, flow: Agent): ActiveSource { const source = this.active.get(JSON.stringify([runId, getAgentInstanceId(flow)])); if (!source) throw new Error('Native Flow source is not registered'); return source; }
  private path(target: FlowNativeTarget): string { return join(this.directory, `${createHash('sha256').update(keyOf(target)).digest('hex')}.json`); }
  private persist(source: ActiveSource, record = source.record): Promise<void> {
    const content = JSON.stringify(record);
    const operation = source.tail.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const path = this.path(source.record.target), temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    });
    source.tail = operation; return operation;
  }
  private async source(target: FlowNativeTarget, epoch?: string): Promise<{ record: SourceRecord; active?: ActiveSource; epoch: string }> {
    this.assertOpen();
    if (!target || !target.runId || !target.instanceId || !target.sessionId) unavailable('Native target requires Run, instance and Session identities');
    const active = this.active.get(keyOf(target));
    let record: SourceRecord;
    if (active) {
      await active.tail; record = active.record;
      const appearance = getAgentAppearance(active.flow);
      if (appearance?.id !== target.instanceId || String(appearance.profile.sessionID) !== String(target.sessionId)) unavailable('Native instance has not been published by its Run');
    }
    else {
      try { record = JSON.parse(await readFile(this.path(target), 'utf8')) as SourceRecord; }
      catch { return unavailable('No trusted native instance source'); }
    }
    if (!record || !record.target || record.format !== 'dsh-flow-native-source' || record.version !== 1 || keyOf(record.target) !== keyOf(target) || record.target.sessionId !== target.sessionId || record.header?.id !== target.sessionId
      || !Number.isSafeInteger(record.inheritedEventCount) || record.inheritedEventCount < 0) unavailable('Native target does not match its trusted source');
    if (record.phase === 'abandoned' || record.phase === 'failed') unavailable(record.reason ?? 'Native cleanup has no trusted final cut', record.phase);
    if (!active && record.phase !== 'complete') unavailable('Native instance has no durable final cut', record.phase);
    if (!active && record.published !== true) unavailable('Native instance has no trusted publication record', record.phase);
    if (record.phase === 'complete' && (!Number.isSafeInteger(record.endSeq) || record.endSeq! < -1)) unavailable('Native instance has no trustworthy end sequence', record.phase);
    const currentEpoch = active?.epoch ?? `${this.processEpoch}/${record.target.instanceId}`;
    if (epoch !== undefined && epoch !== currentEpoch) throw new RemoteError('flow/native-epoch', 'Native source generation changed', { epoch: currentEpoch });
    this.assertOpen();
    return { record, ...(active ? { active } : {}), epoch: currentEpoch };
  }
  private async observe(record: SourceRecord, signal: AbortSignal): Promise<SessionObservation> {
    const observation = await this.host.sessionQuery.observeSession(record.target.sessionId, { signal, projectionMode: 'none' });
    try { assertSessionHeadersCompatible(record.header, observation.header); if (record.inheritedEventCount !== observation.inheritedEventCount) unavailable('Native inherited prefix differs from instance source'); }
    catch (error) { observation[Symbol.dispose](); throw error; }
    this.leases++; return observation;
  }
  private release(observation: SessionObservation): void { observation[Symbol.dispose](); this.leases--; }
  private prefix(record: SourceRecord, observation: SessionObservation): readonly SessionEvent[] {
    if (record.phase === 'failed' || record.phase === 'abandoned') return unavailable(record.reason ?? 'No trusted final cut', record.phase);
    const end = record.phase === 'complete' ? record.endSeq! : observation.cursor;
    if (end > observation.cursor) return unavailable('Native durable log is shorter than the trusted instance cut', record.phase);
    const events = observation.events.slice(0, end + 1);
    if (events.some((event, index) => event.seq !== index)) return unavailable('Native log is not a contiguous prefix', record.phase);
    return events;
  }
  private projections(record: SourceRecord, events: readonly SessionEvent[]): SessionProjectionBaseline {
    return JSON.parse(JSON.stringify(this.host.sessionProjections.restore({}, events, SessionLogOffset(0), record.header, SessionLogOffset(record.inheritedEventCount)).snapshot));
  }
  private summary(record: SourceRecord, events: readonly SessionEvent[]): SessionSummary {
    const live = this.active.get(keyOf(record.target));
    const available = !!live && record.phase !== 'complete' && this.host.agents.get(record.target.sessionId) === live.native;
    return { sessionId: record.target.sessionId, agentAvailable: available, running: available && live.native.status === 'running', blank: !events.some(event => event.type === 'turn/start'), updatedAt: events.at(-1)?.time ?? record.header.createdAt,
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }), ...(record.header.origin === undefined ? {} : { origin: record.header.origin }), ...(record.header.parentSession === undefined ? {} : { parentSessionId: record.header.parentSession }) };
  }
  async page(input: FlowNativePageInput, signal: AbortSignal): Promise<SessionPage> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const source = await this.source(input.target, input.epoch), observation = await this.observe(source.record, signal);
    try { signal.throwIfAborted(); return window(this.prefix(source.active?.record ?? source.record, observation), input.request, input.request.throughSeq); } finally { this.release(observation); }
  }
  async attachment(input: FlowNativeAttachmentInput, signal: AbortSignal): Promise<SessionAttachmentValue> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const source = await this.source(input.target, input.epoch), observation = await this.observe(source.record, signal);
    try {
      signal.throwIfAborted(); const ref = imageReference(this.prefix(source.active?.record ?? source.record, observation), input.attachmentId);
      if (!ref) throw new RemoteError('session/attachment-invalid', 'Image is not referenced by this instance history.', { reason: 'ATTACHMENT_NOT_REFERENCED' });
      const stored = await this.host.attachments.readImage(ref); signal.throwIfAborted();
      return { attachment: stored.ref, data: Buffer.from(stored.data).toString('base64') };
    } finally { this.release(observation); }
  }
  async *follow(input: FlowNativeFollowInput, signal: AbortSignal): AsyncIterable<FlowNativeFrame> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const source = await this.source(input.target);
    this.assertOpen();
    const buffer: Item[] = []; let wake: (() => void) | undefined, closed = false, ordinal = 0;
    let observation: SessionObservation | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const disposers: (() => void)[] = [];
    const close = () => {
      closed = true; notify(); this.followers.delete(follower);
      if (observation) { this.release(observation); observation = undefined; }
      for (const dispose of disposers.splice(0).reverse()) dispose();
      buffer.length = 0;
    };
    const follower = { notify, close };
    const currentNative = source.active?.native;
    const push = (item: Item) => { buffer.push(item); notify(); };
    this.followers.add(follower); signal.addEventListener('abort', close, { once: true });
    try {
      if (source.record.phase !== 'complete') {
        disposers.push(this.host.on('session/event', (session, event) => { if (session === currentNative?.session) push({ kind: 'event', event }); }, { global: true }));
        disposers.push(this.host.on('agent/status', ({ agent }) => { if (agent === currentNative) push({ kind: 'state' }); }, { global: true }));
        if (input.request.assistantStream) disposers.push(this.host.on('agent/assistant-stream', ({ agent, frame }) => { if (agent === currentNative) push({ kind: 'assistant', frame: assistantFrame(frame, cursorOf(agent)), ordinal: ++ordinal }); }, { global: true }));
        disposers.push(this.host.sessionProjections.onChanged(session => { if (session === currentNative?.session) push({ kind: 'state' }); }));
      }
      observation = await this.observe(source.record, signal); signal.throwIfAborted();
      const openingRecord = source.active?.record ?? source.record;
      const events = this.prefix(openingRecord, observation), cursor = events.length - 1;
      const projections = this.projections(openingRecord, events);
      const assistantStream = input.request.assistantStream ? openingRecord.phase === 'complete' ? { revision: 0 } : source.active?.stream.snapshot() ?? { revision: 0 } : undefined;
      const ordinalCut = ordinal;
      const page = window(events, input.request, cursor);
      yield { epoch: source.epoch, kind: 'journal', frame: { type: 'snapshot', header: structuredClone(openingRecord.header), cursor, ...page, projections, ...(assistantStream ? { assistantStream } : {}) } };
      if (closed || this.closed) return;
      yield { epoch: source.epoch, kind: 'state', summary: this.summary(openingRecord, events), projections };
      if (observation) { this.release(observation); observation = undefined; }
      if (openingRecord.phase === 'complete') return;
      let next = cursor + 1;
      while (!closed && !signal.aborted && !this.closed) {
        const record = source.active?.record ?? source.record;
        if (record.phase === 'abandoned' || record.phase === 'failed') unavailable(record.reason ?? 'Native final cut unavailable', record.phase);
        const item = buffer.shift();
        if (item?.kind === 'event') {
          if (record.endSeq !== undefined && item.event.seq > record.endSeq) continue;
          if (item.event.seq < next) continue;
          if (item.event.seq !== next) unavailable(`Native event stream skipped sequence ${next}`, record.phase);
          next++;
          yield { epoch: source.epoch, kind: 'journal', frame: records([item.event])[0]! };
        } else if (item?.kind === 'assistant') {
          if (item.ordinal > ordinalCut) yield { epoch: source.epoch, kind: 'journal', frame: { type: 'assistant-stream', frame: item.frame } };
        } else if (item?.kind === 'state') {
          if (currentNative && record.phase !== 'complete') {
            const snapshot = currentNative.session.snapshotEvents();
            yield { epoch: source.epoch, kind: 'state', summary: this.summary(record, snapshot), projections: this.projections(record, snapshot) };
          }
        } else if (record.phase === 'complete') {
          if (next <= record.endSeq!) unavailable('Native final cut is missing streamed events', record.phase);
          if (currentNative) {
            const prefix = currentNative.session.snapshotEvents().slice(0, record.endSeq! + 1);
            yield { epoch: source.epoch, kind: 'state', summary: this.summary(record, prefix), projections: this.projections(record, prefix) };
          }
          break;
        } else if (!item) await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      close(); signal.removeEventListener('abort', close);
    }
  }
  private assertOpen(): void { if (this.closed) unavailable('Flow Native history is closed', 'closed'); }
  async dispose(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.controller.abort(new Error('Flow Native history closed'));
    for (const follower of this.followers) follower.close();
    for (const dispose of this.disposers) dispose();
    try { await Promise.all([...this.active.values()].map(source => source.tail)); }
    finally { this.active.clear(); this.barriers.clear(); }
  }
}
