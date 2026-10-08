/** Resolve one team's model choices from a single current configuration snapshot. */
import type { AgentRecord, FlowModelSelection, NodeScope } from './model.ts';
import { fail } from '../errors.ts';
import { textField } from '../validation.ts';

/** Validate the complete Flow model selection; adapter execution controls belong to DSH. */
export function validateModelSelection(input: unknown, label = 'model selection'): FlowModelSelection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(`Invalid ${label}: expected an object`);
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!['provider', 'model', 'reasoningEffort'].includes(key)) fail(`Unsupported ${label} field: ${key}`);
  }
  return {
    ...(fields.provider === undefined ? {} : { provider: textField(fields.provider, `${label}.provider`, 512) }),
    ...(fields.model === undefined ? {} : { model: textField(fields.model, `${label}.model`, 512) }),
    ...(fields.reasoningEffort === undefined ? {} : { reasoningEffort: textField(fields.reasoningEffort, `${label}.reasoningEffort`, 128) }),
  };
}

export function prepareModelSelection(
  defaults: FlowModelSelection,
  scope: Pick<NodeScope, 'team_model' | 'team_model_options'> | null | undefined,
): (agent: Pick<AgentRecord, 'role' | 'meta'>) => FlowModelSelection {
  const fallback = validateModelSelection(defaults, 'model defaults');
  const base = scope?.team_model === undefined ? fallback : validateModelSelection(scope.team_model, 'team model');
  const shared = { ...base, ...validateModelSelection(scope?.team_model_options ?? {}, 'team model options') };
  return agent => ({ ...shared, ...validateModelSelection(agent.meta?.model ?? {}, 'identity model') });
}
