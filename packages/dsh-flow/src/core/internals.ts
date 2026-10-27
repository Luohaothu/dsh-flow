import type { ConstructionScope } from './construction.js';
import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Group } from './group.js';
import type { Mailbox } from './mailbox.js';
import type { AgentStatus, HostAgent, MessageMeta, Signal } from './types.js';

export const createOwned: unique symbol = Symbol('Flow owned construction');
export const agentControl: unique symbol = Symbol('Flow Agent lifecycle');
export const mailboxControl: unique symbol = Symbol('Flow Mailbox lifecycle');
export const groupControl: unique symbol = Symbol('Flow Group lifecycle');
export const contextControl: unique symbol = Symbol('Flow Context publication');
export interface AgentControl {
  readonly context: Context;
  readonly host: HostAgent;
  readonly status: AgentStatus;
  assertAvailable(scope?: ConstructionScope): void;
  join(group: Group, scope?: ConstructionScope): void;
  leave(group: Group): void;
  release(signal: Signal): Promise<void>;
}
export interface MailboxControl {
  readonly context: Context | undefined;
  readonly closed: boolean;
  bind(context: Context): void;
  stopReceiving(): void;
  close(): Promise<void>;
  inspect(id: import('./types.js').MessageID): import('./types.js').Message | null;
  onRead(listener: (message: MessageMeta) => void): void;
}
export interface GroupControl {
  readonly context: Context;
  readonly closed: boolean;
  close(): Promise<void>;
  leave(agent: Agent): void;
  members(): Agent[];
}
export interface ContextControl {
  assertOpen(): void;
  assertAvailable(agent: Agent, scope?: ConstructionScope): void;
  has(object: Agent | Group | Mailbox): boolean;
  registered(object: Agent | Group | Mailbox): boolean;
  register(object: Agent | Group | Mailbox, scope?: ConstructionScope): void;
  beginCreation(): () => void;
  publish(agent: Agent, mailbox: Mailbox, sources: readonly Agent[], attach: () => void, scope?: ConstructionScope): void;
  rollback(agent: Agent, mailbox: Mailbox): void;
  terminated(agent: Agent): void;
  trackRelease(object: Agent | Group | Mailbox, completion: Promise<void>): void;
  markReleasing(object: Agent | Group | Mailbox): void;
}
