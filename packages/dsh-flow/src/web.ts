/**
 * The standard Remote face of the cluster service.
 *
 * This module is the whole browser contract: seven methods, each one a thin
 * adaptation of a `ctx.flow` operation. It owns no database, no scheduler and
 * no background loop, and it caches nothing — every call reads the live service,
 * so an unloaded or replaced flow service cannot leave a stale object behind
 * here.
 *
 * The binding is `bindTypertRemote` rather than a `TypertRemoteService` base
 * class: the generated descriptor, the wire namespace and the visible gateway
 * binding are identical, and this form keeps the class hierarchy to the Cordis
 * `Service` the plugin already needs.
 *
 * What is deliberately *not* here: `settle`, `tick`, `single`, `recover` and
 * `dispose`. Those drive the host itself and are reachable only through the
 * development IPC bridge an acceptance overlay mounts; an authenticated browser
 * must not be able to close the database and abort every turn with one request.
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';

import type {
  FlowTeamRun,
  FlowAgentSession,
  FlowTeamSnapshot,
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
    /** Typed Remote control of this deployment's agent clusters. */
    flowRemote: FlowRemote
  }
}

/** Cordis identity for the cluster Remote face. */
export const name = 'dsh-flow-web';

/** The cluster service must be live before this face is callable. */
export const inject = ['flow'];

/** Typed Remote access to the cluster service. */
export class FlowRemote extends Service {
  /** Visible gateway binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote = bindTypertRemote(this, 'flowRemote', { namespace: 'flow' });

  /**
   * @param ctx - context carrying the cluster service.
   */
  constructor(ctx: Context) {
    super(ctx, 'flowRemote');
  }

  /** List the owning conversation's current and historical runs. */
  @Remote
  teamRuns(sessionId: string, signal: AbortSignal): readonly FlowTeamRun[] {
    signal.throwIfAborted();
    return this.ctx.flow.teamRuns(sessionId);
  }

  /** Native Session relation and current continuation policy; observation only. */
  @Remote
  agentSession(sessionId: string, signal: AbortSignal): FlowAgentSession | null {
    signal.throwIfAborted();
    return this.ctx.flow.agentSession(sessionId);
  }

  /** Read a transactionally consistent observing snapshot. */
  @Remote
  teamRead(sessionId: string, runId: string, signal: AbortSignal): FlowTeamSnapshot {
    signal.throwIfAborted();
    return this.ctx.flow.teamRead(sessionId, runId);
  }

  /**
   * Start one cluster.
   * @param request - objective plus overrides; omitted fields come from configuration.
   * @param signal - carrier cancellation.
   * @returns the new cluster's initial snapshot.
   */
  start(request: FlowStartRequest, signal: AbortSignal): FlowSnapshot {
    signal.throwIfAborted();
    return this.ctx.flow.start(request);
  }

  /**
   * List clusters.
   * @param request - optional status filter and page window.
   * @param signal - carrier cancellation.
   * @returns the cluster list.
   */
  @Remote
  list(request: FlowListQuery, signal: AbortSignal): FlowListResult {
    signal.throwIfAborted();
    return this.ctx.flow.list(request);
  }

  /**
   * Read one cluster.
   * @param id - cluster id.
   * @param request - which sections to include.
   * @param signal - carrier cancellation.
   * @returns the cluster snapshot.
   */
  @Remote
  read(id: string, request: FlowReadQuery, signal: AbortSignal): FlowSnapshot {
    signal.throwIfAborted();
    return this.ctx.flow.read(id, request);
  }

  /**
   * Read one page of durable events.
   * @param id - cluster id.
   * @param request - cursor and page size.
   * @param signal - carrier cancellation.
   * @returns the event page.
   */
  @Remote
  events(id: string, request: FlowEventQuery, signal: AbortSignal): FlowEventsResult {
    signal.throwIfAborted();
    return this.ctx.flow.events(id, request);
  }

  /**
   * Pause, resume or cancel one cluster.
   * @param id - cluster id.
   * @param action - the operator's whole-cluster switch.
   * @param signal - carrier cancellation.
   * @returns the snapshot after the transition.
   */
  control(id: string, action: FlowControlAction, signal: AbortSignal): FlowSnapshot {
    signal.throwIfAborted();
    return this.ctx.flow.control(id, action);
  }

  /**
   * Ask one tagged question about a cluster.
   * @param id - cluster id.
   * @param what - which question to ask.
   * @param params - the parameters that question consumes.
   * @param signal - carrier cancellation.
   * @returns the tagged answer.
   */
  @Remote
  query(id: string, what: FlowQueryKind, params: FlowQueryParams, signal: AbortSignal): FlowQueryResult {
    signal.throwIfAborted();
    return this.ctx.flow.queryCluster(id, what, params);
  }

  /**
   * Produce one cluster's mechanism report.
   * @param id - cluster id.
   * @param signal - carrier cancellation.
   * @returns the report.
   */
  @Remote
  report(id: string, signal: AbortSignal): FlowReport {
    signal.throwIfAborted();
    return this.ctx.flow.report(id);
  }
}

/**
 * Register the Remote face.
 * @param ctx - context carrying the cluster service.
 */
export function apply(ctx: Context): void {
  new FlowRemote(ctx);
}
