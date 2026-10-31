import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const digest = raw => createHash('sha256').update(raw).digest('hex');
const preciseIdentity = value => {
  if (typeof value === 'bigint') return value;
  assert.ok(typeof value === 'string' && /^-?[0-9]+$/u.test(value), 'Exact inode identity required');
  return BigInt(value);
};
const same = (a, b, fields) => {for (const key of fields) assert.equal(['dev', 'ino'].includes(key) ? preciseIdentity(a[key]) : a[key], ['dev', 'ino'].includes(key) ? preciseIdentity(b[key]) : b[key], 'Package file changed: ' + key);};
function statView(stat) {
  const numeric = key => {const value = Number(stat[key]);assert.ok(Number.isSafeInteger(value), 'Unsafe package metadata: ' + key);return value;};
  const milliseconds = key => {const ns = stat[key];assert.equal(typeof ns, 'bigint');const whole = Number(ns / 1000000n);assert.ok(Number.isSafeInteger(whole));return whole + Number(ns % 1000000n) / 1000000;};
  assert.equal(typeof stat.dev, 'bigint');assert.equal(typeof stat.ino, 'bigint');
  const result = {dev: stat.dev, ino: stat.ino, ...Object.fromEntries(['size', 'uid', 'gid', 'mode', 'nlink'].map(key => [key, numeric(key)])),
    mtimeMs: milliseconds('mtimeNs'), ctimeMs: milliseconds('ctimeNs'), atime: stat.atime, mtime: stat.mtime};
  for (const method of ['isFile', 'isDirectory', 'isSymbolicLink']) result[method] = stat[method].bind(stat);
  return result;
}
const lstat = file => statView(fs.lstatSync(file, {bigint: true}));
const fstat = fd => statView(fs.fstatSync(fd, {bigint: true}));
const stable = ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'];
const identity = ['dev', 'ino', 'uid', 'gid', 'mode'];
const snapshot = stat => Object.fromEntries(stable.map(key => [key, ['dev', 'ino'].includes(key) ? preciseIdentity(stat[key]).toString() : stat[key]]));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function protectedEntry(file, owner, directory = false) {
  const value = lstat(file);
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
    const opened = fstat(fd);same(opened, before, stable);
    const raw = readAt(fd, opened.size);same(fstat(fd), opened, stable);same(lstat(file), opened, stable);
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
      const created = fstat(tempFd);
      if (created.uid !== before.uid || created.gid !== before.gid) fs.fchownSync(tempFd, before.uid, before.gid);
      fs.fchmodSync(tempFd, before.mode & 0o7777);
      fs.futimesSync(tempFd, before.atime, before.mtime);
      fs.fsyncSync(tempFd);
      const prepared = fstat(tempFd);
      assert.ok(prepared.isFile());assert.equal(prepared.nlink, 1);
      assert.deepEqual([prepared.uid, prepared.gid, prepared.mode & 0o7777, prepared.size], [before.uid, before.gid, before.mode & 0o7777, before.size]);
      assert.equal(digest(readAt(tempFd, prepared.size)), row.sha256, 'Temporary package bytes differ');
      same(fstat(original.fd), before, stable);same(lstat(file), before, stable);
      assert.equal(digest(readAt(original.fd, before.size)), row.sha256, 'Original package bytes changed');
      same(fstat(original.fd), before, stable);rootStillSame();
      fs.renameSync(temporary, file);renamed = true;row.status = 'published-unverified';
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
      const after = protectedEntry(file, owner);same(after, fstat(tempFd), stable);
      assert.equal(after.nlink, 1);assert.ok(after.dev !== before.dev || after.ino !== before.ino);
      assert.deepEqual([after.uid, after.gid, after.mode & 0o7777, after.size], [before.uid, before.gid, before.mode & 0o7777, before.size]);
      assert.equal(digest(readAt(tempFd, after.size)), row.sha256);
      const old = fstat(original.fd);
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
      const file = path.join(directory, name), entry = lstat(file);
      assert.ok(inside(root, file));
      if (entry.isSymbolicLink()) {
        if (!verify) receipt.symlinks.push({file, target: fs.readlinkSync(file), dev: entry.dev.toString(), ino: entry.ino.toString(), uid: entry.uid, gid: entry.gid, mode: entry.mode});
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
      const after = lstat(link.file);assert.ok(after.isSymbolicLink());
      same(after, link, ['dev', 'ino', 'uid', 'gid', 'mode']);assert.equal(fs.readlinkSync(link.file), link.target);
    }
    assert.equal(receipt.finalRegularFiles, receipt.observedRegularFiles);
    receipt.complete = true;return receipt;
  } catch (error) {
    receipt.error = {name: error.name, message: error.message};
    error.materializationReceipt = receipt;throw error;
  }
}

/** Reserve an owned receipt before package mutation, preserving a partial failure result. */
export function materializePackageHardlinksToReceipt({root, receiptFile, expectedOwner = {uid: 0, gid: 0}}) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root);
  assert.ok(path.isAbsolute(receiptFile) && path.resolve(receiptFile) === receiptFile && !inside(root, receiptFile));
  const owner = structuredClone(expectedOwner), parent = path.dirname(receiptFile);
  const beforeParent = protectedEntry(parent, owner, true);
  const fd = fs.openSync(receiptFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let receipt, failure, publicationFailure;
  try {
    const reserved = fstat(fd);assert.ok(reserved.isFile());assert.equal(reserved.nlink, 1);
    assert.deepEqual([reserved.uid, reserved.gid, reserved.mode & 0o777], [owner.uid, owner.gid, 0o600]);
    same(lstat(receiptFile), reserved, stable);same(protectedEntry(parent, owner, true), beforeParent, identity);
    try {receipt = materializePackageHardlinks({root, expectedOwner: owner});}
    catch (error) {failure = error;receipt = error.materializationReceipt ?? {schema: 'package-hardlink-materialization/v1', root, complete: false, materialized: [], error: {name: error.name, message: error.message}};}
    try {
      fs.writeFileSync(fd, JSON.stringify(receipt) + '\n');fs.fchmodSync(fd, 0o444);fs.fsyncSync(fd);
      const final = fstat(fd);same(lstat(receiptFile), final, stable);assert.equal(final.nlink, 1);
      assert.deepEqual([final.uid, final.gid, final.mode & 0o777], [owner.uid, owner.gid, 0o444]);
      same(protectedEntry(parent, owner, true), beforeParent, identity);
    } catch (error) {publicationFailure = error;}
  } catch (error) {failure ??= error;}
  finally {try {fs.closeSync(fd);} catch (error) {publicationFailure ??= error;}}
  if (failure) {if (publicationFailure) failure.receiptPublicationError = publicationFailure;throw failure;}
  if (publicationFailure) throw publicationFailure;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [rootFlag, root, receiptFlag, receiptFile, ...extra] = process.argv.slice(2);
  assert.equal(rootFlag, '--root');assert.equal(receiptFlag, '--receipt');assert.equal(extra.length, 0);
  assert.equal(process.getuid(), 0);assert.equal(process.getgid(), 0);
  materializePackageHardlinksToReceipt({root, receiptFile});
}
