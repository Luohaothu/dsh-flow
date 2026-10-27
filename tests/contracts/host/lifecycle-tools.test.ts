import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import type { CoreObservation } from '../../../packages/dsh-flow/src/core/observation.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { input, runtime, until } from '../../helpers/contract-runtime.js';

type Termination = Extract<CoreObservation, { type: 'agent-terminated' }>;
async function fixture(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t), facts: Termination[] = [];
  observeCore(f.context, event => { if (event.type === 'agent-terminated') facts.push(event); });
  const initialRound = async (agent: Agent, failed = false) => {
    f.model.failAfterUsage = failed; f.model.script = () => 'round finished';
    await f.adaptor.send(f.hostAgent(agent), input('work')); await f.native(agent).whenIdle();
    f.model.failAfterUsage = false;
  };
  const selfSignal = async (agent: Agent, signal: 'SIGTERM' | 'SIGKILL') => {
    let called = false;
    f.model.script = () => { if (called) return 'after accepted self signal'; called = true; return { tool: 'flow_signal', args: { signal } }; };
    await f.adaptor.send(f.hostAgent(agent), input('self signal')); await f.native(agent).whenIdle();
    await until(() => facts.some(fact => fact.agent === agent));
    return facts.find(fact => fact.agent === agent)!;
  };
  return { ...f, facts, initialRound, selfSignal };
}

test('real SDK model flow_signal preserves completed and failed prior rounds as self outcomes', async t => {
  const f = await fixture(t), completed = await f.create('self-completed');
  await f.initialRound(completed);
  const complete = await f.selfSignal(completed, 'SIGTERM');
  assert.equal(complete.initiator, 'self'); assert.equal(complete.outcome, 'completed'); assert.equal(complete.mode, 'after-turn'); assert.equal(complete.propagated, false);
  const failed = await f.create('self-failed'); await f.initialRound(failed, true);
  const failure = await f.selfSignal(failed, 'SIGTERM');
  assert.equal(failure.initiator, 'self'); assert.equal(failure.outcome, 'failed');
});

test('real SDK self KILL reports self while user signals and parent kill retain stopped outcomes', async t => {
  const f = await fixture(t), self = await f.create('self-kill'); await f.initialRound(self);
  const selfKill = await f.selfSignal(self, 'SIGKILL');
  assert.equal(selfKill.initiator, 'self'); assert.equal(selfKill.signal, 'SIGKILL'); assert.equal(selfKill.mode, 'immediate'); assert.equal(selfKill.outcome, 'completed');
  const user = await f.create('user-stop'); await f.initialRound(user);
  await user.recvSignal('SIGTERM'); const userFact = f.facts.find(fact => fact.agent === user)!;
  assert.equal(userFact.initiator, 'user'); assert.equal(userFact.outcome, 'stopped');
  const parent = await f.create('parent'), child = await parent.fork(); await f.initialRound(child);
  await parent.kill(child); const childFact = f.facts.find(fact => fact.agent === child)!;
  assert.equal(childFact.initiator, 'parent'); assert.equal(childFact.outcome, 'stopped'); assert.equal(childFact.propagated, false);
});

test('real SDK invalid flow_signal cannot bypass schema or terminate the caller', async t => {
  const f = await fixture(t), agent = await f.create('invalid-self-signal'), native = f.native(agent);
  let called = false;
  f.model.script = () => { if (called) return 'still alive'; called = true; return { tool: 'flow_signal', args: { signal: 'INVALID' } }; };
  await f.adaptor.send(f.hostAgent(agent), input('invalid')); await native.whenIdle();
  assert.equal(f.facts.length, 0); assert.notEqual(agent.getStatus(), 'terminated');
  assert.ok(native.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError));
});
