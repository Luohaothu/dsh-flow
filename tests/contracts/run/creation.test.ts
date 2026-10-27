import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, flush } from '../../helpers/contract-host.js';
import { runFixture, waitFor } from '../../helpers/contract-run.js';

test('C036-01 create returns starting before initializing an idle root without model input', async t => {
  const initialization = deferred();
  t.after(() => initialization.resolve());
  const f = await runFixture(t, { onInitialize: () => initialization.promise });
  const origin = f.origin();
  const run = f.service.create(origin, {}, 'create');
  assert.ok(run.id);
  assert.equal(run.status, 'starting');
  assert.equal(f.service.read(origin, run).status, 'starting');
  await assert.rejects(f.service.assign(origin, run, f.spec(), 'too-early'));
  await flush();
  assert.equal(run.status, 'starting');
  initialization.resolve();
  await waitFor(() => run.status !== 'starting');
  assert.equal(run.status, 'active');
  const { root, host } = f.binding(run);
  assert.equal(root.getStatus(), 'idle');
  assert.equal(root.getParent(), null);
  assert.equal(root.getMailbox().count(), 0);
  assert.equal(host.sent.length, 0);
  await flush();
  assert.equal(run.status, 'active');
  assert.equal(host.sent.length, 0);
});

test('C036-01 root inherits the initiating session configuration and applies explicit Run overrides', async t => {
  const inherited = {
    model: { provider: 'session', id: 'session-model' },
    params: { version: 1 as const, reasoningEffort: 'high', temperature: 0.4, maxTokens: 800 },
    permission: 'workspace-write' as const,
    hostExtras: { workspace: { path: '/contract/project' }, native: 'session-config' },
  };
  const f = await runFixture(t, { originDefaults: inherited });
  const normal = await f.createActive();
  const normalProfile = f.binding(normal).root.getProfile();
  assert.deepEqual(normalProfile.model, inherited.model);
  assert.deepEqual(normalProfile.params, inherited.params);
  assert.equal(normalProfile.permission, inherited.permission);
  assert.deepEqual(normalProfile.hostExtras, inherited.hostExtras);
  const overridden = await f.createActive({ model: { provider: 'override', id: 'other-model' }, permission: 'read-only' });
  const overriddenProfile = f.binding(overridden).root.getProfile();
  assert.deepEqual(overriddenProfile.model, { provider: 'override', id: 'other-model' });
  assert.equal(overriddenProfile.permission, 'read-only');
  assert.deepEqual(overriddenProfile.params, inherited.params);
  assert.deepEqual(overriddenProfile.hostExtras, inherited.hostExtras);
  const tuned = await f.createActive({ params: { version: 1, maxTokens: 1600 }, hostExtras: { native: 'explicit-config' } });
  assert.deepEqual(f.binding(tuned).root.getProfile().params, { version: 1, maxTokens: 1600 });
  assert.deepEqual(f.binding(tuned).root.getProfile().hostExtras, { native: 'explicit-config' });
  assert.deepEqual(f.binding(tuned).root.getProfile().model, inherited.model);
});

test('C036-02 trusted origins use stable session identity across calls and isolate backend and session', async t => {
  const f = await runFixture(t);
  const firstCall = f.origin('session-a');
  const laterCall = f.origin('session-a');
  const otherSession = f.origin('session-b');
  const otherBackend = f.origin('session-a', 'other-backend');
  const defaults = { model: { provider: 'contract', id: 'chosen' }, permission: 'read-only' as const };
  const run = f.service.create(firstCall, defaults, 'same-key');
  assert.equal(f.service.create(laterCall, { permission: 'read-only', model: { id: 'chosen', provider: 'contract' } }, 'same-key'), run);
  assert.throws(() => f.service.create(laterCall, { ...defaults, permission: 'workspace-write' }, 'same-key'));
  const separateSession = await f.createActive({}, 'same-key', otherSession);
  const separateBackend = await f.createActive({}, 'same-key', otherBackend);
  await waitFor(() => run.status !== 'starting');
  assert.deepEqual(f.service.list(laterCall).map(item => item.id), [run.id]);
  assert.deepEqual(f.service.list(otherSession).map(item => item.id), [separateSession.id]);
  assert.deepEqual(f.service.list(otherBackend).map(item => item.id), [separateBackend.id]);
  assert.equal(f.service.read(laterCall, run).status, 'active');
  for (const outsider of [otherSession, otherBackend]) {
    assert.throws(() => f.service.read(outsider, run));
    await assert.rejects(f.service.assign(outsider, run, f.spec(), 'forbidden'));
    await assert.rejects(async () => f.service.release(outsider, run));
  }
  assert.equal(run.status, 'active');
});

test('C036-01 inherited and explicit defaults are snapshots across asynchronous initialization', async t => {
  const initialized = deferred();
  t.after(() => initialized.resolve());
  const sessionDefaults = {
    model: { provider: 'session', id: 'original' }, params: { version: 1 as const, maxTokens: 400 },
    permission: 'workspace-write' as const, hostExtras: { session: { value: 'original' } },
  };
  const overrides = { params: { version: 1 as const, maxTokens: 900 }, skills: ['role-skill'] };
  const f = await runFixture(t, { originDefaults: sessionDefaults, onInitialize: () => initialized.promise });
  const owner = f.origin();
  const run = f.service.create(owner, overrides, 'snapshots');
  sessionDefaults.model.id = 'changed';
  sessionDefaults.hostExtras.session.value = 'changed';
  overrides.params.maxTokens = 1;
  overrides.skills.push('changed');
  const exposed = run.defaults;
  exposed.skills!.push('mutated-view');
  initialized.resolve();
  await waitFor(() => run.status !== 'starting');
  assert.equal(run.status, 'active');
  const root = f.binding(run).root;
  assert.deepEqual(root.getProfile().model, { provider: 'session', id: 'original' });
  assert.deepEqual(root.getProfile().params, { version: 1, maxTokens: 900 });
  assert.deepEqual(root.getProfile().hostExtras, { session: { value: 'original' } });
  assert.deepEqual(run.defaults.skills, ['role-skill']);
  assert.equal(f.service.create(f.origin(), { params: { version: 1, maxTokens: 900 }, skills: ['role-skill'] }, 'snapshots'), run);
});

test('C036-02 matching origin fields cannot forge the host-issued authority', async t => {
  const f = await runFixture(t);
  const owner = f.origin();
  const run = await f.createActive({}, 'owned', owner);
  for (const forged of [{ ...owner }, structuredClone(owner), { backend: 'contract', callerSessionId: 'main' }]) {
    assert.throws(() => f.service.create(forged as never, {}, 'forged'));
    assert.throws(() => f.service.list(forged as never));
    assert.throws(() => f.service.read(forged as never, run));
    await assert.rejects(f.service.assign(forged as never, run, f.spec(), 'forged-assignment'));
    await assert.rejects(async () => f.service.release(forged as never, run));
  }
  assert.equal(run.status, 'active');
  assert.equal(f.binding(run).host.disposeCount, 0);
});
