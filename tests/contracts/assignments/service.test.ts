import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Agent } from '../../../packages/dsh-flow/src/core/index.js';
import { withTrustedCall } from '../../../packages/dsh-flow/src/assignments/internal.js';
import { compileSchema } from '../../../packages/dsh-flow/src/assignments/schema.js';
import { deferred, flush } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

async function setup(t: TestContext, options?: Parameters<typeof runFixture>[1]) {
  const f = await runFixture(t, options);
  const run = await f.createActive();
  const { root, context, host } = f.binding(run);
  const assignments = run.assignments;
  assert.ok(assignments);
  const top = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, 'top');
  return { f, run, root, context, host, assignments, top };
}

test('C039-01 C041-01 prepare saves a complete immutable spec and sender-scoped request replay without model input', async t => {
  const { f, run, root, host, assignments, top } = await setup(t);
  const child = await f.child(run);
  const materials = [{ id: 'material', sourceId: 'source', digest: 'digest', location: '/contract/input', mediaType: 'text/plain' }];
  const original = f.spec({ name: 'Review', type: 'analysis', background: 'Context', requirements: 'Find evidence', acceptanceCriteria: 'Cite sources', resultSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } });
  const expected = structuredClone(original);
  const request = { sender: root, recipient: child, parentAssignment: top, spec: original };
  const assignment = await assignments.prepare(request, 'review');
  assert.equal(await assignments.prepare({ ...request, spec: structuredClone(expected) }, 'review'), assignment);
  await assert.rejects(assignments.prepare({ ...request, spec: { ...expected, requirements: 'Different' } }, 'review'));
  original.requirements = 'changed';
  const snapshot = assignments.read(root, assignment);
  assert.deepEqual(snapshot.spec, expected);
  assert.equal(snapshot.runId, run.id);
  assert.equal(snapshot.parentAssignmentId, assignments.read(root, top).id);
  assert.deepEqual(snapshot.sender, { kind: 'agent', sessionID: root.getProfile().sessionID });
  assert.equal(snapshot.recipientSessionID, child.getProfile().sessionID);
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.submissionCount, 0);
  assert.equal(snapshot.schemaFailures, 0);
  assert.deepEqual(snapshot.submissions, []);
  assert.deepEqual(snapshot.continuingChildren, []);
  assert.equal(snapshot.schemaDialect, compileSchema(expected.resultSchema).dialect);
  assert.equal(snapshot.schemaDigest, compileSchema(expected.resultSchema).digest);
  assert.equal(snapshot.result, undefined);
  assert.equal(snapshot.reason, undefined);
  snapshot.spec.requirements = 'snapshot changed';
  assert.deepEqual(assignments.read(root, assignment).spec, expected);
  assert.equal(host.sent.length, 0);
  assert.equal(child.getMailbox().count(), 0);
  assert.deepEqual(assignments.list(root, { parentAssignment: top, status: 'pending' }).map(item => item.id), [snapshot.id]);
  await assert.rejects(assignments.prepare({ ...request, spec: f.spec({ materials }) }, 'unsupported-material'));
  await assert.rejects(assignments.prepare({ ...request, spec: f.spec({ resultSchema: { unsupportedKeyword: true } }) }, 'unsupported-schema'));
  assert.equal(assignments.list(root).length, 2);
});

test('C041-01 prepare request keys are scoped by the actual sender', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run); const grandchild = await f.child(run, child);
  const parentJob = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'same-request');
  const childJob = await assignments.prepare({ sender: child, recipient: grandchild, parentAssignment: parentJob, spec: f.spec({ resultSchema: true }) }, 'same-request');
  assert.notEqual(assignments.read(root, parentJob).id, assignments.read(root, childJob).id);
  assert.equal(assignments.read(root, childJob).parentAssignmentId, assignments.read(root, parentJob).id);
});

test('C041-01 C041-02 materials finish validation before save and complete trusted delivery bypasses recipient filters once', async t => {
  const validation = deferred();
  const observed: unknown[] = [];
  const { f, run, root, host, assignments, top } = await setup(t, { validateMaterials: async (recipient, refs) => { observed.push({ recipient, refs }); await validation.promise; } });
  const child = await f.child(run);
  const spec = f.spec({ materials: [{ id: 'material', sourceId: 'source', digest: 'sha256:input', location: '/input/report', mediaType: 'text/plain' }] });
  const preparing = assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec }, 'material');
  await flush();
  assert.deepEqual(observed, [{ recipient: child, refs: spec.materials }]);
  assert.equal(assignments.list(root).length, 1);
  assert.equal(host.sent.length, 0);
  validation.resolve();
  const assignment = await preparing;
  child.getMailbox().setFilters([() => true]);
  assignments.deliver(assignment);
  assignments.deliver(assignment);
  assert.equal(child.getMailbox().count(), 1);
  const delivered = child.getMailbox().query(undefined, 'get')[0]!;
  assert.deepEqual(delivered.source, { kind: 'system' });
  const content = typeof delivered.payload === 'string' ? delivered.payload : JSON.stringify(delivered.payload);
  for (const value of [spec.name, spec.type, spec.background, spec.requirements, spec.acceptanceCriteria, 'material', 'source', 'sha256:input', '/input/report', 'flow_submit', assignments.read(root, assignment).id]) assert.ok(content.includes(value), value);
  assert.ok(content.includes('resultSchema') || content.includes(JSON.stringify(spec.resultSchema)));
  assert.deepEqual(assignments.read(root, assignment).spec, spec);
  await flush();
  assert.equal(child.getMailbox().count(), 1);
});

test('C040-01 C041-01 material validation rechecks current direct parent and pending upper assignment', async t => {
  const gate = deferred();
  const { f, run, root, assignments, top } = await setup(t, { validateMaterials: async () => gate.promise });
  const child = await f.child(run);
  const adopt = await f.child(run);
  const spec = f.spec({ materials: [{ id: 'm', sourceId: 's', digest: 'd', location: '/m', mediaType: 'text/plain' }] });
  const preparing = assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec }, 'moving');
  await flush(); root.transfer(child, adopt); gate.resolve();
  await assert.rejects(preparing);
  assert.equal(assignments.list(root).length, 1);
  const gate2 = deferred();
  const f2 = await setup(t, { validateMaterials: async () => gate2.promise });
  const child2 = await f2.f.child(f2.run);
  const preparing2 = f2.assignments.prepare({ sender: f2.root, recipient: child2, parentAssignment: f2.top, spec }, 'ending');
  await flush();
  assert.equal((await f2.f.submit(f2.run, f2.root, f2.top, {})).kind, 'accepted');
  gate2.resolve();
  await assert.rejects(preparing2);
  assert.equal(f2.assignments.list(f2.root).length, 1);
});

test('C041-01 failed material validation and termination during validation leave no assignment registered', async t => {
  let rejectMaterials = true;
  const gate = deferred();
  const { f, run, root, context, assignments, top } = await setup(t, { validateMaterials: async () => {
    if (rejectMaterials) throw new Error('Material digest or model presentation is invalid');
    await gate.promise;
  } });
  const child = await f.child(run);
  const request = { sender: root, recipient: child, parentAssignment: top, spec: f.spec({ materials: [{ id: 'm', sourceId: 's', digest: 'd', location: '/m', mediaType: 'image/png' }] }) };
  await assert.rejects(assignments.prepare(request, 'invalid-material'), /Material/);
  assert.equal(assignments.list(root).length, 1);
  rejectMaterials = false;
  const preparing = assignments.prepare(request, 'terminate-during-validation');
  await flush();
  const releasing = context.release(child);
  gate.resolve();
  await assert.rejects(preparing);
  await releasing;
  assert.equal(assignments.list(root).length, 1);
});

test('C041-02 notification transport failure retries through the mailbox while assignment delivery stays single', async t => {
  const { f, run, root, host, assignments, top } = await setup(t);
  const child = await f.child(run);
  const job = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'notify-retry');
  let attempts = 0;
  host.sendHook = async () => { if (++attempts === 1) throw new Error('Transient notification failure'); };
  assignments.deliver(job);
  await flush();
  assert.equal(attempts, 1);
  assert.equal(assignments.read(root, job).status, 'pending');
  assert.equal(child.getMailbox().count(), 1);
  host.turnEnd(child);
  await flush();
  assert.equal(attempts, 2);
  assignments.deliver(job);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(child.getMailbox().count(), 1);
  assert.equal(assignments.read(root, job).status, 'pending');
});

test('C041-03 an inbox delivery failure settles the assignment with a queryable cause', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const job = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'delivery-failure');
  const receive = child.recvMessage;
  child.recvMessage = () => { throw new Error('Inbox unavailable'); };
  assert.throws(() => assignments.deliver(job), /Inbox unavailable/);
  child.recvMessage = receive;
  const saved = assignments.read(root, job);
  assert.equal(saved.status, 'failed'); assert.match(saved.reason ?? '', /Inbox unavailable/);
  assert.equal(child.getMailbox().count(), 0);
  assert.deepEqual(assignments.list(root, { status: 'failed' }).map(item => item.id), [saved.id]);
  assert.throws(() => assignments.deliver(job));
});

test('C040-01 prepare rejects non-direct, foreign, inactive and wrong-upper recipients', async t => {
  const { f, run, root, context, assignments, top } = await setup(t);
  const child = await f.child(run);
  const grandchild = await f.child(run, child);
  const childJob = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'child');
  await assert.rejects(assignments.prepare({ sender: root, recipient: grandchild, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'skip'));
  await assert.rejects(assignments.prepare({ sender: root, recipient: child, parentAssignment: childJob, spec: f.spec({ resultSchema: true }) }, 'wrong-upper'));
  await assert.rejects(assignments.prepare({ sender: run, recipient: child, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, 'top-child'));
  const other = await f.createActive({}, 'another-run');
  const foreign = f.binding(other).root;
  await assert.rejects(assignments.prepare({ sender: root, recipient: foreign, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'foreign'));
  await context.release(grandchild);
  await assert.rejects(assignments.prepare({ sender: child, recipient: grandchild, parentAssignment: childJob, spec: f.spec({ resultSchema: true }) }, 'released'));
  await assignments.cancel(run, top, 'stop');
  await assert.rejects(assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'ended-upper'));
});

test('C040-02 transfer preserves old assignment edges, checks new edges and fork inherits no assignments', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const adopt = await f.child(run);
  const adoptJob = await assignments.prepare({ sender: root, recipient: adopt, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'adopt');
  const old = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'old');
  const saved = assignments.read(root, old);
  root.transfer(child, adopt);
  assert.deepEqual(assignments.read(root, old), saved);
  await assert.rejects(assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'old-parent'));
  const next = await assignments.prepare({ sender: adopt, recipient: child, parentAssignment: adoptJob, spec: f.spec({ resultSchema: true }) }, 'new-parent');
  assert.equal(assignments.read(root, next).parentAssignmentId, assignments.read(root, adoptJob).id);
  const fork = await child.fork();
  assert.ok(fork instanceof Agent);
  assert.equal(assignments.list(root).filter(item => item.recipientSessionID === fork.getProfile().sessionID).length, 0);
  assert.deepEqual(assignments.read(root, old), saved);
  assert.equal(assignments.list(root).filter(item => item.recipientSessionID === child.getProfile().sessionID).length, 2);
});

test('C042-01 missing pending direct child reasons returns all IDs before format checking and accepted reasons persist', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const strict = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: { type: 'string' } }) }, 'strict');
  const a = await f.child(run); const b = await f.child(run); const c = await f.child(run);
  const one = await assignments.prepare({ sender: root, recipient: a, parentAssignment: strict, spec: f.spec({ resultSchema: true }) }, 'one');
  const two = await assignments.prepare({ sender: root, recipient: b, parentAssignment: strict, spec: f.spec({ resultSchema: true }) }, 'two');
  const ended = await assignments.prepare({ sender: root, recipient: c, parentAssignment: strict, spec: f.spec({ resultSchema: true }) }, 'ended');
  await f.submit(run, c, ended, null);
  const otherTree = await assignments.prepare({ sender: root, recipient: a, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'other-tree');
  const receipt = await f.submit(run, root, strict, 123, 'missing', [{ assignment: one, reason: '  ' }]);
  assert.equal(receipt.kind, 'missing-children');
  assert.deepEqual(new Set(receipt.missingChildren), new Set([assignments.read(root, one).id, assignments.read(root, two).id]));
  assert.equal(assignments.read(root, strict).schemaFailures, 0);
  assert.equal(assignments.read(root, strict).status, 'pending');
  const accepted = await f.submit(run, root, strict, 'complete', 'accept', [{ assignment: one, reason: 'Continue evidence' }, { assignment: two, reason: 'Finish measurement' }]);
  assert.equal(accepted.kind, 'accepted');
  assert.deepEqual(assignments.read(root, strict).continuingChildren, [{ assignmentId: assignments.read(root, one).id, reason: 'Continue evidence' }, { assignmentId: assignments.read(root, two).id, reason: 'Finish measurement' }]);
  assert.equal(assignments.read(root, otherTree).status, 'pending');
});

test('C043-01 C043-02 trusted submit replay reuses receipts, rejects altered arguments and permits exactly two corrections', async t => {
  const { f, run, root, host, assignments } = await setup(t);
  const strict = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } }) }, 'strict');
  const result = { value: 'wrong' };
  const first = await f.submit(run, root, strict, result, 'tool-1');
  assert.equal(first.kind, 'invalid-result'); assert.equal(first.status, 'pending');
  assert.ok(first.errors?.some(error => error.path.includes('value') && error.message.length > 0));
  assert.deepEqual(await f.submit(run, root, strict, structuredClone(result), 'tool-1'), first);
  await assert.rejects(f.submit(run, root, strict, { value: 1 }, 'tool-1'));
  assert.equal(assignments.read(root, strict).submissionCount, 1);
  assert.equal(assignments.read(root, strict).schemaFailures, 1);
  const second = await f.submit(run, root, strict, result, 'tool-2');
  assert.equal(second.kind, 'invalid-result'); assert.equal(second.status, 'pending');
  const third = await f.submit(run, root, strict, result, 'tool-3');
  assert.equal(third.kind, 'invalid-result'); assert.equal(third.status, 'failed');
  assert.equal(assignments.read(root, strict).schemaFailures, 3);
  assert.equal(assignments.read(root, strict).submissionCount, 3);
  assert.deepEqual(await f.submit(run, root, strict, result, 'tool-1'), first);
  const terminal = await f.submit(run, root, strict, { value: 1 }, 'tool-4');
  assert.equal(terminal.kind, 'terminal'); assert.equal(terminal.status, 'failed');
  const saved = assignments.read(root, strict);
  assert.equal(saved.submissionCount, 4); assert.equal(saved.submissions.length, 4); assert.equal(saved.schemaFailures, 3);
  assert.equal(saved.result, undefined); assert.ok(saved.reason);
  assert.deepEqual(result, { value: 'wrong' });
  assert.equal(host.sent.length, 0);
});

test('C043-02 submit requires trusted actor transport context and rejects a model-provided replay key', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const submission = { result: null, continuingChildren: [] };
  await assert.rejects(assignments.submit(root, top, submission));
  await assert.rejects(withTrustedCall({ actor: child, transportKey: 'spoof' }, () => assignments.submit(root, top, submission)));
  await assert.rejects(withTrustedCall({ actor: root, transportKey: 'spoof-recipient' }, () => assignments.submit(child, top, submission)));
  await assert.rejects(assignments.submit(root, top, { ...submission, transportKey: 'model-key' } as never));
  assert.equal(assignments.read(root, top).submissionCount, 0);
  const accepted = await withTrustedCall({ actor: root, transportKey: 'real-host-key' }, () => assignments.submit(root, top, { ...submission, transportKey: 'model-key' } as never));
  assert.equal(accepted.kind, 'accepted');
  assert.equal(assignments.read(root, top).result, null);
  assert.deepEqual(await f.submit(run, root, top, null, 'real-host-key'), accepted);
  assert.equal(assignments.read(root, top).submissionCount, 1);
  const independent = await withTrustedCall({ actor: root, transportKey: 'another-real-host-key' }, () => assignments.submit(root, top, { ...submission, transportKey: 'model-key' } as never));
  assert.equal(independent.kind, 'terminal');
  assert.equal(assignments.read(root, top).submissionCount, 2);
});

test('C043-02 overlapping trusted submit contexts retain each real actor and scope transport keys by recipient', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const a = await f.child(run); const b = await f.child(run);
  const one = await assignments.prepare({ sender: root, recipient: a, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'one');
  const two = await assignments.prepare({ sender: root, recipient: b, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'two');
  const gate = deferred();
  const first = withTrustedCall({ actor: a, transportKey: 'shared-call-key' }, async () => {
    await gate.promise;
    return assignments.submit(a, one, { result: 'a', continuingChildren: [] });
  });
  const second = withTrustedCall({ actor: b, transportKey: 'shared-call-key' }, async () => {
    await gate.promise;
    return assignments.submit(b, two, { result: 'b', continuingChildren: [] });
  });
  gate.resolve();
  const receipts = await Promise.all([first, second]);
  assert.deepEqual(receipts.map(receipt => receipt.kind), ['accepted', 'accepted']);
  assert.deepEqual(receipts.map(receipt => receipt.assignmentId), [assignments.read(root, one).id, assignments.read(root, two).id]);
  assert.equal(assignments.read(root, one).result, 'a'); assert.equal(assignments.read(root, two).result, 'b');
  assert.equal(assignments.read(root, one).submissionCount, 1); assert.equal(assignments.read(root, two).submissionCount, 1);
});

test('C039-03 C044-01 first valid JSON result is saved before submitted and cannot be replaced by later calls', async t => {
  const { f, run, root, assignments } = await setup(t);
  for (const [index, result] of [null, false, 0, '', [false, null], { content: 'not judged by runtime' }].entries()) {
    const assignment = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, `json-${index}`);
    assert.equal((await f.submit(run, root, assignment, result, `first-${index}`)).kind, 'accepted');
    assert.deepEqual(assignments.read(root, assignment).result, result);
    assert.equal(assignments.readArchive(assignments.read(root, assignment).id).kind, 'found');
    const later = await f.submit(run, root, assignment, 'replacement', `second-${index}`);
    assert.equal(later.kind, 'terminal'); assert.equal(later.status, 'submitted');
    assert.deepEqual(assignments.read(root, assignment).result, result);
    assert.equal(assignments.read(root, assignment).submissionCount, 2);
  }
});

test('C039-03 non-JSON submission data is rejected without accepting or mutating the assignment', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const [index, result] of [undefined, NaN, Infinity, { x: undefined }, [undefined], cycle, new Date()].entries()) {
    await assert.rejects(f.submit(run, root, top, result as never, `non-json-${index}`));
    assert.equal(assignments.read(root, top).status, 'pending');
    assert.equal(assignments.read(root, top).result, undefined);
  }
});

test('C044-01 Store write failure never reports accepted or publishes submitted', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  f.failWrites('write', new Error('contract disk failure'), run.id);
  await assert.rejects(f.submit(run, root, top, { accepted: true }, 'disk-failure'));
  const snapshot = assignments.read(root, top);
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.result, undefined);
  const archive = assignments.readArchive(snapshot.id);
  assert.equal(archive.kind, 'found');
  if (archive.kind === 'found') { assert.equal(archive.assignment.status, 'pending'); assert.equal(archive.assignment.result, undefined); }
  assert.ok(f.service.read(f.origin(), run).storageError);
  f.clearFault();
});

test('C044-01 accepted result and continuing reasons are readable from a fresh Store instance', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const ongoing = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'ongoing');
  const result = { evidence: [false, null, 0] };
  await f.submit(run, root, top, result, 'save', [{ assignment: ongoing, reason: 'Collect final evidence' }]);
  const snapshot = assignments.read(root, top);
  const second = await runFixture(t, { directory: f.directory });
  const archive = second.service.readArchive(snapshot.id);
  assert.equal(archive.kind, 'found');
  if (archive.kind === 'found') {
    assert.deepEqual(archive.assignment, snapshot);
    assert.equal(archive.interrupted, false);
    assert.deepEqual(archive.assignment.result, result);
  }
  result.evidence.push(42);
  assert.deepEqual(assignments.read(root, top).result, { evidence: [false, null, 0] });
});

test('C046-02 C046-03 archive retains interrupted history and explicit resumed jobs establish fresh current relationships', async t => {
  const { f, run, root, host, assignments, top } = await setup(t);
  const child = await f.child(run);
  const job = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'old-child');
  const oldTop = assignments.read(root, top); const oldChild = assignments.read(root, job);
  await host.persist(host.native(child));
  const second = await runFixture(t, { directory: f.directory });
  for (const snapshot of [oldTop, oldChild]) {
    const archive = second.service.readArchive(snapshot.id);
    assert.equal(archive.kind, 'found');
    if (archive.kind === 'found') {
      assert.deepEqual(archive.assignment, snapshot);
      assert.equal(archive.assignment.status, 'pending');
      assert.equal(archive.interrupted, true);
      assert.deepEqual(JSON.parse(JSON.stringify(archive.assignment)), snapshot);
    }
  }
  assert.deepEqual(second.service.list(second.origin()), []);
  const freshRun = await second.createActive();
  const fresh = second.binding(freshRun);
  assert.ok(freshRun.assignments);
  const freshAssignments = freshRun.assignments;
  assert.equal(freshAssignments.list(fresh.root).length, 0);
  assert.throws(() => freshAssignments.read(fresh.root, job));
  assert.throws(() => freshAssignments.resolve(oldChild.id));
  fresh.host.persisted.set(child.getProfile().sessionID, structuredClone(child.getProfile()));
  const resumed = await Agent.resume(fresh.context, fresh.root, child.getProfile().sessionID);
  assert.equal(freshAssignments.list(resumed).length, 0);
  const continuedTop = await freshAssignments.prepare({ sender: freshRun, recipient: fresh.root, parentAssignment: null, spec: second.spec({ resultSchema: true, resumesAssignmentId: oldTop.id }) }, 'new-top');
  const continuedChild = await freshAssignments.prepare({ sender: fresh.root, recipient: resumed, parentAssignment: continuedTop, spec: second.spec({ resultSchema: true, resumesAssignmentId: oldChild.id }) }, 'new-child');
  const nextTop = freshAssignments.read(fresh.root, continuedTop); const nextChild = freshAssignments.read(fresh.root, continuedChild);
  assert.notEqual(nextTop.id, oldTop.id); assert.notEqual(nextChild.id, oldChild.id);
  assert.equal(nextTop.spec.resumesAssignmentId, oldTop.id); assert.equal(nextChild.spec.resumesAssignmentId, oldChild.id);
  assert.equal(nextTop.parentAssignmentId, null); assert.equal(nextChild.parentAssignmentId, nextTop.id);
  assert.equal(nextChild.runId, freshRun.id);
  assert.deepEqual(nextChild.sender, { kind: 'agent', sessionID: fresh.root.getProfile().sessionID });
  assert.equal(nextChild.recipientSessionID, resumed.getProfile().sessionID);
  assert.equal(second.service.readArchive(oldChild.id).kind, 'found');
});

test('C042-02 new child registration before parent submit is visible; parent submit before registration prevents a late child', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const registration = assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'child-first');
  const submitting = f.submit(run, root, top, {}, 'parent-second');
  const job = await registration;
  const receipt = await submitting;
  assert.equal(receipt.kind, 'missing-children');
  assert.deepEqual(receipt.missingChildren, [assignments.read(root, job).id]);
  const parent2 = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, 'parent2');
  const ending = f.submit(run, root, parent2, {}, 'parent-first');
  const late = assignments.prepare({ sender: root, recipient: child, parentAssignment: parent2, spec: f.spec({ resultSchema: true }) }, 'child-second');
  assert.equal((await ending).kind, 'accepted');
  await assert.rejects(late);
  assert.equal(assignments.list(root, { parentAssignment: parent2 }).length, 0);
});

test('C044-03 cancel and submit respect both call orders and publish one terminal result', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const cancelling = assignments.cancel(run, top, 'cancel first');
  const rejected = f.submit(run, root, top, {}, 'after-cancel');
  await cancelling;
  assert.equal((await rejected).status, 'cancelled');
  assert.equal(assignments.read(root, top).result, undefined);
  const second = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, 'submit-first');
  const submitting = f.submit(run, root, second, false, 'before-cancel');
  const cancelled = assignments.cancel(run, second, 'too late');
  assert.equal((await submitting).kind, 'accepted');
  assert.ok((await cancelled).some(outcome => outcome.status === 'submitted'));
  assert.equal(assignments.read(root, second).status, 'submitted');
  assert.equal(assignments.read(root, second).result, false);
});

test('C044-02 C044-03 logical termination synchronously fails all pending assignments and preserves earlier submitted results', async t => {
  const { f, run, root, context, assignments, top } = await setup(t);
  const child = await f.child(run);
  const a = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'a');
  const b = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'b');
  const c = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'c');
  const completing = f.submit(run, child, c, 'saved', 'before-termination');
  const releasing = context.release(child);
  for (const assignment of [a, b]) {
    const snapshot = assignments.read(root, assignment);
    assert.equal(snapshot.status, 'failed'); assert.ok(snapshot.reason);
  }
  assert.equal(assignments.read(root, c).status, 'submitted');
  assert.equal((await completing).kind, 'accepted');
  assert.equal((await f.submit(run, child, a, {}, 'after-termination')).status, 'failed');
  await releasing;
  assert.equal(assignments.read(root, c).result, 'saved');
  assert.equal(assignments.read(root, top).status, 'pending');
});

test('C045-01 C045-02 recursive cancellation crosses submitted and failed nodes, retains results and other trees, and never terminates Agents', async t => {
  const { f, run, root, host, assignments, top } = await setup(t);
  const child = await f.child(run); const grandchild = await f.child(run, child);
  const other = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec({ resultSchema: true }) }, 'other');
  const retained = await assignments.prepare({ sender: root, recipient: child, parentAssignment: other, spec: f.spec({ resultSchema: true }) }, 'retained');
  const submitted = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'submitted');
  const leafA = await assignments.prepare({ sender: child, recipient: grandchild, parentAssignment: submitted, spec: f.spec({ resultSchema: true }) }, 'leaf-a');
  const failed = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: { type: 'string' } }) }, 'failed');
  const leafB = await assignments.prepare({ sender: child, recipient: grandchild, parentAssignment: failed, spec: f.spec({ resultSchema: true }) }, 'leaf-b');
  await f.submit(run, child, submitted, { preserved: true }, 'submitted', [{ assignment: leafA, reason: 'Keep working' }]);
  for (let index = 0; index < 3; index++) await f.submit(run, child, failed, 0, `invalid-${index}`, [{ assignment: leafB, reason: 'Keep working' }]);
  await assert.rejects(assignments.cancel(child, top, 'not sender'));
  const beforeReleases = host.releases.length;
  const cancelled = await assignments.cancel(run, top, 'stop subtree');
  assert.equal(assignments.read(root, top).status, 'cancelled');
  for (const leaf of [leafA, leafB]) assert.equal(assignments.read(root, leaf).status, 'cancelled');
  assert.equal(assignments.read(root, submitted).status, 'submitted');
  assert.deepEqual(assignments.read(root, submitted).result, { preserved: true });
  assert.equal(assignments.read(root, failed).status, 'failed');
  assert.equal(assignments.read(root, retained).status, 'pending');
  assert.equal(assignments.read(root, other).status, 'pending');
  assert.equal(host.releases.length, beforeReleases);
  assert.notEqual(root.getStatus(), 'terminated'); assert.notEqual(child.getStatus(), 'terminated'); assert.notEqual(grandchild.getStatus(), 'terminated');
  await flush();
  const notifications = [root, child, grandchild].map(agent => agent.getMailbox().count());
  assert.deepEqual(await assignments.cancel(run, top, 'stop subtree'), cancelled);
  await flush();
  assert.deepEqual([root, child, grandchild].map(agent => agent.getMailbox().count()), notifications);
  assert.equal((await f.submit(run, grandchild, leafA, {}, 'after-cancel')).status, 'cancelled');
});

test('C046-01 completion and failure send ordinary System lookup hints and cancel sends the recipient a stop hint', async t => {
  const { f, run, root, assignments, top } = await setup(t);
  const child = await f.child(run);
  const completed = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'complete');
  root.getMailbox().setSourcePriority({ kind: 'system' }, 'low');
  await f.submit(run, child, completed, false);
  const completedId = assignments.read(root, completed).id;
  const notices = root.getMailbox().query(undefined, 'get');
  assert.ok(notices.some(message => 'kind' in message.source && message.source.kind === 'system' && JSON.stringify(message.payload).includes(completedId)));
  assert.ok(root.getMailbox().query().some(message => message.priority === 'normal'));
  const failed = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: false }) }, 'fail');
  for (let index = 0; index < 3; index++) await f.submit(run, child, failed, null, `fail-${index}`);
  assert.ok(root.getMailbox().query(undefined, 'get').some(message => JSON.stringify(message.payload).includes(assignments.read(root, failed).id)));
  const cancelled = await assignments.prepare({ sender: root, recipient: child, parentAssignment: top, spec: f.spec({ resultSchema: true }) }, 'cancel');
  await assignments.cancel(root, cancelled, 'No longer needed');
  assert.ok(child.getMailbox().query(undefined, 'get').some(message => 'kind' in message.source && message.source.kind === 'system' && JSON.stringify(message.payload).includes(assignments.read(root, cancelled).id)));
});
