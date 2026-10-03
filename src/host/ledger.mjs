import { join } from 'node:path';
/**
 * Read-only access to a finished run's cluster.sqlite, for acceptance checks.
 * The runner never writes through this handle.
 */
import { DatabaseSync } from 'node:sqlite';

export function openLedger(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    all: (sql, ...args) => db.prepare(sql).all(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    close: () => db.close(),
  };
}

export function usageSummary(ledger, clusterId) {
  return ledger.get(
    `SELECT COUNT(*) AS requests,
            SUM(COALESCE(total_tokens,0)) AS total_tokens,
            SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens,
            SUM(COALESCE(completion_tokens,0)) AS completion_tokens,
            SUM(COALESCE(cached_tokens,0)) AS cached_tokens,
            SUM(COALESCE(reasoning_tokens,0)) AS reasoning_tokens,
            SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) AS unknown_requests,
            SUM(COALESCE(overshoot,0)) AS overshoot
     FROM usage_receipts WHERE cluster_id=?`, clusterId);
}

/**
 * Worker activation: a worker counts as *activated* only when it really sent at
 * least one non-compaction provider request. A created identity, a queued turn
 * or a receipt whose request never left the client (`NOT_SENT`) proves nothing
 * about model-backed execution, so none of them may be counted here.
 */
export function workerActivation(ledger, clusterId) {
  const perAgent = ledger.all(
    `SELECT a.id AS agent_id, a.turns,
            (SELECT COUNT(*) FROM usage_receipts u
              WHERE u.agent_id=a.id AND u.cluster_id=a.cluster_id AND u.kind='worker' AND u.status<>'NOT_SENT') AS dispatched_requests,
            (SELECT COUNT(DISTINCT u.request_id) FROM usage_receipts u
              WHERE u.agent_id=a.id AND u.cluster_id=a.cluster_id AND u.kind='worker' AND u.status<>'NOT_SENT') AS distinct_requests
     FROM agents a WHERE a.cluster_id=? AND a.role='worker'`, clusterId);
  return {
    per_agent: perAgent,
    created: perAgent.length,
    activated: perAgent.filter(row => Number(row.dispatched_requests) > 0).length,
    with_turns: perAgent.filter(row => Number(row.turns) > 0).length,
  };
}

/** Compact (worker agent, transaction) pairs with their provider request counts. */
export function workerRequestCoverage(ledger, clusterId) {
  return ledger.all(
    `SELECT a.id AS agent_id, a.node_id, a.turns,
            (SELECT COUNT(*) FROM usage_receipts u WHERE u.agent_id=a.id AND u.kind='worker') AS requests,
            (SELECT COUNT(*) FROM usage_receipts u WHERE u.agent_id=a.id AND u.kind='worker' AND u.status='NOT_SENT') AS not_sent
     FROM agents a WHERE a.cluster_id=? AND a.role='worker'`, clusterId);
}

/**
 * Two different ceilings, measured two different ways:
 * `resident_peak` is the peak of locally registered live turn handles (from
 * lease intervals) and `provider_inflight_peak` is the peak of dispatched but
 * unsettled provider requests (from receipt intervals). Neither is ever
 * substituted for the other, and a run with no intervals reports `null`.
 */
export function concurrencyPeaks(ledger, clusterId) {
  const overlap = (rows, from, to) => {
    const points = [];
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

export function transactionStatusCounts(ledger, clusterId) {
  return ledger.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId);
}

export function deliveryCounts(ledger, clusterId) {
  return ledger.all(
    `SELECT r.recipient, r.message_id, r.status, COUNT(*) AS c
     FROM recipients r JOIN messages m ON m.id=r.message_id
     WHERE m.cluster_id=? GROUP BY r.recipient, r.message_id, r.status`, clusterId);
}

export function effectCounts(ledger, clusterId) {
  return ledger.all('SELECT status, COUNT(*) AS c FROM effects WHERE cluster_id=? GROUP BY status', clusterId);
}

export function pendingWork(ledger, clusterId) {
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
export function writeScopeAnalysis({ allocations = [], effects = [], workspace = null } = {}) {
  // Paths are compared after normalisation: `/work/allowed/../outside` starts
  // with the granted prefix and is not inside it.
  const normalise = value => {
    if (typeof value !== 'string' || !value) return null;
    if (!value.startsWith('/')) return workspace ? join(workspace, value) : null;
    const parts = [];
    for (const segment of value.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return `/${parts.join('/')}`;
  };
  const scopesByAgent = new Map();
  for (const allocation of allocations) {
    const entries = (() => {
      const raw = allocation.write_scope_canonical ?? allocation.write_scope ?? [];
      if (Array.isArray(raw)) return raw;
      try { return JSON.parse(raw ?? '[]'); } catch { return []; }
    })();
    if (!entries.length) continue;
    const existing = scopesByAgent.get(allocation.agent_id) ?? [];
    scopesByAgent.set(allocation.agent_id, [...existing, ...entries]);
  }
  const writes = effects.filter(effect => ['write', 'edit'].includes(effect.tool) && effect.status === 'SETTLED');
  if (!writes.length) return { checked: 0, escapes: [], settled_writes: 0, unmeasured: 'no write-capable tool call settled' };
  const escapes = [];
  let unchecked = 0;
  for (const effect of writes) {
    const scopes = (scopesByAgent.get(effect.agent_id) ?? []).map(normalise).filter(Boolean);
    if (!scopes.length) { unchecked += 1; continue; }
    let args = effect.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    const raw = args?.file_path ?? args?.path ?? null;
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
