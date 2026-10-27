import type { Agent } from '../core/agent.js';
import type { Context } from '../core/context.js';
import type { AgentProfile } from '../core/types.js';
import type { AssignmentArchiveReadResult, AssignmentSnapshot, AssignmentSpec, MaterialRef, SubmissionReceipt } from '../assignments/types.js';
import type { Run } from './run.js';
import type { RunStore } from './store.js';

export type RunStatus = 'starting' | 'active' | 'stopping' | 'stopped' | 'failed';
export interface HostOrigin { readonly backend: string; readonly callerSessionId: string }
export type RunDefaults = Partial<Pick<AgentProfile, 'model' | 'params' | 'permission' | 'hostExtras'>> & { preset?: string; skills?: string[] };
export interface RunSnapshot {
  id: string; runId: string; epoch: string; revision: number; status: RunStatus; origin: HostOrigin;
  defaults: RunDefaults; overrides: RunDefaults; rootSessionID?: string; pendingAssignments: number;
  error?: string; storageError?: string; cleanup: 'pending' | 'complete' | 'failed';
}
export interface RunRecord extends Omit<RunSnapshot, 'pendingAssignments' | 'storageError'> {
  assignments: Record<string, AssignmentSnapshot>;
  prepareKeys: Record<string, { digest: string; assignmentId: string }>;
  receipts: Record<string, { digest: string; receipt: SubmissionReceipt }>;
  createRequestId: string; createDigest: string;
}
export type RunHandle = Run;
export interface RunServiceDependencies {
  store: RunStore;
  getOriginDefaults(origin: HostOrigin): RunDefaults;
  initialize(run: Run, defaults: RunDefaults, context: Context): Promise<Agent>;
  validateMaterials?(recipient: Agent, refs: readonly MaterialRef[]): Promise<void>;
  onTopLevelOutcome?(origin: HostOrigin, run: Run, assignment: AssignmentSnapshot): void | Promise<void>;
}
export type ArchiveReader = (id: string) => AssignmentArchiveReadResult;
export type TopLevelAssignmentSpec = AssignmentSpec;
