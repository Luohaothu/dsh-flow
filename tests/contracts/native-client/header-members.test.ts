import test from 'node:test';
import assert from 'node:assert/strict';
import { HeaderMembers } from '../../../packages/dsh-flow/src/native/header-members.js';
import { run, snapshot, card } from '../ui/fixtures.js';
import { PROTOCOL_VERSION, type RegistrySnapshot, type RunSnapshot } from '../../../packages/dsh-flow/src/dashboard/protocol.js';

const registry = (seq: number, epoch = 'epoch'): RegistrySnapshot => ({ version: PROTOCOL_VERSION, epoch, seq, runs: ['a', 'b', 'c', 'd'].map(id => ({ ...run(id), epoch, entry: { backend: 'fixture', callerSessionId: 'main' } })) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('menu reads coalesce same-metadata registry invalidations fairly and ignore ordinary client publications', async () => {
  const reads: { id: string; signal: AbortSignal; resolve(value: RunSnapshot): void }[] = [];
  const pool = new HeaderMembers({ readRunSnapshot: (id, signal) => new Promise(resolve => reads.push({ id, signal, resolve })) }, 'main');
  pool.update(registry(1)); assert.deepEqual(reads.map(read => read.id), ['a']);
  pool.update(registry(2)); pool.update(registry(3));
  for (const id of ['a', 'b', 'c', 'd']) {
    const read = reads.at(-1)!; assert.equal(read.id, id);
    read.resolve(snapshot([card(id)], { run: run(id) })); await tick();
  }
  assert.deepEqual(reads.map(read => read.id), ['a', 'b', 'c', 'd', 'a']);
  pool.update(registry(3));
  assert.equal(reads.length, 5, 'same cursor does not requeue finite reads');
  assert.deepEqual(Object.keys(pool.getState()).sort(), ['a', 'b', 'c', 'd']);
  pool.dispose(); assert.equal(reads.at(-1)!.signal.aborted, true);
  reads.at(-1)!.resolve(snapshot([card('late')], { run: run('a') })); await tick();
  assert.equal(reads.length, 5, 'late completion does not start disposed queued work');
  assert.equal(pool.getState().a!.snapshot!.nodes[0]!.id, 'a');
});

test('menu epochs, unavailable Runs, per-Run errors and caller boundaries cannot publish obsolete members', async () => {
  const reads: { id: string; signal: AbortSignal; resolve(value: RunSnapshot): void; reject(reason: unknown): void }[] = [];
  const port = { readRunSnapshot: (id: string, signal: AbortSignal) => new Promise<RunSnapshot>((resolve, reject) => reads.push({ id, signal, resolve, reject })) };
  const pool = new HeaderMembers(port, 'main'); pool.update(registry(1));
  pool.update(registry(0, 'new-epoch')); assert.equal(reads[0]!.signal.aborted, true);
  reads[0]!.resolve(snapshot([card('obsolete')], { run: run('a') })); await tick();
  assert.equal(pool.getState().a!.snapshot, undefined);
  reads[1]!.reject(new Error('native run is unavailable')); await tick();
  assert.equal(pool.getState().a!.error, 'native run is unavailable'); assert.equal(reads[2]!.id, 'b');
  const invalid = registry(1, 'new-epoch'); invalid.runs[1]!.status = 'invalid'; pool.update(invalid);
  assert.equal(reads[2]!.signal.aborted, true); assert.equal(pool.getState().b!.error, '该运行已不可用');
  pool.dispose(); reads[2]!.resolve(snapshot([card('late-b')], { run: run('b') })); await tick();
  const next = new HeaderMembers(port, 'other'); next.update(registry(2));
  assert.deepEqual(next.getState(), {}); assert.equal(reads.length, 3); next.dispose();
});
