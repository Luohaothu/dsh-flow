import test from 'node:test';
import assert from 'node:assert/strict';
import {domainFixture} from './domain-fixtures.mjs';
import {makeActiveDomainCurrent, validateWriterDomainCutover, requireWriterDomainCutover} from './writer-domain-cutover.mjs';

test('new explicit domain retains unknown baseline physical closure and archival bytes while validating a separate strict active inventory', () => {
  const f = domainFixture(), value = validateWriterDomainCutover(f.plan, f.ports);
  assert.equal(f.strictCalls, 1); assert.equal(value.rolePolicyValidated, true); assert.equal(value.actualSdkQualified, false);
  assert.equal(value.legacyObservation.legacyPhysicalCompleteness, 'unknown'); assert.equal(value.legacyPhysicalCompleteness, 'unknown'); assert.equal(value.unobservedLegacyToolWriters, 'unknown');
  assert.equal(value.legacyStrictF6, 'unknown'); assert.equal(value.businessCredit, false);
  assert.equal(value.archivedCurrents.length, 1); assert.equal(value.archivedCurrents[0].source.sha256, f.pointer.sha256);
  assert.equal(value.baselineUsage.usedAttempts, 17); assert.equal(value.baselineUsage.unknownUsageRequests + value.baselineUsage.baseline.unknownUsageNetworkRequests, 3);
  assert.equal(value.policyIdentity.totalAttemptLimit, 15000); assert.equal(value.policyIdentity.reserve, 16);
  assert.equal(requireWriterDomainCutover(value), value); assert.throws(() => requireWriterDomainCutover(structuredClone(value)), /same-module/);
});
for (const key of ['namespaceId', 'generationId', 'containerId', 'imageId']) test('active index cannot borrow a foreign ' + key, () => {
  const f = domainFixture(), value = JSON.parse(f.read(f.currentIndex)); value[key] = 'foreign';
  f.plan.activeCurrentIndex = f.putRoot(f.currentIndex.file, value);
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports), /Active domain/); assert.equal(f.strictCalls, 0);
});
test('deleting an old current from the role index cannot silently turn it into an empty active inventory', () => {
  const f = domainFixture(), index = {...f.index, files: []};
  f.plan.legacyReferenceIndex = f.putRoot(f.indexRef.file, index); f.binding.referenceIndexSha256 = f.plan.legacyReferenceIndex.expectedSha256;
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports), /Epoch and archival reference index differ|omitted or rewritten/);
});
test('changed archival raw bytes are rejected even under a new Root reference', () => {
  const f = domainFixture(); f.index.files[0].reference = f.putRawRoot(f.index.files[0].reference.file, '{}\n');
  f.plan.legacyReferenceIndex = f.putRoot(f.indexRef.file, f.index); f.binding.referenceIndexSha256 = f.plan.legacyReferenceIndex.expectedSha256;
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports), /Epoch and archival reference index differ|archival current bytes differ/);
});
test('the Root writer PID must be from the same actual capture, rather than a holder or another Node process', () => {
  const f = domainFixture(), current = {...f.prepared.current, rootPid: 999};
  const ref = f.putRoot(f.currentRef.file, current); f.plan.activeCurrentIndex = f.putRoot(f.currentIndex.file, f.prepared.makeIndex(ref));
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports), /Root writer PID\/UID differs/);
});
test('strict prior writer inventory must carry the same new namespace/generation; historical references never stand in for it', () => {
  const f = domainFixture(); f.priorValue.generationId = 'legacy'; f.plan.activePriorWriterInventory = f.putRoot(f.prior.file, f.priorValue);
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports), /generationId differs/); assert.equal(f.strictCalls, 0);
});
test('active current records stay out of candidate-visible shared paths', () => {
  const f = domainFixture(); f.plan.domain.currentDirectory = '/shared/case/current';
  assert.throws(() => validateWriterDomainCutover(f.plan, f.ports)); assert.equal(f.strictCalls, 0);
});
test('the constructor freezes the first capture/reference so later caller mutation cannot change publication bytes', () => {
  const f = domainFixture(), prepared = makeActiveDomainCurrent({domainId:'isolated',generationId:'g',writerId:'root-writer',currentDirectory:f.plan.domain.currentDirectory}, {rootBinding:f.binding,rootCapture:f.capture,rootCaptureSource:f.captureRef});
  const before = prepared.current.rootCapture.expectedSha256; f.captureRef.expectedSha256 = 'e'.repeat(64);
  assert.equal(prepared.current.rootCapture.expectedSha256, before); assert.ok(Object.isFrozen(prepared.current));
});


test('new domain cannot reset the legacy attempt epoch while preserving its underlying rows', () => {
  const f = domainFixture(), snapshot=JSON.parse(f.read(f.foundations.snapshot)); snapshot.usedAttempts=0;
  f.foundations.snapshot=f.put(f.foundations.snapshot.file,snapshot); f.censusValue.sourceRefs[0]=f.foundations.snapshot; f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  assert.throws(() => validateWriterDomainCutover(f.plan,f.ports), /Historical attempt epoch was reset/); assert.equal(f.strictCalls,0);
});

test('one logical origin includes every explicit native phase receipt instead of assuming one case equals one PID', () => {
  const f=domainFixture(), matrix=JSON.parse(f.read(f.foundations.matrix)), extra=f.put('/history/.artifacts/natural-b2/private/scenario/process-stage-2.json',{pid:62,startedAt:3,endedAt:4,exit:{code:0,signal:null}});
  matrix.resourceCases[0].additionalProcessReceipts=[extra]; f.foundations.matrix=f.put(f.foundations.matrix.file,matrix);
  f.censusValue.matrix=f.foundations.matrix; f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  const value=validateWriterDomainCutover(f.plan,f.ports), origin=value.legacyObservation.observations.find(x=>x.originKey==='natural-b2/scenario');
  assert.deepEqual(origin.sourceBoundOwnerStages.filter(x=>x.role.startsWith('native')).map(x=>[x.nativePid,x.exit.code]),[[41,130],[62,0]]);
});

test('a source capsule cannot substitute an alternative coherent baseline for the bound archive baseline', () => {
  const f=domainFixture(); f.index.files.find(x=>x.originalPath===f.foundations.baseline.file).sha256='f'.repeat(64);
  f.plan.legacyReferenceIndex=f.putRoot(f.indexRef.file,f.index); f.binding.referenceIndexSha256=f.plan.legacyReferenceIndex.expectedSha256;
  const epoch=JSON.parse(f.read(f.plan.legacyEpochSnapshot)); epoch.referenceIndex=f.plan.legacyReferenceIndex; f.plan.legacyEpochSnapshot=f.putRoot(f.plan.legacyEpochSnapshot.file,epoch);
  assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports),/Baseline source is not the bound/); assert.equal(f.strictCalls,0);
});

test('a known original native PID still present blocks cutover before StrictV3', () => {
  const f=domainFixture();
  f.censusValue.commands[3].stdout=f.putRaw('/history/processes.stdout','41 1 41 501 Sat Oct 31 00:00:00 2026\n');
  f.censusValue.processes=[{pid:41,ppid:1,pgid:41,uid:501,osBirth:{normalized:'Sat Oct 31 00:00:00 2026'}}];
  f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports),/recorded legacy owner is present/); assert.equal(f.strictCalls,0);
});

test('a command error cannot be hidden by a complete-metadata flag', () => {
  const f=domainFixture(); f.censusValue.commands[3].code=1; f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports)); assert.equal(f.strictCalls,0);
});

test('BSD signed system UID rows remain in the complete raw census', () => {
  const f=domainFixture();
  f.censusValue.commands[3].stdout=f.putRaw('/history/processes.stdout','1 0 1 0 Sat Oct 31 00:00:00 2026\n7 1 7 -2 Sat Oct 31 00:00:00 2026\n');
  f.censusValue.processes.push({pid:7,ppid:1,pgid:7,uid:-2,osBirth:{normalized:'Sat Oct 31 00:00:00 2026'}});
  f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  assert.equal(validateWriterDomainCutover(f.plan,f.ports).rolePolicyValidated,true);
});

test('a StrictV3 failure remains a cutover failure instead of being replaced by the new role policy', () => {
  const f=domainFixture(); f.ports.validateStrict=()=>{throw Error('Strict original rejected source');};
  assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports),/Strict original rejected/);
});


test('a missing or empty host scope cannot bind a census by vacuous equality', () => {
  for (const hostScopeId of [undefined, null, '', '   ', 42]) {
    const f=domainFixture(), review=JSON.parse(f.read(f.censusValue.sourceReviewedRef));
    review.hostScopeId=hostScopeId; f.censusValue.hostScopeId=hostScopeId; f.plan.historical.expectedCensus.hostScopeId=hostScopeId;
    const ref=f.put(f.censusValue.sourceReviewedRef.file,review); f.censusValue.sourceReviewedRef=ref; f.plan.historical.expectedCensus.sourceReviewSha256=ref.sha256;
    f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
    assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports),/host scope is required/); assert.equal(f.strictCalls,0);
  }
});
for(const kind of ['snapshot','baseline'])test('missing or changed archived '+kind+' bytes cannot pass on an index digest alone',()=>{
  for(const change of ['missing','changed']){
    const f=domainFixture(), ref=kind==='snapshot'?JSON.parse(f.read(f.plan.legacyEpochSnapshot)).originalSnapshot:f.index.files.find(row=>row.originalPath===f.foundations.baseline.file).reference;
    if(change==='missing')f.files.delete(ref.file);else f.files.set(ref.file,Buffer.from('changed original bytes\n'));
    assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports));assert.equal(f.strictCalls,0);
  }
});
test('a recorded shared group remains an observation with unknown ownership, not a complete retirement proof',()=>{
  const f=domainFixture(), matrix=JSON.parse(f.read(f.foundations.matrix));matrix.resourceCases[0].observedIdentities=[{pid:41,pgid:999}];
  f.foundations.matrix=f.put(f.foundations.matrix.file,matrix);f.censusValue.matrix=f.foundations.matrix;
  f.censusValue.commands[3].stdout=f.putRaw('/history/processes.stdout','7 1 999 501 Sat Oct 31 00:00:00 2026\n');
  f.censusValue.processes=[{pid:7,ppid:1,pgid:999,uid:501,osBirth:{normalized:'Sat Oct 31 00:00:00 2026'}}];f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
  const value=validateWriterDomainCutover(f.plan,f.ports), origin=value.legacyObservation.observations.find(row=>row.originKey==='natural-b2/scenario');
  assert.ok(origin.sourceBoundOwnerStages.some(row=>row.actualObservedPgids?.includes(999)));assert.deepEqual(origin.currentMatches,[]);
  assert.equal(value.rolePolicyValidated,true);assert.equal(value.legacyPhysicalCompleteness,'unknown');assert.equal(value.unobservedLegacyToolWriters,'unknown');assert.equal(value.legacyStrictF6,'unknown');
});
test('a native PID is not an inferred owned PGID, while an actual recorded parent match still blocks',()=>{
  for(const ppid of [1,41]){
    const f=domainFixture();f.censusValue.commands[3].stdout=f.putRaw('/history/processes.stdout',`7 ${ppid} 41 501 Sat Oct 31 00:00:00 2026\n`);
    f.censusValue.processes=[{pid:7,ppid,pgid:41,uid:501,osBirth:{normalized:'Sat Oct 31 00:00:00 2026'}}];f.plan.historical.census=f.put(f.plan.historical.census.file,f.censusValue);
    if(ppid===41)assert.throws(()=>validateWriterDomainCutover(f.plan,f.ports),/recorded legacy owner is present/);
    else assert.equal(validateWriterDomainCutover(f.plan,f.ports).legacyPhysicalCompleteness,'unknown');
  }
});
