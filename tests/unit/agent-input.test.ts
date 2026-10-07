import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { createFakeHost } from './fake-host.ts';
import { COMMUNICATION_CATEGORIES } from '../../packages/dsh-flow/src/messages.ts';

test('first task remains user input on empty resume; later scheduling retains its own source', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'test message provenance', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const session = Session.create(SessionId(agent.session_id));
  const communication = createUserMessage({ source: { kind: 'flow' }, content: [{ type: 'text', text: 'separate incoming evidence' }] });
  host.setScript(async turn => {
    // Real Inbox claim order is next-step messages, then the waking next-turn.
    const decision = await turn.preStep({ messages: [...turn.inputs.slice(1), turn.inputs[0]!] });
    assert.equal(decision.kind, 'enter');
    if (decision.kind !== 'enter') return;
    assert.equal(decision.messages[0]?.id, turn.prompt?.id, 'the task is first in durable model history');
    assert.equal(decision.messages[1]?.id, communication.id, 'communication keeps its independent identity');
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' });
  });
  const turn = async (resume: boolean) => runTurn(host.ctx, {
    agent, role: agent.role, prompt: 'initial task or later scheduling', messages: [communication],
    allowedTools: [], globalTools: [], model: runtime.config.model, resume, modelAccounting: false,
    budgetIds: [], turnSeq: 1, flow: { store: runtime.store },
    onAgentReady(live) { live.session.deriveMessages = () => session.deriveMessages(); },
  });
  await turn(true);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'user', 'an existing empty session has never received its initial prompt');
  await turn(true);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'flow', 'resumed scheduling is not attributed to the human');
});

test('team communication projection preserves explicit categories and falls back for legacy rows', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const team = runtime.startTeam('main', 'classified-team', '分类消息', '/tmp');
  const lead = runtime.store.listAgents(team.cluster.id, { role: 'orchestrator' })[0]!;
  for (const category of COMMUNICATION_CATEGORIES) {
    runtime.store.insertMessage({ id: category, cluster_id: team.cluster.id, from_agent: null, from_node: lead.node_id,
      kind: 'direct', content: { category, text: category } });
    runtime.store.insertRecipient(category, lead.id);
  }
  runtime.store.insertMessage({ id: 'legacy', cluster_id: team.cluster.id, from_agent: null, from_node: lead.node_id,
    kind: 'direct', content: { text: 'older message' } });
  runtime.store.insertRecipient('legacy', lead.id);
  const rows = runtime.teamRead('main', team.cluster.id).communications;
  assert.equal(rows.length, 9);
  for (const category of COMMUNICATION_CATEGORIES) assert.equal(rows.find(row => row.id.startsWith(`${category}:`))?.category, category);
  assert.equal(rows.find(row => row.id.startsWith('legacy:'))?.category, 'discussion');
});
