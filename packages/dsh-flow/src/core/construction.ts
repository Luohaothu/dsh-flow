import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Group } from './group.js';
import type { Mailbox } from './mailbox.js';
import { agentControl, contextControl, groupControl, mailboxControl } from './internals.js';
import { commitAgentAppearance, type CoreObservation } from './observation.js';
import type { MessageSource } from './types.js';

type Resource = Agent | Group | Mailbox;
type Kind = 'agent' | 'group' | 'mailbox';
export interface ConstructionScope {
  readonly context: Context;
  readonly root: Agent;
  commit(): () => void;
  abort(): Promise<void>;
}
interface ConstructionState {
  context: Context;
  root: Agent;
  phase: 'open' | 'aborting' | 'committed';
  objects: Map<Resource, Kind>;
  attempts: Set<Promise<void>>;
  events: (() => void)[];
  cleanupErrors: { object: Resource; cause: unknown }[];
  unsubscribe: () => void;
  abortPromise?: Promise<void>;
}
const states = new WeakMap<ConstructionScope, ConstructionState>();
const owners = new WeakMap<object, ConstructionScope>();

function stateOf(scope: ConstructionScope): ConstructionState {
  const state = states.get(scope);
  if (!state) throw new Error('Invalid construction owner');
  return state;
}
export function assertConstructionScope(scope: ConstructionScope, context?: Context): void {
  const state = stateOf(scope);
  if (state.phase !== 'open' || (context && state.context !== context)) throw new Error('Construction is not open in this Context');
  state.context[contextControl].assertAvailable(state.root);
}
export function assertNoPendingConstruction(object: object): void {
  if (owners.has(object)) throw new Error('Object belongs to an uncommitted construction');
}
export function hasNoPendingConstruction(object: object): boolean { return !owners.has(object); }
export function assertConstructionAccess(object: object, scope?: ConstructionScope): void {
  const owner = owners.get(object);
  if (!owner) return;
  if (!scope || owner !== scope) throw new Error('Object belongs to an uncommitted construction');
  assertConstructionScope(scope);
}
export function assertConstructionParticipant(scope: ConstructionScope, agent: Agent): void {
  assertConstructionScope(scope);
  const state = stateOf(scope);
  if (agent !== state.root && owners.get(agent) !== scope) throw new Error('Agent is not owned by this construction');
  state.context[contextControl].assertAvailable(agent, scope);
}
export function ownConstructionResource(scope: ConstructionScope, object: Resource, kind: Kind): void {
  assertConstructionScope(scope);
  if (owners.has(object)) throw new Error('Construction resource is already owned');
  owners.set(object, scope); stateOf(scope).objects.set(object, kind);
}
export function beginConstructionAttempt(scope: ConstructionScope): () => void {
  assertConstructionScope(scope);
  const state = stateOf(scope);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  state.attempts.add(pending);
  return () => { state.attempts.delete(pending); finish(); };
}
export function recordConstructionCleanupFailure(scope: ConstructionScope | undefined, object: Resource, cause: unknown): void {
  if (!scope) return;
  const errors = stateOf(scope).cleanupErrors;
  if (!errors.some(error => error.object === object && error.cause === cause)) errors.push({ object, cause });
}
export function assertConstructionSource(source: MessageSource): void {
  assertNoPendingConstruction(source);
  if ('agent' in source && 'g' in source) {
    assertNoPendingConstruction(source.agent); assertNoPendingConstruction(source.g);
  }
}
export function bufferConstructionObservation(event: CoreObservation, dispatch: () => void): boolean {
  const owner = ('agent' in event ? owners.get(event.agent) : undefined) ?? ('group' in event ? owners.get(event.group) : undefined);
  if (!owner) return false;
  const state = stateOf(owner);
  if (state.phase === 'open') state.events.push(dispatch);
  return true;
}
export function beginConstruction(context: Context, root: Agent): ConstructionScope {
  context[contextControl].assertAvailable(root);
  const state: ConstructionState = { context, root, phase: 'open', objects: new Map(), attempts: new Set(), events: [], cleanupErrors: [], unsubscribe: () => {} };
  const scope: ConstructionScope = Object.freeze({
    context, root,
    commit: () => {
      assertConstructionScope(scope, context);
      if (state.attempts.size) throw new Error('Construction initialization is still pending');
      for (const [object, kind] of state.objects) {
        if (!context[contextControl].has(object)) throw new Error('Construction resource is releasing or unregistered');
        if (kind === 'agent') {
          const agent = object as Agent;
          context[contextControl].assertAvailable(agent, scope);
          if (agent[agentControl].status !== 'idle') throw new Error('Construction Agent is not idle');
        } else if (kind === 'group' ? (object as Group)[groupControl].closed : (object as Mailbox)[mailboxControl].closed) throw new Error('Construction resource is closed');
      }
      assertConstructionScope(scope, context);
      for (const object of state.objects.keys()) if (!context[contextControl].has(object)) throw new Error('Construction resource is no longer available');
      state.phase = 'committed';
      for (const [object, kind] of state.objects) { if (kind === 'agent') commitAgentAppearance(object as Agent); owners.delete(object); }
      state.unsubscribe();
      const events = state.events.splice(0);
      let flushed = false;
      return () => { if (flushed) return; flushed = true; for (const dispatch of events) dispatch(); };
    },
    abort: () => {
      if (state.abortPromise) return state.abortPromise;
      if (state.phase === 'committed') return state.abortPromise = Promise.resolve();
      state.phase = 'aborting'; state.events = []; state.unsubscribe();
      let resolve!: () => void; let reject!: (error: unknown) => void;
      state.abortPromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const clean = async (object: Resource, kind: Kind) => {
        try {
          if (kind === 'group') {
            if (context[contextControl].registered(object)) await context.release(object as Group);
            else await (object as Group)[groupControl].close();
          }
          else if (kind === 'agent') await (object as Agent)[agentControl].release('SIGKILL');
        } catch (cause) { recordConstructionCleanupFailure(scope, object, cause); }
      };
      const closing = async () => {
        const objects = [...state.objects];
        for (const [object, kind] of objects) if (kind === 'group') await clean(object, kind);
        for (const [object, kind] of objects.reverse()) if (kind === 'agent') await clean(object, kind);
        await Promise.all([...state.attempts]);
        if (state.cleanupErrors.length) throw new AggregateError(state.cleanupErrors.map(({ object, cause }) => Object.assign(new Error('Construction resource cleanup failed', { cause }), { object })), 'Construction cleanup failed');
      };
      void closing().then(resolve, reject);
      return state.abortPromise;
    },
  });
  states.set(scope, state);
  state.unsubscribe = context.onAgentTerminated(agent => { if (agent === root && state.phase === 'open') { state.phase = 'aborting'; state.events = []; } });
  return scope;
}
