/**
 * Native host contracts under the deterministic model endpoint.
 *
 * These drive a *real* DSH host — real agent loop, real tool execution, real
 * Session and real SQLite — with only the model's generation replaced. They are
 * deliberately not part of `npm test`: they boot a host process, and their
 * subject is the plugin's boundary behaviour rather than its pure logic.
 *
 * N0 is the positive round trip the release gate names. F-permission,
 * F-arguments, F-transport and F-budget are the four negative contracts: each
 * one declares an exact expected refusal and the side effects that must *not*
 * exist afterwards. An unexpected success is a failure, and an unexplained
 * failure is not accepted as a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DshHost, buildHostEnv, createRunLayout, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../../src/host/host.mjs';
import { startMockModel } from '../../../src/host/mock-model.mjs';
import { buildScenario, call, say, sumFromToolResult } from '../../../src/host/mock-scenarios.mjs';
import { inspectNativeSumRoundTrip } from '../qwen-smoke.mjs';
import { findSessionFile, readSessionEvents } from '../../../src/host/session-scan.mjs';
import { openLedger } from '../../../src/host/ledger.mjs';
import { MOCK_API_KEY, MOCK_MODEL_ID, MOCK_PROVIDER, mockPatchText } from '../run.mjs';

const ARTIFACTS_ROOT = join(PROJECT_ROOT, '.artifacts');
let sequence = 0;

/** One isolated native run: its own profile, home, data dir, workspace and mock. */
async function harness(t, { name, hooks, caseId = 'native' }) {
  sequence += 1;
  const runId = `native-${name}-${Date.now().toString(36)}-${sequence}`;
  const layout = createRunLayout(ARTIFACTS_ROOT, runId);
  const mock = await startMockModel({ modelId: MOCK_MODEL_ID });
  const profile = `dsh-flow-${runId}`;
  const overlay = join(layout.root, 'mock-model.patch.yml');
  writeFileSync(overlay, mockPatchText(mock.baseURL));
  const patches = [resolve(PROJECT_ROOT, 'examples/cluster.patch.yml'), overlay];
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES });
  const env = buildHostEnv({
    home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: mock.baseURL, model: MOCK_MODEL_ID, provider: MOCK_PROVIDER },
    modelApiKey: MOCK_API_KEY,
  });
  const host = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
  mock.setScenario(buildScenario({ caseId, layout, workspace: layout.workspace, hooks }));
  await host.start();
  // The plugin signals readiness before every bundle has mounted; a turn
  // started too early finds no agent loop. Waiting for the host's own web URL
  // is the same barrier the acceptance runner uses.
  await host.waitForWebUrl(120_000);
  t.after(async () => {
    await host.stop();
    await mock.close();
  });
  return { host, mock, layout, runId };
}

/** The effect rows and events of one cluster, read from the run's own database. */
function ledgerOf(layout, clusterId) {
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  return {
    effects: () => ledger.all('SELECT tool,status,args,body,error FROM effects WHERE cluster_id=? ORDER BY rowid', clusterId),
    events: () => ledger.all('SELECT type,data FROM events WHERE cluster_id=? ORDER BY seq', clusterId),
    transactions: () => ledger.all('SELECT id,status,result FROM transactions WHERE cluster_id=?', clusterId),
    allocations: () => ledger.all('SELECT id,status,transaction_id FROM allocations WHERE cluster_id=?', clusterId),
    usage: () => ledger.all('SELECT request_id,status,total_tokens FROM usage_receipts WHERE cluster_id=?', clusterId),
    receipts: () => ledger.all('SELECT request_id,agent_id,role,kind,status,reservation_tokens,total_tokens,budget_scope_id,note FROM usage_receipts WHERE cluster_id=? ORDER BY created', clusterId),
    budgets: () => ledger.all('SELECT id,scope_kind,scope_id,tokens_limit,tokens_spent,tokens_reserved FROM budgets WHERE cluster_id=?', clusterId),
    toolCalls: () => ledger.all('SELECT tool,dispatch_status,error FROM tool_call_receipts WHERE cluster_id=? ORDER BY rowid', clusterId),
    close: () => ledger.close(),
  };
}

/** The native session events of every identity in one cluster. */
function sessionsOf(layout, clusterId) {
  const ledger = openLedger(join(layout.data, 'cluster.sqlite'));
  const agents = ledger.all('SELECT id,role,session_id FROM agents WHERE cluster_id=?', clusterId);
  ledger.close();
  const root = join(layout.home, 'sessions');
  return agents.map(agent => {
    const file = findSessionFile(root, agent.session_id);
    const read = file ? readSessionEvents(file) : { state: 'MISSING', events: [] };
    return { ...agent, file, state: read.state, events: read.events ?? [] };
  });
}

/** Every tool result text a session recorded, in order. */
function toolResults(session) {
  return session.events.filter(event => event.type === 'tool/result')
    .map(event => (event.data?.message?.content ?? []).map(part => part?.text ?? '').join(''));
}

const singleBudget = { tokens: 1_000_000, model_requests: 200, tool_calls: 200, wall_time_ms: 600_000, agents: 8, max_active_agents: 2 };

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
  const single = await host.request('single', undefined, {
    objective: 'Use the flow_sum tool on [2,3] and submit the resulting number as the transaction result.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['The submitted result contains the number 5'],
  }, 300_000);

  assert.equal(single.cluster_id ? true : false, true, 'the single control reports its cluster');
  const ledger = ledgerOf(layout, single.cluster_id);
  try {
    const transactions = ledger.transactions();
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].status, 'SUBMITTED', 'the staged submission is published when the turn ends');
    assert.deepEqual(JSON.parse(transactions[0].result), { sum: 5 });
    // The single control publishes its staged submission through its own path,
    // so the durable proof is the transaction's own status and result plus the
    // native session below — not the presence of one particular event name.
    assert.equal(txCount(ledger.events(), 'single-control-finished'), 1);
  } finally {
    ledger.close();
  }

  const db = openLedger(join(layout.data, 'cluster.sqlite'));
  const sessionId = db.get('SELECT session_id FROM agents WHERE cluster_id=?', single.cluster_id).session_id;
  db.close();
  const file = findSessionFile(join(layout.home, 'sessions'), sessionId);
  assert.ok(file, 'the Worker session must exist on disk');
  const read = readSessionEvents(file);
  assert.equal(read.state, 'READ', `the session must be readable: ${read.reason ?? ''}`);
  const verdict = inspectNativeSumRoundTrip(read.events);
  assert.deepEqual(verdict.verified, true, `native round trip: ${JSON.stringify(verdict)}`);
  assert.equal(String(single.finalText ?? '').trim(), '5', 'the assistant answered with the number the tool returned');
  assert.equal(mock.errors.length, 0, `fixture errors: ${mock.errors.join('; ')}`);
});

test('F-permission: a Worker cannot reach management tools or write outside its scope', async t => {
  const { host, mock, layout } = await harness(t, {
    name: 'f-permission',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName) {
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
  const single = await host.request('single', undefined, {
    objective: 'Attempt one management call and one out-of-scope write, then report what happened.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget,
    acceptance_criteria: ['The result states that both attempts were refused'],
  }, 300_000);

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
    const anomalies = ledger.events().filter(event => /refus|anomaly|blocked/.test(event.type));
    assert.ok(anomalies.length >= 1, `a durable refusal is recorded: ${JSON.stringify(ledger.events().map(e => e.type))}`);
  } finally {
    ledger.close();
  }
  void mock;
});

test('F-arguments: sharded arguments assemble, both params spellings persist, illegal params refuse cleanly', async t => {
  const submitted = new Map();
  const { host, mock, layout } = await harness(t, {
    name: 'f-arguments',
    hooks: {
      worker(request) {
        const c = request.classified;
        if (c.lastToolName) {
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
  const created = await host.request('start', undefined, spec, 120_000);
  await host.request('settle', created.cluster.id, { timeout_ms: 300_000, poll_ms: 300 }, 420_000);

  const ledger = ledgerOf(layout, created.cluster.id);
  try {
    const transactions = ledger.transactions();
    for (const row of transactions) {
      assert.equal(row.status, 'ACCEPTED', `${row.id} must be accepted, not ${row.status}`);
      assert.equal(JSON.parse(row.result).sum, 5, `${row.id} carries the value the tool returned`);
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
        if (c.lastToolName) return say('done');
        return call('flow_transaction', {
          action: 'submit_result',
          params: { transaction_id: 'not-a-transaction', result: { sum: 5 } },
        });
      },
    },
  });
  const badSingle = await bad.host.request('single', undefined, {
    objective: 'Submit a result for a transaction that does not belong to this identity.',
    workspace: bad.layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['nothing is submitted'],
  }, 300_000);
  const badLedger = ledgerOf(bad.layout, badSingle.cluster_id);
  try {
    const results = sessionsOf(bad.layout, badSingle.cluster_id).flatMap(toolResults);
    assert.ok(results.some(text => /not found|not allocated|outside|403|404|Cluster Agent/i.test(text)),
      `the illegal submission was refused with a named reason: ${JSON.stringify(results)}`);
    // The turn itself still ends and publishes its own prose output; what must
    // not happen is the *illegal submission* landing as the result.
    for (const row of badLedger.transactions()) {
      const parsed = row.result ? JSON.parse(row.result) : null;
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
        if (c.lastToolName) return say('done');
        return { toolCalls: [{ name: 'flow_sum', arguments: malformedRaw }], chunkBoundaries: [1, 4, 9] };
      },
    },
  });
  const malformedSingle = await malformed.host.request('single', undefined, {
    objective: 'Call the sum tool with an argument stream that never assembles.',
    workspace: malformed.layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget,
    acceptance_criteria: ['nothing is submitted'],
  }, 300_000);
  const malformedLedger = ledgerOf(malformed.layout, malformedSingle.cluster_id);
  try {
    const sessions = sessionsOf(malformed.layout, malformedSingle.cluster_id);
    const calls = sessions.flatMap(session => session.events.filter(event => event.type === 'tool/call'));
    const results = sessions.flatMap(session => session.events.filter(event => event.type === 'tool/result'));
    assert.equal(calls.length, 1, `exactly the malformed call was issued: ${JSON.stringify(calls)}`);
    const [attempt] = calls;
    assert.equal(attempt.data.name, 'flow_sum');
    // What the call was recorded with is not the stream that was sent: the host
    // could not decode it and normalised the arguments to an empty object.
    assert.equal(String(attempt.data.arguments), '{}',
      `the undecodable stream is not the recorded argument text: ${JSON.stringify(attempt.data.arguments)}`);
    const refusal = results.find(event => event.data.message?.toolCallId === attempt.data.callId);
    assert.ok(refusal, `the malformed call has a result of its own: ${JSON.stringify(results)}`);
    assert.equal(refusal.data.message?.isError, true);
    assert.equal(refusal.data.error?.code, 'INVALID_ARGS', JSON.stringify(refusal.data.error));
    assert.ok(toolResults({ events: [refusal] }).some(text => /invalid arguments/i.test(text)),
      'the refusal names invalid arguments rather than a domain reason');

    assert.deepEqual(malformedLedger.effects(), [], 'no effect came from the malformed call');
    for (const row of malformedLedger.transactions()) {
      const parsed = row.result ? JSON.parse(row.result) : null;
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
  const outcomes = [];
  const { host, layout } = await harness(t, {
    name: 'f-transport',
    hooks: {
      worker(request) {
        const c = request.classified;
        const mode = c.objective ?? '';
        if (/aborted stream/u.test(mode)) return c.lastToolName ? say('done') : { abort: true };
        if (/server error/u.test(mode)) return c.lastToolName ? say('done') : { fail: { status: 500, message: 'declared server failure' } };
        return say(`no stimulus matched: ${mode}`);
      },
    },
  });
  for (const [id, objective] of [
    ['transport-500', 'Provoke a declared server error from the model endpoint and report it.'],
    ['transport-abort', 'Provoke an aborted stream from the model endpoint and report it.'],
  ]) {
    const spec = {
      objective,
      workspace: layout.workspace,
      capabilities: ['fs_read'],
      limits: { max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 1, max_llm_concurrency: 1, max_role_turns: 4, max_attempts: 1 },
      budget: { ...singleBudget, model_requests: 40 },
      initial_transactions: [{ id, objective, acceptance_criteria: ['reported honestly'] }],
    };
    const created = await host.request('start', undefined, spec, 120_000);
    await host.request('settle', created.cluster.id, { timeout_ms: 180_000, poll_ms: 300 }, 300_000);
    const ledger = ledgerOf(layout, created.cluster.id);
    try {
      const transactions = ledger.transactions();
      const events = ledger.events();
      const receipts = ledger.receipts();
      const budgets = ledger.budgets();
      assert.equal(transactions.filter(row => row.status === 'SUBMITTED' || row.status === 'ACCEPTED').length, 0,
        `${id}: a failed provider request must not produce a submitted result`);
      assert.equal(events.filter(event => event.type === 'result-submitted').length, 0,
        `${id}: no result may be published from a turn whose request failed`);
      assert.ok(receipts.length >= 1, `${id}: the dispatched request is accounted`);
      assert.equal(receipts.filter(row => row.status === 'RESERVED').length, 0, `${id}: no receipt is left reserved`);

      // The Worker's own request is the one that failed. The harness reports a
      // transport failure with a *zeroed* usage object, so a receipt that
      // settles on it books a cost of zero and hands the token hold back as free
      // capacity — the exact release `settleLlmRequest` refuses for an unknown
      // outcome. The receipt must therefore be UNKNOWN, with its hold intact.
      const workerReceipts = receipts.filter(row => row.kind === 'worker');
      assert.ok(workerReceipts.length >= 1, `${id}: the Worker's request is recorded`);
      for (const receipt of workerReceipts) {
        assert.equal(receipt.status, 'UNKNOWN',
          `${id}: an unaccounted failure is UNKNOWN, not settled at zero (${receipt.status}, total=${receipt.total_tokens})`);
        assert.equal(receipt.total_tokens, null, `${id}: no zero total is booked for an unaccounted failure`);
        assert.ok(Number(receipt.reservation_tokens) > 0, `${id}: the request reserved tokens`);
        assert.ok(/failed after dispatch|unknown/.test(String(receipt.note ?? '')),
          `${id}: the unknown outcome carries its reason: ${receipt.note}`);
      }
      // Reservation conservation: every retained hold is still held by the scope
      // that paid for it, and the unknown request did not consume tokens.
      const retained = workerReceipts
        .filter(receipt => receipt.status === 'UNKNOWN')
        .reduce((sum, receipt) => sum + Number(receipt.reservation_tokens), 0);
      const held = budgets.reduce((sum, row) => sum + Number(row.tokens_reserved), 0);
      assert.ok(held >= retained, `${id}: the retained holds stay reserved (held ${held} >= retained ${retained})`);
      // The successful management turns are untouched: a real provider report is
      // still a settled cost.
      const roleReceipts = receipts.filter(row => row.kind !== 'worker' && row.status !== 'NOT_SENT');
      assert.ok(roleReceipts.some(receipt => receipt.status === 'SETTLED' && Number(receipt.total_tokens) > 0),
        `${id}: genuine usage still settles: ${JSON.stringify(roleReceipts.map(r => [r.status, r.total_tokens]))}`);
      const anomalies = events.filter(event => event.type === 'agent-anomaly');
      assert.ok(anomalies.length >= 1, `${id}: the failure is recorded as an anomaly`);
      outcomes.push({ id, worker_receipts: workerReceipts.map(row => [row.status, row.reservation_tokens, row.total_tokens]), retained, held, anomalies: anomalies.length });
    } finally {
      ledger.close();
    }
  }
  assert.equal(outcomes.length, 2);
});

test('F-budget: a Worker allowance of two requests refuses the third before the endpoint', async t => {
  const { host, mock, layout } = await harness(t, {
    name: 'f-budget',
    hooks: {
      worker(request) {
        const c = request.classified;
        // Every step asks for one more real tool call and never submits: the
        // only thing that can stop the turn is the declared allowance.
        return call('flow_sum', { values: [1, 1], attempt: (c.messageCount) });
      },
    },
  });
  const spec = {
    objective: 'Keep calling flow_sum without ever submitting a result.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    limits: {
      max_children: 2, max_depth: 2, max_agents: 4, max_active_agents: 1,
      max_llm_concurrency: 1, max_role_turns: 6, max_attempts: 1,
      worker_model_requests: 2, worker_max_tokens: 512,
    },
    budget: { ...singleBudget, model_requests: 40 },
    initial_transactions: [{ id: 'budget-worker', objective: 'Keep calling flow_sum without submitting.', acceptance_criteria: ['never submits'] }],
  };
  const created = await host.request('start', undefined, spec, 120_000);
  await host.request('settle', created.cluster.id, { timeout_ms: 180_000, poll_ms: 300 }, 300_000);

  const workerRequests = mock.requests.filter(entry => entry.kind === 'worker');
  assert.equal(workerRequests.length, 2,
    `the endpoint must see exactly the declared allowance: ${JSON.stringify(workerRequests.map(entry => entry.seq))}`);
  const ledger = ledgerOf(layout, created.cluster.id);
  try {
    const refusals = ledger.events().filter(event => event.type === 'agent-anomaly' || event.type === 'result-withheld' || /refused/.test(event.type));
    assert.ok(refusals.length >= 1, `a durable refusal must be recorded: ${JSON.stringify(ledger.events().map(e => e.type))}`);
    const stop = ledger.events()
      .filter(event => event.type === 'turn-end')
      .map(event => JSON.parse(event.data).stop_detail?.message ?? '')
      .find(message => /allowance/.test(message));
    assert.ok(stop, `the refusal names the allowance: ${JSON.stringify(ledger.events().map(e => e.type))}`);
    const receiptStates = ledger.usage().map(row => row.status);
    assert.equal(receiptStates.filter(status => status === 'RESERVED').length, 0, 'no receipt is left reserved');
    assert.equal(ledger.transactions().filter(row => row.status === 'SUBMITTED' || row.status === 'ACCEPTED').length, 0,
      'the Worker never submitted, so no transaction was published');
  } finally {
    ledger.close();
  }
  assert.equal(mock.errors.length, 0, `fixture errors: ${mock.errors.join('; ')}`);
});

function txCount(events, type) {
  return events.filter(event => event.type === type).length;
}
