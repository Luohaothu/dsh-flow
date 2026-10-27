import type { AgentProfile } from '../../packages/dsh-flow/src/core/types.js';
import { snapshotProfile } from '../../packages/dsh-flow/src/core/profile.js';
import type { PatternRoleRequirements, PatternRoleValidator } from '../../packages/dsh-flow/src/patterns/types.js';

export class ContractPatternRoleValidator implements PatternRoleValidator {
  constructor(private readonly models: readonly string[] = ['contract/session-model', 'contract/model-a', 'contract/model-b']) {}
  async validate(input: Readonly<AgentProfile>, requirements: PatternRoleRequirements): Promise<void> {
    const profile = snapshotProfile(input);
    if (!this.models.includes(`${profile.model.provider}/${profile.model.id}`)) throw new Error('Unsupported contract model');
    if (requirements.preset !== undefined || requirements.skills !== undefined) throw new Error('Contract preset/skills installation is unsupported');
    for (const key of Object.keys(profile.hostExtras ?? {})) if (key !== 'sandbox') throw new Error(`Unsupported contract extras ${key}`);
    const sandbox = profile.hostExtras?.sandbox;
    if (sandbox !== undefined) {
      if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) throw new TypeError('Contract sandbox must be an object');
      const values = sandbox as Record<string, unknown>;
      if (Object.keys(values).some(key => key !== 'workspace') || typeof values.workspace !== 'string' || !values.workspace.trim()) throw new TypeError('Contract sandbox requires only workspace');
    }
    if (profile.params.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(profile.params.reasoningEffort)) throw new Error('Unsupported contract reasoningEffort');
    if (profile.params.temperature !== undefined && (profile.params.temperature < 0 || profile.params.temperature > 2)) throw new Error('Unsupported contract temperature');
  }
}
