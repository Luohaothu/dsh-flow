/** Resolve one team's model choices from a single current configuration snapshot. */
import type { AgentRecord, FlowModelSelection, NodeScope } from './model.ts';

export function prepareModelSelection(
  defaults: FlowModelSelection,
  scope: Pick<NodeScope, 'team_model' | 'team_model_options'> | null | undefined,
  workerMaxTokens?: number,
): (agent: Pick<AgentRecord, 'role' | 'meta'>) => FlowModelSelection {
  const route = scope?.team_model;
  const shared = { ...(route ? { maxTokens: defaults.maxTokens, ...route } : defaults), ...(scope?.team_model_options ?? {}) };
  const cap = Number(workerMaxTokens) || null;
  return agent => {
    const selected = { ...shared, ...(agent.meta?.model ?? {}) };
    // Management keeps its configured output budget; only Workers have this cap.
    return cap && agent.role === 'worker'
      ? { ...selected, maxTokens: Math.min(selected.maxTokens ?? cap, cap) }
      : selected;
  };
}
