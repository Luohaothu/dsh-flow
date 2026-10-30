import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDrainEvidenceReader, mergeRequestSettlements } from './evidence-view.mjs';

const record = value => ({ value: structuredClone(value), bytes: Buffer.from(JSON.stringify(value, null, 2)) });
const request = (patch = {}) => ({ number: 1, sessionId: 'fixture-main', afterEventSeq: 12, provider: 'fixture-provider', model: 'fixture-model', startedAt: 10,
  promptSha256: 'fixture-prompt-digest', tools: ['fixture-tool'], maxTokens: 100, status: 'running', ...patch });
const business = requests => record({ status: 'ABORTED', reason: 'fixture-boundary', endedAt: 20, requests, histories: [{ sessionId: 'fixture-main', events: [{ seq: 12 }] }], snapshots: [{ run: { status: 'active' } }] });
const witness = (boundary, requests, patch = {}) => record({ schema: 'flow-natural-shutdown/v1', phase: 'post-boundary-stream', scoringEligible: false, observedAt: 30, capturedAt: 30,
  businessBoundary: { file: 'evidence.json', sha256: createHash('sha256').update(boundary.bytes).digest('hex'), status: boundary.value.status, reason: boundary.value.reason, endedAt: boundary.value.endedAt },
  requests, histories: [{ sessionId: 'fixture-main', events: [{ seq: 99, type: 'turn/end' }] }], registry: null, snapshots: [{ run: { status: 'stopped' } }], captureErrors: [], ...patch });

function fixture(boundary) {
  const files = new Map([['evidence.json', boundary]]);
  return { files, read: createDrainEvidenceReader({ boundary, read: name => files.get(name) }) };
}

test('shutdown settles an in-flight request using its last cumulative usage without changing business facts', () => {
  const boundary = business([request({ usage: { totalTokens: 4 } }), request({ number: 2, status: 'completed', endedAt: 15, usage: { totalTokens: 3 } })]);
  const original = Buffer.from(boundary.bytes), f = fixture(boundary);
  f.files.set('shutdown-evidence.json', witness(boundary, [request({ status: 'completed', endedAt: 30, usage: { totalTokens: 9 } }), boundary.value.requests[1]], { totalReportedTokens: 9999, usageMissingRequests: [999] }));
  const view = f.read();
  assert.equal(view.totalReportedTokens, 12);
  assert.deepEqual(view.usageMissingRequests, []);
  assert.equal(view.requests[0].status, 'completed');
  assert.equal(view.requestEvidence.mode, 'shutdown-witness');
  assert.equal(view.requestEvidence.scoringEligible, false);
  assert.deepEqual(Object.keys(view).sort(), ['requestEvidence', 'requests', 'totalReportedTokens', 'usageMissingRequests']);
  assert.deepEqual(boundary.bytes, original);
  assert.equal(boundary.value.status, 'ABORTED');
  assert.equal(boundary.value.requests[0].status, 'running');
  assert.equal(boundary.value.histories[0].events.at(-1).seq, 12);
  assert.equal(boundary.value.snapshots[0].run.status, 'active');
});

test('cancelled requests retain unknown usage instead of carrying an earlier cumulative sample forward', () => {
  const boundary = business([request({ usage: { totalTokens: 4 } })]), f = fixture(boundary);
  f.files.set('shutdown-evidence.json', witness(boundary, [request({ status: 'cancelled', endedAt: 30 })]));
  const view = f.read();
  assert.equal(view.requests[0].usage, undefined);
  assert.equal(view.totalReportedTokens, 0);
  assert.deepEqual(view.usageMissingRequests, [1]);
});

test('an absent shutdown preserves running requests and supports settlement from a legacy observer', () => {
  const boundary = business([request()]), f = fixture(boundary);
  assert.equal(f.read().requests[0].status, 'running');
  f.files.set('evidence.json', record({ ...boundary.value, requests: [request({ status: 'failed', endedAt: 30, error: 'fixture stream failure' })] }));
  const view = f.read();
  assert.equal(view.requests[0].status, 'failed');
  assert.equal(view.requestEvidence.mode, 'legacy-observer');
  assert.deepEqual(view.usageMissingRequests, [1]);
});

test('a legacy observer cannot change the business boundary or regress its accepted terminal request', () => {
  const boundary = business([request()]), f = fixture(boundary);
  f.files.set('evidence.json', record({ ...boundary.value, status: 'SETTLED' }));
  assert.throws(f.read, { code: 'evidence-business-boundary-changed' });
  f.files.set('evidence.json', record({ ...boundary.value, requests: [request({ status: 'completed', endedAt: 30 })] }));
  f.read(); f.files.set('evidence.json', boundary);
  assert.throws(f.read, { code: 'evidence-request-terminal-changed' });
});

test('the reader preserves the exact adopted witness bytes and exposes the independent frozen reference', () => {
  const boundary = business([request()]), shutdown = witness(boundary, [request({ status: 'completed', endedAt: 30 })]);
  const files = new Map([['evidence.json', boundary], ['shutdown-evidence.json', shutdown]]), copies = [];
  const read = createDrainEvidenceReader({ boundary, read: name => files.get(name), preserve: (record, source) => {
    copies.push({ bytes: Buffer.from(record.bytes), source }); return 'fixture-frozen.json';
  } });
  const view = read();
  assert.deepEqual(copies[0].bytes, shutdown.bytes);
  assert.equal(view.requestEvidence.frozenFile, 'fixture-frozen.json');
  assert.equal(copies[0].source.sha256, createHash('sha256').update(copies[0].bytes).digest('hex'));
});

for (const [name, mutate, code] of [
  ['SHA', value => { value.businessBoundary.sha256 = '0'.repeat(64); }, 'evidence-shutdown-boundary-mismatch'],
  ['file', value => { value.businessBoundary.file = 'other.json'; }, 'evidence-shutdown-boundary-mismatch'],
  ['boundary status', value => { value.businessBoundary.status = 'SETTLED'; }, 'evidence-shutdown-boundary-mismatch'],
  ['boundary reason', value => { value.businessBoundary.reason = 'other'; }, 'evidence-shutdown-boundary-mismatch'],
  ['boundary time', value => { value.businessBoundary.endedAt++; }, 'evidence-shutdown-boundary-mismatch'],
  ['schema', value => { value.schema = 'other/v1'; }, 'evidence-shutdown-schema-invalid'],
  ['scoring flag', value => { value.scoringEligible = true; }, 'evidence-shutdown-schema-invalid'],
  ['phase', value => { value.phase = 'business-success'; }, 'evidence-shutdown-schema-invalid'],
  ['capture errors', value => { value.captureErrors.push({ source: 'fixture', error: 'not captured' }); }, 'evidence-shutdown-capture-errors'],
  ['new request', value => { value.requests.push(request({ number: 2 })); }, 'evidence-request-set-changed'],
  ['missing request', value => { value.requests = []; }, 'evidence-request-set-changed'],
  ['duplicate number', value => { value.requests.push(value.requests[0]); }, 'evidence-request-invalid-or-duplicate'],
  ['changed number', value => { value.requests[0].number = 2; }, 'evidence-request-set-changed'],
  ['unknown status', value => { value.requests[0].status = 'settled'; }, 'evidence-request-invalid-or-duplicate'],
]) {
  test(`shutdown rejects ${name} instead of falling back to a legacy complete view`, () => {
    const boundary = business([request()]), f = fixture(boundary), shutdown = witness(boundary, [request({ status: 'completed', endedAt: 30 })]);
    mutate(shutdown.value); f.files.set('shutdown-evidence.json', record(shutdown.value));
    assert.throws(f.read, { code });
  });
}

for (const field of ['sessionId', 'afterEventSeq', 'provider', 'model', 'startedAt', 'promptSha256', 'tools', 'maxTokens', 'futureIdentity']) {
  test(`shutdown rejects changed or removed request identity ${field}`, () => {
    const original = request({ futureIdentity: { key: 'fixture' } }), boundary = business([original]);
    for (const remove of [false, true]) {
      const next = { ...original, status: 'completed', endedAt: 30 };
      if (remove) delete next[field]; else next[field] = { changed: true };
      const f = fixture(boundary); f.files.set('shutdown-evidence.json', witness(boundary, [next]));
      assert.throws(f.read, { code: 'evidence-request-identity-changed' });
    }
  });
}

test('request identity preserves absent optional fields and compares lists independently of ordering', () => {
  const first = request(); delete first.afterEventSeq;
  const second = request({ number: 2 });
  const boundary = business([first, second]);
  const view = mergeRequestSettlements(boundary.value, { requests: [{ ...second, status: 'completed' }, first] });
  assert.deepEqual(view.requests.map(item => item.number), [1, 2]);
  assert.equal(Object.hasOwn(view.requests[0], 'afterEventSeq'), false);
  assert.throws(() => mergeRequestSettlements(boundary.value, { requests: [{ ...first, afterEventSeq: 0 }, second] }), { code: 'evidence-request-identity-changed' });
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`shutdown cannot change a frozen ${status} request or an already accepted terminal request`, () => {
    const terminal = request({ status, endedAt: 15, usage: { totalTokens: 4 }, output: 'fixture output' });
    for (const patch of [{ status: 'running' }, { status: status === 'completed' ? 'failed' : 'completed' }, { usage: { totalTokens: 5 } }, { output: 'changed' }, { endedAt: 16 }]) {
      const boundary = business([terminal]), f = fixture(boundary);
      f.files.set('shutdown-evidence.json', witness(boundary, [{ ...terminal, ...patch }]));
      assert.throws(f.read, { code: 'evidence-request-terminal-changed' });
      const running = business([request()]), later = fixture(running);
      later.files.set('shutdown-evidence.json', witness(running, [terminal])); later.read();
      later.files.set('shutdown-evidence.json', witness(running, [{ ...terminal, ...patch }]));
      assert.throws(later.read, { code: 'evidence-request-terminal-changed' });
    }
  });
}

test('an incomplete current JSON or shutdown is pending and a disappeared witness cannot restore legacy completion', () => {
  const boundary = business([request({ status: 'completed', endedAt: 15 })]), f = fixture(boundary);
  f.files.set('shutdown-evidence.json', { pending: true });
  assert.equal(f.read(), undefined);
  f.files.set('shutdown-evidence.json', witness(boundary, boundary.value.requests));
  f.files.set('evidence.json', { pending: true }); assert.equal(f.read(), undefined);
  f.files.set('evidence.json', boundary); assert.equal(f.read().requests[0].status, 'completed');
  f.files.delete('shutdown-evidence.json'); assert.throws(f.read, { code: 'evidence-shutdown-missing' });
});

test('a shutdown bound to parsed business values still rejects changed original bytes', () => {
  const boundary = business([request()]), f = fixture(boundary);
  f.files.set('shutdown-evidence.json', witness(boundary, [request({ status: 'completed', endedAt: 30 })]));
  f.files.set('evidence.json', { value: boundary.value, bytes: Buffer.from(JSON.stringify(boundary.value)) });
  assert.throws(f.read, { code: 'evidence-shutdown-boundary-mismatch' });
});

test('invalid usage cannot enter a technical settlement view', () => {
  for (const usage of [null, [], { totalTokens: -1 }, { totalTokens: '4' }, { totalTokens: Infinity }]) {
    assert.throws(() => mergeRequestSettlements({ requests: [request()] }, { requests: [request({ status: 'completed', usage })] }), { code: 'evidence-request-usage-invalid' });
  }
});
