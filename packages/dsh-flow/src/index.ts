/** Standard native Agents; Flow owns only collaboration records and handles. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { resolveConfig, type Config as ConfigInput } from './config.ts';
import { FlowController } from './core/controller.ts';
import { registerMemberTools } from './core/member-tools.ts';
import type {} from './service.ts';
export { Config } from './config.ts';
export type { Config as ConfigInput, ResolvedConfig } from './config.ts';
export type { FlowService } from './service.ts';
export const name = 'dsh-flow';
export const inject = ['tools', 'agents', 'agentPresets', 'agentDefaultModel', 'sessionProjections', 'sessions', 'sessionPersistence', 'systemPrompt', 'skills'] as const;
export async function apply(ctx: Context, input: ConfigInput): Promise<void> {
  const runtime = new FlowController(ctx, resolveConfig(input));
  ctx.effect(() => () => runtime.dispose(), 'dsh-flow: collaboration owner');
  await runtime.recover();
  if (runtime.closed) return;
  ctx.provide('flow', runtime);
  // A main conversation uses the same collaboration operations as a member.
  registerMemberTools(ctx, runtime);
  ctx.inject(['sessionController'], child => {
    child.effect(() => child.sessionController.registerSessionDriver({
      owns: sessionId => runtime.isTeamAgentSession(sessionId),
      resolveAgent: sessionId => runtime.ensureAgent(sessionId),
    }), 'dsh-flow: native Agent owner lookup');
    child.effect(() => child.sessionController.registerSessionOrigin(sessionId =>
      runtime.isTeamAgentSession(sessionId) ? 'subagent' : undefined), 'dsh-flow: session origin');
  });
}
