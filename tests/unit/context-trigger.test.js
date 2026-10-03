import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../../src/adapter/index.js';
import { DEFAULT_CONTEXT_LIMITS } from '../../src/adapter/protocol.js';
import { contextBudget, runTurn } from '../../src/adapter/runtime.js';
import { createFakeHost } from './fake-host.mjs';

test('FLOW_CONTEXT_TRIGGER drives real pre-step compaction below the role budget', async t => {
  const original = process.env.FLOW_CONTEXT_TRIGGER;
  process.env.FLOW_CONTEXT_TRIGGER = '0.064';
  t.after(() => {
    if (original === undefined) delete process.env.FLOW_CONTEXT_TRIGGER;
    else process.env.FLOW_CONTEXT_TRIGGER = original;
  });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-context-trigger-'));
  t.after(async () => {
    await runtime?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const compactions = [];
  const host = createFakeHost({
    tokenMeter: { measure: () => ({ totalTokens: host.sessionTokens, logRevision: 1 }) },
    compaction: {
      async compactNow() { return null; },
      async compactIfNeeded(live, reason) {
        compactions.push({ session: live.session.id, reason });
        host.setSessionTokens(300);
        return { summarySeq: 42, shadowedTokenCount: 300 };
      },
    },
  });
  host.setSessionTokens(400);
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  const clusterId = runtime.start({
    objective: 'measure a management turn', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  const decisions = [];
  host.setScript(async turn => {
    host.setSessionTokens(450);
    decisions.push((await turn.preStep({ step: 1, messages: [] })).kind);
    host.setSessionTokens(600);
    decisions.push((await turn.preStep({ step: 2, messages: [] })).kind);
  });

  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, modelAccounting: false, resume: false, turnSeq: 1,
    flow: runtime, contextLimits: runtime.config.context,
  });

  assert.deepEqual(decisions, ['enter', 'enter']);
  assert.deepEqual(compactions, [{ session: agent.session_id, reason: 'context-overflow' }]);
  const steps = runtime.store.readEvents(clusterId, { limit: 100 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => event.data.decision), ['proceed', 'compact']);
  assert.equal(steps[1].data.before, 600);
  assert.equal(steps[1].data.after, 300);
  assert.equal(steps[1].data.threshold, 524);
  assert.equal(steps[1].data.context_limit, 8192);

  assert.equal(contextBudget(agent, 'orchestrator', DEFAULT_CONTEXT_LIMITS).trigger, 0.8,
    'without an env override the normal trigger stays at 0.8');
  assert.equal(contextBudget({ ...agent, meta: { context: { trigger: 0.25 } } },
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
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'do not send a request beyond the provider input ceiling', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  let decision;
  host.setScript(async turn => {
    decision = await turn.preStep({ step: 1, messages: [] });
    if (decision.kind === 'enter') await turn.request({ purpose: 'role' });
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: false, turnSeq: 1,
    flow: runtime, contextLimits: { ...runtime.config.context, model: 9_200, server_input: 9_200 },
  });
  assert.equal(decision?.kind, 'reject');
  assert.equal(host.lastTurn.requests.length, 0, 'the request never left the context gate');
  const step = runtime.store.readEvents(clusterId, { limit: 100 }).findLast(event => event.type === 'context-step');
  assert.equal(step?.data.decision, 'reject');
  assert.equal(step?.data.context_limit, 8192);
  assert.equal(step?.data.sending_ceiling, 8_688);
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
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'keep each ordinary request inside the identity window', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  const decisions = [];
  host.setScript(async turn => {
    host.setSessionTokens(7_887);
    decisions.push((await turn.preStep({ step: 1, messages: [] })).kind);
    host.setSessionTokens(8_378);
    decisions.push((await turn.preStep({ step: 2, messages: [] })).kind);
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'measure pressure', allowedTools: [], globalTools: [],
    model: runtime.config.model, modelAccounting: false, resume: false, turnSeq: 1,
    flow: runtime, contextLimits: { ...runtime.config.context, compaction_threshold: 0.064 },
  });
  assert.deepEqual(decisions, ['enter', 'reject']);
  const steps = runtime.store.readEvents(clusterId, { limit: 100 }).filter(event => event.type === 'context-step');
  assert.deepEqual(steps.map(event => event.data.decision), ['compact', 'reject']);
  assert.equal(steps[1].data.after, 8_378);
  assert.equal(steps[1].data.context_limit, 8_192);
});

test('an explicit context threshold overrides FLOW_CONTEXT_TRIGGER', async t => {
  const original = process.env.FLOW_CONTEXT_TRIGGER;
  process.env.FLOW_CONTEXT_TRIGGER = '0.004';
  t.after(() => {
    if (original === undefined) delete process.env.FLOW_CONTEXT_TRIGGER;
    else process.env.FLOW_CONTEXT_TRIGGER = original;
  });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-context-explicit-'));
  t.after(async () => {
    await runtime?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, context: { compaction_threshold: 0.25 },
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  assert.equal(contextBudget(null, 'orchestrator', runtime.config.context).trigger, 0.25);
});

test('cluster compaction asks the model for text without executable tools or hidden reasoning', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-compaction-request-'));
  const host = createFakeHost();
  const runtime = apply(host.ctx, {
    dataDir: dir, provider: 'local-fake', model: 'fake-model', maxTokens: 512,
    tickMs: 10_000, heartbeatMs: 10_000, leaseTtlMs: 60_000,
  });
  t.after(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const clusterId = runtime.start({
    objective: 'produce a model-written checkpoint', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 10, tool_calls: 10, agents: 8, max_active_agents: 3 },
  }).cluster.id;
  const agent = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0];
  const offered = [{ name: 'flow_transaction', description: 'change a transaction', parameters: {} }];
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'unchanged role rules' }] },
    { role: 'user', content: [{ type: 'text', text: 'Summarize progress.' }] },
  ];
  const sent = [];
  host.setScript(async turn => {
    const handler = turn.agentCtx.streamHandlers[0];
    for (const purpose of ['compaction', undefined]) {
      const options = {
        sessionId: agent.session_id, provider: 'local-fake', model: 'fake-model',
        purpose, messages, tools: offered, maxTokens: 512,
      };
      const stream = handler(options, async function* () {
        sent.push({ purpose, tools: options.tools, reasoningEffort: options.reasoningEffort,
          messageRoles: options.messages.map(message => message.role) });
        yield { type: 'text', text: 'A useful checkpoint' };
        yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 } };
      });
      for await (const _chunk of stream) { /* consume the real accounting path */ }
    }
  });
  await runTurn(host.ctx, {
    agent, role: 'orchestrator', prompt: 'resume work', allowedTools: [], globalTools: [],
    model: runtime.config.model, resume: false, turnSeq: 1,
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
