/** Real native runtime probe. Only the model's generated responses are scripted. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import { fromAny } from '@total-typescript/shoehorn';
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-skill';
import { createNativeMember } from '../../../packages/dsh-flow/src/core/runtime.ts';

export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'llm', 'tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'sessionController', 'systemPrompt', 'skills'];
interface Config { workspace: string; report: string; phase: 'fresh' | 'cold' }
// A public IP endpoint avoids the developer machine's DNS fake-IP routing;
// this still exercises the unchanged native public-address and HTTPS checks.
const publicPage = { url: 'https://1.1.1.1/cdn-cgi/trace', expectedText: 'h=1.1.1.1' };
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
function policy(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'approval/policy' || event.type.startsWith('sandbox/')).map(event => ({ type: event.type, data: event.data }));
}
function receipts(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'tool/result').map(event => event.data);
}
class ProbeAdapter extends LlmAdapter {
  calls = 0;
  override async listModels(provider: string) { return ['scripted', 'scripted-selected'].map(id => ({ provider, id, name: id })); }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    options.signal?.throwIfAborted();
    if(options.sessionId==='session-flow-native-probe'&&!options.purpose){
      const system=options.messages.filter(message=>message.role==='system').flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n');
      assert.match(system,/团队角色：协调者（Orchestrator）/u);
      assert.match(system,/NATIVE-ROLE-INSTRUCTIONS/u);
      assert.match(system,/NATIVE-ROLE-SKILL/u);
    }
    const inputIndex = options.messages.findLastIndex(message => message.role === 'user' && message.content.some(part => part.type === 'text' && /^(CASE|TEXT|SLOW|LONG) /u.test(part.text)));
    const input = options.messages[inputIndex]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? '';
    const toolMessages = options.messages.slice(inputIndex + 1).filter(message => message.role === 'tool');
    const count = toolMessages.length;
    const prefix = input.slice(5);
    let call: { name: string; args: object } | undefined;
    if (input.startsWith('CASE ')) {
      call = [
        { name: 'write', args: { file_path: `${prefix}.txt`, content: 'native tools stay native\n' } },
        { name: 'read', args: { file_path: `${prefix}.txt` } },
        { name: 'bash', args: { command: `test -f ${prefix}.txt && printf 'BASH-OK'`, description: 'Check the native file and shell.' } },
        { name: 'fixture_native_artifact', args: { label: prefix, content: 'unlisted plugin round trip\n' } },
        { name: 'web_fetch', args: { url: publicPage.url } },
        { name: 'bash', args: { command: `sleep 0.3; printf 'NATIVE-JOB-OK' > ${prefix}-background.txt; cat ${prefix}-background.txt`, description: 'Run a real native background job and persist its completed output.', run_in_background: true } },
      ][count];
      if (count === 6) {
        const backgroundReceipt = toolMessages[5]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? '';
        const jobId = /started background job (\S+)/u.exec(backgroundReceipt)?.[1];
        assert.ok(jobId, `the native bash receipt must supply the actual job id: ${backgroundReceipt}`);
        call = { name: 'job_output', args: { job_id: jobId, wait: true, timeout_ms: 5_000 } };
      }
    } else if (input.startsWith('SLOW ') && count === 0) {
      call = { name: 'bash', args: { command: 'printf ready > slow-started; sleep 20; printf escaped > slow-ended', description: 'Exercise cancellation of a native foreground shell.', timeoutMs: 30_000 } };
    } else if (input.startsWith('LONG ') && count < 32) {
      call = { name: 'read', args: { file_path: 'member.txt' } };
    }
    const block: ContentBlock = call
      ? { type: 'tool-call', id: ToolCallId(randomUUID()), name: call.name, arguments: JSON.stringify(call.args) }
      : { type: 'text', text: input.startsWith('TEXT ') ? input.slice(5) : 'NATIVE-DONE' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    else if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } };
  }
}
export function apply(ctx: Context, config: Config): void {
  const adapter = new ProbeAdapter();
  ctx.skills.register({name:'native-role-probe',description:'Native role probe',source:'runtime',content:'NATIVE-ROLE-SKILL: preserve native tool receipts.'});
  const roleProfile={role:'orchestrator' as const,instructions:'NATIVE-ROLE-INSTRUCTIONS: coordinate resources with the same native tools.',skills:['native-role-probe']};
  ctx.llm.registerAdapter(['native-member-probe'], adapter);
  // This tool exists only in this unrelated test plugin. Flow neither names it
  // nor maps it to a capability: the native registry exposes and executes it.
  ctx.tools.register(defineTool({
    name: 'fixture_native_artifact',
    description: 'Write and read back one isolated native-plugin test artifact.',
    parameters: {
      label: { type: 'string', enum: ['ordinary', 'member'], required: true },
      content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      assert.equal(exec.agent?.session.header.cwd, config.workspace);
      const path = join(config.workspace, `${args.label}-plugin.txt`);
      writeFileSync(path, args.content);
      return readFileSync(path, 'utf8');
    },
  }));
  // The native preset diagnostic waits for the host Loader to finish activation.
  // Run outside this plugin's activation callback so the Loader can settle.
  setTimeout(() => { void run().then(
      report => writeFileSync(config.report, JSON.stringify({ status: 'PASSED', ...report }, null, 2)),
      error => writeFileSync(config.report, JSON.stringify({ status: 'FAILED', message: String(error), stack: error instanceof Error ? error.stack : null }, null, 2)),
  ); }, 0);
  async function run() {
    const model = { provider: 'native-member-probe', model: 'scripted' };
    if (config.phase === 'cold') {
      const member = await createNativeMember(ctx, { ...roleProfile, sessionId: 'session-flow-native-probe', workspace: config.workspace, model, setup: () => {} });
      const before = member.events().length;
      assert.ok(member.events().some(event => event.type === 'tool/result'), 'native tool receipts survive a real host restart');
      assert.equal(member.lastText(), 'PERSISTED');
      assert.equal(member.agent.options.model, 'scripted-selected', 'the durable native model selection overrides the old Flow creation model');
      assert.equal(member.running(), false);
      member.send(user('TEXT RESTORED'), 'followup'); await member.whenIdle();
      assert.equal(member.lastText(), 'RESTORED');
      assert.ok(member.events().length > before);
      await member.flush(); await member.dispose();
      return { restored: true, restored_native_model: member.agent.options.model, prior_native_events: before, model_calls: adapter.calls };
    }
    const preset = await ctx.agentPresets.resolve();
    const baseline = await ctx.agents.create({ sessionId: SessionId('session-ordinary-native-probe'), meta: { cwd: config.workspace, agentPreset: preset.id }, agentOptions: model,
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); } });
    const observed: number[] = [];
    const member = await createNativeMember(ctx, { ...roleProfile, sessionId: 'session-flow-native-probe', parentSessionId: baseline.agent.session.id,
      workspace: config.workspace, setup: () => {}, onEvent: event => { observed.push(event.seq); } });
    assert.equal(member.agent.options.provider, model.provider, 'omitted Flow model inherits the configured native default');
    assert.equal(member.agent.options.model, model.model);
    const stopDriver = ctx.sessionController.registerSessionDriver({
      owns: sessionId => sessionId === member.agent.session.id,
      resolveAgent: async () => member.agent,
    });
    const baselineTools = baseline.agent.ctx.tools.schemas(baseline.agent).map(tool => tool.name).sort();
    const memberTools = member.agent.ctx.tools.schemas(member.agent).map(tool => tool.name).sort();
    for (const tool of ['read', 'write', 'bash', 'fixture_native_artifact', 'web_fetch', 'job_output']) assert.ok(baselineTools.includes(tool));
    assert.deepEqual(memberTools, baselineTools);
    assert.deepEqual(policy(member.events()), policy(baseline.agent.session.snapshotEvents()));
    assert.ok(policy(member.events()).some(event => event.type === 'approval/policy' && 'policy' in event.data && event.data.policy === 'ask'));
    assert.equal(ctx.agentPresets.composedPreset(member.agent.ctx), preset.id);
    baseline.agent.followup(user('CASE ordinary')); await baseline.agent.whenIdle();
    member.send(user('CASE member'), 'followup'); await member.whenIdle();
    const nativeToolComparison = Object.fromEntries(([
      ['ordinary', baseline.agent.session.snapshotEvents()], ['member', member.events()],
    ] as const).map(([name, events]) => [name, events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')]));
    // Preserve actual receipts before assertions, including native/network failures.
    writeFileSync(join(dirname(config.report), 'native-tool-comparison.json'), JSON.stringify(nativeToolComparison, null, 2));
    for (const [name, events] of [['ordinary', baseline.agent.session.snapshotEvents()], ['member', member.events()]] as const) {
      const results = receipts(events);
      assert.equal(results.length, 7, `${name} executes real file, shell, unrelated plugin, public web and background job tools`);
      for (const result of results) assert.notEqual(result.message.isError, true, JSON.stringify(result));
      assert.equal(readFileSync(join(config.workspace, `${name}.txt`), 'utf8'), 'native tools stay native\n');
      assert.equal(readFileSync(join(config.workspace, `${name}-plugin.txt`), 'utf8'), 'unlisted plugin round trip\n');
      const pluginCall = events.find(event => event.type === 'tool/call' && event.data.name === 'fixture_native_artifact');
      assert.ok(pluginCall?.type === 'tool/call');
      const pluginReceipt = results.find(result => result.message.toolCallId === pluginCall.data.callId);
      assert.deepEqual(pluginReceipt?.message.content, [{ type: 'text', text: 'unlisted plugin round trip\n' }]);
      const webCall = events.find(event => event.type === 'tool/call' && event.data.name === 'web_fetch');
      assert.ok(webCall?.type === 'tool/call');
      const webReceipt = results.find(result => result.message.toolCallId === webCall.data.callId);
      assert.ok(JSON.stringify(webReceipt?.message.content).includes(publicPage.expectedText));
      const jobCall = events.find(event => event.type === 'tool/call' && event.data.name === 'job_output');
      assert.ok(jobCall?.type === 'tool/call');
      const jobReceipt = results.find(result => result.message.toolCallId === jobCall.data.callId);
      assert.match(JSON.stringify(jobReceipt?.message.content), /NATIVE-JOB-OK/u);
      assert.match(JSON.stringify(jobReceipt?.message.content), /\[status: completed/u);
      assert.equal(readFileSync(join(config.workspace, `${name}-background.txt`), 'utf8'), 'NATIVE-JOB-OK');
    }
    assert.equal(member.lastText(), 'NATIVE-DONE');
    const callsBeforeNotice = adapter.calls;
    member.send(user('idle notice'), 'notice'); await delay(60);
    assert.equal(adapter.calls, callsBeforeNotice, 'a native notice does not wake an idle Agent');
    const sameAgent = member.agent;
    member.send(user('TEXT CONTINUED'), 'followup'); await member.whenIdle();
    assert.equal(member.agent, sameAgent); assert.equal(member.lastText(), 'CONTINUED');
    const requestId = () => fromAny<SessionRequestId, string>(randomUUID());
    const publicRequest = { sessionId: member.agent.session.id, requestId: requestId(), mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'TEXT PUBLIC' }, { type: 'text' as const, text: 'Second content part' }] };
    const ordinaryRequest = { ...publicRequest, sessionId: baseline.agent.session.id, requestId: requestId() };
    await ctx.sessionController.prompt(ordinaryRequest, new AbortController().signal);
    await ctx.sessionController.prompt(ordinaryRequest, new AbortController().signal);
    await baseline.agent.whenIdle();
    const ordinaryDuplicates = baseline.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && 'rpcId' in event.data.source && event.data.source.rpcId === ordinaryRequest.requestId);
    assert.equal(ordinaryDuplicates.length, 1, 'ordinary native prompt identity also deduplicates');
    await ctx.sessionController.prompt(publicRequest, new AbortController().signal);
    await ctx.sessionController.prompt(publicRequest, new AbortController().signal);
    await member.whenIdle();
    const publicInputs = member.events().filter(event => event.type === 'user/message' && 'rpcId' in event.data.source && event.data.source.rpcId === publicRequest.requestId);
    assert.equal(publicInputs.length, 1, `native prompt dedup baseline=${ordinaryDuplicates.length}, owned=${publicInputs.length}: ${JSON.stringify(publicInputs)}`);
    const publicInput = publicInputs[0]; assert.ok(publicInput?.type === 'user/message');
    assert.deepEqual(publicInput.data.content, publicRequest.content);
    assert.equal(member.agent, sameAgent, 'the public entry resolves the same owner instead of creating another Agent');
    member.send(user('SLOW cancel'), 'followup');
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(config.workspace, 'slow-started')) && Date.now() < deadline) await delay(20);
    assert.ok(existsSync(join(config.workspace, 'slow-started')), 'the real shell started before cancellation');
    assert.equal(member.running(), true);
    const queued = async (text: string) => {
      const req = { sessionId: member.agent.session.id, requestId: requestId(), mode: 'queue' as const, content: [{ type: 'text' as const, text }] };
      await ctx.sessionController.prompt(req, new AbortController().signal);
      const input = member.agent.inbox.nextTurn.find(input => 'rpcId' in input.source && input.source.rpcId === req.requestId);
      assert.ok(input); return input.id;
    };
    const removedId = await queued('TEXT REMOVE');
    const editedId = await queued('TEXT BEFORE-EDIT');
    const steeredId = await queued('TEXT STEER');
    await ctx.sessionController.updateQueue({ sessionId: member.agent.session.id, itemId: removedId, action: { kind: 'remove' } });
    await ctx.sessionController.updateQueue({ sessionId: member.agent.session.id, itemId: editedId, action: { kind: 'edit', content: [{ type: 'text', text: 'TEXT AFTER-EDIT' }] } });
    await ctx.sessionController.updateQueue({ sessionId: member.agent.session.id, itemId: steeredId, action: { kind: 'steer' } });
    assert.equal(member.agent.inbox.nextTurn.some(input => input.id === removedId), false);
    assert.deepEqual(member.agent.inbox.nextTurn.find(input => input.id === editedId)?.content, [{ type: 'text', text: 'TEXT AFTER-EDIT' }]);
    assert.ok(member.agent.inbox.nextStep.some(input => input.id === steeredId));
    await member.cancel(); assert.equal(member.running(), false);
    assert.equal(existsSync(join(config.workspace, 'slow-ended')), false, 'cancel drains the native foreground process');
    const beforeLong = receipts(member.events()).length;
    member.send(user('LONG verify'), 'followup'); await member.whenIdle();
    const longReceipts = receipts(member.events()).slice(beforeLong);
    assert.equal(longReceipts.length, 32, 'native work can continue past the retired Flow per-turn tool ceiling');
    for (const receipt of longReceipts) assert.notEqual(receipt.message.isError, true);
    for (let turn = 0; turn < 15; turn++) {
      member.send(user(`TEXT continuation-${turn}`), 'followup'); await member.whenIdle();
      assert.equal(member.lastText(), `continuation-${turn}`);
    }
    member.send(user('TEXT PERSISTED'), 'followup'); await member.whenIdle();
    await ctx.sessionController.selectModel({ sessionId: member.agent.session.id, provider: model.provider, model: 'scripted-selected' });
    await member.flush();
    const forked = await ctx.sessionController.fork({ sessionId: member.agent.session.id });
    assert.notEqual(forked.sessionId, member.agent.session.id);
    assert.equal(ctx.sessionController.sessionDriver(forked.sessionId), undefined, 'a fork is an ordinary native Session with no Flow owner');
    assert.ok(observed.length > 0);
    const eventCount = member.events().length;
    await member.dispose(); await member.dispose(); await baseline.dispose(); stopDriver();
    assert.equal(ctx.agents.get(SessionId('session-flow-native-probe')), undefined);
    return { preset: preset.id, identical_tools: memberTools, identical_native_policy: true, tool_receipts_per_agent: 7,
      retained_same_agent: true, idle_notice_no_wake: true, cancel_drained: true, native_events: eventCount, model_calls: adapter.calls,
      public_prompt_preserves_content: true, public_prompt_deduplicates: true, public_queue_edit_remove_steer: true, ordinary_fork: true,
      long_turn_native_reads: 32, consecutive_followup_turns: 15,
      public_web_fetch: { url: publicPage.url, ordinary_executed: true, flow_member_executed: true, expected_text: publicPage.expectedText },
      native_background_job: { ordinary_executed: true, flow_member_executed: true, terminal_status: 'completed', actual_output: 'NATIVE-JOB-OK',
        artifacts: ['ordinary-background.txt', 'member-background.txt'], evidence: 'native-tool-comparison.json' },
      unlisted_plugin_tool: { name: 'fixture_native_artifact', ordinary_executed: true, flow_member_executed: true,
        artifacts: ['ordinary-plugin.txt', 'member-plugin.txt'], content: 'unlisted plugin round trip\n' } };
  }
}
