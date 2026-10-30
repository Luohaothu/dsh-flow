import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNamedVolumeMounts, assertDistinctNamedVolumeMounts } from './container-mounts.mjs';

const roles = ['workspace', 'profile', 'agentsHome', 'nativeOutput', 'channel'];
function fixture(caseId = 'case-a') {
  const mappings = roles.map(role => ({ role, volumeName: caseId + '-' + role, rootPath: '/root-cases/' + caseId + '/' + role,
    guestPath: '/candidate/' + role, writable: role !== 'profile', rootWritable: role !== 'agentsHome' }));
  const volumes = mappings.map(row => ({ Name: row.volumeName, Driver: 'local', Mountpoint: '/var/lib/docker/volumes/' + row.volumeName + '/_data', Options: null, Scope: 'local' }));
  const candidateMounts = mappings.map((row, index) => ({ Type: 'volume', Name: row.volumeName, Source: volumes[index].Mountpoint, Destination: row.guestPath, RW: row.writable }));
  const rootMounts = mappings.map((row, index) => ({ Type: 'volume', Name: row.volumeName, Source: volumes[index].Mountpoint, Destination: row.rootPath, RW: row.rootWritable }));
  return { mappings, volumes, candidateMounts, rootMounts, forbiddenSources: [] };
}
function source(input, index, value) {
  input.volumes[index].Mountpoint = value; input.candidateMounts[index].Source = value; input.rootMounts[index].Source = value;
}

test('bind real named-volume shapes with separate daemon, Root and guest paths into frozen rows', () => {
  const input = fixture(), before = structuredClone(input), result = bindNamedVolumeMounts(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result, input.mappings.map((row, index) => ({ ...row, source: input.volumes[index].Mountpoint })));
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen));
  assert.throws(() => { result[0].source = '/other'; }, TypeError);
  input.mappings[0].role = 'changed'; input.volumes[0].Mountpoint = '/changed';
  assert.equal(result[0].role, 'workspace'); assert.match(result[0].source, /case-a-workspace\/_data$/);
});

test('match by named identity rather than inspect order and accept empty local Options', () => {
  const input = fixture(); input.volumes.forEach(row => { row.Options = {}; });
  input.volumes.reverse(); input.rootMounts.reverse(); input.candidateMounts.reverse();
  assert.deepEqual(bindNamedVolumeMounts(input).map(row => row.role), roles);
});

test('Root may retain its private, daemon and other-case mounts without exposing them to the candidate', () => {
  const input = fixture(); input.forbiddenSources = ['/private-root'];
  input.rootMounts.push({ Type: 'bind', Source: '/private-root/credentials', Destination: '/root-private/credentials', RW: false },
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true },
    ...fixture('case-b').rootMounts);
  assert.equal(bindNamedVolumeMounts(input).length, 5);
});

for (const direction of ['ancestor', 'descendant']) test('Root extra ' + direction + ' mount cannot shadow a mapped volume', () => {
  const input = fixture(), target = input.mappings[0].rootPath;
  input.rootMounts.push({ Type: 'bind', Source: '/unrelated-root-source',
    Destination: direction === 'descendant' ? target + '/nested' : target.slice(0, target.lastIndexOf('/')), RW: false });
  assert.throws(() => bindNamedVolumeMounts(input), /Root volume binding must be unique/);
});

for (const direction of ['ancestor', 'descendant']) test('Root extra physical ' + direction + ' source cannot alias a mapped volume', () => {
  const input = fixture(), target = input.volumes[0].Mountpoint;
  input.rootMounts.push({ Type: 'bind', Source: direction === 'descendant' ? target + '/unlisted-private-file' : target.slice(0, target.lastIndexOf('/')),
    Destination: '/root-private/unlisted-private-file', RW: false });
  assert.throws(() => bindNamedVolumeMounts(input), /Root volume binding must be unique/);
});

const invalid = [
  ['missing candidate mount', value => value.candidateMounts.pop()],
  ['extra readonly foreign candidate volume', value => value.candidateMounts.push({ ...fixture('case-b').candidateMounts[0], RW: false })],
  ['candidate bind mount', value => { value.candidateMounts[0].Type = 'bind'; }],
  ['candidate foreign volume name', value => { value.candidateMounts[0].Name = 'foreign'; }],
  ['candidate foreign physical source', value => { value.candidateMounts[0].Source = '/var/lib/docker/volumes/foreign/_data'; }],
  ['candidate wrong guest destination', value => { value.candidateMounts[0].Destination = '/different/workspace'; }],
  ['candidate wrong writability', value => { value.candidateMounts[0].RW = !value.mappings[0].writable; }],
  ['candidate duplicate name', value => { value.candidateMounts[1].Name = value.candidateMounts[0].Name; }],
  ['candidate duplicate physical source', value => { value.candidateMounts[1].Source = value.candidateMounts[0].Source; }],
  ['candidate duplicate destination', value => { value.candidateMounts[1].Destination = value.candidateMounts[0].Destination; }],
  ['missing volume inspect', value => value.volumes.pop()],
  ['extra foreign volume inspect', value => value.volumes.push(fixture('case-b').volumes[0])],
  ['duplicate volume inspect name', value => { value.volumes[1].Name = value.volumes[0].Name; }],
  ['duplicate volume mountpoint', value => { value.volumes[1].Mountpoint = value.volumes[0].Mountpoint; }],
  ['foreign volume inspect name', value => { value.volumes[0].Name = 'foreign'; }],
  ['volume source differs from actual mounts', value => { value.volumes[0].Mountpoint = '/different/daemon/source'; }],
  ['non-local volume driver', value => { value.volumes[0].Driver = 'external'; }],
  ['bind-backed local volume', value => { value.volumes[0].Options = { type: 'none', o: 'bind', device: '/private-root' }; }],
  ['nonempty local volume Options', value => { value.volumes[0].Options = { arbitrary: 'value' }; }],
  ['missing local Options witness', value => { delete value.volumes[0].Options; }],
  ['array local Options', value => { value.volumes[0].Options = []; }],
  ['missing mapped Root volume', value => value.rootMounts.pop()],
  ['Root wrong destination', value => { value.rootMounts[0].Destination = '/different/root/path'; }],
  ['Root wrong writability', value => { value.rootMounts[0].RW = !value.mappings[0].rootWritable; }],
  ['Root foreign physical source', value => { value.rootMounts[0].Source = '/different/daemon/source'; }],
  ['Root bind masquerading as a named volume', value => { value.rootMounts[0].Type = 'bind'; }],
  ['Root foreign name at the expected destination', value => { value.rootMounts[0].Name = 'foreign'; }],
  ['Root duplicate mounted volume alias', value => value.rootMounts.push({ ...value.rootMounts[0], Destination: '/second/root/alias' })],
  ['Root duplicate target occupied by another mount', value => value.rootMounts.push({ Type: 'bind', Source: '/other/source', Destination: value.mappings[0].rootPath, RW: false })],
  ['duplicate mapping role', value => { value.mappings[1].role = value.mappings[0].role; }],
  ['duplicate mapping volume', value => { value.mappings[1].volumeName = value.mappings[0].volumeName; }],
  ['duplicate mapping Root path', value => { value.mappings[1].rootPath = value.mappings[0].rootPath; }],
  ['duplicate mapping guest path', value => { value.mappings[1].guestPath = value.mappings[0].guestPath; }],
  ['nested mapping Root path', value => { value.mappings[1].rootPath = value.mappings[0].rootPath + '/profile'; value.rootMounts[1].Destination = value.mappings[1].rootPath; }],
  ['nested mapping guest path', value => { value.mappings[1].guestPath = value.mappings[0].guestPath + '/profile'; value.candidateMounts[1].Destination = value.mappings[1].guestPath; }],
  ['nested physical source with otherwise consistent inspect bindings', value => source(value, 1, value.volumes[0].Mountpoint + '/profile')],
  ['two writable roles share one physical volume source', value => source(value, 3, value.volumes[0].Mountpoint)],
  ['Root bind with an empty source', value => value.rootMounts.push({ Type: 'bind', Source: '', Destination: '/root-private/invalid', RW: false })],
  ['nonboolean writability', value => { value.mappings[0].writable = 1; }],
  ['mapping embeds a preselected source', value => { value.mappings[0].source = value.volumes[0].Mountpoint; }],
  ['forbidden sensitive source parent', value => { value.forbiddenSources = ['/var/lib/docker/volumes/case-a-workspace']; }],
  ['forbidden sensitive file below source', value => { value.forbiddenSources = [value.volumes[0].Mountpoint + '/credential.json']; }],
  ['Docker socket source', value => source(value, 0, '/var/run/docker.sock')],
  ['Podman socket source', value => source(value, 0, '/run/user/1000/podman/podman.sock')],
];
for (const [description, change] of invalid) test('reject ' + description, () => {
  const input = fixture(); change(input); assert.throws(() => bindNamedVolumeMounts(input));
});

for (const path of ['relative/path', '/root//workspace', '/root/../workspace', '/root/./workspace', '/root/workspace/', '/root\\workspace', '/root/\u0000workspace']) {
  test('reject noncanonical mapping and source path ' + JSON.stringify(path), () => {
    const input = fixture(); input.mappings[0].rootPath = path; assert.throws(() => bindNamedVolumeMounts(input));
    const physical = fixture(); source(physical, 0, path); assert.throws(() => bindNamedVolumeMounts(physical));
  });
}

test('four cases keep their own physical sources and Root destinations while sharing guest path spellings', () => {
  const cases = ['case-a', 'case-b', 'case-c', 'case-d'].map(caseId => ({ caseId, bindings: bindNamedVolumeMounts(fixture(caseId)) }));
  assert.equal(cases[0].bindings[0].guestPath, cases[1].bindings[0].guestPath);
  assert.doesNotThrow(() => assertDistinctNamedVolumeMounts(cases));
});

for (const [field, value] of [['volumeName', 'case-a-workspace'], ['source', '/var/lib/docker/volumes/case-a-workspace/_data'], ['rootPath', '/root-cases/case-a/workspace']]) {
  test('reject cross-case reuse of ' + field, () => {
    const first = { caseId: 'case-a', bindings: bindNamedVolumeMounts(fixture()) };
    const second = { caseId: 'case-b', bindings: structuredClone(bindNamedVolumeMounts(fixture('case-b'))) };
    second.bindings[0][field] = value;
    assert.throws(() => assertDistinctNamedVolumeMounts([first, second]));
  });
}

test('reject duplicated case identity and malformed serialized bindings', () => {
  const bindings = bindNamedVolumeMounts(fixture());
  assert.throws(() => assertDistinctNamedVolumeMounts([{ caseId: 'case-a', bindings }, { caseId: 'case-a', bindings: bindNamedVolumeMounts(fixture('case-b')) }]));
  const malformed = structuredClone(bindings); delete malformed[0].source;
  assert.throws(() => assertDistinctNamedVolumeMounts([{ caseId: 'case-a', bindings: malformed }]));
});

for (const field of ['source', 'rootPath']) {
  for (const direction of ['ancestor', 'descendant']) {
    test('reject cross-case ' + direction + ' overlap of ' + field, () => {
      const first = { caseId: 'case-a', bindings: bindNamedVolumeMounts(fixture()) };
      const second = { caseId: 'case-b', bindings: structuredClone(bindNamedVolumeMounts(fixture('case-b'))) };
      second.bindings[0][field] = direction === 'descendant' ? first.bindings[0][field] + '/nested' : first.bindings[0][field].slice(0, first.bindings[0][field].lastIndexOf('/'));
      assert.throws(() => assertDistinctNamedVolumeMounts([first, second]));
    });
  }
}
