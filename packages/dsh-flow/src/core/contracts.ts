/** Immutable business contracts and the structural checks shared by every entry. */
import { fail } from '../errors.ts';
import { objectField } from '../validation.ts';
import type { FlowJsonValue } from '../types.ts';
import type { ClusterStore } from './store.ts';
import type { CriterionRef, FlowActor, PlanRecord, PlanRef, TaskContract, TransactionRecord } from './model.ts';

export function sameRef(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contractFor(store: ClusterStore, tx: TransactionRecord): TaskContract {
  return {
    objective: tx.objective, inputs: tx.inputs, constraints: tx.constraints,
    expected_output: tx.expected_output, acceptance_criteria: tx.acceptance_criteria,
    capabilities: tx.capabilities, needs: tx.needs, dependencies: store.dependenciesOf(tx.id),
  };
}

export function assertExpectedTransaction(tx: TransactionRecord, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('expected_transaction_revision is required; read the current transaction before changing it', 409);
  if (tx.revision !== value) fail(`transaction revision conflict: expected ${value}, current ${tx.revision}`, 409);
}

export function validPlan(store: ClusterStore, tx: TransactionRecord, execution?: PlanRecord['execution'], allowRejectedCurrent = false): PlanRecord {
  const plan = store.getPlan(tx.current_plan_ref);
  if (!plan || !sameRef(plan.contract, contractFor(store, tx))) fail(`transaction ${tx.id} has no current prepared plan`, 409);
  if (execution && plan.execution !== execution) fail(`transaction ${tx.id} uses ${plan.execution} execution; this action requires ${execution}`, 409);
  const verdict = store.findAudit(tx.cluster_id, tx.id, 'plan', plan.ref.prepared_revision);
  if (!allowRejectedCurrent && (verdict?.decision === 'REJECTED' || verdict?.decision === 'REPLAN_REQUESTED')) fail(`plan for transaction ${tx.id} was rejected; revise it before execution`, 409);
  let ancestorId = tx.parent_transaction_id;
  const visited = new Set<string>();
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = store.getTransaction(ancestorId);
    if (!ancestor?.current_plan_ref) fail('the parent contract requires replanning before child execution', 409);
    const parentAudit = store.findAudit(tx.cluster_id, ancestor.id, 'plan', ancestor.current_plan_ref.prepared_revision);
    if (parentAudit?.decision === 'REJECTED' || parentAudit?.decision === 'REPLAN_REQUESTED') fail('the parent plan requires correction before child execution', 409);
    for (const responsibility of plan.criterion_responsibilities) {
      if (responsibility.criterion.transaction_id === ancestor.id
        && !sameRef({ transaction_id: ancestor.id, prepared_revision: responsibility.criterion.prepared_revision }, ancestor.current_plan_ref)) fail('child plan is bound to a superseded parent contract', 409);
    }
    ancestorId = ancestor.parent_transaction_id;
  }
  return plan;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must contain the manager's decision`);
  return value.trim();
}

/** Structural inheritance is checked without pretending to judge natural language. */
export function retainsConstraints(child: FlowJsonValue, parent: FlowJsonValue): boolean {
  if (Array.isArray(parent)) return Array.isArray(child) && parent.every(item => child.some(candidate => sameRef(item, candidate)));
  if (parent !== null && typeof parent === 'object') {
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      && Object.entries(parent).every(([key, item]) => retainsConstraints(child[key] ?? null, item));
  }
  return parent === null || sameRef(child, parent);
}

export function preparePlan(
  store: ClusterStore, tx: TransactionRecord, actor: FlowActor, draft: unknown,
  options: { children?: ReadonlyMap<string, TransactionRecord>; parentPlan?: PlanRecord; inherited?: TaskContract } = {},
): PlanRecord {
  const raw = objectField(draft, 'plan');
  const execution = raw.execution;
  if (execution !== 'worker' && execution !== 'decompose' && execution !== 'management') fail('plan.execution must be worker, decompose or management');
  const ref: PlanRef = { transaction_id: tx.id, prepared_revision: tx.revision + 1 };
  const contract = contractFor(store, tx);
  if (options.inherited && !retainsConstraints(contract.constraints, options.inherited.constraints)) fail('child contract must retain applicable parent constraints', 409);
  const rawResponsibilities = raw.criterion_responsibilities;
  if (!Array.isArray(rawResponsibilities)) fail('plan.criterion_responsibilities must explicitly cover the formal criteria');
  const responsibilities = rawResponsibilities.map((entry, index) => {
    const responsibility = objectField(entry, `plan.criterion_responsibilities[${index}]`);
    const criterion = objectField(responsibility.criterion, 'criterion reference');
    const criterionIndex = criterion.criterion_index;
    if (typeof criterionIndex !== 'number' || !Number.isInteger(criterionIndex) || criterionIndex < 0) fail('criterion_index must be a nonnegative integer');
    let criterionRef: CriterionRef;
    const referencedChild = typeof criterion.transaction_id === 'string' ? options.children?.get(criterion.transaction_id) : undefined;
    if (referencedChild) {
      if (criterionIndex >= referencedChild.acceptance_criteria.length) fail('child criterion is outside its formal contract');
      criterionRef = { transaction_id: referencedChild.id, prepared_revision: referencedChild.revision + 1, criterion_index: criterionIndex };
    } else if (options.parentPlan && (criterion.transaction_id === 'parent'
      || (criterion.transaction_id === options.parentPlan.ref.transaction_id && criterion.prepared_revision === undefined))) {
      if (criterionIndex >= options.parentPlan.contract.acceptance_criteria.length) fail('parent criterion is outside the inherited contract');
      criterionRef = { ...options.parentPlan.ref, criterion_index: criterionIndex };
    } else if (criterion.transaction_id === 'self') {
      if (criterionIndex >= contract.acceptance_criteria.length) fail('criterion reference is outside this formal contract');
      criterionRef = { ...ref, criterion_index: criterionIndex };
    } else {
      if (typeof criterion.transaction_id !== 'string' || typeof criterion.prepared_revision !== 'number') fail("criterion reference requires transaction_id and prepared_revision; atomic child plans may use transaction_id:'parent' with criterion_index to bind the newly prepared parent without guessing a revision");
      criterionRef = { transaction_id: criterion.transaction_id, prepared_revision: criterion.prepared_revision, criterion_index: criterionIndex };
      const target = sameRef({ transaction_id: criterionRef.transaction_id, prepared_revision: criterionRef.prepared_revision }, options.parentPlan?.ref)
        ? options.parentPlan : store.getPlan(criterionRef);
      if (!target || target.cluster_id !== tx.cluster_id || criterionIndex >= target.contract.acceptance_criteria.length) fail('criterion reference does not resolve to an immutable formal contract', 409);
      if (target.ref.transaction_id !== tx.id && target.ref.transaction_id !== tx.parent_transaction_id) fail('criterion reference is outside this task and its parent contract', 403);
      if (target.ref.transaction_id === tx.parent_transaction_id
        && !sameRef(options.parentPlan?.ref ?? store.getTransaction(tx.parent_transaction_id)?.current_plan_ref, target.ref)) {
        fail("parent criterion reference is superseded; use transaction_id:'parent' to bind this atomic parent plan", 409);
      }
    }
    const provider = text(responsibility.evidence_provider, 'evidence_provider');
    if (provider === 'auditor') fail('Auditor governance cannot be assigned business delivery or validation');
    const child = options.children?.get(provider);
    if (!child && provider !== 'worker' && provider !== 'orchestrator') {
      fail(`unknown evidence provider ${provider}; use worker or orchestrator, or an exact child key declared in this atomic decompose call. A management plan uses orchestrator for its integrated delivery; the Allocator creates its child domain later, so do not guess a future child key.`);
    }
    if (execution === 'worker' && child) fail('direct worker plan cannot assign children');
    if (responsibility.validated_by !== 'orchestrator') fail('business validation belongs to the Orchestrator');
    const applies = responsibility.applies_to;
    if (applies !== undefined && (!Array.isArray(applies) || applies.some(item => typeof item !== 'string'))) fail('applies_to must be a list of participant roles or child keys');
    const validParticipants = new Set(['worker', 'orchestrator', 'allocator', 'auditor', ...Array.from(options.children?.keys() ?? [])]);
    if (Array.isArray(applies) && applies.some(item => !validParticipants.has(String(item)))) fail('applies_to contains an unknown participant or child key');
    return {
      criterion: criterionRef, evidence_provider: child?.id ?? provider,
      validated_by: 'orchestrator' as const,
      applies_to: Array.isArray(applies) ? applies.map(item => options.children?.get(String(item))?.id ?? String(item)) : [child?.id ?? provider],
    };
  });
  for (let index = 0; index < contract.acceptance_criteria.length; index += 1) {
    if (!responsibilities.some(item => sameRef(item.criterion, { ...ref, criterion_index: index }))) fail(`plan omits formal criterion ${index}`);
  }
  const integration = raw.integration === undefined || raw.integration === null ? null : text(raw.integration, 'plan.integration');
  if (execution !== 'worker' && !integration) fail('decomposed and delegated plans require integration responsibility');
  return {
    ref, cluster_id: tx.cluster_id, author_role: actor.role, author_agent_id: actor.role === 'user' ? null : actor.agent_id,
    created: store.now(), contract, understanding: text(raw.understanding, 'plan.understanding'), execution,
    rationale: text(raw.rationale, 'plan.rationale'), assignment: execution === 'decompose' && raw.assignment === undefined
      ? text(raw.integration, 'plan.integration') : text(raw.assignment, 'plan.assignment'),
    assignment_key: typeof raw.assignment_key === 'string' && raw.assignment_key.trim() ? raw.assignment_key.trim() : 'primary',
    child_transaction_ids: Array.from(options.children?.values() ?? []).map(child => child.id),
    criterion_responsibilities: responsibilities, integration,
  };
}

export function savePlan(store: ClusterStore, tx: TransactionRecord, plan: PlanRecord): TransactionRecord {
  store.insertPlan(plan);
  return store.updateTransaction(tx.id, {
    current_plan_ref: plan.ref, current_validation_ref: null, validation: null,
    plan_approved_revision: null,
    current_result_ref: null, result: null, result_revision: null,
    result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
  }) ?? fail('Transaction not found', 404);
}

/** Explicit standalone input is its own user-authored direct contract. */
export function prepareDirectWorkerContract(store: ClusterStore, tx: TransactionRecord, actor: FlowActor, assignment: string): PlanRecord {
  const plan = preparePlan(store, tx, actor, {
    understanding: tx.objective, execution: 'worker', rationale: 'The explicit single-worker input selects direct execution.', assignment,
    criterion_responsibilities: tx.acceptance_criteria.map((_, criterion_index) => ({
      criterion: { transaction_id: 'self', criterion_index }, evidence_provider: 'worker', validated_by: 'orchestrator', applies_to: ['worker'],
    })),
  });
  savePlan(store, tx, plan);
  return plan;
}
