import test from 'node:test';
import assert from 'node:assert/strict';
import { assertContainerAllocation, assertContainerScope, assertDistinctContainerScopes, assertContainerIdentity } from './container-identity.mjs';

function fixture(index = 0) {
  const expected = { caseId: 'case-' + index, namespaceId: 'allocated-case-' + index,
    containerId: String(index + 1).repeat(64), imageId: 'sha256:' + 'a'.repeat(64),
    runtimeIdentity: { user: '1000:1000', uid: 1000, gid: 1000 },
    labelKeys: { caseId: 'test.case', namespaceId: 'test.namespace', owner: 'test.owner', nonce: 'test.nonce' }, nonce: 'nonce-' + String(index).repeat(40) };
  const actual = { id: expected.containerId, image: expected.imageId, user: '1000:1000', network: 'none', privileged: false,
    labels: { 'test.case': expected.caseId, 'test.namespace': expected.namespaceId, 'test.owner': 'root', 'test.nonce': expected.nonce } };
  return { expected, actual };
}

test('four allocated case tokens bind to four separately returned physical IDs', () => {
  const cases = Array.from({ length: 4 }, (_, index) => fixture(index));
  const scopes = cases.map(({ expected, actual }) => assertContainerIdentity(expected, actual));
  assertDistinctContainerScopes(scopes);
  assert.equal(scopes[0].namespaceId, 'allocated-case-0');
  assert.equal(scopes[0].containerId, '1'.repeat(64));
  assert.equal(Object.isFrozen(scopes[0]), true);
});

for (const [name, change] of [
  ['foreign physical ID', f => { f.actual.id = '2'.repeat(64); }],
  ['foreign image', f => { f.actual.image = 'sha256:' + 'b'.repeat(64); }],
  ['foreign case label', f => { f.actual.labels['test.case'] = 'case-1'; }],
  ['physical ID substituted for namespace label', f => { f.actual.labels['test.namespace'] = f.expected.containerId; }],
  ['foreign namespace label', f => { f.actual.labels['test.namespace'] = 'allocated-case-1'; }],
  ['foreign owner label', f => { f.actual.labels['test.owner'] = 'candidate'; }],
  ['foreign nonce', f => { f.actual.labels['test.nonce'] = 'nonce-' + '1'.repeat(40); }],
  ['different runtime user', f => { f.actual.user = '1001:1000'; }],
  ['root runtime UID', f => { f.expected.runtimeIdentity.uid = 0; }],
  ['root numeric alias', f => { f.expected.runtimeIdentity.user = f.actual.user = '0000:1000'; }],
  ['root named user', f => { f.expected.runtimeIdentity.user = f.actual.user = 'root:1000'; }],
  ['network enabled', f => { f.actual.network = 'bridge'; }],
  ['privileged candidate', f => { f.actual.privileged = true; }],
  ['missing creation nonce label', f => { delete f.actual.labels['test.nonce']; }],
  ['overlapping label keys', f => { f.expected.labelKeys.namespaceId = f.expected.labelKeys.caseId; }],
  ['friendly container name', f => { f.expected.containerId = 'container-name'; }],
]) test('rejects ' + name + ' before a target can be used', () => {
  const f = fixture(); change(f); assert.throws(() => assertContainerIdentity(f.expected, f.actual));
});

for (const field of ['caseId', 'namespaceId', 'containerId']) test('rejects reused ' + field + ' across two cases', () => {
  const scopes = [fixture(0).expected, fixture(1).expected]; scopes[1][field] = scopes[0][field];
  assert.throws(() => assertDistinctContainerScopes(scopes), /isolation field reused/u);
});

test('a shared Root execution namespace does not stand in for the four allocated case tokens', () => {
  const scopes = Array.from({ length: 4 }, (_, index) => ({ ...fixture(index).expected, namespaceId: 'root-execution' }));
  assert.throws(() => assertDistinctContainerScopes(scopes), /namespaceId/u);
});

test('stop readback rejects another physical target while preserving the allocated namespace', () => {
  const f = fixture(), stopScope = { ...f.expected, containerId: fixture(1).expected.containerId };
  assert.throws(() => assertContainerIdentity(stopScope, f.actual), /Physical container ID/u);
  assert.equal(assertContainerIdentity(f.expected, f.actual).namespaceId, f.expected.namespaceId);
});

test('a consumer without nonce labels still enforces the original case, namespace, and owner contract', () => {
  const f = fixture(); delete f.expected.nonce; delete f.expected.labelKeys.nonce;
  assertContainerIdentity(f.expected, f.actual);
  f.actual.labels['test.namespace'] = 'foreign';
  assert.throws(() => assertContainerIdentity(f.expected, f.actual), /namespaceId/u);
});

test('scope fields cannot be omitted or inferred from the Root execution namespace', () => {
  for (const field of ['caseId', 'namespaceId', 'containerId', 'imageId']) {
    const scope = fixture().expected; delete scope[field]; assert.throws(() => assertContainerScope(scope));
  }
});

test('allocated tokens fit the existing case-stop identity format', () => {
  const scope = fixture().expected;
  assertContainerAllocation({ caseId: scope.caseId, namespaceId: 'n'.repeat(80) });
  assertContainerScope({ ...scope, namespaceId: 'n'.repeat(80) });
  assert.throws(() => assertContainerScope({ ...scope, namespaceId: 'n'.repeat(81) }));
});
