import { sessionID } from '../../packages/dsh-flow/src/core/message.js';
import { registerAuxiliaryUsageSink } from '../../packages/dsh-flow/src/core/auxiliary-usage.js';
import type { Agent, AgentProfile, HostAdaptor, HostAgent, HostEvent, Message, SessionID, Usage } from '../../packages/dsh-flow/src/core/index.js';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export function profile(session: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    role: '核验公开合同', sessionID: sessionID(session), permission: 'workspace-write', name: session,
    model: { provider: 'contract', id: 'model-a' }, params: { version: 1 }, ...overrides,
  };
}

export function message(summary: string, source: Message['source'] = { kind: 'user' }, timestamp = 100, payload: unknown = { text: summary }): Message {
  return { source, timestamp, summary, payload, read: false, read_timestamp: null };
}

export interface SendRecord {
  agent: HostAgent;
  message: Message;
  mode: 'followup' | 'steer' | 'notice';
  purpose: 'input' | 'notification';
}

export class ContractHost implements HostAdaptor {
  readonly backend = 'contract';
  readonly host = { backendContext: 'borrowed host identity' };
  readonly capabilities = { usage: true };
  readonly created: { flow: Agent; agent: HostAgent; history?: string }[] = [];
  readonly sent: SendRecord[] = [];
  readonly releases: { agent: HostAgent; mode: 'immediate' | 'after-turn' }[] = [];
  readonly listeners = new Map<HostAgent, Set<(event: Readonly<HostEvent>) => void>>();
  readonly nativeStatus = new Map<HostAgent, 'idle' | 'running'>();
  readonly closeGates = new Map<HostAgent, ReturnType<typeof deferred<void>>>();
  readonly persisted = new Map<string, AgentProfile>();
  readonly summaries: HostAgent[] = [];
  readonly merges: { agent: HostAgent; own: string; other: string }[] = [];
  readonly exports: HostAgent[] = [];
  readonly usageSettlements: { agent: HostAgent; usage: Usage[] }[] = [];
  disposed = false;
  disposeCount = 0;
  unsubscribed = 0;
  createHook?: (flow: Agent, p: AgentProfile) => Promise<void> | void;
  subscribeHook?: (agent: HostAgent) => void;
  sendHook?: (record: SendRecord) => Promise<void> | void;
  releaseHook?: (agent: HostAgent, mode: 'immediate' | 'after-turn') => void;
  summaryHook?: (agent: HostAgent) => Promise<{ summary: string; usage: Usage[] }>;
  mergeHook?: (agent: HostAgent, own: string, other: string) => Promise<{ summary: string; usage: Usage[] }>;
  exportHook?: (agent: HostAgent) => Promise<string>;

  constructor() {
    registerAuxiliaryUsageSink(this, (agent, usage) => {
      this.usageSettlements.push({ agent, usage: [...usage] });
      for (const item of usage) this.emit({ type: 'usage', agent, timestamp: item.timestamp, usage: item });
    });
  }

  async createAgent(flow: Agent, p: AgentProfile, history?: string): Promise<HostAgent> {
    flow.getMailbox();
    await this.createHook?.(flow, p);
    const agent: HostAgent = { profile: p };
    this.created.push({ flow, agent, ...(history === undefined ? {} : { history }) });
    this.nativeStatus.set(agent, 'idle');
    return agent;
  }
  resumeAgent(flow: Agent, session: SessionID): Promise<HostAgent> {
    const saved = this.persisted.get(session);
    if (!saved) return Promise.reject(new Error('session not found'));
    return this.createAgent(flow, saved);
  }
  releaseAgent(agent: HostAgent, mode: 'immediate' | 'after-turn' = 'after-turn'): Promise<void> {
    this.releases.push({ agent, mode });
    this.releaseHook?.(agent, mode);
    const gate = this.closeGates.get(agent);
    return gate?.promise ?? Promise.resolve();
  }
  async dispose(): Promise<void> { this.disposeCount++; this.disposed = true; }
  async send(agent: HostAgent, m: Message, mode: SendRecord['mode'] = 'followup', purpose: SendRecord['purpose'] = 'input'): Promise<void> {
    const record = { agent, message: m, mode, purpose };
    this.sent.push(record);
    await this.sendHook?.(record);
  }
  getStatus(agent: HostAgent): 'idle' | 'running' {
    const status = this.nativeStatus.get(agent);
    if (!status) throw new Error('foreign HostAgent');
    return status;
  }
  async whenIdle(_agent: HostAgent): Promise<void> {}
  async persist(agent: HostAgent): Promise<void> { this.persisted.set(agent.profile.sessionID, structuredClone(agent.profile)); }
  async exportHistory(agent: HostAgent): Promise<string> {
    this.exports.push(agent);
    return this.exportHook ? this.exportHook(agent) : 'contract-history-v1: recorded dialogue';
  }
  async summarizeContext(agent: HostAgent): Promise<{ summary: string; usage: Usage[] }> {
    this.summaries.push(agent);
    return this.summaryHook ? this.summaryHook(agent) : { summary: `summary:${agent.profile.sessionID}`, usage: [] };
  }
  async mergeContextSummaries(agent: HostAgent, own: string, other: string): Promise<{ summary: string; usage: Usage[] }> {
    this.merges.push({ agent, own, other });
    return this.mergeHook ? this.mergeHook(agent, own, other) : { summary: 'merged context', usage: [] };
  }
  subscribe(agent: HostAgent, listener: (event: Readonly<HostEvent>) => void): () => void {
    this.subscribeHook?.(agent);
    const listeners = this.listeners.get(agent) ?? new Set();
    this.listeners.set(agent, listeners);
    listeners.add(listener);
    return () => { if (listeners.delete(listener)) this.unsubscribed++; };
  }
  native(agent: Agent): HostAgent {
    const match = this.created.find(item => item.flow === agent);
    if (!match) throw new Error('no native binding for Flow Agent');
    return match.agent;
  }
  status(agent: Agent, status: 'idle' | 'running'): void {
    const native = this.native(agent);
    this.nativeStatus.set(native, status);
    this.emit({ type: 'status', agent: native, timestamp: Date.now(), status });
  }
  turnEnd(agent: Agent): void {
    this.emit({ type: 'turn-end', agent: this.native(agent), timestamp: Date.now(), reason: 'completed' });
  }
  emit(event: HostEvent): void {
    for (const listener of this.listeners.get(event.agent) ?? []) listener(event);
  }
}
