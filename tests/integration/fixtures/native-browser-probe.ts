/** Script only model replies; navigate and snapshot are the installed native MCP tools. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-tools';
import { LlmAdapter, ToolCallId, createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createNativeMember } from '../../../packages/dsh-flow/src/core/runtime.ts';

export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'llm', 'tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt', 'skills'];
interface Config { workspace: string; report: string; evidence: string; origin: string }
class BrowserProbeAdapter extends LlmAdapter {
  calls = 0;
  constructor(private readonly origin: string) { super(); }
  override async listModels(provider: string) { return [{ provider, id: 'scripted-browser', name: 'scripted-browser' }]; }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++; options.signal?.throwIfAborted();
    const inputIndex = options.messages.findLastIndex(message => message.role === 'user' && message.content.some(part => part.type === 'text' && /^BROWSER (ordinary|member)$/u.test(part.text)));
    const input = options.messages[inputIndex]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? '';
    const count = options.messages.slice(inputIndex + 1).filter(message => message.role === 'tool').length;
    const suffix = count === 0 ? 'browser_navigate' : count === 1 ? 'browser_snapshot' : undefined;
    const name = suffix ? options.tools?.find(tool => tool.name.startsWith('mcp__') && tool.name.endsWith(`__${suffix}`))?.name : undefined;
    if (suffix) assert.ok(name, `The installed native MCP catalog must expose ${suffix}`);
    const block: ContentBlock = name
      ? { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(count === 0 ? { url: `${this.origin}/${input.slice(8)}` } : {}) }
      : { type: 'text', text: 'NATIVE-BROWSER-DONE' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    else if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } };
  }
}
export function apply(ctx: Context, config: Config): void {
  const adapter = new BrowserProbeAdapter(config.origin);
  ctx.llm.registerAdapter(['native-browser-probe'], adapter);
  setTimeout(() => { void run().then(
    report => writeFileSync(config.report, JSON.stringify({ status: 'PASSED', ...report }, null, 2)),
    error => writeFileSync(config.report, JSON.stringify({ status: 'FAILED', message: String(error), stack: error instanceof Error ? error.stack : null }, null, 2)),
  ); }, 0);
  async function run() {
    const agents: { label: string; agent: Agent; dispose: () => Promise<void> }[] = [];
    const outcomes: { label: string; error?: string }[] = [];
    const evidence = () => Object.fromEntries(agents.map(({ label, agent }) => [label, agent.session.snapshotEvents()]));
    try {
      const preset = await ctx.agentPresets.resolve();
      const model = { provider: 'native-browser-probe', model: 'scripted-browser' };
      const ordinary = await ctx.agents.create({ sessionId: SessionId('session-browser-ordinary'), meta: { cwd: config.workspace, agentPreset: preset.id }, agentOptions: model,
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); } });
      agents.push({ label: 'ordinary', agent: ordinary.agent, dispose: () => ordinary.dispose() });
      const member = await createNativeMember(ctx, { sessionId: 'session-browser-member', parentSessionId: ordinary.agent.session.id, workspace: config.workspace, setup: () => {} });
      agents.push({ label: 'member', agent: member.agent, dispose: () => member.dispose() });
      const catalogs = agents.map(({ agent }) => agent.ctx.tools.schemas(agent).map(tool => tool.name).sort());
      assert.deepEqual(catalogs[0], catalogs[1]);
      const policies = (events: readonly SessionEvent[]) => events.filter(event => event.type === 'approval/policy' || event.type.startsWith('sandbox/')).map(event => ({ type: event.type, data: event.data }));
      assert.deepEqual(policies(ordinary.agent.session.snapshotEvents()), policies(member.events()));
      assert.ok(member.events().some(event => event.type === 'approval/policy' && event.data.policy === 'ask'));
      // Run both sides before asserting receipts so a provider limitation remains comparable.
      for (const { label, agent } of agents) {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `BROWSER ${label}` }] }));
        try {
          await Promise.race([agent.whenIdle(), delay(25_000, undefined, { ref: false }).then(() => { throw new Error(`${label} native browser turn did not become idle`); })]);
          outcomes.push({ label });
        } catch (error) { outcomes.push({ label, error: String(error) }); }
      }
      writeFileSync(config.evidence, JSON.stringify({ outcomes, events: evidence() }, null, 2));
      for (const { label, agent } of agents) {
        assert.equal(outcomes.find(outcome => outcome.label === label)?.error, undefined);
        const events = agent.session.snapshotEvents();
        const calls = events.filter(event => event.type === 'tool/call');
        const results = events.filter(event => event.type === 'tool/result');
        assert.equal(calls.length, 2, `${label} must really navigate and then read a browser snapshot`);
        assert.equal(results.length, 2);
        for (const result of results) assert.notEqual(result.data.message.isError, true, JSON.stringify(result));
        const snapshotCall = calls.find(event => event.data.name.endsWith('__browser_snapshot'));
        assert.ok(snapshotCall);
        const snapshot = results.find(event => event.data.message.toolCallId === snapshotCall.data.callId);
        assert.ok(snapshot);
        assert.match(JSON.stringify(snapshot.data.message.content), new RegExp(`NATIVE-BROWSER-${label.toUpperCase()}-VISIBLE`, 'u'));
      }
      return { preset: preset.id, browser_provider: 'playwright-mcp', browser_mode: 'launch / isolated / headless', identical_native_catalog: catalogs[0],
        ordinary_navigate_and_snapshot: true, member_navigate_and_snapshot: true, native_policy_unchanged: true, external_model_requests: 0,
        scripted_model_steps: adapter.calls, native_evidence: config.evidence };
    } finally {
      writeFileSync(config.evidence, JSON.stringify({ outcomes, events: evidence() }, null, 2));
      await Promise.allSettled(agents.map(agent => agent.dispose()));
    }
  }
}
