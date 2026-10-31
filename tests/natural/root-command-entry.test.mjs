import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeRootCommand} from './root-command-contract.mjs';
import {publishRootCommandFromHost, admitRootCommand} from './root-command-entry.mjs';
const sha = raw => createHash('sha256').update(raw).digest('hex');

function fixture(action, executionPhase) {
  const scope = {namespaceId: 'example-root', containerId: 'a'.repeat(64),
    generationId: 'example-generation', accountingScope: executionPhase === 'live-wave' ? 'live-case' : 'qualification-offline'};
  const raw = Buffer.from('{"operation":"example"}\n');
  const plan = {schema: 'root-wave02-host-command-plan/v1', ...scope,
    imageId: 'sha256:' + 'd'.repeat(64), sequence: 4, action,
    rootNetworkMode: scope.accountingScope === 'live-case' ? 'bridge' : 'none',
    privateRoot: '/root-private', controlRoot: '/root-private/runtime',
    installedSourceRoot: '/code', publisherFile: '/code/commands/publisher.mjs',
    inputSource: {file: '/source/input.json', expectedSha256: sha(raw)}};
  const control = {schema: 'root-wave02-root-runtime/v2', ...scope,
    executionPhase, controlRoot: plan.controlRoot};
  const f = {plan, control, raw, trace: [], files: new Map(), records: new Map(), handlers: 0,
    actual: {Id: plan.containerId, Image: plan.imageId, Config: {User: '0:0', Labels: {'natural.root-namespace': plan.namespaceId}},
      HostConfig: {NetworkMode: plan.rootNetworkMode}, State: {Running: true}}};
  const reply = (value, code = 0) => ({code, stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: Buffer.alloc(0)});
  f.execute = async request => {
    const stages = {'root-command-exact-inspect': 'inspect', 'reserve-root-command-slot': 'reserve', 'publish-root-command-once': 'publish'};
    const stage = stages[request.label];assert.ok(stage);f.trace.push(stage);
    if (request.label === f.failAt) return reply('', 1);
    assert.equal(request.args[request.args[1] === 'inspect' ? 2 : 4], plan.containerId);
    if (stage === 'inspect') return reply(f.actual);
    if (stage === 'reserve') {
      const job = JSON.parse(Buffer.from(request.args.at(-2), 'base64'));
      makeRootCommand(job, control, {receipt: {sha256: job.input.expectedSha256}});
      f.reserved = structuredClone(job);return reply({reserved: true});
    }
    const job = JSON.parse(f.files.get(request.args.at(-2)));
    assert.deepEqual(job, f.reserved);
    const inputRaw = f.files.get(job.input.file);
    f.command = makeRootCommand(job, control, {receipt: {sha256: sha(inputRaw)}});
    const commandRaw = Buffer.from(JSON.stringify(f.command) + '\n');
    f.commandRef = {file: control.controlRoot + '/command-000004.json', expectedUid: 0, expectedGid: 0,
      allowedModes: [0o444], expectedSha256: sha(commandRaw)};
    return reply(f.commandRef);
  };
  f.store = {save: (name, value) => {f.records.set(name, value);return {name};},
    freeze: (name, value) => {f.trace.push('freeze');f.frozen = value;return {name, value};}};
  f.ports = {execute: f.execute, store: f.store,
    read: reference => {f.trace.push('read');assert.equal(reference.expectedSha256, sha(raw));return {raw};},
    publisherRelativePath: 'commands/publisher.mjs',
    buildBundle: value => {f.trace.push('build');f.bundle = value;return {files: value.files};},
    installBundle: async (value, ports) => {f.trace.push('install');assert.equal(value.containerId, plan.containerId);
      assert.equal(ports.execute, f.execute);assert.equal(ports.save, f.store.save);
      for (const file of value.files) {assert.equal(file.mode, 0o444);f.files.set(file.file, Buffer.from(file.raw));}}};
  f.publish = () => publishRootCommandFromHost(plan, f.ports);
  f.admitAndHandle = () => {const result = admitRootCommand(f.command, {control, sequence: plan.sequence});f.handlers++;return result;};
  return f;
}

for (const [action, phase] of [['prepare-writer-domain', 'live-wave'], ['freeze-offline-resource-close', 'offline-qualification']]) {
  test(action + ' follows the complete publication and runtime admission path', async () => {
    const f = fixture(action, phase),result = await f.publish();
    assert.equal(result.value.rootCommandSource.expectedSha256, f.commandRef.expectedSha256);
    assert.equal(result.value.actualSdkQualification, false);
    assert.equal(f.admitAndHandle().action, action);assert.equal(f.handlers, 1);
    assert.deepEqual(f.trace, ['inspect', 'read', 'reserve', 'build', 'install', 'publish', 'freeze']);
    assert.deepEqual(f.bundle.files[0].raw, f.raw);
    assert.equal(f.command.input.expectedSha256, sha(f.raw));
  });
}
test('wrong phase is rejected before any handler consumes the published input', async () => {
  const f = fixture('prepare-writer-domain', 'offline-qualification');await f.publish();
  assert.throws(() => f.admitAndHandle(), /Action exceeds the Root execution phase/u);assert.equal(f.handlers, 0);
});
test('unknown action fails at reservation before bundle installation or publication', async () => {
  const f = fixture('unknown-action', 'live-wave');await assert.rejects(f.publish());
  assert.deepEqual(f.trace, ['inspect', 'read', 'reserve']);assert.equal(f.handlers, 0);
});
test('Root physical identity is checked before input reading or reservation', async () => {
  for (const change of [x => x.Id = 'c'.repeat(64), x => x.Image = 'sha256:' + 'c'.repeat(64),
    x => x.Config.User = '1000:1000', x => x.HostConfig.NetworkMode = 'foreign',
    x => x.State.Running = false, x => x.Config.Labels['natural.root-namespace'] = 'foreign']) {
    const f = fixture('prepare-writer-domain', 'live-wave');change(f.actual);await assert.rejects(f.publish());
    assert.deepEqual(f.trace, ['inspect']);
  }
});
test('failed inspect, reserve or publish does not continue to subsequent stages', async () => {
  for (const [label, expected] of [['root-command-exact-inspect', ['inspect']],
    ['reserve-root-command-slot', ['inspect', 'read', 'reserve']],
    ['publish-root-command-once', ['inspect', 'read', 'reserve', 'build', 'install', 'publish']]]) {
    const f = fixture('freeze-offline-resource-close', 'offline-qualification');f.failAt = label;
    await assert.rejects(f.publish());assert.deepEqual(f.trace, expected);
  }
});
test('bundle installation rejection prevents publication', async () => {
  const f = fixture('freeze-offline-resource-close', 'offline-qualification');
  f.ports.installBundle = async () => {f.trace.push('install');throw Error('copy failed');};
  await assert.rejects(f.publish(), /copy failed/u);assert.deepEqual(f.trace, ['inspect', 'read', 'reserve', 'build', 'install']);
});
test('network, control directory and exact publisher path guards precede inspect', async () => {
  for (const [key, value] of [['rootNetworkMode', 'bridge'], ['controlRoot', '/foreign/runtime'], ['publisherFile', '/code/other.mjs']]) {
    const f = fixture('freeze-offline-resource-close', 'offline-qualification');f.plan[key] = value;
    await assert.rejects(f.publish());assert.deepEqual(f.trace, []);
  }
});
test('received schema, sequence and every Root scope field are checked before handlers', async () => {
  const f = fixture('freeze-offline-resource-close', 'offline-qualification');await f.publish();
  for (const [key, value] of [['schema', 'foreign'], ['sequence', 5], ['namespaceId', 'foreign'],
    ['containerId', 'c'.repeat(64)], ['generationId', 'foreign'], ['accountingScope', 'live-case']]) {
    const command = {...f.command, [key]: value};
    assert.throws(() => admitRootCommand(command, {control: f.control, sequence: 4}));
  }
  assert.equal(f.handlers, 0);
});
