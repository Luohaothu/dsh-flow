import assert from 'node:assert/strict';
import test from 'node:test';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';
import { input, profile, runtime } from '../../helpers/contract-runtime.js';

async function fixture(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t);
  const call = async (caller: Agent, args: Record<string, unknown>) => {
    const native = f.native(caller), start = native.session.snapshotEvents().length;
    let issued = false;
    f.model.script = () => {
      if (issued) return 'DONE';
      issued = true;
      return { tool: 'flow_create', args };
    };
    await f.adaptor.send(f.hostAgent(caller), input('create a child'));
    await native.whenIdle();
    const result = native.session.snapshotEvents().slice(start).find(event => event.type === 'tool/result');
    assert.ok(result?.type === 'tool/result');
    return { error: result.data.message.isError,
      text: result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') };
  };
  return { ...f, call };
}

test('flow_create exposes a supported schema and reports every missing Profile field before native creation', async t => {
  const f = await fixture(t), parent = await f.create('profile-schema-parent'), native = f.native(parent);
  const tool = native.ctx.tools.schemas(native).find(tool => tool.name === 'flow_create');
  assert.ok(tool);
  assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters));
  const create = t.mock.method(f.host.agents, 'create'), members = f.host.agents.list().length;
  const identity = { role: 'Review the assigned evidence.', name: 'reviewer' };
  const cases = [
    { fields: identity, missing: ['permission', 'model', 'params'] },
    { fields: { ...identity, permission: 'read-only' }, missing: ['model', 'params'] },
    { fields: { ...identity, permission: 'read-only', model: profile().model }, missing: ['params'] },
  ];
  for (const entry of cases) await t.test(`missing ${entry.missing.join(', ')}`, async () => {
    const rejected = await f.call(parent, { profile: entry.fields });
    assert.equal(rejected.error, true);
    for (const field of entry.missing) assert.ok(rejected.text.includes(`value.profile.${field}`), rejected.text);
    assert.equal(parent.getChildren().length, 0);
    assert.equal(f.host.agents.list().length, members);
    assert.equal(create.mock.callCount(), 0);
  });
});

test('flow_create accepts a complete copied Profile, replaces any supplied sessionID and leaves the child idle', async t => {
  const f = await fixture(t), parent = await f.create('profile-copy-parent');
  const original = structuredClone(parent.getProfile());
  for (const suppliedSessionID of [original.sessionID, { ignored: true }]) {
    const requested = { ...original, sessionID: suppliedSessionID, name: `child-${parent.getChildren().length}`,
      role: 'Handle a later formal assignment.', permission: 'read-only', hostExtras: { dsh: { stop: ['END'] } } };
    const created = await f.call(parent, { profile: requested });
    assert.equal(created.error, false, created.text);
    const returned = JSON.parse(created.text) as { profile: { sessionID: string }; status: string; parent: string };
    const child = f.context.getAgent(sessionID(returned.profile.sessionID));
    assert.ok(child);
    assert.notEqual(child.getProfile().sessionID, original.sessionID);
    assert.equal(child.getParent(), parent);
    assert.equal(returned.parent, original.sessionID);
    assert.equal(returned.status, 'idle');
    assert.equal(child.getStatus(), 'idle');
    assert.deepEqual(child.getProfile(), { ...requested, sessionID: child.getProfile().sessionID });
    assert.equal(f.native(child).status, 'idle');
    assert.equal(f.native(child).session.snapshotEvents().some(event => event.type === 'turn/start'), false);
  }
  assert.equal(parent.getChildren().length, 2);
  assert.deepEqual(parent.getProfile(), original);
});

test('flow_create keeps the parent permission ceiling after structural Profile validation', async t => {
  const f = await fixture(t), parent = await f.create('profile-permission-parent');
  const create = t.mock.method(f.host.agents, 'create'), members = f.host.agents.list().length;
  const rejected = await f.call(parent, { profile: profile('elevated-child', 'full-access') });
  assert.equal(rejected.error, true);
  assert.match(rejected.text, /Child initial permission exceeds parent initial permission/);
  assert.equal(parent.getChildren().length, 0);
  assert.equal(f.host.agents.list().length, members);
  assert.equal(create.mock.callCount(), 0);
});
