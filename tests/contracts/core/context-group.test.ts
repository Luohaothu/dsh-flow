import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Context, Group, Mailbox } from '../../../packages/dsh-flow/src/core/index.js';
import { ContractHost, deferred, flush, message, profile } from '../../helpers/contract-host.js';

async function setup() {
  const ctx = new Context(); const host = new ContractHost(); ctx.registerHostAdaptor(host);
  const a = await Agent.create(ctx, profile('a'), null); const b = await Agent.create(ctx, profile('b'), null);
  const c = await Agent.create(ctx, profile('c'), null);
  return { ctx, host, a, b, c };
}

test('C027-01 C027-03 Context borrows host identity, binds one adaptor and returns copied lists', async () => {
  const ctx = new Context(); const host = new ContractHost();
  assert.throws(() => ctx.getHostAdaptor());
  await assert.rejects(Agent.create(ctx, profile('early'), null));
  await assert.rejects(Agent.resume(ctx, null, sessionID('missing')));
  ctx.registerHostAdaptor(host); ctx.registerHostAdaptor(host);
  assert.equal(ctx.getHostAdaptor(), host); assert.equal(ctx.getHostContext(), host.host);
  assert.throws(() => ctx.registerHostAdaptor(new ContractHost()));
  const a = await Agent.create(ctx, profile('a'), null);
  const copy = ctx.list(); copy.length = 0;
  assert.equal(ctx.has(a), true); assert.equal(ctx.has(a.getMailbox()), true);
  assert.deepEqual(ctx.list(obj => obj === a), [a]);
  assert.equal(ctx.list().includes(host.host), true); assert.equal(ctx.list().includes(host), true);
  await ctx.dispose(); assert.throws(() => ctx.getHostAdaptor());
  assert.deepEqual(host.host, { backendContext: 'borrowed host identity' });
});

test('C027-02 duplicate object registration is idempotent; foreign and duplicate session registration roll back', async t => {
  const { ctx, host, a } = await setup(); t.after(() => ctx.dispose());
  const before = ctx.list().length; ctx.register(a); ctx.register(a.getMailbox());
  assert.equal(ctx.list().length, before);
  const other = new Context(); const otherHost = new ContractHost(); other.registerHostAdaptor(otherHost); t.after(() => other.dispose());
  assert.throws(() => other.register(a)); assert.throws(() => other.register(a.getMailbox()));
  assert.equal(other.getAgent(sessionID('a')), null);
  await assert.rejects(Agent.create(ctx, profile('a'), null));
  assert.equal(ctx.getAgent(sessionID('a')), a); assert.equal(ctx.list().length, before);
  assert.equal(host.created.length, 4);
});

test('C001-02 C027-03 C028-02 release hides objects immediately and repeats share the pending aggregate', async () => {
  const { ctx, host, a } = await setup();
  const gate = deferred(); host.closeGates.set(host.native(a), gate);
  const first = ctx.release(a); const repeated = ctx.release(a);
  assert.equal(first, repeated);
  assert.equal(ctx.has(a), false); assert.equal(ctx.getAgent(a.getProfile().sessionID), null);
  assert.equal(ctx.list().includes(a), false);
  assert.throws(() => ctx.register(a));
  gate.resolve(); await first; assert.equal(ctx.has(a.getMailbox()), false);
  assert.equal(ctx.release(a), first);
  const mailboxClose = ctx.release(a.getMailbox()); await mailboxClose;
  assert.equal(ctx.release(a.getMailbox()), mailboxClose);
  assert.throws(() => a.getMailbox().put(message('after release')));
  assert.throws(() => a.getMailbox().setFilters([]));
  assert.throws(() => a.getMailbox().setSourcePriority({ kind: 'user' }, 'high'));
  assert.throws(() => a.recvMessage(message('after release')));
  await assert.rejects(a.fork());
  await assert.rejects(ctx.release(new Mailbox()));
  await ctx.dispose(); await assert.rejects(Agent.create(ctx, profile('closed'), null));
  assert.throws(() => ctx.register(new Mailbox()));
});

test('C028-01 termination observers run synchronously once; reentrancy and exceptions cannot undo termination', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const gate = deferred(); host.closeGates.set(host.native(a), gate);
  const seen: Agent[] = [];
  ctx.onAgentTerminated(agent => {
    assert.equal(agent.getStatus(), 'terminated'); seen.push(agent);
    if (agent === a) { void a.recvSignal('SIGKILL'); throw new Error('observer failure'); }
  });
  let removedCount = 0; const unsubscribe = ctx.onAgentTerminated(() => { removedCount++; });
  unsubscribe();
  const release = a.recvSignal('SIGTERM');
  assert.deepEqual(seen, [a]); assert.equal(removedCount, 0);
  let late = 0; ctx.onAgentTerminated(() => { late++; });
  assert.equal(late, 0);
  void a.recvSignal('SIGTERM'); assert.deepEqual(seen, [a]);
  await b.recvSignal('SIGTERM'); assert.deepEqual(seen, [a, b]); assert.equal(late, 1);
  gate.resolve(); await release;
});

test('C010-02 C021-02 C028-03 Core release aggregates actual pending backend boundary promises', async () => {
  const { ctx, host, a, b } = await setup();
  const child = await Agent.create(ctx, profile('child'), a);
  const gates = new Map(host.created.map(({ agent }) => [agent, deferred()]));
  for (const [agent, gate] of gates) host.closeGates.set(agent, gate);
  const first = ctx.dispose(); const repeated = ctx.dispose();
  assert.equal(first, repeated); assert.equal(host.disposed, false);
  assert.equal(host.releases.filter(r => r.mode === 'after-turn').length, 4);
  assert.deepEqual([a, b, child].map(item => item.getStatus()), ['terminated', 'terminated', 'terminated']);
  let complete = false; void first.then(() => { complete = true; });
  for (const [agent, gate] of gates) if (agent !== host.native(child)) gate.resolve();
  await flush(); assert.equal(complete, false); assert.equal(host.disposed, false);
  const killed = child.recvSignal('SIGKILL');
  gates.get(host.native(child))!.resolve(); await Promise.all([first, killed]);
  assert.equal(host.disposeCount, 1); assert.equal(complete, true);
});

test('C010-03 C028-03 backend close rejection prevents dependent adaptor disposal and is preserved on repetition', async () => {
  const { ctx, host, a } = await setup();
  const gate = deferred(); host.closeGates.set(host.native(a), gate);
  const first = ctx.dispose(); const repeated = ctx.dispose();
  const failure = new Error('abandoned backend cleanup');
  const containsFailure = (error: unknown): boolean => error === failure || (error instanceof AggregateError && error.errors.some(containsFailure));
  const failed = assert.rejects(first, containsFailure);
  assert.equal(first, repeated);
  gate.reject(failure); await failed;
  assert.equal(host.disposed, false);
  await assert.rejects(ctx.dispose(), containsFailure);
});

test('C001-01 C022-01 C023-01 Group fixes member containers and synchronously delivers source objects to peers', async t => {
  const { ctx, a, b, c } = await setup(); t.after(() => ctx.dispose());
  const members = [a, b]; const group = new Group(ctx, members); members.splice(0, 2, c);
  assert.equal(ctx.getGroup(group.getID()), group);
  assert.notEqual(group.getID(), new Group(ctx, [a, b]).getID());
  group.postMessage(a, message('hello'));
  assert.equal(a.getMailbox().count(), 0); assert.equal(b.getMailbox().count(), 1); assert.equal(c.getMailbox().count(), 0);
  assert.deepEqual(b.getMailbox().query()[0]!.source, { agent: a, g: group });
  assert.throws(() => group.postMessage(c, message('intruder')));
});

test('C022-01 Group refuses cross-Context, terminated and initializing members without leaking registration', async t => {
  const { ctx, host, a, b } = await setup(); t.after(() => ctx.dispose());
  const other = new Context(); other.registerHostAdaptor(new ContractHost()); t.after(() => other.dispose());
  const alien = await Agent.create(other, profile('alien'), null);
  const before = ctx.list().filter(obj => obj instanceof Group).length;
  assert.throws(() => new Group(ctx, [a, alien]));
  await b.recvSignal('SIGKILL'); assert.throws(() => new Group(ctx, [a, b]));
  host.createHook = flow => { assert.throws(() => new Group(ctx, [a, flow])); };
  await Agent.create(ctx, profile('initializing'), null);
  assert.equal(ctx.list().filter(obj => obj instanceof Group).length, before);
});

test('C022-02 C022-03 terminated members leave groups; dissolution preserves received historical messages', async t => {
  const { ctx, a, b, c } = await setup(); t.after(() => ctx.dispose());
  const g1 = new Group(ctx, [a, b]); const g2 = new Group(ctx, [a, c]);
  g1.postMessage(a, message('historical'));
  const id = b.getMailbox().query()[0]!.id;
  await a.recvSignal('SIGTERM');
  assert.throws(() => g1.postMessage(a, message('former member')));
  assert.throws(() => g2.postToBlackboard(a, message('former member')));
  assert.equal(b.getStatus(), 'running'); assert.equal(c.getStatus(), 'idle');
  g1.postToBlackboard(b, message('surviving group'));
  assert.equal(g1.readBlackboard().length, 1);
  const groupClose = ctx.release(g1); assert.equal(ctx.release(g1), groupClose);
  await groupClose; assert.equal(ctx.release(g1), groupClose);
  assert.throws(() => g1.postMessage(b, message('dissolved')));
  assert.throws(() => g1.postToBlackboard(b, message('dissolved')));
  assert.throws(() => g1.readBlackboard()); assert.throws(() => g1.hasNewMsgOnboard(0));
  assert.deepEqual(b.getMailbox().get(id)?.source, { agent: a, g: g1 });
  assert.equal(ctx.getGroup(g1.getID()), null);
});

test('C023-02 C023-03 blackboard assigns increasing timestamps and isolates snapshots without Mailbox delivery', async t => {
  const { ctx, a, b, c } = await setup(); t.after(() => ctx.dispose());
  const g = new Group(ctx, [a, b]);
  const payload = { nested: { text: 'original' } };
  const m = message('first', a, 9_999_999_999, payload); m.read = true; m.read_timestamp = 1;
  g.postToBlackboard(a, m); g.postToBlackboard(b, message('second', b, 0));
  payload.nested.text = 'mutated';
  const rows = g.readBlackboard();
  assert.equal(rows.length, 2); assert.ok(rows[1]!.timestamp > rows[0]!.timestamp);
  assert.deepEqual(rows[0]!.payload, { nested: { text: 'original' } });
  Reflect.set(rows[0]!.payload as object, 'nested', { text: 'read mutation' });
  assert.deepEqual(g.readBlackboard()[0]!.payload, { nested: { text: 'original' } });
  assert.deepEqual(g.readBlackboard(rows[0]!.timestamp).map(m => m.summary), ['second']);
  assert.equal(g.hasNewMsgOnboard(rows[0]!.timestamp), true); assert.equal(g.hasNewMsgOnboard(rows[1]!.timestamp), false);
  assert.equal(a.getMailbox().count(), 0); assert.equal(b.getMailbox().count(), 0);
  assert.throws(() => g.postToBlackboard(c, message('intruder')));
});

test('C023-01 a throwing first recipient cannot prevent other members in the captured group snapshot receiving', async t => {
  const { ctx, a, b, c } = await setup(); t.after(() => ctx.dispose());
  const group = new Group(ctx, [a, b, c]);
  b.getMailbox().setFilters([() => { throw new Error('recipient filter failed'); }]);
  try { group.postMessage(a, message('snapshot delivery')); } catch {}
  assert.equal(a.getMailbox().count(), 0); assert.equal(b.getMailbox().count(), 0);
  assert.equal(c.getMailbox().count(), 1);
  assert.deepEqual(c.getMailbox().query()[0]!.source, { agent: a, g: group });
  assert.equal(c.getMailbox().query()[0]!.summary, 'snapshot delivery');
});
