import type { Agent } from './agent.js';
import type { Group } from './group.js';
import type { Mailbox } from './mailbox.js';

export type Timestamp = number;
declare const businessID: unique symbol;
export type SessionID = string & { readonly [businessID]: 'session' };
export type GroupID = string & { readonly [businessID]: 'group' };
export type MessageID = string & { readonly [businessID]: 'message' };
export type AgentPermission = 'read-only' | 'workspace-write' | 'full-access';
export type AgentStatus = 'running' | 'waiting' | 'idle' | 'terminated';
export type MessagePriority = 'normal' | 'high' | 'low';
export type Signal = 'SIGTERM' | 'SIGKILL';
export type ReleaseMode = 'after-turn' | 'immediate';
export type SendMode = 'followup' | 'steer' | 'notice';
export type SendPurpose = 'input' | 'notification';
export type Model = Readonly<{ provider: string; id: string }>;
export interface ReasoningParams { version: 1; temperature?: number; reasoningEffort?: string; maxTokens?: number }
export type HostExtras = Readonly<Record<string, unknown>>;
export interface AgentProfile {
  role: string;
  sessionID: SessionID;
  permission: AgentPermission;
  name: string;
  model: Model;
  params: ReasoningParams;
  hostExtras?: HostExtras;
}
export type System = Readonly<{ kind: 'system' }>;
export type User = Readonly<{ kind: 'user' }>;
export type AgentInGroup = { agent: Agent; g: Group };
export type MessageSource = Agent | AgentInGroup | System | User;
export interface Message {
  source: MessageSource;
  timestamp: Timestamp;
  priority?: MessagePriority;
  read: boolean;
  read_timestamp: Timestamp | null;
  summary: string;
  payload: unknown;
}
export interface MessageMeta extends Omit<Message, 'payload' | 'priority'> { id: MessageID; priority: MessagePriority }
export type MailboxQuery = (message: Readonly<Message>) => boolean;
export type MessageFilter = MailboxQuery;
export type WaitResult = { kind: 'matched'; message: MessageMeta } | { kind: 'registered' };
export type HostContext = object;
export interface HostCapabilities { usage?: boolean; uiPanel?: boolean }
export interface HostAgent { readonly profile: Readonly<AgentProfile> }
export interface Usage {
  callId?: string;
  kind?: 'main' | 'auxiliary' | 'compaction';
  timestamp: Timestamp;
  model: Model;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}
export interface ContextSummary { summary: string; usage: Usage[] }
export type HostEvent = { agent: HostAgent; timestamp: Timestamp } & (
  | { type: 'status'; status: 'idle' | 'running' }
  | { type: 'output'; text: string }
  | { type: 'turn-end'; reason: 'completed' | 'cancelled' | 'failed' }
  | { type: 'error'; message: string }
  | { type: 'auto-reject'; message: string }
  | { type: 'usage'; usage: Usage }
);
export interface HostAdaptor {
  readonly backend: string;
  readonly host: HostContext;
  readonly capabilities: Readonly<HostCapabilities>;
  createAgent(flowAgent: Agent, p: AgentProfile, history?: string): Promise<HostAgent>;
  resumeAgent(flowAgent: Agent, session: SessionID): Promise<HostAgent>;
  releaseAgent(agent: HostAgent, mode?: ReleaseMode): Promise<void>;
  dispose(): Promise<void>;
  send(agent: HostAgent, message: Message, mode?: SendMode, purpose?: SendPurpose): Promise<void>;
  getStatus(agent: HostAgent): 'idle' | 'running';
  whenIdle(agent: HostAgent): Promise<void>;
  persist(agent: HostAgent): Promise<void>;
  exportHistory(agent: HostAgent): Promise<string>;
  summarizeContext(agent: HostAgent): Promise<ContextSummary>;
  mergeContextSummaries(agent: HostAgent, own: string, other: string): Promise<ContextSummary>;
  subscribe(agent: HostAgent, listener: (event: Readonly<HostEvent>) => void): () => void;
}
export type ContextObject = Agent | Group | Mailbox | HostContext | HostAdaptor;
export type { Agent, Group, Mailbox };
