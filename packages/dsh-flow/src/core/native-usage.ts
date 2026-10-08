/** Passive projection of durable host Session facts. This module never sends a model request. */
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { FlowAgentRole, FlowJsonValue, FlowNativeContext, FlowUsageEvent, FlowUsageSummary } from '../types.ts';

export interface NativeUsageProjection {
  readonly clusterId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly role: FlowAgentRole;
  readonly nativeSessionId: string;
  readonly transactionId?: string | null;
  readonly events: readonly SessionEvent[];
  readonly contextSnapshot?: NativeContextSnapshot;
}

/** An existing host projection at the same durable event cut. Flow never computes its estimate. */
export interface NativeContextSnapshot {
  readonly nativeSeq: number;
  readonly projectedTokens?: number;
  readonly pressureTokens?: number;
  readonly contextWindow?: number;
}

/** The persisted host event, associated once with its Flow identity and domain. */
export interface NativeSessionFact {
  readonly native_session_id: string;
  readonly native_seq: number;
  readonly cluster_id: string;
  readonly agent_id: string;
  readonly node_id: string;
  readonly transaction_id: string | null;
  readonly role: FlowAgentRole;
  readonly type: string;
  readonly data: FlowJsonValue;
  readonly time: number;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One native attempt becomes exactly one settlement event; steps are never the deduplication key. */
export function nativeUsageEvents(facts: readonly NativeSessionFact[]): FlowUsageEvent[] {
  const headers = new Map<string, Record<string, unknown>>();
  const events: FlowUsageEvent[] = [];
  for (const fact of [...facts].sort((a, b) => a.native_session_id.localeCompare(b.native_session_id) || a.native_seq - b.native_seq)) {
    const data = object(fact.data);
    if (fact.type === 'request/header') {
      headers.set(fact.native_session_id, object(object(data.header).config));
      continue;
    }
    if (fact.type !== 'assistant/message' && fact.type !== 'assistant/attempt' && fact.type !== 'compaction/summary') continue;
    const header = headers.get(fact.native_session_id) ?? {};
    const source = fact.type === 'assistant/message' ? object(object(data.message).source)
      : fact.type === 'compaction/summary' ? data : header;
    const usage = fact.type === 'assistant/attempt'
      ? object(Array.isArray(data.stream) ? lastAssistantStreamChunk(data.stream as AssistantStreamRecord[], 'usage')?.usage : undefined)
      : object(data.usage);
    const provider = text(source.provider);
    const model = text(source.model);
    const sameHeader = provider === text(header.provider) && model === text(header.model);
    const reasoning = fact.type === 'compaction/summary' ? null : sameHeader ? text(header.reasoningEffort) : null;
    const prompt = tokens(usage.inputTokens);
    const completion = tokens(usage.outputTokens);
    const read = tokens(usage.cacheReadTokens);
    const write = tokens(usage.cacheWriteTokens);
    const total = tokens(usage.totalTokens);
    const interrupted = data.interrupted === true;
    events.push({
      native_session_id: fact.native_session_id, native_seq: fact.native_seq, event_type: fact.type,
      cluster_id: fact.cluster_id, agent_id: fact.agent_id, node_id: fact.node_id,
      transaction_id: fact.transaction_id, role: fact.role, provider, model, reasoning_effort: reasoning,
      prompt_tokens: prompt, completion_tokens: completion, cache_read_tokens: read, cache_write_tokens: write,
      cached_tokens: read === null || write === null ? null : read + write,
      reasoning_tokens: tokens(usage.reasoningTokens), total_tokens: total,
      completeness: interrupted || fact.type === 'assistant/attempt' || prompt === null || completion === null || total === null
        || read === null || write === null || tokens(usage.reasoningTokens) === null
        ? 'incomplete' : 'complete',
      interrupted, created: fact.time,
    });
  }
  return events;
}

const TOKEN_FIELDS = ['total_tokens', 'prompt_tokens', 'completion_tokens', 'cached_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const;

/** Known parts are retained. A missing total stays missing and never adds reasoning twice. */
export function summarizeNativeUsage(facts: readonly NativeSessionFact[]): FlowUsageSummary {
  const events = nativeUsageEvents(facts);
  const totals: { [K in typeof TOKEN_FIELDS[number]]: number | null } = {
    total_tokens: null, prompt_tokens: null, completion_tokens: null, cached_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null,
  };
  for (const event of events) for (const key of TOKEN_FIELDS) {
    const value = event[key];
    if (value !== null) totals[key] = (totals[key] ?? 0) + value;
  }
  const compactions = new Map<string, { start: boolean; summary: boolean; end: boolean; error: boolean }>();
  let incomplete = events.some(event => event.completeness === 'incomplete');
  let requests = events.filter(event => event.event_type !== 'compaction/summary').length;
  for (const fact of facts) {
    const data = object(fact.data);
    if (fact.type === 'turn/end' && ['error', 'interrupted', 'aborted'].includes(String(object(data.reason).kind))) incomplete = true;
    if (!['compaction/start', 'compaction/summary', 'compaction/end'].includes(fact.type)) continue;
    const key = `${fact.native_session_id}:${String(data.compactionId)}`;
    const state = compactions.get(key) ?? { start: false, summary: false, end: false, error: false };
    if (fact.type === 'compaction/start') state.start = true;
    if (fact.type === 'compaction/summary') {
      state.summary = true;
      // The host's explicit call marker is the only evidence that a summary made a model call.
      if (data.llmStreamCall === true) requests += 1;
    }
    if (fact.type === 'compaction/end') { state.end = true; state.error = typeof data.error === 'string'; }
    compactions.set(key, state);
  }
  for (const state of compactions.values()) if (!state.start || !state.summary || !state.end || state.error) incomplete = true;
  return { requests, ...totals, completeness: incomplete ? 'incomplete' : events.length ? 'complete' : 'unknown' };
}

/** Read only host facts: route capacity can be unknown, and no configured route is reported as actual. */
export function nativeContext(facts: readonly NativeSessionFact[]): FlowNativeContext {
  let contextLimit: number | null = null;
  let compactedAt: number | null = null;
  const summaries = new Map<string, number>();
  for (const fact of [...facts].sort((a, b) => a.time - b.time || a.native_seq - b.native_seq)) {
    const data = object(fact.data);
    if (fact.type === 'request/context') contextLimit = tokens(data.contextWindow);
    const compaction = `${fact.native_session_id}:${String(data.compactionId)}`;
    if (fact.type === 'compaction/summary') summaries.set(compaction, fact.time);
    if (fact.type === 'compaction/end' && typeof data.error !== 'string') compactedAt = summaries.get(compaction) ?? compactedAt;
  }
  const actual = nativeUsageEvents(facts).filter(event => event.event_type !== 'compaction/summary')
    .sort((a, b) => a.created - b.created || a.native_seq - b.native_seq).at(-1);
  return {
    context_used: null, context_limit: contextLimit, compacted_at: compactedAt,
    model: actual?.model ?? null, provider: actual?.provider ?? null, reasoning_effort: actual?.reasoning_effort ?? null,
    native_session_id: actual?.native_session_id ?? null, native_seq: actual?.native_seq ?? null,
  };
}
