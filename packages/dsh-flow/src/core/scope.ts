/**
 * Per-allocation write isolation, enforced at the moment a mutating tool is
 * dispatched.
 *
 * A workspace-wide sandbox stops a Worker from leaving the *workspace*; it does
 * not stop two Workers from writing each other's files, because both write
 * inside the same workspace. The allocation's `write_scope` is the only thing
 * that separates siblings, so it is checked against the canonical path the tool
 * is about to touch — including symlinks and not-yet-existing paths.
 */
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

export const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'bash', 'job_kill']);

const WRITE_PATH_KEYS = ['path', 'file_path', 'filepath', 'target', 'file'] as const;

/** Narrow one JSON-ish object without losing the fields a caller may hold. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Canonicalise a path that may not exist yet, resolving *every* existing level
 * (so a symlink inside the path cannot hide a different target) and refusing a
 * dangling symlink: `existsSync` is false for a broken link, which would let an
 * owned link create a sibling's non-existent target.
 * @returns the canonical path, or `null` when the path is unresolvable.
 */
export function canonicalTarget(root: string, requested: unknown): string | null {
  if (typeof requested !== 'string' || !requested) return null;
  const absolute = normalize(isAbsolute(requested) ? requested : join(root, requested));
  const segments = absolute.split(sep).filter(segment => segment.length > 0);
  let head: string = sep;
  for (const [index, segment] of segments.entries()) {
    const candidate = join(head, segment);
    let stats: Stats | null = null;
    try {
      stats = lstatSync(candidate);
    } catch {
      stats = null;
    }
    if (stats === null) {
      // The rest of the path does not exist yet: it is canonical as written.
      return normalize(join(head, ...segments.slice(index)));
    }
    if (stats.isSymbolicLink()) {
      try {
        head = realpathSync(candidate);
      } catch {
        return null; // dangling symlink: refuse rather than create its target
      }
      continue;
    }
    head = candidate;
  }
  return normalize(head);
}

/** Canonical form of a whole granted scope, or null when any entry is unusable. */
export function canonicalScope(root: string, writeScope: unknown): string[] | null {
  const entries: string[] = [];
  for (const entry of Array.isArray(writeScope) ? writeScope : []) {
    const canonical = canonicalScopeEntry(root, entry);
    if (canonical === null) return null;
    entries.push(canonical);
  }
  return entries;
}

/** Canonical form of one scope entry (a file or a directory). */
export function canonicalScopeEntry(root: string, entry: unknown): string | null {
  return canonicalTarget(root, entry);
}

/** Whether a canonical path is the entry itself or below it. */
export function withinScope(candidate: string, entry: string): boolean {
  if (!candidate || !entry) return false;
  if (candidate === entry) return true;
  return candidate.startsWith(entry.endsWith(sep) ? entry : `${entry}${sep}`);
}

export function requestedPath(exec: unknown): string | null {
  const holder = asRecord(exec);
  const args = holder ? asRecord(holder.arguments) : null;
  if (!args) return null;
  for (const key of WRITE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** The inputs of one mutation decision, as the dispatch site observes them. */
export interface WriteAccessInput {
  readonly tool: string;
  readonly workspace: string;
  readonly writeScope?: readonly string[] | null;
  readonly arguments?: unknown;
  readonly writeScopeCanonical?: readonly string[] | null;
}

/** The write decision for one tool call. */
export type WriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkWriteAccess({ tool, workspace, writeScope, arguments: args, writeScopeCanonical }: WriteAccessInput): WriteDecision {
  if (!MUTATING_TOOLS.has(tool)) return { allowed: true };
  // A granted scope is canonicalised when the lock is issued and reused here, so
  // dispatch and the overlap check can never disagree about ownership.
  const scope = writeScopeCanonical ?? canonicalScope(workspace, writeScope) ?? [];
  if (scope.length === 0 && (writeScope ?? []).length > 0) {
    return { allowed: false, reason: `this allocation's write scope ${JSON.stringify(writeScope)} cannot be resolved inside the workspace` };
  }

  if (tool === 'bash' || tool === 'job_kill') {
    // A shell can write anywhere in the workspace, so it is only granted to an
    // allocation that owns the whole workspace exclusively.
    const rootCanonical = canonicalScopeEntry(workspace, '.');
    const coversWorkspace = rootCanonical !== null && scope.some(entry => entry === rootCanonical);
    return coversWorkspace
      ? { allowed: true }
      : { allowed: false, reason: `${tool} needs an allocation whose write scope is the whole workspace; this allocation owns ${JSON.stringify(writeScope ?? [])}` };
  }

  const requested = requestedPath({ arguments: args });
  if (requested === null) return { allowed: true };
  const candidate = canonicalTarget(workspace, requested);
  if (candidate === null) return { allowed: false, reason: `${tool} target ${requested} cannot be resolved inside the workspace` };
  if (!scope.length) return { allowed: false, reason: `this allocation owns no write paths; ${tool} to ${requested} is refused` };
  if (!scope.some(entry => withinScope(candidate, entry))) {
    return {
      allowed: false,
      reason: `${tool} to ${requested} is outside this allocation's write scope ${JSON.stringify(writeScope)}`,
    };
  }
  return { allowed: true };
}