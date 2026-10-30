import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isExactPackageVersion, resolvePackageMetadata, resolvePackageOwners, resolveDeclaredDependencyOwners } from './image-package-owners.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-package-owner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function pkg(relative, value) { const file = path.join(root, relative, 'package.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; }
  function link(anchor, name, target) { const link = path.join(path.dirname(anchor), 'node_modules', name); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.dirname(target), link); }
  const workspace = pkg('workspace', { name: 'example-workspace' });
  const parent = pkg('store/parent', { name: 'example-sdk', version: '1.2.3', dependencies: { 'example-base': '1.2.3' } });
  const consumer = pkg('store/base', { name: 'example-base', version: '1.2.3', dependencies: { 'example-internal': '1.2.3' } });
  const target = pkg('store/internal', { name: 'example-internal', version: '1.2.3' });
  link(workspace, 'example-sdk', parent); link(parent, 'example-base', consumer); link(parent, 'example-internal', target); link(consumer, 'example-internal', target);
  const input = { parentAnchor: parent, consumer: { name: 'example-base', version: '1.2.3', packageJsonSha256: hash(fs.readFileSync(consumer)) }, expected: { name: 'example-internal', version: '1.2.3', packageJsonSha256: hash(fs.readFileSync(target)) } };
  return { root, workspace, parent, consumer, target, input, pkg, link };
}
test('exact package versions accept actual pinned syntax and reject ranges', () => { for (const value of ['2.9.1', '4.6.5', '0.2.0-rc.2']) assert.equal(isExactPackageVersion(value), true); for (const value of ['^2.9.1', '~4.6.5', '*', '2.9', null]) assert.equal(isExactPackageVersion(value), false); });
test('internal package missing at workspace is valid through actual SDK consumer', t => { const f = fixture(t); assert.throws(() => createRequire(f.workspace).resolve('example-internal/package.json'), { code: 'MODULE_NOT_FOUND' }); const found = resolveDeclaredDependencyOwners(f.input); assert.equal(found.records[0].filename, f.target); assert.equal(found.records[1].filename, f.target); });
test('same owner and SHA from two actual anchors accepted', t => { const f = fixture(t); assert.equal(resolvePackageOwners([f.parent, f.consumer], f.input.expected).length, 2); });
test('equal versions at distinct physical owners rejected', t => { const f = fixture(t); const other = f.pkg('store/other', { name: 'example-internal', version: '1.2.3' }); fs.unlinkSync(path.join(path.dirname(f.consumer), 'node_modules/example-internal')); f.link(f.consumer, 'example-internal', other); assert.throws(() => resolveDeclaredDependencyOwners(f.input), /sdk-owner/); });
test('wrong original package bytes rejected', t => { const f = fixture(t); f.input.expected.packageJsonSha256 = '0'.repeat(64); assert.throws(() => resolveDeclaredDependencyOwners(f.input), /sdk-owner/); });
test('wrong original consumer bytes rejected', t => { const f = fixture(t); f.input.consumer.packageJsonSha256 = '0'.repeat(64); assert.throws(() => resolveDeclaredDependencyOwners(f.input), /consumer-pin/); });
test('undeclared consumer cannot supply a guessed lookup anchor', t => { const f = fixture(t); fs.writeFileSync(f.parent, JSON.stringify({ name: 'example-sdk' })); assert.throws(() => resolveDeclaredDependencyOwners(f.input), /consumer-not-declared/); });
test('consumer must actually declare the requested internal dependency', t => { const f = fixture(t); fs.writeFileSync(f.consumer, JSON.stringify({ name: 'example-base', version: '1.2.3' })); f.input.consumer.packageJsonSha256 = hash(fs.readFileSync(f.consumer)); assert.throws(() => resolveDeclaredDependencyOwners(f.input), /dependency-not-declared/); });
test('one anchor cannot masquerade as a same-owner comparison', t => { const f = fixture(t); assert.throws(() => resolvePackageOwners([f.parent], f.input.expected), /sdk-owner/); });
test('package metadata reader never executes package entry', t => { const f = fixture(t); fs.writeFileSync(path.join(path.dirname(f.target), 'index.js'), 'throw new Error("entry must not execute")'); assert.equal(resolvePackageMetadata(f.parent, 'example-internal').value.version, '1.2.3'); });
