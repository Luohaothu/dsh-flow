import type { Context as DshContext } from '@deepseek-ai/cordis';
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type { AgentProfile } from '../core/types.js';
import { snapshotProfile } from '../core/profile.js';
import type { PatternRoleRequirements, PatternRoleValidator } from '../patterns/types.js';

export class DshConfigurationResolver implements PatternRoleValidator {
  constructor(private readonly llm: Pick<DshContext['llm'], 'resolveCallConfig'>) {}
  async validate(profile: Readonly<AgentProfile>, requirements: Readonly<PatternRoleRequirements>): Promise<void> {
    snapshotProfile(profile);
    if (requirements.preset !== undefined) {
      if (typeof requirements.preset !== 'string' || !requirements.preset.trim()) throw new TypeError('preset must be a nonempty string');
      throw new Error('DSH preset installation is unsupported');
    }
    if (requirements.skills !== undefined) {
      if (!Array.isArray(requirements.skills) || requirements.skills.some(skill => typeof skill !== 'string' || !skill.trim())) throw new TypeError('skills must be nonempty strings');
      throw new Error('DSH skill installation is unsupported');
    }
    await this.configuration(profile);
  }
  async configuration(profile: Readonly<AgentProfile>, saved?: LlmCallConfig): Promise<LlmCallConfig> {
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
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('Invalid persisted model configuration');
      for (const key of Object.keys(saved)) if (!fields.some(field => field === key)) throw new TypeError(`Unsupported persisted model parameter ${key}`);
      if (saved.temperature !== undefined && !Number.isFinite(saved.temperature)) throw new TypeError('Invalid persisted temperature');
      if (saved.maxTokens !== undefined && (!Number.isSafeInteger(saved.maxTokens) || saved.maxTokens <= 0)) throw new TypeError('Invalid persisted maxTokens');
      if (saved.reasoningEffort !== undefined && (typeof saved.reasoningEffort !== 'string' || !saved.reasoningEffort.trim())) throw new TypeError('Invalid persisted reasoningEffort');
      if (saved.stop !== undefined && (!Array.isArray(saved.stop) || saved.stop.some(item => typeof item !== 'string'))) throw new TypeError('Invalid persisted stop');
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
