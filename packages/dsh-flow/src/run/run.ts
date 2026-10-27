import { randomUUID } from 'node:crypto';
import { Agent } from '../core/agent.js';
import { agentControl } from '../core/internals.js';
import { Context } from '../core/context.js';
import { AssignmentService } from '../assignments/service.js';
import { assertJson, digestJson } from '../assignments/schema.js';
import type { Assignment, AssignmentArchiveReadResult, AssignmentOutcome, AssignmentSnapshot, AssignmentSpec } from '../assignments/types.js';
import { bindRun, originKey, runState, verifiedOrigin, type RunState } from './internal.js';
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
    const run = new Run(randomUUID());
    const record: RunRecord = {
      id: run.id, runId: run.id, epoch: this.epoch, revision: 0, status: 'starting', origin: structuredClone(source),
      defaults: effective, overrides, cleanup: 'pending', assignments: {}, prepareKeys: {}, receipts: {},
      createRequestId: requestId, createDigest: digest,
    };
    this.dependencies.store.write(record);
    const state: RunState = {
      record, dependencies: this.dependencies, context: new Context(), accepting: false, initialization: Promise.resolve(),
      commit: change => {
        this.dependencies.store.assertWritable(run.id);
        const draft = structuredClone(state.record);
        const result = change(draft);
        draft.revision++;
        this.dependencies.store.write(draft);
        state.record = draft;
        return result;
      },
      outcome: assignment => {
        if (assignment.sender.kind !== 'run' || !this.dependencies.onTopLevelOutcome) return;
        try {
          const delivery = this.dependencies.onTopLevelOutcome(source, run, structuredClone(assignment));
          if (delivery) void delivery.catch(error => { state.runtimeError = errorText(error); });
        } catch (error) { state.runtimeError = errorText(error); }
      },
    };
    bindRun(run, state);
    this.runs.set(run.id, run); this.createKeys.set(key, { digest, run });
    state.initialization = Promise.resolve().then(async () => {
      try {
        const root = await this.dependencies.initialize(run, structuredClone(effective), state.context!);
        if (!(root instanceof Agent) || root[agentControl].context !== state.context || !state.context!.has(root) || root.getStatus() === 'terminated' || root.getParent() !== null) throw new Error('Initializer must return an active root in its Context');
        state.root = root;
        state.assignments = new AssignmentService(run);
        if (state.record.status === 'starting') {
          state.commit(draft => { draft.status = 'active'; draft.rootSessionID = root.getProfile().sessionID; });
          state.accepting = true;
        }
      } catch (error) {
        state.accepting = false;
        const errors: unknown[] = [error];
        if (state.context) { try { await state.context.dispose(); } catch (cleanup) { errors.push(cleanup); } }
        state.runtimeError = errors.map(errorText).join('; ');
        state.runtimeStatus = 'failed'; state.runtimeCleanup = errors.length === 1 ? 'complete' : 'failed';
        try { state.commit(draft => { draft.status = 'failed'; draft.error = state.runtimeError!; draft.cleanup = errors.length === 1 ? 'complete' : 'failed'; }); }
        catch (storage) { state.runtimeError += `; ${errorText(storage)}`; }
      }
    });
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
    const state = runState(run);
    if (state.releasePromise) return state.releasePromise;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    state.releasePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    state.accepting = false;
    const errors: unknown[] = [];
    try { state.commit(draft => { draft.status = 'stopping'; }); } catch (error) { errors.push(error); }
    if (state.assignments) { try { state.assignments.stop('Run explicitly released'); } catch (error) { errors.push(error); } }
    void Promise.resolve().then(async () => {
      await state.initialization;
      if (state.context) { try { await state.context.dispose(); state.runtimeCleanup = 'complete'; } catch (error) { state.runtimeCleanup = 'failed'; errors.push(error); } }
      try { state.commit(draft => { draft.status = errors.length ? 'failed' : 'stopped'; draft.cleanup = errors.length ? 'failed' : 'complete'; if (errors.length) draft.error = errors.map(errorText).join('; '); }); }
      catch (error) { errors.push(error); }
      if (errors.length) { state.runtimeCleanup = 'failed'; state.runtimeStatus = 'failed'; state.runtimeError = errors.map(errorText).join('; '); throw new AggregateError(errors, 'Run release failed'); }
    }).then(resolve, reject);
    return state.releasePromise;
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
    return structuredClone({ ...record, ...(state.runtimeStatus ? { status: state.runtimeStatus } : {}), ...(state.runtimeCleanup ? { cleanup: state.runtimeCleanup } : {}), pendingAssignments: Object.values(assignments).filter(assignment => assignment.status === 'pending').length,
      ...(state.runtimeError && !record.error ? { error: state.runtimeError } : {}), ...(storageError ? { storageError } : {}) });
  }
}
