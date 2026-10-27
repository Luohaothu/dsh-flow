import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context, Group } from '../../../packages/dsh-flow/src/core/index.js';
import { assertNoPendingConstruction, beginConstruction } from '../../../packages/dsh-flow/src/core/construction.js';
import { agentControl, contextControl, createOwned } from '../../../packages/dsh-flow/src/core/internals.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { ContractHost, deferred, flush, message, profile } from '../../helpers/contract-host.js';

async function setup() {
  const context = new Context(); const host = new ContractHost(); context.registerHostAdaptor(host);
  const root = await Agent.create(context, profile('root'), null);
  const existing = await Agent.create(context, profile('existing'), root);
  return { context, host, root, existing };
}

test('construction hides resources and rejects direct Core and leaked Mailbox business until commit', async t => {
  const { context, host, root, existing } = await setup(); t.after(() => context.dispose());
  const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root);
  const leaf = await Agent[createOwned](scope, profile('leaf'), child);
  const group = Group[createOwned](scope, [root, child, leaf]);
  assert.equal(context.has(child), false); assert.equal(context.has(child.getMailbox()), false);
  assert.equal(context.getAgent(child.getProfile().sessionID), null); assert.equal(context.getGroup(group.getID()), null);
  const examined: object[] = []; context.list(object => { examined.push(object); return true; });
  assert.equal(examined.includes(child), false); assert.deepEqual(root.getChildren(), [existing]);
  assert.deepEqual(child.getChildren(), []); assert.equal(leaf.getParent(), null);
  await assert.rejects(Agent.create(context, profile('intruder'), child));
  await assert.rejects(Agent.resume(context, child, root.getProfile().sessionID));
  await assert.rejects(child.fork()); await assert.rejects(root.herb(child));
  assert.throws(() => root.transfer(existing, child)); assert.throws(() => root.transfer(child, existing));
  assert.throws(() => context.register(child)); assert.throws(() => new Group(context, [root, child]));
  assert.throws(() => child.recvMessage(message('input'))); assert.throws(() => existing.recvMessage(message('source', child)));
  assert.throws(() => existing.recvMessage(message('group source', { agent: root, g: group })));
  assert.throws(() => child.wait(() => false, 100)); assert.throws(() => child.joinGroup(group)); assert.throws(() => root.quitGroup(group));
  assert.throws(() => group.postToBlackboard(root, message('board'))); assert.throws(() => group.readBlackboard());
  const box = child.getMailbox();
  for (const action of [() => box.put(message('box')), () => box.query(), () => box.count(), () => box.getUnread(), () => box.getLastUnread(), () => box.setFilters([]), () => box.getFilters(), () => box.setSourcePriority(root, 'high'), () => box.getSourcePriority(root)]) assert.throws(action);
  assert.throws(() => existing.getMailbox().setSourcePriority(child, 'high'));
  assert.throws(() => assertNoPendingConstruction(child)); assert.equal(host.sent.length, 0);
  const events: string[] = []; t.after(observeCore(context, event => { events.push(event.type); }));
  const drain = scope.commit(); assert.equal(context.has(child), true); assert.equal(events.length, 0); drain(); drain();
  assert.deepEqual(events, ['agent-created', 'agent-created', 'group-created']);
  assert.deepEqual(root.getChildren(), [existing, child]); assert.equal(leaf.getParent(), child); assert.doesNotThrow(() => box.query());
});

test('construction claims objects before host hooks and publication; abort never releases existing agents', async t => {
  const { context, host, root, existing } = await setup(); t.after(() => context.dispose());
  const scope = beginConstruction(context, root); const gate = deferred(); let leaked!: Agent;
  host.createHook = flow => { leaked = flow; assert.throws(() => flow.getMailbox().query()); assert.throws(() => context.register(flow.getMailbox())); return gate.promise; };
  const creating = Agent[createOwned](scope, profile('late'), root); const failed = assert.rejects(creating);
  assert.throws(() => existing.recvMessage(message('leaked source', leaked)));
  const abort = scope.abort(); assert.equal(scope.abort(), abort); let done = false; void abort.then(() => { done = true; });
  await flush(); assert.equal(done, false); gate.resolve(); await Promise.all([abort, failed]);
  assert.equal(host.releases.some(record => record.mode === 'immediate'), true);
  assert.equal(existing.getStatus(), 'idle'); assert.equal(root.getStatus(), 'idle'); assert.throws(() => scope.commit());
  assert.throws(() => leaked.getMailbox().query());
});

test('construction commit fixes success before observers can terminate the tree; historical events retain order', async () => {
  const { context, root } = await setup(); const scope = beginConstruction(context, root);
  const one = await Agent[createOwned](scope, profile('one'), root); const two = await Agent[createOwned](scope, profile('two'), one);
  const seen: Agent[] = []; const terminations: Agent[] = []; context.onAgentTerminated(agent => terminations.push(agent));
  observeCore(context, event => { if (event.type === 'agent-created') { seen.push(event.agent); if (event.agent === one) void root.recvSignal('SIGKILL'); } });
  const drain = scope.commit(); let resolved = false; const result = Promise.resolve([one, two]).then(value => { resolved = true; return value; });
  drain(); assert.equal(resolved, false); assert.deepEqual(seen, [one, two]); assert.equal(terminations.includes(two), true);
  assert.deepEqual(await result, [one, two]); await scope.abort(); await context.dispose();
});

test('construction root termination rejects commit and raw dispose sees hidden resources and late initialization', async () => {
  const { context, host, root } = await setup(); const scope = beginConstruction(context, root);
  const ready = await Agent[createOwned](scope, profile('ready'), root); Group[createOwned](scope, [root, ready]);
  const gate = deferred(); host.createHook = () => gate.promise;
  const creating = Agent[createOwned](scope, profile('late'), ready); const failed = assert.rejects(creating);
  const disposing = context.dispose(); let disposed = false; void disposing.then(() => { disposed = true; });
  assert.equal(ready.getStatus(), 'terminated'); assert.throws(() => scope.commit());
  await flush(); assert.equal(disposed, false); gate.resolve(); await Promise.all([failed, scope.abort(), disposing]); assert.equal(host.disposeCount, 1);
});

test('construction abort removes raw Group registration and shares its Promise during backend reentry', async t => {
  const { context, host, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root); const group = Group[createOwned](scope, [root, child]);
  let reentered: Promise<void> | undefined;
  host.releaseHook = () => { if (!reentered) { reentered = Promise.resolve(); reentered = scope.abort(); } };
  const abort = scope.abort(); await flush(); assert.equal(reentered, abort); await abort;
  assert.equal(context[contextControl].registered(group), false);
});

test('construction abort includes a late backend cleanup rejection and preserves failed ownership', async () => {
  const { context, host, root } = await setup(); const scope = beginConstruction(context, root);
  const initialize = deferred(); const cleanup = deferred(); const failure = new Error('late cleanup failed'); let leaked!: Agent;
  host.createHook = flow => { leaked = flow; return initialize.promise; };
  host.releaseHook = native => host.closeGates.set(native, cleanup);
  const creating = Agent[createOwned](scope, profile('late-failure'), root); const failed = assert.rejects(creating);
  const abort = scope.abort(); const aborted = assert.rejects(abort, error => error instanceof AggregateError && error.errors.some(item => item.cause === failure));
  initialize.resolve(); await flush(); cleanup.reject(failure); await Promise.all([failed, aborted]);
  assert.throws(() => assertNoPendingConstruction(leaked)); await assert.rejects(context.dispose());
});

test('public initial input refuses an uncommitted source before backend creation', async t => {
  const { context, host, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root); const before = host.created.length;
  await assert.rejects(Agent.create(context, profile('source-intrusion'), root, message('source', child)));
  assert.equal(host.created.length, before); assert.equal(host.sent.length, 0); await scope.abort();
});


test('construction abort Promise is installed before synchronous backend cleanup callbacks', async t => {
  const { context, host, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  await Agent[createOwned](scope, profile('child'), root);
  let reentered: Promise<void> | undefined;
  host.releaseHook = () => { if (!reentered) { reentered = Promise.resolve(); reentered = scope.abort(); } };
  const abort = scope.abort(); assert.equal(reentered, abort); await abort;
});

test('owned Group rolls back every association when a member joins then throws', async t => {
  const { context, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root);
  const control = child[agentControl]; const join = control.join; const leave = control.leave; let removed = 0;
  control.join = (group, owner) => { join(group, owner); throw new Error('association failed after mutation'); };
  control.leave = group => { removed++; leave(group); };
  assert.throws(() => Group[createOwned](scope, [root, child]), /association failed/);
  assert.equal(removed, 1); control.join = join; control.leave = leave; await scope.abort();
});

test('construction initialization rejection closes its unregistered Mailbox without a fake host release', async t => {
  const { context, host, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root); let candidate!: Agent;
  host.createHook = flow => { candidate = flow; throw new Error('initialization rejected'); };
  await assert.rejects(Agent[createOwned](scope, profile('rejected'), root), /initialization rejected/);
  await scope.abort(); assert.equal(host.releases.length, 0); assert.throws(() => candidate.getMailbox().query());
  assert.equal(candidate.getStatus(), 'terminated'); assert.deepEqual(root.getChildren().map(item => item.getProfile().name), ['existing']);
});

test('owned direct kill bypasses pending and later SIGKILL upgrades the same release Promise', async t => {
  const { context, host, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root); const close = deferred(); host.closeGates.set(host.native(child), close);
  const first = root.kill(child); const second = child.recvSignal('SIGKILL'); assert.equal(first, second);
  assert.deepEqual(host.releases.map(record => record.mode), ['after-turn', 'immediate']);
  assert.throws(() => scope.commit()); const abort = scope.abort(); close.resolve(); await Promise.all([first, second, abort]);
});

test('commit never invokes replaceable public status queries while clearing ownership', async t => {
  const { context, root } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root);
  const child = await Agent[createOwned](scope, profile('child'), root); let queries = 0;
  child.getStatus = () => { queries++; void root.recvSignal('SIGKILL'); return 'idle'; };
  const drain = scope.commit(); assert.equal(queries, 0); assert.equal(context.has(child), true); drain();
});

test('construction hides a bound candidate during subscription and raw publication hooks', async t => {
  const { context, host, root, existing } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root); let hooks = 0;
  host.subscribeHook = native => {
    const flow = host.created.find(record => record.agent === native)!.flow; hooks++;
    assert.throws(() => flow.getMailbox().query()); assert.equal(context.getAgent(native.profile.sessionID), null);
    assert.throws(() => existing.recvMessage(message('before publication', flow)));
  };
  const publish = context[contextControl].publish;
  context[contextControl].publish = (...args) => {
    publish(...args); hooks++; const [agent, mailbox] = args;
    assert.equal(context.has(agent), false); assert.equal(context.has(mailbox), false); assert.deepEqual(root.getChildren(), [existing]);
    assert.throws(() => mailbox.setFilters([])); assert.throws(() => root.transfer(existing, agent));
  };
  await Agent[createOwned](scope, profile('hooked'), root); assert.equal(hooks, 2); await scope.abort();
});

test('pending-only source checks preserve messages and ratings from terminated historical identities', async t => {
  const { context, root, existing } = await setup(); t.after(() => context.dispose()); const group = new Group(context, [root, existing]);
  await existing.recvSignal('SIGTERM'); await context.release(group);
  root.getMailbox().setSourcePriority(existing, 'high'); root.recvMessage(message('history', existing));
  root.recvMessage(message('group history', { agent: existing, g: group }));
  assert.equal(root.getMailbox().count(), 2); assert.equal(root.getMailbox().getSourcePriority(existing), 'high');
});

test('construction never adopts an existing member even through an owned factory', async t => {
  const { context, host, root, existing } = await setup(); t.after(() => context.dispose()); const scope = beginConstruction(context, root); const before = host.created.length;
  await assert.rejects(Agent[createOwned](scope, profile('foreign-child'), existing));
  assert.throws(() => Group[createOwned](scope, [root, existing])); await scope.abort();
  assert.equal(host.created.length, before); assert.equal(existing.getParent(), root); assert.equal(existing.getStatus(), 'idle');
});
