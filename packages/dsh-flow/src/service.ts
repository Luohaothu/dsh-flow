/**
 * The `ctx.flow` public contract.
 *
 * This is the surface other plugins are allowed to program against: the seven
 * cluster operations and main-session team bindings. The store, the scheduler, the ticker,
 * recovery and disposal stay on the deep `ClusterRuntime` module — a consumer
 * cannot reach them through this type, and the published package does not
 * export the runtime class at all.
 *
 * `queryCluster` is the single user-facing query entry point and answers with a
 * tagged result, so a consumer narrows `data` by branch instead of asserting
 * the shape it hoped for. The role tools keep their own actor-scoped query
 * inside the runtime; that one is not part of this contract.
 */
import type {} from '@deepseek-ai/cordis';
import type { FlowModelSelection, FlowStartDefaults } from './core/model.ts';

import type {
  FlowTeamRun,
  FlowAgentSession,
  FlowTeamSnapshot,
  FlowTeamCreateRequest,
  FlowControlAction,
  FlowEventQuery,
  FlowEventsResult,
  FlowListQuery,
  FlowListResult,
  FlowQueryKind,
  FlowQueryParams,
  FlowQueryResult,
  FlowReadQuery,
  FlowReport,
  FlowSnapshot,
  FlowStartRequest,
} from './types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hierarchical agent clusters owned by this deployment. */
    flow: FlowService
  }
}

/** The cluster operations a deployment may call. */
export interface FlowService {
  /** Main-Agent creation, with durable assessment and parameter-safe retries. */
  createTeam(sessionId: string, launchId: string, request: FlowTeamCreateRequest, model?: FlowModelSelection): FlowTeamSnapshot
  /** Effective deployment defaults for the main Agent's launch assessment. */
  teamStartDefaults(): FlowStartDefaults | undefined
  /** Internal execution sessions cannot operate the main-conversation tools. */
  isTeamAgentSession(sessionId: string): boolean
  agentSession(sessionId: string): FlowAgentSession | null
  promptAgent(sessionId: string, requestId: string, text: string, clientTimeZone?: string, mode?: 'queue' | 'steer'): void
  interruptAgent(sessionId: string): void
  /** Release terminal execution resources while retaining all evidence and history. */
  finalizeTeam(sessionId: string, runId: string): FlowTeamSnapshot
  /** Start a deduplicated main-session command intent. */
  startTeam(sessionId: string, intentId: string, objective: string, workspace?: string,model?:FlowModelSelection): FlowSnapshot
  /** Apply the main-session model selection to active teams that follow it. */
  teamSelectModel(sessionId:string,model:FlowModelSelection):void
  teamReply(sessionId: string, messageId: string, content: string, runId?: string): void
  /** Runs are isolated by their owning main session. */
  teamRuns(sessionId: string): readonly FlowTeamRun[]
  /** Durable main owners, including idle/cold sessions; Host notification delivery only. */
  teamOwners(): readonly string[]
  /** One coherent read-only snapshot. */
  teamRead(sessionId: string, runId: string): FlowTeamSnapshot
  /**
   * Create and start one cluster.
   * @param request - the objective plus whatever the caller overrides; every omitted field comes from the resolved deployment configuration.
   * @returns the new cluster's initial snapshot.
   */
  start(request: FlowStartRequest): FlowSnapshot
  /**
   * List clusters, newest configuration state first.
   * @param request - optional status filter and page window.
   * @returns the cluster list with each cluster's counts.
   */
  list(request: FlowListQuery): FlowListResult
  /**
   * Read one cluster.
   * @param id - cluster id.
   * @param request - which sections and how much of the ledger to include.
   * @returns the cluster snapshot.
   */
  read(id: string, request: FlowReadQuery): FlowSnapshot
  /**
   * Read one page of a cluster's durable events.
   * @param id - cluster id.
   * @param request - cursor and page size.
   * @returns the event page.
   */
  events(id: string, request: FlowEventQuery): FlowEventsResult
  /**
   * Pause, resume or cancel a cluster.
   * @param id - cluster id.
   * @param action - the operator's whole-cluster switch.
   * @returns the cluster snapshot after the transition.
   */
  control(id: string, action: FlowControlAction): FlowSnapshot
  /**
   * Ask one tagged question about a cluster's state.
   * @param id - cluster id.
   * @param what - which question to ask.
   * @param params - the parameters that question consumes.
   * @returns the answer, tagged with the branch that produced it.
   */
  queryCluster(id: string, what: FlowQueryKind, params: FlowQueryParams): FlowQueryResult
  /**
   * Produce the exhaustive mechanism report of one cluster.
   * @param id - cluster id.
   * @returns the report.
   */
  report(id: string): FlowReport
}
