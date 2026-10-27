import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runFixture } from '../../helpers/contract-run.js';

test('C038-02 the versioned persisted envelope decodes to the unchanged Run record', async t => {
  const f = await runFixture(t);
  const run = await f.createActive();
  const persisted = JSON.parse(await readFile(join(f.directory, `${run.id}.json`), 'utf8'));
  assert.equal(persisted.format, 'dsh-flow-run');
  assert.equal(persisted.version, 2);
  assert.equal(persisted.record.id, run.id);
  assert.deepEqual(f.store.read(run.id), persisted.record);
  assert.equal(Object.hasOwn(f.store.read(run.id)!, 'version'), false);
});

test('C038-02 unreadable unrelated runs leave saved archives and explicit continuation usable', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'team', owner);
  const saved = await f.service.assign(owner, run, f.spec(), 'saved');
  assert.ok(run.assignments);
  await f.submit(run, f.binding(run).root, run.assignments.resolve(saved.id), { answer: '已保存' });
  const expected = f.service.readArchive(saved.id);
  const persisted = JSON.parse(await readFile(join(f.directory, `${run.id}.json`), 'utf8'));
  const broken = new Map([
    ['000-unreadable.json', '{"assignments":'],
    ['001-unsupported.json', JSON.stringify({ ...persisted, version: 2 })],
    ['002-invalid-table.json', JSON.stringify({ ...persisted, record: { ...persisted.record, id: '002-invalid-table', runId: '002-invalid-table', assignments: [] } })],
  ]);
  for (const [name, bytes] of broken) await writeFile(join(f.directory, name), bytes);

  assert.deepEqual(f.service.readArchive(saved.id), expected);
  const resumed = await f.service.assign(owner, run, f.spec({ resumesAssignmentId: saved.id }), 'continuation');
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.spec.resumesAssignmentId, saved.id);
  for (const [name, bytes] of broken) assert.equal(await readFile(join(f.directory, name), 'utf8'), bytes);
});

test('C038-02 files outside the run ID naming convention do not participate in archive reads', async t => {
  const f = await runFixture(t);
  const run = await f.createActive();
  const saved = await f.service.assign(f.origin(), run, f.spec(), 'saved');
  const expected = f.service.readArchive(saved.id);
  for (const name of ['a.b.json', '.json', '.unfinished.json', 'unfinished.tmp']) {
    await writeFile(join(f.directory, name), 'not a run record');
  }

  assert.deepEqual(f.service.readArchive(saved.id), expected);
  assert.deepEqual(f.service.readArchive('unknown-assignment'), { kind: 'not-found', id: 'unknown-assignment' });
  assert.deepEqual(f.store.records().map(record => record.id), [run.id]);
});

test('C038-02 unknown history reports incomplete reads with each failing run and preserves bytes', async t => {
  const f = await runFixture(t);
  await f.createActive();
  const broken = new Map([
    ['000-broken.json', '{"assignments":'],
    ['001-broken.json', 'null'],
  ]);
  for (const [name, bytes] of broken) await writeFile(join(f.directory, name), bytes);

  assert.throws(() => f.service.readArchive('unknown-assignment'), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /archive.*read.*unavailable/i);
    assert.equal(error.errors.length, 2);
    for (const name of broken.keys()) {
      const cause = error.errors.find(cause => cause instanceof Error && cause.message.includes(name));
      assert.ok(cause instanceof Error);
      assert.ok(cause.cause instanceof Error);
    }
    return true;
  });
  assert.throws(() => f.store.records(), AggregateError);
  for (const [name, bytes] of broken) assert.equal(await readFile(join(f.directory, name), 'utf8'), bytes);
});

test('C038-02 complete archive scans still report missing assignments', async t => {
  const f = await runFixture(t);
  assert.deepEqual(f.service.readArchive('unknown-assignment'), { kind: 'not-found', id: 'unknown-assignment' });
  const run = await f.createActive();
  await f.service.assign(f.origin(), run, f.spec(), 'saved');
  assert.deepEqual(f.service.readArchive('unknown-assignment'), { kind: 'not-found', id: 'unknown-assignment' });
});

for (const [name, patch] of [
  ['missing format identity', { format: undefined }],
  ['unsupported format identity', { format: 'another-format' }],
  ['missing format version', { version: undefined }],
  ['unsupported format version', { version: 1 }],
] as const) {
  test(`C038-02 ${name} is an unreadable archive record`, async t => {
    const f = await runFixture(t);
    const run = await f.createActive();
    const path = join(f.directory, `${run.id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    const bytes = JSON.stringify({ ...persisted, ...patch });
    await writeFile(path, bytes);

    assert.throws(() => f.store.read(run.id), /invalid persisted run record/i);
    assert.throws(() => f.service.readArchive('unknown-assignment'), /archive.*read.*unavailable/i);
    assert.equal(await readFile(path, 'utf8'), bytes);
  });
}

for (const [name, patch] of [
  ['null assignment table', { assignments: null }],
  ['array assignment table', { assignments: [] }],
  ['string assignment table', { assignments: 'unreadable' }],
  ['non-object assignment', { assignments: { broken: null } }],
] as const) {
  test(`C038-02 ${name} is an unreadable archive record`, async t => {
    const f = await runFixture(t);
    const run = await f.createActive();
    const path = join(f.directory, `${run.id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    const bytes = JSON.stringify({ ...persisted, record: { ...persisted.record, ...patch } });
    await writeFile(path, bytes);

    assert.throws(() => f.store.read(run.id), /invalid persisted run record|unsupported.*version/i);
    assert.throws(() => f.service.readArchive('unknown-assignment'), /archive.*read.*unavailable/i);
    assert.equal(await readFile(path, 'utf8'), bytes);
  });
}

test('C038-02 unversioned flat records are rejected without migration', async t => {
  const f = await runFixture(t);
  const run = await f.createActive();
  const path = join(f.directory, `${run.id}.json`);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  const bytes = JSON.stringify(persisted.record);
  await writeFile(path, bytes);

  assert.throws(() => f.store.read(run.id), /invalid persisted run record/i);
  assert.throws(() => f.service.readArchive('unknown-assignment'), /archive.*read.*unavailable/i);
  assert.equal(await readFile(path, 'utf8'), bytes);
});
