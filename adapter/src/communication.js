/**
 * Communication graph: point-to-point messages, multicast, groups, blackboard
 * and subscriptions. Any agent inside one cluster may reach any other agent
 * across subtrees; the management tree and permissions are untouched by this.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fail } from './store.js';
import { AGENT_TERMINAL } from './protocol.js';

export const COMMUNICATION_ACTIONS = ['send', 'multicast', 'group', 'publish', 'query', 'subscribe'];

export function resolveRecipients(store, clusterId, actor, params) {
  const targets = [];
  const push = id => {
    if (typeof id !== 'string' || !id) fail('Invalid recipient');
    if (!targets.includes(id)) targets.push(id);
  };
  if (params.agent !== undefined) push(params.agent);
  if (params.group !== undefined) {
    const group = store.groupByName(clusterId, params.group) ?? store.getGroup(params.group);
    if (!group || group.cluster_id !== clusterId) fail(`Unknown group: ${params.group}`, 404);
    for (const member of store.groupMembers(group.id)) push(member);
  }
  if (params.node !== undefined) {
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

function deliverable(store, clusterId, actor, params) {
  const recipients = resolveRecipients(store, clusterId, actor, params);
  const content = normalizeContent(params.content);
  return { recipients, content };
}

function normalizeContent(content) {
  if (content === undefined || content === null) fail('Message requires content');
  if (typeof content === 'string') {
    if (!content.length || content.length > 32768) fail('Invalid message content');
    return { text: content };
  }
  if (typeof content === 'object' && !Array.isArray(content)) return content;
  fail('Invalid message content');
}

// Atomicity is part of this module's interface, not a caller ordering rule.
// notify persists wake-up evidence in the same store transaction.
export function communicate(store, cluster, actor, action, params = {}, options = {}) {
  return store.tx(() => applyCommunication(store, cluster, actor, action, params, options));
}

function applyCommunication(store, cluster, actor, action, params, { notify } = {}) {
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
        || !isDeepStrictEqual(JSON.parse(existing.content), content))) {
        fail('message_id conflicts with an existing message', 409);
      }
      if (!existing) store.insertMessage({
        id, cluster_id: clusterId, from_agent: actor.agent_id, from_node: actor.node_id, kind, content,
      });
      // A retry may repair missing recipients, but cannot change the immutable
      // envelope. New and repaired deliveries share notification persistence.
      const delivered = [];
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
      if (!['create', 'join', 'leave', 'close'].includes(operation)) fail(`Unknown group operation: ${String(operation)}`);
      if (operation === 'create') {
        const name = params.name ?? params.id;
        if (typeof name !== 'string' || !name) fail('group create requires a name');
        const existing = store.groupByName(clusterId, name);
        if (existing) return { group: existing, deduped: true };
        const group = store.insertGroup({ id: randomUUID(), cluster_id: clusterId, name });
        const members = Array.isArray(params.members) ? params.members : [];
        for (const member of members) store.addGroupMember(group.id, requireMember(store, clusterId, member));
        if (actor.agent_id) store.addGroupMember(group.id, actor.agent_id);
        store.appendEvent(clusterId, 'group-created', { group_id: group.id, name, members: store.groupMembers(group.id) });
        return { group: store.getGroup(group.id), members: store.groupMembers(group.id) };
      }
      const group = params.id ? store.getGroup(params.id) : store.groupByName(clusterId, params.name);
      if (!group || group.cluster_id !== clusterId) fail('Unknown group', 404);
      if (operation === 'join') {
        const members = Array.isArray(params.members) && params.members.length ? params.members : [actor.agent_id];
        for (const member of members) store.addGroupMember(group.id, requireMember(store, clusterId, member));
      } else if (operation === 'leave') {
        const members = Array.isArray(params.members) && params.members.length ? params.members : [actor.agent_id];
        for (const member of members) store.removeGroupMember(group.id, member);
      } else {
        if (group.status !== 'OPEN') return { group, deduped: true };
        store.updateGroup(group.id, { status: 'CLOSED' });
      }
      store.appendEvent(clusterId, `group-${operation}`, { group_id: group.id, members: store.groupMembers(group.id) });
      return { group: store.getGroup(group.id), members: store.groupMembers(group.id) };
    }

    case 'publish': {
      if (typeof params.key !== 'string' || !params.key || params.key.length > 256) fail('publish requires a key');
      const entry = store.setBlackboard(clusterId, params.key, params.value ?? null, params.expected_revision ?? null, actor.agent_id);
      store.appendEvent(clusterId, 'blackboard', { key: entry.key, revision: entry.revision, by: actor.agent_id });
      if (notify) notifySubscribers(store, clusterId, entry.key, notify);
      return { key: entry.key, revision: entry.revision };
    }

    case 'query': {
      const prefix = typeof params.prefix === 'string' ? params.prefix : null;
      const explicitKey = typeof params.key === 'string' ? params.key : null;
      const rows = explicitKey ? [store.blackboardEntry(clusterId, explicitKey)].filter(Boolean) : store.blackboardList(clusterId, prefix);
      return {
        entries: rows.map(r => ({ key: r.key, value: JSON.parse(r.value), revision: r.revision, updated_by: r.updated_by, updated: r.updated })),
        cursor: store.latestEventSeq(clusterId),
      };
    }

    case 'subscribe': {
      const operation = params.operation ?? 'add';
      if (!['add', 'remove'].includes(operation)) fail(`Unknown subscribe operation: ${String(operation)}`);
      if (operation === 'remove') {
        const subs = store.listSubscriptions(clusterId, { agent_id: actor.agent_id, active: true });
        const target = params.id ? subs.find(s => s.id === params.id) : subs.find(s => s.pattern === (params.prefix ?? params.key ?? ''));
        if (!target) fail('Subscription not found', 404);
        store.setSubscriptionActive(target.id, false);
        return { subscription: { ...target, active: 0 } };
      }
      const pattern = params.prefix ?? params.key ?? '';
      // Snapshot and cursor come from one read cut so no notification is lost.
      const mode = params.prefix !== undefined ? 'prefix' : 'exact';
      if (typeof pattern !== 'string') fail('Invalid subscription pattern');
      const snapshotRows = mode === 'prefix'
        ? store.blackboardList(clusterId, pattern)
        : [store.blackboardEntry(clusterId, pattern)].filter(Boolean);
      const cursor = store.latestEventSeq(clusterId);
      const subscription = store.insertSubscription({
        id: randomUUID(), cluster_id: clusterId, agent_id: actor.agent_id, pattern,
        mode, cursor: String(cursor),
      });
      return {
        subscription: { id: subscription.id, pattern, cursor },
        snapshot: snapshotRows.map(r => ({ key: r.key, value: JSON.parse(r.value), revision: r.revision })),
      };
    }

    default:
      fail(`Unknown communication action: ${String(action)}`);
  }
}

function requireMember(store, clusterId, agentId) {
  const agent = store.getAgent(agentId);
  if (!agent || agent.cluster_id !== clusterId) fail(`Unknown group member: ${agentId}`, 404);
  if (AGENT_TERMINAL.has(agent.status)) fail(`Group member ${agentId} is TERMINATED`, 409);
  return agentId;
}

function notifySubscribers(store, clusterId, key, notify) {
  for (const sub of store.listSubscriptions(clusterId, { active: true })) {
    const matches = sub.mode === 'prefix' ? (sub.pattern === '' || key.startsWith(sub.pattern)) : sub.pattern === key;
    if (matches) notify(sub.agent_id, { kind: 'blackboard', key });
  }
}