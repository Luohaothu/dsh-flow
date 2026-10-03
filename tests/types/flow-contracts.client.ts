/**
 * Client-side type contract of the published package.
 *
 * Never executed. It proves three things a browser consumer depends on:
 * the generated Remote namespace is callable with the declared arguments, its
 * answers are `RemoteResult` values that narrow by the tag the *answer*
 * carries, and the Host service tree is not reachable from a Client Context.
 *
 * The `@ts-expect-error` directives are negative assertions: if the rejected
 * expression ever starts to compile, the directive becomes an error and this
 * file stops building.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from 'dsh-flow/remote';

import type { FlowStartRequest } from 'dsh-flow/types';

declare const ctx: Context;

/**
 * The Remote surface, in the shapes a browser is allowed to use.
 * @returns what a legal caller observes.
 */
export async function legalClientUsage(): Promise<{ status: string | undefined; nodes: number }> {
  const request: FlowStartRequest = { objective: 'ship it' };

  const started = await ctx.remote.flow.start(request);
  const status = started.ok ? started.value.cluster.status : undefined;

  await ctx.remote.flow.control('cluster', 'resume');
  await ctx.remote.flow.read('cluster', { include_events: false });
  await ctx.remote.flow.events('cluster', { since: 0, limit: 200 });
  await ctx.remote.flow.list({ limit: 10 });
  await ctx.remote.flow.report('cluster');

  // The tag on the answer is what narrows the payload.
  const answer = await ctx.remote.flow.query('cluster', 'nodes', { limit: 10 });
  const nodes = answer.ok && answer.value.what === 'nodes' ? answer.value.data.total : 0;

  return { status, nodes };
}

// ---------------------------------------------------------------------------
// Negative assertions. Each one must keep failing to compile.
// ---------------------------------------------------------------------------

// @ts-expect-error a budget dimension is a number, never a string
export const wrongBudget = ctx.remote.flow.start({ objective: 'x', budget: { tokens: 'many' } });

// @ts-expect-error the control vocabulary is closed: 'stop' is not an action
export const wrongControl = ctx.remote.flow.control('cluster', 'stop');

// @ts-expect-error the seven published methods are the whole surface; there is no `settle`
export const leakedSettle = ctx.remote.flow.settle('cluster');

// @ts-expect-error the Host service tree is not part of the Client Context
export const leakedHostService = ctx.flow;