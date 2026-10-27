import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { getAgentInstanceId } from '../../../packages/dsh-flow/src/core/observation.js';
import { runFixture } from '../../helpers/contract-run.js';

for (const corruption of ['startedAt', 'endedAt', 'epoch', 'revision', 'recipientInstanceId', 'senderInstanceId', 'parent', 'child', 'prepare', 'receipt', 'receiptUnion', 'fractionalCount', 'negativeTimestamp'] as const) {
  test(`P5 new persistence format rejects malformed ${corruption} and preserves archive bytes`, async t => {
    const f = await runFixture(t); const run = await f.createActive(); const root = f.binding(run).root; const child = await f.child(run);
    const top = await f.service.assign(f.origin(), run, f.spec({ resultSchema: true }), 'top');
    const childHandle = await run.assignments!.prepare({ sender: root, recipient: child, parentAssignment: run.assignments!.resolve(top.id), spec: f.spec({ resultSchema: true }) }, 'child');
    await f.submit(run, child, childHandle, true, 'submission');
    const record = f.store.read(run.id)!; const assignment = record.assignments[childHandle.id]!;
    switch (corruption) {
      case 'startedAt': Object.assign(record, { startedAt: null }); break;
      case 'endedAt': record.endedAt = record.startedAt - 1; break;
      case 'epoch': record.epoch = 'not-a-uuid'; break;
      case 'revision': record.revision = 0.5; break;
      case 'recipientInstanceId': assignment.recipientInstanceId = ''; break;
      case 'senderInstanceId': if (assignment.sender.kind === 'agent') assignment.sender.instanceId = 'invalid'; break;
      case 'parent': assignment.parentAssignmentId = assignment.id; break;
      case 'child': assignment.continuingChildren = [{ assignmentId: top.id, reason: 'wrong edge' }]; break;
      case 'prepare': record.prepareKeys.bad = { digest: 'x', assignmentId: 'absent' }; break;
      case 'receipt': Object.values(record.receipts)[0]!.receipt.assignmentId = 'absent'; break;
      case 'receiptUnion': assignment.submissions[0]!.receipt.status = 'pending'; break;
      case 'fractionalCount': assignment.schemaFailures = 0.5; break;
      case 'negativeTimestamp': assignment.submissions[0]!.timestamp = -1; break;
    }
    const file = join(f.directory, `${run.id}.json`); const envelope: unknown = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(envelope && typeof envelope === 'object'); const bytes = JSON.stringify({ ...envelope, record }); await writeFile(file, bytes);
    assert.throws(() => new RunStore(f.directory).read(run.id), /Invalid persisted run record/); assert.equal(await readFile(file, 'utf8'), bytes);
  });
}

test('P5 cold resume shares Session identity but archives permanently retain the original instance UUID', async t => {
  const f = await runFixture(t); const run = await f.createActive(); const child = await f.child(run); const root = f.binding(run).root;
  const top = await f.service.assign(f.origin(), run, f.spec({ resultSchema: true }), 'top');
  const old = await run.assignments!.prepare({ sender: root, recipient: child, parentAssignment: run.assignments!.resolve(top.id), spec: f.spec({ resultSchema: true }) }, 'child');
  const original = run.assignments!.read(root, old); const id = getAgentInstanceId(child); await root.kill(child);
  f.binding(run).host.persisted.set(child.getProfile().sessionID, structuredClone(child.getProfile()));
  const resumed = await Agent.resume(f.binding(run).context, root, child.getProfile().sessionID); assert.notEqual(getAgentInstanceId(resumed), id);
  const snapshot = run.assignments!.read(root, old); assert.equal(snapshot.recipientSessionID, resumed.getProfile().sessionID); assert.equal(snapshot.recipientInstanceId, id); assert.equal(original.recipientInstanceId, id);
  assert.equal(f.service.readArchive(old.id).kind, 'found');
});
