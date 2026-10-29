import type { HostOrigin } from './types.js';

const origins = new WeakMap<object, HostOrigin>();
export function issueHostOrigin(input: HostOrigin): HostOrigin {
  if (!input || typeof input.backend !== 'string' || !input.backend.trim() || typeof input.callerSessionId !== 'string' || !input.callerSessionId.trim()) throw new TypeError('Host origin requires backend and callerSessionId');
  const origin = Object.freeze({ backend: input.backend, callerSessionId: input.callerSessionId });
  origins.set(origin, origin);
  return origin;
}
export function verifiedOrigin(origin: HostOrigin): HostOrigin {
  const trusted = origin && origins.get(origin);
  if (!trusted) throw new Error('HostOrigin must be issued by the trusted host');
  return trusted;
}
export function originKey(origin: HostOrigin): string { const trusted = verifiedOrigin(origin); return JSON.stringify([trusted.backend, trusted.callerSessionId]); }

import type { Agent } from '../core/agent.js';
import type { Context } from '../core/context.js';
import type { PatternCatalog } from '../patterns/catalog.js';
import type { AssignmentService } from '../assignments/service.js';
import type { AssignmentExecutionFault, AssignmentSnapshot } from '../assignments/types.js';
import type { Run } from './run.js';
import type { RunSnapshot } from './types.js';
import type { RunRecord, RunServiceDependencies, RunStatus } from './types.js';
export interface RunState {
  readonly patternCatalog: PatternCatalog;
  record: RunRecord; readonly dependencies: RunServiceDependencies;
  context?: Context; root?: Agent; assignments?: AssignmentService; accepting: boolean;
  initialization: Promise<void>; releasePromise?: Promise<void>; runtimeError?: string; runtimeEndedAt?: number; runtimeStatus?: RunStatus; runtimeCleanup?: RunRecord['cleanup'];
  commit<T>(change: (record: RunRecord) => T, publish?: boolean): T;
  outcome(assignment: AssignmentSnapshot): void;
  executionFault(fault: AssignmentExecutionFault): void;
  notify(): void;
  afterCommit?(record: RunRecord): void;
}
const runs = new WeakMap<Run, RunState>();
const contextRuns = new WeakMap<Context, Run>();
export function contextRun(context: Context): Run { const run = contextRuns.get(context); if (!run) throw new Error('Context does not belong to a Run'); return run; }
export function bindRun(run: Run, state: RunState): void { if (runs.has(run)) throw new Error('Run is already bound'); if (!state.context || contextRuns.has(state.context)) throw new Error('Run Context is already bound'); runs.set(run, state); contextRuns.set(state.context, run); }
export function runState(run: Run): RunState { const state = runs.get(run); if (!state) throw new Error('Invalid run handle'); return state; }

/** Package-private authority for the authenticated dashboard composition. */
export const runServiceControl = Symbol('RunService.control');
export interface RunReadView {
  run: RunSnapshot;
  assignments: AssignmentSnapshot[];
  context: Context;
  root?: Agent;
  revision: number;
}
export interface RunServiceControl {
  enumerate(): RunReadView[];
  observe(listener: (view: RunReadView) => void): () => void;
  snapshot(runId: string): RunReadView;
  release(runId: string, targetEpoch: string): Promise<void>;
}
