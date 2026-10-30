import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const isExactPackageVersion = value => typeof value === 'string' && /^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9_.-]+)?$/.test(value);
const fail = message => { throw new Error(message); };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// resolve() and JSON reads inspect installation metadata without importing SDK code.
export function resolvePackageMetadata(anchor, name) {
  const filename = fs.realpathSync(createRequire(anchor).resolve(`${name}/package.json`));
  const bytes = fs.readFileSync(filename), value = JSON.parse(bytes);
  if (value.name !== name) fail(`package-name:${name}`);
  return { filename, value, sha256: sha256(bytes) };
}

export function verifyOwnerRecords(records, expected) {
  if (records.length < 2 || records.some(record => record.version !== expected.version || record.realpath !== records[0].realpath || (expected.packageJsonSha256 && record.sha256 !== expected.packageJsonSha256))) fail(`sdk-owner:${expected.name}`);
}

export function resolvePackageOwners(anchors, expected) {
  if (!isExactPackageVersion(expected.version)) fail(`package-exact-version:${expected.name}`);
  const found = anchors.map(anchor => resolvePackageMetadata(anchor, expected.name));
  verifyOwnerRecords(found.map(record => ({ version: record.value.version, realpath: record.filename, sha256: record.sha256 })), expected);
  return found;
}

// Internal dependencies belong to their declaring consumer, not necessarily the workspace.
export function resolveDeclaredDependencyOwners({ parentAnchor, consumer, expected }) {
  if (!isExactPackageVersion(consumer.version) || !consumer.packageJsonSha256) fail('consumer-pin');
  const parent = JSON.parse(fs.readFileSync(parentAnchor, 'utf8'));
  if (parent.dependencies?.[consumer.name] !== consumer.version) fail(`consumer-not-declared:${consumer.name}`);
  const owner = resolvePackageMetadata(parentAnchor, consumer.name);
  if (owner.value.version !== consumer.version || owner.sha256 !== consumer.packageJsonSha256) fail(`consumer-pin:${consumer.name}`);
  if (owner.value.dependencies?.[expected.name] !== expected.version) fail(`dependency-not-declared:${expected.name}`);
  const records = resolvePackageOwners([parentAnchor, owner.filename], expected);
  return { consumer: owner, records };
}
