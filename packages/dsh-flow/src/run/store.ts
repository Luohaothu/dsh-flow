import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssignmentArchiveReadResult, AssignmentSnapshot } from '../assignments/types.js';
import { assertJson } from '../assignments/schema.js';
import type { HostOrigin, RunDefaults, RunRecord } from './types.js';

const runIdPattern = /^[a-zA-Z0-9_-]+$/;
const recordVersion = 2;
interface PersistedRunRecord { format: 'dsh-flow-run'; version: typeof recordVersion; record: RunRecord }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every(key => typeof value[key] === 'string'); }
function optional(value: Record<string, unknown>, key: string, check: (entry: unknown) => boolean): boolean { return !Object.hasOwn(value, key) || check(value[key]); }
function isString(value: unknown): value is string { return typeof value === 'string'; }
function isStatus(value: unknown): boolean { return typeof value === 'string' && ['pending', 'submitted', 'failed', 'cancelled'].includes(value); }
function isChildren(value: unknown): boolean {
  return Array.isArray(value) && value.every(child => isObject(child) && hasStrings(child, ['assignmentId', 'reason']));
}
function isReceipt(value: unknown): boolean {
  if (!isObject(value) || !isUUID(value.assignmentId) || !isStatus(value.status)) return false;
  if (!optional(value, 'missingChildren', children => Array.isArray(children) && children.every(isUUID))
    || !optional(value, 'errors', errors => Array.isArray(errors) && errors.every(error => isObject(error) && hasStrings(error, ['path', 'message'])))) return false;
  switch (value.kind) {
    case 'accepted': return value.status === 'submitted';
    case 'missing-children': return value.status === 'pending' && Array.isArray(value.missingChildren);
    case 'invalid-result': return (value.status === 'pending' || value.status === 'failed') && Array.isArray(value.errors);
    case 'terminal': return value.status !== 'pending';
    default: return false;
  }
}
function isSubmission(value: unknown): boolean {
  return isObject(value) && typeof value.transportKey === 'string' && isNumber(value.timestamp) && value.timestamp >= 0
    && isObject(value.submission) && Object.hasOwn(value.submission, 'result') && isChildren(value.submission.continuingChildren)
    && isReceipt(value.receipt);
}
function isSpec(value: unknown): boolean {
  return isObject(value) && hasStrings(value, ['name', 'type', 'background', 'requirements', 'acceptanceCriteria'])
    && (typeof value.resultSchema === 'boolean' || isObject(value.resultSchema))
    && optional(value, 'resumesAssignmentId', isString)
    && optional(value, 'materials', materials => Array.isArray(materials) && materials.every(ref =>
      isObject(ref) && hasStrings(ref, ['id', 'sourceId', 'digest', 'location', 'mediaType'])));
}
function isAssignment(value: unknown, id: string, runId: string): value is AssignmentSnapshot {
  if (!isObject(value) || !isUUID(value.id) || value.id !== id || value.runId !== runId || !isSpec(value.spec) || !isObject(value.sender)) return false;
  const sender = value.sender;
  return ((sender.kind === 'run' && sender.runId === runId) || (sender.kind === 'agent' && typeof sender.sessionID === 'string' && isUUID(sender.instanceId)))
    && typeof value.recipientSessionID === 'string' && isUUID(value.recipientInstanceId) && (value.parentAssignmentId === null || typeof value.parentAssignmentId === 'string')
    && isStatus(value.status) && Array.isArray(value.submissions) && value.submissions.every(isSubmission)
    && isCount(value.submissionCount) && value.submissionCount === value.submissions.length && isCount(value.schemaFailures) && value.schemaFailures <= 3
    && hasStrings(value, ['schemaDialect', 'schemaDigest']) && isChildren(value.continuingChildren)
    && (value.status !== 'submitted' || Object.hasOwn(value, 'result')) && optional(value, 'reason', isString);
}
function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isCount(value: unknown): value is number { return isNumber(value) && Number.isSafeInteger(value) && value >= 0; }
function isUUID(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isRunDefaults(value: unknown): value is RunDefaults {
  return isObject(value)
    && optional(value, 'model', model => isObject(model) && hasStrings(model, ['provider', 'id']))
    && optional(value, 'params', params => isObject(params) && params.version === 1
      && optional(params, 'temperature', isNumber) && optional(params, 'reasoningEffort', isString) && optional(params, 'maxTokens', isNumber))
    && optional(value, 'permission', permission => typeof permission === 'string' && ['read-only', 'workspace-write', 'full-access'].includes(permission))
    && optional(value, 'hostExtras', isObject) && optional(value, 'preset', isString)
    && optional(value, 'skills', skills => Array.isArray(skills) && skills.every(isString));
}
function isRunRecord(value: unknown, runId: string): value is RunRecord {
  return isObject(value) && isUUID(value.id) && value.id === runId && value.runId === runId
    && isUUID(value.epoch) && isCount(value.revision) && isNumber(value.startedAt) && value.startedAt >= 0 && optional(value, 'endedAt', end => isNumber(end) && end >= Number(value.startedAt))
    && typeof value.status === 'string' && ['starting', 'active', 'stopping', 'stopped', 'failed'].includes(value.status)
    && isObject(value.origin) && hasStrings(value.origin, ['backend', 'callerSessionId'])
    && isRunDefaults(value.defaults) && isRunDefaults(value.overrides)
    && optional(value, 'rootSessionID', isString) && optional(value, 'error', isString)
    && typeof value.cleanup === 'string' && ['pending', 'complete', 'failed'].includes(value.cleanup)
    && isObject(value.assignments) && Object.entries(value.assignments).every(([id, assignment]) => isAssignment(assignment, id, runId))
    && isObject(value.prepareKeys) && Object.values(value.prepareKeys).every(entry => isObject(entry) && hasStrings(entry, ['digest', 'assignmentId']))
    && isObject(value.receipts) && Object.values(value.receipts).every(entry => isObject(entry) && typeof entry.digest === 'string' && isReceipt(entry.receipt))
    && hasStrings(value, ['createRequestId', 'createDigest']) && crossReferences(value);
}

function crossReferences(record: Record<string, unknown>): boolean {
  if (!isObject(record.assignments) || !isObject(record.prepareKeys) || !isObject(record.receipts)) return false;
  const assignments = record.assignments;
  for (const value of Object.values(assignments)) {
    if (!isObject(value)) return false;
    if (value.parentAssignmentId !== null && (typeof value.parentAssignmentId !== 'string' || !Object.hasOwn(assignments, value.parentAssignmentId))) return false;
    if (!isObject(value.sender)) return false;
    if (value.parentAssignmentId === null) { if (value.sender.kind !== 'run') return false; }
    else { const parent = assignments[String(value.parentAssignmentId)]; if (!isObject(parent) || value.sender.kind !== 'agent' || value.sender.instanceId !== parent.recipientInstanceId || value.sender.sessionID !== parent.recipientSessionID) return false; }
    if (!Array.isArray(value.continuingChildren) || !value.continuingChildren.every(child => { if (!isObject(child) || typeof child.assignmentId !== 'string') return false; const entry = assignments[child.assignmentId]; return isObject(entry) && entry.parentAssignmentId === value.id; })) return false;
    if (!Array.isArray(value.submissions) || !value.submissions.every(attempt => {
      if (!isObject(attempt) || !isObject(attempt.receipt) || attempt.receipt.assignmentId !== value.id || !isObject(attempt.submission) || !Array.isArray(attempt.submission.continuingChildren)) return false;
      return attempt.submission.continuingChildren.every(child => { if (!isObject(child) || typeof child.assignmentId !== 'string') return false; const entry = assignments[child.assignmentId]; return isObject(entry) && entry.parentAssignmentId === value.id; });
    })) return false;
    const visited = new Set<unknown>([value.id]);
    let parent: unknown = value.parentAssignmentId;
    while (parent !== null) {
      if (typeof parent !== 'string' || visited.has(parent)) return false;
      visited.add(parent);
      const entry = assignments[parent];
      if (!isObject(entry)) return false;
      parent = entry.parentAssignmentId;
    }
  }
  return Object.values(record.prepareKeys).every(entry => isObject(entry) && typeof entry.assignmentId === 'string' && Object.hasOwn(assignments, entry.assignmentId))
    && Object.values(record.receipts).every(entry => isObject(entry) && isObject(entry.receipt) && typeof entry.receipt.assignmentId === 'string' && Object.hasOwn(assignments, entry.receipt.assignmentId));
}

export type StoreStage = 'write' | 'file-sync' | 'rename' | 'directory-sync';
export class RunStore {
  private frozen = new Map<string, Error>();
  constructor(readonly directory: string, private readonly options: { fault?: (stage: StoreStage, runId: string) => void } = {}) { mkdirSync(directory, { recursive: true }); }
  write(record: RunRecord): void {
    this.assertWritable(record.id);
    let file: number | undefined;
    let directory: number | undefined;
    const temporary = join(this.directory, `.${record.id}.${randomUUID()}.tmp`);
    try {
      const persisted: PersistedRunRecord = { format: 'dsh-flow-run', version: recordVersion, record };
      assertJson(persisted);
      if (!isRunRecord(record, record.id)) throw new TypeError('Invalid persisted run record');
      const payload = JSON.stringify(persisted);
      this.options.fault?.('write', record.id);
      file = openSync(temporary, 'wx', 0o600);
      writeFileSync(file, payload, 'utf8');
      this.options.fault?.('file-sync', record.id);
      fsyncSync(file); closeSync(file); file = undefined;
      this.options.fault?.('rename', record.id);
      renameSync(temporary, this.path(record.id));
      directory = openSync(this.directory, 'r');
      this.options.fault?.('directory-sync', record.id);
      fsyncSync(directory); closeSync(directory); directory = undefined;
    } catch (cause) {
      const error = new Error('Run storage failed or is uncertain; mutations are frozen', { cause });
      this.frozen.set(record.id, error);
      throw error;
    } finally {
      if (file !== undefined) { try { closeSync(file); } catch {} }
      if (directory !== undefined) { try { closeSync(directory); } catch {} }
      try { unlinkSync(temporary); } catch {}
    }
  }
  assertWritable(runId: string): void { const error = this.frozen.get(runId); if (error) throw error; }
  error(runId: string): string | undefined { return this.frozen.get(runId)?.message; }
  read(runId: string): RunRecord | null {
    try {
      const persisted: unknown = JSON.parse(readFileSync(this.path(runId), 'utf8'));
      assertJson(persisted);
      if (!isObject(persisted) || persisted.format !== 'dsh-flow-run' || persisted.version !== recordVersion) throw new TypeError('Invalid persisted run record format or version');
      const record = persisted.record;
      if (!isRunRecord(record, runId)) throw new TypeError('Invalid persisted run record');
      return record;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  }
  records(): RunRecord[] {
    const { records, errors } = this.scan();
    if (errors.length) throw new AggregateError(errors, 'Run record read unavailable');
    return records;
  }
  readArchive(id: string, epoch?: string, origin?: HostOrigin): AssignmentArchiveReadResult {
    const { records, errors } = this.scan();
    for (const record of records) {
      if (origin && (record.origin.backend !== origin.backend || record.origin.callerSessionId !== origin.callerSessionId)) continue;
      if (!Object.hasOwn(record.assignments, id)) continue;
      const assignment = structuredClone(record.assignments[id]!);
      return { kind: 'found', assignment, interrupted: assignment.status === 'pending' && record.epoch !== epoch };
    }
    if (errors.length) throw new AggregateError(errors, 'Assignment archive read unavailable');
    return { kind: 'not-found', id };
  }
  private scan(): { records: RunRecord[]; errors: Error[] } {
    const records: RunRecord[] = [];
    const errors: Error[] = [];
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json') || !runIdPattern.test(file.slice(0, -5))) continue;
      try {
        const record = this.read(file.slice(0, -5));
        if (record) records.push(record);
      } catch (cause) { errors.push(new Error(`Could not read persisted run ${file}`, { cause })); }
    }
    return { records, errors };
  }
  private path(runId: string): string {
    if (typeof runId !== 'string' || !runIdPattern.test(runId)) throw new TypeError('Invalid run ID');
    return join(this.directory, `${runId}.json`);
  }
}
