import { join } from 'node:path';
import { summarizeNativeUsage } from '../../packages/dsh-flow/src/core/native-usage.ts';
import type { NativeSessionFact } from '../../packages/dsh-flow/src/core/native-usage.ts';
import type { FlowUsageSummary } from '../../packages/dsh-flow/src/types.ts';
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

/** Host-recorded usage, preserving missing fields and observation completeness. */
export type UsageSummary = FlowUsageSummary;

/** One worker's activation counters. */
export interface WorkerActivationRow {
  agent_id: string | null;
  turns: number;
  started_turns: number;
  completed_turns: number;
  native_settlements: number;
}

/** Worker identities, completed execution lifecycles and native assistant settlements. */
export interface WorkerActivation {
  per_agent: WorkerActivationRow[];
  created: number;
  activated: number;
  with_turns: number;
}

/** Agent lifecycle concurrency; provider request concurrency remains unavailable here. */
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

/** Read durable native event facts without mutating the Flow database. */
export function nativeSessionFacts(ledger: Ledger, clusterId: string): NativeSessionFact[] {
  return ledger.all('SELECT * FROM native_session_events WHERE cluster_id=? ORDER BY native_session_id,native_seq', clusterId).map(row => ({
    native_session_id: String(row.native_session_id), native_seq: countOf(row, 'native_seq'),
    cluster_id: String(row.cluster_id), agent_id: String(row.agent_id), node_id: String(row.node_id),
    role: String(row.role) as NativeSessionFact['role'], transaction_id: textOf(row, 'transaction_id'),
    type: String(row.type), data: JSON.parse(String(row.data)) as NativeSessionFact['data'],
    time: countOf(row, 'time'),
  }));
}

export function usageSummary(ledger: Ledger, clusterId: string): UsageSummary {
  return summarizeNativeUsage(nativeSessionFacts(ledger, clusterId));
}

/**
 * Activation requires native assistant settlement evidence and an actual Agent
 * execution lifecycle. A created identity or scheduled turn alone is insufficient.
 * This proves execution, not dispatch counts or provider request concurrency.
 */
export function workerActivation(ledger: Ledger, clusterId: string): WorkerActivation {
  const perAgent = ledger.all(`SELECT a.id AS agent_id,a.turns,
    (SELECT COUNT(*) FROM events e WHERE e.cluster_id=a.cluster_id AND e.type='turn-start' AND json_extract(e.data,'$.agent_id')=a.id) AS started_turns,
    (SELECT COUNT(*) FROM events e WHERE e.cluster_id=a.cluster_id AND e.type='turn-end' AND json_extract(e.data,'$.agent_id')=a.id) AS completed_turns,
    (SELECT COUNT(*) FROM native_session_events n WHERE n.cluster_id=a.cluster_id AND n.agent_id=a.id AND n.type IN ('assistant/message','assistant/attempt')) AS native_settlements
    FROM agents a WHERE a.cluster_id=? AND a.role='worker'`, clusterId).map(row => ({
      agent_id: textOf(row, 'agent_id'), turns: countOf(row, 'turns'),
      started_turns: countOf(row, 'started_turns'), completed_turns: countOf(row, 'completed_turns'),
      native_settlements: countOf(row, 'native_settlements'),
    }));
  return { per_agent: perAgent, created: perAgent.length,
    activated: perAgent.filter(row => row.started_turns > 0 && row.completed_turns > 0 && row.native_settlements > 0).length,
    with_turns: perAgent.filter(row => row.started_turns > 0 && row.completed_turns > 0).length };
}

/**
 * Agent lifecycle intervals measure resident turns. Durable assistant settlement
 * events contain no request dispatch intervals, so provider concurrency stays
 * unknown unless an independent provider observer records it elsewhere.
 */
export function concurrencyPeaks(ledger: Ledger, clusterId: string): ConcurrencyPeaks {
  const events = ledger.all("SELECT type,data,at FROM events WHERE cluster_id=? AND type IN ('turn-start','turn-end') ORDER BY seq", clusterId);
  const active = new Set<string>();
  let peak = 0;
  let samples = 0;
  for (const event of events) {
    const data = asRecord(JSON.parse(String(event.data)));
    const agent = data?.agent_id;
    if (typeof agent !== 'string') continue;
    if (event.type === 'turn-start') { active.add(agent); samples += 1; peak = Math.max(peak, active.size); }
    else active.delete(agent);
  }
  return { resident_peak: samples ? peak : null, provider_inflight_peak: null,
    resident_samples: samples, provider_samples: 0 };
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
