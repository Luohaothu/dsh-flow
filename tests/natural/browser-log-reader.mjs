import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const digest = raw => createHash('sha256').update(raw).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const stable = ['dev','ino','size','uid','gid','mode','nlink','mtimeMs','ctimeMs'];

function original(reference, {filesystem, expectedOwner, allowEmpty}) {
  assert.ok(reference && path.isAbsolute(reference.file) && path.isAbsolute(reference.trustedRoot));
  assert.match(reference.expectedSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual([reference.expectedUid, reference.expectedGid], [expectedOwner.uid, expectedOwner.gid], 'Unexpected log owner policy');
  assert.ok(Array.isArray(reference.forbiddenRoots) && Array.isArray(reference.forbiddenFiles), 'Explicit forbidden boundaries required');
  assert.equal(reference.ownerOnlyAncestors, true, 'Browser logs require private ancestors');
  assert.deepEqual(reference.allowedModes, [0o600]);
  const file = path.resolve(reference.file), root = path.resolve(reference.trustedRoot);
  assert.equal(file, reference.file); assert.equal(root, reference.trustedRoot);
  assert.equal(filesystem.realpathSync(root), root); assert.ok(inside(root, file) && file !== root);
  for (const forbidden of reference.forbiddenRoots) assert.ok(!inside(path.resolve(forbidden), file), 'Candidate boundary overlaps log');
  const ancestors = [];
  for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
    const row = filesystem.lstatSync(directory); assert.ok(row.isDirectory() && !row.isSymbolicLink());
    assert.equal(filesystem.realpathSync(directory), directory);
    assert.deepEqual([row.uid, row.gid], [expectedOwner.uid, expectedOwner.gid]); assert.equal(row.mode & 0o077, 0, 'Log ancestor is not private');
    ancestors.push({path: directory, uid: row.uid, gid: row.gid, mode: row.mode & 0o777});
    if (directory === root) break; assert.notEqual(directory, path.dirname(directory));
  }
  const before = filesystem.lstatSync(file); assert.ok(before.isFile() && !before.isSymbolicLink());
  const fd = filesystem.openSync(file, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
  try {
    const opened = filesystem.fstatSync(fd); assert.ok(opened.isFile());
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino); assert.equal(opened.nlink, 1);
    assert.deepEqual([opened.uid, opened.gid, opened.mode & 0o777], [expectedOwner.uid, expectedOwner.gid, 0o600]);
    for (const forbidden of reference.forbiddenFiles) {
      assert.notEqual(file, path.resolve(forbidden));
      try { const row = filesystem.statSync(forbidden); assert.ok(row.dev !== opened.dev || row.ino !== opened.ino, 'Forbidden inode alias'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.ok(Number.isSafeInteger(opened.size) && opened.size >= (allowEmpty ? 0 : 1), 'Non-log original cannot be empty');
    const raw = filesystem.readFileSync(fd), after = filesystem.fstatSync(fd), final = filesystem.lstatSync(file);
    assert.ok(Buffer.isBuffer(raw));for (const key of stable) assert.equal(after[key], opened[key], 'Log changed while reading');
    for (const key of stable) assert.equal(final[key], opened[key], 'Log path changed while reading');
    assert.ok(final.isFile() && !final.isSymbolicLink());
    assert.equal(raw.length, opened.size); assert.equal(digest(raw), reference.expectedSha256, 'Log original bytes changed');
    return {raw, receipt: {path: file, sha256: digest(raw), bytes: raw.length, uid: opened.uid, gid: opened.gid, mode: opened.mode & 0o777, ancestors}};
  } finally { filesystem.closeSync(fd); }
}

// Only the stdout/stderr leaf selected by a nonempty pinned browser-close DTO
// may be empty. JSON and other roles do not use this allowance. Production is
// Root0 by default; expectedOwner is overridden only by explicit self-UID file
// controls, which do not establish Root0 runtime provenance.
export function readPinnedBrowserLog({closedSource, stream}, {filesystem = fs, expectedOwner = {uid: 0, gid: 0}} = {}) {
  assert.ok(['stdout','stderr'].includes(stream), 'Only browser stdout/stderr supported');
  assert.ok(Number.isSafeInteger(expectedOwner.uid) && expectedOwner.uid >= 0 && Number.isSafeInteger(expectedOwner.gid) && expectedOwner.gid >= 0);
  const closed = original(closedSource, {filesystem, expectedOwner, allowEmpty: false});
  const value = JSON.parse(closed.raw); assert.equal(value.schema, 'root-wave02-owned-browser-closed/v1');
  assert.ok(value.stdoutRef && value.stderrRef); assert.notEqual(value.stdoutRef.file, value.stderrRef.file);
  const reference = value[stream + 'Ref']; assert.equal(reference.trustedRoot, closedSource.trustedRoot); assert.notEqual(reference.file, closedSource.file);
  const log = original(reference, {filesystem, expectedOwner, allowEmpty: true});
  return {...log, receipt: {...log.receipt, role: 'owned-browser-' + stream, closedSourceSha256: closed.receipt.sha256}};
}
