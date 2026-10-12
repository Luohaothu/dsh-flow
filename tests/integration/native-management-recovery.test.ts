/** Cold restoration of real manager tools; model generation alone is scripted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DshHost, buildHostEnv, createRunLayout, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';
import { startMockModel } from '../../src/host/mock-model.ts';
import { buildScenario, call, say } from '../../src/host/mock-scenarios.ts';
import { openLedger } from '../../src/host/ledger.ts';
import { findSessionFile, readSessionEvents } from '../../src/host/session-scan.ts';
import { MOCK_API_KEY, MOCK_MODEL_ID, MOCK_PROVIDER, mockPatchText, ipcBridgePatchText, startAcceptanceHost } from '../acceptance/run.ts';
import { asArray, asObject, decodeStartReply } from '../acceptance/context.ts';
import { readNativeToolReceipts } from '../acceptance/native-tool-receipts.ts';
import { buildDrift, computeBuildHashes } from '../acceptance/build-fingerprint.ts';

const capabilities = ['fs_read', 'fs_write', 'shell'];
const requiredTools = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_kill'];
const verificationFile = 'cold-manager-check.txt';
const sourcePath = fileURLToPath(import.meta.url);
const sourceHash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

test('cold native recovery restores manager authorization, tools and bound validation', { timeout: 180_000 }, async t => {
  const startedAt = Date.now();
  const runId = `integration-manager-recovery-${startedAt.toString(36)}`;
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
  const original = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host-before.log') });
  const resumed = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host-after.log') });
  t.after(async () => { await original.stop(); await resumed.stop(); await mock.close(); });
  const before = computeBuildHashes({ id: '' }, patches);
  const testSourceBefore = sourceHash();
  let restored = false;
  let stage = 'bind';
  let verified = false;
  let managerId = '';
  mock.setScenario(buildScenario({
    caseId: 'native', layout, workspace: layout.workspace,
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName === 'flow_transaction') return say('Published the text calculation.');
        return call('flow_transaction', { action: 'submit_result', params: {
          transaction_id: c.transactionId, result: { sum: 5, values: [2, 3], basis: '2 + 3 = 5; plain-text delivery without file or shell operations.' },
        } });
      },
      orchestrator(request, item) {
        if (item.action !== 'validate' || verified) return null;
        if (!restored) return { ...say('The fixture is stopping this host before manager verification.'), hold: 'before-manager-verification' };
        const c = request.classified;
        const detail = asObject(c.context?.transaction);
        assert.equal(c.agentId, managerId, 'the restored native turn uses the persisted manager identity');
        if (stage === 'bind') {
          stage = 'write';
          return call('flow_transaction', { action: 'bind_validation', params: {
            transaction_id: item.transaction_id, plan_ref: asObject(detail?.plan)?.ref, result_ref: asObject(detail?.result)?.ref,
          } });
        }
        if (stage === 'write') {
          assert.equal(c.lastToolName, 'flow_transaction');
          assert.match(c.lastToolResult ?? '', /"ok":true/);
          stage = 'read';
          return call('write', { file_path: verificationFile, content: 'COLD-MANAGER-CHECK 5\n' });
        }
        if (stage === 'read') {
          assert.equal(c.lastToolName, 'write');
          stage = 'bash';
          return call('read', { file_path: verificationFile });
        }
        if (stage === 'bash') {
          assert.equal(c.lastToolName, 'read');
          assert.match(c.lastToolResult ?? '', /COLD-MANAGER-CHECK 5/);
          stage = 'evidence';
          return call('bash', { command: "printf '%s\\n' $((2 + 3))", description: 'Independently calculate the submitted total after cold restoration' });
        }
        if (stage === 'evidence') {
          assert.equal(c.lastToolName, 'bash');
          assert.match(c.lastToolResult ?? '', /(?:^|\n)5(?:\r?\n|$)/);
          stage = 'validate';
          return call('flow_query', { what: 'transaction', params: {
            id: item.transaction_id, fields: ['requirements', 'plan', 'result', 'evidence'], limit: 8,
          } });
        }
        assert.equal(stage, 'validate');
        const receipts = readNativeToolReceipts(detail).filter(receipt => asObject(receipt.ref)?.agent_id === managerId);
        for (const tool of ['write', 'read', 'bash']) {
          const receipt = receipts.find(receipt => receipt.tool === tool);
          assert.ok(receipt, `${tool} has the restored manager's real native receipt`);
          assert.equal(receipt.status, 'returned'); assert.equal(receipt.association, 'current-manager');
        }
        const planRef = asObject(asObject(detail?.plan)?.ref);
        const resultRef = asObject(asObject(detail?.result)?.ref);
        const criteria = asArray(asObject(detail?.requirements)?.acceptance_criteria);
        assert.ok(planRef); assert.ok(resultRef); assert.ok(criteria);
        verified = true;
        return call('flow_transaction', { action: 'validate', params: {
          transaction_id: item.transaction_id, expected_transaction_revision: asObject(detail?.transaction)?.revision,
          plan_ref: planRef, result_ref: resultRef, accepted: true,
          checks: criteria.map((criterion, criterion_index) => ({
            criterion, criterion_ref: { ...planRef, criterion_index }, passed: true,
            method: 'After cold host restoration, write and read the manager verification file, then independently calculate 2+3 through native bash.',
            observation: 'The manager read COLD-MANAGER-CHECK 5 and bash returned 5; the published text result is 5.',
            evidence: JSON.stringify({ native_receipts: receipts, result_ref: resultRef }),
            evidence_refs: [{ kind: 'result', ref: resultRef }],
          })),
        } });
      },
    },
  }));
  const journal = (sessionId: string) => {
    const file = findSessionFile(join(layout.home, 'sessions'), sessionId);
    assert.ok(file);
    const read = readSessionEvents(file);
    assert.equal(read.state, 'READ');
    return read.events;
  };
  try {
    await startAcceptanceHost(original);
    const oldPing = asObject(await original.request('ping', undefined));
    const created = decodeStartReply(await original.request('start', undefined, {
      objective: 'Receive a text calculation from a Worker; the manager must validate using its own native tools after a cold host restart.',
      workspace: layout.workspace, capabilities: [], managementCapabilities: capabilities, managementWriteScope: ['.'],
      budget: { tool_calls: 240, wall_time_ms: 180_000, agents: 8, max_active_agents: 2 },
      limits: { max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 16 },
      initial_transactions: [{ objective: 'Provide the plain-text total of 2+3.', acceptance_criteria: ['The total is 5 and the manager independently verifies it with native write/read/bash after cold host restoration.'] }],
    }));
    assert.ok(created);
    await mock.waitForRequest(request => request.held && request.barrier === 'before-manager-verification', { timeoutMs: 60_000 });
    const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
    let authorization: unknown;
    let publication: unknown;
    let managerSession = '';
    try {
      const tx = ledger.get('SELECT status,current_result_ref FROM transactions WHERE cluster_id=?', created.cluster.id);
      assert.equal(tx?.status, 'SUBMITTED'); publication = JSON.parse(String(tx?.current_result_ref));
      const manager = ledger.get("SELECT id,session_id,capabilities FROM agents WHERE cluster_id=? AND role='orchestrator'", created.cluster.id);
      assert.ok(manager); managerId = String(manager.id); managerSession = String(manager.session_id);
      assert.deepEqual(JSON.parse(String(manager.capabilities)), capabilities);
      const scope = asObject(JSON.parse(String(ledger.get("SELECT scope FROM nodes WHERE cluster_id=? AND kind='management' AND parent_id IS NULL", created.cluster.id)?.scope)));
      authorization = scope?.execution_authorization;
      assert.deepEqual(asObject(authorization)?.capabilities, capabilities);
      assert.deepEqual(asObject(authorization)?.write_scope, ['.']);
      assert.equal(ledger.all("SELECT call_id FROM tool_call_receipts WHERE agent_id=? AND tool NOT LIKE 'flow_%'", managerId).length, 0, 'native business verification has not run before the restart');
    } finally { ledger.close(); }
    await original.request('control', created.cluster.id, { action: 'pause' });
    const oldExit = await original.stop();
    mock.release('before-manager-verification');
    const oldNativeSeq = Math.max(...journal(managerSession).map(event => event.seq));
    const paused = openLedger(join(layout.data, 'cluster.sqlite'));
    const initialInputs = paused.all("SELECT id,agent_id,session_id,native_message_id FROM member_inputs WHERE cluster_id=? AND kind='initial' ORDER BY id", created.cluster.id);
    try {
      assert.equal(paused.get('SELECT status FROM clusters WHERE id=?', created.cluster.id)?.status, 'PAUSED');
      assert.equal(initialInputs.length, 3);
      for (const input of initialInputs) assert.equal(journal(String(input.session_id)).filter(event => event.type === 'user/message' && asObject(event.data)?.id === input.native_message_id).length, 1);
    } finally { paused.close(); }
    const lastRequestBeforeRestart = mock.requests.at(-1)?.seq ?? 0;
    await startAcceptanceHost(resumed);
    const newPing = asObject(await resumed.request('ping', undefined));
    assert.notEqual(newPing?.pid, oldPing?.pid, 'a fresh host process owns the recovered runtime');
    assert.equal(newPing?.data_dir, oldPing?.data_dir);
    // Host startup runs the real recovery and reconciliation lifecycle before IPC is ready.
    const recoveryLedger = openLedger(join(layout.data, 'cluster.sqlite'));
    let recovery: unknown;
    try {
      const facts = recoveryLedger.all("SELECT seq,data FROM events WHERE cluster_id=? AND type='recovered'", created.cluster.id);
      assert.ok(facts.length > 0, 'the fresh host recovered this persisted run');
      recovery = { source: 'host-startup', facts };
    } finally { recoveryLedger.close(); }
    restored = true;
    await resumed.request('control', created.cluster.id, { action: 'resume' });
    await resumed.request('settle', created.cluster.id, { timeout_ms: 90_000, poll_ms: 100 }, 120_000);
    assert.equal(verified, true);
    assert.equal(readFileSync(join(layout.workspace, verificationFile), 'utf8'), 'COLD-MANAGER-CHECK 5\n');
    const requests = mock.requests.filter(request => request.seq > lastRequestBeforeRestart && request.classified.role === 'orchestrator');
    assert.ok(requests.length > 0);
    for (const request of requests) for (const name of requiredTools) assert.ok(request.tools.includes(name), `${name} is effectively mounted on the restored manager`);
    const final = openLedger(join(layout.data, 'cluster.sqlite'));
    try {
      const manager = final.get('SELECT id,session_id,capabilities FROM agents WHERE id=?', managerId);
      assert.equal(manager?.session_id, managerSession); assert.deepEqual(JSON.parse(String(manager?.capabilities)), capabilities);
      const scope = asObject(JSON.parse(String(final.get("SELECT scope FROM nodes WHERE cluster_id=? AND kind='management' AND parent_id IS NULL", created.cluster.id)?.scope)));
      assert.deepEqual(scope?.execution_authorization, authorization);
      const tx = final.get('SELECT id,status,current_plan_ref,current_result_ref FROM transactions WHERE cluster_id=?', created.cluster.id);
      assert.equal(tx?.status, 'ACCEPTED'); assert.deepEqual(JSON.parse(String(tx?.current_result_ref)), publication);
      assert.equal(final.all('SELECT id FROM allocations WHERE agent_id=?', managerId).length, 0, 'manager business tools do not fake a Worker allocation');
      const workers = final.all("SELECT capabilities FROM agents WHERE cluster_id=? AND role='worker'", created.cluster.id);
      assert.equal(workers.length, 1); assert.deepEqual(JSON.parse(String(workers[0]?.capabilities)), []);
      const receipts = final.all("SELECT call_id,tool,dispatch_status,error,turn_seq,result_body FROM tool_call_receipts WHERE agent_id=? AND tool NOT LIKE 'flow_%'", managerId);
      assert.deepEqual(receipts.map(row => row.tool).sort(), ['bash', 'read', 'write']);
      assert.equal(new Set(receipts.map(row => row.turn_seq)).size, 1);
      const bindings = final.all("SELECT data FROM events WHERE cluster_id=? AND type='manager-tool-bound'", created.cluster.id).map(row => asObject(JSON.parse(String(row.data))));
      for (const receipt of receipts) {
        assert.equal(receipt.dispatch_status, 'SETTLED'); assert.equal(receipt.error, null);
        const binding = bindings.find(value => value?.call_id === receipt.call_id);
        assert.equal(binding?.agent_id, managerId);
        assert.deepEqual(binding?.plan_ref, JSON.parse(String(tx?.current_plan_ref)));
        assert.deepEqual(binding?.result_ref, publication);
      }
      const finalInputs = final.all("SELECT id,agent_id,session_id,native_message_id FROM member_inputs WHERE cluster_id=? AND kind='initial' ORDER BY id", created.cluster.id);
      assert.deepEqual(finalInputs, initialInputs);
      const initialCounts = finalInputs.map(input => ({ id: input.id, native_message_id: input.native_message_id,
        occurrences: journal(String(input.session_id)).filter(event => event.type === 'user/message' && asObject(event.data)?.id === input.native_message_id).length }));
      assert.ok(initialCounts.every(input => input.occurrences === 1), 'cold restoration never repeats initial input');
      const events = journal(managerSession);
      assert.equal(asObject(events.filter(event => event.type === 'approval/policy').at(-1)?.data)?.policy, 'never');
      assert.equal(asObject(events.filter(event => event.type === 'sandbox/mode').at(-1)?.data)?.mode, 'workspace-write');
      const nativeCalls = events.filter(event => event.type === 'tool/call' && ['write', 'read', 'bash'].includes(String(asObject(event.data)?.name)));
      assert.equal(nativeCalls.length, 3); assert.ok(nativeCalls.every(event => event.seq > oldNativeSeq));
      const after = computeBuildHashes({ id: '' }, patches);
      assert.equal(buildDrift(before, after), null); assert.equal(sourceHash(), testSourceBefore);
      writeFileSync(join(layout.root, 'report.json'), JSON.stringify({
        status: 'PASSED', run_id: runId, cluster_id: created.cluster.id, manager_id: managerId, manager_session_id: managerSession,
        started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt,
        source: { path: sourcePath, sha256: testSourceBefore }, build_before: before, build_after: after, build_drift: null,
        old_host: oldPing, new_host: newPing, old_exit: oldExit, recovery, persisted_authorization: authorization,
        publication_ref: publication, old_native_seq: oldNativeSeq, native_calls: nativeCalls, native_receipts: receipts,
        manager_tool_bindings: bindings,
        manager_input_bindings: final.all('SELECT id,status,binding,native_message_id FROM member_inputs WHERE agent_id=? ORDER BY created,id', managerId),
        resumed_request_tools: requests.map(request => ({ seq: request.seq, tools: request.tools })),
        policy: 'never', sandbox: 'workspace-write', manager_worker_allocations: 0, initial_inputs: initialCounts,
      }, null, 2));
    } finally { final.close(); }
    console.log(`Native manager cold recovery evidence: ${join(layout.root, 'report.json')}`);
  } catch (error) {
    writeFileSync(join(layout.root, 'report.json'), JSON.stringify({ status: 'FAILED', run_id: runId, started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt, stage, restored, error: String(error), mock_errors: [...mock.errors], source: { path: sourcePath, sha256: testSourceBefore }, build_before: before, build_after: computeBuildHashes({ id: '' }, patches) }, null, 2));
    throw error;
  }
});
