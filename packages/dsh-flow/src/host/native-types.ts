import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type { AgentProfile, Context, SessionID } from '../core/index.js';

export interface NativeSkillIdentity {
  readonly name: string;
  readonly identity: string;
  readonly digest: string;
}
export interface NativeRecipe {
  readonly version: 1;
  readonly preset?: { readonly id: string; readonly digest: string };
  readonly skills: readonly NativeSkillIdentity[];
  readonly strategy: { readonly version: 1; readonly digest: string };
}
export interface NativeRunSeed {
  readonly cwd: string;
  readonly preset?: string;
  readonly skills?: readonly string[];
  readonly recipe?: NativeRecipe;
}
export interface NativePlan {
  readonly context: Context;
  readonly profile: Readonly<AgentProfile>;
  readonly config: Readonly<LlmCallConfig>;
  readonly cwd: string;
  readonly recipe: NativeRecipe;
}
export interface NativePlanLease { readonly sessionID: SessionID; dispose(): void }
