import {digest} from './historical-owner-scope.mjs';
export function fixture({baseline = false, present = false} = {}) {
  const files = new Map(), putRaw = (file, raw) => {raw = Buffer.from(raw); files.set(file, raw); return {file, sha256: digest(raw), bytes: raw.length};}, put = (file, value) => putRaw(file, JSON.stringify(value) + '\n');
  const root = '/history', caseRoot = root + '/.artifacts/natural-b2/private/scenario';
  const child = put(caseRoot + '/process.json', {pid: 41, startedAt: 1, endedAt: 2, exit: {code: 130, signal: null}});
  const pointer = put(root + '/.artifacts/natural-b2/current.json', {proof: caseRoot, scenario: 'scenario', pid: 40});
  const baseChild = baseline ? put(root + '/.artifacts/natural-b0/private/initial/process.json', {pid: 31, code: 130, signal: null, endedAt: '2026-10-28T00:00:00Z'}) : null;
  const snapshot = put(root + '/snapshot.json', {cases: [{batch: 'natural-b2', id: 'scenario'}]});
  const ledger = put(root + '/baseline.json', {rows: baseline ? [{id: 'initial', evidence: {processPath: '.artifacts/natural-b0/private/initial/process.json', processSha256: baseChild.sha256}}] : [], zeroObservedLaunchFailures: []});
  const matrix = put(root + '/matrix.json', {resourceCases: [{caseKey: 'natural-b2/scenario', childReceipt: child, closureFamily: 'unreconstructed-physical-history', closureRefs: []}], baselineLedger: {rows: baseline ? [{id: 'initial', childReceipt: baseChild}] : [], zeroAttemptLaunchOwners: []}});
  const directoryCensus = put(root + '/directory-census.json', {schema: 'file-only-private-process-census/v1', OSProcessesObserved: false, entries: [{stage: 2, origin: 'scenario', processExists: true}, ...(baseline ? [{stage: 0, origin: 'initial', processExists: true}] : [])]});
  const foundations = {snapshot, baseline: ledger, matrix, processDirectoryCensus: directoryCensus};
  const collector = putRaw(root + '/collector.mjs', 'export const metadataOnly = true;\n'), node = {file: '/node', sha256: 'a'.repeat(64)}, binaries = {ps: {file: '/bin/ps', sha256: 'b'.repeat(64)}};
  const reviewValue = {schema: 'root-historical-passive-source-review/v1', executionAuthorized: true, action: 'metadata-only-historical-passive-census', hostScopeId: 'fixture-host', sourceSetSha256: 'c'.repeat(64), collectorClosure: [collector], node, commandBinaries: binaries};
  const review = put(root + '/review.json', reviewValue);
  const definitions = [['host', ['/usr/bin/uname', '-srm'], 'Darwin 25.0 arm64\n'], ['boot-time', ['/usr/sbin/sysctl', '-n', 'kern.boottime'], '{ sec = 1, usec = 0 }\n'], ['boot-session', ['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], '12345678-1234-1234-1234-123456789012\n'], ['processes', ['/bin/ps', '-axo', 'pid=,ppid=,pgid=,uid=,lstart='], (present ? '41 1 41 501 Sat Oct 31 00:00:00 2026\n' : '1 0 1 0 Sat Oct 31 00:00:00 2026\n')]];
  const commands = definitions.map(([role, argv, output]) => ({role, argv, code: 0, signal: null, error: null, outputTruncated: false, environmentValuesRead: false, stdout: putRaw(root + '/' + role + '.stdout', output), stderr: putRaw(root + '/' + role + '.stderr', '')}));
  const censusValue = {schema: 'root-historical-passive-census/v1', sourceReviewedRef: review, hostScopeId: 'fixture-host', sourceSetSha256: 'c'.repeat(64), collectorClosure: [collector], node, commandBinaries: binaries, matrix, sourceRefs: [snapshot, ledger], commands, host: {value: {platform: 'darwin', kernelRelease: '25.0', machine: 'arm64'}, bootTime: {seconds: 1, microseconds: 0}, bootSession: '12345678-1234-1234-1234-123456789012'}, processes: [{pid: present ? 41 : 1, ppid: present ? 1 : 0, pgid: present ? 41 : 1, uid: present ? 501 : 0, osBirth: {normalized: 'Sat Oct 31 00:00:00 2026'}}], errors: [], metadataComplete: true, ownedSetComplete: false};
  const census = put(root + '/census.json', censusValue);
  const inputs = {foundations, currentPointers: [{batch: 'natural-b2', reference: pointer}], census, expectedCensus: {sourceReviewSha256: review.sha256, hostScopeId: 'fixture-host'}};
  return {files, put, putRaw, foundations, inputs, censusValue, pointer, child, read: ref => Buffer.from(files.get(ref.file ?? ref.path))};
}
