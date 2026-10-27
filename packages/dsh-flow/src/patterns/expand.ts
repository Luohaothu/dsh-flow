import type { AgentProfile } from '../core/types.js';
import type { RunDefaults } from '../run/types.js';
import { snapshotProfile, checkPermission } from '../core/profile.js';
import { sessionID } from '../core/message.js';
import { copyPatternData, freezePatternData } from './data.js';
import { fail, json, object, parameterType, role, variable } from './compiler.js';
import { compiledPattern } from './internal.js';
import type { PatternAst, PatternNode } from './internal.js';
import type { JsonObject, JsonValue, PatternDefinition, PatternExpandedNode, PatternExpansion, PatternExpandedGroup, RoleOverride } from './types.js';

function parametersFor(ast: PatternAst, supplied: JsonObject): JsonObject {
  object(supplied, `${ast.id}.parameters`); json(supplied, `${ast.id}.parameters`); const parameters: JsonObject = Object.create(null);
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(ast.parameters, key)) fail(`${ast.id}.parameters.${key}`, 'Unknown parameter');
  for (const [key, declaration] of Object.entries(ast.parameters)) {
    const value = Object.hasOwn(supplied, key) ? supplied[key] : declaration.default;
    if (value === undefined) fail(`${ast.id}.parameters.${key}`, 'Missing required parameter');
    if (!parameterType(value, declaration.type)) fail(`${ast.id}.parameters.${key}`, `Expected ${declaration.type}`);
    parameters[key] = copyPatternData(value);
  }
  return freezePatternData(parameters);
}
function evaluate(value: JsonValue, ast: PatternAst, parameters: JsonObject): JsonValue {
  const key = variable(value, ast.parameters, `${ast.id}.value`); return key === undefined ? value : parameters[key]!;
}
function countFor(node: PatternNode, ast: PatternAst, parameters: JsonObject): number {
  const count = evaluate(node.count, ast, parameters);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail(`${ast.id}.${node.name}.count`, 'Expected a nonnegative safe integer');
  return count;
}
function useScope(node: PatternNode, definition: PatternDefinition, parameters: JsonObject): { definition: PatternDefinition; parameters: JsonObject } | undefined {
  if (!node.use) return undefined;
  const compiled = compiledPattern(definition); const target = compiled.references[node.use.id]!; const values: JsonObject = Object.create(null);
  for (const [key, value] of Object.entries(node.use.with)) values[key] = evaluate(value, compiled.ast, parameters);
  return { definition: target, parameters: parametersFor(compiledPattern(target).ast, values) };
}
function representable(definition: PatternDefinition, parameters: JsonObject): void {
  const stack = compiledPattern(definition).ast.children.map(node => ({ node, definition, parameters, multiplier: 1 })); let total = 0;
  while (stack.length) {
    const task = stack.pop()!; const ast = compiledPattern(task.definition).ast; const count = countFor(task.node, ast, task.parameters);
    if (count === 0) continue;
    const multiplier = task.multiplier * count; total += multiplier;
    if (!Number.isSafeInteger(multiplier) || !Number.isSafeInteger(total)) fail(`${ast.id}.${task.node.name}.count`, 'Expanded node count exceeds safe integer representability');
    if (total > 2 ** 32 - 1) fail(`${ast.id}.${task.node.name}.count`, 'Expanded node count exceeds array length representability');
    const use = useScope(task.node, task.definition, task.parameters); const scope = use ?? task;
    const children = use ? compiledPattern(use.definition).ast.children : task.node.children;
    for (const node of children) stack.push({ node, definition: scope.definition, parameters: scope.parameters, multiplier });
  }
}
function select(expression: string, templateRoot: string, relativeRoot: string, paths: readonly string[], pathSet: ReadonlySet<string>): string[] {
  const parts = expression.split('/'); const base = parts[0] === 'root' ? templateRoot : relativeRoot; const suffix = parts.slice(1); const absolute = [base, ...suffix].join('/');
  if (!suffix.includes('*')) { if (!pathSet.has(absolute)) fail(expression, `Dangling exact member selector ${absolute}`); return [absolute]; }
  const segments = absolute.split('/');
  return paths.filter(path => { const candidate = path.split('/'); return candidate.length === segments.length && candidate.every((value, i) => segments[i] === '*' ? /^(0|[1-9]\d*)$/.test(value) : segments[i] === value); });
}
export function expandPattern(definition: PatternDefinition, supplied: JsonObject = {}, overrides: Readonly<Record<string, RoleOverride>> = {}, runDefaults: RunDefaults = {}, rootProfile: Readonly<AgentProfile>): PatternExpansion {
  const compiled = compiledPattern(definition); const parameters = parametersFor(compiled.ast, supplied);
  object(overrides, 'overrides'); json(overrides, 'overrides'); object(runDefaults, 'runDefaults'); json(runDefaults, 'runDefaults');
  const parsedOverrides: Record<string, RoleOverride> = Object.create(null);
  for (const [path, override] of Object.entries(overrides)) { if (path === 'root') fail(path, 'The existing root cannot be overridden'); parsedOverrides[path] = role(override, compiled.ast.assets, compiled.ast.path, `overrides.${path}`); }
  representable(definition, parameters);
  const nodes: PatternExpandedNode[] = []; const profiles = new Map<string, Readonly<AgentProfile>>([['root', rootProfile]]); const paths: string[] = [];
  const scopes: { definition: PatternDefinition; root: string }[] = [{ definition, root: 'root' }]; const usedOverrides = new Set<string>();
  interface Task { node: PatternNode; parent: string; definition: PatternDefinition; parameters: JsonObject; index: number; count: number }
  const tasks: Task[] = [];
  const push = (children: readonly PatternNode[], parent: string, def: PatternDefinition, values: JsonObject): void => {
    const ast = compiledPattern(def).ast;
    for (let i = children.length - 1; i >= 0; --i) { const node = children[i]!; const count = countFor(node, ast, values); if (count) tasks.push({ node, parent, definition: def, parameters: values, index: 0, count }); }
  };
  push(compiled.ast.children, 'root', definition, parameters);
  while (tasks.length) {
    const task = tasks.pop()!; const ast = compiledPattern(task.definition).ast; const path = `${task.parent}/${task.node.name}/${task.index}`;
    if (task.index + 1 < task.count) tasks.push({ ...task, index: task.index + 1 });
    const configuredRole = ast.roles[task.node.role]!; const override = parsedOverrides[path]; if (override) usedOverrides.add(path);
    const merged = { ...runDefaults, ...configuredRole, ...override }; const use = useScope(task.node, task.definition, task.parameters);
    const instructions = [merged.instructions ?? task.node.role, use ? compiledPattern(use.definition).ast.instructions : ''].filter(Boolean).join('\n\n');
    const profile = snapshotProfile({ role: instructions, name: merged.name ?? task.node.role, sessionID: sessionID('pattern-expansion'), permission: merged.permission!, model: merged.model!, params: merged.params!, ...(merged.hostExtras === undefined ? {} : { hostExtras: merged.hostExtras }) });
    checkPermission(profile, profiles.get(task.parent)!); const { sessionID: _sessionID, ...config } = profile;
    const requirements = { ...(merged.preset === undefined ? {} : { preset: merged.preset }), ...(merged.skills === undefined ? {} : { skills: [...merged.skills] }) };
    nodes.push({ path, parent: task.parent, config, requirements }); profiles.set(path, profile); paths.push(path);
    if (use) { scopes.push({ definition: use.definition, root: path }); push(compiledPattern(use.definition).ast.children, path, use.definition, use.parameters); }
    else push(task.node.children, path, task.definition, task.parameters);
  }
  for (const path of Object.keys(parsedOverrides)) if (!usedOverrides.has(path)) fail(`overrides.${path}`, 'Override does not name an expanded node');
  const pathSet = new Set(paths); pathSet.add('root'); const groups: PatternExpandedGroup[] = []; const groupKeys = new Set<string>();
  for (const scope of scopes) for (const group of compiledPattern(scope.definition).ast.groups) {
    const starts = group.forEach === undefined ? [scope.root] : select(group.forEach, scope.root, scope.root, paths, pathSet);
    for (const start of starts) {
      const key = `${start}/${group.key}`; if (groupKeys.has(key)) fail(key, 'Duplicate expanded group key'); groupKeys.add(key);
      const members = [...new Set(group.members.flatMap(member => select(member, scope.root, start, paths, pathSet)))];
      groups.push({ key, members });
    }
  }
  return freezePatternData({ nodes, groups, instructions: compiled.ast.instructions });
}
