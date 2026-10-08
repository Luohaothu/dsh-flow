import { fail } from './errors.ts';
/**
 * Hierarchical agent clusters for a DeepSeek Harness deployment.
 *
 * One plugin instance owns the durable database, management-tree scheduler,
 * recovery reconciliation and `ctx.flow` service. Cordis waits for all required
 * dependencies and unloads the instance when any disappears. Recovery proves
 * durable session admission before the service is published.
 *
 * Deployment parameters arrive through configuration. The acceptance IPC bridge
 * is mounted separately; browser clients use the generated Remote interface.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-loop';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-api-session-controller';

import { Config, resolveConfig } from './config.ts';
import type { Config as ConfigInput, ResolvedConfig } from './config.ts';
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
function isResolved(input:ConfigInput | ResolvedConfig):input is ResolvedConfig {
  return typeof input.defaultBudget==='object'&&input.defaultBudget!==null&&'get' in input.defaultBudget;
}
export async function apply(ctx: Context, input: ConfigInput | ResolvedConfig): Promise<void> {
  // The loader supplies live Volatile references. Preserve them so native
  // configuration edits reach future starts without restarting the controller.
  // Direct compositions may still pass a raw row through the same schema.
  const resolved = resolveConfig(isResolved(input)?input:Config(input), { logger: ctx.logger });
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
  // Flow owns independent native sessions outside the host subagent catalog.
  // The host API classifies list summaries without changing their raw headers or
  // their independent observation and continuation policy.
  ctx.inject(['sessionController'], (child) => {
    child.effect(() => child.sessionController.registerSessionDriver({
      owns:id => !runtime.closed && runtime.isTeamAgentSession(id),
      async prompt(request,signal) {
        signal.throwIfAborted();
        if (request.content.some(part=>part.type !== 'text')) fail('智能体会话当前支持文本消息，请在主会话提供附件',400);
        const text=request.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n');
        runtime.promptAgent(request.sessionId,request.requestId,text,request.clientTimeZone,request.mode);
        return {accepted:true};
      },
      cancel(request) { runtime.interruptAgent(request.sessionId);return {accepted:true}; },
    }), 'dsh-flow: native session execution driver');
    child.effect(() => child.sessionController.registerSessionOrigin(id =>
      !runtime.closed && runtime.store.getAgentBySession(id) ? 'subagent' : undefined), 'dsh-flow: internal session classification');
  });
}
