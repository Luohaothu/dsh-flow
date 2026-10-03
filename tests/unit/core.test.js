import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ClusterStore, StoreError } from '../../src/adapter/store.js';
import {
  authorize, toolsForCapabilities, assertTransition, scopesOverlap, validateSpec, DEFAULT_LIMITS,
  CAPABILITY_TOOLS,
} from '../../src/adapter/protocol.js';
import {
  DIMENSIONS, createBudget, budgetView, reserveChain, settleChain, releaseChain, transferBudget,
  effectiveDeadline, exhausted, BudgetError,
} from '../../src/adapter/budget.js';
import { communicate } from '../../src/adapter/communication.js';
import { reserveLlmRequest, settleLlmRequest, releaseLlmRequest } from '../../src/adapter/runtime.js';
import { checkWriteAccess, canonicalScope } from '../../src/adapter/scope.js';

let clock = 1_700_000_000_000;
const now = () => clock;

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ClusterStore(join(dir, 'cluster.sqlite'), { now });
  t.after(() => store.close());
  return store;
}

function seedCluster(store, overrides = {}) {
  const spec = validateSpec({
    objective: 'test objective', workspace: '/tmp/ws',
    capabilities: ['fs_read', 'fs_write'], limits: { max_children: 4, max_active_agents: 4 },
    budget: { tokens: 1000, model_requests: 10, tool_calls: 100, agents: 16, max_active_agents: 4 },
    ...overrides,
  });
  const cluster = store.createCluster({ id: 'c-' + Math.random().toString(36).slice(2, 8), ...spec, limits: spec.limits, capabilities: spec.capabilities }, spec.budget);
  return cluster;
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

test('commands are idempotent per command_id and reject a conflicting payload', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  let applied = 0;
  const run = params => store.runCommand({ cluster_id: cluster.id, command_id: 'cmd-1', actor: { agent_id: 'a1' }, action: 'dispatch', params, expected_revision: 1 },
    () => {
      applied += 1;
      return { revision: 2, value: params.n };
    });

  assert.deepEqual(run({ n: 1 }), { result: { revision: 2, value: 1 }, revision: 2, deduped: false });
  assert.deepEqual(run({ n: 1 }), { result: { revision: 2, value: 1 }, revision: 2, deduped: true });
  assert.equal(applied, 1);
  assert.throws(() => run({ n: 2 }), error => error instanceof StoreError && error.status === 409);
});

test('events are append-only with a monotonic per-cluster cursor', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  store.tx(() => {
    store.appendEvent(cluster.id, 'one', { i: 1 });
    store.appendEvent(cluster.id, 'two', { i: 2 });
  });
  const first = store.readEvents(cluster.id, {});
  const second = store.readEvents(cluster.id, { since: first[0].seq });
  assert.deepEqual(first.map(e => e.type), ['one', 'two']);
  assert.deepEqual(second.map(e => e.type), ['two']);
});

test('role authorization denies cross-role writes and unknown roles', () => {
  assert.doesNotThrow(() => authorize({ role: 'orchestrator' }, 'dispatch'));
  assert.doesNotThrow(() => authorize({ role: 'auditor' }, 'inspect_plan'));
  assert.doesNotThrow(() => authorize({ role: 'allocator' }, 'spawn_management_node'));
  const denied = [
    [{ role: 'worker' }, 'dispatch'],
    [{ role: 'worker' }, 'accept_result'],
    [{ role: 'orchestrator' }, 'spawn_agent'],
    [{ role: 'auditor' }, 'validate'],
    [{ role: 'allocator' }, 'accept_result'],
    [{ role: 'ghost' }, 'dispatch'],
    [undefined, 'dispatch'],
  ];
  for (const [actor, action] of denied) {
    assert.throws(() => authorize(actor, action), error => error.status === 403, `${actor?.role}:${action}`);
  }
});

test('worker capabilities map to host tools and reject unknown or forbidden capabilities', () => {
  assert.deepEqual(toolsForCapabilities(['fs_read']), ['glob', 'grep', 'read']);
  assert.ok(toolsForCapabilities(['browser']).includes('mcp__playwright-mcp__browser_snapshot'));
  assert.ok(!toolsForCapabilities(['browser']).includes('mcp__playwright-mcp__browser_run_code_unsafe'));
  assert.deepEqual(Object.keys(CAPABILITY_TOOLS).sort(), ['browser', 'fs_read', 'fs_write', 'shell', 'web_fetch']);
  assert.throws(() => toolsForCapabilities(['root']), /Unsupported capability/);
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
  assert.equal(budgetView(store.getBudget(root.id)).tokens.available, 700);

  settleChain(store, [root.id], { reservedAmounts: { tokens: 300, model_requests: 1 }, consumed: { tokens: 260, model_requests: 1 } });
  const after = budgetView(store.getBudget(root.id));
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
    limit: cluster.budget, wall_limit_ms: 60_000,
  });
  const child = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'n1', parent_budget_id: root.id, wall_limit_ms: 120_000 });

  store.tx(() => transferBudget(store, root.id, child.id, { tokens: 400, model_requests: 4 }));
  assert.equal(budgetView(store.getBudget(child.id)).tokens.limit, 400);
  assert.equal(budgetView(store.getBudget(root.id)).tokens.limit, 600);
  assert.throws(() => store.tx(() => transferBudget(store, root.id, child.id, { tokens: 601 })), /only 600 unused-unreserved remains/);

  store.tx(() => settleChain(store, [child.id], { consumed: { tokens: 100 } }));
  store.tx(() => reserveChain(store, [child.id], { tokens: 50 }));
  assert.throws(() => store.tx(() => transferBudget(store, child.id, root.id, { tokens: 251 })), /only 250 unused-unreserved remains/);
  assert.equal(budgetView(store.getBudget(child.id)).tokens.spent, 100);
});

test('wall deadlines take the earliest ancestor deadline and never reset', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, { cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, limit: cluster.budget, wall_limit_ms: 1000 });
  const child = createBudget(store, { cluster_id: cluster.id, scope_kind: 'node', scope_id: 'n1', parent_budget_id: root.id, wall_limit_ms: 60_000 });
  store.tx(() => transferBudget(store, root.id, child.id, { tokens: 100, model_requests: 1 }));
  assert.equal(effectiveDeadline(store, store.getBudget(child.id)), now() + 1000);

  clock += 1500;
  assert.ok(exhausted(store, store.getBudget(child.id)));
  assert.throws(() => reserveChain(store, [child.id], { tokens: 1, model_requests: 1 }),
    error => error.code === 'LIMIT_REACHED' && error.dimension === 'wall_time_ms');
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
    cluster_id: cluster.id, agent_id: 'first-worker', node_id: 'first', role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [first.id], reservationTokens: 50, turn_seq: 1,
  });
  settleLlmRequest(store, {
    cluster_id: cluster.id, reservation: initial,
    usage: { inputTokens: 900, outputTokens: 50, totalTokens: 950 },
  });
  assert.throws(() => reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'second-worker', node_id: 'second', role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [second.id], reservationTokens: 80, turn_seq: 1,
  }), error => error.code === 'LIMIT_REACHED' && error.scope === cluster.id
    && error.dimension === 'tokens' && error.requested === 80 && error.available === 50);
  assert.equal(store.getBudget(second.id).tokens_reserved, 0, 'refused requests leave no hold');
  assert.equal(store.countUsageReceipts(cluster.id, 'second-worker'), 0, 'and no dispatchable receipt');
});

test('a replayed settlement moves no budget, and an unknown outcome keeps its token hold', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const root = createBudget(store, {
    cluster_id: cluster.id, scope_kind: 'root', scope_id: cluster.id, wall_limit_ms: 60_000,
    limit: { tokens: 1_000_000, model_requests: 100, tool_calls: 100, agents: 16, max_active_agents: 4 },
  });
  const dimensions = ['tokens', 'model_requests', 'tool_calls', 'agents', 'max_active_agents'];
  const snapshot = () => {
    const row = store.getBudget(root.id);
    return Object.fromEntries(dimensions.map(key => [key, { reserved: row[DIMENSIONS.find(d => d.key === key).reserved], spent: row[DIMENSIONS.find(d => d.key === key).spent] }]));
  };

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
  assert.equal(store.getUsageReceipt(c.request_id).status, 'UNKNOWN');

  // A request that provably never left the client releases both dimensions.
  const d = reserveLlmRequest(store, {
    cluster_id: cluster.id, agent_id: 'agent-d', node_id: null, transaction_id: null, role: 'worker', kind: 'worker',
    model: 'm', provider: 'p', budgetIds: [root.id], reservationTokens: 5_000, turn_seq: 1,
  });
  releaseLlmRequest(store, { cluster_id: cluster.id, reservation: d, budgetIds: [root.id], dispatched: false, note: 'dispatch failed' });
  assert.deepEqual(snapshot().tokens, { reserved: 5_000, spent: 170 });
  assert.deepEqual(snapshot().model_requests, { reserved: 0, spent: 3 }, 'a never-sent request must not consume an attempt');
  assert.equal(store.getUsageReceipt(d.request_id).status, 'NOT_SENT');
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
  const allow = tool => checkWriteAccess({ tool, workspace: dir, writeScope: owned, arguments: tool === 'write' ? { path: 'src/ui/App.jsx' } : {} });
  assert.equal(allow('write').allowed, true, 'a file inside the owned directory is allowed');
  assert.equal(checkWriteAccess({ tool: 'edit', workspace: dir, writeScope: owned, arguments: { path: 'src/ui/New.jsx' } }).allowed, true,
    'a not-yet-existing file inside the owned directory is allowed');

  const sibling = checkWriteAccess({ tool: 'write', workspace: dir, writeScope: owned, arguments: { path: 'src/data/store.js' } });
  assert.equal(sibling.allowed, false, "a sibling's file must be refused");
  assert.match(sibling.reason, /outside this allocation's write scope/);

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

  const owned = canonicalScope(dir, ['src/ui']);
  assert.deepEqual(owned, canonicalScope(dir, ['alias-ui']), 'two names for one directory must canonicalise identically');
  assert.ok(scopesOverlap(owned, canonicalScope(dir, ['alias-ui'])), 'so the overlap check refuses the second lock');

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
  assert.equal(checkWriteAccess({ tool: 'write', workspace: dir, writeScope: ['.'] , writeScopeCanonical: canonicalScope(dir, ['.']), arguments: { path: 'elsewhere/other.ts' } }).allowed, true,
    'the workspace owner may write anywhere inside it');

  // Shell belongs to the workspace owner only, and an alias of the workspace
  // canonicalises to the same lock.
  assert.equal(canonicalScope(dir, ['.'])[0], canonicalScope(dir, ['src/..'])[0], 'a traversing alias canonicalises to the root lock');
});

test('communication validates every multicast target before delivering anything', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' });
  const b = store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' });
  store.insertAgent({ id: 'a3', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's3', status: 'TERMINATED' });
  const actor = { agent_id: a.id, node_id: a.node_id, role: 'orchestrator' };

  const sent = store.tx(() => communicate(store, cluster, actor, 'multicast', { agent: 'a2', content: 'hello' }));
  assert.deepEqual(sent.recipients, [{ recipient: b.id, delivery_seq: 1 }]);
  assert.equal(store.pendingDeliveries('a2').length, 1);
  assert.equal(store.pendingDeliveries('a2')[0].content, JSON.stringify({ text: 'hello' }));

  assert.throws(() => communicate(store, cluster, actor, 'multicast', { agent: ['a1'] }, {}), /Invalid recipient/);
  const before = store.getMessage(sent.message_id);
  assert.throws(() => store.tx(() => communicate(store, cluster, actor, 'multicast', { agent: 'a3', content: 'x' })), /TERMINATED/);
  assert.deepEqual(store.getMessage(sent.message_id), before);
  assert.throws(() => communicate(store, cluster, actor, 'send', { agent: 'a2' }), /requires content/);
});

test('resending a message id repairs deliveries without duplicating the message', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' });
  store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' });
  const actor = { agent_id: a.id, node_id: 'n1', role: 'orchestrator' };
  const first = store.tx(() => communicate(store, cluster, actor, 'send', { agent: 'a2', content: 'hi', message_id: 'm-1' }));
  const second = store.tx(() => communicate(store, cluster, actor, 'send', { agent: 'a2', content: 'hi', message_id: 'm-1' }));
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.deepEqual(second.recipients, []);
  assert.equal(store.pendingDeliveries('a2').length, 1);
});

test('groups accept cross-subtree members and blackboard publishes are revision fenced', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'orchestrator', session_id: 's1', status: 'READY' });
  store.insertAgent({ id: 'a2', cluster_id: cluster.id, node_id: 'n2', role: 'worker', session_id: 's2', status: 'READY' });
  store.insertNode({ id: 'n1', cluster_id: cluster.id, parent_id: null, kind: 'management', depth: 0, status: 'ACTIVE', path: 'root' });
  store.insertNode({ id: 'n2', cluster_id: cluster.id, parent_id: 'n1', kind: 'worker', depth: 1, status: 'ACTIVE', path: 'root/n2' });
  const actor = { agent_id: a.id, node_id: 'n1', role: 'orchestrator' };

  const created = store.tx(() => communicate(store, cluster, actor, 'group', { operation: 'create', name: 'site-contract', members: ['a2'] }));
  assert.deepEqual(created.members.sort(), ['a1', 'a2']);
  const sent = store.tx(() => communicate(store, cluster, actor, 'send', { group: 'site-contract', content: 'contract v1' }));
  assert.deepEqual(sent.recipients.map(r => r.recipient), ['a1', 'a2']);
  store.tx(() => communicate(store, cluster, actor, 'group', { operation: 'leave', id: created.group.id, members: ['a2'] }));
  assert.deepEqual(store.groupMembers(created.group.id), ['a1']);

  const published = store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 1 } }));
  assert.equal(published.revision, 1);
  assert.throws(() => store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 2 }, expected_revision: 0 })),
    error => error.status === 409);
  const second = store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'ui/contract', value: { v: 2 }, expected_revision: 1 }));
  assert.equal(second.revision, 2);
});

test('subscribe returns a snapshot and cursor from one read cut', t => {
  const store = tempStore(t);
  const cluster = seedCluster(store);
  const a = store.insertAgent({ id: 'a1', cluster_id: cluster.id, node_id: 'n1', role: 'auditor', session_id: 's1', status: 'READY' });
  const actor = { agent_id: a.id, node_id: 'n1', role: 'auditor' };
  store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'plan/a', value: 1 }));
  const cursorBefore = store.latestEventSeq(cluster.id);
  store.tx(() => communicate(store, cluster, actor, 'publish', { key: 'plan/b', value: 2 }));
  const sub = store.tx(() => communicate(store, cluster, actor, 'subscribe', { prefix: 'plan/' }));
  assert.equal(sub.snapshot.length, 2);
  assert.ok(Number(sub.subscription.cursor) >= cursorBefore);
  assert.equal(store.listSubscriptions(cluster.id, { agent_id: 'a1', active: true }).length, 1);
  store.tx(() => communicate(store, cluster, actor, 'subscribe', { operation: 'remove', id: sub.subscription.id }));
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