import { Agent } from '../core/agent.js';
import { Group } from '../core/group.js';
import { beginConstruction, assertNoPendingConstruction } from '../core/construction.js';
import { agentControl, createOwned } from '../core/internals.js';
import { newSessionID } from '../core/message.js';
import { checkPermission, snapshotProfile } from '../core/profile.js';
import type { AgentProfile } from '../core/types.js';
import { assertJson, digestJson } from '../assignments/schema.js';
import { contextRun, runState, type RunState } from '../run/internal.js';
import type { Run } from '../run/run.js';
import { expandPattern } from './expand.js';
import { catalogControl, definitionDigest, PatternError } from './internal.js';
import type { PatternApplyRequest } from './types.js';

export interface PatternApplyResult {
  readonly agents: Record<string, Agent>;
  readonly groups: Record<string, Group>;
  readonly instructions: string;
}
export interface PatternApplyFailure { readonly path: string; readonly error: unknown }
/** Original failure and cleanup failures remain available without losing object identities. */
export class PatternApplyError extends Error {
  readonly created: Readonly<{ agents: Record<string, Agent>; groups: Record<string, Group> }>;
  constructor(readonly path: string, cause: unknown, created: { agents: Record<string, Agent>; groups: Record<string, Group> },
    readonly cleanupErrors: readonly unknown[] = []) {
    super(`Pattern application failed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'PatternApplyError';
    this.created = Object.freeze({ agents: Object.freeze(Object.fromEntries(Object.entries(created.agents).filter(([path]) => path !== 'root'))), groups: Object.freeze({ ...created.groups }) });
  }
  get failures(): readonly PatternApplyFailure[] { return [{ path: this.path, error: this.cause }]; }
}
interface Entry { readonly digest: string; readonly promise: Promise<PatternApplyResult> }
const requests = new WeakMap<Run, WeakMap<Agent, Map<string, Entry>>>();
const queues = new WeakMap<Run, Promise<void>>();
function assertReady(state: RunState, root: Agent): void {
  if (!state.context || root[agentControl].context !== state.context || !state.context.has(root) || root.getStatus() === 'terminated') throw new Error('Pattern root is unavailable in its Run');
  assertNoPendingConstruction(root);
  if (!state.accepting || state.record.status !== 'active' || state.runtimeStatus && state.runtimeStatus !== 'active') throw new Error('Run is not active');
  state.dependencies.store.assertWritable(state.record.id);
}

/** Register before yielding; replay shares the exact settled or pending Promise. */
export function applyPattern(root: Agent, request: PatternApplyRequest, requestId: string): Promise<PatternApplyResult> {
  try {
    if (!(root instanceof Agent)) throw new TypeError('Pattern root must be an Agent');
    if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('requestId must be nonempty');
    if (!request || typeof request !== 'object') throw new TypeError('Pattern request must be an object');
    for (const field of Object.keys(request)) if (!['definition', 'parameters', 'overrides'].includes(field)) throw new TypeError(`Unknown pattern request field ${field}`);
    const run = contextRun(root[agentControl].context), state = runState(run);
    const input = { parameters: request.parameters ?? {}, overrides: request.overrides ?? {} };
    assertJson(input);
    const snapshot = structuredClone(input);
    const definition = request.definition;
    const digest = digestJson({ definition: definitionDigest(definition), parameters: snapshot.parameters, overrides: snapshot.overrides });
    let byRoot = requests.get(run);
    if (!byRoot) { byRoot = new WeakMap(); requests.set(run, byRoot); }
    let byKey = byRoot.get(root);
    if (!byKey) { byKey = new Map(); byRoot.set(root, byKey); }
    const previous = byKey.get(requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error('requestId was reused with different pattern parameters');
      return previous.promise;
    }
    assertReady(state, root);
    state.patternCatalog[catalogControl].assertVisible(definition);
    let resolve!: (value: PatternApplyResult) => void, reject!: (error: unknown) => void;
    const promise = new Promise<PatternApplyResult>((yes, no) => { resolve = yes; reject = no; });
    byKey.set(requestId, { digest, promise });
    const prior = queues.get(run) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const agents: Record<string, Agent> = Object.create(null), groups: Record<string, Group> = Object.create(null);
      let path = 'root', scope: ReturnType<typeof beginConstruction> | undefined;
      try {
        assertReady(state, root);
        state.patternCatalog[catalogControl].assertVisible(definition);
        const plan = expandPattern(definition, snapshot.parameters, snapshot.overrides, state.record.defaults, root.getProfile());
        const profiles = new Map<string, Readonly<AgentProfile>>([['root', root.getProfile()]]);
        for (const node of plan.nodes) {
          path = node.path;
          const parent = profiles.get(node.parent);
          if (!parent) throw new Error(`Unknown planned parent ${node.parent}`);
          const profile = snapshotProfile({ ...node.config, sessionID: newSessionID() });
          checkPermission(profile, parent); profiles.set(node.path, profile);
          await state.dependencies.patternRoleValidator.validate(profile, node.requirements);
          assertReady(state, root);
        }
        assertReady(state, root);
        scope = beginConstruction(state.context!, root);
        agents.root = root;
        for (const node of plan.nodes) {
          path = node.path;
          const parent = agents[node.parent];
          if (!parent) throw new Error(`Unknown created parent ${node.parent}`);
          const agent = await Agent[createOwned](scope, profiles.get(node.path)!, parent);
          agents[node.path] = agent;
          assertReady(state, root);
          if (agent.getStatus() !== 'idle') throw new Error('New pattern member must be idle');
        }
        for (const spec of plan.groups) {
          path = spec.key;
          assertReady(state, root);
          groups[spec.key] = Group[createOwned](scope, spec.members.map(member => {
            const agent = agents[member];
            if (!agent) throw new Error(`Unknown group member ${member}`);
            return agent;
          }));
        }
        path = 'commit';
        assertReady(state, root);
        const flush = scope.commit();
        const result = Object.freeze({ agents: Object.freeze(agents), groups: Object.freeze(groups), instructions: plan.instructions });
        resolve(result);
        try { flush(); } catch {  }
      } catch (error) {
        const cleanup: unknown[] = [];
        if (scope) { try { await scope.abort(); } catch (failure) { cleanup.push(...(failure instanceof AggregateError ? failure.errors : [failure])); } }
        reject(new PatternApplyError(error instanceof PatternError ? error.path : path, error, { agents, groups }, cleanup));
      }
    });
    queues.set(run, operation.catch(() => {}));
    return promise;
  } catch (error) { return Promise.reject(error); }
}
