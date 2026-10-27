import type { Context } from './context.js';
import { mailboxControl, type MailboxControl } from './internals.js';
import { isTrustedSystemMessage, newMessageID, sameSource, snapshotMessage, snapshotMeta, snapshotSource } from './message.js';
import type { MailboxQuery, Message, MessageFilter, MessageID, MessageMeta, MessagePriority, MessageSource } from './types.js';

type Entry = { id: MessageID; message: Message & { priority: MessagePriority }; order: number };
export class Mailbox {
  private records: Entry[] = [];
  private ratings: { source: MessageSource; priority: MessagePriority }[] = [];
  private filters: MessageFilter[] = [];
  private closed = false;
  private receiving = true;
  private owner?: Context;
  private order = 0;
  private closePromise?: Promise<void>;
  private readListener: ((message: MessageMeta) => void) | undefined;

  readonly [mailboxControl]: MailboxControl;

  constructor() {
    const self = this;
    this[mailboxControl] = {
    get context() { return self.owner; },
    get closed() { return self.closed; },
    bind: context => {
      this.assertOpen();
      if (this.owner && this.owner !== context) throw new Error('Mailbox belongs to another Context');
      this.owner = context;
    },
    stopReceiving: () => { this.receiving = false; },
    close: () => {
      if (this.closePromise) return this.closePromise;
      this.closed = true; this.records = []; this.ratings = []; this.filters = [];
      this.readListener = undefined;
      return this.closePromise = Promise.resolve();
    },
    inspect: id => { this.assertOpen(); const entry = this.records.find(entry => entry.id === id); return entry ? snapshotMessage(entry.message) : null; },
    onRead: listener => { this.readListener = listener; },
    };
  }
  private assertOpen(): void { if (this.closed) throw new Error('Mailbox is released'); }
  private assertReceiving(): void {
    this.assertOpen();
    if (!this.receiving) throw new Error('Mailbox is not receiving messages');
  }
  put(message: Message): MessageID | null {
    this.assertReceiving();
    const saved = snapshotMessage(message);
    const trusted = isTrustedSystemMessage(saved);
    saved.priority = trusted ? 'normal' : this.getSourcePriority(saved.source) ?? 'normal';
    saved.read = false; saved.read_timestamp = null;
    const filters = this.filters.slice();
    if (!trusted) {
      for (const filter of filters) {
        const drop = filter(snapshotMessage(saved));
        this.assertReceiving();
        if (drop) return null;
      }
    }
    this.assertReceiving();
    const entry: Entry = { id: newMessageID(), message: saved as Entry['message'], order: this.order++ };
    this.records.push(entry);
    this.records.sort((a, b) => a.message.timestamp - b.message.timestamp || a.order - b.order);
    return entry.id;
  }
  peak(id: MessageID): MessageMeta | null {
    this.assertOpen(); const entry = this.records.find(entry => entry.id === id);
    return entry ? this.meta(entry) : null;
  }
  get(id: MessageID): Message | null {
    this.assertOpen(); const entry = this.records.find(entry => entry.id === id);
    return entry ? this.read([entry])[0]! : null;
  }
  getLastUnread(): Message | null {
    this.assertOpen(); const entry = this.records.findLast(entry => !entry.message.read);
    return entry ? this.read([entry])[0]! : null;
  }
  getUnread(): IterableIterator<Message> {
    this.assertOpen(); const range = this.records.filter(entry => !entry.message.read); const mailbox = this;
    return (function* () {
      for (const entry of range) {
        mailbox.assertOpen();
        if (!entry.message.read) yield mailbox.read([entry])[0]!;
      }
    })();
  }
  query(query?: MailboxQuery, mode?: 'peak'): MessageMeta[];
  query(query: MailboxQuery | undefined, mode: 'get'): Message[];
  query(query: MailboxQuery | undefined, mode: 'peak' | 'get'): MessageMeta[] | Message[];
  query(query?: MailboxQuery, mode: 'peak' | 'get' = 'peak'): MessageMeta[] | Message[] {
    this.assertOpen();
    if (mode !== 'peak' && mode !== 'get') throw new TypeError('Unknown Mailbox query mode');
    const selected: Entry[] = [];
    for (const entry of this.records.slice()) {
      const accepted = !query || query(snapshotMessage(entry.message));
      this.assertOpen();
      if (accepted) selected.push(entry);
    }
    return mode === 'get' ? this.read(selected) : selected.map(entry => this.meta(entry));
  }
  count(query?: MailboxQuery): number { return this.query(query).length; }
  setFilters(rules: MessageFilter[]): void {
    this.assertOpen();
    if (!rules.every(rule => typeof rule === 'function')) throw new TypeError('Filters must be functions');
    this.filters = rules.slice();
  }
  getFilters(): MessageFilter[] { this.assertOpen(); return this.filters.slice(); }
  getSourcePriority(source: MessageSource): MessagePriority | null {
    this.assertOpen(); return this.ratings.find(rating => sameSource(rating.source, source))?.priority ?? null;
  }
  setSourcePriority(source: MessageSource, priority: MessagePriority): void {
    this.assertOpen();
    if (!['high', 'normal', 'low'].includes(priority)) throw new TypeError('Unknown source priority');
    const saved = snapshotSource(source);
    const rating = this.ratings.find(rating => sameSource(rating.source, saved));
    if (rating) rating.priority = priority; else this.ratings.push({ source: saved, priority });
  }
  private meta(entry: Entry): MessageMeta { return snapshotMeta({ ...entry.message, id: entry.id }); }
  private read(entries: Entry[]): Message[] {
    const changed: Entry[] = [];
    const now = Date.now();
    for (const entry of entries) if (!entry.message.read) {
      entry.message.read = true; entry.message.read_timestamp = now; changed.push(entry);
    }
    const results = entries.map(entry => snapshotMessage(entry.message));
    const changedMeta = changed.map(entry => this.meta(entry));
    for (const meta of changedMeta) { try { this.readListener?.(meta); } catch {} }
    return results;
  }
}
