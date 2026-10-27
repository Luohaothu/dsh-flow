import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class JournalCursorError extends Error {
  constructor(message = 'Event cursor requires a new snapshot') { super(message); this.name = 'JournalCursorError'; }
}
export type JournalStage = 'write' | 'file-sync' | 'directory-sync';
interface Entry<T> { event: T; bytes: number }
interface Subscriber<T> { listener: (event: T) => void; replaying: boolean; pending: T[]; pendingBytes: number }
interface SegmentHeader { format: 'dsh-flow-events'; version: 1; name: string; epoch: string; seq: number; previousSegment: string | null; ancestors: string[]; state?: unknown }
export interface JournalReplay { epoch: string; seq: number; state: unknown; events: { seq: number; [key: string]: unknown }[]; segments: string[] }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validPart(value: string): boolean { return /^[a-zA-Z0-9_-]+$/.test(value); }
/** A fresh reader follows the segment chain; a recovery state supersedes uncertain earlier tails. */
export function readJournal(directory: string, name: string, epoch: string): JournalReplay {
  if (!validPart(name) || !validPart(epoch)) throw new TypeError('Invalid journal identity');
  const prefix = `${name}.${epoch}`;
  const segments = new Map<string, { header: SegmentHeader; lines: string[] }>();
  for (const file of readdirSync(directory)) {
    if (!(file === `${prefix}.jsonl` || (file.startsWith(`${prefix}.`) && file.endsWith('.jsonl')))) continue;
    const lines = readFileSync(join(directory, file), 'utf8').split('\n');
    let header: unknown;
    try { header = JSON.parse(lines[0]!); } catch { continue; }
    if (!object(header) || header.format !== 'dsh-flow-events' || header.version !== 1 || header.name !== name || header.epoch !== epoch || !Number.isSafeInteger(header.seq) || Number(header.seq) < 0 || !(header.previousSegment === null || typeof header.previousSegment === 'string') || !Array.isArray(header.ancestors) || !header.ancestors.every(item => typeof item === 'string' && basename(item) === item)) continue;
    const decoded: SegmentHeader = { format: 'dsh-flow-events', version: 1, name, epoch, seq: Number(header.seq), previousSegment: header.previousSegment, ancestors: header.ancestors, ...(Object.hasOwn(header, 'state') ? { state: header.state } : {}) };
    segments.set(file, { header: decoded, lines: lines.slice(1) });
  }
  const predecessors = new Set([...segments.values()].flatMap(segment => segment.header.ancestors));
  const heads = [...segments.keys()].filter(file => !predecessors.has(file));
  if (heads.length !== 1) throw new Error('Journal segment chain is unavailable or ambiguous');
  const head = segments.get(heads[0]!)!;
  const chain = [...head.header.ancestors, heads[0]!];
  if (new Set(chain).size !== chain.length) throw new Error('Cyclic journal segments');
  let seq = 0; let state: unknown; let events: JournalReplay['events'] = [];
  const lastBaseline = chain.findLastIndex(file => Object.hasOwn(segments.get(file)?.header ?? {}, 'state'));
  const start = Math.max(0, lastBaseline);
  for (const file of chain.slice(start)) {
    const segment = segments.get(file); if (!segment) throw new Error('Missing journal segment');
    if (Object.hasOwn(segment.header, 'state')) { state = structuredClone(segment.header.state); seq = segment.header.seq; events = []; }
    else if (segment.header.seq !== seq) throw new Error('Journal baseline cursor mismatch');
    for (const line of segment.lines) {
      if (!line) continue;
      const event: unknown = JSON.parse(line);
      if (!object(event) || event.seq !== seq + 1) throw new Error('Journal event cursor mismatch');
      const record: { seq: number; [key: string]: unknown } = { ...event, seq: seq + 1 }; events.push(record); seq++;
    }
  }
  return { epoch, seq, state, events, segments: chain };
}
/** Each stream owns a cursor; publication follows a durable append. */
export class EventJournal<T extends { seq: number }> {
  private sequence = 0;
  private floor = 0;
  private bytes = 0;
  private entries: Entry<T>[] = [];
  private subscribers = new Set<Subscriber<T>>();
  private resetListeners = new Set<() => void>();
  private failed = false;
  private dispatching = false;
  private readonly dispatchQueue: Entry<T>[] = [];
  private dispatchBytes = 0;
  private readonly maxBytes: number;
  private path: string;
  private ancestors: string[] = [];
  constructor(private readonly options: { directory: string; name: string; epoch: string; maxBytes?: number; tolerateInitializationFailure?: boolean; fault?: (stage: JournalStage) => void }) {
    if (!validPart(options.name) || !validPart(options.epoch)) throw new TypeError('Invalid journal identity');
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new TypeError('Invalid journal byte bound');
    this.path = join(options.directory, `${options.name}.${options.epoch}.jsonl`);
    try { this.createSegment(this.path, { format: 'dsh-flow-events', version: 1, name: options.name, epoch: options.epoch, seq: 0, previousSegment: null, ancestors: [] }); }
    catch (error) { this.degrade(); if (!options.tolerateInitializationFailure) throw error; }
  }
  get seq(): number { return this.sequence; }
  get degraded(): boolean { return this.failed; }
  observeReset(listener: () => void): () => void { this.resetListeners.add(listener); return () => { this.resetListeners.delete(listener); }; }
  append(make: (seq: number) => T): T {
    if (this.failed) throw new Error('Journal is degraded; establish a snapshot baseline');
    const next = this.sequence + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError('Journal cursor exhausted');
    const event = structuredClone(make(next));
    if (event.seq !== next) throw new TypeError('Event cursor mismatch');
    const payload = JSON.stringify(event) + '\n';
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND);
      this.options.fault?.('write'); writeFileSync(fd, payload, 'utf8');
      this.options.fault?.('file-sync'); fsyncSync(fd); closeSync(fd); fd = undefined;
    } catch (error) { this.degrade(); throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    this.sequence = next;
    const bytes = Buffer.byteLength(payload);
    this.entries.push({ event, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.entries.length) { const removed = this.entries.shift()!; this.bytes -= removed.bytes; this.floor = removed.event.seq; }
    this.dispatchQueue.push({ event, bytes }); this.dispatchBytes += bytes;
    if (this.dispatching && this.dispatchBytes > this.maxBytes) {
      this.dispatchQueue.length = 0; this.dispatchBytes = 0; this.subscribers.clear();
      for (const listener of this.resetListeners) listener();
    }
    if (!this.dispatching) {
      this.dispatching = true;
      try {
        while (this.dispatchQueue.length) {
          const entry = this.dispatchQueue.shift()!; this.dispatchBytes -= entry.bytes; const current = entry.event;
          for (const subscriber of [...this.subscribers]) {
            if (!this.subscribers.has(subscriber)) continue;
            if (subscriber.replaying) {
              subscriber.pendingBytes += Buffer.byteLength(JSON.stringify(current));
              if (subscriber.pendingBytes > this.maxBytes) {
                this.subscribers.delete(subscriber); subscriber.pending = []; subscriber.pendingBytes = 0;
                for (const listener of this.resetListeners) listener();
              }
              else subscriber.pending.push(current);
            } else this.deliver(subscriber, current);
          }
        }
      } finally { this.dispatching = false; }
    }
    return structuredClone(event);
  }
  subscribe(after: number, epoch: string, listener: (event: T) => void): () => void {
    if (this.failed || epoch !== this.options.epoch || !Number.isSafeInteger(after) || after < this.floor || after > this.sequence) throw new JournalCursorError();
    const subscriber: Subscriber<T> = { listener, replaying: true, pending: [], pendingBytes: 0 };
    const replay = this.entries.filter(entry => entry.event.seq > after).map(entry => entry.event);
    this.subscribers.add(subscriber);
    for (const event of replay) { if (!this.subscribers.has(subscriber)) break; this.deliver(subscriber, event); }
    while (subscriber.pending.length && this.subscribers.has(subscriber)) {
      const event = subscriber.pending.shift()!;
      subscriber.pendingBytes -= Buffer.byteLength(JSON.stringify(event));
      this.deliver(subscriber, event);
    }
    subscriber.replaying = false;
    return () => { this.subscribers.delete(subscriber); subscriber.pending = []; subscriber.pendingBytes = 0; };
  }
  /** Preserve all old bytes and start a new durable segment from the complete actual view. */
  rebaseline(state: unknown): void {
    if (!object(state) || state.seq !== this.sequence) throw new TypeError('Recovery baseline must contain the current full snapshot cursor');
    const nextPath = join(this.options.directory, `${this.options.name}.${this.options.epoch}.${randomUUID()}.jsonl`);
    const previousSegment = basename(this.path);
    this.ancestors.push(previousSegment);
    this.path = nextPath;
    try {
      this.createSegment(nextPath, { format: 'dsh-flow-events', version: 1, name: this.options.name, epoch: this.options.epoch, seq: this.sequence, previousSegment, ancestors: [...this.ancestors], state: structuredClone(state) }); this.floor = this.sequence; this.entries = []; this.bytes = 0; this.failed = false;
    } catch (error) { this.degrade(); throw error; }
  }
  private createSegment(path: string, header: SegmentHeader): void {
    let fd: number | undefined; let dir: number | undefined;
    try {
      mkdirSync(this.options.directory, { recursive: true }); fd = openSync(path, 'wx', 0o600);
      this.options.fault?.('write'); writeFileSync(fd, JSON.stringify(header) + '\n');
      this.options.fault?.('file-sync'); fsyncSync(fd); closeSync(fd); fd = undefined;
      dir = openSync(this.options.directory, 'r'); this.options.fault?.('directory-sync'); fsyncSync(dir);
    } finally { if (fd !== undefined) closeSync(fd); if (dir !== undefined) closeSync(dir); }
  }
  private degrade(): void {
    if (!this.failed) this.sequence++;
    this.failed = true; this.subscribers.clear();
    for (const listener of this.resetListeners) listener();
  }
  private deliver(subscriber: Subscriber<T>, event: T): void {
    try { subscriber.listener(structuredClone(event)); }
    catch { this.subscribers.delete(subscriber); }
  }
}
