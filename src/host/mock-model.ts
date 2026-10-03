/**
 * Deterministic local model endpoint for the acceptance suite.
 *
 * The plugin under test is driven through a *real* DSH host and a *real* agent
 * loop; only the model's own generation is replaced. This module is that
 * replacement: an OpenAI-compatible chat-completions server on loopback that
 * answers every request from a scripted scenario instead of a model, so a
 * failure can only come from the plugin, the host, or the fixture.
 *
 * Wire facts this server must honour (read from the installed provider, not
 * assumed):
 *   * the harness `llm-pi-ai` `openai-completions` route always streams
 *     (`stream: true`), so a plain JSON body would yield an empty stream and
 *     the provider would throw "Stream ended without finish_reason";
 *   * a stream must carry a chunk with `finish_reason` and a final chunk with
 *     `usage` before `data: [DONE]`;
 *   * `tool_calls` deltas are keyed by `index`, with the call `id` and
 *     `function.name` announced once and `function.arguments` concatenated
 *     across chunks as a JSON string;
 *   * no header identifies the session or the request purpose, so a request is
 *     classified from its own messages.
 *
 * Everything the server records is a *test input*: usage numbers prove how the
 * plugin accounts, never what a real model cost.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const DONE_FRAME = 'data: [DONE]\n\n';

/** The exact substrings that identify a request, taken from the harness. */
export const ROLE_LINE = /^Role: ([\w-]+)\. Node: (\S+) \(depth (\d+)\)\. Agent id: (\S+)\.$/mu;
export const WORKER_HEADER = 'You are a Worker in a hierarchical agent cluster.';
export const COMPACTION_MARKER = 'You are now acting as a compaction engine';
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint';
export const DIGEST_MARKER = 'Current domain state (read anything else with flow_query';
/**
 * The fixture carries the plugin's own domain digest inside its checkpoint, so
 * a turn that was compacted mid-flight can still be answered from the state it
 * was acting on. It is a fixture-owned line, never a plugin promise.
 */
export const DIGEST_LINE_MARKER = 'dsh-flow-domain-digest: ';

/**
 * A decoded domain digest, as the fixture reads it: a JSON object published by
 * the plugin. Fields are read defensively through {@link asRecord} and friends,
 * because the fixture must not guess a shape the plugin owns.
 */
export type MockDigest = Record<string, unknown>;

/** The identity a request addresses, read back out of its own messages. */
export interface MockRequestIdentity {
  role: string | null;
  nodeId: string | null;
  depth: number | null;
  agentId: string | null;
  transactionId: string | null;
  objective: string | null;
  workerPrompt: boolean;
  digest: MockDigest | null;
}

/** The facts one provider request carries, before any script answers it. */
export interface MockRequestClassificationFields {
  compaction: boolean;
  checkpoint_continuation: boolean;
  digest_source: 'prompt' | 'checkpoint' | 'older' | null;
  fresh_digest: boolean;
  last_message_role: string | null;
  role: string | null;
  nodeId: string | null;
  depth: number | null;
  agentId: string | null;
  transactionId: string | null;
  objective: string | null;
  identity: MockRequestIdentity;
  digest: MockDigest | null;
  lastToolResult: string | null;
  lastToolName: string | null;
  toolNames: string[];
  userText: string;
  messageCount: number;
}

/** One classified request, discriminated by the kind of prompt it carried. */
export type MockRequestClassification =
  | (MockRequestClassificationFields & { kind: 'compaction' })
  | (MockRequestClassificationFields & { kind: 'role' })
  | (MockRequestClassificationFields & { kind: 'worker' })
  | (MockRequestClassificationFields & { kind: 'unknown' });

/** One scripted tool call in an assistant turn. */
export interface MockToolCallSpec {
  name: string;
  arguments?: unknown;
  id?: string;
}

/** The usage numbers a scripted answer reports. */
export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

/** A declared failure a case asked for, as opposed to a fixture defect. */
export interface MockScenarioFail {
  status?: number;
  message?: string;
}

/** One scripted model answer. */
export interface MockScenarioReply {
  text?: string;
  toolCalls?: MockToolCallSpec[];
  finishReason?: string;
  usage?: MockUsage | null;
  chunkBoundaries?: number[] | null;
  fail?: MockScenarioFail;
  abort?: boolean;
  hold?: string;
}

/** A scenario's own record of what it observed, when it keeps one. */
export interface MockScenarioFinish {
  requests?: number;
  compaction_requests?: number;
  role_requests?: Record<string, number>;
  worker_requests?: Record<string, number>;
  digest_missing?: number;
  checks?: unknown[];
  problems?: string[];
  fixture_evidence?: unknown;
}

/** One scripted answerer: one scenario drives one case. */
export interface MockScenario {
  name?: string;
  respond(entry: MockRequestRecord): MockScenarioReply | null | Promise<MockScenarioReply | null>;
  finish?(): MockScenarioFinish | null | undefined;
}

/** The request shape the wire carried, recorded for evidence. */
export interface MockRequestShape {
  stream_options: unknown;
  max_tokens_field: 'max_completion_tokens' | 'max_tokens' | null;
}

/** The answer this fixture actually sent for one request. */
export interface MockResponseRecord {
  finish_reason: string;
  text: string;
  tool_calls: Array<{ name: string; arguments: unknown }>;
  usage: MockUsage | null;
  chunk_boundaries: number[] | null;
}

/** A declared failure, recorded on the request it answered. */
export interface MockDeclaredFailure {
  status: number | null;
  message: string;
}

/** Everything the fixture recorded about one provider request. */
export interface MockRequestRecord {
  seq: number;
  at: number;
  model: unknown;
  stream: unknown;
  messageCount: number;
  kind: string;
  role: string | null;
  node_id: string | null;
  depth: number | null;
  agent_id: string | null;
  transaction_id: string | null;
  tools: string[];
  authorized: boolean;
  request_shape: MockRequestShape;
  body: unknown;
  classified: MockRequestClassification;
  barrier: string | null;
  held: boolean;
  opened_at?: number;
  closed_at?: number;
  disconnected?: boolean;
  diagnostic?: boolean;
  declared_failure?: MockDeclaredFailure;
  response?: MockResponseRecord;
}

/** A predicate over the requests recorded so far. */
export type MockRequestPredicate = (entry: MockRequestRecord, requests: readonly MockRequestRecord[]) => boolean;

/** One request kept open on a named barrier. */
interface MockHolder {
  barrier: string;
  entry: MockRequestRecord;
  resolve(reply?: MockScenarioReply): void;
}

/** One runner waiting for a matching request. */
interface MockWaiter {
  predicate: MockRequestPredicate;
  resolve(entry: MockRequestRecord): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

/** One SSE response, written in stages so a held request never goes idle. */
export interface MockStream {
  open(): void;
  startKeepAlive(everyMs?: number): void;
  stopKeepAlive(): void;
  end(): void;
  finish(reply: MockScenarioReply | null, entry: MockRequestRecord): void;
}

/** How to start the scripted endpoint. */
export interface StartMockModelOptions {
  scenario?: MockScenario | null;
  host?: string;
  modelId?: string;
  now?: () => number;
}

/** The fixture completeness summary reported at teardown. */
export interface MockFixtureSummary {
  requests: number;
  scenario: string | null;
  checks: unknown[];
  fixture_evidence?: unknown;
}

/** The running endpoint and the concurrency/completeness APIs the runner uses. */
export interface MockModelHandle {
  readonly baseURL: string;
  readonly modelId: string;
  readonly requests: MockRequestRecord[];
  readonly errors: string[];
  readonly scenarioName: string | null;
  /** Bind the script before the cluster starts. A second bind is a fixture bug. */
  setScenario(next: MockScenario | null): MockScenario | null;
  /** Resolve once a recorded request matches. Times out loudly, never silently. */
  waitForRequest(predicate: MockRequestPredicate, options?: { timeoutMs?: number }): Promise<MockRequestRecord>;
  /** Release every request held on one barrier; returns how many were waiting. */
  release(barrier: string): number;
  heldBarriers(): string[];
  /** How many requests are held on one barrier right now. */
  heldCount(barrier?: string | null): number;
  /** Resolve once at least `count` requests are held at the same time. */
  waitUntilHeld(count: number, options?: { barrier?: string | null; timeoutMs?: number }): Promise<number>;
  peakConcurrency(): number | null;
  assertComplete(): MockFixtureSummary;
  close(): Promise<void>;
}

/** A decoded chat message from a provider request body. */
export type MockChatMessage = Record<string, unknown>;

/** A checked, non-null object view of an unknown JSON value. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  // `typeof value === 'object'` and the array check prove the runtime shape; the
  // record view exposes every member as `unknown`, so fields still get narrowed.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The members of an unknown JSON array, or none when it is not an array. */
export function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

/** The object members of an unknown JSON array, dropping anything else. */
export function recordsOf(value: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const item of listOf(value)) {
    const record = asRecord(item);
    if (record) records.push(record);
  }
  return records;
}

/** A value's text form, or null when it is not a string. */
export function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A non-null, finite number, or null. */
export function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The text of one message's `content`, string or content-part array alike. */
function messageText(message: MockChatMessage | null | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(partText).join('\n');
}

/** The text of one content part. */
function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  return textOf(asRecord(part)?.text) ?? '';
}

/**
 * The identity a request addresses, read from *every* user/system message and
 * not only the newest one.
 *
 * A native compaction replaces the shadowed span — including the original
 * prompt — with the checkpoint, so the continuation request carries no role
 * line of its own. The identity therefore has to survive inside the checkpoint
 * text this fixture returns, and this scan is what reads it back. The newest
 * answer for each field wins, so a re-prompted identity overrides a stale one.
 */
export function identityOf(messages: readonly MockChatMessage[]): MockRequestIdentity {
  const identity: MockRequestIdentity = { role: null, nodeId: null, depth: null, agentId: null, transactionId: null, objective: null, workerPrompt: false, digest: null };
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'system') continue;
    const text = messageText(message);
    const roleMatch = ROLE_LINE.exec(text);
    if (roleMatch) {
      identity.role = roleMatch[1] ?? null;
      identity.nodeId = roleMatch[2] ?? null;
      identity.depth = Number(roleMatch[3] ?? 0);
      identity.agentId = roleMatch[4] ?? null;
    }
    const transactionMatch = /\bTransaction id: (\S+)/u.exec(text);
    if (transactionMatch) identity.transactionId = transactionMatch[1] ?? null;
    const objectiveMatch = /\bObjective: (.*)/u.exec(text);
    if (objectiveMatch) identity.objective = objectiveMatch[1]?.trim() ?? null;
    if (text.startsWith(WORKER_HEADER)) identity.workerPrompt = true;
    // Both spellings: the plugin's own prompt marker and the line this fixture
    // preserves through a checkpoint. The newest one in the conversation wins.
    const carried = digestIn(text);
    if (carried) identity.digest = carried;
  }
  return identity;
}

/** The domain digest a message carries, from either the prompt or a checkpoint. */
function digestIn(text: unknown): MockDigest | null {
  const source = String(text ?? '');
  const markerIndex = source.indexOf(DIGEST_MARKER);
  if (markerIndex >= 0) {
    const after = source.slice(markerIndex);
    const start = after.indexOf('\n');
    if (start >= 0) {
      const line = after.slice(start + 1).split('\n')[0]?.trim() ?? '';
      const parsed = parseJson(line);
      if (parsed !== null) return parsed;
    }
  }
  const digestIndex = source.lastIndexOf(DIGEST_LINE_MARKER);
  if (digestIndex >= 0) {
    const line = source.slice(digestIndex + DIGEST_LINE_MARKER.length).split('\n')[0]?.trim() ?? '';
    const parsed = parseJson(line);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Parse one JSON line into a checked object, or null when it is not one. */
function parseJson(text: string): MockDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return asRecord(parsed);
}

/**
 * Classify one provider request from its messages alone. This is the only
 * signal the wire carries: the route adds no session or purpose header.
 */
export function classifyRequest(body: unknown): MockRequestClassification {
  const record = asRecord(body);
  const messages = recordsOf(record?.messages);
  const users = messages.filter(message => message.role === 'user');
  const lastUser = users[users.length - 1] ?? null;
  const lastUserText = messageText(lastUser);
  const identity = identityOf(messages);
  const roleMessage = [...users].reverse().find(message => ROLE_LINE.test(messageText(message)));
  const workerMessage = [...users].reverse().find(message => messageText(message).startsWith(WORKER_HEADER));
  const compaction = lastUserText.includes(COMPACTION_MARKER);
  const checkpointContinuation = lastUserText.includes(CHECKPOINT_PREAMBLE);
  const text = roleMessage ? messageText(roleMessage) : workerMessage ? messageText(workerMessage) : lastUserText;
  const toolMessages = messages.filter(message => message.role === 'tool');
  const lastMessageRole = messages.length ? textOf(messages[messages.length - 1]?.role) : null;
  // The digest is read from the *last user message*: either the plugin's own
  // role prompt, or the checkpoint a native compaction put in its place. Both
  // are the state the turn is acting on. A digest that only an older message
  // carries is not used to choose an action — the step then ends the turn and
  // the scheduler re-prompts with current state.
  const digestFromLastUser = digestIn(lastUserText);
  const digest = digestFromLastUser ?? identity.digest;
  return {
    kind: compaction ? 'compaction' : identity.role ? 'role' : identity.workerPrompt || identity.transactionId ? 'worker' : 'unknown',
    compaction,
    checkpoint_continuation: checkpointContinuation,
    digest_source: digestFromLastUser ? (lastUserText.includes(DIGEST_MARKER) ? 'prompt' : 'checkpoint') : identity.digest ? 'older' : null,
    fresh_digest: digestFromLastUser !== null && lastMessageRole === 'user',
    last_message_role: lastMessageRole,
    role: identity.role,
    nodeId: identity.nodeId,
    depth: identity.depth,
    agentId: identity.agentId,
    transactionId: identity.transactionId,
    objective: identity.objective,
    identity,
    digest,
    // The *newest* tool result, so a scripted step can read what the host
    // really returned instead of assuming its own request took effect.
    lastToolResult: toolMessages.length ? messageText(toolMessages[toolMessages.length - 1]) : null,
    lastToolName: lastToolNameOf(messages),
    toolNames: recordsOf(record?.tools)
      .map(tool => textOf(asRecord(tool.function)?.name))
      .filter((name): name is string => name !== null),
    userText: text,
    messageCount: messages.length,
  };
}

/** The newest assistant tool call's function name, or null when none was made. */
function lastToolNameOf(messages: readonly MockChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const calls = listOf(message.tool_calls);
    if (!calls.length) continue;
    const lastCall = asRecord(calls[calls.length - 1]);
    return textOf(asRecord(lastCall?.function)?.name);
  }
  return null;
}

/**
 * One scripted model endpoint. A scenario is bound before the cluster starts;
 * an unbound request is a fixture error, never a default "OK" answer.
 */
export async function startMockModel({ scenario = null, host = '127.0.0.1', modelId = 'mock-model', now = Date.now }: StartMockModelOptions = {}): Promise<MockModelHandle> {
  const requests: MockRequestRecord[] = [];
  const holders: MockHolder[] = [];
  const waiters: MockWaiter[] = [];
  const sockets = new Set<Socket>();
  let current: MockScenario | null = scenario;
  let closed = false;
  const errors: string[] = [];
  let sequence = 0;

  function record(entry: MockRequestRecord): void {
    requests.push(entry);
    settleWaiters(entry);
  }

  function settleWaiters(entry: MockRequestRecord): void {
    for (const waiter of [...waiters]) {
      let matched = false;
      try {
        matched = Boolean(waiter.predicate(entry, requests));
      } catch (error) {
        waiter.reject(error);
        waiters.splice(waiters.indexOf(waiter), 1);
        continue;
      }
      if (matched) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
    }
  }

  function noteError(message: string): void {
    errors.push(message);
  }

  /** How many requests are held on one barrier right now (null = any barrier). */
  const countHeld = (barrier: string | null = null): number =>
    barrier === null ? holders.length : holders.filter(holder => holder.barrier === barrier).length;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((error: unknown) => {
        // A client that walked away mid-stream is the *tested* fault (a cluster
        // cancelled under a live turn), not a fixture defect.
        if (isDisconnect(error)) return;
        noteError(`mock server error: ${messageOf(error)}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: messageOf(error) } }));
      });
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // Node closes an idle keep-alive socket after 5s by default. A provider
  // client that reuses that connection later sees ECONNRESET — a *transport*
  // failure the plugin would rightly report, produced by the fixture rather
  // than by anything under test.
  server.keepAliveTimeout = 900_000;
  server.headersTimeout = 960_000;
  server.requestTimeout = 0;

  async function handle(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'acceptance-mock' }] }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock model has no route ${req.method} ${url.pathname}` } }));
      return;
    }
    let body: MockChatMessage;
    try {
      const parsed: unknown = JSON.parse(rawBody || '{}');
      body = asRecord(parsed) ?? {};
    } catch (error) {
      noteError(`mock model received a body it cannot parse: ${messageOf(error)}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
      return;
    }
    if (!current) {
      noteError('the mock model received a request before a scenario was bound');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no mock scenario is bound' } }));
      return;
    }
    const bound = current;

    sequence += 1;
    const classified = classifyRequest(body);
    const entry: MockRequestRecord = {
      seq: sequence,
      at: now(),
      model: body.model ?? null,
      stream: body.stream ?? null,
      messageCount: classified.messageCount,
      kind: classified.kind,
      role: classified.role,
      node_id: classified.nodeId,
      depth: classified.depth,
      agent_id: classified.agentId,
      transaction_id: classified.transactionId,
      tools: classified.toolNames,
      // The credential is never stored; only the fact that one was presented.
      authorized: Boolean(req.headers.authorization) || Boolean(req.headers['api-key']),
      request_shape: { stream_options: body.stream_options ?? null, max_tokens_field: body.max_completion_tokens !== undefined ? 'max_completion_tokens' : body.max_tokens !== undefined ? 'max_tokens' : null },
      body,
      classified,
      barrier: null,
      held: false,
    };
    record(entry);

    let stream: MockStream | null = null;
    // Registered before the script runs: a response closed early would otherwise
    // never record its end, and every such request would look like a live
    // interval, inflating any concurrency measured from these records.
    res.on('close', () => {
      entry.closed_at = entry.closed_at ?? Date.now();
      if (res.writableEnded) return;
      entry.disconnected = true;
      // A held request whose client left is released immediately: the runner's
      // barrier is about controlling *when* the cluster may continue, not about
      // keeping a dead socket open.
      for (const holder of holders.filter(candidate => candidate.entry === entry)) holder.resolve();
      stream?.stopKeepAlive();
    });

    let reply: MockScenarioReply | null;
    try {
      reply = await bound.respond(entry);
    } catch (error) {
      noteError(`scenario ${bound.name ?? 'unnamed'} failed on request ${entry.seq}: ${messageOf(error)}`);
      entry.diagnostic = true;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: messageOf(error) } }));
      return;
    }

    stream = openStream(res, { model: body.model ?? modelId, seq: sequence, now });
    entry.opened_at = Date.now();

    // A *declared* failure is a stimulus the case asked for, not a fixture
    // defect: it is recorded on the entry and never as a scenario error.
    if (reply?.fail) {
      const status = reply.fail.status ?? 500;
      entry.declared_failure = { status, message: reply.fail.message ?? 'declared failure' };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: entry.declared_failure.message } }));
      return;
    }
    if (reply?.abort) {
      // The stream ends after a first frame and without `finish_reason`, which
      // the provider surfaces as a transport failure — exactly the fault this
      // stimulus exists to produce.
      entry.declared_failure = { status: null, message: 'stream aborted before finish_reason' };
      stream.open();
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-mock-${sequence}`, object: 'chat.completion.chunk', created: Math.floor(now() / 1000),
        model: body.model ?? modelId, choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }],
      })}\n\n`);
      res.destroy();
      return;
    }

    entry.response = {
      finish_reason: reply?.finishReason ?? (reply?.toolCalls?.length ? 'tool_calls' : 'stop'),
      text: reply?.text ?? '',
      tool_calls: (reply?.toolCalls ?? []).map(call => ({ name: call.name, arguments: call.arguments })),
      usage: reply?.usage ?? null,
      chunk_boundaries: reply?.chunkBoundaries ?? null,
    };

    if (reply?.hold) {
      const barrier = String(reply.hold);
      entry.barrier = barrier;
      entry.held = true;
      // A runner waiting for "a request held on this barrier" must be woken
      // *now*: at `record` time the hold had not been decided yet.
      settleWaiters(entry);
      // The request is answered *after* the runner releases the barrier. SSE
      // comment frames keep the provider's idle watchdog fed in the meantime, so
      // a held request is a slow model, not a dead connection.
      stream.open();
      stream.startKeepAlive();
      const holder: MockHolder = { barrier, entry, resolve: () => {} };
      await new Promise<MockScenarioReply | undefined>(resolvePromise => {
        holder.resolve = resolvePromise;
        holders.push(holder);
      });
      const index = holders.indexOf(holder);
      if (index >= 0) holders.splice(index, 1);
      stream.stopKeepAlive();
      entry.held = false;
    }
    if (entry.disconnected) {
      stream.end();
      return;
    }
    try {
      stream.finish(reply, entry);
    } catch (error) {
      if (!isDisconnect(error)) throw error;
      entry.disconnected = true;
    }
  }

  await new Promise<void>(resolvePromise => server.listen(0, host, () => resolvePromise()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock model server did not bind a TCP port');
  const baseURL = `http://${host}:${address.port}/v1`;

  return {
    baseURL,
    modelId,
    get requests() {
      return requests;
    },
    get errors() {
      return errors;
    },
    get scenarioName() {
      return current?.name ?? null;
    },
    /** Bind the script before the cluster starts. A second bind is a fixture bug. */
    setScenario(next) {
      if (current && next && current !== next) noteError(`scenario rebound from ${current.name ?? 'unnamed'} to ${next.name ?? 'unnamed'} mid-run`);
      current = next;
      return next;
    },
    /** Resolve once a recorded request matches. Times out loudly, never silently. */
    waitForRequest(predicate, { timeoutMs = 60_000 } = {}) {
      const existing = requests.find(entry => predicate(entry, requests));
      if (existing) return Promise.resolve(existing);
      return new Promise<MockRequestRecord>((resolvePromise, rejectPromise) => {
        const waiter: MockWaiter = {
          predicate,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            rejectPromise(new Error(`mock model: no request matched within ${timeoutMs}ms (${requests.length} recorded)`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    /** Release every request held on one barrier; returns how many were waiting. */
    release(barrier) {
      const held = holders.filter(holder => holder.barrier === barrier);
      for (const holder of held) holder.resolve();
      for (const holder of held) holders.splice(holders.indexOf(holder), 1);
      return held.length;
    },
    heldBarriers() {
      return [...new Set(holders.map(holder => holder.barrier))];
    },
/** How many requests are held on one barrier right now. */
    heldCount(barrier = null) {
      return countHeld(barrier);
    },
    /** Resolve once at least `count` requests are held at the same time. */
    waitUntilHeld(count, { barrier = null, timeoutMs = 60_000 } = {}) {
      if (countHeld(barrier) >= count) return Promise.resolve(countHeld(barrier));
      return new Promise<number>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          rejectPromise(new Error(`mock model: fewer than ${count} request(s) were held on ${barrier ?? 'any barrier'} within ${timeoutMs}ms (${countHeld(barrier)} held)`));
        }, timeoutMs);
        const poll = setInterval(() => {
          if (countHeld(barrier) < count) return;
          clearTimeout(timer);
          clearInterval(poll);
          resolvePromise(countHeld(barrier));
        }, 50);
        poll.unref();
      });
    },
    /**
     * How many provider requests this fixture was actually serving at once, from
     * the request/response intervals it recorded. This is the *plugin's*
     * concurrency as the wire saw it, not a number derived from its own ledger.
     */
    peakConcurrency() {
      const points: Array<[number, number]> = [];
      const lastEnd = requests.reduce((max, entry) => Math.max(max, entry.closed_at ?? entry.at), 0);
      for (const entry of requests) {
        const start = entry.opened_at ?? entry.at;
        const end = entry.closed_at ?? lastEnd;
        points.push([start, 1], [Math.max(start, end), -1]);
      }
      points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let live = 0;
      let peak = 0;
      for (const [, delta] of points) {
        live += delta;
        if (live > peak) peak = live;
      }
      return requests.length ? peak : null;
    },
    /** Fixture completeness: every request answered, nothing held, no fixture error. */
    assertComplete(): MockFixtureSummary {
      const finish = current?.finish?.();
      const held = holders.map(holder => `${holder.barrier}@${holder.entry.seq}`);
      const problems = [...errors];
      if (held.length) problems.push(`requests still held at teardown: ${held.join(', ')}`);
      if (finish?.problems?.length) problems.push(...finish.problems);
      if (problems.length) throw new Error(`mock fixture incomplete:\n  ${problems.join('\n  ')}`);
      return {
        requests: requests.length,
        scenario: current?.name ?? null,
        checks: finish?.checks ?? [],
        // A scenario's own record of what it observed, when it keeps one: the
        // subjects of its verdicts, carried out of the fixture so a reader can
        // check a closure against the submissions it was decided from.
        ...(finish?.fixture_evidence ? { fixture_evidence: finish.fixture_evidence } : {}),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const holder of [...holders]) holder.resolve({ text: 'mock shutting down' });
      holders.length = 0;
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
  };
}

/** The message of a thrown unknown, or its string form when it carries none. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    return message === undefined || message === null ? String(error) : String(message);
  }
  return String(error);
}

/** Loopback sockets that died mid-flight; the client's own abort, not a defect. */
function isDisconnect(error: unknown): boolean {
  const code = asRecord(error)?.code ?? '';
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET'
    || /socket hang up|destroyed|premature close|aborted/i.test(messageOf(error));
}

/**
 * One SSE response, written in stages so a request can be held open without
 * going idle: `open()` sends the role frame, `startKeepAlive()` sends SSE
 * comment frames, and `finish()` sends the deltas, the finish frame, the usage
 * and `[DONE]`.
 *
 * Content is split into deterministic slices so the client's own reassembly of
 * `tool_calls[].function.arguments` is exercised, not bypassed by a single
 * whole-string frame.
 */
function openStream(res: ServerResponse, { model, seq, now }: { model: unknown; seq: number; now: () => number }): MockStream {
  const id = `chatcmpl-mock-${seq}`;
  const created = Math.floor(now() / 1000);
  let keepAlive: NodeJS.Timeout | null = null;
  let opened = false;
  const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model, ...payload,
  })}\n\n`;
  const send = (text: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(text);
  };
  return {
    open() {
      if (opened) return;
      opened = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      send(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
    },
    startKeepAlive(everyMs = 5000) {
      if (keepAlive) return;
      this.open();
      keepAlive = setInterval(() => send(': kept open by the acceptance mock\n\n'), everyMs);
      keepAlive.unref();
    },
    stopKeepAlive() {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    },
    end() {
      this.stopKeepAlive();
      if (!res.writableEnded && !res.destroyed) res.end();
    },
    finish(reply, _entry) {
      this.stopKeepAlive();
      this.open();
      const toolCalls = reply?.toolCalls ?? [];
      const text = reply?.text ?? '';
      // Text and tool calls can arrive in one assistant turn; sending only the
      // tool calls would silently drop the answer the model gave.
      for (const piece of splitText(text)) {
        send(frame({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
      }
      if (toolCalls.length) {
        for (const [index, call] of toolCalls.entries()) {
          const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
          const pieces = sliceArguments(args, reply?.chunkBoundaries ?? [8, 24]);
          send(frame({
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index, id: call.id ?? `call_mock_${seq}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] },
              finish_reason: null,
            }],
          }));
          for (const piece of pieces) {
            send(frame({
              choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null }],
            }));
          }
        }
      }
      send(frame({
        choices: [{ index: 0, delta: {}, finish_reason: reply?.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') }],
      }));
      send(frame({ choices: [], usage: reply?.usage ?? defaultUsage(text, toolCalls) }));
      send(DONE_FRAME);
      if (!res.writableEnded && !res.destroyed) res.end();
    },
  };
}

/** Split an argument string at the fixture's own boundaries, byte-exact. */
function sliceArguments(text: string, boundaries: number[]): string[] {
  const cuts = [...new Set(boundaries.filter(size => size > 0 && size < text.length))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    pieces.push(text.slice(cursor, cut));
    cursor = cut;
  }
  pieces.push(text.slice(cursor));
  return pieces.filter(piece => piece.length);
}

function splitText(text: string): string[] {
  if (!text) return [];
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += 400) pieces.push(text.slice(index, index + 400));
  return pieces;
}

/**
 * Synthetic usage. It is an input to the ledger, not a measurement: the point
 * is that a request which really dispatched is accounted exactly once.
 */
function defaultUsage(text: string, toolCalls: readonly MockToolCallSpec[]): MockUsage {
  const completion = Math.max(1, Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4));
  return { prompt_tokens: 1000, completion_tokens: completion, total_tokens: 1000 + completion };
}