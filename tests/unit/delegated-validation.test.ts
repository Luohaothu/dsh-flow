import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole } from '../../packages/dsh-flow/src/types.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost } from './fake-host.ts';
import { fixtureParams } from './task-fixtures.ts';

function delegatedFixture(t: TestContext) {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const clusterId = runtime.start({ managementCapabilities: [], objective: 'Delegate and validate the delivered answer.', workspace: '/tmp',
    capabilities: [], acceptance_criteria: ['The answer is 5.'],
    limits: { max_active_agents: 4, max_llm_concurrency: 2, max_role_turns: 20 },
    budget: { tool_calls: 1000, agents: 16, max_active_agents: 4 },
  }).cluster.id;
  const root = runtime.store.listNodes(clusterId, { parent_id: null })[0]!;
  const parent = runtime.store.rootTransactions(clusterId)[0]!;
  const actor = (nodeId: string, role: FlowAgentRole): FlowAgentActor => {
    const agent = runtime.store.listAgents(clusterId, { node_id: nodeId, role, limit: 1 })[0]!;
    return { cluster_id: clusterId, node_id: nodeId, role, agent_id: agent.id, session_id: agent.session_id };
  };
  let commandSeq = 0;
  const command = (author: FlowAgentActor, action: string, params: Record<string, unknown>) => runtime.command(author, {
    command_id: `delegated-wait:${++commandSeq}`, action, params: fixtureParams(runtime, author, action, params),
  });
  command(actor(root.id, 'orchestrator'), 'dispatch', { transaction_id: parent.id, fixture_execution: 'management' });
  const spawned = objectField(command(actor(root.id, 'allocator'), 'spawn_management_node', {
    transaction_id: parent.id, budget: { tool_calls: 300, agents: 4, max_active_agents: 2 },
  }).result, 'management delegation');
  const node = runtime.store.getNode(String(spawned.node_id))!;
  const child = runtime.store.getTransaction(String(spawned.delegated_transaction_id))!;
  const lead = actor(node.id, 'orchestrator');
  command(lead, 'dispatch', { transaction_id: child.id });
  // An explicit fixture publication does not claim to be native Worker execution.
  runtime.store.updateTransaction(child.id, { status: 'SUBMITTED', result: '2+3=5' });
  // Isolate the receiving domain; unrelated parent planning cannot book progress for it.
  for (const member of runtime.store.listAgents(clusterId, { node_id: root.id })) runtime.store.updateAgent(member.id, { status: 'BLOCKED' });
  runtime.store.consumeInbox(runtime.store.listInbox(clusterId, { recipient: lead.agent_id, status: 'PENDING' }).map(row => row.id));
  return { host, runtime, clusterId, root, parent, node, child, lead, command };
}

test('a delegated positive validation is accepted immediately and permits its parent to aggregate', async t => {
  const f = delegatedFixture(t); const { runtime, clusterId, node, child, lead } = f;
  const pending = () => runtime.pendingFor('orchestrator', runtime.store.getNode(node.id)!, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(lead.agent_id));
  assert.ok(pending().some(item => item.action === 'validate'));
  f.command(lead, 'validate', { transaction_id: child.id, accepted: true, checks: [{ passed: true }] });
  const accepted = runtime.store.getTransaction(child.id)!;
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(runtime.store.getValidation(accepted.current_validation_ref)?.author_agent_id, lead.agent_id);
  assert.ok(runtime.store.aggregatableParents(clusterId, f.root.id).some(row => row.parent_id === f.parent.id));
  assert.equal(pending().some(item => item.action === 'validate'), false);
  runtime.evaluateCompletion(clusterId);
  assert.equal(runtime.store.listAgents(clusterId, { node_id: node.id }).length, 2);
  assert.equal(runtime.store.getNode(node.id)?.status, 'COMPLETED');
});

test('a delegated author still blocks after three idle turns when actual validation work is available', async t => {
  const f = delegatedFixture(t);
  f.host.setScript(async turn => { await turn.callTool('flow_query', { what: 'agenda' }); });
  f.runtime.enableScheduling();
  for (let index = 0; index < 3; index += 1) {
    await f.runtime.tick();
    await Promise.all(f.runtime.activeTurnIds().map(id => f.runtime.activeTurnFor(id)!.promise));
  }
  assert.equal(f.runtime.store.getAgent(f.lead.agent_id)?.turns, 3);
  assert.equal(f.runtime.store.getNode(f.node.id)?.status, 'BLOCKED', 'real unperformed work remains subject to the no-progress guard');
  assert.equal(f.runtime.store.getTransaction(f.child.id)?.status, 'SUBMITTED');
});
