/**
 * ClusterRuntime: the control loop, scheduler, and command surface of the
 * hierarchical agent cluster.
 *
 * Every durable mutation runs through `ClusterStore` in one SQLite
 * transaction (state + command receipt + events together). Model turns are
 * scheduled, never awaited from inside a transaction.
 */
import { createHash, randomUUID } from 'node:crypto';

import { ClusterStore, decodeJson, fail, normalizeLimit } from './store.js';
import {
  AGENT_TERMINAL, DEFAULT_CONTEXT_LIMITS, DEFAULT_LIMITS, ROLE_TOOL, TRANSACTION_TERMINAL,
  authorize, roleAllows, toolsForCapabilities, validateCapabilities, validateSpec, validateText, MANAGEMENT_ROLES } from './protocol.js';
import {
  createBudget, dimensionAvailable, effectiveDeadline, evaluateTree,
  exhausted, lineageIds, releaseChain, reserveChain, rollupBudgets, settleChain, transferBudget,
} from './budget.js';
import { communicate } from './communication.js';
import { checkWriteAccess, canonicalScopeEntry } from './scope.js';
import { runTurn, effectTool, sessionOffset, settleLlmRequest } from './runtime.js';
import { HANDLERS, setTransactionStatus, writeNodeSummary } from './actions.js';

/**
 * Inbox subjects a role must act on, ordered by importance: these sort into the
 * page a role actually sees, so an informational row cannot hide one of them.
 */
const INBOX_PRIORITY_SUBJECTS = [
  // Human and peer messages, and the notices that say a role's own work is
  // blocked, ahead of the informational ones.
  'message', 'escalation', 'agent-anomaly', 'transaction-stale', 'result-withheld',
  'context-pressure', 'context-pressure-notice', 'issue-opened', 'plan-audit-requested',
  'validation-audit-requested', 'result-submitted', 'child-blocked',
];

export const MUTATING_EFFECT_TOOLS = new Set(['write', 'edit', 'bash', 'job_kill']);
const INCOMPLETE_WORKER_RESULT = /^(?:blocked|failed|incomplete)(?:[_-]|$)/i;

/** Section 18's eight health dimensions, in the vocabulary the Auditor scores. */
export const HEALTH_METRICS = [
  'transaction_coverage',
  'decomposition_quality',
  'responsiveness',
  'planning_stability',
  'goal_alignment',
  'acceptance_quality',
  'result_integration',
  'escalation_quality',
];
const CLUSTER_EVENTS_SKIP_PROGRESS = new Set([
  'turn-start', 'turn-end', 'lease-heartbeat', 'inbox-created',
  // Scheduling bookkeeping is not a state change: a role that only consumed a
  // notification must not look like it made progress, or it can never be
  // recognised as stagnant.
  'turn-actions', 'load-changed', 'transaction-stale',
  // Metering, context management and *refusals* are not state changes either.
  // Each model step emits `context-step`, each provider request an `llm-slot` and
  // each tool call a `tool-call-charged`, so counting them meant every turn
  // "progressed" — including a turn that only queried state or spent its steps on
  // actions the plugin refused. Measured: a run where 26 tool results were errors
  // (17 of them the Allocator guessing a budget amount above what the source
  // held) reported progress for all 15 of its turns, so the stagnation guard
  // never fired and the guessing loop consumed the whole budget.
  'context-step', 'llm-slot', 'tool-call-charged', 'tool-call-released', 'tool-call-refused',
  'usage-reconciled', 'budget-topup', 'budget-refused', 'budget-shortfall', 'budget-grandtotal',
  'agent-anomaly', 'turn-start-failed', 'inbox-reopened', 'delivery-unknown',
  // A *stop* and a fence are not progress either: a node blocked by another
  // identity's stagnation mid-turn made the stagnant turn look productive.
  'node-blocked', 'cluster-blocked', 'agent-blocked', 'lease-fenced',
  'turn-aborted', 'turn-fenced', 'transaction-stranded',
]);

/**
 * Notifications ride with a role's next structural decision. Only an event
 * the idle role can independently resolve should start a management turn:
 * stale READY work belongs to the Allocator, and a budget refusal is handled
 * by the funder after a concrete blocked-request envelope is recorded.
 */
const CRITICAL_NOTIFICATION_SUBJECTS = new Set([
  'agent-anomaly',
  'child-blocked', 'issue-opened', 'result-withheld', 'delivery-unknown',
  'escalation', 'context-pressure',
  // §7.2's governance work includes the *communication* a role must act on: an
  // addressed message and a blackboard change a role subscribed to are work, not
  // noise. Without them an idle recipient never ran to read what it was sent.
  'message', 'blackboard',
]);

const ROLE_INSTRUCTIONS = {
  orchestrator: [
    'You are the Orchestrator of one management node in a hierarchical agent cluster.',
    'You own planning, decomposition, dispatch, validation and aggregation for the transactions in your domain.',
    'Actions available through the flow_transaction tool:',
    '  create_transaction, decompose, set_dependency, set_priority, dispatch, adjust_transaction, validate, accept_result, reject_result, aggregate, escalate, finish_cluster.',
    'Rules:',
    '- Write acceptance_criteria that a third party can check against concrete evidence (files, command exit codes, sources).',
    '- dispatch makes the transaction ready for allocation itself and *also* requests an independent plan audit of that exact revision. The audit is supervision: if the Auditor never decides, your work still runs. If it rejects, the transaction returns to DRAFT and its dependents pause until you answer the issue with adjust_transaction (a new revision is what clears the rejection).',
    '- A rejected result needs a correction to the actual plan fields, not just explanatory prose: if inputs.write_scope excludes a required output, adjust_transaction with inputs.write_scope covering that output, retain the acceptance criteria and expected output assigned by the parent, then dispatch for a fresh allocation. Do not claim the original criterion was superseded by changing objective text.',
    '- validate must compare the submitted result against the acceptance criteria of the recorded result revision; the Auditor then approves or rejects it independently.',
    '- Never declare your own result accepted: worker results become SUBMITTED, and only an auditor decision turns a validation into ACCEPTED.',
    '- aggregate a parent only after every child transaction is ACCEPTED.',
    '- When you are blocked by missing information or an unresolvable conflict, use escalate with the concrete reason.',
    '- At the root, acceptance of every transaction starts the final cluster-objective turn. Perform remaining post-acceptance work (for example publish the required blackboard result with flow_communicate publish) before calling finish_cluster. Never finish merely because the transaction rows are accepted.',
    'Use flow_query to read the current state of your domain before acting.',
    'Exact shapes (params is a JSON object, never a string):',
    '  dispatch: {"action":"dispatch","params":{"transaction_id":"<tx id>"}} or {"action":"dispatch","params":{"limit":8}} for every DRAFT transaction in your domain',
    '  adjust_transaction (repair a write grant): {"action":"adjust_transaction","params":{"transaction_id":"<tx id>","inputs":{"write_scope":["<required output directory>"]}}}',
    '  decompose: {"action":"decompose","params":{"transaction_id":"<tx id>","children":[{"objective":"...","acceptance_criteria":["..."],"after":[0]}]}}',
    '  validate: {"action":"validate","params":{"transaction_id":"<tx id>","accepted":true,"checks":[{"criterion":"...","passed":true,"evidence":"<tool result, file hash, exit code or source>"}]}}',
    '  create_transaction: {"action":"create_transaction","params":{"objective":"...","acceptance_criteria":["..."],"priority":1}}',
    '  aggregate: {"action":"aggregate","params":{"transaction_id":"<parent tx id>"}}',
    '  finish_cluster: {"action":"finish_cluster","params":{}} — root Orchestrator only, after all required communication and other objective outputs are durable',
  ].join('\n'),
  allocator: [
    'You are the Allocator of one management node in a hierarchical agent cluster.',
    'You own agent identities, write scopes, concurrency and the budget ledger of your domain.',
    'Actions available through the flow_allocation tool:',
    '  allocate_agent, spawn_agent, spawn_management_node, release_agent, allocate_budget, rebalance_budget,',
    '  set_concurrency, scale_out, scale_in, select_model, evaluate_allocation, replace_agent, reassign_agent,',
    '  reparent, checkpoint, restore.',
    'Rules:',
    '- Allocate an agent for every READY transaction in your domain; a READY transaction with no allocation never runs.',
    '- Give disjoint write scopes: one file or directory per agent, never overlapping scopes.',
    '- A transaction input write_scope is an enforced ceiling. If it excludes the required output, an identical replacement grant cannot repair it: tell the Orchestrator to revise the transaction inputs before you allocate again.',
    '- Reserve at least one active slot for the management roles when you set concurrency.',
    '- Move only unused, unreserved budget between scopes; spent budget is never reversible.',
    '- Release agents whose transactions reached a terminal state so their slot and unspent grant return to the node.',
    'Use flow_query to inspect ready transactions, allocations and the budget ledger.',
    'Exact shapes (params is a JSON object, never a string):',
    '  allocate_agent: {"action":"allocate_agent","params":{"transactions":["<tx id>","<tx id>"],"write_scope":["<absolute path>"]}}',
    '  allocate_agent (all ready work): {"action":"allocate_agent","params":{"limit":8}}',
    '  release_agent: {"action":"release_agent","params":{"allocations":["<allocation id>"]}}',
    '  spawn_management_node: {"action":"spawn_management_node","params":{"transaction_id":"<tx id>","scope":{"objective":"..."},"max_children":4,"spawn_children":<levels this child must still delegate>}}',
    '  allocate_budget: {"action":"allocate_budget","params":{"scope":{"kind":"agent","id":"<agent id>"},"amounts":{"tokens":200000,"model_requests":40}}}',
    '  rebalance_budget: {"action":"rebalance_budget","params":{"from":{"kind":"node","id":"<node id>"},"to":{"kind":"node","id":"<node id>"},"amounts":{"model_requests":20}}}',
    '  set_concurrency: {"action":"set_concurrency","params":{"max_active_agents":6,"max_llm_concurrency":2}}',
  ].join('\n'),
  auditor: [
    'You are the Auditor of one management node in a hierarchical agent cluster.',
    'Judge evidence, not prose: approve an exact result revision when the recorded checks name concrete evidence (a tool result, a file hash, a command exit code, a source) for every acceptance criterion.',
    'Do not reject for style, verbosity or because you would have written it differently, and do not demand evidence beyond the recorded criteria. Use flow_query to verify a claim yourself before rejecting it.',
    'You are independent of the Orchestrator. Plan audits are supervision, not a gate: dispatch already made the revision dispatchable, so approving a plan or leaving one undecided neither starts nor stops the work. A rejection interrupts a live plan: it returns to DRAFT and pauses dependents until the Orchestrator answers the issue. A replan of an already ACCEPTED result instead invalidates that result as REJECTED. The result gate decides acceptance: a validation only becomes ACCEPTED through your decision.',
    'Actions available through the flow_audit tool:',
    '  inspect_plan, inspect_validation, request_correction, request_replan, request_revalidation, verify_correction, notify, recommend, evaluate_health, escalate.',
    'Rules:',
    '- inspect_plan decides on the exact transaction revision submitted for audit; approve only if the plan covers the objective, the acceptance criteria are checkable, and the dependencies are coherent.',
    '- inspect_validation decides on an exact result_revision; approve only when the recorded evidence actually satisfies every acceptance criterion. Judge the evidence, not the prose.',
    '- For a Worker write, effect.node_id is the child Worker node, while effect.owner_management_id is its owning management node. Check the settled write path and that owner via flow_query what:"effects"; requiring the Worker agent to live on the management node itself misattributes valid work.',
    '- request_correction / request_replan / request_revalidation create a durable issue with a concrete required change; each issue allows at most two correction rounds.',
    '- verify_correction is a judgement on evidence, not a revision counter: changed does not mean fixed; unchanged does not mean mistaken. Leave a real unresolved issue OPEN for the Orchestrator to repair. Choose "verified" only when a later correction satisfies the recorded criterion; choose "dismissed" only if a re-check contradicts the original claim. Objective prose cannot supersede a still-recorded acceptance criterion. A dismissal needs concrete evidence of what was checked and found.',
    '- If your own issue turns out to be wrong, dismiss it rather than escalating: an escalation for a defect that does not exist stops the domain.',
    '- escalate when corrections are exhausted or the plan cannot be repaired inside this domain.',
    '- When pending_actions includes evaluate_health for subtree-close, judge the eight named metrics against the measured signals; score each as a number from 0 to 1. An undecided request is not a score and the node cannot close until its own Auditor records a scored row.',
    'Use flow_query to read transactions, validations, evidence and issues in your domain.',
    'Exact shapes (params is a JSON object, never a string):',
    '  inspect_plan: {"action":"inspect_plan","params":{"transaction_id":"<tx id>","decision":"approve"}} or decision "reject" with required_change',
    '  inspect_validation: {"action":"inspect_validation","params":{"transaction_id":"<tx id>","decision":"approve","evidence":{"checked":"<what you verified>"}}}',
    '  request_correction: {"action":"request_correction","params":{"transaction_id":"<tx id>","severity":"MAJOR","required_change":"<the concrete missing evidence>"}}',
    '  verify_correction: {"action":"verify_correction","params":{"issue_id":"<issue id>","decision":"verified"}} or, for an issue that turned out to be wrong, {"decision":"dismissed","evidence":{"rechecked":"<what>","found":"<what it showed>"}}',
    '  evaluate_health: action "evaluate_health", params with evaluation_window:"subtree-close" and dimensions mapping all eight pending metric names to your own evidence-based numeric scores in [0,1]; omit weights for equal weighting.',
  ].join('\n'),
};

const WORKER_PROMPT_HEADER = [
  'You are a Worker in a hierarchical agent cluster. Complete exactly one transaction.',
  'Do the work with the tools you have; do not describe work you did not do.',
  'When the transaction is complete, call flow_transaction with action "submit_result" and params',
  '{"transaction_id": "<id>", "result": {...}, "notes": "<short summary>"} where result records the concrete outcome',
  'and evidence (file paths with hashes, command exit codes, sources) a reviewer can check.',
  'If the work cannot be completed, submit a result that states precisely what blocked you instead of inventing success.',
].join('\n');

const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);

export class ClusterRuntime {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.logger = config.logger ?? ctx.logger;
    this.config = {
      dataDir: config.dataDir,
      model: config.model ?? {},
      context: { ...DEFAULT_CONTEXT_LIMITS, ...(config.context ?? {}) },
      tickMs: config.tickMs ?? 250,
      leaseTtlMs: config.leaseTtlMs ?? 60_000,
      hostReadyTimeoutMs: config.hostReadyTimeoutMs ?? 120_000,
      // How long a transaction may sit unchanged before it counts as stale.
      staleMs: config.staleMs ?? 120_000,
      // How long one turn may stay in flight before it is aborted. The provider
      // has its own request timeouts; this is the cluster's backstop for a turn
      // that stopped making progress while still holding its lease.
      maxTurnMs: config.maxTurnMs ?? 900_000,
      heartbeatMs: config.heartbeatMs ?? 20_000,
      now: config.now,
      ...config,
    };
    // The deployment's own route is always selectable; a caller may widen the
    // registry explicitly.
    if (!this.config.routes || !Object.keys(this.config.routes).length) {
      const provider = this.config.model?.provider;
      const model = this.config.model?.model;
      this.config.routes = provider && model ? { [provider]: [model] } : {};
    }
    this.store = new ClusterStore(config.path ?? config.dbPath, { now: config.now ?? Date.now });
    this.#activeTurns = new Map();
    /** One scheduling pass per cluster at a time, across every driver. */
    this.#scheduling = new Set();
    this.#llmSlots = { limit: 2, inUse: 0, waiters: [] };
    this.#rotation = new Map();
    this.#lastAdmittedClass = new Map();
    this.#roleRotation = new Map();
    this.#pendingRefusals = new Map();
    this.#correctionStops = new Map();
    this.#timer = null;
    this.#disposed = false;
  }

  #activeTurns;
  #scheduling;
  #llmSlots;
  #rotation;
  /** Which class took a one-slot window last: with one slot, the classes alternate. */
  #lastAdmittedClass;
  /** The role each node admitted last, per node: management roles rotate on starts. */
  #roleRotation;
  /** Refusals the current turn took up, acknowledged only when its action commits. */
  #pendingRefusals;
  /** Correction-budget stops awaiting application, kept out of the rolled-back transaction. */
  #correctionStops;
  #timer;
  #disposed;
  #disposePromise = null;
  #recoveryPromise = null;
  #schedulingGeneration = 0;
  #ticking = false;
  #wakeups = [];
  #wakePromise = null;
  #wakeResolve = null;

  // ------------------------------------------------------------ public API

  start(spec) {
    const normalized = validateSpec(spec);
    const clusterId = spec.id ?? randomUUID();
    const cluster = this.store.tx(() => {
      const created = this.store.createCluster({
        id: clusterId,
        objective: normalized.objective,
        workspace: normalized.workspace,
        capabilities: normalized.capabilities,
        limits: normalized.limits,
        budget: normalized.budget,
        delegation: normalized.delegation,
        message_fixture: normalized.message_fixture,
      }, normalized.budget);

      const rootBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'root', scope_id: clusterId,
        limit: {
          tokens: normalized.budget.tokens ?? 0,
          model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
          agents: normalized.budget.agents ?? normalized.limits.max_agents,
          max_active_agents: normalized.budget.max_active_agents ?? normalized.limits.max_active_agents,
        },
        wall_limit_ms: normalized.budget.wall_time_ms ?? 3_600_000,
      });

      const root = this.store.insertNode({
        id: randomUUID(), cluster_id: clusterId, parent_id: null, kind: 'management', depth: 0,
        status: 'ACTIVE', scope: { objective: normalized.objective }, capabilities: normalized.capabilities,
        path: '0', max_children: normalized.limits.max_children,
      });
      this.store.updateNode(root.id, { scope: { objective: normalized.objective, root: true } });

      const rootNodeBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'node', scope_id: root.id, node_id: root.id,
        parent_budget_id: rootBudget.id, limit: {}, wall_limit_ms: 0,
      });
      const rootRow = this.store.getBudget(rootBudget.id);
      // Compaction is accounted separately (V6): it is the operation that makes a
      // session affordable again, so it must not be starved by the very
      // consumption it exists to reduce. It gets its own scope, funded before the
      // tree can spend the rest.
      // The earmark takes a *share*, never a floor that could exceed the work:
      // a small cluster must still be able to run its own roles and workers.
      const share = (limit, floor, fraction) => {
        if (!Number.isFinite(limit) || limit <= 0) return 0;
        const bounded = Math.min(Math.max(floor, Math.floor(limit * fraction)), Math.floor(limit * 0.25));
        return bounded >= Math.min(floor, limit) ? bounded : 0;
      };
      // A compaction reserves the summary request's whole envelope, which can
      // reach the backend's 65,536-token output ceiling, even though it settles
      // for less. A fixed 400k-token/128-request pool almost ran out after only
      // 16 files (389,743 tokens spent); it cannot support the 64-file tier.
      // Fund a tenth of the declared tokens and a fifth of its requests, capped
      // at a quarter for small budgets. These grants come out of the root budget,
      // not in addition to it; ordinary work retains the other shares.
      const compactionTokens = share(rootRow.tokens_limit, 64_000, 0.10);
      const compactionRequests = share(rootRow.requests_limit, 4, 0.20);
      if (compactionTokens > 0 || compactionRequests > 0) {
        const compactionBudget = createBudget(this.store, {
          cluster_id: clusterId, scope_kind: 'compaction', scope_id: clusterId,
          parent_budget_id: rootBudget.id, limit: {}, wall_limit_ms: 0,
        });
        this.grantBudget(rootBudget, compactionBudget, { tokens: compactionTokens, model_requests: compactionRequests });
      }
      this.grantBudget(rootBudget, rootNodeBudget, {
        tokens: rootRow.tokens_limit, model_requests: rootRow.requests_limit,
        tool_calls: rootRow.tool_calls_limit, agents: rootRow.agents_limit,
        max_active_agents: rootRow.max_active_limit,
      });
      const budgets = new Map();
      budgets.set(root.id, rootNodeBudget);
      this.ensureRoles(clusterId, root, budgets);

      if (normalized.delegation.length) {
        this.store.appendEvent(clusterId, 'delegation-fixture', { entries: normalized.delegation.length, scopes: normalized.delegation.map(entry => entry.scope) });
      }
      if (normalized.message_fixture.length) {
        this.store.appendEvent(clusterId, 'message-fixture', { entries: normalized.message_fixture.map(entry => entry.message_id) });
      }
      const planned = Array.isArray(spec.initial_transactions) && spec.initial_transactions.length
        ? spec.initial_transactions
        : [{ objective: normalized.objective, acceptance_criteria: spec.acceptance_criteria ?? [] }];
      for (const entry of planned) this.createTransactionInternal(clusterId, root, entry, { local: true, parent: null });

      this.store.appendEvent(clusterId, 'cluster-started', {
        objective: normalized.objective, workspace: normalized.workspace,
        limits: normalized.limits, initial_transactions: planned.length,
      });
      return this.store.getCluster(clusterId);
    });

    this.setLlmConcurrency(cluster.limits.max_llm_concurrency);
    this.#ensureTicking();
    this.wake();
    return this.read(clusterId, { include_events: false });
  }

  list(query = {}) {
    const clusters = this.store.listClusters({ status: query.status, limit: query.limit, offset: query.offset });
    return {
      clusters: clusters.map(cluster => {
        const counts = this.countsOf(cluster.id);
        return {
          id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace,
          revision: cluster.revision, created: cluster.created, ...counts,
        };
      }),
    };
  }

  read(id, query = {}) {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    const snapshot = {
      cluster: {
        id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace,
        capabilities: cluster.capabilities, limits: cluster.limits, budget: cluster.budget,
        revision: cluster.revision, created: cluster.created, updated: cluster.updated,
      },
      counts: this.countsOf(id),
      nodes: this.store.listNodes(id, { limit: normalizeLimit(query.limit) }),
      agents: this.store.listAgents(id, { limit: normalizeLimit(query.limit, 200) }),
      transactions: this.store.listTransactions({
        cluster_id: id, node_id: query.node_id, status: query.status,
        limit: normalizeLimit(query.limit), offset: query.offset,
      }),
      allocations: this.store.listAllocations({ cluster_id: id, status: 'ACTIVE', limit: normalizeLimit(query.limit, 200) }),
      budgets: evaluateTree(this.store, id),
      issues: this.store.openIssues(id, {}),
      usage: this.store.usageSummary(id),
      latest_seq: this.store.latestEventSeq(id),
    };
    if (query.include_events !== false) snapshot.events = this.store.readEvents(id, { since: query.since ?? 0, limit: normalizeLimit(query.event_limit, 100) });
    if (query.include_summary) snapshot.summary = this.latestSummaryOf(id);
    return snapshot;
  }

  events(id, query = {}) {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    return { events: this.store.readEvents(id, { since: query.since ?? 0, limit: normalizeLimit(query.limit, 200) }) };
  }

  control(id, action) {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    if (!['pause', 'resume', 'cancel'].includes(action)) fail(`Unknown control action: ${action}`);
    const result = this.store.tx(() => {
      const at = this.timestamp();
      const nextStatus = { pause: 'PAUSED', resume: 'RUNNING', cancel: 'CANCELLED' }[action];
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(cluster.status)) fail('Cluster is terminal', 409);
      if (action === 'resume' && !['PAUSED', 'BLOCKED'].includes(cluster.status)) fail('Cluster is not paused', 409);
      this.store.updateCluster(id, { status: nextStatus });
      if (action === 'pause') {
        for (const node of this.store.nodesInSubtree(id, null)) {
          if (node.status === 'ACTIVE') this.store.updateNode(node.id, { status: 'PAUSED' });
        }
        for (const agent of this.store.agentsInSubtree(id, null)) {
          if (['READY', 'RUNNING', 'WAITING'].includes(agent.status)) this.store.updateAgent(agent.id, { status: 'PAUSED' });
        }
        // One exhaustive statement per status: a page of transactions is not
        // "every transaction that was in flight". The status a transaction came
        // from is remembered, so `resume` restores *that* rather than promoting
        // an unapproved DRAFT to READY. A staged proposal is left alone: it is
        // real work, and the turn that produced it may still be the turn that
        // finishes it.
        for (const status of ['READY', 'DISPATCHED', 'RUNNING', 'DRAFT']) {
          this.store.run(
            `UPDATE transactions SET status='PAUSED', pre_pause_status=?, pre_pause_revision=revision, updated=?
              WHERE cluster_id=? AND status=?`,
            status, this.timestamp(), id, status,
          );
        }
      }
      if (action === 'resume') {
        for (const node of this.store.nodesInSubtree(id, null)) {
          if (node.status === 'PAUSED') this.store.updateNode(node.id, { status: 'ACTIVE' });
        }
        for (const agent of this.store.agentsInSubtree(id, null)) {
          if (agent.status === 'PAUSED') this.store.updateAgent(agent.id, { status: 'READY' });
        }
        // The pre-pause status decides where each transaction goes back to, and
        // the dependencies decide whether going back is legal yet. Both are SQL
        // predicates, so the whole cluster is classified regardless of size.
        this.store.run(
          `UPDATE transactions SET status='READY', pre_pause_status=NULL, pre_pause_revision=NULL, updated=?
            WHERE cluster_id=? AND status='PAUSED' AND pre_pause_status IN ('READY','DISPATCHED','RUNNING')
              AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN transactions o ON o.id = d.depends_on
                              WHERE d.transaction_id = transactions.id AND o.status <> 'ACCEPTED')`,
          this.timestamp(), id,
        );
        this.store.run(
          `UPDATE transactions SET status='DRAFT', pre_pause_status=NULL, pre_pause_revision=NULL, updated=?
            WHERE cluster_id=? AND status='PAUSED' AND pre_pause_status IN ('READY','DISPATCHED','RUNNING')`,
          this.timestamp(), id,
        );
        this.store.run(
          "UPDATE transactions SET status=COALESCE(pre_pause_status,'DRAFT'), pre_pause_status=NULL, pre_pause_revision=NULL, updated=? WHERE cluster_id=? AND status='PAUSED'",
          this.timestamp(), id,
        );
      }
      if (action === 'cancel') {
        this.cancelSubtree(id, null, at);
        this.terminateClusterJobs(id, 'cluster cancelled');
      }
      this.store.appendEvent(id, `cluster-${action}`, { at });
      return this.read(id, { include_events: false });
    });
    this.wake();
    return result;
  }

  /**
   * Role command entry: `actor` carries the authenticated role and management
   * domain, `command` carries the caller-minted command identity.
   */
  command(actor, command) {
    if (!command || typeof command !== 'object') fail('Invalid command');
    const { command_id, action, params, expected_revision } = command;
    if (typeof action !== 'string' || !action) fail('Invalid command action');
    const clusterId = actor.cluster_id ?? params?.cluster_id;
    if (!clusterId) fail('Command requires a cluster id');
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) fail('Cluster not found', 404);
    authorize(actor, action);
    if (actor.role !== 'user' && actor.epoch !== undefined) {
      // A command is only valid while the exact lease epoch that produced it is
      // still the live one for that identity.
      const lease = this.store.leaseForAgent(actor.agent_id);
      if (!lease || lease.epoch !== actor.epoch || lease.expires <= this.timestamp()) {
        fail(`command from a fenced turn: agent ${actor.agent_id} does not hold epoch ${actor.epoch}`, 409);
      }
    }
    const outcome = this.store.runCommand(
      { cluster_id: clusterId, command_id, actor, action, expected_revision, params },
      () => {
        // The precondition guards new work. A completed command already has
        // its answer, even if that work advanced the cluster revision itself.
        const current = this.store.getCluster(clusterId);
        if (expected_revision !== undefined && expected_revision !== null && expected_revision !== current.revision) {
          fail(`revision conflict: expected ${expected_revision}, current ${current.revision}`, 409);
        }
        return this.#applyCommand(current, actor, action, params ?? {});
      },
    );
    this.wake();
    return outcome;
  }

  /**
   * Run one communication action on behalf of an actor. The communication
   * module commits its delivery notifications with the action atomically.
   */
  communicateFrom(actor, action, params) {
    const cluster = this.store.getCluster(actor.cluster_id);
    if (!cluster) fail('Cluster not found', 404);
    const result = communicate(this.store, cluster, actor, action, params ?? {}, {
      notify: (recipient, payload) => this.notifyInternal(actor.cluster_id, recipient, { subject: payload.kind, payload }),
    });
    return result;
  }

  /**
   * Cancel every background job this cluster registered. An unknown or foreign
   * process is never killed by guesswork: only jobs the host still owns.
   */
  terminateClusterJobs(clusterId, reason) {
    let jobs;
    try {
      jobs = this.ctx.get?.('jobs');
    } catch {
      jobs = undefined;
    }
    if (!jobs) return [];
    const stopped = [];
    for (const effect of this.store.effectsAll(clusterId)) {
      if (!effect.job_id) continue;
      const agent = this.store.getAgent(effect.agent_id);
      if (!agent) continue;
      try {
        jobs.kill(effect.job_id, agent.session_id, reason);
        stopped.push(effect.job_id);
      } catch (error) {
        this.logger?.warn?.(error);
      }
    }
    if (stopped.length) this.store.appendEvent(clusterId, 'jobs-terminated', { jobs: stopped, reason });
    return stopped;
  }

  /**
   * Prove injections against the recipient's own durable Session: a message id
   * that is present there was admitted, so only its ack is missing. Everything
   * else stays queued for a real delivery.
   */
  /**
   * The session persistence service, when the profile mounts one. Without it a
   * crash window between injection and ack cannot be proven and the attempted
   * delivery stays withheld until its durable session can be read.
   */
  attachPersistence(service) {
    this.#persistence = service ?? null;
    return this.#persistence;
  }

  persistenceAvailable() {
    return Boolean(this.#persistence);
  }

  /**
   * Whether a Session really exists on disk. `agent.turns > 0` is a proxy that
   * is wrong on both sides of Session materialization: a crash after the first
   * Session was written but before its finisher ran leaves `turns === 0` while
   * the Session exists, and a failed first turn can leave `turns > 0` with no
   * Session at all.
   * @returns true/false when the store can answer, or null when it cannot.
   */
  async sessionExists(sessionId) {
    if (!this.#persistence || typeof this.#persistence.stat !== 'function') return null;
    try {
      const snapshot = await this.#persistence.stat(sessionId);
      return Boolean(snapshot);
    } catch (error) {
      this.logger?.warn?.(`dsh-flow: session existence probe failed: ${error?.message ?? error}`);
      return null;
    }
  }

  async reconcileDeliveries(clusterId, { sessionIdFor = agent => agent?.session_id } = {}) {
    // Settle anything still reserved from the previous process before any
    // scheduling resumes, so held tokens are visible to the first decision.
    // Only identities that really hold a reservation are visited: the set comes
    // from the ledger, so a cluster with more identities than one page still
    // settles every stranded request before scheduling resumes.
    for (const facts of this.store.agentsWithReservedReceipts(clusterId)) {
      this.reconcileReservations(this.store.getCluster(clusterId), facts);
    }
    let persistence = this.#persistence;
    if (!persistence) {
      // Fall back to a direct lookup: `ctx.inject` is the documented path, but
      // a profile may expose the service without going through it.
      try {
        persistence = this.ctx.get?.('sessionPersistence') ?? null;
      } catch (error) {
        this.logger?.warn?.(`dsh-flow: session persistence is not reachable: ${error?.message ?? error}`);
        persistence = null;
      }
      if (persistence) this.#persistence = persistence;
    }
    const rows = this.store.all(
      `SELECT r.message_id, r.recipient, r.status FROM recipients r JOIN messages m ON m.id=r.message_id
       WHERE m.cluster_id=? AND r.status IN ('DELIVERED','PENDING')`, clusterId);
    if (!rows.length) return { acknowledged: 0, requeued: 0, unknown: 0, persistence: Boolean(persistence) };
    let acknowledged = 0;
    let requeued = 0;
    let unknown = 0;
    for (const row of rows) {
      const agent = this.store.getAgent(row.recipient);
      const sessionId = sessionIdFor(agent);
      // A session that does not exist cannot have been injected: that is a
      // *proven* absence, not an unreadable one, and treating it as unknown
      // blocked a whole cluster at boot for a delivery that had never been sent.
      const exists = sessionId ? await this.sessionExists(sessionId) : false;
      const proof = !persistence || !sessionId
        ? { state: 'UNKNOWN', found: false, reason: persistence ? 'no session id' : 'no session persistence service' }
        : exists === false
          ? { state: 'ABSENT', found: false, reason: 'the recipient has no session yet, so nothing was injected' }
          : await sessionCarries(persistence, sessionId, row.message_id);
      const admitted = proof.state === 'FOUND';
      this.store.tx(() => this.store.appendEvent(clusterId, 'messages-reconcile', {
        message_id: row.message_id, recipient: row.recipient, session_id: sessionId ?? null,
        state: proof.state, found: admitted, reason: proof.reason ?? null, events_scanned: proof.scanned ?? null,
      }));
      if (proof.state === 'UNKNOWN') {
        // An unprovable state is preserved and named. It blocks its owner
        // only when the delivery *had been injected*: that is the case where a
        // dispatch could duplicate it. A delivery that was still queued has not
        // been handed over at all, so there is nothing ambiguous to resolve and
        // blocking the cluster for it stops work for no reason.
        const owner = row.status === 'DELIVERED' ? this.store.getAgent(row.recipient) : null;
        this.store.tx(() => {
          // Keep DELIVERED: changing it to PENDING would erase the only durable
          // distinction between a fresh message and one that may already be in
          // the session, allowing a later restart to re-inject it without proof.
          this.store.appendEvent(clusterId, 'delivery-unknown', {
            message_id: row.message_id, recipient: row.recipient, session_id: sessionId ?? null,
            was_injected: row.status === 'DELIVERED', reason: proof.reason ?? null,
          });
          if (owner) {
            this.store.updateAgent(owner.id, { status: 'BLOCKED' });
            this.blockNodeInternal(clusterId, owner.node_id,
              `DELIVERY_UNKNOWN: delivery ${row.message_id} to ${owner.id} cannot be proven either way`, 'DELIVERY_UNKNOWN');
          }
        });
        unknown += 1;
        continue;
      }
      if (admitted) {
        this.store.tx(() => {
          this.store.ackDelivery(row.message_id, row.recipient);
          this.store.appendEvent(clusterId, 'messages-ack-reconciled', { message_id: row.message_id, recipient: row.recipient, session_id: sessionId });
        });
        acknowledged += 1;
      } else {
        this.store.tx(() => this.store.run(
          "UPDATE recipients SET status='PENDING', acked=NULL WHERE message_id=? AND recipient=? AND status='DELIVERED'",
          row.message_id, row.recipient,
        ));
        requeued += 1;
      }
    }
    return { acknowledged, requeued, unknown, persistence: Boolean(persistence) };
  }

  /** Reclaim leases whose TTL passed. Exposed for tests and for the boot sweep. */
  txExpireLeases(clusterId) {
    return this.#expireLeases(clusterId);
  }

  /**
   * Node ids one actor may read. A management role sees its own subtree; a
   * worker sees its own node; the host user sees everything.
   */
  domainNodeIds(actor, clusterId) {
    if (actor.role === 'user' || !actor.node_id) {
      return new Set(this.store.all('SELECT id FROM nodes WHERE cluster_id=?', clusterId).map(row => row.id));
    }
    // One recursive CTE, not a page-and-fixpoint loop: a domain with more nodes
    // than one page used to be truncated to whatever the page held.
    const rows = this.store.all(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       SELECT id FROM sub`, actor.node_id);
    return new Set(rows.map(row => row.id));
  }

  /** Topology only: ancestors are context, not an extension of the role's read domain. */
  managementAncestors(clusterId, nodeId) {
    return this.store.all(
      `WITH RECURSIVE lineage(id,parent_id,depth,path,kind) AS (
         SELECT id,parent_id,depth,path,kind FROM nodes WHERE cluster_id=? AND id=?
         UNION ALL
         SELECT parent.id,parent.parent_id,parent.depth,parent.path,parent.kind
           FROM nodes parent JOIN lineage child ON parent.id=child.parent_id
          WHERE parent.cluster_id=?
       )
       SELECT id,depth,path,kind FROM lineage WHERE id<>? ORDER BY depth`,
      clusterId, nodeId, clusterId, nodeId,
    );
  }

  /** Read-only query surface shared by every role and the host API. */
  query(actor, what, params = {}) {
    const clusterId = actor.cluster_id ?? params.cluster_id;
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) fail('Cluster not found', 404);
    const limit = normalizeLimit(params.limit);
    const offset = Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const domain = this.domainNodeIds(actor, clusterId);
    const inDomain = tx => domain.has(tx.node_id);
    const canReadTransaction = tx => inDomain(tx)
      || this.store.listAllocations({ cluster_id: clusterId, agent_id: actor.agent_id, status: 'ACTIVE', limit: 5 })
        .some(allocation => allocation.transaction_id === tx.id);
    /**
     * One envelope for every list: the caller always learns whether it is
     * looking at the whole answer, and `next_offset` is `null` exactly when it
     * is. A list that silently stops at the first page is how a client comes to
     * believe a 1024-row domain holds 200 rows.
     */
    const pageList = (items, total = null) => {
      const count = total === null ? items.length : total;
      const next = offset + items.length < count ? offset + items.length : null;
      return { items, total: count, offset, limit, next_offset: next };
    };
    switch (what) {
      case 'cluster':
        return { cluster: this.read(clusterId, { include_events: false }).cluster, counts: this.countsOf(clusterId) };
      case 'nodes': {
        const nodes = scopeNodes(this.store, actor, clusterId).filter(node => params.parent_id === undefined || node.parent_id === params.parent_id);
        return pageList(nodes.slice(offset, offset + limit).map(nodeReference), nodes.length);
      }
      case 'node': {
        if (typeof params.id !== 'string' || !params.id) fail('query "node" needs params.id, the node id (see what:"nodes")');
        const node = this.store.getNode(params.id);
        if (!node || node.cluster_id !== clusterId) fail(`Node not found: ${params.id}`, 404);
        if (!domain.has(node.id)) fail('node is outside this agent\'s domain', 403);
        const transactions = this.store.transactionsForDomain(clusterId, {
          scope_node_id: actor.role === 'user' ? null : actor.node_id,
          node_id: node.id, limit, offset,
        });
        const agents = this.store.listAgents(clusterId, { node_id: node.id, limit, offset });
        const agentsTotal = Number(this.store.get(
          'SELECT COUNT(*) AS c FROM agents WHERE cluster_id=? AND node_id=?', clusterId, node.id).c);
        return {
          ancestors: this.managementAncestors(clusterId, node.id),
          // A topology lookup normally needs path, depth and child references.
          // Nested delegation scope repeats long objectives and acceptance
          // criteria on every ancestor: one real Auditor fetched two 3.5 kB
          // node details, then could not fit its validation under 8k. Keep
          // complete scope available by id when explicitly requested.
          node: actor.role === 'user' || params.full === true ? node : nodeReference(node),
          transactions: pageList(transactions.items.map(transactionReference), transactions.total),
          agents: pageList(agents.map(agentReference), agentsTotal),
          subtree_size: this.store.nodesInSubtree(clusterId, node.id).length - 1,
        };
      }
      case 'transactions': {
        const { items, total } = this.store.transactionsForDomain(clusterId, {
          scope_node_id: actor.role === 'user' ? null : actor.node_id,
          node_id: params.node_id, parent_id: params.parent_id, status: params.status, limit, offset,
        });
        return pageList(items.map(transactionReference), total);
      }
      case 'transaction': {
        if (typeof params.id !== 'string' || !params.id) {
          fail('query "transaction" needs params.id; transaction_id is the mutation parameter, not the query parameter');
        }
        const tx = this.store.getTransaction(params.id);
        if (!tx || tx.cluster_id !== clusterId) fail('Transaction not found', 404);
        if (!canReadTransaction(tx)) fail('transaction is outside this agent\'s domain', 403);
        if (actor.role !== 'user' && params.full === true) {
          fail('A model cannot load every historical audit in one transaction response; read each audit by id with what:"audit" (or each issue with what:"issue")');
        }
        const { result, validation, ...transaction } = tx;
        // The current validation and direct result remain complete; an
        // aggregate's child evidence is independently addressable through its
        // child transaction. Historical audits/issues are references too:
        // replaying all earlier traces can strand a native role session.
        const full = actor.role === 'user';
        const visibleTransaction = full ? transaction : {
          ...transactionReference(tx),
          objective: tx.objective,
          inputs: tx.inputs,
          expected_output: tx.expected_output,
          acceptance_criteria: tx.acceptance_criteria,
          capabilities: tx.capabilities,
          attempts: tx.attempts,
          plan_approved_revision: tx.plan_approved_revision,
        };
        // An aggregate embeds each child's full result a second time. The
        // child is itself a domain-checked transaction readable by id; keep
        // its provenance here without replaying that evidence into the role's
        // session. The host-facing detail retains the complete saved result.
        const visibleResult = full || result?.kind !== 'aggregate' || !Array.isArray(result.children)
          ? result : {
            ...result,
            children: result.children.map(child => ({
              transaction_id: child.transaction_id,
              result_revision: child.result_revision,
              accepted_by: child.accepted_by,
            })),
          };
        const audits = full ? this.store.auditsForTransaction(clusterId, tx.id, { limit })
          : this.store.all(
            `SELECT id,node_id,kind,target_revision,decision,auditor_agent_id,created,decided
               FROM audits WHERE cluster_id=? AND transaction_id=? ORDER BY created,rowid LIMIT ?`,
            clusterId, tx.id, limit);
        const issues = full ? this.store.openIssues(clusterId, { transaction_id: tx.id, status: null })
          : this.store.all(
            `SELECT id,node_id,target_revision,severity,SUBSTR(required_change,1,200) AS required_change,
                    status,corrections,created,updated
               FROM issues WHERE cluster_id=? AND transaction_id=? ORDER BY created`,
            clusterId, tx.id);
        const active = this.store.activeAllocationForTransaction(tx.id);
        return {
          transaction: visibleTransaction,
          dependencies: this.store.dependenciesOf(tx.id),
          dependents: this.store.dependentsOf(tx.id),
          audits,
          issues,
          allocation: full || !active ? active : {
            id: active.id, node_id: active.node_id, agent_id: active.agent_id,
            write_scope: active.write_scope, status: active.status,
          },
          validation: validation ?? null,
          result: visibleResult ?? null,
          result_revision: tx.result_revision ?? null,
        };
      }
      case 'audit': {
        if (typeof params.id !== 'string' || !params.id) fail('query "audit" needs params.id');
        const audit = this.store.getAudit(params.id);
        if (!audit || audit.cluster_id !== clusterId) fail('Audit not found', 404);
        const tx = this.store.getTransaction(audit.transaction_id);
        if (!tx || !canReadTransaction(tx)) fail('audit is outside this agent\'s domain', 403);
        return { audit };
      }
      case 'agents': {
        // A Worker has one transaction, not its manager's whole subtree. It
        // must still be able to address the three roles that own its allocation
        // when a write restriction or execution blocker needs escalation.
        const ownerNodeId = actor.role === 'worker'
          ? this.store.activeAllocationForAgent(actor.agent_id)?.node_id : null;
        const agents = this.store.agentsInSubtree(clusterId, null, { status: params.status ?? null, role: params.role ?? null })
          .filter(agent => actor.role === 'user' || domain.has(agent.node_id)
            || (agent.node_id === ownerNodeId && agent.role !== 'worker'));
        // A large subtree has many role and Worker identities. Preserve the
        // full count and cursor, but do not deliver all of them into one 8k
        // management context (the live root read 3.6 kB in a single query).
        const agentLimit = actor.role === 'user' ? limit : Math.min(limit, 8);
        return { ...pageList(agents.slice(offset, offset + agentLimit).map(agentReference), agents.length), limit: agentLimit };
      }
      case 'allocations': {
        const allocations = this.store.allocationsInSubtree(clusterId, null, { status: params.status ?? 'ACTIVE' })
          .filter(allocation => (actor.role === 'user' ? true : domain.has(allocation.node_id)));
        return pageList(allocations.slice(offset, offset + limit), allocations.length);
      }
      case 'budgets': {
        // A list is for choosing a spendable source, not replaying every
        // dimension's limit/reserved/spent/available ledger. In the native
        // recursion run a six-row page alone consumed 5.5 kB of an
        // Orchestrator's 8k-token identity context. Keep the host's complete
        // ledger; give a model the same scope IDs and actual available amounts.
        const budgetLimit = actor.role === 'user' ? limit : Math.min(limit, 6);
        const rows = evaluateTree(this.store, clusterId)
          .filter(row => row.node_id === null || domain.has(row.node_id))
          .sort((a, b) => a.id.localeCompare(b.id));
        const page = rows.slice(offset, offset + budgetLimit);
        const visible = actor.role === 'user' ? page : page.map(row => ({
          id: row.id, scope_kind: row.scope_kind, scope_id: row.scope_id,
          node_id: row.node_id, parent_budget_id: row.parent_budget_id,
          available: {
            tokens: row.tokens.available, model_requests: row.model_requests.available,
            tool_calls: row.tool_calls.available, agents: row.agents.available,
            max_active_agents: row.max_active_agents.available,
          },
          effective_deadline: row.effective_deadline,
        }));
        return { ...pageList(visible, rows.length), limit: budgetLimit };
      }
      case 'issues': {
        // The model sees stable references and the requested change, not the
        // full evidence of every open issue. Read the evidence by id below.
        const issues = actor.role === 'user'
          ? this.store.openIssues(clusterId, { status: params.status ?? null })
          : this.store.all(
            `SELECT id,cluster_id,node_id,transaction_id,reporter_agent_id,target_revision,
                    severity,SUBSTR(required_change,1,200) AS required_change,status,corrections,created,updated
               FROM issues WHERE cluster_id=? ORDER BY created`, clusterId,
          ).filter(issue => !params.status || (Array.isArray(params.status)
            ? params.status.includes(issue.status) : issue.status === params.status));
        const scoped = issues.filter(issue => !issue.node_id || domain.has(issue.node_id));
        // A real Auditor fetched nine historical and open issues as one 5.5 kB
        // tool result and could not fit its next step under the role budget.
        // Offer unresolved work first, with a cursor for every older verdict.
        if (actor.role !== 'user') scoped.sort((a, b) =>
          Number(b.status === 'OPEN') - Number(a.status === 'OPEN')
          || a.created - b.created || a.id.localeCompare(b.id));
        const issueLimit = actor.role === 'user' ? limit : Math.min(limit, 4);
        return { ...pageList(scoped.slice(offset, offset + issueLimit), scoped.length), limit: issueLimit };
      }
      case 'issue': {
        if (typeof params.id !== 'string' || !params.id) fail('query "issue" needs params.id');
        const issue = this.store.getIssue(params.id);
        if (!issue || issue.cluster_id !== clusterId) fail('Issue not found', 404);
        if (issue.node_id && !domain.has(issue.node_id)) fail('issue is outside this agent\'s domain', 403);
        return { issue };
      }
      case 'audits': {
        const audits = this.store.all(
          "SELECT * FROM audits WHERE cluster_id=? AND decision='PENDING' ORDER BY created,id", clusterId)
          .filter(audit => domain.has(audit.node_id))
          .map(audit => ({ ...audit, evidence: decodeJson(audit.evidence) }));
        return pageList(audits.slice(offset, offset + limit), audits.length);
      }
      case 'effects': {
        const columns = actor.role === 'user'
          ? 'e.*'
          : 'e.call_id,e.cluster_id,e.agent_id,e.node_id,e.tool,e.status,SUBSTR(e.error,1,200) AS error,e.created,e.settled';
        const effects = this.store.all(
          `SELECT ${columns}, CASE WHEN n.kind='worker' THEN n.parent_id ELSE n.id END AS owner_management_id
             FROM effects e LEFT JOIN nodes n ON n.id=e.node_id AND n.cluster_id=e.cluster_id
            WHERE e.cluster_id=?${params.agent_id ? ' AND e.agent_id=?' : ''}
            ORDER BY e.created DESC`,
          ...(params.agent_id ? [clusterId, params.agent_id] : [clusterId]),
        ).filter(effect => !effect.node_id || domain.has(effect.node_id));
        return pageList(effects.slice(offset, offset + limit), effects.length);
      }
      case 'effect': {
        if (typeof params.call_id !== 'string' || !params.call_id) fail('query "effect" needs params.call_id');
        const effect = this.store.getEffect(params.call_id);
        if (!effect || effect.cluster_id !== clusterId) fail('Effect receipt not found', 404);
        if (effect.node_id && !domain.has(effect.node_id)) fail('effect is outside this agent\'s domain', 403);
        const node = effect.node_id ? this.store.getNode(effect.node_id) : null;
        return { effect: { ...effect, owner_management_id: node?.kind === 'worker' ? node.parent_id : node?.id ?? null } };
      }
      case 'usage': {
        // Receipts are substantially wider than tree references. A role's
        // default 100-row page can exceed its entire context budget in one
        // tool result; the host-facing API retains its requested page size.
        const receiptLimit = actor.role === 'user' ? limit : Math.min(limit, 8);
        const { items, total } = this.store.usageReceiptsForDomain(clusterId, {
          scope_node_id: actor.role === 'user' ? null : actor.node_id,
          agent_id: params.agent_id, status: params.status, limit: receiptLimit, offset,
        });
        return {
          usage: this.store.usageSummary(clusterId, { nodeId: actor.role === 'user' ? null : actor.node_id }),
          ...pageList(items, total),
          limit: receiptLimit,
        };
      }
      case 'deliveries': {
        const rows = this.store.all(
          `SELECT r.message_id, r.recipient, r.delivery_seq, r.status, r.acked, m.kind, m.from_agent, m.from_node,
                  COALESCE(a.node_id, m.from_node) AS recipient_node
             FROM recipients r JOIN messages m ON m.id=r.message_id LEFT JOIN agents a ON a.id=r.recipient
            WHERE m.cluster_id=? ORDER BY r.created, r.message_id, r.recipient`, clusterId)
          .filter(row => actor.role === 'user' || domain.has(row.recipient_node) || domain.has(row.from_node));
        return pageList(rows.slice(offset, offset + limit), rows.length);
      }
      case 'context': {
        const agentId = params.agent_id ?? actor.agent_id;
        const contextAgent = this.store.getAgent(agentId);
        if (!contextAgent || contextAgent.cluster_id !== clusterId) fail('Context agent not found', 404);
        if (actor.role !== 'user' && !domain.has(contextAgent.node_id) && contextAgent.id !== actor.agent_id) {
          fail('context is outside this agent\'s domain', 403);
        }
        if (params.transaction_id && actor.role !== 'user') {
          const transaction = this.store.getTransaction(params.transaction_id);
          if (!transaction || transaction.cluster_id !== clusterId || !domain.has(transaction.node_id)) {
            fail('context transaction is outside this agent\'s domain', 403);
          }
        }
        const steps = this.store.all(
          `SELECT e.seq, e.data FROM events e WHERE e.cluster_id=? AND e.type='context-step'
             AND json_extract(e.data,'$.agent_id')=? ORDER BY e.seq DESC LIMIT 50`, clusterId, agentId);
        const summaryScope = params.transaction_id
          ? { transaction_id: params.transaction_id }
          : { node_id: actor.role === 'user' && contextAgent.role === 'worker'
            ? this.store.getNode(contextAgent.node_id)?.parent_id ?? contextAgent.node_id
            : contextAgent.node_id };
        return {
          agent_id: agentId,
          steps: steps.map(row => ({ seq: row.seq, ...decodeJson(row.data) })),
          summary: this.store.latestSummary(clusterId, summaryScope)?.data ?? null,
        };
      }
      case 'health': {
        // The latest evaluation, with the measured signals it was scored
        // against, plus the node's own closing evaluation when one exists.
        const nodeId = params.node_id ?? (actor.role === 'user' ? null : actor.node_id);
        if (actor.role !== 'user' && !domain.has(nodeId)) fail('health is outside this agent\'s domain', 403);
        const latest = this.store.latestHealth(clusterId, { node_id: nodeId });
        return {
          health: latest,
          metrics: this.healthMetricNames(),
          signals: this.healthSignals(clusterId, { windowMs: this.config.staleMs }),
        };
      }
      case 'summary': {
        if (actor.role === 'user') return { summary: this.latestSummaryOf(clusterId, params) };
        const nodeId = params.node_id ?? actor.node_id;
        if (!domain.has(nodeId)) fail('summary is outside this agent\'s domain', 403);
        if (params.transaction_id) {
          const transaction = this.store.getTransaction(params.transaction_id);
          if (!transaction || transaction.cluster_id !== clusterId || !domain.has(transaction.node_id)) {
            fail('summary transaction is outside this agent\'s domain', 403);
          }
        }
        const row = this.store.latestSummary(clusterId, params.transaction_id
          ? { transaction_id: params.transaction_id } : { node_id: nodeId });
        return { summary: row ? { ...row.data, as_of_seq: row.as_of_seq } : null };
      }
      case 'blackboard': {
        const entries = this.store.blackboardList(clusterId, params.prefix);
        return pageList(entries.slice(offset, offset + limit).map(row => ({
          key: row.key, value: JSON.parse(row.value), revision: row.revision, updated_by: row.updated_by,
        })), entries.length);
      }
      default:
        fail(`Unknown query: ${String(what)}`);
    }
  }

  report(id) {
    const cluster = this.store.getCluster(id);
    if (!cluster) fail('Cluster not found', 404);
    // Every number here is an exhaustive SQL aggregate. Detail lists are paged
    // explicitly and say so (`truncated` + `total`), because a report that
    // silently listed the first 500 rows of 1024 transactions would be read as
    // "there are 500".
    const transactionCounts = this.store.countTransactionsByStatus(id);
    const statusCounts = Object.fromEntries(transactionCounts.map(row => [row.status, Number(row.c)]));
    const totalTransactions = transactionCounts.reduce((sumTotal, row) => sumTotal + Number(row.c), 0);
    const nodes = this.store.nodesInSubtree(id, null);
    const agentsByRole = this.store.countAgentsByRole(id);
    const agentsTotal = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.c), 0);
    const liveAgents = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.live), 0);
    const activatedAgents = agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.activated), 0);
    const audits = this.store.all('SELECT kind, decision, COUNT(*) AS c FROM audits WHERE cluster_id=? GROUP BY kind, decision', id);
    const issues = this.store.all('SELECT status, COUNT(*) AS c, SUM(corrections) AS corrections FROM issues WHERE cluster_id=? GROUP BY status', id);
    const effects = this.store.all('SELECT status, COUNT(*) AS c FROM effects WHERE cluster_id=? GROUP BY status', id);
    const subtree = new Map(this.store.subtreeSizes(id).map(row => [row.node_id, Number(row.size)]));
    const contextByAgent = this.store.latestOrchestratorContext(id)
      .map(row => ({ agent_id: row.agent_id, total_tokens: row.tokens === null ? null : Number(row.tokens) }));
    const traffic = this.store.deliveryTraffic(id);
    const windowMs = 5 * 60_000;
    const txPage = this.store.listTransactions({ cluster_id: id, limit: 200 });
    return {
      cluster: { id: cluster.id, status: cluster.status, objective: cluster.objective, workspace: cluster.workspace, limits: cluster.limits },
      mechanism: {
        nodes: nodes.length,
        management_nodes: nodes.filter(n => n.kind === 'management').length,
        worker_nodes: nodes.filter(n => n.kind === 'worker').length,
        max_depth: this.store.maxNodeDepth(id),
        max_fan_out: Math.max(0, ...[...nodes.reduce((map, node) => map.set(node.parent_id ?? 'root', (map.get(node.parent_id ?? 'root') ?? 0) + 1), new Map()).values()]),
        agents_ever_created: agentsTotal,
        agents_live: liveAgents,
        agents_activated: activatedAgents,
        agents_by_role: Object.fromEntries(agentsByRole.map(row => [row.role, Number(row.c)])),
        transactions_by_status: statusCounts,
        transactions_total: totalTransactions,
        audits_pending: audits.filter(row => row.decision === 'PENDING').reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        issues_open: issues.filter(row => row.status === 'OPEN').reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        issues_total: issues.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        corrections: issues.reduce((sumTotal, row) => sumTotal + Number(row.corrections ?? 0), 0),
        usage: this.store.usageSummary(id),
        budgets: evaluateTree(this.store, id),
        leases_active: this.store.listLeases(id, {}).length,
        effects: effects.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
        effects_by_status: Object.fromEntries(effects.map(row => [row.status, Number(row.c)])),
        sources_captured: this.store.countSources(id),
        message_deliveries: traffic.deliveries,
        events: this.store.latestEventSeq(id),
        // Section 19's named scale signals.
        subtree_size: Object.fromEntries(subtree),
        orchestrator_context: contextByAgent,
        agent_utilization: {
          live_agents: liveAgents,
          active_turns: this.#activeTurnCount(id),
          ratio: liveAgents > 0 ? Number((this.#activeTurnCount(id) / liveAgents).toFixed(4)) : null,
        },
        auditor_event_rate: {
          window_ms: windowMs,
          inbox_rows: this.store.countInboxSince(id, { role: 'auditor', since: this.timestamp() - windowMs }),
          per_second: Number((this.store.countInboxSince(id, { role: 'auditor', since: this.timestamp() - windowMs }) / (windowMs / 1000)).toFixed(4)),
        },
        communication_traffic: { ...traffic, cross_subtree_ratio: traffic.deliveries > 0 ? Number((traffic.cross_subtree / traffic.deliveries).toFixed(4)) : null },
      },
      transactions: {
        items: txPage.map(tx => ({
          id: tx.id, status: tx.status, revision: tx.revision, result_revision: tx.result_revision,
          objective: tx.objective.slice(0, 200), parent: tx.parent_transaction_id, node: tx.node_id, priority: tx.priority,
          validation: tx.validation ? { accepted: tx.validation.accepted, checks: tx.validation.checks?.length ?? 0 } : null,
        })),
        total: totalTransactions,
        truncated: txPage.length < totalTransactions,
      },
    };
  }

  dispose() {
    // Plugin teardown, IPC shutdown and disconnect can overlap. Every caller
    // waits for the same drain; none may close the store beneath another.
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose() {
    this.#disposed = true;
    this.wake();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const live = [...this.#activeTurns.values()];
    for (const entry of live) entry.ac.abort(new Error('cluster runtime disposed'));
    // The abort is asynchronous, so the finishers run *after* it: the store stays
    // open until they have settled (a bounded wait, because a turn wedged in the
    // host must not hold the process up) and only then is the remainder
    // reconciled. Closing under them left leases, `RUNNING` identities and
    // `RESERVED` requests at rest (measured on a blocked smoke: 2 leases, 2
    // RUNNING agents, 1 RESERVED receipt).
    const settled = await Promise.race([
      Promise.allSettled(live.map(entry => entry.promise)).then(() => true),
      new Promise(resolvePromise => {
        const timer = setTimeout(() => resolvePromise(false), 5_000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    try {
      this.#drainLiveTurns(live, { unresponsive: !settled });
    } catch (error) {
      this.logger?.warn?.(error);
    }
    let afterId = '';
    for (;;) {
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      for (const cluster of page) {
        try {
          this.terminateClusterJobs(cluster.id, 'cluster runtime disposed');
        } catch (error) {
          this.logger?.warn?.(error);
        }
      }
      afterId = page[page.length - 1].id;
      if (page.length < 200) break;
    }
    this.#activeTurns.clear();
    this.store.close();
  }

  /**
   * Close out the turns that were live at teardown, deterministically: their
   * leases are fenced and their identity returned to a schedulable state, and a
   * request that was reserved and never settled is recorded as unknown *without*
   * handing its token hold back — an unknown-cost send is not free capacity.
   */
  #drainLiveTurns(live, { unresponsive = true } = {}) {
    const leases = live.map(entry => entry.lease).filter(Boolean);
    // The receipt owns its accounting even if its turn is already gone. Visit
    // every remaining reservation through the same transition; a status-only
    // update would strand requests_reserved instead of consuming the attempt.
    const held = this.store.all("SELECT request_id, cluster_id, reservation_tokens FROM usage_receipts WHERE status='RESERVED'");
    for (const receipt of held) {
      try {
        settleLlmRequest(this.store, {
          cluster_id: receipt.cluster_id,
          reservation: { request_id: receipt.request_id, tokens: receipt.reservation_tokens ?? 0 },
          usage: null,
          status: 'UNKNOWN',
          note: `the runtime stopped while this request was in flight; ${receipt.reservation_tokens ?? 0} tokens stay held`,
        });
      } catch (error) {
        this.logger?.warn?.(error);
        this.store.tx(() => this.store.settleUsageReceipt(receipt.request_id, {
          status: 'UNKNOWN',
          note: `the runtime stopped while this request was in flight; ${receipt.reservation_tokens ?? 0} tokens stay held`,
        }));
      }
    }
    this.store.tx(() => {
      for (const lease of leases) {
        const current = this.store.getLease(lease.id);
        if (!current) continue;
        // The messages this turn owned were never answered: its prompt did not
        // become durable, so they go back to the queue rather than dying with it.
        const taken = this.store.get(
          "SELECT json_extract(data,'$.inbox_ids') AS ids FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1",
          lease.cluster_id, lease.agent_id,
        );
        let ids = [];
        try { ids = JSON.parse(taken?.ids ?? '[]'); } catch { ids = []; }
        if (Array.isArray(ids) && ids.length) {
          const reopened = this.store.reopenInbox(ids);
          if (reopened) {
            this.store.appendEvent(lease.cluster_id, 'inbox-reopened', {
              agent_id: lease.agent_id, count: reopened,
              reason: 'the runtime stopped before the turn proved its prompt durable',
            });
          }
        }
        this.store.deleteLease(lease.id);
        this.store.appendEvent(lease.cluster_id, 'lease-fenced', {
          agent_id: lease.agent_id, lease_id: lease.id, epoch: lease.epoch,
          reason: unresponsive
            ? 'the runtime stopped while this turn was live'
            : 'the turn was aborted during shutdown',
        });
        const agent = this.store.getAgent(lease.agent_id);
        if (agent && !AGENT_TERMINAL.has(agent.status)) this.store.updateAgent(lease.agent_id, { status: 'READY' });
      }
    });
  }

  // --------------------------------------------------------- wake/schedule

  wake() {
    const shared = this.#wakeResolve;
    this.#wakePromise = null;
    this.#wakeResolve = null;
    for (const resolve of this.#wakeups.splice(0)) resolve();
    shared?.();
  }

  /**
   * Resolve on the next scheduling event. One shared promise is reused, so a
   * settle loop that polls for hours cannot accumulate resolvers.
   */
  waitForWake() {
    if (this.#disposed) return Promise.resolve();
    if (!this.#wakePromise) {
      this.#wakePromise = new Promise(resolve => {
        this.#wakeResolve = resolve;
      });
    }
    return this.#wakePromise;
  }

  #ensureTicking() {
    if (this.#timer || this.#disposed || this.config.autoTick === false) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(error => this.logger?.error?.(error));
    }, this.config.tickMs);
    this.#timer.unref?.();
  }

  async tick() {
    if (this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      this.#reapTurns();
      this.#abortHungTurns();
      this.#sweepStrandedTransactions();
      // Every non-terminal cluster, in keyset pages: a fixed page of 50 would
      // stop scheduling the 51st cluster while claiming to tick them all.
      let afterId = '';
      for (;;) {
        const page = this.store.listOpenClusters({ afterId, limit: 200 });
        if (!page.length) break;
        for (const cluster of page) {
          this.#expireLeases(cluster.id);
          // eslint-disable-next-line no-await-in-loop
          await this.#scheduleCluster(cluster);
        }
        afterId = page[page.length - 1].id;
        if (page.length < 200) break;
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Drive the cluster until it reaches a terminal or blocked state, or the deadline passes. */
  async runUntilSettled(id, { timeoutMs = 3_600_000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // A settle request must not drive scheduling past the readiness barrier.
    while (!this.#schedulingEnabled && !this.#disposed && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (;;) {
      if (this.#disposed) return this.read(id, { include_events: false });
      const cluster = this.store.getCluster(id);
      if (!cluster) fail('Cluster not found', 404);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(cluster.status)) return this.read(id, { include_events: false });
      // A budget stop is not necessarily final: a settling request releases what it
      // did not use, and that released capacity is what the stopped node needs
      // (measured: a pool 252 tokens short was made whole 1,361 ms later by a
      // settlement, while a run that returned on BLOCKED ended before it landed).
      // So the loop keeps scheduling — which is where the resume lives — for a
      // `BUDGET_EXHAUSTED` stop, inside its own deadline, and returns as soon as the
      // cluster is no longer blocked. Every other stop reason is immediate.
      const blockedForBudget = cluster.status === 'BLOCKED' && this.#recoverableBudgetStop(id);
      if (cluster.status === 'BLOCKED' && !blockedForBudget) return this.read(id, { include_events: false });
      if (blockedForBudget) {
        // Give the recovery its chance first — the resume, and one scheduling pass,
        // which is where a released reservation reopens the cluster…
        this.#resumeBudgetRepaired(cluster);
        // eslint-disable-next-line no-await-in-loop
        await this.#scheduleCluster(cluster);
        const after = this.store.getCluster(id);
        if (after.status === 'BLOCKED') {
          // …and only then decide. If nothing in flight can change capacity — no
          // reservation outstanding and no live turn — a budget stop is final, and
          // waiting on it would consume the whole settle deadline for nothing.
          const inFlight = Number(this.store.get(
            "SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND status='RESERVED'", id)?.c ?? 0) > 0
            || this.#activeTurnCount(id) > 0;
          if (!inFlight) return this.read(id, { include_events: false });
        }
      }
      if (Date.now() > deadline) return this.read(id, { include_events: false });
      this.#reapTurns();
      this.#expireLeases(id);
      // eslint-disable-next-line no-await-in-loop
      await this.#scheduleCluster(cluster);
      if (blockedForBudget) {
        const after = this.store.getCluster(id);
        if (!after || ['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(after.status)) return this.read(id, { include_events: false });
        if (after.status === 'BLOCKED' && !this.#recoverableBudgetStop(id)) return this.read(id, { include_events: false });
      }
      // One outstanding wakeup at a time: a long settle loop must not
      // accumulate resolvers it will never call.
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([this.waitForWake(), new Promise(resolve => setTimeout(resolve, pollMs))]);
    }
  }

  /**
   * Is this cluster's stop one that a settling request could still repair? True only
   * for a `BUDGET_EXHAUSTED` stop with a reservation outstanding somewhere in the
   * cluster: an in-flight request is the one thing that can release capacity without
   * anybody acting. Anything else — a mechanism failure, an uncertain effect, a
   * stagnation stop — returns false, so those remain immediate.
   */
  #recoverableBudgetStop(clusterId) {
    const blocked = this.store.get(
      "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", clusterId);
    return Boolean(blocked && (JSON.parse(blocked.data).code ?? null) === 'BUDGET_EXHAUSTED');
  }

  async #scheduleCluster(cluster) {
    // One barrier for every driver: the interval, `tick()` and `runUntilSettled`
    // all reach scheduling through here.
    if (!this.#schedulingEnabled) return;
    const id = cluster.id;
    // Two drivers (the interval `tick()` and a `runUntilSettled` loop) can reach
    // this method concurrently. Without a per-cluster gate each snapshots the
    // active count, registers turns, and together they exceed the window.
    if (this.#scheduling.has(id)) return;
    this.#scheduling.add(id);
    try {
      // Repair-then-run: a node stopped for `BUDGET_EXHAUSTED` is resumed as soon
      // as its file can pay a turn again. Balances alone were not enough — a
      // rebalance changes numbers, while scheduling only ever selects ACTIVE
      // nodes, so two nodes that received 120 k/12 and 40 k/4 after being blocked
      // stayed blocked for the rest of the run and their subtrees never ran again.
      this.#resumeBudgetRepaired(cluster);
      this.#applyCorrectionBudgetStops(cluster);
      await this.#scheduleClusterLocked(cluster);
    } finally {
      this.#scheduling.delete(id);
    }
  }

  /**
   * Resume what a budget repair has made runnable again — and nothing else.
   *
   * Only a node whose last stop was `BUDGET_EXHAUSTED` is considered, and only when
   * its own file can pay a turn: every other stop reason (a mechanism failure, an
   * uncertain effect, an exhausted role) keeps the node blocked, which is what makes
   * this transition safe rather than a general unblock. The cluster itself is
   * reopened the same way, since scheduling iterates RUNNING clusters only.
   */
  /**
   * Apply a recorded correction-budget stop. The guard refuses the round, and the node
   * stop is applied here so the refusal's rollback cannot take it with it.
   */
  #applyCorrectionBudgetStops(cluster) {
    // The stops are remembered in memory, not in the ledger: the guard refuses the round
    // by throwing, which rolls its transaction back, and an event written inside it would
    // be rolled back with it.
    const stops = this.#correctionStops.get(cluster.id) ?? [];
    if (!stops.length) return;
    this.#correctionStops.delete(cluster.id);
    for (const stop of stops) {
      this.blockNodeInternal(cluster.id, stop.node_id,
        `correction budget exhausted for transaction ${stop.transaction_id}: ${stop.used} of ${stop.max_corrections} rounds failed`,
        'CORRECTION_BUDGET_EXHAUSTED');
      this.store.tx(() => this.store.appendEvent(cluster.id, 'correction-budget-applied', {
        node_id: stop.node_id, transaction_id: stop.transaction_id,
      }));
    }
  }

  /** The guard's refusal cannot write to the ledger (it throws); the stop is noted here. */
  noteCorrectionBudgetStop(clusterId, { nodeId, transactionId, used, maxCorrections }) {
    if (!nodeId) return;
    const stops = this.#correctionStops.get(clusterId) ?? [];
    stops.push({ node_id: nodeId, transaction_id: transactionId ?? null, used, max_corrections: maxCorrections });
    this.#correctionStops.set(clusterId, stops);
  }

  #resumeBudgetRepaired(cluster) {
    const lastEvent = (type, nodeId) => this.store.get(
      `SELECT seq, data FROM events WHERE cluster_id=? AND type=? AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1`,
      cluster.id, type, nodeId,
    );
    const codeOf = (type, nodeId) => {
      const row = lastEvent(type, nodeId);
      return row ? JSON.parse(row.data).code ?? null : null;
    };
    /**
     * A node is runnable again only when *both* hold:
     *  - the request that failed is affordable now, in full; and
     *  - something authorized actually funded it after the stop.
     *
     * The second half matters as much as the first: a node holding 20,000 tokens
     * and one request that refused a 40,000-token request would pass a bare
     * threshold and be resumed into the same refusal, over and over. A resumed node
     * must be one whose budget was *changed* by a transfer, which in this plugin is
     * an explicitly authorized act — never an inference from a balance.
     */
    /**
     * The envelope the stop was about, taken from the refusal of the *identity*
     * that failed — never from the node's own scope, which a refusal does not name
     * (measured: the refusals behind two blocked nodes named an agent and the
     * compaction pool, so a node-scoped lookup found nothing and no node qualified).
     */
    const envelopeOf = (block) => {
      const data = JSON.parse(block.data);
      const agentId = data.agent_id ?? null;
      if (!agentId) return null;
      // The recorded envelope is authoritative: it is what the request needed in
      // every dimension. A refusal only names the dimension that ran out, and
      // repairing just that one resumes a node into the same refusal (measured: a
      // token-only repair with zero requests, and a request-limit refusal checked
      // against a single token rather than the tokens the request would have cost).
      const recorded = data.envelope ?? null;
      const refusal = this.store.get(
        `SELECT data FROM events WHERE cluster_id=? AND type='budget-refused' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1`,
        cluster.id, agentId,
      );
      const refused = refusal ? JSON.parse(refusal.data) : null;
      const tokens = Number(recorded?.tokens ?? (refused?.dimension === 'tokens' ? refused?.requested : 0));
      const modelRequests = Number(recorded?.model_requests ?? (refused?.dimension === 'model_requests' ? refused?.requested : 0));
      const toolCalls = Number(recorded?.tool_calls ?? (refused?.dimension === 'tool_calls' ? refused?.requested : 0));
      if (![tokens, modelRequests, toolCalls].some(value => Number.isFinite(value) && value > 0)) return null;
      return {
        agentId,
        tokens: Number.isFinite(tokens) ? tokens : 0,
        modelRequests: Number.isFinite(modelRequests) ? modelRequests : 0,
        toolCalls: Number.isFinite(toolCalls) ? toolCalls : 0,
      };
    };
    /**
     * One legal payer must cover the *whole* envelope, under a live deadline. The
     * check is *current* affordability — nothing else. Capacity can become available
     * without any grant: a reservation that settles releases the difference between
     * what it held and what it used (measured: a pool 252 tokens short of a request
     * was made whole 1,361 ms later when an in-flight request settled, releasing
     * 352 of its 15,775 reserved tokens). Requiring a transfer event would have kept
     * that node stranded, so what the resume insists on is that the payer can pay
     * *now* — which still refuses to resume anything whose balances are unchanged
     * and still short.
     */
    const affordable = (envelope) => {
      const agent = this.store.getAgent(envelope.agentId);
      if (!agent) return false;
      // Every scope the request could legally be charged to, whichever kind it is:
      // the chain the runtime builds depends on the request's kind (the pool is
      // preferred for compactions), and a resume must not miss the pool just because
      // it does not know what the retried request will be.
      const candidates = [...new Set([
        ...this.budgetChainForAgent(agent, { tokens: envelope.tokens, requests: envelope.modelRequests }),
        this.compactionBudgetId(cluster.id),
        this.store.budgetForScope(cluster.id, 'agent', agent.id)?.id,
        this.fundingBudget(cluster, agent)?.id,
      ].filter(Boolean))];
      const now = this.timestamp();
      return candidates.some(id => {
        const row = this.store.getBudget(id);
        if (!row) return false;
        const deadline = effectiveDeadline(this.store, row);
        if (deadline !== null && deadline <= now) return false;
        return dimensionAvailable(row, 'tokens') >= envelope.tokens
          && dimensionAvailable(row, 'model_requests') >= envelope.modelRequests
          && dimensionAvailable(row, 'tool_calls') >= envelope.toolCalls;
      });
    };
    const repaired = new Set();
    for (const node of this.store.all("SELECT id FROM nodes WHERE cluster_id=? AND status='BLOCKED'", cluster.id)) {
      const block = lastEvent('node-blocked', node.id);
      if (!block || (JSON.parse(block.data).code ?? null) !== 'BUDGET_EXHAUSTED') continue;
      const envelope = envelopeOf(block);
      if (!envelope) continue;
      if (!affordable(envelope)) {
        // Admission already tried to reclaim this node's idle grants. A sibling
        // may still have held a live lease *then* and released it since. Retry
        // that same in-node transfer at the repair point; never take capacity
        // from a different subtree or mint quota. In a strict recursion run the
        // root Allocator finished with 271k free tokens while the root
        // Orchestrator stayed blocked for a 19k compaction request.
        const agent = this.store.getAgent(envelope.agentId);
        if (agent) this.topUpBudgetForAgent(agent, {
          tokens: envelope.tokens,
          model_requests: envelope.modelRequests,
          tool_calls: envelope.toolCalls,
        });
        if (!affordable(envelope)) continue;
      }
      repaired.add(node.id);
      this.store.tx(() => {
        this.store.updateNode(node.id, { status: 'ACTIVE' });
        this.store.appendEvent(cluster.id, 'node-resumed', { node_id: node.id, code: 'BUDGET_REPAIRED' });
      });
      // The agents of a resumed node were blocked with it: they are the ones whose
      // turns the repair exists to make possible.
      this.store.tx(() => {
        for (const agent of this.store.listAgents(cluster.id, { node_id: node.id, limit: 64 })) {
          if (agent.status !== 'BLOCKED') continue;
          this.store.updateAgent(agent.id, { status: 'READY' });
        }
      });
    }
    const blockedCluster = this.store.getCluster(cluster.id);
    if (!blockedCluster || blockedCluster.status !== 'BLOCKED') return;
    const clusterCode = (() => {
      const row = this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", cluster.id);
      return row ? JSON.parse(row.data).code ?? null : null;
    })();
    if (clusterCode !== 'BUDGET_EXHAUSTED') return;
    // The cluster reopens for the node whose stop *was* the cluster's stop — the
    // root — and only once that node passed the same tests. A nonblocked node with
    // tokens somewhere else says nothing about the reason this cluster stopped.
    const clusterBlock = this.store.get(
      "SELECT seq, data FROM events WHERE cluster_id=? AND type='cluster-blocked' ORDER BY seq DESC LIMIT 1", cluster.id);
    const causeNode = clusterBlock ? (JSON.parse(clusterBlock.data).node_id ?? null) : null;
    const rootNode = this.store.listNodes(cluster.id, { parent_id: null })[0]?.id ?? null;
    if (!repaired.has(causeNode ?? rootNode)) return;
    this.store.tx(() => {
      this.store.updateCluster(cluster.id, { status: 'RUNNING' });
      this.store.appendEvent(cluster.id, 'cluster-resumed', { code: 'BUDGET_REPAIRED' });
    });
  }

  async #scheduleClusterLocked(cluster) {
    const id = cluster.id;
    // The caller may hold a stale RUNNING snapshot: a role can block the root
    // between that snapshot and admission. Only a successfully repaired cluster
    // may launch more turns, even if its child nodes are still ACTIVE.
    if (this.store.getCluster(id)?.status !== 'RUNNING') return;
    const limits = cluster.limits;
    const active = this.#activeTurnCount(id);
    const budget = this.store.budgetForScope(id, 'root', id);
    // Grants move `limit` down the tree, so the cluster's remaining capacity is
    // the sum over every scope, never the root row alone.
    const rollup = rollupBudgets(this.store, id);
    const requestsLeft = rollup.model_requests.limit - rollup.model_requests.reserved - rollup.model_requests.spent;
    const toolsLeft = rollup.tool_calls.limit - rollup.tool_calls.reserved - rollup.tool_calls.spent;
    // The whole cluster's remaining capacity, not one scope's: a node that
    // still holds tokens while the cluster's total is spent cannot fund a
    // request, and starting one would only overshoot the declared budget.
    const tokensLeft = rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent;
    // Coded reasons: the reader (and the acceptance ledger) classifies a stop
    // without parsing the sentence that explains it.
    if (rollup.tokens.limit > 0 && tokensLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (tokens)', 'BUDGET_EXHAUSTED');
      return;
    }
    if (rollup.model_requests.limit > 0 && requestsLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (model requests)', 'BUDGET_EXHAUSTED');
      return;
    }
    if (rollup.tool_calls.limit > 0 && toolsLeft <= 0) {
      this.blockClusterInternal(id, 'BUDGET: cluster budget exhausted (tool calls)', 'BUDGET_EXHAUSTED');
      return;
    }
    const deadline = budget ? effectiveDeadline(this.store, budget) : null;
    if (deadline !== null && deadline <= this.timestamp()) {
      this.blockClusterInternal(id, 'LIMIT_REACHED: cluster wall-time deadline passed', 'DEADLINE_PASSED');
      return;
    }

    // The message fixture is idempotent by message id, so it can be attempted
    // on every tick until its target exists.
    this.deliverFixtureMessages(cluster);

    const nodes = this.store.activeManagementNodes(id);
    const root = this.store.listNodes(id, { parent_id: null })[0];
    if (root?.status === 'BLOCKED'
      && !this.#hasActiveDelegatedWork(this.store.nodesInSubtree(id), root.id)
      && this.#activeTurnCount(id) === 0) {
      // A root budget refusal was deferred only while independent descendants
      // could finish and return capacity. Nothing remains to repair it now.
      const stopped = this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        id, root.id,
      );
      const detail = stopped ? JSON.parse(stopped.data) : {};
      this.blockClusterInternal(id, detail.reason ?? 'BUDGET: root could not fund its next request',
        detail.code ?? 'BUDGET_EXHAUSTED', { node_id: root.id });
      return;
    }
    if (!nodes.length) {
      this.evaluateCompletion(id);
      return;
    }

    const rotation = this.#rotation.get(id) ?? 0;
    // Rotation is not fairness by itself: a pass stops when the window fills, and the
    // nodes that always have work — the root and the shallow branches — win every slot
    // ahead of a deep node whose roles have never run at all (measured: a depth-3
    // auditor and allocator at 0 turns with two plan audits pending, while depths 0-2
    // had 2-3 turns each, and the run ended on the Orchestrator's escalation about
    // exactly those undecided audits). A node none of whose roles has ever been admitted
    // is therefore served first.
    // Per *role*, not per node: the failed node had already taken one Orchestrator turn,
    // so a node-level test left its zero-turn Allocator and Auditor starving behind
    // branches that always have work.
    const freshRoles = (nodeId) => {
      const roles = [];
      for (const role of MANAGEMENT_ROLES) {
        const agent = this.roleAgentOf(id, nodeId, role);
        if (!agent || agent.status !== 'READY' || this.#activeTurns.has(agent.id)) continue;
        const started = Number(this.store.get(
          `SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=?`,
          id, agent.id)?.c ?? 0);
        if (started === 0) roles.push(role);
      }
      return roles;
    };
    const withFreshRoles = nodes.filter(node => freshRoles(node.id).length > 0);
    const ordered = [
      ...rotate(withFreshRoles, rotation),
      ...rotate(nodes.filter(node => !withFreshRoles.includes(node)), rotation),
    ];
    const refusalsBefore = this.#refusals.get(id) ?? 0;
    let registered = 0;

    // The window is shared, and it is shared *by purpose*: supervision may not
    // consume the slots the work itself needs. A run of 26 management turns with
    // zero Worker turns — three transactions READY with ACTIVE allocations and no
    // dependencies, for 1067 seconds — is what "management first" costs when five
    // management nodes each have three roles and the window is six.
    //
    // One slot is held back whenever a Worker is waiting to run, and the
    // per-pass ceiling below is what lets it through.
    const workerWaiting = this.store.readyForWorker(id, { limit: 1 }).length > 0;
    // A one-slot window is a serialization: management work is effectively endless
    // (a role always has something to look at), so taking the slot every pass starves
    // the Worker for as long as management keeps finding work. The slot alternates.
    const singleSlot = limits.max_active_agents === 1;
    const lastClass = this.#lastAdmittedClass.get(id) ?? null;
    const { managementCeiling } = scheduleAdmission({ window: limits.max_active_agents, workerWaiting });
    const yieldSlotToWorker = singleSlot && workerWaiting && lastClass === 'management';
    // The window is read live before every start. `started` is only a progress
    // counter for the rotation below — adding it to the live count as well
    // double-counted every turn this pass had registered and left a slot empty
    // in each pass.
    for (const node of ordered) {
      if (yieldSlotToWorker) break;
      // Two independent guards, and both are needed:
      //  - the *window* is a hard cap on resident turns of every class together
      //    (§9/G6: peak resident turns may never exceed `max_active_agents`), so
      //    it is checked against the total, not against one class; and
      //  - the class ceiling decides how much of that window management may take
      //    without leaving a waiting Worker nothing, which is a fairness rule, not
      //    a capacity rule.
      // Measuring the fairness rule against the total was the earlier starvation
      // (Workers holding every slot skipped every manager); measuring *only*
      // against the class, as a first attempt at the fix did, admits a manager on
      // top of a full window of Workers.
      if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
      if (this.#activeTurnCount(id, 'management') >= managementCeiling) break;
      // Roles rotate per node, on actual starts: a fixed order with a tight window
      // let the first role consume every slot while the later ones never ran at all
      // (measured: a depth-3 Auditor still READY with zero turns and five pending
      // notifications, while its Orchestrator had taken three turns). Round-robin
      // starts at whatever the node admitted last.
      // A role that has never been admitted at all goes first in this node's scan, before
      // the rotation decides the rest.
      const fresh = freshRoles(node.id);
      const roleOrder = fresh.length
        ? [...fresh, ...MANAGEMENT_ROLES.filter(role => !fresh.includes(role))]
        : MANAGEMENT_ROLES;
      const offset = (this.#roleRotation.get(node.id) ?? 0) % roleOrder.length;
      for (let index = 0; index < roleOrder.length; index += 1) {
        const role = roleOrder[(offset + index) % roleOrder.length];
        if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
        if (this.#activeTurnCount(id, 'management') >= managementCeiling) break;
        const agent = this.roleAgentOf(id, node.id, role);
        if (!agent || agent.status === 'TERMINATED' || agent.status === 'BLOCKED' || this.#activeTurns.has(agent.id)) continue;
        if (agent.turns >= limits.max_role_turns) {
          this.blockNodeInternal(id, node.id, `role ${role} exhausted its turn budget (${limits.max_role_turns})`);
          continue;
        }
        const pending = this.#pendingFor(role, node, cluster, agent);
        if (!pending.length) continue;
        const outcome = await this.#startTurn(cluster, agent, role, { node, pending });
        if (outcome?.started) {
          registered += 1;
          if (singleSlot) this.#lastAdmittedClass.set(id, 'management');
          // Next pass starts where this one left off, so a later role gets the slot.
          this.#roleRotation.set(node.id, (offset + index + 1) % roleOrder.length);
        }
      }
    }

    // Workers fill the remaining slots. The management reserve is already
    // expressed by the ceiling above, so subtracting it here again would leave
    // the window one slot short of what the pass actually admitted.
    const managementPending = ordered.some(node => ['orchestrator', 'allocator', 'auditor'].some(role => {
      const agent = this.roleAgentOf(id, node.id, role);
      return Boolean(agent) && agent.status !== 'TERMINATED' && agent.status !== 'BLOCKED'
        && !this.#activeTurns.has(agent.id) && agent.turns < limits.max_role_turns
        && this.#pendingFor(role, node, cluster, agent).length > 0;
    }));
    const { workerSlots } = scheduleAdmission({
      window: limits.max_active_agents,
      active: this.#activeTurnCount(id),
      workerWaiting,
      managementActive: this.#activeTurnCount(id, 'management'),
      managementPending,
    });
    if (workerSlots > 0) {
      const workersStarted = await this.#scheduleWorkers(cluster, Math.min(workerSlots, limits.max_active_agents));
      registered += workersStarted;
      if (singleSlot && workersStarted > 0) this.#lastAdmittedClass.set(id, 'worker');
    }

    // Section 11's producers that only the scheduler can observe: a transaction
    // that has not moved for too long, an identity whose provider call failed,
    // and a load signal the Allocator must see.
    this.#publishStaleTransactions(cluster);
    this.#publishLoad(cluster, limits);

    this.#rotation.set(id, (rotation + 1) % Math.max(1, ordered.length));
    void refusalsBefore;
    if (!registered) this.evaluateCompletion(id);
    else if (this.#activeTurns.size === 0) this.wake();
  }

  /**
   * `transaction-stale`: work that has not moved for longer than the staleness
   * window. Deduplicated per revision, so the notify is an event rather than a
   * per-tick stream.
   */
  #publishStaleTransactions(cluster) {
    const staleBefore = this.timestamp() - this.config.staleMs;
    const now = this.timestamp();
    const rows = this.store.all(
      `SELECT id, revision, status, node_id, updated FROM transactions t
        WHERE t.cluster_id=? AND t.status IN ('READY','DISPATCHED','SUBMITTED','RUNNING') AND t.updated < ?
          AND NOT EXISTS (
            SELECT 1 FROM transactions child
              WHERE child.cluster_id=t.cluster_id AND child.parent_transaction_id=t.id
                AND child.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED'))
          AND NOT EXISTS (SELECT 1 FROM allocations a JOIN leases l ON l.agent_id = a.agent_id
                           WHERE a.transaction_id = t.id AND a.status='ACTIVE' AND l.expires > ?)
          AND NOT EXISTS (
            SELECT 1 FROM events e WHERE e.cluster_id=t.cluster_id AND e.type='transaction-stale'
              AND json_extract(e.data,'$.transaction_id')=t.id
              AND json_extract(e.data,'$.revision')=t.revision)
        ORDER BY t.updated LIMIT 8`, cluster.id, staleBefore, now);
    for (const row of rows) {
      const staleMs = Math.max(0, this.timestamp() - Number(row.updated));
      // One notification per (transaction, revision): the fact is the same on
      // every tick, and a scan that appended an event each time wrote ten
      // thousand rows in one stalled run.
      this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, row.node_id, 'auditor')?.id, {
        subject: 'transaction-stale', payload: { transaction_id: row.id, status: row.status, stale_ms: staleMs, revision: row.revision },
        dedupeKey: `stale:${row.id}:${row.revision}`,
      });
      this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, row.node_id, 'orchestrator')?.id, {
        subject: 'transaction-stale', payload: { transaction_id: row.id, status: row.status, stale_ms: staleMs, revision: row.revision },
        dedupeKey: `stale:${row.id}:${row.revision}`,
      });
      this.store.appendEvent(cluster.id, 'transaction-stale', {
        transaction_id: row.id, status: row.status, stale_ms: staleMs, revision: row.revision,
      });
    }
  }

  /**
   * `load-changed`: the window is saturated or work is queued for the model.
   * One report per time bucket, and the *fact* is notified and recorded
   * together: a saturated window is true on every tick, and a scan that wrote
   * an event each time buried the run's real events under thousands of rows.
   */
  #publishLoad(cluster, limits) {
    const active = this.#activeTurnCount(cluster.id);
    const waiting = this.llmWaiters();
    if (active < limits.max_active_agents && waiting === 0) return;
    const bucket = Math.floor(this.timestamp() / Math.max(1000, this.config.staleMs / 4));
    const key = `load:${cluster.id}:${bucket}`;
    const recipient = this.roleAgentOf(cluster.id, this.store.listNodes(cluster.id, { parent_id: null })[0]?.id, 'allocator')?.id ?? null;
    if (this.#alreadyNotified(key, recipient)) return;
    this.notifyInternal(cluster.id, recipient, {
      subject: 'load-changed',
      payload: { active_turns: active, max_active_agents: limits.max_active_agents, llm_waiters: waiting, llm_in_use: this.llmSlotsInUse() },
      dedupeKey: key,
    });
    this.store.appendEvent(cluster.id, 'load-changed', {
      active_turns: active, max_active_agents: limits.max_active_agents, llm_waiters: waiting,
    });
  }

  /** Whether this exact notification was already queued for this recipient. */
  #alreadyNotified(dedupeKey, recipient) {
    return Boolean(this.store.get('SELECT id FROM inbox WHERE dedupe_key=?', `${dedupeKey}:${recipient ?? 'none'}`));
  }

  /** Registered turns for one cluster, read live rather than from a snapshot. */
  #activeTurnCount(id, klass = null) {
    let count = 0;
    for (const entry of this.#activeTurns.values()) {
      if (entry.cluster_id !== id) continue;
      if (klass === 'worker' && entry.role === 'worker') { count += 1; continue; }
      if (klass === 'management' && entry.role !== 'worker') { count += 1; continue; }
      if (klass === null) count += 1;
    }
    return count;
  }

  async #scheduleWorkers(cluster, slots) {
    const id = cluster.id;
    const limits = cluster.limits;
    let started = 0;
    // The eligible set is asked for in keyset pages and the pass stops when the
    // window is full, not when a fixed page runs out: a READY, allocated
    // transaction behind the first 200 still gets a Worker.
    let cursor = null;
    for (;;) {
      if (started >= slots) break;
      const page = this.store.readyForWorker(id, { after: cursor, limit: 100 });
      if (!page.length) break;
      for (const tx of page) {
        cursor = { priority: tx.priority, created: tx.created, id: tx.id };
        if (started >= slots) break;
        // The window is a hard cap on resident turns of every class together
        // (§9/G6): the pass allowance already leaves a class reserve, and this is
        // the capacity check that no allowance may exceed.
        if (this.#activeTurnCount(id) >= limits.max_active_agents) break;
        const allocation = this.store.activeAllocationForTransaction(tx.id);
        if (!allocation) continue;
        // A revised transaction is a different plan. Its old Worker grant
        // cannot silently acquire authority over the new revision; the owning
        // Allocator must drain and replace it before scheduling another turn.
        if (this.store.allocationOutdated(id, allocation)) continue;
        const agent = this.store.getAgent(allocation.agent_id);
        if (!agent || agent.status === 'TERMINATED' || agent.status === 'BLOCKED' || this.#activeTurns.has(agent.id)) continue;
        // eslint-disable-next-line no-await-in-loop
        const outcome = await this.#startWorkerTurn(cluster, agent, tx, allocation);
        if (outcome?.started) started += 1;
      }
      if (page.length < 100) break;
    }
    return started;
  }

  /** The pending actions for one role/node, exposed for tests and diagnostics. */
  pendingFor(role, node, cluster, agent = null) {
    return this.#pendingFor(role, node, cluster, agent);
  }

  /** The delegation instructions a node still owes, for tests and diagnostics. */
  delegationInstructions(clusterId, nodeId) {
    const cluster = this.store.getCluster(clusterId);
    const node = this.store.getNode(nodeId);
    return node ? this.#requiredDelegation(cluster, node) : [];
  }

  /** The delegation instruction this node still owes, or null when none is due. */
  pendingDelegationInstruction(cluster, node) {
    const required = this.#requiredDelegation(cluster, node);
    const have = this.store.childrenOf(node.id).filter(child => child.kind === 'management').length;
    return have < required.length ? required[have] : null;
  }

  /**
   * A fixture entry is ready once its target has a live allocation and its
   * source is actually being worked on. Waiting for full acceptance would make
   * the delivery pipeline's exercise depend on the model converging.
   */
  #fixtureReady(cluster, entry) {
    const source = this.store.getTransaction(entry.from);
    if (!source) return false;
    return Boolean(this.#fixtureRecipient(cluster, entry));
  }

  /**
   * Who receives a fixture message: a Worker of another allocation (a different
   * worker node, so the delivery really crosses subtrees), or, when no sibling
   * is allocated yet, the Auditor of the source's management node. The fixture
   * must not depend on the model allocating one particular transaction.
   */
  #fixtureRecipient(cluster, entry) {
    // A stable identity first: the Auditor of the source's management node
    // exists from cluster start, so the fixture fires once and always targets
    // the same agent. A sibling Worker is the fallback when no Auditor exists
    // (a Worker node is a different node from the source's, so the delivery
    // still crosses subtrees).
    const source = this.store.getTransaction(entry.from);
    // Prefer a Worker whose own node differs from the source's: that is the
    // cross-subtree delivery the fixture exists to exercise.
    const sourceNode = source ? this.store.getNode(source.node_id)?.parent_id ?? source.node_id : null;
    for (const allocation of this.store.listAllocations({ cluster_id: cluster.id, status: 'ACTIVE', limit: 500 })) {
      if (allocation.transaction_id === entry.from) continue;
      const agent = this.store.getAgent(allocation.agent_id);
      if (!agent || agent.status === 'TERMINATED') continue;
      const node = this.store.getNode(agent.node_id);
      if (node && node.parent_id === sourceNode) return agent;
    }
    // No sibling branch exists yet: the source's own management Auditor is a
    // different node, but the same management node as the sender.
    const rootId = source?.node_id ?? this.store.listNodes(cluster.id, { parent_id: null })[0]?.id;
    const auditor = rootId ? this.roleAgentOf(cluster.id, rootId, 'auditor') : null;
    return auditor && auditor.status !== 'TERMINATED' ? auditor : null;
  }

  /** Management children a node must still build according to the topology fixture. */
  #requiredDelegation(cluster, node) {
    const fixture = cluster.spec?.delegation ?? [];
    if (!node.parent_id) return fixture;
    // A delegation chain descends *one level at a time*: the node owes at most
    // one pending instruction, and the instruction carries how many levels are
    // still to come. Handing a node several instructions at once let a model
    // build the whole chain in one action and silently skip the intermediate
    // management levels the fixture exists to exercise.
    const spawn = node.scope?.spawn_children ?? 0;
    if (!spawn) return [];
    const inherited = { ...(node.scope?.delegation_entry ?? {}), scope: `${node.scope?.objective ?? 'child'} / nested` };
    return [inherited];
  }

  #managementPending(id, cluster) {
    for (const node of this.store.listNodes(id, { status: 'ACTIVE' })) {
      for (const role of ['orchestrator', 'allocator', 'auditor']) {
        if (this.#pendingFor(role, node, cluster).length) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- turns

  async #startTurn(cluster, agent, role, { node, pending }) {
    const id = cluster.id;
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      // An uncertain effect really stops the owner: a model turn can repeat the
      // same non-idempotent work through any tool it holds.
      this.store.tx(() => {
        this.store.updateAgent(agent.id, { status: 'BLOCKED' });
        this.store.appendEvent(id, 'agent-blocked', {
          agent_id: agent.id, role, code: 'EFFECT_UNCERTAIN', call_id: uncertain.call_id, tool: uncertain.tool,
          reason: `an earlier ${uncertain.tool} call may or may not have executed before the restart; resolve it with flow_allocation action "resolve_effect"`,
        });
        this.blockNodeInternal(id, node?.id ?? agent.node_id,
          `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) needs a decision before this identity runs again`,
          'EFFECT_UNCERTAIN');
      });
      return { started: false };
    }
    // Fund the turn before it starts. A node dry in one dimension at the moment
    // its role is due to run stops the node on budget — the case's mechanism
    // stop — even when the cluster holds the capacity in another branch: the
    // refusal must be a real exhaustion, not a stale partition.
    this.ensureTurnFunding(cluster, agent);
    const ac = new AbortController();
    this.#flowCalls.set(agent.id, 0);
    this.#toolCallLog.set(agent.id, []);
    // The notifications this turn is answering are consumed in the *same
    // transaction* that takes the lease and records the turn's start, so a crash
    // before the turn leaves them queued; a turn that took them and then failed
    // before admitting its prompt hands them back (see the finisher).
    const inboxIds = (pending ?? []).filter(item => item.inbox_id).map(item => item.inbox_id);
    // Acting on a refusal is once: the event is acknowledged in the same transaction
    // that takes the turn, so the pending action disappears — and a *new* refusal
    // (a higher seq) still surfaces.
    const refusalItems = (pending ?? []).filter(item => item.refusal_seq !== undefined).flatMap(item =>
      (item.refusal_seqs ?? [item.refusal_seq]).map(seq => ({
        seq: Number(seq), action: item.action,
        transaction_id: item.transaction_id ?? null, node_id: item.node_id ?? null,
      })));
    if (refusalItems.length) {
      // Remembered against the identity, with what each one is *about*, and not
      // acknowledged yet: a turn that fails or does nothing leaves the refusal
      // pending, and only a command that commits the matching correction or
      // escalation acknowledges it. Remembering just the seq dropped every refusal
      // whenever any unrelated command returned a transaction id — approving an
      // audit is not a correction.
      this.#pendingRefusals.set(agent.id, refusalItems);
    }
    // The paging cursor moves only for work this turn really took: the page the
    // Auditor is about to decide.
    if (role === 'auditor') {
      const taken = (pending ?? []).map(item => item.audit_id).filter(Boolean);
      if (taken.length) {
        const rows = taken.map(auditId => this.store.getAudit(auditId)).filter(Boolean);
        if (rows.length) {
          const last = rows.at(-1);
          this.#auditCursor.set(node.id, { created: last.created, id: last.id });
        }
      } else if (this.#auditCursor.has(node.id)) {
        // Nothing left past the cursor, and this turn is still running: the
        // survey is over, so the next one starts from the oldest pending
        // decision again. Without the reset an audit that arrived after the
        // cursor advanced was never visited, and its transaction sat in
        // VALIDATING forever.
        this.#auditCursor.delete(node.id);
      }
    }
    this.store.appendEvent(id, 'turn-actions', {
      agent_id: agent.id, role, actions: (pending ?? []).map(item => item.action).slice(0, 16),
      inbox_consumed: inboxIds.length,
    });
    const lease = this.#acquireLease(cluster, agent, `${role}-turn`, inboxIds);
    // A refusal this turn took up is handled once: the acknowledgement is written
    // before the turn runs, in the same pass that admitted it.

    const turnSeq = agent.turns + 1;
    const identity = {
      cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, role,
      epoch: lease.epoch, lease_id: lease.id, turn_seq: turnSeq,
    };
    // Admission is an event, not a return value: a turn that admits the prompt
    // and then throws must still count as admitted, or its deliveries would be
    // reopened and injected a second time.
    let admittedThisTurn = false;
    let flushedThisTurn = false;
    let failures = this.#startFailures.get(agent.id) ?? 0;
    // Binding records both the identity and the live instance: the checkpoint
    // needs the instance to read its native session offset.
    const bind = live => {
      this.bindTurnIdentity(live, identity);
      const entry = this.#activeTurns.get(agent.id);
      if (entry) entry.instance = live;
    };
    const onAdmitted = () => {
      admittedThisTurn = true;
    };
    // The host answers the flush with a boolean; a rejected flush is not a
    // durable turn, and pretending otherwise acked deliveries that were never
    // written to disk.
    const onFlushed = ok => {
      flushedThisTurn = ok !== false;
    };
    const budgetIds = this.agentBudgetChain(cluster, agent);
    // Deliveries are taken before the prompt is built: they are part of this
    // turn's input, and the prompt must name each message's stable id.
    const policy = this.allowedToolsFor(cluster, role, agent);
    const before = this.progressSeq(id);
    const turn = (async () => {
      let deliveries = { messages: [], ids: [] };
      let outcome = null;
      let error = null;
      let slot = null;
      // The permit is taken *inside* the cleanup: a failure while acquiring it —
      // or while collecting deliveries, or building the prompt — must still reach
      // the finisher, which releases the lease, books the turn and hands an
      // unanswered message back. Outside it, the closure threw before its own
      // finisher and the message stayed consumed.
      try {
        slot = await this.acquireLlmSlot(id);
        // Delivery collection happens inside the turn: it may have to prove
        // messages against the Session, and that wait must not hold the
        // scheduling pass that is filling the rest of the window.
        deliveries = await this.collectDeliveries(agent);
        const prompt = this.#rolePrompt(cluster, node, agent, role, pending, deliveries.messages);
        outcome = await runTurn(this.ctx, {
          agent, role, prompt, systemInstructions: ROLE_INSTRUCTIONS[role],
          allowedTools: policy.allowed, globalTools: policy.global,
          capabilities: policy.capabilities, resume: agent.turns > 0, cwd: cluster.workspace,
          model: this.modelFor(agent), signal: ac.signal, logger: this.logger,
          budgetIds, turnSeq, flow: this, contextLimits: this.config.context,
          forceCompact: this.#forceCompact.has(agent.id), onAgentReady: bind, onAdmitted, onFlushed,
        });
      } catch (cause) {
        error = cause;
      } finally {
        if (slot) slot();
      }
      this.#startFailures.set(agent.id, failures);
      this.#finishTurn(cluster, agent, role, { turnSeq, inboxIds,
        node, outcome, error, before, lease, deliveries: deliveries.ids, admitted: admittedThisTurn,
        durable: admittedThisTurn && flushedThisTurn, failures,
      });
    })();
    this.#activeTurns.set(agent.id, { promise: turn, ac, lease, cluster_id: id, agent_id: agent.id, node_id: node.id, role, started: this.timestamp() });
    turn.catch(error => this.logger?.error?.(error));
    // Return after *registration*, not after completion: the scheduling pass
    // exists to fill the window, and awaiting the whole turn here would let one
    // driver start exactly one agent at a time.
    return { started: true, agent_id: agent.id, turn };
  }

  async #startWorkerTurn(cluster, agent, tx, allocation) {
    const turnSeq = agent.turns + 1;
    const id = cluster.id;
    // The last line of defence for a delegated parent that already holds an
    // allocation: eligibility excludes it, and admission refuses it too, so no path
    // can spend its attempts on work the children have not reported yet.
    if (this.store.parentsAwaitingChildren(id).includes(tx.id)) {
      this.store.appendEvent(id, 'worker-deferred', {
        transaction_id: tx.id, agent_id: agent.id,
        reason: 'delegated work is still unfinished; the parent waits for the child results',
      });
      return { started: false };
    }
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      this.store.tx(() => {
        this.store.updateAgent(agent.id, { status: 'BLOCKED' });
        this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        this.store.appendEvent(id, 'agent-blocked', {
          agent_id: agent.id, role: 'worker', code: 'EFFECT_UNCERTAIN', call_id: uncertain.call_id, tool: uncertain.tool,
          transaction_id: tx.id,
          reason: `an earlier ${uncertain.tool} call may or may not have executed before the restart; resolve it with flow_allocation action "resolve_effect"`,
        });
        this.blockNodeInternal(id, allocation.node_id,
          `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) needs a decision before this identity runs again`,
          'EFFECT_UNCERTAIN');
      });
      return { started: false };
    }
    // Fund the turn before it starts. A node dry in one dimension at the moment
    // its role is due to run stops the node on budget — the case's mechanism
    // stop — even when the cluster holds the capacity in another branch: the
    // refusal must be a real exhaustion, not a stale partition.
    this.ensureTurnFunding(cluster, agent);
    const ac = new AbortController();
    this.#flowCalls.set(agent.id, 0);
    this.#toolCallLog.set(agent.id, []);
    const lease = this.#acquireLease(cluster, agent, 'worker-turn');
    const identity = {
      cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, role: 'worker',
      epoch: lease.epoch, lease_id: lease.id, turn_seq: agent.turns + 1,
    };
    // Admission is an event, not a return value: a turn that admits the prompt
    // and then throws must still count as admitted, or its deliveries would be
    // reopened and injected a second time. Durability is tracked separately:
    // admission alone does not make the message replay-safe.
    let admittedThisTurn = false;
    let flushedThisTurn = false;
    let failures = this.#startFailures.get(agent.id) ?? 0;
    const bind = live => {
      this.bindTurnIdentity(live, identity);
      const entry = this.#activeTurns.get(agent.id);
      if (entry) entry.instance = live;
    };
    const budgetIds = this.agentBudgetChain(cluster, agent, tx);
    const policy = this.allowedToolsFor(cluster, 'worker', agent);
    const before = this.progressSeq(id);
    this.store.tx(() => {
      const current = this.store.getTransaction(tx.id);
      if (current.status === 'READY') setTransactionStatus(this.store, this, cluster, current, 'RUNNING');
      // The attempt is counted when the prompt is really admitted (see
      // `onAdmitted`), so an infrastructure rejection costs nothing.
    });
    const onAdmitted = () => {
      admittedThisTurn = true;
      this.store.tx(() => {
        const current = this.store.getTransaction(tx.id);
        if (!current || current.status !== 'RUNNING') return;
        this.store.updateTransaction(tx.id, { attempts: current.attempts + 1, __bump_revision: false });
      });
    };
    // The host answers the flush with a boolean; a rejected flush is not a
    // durable turn, and pretending otherwise acked deliveries that were never
    // written to disk.
    const onFlushed = ok => {
      flushedThisTurn = ok !== false;
    };
    const turn = (async () => {
      let deliveries = { messages: [], ids: [] };
      let outcome = null;
      let error = null;
      let slot = null;
      try {
        slot = await this.acquireLlmSlot(id);
        deliveries = await this.collectDeliveries(agent);
        const prompt = this.#workerPrompt(cluster, tx, allocation, deliveries.messages);
        outcome = await runTurn(this.ctx, {
          agent, role: 'worker', prompt, allowedTools: policy.allowed, globalTools: policy.global,
          capabilities: policy.capabilities, resume: agent.turns > 0, cwd: cluster.workspace,
          model: this.modelFor(agent), signal: ac.signal, logger: this.logger,
          budgetIds, transactionId: tx.id, turnSeq, flow: this, contextLimits: this.config.context,
          forceCompact: this.#forceCompact.has(agent.id), onAgentReady: bind, onAdmitted, onFlushed,
        });
      } catch (cause) {
        error = cause;
      } finally {
        if (slot) slot();
      }
      this.#startFailures.set(agent.id, failures);
      this.finishWorkerTurn(cluster, agent, tx, allocation, {
        outcome, error, before, lease, deliveries: deliveries.ids, admitted: admittedThisTurn,
        durable: admittedThisTurn && flushedThisTurn, failures, turnSeq,
      });
    })();
    this.#activeTurns.set(agent.id, { promise: turn, ac, lease, cluster_id: id, agent_id: agent.id, node_id: agent.node_id, role: 'worker', started: this.timestamp() });
    turn.catch(error => this.logger?.error?.(error));
    // Registered, not awaited: the pass must be able to fill the remaining slots.
    return { started: true, agent_id: agent.id, turn };
  }

  #finishTurn(cluster, agent, role, { node, outcome, error, before, lease, deliveries, admitted = false, durable = false, failures = 0, turnSeq = null, inboxIds = [] }) {
    // Read the fencing verdict first: releasing the lease is what makes a later
    // read say "not held".
    const leaseValid = this.leaseStillHeld(lease);
    if (!leaseValid) {
      // The identity was replaced or the lease expired: this turn owns nothing
      // any more, so it must not touch the agent, the transaction or the budget.
      this.#forgetLease(lease);
      this.#activeTurns.delete(agent.id);
      try {
        this.store.appendEvent(cluster.id, 'turn-fenced', {
          agent_id: agent.id, role, turn: agent.turns + 1, lease_epoch: lease.epoch,
          note: 'the turn finished after its lease was replaced',
        });
      } catch (cause) {
        this.logger?.warn?.(cause);
      }
      this.wake();
      return;
    }
    this.#releaseLease(cluster.id, agent.id, lease);
    try {
      // The turn's decisions already happened, so a failed reconciliation
      // cannot undo them. It can, and must, fence the owner against acting
      // again until its accounting has a resolvable payer. Always book the
      // completed turn and its delivery facts below.
      let accountingUncertain = false;
      try {
        accountingUncertain = (this.reconcileReservations(cluster, agent)?.uncertain ?? 0) > 0;
      } catch (cause) {
        accountingUncertain = true;
        this.store.tx(() => this.store.appendEvent(cluster.id, 'accounting-uncertain', {
          agent_id: agent.id, transaction_id: null, reason: String(cause?.message ?? cause).slice(0, 300),
          code: 'ACCOUNTING_UNCERTAIN',
        }));
      }
      if (accountingUncertain) {
        this.store.tx(() => this.store.updateAgent(agent.id, { status: 'BLOCKED' }));
        this.blockNodeInternal(cluster.id, agent.node_id,
          `ACCOUNTING_UNCERTAIN: ${role} cannot attribute the request from its last turn`,
          'ACCOUNTING_UNCERTAIN');
      }
      if (deliveries?.length) this.settleDeliveries(cluster.id, agent.id, deliveries, { admitted, durable });
      // A turn that took messages and never made its prompt *durable* did not
      // answer them: not admitted, or admitted and then refused at the flush. They
      // go back to the queue, where the next pass offers them again.
      if (!durable && inboxIds.length) {
        const reopened = this.store.tx(() => this.store.reopenInbox(inboxIds));
        if (reopened) {
          this.store.appendEvent(cluster.id, 'inbox-reopened', {
            agent_id: agent.id, role, count: reopened,
            reason: admitted ? 'the prompt was admitted but its session was not flushed' : 'the prompt was never admitted',
          });
        }
      }
      this.store.tx(() => {
        const progress = this.progressSeq(cluster.id) !== before;
        const turns = agent.turns + 1;
        const overflowed = ['CONTEXT_WINDOW_EXCEEDED', 'PI_AI_ERROR'].includes(outcome?.stopDetail?.code)
          && /overflow|exceeds the maximum allowed length/i.test(String(outcome?.stopDetail?.message ?? ''));
        if (overflowed) {
          // A provider overflow is not the model's stagnation: ask for a forced
          // compaction before the next turn instead of counting it against it.
          this.#forceCompact.add(agent.id);
          this.store.appendEvent(cluster.id, 'context-overflow', { agent_id: agent.id, role, turn: turns });
        } else if (outcome?.stopReason === 'completed') {
          this.#forceCompact.delete(agent.id);
        }
        const stagnation = progress || overflowed ? 0 : agent.stagnation + 1;
        // A blocked accounting owner must not be made schedulable again merely
        // because the finisher booked its turn.
        const currentStatus = this.store.getAgent(agent.id)?.status ?? agent.status;
        this.store.updateAgent(agent.id, {
          turns: this.#bookTurn(agent, turnSeq, turns), stagnation,
          status: AGENT_TERMINAL.has(currentStatus) || currentStatus === 'BLOCKED' ? currentStatus : 'READY',
          epoch: lease.epoch,
        });
        this.store.insertCheckpoint({
          id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, session_id: agent.session_id,
          // Two different logs, recorded separately: the native session offset
          // is where the agent's own history stands, the event cursor is where
          // the cluster's own log stands.
          flushed_seq: outcome?.native_seq ?? null,
          events_seq: this.store.latestEventSeq(cluster.id),
          transaction_id: null, transaction_revision: null,
          inbox_ack_cursor: null, usage_watermark: this.usageWatermark(cluster.id), turn_seq: turns,
          data: { role, node_id: node?.id ?? null, stop_reason: outcome?.stopReason ?? 'error', model_requests: outcome?.usage?.length ?? 0 },
        });
        this.store.appendEvent(cluster.id, 'turn-end', {
          agent_id: agent.id, role, turn: turns,
          tools_used: [...new Set(this.#toolCallLog.get(agent.id) ?? [])].sort(),
          stop_reason: outcome?.stopReason ?? 'error',
          stop_detail: outcome?.stopDetail ?? null,
          context: outcome?.context ?? null,
          progress, error: error ? String(error.message ?? error) : null,
        });
        if ((error || outcome?.stopReason === 'error')
          && !this.modelRequestRefusedThisTurn(cluster.id, agent.id, lease, outcome, error)) {
          this.recordAgentAnomaly({ ...agent, role }, {
            code: error?.code ?? outcome?.stopDetail?.code ?? null,
            message: error ? String(error.message ?? error).slice(0, 200) : (outcome?.stopDetail?.message ?? 'the model request failed'),
          });
        }
        if (!progress && stagnation >= 3) {
          // A role that cannot act because its scope has no budget left has not
          // stagnated: naming the budget is what makes the stop diagnosable
          // instead of looking like a planning failure.
          // "Starved" means no scope in this identity's funding chain can pay,
          // which is exactly what admission concluded — not that the node file is
          // empty. A request charged to the compaction pool leaves the node's own
          // request column at zero, and reading that as starvation stopped a node
          // whose turns were being admitted the whole time.
          // Classify from the refusal's own admission facts: the scope that really
          // refused and the dimension it ran out of. Deriving "starved" from
          // `budgetChainForAgent` was wrong twice over — that helper ignores the
          // dimension it is asked about and normal picks the compaction pool, whose
          // tool quota is deliberately zero, so a no-op role with ample tool quota
          // was reported as budget-blocked.
          // Only a *terminal* refusal for this identity, recorded since its last
          // progress, can relabel these turns. A repaired shortfall is a different
          // event type; a refusal from before its last productive turn is history; and
          // with no refusal at all the stop is the stagnation this bound exists for —
          // inferring budget failure from one row declared a query-only role
          // exhausted while its pool was solvent and no request had been refused.
          const progressSeq = this.store.get(
            `SELECT seq FROM events WHERE cluster_id=? AND type='turn-end'
              AND json_extract(data,'$.agent_id')=? AND json_extract(data,'$.progress') IN (1,'true')
              ORDER BY seq DESC LIMIT 1`, cluster.id, agent.id)?.seq ?? 0;
          const lastRefusal = this.store.get(
            `SELECT seq, data FROM events WHERE cluster_id=? AND type='budget-refused'
              AND json_extract(data,'$.agent_id')=? AND seq > ? ORDER BY seq DESC LIMIT 1`,
            cluster.id, agent.id, Number(progressSeq));
          const refused = lastRefusal ? JSON.parse(lastRefusal.data) : null;
          const named = refused?.dimension ?? null;
          const refusedScope = refused?.scope
            ? this.store.getBudget(this.store.all(
              "SELECT id FROM budgets WHERE cluster_id=? AND (scope_id=? OR id=?)", cluster.id, refused.scope, refused.scope,
            )[0]?.id)
            : null;
          const starved = named && (!refusedScope || dimensionAvailable(refusedScope, named) <= 0) ? [named] : [];
          const envelope = refused
            ? { tokens: named === 'tokens' ? Number(refused.requested ?? 0) || 0 : 0,
              model_requests: named === 'model_requests' ? Number(refused.requested ?? 0) || 0 : 0,
              tool_calls: named === 'tool_calls' ? Number(refused.requested ?? 0) || 0 : 0 }
            : null;
          const reason = starved.length
            ? `${role} could not act: its scope has no ${starved.join(' or ')} left`
            : `${role} made no state change across ${stagnation} turns`;
          // A starved role is a budget stop and is coded as one, so the report
          // classifies it without reading the sentence.
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            starved.length ? `BUDGET: ${reason}` : reason,
            starved.length ? 'BUDGET_EXHAUSTED' : null,
            starved.length ? { agent_id: agent.id, dimension: starved[0], requested: refused?.requested ?? null, envelope } : null);
        }
        if (outcome?.context_pressure && !outcome?.context_blocked) {
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, node?.id ?? agent.node_id, 'allocator')?.id, {
            subject: 'context-pressure-notice', payload: { agent_id: agent.id, tokens: outcome.context?.totalTokens ?? null },
          });
        }
        const refusal = this.contextRefusal(outcome, error, agent);
        if (refusal) {
          // A request refused before dispatch is not a model failure: name it
          // and stop the node instead of spending the turn budget of an identity
          // that cannot make its next request. The code decides the class — a
          // refusal the budget caused is a budget stop.
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            refusal.message.startsWith('BUDGET: ') ? refusal.message : `CONTEXT_PRESSURE: ${refusal.message}`,
            refusal.code);
        }
        if (outcome?.context_blocked) {
          const unfunded = Boolean(outcome.context?.compaction_unfunded);
          if (unfunded) {
            this.recordBudgetRefusal(agent, `compaction refused for lack of budget: ${outcome.context.compaction_error}`);
          }
          const cause = unfunded ? ' (compaction could not be funded)' : '';
          // The producer knows which stop this is: an unfunded compaction is a
          // budget stop, and `context_blocked` carries that fact in its own
          // fields rather than leaving the reader to infer it from the message.
          const contextCode = outcome.context?.context_code ?? (unfunded ? 'BUDGET_EXHAUSTED' : 'CONTEXT_PRESSURE');
          this.blockNodeInternal(cluster.id, node?.id ?? agent.node_id,
            contextCode === 'BUDGET_EXHAUSTED'
              ? `BUDGET: the session could not be compacted${cause} — ${role} holds ${outcome.context.totalTokens} tokens`
              : `CONTEXT_PRESSURE${cause}: ${role} holds ${outcome.context.totalTokens} tokens and compaction did not reduce it`,
            contextCode);
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, node?.id ?? agent.node_id, 'allocator')?.id, {
            subject: 'context-pressure', payload: { agent_id: agent.id, tokens: outcome.context.totalTokens },
          });
        }
      });
    } finally {
      this.#activeTurns.delete(agent.id);
      try {
        // A management node can finish only after its last live role turn
        // releases. Retry both delegated acceptance and the root's explicit
        // finish request here, before a still-pending advisory audit admits
        // another turn and starves root closure.
        const finishedNode = this.store.getNode(agent.node_id);
        const rootFinished = finishedNode?.kind === 'management' && !finishedNode.parent_id
          && this.store.get(
            "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
            cluster.id, finishedNode.id,
          );
        if (finishedNode?.kind === 'management' && finishedNode.status !== 'COMPLETED'
          && (rootFinished || (finishedNode.delegated_transaction_id
            && this.store.getTransaction(finishedNode.delegated_transaction_id)?.status === 'ACCEPTED'))) {
          this.evaluateCompletion(cluster.id);
        }
      } finally {
        this.wake();
      }
    }
  }

  /**
   * Publish a Worker proposal only when its turn really completed. Every other
   * ending — provider error, abort, max-tokens, interrupted — withholds the
   * proposal, records why, and leaves the transaction re-dispatchable while
   * attempts remain.
   */
  finishWorkerTurn(cluster, agent, tx, allocation, { outcome, error, before, lease, deliveries, admitted = false, durable = false, failures = 0, turnSeq = null }) {
    const leaseValid = this.leaseStillHeld(lease);
    if (!leaseValid) {
      // A replacement may already have staged its own work on this
      // transaction; a fenced finisher clears nothing and publishes nothing.
      this.#forgetLease(lease);
      this.#activeTurns.delete(agent.id);
      try {
        this.store.appendEvent(cluster.id, 'turn-fenced', {
          agent_id: agent.id, role: 'worker', transaction_id: tx.id, lease_epoch: lease.epoch,
          note: 'the worker finished after its lease was replaced; nothing was published or cleared',
        });
      } catch (cause) {
        this.logger?.warn?.(cause);
      }
      this.wake();
      return;
    }
    this.#releaseLease(cluster.id, agent.id, lease);
    let accountingBlocked = false;
    try {
      // Bookkeeping must never stop the turn's result from being published — an
      // accounting anomaly is recorded and named and the work still lands — with
      // one exception: a reservation that cannot be attributed to a payer leaves
      // the turn's own accounting unknown, and a result published from it would
      // be a claim nothing can be charged to. That case blocks the transaction
      // and withholds the result.
      try {
        const reconciliation = this.reconcileReservations(cluster, agent, { transactionId: tx.id }) ?? {};
        accountingBlocked = Number(reconciliation.uncertain ?? 0) > 0;
      } catch (cause) {
        this.store.tx(() => this.store.appendEvent(cluster.id, 'accounting-uncertain', {
          agent_id: agent.id, transaction_id: tx.id, reason: String(cause?.message ?? cause).slice(0, 300),
          code: cause?.code ?? 'ACCOUNTING_UNCERTAIN',
        }));
        accountingBlocked = true;
      }
      if (deliveries?.length) this.settleDeliveries(cluster.id, agent.id, deliveries, { admitted, durable });
      this.store.tx(() => {
        const current = this.store.getTransaction(tx.id);
        const rejectedRevision = current?.status === 'RUNNING'
          && this.store.findAudit(cluster.id, tx.id, 'plan', current.revision)?.decision === 'REJECTED';
        const progress = this.progressSeq(cluster.id) !== before;
        const started = admitted || error === null;
        if (!started) {
          // The same rule as a role turn: a failure before the model saw
          // anything must not advance the counter that selects create versus
          // resume, and must not consume the transaction's attempts.
          failures = (failures ?? 0) + 1;
          this.store.appendEvent(cluster.id, 'turn-start-failed', {
            agent_id: agent.id, role: 'worker', transaction_id: tx.id, attempt: failures,
            error: error ? String(error.message ?? error).slice(0, 300) : null,
          });
          const blocked = failures >= 3;
          if (blocked) {
            this.store.appendEvent(cluster.id, 'agent-blocked', {
              agent_id: agent.id, role: 'worker',
              reason: `three consecutive turns failed before reaching the model: ${error ? String(error.message ?? error).slice(0, 200) : 'unknown'}`,
            });
            this.store.updateTransaction(tx.id, { status: 'READY', __bump_revision: false });
          }
          this.store.updateAgent(agent.id, { status: blocked ? 'BLOCKED' : 'READY' });
          if (rejectedRevision && this.store.getTransaction(tx.id)?.status === 'RUNNING') {
            setTransactionStatus(this.store, this, cluster, current, 'DRAFT');
          }
          this.armHostReadyRetry(error);
          return;
        }
        failures = 0;
        const turns = agent.turns + 1;
        const workerStatus = this.store.getAgent(agent.id)?.status ?? agent.status;
        this.store.updateAgent(agent.id, {
          turns: this.#bookTurn(agent, turnSeq, turns), stagnation: progress ? 0 : agent.stagnation + 1,
          status: AGENT_TERMINAL.has(workerStatus) ? workerStatus : 'READY',
        });

        // A fallback submission must carry the same native proof an explicit
        // result could cite. Tool names and statuses alone do not identify the
        // path, bytes, writer, or successful receipt an Auditor needs to judge.
        // Do not attribute effects from a previous turn of this Worker to this
        // result; the original receipts remain queryable through flow_query effects.
        const evidence = this.store.effects(cluster.id, { agent_id: agent.id, limit: 50 })
          .filter(effect => effect.lease_epoch === lease.epoch && effect.turn_seq === turns)
          .map(effect => ({
            call_id: effect.call_id, agent_id: effect.agent_id, node_id: effect.node_id,
            owner_management_id: effect.owner_management_id,
            tool: effect.tool, status: effect.status, job_id: effect.job_id ?? null,
            args: JSON.parse(effect.args), body: effect.body === null ? null : JSON.parse(effect.body),
          }));
        const blocked = current && ['PAUSED', 'BLOCKED', 'CANCELLED'].includes(current.status);
        const completed = Boolean(outcome) && error === null && outcome.completed === true && leaseValid && !accountingBlocked;
        const stagedForThisTurn = current
          && current.result !== null && current.result !== undefined
          && current.result_staged_epoch === lease.epoch
          && current.result_staged_turn === turns;
        // The *identity* that staged the proposal is what makes it this Worker's
        // work; the turn counter is diagnosis, not permission. A paused Worker
        // that resumes is the same identity finishing the same job, and throwing
        // its staged result away — or replacing it with a prose summary —
        // destroys the only concrete evidence the Auditor could judge. A fenced
        // or replaced identity is blocked before this point.
        const stagedByThisWorker = Boolean(current)
          && current.result !== null && current.result !== undefined
          && (current.result_staged_agent ?? null) === agent.id;
        const staged = stagedByThisWorker;

        if (current && current.status === 'RUNNING' && !blocked) {
          if (completed) {
            const result = staged
              ? current.result
              : { kind: 'worker-output', summary: outcome?.finalText ?? '', tool_calls: outcome?.toolCalls?.length ?? 0, evidence };
            this.store.updateTransaction(tx.id, {
              status: 'SUBMITTED', result, result_revision: null, validation: null,
              result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null, __bump_revision: false,
            });
            // Models report inability through `completed: false`, `status`, or
            // `outcome`. Preserve all three spellings as one durable signal: the
            // Auditor must see the original blocked revision even if the
            // Orchestrator revises it before the validation audit is inspected.
            const incomplete = result?.completed === false
              || (typeof result?.status === 'string' && INCOMPLETE_WORKER_RESULT.test(result.status))
              || (typeof result?.outcome === 'string' && INCOMPLETE_WORKER_RESULT.test(result.outcome));
            this.store.appendEvent(cluster.id, 'result-submitted', {
              transaction_id: tx.id, agent_id: agent.id, node_id: allocation.node_id,
              source: staged ? 'worker-tool' : 'turn-output',
              staged_for_this_turn: stagedForThisTurn,
              revision: current.revision,
              result_completed: incomplete ? false : result?.completed ?? null,
              result_status: result?.status ?? result?.outcome ?? null,
            });
            this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
              subject: 'result-submitted', payload: { transaction_id: tx.id },
            });
            this.deliverFixtureMessages(cluster, this.store.getTransaction(tx.id));
          } else {
            const stopReason = error ? `exception: ${String(error.message ?? error)}` : outcome?.stopReason ?? 'unknown';
            if ((error || outcome?.stopReason === 'error')
              && !this.modelRequestRefusedThisTurn(cluster.id, agent.id, lease, outcome, error)) {
              this.recordAgentAnomaly({ ...agent, role: 'worker' }, {
                transaction_id: tx.id,
                code: error?.code ?? outcome?.stopDetail?.code ?? null,
                message: error ? String(error.message ?? error).slice(0, 200) : (outcome?.stopDetail?.message ?? 'the model request failed'),
              });
            }
            // A request the provider would have refused is a context pathology:
            // the transaction is blocked with its coded reason rather than
            // retried into the same ceiling.
            const refusal = this.contextRefusal(outcome, error, agent);
            const contextBlocked = refusal !== null;
            const furtherAttempts = !contextBlocked && current.attempts < cluster.limits.max_attempts;
            if (contextBlocked) {
              this.blockNodeInternal(cluster.id, allocation.node_id,
                refusal.message.startsWith('BUDGET: ') ? refusal.message : `CONTEXT_PRESSURE: ${refusal.message}`,
                refusal.code);
            }
            this.store.updateTransaction(tx.id, {
              status: contextBlocked ? 'BLOCKED' : furtherAttempts ? 'READY' : 'FAILED',
              result: null, result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
              result_revision: null, validation: null, __bump_revision: false,
            });
            this.store.appendEvent(cluster.id, 'result-withheld', {
              transaction_id: tx.id, agent_id: agent.id, stop_reason: stopReason,
              had_submission: current.result !== null && current.result !== undefined,
              staged_binding_match: staged, attempts: current.attempts,
              next_status: contextBlocked ? 'BLOCKED' : furtherAttempts ? 'READY' : 'FAILED',
              // The producer's code, not a hardcoded one: a refusal the budget
              // caused is a budget stop even on this path.
              ...(contextBlocked ? { code: refusal.code } : {}),
            });
            this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
              subject: 'result-withheld', payload: { transaction_id: tx.id, stop_reason: stopReason },
            });
          }
        } else if (current && current.status === 'RUNNING') {
          this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        } else if (accountingBlocked) {
          // The transaction was blocked by the reconciliation itself: say so in
          // the turn's own record, and keep the staged result for the human
          // decision that resolves the accounting. Nothing is published.
          this.store.appendEvent(cluster.id, 'result-withheld', {
            transaction_id: tx.id, agent_id: agent.id, stop_reason: 'accounting-uncertain',
            had_submission: current?.result !== null && current?.result !== undefined,
            staged_binding_match: staged, attempts: current?.attempts ?? 0,
            next_status: 'BLOCKED', code: 'ACCOUNTING_UNCERTAIN',
          });
          this.notifyInternal(cluster.id, this.roleAgentOf(cluster.id, allocation.node_id, 'orchestrator')?.id, {
            subject: 'result-withheld', payload: { transaction_id: tx.id, stop_reason: 'accounting-uncertain' },
          });
        }
        if (rejectedRevision) {
          const finished = this.store.getTransaction(tx.id);
          if (finished && !TRANSACTION_TERMINAL.has(finished.status)
            && !['DRAFT', 'BLOCKED'].includes(finished.status)) {
            // The Worker finished under its original revision. Its native
            // write receipts and result remain evidence, but a rejected plan
            // cannot enter validation until the Orchestrator corrects it.
            setTransactionStatus(this.store, this, cluster, finished, 'DRAFT');
          }
        }
        this.store.insertCheckpoint({
          id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, session_id: agent.session_id,
          flushed_seq: outcome?.native_seq ?? null,
          events_seq: this.store.latestEventSeq(cluster.id), transaction_id: tx.id,
          transaction_revision: current?.revision ?? null, inbox_ack_cursor: null,
          usage_watermark: this.usageWatermark(cluster.id), turn_seq: turns,
          data: { role: 'worker', stop_reason: outcome?.stopReason ?? 'error', tool_calls: outcome?.toolCalls?.length ?? 0 },
        });
        this.store.appendEvent(cluster.id, 'turn-end', {
          agent_id: agent.id, role: 'worker', turn: turns, transaction_id: tx.id,
          tools_used: [...new Set(this.#toolCallLog.get(agent.id) ?? [])].sort(),
          stop_reason: outcome?.stopReason ?? 'error',
          stop_detail: outcome?.stopDetail ?? null,
          error: error ? String(error.message ?? error) : null,
          progress,
        });
      });
    } finally {
      this.#activeTurns.delete(agent.id);
    }
    this.wake();
  }

  /**
   * Abort a turn that has been in flight far longer than any request may take.
   * A hung turn holds its lease, its transaction (RUNNING) and a model permit;
   * without this backstop a single stuck stream stops a transaction for the rest
   * of the run (measured: one transaction sat RUNNING for 29 minutes while the
   * cluster counted down to its wall deadline).
   */
  #abortHungTurns() {
    const cutoff = this.timestamp() - this.config.maxTurnMs;
    for (const [agentId, entry] of this.#activeTurns) {
      if ((entry.started ?? this.timestamp()) > cutoff) continue;
      try {
        this.store.appendEvent(entry.cluster_id, 'turn-aborted', {
          agent_id: agentId, role: entry.role, reason: 'the turn exceeded the maximum lifetime',
          age_ms: this.timestamp() - (entry.started ?? this.timestamp()),
        });
      } catch (error) {
        this.logger?.warn?.(error);
      }
      entry.ac.abort(new Error('turn exceeded the maximum lifetime'));
    }
  }

  /**
   * Return a transaction that is `RUNNING` with no live turn and no live lease
   * to the schedulable set.
   *
   * This is the recovery rule applied *during* a run: a turn whose identity
   * vanished (a killed stream, an expired lease, a finisher that never ran)
   * leaves its transaction RUNNING forever, and nothing else in the system will
   * ever look at it again. The event names it, so the sweep is evidence rather
   * than a silent cleanup.
   */
  #sweepStrandedTransactions() {
    const now = this.timestamp();
    const rows = this.store.all(
      `SELECT t.id, t.attempts, t.node_id FROM transactions t
        JOIN allocations a ON a.transaction_id = t.id AND a.status='ACTIVE'
        WHERE t.status='RUNNING' AND t.cluster_id = a.cluster_id
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.agent_id = a.agent_id AND l.expires > ?)
        LIMIT 100`, now);
    for (const row of rows) {
      const allocation = this.store.activeAllocationForTransaction(row.id);
      if (!allocation || this.#activeTurns.has(allocation.agent_id)) continue;
      const cluster = this.store.getCluster(this.store.getTransaction(row.id).cluster_id);
      const furtherAttempts = row.attempts < (cluster?.limits?.max_attempts ?? 2);
      this.store.tx(() => {
        this.store.updateTransaction(row.id, {
          status: furtherAttempts ? 'READY' : 'BLOCKED',
          result_staged_epoch: null, result_staged_turn: null, result_staged_agent: null,
          __bump_revision: false,
        });
        this.store.appendEvent(cluster.id, 'transaction-stranded', {
          transaction_id: row.id, node_id: row.node_id, agent_id: allocation.agent_id,
          attempts: row.attempts, next_status: furtherAttempts ? 'READY' : 'BLOCKED',
          reason: 'the transaction was RUNNING with no live turn and no live lease', code: 'STRANDED_TURN',
        });
      });
    }
  }

  #reapTurns() {
    for (const [agentId, entry] of this.#activeTurns) {
      if (entry.settled) this.#activeTurns.delete(agentId);
    }
  }

  // -------------------------------------------------------------- leases

  #acquireLease(cluster, agent, purpose, inboxIds = []) {
    return this.store.tx(() => {
      const existing = this.store.leaseForAgent(agent.id);
      if (existing && existing.expires > this.timestamp()) fail(`agent ${agent.id} already holds a live lease`, 409);
      if (existing) this.store.deleteLease(existing.id);
      const epoch = (existing?.epoch ?? agent.epoch) + 1;
      const at = this.timestamp();
      const lease = this.store.createLease({
        id: randomUUID(), cluster_id: cluster.id, agent_id: agent.id, node_id: agent.node_id, purpose,
        epoch, expires: at + this.config.leaseTtlMs, event_upper_bound: this.store.latestEventSeq(cluster.id),
      });
      this.store.updateAgent(agent.id, { status: 'RUNNING', epoch });
      // Ownership of the inbox rides with the same transaction as the lease: a
      // message is either still queued or owned by a turn that exists.
      if (inboxIds.length) this.store.consumeInbox(inboxIds);
      this.store.appendEvent(cluster.id, 'turn-start', {
        agent_id: agent.id, role: agent.role, purpose, epoch,
        inbox_taken: inboxIds.length, inbox_ids: inboxIds.slice(0, 16),
      });
      const beat = setInterval(() => {
        try {
          this.store.tx(() => this.store.touchLease(lease.id, this.timestamp() + this.config.leaseTtlMs));
        } catch (error) {
          this.logger?.warn?.(error);
        }
      }, this.config.heartbeatMs);
      beat.unref?.();
      this.#heartbeats.set(lease.id, beat);
      return lease;
    });
  }

  /**
   * Drop this turn's local traces without touching anything another turn now
   * owns: used when the lease was fenced before the turn finished.
   */
  #forgetLease(lease) {
    this.#clearLeaseLocal(lease);
  }

  #clearLeaseLocal(lease) {
    const beat = this.#heartbeats.get(lease.id);
    if (beat) {
      clearInterval(beat);
      this.#heartbeats.delete(lease.id);
    }
  }

  /**
   * Whether the exact lease this turn captured is still live and current. Must
   * be read before the lease is released.
   */
  leaseStillHeld(lease) {
    const live = this.store.getLease(lease.id);
    return Boolean(live) && live.epoch === lease.epoch;
  }

  #releaseLease(clusterId, agentId, lease) {
    this.#clearLeaseLocal(lease);
    const beat = this.#heartbeats.get(lease.id);
    if (beat) {
      clearInterval(beat);
      this.#heartbeats.delete(lease.id);
    }
    this.store.tx(() => {
      const current = this.store.getLease(lease.id);
      if (current) this.store.deleteLease(lease.id);
      const agent = this.store.getAgent(agentId);
      if (agent && !AGENT_TERMINAL.has(agent.status)) this.store.updateAgent(agentId, { status: 'READY' });
    });
  }

  #expireLeases(clusterId) {
    const now = this.timestamp();
    const expired = this.store.expiredLeases(now).filter(lease => lease.cluster_id === clusterId);
    if (!expired.length) return;
    this.store.tx(() => {
      for (const lease of expired) {
        this.store.deleteLease(lease.id);
        const agent = this.store.getAgent(lease.agent_id);
        if (agent && agent.status === 'RUNNING') this.store.updateAgent(agent.id, { status: 'READY' });
        this.store.appendEvent(clusterId, 'lease-expired', { agent_id: lease.agent_id, epoch: lease.epoch });
      }
    });
  }

  usageWatermark(clusterId) {
    const rows = this.store.listUsageReceipts(clusterId, { limit: 1 });
    return rows.length ? rows[0].created : null;
  }

  // ---------------------------------------------------------- llm slots

  /** Public: the Allocator's set_concurrency action adjusts the live semaphore. */
  setLlmConcurrency(limit) {
    this.#llmSlots.limit = Math.max(1, limit ?? 2);
    // Raising the cap must let queued work in immediately; lowering it must not
    // admit anything new until the running work drops below the new cap.
    this.#pumpLlmSlots();
  }

  /** The declared per-Worker model-request allowance, or null when unlimited. */
  workerRequestAllowance(agent) {
    if (agent?.role !== 'worker') return null;
    return Number(this.store.getCluster(agent.cluster_id)?.limits?.worker_model_requests) || null;
  }

  /** Identities with a registered, unfinished turn. */
  activeTurnIds() {
    return [...this.#activeTurns.keys()];
  }

  /** Permits currently held, for the concurrency gate and its regressions. */
  llmSlotsInUse() {
    return this.#llmSlots.inUse;
  }

  /** Waiters queued for a permit. */
  llmWaiters() {
    return this.#llmSlots.waiters.length;
  }

  /** Number of in-flight cluster turns for one cluster. */
  inFlight(clusterId) {
    return [...this.#activeTurns.values()].filter(entry => entry.cluster_id === clusterId).length;
  }

  /**
   * Bound the control-plane calls one turn may make. A model that keeps
   * retrying a rejected action burns tokens without changing state; the cap
   * turns that into one clear instruction instead of an unbounded loop.
   */
  admitFlowCall(agent) {
    const limit = this.config.limits?.max_tool_calls_per_turn ?? DEFAULT_LIMITS.max_tool_calls_per_turn;
    const used = (this.#flowCalls.get(agent.id) ?? 0) + 1;
    this.#flowCalls.set(agent.id, used);
    if (used > limit) {
      fail(`control-plane call budget for this turn is exhausted (${limit} calls); stop calling tools, summarise what you changed and end the turn`, 409);
    }
    return used;
  }

  /**
   * The identity of the turn that owns one *live agent instance*. Keyed by the
   * object, not by session id: a later turn resumes a new instance, so an old
   * handle keeps its own stale identity and is fenced instead of borrowing the
   * new epoch.
   */
  turnActor(agentInstance) {
    if (!agentInstance || (typeof agentInstance !== 'object' && typeof agentInstance !== 'function')) return null;
    return this.#turnIdentity.get(agentInstance) ?? null;
  }

  /** Register the identity of a live agent instance for the duration of its turn. */
  bindTurnIdentity(agentInstance, identity) {
    this.#turnIdentity.set(agentInstance, identity);
  }

  /**
   * The native session offset of the live instance of one identity, or null
   * when it has no live instance to ask. Callers use it for checkpoints; it
   * never guesses.
   */
  sessionOffsetOf(sessionId) {
    for (const entry of this.#activeTurns.values()) {
      const agent = this.store.getAgent(entry.agent_id);
      if (agent?.session_id === sessionId) return sessionOffset(entry.instance ?? null);
    }
    return null;
  }

  healthMetricNames() {
    return [...HEALTH_METRICS];
  }

  /**
   * Section 18's health signals, all of them *derived* from the durable ledger
   * rather than asserted: the model supplies the judgement when it calls
   * `evaluate_health`, never the measurement.
   */
  healthSignals(clusterId, { windowMs = this.config.staleMs } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) fail('Health evaluation window must be a finite positive number');
    const at = this.timestamp();
    const windowStart = at - windowMs;
    const staleBefore = at - this.config.staleMs;
    const rootTotal = this.store.countTransactions(clusterId, { parent_transaction_id: null });
    const rootAccepted = this.store.countTransactions(clusterId, { parent_transaction_id: null, status: ['ACCEPTED'] });
    const statuses = Object.fromEntries(this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]));
    const total = Object.values(statuses).reduce((sum, count) => sum + count, 0);

    // decomposition quality: a unit of work is decomposed when it carries
    // checkable criteria and either children or dependencies.
    const decomposed = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM transactions t
        WHERE t.cluster_id=? AND json_array_length(t.acceptance_criteria) > 0
          AND (EXISTS (SELECT 1 FROM transactions c WHERE c.parent_transaction_id = t.id)
               OR EXISTS (SELECT 1 FROM dependencies d WHERE d.transaction_id = t.id))`, clusterId).c);
    const orphans = Number(this.store.get(
      'SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND json_array_length(acceptance_criteria) = 0', clusterId).c);

    // responsiveness: the median age of open MAJOR+ issues, and how many
    // submitted results have waited past the staleness window for a decision.
    const issueAges = this.store.all(
      `SELECT (? - created) AS age FROM issues
        WHERE cluster_id=? AND status='OPEN' AND severity IN ('MAJOR','CRITICAL','BLOCKER')
          AND created >= ?
        ORDER BY created`, at, clusterId, windowStart).map(row => Number(row.age));
    const median = ages => (ages.length ? ages[Math.floor(ages.length / 2)] : null);
    const staleSubmitted = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='SUBMITTED' AND updated < ?", clusterId, staleBefore).c);

    // planning stability: how often plans moved, and how often a rejected plan
    // came back only to be rejected again.
    const churn = this.store.all(
      "SELECT json_extract(data,'$.transaction_id') AS id, COUNT(*) AS c FROM events WHERE cluster_id=? AND at>=? AND type IN ('transaction-adjusted','decomposed') GROUP BY 1",
      clusterId, windowStart);
    const churnPerSurvey = churn.length ? Number((churn.reduce((sum, row) => sum + Number(row.c), 0) / churn.length).toFixed(4)) : 0;
    const rejectionCycles = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM (
         SELECT json_extract(data,'$.transaction_id') AS id, COUNT(*) AS c
           FROM events WHERE cluster_id=? AND at>=? AND type='transaction-status' AND json_extract(data,'$.to')='REJECTED'
          GROUP BY 1 HAVING COUNT(*) > 1)`, clusterId, windowStart).c);

    // acceptance quality: accepted work whose recorded checks all carry evidence.
    const acceptedWithEvidence = Number(this.store.get(
      `SELECT COUNT(*) AS c FROM transactions
        WHERE cluster_id=? AND status='ACCEPTED' AND validation IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(validation,'$.checks')) AS criterion
                           WHERE COALESCE(json_extract(criterion.value,'$.evidence'),'') = '')`, clusterId).c);

    // result integration: accepted parents whose children have all settled.
    const acceptedParents = this.store.all(
      `SELECT id FROM transactions WHERE cluster_id=? AND status='ACCEPTED'
        AND EXISTS (SELECT 1 FROM transactions c WHERE c.parent_transaction_id = transactions.id)`, clusterId);
    const integrated = acceptedParents.filter(row => this.store.all(
      "SELECT status FROM transactions WHERE cluster_id=? AND parent_transaction_id=?", clusterId, row.id)
      .every(child => TRANSACTION_TERMINAL.has(child.status) || child.status === 'ACCEPTED')).length;

    const blockedStale = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE cluster_id=? AND status='BLOCKED' AND updated < ?", clusterId, staleBefore).c);
    const escalations = Number(this.store.get(
      "SELECT COUNT(*) AS c FROM events WHERE cluster_id=? AND type='escalated' AND at >= ?", clusterId, windowStart).c);

    const ratio = (numerator, denominator) => (denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null);
    return {
      window_ms: windowMs,
      transaction_coverage: ratio(rootAccepted, rootTotal),
      decomposition_quality: { ratio: ratio(decomposed, total), decomposed, orphans },
      responsiveness: { median_issue_age_ms: median(issueAges), open_major_issues: issueAges.length, stale_submitted: staleSubmitted },
      planning_stability: { revisions_per_transaction: churnPerSurvey, rejection_cycles: rejectionCycles },
      goal_alignment: null,
      acceptance_quality: ratio(acceptedWithEvidence, statuses.ACCEPTED ?? 0),
      result_integration: ratio(integrated, acceptedParents.length),
      escalation_quality: blockedStale > 0 ? Math.min(1, Number((escalations / blockedStale).toFixed(4))) : (escalations > 0 ? 1 : null),
      transactions_by_status: statuses,
    };
  }

  /** The §18 signals, projected for a prompt: the numbers, not the status table. */
  #healthDigest(clusterId) {
    try {
      const signals = this.healthSignals(clusterId);
      return {
        transaction_coverage: signals.transaction_coverage,
        decomposition_quality: signals.decomposition_quality,
        responsiveness: signals.responsiveness,
        planning_stability: signals.planning_stability,
        acceptance_quality: signals.acceptance_quality,
        result_integration: signals.result_integration,
        escalation_quality: signals.escalation_quality,
      };
    } catch (error) {
      this.logger?.warn?.(error);
      return null;
    }
  }

  /** Live turn entry for one agent, or null. */
  activeTurnFor(agentId) {
    return this.#activeTurns.get(agentId) ?? null;
  }

  /**
   * Counting semaphore over a fixed number of permits. A released permit is
   * *transferred* to the next waiter: decrementing and re-incrementing across
   * the handoff would let a third caller in while the waiter is still running.
   */
  acquireLlmSlot(clusterId = null) {
    if (this.#llmSlots.inUse < this.#llmSlots.limit) {
      this.#llmSlots.inUse += 1;
      this.#noteLlmSlot(clusterId, 'acquired');
      return Promise.resolve(this.slotReleaser(clusterId));
    }
    return new Promise(resolve => {
      this.#llmSlots.waiters.push(() => {
        this.#noteLlmSlot(clusterId, 'acquired-after-wait');
        resolve(this.slotReleaser(clusterId));
      });
    });
  }

  /**
   * A permit receipt: how many permits were held when one was taken. It is the
   * durable evidence for the "provider requests in flight never exceed the
   * concurrency window" invariant, which is otherwise inferred from request
   * intervals that a cancelled request can stretch.
   */
  #noteLlmSlot(clusterId, kind) {
    if (!clusterId) return;
    try {
      this.store.appendEvent(clusterId, 'llm-slot', { kind, in_use: this.#llmSlots.inUse, limit: this.#llmSlots.limit });
    } catch {
      /* the receipt is diagnostic: it must never fail a turn */
    }
  }

  /**
   * Admit queued work while the current limit allows it. The permit count is
   * owned here: `acquireLlmSlot` increments, `release` decrements, and this pump
   * moves permits to waiters only while `inUse` stays below the limit — so
   * lowering the cap stops new work instead of handing a busy slot on.
   */
  #pumpLlmSlots() {
    while (this.#llmSlots.inUse < this.#llmSlots.limit) {
      const next = this.#llmSlots.waiters.shift();
      if (!next) return;
      this.#llmSlots.inUse += 1;
      next();
    }
  }

  slotReleaser(clusterId = null) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#llmSlots.inUse = Math.max(0, this.#llmSlots.inUse - 1);
      this.#noteLlmSlot(clusterId, 'released');
      this.#pumpLlmSlots();
    };
  }

  /**
   * Non-cluster control run: one DSH agent, the same Worker prompt shape, the
   * same capability tools, the same budget ledger and the same accounting.
   * No management role is started and no scheduler is involved.
   */
  async runSingleAgent({ objective, workspace, capabilities, budget = {}, acceptance_criteria = [], timeoutMs = 3_600_000 } = {}) {
    const normalized = validateSpec({
      objective, workspace,
      capabilities: capabilities ?? ['fs_read'],
      limits: { max_depth: 1, max_children: 1, max_agents: 2, max_active_agents: 1, max_llm_concurrency: 1 },
      budget: { ...budget, wall_time_ms: budget.wall_time_ms ?? timeoutMs },
    });
    const clusterId = randomUUID();
    const prepared = this.store.tx(() => {
      const cluster = this.store.createCluster({
        id: clusterId, objective: normalized.objective, workspace: normalized.workspace,
        capabilities: normalized.capabilities, limits: normalized.limits, budget: normalized.budget,
      }, normalized.budget);
      const rootBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'root', scope_id: clusterId,
        limit: {
          tokens: normalized.budget.tokens ?? 0, model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
          agents: normalized.limits.max_agents, max_active_agents: normalized.limits.max_active_agents,
        },
        wall_limit_ms: normalized.budget.wall_time_ms ?? timeoutMs,
      });
      const node = this.store.insertNode({
        id: randomUUID(), cluster_id: clusterId, parent_id: null, kind: 'worker', depth: 0,
        status: 'ACTIVE', scope: { objective: normalized.objective.slice(0, 200), single: true },
        capabilities: normalized.capabilities, path: '0', max_children: 0,
      });
      const nodeBudget = createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'node', scope_id: node.id, node_id: node.id,
        parent_budget_id: rootBudget.id,
        limit: {
          tokens: normalized.budget.tokens ?? 0, model_requests: normalized.budget.model_requests ?? 0,
          tool_calls: normalized.budget.tool_calls ?? 0,
        },
      });
      const agent = this.store.insertAgent({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, role: 'worker',
        session_id: randomUUID(), status: 'READY', capabilities: normalized.capabilities, cwd: normalized.workspace,
        meta: { single: true },
      });
      this.grantAgentBudget(clusterId, node, nodeBudget, agent, 'worker');
      const tx = this.createTransactionInternal(clusterId, node, {
        objective: normalized.objective, acceptance_criteria,
        capabilities: normalized.capabilities, status: 'RUNNING',
      }, { parent: null, local: true });
      // The single control *is* the whole cluster, so it owns the entire
      // workspace exclusively: its Worker prompt asks it to produce files, and
      // the write-scope check must permit exactly that.
      this.store.insertAllocation({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, agent_id: agent.id,
        transaction_id: tx.id, capabilities: normalized.capabilities,
        write_scope: ['.'], write_scope_canonical: [canonicalScopeEntry(cluster.workspace, '.')], status: 'ACTIVE',
      });
      this.store.appendEvent(clusterId, 'single-control-started', { agent_id: agent.id, transaction_id: tx.id });
      return { cluster: this.store.getCluster(clusterId), agent, tx, node };
    });

    const lease = this.#acquireLease(prepared.cluster, prepared.agent, 'single-turn');
    const identity = {
      cluster_id: clusterId, agent_id: prepared.agent.id, node_id: prepared.node.id, role: 'worker',
      epoch: lease.epoch, lease_id: lease.id, turn_seq: 1,
    };
    const budgetIds = this.agentBudgetChain(prepared.cluster, prepared.agent, prepared.tx);
    const policy = this.allowedToolsFor(prepared.cluster, 'worker', prepared.agent);
    const allocation = this.store.activeAllocationForTransaction(prepared.tx.id);
    const prompt = this.#workerPrompt(prepared.cluster, prepared.tx, allocation ?? { write_scope: ['.'] });
    let outcome = null;
    let error = null;
    try {
      outcome = await runTurn(this.ctx, {
        agent: prepared.agent, role: 'worker', prompt, allowedTools: policy.allowed,
        globalTools: policy.global, capabilities: policy.capabilities, resume: false,
        cwd: prepared.cluster.workspace, model: this.modelFor(prepared.agent), signal: undefined,
        logger: this.logger, budgetIds, transactionId: prepared.tx.id, turnSeq: 1, flow: this,
        contextLimits: this.config.context,
        // The control's tools resolve their actor from the bound instance, the
        // same rule as a cluster turn.
        onAgentReady: live => this.bindTurnIdentity(live, identity),
      });
    } catch (cause) {
      error = cause;
    } finally {
      this.#releaseLease(clusterId, prepared.agent.id, lease);
    }
    const completed = Boolean(outcome) && error === null && outcome.completed === true;
    this.store.tx(() => {
      // The single control follows the same rule as a cluster Worker: only a
      // completed turn publishes a result.
      this.store.updateTransaction(prepared.tx.id, {
        status: completed ? 'SUBMITTED' : 'FAILED',
        ...(completed
          ? { result: this.store.getTransaction(prepared.tx.id).result ?? { summary: outcome.finalText ?? '', tool_calls: outcome.toolCalls?.length ?? 0 } }
          : { result: null }),
        __bump_revision: false,
      });
      this.store.updateAgent(prepared.agent.id, { turns: 1, status: 'TERMINATED' });
      this.store.updateCluster(clusterId, { status: completed ? 'COMPLETED' : 'FAILED' });
      this.store.appendEvent(clusterId, 'single-control-finished', {
        stop_reason: outcome?.stopReason ?? 'error', completed, error: error ? String(error.message ?? error) : null,
      });
    });
    return {
      cluster_id: clusterId,
      stop_reason: outcome?.stopReason ?? 'error',
      stop_detail: outcome?.stopDetail ?? null,
      final_text: outcome?.finalText ?? '',
      finalText: outcome?.finalText ?? '',
      tool_calls: outcome?.toolCalls ?? [],
      usage: this.store.usageSummary(clusterId),
      error: error ? String(error.message ?? error) : null,
    };
  }

  /**
   * Durable tool-call admission: hard quota plus an effect receipt before the
   * side effect. Runs outside any SQLite transaction on the caller's side.
   */
  admitToolCall(agent, exec, callId) {
    const lease = this.store.leaseForAgent(agent.id);
    if (!lease || lease.expires <= this.timestamp()) return { ok: false, reason: 'this agent holds no valid turn lease' };
    // The *captured* identity of the live instance is what authorises a tool
    // effect: an old instance must not act under its replacement's lease.
    const captured = exec.agent ? this.turnActor(exec.agent) : null;
    if (captured && captured.epoch !== lease.epoch) {
      return { ok: false, reason: `this instance belongs to lease epoch ${captured.epoch}, but the live lease is ${lease.epoch}` };
    }
    if (!captured && MUTATING_EFFECT_TOOLS.has(exec.name)) {
      return { ok: false, reason: `${exec.name} requires a scheduled turn identity on this agent instance` };
    }
    const cluster = this.store.getCluster(agent.cluster_id);
    // Per-allocation write isolation, checked against the canonical target the
    // tool is about to touch rather than against the scope strings alone.
    const allocation = this.store.activeAllocationForAgent(agent.id);
    const writeDecision = checkWriteAccess({
      tool: exec.name, workspace: cluster.workspace,
      writeScope: allocation?.write_scope ?? [], writeScopeCanonical: allocation?.write_scope_canonical ?? null,
      arguments: exec.arguments,
    });
    if (!writeDecision.allowed) {
      this.store.appendEvent(agent.cluster_id, 'write-refused', {
        agent_id: agent.id, tool: exec.name, reason: writeDecision.reason,
      });
      return { ok: false, reason: writeDecision.reason };
    }
    const budgetIds = this.agentBudgetChain(cluster, agent);
    const argumentsJson = safeJson(exec.arguments);
    // A side effect still in flight from a previous run may not be repeated by
    // guesswork: the identity that would repeat it is blocked until a human
    // decides (see `#effectUncertainFor`).
    const uncertain = this.#effectUncertainFor(agent);
    if (uncertain) {
      return { ok: false, reason: `EFFECT_UNCERTAIN: ${uncertain.tool} (call ${uncertain.call_id}) may or may not have executed before the restart; it cannot be repeated without a decision (flow_query what:"effects")` };
    }
    const reserve = () => this.store.tx(() => {
      reserveChain(this.store, budgetIds, { tool_calls: 1 }, { label: `tool call ${exec.name}` });
        // The receipt and its reservation are written together: a crash between
        // them would either leak a quota slot or lose the fact that the call was
        // admitted at all.
      this.store.insertToolCallReceipt({
        call_id: callId, cluster_id: agent.cluster_id, agent_id: agent.id, session_id: agent.session_id,
        turn_seq: agent.turns + 1, tool: exec.name, args_hash: sha1(JSON.stringify(argumentsJson)),
        budget_scope_id: budgetIds.length === 1 ? budgetIds[0] : null, dispatch_status: 'ADMITTED',
      });
      if (effectTool(exec.name)) {
        this.store.insertEffect({
          call_id: callId, cluster_id: agent.cluster_id, agent_id: agent.id, node_id: agent.node_id,
          lease_epoch: lease.epoch, session_id: agent.session_id, turn_seq: agent.turns + 1,
          tool: exec.name, args: argumentsJson, status: 'STARTED',
        });
        this.store.appendEvent(agent.cluster_id, 'effect-started', { agent_id: agent.id, call_id: callId, tool: exec.name });
      }
    });
    try {
      reserve();
    } catch (error) {
      if (error?.code !== 'LIMIT_REACHED') throw error;
      // A grant that ran dry while its node still holds capacity is a
      // bookkeeping state, not a refusal: the tool-call path tops up the gap
      // once, exactly like the model-request path.
      const granted = this.topUpBudgetForAgent(agent, { tool_calls: 1 });
      if (!granted) {
        this.recordBudgetRefusal(agent, `tool call refused: ${error.message}`, {
          scope: error.scope ?? agent.node_id, dimension: error.dimension ?? 'tool_calls',
          requested: error.requested ?? 1, available: error.available ?? 0,
        });
        return { ok: false, reason: error.message };
      }
      try {
        reserve();
      } catch (retryError) {
        if (retryError?.code === 'LIMIT_REACHED') {
          this.recordBudgetRefusal(agent, `tool call refused after a top-up: ${retryError.message}`, {
            scope: retryError.scope ?? agent.node_id, dimension: retryError.dimension ?? 'tool_calls',
            requested: retryError.requested ?? 1, available: retryError.available ?? 0,
          });
          return { ok: false, reason: retryError.message };
        }
        throw retryError;
      }
    }
    return { ok: true };
  }

  /**
   * A role's turn needs one request's envelope *before* it starts, not after a
   * refusal. A node that is dry for one dimension at the moment a turn begins
   * would otherwise stop the node on budget — the case's mechanism stop — while
   * the cluster still holds its budget in another branch; the refill is bounded
   * to a working envelope and moves capacity that already exists.
   */
  ensureTurnFunding(cluster, agent) {
    const perTurn = Math.max(16_384, Number(this.config?.context?.role) * 2 || 16_384);
    const envelope = { tokens: perTurn, model_requests: 2, tool_calls: 4 };
    try {
      const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
      const nodeBudget = this.fundingBudget(cluster, agent);
      if (!agentBudget || !nodeBudget) return null;
      const nodeRow = this.store.getBudget(nodeBudget.id);
      const short = {};
      for (const [key, need] of Object.entries(envelope)) {
        const available = dimensionAvailable(nodeRow, key);
        if (available < need) short[key] = need - available;
      }
      for (const [key, need] of Object.entries(envelope)) {
        const available = dimensionAvailable(this.store.getBudget(agentBudget.id), key);
        if (available < need) short[key] = Math.max(short[key] ?? 0, need - available);
      }
      if (!Object.keys(short).length) return null;
      return this.topUpBudgetForAgent(agent, short);
    } catch (error) {
      this.store.appendEvent(cluster.id, 'budget-preturn-refill-failed', {
        agent_id: agent.id, error: String(error?.message ?? error).slice(0, 400),
      });
      return null;
    }
  }

  /**
   * An effect whose outcome is unknown, for this identity. `EFFECT_UNCERTAIN`
   * must really stop the owner: a replay of a non-idempotent write is not
   * recoverable, and changing a table's state without blocking the caller is
   * not a barrier.
   */
  #effectUncertainFor(agent) {
    const uncertain = this.store.all(
      "SELECT call_id, tool FROM effects WHERE cluster_id=? AND agent_id=? AND status='EFFECT_UNCERTAIN' LIMIT 1",
      agent.cluster_id, agent.id);
    return uncertain[0] ?? null;
  }

  /**
   * A refused admission is an accounting stop, not a provider failure. The
   * native host can wrap its error as UNKNOWN, so match the durable terminal
   * refusal for this identity *after this lease began* to the error it returned.
   * A separate transport failure later in the turn remains an anomaly.
   */
  modelRequestRefusedThisTurn(clusterId, agentId, lease, outcome, error) {
    const detail = String(error?.message ?? outcome?.stopDetail?.message ?? '');
    if (!detail) return false;
    const refusal = this.store.get(
      `SELECT data FROM events WHERE cluster_id=? AND type='budget-refused'
        AND json_extract(data,'$.agent_id')=? AND seq>?
        AND json_extract(data,'$.reason') LIKE 'model request refused%'
        ORDER BY seq DESC LIMIT 1`,
      clusterId, agentId, lease.event_upper_bound);
    if (!refusal) return false;
    return error?.code === 'LIMIT_REACHED' || outcome?.stopDetail?.code === 'LIMIT_REACHED'
      || JSON.parse(refusal.data).reason.includes(detail);
  }

  /**
   * `agent-anomaly`: a provider or model failure is the Allocator's signal — it
   * owns the identities and the model routes.
   */
  recordAgentAnomaly(agent, { code = null, message = null, transaction_id = null } = {}) {
    if (!agent?.cluster_id) return null;
    this.store.appendEvent(agent.cluster_id, 'agent-anomaly', {
      agent_id: agent.id, role: agent.role ?? null, transaction_id, code,
    });
    return this.notifyInternal(agent.cluster_id, this.roleAgentOf(agent.cluster_id, agent.node_id, 'allocator')?.id, {
      subject: 'agent-anomaly',
      payload: { agent_id: agent.id, role: agent.role ?? null, transaction_id, code, message },
    });
  }

  /** The tool really dispatched: from here the call is consumed even if it fails. */
  markToolCallDispatched(agent, exec, callId) {
    this.store.tx(() => {
      const receipt = this.store.getToolCallReceipt(callId);
      if (!receipt || receipt.dispatch_status !== 'ADMITTED') return;
      this.store.settleToolCallReceipt(callId, { dispatch_status: 'DISPATCHED', error: null });
    });
  }

  /**
   * A turn that died with a model request still reserved may have sent it.
   * Charge one attempt if the recorded payer still owns the hold, retain the
   * unknown token hold, and block the owner if settlement cannot be attributed.
   */
  reconcileReservations(cluster, agent, { transactionId = null } = {}) {
    const stale = this.store.usageReceiptsAll(cluster.id, { agent_id: agent.id, status: 'RESERVED' });
    if (!stale.length) return { consumed: 0, uncertain: 0 };
    let uncertain = 0;
    let consumed = 0;
    const blockUncertain = (receipt, reason) => {
      uncertain += 1;
      this.store.appendEvent(cluster.id, 'accounting-uncertain', {
        request_id: receipt.request_id, agent_id: agent.id,
        code: 'ACCOUNTING_UNCERTAIN', reason: String(reason).slice(0, 300),
      });
      this.store.updateAgent(agent.id, { status: 'BLOCKED' });
      const txId = transactionId ?? receipt.transaction_id;
      if (txId) {
        const tx = this.store.getTransaction(txId);
        if (tx && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)) {
          this.store.updateTransaction(txId, { status: 'BLOCKED' });
        }
      }
      this.blockNodeInternal(cluster.id, agent.node_id,
        `ACCOUNTING_UNCERTAIN: request ${receipt.request_id} cannot be settled; its reservation is kept`,
        'ACCOUNTING_UNCERTAIN');
    };
    this.store.tx(() => {
      for (const receipt of stale) {
        const live = this.store.getUsageReceipt(receipt.request_id);
        if (!live || live.status !== 'RESERVED') continue;
        // The scope that was charged is the receipt's own recorded scope — the
        // same rule settlement uses. There is *no* fallback to the identity's
        // current chain: a receipt whose payer is missing or dangling would then
        // debit whatever request holds quota there now, which is another
        // request's reservation, not this one's.
        const budgetIds = live.budget_scope_id && this.store.getBudget(live.budget_scope_id) ? [live.budget_scope_id] : null;
        if (!budgetIds) {
          blockUncertain(live, live.budget_scope_id
            ? `the recorded payer ${live.budget_scope_id} does not exist; the reservation is kept`
            : 'the receipt records no payer scope; the reservation is kept');
          continue;
        }
        // A receipt still reserved when its turn ended belongs to a request
        // that may have been sent: its tokens stay held, only the attempt is
        // consumed.
        try {
          settleChain(this.store, budgetIds, {
            reservedAmounts: { model_requests: 1 },
            consumed: { model_requests: 1 },
          });
          consumed += 1;
        } catch (error) {
          // The payer row exists but no longer owns this attempt's hold. Do
          // not debit another request, nor publish work from an unpayable turn.
          blockUncertain(live, error?.message ?? error);
          continue;
        }
        this.store.settleUsageReceipt(receipt.request_id, {
          status: 'UNKNOWN',
          note: `turn ended with the request still reserved; ${receipt.reservation_tokens} tokens retained`,
        });
        this.store.appendEvent(cluster.id, 'usage-reconciled', { request_id: receipt.request_id, agent_id: agent.id });
      }
    });
    return { consumed, uncertain };
  }

  /**
   * The one transition a tool call's *quota* goes through, owned by the receipt.
   *
   * Only a receipt that is `ADMITTED` (admitted, never dispatched) or
   * `DISPATCHED` (may have run) holds quota. Every other state is terminal for the
   * hold, which is what makes this replay-safe: settling an `UNKNOWN` or
   * `SETTLED` receipt again would take one call out of a reserve it no longer
   * owns, or out of another call's hold in the same scope. There is no fallback to
   * the identity's current chain: a receipt whose payer is gone keeps its hold and
   * is reported as uncertain.
   *
   * Returns `{ outcome, payer }` with outcome in
   * `consumed | released | none | uncertain`.
   */
  settleToolReceiptQuota(callId, { dispatched = null, status = null, error = null } = {}) {
    const receipt = this.store.getToolCallReceipt(callId);
    if (!receipt) return { outcome: 'none', payer: null };
    const current = String(receipt.dispatch_status ?? '').toUpperCase();
    if (!['ADMITTED', 'DISPATCHED'].includes(current)) return { outcome: 'none', payer: receipt.budget_scope_id ?? null };
    const payer = receipt.budget_scope_id && this.store.getBudget(receipt.budget_scope_id) ? receipt.budget_scope_id : null;
    if (!payer) {
      this.store.appendEvent(receipt.cluster_id, 'accounting-uncertain', {
        call_id: callId, agent_id: receipt.agent_id, code: 'ACCOUNTING_UNCERTAIN',
        reason: receipt.budget_scope_id
          ? `the recorded payer ${receipt.budget_scope_id} does not exist; the tool hold is kept`
          : 'the tool receipt records no payer scope; the hold is kept',
      });
      return { outcome: 'uncertain', payer: null };
    }
    const ran = dispatched === null ? current === 'DISPATCHED' : Boolean(dispatched);
    // The scope must actually hold the call. A receipt that says it holds one
    // while the ledger shows none is an inconsistency, and *nothing* may move on
    // it: consuming the call anyway would overshoot a quota the payer never
    // reserved (settlement has no upper-limit check of its own), and releasing
    // would drive the counter negative or take another call's hold. The receipt
    // and its hold are preserved, the owner is blocked, and the reason is named —
    // the human exit is the same one every other uncertain accounting uses.
    if (Number(this.store.getBudget(payer).tool_calls_reserved ?? 0) < 1) {
      const allocation = this.store.activeAllocationForAgent(receipt.agent_id);
      if (allocation?.transaction_id) {
        const tx = this.store.getTransaction(allocation.transaction_id);
        if (tx && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)) {
          this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
        }
      }
      this.store.updateAgent(receipt.agent_id, { status: 'BLOCKED' });
      const nodeId = receipt.node_id ?? allocation?.node_id ?? this.store.getAgent(receipt.agent_id)?.node_id ?? null;
      this.blockNodeInternal(receipt.cluster_id, nodeId,
        `ACCOUNTING_UNCERTAIN: tool call ${callId} is ${current} but its payer holds no reservation; nothing is charged`,
        'ACCOUNTING_UNCERTAIN');
      this.store.appendEvent(receipt.cluster_id, 'accounting-uncertain', {
        call_id: callId, agent_id: receipt.agent_id, code: 'ACCOUNTING_UNCERTAIN', payer,
        reason: `the receipt is ${current} but its payer holds no tool-call reservation; the receipt and hold are preserved`,
      });
      return { outcome: 'uncertain', payer };
    }
    settleChain(this.store, [payer], ran
      ? { reservedAmounts: { tool_calls: 1 }, consumed: { tool_calls: 1 } }
      : { reservedAmounts: { tool_calls: 1 }, consumed: {} });
    this.store.settleToolCallReceipt(callId, {
      dispatch_status: status ?? (ran ? 'UNKNOWN' : 'CANCELLED'),
      ...(error ? { error: String(error).slice(0, 2000) } : {}),
    });
    this.store.appendEvent(receipt.cluster_id, ran ? 'tool-call-charged' : 'tool-call-released', {
      // What was charged, not only who paid: the ledger has to be able to say which
      // tool ran for which identity, or evidence about who produced an artifact
      // cannot be read out of it.
      call_id: callId, payer, tool: receipt.tool ?? null, agent_id: receipt.agent_id ?? null,
    });
    return { outcome: ran ? 'consumed' : 'released', payer };
  }

  /**
   * The human decision's effect on a tool receipt: the quota is reconciled through
   * the same receipt-owned transition as everywhere else (so it can never be taken
   * twice), and the receipt records the outcome the human chose.
   */
  resolveReceiptQuotaAfterEffect(callId, { decision, actor = {}, params = {} } = {}) {
    const receipt = this.store.getToolCallReceipt(callId);
    if (!receipt) return { outcome: 'none' };
    const status = decision === 'settled' ? 'SETTLED' : 'FAILED';
    const outcome = this.settleToolReceiptQuota(callId, { status });
    // The decision is recorded even when there was no hold left to move: the
    // receipt is the record of what the human decided.
    if (outcome.outcome === 'none') this.store.settleToolCallReceipt(callId, { dispatch_status: status });
    this.store.settleToolCallReceipt(callId, {
      result_body: this.boundReceiptBody({ resolved_by: actor.agent_id ?? null, note: params.note ?? 'resolved by hand' }, 2_000),
    });
    return outcome;
  }


  /**
   * Serialize a receipt body by *bounding its fields*, never by cutting the JSON.
   *
   * `JSON.stringify(body).slice(0, 8000)` produced malformed JSON whenever the
   * body was longer — 17 `flow_query` receipts in one run could not be parsed at
   * all — so a reader could no longer tell a long answer from a corrupt one. The
   * structure is preserved and the strings inside it are truncated.
   */
  boundReceiptBody(value, maxString = 8_000, maxItems = 50) {
    try {
      return JSON.stringify(this.boundBody(value, maxString, maxItems));
    } catch (error) {
      return JSON.stringify({ unserializable: String(error?.message ?? error).slice(0, 500) });
    }
  }

  /** The same bounding, as a structure: both ledgers hold the same one. */
  boundBody(value, maxString = 8_000, maxItems = 50) {
    const bound = item => {
      if (typeof item === 'string') return item.length > maxString ? `${item.slice(0, maxString)}…[${item.length - maxString} chars omitted]` : item;
      if (Array.isArray(item)) return item.slice(0, maxItems).map(bound);
      if (item && typeof item === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(item)) out[key] = bound(entry);
        return out;
      }
      return item;
    };
    return bound(value);
  }

  /** Settle the quota reservation and the effect receipt after the tool ran. */
  settleToolCall(agent, exec, callId, result, error, { charged = true } = {}) {
    const log = this.#toolCallLog.get(agent.id) ?? [];
    log.push(exec.name);
    this.#toolCallLog.set(agent.id, log);
    // The scope that paid is the receipt's own recorded scope: recomputing the
    // chain here could settle a reservation in a scope that never held it.
    // The text is bounded *once*, before either ledger is written — the tool
    // receipt and the effect row hold the same body — and the bound states what it
    // omitted, which a pre-truncated string cannot.
    const body = result ? { isError: result.isError === true, text: boundText(textOfResult(result), 8_000) } : null;
    const source = result && result.isError !== true ? captureSource(agent, exec, result) : null;
    this.store.tx(() => {
      if (source) this.store.insertSource(source);
      // Through the receipt-owned transition, once: `charged` means the call
      // really ran (consumed), anything else means it never dispatched
      // (released), and a receipt that is already terminal moves nothing.
      this.settleToolReceiptQuota(callId, {
        dispatched: charged,
        // A call that never dispatched was cancelled, whatever error text
        // explains the refusal: `FAILED` is reserved for a tool that really ran
        // and failed.
        status: charged ? (error ? 'FAILED' : 'SETTLED') : 'CANCELLED',
      });
      // One bounded body, both ledgers: the tool receipt and the effect row hold
      // the same text, and neither holds the full unbounded output.
      const boundedBody = body === null ? null : this.boundBody(body, 8_000);
      if (this.store.getToolCallReceipt(callId)) {
        this.store.settleToolCallReceipt(callId, {
          result_body: boundedBody === null ? null : JSON.stringify(boundedBody),
          error: error ? String(error?.message ?? error).slice(0, 2000) : null,
        });
      }
      const effect = this.store.getEffect(callId);
      if (effect) {
        const jobId = jobIdOf(result);
        this.store.settleEffect(callId, error
          ? { status: 'FAILED', error: String(error?.message ?? error).slice(0, 2000) }
          : { status: 'SETTLED', body: boundedBody ?? body, ...(jobId ? { job_id: jobId } : {}) });
        this.store.appendEvent(agent.cluster_id, 'effect-settled', { call_id: callId, tool: exec.name, ok: !error, ...(jobId ? { job_id: jobId } : {}) });
      }
    });
  }

  /**
   * Restart recovery: fence stale leases, mark in-flight effects uncertain,
   * return abandoned work to a schedulable state, and resume unfinished
   * clusters. Sessions are never re-created under an existing identity.
   */
  recover({ deferScheduling = false } = {}) {
    if (this.#activeTurns.size || this.#scheduling.size || this.#ticking) {
      fail('Cannot recover while turns or a scheduling pass are active; pause the clusters, let active turns drain, then retry recover', 409);
    }
    // Recovery may be requested again over an already-ready runtime. Close
    // admission before fencing leases; deferral is a barrier, not merely a
    // request to skip opening an initially closed gate at the end.
    this.#schedulingEnabled = false;
    this.#schedulingGeneration += 1;
    const report = [];
    // Every non-terminal cluster, in keyset pages: recovery is the one pass that
    // must never leave a cluster behind.
    const clusters = [];
    let afterId = '';
    for (;;) {
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      clusters.push(...page);
      afterId = page[page.length - 1].id;
      if (page.length < 200) break;
    }
    for (const cluster of clusters) {
      const facts = { cluster_id: cluster.id, status: cluster.status, fenced_leases: 0, uncertain_effects: 0, requeued: 0, blocked_agents: 0 };
      this.store.tx(() => {
        for (const lease of this.store.listLeases(cluster.id, {})) {
          // The messages the fenced turn owned go back to the queue: the process
          // died between taking them and proving its prompt durable, so nothing
          // answered them and a consumed message is never re-offered. The ids are
          // read from the turn-start event, which is what records the ownership.
          const taken = this.store.get(
            "SELECT json_extract(data,'$.inbox_ids') AS ids FROM events WHERE cluster_id=? AND type='turn-start' AND json_extract(data,'$.agent_id')=? ORDER BY seq DESC LIMIT 1",
            cluster.id, lease.agent_id,
          );
          let ids = [];
          try { ids = JSON.parse(taken?.ids ?? '[]'); } catch { ids = []; }
          if (Array.isArray(ids) && ids.length) {
            const reopened = this.store.reopenInbox(ids);
            if (reopened) {
              facts.inbox_reopened = (facts.inbox_reopened ?? 0) + reopened;
              this.store.appendEvent(cluster.id, 'inbox-reopened', {
                agent_id: lease.agent_id, count: reopened, reason: 'the process restarted before the turn proved its prompt durable',
              });
            }
          }
          this.store.deleteLease(lease.id);
          facts.fenced_leases += 1;
        }
        for (const callId of this.store.effectIds(cluster.id, 'STARTED')) {
          this.store.settleEffect(callId, { status: 'EFFECT_UNCERTAIN', error: 'process restarted while the effect was in flight' });
          facts.uncertain_effects += 1;
        }
        this.store.run(
          "UPDATE agents SET status='READY', updated=? WHERE cluster_id=? AND status IN ('RUNNING','CREATED','WAITING')",
          this.store.now(), cluster.id,
        );
        facts.agents_requeued = this.store.changed();
        // Exhaustive, including RUNNING transactions with an ACTIVE allocation.
        // An unreviewed plan resumes under the same identity; a plan the Auditor
        // rejected while that identity was live returns to DRAFT instead, so
        // recovery cannot dispatch work whose old turn lost its lease.
        this.store.run(
          `UPDATE transactions SET
             status=CASE WHEN (
               SELECT a.decision FROM audits a
                WHERE a.cluster_id=transactions.cluster_id AND a.transaction_id=transactions.id
                  AND a.kind='plan' AND a.target_revision=transactions.revision
                ORDER BY a.created DESC, a.rowid DESC LIMIT 1
             )='REJECTED' THEN 'DRAFT' ELSE 'READY' END,
             updated=?
           WHERE cluster_id=? AND status='RUNNING'`,
          this.store.now(), cluster.id,
        );
        facts.requeued = this.store.changed();
        // Stray *capacity* from the previous process is returned to the node: the
        // identity and concurrency reservations a dead turn held are structural,
        // and a reservation whose turn no longer exists must not shrink the
        // cluster. The *economic* holds are not stray: a request that was in
        // flight (RESERVED) or whose cost is unknown keeps its tokens, and
        // zeroing them here made an unknown-cost send spendable again — the exact
        // capacity `releaseLlmRequest(dispatched: true)` deliberately retains.
        // The reserved counters are therefore recomputed from the durable receipts
        // rather than cleared.
        this.store.run(
          `UPDATE budgets SET
             agents_reserved=0, max_active_reserved=0,
             tokens_reserved=COALESCE((
               SELECT SUM(r.reservation_tokens) FROM usage_receipts r
                WHERE r.budget_scope_id = budgets.id AND r.status IN ('RESERVED','UNKNOWN')), 0),
             requests_reserved=COALESCE((
               SELECT COUNT(*) FROM usage_receipts r
                WHERE r.budget_scope_id = budgets.id AND r.status='RESERVED'), 0),
             tool_calls_reserved=COALESCE((
               SELECT COUNT(*) FROM tool_call_receipts t
                WHERE t.budget_scope_id = budgets.id AND t.dispatch_status IN ('ADMITTED','DISPATCHED')), 0),
             revision=revision+1, updated=?
           WHERE cluster_id=? AND scope_kind='agent'`,
          this.store.now(), cluster.id,
        );
        // A fenced turn's unspent, unreserved grant goes back to the scope that
        // funded it: the process that held it is gone.
        facts.returned = this.returnFencedGrants(cluster.id);
        // Every tool call leaves a receipt, including the ones with no effect row
        // (a read, a query), so the quota is reconciled here from the receipt —
        // not from an effect decision, which a read never has. ADMITTED means the
        // call never dispatched: its hold is released and nothing is charged.
        // DISPATCHED means it may have run: one call is consumed, once.
        for (const receipt of this.store.all(
          "SELECT call_id, agent_id, budget_scope_id, dispatch_status FROM tool_call_receipts WHERE cluster_id=? AND dispatch_status IN ('ADMITTED','DISPATCHED')",
          cluster.id,
        )) {
          const outcome = this.settleToolReceiptQuota(receipt.call_id, {
            error: 'the process restarted while the call was in flight',
          }).outcome;
          if (outcome === 'uncertain') facts.tool_receipts_uncertain = (facts.tool_receipts_uncertain ?? 0) + 1;
          else facts.tool_receipts_reconciled = (facts.tool_receipts_reconciled ?? 0) + 1;
        }
        // Preserve attempted injections until the asynchronous session proof:
        // FOUND is acked, ABSENT is requeued, and UNKNOWN remains withheld.
        // Reopening here made reconciliation mistake an uncertain prior send
        // for a fresh queued message and skip its owner fence.
        facts.injections_reopened = 0;
        facts.injections_pending_proof = Number(this.store.get(
          `SELECT COUNT(*) AS count FROM recipients r JOIN messages m ON m.id=r.message_id
           WHERE m.cluster_id=? AND r.status='DELIVERED'`, cluster.id).count);
        this.store.appendEvent(cluster.id, 'recovered', facts);
      });
      report.push(facts);
    }
    if (report.some(facts => facts.status === 'RUNNING') && !deferScheduling) this.enableScheduling();
    return report;
  }

  /**
   * The complete restart lifecycle, shared by startup and IPC. Concurrent
   * callers join the same proof pass, and only its own successful completion
   * may reopen scheduling. Failed proof leaves admission closed for a retry.
   */
  recoverAndReconcile() {
    if (!this.#recoveryPromise) {
      this.#recoveryPromise = this.#recoverAndReconcile().finally(() => {
        this.#recoveryPromise = null;
      });
    }
    return this.#recoveryPromise;
  }

  async #recoverAndReconcile() {
    const recovered = this.recover({ deferScheduling: true });
    const generation = this.#schedulingGeneration;
    const reconciled = [];
    let afterId = '';
    for (;;) {
      const page = this.store.listOpenClusters({ afterId, limit: 200 });
      if (!page.length) break;
      for (const cluster of page) {
        const sessions = await this.proveSessions(cluster.id);
        reconciled.push({ cluster_id: cluster.id, sessions, ...(await this.reconcileDeliveries(cluster.id)) });
      }
      afterId = page[page.length - 1].id;
      if (page.length < 200) break;
    }
    this.#resumeScheduling(generation);
    return { recovered, reconciled };
  }

  /**
   * Prove every identity's durable session, outside any transaction because the
   * probe awaits the persistence service.
   *
   * An identity with turn history and no session is a real defect: re-creating
   * a session under the same id would silently present a blank history as the
   * agent's memory, so its work is blocked with `SESSION_MISSING` instead and a
   * human decides. An identity with no history is simply new, and an
   * unanswerable probe (no persistence mounted) is not evidence of absence.
   */
  async proveSessions(clusterId = null) {
    const clusters = clusterId
      ? [this.store.getCluster(clusterId)].filter(Boolean)
      : this.store.listOpenClusters({ limit: 1000 });
    const report = [];
    for (const cluster of clusters) {
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(cluster.status)) continue;
      const missing = [];
      for (const facts of this.store.agentsInSubtree(cluster.id, null)) {
        if (facts.turns <= 0 || facts.status === 'TERMINATED') continue;
        // eslint-disable-next-line no-await-in-loop
        const exists = await this.sessionExists(facts.session_id);
        if (exists !== false) continue;
        missing.push(facts);
      }
      if (!missing.length) continue;
      this.store.tx(() => {
        for (const facts of missing) {
          for (const tx of this.store.transactionsInSubtree(cluster.id, facts.node_id)) {
            if (['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED', 'BLOCKED'].includes(tx.status)) continue;
            this.store.updateTransaction(tx.id, { status: 'BLOCKED' });
          }
          this.store.updateAgent(facts.id, { status: 'BLOCKED' });
          this.store.appendEvent(cluster.id, 'session-missing', {
            agent_id: facts.id, session_id: facts.session_id, turns: facts.turns,
            code: 'SESSION_MISSING',
            note: 'the identity has turn history but no durable session; it is not re-created under the same id',
          });
        }
        this.blockClusterInternal(cluster.id,
          `SESSION_MISSING: ${missing.length} identities have turn history but no durable session`, 'SESSION_MISSING');
      });
      report.push({ cluster_id: cluster.id, session_missing: missing.map(facts => facts.id) });
    }
    return report;
  }

  /**
   * Whether the host can actually run a turn yet. Recovery may complete while
   * the profile is still mounting, and starting a turn then produces
   * "no agent factory registered" — an infrastructure rejection that must not
   * burn a Worker's attempts.
   */
  hostReady() {
    try {
      if (this.ctx.get?.('agentLoop') === undefined) return false;
      if (this.ctx.get?.('agents') === undefined) return false;
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Resume scheduling only once the host is ready *and* recovery has finished
   * proving which injections were really admitted. Nothing is re-injected while
   * the proof is still being read, and no turn starts against a half-mounted
   * profile.
   */
  /** Whether the readiness and reconciliation barriers have been cleared. */
  schedulingEnabled() {
    return this.#schedulingEnabled;
  }

  /** Open the barrier. Called only once the host is ready and proofs are read. */
  enableScheduling() {
    this.#schedulingEnabled = true;
    this.#ensureTicking();
    this.wake();
  }

  resumeScheduling() {
    this.#resumeScheduling(this.#schedulingGeneration);
  }

  #resumeScheduling(generation) {
    if (this.#disposed || generation !== this.#schedulingGeneration) return;
    // A pending host-readiness callback belongs to this recovery only. A later
    // recovery invalidates it before reopening the session-proof barrier.
    if (this.hostReady()) {
      this.enableScheduling();
      return;
    }
    // The launcher commits its own readiness after boot and host setup; wait
    // for it, then re-check the factory before enabling the scheduler.
    let ready;
    try {
      ready = this.ctx.get?.('appReady');
    } catch {
      ready = undefined;
    }
    const enable = () => {
      if (this.#disposed || generation !== this.#schedulingGeneration) return;
      const wait = () => {
        if (this.#disposed || generation !== this.#schedulingGeneration) return;
        if (this.hostReady()) {
          this.enableScheduling();
          return;
        }
        if (Date.now() - started > this.config.hostReadyTimeoutMs) {
          this.logger?.warn?.('dsh-flow: host did not become ready; scheduling stays disabled');
          return;
        }
        setTimeout(wait, 100).unref?.();
      };
      const started = Date.now();
      wait();
    };
    if (typeof ready?.onReady === 'function') ready.onReady(enable);
    else enable();
  }

  /** The compaction scope, funded separately from the tree it keeps affordable. */
  compactionBudgetId(clusterId) {
    const row = this.store.get('SELECT id FROM budgets WHERE cluster_id=? AND scope_kind=? LIMIT 1', clusterId, 'compaction');
    return row?.id ?? null;
  }

  /**
   * Select one scope that can cover the entire request. Compaction draws from
   * its reserved pool first; ordinary turns draw from their management grant
   * first. Either can fall back to the other's scope when its own grants cannot
   * pay, so funded capacity does not become stranded.
   */
  budgetChainForAgent(agent, { tokens = 0, requests = 1, kind = 'role' } = {}) {
    const cluster = this.store.getCluster(agent.cluster_id);
    const agentBudget = this.store.getBudget(this.store.budgetForScope(agent.cluster_id, 'agent', agent.id)?.id);
    const pool = this.store.getBudget(this.compactionBudgetId(agent.cluster_id));
    const management = this.fundingBudget(cluster, agent);
    const candidates = (kind === 'compaction'
      ? [pool, management, agentBudget]
      : [management, agentBudget, pool]).filter(Boolean);
    const now = this.timestamp();
    // A scope is payable only when it covers the *whole* reservation in every
    // dimension the request needs, under a live deadline. Choosing a scope
    // because it holds *something* strands the request while the rest of the
    // budget sits elsewhere.
    const payable = row => {
      if (dimensionAvailable(row, 'tokens') < tokens || dimensionAvailable(row, 'model_requests') < requests) return false;
      const deadline = effectiveDeadline(this.store, row);
      return deadline === null || deadline > now;
    };
    const chosen = candidates.find(payable);
    if (chosen) return [chosen.id];
    // Nothing can pay it: name the scope with the most capacity, so the refusal
    // points at the scope that is really short — and never answer with an empty
    // chain, which reserves nothing and would send the request for free.
    if (candidates.length) {
      const best = candidates.reduce((a, b) => (dimensionAvailable(a, 'tokens') >= dimensionAvailable(b, 'tokens') ? a : b));
      return [best.id];
    }
    const fallback = this.agentBudgetChain(cluster, agent);
    if (fallback.length) return fallback;
    const error = new Error(`no budget scope exists for agent ${agent.id}; a request from it cannot be accounted`);
    error.code = 'LIMIT_REACHED';
    error.scope = agent.node_id ?? agent.id;
    error.dimension = 'model_requests';
    throw error;
  }

  /**
   * A refused admission is the only durable evidence that a limit was really
   * hit; proximity to the ceiling is not.
   */
  /**
   * A request that could not be funded anywhere its identity is allowed to draw
   * on stops the *node* it belongs to, with the coded reason. Retrying it as a
   * per-turn error burned 49 turns in one recursion run and moved nothing.
   *
   * A Worker's own request allowance is deliberately not covered here: that is a
   * per-task limit, and exhaust it does not mean the node is out of money.
   */
  blockNodeOnBudget(agent, reason, facts = {}) {
    if (!agent?.cluster_id || !agent.node_id) return false;
    if (/allowance for this task/.test(String(reason))) return false;
    const node = this.store.getNode(agent.node_id);
    if (!node || node.status === 'BLOCKED') return false;
    // The identity is part of the record: a resume has to know whose envelope was
    // refused, and a refusal is scoped to that identity (or to the pool it drew
    // from), never to the node.
    this.blockNodeInternal(agent.cluster_id, agent.node_id, `BUDGET: ${String(reason).slice(0, 300)}`,
      'BUDGET_EXHAUSTED', {
        agent_id: agent.id, dimension: facts.dimension ?? null, requested: facts.requested ?? null,
        envelope: facts.envelope ?? null,
      });
    return true;
  }

  recordBudgetRefusal(agent, reason, facts = {}) {
    if (!agent?.cluster_id) return null;
    this.#refusals.set(agent.cluster_id, (this.#refusals.get(agent.cluster_id) ?? 0) + 1);
    // A refusal for tokens in a cluster that has less than one request's worth
    // left anywhere is not a bookkeeping hiccup: the cluster cannot pay for its
    // own next request, and saying so stops it — otherwise it spins until its
    // wall deadline, refusing every request it tries (measured: a tier sat for
    // hours with 997,670 of its 1,048,576 tokens spent and no progress).
    if (facts.dimension === 'tokens' && facts.available === 0) {
      const rollup = rollupBudgets(this.store, agent.cluster_id);
      const left = rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent;
      if (rollup.tokens.limit > 0 && left < 4096) {
        this.blockClusterInternal(agent.cluster_id,
          `BUDGET: ${String(reason).slice(0, 200)} (only ${left} tokens remain in the cluster)`, 'BUDGET_EXHAUSTED');
      }
    }
    // A shortfall that a repair then closed is *not* a refusal: the request was
    // admitted. Recording it as one made the acceptance classifier read a
    // recovered request as a terminal limit (measured: twelve `budget-refused`
    // events for one identity, all with a SETTLED receipt within 20 ms).
    const type = facts.terminal === false ? 'budget-shortfall' : 'budget-refused';
    return this.store.tx(() => {
      const event = this.store.appendEvent(agent.cluster_id, type, {
        agent_id: agent.id, node_id: agent.node_id ?? null, role: agent.role ?? null,
        scope: facts.scope ?? null, dimension: facts.dimension ?? null,
        requested: facts.requested ?? null, available: facts.available ?? null,
        terminal: facts.terminal ?? true, reason: String(reason).slice(0, 300),
      });
      if (type === 'budget-refused' && agent.node_id) {
        const node = this.store.getNode(agent.node_id);
        const payload = { node_id: agent.node_id, agent_id: agent.id,
          dimension: facts.dimension ?? null, requested: facts.requested ?? null,
          available: facts.available ?? null, scope: facts.scope ?? null };
        const dedupeKey = `budget-refused:${agent.node_id}:${node?.revision ?? 0}:${facts.dimension ?? ''}`;
        this.notifyInternal(agent.cluster_id, this.roleAgentOf(agent.cluster_id, agent.node_id, 'orchestrator')?.id,
          { subject: 'budget-refused', payload, dedupeKey });
        if (node?.parent_id) this.notifyInternal(agent.cluster_id,
          this.roleAgentOf(agent.cluster_id, node.parent_id, 'allocator')?.id,
          { subject: 'budget-refused', payload, dedupeKey });
      }
      return event;
    });
  }

  /**
   * The same admission test as `admitToolCall`, re-run after the awaited flush.
   * Returns `{ok}` and never mutates the reservation.
   */
  recheckToolCall(agent, exec, callId) {
    const lease = this.store.leaseForAgent(agent.id);
    if (!lease || lease.expires <= this.timestamp()) return { ok: false, reason: 'the turn lease expired while the tool call was being prepared' };
    const captured = exec.agent ? this.turnActor(exec.agent) : null;
    if (captured && captured.epoch !== lease.epoch) {
      return { ok: false, reason: `this instance belongs to lease epoch ${captured.epoch}, but the live lease is ${lease.epoch}` };
    }
    void callId;
    return { ok: true };
  }

  /**
   * A tool call refused at the post-flush fence never dispatched, so its
   * reservation is returned without charging and the refusal is recorded.
   */
  refuseToolCall(agent, exec, callId, reason) {
    this.store.tx(() => {
      this.store.appendEvent(agent.cluster_id, 'tool-call-refused', {
        agent_id: agent.id, call_id: callId, tool: exec?.name ?? null, reason: reason ?? 'refused before dispatch',
      });
    });
    return this.settleToolCall(agent, exec, callId, null, new Error(reason ?? 'refused before dispatch'), { charged: false });
  }

  /**
   * Validate an actor fenced to a captured turn. Mutating actions require a
   * captured epoch that is still the live one; read-only work may proceed
   * without one.
   */
  assertActorFence(actor, { mutating = true } = {}) {
    if (actor.role === 'user') return;
    const lease = this.store.leaseForAgent(actor.agent_id);
    if (actor.epoch === undefined) {
      if (mutating) fail(`this agent instance does not own a scheduled cluster turn; its identity cannot be fenced`, 409);
      return;
    }
    if (!lease || lease.epoch !== actor.epoch || lease.expires <= this.timestamp()) {
      fail(`command from a fenced turn: agent ${actor.agent_id} does not hold epoch ${actor.epoch}`, 409);
    }
    if (mutating && actor.epoch !== lease.epoch) fail('fenced actor', 409);
  }

  /**
   * A turn rejected before the host was ready is an infrastructure condition:
   * wait for readiness again instead of burning turns against it.
   */
  armHostReadyRetry(error) {
    const message = String(error?.message ?? '');
    if (!/agent factory|not mounted|not loadable/i.test(message)) return;
    this.logger?.warn?.(`dsh-flow: a turn started before the host was ready (${message}); scheduling waits for readiness again`);
    this.resumeScheduling();
  }

  #heartbeats = new Map();
  #flowCalls = new Map();
  #toolCallLog = new Map();
  #turnIdentity = new WeakMap();
  #persistence = null;
  #startFailures = new Map();
  #schedulingEnabled = false;
  #forceCompact = new Set();

  // ----------------------------------------------------------- inventory

  roleAgentOf(clusterId, nodeId, role) {
    return this.store.listAgents(clusterId, { node_id: nodeId, role, limit: 5 })
      .find(agent => agent.status !== 'TERMINATED') ?? null;
  }

  ensureRoles(clusterId, node, budgets) {
    const created = {};
    for (const role of ['orchestrator', 'allocator', 'auditor']) {
      const agent = this.store.insertAgent({
        id: randomUUID(), cluster_id: clusterId, node_id: node.id, role,
        session_id: randomUUID(), status: 'READY', capabilities: node.capabilities,
        meta: { management: true },
      });
      this.grantAgentBudget(clusterId, node, budgets.get(node.id), agent, role);
      created[role] = agent.id;
    }
    this.store.appendEvent(clusterId, 'roles-created', { node_id: node.id, agents: created });
    return created;
  }

  grantAgentBudget(clusterId, node, nodeBudget, agent, role) {
    const fresh = this.store.getBudget(nodeBudget.id ?? nodeBudget);
    const limits = { tokens: 0, model_requests: 0, tool_calls: 0, agents: 0, max_active_agents: 0 };
    if (role === 'worker') {
      // A worker runs one short transaction: its grant must cover a couple of
      // requests, never a share that would starve the long-lived roles. On
      // this deployment a request carries 10-70k input tokens, so the token
      // budget, not the request count, is the binding constraint.
      const workerGrant = { tokens: 65_536, model_requests: 8, tool_calls: 32 };
      // A declared per-Worker request allowance is a ceiling on what this
      // identity may send as *task* requests (see `countWorkerRequests`), so
      // granting many more parks capacity the next Worker needs: measured at 64
      // files, Workers were handed 8 requests each out of a node that holds 234,
      // and the last 50 were born with an allocation of zero requests — they
      // could not start. The grant is the allowance plus one working
      // reservation: a request that is reserved and then released before
      // dispatch still has to fit, and a compaction the summary pool cannot pay
      // falls back here. The ordinary ceiling stays enforced per request.
      const perWorkerAllowance = Number(this.store.getCluster(clusterId)?.limits?.worker_model_requests) || 0;
      if (perWorkerAllowance > 0) {
        workerGrant.model_requests = Math.min(workerGrant.model_requests, perWorkerAllowance + 1);
      }
      for (const key of ['tokens', 'model_requests', 'tool_calls']) {
        limits[key] = Math.max(1, Math.min(workerGrant[key], dimensionAvailable(fresh, key)));
      }
      // No per-agent active-slot grant: concurrency is enforced once, by the
      // cluster-level window, and a single agent can only run one turn at a
      // time (`#activeTurns.has(agent.id)`). Granting a worker its own
      // `max_active_agents` limit added no constraint and leaked the node's
      // capacity one wave at a time, because only the node's own reservation
      // was ever returned.
    } else {
      // The three management roles carry the planning, allocation and audit work
      // of the whole domain, and the node's file is the pool they draw from when
      // their own grant runs out (`agentBudgetChain`). Their *initial* grant is a
      // working allowance — the turns this deployment gives a role, at the cost a
      // management request actually carries here — not a greedy quarter of the
      // file. A quarter each drained the node before its children existed: a
      // depth-1 node held 134,430 tokens, its three roles took them, and the two
      // levels below it were created with 11,000 and 6,067 tokens, so the branch
      // the case exists to exercise was born unable to run a single one of its
      // roles' turns.
      const cluster = this.store.getCluster(clusterId);
      const perTurn = Math.max(16_384, (Number(this.config?.context?.role) || 8192) * 2);
      const turns = Math.max(1, Number(cluster?.limits?.max_role_turns) || 3);
      const working = Math.min(perTurn * turns, Math.floor(dimensionAvailable(fresh, 'tokens') / 4));
      limits.tokens = Math.max(1, working);
      limits.model_requests = Math.max(1, Math.min(turns * 4, Math.floor(dimensionAvailable(fresh, 'model_requests') / 4)));
      // Tool calls are consumed several per turn across a whole run, not three turns'
      // worth: a role spent 62, 33, 31 and 27 of its 60-token grant while the run still
      // had work, and every one of the 24 tool-call refusals was an agent scope spent
      // to the last call. The grant is a working allowance for the turns this
      // deployment actually gives a role, still bounded by a quarter of the node.
      limits.tool_calls = Math.max(1, Math.min(turns * 20, Math.floor(dimensionAvailable(fresh, 'tool_calls') / 4)));
    }
    const budget = createBudget(this.store, {
      cluster_id: clusterId, scope_kind: 'agent', scope_id: agent.id, node_id: node.id,
      parent_budget_id: nodeBudget.id, limit: {},
    });
    this.grantBudget(nodeBudget, budget, limits);
    this.store.appendEvent(clusterId, 'budget-granted', {
      agent_id: agent.id, node_id: node.id, role, grant: this.store.getBudget(budget.id),
    });
    return this.store.getBudget(budget.id);
  }

  /**
   * Send the deterministic fixture messages whose source transaction just
   * reached acceptance. The send goes through the same communication graph a
   * model call would use, so the delivery pipeline itself is what gets tested.
   */
  deliverFixtureMessages(cluster, tx = null) {
    const fixture = cluster.spec?.message_fixture ?? [];
    const entries = fixture.filter(entry => (tx ? entry.from === tx.id : this.#fixtureReady(cluster, entry)));
    if (!entries.length) return [];
    const sent = [];
    const senderNode = tx?.node_id ?? this.store.getTransaction(entries[0].from)?.node_id ?? this.store.listNodes(cluster.id, { parent_id: null })[0]?.id;
    const sender = this.roleAgentOf(cluster.id, senderNode, 'orchestrator');
    for (const entry of entries) {
      const recipient = this.#fixtureRecipient(cluster, entry);
      if (!recipient) {
        this.store.appendEvent(cluster.id, 'fixture-message-undeliverable', { message_id: entry.message_id, to: entry.to });
        continue;
      }
      const result = this.store.tx(() => this.communicateFrom(
        { cluster_id: cluster.id, agent_id: sender?.id ?? null, node_id: senderNode, role: 'orchestrator' },
        'send',
        { agent: recipient.id, content: entry.content, message_id: entry.message_id },
      ));
      if (!result.deduped) {
        const recipientNode = this.store.getNode(recipient.node_id);
        this.store.appendEvent(cluster.id, 'fixture-message-sent', {
          message_id: entry.message_id, from: entry.from, recipient: recipient.id,
          recipient_node: recipient.node_id, sender_node: senderNode,
          cross_subtree: Boolean(recipientNode && recipientNode.parent_id === senderNode),
        });
        sent.push({ message_id: entry.message_id, recipient: recipient.id });
      }
      void tx;
    }
    return sent;
  }

  /**
   * Take this agent's undelivered messages out of the queue and mark them
   * injected. A delivery is only acked after the turn's session is flushed, so
   * the crash window between injection and ack can be repaired without a
   * second copy: recovery acks what was already injected and never re-injects.
   */
  /**
   * Take on this agent's pending deliveries.
   *
   * A delivery can be pending while its prompt is *already durable* in the
   * recipient's session — the tool pipeline flushes the session mid-turn, so a
   * turn that dies at its final flush leaves the message written but unacked.
   * Such a delivery is acked here instead of injected again: replaying it would
   * put the same message in the session twice.
   */
  async collectDeliveries(agent) {
    const pending = this.store.pendingDeliveries(agent.id);
    if (!pending.length) return { messages: [], ids: [], reconciled: 0 };
    const persistence = this.#persistence ?? (() => {
      try { return this.ctx.get?.('sessionPersistence') ?? null; } catch { return null; }
    })();
    if (persistence) this.#persistence = persistence;
    const toInject = [];
    let reconciled = 0;
    for (const row of pending) {
      if (!persistence || !agent.session_id) {
        toInject.push(row);
        continue;
      }
      // A session that does not exist has never been injected: that is a proven
      // absence, so the message is delivered rather than withheld. Only a
      // session that exists but cannot be read is UNKNOWN.
      const exists = await this.sessionExists(agent.session_id);
      const proof = exists === false
        ? { state: 'ABSENT', found: false, reason: 'the recipient has no session yet, so nothing has been injected' }
        : await sessionCarries(persistence, agent.session_id, row.message_id);
      if (proof.state === 'UNKNOWN') {
        // Unprovable: keep it queued, record why, and do not inject a possible
        // second copy.
        this.store.tx(() => this.store.appendEvent(agent.cluster_id, 'delivery-unknown', {
          agent_id: agent.id, message_id: row.message_id, session_id: agent.session_id, reason: proof.reason ?? null,
        }));
        continue;
      }
      if (proof.state !== 'FOUND') {
        toInject.push(row);
        continue;
      }
      reconciled += 1;
      this.store.tx(() => {
        this.store.ackDelivery(row.message_id, agent.id);
        this.store.appendEvent(agent.cluster_id, 'messages-ack-reconciled', {
          agent_id: agent.id, message_id: row.message_id, session_id: agent.session_id,
          reason: 'the prompt was already durable in the session', scanned: proof.scanned ?? null,
        });
      });
    }
    if (!toInject.length) return { messages: [], ids: [], reconciled };
    const ids = toInject.map(row => row.message_id);
    this.store.tx(() => {
      for (const id of ids) this.store.markDeliveryInjected(id, agent.id);
      this.store.appendEvent(agent.cluster_id, 'messages-injected', { agent_id: agent.id, message_ids: ids });
    });
    return { messages: toInject, ids, reconciled };
  }

  /**
   * Ack deliveries whose turn was *provably* admitted and flushed. A turn that
   * never reached the model reopens them instead, so a startup failure cannot
   * consume a message.
   */
  settleDeliveries(clusterId, agentId, ids, { admitted, durable = false }) {
    if (!ids?.length) return 0;
    // A message may only be acked when its prompt was admitted *and* the
    // session was flushed: `followup` alone does not make it durable.
    if (!admitted || !durable) {
      this.store.tx(() => {
        for (const id of ids) {
          this.store.run("UPDATE recipients SET status='PENDING', acked=NULL WHERE message_id=? AND recipient=? AND status='DELIVERED'", id, agentId);
        }
        this.store.appendEvent(clusterId, 'messages-reopened', {
          agent_id: agentId, message_ids: ids,
          reason: admitted ? 'the session was not flushed before the turn ended' : 'the turn never reached the model',
        });
      });
      return 0;
    }
    // The durable-flush boundary: recorded so a fault trigger can land exactly
    // between "the session is durable" and "the delivery is acked".
    this.store.tx(() => this.store.appendEvent(clusterId, 'delivery-flushed', { agent_id: agentId, message_ids: ids }));
    this.store.tx(() => {
      for (const id of ids) this.store.ackDelivery(id, agentId);
      this.store.appendEvent(clusterId, 'messages-acked', { agent_id: agentId, message_ids: ids });
    });
    return ids.length;
  }

  /**
   * Keep a live identity supplied from its node's remaining budget. The grant
   * is a real transfer, so the ledger stays hierarchical and the Allocator can
   * still move budget explicitly with `rebalance_budget`.
   */
  /**
   * Top-up entry point for the request path. The request path names the *gap*
   * it is short of, in the dimensions it needs; nothing else moves.
   *
   * Two rules make this honest rather than generous:
   * - a Worker whose request allowance is spent gets no tokens — paying for a
   *   request that cannot be sent is not a top-up;
   * - the node is asked for the gap, and siblings are reclaimed only when the
   *   node really cannot cover it.
   */
  topUpBudgetForAgent(agent, amounts = {}) {
    const cluster = this.store.getCluster(agent.cluster_id);
    const agentBudget = this.store.getBudget(this.store.budgetForScope(cluster.id, 'agent', agent.id)?.id);
    const nodeBudget = this.fundingBudget(cluster, agent);
    if (!agentBudget || !nodeBudget) return null;
    const wanted = Object.fromEntries(Object.entries(amounts).filter(([, value]) => Number.isFinite(value) && value > 0));
    if (!Object.keys(wanted).length) return null;
    const allowance = this.workerRequestAllowance(agent);
    // A per-identity *request* allowance is final: a top-up must not extend it.
    // It says nothing about tool calls, though. A Worker that has sent both of
    // its requests still has to run the tool call that submits the result, and
    // refusing that refill here made the last step of an otherwise finished
    // Worker fail (measured: a Worker holding 32 tool calls, two requests sent,
    // and a refused final submit that ended its transaction FAILED).
    const wantsRequests = Number(wanted.model_requests ?? 0) > 0;
    if (allowance !== null && wantsRequests && this.store.countWorkerRequests(cluster.id, agent.id) >= allowance) return null;
    const row = this.store.getBudget(agentBudget.id);
    const gap = {};
    for (const [key, need] of Object.entries(wanted)) {
      // The recipient's deficit is measured against its *limit*, not against what
      // it has left. An account may be overdrawn: settlement permits actual usage to
      // exceed the reservation, so `spent` can pass `limit` (measured: a pool at
      // −279 tokens) and `dimensionAvailable` clamps that debt to zero — filling
      // only `need` would leave it exactly as short as the overshoot.
      const column = key === 'model_requests' ? 'requests' : key;
      const short = need + Number(row[`${column}_reserved`] ?? 0) + Number(row[`${column}_spent`] ?? 0)
        - Number(row[`${column}_limit`] ?? 0);
      if (short > 0) gap[key] = short;
    }
    if (!Object.keys(gap).length) return null;
    const node = this.store.getBudget(nodeBudget.id);
    const shortAtNode = Object.entries(gap).some(([key, need]) => dimensionAvailable(node, key) < need);
    // Reclaim only idle identities funded by this node. If its own file still
    // cannot cover the measured gap, unallocated capacity held by an ancestor
    // node may follow the parent_budget_id path down. No sibling's node grant
    // moves automatically; cross-subtree rebalances remain Allocator actions.
    if (shortAtNode) this.reclaimSiblingGrants(cluster, agent, nodeBudget.id);
    const afterReclaim = this.store.getBudget(nodeBudget.id);
    const missing = Object.fromEntries(Object.entries(gap)
      .map(([key, need]) => [key, Math.max(0, need - dimensionAvailable(afterReclaim, key))])
      .filter(([, need]) => need > 0));
    if (Object.keys(missing).length) {
      const path = [nodeBudget.id];
      let source = this.store.getBudget(afterReclaim.parent_budget_id);
      while (source?.scope_kind === 'node') {
        // The ancestor may look empty because its own idle roles hold the
        // unused grant. Bring it back to that node (never from a sibling node)
        // before deciding whether the whole measured gap can follow this path.
        if (Object.entries(missing).some(([key, need]) => dimensionAvailable(source, key) < need)) {
          this.reclaimIdleRoleGrants(cluster, source.id);
          source = this.store.getBudget(source.id);
        }
        if (Object.entries(missing).every(([key, need]) => dimensionAvailable(source, key) >= need)) {
          for (let i = path.length - 1; i >= 0; i -= 1) {
            transferBudget(this.store, source.id, path[i], missing);
            source = this.store.getBudget(path[i]);
          }
          this.store.appendEvent(cluster.id, 'budget-topup', {
            agent_id: agent.id, node_id: agent.node_id, granted: missing, mode: 'ancestor-request-gap',
          });
          break;
        }
        path.push(source.id);
        source = this.store.getBudget(source.parent_budget_id);
      }
    }
    const available = this.store.getBudget(nodeBudget.id);
    // All or nothing, over the *whole* envelope. A partial grant is the worst of
    // both worlds: the request it was meant to fund still cannot be reserved, and
    // the capacity it moved is now held by an identity that cannot spend it
    // (measured: a top-up of 15,399 tokens against a 41,363-token request left the
    // request refused and the node 15,399 tokens poorer).
    //
    // Moving only the dimension that fits is worse still when two candidates are
    // repaired in turn: with the pool holding one request and no tokens, the root
    // node holding tokens and no requests, and the identity leased and empty,
    // moving tokens into the identity leaves the pool with nothing to draw and the
    // request unpayable — where a full-envelope repair, which would move nothing
    // for the identity, leaves every token where the pool can reach it.
    for (const [key, need] of Object.entries(gap)) {
      if (dimensionAvailable(available, key) < need) return null;
    }
    const give = { ...gap };
    const granted = this.grantBudget(nodeBudget, this.store.getBudget(agentBudget.id), give);
    if (granted) {
      const after = this.store.getBudget(agentBudget.id);
      this.store.appendEvent(cluster.id, 'budget-topup', {
        agent_id: agent.id, node_id: agent.node_id, granted, mode: 'request-gap',
        // The resulting state is recorded with the grant: a top-up that does not
        // move the identity's availability is a bookkeeping defect, and the
        // numbers are what makes that visible.
        available_after: {
          tokens: dimensionAvailable(after, 'tokens'),
          model_requests: dimensionAvailable(after, 'model_requests'),
          tool_calls: dimensionAvailable(after, 'tool_calls'),
        },
      });
    }
    return granted;
  }

  /** Move every sibling identity's unused, unreserved surplus back to its node. */
  /**
   * Fund the compaction pool from the node lineage when the earmark cannot cover
   * a summary request.
   *
   * The pool is a *share* of the cluster's budget, so a long run exhausts it
   * while the node still holds capacity — and an unfundable compaction is an
   * unshrinkable session (measured: the allocator's session grew to 124k and
   * every later step was refused at the provider ceiling). Idle identities'
   * grants are reclaimed first, because the capacity they hold is capacity the
   * node no longer has.
   */
  topUpCompactionPool(clusterId, amounts = {}) {
    const pool = this.store.getBudget(this.compactionBudgetId(clusterId));
    const rootId = this.store.listNodes(clusterId, { parent_id: null })[0]?.id ?? null;
    const node = rootId ? this.store.budgetForScope(clusterId, 'node', rootId) : null;
    if (!pool || !node) return null;
    const wanted = Object.fromEntries(Object.entries(amounts).filter(([, value]) => Number.isFinite(value) && value > 0));
    if (!Object.keys(wanted).length) return null;
    const gap = {};
    for (const [key, need] of Object.entries(wanted)) {
      // Against the limit, so an overdrawn pool is refilled to a *working* balance
      // rather than left short by its overshoot (see `topUpBudgetForAgent`).
      const column = key === 'model_requests' ? 'requests' : key;
      const short = need + Number(pool[`${column}_reserved`] ?? 0) + Number(pool[`${column}_spent`] ?? 0)
        - Number(pool[`${column}_limit`] ?? 0);
      if (short > 0) gap[key] = short;
    }
    if (!Object.keys(gap).length) return null;
    const before = this.store.getBudget(node.id);
    if (Object.entries(gap).some(([key, need]) => dimensionAvailable(before, key) < need)) {
      this.reclaimAllIdleGrants(clusterId, node.id);
    }
    const available = this.store.getBudget(node.id);
    const give = {};
    for (const [key, need] of Object.entries(gap)) {
      const movable = Math.min(need, dimensionAvailable(available, key));
      if (movable > 0) give[key] = movable;
    }
    if (!Object.keys(give).length) return null;
    const granted = this.grantBudget(this.store.getBudget(node.id), this.store.getBudget(pool.id), give);
    if (granted) {
      this.store.appendEvent(clusterId, 'budget-topup', { scope: pool.id, granted, mode: 'compaction-pool' });
    }
    return granted;
  }

  /**
   * Every idle identity's unused, unreserved grant, back to *the scope that
   * funded it*.
   *
   * The parent check is load-bearing: this function runs while funding the
   * cluster's compaction pool, and without it every delegated subtree's grants
   * were swept into the root node — one subtree's capacity paying another
   * subtree's summary. Reclamation never crosses a `parent_budget_id`.
   */
  reclaimAllIdleGrants(clusterId, nodeBudgetId) {
    const moved = {};
    for (const sibling of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      if (sibling.parent_budget_id !== nodeBudgetId) continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      const give = {};
      for (const key of ['tokens', 'model_requests', 'tool_calls']) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  /**
   * Move every *idle* sibling identity's unused, unreserved surplus back to the
   * node. Idle means "not running a turn": a live turn's grant is what the node
   * must keep funding, and reclaiming it mid-request would strand the request
   * that is already reserved. There is no fixed floor — a reserve that is never
   * spent is exactly the capacity the starving identity needed.
   */
  /**
   * Bring back the idle grants of *every* identity this node funds. Called before
   * a node hands capacity to a child: the parent's own roles hold most of its
   * requests while they are between turns (measured: the root node's three roles
   * held 96, 78 and 59 requests with 27 spent between them, while the node itself
   * refused 21 requests and two of its depth-3 children were created with 5 and 3),
   * and that capacity is in scope for the node that granted it.
   */
  /** Idle identities funded by one node hand their unspent, unreserved grants back to it. */
  reclaimIdleRoleGrants(cluster, nodeBudgetId) {
    // Callers pass either the cluster row or its id; taking `cluster.id` from a
    // string silently matched nothing, which is exactly the failure this method
    // exists to prevent.
    const clusterId = typeof cluster === 'string' ? cluster : cluster?.id;
    if (!clusterId) return null;
    const node = this.store.getBudget(nodeBudgetId);
    if (!node) return null;
    const moved = {};
    for (const budget of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      if (budget.parent_budget_id !== nodeBudgetId) continue;
      // Idle identities only, and nothing retained. §5.6 permits reclaiming what an
      // identity holds *and* has no live turn to spend it in — a leased identity is
      // mid-turn, and moving its grant would take capacity from a request it is
      // about to make. Redistributing a live turn's grant is the Allocator's
      // explicit `rebalance_budget`, never a side effect of a repair, and no fixed
      // floor is kept back: the repair is the gap a request actually needs.
      if (this.store.leaseForAgent(budget.scope_id)) continue;
      const row = this.store.getBudget(budget.id);
      const give = {};
      for (const key of ['tokens', 'model_requests', 'tool_calls']) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  reclaimSiblingGrants(cluster, agent, nodeBudgetId) {
    const moved = {};
    for (const sibling of this.store.listBudgets(cluster.id, { scope_kind: 'agent' })) {
      // Siblings are the identities funded by the same parent budget.
      if (sibling.scope_id === agent.id || sibling.parent_budget_id !== nodeBudgetId) continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      const give = {};
      for (const key of ['tokens', 'model_requests', 'tool_calls']) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, nodeBudgetId, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }


  /**
   * Move every identity grant that no live turn can spend back to the scope
   * that funded it. Run at recovery, when the identities that held those grants
   * belong to a process that no longer exists.
   */
  returnFencedGrants(clusterId) {
    const moved = {};
    for (const sibling of this.store.listBudgets(clusterId, { scope_kind: 'agent' })) {
      // A *Worker* grant belongs to one transaction's turn; when the process
      // dies, that worker's work is over and its grant goes home. A management
      // role's grant is not returned: the role survives the restart and would
      // otherwise start every dimension at zero (measured: an orchestrator with
      // 1,285 tool calls returned to its node could not make a single tool call
      // afterwards, and burned its whole turn budget on refusals).
      const owner = this.store.getAgent(sibling.scope_id);
      if (!owner || owner.role !== 'worker') continue;
      if (this.store.leaseForAgent(sibling.scope_id)) continue;
      const row = this.store.getBudget(sibling.id);
      const parent = row.parent_budget_id ? this.store.getBudget(row.parent_budget_id) : null;
      if (!parent) continue;
      const give = {};
      for (const key of ['tokens', 'model_requests', 'tool_calls']) {
        const take = dimensionAvailable(row, key);
        if (take > 0) give[key] = take;
      }
      if (!Object.keys(give).length) continue;
      transferBudget(this.store, row.id, parent.id, give);
      for (const [key, amount] of Object.entries(give)) moved[key] = (moved[key] ?? 0) + amount;
    }
    return Object.keys(moved).length ? moved : null;
  }

  /**
   * The budget that actually funds an identity: its agent budget's own parent.
   * A Worker's node id points at the worker node, while its grant is parented
   * to the management node's budget, so resolving by `agent.node_id` would look
   * for a node budget that never exists.
   */
  fundingBudget(cluster, agent) {
    const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
    if (!agentBudget) return null;
    const parent = agentBudget.parent_budget_id ? this.store.getBudget(agentBudget.parent_budget_id) : null;
    if (parent) return parent;
    return this.store.budgetForScope(cluster.id, 'node', agent.node_id) ?? null;
  }



  /**
   * The enforcing scope for one agent's requests is its own grant. Budget moves
   * downward as a transfer (`limit` leaves the parent), so reserving on the
   * whole lineage would double-count the same tokens.
   */
  agentBudgetChain(cluster, agent) {
    const agentBudget = this.store.budgetForScope(cluster.id, 'agent', agent.id);
    if (agentBudget) return [agentBudget.id];
    const nodeBudget = this.store.budgetForScope(cluster.id, 'node', agent.node_id);
    return nodeBudget ? [nodeBudget.id] : [];
  }

  /** Transfer a node's unused, unreserved capacity to a child budget. */
  grantBudget(parentBudget, childBudget, amounts = {}) {
    if (!parentBudget || !childBudget) return null;
    // Always work from the current rows: a caller's budget object is a
    // snapshot, and a stale snapshot would grant the same capacity twice.
    const parent = this.store.getBudget(parentBudget.id ?? parentBudget);
    const child = this.store.getBudget(childBudget.id ?? childBudget);
    if (!parent || !child) return null;
    const transfer = {};
    // Only the dimensions the caller names move. An omitted dimension is not
    // "grant everything": a budget top-up must never hand over the node's
    // agent or active-slot capacity.
    for (const [key, wanted] of Object.entries(amounts)) {
      if (!['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents'].includes(key)) {
        fail(`Unknown budget dimension: ${key}`);
      }
      const available = dimensionAvailable(parent, key);
      if (available <= 0) continue;
      const give = Math.min(available, Math.floor(wanted));
      if (give > 0) transfer[key] = give;
    }
    if (!Object.keys(transfer).length) return null;
    transferBudget(this.store, parent.id, child.id, transfer);
    return transfer;
  }

  modelFor(agent) {
    const base = { ...this.config.model, ...(agent.meta?.model ?? {}) };
    // A scale tier may cap generated tokens per Worker; management keeps the
    // configured budget, since its planning and audit turns are longer.
    const cap = Number(this.store.getCluster(agent.cluster_id)?.limits?.worker_max_tokens) || null;
    if (cap && agent.role === 'worker') return { ...base, maxTokens: Math.min(base.maxTokens ?? cap, cap) };
    return base;
  }

  /**
   * Two surfaces for one turn: `allowed` is the enforced allowlist (capability
   * tools plus this role's flow tools plus the shared read-only tools), and
   * `global` is the subset that lives in the global layer, which is all
   * `tools.restrict()` may name. Capability packages are mounted into the
   * agent's own scope and are therefore enforced by the guard alone.
   */
  allowedToolsFor(cluster, role, agent) {
    const flowTools = role === 'worker'
      ? ['flow_transaction', 'flow_query', 'flow_communicate', 'flow_sum']
      : [ROLE_TOOL[role], 'flow_query', 'flow_communicate', 'flow_sum'];
    if (role === 'worker') {
      const allocation = this.store.activeAllocationForAgent(agent.id);
      const capabilities = (allocation?.capabilities?.length ? allocation.capabilities : null)
        ?? (agent.capabilities?.length ? agent.capabilities : null)
        ?? cluster.capabilities;
      const tools = toolsForCapabilities(capabilities);
      return { allowed: [...new Set([...tools, ...flowTools, 'flow_sum'])].sort(), global: [...new Set(flowTools)].sort(), capabilities };
    }
    return { allowed: [...new Set(flowTools)].sort(), global: [...new Set(flowTools)].sort(), capabilities: [] };
  }

  // -------------------------------------------------------- pending work

  #pendingFor(role, node, cluster, agent = null) {
    const id = cluster.id;
    const items = [];
    // Notifications first: an event a role subscribed to is an action it must
    // take, and consuming it here (in the same transaction that starts the
    // turn) is what makes the inbox a queue rather than a log.
    const recipient = agent?.id ?? this.roleAgentOf(id, node.id, role)?.id ?? null;
    const notifications = [];
    if (recipient) {
      // Notifications *ride along* with the next turn this role starts for its
      // own work; they never manufacture a turn. A role woken only by "the load
      // changed" burned 107 turns in one run, each a full management request,
      // and exhausted its turn budget without allocating anything.
      for (const row of this.store.listInbox(id, {
        recipient, status: 'PENDING', limit: 8, priority: INBOX_PRIORITY_SUBJECTS,
      })) {
        notifications.push({
          kind: 'notification', action: 'inbox', subject: row.subject, inbox_id: row.id,
          audit_id: row.payload?.audit_id ?? null,
          payload: truncate(JSON.stringify(row.payload ?? {}), 400),
          // A budget-blocked child is awaiting an authorized Allocator
          // transfer. Waking its parent's Orchestrator cannot fund it.
          wakes_role: CRITICAL_NOTIFICATION_SUBJECTS.has(row.subject)
            && !(row.subject === 'child-blocked' && row.payload?.code === 'BUDGET_EXHAUSTED'),
        });
      }
    }
    if (role === 'orchestrator') {
      // Each status is asked for on its own, by SQL. A node with more
      // transactions than one page used to show the model only that page, so
      // the work behind it was never dispatched.
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'DRAFT', limit: 64 })) {
        const unanswered = this.store.openIssues(id, { transaction_id: tx.id, status: 'OPEN' })
          .find(issue => !this.issueProgressed(id, issue).progressed);
        items.push(unanswered
          ? { action: 'revise-plan', transaction_id: tx.id, revision: tx.revision, issue_id: unanswered.id,
            required_change: String(unanswered.required_change ?? '').slice(0, 300),
            write_scope: tx.inputs?.write_scope ?? [], acceptance_criteria: tx.acceptance_criteria }
          : { action: 'dispatch', transaction_id: tx.id, objective: tx.objective.slice(0, 120), revision: tx.revision });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'REJECTED', limit: 32 })) {
        const unanswered = this.store.openIssues(id, { transaction_id: tx.id, status: 'OPEN' })
          .find(issue => !this.issueProgressed(id, issue).progressed);
        items.push(unanswered
          ? { action: 'correct-result', transaction_id: tx.id, revision: tx.revision, issue_id: unanswered.id,
            required_change: String(unanswered.required_change ?? '').slice(0, 300),
            write_scope: tx.inputs?.write_scope ?? [], acceptance_criteria: tx.acceptance_criteria }
          : { action: 'replan-or-redispatch', transaction_id: tx.id, revision: tx.revision, objective: tx.objective.slice(0, 120) });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'BLOCKED', limit: 32 })) {
        items.push({ action: 'escalate-or-unblock', transaction_id: tx.id, revision: tx.revision });
      }
      for (const tx of this.store.listTransactions({ cluster_id: id, node_id: node.id, status: 'SUBMITTED', limit: 32 })) {
        // Validation is about a parent's *own* result: while its delegated work is
        // open, the honest action is `aggregate`, not accepting the parent's answer.
        if (this.store.parentsAwaitingChildren(id, node.id).includes(tx.id)) continue;
        items.push({ action: 'validate', transaction_id: tx.id, revision: tx.revision, objective: tx.objective.slice(0, 120) });
      }
      for (const row of this.store.aggregatableParents(id, node.id, { limit: 32 })) {
        items.push({ action: 'aggregate', transaction_id: row.parent_id, children: Number(row.children) });
      }
      if (node.delegated_transaction_id) {
        const delegated = this.store.getTransaction(node.delegated_transaction_id);
        // Submission and validation can need a parent notification. Once the
        // delegated result is ACCEPTED, its parent already reads that durable
        // status through aggregatableParents; offering report-to-parent on
        // every tick made a completed child spend three idle Orchestrator turns
        // and become BLOCKED while its Auditor was still closing health.
        if (delegated && ['SUBMITTED', 'VALIDATING'].includes(delegated.status)) {
          items.push({ action: 'report-to-parent', transaction_id: delegated.id, status: delegated.status });
        }
      }
      if (!items.length && this.store.countTransactions(id, { node_id: node.id }) === 0) {
        items.push({ action: 'decompose', transaction_id: node.delegated_transaction_id ?? null, note: 'node has no transactions yet' });
      }
      if (!node.parent_id && !this.store.get(
        "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        id, node.id,
      )) {
        const total = this.store.countTransactions(id, { parent_transaction_id: null });
        const accepted = this.store.countTransactions(id, { parent_transaction_id: null, status: ['ACCEPTED'] });
        if (total > 0 && accepted === total) {
          items.push({ action: 'finish_cluster', note: 'all root transactions are ACCEPTED; complete outstanding cluster-objective work before requesting closure' });
        }
      }
    } else if (role === 'allocator') {
      // Delegated parents are Orchestrator aggregation work, even after the
      // last child is accepted. The Worker frontier only includes leaf work.
      const owesChild = node.delegated_transaction_id && this.pendingDelegationInstruction(cluster, node)
        ? node.delegated_transaction_id : null;
      const unallocated = this.store.all(
        `SELECT id, revision FROM transactions t
          WHERE t.cluster_id=? AND t.node_id=? AND t.status='READY'
            AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.transaction_id = t.id AND a.status='ACTIVE')
            AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.cluster_id=t.cluster_id AND c.parent_transaction_id=t.id)
          ORDER BY t.priority DESC, t.created, t.id LIMIT 32`, id, node.id,
      ).filter(row => row.id !== owesChild);
      // A hint the node cannot execute is not work. `allocate_agent` fails at the
      // child ceiling, so offering it to a full node booked three no-progress
      // Allocator turns and then blocked the node for stagnation — while the
      // Workers that would have freed a slot were still waiting on the Auditor.
      // The ceiling is the same one `createWorkerForTransaction` enforces.
      const occupiedChildren = this.store.childrenOf(node.id).filter(child => child.status !== 'RELEASED').length;
      const childCeiling = node.max_children ?? cluster.limits.max_children;
      const freeSlots = Math.max(0, childCeiling - occupiedChildren);
      if (unallocated.length && freeSlots > 0) {
        items.push({
          action: 'allocate_agent',
          transactions: unallocated.slice(0, freeSlots).map(row => row.id),
          count: Math.min(unallocated.length, freeSlots),
          free_slots: freeSlots,
          // What the window can fill *now* is not what the node still owes: a
          // caller that can see only the executable slice cannot tell a node
          // that is nearly done from one that is about to run out of the
          // capacity its remaining work needs.
          unallocated_total: unallocated.length,
        });
      }
      const releasable = this.store.allocationsForNode(node.id, { status: 'ACTIVE' }).filter(allocation => {
        const tx = allocation.transaction_id ? this.store.getTransaction(allocation.transaction_id) : null;
        return !tx || ['ACCEPTED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(tx.status)
          || (this.store.allocationOutdated(id, allocation) && !this.activeTurnFor(allocation.agent_id));
      });
      if (releasable.length) items.push({ action: 'release_agent', allocations: releasable.map(a => a.id).slice(0, 64) });
      const nodeBudget = this.store.budgetForScope(id, 'node', node.id);
      {
        // §11's load producer, made concrete: capacity out of reach of the branch
        // that needs it is a *rebalance*, which the design gives to the Allocator.
        // The hint must be executable by the identity that receives it, and
        // `rebalance_budget` permits an actor to move capacity only *within its own
        // domain* — so a subtree that is short is named to the ancestor whose
        // allocator owns both ends, never to the short subtree's own allocator,
        // which would get a 403 for the source it was told to use.
        const within = this.store.nodesInSubtree(id, node.id).map(entry => entry.id);
        // Idle capacity is not only on node scopes: the roles of a rich node hold
        // their grants, and that is exactly where it sat when a child branch was
        // refused — measured: the root node's three roles held 96, 78 and 59
        // requests with 26, 19 and 18 spent, while a depth-1 node was refused at
        // 4/4. Naming those grants as sources is what makes the hint worth acting
        // on; the Allocator still decides.
        const budgets = new Map();
        for (const row of this.store.listBudgets(id, {})) {
          // Only scopes this allocator owns: its own node and the subtree below.
          if (row.scope_kind === 'node') {
            if (within.includes(row.scope_id)) budgets.set(row.scope_id, row);
          }
          else if (row.scope_kind === 'agent') {
            const agent = this.store.getAgent(row.scope_id);
            if (agent && within.includes(agent.node_id)) budgets.set(row.scope_id, { ...row, via_node_id: agent.node_id });
          }
        }
        // Every dimension a role spends, tool calls included: a node can be out of
        // tools while its tokens and requests are untouched (measured: 35 tool-call
        // refusals across five identities, with 7,700 tool-call quota unspent
        // cluster-wide), and a hint that ignores the exhausted dimension cannot be
        // acted on.
        const headroomOf = row => ({
          scope_kind: row.scope_kind === 'agent' ? 'agent' : 'node', scope_id: row.scope_id,
          node_id: row.node_id ?? row.via_node_id ?? null,
          tokens: Math.max(0, row.tokens_limit - row.tokens_spent - row.tokens_reserved),
          model_requests: Math.max(0, row.requests_limit - row.requests_spent - row.requests_reserved),
          tool_calls: Math.max(0, row.tool_calls_limit - row.tool_calls_spent - row.tool_calls_reserved),
        });
        const enough = row => row.tokens > 4 * Math.max(16_384, Number(this.config?.context?.role ?? 8192) * 2)
          || row.model_requests > 4 || row.tool_calls > 16;
        const spenders = ['tokens', 'model_requests', 'tool_calls'];
        for (const candidate of within) {
          const short = budgets.get(candidate);
          if (!short) continue;
          const owner = this.store.getNode(candidate);
          if (owner?.kind !== 'management' || owner.status !== 'BLOCKED') continue;
          // A zero balance has no request size. Waking an ancestor to fund it
          // led to repeated one-token transfers; admission will first try the
          // local grant and record an exact refusal if the node really cannot
          // run. Only then may the ancestor move capacity across subtrees.
          const stopped = this.store.get(
            `SELECT data FROM events WHERE cluster_id=? AND type='node-blocked'
              AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1`, id, candidate);
          const block = stopped ? JSON.parse(stopped.data) : null;
          if (block?.code !== 'BUDGET_EXHAUSTED') continue;
          const required = {
            tokens: Math.max(0, Number(block.envelope?.tokens ?? (block.dimension === 'tokens' ? block.requested : 0)) || 0),
            model_requests: Math.max(0, Number(block.envelope?.model_requests ?? (block.dimension === 'model_requests' ? block.requested : 0)) || 0),
            tool_calls: Math.max(0, Number(block.envelope?.tool_calls ?? (block.dimension === 'tool_calls' ? block.requested : 0)) || 0),
          };
          if (!spenders.some(key => dimensionAvailable(short, key) < required[key])) continue;
          const sources = [...budgets.keys()]
            .filter(other => other !== candidate)
            .map(other => budgets.get(other))
            .filter(row => row && enough(headroomOf(row)))
            .map(headroomOf)
            .sort((a, b) => (b.tokens + b.model_requests * 16_384) - (a.tokens + a.model_requests * 16_384))
            .slice(0, 3);
          if (!sources.length) continue;
          items.push({
            action: 'rebalance_budget', to: { kind: 'node', id: candidate }, from_options: sources,
            required,
            note: 'a node with actionable local work cannot afford its next request; fund the full refused envelope',
          });
          break;
        }
      }
      const required = this.#requiredDelegation(cluster, node);
      const have = this.store.childrenOf(node.id).filter(child => child.kind === 'management').length;
      if (have < required.length) {
        const instruction = required[have];
        items.push({
          action: 'spawn_management_node',
          node_id: node.id,
          instruction: {
            scope: instruction.scope, objective: instruction.objective,
            max_children: instruction.max_children, spawn_children: instruction.spawn_children,
            budget: instruction.budget ?? null,
          },
          note: 'the topology fixture requires this management child; call flow_allocation spawn_management_node with scope, max_children and spawn_children from this instruction',
        });
      }
      // Only an unfinished Worker's *owner* can fund it, and a declared
      // per-Worker request allowance is a ceiling, not a request for a top-up.
      const starved = this.store.all(
        `SELECT b.scope_id AS agent_id FROM budgets b
           JOIN agents a ON a.id = b.scope_id
           JOIN allocations al ON al.agent_id = a.id AND al.status='ACTIVE'
           JOIN transactions t ON t.id = al.transaction_id
          WHERE b.cluster_id=? AND b.scope_kind='agent' AND al.node_id=? AND a.status<>'TERMINATED'
            AND a.role='worker' AND t.status IN ('READY','RUNNING')
            AND (b.requests_limit - b.requests_reserved - b.requests_spent) <= 0
          LIMIT 16`, id, node.id).map(row => row.agent_id)
        .filter(agentId => !cluster.limits?.worker_model_requests
          || this.store.countWorkerRequests(id, agentId) < cluster.limits.worker_model_requests);
      if (starved.length && nodeBudget && dimensionAvailable(nodeBudget, 'model_requests') > 0) {
        items.push({ action: 'rebalance_budget', starved_agents: starved, from: { kind: 'node', id: node.id } });
      }
    } else if (role === 'auditor') {
      const auditorId = recipient;
      const healthId = `${id}:${node.id}:final`;
      const requested = this.store.get('SELECT id FROM health WHERE id=? AND cluster_id=?', healthId, id);
      if (requested && !this.#finalHealthDecision(id, node.id, auditorId)) {
        return [{
          action: 'evaluate_health', evaluation_window: 'subtree-close',
          node_id: node.id, dimensions: this.healthMetricNames(),
          signals: this.healthSignals(id, { windowMs: this.config.staleMs }),
        }, ...notifications];
      }
      // Validation is the acceptance gate; advisory plan reviews must not fill
      // its entire eight-item page while finished Worker results wait behind
      // them. Keep the same keyset rotation within each kind, and return to the
      // oldest pending item of that kind when its cursor has passed the end.
      // A capacity probe only reads; #startTurn moves the cursor on admission.
      const cursor = this.#auditCursor.get(node.id) ?? null;
      let pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'validation', limit: 8, after: cursor });
      if (!pending.length && cursor) {
        pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'validation', limit: 8 });
      }
      if (!pending.length) {
        pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'plan', limit: 8, after: cursor });
        if (!pending.length && cursor) {
          pending = this.store.pendingAudits(id, { node_id: node.id, kind: 'plan', limit: 8 });
        }
      }
      for (const audit of pending) {
        // The facts the verdict is *about*, carried with the action: a plan audit that
        // arrives without its transaction's criteria invites the Auditor to assume there
        // are none — measured: an issue claiming `acceptance_criteria is empty` for a
        // transaction that carries two, followed by the model's own retraction. The item
        // names what is being judged, not only where to look.
        const subject = this.store.getTransaction(audit.transaction_id);
        items.push({
          action: audit.kind === 'plan' ? 'inspect_plan' : 'inspect_validation',
          audit_id: audit.id, transaction_id: audit.transaction_id, target_revision: audit.target_revision,
          objective: subject ? String(subject.objective ?? '').slice(0, 200) : null,
          acceptance_criteria: subject ? (subject.acceptance_criteria ?? []) : [],
          expected_output: subject ? String(subject.expected_output ?? '').slice(0, 200) : null,
        });
      }
      // A Worker that submits "blocked" instead of attempting a forbidden effect
      // has supplied evidence of an unsatisfied result, not a write-refused event.
      // Keep that original revision visible after the Orchestrator adjusts the
      // plan: an independent Auditor can still open and verify the correction.
      const blockedResults = this.store.all(
        `SELECT e.seq, e.data FROM events e
          WHERE e.cluster_id=? AND e.type='result-submitted'
            AND json_extract(e.data,'$.node_id')=?
            AND json_extract(e.data,'$.result_completed')=0
            -- A later plan revision may be the issue's target even though the
            -- original blocked Worker event retains its own earlier revision.
            -- Match the issue-opened event *after* that result, so an old issue
            -- does not hide a genuinely new blocked Worker attempt.
            AND NOT EXISTS (
              SELECT 1 FROM issues i
                JOIN events opened ON opened.cluster_id=i.cluster_id AND opened.type='issue-opened'
                  AND json_extract(opened.data,'$.issue_id')=i.id AND opened.seq>e.seq
               WHERE i.cluster_id=e.cluster_id
                 AND i.transaction_id=json_extract(e.data,'$.transaction_id')
                 AND i.target_revision>=json_extract(e.data,'$.revision'))
          ORDER BY e.seq DESC LIMIT 8`, id, node.id);
      for (const row of blockedResults) {
        const result = JSON.parse(row.data);
        const tx = this.store.getTransaction(result.transaction_id);
        if (!tx || TRANSACTION_TERMINAL.has(tx.status)) continue;
        items.push({
          action: 'request_correction', transaction_id: tx.id,
          target_revision: result.revision, result_status: result.result_status,
          reason: 'the Worker submitted a result explicitly marked incomplete',
          required_change: 'correct the plan or allocation so the Worker can satisfy the transaction acceptance criteria',
        });
      }
      // A refused write is the owning management node's Auditor's work, not
      // every ancestor's: exposing one Worker refusal to the whole subtree
      // opened several independent issues for one denied effect.
      const refusals = this.store.all(
        `SELECT e.seq, e.data, a.transaction_id FROM events e
           JOIN allocations a ON a.cluster_id=e.cluster_id
             AND a.agent_id=json_extract(e.data,'$.agent_id')
           JOIN transactions t ON t.id=a.transaction_id AND t.cluster_id=e.cluster_id
          WHERE e.cluster_id=? AND e.type='write-refused' AND t.node_id=?
          ORDER BY e.seq DESC LIMIT 8`,
        id, node.id,
      );
      // Only refusals nobody has taken up yet: a handled refusal must not reopen the
      // same issue on every pass, while a genuinely new refusal still surfaces.
      const handled = new Set(this.store.all(
        "SELECT json_extract(data,'$.seq') AS seq FROM events WHERE cluster_id=? AND type='refusal-handled'",
        id,
      ).map(row => Number(row.seq)));
      const seenRefusals = new Map();
      for (const refusal of refusals) {
        const data = JSON.parse(refusal.data);
        const transactionId = refusal.transaction_id ?? null;
        if (!transactionId || handled.has(Number(refusal.seq))) continue;
        // Several denied attempts by one allocation have one corrective decision.
        // Keep every sequence on that decision so committing it acknowledges all
        // the refusals it saw, rather than reopening the same issue next turn.
        const previous = seenRefusals.get(transactionId);
        if (previous) {
          previous.refusal_seqs.push(refusal.seq);
          continue;
        }
        // The action must be executable in the state the transaction is really in.
        // Before a result is submitted there is no validation audit, a rejected
        // `validate` leaves its audit OVERRIDDEN (so `inspect_validation` answers
        // deduped and opens nothing), and `request_replan` transitions to DRAFT —
        // which a terminal transaction forbids. A failed branch is escalated, not
        // replanned.
        const transaction = this.store.getTransaction(transactionId);
        if (!transaction) continue;
        const refusalSeqs = [refusal.seq];
        const item = { refusal_seqs: refusalSeqs };
        seenRefusals.set(transactionId, item);
        const terminal = ['FAILED', 'CANCELLED', 'ACCEPTED', 'SUPERSEDED'].includes(transaction.status);
        const note = `a write with ${data.tool ?? 'a tool'} was refused under the current plan: ${String(data.reason ?? '').slice(0, 200)}`;
        Object.assign(item, terminal
          ? {
            // A terminal transaction cannot be replanned or blocked again: the
            // escalation that no status forbids is the *node-level* one, which records
            // the refusal for the domain above without touching the transaction.
            action: 'escalate', node_id: transaction.node_id, transaction_id: transactionId,
            refusal_seq: refusal.seq, tool: data.tool ?? null, status: transaction.status,
            reason: note, note,
          }
          : {
            action: 'request_replan', transaction_id: transactionId, refusal_seq: refusal.seq,
            tool: data.tool ?? null, status: transaction.status,
            reason: note, required_change: 'widen the write scope and re-allocate before resubmitting',
            note,
          });
        items.push(item);
      }
      // An open issue is review work, not an automatic verdict. A later plan
      // revision or validation is evidence of activity, never evidence that the
      // required change was satisfied; an unchanged issue may also be a real
      // defect awaiting its Orchestrator rather than a mistaken report.
      for (const issue of this.#issuesAwaitingVerdict(id, node.id, agent)) {
        items.push({
          action: 'review_issue', issue_id: issue.id, transaction_id: issue.transaction_id,
          changed_since_issue: issue.progressed,
          required_change: String(issue.required_change ?? '').slice(0, 200),
          severity: issue.severity ?? null,
          review: issue.progressed
            ? 'A later transaction revision exists. Re-check the recorded criterion and new evidence before deciding whether it addresses this issue.'
            : 'No durable correction exists. Re-check the original claim: leave a genuine issue open for the Orchestrator; dismiss only a mistaken claim with contrary evidence.',
        });
      }
    }
    // Notifications ride along with work rather than replacing it — an inbox-only
    // turn manufactured 107 Allocator turns in one run — with one exception: a
    // *critical* message is governance work, and an otherwise-idle role must
    // still be woken to handle and consume it. The noisy subjects (`load-changed`,
    // the context notices) are coalesced at their producer and never wake a role
    // on their own.
    if (items.length) return [...items, ...notifications];
    const critical = notifications.filter(item => item.wakes_role);
    return critical;
  }

  /**
   * Open issues that have something to verify: the transaction they name made
   * durable progress past the revision the issue was raised against. An issue
   * nobody has answered yet is waiting for the Orchestrator, not for the Auditor.
   */
  #issuesAwaitingVerdict(clusterId, nodeId, agent = null) {
    // Every OPEN issue is a candidate verdict, with a hint about which verdict the state
    // supports: a correction that moved the transaction can be verified, while an issue
    // *nothing* has changed for may still be dismissed when the Auditor re-checks and finds
    // no defect. Filtering the unprogressed ones out entirely made the dismissal
    // unreachable — the Auditor had no work for the issue it had raised in error, and its
    // only exit was the escalation that stopped the domain.
    //
    // The unprogressed candidate is *one-shot*, though: it is offered while the issue is
    // newer than this Auditor's last turn, so a genuine issue nothing has changed for does
    // not queue an endless stream of Auditor turns (which would burn its turn budget and
    // stop the node for stagnation). A repair re-arms it through the ordinary
    // `progressed` path.
    const lastTurnSeq = agent ? Number(this.store.get(
      `SELECT MAX(seq) AS seq FROM events WHERE cluster_id=? AND type='turn-start'
        AND json_extract(data,'$.agent_id')=?`, clusterId, agent.id)?.seq ?? 0) : 0;
    const opened = new Map(this.store.all(
      "SELECT json_extract(data,'$.issue_id') AS issue_id, seq FROM events WHERE cluster_id=? AND type='issue-opened'",
      clusterId,
    ).map(row => [row.issue_id, Number(row.seq)]));
    return this.store.openIssues(clusterId, { node_id: nodeId, status: 'OPEN' })
      .map(issue => ({ ...issue, progressed: this.issueProgressed(clusterId, issue).progressed }))
      .filter(issue => {
        if (issue.progressed) {
          return !this.store.issueHasIncompleteWorkerResult(clusterId, issue)
            || this.store.issueHasNewWorkerEvidence(clusterId, issue);
        }
        if (Number(issue.corrections ?? 0) !== 0 || issue.reviewed_revision || (opened.get(issue.id) ?? 0) < lastTurnSeq) return false;
        // Only a mistaken observation can be withdrawn without a correction.
        // A guard-confirmed denied write on unfinished work is still a defect,
        // so offering a dismissal here sends the Auditor into a false verdict.
        if (this.store.issueHasIncompleteWorkerResult(clusterId, issue)) return false;
        return !this.store.hasConfirmedWriteRefusal(clusterId, issue.transaction_id, issue.evidence)
          || this.store.getTransaction(issue.transaction_id)?.status === 'ACCEPTED';
      });
  }

  /**
   * Whether the issue's transaction made durable progress past the revision the
   * issue was raised against — the one thing a verdict can be about.
   *
   * Two corrections are real, and the predicate has to recognise both or a
   * fulfilled request becomes unverifiable:
   *
   * * a **plan** correction: the transaction was adjusted at a later revision;
   * * a **revalidation**: `validate` recorded a new validation at a later
   *   result revision (`request_revalidation → validate` never emits
   *   `transaction-adjusted`, so reading only that left the Auditor unable to
   *   close the very issue the re-run answered).
   *
   * `issue.corrections` is deliberately not evidence: it advances when a verdict
   * *fails*.
   */
  issueProgressed(clusterId, issue, { since = 'reviewed' } = {}) {
    const target = Number(issue.target_revision ?? 0);
    // Each verdict binds to the revision it reviews: `reviewed_revision` is written when a
    // failed verdict charges a round, so reviewing the *same* correction twice costs
    // nothing and a second charge needs a second repair. Without it, one adjustment
    // followed by two rejection calls spent both rounds and blocked the node although
    // only one repair had been attempted.
    // Closing a round needs only that *something* changed since the issue was raised;
    // charging another round needs a correction later than the one already reviewed.
    const reviewed = Number(issue.reviewed_revision ?? 0);
    const lowest = since === 'raised' ? target : Math.max(target, reviewed);
    const adjustment = this.store.get(
      "SELECT MAX(CAST(json_extract(data,'$.revision') AS INTEGER)) AS revision FROM events WHERE cluster_id=? AND type='transaction-adjusted' AND json_extract(data,'$.transaction_id')=?",
      clusterId, issue.transaction_id,
    );
    const validation = this.store.get(
      "SELECT MAX(CAST(json_extract(data,'$.result_revision') AS INTEGER)) AS revision FROM events WHERE cluster_id=? AND type='validation-proposed' AND json_extract(data,'$.transaction_id')=?",
      clusterId, issue.transaction_id,
    );
    // The *latest* eligible revision across both streams: returning on the adjustment
    // first recorded a lower revision, and the later validation — which already existed
    // before the first verdict — was then discovered on the second call and charged a
    // round with no intervening work.
    const adjusted = Number(adjustment?.revision ?? 0);
    const revalidated = Number(validation?.revision ?? 0);
    const latest = Math.max(adjusted, revalidated);
    if (latest <= lowest) return { progressed: false, how: null };
    return {
      progressed: true,
      how: adjusted >= revalidated ? 'plan-adjusted' : 'revalidated',
      revision: latest,
    };
  }

  #auditCursor = new Map();
  /** Structured refusals per cluster, so a pass can tell "nothing to do" from
   *  "everything was refused". */
  #refusals = new Map();

  #rolePrompt(cluster, node, agent, role, pending, messages = []) {
    // The prompt carries *references* and the actions to take, never the whole
    // tree: a management session that inlines every transaction and every
    // budget row each turn is what made one orchestrator turn cost tens of
    // thousands of tokens. The model can read any of it on demand with
    // `flow_query`.
    const statusCounts = Object.fromEntries(
      this.store.countTransactionsByStatus(cluster.id, { nodeId: node.id }).map(row => [row.status, Number(row.c)]),
    );
    const actions = pending.filter(item => item.kind !== 'notification');
    const recent = role === 'auditor' && actions.length
      ? [] : this.store.listTransactions({ cluster_id: cluster.id, node_id: node.id, limit: 20 });
    const openIssues = role === 'auditor' && actions.length
      ? [] : this.store.openIssues(cluster.id, { node_id: node.id, status: 'OPEN' });
    // The prompt carries the role's own decisions *and* the notifications it
    // must answer, in separate fields: a queue of eight notifications must never
    // push the decision it exists to prompt out of the prompt.
    // The decisions themselves carry current criteria and issues. An Auditor
    // with decisions to make need not receive the same transactions, issues,
    // topology and budget as another copy of the queue on every resumed turn.
    const auditIds = new Set(actions.map(item => item.audit_id).filter(Boolean));
    const notifications = pending.filter(item => item.kind === 'notification'
      && !(item.audit_id && auditIds.has(item.audit_id)
        && (item.subject === 'plan-audit-requested' || item.subject === 'validation-audit-requested')));
    const nodeBudget = this.store.budgetForScope(cluster.id, 'node', node.id);
    // The initial turn establishes the node's objective and delegation
    // contract; its native session (and genuine checkpoints) retain them.
    // Later turns carry current actions instead of repeating the full
    // objective. The authoritative scope remains queryable by node id.
    const scope = node.scope ?? {};
    const initialScope = agent.turns === 0;
    const digest = {
      cluster: { id: cluster.id, status: cluster.status },
      node: {
        id: node.id, depth: node.depth,
        scope: initialScope ? {
          objective: scope.objective,
          ...(scope.spawn_children === undefined ? {} : { spawn_children: scope.spawn_children }),
          ...(scope.delegation_contract ? { delegation_contract: scope.delegation_contract } : {}),
          ...(scope.delegation_entry?.inputs ? { inputs: scope.delegation_entry.inputs } : {}),
        } : {
          ...(actions.some(action => action.action === 'spawn_management_node') && scope.spawn_children !== undefined
            ? { spawn_children: scope.spawn_children } : {}),
        },
        delegated_transaction_id: node.delegated_transaction_id, max_children: node.max_children,
      },
      ancestors: this.managementAncestors(cluster.id, node.id),
      pending_actions: actions.slice(0, 8),
      unread_notifications: notifications.slice(0, 8),
      transactions: {
        by_status: statusCounts,
        ...(recent.length ? { recent: recent.map(tx => ({
          id: tx.id, status: tx.status, revision: tx.revision, parent: tx.parent_transaction_id,
          priority: tx.priority,
        })) } : {}),
      },
      issues: openIssues.slice(0, 8).map(issue => ({
        id: issue.id, transaction_id: issue.transaction_id, severity: issue.severity,
        required_change: issue.required_change.slice(0, 200),
      })),
      ...(role === 'auditor' && actions.length ? {} : {
        children_of_node: this.store.childrenOf(node.id).slice(0, 16)
          .map(child => ({ id: child.id, kind: child.kind, status: child.status, depth: child.depth })),
      }),
      // A turn only needs available capacity to choose its next action; the
      // full ledger (including scope ids and reservations) is a flow_query away.
      ...(role === 'auditor' && actions.length ? {} : {
        budget_available: nodeBudget ? {
          tokens: dimensionAvailable(nodeBudget, 'tokens'),
          model_requests: dimensionAvailable(nodeBudget, 'model_requests'),
          tool_calls: dimensionAvailable(nodeBudget, 'tool_calls'),
          agents: dimensionAvailable(nodeBudget, 'agents'),
          max_active_agents: dimensionAvailable(nodeBudget, 'max_active_agents'),
        } : null,
        limits: cluster.limits,
      }),
      // Health scoring needs measured signals, not a generic full-domain digest.
      ...(role === 'auditor' && actions.some(action => action.action === 'evaluate_health')
        ? { health: this.#healthDigest(cluster.id) } : {}),
    };
    return [
      `Role: ${role}. Node: ${node.id} (depth ${node.depth}). Agent id: ${agent.id}.`,
      `Workspace: ${cluster.workspace}`,
      '',
      ...(messages.length ? [renderMessages(messages), ''] : []),
      'Current domain state (read anything else with flow_query; every list answers with items/total/next_offset):',
      JSON.stringify(digest),
      '',
      `Perform the pending actions now using the ${ROLE_TOOL[role]} tool, one call per state change.`,
      'Finish your reply with a single line "STATUS: <one sentence>" describing what you changed. Do not claim success for an action you did not actually perform.',
    ].join('\n');
  }

  #workerPrompt(cluster, tx, allocation, messages = []) {
    return [
      WORKER_PROMPT_HEADER,
      '',
      `Transaction id: ${tx.id}`,
      `Objective: ${tx.objective}`,
      tx.expected_output ? `Expected output: ${tx.expected_output}` : '',
      tx.acceptance_criteria.length ? `Acceptance criteria:\n${tx.acceptance_criteria.map(c => `- ${c}`).join('\n')}` : '',
      tx.constraints.length ? `Constraints:\n${tx.constraints.map(c => `- ${c}`).join('\n')}` : '',
      Object.keys(tx.inputs).length ? `Inputs:\n${JSON.stringify(tx.inputs, null, 1).slice(0, 4000)}` : '',
      ...(messages.length ? [renderMessages(messages), ''] : []),
      `Workspace root: ${cluster.workspace}`,
      allocation.write_scope.length ? `You own these paths (do not write outside them): ${allocation.write_scope.join(', ')}` : 'You own no file paths; do not write files.',
      '',
      'Use the tools you have to actually perform the work, then submit the result.',
    ].filter(Boolean).join('\n');
  }

  // ------------------------------------------------- commands / handlers

  #applyCommand(cluster, actor, action, params) {
    const id = cluster.id;
    const handler = this.#handlers[action];
    if (!handler) fail(`Unknown action: ${action}`, 400);
    if (!roleAllows(actor.role ?? 'user', action) && actor.role !== 'user') fail(`Role ${actor.role} may not perform ${action}`, 403);
    const result = handler(this, cluster, actor, params, id);
    // A refusal the current turn took up is acknowledged *here*: the command that
    // commits the correction or the escalation is the one that handled it. A turn that
    // failed or did nothing never reaches this point, so the work stays pending.
    const pendingRefusals = actor.agent_id ? this.#pendingRefusals.get(actor.agent_id) : null;
    if (pendingRefusals?.length && result?.deduped !== true) {
      // A corrective action for the *same* target closes a refusal: the action the
      // pending set advertises can change with the transaction's state (a branch that
      // fails between the turn and the command moves from `request_replan` to
      // `escalate`), so the test is the target and the kind of act, never the exact
      // name — while an unrelated approval is not a correction at all.
      const corrective = new Set(['request_replan', 'revise-plan', 'escalate']);
      const matches = pendingRefusals.filter(entry => {
        if (!corrective.has(action)) return false;
        // Either target closes it: a replan carries the transaction, an escalation
        // carries the node, and requiring the transaction first made the node-level
        // escalation (which returns no transaction id) match nothing.
        const targetsTransaction = Boolean(entry.transaction_id)
          && (entry.transaction_id === result?.transaction_id || entry.transaction_id === params.transaction_id);
        const targetsNode = Boolean(entry.node_id)
          && (entry.node_id === result?.node_id || entry.node_id === params.node_id);
        return targetsTransaction || targetsNode;
      });
      if (matches.length) {
        const rest = pendingRefusals.filter(entry => !matches.includes(entry));
        if (rest.length) this.#pendingRefusals.set(actor.agent_id, rest);
        else this.#pendingRefusals.delete(actor.agent_id);
        this.store.tx(() => {
          const issue = result?.issue_id ? this.store.getIssue(result.issue_id) : null;
          if (issue?.transaction_id) {
            const refusalSeqs = matches.filter(entry => entry.transaction_id === issue.transaction_id)
              .map(entry => entry.seq).sort((a, b) => a - b);
            if (refusalSeqs.length) this.store.updateIssue(issue.id, {
              evidence: { ...issue.evidence, refusal_seqs: refusalSeqs },
            });
          }
          for (const entry of matches) {
            this.store.appendEvent(id, 'refusal-handled', {
              agent_id: actor.agent_id, role: actor.role ?? null, seq: entry.seq, action,
              issue_id: result?.issue_id ?? null,
              transaction_id: entry.transaction_id, node_id: entry.node_id,
            });
          }
        });
      }
    }
    return { revision: this.store.getCluster(id)?.revision ?? cluster.revision, ...result };
  }

  get #handlers() {
    return HANDLERS;
  }

  // helpers used by handlers
  /** Current wall clock, injectable for deterministic tests. */
  timestamp() {
    return this.store.now();
  }

  progressSeq(clusterId) {
    // One indexed MAX over the whole event table: a bounded page would stop
    // observing progress once a cluster passes the page size.
    return this.store.latestProgressSeq(clusterId, [...CLUSTER_EVENTS_SKIP_PROGRESS]);
  }

  createTransactionInternal(clusterId, node, entry, { parent = null, local = false } = {}) {
    validateText(entry.objective, 'transaction.objective', 16384);
    for (const key of ['needs', 'constraints', 'acceptance_criteria']) {
      if (entry[key] !== undefined && !Array.isArray(entry[key])) fail(`Invalid transaction.${key}`);
    }
    const tx = this.store.insertTransaction({
      id: entry.id ?? randomUUID(), cluster_id: clusterId, node_id: node.id, owner_management_id: node.id,
      parent_transaction_id: entry.parent_transaction_id ?? parent, objective: entry.objective,
      inputs: entry.inputs ?? {}, constraints: entry.constraints ?? [], expected_output: entry.expected_output ?? '',
      acceptance_criteria: entry.acceptance_criteria ?? [], needs: entry.needs ?? {},
      priority: Number.isInteger(entry.priority) ? entry.priority : 0,
      // A transaction inherits its management node's capability set unless it
      // restricts it explicitly.
      capabilities: validateCapabilities(entry.capabilities ?? node.capabilities ?? [], 'transaction.capabilities'),
      status: entry.status ?? 'DRAFT',
    });
    const nodeBudget = this.store.budgetForScope(clusterId, 'node', node.id);
    if (nodeBudget) {
      createBudget(this.store, {
        cluster_id: clusterId, scope_kind: 'transaction', scope_id: tx.id, node_id: node.id,
        parent_budget_id: nodeBudget.id, limit: {},
      });
    }
    if (local) this.store.appendEvent(clusterId, 'transaction-created', { transaction_id: tx.id, node_id: node.id, parent });
    return tx;
  }

  settledDependencies(tx) {
    const deps = this.store.dependenciesOf(tx.id);
    if (!deps.length) return true;
    return deps.every(dep => {
      const other = this.store.getTransaction(dep);
      return other && other.status === 'ACCEPTED';
    });
  }

  notifyInternal(clusterId, recipient, { subject, payload, dedupeKey = null }) {
    if (!recipient) return null;
    return this.store.insertInbox({
      id: randomUUID(), cluster_id: clusterId, recipient, subject, payload,
      // Coalescing keeps one live row per subject+subject-entity; the dedupe key
      // makes a repeated notification of the *same fact* (one revision's
      // staleness, one half-minute of saturation) a single row. It is scoped to
      // the recipient: one fact told to two roles is two notifications.
      coalesce_key: `${subject}:${payload?.transaction_id ?? payload?.issue_id ?? ''}`,
      dedupe_key: dedupeKey ? `${dedupeKey}:${recipient}` : null,
    });
  }

  /**
   * A context refusal that stopped a turn, from either shape the host can
   * produce: an exception out of the turn, or a turn that ended with the
   * refusal as its failure reason. Returns the message, or null.
   */
  contextRefusal(outcome, error, agent = null) {
    // The shape is the point: the *code* travels with the message, so the
    // durable event carries a machine-readable reason and a reader is never
    // asked to parse a sentence to find out whether a stop was a budget stop.
    // A refusal the *pre-dispatch ceiling* raises after it could not fund the
    // compaction carries `BUDGET_EXHAUSTED`, and it is recognised here too: the
    // producer's code decides the class, not the gate that noticed.
    if (error?.code === 'BUDGET_EXHAUSTED') return { message: String(error.message ?? error), code: 'BUDGET_EXHAUSTED' };
    if (error?.code === 'CONTEXT_PRESSURE') return { message: String(error.message ?? error), code: 'CONTEXT_PRESSURE' };
    const detail = outcome?.stopDetail ?? null;
    if (detail?.code === 'BUDGET_EXHAUSTED') return { message: String(detail.message ?? 'budget exhausted'), code: 'BUDGET_EXHAUSTED' };
    if (detail?.code === 'CONTEXT_PRESSURE') return { message: String(detail.message ?? 'context ceiling'), code: 'CONTEXT_PRESSURE' };
    if (typeof detail?.message === 'string' && detail.message.startsWith('BUDGET: ')) {
      return { message: detail.message, code: 'BUDGET_EXHAUSTED' };
    }
    if (typeof detail?.message === 'string' && detail.message.includes('CONTEXT_PRESSURE')) {
      return { message: detail.message, code: 'CONTEXT_PRESSURE' };
    }
    // The scoped pre-step listener rejects requests that remain over either
    // the identity budget or the provider input ceiling after compaction. The
    // rejection carries its measurements and identifies the exceeded ceiling.
    if (outcome?.stopReason === 'blocked') {
      const rejection = outcome?.stopDetail?.info?.rejection ?? null;
      if (rejection?.compaction_unfunded) {
        // The session could not be shrunk because the budget could not pay for
        // the summary: the stop is a budget stop, and it is reported as one.
        return { message: `BUDGET: the session could not be compacted — ${JSON.stringify(rejection)}`, code: 'BUDGET_EXHAUSTED' };
      }
      // A session above either sending limit whose cluster budget is spent
      // cannot fund further compaction; report the budget stop rather than
      // attributing it to a provider or context malfunction.
      const rollup = agent?.cluster_id ? rollupBudgets(this.store, agent.cluster_id) : null;
      const tokensLeft = rollup ? rollup.tokens.limit - rollup.tokens.reserved - rollup.tokens.spent : null;
      if (rollup && rollup.tokens.limit > 0 && tokensLeft <= 0 && rejection) {
        return {
          message: `BUDGET: the session could not be compacted because the cluster budget is exhausted — ${JSON.stringify(rejection)}`,
          code: 'BUDGET_EXHAUSTED',
        };
      }
      return {
        message: rejection
          ? `the step could not be sent inside its ${rejection.exceeded === 'identity' ? 'identity budget' : 'provider ceiling'}: ${JSON.stringify(rejection)}`
          : 'the step could not be sent inside its identity budget or provider ceiling, and compaction did not reduce it',
        code: 'CONTEXT_PRESSURE',
      };
    }
    return null;
  }

  #hasActiveDelegatedWork(nodes, rootId) {
    return nodes.some(node => node.id !== rootId && node.status === 'ACTIVE'
      && (node.kind === 'worker' || (node.kind === 'management' && node.delegated_transaction_id)));
  }

  blockNodeInternal(clusterId, nodeId, reason, code = null, facts = null) {
    if (!nodeId) return;
    this.store.tx(() => {
      const node = this.store.getNode(nodeId);
      if (!node || node.status === 'BLOCKED') return;
      this.store.updateNode(nodeId, { status: 'BLOCKED' });
      // The identity whose request failed is part of the record: a node stops
      // *for* something specific, and only its own record can say what the repair
      // would have to make affordable again. A refusal is not scoped to the node —
      // it names the agent, or the compaction pool.
      this.store.appendEvent(clusterId, 'node-blocked', {
        node_id: nodeId, reason, code, agent_id: facts?.agent_id ?? null,
        dimension: facts?.dimension ?? null, requested: facts?.requested ?? null,
        // The envelope a resume would have to make affordable, in every dimension
        // the request needed.
        envelope: facts?.envelope ?? null,
      });
      if (!node.parent_id) {
        // The root cannot run its own role, but a delegated child with a live
        // grant may still finish and return capacity. Do not stop the cluster
        // before that independent work has a chance to resolve the shortfall.
        if (code !== 'BUDGET_EXHAUSTED'
          || !this.#hasActiveDelegatedWork(this.store.nodesInSubtree(clusterId, nodeId), nodeId)) {
          this.blockClusterInternal(clusterId, reason, code, { node_id: nodeId });
        }
      } else {
        this.notifyInternal(clusterId, this.roleAgentOf(clusterId, node.parent_id, 'orchestrator')?.id,
          { subject: 'child-blocked', payload: { node_id: nodeId, reason, code } });
      }
    });
  }

  /**
   * Stop the whole cluster with a *coded* reason: the code is what lets a
   * reader (and the acceptance ledger) classify the stop without parsing the
   * sentence that explains it.
   */
  blockClusterInternal(clusterId, reason, code = null, facts = null) {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(cluster.status)) return;
    this.store.updateCluster(clusterId, { status: 'BLOCKED' });
    // The node whose stop became the cluster's stop: reopening must be about *that*
    // reason, not about capacity appearing anywhere.
    this.store.appendEvent(clusterId, 'cluster-blocked', { reason, code, node_id: facts?.node_id ?? null });
  }

  evaluateCompletion(clusterId) {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster || !['RUNNING', 'BLOCKED'].includes(cluster.status)) return;
    // A management node is done when its whole subtree has accepted. Its
    // closing sequence is the design's three finishing acts, in order: the
    // Orchestrator's aggregation, the Allocator's capacity return, and the
    // Auditor's final health evaluation. Only then is the node COMPLETED.
    for (const node of this.store.nodesInSubtree(clusterId, null)) {
      if (node.kind !== 'management' || node.status === 'COMPLETED' || node.status === 'CANCELLED') continue;
      const counts = Object.fromEntries(this.store.countTransactionsInSubtree(clusterId, node.id).map(row => [row.status, Number(row.c)]));
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (total === 0 || (counts.ACCEPTED ?? 0) !== total) continue;
      this.#completeManagementNode(cluster, node, total);
    }
    // Exhaustive predicates: a page of ten roots must never complete a cluster
    // that has an eleventh still running.
    const root = this.store.listNodes(clusterId, { parent_id: null })[0];
    const total = this.store.countTransactions(clusterId, { parent_transaction_id: null });
    if (total === 0) return;
    const accepted = this.store.countTransactions(clusterId, { parent_transaction_id: null, status: ['ACCEPTED'] });
    if (accepted === total) {
      // Not while a management turn is still running: the roles' closing acts
      // belong to those turns, and completing the cluster under them is what left
      // a finished run with unbooked turns and no `turn-end` record (measured:
      // a smoke run reported 0 management role turns while its Auditor had
      // approved both plans and both results were accepted). The next pass
      // retries.
      if (root?.status !== 'COMPLETED') return;
      if (this.#activeTurns.size > 0 && this.#activeTurnsForCluster(clusterId)) return;
      this.store.tx(() => {
        this.store.updateCluster(clusterId, { status: 'COMPLETED' });
        this.store.appendEvent(clusterId, 'cluster-completed', { transactions: total });
      });
      return;
    }
    const settled = this.store.countTransactions(clusterId, {
      parent_transaction_id: null, status: ['ACCEPTED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'BLOCKED'],
    });
    if (settled === total) {
      // A root transaction blocked by the same refusal that stopped its node
      // cannot be accepted by finishing other descendants. Preserve the
      // producer's code instead of replacing it with an uncoded aggregate stop.
      const root = this.store.listNodes(clusterId, { parent_id: null })[0];
      const cause = root?.status === 'BLOCKED' && this.store.get(
        "SELECT data FROM events WHERE cluster_id=? AND type='node-blocked' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
        clusterId, root.id,
      );
      const detail = cause ? JSON.parse(cause.data) : null;
      this.blockClusterInternal(clusterId, detail?.reason ?? 'root transactions did not all reach ACCEPTED',
        detail?.code ?? null, detail ? { node_id: root.id } : null);
    }
  }

  /** The three finishing acts of one management node, then its COMPLETED state. */
  /** Whether any live turn belongs to this cluster. */
  #activeTurnsForCluster(clusterId) {
    for (const agentId of this.#activeTurns.keys()) {
      const agent = this.store.getAgent(agentId);
      if (agent?.cluster_id === clusterId) return true;
    }
    return false;
  }

  /**
   * Book a finished turn exactly once.
   *
   * A node that closes while a role is mid-turn books that turn itself (see
   * `#completeManagementNode`), because the turn's own finisher may not get to
   * run before the cluster is torn down — and an unbooked turn is a turn whose
   * session the next turn would treat as a first turn. The sequence number is
   * what makes the two paths idempotent: a turn's own sequence is
   * `agent.turns + 1` when it starts, so a row already at that count has been
   * booked.
   */
  #bookTurn(agent, turnSeq, fallback) {
    const current = this.store.getAgent(agent.id);
    if (!current) return fallback;
    const booked = Number(current.turns ?? 0);
    if (Number.isInteger(turnSeq) && turnSeq > 0) return Math.max(booked, turnSeq);
    return booked + 1;
  }

  /** A closeout counts only when this node's own Auditor scored all eight metrics after its request. */
  #finalHealthDecision(clusterId, nodeId, auditorId) {
    if (!auditorId) return null;
    const marker = this.store.get('SELECT rowid FROM health WHERE id=? AND cluster_id=?',
      `${clusterId}:${nodeId}:final`, clusterId);
    if (!marker) return null;
    const scored = this.store.get(
      `SELECT h.* FROM health h WHERE h.cluster_id=? AND h.node_id=?
         AND h.evaluation_window='subtree-close' AND h.decided=1 AND h.decided_by=? AND h.rowid>?
         ORDER BY h.rowid DESC LIMIT 1`,
      clusterId, nodeId, auditorId, marker.rowid);
    const scores = scored ? decodeJson(scored.scores) : null;
    return scores && HEALTH_METRICS.every(metric => typeof scores[metric] === 'number' && Number.isFinite(scores[metric]))
      ? scored : null;
  }

  #completeManagementNode(cluster, node, total) {
    if (!node.parent_id && !this.store.get(
      "SELECT seq FROM events WHERE cluster_id=? AND type='cluster-finish-requested' AND json_extract(data,'$.node_id')=? ORDER BY seq DESC LIMIT 1",
      cluster.id, node.id,
    )) return;
    if (node.delegated_transaction_id) {
      const delegated = this.store.getTransaction(node.delegated_transaction_id);
      // A delegated assignment that is not accepted yet means the parent still
      // owes a report: finishing the node now would hide unfinished work.
      if (delegated && !['ACCEPTED', 'CANCELLED', 'SUPERSEDED'].includes(delegated.status)) return;
    }
    // The node's own roles finish first. Their closing acts are *theirs* (the
    // Allocator returns capacity, the Auditor evaluates, the Orchestrator
    // aggregates), so a node that closed while one of them was mid-turn either
    // aborted that act or cut it off at teardown — measured: a smoke run whose
    // cluster completed mid-turn recorded no management `turn-end` at all, and
    // the roles' own turn counts stayed zero. Returning here leaves the cluster
    // running; the next scheduling pass retries (a hung turn is still bounded by
    // `#abortHungTurns`).
    const liveRoles = ['orchestrator', 'allocator', 'auditor']
      .map(role => this.roleAgentOf(cluster.id, node.id, role))
      .filter(roleAgent => roleAgent && this.#activeTurns.has(roleAgent.id));
    if (liveRoles.length) return;
    const healthId = `${cluster.id}:${node.id}:final`;
    if (!this.store.get('SELECT id FROM health WHERE id=?', healthId)) {
      // The summary is durable before the request. Leave the Auditor's grant
      // and its parent node pool intact until the real final judgement settles.
      this.store.tx(() => {
        const summary = writeNodeSummary(this, cluster, node.id);
        this.store.insertHealth({
          id: healthId, cluster_id: cluster.id, node_id: node.id,
          evaluation_window: 'subtree-close', signals: this.healthSignals(cluster.id),
          scores: {}, weights: {}, decided: false, decided_by: null,
        });
        this.store.appendEvent(cluster.id, 'management-closeout-requested', {
          node_id: node.id, health_id: healthId, summary_id: summary?.id ?? null,
        });
      });
      return;
    }
    const auditor = this.roleAgentOf(cluster.id, node.id, 'auditor');
    const scored = this.#finalHealthDecision(cluster.id, node.id, auditor?.id);
    if (!scored) return;
    this.store.tx(() => {
      // Only after the Auditor's turn ends can the Allocator refund its idle
      // grant. Returning it on the request pass would make scoring impossible.
      const budget = this.store.budgetForScope(cluster.id, 'node', node.id);
      if (budget) this.reclaimAllIdleGrants(cluster.id, budget.id);
      const remaining = budget ? this.store.getBudget(budget.id) : null;
      const returned = {};
      if (remaining?.parent_budget_id) {
        for (const key of ['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents']) {
          const amount = dimensionAvailable(remaining, key);
          if (amount > 0) returned[key] = amount;
        }
        if (Object.keys(returned).length) {
          transferBudget(this.store, remaining.id, remaining.parent_budget_id, returned);
        }
      }
      for (const allocation of this.store.allocationsInSubtree(cluster.id, node.id, { status: 'ACTIVE' })) {
        this.store.updateAllocation(allocation.id, { status: 'RELEASED' });
        this.store.updateAgent(allocation.agent_id, { status: 'TERMINATED' });
      }
      const summary = this.store.latestSummary(cluster.id, { node_id: node.id });
      for (const role of ['orchestrator', 'allocator', 'auditor']) {
        const roleAgent = this.roleAgentOf(cluster.id, node.id, role);
        if (!roleAgent) continue;
        // A role that is mid-turn when its node closes is aborted *and*
        // terminated: the abort lets the turn's own finisher book it (the
        // identity keeps its status), and the termination is what stops a
        // finished cluster from hosting live identities. Without the abort the
        // turn was simply cut off at shutdown and never counted.
        this.store.updateAgent(roleAgent.id, { status: 'TERMINATED' });
      }
      this.store.updateNode(node.id, { status: 'COMPLETED' });
      this.store.appendEvent(cluster.id, 'management-node-completed', {
        node_id: node.id, transactions: total, returned_budget: returned,
        health_id: scored.id, summary_id: summary?.id ?? null,
      });
    });
  }

  cancelSubtree(clusterId, nodeId, at) {
    const nodes = nodeId ? this.store.nodesInSubtree(clusterId, nodeId) : this.store.nodesInSubtree(clusterId, null);
    const nodeIds = new Set(nodes.filter(Boolean).map(node => node.id));
    for (const tx of this.store.transactionsInSubtree(clusterId, nodeId)) {
      if (!nodeIds.has(tx.node_id)) continue;
      if (TRANSACTION_TERMINAL.has(tx.status)) continue;
      this.store.updateTransaction(tx.id, { status: 'CANCELLED' });
    }
    for (const allocation of this.store.allocationsInSubtree(clusterId, nodeId, { status: 'ACTIVE' })) {
      if (!nodeIds.has(allocation.node_id)) continue;
      this.store.updateAllocation(allocation.id, { status: 'RELEASED' });
      this.store.updateAgent(allocation.agent_id, { status: 'TERMINATED', meta: {} });
    }
    for (const agent of this.store.agentsInSubtree(clusterId, nodeId)) {
      if (!nodeIds.has(agent.node_id)) continue;
      // Allocation release above may already have marked a Worker terminal.
      // Its native turn must still be aborted before skipping persisted state.
      const turn = this.#activeTurns.get(agent.id);
      if (turn) turn.ac.abort(new Error('subtree cancelled'));
      if (AGENT_TERMINAL.has(agent.status)) continue;
      this.store.updateAgent(agent.id, { status: 'TERMINATED' });
    }
    for (const id of nodeIds) this.store.updateNode(id, { status: 'CANCELLED' });
    this.store.appendEvent(clusterId, 'subtree-cancelled', { nodes: [...nodeIds], at });
  }

  countsOf(clusterId) {
    const statusCounts = Object.fromEntries(
      this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]),
    );
    const total = Object.values(statusCounts).reduce((sumTotal, count) => sumTotal + count, 0);
    const agentsByRole = this.store.countAgentsByRole(clusterId);
    return {
      nodes: this.store.countNodes(clusterId),
      agents: agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.c), 0),
      agents_live: agentsByRole.reduce((sumTotal, row) => sumTotal + Number(row.live), 0),
      active_turns: [...this.#activeTurns.values()].filter(entry => entry.cluster_id === clusterId).length,
      transactions: total,
      ready: statusCounts.READY ?? 0,
      running: (statusCounts.DISPATCHED ?? 0) + (statusCounts.RUNNING ?? 0),
      accepted: statusCounts.ACCEPTED ?? 0,
      blocked: statusCounts.BLOCKED ?? 0,
      open_issues: this.store.openIssues(clusterId, {}).length,
    };
  }

  latestSummaryOf(clusterId, params = {}) {
    const row = params.node_id
      ? this.store.latestSummary(clusterId, { node_id: params.node_id })
      : this.store.latestSummary(clusterId, { transaction_id: params.transaction_id });
    if (row) return { ...row.data, as_of_seq: row.as_of_seq };
    return this.buildSummary(clusterId);
  }

  /** Root summary: business conclusions from accepted transactions, resources from the ledger. */
  buildSummary(clusterId) {
    // Counts come from SQL, never from the rows a page happened to hold: the
    // root summary is what a reader uses to decide whether the work is done.
    const counts = Object.fromEntries(
      this.store.countTransactionsByStatus(clusterId).map(row => [row.status, Number(row.c)]),
    );
    const total = Object.values(counts).reduce((sumTotal, count) => sumTotal + count, 0);
    const acceptedCount = counts.ACCEPTED ?? 0;
    const accepted = this.store.transactionsInSubtree(clusterId, null, { status: 'ACCEPTED' });
    const issues = this.store.openIssues(clusterId, { status: null });
    return {
      transactions: {
        total,
        progress: total - acceptedCount - (counts.CANCELLED ?? 0) - (counts.SUPERSEDED ?? 0),
        completed: acceptedCount,
        failed: (counts.FAILED ?? 0) + (counts.BLOCKED ?? 0),
      },
      conclusions: accepted.filter(tx => !tx.parent_transaction_id).map(tx => ({ transaction_id: tx.id, result: truncate(JSON.stringify(tx.result ?? null), 2000) })),
      evidence: accepted.flatMap(tx => (tx.validation?.checks ?? []).map(check => ({ transaction_id: tx.id, criterion: check.criterion, evidence: truncate(String(check.evidence ?? ''), 400) }))).slice(0, 50),
      unresolved_questions: issues.filter(issue => issue.status === 'OPEN').map(issue => ({ issue_id: issue.id, transaction_id: issue.transaction_id, required_change: truncate(issue.required_change, 300) })),
      resource_state: this.store.usageSummary(clusterId),
      management_health: {
        open_issues: issues.filter(issue => issue.status === 'OPEN').length,
        corrections: sum(issues, 'corrections'),
        blocked_nodes: this.store.all("SELECT id FROM nodes WHERE cluster_id=? AND status='BLOCKED'", clusterId).map(row => row.id),
      },
      // `confidence` is a statement about coverage, so it is derived from
      // exhaustive counts — not from the page a caller happened to read.
      confidence: total > 0 && acceptedCount === total ? 'high' : 'partial',
      as_of_seq: this.store.latestEventSeq(clusterId),
    };
  }
}

// ------------------------------------------------------------------ helpers


/**
 * How the active window is shared between supervision and work.
 *
 * A Worker waiting to run holds one slot back from the management roles; without
 * that, five management nodes with three roles each saturate a six-slot window and
 * the work never runs (measured: 26 management turns, three transactions READY
 * with ACTIVE allocations and no dependencies, and **zero** Worker turns in 1067
 * seconds). Workers then take what is left — never a negative or reserved slot.
 */
/**
 * How one scheduling pass shares the concurrency window between the two classes
 * of turn. Both directions of starvation are real and were measured:
 *
 *  - supervision filling the window left a waiting Worker nothing to run in
 *    (zero Worker turns in a 1067-second run), and
 *  - Workers filling it left management nothing to run in: with five active
 *    Workers and a sixth waiting, counting the ceiling against *all* live turns
 *    skipped every pending management role on every pass, for as long as the
 *    Worker queue stayed populated.
 *
 * So the ceiling is measured against the turns it governs — management-active
 * turns — while the Worker allowance keeps one slot back only when a management
 * turn is *owed and none is running*. A class that is already running does not
 * need an extra reservation, and one that is not owed does not take one.
 */
export function scheduleAdmission({
  window, active = 0, workerWaiting = false,
  managementActive = 0, managementPending = false,
}) {
  const total = Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
  const live = Math.max(0, Math.min(active, total));
  // A one-slot window is the case that broke this: `total - 1` for management and
  // `total - live - 1` for workers both came out zero, so neither class could ever
  // start (measured: `max_active_agents: 1` at three points in one run, with
  // management work owed and a Worker ready). A single slot goes to the class that is
  // owed it — management first, because its turns are what dispatch the rest — and
  // the reservation is only ever taken out of a window that has more than one slot to
  // share.
  const managementCeiling = total <= 1 ? total : Math.max(0, total - (workerWaiting ? 1 : 0));
  const reserveForManagement = Boolean(managementPending) && managementActive === 0 && total > 1;
  const workerSlots = Math.max(0, total - live - (reserveForManagement ? 1 : 0));
  return { managementCeiling, workerSlots, reserveForManagement };
}

function rotate(items, offset) {
  if (!items.length) return items;
  const index = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(index), ...items.slice(0, index)];
}


function scopeNodes(store, actor, clusterId) {
  if (actor.role === 'user' || !actor.node_id) return store.nodesInSubtree(clusterId, null);
  return store.nodesInSubtree(clusterId, actor.node_id);
}

// List queries carry bounded references, not every saved result, session or
// node objective. Full transaction evidence is available via the per-id
// detail query; inlining six full rows already overflowed a role's 8192 tokens.
function nodeReference(node) {
  return {
    id: node.id, parent_id: node.parent_id, path: node.path, depth: node.depth,
    kind: node.kind, status: node.status, owner_management_id: node.owner_management_id,
    max_children: node.max_children, delegated_transaction_id: node.delegated_transaction_id,
    scope: { objective: String(node.scope?.objective ?? '').slice(0, 160) },
  };
}

function agentReference(agent) {
  return {
    id: agent.id, node_id: agent.node_id, role: agent.role, status: agent.status,
    capabilities: agent.capabilities, model: agent.model, turns: agent.turns,
  };
}

function transactionReference(tx) {
  return {
    id: tx.id, node_id: tx.node_id, owner_management_id: tx.owner_management_id,
    status: tx.status, revision: tx.revision, result_revision: tx.result_revision,
    priority: tx.priority, parent_transaction_id: tx.parent_transaction_id,
    objective: tx.objective.slice(0, 160),
  };
}

function tally(items, key) {
  const out = {};
  for (const item of items) {
    const value = key(item);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

/**
 * Capture a real web_fetch receipt: the runtime, not the model, records what
 * was actually fetched, when, its hash and the returned text.
 */
function captureSource(agent, exec, result) {
  if (exec.name !== 'web_fetch') return null;
  const value = result.value;
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
  const text = typeof value.body?.content === 'string' ? value.body.content : '';
  const requestUrl = typeof exec.arguments?.url === 'string' ? exec.arguments.url : value.url;
  return {
    id: randomUUID(), cluster_id: agent.cluster_id, agent_id: agent.id, node_id: agent.node_id,
    transaction_id: agent.meta?.transaction_id ?? null,
    request_url: requestUrl, final_url: value.url, status_code: value.statusCode ?? null,
    fetched_at: Date.now(), hash: sha1(text), bytes: Buffer.byteLength(text), text: text.slice(0, 512 * 1024),
  };
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/** Background jobs a tool started are owned by this cluster; record the id. */
function jobIdOf(result) {
  const value = result?.value;
  const candidates = [value?.job?.id, value?.job_id, value?.id, value?.jobId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether a durable Session already contains one message id. The injected
 * prompt names every message id, so the Session itself is the proof of
 * admission; a session that cannot be read is not proof.
 */
async function sessionCarries(persistence, sessionId, messageId) {
  const marker = `${DELIVERY_MARKER} ${messageId} seq `;
  let handle;
  try {
    handle = await persistence.open(sessionId, 'read');
  } catch (error) {
    // "I could not look" is not "it is not there": an unreadable session leaves
    // the delivery PENDING rather than injecting a second copy.
    return { state: 'UNKNOWN', found: false, reason: `open failed: ${error?.message ?? error}` };
  }
  try {
    // Paginate: a bound that stops at the first page would report "absent" for
    // a long session and re-inject a message that was already delivered.
    const pageSize = 5_000;
    let scanned = 0;
    for (let offset = 0; offset < 500_000; offset += pageSize) {
      const page = await handle.read(offset, pageSize);
      const events = page?.events ?? [];
      scanned += events.length;
      for (const event of events) {
        // Only an *incoming* user message that carries this delivery's own
        // marker proves receipt. Matching any event's text would accept the
        // sender's tool result for the message it just sent.
        const type = String(event?.type ?? '');
        if (!/user\/message|user_message/i.test(type)) continue;
        if (JSON.stringify(event?.data ?? event).includes(marker)) return { state: 'FOUND', found: true, scanned };
      }
      if (events.length < pageSize) break;
    }
    return { state: 'ABSENT', found: false, scanned };
  } catch (error) {
    return { state: 'UNKNOWN', found: false, reason: `read failed: ${error?.message ?? error}` };
  } finally {
    try {
      await handle.close?.();
    } catch {
      /* a read handle that refuses to close is not a delivery failure */
    }
  }
}

/** Render the messages one agent received, with their stable ids. */
/**
 * The exact marker a delivery carries into the recipient's session. Proof of
 * receipt matches this, not a bare id: a sender's own tool result also contains
 * the message id it just sent, so an id-substring search would treat "I sent it"
 * as "I received it".
 */
export const DELIVERY_MARKER = '[[flow-delivery';
const deliveryMarker = row => `${DELIVERY_MARKER} ${row.message_id} seq ${row.delivery_seq}]]`;

function renderMessages(messages) {
  return [
    'Messages from other agents (answer or act on them; do not repeat them back):',
    ...messages.map(row => `- from ${row.from_agent ?? 'unknown'} ${deliveryMarker(row)}: ${String(row.content).slice(0, 2000)}`),
  ].join('\n');
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { note: 'arguments were not serialisable' };
  }
}

/** Truncate a string with an explicit marker: the reader can tell a cut from a short answer. */
function boundText(text, max = 8_000) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…[${value.length - max} chars omitted]` : value;
}

function textOfResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export { truncate, rotate, scopeNodes };
