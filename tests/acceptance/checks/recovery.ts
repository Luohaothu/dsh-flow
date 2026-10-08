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

import { openLedger, deliveryCounts } from '../../../src/host/ledger.ts';
import { countDeliveriesInSession, findSessionFile } from '../../../src/host/session-scan.ts';
import { asArray, asNumber, asString } from '../context.ts';
import type { CheckEntry, CheckOutcome, JsonObject, RestartFacts } from '../context.ts';

interface CaseInstructions {
  readonly objective?: unknown;
  readonly acceptance_criteria?: readonly unknown[];
}

interface BlackboardRow {
  readonly key?: unknown;
}

interface RecoveryRestart {
  readonly restarted?: unknown;
  readonly exit?: unknown;
  readonly kill_at_ms?: unknown;
  readonly event_seq_at_kill?: unknown;
  readonly leases_at_crash?: unknown;
  readonly interrupted_agents_at_crash?: unknown;
}

interface RecoveryReport {
  readonly cluster_id?: string | null;
  readonly failure?: { readonly message: string } | null;
  readonly restart?: RestartFacts | RecoveryRestart | null;
  readonly run_id?: string;
}

interface RecoveryEvent {
  readonly seq?: number;
  readonly at?: number;
  readonly type: string;
  readonly data?: JsonObject;
}

interface RecoveryLayout {
  readonly data: string;
  readonly home: string;
}

interface RecoveryContext {
  readonly caseDef: CaseInstructions;
  readonly report: RecoveryReport;
  readonly layout: RecoveryLayout;
  readonly events: readonly RecoveryEvent[];
}

interface DeliveryObservation {
  readonly message_id: string;
  readonly session: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly messages?: number | null;
  readonly events?: number;
  readonly flushed_before_kill: boolean;
  readonly acked_before_kill: boolean;
}

const TERMINAL = new Set(['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED']);

/**
 * The blackboard keys this case's own instructions require, with `{{runId}}`
 * resolved to the run being checked. A case that tells the run to publish a key
 * is measuring that key: its absence is a scenario outcome, not an unmeasurable.
 */
export function requiredBlackboardKeys(caseDef: CaseInstructions, runId: unknown): string[] {
  const text = [caseDef?.objective ?? '', ...(caseDef?.acceptance_criteria ?? [])].join('\n');
  const keys = new Set<string>();
  for (const match of text.matchAll(/`([^`]*\{\{runId\}\}[^`]*)`/g)) {
    const key = match[1];
    if (key !== undefined) keys.add(key.replaceAll('{{runId}}', String(runId ?? '')));
  }
  for (const match of text.matchAll(/`([^`]*\/[a-zA-Z0-9_.-]+)`/g)) {
    const key = match[1];
    if (key === undefined || key.includes('{{runId}}')) continue;
    if (key.includes('/') && !key.includes(' ') && !key.startsWith('/')) keys.add(key);
  }
  return [...keys];
}

/** Present / absent / wrong-key verdict for a case that requires named keys. */
export function blackboardVerdict(rows: readonly BlackboardRow[], requiredKeys: readonly string[]) {
  const present = new Set(rows.map(row => row.key));
  const found = requiredKeys.filter(key => present.has(key));
  return { required: requiredKeys, found, missing: requiredKeys.filter(key => !present.has(key)), ok: requiredKeys.length > 0 && found.length === requiredKeys.length };
}

export async function run({ caseDef, report, layout, events }: RecoveryContext): Promise<CheckOutcome> {
  const checks: CheckEntry[] = [];
  const push = (name: string, passed: boolean | null | undefined, evidence: unknown): void => {
    checks.push({
      name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
    });
  };
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

  const restart = report.restart ?? null;
  push('host-was-restarted', restart?.restarted === true, `restart facts: ${JSON.stringify(restart?.exit ?? null)}`);

  const statuses = ledger.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId);
  const total = statuses.reduce((sum, row) => sum + Number(row.c), 0);
  const accepted = Number(statuses.find(row => row.status === 'ACCEPTED')?.c ?? 0);
  push('all-transactions-reached-acceptance', accepted === total && total >= 4, `${accepted}/${total}: ${JSON.stringify(statuses)}`);

  const recoveryEvents = events.filter(event => event.type === 'recovered' || event.type === 'recovery');
  push('recovery-recorded', recoveryEvents.length > 0, `${recoveryEvents.length} recovery events`);
  const fenced = events.filter(event => event.type === 'recovered').reduce((sum, event) => sum + Number(event.data?.fenced_leases ?? 0), 0);
  const leasesAtCrash = asArray(restart?.leases_at_crash);
  const leasesAtCrashCount = leasesAtCrash === null ? null : leasesAtCrash.length;
  const expired = events.filter(event => event.type === 'lease-expired').length;
  // No recorded lease rows (or no live lease) do not exercise crash fencing.
  push('stale-leases-fenced', leasesAtCrashCount == null || leasesAtCrashCount === 0
    ? null : fenced >= leasesAtCrashCount || expired >= leasesAtCrashCount,
  `${fenced} leases fenced at recovery, ${leasesAtCrashCount ?? 'unknown'} live at the crash, ${expired} expired during the run`);

  const duplicateCharges = ledger.get('SELECT COUNT(*) AS c FROM (SELECT native_session_id,native_seq FROM native_session_events WHERE cluster_id=? GROUP BY native_session_id,native_seq HAVING COUNT(*)>1)', clusterId)?.c;
  push('no-duplicate-charges', duplicateCharges === 0, `${duplicateCharges} duplicated native session event keys`);

  const duplicateAccepts = ledger.get("SELECT COUNT(*) AS c FROM (SELECT json_extract(data,'$.transaction_id') AS t FROM events WHERE cluster_id=? AND type='result-accepted' GROUP BY t HAVING COUNT(*)>1)", clusterId)?.c;
  push('no-recomputed-acceptance', duplicateAccepts === 0, `${duplicateAccepts} transactions accepted more than once`);

  const cursors = ledger.all('SELECT c.native_session_id,c.native_seq,MAX(n.native_seq) AS projected_seq FROM native_usage_cursors c JOIN native_session_events n ON n.native_session_id=c.native_session_id WHERE n.cluster_id=? GROUP BY c.native_session_id,c.native_seq', clusterId);
  push('native-usage-cursors-consistent', cursors.length > 0 ? cursors.every(row => Number(row.native_seq) === Number(row.projected_seq)) : null,
    `durable native event consumption cursors: ${JSON.stringify(cursors)}`);

  // The claim is about the recipient's *native Session*, so the check reads the
  // durable Session log: a recipients-table pair count would be a tautology.
  const sentEvents = events.filter(event => event.type === 'fixture-message-sent');
  push('fixture-message-sent', sentEvents.length > 0,
    `${sentEvents.length} fixture messages sent: ${sentEvents.map(event => event.data?.message_id).join(', ') || 'none'}`);

  const sessionsRoot = join(layout.home, 'sessions');
  const killAt = restart?.kill_at_ms == null || !Number.isFinite(Number(restart.kill_at_ms))
    ? null : Number(restart.kill_at_ms);
  const seqAtKill = Number.isSafeInteger(restart?.event_seq_at_kill) ? Number(restart?.event_seq_at_kill) : null;
  // The post-SIGKILL ledger cursor is the authoritative ordering boundary.
  // Only fall back to wall timestamps for older runs without that cursor.
  const beforeKill = (candidate: RecoveryEvent): boolean => seqAtKill === null
    ? killAt !== null && Number.isFinite(candidate.at) && Number(candidate.at) <= killAt
    : Number.isSafeInteger(candidate.seq) && Number(candidate.seq) <= seqAtKill;
  const observations: DeliveryObservation[] = [];
  for (const event of sentEvents) {
    const messageId = asString(event.data?.message_id) ?? '';
    const recipientId = asString(event.data?.recipient);
    const recipient = ledger.get('SELECT * FROM agents WHERE id=?', recipientId);
    const delivery = ledger.get('SELECT * FROM recipients WHERE message_id=? AND recipient=?', messageId, recipientId);
    // The crash exercises the injection/ack window only if the recipient's
    // Session was flushed before the kill and its delivery was not yet acked.
    const matching = (candidate: RecoveryEvent): boolean => (asArray(candidate.data?.message_ids) ?? []).includes(messageId)
      && candidate.data?.agent_id === event.data?.recipient;
    const flushedBeforeKill = events.some(candidate => candidate.type === 'delivery-flushed'
      && matching(candidate) && beforeKill(candidate));
    const ackedBeforeKill = events.some(candidate => candidate.type === 'messages-acked'
      && matching(candidate) && beforeKill(candidate));
    const sessionId = asString(recipient?.session_id);
    const file = sessionId === null ? null : findSessionFile(sessionsRoot, sessionId);
    if (!file || !delivery) {
      observations.push({
        message_id: messageId, session: null, state: 'UNKNOWN',
        reason: !recipient ? 'the recipient agent row is missing' : !delivery ? 'the delivery row is missing' : 'no session log on disk',
        flushed_before_kill: flushedBeforeKill, acked_before_kill: ackedBeforeKill,
      });
      continue;
    }
    const deliverySeq = asNumber(delivery.delivery_seq) ?? 0;
    const scan = countDeliveriesInSession(file, [{ message_id: messageId, delivery_seq: deliverySeq }]);
    switch (scan.state) {
      case 'FOUND':
        observations.push({
          message_id: messageId, session: sessionId, state: scan.state, reason: null,
          messages: scan.counted[messageId] ?? null, events: scan.events,
          flushed_before_kill: flushedBeforeKill, acked_before_kill: ackedBeforeKill,
        });
        break;
      case 'ABSENT':
      case 'UNKNOWN':
        observations.push({
          message_id: messageId, session: sessionId, state: scan.state, reason: scan.reason,
          messages: scan.counted[messageId] ?? null, events: scan.events,
          flushed_before_kill: flushedBeforeKill, acked_before_kill: ackedBeforeKill,
        });
        break;
    }
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