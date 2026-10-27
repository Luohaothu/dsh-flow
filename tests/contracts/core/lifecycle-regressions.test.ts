import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context } from '../../../packages/dsh-flow/src/core/index.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { ContractHost, deferred, flush, message, profile } from '../../helpers/contract-host.js';

function environment() {
  const ctx = new Context(); const host = new ContractHost();
  ctx.registerHostAdaptor(host);
  return { ctx, host };
}

function contains(error: unknown, failure: unknown): boolean {
  return error === failure || (error instanceof AggregateError && error.errors.some(item => contains(item, failure)));
}

test('C005-02 C010-03 C028-03 failed factory cleanup before dispose remains a required release dependency', async () => {
  const { ctx, host } = environment();
  const cleanup = deferred(); const failure = new Error('native rollback failed');
  host.sendHook = () => { throw new Error('initial handover failed'); };
  host.releaseHook = native => host.closeGates.set(native, cleanup);
  const creating = Agent.create(ctx, profile('failed-factory'), null, message('initial'));
  const creationFailed = assert.rejects(creating, error => contains(error, failure));
  await flush(); cleanup.reject(failure); await creationFailed;
  const disposing = ctx.dispose();
  await assert.rejects(disposing, error => contains(error, failure));
  assert.equal(ctx.dispose(), disposing);
  assert.equal(host.disposeCount, 0);
});

test('C005-02 C010-03 C028-03 dispose waits for concurrent factory rollback and rejects its native cleanup failure', async () => {
  const { ctx, host } = environment();
  const initialize = deferred(); const cleanup = deferred();
  const failure = new Error('concurrent native rollback failed');
  host.createHook = () => initialize.promise;
  host.subscribeHook = native => host.closeGates.set(native, cleanup);
  const creating = Agent.create(ctx, profile('concurrent-factory'), null);
  const creationFailed = assert.rejects(creating, error => contains(error, failure));
  const disposing = ctx.dispose();
  let settled = false; void disposing.then(() => { settled = true; }, () => { settled = true; });
  initialize.resolve(); await flush();
  assert.equal(host.releases.length, 1); assert.equal(settled, false); assert.equal(host.disposeCount, 0);
  const disposalFailed = assert.rejects(disposing, error => contains(error, failure));
  cleanup.reject(failure); await Promise.all([creationFailed, disposalFailed]);
  assert.equal(host.disposeCount, 0);
});

test('C005-02 C010-03 C028-03 failed late native cleanup after candidate termination blocks dispose', async () => {
  const { ctx, host } = environment();
  const initialize = deferred(); const cleanup = deferred();
  const failure = new Error('late native cleanup failed');
  let termination: Promise<void> | undefined;
  host.createHook = flow => { termination = flow.recvSignal('SIGTERM'); return initialize.promise; };
  host.releaseHook = native => host.closeGates.set(native, cleanup);
  const creating = Agent.create(ctx, profile('late-native'), null);
  const creationFailed = assert.rejects(creating, error => contains(error, failure));
  await termination;
  const disposing = ctx.dispose();
  initialize.resolve(); await flush();
  assert.equal(host.releases.length, 1); assert.equal(host.disposeCount, 0);
  const disposalFailed = assert.rejects(disposing, error => contains(error, failure));
  cleanup.reject(failure); await Promise.all([creationFailed, disposalFailed]);
  assert.equal(host.disposeCount, 0);
});

for (const timing of ['before', 'concurrent'] as const) {
  test(`C005-02 C028-03 ordinary factory failure with successful cleanup permits ${timing} dispose`, async () => {
    const { ctx, host } = environment();
    const cleanup = deferred();
    host.sendHook = () => { throw new Error('business handover failed'); };
    host.releaseHook = native => host.closeGates.set(native, cleanup);
    const creating = Agent.create(ctx, profile(`business-failure-${timing}`), null, message('initial'));
    const creationFailed = assert.rejects(creating, /business handover failed/);
    await flush();
    const disposing = timing === 'concurrent' ? ctx.dispose() : undefined;
    cleanup.resolve(); await creationFailed;
    await (disposing ?? ctx.dispose());
    assert.equal(host.disposeCount, 1);
  });
}

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  test(`C004-02 C009-01 running observer ${signal} prevents notification handover`, async t => {
    const { ctx, host } = environment();
    const receiver = await Agent.create(ctx, profile('receiver'), null);
    const cleanup = deferred(); host.closeGates.set(host.native(receiver), cleanup);
    t.after(() => { cleanup.resolve(); return ctx.dispose(); });
    let termination: Promise<void> | undefined;
    let errors = 0;
    t.after(observeCore(ctx, event => {
      if (event.type === 'host-event' && event.event.type === 'error') errors++;
      if (event.type === 'agent-status' && event.agent === receiver && event.status === 'running') termination = receiver.recvSignal(signal);
    }));
    receiver.recvMessage(message('notify'));
    assert.equal(receiver.getStatus(), 'terminated'); assert.equal(host.releases.length, 1);
    assert.equal(host.sent.length, 0); assert.equal(errors, 0);
    cleanup.resolve(); await termination;
  });

  test(`C004-02 C006-02 C009-01 running observer ${signal} prevents initial input handover`, async t => {
    const { ctx, host } = environment();
    const cleanup = deferred(); host.releaseHook = native => host.closeGates.set(native, cleanup);
    t.after(() => { cleanup.resolve(); return ctx.dispose(); });
    t.after(observeCore(ctx, event => {
      if (event.type === 'agent-status' && event.status === 'running') void event.agent.recvSignal(signal);
    }));
    const creating = Agent.create(ctx, profile('initial'), null, message('initial input'));
    const creationFailed = assert.rejects(creating, /Agent is not available/);
    await flush();
    assert.equal(host.created[0]!.flow.getStatus(), 'terminated');
    assert.equal(host.sent.length, 0);
    cleanup.resolve(); await creationFailed;
  });
}

test('C004-02 C009-01 C026-02 C026-04 filter TERM rejects arrival before committing into the retained Mailbox', async t => {
  const { ctx, host } = environment();
  const receiver = await Agent.create(ctx, profile('receiver'), null);
  host.status(receiver, 'running');
  receiver.recvMessage(message('existing unread input'));
  const mailbox = receiver.getMailbox(); const existing = mailbox.query()[0]!;
  const cleanup = deferred(); host.closeGates.set(host.native(receiver), cleanup);
  t.after(() => { cleanup.resolve(); return ctx.dispose(); });
  let termination: Promise<void> | undefined;
  let received = 0;
  t.after(observeCore(ctx, event => { if (event.type === 'message-received') received++; }));
  mailbox.setFilters([() => { termination = receiver.recvSignal('SIGTERM'); return false; }]);
  assert.throws(() => receiver.recvMessage(message('rejected arrival')), /not receiving|Agent is not available/);
  assert.equal(receiver.getStatus(), 'terminated'); assert.equal(host.releases[0]!.mode, 'after-turn');
  assert.equal(mailbox.count(), 1); assert.deepEqual(mailbox.query().map(row => row.id), [existing.id]);
  assert.equal(mailbox.get(existing.id)?.summary, 'existing unread input');
  assert.equal(received, 0); assert.equal(host.sent.length, 0);
  cleanup.resolve(); await termination;
});
