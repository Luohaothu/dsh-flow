import { join } from 'node:path';
/**
 * Read-only access to a finished run's cluster.sqlite, for acceptance checks.
 * The runner never writes through this handle.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

/** One raw SQLite row, exactly as the driver hands it back. */
export type SqlRow = Record<string, SQLOutputValue>;

/** A read-only view of one finished run's database. */
export interface Ledger {
  all(sql: string, ...args: SQLInputValue[]): SqlRow[];
  get(sql: string, ...args: SQLInputValue[]): SqlRow | undefined;
  close(): void;
}

/** One usage-receipt aggregate for a cluster. */
export interface UsageSummary {
  requests: number;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  unknown_requests: number | null;
  overshoot: number | null;
}

/** One worker's activation counters. */
export interface WorkerActivationRow {
  agent_id: string | null;
  turns: number;
  dispatched_requests: number;
  distinct_requests: number;
}

/** How many workers were created, sent a request, and ran a turn. */
export interface WorkerActivation {
  per_agent: WorkerActivationRow[];
  created: number;
  activated: number;
  with_turns: number;
}

/** Two independently measured concurrency ceilings. */
export interface ConcurrencyPeaks {
  resident_peak: number | null;
  provider_inflight_peak: number | null;
  resident_samples: number;
  provider_samples: number;
}

/** One recipient's record of a message, with its occurrence count. */
export interface DeliveryCountRow {
  recipient: string | null;
  message_id: string | null;
  status: string | null;
  c: number;
}

/** One settled write that landed outside every scope its identity was granted. */
export interface WriteScopeEscape {
  agent_id: unknown;
  tool: unknown;
  path: string;
  scopes: string[];
}

/** The write-scope verdict: how many writes were checkable, and what escaped. */
export interface WriteScopeAnalysis {
  checked: number;
  escapes: WriteScopeEscape[];
  settled_writes: number;
  unmeasured: string | null;
}

/** Allocation rows the write-scope analysis reads. */
export interface WriteScopeAllocation {
  agent_id?: unknown;
  write_scope?: unknown;
  write_scope_canonical?: unknown;
}

/** Settled effect rows the write-scope analysis reads. */
export interface WriteScopeEffect {
  agent_id?: unknown;
  tool?: unknown;
  status?: unknown;
  args?: unknown;
}

/** What the write-scope analysis was given. */
export interface WriteScopeInput {
  allocations?: readonly WriteScopeAllocation[];
  effects?: readonly WriteScopeEffect[];
  workspace?: string | null;
}

export function openLedger(dbPath: string): Ledger {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    all: (sql, ...args) => db.prepare(sql).all(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    close: () => db.close(),
  };
}

export function usageSummary(ledger: Ledger, clusterId: string): UsageSummary {
  const row = ledger.get(
    `SELECT COUNT(*) AS requests,
            SUM(COALESCE(total_tokens,0)) AS total_tokens,
            SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens,
            SUM(COALESCE(completion_tokens,0)) AS completion_tokens,
            SUM(COALESCE(cached_tokens,0)) AS cached_tokens,
            SUM(COALESCE(reasoning_tokens,0)) AS reasoning_tokens,
            SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) AS unknown_requests,
            SUM(COALESCE(overshoot,0)) AS overshoot
     FROM usage_receipts WHERE cluster_id=?`, clusterId);
  return {
    requests: countOf(row, 'requests'),
    total_tokens: sumOf(row, 'total_tokens'),
    prompt_tokens: sumOf(row, 'prompt_tokens'),
    completion_tokens: sumOf(row, 'completion_tokens'),
    cached_tokens: sumOf(row, 'cached_tokens'),
    reasoning_tokens: sumOf(row, 'reasoning_tokens'),
    unknown_requests: sumOf(row, 'unknown_requests'),
    overshoot: sumOf(row, 'overshoot'),
  };
}

/**
 * Worker activation: a worker counts as *activated* only when it really sent at
 * least one non-compaction provider request. A created identity, a queued turn
 * or a receipt whose request never left the client (`NOT_SENT`) proves nothing
 * about model-backed execution, so none of them may be counted here.
 */
export function workerActivation(ledger: Ledger, clusterId: string): WorkerActivation {
  const perAgent = ledger.all(
    `SELECT a.id AS agent_id, a.turns,
            (SELECT COUNT(*) FROM usage_receipts u
              WHERE u.agent_id=a.id AND u.cluster_id=a.cluster_id AND u.kind='worker' AND u.status<>'NOT_SENT') AS dispatched_requests,
            (SELECT COUNT(DISTINCT u.request_id) FROM usage_receipts u
              WHERE u.agent_id=a.id AND u.cluster_id=a.cluster_id AND u.kind='worker' AND u.status<>'NOT_SENT') AS distinct_requests
     FROM agents a WHERE a.cluster_id=? AND a.role='worker'`, clusterId)
    .map(row => ({
      agent_id: textOf(row, 'agent_id'),
      turns: countOf(row, 'turns'),
      dispatched_requests: countOf(row, 'dispatched_requests'),
      distinct_requests: countOf(row, 'distinct_requests'),
    }));
  return {
    per_agent: perAgent,
    created: perAgent.length,
    activated: perAgent.filter(row => row.dispatched_requests > 0).length,
    with_turns: perAgent.filter(row => row.turns > 0).length,
  };
}

/**
 * Two different ceilings, measured two different ways:
 * `resident_peak` is the peak of locally registered live turn handles (from
 * lease intervals) and `provider_inflight_peak` is the peak of dispatched but
 * unsettled provider requests (from receipt intervals). Neither is ever
 * substituted for the other, and a run with no intervals reports `null`.
 */
export function concurrencyPeaks(ledger: Ledger, clusterId: string): ConcurrencyPeaks {
  const overlap = (rows: SqlRow[], from: string, to: string): number | null => {
    const points: Array<[number, number]> = [];
    for (const row of rows) {
      const start = row[from];
      const end = row[to];
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      points.push([start, 1], [Math.max(start, end), -1]);
    }
    if (!points.length) return null;
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let live = 0;
    let peak = 0;
    for (const [, delta] of points) {
      live += delta;
      if (live > peak) peak = live;
    }
    return peak;
  };
  const receipts = ledger.all('SELECT created, settled FROM usage_receipts WHERE cluster_id=?', clusterId);
  const leases = ledger.all('SELECT created, expires FROM leases WHERE cluster_id=?', clusterId);
  return {
    resident_peak: overlap(leases, 'created', 'expires'),
    provider_inflight_peak: overlap(receipts, 'created', 'settled'),
    resident_samples: leases.length,
    provider_samples: receipts.length,
  };
}

export function deliveryCounts(ledger: Ledger, clusterId: string): DeliveryCountRow[] {
  return ledger.all(
    `SELECT r.recipient, r.message_id, r.status, COUNT(*) AS c
     FROM recipients r JOIN messages m ON m.id=r.message_id
     WHERE m.cluster_id=? GROUP BY r.recipient, r.message_id, r.status`, clusterId)
    .map(row => ({
      recipient: textOf(row, 'recipient'),
      message_id: textOf(row, 'message_id'),
      status: textOf(row, 'status'),
      c: countOf(row, 'c'),
    }));
}

export function pendingWork(ledger: Ledger, clusterId: string): {
  leases: SqlRow[];
  running_agents: SqlRow[];
  in_flight_effects: SqlRow[];
} {
  return {
    leases: ledger.all('SELECT * FROM leases WHERE cluster_id=?', clusterId),
    running_agents: ledger.all("SELECT id,role,status,turns FROM agents WHERE cluster_id=? AND status='RUNNING'", clusterId),
    in_flight_effects: ledger.all("SELECT call_id,tool,status FROM effects WHERE cluster_id=? AND status='STARTED'", clusterId),
  };
}
/**
 * Which settled write-capable effects really landed outside the scope their
 * identity was granted.
 *
 * A refused attempt is *enforcement working* — the sandbox held — and is counted
 * separately. An escape is a write that was **dispatched and settled** at a path
 * no grant covers; without a settled write effect there is no execution evidence
 * and the answer is `null` (unmeasured), never zero.
 */
export function writeScopeAnalysis({ allocations = [], effects = [], workspace = null }: WriteScopeInput = {}): WriteScopeAnalysis {
  // Paths are compared after normalisation: `/work/allowed/../outside` starts
  // with the granted prefix and is not inside it.
  const normalise = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    if (!value.startsWith('/')) return workspace ? join(workspace, value) : null;
    const parts: string[] = [];
    for (const segment of value.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return `/${parts.join('/')}`;
  };
  const scopesByAgent = new Map<unknown, unknown[]>();
  for (const allocation of allocations) {
    const record = asRecord(allocation) ?? {};
    const entries: unknown[] = (() => {
      const raw = record.write_scope_canonical ?? record.write_scope ?? [];
      if (Array.isArray(raw)) return [...raw];
      try {
        const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : String(raw ?? '[]'));
        return Array.isArray(parsed) ? [...parsed] : [];
      } catch {
        return [];
      }
    })();
    if (!entries.length) continue;
    const existing = scopesByAgent.get(record.agent_id) ?? [];
    scopesByAgent.set(record.agent_id, [...existing, ...entries]);
  }
  const writes = effects
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null)
    .filter(effect => (effect.tool === 'write' || effect.tool === 'edit') && effect.status === 'SETTLED');
  if (!writes.length) return { checked: 0, escapes: [], settled_writes: 0, unmeasured: 'no write-capable tool call settled' };
  const escapes: WriteScopeEscape[] = [];
  let unchecked = 0;
  for (const effect of writes) {
    const scopes = (scopesByAgent.get(effect.agent_id) ?? []).map(normalise).filter((entry): entry is string => entry !== null);
    if (!scopes.length) { unchecked += 1; continue; }
    let args = effect.args;
    if (typeof args === 'string') {
      try {
        const parsed: unknown = JSON.parse(args);
        args = parsed;
      } catch {
        args = null;
      }
    }
    const argsRecord = asRecord(args);
    const raw = argsRecord?.file_path ?? argsRecord?.path ?? null;
    const target = normalise(raw);
    if (!target) { unchecked += 1; continue; }
    const covered = scopes.some(entry => target === entry || target.startsWith(entry.endsWith('/') ? entry : `${entry}/`));
    if (!covered) escapes.push({ agent_id: effect.agent_id, tool: effect.tool, path: target, scopes });
  }
  // A write that could not be checked is not a write that stayed inside: with any
  // coverage missing the answer is UNKNOWN — unless an escape was *proven*, which
  // is a failure regardless.
  return {
    checked: writes.length - unchecked,
    escapes,
    settled_writes: writes.length,
    unmeasured: unchecked > 0
      ? `${unchecked} settled write-capable call(s) could not be checked (no granted scope or no readable target path)`
      : null,
  };
}

/** A checked, non-null object view of an unknown row or JSON value. */
function asRecord(value: unknown): Record<string, unknown> | null {
  // `typeof value === 'object'` proves the runtime shape; the record view only
  // exposes `unknown` members, so every field still has to be narrowed.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A row's text column, or null when the column is NULL or not text. */
function textOf(row: SqlRow | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === 'string' ? value : null;
}

/** A row's numeric column as a number; absent, NULL and bigint read as counts. */
function countOf(row: SqlRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

/**
 * A row's SUM column exactly as SQL produced it: a number, or null when the
 * aggregate covered no rows. "No receipt was recorded" is not "zero used", so
 * the null is preserved rather than flattened.
 */
function sumOf(row: SqlRow | undefined, key: string): number | null {
  const value = row?.[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}