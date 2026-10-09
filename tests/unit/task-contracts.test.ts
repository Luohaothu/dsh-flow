import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { ClusterStore, SCHEMA_VERSION } from '../../packages/dsh-flow/src/core/store.ts';
import { validPlan, prepareDirectWorkerContract } from '../../packages/dsh-flow/src/core/contracts.ts';
import type { AuditRecord, FlowAgentActor, PlanRecord, TransactionRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole, FlowJsonValue } from '../../packages/dsh-flow/src/types.ts';

const planRules = ['goal_coverage', 'responsibility', 'dependencies', 'handoff', 'acceptance_arrangement'];
const validationRules = ['standard_coverage', 'checks_performed', 'evidence_applicability', 'conclusion_support', 'authority'];

function must<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
function object(value: FlowJsonValue): Record<string, FlowJsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
}
function text(value: FlowJsonValue | undefined): string { assert.equal(typeof value, 'string'); return String(value); }
function draft(tx: Pick<TransactionRecord, 'objective' | 'acceptance_criteria'>, execution: PlanRecord['execution'] = 'worker') {
  return {
    understanding: `Deliver ${tx.objective} while preserving the specified restrictions.`, execution,
    rationale: execution === 'worker' ? 'A single execution unit can deliver this result.' : 'The assigned domain requires its own planning and integration.',
    assignment: `Please ${tx.objective}. Submit the actual result and the evidence of your work. Use only text.`,
    criterion_responsibilities: tx.acceptance_criteria.map((_, criterion_index) => ({
      criterion: { transaction_id: 'self', criterion_index }, evidence_provider: execution === 'management' ? 'orchestrator' : 'worker',
      validated_by: 'orchestrator', applies_to: ['worker', 'orchestrator'],
    })),
    ...(execution === 'worker' ? {} : { integration: 'The owner integrates the accepted domain delivery and checks every parent requirement.' }),
  };
}
function auditEvidence(audit: AuditRecord, approved = true) {
  return {
    checks: (audit.kind === 'plan' ? planRules : validationRules).map((rule, index) => ({
      rule, method: 'Read the bound immutable record and compare its checks with the applicable requirement.',
      observation: approved || index !== 0 ? 'The recorded responsibility, check and supporting reference correspond to this task.' : 'The current record omits the actual verification required by its formal standard.',
      passed: approved || index !== 0,
      evidence_refs: [{ kind: audit.kind === 'plan' ? 'plan' : 'validation', ref: audit.kind === 'plan' ? audit.plan_ref : audit.validation_ref }],
    })),
    issues: approved ? [] : ['The Orchestrator must supplement its validation.'],
  };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-contracts-'));
  const runtime = new ClusterRuntime(new Context(), {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    logger: { warn() {}, error() {}, info() {} }, model: { provider: 'fixture', model: 'fixture' },
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const id = runtime.start({ objective: 'calculate 2+3', workspace: dir, capabilities: ['fs_read'],
    acceptance_criteria: ['the calculation is 5', 'the work uses only text'],
    budget: { tool_calls: 5000, agents: 64, max_active_agents: 8, wall_time_ms: 3_600_000 },
    limits: { max_children: 8, max_depth: 5, max_active_agents: 8, max_corrections: 5 },
  }).cluster.id;
  const root = must(runtime.store.listNodes(id, { parent_id: null })[0]);
  let sequence = 0;
  const role = (name: FlowAgentRole, nodeId = root.id): FlowAgentActor => {
    const agent = must(runtime.store.listAgents(id, { node_id: nodeId, role: name })[0]);
    return { cluster_id: id, node_id: nodeId, role: name, agent_id: agent.id, session_id: agent.session_id };
  };
  const send = (actor: FlowAgentActor, action: string, params: Record<string, unknown>) => runtime.command(actor, {
    command_id: `contract-command-${++sequence}`, action, params,
  }).result;
  const tx = (txId: string) => must(runtime.store.getTransaction(txId));
  const initial = must(runtime.store.rootTransactions(id)[0]).id;
  const create = (params: Record<string, unknown> = {}) => text(object(send(role('orchestrator'), 'create_transaction', {
    objective: 'calculate a second value', acceptance_criteria: ['the required value is delivered'], constraints: ['text only'], ...params,
  })).transaction_id);
  const dispatch = (txId: string, execution: PlanRecord['execution'] = 'worker') => send(role('orchestrator', tx(txId).node_id), 'dispatch', {
    transaction_id: txId, expected_transaction_revision: tx(txId).revision, plan: draft(tx(txId), execution),
  });
  /** Synthetic successful finisher: tests the storage boundary without claiming native execution. */
  const publish = (txId: string, result: FlowJsonValue = '5') => {
    const current = tx(txId);
    const allocator = role('allocator', current.node_id);
    if (!runtime.store.activeAllocationForTransaction(txId)) send(allocator, 'allocate_agent', { transaction_id: txId, plan_ref: current.current_plan_ref });
    const allocation = must(runtime.store.activeAllocationForTransaction(txId));
    const agent = must(runtime.store.getAgent(allocation.agent_id));
    const actor: FlowAgentActor = { cluster_id: id, node_id: allocation.node_id, role: 'worker', agent_id: agent.id, session_id: agent.session_id };
    runtime.store.updateTransaction(txId, { status: 'RUNNING', __bump_revision: false });
    send(actor, 'submit_result', { transaction_id: txId, result });
    runtime.store.tx(() => {
      runtime.store.updateTransaction(txId, { status: 'SUBMITTED', result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null, __bump_revision: false });
      const publication = runtime.store.appendEvent(id, 'result-submitted', { transaction_id: txId, agent_id: agent.id, synthetic_fixture: true });
      runtime.store.publishResult(txId, { producer_role: 'worker', producer_agent_id: agent.id, epoch: 1, turn_seq: 1, publication_event_seq: publication.seq });
    });
    return tx(txId);
  };
  const checks = (txId: string) => {
    const current = tx(txId);
    const plan = must(runtime.store.getPlan(current.current_plan_ref));
    return plan.contract.acceptance_criteria.map((criterion, criterion_index) => ({
      criterion, criterion_ref: { ...plan.ref, criterion_index }, passed: true,
      method: 'Increment 2 three times and examine the recorded execution evidence.', observation: 'The arithmetic produces 3, 4 and 5; the execution records correspond to the text restriction.',
      evidence: 'The current published result and its execution record were checked.', evidence_refs: [{ kind: 'result', ref: current.current_result_ref }],
    }));
  };
  const validate = (txId: string) => send(role('orchestrator', tx(txId).node_id), 'validate', {
    transaction_id: txId, expected_transaction_revision: tx(txId).revision, accepted: true, checks: checks(txId),
  });
  const inspect = (audit: AuditRecord, approved = true) => send(role('auditor', must(audit.node_id)), audit.kind === 'plan' ? 'inspect_plan' : 'inspect_validation', {
    audit_id: audit.id, decision: approved ? 'approve' : 'reject', evidence: auditEvidence(audit, approved),
  });
  const accept = (txId: string) => {
    validate(txId);
    const audit = must(runtime.store.findAudit(id, txId, 'validation', must(tx(txId).result_revision)));
    return inspect(audit);
  };
  return { runtime, store: runtime.store, id, root, role, send, tx, initial, create, dispatch, publish, checks, validate, inspect, accept };
}

test('unprepared direct, batch and derived actions cannot create execution state', t => {
  const f = fixture(t); const id = f.initial;
  const count = f.store.countAgents(f.id); const seq = f.store.latestEventSeq(f.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { transaction_id: id }), /prepared plan/);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { limit: 10 }), /explicitly referenced/);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { transactions: [id] }), /prepared plan/);
  f.store.updateTransaction(id, { status: 'READY', __bump_revision: false });
  assert.throws(() => f.send(f.role('allocator'), 'allocate_agent', { transaction_id: id }), /prepared plan/);
  assert.throws(() => f.send(f.role('allocator'), 'spawn_agent', { transaction_id: id }), /prepared plan/);
  assert.throws(() => f.send(f.role('allocator'), 'spawn_management_node', { transaction_id: id }), /prepared plan/);
  assert.equal(f.store.countAgents(f.id), count);
  assert.equal(f.store.latestEventSeq(f.id), seq);
});

test('prepared plan author, immutable contract and semantic retries survive new command IDs', t => {
  const f = fixture(t); const before = f.tx(f.initial);
  const request = { transaction_id: before.id, expected_transaction_revision: before.revision, plan: { ...draft(before), author_agent_id: 'forged' } };
  const first = f.send(f.role('orchestrator'), 'dispatch', request);
  const seq = f.store.latestEventSeq(f.id);
  const replay = object(f.send(f.role('orchestrator'), 'dispatch', request));
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.dispatched, object(first).dispatched);
  assert.equal(f.store.latestEventSeq(f.id), seq);
  assert.equal(f.store.listPlans(f.id, before.id).length, 1);
  const current = f.tx(before.id); const plan = must(f.store.getPlan(current.current_plan_ref));
  assert.equal(plan.author_agent_id, f.role('orchestrator').agent_id);
  assert.equal(plan.ref.prepared_revision, current.revision);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { ...request, plan: { ...draft(before), assignment: 'another assignment' } }), /semantic operation key/);
  assert.throws(() => f.send(f.role('allocator'), 'dispatch', request), /may not perform/);
  plan.contract.acceptance_criteria.forEach((criterion, index) => assert.equal(criterion, before.acceptance_criteria[index]));
});

test('batch plan failure rolls back plans, audits and dispatch together', t => {
  const f = fixture(t); const second = f.create();
  const seq = f.store.latestEventSeq(f.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { transactions: [
    { transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, plan: draft(f.tx(f.initial)) },
    { transaction_id: second, expected_transaction_revision: f.tx(second).revision, plan: { ...draft(f.tx(second)), criterion_responsibilities: [] } },
  ] }), /omits formal criterion/);
  assert.equal(f.tx(f.initial).status, 'DRAFT'); assert.equal(f.tx(f.initial).current_plan_ref, null);
  assert.equal(f.store.listPlans(f.id, f.initial).length, 0); assert.equal(f.store.pendingAudits(f.id).length, 0);
  assert.equal(f.store.latestEventSeq(f.id), seq);
});

test('state revisions preserve current plan while business changes and dependencies invalidate it', t => {
  const f = fixture(t); f.dispatch(f.initial);
  const original = must(f.tx(f.initial).current_plan_ref);
  f.store.updateTransaction(f.initial, { attempts: 2 });
  assert.deepEqual(validPlan(f.store, f.tx(f.initial)).ref, original);
  f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, objective: 'calculate 3+4' });
  assert.equal(f.tx(f.initial).current_plan_ref, null);
  assert.equal(must(f.store.getPlan(original)).contract.objective, 'calculate 2+3');
  f.dispatch(f.initial); const newer = must(f.tx(f.initial).current_plan_ref);
  const dep = f.create();
  f.send(f.role('orchestrator'), 'set_dependency', { transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, depends_on: [dep] });
  assert.equal(f.tx(f.initial).current_plan_ref, null); assert.ok(f.store.getPlan(newer));
});

test('late plan review binds the current plan after publication and validation advance revision', t => {
  const f = fixture(t); f.dispatch(f.initial);
  const plan = must(f.tx(f.initial).current_plan_ref);
  const audit = must(f.store.findAudit(f.id, f.initial, 'plan', plan.prepared_revision));
  f.publish(f.initial); f.validate(f.initial);
  assert.ok(f.tx(f.initial).revision > plan.prepared_revision);
  assert.equal(object(f.inspect(audit)).decision, 'APPROVED');
  assert.deepEqual(f.tx(f.initial).current_plan_ref, plan);
});

test('staged results, omitted criteria and mismatched execution references cannot be validated', t => {
  const f = fixture(t); f.dispatch(f.initial);
  f.store.updateTransaction(f.initial, { status: 'SUBMITTED', result: '5', result_staged_agent: 'staging-agent', __bump_revision: false });
  assert.throws(() => f.validate(f.initial), /published result snapshot/);
  f.store.updateTransaction(f.initial, { status: 'READY', result: null, result_staged_agent: null, __bump_revision: false });
  f.publish(f.initial);
  const revision = f.tx(f.initial).revision;
  const request = { transaction_id: f.initial, expected_transaction_revision: revision, accepted: true, checks: f.checks(f.initial) };
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', { ...request, checks: request.checks.slice(0, 1) }), /omits formal criterion/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', { ...request, checks: request.checks.map(check => ({ ...check, method: '' })) }), /actual method/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', { ...request, checks: request.checks.map(check => ({ ...check, evidence_refs: [{ kind: 'result', ref: { transaction_id: f.initial, publication_event_seq: 999999 } }] })) }), /another result publication/);
  assert.equal(f.tx(f.initial).revision, revision); assert.equal(f.tx(f.initial).current_validation_ref, null);
});

test('formal correction inputs may bind an older publication as historical evidence without changing the current result', t => {
  const f = fixture(t); f.dispatch(f.initial); f.publish(f.initial, '6');
  const rejectedRef = must(f.tx(f.initial).current_result_ref);
  f.send(f.role('orchestrator'), 'validate', {
    transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, accepted: false,
    checks: f.checks(f.initial).map(check => ({ ...check, passed: false, observation: 'The first candidate was 6, so the arithmetic requirement failed.' })),
  });
  const rejectedValidation = must(f.tx(f.initial).current_validation_ref);
  f.send(f.role('allocator'), 'release_agent', { allocation_id: must(f.store.activeAllocationForTransaction(f.initial)).id });
  f.send(f.role('orchestrator'), 'adjust_transaction', {
    transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision,
    inputs: { correction: { rejected_candidates: [{ result_ref: rejectedRef, value: '6' }] } },
  });
  f.dispatch(f.initial); f.publish(f.initial, '5');
  const current = f.tx(f.initial), currentRef = must(current.current_result_ref);
  const checks = f.checks(f.initial).map(check => ({ ...check,
    evidence_refs: [...check.evidence_refs, { kind: 'historical_result', ref: rejectedRef }],
  }));
  f.send(f.role('orchestrator'), 'validate', { transaction_id: f.initial, expected_transaction_revision: current.revision,
    accepted: true, plan_ref: current.current_plan_ref, result_ref: currentRef, checks });
  const validation = must(f.store.getValidation(f.tx(f.initial).current_validation_ref));
  assert.deepEqual(validation.result_ref, currentRef); assert.deepEqual(validation.plan_ref, current.current_plan_ref);
  for (const check of validation.checks) {
    const historical = must(check.evidence_refs?.find(ref => object(ref).kind === 'historical_result'));
    assert.deepEqual(object(historical).ref, rejectedRef);
  }
  assert.equal(must(f.store.getResult(rejectedRef)).result, '6');
  assert.equal(must(f.store.getValidation(rejectedValidation)).accepted, false);
  f.inspect(must(f.store.findAudit(f.id, f.initial, 'plan', must(current.current_plan_ref).prepared_revision)));
  f.inspect(must(f.store.findAudit(f.id, f.initial, 'validation', validation.ref.result_revision)));
  assert.equal(f.tx(f.initial).status, 'ACCEPTED'); assert.deepEqual(f.tx(f.initial).current_result_ref, currentRef);
});

test('historical evidence refuses wrong kinds, current, foreign, unpublished and unreferenced publications', t => {
  const f = fixture(t); const other = f.create(); f.dispatch(other); f.publish(other, '6');
  const foreignRef = must(f.tx(other).current_result_ref);
  f.dispatch(f.initial); f.publish(f.initial, '6'); const oldRef = must(f.tx(f.initial).current_result_ref);
  f.send(f.role('orchestrator'), 'reject_result', { transaction_id: f.initial, reason: 'The first candidate must be corrected.' });
  f.send(f.role('allocator'), 'release_agent', { allocation_id: must(f.store.activeAllocationForTransaction(f.initial)).id });
  f.send(f.role('orchestrator'), 'adjust_transaction', {
    transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision,
    inputs: { foreign_candidate: { result_ref: foreignRef }, old_candidate_as_text: JSON.stringify(oldRef),
      split_reference: [{ transaction_id: oldRef.transaction_id }, { publication_event_seq: oldRef.publication_event_seq }] },
  });
  f.dispatch(f.initial); f.publish(f.initial, '5');
  const current = f.tx(f.initial), checks = f.checks(f.initial);
  const request = { transaction_id: f.initial, expected_transaction_revision: current.revision, accepted: true, checks };
  const withEvidence = (kind: string, ref: unknown) => ({ ...request, checks: checks.map(check => ({ ...check,
    evidence_refs: [...check.evidence_refs, { kind, ref }],
  })) });
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('result', oldRef)), /another result publication/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('history', oldRef)), /evidence kind/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('historical_result', current.current_result_ref)), /older published result/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('historical_result', foreignRef)), /older published result of this task/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('historical_result', { ...oldRef, publication_event_seq: 999999 })), /older published result/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('historical_result', oldRef)), /explicitly referenced.*formal plan inputs/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', withEvidence('historical_result', { ...oldRef, explanation: 'older' })), /exact immutable result reference/);
  assert.throws(() => f.send(f.role('orchestrator'), 'validate', { ...request, result_ref: oldRef }), /result_ref is stale/);
  assert.equal(f.tx(f.initial).revision, current.revision); assert.equal(f.tx(f.initial).current_validation_ref, null);
  assert.deepEqual(f.tx(f.initial).current_result_ref, current.current_result_ref);
});

test('validation rejection preserves the publication and requires a new independently approved record', t => {
  const f = fixture(t); f.dispatch(f.initial); f.publish(f.initial); f.validate(f.initial);
  const original = f.tx(f.initial); const validation = must(f.store.getValidation(original.current_validation_ref));
  const audit = must(f.store.findAudit(f.id, f.initial, 'validation', validation.ref.result_revision));
  assert.throws(() => f.send(f.role('auditor'), 'inspect_validation', { audit_id: audit.id, decision: 'approve', evidence: {} }), /actual checks/);
  const rejection = object(f.inspect(audit, false)); const issueId = text(rejection.issue_id);
  assert.equal(f.tx(f.initial).status, 'SUBMITTED'); assert.deepEqual(f.tx(f.initial).current_result_ref, original.current_result_ref);
  assert.equal(f.tx(f.initial).result, '5'); assert.ok(f.store.getValidation(validation.ref));
  assert.throws(() => f.send(f.role('auditor'), 'verify_correction', { issue_id: issueId, decision: 'corrected' }), /new matching validation/);
  f.validate(f.initial); const next = must(f.tx(f.initial).current_validation_ref);
  assert.notDeepEqual(next, validation.ref);
  assert.throws(() => f.send(f.role('orchestrator'), 'accept_result', { transaction_id: f.initial }), /approval.*missing/);
  f.inspect(must(f.store.findAudit(f.id, f.initial, 'validation', next.result_revision)));
  assert.equal(f.tx(f.initial).status, 'ACCEPTED'); assert.equal(must(f.store.getIssue(issueId)).status, 'OPEN');
  f.send(f.role('auditor'), 'verify_correction', { issue_id: issueId, decision: 'corrected', evidence: { validation_ref: next } });
  assert.equal(must(f.store.getIssue(issueId)).status, 'CORRECTED');
  const summary = object(must(f.store.latestSummary(f.id, { transaction_id: f.initial })).data);
  assert.equal(summary.validated_by, f.role('orchestrator').agent_id); assert.equal(summary.audited_by, f.role('auditor').agent_id);
  assert.equal(summary.accepted_by, 'runtime');
});

test('one management plan creates one unique delegation and cannot be rewritten by Allocator', t => {
  const f = fixture(t); f.dispatch(f.initial, 'management'); const current = f.tx(f.initial);
  assert.throws(() => f.send(f.role('allocator'), 'allocate_agent', { transaction_id: current.id }), /requires worker/);
  assert.throws(() => f.send(f.role('allocator'), 'spawn_management_node', { transaction_id: current.id, plan_ref: current.current_plan_ref, objective: 'other business work' }), /cannot rewrite/);
  const request = { transaction_id: current.id, plan_ref: current.current_plan_ref };
  const first = f.send(f.role('allocator'), 'spawn_management_node', request); const nodeCount = f.store.listNodes(f.id).length;
  assert.deepEqual(f.send(f.role('allocator'), 'spawn_management_node', request), { ...object(first), deduped: true }); assert.equal(f.store.listNodes(f.id).length, nodeCount);
  assert.throws(() => f.send(f.role('allocator'), 'spawn_management_node', { ...request, max_children: 3 }), /semantic operation key/);
  const child = f.tx(text(object(first).delegated_transaction_id));
  assert.equal(child.objective, must(f.store.getPlan(current.current_plan_ref)).assignment);
  assert.deepEqual(child.constraints, current.constraints);
});

test('explicit immutable management budgets preserve the request and conserve resource grants', t => {
  for (const budget of [Object.freeze({ tool_calls: 60, agents: 4, max_active_agents: 1 }),
    Object.preventExtensions({ tool_calls: 60, max_active_agents: 1 })]) {
    const f = fixture(t); f.dispatch(f.initial, 'management');
    const current = f.tx(f.initial), originalBudget = { ...budget };
    const totals = () => f.store.listBudgets(f.id).reduce((sum, row) => ({
      tools: sum.tools + row.tool_calls_limit, agents: sum.agents + row.agents_limit,
      active: sum.active + row.max_active_limit,
    }), { tools: 0, agents: 0, active: 0 });
    const before = totals(), agentsBefore = f.store.countAgents(f.id);
    const request = { transaction_id: current.id, plan_ref: current.current_plan_ref, budget };
    const first = object(f.send(f.role('allocator'), 'spawn_management_node', request));
    const child = must(f.store.getNode(text(first.node_id)));
    assert.equal(child.kind, 'management'); assert.equal(child.parent_id, f.root.id);
    assert.equal(f.store.countAgents(f.id), agentsBefore + 3);
    assert.deepEqual(totals(), before); assert.deepEqual(budget, originalBudget);
    const resources = f.store.listBudgets(f.id), nodeCount = f.store.listNodes(f.id).length;
    assert.deepEqual(f.send(f.role('allocator'), 'spawn_management_node', request), { ...first, deduped: true });
    assert.equal(f.store.listNodes(f.id).length, nodeCount); assert.deepEqual(f.store.listBudgets(f.id), resources);
  }
});

test('an unfundable immutable management budget rolls back identities, assignments and resource changes', t => {
  const f = fixture(t); f.dispatch(f.initial, 'management');
  for (const budget of f.store.listBudgets(f.id)) {
    f.store.updateBudget(budget.id, { tool_calls_spent: budget.tool_calls_limit - budget.tool_calls_reserved });
  }
  const current = f.tx(f.initial), budgets = f.store.listBudgets(f.id), nodes = f.store.listNodes(f.id);
  const agents = f.store.countAgents(f.id), transactions = f.store.listTransactions({ cluster_id: f.id });
  const budget = Object.freeze({ tool_calls: 60, agents: 4, max_active_agents: 1 });
  assert.throws(() => f.send(f.role('allocator'), 'spawn_management_node', {
    transaction_id: current.id, plan_ref: current.current_plan_ref, budget,
  }), /cannot fund delegated management node.*tool_calls/);
  assert.deepEqual(f.store.listBudgets(f.id), budgets); assert.deepEqual(f.store.listNodes(f.id), nodes);
  assert.equal(f.store.countAgents(f.id), agents); assert.deepEqual(f.store.listTransactions({ cluster_id: f.id }), transactions);
  assert.equal(f.store.all('SELECT transaction_id FROM management_assignments WHERE transaction_id=?', current.id).length, 0);
  assert.deepEqual(budget, { tool_calls: 60, agents: 4, max_active_agents: 1 });
});

test('decomposition binds stable child keys, preserves parent coverage and pauses children on late rejection', t => {
  const f = fixture(t); const parent = f.tx(f.initial);
  const children = ['left', 'right'].map((key, index) => ({
    key, objective: `deliver part ${key}`, acceptance_criteria: [`deliver part ${key}`],
    ...(index ? { depends_on: ['left'] } : {}),
    plan: { ...draft({ objective: `deliver part ${key}`, acceptance_criteria: [`deliver part ${key}`] }), criterion_responsibilities: [
      { criterion: { transaction_id: 'self', criterion_index: 0 }, evidence_provider: 'worker', validated_by: 'orchestrator', applies_to: ['worker'] },
      { criterion: { transaction_id: index ? parent.id : 'parent', criterion_index: index }, evidence_provider: 'worker', validated_by: 'orchestrator', applies_to: ['worker'] },
    ] },
  }));
  const request = { transaction_id: parent.id, expected_transaction_revision: parent.revision, children, plan: {
    ...draft(parent, 'decompose'), criterion_responsibilities: parent.acceptance_criteria.map((_, criterion_index) => ({
      criterion: { transaction_id: 'self', criterion_index }, evidence_provider: criterion_index ? 'right' : 'left', validated_by: 'orchestrator', applies_to: [criterion_index ? 'right' : 'left'],
    })),
  } };
  assert.throws(() => f.send(f.role('orchestrator'), 'decompose', { ...request, children: children.map(child => ({ ...child,
    plan: { ...child.plan, criterion_responsibilities: child.plan.criterion_responsibilities.map(item => item.criterion.transaction_id === parent.id
      ? { ...item, criterion: { ...item.criterion, prepared_revision: 999999 } } : item) },
  })) }), /immutable formal contract/);
  assert.equal(f.store.childrenOfTransaction(f.id, parent.id).length, 0);
  const result = object(f.send(f.role('orchestrator'), 'decompose', request)); const ids = (result.children as FlowJsonValue[]).map(child => text(object(child).transaction_id));
  assert.equal(f.tx(parent.id).status, 'READY'); assert.equal(f.tx(must(ids[0])).status, 'DRAFT');
  assert.deepEqual(f.store.dependenciesOf(must(ids[1])), [ids[0]]);
  const secondPlan = must(f.store.getPlan(f.tx(must(ids[1])).current_plan_ref));
  assert.equal(secondPlan.ref.prepared_revision, f.tx(must(ids[1])).revision);
  assert.ok(secondPlan.criterion_responsibilities.some(item => item.criterion.transaction_id === parent.id));
  assert.deepEqual(f.send(f.role('orchestrator'), 'decompose', request), { ...result, deduped: true });
  f.inspect(must(f.store.getAudit(text(result.audit_id))), false);
  assert.equal(f.tx(must(ids[0])).status, 'PAUSED'); assert.equal(f.tx(must(ids[1])).status, 'PAUSED');
});

test('standalone explicit contract records user provenance and delivery admission is durable', t => {
  const f = fixture(t); const tx = f.tx(f.initial);
  const plan = prepareDirectWorkerContract(f.store, tx, { role: 'user', cluster_id: f.id }, 'Calculate 2+3 using only text.');
  assert.equal(plan.author_role, 'user'); assert.equal(plan.author_agent_id, null);
  const agent = f.role('orchestrator');
  const input = { cluster_id: f.id, agent_id: agent.agent_id, session_id: agent.session_id, delivery_key: 'initial:contract', kind: 'initial' as const,
    author: { role: 'user' }, plan_ref: plan.ref, binding: { transaction_id: tx.id }, content: plan.assignment, native_message_id: 'native-input-1' };
  const first = f.store.saveMemberInput(input);
  assert.deepEqual(f.store.saveMemberInput({ ...input, native_message_id: 'new-unsent-id' }), first);
  assert.throws(() => f.store.saveMemberInput({ ...input, content: 'different request' }), /delivery key/);
  f.store.acknowledgeMemberInput(first.id, { native_seq: 42 });
  assert.equal(must(f.store.getMemberInput(first.id)).status, 'ADMITTED'); assert.equal(must(f.store.getMemberInput(first.id)).native_seq, 42);
});

test('old schema is refused without migrating or deleting its contents', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-old-contract-')); const path = join(dir, 'old.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path); legacy.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'retained\'); PRAGMA user_version=3'); legacy.close();
  assert.equal(SCHEMA_VERSION, 4); assert.throws(() => new ClusterStore(path), /use a new dataDir/);
  const proof = new DatabaseSync(path); assert.equal(proof.prepare('SELECT value FROM sentinel').get()?.value, 'retained');
  assert.equal(proof.prepare('PRAGMA user_version').get()?.user_version, 3); proof.close();
});

test('an active original lease blocks revision while its late rejected plan may still stage a real delivery', t => {
  const f = fixture(t); f.dispatch(f.initial);
  f.send(f.role('allocator'), 'allocate_agent', { transaction_id: f.initial });
  const allocation = must(f.store.activeAllocationForTransaction(f.initial)); const agent = must(f.store.getAgent(allocation.agent_id));
  f.store.updateTransaction(f.initial, { status: 'RUNNING', __bump_revision: false });
  f.store.createLease({ id: 'live-original', cluster_id: f.id, agent_id: agent.id, node_id: agent.node_id, epoch: 1, expires: Date.now() + 60_000 });
  const before = f.tx(f.initial);
  assert.throws(() => f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: f.initial, expected_transaction_revision: before.revision, objective: 'revised work' }), /active turn or lease/);
  assert.deepEqual(f.tx(f.initial), before);
  f.inspect(must(f.store.findAudit(f.id, f.initial, 'plan', must(before.current_plan_ref).prepared_revision)), false);
  assert.equal(f.tx(f.initial).status, 'RUNNING');
  const actor: FlowAgentActor = { role: 'worker', cluster_id: f.id, agent_id: agent.id, node_id: allocation.node_id, session_id: agent.session_id, epoch: 1, turn_seq: 1 };
  assert.equal(object(f.send(actor, 'submit_result', { transaction_id: f.initial, result: '5' })).status, 'STAGED');
  assert.equal(f.tx(f.initial).result_staged_epoch, 1); assert.equal(f.tx(f.initial).result_staged_turn, 1);
  assert.equal(f.tx(f.initial).current_result_ref, null);
});

test('new execution turns must explicitly rebind a staged result even when its content is identical', t => {
  const f = fixture(t); f.dispatch(f.initial); f.send(f.role('allocator'), 'allocate_agent', { transaction_id: f.initial });
  const allocation = must(f.store.activeAllocationForTransaction(f.initial)); const agent = must(f.store.getAgent(allocation.agent_id));
  f.store.updateTransaction(f.initial, { status: 'RUNNING', __bump_revision: false });
  f.store.createLease({ id: 'stage-round-one', cluster_id: f.id, agent_id: agent.id, node_id: agent.node_id, epoch: 1, expires: Date.now() + 60_000 });
  const first: FlowAgentActor = { role: 'worker', cluster_id: f.id, agent_id: agent.id, node_id: allocation.node_id, session_id: agent.session_id, epoch: 1, turn_seq: 1 };
  f.send(first, 'submit_result', { transaction_id: f.initial, result: '5' });
  assert.equal(object(f.send(first, 'submit_result', { transaction_id: f.initial, result: '5' })).deduped, true);
  assert.throws(() => f.send(first, 'submit_result', { transaction_id: f.initial, result: '6' }), /already staged different/);
  f.store.run('DELETE FROM leases WHERE agent_id=?', agent.id);
  f.store.createLease({ id: 'stage-round-two', cluster_id: f.id, agent_id: agent.id, node_id: agent.node_id, epoch: 2, expires: Date.now() + 60_000 });
  f.send({ ...first, epoch: 2, turn_seq: 2 }, 'submit_result', { transaction_id: f.initial, result: '5' });
  assert.equal(f.tx(f.initial).result_staged_epoch, 2); assert.equal(f.tx(f.initial).result_staged_turn, 2);
});

test('accepted child revalidation preserves its result and invalidates ancestor aggregate acceptance', t => {
  const f = fixture(t); f.dispatch(f.initial, 'management');
  const spawned = object(f.send(f.role('allocator'), 'spawn_management_node', { transaction_id: f.initial, plan_ref: f.tx(f.initial).current_plan_ref }));
  const childId = text(spawned.delegated_transaction_id); const child = f.tx(childId);
  f.dispatch(childId); f.publish(childId); f.accept(childId);
  f.send(f.role('orchestrator'), 'aggregate', { transaction_id: f.initial, summary: 'The child result is integrated.' }); f.accept(f.initial);
  const oldParentResult = must(f.tx(f.initial).current_result_ref); const oldChildResult = must(f.tx(childId).current_result_ref);
  const oldChildValidation = must(f.tx(childId).current_validation_ref);
  const dependentId = f.create();
  f.send(f.role('orchestrator'), 'set_dependency', { transaction_id: dependentId, expected_transaction_revision: f.tx(dependentId).revision, depends_on: [f.initial] });
  f.dispatch(dependentId);
  assert.equal(f.tx(dependentId).status, 'READY');
  f.send(f.role('auditor', child.node_id), 'request_revalidation', { transaction_id: childId, required_change: 'Document the actual text restriction check.' });
  assert.equal(f.tx(childId).status, 'SUBMITTED'); assert.deepEqual(f.tx(childId).current_result_ref, oldChildResult);
  assert.equal(f.tx(f.initial).status, 'READY'); assert.equal(f.tx(f.initial).current_result_ref, null);
  assert.equal(f.tx(dependentId).status, 'PAUSED');
  assert.ok(f.store.getResult(oldParentResult)); assert.ok(f.store.getValidation(oldChildValidation));
  f.accept(childId);
  assert.deepEqual(f.tx(childId).current_result_ref, oldChildResult); assert.notDeepEqual(f.tx(childId).current_validation_ref, oldChildValidation);
  f.send(f.role('orchestrator'), 'aggregate', { transaction_id: f.initial, summary: 'The current child acceptance is integrated.' }); f.accept(f.initial);
  assert.notDeepEqual(f.tx(f.initial).current_result_ref, oldParentResult);
  const current = must(f.store.getResult(f.tx(f.initial).current_result_ref));
  assert.deepEqual(current.source_validation_refs, [f.tx(childId).current_validation_ref]);
});

test('replacement plans supersede drained child generations and Allocator retires the preserved domain', t => {
  const f = fixture(t); f.dispatch(f.initial, 'management');
  const spawned = object(f.send(f.role('allocator'), 'spawn_management_node', { transaction_id: f.initial, plan_ref: f.tx(f.initial).current_plan_ref }));
  const childId = text(spawned.delegated_transaction_id); const childNodeId = text(spawned.node_id);
  const role = f.role('orchestrator', childNodeId);
  f.store.createLease({ id: 'child-management-active', cluster_id: f.id, agent_id: role.agent_id, node_id: childNodeId, epoch: 1, expires: Date.now() + 60_000 });
  const original = f.tx(f.initial); const eventSeq = f.store.latestEventSeq(f.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: f.initial, expected_transaction_revision: original.revision, objective: 'a simpler revised goal' }), /active turn or lease/);
  assert.throws(() => f.send(f.role('auditor'), 'request_replan', { transaction_id: f.initial, required_change: 'revise the parent contract' }), /active turn or lease/);
  assert.throws(() => f.send(f.role('orchestrator'), 'set_dependency', { transaction_id: f.initial, expected_transaction_revision: original.revision, depends_on: [] }), /active turn or lease/);
  assert.deepEqual(f.tx(f.initial), original); assert.equal(f.store.latestEventSeq(f.id), eventSeq);
  f.store.run('DELETE FROM leases WHERE agent_id=?', role.agent_id);
  f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: f.initial, expected_transaction_revision: original.revision, objective: 'a simpler revised goal' });
  f.dispatch(f.initial);
  assert.equal(f.tx(childId).status, 'SUPERSEDED'); assert.equal(must(f.store.getNode(childNodeId)).status, 'DRAINING');
  assert.deepEqual(f.store.currentChildrenOfTransaction(f.id, f.initial), []); assert.ok(f.store.getPlan(original.current_plan_ref));
  f.send(f.role('allocator'), 'release_agent', { all: true, node_id: childNodeId });
  assert.equal(must(f.store.getNode(childNodeId)).status, 'RELEASED');
  for (const agent of f.store.agentsInSubtree(f.id, childNodeId)) assert.equal(agent.status, 'TERMINATED');
});

test('late child plan rejection revokes ancestor aggregate acceptance while preserving historical publications', t => {
  const f = fixture(t); f.dispatch(f.initial, 'management');
  const spawned = object(f.send(f.role('allocator'), 'spawn_management_node', { transaction_id: f.initial, plan_ref: f.tx(f.initial).current_plan_ref }));
  const childId = text(spawned.delegated_transaction_id);
  f.dispatch(childId); f.publish(childId); f.accept(childId);
  f.send(f.role('orchestrator'), 'aggregate', { transaction_id: f.initial }); f.accept(f.initial);
  const parentPublication = must(f.tx(f.initial).current_result_ref);
  const childPublication = must(f.tx(childId).current_result_ref);
  const childPlan = must(f.tx(childId).current_plan_ref);
  f.inspect(must(f.store.findAudit(f.id, childId, 'plan', childPlan.prepared_revision)), false);
  assert.equal(f.tx(childId).status, 'REJECTED');
  assert.equal(f.tx(f.initial).status, 'READY'); assert.equal(f.tx(f.initial).current_result_ref, null);
  assert.ok(f.store.getResult(parentPublication)); assert.ok(f.store.getResult(childPublication));
  assert.throws(() => f.send(f.role('orchestrator'), 'aggregate', { transaction_id: f.initial }), /not ACCEPTED/);
});

test('prepared parent contracts refuse undeclared children and false validation cannot enter acceptance', t => {
  const f = fixture(t); f.dispatch(f.initial);
  const count = f.store.countTransactions(f.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'create_transaction', { parent_transaction_id: f.initial, objective: 'undeclared child' }), /atomic decompose/);
  assert.equal(f.store.countTransactions(f.id), count);
  f.publish(f.initial);
  f.send(f.role('orchestrator'), 'validate', { transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, accepted: false, checks: f.checks(f.initial).map(check => ({ ...check, passed: false })) });
  f.store.updateTransaction(f.initial, { status: 'VALIDATING', __bump_revision: false });
  const current = f.tx(f.initial); const audit = must(f.store.findAudit(f.id, f.initial, 'validation', must(current.result_revision)));
  // A corrupted approval cannot convert the Orchestrator's negative business verdict into acceptance.
  f.store.run("UPDATE audits SET decision='APPROVED',auditor_agent_id=? WHERE id=?", f.role('auditor').agent_id, audit.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'accept_result', { transaction_id: f.initial }), /positive current validation/);
  assert.equal(f.tx(f.initial).status, 'VALIDATING');
});

test('a prepared recursive child must declare its real decomposition before dispatch', t => {
  const f = fixture(t); const parent = f.tx(f.initial);
  const child = { key: 'recursive', objective: 'prepare the two text calculations', acceptance_criteria: ['the two calculations are integrated'],
    plan: { ...draft({ objective: 'prepare the two text calculations', acceptance_criteria: ['the two calculations are integrated'] }, 'decompose'),
      criterion_responsibilities: [
        { criterion: { transaction_id: 'self', criterion_index: 0 }, evidence_provider: 'orchestrator', validated_by: 'orchestrator' },
        ...parent.acceptance_criteria.map((_, criterion_index) => ({ criterion: { transaction_id: 'parent', criterion_index }, evidence_provider: 'orchestrator', validated_by: 'orchestrator' })),
      ] },
  };
  const result = object(f.send(f.role('orchestrator'), 'decompose', { transaction_id: parent.id, expected_transaction_revision: parent.revision,
    plan: { ...draft(parent, 'decompose'), criterion_responsibilities: parent.acceptance_criteria.map((_, criterion_index) => ({
      criterion: { transaction_id: 'self', criterion_index }, evidence_provider: child.key, validated_by: 'orchestrator',
    })) }, children: [child] }));
  const childId = text(object(must((result.children as FlowJsonValue[])[0])).transaction_id);
  const seq = f.store.latestEventSeq(f.id);
  assert.throws(() => f.send(f.role('orchestrator'), 'dispatch', { transaction_id: childId }), /call decompose.*actual children/);
  assert.equal(f.tx(childId).status, 'DRAFT'); assert.equal(f.store.latestEventSeq(f.id), seq);
});

test('replacement Worker identities retain the same valid formal execution contract', t => {
  const f = fixture(t); f.dispatch(f.initial);
  f.send(f.role('allocator'), 'allocate_agent', { transaction_id: f.initial });
  const allocation = must(f.store.activeAllocationForTransaction(f.initial));
  const agent = must(f.store.getAgent(allocation.agent_id));
  f.send(f.role('orchestrator'), 'adjust_transaction', { transaction_id: f.initial, expected_transaction_revision: f.tx(f.initial).revision, objective: 'revise the work before assigning a replacement' });
  const count = f.store.countAgents(f.id), seq = f.store.latestEventSeq(f.id);
  assert.throws(() => f.send(f.role('allocator'), 'replace_agent', { agent_id: agent.id }), /current prepared plan/);
  assert.equal(f.store.countAgents(f.id), count); assert.equal(f.store.latestEventSeq(f.id), seq);
  assert.equal(must(f.store.getAgent(agent.id)).status, agent.status);
  f.dispatch(f.initial, 'management');
  assert.throws(() => f.send(f.role('allocator'), 'replace_agent', { agent_id: agent.id }), /requires worker/);
  assert.equal(f.store.countAgents(f.id), count);
});

test('atomic decomposition rejects any superseded explicit parent criterion even beside correct coverage', t => {
  const f = fixture(t); f.dispatch(f.initial);
  const oldParent = must(f.tx(f.initial).current_plan_ref);
  f.send(f.role('auditor'), 'request_replan', { transaction_id: f.initial, required_change: 'split the work into an explicit child contract' });
  const parent = f.tx(f.initial), seq = f.store.latestEventSeq(f.id);
  const childPlan = { ...draft({ objective: 'deliver both calculations', acceptance_criteria: ['both values are delivered'] }),
    criterion_responsibilities: [
      { criterion: { transaction_id: 'self', criterion_index: 0 }, evidence_provider: 'worker', validated_by: 'orchestrator' },
      ...parent.acceptance_criteria.map((_, criterion_index) => ({ criterion: { transaction_id: 'parent', criterion_index }, evidence_provider: 'worker', validated_by: 'orchestrator' })),
      { criterion: { ...oldParent, criterion_index: 0 }, evidence_provider: 'worker', validated_by: 'orchestrator' },
    ],
  };
  assert.throws(() => f.send(f.role('orchestrator'), 'decompose', { transaction_id: parent.id, expected_transaction_revision: parent.revision,
    plan: { ...draft(parent, 'decompose'), criterion_responsibilities: parent.acceptance_criteria.map((_, criterion_index) => ({
      criterion: { transaction_id: 'self', criterion_index }, evidence_provider: 'part', validated_by: 'orchestrator',
    })) }, children: [{ key: 'part', objective: 'deliver both calculations', acceptance_criteria: ['both values are delivered'], plan: childPlan }] }), /parent criterion reference is superseded/);
  assert.deepEqual(f.tx(parent.id), parent); assert.equal(f.store.childrenOfTransaction(f.id, parent.id).length, 0);
  assert.equal(f.store.latestEventSeq(f.id), seq); assert.ok(f.store.getPlan(oldParent));
});
