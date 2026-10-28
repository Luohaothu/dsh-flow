import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CoreObservation } from '../../../packages/dsh-flow/src/core/observation.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import type { Usage } from '../../../packages/dsh-flow/src/core/types.js';
import { input, runtime } from '../../helpers/contract-runtime.js';

test('real rc.2 SDK cumulative stream samples and durable-before-end settlement replace one main call', async t => {
  const f = await runtime(t), agent = await f.create('stream-usage'), native = f.native(agent), usage: Usage[] = [];
  f.adaptor.subscribe(f.hostAgent(agent), event => { if (event.type === 'usage') usage.push(event.usage); });
  t.mock.method(f.model, 'stream', async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'DONE' };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const order: string[] = [];
  native.ctx.on('session/event', (_session, event) => { if (event.type === 'assistant/message') order.push('durable'); });
  native.ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'end') order.push('end'); });
  await f.adaptor.send(f.hostAgent(agent), input('RUN')); await native.whenIdle();
  assert.deepEqual(order, ['durable', 'end']); assert.equal(usage.length, 2);
  assert.equal(usage[0]!.callId, usage[1]!.callId); assert.equal(usage[0]!.kind, 'main');
  assert.deepEqual(usage.map(item => item.outputTokens), [1, 7]);
  assert.deepEqual(usage[1]!.model, { provider: 'fixture', id: 'model' });
  await f.adaptor.send(f.hostAgent(agent), input('AGAIN')); await native.whenIdle();
  assert.notEqual(usage[1]!.callId, usage[2]!.callId);
});

test('SDK missing usage emits none; failed provider attempt retains exactly one stable usage call', async t => {
  const f = await runtime(t), agent = await f.create('missing-usage'), native = f.native(agent), usage: Usage[] = [];
  f.adaptor.subscribe(f.hostAgent(agent), event => { if (event.type === 'usage') usage.push(event.usage); });
  const stream = t.mock.method(f.model, 'stream', async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  await f.adaptor.send(f.hostAgent(agent), input('RUN')); await native.whenIdle(); assert.equal(usage.length, 0);
  stream.mock.restore(); f.model.failAfterUsage = true;
  await f.adaptor.send(f.hostAgent(agent), input('FAIL')); await native.whenIdle();
  assert.equal(usage.length, 1); assert.ok(usage[0]!.callId); assert.equal(usage[0]!.totalTokens, 20);
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'assistant/attempt'));
});

test('cleanup publishes actual phases and persistence failure before complete', async t => {
  const f = await runtime(t), agent = await f.create('cleanup-persist'), events: CoreObservation[] = [];
  observeCore(f.context, event => { if (event.type === 'host-cleanup') events.push(event); });
  t.mock.method(f.host.sessions, 'flush', async () => false);
  await agent.recvSignal('SIGKILL');
  const facts = events.filter(event => event.type === 'host-cleanup');
  assert.deepEqual(facts.map(event => event.phase), ['pending', 'releasing', 'releasing', 'complete']);
  assert.equal(facts[2]!.reason, 'persistence-failed'); assert.match(facts[3]!.persistenceError!, /durability/);
  assert.ok(facts[1]!.deadline! >= facts[1]!.timestamp);
});

test('cleanup deadline abandonment remains terminal after late native idle', async t => {
  const f = await runtime(t, { immediateTimeoutMs: 15 }), events: CoreObservation[] = [];
  observeCore(f.context, event => { if (event.type === 'host-cleanup') events.push(event); });
  let nativeDisposeStarted = false, finishDisposal!: () => void, failDisposal!: (error: unknown) => void;
  const nativeDisposed = new Promise<void>((resolve, reject) => { finishDisposal = resolve; failDisposal = reject; });
  const createNative = f.host.agents.create.bind(f.host.agents);
  t.mock.method(f.host.agents, 'create', async (options: Parameters<typeof createNative>[0]) => {
    const handle = await createNative(options);
    return { agent: handle.agent, dispose: () => {
      nativeDisposeStarted = true;
      const completion = handle.dispose(); void completion.then(finishDisposal, failDisposal); return completion;
    } };
  });
  const agent = await f.create('cleanup-abandoned'), native = f.native(agent);
  let finishIdle!: () => void, enterPersistence!: () => void, allowPersistence!: () => void;
  const idle = new Promise<void>(resolve => { finishIdle = resolve; });
  const persistenceEntered = new Promise<void>(resolve => { enterPersistence = resolve; });
  const persistenceAllowed = new Promise<void>(resolve => { allowPersistence = resolve; });
  const flush = f.host.sessions.flush.bind(f.host.sessions);
  let flushes = 0;
  t.mock.method(f.host.sessions, 'flush', async (...args: Parameters<typeof flush>) => {
    if (++flushes === 1) { enterPersistence(); await persistenceAllowed; }
    return flush(...args);
  });
  const mock = t.mock.method(native, 'whenIdle', () => idle);
  try {
    await assert.rejects(f.adaptor.releaseAgent(f.hostAgent(agent), 'immediate'), /abandoned/);
    assert.equal(flushes, 0); assert.equal(nativeDisposeStarted, false);
    finishIdle(); mock.mock.restore();
    await persistenceEntered; assert.equal(nativeDisposeStarted, false);
    allowPersistence();
    // The actual SDK disposer runs after persistOwned finishes its write/rename and drains native persistence.
    await nativeDisposed;
    const facts = events.filter(event => event.type === 'host-cleanup');
    assert.equal(facts.at(-1)!.phase, 'abandoned'); assert.equal(facts.at(-1)!.reason, 'immediate-cleanup-timeout');
  } finally {
    finishIdle(); mock.mock.restore(); allowPersistence(); await nativeDisposed;
  }
});

test('real after-turn deadline publishes the upgrade and new immediate deadline before completing', async t => {
  const f = await runtime(t, { afterTurnTimeoutMs: 15, immediateTimeoutMs: 5_000 }), agent = await f.create('cleanup-upgrade'), native = f.native(agent), events: CoreObservation[] = [];
  observeCore(f.context, event => { if (event.type === 'host-cleanup') events.push(event); });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.model.script = options => new Promise<string>(resolve => { started(); options.signal!.addEventListener('abort', () => resolve('cancelled'), { once: true }); });
  await f.adaptor.send(f.hostAgent(agent), input('HOLD')); await entered;
  await agent.recvSignal('SIGTERM'); await native.whenIdle();
  const facts = events.filter(event => event.type === 'host-cleanup');
  assert.deepEqual(facts.map(event => event.phase), ['pending', 'waiting', 'releasing', 'complete']);
  assert.equal(facts[2]!.reason, 'after-turn-timeout'); assert.ok(facts[2]!.deadline! > facts[1]!.deadline!);
});

test('real native approval audit under never policy publishes an explicit automatic rejection', async t => {
  const f = await runtime(t), agent = await f.create('approval-marker'), native = f.native(agent), markers: string[] = [];
  const { registerJsonTool } = await import('../../../packages/dsh-flow/src/host/tools.js');
  f.adaptor.subscribe(f.hostAgent(agent), event => { if (event.type === 'auto-reject') markers.push(event.message); });
  registerJsonTool(native.ctx, 'approval_marker_probe', 'Ask for escalation', { type: 'object', properties: {} }, async (_args, execution) => {
    return f.host.approval.request({ agent: native, toolName: 'approval_marker_probe', callId: execution.callId, reason: 'Needs explicit escalation', signal: execution.signal });
  });
  f.model.script = (_options, index) => index === 0 ? { tool: 'approval_marker_probe', args: {} } : 'DONE';
  await f.adaptor.send(f.hostAgent(agent), input('ASK')); await native.whenIdle();
  assert.deepEqual(markers, ['approval_marker_probe: Needs explicit escalation']);
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'rejected'));
});
