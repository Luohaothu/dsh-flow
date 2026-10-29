import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { copyPatternData, freezePatternData, stringifyPatternData } from './data.js';
import { bindDefinition, compiledPattern, PatternError } from './internal.js';
import type { PatternAst, PatternNode, PatternGroup } from './internal.js';
import type { JsonValue, PatternAssets, PatternDefinition, PatternDocument, PatternParameter, PatternParameterType, RoleOverride } from './types.js';

export function fail(path: string, message: string): never { throw new PatternError(path, message); }
export function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'Expected a plain object');
}
export function text(value: unknown, path: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) fail(path, 'Expected a nonempty string'); }
export function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'Unknown field'); }
export function json(value: unknown, path: string): void {
  const active = new Set<object>();
  const stack: { value: unknown; path: string; exit?: boolean }[] = [{ value, path }];
  while (stack.length) {
    const item = stack.pop()!; const v = item.value;
    if (item.exit) { active.delete(v as object); continue; }
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) continue;
    if (!v || typeof v !== 'object') fail(item.path, 'Expected a finite JSON value');
    if (active.has(v)) fail(item.path, 'Cyclic values and YAML aliases are not allowed');
    if (!Array.isArray(v)) object(v, item.path);
    else if (Object.keys(v).length !== v.length || Object.keys(v).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length)) fail(item.path, 'Expected a dense JSON array without extra properties');
    active.add(v); stack.push({ ...item, exit: true });
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || !d.enumerable || !('value' in d)) fail(item.path, 'Expected JSON data properties');
      stack.push({ value: d.value, path: `${item.path}.${key}` });
    }
  }
}
export function packagePath(path: string): string {
  const normalized = posix.normalize(path);
  if (!path || path.includes('\\') || posix.isAbsolute(path) || /^[a-zA-Z]:/.test(path) || normalized === '..' || normalized.startsWith('../') || path.includes('\0')) fail(path, 'Expected a package-relative path without traversal');
  return normalized;
}
function parse(document: PatternDocument): { value: Record<string, unknown>; path: string } {
  if (typeof document !== 'string') {
    object(document, 'document');
    if (document.kind !== 'yaml' && document.kind !== 'object') fail('document.kind', 'Expected yaml or object');
    keys(document, document.kind === 'yaml' ? ['kind', 'text', 'path'] : ['kind', 'value', 'path'], 'document');
    if (Object.hasOwn(document, 'path') && typeof document.path !== 'string') fail('document.path', 'Expected a package-relative path string');
    if (document.kind === 'yaml') {
      if (typeof document.text !== 'string') fail('document.text', 'Expected YAML text');
    } else object(document.value, 'document.value');
  }
  const path = packagePath(typeof document === 'string' ? 'pattern.yaml' : document.path ?? 'pattern.yaml');
  let value: unknown;
  if (typeof document !== 'string' && document.kind === 'object') value = document.value;
  else {
    const content = typeof document === 'string' ? document : document.text;
    const doc = parseDocument(content, { uniqueKeys: true, strict: true });
    if (doc.errors.length) fail(path, doc.errors.map(e => e.message).join('; '));
    if (doc.warnings.some(warning => warning.code === 'TAG_RESOLVE_FAILED')) fail(path, 'Unsupported YAML tag');
    const stack: unknown[] = [doc.contents];
    while (stack.length) {
      const node = stack.pop();
      if (isAlias(node)) fail(path, 'YAML aliases are not supported');
      if (isMap(node)) for (const pair of node.items) {
        if (isAlias(pair.key)) fail(path, 'YAML aliases are not supported');
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail(path, 'YAML mapping keys must be strings');
        stack.push(pair.value);
      }
      else if (isSeq(node)) stack.push(...node.items);
    }
    try { value = doc.toJS(); } catch (error) { fail(path, String(error)); }
  }
  json(value, path); object(value, path);
  return { value: copyPatternData(value), path };
}
export function parameterType(value: JsonValue, type: PatternParameterType): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}
const types: readonly string[] = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'];
const roleKeys = ['instructions', 'name', 'preset', 'skills', 'model', 'params', 'permission', 'hostExtras'];
export function instruction(value: unknown, assets: PatternAssets, documentPath: string, path: string): string {
  if (typeof value === 'string') return value;
  object(value, path); keys(value, ['file'], path); text(value.file, `${path}.file`);
  const relative = packagePath(value.file);
  const file = posix.join(posix.dirname(documentPath), relative);
  if (!Object.hasOwn(assets, file)) fail(path, `Missing package resource ${file}`);
  return assets[file]!;
}
export function role(value: unknown, assets: PatternAssets, documentPath: string, path: string): RoleOverride {
  object(value, path); keys(value, roleKeys, path);
  const result = { ...value };
  if (Object.hasOwn(result, 'instructions')) result.instructions = instruction(result.instructions, assets, documentPath, `${path}.instructions`);
  for (const field of ['name', 'preset']) if (Object.hasOwn(result, field)) text(result[field], `${path}.${field}`);
  if (Object.hasOwn(result, 'skills') && (!Array.isArray(result.skills) || result.skills.some(v => typeof v !== 'string' || !v.trim()))) fail(`${path}.skills`, 'Expected skill names');
  if (Object.hasOwn(result, 'permission') && !['read-only', 'workspace-write', 'full-access'].includes(result.permission as string)) fail(`${path}.permission`, 'Unknown initial permission');
  if (Object.hasOwn(result, 'model')) { object(result.model, `${path}.model`); keys(result.model, ['provider', 'id'], `${path}.model`); text(result.model.provider, `${path}.model.provider`); text(result.model.id, `${path}.model.id`); }
  if (Object.hasOwn(result, 'params')) {
    object(result.params, `${path}.params`); keys(result.params, ['version', 'temperature', 'reasoningEffort', 'maxTokens'], `${path}.params`);
    if (result.params.version !== 1) fail(`${path}.params.version`, 'Expected reasoning params version 1');
    if (result.params.temperature !== undefined && (typeof result.params.temperature !== 'number' || !Number.isFinite(result.params.temperature))) fail(`${path}.params.temperature`, 'Expected a finite number');
    if (result.params.reasoningEffort !== undefined) text(result.params.reasoningEffort, `${path}.params.reasoningEffort`);
    if (result.params.maxTokens !== undefined && (!Number.isSafeInteger(result.params.maxTokens) || (result.params.maxTokens as number) <= 0)) fail(`${path}.params.maxTokens`, 'Expected a positive safe integer');
  }
  if (Object.hasOwn(result, 'hostExtras')) object(result.hostExtras, `${path}.hostExtras`);
  json(result, path);
  return result as RoleOverride;
}
const reserved = ['instructions', 'role', 'count', 'use'];
function name(value: string, path: string, nodeName = true): void { if (!value.trim() || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('*') || value.includes('\0') || (nodeName && reserved.includes(value))) fail(path, 'Ambiguous or reserved path name'); }
export function variable(value: JsonValue, parameters: Readonly<Record<string, PatternParameter>>, path: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
  if (!match) { if (value.includes('{{') || value.includes('}}')) fail(path, 'Only pure parameter placeholders are supported'); return undefined; }
  const key = match[1]!.trim();
  if (!Object.hasOwn(parameters, key)) fail(path, `Unknown parameter ${key}`);
  return key;
}
export function selector(value: unknown, path: string): asserts value is string {
  text(value, path);
  const parts = value.split('/');
  if (!['root', '.'].includes(parts[0]!)) fail(path, 'Selector must start with root or .');
  if (parts.length % 2 !== 1) fail(path, 'Selector requires name/index pairs');
  for (let i = 1; i < parts.length; i += 2) { name(parts[i]!, path); if (parts[i + 1] !== '*' && !/^(0|[1-9]\d*)$/.test(parts[i + 1]!)) fail(path, 'Selector index must be a nonnegative integer or *'); }
}
export function parseAst(document: PatternDocument, inputAssets: PatternAssets): PatternAst {
  object(inputAssets, 'assets'); const assets: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(inputAssets)) { const normalized = packagePath(key); if (typeof value !== 'string') fail(`assets.${key}`, 'Expected text resource'); if (Object.hasOwn(assets, normalized)) fail(key, 'Duplicate resource path'); assets[normalized] = value; }
  const { value, path } = parse(document);
  keys(value, ['apiVersion', 'id', 'description', 'whenToUse', 'parameters', 'roles', 'root', 'groups'], path);
  if (value.apiVersion !== 'v1') fail(`${path}.apiVersion`, 'Expected v1');
  text(value.id, `${path}.id`); if (!/^[^/\s]+\/.+/.test(value.id)) fail(`${path}.id`, 'Expected a namespaced template id');
  text(value.description, `${path}.description`); text(value.whenToUse, `${path}.whenToUse`);
  object(value.parameters === undefined ? {} : value.parameters, `${path}.parameters`);
  const parameters: Record<string, PatternParameter> = Object.create(null);
  for (const [key, p] of Object.entries(value.parameters ?? {})) {
    object(p, `${path}.parameters.${key}`); keys(p, ['type', 'description', 'default'], `${path}.parameters.${key}`);
    if (!types.includes(p.type as string)) fail(`${path}.parameters.${key}.type`, 'Unknown parameter type');
    text(p.description, `${path}.parameters.${key}.description`);
    if (Object.hasOwn(p, 'default') && !parameterType(p.default as JsonValue, p.type as PatternParameterType)) fail(`${path}.parameters.${key}.default`, 'Default does not match parameter type');
    parameters[key] = p as unknown as PatternParameter;
  }
  object(value.roles === undefined ? {} : value.roles, `${path}.roles`); const roles: Record<string, RoleOverride> = Object.create(null);
  for (const [key, r] of Object.entries(value.roles ?? {})) roles[key] = role(r, assets, path, `${path}.roles.${key}`);
  object(value.root, `${path}.root`);
  const instructions = value.root.instructions === undefined ? '' : instruction(value.root.instructions, assets, path, `${path}.root.instructions`);
  const children: PatternNode[] = [];
  const tasks: { source: Record<string, unknown>; target: PatternNode[]; path: string; root?: boolean }[] = [{ source: value.root, target: children, path: `${path}.root`, root: true }];
  while (tasks.length) {
    const task = tasks.pop()!;
    for (const [key, entry] of Object.entries(task.source)) {
      if (task.root && key === 'instructions') continue;
      if (!task.root && ['role', 'count', 'use'].includes(key)) continue;
      name(key, `${task.path}.${key}`); object(entry, `${task.path}.${key}`); text(entry.role, `${task.path}.${key}.role`);
      if (!Object.hasOwn(roles, entry.role)) fail(`${task.path}.${key}.role`, `Unknown role ${entry.role}`);
      const count = entry.count === undefined ? 1 : entry.count; json(count, `${task.path}.${key}.count`);
      const parameter = variable(count as JsonValue, parameters, `${task.path}.${key}.count`);
      if (parameter ? !['integer', 'number'].includes(parameters[parameter]!.type) : typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail(`${task.path}.${key}.count`, 'Count must be a nonnegative safe integer or numeric parameter');
      const nested: PatternNode[] = [];
      let use: PatternNode['use'];
      if (entry.use !== undefined) {
        object(entry.use, `${task.path}.${key}.use`); keys(entry.use, ['id', 'with'], `${task.path}.${key}.use`); text(entry.use.id, `${task.path}.${key}.use.id`); object(entry.use.with === undefined ? {} : entry.use.with, `${task.path}.${key}.use.with`);
        for (const [k, v] of Object.entries(entry.use.with ?? {})) variable(v as JsonValue, parameters, `${task.path}.${key}.use.with.${k}`);
        use = { id: entry.use.id, with: (entry.use.with ?? {}) as Record<string, JsonValue> };
        if (Object.keys(entry).some(k => !['role', 'count', 'use'].includes(k))) fail(`${task.path}.${key}`, 'use and inline children are mutually exclusive');
      }
      task.target.push({ name: key, role: entry.role, count: count as number | string, children: nested, ...(use ? { use } : {}) });
      if (!use) tasks.push({ source: entry, target: nested, path: `${task.path}.${key}` });
    }
  }
  const groups: PatternGroup[] = []; const groupKeys = new Set<string>();
  if (value.groups !== undefined && !Array.isArray(value.groups)) fail(`${path}.groups`, 'Expected an array');
  for (const [index, g] of ((value.groups ?? []) as unknown[]).entries()) {
    const at = `${path}.groups.${index}`; object(g, at); keys(g, ['key', 'members', 'forEach'], at); text(g.key, `${at}.key`); name(g.key, `${at}.key`, false);
    if (groupKeys.has(g.key)) fail(`${at}.key`, 'Duplicate group key'); groupKeys.add(g.key);
    if (!Array.isArray(g.members)) fail(`${at}.members`, 'Expected selectors');
    for (const s of g.members) selector(s, `${at}.members`);
    if (g.forEach !== undefined) selector(g.forEach, `${at}.forEach`);
    groups.push({ key: g.key, members: g.members as string[], ...(g.forEach === undefined ? {} : { forEach: g.forEach as string }) });
  }
  return freezePatternData({ id: value.id, description: value.description, whenToUse: value.whenToUse, parameters, roles, instructions, children, groups, path, assets });
}
export function dependencies(ast: PatternAst): Set<string> {
  const result = new Set<string>(); const stack = [...ast.children];
  while (stack.length) { const node = stack.pop()!; if (node.use) result.add(node.use.id); stack.push(...node.children); }
  return result;
}
function validateBindings(ast: PatternAst, references: Readonly<Record<string, PatternDefinition>>): void {
  const stack = [...ast.children];
  while (stack.length) {
    const node = stack.pop()!; stack.push(...node.children); if (!node.use) continue;
    const target = compiledPattern(references[node.use.id]!).ast;
    for (const [key, value] of Object.entries(node.use.with)) {
      const declaration = target.parameters[key]; if (!declaration) fail(`${ast.path}.use.with.${key}`, `Unknown parameter for ${target.id}`);
      const parameter = variable(value, ast.parameters, `${ast.path}.use.with.${key}`);
      if (parameter) { const sourceType = ast.parameters[parameter]!.type; if (sourceType !== declaration.type && !(['integer', 'number'].includes(sourceType) && ['integer', 'number'].includes(declaration.type))) fail(`${ast.path}.use.with.${key}`, 'Forwarded parameter type does not match'); }
      else if (!parameterType(value, declaration.type)) fail(`${ast.path}.use.with.${key}`, 'Value does not match referenced parameter type');
    }
    for (const [key, declaration] of Object.entries(target.parameters)) if (!Object.hasOwn(node.use.with, key) && !Object.hasOwn(declaration, 'default')) fail(`${ast.path}.use.with.${key}`, `Missing required parameter for ${target.id}`);
  }
}
export function compileAsts(asts: readonly PatternAst[], existing: ReadonlyMap<string, PatternDefinition>): Map<string, PatternDefinition> {
  const byId = new Map<string, PatternAst>();
  for (const ast of asts) { if (byId.has(ast.id)) fail(ast.path, `Duplicate template id ${ast.id}`); byId.set(ast.id, ast); }
  const completed = new Map<string, PatternDefinition>(); const active = new Set<string>();
  for (const ast of asts) {
    const stack: { ast: PatternAst; exit?: boolean }[] = [{ ast }];
    while (stack.length) {
      const task = stack.pop()!; if (completed.has(task.ast.id)) continue;
      if (!task.exit) {
        if (active.has(task.ast.id)) fail(task.ast.path, `Template reference cycle at ${task.ast.id}`);
        active.add(task.ast.id); stack.push({ ...task, exit: true });
        for (const id of dependencies(task.ast)) { const dependency = byId.get(id); if (dependency) stack.push({ ast: dependency }); else if (!existing.has(id)) fail(task.ast.path, `Unknown referenced template ${id}`); }
      } else {
        const references: Record<string, PatternDefinition> = Object.create(null);
        for (const id of dependencies(task.ast)) references[id] = completed.get(id) ?? existing.get(id)!;
        validateBindings(task.ast, references);
        const digest = createHash('sha256').update(stringifyPatternData([task.ast, Object.entries(references).map(([id, def]) => [id, compiledPattern(def).digest])])).digest('hex');
        const definition = freezePatternData({ id: task.ast.id, description: task.ast.description, whenToUse: task.ast.whenToUse, parameters: task.ast.parameters }) as PatternDefinition;
        bindDefinition(definition, freezePatternData({ ast: task.ast, references, digest })); completed.set(task.ast.id, definition); active.delete(task.ast.id);
      }
    }
  }
  return completed;
}
