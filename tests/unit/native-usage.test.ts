import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fromAny } from '@total-typescript/shoehorn';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { ClusterStore, SCHEMA_VERSION } from '../../packages/dsh-flow/src/core/store.ts';
import type { NativeUsageProjection } from '../../packages/dsh-flow/src/core/native-usage.ts';
import { validateBudget, validateLimits } from '../../packages/dsh-flow/src/validation.ts';
import { createBudget, reserveChain, settleChain } from '../../packages/dsh-flow/src/core/budget.ts';
import { validateSpec } from '../../packages/dsh-flow/src/core/protocol.ts';

function event(seq: number, type: string, data: unknown, time = seq): SessionEvent {
  return fromAny({ seq, type, data, time });
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-native-usage-'));
  const path = join(dir, 'flow.sqlite');
  let store = new ClusterStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (events: SessionEvent[], agentId = 'agent', nativeSessionId = 'session'): NativeUsageProjection => ({
    clusterId: 'cluster', nodeId: 'root', agentId, role: 'worker', nativeSessionId, events,
  });
  return { get store() { return store; }, input, reopen() { store.close(); store = new ClusterStore(path); return store; } };
}
const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 34, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 5 };
const source = { kind: 'model', provider: 'provider', model: 'model' };
const message = (value: unknown = usage) => ({ turn: 1, step: 1, message: { source }, stream: [], usage: value });
const header = { header: { config: { provider: 'provider', model: 'model', reasoningEffort: 'high' } } };
const streamUsage = (value: unknown) => ({ type: 'chunk', time: 1, chunk: { type: 'usage', usage: value } });

test('public native Session and Assistant builders produce the exact shapes consumed by the projection', t => {
  const f = fixture(t);
  const session = Session.create(SessionId('real-native'));
  const events: SessionEvent[] = [
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'provider', model: 'model', reasoningEffort: ReasoningEffortId('high') } } }),
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { ...usage, totalTokens: 99 } } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage } },
    ] }),
    session.append('assistant/message', {
      turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'provider', model: 'model' }, content: [{ type: 'text', text: 'result' }] }), stream: [], usage,
    }, { surfaceOp: 'append' }),
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ];
  f.store.projectNativeUsage(f.input(events, 'real-agent', session.id));
  const actual = f.store.latestNativeContext('real-agent');
  assert.equal(actual.model, 'model');
  assert.equal(actual.reasoning_effort, 'high');
  assert.equal(f.store.usageSummary('cluster').total_tokens, 68);
  assert.equal(f.store.usageSummary('cluster').requests, 2);
  assert.equal(f.store.usageSummary('cluster').completeness, 'incomplete');
});

test('native replay, increments and restarts consume each seq once and persist the cursor', t => {
  const f = fixture(t);
  const events = [event(0, 'request/header', header), event(1, 'assistant/message', {
    ...message(), stream: [streamUsage({ ...usage, totalTokens: 999 })],
  })];
  assert.equal(f.store.projectNativeUsage(f.input(events)), 1);
  assert.equal(f.store.usageSummary('cluster').total_tokens, 34, 'message data.usage takes precedence over its stream');
  f.store.projectNativeUsage(f.input(events));
  const reopened = f.reopen();
  assert.equal(reopened.nativeUsageCursor('session'), 1);
  reopened.projectNativeUsage(f.input([...events, event(2, 'assistant/attempt', {
    turn: 1, step: 1, stream: [streamUsage({ ...usage, totalTokens: 100 }), streamUsage({ ...usage, totalTokens: 40 })],
  })]));
  assert.equal(reopened.usageSummary('cluster').requests, 2, 'independent attempts within one step remain independent');
  assert.equal(reopened.usageSummary('cluster').total_tokens, 74, 'only the final attempt usage is counted');
  assert.equal(reopened.usageEventsForDomain('cluster').total, 2);
  assert.equal(reopened.latestNativeContext('agent').reasoning_effort, 'high');
  assert.equal(reopened.usageSummary('cluster').reasoning_tokens, 10, 'reasoning is preserved without adding it to total');
});

test('native facts and consumption cursor roll back together on a failed batch or outer transaction', t => {
  const f = fixture(t);
  assert.throws(() => f.store.projectNativeUsage(f.input([event(0, 'request/header', header), event(2, 'assistant/message', message())])), /contiguous/);
  assert.equal(f.store.nativeUsageCursor('session'), null);
  assert.equal(f.store.nativeEventsForAgent('agent').length, 0);
  assert.throws(() => f.store.tx(() => {
    f.store.projectNativeUsage(f.input([event(0, 'assistant/message', message())]));
    throw new Error('outer write failed');
  }), /outer write failed/);
  assert.equal(f.store.nativeUsageCursor('session'), null);
  f.store.projectNativeUsage(f.input([event(0, 'assistant/message', message())]));
  assert.throws(() => f.store.projectNativeUsage(f.input([event(0, 'assistant/message', message({ ...usage, totalTokens: 999 }))])), /changed/);
  assert.throws(() => f.store.projectNativeUsage(f.input([], 'other-agent')), /another cluster or identity/);
  assert.equal(f.store.usageSummary('cluster').total_tokens, 34);
});

test('missing and zero host fields stay separate from completeness and no total is fabricated', t => {
  const f = fixture(t);
  assert.equal(f.store.usageSummary('cluster').total_tokens, null);
  assert.equal(f.store.usageSummary('cluster').completeness, 'unknown');
  f.store.projectNativeUsage(f.input([
    event(0, 'assistant/message', message({ inputTokens: 0, outputTokens: 0 })),
    event(1, 'assistant/message', { ...message({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), interrupted: true }),
    event(2, 'assistant/attempt', { turn: 1, step: 1, stream: [] }),
  ]));
  const summary = f.store.usageSummary('cluster');
  assert.equal(summary.total_tokens, 0);
  assert.equal(summary.cache_read_tokens, null);
  assert.equal(summary.reasoning_tokens, null);
  assert.equal(summary.completeness, 'incomplete');
  assert.equal(f.store.usageEventsForDomain('cluster').items[0]?.total_tokens, null);
  assert.equal(f.store.usageEventsForDomain('cluster').items[1]?.total_tokens, 0);
});

test('host context snapshots commit at the durable event cut and survive restart without measuring', t => {
  const f = fixture(t);
  const events = [event(0, 'request/context', { provider: 'provider', model: 'model', contextWindow: 8192 })];
  assert.throws(() => f.store.projectNativeUsage({ ...f.input(events), contextSnapshot: { nativeSeq: 1, projectedTokens: 100 } }), /ahead/);
  assert.equal(f.store.nativeUsageCursor('session'), null, 'a rejected snapshot rolls back its event batch');
  f.store.projectNativeUsage({ ...f.input(events), contextSnapshot: { nativeSeq: 0, projectedTokens: 120, pressureTokens: 100, contextWindow: 8192 } });
  assert.equal(f.store.latestNativeContext('agent').context_used, 120);
  assert.equal(f.reopen().latestNativeContext('agent').context_limit, 8192);
  assert.equal(f.store.latestNativeContext('agent').context_used, 120);
  f.store.projectNativeUsage(f.input([event(1, 'user/message', {})]));
  assert.equal(f.store.latestNativeContext('agent').context_used, null, 'stale surface estimates are not current occupancy');
  assert.equal(f.store.latestNativeContext('agent').context_limit, 8192, 'an observed route capacity remains known when only its occupancy snapshot is stale');
});

test('a route with no native capacity never revives the preceding route window from a stale snapshot', t => {
  const f = fixture(t);
  const session = Session.create(SessionId('route-capacity'));
  const initial = [session.append('request/context', { provider: 'provider', model: 'model-a', contextWindow: 8192 })];
  f.store.projectNativeUsage({ ...f.input(initial, 'agent', session.id),
    contextSnapshot: { nativeSeq: initial[0]!.seq, projectedTokens: 100, contextWindow: 8192 } });
  assert.equal(f.store.latestNativeContext('agent').context_limit, 8192);
  const changed = [
    session.append('request/context', { provider: 'provider', model: 'model-b' }),
    session.append('assistant/message', {
      turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'provider', model: 'model-b' },
        content: [{ type: 'text', text: 'unknown capacity' }] }), stream: [], usage,
    }, { surfaceOp: 'append' }),
  ];
  f.store.projectNativeUsage(f.input(changed, 'agent', session.id));
  const context = f.reopen().latestNativeContext('agent');
  assert.equal(context.model, 'model-b');
  assert.equal(context.context_limit, null, 'the previous route snapshot cannot supply the new route capacity');
  assert.equal(context.context_used, null);
});

test('compaction summary usage is counted once, replacement messages never count, failures only mark incomplete', t => {
  const f = fixture(t);
  f.store.projectNativeUsage(f.input([
    event(0, 'compaction/start', { compactionId: 'one', turn: 1 }),
    event(1, 'compaction/summary', { compactionId: 'one', provider: 'summary-provider', model: 'summary-model', usage, llmStreamCall: true }),
    event(2, 'user/message', { source: { kind: 'compact-checkpoint' }, usage }),
    event(3, 'compaction/end', { compactionId: 'one', turn: 1 }),
  ]));
  assert.equal(f.store.usageSummary('cluster').requests, 1);
  assert.equal(f.store.usageSummary('cluster').total_tokens, 34);
  assert.equal(f.store.usageSummary('cluster').completeness, 'complete');
  assert.equal(f.store.latestNativeContext('agent').model, null, 'summary model is not the actual agent request model');
  f.store.projectNativeUsage(f.input([event(4, 'compaction/start', { compactionId: 'two', turn: 1 })]));
  assert.equal(f.store.usageSummary('cluster').completeness, 'incomplete');
  f.store.projectNativeUsage(f.input([event(5, 'compaction/end', { compactionId: 'two', turn: 1, error: 'summarizer failed' })]));
  assert.equal(f.store.usageSummary('cluster').requests, 1);
  assert.equal(f.store.usageSummary('cluster').total_tokens, 34);
});

test('identity, subtree and team sums use the same facts without counting ancestors twice', t => {
  const f = fixture(t);
  f.store.insertNode({ id: 'root', cluster_id: 'cluster', parent_id: null, kind: 'management', status: 'ACTIVE', depth: 0, path: '0' });
  f.store.insertNode({ id: 'child', cluster_id: 'cluster', parent_id: 'root', kind: 'worker', status: 'ACTIVE', depth: 1, path: '0.0' });
  f.store.insertNode({ id: 'sibling', cluster_id: 'cluster', parent_id: null, kind: 'management', status: 'ACTIVE', depth: 0, path: '1' });
  f.store.projectNativeUsage(f.input([event(0, 'assistant/message', message())]));
  f.store.projectNativeUsage({ ...f.input([event(0, 'assistant/message', message())], 'child-agent', 'child-session'), nodeId: 'child' });
  f.store.projectNativeUsage({ ...f.input([event(0, 'assistant/message', message())], 'sibling-agent', 'sibling-session'), nodeId: 'sibling' });
  assert.equal(f.store.usageSummary('cluster').total_tokens, 102);
  assert.equal(f.store.usageSummary('cluster', { nodeId: 'root' }).total_tokens, 68);
  assert.equal(f.store.usageSummary('cluster', { agentId: 'child-agent' }).total_tokens, 34);
  assert.equal(f.store.usageEventsForDomain('cluster', { scope_node_id: 'root' }).total, 2);
});

test('new schema is self-contained and rejects old versions and unversioned business tables without writes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const version of [0, 1, 2, 99]) {
    const path = join(dir, `${version}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('retain'); PRAGMA user_version=${version}`);
    db.close();
    const before = readFileSync(path);
    assert.throws(() => new ClusterStore(path), /use a new dataDir/);
    assert.deepEqual(readFileSync(path), before, 'even persistent PRAGMAs must not mutate a rejected file');
  }
  const path = join(dir, 'fresh.sqlite');
  const store = new ClusterStore(path);
  assert.equal(store.get('PRAGMA user_version')?.user_version, SCHEMA_VERSION);
  assert.equal(store.get("SELECT name FROM sqlite_master WHERE name='usage_receipts'"), undefined);
  assert.equal(store.all('PRAGMA table_info(budgets)').some(row => String(row.name).includes('token') || String(row.name).includes('requests')), false);
  for (const [table, names] of [['clusters', ['declared_limits']], ['transactions', ['result_staged_epoch', 'result_staged_turn', 'result_staged_agent', 'pre_pause_status', 'pre_pause_revision']], ['allocations', ['write_scope_canonical']], ['checkpoints', ['events_seq', 'usage_watermark']], ['tool_call_receipts', ['budget_scope_id', 'dispatch_status']], ['leases', ['epoch', 'event_upper_bound']]] as const) {
    const columns = store.all(`PRAGMA table_info(${table})`).map(row => row.name);
    for (const name of names) assert.ok(columns.includes(name), `${table}.${name} belongs directly to schema 3`);
  }
  const spec = validateSpec({ objective: 'retain tool and cooperation limits', workspace: dir, limits: { max_tool_calls_per_turn: 7, max_scale_batch: 3 } });
  store.createCluster({ id: 'retained-limits', ...spec }, spec.budget);
  store.close();
  const reopened = new ClusterStore(path);
  assert.equal(reopened.getCluster('retained-limits')?.limits.max_tool_calls_per_turn, 7);
  assert.equal(reopened.getCluster('retained-limits')?.limits.max_scale_batch, 3);
  reopened.close();
});

test('new-contract restarts preserve tool holds, uncertain effects, leases and native checkpoint cursors', t => {
  const f = fixture(t);
  const budget = createBudget(f.store, { cluster_id: 'cluster', scope_kind: 'agent', scope_id: 'agent', limit: { tool_calls: 3 } });
  reserveChain(f.store, [budget.id], { tool_calls: 1 });
  f.store.insertToolCallReceipt({ call_id: 'tool', cluster_id: 'cluster', agent_id: 'agent', session_id: 'session',
    tool: 'write', args_hash: 'hash', budget_scope_id: budget.id, dispatch_status: 'DISPATCHED' });
  f.store.insertEffect({ call_id: 'tool', cluster_id: 'cluster', agent_id: 'agent', lease_epoch: 7, tool: 'write', status: 'EFFECT_UNCERTAIN' });
  f.store.createLease({ id: 'lease', cluster_id: 'cluster', agent_id: 'agent', node_id: 'root', epoch: 7, expires: 999999, event_upper_bound: 12 });
  f.store.projectNativeUsage(f.input([event(0, 'assistant/message', message())]));
  f.store.insertCheckpoint({ id: 'checkpoint', cluster_id: 'cluster', agent_id: 'agent', session_id: 'session',
    flushed_seq: 1, events_seq: 12, usage_watermark: f.store.nativeUsageCursor('session') });
  const store = f.reopen();
  assert.equal(store.getToolCallReceipt('tool')?.dispatch_status, 'DISPATCHED');
  assert.equal(store.getEffect('tool')?.status, 'EFFECT_UNCERTAIN');
  assert.equal(store.leaseForAgent('agent')?.epoch, 7);
  assert.equal(store.leaseForAgent('agent')?.event_upper_bound, 12);
  assert.equal(store.getCheckpoint('checkpoint')?.usage_watermark, 0);
  assert.equal(store.getBudget(budget.id)?.tool_calls_reserved, 1);
  settleChain(store, [budget.id], { reservedAmounts: { tool_calls: 1 }, consumed: { tool_calls: 1 } });
  store.settleToolCallReceipt('tool', { dispatch_status: 'SETTLED', result_body: 'confirmed' });
  assert.equal(store.getBudget(budget.id)?.tool_calls_spent, 1);
});

test('deprecated budget and worker limits are rejected including hidden requests alias', () => {
  for (const field of ['tokens', 'model_requests', 'requests']) assert.throws(() => validateBudget({ [field]: 1 }), /Unsupported/);
  for (const field of ['worker_max_tokens', 'worker_model_requests']) assert.throws(() => validateLimits({ [field]: 1 }), /Unsupported/);
});
