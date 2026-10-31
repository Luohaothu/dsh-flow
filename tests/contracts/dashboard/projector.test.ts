import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { Agent, Group } from '../../../packages/dsh-flow/src/core/index.js';
import { beginConstruction } from '../../../packages/dsh-flow/src/core/construction.js';
import { agentControl, createOwned } from '../../../packages/dsh-flow/src/core/internals.js';
import { describeWait } from '../../../packages/dsh-flow/src/core/message.js';
import { getAgentAppearance, getAgentInstanceId, observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { readJournal } from '../../../packages/dsh-flow/src/dashboard/events.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import type { RunEvent } from '../../../packages/dsh-flow/src/dashboard/protocol.js';
import { deferred, flush, message, profile } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

async function setup(t: Parameters<typeof runFixture>[0], late = false) {
  const f = await runFixture(t); const directory = join(f.directory, 'dashboard');
  const projector = late ? undefined : new DashboardProjector(f.service, { directory });
  const run = await f.createActive();
  const p = projector ?? new DashboardProjector(f.service, { directory }); t.after(() => p.dispose());
  return { ...f, run, p, directory, ...f.binding(run) };
}

test('projector publishes committed instance births before all facts under synchronous termination and retains tombstones', async t => {
  const f = await setup(t); const scope = beginConstruction(f.context, f.root);
  const one = await Agent[createOwned](scope, profile('one'), f.root);
  const two = await Agent[createOwned](scope, profile('two'), one);
  assert.equal(getAgentAppearance(one), undefined); const id = getAgentInstanceId(one);
  const cursor = f.p.snapshot(f.run.id).seq; const seen: RunEvent[] = [];
  f.p.subscribeRun(f.run.id, cursor, f.service.epoch, event => seen.push(event));
  observeCore(f.context, event => { if (event.type === 'agent-created' && event.agent === one) void f.root.recvSignal('SIGKILL'); });
  const drain = scope.commit(); assert.equal(getAgentAppearance(one)!.id, id); drain(); await f.context.dispose();
  for (const agent of [one, two]) {
    const events = seen.filter((event): event is Extract<RunEvent, { node: unknown }> => 'node' in event && event.node.id === getAgentInstanceId(agent));
    assert.equal(events[0]!.type, 'node-appeared');
    assert.equal(events.filter(event => event.type === 'node-terminated').length, 1);
    assert.equal(f.p.snapshot(f.run.id).nodes.find(node => node.id === getAgentInstanceId(agent))!.status, 'terminated');
  }
});

test('owner abort never exposes a node or appearance; same SessionID resume has a new instance', async t => {
  const f = await setup(t); const scope = beginConstruction(f.context, f.root);
  const child = await Agent[createOwned](scope, profile('aborted'), f.root); const hidden = getAgentInstanceId(child); await scope.abort();
  assert.equal(getAgentAppearance(child), undefined); assert.equal(f.p.snapshot(f.run.id).nodes.some(node => node.id === hidden), false);
  const previous = await Agent.create(f.context, profile('saved'), f.root); await f.host.persist(f.host.native(previous));
  await previous.recvSignal('SIGTERM'); const resumed = await Agent.resume(f.context, f.root, previous.getProfile().sessionID);
  assert.notEqual(getAgentInstanceId(previous), getAgentInstanceId(resumed));
  const records = f.p.snapshot(f.run.id).nodes.filter(node => node.sessionID === 'saved');
  assert.equal(records.length, 2); assert.equal(records[0]!.outcome, 'stopped'); assert.equal(records[1]!.source.kind, 'resume');
  assert.equal(records[1]!.source.resumeSessionID, 'saved');
});

test('snapshot restores waits, mailbox and real blackboard activity without consuming messages', async t => {
  const f = await setup(t); const peer = await Agent.create(f.context, profile('peer'), f.root); const group = new Group(f.context, [f.root, peer]);
  f.root.wait(describeWait(() => false, '等待 peer 的结果'), 10000);
  f.root.getMailbox().setSourcePriority(peer, 'high'); f.root.recvMessage(message('优先反馈', peer)); await flush();
  let node = f.p.snapshot(f.run.id).nodes.find(node => node.id === getAgentInstanceId(f.root))!;
  assert.equal(node.status, 'running'); assert.equal(node.waiting!.target, '等待 peer 的结果'); assert.equal(node.messages[0]!.read, false);
  let during = false;
  const unsubscribe = f.p.subscribeRun(f.run.id, f.p.snapshot(f.run.id).seq, f.service.epoch, event => { if ('node' in event && event.node.blackboardWrites.length) { during = true; assert.equal(f.p.snapshot(f.run.id).nodes.find(node => node.id === getAgentInstanceId(peer))!.blackboardWrites.length, 1); } });
  group.postToBlackboard(peer, message('黑板记录', peer, 100, { value: ['kept'] })); unsubscribe(); assert.equal(during, true);
  await f.context.release(group); await peer.recvSignal('SIGTERM');
  const snapshot = f.p.snapshot(f.run.id); assert.equal(snapshot.groups[0]!.dissolved, true); assert.deepEqual(snapshot.groups[0]!.blackboard[0]!.payload, { value: ['kept'] });
  node = snapshot.nodes.find(node => node.id === getAgentInstanceId(f.root))!; assert.equal(node.messages[0]!.read, false); assert.equal(f.root.getMailbox().query()[0]!.read, false);
  const json = JSON.parse(JSON.stringify(snapshot)); assert.deepEqual(json.nodes[0].messages[0].source.agentId, getAgentInstanceId(peer));
  node.messages[0]!.summary = 'mutated'; assert.equal(f.p.snapshot(f.run.id).nodes[0]!.messages[0]!.summary, '优先反馈');
});

test('usage replaces call sampling and unknown pricing stays unavailable', async t => {
  const f = await setup(t); const { run, root, context, host } = f; const peer = await Agent.create(context, profile('gone'), root);
  const group = new Group(context, [root, peer]); group.postToBlackboard(peer, message('历史黑板', peer)); root.recvMessage(message('历史消息', peer)); await peer.recvSignal('SIGTERM'); await context.release(group);
  const p = f.p;
  assert.equal(p.snapshot(run.id).nodes.length, 2); assert.equal(p.snapshot(run.id).groups[0]!.blackboard.length, 1);
  for (const totalTokens of [10, 20, 20]) host.emit({ type: 'usage', agent: host.native(root), timestamp: Date.now(), usage: { callId: 'main:1', kind: 'main', timestamp: Date.now(), model: root.getProfile().model, inputTokens: 5, outputTokens: 15, totalTokens } });
  host.emit({ type: 'usage', agent: host.native(root), timestamp: Date.now(), usage: { callId: 'aux:1', kind: 'auxiliary', timestamp: Date.now(), model: root.getProfile().model, totalTokens: 2 } });
  const usage = p.snapshot(run.id).nodes[0]!.usage; assert.equal(usage.length, 2); assert.equal(usage[0]!.totalTokens, 20); assert.equal(usage[0]!.amount, null);
  assert.equal(readFileSync(join(f.directory, 'runs', `${run.id}.${f.service.epoch}.jsonl`), 'utf8').includes('node-usage'), true);
});

test('registry and per-run cursors are independent; replay listener reentry loses no event', async t => {
  const f = await setup(t); const registry = f.p.registry(); const snapshot = f.p.snapshot(f.run.id); const child = await Agent.create(f.context, profile('replay'), f.root);
  assert.ok(f.p.registry().seq > registry.seq); assert.ok(f.p.snapshot(f.run.id).seq > snapshot.seq);
  const navigation = f.p.registry().seq, history = f.p.snapshot(f.run.id).seq;
  f.host.emit({ type: 'output', agent: f.host.native(child), timestamp: Date.now(), text: 'history only' });
  f.host.emit({ type: 'usage', agent: f.host.native(child), timestamp: Date.now(), usage: { callId: 'nav-usage', kind: 'main', timestamp: Date.now(), model: child.getProfile().model, totalTokens: 1 } });
  assert.equal(f.p.registry().seq, navigation); assert.ok(f.p.snapshot(f.run.id).seq > history);
  f.host.status(child, 'running');
  const beforeMessages = f.p.registry().seq, beforeHistory = f.p.snapshot(f.run.id).seq;
  child.recvMessage(message('message-only while already running')); await flush(); child.getMailbox().getLastUnread();
  assert.equal(f.p.registry().seq, beforeMessages); assert.ok(f.p.snapshot(f.run.id).seq > beforeHistory);
  const events: number[] = []; let reentered = false;
  f.p.subscribeRun(f.run.id, snapshot.seq, f.service.epoch, event => { events.push(event.seq); if (!reentered) { reentered = true; child.recvMessage(message('during replay')); } });
  assert.deepEqual(events, [...new Set(events)].sort((a, b) => a - b)); assert.equal(events.at(-1), f.p.snapshot(f.run.id).seq);
  assert.throws(() => f.p.subscribeRun(f.run.id, events.at(-1)! + 1, f.service.epoch, () => {}));
  assert.throws(() => f.p.subscribeRun(f.run.id, 0, 'other-epoch', () => {}));
});

test('journal outage keeps projection truth, resets subscribers and requires a snapshot baseline', async t => {
  const f = await setup(t); const baseline = f.p.snapshot(f.run.id); const path = join(f.directory, 'runs'); const backup = join(f.directory, 'runs-unavailable');
  let resets = 0; f.p.observeReset(runId => { if (runId === f.run.id) resets++; });
  renameSync(path, backup); writeFileSync(path, 'storage unavailable'); f.root.recvMessage(message('storage outage'));
  assert.ok(resets > 0); const degraded = f.p.snapshot(f.run.id); assert.equal(degraded.degraded, true); assert.equal(degraded.nodes[0]!.messages[0]!.summary, 'storage outage');
  assert.throws(() => f.p.subscribeRun(f.run.id, baseline.seq, f.service.epoch, () => {}));
  rmSync(path); renameSync(backup, path); const recovered = f.p.snapshot(f.run.id); assert.equal(recovered.degraded, undefined);
  assert.deepEqual(readJournal(path, f.run.id, f.service.epoch).state, recovered);
  assert.throws(() => f.p.subscribeRun(f.run.id, baseline.seq, f.service.epoch, () => {}));
  const seen: RunEvent[] = []; f.p.subscribeRun(f.run.id, recovered.seq, f.service.epoch, event => seen.push(event)); f.root.recvMessage(message('after recovery')); assert.ok(seen.length > 0);
});


test('projector explicitly refuses a late attachment that cannot restore prior domain facts', async t => {
  const f = await runFixture(t); await f.createActive();
  assert.throws(() => new DashboardProjector(f.service, { directory: join(f.directory, 'late') }), /before Context initialization/);
});

test('failed initial handover records failure while explicit parent cancellation takes priority over prior errors', async t => {
  const f = await setup(t); f.host.sendHook = record => { if (record.purpose === 'input') throw new Error('handover failed'); };
  await assert.rejects(Agent.create(f.context, profile('failed-input'), f.root, message('初始输入')), /handover failed/);
  const failed = f.p.snapshot(f.run.id).nodes.find(node => node.sessionID === 'failed-input')!;
  assert.equal(failed.outcome, 'failed'); assert.equal(failed.termination!.initiator, 'self');
  const child = await Agent.create(f.context, profile('cancelled'), f.root);
  f.host.emit({ type: 'error', agent: f.host.native(child), timestamp: Date.now(), message: 'earlier error' });
  await f.root.kill(child);
  const cancelled = f.p.snapshot(f.run.id).nodes.find(node => node.id === getAgentInstanceId(child))!;
  assert.equal(cancelled.outcome, 'stopped'); assert.equal(cancelled.termination!.initiator, 'parent'); assert.equal(cancelled.errors.length, 1);
});

test('completed turns preserve normal status, output and host events without warning markers', async t => {
  const f = await setup(t); let completed = 0;
  const unsubscribe = observeCore(f.context, event => {
    if (event.type === 'host-event' && event.event.type === 'turn-end' && event.event.reason === 'completed') completed++;
  }); t.after(unsubscribe);
  f.host.status(f.root, 'running');
  f.host.emit({ type: 'output', agent: f.host.native(f.root), timestamp: Date.now(), text: '正常结果' });
  f.host.status(f.root, 'idle'); f.host.turnEnd(f.root); await flush();
  let node = f.p.snapshot(f.run.id).nodes[0]!;
  assert.equal(node.status, 'idle'); assert.equal(node.outcome, null);
  assert.deepEqual(node.markers, []); assert.equal(node.outputs[0]!.text, '正常结果'); assert.equal(completed, 1);
  await f.root.recvSignal('SIGTERM');
  node = f.p.snapshot(f.run.id).nodes[0]!;
  assert.equal(node.outcome, 'stopped'); assert.equal(node.termination!.initiator, 'user'); assert.deepEqual(node.markers, []);
});

test('abnormal turns and existing error, rejection and cleanup warnings survive later completed turns', async t => {
  const f = await setup(t), native = f.host.native(f.root), timestamp = Date.now();
  const { emitCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  f.host.emit({ type: 'turn-end', agent: native, timestamp, reason: 'cancelled' });
  f.host.emit({ type: 'turn-end', agent: native, timestamp: timestamp + 1, reason: 'failed' });
  f.host.emit({ type: 'error', agent: native, timestamp: timestamp + 2, message: '实际错误' });
  f.host.emit({ type: 'auto-reject', agent: native, timestamp: timestamp + 3, message: '策略拒绝' });
  emitCore(f.context, { type: 'host-cleanup', agent: f.root, timestamp: timestamp + 4, phase: 'abandoned', reason: '未能完成清理' });
  emitCore(f.context, { type: 'host-cleanup', agent: f.root, timestamp: timestamp + 5, phase: 'failed', persistenceError: '持久化失败' });
  const before = f.p.snapshot(f.run.id).nodes[0]!;
  assert.deepEqual(before.markers.map(marker => marker.kind), ['turn-cancelled', 'turn-failed', 'error', 'auto-reject', 'cleanup-abandoned', 'persistence-error']);
  f.host.emit({ type: 'turn-end', agent: native, timestamp: timestamp + 6, reason: 'completed' });
  const after = f.p.snapshot(f.run.id).nodes[0]!;
  assert.deepEqual(after.markers, before.markers);
  assert.deepEqual(after.errors, [{ timestamp: timestamp + 2, message: '实际错误' }]);
  assert.equal(after.cleanup!.phase, 'failed'); assert.equal(after.cleanup!.persistenceError, '持久化失败');
});

test('cleanup retains abandonment and persistence markers after subsequent facts; typed auto-reject is independent of errors', async t => {
  const f = await setup(t); const { emitCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const timestamp = Date.now();
  emitCore(f.context, { type: 'host-cleanup', agent: f.root, timestamp, phase: 'abandoned', reason: 'deadline elapsed', deadline: timestamp, persistenceError: 'disk failed' });
  emitCore(f.context, { type: 'host-cleanup', agent: f.root, timestamp: timestamp + 1, phase: 'failed', reason: 'cleanup failed' });
  f.host.emit({ type: 'auto-reject', agent: f.host.native(f.root), timestamp: timestamp + 2, message: 'tool denied by policy' });
  const node = f.p.snapshot(f.run.id).nodes[0]!;
  assert.equal(node.cleanup!.phase, 'failed'); assert.equal(node.errors.length, 0);
  assert.ok(node.markers.some(marker => marker.kind === 'cleanup-abandoned' && marker.message === 'disk failed'));
  assert.ok(node.markers.some(marker => marker.kind === 'auto-reject'));
});

test('price calculation uses the actual model, cache portions and per-million token units', async t => {
  const f = await runFixture(t); const model = { provider: 'actual', id: 'used-model' };
  const p = new DashboardProjector(f.service, { directory: join(f.directory, 'priced'), prices: [{ model, currency: 'CNY', input: 2, output: 4, cacheRead: 1, cacheWrite: 3 }] }); t.after(() => p.dispose());
  const run = await f.createActive(); const { host, root } = f.binding(run);
  host.emit({ type: 'usage', agent: host.native(root), timestamp: 1, usage: { callId: 'priced', timestamp: 1, model, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 100_000, cacheWriteTokens: 200_000, totalTokens: 2_000_000 } });
  const usage = p.snapshot(run.id).nodes[0]!.usage[0]!; assert.equal(usage.amount, 6.1); assert.equal(usage.currency, 'CNY'); assert.deepEqual(usage.model, model);
});


test('a new run stays real and observable when its journal directory cannot initialize', async t => {
  const f = await runFixture(t); const directory = join(f.directory, 'per-run-outage');
  const p = new DashboardProjector(f.service, { directory }); t.after(() => p.dispose());
  const blocker = join(directory, 'runs'); writeFileSync(blocker, 'unavailable directory');
  const run = await f.createActive();
  const failed = p.snapshot(run.id); assert.equal(failed.degraded, true); assert.equal(failed.nodes.length, 1); assert.equal(failed.run.status, 'active');
  rmSync(blocker); const recovered = p.snapshot(run.id); assert.equal(recovered.degraded, undefined); assert.equal(recovered.nodes[0]!.id, failed.nodes[0]!.id);
});

test('blackboard display payload is valid JSON even for cyclic structured domain data', async t => {
  const f = await setup(t); const group = new Group(f.context, [f.root]);
  const payload: { count: bigint; nested: Map<string, Set<number>>; self?: unknown } = { count: 12n, nested: new Map([['set', new Set([1, 2])]]) }; payload.self = payload;
  group.postToBlackboard(f.root, message('结构化数据', f.root, 1, payload));
  const snapshot = f.p.snapshot(f.run.id); const data = snapshot.groups[0]!.blackboard[0]!.payload;
  assert.doesNotThrow(() => JSON.stringify(snapshot)); assert.deepEqual(JSON.parse(JSON.stringify(data)), { count: { $type: 'bigint', value: '12' }, nested: { $type: 'map', entries: [['set', { $type: 'set', values: [1, 2] }]] }, self: { $ref: '#' } });
  assert.equal(snapshot.degraded, undefined);
});


test('aborted pending native initialization can never publish its captured instance identity', async t => {
  const f = await setup(t); const scope = beginConstruction(f.context, f.root); const gate = deferred(); let candidate!: Agent;
  f.host.createHook = flow => { candidate = flow; return gate.promise; };
  const creating = Agent[createOwned](scope, profile('never-published'), f.root); const failed = assert.rejects(creating);
  const id = getAgentInstanceId(candidate); assert.equal(getAgentAppearance(candidate), undefined);
  const aborted = scope.abort(); gate.resolve(); await Promise.all([failed, aborted]);
  assert.equal(getAgentInstanceId(candidate), id); assert.equal(getAgentAppearance(candidate), undefined); assert.equal(f.p.snapshot(f.run.id).nodes.some(node => node.id === id), false);
});

test('retry appears with failed UUID provenance under the last parent while the source card remains historical', async t => {
  const f = await setup(t);
  const adopt = await Agent.create(f.context, profile('retry-parent'), f.root); const source = await Agent.create(f.context, profile('failed-source'), f.root);
  f.root.transfer(source, adopt);
  f.host.emit({ type: 'error', agent: f.host.native(source), timestamp: Date.now(), message: 'source failed' }); await source[agentControl].release('SIGTERM', 'self');
  const sourceId = getAgentInstanceId(source); const before = f.p.snapshot(f.run.id);
  const seen: RunEvent[] = []; f.p.subscribeRun(f.run.id, before.seq, f.service.epoch, event => seen.push(event));
  const retry = await adopt[agentControl].retry(profile('retry-child'), sourceId, message('retry input'));
  const snapshot = f.p.snapshot(f.run.id); const old = snapshot.nodes.find(node => node.id === sourceId)!; const fresh = snapshot.nodes.find(node => node.id === getAgentInstanceId(retry))!;
  assert.equal(old.status, 'terminated'); assert.equal(old.outcome, 'failed'); assert.equal(old.parentId, getAgentInstanceId(adopt));
  assert.equal(fresh.source.kind, 'retry'); assert.deepEqual(fresh.source.sourceIds, [sourceId]); assert.equal(fresh.parentId, getAgentInstanceId(adopt));
  const changes = seen.filter(event => 'node' in event && event.node.id === fresh.id); assert.equal(changes[0]!.type, 'node-appeared');
  assert.equal(JSON.parse(JSON.stringify(snapshot)).nodes.find((node: { id: string }) => node.id === fresh.id).source.sourceIds[0], sourceId);
});
