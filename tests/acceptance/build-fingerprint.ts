/** The sources and build outputs that identify one acceptance run. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { PLUGIN_ROOT, PROJECT_ROOT } from '../../src/host/host.ts';
import type { CaseDefinition } from '../../src/host/types.ts';

/** One hashed source tree, including the number of files that fed its digest. */
export interface HashTree {
  readonly digest: string | null;
  readonly files: number;
}

interface HashEntry {
  readonly path: string;
  readonly digest: string | null;
}

interface FingerprintInput {
  readonly caseDef: CaseDefinition;
  readonly patches: readonly string[];
}

interface FingerprintEntry<T = unknown> {
  capture(input: FingerprintInput): T;
  complete(value: unknown): boolean;
  readonly missing?: unknown;
}

const present = (value: unknown): boolean => value !== null && value !== undefined;

function file(name: string): FingerprintEntry<string | null> {
  return { capture: () => hashFile(join(PLUGIN_ROOT, 'lib', name)), complete: present };
}

function tree(root: string, extra: readonly { prefix: string; root: string }[] = [], filter?: (path: string) => boolean): FingerprintEntry<HashTree> {
  return {
    capture: () => hashTree(root, extra, filter),
    complete: value => typeof value === 'object' && value !== null && !Array.isArray(value)
      && 'digest' in value && typeof value.digest === 'string'
      && 'files' in value && typeof value.files === 'number' && value.files > 0,
  };
}

/** Each captured field owns its completeness rule and drift comparison order. */
const manifest = {
  plugin_source: tree(join(PLUGIN_ROOT, 'src'), [], path => path.endsWith('.ts') || path.endsWith('.tsx')),
  lib_index: file('index.js'),
  lib_client: file('client.js'),
  lib_command: file('command.js'),
  lib_web: file('web.js'),
  typert_host: file('typert.host.js'),
  typert_host_types: file('typert.host.d.ts'),
  typert_remote_client: file('typert.remote-client.js'),
  typert_remote_client_types: file('typert.remote-client.d.ts'),
  host_source: tree(join(PROJECT_ROOT, 'src/host'), [
    { prefix: 'scripts', root: join(PROJECT_ROOT, 'scripts') },
  ], path => path.endsWith('.ts')),
  // A checker, scenario or host driver changing mid-run changes the experiment.
  acceptance_source: tree(join(PROJECT_ROOT, 'tests/acceptance'), [
    { prefix: 'host', root: join(PROJECT_ROOT, 'src/host') },
  ]),
  case_file: {
    capture: ({ caseDef }: FingerprintInput) => caseDef.id
      ? hashFile(join(PROJECT_ROOT, 'tests/acceptance/cases', `${caseDef.id}.json`)) : null,
    complete: present,
  },
  patches: {
    capture: ({ patches }: FingerprintInput): readonly HashEntry[] => (patches ?? []).map(path => ({ path, digest: hashFile(path) })),
    complete: (value: unknown) => Array.isArray(value) && value.length > 0,
    missing: [],
  },
} satisfies Record<string, FingerprintEntry>;

/** The manifest determines the captured fields; reports may carry extra facts. */
export type BuildHashes = {
  [Key in keyof typeof manifest]: ReturnType<typeof manifest[Key]['capture']>;
} & { [key: string]: unknown };

const entries: readonly [string, FingerprintEntry][] = Object.entries(manifest);

/** Capture the code that runs, separately from the task's input data. */
export function computeBuildHashes(caseDef: CaseDefinition, patches: readonly string[]): BuildHashes {
  return Object.fromEntries(entries.map(([key, entry]) => [key, entry.capture({ caseDef, patches })])) as BuildHashes;
}

/** Name every changed field, or null when both samples describe one build. */
export function buildDrift(before: BuildHashes | null | undefined, after: BuildHashes | null | undefined): string | null {
  if (!before || !after) return 'the fingerprint was never taken';
  const changed = entries.filter(([key, entry]) =>
    JSON.stringify(before[key] ?? entry.missing ?? null) !== JSON.stringify(after[key] ?? entry.missing ?? null));
  return changed.length ? changed.map(([key]) => key).join(', ') : null;
}

/** Check all required captured fields without conflating absent drift evidence. */
export function completeBuildHashes(hashes: Record<string, unknown> | null | undefined): boolean {
  return hashes != null && entries.every(([key, entry]) => key in hashes && entry.complete(hashes[key]));
}

function hashText(text: string | Buffer): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** A file's content digest, or null when the file does not exist. */
export function hashFile(path: string): string | null {
  return existsSync(path) ? hashText(readFileSync(path)) : null;
}

/**
 * Hash relative paths and content across source trees, keeping extra trees in
 * distinct namespaces. Installed dependency trees do not contribute evidence.
 * A missing tree is unknown, never an empty-but-valid digest.
 */
export function hashTree(root: string, extra: readonly { prefix: string; root: string }[] = [], filter?: (relativePath: string) => boolean): HashTree {
  const files: Array<{ path: string; digest: string | null }> = [];
  for (const source of [{ prefix: '', root }, ...extra]) {
    if (!existsSync(source.root)) return { digest: null, files: 0 };
    for (const full of sourceFiles(source.root)) {
      const path = relative(source.root, full).split(sep).join('/');
      if (filter && !filter(path)) continue;
      files.push({ path: source.prefix ? `${source.prefix}/${path}` : path, digest: hashFile(full) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { digest: hashText(files.map(entry => `${entry.path}:${entry.digest}`).join('\n')), files: files.length };
}

function* sourceFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else yield path;
  }
}
