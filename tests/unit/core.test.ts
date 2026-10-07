import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromAny } from '@total-typescript/shoehorn';

import { Context } from '@deepseek-ai/cordis';
import { ClusterStore } from '../../packages/dsh-flow/src/core/store.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import {
  authorize, toolsForCapabilities, assertTransition, scopesOverlap, validateSpec, DEFAULT_LIMITS,
  CAPABILITY_TOOLS,
} from '../../packages/dsh-flow/src/core/protocol.ts';
import {
  DIMENSIONS, createBudget, budgetView, reserveChain, settleChain, releaseChain, transferBudget,
  effectiveDeadline, exhausted, BudgetError,
} from '../../packages/dsh-flow/src/core/budget.ts';
import type { BudgetDimension, DimensionSpec } from '../../packages/dsh-flow/src/core/budget.ts';
import { communicate } from '../../packages/dsh-flow/src/core/communication.ts';
import type {
  CommunicationActor, CommunicationGroupMembersResult, CommunicationPublishResult,
  CommunicationResult, CommunicationSendResult, CommunicationSubscriptionResult,
} from '../../packages/dsh-flow/src/core/communication.ts';
import { reserveLlmRequest, settleLlmRequest, releaseLlmRequest } from '../../packages/dsh-flow/src/core/runtime.ts';
import { checkWriteAccess, canonicalScope } from '../../packages/dsh-flow/src/core/scope.ts';
import type { WriteDecision } from '../../packages/dsh-flow/src/core/scope.ts';
import type { ClusterRecord, FlowActor, FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowBudgetView, FlowJsonValue } from '../../packages/dsh-flow/src/types.ts';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';

let clock = 1_700_000_000_000;
const now = () => clock;

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

function dimensionOf(key: BudgetDimension): DimensionSpec {
  const spec = DIMENSIONS.find(candidate => candidate.key === key);
  if (!spec) throw new Error(`unknown budget dimension ${key}`);
  return spec;
}

/** The projected view of a budget row the fixture just created. */
function viewOf(store: ClusterStore, id: string): FlowBudgetView {
  const view = budgetView(store.getBudget(id));
  if (!view) throw new Error(`fixture: budget ${id} is missing`);
  return view;
}

function refusalOf(decision: WriteDecision): string {
  if (!decision.allowed) return decision.reason;
  throw new Error('expected the write to be refused');
}

function sendOf(result: CommunicationResult): CommunicationSendResult {
  if ('recipients' in result) return result;
  throw new Error('expected a send result');
}

function groupOf(result: CommunicationResult): CommunicationGroupMembersResult {
  if ('members' in result) return result;
  throw new Error('expected a group result');
}

function publishOf(result: CommunicationResult): CommunicationPublishResult {
  if ('revision' in result) return result;
  throw new Error('expected a publish result');
}

function subscriptionOf(result: CommunicationResult): CommunicationSubscriptionResult {
  if ('subscription' in result) return result;
  throw new Error('expected a subscription result');
}

function tempStore(t: TestContext): ClusterStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ClusterStore(join(dir, 'cluster.sqlite'), { now });
  t.after(() => store.close());
  return store;
}

function seedCluster(store: ClusterStore, overrides: Record<string, unknown> = {}): ClusterRecord {
  const spec = validateSpec({
    objective: 'test objective', workspace: '/tmp/ws',
    capabilities: ['fs_read', 'fs_write'], limits: { max_children: 4, max_active_agents: 4 },
    budget: { tokens: 1000, model_requests: 10, tool_calls: 100, agents: 16, max_active_agents: 4 },
    ...overrides,
  });
  return must(store.createCluster({
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    ...spec, limits: spec.limits, capabilities: spec.capabilities,
  }, spec.budget), 'cluster');
}

test('store rejects a newer schema and legacy workflow databases', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const newer = join(dir, 'newer.sqlite');
  const db = new DatabaseSync(newer);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => new ClusterStore(newer), /newer than supported/);

  const legacy = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(legacy);
  legacyDb.exec('CREATE TABLE workflows(id TEXT PRIMARY KEY)');
  legacyDb.close();
  assert.throws(() => new ClusterStore(legacy), /legacy workflow database/);
});

test('schema-2 transaction JSON inputs survive creation, updates and reopened consumer reads', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-inputs-'));
  const path = join(dir, 'cluster.sqlite');
  const open = () => new ClusterRuntime(new Context(), {
    path, dataDir: dir, autoTick: false, now,
    logger: { warn() {}, error() {}, info() {} },
  });
  let runtime = open();
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const samples: readonly FlowJsonValue[] = [
    [1, 'two', null, { nested: [false, 3] }],
    [], 'input text', '', 42, 0, true, false,
    { write_scope: [], after: [0], nested: { value: null } },
    null,
  ];
  const expected = new Map<string, FlowJsonValue>(samples.map((inputs, index) => [
    `json-input-${index}`, inputs ?? {},
  ]));
  const snapshot = runtime.start({
    objective: 'preserve transaction inputs', workspace: dir,
    capabilities: ['fs_read'],
    budget: { tokens: 100_000, model_requests: 100, tool_calls: 100, agents: 16, max_active_agents: 4 },
    initial_transactions: samples.map((inputs, index) => ({
      id: `json-input-${index}`, objective: `payload ${index}`, inputs,
    })),
  });
  const clusterId = snapshot.cluster.id;
  const root = must(runtime.store.listNodes(clusterId, { parent_id: null })[0], 'root');
  const orchestrator = must(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'orchestrator' })[0], 'orchestrator');
  const actor: FlowAgentActor = {
    cluster_id: clusterId, node_id: root.id, agent_id: orchestrator.id,
    session_id: orchestrator.session_id, role: 'orchestrator',
  };
  // Creation historically defaults both missing and explicitly null inputs to
  // {}, but an existing row containing JSON null must remain JSON null.
  const absent = runtime.createTransactionInternal(clusterId, root, { id: 'json-input-absent', objective: 'absent input' });
  assert.deepEqual(absent.inputs, {});
  expected.set(absent.id, {});
  const explicitUndefined = runtime.createTransactionInternal(clusterId, root, {
    id: 'json-input-undefined', objective: 'undefined input', inputs: undefined,
  });
  assert.deepEqual(explicitUndefined.inputs, {});
  expected.set(explicitUndefined.id, {});
  const storedNull = runtime.createTransactionInternal(clusterId, root, {
    id: 'json-input-stored-null', objective: 'historical null input',
  });
  runtime.store.run('UPDATE transactions SET inputs=? WHERE id=?', 'null', storedNull.id);
  expected.set(storedNull.id, null);

  // Array/scalar/null payloads have no object metadata. They must not prevent
  // allocation or reassignment, while an actual object write_scope remains an
  // enforced ceiling.
  const allocator = must(runtime.store.listAgents(clusterId, { node_id: root.id, role: 'allocator' })[0], 'allocator');
  const allocatorActor: FlowAgentActor = {
    cluster_id: clusterId, node_id: root.id, agent_id: allocator.id,
    session_id: allocator.session_id, role: 'allocator',
  };
  for (const id of ['json-input-0', 'json-input-2', 'json-input-8', storedNull.id]) {
    runtime.command(actor, {
      command_id: `json-dispatch-${id}`, action: 'dispatch', params: { transaction_id: id },
    });
  }
  assert.throws(() => runtime.command(allocatorActor, {
    command_id: 'json-scope-ceiling', action: 'spawn_agent',
    params: { transaction_id: 'json-input-8', write_scope: ['output'] },
  }), error => rejectionStatus(error) === 409);
  assert.equal(runtime.store.activeAllocationForTransaction('json-input-8'), null);
  runtime.command(allocatorActor, {
    command_id: 'json-allocate-array', action: 'spawn_agent',
    params: { transaction_id: 'json-input-0', write_scope: ['output'] },
  });
  const allocation = must(runtime.store.activeAllocationForTransaction('json-input-0'), 'array allocation');
  for (const id of ['json-input-2', storedNull.id]) {
    runtime.command(allocatorActor, {
      command_id: `json-reassign-${id}`, action: 'reassign_agent',
      params: { agent_id: allocation.agent_id, transaction_id: id },
    });
    const reassigned = must(runtime.store.activeAllocationForTransaction(id), 'reassigned allocation');
    assert.equal(reassigned.agent_id, allocation.agent_id);
    assert.deepEqual(reassigned.write_scope, ['output']);
  }

  runtime.command(actor, {
    command_id: 'json-create-command', action: 'create_transaction',
    params: { objective: 'command payload', inputs: ['created', { through: 'role command' }] },
  });
  const commandTx = must(runtime.store.listTransactions({ cluster_id: clusterId })
    .find(tx => tx.objective === 'command payload'), 'command-created transaction');
  expected.set(commandTx.id, ['created', { through: 'role command' }]);
  runtime.command(actor, {
    command_id: 'json-adjust-command', action: 'adjust_transaction',
    params: { transaction_id: commandTx.id, inputs: 'updated scalar' },
  });
  expected.set(commandTx.id, 'updated scalar');
  runtime.store.updateTransaction('json-input-4', { inputs: ['updated', 42] });
  expected.set('json-input-4', ['updated', 42]);
  runtime.store.updateTransaction('json-input-4', { inputs: undefined });
  assert.deepEqual(must(runtime.store.getTransaction('json-input-4'), 'updated transaction').inputs, ['updated', 42]);
  // SQL NULL is still forbidden by the historical NOT NULL column; it is not
  // interchangeable with a row whose JSON text is "null".
  assert.throws(() => runtime.store.updateTransaction('json-input-4', { inputs: null }));
  const count = runtime.store.countTransactions(clusterId);
  const cursor = runtime.store.latestEventSeq(clusterId);
  assert.throws(() => runtime.command(actor, {
    command_id: 'json-invalid-command', action: 'create_transaction',
    params: { objective: 'invalid input', inputs: { nonJson: undefined } },
  }), error => rejectionStatus(error) === 400);
  assert.equal(runtime.store.countTransactions(clusterId), count);
  assert.equal(runtime.store.latestEventSeq(clusterId), cursor);

  const checkConsumers = () => {
    const read = runtime.read(clusterId, { include_events: false });
    assert.equal(read.transactions.length, expected.size);
    const listed = runtime.store.listTransactions({ cluster_id: clusterId });
    assert.equal(listed.length, expected.size);
    for (const [id, inputs] of expected) {
      assert.deepEqual(must(runtime.store.getTransaction(id), 'stored transaction').inputs, inputs);
      assert.deepEqual(must(listed.find(tx => tx.id === id), 'listed transaction').inputs, inputs);
      assert.deepEqual(must(read.transactions.find(tx => tx.id === id), 'snapshot transaction').inputs, inputs);
      const userQuery = runtime.queryCluster(clusterId, 'transaction', { id });
      assert.equal(userQuery.what, 'transaction');
      if (userQuery.what !== 'transaction') assert.fail('transaction query tag mismatch');
      if (!('inputs' in userQuery.data.transaction)) assert.fail('user transaction inputs missing');
      assert.deepEqual(userQuery.data.transaction.inputs, inputs);
      const roleQuery = runtime.query(actor, 'transaction', { id });
      if (!('inputs' in roleQuery.transaction)) assert.fail('role transaction inputs missing');
      assert.deepEqual(roleQuery.transaction.inputs, inputs);
    }
    const transactionsQuery = runtime.queryCluster(clusterId, 'transactions', {});
    if (transactionsQuery.what !== 'transactions') assert.fail('transactions query tag mismatch');
    assert.equal(transactionsQuery.data.total, expected.size);
    assert.equal(runtime.query(actor, 'transactions').total, expected.size);
    const report = runtime.report(clusterId);
    assert.equal(report.transactions.total, expected.size);
    assert.equal(report.transactions.truncated, false);
    assert.deepEqual(new Set(report.transactions.items.map(tx => tx.id)), new Set(expected.keys()));
  };
  checkConsumers();
  await runtime.dispose();
  runtime = open();
  assert.equal(runtime.store.get('PRAGMA user_version')?.user_version, 2);
  checkConsumers();
});

test('commands are idempotent per command_id and reject a conflicting payload', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const actor: FlowAgentActor = { role: 'orchestrator', cluster_id: cluster.id, agent_id: 'a1', node_id: 'n1', session_id: 's1' };
  let applied = 0;
  const run = (params: Record<string, number>) => store.runCommand({
    cluster_id: cluster.id, command_id: 'cmd-1', actor, action: 'dispatch', params, expected_revision: 1,
  }, () => {
    applied += 1;
    return { revision: 2, value: params.n };
  });

  assert.deepEqual(run({ n: 1 }), { result: { revision: 2, value: 1 }, revision: 2, deduped: false });
  assert.deepEqual(run({ n: 1 }), { result: { revision: 2, value: 1 }, revision: 2, deduped: true });
  assert.equal(applied, 1);
  assert.throws(() => run({ n: 2 }), error => rejectionStatus(error) === 409);
});

test('events are append-only with a monotonic per-cluster cursor', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  store.tx(() => {
    store.appendEvent(cluster.id, 'one', { i: 1 });
    store.appendEvent(cluster.id, 'two', { i: 2 });
  });
  const first = store.readEvents(cluster.id, {});
  const second = store.readEvents(cluster.id, { since: must(first[0], 'event').seq });
  assert.deepEqual(first.map(e => e.type), ['one', 'two']);
  assert.deepEqual(second.map(e => e.type), ['two']);
});

test('role authorization denies cross-role writes and unknown roles', () => {
  const orchestrator: FlowAgentActor = { role: 'orchestrator', cluster_id: 'c', agent_id: 'a', node_id: 'n', session_id: 's' };
  assert.doesNotThrow(() => authorize(orchestrator, 'dispatch'));
  assert.doesNotThrow(() => authorize({ ...orchestrator, role: 'auditor' }, 'inspect_plan'));
  assert.doesNotThrow(() => authorize({ ...orchestrator, role: 'allocator' }, 'spawn_management_node'));
  // Deliberately wrong identities: a partial actor, an unknown role and no
  // actor at all — the guard must refuse each with 403 rather than trusting it.
  const denied: Array<[FlowActor, string]> = [
    [fromAny({ role: 'worker' }), 'dispatch'],
    [fromAny({ role: 'worker' }), 'accept_result'],
    [fromAny({ role: 'orchestrator' }), 'spawn_agent'],
    [fromAny({ role: 'auditor' }), 'validate'],
    [fromAny({ role: 'allocator' }), 'accept_result'],
    [fromAny({ role: 'ghost' }), 'dispatch'],
    [fromAny(undefined), 'dispatch'],
  ];
  for (const [actor, action] of denied) {
    assert.throws(() => authorize(actor, action), error => rejectionStatus(error) === 403, `${String(actor?.role)}:${action}`);
  }
});

test('worker capabilities map to host tools and reject unknown or forbidden capabilities', () => {
  assert.deepEqual(toolsForCapabilities(['fs_read'] as const), ['glob', 'grep', 'read']);
  assert.ok(toolsForCapabilities(['browser'] as const).includes('mcp__playwright-mcp__browser_snapshot'));
  assert.ok(!toolsForCapabilities(['browser'] as const).includes('mcp__playwright-mcp__browser_run_code_unsafe'));
  assert.deepEqual(Object.keys(CAPABILITY_TOOLS).sort(), ['browser', 'fs_read', 'fs_write', 'shell', 'web_fetch']);
  assert.throws(() => toolsForCapabilities(fromAny(['root'])), /Unsupported capability/);
  assert.throws(() => validateSpec({ objective: 'o', workspace: '/w', capabilities: ['subagent'] }), /Unsupported capability/);
});

test('transaction transitions reject illegal edges and allow the happy path', () => {
  assert.doesNotThrow(() => assertTransition('DRAFT', 'READY'));
  assert.doesNotThrow(() => assertTransition('SUBMITTED', 'VALIDATING'));
  assert.doesNotThrow(() => assertTransition('VALIDATING', 'ACCEPTED'));
  assert.doesNotThrow(() => assertTransition('VALIDATING', 'REJECTED'));
  assert.doesNotThrow(() => assertTransition('REJECTED', 'READY'));
  assert.throws(() => assertTransition('DRAFT', 'ACCEPTED'), /Illegal transaction transition/);
  assert.throws(() => assertTransition('ACCEPTED', 'RUNNING'), /Illegal transaction transition/);
});

test('allocation write scopes overlap by file or by directory', () => {
  assert.ok(scopesOverlap(['src/a.ts'], ['src/a.ts']));
  assert.ok(scopesOverlap(['src'], ['src/a.ts']));
  assert.ok(!scopesOverlap(['src/a.ts'], ['src/b.ts']));
  assert.ok(!scopesOverlap(['srcs'], ['src/a.ts']));
});

test('budget reserves, settles consumption and blocks an exhausted scope', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, {
    cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id,
    limit: cluster.budget, wall_limit_ms: 60_000,
  });

  reserveChain(store, [root.id], { tokens: 300, model_requests: 1 });
  assert.equal(viewOf(store, root.id).tokens.available, 700);

  settleChain(store, [root.id], { reservedAmounts: { tokens: 300, model_requests: 1 }, consumed: { tokens: 260, model_requests: 1 } });
  const after = viewOf(store, root.id);
  assert.deepEqual(
    { tokens: after.tokens, requests: after.model_requests },
    { tokens: { limit: 1000, reserved: 0, spent: 260, available: 740 }, requests: { limit: 10, reserved: 0, spent: 1, available: 9 } },
  );

  reserveChain(store, [root.id], { tokens: 700 });
  assert.throws(() => reserveChain(store, [root.id], { tokens: 41 }), error => error instanceof BudgetError && error.code === 'LIMIT_REACHED');
  releaseChain(store, [root.id], { tokens: 700 });
  assert.doesNotThrow(() => reserveChain(store, [root.id], { tokens: 740 }));
  releaseChain(store, [root.id], { tokens: 740 });
});

test('budget transfers move only unused unreserved budget and never reverse spend', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, {
    cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, wall_limit_ms: 60_000,
    limit: cluster.budget,
  });
  const child = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'n1', parent_budget_id: root.id, wall_limit_ms: 120_000 });

  store.tx(() => transferBudget(store, root.id, child.id, { tokens: 400, model_requests: 4 }));
  assert.equal(viewOf(store, child.id).tokens.limit, 400);
  assert.equal(viewOf(store, root.id).tokens.limit, 600);
  assert.throws(() => store.tx(() => transferBudget(store, root.id, child.id, { tokens: 601 })), /only 600 unused-unreserved remains/);

  store.tx(() => settleChain(store, [child.id], { consumed: { tokens: 100 } }));
  store.tx(() => reserveChain(store, [child.id], { tokens: 50 }));
  assert.throws(() => store.tx(() => transferBudget(store, child.id, root.id, { tokens: 251 })), /only 250 unused-unreserved remains/);
  assert.equal(viewOf(store, child.id).tokens.spent, 100);
});

test('wall deadlines take the earliest ancestor deadline and never reset', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, { cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, limit: cluster.budget, wall_limit_ms: 1000 });
  const child = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'n1', parent_budget_id: root.id, wall_limit_ms: 60_000 });
  store.tx(() => transferBudget(store, root.id, child.id, { tokens: 100, model_requests: 1 }));
  assert.equal(effectiveDeadline(store, must(store.getBudget(child.id), 'child budget')), now() + 1000);

  clock += 1500;
  assert.ok(exhausted(store, must(store.getBudget(child.id), 'child budget')));
  assert.throws(() => reserveChain(store, [child.id], { tokens: 1, model_requests: 1 }),
    error => error instanceof BudgetError && error.code === 'LIMIT_REACHED' && error.dimension === 'wall_time_ms');
  clock -= 1500;
});

test('provider admission refuses a second funded scope when actual usage already consumed its cluster reserve', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, { cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, limit: cluster.budget });
  const first = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'first', parent_budget_id: root.id });
  const second = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'second', parent_budget_id: root.id });
  store.tx(() => {
    transferBudget(store, root.id, first.id, { tokens: 900, model_requests: 1 });
    transferBudget(store, root.id, second.id, { tokens: 100, model_requests: 1 });
  });
  const initial = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'first-worker', node_id: 'first', transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [first.id], reservationTokens: 50, turn_seq: 1,
  });
  settleLlmRequest(store, {
    cluster_id: cluster.id, reservation: initial,
    usage: { inputTokens: 900, outputTokens: 50, totalTokens: 950 },
  });
  assert.throws(() => reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'second-worker', node_id: 'second', transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [second.id], reservationTokens: 80, turn_seq: 1,
  }), error => error instanceof BudgetError && error.code === 'LIMIT_REACHED' && error.scope === cluster.id
    && error.dimension === 'tokens' && error.requested === 80 && error.available === 50);
  assert.equal(must(store.getBudget(second.id), 'second budget').tokens_reserved, 0, 'refused requests leave no hold');
  assert.equal(store.countUsageReceipts(cluster.id, 'second-worker'), 0, 'and no dispatchable receipt');
});

test('a replayed settlement moves no budget, and an unknown outcome keeps its token hold', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, {
    cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, wall_limit_ms: 60_000,
    limit: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, agents: 16, max_active_agents: 4 },
  });
  const dimensionSnapshot = (key: BudgetDimension): { reserved: number; spent: number | undefined } => {
    const spec = dimensionOf(key);
    const row = must(store.getBudget(root.id), 'root budget');
    return { reserved: row[spec.reserved], spent: spec.spent === null ? undefined : row[spec.spent] };
  };
  const snapshot = (): Record<BudgetDimension, { reserved: number; spent: number | undefined }> => ({
    tokens: dimensionSnapshot('tokens'),
    model_requests: dimensionSnapshot('model_requests'),
    tool_calls: dimensionSnapshot('tool_calls'),
    agents: dimensionSnapshot('agents'),
    max_active_agents: dimensionSnapshot('max_active_agents'),
  });

  // Two outstanding reservations on the same scope.
  const a = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'agent-a', node_id: null, transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [root.id], reservationTokens: 10_000, turn_seq: 1,
  });
  const b = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'agent-b', node_id: null, transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [root.id], reservationTokens: 20_000, turn_seq: 1,
  });
  assert.equal(snapshot().tokens.reserved, 30_000);

  settleLlmRequest(store, {
    cluster_id: cluster.id, reservation: a, budgetIds: [root.id],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  const afterFirst = snapshot();
  assert.deepEqual({ tokens: afterFirst.tokens, requests: afterFirst.model_requests },
    { tokens: { reserved: 20_000, spent: 150 }, requests: { reserved: 1, spent: 1 } });

  // Replaying A must not touch B's reservation nor spend A's usage again.
  settleLlmRequest(store, {
    cluster_id: cluster.id, reservation: a, budgetIds: [root.id],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  assert.deepEqual(snapshot(), afterFirst, 'a replayed settlement must be a no-op');

  settleLlmRequest(store, {
    cluster_id: cluster.id, reservation: b, budgetIds: [root.id],
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  });
  const afterSecond = snapshot();
  assert.deepEqual(afterSecond.tokens, { reserved: 0, spent: 170 });
  assert.deepEqual(afterSecond.model_requests, { reserved: 0, spent: 2 });

  // An unknown outcome consumes the attempt but keeps the token hold.
  const c = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'agent-c', node_id: null, transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [root.id], reservationTokens: 5_000, turn_seq: 1,
  });
  releaseLlmRequest(store, { cluster_id: cluster.id, reservation: c, budgetIds: [root.id], dispatched: true, note: 'stream ended without usage' });
  const afterUnknown = snapshot();
  assert.deepEqual(afterUnknown.tokens, { reserved: 5_000, spent: 170 }, 'an unknown outcome must retain its token hold');
  assert.deepEqual(afterUnknown.model_requests, { reserved: 0, spent: 3 });
  assert.equal(must(store.getUsageReceipt(c.request_id), 'usage receipt').status, 'UNKNOWN');

  // A request that provably never left the client releases both dimensions.
  const d = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'agent-d', node_id: null, transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [root.id], reservationTokens: 5_000, turn_seq: 1,
  });
  releaseLlmRequest(store, { cluster_id: cluster.id, reservation: d, budgetIds: [root.id], dispatched: false, note: 'dispatch failed' });
  assert.deepEqual(snapshot().tokens, { reserved: 5_000, spent: 170 });
  assert.deepEqual(snapshot().model_requests, { reserved: 0, spent: 3 }, 'a never-sent request must not consume an attempt');
  assert.equal(must(store.getUsageReceipt(d.request_id), 'usage receipt').status, 'NOT_SENT');
});

test('write isolation is enforced on the canonical target, not the scope string', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true });
  mkdirSync(join(dir, 'src', 'data'), { recursive: true });
  mkdirSync(join(dir, 'outside'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ui', 'App.jsx'), 'export default null;\n');
  writeFileSync(join(dir, 'src', 'data', 'store.js'), 'export const x = 1;\n');
  // A symlink that looks like it stays inside the owned directory.
  symlinkSync(join(dir, 'outside'), join(dir, 'src', 'ui', 'link'));

  const owned = ['src/ui'];
  const allow = (tool: string) => checkWriteAccess({ tool, workspace: dir, writeScope: owned, arguments: tool === 'write' ? { path: 'src/ui/App.jsx' } : {} });
  assert.equal(allow('write').allowed, true, 'a file inside the owned directory is allowed');
  assert.equal(checkWriteAccess({ tool: 'edit', workspace: dir, writeScope: owned, arguments: { path: 'src/ui/New.jsx' } }).allowed, true,
    'a not-yet-existing file inside the owned directory is allowed');

  const sibling = checkWriteAccess({ tool: 'write', workspace: dir, writeScope: owned, arguments: { path: 'src/data/store.js' } });
  assert.equal(sibling.allowed, false, "a sibling's file must be refused");
  assert.match(refusalOf(sibling), /outside this allocation's write scope/);

  const escape = checkWriteAccess({ tool: 'write', workspace: dir, writeScope: owned, arguments: { path: 'src/ui/link/escaped.txt' } });
  assert.equal(escape.allowed, false, 'a symlink out of the owned directory must be refused');

  const traversal = checkWriteAccess({ tool: 'write', workspace: dir, writeScope: owned, arguments: { path: 'src/ui/../data/store.js' } });
  assert.equal(traversal.allowed, false, 'a traversing path must be refused');

  const noScope = checkWriteAccess({ tool: 'write', workspace: dir, writeScope: [], arguments: { path: 'src/ui/App.jsx' } });
  assert.equal(noScope.allowed, false, 'an allocation that owns nothing may not write');

  // Shell needs the whole workspace, exclusively.
  const shellWithout = checkWriteAccess({ tool: 'bash', workspace: dir, writeScope: owned, arguments: { command: 'touch x' } });
  assert.equal(shellWithout.allowed, false, 'a shell without the workspace lock must be refused');
  const shellWith = checkWriteAccess({ tool: 'bash', workspace: dir, writeScope: ['.'], arguments: { command: 'touch x' } });
  assert.equal(shellWith.allowed, true, 'a shell that owns the whole workspace is allowed');
  const readTool = checkWriteAccess({ tool: 'read', workspace: dir, writeScope: owned, arguments: { path: 'src/data/store.js' } });
  assert.equal(readTool.allowed, true, 'reading outside the owned scope stays allowed');
});

test('write ownership is canonical at grant time: aliases collide and dangling links are refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-alias-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true });
  mkdirSync(join(dir, 'elsewhere'), { recursive: true });
  symlinkSync(join(dir, 'src', 'ui'), join(dir, 'alias-ui'));
  symlinkSync(join(dir, 'missing-target'), join(dir, 'dangling'));

  const owned = must(canonicalScope(dir, ['src/ui']), 'owned scope');
  const alias = must(canonicalScope(dir, ['alias-ui']), 'alias scope');
  assert.deepEqual(owned, alias, 'two names for one directory must canonicalise identically');
  assert.ok(scopesOverlap(owned, alias), 'so the overlap check refuses the second lock');

  const throughAlias = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: ['src/ui'], writeScopeCanonical: owned,
    arguments: { path: 'alias-ui/App.jsx' },
  });
  assert.equal(throughAlias.allowed, true, 'writing through an alias of the owned directory is still inside it');

  // A dangling link must not be usable to create another directory's target.
  assert.equal(canonicalScope(dir, ['dangling']), null, 'a dangling symlink cannot be canonicalised');
  const danglingWrite = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: ['dangling'], writeScopeCanonical: canonicalScope(dir, ['dangling']) ?? [],
    arguments: { path: 'dangling/escaped.txt' },
  });
  assert.equal(danglingWrite.allowed, false, 'an unresolvable scope refuses every write');

  const sibling = checkWriteAccess({
    tool: 'write', workspace: dir, writeScope: ['src/ui'], writeScopeCanonical: owned,
    arguments: { path: 'elsewhere/other.ts' },
  });
  assert.equal(sibling.allowed, false, "a sibling's directory is refused");
  assert.equal(checkWriteAccess({ tool: 'write', workspace: dir, writeScope: ['.'], writeScopeCanonical: must(canonicalScope(dir, ['.']), 'root scope'), arguments: { path: 'elsewhere/other.ts' } }).allowed, true,
    'the workspace owner may write anywhere inside it');

  // Shell belongs to the workspace owner only, and an alias of the workspace
  // canonicalises to the same lock.
  assert.equal(must(canonicalScope(dir, ['.']), 'root scope')[0], must(canonicalScope(dir, ['src/..']), 'traversing scope')[0], 'a traversing alias canonicalises to the root lock');
});

test('communication validates every multicast target before delivering anything', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = must(store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' }), 'agent a1');
  const b = must(store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' }), 'agent a2');
  store.insertAgent({ id: 'a3', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's3', status: 'TERMINATED' });
  const actor: CommunicationActor = { cluster_id: cluster.id, agent_id: a.id, node_id: a.node_id, role: 'orchestrator' };

  const sent = sendOf(store.tx(() => communicate(store, cluster, actor, 'multicast', { agent: 'a2', content: 'hello' })));
  assert.deepEqual(sent.recipients, [{ recipient: b.id, delivery_seq: 1 }]);
  assert.equal(store.pendingDeliveries('a2').length, 1);
  assert.equal(must(store.pendingDeliveries('a2')[0], 'delivery').content, JSON.stringify({ text: 'hello', category: 'discussion' }));

  assert.throws(() => communicate(store, cluster, actor, 'multicast', { agent: ['a1'] }, {}), /Invalid recipient/);
  const before = store.getMessage(sent.message_id);
  assert.throws(() => store.tx(() => communicate(store, cluster, actor, 'multicast', { agent: 'a3', content: 'x' })), /TERMINATED/);
  assert.deepEqual(store.getMessage(sent.message_id), before);
  assert.throws(() => communicate(store, cluster, actor, 'send', { agent: 'a2' }), /requires content/);
});

test('resending a message id repairs deliveries without duplicating the message', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = must(store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' }), 'agent a1');
  store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' });
  const actor: CommunicationActor = { cluster_id: cluster.id, agent_id: a.id, node_id: 'n1', role: 'orchestrator' };
  const first = sendOf(store.tx(() => communicate(store, cluster, actor, 'send', { agent: 'a2', content: 'hi', message_id: 'm-1' })));
  const second = sendOf(store.tx(() => communicate(store, cluster, actor, 'send', { agent: 'a2', content: 'hi', message_id: 'm-1' })));
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.deepEqual(second.recipients, []);
  assert.equal(store.pendingDeliveries('a2').length, 1);
});

test('groups accept cross-subtree members and blackboard publishes are revision fenced', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = must(store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' }), 'agent a1');
  store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' });
  store.insertNode({ id: 'n1', cluster_id: cluster.id, parent_id: null, kind: 'management', depth: 0, status: 'ACTIVE', path: 'root' });
  store.insertNode({ id: 'n2', cluster_id: cluster.id, parent_id: 'n1', kind: 'worker', depth: 1, status: 'ACTIVE', path: 'root/n2' });
  const actor: CommunicationActor = { cluster_id: cluster.id, agent_id: a.id, node_id: 'n1', role: 'orchestrator' };

  const created = groupOf(store.tx(() => communicate(store, cluster, actor, 'group', { operation: 'create', name: 'site-contract', members: ['a2'] })));
  assert.deepEqual(created.members.sort(), ['a1', 'a2']);
  const sent = sendOf(store.tx(() => communicate(store, cluster, actor, 'send', { group: 'site-contract', content: 'contract v1' })));
  assert.deepEqual(sent.recipients.map(r => r.recipient), ['a1', 'a2']);
  store.tx(() => communicate(store, cluster, actor, 'group', { operation: 'leave', id: must(created.group, 'group').id, members: ['a2'] }));
  assert.deepEqual(store.groupMembers(must(created.group, 'group').id), ['a1']);

  const published = publishOf(store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 1 } })));
  assert.equal(published.revision, 1);
  assert.throws(() => store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 2 }, expected_revision: 0 })),
    error => rejectionStatus(error) === 409);
  const second = publishOf(store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 2 }, expected_revision: 1 })));
  assert.equal(second.revision, 2);
});

test('subscribe returns a snapshot and cursor from one read cut', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = must(store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'auditor', session_id: 's1', status: 'READY' }), 'agent a1');
  const actor: CommunicationActor = { cluster_id: cluster.id, agent_id: a.id, node_id: 'n1', role: 'auditor' };
  store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'plan/a', value: 1 }));
  const cursorBefore = store.latestEventSeq(cluster.id);
  store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'plan/b', value: 2 }));
  const sub = subscriptionOf(store.tx(() => communicate(store, cluster, actor, 'subscribe', { prefix: 'plan/' })));
  assert.equal((sub.snapshot ?? []).length, 2);
  assert.ok(Number(must(sub.subscription, 'subscription').cursor) >= cursorBefore);
  assert.equal(store.listSubscriptions(cluster.id, { agent_id: 'a1', active: true }).length, 1);
  store.tx(() => communicate(store, cluster, actor, 'subscribe', { operation: 'remove', id: must(sub.subscription, 'subscription').id }));
  assert.equal(store.listSubscriptions(cluster.id, { agent_id: 'a1', active: true }).length, 0);
});

test('validateSpec applies documented default limits', () => {
  const spec = validateSpec({ objective: 'o', workspace: '/tmp/w' });
  assert.equal(spec.limits.max_children, DEFAULT_LIMITS.max_children);
  assert.equal(spec.limits.max_depth, DEFAULT_LIMITS.max_depth);
  assert.deepEqual(spec.capabilities, ['fs_read']);
  assert.throws(() => validateSpec({ objective: '', workspace: '/tmp/w' }), /Invalid spec.objective/);
  assert.throws(() => validateSpec({ objective: 'o', workspace: '/tmp/w', limits: { max_depth: 99 } }), /Invalid spec.limits.max_depth/);
});
