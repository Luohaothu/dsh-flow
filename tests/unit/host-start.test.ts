import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { ToolArgsError } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { Config, resolveConfig, INTERACTIVE_BUDGET, INTERACTIVE_LIMITS } from '../../packages/dsh-flow/src/config.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowService } from '../../packages/dsh-flow/src/service.ts';
import type { FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';
import * as userTools from '../../packages/dsh-flow/src/tools.ts';
import { FlowRemote } from '../../packages/dsh-flow/src/web.ts';
import { createFakeHost } from './fake-host.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-start-contract-'));
  const host = createFakeHost();
  const deployment = resolveConfig(Config({
    provider: 'local-fake', model: 'fake-model', workspace: dir, dataDir: dir,
    defaultBudget: { model_requests: 37 }, defaultLimits: { max_depth: 3 },
  }));
  const runtime = new ClusterRuntime(host.ctx, {
    ...deployment.runtime, path: join(dir, 'cluster.sqlite'), dataDir: dir,
    startDefaults: deployment.startDefaults, autoTick: false,
  });
  const flow: FlowService = runtime;
  host.ctx.provide('flow', flow);
  const scoped = new Map<string, ToolDefinition>();
  const toolsScope = host.ctx.extend({ tools: {
    register(definition: ToolDefinition) { scoped.set(definition.name, definition); return () => scoped.delete(definition.name); },
  } });
  const toolsFiber = toolsScope.plugin(userTools);
  const remote = new FlowRemote(host.ctx);
  t.after(async () => {
    await toolsFiber.dispose();
    await runtime.dispose();
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, host, scoped, flow, runtime, remote, toolsFiber };
}

test('service, scoped user tool and Remote share persisted per-field start defaults', async t => {
  const f = fixture(t);
  await f.toolsFiber.await();
  assert.deepEqual([...f.scoped.keys()].sort(), ['flow_control', 'flow_read', 'flow_start']);
  assert.equal(f.host.tools.has('flow_start'), false, 'user tools remain in the selected scope');
  const request: FlowStartRequest = {
    objective: 'same partial envelope', budget: { tokens: 100_000 },
    limits: { max_children: 2 }, capabilities: [],
  };
  const local = f.flow.start(request);
  const remote = f.remote.start(request, new AbortController().signal);
  const tool = f.scoped.get('flow_start');
  assert.ok(tool);
  await tool.execute(request, fromPartial<ToolRunContext>({ signal: new AbortController().signal }));
  const persisted = f.runtime.store.listClusters({});
  assert.equal(persisted.length, 3);
  for (const row of persisted) {
    assert.equal(row.workspace, f.dir);
    assert.deepEqual(row.capabilities, [], 'an explicit empty capability list is not replaced');
    assert.deepEqual(row.limits, { ...INTERACTIVE_LIMITS, max_depth: 3, max_children: 2 });
    // start grants the root scope into node/compaction budgets; the stored
    // cluster envelope retains the exact merged request before those grants.
    assert.equal(row.budget.tokens, 100_000);
    assert.equal(row.budget.model_requests, 37);
    assert.equal(row.budget.tool_calls, INTERACTIVE_BUDGET.tool_calls);
    assert.equal(row.budget.wall_time_ms, INTERACTIVE_BUDGET.wall_time_ms);
    assert.equal(row.budget.agents, INTERACTIVE_BUDGET.agents);
    assert.equal(row.budget.max_active_agents, INTERACTIVE_BUDGET.max_active_agents);
    assert.ok(f.flow.events(row.id, {}).events.length > 0);
  }
  assert.notEqual(local.cluster.id, remote.cluster.id);
  const omitted = f.flow.start({ objective: 'omitted capabilities' });
  assert.deepEqual(omitted.cluster.capabilities, ['fs_read', 'fs_write']);
});

test('invalid starts reject across all entrypoints without writing clusters or events', async t => {
  const f = fixture(t);
  await f.toolsFiber.await();
  const tool = f.scoped.get('flow_start');
  assert.ok(tool);
  const malformed: unknown[] = [
    { budget: { tokens: 0 } }, { budget: { tokens: -1 } }, { budget: { tokens: '100' } },
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
    assert.throws(() => f.remote.start(request, new AbortController().signal), rejected);
    // The native tool's declared string parameter rejects null before the
    // flow handler; JSON budget/limits null still reach flow/rejected above.
    await assert.rejects(
      tool.execute(request, fromPartial<ToolRunContext>({ signal: new AbortController().signal })),
      'workspace' in input && input.workspace === null ? ToolArgsError : rejected,
    );
    assert.deepEqual(f.runtime.store.listClusters({}), []);
    assert.deepEqual(f.runtime.store.all('SELECT * FROM events'), before);
  }
});
