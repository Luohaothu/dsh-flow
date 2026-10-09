import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentWorkerProducer } from '../acceptance/handoff-worker-identity.ts';

const plan = { transaction_id: 'task', prepared_revision: 3 };
const tx = { id: 'task', cluster_id: 'cluster', node_id: 'manager', current_plan_ref: JSON.stringify(plan) };
const publication = { cluster_id: 'cluster', ref: { transaction_id: 'task', publication_event_seq: 146 },
  plan_ref: plan, producer_role: 'worker', producer_agent_id: 'producer' };
const agents = [{ id: 'producer', cluster_id: 'cluster', role: 'worker', node_id: 'worker-home' }];
const nodes = [{ id: 'worker-home', cluster_id: 'cluster', kind: 'worker', parent_id: 'manager' }];
const allocation = { cluster_id: 'cluster', agent_id: 'producer', transaction_id: 'task', node_id: 'manager', plan_ref: JSON.stringify(plan), status: 'RELEASED' };

test('completed Worker delivery retains its real allocation and dedicated residence', () => {
  assert.equal(isCurrentWorkerProducer(tx, publication, agents, nodes, [allocation]), true);
});

test('a different task, producer or management domain cannot supply the Worker identity', () => {
  for (const patch of [{ transaction_id: 'other-task' }, { agent_id: 'other-worker' }, { node_id: 'other-manager' }, { cluster_id: 'other-cluster' }]) {
    assert.equal(isCurrentWorkerProducer(tx, publication, agents, nodes, [{ ...allocation, ...patch }]), false);
  }
  assert.equal(isCurrentWorkerProducer(tx, publication, agents, [{ ...nodes[0], parent_id: 'other-manager' }], [allocation]), false);
  assert.equal(isCurrentWorkerProducer(tx, publication, [{ ...agents[0], role: 'auditor' }], nodes, [allocation]), false);
});

test('historical allocations and publications cannot impersonate the current plan', () => {
  const old = { ...plan, prepared_revision: 2 };
  assert.equal(isCurrentWorkerProducer(tx, publication, agents, nodes, [{ ...allocation, plan_ref: JSON.stringify(old) }]), false);
  assert.equal(isCurrentWorkerProducer(tx, { ...publication, plan_ref: old }, agents, nodes, [allocation]), false);
  assert.equal(isCurrentWorkerProducer(tx, publication, agents, nodes, [{ ...allocation, plan_ref: JSON.stringify({ ...plan, alias: 'current' }) }]), false);
});
