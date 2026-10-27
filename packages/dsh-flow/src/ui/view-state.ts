import type { DashboardScope, RunViewState } from './types.js';

export function scopeKey(scope: DashboardScope): string { return JSON.stringify(scope.kind === 'global' ? ['global'] : ['session', scope.callerSessionId]); }
export function initialRunView(): RunViewState { return { selectedId: null, groupId: null, detailOpen: false, collapsed: [], tab: 'overview', viewport: { x: 0, y: 0, scale: 1 }, mode: 'tree' }; }
/** One store belongs to one mounted dashboard. A host may retain it across tab mounts. */
export class DashboardViewStore {
  private readonly runs = new Map<string, RunViewState>();
  private readonly selections = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private key(epoch: string, scope: DashboardScope, runId: string): string { return JSON.stringify([epoch, scopeKey(scope), runId]); }
  get(epoch: string, scope: DashboardScope, runId: string): RunViewState {
    const key = this.key(epoch, scope, runId);
    let state = this.runs.get(key);
    if (!state) { state = initialRunView(); this.runs.set(key, state); }
    return state;
  }
  update(epoch: string, scope: DashboardScope, runId: string, update: Partial<RunViewState> | ((state: RunViewState) => RunViewState)): void {
    const state = this.get(epoch, scope, runId);
    this.runs.set(this.key(epoch, scope, runId), typeof update === 'function' ? update(state) : { ...state, ...update });
    for (const listener of this.listeners) listener();
  }
  selectedRun(epoch: string, scope: DashboardScope): string | undefined { return this.selections.get(JSON.stringify([epoch, scopeKey(scope)])); }
  selectRun(epoch: string, scope: DashboardScope, runId: string): void { this.selections.set(JSON.stringify([epoch, scopeKey(scope)]), runId); }
}
export function createDashboardViewStore(): DashboardViewStore { return new DashboardViewStore(); }
