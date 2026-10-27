import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonValue } from '../../../packages/dsh-flow/src/assignments/types.js';
import { runFixture } from '../../helpers/contract-run.js';

type JsonRecord = { [key: string]: any };
type Corruption = [string, (record: JsonRecord, id: string) => void];
const corruptions: Corruption[] = [
  ['missing submitted result', (record, id) => { delete record.assignments[id].result; }],
  ['two-field assignment', (record, id) => { record.assignments[id] = { id, status: 'submitted' }; }],
  ['mismatched record runId', record => { record.runId = 'another-run'; }],
  ['mismatched assignment id', (record, id) => { record.assignments[id].id = 'another-assignment'; }],
  ['mismatched assignment runId', (record, id) => { record.assignments[id].runId = 'another-run'; }],
  ...['spec', 'sender', 'recipientSessionID', 'parentAssignmentId', 'submissions', 'submissionCount', 'schemaFailures', 'schemaDialect', 'schemaDigest', 'continuingChildren'].map(key =>
    [`missing ${key}`, (record: JsonRecord, id: string) => { delete record.assignments[id][key]; }] as Corruption),
  ...Object.entries({ spec: [], sender: [], recipientSessionID: 1, parentAssignmentId: false, submissions: {}, submissionCount: '1', schemaFailures: null, schemaDialect: 1, schemaDigest: {}, continuingChildren: {} }).map(([key, value]) =>
    [`invalid ${key} type`, (record: JsonRecord, id: string) => { record.assignments[id][key] = value; }] as Corruption),
  ...['name', 'type', 'background', 'requirements', 'acceptanceCriteria', 'resultSchema'].map(key =>
    [`missing spec.${key}`, (record: JsonRecord, id: string) => { delete record.assignments[id].spec[key]; }] as Corruption),
  ...Object.entries({ name: 1, type: [], background: false, requirements: null, acceptanceCriteria: {}, resultSchema: [] }).map(([key, value]) =>
    [`invalid spec.${key} type`, (record: JsonRecord, id: string) => { record.assignments[id].spec[key] = value; }] as Corruption),
  ['invalid sender kind', (record, id) => { record.assignments[id].sender = { kind: 'other', runId: record.id }; }],
  ['missing run sender identity', (record, id) => { record.assignments[id].sender = { kind: 'run' }; }],
  ['mismatched run sender identity', (record, id) => { record.assignments[id].sender = { kind: 'run', runId: 'another-run' }; }],
  ['missing agent sender identity', (record, id) => { record.assignments[id].sender = { kind: 'agent' }; }],
  ['invalid agent sender identity type', (record, id) => { record.assignments[id].sender = { kind: 'agent', sessionID: 1 }; }],
  ['invalid material reference', (record, id) => { record.assignments[id].spec.materials = [{ id: 'material' }]; }],
  ['invalid materials type', (record, id) => { record.assignments[id].spec.materials = {}; }],
  ['invalid resume identity type', (record, id) => { record.assignments[id].spec.resumesAssignmentId = null; }],
  ['invalid reason type', (record, id) => { record.assignments[id].reason = false; }],
  ['invalid continuing child', (record, id) => { record.assignments[id].continuingChildren = [{ assignmentId: 'child', reason: 1 }]; }],
  ['missing submission result', (record, id) => { delete record.assignments[id].submissions[0].submission.result; }],
  ['missing submission transport key', (record, id) => { delete record.assignments[id].submissions[0].transportKey; }],
  ['invalid submission timestamp', (record, id) => { record.assignments[id].submissions[0].timestamp = 'yesterday'; }],
  ['invalid submission child', (record, id) => { record.assignments[id].submissions[0].submission.continuingChildren = [null]; }],
  ['missing submission receipt', (record, id) => { delete record.assignments[id].submissions[0].receipt; }],
  ['invalid receipt kind', (record, id) => { record.assignments[id].submissions[0].receipt.kind = 'other'; }],
  ['invalid receipt assignment identity', (record, id) => { record.assignments[id].submissions[0].receipt.assignmentId = 1; }],
  ['invalid receipt status', (record, id) => { record.assignments[id].submissions[0].receipt.status = 'other'; }],
  ['invalid receipt missing children', (record, id) => { record.assignments[id].submissions[0].receipt.missingChildren = [1]; }],
  ['invalid receipt schema errors', (record, id) => { record.assignments[id].submissions[0].receipt.errors = [{ path: '', message: 1 }]; }],
];

for (const [name, corrupt] of corruptions) {
  test(`C046-02 archive DTO rejects ${name} and explicit continuation preserves damaged bytes`, async t => {
    const f = await runFixture(t);
    const run = await f.createActive();
    const saved = await f.service.assign(f.origin(), run, f.spec(), 'saved');
    assert.equal((await f.submit(run, f.binding(run).root, run.assignments!.resolve(saved.id), { answer: 'saved' })).kind, 'accepted');
    const path = join(f.directory, `${run.id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    corrupt(persisted.record, saved.id);
    const bytes = JSON.stringify(persisted);
    await writeFile(path, bytes);

    assert.throws(() => f.store.read(run.id), /invalid persisted run record/i);
    assert.throws(() => f.service.readArchive(saved.id), AggregateError);
    assert.throws(() => f.service.readArchive('unknown-assignment'), AggregateError);
    const successor = await f.createActive();
    await assert.rejects(f.service.assign(f.origin(), successor, f.spec({ resumesAssignmentId: saved.id }), 'resume'), AggregateError);
    assert.deepEqual(successor.assignments!.list(successor), []);
    assert.equal(await readFile(path, 'utf8'), bytes);
  });
}

for (const result of [null, false, 0, '', [], {}] satisfies JsonValue[]) {
  test(`C046-02 submitted JSON result ${JSON.stringify(result)} stays readable and resumable`, async t => {
    const f = await runFixture(t);
    const run = await f.createActive();
    const saved = await f.service.assign(f.origin(), run, f.spec({ resultSchema: true }), 'saved');
    assert.equal((await f.submit(run, f.binding(run).root, run.assignments!.resolve(saved.id), result)).kind, 'accepted');

    const archive = f.service.readArchive(saved.id);
    assert.equal(archive.kind, 'found');
    if (archive.kind !== 'found') throw new Error('Saved result is unavailable');
    assert.equal(Object.hasOwn(archive.assignment, 'result'), true);
    assert.deepEqual(archive.assignment.result, result);
    const successor = await f.createActive();
    assert.equal((await f.service.assign(f.origin(), successor, f.spec({ resumesAssignmentId: saved.id }), 'resume')).status, 'pending');
  });
}

for (const [name, corrupt] of corruptions.slice(0, 2)) {
  test(`C046-02 explicit continuation rejects ${name} as its only historical source`, async t => {
    const f = await runFixture(t);
    const run = await f.createActive();
    const saved = await f.service.assign(f.origin(), run, f.spec(), 'saved');
    await f.submit(run, f.binding(run).root, run.assignments!.resolve(saved.id), { answer: 'saved' });
    const path = join(f.directory, `${run.id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    corrupt(persisted.record, saved.id);
    const bytes = JSON.stringify(persisted);
    await writeFile(path, bytes);
    const successor = await f.createActive();

    await assert.rejects(f.service.assign(f.origin(), successor, f.spec({ resumesAssignmentId: saved.id }), 'resume'), AggregateError);
    assert.deepEqual(successor.assignments!.list(successor), []);
    assert.equal(await readFile(path, 'utf8'), bytes);
  });
}

test('C046-02 archive DTO rejects a submitted result that is not legal JSON', async t => {
  const f = await runFixture(t);
  const run = await f.createActive();
  const saved = await f.service.assign(f.origin(), run, f.spec({ resultSchema: true }), 'saved');
  await f.submit(run, f.binding(run).root, run.assignments!.resolve(saved.id), 'oversized-number');
  const path = join(f.directory, `${run.id}.json`);
  const bytes = (await readFile(path, 'utf8')).replaceAll('"oversized-number"', '1e400');
  await writeFile(path, bytes);

  assert.throws(() => f.service.readArchive(saved.id), AggregateError);
  const successor = await f.createActive();
  await assert.rejects(f.service.assign(f.origin(), successor, f.spec({ resumesAssignmentId: saved.id }), 'resume'), AggregateError);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('C046-02 damaged assignment DTOs do not hide a valid archive in another run', async t => {
  const f = await runFixture(t);
  const damaged = await f.createActive();
  const lost = await f.service.assign(f.origin(), damaged, f.spec(), 'lost');
  await f.submit(damaged, f.binding(damaged).root, damaged.assignments!.resolve(lost.id), { answer: 'lost' });
  const path = join(f.directory, `${damaged.id}.json`);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  delete persisted.record.assignments[lost.id].result;
  const bytes = JSON.stringify(persisted);
  await writeFile(path, bytes);
  const valid = await f.createActive();
  const saved = await f.service.assign(f.origin(), valid, f.spec(), 'saved');
  const archive = f.service.readArchive(saved.id);

  assert.equal(archive.kind, 'found');
  if (archive.kind !== 'found') throw new Error('Valid history is unavailable');
  assert.equal(archive.assignment.id, saved.id);
  assert.throws(() => f.store.records(), AggregateError);
  assert.equal((await f.service.assign(f.origin(), valid, f.spec({ resumesAssignmentId: saved.id }), 'resume')).status, 'pending');
  assert.equal(await readFile(path, 'utf8'), bytes);
});
