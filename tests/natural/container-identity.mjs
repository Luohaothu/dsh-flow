import assert from 'node:assert/strict';

const token = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;
const containerId = /^[a-f0-9]{64}$/u;
const imageId = /^sha256:[a-f0-9]{64}$/u;

/** namespaceId is allocated before creation; containerId comes from the create/inspect readback. */
export function assertContainerAllocation(scope) {
  assert.ok(scope && typeof scope.caseId === 'string' && token.test(scope.caseId), 'Case identity missing');
  assert.ok(typeof scope.namespaceId === 'string' && token.test(scope.namespaceId), 'Case namespace token missing');
}

export function assertContainerScope(scope) {
  assertContainerAllocation(scope);
  assert.ok(containerId.test(scope.containerId), 'Exact container ID missing');
  assert.ok(imageId.test(scope.imageId), 'Exact image ID missing');
  return Object.freeze({ caseId: scope.caseId, namespaceId: scope.namespaceId, containerId: scope.containerId, imageId: scope.imageId });
}

export function assertDistinctContainerScopes(scopes) {
  assert.ok(Array.isArray(scopes) && scopes.length > 0, 'Container scopes missing');
  for (const scope of scopes) assertContainerScope(scope);
  for (const field of ['caseId', 'namespaceId', 'containerId']) {
    assert.equal(new Set(scopes.map(scope => scope[field])).size, scopes.length, 'Container isolation field reused: ' + field);
  }
}

/** Inspect adapters supply these six fields from the preserved raw inspection. */
export function assertContainerIdentity(expected, actual) {
  const scope = assertContainerScope(expected);
  const identity = expected.runtimeIdentity;
  assert.ok(identity && Number.isSafeInteger(identity.uid) && identity.uid > 0
    && Number.isSafeInteger(identity.gid) && identity.gid > 0, 'Nonroot runtime identity missing');
  assert.ok(typeof identity.user === 'string' && identity.user.length > 0, 'Runtime user missing');
  const user = identity.user.split(':')[0];
  assert.ok(user !== 'root' && !/^0+$/u.test(user), 'Root runtime user forbidden');
  assert.equal(actual.id, scope.containerId, 'Physical container ID differs');
  assert.equal(actual.image, scope.imageId, 'Container image differs');
  assert.equal(actual.user, identity.user, 'Container user differs');
  assert.equal(actual.network, 'none', 'Candidate network is not isolated');
  assert.equal(actual.privileged, false, 'Privileged candidate forbidden');
  const keys = expected.labelKeys;
  assert.ok(keys && ['caseId', 'namespaceId', 'owner'].every(field => typeof keys[field] === 'string' && keys[field]), 'Identity label keys missing');
  const required = ['caseId', 'namespaceId', 'owner'];
  if (expected.nonce !== undefined) {
    assert.ok(typeof expected.nonce === 'string' && expected.nonce.length >= 32, 'Creation nonce missing');
    assert.ok(typeof keys.nonce === 'string' && keys.nonce, 'Creation nonce label key missing');
    required.push('nonce');
  }
  assert.equal(new Set(required.map(field => keys[field])).size, required.length, 'Identity label keys overlap');
  assert.ok(actual.labels && typeof actual.labels === 'object' && !Array.isArray(actual.labels), 'Actual identity labels missing');
  for (const field of ['caseId', 'namespaceId']) assert.equal(actual.labels[keys[field]], scope[field], 'Container ' + field + ' label differs');
  assert.equal(actual.labels[keys.owner], 'root', 'Container owner label differs');
  if (expected.nonce !== undefined) assert.equal(actual.labels[keys.nonce], expected.nonce, 'Container nonce label differs');
  return scope;
}
