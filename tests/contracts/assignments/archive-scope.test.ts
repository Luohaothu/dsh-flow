import assert from 'node:assert/strict';
import test from 'node:test';
import { runFixture } from '../../helpers/contract-run.js';

for (const historical of [false, true]) {
  test(`C046-02 C055: foreign origins cannot read or continue ${historical ? 'historical' : 'active'} assignments`, async t => {
    const f = await runFixture(t), owner = f.origin('owner');
    const original = await f.createActive({}, 'original', owner);
    const saved = await f.service.assign(owner, original, f.spec({ name: 'private source', background: 'private facts', resultSchema: true }), 'secret');
    if (historical) {
      await f.submit(original, original.root!, original.assignments!.resolve(saved.id), { private: true });
      await f.service.release(owner, original);
    }
    for (const [index, foreign] of [f.origin('other'), f.origin('owner', 'other-backend')].entries()) {
      const run = await f.createActive({}, `foreign-${index}`, foreign);
      assert.deepEqual(run.assignments!.readArchive(saved.id), { kind: 'not-found', id: saved.id });
      await assert.rejects(f.service.assign(foreign, run, f.spec({ resumesAssignmentId: saved.id }), 'foreign-continuation'), /history does not exist/);
      assert.equal(run.assignments!.list(run).length, 0);
    }
  });
}

test('C046-02 C055: the same origin retains its historical archive and explicit continuation', async t => {
  const f = await runFixture(t), owner = f.origin('owner');
  const original = await f.createActive({}, 'original', owner);
  const saved = await f.service.assign(owner, original, f.spec({ resultSchema: true }), 'source');
  await f.submit(original, original.root!, original.assignments!.resolve(saved.id), false);
  await f.service.release(owner, original);
  const nextOwner = f.origin('owner'), next = await f.createActive({}, 'next', nextOwner);
  const archive = next.assignments!.readArchive(saved.id);
  assert.equal(archive.kind, 'found');
  if (archive.kind !== 'found') throw new Error('Own history missing');
  assert.equal(archive.assignment.result, false);
  const successor = await f.service.assign(nextOwner, next, f.spec({ resumesAssignmentId: saved.id }), 'continue');
  assert.equal(successor.spec.resumesAssignmentId, saved.id);
  assert.equal(successor.status, 'pending');
});
