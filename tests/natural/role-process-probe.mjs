import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export function captureScopedProcess(target, {procRoot = '/proc', filesystem = fs} = {}) {
  assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0);
  const base = path.join(procRoot, String(target.pid));
  let initial;
  try {initial = filesystem.readFileSync(base + '/stat', 'utf8');}
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {role: target.role, pid: target.pid, observedState: 'absent', statPath: base + '/stat'};
  }
  const birth = stat => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];
  const start = birth(initial);
  const row = {role: target.role, pid: target.pid, observedState: 'present', stat: initial, startTimeTicks: start};
  try {
    row.status = filesystem.readFileSync(base + '/status', 'utf8');
    row.cmdline = filesystem.readFileSync(base + '/cmdline').toString().split('\0').filter(Boolean);
    row.fds = [];
    for (const fd of filesystem.readdirSync(base + '/fd')) {
      try {row.fds.push({fd, link: filesystem.readlinkSync(base + '/fd/' + fd)});}
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        row.fds.push({fd, disappearedDuringRead: true});
      }
    }
    row.afterStat = filesystem.readFileSync(base + '/stat', 'utf8');
    if (birth(row.afterStat) !== start) row.observedState = 'changed-during-capture';
    if (target.expectedStartTimeTicks !== undefined && target.expectedStartTimeTicks !== start)
      row.observedState = 'different-process-reused-pid';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    row.observedState = 'changed-during-capture';row.captureError = {code: error.code};
  }
  return row;
}

const keys = ['caseId', 'candidateId', 'namespaceId', 'containerId', 'imageId', 'generationId', 'accountingScope', 'nativeObserverSourceSha256', 'nonce'];

/** Node-only process sampling in the SDK's own UID; never a Root0 FD attestation. */
export function captureRoleProcessProbe(scope, {
  captureProcess = captureScopedProcess, platform = process.platform,
  uid = process.getuid(), gid = process.getgid(), pid = process.pid, now = Date.now,
} = {}) {
  assert.equal(platform, 'linux');
  assert.deepEqual([uid, gid], [1000, 1000]);
  assert.equal(scope.schema, 'root-sdk-process-probe-scope/v1');
  for (const key of keys) assert.ok(typeof scope[key] === 'string' && scope[key]);
  assert.match(scope.containerId, /^[a-f0-9]{64}$/u);
  assert.match(scope.containerInspectionSourceSha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(scope.processes.length, 1);
  const target = scope.processes[0];
  assert.equal(target.pid, 1);
  assert.ok(['sdk', 'pre-sdk-pid1'].includes(target.role));
  assert.match(target.expectedStartTimeTicks, /^\d+$/u);
  const value = captureProcess(target);
  assert.equal(value.pid, target.pid);assert.equal(value.role, target.role);
  assert.equal(value.observedState, 'present');
  assert.equal(value.startTimeTicks, target.expectedStartTimeTicks);
  for (const field of ['Uid', 'Gid']) {
    const line = value.status.split('\n').find(row => row.startsWith(field + ':'));
    assert.ok(line);const values = line.trim().split(/\s+/u).slice(1);
    assert.equal(values.length, 4);assert.ok(values.every(value => value === '1000'));
  }
  assert.ok(Array.isArray(value.cmdline));assert.ok(Array.isArray(value.fds));
  assert.equal(value.captureError, undefined);
  assert.equal(value.afterStat.slice(value.afterStat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19], target.expectedStartTimeTicks);
  return {
    schema: 'root-sdk-process-probe/v1', ...Object.fromEntries(keys.map(key => [key, scope[key]])),
    capturedAt: now(), containerInspectionSourceSha256: scope.containerInspectionSourceSha256,
    actor: {pid, uid, gid, kind: 'Root-fixed-Node-only-same-uid-probe'},
    processes: [value], actualSdkQualified: false,
  };
}
