/** One observable snapshot shared by the tree, graph, list and inspectors. */
import type { FlowTeamRun, FlowTeamSnapshot } from '../types.ts';

export interface TeamReadOperations {
  runs(sessionId: string): Promise<readonly FlowTeamRun[]>
  read(sessionId: string, runId: string): Promise<FlowTeamSnapshot>
}
export interface ObserverSnapshot {
  readonly runs: readonly FlowTeamRun[]
  readonly selectedRun: string | null
  readonly team: FlowTeamSnapshot | null
  readonly loading: boolean
  readonly error: string | null
  readonly updated: number | null
}
/** Generation fences prevent a slow run read from publishing into a newer selection. */
export class TeamObserver {
  private value: ObserverSnapshot = { runs: [], selectedRun: null, team: null, loading: true, error: null, updated: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selectedRun: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  constructor(readonly sessionId: string, private operations: TeamReadOperations, private interval = 1500) {}
  getSnapshot = (): ObserverSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.stopTimer(); };
  };
  private publish(value: ObserverSnapshot): void { this.value = value; for (const listener of this.listeners) listener(); }
  private stopTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  select(runId: string): void {
    if (this.selectedRun === runId) return;
    this.selectedRun = runId;
    this.reset();
    this.publish({ ...this.value, selectedRun: runId, team: null, loading: true, error: null });
    void this.refresh();
  }
  /** Reconnect invalidates in-flight reads before fetching the authoritative snapshot. */
  reset(): void { this.generation++; this.inFlight = null; this.stopTimer(); }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.stopTimer();
    const generation = this.generation;
    const task = this.load(generation).finally(() => {
      if (generation !== this.generation) return;
      this.inFlight = null;
      if (this.listeners.size && !this.disposed) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, this.interval);
    });
    this.inFlight = task;
    return task;
  };
  private async load(generation: number): Promise<void> {
    try {
      const runs = await this.operations.runs(this.sessionId);
      if (generation !== this.generation || this.disposed) return;
      this.publish({ ...this.value, runs });
      const run = this.selectedRun === null
        ? runs.find(run => !['completed', 'cancelled', 'failed'].includes(run.state)) ?? runs[0]
        : runs.find(run => run.id === this.selectedRun);
      if (this.selectedRun !== null && !run) throw new Error('所选运行已不可用，请从运行记录选择其他运行');
      const team = run ? await this.operations.read(this.sessionId, run.id) : null;
      if (generation !== this.generation || this.disposed) return;
      if (team && (team.run.id !== run?.id || team.run.main_session_id !== this.sessionId)) throw new Error('提供方返回了其他会话的团队');
      if (team && this.value.team?.run.id === team.run.id && team.run.version <= this.value.team.run.version) {
        this.publish({...this.value,runs,loading:false,error:null,updated:Date.now()});
        return;
      }
      this.publish({ runs, selectedRun: run?.id ?? this.selectedRun, team, loading: false, error: null, updated: Date.now() });
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.publish({ ...this.value, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  dispose(): void { this.disposed = true; this.reset(); this.listeners.clear(); }
}
