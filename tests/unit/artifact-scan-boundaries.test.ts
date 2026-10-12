import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost } from './fake-host.ts';
import { fixtureParams, publishFixtureResult } from './task-fixtures.ts';

for (const kind of ['directory', 'symlink', 'before-limit', 'after-limit'] as const) test(`declared artifact scan preserves the ${kind} boundary`, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-artifact-scan-')));
  const file = join(dir, 'delivery.txt');
  writeFileSync(file, 'original');
  let declared = 'delivery.txt';
  let target = file;
  if (kind === 'directory') {
    mkdirSync(join(dir, 'delivery'));
    target = join(dir, 'delivery', 'part.txt');
    writeFileSync(target, 'original');
    declared = 'delivery';
  } else if (kind === 'symlink') {
    // Equal bytes still represent another published target after relinking.
    writeFileSync(join(dir, 'alternate.txt'), 'original');
    symlinkSync('delivery.txt', join(dir, 'published.txt'));
    declared = 'published.txt';
    target = join(dir, 'published.txt');
  } else if (kind === 'before-limit') truncateSync(file, 256 * 1024 * 1024 + 1);
  const host = createFakeHost();
  let runtime: ClusterRuntime;
  let dispatched = 0;
  host.registerTool({ name: 'write', description: 'Execute a controlled artifact mutation.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, async execute() {
      dispatched += 1;
      assert.equal(runtime.store.inTransaction, false, 'native filesystem execution is outside the ledger transaction');
      if (kind === 'symlink') { unlinkSync(target); symlinkSync('alternate.txt', target); }
      else if (kind === 'after-limit') truncateSync(file, 256 * 1024 * 1024 + 1);
      else writeFileSync(target, 'changed');
      return 'done';
    } });
  host.registerTool({ name: 'edit', description: 'Unused required capability companion.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, async execute() { assert.fail('unused edit'); } });
  runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const clusterId = runtime.start({ objective: 'Preserve declared output artifacts.', workspace: dir,
    acceptance_criteria: ['Preserve the original delivery.'], capabilities: [], managementCapabilities: ['fs_write'],
    budget: { tool_calls: 100, agents: 8 } }).cluster.id;
  const lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const actor: FlowAgentActor = { role: 'orchestrator', cluster_id: clusterId, node_id: lead.node_id, agent_id: lead.id, session_id: lead.session_id };
  const tx = runtime.store.rootTransactions(clusterId)[0]!;
  runtime.command(actor, { command_id: 'prepare', action: 'dispatch', params: fixtureParams(runtime, actor, 'dispatch', { transaction_id: tx.id }) });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { artifacts: [declared] } });
  publishFixtureResult(runtime, tx.id);
  runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role: 'allocator' })[0]!.id, { status: 'BLOCKED' });
  let failure: unknown;
  host.setScript(async turn => {
    try {
      const response = await turn.callTool('write', { path: target, content: 'changed' }, { callId: `scan-${kind}` });
      assert.equal(response.isError, kind === 'before-limit');
      if (kind === 'before-limit') assert.match(JSON.stringify(response), /ARTIFACT_SCAN_LIMIT/);
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  assert.equal(dispatched, kind === 'before-limit' ? 0 : 1);
  assert.equal(runtime.store.getTransaction(tx.id)!.status, kind === 'before-limit' ? 'SUBMITTED' : 'REJECTED');
  const mutation = runtime.store.get("SELECT data FROM events WHERE cluster_id=? AND type='manager-result-mutated' AND json_extract(data,'$.call_id')=?", clusterId, `scan-${kind}`);
  if (kind === 'before-limit') {
    assert.equal(mutation, undefined);
    assert.equal(runtime.store.getEffect(`scan-${kind}`), null);
  } else {
    assert.ok(mutation, 'changing a directory, relinking or becoming unverifiable invalidates the publication');
    const details = objectField(JSON.parse(String(mutation.data)), 'mutation');
    assert.deepEqual(details.paths, [join(dir, declared)]);
    if (kind === 'after-limit') assert.match(String(details.observation_error), /ARTIFACT_SCAN_LIMIT/);
    assert.equal(runtime.store.getEffect(`scan-${kind}`)?.status, 'SETTLED', 'post-effect scan failure never loses the effect receipt');
  }
});
