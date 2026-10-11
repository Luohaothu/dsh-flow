import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { createFakeHost } from './fake-host.ts';

test('team approval is session-local, durable and repinned before resumed execution', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const ordinary = Session.create(SessionId('ordinary-permission'));
  setApprovalPolicy(ordinary, 'ask');
  const started = runtime.start({ objective: 'verify team approval', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  host.setScript(turn => {
    assert.equal(turn.session.snapshotEvents().findLast(event => event.type === 'approval/policy')?.data.policy, 'never');
    turn.concluded = true;
  });
  const execute = (resume: boolean) => runTurn(host.ctx, {
    agent, role: agent.role, prompt: 'Check the session policy', allowedTools: [], globalTools: [],
    model: runtime.config.model, resume, turnSeq: 1, flow: runtime,
  });
  await execute(false);
  const member = host.lastTurn!.session;
  await execute(true);
  assert.equal(member.snapshotEvents().filter(event => event.type === 'approval/policy').length, 1, 'an unchanged resume adds no duplicate policy override');
  setApprovalPolicy(member, 'ask');
  await execute(true);
  assert.deepEqual(member.snapshotEvents().filter(event => event.type === 'approval/policy').map(event => event.data.policy), ['never', 'ask', 'never']);
  assert.deepEqual(ordinary.snapshotEvents().filter(event => event.type === 'approval/policy').map(event => event.data.policy), ['ask']);
});
