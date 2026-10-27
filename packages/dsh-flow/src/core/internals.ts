import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Group } from './group.js';
import type { Mailbox } from './mailbox.js';
import type { HostAgent, MessageMeta, Signal } from './types.js';

export const agentControl: unique symbol = Symbol('Flow Agent lifecycle');
export const mailboxControl: unique symbol = Symbol('Flow Mailbox lifecycle');
export const groupControl: unique symbol = Symbol('Flow Group lifecycle');
export const contextControl: unique symbol = Symbol('Flow Context publication');
export interface AgentControl {
  readonly context: Context;
  readonly host: HostAgent;
  assertAvailable(): void;
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
  assertAvailable(agent: Agent): void;
  beginCreation(): () => void;
  publish(agent: Agent, mailbox: Mailbox, sources: readonly Agent[], attach: () => void): void;
  rollback(agent: Agent, mailbox: Mailbox): void;
  terminated(agent: Agent): void;
  trackRelease(agent: Agent, completion: Promise<void>): void;
  markReleasing(object: Agent | Group | Mailbox): void;
}
