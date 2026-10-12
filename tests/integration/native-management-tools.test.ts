/**
 * Additional real native tool coverage; only model generation is scripted.
 * Requires public HTTPS access. Fake-IP networks may explicitly provide an
 * HTTP proxy with FLOW_NATIVE_FETCH_PROXY; ambient proxies stay isolated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { DshHost, buildHostEnv, createRunLayout, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';
import { startMockModel } from '../../src/host/mock-model.ts';
import { buildScenario, call } from '../../src/host/mock-scenarios.ts';
import { openLedger } from '../../src/host/ledger.ts';
import { MOCK_API_KEY, MOCK_MODEL_ID, MOCK_PROVIDER, mockPatchText, ipcBridgePatchText, startAcceptanceHost } from '../acceptance/run.ts';
import { asArray, asObject, decodeStartReply } from '../acceptance/context.ts';
import { readNativeToolReceipts } from '../acceptance/native-tool-receipts.ts';
import { buildDrift, computeBuildHashes } from '../acceptance/build-fingerprint.ts';

const toolsExercised = ['bash', 'job_kill', 'job_output', 'web_fetch'];
const materialUrl = 'https://example.com';
const sourcePath = fileURLToPath(import.meta.url);
const sourceHash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

test('manager native jobs and public web material bind to its current validation', { timeout: 180_000 }, async t => {
  const runId = `integration-manager-native-${Date.now().toString(36)}`;
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts'), runId);
  const mock = await startMockModel({ modelId: MOCK_MODEL_ID });
  const profile = `dsh-flow-${runId}`;
  const overlay = join(layout.root, 'mock-model.patch.yml');
  const bridge = join(layout.root, 'ipc-bridge.patch.yml');
  writeFileSync(overlay, mockPatchText(mock.baseURL, [{ provider: MOCK_PROVIDER, model: MOCK_MODEL_ID }], mock.identityKey));
  writeFileSync(bridge, ipcBridgePatchText());
  const patches = [resolve(PROJECT_ROOT, 'examples/cluster.patch.yml'), overlay, bridge];
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES });
  const env = buildHostEnv({
    home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: mock.baseURL, model: MOCK_MODEL_ID, provider: MOCK_PROVIDER }, modelApiKey: MOCK_API_KEY,
  });
  const proxy = process.env.FLOW_NATIVE_FETCH_PROXY;
  if (proxy) {
    const parsed = new URL(proxy);
    assert.ok(['http:', 'https:'].includes(parsed.protocol), 'use an HTTP(S) proxy supported by the native host');
    assert.equal(parsed.username, '', 'this fixture does not copy proxy credentials');
    assert.equal(parsed.password, '', 'this fixture does not copy proxy credentials');
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
  }
  const host = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
  t.after(async () => { await host.stop(); await mock.close(); });
  const before = computeBuildHashes({ id: '' }, patches);
  const testSourceBefore = sourceHash();
  let stage = 'bind';
  let jobId = '';
  let jobOutput = '';
  let webText = '';
  let managerId = '';
  let webReceipt: Record<string, unknown> | null = null;
  let jobKillEffect: Record<string, unknown> | null = null;
  let jobKillCallId = '';
  let validated = false;
  mock.setScenario(buildScenario({
    caseId: 'native', layout, workspace: layout.workspace,
    hooks: { orchestrator(request, item) {
      if (item.action !== 'validate' || validated) return null;
      const c = request.classified;
      const detail = asObject(c.context?.transaction);
      if (stage === 'bind') {
        managerId = String(c.agentId);
        stage = 'bash';
        return call('flow_transaction', { action: 'bind_validation', params: {
          transaction_id: item.transaction_id, plan_ref: asObject(detail?.plan)?.ref, result_ref: asObject(detail?.result)?.ref,
        } });
      }
      if (stage === 'bash') {
        assert.equal(c.lastToolName, 'flow_transaction');
        assert.match(c.lastToolResult ?? '', /"ok":true/);
        stage = 'kill';
        return call('bash', { command: 'printf "MANAGER-LONG-JOB\\n"; sleep 120', description: 'Start a cancellable native verification job', run_in_background: true });
      }
      if (stage === 'kill') {
        assert.equal(c.lastToolName, 'bash');
        jobId = /started background job (\S+)/u.exec(c.lastToolResult ?? '')?.[1] ?? '';
        assert.ok(jobId, 'the manager receives its real registered background job');
        stage = 'output';
        return call('job_kill', { job_id: jobId, reason: 'The cancellation contract is the verification target.' });
      }
      if (stage === 'output') {
        assert.equal(c.lastToolName, 'job_kill');
        assert.match(c.lastToolResult ?? '', /requested cancellation of job/);
        stage = 'fetch';
        return call('job_output', { job_id: jobId, wait: true, timeout_ms: 10_000 });
      }
      if (stage === 'fetch') {
        assert.equal(c.lastToolName, 'job_output');
        jobOutput = c.lastToolResult ?? '';
        assert.match(jobOutput, /MANAGER-LONG-JOB/);
        assert.match(jobOutput, /\[status: killed(?:,|\])/);
        assert.doesNotMatch(jobOutput, /\[status: (?:running|stopping)/);
        stage = 'native-list';
        return call('web_fetch', { url: materialUrl });
      }
      if (stage === 'native-list') {
        assert.equal(c.lastToolName, 'web_fetch');
        webText = c.lastToolResult ?? '';
        assert.match(webText, /Example Domain/);
        assert.match(webText, /documentation examples/);
        stage = 'native-detail';
        return call('flow_query', { what: 'transaction', params: {
          id: item.transaction_id, fields: ['requirements', 'plan', 'result', 'evidence'], limit: 8,
        } });
      }
      if (stage === 'native-detail') {
        const receipts = readNativeToolReceipts(detail);
        webReceipt = receipts.find(receipt => receipt.tool === 'web_fetch' && asObject(receipt.ref)?.agent_id === managerId) ?? null;
        assert.ok(webReceipt, 'the manager can read its own current-turn web receipt');
        assert.equal(webReceipt.status, 'returned');
        assert.equal(webReceipt.association, 'current-manager');
        const read = asObject(webReceipt.read);
        assert.ok(read);
        stage = 'effects';
        return call('flow_query', { what: read.what, params: {
          ...asObject(read.params), fields: ['requirements', 'plan', 'result', 'evidence'],
        } });
      }
      if (stage === 'effects') {
        const receipts = readNativeToolReceipts(detail);
        assert.equal(receipts.length, 1);
        assert.deepEqual(receipts[0]?.ref, webReceipt?.ref);
        assert.match(JSON.stringify(receipts[0]?.result), /Example Domain/);
        stage = 'validate';
        return call('flow_query', { what: 'effects', params: { agent_id: managerId, limit: 8 } });
      }
      assert.equal(stage, 'validate');
      const effects = (asArray(asObject(JSON.parse(c.lastToolResult ?? 'null'))?.items) ?? []).map(asObject);
      jobKillEffect = effects.find(effect => effect?.tool === 'job_kill' && effect.agent_id === managerId) ?? null;
      assert.ok(jobKillEffect, 'cancellation has a real persisted effect');
      assert.equal(jobKillEffect.status, 'SETTLED');
      assert.equal(jobKillEffect.error, null);
      assert.equal(typeof jobKillEffect.call_id, 'string');
      jobKillCallId = String(jobKillEffect.call_id);
      const planRef = asObject(asObject(detail?.plan)?.ref);
      const resultRef = asObject(asObject(detail?.result)?.ref);
      assert.ok(planRef); assert.ok(resultRef);
      const criteria = asArray(asObject(detail?.requirements)?.acceptance_criteria);
      assert.ok(criteria);
      assert.equal(criteria.length, 1);
      validated = true;
      return call('flow_transaction', { action: 'validate', params: {
        transaction_id: item.transaction_id, expected_transaction_revision: asObject(detail?.transaction)?.revision,
        plan_ref: planRef, result_ref: resultRef, accepted: true,
        checks: criteria.map((criterion, criterion_index) => ({
          criterion, criterion_ref: { ...planRef, criterion_index }, passed: true,
          method: 'Recompute 2+3; cancel the manager background job and collect its terminal state; fetch and inspect the public Example Domain page through native web_fetch.',
          observation: `2+3=5. ${jobOutput}. The retrieved page contains Example Domain and documentation examples.`,
          evidence: JSON.stringify({ job_id: jobId, kill_call_id: jobKillCallId, web_receipt: webReceipt?.ref }),
          evidence_refs: [{ kind: 'result', ref: resultRef }, { kind: 'effect', call_id: jobKillCallId }],
        })),
      } });
    } },
  }));

  try {
    await startAcceptanceHost(host);
    const created = decodeStartReply(await host.request('start', undefined, {
      objective: 'Sum [2,3]. The manager must independently cancel a real background job and fetch https://example.com before validating.',
      workspace: layout.workspace, capabilities: [], managementCapabilities: ['shell', 'web_fetch'], managementWriteScope: ['.'],
      budget: { tool_calls: 200, wall_time_ms: 180_000, agents: 8, max_active_agents: 2 },
      limits: { max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
      initial_transactions: [{ objective: 'Sum [2,3] with flow_sum and submit the result.', acceptance_criteria: ['The total is 5, and the manager has independently terminated its background job and retrieved the Example Domain material.'] }],
    }));
    assert.ok(created);
    await host.request('settle', created.cluster.id, { timeout_ms: 120_000, poll_ms: 100 }, 150_000);
    assert.equal(validated, true);
    const first = mock.requests.find(request => request.classified.role === 'orchestrator');
    assert.ok(first);
    for (const tool of toolsExercised) assert.ok(first.tools.includes(tool), `${tool} was mounted before the model request`);
    const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
    try {
      const tx = ledger.get('SELECT id,status,current_plan_ref,current_result_ref FROM transactions WHERE cluster_id=?', created.cluster.id);
      assert.equal(tx?.status, 'ACCEPTED');
      const receipts = ledger.all('SELECT call_id,agent_id,session_id,turn_seq,tool,dispatch_status,error,result_body FROM tool_call_receipts WHERE cluster_id=? AND agent_id=?', created.cluster.id, managerId)
        .filter(row => toolsExercised.includes(String(row.tool)));
      assert.equal(receipts.length, toolsExercised.length);
      assert.equal(new Set(receipts.map(row => row.turn_seq)).size, 1);
      const bindings = ledger.all("SELECT data FROM events WHERE cluster_id=? AND type='manager-tool-bound'", created.cluster.id).map(row => asObject(JSON.parse(String(row.data))));
      for (const receipt of receipts) {
        assert.equal(receipt.dispatch_status, 'SETTLED'); assert.equal(receipt.error, null);
        const binding = bindings.find(value => value?.call_id === receipt.call_id);
        assert.equal(binding?.agent_id, managerId);
        assert.deepEqual(binding?.plan_ref, JSON.parse(String(tx?.current_plan_ref)));
        assert.deepEqual(binding?.result_ref, JSON.parse(String(tx?.current_result_ref)));
      }
      const validation = asObject(JSON.parse(String(ledger.get('SELECT data FROM validation_records WHERE transaction_id=?', String(tx?.id))?.data)));
      assert.equal(validation?.author_agent_id, managerId);
      assert.ok(JSON.stringify(validation).includes(jobKillCallId));
      const after = computeBuildHashes({ id: '' }, patches);
      assert.equal(buildDrift(before, after), null);
      assert.equal(sourceHash(), testSourceBefore);
      writeFileSync(join(layout.root, 'report.json'), JSON.stringify({
        status: 'PASSED', run_id: runId, cluster_id: created.cluster.id, source: { path: sourcePath, sha256: testSourceBefore },
        build_before: before, build_after: after, build_drift: null, tools: toolsExercised, network_route: proxy ? 'explicit-test-proxy' : 'direct',
        manager_id: managerId, job_id: jobId, job_output: jobOutput, web_url: materialUrl,
        web_content_matched: ['Example Domain', 'documentation examples'], web_receipt: webReceipt, job_kill_effect: jobKillEffect,
        native_receipts: receipts, validation,
      }, null, 2));
    } finally { ledger.close(); }
    console.log(`Native manager jobs/web evidence: ${join(layout.root, 'report.json')}`);
  } catch (error) {
    writeFileSync(join(layout.root, 'report.json'), JSON.stringify({ status: 'FAILED', run_id: runId, stage, error: String(error), build_before: before, build_after: computeBuildHashes({ id: '' }, patches) }, null, 2));
    throw error;
  }
});
