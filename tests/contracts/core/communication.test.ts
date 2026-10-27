import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context, Group } from '../../../packages/dsh-flow/src/core/index.js';
import { ContractHost, deferred, flush, message, profile } from '../../helpers/contract-host.js';

async function setup() {
  const ctx = new Context(); const host = new ContractHost(); ctx.registerHostAdaptor(host);
  const a = await Agent.create(ctx, profile('receiver'), null); const b = await Agent.create(ctx, profile('sender'), null);
  const c = await Agent.create(ctx, profile('other sender'), null);
  return { ctx, host, a, b, c };
}
const text = (host: ContractHost, n = 0) => String(host.sent[n]?.message.payload);

test('C018-01 C018-02 C019-02 idle normal notification uses meta only, requests first rating and leaves body unread', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  a.recvMessage(message('requested answer', b, 1, { secret: 'body must stay in Mailbox' }));
  await flush();
  const id = a.getMailbox().query()[0]!.id;
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'followup'); assert.equal(host.sent[0]!.purpose, 'notification');
  assert.deepEqual(host.sent[0]!.message.source, { kind: 'system' });
  assert.equal(host.sent[0]!.message.priority, 'normal');
  assert.ok(text(host).includes(`[${id}]`)); assert.ok(text(host).includes('sender'));
  assert.ok(text(host).includes('requested answer')); assert.equal(text(host).includes('body must stay'), false);
  assert.ok(text(host).includes('setSourcePriority')); assert.ok(text(host).includes('后续可随时调整'));
  assert.equal(a.getMailbox().peak(id)?.read, false);
  host.status(a, 'running'); a.recvMessage(message('next', b, 2));
  host.status(a, 'idle'); host.turnEnd(a); await flush();
  assert.equal(host.sent.length, 2); assert.equal(text(host, 1).includes('setSourcePriority'), false);
  assert.equal(a.getMailbox().getSourcePriority(b), null);
  assert.equal(a.getMailbox().get(id)?.read, true);
});

test('C018-01 C019-01 C019-02 turn-end batches same-source normal entries with low count and one rating prompt', async t => {
  const { ctx, host, a, b, c } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running');
  a.getMailbox().setSourcePriority(c, 'low');
  a.recvMessage(message('first', b, 1)); a.recvMessage(message('second', b, 2));
  a.recvMessage(message('unimportant detail', c, 3));
  assert.equal(host.sent.length, 0);
  host.status(a, 'idle'); await flush(); assert.equal(host.sent.length, 0);
  host.turnEnd(a); assert.equal(host.sent.length, 0); await flush();
  assert.equal(host.sent.length, 1); assert.equal(host.sent[0]!.mode, 'followup');
  assert.ok(text(host).includes('first')); assert.ok(text(host).includes('second'));
  assert.ok(text(host).includes('不重要消息：1 条')); assert.equal(text(host).includes('unimportant detail'), false);
  assert.equal((text(host).match(/setSourcePriority/g) ?? []).length, 1);
  host.turnEnd(a); await flush(); assert.equal(host.sent.length, 1);
});

test('C019-01 low-only messages form a normal followup batch', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  a.getMailbox().setSourcePriority(b, 'low');
  a.recvMessage(message('do not expose low summary', b)); await flush();
  assert.equal(host.sent.length, 1); assert.equal(host.sent[0]!.mode, 'followup');
  assert.equal(host.sent[0]!.message.priority, 'normal');
  assert.ok(text(host).includes('不重要消息：1 条')); assert.equal(text(host).includes('do not expose low summary'), false);
});

test('C019-03 in-flight notification fixes its range and a later arrival appears once in a later batch', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const handover = deferred(); let sends = 0;
  host.sendHook = () => { if (++sends === 1) return handover.promise; };
  a.recvMessage(message('first range', b, 1)); await flush();
  a.recvMessage(message('second range', b, 2)); await flush();
  assert.equal(host.sent.length, 1); assert.equal(text(host).includes('second range'), false);
  handover.resolve(); await flush();
  host.turnEnd(a); await flush();
  assert.equal(host.sent.length, 2);
  assert.equal(text(host, 1).includes('first range'), false); assert.ok(text(host, 1).includes('second range'));
  host.turnEnd(a); await flush(); assert.equal(host.sent.length, 2);
});

test('C018-02 C019-03 rejected notification retains pending messages and first-rating prompt until retry succeeds', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  let fail = true;
  host.sendHook = () => { if (fail) throw new Error('handover rejected'); };
  a.recvMessage(message('retry this', b)); await flush();
  assert.equal(host.sent.length, 1);
  assert.ok(text(host).includes('setSourcePriority'));
  fail = false; host.turnEnd(a); await flush();
  assert.equal(host.sent.length, 2); assert.ok(text(host, 1).includes('retry this')); assert.ok(text(host, 1).includes('setSourcePriority'));
  assert.equal(a.getMailbox().query()[0]!.read, false);
  host.turnEnd(a); await flush(); assert.equal(host.sent.length, 2);
});

test('C004-01 C015-01 existing matching AgentInGroup message returns metadata and consumes only pending notification', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running');
  const group = new Group(ctx, [a, b]); group.postMessage(b, message('group result'));
  const result = a.wait(m => 'g' in m.source && m.source.g === group, 500);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') {
    assert.equal(result.message.summary, 'group result'); assert.deepEqual(result.message.source, { agent: b, g: group });
    assert.equal('payload' in result.message, false); assert.equal(result.message.read, false);
  }
  assert.equal(a.hasPendingWait(), false); assert.equal(a.getStatus(), 'running');
  host.turnEnd(a); await flush(); assert.equal(host.sent.length, 0);
  assert.equal(a.getMailbox().query()[0]!.read, false);
});

test('C015-02 C015-03 registered wait is immediate, valid only once and uses a finite positive duration', async t => {
  const { ctx, a } = await setup(); t.after(() => ctx.dispose());
  for (const duration of [0, -1, NaN, Infinity, -Infinity]) assert.throws(() => a.wait(() => false, duration));
  assert.equal(a.hasPendingWait(), false);
  assert.deepEqual(a.wait(() => false, 2_000), { kind: 'registered' });
  assert.equal(a.hasPendingWait(), true); assert.equal(a.getStatus(), 'waiting');
  assert.throws(() => a.wait(() => true, 100)); assert.equal(a.hasPendingWait(), true);
});

test('C004-01 C017-01 unrelated high notification temporarily runs without clearing the original wait', async t => {
  const { ctx, host, a, b, c } = await setup(); t.after(() => ctx.dispose());
  a.getMailbox().setSourcePriority(c, 'high');
  a.wait(m => m.source === b, 5_000);
  host.status(a, 'idle'); assert.equal(a.getStatus(), 'waiting');
  a.recvMessage(message('ordinary deferred', { kind: 'user' }));
  await flush(); assert.equal(host.sent.length, 0);
  a.recvMessage(message('urgent but unrelated', c)); await flush();
  assert.equal(host.sent.length, 1); assert.equal(host.sent[0]!.mode, 'steer');
  assert.equal(host.sent[0]!.message.priority, 'high');
  host.status(a, 'running'); assert.equal(a.getStatus(), 'running'); assert.equal(a.hasPendingWait(), true);
  host.status(a, 'idle'); host.turnEnd(a); await flush();
  assert.equal(a.getStatus(), 'waiting'); assert.equal(a.hasPendingWait(), true); assert.equal(host.sent.length, 1);
});

test('C020-01 C020-02 matching low message leads a completion batch and preserves deferred message ratings', async t => {
  const { ctx, host, a, b, c } = await setup(); t.after(() => ctx.dispose());
  a.getMailbox().setSourcePriority(b, 'low');
  a.wait(m => m.source === b, 5_000);
  a.recvMessage(message('normal deferred', c, 1));
  a.recvMessage(message('low matched', b, 2)); await flush();
  assert.equal(a.hasPendingWait(), false); assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'followup'); assert.equal(host.sent[0]!.purpose, 'notification');
  assert.ok(text(host).includes('low matched')); assert.ok(text(host).includes('normal deferred'));
  assert.ok(text(host).indexOf('low matched') < text(host).indexOf('normal deferred'));
  assert.equal(a.getMailbox().query()[1]!.priority, 'low');
  assert.ok(a.getMailbox().query().every(m => !m.read));
  host.turnEnd(a); await flush(); assert.equal(host.sent.length, 1);
});

test('C020-01 high match uses steer and completes one pending wait', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  a.getMailbox().setSourcePriority(b, 'high'); a.wait(m => m.source === b, 500);
  a.recvMessage(message('urgent matching result', b)); await flush();
  assert.equal(a.hasPendingWait(), false); assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'steer'); assert.ok(text(host).includes('urgent matching result'));
});

test('C020-02 a reentrant new wait cannot block the completion notification already formed for the old wait', async t => {
  const { ctx, host, a, b, c } = await setup(); t.after(() => ctx.dispose());
  a.wait(m => m.source === b, 500); a.recvMessage(message('deferred before match', c));
  a.recvMessage(message('finished previous wait', b));
  assert.deepEqual(a.wait(m => m.summary === 'future result', 5_000), { kind: 'registered' });
  await flush();
  assert.equal(a.hasPendingWait(), true); assert.equal(host.sent.length, 1);
  assert.ok(text(host).includes('finished previous wait')); assert.ok(text(host).includes('deferred before match'));
});

test('C015-02 matching arrival during query callback is not lost between the initial scan and wait registration', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running'); a.recvMessage(message('existing nonmatch', b, 1));
  let injected = false;
  a.wait(m => {
    if (!injected) { injected = true; a.recvMessage(message('arrived in query', b, 2)); }
    return m.summary === 'arrived in query';
  }, 5_000);
  await flush();
  assert.equal(a.hasPendingWait(), false);
  assert.equal(a.getMailbox().count(), 2);
  assert.equal(a.getMailbox().query().find(m => m.summary === 'arrived in query')?.read, false);
});

test('C015-03 reentrant termination in a wait predicate cannot resurrect a waiting terminated Agent', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running'); a.recvMessage(message('inspect', b));
  assert.throws(() => a.wait(() => { void a.recvSignal('SIGKILL'); return false; }, 5_000));
  assert.equal(a.getStatus(), 'terminated'); assert.equal(a.hasPendingWait(), false);
});

test('C016-01 C016-02 timeout emits one high System steer with duration/time; old timeout cannot finish a new wait', async t => {
  const { ctx, host, a, b } = await setup();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  t.after(async () => { await ctx.dispose(); t.mock.timers.reset(); });
  a.wait(m => m.source === b, 100);
  t.mock.timers.tick(99); assert.equal(a.hasPendingWait(), true); assert.equal(host.sent.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(a.hasPendingWait(), false); assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'steer'); assert.equal(host.sent[0]!.purpose, 'notification');
  assert.deepEqual(host.sent[0]!.message.source, { kind: 'system' }); assert.equal(host.sent[0]!.message.priority, 'high');
  assert.match(text(host), /100/); assert.match(text(host), /10000|10:|1970/); assert.match(text(host), /超时/);
  a.wait(m => m.source === b, 200);
  t.mock.timers.tick(100); assert.equal(a.hasPendingWait(), true);
  a.recvMessage(message('matched second wait', b)); await flush(); assert.equal(a.hasPendingWait(), false);
  const sent = host.sent.length;
  a.wait(m => m.summary === 'third', 1_000);
  t.mock.timers.tick(100); await flush(); assert.equal(a.hasPendingWait(), true); assert.equal(host.sent.length, sent);
  await a.recvSignal('SIGTERM'); t.mock.timers.tick(2_000); await flush(); assert.equal(host.sent.length, sent);
});

test('C016-02 match processed at its deadline yields one timeout completion and no duplicate notification', async t => {
  const { ctx, host, a, b } = await setup();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 20_000 });
  t.after(async () => { await ctx.dispose(); t.mock.timers.reset(); });
  a.wait(m => m.source === b, 100); t.mock.timers.tick(100);
  a.recvMessage(message('late match', b)); await flush();
  assert.equal(a.hasPendingWait(), false);
  assert.equal(host.sent.filter(s => s.mode === 'steer' && String(s.message.payload).includes('超时')).length, 1);
  t.mock.timers.tick(1_000); await flush();
  assert.equal(host.sent.filter(s => s.mode === 'steer' && String(s.message.payload).includes('超时')).length, 1);
});

test('C004-02 C009-01 C026-02 reentrant filter termination cannot accept a late message or generate notification', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  a.getMailbox().setFilters([() => { void a.recvSignal('SIGKILL'); return false; }]);
  assert.throws(() => a.recvMessage(message('terminating filter callback', b)));
  await flush();
  assert.equal(a.getStatus(), 'terminated'); assert.equal(a.hasPendingWait(), false);
  assert.equal(host.sent.length, 0);
});

test('C015-02 C020-01 nested high matching arrival completes waiting before ordinary high notification dispatch', async t => {
  const { ctx, host, a, b, c } = await setup(); t.after(() => ctx.dispose());
  host.status(a, 'running');
  a.getMailbox().setSourcePriority(b, 'high');
  let injected = false;
  a.wait(m => {
    if (!injected) { injected = true; a.recvMessage(message('nested matching high', b, 2)); }
    return m.summary === 'nested matching high';
  }, 1_000);
  a.recvMessage(message('first nonmatching arrival', c, 1));
  await flush();
  const id = a.getMailbox().query(m => m.summary === 'nested matching high')[0]!.id;
  assert.equal(a.hasPendingWait(), false);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'steer');
  assert.ok(text(host).includes(`[${id}]`));
  assert.ok(text(host).includes('nested matching high'));
  assert.equal(a.getMailbox().peak(id)?.read, false);
});

test('C015-02 C016-01 timeout starts at registration after the synchronous existing-message scan', async t => {
  const { ctx, host, a, b } = await setup();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 30_000 });
  t.after(async () => { await ctx.dispose(); t.mock.timers.reset(); });
  host.status(a, 'running'); a.recvMessage(message('existing', b));
  let scanned = false;
  assert.deepEqual(a.wait(() => {
    if (!scanned) { scanned = true; t.mock.timers.tick(50); }
    return false;
  }, 100), { kind: 'registered' });
  t.mock.timers.tick(99); await flush();
  assert.equal(a.hasPendingWait(), true); assert.equal(host.sent.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(a.hasPendingWait(), false); assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.mode, 'steer'); assert.match(text(host), /100/);
});
