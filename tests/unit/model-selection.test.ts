import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-model-selection-'));
  const runtime = new ClusterRuntime(new Context(), {
    path: join(dir, 'ledger.sqlite'), dataDir: dir, autoTick: false,
    model: { provider: 'deployment', model: 'default', reasoningEffort: 'high', maxTokens: 4096 },
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
  assert.ok(large.team.agents.every(agent => agent.model === 'default'));
  runtime.teamSelectModel('main', { provider: 'owner', model: 'current' });
  const current = read();
  assert.equal(current.traversals, small.traversals);
  assert.ok(current.team.agents.every(agent => agent.model === 'current' && agent.reasoning_effort === null));
});

test('execution and team projection preserve model precedence, worker caps and recorded reasoning', async t => {
  const { runtime, id, lead, root } = fixture(t);
  assert.deepEqual(runtime.modelFor(lead), {
    provider: 'deployment', model: 'default', reasoningEffort: 'high', maxTokens: 4096,
  });
  runtime.teamSelectModel('main', { provider: 'owner', model: 'team' });
  assert.deepEqual(runtime.modelFor(lead), { provider: 'owner', model: 'team', maxTokens: 4096 });
  runtime.store.updateNode(root.id, { scope: {
    ...runtime.store.getNode(root.id)!.scope,
    team_model_options: { reasoningEffort: 'medium', maxTokens: 2048 },
  } });
  assert.deepEqual(runtime.modelFor(lead), {
    provider: 'owner', model: 'team', reasoningEffort: 'medium', maxTokens: 2048,
  });
  const cluster = runtime.store.getCluster(id)!;
  runtime.store.updateCluster(id, { limits: { ...cluster.limits, worker_max_tokens: 128 } });
  const worker = runtime.store.insertAgent({
    id: 'worker', cluster_id: id, node_id: root.id, role: 'worker', session_id: 'worker-session', status: 'READY',
    meta: { parent_agent_id: lead.id, model: { provider: 'member', model: 'override', reasoningEffort: 'low', maxTokens: 512 } },
  })!;
  assert.deepEqual(runtime.modelFor(worker), {
    provider: 'member', model: 'override', reasoningEffort: 'low', maxTokens: 128,
  });
  assert.equal(runtime.modelFor(lead).maxTokens, 2048, 'the Worker cap does not affect management');
  const shown = () => runtime.teamRead('main', id).agents.find(agent => agent.id === worker.id)!;
  assert.equal(shown().model, 'override');
  assert.equal(shown().reasoning_effort, 'low');
  runtime.store.insertUsageReceipt({
    request_id: 'recorded', cluster_id: id, agent_id: worker.id, node_id: root.id,
    role: 'worker', kind: 'model', model: 'recorded-model', reasoning_effort: 'high', status: 'SETTLED',
  });
  assert.equal(shown().model, 'recorded-model');
  assert.equal(shown().reasoning_effort, 'high');
  runtime.store.insertUsageReceipt({
    request_id: 'recorded-without-effort', cluster_id: id, agent_id: worker.id, node_id: root.id,
    role: 'worker', kind: 'model', model: 'recorded-default-effort', status: 'SETTLED',
  });
  assert.equal(shown().model, 'recorded-default-effort');
  assert.equal(shown().reasoning_effort, null, 'current preferences do not relabel a recorded default');
});
