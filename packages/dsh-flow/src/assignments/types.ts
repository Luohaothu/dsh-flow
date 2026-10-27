import type { Agent } from '../core/agent.js';
import type { Run } from '../run/run.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | JsonObject;
export type AssignmentID = string;
export type AssignmentStatus = 'pending' | 'submitted' | 'failed' | 'cancelled';
export interface MaterialRef { id: string; sourceId: string; digest: string; location: string; mediaType: string }
export interface AssignmentSpec {
  name: string; type: string; background: string; requirements: string; acceptanceCriteria: string;
  resultSchema: JsonSchema; materials?: MaterialRef[]; resumesAssignmentId?: AssignmentID;
}
export type AssignmentRequest =
  | { sender: Agent; recipient: Agent; parentAssignment: Assignment; spec: AssignmentSpec }
  | { sender: Run; recipient: Agent; parentAssignment: null; spec: AssignmentSpec };
export interface AssignmentSubmission { result: JsonValue; continuingChildren: { assignment: Assignment; reason: string }[] }
export type AssignmentActor = { kind: 'run'; runId: string } | { kind: 'agent'; sessionID: string; instanceId: string };
export interface SchemaError { path: string; message: string }
export interface SubmissionReceipt {
  kind: 'accepted' | 'missing-children' | 'invalid-result' | 'terminal';
  assignmentId: AssignmentID; status: AssignmentStatus;
  missingChildren?: AssignmentID[]; errors?: SchemaError[];
}
export interface SubmissionAttempt {
  transportKey: string; timestamp: number;
  submission: { result: JsonValue; continuingChildren: { assignmentId: AssignmentID; reason: string }[] };
  receipt: SubmissionReceipt;
}
export interface AssignmentSnapshot {
  id: AssignmentID; runId: string; spec: AssignmentSpec; sender: AssignmentActor;
  recipientSessionID: string; recipientInstanceId: string; parentAssignmentId: AssignmentID | null; status: AssignmentStatus;
  submissions: SubmissionAttempt[]; submissionCount: number; schemaFailures: number;
  schemaDialect: string; schemaDigest: string; continuingChildren: { assignmentId: AssignmentID; reason: string }[];
  result?: JsonValue; reason?: string;
}
export interface AssignmentQuery { parentAssignment?: Assignment | null; parentAssignmentId?: AssignmentID | null; status?: AssignmentStatus }
export interface AssignmentOutcome { assignmentId: AssignmentID; status: AssignmentStatus; reason?: string }
export type AssignmentArchiveReadResult =
  | { kind: 'found'; assignment: AssignmentSnapshot; interrupted: boolean }
  | { kind: 'not-found'; id: AssignmentID };

export class Assignment {
  constructor(readonly id: AssignmentID, readonly runId: string) { Object.freeze(this); }
}
