import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createUserMessage, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Agent, type HostEvent } from '../../../packages/dsh-flow/src/core/index.js';
import { sessionID, markWaitCompletion } from '../../../packages/dsh-flow/src/core/message.js';
import { AuxiliaryCallError } from '../../../packages/dsh-flow/src/core/auxiliary-usage.js';
import { ExecutionCapacity } from '../../../packages/dsh-flow/src/host/index.js';
import { registerJsonTool } from '../../../packages/dsh-flow/src/host/tools.js';
import { runtime, input, profile, until, validSummary } from '../../helpers/contract-runtime.js';

const text = (options: GenerateOptions) => options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
const user = (value: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('C002-02 C031-01: unknown HostExtras fields reject before actual native creation', async t => {
  const f = await runtime(t), create = t.mock.method(f.host.agents, 'create');
  for (const hostExtras of [{ unexpected: true, dsh: { stop: ['END'] } }, { dsh: { stop: ['END'], unexpected: true } }]) {
    const p = { ...profile('unknown-extra'), hostExtras };
    await assert.rejects(Agent.create(f.context, p, null), /unexpected/);
    assert.equal(create.mock.callCount(), 0);
    assert.equal(f.host.agents.get(SessionId(p.sessionID)), undefined);
  }
  const agent = await Agent.create(f.context, { ...profile('known-extra'), hostExtras: { dsh: { stop: ['END'] } } }, null);
  await f.adaptor.send(f.hostAgent(agent), input('KNOWN-EXTRA')); await f.native(agent).whenIdle();
  assert.deepEqual(f.model.requests[0]?.stop, ['END']);
});

test('C007-01 C031-01: cold resume uses saved effective config after provider defaults change', async t => {
  const f = await runtime(t);
  let defaultMaxTokens = 600;
  let defaultEffort = ReasoningEffortId('medium');
  f.model.resolveModel = async (provider, id) => ({ provider, id, name: 'Defaults', defaultMaxTokens,
    reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort } });
  const p = profile('persist-defaults'); p.params = { version: 1 }; p.hostExtras = { dsh: { stop: ['END'] } };
  const agent = await Agent.create(f.context, p, null), original = structuredClone(f.native(agent).options);
  assert.equal(original.maxTokens, 600);
  await f.context.release(agent); defaultMaxTokens = 1200; defaultEffort = ReasoningEffortId('high');
  const resumed = await Agent.resume(f.context, null, p.sessionID), native = f.native(resumed);
  assert.deepEqual(native.options, original);
  assert.deepEqual(resumed.getProfile(), p);
  await f.adaptor.send(f.hostAgent(resumed), input('RESUMED')); await native.whenIdle();
  assert.equal(f.model.requests[0]?.maxTokens, 600);
  assert.equal(f.model.requests[0]?.reasoningEffort, 'medium');
  assert.deepEqual(f.model.requests[0]?.stop, ['END']);
});

test('C007-01 C031-01: invalid or no longer supported saved configs reject before native resume', async t => {
  const cases: { name: string; edit: (config: Record<string, unknown>) => void; error: RegExp }[] = [
    { name: 'route contradicts Profile', edit: config => { config.model = 'another-model'; }, error: /model differs from Profile/ },
    { name: 'explicit parameter contradicts Profile', edit: config => { config.temperature = 0.9; }, error: /temperature differs from Profile/ },
    { name: 'unknown parameter', edit: config => { config.seed = 7; }, error: /seed/ },
    { name: 'invalid effective parameter', edit: config => { config.maxTokens = '600'; }, error: /maxTokens/ },
    { name: 'missing effective default', edit: config => { delete config.maxTokens; }, error: /cannot honor maxTokens/ },
    { name: 'unsupported effective reasoning', edit: config => { config.reasoningEffort = 'unsupported'; }, error: /does not support reasoning/ },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const f = await runtime(t);
    f.model.resolveModel = async (provider, id) => ({ provider, id, name: 'Defaults', defaultMaxTokens: 600,
      reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }], defaultEffort: ReasoningEffortId('medium') } });
    const p = profile('invalid-saved'); p.params = { version: 1, temperature: 0.2 };
    const agent = await Agent.create(f.context, p, null); await f.context.release(agent);
    const path = `${f.directory}/flow/${createHash('sha256').update(p.sessionID).digest('hex')}.json`;
    const saved = JSON.parse(await readFile(path, 'utf8')) as { config: Record<string, unknown> };
    entry.edit(saved.config); await writeFile(path, JSON.stringify(saved));
    const resume = t.mock.method(f.host.agents, 'resume');
    await assert.rejects(Agent.resume(f.context, null, p.sessionID), entry.error);
    assert.equal(resume.mock.callCount(), 0);
    assert.equal(f.host.agents.get(SessionId(p.sessionID)), undefined);
  });
});

test('C007-01: newly introduced provider defaults cannot replace saved absent values', async t => {
  const f = await runtime(t), p = profile('new-default'); p.params = { version: 1 };
  const agent = await Agent.create(f.context, p, null);
  assert.equal(f.native(agent).options.maxTokens, undefined); await f.context.release(agent);
  f.model.resolveModel = async (provider, id) => ({ provider, id, name: 'Defaults', defaultMaxTokens: 1200,
    reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] } });
  const resume = t.mock.method(f.host.agents, 'resume');
  await assert.rejects(Agent.resume(f.context, null, p.sessionID), /cannot honor maxTokens/);
  assert.equal(resume.mock.callCount(), 0);
});

test('C029-01 C030-02 C030-03 C031-01 C031-02: real create is idle, scoped, configured and identity checked', async t => {
  const f = await runtime(t); const agent = await f.create('configured', 'full-access'), native = f.native(agent), handle = f.hostAgent(agent);
  assert.equal(f.model.requests.length, 0); assert.equal(native.status, 'idle');
  assert.deepEqual(native.options, { provider: 'fixture', model: 'model', reasoningEffort: 'medium', temperature: 0.2, maxTokens: 500 });
  assert.equal(f.host.sandboxPolicy.resolve({ session: native.session }).mode, 'danger-full-access');
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'approval/policy' && event.data.policy === 'never'));
  const names = native.ctx.tools.schemas(native).map(tool => tool.name);
  for (const name of ['flow_self', 'flow_send', 'flow_wait', 'flow_create', 'flow_transfer']) assert.ok(names.includes(name));
  for (const name of ['flow_submit', 'flow_start', 'flow_dispose_team']) assert.ok(!names.includes(name));
  assert.deepEqual(Object.keys(handle), ['profile']);
  assert.equal(f.adaptor.capabilities.usage, true); assert.equal('uiPanel' in f.adaptor.capabilities, false);
  await assert.rejects(Agent.create(f.context, profile('configured'), null), /active|exists|registered/);
  await assert.rejects(Agent.resume(f.context, null, sessionID('configured')), /active|registered/);
  assert.throws(() => f.adaptor.getStatus({ profile: handle.profile }), /another adaptor/);
  await assert.rejects(Agent.create(f.context, { ...profile('bad'), params: { version: 1, seed: 7 } } as never, null), /seed/);
  await f.context.release(agent);
  assert.throws(() => f.adaptor.getStatus(handle), /released/);
});

test('C029-03 C029-04 C029-05 C032-01 C034-01 C034-02: actual input modes, ordered committed events and provider usage', async t => {
  const f = await runtime(t); const agent = await f.create(), handle = f.hostAgent(agent), native = f.native(agent);
  const events: HostEvent[] = [];
  f.adaptor.subscribe(handle, event => { events.push(event); });
  f.adaptor.subscribe(handle, () => { throw new Error('observer fault'); });
  assert.equal(events.length, 0);
  await f.adaptor.send(handle, input('NOTICE'), 'notice'); await delay(10); assert.equal(f.model.requests.length, 0);
  await f.adaptor.send(handle, input('FOLLOWUP')); await f.adaptor.whenIdle(handle);
  assert.equal(f.model.requests.length, 1); assert.match(text(f.model.requests[0]!), /NOTICE[\s\S]*FOLLOWUP/);
  const messages = native.session.snapshotEvents().filter(event => event.type === 'user/message');
  assert.ok(messages.every(event => event.data.source.kind === 'flow' && event.data.source.purpose === 'input' && event.data.source.priority === 'normal'));
  assert.ok(events.every(event => event.agent === handle && Number.isFinite(event.timestamp)));
  assert.equal(events.filter(event => event.type === 'output').length, 1);
  const usage = events.filter(event => event.type === 'usage'); assert.equal(usage.length, 1);
  assert.deepEqual(usage[0]!.usage, { timestamp: usage[0]!.usage.timestamp, model: { provider: 'fixture', id: 'model' }, inputTokens: 15, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 });
  assert.equal(events.at(-1)?.type === 'turn-end' || events.at(-1)?.type === 'status', true);
  await f.adaptor.persist(handle); assert.equal(native.status, 'idle');
  let cancelledEvents = 0;
  const stop = f.adaptor.subscribe(handle, () => { cancelledEvents++; }); stop();
  await f.adaptor.send(handle, input('STEER'), 'steer'); await f.adaptor.whenIdle(handle);
  assert.equal(f.model.requests.length, 2); assert.equal(cancelledEvents, 0);
});

test('C029-03: persist refuses a runtime without durability support', async t => {
  const f = await runtime(t, { persistence: false }); const agent = await f.create();
  await assert.rejects(f.adaptor.persist(f.hostAgent(agent)), /persistence/);
});

test('C031-03 C029-02: real scoped guard denies five management writes, preserves inspect/list and ordinary Agents', async t => {
  const f = await runtime(t); const invoked: string[] = [];
  registerJsonTool(f.host, 'plugin_manager', 'Management path probe', { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }, args => { invoked.push(args.action as string); return 'manager'; });
  registerJsonTool(f.host, 'cordis_inspect_query', 'Read-only path probe', { type: 'object', properties: {} }, () => { invoked.push('inspect'); return 'read-only'; });
  const agent = await f.create('guarded'), native = f.native(agent);
  const writes = ['set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'set_version_exemption'];
  const reads = ['list_plugins', 'list_bundles', 'list_version_exemptions'];
  let next = 0;
  f.model.script = () => next < writes.length + reads.length ? { tool: 'plugin_manager', args: { action: [...writes, ...reads][next++]! } }
    : next++ === writes.length + reads.length ? { tool: 'cordis_inspect_query', args: {} } : 'DONE';
  native.followup(user('TEST')); await native.whenIdle();
  assert.deepEqual(invoked, [...reads, 'inspect']);
  const results = native.session.snapshotEvents().filter(event => event.type === 'tool/result');
  assert.equal(results.filter(event => event.data.message.isError).length, 5);
  await assert.rejects(f.host.commands.execute(native, '/permission full-access', [], new AbortController().signal), /Flow does not expose permission changes/);
  const ordinary = await f.host.agents.create({ sessionId: SessionId('ordinary'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } });
  next = 0; f.model.script = () => next++ === 0 ? { tool: 'plugin_manager', args: { action: 'set_plugin' } } : 'DONE';
  ordinary.agent.followup(user('TEST')); await ordinary.agent.whenIdle();
  assert.equal(invoked.at(-1), 'set_plugin'); await ordinary.dispose();
});

test('C032-02 C032-03 C017-01 C017-02 C017-03 C020-02: registered wait returns, dequeued input is preserved and completion is first', async t => {
  const f = await runtime(t); const agent = await f.create('waiter'), handle = f.hostAgent(agent), native = f.native(agent);
  f.model.script = (_request, index) => index === 0 ? { tool: 'flow_wait', args: { query: { summaryIncludes: 'MATCH' }, timeout: 5000 } } : 'DONE';
  await f.adaptor.send(handle, input('START')); await native.whenIdle();
  assert.equal(agent.hasPendingWait(), true); assert.equal(f.model.requests.length, 1);
  const result = native.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.ok(result && JSON.stringify(result).includes('registered'));
  native.followup(user('DEFERRED-USER')); await native.whenIdle();
  assert.equal(f.model.requests.length, 1, 'ordinary native input was already dequeued but must be deferred');
  await f.adaptor.send(handle, { ...input('TEMPORARY-HIGH'), priority: 'high' }, 'steer', 'notification'); await native.whenIdle();
  assert.equal(agent.hasPendingWait(), true); assert.equal(f.model.requests.length, 2);
  assert.ok(!text(f.model.requests[1]!).includes('DEFERRED-USER'));
  const sender = await f.create('sender');
  agent.recvMessage({ ...input('MATCH'), source: sender });
  await until(() => !agent.hasPendingWait()); await native.whenIdle();
  assert.equal(f.model.requests.length, 3);
  const final = text(f.model.requests[2]!); assert.ok(final.includes('DEFERRED-USER'));
  const inputs = f.model.requests[2]!.messages.filter(message => message.role === 'user').map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
  assert.ok(inputs.at(-1)?.includes('DEFERRED-USER'));
});

test('C020-02 C032-03: an already formed completion crosses a subsequently registered wait', async t => {
  const f = await runtime(t); const agent = await f.create(), native = f.native(agent), handle = f.hostAgent(agent);
  const sending = f.adaptor.send(handle, markWaitCompletion(input('FORMED-COMPLETION')), 'followup', 'notification');
  agent.wait(() => false, 5000);
  await sending;
  await native.whenIdle(); assert.equal(f.model.requests.length, 1); assert.match(text(f.model.requests[0]!), /FORMED-COMPLETION/);
  assert.equal(agent.hasPendingWait(), true);
});

test('C010-01 C010-02 C035-01: real after-turn and KILL races share the cached close Promise', async t => {
  const f = await runtime(t, { afterTurnTimeoutMs: 50, immediateTimeoutMs: 500 }); const gate = latch();
  f.model.script = async options => { await Promise.race([gate.promise, new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))]); return 'DONE'; };
  const agent = await f.create(), native = f.native(agent), handle = f.hostAgent(agent);
  await f.adaptor.send(handle, input('HOLD')); await until(() => f.model.requests.length === 1);
  const first = f.adaptor.releaseAgent(handle); const repeated = f.adaptor.releaseAgent(handle);
  assert.equal(first, repeated); assert.equal(native.status, 'running');
  const killed = f.adaptor.releaseAgent(handle, 'immediate'); assert.equal(first, killed); gate.release();
  await first; assert.equal(f.host.agents.get(native.id), undefined); assert.equal(f.adaptor.releaseAgent(handle), first);
});

test('C010-01 C010-03: actual non-cooperative provider exceeds configured deadlines and abandons', async t => {
  const f = await runtime(t, { afterTurnTimeoutMs: 10, immediateTimeoutMs: 20 }); const gate = latch();
  f.model.script = async () => { await gate.promise; return 'DONE'; };
  const agent = await f.create(), native = f.native(agent), handle = f.hostAgent(agent);
  await f.adaptor.send(handle, input('HOLD')); await until(() => f.model.requests.length === 1);
  const closing = f.adaptor.releaseAgent(handle); await assert.rejects(closing, /abandoned/);
  assert.equal(f.adaptor.releaseAgent(handle, 'immediate'), closing);
  gate.release(); await native.whenIdle();
  assert.equal(f.adaptor.releaseAgent(handle), closing);
  await assert.rejects(f.adaptor.dispose(), /failed to release/);
});

test('C033-01 C033-02 C034-02: summaries use three independent requests without mutating source histories', async t => {
  const f = await runtime(t); const own = await f.create('own'), other = await f.create('other');
  f.model.script = () => validSummary;
  const beforeOwn = f.native(own).session.snapshotEvents(), beforeOther = f.native(other).session.snapshotEvents();
  const summaries = await Promise.all([f.adaptor.summarizeContext(f.hostAgent(own)), f.adaptor.summarizeContext(f.hostAgent(other))]);
  const merged = await f.adaptor.mergeContextSummaries(f.hostAgent(own), summaries[0]!.summary, summaries[1]!.summary);
  assert.match(merged.summary, /own.*other/); assert.equal(f.model.requests.length, 3);
  assert.ok(f.model.requests.every(request => !request.tools?.length && request.messages.length === 1));
  assert.deepEqual(f.native(own).session.snapshotEvents(), beforeOwn); assert.deepEqual(f.native(other).session.snapshotEvents(), beforeOther);
  f.model.script = () => 'invalid';
  await assert.rejects(f.adaptor.summarizeContext(f.hostAgent(own)), error => error instanceof AuxiliaryCallError && error.usage.length === 1);
});

test('C030-01 C031-01 C031-02 C035-02: fork and cold resume retain independent native ownership and overwrite seed permissions', async t => {
  const f = await runtime(t); const parent = await f.create('parent', 'full-access');
  await f.adaptor.send(f.hostAgent(parent), input('HISTORY')); await f.native(parent).whenIdle();
  const { setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy');
  setSandboxMode(f.native(parent).session, 'read-only');
  const child = await parent.fork(); const childNative = f.native(child), childID = child.getProfile().sessionID;
  assert.equal(childNative.options.reasoningEffort, 'medium');
  assert.equal(f.host.sandboxPolicy.resolve({ session: childNative.session }).mode, 'danger-full-access');
  await parent.transfer(child, await f.create('adopt', 'full-access'));
  await f.context.release(parent); assert.equal(f.host.agents.get(childNative.id), childNative);
  childNative.inject(user('PENDING-USER')); await f.adaptor.persist(f.hostAgent(child));
  await f.context.release(child);
  const before = f.model.requests.length;
  const resumed = await Agent.resume(f.context, null, childID), restored = f.native(resumed);
  await delay(10); assert.equal(f.model.requests.length, before, 'resume inject does not wake');
  assert.ok(restored.inbox.nextStep.some(message => message.content.some(block => block.type === 'text' && block.text === 'PENDING-USER')));
  assert.equal(restored.options.reasoningEffort, 'medium');
  assert.equal(f.host.sandboxPolicy.resolve({ session: restored.session }).mode, 'danger-full-access');
  assert.ok(restored.session.snapshotEvents().some(event => event.type === 'approval/policy' && event.data.policy === 'never'));
});

test('C030-02: idle native creation consumes no service capacity and resize governs future admission', async t => {
  const capacity = new ExecutionCapacity(1), f = await runtime(t, { capacity }); const gate = latch();
  f.model.script = async () => { await gate.promise; return 'DONE'; };
  const agents = await Promise.all([f.create('one'), f.create('two'), f.create('three')]); assert.equal(capacity.executing, 0);
  await Promise.all(agents.map(agent => f.adaptor.send(f.hostAgent(agent), input('WORK'))));
  await until(() => f.model.requests.length === 1); capacity.resize(2); await until(() => f.model.requests.length === 2);
  capacity.resize(1); assert.equal(capacity.executing, 2);
  gate.release(); await Promise.all(agents.map(agent => f.native(agent).whenIdle())); assert.equal(f.model.requests.length, 3);
});

test('C029-03 C010-03: a durability listener loss rejects persist and close still disposes the real native handle', async t => {
  const f = await runtime(t, { persistence: false }), agent = await f.create(), native = f.native(agent), handle = f.hostAgent(agent);
  const { default: JsonlPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl');
  await f.host.plugin(JsonlPersistence, { root: `${f.directory}/late-sessions`, compression: 'none' });
  t.mock.method(f.host.sessions, 'flush', async () => false);
  assert.equal(await f.host.sessions.flush(native.session), false);
  await assert.rejects(f.adaptor.persist(handle), /durability listener/);
  const events: HostEvent[] = []; f.adaptor.subscribe(handle, event => events.push(event));
  await f.adaptor.releaseAgent(handle, 'immediate');
  assert.equal(f.host.agents.get(native.id), undefined);
  assert.ok(events.some(event => event.type === 'error' && event.message.includes('Persistence failed during close')));
});

test('C007-03 C035-01 C035-02: cold recovery removes marked notifications and preserves user and Flow task inputs', async t => {
  const f = await runtime(t), agent = await f.create('recover-inputs'), native = f.native(agent), handle = f.hostAgent(agent);
  native.inject(user('PENDING-USER'));
  await f.adaptor.send(handle, input('PENDING-TASK'), 'notice', 'input');
  await f.adaptor.send(handle, input('STALE-NOTIFICATION'), 'notice', 'notification');
  const before = f.model.requests.length;
  await f.context.release(agent);
  const resumed = await Agent.resume(f.context, null, sessionID('recover-inputs')), restored = f.native(resumed);
  await delay(5); assert.equal(f.model.requests.length, before);
  const pending = [...restored.inbox.nextTurn, ...restored.inbox.nextStep].map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
  assert.ok(pending.includes('PENDING-USER')); assert.ok(pending.includes('PENDING-TASK')); assert.ok(!pending.includes('STALE-NOTIFICATION'));
  assert.ok(pending.some(value => value.includes('Mailbox 和通信关系已重新初始化')));
  assert.ok(restored.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'), 'old notification cancellation remains in the log');
});

test('C010-01 C029-02: TERM keeps only the admitted native turn business-qualified after logical deregistration', async t => {
  const f = await runtime(t, { afterTurnTimeoutMs: 500, immediateTimeoutMs: 500 }), gate = latch();
  registerJsonTool(f.host, 'fixture_hold', 'Hold a native tool', { type: 'object', properties: {} }, () => gate.promise);
  const agent = await f.create('term-qualified'), native = f.native(agent);
  f.model.script = (_options, index) => index === 0 ? { tool: 'fixture_hold', args: {} } : index === 1 ? { tool: 'flow_self', args: {} } : 'DONE';
  await f.adaptor.send(f.hostAgent(agent), input('WORK')); await until(() => native.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.name === 'fixture_hold'));
  const closing = agent.recvSignal('SIGTERM'); assert.equal(agent.getStatus(), 'terminated'); assert.equal(f.context.has(agent), false);
  gate.release(); await closing;
  const results = native.session.snapshotEvents().filter(event => event.type === 'tool/result');
  assert.equal(results.length, 2); assert.ok(results.every(event => !event.data.message.isError));
});

test('C032-02: an immediate mailbox match keeps the actual native turn running after flow_wait', async t => {
  const f = await runtime(t), caller = await f.create('matched'), sender = await f.create('matched-source'), native = f.native(caller);
  f.model.script = (_options, index) => index === 0 ? { tool: 'flow_wait', args: { query: { summaryIncludes: 'MATCH' }, timeout: 5000 } } : 'AFTER-MATCH';
  caller.recvMessage({ ...input('MATCH'), source: sender });
  await until(() => f.model.requests.length >= 2); await native.whenIdle();
  assert.equal(caller.hasPendingWait(), false);
  const starts = native.session.snapshotEvents().filter(event => event.type === 'turn/start');
  const calls = native.session.snapshotEvents().filter(event => event.type === 'assistant/message');
  assert.equal(starts.length, 1); assert.equal(calls.length, 2);
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'tool/result' && JSON.stringify(event).includes('matched')));
});

test('C029-03: real whenIdle includes a followup accepted during the preceding model call', async t => {
  const f = await runtime(t), agent = await f.create(), handle = f.hostAgent(agent), gate = latch();
  f.model.script = async (_options, index) => { if (index === 0) await gate.promise; return 'DONE'; };
  await f.adaptor.send(handle, input('FIRST')); await until(() => f.model.requests.length === 1);
  let idle = false; const waiting = f.adaptor.whenIdle(handle).then(() => { idle = true; });
  await f.adaptor.send(handle, input('SECOND')); assert.equal(idle, false); gate.release(); await waiting;
  assert.equal(f.model.requests.length, 2); assert.match(text(f.model.requests[1]!), /SECOND/);
});

test('C029-05 C034-02: a failed native stream retains attempt usage with no invented total or completed output', async t => {
  const f = await runtime(t), agent = await f.create(), handle = f.hostAgent(agent), native = f.native(agent);
  f.model.usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 5 }; f.model.failAfterUsage = true;
  const events: HostEvent[] = []; f.adaptor.subscribe(handle, event => events.push(event));
  await f.adaptor.send(handle, input('FAIL')); await native.whenIdle();
  const usage = events.filter(event => event.type === 'usage');
  assert.equal(usage.length, 1); assert.equal(usage[0]!.usage.inputTokens, 8); assert.equal(usage[0]!.usage.totalTokens, undefined);
  assert.equal(events.filter(event => event.type === 'output').length, 0);
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'assistant/attempt'));
  assert.ok(events.some(event => event.type === 'turn-end' && event.reason === 'failed'));
  await assert.rejects(f.adaptor.summarizeContext(handle), error => error instanceof AuxiliaryCallError && error.usage[0]?.inputTokens === 8);
});

test('C014-01 C033-01 C033-02 C034-02: actual herb uses each source model and attributes three auxiliary calls only to its published child', async t => {
  const f = await runtime(t), ownProfile = profile('herb-mother'), otherProfile = profile('herb-other');
  ownProfile.model = { provider: 'fixture', id: 'mother-model' }; otherProfile.model = { provider: 'fixture', id: 'other-model' };
  const mother = await Agent.create(f.context, ownProfile, null), other = await Agent.create(f.context, otherProfile, null);
  f.model.script = options => text(options).includes('Flow 上下文总结 v1') && options.messages.length === 1 ? validSummary : 'CHILD-DONE';
  const { observeCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const observations: { type: string; agent: Agent; model?: string }[] = [];
  observeCore(f.context, event => {
    if (event.type === 'agent-created') observations.push({ type: 'created', agent: event.agent });
    if (event.type === 'host-event' && event.event.type === 'usage') observations.push({ type: 'usage', agent: event.agent, model: event.event.usage.model.id });
  });
  const ownBefore = f.native(mother).session.snapshotEvents(), otherBefore = f.native(other).session.snapshotEvents();
  const child = await mother.herb(other);
  await f.native(child).whenIdle();
  assert.deepEqual(f.model.requests.slice(0, 3).map(request => request.model), ['mother-model', 'other-model', 'mother-model']);
  const auxiliary = observations.filter(event => event.type === 'usage').slice(0, 3);
  assert.equal(auxiliary.length, 3); assert.ok(auxiliary.every(event => event.agent === child));
  assert.deepEqual(auxiliary.map(event => event.model), ['mother-model', 'other-model', 'mother-model']);
  assert.equal(observations[0]?.type, 'created'); assert.equal(observations[0]?.agent, child);
  assert.deepEqual(f.native(mother).session.snapshotEvents(), ownBefore); assert.deepEqual(f.native(other).session.snapshotEvents(), otherBefore);
});

test('C014-02 C034-02: terminated mother retains invocation-local auxiliary accounting until settlement, with no double event', async t => {
  const f = await runtime(t, { immediateTimeoutMs: 500 }), mother = await f.create('terminated-mother'), other = await f.create('surviving-source');
  const gate = latch();
  f.model.script = async options => {
    await gate.promise;
    if (options.signal?.aborted) return validSummary;
    return validSummary;
  };
  const { observeCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const usage: Agent[] = [];
  observeCore(f.context, event => { if (event.type === 'host-event' && event.event.type === 'usage') usage.push(event.agent); });
  const herb = mother.herb(other); await until(() => f.model.requests.length === 2);
  const rejected = assert.rejects(herb);
  const closing = mother.recvSignal('SIGKILL'); gate.release(); await rejected; await closing;
  assert.deepEqual(usage, [mother]); assert.equal(f.model.requests.length, 2);
});

test('C029-02: tools reject a real foreign native caller and resolve message IDs only in the bound Mailbox', async t => {
  const f = await runtime(t), caller = await f.create('caller'), other = await f.create('other-mailbox'), native = f.native(caller);
  const foreignID = other.getMailbox().put({ ...input('FOREIGN-PAYLOAD'), source: caller }); assert.ok(foreignID);
  let next = 0;
  f.model.script = () => next++ === 0 ? { tool: 'flow_read', args: { messageID: foreignID } } : 'DONE';
  await f.adaptor.send(f.hostAgent(caller), input('READ')); await native.whenIdle();
  const read = native.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.ok(read && JSON.stringify(read).includes('null')); assert.equal(other.getMailbox().peak(foreignID)?.read, false);
  const definition = native.ctx.tools.get('flow_self', native); assert.ok(definition);
  registerJsonTool(f.host, 'fixture_foreign_call', 'Call a captured Flow definition with the real ordinary caller execution', { type: 'object', properties: {} }, (_args, execution) => definition.execute({}, execution));
  const ordinary = await f.host.agents.create({ sessionId: SessionId('foreign-native-caller'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } });
  next = 0; f.model.script = () => next++ === 0 ? { tool: 'fixture_foreign_call', args: {} } : 'DONE';
  ordinary.agent.followup(user('CALL')); await ordinary.agent.whenIdle();
  assert.ok(ordinary.agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError && JSON.stringify(event).includes('caller does not match')));
  await ordinary.dispose();
});

test('C010-01: configured after-turn deadline upgrades and cancels a cooperative real provider', async t => {
  const f = await runtime(t, { afterTurnTimeoutMs: 10, immediateTimeoutMs: 500 });
  f.model.script = async options => { await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true })); return 'DONE'; };
  const agent = await f.create(), native = f.native(agent), handle = f.hostAgent(agent);
  await f.adaptor.send(handle, input('HOLD')); await until(() => f.model.requests.length === 1);
  await f.adaptor.releaseAgent(handle); assert.equal(f.host.agents.get(native.id), undefined);
});

test('C007-03 C035-02: actual process checkpoint cold-resumes pending Inbox and removes stale Flow notification in unpublished setup', async t => {
  const f = await runtime(t);
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/cold-checkpoint.ts', import.meta.url)), f.directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /CHECKPOINT-DURABLE/);
  const agent = await Agent.resume(f.context, null, sessionID('crash-checkpoint')), native = f.native(agent);
  assert.equal(f.model.requests.length, 0);
  const pending = [...native.inbox.nextTurn, ...native.inbox.nextStep];
  const contents = pending.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []));
  assert.ok(contents.includes('CRASH-USER')); assert.ok(contents.includes('CRASH-TASK')); assert.ok(!contents.includes('STALE-FLOW-NOTICE'));
  const staleInsertion = native.session.snapshotEvents().find(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.content.some(block => block.type === 'text' && block.text === 'STALE-FLOW-NOTICE')));
  assert.ok(staleInsertion?.type === 'agent/inbox/spliced');
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.seq > staleInsertion.seq && event.data.outcome === 'canceled' && event.data.removedCount === 1), 'the actual setup remove is recorded while insertion history remains');
});
