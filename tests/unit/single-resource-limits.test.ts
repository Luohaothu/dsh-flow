import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { rollupBudgets } from '../../packages/dsh-flow/src/core/budget.ts';
import { createFakeHost } from './fake-host.ts';

function fixture(t: TestContext, maxTurnMs = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-single-resources-'));
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'ledger.sqlite'), dataDir: dir, autoTick: false, maxTurnMs,
    model: { provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off' },
  });
  t.after(async () => {
    await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, host, runtime };
}

test('single startup transfers one tool endowment and rejects calls after it is spent', async t => {
  const { dir, host, runtime } = fixture(t);
  let executions = 0;
  for (const name of ['read', 'glob', 'grep']) {
    host.registerTool({
      name, description: 'single resource fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { executions += 1; return 'recorded'; },
    });
  }
  const refused: boolean[] = [];
  host.setScript(async turn => {
    for (let call = 0; call < 3; call += 1) {
      const result = await turn.callTool('read', { file_path: 'fixture.txt' });
      refused.push(result.isError);
    }
    turn.concluded = true;
  });
  const result = await runtime.runSingleAgent({
    objective: 'Use the retained tool quota', workspace: dir, capabilities: ['fs_read'], budget: { tool_calls: 2 },
  });
  assert.equal(result.error, null);
  assert.deepEqual(refused, [false, false, true]);
  assert.equal(executions, 2);
  const resources = rollupBudgets(runtime.store, result.cluster_id);
  assert.equal(resources.tool_calls.limit, 2, 'root, node and identity grants conserve the original endowment');
  assert.equal(resources.tool_calls.spent, 2);
  assert.equal(resources.tool_calls.reserved, 0);
  assert.deepEqual(runtime.store.toolCallReceipts(result.cluster_id).map(row => row.dispatch_status), ['SETTLED', 'SETTLED']);
});

for (const bound of ['timeout', 'wall budget', 'turn duration'] as const) {
  test(`single execution cancels at the retained ${bound} bound`, async t => {
    const { dir, host, runtime } = fixture(t, bound === 'turn duration' ? 25 : 10_000);
    host.setScript(async () => { await new Promise<void>(() => {}); });
    const result = await runtime.runSingleAgent({
      objective: 'Stop at the earliest time bound', workspace: dir, capabilities: [],
      timeoutMs: bound === 'timeout' ? 25 : 10_000,
      budget: { wall_time_ms: bound === 'wall budget' ? 25 : 10_000 },
    });
    assert.equal(host.lastTurn?.cancelled, true);
    assert.equal(result.stop_reason, 'aborted');
    assert.equal(runtime.store.getCluster(result.cluster_id)?.status, 'FAILED');
    assert.equal(runtime.store.listTransactions({ cluster_id: result.cluster_id })[0]?.status, 'FAILED');
    assert.equal(runtime.store.listAgents(result.cluster_id)[0]?.status, 'TERMINATED');
    assert.equal(runtime.store.usageSummary(result.cluster_id).completeness, 'incomplete');
    assert.equal(runtime.store.all('SELECT id FROM leases WHERE cluster_id=?', result.cluster_id).length, 0);
  });
}
