import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { createFakeHost } from './fake-host.ts';
import { COMMUNICATION_CATEGORIES } from '../../packages/dsh-flow/src/messages.ts';

test('explicit handoff kind survives unrelated user input and resumes without repeating the first delegation', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'test message provenance', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const session = Session.create(SessionId(agent.session_id));
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'an unrelated earlier user message' }] }), { surfaceOp: 'append' });
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
    input: { kind: 'initial', key: 'first-assignment', author: 'actual-manager', binding: { transaction_id: 'bound-object' } },
    allowedTools: [], globalTools: [], model: runtime.config.model, resume,
     turnSeq: 1, flow: { store: runtime.store },
    onAgentReady(live) {
      live.session.deriveMessages = () => session.deriveMessages();
      live.session.snapshotEvents = from => session.snapshotEvents(from);
    },
  });
  await turn(true);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'user', 'only the explicit initial handoff determines attribution');
  await turn(true);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'flow', 'resumed scheduling is not attributed to the human');
  const entered = session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === 'initial task or later scheduling'));
  assert.equal(entered.length, 1, 'the original business delegation is entered exactly once');
  const stored = runtime.store.memberInputForKey(agent.id, 'first-assignment')!;
  assert.equal(stored.status, 'ADMITTED');
  assert.equal(stored.author, 'actual-manager');
  assert.deepEqual(stored.binding, { transaction_id: 'bound-object' });
});

test('native proof reconciles a handoff left pending by a crash before its delivery acknowledgement', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'recover handoff', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const session = Session.create(SessionId(agent.session_id));
  const task = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'preserved task' }] });
  const input = runtime.store.saveMemberInput({ cluster_id: agent.cluster_id, agent_id: agent.id,
    session_id: agent.session_id, delivery_key: 'crashed-handoff', kind: 'initial', author: 'manager',
    plan_ref: null, binding: null, content: 'preserved task', native_message_id: task.id });
  session.append('user/message', task, { surfaceOp: 'append' });
  assert.equal(input.status, 'PENDING');
  host.setScript(turn => {
    for (const message of turn.inputs) session.append('user/message', message, { surfaceOp: 'append' });
  });
  await runTurn(host.ctx, { agent, role: agent.role, prompt: 'preserved task',
    input: { kind: 'initial', key: 'crashed-handoff', author: 'manager' },
    allowedTools: [], globalTools: [], model: runtime.config.model, resume: true, turnSeq: 1,
    flow: { store: runtime.store }, onAgentReady(live) { live.session.snapshotEvents = from => session.snapshotEvents(from); } });
  assert.equal(runtime.store.getMemberInput(input.id)?.status, 'ADMITTED');
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'flow');
});

test('an inbox splice is pending input, and recovery enters the original native message once', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'recover queued handoff', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const session = Session.create(SessionId(agent.session_id));
  const invoke = () => runTurn(host.ctx, { agent, role: agent.role, prompt: 'preserve the queued delegation',
    input: { kind: 'initial', key: 'queued-handoff', author: 'manager' }, allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: true, turnSeq: 1, flow: { store: runtime.store },
    onAgentReady(live) { live.session.snapshotEvents = from => session.snapshotEvents(from); } });
  host.setScript(turn => { session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [...turn.inputs] }); });
  await invoke();
  const queued = runtime.store.memberInputForKey(agent.id, 'queued-handoff')!;
  assert.equal(queued.status, 'PENDING', 'a durable queue insertion does not prove that the model received its business task');
  host.setScript(turn => { for (const message of turn.inputs) session.append('user/message', message, { surfaceOp: 'append' }); });
  await invoke();
  assert.equal(host.lastTurn?.prompt?.id, queued.native_message_id);
  assert.equal(host.lastTurn?.prompt?.source.kind, 'user', 'pending recovery retains the original author source');
  assert.equal(runtime.store.getMemberInput(queued.id)?.status, 'ADMITTED');
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === queued.native_message_id).length, 1);
});

test('an acknowledged handoff without its native journal proof fails without replaying the delegation', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'missing native evidence', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const input = runtime.store.saveMemberInput({ cluster_id: agent.cluster_id, agent_id: agent.id, session_id: agent.session_id,
    delivery_key: 'missing-handoff', kind: 'initial', author: 'manager', plan_ref: null, binding: null,
    content: 'already acknowledged delegation', native_message_id: 'missing-native-message' });
  runtime.store.acknowledgeMemberInput(input.id);
  let invoked = false;
  host.setScript(() => { invoked = true; });
  await assert.rejects(() => runTurn(host.ctx, { agent, role: agent.role, prompt: input.content,
    input: { kind: 'initial', key: input.delivery_key, author: 'manager' }, allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: true, turnSeq: 1, flow: { store: runtime.store } }),
  error => error instanceof Error && 'code' in error && error.code === 'DELIVERY_UNKNOWN');
  assert.equal(invoked, false);
  assert.equal(host.lastTurn?.prompt, undefined, 'no new first delegation is enqueued when earlier delivery cannot be reconciled');
});

test('compaction of the visible messages does not hide the original journal admission', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const started = runtime.start({ objective: 'compacted handoff', workspace: '/tmp', capabilities: [] });
  const agent = runtime.store.listAgents(started.cluster.id, { role: 'orchestrator' })[0]!;
  const session = Session.create(SessionId(agent.session_id));
  const task = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'compacted business task' }] });
  const saved = runtime.store.saveMemberInput({ cluster_id: agent.cluster_id, agent_id: agent.id, session_id: agent.session_id,
    delivery_key: 'compacted-handoff', kind: 'initial', author: 'manager', plan_ref: null, binding: null,
    content: 'compacted business task', native_message_id: task.id });
  session.append('user/message', task, { surfaceOp: 'append' });
  runtime.store.acknowledgeMemberInput(saved.id);
  host.setScript(turn => { for (const message of turn.inputs) session.append('user/message', message, { surfaceOp: 'append' }); });
  await runTurn(host.ctx, { agent, role: agent.role, prompt: saved.content, input: { kind: 'initial', key: saved.delivery_key, author: 'manager' },
    allowedTools: [], globalTools: [], model: runtime.config.model, resume: true, turnSeq: 1, flow: { store: runtime.store },
    onAgentReady(live) { live.session.deriveMessages = () => []; live.session.snapshotEvents = from => session.snapshotEvents(from); } });
  assert.equal(host.lastTurn?.prompt?.source.kind, 'flow');
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === task.id).length, 1);
});

test('team communication projection preserves explicit categories and defaults unclassified messages to discussion', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const team = runtime.startTeam('main', 'classified-team', '分类消息', '/tmp');
  const lead = runtime.store.listAgents(team.cluster.id, { role: 'orchestrator' })[0]!;
  for (const category of COMMUNICATION_CATEGORIES) {
    runtime.store.insertMessage({ id: category, cluster_id: team.cluster.id, from_agent: null, from_node: lead.node_id,
      kind: 'direct', content: { category, text: category } });
    runtime.store.insertRecipient(category, lead.id);
  }
  runtime.store.insertMessage({ id: 'unclassified', cluster_id: team.cluster.id, from_agent: null, from_node: lead.node_id,
    kind: 'direct', content: { text: 'unclassified message' } });
  runtime.store.insertRecipient('unclassified', lead.id);
  const rows = runtime.teamRead('main', team.cluster.id).communications;
  assert.equal(rows.length, 9);
  for (const category of COMMUNICATION_CATEGORIES) assert.equal(rows.find(row => row.id.startsWith(`${category}:`))?.category, category);
  assert.equal(rows.find(row => row.id.startsWith('unclassified:'))?.category, 'discussion');
});
