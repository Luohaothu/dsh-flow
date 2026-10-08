/** Native default compaction evidence; Flow never supplies a role window or forces compaction. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger, usageSummary } from '../../../src/host/ledger.ts';
import { findSessionFile, readSessionEvents } from '../../../src/host/session-scan.ts';
import { asString } from '../context.ts';
import type { AcceptanceReport, CheckEntry, CheckOutcome, RunEvent } from '../context.ts';
import type { RunLayout } from '../../../src/host/types.ts';

interface ContextCheckContext { readonly report: AcceptanceReport; readonly layout: RunLayout; readonly events: readonly RunEvent[] }

export async function run({ report, layout }: ContextCheckContext): Promise<CheckOutcome> {
  const checks: CheckEntry[] = [];
  const push = (name: string, passed: boolean | null, evidence: unknown): void => {
    checks.push({ name, passed, evidence: String(evidence).slice(0, 2500) });
  };
  const dbPath = join(layout.data, 'cluster.sqlite');
  push('cluster-database-present', existsSync(dbPath), dbPath);
  push('cluster-id-resolved', Boolean(report.cluster_id), report.cluster_id ?? 'start did not resolve a cluster');
  if (existsSync(dbPath) && report.cluster_id) {
    const ledger = openLedger(dbPath);
    try {
      const sessions = ledger.all('SELECT id,session_id FROM agents WHERE cluster_id=?', report.cluster_id);
      const evidence: { agent: string; seq: number; settlements_before: number; settlements_after: number }[] = [];
      let readable = 0;
      const unreadable: string[] = [];
      for (const agent of sessions) {
        const sessionId = asString(agent.session_id);
        const file = sessionId ? findSessionFile(join(layout.home, 'sessions'), sessionId) : null;
        if (!file) { unreadable.push(String(agent.id)); continue; }
        const scanned = readSessionEvents(file);
        if (scanned.state !== 'READ') { unreadable.push(`${agent.id}: ${scanned.reason}`); continue; }
        readable += 1;
        const settlements = scanned.events.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type));
        for (const event of scanned.events.filter(event => event.type === 'compaction/summary')) {
          evidence.push({ agent: String(agent.id), seq: event.seq,
            settlements_before: settlements.filter(fact => fact.seq < event.seq).length,
            settlements_after: settlements.filter(fact => fact.seq > event.seq).length });
        }
      }
      push('native-default-compaction-recorded', readable ? evidence.length > 0 : null,
        `${readable} native logs read; summary facts ${JSON.stringify(evidence)}; unreadable ${JSON.stringify(unreadable)}`);
      push('native-compaction-between-settlements', readable ? evidence.some(row => row.settlements_before > 0 && row.settlements_after > 0) : null,
        JSON.stringify(evidence));
      const usage = usageSummary(ledger, report.cluster_id);
      push('host-usage-projected', usage.requests > 0, JSON.stringify(usage));
      const summaries = ledger.all("SELECT native_session_id,native_seq FROM native_session_events WHERE cluster_id=? AND type='compaction/summary'", report.cluster_id);
      push('native-summary-projected-once', evidence.length ? summaries.length === evidence.length : null,
        `${summaries.length} projected native summaries; ${evidence.length} durable Session summaries`);
      const accepted = Number(ledger.get("SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='ACCEPTED'", report.cluster_id)?.c ?? 0);
      push('work-accepted', accepted > 0, `${accepted} accepted transactions`);
      const summariesWritten = ledger.all('SELECT data FROM summaries WHERE cluster_id=?', report.cluster_id);
      push('durable-summary-written', summariesWritten.length > 0, `${summariesWritten.length} summaries`);
    } finally { ledger.close(); }
  }
  const failed = checks.filter(check => check.passed === false);
  const unknown = checks.some(check => check.passed === null);
  return { checks, scenario_status: failed.length ? 'FAILED' : unknown ? 'UNKNOWN' : 'PASSED',
    failure_class: failed.length ? 'MECHANISM' : null };
}
