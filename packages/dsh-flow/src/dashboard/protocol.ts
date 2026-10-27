import type { AssignmentSnapshot, JsonValue } from '../assignments/types.js';
import type { AgentPermission, AgentStatus, Model, Usage } from '../core/types.js';
import type { AgentOrigin, AgentOutcome } from '../core/observation.js';
import type { HostOrigin, RunStatus } from '../run/types.js';

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export interface ProtocolVersion { major: number; minor: number }
export interface ModelPrice { model: Model; currency: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }
export type PriceTable = ModelPrice[];
export type MessageSourceView = { kind: 'user' | 'system' } | { kind: 'agent'; agentId: string; sessionID: string; name: string } | { kind: 'group'; agentId: string; sessionID: string; name: string; groupId: string };
export interface MessageView { id: string; source: MessageSourceView; recipientId: string; timestamp: number; summary: string; priority: 'high' | 'normal' | 'low'; read: boolean; readTimestamp: number | null }
export interface MarkerView { id: string; kind: string; timestamp: number; message: string }
export interface CleanupView { phase: 'pending' | 'waiting' | 'releasing' | 'complete' | 'failed' | 'abandoned'; timestamp: number; reason?: string; deadline?: number; persistenceError?: string }
export interface UsageView extends Usage { callId: string; amount: number | null; currency: string | null }
export interface AgentCard {
  id: string; parentId: string | null; sessionID: string; name: string; role: string; model: Model; permission: AgentPermission; task: string;
  status: AgentStatus; source: { kind: AgentOrigin; sourceIds: string[]; resumeSessionID?: string };
  waiting: { target: string; startedAt: number; deadline: number } | null;
  outcome: AgentOutcome | null; termination: { signal: 'SIGTERM' | 'SIGKILL'; initiator: 'user' | 'parent' | 'context' | 'self'; mode: 'after-turn' | 'immediate'; propagated: boolean } | null;
  cleanup: CleanupView | null; markers: MarkerView[]; usage: UsageView[]; createdAt: number; terminatedAt: number | null;
  messages: MessageView[]; blackboardWrites: { id: string; groupId: string; startedAt: number }[]; assignmentIds: string[]; groups: string[];
  outputs: { timestamp: number; text: string }[]; errors: { timestamp: number; message: string }[];
}
export interface BlackboardView { id: string; source: MessageSourceView; timestamp: number; summary: string; payload: JsonValue }
export interface GroupView { id: string; members: string[]; dissolved: boolean; blackboard: BlackboardView[] }
export interface RunInfo { id: string; epoch: string; name: string; entry: HostOrigin; rootSummary: { id: string; name: string; sessionID: string } | null; status: RunStatus | 'invalid'; startedAt: number; endedAt?: number; pendingAssignmentCount: number; error?: string; storageError?: string }
export type StopTarget = { agentId: string; scope?: never } | { scope: 'run'; agentId?: never };
export type StopRequest = { operationId: string; targetEpoch: string } & StopTarget;
export interface OperationAccepted { operationId: string; status: 'accepted' }
export interface OperationView { id: string; target: StopTarget; status: 'accepted' | 'completed' | 'failed'; error?: string }
export interface RegistrySnapshot { version: ProtocolVersion; epoch: string; seq: number; runs: RunInfo[]; degraded?: boolean }
export interface RunSnapshot { version: ProtocolVersion; seq: number; run: RunInfo; nodes: AgentCard[]; groups: GroupView[]; assignments: AssignmentSnapshot[]; prices: PriceTable; operations: OperationView[]; degraded?: boolean }
export interface RegistryEvent { epoch: string; seq: number; type: 'run-appeared' | 'run-changed' | 'run-ended' | 'run-invalidated'; run: RunInfo }
export type RunEvent = { runId: string; seq: number; timestamp: number } & (
  | { type: 'node-appeared' | 'node-changed' | 'node-terminated' | 'node-usage' | 'message-received' | 'message-read' | 'blackboard-write' | 'node-cleanup'; node: AgentCard }
  | { type: 'group-changed'; group: GroupView }
  | { type: 'assignment-changed'; assignment: AssignmentSnapshot }
  | { type: 'operation-result'; operation: OperationView }
  | { type: 'run-changed' | 'run-ended' | 'run-invalidated'; run: RunInfo }
);
export interface TokenResponse { token: string; epoch: string; version: ProtocolVersion }
