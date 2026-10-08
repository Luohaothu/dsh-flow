import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { fromPartial } from '@total-typescript/shoehorn';
import { Context } from '@deepseek-ai/cordis';
import { validateModelSelection } from '../../packages/dsh-flow/src/core/model-selection.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-model-selection-'));
  const runtime = new ClusterRuntime(new Context(), {
    path: join(dir, 'ledger.sqlite'), dataDir: dir, autoTick: false,
    model: { provider: 'deployment', model: 'default', reasoningEffort: 'high' },
  });
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const run = runtime.startTeam('main', 'launch', 'Check model selection', dir);
  const lead = runtime.store.listAgents(run.cluster.id, { role: 'orchestrator' })[0]!;
  const root = runtime.store.getNode(lead.node_id)!;
  return { runtime, id: run.cluster.id, lead, root };
}

test('team model preparation stays bounded across member pages and reads current configuration', async t => {
  const { runtime, id, lead } = fixture(t);
  const traversals = t.mock.method(runtime.store, 'nodesInSubtree');
  const read = () => {
    traversals.mock.resetCalls();
    const team = runtime.teamRead('main', id);
    return { team, traversals: traversals.mock.callCount() };
  };
  const small = read();
  assert.equal(small.team.agents.length, 3);
  runtime.store.tx(() => {
    for (let index = 0; index < 503; index += 1) {
      runtime.store.insertAgent({
        id: `worker-${index}`, cluster_id: id, node_id: lead.node_id,
        role: 'worker', session_id: `worker-session-${index}`, status: 'READY',
        meta: { parent_agent_id: lead.id },
      });
    }
  });
  const large = read();
  assert.equal(large.team.agents.length, 506);
  assert.equal(large.traversals, small.traversals, 'reading more members does not repeat tree traversal');
  assert.ok(large.team.agents.every(agent => agent.configured_model === 'default'));
  runtime.teamSelectModel('main', { provider: 'owner', model: 'current' });
  const current = read();
  assert.equal(current.traversals, small.traversals);
  assert.ok(current.team.agents.every(agent => agent.configured_model === 'current' && agent.configured_reasoning_effort === null));
});

test('execution and team projection preserve model precedence, native recorded reasoning', async t => {
  const { runtime, id, lead, root } = fixture(t);
  assert.deepEqual(runtime.modelFor(lead), {
    provider: 'deployment', model: 'default', reasoningEffort: 'high',
  });
  runtime.teamSelectModel('main', { provider: 'owner', model: 'team' });
  assert.deepEqual(runtime.modelFor(lead), { provider: 'owner', model: 'team' });
  runtime.store.updateNode(root.id, { scope: {
    ...runtime.store.getNode(root.id)!.scope,
    team_model_options: { reasoningEffort: 'medium' },
  } });
  assert.deepEqual(runtime.modelFor(lead), {
    provider: 'owner', model: 'team', reasoningEffort: 'medium',
  });
  const worker = runtime.store.insertAgent({
    id: 'worker', cluster_id: id, node_id: root.id, role: 'worker', session_id: 'worker-session', status: 'READY',
    meta: { parent_agent_id: lead.id, model: { provider: 'member', model: 'override', reasoningEffort: 'low' } },
  })!;
  assert.deepEqual(runtime.modelFor(worker), {
    provider: 'member', model: 'override', reasoningEffort: 'low',
  });
  const shown = () => runtime.teamRead('main', id).agents.find(agent => agent.id === worker.id)!;
  assert.equal(shown().model, null, 'configuration does not fabricate an actual request');
  assert.equal(shown().configured_model, 'override');
  assert.equal(shown().configured_reasoning_effort, 'low');
  const facts = (model: string, reasoningEffort?: string): SessionEvent[] => [
    fromPartial<SessionEvent<'request/header'>>({ type: 'request/header', seq: SessionSeq(0), time: 1,
      data: { header: { config: { provider: 'member', model, ...(reasoningEffort ? { reasoningEffort } : {}) } } } }),
    fromPartial<SessionEvent<'assistant/message'>>({ type: 'assistant/message', seq: SessionSeq(1), time: 2,
      data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'member', model } }) } }),
  ];
  runtime.store.projectNativeUsage({ clusterId: id, nodeId: root.id, agentId: worker.id, nativeSessionId: worker.session_id,
    role: 'worker', events: facts('recorded-model', 'high') });
  assert.equal(shown().model, 'recorded-model');
  assert.equal(shown().reasoning_effort, 'high');
  runtime.store.projectNativeUsage({ clusterId: id, nodeId: root.id, agentId: worker.id, nativeSessionId: worker.session_id,
    role: 'worker', events: facts('recorded-default-effort').map(event => ({ ...event, seq: SessionSeq(event.seq + 2), time: event.time + 2 })) });
  assert.equal(shown().model, 'recorded-default-effort');
  assert.equal(shown().reasoning_effort, null, 'current preferences do not relabel a recorded default');
});


test('model selection rejects deleted execution controls, including nested output settings', () => {
  for (const fields of [{ maxTokens: 1 }, { max_tokens: 1 }, { context: {} }, { output: { maxTokens: 1 } }, { options: { max_tokens: 1 } }]) {
    assert.throws(() => validateModelSelection({ provider: 'host', model: 'model', ...fields }), /Unsupported model selection field/);
  }
});
