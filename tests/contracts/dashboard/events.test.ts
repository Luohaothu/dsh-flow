import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventJournal, JournalCursorError, readJournal, type JournalStage } from '../../../packages/dsh-flow/src/dashboard/events.js';

test('journals publish only after fsync and replay atomically through reentrant append', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stages: JournalStage[] = [];
  const journal = new EventJournal<{ seq: number; text: string }>({ directory, name: 'run', epoch: 'epoch', fault: stage => stages.push(stage) });
  stages.length = 0;
  journal.append(seq => ({ seq, text: 'one' })); journal.append(seq => ({ seq, text: 'two' }));
  const seen: number[] = [];
  journal.subscribe(0, 'epoch', event => { seen.push(event.seq); if (event.seq === 1) journal.append(seq => ({ seq, text: 'three' })); });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(stages, ['write', 'file-sync', 'write', 'file-sync', 'write', 'file-sync']);
  assert.match(readFileSync(join(directory, 'run.epoch.jsonl'), 'utf8'), /"seq":3/);
  const copy = journal.append(seq => ({ seq, text: 'four' })); copy.text = 'mutated';
  const values: string[] = []; journal.subscribe(3, 'epoch', event => values.push(event.text)); assert.deepEqual(values, ['four']);
});

test('journal bounds retained bytes, validates epoch/future/old cursor and isolates streams', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = new EventJournal<{ seq: number; text: string }>({ directory, name: 'a', epoch: 'e', maxBytes: 90 });
  const b = new EventJournal<{ seq: number }>({ directory, name: 'b', epoch: 'e' });
  for (let i = 0; i < 5; i++) a.append(seq => ({ seq, text: '12345678901234567890' }));
  assert.equal(a.seq, 5); assert.equal(b.seq, 0);
  for (const [after, epoch] of [[0, 'e'], [6, 'e'], [5, 'old'], [-1, 'e'], [NaN, 'e']] as const) assert.throws(() => a.subscribe(after, epoch, () => {}), JournalCursorError);
  const seen: number[] = []; a.subscribe(4, 'e', event => seen.push(event.seq)); assert.deepEqual(seen, [5]);
});

test('uncertain journal write closes subscribers, reserves a cursor and recovers a durable snapshot baseline', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let fail = false; const events: number[] = []; let resets = 0;
  const journal = new EventJournal<{ seq: number }>({ directory, name: 'run', epoch: 'e', fault: stage => { if (fail && stage === 'file-sync') throw new Error('disk'); } });
  journal.observeReset(() => resets++); journal.subscribe(0, 'e', event => events.push(event.seq));
  journal.append(seq => ({ seq })); fail = true;
  assert.throws(() => journal.append(seq => ({ seq })), /disk/); assert.equal(journal.degraded, true); assert.deepEqual(events, [1]); assert.equal(resets, 1);
  assert.throws(() => journal.subscribe(1, 'e', () => {}), JournalCursorError);
  fail = false; journal.rebaseline({ seq: journal.seq, nodes: [{ id: 'actual' }] }); assert.equal(journal.degraded, false); assert.throws(() => journal.subscribe(1, 'e', () => {}), JournalCursorError);
  const cursor = journal.seq; const recovered: number[] = []; journal.subscribe(cursor, 'e', event => recovered.push(event.seq)); journal.append(seq => ({ seq }));
  assert.deepEqual(recovered, [cursor + 1]); assert.deepEqual(events, [1]); assert.equal(readJournal(directory, 'run', 'e').seq, cursor + 1);
});

test('reentrant live append preserves strict publication order for every subscriber', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new EventJournal<{ seq: number }>({ directory, name: 'run', epoch: 'e' });
  const first: number[] = []; const second: number[] = [];
  journal.subscribe(0, 'e', event => { first.push(event.seq); if (event.seq === 1) journal.append(seq => ({ seq })); });
  journal.subscribe(0, 'e', event => second.push(event.seq)); journal.append(seq => ({ seq }));
  assert.deepEqual(first, [1, 2]); assert.deepEqual(second, [1, 2]);
});

test('recovery appends full-state segments, preserves prior and uncertain bytes, and a fresh reader replays them', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let fail = false;
  const journal = new EventJournal<{ seq: number; text: string }>({ directory, name: 'run', epoch: 'e', fault: stage => { if (fail && stage === 'file-sync') throw new Error('disk'); } });
  journal.append(seq => ({ seq, text: 'before' }));
  const initialPath = join(directory, 'run.e.jsonl'); const before = readFileSync(initialPath, 'utf8');
  assert.throws(() => new EventJournal({ directory, name: 'run', epoch: 'e' })); assert.equal(readFileSync(initialPath, 'utf8'), before);
  fail = true; assert.throws(() => journal.append(seq => ({ seq, text: 'uncertain' })));
  const uncertain = readFileSync(initialPath, 'utf8'); assert.ok(uncertain.startsWith(before));
  assert.throws(() => journal.rebaseline({ seq: journal.seq, nodes: [{ id: 'actual', messages: ['retained'] }] }));
  fail = false; const baseline = { seq: journal.seq, nodes: [{ id: 'actual', messages: ['retained'] }] }; journal.rebaseline(baseline); journal.append(seq => ({ seq, text: 'after' }));
  assert.equal(readFileSync(initialPath, 'utf8'), uncertain);
  const replay = readJournal(directory, 'run', 'e'); assert.deepEqual(replay.state, baseline); assert.deepEqual(replay.events.map(event => event.text), ['after']); assert.equal(replay.seq, journal.seq); assert.equal(replay.segments.length, 3);
});

test('pending replay drain preserves order across successive reentrant appends and resets byte accounting', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-replay-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new EventJournal<{ seq: number }>({ directory, name: 'run', epoch: 'e', maxBytes: 60 });
  journal.append(seq => ({ seq })); journal.append(seq => ({ seq }));
  const seen: number[] = [];
  journal.subscribe(0, 'e', event => {
    seen.push(event.seq);
    if (event.seq === 1) { journal.append(seq => ({ seq })); journal.append(seq => ({ seq })); }
    if (event.seq >= 3 && event.seq < 9) journal.append(seq => ({ seq }));
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a replaying subscriber beyond the pending byte limit receives reset instead of hanging silently', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-journal-slow-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new EventJournal<{ seq: number; text: string }>({ directory, name: 'run', epoch: 'e', maxBytes: 100 });
  journal.append(seq => ({ seq, text: 'initial' }));
  let resets = 0; journal.observeReset(() => { resets++; }); const seen: number[] = [];
  journal.subscribe(0, 'e', event => {
    seen.push(event.seq);
    if (event.seq === 1) for (let i = 0; i < 5; i++) journal.append(seq => ({ seq, text: 'a payload larger than one pending slot' }));
  });
  assert.deepEqual(seen, [1]); assert.equal(resets, 1);
});
