/** Follow the host's public durable model-selection precedence. */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { FlowModelSelection } from './core/model.ts';

export function mainModel(ctx: Context, session: Session): FlowModelSelection {
  const picked = ctx.sessionProjections.stateOf(session, 'modelSelection')?.pending;
  if (picked) return { ...picked };
  const header = session.requestHeader();
  if (!header) return { ...ctx.agentDefaultModel.currentSelection() };
  return { provider: header.config.provider, model: header.config.model,
    ...(header.adapterDefaults?.reasoningEffort === true || header.config.reasoningEffort === undefined ? {} : { reasoningEffort: header.config.reasoningEffort }) };
}
