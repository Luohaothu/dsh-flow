import assert from 'node:assert/strict';
import test from 'node:test';
import { ancestors, defaultRun, descendants, formatDuration, orderedNodes, scopedRuns, sortMailbox, statusLabel, usageTotals, visibleTree } from '../../../packages/dsh-flow/src/ui/derive.js';
import { createDashboardViewStore } from '../../../packages/dsh-flow/src/ui/view-state.js';
import { card, model, run } from './fixtures.js';

test('scope filters by actual caller and defaults to latest active, while saved selection and views remain isolated', () => {
  const global = { kind: 'global' as const }, session = { kind: 'session' as const, callerSessionId: 'caller' };
  const runs = [run('older', { startedAt: 10 }), run('recent-stopped', { startedAt: 30, status: 'stopped' }), run('foreign', { startedAt: 40, entry: { backend: 'dsh', callerSessionId: 'another' } })];
  assert.equal(defaultRun(scopedRuns(runs, session))?.id, 'older');
  const store = createDashboardViewStore(); store.selectRun('e', global, 'recent-stopped'); store.update('e', global, 'older', { selectedId: 'old-instance', collapsed: ['branch'], viewport: { x: -20, y: 5, scale: .7 } });
  assert.equal(store.selectedRun('e', global), 'recent-stopped'); assert.equal(store.selectedRun('e', session), undefined);
  assert.equal(store.get('e', session, 'older').selectedId, null); assert.equal(store.get('new-epoch', global, 'older').selectedId, null);
  assert.equal(store.get('e', global, 'older').viewport.x, -20); assert.strictEqual(store.get('e', global, 'older'), store.get('e', global, 'older'));
});
test('published sibling order survives snapshot replacements and instance identity is independent of SessionID', () => {
  const root = card('root'), a = card('a', 'root'), b = card('b', 'root'), order = new Map<string, number>();
  assert.deepEqual(orderedNodes([root, a, b], order).map(node => node.id), ['root', 'a', 'b']);
  assert.deepEqual(orderedNodes([b, root, { ...a, status: 'running' }], order).map(node => node.id), ['root', 'a', 'b']);
  const resumed = card('resumed', 'root', { sessionID: a.sessionID, createdAt: 200 });
  assert.deepEqual(descendants('root', [root, a, resumed]).map(node => node.id), ['a', 'resumed']);
});
test('folding hides all logical descendants while ancestry remains available for focus recovery', () => {
  const nodes = [card('r'), card('a', 'r'), card('b', 'a'), card('c', 'b'), card('d', 'r')];
  assert.deepEqual(visibleTree(nodes, new Set(['a'])).map(item => item.node.id), ['r', 'a', 'd']); assert.deepEqual(ancestors('c', nodes), ['b', 'a', 'r']); assert.equal(descendants('a', nodes).length, 2);
  const transferred = nodes.map(node => node.id === 'b' ? { ...node, parentId: 'd' } : node);
  assert.deepEqual(ancestors('c', transferred), ['b', 'd', 'r']); assert.deepEqual(visibleTree(transferred, new Set(['a'])).map(item => item.node.id), ['r', 'a', 'd', 'b', 'c']);
});
test('usage takes latest cumulative sample per instance/call and keeps missing totals and currencies honest', () => {
  const a = card('a', null, { usage: [{ callId: 'call', model, timestamp: 1, inputTokens: 20, outputTokens: 2, totalTokens: 22, cacheReadTokens: 4, amount: 1, currency: 'USD' }, { callId: 'call', model, timestamp: 2, inputTokens: 30, outputTokens: 3, totalTokens: 40, cacheReadTokens: 6, amount: 2, currency: 'USD' }] });
  const b = card('b', 'a', { usage: [{ callId: 'call', model, timestamp: 3, inputTokens: 5, amount: .5, currency: 'CNY' }] });
  const self = usageTotals([a]), branch = usageTotals([a, b]); assert.equal(self.input, 30); assert.equal(self.total, 40); assert.equal(self.calls.length, 1); assert.equal(branch.input, 35); assert.equal(branch.output, null); assert.equal(branch.total, null); assert.equal(branch.cacheWrite, null); assert.deepEqual(branch.amounts, [{ currency: 'USD', amount: 2 }, { currency: 'CNY', amount: .5 }]);
  assert.equal(usageTotals([card('unknown')]).total, null); assert.equal(usageTotals([card('unknown')]).amountAvailable, false);
});
test('only termination outcome changes Agent result and elapsed time freezes at terminatedAt', () => {
  assert.equal(statusLabel(card('live', null, { status: 'idle', assignmentIds: ['completed-job'] })), '空闲');
  assert.equal(statusLabel(card('done', null, { status: 'terminated', outcome: 'completed' })), '完成');
  assert.equal(formatDuration(0, 83_000, 900_000), '1m23s'); assert.equal(formatDuration(0, null, 3_723_000), '1h02m03s');
});
test('mailbox order is newest timestamp first with insertion order preserved for equal times', () => {
  const message = { source: { kind: 'system' as const }, recipientId: 'r', timestamp: 10, summary: '消息', priority: 'normal' as const, read: false, readTimestamp: null };
  const input = [{ ...message, id: 'first' }, { ...message, id: 'second' }, { ...message, id: 'new', timestamp: 20 }];
  assert.deepEqual(sortMailbox(input).map(item => item.id), ['new', 'first', 'second']); assert.deepEqual(input.map(item => item.id), ['first', 'second', 'new']);
});
