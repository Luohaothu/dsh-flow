import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import { FlowPlugin } from '../../../packages/dsh-flow/src/plugin.js';
import { registerJsonTool } from '../../../packages/dsh-flow/src/host/tools.js';
import { deferred, flush } from '../../helpers/contract-host.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';
import { runtime, until } from '../../helpers/contract-runtime.js';

async function fixture(t: TestContext) {
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  const plugin = await FlowPlugin.create(f.host, { stateDirectory: join(f.directory, 'plugin') });
  t.after(() => plugin.dispose());
  const ordinary = async () => (await f.host.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: f.directory },
    agentOptions: { provider: 'fixture', model: 'model' } })).agent;
  const execute = (main: Awaited<ReturnType<typeof ordinary>>) => f.host.commands.execute(main, '/agent-team Check the consumer contract.', [], new AbortController().signal);
  return { ...f, plugin, ordinary, execute };
}

test('the command refuses a missing native skill consumer before material admission or user delivery', async t => {
  const f = await fixture(t), main = await f.ordinary();
  const admission = t.mock.method(f.plugin.bridge, 'admitCommand');
  await assert.rejects(f.execute(main), /skill.*consumer/i);
  assert.equal(admission.mock.callCount(), 0); assert.equal(f.model.requests.length, 0);
  const events = main.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'user/message').length, 0);
  assert.equal(events.filter(event => event.type === 'command/done' && event.data.kind === 'success').length, 0);
  assert.equal(events.filter(event => event.type === 'command/done' && event.data.kind === 'error').length, 1);
});

test('a same-name plugin and foreign skill tool do not establish the native consumer', async t => {
  const f = await fixture(t), main = await f.ordinary();
  await f.host.plugin({ name: ToolSkill.name, apply() {} });
  registerJsonTool(f.host, 'skill', 'Foreign same-name tool', { type: 'object' }, () => ({ ok: true }));
  await assert.rejects(f.execute(main), /skill.*consumer/i);
  assert.equal(f.model.requests.length, 0);
  assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
});

for (const state of ['pending', 'failed'] as const) {
  test(`a ${state} native ToolSkill runtime cannot admit a command`, async t => {
    const f = await fixture(t), main = await f.ordinary();
    if (state === 'pending') {
      const fiber = await f.host.isolate('skills').plugin(ToolSkill); assert.equal(fiber.state, 0);
    } else {
      await assert.rejects(async () => f.host.plugin(ToolSkill, { catalogDescriptionMaxLength: 0 }));
      assert.deepEqual([...f.host.registry.get(ToolSkill)!.fibers].map(fiber => fiber.state), [3]);
    }
    assert.equal(f.host.registry.has(ToolSkill), true);
    await assert.rejects(f.execute(main), /skill.*consumer/i);
    assert.equal(f.model.requests.length, 0);
    assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
  });
}

test('only an active consumer visible to the actual receiving Agent admits the command and remains host-owned', async t => {
  const f = await fixture(t), main = await f.ordinary(), other = await f.ordinary();
  const consumer = await main.ctx.plugin(ToolSkill), tool = main.ctx.tools.get('skill', main);
  assert.equal(consumer.state, 2); assert.equal(f.host.registry.has(ToolSkill), true);
  await assert.rejects(f.execute(other), /skill.*consumer/i);
  assert.equal(f.model.requests.length, 0);
  const accepted = await f.execute(main); assert.equal(accepted?.result.kind, 'success'); await main.whenIdle();
  const events = main.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation').length, 1);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1);
  assert.equal(f.model.requests.length, 1);
  assert.equal([...f.host.registry.get(ToolSkill)!.fibers].length, 1);
  await f.plugin.dispose();
  assert.equal(consumer.state, 2); assert.equal(main.ctx.tools.get('skill', main), tool);
});

test('an unloading host consumer refuses a new command until host cleanup completes', async t => {
  const f = await fixture(t), main = await f.ordinary(), gate = deferred();
  const consumer = await f.host.plugin(ToolSkill);
  consumer.ctx.effect(() => () => gate.promise);
  const unloading = consumer.dispose();
  try {
    await until(() => consumer.state === 5);
    await assert.rejects(f.execute(main), /skill.*consumer/i);
    assert.equal(f.model.requests.length, 0);
    assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
  } finally { gate.resolve(); await unloading; }
});

test('consumer loss during admission rejects delivery, permits the same failed request to retry and preserves in-flight and successful replays', async t => {
  const f = await fixture(t), main = await f.ordinary(), gate = deferred();
  const consumer = await f.host.plugin(ToolSkill), command = f.host.commands.find(main, 'agent-team')!;
  const admit = f.plugin.bridge.admitCommand.bind(f.plugin.bridge);
  let invocation: CommandInvocation | undefined;
  const admission = t.mock.method(f.plugin.bridge, 'admitCommand', async (value: CommandInvocation) => {
    invocation = value; await gate.promise; return admit(value);
  });
  const first = assert.rejects(f.execute(main), /skill.*consumer/i);
  await until(() => invocation !== undefined);
  const original = invocation!;
  const replay = assert.rejects(async () => command.handler(original), /skill.*consumer/i);
  await consumer.dispose();
  const inFlight = Promise.resolve(command.handler(original)); let settled = false;
  void inFlight.then(() => { settled = true; }, () => { settled = true; });
  const replayAfterUnload = assert.rejects(inFlight, /skill.*consumer/i);
  await flush(); assert.equal(settled, false, 'a replay must wait for the original admission instead of reevaluating the consumer');
  assert.equal(admission.mock.callCount(), 1);
  gate.resolve(); await Promise.all([first, replay, replayAfterUnload]);
  assert.equal(f.model.requests.length, 0);
  assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
  const replacement = await f.host.plugin(ToolSkill);
  const retried = await command.handler(original); assert.equal(retried.kind, 'success'); await main.whenIdle();
  assert.equal(admission.mock.callCount(), 2); assert.equal(f.model.requests.length, 1);
  assert.equal(main.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation').length, 1);
  await replacement.dispose();
  assert.deepEqual(await command.handler(original), retried);
  await assert.rejects(async () => command.handler({ ...original, rawInput: 'Different task' }), /different input/);
  assert.equal(admission.mock.callCount(), 2); assert.equal(f.model.requests.length, 1);
});
