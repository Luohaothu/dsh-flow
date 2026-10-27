import assert from 'node:assert/strict';
import test from 'node:test';
import type { DashboardClientState } from '../../../packages/dsh-flow/src/dashboard/client.js';
import type { MessageView } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { PROTOCOL_VERSION } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { DashboardStore } from '../../../packages/dsh-flow/src/ui/client-store.js';
import { card, run, snapshot } from './fixtures.js';

test('cached snapshots are stable and only verified live message-received updates animate once', () => {
  const message = (id: string): MessageView => ({ id, source: { kind: 'agent', agentId: 'sender', sessionID: 's', name: '发送者' }, recipientId: 'r', timestamp: 100, summary: '真实摘要', priority: 'normal', read: false, readTimestamp: null });
  let state: DashboardClientState = { connection: 'connected', registryConnection: 'connected', runConnection: 'connected', version: PROTOCOL_VERSION, epoch: 'epoch', registry: { version: PROTOCOL_VERSION, epoch: 'epoch', seq: 0, runs: [run()] }, selectedRunId: 'run', snapshot: snapshot([card('r')]), updatedAt: 100, error: null, update: { kind: 'snapshot', generation: 1, seq: 0 } };
  let notify: ((state: DashboardClientState) => void) | undefined, released = 0;
  const store = new DashboardStore({ getState: () => structuredClone(state), subscribe: listener => { notify = listener; listener(structuredClone(state)); return () => { released++; }; } });
  const unsubscribe = store.subscribe(() => {}); assert.strictEqual(store.getSnapshot(), store.getSnapshot());
  const send = (ids: string[], kind: DashboardClientState['update']['kind'], seq: number, eventType = 'message-received') => { state = { ...state, snapshot: snapshot([card('r', null, { messages: ids.map(message) })], { seq }), update: { kind, generation: 1, seq, eventType } }; notify!(structuredClone(state)); };
  send(['history'], 'snapshot', 2); assert.equal(store.getSnapshot().deliveries.length, 0);
  send(['history', 'while-offline'], 'replay', 3); assert.equal(store.getSnapshot().deliveries.length, 0);
  send(['history', 'while-offline', 'live'], 'live', 4); assert.equal(store.getSnapshot().deliveries.length, 1);
  send(['history', 'while-offline', 'live'], 'live', 5, 'message-read'); assert.equal(store.getSnapshot().deliveries.length, 1);
  send(['history', 'while-offline', 'live'], 'snapshot', 10); assert.equal(store.getSnapshot().deliveries.length, 1);
  send(['history', 'while-offline', 'live'], 'live', 11); assert.equal(store.getSnapshot().deliveries.length, 1);
  unsubscribe(); assert.equal(released, 1);
  state = { ...state, snapshot: snapshot([card('r', null, { messages: [message('unmounted-live')] })], { seq: 12 }), update: { kind: 'live', generation: 1, seq: 12, eventType: 'message-received' } };
  const remount = store.subscribe(() => {}); assert.equal(store.getSnapshot().deliveries.length, 0); remount();
});
