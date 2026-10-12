import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { MANAGEMENT_CAPABILITIES, managementAuthorization, managementAuthorizationJson, resolveManagementAuthorization } from '../../packages/dsh-flow/src/core/management-authorization.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { fixtureParams } from './task-fixtures.ts';

function fixture(t: TestContext, overrides: Partial<FlowStartRequest> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-management-authority-'));
  const open = () => new ClusterRuntime(new Context(), { path: join(dir, 'flow.sqlite'), autoTick: false });
  let runtime = open();
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const started = runtime.start({ objective: 'Verify management execution authorization.', workspace: dir, capabilities: [], acceptance_criteria: ['Verified artifact.'], budget: { tool_calls: 500, agents: 32, max_active_agents: 4 }, ...overrides }).cluster;
  const cluster = runtime.store.getCluster(started.id)!;
  const root = runtime.store.listNodes(cluster.id, { parent_id: null })[0]!;
  const actor = (role: 'orchestrator' | 'allocator'): FlowAgentActor => {
    const agent = runtime.store.listAgents(cluster.id, { node_id: root.id, role })[0]!;
    return { role, cluster_id: cluster.id, node_id: root.id, agent_id: agent.id, session_id: agent.session_id };
  };
  const delegated = (params: Record<string, unknown> = {}) => {
    const tx = runtime.store.rootTransactions(cluster.id)[0]!;
    const caller = actor('allocator');
    return runtime.command(caller, { command_id: `child-${JSON.stringify(params)}`, action: 'spawn_management_node', params: fixtureParams(runtime, caller, 'spawn_management_node', { transaction_id: tx.id, fixture_prepare_management: true, ...params }) });
  };
  return { get runtime() { return runtime; }, cluster, root, actor, delegated, async reopen() { await runtime.dispose(); runtime = open(); runtime.recover({ deferScheduling: true }); return runtime; } };
}

test('management defaults persist all capabilities while Worker and Allocator authority remain separate', async t => {
  const f = fixture(t), before = resolveManagementAuthorization(f.cluster, f.root);
  assert.deepEqual(before.capabilities, MANAGEMENT_CAPABILITIES);
  assert.deepEqual(before.write_scope, ['.']);
  assert.deepEqual(f.cluster.capabilities, []);
  const lead = f.runtime.store.getAgent(f.actor('orchestrator').agent_id)!;
  const allocator = f.runtime.store.getAgent(f.actor('allocator').agent_id)!;
  const policy = f.runtime.allowedToolsFor(f.cluster, 'orchestrator', lead);
  for (const name of ['read', 'write', 'bash', 'job_output', 'web_fetch']) assert.ok(policy.allowed.includes(name), name);
  assert.ok(policy.allowed.some(name => name.includes('browser_snapshot')));
  assert.equal(f.runtime.allowedToolsFor(f.cluster, 'allocator', allocator).allowed.includes('bash'), false);
  const reopened = await f.reopen();
  assert.deepEqual(resolveManagementAuthorization(reopened.store.getCluster(f.cluster.id)!, reopened.store.getNode(f.root.id)!), before);
  assert.deepEqual(reopened.allowedToolsFor(reopened.store.getCluster(f.cluster.id)!, 'orchestrator', reopened.store.getAgent(lead.id)!).allowed, policy.allowed);
});

test('delegated management inherits the exact durable grant and cannot widen capability or path boundaries', async t => {
  const f = fixture(t, { managementCapabilities: ['fs_read', 'fs_write'], managementWriteScope: ['output'] });
  assert.throws(() => f.delegated({ managementCapabilities: ['fs_read', 'shell'] }), /cannot widen/);
  assert.throws(() => f.delegated({ managementWriteScope: ['.'] }), /cannot widen/);
  const reply = f.delegated();
  const childId = String(objectField(reply.result, 'spawn outcome').node_id), child = f.runtime.store.getNode(childId)!;
  assert.deepEqual(resolveManagementAuthorization(f.cluster, child), resolveManagementAuthorization(f.cluster, f.root));
  assert.equal(f.runtime.store.listAgents(f.cluster.id, { node_id: childId }).length, 2);
  const before = child.scope?.execution_authorization;
  const runtime = await f.reopen();
  assert.deepEqual(runtime.store.getNode(childId)!.scope?.execution_authorization, before);
  runtime.store.updateNode(f.root.id, { scope: { ...runtime.store.getNode(f.root.id)!.scope, execution_authorization: managementAuthorizationJson(managementAuthorization(f.cluster.workspace, ['fs_read'], ['output'])) } });
  const childAgent = runtime.store.listAgents(f.cluster.id, { node_id: childId, role: 'orchestrator' })[0]!;
  assert.throws(() => runtime.allowedToolsFor(runtime.store.getCluster(f.cluster.id)!, 'orchestrator', childAgent), /exceeds its current ancestor grant/, 'restored children cannot retain wider permissions after a parent grant narrows');
});

test('an explicit empty management grant remains empty through delegation and restart', async t => {
  const f = fixture(t, { managementCapabilities: [], managementWriteScope: [] });
  const reply = f.delegated(), childId = String(objectField(reply.result, 'spawn outcome').node_id);
  for (const nodeId of [f.root.id, childId]) {
    const node = f.runtime.store.getNode(nodeId)!;
    assert.deepEqual(resolveManagementAuthorization(f.cluster, node).capabilities, []);
    assert.deepEqual(resolveManagementAuthorization(f.cluster, node).write_scope, []);
  }
  const runtime = await f.reopen();
  assert.deepEqual(resolveManagementAuthorization(runtime.store.getCluster(f.cluster.id)!, runtime.store.getNode(childId)!).capabilities, []);
});


test('reparenting cannot move a management grant beneath a narrower parent', t => {
  const f = fixture(t, { managementCapabilities: ['fs_read', 'fs_write'], managementWriteScope: ['.'] });
  const wideId = String(objectField(f.delegated().result, 'wide child').node_id);
  const lead = f.actor('orchestrator'), allocator = f.actor('allocator');
  const created = f.runtime.command(lead, { command_id: 'new-narrow-task', action: 'create_transaction', params: { objective: 'Own a restricted output directory.', acceptance_criteria: ['Deliver the restricted result.'] } });
  const narrowTask = String(objectField(created.result, 'created').transaction_id);
  const narrowId = String(objectField(f.delegated({ transaction_id: narrowTask, managementCapabilities: ['fs_read'], managementWriteScope: ['output'] }).result, 'narrow child').node_id);
  const nodes = f.runtime.store.listNodes(f.cluster.id), budgets = f.runtime.store.listBudgets(f.cluster.id), seq = f.runtime.store.latestEventSeq(f.cluster.id);
  assert.throws(() => f.runtime.command(allocator, { command_id: 'invalid-reparent', action: 'reparent', params: { node_id: wideId, new_parent_id: narrowId } }), /cannot widen/);
  assert.deepEqual(f.runtime.store.listNodes(f.cluster.id), nodes);
  assert.deepEqual(f.runtime.store.listBudgets(f.cluster.id), budgets);
  assert.equal(f.runtime.store.latestEventSeq(f.cluster.id), seq);
});
