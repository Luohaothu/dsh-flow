import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssignmentArchiveReadResult } from '../assignments/types.js';
import { assertJson } from '../assignments/schema.js';
import type { RunRecord } from './types.js';

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
      assertJson(record);
      const payload = JSON.stringify(record);
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
      const record: unknown = JSON.parse(readFileSync(this.path(runId), 'utf8'));
      assertJson(record);
      if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== runId || typeof record.epoch !== 'string' || !record.assignments) throw new TypeError('Invalid persisted run record');
      return record as unknown as RunRecord;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  }
  records(): RunRecord[] {
    return readdirSync(this.directory).filter(file => file.endsWith('.json')).map(file => this.read(file.slice(0, -5))).filter((record): record is RunRecord => record !== null);
  }
  readArchive(id: string, epoch?: string): AssignmentArchiveReadResult {
    for (const record of this.records()) {
      if (!Object.hasOwn(record.assignments, id)) continue;
      const assignment = structuredClone(record.assignments[id]!);
      return { kind: 'found', assignment, interrupted: assignment.status === 'pending' && record.epoch !== epoch };
    }
    return { kind: 'not-found', id };
  }
  private path(runId: string): string {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new TypeError('Invalid run ID');
    return join(this.directory, `${runId}.json`);
  }
}
