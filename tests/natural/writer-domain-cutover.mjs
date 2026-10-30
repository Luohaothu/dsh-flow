import assert from 'node:assert/strict';
import path from 'node:path';
import {createSourceReader, digest, stable} from './historical-owner-scope.mjs';
import {observeKnownHistoricalOwners} from './historical-known-owner.mjs';

const bindings = new WeakSet();
const inside = (root, file) => {const relative = path.posix.relative(root, file); return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative));};
const canonical = file => typeof file === 'string' && path.posix.isAbsolute(file) && path.posix.resolve(file) === file && !/[\0-\x1f\x7f]/.test(file);
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id);
const refSha = ref => ref.expectedSha256 ?? ref.sha256;
const freeze = x => {if (x && typeof x === 'object') {for (const value of Object.values(x)) freeze(value); Object.freeze(x);} return x;};
const rootRef = ref => {assert.deepEqual([ref.expectedUid, ref.expectedGid, ref.allowedModes], [0, 0, [0o444]], 'Active-domain sources require the Root control role'); return ref;};
function sameDomain(value, domain) {
  for (const key of ['domainId', 'generationId', 'namespaceId', 'containerId', 'imageId']) assert.equal(value[key], domain[key], 'Active domain ' + key + ' differs');
}

/** Pure producer: every value comes from the actual Root capture and layout binding. */
export function makeActiveDomainCurrent({domainId, generationId, writerId, currentDirectory}, {rootBinding, rootCapture, rootCaptureSource}) {
  assert.ok(safeId(domainId) && safeId(generationId) && safeId(writerId));
  assert.equal(rootCapture.schema, 'root-linux-execution-namespace/v1');
  for (const key of ['namespaceId', 'containerId', 'imageId']) assert.equal(rootCapture[key], rootBinding[key]);
  assert.deepEqual([rootCapture.uid, rootCapture.gid], [0, 0]);
  assert.ok(Number.isSafeInteger(rootCapture.rootPid) && rootCapture.rootPid > 0);
  assert.ok(canonical(currentDirectory) && inside(rootBinding.dataRoot, currentDirectory) && currentDirectory !== rootBinding.dataRoot);
  const domain = freeze({domainId, generationId, namespaceId: rootBinding.namespaceId, containerId: rootBinding.containerId, imageId: rootBinding.imageId});
  const current = {schema: 'root-active-domain-current/v1', ...domain, writerId, role: 'sole-upstream-authority-writer', rootPid: rootCapture.rootPid,
    rootCapture: rootCaptureSource, sourceManifestSha256: rootBinding.sourceManifestSha256, codeRoot: rootBinding.codeRoot, dataRoot: rootBinding.dataRoot};
  return Object.freeze({domain, currentFile: currentDirectory + '/root-writer.json', current: freeze(structuredClone(current)),
    indexFile: currentDirectory + '/index.json', makeIndex: currentReference => freeze({schema: 'root-active-domain-current-index/v1', ...domain,
      role: 'active-upstream-writers-only', currents: [{writerId, current: structuredClone(currentReference)}], legacyPointersAreArchivedSeparately: true})});
}

/** This is a new domain policy. It never changes an unknown historical physical status to PASS. */
export function validateWriterDomainCutover(plan, {readHistorical, readActive, rootBinding, validateStrict}) {
  assert.equal(plan.schema, 'root-writer-domain-cutover/v1');
  assert.ok(safeId(plan.domain.domainId) && safeId(plan.domain.generationId));
  const domain = plan.domain, active = createSourceReader(readActive), history = createSourceReader(readHistorical);
  for (const key of ['namespaceId', 'containerId', 'imageId']) assert.equal(domain[key], rootBinding[key], 'Domain differs from actual Root ' + key);
  const layout = active.load(rootRef(plan.authorityLayoutSource));
  assert.equal(layout.source.sha256, rootBinding.layoutSha256);
  assert.equal(layout.value.dataRoot, rootBinding.dataRoot); assert.equal(layout.value.codeRoot, rootBinding.codeRoot);
  assert.ok(canonical(domain.currentDirectory) && inside(rootBinding.dataRoot, domain.currentDirectory) && domain.currentDirectory !== rootBinding.dataRoot);
  assert.equal(domain.authorityDirectory, path.posix.join(rootBinding.dataRoot, '.artifacts/shared-request-authority-v3'));
  assert.notEqual(domain.currentDirectory, domain.authorityDirectory);
  for (const row of layout.value.sharedMappings) assert.ok(!inside(row.rootPath, domain.currentDirectory) && !inside(domain.currentDirectory, row.rootPath), 'Active current index is SUT-visible');
  const historical = observeKnownHistoricalOwners(plan.historical, {read: readHistorical});
  assert.ok(historical.host, 'A real complete current Host census is required');
  assert.equal(historical.status, 'known-anchors-absent', 'A recorded legacy owner is present or the current census is unknown');
  const snapshot = history.load(plan.historical.foundations.snapshot);
  assert.equal(snapshot.value.totalAttemptLimit, 15000); assert.deepEqual(snapshot.value.reserve, {attempts:16,reportedTokens:null});
  assert.equal(snapshot.value.totalReportedTokenLimit, null); assert.equal(snapshot.value.tokenBudgetStopEnabled, false);
  assert.equal(snapshot.value.perCaseRequestAndDurationBudgetsTerminateActiveWork, false);
  const ledger = history.load(plan.historical.foundations.baseline), g = snapshot.value, totals = ledger.value.totals;
  assert.ok(totals && Array.isArray(totals.stillUnknownNetworkUsage), 'Original baseline accounting is required');
  assert.equal(g.baseline.conservativeAttempts, totals.conservativeRequestAttempts);
  assert.equal(g.baseline.knownReportedTokens, totals.knownReportedTotalTokens);
  assert.equal(g.baseline.monitoredAttempts, totals.monitoredRequestAttempts);
  assert.equal(g.baseline.unknownUsageNetworkRequests, totals.stillUnknownNetworkUsage.length);
  assert.equal(g.usedAttempts, g.baseline.conservativeAttempts + g.cases.reduce((n, row) => n + row.conservativeAttempts, 0), 'Historical attempt epoch was reset or changed');
  assert.equal(g.usedTokens, g.baseline.knownReportedTokens + g.cases.reduce((n, row) => n + row.reportedTokens, 0), 'Historical token total was changed');
  assert.equal(g.unknownUsageRequests, g.cases.reduce((n, row) => n + row.unknownUsageRequests, 0), 'Historical unknown usage was changed');
  // v19's top-level late-local field covers the post-baseline rows; baseline conservative attempts already carry their own original treatment.
  assert.equal(g.lateLocalBoundaryRejects, g.cases.reduce((n, row) => n + row.lateLocalBoundaryRejects, 0));
  assert.equal(g.remainingAttempts, g.totalAttemptLimit - g.usedAttempts - g.reserve.attempts, 'Global allowance/reserve was reset');
  const referenceIndex = active.load(rootRef(plan.legacyReferenceIndex));
  assert.equal(referenceIndex.source.sha256, rootBinding.referenceIndexSha256);
  assert.ok(Array.isArray(referenceIndex.value.files));
  const epoch = active.load(rootRef(plan.legacyEpochSnapshot));
  assert.equal(epoch.value.schema, 'root-global-usage-snapshot/v3');
  assert.deepEqual(epoch.value.referenceIndex, plan.legacyReferenceIndex, 'Epoch and archival reference index differ');
  assert.equal(epoch.value.originalSnapshotSha256, snapshot.source.sha256, 'Historical source differs from the actual original epoch');
  assert.equal(refSha(epoch.value.originalSnapshot), snapshot.source.sha256);
  assert.equal(active.raw(rootRef(epoch.value.originalSnapshot)).source.sha256, snapshot.source.sha256, 'Preserved original snapshot bytes differ');
  assert.equal(epoch.value.usage.usedAttempts, snapshot.value.usedAttempts); assert.equal(epoch.value.usage.usedTokens, snapshot.value.usedTokens);
  const baselineFile = plan.historical.foundations.baseline.file ?? plan.historical.foundations.baseline.path;
  const baselineRow = referenceIndex.value.files.find(x => x.originalPath === baselineFile);
  assert.ok(baselineRow && baselineRow.sha256 === ledger.source.sha256, 'Baseline source is not the bound historical raw baseline');
  assert.equal(active.raw(rootRef(baselineRow.reference)).source.sha256, ledger.source.sha256, 'Preserved baseline bytes differ');
  const archived = historical.currentPointerBindings.map(binding => {
    const row = referenceIndex.value.files.find(x => x.originalPath === binding.source.file);
    assert.ok(row && row.sha256 === binding.source.sha256 && row.bytes === binding.source.bytes, 'An original current pointer was omitted or rewritten in the archive');
    assert.ok(!inside(domain.currentDirectory, row.reference.file) && !inside(row.reference.file, domain.currentDirectory), 'Archival current and active current paths overlap');
    const actual = active.raw(rootRef(row.reference));
    assert.equal(actual.source.sha256, binding.source.sha256, 'Preserved archival current bytes differ');
    return {...binding, role: 'archival-reference', reference: row.reference};
  });
  const activeIndex = active.load(rootRef(plan.activeCurrentIndex));
  assert.equal(activeIndex.value.schema, 'root-active-domain-current-index/v1'); sameDomain(activeIndex.value, domain);
  assert.equal(activeIndex.value.role, 'active-upstream-writers-only');
  assert.equal(activeIndex.source.file, domain.currentDirectory + '/index.json');
  assert.equal(activeIndex.value.currents.length, 1, 'There must be one actual Root upstream writer');
  const current = active.load(rootRef(activeIndex.value.currents[0].current));
  assert.equal(current.value.schema, 'root-active-domain-current/v1'); sameDomain(current.value, domain);
  assert.equal(current.source.file, domain.currentDirectory + '/root-writer.json');
  assert.equal(current.value.role, 'sole-upstream-authority-writer');
  assert.equal(current.value.writerId, activeIndex.value.currents[0].writerId);
  assert.equal(current.value.sourceManifestSha256, rootBinding.sourceManifestSha256);
  assert.equal(current.value.codeRoot, rootBinding.codeRoot); assert.equal(current.value.dataRoot, rootBinding.dataRoot);
  const capture = active.load(rootRef(current.value.rootCapture));
  assert.equal(capture.source.sha256, rootBinding.rootCaptureSha256);
  assert.equal(capture.value.schema, 'root-linux-execution-namespace/v1');
  for (const key of ['namespaceId', 'containerId', 'imageId']) assert.equal(capture.value[key], domain[key]);
  assert.deepEqual([capture.value.uid, capture.value.gid, capture.value.rootPid], [0, 0, current.value.rootPid], 'Root writer PID/UID differs from actual current capture');
  const inventory = active.load(rootRef(plan.activePriorWriterInventory));
  assert.equal(inventory.value.schema, 'root-model-request-writer-inventory/v3'); sameDomain(inventory.value, domain);
  const discovery = active.load(rootRef(inventory.value.discoverySource)); sameDomain(discovery.value, domain);
  assert.deepEqual(inventory.value.currentPointers, [], 'Archived pointers cannot be hidden in active prior-writer inventory');
  assert.ok(!inventory.value.owners.some(x => x.ownerId === current.value.writerId), 'The newly allowed Root writer cannot be declared already closed');
  const strict = validateStrict(plan.activePriorWriterInventory);
  assert.equal(strict.inventorySha256, inventory.source.sha256); assert.equal(strict.requestWriterAdmissionSafe, true);
  const identity = {schema: 'root-model-writer-domain-policy/v1', domain: structuredClone(domain),
    rootLayoutSha256: rootBinding.layoutSha256, rootCaptureSha256: capture.source.sha256, sourceManifestSha256: rootBinding.sourceManifestSha256,
    referenceIndexSha256: referenceIndex.source.sha256, epochSnapshotSha256: epoch.source.sha256, originalUsageSnapshotSha256: snapshot.source.sha256,
    archivedPointerSourceSha256: archived.map(x => x.source.sha256), currentHostCensusSha256: historical.host.source.sha256,
    activeCurrentIndexSha256: activeIndex.source.sha256, activePriorWriterInventorySha256: inventory.source.sha256,
    baselineUsedAttempts: snapshot.value.usedAttempts, totalAttemptLimit: snapshot.value.totalAttemptLimit, reserve: snapshot.value.reserve.attempts,
    reportedTokenLimit: null, perCaseTerminationBudget: null};
  const result = freeze({schema: 'root-writer-domain-cutover-binding/v1', domain: structuredClone(domain), policyIdentity: identity,
    policySha256: digest(Buffer.from(stable(identity))), archivedCurrents: archived, activeCurrent: current.value,
    baselineSnapshotSha256: snapshot.source.sha256, baselineUsage: structuredClone(snapshot.value),
    knownLegacyOwnerObservation: 'all-source-bound-known-current-PIDs-absent', legacyPhysicalCompleteness: 'unknown', legacyLoadedModelPaths: 'unknown', unobservedLegacyToolWriters: 'unknown',
    legacyStrictF6: 'unknown', legacyObservation: historical, strictActivePriorInventory: strict,
    rolePolicyValidated: true, actualSdkQualified: false, businessCredit: false, strictF6: 'unknown'});
  bindings.add(result); return result;
}
export function requireWriterDomainCutover(binding) {assert.ok(bindings.has(binding), 'Verified same-module domain cutover required'); return binding;}
