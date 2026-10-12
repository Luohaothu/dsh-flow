import assert from 'node:assert/strict';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Current oMLX schema: model overrides live under models, not at the root. */
export function snapshotRecipe(modelConfig: unknown, serverConfig: unknown, model: string) {
  assert(object(modelConfig) && object(modelConfig.models), 'oMLX model settings must contain a models dictionary');
  const entry = modelConfig.models[model];
  assert(object(entry) && Object.keys(entry).length > 0, `Missing oMLX settings for ${model}; an empty snapshot cannot establish comparability`);
  assert(object(serverConfig), 'Missing oMLX server settings');
  const global: Record<string, unknown> = {};
  for (const key of ['memory', 'scheduler', 'sampling', 'cache']) if (serverConfig[key] !== undefined) global[key] = serverConfig[key];
  assert(object(global.memory) && object(global.scheduler), 'Need memory and scheduler settings to record the execution recipe');
  return structuredClone({ schema_version: modelConfig.version, model, settings: entry, global });
}
