import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT_COMMAND_PHASE_ACTIONS, ROOT_COMMAND_SCOPE_KEYS} from './root-command-contract.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');

/** Publish through the existing inspect, reservation, installation and publication protocol. */
export async function publishRootCommandFromHost(plan, {
  execute, store, read, buildBundle, installBundle, publisherRelativePath,
}) {
  assert.equal(plan.schema, 'root-wave02-host-command-plan/v1');
  assert.match(plan.containerId, /^[a-f0-9]{64}$/u);
  assert.equal(plan.rootNetworkMode, plan.accountingScope === 'qualification-offline' ? 'none' : 'bridge');
  assert.equal(plan.controlRoot, plan.privateRoot + '/runtime');
  assert.equal(typeof publisherRelativePath, 'string');
  assert.equal(plan.publisherFile, plan.installedSourceRoot + '/' + publisherRelativePath);
  const result = await execute({label: 'root-command-exact-inspect', args: [
    'container', 'inspect', plan.containerId, '--format', '{{json .}}',
  ]});
  store.save('root-command-inspect.stdout', result.stdout);
  assert.equal(result.code, 0);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual([
    actual.Id, actual.Image, actual.Config.User, actual.HostConfig.NetworkMode,
    actual.State.Running, actual.Config.Labels['natural.root-namespace'],
  ], [plan.containerId, plan.imageId, '0:0', plan.rootNetworkMode, true, plan.namespaceId]);
  const incoming = plan.privateRoot + '/incoming/' + String(plan.sequence).padStart(6, '0');
  const raw = read(plan.inputSource).raw;
  const input = {
    file: incoming + '/input.json', trustedRoot: incoming,
    expectedUid: 0, expectedGid: 0, allowedModes: [0o444], expectedSha256: sha(raw),
    forbiddenRoots: [], forbiddenFiles: [],
  };
  const job = {
    schema: 'root-wave02-root-command-publication/v1',
    ...Object.fromEntries(ROOT_COMMAND_SCOPE_KEYS.map(key => [key, plan[key]])),
    controlRoot: plan.controlRoot, sequence: plan.sequence, action: plan.action, input,
  };
  const reserve = await execute({label: 'reserve-root-command-slot', args: [
    'container', 'exec', '--user', '0:0', plan.containerId, 'node', plan.publisherFile,
    '--reserve-root-command', Buffer.from(JSON.stringify(job)).toString('base64'), plan.privateRoot,
  ]});
  store.save('root-command-reservation.stdout', reserve.stdout);
  store.save('root-command-reservation.stderr', reserve.stderr);
  assert.equal(reserve.code, 0);
  const jobRaw = Buffer.from(JSON.stringify(job) + '\n');
  const bundle = buildBundle({privateRoot: incoming, files: [
    {file: input.file, raw, mode: 0o444},
    {file: incoming + '/publication.json', raw: jobRaw, mode: 0o444},
  ]});
  await installBundle({containerId: plan.containerId, ...bundle}, {execute, save: store.save});
  const published = await execute({label: 'publish-root-command-once', args: [
    'container', 'exec', '--user', '0:0', plan.containerId, 'node', plan.publisherFile,
    '--publish-root-command', incoming + '/publication.json', plan.privateRoot,
  ]});
  store.save('root-command-publication.stdout', published.stdout);
  store.save('root-command-publication.stderr', published.stderr);
  assert.equal(published.code, 0);
  return store.freeze('root-command-publication.json', {
    plan, rootCommandSource: JSON.parse(published.stdout), actualSdkQualification: false,
  });
}

/** Admit a received command before runtime inputs or handlers are consumed. */
export function admitRootCommand(command, {control, sequence}) {
  assert.equal(command.schema, 'root-wave02-root-command/v1');
  assert.equal(command.sequence, sequence);
  assert.ok(ROOT_COMMAND_PHASE_ACTIONS[control.executionPhase].includes(command.action),
    'Action exceeds the Root execution phase');
  for (const key of ROOT_COMMAND_SCOPE_KEYS) assert.equal(command[key], control[key]);
  return command;
}
