import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {materializePackageHardlinks, materializePackageHardlinksToReceipt} from './package-hardlinks.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'package-hardlinks-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'node_modules');fs.mkdirSync(root, {mode: 0o700});
  const stat = fs.statSync(root), owner = {uid: stat.uid, gid: stat.gid};
  const file = (name, raw, mode = 0o644) => {const target = path.join(root, name);fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});fs.writeFileSync(target, raw, {mode});return target;};
  return {directory, root, owner, file, run: () => materializePackageHardlinks({root, expectedOwner: owner})};
}
const metadata = file => {const s = fs.lstatSync(file);return {uid: s.uid, gid: s.gid, mode: s.mode, dev: s.dev, ino: s.ino, nlink: s.nlink, mtimeMs: s.mtimeMs};};

test('real external hardlink becomes an independent inode with identical bytes and permissions', t => {
  const f = fixture(t), target = f.file('package/data.bin', Buffer.from([0, 1, 255, 5]), 0o640), alias = path.join(f.directory, 'external.bin');
  fs.linkSync(target, alias);const before = metadata(target), externalBefore = metadata(alias), original = fs.readFileSync(alias);
  const out = f.run(), after = metadata(target);
  assert.equal(out.complete, true);assert.equal(out.materialized.length, 1);assert.equal(after.nlink, 1);assert.notEqual(after.ino, before.ino);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(metadata(alias).ino, externalBefore.ino);assert.equal(metadata(alias).nlink, 1);assert.deepEqual(fs.readFileSync(alias), original);
  assert.equal(out.materialized[0].originalAliasBytesUnchanged, true);
});

test('internal aliases converge to two single-link files without rewriting the last single-link inode', t => {
  const f = fixture(t), first = f.file('a', 'same bytes'), second = path.join(f.root, 'b');fs.linkSync(first, second);const old = metadata(second);
  const out = f.run();assert.equal(out.materialized.length, 1);assert.equal(metadata(first).nlink, 1);assert.equal(metadata(second).nlink, 1);
  assert.notEqual(metadata(first).ino, metadata(second).ino);assert.equal(metadata(second).ino, old.ino);assert.equal(fs.readFileSync(second, 'utf8'), 'same bytes');
});

test('single-link files retain inode, byte content, owner, mode and modification time', t => {
  const f = fixture(t), file = f.file('single', 'ordinary', 0o444), before = metadata(file);
  const out = f.run();assert.equal(out.materialized.length, 0);assert.deepEqual(metadata(file), before);assert.equal(fs.readFileSync(file, 'utf8'), 'ordinary');
});

test('package symlink resolution is preserved and out-of-tree symlink targets are never traversed', t => {
  const f = fixture(t), manifest = f.file('.pnpm/example/node_modules/example/package.json', '{"name":"example","version":"1.0.0"}\n');
  const store = path.join(f.directory, 'store.json');fs.linkSync(manifest, store);fs.symlinkSync('.pnpm/example/node_modules/example', path.join(f.root, 'example'));
  const outside = path.join(f.directory, 'outside');fs.mkdirSync(outside);const external = path.join(outside, 'entry');fs.writeFileSync(external, 'external');fs.linkSync(external, path.join(outside, 'alias'));
  fs.symlinkSync(outside, path.join(f.root, 'external-tree'));
  const require = createRequire(path.join(f.directory, 'application.cjs')), resolved = require.resolve('example/package.json');
  const symlinkBefore = metadata(path.join(f.root, 'example')), outsideBefore = metadata(external);
  const out = f.run();assert.equal(require.resolve('example/package.json'), resolved);assert.equal(fs.readlinkSync(path.join(f.root, 'example')), '.pnpm/example/node_modules/example');
  assert.deepEqual(metadata(path.join(f.root, 'example')), symlinkBefore);assert.deepEqual(metadata(external), outsideBefore);assert.equal(metadata(external).nlink, 2);
  assert.equal(out.observedRegularFiles, 1);assert.equal(out.symlinks.length, 2);assert.equal(metadata(manifest).nlink, 1);
});

test('a symlink root is rejected before any write', t => {
  const f = fixture(t), file = f.file('a', 'original'), alias = path.join(f.directory, 'root-alias');fs.linkSync(file, path.join(f.directory, 'external'));fs.symlinkSync(f.root, alias);
  assert.throws(() => materializePackageHardlinks({root: alias, expectedOwner: f.owner}));assert.equal(metadata(file).nlink, 2);
});

test('a late protected-tree failure retains an incomplete receipt without claiming rollback or completion', t => {
  const f = fixture(t), first = f.file('a', 'linked');fs.linkSync(first, path.join(f.directory, 'external'));
  const bad = path.join(f.root, 'z-unprotected');fs.mkdirSync(bad, {mode: 0o777});fs.chmodSync(bad, 0o777);
  assert.throws(f.run, error => {assert.equal(error.materializationReceipt.complete, false);assert.equal(error.materializationReceipt.materialized.length, 1);return true;});
  assert.equal(metadata(first).nlink, 1);assert.ok(!fs.readdirSync(f.root).some(name => name.startsWith('.package-link-')));
});

test('a second successful pass makes no further inode replacements', t => {
  const f = fixture(t), file = f.file('a', 'repeatable');fs.linkSync(file, path.join(f.directory, 'external'));assert.equal(f.run().materialized.length, 1);
  const before = metadata(file), out = f.run();assert.equal(out.complete, true);assert.equal(out.materialized.length, 0);assert.deepEqual(metadata(file), before);
});


test('exact high inode identities survive real replacement and receipt JSON serialization', t => {
  const f = fixture(t), file = f.file('a', 'precise identity');fs.linkSync(file, path.join(f.directory, 'external'));
  const realLstat = fs.lstatSync.bind(fs), realFstat = fs.fstatSync.bind(fs), oldInode = realLstat(file, {bigint: true}).ino;
  const beforeIdentity = 9007199254740992n, afterIdentity = 9007199254740993n, device = 9007199254740995n;
  assert.equal(Number(beforeIdentity), Number(afterIdentity));
  function project(stat, options) {
    const bigint = options?.bigint === true, projected = Object.create(stat);
    const inode = stat.isFile() ? ((bigint ? stat.ino === oldInode : stat.ino === Number(oldInode)) ? beforeIdentity : afterIdentity) : (bigint ? stat.ino : BigInt(stat.ino));
    Object.defineProperty(projected, 'dev', {value: bigint ? device : Number(device)});
    Object.defineProperty(projected, 'ino', {value: bigint ? inode : Number(inode)});
    for (const name of ['isFile', 'isDirectory', 'isSymbolicLink']) Object.defineProperty(projected, name, {value: stat[name].bind(stat)});
    return projected;
  }
  t.mock.method(fs, 'lstatSync', (name, options) => project(realLstat(name, options), options));
  t.mock.method(fs, 'fstatSync', (fd, options) => project(realFstat(fd, options), options));
  const result = f.run();assert.equal(result.complete, true);const row = result.materialized[0];
  assert.equal(row.before.ino, beforeIdentity.toString());assert.equal(row.after.ino, afterIdentity.toString());assert.equal(row.before.dev, device.toString());
  assert.doesNotThrow(() => JSON.stringify(result));assert.equal(fs.readFileSync(file, 'utf8'), 'precise identity');
  t.mock.restoreAll();
  const receiptFile = path.join(f.directory, 'success.json');
  const written = materializePackageHardlinksToReceipt({root: f.root, receiptFile, expectedOwner: f.owner});
  assert.equal(written.complete, true);assert.equal(written.materialized.length, 0);assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile)), written);
});

test('an existing receipt is refused before any package inode or hardlink mutation', t => {
  const f = fixture(t), file = f.file('a', 'untouched');fs.linkSync(file, path.join(f.directory, 'external'));
  const receiptFile = path.join(f.directory, 'receipt.json');fs.writeFileSync(receiptFile, 'original receipt');
  const before = metadata(file), bytes = fs.readFileSync(file);
  assert.throws(() => materializePackageHardlinksToReceipt({root: f.root, receiptFile, expectedOwner: f.owner}), {code: 'EEXIST'});
  assert.deepEqual(metadata(file), before);assert.deepEqual(fs.readFileSync(file), bytes);assert.equal(fs.readFileSync(receiptFile, 'utf8'), 'original receipt');
});

test('a partial materialization failure reaches the pre-reserved receipt and preserves the original failure', t => {
  const f = fixture(t), file = f.file('a', 'partial');fs.linkSync(file, path.join(f.directory, 'external'));
  const bad = path.join(f.root, 'z-unprotected');fs.mkdirSync(bad);fs.chmodSync(bad, 0o777);
  const receiptFile = path.join(f.directory, 'partial.json');let failure;
  try {materializePackageHardlinksToReceipt({root: f.root, receiptFile, expectedOwner: f.owner});} catch (error) {failure = error;}
  assert.ok(failure);assert.equal(failure.materializationReceipt.complete, false);assert.equal(failure.materializationReceipt.materialized.length, 1);
  const saved = JSON.parse(fs.readFileSync(receiptFile));assert.equal(saved.complete, false);assert.equal(saved.error.name, failure.name);assert.equal(saved.error.message, failure.message);
  assert.equal(typeof saved.materialized[0].before.ino, 'string');assert.equal(saved.materialized[0].status, 'verified');assert.equal(metadata(file).nlink, 1);
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o444);
});
