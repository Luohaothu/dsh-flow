/**
 * Scale case checks: prove that planned work really became real, distinct,
 * model-backed execution, and that the control plane stayed inside its
 * declared bounds.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalScopeEntry } from '../../../src/adapter/scope.js';
import { openLedger, usageSummary, pendingWork, workerActivation, concurrencyPeaks, writeScopeAnalysis } from '../../../src/host/ledger.mjs';

/**
 * The file a tier transaction was created for, from the runner's frozen spec.
 *
 * Never from `transactions.inputs`: `adjust_transaction` may legally replace
 * those during a run, so an oracle that read them could have its expectation
 * moved by the very run it is grading. A transaction the spec does not name has
 * no grant at all, and must not silently fall back to the live row.
 */
export function frozenGrantedFile(specEntries, transactionId) {
  const entry = (specEntries ?? []).find(candidate => candidate?.id === transactionId) ?? null;
  const inputs = entry?.inputs ?? {};
  return inputs.file ?? inputs.path ?? null;
}

/**
 * The corpus path a settled `read` receipt proved, or null.
 *
 * `dispatch_status: 'SETTLED'` means the *call* finished, not that the tool
 * succeeded: an errored read also settles (measured: a malformed-argument call
 * settles with `isError: true` and no content). A path is only evidence when the
 * receipt carries a successful result and no transport error.
 */
export function successfulReadPath(receipt) {
  if (!receipt || receipt.error) return null;
  let parsed = null;
  try { parsed = JSON.parse(String(receipt.result_body ?? '')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.isError !== false) return null;
  const claimed = /<path>([^<]+)<\/path>/u.exec(String(parsed.text ?? ''))?.[1] ?? null;
  return claimed ?? null;
}

const TERMINAL = new Set(['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED']);

export function scaleValidation(tier, planned, terminal, activated, requiredWorkers, failedChecks) {
  return planned === tier && terminal === planned && activated >= requiredWorkers && failedChecks === 0
    ? 'VERIFIED' : 'INCOMPLETE';
}

/**
 * Does a submitted result answer the question its own transaction asked?
 *
 * The granted file is the transaction's frozen input; the expected symbol and
 * line come from that file. A result that names another file — or a symbol that
 * does not occur in the granted one — is wrong even when it is an accurate
 * description of some *other* file in the corpus, which is exactly the
 * confusion the earlier oracle could not see.
 */
export function resultMatchesGrant({ file, symbol, line, grantedFile, expected }) {
  if (!grantedFile || !expected) return false;
  if (String(file ?? '') !== String(grantedFile)) return false;
  return String(symbol ?? '') === String(expected.symbol) && Number(line) === Number(expected.line);
}

/**
 * One *distinct* Worker per tier file. An agent that was granted two files is
 * one identity answering twice, which is not the tier's claim even when both
 * answers are correct.
 */
export function distinctWorkersCoverFiles(tierIds, tierAgents) {
  const agents = tierIds.map((_, index) => tierAgents[index] ?? null);
  return agents.length > 0 && agents.every(Boolean) && new Set(agents).size === agents.length;
}


export async function run({ caseDef, workspace, report, layout, events }) {
  const checks = [];
  const push = (name, passed, evidence) => checks.push({
    name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
  });
  const dbPath = join(layout.data, 'cluster.sqlite');
  // Two independent facts: a database that exists with no resolved cluster id
  // is a different failure from a database that was never created.
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (!dbPresent || !report.cluster_id) {
    return { checks, scenario_status: 'FAILED', failure_class: 'MECHANISM', scale_validation: 'INCOMPLETE' };
  }
  const ledger = openLedger(dbPath);
  const clusterId = report.cluster_id;
  const limits = report.spec?.limits ?? {};
  const fixture = caseDef.scale_fixture ?? {};
  const plannedFromSpec = (report.spec?.initial_transactions ?? []).length;
  const tier = plannedFromSpec || (fixture.workers ?? 1024);
  // A *mock* tier must activate every file's Worker: the fixture is fixed, so
  // "90% of the workers ran" is a partial pass with no excuse. A live tier keeps
  // the weaker bar, which measures model behaviour rather than mechanism, and
  // says so in its evidence.
  const mockScoped = report.validation_mode === 'mock-api';
  const requiredWorkers = mockScoped
    ? tier
    : tier >= 1000 ? (fixture.assertions?.minimum_real_llm_workers ?? 1000) : Math.max(1, Math.ceil(tier * 0.9));

  const activation = workerActivation(ledger, clusterId);
  const workersWithRequests = activation.activated;
  const workersWithTurns = activation.with_turns;
  const workerCount = activation.created;

  // The *tier's* denominator is the fixture the runner started, by id: a model
  // that also spawns a management node (and the delegated transaction that comes
  // with it) has done extra work, which is reported separately rather than
  // silently folded into — or counted against — the tier.
  const tierIds = (report.spec?.initial_transactions ?? []).map(entry => entry.id);
  const placeholders = tierIds.map(() => '?').join(',');
  const planned = tierIds.length
    ? ledger.get(`SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND id IN (${placeholders})`, clusterId, ...tierIds).c
    : 0;
  const terminal = tierIds.length
    ? ledger.get(
      `SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND id IN (${placeholders}) AND status IN ('ACCEPTED','FAILED','CANCELLED','SUPERSEDED','BLOCKED')`,
      clusterId, ...tierIds).c
    : 0;
  const byStatus = ledger.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId);
  const extra = ledger.get(
    `SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=?${tierIds.length ? ` AND id NOT IN (${placeholders})` : ''}`,
    clusterId, ...tierIds).c;

  push('fixture-planned', planned === tier, `${planned} of the tier's ${tier} transactions exist in the cluster`);
  push('every-transaction-terminal', planned > 0 && terminal === planned,
    `${terminal}/${planned} of the tier's transactions are terminal: ${JSON.stringify(byStatus)}${extra ? ` (plus ${extra} the model added on its own)` : ''}`);
  push('real-llm-workers', workersWithRequests >= requiredWorkers,
    `${workersWithRequests} of ${workerCount} created workers dispatched a real model request (tier requires ${requiredWorkers})`);
  push('workers-actually-ran', workersWithTurns >= requiredWorkers,
    `${workersWithTurns} workers executed a turn (tier requires ${requiredWorkers})`);

  const duplicateCharges = ledger.get('SELECT COUNT(*) AS c FROM (SELECT request_id FROM usage_receipts WHERE cluster_id=? GROUP BY request_id HAVING COUNT(*)>1)', clusterId).c;
  push('no-duplicate-charges', duplicateCharges === 0, `${duplicateCharges} duplicated request ids`);

  // §9 asks the tier for "越 scope 写入 0". An escaped write is a proven
  // settled write outside its identity's grant; prevented attempts are the
  // sandbox working and are reported as their own number. With no write-capable
  // call settled the invariant is unmeasured, not satisfied.
  const scoped = ledger.all('SELECT agent_id, write_scope, write_scope_canonical FROM allocations WHERE cluster_id=?', clusterId);
  const writeEffects = ledger.all("SELECT agent_id, tool, args, status FROM effects WHERE cluster_id=? AND status='SETTLED' AND tool IN ('write','edit')", clusterId);
  const writeScope = writeScopeAnalysis({ allocations: scoped, effects: writeEffects, workspace });
  const prevented = ledger.get("SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='write-refused'", clusterId).c;
  push('no-out-of-scope-writes',
    writeScope.escapes.length ? false : (writeScope.settled_writes === 0 ? null : (writeScope.unmeasured ? null : true)),
    writeScope.settled_writes === 0
      ? `not exercised by this case: 0 settled write-capable calls (the tier only reads files); the write contract is proven by the recursion and negative cases (${prevented} refused attempt(s) recorded)`
      : `${writeScope.escapes.length} escaped write(s) among ${writeScope.checked} checked settled write call(s); ${prevented} out-of-scope attempt(s) refused${writeScope.unmeasured ? `; ${writeScope.unmeasured}` : ''}`);

  const usage = usageSummary(ledger, clusterId);
  // "Accounted" means every request reached a terminal receipt state with its
  // outcome named — not that a provider always reported usage. A request that
  // was aborted mid-flight genuinely has an unknown cost, and this ledger
  // records it as UNKNOWN with its token hold retained and its reason attached;
  // demanding `unknown_requests === 0` would force that request to be booked at
  // zero instead.
  const receiptStates = ledger.all('SELECT status, COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? GROUP BY status', clusterId);
  const reservedAtRest = Number(receiptStates.find(row => row.status === 'RESERVED')?.c ?? 0);
  const unexplained = Number(ledger.get("SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND status='UNKNOWN' AND (note IS NULL OR note='')", clusterId).c);
  push('usage-accounted',
    usage.requests > 0 && reservedAtRest === 0 && unexplained === 0,
    `${JSON.stringify(usage)}; receipts ${JSON.stringify(receiptStates.map(row => `${row.status}:${row.c}`))}; ${unexplained} unknown without a reason`);

  const roles = ledger.all("SELECT role, COUNT(*) AS c, SUM(CASE WHEN turns>0 THEN 1 ELSE 0 END) AS activated FROM agents WHERE cluster_id=? GROUP BY role", clusterId);
  const management = roles.filter(row => row.role !== 'worker');
  push('management-roles-ran', management.length === 3 && management.every(row => row.activated > 0), JSON.stringify(roles));

  // A control-plane tool call that was refused at *lookup* time ("no plan audit
  // for transaction … at revision …") is not a domain refusal: it means the
  // caller asked about a revision nothing was offered for, or under a reference
  // the item did not carry. The fixture used to send verdicts without the
  // offered `audit_id`, so every verdict on a revised plan resolved to the
  // transaction's *current* revision and missed. Nothing in a healthy run should
  // be refused for a reason the caller was already told.
  const controlCalls = ledger.all(
    "SELECT tool, result_body, error FROM tool_call_receipts WHERE cluster_id=? AND tool IN ('flow_audit','flow_transaction','flow_allocation','flow_query')",
    clusterId,
  );
  const lookupRefusals = controlCalls.filter(row => {
    if (row.error) return true;
    let text = String(row.result_body ?? '');
    try { const parsed = JSON.parse(text); if (parsed?.isError === false) return false; text = parsed?.text ?? text; } catch { /* raw text */ }
    return /no plan audit|no validation audit|is a \w+ audit, not|audit requires audit_id|no .* audit for transaction/i.test(text);
  });
  push('control-plane-calls-clean',
    mockScoped ? controlCalls.length > 0 && lookupRefusals.length === 0 : null,
    mockScoped
      ? `${controlCalls.length} control-plane call(s), ${lookupRefusals.length} refused for a missing or mismatched audit reference: ${JSON.stringify(lookupRefusals.slice(0, 2))}`
      : 'not asserted outside a mock run');

  // The corpus must exist with the recorded hashes, and every worker that
  // claims to have read a file must have really called the read tool.
  const datasetPath = join(workspace, caseDef.dataset?.file ?? 'dataset.json');
  if (existsSync(datasetPath)) {
    const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
    const selected = dataset.entries.slice(0, tier);
    const missing = selected.filter(entry => !existsSync(join(workspace, entry.workspace_path)));
    const mismatched = selected.filter(entry => {
      const path = join(workspace, entry.workspace_path);
      if (!existsSync(path)) return false;
      return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` !== entry.hash;
    });
    push('corpus-materialized', missing.length === 0 && mismatched.length === 0,
      `${selected.length} files in the workspace, ${missing.length} missing, ${mismatched.length} hash mismatches`);
  } else {
    push('corpus-materialized', false, `no dataset at ${datasetPath}`);
  }

  const readTurns = events.filter(event => event.type === 'turn-end' && (event.data.tools_used ?? []).includes('read'));
  push('workers-really-read-files', readTurns.length >= requiredWorkers,
    `${readTurns.length} worker turns recorded a real read call (tier requires ${requiredWorkers})`);

  // The expected answer for every tier transaction is a property of the corpus
  // the runner generated, read here from the files themselves: the first
  // `export function <name>` and the line it sits on. The comparison is against
  // the file, never against anything the model — or the mock — reported.
  const expectedFor = relativePath => {
    const absolute = join(workspace, relativePath);
    if (!existsSync(absolute)) return null;
    const lines = readFileSync(absolute, 'utf8').split('\n');
    const index = lines.findIndex(line => /^\s*export\s+function\s+\w+/u.test(line));
    if (index < 0) return null;
    return { symbol: /^\s*export\s+function\s+(\w+)/u.exec(lines[index])[1], line: index + 1 };
  };
  const tierRows = tierIds.length
    ? ledger.all(`SELECT id,status,result,inputs FROM transactions WHERE cluster_id=? AND id IN (${placeholders})`, clusterId, ...tierIds)
    : [];
  // The file a tier transaction was created for comes from the **frozen spec**
  // the runner generated (`report.spec.initial_transactions`), never from the
  // ledger's `transactions.inputs`: `adjust_transaction` may legally replace
  // `inputs` mid-run, so grading against them let a rewritten assignment move
  // the question instead of failing the answer.
  const specEntries = report.spec?.initial_transactions ?? [];
  const liveInputsByTx = new Map(tierRows.map(row => {
    let inputs = {};
    try { inputs = JSON.parse(row.inputs ?? '{}'); } catch { inputs = {}; }
    return [row.id, inputs.file ?? inputs.path ?? null];
  }));
  const grantedFileByTx = new Map(tierIds.map(id => [id, frozenGrantedFile(specEntries, id)]));
  const unspecified = tierIds.filter(id => !grantedFileByTx.get(id));
  const rewritten = tierIds.filter(id => {
    const frozen = grantedFileByTx.get(id);
    return frozen && liveInputsByTx.get(id) !== null && liveInputsByTx.get(id) !== frozen;
  });
  push('transactions-keep-their-frozen-assignment',
    mockScoped ? (tier > 0 && unspecified.length === 0 && rewritten.length === 0) : null,
    mockScoped
      ? `${tierIds.length} tier transaction(s): ${unspecified.length} absent from the frozen spec, ${rewritten.length} whose live inputs no longer name the granted file${rewritten.length ? `: ${JSON.stringify(rewritten.slice(0, 3))}` : ''}`
      : 'not asserted outside a mock run');
  const exact = tierRows.map(row => {
    let parsed = null;
    try { parsed = JSON.parse(row.result ?? 'null'); } catch { parsed = null; }
    const relative = parsed ? String(parsed.file ?? parsed.path ?? '') : '';
    const granted = grantedFileByTx.get(row.id) ?? null;
    const expected = granted ? expectedFor(granted) : null;
    return {
      id: row.id, status: row.status, granted_file: granted,
      submitted: parsed ? { file: relative, symbol: parsed.symbol ?? null, line: parsed.line ?? null } : null,
      expected,
      ok: row.status === 'ACCEPTED' && resultMatchesGrant({
        file: relative, symbol: parsed?.symbol, line: parsed?.line, grantedFile: granted, expected,
      }),
    };
  });
  const wrongFile = exact.filter(entry => entry.submitted && entry.submitted.file !== entry.granted_file);
  push('results-name-the-granted-file', mockScoped ? (tier > 0 && wrongFile.length === 0) : null,
    mockScoped
      ? `${exact.length - wrongFile.length}/${exact.length} results answered for the file their transaction was granted; answers for another file: ${JSON.stringify(wrongFile.slice(0, 3))}`
      : 'not asserted outside a mock run');
  const exactMatches = exact.filter(entry => entry.ok);
  push('per-file-results-exact', mockScoped ? (tier > 0 && exactMatches.length === tier) : null,
    mockScoped
      ? `${exactMatches.length}/${tier} tier results name the file's real symbol and the line it sits on; first mismatches: ${JSON.stringify(exact.filter(entry => !entry.ok).slice(0, 3))}`
      : 'not asserted outside a mock run: a live model may legitimately answer "unknown" for a file');
  const symbolsFound = exact.filter(entry => entry.submitted?.symbol && entry.submitted.symbol !== 'unknown'
    && entry.expected && entry.submitted.symbol === entry.expected.symbol).length;
  push('symbols-exist-in-the-files',
    mockScoped ? null : (exact.length === 0 || symbolsFound >= Math.ceil(exact.length * 0.5)),
    `${symbolsFound}/${exact.length} submitted results name a symbol that really occurs in the file${mockScoped ? ' (the mock tier is held to `per-file-results-exact` instead)' : ''}`);

  // One Worker per file, each of them a *distinct* identity that really called
  // the read tool: "some Worker read something" is not the tier's claim.
  const allocationRows = ledger.all('SELECT agent_id, transaction_id, created FROM allocations WHERE cluster_id=? ORDER BY created', clusterId);
  const firstAgentByTx = new Map();
  for (const row of allocationRows) if (!firstAgentByTx.has(row.transaction_id)) firstAgentByTx.set(row.transaction_id, row.agent_id);
  const tierAgents = tierIds.map(id => firstAgentByTx.get(id) ?? null);
  const readAgents = new Set(events
    .filter(event => event.type === 'turn-end' && (event.data.tools_used ?? []).includes('read'))
    .map(event => event.data.agent_id));
  // A read of *any* file is not the tier's claim: each transaction's Worker must
  // have read the file that transaction was granted. The evidence is the settled
  // `read` receipt's own successful result — the path the native read tool
  // reported, from a call that did not error.
  const readPathsByAgent = new Map();
  const failedReads = [];
  for (const receipt of ledger.all(
    "SELECT agent_id, result_body, error, dispatch_status FROM tool_call_receipts WHERE cluster_id=? AND tool='read'", clusterId,
  )) {
    if (receipt.dispatch_status !== 'SETTLED') continue;
    const claimed = successfulReadPath(receipt);
    if (claimed === null) {
      failedReads.push({ agent: String(receipt.agent_id ?? '').slice(0, 8), error: receipt.error ?? null, body: String(receipt.result_body ?? '').slice(0, 80) });
      continue;
    }
    const canonical = canonicalScopeEntry(workspace, claimed);
    if (!canonical) continue;
    const list = readPathsByAgent.get(receipt.agent_id) ?? new Set();
    list.add(canonical);
    readPathsByAgent.set(receipt.agent_id, list);
  }
  push('reads-succeeded',
    mockScoped ? failedReads.length === 0 : null,
    mockScoped
      ? `${failedReads.length} settled read receipt(s) carried no successful result: ${JSON.stringify(failedReads.slice(0, 2))}`
      : 'not asserted outside a mock run');

  const distinctAgents = new Set(tierAgents.filter(Boolean));
  const readTheGrantedFile = tierIds.filter((id, index) => {
    const agent = tierAgents[index];
    const granted = grantedFileByTx.get(id);
    if (!agent || !granted) return false;
    const canonical = canonicalScopeEntry(workspace, join(workspace, granted));
    return Boolean(canonical) && readPathsByAgent.get(agent)?.has(canonical);
  });
  push('one-distinct-worker-per-file',
    mockScoped
      ? (distinctWorkersCoverFiles(tierIds, tierAgents)
        && readTheGrantedFile.length === tier && tierAgents.every(agent => readAgents.has(agent)))
      : null,
    mockScoped
      ? `${distinctAgents.size} distinct Worker(s) for ${tier} tier file(s); ${readTheGrantedFile.length} of them opened the file their transaction was granted; ${tierAgents.filter(agent => agent && readAgents.has(agent)).length} recorded a read call`
      : 'not asserted outside a mock run');

  // The ceiling was not merely respected, it was *reached* and then held: the
  // runner kept exactly `max_llm_concurrency` Worker requests open at once and
  // watched whether a further request could arrive. That is the fixture's own
  // account of the plugin's concurrency, not a number the plugin reports about
  // itself.
  const mockPeak = report.mock_concurrency?.peak_concurrent_requests ?? null;
  const probe = report.concurrency_probe ?? null;
  push('provider-ceiling-actually-reached',
    mockScoped
      ? Boolean(probe) && probe.held_simultaneously === Math.min(probe.ceiling, tier)
        && probe.requests_while_held === 0 && mockPeak !== null && mockPeak <= probe.ceiling
      : null,
    mockScoped
      ? (probe
        ? `held ${probe.held_simultaneously} of ${probe.ceiling} allowed request(s) open for ${probe.window_ms}ms; ${probe.requests_while_held} further request(s) arrived while they were held; the fixture's own peak was ${mockPeak}`
        : 'the run recorded no concurrency probe')
      : 'not asserted outside a mock run');

  const pending = pendingWork(ledger, clusterId);
  // A tier that stopped for a declared reason (its own deadline, or a coded
  // budget stop) is expected to leave the in-flight turn where it was: "at rest"
  // is only a requirement for a cluster that claims to be finished.
  const hitWall = (report.wall_time_ms ?? 0) >= (report.spec?.budget?.wall_time_ms ?? Infinity) * 0.9;
  const stopped = hitWall || ['BLOCKED', 'FAILED', 'CANCELLED'].includes(report.ledger?.cluster_status ?? '');
  const atRest = stopped ? null : pending.leases.length === 0;
  push('no-leftover-leases', atRest,
    `${pending.leases.length} live leases at rest${stopped ? ` (the cluster stopped: ${report.ledger?.cluster_status}${hitWall ? ', at its wall deadline' : ''})` : ''}`);
  push('no-stuck-agents', stopped ? null : pending.running_agents.length === 0,
    `${pending.running_agents.length} agents still RUNNING at rest${stopped ? ` (the cluster stopped: ${report.ledger?.cluster_status})` : ''}`);

  const concurrency = measureConcurrency(events);
  // Two different ceilings, measured two different ways: resident *turns* come
  // from the turn-start/turn-end pairs, while provider requests in flight come
  // from the receipt intervals. Comparing turn overlap against the LLM window
  // would fail a compliant run whenever more agents are resident than the model
  // window allows — which is the normal case.
  const llmCeiling = limits.max_llm_concurrency ?? 2;
  const peaks = concurrencyPeaks(ledger, clusterId);
  const inflight = peaks.provider_inflight_peak ?? maxInFlight(ledger, clusterId);
  push('qwen-inflight-within-limit', inflight === null ? null : inflight <= llmCeiling,
    inflight === null
      ? 'no request intervals were recorded to measure in-flight concurrency'
      : `observed max in-flight provider requests ${inflight} against max_llm_concurrency ${llmCeiling}`);
  const residentPeak = peaks.resident_peak ?? concurrency.maxResident;
  push('resident-turns-within-limit', residentPeak === null ? null : residentPeak <= (limits.max_active_agents ?? 9),
    `observed max resident turn handles ${residentPeak} against max_active_agents ${limits.max_active_agents ?? 9}`);

  const queue = queueLatency(events);
  const apiCost = ledger.get(
    "SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND total_tokens IS NOT NULL AND status='SETTLED'", clusterId).c;
  ledger.close();

  const metrics = {
    tier,
    planned,
    terminal,
    workers_created: workerCount,
    workers_with_requests: workersWithRequests,
    workers_with_turns: workersWithTurns,
    activation: { created: workerCount, activated: workersWithRequests, with_turns: workersWithTurns },
    usage,
    concurrency,
    // Zero samples are reported as `null`, never as the first element of an
    // empty list or as 0ms of queueing.
    queue_wait_ms: queue,
    peaks: { resident_peak: residentPeak, provider_inflight_peak: inflight, samples: peaks },
    api_cost: { amount: 0, currency: 'USD', pricing: 'local-unpriced', priced_receipts: 0, unpriced_receipts: apiCost },
    by_status: byStatus,
  };
  // The metrics file belongs to the *live* run that is writing its report at the
  // end of the case. A checker re-run over a finished artifact must not write
  // into it: historical runs are read-only evidence, and re-deriving their files
  // with changed checks rewrites history. A finished run is exactly one that
  // already has its report on disk.
  if (!existsSync(join(layout.root, 'report.json'))) {
    writeFileSync(join(layout.root, 'scale-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  }

  const failed = checks.filter(entry => entry.passed === false);
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    // The class is *derived* from structured, persisted blocking causes, never
    // written as a constant: a run blocked by context pressure is a mechanism
    // failure even when it also spent a lot of its budget.
    failure_class: failed.length === 0 ? null : deriveFailureClass({ ledger: report.ledger ?? {}, report, failed }),
    scale_validation: scaleValidation(tier, planned, terminal, workersWithRequests, requiredWorkers, failed.length),
    // The measured cost of one file, so a tier's feasibility is a number the
    // report carries rather than an assumption made elsewhere. A tier with no
    // identified worker costs `null`, not an Infinity-by-division artefact.
    measured_per_file: planned > 0 && (usage.requests ?? 0) > 0
      ? {
        model_requests: Number(((usage.requests ?? 0) / planned).toFixed(2)),
        prompt_tokens_per_request: Math.round((usage.prompt_tokens ?? 0) / (usage.requests ?? 1)),
        tokens: Math.round((usage.total_tokens ?? 0) / planned),
        tokens_per_activated_worker: workersWithTurns > 0 ? Math.round((usage.total_tokens ?? 0) / workersWithTurns) : null,
      }
      : null,
    metrics,
  };
}

/**
 * Derive the failure class from structured evidence, in priority order.
 *
 * Free text is never the classifier: a mechanism blocker recorded by the plugin
 * (a structured `cluster-blocked` code, a refused budget dimension) outranks an
 * exhausted cap, which outranks an unreachable dependency, which outranks a
 * mechanism that worked but produced an unacceptable artifact.
 */
export function deriveFailureClass({ ledger, report, failed }) {
  if (!failed?.length) return null;
  const names = new Set(failed.map(entry => entry.name));
  if (names.has('cluster-database-present') || names.has('cluster-id-resolved')) return 'MECHANISM';
  const blockers = ledger.blockers ?? [];
  const codes = new Set(blockers.map(blocker => (typeof blocker.code === 'string' ? blocker.code.toUpperCase() : '')).filter(Boolean));
  const reason = String(ledger.blocked_reason ?? '');
  const MECHANISM_CODES = [
    'CONTEXT_PRESSURE', 'SESSION_MISSING', 'DELIVERY_UNKNOWN', 'EFFECT_UNCERTAIN',
    'ACCOUNTING_UNCERTAIN', 'WRITE_SCOPE', 'PERMISSION', 'FENCE', 'TOOL_IDENTITY_MISSING',
  ];
  const LIMIT_CODES = ['BUDGET_EXHAUSTED', 'LIMIT_REACHED', 'DEADLINE_PASSED'];
  // The order is the contract (§1.6-1.7): a mechanism defect outranks a limit,
  // which outranks the environment, which outranks the model. A stop that is
  // *both* fenced and out of budget is a mechanism failure first — the fence is
  // the defect, the budget is what it ran out of.
  if ([...codes].some(code => MECHANISM_CODES.includes(code) || code.startsWith('CONTEXT_'))) return 'MECHANISM';
  // Textual evidence is read by *prefix* only: a sentence that mentions a budget
  // somewhere inside it is prose, and prose is not a limit.
  if (/^(CONTEXT_PRESSURE|SESSION_MISSING|DELIVERY_UNKNOWN|EFFECT_UNCERTAIN|ACCOUNTING_UNCERTAIN|FENCE|WRITE_SCOPE)\b/.test(reason.trim())) return 'MECHANISM';
  // The cluster's own coded reasons are read from both `cluster-blocked` and
  // `node-blocked` events: a subtree that could not pay for its next request
  // stops with the code even when the root keeps running.
  if ([...codes].some(code => LIMIT_CODES.includes(code))) return 'LIMIT_REACHED';
  if (blockers.some(blocker => /^(BUDGET|LIMIT_REACHED):/.test(String(blocker.reason ?? '').trim()))) return 'LIMIT_REACHED';
  if (/^(BUDGET|LIMIT_REACHED):/.test(reason.trim())) return 'LIMIT_REACHED';
  const limit = report.limit_reached;
  if (limit && (limit.hitWall || (limit.refusals ?? []).length > 0)) return 'LIMIT_REACHED';
  if (report.environment_failure) return 'ENVIRONMENT';
  // A missing corpus or an unreachable browser is the environment, not the
  // mechanism and not the model.
  if (names.has('corpus-materialized') || names.has('host-served-web-url') || names.has('browser-available')) return 'ENVIRONMENT';
  return 'MODEL_OUTPUT';
}

/** Derive turn overlap from the event stream's own turn-start/turn-end pairs. */
/** Max overlapping provider requests, from the durable receipt intervals. */
function maxInFlight(ledger, clusterId) {
  let rows = [];
  try {
    rows = ledger.all('SELECT created, settled FROM usage_receipts WHERE cluster_id=?', clusterId);
  } catch {
    return null;
  }
  const points = [];
  for (const row of rows) {
    if (typeof row.created !== 'number' || typeof row.settled !== 'number') continue;
    points.push([row.created, 1], [Math.max(row.created, row.settled), -1]);
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
}

function measureConcurrency(events) {
  let resident = 0;
  let maxResident = 0;
  let max = 0;
  const activeByAgent = new Map();
  for (const event of events) {
    if (event.type === 'turn-start') {
      activeByAgent.set(event.data.agent_id, event.at);
      resident += 1;
      maxResident = Math.max(maxResident, resident);
      max = Math.max(max, resident);
    } else if (event.type === 'turn-end') {
      if (activeByAgent.delete(event.data.agent_id)) resident -= 1;
    }
  }
  return { max, maxResident };
}

function queueLatency(events) {
  const enqueued = new Map();
  const waits = [];
  for (const event of events) {
    if (event.type === 'transaction-status' && event.data.to === 'READY') enqueued.set(event.data.transaction_id, event.at);
    if (event.type === 'turn-start' && event.data.purpose === 'worker-turn') {
      const at = enqueued.get(event.data.agent_id);
      if (at) waits.push(event.at - at);
    }
  }
  if (!waits.length) return null;
  waits.sort((a, b) => a - b);
  return { p50: waits[Math.floor(waits.length / 2)], p95: waits[Math.floor(waits.length * 0.95)], samples: waits.length };
}