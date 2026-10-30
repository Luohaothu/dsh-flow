import {fixture} from './writer-domain-origin-fixtures.mjs';
import {makeActiveDomainCurrent} from './writer-domain-cutover.mjs';
export function domainFixture() {
  const f = fixture({baseline: true}), rootRef = ref => ({file: ref.file, trustedRoot: '/root-private', expectedUid: 0, expectedGid: 0, allowedModes: [0o444], expectedSha256: ref.sha256, forbiddenRoots: [], forbiddenFiles: []});
  const put = (file, value) => rootRef(f.put(file, value)), putRaw = (file, raw) => rootRef(f.putRaw(file, raw));
  const snapshot = JSON.parse(f.read(f.foundations.snapshot));
  Object.assign(snapshot, {usedAttempts: 17, usedTokens: 123, unknownUsageRequests: 1, baseline: {unknownUsageNetworkRequests: 2}, totalAttemptLimit: 15000, reserve: {attempts:16,reportedTokens:null}, totalReportedTokenLimit: null, tokenBudgetStopEnabled: false, perCaseRequestAndDurationBudgetsTerminateActiveWork: false});
  snapshot.baseline = {conservativeAttempts:5,knownReportedTokens:3,monitoredAttempts:5,unknownUsageNetworkRequests:2};
  Object.assign(snapshot.cases[0], {conservativeAttempts:12,reportedTokens:120,unknownUsageRequests:1,lateLocalBoundaryRejects:0});
  snapshot.lateLocalBoundaryRejects=0; snapshot.remainingAttempts=15000-17-16;
  const ledger=JSON.parse(f.read(f.foundations.baseline)); ledger.totals={conservativeRequestAttempts:5,knownReportedTotalTokens:3,monitoredRequestAttempts:5,stillUnknownNetworkUsage:[{},{}],lateLocalBoundaryRejects:0};
  f.foundations.baseline=f.put(f.foundations.baseline.file,ledger); f.censusValue.sourceRefs[1]=f.foundations.baseline;
  const changed = f.put(f.foundations.snapshot.file, snapshot); f.foundations.snapshot = changed;
  f.censusValue.sourceRefs[0] = changed; f.inputs.census = f.put(f.inputs.census.file, f.censusValue);
  const binding = {schema: 'natural-root-authority-layout-binding/v1', namespaceId: 'fresh-root', containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), codeRoot: '/code', dataRoot: '/root-private/data', sourceManifestSha256: 'd'.repeat(64)};
  const layout = {dataRoot: binding.dataRoot, codeRoot: binding.codeRoot, sharedMappings: [{rootPath: '/shared/case'}]};
  const layoutRef = put('/root-private/layout.json', layout); binding.layoutSha256 = layoutRef.expectedSha256;
  const capture = {schema: 'root-linux-execution-namespace/v1', namespaceId: binding.namespaceId, containerId: binding.containerId, imageId: binding.imageId, uid: 0, gid: 0, rootPid: 200};
  const captureRef = put('/root-private/capture.json', capture); binding.rootCaptureSha256 = captureRef.expectedSha256;
  const archive = putRaw(binding.dataRoot + '/.artifacts/natural-b2/current.json', f.read(f.pointer));
  const index = {files: [{originalPath: f.pointer.file, sha256: f.pointer.sha256, bytes: f.pointer.bytes, reference: archive}]};
  index.files.push({originalPath:f.foundations.baseline.file,sha256:f.foundations.baseline.sha256,bytes:f.foundations.baseline.bytes,reference:putRaw(binding.dataRoot+'/.artifacts/baseline-ledger.json',f.read(f.foundations.baseline))});
  const indexRef = put('/root-private/history-index.json', index); binding.referenceIndexSha256 = indexRef.expectedSha256;
  const originalSnapshot=putRaw('/root-private/original-snapshot.json',f.read(f.foundations.snapshot));
  const epoch=put('/root-private/epoch.json',{schema:'root-global-usage-snapshot/v3',referenceIndex:indexRef,originalSnapshot,originalSnapshotSha256:f.foundations.snapshot.sha256,usage:{usedAttempts:snapshot.usedAttempts,usedTokens:snapshot.usedTokens}});
  const domainInput = {domainId: 'new-domain', generationId: 'new-generation', writerId: 'root-authority', currentDirectory: binding.dataRoot + '/.artifacts/active-domains/new-domain/current'};
  const prepared = makeActiveDomainCurrent(domainInput, {rootBinding: binding, rootCapture: capture, rootCaptureSource: captureRef});
  const currentRef = put(prepared.currentFile, prepared.current), currentIndex = put(prepared.indexFile, prepared.makeIndex(currentRef));
  const scope = prepared.domain, discovery = put('/root-private/prior-discovery.json', {schema: 'root-observed-model-writer-set/v1', ...scope, ownerIds: []});
  const priorValue = {schema: 'root-model-request-writer-inventory/v3', ...scope, discoverySource: discovery, owners: [], currentPointers: []};
  const prior = put('/root-private/prior-inventory.json', priorValue);
  const plan = {schema: 'root-writer-domain-cutover/v1', domain: {...prepared.domain, currentDirectory: domainInput.currentDirectory, authorityDirectory: binding.dataRoot + '/.artifacts/shared-request-authority-v3'}, historical: f.inputs,
    authorityLayoutSource: layoutRef, legacyEpochSnapshot:epoch, legacyReferenceIndex: indexRef, activeCurrentIndex: currentIndex, activePriorWriterInventory: prior};
  let strictCalls = 0;
  const ports = {readHistorical: f.read, readActive: f.read, rootBinding: binding, validateStrict: reference => {strictCalls++; if(reference.expectedSha256!==prior.expectedSha256) throw Error('wrong strict input'); return {inventorySha256: prior.expectedSha256, requestWriterAdmissionSafe: true, sourceSha256: []};}};
  return {...f, rootRef, putRoot: put, putRawRoot: putRaw, plan, ports, binding, layout, layoutRef, capture, captureRef, currentRef, currentIndex, prepared, priorValue, prior, index, indexRef, get strictCalls() {return strictCalls;}};
}
