import { randomUUID } from 'node:crypto';
import { snapshotProfile } from './profile.js';
import { bufferConstructionObservation } from './construction.js';
import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Group } from './group.js';
import type { AgentProfile, AgentStatus, HostEvent, Message, MessageMeta, Signal } from './types.js';

export type AgentOrigin = 'create' | 'resume' | 'fork' | 'herb' | 'retry';
export type AgentOutcome = 'completed' | 'failed' | 'stopped';
export interface AgentAppearance { readonly id: string; readonly profile: Readonly<AgentProfile>; readonly parentId: string | null; readonly origin: AgentOrigin; readonly sourceIds: readonly string[]; readonly createdAt: number; readonly resumeSessionID?: string }
const identities = new WeakMap<Agent, string>();
const committedAppearances = new WeakSet<Agent>();
const appearances = new WeakMap<Agent, Readonly<AgentAppearance>>();
export function getAgentInstanceId(agent: Agent): string { let id = identities.get(agent); if (!id) { id = randomUUID(); identities.set(agent, id); } return id; }
export function setAgentAppearance(agent: Agent, profile: Readonly<AgentProfile>, parent: Agent | null, origin: AgentOrigin, sources: readonly Agent[], createdAt: number, resumeSessionID?: string, committed = true, sourceIds?: readonly string[]): void {
  if (appearances.has(agent)) throw new Error('Agent appearance is immutable');
  appearances.set(agent, Object.freeze({ id: getAgentInstanceId(agent), profile: snapshotProfile(profile), parentId: parent ? getAgentInstanceId(parent) : null, origin, sourceIds: Object.freeze(sourceIds ? [...sourceIds] : sources.map(getAgentInstanceId)), createdAt, ...(resumeSessionID ? { resumeSessionID } : {}) }));
  if (committed) commitAgentAppearance(agent);
}
export function commitAgentAppearance(agent: Agent): void { if (!appearances.has(agent)) throw new Error('Agent appearance has not been staged'); committedAppearances.add(agent); }
export function getAgentAppearance(agent: Agent): Readonly<AgentAppearance> | undefined { return committedAppearances.has(agent) ? appearances.get(agent) : undefined; }
export interface AgentTerminationFact { readonly id: string; readonly sessionID: string; readonly parentId: string | null; readonly outcome: AgentOutcome; readonly terminatedAt: number }
export interface RetrySource extends AgentTerminationFact { readonly parentId: string; readonly outcome: 'failed' }
const terminationFacts = new WeakMap<Context, Map<string, Readonly<AgentTerminationFact>>>();
export function recordAgentTermination(context: Context, agent: Agent, parentId: string | null, outcome: AgentOutcome, terminatedAt: number): void {
  const appearance = getAgentAppearance(agent); if (!appearance) return;
  let facts = terminationFacts.get(context); if (!facts) { facts = new Map(); terminationFacts.set(context, facts); }
  if (!facts.has(appearance.id)) facts.set(appearance.id, Object.freeze({ id: appearance.id, sessionID: appearance.profile.sessionID, parentId, outcome, terminatedAt }));
}
export function findRetrySource(context: Context, parentId: string, sourceId: string): Readonly<RetrySource> {
  if (typeof sourceId !== 'string' || !sourceId.trim()) throw new TypeError('retryOf must be an instance UUID');
  const source = terminationFacts.get(context)?.get(sourceId);
  if (!source || source.outcome !== 'failed' || source.parentId !== parentId) throw new Error('Retry source must be a committed failed instance last parented by the caller in this Context');
  return Object.freeze({ ...source, parentId: source.parentId, outcome: 'failed' });
}


export type CoreObservation = { timestamp: number } & (
  | { type: 'agent-created'; agent: Agent; parent: Agent | null; origin: AgentOrigin; sources: Agent[]; sourceIds: readonly string[] }
  | { type: 'agent-status'; agent: Agent; status: AgentStatus }
  | { type: 'agent-terminated'; agent: Agent; signal: Signal; outcome: AgentOutcome; initiator: 'user' | 'parent' | 'context' | 'self'; mode: 'after-turn' | 'immediate'; propagated: boolean }
  | { type: 'agent-wait'; agent: Agent; waiting: { target: string; startedAt: number; deadline: number } | null }
  | { type: 'host-cleanup'; agent: Agent; phase: 'pending' | 'waiting' | 'releasing' | 'complete' | 'failed' | 'abandoned'; reason?: string; deadline?: number; persistenceError?: string }
  | { type: 'blackboard-write'; agent: Agent; group: Group; id: string; active: boolean }
  | { type: 'context-release'; phase: 'started' | 'complete' | 'failed'; error?: string }
  | { type: 'agent-parent'; agent: Agent; previous: Agent; parent: Agent }
  | { type: 'host-event'; agent: Agent; event: Readonly<HostEvent> }
  | { type: 'message-received' | 'message-read'; agent: Agent; message: MessageMeta }
  | { type: 'group-created'; group: Group; members: Agent[] }
  | { type: 'group-member-left'; group: Group; agent: Agent }
  | { type: 'group-blackboard'; group: Group; message: Message }
  | { type: 'group-released'; group: Group }
);
const listeners = new WeakMap<Context, Set<(event: Readonly<CoreObservation>) => void>>();
export function observeCore(context: Context, listener: (event: Readonly<CoreObservation>) => void): () => void {
  let set = listeners.get(context);
  if (!set) { set = new Set(); listeners.set(context, set); }
  set.add(listener);
  return () => { set.delete(listener); };
}
const observedContexts = new WeakSet<Context>();
export function hasCoreObservations(context: Context): boolean { return observedContexts.has(context); }
const dispatching = new WeakMap<Context, { queue: CoreObservation[]; active: boolean }>();
export function emitCore(context: Context, event: CoreObservation): void {
  const dispatch = () => {
    let state = dispatching.get(context);
    if (!state) { state = { queue: [], active: false }; dispatching.set(context, state); }
    state.queue.push(event);
    if (state.active) return;
    state.active = true;
    try {
      while (state.queue.length) {
        const next = state.queue.shift()!;
        observedContexts.add(context);
        for (const listener of [...(listeners.get(context) ?? [])]) { try { listener(next); } catch {} }
      }
    } finally { state.active = false; }
  };
  if (!bufferConstructionObservation(event, dispatch)) dispatch();
}
