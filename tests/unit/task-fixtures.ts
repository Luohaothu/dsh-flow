/** Complete task contracts for mechanism tests whose subject is elsewhere. */
import type { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowActor, TransactionRecord } from '../../packages/dsh-flow/src/core/model.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';

export function fixturePlan(tx: Pick<TransactionRecord, 'objective' | 'expected_output' | 'acceptance_criteria'>,
  execution: 'worker' | 'management' | 'decompose' = 'worker'): Record<string, unknown> {
  return {
    understanding: `Deliver ${tx.objective}; the required output is ${tx.expected_output || 'the requested result'}.`,
    execution,
    rationale: execution === 'management' ? 'This fixture exercises a delegated planning domain.' : execution === 'decompose'
      ? 'The independent fixture deliverables are combined by the parent.' : 'One worker can deliver this fixture work unit.',
    assignment: `${tx.objective}. Deliver ${tx.expected_output || 'the requested result'} with execution evidence, preserving the formal constraints.`,
    criterion_responsibilities: tx.acceptance_criteria.map((_criterion, index) => ({
      criterion: { transaction_id: 'self', criterion_index: index }, evidence_provider: execution === 'management' ? 'orchestrator' : 'worker',
      validated_by: 'orchestrator', applies_to: ['worker', 'orchestrator'],
    })),
    ...(execution !== 'worker' ? { integration: 'The parent combines every accepted child and validates the formal parent criteria.' } : {}),
  };
}

export function fixtureAuditEvidence(runtime: ClusterRuntime, transactionId: string, kind: 'plan' | 'validation', approved = true): Record<string, unknown> {
  const tx = runtime.store.getTransaction(transactionId);
  const ref = kind === 'plan' ? tx?.current_plan_ref : tx?.current_validation_ref;
  const rules = kind === 'plan' ? ['goal_coverage', 'responsibility', 'dependencies', 'handoff', 'acceptance_arrangement']
    : ['standard_coverage', 'checks_performed', 'evidence_applicability', 'conclusion_support', 'authority'];
  return { checks: rules.map((rule, index) => ({ rule,
    method: kind === 'plan' ? 'Inspect the saved plan against its immutable formal contract.' : 'Inspect the coordinating agent validation record against its formal criteria, publication and execution evidence.',
    observation: approved ? `The fixture record satisfies ${rule}.` : `The fixture record ${index === 0 ? 'fails' : 'satisfies'} ${rule}.`,
    passed: approved || index !== 0, evidence_refs: [{ kind, ref }],
  })) };
}

/** Explicitly initialise a durable test work unit through the manager's API. */
export function prepareFixtureTask(runtime: ClusterRuntime, transactionId: string, execution: 'worker' | 'management' = 'worker'): void {
  const tx = runtime.store.getTransaction(transactionId);
  if (!tx || tx.current_plan_ref) return;
  if (tx.parent_transaction_id) prepareFixtureTask(runtime, tx.parent_transaction_id, 'management');
  const lead = runtime.store.listAgents(tx.cluster_id, { node_id: tx.node_id, role: 'orchestrator', limit: 1 })[0];
  if (!lead) throw new Error('The work fixture requires its manager identity');
  const originalStatus = tx.status;
  if (originalStatus !== 'DRAFT') runtime.store.updateTransaction(tx.id, { status: 'DRAFT', __bump_revision: false });
  const live = runtime.store.getTransaction(tx.id)!;
  runtime.command({ cluster_id: tx.cluster_id, node_id: tx.node_id, role: 'orchestrator', agent_id: lead.id, session_id: lead.session_id }, {
    command_id: `fixture-plan:${tx.id}:${live.revision}`, action: 'dispatch',
    params: { transaction_id: tx.id, expected_transaction_revision: live.revision, plan: fixturePlan(tx, execution) },
  });
  if (!['DRAFT', 'READY'].includes(originalStatus)) runtime.store.updateTransaction(tx.id, { status: originalStatus, result: tx.result, validation: tx.validation, result_revision: tx.result_revision, __bump_revision: false });
}

/** A fixture publication is attributed to the fixture author, never claimed as native Worker execution. */
export function publishFixtureResult(runtime: ClusterRuntime, transactionId: string): void {
  const fixtureResult = runtime.store.getTransaction(transactionId)?.result;
  prepareFixtureTask(runtime, transactionId);
  if (fixtureResult !== null && fixtureResult !== undefined) runtime.store.updateTransaction(transactionId, { result: fixtureResult, __bump_revision: false });
  const tx = runtime.store.getTransaction(transactionId)!;
  if (tx.current_result_ref || tx.result === null) return;
  const seq = runtime.store.appendEvent(tx.cluster_id, 'fixture-result-published', { transaction_id: tx.id, author: 'test fixture' }).seq;
  runtime.store.publishResult(tx.id, { producer_role: 'user', producer_agent_id: null, epoch: null, turn_seq: null, publication_event_seq: seq });
}

/** Read an explicitly selected large field through its stable content cursor. */
export function readFixtureField(runtime: ClusterRuntime, actor: FlowActor, kind: string, reference: { id?: string; call_id?: string }, field: string): unknown {
  const first = objectField(runtime.query(actor, kind, { ...reference, fields: [field] }), 'field projection');
  const value = first[field];
  if (!value || typeof value !== 'object' || !('ref' in value)) return value;
  let offset = 0;
  let text = '';
  let encoding: unknown;
  for (;;) {
    const answer = objectField(runtime.query(actor, kind, { ...reference, fields: [field], content_field: field,
      content_offset: offset, content_limit: 8_000, content_snapshot_id: String(objectField(value, 'field reference').snapshot_id) }), 'content page');
    const page = objectField(answer[field], 'content page field');
    text += String(page.content ?? ''); encoding = page.encoding;
    if (page.next_offset === null) break;
    offset = Number(page.next_offset);
  }
  return encoding === 'json' ? JSON.parse(text) : text;
}

/** Add explicit plans and evidence to older lifecycle fixtures, never to contract-negative tests. */
export function fixtureParams(runtime: ClusterRuntime, actor: FlowActor, action: string, params: Record<string, unknown>): Record<string, unknown> {
  const targetId = typeof params.transaction_id === 'string' ? params.transaction_id : typeof params.audit_id === 'string' ? runtime.store.getAudit(params.audit_id)?.transaction_id : null;
  const tx = targetId ? runtime.store.getTransaction(targetId) : null;
  if (action === 'create_transaction' && params.acceptance_criteria === undefined) return { ...params, acceptance_criteria: ['The specified fixture deliverable is provided.'] };
  if (tx && action === 'allocate_agent' && !tx.current_plan_ref && actor.role === 'allocator' && actor.cluster_id === tx.cluster_id && actor.node_id === tx.node_id) prepareFixtureTask(runtime, tx.id);
  if (tx && ['request_correction', 'request_revalidation'].includes(action) && !tx.current_result_ref && tx.result !== null) publishFixtureResult(runtime, tx.id);
  if (tx && ['inspect_plan', 'inspect_validation'].includes(action) && !(params.evidence && typeof params.evidence === 'object' && 'checks' in params.evidence)) {
    const supplied = params.evidence && typeof params.evidence === 'object' ? Object.fromEntries(Object.entries(params.evidence)) : {};
    return { ...params, evidence: { ...supplied, ...fixtureAuditEvidence(runtime, tx.id, action === 'inspect_plan' ? 'plan' : 'validation', !['reject', 'REJECTED', 'replan', 'REPLAN_REQUESTED'].includes(String(params.decision))) } };
  }
  if (action === 'spawn_management_node') {
    const { fixture_prepare_management: _prepare, ...body } = params;
    void _prepare;
    if (tx && !tx.current_plan_ref && tx.status === 'DRAFT' && actor.role === 'allocator' && (actor.node_id === tx.node_id || body.node_id === tx.node_id) && actor.cluster_id === tx.cluster_id) {
      const lead = runtime.store.listAgents(tx.cluster_id, { node_id: tx.node_id, role: 'orchestrator', limit: 1 })[0];
      if (!lead) throw new Error('The management fixture requires its real Orchestrator identity');
      runtime.command({ cluster_id: tx.cluster_id, node_id: tx.node_id, role: 'orchestrator', agent_id: lead.id, session_id: lead.session_id }, {
        command_id: `fixture-management-plan:${tx.id}:${tx.revision}`, action: 'dispatch',
        params: { transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx, 'management') },
      });
    }
    const current = tx ? runtime.store.getTransaction(tx.id) : null;
    const saved = runtime.store.getPlan(current?.current_plan_ref);
    return { ...body, ...(saved ? { plan_ref: saved.ref, ...(body.objective === undefined ? {} : { objective: saved.assignment }) } : {}) };
  }
  if (action === 'dispatch') {
    const execution = params.fixture_execution === 'management' ? 'management' : 'worker';
    const { fixture_execution: _fixtureExecution, ...body } = params;
    void _fixtureExecution;
    if (tx && !tx.current_plan_ref && body.plan === undefined) return { ...body, expected_transaction_revision: tx.revision, plan: fixturePlan(tx, execution) };
    if (!tx && body.transactions === undefined && (params.node_id || params.limit)) {
      const targets = runtime.store.listTransactions({ cluster_id: actor.cluster_id, node_id: String(params.node_id ?? (actor.role === 'user' ? undefined : actor.node_id)), status: 'DRAFT', limit: Number(params.limit ?? 64) });
      return { transactions: targets.map(target => ({ transaction_id: target.id,
        ...(!target.current_plan_ref ? { expected_transaction_revision: target.revision, plan: fixturePlan(target, execution) } : {}) })) };
    }
    return body;
  }
  if (tx && action === 'decompose' && Array.isArray(params.children) && params.plan === undefined) {
    const children = params.children.map((raw, index) => {
      const child = objectField(raw, 'fixture child');
      const key = typeof child.key === 'string' ? child.key : `child-${index}`;
      const criteria = Array.isArray(child.acceptance_criteria) ? child.acceptance_criteria.map(String) : ['The specified child deliverable is provided.'];
      const plan = fixturePlan({ objective: String(child.objective), expected_output: String(child.expected_output ?? 'the requested child deliverable'), acceptance_criteria: criteria });
      return { ...child, key, acceptance_criteria: criteria, plan: { ...plan,
        criterion_responsibilities: [...objectField(plan, 'child plan').criterion_responsibilities as Record<string, unknown>[],
          ...tx.acceptance_criteria.map((_criterion, index) => ({ criterion: { transaction_id: 'parent', criterion_index: index }, evidence_provider: 'worker', validated_by: 'orchestrator', applies_to: ['worker'] }))] } };
    });
    const plan = { ...fixturePlan(tx, 'decompose'), criterion_responsibilities: children.flatMap(child => tx.acceptance_criteria.map((_criterion, index) => ({
      criterion: { transaction_id: 'self', criterion_index: index }, evidence_provider: child.key, validated_by: 'orchestrator', applies_to: [child.key] }))) };
    return { ...params, expected_transaction_revision: tx.revision, plan, children };
  }
  if (tx && ['adjust_transaction', 'set_dependency'].includes(action)) return { expected_transaction_revision: tx.revision, ...params };
  if (tx && action === 'validate') {
    if (!tx.current_result_ref && tx.result !== null && tx.current_plan_ref) {
      publishFixtureResult(runtime, tx.id);
    }
    const live = runtime.store.getTransaction(tx.id)!;
    const original = Array.isArray(params.checks) ? params.checks : [];
    const checks = tx.acceptance_criteria.map((criterion, index) => {
      const candidate = original[index];
      const supplied: Record<string, unknown> = candidate && typeof candidate === 'object' ? Object.fromEntries(Object.entries(candidate)) : {};
      return { ...supplied,
        criterion, criterion_ref: { transaction_id: tx.id, prepared_revision: live.current_plan_ref?.prepared_revision, criterion_index: index },
        method: 'Compare the fixture publication to the recorded formal criterion.',
        observation: JSON.stringify(tx.result),
        evidence_refs: [{ kind: 'result', ref: live.current_result_ref }],
        evidence: typeof supplied.evidence === 'string' && supplied.evidence ? supplied.evidence : 'The published fixture result was inspected.',
        passed: supplied.passed === undefined ? params.accepted !== false : supplied.passed,
      };
    });
    return { expected_transaction_revision: live.revision, ...params, checks };
  }
  return params;
}
