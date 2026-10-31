import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
const keys = ['caseId', 'candidateId', 'namespaceId', 'containerId', 'imageId', 'generationId', 'accountingScope', 'nativeObserverSourceSha256', 'nonce'];
const digest = raw => createHash('sha256').update(raw).digest('hex');
const clone = value => structuredClone(value);
function bind(value, scope) {for (const key of keys) {assert.ok(typeof scope[key] === 'string' && scope[key]);assert.equal(value[key], scope[key]);}}
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const stable = ['dev','ino','size','uid','gid','mode','nlink','mtimeMs','ctimeMs'];

function original(reference, {filesystem, expectedOwner, allowEmpty}) {
  assert.ok(reference && path.isAbsolute(reference.file) && path.isAbsolute(reference.trustedRoot));
  assert.match(reference.expectedSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual([reference.expectedUid, reference.expectedGid], [expectedOwner.uid, expectedOwner.gid], 'Unexpected role-source owner policy');
  assert.ok(Array.isArray(reference.forbiddenRoots) && Array.isArray(reference.forbiddenFiles), 'Explicit forbidden boundaries required');
  assert.equal(reference.ownerOnlyAncestors, true, 'Role stderr requires private ancestors');
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

// Only the two stderr refs selected from the pinned joined record may be empty.
export function readRoleStderr({joinedSource, role}, {filesystem = fs, expectedOwner = {uid: 0, gid: 0}} = {}) {
  assert.ok(['root', 'sdk'].includes(role));
  const joined = original(joinedSource, {filesystem, expectedOwner, allowEmpty: false});
  const value = JSON.parse(joined.raw);
  assert.ok(['root-wave02-actual-pre-sdk-filemeta/v1', 'root-wave02-filemeta-process-source/v1'].includes(value.schema));
  const refs = value.roleSources;assert.notEqual(refs.rootStderr.file, refs.sdkStderr.file);
  const reference = refs[role + 'Stderr'];assert.equal(reference.trustedRoot, joinedSource.trustedRoot);assert.notEqual(reference.file, joinedSource.file);
  return original(reference, {filesystem, expectedOwner, allowEmpty: true});
}

function invocation(actual, expected, args) {assert.ok(expected && typeof expected.executable === 'string' && path.posix.isAbsolute(expected.executable));assert.ok(Array.isArray(expected.argsPrefix) && expected.argsPrefix.every(value => typeof value === 'string'));assert.equal(actual.executable, expected.executable);assert.deepEqual(actual.args, [...expected.argsPrefix, ...args]);}
function sdkProcess(value, target) {
  assert.equal(value.pid, 1);assert.equal(value.pid, target.pid);assert.equal(value.role, target.role);
  assert.equal(value.observedState, 'present');assert.equal(value.startTimeTicks, target.expectedStartTimeTicks);
  assert.equal(value.captureError, undefined);assert.ok(Array.isArray(value.fds));assert.ok(Array.isArray(value.cmdline));
  for (const key of ['Uid', 'Gid']) {const row = value.status.split('\n').find(row => row.startsWith(key + ':'));assert.ok(row);const ids = row.trim().split(/\s+/u).slice(1);assert.equal(ids.length, 4);assert.ok(ids.every(value => value === '1000'));}
  assert.equal(value.afterStat.slice(value.afterStat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19], target.expectedStartTimeTicks);
}
function join(root, sdk, input) {
  const {scope, mode, sdkTarget} = input;bind(root, scope);bind(sdk, scope);
  assert.equal(root.containerInspectionSourceSha256, input.rootScope.containerInspectionSourceSha256);
  assert.equal(sdk.containerInspectionSourceSha256, root.containerInspectionSourceSha256);
  assert.deepEqual([root.actor.uid, root.actor.gid], [0, 0]);assert.ok(Number.isSafeInteger(root.actor.pid) && root.actor.pid > 0);
  assert.deepEqual([sdk.actor.uid, sdk.actor.gid], [1000, 1000]);assert.ok(Number.isSafeInteger(sdk.actor.pid) && sdk.actor.pid > 0);
  assert.equal(sdk.actor.kind, 'Root-fixed-Node-only-same-uid-probe');assert.equal(sdk.schema, 'root-sdk-process-probe/v1');
  assert.equal(sdk.processes.length, 1);sdkProcess(sdk.processes[0], sdkTarget);
  const value = clone(root);
  if (mode === 'pre-sdk') {
    assert.equal(root.schema, 'root-wave02-actual-pre-sdk-filemeta/v1');
    assert.equal(root.sdkProcessSource, undefined);assert.equal(root.sdkPid, sdkTarget.pid);assert.equal(root.sdkStartTimeTicks, sdkTarget.expectedStartTimeTicks);
    value.sdkProcessSource = clone(sdk.processes[0]);
  } else {
    assert.equal(mode, 'native-peers');assert.equal(root.schema, 'root-wave02-filemeta-process-source/v1');
    assert.ok(Array.isArray(root.processes));assert.ok(root.processes.every(row => row.role === 'technicalBridge'));
    value.processes = [...clone(root.processes), clone(sdk.processes[0])];
  }
  value.sourceKind = 'role-split-Root0-filesystem-and-SDK1000-process';
  value.actualSdkQualified = false;return value;
}

/** Execute the two real actor roles, preserve their raw sources, then join them. */
export async function captureRoleFilemeta(input, {publishScopedRecord, command, save}) {
  const plan = clone(input),{scope, controlDirectory, fileName, mode} = plan;
  assert.ok(['pre-sdk', 'native-peers'].includes(mode));assert.match(scope.containerId, /^[a-f0-9]{64}$/u);
  assert.equal(path.posix.normalize(controlDirectory), controlDirectory);assert.ok(path.posix.isAbsolute(controlDirectory));assert.match(fileName, /^[a-zA-Z0-9_.-]+$/u);
  assert.equal(plan.sdkTarget.pid, 1);assert.match(plan.sdkTarget.expectedStartTimeTicks, /^\d+$/u);
  const sdkScope = {schema: 'root-sdk-process-probe-scope/v1', ...Object.fromEntries(keys.map(key => [key, scope[key]])),
    containerInspectionSourceSha256: plan.rootScope.containerInspectionSourceSha256, processes: [plan.sdkTarget]};
  const rootName = fileName + '-root.json',sdkName = fileName + '-sdk.json';
  const rootPublished = clone(await publishScopedRecord({directory: controlDirectory, fileName: rootName, value: plan.rootScope}));
  const sdkPublished = clone(await publishScopedRecord({directory: controlDirectory, fileName: sdkName, value: sdkScope}));
  const rootScopeSource = rootPublished, sdkScopeSource = sdkPublished;
  assert.equal(rootScopeSource.expectedSha256, digest(Buffer.from(JSON.stringify(plan.rootScope) + '\n')));
  assert.equal(sdkScopeSource.expectedSha256, digest(Buffer.from(JSON.stringify(sdkScope) + '\n')));
  const rootArgs = ['container', 'exec', '--user', '0:0', scope.containerId, 'node', plan.rootEntry,
    mode === 'pre-sdk' ? '--pre-sdk-filemeta' : '--reviewed-scope', controlDirectory + '/' + rootName];
  if (mode === 'pre-sdk') rootArgs.push(controlDirectory);
  const rootResult = await command(mode === 'pre-sdk' ? 'actual-pre-sdk-filemeta' : 'native-peer-sampler', rootArgs);
  assert.equal(rootResult.code, 0);invocation(rootResult.actualInvocation, plan.executor, rootArgs);const rootRaw = Buffer.from(rootResult.stdout),rootSource = clone(rootResult.refs.stdout);
  assert.equal(digest(rootRaw), rootSource.expectedSha256);
  const sdkResult = await command('sdk-process-probe', ['container', 'exec', '--user', '1000:1000', scope.containerId,
    'node', plan.sdkEntry, '--sdk-process-probe', controlDirectory + '/' + sdkName, controlDirectory]);
  assert.equal(sdkResult.code, 0);invocation(sdkResult.actualInvocation, plan.executor, ['container', 'exec', '--user', '1000:1000', scope.containerId, 'node', plan.sdkEntry, '--sdk-process-probe', controlDirectory + '/' + sdkName, controlDirectory]);const sdkRaw = Buffer.from(sdkResult.stdout),sdkSource = clone(sdkResult.refs.stdout);
  assert.equal(digest(sdkRaw), sdkSource.expectedSha256);
  const value = join(JSON.parse(rootRaw), JSON.parse(sdkRaw), plan);
  value.roleSources = {mode, rootSample: rootSource, sdkSample: sdkSource, rootScope: rootScopeSource, sdkScope: sdkScopeSource,
    rootPublished, sdkPublished, rootCommand: clone(rootResult.refs.command), rootInvocation: clone(rootResult.refs.invocation), rootStderr: clone(rootResult.refs.stderr), sdkCommand: clone(sdkResult.refs.command), sdkInvocation: clone(sdkResult.refs.invocation), sdkStderr: clone(sdkResult.refs.stderr), controlDirectory, rootName, sdkName, rootEntry: plan.rootEntry, sdkEntry: plan.sdkEntry};
  const raw = Buffer.from(JSON.stringify(value) + '\n'),source = clone(await save(fileName + '-joined.json', raw));
  assert.equal(source.expectedSha256, digest(raw));return {value, raw, source};
}

/** Rebuild the joined source from the original Root-preserved component bytes. */
export function verifyRoleFilemeta(value, {scope, mode, expected, joinedSource, readSource, readStderr = readRoleStderr, filesystem}) {
  const refs = value.roleSources;assert.equal(refs.mode, mode);
  assert.equal(refs.rootEntry, expected.rootEntry);assert.equal(refs.sdkEntry, expected.sdkEntry);
  const raw = reference => {assert.deepEqual([reference.expectedUid, reference.expectedGid], [0, 0]);assert.ok(Array.isArray(reference.allowedModes) && reference.allowedModes.length > 0 && reference.allowedModes.every(mode => [0o444, 0o600].includes(mode)));const loaded = readSource(reference);assert.ok(Buffer.isBuffer(loaded.raw));assert.equal(digest(loaded.raw), reference.expectedSha256);return loaded.raw;};
  const load = reference => JSON.parse(raw(reference));
  assert.deepEqual(load(joinedSource), value, 'Joined record differs from the current original');
  const rootScope = load(refs.rootScope),sdkScope = load(refs.sdkScope);bind(rootScope, scope);bind(sdkScope, scope);
  const rootCommand = load(refs.rootCommand),sdkCommand = load(refs.sdkCommand);
  for (const command of [rootCommand, sdkCommand]) for (const key of ['caseId', 'namespaceId', 'containerId', 'imageId', 'generationId', 'accountingScope']) assert.equal(command.scope[key], scope[key]);
  const rootArgs = ['container', 'exec', '--user', '0:0', scope.containerId, 'node', refs.rootEntry,
    mode === 'pre-sdk' ? '--pre-sdk-filemeta' : '--reviewed-scope', refs.controlDirectory + '/' + refs.rootName];
  if (mode === 'pre-sdk') rootArgs.push(refs.controlDirectory);
  assert.deepEqual(rootCommand.args, rootArgs);
  assert.deepEqual(sdkCommand.args, ['container', 'exec', '--user', '1000:1000', scope.containerId, 'node', refs.sdkEntry,
    '--sdk-process-probe', refs.controlDirectory + '/' + refs.sdkName, refs.controlDirectory]);
  const rootRun = load(refs.rootInvocation),sdkRun = load(refs.sdkInvocation);
  assert.equal(rootRun.code, 0);assert.equal(sdkRun.code, 0);invocation(rootRun.actualInvocation, expected.executor, rootCommand.args);invocation(sdkRun.actualInvocation, expected.executor, sdkCommand.args);
  for (const role of ['root', 'sdk']) {const source = refs[role + 'Stderr'];const result = readStderr({joinedSource, role}, {filesystem});assert.ok(Buffer.isBuffer(result.raw));assert.equal(result.receipt.path, source.file);assert.equal(digest(result.raw), source.expectedSha256);}

  assert.equal(sdkScope.schema, 'root-sdk-process-probe-scope/v1');assert.equal(sdkScope.processes.length, 1);
  const rebuilt = join(load(refs.rootSample), load(refs.sdkSample), {scope, mode, rootScope, sdkTarget: sdkScope.processes[0]});
  const {roleSources, ...actual} = value;assert.deepEqual(actual, rebuilt);return rebuilt;
}
