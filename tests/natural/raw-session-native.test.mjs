import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {NATIVE_SCOPE_KEYS, createRawSessionNativeCapture, assembleRawSessionSetup, assertRawSessionSetupZero} from './raw-session-native.mjs';

// Coherent synthetic source records only. No SDK, profile, loader, or process is
// actually loaded by these controls; the injected verifier checks original
// record bytes against independent fixture pins rather than returning true.
const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function fixture({persisted = [], agentEvents = [], sessionEvents = [], queryEvents = [], readThrows, failClose = false} = {}) {
  const calls = [], fields = scope => Object.fromEntries(NATIVE_SCOPE_KEYS.map(key => [key, scope[key]]));
  const source = (file, text) => { const raw = Buffer.from(text); return {path: file, sha256: digest(raw), rawBase64: raw.toString('base64')}; };
  const owners = [source('/fixture/loader.mjs', '// synthetic loader'), source('/fixture/profile.json', '{"syntheticProfile":true}')];
  const scope = {caseId: 'fixture-case', candidateId: 'fixture-case', namespaceId: 'fixture-namespace', containerId: 'fixture-container', imageId: 'fixture-image', generationId: 'fixture-generation', nativeObserverSourceSha256: digest('// synthetic observer'), accountingScope: 'synthetic-control', observerClosureSha256: digest('// synthetic closure'), sdkVersion: '0.2.0-rc.2'};
  const header = {version: 4, id: 'fixture-session', createdAt: 1, cwd: '/fixture/workspace', isSeeded: false};
  const observer = {observerSha256: scope.nativeObserverSourceSha256, requests: [], status: 'OBSERVING'};
  const initialized = source('/fixture/observer.json', JSON.stringify(observer));
  const original = {schema: 'fixture-sdk-source/v1', ...fields(scope), nativePid: 123, owners, observerInitializationSource: initialized};
  const ownerPins = clone(owners);
  const verifySdkEvidence = (value, expected) => {
    calls.push('verify-sdk-profile-original'); assert.equal(value.schema, 'fixture-sdk-source/v1'); assert.deepEqual(fields(value), fields(expected));
    assert.deepEqual(value.owners, ownerPins);
    for (const row of [...value.owners, value.observerInitializationSource]) assert.equal(digest(Buffer.from(row.rawBase64, 'base64')), row.sha256);
    assert.equal(JSON.parse(Buffer.from(value.observerInitializationSource.rawBase64, 'base64')).observerSha256, expected.nativeObserverSourceSha256);
    return {schema: 'natural-sdk-source-verification/v1', ...fields(expected), sdkEvidenceSha256: digest(JSON.stringify(value)), observerEntrySha256: expected.nativeObserverSourceSha256, observerClosureSha256: expected.observerClosureSha256, observerInitializationSha256: value.observerInitializationSource.sha256};
  };
  const body = events => ({id: header.id, header: clone(header), seq: events.length, firstLiveSeq: 0, inheritedEventCount: 0, snapshotEvents(from, to) { calls.push('same-instance-read'); assert.deepEqual([from, to], [0, events.length]); return clone(events); }});
  const agent = {session: body(agentEvents), status: 'idle'};
  const services = {
    sessions: {list: () => [body(sessionEvents)]},
    sessionQuery: {listSessions: async () => [{header: clone(header), live: true, persisted: true}], readSession: async () => ({session: clone(header), events: clone(queryEvents), inheritedEventCount: 0})},
    sessionPersistence: {list: async () => [{header: clone(header), revision: 'fixture'}], open: async (id, access) => { calls.push('open-' + access); assert.equal(id, header.id); return {id, access, header: clone(header), inheritedEventCount: 0, read: async offset => { calls.push('read-' + offset); if (readThrows) throw readThrows.value; return {events: clone(persisted), eventState: 'detached'}; }, close: async () => { calls.push('close'); if (failClose) throw Error('fixture-close-error'); }}; }},
    settings: {describe: () => [{ns: 'subagent-model-selection-settings', applies: 'live', revision: 0, value: {enabled: true, allowedModels: []}}]},
    subagentModelSelection: {current: () => ({enabled: true, allowedModels: []})}, tools: {get: () => ({})},
  };
  const ctx = {on: () => {}, agents: {list: () => [agent]}, get: name => services[name], flow: {projector: {registry: () => ({runs: []})}}, workspaceRegistry: {list: () => [{id: 'workspace', path: header.cwd, sessionIds: [header.id]}]}};
  const ports = {ctx, scope, now: () => 2, pid: 123, parentPid: 122, loadEvidence: async () => clone(original), verifySdkEvidence,
    readObserver: async () => { const raw = Buffer.from(JSON.stringify(observer)); return {raw, value: clone(observer), source: {sha256: digest(raw)}}; }};
  return {calls, ports, scope, verifySdkEvidence};
}
async function pipeline(options) {
  const f = fixture(options), native = await createRawSessionNativeCapture(f.ports).capture();
  const assemble = () => assembleRawSessionSetup({native, scope: f.scope, verifySdkEvidence: f.verifySdkEvidence});
  return {...f, native, assemble, gate: snapshot => assertRawSessionSetupZero({native, snapshot, scope: f.scope, verifySdkEvidence: f.verifySdkEvidence})};
}
const requestHeader = {seq: 0, type: 'request/header', time: 2, data: {}};
test('public producer → assembler → gate rejects a same-ID durable request hidden by all live sources', async () => {
  const p = await pipeline({persisted: [requestHeader]}), snapshot = p.assemble();
  assert.equal(p.native.observedSubset.requestHeaderCount, 0); assert.equal(snapshot.fullSdkSummary.persisted.requestHeaders, 1);
  assert.equal(snapshot.setup.generationSourceObservations, 1); assert.throws(() => p.gate(snapshot), /Request header/);
  assert.ok(p.calls.includes('same-instance-read')); assert.ok(p.calls.includes('open-read') && p.calls.includes('read-0') && p.calls.includes('close'));
});
test('public actual consumption chain accepts complete coherent zero evidence without qualification credit', async () => {
  const p = await pipeline(), result = p.gate(p.assemble()); assert.equal(result.actualQualification, false); assert.equal(result.physicalAttemptCount, null);
  assert.ok(p.calls.filter(value => value === 'verify-sdk-profile-original').length >= 3);
});
for (const source of ['agentEvents', 'sessionEvents']) test(source + ' body cannot be replaced by an empty query body', async () => {
  const p = await pipeline({[source]: [requestHeader]}), snapshot = p.assemble(); assert.equal(snapshot.setup.generationSourceObservations, 1); assert.throws(() => p.gate(snapshot), /Request header/);
});
for (const verifier of [undefined, () => true, () => null, () => { throw Error('SDK source pending'); }]) test('missing or unbound SDK verifier never yields complete native evidence: ' + String(verifier), async () => {
  const f = fixture(); f.ports.verifySdkEvidence = verifier; const native = await createRawSessionNativeCapture(f.ports).capture(); assert.equal(native.status, 'unknown'); assert.ok(native.captureErrors.some(row => row.source === 'sdk-source-verification'));
  assert.throws(() => assembleRawSessionSetup({native, scope: f.scope, verifySdkEvidence: f.verifySdkEvidence}));
});
for (const mutate of [proof => proof.caseId = 'foreign', proof => proof.sdkEvidenceSha256 = '0'.repeat(64), proof => proof.observerInitializationSha256 = '1'.repeat(64), proof => proof.observerClosureSha256 = '2'.repeat(64)]) test('SDK verifier proof must bind this scope and original source: ' + String(mutate), async () => {
  const f = fixture(); f.ports.verifySdkEvidence = (value, scope) => { const proof = f.verifySdkEvidence(value, scope); mutate(proof); return proof; };
  const native = await createRawSessionNativeCapture(f.ports).capture(); assert.equal(native.status, 'unknown');
});
test('assembler cannot reuse capture proof after original SDK source changes', async () => { const p = await pipeline(); p.native.sdkLoad.extra = 'changed'; assert.throws(p.assemble, /binding changed/); });
test('assembler independently requires SDK/profile verification', async () => { const p = await pipeline(); assert.throws(() => assembleRawSessionSetup({native: p.native, scope: p.scope}), /verifier is required/); });
test('missing SDK service lookup is captured as unknown rather than an empty corpus', async () => { const f = fixture(), get = f.ports.ctx.get; f.ports.ctx.get = name => { if (name === 'sessionPersistence') throw null; return get(name); }; const native = await createRawSessionNativeCapture(f.ports).capture(); assert.equal(native.status, 'unknown'); assert.equal(native.fullSdkEvidence.status, 'unknown'); assert.ok(native.captureErrors.some(row => row.source === 'full-sdk-capture' && row.message === 'null')); });
test('a coherent self-hash does not replace independently pinned profile/loader owners', async () => { const f = fixture(), load = f.ports.loadEvidence; f.ports.loadEvidence = async () => { const value = await load(); value.owners[0] = {path: '/fixture/unapproved.mjs', sha256: digest('foreign'), rawBase64: Buffer.from('foreign').toString('base64')}; return value; }; const native = await createRawSessionNativeCapture(f.ports).capture(); assert.equal(native.status, 'unknown'); });
for (const value of [null, false, 0, '']) test('full consumer retains falsy read rejection and close failure: ' + JSON.stringify(value), async () => { const p = await pipeline({readThrows: {value}, failClose: true}); assert.equal(p.native.status, 'unknown'); assert.ok(p.native.fullSdkEvidence.errors.some(row => row.message === String(value))); assert.ok(p.native.fullSdkEvidence.errors.some(row => row.message === 'fixture-close-error')); assert.throws(p.assemble); });
test('gate reconstructs the snapshot rather than trusting its zero fields', async () => { const p = await pipeline({persisted: [requestHeader]}), snapshot = p.assemble(); snapshot.setup.generationSourceObservations = 0; assert.throws(() => p.gate(snapshot), /view changed/); });
