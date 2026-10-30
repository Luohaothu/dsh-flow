import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectRawSessionEvidence, selectRawSessionEvidence, assertRawSessionZero} from './raw-session-evidence.mjs';

export const NATIVE_SCOPE_KEYS = Object.freeze(['caseId','candidateId','namespaceId','containerId','imageId','generationId','nativeObserverSourceSha256','accountingScope']);
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonDigest = value => digest(JSON.stringify(value));
const scopeFields = scope => Object.fromEntries(NATIVE_SCOPE_KEYS.map(key => [key, scope[key]]));
const sameScope = (value, scope) => {
  for (const key of NATIVE_SCOPE_KEYS) { assert.ok(typeof scope[key] === 'string' && scope[key], 'Missing source scope: ' + key); assert.equal(value[key], scope[key], 'Foreign source scope: ' + key); }
};
const errorRecord = (source, error) => ({source, name: error?.name ?? 'Error', message: error?.message ?? String(error)});

// The SDK-specific verifier must validate its loader/profile/source records,
// then return this binding. A boolean cannot stand in for that evidence. Both
// capture and Root assembly independently invoke the required verifier. This
// digest binds the JSON subrecord; its consumer must also pin the original
// containing file's raw bytes before calling the assembler.
function verifySdkBinding(native, scope, verifySdkEvidence) {
  assert.equal(typeof verifySdkEvidence, 'function', 'SDK/profile verifier is required');
  const evidence = native.sdkLoad;
  assert.ok(evidence && typeof evidence === 'object'); sameScope(evidence, scope);
  const proof = verifySdkEvidence(evidence, scope);
  assert.equal(proof?.schema, 'natural-sdk-source-verification/v1'); sameScope(proof, scope);
  assert.equal(proof.sdkEvidenceSha256, jsonDigest(evidence), 'SDK verification belongs to different original bytes');
  assert.equal(proof.observerEntrySha256, scope.nativeObserverSourceSha256);
  assert.equal(proof.observerClosureSha256, scope.observerClosureSha256);
  assert.match(proof.observerClosureSha256, /^[a-f0-9]{64}$/u);
  assert.equal(proof.observerInitializationSha256, evidence.observerInitializationSource?.sha256);
  assert.match(proof.observerInitializationSha256, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.nativePid, native.nativePid, 'SDK verification belongs to another process');
  return clone(proof);
}

// Read-only SDK facade: no create, resume, restore, prompt, write, or flush.
// Missing services and failed owner checks produce unknown evidence, never an
// empty successful corpus. Lifecycle and filesystem publication stay outside.
export function createRawSessionNativeCapture({ctx, scope, readObserver, loadEvidence, verifySdkEvidence, now = Date.now, pid = process.pid, parentPid = process.ppid}) {
  const known = new Set(); let sequence = 0, loaded;
  ctx.on('agent/disposed', ({agent}) => known.add(agent.session.id));
  return {async capture() {
    const errors = [];
    const capture = async (source, operation) => { try { return await operation(); } catch (error) { errors.push(errorRecord(source, error)); return undefined; } };
    const observed = await capture('observer', async () => {
      const value = await readObserver(); assert.ok(Buffer.isBuffer(value.raw));
      assert.deepEqual(JSON.parse(value.raw), value.value); assert.equal(value.source.sha256, digest(value.raw));
      assert.equal(value.value.observerSha256, scope.nativeObserverSourceSha256); assert.ok(Array.isArray(value.value.requests)); return value;
    });
    if (!loaded && observed) loaded = await capture('actual-loader', () => loadEvidence({observer: observed.value, observerSource: observed.source}));
    const full = selectRawSessionEvidence(await capture('full-sdk-capture', () => collectRawSessionEvidence({agents: ctx.agents, sessions: ctx.get('sessions'), sessionQuery: ctx.get('sessionQuery'), sessionPersistence: ctx.get('sessionPersistence'), sdkVersion: scope.sdkVersion, now})));
    if (full.status !== 'complete') errors.push(...full.errors.map(row => ({...row, source: 'full-sdk:' + row.source})));
    const agents = await capture('agents', () => { const rows = ctx.agents.list(); assert.ok(Array.isArray(rows)); for (const row of rows) assert.ok(typeof row.session.id === 'string' && row.session.id); return rows; });
    for (const agent of agents ?? []) known.add(agent.session.id);
    const histories = [];
    for (const sessionId of known) {
      const live = full.sources?.agents?.before?.find(row => row.header.id === sessionId), query = full.sources?.query?.logs?.find(row => row.sessionId === sessionId);
      if (live) histories.push({sessionId, header: clone(live.header), events: clone(live.events), sourceKind: 'actual-agent-instance', status: (agents ?? []).find(agent => agent.session.id === sessionId)?.status ?? 'disposed'});
      else if (query) histories.push({sessionId, header: clone(query.log.session), events: clone(query.log.events), sourceKind: 'query-for-no-longer-listed-agent', status: 'disposed'});
      else errors.push({source: 'observed-history', sessionId, name: 'Error', message: 'Known Agent missing from read-only sources'});
    }
    const settings = await capture('settings', () => { const rows = ctx.get('settings').describe({redactSecrets: true}).filter(row => row.ns === 'subagent-model-selection-settings'); assert.equal(rows.length, 1); const row = clone(rows[0]); return {ns: row.ns, applies: row.applies, revision: row.revision, value: row.value, current: clone(ctx.get('subagentModelSelection').current())}; });
    const registry = await capture('registry', () => { const value = clone(ctx.flow.projector.registry()); assert.ok(Array.isArray(value.runs)); return value; });
    const workspaces = await capture('workspaces', () => { const value = clone(ctx.workspaceRegistry.list()); assert.ok(Array.isArray(value)); return value; });
    const liveAgents = await capture('live-agent-metadata', () => (agents ?? []).map(agent => ({sessionId: agent.session.id, firstLiveSeq: agent.session.firstLiveSeq, scopedTools: ctx.get('tools').get('list_subagent_models', agent) ? ['list_subagent_models'] : []})));
    const native = {schema: 'natural-raw-session-native/v1', ...scopeFields(scope), sequence: sequence++, capturedAt: now(), nativePid: pid, runnerPid: parentPid,
      observedSubset: {observerRequests: observed ? clone(observed.value.requests) : null, observerDataDigestSha256: observed ? digest(observed.raw) : null, histories, sessionIds: histories.map(row => row.sessionId), requestHeaderCount: histories.reduce((sum, row) => sum + row.events.filter(event => event.type === 'request/header').length, 0)},
      fullSdkEvidence: full, sdkLoad: loaded ?? null, flowRunIds: registry?.runs.map(row => row.id) ?? null, dashboardAddress: observed?.value.dashboardAddress ?? null,
      settings: settings ?? null, liveAgents: liveAgents ?? null, workspaces: workspaces ?? null, uiMainBinding: clone(observed?.value.uiMainBinding ?? null), businessBoundaryStatus: observed?.value.status ?? null};
    native.sdkSourceVerification = await capture('sdk-source-verification', () => verifySdkBinding(native, scope, verifySdkEvidence));
    native.captureErrors = errors; native.status = errors.length ? 'unknown' : 'complete'; native.actualQualification = false;
    return native;
  }};
}

export function assembleRawSessionSetup({native, scope, verifySdkEvidence}) {
  assert.equal(native.schema, 'natural-raw-session-native/v1'); sameScope(native, scope); assert.deepEqual(native.captureErrors, []); assert.equal(native.status, 'complete');
  const full = selectRawSessionEvidence(native.fullSdkEvidence); assert.equal(full.status, 'complete', 'Complete SDK source evidence unavailable');
  const proof = verifySdkBinding(native, scope, verifySdkEvidence); assert.deepEqual(native.sdkSourceVerification, proof, 'Capture SDK source binding changed');
  const subset = native.observedSubset; assert.ok(Array.isArray(subset.observerRequests) && Array.isArray(subset.histories));
  assert.equal(subset.requestHeaderCount, subset.histories.reduce((sum, row) => sum + row.events.filter(event => event.type === 'request/header').length, 0));
  assert.ok(Array.isArray(native.flowRunIds) && Array.isArray(native.workspaces) && Array.isArray(native.liveAgents));
  const histories = full.sources.query.logs.map(row => { const instance = full.sources.agents.before.find(item => item.header.id === row.sessionId) ?? full.sources.sessions.before.find(item => item.header.id === row.sessionId); return {sessionId: row.sessionId, header: instance?.header ?? row.log.session, events: instance?.events ?? row.log.events, status: subset.histories.find(history => history.sessionId === row.sessionId)?.status ?? 'not-agent'}; });
  return {schema: 'natural-raw-session-setup/v1', ...scopeFields(scope), capturedAt: native.capturedAt, nativePid: native.nativePid,
    sdkSourceVerification: proof, fullSdkEvidenceSha256: jsonDigest(native.fullSdkEvidence), fullSdkSummary: full.summary,
    setup: {requests: clone(subset.observerRequests), generationSourceObservations: Math.max(subset.observerRequests.length, subset.requestHeaderCount, full.summary.requestHeaderObservations), flowRunIds: clone(native.flowRunIds), histories: clone(histories), sessionIds: clone(full.summary.sessionIds)}, actualQualification: false};
}

export function assertRawSessionSetupZero({native, snapshot, scope, verifySdkEvidence}) {
  const rebuilt = assembleRawSessionSetup({native, scope, verifySdkEvidence}); assert.deepEqual(snapshot, rebuilt, 'SDK setup view changed from original source');
  const full = assertRawSessionZero(native.fullSdkEvidence); assert.equal(rebuilt.setup.requests.length, 0, 'Observer request exists'); assert.equal(rebuilt.setup.generationSourceObservations, 0); assert.deepEqual(rebuilt.setup.flowRunIds, [], 'Flow run exists');
  return {fullSdkEvidenceSha256: rebuilt.fullSdkEvidenceSha256, sessionIds: clone(full.summary.sessionIds), physicalAttemptCount: null, actualQualification: false};
}
