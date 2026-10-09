/**
 * Scripted model behaviour for the deterministic acceptance runs.
 *
 * One scenario drives one case. Each provider request is answered from the
 * request's own facts — the trusted native identity, scoped task queries and the newest tool
 * result — so the script is keyed by *identity and state*, never by arrival
 * order: two concurrent Workers interleave freely and still get the answer
 * their own transaction owes.
 *
 * A scenario only ever produces model output. It never writes to the cluster's
 * database, never edits a Worker's result file and never marks an issue
 * corrected: everything the checks read must have been done by the plugin, the
 * host, or a real tool call.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { COMPACTION_MARKER } from './mock-model.ts';
import { asRecord, listOf, recordsOf, textOf, numberOf } from './mock-model.ts';
import type {
  MockWorkContext,
  MockRequestClassification,
  MockRequestRecord,
  MockScenario,
  MockScenarioReply,
} from './mock-model.ts';

const ROLE_TOOL_NAME: Record<string, string> = { orchestrator: 'flow_transaction', allocator: 'flow_allocation', auditor: 'flow_audit' };
const WORKER_TOOL_NAME = 'flow_transaction';

/** One assistant turn that calls a tool. */
export function call(name: string, args?: unknown, extra: MockScenarioReply = {}): MockScenarioReply {
  return { toolCalls: [{ name, arguments: JSON.stringify(args ?? {}) }], ...extra };
}

/** One assistant turn with no tool call: the turn ends on its own. */
export function say(text: string, extra: MockScenarioReply = {}): MockScenarioReply {
  return { text, ...extra };
}

const STATUS_LINE = 'The durable action has been recorded.';

/** Native compaction preserves business context; live work is queried again. */
export function checkpointFor(classified: MockRequestClassification | null): string {
  return [
    '## Primary Request and Intent',
    'Continue the assigned work and preserve its formal requirements.',
    '## Key Technical Concepts',
    'Worker delivery, Orchestrator validation and independent governance review.',
    '## Files and Code',
    'Read concrete inputs through the authorised tools when needed.',
    '## Errors and Fixes',
    'The durable records contain any outstanding correction.',
    '## Pending Jobs',
    'Read the bound assignment and the role agenda before continuing.',
    '## Current Work',
    classified?.objective ?? 'The native turn was interrupted by context pressure.',
    '## Next Step',
    'Query the current assignment and relevant object fields.',
    '## Critical Context',
    'The host retains identity and input bindings outside this checkpoint.',
  ].join('\n');
}

/** One budget row a `flow_query what:"budgets"` answer carried. */
interface MockBudgetRow {
  scope_kind: string;
  scope_id: string;
  available: { tool_calls: number };
}

/** The budget rows a `flow_query what:"budgets"` result carried, or none. */
function budgetRows(text: unknown): MockBudgetRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  return listOf(asRecord(parsed)?.items)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter(row => typeof row.scope_kind === 'string' && asRecord(row.available) !== null && typeof asRecord(row.available)?.tool_calls === 'number')
    .map(row => {
      const available = asRecord(row.available) ?? {};
      return {
        scope_kind: String(row.scope_kind),
        scope_id: String(row.scope_id ?? ''),
        available: {
          tool_calls: Number(available.tool_calls ?? 0),
        },
      };
    })
    .filter(row => row.scope_id);
}

/** A stable name for one pending item, so the script can tell them apart. */
function signatureOf(item: Record<string, unknown>): string {
  return `${item.action}:${item.transaction_id ?? item.node_id ?? ''}`;
}

interface QueriedWork {
  assignment?: Record<string, unknown>;
  agenda?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  node?: Record<string, unknown>;
  children?: Record<string, unknown>[];
  childrenNext?: number | null;
  budgets?: Record<string, unknown>[];
  budgetNext?: number | null;
  transactions?: Record<string, unknown>[];
  transactionNext?: number | null;
  effects?: Record<string, unknown>[];
  effectDetails?: Record<string, Record<string, unknown>>;
  expansion?: { what: unknown; params: Record<string, unknown>; field: string; text: string; answer: Record<string, unknown> };
}

/** All scripted decisions read the same scoped tools available to real members. */
function readWork(request: MockRequestRecord, work: Map<string, QueriedWork>, caseId: string): MockScenarioReply | null {
  const c = request.classified;
  if (c.kind !== 'role' && c.kind !== 'worker') return null;
  const key = `${c.agentId}:${c.identity.epoch ?? 0}:${c.identity.turnSeq ?? 0}`;
  let state = work.get(key);
  const freshTurn = !state;
  if (!state) { state = {}; work.set(key, state); }
  const queried = !freshTurn && c.lastToolName === 'flow_query' && (c.kind === 'role' || !state.assignment) ? c.lastToolArguments : null;
  if (queried) {
    let answer: Record<string, unknown> | null = null;
    try { answer = asRecord(JSON.parse(c.lastToolResult ?? 'null')); } catch { /* Report a failed query without inventing work. */ }
    if (!answer || answer.error) return say('The required task query failed; waiting for current task information.');
    if (state.expansion && queried.what === state.expansion.what && asRecord(queried.params)?.content_field === state.expansion.field) {
      const expansion = state.expansion;
      const page = asRecord(answer[expansion.field]);
      if (!page || typeof page.content !== 'string') return say('The requested content page was unavailable.');
      expansion.text += page.content;
      if (page.next_offset !== null) return call('flow_query', { what: expansion.what, params: { ...expansion.params, content_offset: page.next_offset } });
      let complete: unknown = expansion.text;
      if (page.encoding === 'json') { try { complete = JSON.parse(expansion.text); } catch { return say('The complete queried field was not valid JSON.'); } }
      answer = { ...expansion.answer, [expansion.field]: complete };
      delete state.expansion;
    }
    const large = Object.entries(answer).find(([, value]) => asRecord(value)?.complete === false && asRecord(asRecord(value)?.read));
    if (large) {
      const [field, value] = large;
      const read = asRecord(asRecord(value)?.read) ?? {};
      const params = asRecord(read.params) ?? {};
      state.expansion = { what: read.what, params, field, text: '', answer };
      return call('flow_query', { what: read.what, params });
    }
    switch (queried.what) {
      case 'assignment': state.assignment = answer; break;
      case 'agenda': state.agenda = answer; break;
      case 'transaction': state.transaction = answer; break;
      case 'node': state.node = answer; break;
      case 'nodes': {
        const offset = Number(asRecord(queried.params)?.offset ?? 0);
        state.children = [...(offset ? state.children ?? [] : []), ...recordsOf(answer.items)];
        state.childrenNext = typeof answer.next_offset === 'number' ? answer.next_offset : null;
        break;
      }
      case 'budgets': {
        const offset = Number(asRecord(queried.params)?.offset ?? 0);
        state.budgets = [...(offset ? state.budgets ?? [] : []), ...recordsOf(answer.items)];
        state.budgetNext = typeof answer.next_offset === 'number' ? answer.next_offset : null;
        break;
      }
      case 'transactions': {
        const offset = Number(asRecord(queried.params)?.offset ?? 0);
        state.transactions = [...(offset ? state.transactions ?? [] : []), ...recordsOf(answer.items)];
        state.transactionNext = typeof answer.next_offset === 'number' ? answer.next_offset : null;
        break;
      }
      case 'effects': state.effects = recordsOf(answer.items); break;
      case 'effect': state.effectDetails = { ...state.effectDetails, [String(asRecord(queried.params)?.call_id)]: answer }; break;
    }
  }
  const roleFields = c.role === 'worker'
    ? ['brief', 'requirements', 'constraints', 'inputs', 'allocation']
    : c.role === 'auditor' ? ['brief', 'requirements', 'plan', 'validation', 'audit']
      : ['brief', 'requirements', 'constraints', 'inputs', 'plan'];
  if (!state.assignment) return call('flow_query', { what: 'assignment', params: { fields: roleFields } });
  const assignment = state.assignment;
  const binding = asRecord(assignment.binding);
  const requirements = asRecord(assignment.requirements);
  c.transactionId = textOf(binding?.transaction_id);
  c.objective = textOf(requirements?.objective) ?? textOf(assignment.brief) ?? textOf(assignment.title);
  c.identity.transactionId = c.transactionId;
  c.identity.objective = c.objective;
  request.transaction_id = c.transactionId;
  if (c.kind === 'worker') { c.context = assignment; return null; }
  if (!state.agenda) return call('flow_query', { what: 'agenda', params: { limit: 8 } });
  const actions = recordsOf(state.agenda.items).map(item => ({ ...asRecord(item.details), ...item }));
  const selected = actions.find(item => item.action !== 'inbox');
  const targetId = textOf(selected?.transaction_id);
  if (targetId && !state.transaction) {
    const fields = c.role === 'auditor' ? ['requirements', 'plan', 'validation', 'result', 'audits', 'issues', 'evidence']
      : c.role === 'allocator' ? ['requirements', 'inputs', 'plan', 'allocation']
        : ['requirements', 'constraints', 'inputs', 'plan', 'result', 'validation', 'evidence'];
    return call('flow_query', { what: 'transaction', params: { id: targetId, fields } });
  }
  if (c.role === 'orchestrator' && selected?.action === 'validate') {
    const record = asRecord(state.transaction?.result);
    if (asRecord(record?.result)?.completed === true && typeof asRecord(record?.result)?.file === 'string' && record?.producer_agent_id) {
      if (!state.effects) return call('flow_query', { what: 'effects', params: { agent_id: record.producer_agent_id, limit: 20 } });
      const pending = state.effects.find(effect => !state.effectDetails?.[String(effect.call_id)]);
      if (pending) return call('flow_query', { what: 'effect', params: { call_id: pending.call_id, fields: ['args', 'body', 'status', 'tool', 'agent_id', 'turn_seq'] } });
    }
  }
  if (c.role === 'orchestrator' && selected?.action === 'finish_cluster') {
    if (!state.transactions) return call('flow_query', { what: 'transactions', params: { node_id: c.nodeId, limit: 4 } });
    if (state.transactionNext !== null && state.transactionNext !== undefined)
      return call('flow_query', { what: 'transactions', params: { node_id: c.nodeId, limit: 4, offset: state.transactionNext } });
  }
  if (c.role === 'allocator' && (selected?.action === 'allocate_agent' || caseId === 'scale')) {
    if (!state.node) return call('flow_query', { what: 'node', params: { id: c.nodeId, full: true, limit: 3 } });
    if (!state.children) return call('flow_query', { what: 'nodes', params: { parent_id: c.nodeId, limit: 8 } });
    if (state.childrenNext !== null && state.childrenNext !== undefined)
      return call('flow_query', { what: 'nodes', params: { parent_id: c.nodeId, limit: 8, offset: state.childrenNext } });
    if (!state.budgets) return call('flow_query', { what: 'budgets', params: { limit: 6 } });
    const managementAgents = recordsOf(asRecord(state.node.agents)?.items).filter(agent => agent.role !== 'worker');
    const knownBudgets = state.budgets;
    const missingRoleBudget = managementAgents.some(agent => !knownBudgets.some(row => row.scope_kind === 'agent' && row.scope_id === agent.id));
    const missingNodeBudget = !knownBudgets.some(row => row.scope_kind === 'node' && row.scope_id === c.nodeId);
    if ((missingRoleBudget || missingNodeBudget) && state.budgetNext !== null && state.budgetNext !== undefined)
      return call('flow_query', { what: 'budgets', params: { limit: 6, offset: state.budgetNext } });
  }
  const nodeBudget = state.budgets?.find(row => row.scope_kind === 'node' && row.scope_id === c.nodeId);
  c.context = {
    ...assignment,
    work_items: actions,
    transaction: state.transaction,
    node: state.node?.node ?? { delegated_transaction_id: binding?.transaction_id },
    ancestors: state.node?.ancestors ?? (c.depth === 0 ? [] : [{ kind: 'management', depth: (c.depth ?? 1) - 1 }]),
    children_of_node: state.children ?? [],
    budget_available: nodeBudget?.available,
    budget_rows: state.budgets, node_agents: state.node?.agents,
    execution_effects: Object.values(state.effectDetails ?? {}),
    transactions: { by_status: Object.fromEntries(['ACCEPTED', 'DRAFT', 'READY', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'REJECTED', 'FAILED', 'CANCELLED'].map(status => [status, state.transactions?.filter(tx => tx.status === status).length ?? 0])) },
  };
  return null;
}

/** Select a work item returned by the actor-scoped agenda query. */
function pickAction(request: MockRequestRecord, ctx: MockScenarioContext): Record<string, unknown> | null {
  const contextFacts = request.classified.context;
  if (!contextFacts) return null;
  const actions = recordsOf(contextFacts.work_items)
    .filter(item => item.action && item.action !== 'inbox');
  if (!actions.length) return null;
  const chosen = actions[0] ?? null;
  if (chosen) ctx.lastIssued.set(request.classified.agentId ?? '', signatureOf(chosen));
  return chosen;
}

/** The closest management ancestor a delegated transaction reports to. */
function nearestAncestor(contextFacts: MockWorkContext | null): Record<string, unknown> | null {
  const management = recordsOf(contextFacts?.ancestors).filter(entry => entry.kind === 'management');
  return management.sort((a, b) => Number(b.depth) - Number(a.depth))[0] ?? null;
}

function dispatchParams(request: MockRequestRecord, item: Record<string, unknown>, ctx: MockScenarioContext): Record<string, unknown> {
  const detail = asRecord(request.classified.context?.transaction) ?? {};
  const tx = asRecord(detail.transaction) ?? {};
  const requirements = asRecord(detail.requirements) ?? {};
  if (tx.current_plan_ref) return { transaction_id: item.transaction_id };
  const criteria = listOf(requirements.acceptance_criteria);
  const objective = textOf(requirements.objective) ?? textOf(item.objective) ?? request.classified.objective ?? '';
  const expectedOutput = textOf(requirements.expected_output) || 'the result requested by this task';
  const management = ctx.caseId === 'recursion' && objective.includes('deep/') && (request.classified.depth ?? 0) < 3;
  return {
    transaction_id: item.transaction_id,
    expected_transaction_revision: tx.revision ?? item.revision,
    plan: {
      understanding: `Deliver ${objective}. The formal output is ${expectedOutput}.`,
      execution: management ? 'management' : 'worker',
      rationale: management ? 'This explicitly delegated domain needs its own planning and coordination.' : 'One execution unit covers this objective; its result will be checked by the coordinating agent.',
      assignment: `${objective}\nDeliver ${expectedOutput}, with execution evidence and any limitations. Preserve all formal constraints.`,
      ...(management ? { integration: 'Receive the accepted delegated result, check inherited requirements and record parent validation.' } : {}),
      criterion_responsibilities: criteria.map((_criterion, index) => ({
        criterion: { transaction_id: 'self', criterion_index: index },
        evidence_provider: management ? 'orchestrator' : 'worker', validated_by: 'orchestrator', applies_to: ['worker', 'orchestrator'],
      })),
    },
  };
}

/** The fixture's arithmetic check and evidence inspection actually run here. */
function validationParams(request: MockRequestRecord, item: Record<string, unknown>): Record<string, unknown> {
  const detail = asRecord(request.classified.context?.transaction) ?? {};
  const tx = asRecord(detail.transaction) ?? {};
  const requirements = asRecord(detail.requirements) ?? {};
  const plan = asRecord(detail.plan) ?? {};
  const planRef = asRecord(plan.ref) ?? asRecord(tx.current_plan_ref) ?? {};
  const record = asRecord(detail.result) ?? {};
  const result = asRecord(record.result) ?? {};
  const values = Array.isArray(result.values) ? result.values.map(Number) : sumValues(requirements.objective) ?? [];
  const actual = values.reduce((sum, value) => sum + value, 0);
  const hasSum = typeof result.sum === 'number';
  const passed = result.completed !== false && result.status !== 'blocked' && (!hasSum || (values.length > 0 && actual === result.sum));
  const observation = hasSum ? `Adding the submitted operands ${values.join(' + ')} gives ${actual}; the submitted sum is ${result.sum}.`
    : `Inspected this publication and its execution evidence: ${JSON.stringify(result)}.`;
  const checks = listOf(requirements.acceptance_criteria).map((criterion, index) => ({
    criterion_ref: { transaction_id: item.transaction_id, prepared_revision: planRef.prepared_revision, criterion_index: index },
    criterion,
    method: hasSum ? 'Recompute addition from the submitted operands and inspect the bound execution records.' : 'Compare the published deliverable and its bound execution records against the formal criterion.',
    observation, passed,
    evidence: JSON.stringify({ result_ref: record.ref, producer_agent_id: record.producer_agent_id, turn_seq: record.turn_seq, execution: detail.evidence }),
    evidence_refs: [{ kind: 'result', ref: record.ref ?? tx.current_result_ref }],
  }));
  return { transaction_id: item.transaction_id, expected_transaction_revision: tx.revision ?? item.revision, accepted: passed, checks };
}

function auditEvidence(request: MockRequestRecord, item: Record<string, unknown>, kind: 'plan' | 'validation', approved: boolean): Record<string, unknown> {
  const detail = asRecord(request.classified.context?.transaction) ?? {};
  const record = asRecord(detail[kind]) ?? {};
  const ref = item[`${kind}_ref`] ?? record.ref;
  const rules = kind === 'plan' ? ['goal_coverage', 'responsibility', 'dependencies', 'handoff', 'acceptance_arrangement']
    : ['standard_coverage', 'checks_performed', 'evidence_applicability', 'conclusion_support', 'authority'];
  return { checks: rules.map((rule, index) => ({ rule,
    method: kind === 'plan' ? 'Compare the manager plan, responsibility map and handoff to the immutable task requirements.'
      : 'Inspect the coordinating agent checks, recorded observations and publication references against the formal requirements.',
    observation: JSON.stringify({ rule, requirements: detail.requirements, record }),
    passed: approved || index !== 0,
    evidence_refs: [{ kind, ref }],
  })) };
}

function enrichMockReply(request: MockRequestRecord, reply: MockScenarioReply | null): MockScenarioReply | null {
  if (!reply?.toolCalls) return reply;
  return { ...reply, toolCalls: reply.toolCalls.map(spec => {
    let args: Record<string, unknown> | null = null;
    try { args = asRecord(JSON.parse(String(spec.arguments))); } catch { return spec; }
    if (!args) return spec;
    const params = asRecord(args.params);
    if (!params) return spec;
    const action = textOf(args.action);
    const item = recordsOf(request.classified.context?.work_items).find(entry => entry.transaction_id === params.transaction_id) ?? {};
    if (spec.name === 'flow_audit' && (action === 'inspect_plan' || action === 'inspect_validation')) {
      const supplied = asRecord(params.evidence) ?? {};
      if (!Array.isArray(supplied.checks)) params.evidence = { ...supplied,
        ...auditEvidence(request, item, action === 'inspect_plan' ? 'plan' : 'validation', params.decision === 'approve') };
      if (!params.audit_id && item.audit_id) params.audit_id = item.audit_id;
    }
    if (spec.name === 'flow_transaction' && ['adjust_transaction', 'set_dependency'].includes(action ?? '') && params.expected_transaction_revision === undefined) {
      const tx = asRecord(asRecord(request.classified.context?.transaction)?.transaction);
      if (tx && tx.id === params.transaction_id) params.expected_transaction_revision = tx.revision;
    }
    return { ...spec, arguments: JSON.stringify({ ...args, params }) };
  }) };
}

/** Choose an execution design and validate the queried formal work. */
function orchestratorReply(request: MockRequestRecord, ctx: MockScenarioContext): MockScenarioReply {
  const item = pickAction(request, ctx);
  if (!item) return say(`No pending action for node ${request.classified.nodeId}. ${STATUS_LINE}`);
  const hook = ctx.hooks.orchestrator;
  if (hook) {
    const custom = hook(request, item, ctx);
    if (custom) return custom;
  }
  // A tool continuation carries the original role prompt. After its action,
  // yield so the scheduler can supply current state on the next turn.

  switch (textOf(item.action)) {
    case 'prepare-plan':
    case 'dispatch':
    case 'replan-or-redispatch':
      // The specific agenda reference owns its own execution decision.
      return call('flow_transaction', {
        action: 'dispatch',
        params: dispatchParams(request, item, ctx),
      });
    case 'revise-plan':
    case 'correct-result':
      return call('flow_transaction', {
        action: 'adjust_transaction',
        params: { expected_transaction_revision: asRecord(asRecord(request.classified.context?.transaction)?.transaction)?.revision ?? item.revision, ...(ctx.revisionFor(item) ?? { transaction_id: item.transaction_id, priority: 0 }) },
      });
    case 'validate':
      return call('flow_transaction', {
        action: 'validate',
        params: validationParams(request, item),
      });
    case 'aggregate':
      return call('flow_transaction', { action: 'aggregate', params: { transaction_id: item.transaction_id } });
    case 'escalate-or-unblock':
      return call('flow_transaction', {
        action: 'escalate', params: { node_id: request.classified.nodeId, reason: `transaction ${item.transaction_id} is blocked` },
      });
    case 'finish_cluster':
      return call('flow_transaction', { action: 'finish_cluster', params: {} });
    case 'report-to-parent': {
      const parent = nearestAncestor(request.classified.context);
      if (!parent) return say(`Delegated transaction ${item.transaction_id} is ${item.status}. ${STATUS_LINE}`);
      return call('flow_communicate', {
        action: 'send',
        params: { node: parent.id, content: `transaction ${item.transaction_id} is ${item.status}` },
      });
    }
    case 'decompose':
      return call('flow_transaction', {
        action: 'decompose',
        params: ctx.decomposeFor(request, item) ?? null,
      });
    default:
      return say(`Unhandled pending action ${item.action} on node ${request.classified.nodeId}. ${STATUS_LINE}`);
  }
}

/** Allocator policy: identity, topology and funding, again from the contextFacts. */
function allocatorReply(request: MockRequestRecord, ctx: MockScenarioContext): MockScenarioReply {
  // The answer to a ledger read that this turn opened: the turn may have no
  // pending action of its own, and the rebalance is the action it exists for.
  const rebalanceReply = (): MockScenarioReply | null => {
    if (request.classified.lastToolName !== 'flow_query' || request.classified.lastToolArguments?.what !== 'budgets'
      || !ctx.rebalanced.get(request.classified.nodeId ?? '')) return null;
    const rows = budgetRows(request.classified.lastToolResult);
    const richest = rows
      .filter(row => row.scope_kind === 'agent' && row.scope_id !== request.classified.agentId)
      .sort((a, b) => b.available.tool_calls - a.available.tool_calls)[0] ?? null;
    if (!richest || richest.available.tool_calls <= 0) return null;
    const allocations = recordsOf(request.classified.context?.work_items).filter(item => item.action === 'allocate_agent');
    const frontier = Number(allocations[0]?.unallocated_total ?? allocations.length);
    if (frontier <= 0) return null;
    return call('flow_allocation', {
      action: 'rebalance_budget',
      params: {
        from: { kind: 'agent', id: richest.scope_id },
        to: { kind: 'node', id: request.classified.nodeId },
        amounts: {
          // One Worker grant per remaining transaction is the need; taking at
          // most half of the source leaves the spending role with a working
          // allowance of its own. Draining it whole moved the starvation.
          tool_calls: Math.min(32 * frontier, Math.max(32, Math.floor(richest.available.tool_calls / 2))),
        },
      },
    });
  };
  const item = pickAction(request, ctx);
  if (!item) return rebalanceReply() ?? say(`No pending allocation action for node ${request.classified.nodeId}. ${STATUS_LINE}`);
  // A case's own script runs first: the recursion fixture's delegated chain is
  // its allocator's first duty, and a capacity top-up must not displace it.
  const hook = ctx.hooks.allocator;
  if (hook) {
    const custom = hook(request, item, ctx);
    if (custom) return custom;
  }
  const rebalance = rebalanceReply();
  if (rebalance) return rebalance;

  const contextFacts: MockWorkContext = request.classified.context ?? {};
  if (ctx.caseId === 'scale') {
    const rows = recordsOf(contextFacts.budget_rows);
    const roles = recordsOf(asRecord(contextFacts.node_agents)?.items).filter(row => row.role !== 'worker');
    const source = rows.find(row => row.scope_kind === 'node' && row.scope_id === request.classified.nodeId);
    const needy = rows.find(row => row.scope_kind === 'agent' && roles.some(role => role.id === row.scope_id)
      && Number(asRecord(row.available)?.tool_calls ?? Infinity) < 64);
    if (source && needy && Number(asRecord(source.available)?.tool_calls ?? 0) >= 128) return call('flow_allocation', { action: 'rebalance_budget',
      params: { from: { kind: 'node', id: source.scope_id }, to: { kind: 'agent', id: needy.scope_id }, amounts: { tool_calls: 128 } } });
  }

  const actions = recordsOf(contextFacts.work_items);
  const nodeToolCalls = Number(asRecord(contextFacts.budget_available)?.tool_calls ?? Number.POSITIVE_INFINITY);
  const frontier = listOf(item.transactions).length;
  const isRoot = recordsOf(contextFacts.ancestors).length === 0;
  const topUps = ctx.rebalanced.get(request.classified.nodeId ?? '') ?? 0;

  // A node can only host as many Workers as it has free child slots. Allocating
  // the whole ready frontier at once therefore fails partway with
  // `reached max_children` and leaves the rest of the tier unable to start; the
  // ladder has to go in waves, releasing each wave's finished Workers so their
  // slots — and their nodes — are reused.
  const children = recordsOf(contextFacts.children_of_node);
  const liveChildren = children.filter(child => child.status !== 'RELEASED');
  const childLimit = Number(asRecord(contextFacts.node)?.max_children ?? children.length) || children.length;
  const freeSlots = Math.max(0, childLimit - liveChildren.length);

  const owed = Number(actions.find(entry => entry.action === 'allocate_agent')?.unallocated_total ?? frontier);
  const perWorkerTools = 32;
  const affordable = Number.isFinite(nodeToolCalls) ? Math.floor(nodeToolCalls / perWorkerTools) : Infinity;
  const needsToolCalls = perWorkerTools * Math.min(owed, Math.max(1, freeSlots)) + 32;
  if (isRoot && item.action === 'allocate_agent' && owed >= 8 && topUps < 3 && affordable <= 0 && nodeToolCalls < needsToolCalls) {
    ctx.rebalanced.set(request.classified.nodeId ?? '', topUps + 1);
    return call('flow_query', { what: 'budgets', params: { limit: 50 } });
  }

  const releaseFirst = (): MockScenarioReply => {
    const release = actions.find(entry => entry.action === 'release_agent');
    if (release) {
      return call('flow_allocation', {
        action: 'release_agent',
        params: release.all === true ? { all: true, node_id: release.node_id } : { allocations: release.allocations ?? [] },
      });
    }
    return say(`Node ${request.classified.nodeId} has no free child slot and nothing to release yet. ${STATUS_LINE}`);
  };
  switch (textOf(item.action)) {
    case 'allocate_agent': {
      if (freeSlots === 0) return releaseFirst();
      // A new Worker's grant is drawn from the node. When the node cannot fund
      // even one full grant, the finished Workers' unspent grants are the
      // capacity the next wave needs — releasing them first is what keeps the
      // last Workers of a ladder from being born with a one-call allowance.
      if (nodeToolCalls < 32 && actions.some(entry => entry.action === 'release_agent')) return releaseFirst();
      // The plugin computed *these* transactions as READY and unallocated.
      // A blind node-wide batch can pick rows that already have an allocation,
      // dedupe them and change nothing — a turn that looks like work and is
      // booked as stagnation. The batch is also bounded by what the node can
      // fund for each of them.
      const room = Number.isFinite(affordable) ? Math.max(1, Math.min(freeSlots, affordable)) : freeSlots;
      const batch = (item.transaction_id ? [item.transaction_id] : listOf(item.transactions)).slice(0, room);
      if (!batch.length) return say(`Nothing unallocated on node ${request.classified.nodeId}. ${STATUS_LINE}`);
      return call('flow_allocation', {
        action: 'allocate_agent',
        params: { transactions: batch },
      });
    }
    case 'release_agent':
      // The plugin named these allocations as releasable. `scale_in` re-derives
      // its own candidates and only covers *terminal* transactions, so it can
      // silently release nothing for an outdated allocation — a turn that looks
      // like work and changes nothing.
      return call('flow_allocation', {
        action: 'release_agent',
        params: item.all === true ? { all: true, node_id: item.node_id } : { allocations: item.allocations ?? [] },
      });
    case 'spawn_management_node': {
      const instruction = asRecord(item.instruction) ?? {};
      const transactionId = item.transaction_id ?? asRecord(contextFacts.node)?.delegated_transaction_id ?? null;
      if (!transactionId) return say(`No delegated transaction to delegate from on node ${request.classified.nodeId}. ${STATUS_LINE}`);
      return call('flow_allocation', {
        action: 'spawn_management_node',
        params: {
          transaction_id: transactionId,
          plan_ref: asRecord(asRecord(contextFacts.transaction)?.plan)?.ref,
          node_id: request.classified.nodeId,
          scope: instruction.scope ?? { objective: instruction.objective ?? 'delegated domain' },
          max_children: instruction.max_children ?? 4,
          ...(instruction.spawn_children === undefined ? {} : { spawn_children: instruction.spawn_children }),
          ...(instruction.inputs === undefined ? {} : { inputs: instruction.inputs }),
        },
      });
    }
    case 'rebalance_budget': {
      // The hint names scopes in the shape the *query* returns
      // (`{scope_kind, scope_id}`); `rebalance_budget` resolves `{kind, id}`.
      // Passing one as the other 404s, the command changes nothing, and the
      // hint repeats every tick until the Allocator's turn budget is gone.
      const reference = (value: unknown): { kind?: unknown; id?: unknown } | null => {
        const record = asRecord(value);
        return record ? { kind: record.kind ?? record.scope_kind, id: record.id ?? record.scope_id } : null;
      };
      const starved = listOf(item.starved_agents);
      const from = reference(item.from) ?? reference(listOf(item.from_options)[0]);
      const to = reference(item.to) ?? reference(starved.length ? { kind: 'agent', id: starved[0] } : null);
      if (!from || !to || !from.id || !to.id) {
        return say(`No executable rebalance on node ${request.classified.nodeId}. ${STATUS_LINE}`);
      }
      // The hint for a starved Worker carries the agent but no envelope; the
      // plugin's own Worker grant is the amount that makes it runnable again.
      // Moving an empty amount is a successful command that changes nothing, and
      // the hint then repeats until the Allocator has no turns left.
      const amounts = item.required ?? (starved.length
        ? { tool_calls: 32 }
        : {});
      return call('flow_allocation', {
        action: 'rebalance_budget',
        params: { to, from, amounts },
      });
    }
    default:
      return say(`Unhandled allocation action ${item.action} on node ${request.classified.nodeId}. ${STATUS_LINE}`);
  }
}

/** Auditor policy: the independent gate, approving only what it was shown. */
function auditorReply(request: MockRequestRecord, ctx: MockScenarioContext): MockScenarioReply {
  const item = pickAction(request, ctx);
  if (!item) return say(`No pending audit action for node ${request.classified.nodeId}. ${STATUS_LINE}`);
  const hook = ctx.hooks.auditor;
  if (hook) {
    const custom = hook(request, item, ctx);
    if (custom) return custom;
  }

  switch (textOf(item.action)) {
    case 'inspect_plan':
      return call('flow_audit', {
        action: 'inspect_plan',
        // The reference the item was offered with, not the transaction's
        // current revision: by the time the verdict is sent the plan may have
        // been revised, and a `target_revision`-less call resolves to whatever
        // audit now sits at the newest revision — a lookup that either misses
        // ("no plan audit ... at revision N") or judges a plan that was never
        // offered for this decision.
        params: {
          transaction_id: item.transaction_id,
          ...(item.audit_id ? { audit_id: item.audit_id } : {}),
          ...(item.target_revision === undefined ? {} : { target_revision: item.target_revision }),
          decision: 'approve',
          notes: 'the plan states a checkable objective',
          evidence: auditEvidence(request, item, 'plan', true),
        },
      });
    case 'inspect_validation':
      return call('flow_audit', {
        action: 'inspect_validation',
        params: {
          transaction_id: item.transaction_id,
          ...(item.audit_id ? { audit_id: item.audit_id } : {}),
          ...(item.target_revision === undefined ? {} : { target_revision: item.target_revision }),
          decision: ctx.validationDecision(request, item),
          notes: 'decision recorded against the exact result revision',
          evidence: auditEvidence(request, item, 'validation', ctx.validationDecision(request, item) === 'approve'),
        },
      });
    case 'request_correction':
      return call('flow_audit', {
        action: 'request_correction',
        params: {
          transaction_id: item.transaction_id,
          required_change: ctx.correctionFor(item) ?? item.required_change ?? 'satisfy the recorded acceptance criteria',
          evidence: { observed: item.reason ?? 'the Worker reported an incomplete result' },
        },
      });
    case 'request_replan':
      return call('flow_audit', {
        action: 'request_replan',
        params: {
          transaction_id: item.transaction_id,
          required_change: ctx.correctionFor(item) ?? item.required_change ?? 'replace the plan with one that can satisfy the criteria',
          evidence: { observed: item.reason ?? 'the plan cannot produce the recorded evidence' },
        },
      });
    case 'request_revalidation':
      return call('flow_audit', {
        action: 'request_revalidation',
        params: {
          transaction_id: item.transaction_id,
          ...(item.target_revision === undefined ? {} : { target_revision: item.target_revision }),
          required_change: ctx.correctionFor(item) ?? item.required_change ?? 're-validate the result at the recorded revision',
          evidence: { observed: item.reason ?? 'the recorded validation is not backed by the evidence' },
        },
      });
    case 'notify':
      return call('flow_audit', {
        action: 'notify',
        params: {
          node_id: item.node_id ?? request.classified.nodeId,
          ...(item.transaction_id ? { transaction_id: item.transaction_id } : {}),
          observation: item.observation ?? item.note ?? 'noted from the recorded evidence',
        },
      });
    case 'recommend':
      return call('flow_audit', {
        action: 'recommend',
        params: {
          transaction_id: item.transaction_id,
          recommendation: item.recommendation ?? item.note ?? 'adjust the plan before the next dispatch',
        },
      });
    case 'escalate':
      return call('flow_audit', {
        action: 'escalate',
        params: {
          node_id: item.node_id ?? request.classified.nodeId,
          reason: item.reason ?? 'the issue could not be resolved inside this domain',
        },
      });
    case 'review_issue':
      // The plugin offers a verdict on an open issue with a hint about which
      // one the state supports. An issue nothing has changed for is left for the
      // Orchestrator; one with a later correction is verified on its evidence.
      if (!item.changed_since_issue) {
        return say(`Issue ${item.issue_id} has no durable correction yet; leaving it to the Orchestrator. ${STATUS_LINE}`);
      }
      return call('flow_audit', {
        action: 'verify_correction',
        params: {
          issue_id: item.issue_id,
          decision: 'verified',
          evidence: { checked: item.required_change ?? 'the recorded criterion' },
        },
      });
    case 'verify_correction':
      return call('flow_audit', {
        action: 'verify_correction',
        params: { issue_id: item.issue_id, decision: 'verified', evidence: 'the later revision satisfies the recorded criterion' },
      });
    case 'evaluate_health': {
      const metrics = listOf(item.dimensions);
      return call('flow_audit', {
        action: 'evaluate_health',
        params: {
          evaluation_window: 'subtree-close',
          dimensions: Object.fromEntries(metrics.map(name => [String(name), 0.9])),
        },
      });
    }
    default:
      return say(`Unhandled audit action ${item.action} on node ${request.classified.nodeId}. ${STATUS_LINE}`);
  }
}

/**
 * The numbers a task's own objective asks `flow_sum` to add. Every bracketed
 * list in the text is collected, so a task that asks for `[10]` and `[50]` in
 * one sentence is answered with both.
 */
export function sumValues(text: unknown): number[] | null {
  const source = String(text ?? '');
  const groups = [...source.matchAll(/\[([^\]]*)\]/gu)]
    .map(match => (match[1] ?? '').split(',').map(value => Number(value.trim())))
    .filter(values => values.length && values.every(Number.isFinite));
  if (!groups.length) return null;
  return groups.flat();
}

/** The number a real `flow_sum` tool result carried, or null. */
export function sumFromToolResult(text: unknown): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(String(text ?? '').trim());
  return match ? Number(match[1] ?? '') : null;
}

/** Default Worker policy: call the real tool, then submit what it returned. */
function workerReply(request: MockRequestRecord, ctx: MockScenarioContext): MockScenarioReply {
  const hook = ctx.hooks.worker;
  if (hook) {
    const custom = hook(request, ctx);
    if (custom) return custom;
  }
  const classified = request.classified;
  if (classified.last_message_role === 'tool' && classified.lastToolName === WORKER_TOOL_NAME) return say(STATUS_LINE);
  // Only a task that asks for `flow_sum` is answered with it: a bracketed list
  // in some other objective is not a request to add.
  const wantsSum = /\bflow_sum\b/u.test(`${classified.objective ?? ''} ${classified.userText ?? ''}`);
  const values = wantsSum ? sumValues(classified.objective ?? classified.userText) : null;
  if (values && request.classified.lastToolName !== 'flow_sum') {
    return call('flow_sum', { values });
  }
  if (request.classified.lastToolName === 'flow_sum') {
    const total = sumFromToolResult(request.classified.lastToolResult);
    if (total === null) throw new Error(`flow_sum returned ${JSON.stringify(classified.lastToolResult)} for ${classified.transactionId}`);
    return call(WORKER_TOOL_NAME, {
      action: 'submit_result',
      params: {
        transaction_id: classified.transactionId,
        result: { sum: total, values, tool: 'flow_sum' },
        notes: `computed ${total} with the flow_sum tool`,
      },
    });
  }
  return say(`No tool call was possible for transaction ${classified.transactionId}. ${STATUS_LINE}`);
}

/** One part of a case's own script. */
export interface MockScenarioHooks {
  observe?: (request: MockRequestRecord) => void;
  orchestrator?: (request: MockRequestRecord, item: Record<string, unknown>, ctx: MockScenarioContext) => MockScenarioReply | null;
  allocator?: (request: MockRequestRecord, item: Record<string, unknown>, ctx: MockScenarioContext) => MockScenarioReply | null;
  auditor?: (request: MockRequestRecord, item: Record<string, unknown>, ctx: MockScenarioContext) => MockScenarioReply | null;
  worker?: (request: MockRequestRecord, ctx: MockScenarioContext) => MockScenarioReply | null;
  revision?: (item: Record<string, unknown>) => Record<string, unknown> | null;
  decompose?: (request: MockRequestRecord, item: Record<string, unknown>) => Record<string, unknown> | null;
  correction?: (item: Record<string, unknown>) => string | null;
  validationDecision?: (request: MockRequestRecord, item: Record<string, unknown>) => string;
  reportEvidence?: () => unknown;
}

/** The run-wide fixtures one case's hook factory may read. */
export interface MockCaseContext {
  fixtureIds?: Record<string, string>;
  workspace?: string | null;
  layout?: unknown;
  runId?: string | null;
  limits?: Record<string, unknown> | null;
}

/** The fixture state one scenario tracks while it answers. */
export interface MockScenarioSeen {
  compaction: number;
  role: Record<string, number>;
  worker: Record<string, number>;
  query_missing: number;
}

/** Everything the shared policy functions may consult. */
export interface MockScenarioContext {
  caseId: string;
  layout: unknown;
  workspace: string | null;
  limits: Record<string, unknown> | null;
  hooks: MockScenarioHooks;
  lastIssued: Map<string, string>;
  rebalanced: Map<string, number>;
  revisionFor(item: Record<string, unknown>): Record<string, unknown> | null;
  decomposeFor(request: MockRequestRecord, item: Record<string, unknown>): Record<string, unknown> | null;
  correctionFor(item: Record<string, unknown>): string | null;
  validationDecision(request: MockRequestRecord, item: Record<string, unknown>): string;
  seen: MockScenarioSeen;
  problems: string[];
}

/**
 * Case-specific behaviour. Everything not named here falls back to the
 * plugin-driven default policy, so a case only has to describe what makes it
 * different.
 */
const CASE_HOOKS: Record<string, (context: MockCaseContext) => MockScenarioHooks> = {
  context: () => {
    const reads = new Map<string, number>();
    return { worker(request) {
      const transaction = request.classified.transactionId ?? request.classified.agentId ?? '';
      const count = reads.get(transaction) ?? 0;
      if (count >= 4) return null;
      reads.set(transaction, count + 1);
      // Real read results create the long native history. The controlled
      // provider's usage anchors the host meter; its default policy decides
      // whether and where to compact, without Flow thresholds or overrides.
      return call('read', { file_path: 'pressure.txt' }, {
        usage: { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 },
      });
    } };
  },
  /**
   * Observation acceptance needs a stable live team while the browser reads it.
   * Hold final closeout until the checker finishes; only test IPC performs cleanup.
   * This is a slow model with an open SSE stream.
   */
  panel: () => {
    const questioned=new Set<string>();
    const stoppedForQuestion=new Set<string>();
    return {orchestrator:(request,item)=>{
      const id=request.classified.agentId??'';
      if(`${request.classified.objective ?? ''} ${request.classified.userText}`.includes('UX native')&&!questioned.has(id)) {
        questioned.add(id);return call('flow_transaction',{action:'request_user',params:{question:'请确认使用当前工作区'}});
      }
      if(request.classified.lastToolResult?.includes('waiting_user')&&!stoppedForQuestion.has(id)){stoppedForQuestion.add(id);return say('等待主会话答复');}
      return item.action==='finish_cluster'?{...call('flow_transaction',{action:'finish_cluster',params:{}}),hold:'panel-hold'}:null;
    }};
  },
  recursion: context => recursionHooks(context),
  recovery: context => recoveryHooks(context),
  scale: context => scaleHooks(context),
  browser: () => browserHooks(),
};

/** One result the fixture's Workers really submitted for a transaction. */
interface SubmissionEntry {
  at: number;
  completed: boolean;
  granted: string | null;
  wrote: boolean;
}

/** One entry of the recursion fixture's audit trail over an issue. */
interface VerificationLogEntry {
  at: number;
  transaction_id: string | null;
  openIssue: string | null;
  answered: boolean;
  already_sent: boolean;
}

/**
 * The recursion case: an asymmetric tree, one injected write-scope fault, and a
 * real correction round.
 *
 * Every step is keyed by the identity the plugin itself reports — the node's
 * contextFacts, the transaction objective in the Worker prompt, the allocation's
 * granted paths — never by arrival order. The fixture ids come from the runner's
 * own namespace map, so the script names the same transactions the case does.
 */
function recursionHooks(context: MockCaseContext): MockScenarioHooks {
  const fixtureIds = context.fixtureIds ?? {};
  const workspace = context.workspace ?? '';
  const deepTx = fixtureIds['rec-deep'] ?? 'rec-deep';
  const flatTx = fixtureIds['rec-flat'] ?? 'rec-flat';
  const verifyTx = fixtureIds['rec-verify'] ?? 'rec-verify';
  const state = {
    dependencySet: false,
    needsRevision: null as string | null,
    // Per transaction: every result the fixture's Workers actually submitted,
    // in order, with what they reported. Auditor verdicts are bound to this.
    submissions: new Map<unknown, SubmissionEntry[]>(),
    // Per transaction: how many submissions existed when its issue was raised. A
    // correction is verified only against work that came after.
    raisedFor: new Map<unknown, number>(),
    // Each successful correction retains its own evidence window until the
    // corresponding explicit verification succeeds.
    issuesByTx: new Map<unknown, Map<string, number>>(),
    correctionAttempts: new Map<string, { action: string; transaction: string; key: string; after: number }>(),
    confirmedCorrections: new Set<string>(),
    verificationAttempts: new Map<string, string>(),
    verifiedIssues: new Set<string>(),
    complianceIssues: new Set<string>(),
    faultyValidations: new Set<string>(),

    // Why each open issue was or was not verified, in order: the decision this
    // fixture makes must be visible in the report, not inferred from a missing
    // receipt afterwards.
    verificationLog: [] as VerificationLogEntry[],
  };
  const recordSubmission = (txId: string | null, entry: SubmissionEntry): void => {
    const list = state.submissions.get(txId) ?? [];
    list.push(entry);
    state.submissions.set(txId, list);
  };
  const target = join(workspace, 'deep/nested/result.txt');
  const refused = (text: unknown): boolean => /outside|refus|denied|not allowed|is not permitted|cannot write|scope/i.test(String(text ?? ''));
  const observeAudit = (request: MockRequestRecord): void => {
    if (request.classified.lastToolName !== 'flow_audit') return;
    let answer: Record<string, unknown> | null = null;
    try { answer = asRecord(JSON.parse(request.classified.lastToolResult ?? 'null')); } catch { return; }
    if (answer?.ok !== true) return;
    const result = asRecord(answer.result);
    const issueId = textOf(result?.issue_id);
    const agentId = request.classified.agentId ?? '';
    const attempt = state.correctionAttempts.get(agentId);
    if (attempt && answer.action === attempt.action && result?.transaction_id === attempt.transaction && issueId) {
      const issues = state.issuesByTx.get(attempt.transaction) ?? new Map<string, number>();
      if (!issues.has(issueId)) issues.set(issueId, attempt.after);
      state.issuesByTx.set(attempt.transaction, issues);
      state.confirmedCorrections.add(attempt.key);
      if (answer.action === 'inspect_validation') state.complianceIssues.add(issueId);
    }
    if (answer.action === 'verify_correction' && issueId && result?.status === 'CORRECTED' && state.verificationAttempts.get(agentId) === issueId) state.verifiedIssues.add(issueId);
  };


  return {
    observe: observeAudit,
    /** Record the objective of every transaction the role is about to dispatch. */
    orchestrator(request, item) {
      const c = request.classified;
      const contextFacts = c.context ?? {};
      const isRoot = recordsOf(contextFacts.ancestors).length === 0;
      // The verifier must count a fixed corpus: make its dependency explicit
      // before any dispatch, instead of relying on the order workers happen to
      // finish in.
      if (isRoot && !state.dependencySet) {
        const tx = asRecord(asRecord(c.context?.transaction)?.transaction);
        if (tx?.id !== verifyTx) return call('flow_query', { what: 'transaction', params: { id: verifyTx, fields: ['requirements'] } });
        state.dependencySet = true;
        return call('flow_transaction', {
          action: 'set_dependency',
          params: { transaction_id: verifyTx, expected_transaction_revision: tx?.revision, depends_on: [deepTx, flatTx] },
        });
      }
      const detail = asRecord(c.context?.transaction) ?? {};
      const publication = asRecord(detail.result) ?? {};
      const value = asRecord(publication.result) ?? {};
      if (item.action === 'validate' && item.transaction_id === state.needsRevision) {
        const txId = String(item.transaction_id);
        if (!state.faultyValidations.has(txId)) {
          state.faultyValidations.add(txId);
          // A declared fixture fault: the manager observed a blocked publication
          // yet proposes acceptance. The independent audit must refuse this conclusion.
          const params = validationParams(request, item);
          return call('flow_transaction', { action: 'validate', params: { ...params, accepted: true,
            checks: recordsOf(params.checks).map(check => ({ ...check, passed: true })) } });
        }
        if ((state.issuesByTx.get(txId)?.size ?? 0) > 0) return call('flow_transaction', { action: 'adjust_transaction',
          params: { transaction_id: txId, expected_transaction_revision: asRecord(detail.transaction)?.revision, inputs: { write_scope: ['deep/'] } } });
      }
      if (item.action === 'validate' && value.completed === true && typeof value.file === 'string') {
        const receipts = recordsOf(c.context?.execution_effects).map((receipt): Record<string, unknown> & { args: Record<string, unknown> | null; body: Record<string, unknown> | null } => {
          let args = asRecord(receipt.args); let body = asRecord(receipt.body);
          try { if (!args && typeof receipt.args === 'string') args = asRecord(JSON.parse(receipt.args)); } catch { /* Invalid records do not prove work. */ }
          try { if (!body && typeof receipt.body === 'string') body = asRecord(JSON.parse(receipt.body)); } catch { /* Invalid records do not prove work. */ }
          return { ...receipt, args, body };
        });
        const write = receipts.find(receipt => receipt.tool === 'write' && receipt.status === 'SETTLED' && receipt.body?.isError === false
          && String(receipt.args?.file_path ?? '').endsWith(String(value.file)));
        const params = validationParams(request, item);
        return call('flow_transaction', { action: 'validate', params: { ...params, accepted: Boolean(write),
          checks: recordsOf(params.checks).map(check => ({ ...check, passed: Boolean(write),
            method: 'Inspect the persisted successful write receipt, exact file path and bytes for this publication and execution.',
            observation: JSON.stringify(write ?? { limitation: 'No successful matching write receipt was found' }),
            evidence: JSON.stringify({ publication: publication.ref, receipt: write }),
            evidence_refs: [...listOf(check.evidence_refs), ...(write ? [{ kind: 'effect', call_id: write.call_id }] : [])] })) } });
      }
      if (state.needsRevision && item.action === 'correct-result' && item.transaction_id === state.needsRevision) {
        // The deepest branch was granted `deep/staging` for a deliverable at
        // `deep/nested`; the correction is to give it the scope the work needs.
        return call('flow_transaction', {
          action: 'adjust_transaction',
          params: { transaction_id: item.transaction_id, expected_transaction_revision: asRecord(asRecord(c.context?.transaction)?.transaction)?.revision, inputs: { write_scope: ['deep/'] } },
        });
      }
      return null;
    },
    allocator(request, _item) {
      const c = request.classified;
      const contextFacts = c.context ?? {};
      const pending = recordsOf(contextFacts.work_items).filter(entry => entry.action === 'spawn_management_node');
      if (!pending.length) return null;
      const instruction = asRecord(pending[0]?.instruction) ?? {};
      // The delegation has to happen before the allocator hands the same
      // transaction to a Worker: a delegated parent waits for its children, and
      // a Worker allocated first would take the branch the fixture delegates.
      const isRoot = recordsOf(contextFacts.ancestors).length === 0;
      const transactionId = _item.transaction_id ?? (isRoot ? deepTx : asRecord(contextFacts.node)?.delegated_transaction_id);
      if (!transactionId) return null;
      return call('flow_allocation', {
        action: 'spawn_management_node',
        params: {
          transaction_id: transactionId,
          plan_ref: asRecord(asRecord(contextFacts.transaction)?.plan)?.ref,
          node_id: c.nodeId,
          scope: { objective: instruction.objective ?? 'delegated deep branch' },
          max_children: instruction.max_children ?? 4,
          ...(instruction.spawn_children === undefined ? {} : { spawn_children: instruction.spawn_children }),
        },
      });
    },
    worker(request) {
      const c = request.classified;
      const objective = c.objective ?? '';
      const scopeLine = listOf(asRecord(c.context?.allocation)?.write_scope).map(String).join(', ');
      const scopeEntries = scopeLine.split(',').map(entry => entry.trim()).filter(Boolean);
      const lastTool = c.lastToolName;
      const lastResult = c.lastToolResult ?? '';

      if (objective.includes('deep/nested/result.txt')) {
        if (lastTool === 'write') {
          const writeOk = !refused(lastResult) && existsSync(target);
          // The submission is what the Auditor judges, so it is recorded as the
          // fixture's own evidence — including whether the result is complete.
          const entry: SubmissionEntry = {
            at: (state.submissions.get(c.transactionId) ?? []).length + 1,
            completed: writeOk,
            granted: scopeLine || null,
            wrote: writeOk,
          };
          recordSubmission(c.transactionId, entry);
          if (!writeOk) {
            // The real refusal happened: no file was written. Report the
            // limitation as the durable failure the Auditor must judge, and keep
            // this transaction as the one that owes a correction.
            state.needsRevision = c.transactionId;
            return call(WORKER_TOOL_NAME, {
              action: 'submit_result',
              params: {
                transaction_id: c.transactionId,
                result: {
                  completed: false,
                  status: 'blocked',
                  reason: `the write to ${target} was refused: the granted paths are ${scopeLine || 'none'}`,
                  granted: scopeEntries,
                },
                notes: 'the granted write scope does not cover the deliverable; nothing was written',
              },
            });
          }
          // The deliverable exists and this Worker wrote it: the transaction no
          // longer owes a correction.
          state.needsRevision = null;
          return call(WORKER_TOOL_NAME, {
            action: 'submit_result',
            params: {
              transaction_id: c.transactionId,
              result: { completed: true, file: 'deep/nested/result.txt', line: '3', evidence: 'settled write of the single depth line' },
              notes: 'wrote the depth line after the allocation was corrected',
            },
          });
        }
        return call('write', { file_path: target, content: '3\n' });
      }

      if (objective.includes('flat/result.txt')) {
        const flatTarget = join(workspace, 'flat/result.txt');
        if (lastTool === 'write') {
          return call(WORKER_TOOL_NAME, {
            action: 'submit_result',
            params: {
              transaction_id: c.transactionId,
              result: { completed: true, file: 'flat/result.txt', content: 'flat-ok' },
              notes: 'wrote flat/result.txt',
            },
          });
        }
        return call('write', { file_path: flatTarget, content: 'flat-ok\n' });
      }

      if (objective.includes('verify/result.txt')) {
        const verifyTarget = join(workspace, 'verify/result.txt');
        if (lastTool === 'glob') {
          // The count comes from the paths the read tool really listed, never
          // from a number the fixture decided in advance. Distinct paths, not
          // lines: the tool answers with a JSON list, which is one line.
          const found = new Set(String(lastResult).match(/[\w./-]*result\.txt/g) ?? []).size;
          return call('write', { file_path: verifyTarget, content: `verifier-ran ${found}\n` });
        }
        if (lastTool === 'write') {
          return call(WORKER_TOOL_NAME, {
            action: 'submit_result',
            params: {
              transaction_id: c.transactionId,
              result: { completed: true, file: 'verify/result.txt', globbed: 'result.txt' },
              notes: 'counted the result.txt files the read tool listed',
            },
          });
        }
        return call('glob', { pattern: '**/result.txt' });
      }
      return null;
    },
    revision: item => (state.needsRevision && item.transaction_id === state.needsRevision
      ? { transaction_id: item.transaction_id, inputs: { write_scope: ['deep/'] } }
      : null),
    auditor(request, item) {
      // Every decision here is bound to evidence the fixture itself observed:
      // a Worker that submitted a result it marked incomplete, and a *later*
      // submission for the same transaction. Neither objective text nor a plan
      // edit proves that corrective work completed.
      const txKey = item.transaction_id;
      const submissions = state.submissions.get(txKey) ?? [];
      // A `flow_query what:"transaction"` answer, when this step just made one:
      // the plugin's own published view of the transaction a verdict is about.
      const queriedTransaction = (() => {
        if (request.classified.lastToolName !== 'flow_query') return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(request.classified.lastToolResult ?? ''));
        } catch {
          return null;
        }
        return asRecord(asRecord(parsed)?.transaction);
      })();
      const auditAnswer = (() => {
        if (request.classified.lastToolName !== 'flow_audit') return null;
        try {
          const parsed: unknown = JSON.parse(String(request.classified.lastToolResult ?? ''));
          return asRecord(parsed);
        } catch {
          return null;
        }
      })();
      const agentId = request.classified.agentId ?? '';
      const result = asRecord(auditAnswer?.result);
      const issueId = textOf(result?.issue_id);
      const attempt = state.correctionAttempts.get(agentId);
      if (auditAnswer?.ok === true && attempt && auditAnswer.action === attempt.action
        && result?.transaction_id === attempt.transaction && issueId) {
        const issues = state.issuesByTx.get(attempt.transaction) ?? new Map<string, number>();
        if (!issues.has(issueId)) issues.set(issueId, attempt.after);
        state.issuesByTx.set(attempt.transaction, issues);
        state.confirmedCorrections.add(attempt.key);
      }
      if (auditAnswer?.ok === true && auditAnswer.action === 'verify_correction'
        && issueId && result?.status === 'CORRECTED' && state.verificationAttempts.get(agentId) === issueId) {
        state.verifiedIssues.add(issueId);
      }
      const correctionKey = JSON.stringify([txKey, item.action, item.refusal_seqs ?? item.refusal_seq,
        item.audit_id, item.target_revision, item.reason, item.required_change]);
      const beginCorrection = (): boolean => {
        if (state.confirmedCorrections.has(correctionKey)) return false;
        state.correctionAttempts.set(agentId, {
          action: String(item.action), transaction: String(txKey), key: correctionKey, after: submissions.length,
        });
        state.raisedFor.set(txKey, submissions.length);
        return true;
      };
      // Any corrective action this Auditor takes starts the evidence window for
      // that transaction: from here, only work submitted later can answer it.
      if (item.transaction_id && ['request_correction', 'request_replan', 'request_revalidation'].includes(textOf(item.action) ?? '')) {
        if (!beginCorrection()) return say(`The correction for transaction ${txKey} is recorded; waiting for replacement work. ${STATUS_LINE}`);
      }
      if (item.action === 'inspect_validation') {
        const outstanding = state.needsRevision === txKey;
        if (outstanding) {
          const latest = submissions[submissions.length - 1] ?? null;
          // From here on, only work submitted *after* this point can answer it.
          if (!beginCorrection()) return say(`The rejected result for transaction ${txKey} already has a recorded issue. ${STATUS_LINE}`);
          return call('flow_audit', {
            action: 'inspect_validation',
            params: {
              transaction_id: item.transaction_id,
              ...(item.audit_id ? { audit_id: item.audit_id } : {}),
              decision: 'reject',
              required_change: 'grant the deepest branch a write scope that covers deep/nested/result.txt and produce the file there',
              evidence: {
                reason: 'the Worker reported the write was refused outside its granted paths',
                granted: latest?.granted ?? null,
                deliverable: 'deep/nested/result.txt',
                submission: latest?.at ?? null,
              },
            },
          });
        }
        // An issue this Auditor raised is answered by the Auditor. Approving the
        // replacement first would let acceptance close the issue on the way past
        // (`reason: accepted-result-after-issue`), which is exactly the route the
        // case must not certify: the correction has to be verified, by name,
        // against the replacement work.
        const open = [...(state.issuesByTx.get(txKey) ?? [])].find(([id]) => !state.verifiedIssues.has(id));
        const openIssue = open?.[0] ?? null;
        const required = open?.[1] ?? null;
        const answered = required !== null
          && submissions.length > required
          && submissions.slice(required).some(entry => entry.completed === true);
        state.verificationLog.push({
          at: submissions.length,
          transaction_id: textOf(txKey),
          openIssue,
          answered,
          already_sent: openIssue !== null && state.verificationAttempts.get(agentId) === openIssue,
        });
        if (openIssue && !answered) return say(`Issue ${openIssue} has no replacement Worker result yet; leaving it open. ${STATUS_LINE}`);
        if (openIssue && answered && !state.complianceIssues.has(openIssue)) {
          state.verificationAttempts.set(agentId, openIssue);
          return call('flow_audit', {
            action: 'verify_correction',
            params: {
              issue_id: openIssue,
              decision: 'verified',
              evidence: {
                checked: 'a replacement Worker submitted a complete result for this transaction after the issue was raised',
                submissions_after_issue: submissions.length - required,
              },
            },
          });
        }
        return call('flow_audit', {
          action: 'inspect_validation',
          params: {
            transaction_id: item.transaction_id,
            ...(item.audit_id ? { audit_id: item.audit_id } : {}),
            decision: 'approve',
            evidence: { reason: 'the recorded result revision satisfies the acceptance criteria for this transaction' },
          },
        });
      }
      if (item.action === 'verify_correction' || item.action === 'review_issue') {
        const issueId = item.issue_id;
        const required = state.issuesByTx.get(txKey)?.get(String(issueId)) ?? state.raisedFor.get(txKey) ?? null;
        // A verdict needs the replacement work itself: a submission for this
        // issue's transaction, observed by the fixture *after* the issue was
        // raised, that did not report itself incomplete. The fixture issuing a
        // submit tool call is not yet a durable result, so the plugin's own
        // published state is read before judging — the same `flow_query` a real
        // Auditor is told to use, which does not end the turn.
        const newEvidence = required !== null
          && submissions.length > required
          && submissions.slice(required).some(entry => entry.completed === true);
        if (!newEvidence) {
          return say(`Issue ${issueId} has no replacement Worker result yet; leaving it open for the Orchestrator. ${STATUS_LINE}`);
        }
        if (!queriedTransaction) {
          return call('flow_query', { what: 'transaction', params: { id: item.transaction_id } });
        }
        const published = ['SUBMITTED', 'VALIDATING', 'ACCEPTED'].includes(String(queriedTransaction.status ?? ''))
          && Number(queriedTransaction.result_revision ?? queriedTransaction.revision ?? 0) > Number(item.target_revision ?? 0);
        if (!published) {
          return say(`Issue ${issueId}: transaction ${item.transaction_id} is ${queriedTransaction.status} with no later published result; leaving it open. ${STATUS_LINE}`);
        }
        state.verificationAttempts.set(agentId, String(issueId));
        return call('flow_audit', {
          action: 'verify_correction',
          params: {
            issue_id: issueId,
            decision: 'verified',
            evidence: {
              checked: 'a replacement Worker submitted a result for this transaction after the issue was raised',
              submissions_after_issue: submissions.length - required,
            },
          },
        });
      }
      return null;
    },
    reportEvidence: () => ({
      submissions: Object.fromEntries([...state.submissions].map(([tx, list]) => [String(tx).slice(-14), list])),
      raised_for: Object.fromEntries([...state.raisedFor].map(([tx, count]) => [String(tx).slice(-14), count])),
      issues: [...state.issuesByTx].flatMap(([tx, issues]) => [...issues.keys()].map(issue => [String(tx).slice(-14), issue.slice(0, 8)])),
      verification_log: state.verificationLog.map(entry => ({ ...entry, transaction_id: String(entry.transaction_id ?? '').slice(-14) })),
      owes_revision: state.needsRevision ? String(state.needsRevision).slice(-14) : null,
    }),
  };
}

/**
 * The recovery case: a controlled crash while a real cluster is mid-turn.
 *
 * Two fixture-owned constraints make the crash land where the case says it
 * does. The Orchestrator makes `r4` depend on `r3`, so the receiving Worker
 * cannot start before the message that crosses subtrees has been delivered;
 * and the receiving Worker's sum call is held after native admission, so
 * the runner can kill the host while that identity is genuinely in flight.
 */
function recoveryHooks(context: MockCaseContext): MockScenarioHooks {
  const fixtureIds = context.fixtureIds ?? {};
  const findBySuffix = (suffix: string): string | undefined => Object.entries(fixtureIds).find(([key]) => key.endsWith(suffix))?.[1];
  const r3 = findBySuffix('-r3');
  const r4 = findBySuffix('-r4');
  const blackboardKey = `${context.runId ?? ''}/total`;
  const state = { dependencySet: false, published: false, held: false };
  return {
    orchestrator(request) {
      const contextFacts = request.classified.context ?? {};
      const statuses = asRecord(asRecord(contextFacts.transactions)?.by_status) ?? {};
      if (!state.dependencySet && r3 && r4) {
        const tx = asRecord(asRecord(request.classified.context?.transaction)?.transaction);
        if (tx?.id !== r4) return call('flow_query', { what: 'transaction', params: { id: r4, fields: ['requirements'] } });
        state.dependencySet = true;
        return call('flow_transaction', {
          action: 'set_dependency',
          params: { transaction_id: r4, expected_transaction_revision: tx?.revision, depends_on: [r3] },
        });
      }
      // The case's own instruction names the blackboard key the run owes: it is
      // published only once every transaction is accepted, and only once.
      const accepted = Number(statuses.ACCEPTED ?? 0);
      const open = Object.entries(statuses)
        .filter(([status]) => !['ACCEPTED', 'CANCELLED', 'FAILED', 'SUPERSEDED'].includes(status))
        .reduce((sum, [, count]) => sum + Number(count), 0);
      if (!state.published && accepted >= 4 && open === 0) {
        state.published = true;
        return call('flow_communicate', {
          action: 'publish',
          params: { key: blackboardKey, value: { accepted, source: 'cluster' } },
        });
      }
      return null;
    },
    worker(request) {
      const c = request.classified;
      if (c.transactionId !== r4 || state.held || c.lastToolName !== 'flow_query') return null;
      state.held = true;
      return { ...call('flow_sum', { values: sumValues(c.objective) ?? [] }), hold: 'recovery-r4-execution' };
    },
  };
}

/**
 * The scale ladder: one Worker per generated file. The symbol and the line are
 * read out of the *real* read-tool result, never from the fixture's expected
 * table, so the value a transaction submits is evidence that the file was
 * really read in that Worker's own session.
 */
function scaleHooks(context: MockCaseContext): MockScenarioHooks {
  const workspace = context.workspace ?? '';
  const state = { held: 0, holdBudget: numberOf(asRecord(context.limits)?.max_llm_concurrency) ?? 0 };
  /** The declaration the read tool actually returned, with the line it sat on. */
  const parse = (text: unknown): { symbol: string | null; line: number | null } => {
    const lines = String(text ?? '').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      // The tool may prefix each line with its number; when it does, that is the
      // line the Worker saw, and it is what must be quoted back.
      const numbered = /^\s*(\d+)[:|]\s?(.*)$/u.exec(line)
        ?? /^\s*(\d+)\t(.*)$/u.exec(line);
      const body = numbered ? numbered[2] ?? '' : line;
      const match = /export\s+function\s+(\w+)/u.exec(body);
      if (match) return { symbol: match[1] ?? null, line: numbered ? Number(numbered[1]) : index + 1 };
    }
    const inline = /export\s+function\s+(\w+)/u.exec(String(text ?? ''));
    if (inline) {
      const before = String(text).slice(0, inline.index).split('\n').length;
      return { symbol: inline[1] ?? null, line: before };
    }
    return { symbol: null, line: null };
  };
  const relativeOf = (objective: unknown): string | null => /Read the file (\S+) \(relative to the workspace\)/u.exec(String(objective ?? ''))?.[1] ?? null;
  return {
    orchestrator(request, item) {
      if (item.action !== 'validate') return null;
      const detail = asRecord(request.classified.context?.transaction) ?? {};
      const inputs = asRecord(detail.inputs) ?? {};
      const publication = asRecord(detail.result) ?? {};
      const result = asRecord(publication.result) ?? {};
      const expected = parse(inputs.source_excerpt);
      const passed = result.file === inputs.file && expected.symbol !== null && result.symbol === expected.symbol && result.line === expected.line;
      const params = validationParams(request, item);
      return call('flow_transaction', { action: 'validate', params: { ...params, accepted: passed,
        checks: recordsOf(params.checks).map(check => ({ ...check, passed,
          method: 'Parse the declaration and its exact line from the formally supplied source excerpt and compare the current publication.',
          observation: JSON.stringify({ file: inputs.file, source_hash: inputs.hash, expected, submitted: result }),
          evidence: JSON.stringify({ source_excerpt: inputs.source_excerpt, source_hash: inputs.hash, publication: publication.ref }) })) } });
    },
    worker(request) {
      const c = request.classified;
      const relative = relativeOf(c.objective);
      if (!relative) return null;
      const reply = c.lastToolName !== 'read'
        ? call('read', { file_path: join(workspace, relative) })
        : (() => {
          const found = parse(c.lastToolResult);
          return call(WORKER_TOOL_NAME, {
            action: 'submit_result',
            params: {
              transaction_id: c.transactionId,
              result: {
                file: relative,
                symbol: found.symbol ?? 'unknown',
                line: found.line,
                responsibility: `top-level declaration of ${relative}`,
              },
              notes: `read ${relative} and quoted the declaration the tool returned`,
            },
          });
        })();
      // The first `max_llm_concurrency` Worker requests are held open at the
      // same time. That is what turns the ceiling from a number the plugin
      // reports into something the wire can see: while they are held, a request
      // beyond the ceiling would have to arrive at this server.
      if (state.held < state.holdBudget) {
        state.held += 1;
        return { ...reply, hold: 'scale-concurrency' };
      }
      return reply;
    },
  };
}

/**
 * The browser case: a Worker drives the host's own authenticated page through
 * the real Playwright MCP tools. Every step is derived from the tool result the
 * host actually returned — the cluster control's `ref` comes out of a real
 * snapshot, never from a fixed DOM selector the fixture chose.
 */
function browserHooks(): MockScenarioHooks {
  const state = { noticeDismissed: false, clicked: false, ref: null as string | null };
  const NAV = 'mcp__playwright-mcp__browser_navigate';
  const SNAPSHOT = 'mcp__playwright-mcp__browser_snapshot';
  const CLICK = 'mcp__playwright-mcp__browser_click';
  /** The accessibility ref of the control whose accessible name contains X. */
  const refFor = (text: unknown, pattern: RegExp): string | null => {
    for (const line of String(text ?? '').split('\n')) {
      if (!pattern.test(line)) continue;
      const ref = /ref=([A-Za-z0-9_-]+)/u.exec(line);
      if (ref) return ref[1] ?? null;
    }
    return null;
  };
  const titleOf = (text: unknown): string | null => /^-\s*Page Title:\s*(.+)$/imu.exec(String(text ?? ''))?.[1]?.trim() ?? null;
  return {
    worker(request) {
      const c = request.classified;
      const raw = /\b(https?:\/\/\S+)/u.exec(`${c.objective ?? ''} ${c.userText ?? ''}`)?.[1] ?? null;
      // The URL is quoted inside an English sentence, so trailing punctuation
      // belongs to the sentence, not to the query string.
      const url = raw ? raw.replace(/[),.;:!?]+$/u, '') : null;
      const last = c.lastToolName;
      if (!url) return null;
      if (!last || last === 'flow_query') return call(NAV, { url });
      if (last === NAV) return call(SNAPSHOT, {});
      if (last === CLICK) return call(SNAPSHOT, {});
      if (last === SNAPSHOT) {
        const text = String(c.lastToolResult ?? '');
        // The shipped app opens with an internal-testing notice that covers the
        // frame; a real page must acknowledge it before the panel is clickable.
        if (!state.noticeDismissed) {
          const notice = refFor(text, /button\s+"(?:continue|继续|我已了解)"/iu);
          state.noticeDismissed = true;
          if (notice) return call(CLICK, { target: notice });
        }
        if (!state.clicked) {
          const ref = refFor(text, /button\s+"(?:插件|Plugins)"/iu);
          if (!ref) throw new Error(`no Plugins control ref in the snapshot: ${text.slice(0, 600)}`);
          state.ref = ref;
          state.clicked = true;
          return call(CLICK, { target: ref });
        }
        const title = titleOf(text);
        const heading = /heading "插件"/iu.test(text);
        if (!title || !heading) {
          throw new Error(`the post-click snapshot lacks the panel heading or page title: ${text.slice(0, 600)}`);
        }
        return call('flow_transaction', {
          action: 'submit_result',
          params: {
            transaction_id: c.transactionId,
            result: {
              page_title: title,
              heading: '插件',
              ref: state.ref,
              tools: ['browser_navigate', 'browser_snapshot', 'browser_click'],
            },
            notes: 'navigated to the host page, dismissed its notice, clicked the Plugins control by its snapshot ref and snapshotted the opened panel',
          },
        });
      }
      return null;
    },
  };
}

export function caseHooks(caseId: string, context: MockCaseContext = {}): MockScenarioHooks {
  return CASE_HOOKS[caseId]?.(context) ?? {};
}

/** What a case's own expectations assert about the requests it saw. */
export interface MockScenarioExpectations {
  requests?: Record<string, unknown>;
  compaction?: boolean;
}

/** One case scenario's inputs. */
export interface BuildScenarioOptions {
  caseId: string;
  layout?: unknown;
  workspace?: string | null;
  fixtureIds?: Record<string, string>;
  runId?: string | null;
  limits?: Record<string, unknown> | null;
  hooks?: MockScenarioHooks | null;
  expectations?: MockScenarioExpectations;
}

/**
 * Build one case scenario. `hooks` are the case-specific parts; everything the
 * case does not override falls back to the plugin-driven default policy.
 */
export function buildScenario({
  caseId, layout = null, workspace = null, fixtureIds = {}, runId = null, limits = null, hooks = null, expectations = {},
}: BuildScenarioOptions): MockScenario {
  const resolvedHooks = hooks && Object.keys(hooks).length
    ? hooks
    : caseHooks(caseId, { fixtureIds, workspace, layout, runId, limits });
  const seen: MockScenarioSeen = { compaction: 0, role: {}, worker: {}, query_missing: 0 };
  const problems: string[] = [];
  const work = new Map<string, QueriedWork>();
  const ctx: MockScenarioContext = {
    caseId,
    layout,
    workspace,
    limits,
    hooks: resolvedHooks,
    // The last pending item each identity was answered with, so a step that
    // continues after a mid-turn compaction does not re-issue it.
    lastIssued: new Map(),
    // How many times each node's capacity has been topped up from an idle grant,
    // so a recurring deficit is answered without looping on the ledger read.
    rebalanced: new Map(),
    revisionFor: item => resolvedHooks.revision?.(item) ?? null,
    decomposeFor: (request, item) => resolvedHooks.decompose?.(request, item) ?? null,
    correctionFor: item => resolvedHooks.correction?.(item) ?? null,
    validationDecision: (request, item) => resolvedHooks.validationDecision?.(request, item) ?? 'approve',
    seen,
    problems,
  };
  const respondRequest = (request: MockRequestRecord): MockScenarioReply | null => {
      const classified = request.classified;
      // Initial Flow tasks use native user provenance, which also enables
      // the host's ordinary first-prompt session-title provider.
      if (classified.kind === 'unknown' && classified.userText.startsWith('Generate the session title from this JSON array of human messages:\n')) {
        return say('原生任务会话');
      }
      if(caseId==='panel'&&classified.kind==='unknown') {
        const messages=JSON.stringify(request.body);
        if(classified.userText.trim().startsWith('NATIVE-ORDINARY:'))return classified.lastToolName==='agent_team_message'?say('OK，已收到主会话答复'):call('agent_team_message',{text:classified.userText});
        if(messages.includes('native-A-')||messages.includes('native-B-'))return say('原生观察记录');
      }
      if((caseId==='team-launch'||caseId==='panel')&&classified.kind==='unknown') {
        const wire=recordsOf(asRecord(request.body)?.messages);
        const newestInvocation=wire.findLastIndex(message=>message.role==='user'&&(typeof message.content==='string'?message.content:recordsOf(message.content).map(block=>textOf(block.text)??'').join('\n')).trim().startsWith('/agent-team '));
        if(newestInvocation>=0&&!wire.slice(newestInvocation+1).some(message=>message.role==='tool'))return call('agent_team_read',{});
        let data:Record<string,unknown>|null=null;
        try{data=asRecord(JSON.parse(classified.lastToolResult??'null'));}catch{/* The first main request has no tool result. */}
        const run=asRecord(data?.run);
        if(!data)return call('agent_team_read',{});
        const launch=listOf(data?.launches).map(asRecord).find(launch=>launch&&!listOf(data?.runs).some(value=>asRecord(value)?.launch_id===launch.launch_id));
        if(!run||launch) {
          return call('agent_team_create',{launch_id:launch?.launch_id,objective:caseId==='panel'?launch?.objective:'Sum [2,3] with flow_sum and independently verify the total 5.',assessment:{complexity:'simple',rationale:'One task with independent validation'},acceptance_criteria:caseId==='panel'?['The result names the task objective']:['Verified total is 5'],capabilities:[]});
        }
        if(['completed','cancelled','failed'].includes(String(run.state))) {
          if(!run.finalized_at)return call('agent_team_finalize',{run_id:run.id});
          if(classified.lastToolName==='agent_team_finalize')return call('agent_team_read',{run_id:run.id});
          return say('结果 5 已通过审查，团队已收尾，历史保留。');
        }
        if(caseId==='panel')return say(run.state==='waiting_user'?'团队等待你确认使用当前工作区。':'团队正在执行，可以继续查看原生记录。');
        return call('agent_team_read',{run_id:run.id,after_version:run.version,wait_ms:30000});
      }
      if (classified.kind === 'compaction') {
        seen.compaction += 1;
        return say(checkpointFor(classified));
      }
      resolvedHooks.observe?.(request);
      const queryReply = readWork(request, work, caseId);
      if (queryReply) return queryReply;
      if (classified.kind === 'role') {
        if (classified.lastToolName && classified.lastToolName !== 'flow_query' && /^Error:/u.test(classified.lastToolResult ?? '')) return say(`The action was refused: ${classified.lastToolResult}. I need a valid updated task before retrying.`);
        const role = classified.role;
        const key = `${role}:${classified.agentId}`;
        seen.role[key] = (seen.role[key] ?? 0) + 1;
        if (!role || !ROLE_TOOL_NAME[role]) {
          throw new Error(`unknown cluster role ${JSON.stringify(classified.role)} in the role prompt`);
        }
        if (role === 'orchestrator') return orchestratorReply(request, ctx);
        if (role === 'allocator') return allocatorReply(request, ctx);
        return auditorReply(request, ctx);
      }
      if (classified.kind === 'worker') {
        const key = classified.transactionId ?? 'unknown';
        seen.worker[key] = (seen.worker[key] ?? 0) + 1;
        return workerReply(request, ctx);
      }
      throw new Error(`unrecognised model request: no authenticated native identity (${classified.messageCount} messages)`);
  };
  return {
    name: `mock:${caseId}`,
    respond(request) { return enrichMockReply(request, respondRequest(request)); },
    finish() {
      const issues = [...problems];
      for (const [key, expected] of Object.entries(expectations.requests ?? {})) {
        if (!seen.role[key] && !seen.worker[key]) issues.push(`expected a request for ${key}, saw none`);
        void expected;
      }
      if (expectations.compaction && seen.compaction === 0) issues.push('expected at least one real compaction request, saw none');
      return {
        requests: Object.values(seen.role).reduce((sum, count) => sum + count, 0)
          + Object.values(seen.worker).reduce((sum, count) => sum + count, 0)
          + seen.compaction,
        compaction_requests: seen.compaction,
        role_requests: { ...seen.role },
        worker_requests: { ...seen.worker },
        query_missing: seen.query_missing,
        checks: [],
        problems: issues,
        ...(ctx.hooks.reportEvidence ? { fixture_evidence: ctx.hooks.reportEvidence() } : {}),
      };
    },
  };
}

export { COMPACTION_MARKER, ROLE_TOOL_NAME };
