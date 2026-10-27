import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Agent, Context, type AgentProfile } from '../../packages/dsh-flow/src/core/index.js';
import { RunService, type Run } from '../../packages/dsh-flow/src/run/index.js';
import { issueHostOrigin } from '../../packages/dsh-flow/src/run/internal.js';
import { RunStore } from '../../packages/dsh-flow/src/run/store.js';
import { withTrustedCall } from '../../packages/dsh-flow/src/assignments/internal.js';
import type { Assignment } from '../../packages/dsh-flow/src/assignments/index.js';
import type { AssignmentSpec, AssignmentSubmission } from '../../packages/dsh-flow/src/assignments/types.js';
import { PatternCatalog } from '../../packages/dsh-flow/src/patterns/catalog.js';
import { ContractPatternRoleValidator } from './contract-patterns.js';
import { ContractHost, profile } from './contract-host.js';

type ServiceOptions = ConstructorParameters<typeof RunService>[0];
type Defaults = Parameters<RunService['create']>[1];
type Origin = Parameters<RunService['create']>[0];
type StoreOptions = NonNullable<ConstructorParameters<typeof RunStore>[1]>;
type FaultStage = Parameters<NonNullable<StoreOptions['fault']>>[0];
export type RunBinding = { context: Context; host: ContractHost; root: Agent };
export type RunFixtureOptions = Partial<Pick<ServiceOptions, 'validateMaterials' | 'onTopLevelOutcome' | 'patternCatalog' | 'patternRoleValidator'>> & {
  directory?: string;
  originDefaults?: Defaults | ServiceOptions['getOriginDefaults'];
  onInitialize?: (run: Run, defaults: Defaults, environment: Omit<RunBinding, 'root'>) => Promise<void> | void;
};

export function spec(overrides: Partial<AssignmentSpec> = {}): AssignmentSpec {
  return {
    name: '合同核验', type: 'analysis', background: '验证团队运行的公开合同',
    requirements: '返回独立可读的结果', acceptanceCriteria: '结果符合指定 schema',
    resultSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    ...overrides,
  };
}

export async function waitFor(predicate: () => boolean, description = 'Run transition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.ok(predicate(), description);
}

export async function runFixture(t: TestContext, options: RunFixtureOptions = {}) {
  const ownedDirectory = options.directory === undefined;
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'flow-contract-run-'));
  const environments = new Map<Run, Omit<RunBinding, 'root'>>();
  let fault: { stage: FaultStage; error: Error; runId?: string } | undefined;
  const store = new RunStore(directory, {
    fault: (stage, runId) => {
      if (fault && fault.stage === stage && (fault.runId === undefined || fault.runId === runId)) throw fault.error;
    },
  });
  const base: Defaults = {
    model: { provider: 'contract', id: 'session-model' },
    params: { version: 1, reasoningEffort: 'medium', temperature: 0.3, maxTokens: 500 },
    permission: 'workspace-write', hostExtras: { sandbox: { workspace: directory } },
  };
  const configuredDefaults = options.originDefaults;
  const service = new RunService({
    store,
    patternCatalog: options.patternCatalog ?? new PatternCatalog({ includeBuiltins: false }),
    patternRoleValidator: options.patternRoleValidator ?? new ContractPatternRoleValidator(),
    getOriginDefaults: typeof configuredDefaults === 'function'
      ? configuredDefaults : () => configuredDefaults ?? base,
    initialize: async (run, defaults, context) => {
      const host = new ContractHost();
      context.registerHostAdaptor(host);
      environments.set(run, { context, host });
      await options.onInitialize?.(run, defaults, { context, host });
      const root = await Agent.create(context, profile(`root-${run.id}`, {
        model: defaults.model ?? base.model!, params: defaults.params ?? base.params!,
        permission: defaults.permission ?? base.permission!,
        ...(defaults.hostExtras === undefined ? {} : { hostExtras: defaults.hostExtras }),
      }), null);
      return root;
    },
    ...(options.validateMaterials === undefined ? {} : { validateMaterials: options.validateMaterials }),
    ...(options.onTopLevelOutcome === undefined ? {} : { onTopLevelOutcome: options.onTopLevelOutcome }),
  });
  t.after(async () => {
    fault = undefined;
    await Promise.allSettled([...environments.values()].map(({ context }) => context.dispose()));
    if (ownedDirectory) await rm(directory, { recursive: true, force: true });
  });
  const origin = (session = 'main', backend = 'contract') => issueHostOrigin({ backend, callerSessionId: session });
  const binding = (run: Run): RunBinding => {
    const environment = environments.get(run);
    assert.ok(environment, 'initializer has created the Run environment');
    assert.ok(run.root, 'Run root is ready');
    return { ...environment, root: run.root };
  };
  const createActive = async (defaults: Defaults = {}, requestId: string = randomUUID(), owner: Origin = origin()) => {
    const run = service.create(owner, defaults, requestId);
    await waitFor(() => run.status !== 'starting');
    assert.equal(run.status, 'active', 'Run initializes successfully');
    return run;
  };
  return {
    service, store, directory, origin, binding, createActive, spec,
    environment: (run: Run) => { const value = environments.get(run); assert.ok(value); return value; },
    failWrites: (stage: FaultStage, error: Error, runId?: string) => { fault = { stage, error, ...(runId === undefined ? {} : { runId }) }; },
    clearFault: () => { fault = undefined; },
    child: async (run: Run, parent: Agent = binding(run).root, overrides: Partial<AgentProfile> = {}) => {
      const { context } = binding(run);
      return Agent.create(context, profile(`child-${randomUUID()}`, { ...parent.getProfile(), ...overrides, sessionID: profile(randomUUID()).sessionID }), parent);
    },
    submit: (run: Run, actor: Agent, assignment: Assignment, result: AssignmentSubmission['result'], transportKey: string = randomUUID(), continuingChildren: AssignmentSubmission['continuingChildren'] = []) => {
      assert.ok(run.assignments);
      return withTrustedCall({ actor, transportKey }, () => run.assignments!.submit(actor, assignment, { result, continuingChildren }));
    },
  };
}
