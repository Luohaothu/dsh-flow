import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssignmentArchiveReadResult } from '../assignments/types.js';
import { assertJson } from '../assignments/schema.js';
import type { RunRecord } from './types.js';

const runIdPattern = /^[a-zA-Z0-9_-]+$/;
const recordVersion = 1;
interface PersistedRunRecord { format: 'dsh-flow-run'; version: typeof recordVersion; record: RunRecord }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

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
      if (!isObject(record) || record.id !== runId || typeof record.epoch !== 'string' || !isObject(record.assignments)) throw new TypeError('Invalid persisted run record');
      for (const [id, assignment] of Object.entries(record.assignments)) {
        if (!isObject(assignment) || assignment.id !== id || typeof assignment.status !== 'string' || !['pending', 'submitted', 'failed', 'cancelled'].includes(assignment.status)) throw new TypeError('Invalid persisted run record');
      }
      return record as unknown as RunRecord;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  }
  records(): RunRecord[] {
    const { records, errors } = this.scan();
    if (errors.length) throw new AggregateError(errors, 'Run record read unavailable');
    return records;
  }
  readArchive(id: string, epoch?: string): AssignmentArchiveReadResult {
    const { records, errors } = this.scan();
    for (const record of records) {
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
