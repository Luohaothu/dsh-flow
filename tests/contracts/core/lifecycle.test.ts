import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context, Group, Mailbox } from '../../../packages/dsh-flow/src/core/index.js';
import { ContractHost, deferred, flush, message, profile } from '../../helpers/contract-host.js';

function environment() {
  const ctx = new Context(); const host = new ContractHost();
  ctx.registerHostAdaptor(host);
  return { ctx, host };
}

test('C002-01 C005-01 C006-01 profile snapshot and a single early Mailbox are ready before idle publication', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const input = profile('root', { model: { provider: 'contract', id: 'original' }, params: { version: 1, maxTokens: 80 }, hostExtras: { nested: { value: 1 } } });
  let bound: Agent | undefined; let boundMailbox: Mailbox | undefined;
  host.createHook = flow => {
    bound = flow; boundMailbox = flow.getMailbox();
    assert.equal(ctx.has(flow), false);
    assert.equal(boundMailbox.count(), 0);
  };
  const root = await Agent.create(ctx, input, null);
  delete host.createHook;
  const child = await Agent.create(ctx, profile('child'), root);
  input.model = { provider: 'changed', id: 'changed' };
  input.params.maxTokens = 999;
  Reflect.set(input.hostExtras!.nested as object, 'value', 99);
  assert.equal(root, bound); assert.equal(root.getMailbox(), boundMailbox);
  const stable = root.getProfile();
  assert.equal(root.getProfile(), stable); assert.notEqual(stable, input);
  assert.deepEqual(stable, { role: '核验公开合同', sessionID: 'root', permission: 'workspace-write', name: 'root', model: { provider: 'contract', id: 'original' }, params: { version: 1, maxTokens: 80 }, hostExtras: { nested: { value: 1 } } });
  assert.equal(Object.isFrozen(stable), true); assert.equal(Object.isFrozen(stable.params), true);
  assert.equal(ctx.getAgent(sessionID('root')), root);
  assert.equal(ctx.getAgent(sessionID('child')), child);
  assert.equal(ctx.has(root.getMailbox()), true);
  assert.equal(host.listeners.get(host.native(root))?.size, 1);
  assert.equal(child.getParent(), root); assert.deepEqual(root.getChildren(), [child]);
  const returned = root.getChildren(); returned.length = 0;
  assert.deepEqual(root.getChildren(), [child]);
  assert.equal(root.getStatus(), 'idle'); assert.equal(child.getStatus(), 'idle');
  assert.equal(host.sent.length, 0);
});

test('C002-02 invalid generic reasoning data fails before creating a native instance', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  for (const params of [{ version: 1 as const, temperature: NaN }, { version: 1 as const, maxTokens: 0 }, { version: 1 as const, maxTokens: 1.5 }, { version: 1 as const, reasoningEffort: '' }, { version: 1 as const, unknownInference: true }]) {
    await assert.rejects(Agent.create(ctx, profile('invalid', { params }), null));
  }
  assert.equal(host.created.length, 0);
  assert.equal(ctx.getAgent(sessionID('invalid')), null);
});

test('C003-02 C006-02 init input is handed over after publication, with history imported separately', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const accepted = deferred();
  host.sendHook = record => {
    const flow = host.created.find(item => item.agent === record.agent)!.flow;
    assert.equal(ctx.getAgent(sessionID('initial')), flow);
    assert.equal(ctx.has(flow.getMailbox()), true);
    assert.equal(host.listeners.get(record.agent)?.size, 1);
    return accepted.promise;
  };
  let settled = false;
  const create = Agent.create(ctx, profile('initial'), null, message('first input'), 'external-history-v1');
  void create.then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  assert.equal(host.created[0]?.history, 'external-history-v1');
  assert.equal(host.sent.length, 1); assert.equal(host.sent[0]?.purpose, 'input');
  assert.equal(host.sent[0]?.mode, 'followup');
  accepted.resolve(); const agent = await create;
  host.status(agent, 'running');
  assert.equal(agent.getStatus(), 'running');
  assert.equal(settled, true);
});

test('C005-02 parent termination during initialization rolls back and waits for backend binding cleanup', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const parent = await Agent.create(ctx, profile('parent'), null);
  const initializing = deferred(); const entered = deferred(); const cleaned = deferred();
  let provisional: Agent | undefined;
  host.createHook = flow => { provisional = flow; entered.resolve(); return initializing.promise; };
  let rejected = false;
  const creation = Agent.create(ctx, profile('provisional'), parent);
  void creation.catch(() => { rejected = true; });
  await entered.promise;
  await parent.recvSignal('SIGTERM');
  host.releaseHook = native => { if (native.profile.sessionID === 'provisional') host.closeGates.set(native, cleaned); };
  initializing.resolve(); await flush();
  assert.equal(rejected, false);
  assert.equal(ctx.getAgent(sessionID('provisional')), null);
  assert.deepEqual(parent.getChildren(), []);
  cleaned.resolve(); await assert.rejects(creation);
  assert.equal(ctx.has(provisional!), false);
  assert.equal(ctx.has(provisional!.getMailbox()), false);
  assert.throws(() => provisional!.getMailbox().put(message('late')));
  assert.equal(host.listeners.get(host.native(provisional!))?.size ?? 0, 0);
});

test('C005-02 subscription callback termination cannot publish a child under its terminated parent', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const parent = await Agent.create(ctx, profile('parent'), null);
  host.subscribeHook = native => {
    if (native.profile.sessionID === 'child') void parent.recvSignal('SIGKILL');
  };
  await assert.rejects(Agent.create(ctx, profile('child'), parent));
  assert.equal(ctx.getAgent(sessionID('child')), null);
  assert.deepEqual(parent.getChildren(), []);
  assert.equal(host.releases.some(r => r.agent.profile.sessionID === 'child'), true);
});

test('C005-02 event subscription failure rolls back host binding and empty Mailbox', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  host.subscribeHook = () => { throw new Error('subscription unavailable'); };
  await assert.rejects(Agent.create(ctx, profile('failed-subscribe'), null), /subscription unavailable/);
  const provisional = host.created[0]!.flow;
  assert.equal(ctx.getAgent(sessionID('failed-subscribe')), null);
  assert.equal(ctx.has(provisional.getMailbox()), false);
  assert.equal(host.releases.length, 1);
  assert.throws(() => provisional.getMailbox().put(message('late')));
});

test('C005-02 C006-02 failed initial input rolls back published child before rejecting', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const parent = await Agent.create(ctx, profile('parent'), null);
  const cleanup = deferred();
  host.sendHook = () => { throw new Error('input handover failed'); };
  host.releaseHook = native => host.closeGates.set(native, cleanup);
  let rejected = false;
  const create = Agent.create(ctx, profile('child'), parent, message('initial'));
  void create.catch(() => { rejected = true; });
  await flush();
  assert.equal(ctx.getAgent(sessionID('child')), null);
  assert.equal(rejected, false);
  cleanup.resolve(); await assert.rejects(create, /input handover failed/);
  assert.deepEqual(parent.getChildren(), []);
  assert.equal(host.listeners.get(host.created[1]!.agent)?.size, 0);
  assert.equal(ctx.has(host.created[1]!.flow.getMailbox()), false);
});

test('C007-01 C007-02 C026-04 cold resume has saved profile, a fresh mailbox and only the new parent', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const oldParent = await Agent.create(ctx, profile('old-parent'), null);
  const old = await Agent.create(ctx, profile('saved', { params: { version: 1, maxTokens: 70 }, hostExtras: { saved: true } }), oldParent);
  const oldChild = await Agent.create(ctx, profile('old-child'), old);
  const newParent = await Agent.create(ctx, profile('new-parent'), null);
  const group = new Group(ctx, [old, oldParent]);
  host.status(old, 'running');
  old.recvMessage(message('old message', oldParent));
  const oldID = old.getMailbox().query()[0]!.id;
  old.getMailbox().get(oldID); old.getMailbox().setFilters([() => true]);
  old.getMailbox().setSourcePriority(oldParent, 'high');
  old.wait(() => false, 50_000);
  await host.persist(host.native(old)); await ctx.release(old);
  const restored = await Agent.resume(ctx, newParent, sessionID('saved'));
  assert.notEqual(restored, old); assert.notEqual(restored.getMailbox(), old.getMailbox());
  assert.deepEqual(restored.getProfile(), { role: '核验公开合同', sessionID: 'saved', permission: 'workspace-write', name: 'saved', model: { provider: 'contract', id: 'model-a' }, params: { version: 1, maxTokens: 70 }, hostExtras: { saved: true } });
  assert.equal(restored.getParent(), newParent); assert.deepEqual(restored.getChildren(), []);
  assert.equal(restored.hasPendingWait(), false); assert.equal(restored.getStatus(), 'idle');
  assert.equal(restored.getMailbox().count(), 0); assert.deepEqual(restored.getMailbox().getFilters(), []);
  assert.equal(restored.getMailbox().getSourcePriority(oldParent), null);
  assert.equal(restored.getMailbox().peak(oldID), null);
  restored.recvMessage(message('fresh', oldParent));
  assert.notEqual(restored.getMailbox().query()[0]!.id, oldID);
  assert.equal(ctx.getAgent(oldChild.getProfile().sessionID), null);
  group.postMessage(oldParent, message('old group excludes restored'));
  assert.equal(restored.getMailbox().count(), 1);
});

test('C008-01 C021-01 transfer preserves child resources and changes later recursive control', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const a = await Agent.create(ctx, profile('a'), null); const b = await Agent.create(ctx, profile('b'), null);
  const child = await Agent.create(ctx, profile('child'), a);
  const native = host.native(child); const mailbox = child.getMailbox(); const identity = child.getProfile();
  host.status(child, 'running');
  a.transfer(child, b);
  assert.equal(child.getParent(), b); assert.deepEqual(a.getChildren(), []); assert.deepEqual(b.getChildren(), [child]);
  assert.equal(host.native(child), native); assert.equal(child.getMailbox(), mailbox); assert.equal(child.getProfile(), identity);
  assert.equal(child.getStatus(), 'running'); assert.equal(host.created.length, 3);
  await a.recvSignal('SIGKILL'); assert.equal(child.getStatus(), 'running');
  await b.recvSignal('SIGTERM'); assert.equal(child.getStatus(), 'terminated');
  assert.equal(host.releases.find(r => r.agent === native)?.mode, 'after-turn');
});

test('C008-02 invalid transfers are atomic and a transfer to the current parent is a no-op', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const a = await Agent.create(ctx, profile('a'), null); const child = await Agent.create(ctx, profile('child'), a);
  const grand = await Agent.create(ctx, profile('grand'), child); const other = await Agent.create(ctx, profile('other'), null);
  const foreign = environment(); t.after(() => foreign.ctx.dispose());
  const alien = await Agent.create(foreign.ctx, profile('alien'), null);
  a.transfer(child, a); assert.deepEqual(a.getChildren(), [child]);
  for (const action of [() => other.transfer(child, a), () => a.transfer(child, child), () => a.transfer(child, grand), () => a.transfer(child, alien)]) {
    assert.throws(action); assert.equal(child.getParent(), a); assert.deepEqual(a.getChildren(), [child]); assert.deepEqual(child.getChildren(), [grand]);
  }
  await other.recvSignal('SIGKILL'); assert.throws(() => a.transfer(child, other));
  assert.equal(child.getParent(), a); assert.equal(host.created.length, 4);
});

test('C009-01 C021-01 C021-02 logical termination immediately cancels wait, exits groups and recursively merges KILL', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const root = await Agent.create(ctx, profile('root'), null); const child = await Agent.create(ctx, profile('child'), root);
  const grand = await Agent.create(ctx, profile('grand'), child); const peer = await Agent.create(ctx, profile('peer'), null);
  const group = new Group(ctx, [root, peer]);
  root.wait(() => false, 60_000);
  const childGate = deferred(); const grandGate = deferred();
  host.closeGates.set(host.native(child), childGate); host.closeGates.set(host.native(grand), grandGate);
  const term = root.recvSignal('SIGTERM');
  assert.deepEqual([root, child, grand].map(a => a.getStatus()), ['terminated', 'terminated', 'terminated']);
  assert.equal(root.hasPendingWait(), false);
  assert.deepEqual(host.releases.map(r => r.mode), ['after-turn', 'after-turn', 'after-turn']);
  assert.throws(() => group.postMessage(root, message('exited')));
  assert.equal(peer.getStatus(), 'idle');
  await flush();
  const kill = root.recvSignal('SIGKILL');
  assert.equal(host.releases.some(r => r.agent === host.native(child) && r.mode === 'immediate'), true);
  assert.equal(host.releases.some(r => r.agent === host.native(grand) && r.mode === 'immediate'), true);
  const sends = host.sent.length;
  assert.throws(() => root.recvMessage(message('late')));
  host.turnEnd(root); await flush(); assert.equal(host.sent.length, sends);
  childGate.resolve(); grandGate.resolve(); await Promise.all([term, kill]);
});

test('C004-02 C009-01 terminating idle, running and waiting changes logical state before backend cleanup', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  for (const initial of ['idle', 'running', 'waiting'] as const) {
    const a = await Agent.create(ctx, profile(initial), null);
    if (initial === 'running') host.status(a, 'running');
    if (initial === 'waiting') a.wait(() => false, 50_000);
    const gate = deferred(); host.closeGates.set(host.native(a), gate);
    const release = a.recvSignal('SIGTERM');
    assert.equal(a.getStatus(), 'terminated'); assert.equal(a.hasPendingWait(), false);
    assert.equal(host.getStatus(host.native(a)), initial === 'running' ? 'running' : 'idle');
    assert.throws(() => a.wait(() => false, 100));
    gate.resolve(); await release;
  }
});

test('C021-01 kill rejects non-direct targets without terminating them', async t => {
  const { ctx } = environment(); t.after(() => ctx.dispose());
  const a = await Agent.create(ctx, profile('a'), null); const b = await Agent.create(ctx, profile('b'), null);
  const child = await Agent.create(ctx, profile('child'), a); const grand = await Agent.create(ctx, profile('grand'), child);
  await assert.rejects(a.kill(b)); await assert.rejects(a.kill(grand));
  assert.equal(b.getStatus(), 'idle'); assert.equal(grand.getStatus(), 'idle');
  await a.kill(child); assert.equal(child.getStatus(), 'terminated'); assert.equal(grand.getStatus(), 'terminated');
});

test('C005-01 C005-02 publication observer sees a complete child and reentrant parent termination rolls it back', async t => {
  const { observeCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const parent = await Agent.create(ctx, profile('parent'), null);
  let seen: Agent | undefined;
  let publication: unknown;
  const unsubscribe = observeCore(ctx, event => {
    if (event.type !== 'agent-created' || event.agent.getProfile().sessionID !== 'child') return;
    seen = event.agent;
    publication = { registered: ctx.getAgent(sessionID('child')) === event.agent, mailboxRegistered: ctx.has(event.agent.getMailbox()), parent: event.agent.getParent() === parent, parentContains: parent.getChildren().includes(event.agent), subscriptions: host.listeners.get(host.native(event.agent))?.size };
    void parent.recvSignal('SIGKILL');
  });
  t.after(unsubscribe);
  await assert.rejects(Agent.create(ctx, profile('child'), parent));
  assert.deepEqual(publication, { registered: true, mailboxRegistered: true, parent: true, parentContains: true, subscriptions: 1 });
  assert.ok(seen); assert.equal(seen.getStatus(), 'terminated');
  assert.equal(ctx.getAgent(sessionID('child')), null); assert.equal(ctx.has(seen.getMailbox()), false);
});

test('C008-01 reentrant transfer observer sees all three tree references committed together', async t => {
  const { observeCore } = await import('../../../packages/dsh-flow/src/core/observation.js');
  const { ctx } = environment(); t.after(() => ctx.dispose());
  const a = await Agent.create(ctx, profile('a'), null); const b = await Agent.create(ctx, profile('b'), null);
  const child = await Agent.create(ctx, profile('child'), a);
  let observed: unknown;
  t.after(observeCore(ctx, event => {
    if (event.type !== 'agent-parent') return;
    observed = { parent: child.getParent() === b, previous: a.getChildren(), current: b.getChildren() };
  }));
  a.transfer(child, b); assert.deepEqual(observed, { parent: true, previous: [], current: [child] });
});

test('C005-02 initializing candidate termination still cleans a HostAgent returned after the first close completed', async t => {
  const { ctx, host } = environment(); t.after(() => ctx.dispose());
  const initialize = deferred(); const entered = deferred(); const cleanup = deferred();
  let candidate: Agent | undefined;
  let earlyTermination: Promise<void> | undefined;
  host.createHook = flow => {
    candidate = flow; earlyTermination = flow.recvSignal('SIGTERM');
    entered.resolve(); return initialize.promise;
  };
  host.releaseHook = native => host.closeGates.set(native, cleanup);
  let rejected = false;
  const creating = Agent.create(ctx, profile('terminated-during-init'), null);
  void creating.catch(() => { rejected = true; });
  await entered.promise; await earlyTermination;
  assert.equal(candidate!.getStatus(), 'terminated'); assert.equal(host.created.length, 0);
  initialize.resolve(); await flush();
  assert.equal(rejected, false); assert.equal(host.releases.length, 1);
  assert.equal(host.releases[0]!.agent, host.native(candidate!));
  assert.equal(ctx.getAgent(sessionID('terminated-during-init')), null);
  cleanup.resolve(); await assert.rejects(creating);
  assert.equal(host.listeners.get(host.native(candidate!))?.size ?? 0, 0);
  assert.equal(ctx.has(candidate!.getMailbox()), false);
});
