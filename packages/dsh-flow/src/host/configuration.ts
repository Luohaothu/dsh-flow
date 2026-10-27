import type { Context as DshContext } from '@deepseek-ai/cordis';
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type { AgentProfile } from '../core/types.js';
import { snapshotProfile } from '../core/profile.js';

export function decodeModelConfiguration(value: unknown): LlmCallConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid persisted model configuration');
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const fields = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'];
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new TypeError(`Unsupported persisted model parameter ${key}`);
  if (typeof input.provider !== 'string' || !input.provider.trim() || typeof input.model !== 'string' || !input.model.trim()) throw new TypeError('Invalid persisted model route');
  if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== 'string' || !input.reasoningEffort.trim())) throw new TypeError('Invalid persisted reasoningEffort');
  if (input.temperature !== undefined && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature))) throw new TypeError('Invalid persisted temperature');
  if (input.maxTokens !== undefined && (typeof input.maxTokens !== 'number' || !Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0)) throw new TypeError('Invalid persisted maxTokens');
  const stop: string[] = [];
  if (input.stop !== undefined) {
    if (!Array.isArray(input.stop)) throw new TypeError('Invalid persisted stop');
    for (const item of input.stop) { if (typeof item !== 'string') throw new TypeError('Invalid persisted stop'); stop.push(item); }
  }
  return { provider: input.provider, model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(input.reasoningEffort) }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(input.stop === undefined ? {} : { stop }) };
}

export class DshConfigurationResolver {
  constructor(private readonly llm: Pick<DshContext['llm'], 'resolveCallConfig'>) {}
  async configuration(profile: Readonly<AgentProfile>, saved?: LlmCallConfig): Promise<LlmCallConfig> {
    snapshotProfile(profile);
    for (const key of Object.keys(profile.hostExtras ?? {})) if (key !== 'dsh') throw new TypeError(`Unsupported HostExtras field ${key}`);
    const extras = profile.hostExtras?.dsh;
    if (extras !== undefined && (typeof extras !== 'object' || extras === null || Array.isArray(extras))) throw new TypeError('DSH extras must be an object');
    const dsh = (extras ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(dsh)) if (key !== 'stop') throw new TypeError(`Unsupported DSH model parameter ${key}`);
    if (dsh.stop !== undefined && (!Array.isArray(dsh.stop) || dsh.stop.some(item => typeof item !== 'string'))) throw new TypeError('DSH stop must be a string array');
    const declared: LlmCallConfig = { provider: profile.model.provider, model: profile.model.id,
      ...(profile.params.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(profile.params.reasoningEffort) }),
      ...(profile.params.temperature === undefined ? {} : { temperature: profile.params.temperature }),
      ...(profile.params.maxTokens === undefined ? {} : { maxTokens: profile.params.maxTokens }),
      ...(dsh.stop === undefined ? {} : { stop: [...dsh.stop as string[]] }) };
    const fields = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'] as const;
    if (saved !== undefined) {
      saved = decodeModelConfiguration(saved);
      for (const key of fields) {
        if (declared[key] !== undefined && JSON.stringify(saved[key]) !== JSON.stringify(declared[key])) throw new Error(`Persisted ${key} differs from Profile`);
      }
    }
    const config = saved === undefined ? declared : structuredClone(saved);
    const resolved = await this.llm.resolveCallConfig(config);
    for (const key of fields) {
      if ((saved !== undefined || config[key] !== undefined) && JSON.stringify(config[key]) !== JSON.stringify(resolved[key])) throw new Error(`DSH cannot honor ${key}`);
    }
    return saved === undefined ? resolved : config;
  }
}
