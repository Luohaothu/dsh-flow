import { randomUUID } from 'node:crypto';
import { snapshotData } from './snapshot-data.js';
import type { Agent, AgentInGroup, GroupID, MailboxQuery, Message, MessageID, MessageMeta, MessageSource, SessionID, System, User } from './types.js';

export const SYSTEM: System = Object.freeze({ kind: 'system' });
export const USER: User = Object.freeze({ kind: 'user' });
const trusted = new WeakSet<object>();
const completions = new WeakSet<object>();
const waitDescriptions = new WeakMap<MailboxQuery, string>();
function id(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A business ID must be nonempty');
  return value;
}
export const sessionID = (value: string): SessionID => id(value) as SessionID;
export const groupID = (value: string): GroupID => id(value) as GroupID;
export const messageID = (value: string): MessageID => id(value) as MessageID;
export const newSessionID = (): SessionID => sessionID(randomUUID());
export const newGroupID = (): GroupID => groupID(randomUUID());
export const newMessageID = (): MessageID => messageID(randomUUID());
export function isAgentSource(source: MessageSource): source is Agent {
  return typeof source === 'object' && source !== null && 'getProfile' in source && typeof source.getProfile === 'function';
}
export function isGroupSource(source: MessageSource): source is AgentInGroup {
  return typeof source === 'object' && source !== null && 'agent' in source && 'g' in source;
}
export function sourceAgent(source: MessageSource): Agent | null { return isAgentSource(source) ? source : isGroupSource(source) ? source.agent : null; }
export function snapshotSource(source: MessageSource): MessageSource {
  if (isAgentSource(source)) return source;
  if (isGroupSource(source)) return { agent: source.agent, g: source.g };
  if (source?.kind === 'system') return { kind: 'system' };
  if (source?.kind === 'user') return { kind: 'user' };
  throw new TypeError('Unknown message source');
}
export function sameSource(a: MessageSource, b: MessageSource): boolean {
  if (isAgentSource(a) || isAgentSource(b)) return a === b;
  if (isGroupSource(a) || isGroupSource(b)) return isGroupSource(a) && isGroupSource(b) && a.agent === b.agent && a.g === b.g;
  return a.kind === b.kind;
}
export function snapshotMessage(message: Message): Message {
  if (typeof message.summary !== 'string' || [...message.summary].length > 50) throw new TypeError('Message summary must contain at most 50 characters');
  if (!Number.isFinite(message.timestamp)) throw new TypeError('Message timestamp must be finite');
  const result: Message = {
    source: snapshotSource(message.source), timestamp: message.timestamp,
    ...(message.priority === undefined ? {} : { priority: message.priority }),
    read: message.read, read_timestamp: message.read_timestamp, summary: message.summary,
    payload: snapshotData(message.payload),
  };
  if (isTrustedSystemMessage(message)) trusted.add(result);
  if (completions.has(message)) completions.add(result);
  return result;
}
export function snapshotMeta(message: MessageMeta): MessageMeta {
  return { id: message.id, source: snapshotSource(message.source), timestamp: message.timestamp, priority: message.priority,
    read: message.read, read_timestamp: message.read_timestamp, summary: message.summary };
}
export function trustedSystemMessage(summary: string, payload: unknown): Message {
  const result = snapshotMessage({ source: SYSTEM, timestamp: Date.now(), read: false, read_timestamp: null, summary, payload });
  trusted.add(result);
  return result;
}
export const isTrustedSystemMessage = (message: Message): boolean => trusted.has(message) && 'kind' in message.source && message.source.kind === 'system';
export function markWaitCompletion<T extends Message>(message: T): T { completions.add(message); return message; }
export const isWaitCompletion = (message: Message): boolean => completions.has(message);
export function describeWait<T extends MailboxQuery>(query: T, description: string): T { waitDescriptions.set(query, description); return query; }
export const waitDescription = (query: MailboxQuery): string | undefined => waitDescriptions.get(query);
export function serializeSource(source: MessageSource) {
  if (isAgentSource(source)) return { kind: 'agent' as const, sessionID: source.getProfile().sessionID, name: source.getProfile().name };
  if (isGroupSource(source)) return { kind: 'group' as const, sessionID: source.agent.getProfile().sessionID, name: source.agent.getProfile().name, groupID: source.g.getID() };
  return { kind: source.kind };
}
export function serializeMessage(message: Message) { return { ...snapshotMessage(message), source: serializeSource(message.source) }; }
export function serializeMeta(message: MessageMeta) { return { ...snapshotMeta(message), source: serializeSource(message.source) }; }
export function formatSource(source: MessageSource): string {
  const value = serializeSource(source);
  if (value.kind === 'agent') return `${value.name} (${value.sessionID})`;
  if (value.kind === 'group') return `${value.name} (${value.sessionID}) / 群 ${value.groupID}`;
  return value.kind === 'system' ? 'System' : 'User';
}
