/** Follow the host's public durable model-selection precedence. */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import type { FlowModelSelection } from './core/model.ts';

export function mainModel(ctx: Context, session: Session): FlowModelSelection {
  const picked = ctx.sessionProjections.stateOf(session, 'modelSelection')?.pending;
  if (picked) return { provider: picked.provider, model: picked.model,
    ...(picked.reasoningEffort === undefined ? {} : { reasoningEffort: picked.reasoningEffort }) };
  const header = session.requestHeader();
  if (!header) {
    const selected = ctx.agentDefaultModel.currentSelection();
    return { provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
  }
  return { provider: header.config.provider, model: header.config.model,
    ...(header.adapterDefaults?.reasoningEffort === true || header.config.reasoningEffort === undefined ? {} : { reasoningEffort: header.config.reasoningEffort }) };
}
