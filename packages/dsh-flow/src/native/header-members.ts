import type { DashboardClient } from '../dashboard/client.js';
import type { RegistrySnapshot, RunSnapshot } from '../dashboard/protocol.js';

export interface HeaderRunMembers { snapshot?: RunSnapshot; error?: string }
export type HeaderMembersState = Readonly<Record<string, HeaderRunMembers>>;

/** One open menu owns finite reads; its parent owns the sole registry stream. */
export class HeaderMembers {
  private state: HeaderMembersState = {};
  private readonly listeners = new Set<(state: HeaderMembersState) => void>();
  private readonly pending = new Set<string>();
  private readonly runs = new Set<string>();
  private epoch: string | undefined;
  private seq: number | undefined;
  private active: { id: string; abort: AbortController } | undefined;
  private working = false;
  private disposed = false;
  constructor(private readonly client: Pick<DashboardClient, 'readRunSnapshot'>, private readonly callerSessionId: string) {}
  getState(): HeaderMembersState { return this.state; }
  subscribe(listener: (state: HeaderMembersState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  update(registry: RegistrySnapshot | null): void {
    if (this.disposed || !registry || (registry.epoch === this.epoch && registry.seq === this.seq)) return;
    if (this.epoch !== registry.epoch) { this.active?.abort.abort(); this.pending.clear(); this.state = {}; }
    this.epoch = registry.epoch; this.seq = registry.seq;
    const runs = registry.runs.filter(run => run.entry.callerSessionId === this.callerSessionId);
    this.runs.clear();
    const next: Record<string, HeaderRunMembers> = {};
    for (const run of runs) {
      if (run.status === 'invalid') { next[run.id] = { error: '该运行已不可用' }; continue; }
      this.runs.add(run.id); next[run.id] = this.state[run.id] ?? {};
      this.pending.add(run.id);
    }
    for (const id of this.pending) if (!this.runs.has(id)) this.pending.delete(id);
    if (this.active && !this.runs.has(this.active.id)) this.active.abort.abort();
    this.publish(next);
    if (!this.working) void this.drain();
  }
  dispose(): void { this.disposed = true; this.pending.clear(); this.active?.abort.abort(); this.listeners.clear(); }
  private publish(state: HeaderMembersState): void { if (this.disposed) return; this.state = state; for (const listener of this.listeners) listener(state); }
  private async drain(): Promise<void> {
    this.working = true;
    try {
      while (!this.disposed && this.pending.size) {
        const id = this.pending.values().next().value!;
        this.pending.delete(id);
        const epoch = this.epoch, active = { id, abort: new AbortController() }; this.active = active;
        try {
          const snapshot = await this.client.readRunSnapshot(id, active.abort.signal);
          if (this.disposed || active.abort.signal.aborted || this.epoch !== epoch || !this.runs.has(id)) continue;
          this.publish({ ...this.state, [id]: { snapshot } });
        } catch (error) {
          if (this.disposed || active.abort.signal.aborted || this.epoch !== epoch || !this.runs.has(id)) continue;
          this.publish({ ...this.state, [id]: { ...this.state[id], error: error instanceof Error ? error.message : String(error) } });
        } finally { if (this.active === active) this.active = undefined; }
      }
    } finally { this.working = false; }
  }
}
