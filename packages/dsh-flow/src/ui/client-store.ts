import type { DashboardClient, DashboardClientState } from '../dashboard/client.js';
import type { MessageView } from '../dashboard/protocol.js';

export interface Delivery { key: string; message: MessageView; receivedAt: number; replay: boolean }
export interface DashboardStoreSnapshot { state: DashboardClientState; deliveries: readonly Delivery[]; joined: ReadonlyMap<string, number>; runDataTime: number | null }
export class DashboardStore {
  private value: DashboardStoreSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeClient: (() => void) | undefined;
  private identity = '';
  private seen = new Set<string>();
  private seenNodes = new Set<string>();
  private initialized = false;
  constructor(private readonly client: Pick<DashboardClient, 'getState' | 'subscribe'>) { this.value = { state: client.getState(), deliveries: [], joined: new Map(), runDataTime: null }; }
  getSnapshot = (): DashboardStoreSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.unsubscribeClient ??= this.client.subscribe(this.accept);
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.unsubscribeClient?.(); this.unsubscribeClient = undefined; this.initialized = false; } };
  };
  private accept = (state: DashboardClientState): void => {
    const snapshot = state.snapshot, identity = snapshot ? `${snapshot.run.epoch}/${snapshot.run.id}` : `${state.epoch}/${state.selectedRunId}`;
    if (identity !== this.identity) { this.identity = identity; this.seen = new Set(); this.seenNodes = new Set(); }
    const live = this.initialized && state.update.kind === 'live';
    const now = Date.now(), deliveries = this.initialized && identity === thisIdentity(this.value.state) ? this.value.deliveries.filter(item => now - item.receivedAt < 2400) : [];
    const joined = new Map(this.initialized && identity === thisIdentity(this.value.state) ? [...this.value.joined].filter(([, time]) => now - time < 1500) : []);
    if (snapshot) for (const node of snapshot.nodes) {
      if (!this.seenNodes.has(node.id) && live && state.update.eventType === 'node-appeared') joined.set(node.id, now);
      this.seenNodes.add(node.id);
      for (const message of node.messages) {
        const key = `${node.id}/${message.id}`;
        if (!this.seen.has(key) && live && state.update.eventType === 'message-received' && (message.source.kind === 'agent' || message.source.kind === 'group')) deliveries.push({ key: `${identity}/${key}`, message, receivedAt: now, replay: false });
        this.seen.add(key);
      }
    }
    const runDataTime = state.snapshot && state.update.kind !== 'state' ? state.updatedAt : identity === thisIdentity(this.value.state) ? this.value.runDataTime : null;
    this.initialized = true; this.value = { state, deliveries, joined, runDataTime };
    for (const listener of this.listeners) listener();
  };
}
function thisIdentity(state: DashboardClientState): string { return state.snapshot ? `${state.snapshot.run.epoch}/${state.snapshot.run.id}` : `${state.epoch}/${state.selectedRunId}`; }
