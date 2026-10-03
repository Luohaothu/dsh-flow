/**
 * Recovery case checks: the host process was killed mid-flight and restarted.
 * These assertions read durable state on both sides of the crash.
 *
 * A check that could not be measured reports `null` (UNKNOWN) rather than
 * passing: "the crash landed after the ack" is not evidence about the window
 * between injection and ack.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openLedger, usageSummary, deliveryCounts } from '../../../src/host/ledger.mjs';
import { countDeliveriesInSession, findSessionFile } from '../../../src/host/session-scan.mjs';

const TERMINAL = new Set(['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED']);

/**
 * The blackboard keys this case's own instructions require, with `{{runId}}`
 * resolved to the run being checked. A case that tells the run to publish a key
 * is measuring that key: its absence is a scenario outcome, not an unmeasurable.
 */
export function requiredBlackboardKeys(caseDef, runId) {
  const text = [caseDef?.objective ?? '', ...(caseDef?.acceptance_criteria ?? [])].join('\n');
  const keys = new Set();
  for (const match of text.matchAll(/`([^`]*\{\{runId\}\}[^`]*)`/g)) keys.add(match[1].replaceAll('{{runId}}', String(runId ?? '')));
  for (const match of text.matchAll(/`([^`]*\/[a-zA-Z0-9_.-]+)`/g)) {
    if (match[1].includes('{{runId}}')) continue;
    if (match[1].includes('/') && !match[1].includes(' ') && !match[1].startsWith('/')) keys.add(match[1]);
  }
  return [...keys];
}

/** Present / absent / wrong-key verdict for a case that requires named keys. */
export function blackboardVerdict(rows, requiredKeys) {
  const present = new Set((rows ?? []).map(row => row.key));
  const found = requiredKeys.filter(key => present.has(key));
  return { required: requiredKeys, found, missing: requiredKeys.filter(key => !present.has(key)), ok: requiredKeys.length > 0 && found.length === requiredKeys.length };
}

export async function run({ caseDef, report, layout, events, workspace }) {
  void workspace;
  const checks = [];
  const push = (name, passed, evidence) => checks.push({
    name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
  });
  const dbPath = join(layout.data, 'cluster.sqlite');
  // Two independent facts, never one shortened condition: a database that
  // exists with no resolved cluster id is a different failure from a database
  // that was never created, and saying "missing" for the first one is a lie.
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id
      ? `report.cluster_id = ${report.cluster_id}`
      : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (!dbPresent || !report.cluster_id) {
    return { checks, scenario_status: 'FAILED', failure_class: 'MECHANISM' };
  }
  const ledger = openLedger(dbPath);
  const clusterId = report.cluster_id;

  const restart = report.restart ?? {};
  push('host-was-restarted', restart.restarted === true, `restart facts: ${JSON.stringify(restart.exit ?? null)}`);

  const statuses = ledger.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId);
  const total = statuses.reduce((sum, row) => sum + Number(row.c), 0);
  const accepted = statuses.find(row => row.status === 'ACCEPTED')?.c ?? 0;
  push('all-transactions-reached-acceptance', accepted === total && total >= 4, `${accepted}/${total}: ${JSON.stringify(statuses)}`);

  const recoveryEvents = events.filter(event => event.type === 'recovered' || event.type === 'recovery');
  push('recovery-recorded', recoveryEvents.length > 0, `${recoveryEvents.length} recovery events`);
  const fenced = events.filter(event => event.type === 'recovered').reduce((sum, event) => sum + (event.data.fenced_leases ?? 0), 0);
  const leasesAtCrash = report.restart?.leases_at_crash;
  const leasesAtCrashCount = Array.isArray(leasesAtCrash) ? leasesAtCrash.length : null;
  const expired = events.filter(event => event.type === 'lease-expired').length;
  // No recorded lease rows (or no live lease) do not exercise crash fencing.
  push('stale-leases-fenced', leasesAtCrashCount == null || leasesAtCrashCount === 0
    ? null : fenced >= leasesAtCrashCount || expired >= leasesAtCrashCount,
  `${fenced} leases fenced at recovery, ${leasesAtCrashCount ?? 'unknown'} live at the crash, ${expired} expired during the run`);

  const duplicateCharges = ledger.get('SELECT COUNT(*) AS c FROM (SELECT request_id FROM usage_receipts WHERE cluster_id=? GROUP BY request_id HAVING COUNT(*)>1)', clusterId).c;
  push('no-duplicate-charges', duplicateCharges === 0, `${duplicateCharges} duplicated request ids`);

  const duplicateAccepts = ledger.get("SELECT COUNT(*) AS c FROM (SELECT json_extract(data,'$.transaction_id') AS t FROM events WHERE cluster_id=? AND type='result-accepted' GROUP BY t HAVING COUNT(*)>1)", clusterId).c;
  push('no-recomputed-acceptance', duplicateAccepts === 0, `${duplicateAccepts} transactions accepted more than once`);

  const usage = usageSummary(ledger, clusterId);
  // The expected number of UNKNOWN results is exactly the set of receipts that
  // were dispatched and never settled when the process died — read from the
  // crash's own snapshot, not from an allowance. A run that leaves *more*
  // unaccounted requests than it interrupted has lost accounting; one that
  // leaves fewer has silently charged a request that never happened.
  const inFlight = report.restart?.receipts_in_flight_at_crash ?? null;
  const unknownRows = ledger.all("SELECT request_id,agent_id,status,note FROM usage_receipts WHERE cluster_id=? AND status='UNKNOWN'", clusterId);
  const inFlightIds = new Set((inFlight ?? []).map(row => row.request_id));
  const unexplained = unknownRows.filter(row => !inFlightIds.has(row.request_id));
  push('usage-unknown-bounded',
    inFlight === null ? null : (unknownRows.length === inFlight.length && unexplained.length === 0),
    inFlight === null
      ? 'the crash snapshot did not record the in-flight receipts, so the number of UNKNOWN results cannot be attributed'
      : `${unknownRows.length} UNKNOWN receipt(s) against ${inFlight.length} dispatched-unsettled at the crash; unattributed: ${JSON.stringify(unexplained.map(row => row.request_id))}`);

  // The claim is about the recipient's *native Session*, so the check reads the
  // durable Session log: a recipients-table pair count would be a tautology.
  const sentEvents = events.filter(event => event.type === 'fixture-message-sent');
  push('fixture-message-sent', sentEvents.length > 0,
    `${sentEvents.length} fixture messages sent: ${sentEvents.map(event => event.data.message_id).join(', ') || 'none'}`);

  const sessionsRoot = join(layout.home, 'sessions');
  const killAt = restart.kill_at_ms == null || !Number.isFinite(Number(restart.kill_at_ms))
    ? null : Number(restart.kill_at_ms);
  const seqAtKill = Number.isSafeInteger(restart.event_seq_at_kill) ? restart.event_seq_at_kill : null;
  // The post-SIGKILL ledger cursor is the authoritative ordering boundary.
  // Only fall back to wall timestamps for older runs without that cursor.
  const beforeKill = candidate => seqAtKill === null
    ? killAt !== null && Number.isFinite(candidate.at) && candidate.at <= killAt
    : Number.isSafeInteger(candidate.seq) && candidate.seq <= seqAtKill;
  const observations = [];
  for (const event of sentEvents) {
    const messageId = event.data.message_id;
    const recipient = ledger.get('SELECT * FROM agents WHERE id=?', event.data.recipient);
    const delivery = ledger.get('SELECT * FROM recipients WHERE message_id=? AND recipient=?', messageId, event.data.recipient);
    // The crash exercises the injection/ack window only if the recipient's
    // Session was flushed before the kill and its delivery was not yet acked.
    const matching = candidate => (candidate.data?.message_ids ?? []).includes(messageId)
      && candidate.data?.agent_id === event.data.recipient;
    const flushedBeforeKill = events.some(candidate => candidate.type === 'delivery-flushed'
      && matching(candidate) && beforeKill(candidate));
    const ackedBeforeKill = events.some(candidate => candidate.type === 'messages-acked'
      && matching(candidate) && beforeKill(candidate));
    const file = recipient ? findSessionFile(sessionsRoot, recipient.session_id) : null;
    if (!file || !delivery) {
      observations.push({
        message_id: messageId, session: null, state: 'UNKNOWN',
        reason: !recipient ? 'the recipient agent row is missing' : !delivery ? 'the delivery row is missing' : 'no session log on disk',
        flushed_before_kill: flushedBeforeKill, acked_before_kill: ackedBeforeKill,
      });
      continue;
    }
    const scan = countDeliveriesInSession(file, [{ message_id: messageId, delivery_seq: delivery.delivery_seq }]);
    observations.push({
      message_id: messageId, session: recipient.session_id, state: scan.state,
      reason: scan.reason ?? null, messages: scan.counted[messageId] ?? null, events: scan.events,
      flushed_before_kill: flushedBeforeKill, acked_before_kill: ackedBeforeKill,
    });
  }
  const unmeasurable = observations.filter(entry => entry.state !== 'FOUND');
  const wrongCount = observations.filter(entry => entry.state === 'FOUND' && entry.messages !== 1);
  const exercised = observations.filter(entry => entry.flushed_before_kill && !entry.acked_before_kill);
  push('message-appears-exactly-once-in-the-recipient-session',
    observations.length === 0 ? false : unmeasurable.length ? null : wrongCount.length === 0,
    `observations: ${JSON.stringify(observations).slice(0, 900)}`);
  // The crash window this case exists to test is the one between injection and
  // ack. A kill that landed after every ack measured nothing at all: that is
  // UNKNOWN with the reason, never a pass — and never a failure either, since
  // the mechanism was not exercised rather than found broken.
  const crashPosition = seqAtKill === null ? `epoch ${killAt} ms` : `durable event seq ${seqAtKill} (epoch ${killAt ?? 'unknown'} ms)`;
  push('crash-window-exercised',
    (seqAtKill === null && killAt === null) || exercised.length === 0 ? null : true,
    seqAtKill === null && killAt === null
      ? 'the kill timestamp was not recorded and no durable event cursor exists, so the flush/ack order is unknown'
      : exercised.length === 0
        ? `none of ${observations.length} deliveries was flushed and unacked when the kill landed (${crashPosition}); the injection/ack window was not exercised`
        : `${exercised.length} of ${observations.length} deliveries were flushed and unacked at the kill (${crashPosition})`);
  const duplicates = deliveryCounts(ledger, clusterId).filter(row => Number(row.c) > 1);
  push('no-duplicate-delivery-records', duplicates.length === 0, `${duplicates.length} duplicated recipient pairs`);

  const effects = ledger.all('SELECT status, COUNT(*) AS c FROM effects WHERE cluster_id=? GROUP BY status', clusterId);
  const uncertain = effects.find(row => row.status === 'EFFECT_UNCERTAIN')?.c ?? 0;
  push('effect-uncertainty-explicit', effects.every(row => row.status !== 'STARTED'),
    `effect states: ${JSON.stringify(effects)}; ${uncertain} marked EFFECT_UNCERTAIN after the crash`);

  const blackboard = ledger.all('SELECT key, revision FROM blackboard WHERE cluster_id=?', clusterId);
  // This case's own instructions name the key the run must publish
  // (`{{runId}}/total`), and the key it asks for is the key that is checked: a
  // missing one is a scenario outcome, and calling it "not required" measured
  // nothing at all.
  const requiredKeys = requiredBlackboardKeys(caseDef, report.run_id);
  const verdict = blackboardVerdict(blackboard, requiredKeys);
  push('blackboard-published', requiredKeys.length ? verdict.ok : (blackboard.length > 0),
    requiredKeys.length
      ? `required ${JSON.stringify(verdict.required)}; found ${JSON.stringify(verdict.found)}; missing ${JSON.stringify(verdict.missing)}; keys present: ${blackboard.map(row => `${row.key}@${row.revision}`).join(', ') || 'none'}`
      : `keys: ${blackboard.map(row => `${row.key}@${row.revision}`).join(', ') || 'none (no key is named by the case)'}`);

  // The invariant is one lease *per identity*, not one lease in the cluster: a
  // cluster stopped mid-flight legitimately holds a lease for each identity that
  // was working.
  const liveLeases = ledger.all('SELECT * FROM leases WHERE cluster_id=?', clusterId);
  const doubled = ledger.all('SELECT agent_id, COUNT(*) AS c FROM leases WHERE cluster_id=? GROUP BY agent_id HAVING c>1', clusterId);
  push('no-double-lease', doubled.length === 0,
    `${liveLeases.length} live leases at rest across ${new Set(liveLeases.map(row => row.agent_id)).size} identities; ${doubled.length} identities hold more than one`);

  // Every fixture transaction must be in a terminal state, and a transaction
  // left in flight is the one thing recovery exists to prevent.
  const lost = ledger.all(
    `SELECT id,status FROM transactions WHERE cluster_id=? AND status NOT IN (${[...TERMINAL].map(() => '?').join(',')})`,
    clusterId, ...TERMINAL).map(row => `${row.id}:${row.status}`);
  push('no-transaction-left-in-flight', lost.length === 0, lost.length ? lost.slice(0, 5).join(', ') : 'every transaction is terminal');
  ledger.close();

  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => [
    'cluster-database-present', 'cluster-id-resolved', 'no-duplicate-charges', 'no-recomputed-acceptance',
    'effect-uncertainty-explicit', 'host-was-restarted', 'message-appears-exactly-once-in-the-recipient-session',
    'no-transaction-left-in-flight', 'no-duplicate-delivery-records',
  ].includes(entry.name));
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}