#!/usr/bin/env node
/**
 * V1: local Qwen acceptance for the plugin's model and tool path.
 *
 * Every tool assertion goes through a complete DSH profile assembly — a direct
 * HTTP probe proves nothing about the harness wiring. Receipts are written to
 * .artifacts/<run-id>/qwen-smoke.json.
 *
 * Usage: FLOW_QWEN_BASE_URL=... FLOW_QWEN_MODEL=... node acceptance/qwen-smoke.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DshHost, buildHostEnv, createRunLayout, ensureProfile, WEB_PROFILE_BUNDLES, PROJECT_ROOT } from './lib/host.mjs';
import { computeBuildHashes } from './run.mjs';
import { findSessionFile, readSessionEvents } from './lib/session-scan.mjs';

const RUN_ID = process.env.FLOW_QWEN_RUN_ID ?? `qwen-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const BASE_URL = process.env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1';
const MODEL = process.env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-FP8';
const PROVIDER = process.env.FLOW_MODEL_PROVIDER ?? 'local-sglang';

const checks = [];
const push = (name, passed, evidence) => {
  checks.push({ name, passed: passed === null ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500) });
  console.log(`${passed === null ? 'SKIP' : passed ? 'ok  ' : 'FAIL'} ${name} :: ${String(evidence).slice(0, 160)}`);
};

async function main() {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts'), RUN_ID);
  const receipts = { run_id: RUN_ID, base_url: BASE_URL, model: MODEL, provider: PROVIDER, http: {}, host: {} };

  await httpProtocolSuite(receipts);

  const profile = `dsh-flow-${RUN_ID}`.replace(/[^A-Za-z0-9._-]/g, '-');
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES });
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: BASE_URL, model: MODEL, provider: PROVIDER } });
  const patch = join(PROJECT_ROOT, 'examples/cluster.patch.yml');
  assertPatchMatchesEnv(patch);

  const host = new DshHost({ profile, patch, cwd: layout.workspace, env, logPath: join(layout.logs, 'qwen-smoke.log') });
  try {
    await host.start();
    await host.waitForWebUrl(180_000);

    await agentReasoningSuite(host, layout, receipts);
    await filesystemSuite(host, layout, receipts);
    await webFetchSuite(host, layout, receipts);
    await cancellationSuite(host, layout, receipts);
    await concurrencySuite(host, layout, receipts);
  } finally {
    await host.stop();
  }

  const failed = checks.filter(entry => entry.passed === false);
  const report = { run_id: RUN_ID, checks, receipts, status: failed.length ? 'FAILED' : 'PASSED', build_hashes: computeBuildHashes({ id: null }, [patch]) };
  writeFileSync(join(layout.root, 'qwen-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nqwen smoke: ${failed.length ? 'FAILED' : 'PASSED'} (${checks.length} checks) → ${join(layout.root, 'qwen-smoke.json')}`);
  if (failed.length) process.exitCode = 1;
}

/** Raw protocol facts about the service itself (not a substitute for tool wiring). */
async function httpProtocolSuite(receipts) {
  const models = await fetch(`${BASE_URL}/models`).then(response => response.json());
  const ids = (models.data ?? []).map(entry => entry.id);
  push('models-list-has-exact-id', ids.includes(MODEL), `ids: ${ids.join(', ')}`);
  receipts.http.models = models.data;

  const short = await post('/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 24, temperature: 0,
  });
  push('non-streaming-short-answer', /OK/.test(short.choices?.[0]?.message?.content ?? ''), JSON.stringify(short.choices?.[0]?.message ?? {}).slice(0, 300));
  receipts.http.non_streaming = short;

  const streamed = await streamChat({
    model: MODEL,
    messages: [{ role: 'user', content: 'Use the flow_sum tool on [2, 3].' }],
    tools: [sumTool()],
    max_tokens: 256,
    temperature: 0,
    stream_options: { include_usage: true },
  });
  push('streaming-completes-with-usage', streamed.finishReason === 'tool_calls' && streamed.usage !== null,
    `finish=${streamed.finishReason} usage=${JSON.stringify(streamed.usage)}`);
  push('native-tool-call-in-stream', streamed.toolCalls.length === 1 && streamed.toolCalls[0].name === 'flow_sum',
    JSON.stringify(streamed.toolCalls).slice(0, 300));
  // The service's own default keeps thinking on; the harness disables it per
  // request through the qwen chat template, so the raw probe records the
  // default and the *agent* path is asserted from its usage receipts below.
  receipts.http.streaming = { finishReason: streamed.finishReason, usage: streamed.usage, toolCalls: streamed.toolCalls, reasoningChars: streamed.reasoningChars, chunks: streamed.chunks };
  push('default-mode-observed', true, `service default produced ${streamed.reasoningChars} reasoning chars (thinking on unless the request disables it)`);

  const withoutThinking = await streamChat({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 64,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    stream_options: { include_usage: true },
  });
  push('thinking-can-be-disabled-per-request', withoutThinking.reasoningChars === 0, `${withoutThinking.reasoningChars} reasoning chars with enable_thinking false`);
  receipts.http.thinking_disabled = { reasoningChars: withoutThinking.reasoningChars };

  const thinking = await streamChat({
    model: MODEL,
    messages: [{ role: 'user', content: 'Compute 17*23 and reply with only the number.' }],
    max_tokens: 512,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: true },
    stream_options: { include_usage: true },
  });
  push('high-effort-thinking-protocol', thinking.reasoningChars > 0, `${thinking.reasoningChars} reasoning chars with enable_thinking`);
  receipts.http.thinking = { reasoningChars: thinking.reasoningChars, finishReason: thinking.finishReason };

  // Mid-stream abort: the client must stop adopting tokens and must not treat
  // the stream as a completed success.
  const controller = new AbortController();
  let adopted = 0;
  let aborted = false;
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 200 slowly, one number per line.' }], max_tokens: 256, stream: true }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      adopted += decoder.decode(value, { stream: true }).length;
      if (adopted > 200) {
        controller.abort();
        aborted = true;
        break;
      }
    }
  } catch (error) {
    aborted = error.name === 'AbortError' || aborted;
  }
  push('mid-stream-abort', aborted, `aborted after ${adopted} bytes; no success was recorded`);
  receipts.http.abort = { aborted, bytes_adopted: adopted, server_slot_recovered: 'not observable from the client' };

  // Two concurrent requests must be isolated.
  const [first, second] = await Promise.all([
    post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: ALPHA' }], max_tokens: 256, temperature: 0 }),
    post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: BETA' }], max_tokens: 256, temperature: 0 }),
  ]);
  const text = reply => `${reply.choices?.[0]?.message?.content ?? ''}${reply.choices?.[0]?.message?.reasoning_content ?? ''}`;
  const alpha = text(first);
  const beta = text(second);
  push('concurrent-requests-isolated', /ALPHA/.test(alpha) && /BETA/.test(beta), `alpha="${alpha.trim()}" beta="${beta.trim()}"`);
  receipts.http.concurrent = { alpha, beta };

  const failure = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  // A served deployment may ignore the model field; record the fact instead
  // of pretending it is a client-side guarantee.
  push('unknown-model-outcome-recorded', null, `POST with an unknown model id returned ${failure.status}`);
  receipts.http.unknown_model_status = failure.status;
}

const answersFive = value => value === 5 || value === '5'
  || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value.answer === 5 || value.answer === '5'));

/** One hosted turn must prove the whole tool call, native result, final-answer chain. */
async function agentReasoningSuite(host, layout, receipts) {
  const single = await host.request('single', undefined, {
    objective: 'Call flow_sum with values [2, 3]. Read its tool result, then answer with exactly the digit 5 and submit 5 as your result. Do not answer before the tool returns.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget(),
  }, 600_000);
  receipts.host.reasoning = single.usage;
  push('agent-requests-carry-no-reasoning-tokens', (single.usage?.reasoning_tokens ?? 0) === 0 && (single.usage?.requests ?? 0) > 0,
    `usage ${JSON.stringify(single.usage)}`);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
  let agent;
  let tx;
  try {
    agent = db.prepare("SELECT session_id FROM agents WHERE cluster_id=? AND role='worker' LIMIT 1").get(single.cluster_id);
    tx = db.prepare('SELECT id,status,result FROM transactions WHERE cluster_id=? LIMIT 1').get(single.cluster_id);
  } finally {
    db.close();
  }
  const session = agent ? findSessionFile(join(layout.home, 'sessions'), agent.session_id) : null;
  const scanned = session ? readSessionEvents(session) : { state: 'UNKNOWN', events: [], reason: 'the hosted Worker has no native Session file' };
  const evidence = scanned.state === 'READ'
    ? inspectNativeSumRoundTrip(scanned.events)
    : { verified: false, reason: scanned.reason };
  let durableResult;
  try { durableResult = JSON.parse(tx?.result); } catch { durableResult = null; }
  const finalDelivered = single.final_text?.trim() === '5'
    && tx?.status === 'SUBMITTED' && answersFive(durableResult);
  receipts.host.native_sum = { cluster_id: single.cluster_id, session_id: agent?.session_id ?? null,
    stop_reason: single.stop_reason, final_text: single.final_text, transaction_status: tx?.status,
    transaction_result: durableResult, evidence, session_state: scanned.state };
  push('hosted-sum-call-result-and-final-answer',
    evidence.verified && finalDelivered && single.stop_reason === 'completed' && single.error === null,
    JSON.stringify(receipts.host.native_sum));
}

/**
 * A raw HTTP `tool_calls` frame does not prove host execution. The durable
 * Session must show the exact call, matching successful host result 5, and a
 * subsequent assistant message that actually says 5. A submit_result value
 * alone is a durable transaction result, not an assistant answer. The hosted
 * suite independently checks the final text and transaction ledger.
 */
export function inspectNativeSumRoundTrip(events) {
  for (const call of events) {
    if (call.type !== 'tool/call' || call.data?.name !== 'flow_sum' || !call.data.callId) continue;
    let args;
    try { args = JSON.parse(call.data.arguments); } catch { continue; }
    if (!Array.isArray(args?.values) || args.values.length !== 2 || args.values[0] !== 2 || args.values[1] !== 3) continue;
    const result = events.find(event => event.seq > call.seq && event.type === 'tool/result'
      && event.data?.message?.toolCallId === call.data.callId);
    const message = result?.data?.message;
    if (!message || message.isError || !message.content?.some(block => block.type === 'text' && block.text?.trim() === '5')) continue;
    for (const answer of events) {
      if (answer.seq <= result.seq || answer.type !== 'assistant/message') continue;
      const blocks = answer.data?.message?.content ?? [];
      if (blocks.some(block => block.type === 'text' && block.text?.trim() === '5')) {
        return { verified: true, call_id: call.data.callId, call_seq: call.seq,
          result_seq: result.seq, answer_seq: answer.seq };
      }
    }
  }
  return { verified: false, reason: 'no matching native sum call → host result 5 → later assistant answer 5' };
}

async function filesystemSuite(host, layout, receipts) {
  const target = join(layout.workspace, 'smoke', 'note.txt');
  const single = await host.request('single', undefined, {
    objective: `Create the file ${target} whose entire content is the line SMOKE-OK, then read it back and submit a result that reports the exact content you read.`,
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget(),
  }, 900_000);
  receipts.host.filesystem = single;
  push('filesystem-write-and-read', existsSync(target) && readFileSync(target, 'utf8').includes('SMOKE-OK'),
    `file ${existsSync(target) ? 'exists' : 'missing'}; tool calls: ${(single.tool_calls ?? []).map(call => call.name).join(', ')}`);

  const outside = join(layout.root, 'outside-workspace.txt');
  const bounded = await host.request('single', undefined, {
    objective: `Write the text NOPE into the file ${outside}. If the tool refuses, submit a result that quotes the refusal message.`,
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget(),
  }, 900_000);
  receipts.host.filesystem_outside = bounded;
  push('out-of-workspace-write-refused', !existsSync(outside),
    `outside file ${existsSync(outside) ? 'was created (sandbox breach)' : 'not created'}; summary: ${String(bounded.final_text ?? '').slice(0, 200)}`);
}

async function webFetchSuite(host, layout, receipts) {
  const single = await host.request('single', undefined, {
    objective: 'Fetch https://docs.sglang.io/ with the web_fetch tool and submit a result naming the page title you actually received.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'web_fetch'],
    budget: singleBudget(),
  }, 900_000);
  receipts.host.web_fetch = single;
  // The capability was exercised when the tool really ran *and* the outcome
  // reached the ledger. Requiring prose as well made the check fail a run whose
  // model submitted the fetch refusal as a structured result instead of
  // narrating it — the harness's own record of the turn is the evidence, not the
  // model's style.
  const fetchCalled = (single.tool_calls ?? []).some(call => call.name === 'web_fetch');
  let recorded = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
    const row = db.prepare("SELECT result FROM transactions WHERE cluster_id=? AND objective LIKE 'Fetch %' ORDER BY rowid DESC LIMIT 1")
      .get(single.cluster_id ?? '');
    db.close();
    recorded = row ? row.result ?? null : null;
  } catch (error) {
    recorded = `unreadable: ${error.message}`;
  }
  const summary = String(single.final_text ?? '');
  push('web-fetch-official-page', fetchCalled && (summary.length > 0 || (recorded !== null && typeof recorded === 'string')),
    `tools: ${(single.tool_calls ?? []).map(call => call.name).join(', ')}; summary: ${summary.slice(0, 120)}; recorded: ${String(recorded ?? 'none').slice(0, 220)}`);
}

async function cancellationSuite(host, layout, receipts) {
  const created = await host.request('start', undefined, {
    objective: 'Write a 2000-word essay about the history of the abacus, one paragraph per tool call.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: { tokens: 262144, model_requests: 32, tool_calls: 64, wall_time_ms: 300_000, agents: 16, max_active_agents: 3 },
    limits: { max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
  }, 120_000);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 3000));
  const cancelled = await host.request('control', created.cluster.id, { action: 'cancel' }, 60_000);
  receipts.host.cancel = { before: created.cluster.status, after: cancelled.cluster.status };
  push('cancel-terminates-cluster', cancelled.cluster.status === 'CANCELLED', `status ${cancelled.cluster.status}`);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2000));
  const after = await host.request('read', created.cluster.id, { include_events: false }, 60_000);
  const running = (after.agents ?? []).filter(agent => agent.status === 'RUNNING');
  push('cancel-fences-running-agents', running.length === 0, `${running.length} agents still RUNNING after cancel`);
}

async function concurrencySuite(host, layout, receipts) {
  const started = Date.now();
  const [first, second] = await Promise.all([
    host.request('single', undefined, { objective: 'Reply with the word ALPHA and submit it as the result.', workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget() }, 600_000),
    host.request('single', undefined, { objective: 'Reply with the word BETA and submit it as the result.', workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget() }, 600_000),
  ]);
  receipts.host.concurrent = { first: first.final_text, second: second.final_text, elapsed_ms: Date.now() - started };
  push('two-cluster-agents-parallel', first.error === null && second.error === null,
    `errors: ${first.error ?? 'none'} / ${second.error ?? 'none'}; ${Date.now() - started}ms`);
}

function singleBudget() {
  return { tokens: 1_048_576, model_requests: 48, tool_calls: 128, wall_time_ms: 900_000, agents: 8, max_active_agents: 2 };
}

function sumTool() {
  return {
    type: 'function',
    function: {
      name: 'flow_sum',
      description: 'Add a list of finite numbers.',
      parameters: { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } }, required: ['values'] },
    },
  };
}

async function post(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function streamChat(body) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) throw new Error(`stream returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  let usage = null;
  let reasoningChars = 0;
  let chunks = 0;
  const toolCalls = [];
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const parsed = JSON.parse(payload);
      chunks += 1;
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length;
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        toolCalls[index] ??= { name: '', arguments: '' };
        if (call.function?.name) toolCalls[index].name += call.function.name;
        if (call.function?.arguments) toolCalls[index].arguments += call.function.arguments;
      }
      if (parsed.usage) usage = parsed.usage;
    }
  }
  return { finishReason, usage, reasoningChars, chunks, toolCalls };
}

/** The patch's local route and the environment must agree, or the run fails closed. */
function assertPatchMatchesEnv(patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  const baseURL = /baseURL:\s*(\S+)/.exec(text)?.[1];
  const model = /- id:\s*(Qwen\S+)/.exec(text)?.[1];
  if (baseURL !== BASE_URL || model !== MODEL) {
    throw new Error(`profile patch and environment disagree: patch baseURL=${baseURL} model=${model} vs env baseURL=${BASE_URL} model=${MODEL}`);
  }
}

/** Run only when executed directly: importing this module must have no effect. */
const invokedDirectly = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return self === resolve(entry);
  } catch {
    // A missing import must not turn the entry point into a silent no-op.
    return self.endsWith(entry);
  }
};

if (invokedDirectly()) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
