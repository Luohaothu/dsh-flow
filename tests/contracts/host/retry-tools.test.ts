import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { getAgentAppearance, getAgentInstanceId, observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { agentControl } from '../../../packages/dsh-flow/src/core/internals.js';
import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';
import { input, profile, runtime, until } from '../../helpers/contract-runtime.js';

function lastToolValue(options: GenerateOptions): unknown {
  const message = options.messages.filter(item => item.role === 'tool').at(-1);
  if (!message) return undefined;
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  try { return JSON.parse(text); } catch { return undefined; }
}
function field(value: unknown, key: string): unknown { assert.ok(value && typeof value === 'object'); return Reflect.get(value, key); }
function string(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
async function fixture(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t);
  const call = async (caller: Agent, name: string, args: Record<string, unknown>) => {
    const native = f.native(caller), start = native.session.snapshotEvents().length;
    let issued = false, observed: unknown;
    f.model.script = options => {
      if (!issued) { issued = true; return { tool: name, args }; }
      observed = lastToolValue(options); return 'DONE';
    };
    await caller[agentControl].context.getHostAdaptor().send(f.hostAgent(caller), input(`invoke ${name}`)); await native.whenIdle();
    const result = native.session.snapshotEvents().slice(start).find(event => event.type === 'tool/result');
    assert.ok(result && result.type === 'tool/result');
    return { error: result.data.message.isError, observed, text: result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') };
  };
  const failed = async (parent: Agent, name: string) => {
    const child = await Agent.create(f.context, profile(name), parent), native = f.native(child);
    f.model.failAfterUsage = true; f.model.script = () => 'provider fails after usage';
    await f.adaptor.send(f.hostAgent(child), input('fail')); await native.whenIdle(); f.model.failAfterUsage = false;
    assert.equal((await call(child, 'flow_signal', { signal: 'SIGTERM' })).error, false);
    await until(() => f.host.agents.get(SessionId(child.getProfile().sessionID)) === undefined);
    return child;
  };
  return { ...f, call, failed };
}

test('actual parent model reads flow_create instanceId, then retries that failed instance with the same native profile path', async t => {
  const f = await fixture(t), parent = await f.create('retry-parent');
  const created = await f.call(parent, 'flow_create', { profile: profile('original-child') }); assert.equal(created.error, false, created.text);
  // observed was read by the adapter from the actual SDK model request containing flow_create's tool result.
  const retryOf = string(field(created.observed, 'instanceId')), originalProfile = field(created.observed, 'profile');
  const old = f.context.getAgent(sessionID(string(field(originalProfile, 'sessionID')))); assert.ok(old);
  assert.equal(retryOf, getAgentInstanceId(old)); const oldNative = f.native(old);
  f.model.failAfterUsage = true; f.model.script = () => 'provider failed';
  await f.adaptor.send(f.hostAgent(old), input('fail')); await oldNative.whenIdle(); f.model.failAfterUsage = false;
  assert.equal((await f.call(old, 'flow_signal', { signal: 'SIGTERM' })).error, false);
  await until(() => f.host.agents.get(oldNative.session.id) === undefined);
  let birthSource: string[] | undefined;
  observeCore(f.context, event => { if (event.type === 'agent-created' && getAgentAppearance(event.agent)?.origin === 'retry') birthSource = [...getAgentAppearance(event.agent)!.sourceIds]; });
  const requested = profile('retry-profile', 'read-only');
  const retry = await f.call(parent, 'flow_create', { profile: requested, retryOf, initmsg: { summary: 'retry task', payload: 'retry using normal input' } });
  assert.equal(retry.error, false, retry.text);
  const newId = string(field(retry.observed, 'instanceId')), childProfile = field(retry.observed, 'profile');
  const child = f.context.getAgent(sessionID(string(field(childProfile, 'sessionID')))); assert.ok(child);
  assert.notEqual(newId, retryOf); assert.equal(newId, getAgentInstanceId(child)); assert.equal(child.getParent(), parent);
  assert.equal(child.getProfile().permission, 'read-only'); assert.deepEqual(child.getProfile().params, requested.params); assert.deepEqual(child.getProfile().model, requested.model);
  assert.deepEqual(birthSource, [retryOf]); assert.equal(getAgentAppearance(child)!.origin, 'retry');
  assert.equal(getAgentAppearance(old)!.id, retryOf); assert.equal(old.getStatus(), 'terminated'); assert.notEqual(child.getProfile().sessionID, old.getProfile().sessionID);
  await f.native(child).whenIdle(); assert.ok(f.native(child).session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('retry using normal input')));
});

test('actual retry tool rejects fabricated UUID, SessionID, active, stopped, foreign Context and lost-parent sources', async t => {
  const f = await fixture(t), parent = await f.create('retry-owner'), adopt = await f.create('retry-new-parent');
  const active = await Agent.create(f.context, profile('active-source'), parent), stopped = await Agent.create(f.context, profile('stopped-source'), parent);
  await stopped.recvSignal('SIGTERM');
  const other = f.createContext({ cwd: f.directory }), foreignParent = await other.create(profile('foreign-parent'));
  const foreign = await Agent.create(other.context, profile('foreign-failed'), foreignParent), foreignNative = f.native(foreign);
  f.model.failAfterUsage = true; f.model.script = () => 'foreign fails';
  await other.adaptor.send(f.hostAgent(foreign), input('fail')); await foreignNative.whenIdle(); f.model.failAfterUsage = false;
  assert.equal((await f.call(foreign, 'flow_signal', { signal: 'SIGTERM' })).error, false);
  await until(() => f.host.agents.get(foreignNative.session.id) === undefined);
  const moved = await Agent.create(f.context, profile('moved-source'), parent); parent.transfer(moved, adopt);
  const movedNative = f.native(moved); f.model.failAfterUsage = true; f.model.script = () => 'moved fails';
  await f.adaptor.send(f.hostAgent(moved), input('fail')); await movedNative.whenIdle(); f.model.failAfterUsage = false;
  assert.equal((await f.call(moved, 'flow_signal', { signal: 'SIGTERM' })).error, false); await until(() => f.host.agents.get(movedNative.session.id) === undefined);
  const before = parent.getChildren().length;
  for (const retryOf of [randomUUID(), active.getProfile().sessionID, getAgentInstanceId(active), getAgentInstanceId(stopped), getAgentInstanceId(foreign), getAgentInstanceId(moved)]) {
    const rejected = await f.call(parent, 'flow_create', { profile: profile(`rejected-${randomUUID()}`), retryOf });
    assert.equal(rejected.error, true, `unexpected retry accepted: ${retryOf}`); assert.equal(parent.getChildren().length, before);
  }
  const accepted = await f.call(adopt, 'flow_create', { profile: profile('adopt-retry'), retryOf: getAgentInstanceId(moved) }); assert.equal(accepted.error, false, accepted.text);
});

test('retry preserves the ordinary profile permission ceiling and leaves no child after invalid parameters', async t => {
  const f = await fixture(t), parent = await f.create('retry-permission'), old = await f.failed(parent, 'failed-permission');
  const before = parent.getChildren().length;
  const elevated = await f.call(parent, 'flow_create', { profile: profile('elevated-retry', 'full-access'), retryOf: getAgentInstanceId(old) });
  assert.equal(elevated.error, true); assert.match(elevated.text, /permission|Permission/); assert.equal(parent.getChildren().length, before);
  const wrongType = await f.call(parent, 'flow_create', { profile: profile('wrong-retry'), retryOf: 123 });
  assert.equal(wrongType.error, true); assert.equal(parent.getChildren().length, before);
});
