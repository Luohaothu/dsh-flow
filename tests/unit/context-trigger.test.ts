import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { createFakeHost } from './fake-host.ts';

// Context capacity and pressure decisions belong to the official backend. A
// scripted host proves Flow's seam neither calls a manual backend nor refuses
// steps based on its own token count or edits the native request envelope.
test('Flow passes native execution through without its former window and output controls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-native-context-'));
  let manualCompactions = 0;
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: 10_000_000 }) },
    compaction: {
      async compactNow() { manualCompactions += 1; return null; },
      async compactIfNeeded() { manualCompactions += 1; return null; },
    },
  });
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'ledger.sqlite'), dataDir: dir, autoTick: false,
    model: { provider: 'local-fake', model: 'fake-model', reasoningEffort: 'low' },
  });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const cluster = runtime.start({ objective: 'Host owns capacity', workspace: dir, capabilities: [] });
  const agent = runtime.store.listAgents(cluster.cluster.id, { role: 'orchestrator' })[0]!;
  const decisions: string[] = [];
  host.setScript(async turn => {
    for (let step = 1; step <= 4; step += 1) {
      decisions.push((await turn.preStep({ step, messages: [] })).kind);
      await turn.request();
    }
  });
  const outcome = await runTurn(host.ctx, {
    agent, role: agent.role, prompt: 'Use host behavior', allowedTools: [], globalTools: [],
    model: runtime.modelFor(agent), resume: false, turnSeq: 1, flow: runtime,
  });
  assert.deepEqual(decisions, ['enter', 'enter', 'enter', 'enter']);
  assert.equal(manualCompactions, 0);
  assert.equal(host.lastTurn!.requests.length, 4);
  assert.equal(runtime.store.readEvents(cluster.cluster.id, { limit: 100 }).some(event => event.type === 'context-step'), false);
  assert.equal('context' in outcome, false);
  assert.equal(runtime.store.usageSummary(cluster.cluster.id).requests, 4);
  assert.equal(runtime.store.nativeUsageCursor(agent.session_id), outcome.native_seq! - 1);
});
