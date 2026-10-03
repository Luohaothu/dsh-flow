/**
 * `dsh-flow` — hierarchical agent clusters for a DeepSeek Harness deployment.
 *
 * One plugin instance owns one cluster control plane: the durable database, the
 * management-tree scheduler, the recovery reconciliation and the `ctx.flow`
 * service other plugins and the Remote face consume.
 *
 * Three properties of this entry point are load-bearing:
 *
 *  - **Required dependencies, not polling.** `tools`, `agents`, `agentLoop`,
 *    `sessions` and `sessionPersistence` are declared up front. Cordis holds the
 *    plugin `PENDING` until all five are live, and unloads the whole instance if
 *    one disappears. The previous implementation instead waited for an
 *    `appReady` callback while already published, which meant a plugin that was
 *    ACTIVE and had sent its ready message could still be unable to run a turn.
 *  - **Recovery before publication.** `ctx.provide('flow', runtime)` happens
 *    only after `recoverAndReconcile()` has read the durable sessions and proved
 *    which injections were really admitted. A failure propagates, so the fiber
 *    never becomes ACTIVE on a half-recovered database.
 *  - **No environment, no process, no route.** Deployment parameters arrive as
 *    configuration, never as `FLOW_*` variables; the acceptance IPC bridge lives
 *    in its own module and is mounted only by an acceptance overlay; the
 *    browser talks to the cluster through the standard Remote face.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-loop';
import type {} from '@deepseek-ai/dsh-session-persistence';

import { Config, resolveConfig } from './config.ts';
import type { Config as ConfigInput } from './config.ts';
import { ClusterRuntime } from './core/cluster.ts';
import type { RecoveryOutcome } from './core/cluster.ts';
import type {} from './service.ts';

export { Config };
export type { Config as ConfigInput, ResolvedConfig } from './config.ts';
export type { FlowService } from './service.ts';

/** Cordis identity for the cluster control plane. */
export const name = 'dsh-flow';

/** Every service the cluster needs before it may be considered loaded. */
export const inject = ['tools', 'agents', 'agentLoop', 'sessions', 'sessionPersistence'] as const;

/**
 * Mount the cluster control plane.
 * @param ctx - the deployment context.
 * @param input - the profile row's configuration.
 */
export async function apply(ctx: Context, input: ConfigInput): Promise<void> {
  // The loader validates a row against this schema before the plugin mounts; the
  // call is still made here so the defaults are applied in exactly one place and
  // a hand-mounted composition gets the same resolved values.
  const resolved = resolveConfig(Config(input), { logger: ctx.logger });
  mkdirSync(resolved.dataDir, { recursive: true });

  const runtime = new ClusterRuntime(ctx, {
    dataDir: resolved.dataDir,
    path: join(resolved.dataDir, 'cluster.sqlite'),
    logger: ctx.logger,
    startDefaults: resolved.startDefaults,
    ...resolved.runtime,
  });

  // Cordis defers effect cleanup until an async apply settles. These public
  // lifecycle events arrive before that cleanup, so they must interrupt a held
  // persistence proof independently of the ordered runtime disposer.
  ctx.effect(() => async () => { await runtime.dispose(); }, 'dsh-flow: cluster runtime');
  const fiber = ctx.fiber;
  const interrupt = () => {
    void runtime.dispose().catch(error => ctx.logger.error(error));
  };
  const stopPlugin = ctx.on('internal/plugin', changed => {
    if (changed === fiber && changed.uid === null) interrupt();
  });
  const stopService = ctx.on('internal/service', name => {
    const required = inject.find(required => required === name);
    if (required !== undefined && ctx.get(required) === undefined) interrupt();
  });

  let outcome: RecoveryOutcome;
  try {
    runtime.attachPersistence(ctx.sessionPersistence);
    // No timeout while dependencies remain live: a slow proof is legitimate.
    // Disposal cancels the waits, and the runtime fences non-cancellable late
    // completions before they can read or mutate durable cluster state.
    outcome = await runtime.recoverAndReconcile();
  } finally {
    stopPlugin();
    stopService();
  }
  if (runtime.closed) return;

  if (outcome.recovered.length > 0) {
    ctx.logger?.info?.(`dsh-flow: recovered ${outcome.recovered.length} unfinished cluster(s)`);
  }

  ctx.provide('flow', runtime);
}