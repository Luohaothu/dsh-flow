import assert from 'node:assert/strict';
import {parseProcessMetadata} from './process-metadata.mjs';
const refDigest = ref => ref.expectedSha256 ?? ref.sha256;
const commandPlan = [
  ['host', '/usr/bin/uname', '-srm'],
  ['boot-time', '/usr/sbin/sysctl', '-n', 'kern.boottime'],
  ['boot-session', '/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'],
  ['processes', '/bin/ps', '-axo', 'pid=,ppid=,pgid=,uid=,lstart='],
];
export function readCurrentCensus(reference, recomputed, expected, io) {
  const loaded = io.load(reference), c = loaded.value;
  assert.equal(c.schema, 'root-historical-passive-census/v1');
  assert.ok(expected && /^[a-f\d]{64}$/.test(expected.sourceReviewSha256), 'Root frozen census source review is required');
  assert.equal(refDigest(c.sourceReviewedRef), expected.sourceReviewSha256);
  const review = io.load(c.sourceReviewedRef);
  assert.equal(review.value.schema, 'root-historical-passive-source-review/v1');
  assert.equal(review.value.executionAuthorized, true);
  assert.equal(review.value.action, 'metadata-only-historical-passive-census');
  assert.ok(typeof expected.hostScopeId === 'string' && expected.hostScopeId.trim().length > 0, 'Root frozen census host scope is required');
  assert.equal(review.value.hostScopeId, expected.hostScopeId);
  assert.equal(c.hostScopeId, expected.hostScopeId);
  assert.equal(c.sourceSetSha256, review.value.sourceSetSha256);
  assert.deepEqual(c.collectorClosure, review.value.collectorClosure);
  assert.deepEqual(c.node, review.value.node);
  assert.deepEqual(c.commandBinaries, review.value.commandBinaries);
  for (const source of c.collectorClosure) io.raw(source);
  const bound = new Set([refDigest(c.matrix), ...c.sourceRefs.map(refDigest)]);
  assert.ok(recomputed.scopeSourceDigests.slice(0, 3).every(x => bound.has(x)), 'Census is from different accounting/origin sources');
  assert.equal(c.commands.length, commandPlan.length);
  const outputs = [];
  for (let i = 0; i < commandPlan.length; i++) {
    const command = c.commands[i];
    assert.equal(command.role, commandPlan[i][0]);
    assert.deepEqual(command.argv, commandPlan[i].slice(1));
    assert.equal(command.code, 0); assert.equal(command.signal, null); assert.equal(command.error, null);
    assert.equal(command.outputTruncated, false);
    assert.equal(command.environmentValuesRead, false);
    const stdout = io.raw(command.stdout), stderr = io.raw(command.stderr);
    assert.equal(stderr.raw.length, 0, 'Passive command stderr is not empty');
    outputs.push(stdout.raw);
  }
  const host = /^Darwin ([a-zA-Z0-9.-]+) (arm64|x86_64)\n$/.exec(outputs[0].toString()); assert.ok(host);
  assert.deepEqual(c.host.value, {platform: 'darwin', kernelRelease: host[1], machine: host[2]});
  const boot = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}[^\n]*\n$/.exec(outputs[1].toString()); assert.ok(boot);
  assert.deepEqual(c.host.bootTime, {seconds: Number(boot[1]), microseconds: Number(boot[2])});
  assert.ok(c.host.bootTime.seconds > 0 && c.host.bootTime.microseconds < 1000000);
  assert.match(outputs[2].toString(), /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\n$/i);
  assert.equal(c.host.bootSession, outputs[2].toString().trim().toLowerCase());
  const rows = parseProcessMetadata(outputs[3], {includeUid: true});
  assert.equal(c.processes.length, rows.length);
  assert.deepEqual(c.processes.map(x => ({pid: x.pid, ppid: x.ppid, pgid: x.pgid, uid: x.uid, birth: x.osBirth.normalized.replace(/\s0(?=\d\s)/g, ' ')})),
    rows.map(x => ({pid: x.pid, ppid: x.ppid, pgid: x.pgid, uid: x.uid, birth: x.osBirth.replace(/\s0(?=\d\s)/g, ' ')})), 'Census parsed view differs from raw metadata');
  assert.equal(c.host.value.platform, 'darwin');
  assert.ok(c.host.bootSession && c.host.bootTime);
  assert.deepEqual(c.errors, []);
  assert.equal(c.metadataComplete, true);
  assert.equal(c.ownedSetComplete, false, 'Collector metadata must not claim a complete owned set');
  return {source: loaded.source, rows, hostScopeId: c.hostScopeId, bootSession: c.host.bootSession};
}

