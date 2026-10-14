/** Collaboration facts. Native execution, permissions and tools belong to DSH. */
export type FlowJsonValue = string | number | boolean | null | FlowJsonValue[] | { [key: string]: FlowJsonValue };
export interface FlowModelSelection { provider?: string; model?: string; reasoningEffort?: string }
/** Responsibility labels, never execution engines or permission tiers. */
export type FlowAgentRole = 'orchestrator' | 'worker';
/** A task role configures an ordinary DSH Agent; it never selects a different execution engine or permission tier. */
export interface FlowAgentProfile {
  name?: string; role?: FlowAgentRole; instructions?: string; skills?: string[];
  preset?: string; model?: FlowModelSelection;
}
export type FlowTeamState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type FlowTaskState = 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'FAILED' | 'CANCELLED';
export type FlowMemberState = 'queued' | 'idle' | 'running' | 'paused' | 'closed' | 'failed';
export type FlowControlAction = 'pause' | 'resume' | 'cancel';
export interface FlowTeamRun {
  id: string; owner_session_id: string; intent_id: string; title: string; objective: string;
  workspace: string; preset: string | null; model: FlowModelSelection | null;
  state: FlowTeamState; version: number; root_task_id: string; deadline: number | null;
  created: number; updated: number;
}
export interface FlowMember extends Omit<FlowAgentProfile, 'name' | 'preset'> {
  id: string; team_id: string; session_id: string; parent_id: string | null; name: string;
  preset: string | null; state: FlowMemberState; active_task_id: string | null;
  error: string | null; created: number; updated: number;
}
export interface FlowTask {
  id: string; team_id: string; parent_id: string | null; owner_session_id: string;
  assignee_session_id: string; title: string; objective: string;
  paused: boolean; status: FlowTaskState; version: number; result_id: string | null;
  created: number; updated: number;
}
export interface FlowResult {
  id: string; team_id: string; task_id: string; task_version: number; author_session_id: string;
  summary: string; artifacts: string[]; outcome: 'complete' | 'partial' | 'blocked';
  ready: boolean; created: number;
}
export interface FlowReview {
  id: string; team_id: string; task_id: string; result_id: string; reviewer_session_id: string;
  accepted: boolean; notes: string; evidence: string[]; created: number;
}
export interface FlowMessage {
  id: string; team_id: string; from_session_id: string; to_session_id: string;
  task_id: string | null; content: string; mode: 'request' | 'notice';
  state: 'queued' | 'delivered' | 'cancelled'; created: number; delivered_at: number | null;
}
export interface FlowEvent { seq: number; team_id: string; type: string; data: FlowJsonValue; at: number }
export interface FlowUsageSummary {
  responses: number | null; input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; total_tokens: number | null;
}
export interface FlowTeamSnapshot {
  run: FlowTeamRun; members: FlowMember[]; tasks: FlowTask[]; results: FlowResult[];
  reviews: FlowReview[]; messages: FlowMessage[]; events: FlowEvent[]; usage: FlowUsageSummary;
}
export interface FlowTeamCreateRequest {
  objective: string; title?: string; workspace?: string; preset?: string;
  model?: FlowModelSelection; deadline_ms?: number;
}
export interface FlowTaskRequest {
  action: 'delegate' | 'update'; team_id?: string; task_id?: string; version?: number;
  title?: string; objective?: string;
  member_id?: string;
  /** Creation-time configuration. Reusing a member retains its existing profile. */
  profile?: FlowAgentProfile;
}
export interface FlowResultRequest {
  task_id: string; summary: string; artifacts?: string[]; outcome?: 'complete' | 'partial' | 'blocked';
}
export interface FlowReviewRequest { result_id: string; accepted: boolean; notes: string; evidence?: string[] }
export interface FlowMessageRequest {
  team_id?: string; to: string; content: string; task_id?: string; mode?: 'request' | 'notice';
}
export interface FlowReadRequest {
  team_id?: string; what?: 'team' | 'task' | 'member' | 'result' | 'messages' | 'events';
  id?: string; offset?: number; limit?: number;
}
export interface FlowReadResult {
  what: string; value: FlowJsonValue; total: number; offset: number; next_offset: number | null;
}
export interface FlowControlRequest {
  team_id?: string; target: 'team' | 'member' | 'task'; id: string; action: FlowControlAction;
}
export interface FlowAgentSession {
  session_id: string; team_id: string; owner_session_id: string; member_id: string;
  parent_session_id: string | null; name: string; state: FlowMemberState;
  role?: FlowAgentRole;
  can_message: boolean; message_block_reason: string | null;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'flow-task': { kind: 'flow-task'; team_id: string; task_id: string; task_version: number };
    'flow-message': { kind: 'flow-message'; team_id: string; message_id: string; task_id?: string };
  }
}
