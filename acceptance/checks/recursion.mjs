/**
 * Recursion case checks: asymmetric depth, independent interception and a
 * correction round that actually reached a durable issue.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkWriteAccess, canonicalScopeEntry } from '../../adapter/src/scope.js';
import { openLedger } from '../lib/ledger.mjs';

/**
 * Which issues were answered by a real corrective change: the issue names a
 * transaction, and that transaction was adjusted at a *later* revision than the
 * one the issue was raised against.
 *
 * The correction counter is deliberately *not* evidence: it advances when a
 * verification fails, so counting it would let failed checks stand in for a
 * correction that never happened.
 */
export function correctionWitness(issues, adjustments, revalidations = []) {
  const target = issue => Number(issue.target_revision ?? 0);
  return (issues ?? []).filter(issue => {
    const planChanged = (adjustments ?? []).some(
      adjustment => adjustment.transaction_id === issue.transaction_id && Number(adjustment.revision ?? 0) > target(issue),
    );
    const revalidated = (revalidations ?? []).some(
      entry => entry.transaction_id === issue.transaction_id && Number(entry.result_revision ?? 0) > target(issue),
    );
    return planChanged || revalidated;
  });
}

/**
 * The submissions that can answer an issue: results for the same transaction,
 * submitted at a revision later than the one the issue was raised against, and
 * that the Worker really **completed**.
 *
 * The ledger stores `result_completed` as a JSON boolean (`false` for a blocked
 * result, `true` for a completed one, `null` when the result carried no verdict
 * at all). A predicate of the form `!== 0` accepts both `false` and `null`, so
 * it certified issues as answered by a replacement that had itself reported
 * itself blocked. Only `=== true` is a completion.
 */
export function completedReplacementSubmissions(events, issue) {
  return (events ?? []).filter(event => event.type === 'result-submitted'
    && event.data?.transaction_id === issue.transaction_id
    && Number(event.data?.revision ?? 0) > Number(issue.target_revision ?? 0)
    && event.data?.result_completed === true);
}

/**
 * Did a completed replacement result exist *before* the issue was closed? The
 * verdict has to follow the work it certifies: a closure recorded first, or one
 * standing on an incomplete or unknown submission, proves no correction round.
 */
export function answeredByReplacementWork({ events, issue, closedSeq }) {
  if (closedSeq === null || closedSeq === undefined) return false;
  const replacements = completedReplacementSubmissions(events, issue);
  return replacements.some(event => Number(event.seq) < Number(closedSeq));
}

/**
 * Did the *Auditor* close this issue by verifying the correction?
 *
 * The approved plan is explicit: "显式调用 verify_correction 检验修复后状态，不能
 * 只依赖 acceptTransaction 自动把 open issue 标为 CORRECTED". Acceptance closes
 * every open issue of a transaction it accepts, and records why
 * (`reason: accepted-result-after-issue`) — that route proves the result was
 * accepted, not that the correction was verified. A generic `issue-corrected`
 * event is therefore not enough: the verdict itself must exist as a successful
 * `flow_audit` call naming this issue and closing it.
 */
export function auditorVerifiedIssue({ issue, receipts = [], closedEvent = null }) {
  const closing = (receipts ?? []).filter(receipt => {
    if (receipt?.error || receipt?.dispatch_status !== 'SETTLED') return false;
    // The ledger stores a tool result as `{isError, text}`, where `text` is the
    // tool's own JSON answer; the verdict lives one level below that.
    let body = null;
    try { body = JSON.parse(String(receipt?.result_body ?? 'null')); } catch { return false; }
    if (!body || body.isError === true) return false;
    let payload = body;
    if (typeof body.text === 'string') {
      try { payload = JSON.parse(body.text); } catch { return false; }
    }
    if (!payload || payload.action !== 'verify_correction' || payload.deduped === true) return false;
    const verdict = payload.result ?? payload;
    return verdict?.issue_id === issue.id && String(verdict?.status ?? '').toUpperCase() === 'CORRECTED';
  });
  const reason = closedEvent?.reason ?? null;
  return {
    ok: closing.length > 0 && reason !== 'accepted-result-after-issue',
    closings: closing.length,
    reason,
  };
}

const TERMINAL = new Set(['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED']);
const LIMIT_CODES = ['BUDGET_EXHAUSTED', 'LIMIT_REACHED', 'DEADLINE_PASSED'];
const MECHANISM_CHECKS = ['no-duplicate-accounting', 'cluster-database-present', 'cluster-id-resolved'];

/**
 * The class this case derives from its own evidence, in §1.7's order: a mechanism
 * defect first, then a coded limit, then the model's judgement.
 */
export function deriveRunClass({ failed = [], limitCoded = false, mechanismCoded = false } = {}) {
  if (!failed.length) return null;
  if (mechanismCoded || failed.some(name => MECHANISM_CHECKS.includes(name))) return 'MECHANISM';
  return limitCoded ? 'LIMIT_REACHED' : 'MODEL_OUTPUT';
}

export async function run({ workspace, report, layout, events }) {
  const checks = [];
  const push = (name, passed, evidence) => checks.push({
    name, passed: passed === null || passed === undefined ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500),
  });
  const dbPath = join(layout.data, 'cluster.sqlite');
  // A database that exists with no resolved cluster id is a different failure
  // from a database that was never created: report each on its own evidence.
  const dbPresent = existsSync(dbPath);
  push('cluster-database-present', dbPresent, `${dbPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);
  if (!dbPresent || !report.cluster_id) {
    return { checks, scenario_status: 'FAILED', failure_class: 'MECHANISM' };
  }
  const ledger = openLedger(dbPath);
  const clusterId = report.cluster_id;

  const nodes = ledger.all('SELECT id,kind,depth,parent_id,status FROM nodes WHERE cluster_id=? ORDER BY depth', clusterId);
  const depths = nodes.map(node => node.depth);
  const maxDepth = depths.length ? Math.max(...depths) : 0;
  const managementDepths = new Set(nodes.filter(node => node.kind === 'management').map(node => node.depth));
  push('management-depth-three', managementDepths.has(3),
    `max depth ${maxDepth}; management depths ${[...managementDepths].sort().join(', ')}`);

  const sameParent = nodes.filter(node => node.depth === 1);
  push('mixed-children-under-one-parent', new Set(sameParent.map(node => node.parent_id)).size === 1 && sameParent.length >= 2,
    `depth-1 children: ${sameParent.map(node => `${node.kind}:${node.parent_id?.slice(0, 8)}`).join(', ')}`);
  push('asymmetric-branches', managementDepths.has(3) && nodes.some(node => node.kind === 'worker' && node.depth === 1),
    'a depth-3 management branch and a depth-1 worker branch coexist');

  const statuses = ledger.all('SELECT status, COUNT(*) AS c FROM transactions WHERE cluster_id=? GROUP BY status', clusterId);
  const total = statuses.reduce((sum, row) => sum + Number(row.c), 0);
  const terminal = statuses.filter(row => TERMINAL.has(row.status)).reduce((sum, row) => sum + Number(row.c), 0);
  push('every-transaction-terminal', total > 0 && terminal === total, `${terminal}/${total}: ${JSON.stringify(statuses)}`);

  const issues = ledger.all('SELECT id,status,target_revision,corrections,transaction_id,required_change,severity FROM issues WHERE cluster_id=?', clusterId);
  // A correction round is proven by a *durable change*, not by the correction
  // counter: `verify_correction` increments `issue.corrections` only when the
  // verification fails, so a plan corrected and verified on the first try closes
  // the issue at zero. Requiring `corrections >= 1` made the gate unfalsifiable
  // in the path that actually worked.
  // Both real corrections count: a plan adjustment, and a re-validation at a
  // later result revision (`request_revalidation → validate` never emits
  // `transaction-adjusted`).
  const adjustments = ledger.all(
    "SELECT json_extract(data,'$.transaction_id') AS transaction_id, json_extract(data,'$.revision') AS revision FROM events WHERE cluster_id=? AND type='transaction-adjusted'",
    clusterId,
  );
  const revalidations = ledger.all(
    "SELECT json_extract(data,'$.transaction_id') AS transaction_id, json_extract(data,'$.result_revision') AS result_revision FROM events WHERE cluster_id=? AND type='validation-proposed'",
    clusterId,
  );
  const answered = correctionWitness(issues, adjustments, revalidations);
  push('auditor-opened-an-issue', issues.length >= 1, `${issues.length} issues: ${JSON.stringify(issues.map(issue => ({ status: issue.status, corrections: issue.corrections })))}`);
  push('issue-went-through-correction', answered.length >= 1,
    `${answered.length} of ${issues.length} issues were answered by a durable change to the transaction: ${JSON.stringify(answered.map(issue => issue.id))}`);
  const corrected = answered.filter(issue => issue.status === 'CORRECTED');
  // The case asks for at least one *completed* correction round, not a verdict
  // on every independent issue the model may open. Dismissal or escalation is
  // not a corrected outcome; report the others without turning one genuine
  // closed correction into an all-issues assertion absent from the fixture.
  push('issue-reached-a-verdict', corrected.length >= 1,
    `${corrected.length}/${answered.length} durably answered issues CORRECTED; other statuses: ${JSON.stringify(answered.filter(issue => issue.status !== 'CORRECTED').map(issue => issue.status))}`);

  const auditReceipts = ledger.all(
    "SELECT result_body, error, dispatch_status, created FROM tool_call_receipts WHERE cluster_id=? AND tool='flow_audit'", clusterId,
  );
  const verifiedByAuditor = corrected.map(issue => {
    const closedEvent = events.find(event => event.type === 'issue-corrected' && event.data.issue_id === issue.id) ?? null;
    return { issue: issue.id, ...auditorVerifiedIssue({ issue, receipts: auditReceipts, closedEvent: closedEvent?.data ?? null }) };
  });
  push('correction-verified-by-the-auditor',
    corrected.length ? verifiedByAuditor.every(entry => entry.ok) : null,
    `every closed correction needs a successful flow_audit verdict naming it (an acceptance-driven closure, reason "accepted-result-after-issue", does not count): ${JSON.stringify(verifiedByAuditor)}`);

  const audits = ledger.all('SELECT kind,decision,COUNT(*) AS c FROM audits WHERE cluster_id=? GROUP BY kind,decision', clusterId);
  const rejected = audits.filter(row => row.decision === 'REJECTED').reduce((sum, row) => sum + Number(row.c), 0);
  const auditorIssues = ledger.all(
    `SELECT i.id FROM issues i JOIN agents a ON a.id=i.reporter_agent_id
       WHERE i.cluster_id=? AND a.role='auditor'`, clusterId);
  // An Auditor can intervene on a Worker's explicit blocked submission before
  // an Orchestrator proposes validation. That is an independent correction
  // even though there is no validation audit to reject. A model-authored issue
  // from any other role does not meet this gate.
  push('independent-gate-acted', rejected >= 1 || auditorIssues.length >= 1,
    `${rejected} rejected audits, ${auditorIssues.length} Auditor-authored issues; audit decisions: ${JSON.stringify(audits)}`);

  // The injected fault has to be real: the deepest branch's workers are allocated a
  // write scope that does not cover `deep/nested`, and a write to it was actually
  // refused by the guard during the run. A scenario whose "defect" the cluster would
  // happily have accepted proves nothing about the Auditor's rejection.
  // The deepest *management* node: the deepest node of any kind is the worker node
  // the branch produced, which owns no transactions of its own.
  // The *deep branch* the case requires: the management nodes the delegation fixture
  // actually created, identified by the instruction those nodes carry. Deriving it from
  // the fixture's `rec-deep` transaction was wrong — that transaction belongs to the
  // **root**, so its subtree is the whole cluster and any management work would satisfy
  // the check.
  const delegatedNodes = ledger.all(
    `SELECT id, depth, scope FROM nodes WHERE cluster_id=? AND kind='management' ORDER BY depth DESC, id`, clusterId,
  ).filter(row => {
    try {
      const scope = JSON.parse(row.scope ?? '{}');
      return Boolean(scope?.delegation_entry);
    } catch { return false; }
  });
  // The deepest delegated level, first — then *its* allocation, required. Falling back
  // to a shallower node that happens to be allocated would report success for a fault
  // that never reached the work the case is about.
  const deepestNode = delegatedNodes[0] ?? null;
  // The allocation must belong to the deepest node's transaction *and* to a worker the
  // deepest node owns: joining only the transaction let a worker allocated by the root
  // for a deep transaction satisfy the check, which is exactly the mistake the
  // allocation command makes when it is issued without a node.
  const deepestAllocations = deepestNode
    ? ledger.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT a.id, a.transaction_id, a.write_scope, a.write_scope_canonical, a.created, a.agent_id
         FROM allocations a
         JOIN transactions t ON t.id = a.transaction_id
         JOIN agents g ON g.id = a.agent_id
        WHERE a.cluster_id=? AND t.node_id=? AND g.node_id IN (SELECT id FROM sub)
        ORDER BY a.created`,
      deepestNode.id, clusterId, deepestNode.id,
    )
    : [];
  const firstByTx = new Map();
  for (const row of deepestAllocations) {
    if (!firstByTx.has(row.transaction_id)) firstByTx.set(row.transaction_id, row);
  }
  const target = join(workspace, 'deep/nested/result.txt');
  const parsed = row => {
    try { return JSON.parse(row.write_scope_canonical ?? row.write_scope ?? '[]'); } catch { return []; }
  };
  let faultIsReal = false;
  for (const row of firstByTx.values()) {
    const decision = checkWriteAccess({
      tool: 'write', workspace,
      writeScope: parsed(row), writeScopeCanonical: JSON.parse(row.write_scope_canonical ?? 'null') ?? null,
      arguments: { file_path: target },
    });
    if (!decision.allowed) faultIsReal = true;
  }
  const deepestAgents = deepestNode
    ? ledger.all('SELECT id FROM agents WHERE cluster_id=? AND node_id=?', clusterId, deepestNode.id).map(row => row.id)
    : [];
  // The refused write is the *observable* form of the fault: the deepest
// branch's Worker tried the deliverable and the guard held. It is counted over
// the deepest node's whole subtree, because the Worker that attempted it lives
// on a child Worker node, not on the management node itself.
  const refusedWrites = deepestNode
    ? ledger.get(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT COUNT(*) AS c FROM events e JOIN agents g ON g.id = json_extract(e.data,'$.agent_id')
        WHERE e.cluster_id=? AND e.type='write-refused' AND g.node_id IN (SELECT id FROM sub)`,
      deepestNode.id, clusterId,
    ).c
    : 0;
  // Proof of the fault is the guard's own verdict on the initial allocation, not a
  // `write-refused` event: the worker prompt tells a worker not to write outside its
  // allocation, so a well-behaved worker reports the limitation instead of attempting
  // the prohibited write. A *scripted* run is asked for the attempt as well, because
  // the scenario exists to produce one; a live run that reports the limitation instead
  // is judged on the allocation, which is why the assertion is scoped to mock mode.
  push('injected-fault-is-real',
    deepestAgents.length > 0 && firstByTx.size > 0 && faultIsReal,
    `deepest node ${deepestNode?.id ?? 'none'}: initial allocations ${firstByTx.size} denied by the guard ${faultIsReal} (${Number(refusedWrites)} refused-write event(s) recorded in its subtree)`);
  const mockScoped = report.validation_mode === 'mock-api';
  push('injected-fault-was-refused', mockScoped ? refusedWrites >= 1 : null,
    mockScoped
      ? `${Number(refusedWrites)} write-refused event(s) recorded for the deepest branch's own workers`
      : 'not asserted outside a mock run: a live model may report the limitation instead of attempting the write');

  // The recursion case carries no cross-subtree message of its own: its durable
  // deliveries are the plugin's internal notifications, not model communication.
  // The invariant is therefore *not exercised here* and says so, instead of being
  // asserted by a check that always passes.
  const deliveries = ledger.get(
    `SELECT COUNT(*) AS c FROM recipients r JOIN messages m ON m.id=r.message_id WHERE m.cluster_id=?`, clusterId).c;
  push('cross-subtree-traffic', null,
    `not exercised by this case: ${deliveries} durable deliveries, all of them plugin notifications; the communication contract is asserted by the recovery case`);

  const duplicateCharges = ledger.get('SELECT COUNT(*) AS c FROM (SELECT request_id FROM usage_receipts WHERE cluster_id=? GROUP BY request_id HAVING COUNT(*)>1)', clusterId).c;
  const duplicateAccepts = ledger.get("SELECT COUNT(*) AS c FROM (SELECT json_extract(data,'$.transaction_id') AS t FROM events WHERE cluster_id=? AND type='result-accepted' GROUP BY t HAVING COUNT(*)>1)", clusterId).c;
  push('no-duplicate-accounting', duplicateCharges === 0 && duplicateAccepts === 0, `charges ${duplicateCharges}, accepts ${duplicateAccepts}`);

  const deepest = join(workspace, 'deep/nested/result.txt');
  const flat = join(workspace, 'flat/result.txt');
  const verify = join(workspace, 'verify/result.txt');
  // Written *by an agent of the deepest node*, as the case requires, and proven from
  // the **effects ledger**: a settled, non-error `write` whose arguments name exactly
  // this path, recorded for a worker placed in the deepest node's subtree. Existence
  // alone says nothing about who wrote it, and a charged write proves at most that a
  // call was admitted — the effect is what records what actually ran.
  const targetCanonical = canonicalScopeEntry(workspace, 'deep/nested/result.txt');
  const settledWrites = deepestNode
    ? ledger.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT e.agent_id, e.args, e.body, e.error, e.status
         FROM effects e JOIN agents g ON g.id = e.agent_id
        WHERE e.cluster_id=? AND e.tool='write' AND e.status='SETTLED' AND g.node_id IN (SELECT id FROM sub)`,
      deepestNode.id, clusterId,
    )
    : [];
  const wroteTarget = settledWrites.some(row => {
    let args = {};
    let body = {};
    try { args = JSON.parse(row.args ?? '{}'); } catch { args = {}; }
    try { body = JSON.parse(row.body ?? '{}'); } catch { body = {}; }
    if (body?.isError === true || row.error) return false;
    const claimed = args.file_path ?? args.path ?? args.file ?? null;
    if (!claimed) return false;
    return canonicalScopeEntry(workspace, String(claimed)) === targetCanonical;
  });
  push('deep-artifact-written',
    existsSync(target) && wroteTarget,
    `${target} ${existsSync(target) ? 'exists' : 'missing'}; settled non-error writes by the deepest node's workers: ${settledWrites.length}, to this path: ${wroteTarget}`);
  // The fixture requires more than existence: the deepest Worker must write a
  // single line naming how many management levels it sits below the root.
  // A settled write of "deep-ok" satisfies path provenance but not that task.
  const deepContent = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const deepLine = deepContent?.replace(/\r?\n$/, '') ?? null;
  const namesDepth = deepLine !== null && deepLine.length > 0
    && !/[\r\n]/.test(deepLine) && /\b(?:3|three)\b/i.test(deepLine);
  push('deep-artifact-names-depth', namesDepth,
    `deepest management node is 3 levels below root; single-line file names that depth: ${namesDepth}`);
  push('flat-artifact-written', existsSync(flat) && /flat-ok/.test(readFileSync(flat, 'utf8')), `${flat} ${existsSync(flat) ? 'present' : 'missing'}`);
  push('verifier-artifact-written', existsSync(verify) && /verifier-ran/.test(readFileSync(verify, 'utf8')), `${verify} ${existsSync(verify) ? 'present' : 'missing'}`);

  // A closed issue only certifies a correction if the work that answered it
  // really came after it. A verdict recorded before the replacement submission,
  // or recorded against a result the Worker itself reported as incomplete,
  // closes an issue that nothing corrected — and a write that was *refused* is
  // not the write that produced the deliverable. Order is read from the durable
  // event stream and the settled effect, never from a fixture flag.
  const replacementWriters = settledWrites.filter(row => {
    let body = {};
    try { body = JSON.parse(row.body ?? '{}'); } catch { body = {}; }
    if (body?.isError === true || row.error) return false;
    let args = {};
    try { args = JSON.parse(row.args ?? '{}'); } catch { args = {}; }
    const claimed = args.file_path ?? args.path ?? args.file ?? null;
    return claimed && canonicalScopeEntry(workspace, String(claimed)) === targetCanonical;
  });
  const refusedAgents = new Set(ledger.all(
    "SELECT json_extract(data,'$.agent_id') AS agent_id FROM events WHERE cluster_id=? AND type='write-refused'",
    clusterId,
  ).map(row => row.agent_id));
  const correctionEvidence = corrected.map(issue => {
    const closed = events.find(event => event.type === 'issue-corrected' && event.data.issue_id === issue.id)?.seq ?? null;
    // Every submission this transaction produced, with what it reported, so the
    // evidence string shows both what was counted and what was not.
    const observed = events
      .filter(event => event.type === 'result-submitted' && event.data?.transaction_id === issue.transaction_id)
      .map(event => ({ seq: event.seq, revision: event.data?.revision ?? null, completed: event.data?.result_completed ?? null }));
    const replacements = completedReplacementSubmissions(events, issue);
    return {
      issue: issue.id,
      target_revision: issue.target_revision,
      closed,
      submissions: observed,
      completed_later: replacements.map(event => ({ seq: event.seq, revision: event.data.revision })),
      ordered: answeredByReplacementWork({ events, issue, closedSeq: closed }),
    };
  });
  push('correction-answered-by-later-work', corrected.length ? correctionEvidence.every(entry => entry.ordered) : null,
    `each closed issue needs a complete replacement result at a later revision, submitted before its verdict: ${JSON.stringify(correctionEvidence)}`);
  push('correction-written-by-a-replacement-worker',
    corrected.length ? replacementWriters.some(row => !refusedAgents.has(row.agent_id)) : null,
    `the deliverable's successful writer must not be the identity whose write was refused: writers ${JSON.stringify([...new Set(replacementWriters.map(row => String(row.agent_id).slice(0, 8)))])}, refused ${JSON.stringify([...refusedAgents].map(id => String(id).slice(0, 8)))}`);

  const concurrency = events.filter(event => event.type === 'turn-start').length;
  push('turns-observed', concurrency > 6, `${concurrency} turns across the run`);
  const beaconCodes = ledger.all(
    "SELECT json_extract(data,'$.code') AS code FROM events WHERE cluster_id=? AND type IN ('cluster-blocked','node-blocked')",
    clusterId,
  ).map(row => String(row.code ?? '').toUpperCase()).filter(Boolean);
  ledger.close();

  const failed = checks.filter(entry => entry.passed === false);
  // A run that stopped on a *coded* limit is a limit stop, not a model failure —
  // even when its artifacts are also missing. The order is §1.7's: a mechanism
  // defect outranks the limit, the limit outranks the model.
  const limitCoded = (report.limit_reached?.blockedOnBudget === true) || beaconCodes.some(code => LIMIT_CODES.includes(code));
  // A descendant may already be BLOCKED for another reason, preventing a second
  // node-blocked beacon when its live turn reaches the hard context gate.
  // The per-step rejection is durable evidence even in that ordering.
  const mechanismCoded = beaconCodes.includes('CONTEXT_PRESSURE')
    || events.some(event => event.type === 'context-step' && event.data.decision === 'reject');
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: deriveRunClass({ failed: failed.map(entry => entry.name), limitCoded, mechanismCoded }),
    topology_source: 'fixture',
  };
}