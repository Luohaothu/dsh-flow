/**
 * Role action handlers. Each handler is synchronous and runs inside the single
 * SQLite transaction opened by `ClusterRuntime.command`; nothing here awaits
 * model, network or file IO.
 *
 * Handlers receive the runtime so they can reuse its domain helpers, but they
 * never start turns or touch the scheduler directly.
 */
import { randomUUID } from 'node:crypto';

import { fail, integer, normalizeLimit } from './store.js';
import {
  AGENT_TERMINAL, TRANSACTION_TERMINAL, assertTransition, scopesOverlap,
  validateCapabilities, validateWriteScope,
} from './protocol.js';
import { canonicalScope, withinScope } from './scope.js';
import {
  budgetView, createBudget, dimensionAvailable, effectiveDeadline, exhausted, lineageIds,
  reclaimCapacity, reserveChain, settleChain, transferBudget, DIMENSIONS,
} from './budget.js';

const MAX_ISSUE_CORRECTIONS = 2;

// ------------------------------------------------------------------ helpers

/** Required parameter access with a corrective message the model can act on. */
function need(params, key, label = key) {
  const value = params?.[key];
  if (typeof value !== 'string' || !value) fail(`params.${key} is required (${label})`);
  return value;
}

function txOf(rt, id) {
  if (typeof id !== 'string' || !id) fail('params.transaction_id is required');
  const tx = rt.store.getTransaction(id);
  if (!tx) fail('Transaction not found', 404);
  return tx;
}

function nodeOf(rt, id) {
  const node = rt.store.getNode(id);
  if (!node) fail('Node not found', 404);
  return node;
}

/** A management role may write only inside its own node's subtree. */
function assertDomain(rt, cluster, actor, nodeId) {
  if (!nodeId) fail('A management domain is required', 403);
  const target = nodeOf(rt, nodeId);
  if (target.cluster_id !== cluster.id) fail('Node belongs to another cluster', 403);
  if (actor.role === 'user') return target;
  if (!actor.node_id) fail('Actor has no management domain', 403);
  if (target.id === actor.node_id) return target;
  let cursor = target;
  const guard = new Set();
  while (cursor.parent_id) {
    if (guard.has(cursor.id)) fail('Management tree cycle', 409);
    guard.add(cursor.id);
    cursor = nodeOf(rt, cursor.parent_id);
    if (cursor.id === actor.node_id) return target;
  }
  fail(`node ${nodeId} is outside the actor's management domain`, 403);
}

function assertTransactionDomain(rt, cluster, actor, transactionId) {
  const tx = txOf(rt, transactionId);
  if (tx.cluster_id !== cluster.id) fail('Transaction belongs to another cluster', 403);
  assertDomain(rt, cluster, actor, tx.node_id);
  return tx;
}

function setStatus(rt, tx, status) {
  return setTransactionStatus(rt.store, rt, { id: tx.cluster_id }, tx, status);
}

/** Legal, evented transaction status change. Shared with the scheduler. */
export function setTransactionStatus(store, rt, cluster, tx, status) {
  assertTransition(tx.status, status);
  if (tx.status === status) return tx;
  store.appendEvent(cluster.id, 'transaction-status', { transaction_id: tx.id, from: tx.status, to: status });
  return store.updateTransaction(tx.id, { status, __bump_revision: false });
}

function bumpRevision(rt, tx, patch = {}) {
  return rt.store.updateTransaction(tx.id, patch);
}

function openIssue(rt, cluster, actor, params) {
  const issue = rt.store.insertIssue({
    id: randomUUID(), cluster_id: cluster.id, node_id: params.node_id ?? actor.node_id,
    transaction_id: params.transaction_id ?? null, reporter_agent_id: actor.agent_id ?? null,
    target_revision: params.target_revision ?? 0, severity: params.severity ?? 'MAJOR',
    evidence: params.evidence ?? {}, required_change: params.required_change ?? '',
  });
  rt.store.appendEvent(cluster.id, 'issue-opened', {
    issue_id: issue.id, transaction_id: issue.transaction_id, severity: issue.severity,
    required_change: issue.required_change.slice(0, 200),
  });
  const recipient = rt.roleAgentOf(cluster.id, issue.node_id, 'orchestrator');
  rt.notifyInternal(cluster.id, recipient?.id, { subject: 'issue-opened', payload: { issue_id: issue.id, transaction_id: issue.transaction_id } });
  return issue;
}

function assertCorrectionBudget(rt, cluster, tx, maxCorrections) {
  const used = rt.store.countCorrections(cluster.id, tx?.id ?? null);
  if (used >= maxCorrections) {
    // The refusal is the essential part: the guard sits before the issue is written, so
    // without it the very round it forbade still happened. The stop is recorded as an
    // event and applied by the scheduler rather than inside this command's transaction,
    // where the refusal's rollback would take it away again.
    rt.noteCorrectionBudgetStop?.(cluster.id, {
      nodeId: tx?.node_id ?? null, transactionId: tx?.id ?? null, used, maxCorrections,
    });
    fail(`correction budget exhausted: ${used} of ${maxCorrections} rounds have failed for ${tx?.id ?? 'this cluster'}`, 409);
  }
}

function createWorkerForTransaction(rt, cluster, actor, node, tx, params = {}) {
  const limits = cluster.limits;
  if (tx.status !== 'READY') fail(`transaction ${tx.id} is ${tx.status}; only READY transactions are allocated`, 409);
  // Authorization to supervise a subtree does not transfer ownership of its
  // transactions. A root Allocator that names a delegated transaction without
  // `node_id` otherwise creates a root Worker whose write effect cannot belong
  // to the deepest node that owes the result.
  if (node.id !== tx.node_id) {
    fail(`transaction ${tx.id} belongs to node ${tx.node_id}, not allocation node ${node.id}; allocate it under its owning node`, 409);
  }
  // The delegated work must finish first: a parent's own attempts are what runs *after*
  // its children report, and spending them early is how a branch escalated with its
  // delegation still DRAFT (measured: the parent was allocated in the same turn that
  // spawned its child). Filtering the hints was not enough — this is the execution path.
  if (rt.store.parentsAwaitingChildren(cluster.id).includes(tx.id)) {
    fail(`${tx.id} has delegated work still unfinished; wait for the child results and aggregate them`, 409);
  }
  // The topology instruction is pending even before a child transaction
  // exists. `parentsAwaitingChildren` cannot see it yet; allowing a Worker
  // now spends the delegated parent's attempts instead of building the child.
  if (node.delegated_transaction_id === tx.id && rt.pendingDelegationInstruction(cluster, node)) {
    fail(`${tx.id} still owes a delegated management child; spawn it before allocating a Worker`, 409);
  }
  // Delegation changes a parent's completion path permanently: after the
  // last child is accepted, aggregate its evidence rather than spending a
  // Worker attempt on the already-delegated structural objective.
  if (rt.store.get(
    'SELECT 1 FROM transactions WHERE cluster_id=? AND parent_transaction_id=? LIMIT 1',
    cluster.id, tx.id,
  )) {
    fail(`${tx.id} has delegated children; aggregate their results instead of allocating a Worker`, 409);
  }
  const existingAllocation = rt.store.activeAllocationForTransaction(tx.id);
  if (existingAllocation) {
    if (rt.store.allocationOutdated(cluster.id, existingAllocation)) {
      fail(`allocation ${existingAllocation.id} predates the revised transaction ${tx.id}; release it before allocating this plan`, 409);
    }
    return { allocation: existingAllocation, agent: rt.store.getAgent(existingAllocation.agent_id), deduped: true };
  }

  // A released worker node is a spent identity: it keeps its history and its
  // agent rows, but it no longer holds a child slot, so a long ladder recycles
  // resident capacity instead of filling the tree with one node per task.
  const children = rt.store.childrenOf(node.id);
  const occupied = children.filter(child => child.status !== 'RELEASED');
  const childLimit = node.max_children ?? limits.max_children;
  if (occupied.length >= childLimit) fail(`node ${node.id} reached max_children ${childLimit}`, 409);
  if (node.depth + 1 > limits.max_depth) fail(`depth limit ${limits.max_depth} reached`, 409);
  const live = rt.store.countAgents(cluster.id, { live: true });
  if (live >= limits.max_agents) fail(`max_agents ${limits.max_agents} reached`, 409);

  // Inheritance order: the caller's explicit restriction, then the
  // transaction's own set, then its management node's, then the cluster's. An
  // omitted field must never mean "no capability at all".
  const inherited = firstNonEmpty(params.capabilities, tx.capabilities, node.capabilities, cluster.capabilities);
  const capabilities = validateCapabilities(inherited, 'allocation.capabilities');
  const writeScope = validateWriteScope(params.write_scope ?? (tx.inputs?.write_scope ?? []), 'write_scope');
  // Ownership is frozen at grant time: the canonical form is what both the
  // overlap check and every later dispatch compare, so two aliases of one
  // directory cannot both hold the lock.
  const canonical = canonicalScope(cluster.workspace, writeScope);
  if (canonical === null) fail(`write scope ${JSON.stringify(writeScope)} cannot be resolved inside the workspace (a dangling symlink is refused)`, 409);
  // A delegated transaction's write scope is a ceiling, not a suggestion an
  // Allocator can override. An explicit allocation may narrow it; widening it
  // requires the Orchestrator to revise the transaction first. Without this
  // check the first Worker in the recursion case was granted deep/nested while
  // its transaction still required deep/staging, bypassing the injected fault.
  if (params.write_scope !== undefined && Object.hasOwn(tx.inputs ?? {}, 'write_scope')) {
    const restricted = canonicalScope(cluster.workspace, validateWriteScope(tx.inputs.write_scope, 'inputs.write_scope'));
    if (restricted === null || canonical.some(entry => !restricted.some(parent => withinScope(entry, parent)))) {
      fail(`allocation write scope ${JSON.stringify(writeScope)} widens transaction ${tx.id} write scope ${JSON.stringify(tx.inputs.write_scope)}; adjust the transaction before granting a wider scope`, 409);
    }
  }
  assertWriteScopeFree(rt, cluster, canonical, writeScope);

  const nodeBudget = rt.store.budgetForScope(cluster.id, 'node', node.id);
  if (nodeBudget) {
    try {
      reserveChain(rt.store, [nodeBudget.id], { agents: 1 }, { label: `allocate agent for ${tx.id}` });
    } catch (error) {
      if (error.code === 'LIMIT_REACHED') fail(`node ${node.id} cannot host another active agent: ${error.message}`, 409);
      throw error;
    }
  }

  // Reuse a released worker node (reactivating its slot) before growing the
  // tree, so the node path stays stable across a ladder of tasks.
  const reusable = children.find(child => child.kind === 'worker' && child.status === 'RELEASED');
  const workerNode = reusable
    ? (rt.store.updateNode(reusable.id, {
      status: 'ACTIVE', scope: { transaction_id: tx.id, objective: tx.objective.slice(0, 200) }, capabilities,
    }), rt.store.getNode(reusable.id))
    : rt.store.insertNode({
      id: randomUUID(), cluster_id: cluster.id, parent_id: node.id, kind: 'worker',
      depth: node.depth + 1, status: 'ACTIVE', scope: { transaction_id: tx.id, objective: tx.objective.slice(0, 200) },
      capabilities, path: `${node.path}.${occupied.length}`, max_children: 0,
    });
  const agent = rt.store.insertAgent({
    id: randomUUID(), cluster_id: cluster.id, node_id: workerNode.id, role: 'worker',
    session_id: randomUUID(), status: 'READY', capabilities, cwd: cluster.workspace,
    meta: { transaction_id: tx.id, allocated_by: actor.agent_id ?? null },
  });
  if (nodeBudget) rt.grantAgentBudget(cluster.id, workerNode, nodeBudget, agent, 'worker');
  const allocation = rt.store.insertAllocation({
    id: randomUUID(), cluster_id: cluster.id, node_id: node.id, agent_id: agent.id,
    transaction_id: tx.id, capabilities, write_scope: writeScope, write_scope_canonical: canonical, status: 'ACTIVE',
  });
  const budget = params.budget === undefined ? null : rt.store.budgetForScope(cluster.id, 'agent', agent.id);
  if (params.budget && budget) applyBudgetGrant(rt, nodeBudget, budget, params.budget);
  rt.store.updateNode(workerNode.id, { status: 'ACTIVE' });
  rt.store.appendEvent(cluster.id, 'agent-allocated', {
    agent_id: agent.id, node_id: node.id, transaction_id: tx.id, write_scope: writeScope, capabilities,
  });
  return { allocation, agent, node: workerNode };
}

/** First candidate that is a non-empty list, or an empty list when none is. */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
}

function assertWriteScopeFree(rt, cluster, canonicalScopeEntries, originalScope) {
  if (!canonicalScopeEntries.length) return;
  for (const allocation of rt.store.allocationsInSubtree(cluster.id, null, { status: 'ACTIVE' })) {
    const existing = allocation.write_scope_canonical ?? canonicalScope(cluster.workspace, allocation.write_scope) ?? [];
    if (scopesOverlap(canonicalScopeEntries, existing)) {
      fail(`write scope ${JSON.stringify(originalScope)} overlaps active allocation ${allocation.id} (${JSON.stringify(allocation.write_scope)})`, 409);
    }
  }
}

/**
 * Accept both `{tokens: 1000}` and `{tokens: {limit: 1000}}` (a shape models
 * reach for), and translate a requests/tool-calls spelling to this ledger.
 */
function normaliseAmounts(amounts) {
  const out = {};
  for (const [key, value] of Object.entries(amounts ?? {})) {
    const name = key === 'requests' || key === 'model_requests' ? 'model_requests'
      : key === 'tool_calls' || key === 'tools' ? 'tool_calls'
        : key === 'max_active' || key === 'max_active_agents' ? 'max_active_agents'
          : key;
    const raw = value && typeof value === 'object' ? (value.limit ?? value.amount ?? value.value) : value;
    if (raw === undefined || raw === null) continue;
    if (!Number.isFinite(raw)) fail(`Invalid budget amount for ${key}`);
    out[name] = Math.floor(raw);
  }
  return out;
}

function applyBudgetGrant(rt, fromBudget, toBudget, amounts) {
  const transfer = {};
  for (const [key, value] of Object.entries(amounts)) {
    if (!['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents'].includes(key)) fail(`Unknown budget dimension: ${key}`);
    transfer[key] = value;
  }
  if (!Object.keys(transfer).length) return;
  if (!fromBudget) fail('No parent budget to transfer from', 409);
  transferBudget(rt.store, fromBudget.id, toBudget.id, transfer);
}

function assertAllocationTurnDrained(rt, allocation) {
  const lease = rt.store.leaseForAgent(allocation.agent_id);
  if (rt.activeTurnFor(allocation.agent_id) || (lease && lease.expires > rt.timestamp())) {
    fail(`agent ${allocation.agent_id} has an active turn or lease; wait for it to finish before changing allocation ${allocation.id}`, 409);
  }
}
function assertTransactionWorkerDrained(rt, tx) {
  if (tx.status !== 'RUNNING') return;
  const allocation = rt.store.activeAllocationForTransaction(tx.id);
  if (allocation) assertAllocationTurnDrained(rt, allocation);
}


function reclaimUnusedAgentGrant(rt, clusterId, agentId, nodeBudget) {
  if (!nodeBudget) return;
  const agentBudget = rt.store.budgetForScope(clusterId, 'agent', agentId);
  if (!agentBudget) return;
  const give = {};
  for (const key of ['tokens', 'model_requests', 'tool_calls']) {
    const available = dimensionAvailable(agentBudget, key);
    if (available > 0) give[key] = available;
  }
  if (Object.keys(give).length) transferBudget(rt.store, agentBudget.id, nodeBudget.id, give);
}

function releaseAllocation(rt, cluster, allocation, reason) {
  const current = rt.store.getAllocation(allocation.id);
  if (!current || current.status !== 'ACTIVE') return { deduped: true };
  rt.store.updateAllocation(current.id, { status: 'RELEASED' });
  const agent = rt.store.getAgent(current.agent_id);
  if (agent && !AGENT_TERMINAL.has(agent.status)) rt.store.updateAgent(agent.id, { status: 'TERMINATED' });
  const nodeBudget = rt.store.budgetForScope(cluster.id, 'node', current.node_id);
  if (nodeBudget) reclaimCapacity(rt.store, nodeBudget.id, { agents: 1 });
  reclaimUnusedAgentGrant(rt, cluster.id, current.agent_id, nodeBudget);
  // The worker node keeps its identity and history but stops holding a child
  // slot: `allocate_agent` can then reuse it for the next task instead of
  // growing the tree until `max_children` blocks the ladder.
  const workerNode = rt.store.getNode(agent?.node_id ?? null);
  if (workerNode && workerNode.kind === 'worker' && workerNode.status === 'ACTIVE') {
    rt.store.updateNode(workerNode.id, { status: 'RELEASED' });
  }
  rt.store.appendEvent(cluster.id, 'agent-released', {
    agent_id: current.agent_id, allocation_id: current.id, node_id: workerNode?.id ?? null,
    reason: reason ?? 'completed',
  });
  return { allocation_id: current.id, agent_id: current.agent_id };
}

/**
 * Tell everyone who must know that a transaction changed: the domain's other
 * roles and the Auditor. A change the Auditor never hears about is a change it
 * cannot supervise.
 */
function notifyTransactionModified(rt, cluster, actor, tx, change, seen = new Set()) {
  if (!tx || seen.has(tx.id)) return;
  seen.add(tx.id);
  const recipients = [
    rt.roleAgentOf(cluster.id, tx.node_id, 'orchestrator'),
    rt.roleAgentOf(cluster.id, tx.node_id, 'allocator'),
    rt.roleAgentOf(cluster.id, tx.node_id, 'auditor'),
  ].filter(agent => agent && agent.id !== actor.agent_id);
  for (const recipient of recipients) {
    rt.notifyInternal(cluster.id, recipient.id, {
      subject: 'transaction-modified',
      payload: { transaction_id: tx.id, change, revision: tx.revision },
    });
  }
  rt.store.appendEvent(cluster.id, 'transaction-changed', { transaction_id: tx.id, change, revision: tx.revision });
  const parent = tx.parent_transaction_id ? rt.store.getTransaction(tx.parent_transaction_id) : null;
  if (parent) notifyTransactionModified(rt, cluster, actor, parent, `child-${change}`, seen);
}

function detectCycle(rt, clusterId, txId, dependencyId) {
  if (txId === dependencyId) fail('Transaction cannot depend on itself', 409);
  const edges = new Map();
  for (const row of rt.store.allDependencies(clusterId)) {
    const list = edges.get(row.transaction_id) ?? [];
    list.push(row.depends_on);
    edges.set(row.transaction_id, list);
  }
  const added = edges.get(txId) ?? [];
  edges.set(txId, [...new Set([...added, dependencyId])]);
  const queue = [dependencyId];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === txId) fail('Dependency cycle detected', 409);
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(edges.get(current) ?? []));
  }
}

function pauseDependents(rt, cluster, tx) {
  for (const dependentId of rt.store.dependentsOf(tx.id)) {
    const dependent = rt.store.getTransaction(dependentId);
    if (!dependent || TRANSACTION_TERMINAL.has(dependent.status)) continue;
    if (dependent.status === 'PAUSED') continue;
    rt.store.updateTransaction(dependent.id, { status: 'PAUSED', validation: null });
    rt.store.appendEvent(cluster.id, 'downstream-paused', { transaction_id: dependent.id, because_of: tx.id });
  }
}

// ------------------------------------------------------------------ handlers

export const HANDLERS = {
  // ------------------------------------------------------------ orchestrator
  create_transaction(rt, cluster, actor, params) {
    if (typeof params.objective !== 'string' || !params.objective.trim()) fail('params.objective is required');
    const node = assertDomain(rt, cluster, actor, actor.node_id ?? params.node_id);
    const tx = rt.createTransactionInternal(cluster.id, node, {
      objective: params.objective,
      inputs: params.inputs,
      constraints: params.constraints,
      expected_output: params.expected_output,
      acceptance_criteria: Array.isArray(params.acceptance_criteria) ? params.acceptance_criteria : params.acceptance_criteria === undefined ? [] : [params.acceptance_criteria],
      capabilities: params.capabilities,
      priority: params.priority,
      parent_transaction_id: params.parent_transaction_id ?? null,
    }, { parent: params.parent_transaction_id ?? null, local: false });
    rt.store.appendEvent(cluster.id, 'transaction-created', { transaction_id: tx.id, node_id: node.id, parent: params.parent_transaction_id ?? null });
    return { transaction_id: tx.id, revision: tx.revision, status: tx.status };
  },

  decompose(rt, cluster, actor, params) {
    const parent = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (['ACCEPTED', 'CANCELLED', 'SUPERSEDED'].includes(parent.status)) fail(`cannot decompose a ${parent.status} transaction`, 409);
    if (!Array.isArray(params.children) || !params.children.length || params.children.length > 64) fail('decompose requires 1..64 children');
    const node = nodeOf(rt, parent.node_id);
    const created = [];
    for (const child of params.children) {
      const tx = rt.createTransactionInternal(cluster.id, node, {
        objective: child.objective, inputs: child.inputs, constraints: child.constraints,
        expected_output: child.expected_output, acceptance_criteria: child.acceptance_criteria ?? [],
        capabilities: child.capabilities ?? parent.capabilities, priority: child.priority,
        parent_transaction_id: parent.id,
      }, { parent: parent.id, local: false });
      created.push(tx);
    }
    for (const [index, child] of (params.children ?? []).entries()) {
      const deps = [];
      for (const ref of child.depends_on ?? []) {
        if (Number.isInteger(ref)) {
          if (ref < 0 || ref >= created.length) fail(`child depends_on index ${ref} is out of range`);
          deps.push(created[ref].id);
        } else deps.push(String(ref));
      }
      for (const index2 of child.after ?? []) {
        if (!Number.isInteger(index2) || index2 < 0 || index2 >= created.length) fail(`child after index ${index2} is out of range`);
        deps.push(created[index2].id);
      }
      for (const dep of deps) {
        detectCycle(rt, cluster.id, created[index].id, dep);
        rt.store.addDependency(created[index].id, dep);
      }
    }
    rt.store.appendEvent(cluster.id, 'decomposed', { parent: parent.id, children: created.map(tx => tx.id) });
    notifyTransactionModified(rt, cluster, actor, rt.store.getTransaction(parent.id), 'decomposed');
    return { parent_transaction_id: parent.id, children: created.map(tx => ({ transaction_id: tx.id, revision: tx.revision })) };
  },

  set_dependency(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    const rawAdd = params.depends_on ?? params.after ?? params.needs ?? [];
    const add = Array.isArray(rawAdd) ? rawAdd : [rawAdd];
    const remove = Array.isArray(params.remove) ? params.remove : params.remove === undefined ? [] : [params.remove];
    for (const dep of remove) rt.store.removeDependency(tx.id, dep);
    for (const dep of add) {
      if (dep === undefined || dep === null || dep === '') continue;
      const other = txOf(rt, dep);
      if (other.cluster_id !== cluster.id) fail('Dependency belongs to another cluster', 403);
      detectCycle(rt, cluster.id, tx.id, dep);
      rt.store.addDependency(tx.id, dep);
    }
    rt.store.appendEvent(cluster.id, 'dependency-set', { transaction_id: tx.id, add, remove });
    notifyTransactionModified(rt, cluster, actor, tx, 'dependency-set');
    return { transaction_id: tx.id, dependencies: rt.store.dependenciesOf(tx.id) };
  },

  set_priority(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (!Number.isInteger(params.priority) || Math.abs(params.priority) > 1_000_000) fail('Invalid priority');
    const updated = rt.store.updateTransaction(tx.id, { priority: params.priority });
    rt.store.appendEvent(cluster.id, 'priority-set', { transaction_id: tx.id, priority: params.priority });
    notifyTransactionModified(rt, cluster, actor, tx, 'priority-set');
    return { transaction_id: tx.id, priority: updated.priority, revision: updated.revision };
  },

  dispatch(rt, cluster, actor, params) {
    const targets = [];
    if (params.transaction_id) {
      const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
      if (TRANSACTION_TERMINAL.has(tx.status)) fail(`cannot dispatch a ${tx.status} transaction`, 409);
      targets.push(tx);
    } else {
      const nodeId = params.node_id ?? actor.node_id;
      assertDomain(rt, cluster, actor, nodeId);
      const limit = params.limit ?? 64;
      targets.push(...rt.store.listTransactions({ cluster_id: cluster.id, node_id: nodeId, status: 'DRAFT', limit }));
    }
    if (!targets.length) fail('no DRAFT transaction to dispatch', 409);
    const audits = [];
    for (const tx of targets) {
      // A correction cannot be answered by dispatching the same plan again:
      // that would reopen a Worker under the restriction the Auditor rejected.
      const unanswered = rt.store.openIssues(cluster.id, { transaction_id: tx.id, status: 'OPEN' })
        .find(issue => !rt.issueProgressed(cluster.id, issue).progressed);
      if (unanswered) fail(`transaction ${tx.id} has open issue ${unanswered.id}; revise the plan or dismiss the mistaken issue before redispatch`, 409);
      const existing = rt.store.findAudit(cluster.id, tx.id, 'plan', tx.revision);
      // Only a pending audit can supervise a new dispatch. A previously
      // approved/rejected audit is history, even when its issue was dismissed.
      const audit = existing?.decision === 'PENDING' ? existing : rt.store.insertAudit({
        id: randomUUID(), cluster_id: cluster.id, transaction_id: tx.id, node_id: tx.node_id,
        kind: 'plan', target_revision: tx.revision, decision: 'PENDING', evidence: { requested_by: actor.agent_id ?? null },
      });
      audits.push({ audit_id: audit.id, transaction_id: tx.id, target_revision: tx.revision, decision: audit.decision });
      // The Orchestrator owns transactions, so *it* makes the plan dispatchable:
      // the plan audit is observational supervision, not a gate. The Auditor
      // keeps its corrective authority (a rejection pulls the transaction back),
      // but a silent or slow Auditor no longer freezes the whole subtree.
      setStatus(rt, rt.store.getTransaction(tx.id), 'READY');
      rt.store.appendEvent(cluster.id, 'dispatched', { transaction_id: tx.id, audit_id: audit.id, revision: tx.revision });
      rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, 'allocator')?.id, {
        subject: 'plan-dispatched', payload: { transaction_id: tx.id, revision: tx.revision },
      });
      rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, 'auditor')?.id, {
        subject: 'plan-audit-requested', payload: { audit_id: audit.id, transaction_id: tx.id },
      });
    }
    return { audits, dispatched: targets.map(tx => tx.id) };
  },

  adjust_transaction(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (TRANSACTION_TERMINAL.has(tx.status)) fail(`cannot adjust a ${tx.status} transaction`, 409);
    // Revising a plan during an active Worker turn would change the revision
    // underneath its write scope and make a successfully written result
    // impossible to submit. Let that leased turn finish first.
    assertTransactionWorkerDrained(rt, tx);
    // Accept the fields directly on `params` as well as under `params.patch`:
    // both spellings are the same request, and rejecting one wastes a turn.
    const allowed = ['objective', 'inputs', 'constraints', 'expected_output', 'acceptance_criteria', 'priority', 'capabilities'];
    const patch = params.patch ?? Object.fromEntries(allowed.filter(key => params[key] !== undefined).map(key => [key, params[key]]));
    const changes = {};
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      if (key === 'acceptance_criteria' && typeof patch[key] === 'string') patch[key] = [patch[key]];
      changes[key] = key === 'capabilities' ? validateCapabilities(patch[key], 'capabilities') : patch[key];
    }
    if (!Object.keys(changes).length) {
      fail(`adjust_transaction needs at least one of ${allowed.join(', ')} — pass them directly on params or inside params.patch`);
    }
    const node = rt.store.getNode(tx.node_id);
    const contract = node?.delegated_transaction_id === tx.id ? node.scope?.delegation_contract : null;
    if (contract) {
      // The parent assigned this deliverable when it spawned the management
      // node. Its child may add checks or repair execution scope, but cannot
      // turn a denied write into a "correction" by replacing the deliverable.
      if (changes.expected_output !== undefined && contract.expected_output
        && (typeof changes.expected_output !== 'string'
          || !changes.expected_output.includes(contract.expected_output))) {
        fail(`delegated transaction ${tx.id} must retain its parent's expected output: ${contract.expected_output}`, 409);
      }
      if (changes.acceptance_criteria !== undefined
        && (!Array.isArray(changes.acceptance_criteria)
          || contract.acceptance_criteria.some(criterion => !changes.acceptance_criteria.includes(criterion)))) {
        fail(`delegated transaction ${tx.id} must retain its parent's acceptance criteria: ${JSON.stringify(contract.acceptance_criteria)}`, 409);
      }
      if (changes.inputs !== undefined && Object.hasOwn(contract, 'management_levels_remaining')) {
        if (!changes.inputs || typeof changes.inputs !== 'object' || Array.isArray(changes.inputs)
          || (changes.inputs.management_levels_remaining !== undefined
            && changes.inputs.management_levels_remaining !== contract.management_levels_remaining)) {
          fail(`delegated transaction ${tx.id} must retain its assigned management_levels_remaining=${contract.management_levels_remaining}`, 409);
        }
        changes.inputs = { ...changes.inputs, management_levels_remaining: contract.management_levels_remaining };
      }
    }
    setStatus(rt, tx, 'DRAFT');
    // The revision *must* advance: it is what an audit, a validation and a
    // stale-plan check are keyed to. Treating the adjustment as a low-level
    // write left a rejected plan at its old revision, so every re-dispatch
    // reused the auditor's original rejection and the branch could only end in
    // an escalation (measured: `transaction-adjusted` twice, revision 1 both
    // times, then `escalated`).
    const updated = bumpRevision(rt, tx, { ...changes, validation: null, plan_approved_revision: null });
    rt.store.appendEvent(cluster.id, 'transaction-adjusted', { transaction_id: tx.id, fields: Object.keys(changes), revision: updated.revision });
    pauseDependents(rt, cluster, tx);
    notifyTransactionModified(rt, cluster, actor, rt.store.getTransaction(tx.id), 'adjusted');
    if (changes.objective !== undefined) {
      // The unit of work's goal changed: the roles that plan, fund and supervise
      // it must hear it as a goal change, not only as an edit.
      rt.store.appendEvent(cluster.id, 'goal-changed', { transaction_id: tx.id, revision: updated.revision });
      for (const role of ['orchestrator', 'allocator', 'auditor']) {
        rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, role)?.id, {
          subject: 'goal-changed', payload: { transaction_id: tx.id, revision: updated.revision },
        });
      }
    }
    return { transaction_id: tx.id, revision: updated.revision, changed: Object.keys(changes) };
  },

  validate(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (tx.status !== 'SUBMITTED') fail(`transaction ${tx.id} is ${tx.status}; only SUBMITTED results are validated`, 409);
    // A parent's own result cannot be accepted while the work it delegated is open:
    // the child results are part of the artifact, and accepting early is how a branch
    // was closed on a result that could not exist yet.
    if (params.accepted === true) {
      const open = rt.store.parentsAwaitingChildren(cluster.id).includes(tx.id);
      if (open) {
        fail(`${tx.id} has delegated work still unfinished; aggregate the child results or replan before accepting it`, 409);
      }
    }
    if (typeof params.accepted !== 'boolean') fail('validate requires accepted: boolean');
    const checks = validateChecks(params.checks);
    if (params.accepted && checks.length === 0) {
      fail('an accepted validation must carry at least one check, each with criterion, passed and evidence: params.checks = [{"criterion": "...", "passed": true, "evidence": "..."}]');
    }
    if (params.accepted && checks.every(check => !check.evidence)) {
      fail('every accepted check needs concrete evidence (a tool result, a file hash, a command exit code or a source)');
    }
    const updated = bumpRevision(rt, tx, {
      validation: { checks, accepted: params.accepted, notes: params.notes ?? '', at: rt.timestamp(), by: actor.agent_id ?? null },
      result_revision: null,
    });
    const revision = updated.revision;
    setStatus(rt, rt.store.getTransaction(tx.id), 'VALIDATING');
    rt.store.updateTransaction(tx.id, { result_revision: revision, __bump_revision: false });
    const audit = rt.store.insertAudit({
      id: randomUUID(), cluster_id: cluster.id, transaction_id: tx.id, node_id: tx.node_id,
      kind: 'validation', target_revision: revision, decision: 'PENDING',
      evidence: { proposed_by: actor.agent_id ?? null, accepted: params.accepted, checks },
    });
    if (!params.accepted) {
      rt.store.decideAudit(audit.id, 'OVERRIDDEN', actor.agent_id ?? null, { reason: 'orchestrator rejected its own proposal' });
      setStatus(rt, rt.store.getTransaction(tx.id), 'REJECTED');
    }
    rt.store.appendEvent(cluster.id, 'validation-proposed', {
      transaction_id: tx.id, result_revision: revision, accepted: params.accepted, checks: checks.length,
    });
    rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, 'auditor')?.id, {
      subject: 'validation-audit-requested', payload: { audit_id: audit.id, transaction_id: tx.id, target_revision: revision },
    });
    return { transaction_id: tx.id, result_revision: revision, audit_id: audit.id, status: rt.store.getTransaction(tx.id).status };
  },

  accept_result(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (tx.status !== 'VALIDATING') fail(`transaction ${tx.id} is ${tx.status}; nothing to accept`, 409);
    const audit = rt.store.findAudit(cluster.id, tx.id, 'validation', tx.result_revision);
    if (!audit || audit.decision !== 'APPROVED') fail('auditor approval for this result revision is still missing', 409);
    return acceptTransaction(rt, cluster, tx);
  },

  reject_result(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (!['SUBMITTED', 'VALIDATING'].includes(tx.status)) fail(`transaction ${tx.id} is ${tx.status}; nothing to reject`, 409);
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: tx.revision,
      severity: params.severity ?? 'MAJOR', evidence: params.evidence ?? { reason: params.reason ?? '' },
      required_change: params.required_change ?? params.reason ?? 'substantiate the result against the acceptance criteria',
    });
    setStatus(rt, tx, 'REJECTED');
    const approval = rt.store.findAudit(cluster.id, tx.id, 'validation', tx.result_revision);
    if (approval && approval.decision === 'PENDING') rt.store.decideAudit(approval.id, 'OVERRIDDEN', actor.agent_id ?? null, { reason: 'orchestrator rejected the result' });
    return { transaction_id: tx.id, issue_id: issue.id, status: 'REJECTED' };
  },

  aggregate(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    // Reaggregating a submitted or validating parent replaces its result
    // revision while the Auditor is deciding it, stranding a chain of stale
    // audits and repeatedly waking the Orchestrator.
    if (tx.status !== 'READY') fail(`cannot aggregate a ${tx.status} transaction; only READY parents can publish their result`, 409);
    const children = rt.store.childrenOfTransaction(cluster.id, tx.id);
    if (!children.length) fail('aggregate requires child transactions', 409);
    const pending = children.filter(child => child.status !== 'ACCEPTED');
    if (pending.length) fail(`cannot aggregate: ${pending.length} child transactions are not ACCEPTED`, 409);
    const childSummaries = children.map(child => {
      const stored = rt.store.latestSummary(cluster.id, { transaction_id: child.id });
      return stored ? stored.data : { transaction_id: child.id, conclusion: summariseResult(child.result) };
    });
    const result = {
      kind: 'aggregate',
      children: childSummaries,
      summary: params.summary ?? `all ${children.length} child transactions accepted`,
    };
    // An aggregate is the parent's own run: it moves through RUNNING as any other
    // execution does, because the transition table has no READY → SUBMITTED. The
    // status is read fresh — the caller's row is a snapshot, and acting on it skipped
    // the intermediate transition while `setStatus` checked the live one.
    // Work on a snapshot that reflects the live row: `setTransactionStatus` asserts the
    // transition from `tx.status`, so a stale snapshot makes the intermediate step a
    // no-op and the next one illegal.
    let live = rt.store.getTransaction(tx.id);
    if (live.status === 'READY') live = setStatus(rt, live, 'RUNNING');
    setStatus(rt, live, 'SUBMITTED');
    // A published aggregate is a new result at a new revision, exactly as a
    // worker's submission is: `setStatus` deliberately does not advance the
    // revision, so the write below must.
    const updated = bumpRevision(rt, tx, { result, validation: null });
    rt.store.appendEvent(cluster.id, 'aggregated', { transaction_id: tx.id, children: children.length, revision: updated.revision });
    return { transaction_id: tx.id, revision: updated.revision, children: children.length, status: 'SUBMITTED' };
  },

  escalate(rt, cluster, actor, params) {
    if (params.node_id) {
      const node = assertDomain(rt, cluster, actor, params.node_id);
      rt.blockNodeInternal(cluster.id, node.id, params.reason ?? 'escalated');
      // An escalated branch cannot produce its work any more: its unfinished
      // transactions would otherwise sit DRAFT for ever, invisible to every
      // completion check and to the human reading the escalation.
      const pending = rt.store.listTransactions({
        cluster_id: cluster.id, node_id: node.id, status: 'DRAFT', limit: 64,
      }).concat(rt.store.listTransactions({ cluster_id: cluster.id, node_id: node.id, status: 'READY', limit: 64 }));
      rt.store.tx(() => {
        for (const tx of pending) {
          rt.store.updateTransaction(tx.id, { status: 'BLOCKED' });
          rt.store.appendEvent(cluster.id, 'transaction-blocked', {
            transaction_id: tx.id, node_id: node.id, reason: `escalated with its node: ${String(params.reason ?? '').slice(0, 200)}`,
          });
        }
      });
      return { node_id: node.id, status: rt.store.getNode(node.id).status, blocked_transactions: pending.length };
    }
    const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    // A parent still owes its delegated result while a descendant can act.
    // Escalating it first hides a live correction round (observed: the depth-1
    // branch was blocked while the depth-3 Orchestrator was revising a rejected
    // result). A failed or blocked descendant is an actual reason to escalate;
    // DRAFT/READY/REJECTED/SUBMITTED descendants are not.
    const unfinished = transactionSubtree(rt, cluster.id, tx.id).slice(1)
      .map(id => rt.store.getTransaction(id))
      .find(child => child && !['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED'].includes(child.status));
    if (unfinished) fail(`delegated child ${unfinished.id} is still ${unfinished.status}; let its local correction finish before escalating ${tx.id}`, 409);
    setStatus(rt, tx, 'BLOCKED');
    rt.store.appendEvent(cluster.id, 'escalated', { transaction_id: tx.id, reason: params.reason ?? '' });
    const node = nodeOf(rt, tx.node_id);
    if (!node.parent_id) rt.blockClusterInternal(cluster.id, params.reason ?? `transaction ${tx.id} escalated at root`);
    else rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, node.parent_id, 'orchestrator')?.id, { subject: 'escalation', payload: { transaction_id: tx.id, reason: params.reason ?? '' } });
    return { transaction_id: tx.id, status: 'BLOCKED' };
  },

  finish_cluster(rt, cluster, actor) {
    const root = assertDomain(rt, cluster, actor, actor.node_id);
    if (root.parent_id) fail('only the root Orchestrator may finish the cluster', 403);
    if (cluster.status !== 'RUNNING') fail(`cluster is ${cluster.status}; cannot finish`, 409);
    const total = rt.store.countTransactions(cluster.id, { parent_transaction_id: null });
    const accepted = rt.store.countTransactions(cluster.id, {
      parent_transaction_id: null, status: ['ACCEPTED'],
    });
    if (!total || accepted !== total) fail(`all root transactions must be ACCEPTED before finishing (${accepted}/${total})`, 409);
    const requested = rt.store.get(
      "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
      cluster.id, root.id,
    );
    if (!requested) rt.store.appendEvent(cluster.id, 'cluster-finish-requested', { node_id: root.id, transactions: total });
    return { node_id: root.id, transactions: total, finish_requested: true };
  },

  // --------------------------------------------------------------- allocator
  allocate_agent(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    let targets = [];
    if (params.transaction_id) targets = [assertTransactionDomain(rt, cluster, actor, params.transaction_id)];
    else if (Array.isArray(params.transactions)) targets = params.transactions.map(id => assertTransactionDomain(rt, cluster, actor, id));
    else targets = rt.store.listTransactions({ cluster_id: cluster.id, node_id: node.id, status: 'READY', limit: normalizeLimit(params.limit, 32, 128) });
    const results = [];
    for (const tx of targets) {
      const created = createWorkerForTransaction(rt, cluster, actor, node, tx, params);
      results.push({ transaction_id: tx.id, agent_id: created.agent.id, allocation_id: created.allocation.id, deduped: created.deduped ?? false });
    }
    return { allocations: results, count: results.length };
  },

  spawn_agent(rt, cluster, actor, params) {
    if (!params.transaction_id) fail('spawn_agent requires a transaction_id');
    return HANDLERS.allocate_agent(rt, cluster, actor, { ...params, transactions: undefined, node_id: params.node_id });
  },

  spawn_management_node(rt, cluster, actor, params) {
    const parentTx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    const parentNode = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    const limits = cluster.limits;
    const children = rt.store.childrenOf(parentNode.id);
    const childLimit = parentNode.max_children ?? limits.max_children;
    if (children.length >= childLimit) fail(`node ${parentNode.id} reached max_children ${childLimit}`, 409);
    if (parentNode.depth + 1 > limits.max_depth) fail(`depth limit ${limits.max_depth} reached`, 409);

    // The topology fixture is authoritative. When the node still owes a
    // delegation, the *instruction's* remaining depth wins over whatever number
    // the caller passed: a model that repeats `spawn_children: 1` at every level
    // would otherwise either stop the chain early or never let it end.
    const owed = rt.pendingDelegationInstruction(cluster, parentNode);
    const spawnBudget = owed ? (owed.spawn_children ?? 0) : (params.spawn_children ?? 0);
    // A management node at the depth cap cannot execute: its roles' Worker would need a
    // node one level deeper, which `createWorkerForTransaction` refuses. Refusing the
    // spawn names the fact (measured: a depth-4 terminal node with `max_depth: 4` and zero
    // allocations while its transactions sat READY, so the artifact could never be written
    // by the branch that owed it).
    if (parentNode.depth + 1 >= limits.max_depth) {
      fail(`a management node at depth ${parentNode.depth + 1} could not run a Worker: max_depth is ${limits.max_depth}, so its roles would have no identity to allocate. Delegate no deeper, or raise max_depth deliberately.`, 409);
    }
    const scope = params.scope ?? { objective: owed?.objective ?? parentTx.objective.slice(0, 400) };
    const node = rt.store.insertNode({
      id: randomUUID(), cluster_id: cluster.id, parent_id: parentNode.id, kind: 'management',
      depth: parentNode.depth + 1, status: 'ACTIVE',
      scope: typeof scope === 'string' ? { objective: scope.slice(0, 400) } : scope,
      capabilities: validateCapabilities(params.capabilities ?? parentTx.capabilities ?? cluster.capabilities, 'node.capabilities'),
      path: `${parentNode.path}.${children.length}`, max_children: params.max_children ?? limits.max_children,
    });
    const parentBudget = rt.store.budgetForScope(cluster.id, 'node', parentNode.id);
    // Delegation is atomic: a node whose roles cannot start has not been
    // created. The caller can rebalance this parent and retry without leaving
    // an inert subtree or a transaction that can never reach a Worker.
    const nodeBudget = createBudget(rt.store, {
      cluster_id: cluster.id, scope_kind: 'node', scope_id: node.id, node_id: node.id,
      parent_budget_id: parentBudget?.id ?? null, limit: {}, wall_limit_ms: params.wall_limit_ms ?? 0,
    });
    if (parentBudget) {
      const remainingSlots = Math.max(1, (parentNode.max_children ?? cluster.limits.max_children) - children.length);
      const grant = params.budget ? { ...params.budget } : shareOf(parentBudget, remainingSlots);
      const levels = Math.min(Math.max(1, spawnBudget || 1),
        Math.max(1, limits.max_depth - parentNode.depth - 1));
      // Each remaining management level needs three identities, and the leaf
      // needs one Worker. A fixed one-wave allotment loses the last Worker
      // three levels down even when the cluster still has free agent capacity.
      if (cluster.limits?.max_agents) {
        const need = 3 * levels + 1;
        const available = dimensionAvailable(parentBudget, 'agents');
        if (available < need) fail(`cannot fund delegated management roles and Worker: needs ${need} agents, only ${available} available`, 409);
        const wave = 3 + Math.max(1, Number(cluster.limits.max_active_agents) || 1);
        grant.agents = Math.max(Number(grant.agents) || 0, Math.min(Math.max(wave, need), available));
      }
      // The same rule for the dimensions a node's own roles spend: a share of
      // what is left over can be one request or none at all, and a node created
      // with a single request cannot run its orchestrator, allocator and auditor
      // once between them. Measured: a depth-2 node held `requests_limit` 1 and
      // the deepest 0, so the branch the case exists to extend was refused on
      // `model_requests` while the run had 64% of its requests unspent.
      // Two rules, both grounded in what was measured rather than in the case's
      // ceilings:
      //
      //  * a node must be able to run its three roles for a *working* number of
      //    turns at this deployment's cost (~10 requests and ~13 k tokens per role
      //    turn, measured: 188 role requests for 18 turns), or nothing in its
      //    subtree can happen at all — a depth-2 node was created with 5 requests
      //    and 6,172 tokens and could not spawn the level below it; and
      //  * the parent must keep the same working amount for its own roles: a
      //    parent that hands everything to its children cannot run the turn that
      //    would dispatch them — measured: the root node's request file fell to 59
      //    while its three children held ~100 each, and 150 requests were refused
      //    against the parent's slice.
      //
      // `max_role_turns` is a ceiling (24 in the recursion case), not observed work,
      // so it sizes neither rule; the *structural* share is the natural cap, and
      // what the parent can spare is the hard one. More can always be granted
      // later, by the Allocator, explicitly.
      const workingTurns = Math.min(3, Math.max(1, Number(cluster.limits?.max_role_turns) || 3));
      const declaredTools = Number(cluster.spec?.budget?.tool_calls ?? cluster.budget?.tool_calls ?? 0) || 0;
      const declaredTokens = Number(cluster.spec?.budget?.tokens ?? cluster.budget?.tokens ?? 0) || 0;
      const declaredRequests = Number(cluster.spec?.budget?.model_requests ?? cluster.budget?.model_requests ?? 0) || 0;
      // Eight is the topology the recursion case builds — the root, its children and a
      // delegated chain — so an even split of the *declared* tool budget is a deliberately
      // generous per-node allowance that still leaves the root the remainder. It is what
      // keeps a deep node from being born with 0 tool calls while its roles are refused to
      // the last call (measured: node tool files of 433, 69, 0 and 122 against a declared
      // 8,192, with agent grants spent 95/95, 62/62 and 57/57).
      const fairShareTools = declaredTools > 0 ? Math.floor(declaredTools / 8) : 0;
      const perTurn = Math.max(16_384, Number(rt.config?.context?.role ?? 8_192) * 2);
      const wave = Math.max(1, Number(cluster.limits?.max_active_agents) || 1);
      // The same fair share applies to every dimension a node's own roles and Worker wave
      // spend, not only tools: measured, a depth-3 node was created with 38,449 tokens and
      // 5 requests — enough for neither a role turn nor a Worker — and its allocator spent
      // its turns on `escalate-budget` while four transactions sat READY in the branch.
      // A working estimate is not a requirement to give *every* child most of
      // a small declared tool budget. Cap the minimum endowment at a quarter
      // of the declaration: two small branches can then be funded without
      // weakening the larger recursion case's fair-share floor.
      const toolFloor = Math.min(
        Math.max(workingTurns * 20 * 3 + wave * 16, fairShareTools),
        Math.max(4, Math.floor(declaredTools / 4)),
      );
      const tokenFloor = declaredTokens > 0 ? Math.floor(declaredTokens / 8) : 0;
      const requestFloor = declaredRequests > 0 ? Math.floor(declaredRequests / 8) : 0;
      const floor = {
        tokens: Math.max(workingTurns * perTurn * 3 + wave * perTurn, tokenFloor),
        model_requests: Math.max(workingTurns * 10 + wave * 3, requestFloor),
        // A role turn spends several tool calls (a query, an action, sometimes a
        // second look), and a wave of Workers several each: measured on a recursion
        // run, one node's tools ran out 35 times while its roles still had work to
        // do — a sizing error, not a budget.
        tool_calls: toolFloor,
      };
      // A target endowment includes several turns per role; missing it by a
      // few thousand tokens must not turn a funded branch into an inert one.
      // The hard minimum is one send/tool action for each management role and
      // a two-request Worker with its own 65,536-token grant at the leaf.
      const minimum = { tokens: 3 * perTurn + 65_536, model_requests: 5, tool_calls: 5 };
      // The parent's own roles hold most of its capacity while they are between
      // turns, and that capacity is the node's to reclaim before it funds a child —
      // in scope, no other subtree involved. Without this the parent's file looks
      // empty exactly when a child needs it (measured: the root node at 33/33
      // requests with its three roles holding 186 idle, and two depth-3 children
      // created with 5 and 3).
      rt.reclaimIdleRoleGrants(cluster.id, parentBudget.id);
      const currentParent = rt.store.getBudget(parentBudget.id);
      for (const [key, localTarget] of Object.entries(floor)) {
        const target = localTarget * levels;
        const required = minimum[key] * levels;
        const available = dimensionAvailable(currentParent, key);
        if (available < required) {
          fail(`cannot fund delegated management node: needs ${required} ${key}, only ${available} available in this parent`, 409);
        }
        const requested = Number(params.budget?.[key]) || 0;
        const structural = Number(grant[key]) || 0;
        const spare = Math.max(0, available - localTarget);
        const wanted = Math.max(requested, target, Math.min(structural, spare));
        grant[key] = Math.min(available, wanted);
      }
      rt.grantBudget(parentBudget, nodeBudget, grant);
    }
    const budgets = new Map([[node.id, nodeBudget]]);
    const roles = rt.ensureRoles(cluster.id, node, budgets);

    // A delegation chain descends one level at a time: the fixture's depth
    // budget decreases on every spawn and stops when it reaches zero.
    const spawnChildren = Number.isInteger(spawnBudget) && spawnBudget > 0 ? spawnBudget - 1 : 0;
    rt.store.updateNode(node.id, {
      scope: {
        ...(rt.store.getNode(node.id).scope ?? {}),
        spawn_children: spawnChildren,
        ...(owed
          ? {
            delegation_entry: {
              scope: owed.scope, objective: owed.objective, spawn_children: spawnChildren,
              // Everything else the instruction carries travels with it, or the
              // chain silently loses it at the first level: the fixture's write
              // scope reached child one and stopped there, which is a fault injected
              // into the wrong node.
              ...(owed.inputs ? { inputs: owed.inputs } : {}),
              ...(owed.max_children !== undefined ? { max_children: owed.max_children } : {}),
            },
          }
          : {}),
      },
    });
    const delegated = rt.createTransactionInternal(cluster.id, node, {
      // The delegation entry, not the root's topological instruction, names
      // this node's work. At the leaf a Worker otherwise inherits "create
      // another management node" even though the chain already reached zero.
      objective: params.objective ?? owed?.objective ?? parentTx.objective,
      expected_output: params.expected_output ?? parentTx.expected_output,
      // The remaining level count is control data: the fixture owns it at every
      // spawn. Keep the injected write scope alongside it, so a Worker with a
      // real restriction can report the restriction instead of inventing work.
      inputs: owed
        ? { ...(params.inputs ?? owed.inputs ?? { parent_transaction_id: parentTx.id }), management_levels_remaining: spawnChildren }
        : params.inputs ?? { parent_transaction_id: parentTx.id },
      acceptance_criteria: params.acceptance_criteria ?? parentTx.acceptance_criteria,
      capabilities: node.capabilities,
      parent_transaction_id: parentTx.id,
      priority: parentTx.priority,
    }, { parent: parentTx.id, local: false });
    rt.store.updateNode(node.id, {
      delegated_transaction_id: delegated.id,
      scope: {
        ...rt.store.getNode(node.id).scope,
        delegation_contract: {
          expected_output: delegated.expected_output,
          ...(owed ? { management_levels_remaining: spawnChildren } : {}),
          acceptance_criteria: delegated.acceptance_criteria,
        },
      },
    });
    rt.store.updateTransaction(delegated.id, { owner_management_id: node.id, node_id: node.id });
    rt.store.appendEvent(cluster.id, 'management-node-spawned', {
      node_id: node.id, parent: parentNode.id, delegated_transaction_id: delegated.id, roles,
    });
    return {
      node_id: node.id, depth: node.depth, roles, delegated_transaction_id: delegated.id,
      budget: budgetView(rt.store.getBudget(nodeBudget.id)),
    };
  },

  release_agent(rt, cluster, actor, params) {
    const results = [];
    if (!params.all && !params.agent_id && !params.allocation_id && !Array.isArray(params.allocations)) {
      fail('release_agent requires allocations, allocation_id, agent_id or all');
    }
    if (params.all) {
      const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
      for (const allocation of rt.store.allocationsForNode(node.id, { status: 'ACTIVE' })) {
        assertAllocationTurnDrained(rt, allocation);
        results.push(releaseAllocation(rt, cluster, allocation, params.reason));
      }
      return { released: results };
    }
    const ids = params.allocations ?? (params.allocation_id ? [params.allocation_id] : []);
    for (const id of ids) {
      const allocation = rt.store.getAllocation(id);
      if (!allocation) fail('Allocation not found', 404);
      assertDomain(rt, cluster, actor, allocation.node_id);
      assertAllocationTurnDrained(rt, allocation);
      results.push(releaseAllocation(rt, cluster, allocation, params.reason));
    }
    if (params.agent_id) {
      const allocation = rt.store.activeAllocationForAgent(params.agent_id);
      if (!allocation) fail('Agent has no active allocation', 404);
      assertDomain(rt, cluster, actor, allocation.node_id);
      assertAllocationTurnDrained(rt, allocation);
      results.push(releaseAllocation(rt, cluster, allocation, params.reason));
    }
    if (!results.length) fail('release_agent requires allocations, allocation_id, agent_id or all');
    return { released: results };
  },

  allocate_budget(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    const from = rt.store.budgetForScope(cluster.id, 'node', node.id);
    if (!from) fail('Node budget not found', 404);
    const scope = params.scope ?? {};
    const targetId = scope.id ?? params.scope_id ?? params.agent_id ?? params.agent ?? params.target_id;
    const kind = scope.kind ?? params.scope_kind ?? (params.agent_id || params.agent ? 'agent' : 'agent');
    if (!targetId) {
      fail('allocate_budget needs a target scope: params.scope = {"kind":"agent"|"node"|"transaction","id":"<scope id>"} (or params.agent_id)');
    }
    const to = rt.store.budgetForScope(cluster.id, kind, targetId);
    if (!to) fail(`no ${kind} budget exists for ${targetId}; allocate an agent for a transaction first, or name a node id`, 404);
    void node;
    if (lineageIds(rt.store, to).includes(from.id) === false && to.parent_budget_id !== from.id) {
      fail('budget target is not inside this domain', 403);
    }
    const amounts = params.amounts ?? params.budget ?? params.metrics ?? {};
    const normalised = normaliseAmounts(amounts);
    applyBudgetGrant(rt, from, to, normalised);
    rt.store.appendEvent(cluster.id, 'budget-allocated', { from: from.id, to: to.id, amounts: normalised });
    return { budget: budgetView(rt.store.getBudget(to.id)) };
  },

  rebalance_budget(rt, cluster, actor, params) {
    const from = resolveBudget(rt, cluster, params.from);
    const to = resolveBudget(rt, cluster, params.to);
    assertDomain(rt, cluster, actor, from.node_id ?? actor.node_id);
    const normalised = normaliseAmounts(params.amounts ?? params.budget ?? params.metrics ?? {});
    applyBudgetGrant(rt, from, to, normalised);
    rt.store.appendEvent(cluster.id, 'budget-rebalanced', { from: from.id, to: to.id, amounts: normalised });
    return { from: budgetView(rt.store.getBudget(from.id)), to: budgetView(rt.store.getBudget(to.id)) };
  },

  set_concurrency(rt, cluster, actor, params) {
    assertDomain(rt, cluster, actor, actor.node_id);
    const limits = { ...cluster.limits };
    // The declared envelope is a ceiling: a run must stay comparable to the
    // limits the acceptance fixture set, so a request above them is clamped and
    // recorded rather than quietly widening what is being measured.
    const declared = rt.store.declaredLimits(cluster.id);
    const clamp = (key, value) => {
      if (value === undefined) return undefined;
      const ceiling = declared[key];
      if (ceiling === undefined || value <= ceiling) return value;
      rt.store.appendEvent(cluster.id, 'limit-clamped', {
        agent_id: actor.agent_id ?? null, key, requested: value, declared: ceiling,
      });
      return ceiling;
    };
    if (params.max_active_agents !== undefined) {
      if (!Number.isInteger(params.max_active_agents) || params.max_active_agents < 1 || params.max_active_agents > 512) fail('Invalid max_active_agents');
      limits.max_active_agents = clamp('max_active_agents', params.max_active_agents);
    }
    if (params.max_llm_concurrency !== undefined) {
      if (!Number.isInteger(params.max_llm_concurrency) || params.max_llm_concurrency < 1 || params.max_llm_concurrency > 64) fail('Invalid max_llm_concurrency');
      limits.max_llm_concurrency = clamp('max_llm_concurrency', params.max_llm_concurrency);
      rt.setLlmConcurrency(limits.max_llm_concurrency);
    }
    rt.store.updateCluster(cluster.id, { limits });
    rt.store.appendEvent(cluster.id, 'concurrency-set', { limits });
    return { limits };
  },

  scale_out(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    const ready = rt.store.listTransactions({ cluster_id: cluster.id, node_id: node.id, status: 'READY', limit: normalizeLimit(params.count, 32, 128) });
    const results = [];
    for (const tx of ready) results.push(createWorkerForTransaction(rt, cluster, actor, node, tx, params));
    rt.store.appendEvent(cluster.id, 'scaled-out', { node_id: node.id, count: results.length });
    return { node_id: node.id, allocations: results.map(r => ({ transaction_id: r.allocation.transaction_id, agent_id: r.agent.id })) };
  },

  scale_in(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    const count = params.count ?? 1;
    const candidates = rt.store.allocationsForNode(node.id, { status: 'ACTIVE' })
      .filter(allocation => !allocation.transaction_id || ['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(rt.store.getTransaction(allocation.transaction_id)?.status ?? 'ACCEPTED'))
      .slice(0, count);
    const released = candidates.map(allocation => releaseAllocation(rt, cluster, allocation, 'scale_in'));
    rt.store.appendEvent(cluster.id, 'scaled-in', { node_id: node.id, released: released.length });
    return { node_id: node.id, released };
  },

  select_model(rt, cluster, actor, params) {
    // `model` may be a bare id or an object; both spellings name the same route.
    const spec = params.model !== null && typeof params.model === 'object' ? params.model : {};
    const model = {
      provider: params.provider ?? spec.provider,
      model: params.model_id ?? spec.model ?? params.model ?? params.id,
      ...(params.reasoning_effort === undefined && spec.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoning_effort ?? spec.reasoningEffort }),
      ...(params.max_tokens === undefined ? {} : { maxTokens: params.max_tokens }),
    };
    if (typeof model.provider !== 'string' || typeof model.model !== 'string') {
      fail('select_model needs {"provider":"<route>","model":"<model id>"} (or {"model":{"provider":...,"model":...}})');
    }
    const route = rt.config.routes?.[model.provider];
    if (!route) fail(`unknown model provider route: ${model.provider}`, 409);
    if (!route.includes(model.model)) fail(`provider ${model.provider} does not serve model ${model.model}`, 409);
    const targets = [];
    if (params.agent_id) {
      const agent = rt.store.getAgent(params.agent_id);
      if (!agent || agent.cluster_id !== cluster.id) fail('Agent not found', 404);
      assertDomain(rt, cluster, actor, agent.node_id);
      targets.push(agent);
    } else {
      const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
      targets.push(...rt.store.agentsInSubtree(cluster.id, node.id));
    }
    for (const agent of targets) rt.store.updateAgent(agent.id, { meta: { ...agent.meta, model } });
    rt.store.appendEvent(cluster.id, 'model-selected', { model, agents: targets.length });
    return { model, agents: targets.length };
  },

  evaluate_allocation(rt, cluster, actor, params = {}) {
    const node = assertDomain(rt, cluster, actor, actor.node_id);
    const budget = rt.store.budgetForScope(cluster.id, 'node', node.id);
    if (!budget) fail('Node budget not found', 404);
    // An allocation decision needs the local node's spendable capacity and
    // its funding ancestors, not every unrelated agent/transaction grant.
    // The full ledger remains available to the host via read/report.
    const budgetIds = lineageIds(rt.store, budget);
    const limit = normalizeLimit(params.limit, 6, 6);
    const offset = Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const budgets = budgetIds.slice(offset, offset + limit).map(id => {
      const row = rt.store.getBudget(id);
      const view = budgetView(row);
      return {
        id: row.id, scope_kind: row.scope_kind, scope_id: row.scope_id,
        node_id: row.node_id, parent_budget_id: row.parent_budget_id,
        available: Object.fromEntries(DIMENSIONS.map(dim => [dim.key, view[dim.key].available])),
        effective_deadline: effectiveDeadline(rt.store, row),
      };
    });
    const agents = rt.store.agentsInSubtree(cluster.id, null);
    const active = rt.store.allocationsInSubtree(cluster.id, null, { status: 'ACTIVE' });
    const allocations = node.parent_id ? rt.store.allocationsInSubtree(cluster.id, node.id, { status: 'ACTIVE' }) : active;
    const allocationPage = allocations.slice(offset, offset + limit);
    return {
      budgets, budgets_total: budgetIds.length,
      budgets_next_offset: offset + budgets.length < budgetIds.length ? offset + budgets.length : null,
      allocations: allocationPage.map(allocation => ({
        allocation_id: allocation.id, agent_id: allocation.agent_id, node_id: allocation.node_id,
        transaction_id: allocation.transaction_id, write_scope: allocation.write_scope,
      })),
      allocations_total: allocations.length,
      allocations_next_offset: offset + allocationPage.length < allocations.length
        ? offset + allocationPage.length : null,
      capacity: {
        max_agents: cluster.limits.max_agents, max_active_agents: cluster.limits.max_active_agents,
        live_agents: agents.filter(agent => agent.status !== 'TERMINATED').length,
        active_allocations: active.length,
        in_flight: rt.inFlight(cluster.id),
      },
    };
  },

  replace_agent(rt, cluster, actor, params) {
    const allocation = rt.store.getAllocation(params.allocation_id) ?? rt.store.activeAllocationForAgent(params.agent_id);
    if (!allocation) fail('Allocation not found', 404);
    assertDomain(rt, cluster, actor, allocation.node_id);
    const oldAgent = rt.store.getAgent(allocation.agent_id);
    assertAllocationTurnDrained(rt, allocation);
    rt.store.updateAgent(allocation.agent_id, { status: 'TERMINATED' });
    const replacement = rt.store.insertAgent({
      id: randomUUID(), cluster_id: cluster.id, node_id: oldAgent.node_id, role: oldAgent.role,
      session_id: randomUUID(), status: 'READY', capabilities: oldAgent.capabilities, cwd: cluster.workspace,
      meta: { ...oldAgent.meta, replaced: oldAgent.id },
    });
    const nodeBudget = rt.store.budgetForScope(cluster.id, 'node', allocation.node_id);
    if (nodeBudget) {
      // The replacement inherits the same allocation, not a second worker
      // slot. Return the retired identity's unused grant before funding it.
      reclaimUnusedAgentGrant(rt, cluster.id, oldAgent.id, nodeBudget);
      rt.grantAgentBudget(cluster.id, rt.store.getNode(oldAgent.node_id), nodeBudget, replacement, oldAgent.role);
    }
    rt.store.updateAllocation(allocation.id, { agent_id: replacement.id });
    rt.store.appendEvent(cluster.id, 'agent-replaced', { allocation_id: allocation.id, from: oldAgent.id, to: replacement.id });
    return { allocation_id: allocation.id, agent_id: replacement.id, replaced: oldAgent.id };
  },

  reassign_agent(rt, cluster, actor, params) {
    const agent = rt.store.getAgent(params.agent_id);
    if (!agent || agent.cluster_id !== cluster.id) fail('Live agent not found', 409);
    const allocation = rt.store.activeAllocationForAgent(agent.id);
    if (!allocation || allocation.cluster_id !== cluster.id) fail('Agent has no active allocation', 404);
    assertDomain(rt, cluster, actor, allocation.node_id);
    assertAllocationTurnDrained(rt, allocation);
    if (agent.status !== 'READY') fail(`Agent ${agent.id} is ${agent.status}; reassignment requires READY`, 409);
    const source = rt.store.getTransaction(allocation.transaction_id);
    if (!source || source.status !== 'READY' || source.node_id !== allocation.node_id) {
      fail(`source transaction ${allocation.transaction_id} must be READY in the allocation's owner domain`, 409);
    }
    if (rt.store.allocationOutdated(cluster.id, allocation)) fail('source allocation predates its transaction revision', 409);
    const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    if (tx.status !== 'READY' || tx.node_id !== allocation.node_id
      || tx.owner_management_id !== source.owner_management_id) {
      fail(`target transaction ${tx.id} must be READY in the same owner domain`, 409);
    }
    if (rt.store.activeAllocationForTransaction(tx.id)) fail('transaction already has an active allocation', 409);
    if (!firstNonEmpty(tx.capabilities).every(capability => agent.capabilities.includes(capability))) {
      fail(`agent ${agent.id} does not satisfy transaction ${tx.id} capabilities`, 409);
    }
    const oldScope = allocation.write_scope_canonical ?? canonicalScope(cluster.workspace, allocation.write_scope);
    if (oldScope === null) fail('existing allocation write scope cannot be resolved', 409);
    const restricted = Object.hasOwn(tx.inputs ?? {}, 'write_scope')
      ? validateWriteScope(tx.inputs.write_scope, 'inputs.write_scope') : null;
    const targetScope = restricted === null ? null : canonicalScope(cluster.workspace, restricted);
    if (targetScope === null && restricted !== null) fail('target write scope cannot be resolved', 409);
    const scope = restricted === null ? allocation.write_scope
      : oldScope.flatMap((entry, index) => {
        if (targetScope.some(parent => withinScope(entry, parent))) return [allocation.write_scope[index]];
        return restricted.filter((_, targetIndex) => withinScope(targetScope[targetIndex], entry));
      });
    if (targetScope?.length && !scope.length) fail(`target transaction ${tx.id} is outside the allocation write scope`, 409);
    const canonical = canonicalScope(cluster.workspace, scope);
    if (canonical === null || canonical.some(entry => !oldScope.some(parent => withinScope(entry, parent)))) {
      fail(`reassigning ${tx.id} would widen the allocation write scope`, 409);
    }
    const updated = rt.store.updateAllocation(allocation.id, {
      transaction_id: tx.id, write_scope: scope, write_scope_canonical: canonical,
    });
    rt.store.appendEvent(cluster.id, 'agent-allocated', {
      agent_id: agent.id, node_id: allocation.node_id, transaction_id: tx.id,
      revision: tx.revision, write_scope: scope, capabilities: updated.capabilities, reassign: true,
    });
    rt.store.appendEvent(cluster.id, 'agent-reassigned', {
      allocation_id: allocation.id, agent_id: agent.id, from: source.id, transaction_id: tx.id, revision: tx.revision,
    });
    return { allocation_id: allocation.id, agent_id: agent.id, transaction_id: tx.id };
  },

  /**
   * Move a management subtree under a new parent.
   *
   * Two phases, deliberately: a **pre-flight** that writes nothing and aborts
   * nothing (an earlier version aborted the subtree's live turns and *then*
   * failed with 409, so a rejected request had already destroyed work), and a
   * short **commit** in one SQLite transaction that moves the tree, every
   * descendant's path and ownership, and the budget grants together.
   */
  reparent(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id);
    if (!node.parent_id) fail('the root node cannot be reparented', 409);
    const newParent = assertDomain(rt, cluster, actor, params.new_parent_id);
    if (newParent.id === node.id) fail('a node cannot be its own parent', 409);
    let cursor = newParent;
    const guard = new Set();
    while (cursor.parent_id) {
      if (guard.has(cursor.id)) fail('Management tree cycle', 409);
      guard.add(cursor.id);
      cursor = nodeOf(rt, cursor.parent_id);
      if (cursor.id === node.id) fail('cannot reparent a node under its own descendant', 409);
    }
    // ---- pre-flight: read-only, exhaustive, and side-effect free ----
    const subtree = rt.store.nodesInSubtree(cluster.id, node.id);
    const subtreeIds = new Set(subtree.map(member => member.id));
    const subtreeDepth = Math.max(...subtree.map(member => member.depth - node.depth));
    if (newParent.depth + 1 + subtreeDepth > cluster.limits.max_depth) fail(`reparent would exceed max_depth ${cluster.limits.max_depth}`, 409);
    const newSiblings = rt.store.childrenOf(newParent.id);
    const limit = newParent.max_children ?? cluster.limits.max_children;
    if (newSiblings.length + 1 > limit) fail(`new parent reached max_children ${limit}`, 409);

    const agents = rt.store.agentsInSubtree(cluster.id, node.id);
    for (const agent of agents) {
      const turn = rt.activeTurnFor(agent.id);
      // The initiator must not be inside the subtree it is draining: aborting
      // its own turn executes the abort before the failure is reported.
      if (turn && agent.id === actor.agent_id) {
        fail('cannot reparent a subtree that contains the turn requesting the move', 409);
      }
      if (turn) fail(`cannot reparent while ${agent.id} is executing; retry after the drain completes`, 409);
      if (rt.store.leaseForAgent(agent.id)) fail(`cannot reparent while ${agent.id} still holds a live lease`, 409);
      const allocation = rt.store.activeAllocationForAgent(agent.id);
      if (allocation) fail(`cannot reparent while allocation ${allocation.id} is still active`, 409);
    }
    const reserved = rt.store.usageReceiptsAll(cluster.id).filter(receipt => receipt.status === 'RESERVED'
      && agents.some(agent => agent.id === receipt.agent_id));
    if (reserved.length) fail(`cannot reparent while ${reserved.length} usage reservations are still open in the subtree`, 409);
    const openCalls = rt.store.toolCallReceipts(cluster.id).filter(receipt => receipt.dispatch_status === 'ADMITTED'
      && agents.some(agent => agent.id === receipt.agent_id));
    if (openCalls.length) fail(`cannot reparent while ${openCalls.length} tool calls are admitted but not settled in the subtree`, 409);
    // A transaction delegated to this subtree that still hangs off a parent
    // outside it would be left pointing at the wrong owner.
    for (const tx of rt.store.transactionsInSubtree(cluster.id, node.id)) {
      if (!tx.parent_transaction_id) continue;
      const parent = rt.store.getTransaction(tx.parent_transaction_id);
      if (!parent || subtreeIds.has(parent.node_id)) continue;
      if (!TRANSACTION_TERMINAL.has(tx.status)) fail(`cannot reparent: transaction ${tx.id} has an unfinished delegated assignment outside the subtree`, 409);
    }

    // ---- commit: one transaction, all of it or none of it ----
    const previousParent = node.parent_id;
    const depthDelta = newParent.depth + 1 - node.depth;
    const siblingIndex = newSiblings.length;
    const moved = rt.store.tx(() => {
      // Budgets follow the subtree: every scope inside it returns what it has
      // not reserved and not spent to its old funding ancestor, the new parent
      // is checked for the same amount, and the amounts are re-granted along the
      // new path. Totals are conserved and the earliest deadline never moves
      // later.
      const members = rt.store.nodesInSubtree(cluster.id, node.id).map(member => member.id);
      const memberIds = new Set(members);
      const scopes = rt.store.listBudgets(cluster.id).filter(row => row.node_id && memberIds.has(row.node_id));
      const nodeBudget = rt.store.budgetForScope(cluster.id, 'node', node.id);
      const newParentBudget = rt.store.budgetForScope(cluster.id, 'node', newParent.id);
      if (!nodeBudget || !newParentBudget) fail('reparent needs both node budget scopes', 409);
      const priorDeadline = effectiveDeadline(rt.store, nodeBudget);
      // Save canonical, unreserved balances before any transfer changes a limit.
      // Only grants crossing the subtree boundary must return to the old
      // branch; descendant and identity grants retain their own parent scopes.
      const outgoing = scopes.flatMap(row => {
        const parent = row.parent_budget_id ? rt.store.getBudget(row.parent_budget_id) : null;
        if (!parent || memberIds.has(parent.node_id)) return [];
        const amounts = Object.fromEntries(DIMENSIONS
          .map(dim => [dim.key, dimensionAvailable(row, dim.key)])
          .filter(([, amount]) => amount > 0));
        return [{ id: row.id, parentId: parent.id, amounts }];
      });
      for (const { id, parentId, amounts } of outgoing) {
        if (Object.keys(amounts).length) transferBudget(rt.store, id, parentId, amounts);
      }
      rt.reclaimIdleRoleGrants(cluster, newParentBudget.id);
      for (const { id, amounts } of outgoing) {
        if (!Object.keys(amounts).length) continue;
        const payer = id === nodeBudget.id ? newParentBudget : rt.store.getBudget(rt.store.getBudget(id).parent_budget_id);
        if (!payer) fail(`reparent cannot fund budget ${id}`, 409);
        transferBudget(rt.store, payer.id, id, amounts);
      }
      rt.store.updateBudget(nodeBudget.id, {
        parent_budget_id: newParentBudget.id,
        // Preserve the old earliest inherited deadline even when the new
        // ancestor would permit the moved subtree to live longer.
        wall_deadline: priorDeadline === null ? nodeBudget.wall_deadline
          : Math.min(priorDeadline, nodeBudget.wall_deadline ?? priorDeadline),
      });
      // Every descendant's depth *and* path, from the moved root down.
      for (const member of rt.store.nodesInSubtree(cluster.id, node.id)) {
        const suffix = member.path.startsWith(`${node.path}.`) ? member.path.slice(node.path.length + 1) : null;
        rt.store.updateNode(member.id, {
          depth: member.depth + depthDelta,
          ...(member.id === node.id
            ? { parent_id: newParent.id, path: `${newParent.path}.${siblingIndex}` }
            : { path: `${newParent.path}.${siblingIndex}${suffix ? `.${suffix}` : ''}` }),
        });
      }
      // A transaction's owner is the management node that hosts it, not the
      // branch above it: the move relocates the tree, and every transaction in
      // it keeps the owner it will be reassigned inside. Writing the new parent
      // here instead put the moved node's existing transactions into a
      // different owner domain from the ones it creates after the move, and a
      // valid within-domain `reassign_agent` was then refused with a 409.
      for (const tx of rt.store.transactionsInSubtree(cluster.id, node.id)) {
        if (tx.owner_management_id === tx.node_id) continue;
        rt.store.updateTransaction(tx.id, { owner_management_id: tx.node_id });
      }
      return { scopes: outgoing.length };
    });
    rt.store.appendEvent(cluster.id, 'node-reparented', {
      node_id: node.id, from: previousParent, to: newParent.id, subtree: subtree.length, budgets_migrated: moved.scopes,
    });
    return { node_id: node.id, from: previousParent, to: newParent.id, subtree: subtree.length, budgets_migrated: moved.scopes };
  },

  checkpoint(rt, cluster, actor, params) {
    const agent = rt.store.getAgent(params.agent_id);
    if (!agent) fail('Agent not found', 404);
    assertDomain(rt, cluster, actor, agent.node_id);
    const allocation = rt.store.activeAllocationForAgent(agent.id);
    const checkpoint = rt.store.insertCheckpoint({
      id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, session_id: agent.session_id,
      // The native session offset at this safe point (null when the identity has
      // no live instance to ask), and the cluster's own cursor separately.
      flushed_seq: rt.sessionOffsetOf(agent.session_id),
      events_seq: rt.store.latestEventSeq(cluster.id), transaction_id: allocation?.transaction_id ?? null,
      transaction_revision: allocation?.transaction_id ? rt.store.getTransaction(allocation.transaction_id)?.revision ?? null : null,
      inbox_ack_cursor: null, usage_watermark: rt.usageWatermark(cluster.id), turn_seq: agent.turns,
      data: { reason: 'explicit checkout' },
    });
    rt.store.deleteCheckpointsAfter(cluster.id, agent.id, checkpoint.id);
    rt.store.appendEvent(cluster.id, 'checkpoint', { agent_id: agent.id, checkpoint_id: checkpoint.id });
    return { checkpoint_id: checkpoint.id, agent_id: agent.id, turn_seq: agent.turns };
  },

  /**
   * Restore an identity to a checkpoint. The host's Session is append-only, so
   * this never claims to rewind it: the checkpoint is validated against the
   * cluster/agent/session it belongs to and against the native offset it
   * recorded, and the identity is fenced so a later turn starts cleanly.
   */
  restore(rt, cluster, actor, params) {
    const agent = rt.store.getAgent(params.agent_id);
    if (!agent) fail('Agent not found', 404);
    assertDomain(rt, cluster, actor, agent.node_id);
    const checkpoint = params.checkpoint_id ? rt.store.getCheckpoint(params.checkpoint_id) : rt.store.latestCheckpoint(cluster.id, agent.id);
    if (!checkpoint) fail('no durable checkpoint for this agent', 409);
    if (checkpoint.cluster_id !== cluster.id || checkpoint.agent_id !== agent.id || checkpoint.session_id !== agent.session_id) {
      fail('checkpoint does not belong to this cluster, agent and session', 409);
    }
    // §6.6: the durable offset must *equal* the checkpoint's. An offset ahead of
    // it means history was appended after the checkpoint, and an unknown offset
    // means the session cannot be proven to be at the checkpoint at all — both
    // are refusals, checked before anything is mutated.
    const current = rt.sessionOffsetOf(agent.session_id);
    const checkpointOffset = checkpoint.flushed_seq ?? null;
    // An unknown offset is *no* verification, not a degenerate pass:
    // `sessionOffsetOf` answers null when there is no live instance to ask, which
    // says nothing about whether the session carries history. An idle identity
    // that already completed turns would otherwise restore unverified.
    if (checkpointOffset === null || current === null) {
      fail(`the session offset of ${agent.session_id} is ${current === null ? 'unknown' : current} and the checkpoint records ${checkpointOffset === null ? 'none' : checkpointOffset}; the checkpoint cannot be validated`, 409);
    }
    if (current !== checkpointOffset) {
      fail(`checkpoint records native offset ${checkpoint.flushed_seq} but the session is at ${current}; the host session is append-only and cannot be rewound`, 409);
    }
    const turn = rt.activeTurnFor(agent.id);
    if (turn) turn.ac.abort(new Error('agent restored'));
    const unsettled = rt.store.effectsAll(cluster.id, { status: 'STARTED' }).filter(effect => effect.agent_id === agent.id);
    // Fence the identity for real: the epoch alone is not read by
    // `leaseStillHeld`, the tool rechecks or actor fencing, so a restored
    // identity could still be published by the turn it just replaced. Dropping
    // the lease is what the old turn's finisher observes.
    const liveLease = rt.store.leaseForAgent(agent.id);
    if (liveLease) {
      rt.store.deleteLease(liveLease.id);
      rt.store.appendEvent(cluster.id, 'lease-fenced', {
        agent_id: agent.id, lease_id: liveLease.id, epoch: liveLease.epoch,
        reason: 'identity restored from a checkpoint; the replaced instance may not publish',
      });
    }
    rt.store.updateAgent(agent.id, { status: 'READY', epoch: agent.epoch + 1 });
    rt.store.appendEvent(cluster.id, 'restored', {
      agent_id: agent.id, checkpoint_id: checkpoint.id, unsettled: unsettled.length,
      native_offset: checkpoint.flushed_seq, events_seq: checkpoint.events_seq ?? null,
      note: 'the host session is append-only: this fences the identity and reports the checkpoint, it does not rewind the log',
    });
    return {
      agent_id: agent.id, checkpoint_id: checkpoint.id, turn_seq: checkpoint.turn_seq,
      native_offset: checkpoint.flushed_seq, events_seq: checkpoint.events_seq ?? null,
      effect_uncertain: unsettled.map(effect => ({ call_id: effect.call_id, tool: effect.tool })),
      note: unsettled.length
        ? 'non-idempotent effects without a settled receipt are marked EFFECT_UNCERTAIN and are not replayed; the owner stays blocked until a human resolves them'
        : 'the session log is append-only; restore fences the identity rather than rewinding history',
    };
  },

  /**
   * The human exit for an uncertain effect: decide whether the side effect
   * really happened, then let the owner run again. Until this is called, the
   * owner's tool calls are refused (`admitToolCall`), which is what makes
   * EFFECT_UNCERTAIN a barrier instead of a label.
   */
  resolve_effect(rt, cluster, actor, params) {
    const effect = rt.store.getEffect(params.call_id);
    if (!effect || effect.cluster_id !== cluster.id) fail('Effect not found', 404);
    if (effect.status !== 'EFFECT_UNCERTAIN') fail(`effect ${effect.call_id} is ${effect.status}; only an uncertain effect needs a decision`, 409);
    const decision = String(params.decision ?? '').toLowerCase();
    if (!['settled', 'failed'].includes(decision)) fail('resolve_effect requires decision: "settled" (the effect happened) or "failed" (it did not)');
    rt.store.settleEffect(effect.call_id, decision === 'settled'
      ? { status: 'SETTLED', body: { resolved_by: actor.agent_id ?? null, note: params.note ?? 'resolved by hand' } }
      : { status: 'FAILED', error: `resolved by hand as not executed: ${params.note ?? ''}`.slice(0, 2000) });
    // The *quota* moves through the receipt-owned transition the recovery, the
    // post-execution settlement and this decision all share: it acts only on a
    // receipt that still holds the call, so a call recovery already consumed
    // (UNKNOWN) moves nothing here — no underflowed reserve, no borrowing another
    // call's hold. The *decision* is what this action adds.
    if (rt.store.getToolCallReceipt(effect.call_id)) {
      rt.store.tx(() => rt.resolveReceiptQuotaAfterEffect(effect.call_id, { decision, actor, params }));
    }
    rt.store.appendEvent(cluster.id, 'effect-resolved', {
      call_id: effect.call_id, agent_id: effect.agent_id, tool: effect.tool, decision,
      by: actor.agent_id ?? null,
    });
    return { call_id: effect.call_id, status: decision === 'settled' ? 'SETTLED' : 'FAILED' };
  },

  /**
   * Transaction-scoped pause: the Orchestrator's own lifecycle switch, scoped
   * to one transaction and everything that depends on it. The cluster-level
   * `control` remains the operator's whole-cluster switch.
   */
  pause_transaction(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (TRANSACTION_TERMINAL.has(tx.status)) fail(`transaction ${tx.id} is ${tx.status}; nothing to pause`, 409);
    const scope = transactionSubtree(rt, cluster.id, tx.id).map(id => rt.store.getTransaction(id));
    const paused = [];
    for (const member of scope) {
      const current = rt.store.getTransaction(member.id);
      if (!current || !['READY', 'DISPATCHED', 'RUNNING', 'DRAFT', 'SUBMITTED', 'VALIDATING'].includes(current.status)) continue;
      if (current.status === 'RUNNING') assertTransactionWorkerDrained(rt, current);
      // A plan-only pause fences existing grants and advances the lifecycle
      // revision. A submitted result or pending validation must retain its
      // result_revision/audit target instead; no new result was proposed.
      const reviewing = ['SUBMITTED', 'VALIDATING'].includes(current.status);
      rt.store.updateTransaction(current.id, {
        status: 'PAUSED', pre_pause_status: current.status,
        pre_pause_revision: current.revision + (reviewing ? 0 : 1),
        plan_approved_revision: reviewing ? current.plan_approved_revision : null,
        __bump_revision: !reviewing,
      });
      if (!reviewing) {
        const oldAudit = rt.store.findAudit(cluster.id, current.id, 'plan', current.revision);
        if (oldAudit?.decision === 'PENDING') {
          rt.store.decideAudit(oldAudit.id, 'OVERRIDDEN', actor.agent_id ?? null, { reason: 'plan lifecycle paused' });
        }
      }
      paused.push(current.id);
    }
    rt.store.appendEvent(cluster.id, 'transaction-paused', {
      transaction_id: tx.id, transactions: paused, reason: params.reason ?? '', checkpoint_policy: params.checkpoint_policy ?? null,
    });
    notifyTransactionModified(rt, cluster, actor, rt.store.getTransaction(tx.id), 'paused');
    return { transaction_id: tx.id, paused, status: rt.store.getTransaction(tx.id).status };
  },

  resume_transaction(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    if (tx.status !== 'PAUSED' && !transactionSubtree(rt, cluster.id, tx.id).some(id => rt.store.getTransaction(id).status === 'PAUSED')) {
      fail(`transaction ${tx.id} is ${tx.status}; nothing to resume`, 409);
    }
    if (params.updated_requirements !== undefined
      && ['SUBMITTED', 'VALIDATING'].includes(tx.pre_pause_status)) {
      fail('finish or reject the pending result review before changing requirements', 409);
    }
    const scope = transactionSubtree(rt, cluster.id, tx.id).map(id => rt.store.getTransaction(id));
    const resumed = [];
    for (const member of scope) {
      const current = rt.store.getTransaction(member.id);
      if (!current || current.status !== 'PAUSED') continue;
      const prior = current.pre_pause_status;
      if (!prior || current.revision !== current.pre_pause_revision) {
        fail(`paused transaction ${current.id} changed revision; replan before resuming`, 409);
      }
      if (['SUBMITTED', 'VALIDATING'].includes(prior)
        && (current.result === null || (prior === 'VALIDATING'
          && (!current.validation || current.result_revision !== current.revision)))) {
        fail(`paused transaction ${current.id} lost its result review identity`, 409);
      }
      const changedRequirements = current.id === tx.id && params.updated_requirements !== undefined;
      const target = changedRequirements ? 'DRAFT'
        : prior === 'DRAFT' ? 'DRAFT'
          : prior === 'SUBMITTED' || prior === 'VALIDATING' ? prior
            : prior === 'RUNNING' && current.result !== null ? 'SUBMITTED'
              : rt.settledDependencies(current) ? 'READY' : 'DRAFT';
      let updated;
      if (changedRequirements) {
        updated = rt.store.updateTransaction(current.id, {
          acceptance_criteria: Array.isArray(params.updated_requirements)
            ? params.updated_requirements : [params.updated_requirements],
          status: target, plan_approved_revision: null,
          pre_pause_status: null, pre_pause_revision: null,
        });
      } else {
        updated = rt.store.updateTransaction(current.id, {
          status: target, pre_pause_status: null, pre_pause_revision: null,
          __bump_revision: ['SUBMITTED', 'VALIDATING'].includes(prior) ? false : undefined,
        });
      }
      if (target === 'READY' && !['SUBMITTED', 'VALIDATING'].includes(prior)) {
        const audit = rt.store.insertAudit({
          id: randomUUID(), cluster_id: cluster.id, transaction_id: current.id, node_id: current.node_id,
          kind: 'plan', target_revision: updated.revision, decision: 'PENDING',
          evidence: { requested_by: actor.agent_id ?? null, reason: 'transaction resumed' },
        });
        rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, current.node_id, 'auditor')?.id, {
          subject: 'plan-audit-requested', payload: { audit_id: audit.id, transaction_id: current.id },
        });
        const allocation = rt.store.activeAllocationForTransaction(current.id);
        if (allocation) rt.store.appendEvent(cluster.id, 'agent-allocated', {
          agent_id: allocation.agent_id, node_id: allocation.node_id, transaction_id: current.id,
          revision: updated.revision, write_scope: allocation.write_scope, capabilities: allocation.capabilities,
          reason: 'transaction resumed with unchanged scope',
        });
      }
      resumed.push({ transaction_id: current.id, status: target });
    }
    rt.store.appendEvent(cluster.id, 'transaction-resumed', {
      transaction_id: tx.id, transactions: resumed, resume_point: params.resume_point ?? null,
    });
    notifyTransactionModified(rt, cluster, actor, rt.store.getTransaction(tx.id), 'resumed');
    return { transaction_id: tx.id, resumed, status: rt.store.getTransaction(tx.id).status };
  },

  cancel_transaction(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    const scope = transactionSubtree(rt, cluster.id, tx.id).map(id => rt.store.getTransaction(id));
    const cancelled = [];
    for (const member of scope) {
      const current = rt.store.getTransaction(member.id);
      if (!current || TRANSACTION_TERMINAL.has(current.status)) continue;
      setStatus(rt, current, 'CANCELLED');
      // Cancellation is a lifecycle change, and the revision is what a pending
      // audit, a validation and a stale check are keyed to: leaving it behind
      // left audits pending against a revision that no longer describes the
      // transaction.
      rt.store.updateTransaction(current.id, { status: 'CANCELLED' });
      cancelled.push(current.id);
    }
    // The identities that owned that work stop with it, and the capacity their
    // allocations held returns to the node.
    for (const member of scope) {
      const allocation = rt.store.activeAllocationForTransaction(member.id);
      if (allocation) releaseAllocation(rt, cluster, allocation, `transaction ${tx.id} cancelled`);
    }
    rt.store.appendEvent(cluster.id, 'transaction-cancelled', {
      transaction_id: tx.id, transactions: cancelled, reason: params.reason ?? '', artifact_policy: params.artifact_policy ?? null,
    });
    notifyTransactionModified(rt, cluster, actor, rt.store.getTransaction(tx.id), 'cancelled');
    return { transaction_id: tx.id, cancelled, status: rt.store.getTransaction(tx.id).status };
  },

  // ----------------------------------------------------------------- auditor
  inspect_plan(rt, cluster, actor, params) {
    const audit = resolveAudit(rt, cluster, actor, params, 'plan');
    const tx = txOf(rt, audit.transaction_id);
    assertDomain(rt, cluster, actor, tx.node_id);
    if (audit.decision !== 'PENDING') return { audit_id: audit.id, decision: audit.decision, deduped: true };
    const decision = normaliseDecision(params.decision);
    // A verdict on a plan the transaction has already moved past is stale for
    // *both* answers. Checking it only on the approval path let a late rejection
    // pull the newer revision back to DRAFT, open an issue against a revision
    // nobody reviewed, and pause its dependents — a correction for work that no
    // longer exists.
    if (tx.revision !== audit.target_revision) {
      rt.store.decideAudit(audit.id, 'STALE', actor.agent_id ?? null, { note: `transaction moved to revision ${tx.revision}` });
      return { audit_id: audit.id, decision: 'STALE', transaction_id: tx.id };
    }
    if (decision === 'APPROVED') {
      rt.store.decideAudit(audit.id, 'APPROVED', actor.agent_id ?? null, { evidence: params.evidence ?? {} });
      // Observational: the Orchestrator already made this revision dispatchable.
      // The approval is recorded as evidence for the health signal, not as the
      // permission to run.
      rt.store.updateTransaction(tx.id, { plan_approved_revision: audit.target_revision, __bump_revision: false });
      rt.store.appendEvent(cluster.id, 'plan-approved', {
        transaction_id: tx.id, revision: audit.target_revision, status: rt.store.getTransaction(tx.id).status,
      });
      rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, 'allocator')?.id, { subject: 'plan-approved', payload: { transaction_id: tx.id } });
      return { audit_id: audit.id, decision: 'APPROVED', transaction_id: tx.id, status: rt.store.getTransaction(tx.id).status };
    }
    rt.store.decideAudit(audit.id, 'REJECTED', actor.agent_id ?? null, { evidence: params.evidence ?? {} });
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: audit.target_revision,
      severity: params.severity ?? 'MAJOR', evidence: params.evidence ?? {},
      required_change: params.required_change ?? 'revise the plan so the acceptance criteria are checkable and the decomposition covers the objective',
    });
    // A Worker already running this revision has a live submission contract.
    // Record the independent verdict now, but do not revoke that contract
    // before its tool effects and result have been settled. Its finisher pulls
    // the rejected revision back to DRAFT after recording the result.
    const activeAllocation = tx.status === 'RUNNING'
      ? rt.store.activeAllocationForTransaction(tx.id) : null;
    const workerInFlight = activeAllocation && (rt.activeTurnFor(activeAllocation.agent_id)
      || (rt.store.leaseForAgent(activeAllocation.agent_id)?.expires ?? 0) > rt.timestamp());
    if (!workerInFlight && !TRANSACTION_TERMINAL.has(tx.status) && tx.status !== 'DRAFT') {
      setStatus(rt, rt.store.getTransaction(tx.id), 'DRAFT');
    }
    rt.store.updateTransaction(tx.id, { plan_approved_revision: null, __bump_revision: false });
    if (workerInFlight) {
      rt.store.appendEvent(cluster.id, 'plan-rejection-deferred', {
        transaction_id: tx.id, revision: tx.revision, agent_id: activeAllocation.agent_id,
      });
    }
    pauseDependents(rt, cluster, tx);
    assertCorrectionBudget(rt, cluster, tx, cluster.limits.max_corrections);
    return { audit_id: audit.id, decision: 'REJECTED', transaction_id: tx.id, issue_id: issue.id, status: rt.store.getTransaction(tx.id).status };
  },

  inspect_validation(rt, cluster, actor, params) {
    const audit = resolveAudit(rt, cluster, actor, params, 'validation');
    const tx = txOf(rt, audit.transaction_id);
    assertDomain(rt, cluster, actor, tx.node_id);
    if (audit.decision !== 'PENDING') return { audit_id: audit.id, decision: audit.decision, deduped: true };
    const decision = normaliseDecision(params.decision);
    if (tx.result_revision !== audit.target_revision || tx.revision !== audit.target_revision) {
      rt.store.decideAudit(audit.id, 'STALE', actor.agent_id ?? null, { note: `transaction is at revision ${tx.revision}, result revision ${tx.result_revision}` });
      return { audit_id: audit.id, decision: 'STALE', transaction_id: tx.id };
    }
    if (decision === 'APPROVED') {
      rt.store.decideAudit(audit.id, 'APPROVED', actor.agent_id ?? null, { evidence: params.evidence ?? {} });
      const outcome = acceptTransaction(rt, cluster, rt.store.getTransaction(tx.id));
      return { audit_id: audit.id, decision: 'APPROVED', ...outcome };
    }
    rt.store.decideAudit(audit.id, 'REJECTED', actor.agent_id ?? null, { evidence: params.evidence ?? {} });
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: audit.target_revision,
      severity: params.severity ?? 'MAJOR', evidence: params.evidence ?? {},
      required_change: params.required_change ?? 'produce evidence that satisfies every acceptance criterion',
    });
    setStatus(rt, tx, 'REJECTED');
    assertCorrectionBudget(rt, cluster, tx, cluster.limits.max_corrections);
    return { audit_id: audit.id, decision: 'REJECTED', transaction_id: tx.id, issue_id: issue.id, status: 'REJECTED' };
  },

  request_correction(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: params.target_revision ?? tx.revision,
      severity: params.severity ?? 'MAJOR', evidence: params.evidence ?? {},
      required_change: params.required_change ?? 'correct the result against the acceptance criteria',
    });
    if (!TRANSACTION_TERMINAL.has(tx.status) && tx.status !== 'DRAFT') setStatus(rt, tx, 'REJECTED');
    const audit = rt.store.findAudit(cluster.id, tx.id, 'validation', tx.result_revision);
    if (audit && audit.decision === 'PENDING') rt.store.decideAudit(audit.id, 'CORRECTION_REQUESTED', actor.agent_id ?? null, { issue_id: issue.id });
    rt.store.updateTransaction(tx.id, { validation: null });
    pauseDependents(rt, cluster, tx);
    assertCorrectionBudget(rt, cluster, tx, cluster.limits.max_corrections);
    return { issue_id: issue.id, transaction_id: tx.id, status: rt.store.getTransaction(tx.id).status };
  },

  request_replan(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    assertTransactionWorkerDrained(rt, tx);
    assertCorrectionBudget(rt, cluster, tx, cluster.limits.max_corrections);
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: tx.revision,
      severity: params.severity ?? 'MAJOR', evidence: params.evidence ?? {},
      required_change: params.required_change ?? 'replan this transaction before resubmitting it for audit',
    });
    for (const audit of rt.store.all(
      "SELECT id FROM audits WHERE cluster_id=? AND transaction_id=? AND decision='PENDING'",
      cluster.id, tx.id,
    )) {
      rt.store.decideAudit(audit.id, 'REPLAN_REQUESTED', actor.agent_id ?? null, { issue_id: issue.id });
    }
    const reopeningAcceptance = tx.status === 'ACCEPTED';
    const status = reopeningAcceptance ? 'REJECTED' : 'DRAFT';
    setStatus(rt, tx, status);
    rt.store.updateTransaction(tx.id, {
      plan_approved_revision: null, validation: null, __bump_revision: false,
      result: null, result_revision: null,
      result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
    });
    if (reopeningAcceptance) {
      rt.store.insertSummary({
        id: randomUUID(), cluster_id: cluster.id, node_id: tx.node_id,
        transaction_id: tx.id, as_of_seq: rt.store.latestEventSeq(cluster.id),
        data: { transaction_id: tx.id, status, invalidated_by_issue: issue.id },
      });
      writeNodeSummary(rt, cluster, tx.node_id);
    }
    pauseDependents(rt, cluster, tx);
    return { issue_id: issue.id, transaction_id: tx.id, status };
  },

  request_revalidation(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, params.transaction_id);
    const issue = openIssue(rt, cluster, actor, {
      transaction_id: tx.id, node_id: tx.node_id, target_revision: params.target_revision ?? tx.revision,
      severity: params.severity ?? 'MINOR', evidence: params.evidence ?? {},
      required_change: params.required_change ?? 're-run validation against the current result revision',
    });
    if (tx.status === 'VALIDATING') {
      const audit = rt.store.findAudit(cluster.id, tx.id, 'validation', tx.result_revision);
      if (audit && audit.decision === 'PENDING') rt.store.decideAudit(audit.id, 'REVALIDATION_REQUESTED', actor.agent_id ?? null, { issue_id: issue.id });
      // An aggregate is the parent's own run: it moves through RUNNING as any other
    // execution does, because the transition table has no READY → SUBMITTED. The
    // status is read fresh — the caller's row is a snapshot, and acting on it skipped
    // the intermediate transition while `setStatus` checked the live one.
    // Work on a snapshot that reflects the live row: `setTransactionStatus` asserts the
    // transition from `tx.status`, so a stale snapshot makes the intermediate step a
    // no-op and the next one illegal.
    let live = rt.store.getTransaction(tx.id);
    if (live.status === 'READY') live = setStatus(rt, live, 'RUNNING');
    setStatus(rt, live, 'SUBMITTED');
      rt.store.updateTransaction(tx.id, { validation: null, __bump_revision: false });
    }
    assertCorrectionBudget(rt, cluster, tx, cluster.limits.max_corrections);
    return { issue_id: issue.id, transaction_id: tx.id, status: rt.store.getTransaction(tx.id).status };
  },

  verify_correction(rt, cluster, actor, params) {
    const issue = rt.store.getIssue(params.issue_id);
    if (!issue) fail('Issue not found', 404);
    assertDomain(rt, cluster, actor, issue.node_id);
    if (issue.status === 'CORRECTED') return { issue_id: issue.id, status: issue.status, deduped: true };
    // A verdict has something to verify only once the transaction moved past the
    // revision the issue was raised against. Verifying before that is not a
    // correction round: it consumed the correction budget without anything having
    // changed (measured: two such verdicts exhausted the budget and blocked a
    // two-transaction smoke whose plans had both been approved).
    // The *same* predicate the scheduler uses to offer a verdict: a plan
    // adjustment or a re-validation past the issue's revision. Reading only the
    // former refused the verdict for a revalidation the Orchestrator had already
    // performed.
    const decision = String(params.decision ?? '').toUpperCase();
    // A wrong issue has to be withdrawable. The Auditor's escalation in a live run was
    // *its own* retraction — “no defect in plan … I re-queried the transaction: it carries
    // two checkable criteria” — and with no way to close an issue that nothing has
    // changed for, the only exit was to block the cluster. `DISMISSED` is that exit: the
    // reporter's own judgement that there was no defect, recorded as its own status so it
    // can never be mistaken for a correction.
    // A wrong issue has to be withdrawable: `DISMISSED` is the reporter's own judgement
    // that there was no defect, recorded as its own status so it can never be mistaken
    // for a correction.
    if (decision === 'DISMISSED') {
      if (!params.evidence || !Object.keys(params.evidence).length) {
        fail('dismissing an issue needs evidence: what did you re-check, and what did it show?', 409);
      }
      // A refusal that the guard actually recorded is not a mistaken report
      // while its transaction still lacks an accepted result. The Auditor can
      // withdraw an unsupported observation, but it cannot erase a blocked
      // effect by describing the limitation as someone else's responsibility.
      if (rt.store.hasConfirmedWriteRefusal(cluster.id, issue.transaction_id, issue.evidence)
        && rt.store.getTransaction(issue.transaction_id)?.status !== 'ACCEPTED') {
        fail(`issue ${issue.id} records a refused write on unfinished transaction ${issue.transaction_id}; correct the plan or allocation before closing it`, 409);
      }
      // A Worker that explicitly reported an incomplete result really did not
      // satisfy the transaction at the issue's revision. Even without a
      // write-refused tool event, the Auditor must review a later correction
      // rather than withdraw that durable failure as if nothing were wrong.
      if (rt.store.issueHasIncompleteWorkerResult(cluster.id, issue)) {
        fail(`issue ${issue.id} followed a blocked or incomplete Worker result on ${issue.transaction_id}; review the correction instead of dismissing it`, 409);
      }
      const withdrawn = rt.store.updateIssue(issue.id, {
        status: 'DISMISSED', evidence: { ...issue.evidence, dismissal: params.evidence },
      });
      rt.store.appendEvent(cluster.id, 'issue-dismissed', {
        issue_id: issue.id, transaction_id: issue.transaction_id, reason: String(params.notes ?? params.required_change ?? '').slice(0, 300),
      });
      return { issue_id: withdrawn.id, status: withdrawn.status, dismissed: true };
    }
    const closing = decision === 'VERIFIED' || decision === 'CORRECTED';
    // A closing verdict accepts the correction that is there (anything since the issue
    // was raised); a rejection charges a round, so it needs a correction later than the
    // one already reviewed — otherwise the same repair could be rejected twice.
    const progressed = rt.issueProgressed(cluster.id, issue, { since: closing ? 'raised' : 'reviewed' });
    if (!progressed.progressed) {
      fail(`nothing ${closing ? '' : 'new '}has changed on ${issue.transaction_id ?? 'the transaction'} since issue ${issue.id} was raised at revision ${issue.target_revision ?? 'unknown'}${!closing && issue.reviewed_revision ? ` and reviewed at ${issue.reviewed_revision}` : ''}; there is no ${closing ? '' : 'fresh '}correction to verify`, 409);
    }
    if (closing && rt.store.issueHasIncompleteWorkerResult(cluster.id, issue)
      && !rt.store.issueHasNewWorkerEvidence(cluster.id, issue)) {
      fail(`issue ${issue.id} followed an incomplete Worker result; the revised plan needs a new allocation or result before its correction can be verified`, 409);
    }
    if (closing) {
      const updated = rt.store.updateIssue(issue.id, { status: 'CORRECTED', evidence: { ...issue.evidence, verification: params.evidence ?? {} } });
      rt.store.appendEvent(cluster.id, 'issue-corrected', { issue_id: issue.id, transaction_id: issue.transaction_id });
      return { issue_id: updated.id, status: updated.status };
    }
    const corrections = issue.corrections + 1;
    // The reviewed revision is remembered with the charge, so the next round needs a
    // *later* correction than the one just rejected.
    const updated = rt.store.updateIssue(issue.id, {
      corrections,
      reviewed_revision: progressed.revision ?? issue.reviewed_revision ?? null,
      status: corrections >= cluster.limits.max_corrections ? 'ESCALATED' : 'OPEN',
      evidence: { ...issue.evidence, verification: params.evidence ?? {} },
    });
    rt.store.appendEvent(cluster.id, 'issue-unresolved', { issue_id: issue.id, corrections });
    if (corrections >= cluster.limits.max_corrections) {
      const tx = issue.transaction_id ? rt.store.getTransaction(issue.transaction_id) : null;
      if (tx) rt.blockNodeInternal(cluster.id, tx.node_id, `issue ${issue.id} exhausted ${cluster.limits.max_corrections} correction rounds`);
      else rt.blockClusterInternal(cluster.id, `issue ${issue.id} exhausted ${cluster.limits.max_corrections} correction rounds`);
    }
    return { issue_id: updated.id, status: updated.status, corrections };
  },

  /**
   * An observation is not a correction request. Persist it as an event and
   * deliver it to the Orchestrator; only an actual request_correction/replan
   * may create an OPEN issue that can prevent an unchanged plan from running.
   */
  notify(rt, cluster, actor, params) {
    const node = assertDomain(rt, cluster, actor, params.node_id ?? actor.node_id);
    const tx = params.transaction_id ? assertTransactionDomain(rt, cluster, actor, params.transaction_id) : null;
    const event = rt.store.appendEvent(cluster.id, 'auditor-notified', {
      node_id: node.id, transaction_id: tx?.id ?? null, agent_id: actor.agent_id ?? null,
      issue: params.issue ?? null, severity: params.severity ?? 'MINOR',
      evidence: truncateValue(params.evidence, 400),
    });
    rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, node.id, 'orchestrator')?.id, {
      subject: 'auditor-notified',
      payload: { event_seq: event.seq, transaction_id: tx?.id ?? null,
        issue: truncateValue(params.issue, 200) },
    });
    return { event_seq: event.seq, node_id: node.id, transaction_id: tx?.id ?? null };
  },

  recommend(rt, cluster, actor, params) {
    const tx = assertTransactionDomain(rt, cluster, actor, need(params, 'transaction_id'));
    const event = rt.store.appendEvent(cluster.id, 'auditor-recommended', {
      node_id: tx.node_id, transaction_id: tx.id, agent_id: actor.agent_id ?? null,
      recommendation: params.recommendation ?? null, expected_effect: params.expected_effect ?? null,
    });
    rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, tx.node_id, 'orchestrator')?.id, {
      subject: 'auditor-recommended',
      payload: { event_seq: event.seq, transaction_id: tx.id,
        recommendation: truncateValue(params.recommendation, 200) },
    });
    return { event_seq: event.seq, transaction_id: tx.id, advisory: true };
  },

  /**
   * Section 18: score the eight health dimensions on the record. The runtime
   * computes the deterministic signals; the Auditor supplies the judgement and
   * the weights, and both are stored, so a later reader can see what was
   * measured and by whom.
   */
  evaluate_health(rt, cluster, actor, params) {
    const metrics = rt.healthMetricNames();
    const dimensions = params.dimensions ?? {};
    if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) fail('evaluate_health needs dimensions as {metric: score}');
    const unknown = Object.keys(dimensions).filter(key => !metrics.includes(key));
    if (unknown.length) fail(`unknown health metric(s): ${unknown.join(', ')}; expected any of ${metrics.join(', ')}`);
    if (!Object.keys(dimensions).length) fail('evaluate_health needs at least one scored dimension');
    for (const [key, value] of Object.entries(dimensions)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`health score for ${key} must be a number in [0,1]`);
    }
    const weights = params.weights ?? Object.fromEntries(Object.keys(dimensions).map(key => [key, 1 / Object.keys(dimensions).length]));
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) fail('weights must be {metric: weight}');
    let weightSum = 0;
    for (const [key, value] of Object.entries(weights)) {
      if (!metrics.includes(key) || !Object.hasOwn(dimensions, key)) fail(`unknown or unscored health metric in weights: ${key}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        fail(`health weight for ${key} must be a finite number in [0,1]`);
      }
      weightSum += value;
    }
    if (!Number.isFinite(weightSum) || Math.abs(weightSum - 1) > 0.01) fail(`health weights must sum to 1 (±0.01); they sum to ${weightSum}`);

    const window = Object.hasOwn(params, 'evaluation_window')
      ? params.evaluation_window : `${rt.config.staleMs}ms`;
    const closeout = window === 'subtree-close';
    if (closeout) {
      const auditor = rt.roleAgentOf(cluster.id, actor.node_id, 'auditor');
      if (!auditor || auditor.id !== actor.agent_id || Object.keys(dimensions).length !== metrics.length) {
        fail('subtree-close requires the owning Auditor to score all eight health dimensions', 403);
      }
    }
    const numericWindow = typeof window === 'number' ? window
      : typeof window === 'string' && /^\d+(?:\.\d+)?(?:ms)?$/.test(window)
        ? Number(window.replace(/ms$/, '')) : NaN;
    if (!closeout && (!Number.isFinite(numericWindow) || numericWindow <= 0)) {
      fail('evaluation_window must be a positive finite millisecond interval or subtree-close');
    }
    const signals = rt.healthSignals(cluster.id, { windowMs: closeout ? rt.config.staleMs : numericWindow });
    const row = rt.store.insertHealth({
      id: randomUUID(), cluster_id: cluster.id, node_id: actor.node_id ?? null, evaluation_window: window,
      signals, scores: { ...dimensions }, weights: { ...weights }, decided: true, decided_by: actor.agent_id ?? null,
    });
    rt.store.appendEvent(cluster.id, 'health-evaluated', {
      health_id: row.id, node_id: actor.node_id ?? null, dimensions: Object.keys(dimensions), weights,
    });
    return { health_id: row.id, signals, scores: dimensions, weights };
  },

  // ----------------------------------------------------------------- allocator
  /**
   * A per-identity context budget: the Allocator's answer to one session that
   * outgrows the role default, without moving the default for everyone.
   */
  set_context_budget(rt, cluster, actor, params) {
    const agent = rt.store.getAgent(params.agent_id ?? params.agent);
    if (!agent || agent.cluster_id !== cluster.id) fail('Agent not found', 404);
    assertDomain(rt, cluster, actor, agent.node_id);
    const limit = integer(params.context_limit ?? params.limit, 1024, 1_048_576, 'context_limit');
    const trigger = params.compression_threshold ?? params.trigger ?? 0.8;
    if (typeof trigger !== 'number' || !(trigger > 0) || trigger > 1) fail('compression_threshold must be a number in (0,1]');
    rt.store.updateAgent(agent.id, { meta: { ...agent.meta, context: { limit, trigger, retention: params.retention_policy ?? null } } });
    rt.store.appendEvent(cluster.id, 'context-budget-set', { agent_id: agent.id, limit, trigger, retention: params.retention_policy ?? null });
    return { agent_id: agent.id, context: { limit, trigger, retention: params.retention_policy ?? null } };
  },

  // ------------------------------------------------------------------ worker
  /**
   * Stage a Worker's proposal. It is deliberately *not* published yet: only a
   * turn that ends with the provider's `completed` outcome may expose a result
   * to validation, so an aborted, errored or truncated turn can never be
   * validated by accident.
   */
  submit_result(rt, cluster, actor, params) {
    const tx = txOf(rt, params.transaction_id ?? params.id);
    if (tx.cluster_id !== cluster.id) fail('Transaction belongs to another cluster', 403);
    const allocation = rt.store.activeAllocationForTransaction(tx.id);
    if (!allocation || allocation.agent_id !== actor.agent_id) fail('transaction is not allocated to this worker', 403);
    if (!['RUNNING', 'READY', 'DISPATCHED'].includes(tx.status)) {
      fail(`cannot submit a ${tx.status} transaction; a Worker may only stage a result while its transaction is running or ready to run`, 409);
    }
    if (params.result === undefined) fail('submit_result requires a result');
    const staged = tx.result !== null && tx.result !== undefined;
    if (staged) return { transaction_id: tx.id, status: 'STAGED', deduped: true };
    const updated = rt.store.updateTransaction(tx.id, {
      result: params.result, validation: null, result_revision: null,
      // Bind the proposal to the exact turn that produced it *and* to the
      // identity that produced it: a later turn of the same Worker may finish
      // the job and publish it, a foreign or replaced identity never may.
      result_staged_epoch: actor.epoch ?? null, result_staged_turn: actor.turn_seq ?? null,
      result_staged_agent: actor.agent_id ?? null,
      __bump_revision: false,
    });
    rt.store.appendEvent(cluster.id, 'result-staged', {
      transaction_id: tx.id, agent_id: actor.agent_id, epoch: actor.epoch ?? null, turn: actor.turn_seq ?? null,
      notes: String(params.notes ?? '').slice(0, 500), revision: updated.revision,
    });
    return { transaction_id: tx.id, status: 'STAGED', revision: updated.revision };
  },
};

// ------------------------------------------------------------ action helpers

function acceptTransaction(rt, cluster, tx) {
  if (tx.status === 'ACCEPTED') return { transaction_id: tx.id, status: 'ACCEPTED', deduped: true };
  if (tx.status !== 'VALIDATING') fail(`transaction ${tx.id} is ${tx.status}; cannot accept`, 409);
  // The acceptance commit is where the invariant belongs: a parent validated *before*
  // it delegated can otherwise be accepted while its new child is still DRAFT (spawning
  // neither forbids a VALIDATING parent nor changes its revision). This covers every
  // route to ACCEPTED — the Auditor's approval and the Orchestrator's `accept_result`.
  if (rt.store.parentsAwaitingChildren(cluster.id).includes(tx.id)) {
    fail(`${tx.id} has delegated work still unfinished; aggregate the child results before accepting it`, 409);
  }
  const updated = rt.store.updateTransaction(tx.id, { status: 'ACCEPTED', __bump_revision: false });
  rt.store.appendEvent(cluster.id, 'result-accepted', { transaction_id: tx.id, result_revision: tx.result_revision });
  // A durable summary is what a parent aggregates: never a raw transcript, and
  // never a re-sum of an ancestor's numbers.
  rt.store.insertSummary({
    id: randomUUID(), cluster_id: cluster.id, node_id: tx.node_id, transaction_id: tx.id,
    as_of_seq: rt.store.latestEventSeq(cluster.id),
    data: {
      transaction_id: tx.id,
      objective: tx.objective.slice(0, 400),
      result_revision: tx.result_revision,
      conclusion: summariseResult(tx.result),
      evidence: (tx.validation?.checks ?? []).map(check => ({
        criterion: String(check.criterion).slice(0, 300), passed: check.passed, evidence: String(check.evidence ?? '').slice(0, 400),
      })),
      accepted_by: 'auditor',
    },
  });
  rt.store.appendEvent(cluster.id, 'summary-written', { transaction_id: tx.id, node_id: tx.node_id });
  writeNodeSummary(rt, cluster, tx.node_id);
  rt.deliverFixtureMessages(cluster, tx);
  for (const issue of rt.store.openIssues(cluster.id, { transaction_id: tx.id, status: ['OPEN', 'VERIFYING'] })) {
    rt.store.updateIssue(issue.id, { status: 'CORRECTED' });
  }
  const node = rt.store.getNode(tx.node_id);
  if (node?.parent_id) rt.notifyInternal(cluster.id, rt.roleAgentOf(cluster.id, node.parent_id, 'orchestrator')?.id, { subject: 'child-accepted', payload: { transaction_id: tx.id } });
  rt.evaluateCompletion(cluster.id);
  return { transaction_id: tx.id, status: updated.status, result_revision: tx.result_revision };
}

/**
 * Replace a node's summary with one built from its direct children's own
 * summaries. A parent never re-adds its ancestors' numbers.
 */
function writeNodeSummary(rt, cluster, nodeId) {
  // One node's domain, in full: its own transactions and every descendant's.
  const transactions = rt.store.transactionsInSubtree(cluster.id, nodeId);
  if (!transactions.length) return null;
  const summaries = transactions
    .filter(tx => tx.status === 'ACCEPTED')
    .map(tx => rt.store.latestSummary(cluster.id, { transaction_id: tx.id }))
    .filter(Boolean)
    .map(row => row.data);
  const openIssues = rt.store.openIssues(cluster.id, { node_id: nodeId, status: 'OPEN' });
  const counts = Object.fromEntries(
    rt.store.countTransactionsInSubtree(cluster.id, nodeId).map(row => [row.status, Number(row.c)]),
  );
  const total = Object.values(counts).reduce((sumTotal, count) => sumTotal + count, 0);
  const acceptedCount = counts.ACCEPTED ?? 0;
  rt.store.insertSummary({
    id: randomUUID(), cluster_id: cluster.id, node_id: nodeId, transaction_id: null,
    as_of_seq: rt.store.latestEventSeq(cluster.id),
    data: {
      transactions: {
        total,
        progress: total - acceptedCount - (counts.CANCELLED ?? 0) - (counts.SUPERSEDED ?? 0),
        completed: acceptedCount,
        failed: (counts.FAILED ?? 0) + (counts.BLOCKED ?? 0),
      },
      conclusions: summaries.map(summary => ({ transaction_id: summary.transaction_id, conclusion: summary.conclusion })),
      evidence: summaries.flatMap(summary => summary.evidence ?? []).slice(0, 50),
      unresolved_questions: openIssues.map(issue => ({ issue_id: issue.id, required_change: issue.required_change.slice(0, 300) })),
      resource_state: rt.store.usageSummary(cluster.id, { nodeId }),
      management_health: { open_issues: openIssues.length, node_id: nodeId },
      confidence: total > 0 && acceptedCount === total ? 'high' : 'partial',
      as_of_seq: rt.store.latestEventSeq(cluster.id),
    },
  });
  return rt.store.latestSummary(cluster.id, { node_id: nodeId });
}

function resolveAudit(rt, cluster, actor, params, kind) {
  if (params.audit_id) {
    const audit = rt.store.getAudit(params.audit_id);
    if (!audit || audit.cluster_id !== cluster.id) fail('Audit not found', 404);
    if (audit.kind !== kind) fail(`audit ${audit.id} is a ${audit.kind} audit, not ${kind}`, 409);
    return audit;
  }
  if (!params.transaction_id) fail(`${kind} audit requires audit_id or transaction_id`);
  const tx = txOf(rt, params.transaction_id);
  const revision = params.target_revision ?? (kind === 'plan' ? tx.revision : tx.result_revision);
  const audit = rt.store.findAudit(cluster.id, tx.id, kind, revision);
  if (!audit) fail(`no ${kind} audit for transaction ${tx.id} at revision ${revision}`, 404);
  return audit;
}

function normaliseDecision(value) {
  const decision = String(value ?? '').toUpperCase();
  if (decision === 'APPROVE' || decision === 'APPROVED') return 'APPROVED';
  if (decision === 'REJECT' || decision === 'REJECTED') return 'REJECTED';
  fail(`decision must be approve or reject, received ${JSON.stringify(value)}`);
}

/** Default child grant: an equal share of what the parent can still give. */
/**
 * A child's structural share of its parent's *limit*, not of whatever happens
 * to be left when it is created. Splitting the remainder made the order of
 * spawning decide who starves: a node created after its siblings had spent got
 * 781 tokens for its entire subtree, every role on it was refused on `tokens`,
 * and the run stopped as LIMIT_REACHED while the cluster still held 58% of its
 * budget. `grantBudget` still caps the transfer by what the parent really has.
 */
function shareOf(parentBudget, slots) {
  const share = {};
  for (const key of ['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents']) {
    const column = { tokens: 'tokens_limit', model_requests: 'requests_limit', tool_calls: 'tool_calls_limit', agents: 'agents_limit', max_active_agents: 'max_active_limit' }[key];
    const structural = Math.floor((parentBudget[column] ?? 0) / Math.max(1, slots));
    // Never more than half of what is actually left: the structural share is
    // measured against the parent's *limit*, so a fresh parent hands over its
    // fair split without emptying itself, and a nearly spent one keeps enough
    // to finish what it is doing.
    const half = Math.max(0, Math.floor(availableOf(parentBudget, key) / 2));
    const give = Math.min(structural, half);
    if (give > 0) share[key] = give;
  }
  return share;
}

/** What a parent budget still holds, before anything is reserved or spent. */
function availableOf(budget, key = 'tokens') {
  const column = {
    tokens: 'tokens_limit', model_requests: 'requests_limit', tool_calls: 'tool_calls_limit',
    agents: 'agents_limit', max_active_agents: 'max_active_limit',
  }[key];
  return Math.max(0, (budget[column] ?? 0) - (budget[`${column.replace('_limit', '_reserved')}`] ?? 0) - (budget[`${column.replace('_limit', '_spent')}`] ?? 0));
}

function resolveBudget(rt, cluster, ref) {
  if (!ref) fail('budget reference required');
  if (typeof ref === 'string') {
    const budget = rt.store.getBudget(ref);
    if (!budget || budget.cluster_id !== cluster.id) fail('Budget not found', 404);
    return budget;
  }
  const budget = rt.store.budgetForScope(cluster.id, ref.kind ?? 'node', ref.id);
  if (!budget) fail(`Budget not found for ${ref.kind ?? 'node'} ${ref.id}`, 404);
  return budget;
}

function validateChecks(checks) {
  if (typeof checks === 'string') {
    try {
      checks = JSON.parse(checks);
    } catch (error) {
      fail(`params.checks is not valid JSON: ${error.message}`);
    }
  }
  if (checks === undefined) return [];
  if (!Array.isArray(checks) || checks.length > 64) fail('validation.checks must be an array of at most 64 entries');
  return checks.map(check => {
    if (!check || typeof check !== 'object') fail('Invalid validation check');
    return {
      criterion: String(check.criterion ?? '').slice(0, 2000),
      passed: check.passed === true,
      evidence: typeof check.evidence === 'string' ? check.evidence.slice(0, 4000) : JSON.stringify(check.evidence ?? null).slice(0, 4000),
    };
  });
}

/**
 * The transactions of one transaction's subtree: itself and everything
 * decomposed below it, in SQL rather than from a page.
 */
function transactionSubtree(rt, clusterId, txId) {
  const out = [txId];
  const seen = new Set(out);
  const queue = [txId];
  while (queue.length) {
    const current = queue.shift();
    for (const child of rt.store.childrenOfTransaction(clusterId, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

function subtreeOf(rt, nodeId) {
  const out = [];
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift();
    for (const child of rt.store.childrenOf(current)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

function truncateValue(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text === null ? null : String(text).slice(0, max);
}

function summariseResult(result) {
  if (result === null || result === undefined) return null;
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export { MAX_ISSUE_CORRECTIONS, assertDomain, assertTransactionDomain, acceptTransaction, validateChecks, writeNodeSummary };