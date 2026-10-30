import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.resolve(value) === value && !/[\\\x00-\x1f\x7f]/u.test(value);
const inside = (root, file) => { const relative = path.posix.relative(root, file); return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative)); };
const overlap = (a, b) => inside(a, b) || inside(b, a);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
function rootReference(value, file, sha256, root) {
  assert.equal(value.file, file); assert.equal(value.trustedRoot, root);
  assert.deepEqual([value.expectedUid, value.expectedGid], [0, 0]);
  assert.deepEqual(value.allowedModes, [0o444]); assert.equal(value.expectedSha256, sha256);
  assert.ok(Array.isArray(value.forbiddenRoots) && Array.isArray(value.forbiddenFiles));
}

// Index rows name preserved raw bytes. Linux owner/path references are a new
// technical index; they do not rewrite or re-score the original documents.
export function validateRootReferenceIndex(index, {originalRoot, dataRoot, readSet, readSetRaw}) {
  assert.equal(index.schema, 'natural-root-reference-index/v1');
  assert.ok(canonical(originalRoot) && originalRoot !== '/' && canonical(dataRoot) && dataRoot !== '/');
  assert.equal(index.originalRoot, originalRoot); assert.equal(index.dataRoot, dataRoot);
  assert.equal(readSet.schema, 'natural-root-historical-read-set/v1');
  assert.equal(readSet.originalRoot, originalRoot); assert.ok(Buffer.isBuffer(readSetRaw)); assert.deepEqual(JSON.parse(readSetRaw), readSet); assert.equal(index.readSetSha256, digest(readSetRaw));
  assert.ok(readSet.files.length > 0); assert.equal(index.files.length, readSet.files.length);
  const originals = new Set(), targets = new Set();
  for (const row of index.files) {
    assert.ok(canonical(row.originalPath) && inside(originalRoot, row.originalPath) && row.originalPath !== originalRoot);
    const relative = path.posix.relative(originalRoot, row.originalPath);
    assert.equal(row.file, path.posix.join(dataRoot, relative)); assert.ok(inside(dataRoot, row.file));
    assert.ok(!originals.has(row.originalPath) && !targets.has(row.file)); originals.add(row.originalPath); targets.add(row.file);
    assert.ok(hex(row.sha256)); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    const original = readSet.files.filter(item => item.file === row.originalPath); assert.equal(original.length, 1);
    assert.equal(row.sha256, original[0].sha256); assert.equal(row.bytes, original[0].bytes);
    assert.equal(row.kind, 'preserved-raw'); rootReference(row.reference, row.file, row.sha256, dataRoot);
  }
  assert.deepEqual([...originals].sort(), readSet.files.map(row => row.file).sort());
  assert.equal(new Set(readSet.files.map(row => row.file)).size, readSet.files.length);
  assert.deepEqual(index.absentPaths, readSet.absentPaths);
  for (const file of index.absentPaths) { assert.ok(canonical(file) && inside(originalRoot, file) && file !== originalRoot); assert.ok(!originals.has(file)); }
  assert.equal(new Set(index.absentPaths).size, index.absentPaths.length);
  assert.deepEqual(index.directories, readSet.directories);
  assert.equal(new Set(index.directories.map(row => row.relative)).size, index.directories.length);
  for (const row of index.directories) {
    assert.ok(typeof row.relative === 'string' && row.relative && !row.relative.startsWith('/') && path.posix.normalize(row.relative) === row.relative && !row.relative.split('/').some(part => !part || part === '.' || part === '..'));
    assert.ok(Array.isArray(row.entries)); assert.equal(new Set(row.entries.map(entry => entry.name)).size, row.entries.length);
    if (row.selection) {
      assert.ok(readSet.files.some(file => file.sha256 === row.selection.readerSha256 && file.file.endsWith('.mjs')));
      assert.ok(Array.isArray(row.originalEntries));
      const selected = row.selection.kind === 'directories' ? row.originalEntries.filter(entry => entry.type === 'directory') : row.selection.kind === 'suffix' && row.selection.suffix === '-resource.json' ? row.originalEntries.filter(entry => entry.name.endsWith(row.selection.suffix)) : null;
      assert.ok(selected); assert.deepEqual(row.entries, selected);
    }
    for (const entry of row.entries) { assert.ok(typeof entry.name === 'string' && entry.name && !/[\\/\x00-\x1f\x7f]/u.test(entry.name) && !['.', '..'].includes(entry.name)); assert.ok(['file', 'directory'].includes(entry.type)); }
  }
  return freeze(structuredClone(index));
}

export function validateRootAuthorityLayout(layout, {inspection, rootProcess, sourceManifest, ownEntry, index, readSet, readSetRaw}) {
  assert.equal(layout.schema, 'natural-root-authority-layout/v1');
  assert.ok(hex(layout.containerId) && /^sha256:[a-f0-9]{64}$/u.test(layout.imageId));
  assert.ok(typeof layout.namespaceId === 'string' && layout.namespaceId);
  assert.deepEqual([inspection.Id, inspection.Image, inspection.Config.User, inspection.HostConfig.Privileged, inspection.State.Running], [layout.containerId, layout.imageId, '0:0', false, true]);
  assert.equal(inspection.Config.Labels[layout.namespaceLabelKey], layout.namespaceId);
  assert.ok(['none', 'bridge'].includes(layout.networkMode)); assert.equal(inspection.HostConfig.NetworkMode, layout.networkMode);
  assert.ok(!inspection.HostConfig.PortBindings || Object.keys(inspection.HostConfig.PortBindings).length === 0);
  for (const key of ['containerId', 'imageId', 'namespaceId']) assert.equal(rootProcess[key], layout[key]);
  assert.deepEqual([rootProcess.uid, rootProcess.gid], [0, 0]); assert.ok(Number.isSafeInteger(rootProcess.pid) && rootProcess.pid > 0);
  for (const key of ['codeRoot', 'dataRoot', 'privateRoot', 'originalRoot']) assert.ok(canonical(layout[key]) && layout[key] !== '/');
  assert.ok(inside(layout.privateRoot, layout.dataRoot) && layout.dataRoot !== layout.privateRoot);
  assert.ok(!overlap(layout.codeRoot, layout.dataRoot)); assert.equal(sourceManifest.schema, 'root-wave02-executable-source-install/v1');
  assert.equal(sourceManifest.linuxRoot, layout.codeRoot); assert.ok(canonical(ownEntry) && inside(layout.codeRoot, ownEntry));
  const entry = sourceManifest.files.filter(row => row.linuxPath === ownEntry); assert.equal(entry.length, 1);
  assert.deepEqual([entry[0].uid, entry[0].gid, entry[0].mode], [0, 0, 0o444]); assert.ok(hex(entry[0].sha256));
  const privateMount = inspection.Mounts.filter(row => row.Type === 'volume' && row.Name === layout.privateVolumeName && row.Destination === layout.privateRoot);
  assert.equal(privateMount.length, 1); assert.equal(privateMount[0].RW, true); assert.ok(canonical(privateMount[0].Source));
  assert.equal(layout.sharedMappings.length, 20); assert.equal(new Set(layout.sharedMappings.map(row => row.caseId)).size, 4);
  for (const caseId of new Set(layout.sharedMappings.map(row => row.caseId))) assert.deepEqual(layout.sharedMappings.filter(row => row.caseId === caseId).map(row => row.role).sort(), ['agentsHome', 'channel', 'nativeOutput', 'profile', 'workspace']);
  assert.equal(new Set(layout.sharedMappings.map(row => row.volumeName)).size, 20);
  assert.equal(new Set(layout.sharedMappings.map(row => row.rootPath)).size, 20);
  for (const [position, row] of layout.sharedMappings.entries()) {
    for (const previous of layout.sharedMappings.slice(0, position)) assert.ok(!overlap(previous.rootPath, row.rootPath) && !overlap(previous.source, row.source));
    assert.ok(canonical(row.rootPath) && canonical(row.source)); assert.ok(!overlap(row.rootPath, layout.privateRoot) && !overlap(row.rootPath, layout.dataRoot) && !overlap(row.rootPath, layout.codeRoot));
    assert.ok(!overlap(row.source, privateMount[0].Source)); assert.notEqual(row.volumeName, layout.privateVolumeName);
    const actual = inspection.Mounts.filter(mount => mount.Type === 'volume' && mount.Name === row.volumeName && mount.Source === row.source && mount.Destination === row.rootPath);
    assert.equal(actual.length, 1); assert.equal(actual[0].RW, true);
  }
  for (const mount of inspection.Mounts) {
    if (mount === privateMount[0] || layout.sharedMappings.some(row => mount.Type === 'volume' && mount.Name === row.volumeName && mount.Source === row.source && mount.Destination === row.rootPath)) continue;
    assert.ok(canonical(mount.Destination) && canonical(mount.Source));
    for (const protectedPath of [layout.codeRoot, layout.privateRoot, layout.dataRoot, ...layout.sharedMappings.map(row => row.rootPath)]) assert.ok(!overlap(mount.Destination, protectedPath), 'Additional mount shadows a protected Root view');
    for (const protectedSource of [privateMount[0].Source, ...layout.sharedMappings.map(row => row.source)]) assert.ok(!overlap(mount.Source, protectedSource), 'Additional mount aliases a protected volume source');
  }
  const validatedIndex = validateRootReferenceIndex(index, {originalRoot: layout.originalRoot, dataRoot: layout.dataRoot, readSet, readSetRaw});
  return freeze({schema: 'natural-root-authority-layout-binding/v1', containerId: layout.containerId, imageId: layout.imageId, namespaceId: layout.namespaceId, codeRoot: layout.codeRoot, dataRoot: layout.dataRoot, ownEntry, ownEntrySha256: entry[0].sha256, referenceIndexSha256: digest(Buffer.from(JSON.stringify(validatedIndex))), historicalFiles: validatedIndex.files.length, actualSdkQualified: false, businessCredit: false});
}
