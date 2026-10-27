import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context } from '../../../packages/dsh-flow/src/core/index.js';
import type { ContextSummary, Usage } from '../../../packages/dsh-flow/src/core/index.js';
import { AuxiliaryCallError, awaitAuxiliaryUsageSettlements } from '../../../packages/dsh-flow/src/core/auxiliary-usage.js';
import { ContractHost, deferred, flush, profile } from '../../helpers/contract-host.js';

function usage(model: string, tokens: number): Usage {
  return { timestamp: 10, model: { provider: 'actual', id: model }, inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 };
}
function summary(source: string) {
  return `Flow 上下文总结 v1\n来源：${source}\n\n## 目标与约束\n无\n## 已知事实与关键决策\n无\n## 当前进展与已有产物\n无\n## 关键文件、资源及定位信息\n无\n## 未完成事项与后续步骤\n未知\n## 分歧、风险与待确认信息\n未知`;
}
async function setup() {
  const ctx = new Context(); const host = new ContractHost(); ctx.registerHostAdaptor(host);
  const a = await Agent.create(ctx, profile('a', { name: 'mother', hostExtras: { nested: { inherited: 7 } }, model: { provider: 'contract', id: 'model-a' }, params: { version: 1, maxTokens: 64, reasoningEffort: 'high' } }), null);
  const b = await Agent.create(ctx, profile('b', { model: { provider: 'contract', id: 'model-b' } }), null);
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [] });
  host.mergeHook = async () => ({ summary: summary('a + b'), usage: [] });
  return { ctx, host, a, b };
}

test('C011-01 C012-01 fork exports once and imports the explicit snapshot under a new session with inherited config', async t => {
  const { ctx, host, a } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running');
  const child = await a.fork();
  assert.equal(child.getParent(), a); assert.deepEqual(a.getChildren(), [child]);
  assert.notEqual(child.getProfile().sessionID, a.getProfile().sessionID);
  assert.deepEqual(child.getProfile(), { ...a.getProfile(), sessionID: child.getProfile().sessionID });
  assert.notEqual(child.getProfile(), a.getProfile());
  assert.deepEqual(host.exports, [host.native(a)]);
  const nativeChild = host.created.find(record => record.flow === child)!;
  assert.equal(nativeChild.history, 'contract-history-v1: recorded dialogue');
  assert.equal(host.sent.length, 0); assert.equal(a.getStatus(), 'running');
});

test('C011-01 permission ordering rejects elevation before backend creation and allows equal or lower initial grants', async t => {
  const { ctx, host } = await setup(); t.after(() => ctx.dispose());
  const readonly = await Agent.create(ctx, profile('reader', { permission: 'read-only' }), null);
  const before = host.created.length;
  await assert.rejects(Agent.create(ctx, profile('elevated', { permission: 'workspace-write' }), readonly));
  assert.equal(host.created.length, before); assert.deepEqual(readonly.getChildren(), []);
  const equal = await Agent.create(ctx, profile('equal', { permission: 'read-only' }), readonly);
  const writer = await Agent.create(ctx, profile('writer', { permission: 'workspace-write' }), null);
  const lower = await Agent.create(ctx, profile('lower', { permission: 'read-only' }), writer);
  assert.equal(equal.getProfile().permission, 'read-only'); assert.equal(lower.getProfile().permission, 'read-only');
  assert.equal(host.native(lower).profile.permission, 'read-only');
});

test('C011-02 resumed permission cannot exceed its new parent and failed recovery removes the new native binding', async t => {
  const { ctx, host, a } = await setup(); t.after(() => ctx.dispose());
  const readonly = await Agent.create(ctx, profile('reader', { permission: 'read-only' }), null);
  await host.persist(host.native(a)); await ctx.release(a);
  await assert.rejects(Agent.resume(ctx, readonly, sessionID('a')));
  assert.equal(ctx.getAgent(sessionID('a')), null); assert.deepEqual(readonly.getChildren(), []);
  assert.equal(host.releases.filter(r => r.agent.profile.sessionID === 'a').length, 2);
});

test('C013-01 C013-03 C014-01 herb summarizes both running sources, merges once with mother and settles after child input handover', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running'); host.status(b, 'running');
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [usage(agent.profile.model.id, agent === host.native(a) ? 11 : 22)] });
  host.mergeHook = async () => ({ summary: summary('a + b'), usage: [usage('merge-route', 33)] });
  const handover = deferred();
  host.sendHook = record => {
    assert.equal(record.agent.profile.sessionID === 'a' || record.agent.profile.sessionID === 'b', false);
    const child = ctx.getAgent(record.agent.profile.sessionID);
    assert.ok(child); assert.equal(child.getParent(), a);
    assert.equal(host.usageSettlements.length, 0);
    return handover.promise;
  };
  const creating = a.herb(b); await flush();
  assert.deepEqual(host.summaries, [host.native(a), host.native(b)]);
  assert.deepEqual(host.merges, [{ agent: host.native(a), own: summary('a'), other: summary('b') }]);
  assert.equal(host.created.length, 3); assert.equal(host.created[2]!.history, undefined);
  assert.equal(host.sent.length, 1); assert.deepEqual(host.sent[0]!.message.source, { kind: 'system' });
  assert.equal(host.sent[0]!.message.payload, summary('a + b')); assert.equal(host.sent[0]!.purpose, 'input');
  assert.equal(host.usageSettlements.length, 0);
  handover.resolve(); const child = await creating;
  assert.equal(child.getParent(), a);
  assert.deepEqual(child.getProfile(), { ...a.getProfile(), sessionID: child.getProfile().sessionID });
  assert.equal(host.usageSettlements.length, 1); assert.equal(host.usageSettlements[0]!.agent, host.native(child));
  assert.deepEqual(host.usageSettlements[0]!.usage, [usage('model-a', 11), usage('model-b', 22), usage('merge-route', 33)]);
  assert.equal(a.getStatus(), 'running'); assert.equal(b.getStatus(), 'running'); assert.equal(host.exports.length, 0);
});

test('C013-04 C014-02 failed summary waits for both settled outcomes and includes both failed-call usage records once', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const first = deferred<ContextSummary>(); const second = deferred<ContextSummary>();
  host.summaryHook = agent => agent === host.native(a) ? first.promise : second.promise;
  const herb = a.herb(b); let rejected = false; void herb.catch(() => { rejected = true; });
  first.reject(new AuxiliaryCallError('truncated source a', [usage('failed-a', 10)]));
  await flush(); assert.equal(rejected, false); assert.equal(host.usageSettlements.length, 0);
  second.reject(new AuxiliaryCallError('stream failed source b', [usage('failed-b', 20)]));
  await assert.rejects(herb);
  assert.equal(host.merges.length, 0); assert.equal(host.created.length, 2); assert.equal(host.sent.length, 0);
  assert.equal(host.usageSettlements.length, 1); assert.equal(host.usageSettlements[0]!.agent, host.native(a));
  assert.deepEqual(host.usageSettlements[0]!.usage, [usage('failed-a', 10), usage('failed-b', 20)]);
});

test('C014-02 a failed source preserves the other successful summary usage without performing merge', async t => {
  const { ctx, host, a } = await setup(); t.after(() => ctx.dispose());
  host.summaryHook = async agent => {
    if (agent === host.native(a)) throw new AuxiliaryCallError('invalid format', [usage('invalid', 4)]);
    return { summary: summary('b'), usage: [usage('successful-b', 5)] };
  };
  await assert.rejects(a.herb((ctx.getAgent(sessionID('b')))!));
  assert.equal(host.merges.length, 0); assert.equal(host.usageSettlements.length, 1);
  assert.deepEqual(host.usageSettlements[0]!.usage, [usage('invalid', 4), usage('successful-b', 5)]);
});

test('C014-02 merge failure includes actual merge attempt usage and emits no child or source input', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [usage(agent.profile.sessionID, 3)] });
  host.mergeHook = async () => { throw new AuxiliaryCallError('merge output incomplete', [usage('merge-attempt', 7)]); };
  await assert.rejects(a.herb(b));
  assert.equal(host.merges.length, 1); assert.equal(host.created.length, 2); assert.equal(host.sent.length, 0);
  assert.equal(host.usageSettlements.length, 1); assert.equal(host.usageSettlements[0]!.agent, host.native(a));
  assert.deepEqual(host.usageSettlements[0]!.usage.map(u => u.inputTokens), [3, 3, 7]);
});

test('C005-03 C014-02 source terminating during summaries blocks publication and settles buffered usage to mother', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const hold = deferred<ContextSummary>();
  host.summaryHook = agent => agent === host.native(b) ? hold.promise : Promise.resolve({ summary: summary('a'), usage: [usage('a', 1)] });
  const herb = a.herb(b); await flush(); await b.recvSignal('SIGTERM');
  hold.resolve({ summary: summary('b'), usage: [usage('b', 2)] });
  await assert.rejects(herb);
  assert.deepEqual(a.getChildren(), []);
  assert.equal(host.created.filter(item => ctx.has(item.flow)).length, 1);
  assert.equal(host.usageSettlements.length, 1); assert.equal(host.usageSettlements[0]!.agent, host.native(a));
  assert.deepEqual(host.usageSettlements[0]!.usage.slice(0, 2).map(u => u.inputTokens), [1, 2]);
});

test('C005-03 C014-02 termination of mother does not discard usage already reported by pending auxiliary calls', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const hold = deferred<ContextSummary>();
  host.summaryHook = agent => agent === host.native(a) ? hold.promise : Promise.resolve({ summary: summary('b'), usage: [usage('b', 2)] });
  const { observeCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const forwarded: number[] = [];
  t.after(observeCore(ctx, event => { if (event.type === 'host-event' && event.agent === a && event.event.type === 'usage') forwarded.push(event.event.usage.inputTokens!); }));
  const herb = a.herb(b); await flush();
  const nativeCleanup = deferred(); host.closeGates.set(host.native(a), nativeCleanup);
  const drained = awaitAuxiliaryUsageSettlements(host, host.native(a)).then(() => nativeCleanup.resolve());
  const terminated = a.recvSignal('SIGKILL');
  hold.reject(new AuxiliaryCallError('mother closed', [usage('mother-failed', 6)]));
  await assert.rejects(herb);
  assert.equal(host.usageSettlements.length, 1); assert.equal(host.usageSettlements[0]!.agent, host.native(a));
  assert.deepEqual(host.usageSettlements[0]!.usage.map(u => u.inputTokens), [6, 2]);
  await Promise.all([drained, terminated]);
  assert.deepEqual(forwarded, [6, 2]);
});

test('C005-02 C014-02 child initial-input failure settles only after rollback cleanup and never charges child', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [usage('source', 2)] });
  host.mergeHook = async () => ({ summary: summary('a + b'), usage: [usage('merge', 4)] });
  const cleanup = deferred();
  host.sendHook = () => { throw new Error('cannot hand over child input'); };
  host.releaseHook = native => { if (native !== host.native(a) && native !== host.native(b)) host.closeGates.set(native, cleanup); };
  const herb = a.herb(b); let rejected = false; void herb.catch(() => { rejected = true; });
  await flush(); assert.equal(rejected, false); assert.equal(host.usageSettlements.length, 0);
  cleanup.resolve(); await assert.rejects(herb, /cannot hand over child input/);
  assert.deepEqual(a.getChildren(), []); assert.equal(host.usageSettlements.length, 1);
  assert.equal(host.usageSettlements[0]!.agent, host.native(a));
  assert.deepEqual(host.usageSettlements[0]!.usage.map(u => u.inputTokens), [2, 2, 4]);
});

test('C014-01 C014-02 concurrent herb calls isolate their ledgers and successful empty usage emits no records', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const pending = [deferred<ContextSummary>(), deferred<ContextSummary>(), deferred<ContextSummary>(), deferred<ContextSummary>()];
  let index = 0; host.summaryHook = () => pending[index++]!.promise;
  const one = a.herb(b); const two = a.herb(b);
  await flush();
  pending[2]!.resolve({ summary: summary('a second'), usage: [usage('second-a', 20)] });
  pending[3]!.resolve({ summary: summary('b second'), usage: [usage('second-b', 21)] });
  const secondChild = await two;
  pending[0]!.reject(new AuxiliaryCallError('first a failure', [usage('first-a', 10)]));
  pending[1]!.resolve({ summary: summary('b first'), usage: [usage('first-b', 11)] });
  await assert.rejects(one);
  assert.equal(host.usageSettlements.length, 2);
  assert.deepEqual(host.usageSettlements.map(record => [record.agent.profile.sessionID, record.usage.map(u => u.inputTokens)]), [[secondChild.getProfile().sessionID, [20, 21]], ['a', [10, 11]]]);
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [] });
  await a.herb(b); assert.equal(host.usageSettlements.length, 2);
});
