/**
 * Communication graph: point-to-point messages, multicast, groups, blackboard
 * and subscriptions. Any agent inside one cluster may reach any other agent
 * across subtrees; the management tree and permissions are untouched by this.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values';

import { fail } from '../errors.ts';
import type { FlowAgentRole } from '../types.ts';
import type { BlackboardRecord, ClusterRecord, GroupRecord, SubscriptionRecord } from './model.ts';
import { AGENT_TERMINAL } from './protocol.ts';
import type { ClusterStore } from './store.ts';

export const COMMUNICATION_ACTIONS = ['send', 'multicast', 'group', 'publish', 'query', 'subscribe'] as const satisfies readonly string[];

const GROUP_OPERATIONS: ReadonlySet<string> = new Set(['create', 'join', 'leave', 'close']);
const SUBSCRIBE_OPERATIONS: ReadonlySet<string> = new Set(['add', 'remove']);

/**
 * The identity a communication action is attributed to. Unlike a turn-fenced
 * agent actor it needs no session: a fixture sender is a role on a node that has
 * no durable agent row, so `agent_id` may be null.
 */
export interface CommunicationActor {
  readonly cluster_id: string;
  readonly agent_id: string | null;
  readonly node_id: string | null;
  readonly role: FlowAgentRole;
}

/** One delivery expectation raised by a mutating communication action. */
export interface CommunicationNotice {
  readonly kind: 'message' | 'blackboard';
  readonly message_id?: string;
  readonly from?: string | null;
  readonly key?: string;
}

export interface CommunicationRecipient {
  readonly recipient: string;
  readonly delivery_seq: number | null;
}

export interface CommunicationSendResult {
  readonly message_id: string;
  readonly deduped: boolean;
  readonly recipients: CommunicationRecipient[];
}

export interface CommunicationGroupMembersResult {
  readonly group: GroupRecord | null;
  readonly members: string[];
}

export interface CommunicationGroupDedupedResult {
  readonly group: GroupRecord;
  readonly deduped: true;
}

export interface CommunicationPublishResult {
  readonly key: string;
  readonly revision: number;
}

export interface CommunicationBlackboardEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly revision: number;
  readonly updated_by?: string | null;
  readonly updated?: number;
}

export interface CommunicationQueryResult {
  readonly entries: CommunicationBlackboardEntry[];
  readonly cursor: number | null;
}

export interface CommunicationSubscriptionSnapshotEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly revision: number;
}

/** A bare subscription identity, as an `add` reports it back. */
export interface CommunicationSubscriptionRef {
  readonly id: string;
  readonly pattern: string;
  readonly cursor: number;
}

export interface CommunicationSubscriptionResult {
  readonly subscription: SubscriptionRecord | CommunicationSubscriptionRef;
  readonly snapshot?: CommunicationSubscriptionSnapshotEntry[];
}

/** Every shape a communication action can answer with. */
export type CommunicationResult =
  | CommunicationSendResult
  | CommunicationGroupMembersResult
  | CommunicationGroupDedupedResult
  | CommunicationPublishResult
  | CommunicationQueryResult
  | CommunicationSubscriptionResult;

export interface CommunicateOptions {
  readonly notify?: (recipient: string, notice: CommunicationNotice) => void;
}

/** Narrow a JSON-ish value that came off a wire or a row. */
function jsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) fail(`Invalid ${label}`);
  return value as JsonValue;
}

/** A JSON column: stored as text, but a decoded row is already a value. */
function storedJson(value: unknown, label: string): JsonValue {
  if (typeof value !== 'string') return jsonValue(value, label);
  return jsonValue(JSON.parse(value), label);
}

export function resolveRecipients(
  store: ClusterStore,
  clusterId: string,
  _actor: CommunicationActor,
  params: Record<string, unknown>,
): string[] {
  const targets: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id !== 'string' || !id) fail('Invalid recipient');
    if (!targets.includes(id)) targets.push(id);
  };
  if (params.agent !== undefined) push(params.agent);
  if (params.group !== undefined) {
    const name = typeof params.group === 'string' ? params.group : null;
    const group = name === null ? null : store.groupByName(clusterId, name) ?? store.getGroup(name);
    if (!group || group.cluster_id !== clusterId) fail(`Unknown group: ${String(params.group)}`, 404);
    for (const member of store.groupMembers(group.id)) push(member);
  }
  if (params.node !== undefined) {
    if (typeof params.node !== 'string') fail(`Unknown node: ${String(params.node)}`, 404);
    const node = store.getNode(params.node);
    if (!node || node.cluster_id !== clusterId) fail(`Unknown node: ${params.node}`, 404);
    for (const agent of store.listAgents(clusterId, { node_id: params.node })) push(agent.id);
  }
  if (!targets.length) fail('Message requires at least one recipient');
  if (targets.length > 64) fail('Message exceeds 64 recipients');
  for (const id of targets) {
    const agent = store.getAgent(id);
    if (!agent || agent.cluster_id !== clusterId) fail(`Unknown recipient: ${id}`, 404);
    if (AGENT_TERMINAL.has(agent.status)) fail(`Recipient ${id} is TERMINATED and accepts no new messages`, 409);
  }
  return targets;
}

function deliverable(
  store: ClusterStore,
  clusterId: string,
  actor: CommunicationActor,
  params: Record<string, unknown>,
): { recipients: string[]; content: JsonValue } {
  const recipients = resolveRecipients(store, clusterId, actor, params);
  const content = normalizeContent(params.content);
  return { recipients, content };
}

function normalizeContent(content: unknown): JsonValue {
  if (content === undefined || content === null) fail('Message requires content');
  if (typeof content === 'string') {
    if (!content.length || content.length > 32768) fail('Invalid message content');
    return { text: content };
  }
  if (typeof content === 'object' && !Array.isArray(content)) return jsonValue(content, 'message content');
  fail('Invalid message content');
}

// Atomicity is part of this module's interface, not a caller ordering rule.
// notify persists wake-up evidence in the same store transaction.
export function communicate(
  store: ClusterStore,
  cluster: ClusterRecord,
  actor: CommunicationActor,
  action: string,
  params: Record<string, unknown> = {},
  options: CommunicateOptions = {},
): CommunicationResult {
  return store.tx(() => applyCommunication(store, cluster, actor, action, params, options));
}

function applyCommunication(
  store: ClusterStore,
  cluster: ClusterRecord,
  actor: CommunicationActor,
  action: string,
  params: Record<string, unknown>,
  { notify }: CommunicateOptions,
): CommunicationResult {
  const clusterId = cluster.id;
  switch (action) {
    case 'send':
    case 'multicast': {
      const { recipients, content } = deliverable(store, clusterId, actor, params);
      const id = params.message_id ?? randomUUID();
      if (typeof id !== 'string' || !id || id.length > 256) fail('Invalid message_id');
      const kind = action === 'multicast' ? 'multicast' : 'direct';
      const existing = store.getMessage(id);
      if (existing && (existing.cluster_id !== clusterId
        || existing.from_agent !== (actor.agent_id ?? null)
        || existing.from_node !== (actor.node_id ?? null)
        || existing.kind !== kind
        || !isDeepStrictEqual(storedJson(existing.content, 'stored message content'), content))) {
        fail('message_id conflicts with an existing message', 409);
      }
      if (!existing) store.insertMessage({
        id, cluster_id: clusterId, from_agent: actor.agent_id, from_node: actor.node_id, kind, content,
      });
      // A retry may repair missing recipients, but cannot change the immutable
      // envelope. New and repaired deliveries share notification persistence.
      const delivered: CommunicationRecipient[] = [];
      for (const recipient of recipients) {
        if (store.deliveryFor(id, recipient)) continue;
        delivered.push({ recipient, delivery_seq: store.insertRecipient(id, recipient) });
        notify?.(recipient, { kind: 'message', message_id: id, from: actor.agent_id });
      }
      if (!existing) store.appendEvent(clusterId, 'message', { message_id: id, from: actor.agent_id, recipients, kind: action });
      return { message_id: id, deduped: !!existing, recipients: delivered };
    }

    case 'group': {
      const operation = params.operation;
      if (typeof operation !== 'string' || !GROUP_OPERATIONS.has(operation)) fail(`Unknown group operation: ${String(operation)}`);
      if (operation === 'create') {
        const name = params.name ?? params.id;
        if (typeof name !== 'string' || !name) fail('group create requires a name');
        const existing = store.groupByName(clusterId, name);
        if (existing) return { group: existing, deduped: true };
        const group = store.insertGroup({ id: randomUUID(), cluster_id: clusterId, name });
        if (!group) fail('Group not found', 404);
        const members = Array.isArray(params.members) ? params.members : [];
        for (const member of members) store.addGroupMember(group.id, requireMember(store, clusterId, member));
        if (actor.agent_id) store.addGroupMember(group.id, actor.agent_id);
        store.appendEvent(clusterId, 'group-created', { group_id: group.id, name, members: store.groupMembers(group.id) });
        return { group: store.getGroup(group.id), members: store.groupMembers(group.id) };
      }
      let group: GroupRecord | null;
      if (params.id) {
        group = typeof params.id === 'string' ? store.getGroup(params.id) : null;
      } else {
        group = typeof params.name === 'string' ? store.groupByName(clusterId, params.name) : null;
      }
      if (!group || group.cluster_id !== clusterId) fail('Unknown group', 404);
      if (operation === 'join') {
        const members = Array.isArray(params.members) && params.members.length ? params.members : [actor.agent_id];
        for (const member of members) store.addGroupMember(group.id, requireMember(store, clusterId, member));
      } else if (operation === 'leave') {
        const members = Array.isArray(params.members) && params.members.length ? params.members : [actor.agent_id];
        for (const member of members) store.removeGroupMember(group.id, typeof member === 'string' ? member : String(member));
      } else {
        if (group.status !== 'OPEN') return { group, deduped: true };
        store.updateGroup(group.id, { status: 'CLOSED' });
      }
      store.appendEvent(clusterId, `group-${operation}`, { group_id: group.id, members: store.groupMembers(group.id) });
      return { group: store.getGroup(group.id), members: store.groupMembers(group.id) };
    }

    case 'publish': {
      if (typeof params.key !== 'string' || !params.key || params.key.length > 256) fail('publish requires a key');
      const expectedRevision = params.expected_revision === undefined || params.expected_revision === null
        ? null
        : typeof params.expected_revision === 'number' ? params.expected_revision : fail('Invalid blackboard expected_revision');
      const entry = store.setBlackboard(clusterId, params.key, jsonValue(params.value ?? null, 'blackboard value'), expectedRevision, actor.agent_id);
      if (!entry) fail('Blackboard entry not found', 404);
      store.appendEvent(clusterId, 'blackboard', { key: entry.key, revision: entry.revision, by: actor.agent_id });
      if (notify) notifySubscribers(store, clusterId, entry.key, notify);
      return { key: entry.key, revision: entry.revision };
    }

    case 'query': {
      const prefix = typeof params.prefix === 'string' ? params.prefix : null;
      const explicitKey = typeof params.key === 'string' ? params.key : null;
      const rows: BlackboardRecord[] = explicitKey ? blackboardRows(store, clusterId, explicitKey) : store.blackboardList(clusterId, prefix);
      return {
        entries: rows.map(r => ({ key: r.key, value: storedJson(r.value, 'blackboard value'), revision: r.revision, updated_by: r.updated_by, updated: r.updated })),
        cursor: store.latestEventSeq(clusterId),
      };
    }

    case 'subscribe': {
      const operation = params.operation ?? 'add';
      if (typeof operation !== 'string' || !SUBSCRIBE_OPERATIONS.has(operation)) fail(`Unknown subscribe operation: ${String(operation)}`);
      if (operation === 'remove') {
        const subs: SubscriptionRecord[] = store.listSubscriptions(clusterId, {
          ...(actor.agent_id === null ? {} : { agent_id: actor.agent_id }),
          active: true,
        });
        const target = params.id ? subs.find(s => s.id === params.id) : subs.find(s => s.pattern === (params.prefix ?? params.key ?? ''));
        if (!target) fail('Subscription not found', 404);
        store.setSubscriptionActive(target.id, false);
        return { subscription: { ...target, active: 0 } };
      }
      const pattern = params.prefix ?? params.key ?? '';
      // Snapshot and cursor come from one read cut so no notification is lost.
      const mode = params.prefix !== undefined ? 'prefix' : 'exact';
      if (typeof pattern !== 'string') fail('Invalid subscription pattern');
      if (actor.agent_id === null) fail('subscription requires an agent identity', 403);
      const snapshotRows: BlackboardRecord[] = mode === 'prefix' ? store.blackboardList(clusterId, pattern) : blackboardRows(store, clusterId, pattern);
      const cursor = store.latestEventSeq(clusterId);
      const subscription = store.insertSubscription({
        id: randomUUID(), cluster_id: clusterId, agent_id: actor.agent_id, pattern,
        mode, cursor: String(cursor),
      });
      if (!subscription) fail('Subscription not found', 404);
      return {
        subscription: { id: subscription.id, pattern, cursor },
        snapshot: snapshotRows.map(r => ({ key: r.key, value: storedJson(r.value, 'blackboard value'), revision: r.revision })),
      };
    }

    default:
      fail(`Unknown communication action: ${String(action)}`);
  }
}

/** One explicitly named blackboard row, or an empty list when it does not exist. */
function blackboardRows(store: ClusterStore, clusterId: string, key: string): BlackboardRecord[] {
  const entry = store.blackboardEntry(clusterId, key);
  return entry ? [entry] : [];
}

function requireMember(store: ClusterStore, clusterId: string, agentId: unknown): string {
  if (typeof agentId !== 'string') fail(`Unknown group member: ${String(agentId)}`, 404);
  const agent = store.getAgent(agentId);
  if (!agent || agent.cluster_id !== clusterId) fail(`Unknown group member: ${agentId}`, 404);
  if (AGENT_TERMINAL.has(agent.status)) fail(`Group member ${agentId} is TERMINATED`, 409);
  return agentId;
}

function notifySubscribers(
  store: ClusterStore,
  clusterId: string,
  key: string,
  notify: (recipient: string, notice: CommunicationNotice) => void,
): void {
  for (const sub of store.listSubscriptions(clusterId, { active: true })) {
    const matches = sub.mode === 'prefix' ? (sub.pattern === '' || key.startsWith(sub.pattern)) : sub.pattern === key;
    if (matches) notify(sub.agent_id, { kind: 'blackboard', key });
  }
}