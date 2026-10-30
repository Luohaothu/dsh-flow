import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const digest = raw => createHash('sha256').update(raw).digest('hex');
export const stable = value => JSON.stringify(value, (_, x) => x && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const exactSet = (actual, expected, label) => {
  assert.equal(new Set(actual).size, actual.length, label + ' has duplicates');
  assert.deepEqual([...actual].sort(), [...expected].sort(), label + ' differs');
};
const positive = x => Number.isSafeInteger(x) && x > 0;
export function nativeExit(record) {
  const exit = record.exit ?? {code: record.code, signal: record.signal};
  assert.ok(Number.isInteger(exit.code) || typeof exit.signal === 'string', 'Native child exit source is unknown');
  return structuredClone(exit);
}
export function createSourceReader(read) {
  assert.equal(typeof read, 'function');
  const sources = new Map();
  function raw(reference) {
    assert.ok(reference && typeof reference === 'object');
    const file = reference.file ?? reference.path, expected = reference.expectedSha256 ?? reference.sha256;
    assert.ok(typeof file === 'string' && file.length && /^[a-f\d]{64}$/.test(expected ?? ''), 'Pinned source identity is required');
    const raw = read(reference);
    assert.ok(Buffer.isBuffer(raw), 'Source reader must return original bytes');
    const sha256 = digest(raw);
    assert.equal(sha256, expected, 'Original source bytes differ: ' + file);
    if (reference.bytes !== undefined) assert.equal(raw.length, reference.bytes, 'Original source size differs');
    const old = sources.get(file);
    assert.ok(!old || old.sha256 === sha256, 'Conflicting source pins for ' + file);
    const source = {file, sha256, bytes: raw.length};
    sources.set(file, source);
    return {raw, source};
  }
  function load(reference) { const loaded = raw(reference); return {...loaded, value: JSON.parse(loaded.raw.toString('utf8'))}; }
  return {load, raw, sources};
}

/** Rebuild the logical origin set from original accounting and file census, not an owner-name list. */
export function deriveHistoricalOrigins({snapshot, baseline, matrix, processDirectoryCensus}, {read}) {
  const io = createSourceReader(read), global = io.load(snapshot), ledger = io.load(baseline), index = io.load(matrix), census = io.load(processDirectoryCensus);
  assert.ok(Array.isArray(global.value.cases) && Array.isArray(ledger.value.rows));
  assert.ok(Array.isArray(ledger.value.zeroObservedLaunchFailures));
  assert.equal(census.value.schema, 'file-only-private-process-census/v1');
  assert.equal(census.value.OSProcessesObserved, false);
  const indexedCases = index.value.resourceCases, indexedBaseline = index.value.baselineLedger;
  exactSet(indexedCases.map(x => x.caseKey), global.value.cases.map(x => x.batch + '/' + x.id), 'Historical case scope');
  exactSet(indexedBaseline.rows.map(x => x.id), ledger.value.rows.map(x => x.id), 'Baseline scope');
  exactSet(indexedBaseline.zeroAttemptLaunchOwners.map(x => x.id), ledger.value.zeroObservedLaunchFailures.map(x => x.id), 'Zero-request launch scope');
  const origins = [];
  const add = ({originKey, id, stage, reference, expectedPath, expectedSha, closureFamily, closureSources = [], additionalProcessReceipts = []}) => {
    assert.ok(reference && (reference.file ?? reference.path).endsWith('/' + expectedPath), 'Process source is outside its original origin');
    if (expectedSha) assert.equal(reference.sha256 ?? reference.expectedSha256, expectedSha, 'Process pin differs from original ledger');
    const child = io.load(reference), p = child.value;
    assert.ok(positive(p.pid), 'A zero-request origin still needs actual process identity');
    const exit = nativeExit(p);
    const key = digest(Buffer.from(stable({originKey, source: child.source, pid: p.pid, startedAt: p.startedAt ?? null})));
    const origin = {originKey, id, stage, closureFamily, closureSources,
      ownerStages: [{stageKey: key, role: 'native-child', nativePid: p.pid, launchStartedAt: p.startedAt ?? null, exit, source: child.source}],
      originalProcess: p, originalProcessSource: child.source};
    assert.ok(Array.isArray(additionalProcessReceipts));
    for (const extraRef of additionalProcessReceipts) {
      const extra = io.load(extraRef), value = extra.value;
      assert.equal(path.dirname(extra.source.file), path.dirname(child.source.file), 'Extra native stage belongs to another origin');
      assert.ok(positive(value.pid));
      assert.ok(!origin.ownerStages.some(x => x.source.sha256 === extra.source.sha256), 'Duplicate native stage');
      origin.ownerStages.push({stageKey:digest(Buffer.from(stable({originKey,source:extra.source,pid:value.pid,startedAt:value.startedAt??null}))),role:'native-stage',nativePid:value.pid,launchStartedAt:value.startedAt??null,exit:nativeExit(value),source:extra.source});
    }
    origins.push(origin);
  };
  for (const row of ledger.value.rows) {
    const indexed = indexedBaseline.rows.find(x => x.id === row.id), rel = row.evidence?.processPath;
    assert.ok(typeof rel === 'string');
    const stage = Number(rel.match(/natural-b(\d+)\//)?.[1]);
    add({originKey: 'baseline/' + row.id, id: row.id, stage, reference: indexed.childReceipt, expectedPath: rel, expectedSha: row.evidence.processSha256, closureFamily: 'baseline-child-exit-only', additionalProcessReceipts:indexed.additionalProcessReceipts??[]});
  }
  for (const row of ledger.value.zeroObservedLaunchFailures) {
    const indexed = indexedBaseline.zeroAttemptLaunchOwners.find(x => x.id === row.id), stage = Number(row.processPath.match(/natural-b(\d+)\//)?.[1]);
    add({originKey: 'baseline-zero/' + row.id, id: row.id, stage, reference: indexed.process, expectedPath: row.processPath, closureFamily: 'baseline-zero-request-child-exit-only', additionalProcessReceipts:indexed.additionalProcessReceipts??[]});
  }
  for (const row of global.value.cases) {
    const key = row.batch + '/' + row.id, indexed = indexedCases.find(x => x.caseKey === key);
    add({originKey: key, id: row.id, stage: Number(row.batch.match(/^natural-b(\d+)$/)?.[1]), reference: indexed.childReceipt,
      expectedPath: '.artifacts/' + row.batch + '/private/' + row.id + '/process.json', closureFamily: indexed.closureFamily, closureSources: indexed.closureRefs, additionalProcessReceipts:indexed.additionalProcessReceipts??[]});
  }
  exactSet(origins.map(x => x.stage + '/' + x.id), census.value.entries.map(x => x.stage + '/' + x.origin), 'Original private process directory census');
  assert.ok(census.value.entries.every(x => x.processExists === true), 'Unproven not-spawned origin cannot be excluded');
  const scopeSourceDigests = [global.source.sha256, ledger.source.sha256, index.source.sha256, census.source.sha256];
  return {schema: 'root-historical-origin-scope/v1', origins, scopeSourceDigests, sourceRecords: [...io.sources.values()],
    scopeSha256: digest(Buffer.from(stable({scopeSourceDigests, origins: origins.map(x => ({originKey: x.originKey, ownerStages: x.ownerStages}))}))),
    loadedModelPaths: 'unknown', strictF6: 'unknown', authorityEligible: false};
}

/** Join an observed extra owner/stage by original identity and source, not by a caller ownerKey. */
export function appendObservedOwner(origin, identity, source, role = 'observed-owned') {
  assert.ok(positive(identity.pid));
  assert.ok(source && /^[a-f\d]{64}$/.test(source.sha256));
  const birth = identity.normalizedOsStart ?? identity.startToken?.trim() ?? null;
  const groupCandidates = Array.isArray(identity.pgids) ? identity.pgids : positive(identity.pgid) ? [identity.pgid] : [];
  assert.ok(groupCandidates.every(positive));
  const value = {pid: identity.pid, birth, sourceSha256: source.sha256, role};
  const stageKey = digest(Buffer.from(stable(value)));
  if (!origin.ownerStages.some(x => x.stageKey === stageKey)) origin.ownerStages.push({stageKey, role, nativePid: identity.pid,
    observedOsBirth: birth, actualObservedPgids: [...new Set(groupCandidates)], source, exit: null});
}
