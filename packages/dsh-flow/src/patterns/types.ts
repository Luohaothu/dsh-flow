import type { AgentProfile } from '../core/types.js';
import type { JsonObject, JsonValue } from '../assignments/types.js';
export type { JsonValue, JsonObject } from '../assignments/types.js';

export type PatternParameterType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';
export interface PatternParameter { readonly type: PatternParameterType; readonly description: string; readonly default?: JsonValue }
export type PatternDocument = string | { readonly kind: 'yaml'; readonly text: string; readonly path?: string } | { readonly kind: 'object'; readonly value: JsonObject; readonly path?: string };
export type PatternAssets = Readonly<Record<string, string>>;
export type PatternSource = { readonly directory: string } | { readonly document: PatternDocument; readonly assets?: PatternAssets };
export interface PatternCatalogOptions { readonly includeBuiltins?: boolean; readonly builtinDirectory?: string; readonly sources?: readonly PatternSource[] }
export interface PatternDiagnostic { readonly path: string; readonly message: string }
declare const compiledIdentity: unique symbol;
export interface PatternSummary { readonly id: string; readonly description: string; readonly whenToUse: string; readonly parameters: Readonly<Record<string, PatternParameter>> }
export interface PatternDefinition extends PatternSummary { readonly [compiledIdentity]: true }
export type PatternFailure = { readonly ok: false; readonly diagnostics: readonly PatternDiagnostic[] };
export type PatternCompileResult = { readonly ok: true; readonly definition: PatternDefinition } | PatternFailure;
export type PatternResolveResult = PatternCompileResult;
export type PatternCatalogListResult = { readonly ok: true; readonly patterns: readonly PatternSummary[]; readonly diagnostics: readonly PatternDiagnostic[] } | PatternFailure;
export type PatternInstructions = string | { readonly file: string };
export interface RoleOverride {
  readonly instructions?: PatternInstructions;
  readonly name?: string;
  readonly preset?: string;
  readonly skills?: readonly string[];
  readonly model?: AgentProfile['model'];
  readonly params?: AgentProfile['params'];
  readonly permission?: AgentProfile['permission'];
  readonly hostExtras?: AgentProfile['hostExtras'];
}
export interface PatternApplyRequest { readonly definition: PatternDefinition; readonly parameters?: JsonObject; readonly overrides?: Readonly<Record<string, RoleOverride>> }
export interface PatternRoleRequirements { readonly preset?: string; readonly skills?: readonly string[] }
export interface PatternRoleValidator { validate(profile: Readonly<AgentProfile>, requirements: PatternRoleRequirements): Promise<void> }
export type PatternNodeConfig = Omit<AgentProfile, 'sessionID'>;
export interface PatternExpandedNode { readonly path: string; readonly parent: string; readonly config: Readonly<PatternNodeConfig>; readonly requirements: PatternRoleRequirements }
export interface PatternExpandedGroup { readonly key: string; readonly members: readonly string[] }
export interface PatternExpansion { readonly nodes: readonly PatternExpandedNode[]; readonly groups: readonly PatternExpandedGroup[]; readonly instructions: string }
