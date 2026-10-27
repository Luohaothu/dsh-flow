import type { PatternDefinition, PatternAssets, PatternParameter, RoleOverride, JsonValue } from './types.js';

export const catalogControl = Symbol('pattern catalog control');
export interface PatternNode { readonly name: string; readonly role: string; readonly count: number | string; readonly children: readonly PatternNode[]; readonly use?: { readonly id: string; readonly with: Readonly<Record<string, JsonValue>> } }
export interface PatternGroup { readonly key: string; readonly members: readonly string[]; readonly forEach?: string }
export interface PatternAst {
  readonly id: string; readonly description: string; readonly whenToUse: string;
  readonly parameters: Readonly<Record<string, PatternParameter>>;
  readonly roles: Readonly<Record<string, RoleOverride>>;
  readonly instructions: string; readonly children: readonly PatternNode[]; readonly groups: readonly PatternGroup[];
  readonly path: string; readonly assets: PatternAssets;
}
export interface CompiledPattern { readonly ast: PatternAst; readonly references: Readonly<Record<string, PatternDefinition>>; readonly digest: string }
const definitions = new WeakMap<PatternDefinition, CompiledPattern>();
export function bindDefinition(definition: PatternDefinition, compiled: CompiledPattern): void { definitions.set(definition, compiled); }
export function compiledPattern(definition: PatternDefinition): CompiledPattern {
  const value = definition && definitions.get(definition);
  if (!value) throw new TypeError('Expected an authentic compiled PatternDefinition');
  return value;
}
export function definitionDigest(definition: PatternDefinition): string { return compiledPattern(definition).digest; }
export class PatternError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'PatternError'; }
}
