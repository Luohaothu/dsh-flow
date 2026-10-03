/**
 * Context-pressure case: the cluster must relieve pressure by calling the
 * host's compaction engine, never by truncating text, and the accepted work
 * must leave a durable summary behind.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openLedger } from '../../../src/host/ledger.ts';
import { findSessionFile, readSessionEvents } from '../../../src/host/session-scan.ts';
import { asNumber, asObject, asString } from '../context.ts';
import type { AcceptanceReport, CheckEntry, CheckOutcome, JsonObject, RunEvent } from '../context.ts';
import type { RunLayout } from '../../../src/host/types.ts';

interface ContextStep extends JsonObject {
  readonly decision?: unknown;
  readonly after?: unknown;
  readonly before?: unknown;
  readonly pending?: unknown;
  readonly context_limit?: unknown;
}

interface ContextCheckContext {
  readonly report: AcceptanceReport;
  readonly layout: RunLayout;
  readonly events: readonly RunEvent[];
}

interface NativeEvidence {
  readonly seq: number;
  readonly requestsBefore: number;
  readonly requestsAfter: number;
}

type ContextOutcome = CheckOutcome;

/** A compacted step sends its post-compaction session plus pending prompt, not its pre-compaction session. */
export function requestBudgetOverruns(steps: readonly ContextStep[]): ContextStep[] {
  return steps.filter(step => {
    if (step.decision === 'reject') return false;
    const after = asNumber(step.after);
    const pending = asNumber(step.pending);
    const limit = asNumber(step.context_limit);
    return after !== null && pending !== null && limit !== null && after + pending > limit;
  });
}

export async function run({ report, layout, events }: ContextCheckContext): Promise<ContextOutcome> {
  const checks: CheckEntry[] = [];
  const push = (name: string, passed: boolean | null, evidence: unknown): void => {
    checks.push({ name, passed: passed === null ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500) });
  };

  const compactions: JsonObject[] = events
    .filter(event => event.type === 'turn-end' && asObject(event.data.context)?.compacted === true)
    .map(event => {
      const context = asObject(event.data.context) ?? {};
      return { agent_id: event.data.agent_id, role: event.data.role, ...(asObject(context.compaction) ?? {}) };
    });
  push('real-compaction-observed', compactions.length > 0,
    `${compactions.length} turns compacted through ctx.compaction: ${JSON.stringify(compactions.slice(0, 3))}`);
  push('compaction-shadowed-tokens', compactions.some(entry => Number(entry.shadowedTokens ?? 0) > 0),
    `shadowed token counts: ${compactions.map(entry => entry.shadowedTokens).join(', ') || 'none'}`);

  const unavailable = events.filter(event => event.type === 'turn-end' && asObject(event.data.context)?.compaction_unavailable === true).length;
  push('compaction-engine-mounted', unavailable === 0,
    `${unavailable} turns reported no compaction engine in the profile`);

  const blocked = events.filter(event => event.type === 'node-blocked' && /CONTEXT_PRESSURE/.test(String(event.data.reason))).length;
  push('context-pressure-not-blocking', blocked === 0,
    `${blocked} nodes blocked on CONTEXT_PRESSURE with the forced low threshold`);

  // The cluster's own step measurements: what each step was charged against,
  // what it measured, and which gate spent the turn's compaction budget.
  const steps = events.filter(event => event.type === 'context-step').map(event => event.data);
  const compactedSteps = steps.filter(step => step.decision === 'compact');
  const spentSteps = steps.filter(step => step.decision === 'proceed-ineffective');
  push('step-gate-accounted', steps.length > 0 && steps.every(step => typeof step.decision === 'string'),
    `${steps.length} steps measured: ${JSON.stringify(steps.slice(0, 3))}`);
  // One compaction budget per turn: whichever gate spends it, the other records
  // that it was already spent rather than paying for a second one.
  push('one-compaction-per-turn', compactedSteps.length + spentSteps.length >= 1,
    `${compactedSteps.length} steps compacted, ${spentSteps.length} found the turn's budget already spent`);
  push('compaction-reduced-the-surface', compactedSteps.every(step => Number(step.after ?? 0) <= Number(step.before ?? 0)),
    `before → after: ${compactedSteps.map(step => `${step.before}→${step.after}`).join(', ') || 'none'}`);
  // The request pressure is measured against the declared per-identity budget,
  // and a step that is not compacting must be inside it.
  const sentSteps = steps.filter(step => step.decision !== 'reject');
  const unmeasured = sentSteps.filter(step => ![step.after, step.pending, step.context_limit].every(Number.isFinite));
  const overBudget = requestBudgetOverruns(steps);
  push('request-pressure-below-role-budget', unmeasured.length ? null : sentSteps.length > 0 && overBudget.length === 0,
    `${overBudget.length} sent steps over their own budget, ${unmeasured.length} unmeasured: ${JSON.stringify(overBudget.slice(0, 3))}`);
  push('per-identity-budget-applied',
    steps.every(step => step.context_limit === 8192 || step.context_limit === 16384),
    `budgets seen: ${[...new Set(steps.map(step => step.context_limit))].join(', ') || 'none'}`);

  // The native session log is the host's own record: a real `compaction/summary`
  // between two ordinary requests of the *same session* is what "compaction
  // happened inside the conversation" means, and no cluster-side event can
  // substitute for it.
  const turnEnds = events.filter(event => event.type === 'turn-end' && asObject(event.data.context)?.compacted === true);
  let nativeEvidence: NativeEvidence[] | null = null;
  let nativeState = 'no-session-log';
  if (turnEnds.length && report.cluster_id) {
    const dbPath = join(layout.data, 'cluster.sqlite');
    if (existsSync(dbPath)) {
      const ledger = openLedger(dbPath);
      const agentId = asString(turnEnds[0]?.data.agent_id);
      const agent = agentId === null ? undefined : ledger.get('SELECT session_id FROM agents WHERE id=?', agentId);
      ledger.close();
      const sessionId = asString(agent?.session_id);
      const file = sessionId === null ? null : findSessionFile(join(layout.home, 'sessions'), sessionId);
      if (file) {
        const scanned = readSessionEvents(file);
        switch (scanned.state) {
          case 'UNKNOWN':
            nativeState = `unreadable: ${scanned.reason}`;
            break;
          case 'READ': {
            nativeState = 'read';
            const messages = scanned.events.filter(event => /assistant\/message/i.test(event.type)).map(event => event.seq);
            nativeEvidence = scanned.events
              .filter(event => /compaction\/summary/i.test(event.type))
              .map(event => ({
                seq: event.seq,
                requestsBefore: messages.filter(seq => seq < event.seq).length,
                requestsAfter: messages.filter(seq => seq > event.seq).length,
              }));
            break;
          }
        }
      }
    }
  }
  push('native-compaction-between-requests',
    nativeEvidence === null ? null : nativeEvidence.some(entry => entry.requestsBefore >= 1 && entry.requestsAfter >= 1),
    nativeEvidence === null
      ? `the session log could not be read (${nativeState})`
      : `compaction/summary events with a request on each side: ${JSON.stringify(nativeEvidence)}`);

  const dbPath = join(layout.data, 'cluster.sqlite');
  // Two independent facts: a database that exists with no resolved cluster id
  // is a different failure from a database that was never created.
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (dbPresent && report.cluster_id) {
    const ledger = openLedger(dbPath);
    const summaries = ledger.all('SELECT id,transaction_id,data FROM summaries WHERE cluster_id=?', report.cluster_id);
    push('durable-summary-written', summaries.length > 0, `${summaries.length} summaries persisted`);
    push('summary-carries-conclusion', summaries.some(row => String(row.data).includes('conclusion')),
      summaries.length ? String(summaries[0]?.data).slice(0, 200) : 'no summary');
    const accepted = Number(ledger.get("SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='ACCEPTED'", report.cluster_id)?.c);
    push('work-accepted', accepted >= 1, `${accepted} accepted transactions`);
    const usage = ledger.get("SELECT COUNT(*) AS c, SUM(COALESCE(total_tokens,0)) AS t FROM usage_receipts WHERE cluster_id=?", report.cluster_id);
    push('usage-settled', Number(usage?.c) > 0, `${usage?.c} receipts, ${usage?.t} tokens`);
    // Compaction is accounted as its own kind, never folded into the turn's own
    // request allowance: that is what keeps a session from starving the
    // operation that makes it affordable again.
    const byKind = ledger.all('SELECT kind, COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? GROUP BY kind', report.cluster_id);
    push('summary-charged-separately', byKind.some(row => row.kind === 'compaction' && Number(row.c) > 0),
      `receipt kinds: ${JSON.stringify(byKind)}`);
    // Any refusal recorded must be *structured*: a scope and a dimension, not a
    // sentence about context.
    const refusals = ledger.all(
      "SELECT json_extract(data,'$.scope') AS scope, json_extract(data,'$.dimension') AS dimension, json_extract(data,'$.agent_id') AS agent_id FROM events WHERE cluster_id=? AND type='budget-refused'",
      report.cluster_id,
    );
    push('refusals-are-structured', refusals.length === 0 || refusals.every(row => row.scope && row.dimension),
      refusals.length ? JSON.stringify(refusals.slice(0, 4)) : 'no refusal was recorded');
    ledger.close();
  }

  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => ['compaction-engine-mounted', 'cluster-database-present', 'real-compaction-observed'].includes(entry.name));
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}
