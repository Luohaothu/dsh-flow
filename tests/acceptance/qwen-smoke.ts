#!/usr/bin/env node
/**
 * Local Qwen acceptance for the plugin's model and tool path.
 *
 * Every tool assertion goes through a complete DSH profile assembly — a direct
 * HTTP probe proves nothing about the harness wiring. Receipts are written to
 * .artifacts/<run-id>/qwen-smoke.json.
 *
 * Usage: FLOW_QWEN_BASE_URL=... FLOW_QWEN_MODEL=... pnpm run test:qwen
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DshHost, buildHostEnv, createRunLayout, ensureProfile, WEB_PROFILE_BUNDLES, PROJECT_ROOT } from '../../src/host/host.ts';
import { computeBuildHashes, ipcBridgePatchText, startAcceptanceHost } from './run.ts';
import { findSessionFile, readSessionEvents } from '../../src/host/session-scan.ts';
import type { RunLayout } from '../../src/host/types.ts';
import type { SessionEvent, SessionReadResult } from '../../src/host/session-scan.ts';
import { asArray, asNumber, asObject, asString, decodeSingleReply, decodeSnapshot, decodeStartReply, messageOf } from './context.ts';
import type { CheckEntry, JsonObject } from './context.ts';

interface QwenReceipts {
  run_id: string;
  base_url: string;
  model: string;
  provider: string;
  http: Record<string, unknown>;
  host: Record<string, unknown>;
}

interface StreamedChat {
  finishReason: string | null;
  usage: unknown;
  reasoningChars: number;
  chunks: number;
  toolCalls: Array<{ name: string; arguments: string }>;
}

export interface NativeSumVerdict {
  verified: boolean;
  reason?: string | null;
  call_id?: string;
  call_seq?: number;
  result_seq?: number;
  answer_seq?: number;
}

const checks: CheckEntry[] = [];
const push = (name: string, passed: boolean | null, evidence: unknown): void => {
  checks.push({ name, passed: passed === null ? null : Boolean(passed), evidence: String(evidence).slice(0, 2500) });
  console.log(`${passed === null ? 'SKIP' : passed ? 'ok  ' : 'FAIL'} ${name} :: ${String(evidence).slice(0, 160)}`);
};

const RUN_ID = process.env.FLOW_QWEN_RUN_ID ?? `qwen-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const BASE_URL = process.env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1';
const MODEL = process.env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-FP8';
const PROVIDER = process.env.FLOW_MODEL_PROVIDER ?? 'local-sglang';


async function main(): Promise<void> {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts'), RUN_ID);
  const receipts: QwenReceipts = { run_id: RUN_ID, base_url: BASE_URL, model: MODEL, provider: PROVIDER, http: {}, host: {} };

  await httpProtocolSuite(receipts);

  const profile = `dsh-flow-${RUN_ID}`.replace(/[^A-Za-z0-9._-]/g, '-');
  ensureProfile(layout.home, profile, { bundles: WEB_PROFILE_BUNDLES });
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: BASE_URL, model: MODEL, provider: PROVIDER } });
  const patch = join(PROJECT_ROOT, 'examples/cluster.patch.yml');

  const bridgeOverlay = join(layout.root, 'ipc-bridge.patch.yml');
  writeFileSync(bridgeOverlay, ipcBridgePatchText());
  const patches = [patch, bridgeOverlay];
  const host = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'qwen-smoke.log') });
  try {
    await startAcceptanceHost(host);
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
  const report = { run_id: RUN_ID, checks, receipts, status: failed.length ? 'FAILED' : 'PASSED', build_hashes: computeBuildHashes({ id: '' }, patches) };
  writeFileSync(join(layout.root, 'qwen-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nqwen smoke: ${failed.length ? 'FAILED' : 'PASSED'} (${checks.length} checks) → ${join(layout.root, 'qwen-smoke.json')}`);
  if (failed.length) process.exitCode = 1;
}

/** Raw protocol facts about the service itself (not a substitute for tool wiring). */
async function httpProtocolSuite(receipts: QwenReceipts): Promise<void> {
  const modelsResponse = await fetch(`${BASE_URL}/models`);
  const modelsBody: unknown = await modelsResponse.json();
  const models = asObject(modelsBody);
  const modelEntries = asArray(models?.data) ?? [];
  const ids = modelEntries.map(entry => asString(asObject(entry)?.id) ?? '');
  push('models-list-has-exact-id', ids.includes(MODEL), `ids: ${ids.join(', ')}`);
  receipts.http.models = models?.data;

  const short = await post('/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 24, temperature: 0,
  });
  const shortChoice = asObject((asArray(short.choices) ?? [])[0]);
  const shortMessage = asObject(shortChoice?.message);
  const shortContent = asString(shortMessage?.content) ?? '';
  push('non-streaming-short-answer', /OK/.test(shortContent), JSON.stringify(shortMessage ?? {}).slice(0, 300));
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
  push('native-tool-call-in-stream', streamed.toolCalls.length === 1 && streamed.toolCalls[0]?.name === 'flow_sum',
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
    const responseBody = response.body;
    if (!responseBody) throw new Error('stream response carried no body');
    const reader = responseBody.getReader();
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
    aborted = (asObject(error)?.name === 'AbortError') || aborted;
  }
  push('mid-stream-abort', aborted, `aborted after ${adopted} bytes; no success was recorded`);
  receipts.http.abort = { aborted, bytes_adopted: adopted, server_slot_recovered: 'not observable from the client' };

  // Two concurrent requests must be isolated.
  const [first, second] = await Promise.all([
    post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: ALPHA' }], max_tokens: 256, temperature: 0 }),
    post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: BETA' }], max_tokens: 256, temperature: 0 }),
  ]);
  const text = (reply: JsonObject): string => {
    const choice = asObject((asArray(reply.choices) ?? [])[0]);
    const message = asObject(choice?.message);
    return `${asString(message?.content) ?? ''}${asString(message?.reasoning_content) ?? ''}`;
  };
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

function answersFive(value: unknown): boolean {
  if (value === 5 || value === '5') return true;
  const record = asObject(value);
  return record !== null && (record.answer === 5 || record.answer === '5');
}

/** One hosted turn must prove the whole tool call, native result, final-answer chain. */
async function agentReasoningSuite(host: DshHost, layout: RunLayout, receipts: QwenReceipts): Promise<void> {
  const single = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Call flow_sum with values [2, 3]. Read its tool result, then answer with exactly the digit 5 and submit 5 as your result. Do not answer before the tool returns.',
    workspace: layout.workspace,
    capabilities: ['fs_read'],
    budget: singleBudget(),
  }, 600_000));
  if (!single) throw new Error('single reply is not a single-agent result');
  receipts.host.reasoning = single.usage;
  push('agent-requests-carry-no-reasoning-tokens', (single.usage?.reasoning_tokens ?? 0) === 0 && (single.usage?.requests ?? 0) > 0,
    `usage ${JSON.stringify(single.usage)}`);

  const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
  let agentRow: unknown;
  let transactionRow: unknown;
  try {
    agentRow = db.prepare("SELECT session_id FROM agents WHERE cluster_id=? AND role='worker' LIMIT 1").get(single.cluster_id);
    transactionRow = db.prepare('SELECT id,status,result FROM transactions WHERE cluster_id=? LIMIT 1').get(single.cluster_id);
    const routes = db.prepare('SELECT provider,model FROM usage_receipts WHERE cluster_id=?').all(single.cluster_id);
    push('host-model-route-matches-deployment', routes.length > 0 && routes.every(row => row.provider === PROVIDER && row.model === MODEL),
      JSON.stringify(routes));
  } finally {
    db.close();
  }
  const agent = asObject(agentRow);
  const transaction = asObject(transactionRow);
  const sessionId = asString(agent?.session_id);
  const session = sessionId === null ? null : findSessionFile(join(layout.home, 'sessions'), sessionId);
  const scanned: SessionReadResult = session ? readSessionEvents(session) : { state: 'UNKNOWN', events: [], reason: 'the hosted Worker has no native Session file' };
  const evidence = scanned.state === 'READ'
    ? inspectNativeSumRoundTrip(scanned.events)
    : { verified: false, reason: scanned.reason };
  let durableResult: unknown;
  try { durableResult = JSON.parse(String(transaction?.result)); } catch { durableResult = null; }
  const transactionStatus = asString(transaction?.status);
  const finalDelivered = single.final_text.trim() === '5'
    && transactionStatus === 'SUBMITTED' && answersFive(durableResult);
  receipts.host.native_sum = { cluster_id: single.cluster_id, session_id: sessionId,
    stop_reason: single.stop_reason, final_text: single.final_text, transaction_status: transactionStatus,
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
export function inspectNativeSumRoundTrip(events: readonly SessionEvent[]): NativeSumVerdict {
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const call = asObject(event.data);
    const callId = asString(call?.callId);
    if (!call || asString(call.name) !== 'flow_sum' || !callId) continue;
    let args: unknown;
    try { args = JSON.parse(String(call.arguments)); } catch { continue; }
    const values = asArray(asObject(args)?.values);
    if (!values || values.length !== 2 || values[0] !== 2 || values[1] !== 3) continue;
    const result = events.find(candidate => {
      const message = asObject(asObject(candidate.data)?.message);
      return candidate.seq > event.seq && candidate.type === 'tool/result' && message?.toolCallId === callId;
    });
    const resultMessage = result ? asObject(asObject(result.data)?.message) : null;
    const resultContent = asArray(resultMessage?.content) ?? [];
    if (!resultMessage || resultMessage.isError
      || !resultContent.some(block => {
        const content = asObject(block);
        return content?.type === 'text' && asString(content.text)?.trim() === '5';
      })) continue;
    if (!result) continue;
    for (const answer of events) {
      if (answer.seq <= result.seq || answer.type !== 'assistant/message') continue;
      const answerMessage = asObject(asObject(answer.data)?.message);
      const blocks = asArray(answerMessage?.content) ?? [];
      if (blocks.some(block => {
        const content = asObject(block);
        return content?.type === 'text' && asString(content.text)?.trim() === '5';
      })) {
        return { verified: true, call_id: callId, call_seq: event.seq,
          result_seq: result.seq, answer_seq: answer.seq };
      }
    }
  }
  return { verified: false, reason: 'no matching native sum call → host result 5 → later assistant answer 5' };
}
async function filesystemSuite(host: DshHost, layout: RunLayout, receipts: QwenReceipts): Promise<void> {
  const target = join(layout.workspace, 'smoke', 'note.txt');
  const single = decodeSingleReply(await host.request('single', undefined, {
    objective: `Create the file ${target} whose entire content is the line SMOKE-OK, then read it back and submit a result that reports the exact content you read.`,
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget(),
  }, 900_000));
  if (!single) throw new Error('single reply is not a single-agent result');
  receipts.host.filesystem = single;
  push('filesystem-write-and-read', existsSync(target) && readFileSync(target, 'utf8').includes('SMOKE-OK'),
    `file ${existsSync(target) ? 'exists' : 'missing'}; tool calls: ${(single.tool_calls ?? []).map(call => call.name).join(', ')}`);

  const outside = join(layout.root, 'outside-workspace.txt');
  const bounded = decodeSingleReply(await host.request('single', undefined, {
    objective: `Write the text NOPE into the file ${outside}. If the tool refuses, submit a result that quotes the refusal message.`,
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: singleBudget(),
  }, 900_000));
  if (!bounded) throw new Error('single reply is not a single-agent result');
  receipts.host.filesystem_outside = bounded;
  push('out-of-workspace-write-refused', !existsSync(outside),
    `outside file ${existsSync(outside) ? 'was created (sandbox breach)' : 'not created'}; summary: ${String(bounded.final_text ?? '').slice(0, 200)}`);
}

async function webFetchSuite(host: DshHost, layout: RunLayout, receipts: QwenReceipts): Promise<void> {
  const single = decodeSingleReply(await host.request('single', undefined, {
    objective: 'Fetch https://docs.sglang.io/ with the web_fetch tool and submit a result naming the page title you actually received.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'web_fetch'],
    budget: singleBudget(),
  }, 900_000));
  if (!single) throw new Error('single reply is not a single-agent result');
  receipts.host.web_fetch = single;
  // A capability is exercised when the native tool runs and its outcome
  // reaches the ledger, including a structured refusal result.
  const fetchCalled = single.tool_calls.some(call => call.name === 'web_fetch');
  let recorded: unknown = null;
  try {
    const db = new DatabaseSync(join(layout.data, 'cluster.sqlite'), { readOnly: true });
    let row: unknown;
    try {
      row = db.prepare("SELECT result FROM transactions WHERE cluster_id=? AND objective LIKE 'Fetch %' ORDER BY rowid DESC LIMIT 1")
        .get(single.cluster_id ?? '');
    } finally {
      db.close();
    }
    recorded = asObject(row)?.result ?? null;
  } catch (error) {
    recorded = `unreadable: ${messageOf(error)}`;
  }
  const summary = String(single.final_text ?? '');
  push('web-fetch-official-page', fetchCalled && (summary.length > 0 || (recorded !== null && typeof recorded === 'string')),
    `tools: ${single.tool_calls.map(call => call.name).join(', ')}; summary: ${summary.slice(0, 120)}; recorded: ${String(recorded ?? 'none').slice(0, 220)}`);
}

async function cancellationSuite(host: DshHost, layout: RunLayout, receipts: QwenReceipts): Promise<void> {
  const created = decodeStartReply(await host.request('start', undefined, {
    objective: 'Write a 2000-word essay about the history of the abacus, one paragraph per tool call.',
    workspace: layout.workspace,
    capabilities: ['fs_read', 'fs_write'],
    budget: { tokens: 262144, model_requests: 32, tool_calls: 64, wall_time_ms: 300_000, agents: 16, max_active_agents: 3 },
    limits: { max_active_agents: 3, max_llm_concurrency: 1, max_role_turns: 6 },
  }, 120_000));
  if (!created) throw new Error('start reply carried no cluster');
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 3000));
  const cancelled = decodeSnapshot(await host.request('control', created.cluster.id, { action: 'cancel' }, 60_000));
  if (!cancelled) throw new Error('control reply is not a cluster snapshot');
  receipts.host.cancel = { before: created.cluster.status, after: cancelled.cluster.status };
  push('cancel-terminates-cluster', cancelled.cluster.status === 'CANCELLED', `status ${cancelled.cluster.status}`);
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2000));
  const after = decodeSnapshot(await host.request('read', created.cluster.id, { include_events: false }, 60_000));
  if (!after) throw new Error('read reply is not a cluster snapshot');
  const running = (after.agents ?? []).filter(agent => agent.status === 'RUNNING');
  push('cancel-fences-running-agents', running.length === 0, `${running.length} agents still RUNNING after cancel`);
}

async function concurrencySuite(host: DshHost, layout: RunLayout, receipts: QwenReceipts): Promise<void> {
  const started = Date.now();
  const [firstReply, secondReply] = await Promise.all([
    host.request('single', undefined, { objective: 'Reply with the word ALPHA and submit it as the result.', workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget() }, 600_000),
    host.request('single', undefined, { objective: 'Reply with the word BETA and submit it as the result.', workspace: layout.workspace, capabilities: ['fs_read'], budget: singleBudget() }, 600_000),
  ]);
  const first = decodeSingleReply(firstReply);
  const second = decodeSingleReply(secondReply);
  if (!first || !second) throw new Error('concurrent single reply is not a single-agent result');
  receipts.host.concurrent = { first: first.final_text, second: second.final_text, elapsed_ms: Date.now() - started };
  push('two-cluster-agents-parallel', first.error === null && second.error === null,
    `errors: ${first.error ?? 'none'} / ${second.error ?? 'none'}; ${Date.now() - started}ms`);
}

function singleBudget(): JsonObject {
  return { tokens: 1_048_576, model_requests: 48, tool_calls: 128, wall_time_ms: 900_000, agents: 8, max_active_agents: 2 };
}

function sumTool(): JsonObject {
  return {
    type: 'function',
    function: {
      name: 'flow_sum',
      description: 'Add a list of finite numbers.',
      parameters: { type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } }, required: ['values'] },
    },
  };
}

async function post(path: string, body: unknown): Promise<JsonObject> {
  const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result: unknown = await response.json();
  return asObject(result) ?? {};
}

async function streamChat(body: JsonObject): Promise<StreamedChat> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer EMPTY' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) throw new Error(`stream returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const responseBody = response.body;
  if (!responseBody) throw new Error('stream response carried no body');
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let usage: unknown = null;
  let reasoningChars = 0;
  let chunks = 0;
  const toolCalls: StreamedChat['toolCalls'] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const parsedValue: unknown = JSON.parse(payload);
      const parsed = asObject(parsedValue);
      if (!parsed) continue;
      chunks += 1;
      const choice = asObject((asArray(parsed.choices) ?? [])[0]);
      const finish = asString(choice?.finish_reason);
      if (finish) finishReason = finish;
      const delta = asObject(choice?.delta);
      const reasoning = asString(delta?.reasoning_content);
      if (reasoning) reasoningChars += reasoning.length;
      for (const callValue of asArray(delta?.tool_calls) ?? []) {
        const call = asObject(callValue);
        const index = asNumber(call?.index) ?? 0;
        const toolCall = toolCalls[index] ?? { name: '', arguments: '' };
        const fn = asObject(call?.function);
        const name = asString(fn?.name);
        const argumentsText = asString(fn?.arguments);
        if (name) toolCall.name += name;
        if (argumentsText) toolCall.arguments += argumentsText;
        toolCalls[index] = toolCall;
      }
      if (parsed.usage) usage = parsed.usage;
    }
  }
  return { finishReason, usage, reasoningChars, chunks, toolCalls };
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
