import { bufferConstructionObservation } from './construction.js';
import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Group } from './group.js';
import type { AgentStatus, HostEvent, Message, MessageMeta, Signal } from './types.js';

export type CoreObservation = { timestamp: number } & (
  | { type: 'agent-created'; agent: Agent; parent: Agent | null; origin: 'create' | 'resume' | 'fork' | 'herb'; sources: Agent[] }
  | { type: 'agent-status'; agent: Agent; status: AgentStatus }
  | { type: 'agent-terminated'; agent: Agent; signal: Signal }
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
export function emitCore(context: Context, event: CoreObservation): void {
  const dispatch = () => {
    for (const listener of [...(listeners.get(context) ?? [])]) {
      try { listener(event); } catch {}
    }
  };
  if (!bufferConstructionObservation(event, dispatch)) dispatch();
}
