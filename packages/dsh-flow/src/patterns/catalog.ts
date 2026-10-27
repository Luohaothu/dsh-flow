import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { freezeData } from '../core/snapshot-data.js';
import { compileAsts, dependencies, fail, packagePath, parseAst } from './compiler.js';
import { catalogControl, compiledPattern, PatternError } from './internal.js';
import type { PatternAst } from './internal.js';
import type { PatternAssets, PatternCatalogListResult, PatternCatalogOptions, PatternCompileResult, PatternDefinition, PatternDiagnostic, PatternDocument, PatternFailure, PatternResolveResult, PatternSource } from './types.js';

interface CatalogState { readonly definitions: Map<string, PatternDefinition>; readonly diagnostics: readonly PatternDiagnostic[] }
const catalogs = new WeakMap<PatternCatalog, CatalogState>();
function state(catalog: PatternCatalog): CatalogState { const value = catalogs.get(catalog); if (!value) throw new TypeError('Invalid PatternCatalog'); return value; }
function failure(error: unknown): PatternFailure { return freezeData({ ok: false, diagnostics: [{ path: error instanceof PatternError ? error.path : 'pattern', message: error instanceof Error ? error.message : String(error) }] }); }
function contained(root: string, target: string): void { const rel = relative(root, target); if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) fail(target, 'Package resource escapes its real package root'); }
function loadPackage(directory: string): { document: PatternDocument; assets: PatternAssets } {
  const root = realpathSync(directory); const assets: Record<string, string> = Object.create(null); const stack = [root]; const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!; const actual = realpathSync(current); contained(root, actual);
    if (visited.has(actual)) fail(current, 'Cyclic or aliased package directories'); visited.add(actual);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name); const actualFile = realpathSync(file); contained(root, actualFile);
      const stat = statSync(file);
      if (stat.isDirectory()) stack.push(file);
      else if (stat.isFile()) assets[relative(root, file).split(sep).join('/')] = readFileSync(file, 'utf8');
      else fail(file, 'Package resources must be ordinary files');
    }
  }
  if (!Object.hasOwn(assets, 'pattern.yaml')) fail(directory, 'Missing pattern.yaml');
  return { document: { kind: 'yaml', text: assets['pattern.yaml']!, path: 'pattern.yaml' }, assets };
}
function loadDirectory(directory: string, diagnostics: PatternDiagnostic[]): { document: PatternDocument; assets: PatternAssets }[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => entry.name === 'pattern.yaml')) return [loadPackage(directory)];
  const root = realpathSync(directory); const sources = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(directory, entry.name);
    try { contained(root, realpathSync(child)); if (!statSync(child).isDirectory()) fail(child, 'Pattern directory must contain packages'); sources.push(loadPackage(child)); }
    catch (error) { diagnostics.push(...failure(error).diagnostics); }
  }
  return sources;
}
function sourceAsts(source: Exclude<PatternSource, { directory: string }>): PatternAst[] {
  const ast = parseAst(source.document, source.assets ?? {}); const result = [ast];
  for (const [path, text] of Object.entries(source.assets ?? {})) if (packagePath(path) !== ast.path && /(^|\/)pattern\.yaml$/.test(path)) result.push(parseAst({ kind: 'yaml', text, path }, source.assets ?? {}));
  return result;
}
export class PatternCatalog {
  constructor(options: PatternCatalogOptions = {}) {
    const sources: Exclude<PatternSource, { directory: string }>[] = []; const diagnostics: PatternDiagnostic[] = [];
    const load = (directory: string): void => { try { sources.push(...loadDirectory(directory, diagnostics)); } catch (error) { diagnostics.push(...failure(error).diagnostics); } };
    if (options.includeBuiltins !== false) {
      try { load(options.builtinDirectory ?? join(dirname(createRequire(import.meta.url).resolve('dsh-flow/package.json')), 'patterns')); }
      catch (error) { diagnostics.push(...failure(error).diagnostics); }
    }
    for (const source of options.sources ?? []) { if ('directory' in source) load(source.directory); else sources.push(source); }
    const asts: PatternAst[] = [];
    for (const source of sources) {
      const documentPath = typeof source.document === 'string' ? 'pattern.yaml' : source.document.path ?? 'pattern.yaml';
      const documents: PatternDocument[] = [source.document];
      for (const [path, text] of Object.entries(source.assets ?? {})) if (path !== documentPath && /(^|\/)pattern\.yaml$/.test(path)) documents.push({ kind: 'yaml', text, path });
      for (const document of documents) try { asts.push(parseAst(document, source.assets ?? {})); } catch (error) { diagnostics.push(...failure(error).diagnostics); }
    }
    const grouped = new Map<string, PatternAst[]>();
    for (const ast of asts) { const group = grouped.get(ast.id) ?? []; group.push(ast); grouped.set(ast.id, group); }
    const unique = new Map<string, PatternAst>();
    for (const [id, group] of grouped) { if (group.length === 1) unique.set(id, group[0]!); else for (const ast of group) diagnostics.push({ path: ast.path, message: `Duplicate template id ${id}` }); }
    const definitions = new Map<string, PatternDefinition>();
    for (const ast of unique.values()) {
      if (definitions.has(ast.id)) continue;
      try {
        const closure = new Map<string, PatternAst>(); const stack = [ast];
        while (stack.length) {
          const item = stack.pop()!; if (definitions.has(item.id) || closure.has(item.id)) continue; closure.set(item.id, item);
          for (const id of dependencies(item)) { if (definitions.has(id)) continue; const dependency = unique.get(id); if (!dependency) fail(item.path, `Unavailable referenced template ${id}`); stack.push(dependency); }
        }
        for (const [id, definition] of compileAsts([...closure.values()], definitions)) definitions.set(id, definition);
      } catch (error) { diagnostics.push(...failure(error).diagnostics); }
    }
    catalogs.set(this, { definitions, diagnostics: freezeData(diagnostics) }); Object.freeze(this);
  }
  list(): PatternCatalogListResult { return freezeData({ ok: true, patterns: [...state(this).definitions.values()].map(({ id, description, whenToUse, parameters }) => ({ id, description, whenToUse, parameters })), diagnostics: state(this).diagnostics }); }
  resolve(id: string): PatternResolveResult {
    const definition = state(this).definitions.get(id);
    return definition ? { ok: true, definition } : failure(new PatternError('id', `Unknown template ${id}`));
  }
  compile(document: PatternDocument, assets: PatternAssets = {}): PatternCompileResult {
    try {
      const asts = sourceAsts({ document, assets });
      const definition = compileAsts(asts, state(this).definitions).get(asts[0]!.id)!;
      return Object.freeze({ ok: true, definition });
    } catch (error) { return failure(error); }
  }
  readonly [catalogControl] = {
    snapshot: (): PatternCatalog => {
      const copy = new PatternCatalog({ includeBuiltins: false });
      catalogs.set(copy, { definitions: new Map(state(this).definitions), diagnostics: state(this).diagnostics }); return copy;
    },
    register: (definition: PatternDefinition): void => {
      compiledPattern(definition); const definitions = state(this).definitions;
      if (definitions.has(definition.id)) fail('id', `Duplicate template id ${definition.id}`);
      definitions.set(definition.id, definition);
    },
    assertVisible: (definition: PatternDefinition): void => {
      compiledPattern(definition);
      if (state(this).definitions.get(definition.id) !== definition) fail('definition', 'Template definition is not visible in this catalog');
    },
  };
}
