import { randomUUID } from 'node:crypto';
import { Agent } from '../core/agent.js';
import { agentControl, contextControl } from '../core/internals.js';
import { Context } from '../core/context.js';
import { AssignmentService } from '../assignments/service.js';
import { assertJson, digestJson } from '../assignments/schema.js';
import type { Assignment, AssignmentArchiveReadResult, AssignmentOutcome, AssignmentSnapshot, AssignmentSpec } from '../assignments/types.js';
import { catalogControl } from '../patterns/internal.js';
import { bindRun, originKey, runState, verifiedOrigin, runServiceControl, type RunState, type RunReadView, type RunServiceControl } from './internal.js';
import type { HostOrigin, RunDefaults, RunRecord, RunServiceDependencies, RunSnapshot, RunStatus } from './types.js';

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function defaultsSnapshot(defaults: RunDefaults): RunDefaults {
  assertJson(defaults);
  const allowed = new Set(['model', 'params', 'permission', 'hostExtras', 'preset', 'skills']);
  for (const key of Object.keys(defaults)) if (!allowed.has(key)) throw new TypeError(`Unknown run default ${key}`);
  return structuredClone(defaults);
}
export class Run {
  constructor(readonly id: string) { Object.freeze(this); }
  get runId(): string { return this.id; }
  get status(): RunStatus { const state = runState(this); return state.runtimeStatus ?? state.record.status; }
  get context(): Context | undefined { return runState(this).context; }
  get root(): Agent | undefined { return runState(this).root; }
  get assignments(): AssignmentService | undefined { return runState(this).assignments; }
  get defaults(): RunDefaults { return structuredClone(runState(this).record.defaults); }
}
export class RunService {
  readonly epoch = randomUUID();
  private runs = new Map<string, Run>();
  private readonly observers = new Set<(view: RunReadView) => void>();
  private readonly revisions = new Map<string, number>();
  readonly [runServiceControl]: RunServiceControl = {
    enumerate: () => [...this.runs.values()].map(run => this.readView(run)),
    observe: listener => { this.observers.add(listener); return () => { this.observers.delete(listener); }; },
    snapshot: id => this.readView(this.lookup(id)),
    release: (id, epoch) => { if (epoch !== this.epoch) return Promise.reject(new Error('Run epoch expired')); const run = this.lookup(id); return this.releaseRun(run, 'user'); },
  };
  private createKeys = new Map<string, { digest: string; run: Run }>();
  constructor(private readonly dependencies: RunServiceDependencies) {}
  create(origin: HostOrigin, defaults: RunDefaults, requestId: string): Run {
    const source = verifiedOrigin(origin);
    if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('requestId must be nonempty');
    const overrides = defaultsSnapshot(defaults);
    const digest = digestJson(overrides);
    const key = JSON.stringify([originKey(source), requestId]);
    const previous = this.createKeys.get(key);
    if (previous) { if (previous.digest !== digest) throw new Error('requestId was reused with different parameters'); return previous.run; }
    const inherited = defaultsSnapshot(this.dependencies.getOriginDefaults(source));
    const effective = defaultsSnapshot({ ...inherited, ...overrides });
    const patternCatalog = this.dependencies.patternCatalog[catalogControl].snapshot();
    const run = new Run(randomUUID());
    const record: RunRecord = {
      id: run.id, runId: run.id, epoch: this.epoch, revision: 0, status: 'starting', origin: structuredClone(source),
      startedAt: Date.now(), defaults: effective, overrides, cleanup: 'pending', assignments: {}, prepareKeys: {}, receipts: {},
      createRequestId: requestId, createDigest: digest,
    };
    this.dependencies.store.write(record);
    const state: RunState = {
      record, patternCatalog, dependencies: this.dependencies, context: new Context(), accepting: false, initialization: Promise.resolve(),
      commit: (change, publish = true) => {
        try {
          this.dependencies.store.assertWritable(run.id);
          const draft = structuredClone(state.record);
          const result = change(draft);
          draft.revision++;
          this.dependencies.store.write(draft);
          state.record = draft;
          state.afterCommit?.(draft);
          if (publish) state.notify();
          return result;
        } catch (error) { state.notify(); throw error; }
      },
      notify: () => {
        this.revisions.set(run.id, (this.revisions.get(run.id) ?? 0) + 1);
        for (const observer of this.observers) observer(this.readView(run));
      },
      outcome: assignment => {
        if (assignment.sender.kind !== 'run' || !this.dependencies.onTopLevelOutcome) return;
        try {
          const delivery = this.dependencies.onTopLevelOutcome(source, run, structuredClone(assignment));
          if (delivery) void delivery.catch(error => { state.runtimeError = errorText(error); state.notify(); });
        } catch (error) { state.runtimeError = errorText(error); state.notify(); }
      },
      executionFault: fault => {
        if (!state.accepting || state.record.status !== 'active' || !this.dependencies.onTopLevelExecutionFault) return;
        try {
          const delivery = this.dependencies.onTopLevelExecutionFault(source, run, structuredClone(fault));
          if (delivery) void delivery.catch(error => { if (state.accepting) { state.runtimeError = errorText(error); state.notify(); } });
        } catch (error) { state.runtimeError = errorText(error); state.notify(); }
      },
    };
    bindRun(run, state);
    this.runs.set(run.id, run); this.createKeys.set(key, { digest, run });
    state.initialization = Promise.resolve().then(async () => {
      try {
        const root = await this.dependencies.initialize(run, structuredClone(effective), state.context!, source);
        if (!(root instanceof Agent) || root[agentControl].context !== state.context || !state.context!.has(root) || root.getStatus() === 'terminated' || root.getParent() !== null) throw new Error('Initializer must return an active root in its Context');
        state.root = root;
        state.assignments = new AssignmentService(run);
        if (state.record.status === 'starting') {
          state.accepting = true;
          state.commit(draft => { draft.status = 'active'; draft.rootSessionID = root.getProfile().sessionID; });
        }
      } catch (error) {
        state.accepting = false;
        const errors: unknown[] = [error];
        state.runtimeError = errorText(error);
        state.runtimeEndedAt ??= state.record.endedAt ?? Date.now();
        state.runtimeStatus = 'failed'; state.runtimeCleanup = 'pending';
        state.notify();
        if (state.context) { try { await state.context.dispose(); } catch (cleanup) { errors.push(cleanup); } }
        state.runtimeError = errors.map(errorText).join('; ');
        state.runtimeCleanup = errors.length === 1 ? 'complete' : 'failed';
        try { state.commit(draft => { draft.endedAt = state.runtimeEndedAt!; draft.status = 'failed'; draft.error = state.runtimeError!; draft.cleanup = state.runtimeCleanup!; }); }
        catch (storage) { state.runtimeError += `; ${errorText(storage)}`; }
        state.notify();
      }
    });
    state.notify();
    return run;
  }
  list(origin: HostOrigin): RunSnapshot[] {
    const key = originKey(origin);
    return [...this.runs.values()].filter(run => this.ownerKey(runState(run).record.origin) === key).map(run => this.snapshot(run));
  }
  read(origin: HostOrigin, run: Run): RunSnapshot { this.assertOwn(origin, run); return this.snapshot(run); }
  async assign(origin: HostOrigin, run: Run, spec: AssignmentSpec, requestId: string): Promise<AssignmentSnapshot> {
    this.assertOwn(origin, run);
    const state = runState(run);
    if (!state.accepting || state.record.status !== 'active' || !state.assignments || !state.root) throw new Error('Run is not active');
    const assignment = await state.assignments.prepare({ sender: run, recipient: state.root, parentAssignment: null, spec }, requestId);
    const prepared = state.assignments.read(run, assignment);
    if (prepared.status !== 'pending') return prepared;
    state.assignments.deliver(assignment);
    return state.assignments.read(run, assignment);
  }
  readAssignment(origin: HostOrigin, run: Run, assignment: Assignment): AssignmentSnapshot {
    this.assertOwn(origin, run); return this.service(run).read(run, assignment);
  }
  cancelAssignment(origin: HostOrigin, run: Run, assignment: Assignment, reason: string): Promise<AssignmentOutcome[]> {
    this.assertOwn(origin, run); return this.service(run).cancel(run, assignment, reason);
  }
  readArchive(id: string): AssignmentArchiveReadResult { return this.dependencies.store.readArchive(id, this.epoch); }
  release(origin: HostOrigin, run: Run): Promise<void> {
    this.assertOwn(origin, run);
    return this.releaseRun(run);
  }
  private releaseRun(run: Run, initiator: 'user' | 'context' = 'context'): Promise<void> {
    const state = runState(run);
    if (state.releasePromise) return state.releasePromise;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    state.releasePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    state.accepting = false;
    const errors: unknown[] = [];
    if (run.status !== 'failed') {
      state.runtimeStatus = 'stopping';
      try { state.commit(draft => { draft.status = 'stopping'; }); } catch (error) { errors.push(error); }
    }
    if (state.assignments) { try { state.assignments.stop('Run explicitly released'); } catch (error) { errors.push(error); } }
    void Promise.resolve().then(async () => {
      await state.initialization;
      const alreadyFailed = run.status === 'failed';
      const originalError = state.runtimeError ?? state.record.error;
      if (state.context) { try { await state.context[contextControl].dispose(initiator); state.runtimeCleanup = 'complete'; } catch (error) { state.runtimeCleanup = 'failed'; errors.push(error); } }
      state.runtimeEndedAt ??= state.record.endedAt ?? Date.now();
      state.runtimeStatus = alreadyFailed || errors.length ? 'failed' : 'stopped';
      const releaseError = () => [...new Set([...(originalError === undefined ? [] : [originalError]), ...errors.map(errorText)])].join('; ');
      if (errors.length) state.runtimeError = releaseError();
      try { state.commit(draft => { draft.endedAt = state.runtimeEndedAt!; draft.status = state.runtimeStatus!; draft.cleanup = errors.length ? 'failed' : 'complete'; if (state.runtimeError !== undefined) draft.error = state.runtimeError; }); }
      catch (error) { errors.push(error); }
      if (errors.length) { state.runtimeCleanup = 'failed'; state.runtimeStatus = 'failed'; state.runtimeError = releaseError(); state.notify(); throw new AggregateError(errors, 'Run release failed'); }
      state.notify();
    }).then(resolve, reject);
    return state.releasePromise;
  }
  private lookup(id: string): Run { const run = this.runs.get(id); if (!run) throw new Error('Run is unavailable'); return run; }
  private readView(run: Run): RunReadView {
    const state = runState(run);
    if (!state.context) throw new Error('Run has no Context');
    return { run: this.snapshot(run), assignments: structuredClone(Object.values(state.record.assignments)), context: state.context, ...(state.root ? { root: state.root } : {}), revision: this.revisions.get(run.id) ?? 0 };
  }
  private service(run: Run): AssignmentService { const service = runState(run).assignments; if (!service) throw new Error('Run is not ready'); return service; }
  private assertOwn(origin: HostOrigin, run: Run): void {
    const key = originKey(origin);
    if (!(run instanceof Run) || this.runs.get(run.id) !== run) throw new Error('该运行已随重启失效 (run expired after restart)');
    if (this.ownerKey(runState(run).record.origin) !== key) throw new Error('Run belongs to another host session');
  }
  private ownerKey(origin: HostOrigin): string { return JSON.stringify([origin.backend, origin.callerSessionId]); }
  private snapshot(run: Run): RunSnapshot {
    const state = runState(run);
    const { assignments, prepareKeys: _prepareKeys, receipts: _receipts, createDigest: _createDigest, createRequestId: _createRequestId, ...record } = state.record;
    const storageError = this.dependencies.store.error(run.id);
    return structuredClone({ ...record, ...(state.runtimeEndedAt === undefined ? {} : { endedAt: state.runtimeEndedAt }), ...(state.runtimeStatus ? { status: state.runtimeStatus } : {}), ...(state.runtimeCleanup ? { cleanup: state.runtimeCleanup } : {}), pendingAssignments: Object.values(assignments).filter(assignment => assignment.status === 'pending').length,
      ...(state.runtimeError ? { error: state.runtimeError } : {}), ...(storageError ? { storageError } : {}) });
  }
}
