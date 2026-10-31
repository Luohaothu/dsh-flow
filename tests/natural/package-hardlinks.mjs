import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const digest = raw => createHash('sha256').update(raw).digest('hex');
const same = (a, b, fields) => {for (const key of fields) assert.equal(a[key], b[key], 'Package file changed: ' + key);};
const stable = ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'];
const identity = ['dev', 'ino', 'uid', 'gid', 'mode'];
const snapshot = stat => Object.fromEntries(stable.map(key => [key, stat[key]]));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function protectedEntry(file, owner, directory = false) {
  const value = fs.lstatSync(file);
  assert.ok(!value.isSymbolicLink() && (directory ? value.isDirectory() : value.isFile()), 'Unsupported package entry');
  assert.deepEqual([value.uid, value.gid], [owner.uid, owner.gid], 'Unexpected package owner');
  assert.equal(value.mode & 0o022, 0, 'Package entry is writable by another identity');
  assert.equal(fs.realpathSync(file), file, 'Package path is not canonical');
  return value;
}
function readAt(fd, size) {
  assert.ok(Number.isSafeInteger(size) && size >= 0);
  const raw = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const count = fs.readSync(fd, raw, offset, size - offset, offset);
    assert.ok(count > 0, 'Package file became short');
    offset += count;
  }
  return raw;
}
function readStable(file, owner) {
  const before = protectedEntry(file, owner);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);same(opened, before, stable);
    const raw = readAt(fd, opened.size);same(fs.fstatSync(fd), opened, stable);same(fs.lstatSync(file), opened, stable);
    return {fd, stat: opened, raw};
  } catch (error) {fs.closeSync(fd);throw error;}
}

/** Materialize regular hardlinks inside a protected package tree; never follow symlinks. */
export function materializePackageHardlinks({root, expectedOwner = {uid: 0, gid: 0}}) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root);
  assert.notEqual(root, path.parse(root).root);
  assert.ok(Number.isSafeInteger(expectedOwner.uid) && Number.isSafeInteger(expectedOwner.gid));
  const owner = structuredClone(expectedOwner), initial = protectedEntry(root, owner, true);
  const receipt = {schema: 'package-hardlink-materialization/v1', root, owner, complete: false,
    observedRegularFiles: 0, observedSingleLinkFiles: 0, materialized: [], symlinks: [], finalRegularFiles: 0};
  const rootStillSame = () => same(protectedEntry(root, owner, true), initial, identity);
  function replace(file) {
    rootStillSame();const original = readStable(file, owner), before = original.stat;
    receipt.observedRegularFiles++;
    let temporary, tempFd, temporaryOwned = false, renamed = false, row;
    try {
      assert.ok(before.nlink >= 1);
      if (before.nlink === 1) {receipt.observedSingleLinkFiles++;return;}
      row = {file, before: snapshot(before), sha256: digest(original.raw), status: 'copying'};
      receipt.materialized.push(row);
      temporary = path.join(path.dirname(file), '.package-link-' + randomBytes(16).toString('hex'));
      tempFd = fs.openSync(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryOwned = true;
      fs.writeFileSync(tempFd, original.raw);
      const created = fs.fstatSync(tempFd);
      if (created.uid !== before.uid || created.gid !== before.gid) fs.fchownSync(tempFd, before.uid, before.gid);
      fs.fchmodSync(tempFd, before.mode & 0o7777);
      fs.futimesSync(tempFd, before.atime, before.mtime);
      fs.fsyncSync(tempFd);
      const prepared = fs.fstatSync(tempFd);
      assert.ok(prepared.isFile());assert.equal(prepared.nlink, 1);
      assert.deepEqual([prepared.uid, prepared.gid, prepared.mode & 0o7777, prepared.size], [before.uid, before.gid, before.mode & 0o7777, before.size]);
      assert.equal(digest(readAt(tempFd, prepared.size)), row.sha256, 'Temporary package bytes differ');
      same(fs.fstatSync(original.fd), before, stable);same(fs.lstatSync(file), before, stable);
      assert.equal(digest(readAt(original.fd, before.size)), row.sha256, 'Original package bytes changed');
      same(fs.fstatSync(original.fd), before, stable);rootStillSame();
      fs.renameSync(temporary, file);renamed = true;row.status = 'published-unverified';
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
      const after = protectedEntry(file, owner);same(after, fs.fstatSync(tempFd), stable);
      assert.equal(after.nlink, 1);assert.ok(after.dev !== before.dev || after.ino !== before.ino);
      assert.deepEqual([after.uid, after.gid, after.mode & 0o7777, after.size], [before.uid, before.gid, before.mode & 0o7777, before.size]);
      assert.equal(digest(readAt(tempFd, after.size)), row.sha256);
      const old = fs.fstatSync(original.fd);
      same(old, before, ['dev', 'ino', 'size', 'uid', 'gid', 'mode']);
      assert.equal(digest(readAt(original.fd, old.size)), row.sha256, 'Original alias bytes changed');
      row.after = snapshot(after);row.originalInodeLinksAfter = old.nlink;row.originalAliasBytesUnchanged = true;row.status = 'verified';
    } finally {
      if (tempFd !== undefined) fs.closeSync(tempFd);
      fs.closeSync(original.fd);
      if (temporaryOwned && !renamed) fs.unlinkSync(temporary);
    }
  }
  function walk(directory, verify = false) {
    rootStillSame();const before = protectedEntry(directory, owner, true);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), entry = fs.lstatSync(file);
      assert.ok(inside(root, file));
      if (entry.isSymbolicLink()) {
        if (!verify) receipt.symlinks.push({file, target: fs.readlinkSync(file), dev: entry.dev, ino: entry.ino, uid: entry.uid, gid: entry.gid, mode: entry.mode});
      } else if (entry.isDirectory()) walk(file, verify);
      else if (entry.isFile()) {
        if (verify) {const loaded = readStable(file, owner);try {assert.equal(loaded.stat.nlink, 1);receipt.finalRegularFiles++;} finally {fs.closeSync(loaded.fd);}}
        else replace(file);
      } else assert.fail('Unsupported package entry');
    }
    same(protectedEntry(directory, owner, true), before, identity);
  }
  try {
    walk(root);walk(root, true);rootStillSame();
    for (const link of receipt.symlinks) {
      const after = fs.lstatSync(link.file);assert.ok(after.isSymbolicLink());
      same(after, link, ['dev', 'ino', 'uid', 'gid', 'mode']);assert.equal(fs.readlinkSync(link.file), link.target);
    }
    assert.equal(receipt.finalRegularFiles, receipt.observedRegularFiles);
    receipt.complete = true;return receipt;
  } catch (error) {
    receipt.error = {name: error.name, message: error.message};
    error.materializationReceipt = receipt;throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [rootFlag, root, receiptFlag, receiptFile, ...extra] = process.argv.slice(2);
  assert.equal(rootFlag, '--root');assert.equal(receiptFlag, '--receipt');assert.equal(extra.length, 0);
  assert.equal(process.getuid(), 0);assert.equal(process.getgid(), 0);
  assert.ok(path.isAbsolute(receiptFile) && path.resolve(receiptFile) === receiptFile && !inside(root, receiptFile));
  protectedEntry(path.dirname(receiptFile), {uid: 0, gid: 0}, true);
  let receipt, failure;
  try {receipt = materializePackageHardlinks({root});} catch (error) {receipt = error.materializationReceipt;failure = error;}
  receipt ??= {schema: 'package-hardlink-materialization/v1', root, complete: false, materialized: [], error: {name: failure.name, message: failure.message}};
  fs.writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
  if (failure) {process.stderr.write(JSON.stringify({complete: false, materializedFiles: receipt.materialized.length, error: receipt.error}) + '\n');throw failure;}
}
