import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Agent, Context } from '../../../packages/dsh-flow/src/core/index.js';
import { beginConstruction } from '../../../packages/dsh-flow/src/core/construction.js';
import { agentControl, createOwned } from '../../../packages/dsh-flow/src/core/internals.js';
import { getAgentAppearance, getAgentInstanceId } from '../../../packages/dsh-flow/src/core/observation.js';
import { ContractHost, message, profile } from '../../helpers/contract-host.js';

async function fixture(t: TestContext) {
  const context = new Context(); const host = new ContractHost(); context.registerHostAdaptor(host);
  const root = await Agent.create(context, profile('root'), null); t.after(() => context.dispose());
  return { context, host, root };
}
async function fail(host: ContractHost, agent: Agent): Promise<void> {
  host.emit({ type: 'error', agent: host.native(agent), timestamp: Date.now(), message: 'model failure' });
  await agent[agentControl].release('SIGTERM', 'self');
}

test('retry publishes explicit immutable failed-instance provenance through the ordinary creation pipeline', async t => {
  const { context, host, root } = await fixture(t); const source = await Agent.create(context, profile('source'), root); await fail(host, source);
  const sourceId = getAgentInstanceId(source); const prior = root[agentControl].getRetrySource(sourceId);
  assert.equal(prior.parentId, getAgentInstanceId(root)); assert.equal(prior.outcome, 'failed'); assert.ok(Object.isFrozen(prior));
  const child = await root[agentControl].retry(profile('retry'), sourceId, message('新的任务输入'), 'explicit-history');
  const appearance = getAgentAppearance(child)!; assert.equal(appearance.origin, 'retry'); assert.deepEqual(appearance.sourceIds, [sourceId]); assert.equal(appearance.parentId, getAgentInstanceId(root));
  assert.equal(child.getParent(), root); assert.equal(child.getMailbox().count(), 0); assert.equal(host.created.find(record => record.flow === child)!.history, 'explicit-history');
  assert.equal(host.sent.at(-1)!.message.summary, '新的任务输入'); assert.equal(source.getStatus(), 'terminated'); assert.notEqual(getAgentInstanceId(child), sourceId);
});

test('retry accepts only committed failed direct history and uses the final transferred parent', async t => {
  const { context, host, root } = await fixture(t); const adopt = await Agent.create(context, profile('adopt'), root);
  const moved = await Agent.create(context, profile('moved'), root); root.transfer(moved, adopt); await fail(host, moved);
  const sourceId = getAgentInstanceId(moved); assert.equal(getAgentAppearance(moved)!.parentId, getAgentInstanceId(root));
  await assert.rejects(root[agentControl].retry(profile('wrong-parent'), sourceId));
  const retry = await adopt[agentControl].retry(profile('right-parent'), sourceId); assert.equal(retry.getParent(), adopt);
  const active = await Agent.create(context, profile('active'), root);
  const stopped = await Agent.create(context, profile('stopped'), root); await root.kill(stopped);
  const unrelated = await Agent.create(context, profile('unrelated'), adopt); await fail(host, unrelated);
  const scope = beginConstruction(context, root); const aborted = await Agent[createOwned](scope, profile('aborted'), root); await scope.abort();
  for (const invalid of [getAgentInstanceId(active), getAgentInstanceId(stopped), getAgentInstanceId(unrelated), getAgentInstanceId(aborted), sourceId, 'not-an-instance']) {
    await assert.rejects(root[agentControl].retry(profile(`invalid-${invalid}`), invalid));
  }
  assert.equal(getAgentAppearance(aborted), undefined);
});

test('retry source never resolves by SessionID or across Context and ordinary create permission guards still run', async t => {
  const { context, host, root } = await fixture(t); const other = await fixture(t);
  const source = await Agent.create(context, profile('shared-session'), root); await fail(host, source);
  const sourceId = getAgentInstanceId(source);
  const replacement = await Agent.create(context, profile('shared-session'), root);
  const foreign = await Agent.create(other.context, profile('foreign'), other.root); await fail(other.host, foreign);
  for (const invalid of [source.getProfile().sessionID, getAgentInstanceId(replacement), getAgentInstanceId(foreign)]) await assert.rejects(root[agentControl].retry(profile('rejected'), invalid));
  assert.equal(root[agentControl].getRetrySource(sourceId).id, sourceId);
  const before = host.created.length;
  await assert.rejects(root[agentControl].retry(profile('elevated', { permission: 'full-access' }), sourceId), /permission/);
  assert.equal(host.created.length, before);
  const retry = await root[agentControl].retry(profile('new-instance'), sourceId); assert.deepEqual(getAgentAppearance(retry)!.sourceIds, [sourceId]);
});
