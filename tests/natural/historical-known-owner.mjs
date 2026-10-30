import assert from 'node:assert/strict';
import path from 'node:path';
import {appendObservedOwner, createSourceReader, deriveHistoricalOrigins} from './historical-owner-scope.mjs';
import {readCurrentCensus} from './historical-census.mjs';

/** Bounded original PID/direct-PPID observation. Observed groups do not prove exclusive ownership;
 * never infer PGID from PID or turn this into a reconstructed historical descendant inventory. */
export function observeKnownHistoricalOwners({foundations, currentPointers, census, expectedCensus}, {read}) {
  const scope = deriveHistoricalOrigins(foundations, {read}), io = createSourceReader(read), matrix = io.load(foundations.matrix);
  for (const origin of scope.origins) {
    const indexed = matrix.value.resourceCases.find(x => x.caseKey === origin.originKey);
    for (const identity of [...(indexed?.osIdentities ?? []), ...(indexed?.observedIdentities ?? [])]) appendObservedOwner(origin, identity, matrix.source, 'explicit-source-observed');
  }
  const batches = [...new Set(scope.origins.map(x => x.originKey.split('/')[0]).filter(x => /^natural-b\d+$/.test(x)))].sort();
  assert.deepEqual(currentPointers.map(x => x.batch).sort(), batches, 'All original current pointers are required');
  assert.equal(new Set(currentPointers.map(x => x.batch)).size, batches.length);
  const currentPointerBindings = [];
  for (const pointer of currentPointers) {
    const loaded = io.load(pointer.reference), c = loaded.value, origin = scope.origins.find(x => x.originKey === pointer.batch + '/' + c.scenario);
    assert.ok(origin, 'Current pointer names a foreign origin');
    assert.equal(path.basename(loaded.source.file), 'current.json'); assert.equal(path.basename(path.dirname(loaded.source.file)), pointer.batch);
    assert.equal(c.proof, path.dirname(origin.originalProcessSource.file), 'Current proof differs from its original native source');
    assert.ok(Number.isSafeInteger(c.pid) && c.pid > 0);
    appendObservedOwner(origin, {pid: c.pid}, loaded.source, 'current-runner');
    currentPointerBindings.push({batch: pointer.batch, originKey: origin.originKey, source: loaded.source, runnerPid: c.pid,
      nativeSourceSha256: origin.originalProcessSource.sha256, nativePid: origin.originalProcess.pid});
  }
  assert.ok(census, 'Actual current Host metadata is required');
  const current = readCurrentCensus(census, scope, expectedCensus, io), observations = [];
  for (const origin of scope.origins) {
    const pids = [...new Set(origin.ownerStages.map(x => x.nativePid))];
    const matches = current.rows.filter(row => pids.includes(row.pid) || pids.includes(row.ppid));
    observations.push({originKey: origin.originKey, sourceBoundOwnerStages: origin.ownerStages, currentMatches: matches});
  }
  return {schema: 'root-known-historical-owner-observation/v1', status: observations.some(x => x.currentMatches.length) ? 'present-or-unknown-identity' : 'known-anchors-absent',
    scopeSha256: scope.scopeSha256, host: {hostScopeId: current.hostScopeId, bootSession: current.bootSession, source: current.source},
    currentPointerBindings, observations, sourceRecords: [...scope.sourceRecords, ...io.sources.values()],
    legacyPhysicalCompleteness: 'unknown', legacyLoadedModelPaths: 'unknown', unobservedLegacyWriters: 'unknown', strictF6: 'unknown', businessCredit: false};
}
