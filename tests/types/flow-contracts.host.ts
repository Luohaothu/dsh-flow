/**
 * Host-side type contract of the published package.
 *
 * This file is never executed: `tsc -b tsconfig.host.json` compiles it so that
 * the public surface is *proved* rather than described. Each `@ts-expect-error`
 * below is a negative assertion — if the rejected expression ever starts to
 * type-check (because a shape widened to `any`, a member leaked, or an export
 * appeared), the directive itself becomes an error and this file fails to
 * compile. That is the only place in this repository where the directive is
 * allowed.
 */
import type { Context } from '@deepseek-ai/cordis';

import * as flowPackage from 'dsh-flow';
import type { FlowQueryResult, FlowSnapshot, FlowStartRequest } from 'dsh-flow/types';

declare const ctx: Context;

/**
 * The plugin contract, in the shapes a consumer is allowed to use.
 * @returns the values a legal consumer observes.
 */
export function legalHostUsage(): {
  snapshot: FlowSnapshot
  answered: number
  status: FlowSnapshot['cluster']['status']
} {
  const request: FlowStartRequest = { objective: 'ship it', budget: { tokens: 100_000 } };

  // `start` resolves the rest of the envelope from the deployment configuration.
  const snapshot = ctx.flow.start(request);

  // The control vocabulary is a literal union.
  const paused = ctx.flow.control(snapshot.cluster.id, 'pause');

  // A read may omit whole sections.
  const partial = ctx.flow.read(snapshot.cluster.id, { include_events: false });

  // The query answer is tagged, so the payload narrows by branch and no cast is
  // needed to read a page total.
  const answer: FlowQueryResult = ctx.flow.queryCluster(snapshot.cluster.id, 'nodes', { limit: 10 });
  const answered = answer.what === 'nodes' ? answer.data.total : 0;

  // The report is exhaustive.
  const report = ctx.flow.report(snapshot.cluster.id);
  void report.mechanism.agents_live;
  void partial.counts.transactions;

  return { snapshot, answered, status: paused.cluster.status };
}

// ---------------------------------------------------------------------------
// Negative assertions. Each one must keep failing to compile.
// ---------------------------------------------------------------------------

// @ts-expect-error a budget dimension is a number, never a string
export const wrongBudget: FlowStartRequest = { objective: 'x', budget: { tokens: 'many' } };

// @ts-expect-error the control vocabulary is closed: 'stop' is not an action
export const wrongControl = ctx.flow.control('cluster', 'stop');

// @ts-expect-error the store is an implementation detail of the runtime, not of `ctx.flow`
export const leakedStore = ctx.flow.store;

// @ts-expect-error the runtime class is not part of the published surface
export const leakedRuntime = flowPackage.ClusterRuntime;

// @ts-expect-error the runtime's own `query` is actor-scoped and internal; consumers ask `queryCluster`
export const leakedQuery = ctx.flow.query('cluster', 'nodes', {});