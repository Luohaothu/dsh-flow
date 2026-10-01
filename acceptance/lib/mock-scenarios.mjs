/**
 * Scripted model behaviour for the deterministic acceptance runs.
 *
 * One scenario drives one case. Each provider request is answered from the
 * request's own facts — the role line, the domain digest, the newest tool
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

import { ROLE_LINE, WORKER_HEADER, COMPACTION_MARKER, DIGEST_LINE_MARKER } from './mock-model.mjs';

const ROLE_TOOL_NAME = { orchestrator: 'flow_transaction', allocator: 'flow_allocation', auditor: 'flow_audit' };
const WORKER_TOOL_NAME = 'flow_transaction';

/** One assistant turn that calls a tool. */
export function call(name, args, extra = {}) {
  return { toolCalls: [{ name, arguments: JSON.stringify(args ?? {}) }], ...extra };
}

/** One assistant turn with no tool call: the turn ends on its own. */
export function say(text, extra = {}) {
  return { text, ...extra };
}

const STATUS_LINE = 'STATUS: the requested action was submitted; the durable result is in the ledger.';

/**
 * The checkpoint the harness's compaction engine requires: plain Markdown with
 * the exact sections its validator accepts, and no tool call.
 *
 * It also carries the identity and the plugin's own domain digest, because a
 * native compaction replaces the shadowed span — including the original prompt
 * — with this text. Without them the continuation request would address nobody.
 */
export function checkpointFor(classified) {
  const { role = null, nodeId = null, agentId = null, depth = null, transactionId = null, objective = null, digest = null } = classified ?? {};
  // Only what the next step of this turn needs. Carrying the whole digest made
  // the compacted session as large as the region it replaced — at a 64-file
  // tier the hidden prompt alone put the identity back over its own budget — so
  // the long `recent` transaction list is dropped and the rest is kept verbatim.
  const carried = digest ? {
    ...(digest.cluster ? { cluster: { id: digest.cluster.id ?? null, status: digest.cluster.status ?? null } } : {}),
    ...(digest.node ? { node: digest.node } : {}),
    ...(digest.ancestors ? { ancestors: digest.ancestors } : {}),
    ...(digest.pending_actions ? { pending_actions: digest.pending_actions.slice(0, 8) } : {}),
    ...(digest.unread_notifications ? { unread_notifications: digest.unread_notifications.slice(0, 8) } : {}),
    ...(digest.transactions ? { transactions: { by_status: digest.transactions.by_status ?? {} } } : {}),
    ...(digest.issues ? { issues: digest.issues.slice(0, 8) } : {}),
    ...(digest.children_of_node ? { children_of_node: digest.children_of_node } : {}),
    ...(digest.budget_available ? { budget_available: digest.budget_available } : {}),
    ...(digest.limits ? { limits: digest.limits } : {}),
  } : null;
  return [
    '## Primary Request and Intent',
    `Continue the cluster work for ${role ?? 'worker'} on node ${nodeId ?? 'unknown'}.`,
    '## Key Technical Concepts',
    'Hierarchical agent cluster; one transaction per Worker; independent validation.',
    '## Files and Code',
    'No file content is summarised here; read the transaction detail before acting.',
    '## Errors and Fixes',
    'None recorded in the shadowed region.',
    '## Pending Jobs',
    'Continue with the pending actions carried in the critical context below.',
    '## Current Work',
    'The turn was interrupted by context pressure; the durable ledger is authoritative.',
    '## Next Step',
    'Read the current domain state and perform the first pending action.',
    '## Critical Context',
    ...(role ? [`Role: ${role}. Node: ${nodeId} (depth ${depth ?? 0}). Agent id: ${agentId}.`] : []),
    ...(transactionId ? [`Transaction id: ${transactionId}`] : []),
    ...(objective ? [`Objective: ${objective}`] : []),
    ...(digest ? [`${DIGEST_LINE_MARKER}${JSON.stringify(carried)}`] : []),
  ].join('\n');
}

/** The budget rows a `flow_query what:"budgets"` result carried, or none. */
function budgetRows(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .filter(row => row && typeof row.scope_kind === 'string' && row.available && typeof row.available.tool_calls === 'number')
      .map(row => ({
        scope_kind: row.scope_kind,
        scope_id: String(row.scope_id ?? ''),
        available: {
          tool_calls: Number(row.available.tool_calls ?? 0),
          model_requests: Number(row.available.model_requests ?? 0),
        },
      }))
      .filter(row => row.scope_id);
  } catch {
    return [];
  }
}

/** A stable name for one pending item, so the script can tell them apart. */
function signatureOf(item) {
  return `${item.action}:${item.transaction_id ?? item.node_id ?? ''}`;
}

/**
 * The pending action this step should perform.
 *
 * When the digest came from a *checkpoint*, the turn is continuing after a
 * mid-turn compaction: the action this identity already performed is still
 * listed as pending in the digest the checkpoint preserved. Re-issuing it would
 * be refused (nothing changed) and the turn would be booked as stagnation, so
 * the script moves to the next distinct item — which is what the same model
 * would do from the same memory.
 */
function pickAction(request, ctx) {
  const digest = request.classified.digest;
  if (!digest) return null;
  const actions = (Array.isArray(digest.pending_actions) ? digest.pending_actions : [])
    .filter(item => item && item.action && item.action !== 'inbox');
  if (!actions.length) return null;
  const last = ctx.lastIssued.get(request.classified.agentId ?? '') ?? null;
  const chosen = request.classified.digest_source === 'checkpoint' && last
    ? actions.find(item => signatureOf(item) !== last) ?? null
    : actions[0];
  if (chosen) ctx.lastIssued.set(request.classified.agentId ?? '', signatureOf(chosen));
  return chosen;
}

function nearestAncestor(digest) {
  const ancestors = Array.isArray(digest?.ancestors) ? digest.ancestors : [];
  const management = ancestors.filter(entry => entry.kind === 'management');
  return management.sort((a, b) => Number(b.depth) - Number(a.depth))[0] ?? null;
}

/**
 * Orchestrator policy: perform the plugin's own first pending action. The
 * digest is the plugin's statement of what this identity owes, so the script
 * never invents work — it only decides *how* to answer the action.
 *
 * A digest that came out of a checkpoint rather than the current prompt is the
 * state the compacted span was acting on, not the state now. Answering from it
 * would re-issue an action that has already happened, so such a step ends the
 * turn instead and lets the scheduler prompt this identity with fresh state.
 */
function orchestratorReply(request, ctx) {
  const item = pickAction(request, ctx);
  if (!item) return say(`No pending action for node ${request.classified.nodeId}. ${STATUS_LINE}`);
  const hook = ctx.hooks.orchestrator;
  if (hook) {
    const custom = hook(request, item, ctx);
    if (custom) return custom;
  }
  const params = request.classified.digest?.cluster ? {} : {};
  switch (item.action) {
    case 'dispatch':
    case 'replan-or-redispatch':
      // A node-level dispatch covers every DRAFT transaction it owns, so the
      // whole tier becomes READY in one turn instead of one per transaction.
      // Serialising the frontier also serialises the ladder: measured, a
      // turn-per-transaction dispatch left one Worker running at a time and
      // exhausted the tier's request budget before the last files were read.
      return call('flow_transaction', {
        action: 'dispatch',
        params: { node_id: request.classified.nodeId, limit: 64 },
      });
    case 'revise-plan':
    case 'correct-result':
      return call('flow_transaction', {
        action: 'adjust_transaction',
        params: ctx.revisionFor(item) ?? { transaction_id: item.transaction_id, priority: 0 },
      });
    case 'validate':
      return call('flow_transaction', {
        action: 'validate',
        params: {
          transaction_id: item.transaction_id,
          accepted: true,
          checks: [{
            criterion: String(item.objective ?? 'the transaction objective is satisfied'),
            passed: true,
            evidence: 'the submitted result and the tool results recorded in this session',
          }],
        },
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
      const parent = nearestAncestor(request.classified.digest);
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

/** Allocator policy: identity, topology and funding, again from the digest. */
function allocatorReply(request, ctx) {
  // The answer to a ledger read that this turn opened: the turn may have no
  // pending action of its own, and the rebalance is the action it exists for.
  const rebalanceReply = () => {
    if (request.classified.lastToolName !== 'flow_query') return null;
    const rows = budgetRows(request.classified.lastToolResult);
    const richest = rows
      .filter(row => row.scope_kind === 'agent' && row.scope_id !== request.classified.agentId)
      // Requests weigh more than tool calls here: a Worker with a full tool-call
      // grant and no requests cannot start at all, and the ladder binds on
      // whichever dimension runs out first.
      .sort((a, b) => (b.available.model_requests * 2 + b.available.tool_calls)
        - (a.available.model_requests * 2 + a.available.tool_calls))[0] ?? null;
    if (!richest || (richest.available.tool_calls <= 0 && richest.available.model_requests <= 0)) return null;
    const frontier = Number(request.classified.digest?.transactions?.by_status?.READY ?? 0);
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
          model_requests: Math.min(Math.max(2 * frontier, 32), Math.max(16, Math.floor(richest.available.model_requests / 2))),
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
  const digest = request.classified.digest ?? {};
  const actions = Array.isArray(digest.pending_actions) ? digest.pending_actions : [];
  const nodeToolCalls = Number(digest.budget_available?.tool_calls ?? Number.POSITIVE_INFINITY);
  const nodeRequests = Number(digest.budget_available?.model_requests ?? Number.POSITIVE_INFINITY);
  const frontier = Array.isArray(item.transactions) ? item.transactions.length : 0;
  const isRoot = (digest.ancestors ?? []).length === 0;
  const topUps = ctx.rebalanced.get(request.classified.nodeId) ?? 0;

  // A node can only host as many Workers as it has free child slots. Allocating
  // the whole ready frontier at once therefore fails partway with
  // `reached max_children` and leaves the rest of the tier unable to start; the
  // ladder has to go in waves, releasing each wave's finished Workers so their
  // slots — and their nodes — are reused.
  const children = Array.isArray(digest.children_of_node) ? digest.children_of_node : [];
  const liveChildren = children.filter(child => child.status !== 'RELEASED');
  const childLimit = Number(digest.node?.max_children ?? children.length) || children.length;
  const freeSlots = Math.max(0, childLimit - liveChildren.length);

  // Only a cluster's own root *ladder* is topped up: a delegated node is funded
  // down its ancestor chain. The question is not what the current window needs
  // but what the node still owes — every remaining Worker needs a couple of
  // requests and its designed tool-call allowance — so a node that can fill the
  // window but not the work behind it is topped up before its Workers are born
  // with an allowance of zero. At 64 files this is the dimension that binds: the
  // node spent its whole request share while its tool calls were untouched.
  const owed = Number(actions.find(entry => entry.action === 'allocate_agent')?.unallocated_total ?? frontier);
  // A Worker is funded from the node for its whole allowance, so the node must
  // be able to pay for every Worker in the batch. Allocating more than it can
  // fund leaves the last Workers of the wave with an allowance of zero — they
  // cannot send even their first request, their turns fail, and the transaction
  // ends FAILED. The batch is therefore sized by what the node can actually
  // cover, and a node that can cover nothing is topped up first; a turn that
  // allocated work it could not fund used to burn the whole tier.
  const perWorkerRequests = Number(ctx.limits?.worker_model_requests) || 8;
  // Only requests bound the batch: a Worker's tool-call grant is generous and
  // its unspent part returns to the node on release, while a Worker with no
  // requests cannot start at all. Sizing by tool calls split the ladder into
  // waves of two and spent the tier's own request budget on allocation turns.
  const affordable = Number.isFinite(nodeRequests)
    ? Math.floor(nodeRequests / perWorkerRequests)
    : Infinity;
  const needsRequests = 2 * owed + 16;
  const needsToolCalls = 32 * Math.min(owed, Math.max(1, freeSlots)) + 32;
  if (isRoot && item.action === 'allocate_agent' && owed >= 8 && topUps < 3 && affordable <= 0
    && (nodeRequests < needsRequests || nodeToolCalls < needsToolCalls)) {
    ctx.rebalanced.set(request.classified.nodeId, topUps + 1);
    return call('flow_query', { what: 'budgets', params: { limit: 50 } });
  }

  const releaseFirst = () => {
    const release = actions.find(entry => entry.action === 'release_agent');
    if (release) {
      return call('flow_allocation', {
        action: 'release_agent',
        params: { allocations: release.allocations ?? [] },
      });
    }
    return say(`Node ${request.classified.nodeId} has no free child slot and nothing to release yet. ${STATUS_LINE}`);
  };
  switch (item.action) {
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
      const batch = (item.transactions ?? []).slice(0, room);
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
        params: { allocations: item.allocations ?? [] },
      });
    case 'spawn_management_node': {
      const instruction = item.instruction ?? {};
      const transactionId = digest.node?.delegated_transaction_id ?? null;
      if (!transactionId) return say(`No delegated transaction to delegate from on node ${request.classified.nodeId}. ${STATUS_LINE}`);
      return call('flow_allocation', {
        action: 'spawn_management_node',
        params: {
          transaction_id: transactionId,
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
      const reference = value => (value
        ? { kind: value.kind ?? value.scope_kind, id: value.id ?? value.scope_id }
        : null);
      const from = reference(item.from) ?? reference(item.from_options?.[0]);
      const to = reference(item.to) ?? reference(item.starved_agents?.length
        ? { kind: 'agent', id: item.starved_agents[0] } : null);
      if (!from || !to || !from.id || !to.id) {
        return say(`No executable rebalance on node ${request.classified.nodeId}. ${STATUS_LINE}`);
      }
      // The hint for a starved Worker carries the agent but no envelope; the
      // plugin's own Worker grant is the amount that makes it runnable again.
      // Moving an empty amount is a successful command that changes nothing, and
      // the hint then repeats until the Allocator has no turns left.
      const amounts = item.required ?? (item.starved_agents?.length
        ? { tokens: 65_536, model_requests: 8, tool_calls: 32 }
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
function auditorReply(request, ctx) {
  const item = pickAction(request, ctx);
  if (!item) return say(`No pending audit action for node ${request.classified.nodeId}. ${STATUS_LINE}`);
  const hook = ctx.hooks.auditor;
  if (hook) {
    const custom = hook(request, item, ctx);
    if (custom) return custom;
  }
  switch (item.action) {
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
      const metrics = Array.isArray(item.dimensions) ? item.dimensions : [];
      return call('flow_audit', {
        action: 'evaluate_health',
        params: {
          evaluation_window: 'subtree-close',
          dimensions: Object.fromEntries(metrics.map(name => [name, 0.9])),
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
export function sumValues(text) {
  const source = String(text ?? '');
  const groups = [...source.matchAll(/\[([^\]]*)\]/gu)]
    .map(match => match[1].split(',').map(value => Number(value.trim())))
    .filter(values => values.length && values.every(Number.isFinite));
  if (!groups.length) return null;
  return groups.flat();
}

/** The number a real `flow_sum` tool result carried, or null. */
export function sumFromToolResult(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(String(text ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** Default Worker policy: call the real tool, then submit what it returned. */
function workerReply(request, ctx) {
  const hook = ctx.hooks.worker;
  if (hook) {
    const custom = hook(request, ctx);
    if (custom) return custom;
  }
  const classified = request.classified;
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

/**
 * Case-specific behaviour. Everything not named here falls back to the
 * plugin-driven default policy, so a case only has to describe what makes it
 * different.
 */
const CASE_HOOKS = {
  /**
   * The panel drives pause, resume and cancel from a real page. It can only do
   * that while the cluster is still live, so the final closeout request is held
   * on a named barrier until the checker has finished driving the panel and is
   * about to cancel. The hold is a slow model, not a stopped plugin: the SSE
   * stream stays open.
   */
  panel: () => ({
    orchestrator: (request, item) => (item.action === 'finish_cluster'
      ? { ...call('flow_transaction', { action: 'finish_cluster', params: {} }), hold: 'panel-hold' }
      : null),
  }),
  recursion: context => recursionHooks(context),
  recovery: context => recoveryHooks(context),
  scale: context => scaleHooks(context),
  browser: () => browserHooks(),
};

/**
 * The recursion case: an asymmetric tree, one injected write-scope fault, and a
 * real correction round.
 *
 * Every step is keyed by the identity the plugin itself reports — the node's
 * digest, the transaction objective in the Worker prompt, the allocation's
 * granted paths — never by arrival order. The fixture ids come from the runner's
 * own namespace map, so the script names the same transactions the case does.
 */
function recursionHooks({ fixtureIds, workspace }) {
  const deepTx = fixtureIds['rec-deep'] ?? 'rec-deep';
  const flatTx = fixtureIds['rec-flat'] ?? 'rec-flat';
  const verifyTx = fixtureIds['rec-verify'] ?? 'rec-verify';
  const state = {
    dependencySet: false,
    needsRevision: null,
    // Per transaction: every result the fixture's Workers actually submitted,
    // in order, with what they reported. Auditor verdicts are bound to this.
    submissions: new Map(),
    // Per transaction: how many submissions existed when its issue was raised. A
    // correction is verified only against work that came after.
    raisedFor: new Map(),
  };
  const recordSubmission = (txId, entry) => {
    const list = state.submissions.get(txId) ?? [];
    list.push(entry);
    state.submissions.set(txId, list);
  };
  const target = join(workspace, 'deep/nested/result.txt');
  const refused = text => /outside|refus|denied|not allowed|is not permitted|cannot write|scope/i.test(String(text ?? ''));

  return {
    /** Record the objective of every transaction the role is about to dispatch. */
    orchestrator(request, item) {
      const c = request.classified;
      const digest = c.digest ?? {};
      const isRoot = (digest.ancestors ?? []).length === 0;
      // The verifier must count a fixed corpus: make its dependency explicit
      // before any dispatch, instead of relying on the order workers happen to
      // finish in.
      if (isRoot && !state.dependencySet) {
        state.dependencySet = true;
        return call('flow_transaction', {
          action: 'set_dependency',
          params: { transaction_id: verifyTx, depends_on: [deepTx, flatTx] },
        });
      }
      if (state.needsRevision && item.action === 'correct-result' && item.transaction_id === state.needsRevision) {
        // The deepest branch was granted `deep/staging` for a deliverable at
        // `deep/nested`; the correction is to give it the scope the work needs.
        return call('flow_transaction', {
          action: 'adjust_transaction',
          params: { transaction_id: item.transaction_id, inputs: { write_scope: ['deep/'] } },
        });
      }
      return null;
    },
    allocator(request, item) {
      const c = request.classified;
      const digest = c.digest ?? {};
      const pending = (digest.pending_actions ?? []).filter(entry => entry.action === 'spawn_management_node');
      if (!pending.length) return null;
      const instruction = pending[0].instruction ?? {};
      // The delegation has to happen before the allocator hands the same
      // transaction to a Worker: a delegated parent waits for its children, and
      // a Worker allocated first would take the branch the fixture delegates.
      const isRoot = (digest.ancestors ?? []).length === 0;
      const transactionId = isRoot ? deepTx : digest.node?.delegated_transaction_id;
      if (!transactionId) return null;
      return call('flow_allocation', {
        action: 'spawn_management_node',
        params: {
          transaction_id: transactionId,
          node_id: c.nodeId,
          scope: { objective: instruction.objective ?? 'delegated deep branch' },
          max_children: instruction.max_children ?? 4,
          ...(instruction.spawn_children === undefined ? {} : { spawn_children: instruction.spawn_children }),
        },
      });
    },
    worker(request, ctx) {
      const c = request.classified;
      const objective = c.objective ?? '';
      const scopeLine = /You own these paths \(do not write outside them\): (.+)/u.exec(c.userText ?? '')?.[1] ?? '';
      const scopeEntries = scopeLine.split(',').map(entry => entry.trim()).filter(Boolean);
      const lastTool = c.lastToolName;
      const lastResult = c.lastToolResult ?? '';

      if (objective.includes('deep/nested/result.txt')) {
        if (lastTool === 'write') {
          const writeOk = !refused(lastResult) && existsSync(target);
          // The submission is what the Auditor judges, so it is recorded as the
          // fixture's own evidence — including whether the result is complete.
          const entry = {
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
    auditor(request, item, ctx) {
      // Every decision here is bound to evidence the fixture itself observed:
      // a Worker that submitted a result it marked incomplete, and a *later*
      // submission for the same transaction. Deciding from the objective text or
      // from "the plan changed" is what produced a rejected good result and an
      // issue verified before any replacement work existed.
      const submissions = state.submissions.get(item.transaction_id) ?? [];
      // A `flow_query what:"transaction"` answer, when this step just made one:
      // the plugin's own published view of the transaction a verdict is about.
      const queriedTransaction = (() => {
        if (request.classified.lastToolName !== 'flow_query') return null;
        try {
          return JSON.parse(String(request.classified.lastToolResult ?? ''))?.transaction ?? null;
        } catch {
          return null;
        }
      })();
      // Any corrective action this Auditor takes starts the evidence window for
      // that transaction: from here, only work submitted later can answer it.
      if (item.transaction_id && ['request_correction', 'request_replan', 'request_revalidation'].includes(item.action)) {
        state.raisedFor.set(item.transaction_id, submissions.length);
      }
      if (item.action === 'inspect_validation') {
        const outstanding = state.needsRevision === item.transaction_id;
        if (outstanding) {
          const latest = submissions[submissions.length - 1] ?? null;
          // From here on, only work submitted *after* this point can answer it.
          state.raisedFor.set(item.transaction_id, submissions.length);
          return call('flow_audit', {
            action: 'inspect_validation',
            params: {
              transaction_id: item.transaction_id,
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
        return call('flow_audit', {
          action: 'inspect_validation',
          params: {
            transaction_id: item.transaction_id,
            decision: 'approve',
            evidence: { reason: 'the recorded result revision satisfies the acceptance criteria for this transaction' },
          },
        });
      }
      if (item.action === 'verify_correction' || item.action === 'review_issue') {
        const issueId = item.issue_id;
        const required = state.raisedFor.get(item.transaction_id) ?? null;
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
 * and the Auditor's validation review of `r4` is held on a named barrier, so
 * the runner can kill the host while that identity is genuinely in flight.
 */
function recoveryHooks({ fixtureIds, runId }) {
  const findBySuffix = suffix => Object.entries(fixtureIds ?? {}).find(([key]) => key.endsWith(suffix))?.[1];
  const r3 = findBySuffix('-r3');
  const r4 = findBySuffix('-r4');
  const blackboardKey = `${runId ?? ''}/total`;
  const state = { dependencySet: false, published: false, held: false };
  return {
    orchestrator(request, item, ctx) {
      const digest = request.classified.digest ?? {};
      const statuses = digest.transactions?.by_status ?? {};
      if (!state.dependencySet && r3 && r4) {
        state.dependencySet = true;
        return call('flow_transaction', {
          action: 'set_dependency',
          params: { transaction_id: r4, depends_on: [r3] },
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
    auditor(request, item) {
      if (item.action !== 'inspect_validation') return null;
      if (r4 && item.transaction_id !== r4) return null;
      if (state.held) return null;
      // Held exactly once: after the restart the same review must be answerable,
      // or the cluster could never finish the work the crash interrupted.
      state.held = true;
      return {
        ...call('flow_audit', {
          action: 'inspect_validation',
          params: { transaction_id: item.transaction_id, decision: 'approve', evidence: { note: 'result revision checked against the recorded tool result' } },
        }),
        hold: 'recovery-r4-validation',
      };
    },
  };
}

/**
 * The scale ladder: one Worker per generated file. The symbol and the line are
 * read out of the *real* read-tool result, never from the fixture's expected
 * table, so the value a transaction submits is evidence that the file was
 * really read in that Worker's own session.
 */
function scaleHooks({ workspace, limits }) {
  const state = { held: 0, holdBudget: Number(limits?.max_llm_concurrency ?? 0) };
  /** The declaration the read tool actually returned, with the line it sat on. */
  const parse = text => {
    const lines = String(text ?? '').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      // The tool may prefix each line with its number; when it does, that is the
      // line the Worker saw, and it is what must be quoted back.
      const numbered = /^\s*(\d+)[:|]\s?(.*)$/u.exec(lines[index])
        ?? /^\s*(\d+)\t(.*)$/u.exec(lines[index]);
      const body = numbered ? numbered[2] : lines[index];
      const match = /export\s+function\s+(\w+)/u.exec(body);
      if (match) return { symbol: match[1], line: numbered ? Number(numbered[1]) : index + 1 };
    }
    const inline = /export\s+function\s+(\w+)/u.exec(String(text ?? ''));
    if (inline) {
      const before = String(text).slice(0, inline.index).split('\n').length;
      return { symbol: inline[1], line: before };
    }
    return { symbol: null, line: null };
  };
  const relativeOf = objective => /Read the file (\S+) \(relative to the workspace\)/u.exec(String(objective ?? ''))?.[1] ?? null;
  return {
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
function browserHooks() {
  const state = { noticeDismissed: false, clicked: false, ref: null };
  const NAV = 'mcp__playwright-mcp__browser_navigate';
  const SNAPSHOT = 'mcp__playwright-mcp__browser_snapshot';
  const CLICK = 'mcp__playwright-mcp__browser_click';
  /** The accessibility ref of the control whose accessible name contains X. */
  const refFor = (text, pattern) => {
    for (const line of String(text ?? '').split('\n')) {
      if (!pattern.test(line)) continue;
      const ref = /ref=([A-Za-z0-9_-]+)/u.exec(line);
      if (ref) return ref[1];
    }
    return null;
  };
  const titleOf = text => /^-\s*Page Title:\s*(.+)$/imu.exec(String(text ?? ''))?.[1]?.trim() ?? null;
  return {
    worker(request) {
      const c = request.classified;
      const raw = /\b(https?:\/\/\S+)/u.exec(`${c.objective ?? ''} ${c.userText ?? ''}`)?.[1] ?? null;
      // The URL is quoted inside an English sentence, so trailing punctuation
      // belongs to the sentence, not to the query string.
      const url = raw ? raw.replace(/[),.;:!?]+$/u, '') : null;
      const last = c.lastToolName;
      if (!url) return null;
      if (!last) return call(NAV, { url });
      if (last === NAV) return call(SNAPSHOT, {});
      if (last === CLICK) return call(SNAPSHOT, {});
      if (last === SNAPSHOT) {
        const text = String(c.lastToolResult ?? '');
        // The shipped app opens with an internal-testing notice that covers the
        // frame; a real page must acknowledge it before the panel is clickable.
        if (!state.noticeDismissed) {
          const notice = refFor(text, /button\s+"continue"/iu);
          state.noticeDismissed = true;
          if (notice) return call(CLICK, { target: notice });
        }
        if (!state.clicked) {
          const ref = refFor(text, /cluster/iu);
          if (!ref) throw new Error(`no Cluster control ref in the snapshot: ${text.slice(0, 600)}`);
          state.ref = ref;
          state.clicked = true;
          return call(CLICK, { target: ref });
        }
        const title = titleOf(text);
        const heading = /heading "Hierarchical agent cluster"/iu.test(text);
        if (!title || !heading) {
          throw new Error(`the post-click snapshot lacks the panel heading or page title: ${text.slice(0, 600)}`);
        }
        return call('flow_transaction', {
          action: 'submit_result',
          params: {
            transaction_id: c.transactionId,
            result: {
              page_title: title,
              heading: 'Hierarchical agent cluster',
              ref: state.ref,
              tools: ['browser_navigate', 'browser_snapshot', 'browser_click'],
            },
            notes: 'navigated to the host page, dismissed its notice, clicked the Cluster control by its snapshot ref and snapshotted the opened panel',
          },
        });
      }
      return null;
    },
  };
}

export function caseHooks(caseId, context = {}) {
  return CASE_HOOKS[caseId]?.(context) ?? {};
}

/**
 * Build one case scenario. `hooks` are the case-specific parts; everything the
 * case does not override falls back to the plugin-driven default policy.
 */
export function buildScenario({
  caseId, layout = null, workspace = null, fixtureIds = {}, runId = null, limits = null, hooks = null, expectations = {},
} = {}) {
  const resolvedHooks = hooks && Object.keys(hooks).length
    ? hooks
    : caseHooks(caseId, { fixtureIds, workspace, layout, runId, limits });
  const seen = { compaction: 0, role: {}, worker: {}, digest_missing: 0 };
  const problems = [];
  const ctx = {
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
  return {
    name: `mock:${caseId}`,
    respond(request) {
      const classified = request.classified;
      if (classified.kind === 'compaction') {
        seen.compaction += 1;
        return say(checkpointFor(classified));
      }
      if (classified.kind === 'role') {
        const key = `${classified.role}:${classified.agentId}`;
        seen.role[key] = (seen.role[key] ?? 0) + 1;
        if (!ROLE_TOOL_NAME[classified.role]) {
          throw new Error(`unknown cluster role ${JSON.stringify(classified.role)} in the role prompt`);
        }
        if (!classified.digest) {
          // A native compaction can shadow the prompt that carried the digest,
          // and the harness's own checkpoint does not restore it. The honest
          // answer is to end the turn: the scheduler re-prompts this identity
          // with current state. Inventing an action from nothing would be the
          // fixture deciding the plugin's work.
          seen.digest_missing += 1;
          return say(`The ${classified.role} prompt arrived without a domain digest after compaction. ${STATUS_LINE}`);
        }
        if (classified.role === 'orchestrator') return orchestratorReply(request, ctx);
        if (classified.role === 'allocator') return allocatorReply(request, ctx);
        return auditorReply(request, ctx);
      }
      if (classified.kind === 'worker') {
        const key = classified.transactionId ?? 'unknown';
        seen.worker[key] = (seen.worker[key] ?? 0) + 1;
        return workerReply(request, ctx);
      }
      throw new Error(`unrecognised model request: no role line, no worker header and no compaction directive (${classified.messageCount} messages)`);
    },
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
        digest_missing: seen.digest_missing,
        checks: [],
        problems: issues,
        ...(ctx.hooks.reportEvidence ? { fixture_evidence: ctx.hooks.reportEvidence() } : {}),
      };
    },
  };
}

export { ROLE_LINE, WORKER_HEADER, COMPACTION_MARKER, ROLE_TOOL_NAME };