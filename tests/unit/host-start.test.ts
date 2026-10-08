import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny } from '@total-typescript/shoehorn';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { Config, resolveConfig, INTERACTIVE_BUDGET, INTERACTIVE_LIMITS } from '../../packages/dsh-flow/src/config.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowService } from '../../packages/dsh-flow/src/service.ts';
import type { FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';
import { createFakeHost } from './fake-host.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-start-contract-'));
  const host = createFakeHost();
  const deployment = resolveConfig(Config({
    provider: 'local-fake', model: 'fake-model', workspace: dir, dataDir: dir,
    defaultBudget: { tool_calls: 37 }, defaultLimits: { max_depth: 3 },
  }));
  const runtime = new ClusterRuntime(host.ctx, {
    ...deployment.runtime, path: join(dir, 'cluster.sqlite'), dataDir: dir,
    startDefaults: deployment.startDefaults, autoTick: false,
  });
  const flow: FlowService = runtime;
  host.ctx.provide('flow', flow);
  t.after(async () => {
    await runtime.dispose();
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, flow, runtime };
}

test('service starts persist deployment defaults merged per field', t => {
  const f = fixture(t);
  const request: FlowStartRequest = {
    objective: 'same partial envelope', budget: { tool_calls: 100_000 },
    limits: { max_children: 2 }, capabilities: [],
  };
  f.flow.start(request);
  const persisted = f.runtime.store.listClusters({});
  assert.equal(persisted.length, 1);
  for (const row of persisted) {
    assert.equal(row.workspace, f.dir);
    assert.deepEqual(row.capabilities, [], 'an explicit empty capability list is not replaced');
    assert.deepEqual(row.limits, { ...INTERACTIVE_LIMITS, max_depth: 3, max_children: 2 });
    // The envelope retains the merged resource contract before grants.
    assert.equal(row.budget.tool_calls, 100_000);
    assert.equal(row.budget.wall_time_ms, INTERACTIVE_BUDGET.wall_time_ms);
    assert.equal(row.budget.agents, INTERACTIVE_BUDGET.agents);
    assert.equal(row.budget.max_active_agents, INTERACTIVE_BUDGET.max_active_agents);
    assert.ok(f.flow.events(row.id, {}).events.length > 0);
  }
  const omitted = f.flow.start({ objective: 'omitted capabilities' });
  assert.deepEqual(omitted.cluster.capabilities, ['fs_read', 'fs_write']);
});

test('invalid service starts reject without writing clusters or events', t => {
  const f = fixture(t);
  const malformed: unknown[] = [
    { budget: { tool_calls: 0 } }, { budget: { tool_calls: -1 } }, { budget: { tool_calls: '100' } },
    { budget: { tokens: 1 } }, { budget: { model_requests: 1 } }, { budget: { requests: 1 } },
    { maxTokens: 1 }, { context: {} }, { limits: { worker_max_tokens: 1 } }, { limits: { worker_model_requests: 1 } },
    { budget: null }, { limits: { max_children: 0 } }, { limits: { max_depth: -1 } },
    { limits: { max_children: '2' } }, { limits: null },
    { workspace: null }, { workspace: '' },
  ];
  const rejected = (error: unknown): boolean => rejectionStatus(error) === 400;
  for (const input of malformed) {
    assert.ok(input !== null && typeof input === 'object');
    // Deliberately invalid wire inputs must reach the shared runtime validators.
    const request = fromAny<FlowStartRequest, object>({ objective: 'must not persist', ...input });
    const before = f.runtime.store.all('SELECT * FROM events');
    assert.throws(() => f.flow.start(request), rejected);
    assert.deepEqual(f.runtime.store.listClusters({}), []);
    assert.deepEqual(f.runtime.store.all('SELECT * FROM events'), before);
  }
});


test('deployment configuration rejects removed model controls before defaults can hide them', () => {
  for (const input of [
    { maxTokens: 4096 }, { context: {} },
    { defaultModel: { provider: 'host', model: 'model', maxTokens: 1 } },
    { defaultBudget: { tokens: 1000 } }, { defaultBudget: { model_requests: 1 } }, { defaultBudget: { requests: 1 } },
    { defaultLimits: { worker_max_tokens: 512 } }, { defaultLimits: { worker_model_requests: 1 } },
  ]) assert.throws(() => Reflect.apply(Config, undefined, [{ provider: 'fixture', model: 'model', ...input }]), /Removed configuration field|Unsupported defaultModel field/);
});
