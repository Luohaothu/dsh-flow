/**
 * The plugin lifecycle against a real Cordis context.
 *
 * These tests assert the contract a deployment observes:
 *
 *  - a missing required service leaves the plugin PENDING — no `flow` service,
 *    no Consumer started, nothing written to disk;
 *  - once every dependency is live and recovery has finished, the service is
 *    published once and answers;
 *  - a recovery failure never publishes a usable service;
 *  - unloading a dependency (or the plugin) aborts this plugin's live turns,
 *    refuses their late results, stops its timers and releases its listeners,
 *    and a fresh instance then opens the same database and recovers it.
 *
 * Nothing here simulates Fiber state: the context is `new Context()` and the
 * plugin is mounted with `ctx.plugin()`. The scripted model fixture supplies
 * the agent surface only.
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import * as plugin from '../../packages/dsh-flow/src/index.ts';
import type { Config } from '../../packages/dsh-flow/src/config.ts';
import type { FlowService } from '../../packages/dsh-flow/src/service.ts';
import type {} from '../../packages/dsh-flow/src/service.ts';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowPersistenceSeam } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { fromPartial } from '@total-typescript/shoehorn';
import { createFakeHost } from './fake-host.ts';
import type { FakeHost } from './fake-host.ts';

interface StoredSessionService {
  stat(): Promise<undefined>
  open(): Promise<never>
}

/** The durable-session service a deployment would mount; this one has no sessions. */
function sessionPersistenceStub(): StoredSessionService {
  return {
    stat: async () => undefined,
    open: async () => { throw new Error('the lifecycle fixture has no stored sessions'); },
  };
}

/** A real Service provider makes Cordis proxy the dependency on every access. */
class ProxySessionPersistence extends Service implements StoredSessionService {
  readonly stat: () => Promise<undefined>;
  readonly open: () => Promise<never>;

  constructor(ctx: Context, stub: StoredSessionService) {
    super(ctx, 'sessionPersistence');
    // Cordis invokes methods with a shadow receiver; capture the scripted seam
    // instead of requiring a private-field brand on that receiver.
    this.stat = () => stub.stat();
    this.open = () => stub.open();
  }

}

test('a Service-backed persistence dependency publishes flow after recovery through Cordis proxies', async t => {
  const dir = tempDir(t, 'dsh-flow-proxy-dependency-');
  const fixture = createFakeHost({ persistence: null });
  t.after(() => fixture.dispose());
  const persistence = fixture.ctx.plugin({
    name: 'proxy-session-persistence',
    apply(ctx: Context) { new ProxySessionPersistence(ctx, sessionPersistenceStub()); },
  });
  t.after(() => persistence.dispose());
  await persistence.await();

  let consumerRuns = 0;
  fixture.ctx.plugin({
    name: 'proxy-flow-consumer', inject: ['flow'],
    apply(ctx: Context) {
      assert.deepEqual(ctx.flow.list({}), { clusters: [] }, 'the injected service answers');
      consumerRuns += 1;
    },
  });
  const fiber = fixture.ctx.plugin(plugin, pluginConfig(join(dir, 'data')));
  t.after(() => fiber.dispose());
  await fiber.await();
  await settle();

  const flow = flowOf(fixture.ctx);
  assert.ok(flow, 'recovery publishes flow with a proxy-wrapped persistence provider');
  assert.deepEqual(flow.list({}), { clusters: [] });
  assert.equal(consumerRuns, 1, 'the Consumer activates once recovery completes');
});

/** One temporary directory, removed when the test ends. */
function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Let every queued microtask and timer callback run. */
async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await setImmediate();
}

/**
 * A real delay. The scheduler under test is a platform `setInterval`, so
 * "the timer stopped firing" can only be observed against the real clock;
 * deterministic time control would remove the very behaviour under test.
 */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Poll until `check` holds, or give up. */
async function waitFor(check: () => boolean, { attempts = 400, delayMs = 5 } = {}): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return true;
    // eslint-disable-next-line no-await-in-loop
    await delay(delayMs);
  }
  return check();
}

function pluginConfig(dataDir: string): Config {
  return { dataDir, provider: 'local-fake', model: 'fake-model', maxTokens: 512, tickMs: 60_000 };
}

const flowOf = (ctx: Context): FlowService | undefined => ctx.get('flow');

test('a missing sessionPersistence leaves the plugin PENDING: no service, no Consumer, no database', async t => {
  const dir = tempDir(t, 'dsh-flow-lifecycle-pending-');
  const fixture: FakeHost = createFakeHost({ persistence: null });
  t.after(() => fixture.dispose());

  let consumerRuns = 0;
  fixture.ctx.plugin({ name: 'flow-consumer', inject: ['flow'], apply() { consumerRuns += 1; } });
  const fiber = fixture.ctx.plugin(plugin, pluginConfig(join(dir, 'data')));
  t.after(() => fiber.dispose());
  await settle();

  assert.equal(flowOf(fixture.ctx), undefined, 'no service is published while a dependency is missing');
  assert.equal(consumerRuns, 0, 'a Consumer that injects flow does not start');
  assert.equal(existsSync(join(dir, 'data')), false, 'a PENDING plugin creates nothing on disk');

  const stop = fixture.ctx.provide('sessionPersistence', sessionPersistenceStub());
  t.after(() => stop());
  assert.equal(await waitFor(() => flowOf(fixture.ctx) !== undefined), true, 'the service appears once the dependency is live');
  await settle();
  assert.equal(consumerRuns, 1, 'the Consumer starts exactly once');
  const flow = flowOf(fixture.ctx);
  assert.ok(flow);
  assert.deepEqual(flow.list({}), { clusters: [] }, 'the published service answers');
});

test('a recovery failure never publishes a usable service', async t => {
  const dir = tempDir(t, 'dsh-flow-lifecycle-failure-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  // Recovery only proves the sessions of clusters that already exist, so a
  // persisted open cluster is what makes the proof pass run at all.
  const seedHost = createFakeHost();
  const seed = new ClusterRuntime(seedHost.ctx, { path: join(dataDir, 'cluster.sqlite'), dataDir, autoTick: false });
  seed.start({ id: 'seed-cluster', objective: 'persisted work', workspace: dir, capabilities: [], budget: { tokens: 100_000, model_requests: 20, tool_calls: 100, agents: 16, max_active_agents: 4, wall_time_ms: 60_000 } });
  await seed.dispose();
  t.after(() => seedHost.dispose());

  const fixture = createFakeHost();
  t.after(() => fixture.dispose());

  const failure = new Error('unexpected session-proof failure');
  t.mock.method(ClusterRuntime.prototype, 'proveSessions', async () => { throw failure; });

  let consumerRuns = 0;
  fixture.ctx.plugin({ name: 'flow-consumer', inject: ['flow'], apply() { consumerRuns += 1; } });
  const fiber = fixture.ctx.plugin(plugin, pluginConfig(dataDir));
  t.after(() => fiber.dispose());
  await assert.rejects(fiber.await(), error => error === failure);

  assert.equal(flowOf(fixture.ctx), undefined, 'a failed recovery must not publish the service');
  assert.equal(consumerRuns, 0, 'the Consumer never starts');
  assert.equal(existsSync(join(dataDir, 'cluster.sqlite')), true,
    'the store was opened before recovery failed; the disposer must have closed it');
  assert.equal(await waitFor(() => flowOf(fixture.ctx) === undefined, { attempts: 20 }), true,
    'waiting longer never flips a failed instance into a usable one');
});

test('unloading a required dependency aborts the live turn, stops the timer and releases its listener', async t => {
  const dir = tempDir(t, 'dsh-flow-lifecycle-unload-');
  const dataDir = join(dir, 'data');
  const fixture = createFakeHost({ persistence: null });
  t.after(() => fixture.dispose());

  const gate = Promise.withResolvers<void>();
  let held = 0;
  let lateResult: 'sent' | 'refused' | 'none' = 'none';
  fixture.setScript(async turn => {
    held += 1;
    await gate.promise;
    try {
      await turn.callTool('flow_query', { what: 'cluster' });
      lateResult = 'sent';
    } catch {
      lateResult = 'refused';
    }
  });

  const stop = fixture.ctx.provide('sessionPersistence', sessionPersistenceStub());
  const fiber = fixture.ctx.plugin(plugin, { ...pluginConfig(dataDir), tickMs: 10 });
  t.after(() => fiber.dispose());
  assert.equal(await waitFor(() => flowOf(fixture.ctx) !== undefined), true);
  const flow = flowOf(fixture.ctx);
  assert.ok(flow);
  const snapshot = flow.start({
    objective: 'a live turn that a dependency unload must fence',
    workspace: dir,
    capabilities: [],
    initial_transactions: [{ id: 'tx-live', objective: 'hold a turn open', status: 'DRAFT' }],
  });
  assert.equal(await waitFor(() => held > 0), true, 'a real scheduled turn is running');
  const live = fixture.turns.find(turn => turn.admitted);
  assert.ok(live, 'the admitted turn is recorded');
  assert.ok(fixture.sessionEventListeners.length > 0, 'the runtime installed its session listener');
  const turnsBefore = fixture.turns.length;

  stop();
  await fiber.await();
  assert.equal(flowOf(fixture.ctx), undefined, 'the dependency unload takes the service away');
  assert.equal(live.cancelled, true, 'the live turn is aborted');
  assert.equal(fixture.sessionEventListeners.length, 0, 'the turn listener is released');

  await delay(80);
  assert.equal(fixture.turns.length, turnsBefore, 'the scheduler timer stopped; no replacement turn was admitted');

  const database = new DatabaseSync(join(dataDir, 'cluster.sqlite'));
  const eventsBeforeLateResult = database.prepare('SELECT COUNT(*) AS count FROM events').get();
  gate.resolve();
  await settle(6);
  assert.equal(lateResult, 'refused', 'a late result cannot write to the closed database');
  assert.deepEqual(database.prepare('SELECT COUNT(*) AS count FROM events').get(), eventsBeforeLateResult,
    'a fenced late callback creates no durable event');
  database.close();

  const second = createFakeHost();
  t.after(() => second.dispose());
  const secondFiber = second.ctx.plugin(plugin, pluginConfig(dataDir));
  t.after(() => secondFiber.dispose());
  assert.equal(await waitFor(() => flowOf(second.ctx) !== undefined), true);
  const relaunched = flowOf(second.ctx);
  assert.ok(relaunched);
  const clusters = relaunched.list({}).clusters;
  assert.ok(clusters.some(cluster => cluster.id === snapshot.cluster.id),
    'a fresh instance opens the same database and recovers the cluster');
});

test('disposing the plugin itself fences the live turn while a fresh instance recovers the path', async t => {
  const dir = tempDir(t, 'dsh-flow-lifecycle-dispose-');
  const dataDir = join(dir, 'data');
  const fixture = createFakeHost();
  t.after(() => fixture.dispose());

  const gate = Promise.withResolvers<void>();
  let held = 0;
  fixture.setScript(async () => { held += 1; await gate.promise; });

  const fiber = fixture.ctx.plugin(plugin, { ...pluginConfig(dataDir), tickMs: 10 });
  assert.equal(await waitFor(() => flowOf(fixture.ctx) !== undefined), true);
  const flow = flowOf(fixture.ctx);
  assert.ok(flow);
  const snapshot = flow.start({
    objective: 'a live turn that a plugin dispose must fence',
    workspace: dir,
    capabilities: [],
    initial_transactions: [{ id: 'tx-dispose', objective: 'hold a turn open', status: 'DRAFT' }],
  });
  assert.equal(await waitFor(() => held > 0), true);
  const live = fixture.turns.find(turn => turn.admitted);
  assert.ok(live);

  await fiber.dispose();
  assert.equal(await waitFor(() => live.cancelled), true, 'disposing the plugin aborts its live turn');
  gate.resolve();
  await settle(4);

  const second = createFakeHost();
  t.after(() => second.dispose());
  const secondFiber = second.ctx.plugin(plugin, pluginConfig(dataDir));
  t.after(() => secondFiber.dispose());
  assert.equal(await waitFor(() => flowOf(second.ctx) !== undefined), true);
  const relaunched = flowOf(second.ctx);
  assert.ok(relaunched);
  assert.ok(relaunched.list({}).clusters.some(cluster => cluster.id === snapshot.cluster.id));
});

test('delayed durable-session proof gates consumers until recovery completes', { timeout: 5000 }, async t => {
  const dir = tempDir(t, 'dsh-flow-proof-gate-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const seedHost = createFakeHost();
  const seed = new ClusterRuntime(seedHost.ctx, { path: join(dataDir, 'cluster.sqlite'), autoTick: false });
  const saved = seed.start({ objective: 'persisted session proof', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 20, tool_calls: 100, agents: 16, max_active_agents: 4, wall_time_ms: 60_000 } });
  const identity = seed.store.listAgents(saved.cluster.id, {})[0];
  assert.ok(identity);
  seed.store.updateAgent(identity.id, { turns: 1, session_id: 'stored-proof-session' });
  await seed.dispose();
  await seedHost.dispose();

  const proof = Promise.withResolvers<undefined>();
  let probes = 0;
  const fixture = createFakeHost({ persistence: null });
  t.after(() => fixture.dispose());
  const persistence = fixture.ctx.plugin({
    name: 'delayed-proxy-session-persistence',
    apply(ctx: Context) {
      new ProxySessionPersistence(ctx, {
        async stat() { probes += 1; return proof.promise; },
        async open() { throw new Error('no session handle expected for this proof'); },
      });
    },
  });
  t.after(() => persistence.dispose());
  await persistence.await();
  let ready = 0;
  fixture.ctx.plugin({ name: 'proof-ready-consumer', inject: ['flow'], apply() { ready += 1; } });
  const fiber = fixture.ctx.plugin(plugin, pluginConfig(dataDir));
  t.after(() => fiber.dispose());
  assert.equal(await waitFor(() => probes > 0), true);
  assert.equal(flowOf(fixture.ctx), undefined);
  assert.equal(ready, 0, 'no consumer may announce readiness during the durable proof');
  proof.resolve(undefined);
  await fiber.await();
  assert.ok(flowOf(fixture.ctx));
  await settle();
  assert.equal(ready, 1);
});

test('unload drains an in-flight proof and discards its late completion before same-path reload', { timeout: 5000 }, async t => {
  const dir = tempDir(t, 'dsh-flow-proof-unload-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const seedHost = createFakeHost();
  const seed = new ClusterRuntime(seedHost.ctx, { path: join(dataDir, 'cluster.sqlite'), autoTick: false });
  const saved = seed.start({ objective: 'late durable proof', workspace: dir, capabilities: [],
    budget: { tokens: 100_000, model_requests: 20, tool_calls: 100, agents: 16, max_active_agents: 4, wall_time_ms: 60_000 } });
  const identity = seed.store.listAgents(saved.cluster.id, {})[0];
  assert.ok(identity);
  seed.store.updateAgent(identity.id, { turns: 1, session_id: 'late-proof-session' });
  await seed.dispose();
  await seedHost.dispose();

  const proof = Promise.withResolvers<undefined>();
  let probes = 0;
  const fixture = createFakeHost({ persistence: null });
  t.after(() => fixture.dispose());
  let holdProof = false;
  const persistence = fixture.ctx.plugin({
    name: 'unload-proxy-session-persistence',
    apply(ctx: Context) {
      new ProxySessionPersistence(ctx, {
        async stat() {
          if (!holdProof) return undefined;
          probes += 1;
          return proof.promise;
        },
        async open() { throw new Error('proof has no opened handle'); },
      });
    },
  });
  t.after(() => persistence.dispose());
  await persistence.await();
  let ready = 0;
  fixture.ctx.plugin({ name: 'late-proof-ready-consumer', inject: ['flow'], apply() { ready += 1; } });
  const fiber = fixture.ctx.plugin(plugin, { ...pluginConfig(dataDir), disposeTimeoutMs: 40 });
  t.after(() => fiber.dispose());
  await fiber.await();
  await settle();
  const active = flowOf(fixture.ctx);
  assert.ok(active instanceof ClusterRuntime, 'the real plugin publishes its runtime after initial recovery');
  assert.equal(ready, 1);
  holdProof = true;
  const recovery = active.recoverAndReconcile();
  assert.equal(await waitFor(() => probes > 0), true);
  await persistence.dispose();
  await fiber.await();
  assert.equal(flowOf(fixture.ctx), undefined);
  assert.equal(ready, 1, 'the unloaded recovery cannot announce a second ready');
  const database = new DatabaseSync(join(dataDir, 'cluster.sqlite'));
  const before = database.prepare('SELECT * FROM events ORDER BY seq').all();
  proof.resolve(undefined);
  await settle(10);
  await recovery;
  assert.deepEqual(database.prepare('SELECT * FROM events ORDER BY seq').all(), before,
    'late proof neither appends evidence nor touches the disposed store');
  database.close();
  assert.equal(ready, 1, 'a late internal recovery cannot republish the unloaded instance');
  const replacement = createFakeHost();
  t.after(() => replacement.dispose());
  const replacementFiber = replacement.ctx.plugin(plugin, pluginConfig(dataDir));
  t.after(() => replacementFiber.dispose());
  await replacementFiber.await();
  const restored = flowOf(replacement.ctx);
  assert.ok(restored);
  assert.ok(restored.list({}).clusters.some(cluster => cluster.id === saved.cluster.id));
});

for (const phase of ['stat', 'open'] as const) {
  for (const unload of ['plugin', 'dependency'] as const) {
    test(`startup ${phase} proof is interrupted by ${unload} disposal without releasing persistence`, { timeout: 5000 }, async t => {
      const dir = tempDir(t, 'dsh-flow-startup-interrupt-');
      const dataDir = join(dir, 'data');
      mkdirSync(dataDir, { recursive: true });
      const seedHost = createFakeHost();
      const seed = new ClusterRuntime(seedHost.ctx, { path: join(dataDir, 'cluster.sqlite'), autoTick: false });
      const saved = seed.start({
        objective: 'interrupt startup proof', workspace: dir, capabilities: [],
        budget: { tokens: 100_000, model_requests: 20, tool_calls: 100, agents: 16, max_active_agents: 4, wall_time_ms: 60_000 },
      });
      const identity = seed.store.listAgents(saved.cluster.id, {})[0];
      assert.ok(identity);
      seed.store.updateAgent(identity.id, { turns: 1 });
      if (phase === 'open') {
        seed.store.insertMessage({ id: 'held-proof-message', cluster_id: saved.cluster.id, kind: 'message', content: { text: 'persisted delivery' } });
        seed.store.insertRecipient('held-proof-message', identity.id);
        seed.store.markDeliveryInjected('held-proof-message', identity.id);
      }
      await seed.dispose();
      await seedHost.dispose();

      const entered = Promise.withResolvers<void>();
      const statProof = Promise.withResolvers<undefined>();
      const openProof = Promise.withResolvers<SessionHandle>();
      let reads = 0;
      const closed = Promise.withResolvers<void>();
      // Only the read/close boundary is exercised; unrelated handle metadata
      // and mutation methods remain third-party partial fixture data.
      const handle = fromPartial<SessionHandle>({
        async read() { reads += 1; return { eventState: 'detached', events: [] }; },
        async close() { closed.resolve(); },
      });
      t.after(() => { statProof.resolve(undefined); openProof.resolve(handle); });
      const fixture = createFakeHost({ persistence: null });
      t.after(() => fixture.dispose());
      let proofSignal: AbortSignal | undefined;
      const seam: FlowPersistenceSeam = {
        async stat(_id, options) {
          if (phase === 'open') throw new Error('metadata unavailable; inspect the durable log');
          proofSignal = options?.signal;
          entered.resolve();
          return statProof.promise;
        },
        async open(_id, _access, options) {
          assert.equal(phase, 'open', 'an interrupted stat must not open a session');
          proofSignal = options?.signal;
          entered.resolve();
          return openProof.promise;
        },
      };
      const persistence = fixture.ctx.plugin({
        name: 'held-startup-persistence',
        apply(ctx: Context) { ctx.provide('sessionPersistence', seam); },
      });
      await persistence.await();
      let ready = 0;
      fixture.ctx.plugin({ name: 'held-startup-consumer', inject: ['flow'], apply() { ready += 1; } });
      const fiber = fixture.ctx.plugin(plugin, pluginConfig(dataDir));
      t.after(() => fiber.dispose());
      await entered.promise;
      assert.equal(flowOf(fixture.ctx), undefined);
      assert.equal(ready, 0, 'pending recovery never publishes readiness');
      let disposed = false;
      const disposing = (unload === 'plugin' ? fiber.dispose() : persistence.dispose())
        .then(() => { disposed = true; });
      await settle(12);
      assert.equal(disposed, true, 'Cordis cleanup completes while the backend proof is still held');
      assert.equal(proofSignal?.aborted, true, 'cancellation reaches the supported persistence options');
      await disposing;
      await fiber.await();
      assert.equal(flowOf(fixture.ctx), undefined);
      assert.equal(ready, 0);

      const replacement = createFakeHost();
      t.after(() => replacement.dispose());
      const replacementFiber = replacement.ctx.plugin(plugin, pluginConfig(dataDir));
      t.after(() => replacementFiber.dispose());
      await replacementFiber.await();
      const restored = flowOf(replacement.ctx);
      assert.ok(restored, 'a fresh instance opens the same SQLite path before the old proof returns');
      assert.ok(restored.list({}).clusters.some(cluster => cluster.id === saved.cluster.id));
      const database = new DatabaseSync(join(dataDir, 'cluster.sqlite'));
      try {
        const before = database.prepare('SELECT * FROM events ORDER BY seq').all();
        if (phase === 'stat') {
          // A non-cancellable backend can fail after disposal, too. Its
          // rejection is observed without reopening recovery or escaping.
          statProof.reject(new Error('late metadata failure'));
        } else {
          openProof.resolve(handle);
          await closed.promise;
        }
        await settle(8);
        assert.equal(reads, 0, 'a late open handle is closed without reading or committing proof');
        assert.deepEqual(database.prepare('SELECT * FROM events ORDER BY seq').all(), before,
          'late proof cannot write to the disposed store or the replacement instance');
        assert.equal(ready, 0, 'the old consumer is never activated by a late proof');
      } finally {
        database.close();
      }
    });
  }
}