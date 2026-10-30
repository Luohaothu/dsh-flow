import assert from 'node:assert/strict';

const mappingKeys = ['role', 'volumeName', 'rootPath', 'guestPath', 'writable', 'rootWritable'];
const record = value => value !== null && Object.prototype.toString.call(value) === '[object Object]';
const identifier = (value, field) => {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value), 'Invalid ' + field);
  return value;
};
const absolutePath = (value, field) => {
  assert.ok(typeof value === 'string' && value.startsWith('/') && value !== '/' && !/[\x00-\x1f\x7f\\]/.test(value)
    && value.slice(1).split('/').every(part => part && part !== '.' && part !== '..'), 'Noncanonical ' + field);
  return value;
};
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const unique = (rows, field, pathField = false) => {
  const seen = [];
  for (const row of rows) {
    assert.ok(!seen.some(value => pathField ? overlaps(value, row[field]) : value === row[field]), 'Reused or overlapping ' + field);
    seen.push(row[field]);
  }
};
function mappingRow(value, bound = false) {
  assert.ok(record(value), 'Mapping object required');
  assert.deepEqual(Object.keys(value).sort(), [...mappingKeys, ...(bound ? ['source'] : [])].sort(), 'Unexpected mapping fields');
  const row = Object.fromEntries(mappingKeys.map(key => [key, value[key]]));
  identifier(row.role, 'role'); identifier(row.volumeName, 'volumeName');
  absolutePath(row.rootPath, 'rootPath'); absolutePath(row.guestPath, 'guestPath');
  assert.equal(typeof row.writable, 'boolean', 'writable must be boolean');
  assert.equal(typeof row.rootWritable, 'boolean', 'rootWritable must be boolean');
  if (bound) row.source = absolutePath(value.source, 'source');
  return row;
}
function mappingSet(rows, bound = false) {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'Nonempty mappings required');
  const result = rows.map(row => mappingRow(row, bound));
  for (const field of ['role', 'volumeName']) unique(result, field);
  for (const field of ['rootPath', 'guestPath', ...(bound ? ['source'] : [])]) unique(result, field, true);
  return result;
}
function mountRow(value) {
  assert.ok(record(value) && typeof value.Type === 'string' && value.Type, 'Actual mount object required');
  absolutePath(value.Destination, 'mount Destination');
  assert.equal(typeof value.RW, 'boolean', 'Mount RW must be boolean');
  assert.equal(typeof value.Source, 'string', 'Mount Source required');
  if (value.Source !== '' || value.Type !== 'tmpfs') absolutePath(value.Source, 'mount Source');
  if (value.Type === 'volume') { identifier(value.Name, 'mount Name'); absolutePath(value.Source, 'volume Source'); }
  return value;
}

/** Bind daemon volume mountpoints to separate Root and guest destinations. Extra Root mounts must not overlap mapped Root destinations. */
export function bindNamedVolumeMounts({ mappings, volumes, candidateMounts, rootMounts, forbiddenSources = [] }) {
  const rows = mappingSet(mappings);
  assert.ok(Array.isArray(volumes) && volumes.length === rows.length, 'Complete volume inspect set required');
  assert.ok(Array.isArray(candidateMounts) && candidateMounts.length === rows.length, 'Candidate mount set differs from mappings');
  assert.ok(Array.isArray(rootMounts), 'Actual Root mounts required');
  assert.ok(Array.isArray(forbiddenSources), 'forbiddenSources must be an array');
  const forbidden = forbiddenSources.map(value => absolutePath(value, 'forbidden source'));
  const inspected = volumes.map(value => {
    assert.ok(record(value), 'Volume inspect object required');
    identifier(value.Name, 'volume Name'); assert.equal(value.Driver, 'local', 'Only local named volumes accepted');
    absolutePath(value.Mountpoint, 'volume Mountpoint');
    assert.ok(value.Options === null || record(value.Options) && Reflect.ownKeys(value.Options).length === 0, 'Local volume Options must be empty');
    return { Name: value.Name, Mountpoint: value.Mountpoint };
  });
  unique(inspected, 'Name'); unique(inspected, 'Mountpoint', true);
  const candidate = candidateMounts.map(mountRow), root = rootMounts.map(mountRow);
  assert.ok(candidate.every(mount => mount.Type === 'volume'), 'Candidate accepts only named volume mounts');
  unique(candidate, 'Name'); unique(candidate, 'Source', true); unique(candidate, 'Destination', true);
  const bound = rows.map(row => {
    const volume = inspected.find(value => value.Name === row.volumeName); assert.ok(volume, 'Mapped volume missing from inspect');
    const source = volume.Mountpoint;
    assert.ok(!/(?:^|\/)(?:docker|podman)\.sock(?:\/|$)/i.test(source), 'Container daemon socket source forbidden');
    assert.ok(!forbidden.some(value => overlaps(source, value)), 'Volume source overlaps a forbidden source');
    const mount = candidate.find(value => value.Name === row.volumeName); assert.ok(mount, 'Mapped candidate volume missing');
    assert.deepEqual([mount.Source, mount.Destination, mount.RW], [source, row.guestPath, row.writable], 'Candidate volume binding differs');
    const matches = root.filter(value => value.Name === row.volumeName || value.Source !== '' && overlaps(value.Source, source) || overlaps(value.Destination, row.rootPath));
    assert.equal(matches.length, 1, 'Root volume binding must be unique');
    const actual = matches[0];
    assert.deepEqual([actual.Type, actual.Name, actual.Source, actual.Destination, actual.RW],
      ['volume', row.volumeName, source, row.rootPath, row.rootWritable], 'Root volume binding differs');
    return Object.freeze({ ...row, source });
  });
  return Object.freeze(bound);
}

/** Compare only identities shared through the daemon or Root namespace; guest paths belong to separate containers. */
export function assertDistinctNamedVolumeMounts(cases) {
  assert.ok(Array.isArray(cases) && cases.length > 0, 'Nonempty cases required');
  const rows = [], caseIds = new Set();
  for (const entry of cases) {
    assert.ok(record(entry), 'Case bindings required'); identifier(entry.caseId, 'caseId');
    assert.ok(!caseIds.has(entry.caseId), 'Case ID reused'); caseIds.add(entry.caseId);
    const bindings = mappingSet(entry.bindings, true);
    for (const row of bindings) {
      for (const previous of rows) {
        assert.notEqual(row.volumeName, previous.volumeName, 'Volume name reused across cases');
        assert.ok(!overlaps(row.source, previous.source), 'Volume source reused across cases');
        assert.ok(!overlaps(row.rootPath, previous.rootPath), 'Root path reused across cases');
      }
      rows.push(row);
    }
  }
}
