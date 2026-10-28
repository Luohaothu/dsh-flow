import { randomUUID } from 'node:crypto';
import { Agent } from '../core/agent.js';
import { assertNoPendingConstruction } from '../core/construction.js';
import { getAgentInstanceId } from '../core/observation.js';
import { agentControl } from '../core/internals.js';
import { trustedSystemMessage } from '../core/message.js';
import { Run } from '../run/run.js';
import { runState, type RunState } from '../run/internal.js';
import { trustedCall } from './internal.js';
import { assertJson, compileSchema, digestJson } from './schema.js';
import { Assignment, type AssignmentActor, type AssignmentArchiveReadResult, type AssignmentID, type AssignmentOutcome, type AssignmentQuery, type AssignmentRequest, type AssignmentSnapshot, type AssignmentSpec, type AssignmentSubmission, type SubmissionReceipt } from './types.js';

interface Binding { handle: Assignment; sender: Agent | Run; recipient: Agent }
function text(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nonempty(value: unknown, name: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty`); }
function actorOf(actor: Agent | Run): AssignmentActor {
  return actor instanceof Run ? { kind: 'run', runId: actor.id } : { kind: 'agent', sessionID: actor.getProfile().sessionID, instanceId: getAgentInstanceId(actor) };
}
function outcome(record: AssignmentSnapshot): AssignmentOutcome { return { assignmentId: record.id, status: record.status, ...(record.reason === undefined ? {} : { reason: record.reason }) }; }

export class AssignmentService {
  private readonly state: RunState;
  private readonly bindings = new Map<AssignmentID, Binding>();
  private readonly delivered = new Set<AssignmentID>();
  private readonly delivering = new Set<AssignmentID>();
  constructor(private readonly run: Run) {
    this.state = runState(run);
    if (this.state.assignments) throw new Error('Run already has an AssignmentService');
    if (!this.state.context || !this.state.root) throw new Error('Run has no initialized Context and root');
    const terminal = new Set<string>();
    this.state.afterCommit = record => {
      for (const assignment of Object.values(record.assignments)) {
        if (assignment.status === 'pending' || terminal.has(assignment.id)) continue;
        const binding = this.bindings.get(assignment.id);
        if (!binding) continue;
        terminal.add(assignment.id);
        binding.recipient[agentControl].recordAssignmentOutcome(assignment.status);
      }
    };
    this.state.context.onAgentTerminated(agent => {
      try { this.terminate(agent); } catch (error) { this.state.accepting = false; this.state.runtimeError = text(error); this.state.notify(); }
    });
    for (const agent of this.state.context.list()) if (agent instanceof Agent && agent.getStatus() === 'terminated') this.terminate(agent);
    for (const binding of this.bindings.values()) if (binding.recipient.getStatus() === 'terminated') this.terminate(binding.recipient);
  }
  resolve(id: AssignmentID): Assignment {
    const binding = this.bindings.get(id);
    if (!binding) throw new Error('Assignment is not bound to this run');
    return binding.handle;
  }
  async prepare(request: AssignmentRequest, requestId: string): Promise<Assignment> {
    nonempty(requestId, 'requestId');
    request = { ...request };
    this.assertCaller(request.sender);
    this.assertCaller(request.recipient);
    const parent = request.parentAssignment === null ? null : this.binding(request.parentAssignment).handle.id;
    const spec = this.spec(request.spec);
    let schema: ReturnType<typeof compileSchema>;
    try { schema = compileSchema(spec.resultSchema); }
    catch (error) { throw new TypeError(`resultSchema: ${text(error)}`, { cause: error }); }
    const key = JSON.stringify([actorOf(request.sender), requestId]);
    const digest = digestJson({ sender: actorOf(request.sender), recipientSessionID: request.recipient.getProfile().sessionID, recipientInstanceId: getAgentInstanceId(request.recipient), parentAssignmentId: parent, spec });
    const existing = this.existing(key, digest);
    if (existing) return existing;
    this.assertDispatch(request);
    if (spec.materials?.length) {
      const validator = this.state.dependencies.validateMaterials;
      if (!validator) throw new Error('Material validation and model presentation capability are unavailable');
      await validator({ sender: request.sender, recipient: request.recipient, parentAssignment: request.parentAssignment, materials: structuredClone(spec.materials) });
    }
    let created: Assignment | undefined;
    this.state.commit(draft => {
      const prior = draft.prepareKeys[key];
      if (prior) {
        if (prior.digest !== digest) throw new Error('requestId was reused with different parameters');
        created = this.resolve(prior.assignmentId);
        return;
      }
      this.assertDispatch(request);
      const id = randomUUID();
      const snapshot: AssignmentSnapshot = {
        id, runId: this.run.id, spec, sender: actorOf(request.sender), recipientSessionID: request.recipient.getProfile().sessionID, recipientInstanceId: getAgentInstanceId(request.recipient),
        parentAssignmentId: parent, status: 'pending', submissions: [], submissionCount: 0, schemaFailures: 0,
        schemaDialect: schema.dialect, schemaDigest: schema.digest, continuingChildren: [],
      };
      draft.assignments[id] = snapshot;
      draft.prepareKeys[key] = { digest, assignmentId: id };
      created = new Assignment(id, this.run.id);
    }, false);
    if (!created) throw new Error('Assignment was not prepared');
    if (!this.bindings.has(created.id)) {
      this.bindings.set(created.id, { handle: created, sender: request.sender, recipient: request.recipient });
      request.recipient[agentControl].recordAssignmentOutcome('pending');
    }
    this.state.notify();
    if (request.recipient.getStatus() === 'terminated') this.terminate(request.recipient);
    return created;
  }
  deliver(assignment: Assignment): void {
    const binding = this.binding(assignment);
    const snapshot = this.record(assignment);
    if (snapshot.status !== 'pending') throw new Error(`Assignment is ${snapshot.status}`);
    if (this.delivered.has(assignment.id) || this.delivering.has(assignment.id)) return;
    this.state.dependencies.store.assertWritable(this.run.id);
    this.delivering.add(assignment.id);
    try {
      this.assertActive(binding.recipient);
      if (!this.state.accepting || this.state.record.status !== 'active') throw new Error('Run is not active');
      binding.recipient.recvMessage(trustedSystemMessage('正式作业', {
        kind: 'assignment', runId: this.run.id, assignmentId: assignment.id,
        spec: structuredClone(snapshot.spec), schema: structuredClone(snapshot.spec.resultSchema), materials: structuredClone(snapshot.spec.materials ?? []),
        submission: { tool: 'flow_submit', assignmentId: assignment.id, continuingChildren: 'Give a nonempty reason for every pending direct child assignment' },
      }));
      this.delivered.add(assignment.id);
    } catch (error) {
      let changed: AssignmentSnapshot | undefined;
      this.state.commit(draft => {
        const record = draft.assignments[assignment.id]!;
        if (record.status !== 'pending') return;
        record.status = 'failed'; record.reason = `Delivery failed: ${text(error)}`;
        changed = structuredClone(record);
      });
      if (changed) this.notify(changed);
      throw error;
    } finally { this.delivering.delete(assignment.id); }
  }
  read(caller: Agent | Run, assignment: Assignment): AssignmentSnapshot { this.assertCaller(caller); this.binding(assignment); return structuredClone(this.record(assignment)); }
  list(caller: Agent | Run, query: AssignmentQuery = {}): AssignmentSnapshot[] {
    this.assertCaller(caller);
    let parent = query.parentAssignmentId;
    if ('parentAssignment' in query) parent = query.parentAssignment === null ? null : this.binding(query.parentAssignment!).handle.id;
    return Object.values(this.state.record.assignments).filter(record => (parent === undefined || record.parentAssignmentId === parent) && (query.status === undefined || record.status === query.status)).map(record => structuredClone(record));
  }
  readArchive(id: AssignmentID): AssignmentArchiveReadResult { return this.state.dependencies.store.readArchive(id, this.state.record.epoch, this.state.record.origin); }
  async submit(caller: Agent, assignment: Assignment, submission: AssignmentSubmission): Promise<SubmissionReceipt> {
    this.assertCaller(caller);
    const binding = this.binding(assignment);
    if (binding.recipient !== caller) throw new Error('Only the recipient may submit an assignment');
    const call = trustedCall(caller);
    assertJson(submission.result);
    if (!Array.isArray(submission.continuingChildren)) throw new TypeError('continuingChildren must be an array');
    const seen = new Set<string>();
    const children = submission.continuingChildren.map(entry => {
      const child = this.binding(entry.assignment);
      if (this.record(child.handle).parentAssignmentId !== assignment.id || seen.has(child.handle.id)) throw new Error('Continuing child must be a unique direct child assignment');
      if (typeof entry.reason !== 'string') throw new TypeError('Continuing child reason must be a string');
      seen.add(child.handle.id); return { assignmentId: child.handle.id, reason: entry.reason };
    });
    const input = structuredClone({ result: submission.result, continuingChildren: children });
    const key = JSON.stringify([getAgentInstanceId(caller), call.transportKey]);
    const digest = digestJson({ assignmentId: assignment.id, submission: input });
    const old = this.state.record.receipts[key];
    if (old) { if (old.digest !== digest) throw new Error('Transport key was reused with different parameters'); return structuredClone(old.receipt); }
    let changed: AssignmentSnapshot | undefined;
    const receipt = this.state.commit(draft => {
      assertNoPendingConstruction(caller);
      const record = draft.assignments[assignment.id]!;
      let response: SubmissionReceipt;
      if (record.status !== 'pending') response = { kind: 'terminal', assignmentId: assignment.id, status: record.status };
      else {
        const pendingChildren = Object.values(draft.assignments).filter(child => child.parentAssignmentId === assignment.id && child.status === 'pending');
        const missing = pendingChildren.filter(child => !children.some(entry => entry.assignmentId === child.id && entry.reason.trim())).map(child => child.id);
        if (missing.length) response = { kind: 'missing-children', assignmentId: assignment.id, status: record.status, missingChildren: missing };
        else {
          const errors = compileSchema(record.spec.resultSchema).validate(input.result);
          if (errors.length) {
            record.schemaFailures++;
            if (record.schemaFailures === 3) { record.status = 'failed'; record.reason = 'Result schema validation failed three times'; }
            response = { kind: 'invalid-result', assignmentId: assignment.id, status: record.status, errors };
          } else {
            record.result = input.result;
            record.continuingChildren = children.filter(child => pendingChildren.some(pending => pending.id === child.assignmentId));
            record.status = 'submitted';
            response = { kind: 'accepted', assignmentId: assignment.id, status: record.status };
          }
          if (record.status !== 'pending') changed = record;
        }
      }
      record.submissions.push({ transportKey: call.transportKey, timestamp: Date.now(), submission: input, receipt: structuredClone(response) });
      record.submissionCount = record.submissions.length;
      if (changed) changed = structuredClone(record);
      draft.receipts[key] = { digest, receipt: structuredClone(response) };
      return response;
    });
    if (changed) this.notify(changed);
    return structuredClone(receipt);
  }
  async cancel(sender: Agent | Run, assignment: Assignment, reason: string): Promise<AssignmentOutcome[]> {
    this.assertCaller(sender);
    if (this.binding(assignment).sender !== sender) throw new Error('Only the sender may cancel an assignment');
    nonempty(reason, 'Cancellation reason');
    const changed: AssignmentSnapshot[] = [];
    const outcomes = this.state.commit(draft => {
      const selected = new Set([assignment.id]);
      for (;;) {
        let added = false;
        for (const record of Object.values(draft.assignments)) if (record.parentAssignmentId !== null && selected.has(record.parentAssignmentId) && !selected.has(record.id)) { selected.add(record.id); added = true; }
        if (!added) break;
      }
      return [...selected].map(id => {
        const record = draft.assignments[id]!;
        if (record.status === 'pending') { record.status = 'cancelled'; record.reason = reason; changed.push(structuredClone(record)); }
        return outcome(record);
      });
    });
    for (const record of changed) {
      this.notifyCancelled(record);
      if (this.bindings.get(record.id)?.sender !== sender) this.notify(record);
    }
    return outcomes;
  }
  /** Cancels pending work before the owning Run releases its Context. */
  stop(reason: string): void {
    const changed = this.state.commit(draft => {
      const records: AssignmentSnapshot[] = [];
      for (const record of Object.values(draft.assignments)) if (record.status === 'pending') { record.status = 'cancelled'; record.reason = reason; records.push(structuredClone(record)); }
      return records;
    });
    for (const record of changed) {
      this.notifyCancelled(record);
      if (this.bindings.get(record.id)?.sender instanceof Agent) this.notify(record);
    }
  }
  private terminate(agent: Agent): void {
    if (!Object.values(this.state.record.assignments).some(record => record.recipientInstanceId === getAgentInstanceId(agent) && record.status === 'pending')) return;
    const changed = this.state.commit(draft => {
      const records: AssignmentSnapshot[] = [];
      for (const record of Object.values(draft.assignments)) if (record.recipientInstanceId === getAgentInstanceId(agent) && record.status === 'pending') {
        record.status = 'failed'; record.reason = 'Recipient logically terminated'; records.push(structuredClone(record));
      }
      return records;
    });
    for (const record of changed) this.notify(record);
  }
  private notify(record: AssignmentSnapshot): void {
    const binding = this.bindings.get(record.id);
    if (!binding) return;
    if (binding.sender === this.run) { this.state.outcome(record); return; }
    if (binding.sender instanceof Agent && this.isActive(binding.sender)) {
      try { binding.sender.recvMessage(trustedSystemMessage('作业状态更新', { runId: this.run.id, assignmentId: record.id, status: record.status, query: 'flow_assignment_read' })); }
      catch (error) { this.state.runtimeError = text(error); this.state.notify(); }
    }
  }
  private notifyCancelled(record: AssignmentSnapshot): void {
    const binding = this.bindings.get(record.id);
    if (binding && this.isActive(binding.recipient)) {
      try { binding.recipient.recvMessage(trustedSystemMessage('作业已取消', { runId: this.run.id, assignmentId: record.id, reason: record.reason, instruction: 'Stop work on this assignment' })); }
      catch (error) { this.state.runtimeError = text(error); this.state.notify(); }
    }
  }
  private existing(key: string, digest: string): Assignment | undefined {
    const entry = this.state.record.prepareKeys[key];
    if (!entry) return undefined;
    if (entry.digest !== digest) throw new Error('requestId was reused with different parameters');
    return this.resolve(entry.assignmentId);
  }
  private binding(assignment: Assignment): Binding {
    const binding = assignment && this.bindings.get(assignment.id);
    if (!binding || binding.handle !== assignment) throw new Error('Assignment handle does not belong to this run');
    return binding;
  }
  private record(assignment: Assignment): AssignmentSnapshot { return this.state.record.assignments[assignment.id]!; }
  private assertCaller(caller: Agent | Run): void {
    if (caller === this.run) return;
    if (!(caller instanceof Agent) || caller[agentControl].context !== this.state.context) throw new Error('Caller does not belong to this run');
    assertNoPendingConstruction(caller);
  }
  private isActive(agent: Agent): boolean { assertNoPendingConstruction(agent); return agent[agentControl].context === this.state.context && this.state.context!.has(agent) && agent.getStatus() !== 'terminated'; }
  private assertActive(agent: Agent): void { if (!this.isActive(agent)) throw new Error('Agent is unavailable in this run'); }
  private assertDispatch(request: AssignmentRequest): void {
    if (!this.state.accepting || this.state.record.status !== 'active') throw new Error('Run is not active');
    this.assertActive(request.recipient);
    if (request.sender === this.run) {
      if (request.recipient !== this.state.root || request.parentAssignment !== null) throw new Error('Run may only dispatch top-level assignments to its root');
      return;
    }
    if (!(request.sender instanceof Agent)) throw new Error('Invalid sender');
    this.assertActive(request.sender);
    if (!request.parentAssignment) throw new Error('Child assignments require a parent assignment');
    if (request.recipient.getParent() !== request.sender) throw new Error('Recipient is not a current direct child');
    const parent = this.binding(request.parentAssignment);
    if (parent.recipient !== request.sender || this.record(parent.handle).status !== 'pending') throw new Error('Parent assignment must be pending and assigned to the sender');
  }
  private spec(spec: AssignmentSpec): AssignmentSpec {
    assertJson(spec);
    for (const key of ['name', 'type', 'background', 'requirements', 'acceptanceCriteria'] as const) if (typeof spec[key] !== 'string') throw new TypeError(`${key} must be a string`);
    nonempty(spec.name, 'Assignment name'); nonempty(spec.type, 'Assignment type');
    if (spec.resumesAssignmentId !== undefined) {
      nonempty(spec.resumesAssignmentId, 'resumesAssignmentId');
      if (this.readArchive(spec.resumesAssignmentId).kind !== 'found') throw new Error('Resumed assignment history does not exist');
    }
    if (spec.materials !== undefined) {
      if (!Array.isArray(spec.materials)) throw new TypeError('Materials must be an array');
      for (const ref of spec.materials) for (const key of ['id', 'sourceId', 'digest', 'location', 'mediaType'] as const) nonempty(ref[key], `Material ${key}`);
    }
    return structuredClone(spec);
  }
}
