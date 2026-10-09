import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowAgentRole } from '../../packages/dsh-flow/src/types.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost } from './fake-host.ts';
import { fixtureAuditEvidence, fixtureParams } from './task-fixtures.ts';

function delegatedFixture(t: TestContext) {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const clusterId = runtime.start({ objective: 'Delegate and independently audit the delivered answer.', workspace: '/tmp',
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
  const parentAudit = runtime.store.pendingAudits(clusterId, { node_id: root.id, kind: 'plan' })[0]!;
  command(actor(root.id, 'auditor'), 'inspect_plan', { audit_id: parentAudit.id, decision: 'approve' });
  const spawned = objectField(command(actor(root.id, 'allocator'), 'spawn_management_node', {
    transaction_id: parent.id, budget: { tool_calls: 300, agents: 4, max_active_agents: 2 },
  }).result, 'management delegation');
  const node = runtime.store.getNode(String(spawned.node_id))!;
  const child = runtime.store.getTransaction(String(spawned.delegated_transaction_id))!;
  const lead = actor(node.id, 'orchestrator');
  const auditor = actor(node.id, 'auditor');
  command(lead, 'dispatch', { transaction_id: child.id });
  const childAudit = runtime.store.pendingAudits(clusterId, { node_id: node.id, kind: 'plan' })[0]!;
  command(auditor, 'inspect_plan', { audit_id: childAudit.id, decision: 'approve' });
  // An explicit fixture publication does not claim to be native Worker execution.
  runtime.store.updateTransaction(child.id, { status: 'SUBMITTED', result: '2+3=5' });
  // Isolate the receiving domain; unrelated parent planning cannot book progress for it.
  for (const member of runtime.store.listAgents(clusterId, { node_id: root.id })) runtime.store.updateAgent(member.id, { status: 'BLOCKED' });
  runtime.store.consumeInbox(runtime.store.listInbox(clusterId, { recipient: lead.agent_id, status: 'PENDING' }).map(row => row.id));
  return { host, runtime, clusterId, root, parent, node, child, lead, auditor, command };
}

test('a delegated validation waits for its independent auditor without repeated orchestration, then closes normally', async t => {
  let approve: () => void = () => {};
  t.after(() => { approve(); });
  const f = delegatedFixture(t);
  const { runtime, clusterId, node, child, lead, auditor } = f;
  const pending = () => runtime.pendingFor('orchestrator', runtime.store.getNode(node.id)!, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(lead.agent_id));
  assert.ok(pending().some(item => item.action === 'validate'), 'SUBMITTED still requires actual validation');
  assert.equal(pending().some(item => item.action === 'report-to-parent'), false, 'an unaccepted publication is validation work, not closeout');
  f.command(lead, 'validate', { transaction_id: child.id, accepted: true, checks: [{ passed: true }] });
  const validating = runtime.store.getTransaction(child.id)!;
  const audit = runtime.store.pendingAudits(clusterId, { node_id: node.id, kind: 'validation' })[0]!;
  assert.equal(validating.status, 'VALIDATING');
  assert.equal(audit.decision, 'PENDING');
  assert.equal(runtime.store.getValidation(validating.current_validation_ref)?.accepted, true);
  assert.equal(pending().length, 0, 'the author cannot execute the independent approval');
  assert.equal(runtime.query(lead, 'agenda').items.some(item => item.kind === 'closeout'), false);

  let entered!: () => void;
  const auditEntered = new Promise<void>(resolve => { entered = resolve; });
  const approval = new Promise<void>(resolve => { approve = resolve; });
  f.host.setScript(async turn => {
    const member = runtime.store.getAgentBySession(turn.session.id)!;
    if (member.id !== auditor.agent_id) {
      await turn.callTool('flow_query', { what: 'agenda' });
      return;
    }
    if (runtime.store.getTransaction(child.id)?.status === 'VALIDATING') {
      entered();
      await approval;
      const result = await turn.callTool('flow_audit', { action: 'inspect_validation', params: {
        audit_id: audit.id, decision: 'approve', evidence: fixtureAuditEvidence(runtime, child.id, 'validation'),
      } });
      assert.equal(result.isError, false);
    } else {
      const dimensions = Object.fromEntries(runtime.healthMetricNames().map(name => [name, 1]));
      const result = await turn.callTool('flow_audit', { action: 'evaluate_health', params: {
        evaluation_window: 'subtree-close', dimensions, evidence: 'The current delegated result and validation were independently approved before closeout.',
      } });
      assert.equal(result.isError, false);
    }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await auditEntered;
  assert.ok(runtime.activeTurnFor(auditor.agent_id), 'the independent native auditor really is running');
  for (let index = 0; index < 5; index += 1) {
    await runtime.tick();
    await Promise.all(runtime.activeTurnIds().filter(id => id !== auditor.agent_id).map(id => runtime.activeTurnFor(id)!.promise));
  }
  assert.equal(runtime.store.getNode(node.id)?.status, 'ACTIVE');
  assert.equal(runtime.store.getAgent(lead.agent_id)?.turns, 0, 'waiting alone admits no repeated native author turns');
  assert.equal(runtime.store.all('SELECT id FROM member_inputs WHERE agent_id=?', lead.agent_id).length, 0);
  assert.equal(runtime.store.all("SELECT seq FROM events WHERE cluster_id=? AND type='node-blocked'", clusterId).length, 0);
  assert.equal(runtime.store.getTransaction(child.id)?.status, 'VALIDATING');

  approve();
  await runtime.activeTurnFor(auditor.agent_id)!.promise;
  const accepted = runtime.store.getTransaction(child.id)!;
  assert.equal(accepted.status, 'ACCEPTED');
  assert.deepEqual(accepted.current_plan_ref, validating.current_plan_ref);
  assert.deepEqual(accepted.current_result_ref, validating.current_result_ref);
  assert.deepEqual(accepted.current_validation_ref, validating.current_validation_ref);
  assert.equal(runtime.store.getAudit(audit.id)?.decision, 'APPROVED');
  assert.ok(runtime.store.aggregatableParents(clusterId, f.root.id).some(row => row.parent_id === f.parent.id), 'the accepted current delivery wakes its receiving parent');
  assert.equal(pending().length, 0, 'accepted deliveries do not start endless reporting turns');
  runtime.evaluateCompletion(clusterId);
  assert.ok(runtime.pendingFor('auditor', runtime.store.getNode(node.id)!, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(auditor.agent_id))
    .some(item => item.action === 'evaluate_health'), 'acceptance unlocks the actual subtree closeout');
  await runtime.tick();
  await Promise.all(runtime.activeTurnIds().map(id => runtime.activeTurnFor(id)!.promise));
  runtime.evaluateCompletion(clusterId);
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
