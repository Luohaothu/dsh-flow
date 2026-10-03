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

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
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
export function identityOf(messages) {
  const identity = { role: null, nodeId: null, depth: null, agentId: null, transactionId: null, objective: null, workerPrompt: false, digest: null };
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'system') continue;
    const text = messageText(message);
    const roleMatch = ROLE_LINE.exec(text);
    if (roleMatch) {
      identity.role = roleMatch[1];
      identity.nodeId = roleMatch[2];
      identity.depth = Number(roleMatch[3]);
      identity.agentId = roleMatch[4];
    }
    const transactionMatch = /\bTransaction id: (\S+)/u.exec(text);
    if (transactionMatch) identity.transactionId = transactionMatch[1];
    const objectiveMatch = /\bObjective: (.*)/u.exec(text);
    if (objectiveMatch) identity.objective = objectiveMatch[1].trim();
    if (text.startsWith(WORKER_HEADER)) identity.workerPrompt = true;
    // Both spellings: the plugin's own prompt marker and the line this fixture
    // preserves through a checkpoint. The newest one in the conversation wins.
    const carried = digestIn(text);
    if (carried) identity.digest = carried;
  }
  return identity;
}

/** The domain digest a message carries, from either the prompt or a checkpoint. */
function digestIn(text) {
  const markerIndex = String(text ?? '').indexOf(DIGEST_MARKER);
  if (markerIndex >= 0) {
    const after = String(text).slice(markerIndex);
    const start = after.indexOf('\n');
    if (start >= 0) {
      const line = after.slice(start + 1).split('\n')[0].trim();
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }
  }
  const digestIndex = String(text ?? '').lastIndexOf(DIGEST_LINE_MARKER);
  if (digestIndex >= 0) {
    const line = String(text).slice(digestIndex + DIGEST_LINE_MARKER.length).split('\n')[0].trim();
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Classify one provider request from its messages alone. This is the only
 * signal the wire carries: the route adds no session or purpose header.
 */
export function classifyRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
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
  const lastMessageRole = messages.length ? messages[messages.length - 1].role : null;
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
    lastToolName: [...messages].reverse().find(message => message.role === 'assistant'
      && Array.isArray(message.tool_calls) && message.tool_calls.length)?.tool_calls.slice(-1)[0]?.function?.name ?? null,
    toolNames: Array.isArray(body?.tools) ? body.tools.map(tool => tool?.function?.name).filter(Boolean) : [],
    userText: text,
    messageCount: messages.length,
  };
}

/**
 * One scripted model endpoint. A scenario is bound before the cluster starts;
 * an unbound request is a fixture error, never a default "OK" answer.
 */
export async function startMockModel({ scenario = null, host = '127.0.0.1', modelId = 'mock-model', now = Date.now } = {}) {
  const requests = [];
  const holders = [];
  const waiters = [];
  const sockets = new Set();
  let current = scenario;
  let closed = false;
  let errors = [];
  let sequence = 0;

  function record(entry) {
    requests.push(entry);
    settleWaiters(entry);
  }

  function settleWaiters(entry) {
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

  function noteError(message) {
    errors.push(message);
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks).toString('utf8')).catch(error => {
        // A client that walked away mid-stream is the *tested* fault (a cluster
        // cancelled under a live turn), not a fixture defect.
        if (isDisconnect(error)) return;
        noteError(`mock server error: ${error?.message ?? error}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
      });
    });
  });
  server.on('connection', socket => {
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

  async function handle(req, res, rawBody) {
    const url = new URL(req.url, 'http://127.0.0.1');
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
    let body;
    try {
      body = JSON.parse(rawBody || '{}');
    } catch (error) {
      noteError(`mock model received a body it cannot parse: ${error.message}`);
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

    sequence += 1;
    const classified = classifyRequest(body);
    const entry = {
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

let stream = null;
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

    let reply;
    try {
      reply = await current.respond(entry);
    } catch (error) {
      noteError(`scenario ${current.name ?? 'unnamed'} failed on request ${entry.seq}: ${error?.message ?? error}`);
      entry.diagnostic = true;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
      return;
    }

stream = openStream(res, { model: body.model ?? modelId, seq: sequence, now });
    entry.opened_at = Date.now();

    // A *declared* failure is a stimulus the case asked for, not a fixture
    // defect: it is recorded on the entry and never as a scenario error.
    if (reply?.fail) {
      entry.declared_failure = { status: reply.fail.status ?? 500, message: reply.fail.message ?? 'declared failure' };
      res.writeHead(entry.declared_failure.status, { 'content-type': 'application/json' });
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
      entry.barrier = String(reply.hold);
      entry.held = true;
      // A runner waiting for "a request held on this barrier" must be woken
      // *now*: at `record` time the hold had not been decided yet.
      settleWaiters(entry);
      // The request is answered *after* the runner releases the barrier. SSE
      // comment frames keep the provider's idle watchdog fed in the meantime, so
      // a held request is a slow model, not a dead connection.
      stream.open();
      stream.startKeepAlive();
      const holder = { barrier: entry.barrier, entry, resolve: null };
      await new Promise(resolvePromise => {
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

  await new Promise(resolvePromise => server.listen(0, host, resolvePromise));
  const address = server.address();
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
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
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
      return barrier === null ? holders.length : holders.filter(holder => holder.barrier === barrier).length;
    },
    /** Resolve once at least `count` requests are held at the same time. */
    waitUntilHeld(count, { barrier = null, timeoutMs = 60_000 } = {}) {
      if (this.heldCount(barrier) >= count) return Promise.resolve(this.heldCount(barrier));
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          rejectPromise(new Error(`mock model: fewer than ${count} request(s) were held on ${barrier ?? 'any barrier'} within ${timeoutMs}ms (${this.heldCount(barrier)} held)`));
        }, timeoutMs);
        const poll = setInterval(() => {
          if (this.heldCount(barrier) < count) return;
          clearTimeout(timer);
          clearInterval(poll);
          resolvePromise(this.heldCount(barrier));
        }, 50);
        poll.unref?.();
      });
    },
    /**
     * How many provider requests this fixture was actually serving at once, from
     * the request/response intervals it recorded. This is the *plugin's*
     * concurrency as the wire saw it, not a number derived from its own ledger.
     */
    peakConcurrency() {
      const points = [];
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
    assertComplete() {
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
      await new Promise(resolvePromise => server.close(resolvePromise));
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
  };
}

/** Loopback sockets that died mid-flight; the client's own abort, not a defect. */
function isDisconnect(error) {
  const code = error?.code ?? '';
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET'
    || /socket hang up|destroyed|premature close|aborted/i.test(String(error?.message ?? ''));
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
function openStream(res, { model, seq, now }) {
  const id = `chatcmpl-mock-${seq}`;
  const created = Math.floor(now() / 1000);
  let keepAlive = null;
  let opened = false;
  const frame = payload => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model, ...payload,
  })}\n\n`;
  const send = text => {
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
      keepAlive.unref?.();
    },
    stopKeepAlive() {
      clearInterval(keepAlive);
      keepAlive = null;
    },
    end() {
      this.stopKeepAlive();
      if (!res.writableEnded && !res.destroyed) res.end();
    },
    finish(reply) {
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
function sliceArguments(text, boundaries) {
  const cuts = [...new Set(boundaries.filter(size => size > 0 && size < text.length))].sort((a, b) => a - b);
  const pieces = [];
  let cursor = 0;
  for (const cut of cuts) {
    pieces.push(text.slice(cursor, cut));
    cursor = cut;
  }
  pieces.push(text.slice(cursor));
  return pieces.filter(piece => piece.length);
}

function splitText(text) {
  if (!text) return [];
  const pieces = [];
  for (let index = 0; index < text.length; index += 400) pieces.push(text.slice(index, index + 400));
  return pieces;
}

/**
 * Synthetic usage. It is an input to the ledger, not a measurement: the point
 * is that a request which really dispatched is accounted exactly once.
 */
function defaultUsage(text, toolCalls) {
  const completion = Math.max(1, Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4));
  return { prompt_tokens: 1000, completion_tokens: completion, total_tokens: 1000 + completion };
}