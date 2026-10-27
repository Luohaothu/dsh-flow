import type { Agent } from './agent.js';
import type { Context } from './context.js';
import { contextControl, groupControl, type GroupControl } from './internals.js';
import { newGroupID, snapshotMessage } from './message.js';
import { emitCore } from './observation.js';
import type { GroupID, Message, Timestamp } from './types.js';

export class Group {
  private readonly id = newGroupID();
  private readonly members: Set<Agent>;
  private blackboard: Message[] = [];
  private closed = false;
  private closePromise?: Promise<void>;
  private lastTimestamp = -Infinity;
  readonly [groupControl]: GroupControl;

  constructor(private readonly context: Context, members: Agent[]) {
    const self = this;
    this[groupControl] = {
      get context() { return self.context; },
      get closed() { return self.closed; },
      members: () => [...this.members],
      leave: agent => this.leave(agent),
      close: () => this.close(),
    };
    context[contextControl].assertOpen();
    const initial = members.slice();
    for (const member of initial) context[contextControl].assertAvailable(member);
    this.members = new Set(initial);
    for (const member of this.members) member.joinGroup(this);
    context.register(this);
    emitCore(context, { type: 'group-created', timestamp: Date.now(), group: this, members: [...this.members] });
  }
  getID(): GroupID { return this.id; }
  postMessage(source: Agent, message: Message): void {
    this.assertMember(source);
    const recipients = [...this.members].filter(member => member !== source);
    const outgoing = snapshotMessage({ ...message, source: { agent: source, g: this } });
    const failures: unknown[] = [];
    for (const member of recipients) {
      try { member.recvMessage(outgoing); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Group message delivery failed');
  }
  postToBlackboard(source: Agent, message: Message): void {
    this.assertMember(source);
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    const saved = snapshotMessage({ ...message, source: { agent: source, g: this }, timestamp, read: false, read_timestamp: null });
    this.assertMember(source);
    this.lastTimestamp = timestamp; this.blackboard.push(saved);
    emitCore(this.context, { type: 'group-blackboard', timestamp, group: this, message: snapshotMessage(saved) });
  }
  readBlackboard(after?: Timestamp): Message[] {
    this.assertOpen();
    return this.blackboard.filter(message => after === undefined || message.timestamp > after).map(snapshotMessage);
  }
  hasNewMsgOnboard(after: Timestamp): boolean { this.assertOpen(); return this.blackboard.some(message => message.timestamp > after); }
  private assertOpen(): void { if (this.closed || !this.context.has(this)) throw new Error('Group is dissolved or releasing'); }
  private assertMember(source: Agent): void {
    this.assertOpen();
    if (!this.members.has(source)) throw new Error('Sender is not a Group member');
  }
  private leave(agent: Agent): void {
    if (!this.members.delete(agent)) return;
    agent.quitGroup(this);
    emitCore(this.context, { type: 'group-member-left', timestamp: Date.now(), group: this, agent });
  }
  private close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = Promise.resolve(); this.closed = true;
    for (const member of [...this.members]) this.leave(member);
    this.blackboard = [];
    emitCore(this.context, { type: 'group-released', timestamp: Date.now(), group: this });
    return this.closePromise;
  }
}
