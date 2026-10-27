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
import type { AssignmentService } from '../assignments/service.js';
import type { AssignmentSnapshot } from '../assignments/types.js';
import type { Run } from './run.js';
import type { RunRecord, RunServiceDependencies, RunStatus } from './types.js';
export interface RunState {
  record: RunRecord; readonly dependencies: RunServiceDependencies;
  context?: Context; root?: Agent; assignments?: AssignmentService; accepting: boolean;
  initialization: Promise<void>; releasePromise?: Promise<void>; runtimeError?: string; runtimeStatus?: RunStatus; runtimeCleanup?: RunRecord['cleanup'];
  commit<T>(change: (record: RunRecord) => T): T;
  outcome(assignment: AssignmentSnapshot): void;
}
const runs = new WeakMap<Run, RunState>();
export function bindRun(run: Run, state: RunState): void { if (runs.has(run)) throw new Error('Run is already bound'); runs.set(run, state); }
export function runState(run: Run): RunState { const state = runs.get(run); if (!state) throw new Error('Invalid run handle'); return state; }
