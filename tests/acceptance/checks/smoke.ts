/**
 * Smoke case checks: the mechanism works end to end on a tiny, fully
 * verifiable objective — real role turns, real worker tool calls, real
 * independent acceptance, no duplicated accounting.
 */
import { join } from 'node:path';
import { completeBuildHashes } from '../build-fingerprint.ts';

import { findSessionFile, readSessionEvents } from '../../../src/host/session-scan.ts';
import type { SessionEvent } from '../../../src/host/session-scan.ts';
import {
  asArray, asObject,
} from '../context.ts';
import type {
  CheckEntry, CheckOutcome, JsonObject, LedgerRow, LedgerScalar, RunEvent,
  RunSnapshot, SingleReply, StoneLedger,
} from '../context.ts';
import type { RunLayout } from '../../../src/host/types.ts';

const TERMINAL = new Set<string>(['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED']);

/**
 * The sum a transaction's own objective asks for. Parsed here, independently of
 * the mock scenario: the expected value must not come from the code that
 * produced the answer.
 */
function objectiveValues(text: unknown): number[] | null {
  const match = /\[\s*(-?\d+(?:\s*,\s*-?\d+)+)\s*\]/u.exec(String(text ?? ''));
  const values = match?.[1];
  return values ? values.split(',').map(value => Number(value.trim())) : null;
}

function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text ?? 'null'));
  } catch {
    return null;
  }
}

interface SmokeReport extends JsonObject {
  cluster_id?: string | null;
  build_hashes?: JsonObject | null;
  build_drift?: string | null;
  ledger?: Partial<StoneLedger> | null;
}

interface SmokeContext {
  workspace: string;
  report: SmokeReport;
  snapshot?: RunSnapshot | null;
  events: readonly RunEvent[];
  single?: SingleReply | null;
  layout?: RunLayout | null;
}

interface SessionProbe {
  state: string;
  events: SessionEvent[];
  reason?: string | null;
}

interface WorkerUsage {
  agent_id: LedgerScalar | undefined;
  sent: number;
  kinds: Record<string, number>;
}

export async function run({ report, snapshot, events, single, layout }: SmokeContext): Promise<CheckOutcome> {
  const checks: CheckEntry[] = [];
  const ledger: Partial<StoneLedger> = report.ledger ?? {};
  const transactions = snapshot?.transactions ?? [];
  const completed = transactions.filter(tx => tx.status === 'ACCEPTED');
  const sessionsRoot = layout ? join(layout.home, 'sessions') : null;

  checks.push(check('cluster-terminal', Boolean(report.cluster_id) && ['COMPLETED', 'BLOCKED', 'FAILED'].includes(snapshot?.cluster?.status ?? ''), `cluster status ${snapshot?.cluster?.status ?? 'missing'}`));
  checks.push(check('all-transactions-accepted', completed.length === transactions.length && transactions.length >= 2, `${completed.length}/${transactions.length} accepted`));

  // The sum each transaction owes is the one its own objective names, and the
  // value it submitted has to be the number a *real* flow_sum call in that
  // Worker's own session returned. Searching one concatenated blob for "5" and
  // "55" proved that the digits existed somewhere in the report.
  const allocations = ledger.allocations ?? [];
  const agents = new Map<LedgerScalar | undefined, LedgerRow>((ledger.agent_sessions ?? []).map(agent => [agent.id, agent]));
  const perTransaction = transactions.map(tx => {
    const values = objectiveValues(tx.objective ?? '');
    const allocation = allocations.find(entry => entry.transaction_id === tx.id && entry.agent_id);
    const agent = allocation ? agents.get(allocation.agent_id) : null;
    const sessionId = agent?.session_id;
    const sessionFile = sessionId && typeof sessionId === 'string' && sessionsRoot
      ? findSessionFile(sessionsRoot, sessionId) : null;
    const sessionRead: SessionProbe = sessionFile ? readSessionEvents(sessionFile) : { state: 'MISSING', events: [] };
    // An unreadable session is UNKNOWN, never "the call is not there": the
    // round trip is only proven from a session that really was read.
    if (sessionRead.state !== 'READ') return { transaction_id: tx.id, expected: null, verified: false, session_state: sessionRead.state, reason: sessionRead.reason };
    const sessionEvents = sessionRead.events;
    const call = sessionEvents.find(event => event.type === 'tool/call' && asObject(event.data)?.name === 'flow_sum');
    const callData = call ? asObject(call.data) : null;
    const callArguments = call ? asObject(parseJson(callData?.arguments)) : null;
    const callValues = asArray(callArguments?.values);
    const callId = callData?.callId;
    const result = sessionEvents.find(event => {
      const data = asObject(event.data);
      const message = asObject(data?.message);
      return event.type === 'tool/result' && message?.toolCallId === callId;
    });
    const resultMessage = asObject(asObject(result?.data)?.message);
    const resultContent = asArray(resultMessage?.content);
    const resultText = resultContent?.map(part => String(asObject(part)?.text ?? '')).join('') ?? null;
    const toolValue = resultText === null ? null : Number(String(resultText).trim());
    const expected = values ? values.reduce((total, value) => total + value, 0) : null;
    const resultRecord = asObject(tx.result);
    const submitted = typeof tx.result === 'object' && tx.result !== null ? resultRecord?.sum ?? null : tx.result ?? null;
    return {
      transaction_id: tx.id, expected, submitted, tool_value: toolValue,
      call_values: callValues ?? null, call_id: callId ?? null,
      session: sessionFile ? sessionId : null, agent_id: allocation?.agent_id ?? null,
      verified: values !== null && expected !== null && Number(submitted) === expected && toolValue === expected
        && callValues !== null && callValues.length === values.length
        && callValues.every((value, index) => value === values[index]),
    };
  });
  checks.push(check('sums-verified',
    perTransaction.length >= 2 && perTransaction.every(entry => entry.verified),
    `per transaction: ${JSON.stringify(perTransaction)}`));
  checks.push(check('sum-work-not-recomputed',
    perTransaction.every(entry => entry.tool_value !== null),
    `every transaction's value is the result of a real flow_sum call in its own Worker session`));

  const roleTurns = events.filter(event => event.type === 'turn-end' && event.data.role !== 'worker').length;
  const workerTurns = events.filter(event => event.type === 'turn-end' && event.data.role === 'worker').length;
  checks.push(check('roles-ran', roleTurns >= 3, `${roleTurns} management role turns`));
  checks.push(check('workers-ran', workerTurns >= 2, `${workerTurns} worker turns`));

  // The independent gate is the *result* gate: every acceptance must be an
  // Auditor decision, evidenced by an approved validation audit for a transaction.
  // Plan audits provide supervision: the Auditor may approve, reject, or leave
  // one undecided while the work runs. Acceptance requires validation approval.
  const requested = events.filter(event => event.type === 'dispatched' && event.data.audit_id).length;
  const acceptedEvents = events.filter(event => event.type === 'result-accepted').length;
  const validationApprovals = (ledger.audits ?? []).filter(row => row.kind === 'validation' && row.decision === 'APPROVED').reduce((sum, row) => sum + Number(row.c), 0);
  checks.push(check('auditor-gated',
    requested >= transactions.length && acceptedEvents >= transactions.length && validationApprovals >= transactions.length,
    `${requested} plan audits requested, ${validationApprovals} approved validation audits, ${acceptedEvents} accepted results for ${transactions.length} transactions`));

  // Successful smoke execution cannot withhold a Worker result.
  const withheld = events.filter(event => event.type === 'result-withheld').length;
  checks.push(check('no-result-withheld', withheld === 0, `${withheld} withheld results`));
  // Worker request limits include every provider request:
  // a Worker's compaction is a provider request too, and it is recorded under that
  // Worker with `kind='compaction'`. Every sent kind is summed per identity.
  const byWorker = new Map<LedgerScalar | undefined, WorkerUsage>();
  for (const row of ledger.usage_by_agent ?? []) {
    if (row.role !== 'worker') continue;
    const key = row.agent_id;
    const entry = byWorker.get(key) ?? { agent_id: key, sent: 0, kinds: {} };
    entry.sent += Number(row.sent ?? 0);
    const kind = String(row.kind);
    entry.kinds[kind] = (entry.kinds[kind] ?? 0) + Number(row.sent ?? 0);
    byWorker.set(key, entry);
  }
  const workers = [...byWorker.values()];
  const overAllowance = workers.filter(entry => entry.sent > 2);
  checks.push(check('worker-request-allowance', workers.length === 0 || overAllowance.length === 0,
    `per Worker provider requests (all kinds): ${JSON.stringify(workers.map(entry => ({ sent: entry.sent, kinds: entry.kinds })))}`));
  // The fingerprint itself is what this check can see: `not_comparable` is
  // decided by the runner's *final* comparison, and `runChecks` runs before it —
  // so requiring the flag here would let a mixed-build run pass. The runner
  // publishes the drift it measured *before* the checks (`build_drift`), and that
  // is what is asserted.
  const hashes = report.build_hashes ?? null;
  const hashesComplete = completeBuildHashes(hashes);
  // Three explicit cases, never conflated: an incomplete fingerprint is a
  // failure, a report without the measurement is UNKNOWN, a measured equal
  // fingerprint passes and a measured different one fails.
  const measured = report.build_drift !== undefined;
  const hashPassed = !hashesComplete ? false : (measured ? report.build_drift === null : null);
  checks.push(check('build-hashes-recorded', hashPassed,
    `build_hashes ${JSON.stringify(Object.keys(hashes ?? {}))}; ${measured ? `drift=${JSON.stringify(report.build_drift)}` : 'drift was not measured before the checks'}`));

  // Distinctness is a property of the native sessions, not of the transaction
  // ids: comparing ids the runner generated proved nothing about whether two
  // Workers shared one session.
  const workerSessions = perTransaction.map(entry => entry.session).filter(Boolean);
  checks.push(check('worker-sessions-distinct', workerSessions.length >= 2 && new Set(workerSessions).size === workerSessions.length,
    `${workerSessions.length} worker session(s): ${JSON.stringify(workerSessions)}`));

  // The contract is "no request is unaccounted", not "the provider always
  // reports usage". A stream that ends without usage is recorded as UNKNOWN with
  // its reservation retained and a reason — that *is* accounting, and treating it
  // as a mechanism failure turned a provider hiccup into a red gate. What must
  // never happen is a receipt that stays RESERVED at rest, or an UNKNOWN with no
  // reason recorded.
  const receiptStates = ledger.usage_states ?? [];
  const reservedAtRest = receiptStates.find(row => row.status === 'RESERVED')?.c ?? 0;
  const unknownsWithoutReason = ledger.usage_unknown_without_note ?? 0;
  const unsettled = ledger.usage?.unknown_requests ?? 0;
  checks.push(check('usage-settled',
    (ledger.usage?.requests ?? 0) > 0 && reservedAtRest === 0 && unknownsWithoutReason === 0,
    `${ledger.usage?.requests ?? 0} receipts ${JSON.stringify(receiptStates.map(row => `${row.status}:${row.c}`))}, ${unsettled} without provider usage (each carries its reason)`));

  checks.push(check('no-duplicate-accounting', (ledger.duplicate_charges ?? 0) === 0 && (ledger.duplicate_accepts ?? 0) === 0,
    `duplicate charges ${ledger.duplicate_charges ?? 0}, duplicate accepts ${ledger.duplicate_accepts ?? 0}`));
  checks.push(check('no-double-lease', (ledger.double_leases ?? 0) === 0, `double leases ${ledger.double_leases ?? 0}`));
  checks.push(check('no-lost-transactions', (ledger.lost_transactions ?? 0) === 0, `non-terminal transactions ${ledger.lost_transactions ?? 0}`));

  const agentRoles = new Set((snapshot?.agents ?? []).filter(agent => (agent.turns ?? 0) > 0).map(agent => agent.role));
  checks.push(check('three-roles-activated', ['orchestrator', 'allocator', 'auditor', 'worker'].every(role => agentRoles.has(role)),
    `activated roles: ${[...agentRoles].sort().join(', ')}`));

  if (single) {
    checks.push(check('single-control-ran', typeof single.finalText === 'string' && single.finalText.length > 0, `single output length ${single.finalText?.length ?? 0}`));
  }

  // `null` is "not measured": it is not a failure, and it must not make the case
  // look failed either.
  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => ['no-duplicate-accounting', 'no-double-lease', 'no-lost-transactions', 'usage-settled'].includes(entry.name));
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}

function check(name: string, passed: boolean | null | undefined, evidence: unknown): CheckEntry {
  // Three states, as every check keeps: an invariant that could not be measured
  // is `null`, never `false`. Coercing here turned "not measured" into "failed".
  return { name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2000) };
}

export { TERMINAL, check };
