/** Small collaboration interface; it never intercepts native business tools. */
import type {} from '@deepseek-ai/cordis';
import type {
  FlowAgentSession, FlowTeamCreateRequest, FlowTeamRun, FlowTeamSnapshot, FlowModelSelection,
  FlowTaskRequest, FlowTask, FlowResultRequest, FlowResult, FlowReviewRequest, FlowReview,
  FlowMessageRequest, FlowMessage, FlowReadRequest, FlowReadResult, FlowControlRequest,
} from './types.ts';
declare module '@deepseek-ai/cordis' { interface Context { flow: FlowService } }
export interface FlowService {
  createTeam(ownerSessionId: string, intentId: string, request: FlowTeamCreateRequest, model?: FlowModelSelection): Promise<FlowTeamSnapshot>;
  teamRuns(ownerSessionId: string): FlowTeamRun[];
  teamRead(ownerSessionId: string, teamId: string): FlowTeamSnapshot;
  agentSession(sessionId: string): FlowAgentSession | null;
  isTeamAgentSession(sessionId: string): boolean;
  task(actorSessionId: string, request: FlowTaskRequest, operationId?: string): Promise<FlowTask>;
  result(actorSessionId: string, request: FlowResultRequest, operationId?: string): Promise<FlowResult>;
  review(actorSessionId: string, request: FlowReviewRequest, operationId?: string): Promise<FlowReview>;
  message(actorSessionId: string, request: FlowMessageRequest, operationId?: string): Promise<FlowMessage>;
  read(actorSessionId: string, request: FlowReadRequest): FlowReadResult;
  control(actorSessionId: string, request: FlowControlRequest, operationId?: string): Promise<FlowTeamSnapshot>;
}
