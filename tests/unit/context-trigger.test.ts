import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { DEFAULT_CONTEXT_LIMITS } from '../../packages/dsh-flow/src/core/protocol.ts';
import { contextBudget, runTurn } from '../../packages/dsh-flow/src/core/runtime.ts';
import { objectField, textField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost, type FakePreStepDecision } from './fake-host.ts';

/** Narrow fixture reads that the test knows must exist. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: ${label} is missing`);
  return value;
}

/** The session id of the live agent a compaction engine is asked to compact. */
function sessionIdOf(live: unknown): string {
  const holder = objectField(live, 'compaction target');
  const session = objectField(holder.session, 'compaction session');
  return textField(session.id, 'session id');
}

/** The message roles and options one accounted request was actually sent with. */
interface SentRequest {
  readonly purpose: string | undefined
  readonly tools: unknown
  readonly messageRoles: readonly unknown[]
  readonly reasoningEffort: unknown
}



test('the configured compaction threshold drives real pre-step compaction below the role budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-context-trigger-'));
  const compactions: Array<{ session: string; reason: unknown }> = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(live, reason) {
        compactions.push({ session: sessionIdOf(live), reason });
        host.setSessionTokens(300);
        return { summarySeq: 42, shadowedTokenCount: 300 };
      },
    },
  });
  host.setSessionTokens(400);
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    context: { ...DEFAULT_CONTEXT_LIMITS, compaction_threshold: 0.064 },
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    model: { provider: 'local-fake', model: 'fake-model', maxTokens: 512 },
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'measure a management turn', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = must(runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0], 'orchestrator');
  const decisions: string[] = [];
  host.setScript(async turn => {
    host.setSessionTokens(450);
    decisions.push((await turn.preStep({ step: 1, messages: [] })).kind);
    host.setSessionTokens(600);
    decisions.push((await turn.preStep({ step: 2, messages: [] })).kind);
  });

  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, modelAccounting: false, resume: false, turnSeq: 1, budgetIds: [],
    flow: runtime, contextLimits: runtime.config.context,
  });

  assert.deepEqual(decisions, ['enter', 'enter']);
  assert.deepEqual(compactions, [{ session: agent.session_id, reason: 'context-overflow' }]);
  const steps = runtime.store.readEvents(clusterId, { limit: 100 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => objectField(event.data, 'context step').decision), ['proceed', 'compact']);
  const second = objectField(must(steps[1], 'second step').data, 'context step');
  assert.equal(second.before, 600);
  assert.equal(second.after, 300);
  assert.equal(second.threshold, 524);
  assert.equal(second.context_limit, 8192);

  assert.equal(contextBudget(agent, 'orchestrator', DEFAULT_CONTEXT_LIMITS).trigger, 0.8,
    'without an override the normal trigger stays at 0.8');
  assert.equal(contextBudget({ ...agent, meta: { context: { trigger: 0.25, limit: 0, retention: null } } },
    'orchestrator', runtime.config.context).trigger, 0.25,
  'an Allocator identity override takes priority over the cluster trigger');
});

test('ineffective compaction rejects a step beyond the provider input ceiling before dispatch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-context-provider-ceiling-'));
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: 9_000, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded() { return null; },
    },
  });
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    context: { ...DEFAULT_CONTEXT_LIMITS },
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    model: { provider: 'local-fake', model: 'fake-model', maxTokens: 512 },
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'do not send a request beyond the provider input ceiling', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = must(runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0], 'orchestrator');
  const captured: { decision?: FakePreStepDecision } = {};
  host.setScript(async turn => {
    captured.decision = await turn.preStep({ step: 1, messages: [] });
    if (captured.decision.kind === 'enter') await turn.request({ purpose: 'role' });
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: false, turnSeq: 1, budgetIds: [],
    flow: runtime, contextLimits: { ...runtime.config.context, model: 9_200, server_input: 9_200 },
  });
  assert.equal(captured.decision?.kind, 'reject');
  assert.equal(must(host.lastTurn, 'last turn').requests.length, 0, 'the request never left the context gate');
  const step = runtime.store.readEvents(clusterId, { limit: 100 }).findLast(event => event.type === 'context-step');
  const record = objectField(must(step, 'context step').data, 'context step');
  assert.equal(record.decision, 'reject');
  assert.equal(record.context_limit, 8192);
  assert.equal(record.sending_ceiling, 8_688);
});

test('a second step cannot escape the identity budget after an ineffective compaction', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-context-identity-ceiling-'));
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded() { return { summarySeq: 13, shadowedTokenCount: 0 }; },
    },
  });
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    context: { ...DEFAULT_CONTEXT_LIMITS },
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    model: { provider: 'local-fake', model: 'fake-model', maxTokens: 512 },
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'keep each ordinary request inside the identity window', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = must(runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0], 'orchestrator');
  const decisions: string[] = [];
  host.setScript(async turn => {
    host.setSessionTokens(7_887);
    decisions.push((await turn.preStep({ step: 1, messages: [] })).kind);
    host.setSessionTokens(8_378);
    decisions.push((await turn.preStep({ step: 2, messages: [] })).kind);
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, modelAccounting: false, resume: false, turnSeq: 1, budgetIds: [],
    flow: runtime, contextLimits: { ...runtime.config.context, compaction_threshold: 0.064 },
  });
  assert.deepEqual(decisions, ['enter', 'reject']);
  const steps = runtime.store.readEvents(clusterId, { limit: 100 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => objectField(event.data, 'context step').decision), ['compact', 'reject']);
  const second = objectField(must(steps[1], 'second step').data, 'context step');
  assert.equal(second.after, 8_378);
  assert.equal(second.context_limit, 8_192);
});

test('cluster compaction asks the model for text without executable tools or hidden reasoning', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-compaction-request-'));
  const host = createFakeHost();
  // A role route that runs at reasoning effort `off` is what the compaction
  // request is reshaped from; the deployment states it rather than a default.
  const runtime = new ClusterRuntime(host.ctx, {
    path: join(dir, 'cluster.sqlite'), dataDir: dir, autoTick: false,
    context: { ...DEFAULT_CONTEXT_LIMITS },
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
    model: { provider: 'local-fake', model: 'fake-model', reasoningEffort: 'off', maxTokens: 512 },
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'produce a model-written checkpoint', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = must(runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0], 'orchestrator');
  const offered = [{ name: 'flow_transaction', description: 'change a transaction', parameters: {} }];
  const messages = [
    { role: 'system' as const, content: [{ type: 'text' as const, text: 'unchanged role rules' }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Summarize progress.' }] },
  ];
  const sent: SentRequest[] = [];
  host.setScript(async turn => {
    const handler = must(turn.agentCtx.streamHandlers[0], 'llm/stream accounting listener');
    const purposes: Array<'compaction' | undefined> = ['compaction', undefined];
    for (const purpose of purposes) {
      const options: GenerateOptions = fromPartial({
        sessionId: SessionId(agent.session_id), provider: 'local-fake', model: 'fake-model',
        ...(purpose === undefined ? {} : { purpose }),
        messages, tools: offered, maxTokens: 512,
      });
      const stream = handler(options, async function* () {
        sent.push({
          purpose, tools: options.tools, reasoningEffort: options.reasoningEffort,
          messageRoles: options.messages.map(message => message.role),
        });
        yield { type: 'text-delta' as const, index: 0, text: 'A useful checkpoint' };
        yield { type: 'usage' as const, usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 } };
      });
      for await (const _chunk of stream) { /* consume the real accounting path */ }
    }
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'resume work', allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: false, turnSeq: 1, budgetIds: [],
    flow: runtime, contextLimits: runtime.config.context,
  });
  assert.deepEqual(sent, [
    { purpose: 'compaction', tools: [], reasoningEffort: 'off', messageRoles: ['user'] },
    { purpose: undefined, tools: offered, reasoningEffort: undefined, messageRoles: ['system', 'user'] },
  ]);
  assert.deepEqual(runtime.store.all(
    'SELECT kind FROM usage_receipts WHERE cluster_id=? ORDER BY rowid', clusterId,
  ).map(row => row.kind), ['compaction', 'role']);
});