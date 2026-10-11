/**
 * Native host contracts under the deterministic model endpoint.
 *
 * These drive a *real* DSH host — real agent loop, real tool execution, real
 * Session and real SQLite — with only the model's generation replaced. They are
 * deliberately not part of `pnpm test`: they boot a host process, and their
 * subject is the plugin's boundary behaviour rather than its pure logic.
 *
 * N0 is the positive round trip the release gate names. F-permission,
 * F-arguments, F-transport and F-budget are the four negative contracts: each
 * one declares an exact expected refusal and the side effects that must *not*
 * exist afterwards. An unexpected success is a failure, and an unexplained
 * failure is not accepted as a pass.
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DshHost, buildHostEnv, createRunLayout, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../../src/host/host.ts';
import type { RunLayout } from '../../../src/host/types.ts';
import { startMockModel } from '../../../src/host/mock-model.ts';
import type { MockModelHandle } from '../../../src/host/mock-model.ts';
import { buildScenario, call, say, sumFromToolResult } from '../../../src/host/mock-scenarios.ts';
import type { MockScenarioHooks } from '../../../src/host/mock-scenarios.ts';
import { inspectNativeSumRoundTrip } from '../qwen-smoke.ts';
import { findSessionFile, readSessionEvents } from '../../../src/host/session-scan.ts';
import type { SessionEvent } from '../../../src/host/session-scan.ts';
import { openLedger, usageSummary } from '../../../src/host/ledger.ts';
import type { SqlRow } from '../../../src/host/ledger.ts';
import { MOCK_API_KEY, MOCK_MODEL_ID, MOCK_PROVIDER, mockPatchText, ipcBridgePatchText, startAcceptanceHost } from '../run.ts';
import { asArray, asObject, asString, decodeSingleReply, decodeStartReply, requiredString } from '../context.ts';

const ARTIFACTS_ROOT = join(PROJECT_ROOT, '.artifacts');
let sequence = 0;

interface HarnessOptions {
  name: string;
  hooks?: MockScenarioHooks;
  caseId?: string;
  holdSummary?: boolean;
}

interface HarnessResult {
  host: DshHost;
  mock: MockModelHandle;
  layout: RunLayout;
  runId: string;
}

interface LedgerView {
  effects(): SqlRow[];
  events(): SqlRow[];
  transactions(): SqlRow[];
  allocations(): SqlRow[];
  usage(): SqlRow[];
  sessionEvents(): SqlRow[];
  budgets(): SqlRow[];
  toolCalls(): SqlRow[];
  close(): void;
}

interface ClusterSession {
  id: unknown;
  role: unknown;
  session_id: unknown;
  file: string | null;
  state: string;
  events: SessionEvent[];
}

/** One isolated native run: its own profile, home, data dir, workspace and mock. */
async function harness(t: TestContext, { name, hooks, caseId = 'native', holdSummary = false }: HarnessOptions): Promise<HarnessResult> {
  sequence += 1;
  const runId = `native-${name}-${Date.now().toString(36)}-${sequence}`;
  const layout = createRunLayout(ARTIFACTS_ROOT, runId);
  const mock = await startMockModel({ modelId: MOCK_MODEL_ID });
  const profile = `dsh-flow-${runId}`;
  const overlay = join(layout.root, 'mock-model.patch.yml');
  const routes = [{ provider: MOCK_PROVIDER, model: MOCK_MODEL_ID }];
  const observer = resolve(PROJECT_ROOT, 'tests/acceptance/native/host-observer.ts');
  writeFileSync(overlay, `${mockPatchText(mock.baseURL, routes, mock.identityKey)}
- insert:
    - id: native-observer
      name: ${JSON.stringify(observer)}
      config:
        evidencePath: ${JSON.stringify(join(layout.logs, 'llm-envelopes.jsonl'))}
        workspace: ${JSON.stringify(layout.workspace)}
        provider: ${MOCK_PROVIDER}
        model: ${MOCK_MODEL_ID}
`);
  const bridgeOverlay = join(layout.root, 'ipc-bridge.patch.yml');
  writeFileSync(bridgeOverlay, ipcBridgePatchText());
  const patches = [resolve(PROJECT_ROOT, 'examples/cluster.patch.yml'), overlay, bridgeOverlay];
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES });
  const env = buildHostEnv({
    home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: mock.baseURL, model: MOCK_MODEL_ID, provider: MOCK_PROVIDER },
    modelApiKey: MOCK_API_KEY,
  });
  const host = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
  const scenario = buildScenario({ caseId, layout, workspace: layout.workspace, ...(hooks === undefined ? {} : { hooks }) });
  mock.setScenario({
    ...scenario,
    async respond(request) {
      if (request.classified.userText.includes('NATIVE-ORDINARY:')) return say('OK');
      if (request.classified.userText.includes('NATIVE-RESUMED-COMPACTION:')) return say('RESUMED-COMPACTION-OK');
      const reply = await scenario.respond(request);
      return holdSummary && request.kind === 'compaction' && reply
        ? { ...reply, hold: 'native-summary-cancel' }
        : reply;
    },
  });
  t.after(async () => {
    await host.stop();
    await mock.close();
  });
  await startAcceptanceHost(host);
  // Wait for the independent Web bundle as well as the ready flow service.
  await host.waitForWebUrl(120_000);
  return { host, mock, layout, runId };
}

/** The effect rows and events of one cluster, read from the run's own database. */
function ledgerOf(layout: RunLayout, clusterId: string): LedgerView {
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  return {
    effects: () => ledger.all('SELECT tool,status,args,body,error FROM effects WHERE cluster_id=? ORDER BY rowid', clusterId),
    events: () => ledger.all('SELECT type,data FROM events WHERE cluster_id=? ORDER BY seq', clusterId),
    transactions: () => ledger.all('SELECT id,status,result FROM transactions WHERE cluster_id=?', clusterId),
    allocations: () => ledger.all('SELECT id,status,transaction_id FROM allocations WHERE cluster_id=?', clusterId),
    usage: () => ledger.all("SELECT native_session_id,native_seq,agent_id,role,type,data,json_extract(data,'$.usage.totalTokens') AS total_tokens FROM native_session_events WHERE cluster_id=? AND type IN ('assistant/message','assistant/attempt','compaction/summary') ORDER BY native_session_id,native_seq", clusterId),
    sessionEvents: () => ledger.all('SELECT native_session_id,native_seq,type,data FROM native_session_events WHERE cluster_id=? ORDER BY native_session_id,native_seq', clusterId),
    budgets: () => ledger.all('SELECT * FROM budgets WHERE cluster_id=?', clusterId),
    toolCalls: () => ledger.all('SELECT tool,dispatch_status,error,result_body FROM tool_call_receipts WHERE cluster_id=? ORDER BY rowid', clusterId),
    close: () => ledger.close(),
  };
}

/** The native session events of every identity in one cluster. */
function sessionsOf(layout: RunLayout, clusterId: string): ClusterSession[] {
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  const agents = ledger.all('SELECT id,role,session_id FROM agents WHERE cluster_id=?', clusterId);
  ledger.close();
  const root = join(layout.home, 'sessions');
  return agents.map(agent => {
    const sessionId = asString(agent.session_id);
    const file = sessionId === null ? null : findSessionFile(root, sessionId);
    const read: { state: string; events: SessionEvent[] } = file ? readSessionEvents(file) : { state: 'MISSING', events: [] };
    return { id: agent.id, role: agent.role, session_id: agent.session_id, file, state: read.state, events: read.events };
  });
}

/** Every tool result text a session recorded, in order. */
function toolResults(session: { events: readonly SessionEvent[] }): string[] {
  return session.events.filter(event => event.type === 'tool/result')
    .map(event => {
      const message = asObject(asObject(event.data)?.message);
      return (asArray(message?.content) ?? []).map(part => String(asObject(part)?.text ?? '')).join('');
    });
}


const singleBudget = { tool_calls: 200, wall_time_ms: 600_000, agents: 8, max_active_agents: 2 };

test('N0: a native single Worker sums through a real tool call and answers from its result', async t => {
  const { host, mock, layout } = await harness(t, {
    name: 'n0',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName === 'flow_sum') {
          const total = sumFromToolResult(c.lastToolResult);
          assert.notEqual(total, null, `the flow_sum tool result must carry a number, got ${JSON.stringify(c.lastToolResult)}`);
          // Text *and* the submission in one assistant turn: the answer is what
          // the native session must show after the tool result.
          return {
            ...call('flow_transaction', {
              action: 'submit_result',
              params: { transaction_id: c.transactionId, result: { sum: total }, notes: 'summed [2,3] with the flow_sum tool' },
            }),
            text: String(total),
          };
        }
        return call('flow_sum', { values: [2, 3] });
      },
    },
  });
  const single = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Use the flow_sum tool on [2,3] and submit the resulting number as the transaction result.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['The submitted result contains the number 5'],
  }, 300_000));
  if (!single) throw new Error('single reply is not a single-agent result');

  assert.equal(single.cluster_id ? true : false, true, 'the single control reports its cluster');
  const ledger = ledgerOf(layout, single.cluster_id);
  try {
    const transactions = ledger.transactions();
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.status, 'SUBMITTED', 'the staged submission is published when the turn ends');
    const resultText = asString(transactions[0]?.result);
    assert.ok(resultText, 'the staged transaction carries a JSON result');
    const transactionResult: unknown = JSON.parse(resultText);
    assert.deepEqual(transactionResult, { sum: 5 });
    // The single control publishes its staged submission through its own path,
    // so the durable proof is the transaction's own status and result plus the
    // native session below — not the presence of one particular event name.
    assert.equal(txCount(ledger.events(), 'single-control-finished'), 1);
  } finally {
    ledger.close();
  }

  const db = openLedger(join(layout.data, 'cluster.sqlite'));
  const sessionRow = asObject(db.get('SELECT session_id FROM agents WHERE cluster_id=?', single.cluster_id));
  db.close();
  const sessionId = asString(sessionRow?.session_id);
  const file = sessionId === null ? null : findSessionFile(join(layout.home, 'sessions'), sessionId);
  assert.ok(file, 'the Worker session must exist on disk');
  const read = readSessionEvents(file);
  assert.equal(read.state, 'READ', `the session must be readable: ${read.reason ?? ''}`);
  assert.equal(asObject(read.events.filter(event => event.type === 'approval/policy').at(-1)?.data)?.policy, 'never', 'the Worker uses session-local unattended approval');
  assert.equal(asObject(read.events.filter(event => event.type === 'sandbox/mode').at(-1)?.data)?.mode, 'workspace-write', 'unattended execution retains the workspace sandbox');
  const initial = read.events.find(event => event.type === 'user/message');
  assert.equal(asObject(asObject(initial?.data)?.source)?.kind, 'user', 'the initial Worker task is a native user prompt');
  const verdict = inspectNativeSumRoundTrip(read.events);
  assert.deepEqual(verdict.verified, true, `native round trip: ${JSON.stringify(verdict)}`);
  assert.equal(String(single.finalText ?? '').trim(), '5', 'the assistant answered with the number the tool returned');
  assert.equal(mock.errors.length, 0, `fixture errors: ${mock.errors.join('; ')}`);
});

test('N-communication: classified messages retain full bodies, independent sources and one delivery per recipient', async t => {
  let sent = false;
  const body = `Evidence: ${'interface verified; '.repeat(170)}END-OF-EVIDENCE`;
  const { host, mock, layout } = await harness(t, {
    name: 'communication',
    hooks: {
      orchestrator(request) {
        if (sent) return null;
        sent = true;
        return call('flow_communicate', { action: 'multicast', params: {
          node: request.classified.nodeId, message_id: 'native-classified-message', category: 'review_feedback',
          content: { subject: '接口审查意见', text: body },
        } });
      },
    },
  });
  const created = decodeStartReply(await host.request('start', undefined, {
    objective: 'Sum [2,3] and retain incoming review evidence.', workspace: layout.workspace, capabilities: ['fs_read'],
    limits: { max_children: 2, max_depth: 2, max_agents: 8, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: singleBudget,
    initial_transactions: [{ id: 'communication-sum', objective: 'Sum [2,3] with flow_sum and submit the tool result.', acceptance_criteria: ['The real tool result equals 5'] }],
  }));
  assert.ok(created);
  await host.request('settle', created.cluster.id, { timeout_ms: 300_000, poll_ms: 300 }, 420_000);
  let received = 0;
  for (const session of sessionsOf(layout, created.cluster.id)) {
    const inputs = session.events.filter(event => event.type === 'user/message');
    assert.equal(asObject(asObject(inputs[0]?.data)?.source)?.kind, 'user', `${session.role}: task precedes incoming messages`);
    assert.equal(inputs.filter(event => asObject(asObject(event.data)?.source)?.kind === 'user').length, 1, `${session.role}: scheduling never fabricates another human prompt`);
    const review = inputs.filter(event => asObject(asObject(event.data)?.source)?.message_id === 'native-classified-message');
    if (!review.length) continue;
    received += 1;
    assert.equal(review.length, 1, 'retrying scheduler passes do not repeat a delivered message');
    const data = asObject(review[0]?.data)!;
    const source = asObject(data.source)!;
    assert.equal(source.kind, 'flow-message');
    assert.equal(source.presentation, 'communication');
    assert.equal(source.category, 'review_feedback');
    assert.equal(source.display_summary, '接口审查意见');
    assert.equal(source.tone, 'neutral', 'a review message is not an approval verdict');
    assert.equal(source.recipient_id, session.id);
    assert.ok(asString(source.sender_id), 'the Agent sender is attributed');
    const text = (asArray(data.content) ?? []).map(block => asString(asObject(block)?.text) ?? '').join('');
    assert.equal(text.slice(Number(source.body_offset)), body, 'long body remains intact');
    assert.equal(text.includes('[[flow-delivery '), false, 'transport proof stays out of model-visible message text');
    assert.equal(source.message_id, 'native-classified-message', 'the native source carries the durable message identity');
    const position = session.events.indexOf(review[0]!);
    const preceding = session.events.slice(0, position).findLast(event => event.type === 'user/message');
    assert.ok(['user', 'flow'].includes(String(asObject(asObject(preceding?.data)?.source)?.kind)), 'a task or scheduling prompt shares the same admitted step');
  }
  assert.equal(received, 3, 'all three native management roles receive their own copy');
  const db = openLedger(join(layout.data, 'cluster.sqlite'));
  try {
    const deliveries = db.all('SELECT status FROM recipients WHERE message_id=?', 'native-classified-message');
    assert.equal(deliveries.length, 3);
    assert.ok(deliveries.every(row => row.status === 'ACKED'), 'delivery is acknowledged after native persistence');
  } finally { db.close(); }
  assert.equal(mock.errors.length, 0, `fixture errors: ${mock.errors.join('; ')}`);
});

test('F-permission: a Worker cannot reach management tools or write outside its scope', async t => {
  const { host, mock, layout } = await harness(t, {
    name: 'f-permission',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName && c.lastToolName !== 'flow_query') {
          return call('flow_transaction', {
            action: 'submit_result',
            params: { transaction_id: c.transactionId, result: { attempted: true }, notes: 'reported the refusals' },
          });
        }
        // Both calls are outside this identity's authority: `flow_allocation`
        // is not a Worker tool at all, and the path is outside the workspace.
        return {
          text: 'attempting two calls outside my authority',
          toolCalls: [
            { name: 'flow_allocation', arguments: JSON.stringify({ action: 'allocate_agent', params: { transactions: [] } }) },
            { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/dsh-flow-forbidden.txt', content: 'should never land' }) },
          ],
        };
      },
    },
  });
  const single = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Attempt one management call and one out-of-scope write, then report what happened.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget,
    acceptance_criteria: ['The result states that both attempts were refused'],
  }, 300_000));
  if (!single) throw new Error('single reply is not a single-agent result');

  const ledger = ledgerOf(layout, single.cluster_id);
  try {
    // The strongest evidence is the native tool result the Worker received:
    // both calls were refused, and each refusal names why.
    const sessions = sessionsOf(layout, single.cluster_id);
    const results = sessions.flatMap(toolResults);
    assert.ok(results.length >= 2, `the Worker received tool results: ${JSON.stringify(results)}`);
    assert.ok(results.some(text => /never available to a cluster|outside this cluster|may not perform|403/i.test(text)),
      `the management call was refused by the plugin: ${JSON.stringify(results)}`);
    assert.ok(results.some(text => /outside|refus|not permitted|scope|denied/i.test(text)),
      `the out-of-scope write was refused: ${JSON.stringify(results)}`);

    // And no side effect survived either attempt.
    assert.equal(existsSync('/tmp/dsh-flow-forbidden.txt'), false, 'no forbidden file exists');
    assert.equal(ledger.allocations().length, 1, 'only the single control\'s own allocation exists');
    const settled = ledger.toolCalls().filter(row => row.dispatch_status === 'SETTLED').map(row => row.tool);
    assert.ok(!settled.includes('flow_allocation'), `the management tool never settled: ${JSON.stringify(settled)}`);
    const anomalies = ledger.events().filter(event => /refus|anomaly|blocked/.test(asString(event.type) ?? ''));
    assert.ok(anomalies.length >= 1, `a durable refusal is recorded: ${JSON.stringify(ledger.events().map(e => e.type))}`);
  } finally {
    ledger.close();
  }
  void mock;
});

test('F-arguments: sharded arguments assemble, both params spellings persist, illegal params refuse cleanly', async t => {
  const submitted = new Map<string | null, unknown>();
  const { host, mock, layout } = await harness(t, {
    name: 'f-arguments',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName && c.lastToolName !== 'flow_query') {
          const total = sumFromToolResult(c.lastToolResult);
          // `params` as a JSON *string* is a spelling the plugin documents; the
          // scenario covers it on the second transaction.
          const asString = /string-spelling/u.test(c.objective ?? '');
          const params = { transaction_id: c.transactionId, result: { sum: total } };
          submitted.set(c.transactionId, params);
          return call('flow_transaction', {
            action: 'submit_result',
            params: asString ? JSON.stringify(params) : params,
          }, { chunkBoundaries: [1, 3, 5, 11] });
        }
        return call('flow_sum', { values: [2, 3] }, { chunkBoundaries: [2, 7, 13] });
      },
    },
  });
  const spec = {
    objective: 'Sum [2,3] twice: once with params as an object, once with params as a JSON string.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    limits: { max_children: 4, max_depth: 2, max_agents: 8, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: singleBudget,
    initial_transactions: [
      { id: 'args-object', objective: 'Use flow_sum on [2,3]; params-object form.', acceptance_criteria: ['result is 5'] },
      { id: 'args-string-spelling', objective: 'Use flow_sum on [2,3]; params string-spelling form.', acceptance_criteria: ['result is 5'] },
    ],
  };
  const created = decodeStartReply(await host.request('start', undefined, spec, 120_000));
  if (!created) throw new Error('start reply carried no cluster');
  await host.request('settle', created.cluster.id, { timeout_ms: 300_000, poll_ms: 300 }, 420_000);

  const ledger = ledgerOf(layout, created.cluster.id);
  try {
    const transactions = ledger.transactions();
    for (const row of transactions) {
      assert.equal(row.status, 'ACCEPTED', `${row.id} must be accepted, not ${row.status}`);
      const parsed = asObject(JSON.parse(String(row.result)));
      assert.equal(parsed?.sum, 5, `${row.id} carries the value the tool returned`);
    }
    assert.equal(transactions.length, 2);
  } finally {
    ledger.close();
  }

  // An illegal parameter is refused with a status, and leaves no partial effect.
  const bad = await harness(t, {
    name: 'f-arguments-bad',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName && c.lastToolName !== 'flow_query') return say('done');
        return call('flow_transaction', {
          action: 'submit_result',
          params: { transaction_id: 'not-a-transaction', result: { sum: 5 } },
        });
      },
    },
  });
  const badSingle = decodeSingleReply(await bad.host.request('single', undefined, {
    objective: 'Submit a result for a transaction that does not belong to this identity.',
    workspace: bad.layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['nothing is submitted'],
  }, 300_000));
  if (!badSingle) throw new Error('single reply is not a single-agent result');
  const badLedger = ledgerOf(bad.layout, badSingle.cluster_id);
  try {
    const results = sessionsOf(bad.layout, badSingle.cluster_id).flatMap(toolResults);
    assert.ok(results.some(text => /not found|not allocated|outside|403|404|Cluster Agent/i.test(text)),
      `the illegal submission was refused with a named reason: ${JSON.stringify(results)}`);
    // The turn itself still ends and publishes its own prose output; what must
    // not happen is the *illegal submission* landing as the result.
    for (const row of badLedger.transactions()) {
      const parsed = row.result ? asObject(JSON.parse(String(row.result))) : null;
      assert.equal(parsed?.sum, undefined, `the illegal submission did not become a result: ${JSON.stringify(row.result)}`);
    }
    // The refusal itself is the evidence: the call reached the plugin and came
    // back as an error rather than as a recorded submission.
  } finally {
    badLedger.close();
  }
  assert.equal(mock.errors.length, 0);

  // A malformed argument *stream* is a different negative from the authorization
  // one above: the shards never assemble into the documented object, so nothing
  // can execute. Two properties have to hold together — the refusal is
  // attributed to the call that produced it, and nothing ran from it.
  //
  // The stream is deliberately unparseable rather than merely truncated: the
  // host's own decoder repairs truncated JSON (`{ "values": [2,` arrives as
  // `{"values":[2]}` and really runs), so a truncated stream is not a negative
  // at all. Recorded here so the next reader does not "tighten" this case into a
  // form the host silently accepts.
  const malformedRaw = 'totally not json';
  const malformed = await harness(t, {
    name: 'f-arguments-malformed',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName && c.lastToolName !== 'flow_query') return say('done');
        return { toolCalls: [{ name: 'flow_sum', arguments: malformedRaw }], chunkBoundaries: [1, 4, 9] };
      },
    },
  });
  const malformedSingle = decodeSingleReply(await malformed.host.request('single', undefined, {
    objective: 'Call the sum tool with an argument stream that never assembles.',
    workspace: malformed.layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['nothing is submitted'],
  }, 300_000));
  if (!malformedSingle) throw new Error('single reply is not a single-agent result');
  const malformedLedger = ledgerOf(malformed.layout, malformedSingle.cluster_id);
  try {
    const sessions = sessionsOf(malformed.layout, malformedSingle.cluster_id);
    const calls = sessions.flatMap(session => session.events.filter(event => event.type === 'tool/call' && asObject(event.data)?.name === 'flow_sum'));
    const results = sessions.flatMap(session => session.events.filter(event => event.type === 'tool/result'));
    assert.equal(calls.length, 1, `exactly the malformed call was issued: ${JSON.stringify(calls)}`);
    const attempt = calls[0];
    const attemptData = asObject(attempt?.data);
    assert.equal(attemptData?.name, 'flow_sum');
    // What the call was recorded with is not the stream that was sent: the host
    // could not decode it and normalised the arguments to an empty object.
    assert.equal(String(attemptData?.arguments), '{}',
      `the undecodable stream is not the recorded argument text: ${JSON.stringify(attemptData?.arguments)}`);
    const refusal = results.find(event => asObject(asObject(event.data)?.message)?.toolCallId === attemptData?.callId);
    assert.ok(refusal, `the malformed call has a result of its own: ${JSON.stringify(results)}`);
    const refusalData = asObject(refusal.data);
    assert.equal(asObject(refusalData?.message)?.isError, true);
    assert.equal(asObject(refusalData?.error)?.code, 'INVALID_ARGS', JSON.stringify(refusalData?.error));
    assert.ok(toolResults({ events: [refusal] }).some(text => /invalid arguments/i.test(text)),
      'the refusal names invalid arguments rather than a domain reason');

    assert.deepEqual(malformedLedger.effects(), [], 'no effect came from the malformed call');
    for (const row of malformedLedger.transactions()) {
      const resultText = asString(row.result);
      const parsed = resultText === null ? null : asObject(JSON.parse(resultText));
      assert.equal(parsed?.sum, undefined, `the malformed call became no result: ${JSON.stringify(row.result)}`);
    }
    // The plugin still saw the call: it is the host that refused to decode it,
    // and the plugin records the attempt rather than a phantom success.
    assert.equal(malformedLedger.toolCalls().filter(row => row.tool === 'flow_sum').length, 1);
  } finally {
    malformedLedger.close();
  }
  assert.equal(malformed.mock.errors.length, 0, `fixture errors: ${malformed.mock.errors.join('; ')}`);
});

test('F-transport: a 500 and an aborted stream produce no success and no duplicate effect', async t => {
  const outcomes: unknown[] = [];
  const { host, layout } = await harness(t, {
    name: 'f-transport',
    hooks: {
      worker(request) {
        const c = request.classified;
        const mode = c.objective ?? '';
        if (/aborted stream/u.test(mode)) return c.lastToolName && c.lastToolName !== 'flow_query' ? say('done') : { abort: true };
        if (/server error/u.test(mode)) return c.lastToolName && c.lastToolName !== 'flow_query' ? say('done') : { fail: { status: 500, message: 'declared server failure' } };
        return say(`no stimulus matched: ${mode}`);
      },
    },
  });
  const cases: Array<[string, string]> = [
    ['transport-500', 'Provoke a declared server error from the model endpoint and report it.'],
    ['transport-abort', 'Provoke an aborted stream from the model endpoint and report it.'],
  ];
  for (const [id, objective] of cases) {
    const spec = {
      objective,
      workspace: layout.workspace,
      capabilities: ['fs_read'],
      limits: { max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4, max_attempts: 1 },
      budget: singleBudget,
      initial_transactions: [{ id, objective, acceptance_criteria: ['reported honestly'] }],
    };
    const created = decodeStartReply(await host.request('start', undefined, spec, 120_000));
    if (!created) throw new Error('start reply carried no cluster');
    await host.request('settle', created.cluster.id, { timeout_ms: 180_000, poll_ms: 300 }, 300_000);
    const ledger = ledgerOf(layout, created.cluster.id);
    try {
      const transactions = ledger.transactions();
      const events = ledger.events();
      const usage = ledger.usage();
      assert.equal(transactions.filter(row => row.status === 'SUBMITTED' || row.status === 'ACCEPTED').length, 0,
        `${id}: a failed provider request must not produce a submitted result`);
      assert.equal(events.filter(event => event.type === 'result-submitted').length, 0);
      const attempts = usage.filter(row => row.role === 'worker' && row.type === 'assistant/attempt');
      assert.ok(attempts.length > 0, `${id}: the host's failed attempt is retained`);
      assert.ok(usage.some(row => row.role !== 'worker' && typeof row.total_tokens === 'number' && row.total_tokens > 0),
        `${id}: successful management usage remains recorded`);
      for (const budget of ledger.budgets()) {
        assert.equal('tokens_reserved' in budget, false);
        assert.equal('requests_reserved' in budget, false);
      }
      const anomalies = events.filter(event => event.type === 'agent-anomaly');
      assert.ok(anomalies.length >= 1, `${id}: the failure is recorded as an anomaly`);
      outcomes.push({ id, attempts: attempts.length, anomalies: anomalies.length });
    } finally {
      ledger.close();
    }
  }
  assert.equal(outcomes.length, 2);
});

test('N-no-model-limits: a native Worker continues beyond the former eight-request default', async t => {
  const steps = new Map<string | null, number>();
  const { host, mock, layout } = await harness(t, {
    name: 'no-model-limits',
    hooks: { worker(request) {
      const c = request.classified;
      const step = steps.get(c.agentId) ?? 0;
      steps.set(c.agentId, step + 1);
      return step < 9 ? call('flow_sum', { values: [1, 1] })
        : call('flow_transaction', { action: 'submit_result', params: { transaction_id: c.transactionId, result: { sum: 2 } } });
    } },
  });
  const reply = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Call flow_sum nine times, then submit the total 2.',
    workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget,
  }, 300_000));
  assert.ok(reply);
  assert.equal(reply.error, null);
  assert.ok(mock.requests.filter(entry => entry.kind === 'worker').length >= 10);
  const ledger = ledgerOf(layout, reply.cluster_id);
  try {
    assert.ok(ledger.usage().filter(row => row.role === 'worker').length >= 10);
    assert.equal(ledger.transactions()[0]?.status, 'SUBMITTED');
    for (const budget of ledger.budgets()) {
      assert.equal('tokens_limit' in budget, false);
      assert.equal('requests_limit' in budget, false);
    }
  } finally { ledger.close(); }
});

function txCount(events: readonly SqlRow[], type: string): number {
  return events.filter(event => event.type === type).length;
}

/** Fixture IPC is deliberately separate from the eight-method Flow service. */
async function observerRequest(host: DshHost, operation: 'scopes' | 'ordinary' | 'team-launch' | 'agent-session' | 'resume-compacted' | 'ownership' | 'flush-session', params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const child = host.child;
  assert.ok(child?.connected, 'the real host child must be connected');
  const requestId = randomUUID();
  const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<Record<string, unknown>>();
  // This deadline bounds a separate real host process, not a guessed race delay.
  const deadline = AbortSignal.timeout(120_000);
  const cleanup = (): void => {
    child.off('message', receive);
    child.off('exit', exited);
    deadline.removeEventListener('abort', timedOut);
  };
  const receive = (value: unknown): void => {
    const reply = asObject(value);
    if (reply?.nativeObserver !== true || reply.requestId !== requestId) return;
    cleanup();
    if (reply.ok !== true) {
      rejectPromise(new Error(requiredString(reply.error, 'observer error')));
      return;
    }
    const result = asObject(reply.value);
    if (!result) rejectPromise(new Error('invalid observer result'));
    else resolvePromise(result);
  };
  const exited = (): void => {
    cleanup();
    rejectPromise(new Error('host exited during native observation'));
  };
  const timedOut = (): void => {
    cleanup();
    rejectPromise(new Error(`native observer ${operation} timed out`));
  };
  child.on('message', receive);
  child.once('exit', exited);
  deadline.addEventListener('abort', timedOut, { once: true });
  child.send({ ...params, nativeObserver: true, requestId, operation });
  return promise;
}

test('N-permission-rpc: native permission commands accept an omitted submission intent over HTTP', async t => {
  const { host, layout, mock } = await harness(t, { name: 'permission-rpc' });
  const ordinary = await observerRequest(host, 'ordinary');
  const sessionId = requiredString(ordinary.session_id, 'ordinary permission session');
  const url = await host.waitForWebUrl();
  const admission = await fetch(url, { redirect: 'manual' });
  const cookie = admission.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const catalogResponse = await fetch(new URL('/api/permissionPresets/catalog', url), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'permissionPresets/catalog', payload: { args: {} } }),
  });
  const catalog = asObject(asObject(asObject(await catalogResponse.json())?.result)?.value);
  assert.equal(catalog?.defaultPreset, 'workspace-write');
  assert.deepEqual(asArray(catalog?.options)?.map(option => asObject(option)?.value), ['read-only', 'workspace-write', 'danger-full-access']);
  const ordinaryFile = findSessionFile(join(layout.home, 'sessions'), sessionId);
  assert.ok(ordinaryFile);
  const ordinaryEvents = readSessionEvents(ordinaryFile).events;
  assert.equal(asObject(ordinaryEvents.filter(event => event.type === 'permission/preset').at(-1)?.data)?.preset, 'workspace-write');
  assert.equal(asObject(ordinaryEvents.filter(event => event.type === 'approval/policy').at(-1)?.data)?.policy, 'ask', 'ordinary sessions keep interactive approval');
  const requestsBefore = mock.requests.length;
  const execute = async (preset: string, intent: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL('/api/commands/execute', url), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'commands/execute',
        payload: { args: { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [], ...intent } } }),
    });
    assert.equal(response.status, 200);
    return asObject(asObject(await response.json())?.result) ?? {};
  };
  for (const [preset, intent] of [['read-only', {}], ['workspace-write', { submissionId: 'permission-intent' }]] as const) {
    const result = await execute(preset, intent);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(asObject(asObject(result.value)?.result)?.kind, 'success');
    await observerRequest(host, 'flush-session', { sessionId });
    const file = findSessionFile(join(layout.home, 'sessions'), sessionId);
    assert.ok(file);
    const events = readSessionEvents(file).events;
    assert.equal(asObject(events.filter(event => event.type === 'permission/preset').at(-1)?.data)?.preset, preset);
    assert.equal(events.filter(event => event.type === 'command/run').length, events.filter(event => event.type === 'command/done').length);
  }
  const invalid = await execute('read-only', { submissionId: null });
  assert.equal(invalid.ok, false, 'optional intent still rejects a JSON null value');
  assert.equal(asObject(invalid.error)?.code, 'gateway/input-invalid');
  assert.equal(mock.requests.length, requestsBefore, 'permission changes do not invoke the model');
});

test('N-ownership: live and cold Flow composition refuses ordinary execution without a driver',async t=>{
  const {host,mock}=await harness(t,{name:'ownership'});
  const outcome=await observerRequest(host,'ownership');
  const expected=['create','fork','model','queue','prompt','cancel','resolve'];
  assert.deepEqual(outcome.live,expected);assert.deepEqual(outcome.cold,expected);
  assert.equal(outcome.agent_active,false);assert.equal(outcome.marker,'dsh-flow/member');
  assert.equal(mock.requests.length,0,'cold follow never activates a model request');
});

test('N-agent-session: native prompts use the Flow owner, survive retries and retain cold history after recycle',async t=>{
  const {host,layout,mock}=await harness(t,{name:'agent-session'});
  const outcome=await observerRequest(host,'agent-session');
  assert.equal(asObject(outcome.accepted)?.accepted,true);assert.equal(outcome.owned,true);assert.equal(outcome.refused,true);
  assert.equal(asObject(outcome.run)?.state,'completed');
  const events=asArray(outcome.events)??[];
  const human=events.map(asObject).filter(event=>event?.type==='user/message'&&asObject(asObject(event.data)?.source)?.kind==='user')
    .map(event=>asObject(event?.data)).filter(message=>asArray(message?.content)?.some(part=>asString(asObject(part)?.text)?.includes('NATIVE-AGENT-CONTINUATION')));
  assert.equal(human.length,1);assert.ok(asObject(human[0]?.source)?.rpcId);
  assert.equal(asArray(human[0]?.content)?.length,1);assert.ok(!JSON.stringify(human[0]?.content).includes('human_prompt'));
  const ledger=openLedger(join(layout.data,'cluster.sqlite'));t.after(()=>ledger.close());
  assert.equal(ledger.all("SELECT id FROM messages WHERE id LIKE 'human:%'").length,2);
  assert.equal(ledger.all("SELECT recipient FROM recipients WHERE message_id LIKE 'human:%'").length,2);
  const id=requiredString(outcome.session_id,'selected agent session');
  assert.ok(mock.requests.some(request=>JSON.stringify(request.body).includes('NATIVE-AGENT-CONTINUATION')));
  assert.ok(mock.requests.some(request=>JSON.stringify(request.body).includes('NATIVE-ACTIVE-CONTINUATION')));
  const envelopes=readFileSync(join(layout.logs,'llm-envelopes.jsonl'),'utf8').trim().split('\n').map(line=>asObject(JSON.parse(line)))
    .filter(row=>row?.session_id===id && row.purpose!=='session-title');
  assert.ok(envelopes.length);assert.ok(envelopes.every(row=>row?.provider===MOCK_PROVIDER&&row.model===MOCK_MODEL_ID));
});

test('N-team-launch: the native main Agent loads the skill, creates, reads and finalizes in its own journal', async t => {
  const {host,layout}=await harness(t,{name:'team-launch',caseId:'team-launch'});
  const outcome=await observerRequest(host,'team-launch');
  assert.equal(outcome.cold_reload,true,'native persistence reloads the main conversation');
  assert.equal(outcome.launch_ignorable,true,'extension metadata is compatible with the static host event catalog');
  assert.equal(outcome.launches,1,'concurrent and cold command retries reuse one domain launch');
  assert.equal(asArray(outcome.command_ids)?.length,3);
  assert.equal(new Set(asArray(outcome.command_ids)).size,3,'V4 native lifecycle pairing identities remain unique');
  const runs=asArray(outcome.runs);assert.equal(runs?.length,1);
  const run=asObject(runs![0]);assert.equal(run?.state,'completed');assert.ok(run?.finalized_at);
  const id=requiredString(outcome.session_id,'main session');
  const file=findSessionFile(join(layout.home,'sessions'),id);assert.ok(file);
  const journal=readSessionEvents(file);assert.equal(journal.state,'READ');const events=journal.events;
  const human=events.findIndex(event=>event.type==='user/message'&&asObject(asObject(event.data)?.source)?.kind==='user');
  const skill=events.findIndex(event=>event.type==='user/message'&&asObject(asObject(event.data)?.source)?.kind==='skill-invocation'&&asObject(asObject(event.data)?.source)?.name==='agent-team');
  const create=events.findIndex(event=>event.type==='tool/call'&&asObject(event.data)?.name==='agent_team_create');
  assert.ok(human>=0&&skill>human&&create>skill,'human request precedes skill and model-requested creation');
  const names=events.filter(event=>event.type==='tool/call').map(event=>asObject(event.data)?.name);
  assert.ok(names.includes('agent_team_read'));assert.ok(names.includes('agent_team_finalize'));
  const created=events[create]!;const args=asObject(JSON.parse(requiredString(asObject(created.data)?.arguments,'create arguments')));
  assert.equal(asObject(args?.assessment)?.complexity,'simple');
  const ledger=openLedger(join(layout.data,'cluster.sqlite'));t.after(()=>ledger.close());
  const runId=requiredString(run?.id,'team run');
  assert.equal(ledger.all("SELECT seq FROM events WHERE cluster_id=? AND type='team-created'",runId).length,1);
  assert.equal(ledger.all("SELECT seq FROM events WHERE cluster_id=? AND type='team-finalized'",runId).length,1);
  assert.ok(ledger.all('SELECT session_id FROM agents WHERE cluster_id=?',runId).every(agent=>agent.session_id!==id));
});

test('N-scopes: ordinary Agents receive team lifecycle tools while role tools stay scoped', async t => {
  const { host, layout } = await harness(t, { name: 'scopes' });
  const scopes = await observerRequest(host, 'scopes');
  const ordinaryTools = asArray(scopes.ordinary_tools);
  assert.ok(ordinaryTools);

  assert.deepEqual(ordinaryTools.filter(tool => typeof tool === 'string' && tool.startsWith('flow_')), []);
  assert.ok(ordinaryTools.includes('agent_team_read'));
  assert.ok(ordinaryTools.includes('agent_team_control'));
  assert.ok(ordinaryTools.includes('agent_team_create'));
  assert.ok(ordinaryTools.includes('agent_team_message'));
  assert.ok(ordinaryTools.includes('agent_team_finalize'));

  const created = decodeStartReply(await host.request('start', undefined, {
    objective: 'Sum [2,3] and submit 5 through the native tool.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    limits: { max_children: 2, max_depth: 2, max_agents: 8, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 12 },
    budget: singleBudget,
    initial_transactions: [{ id: 'scope-sum', objective: 'Sum [2,3] with flow_sum and submit the tool result.', acceptance_criteria: ['The submitted tool result equals 5'] }],
  }));
  assert.ok(created);
  await host.request('settle', created.cluster.id, { timeout_ms: 300_000, poll_ms: 300 }, 420_000);
  const expected: Record<string, readonly string[]> = {
    orchestrator: ['flow_communicate', 'flow_query', 'flow_sum', 'flow_transaction'],
    allocator: ['flow_allocation', 'flow_communicate', 'flow_query', 'flow_sum'],
    auditor: ['flow_audit', 'flow_communicate', 'flow_query', 'flow_sum'],
    worker: ['flow_communicate', 'flow_query', 'flow_sum', 'flow_transaction'],
  };
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  let agents: SqlRow[];
  try {
    agents = ledger.all('SELECT id,role,session_id FROM agents WHERE cluster_id=?', created.cluster.id);
  } finally {
    ledger.close();
  }
  const observed = readFileSync(join(layout.logs, 'llm-envelopes.jsonl'), 'utf8').trim().split('\n')
    .map(line => {
      const envelope: unknown = JSON.parse(line);
      return asObject(envelope);
    });
  for (const role of Object.keys(expected)) {
    const sessionId = requiredString(agents.find(agent => agent.role === role)?.session_id, `${role} session id`);
    const file = findSessionFile(join(layout.home, 'sessions'), sessionId);
    assert.ok(file);
    const events = readSessionEvents(file).events;
    assert.equal(asObject(events.filter(event => event.type === 'approval/policy').at(-1)?.data)?.policy, 'never', `${role} alone uses unattended approval`);
    assert.equal(asObject(events.filter(event => event.type === 'sandbox/mode').at(-1)?.data)?.mode, 'workspace-write');
    const requests = observed.filter(envelope => envelope?.session_id === sessionId);
    assert.ok(requests.length > 0, `${role} made an actual provider request`);
    for (const request of requests) {
      const options = asObject(JSON.parse(requiredString(request?.before, `${role} request options`)));
      // Native user provenance also starts the host's title-only LLM request.
      if(request?.purpose==='session-title')continue;
      const tools = asArray(options?.tools);
      assert.ok(tools);
      const names = tools.map(tool => asString(asObject(tool)?.name)).filter((name): name is string => name !== null);
      assert.deepEqual(names.filter(name => name.startsWith('flow_')).sort(), expected[role],
        `${role} sees its own role tool and shared tools only`);
    }
  }
});

test('N-missing-capability: unavailable browser tools reject before the first model request', async t => {
  const { host, mock, layout } = await harness(t, { name: 'missing-browser' });
  const before = mock.requests.length;
  const reply = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Open a page with browser tools.',
    workspace: layout.workspace,
    capabilities: ['browser'],
    budget: singleBudget,
  }, 120_000));
  assert.ok(reply);
  assert.equal(mock.requests.length, before, 'capability refusal cannot dispatch a first LLM request');
  assert.match(reply.error ?? '', /CAPABILITY_UNAVAILABLE|browser|capability/i);
  const ledger = ledgerOf(layout, reply.cluster_id);
  try {
    assert.deepEqual(ledger.usage(), [], 'no native model attempt occurs for unavailable tools');
    assert.deepEqual(ledger.effects(), [], 'no native effect was dispatched');
  } finally {
    ledger.close();
  }
});

test('N-default-compaction: the native Loader composition installs one default backend and projects summaries once', async t => {
  const steps = new Map<string | null, number>();
  const { host, mock, layout } = await harness(t, {
    name: 'summary-route',
    hooks: {
      worker(request) {
        const c = request.classified;
        const step = steps.get(c.agentId) ?? 0;
        steps.set(c.agentId, step + 1);
        if (step < 4) return { ...call('read', { file_path: 'pressure.txt' }), usage: { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 } };
        if (step === 4) return call('flow_sum', { values: [2, 3] });
        if (step === 5) {
          const total = sumFromToolResult(c.lastToolResult);
          assert.equal(total, 5, 'submission consumes the real sum tool result');
          return call('flow_transaction', { action: 'submit_result', params: { transaction_id: c.transactionId, result: { sum: total } } });
        }
        return say('5');
      },
    },
  });
  writeFileSync(join(layout.workspace, 'pressure.txt'), Array.from({ length: 1600 }, (_, index) =>
    `line ${index}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega`).join('\n'));
  const reply = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Read pressure.txt, then call flow_sum [2,3] and submit its result.',
    workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget,
  }, 300_000));
  assert.ok(reply);
  assert.equal(reply.error, null, 'the compacted native Worker completes normally');
  const summaries = mock.requests.filter(request => request.kind === 'compaction');
  assert.ok(summaries.length > 0, 'a real native summarizer request reached the model endpoint');
  for (const request of summaries) {
    assert.equal(request.model, MOCK_MODEL_ID);
    const body = asObject(request.body);
    assert.ok(body);
    assert.equal(body.max_completion_tokens, 65_536, 'the official backend owns its default summary request allowance');
  }
  const envelopes = readFileSync(join(layout.logs, 'llm-envelopes.jsonl'), 'utf8').trim().split('\n')
    .map(line => { const value: unknown = JSON.parse(line); return asObject(value); });
  const summaryEnvelopes = envelopes.filter(entry => entry?.purpose === 'compaction');
  assert.equal(summaryEnvelopes.length, summaries.length);
  for (const envelope of summaryEnvelopes) {
    assert.ok(envelope);
    assert.equal(envelope.provider, MOCK_PROVIDER);
    assert.equal(envelope.model, MOCK_MODEL_ID);
    assert.equal(envelope.before, envelope.after, 'the summary messages/tools/reasoning envelope passes through unchanged');
  }
  const ledger = ledgerOf(layout, reply.cluster_id);
  let beforeOrdinary: SqlRow[];
  try {
    const usage = ledger.usage();
    const projected = usage.filter(row => row.type === 'compaction/summary');
    const native = sessionsOf(layout, reply.cluster_id).flatMap(session => session.events).filter(event => event.type === 'compaction/summary');
    assert.equal(projected.length, native.length, 'each durable native summary is projected once');
    assert.ok(projected.length <= summaries.length, 'the official backend may retry an unlanded summary; only its durable summary events are counted');
    const composition = readFileSync(join(layout.logs, 'llm-envelopes.jsonl.compaction.jsonl'), 'utf8').trim().split('\n').map(line => asObject(JSON.parse(line)));
    assert.ok(composition.length > 0);
    for (const row of composition) {
      assert.equal(row?.private_backends, 1, 'exactly one official default backend is mounted for a Flow Agent');
      assert.equal(row?.global_backends, 0, 'no host-plane listener also receives the same Agent');
      assert.deepEqual(row?.config, {}, 'Flow supplies no compaction policy overrides');
    }
    assert.equal(new Set(usage.map(row => `${row.native_session_id}:${row.native_seq}`)).size, usage.length);
    for (const row of projected) assert.ok(typeof row.total_tokens === 'number' && row.total_tokens > 0);
    beforeOrdinary = usage;

  } finally {
    ledger.close();
  }
  const worker = sessionsOf(layout, reply.cluster_id).find(session => session.role === 'worker');
  const sessionId = requiredString(worker?.session_id, 'compacted Worker session');
  const resumed = await observerRequest(host, 'resume-compacted', { sessionId });
  assert.equal(resumed.cold, true, 'the completed Worker handle has released its live Session');
  assert.equal(resumed.approval_policy, 'never', 'cold resume retains session-local unattended approval');
  assert.equal(resumed.checkpoint_in_history, true, 'native resume restores the durable compacted checkpoint into effective history');
  assert.ok(typeof resumed.saved_summaries === 'number' && resumed.saved_summaries > 0);
  assert.equal(resumed.final_text, 'RESUMED-COMPACTION-OK', 'the same compacted Session completes a later native request');
  assert.equal(resumed.cursor, Number(resumed.native_seq) - 1, 'the resumed tail and passive cursor advance together');
  assert.equal(resumed.replay_unchanged, true, 'two cold event replays retain exactly the same recorded usage');
  assert.ok(mock.requests.some(request => request.classified.userText.includes('NATIVE-RESUMED-COMPACTION:')
    && JSON.stringify(request.body).includes('<compacted-summary>')), 'the actual resumed provider request includes the saved checkpoint');
  const resumedComposition = readFileSync(join(layout.logs, 'llm-envelopes.jsonl.compaction.jsonl'), 'utf8').trim().split('\n')
    .map(line => asObject(JSON.parse(line))).filter(row => row?.session_id === sessionId);
  assert.equal(resumedComposition.length, 2, 'creation and cold resume each publish their own native Agent scope');
  assert.ok(resumedComposition.every(row => row?.private_backends === 1 && row.global_backends === 0), 'each scope owns one default backend');
  const resumedLedger = ledgerOf(layout, reply.cluster_id);
  try {
    const afterResume = resumedLedger.usage();
    assert.equal(afterResume.filter(row => row.type === 'compaction/summary').length,
      beforeOrdinary.filter(row => row.type === 'compaction/summary').length, 'cold resume and replay never count prior summaries twice');
    assert.equal(afterResume.length, beforeOrdinary.length + 1, 'one additional native assistant settlement is projected');
    beforeOrdinary = afterResume;
  } finally {
    resumedLedger.close();
  }
  const requestsBeforeOrdinary = mock.requests.length;
  const ordinary = await observerRequest(host, 'ordinary');
  assert.equal(typeof ordinary.session_id, 'string');
  assert.equal(ordinary.flow_compaction_backends, 0, 'the private compaction backend unloads with its native Agent scope');
  const after = ledgerOf(layout, reply.cluster_id);
  try {
    assert.deepEqual(after.usage(), beforeOrdinary, 'an ordinary Session is excluded from this Flow projection');
  } finally {
    after.close();
  }
  assert.equal(mock.requests.length, requestsBeforeOrdinary + 1, 'the ordinary Agent really made its independent request');
});

test('N-summary-cancel: native cancellation preserves incomplete compaction evidence without fabricated usage', async t => {
  const { host, mock, layout } = await harness(t, {
    name: 'summary-cancel', holdSummary: true,
    hooks: { worker() {
      return { ...call('read', { file_path: 'pressure.txt' }), usage: { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 } };
    } },
  });
  writeFileSync(join(layout.workspace, 'pressure.txt'), 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau\n'.repeat(1600));
  const created = decodeStartReply(await host.request('start', undefined, {
    objective: 'Read pressure.txt and report what it contains.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    limits: { max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 2, max_llm_concurrency: 1, max_role_turns: 6 },
    initial_transactions: [{ id: 'summary-cancel', objective: 'Read pressure.txt and report what it contains.', acceptance_criteria: ['The contents are reported from the actual file'] }],
  }));
  assert.ok(created);
  const clusterId = created.cluster.id;
  await mock.waitUntilHeld(1, { barrier: 'native-summary-cancel', timeoutMs: 120_000 });
  const held = mock.requests.find(request => request.kind === 'compaction' && request.held);
  assert.ok(held, 'a native summary stream is held at the fixture endpoint');
  await host.request('control', clusterId, { action: 'cancel' }, 120_000);
  await host.request('settle', clusterId, { timeout_ms: 120_000, poll_ms: 100 }, 180_000);
  assert.equal(mock.heldCount('native-summary-cancel'), 0, 'the cluster turn abort disconnects its held summary stream');
  const ledger = ledgerOf(layout, clusterId);
  try {
    const usage = ledger.usage();
    assert.equal(usage.filter(row => row.type === 'compaction/summary').length, 0,
      'a cancelled summary with no native usage is never fabricated as a request or a zero-cost summary');
    const deadline = Date.now() + 10_000;
    let native = sessionsOf(layout, clusterId).flatMap(session => session.events);
    let projected = ledger.sessionEvents();
    while ((!native.some(event => event.type === 'compaction/end') || !projected.some(event => event.type === 'compaction/end')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      native = sessionsOf(layout, clusterId).flatMap(session => session.events);
      projected = ledger.sessionEvents();
    }
    assert.ok(native.some(event => event.type === 'compaction/start'));
    assert.ok(native.some(event => event.type === 'compaction/end' && typeof asObject(event.data)?.error === 'string'));
    assert.ok(projected.some(event => event.type === 'compaction/end' && typeof asObject(JSON.parse(String(event.data)))?.error === 'string'),
      'the durable Flow projection retains the native cancellation end event');
    const facts = openLedger(join(layout.data, 'cluster.sqlite'));
    try {
      assert.equal(usageSummary(facts, clusterId).completeness, 'incomplete', 'the failed native compaction marks recorded usage incomplete');
    } finally {
      facts.close();
    }
    for (const row of ledger.budgets()) assert.equal('tokens_reserved' in row, false);
    assert.equal(ledger.transactions().filter(row => row.status === 'SUBMITTED' || row.status === 'ACCEPTED').length, 0);

  } finally {
    ledger.close();
  }
});

test('N-capabilities: requested fs, shell/jobs and web tools execute through native dispatch', async t => {
  let fetchUrl = '';
  const { host, mock, layout } = await harness(t, {
    name: 'capabilities',
    hooks: { worker(request) {
      const c = request.classified;
      if (!c.lastToolName || c.lastToolName === 'flow_query') return call('write', { file_path: 'native.txt', content: 'NATIVE-CAPABILITY\\n' });
      if (c.lastToolName === 'write') return call('read', { file_path: 'native.txt' });
      if (c.lastToolName === 'read') {
        assert.match(c.lastToolResult ?? '', /NATIVE-CAPABILITY/, 'the real filesystem returned the written marker');
        return call('bash', { command: 'printf NATIVE-CAPABILITY', description: 'Printing native capability marker', run_in_background: true });
      }
      if (c.lastToolName === 'bash') {
        const jobId = /started background job (\S+)/u.exec(c.lastToolResult ?? '')?.[1];
        assert.ok(jobId, 'the real shell producer returned its registered job id');
        return call('job_output', { job_id: jobId, wait: true });
      }
      if (c.lastToolName === 'job_output') {
        return call('web_fetch', { url: fetchUrl });
      }
      if (c.lastToolName === 'web_fetch') {
        assert.match(c.lastToolResult ?? '', /non-public IP/i,
          'the native web capability refuses the fixture loopback URL at its public-network boundary');
        return call('flow_transaction', { action: 'submit_result', params: {
          transaction_id: c.transactionId, result: { completed: true, web_fetch_refused: true },
        } });
      }
      return say('native capabilities completed');
    } },
  });
  fetchUrl = `${mock.baseURL}/models`;
  const reply = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Write/read native.txt, run a background shell job, collect its output, then verify web_fetch refuses a loopback destination.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write', 'shell', 'web_fetch'],
    budget: singleBudget,
  }, 300_000));
  assert.ok(reply);
  assert.equal(reply.error, null);
  assert.equal(readFileSync(join(layout.workspace, 'native.txt'), 'utf8'), 'NATIVE-CAPABILITY\\n');
  const first = mock.requests.find(request => request.classified.kind === 'worker');
  assert.ok(first);
  for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_output', 'job_kill', 'web_fetch']) {
    assert.ok(first.tools.includes(name), `${name} is mounted before the first provider request`);
  }
  const ledger = ledgerOf(layout, reply.cluster_id);
  try {
    for (const tool of ['write', 'read', 'bash', 'job_output', 'web_fetch']) {
      const receipts = ledger.toolCalls().filter(row => row.tool === tool);
      assert.equal(receipts.length, 1, `${tool} dispatched once`);
      assert.equal(receipts[0]?.dispatch_status, 'SETTLED');
      if (tool === 'web_fetch') {
        const body = asObject(JSON.parse(requiredString(receipts[0]?.result_body, `${tool} result body`)));
        assert.equal(body?.isError, true, 'the real web tool refuses the non-public loopback destination');
        assert.match(requiredString(body?.text, `${tool} refusal`), /non-public IP/i);
      } else {
        assert.equal(receipts[0]?.error, null, `${tool} completed without a fabricated fallback`);
      }
    }
  } finally {
    ledger.close();
  }
});

test('N-identity: model-supplied identities cannot cross a live cluster domain', async t => {
  let foreignTransaction = '';
  let foreignCluster = '';
  let attackStep = 0;
  const { host, layout } = await harness(t, {
    name: 'identity',
    hooks: { worker(request) {
      const c = request.classified;
      if ((c.objective ?? '').includes('Do not overwrite')) return say('Foreign domain remains unchanged.');
      const step = attackStep++;
      if (step === 0) return call('flow_transaction', {
        action: 'submit_result', params: {
          transaction_id: foreignTransaction, result: { forged: true },
          role: 'orchestrator', agent_id: 'forged-agent', cluster_id: foreignCluster,
        },
      });
      if (step === 1) {
        return call('flow_query', { what: 'transaction', params: { id: foreignTransaction, cluster_id: foreignCluster, role: 'user' } });
      }
      if (step === 2) return call('flow_transaction', {
        action: 'submit_result', params: { transaction_id: c.transactionId, result: { marker: 'owned-result' } },
      });
      return say('domain enforcement observed');
    } },
  });
  const foreign = decodeStartReply(await host.request('start', undefined, {
    objective: 'Foreign domain must remain unchanged.', workspace: layout.workspace,
    capabilities: ['fs_read'], budget: singleBudget,
    initial_transactions: [{ id: 'foreign-transaction', objective: 'Do not overwrite this transaction.' }],
  }));
  assert.ok(foreign);
  foreignCluster = foreign.cluster.id;
  await host.request('control', foreignCluster, { action: 'pause' });
  const db = openLedger(join(layout.data, 'cluster.sqlite'));
  let before: SqlRow;
  try {
    const row = db.get('SELECT id,status,result,revision FROM transactions WHERE cluster_id=?', foreignCluster);
    assert.ok(row);
    before = row;
    foreignTransaction = requiredString(row.id, 'foreign transaction id');
  } finally {
    db.close();
  }
  const reply = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Exercise domain boundaries, then submit a result only to your own allocated transaction.',
    workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget,
  }, 300_000));
  assert.ok(reply);
  const after = openLedger(join(layout.data, 'cluster.sqlite'));
  try {
    assert.deepEqual(after.get('SELECT id,status,result,revision FROM transactions WHERE id=?', foreignTransaction), before,
      'forged model identities cannot write the other live domain');
  } finally {
    after.close();
  }
  const results = sessionsOf(layout, reply.cluster_id).flatMap(toolResults);
  assert.ok(results.filter(text => /outside|another cluster|not found|not allocated|403|404|permission/i.test(text)).length >= 2,
    `both foreign write and foreign query are refused: ${JSON.stringify(results)}`);
  const owned = ledgerOf(layout, reply.cluster_id);
  try {
    assert.equal(owned.transactions()[0]?.status, 'SUBMITTED', 'legitimate work still succeeds after the refusals');
    const result = asObject(JSON.parse(requiredString(owned.transactions()[0]?.result, 'owned result')));
    assert.equal(result?.marker, 'owned-result');
  } finally {
    owned.close();
  }
});
