import { randomUUID } from 'node:crypto';
import type { Agent } from './agent.js';
import type { Context } from './context.js';
import { agentControl, contextControl, createOwned, groupControl, type GroupControl } from './internals.js';
import { assertConstructionAccess, assertConstructionParticipant, assertNoPendingConstruction, assertConstructionScope, assertConstructionSource, ownConstructionResource, type ConstructionScope } from './construction.js';
import { newGroupID, snapshotMessage } from './message.js';
import { emitCore } from './observation.js';
import type { GroupID, Message, Timestamp } from './types.js';

export class Group {
  private id!: GroupID;
  private context!: Context;
  private members!: Set<Agent>;
  private blackboard!: Message[];
  private closed!: boolean;
  private closePromise: Promise<void> | undefined;
  private lastTimestamp!: number;
  readonly [groupControl]!: GroupControl;

  constructor(context: Context, members: Agent[]) { this.initialize(context, members); }
  static [createOwned](scope: ConstructionScope, members: Agent[]): Group {
    assertConstructionScope(scope);
    const group = Object.create(Group.prototype) as Group;
    group.initialize(scope.context, members, scope);
    return group;
  }
  private initialize(context: Context, members: Agent[], scope?: ConstructionScope): void {
    this.id = newGroupID(); this.context = context; this.members = new Set(members);
    this.blackboard = []; this.closed = false; this.closePromise = undefined; this.lastTimestamp = -Infinity;
    const self = this;
    Object.defineProperty(this, groupControl, { value: {
      get context() { return self.context; },
      get closed() { return self.closed; },
      members: () => [...this.members],
      leave: (agent: Agent) => this.leave(agent),
      close: () => this.close(),
    } satisfies GroupControl });
    if (scope) ownConstructionResource(scope, this, 'group');
    try {
      context[contextControl].assertOpen();
      for (const member of this.members) {
        if (scope) assertConstructionParticipant(scope, member);
        else context[contextControl].assertAvailable(member);
      }
      for (const member of this.members) {
        if (scope) member[agentControl].join(this, scope);
        else member.joinGroup(this);
      }
      context[contextControl].register(this, scope);
      emitCore(context, { type: 'group-created', timestamp: Date.now(), group: this, members: [...this.members] });
    } catch (error) {
      this.closed = true;
      for (const member of this.members) member[agentControl].leave(this);
      this.members.clear();
      throw error;
    }
  }
  getID(): GroupID { return this.id; }
  postMessage(source: Agent, message: Message): void {
    this.assertMember(source); assertConstructionSource(message.source);
    const recipients = [...this.members].filter(member => member !== source);
    const outgoing = snapshotMessage({ ...message, source: { agent: source, g: this } });
    const failures: unknown[] = [];
    for (const member of recipients) {
      try { this.assertMember(source); member.recvMessage(outgoing); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Group message delivery failed');
  }
  postToBlackboard(source: Agent, message: Message): void {
    this.assertMember(source); assertConstructionSource(message.source);
    const id = randomUUID();
    emitCore(this.context, { type: 'blackboard-write', timestamp: Date.now(), agent: source, group: this, id, active: true });
    try {
      this.assertMember(source);
      const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      const saved = snapshotMessage({ ...message, source: { agent: source, g: this }, timestamp, read: false, read_timestamp: null });
      this.assertMember(source);
      this.lastTimestamp = timestamp; this.blackboard.push(saved);
      emitCore(this.context, { type: 'group-blackboard', timestamp, group: this, message: snapshotMessage(saved) });
    } finally { emitCore(this.context, { type: 'blackboard-write', timestamp: Date.now(), agent: source, group: this, id, active: false }); }
  }
  readBlackboard(after?: Timestamp): Message[] {
    this.assertOpen();
    return this.blackboard.filter(message => after === undefined || message.timestamp > after).map(snapshotMessage);
  }
  hasNewMsgOnboard(after: Timestamp): boolean { this.assertOpen(); return this.blackboard.some(message => message.timestamp > after); }
  private assertOpen(): void { assertNoPendingConstruction(this); if (this.closed || !this.context.has(this)) throw new Error('Group is dissolved or releasing'); }
  private assertMember(source: Agent): void {
    this.assertOpen(); assertConstructionAccess(source);
    if (!this.members.has(source)) throw new Error('Sender is not a Group member');
  }
  private leave(agent: Agent): void {
    if (!this.members.delete(agent)) return;
    agent[agentControl].leave(this);
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
