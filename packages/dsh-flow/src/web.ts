/** Read-only team projections; native Session APIs own conversation transport. */
import { Service, type Context } from '@deepseek-ai/cordis';
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import type {} from './service.ts';
import type { FlowTeamRun, FlowAgentSession, FlowTeamSnapshot } from './types.ts';

declare module '@deepseek-ai/cordis' { interface Context { flowRemote: FlowRemote } }
export const name = 'dsh-flow-web';
export const inject = ['flow'];
export class FlowRemote extends Service {
  readonly typertRemote = bindTypertRemote(this, 'flowRemote', { namespace: 'flow' });
  constructor(ctx: Context) { super(ctx, 'flowRemote'); }
  @Remote
  teamRuns(sessionId: string, signal: AbortSignal): readonly FlowTeamRun[] {
    signal.throwIfAborted();
    return this.ctx.flow.teamRuns(sessionId);
  }
  @Remote
  agentSession(sessionId: string, signal: AbortSignal): FlowAgentSession | null {
    signal.throwIfAborted();
    return this.ctx.flow.agentSession(sessionId);
  }
  @Remote
  teamRead(sessionId: string, teamId: string, signal: AbortSignal): FlowTeamSnapshot {
    signal.throwIfAborted();
    return this.ctx.flow.teamRead(sessionId, teamId);
  }
}
export function apply(ctx: Context): void { new FlowRemote(ctx); }
