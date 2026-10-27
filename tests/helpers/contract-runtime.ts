import { Context as DshContext } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, ReasoningEffortId, type GenerateOptions, type StreamChunk, type ContentBlock, type TokenUsage, type FinishReason, type LlmModelInfo } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import Approval from '@deepseek-ai/dsh-user-approval';
import Commands from '@deepseek-ai/dsh-commands';
import Skills from '@deepseek-ai/dsh-skill';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import type LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Agent, type AgentProfile, type Message, type HostAgent } from '../../packages/dsh-flow/src/core/index.js';
import { USER, sessionID } from '../../packages/dsh-flow/src/core/message.js';
import { DshHostAdaptor, type DshHostAdaptorOptions } from '../../packages/dsh-flow/src/host/index.js';
import { NativePreparation } from '../../packages/dsh-flow/src/host/provisioning.js';
import type { NativeRunSeed } from '../../packages/dsh-flow/src/host/native-types.js';

export type FixtureAnswer = string | { tool: string; args: Record<string, unknown> };
export type FixtureScript = (options: GenerateOptions, index: number) => FixtureAnswer | Promise<FixtureAnswer>;
export const validSummary = 'Flow 上下文总结 v1\n来源：fixture\n\n' + ['目标与约束', '已知事实与关键决策', '当前进展与已有产物', '关键文件、资源及定位信息', '未完成事项与后续步骤', '分歧、风险与待确认信息'].map(heading => `## ${heading}\n无`).join('\n\n');
export const input = (text: string): Message => ({ source: USER, timestamp: Date.now(), read: false, read_timestamp: null, summary: text.slice(0, 50), payload: text });
export function profile(name: string = randomUUID(), permission: AgentProfile['permission'] = 'workspace-write'): AgentProfile {
  return { role: 'Handle the test task with Flow communication tools.', sessionID: sessionID(name), name, permission,
    model: { provider: 'fixture', id: 'model' }, params: { version: 1, reasoningEffort: 'medium', temperature: 0.2, maxTokens: 500 } };
}
export async function until(predicate: () => boolean, message = 'runtime condition'): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), message);
}
export class FixtureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  inputModalities: LlmModelInfo['inputModalities'] = ['text', 'image'];
  script: FixtureScript = () => 'DONE';
  usage: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 };
  failAfterUsage = false;
  finishReason?: FinishReason;
  override async listModels(provider: string) { return [{ provider, id: 'model', name: 'Fixture', ...(this.inputModalities === undefined ? {} : { inputModalities: this.inputModalities }), reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] } }]; }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Fixture', ...(this.inputModalities === undefined ? {} : { inputModalities: this.inputModalities }), reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] } }; }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const answer = await this.script(options, this.requests.length - 1);
    options.signal?.throwIfAborted();
    const block: ContentBlock = typeof answer === 'string' ? { type: 'text', text: answer }
      : { type: 'tool-call', id: ToolCallId(randomUUID()), name: answer.tool, arguments: JSON.stringify(answer.args) };
    yield { type: 'block-start', index: 0, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
    else if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'usage', usage: this.usage };
    if (this.failAfterUsage) throw new Error('Fixture provider stream failure');
    yield { type: 'finish', reason: this.finishReason ?? { kind: typeof answer === 'string' ? 'stop' : 'tool-calls' } };
  }
}
export async function runtime(t: TestContext, options: Partial<DshHostAdaptorOptions> & { persistence?: boolean; directory?: string; filesystem?: typeof LocalFileSystem } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'flow-contract-runtime-'));
  const host = new DshContext();
  await host.plugin(LlmRuntime);
  await host.plugin(SessionStore);
  await host.plugin(SessionProjection);
  await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await host.plugin(ToolRuntime);
  await host.plugin(AgentRegistry);
  await host.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: directory });
  await host.plugin(Approval, { policy: 'ask' });
  await host.plugin(Skills);
  await host.plugin(options.filesystem ?? SandboxedFileSystem, { cwd: directory });
  await host.plugin(Commands);
  if (options.persistence !== false) await host.plugin(SessionPersistence, { root: join(directory, 'sessions'), compression: 'none' });
  await host.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 });
  const model = new FixtureModel(); const modelRegistration = host.llm.registerAdapter(['fixture'], model);
  const context = new Context();
  const bindings = new Map<Agent, HostAgent>();
  class RecordedAdaptor extends DshHostAdaptor {
    override async createAgent(agent: Agent, profile: AgentProfile, history?: string) {
      const handle = await super.createAgent(agent, profile, history); bindings.set(agent, handle); return handle;
    }
    override async resumeAgent(agent: Agent, id: AgentProfile['sessionID']) {
      const handle = await super.resumeAgent(agent, id); bindings.set(agent, handle); return handle;
    }
  }
  const preparation = new NativePreparation(host, context, { cwd: directory });
  const adaptor = new RecordedAdaptor(host, context, { workspaceRoot: directory, stateDirectory: join(directory, 'flow'), preparation, ...options });
  context.registerHostAdaptor(adaptor);
  const contexts = new Set([context]);
  t.after(async () => { for (const context of contexts) await context.dispose().catch(() => {}); await host.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const create = (name?: string, permission?: AgentProfile['permission']) => Agent.create(context, profile(name, permission), null);
  const createContext = (seed: NativeRunSeed, extra: Pick<DshHostAdaptorOptions, 'bindings'> = {}) => {
    const context = new Context(), preparation = new NativePreparation(host, context, seed);
    const adaptor = new RecordedAdaptor(host, context, { workspaceRoot: seed.cwd, stateDirectory: join(directory, 'flow'), ...options, ...extra, preparation });
    context.registerHostAdaptor(adaptor); contexts.add(context);
    return { context, preparation, adaptor, create: (p: AgentProfile) => Agent.create(context, p, null) };
  };
  return { host, context, adaptor, preparation, createContext, model, modelRegistration, directory, create, hostAgent: (agent: Agent) => { const handle = bindings.get(agent); assert.ok(handle); return handle; },
    native: (agent: Agent) => { const native = host.agents.get(SessionId(agent.getProfile().sessionID)); assert.ok(native); return native; } };
}
