import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as React from 'react';
import * as Native from '../../../packages/dsh-flow/src/native/client.js';
import { loadNativeClient } from '../../helpers/native-sdk.js';

test('Native owns its mounted Remote namespace and registers UI with exact Cordis service injections', async t => {
  const ctx = new Context(), styles = new Set<object>(), calls: string[] = [];
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() { const style = { dataset: {}, textContent: '', remove() { styles.delete(style); } }; return style; },
    head: { append(style: object) { styles.add(style); } },
  } });
  t.after(async () => { await ctx.fiber.dispose(); if (previousReact) Object.defineProperty(globalThis, 'React', previousReact); else Reflect.deleteProperty(globalThis, 'React'); if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document'); });
  ctx.reflect.provide('connection', {
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    rpc: { async *open() {}, async call(_path: string, endpoint: string) { calls.push(endpoint); return { ok: true, value: { records: [], hasMore: false } }; } },
  }, undefined);
  for (const name of ['dsh-typert-registry', 'dsh-api-gateway']) {
    const module = loadNativeClient(`@deepseek-ai/${name}/client`);
    (module.apply as (ctx: Context) => void)(ctx);
  }
  const remotes = loadNativeClient('@deepseek-ai/dsh-api-remotes/client');
  const disposeBaseline = await (remotes.apply as (ctx: Context) => Promise<() => Promise<void>>)(ctx);
  t.after(disposeBaseline);
  const controller = loadNativeClient('@deepseek-ai/dsh-api-session-controller/client');
  (controller.apply as (ctx: Context) => void)(ctx);
  const renderer = loadNativeClient('@deepseek-ai/dsh-client-ui-renderer/client');
  (renderer.apply as (ctx: Context) => void)(ctx);
  for (const name of ['uiSession', 'uiConversation', 'configForms', 'uiWorkspace', 'theme']) ctx.reflect.provide(name, {}, undefined);
  let bootstrap: Context | undefined;
  const fiber = ctx.plugin({ name: 'p6-native-service-guard', inject: Native.inject, apply(scope) { bootstrap = scope; return Native.apply(scope); } });
  await fiber;
  const registry = ctx.slots;
  const host = Reflect.apply(Reflect.get(registry, 'hostFace'), registry, []) as { factoryOf(name: string): { component(input: { mode: string }): React.ReactElement<{ ctx: Context }> } | undefined };
  const definition = host.factoryOf('dsh-flow.surface');
  assert.ok(definition, 'UI is registered after the generated namespace is mounted');
  const surface = definition.component({ mode: 'dashboard' });
  const scoped = surface.props.ctx;
  assert.ok(bootstrap);
  assert.notEqual(scoped.fiber, bootstrap.fiber);
  assert.throws(() => bootstrap!.remote.flowDashboard.connection, /without inject/);
  assert.doesNotThrow(() => scoped.remote.flowDashboard.connection);
  assert.doesNotThrow(() => scoped.remote.settings.describe);
  assert.doesNotThrow(() => scoped.remote.session.modelCatalog);
  const result = await scoped.remote.flowDashboard.pageNativeSession({ target: { runId: 'run', instanceId: 'instance', sessionId: 'session' as never }, epoch: 'epoch', request: { throughSeq: -1 } }, new AbortController().signal);
  assert.deepEqual(result, { ok: true, value: { records: [], hasMore: false } });
  assert.deepEqual(calls, ['flowDashboard/pageNativeSession']);
  assert.equal(styles.size, 1);
  assert.ok(ctx.get('remote.flowDashboard'));
  await fiber.dispose();
  assert.equal(styles.size, 0);
  assert.equal(host.factoryOf('dsh-flow.surface'), undefined);
  assert.equal(ctx.get('remote.flowDashboard'), undefined);
  const second = ctx.plugin({ name: 'p6-native-service-guard-reenabled', inject: Native.inject, apply: Native.apply });
  await second;
  assert.equal(styles.size, 1);
  assert.ok(host.factoryOf('dsh-flow.surface'));
  assert.notEqual(host.factoryOf('dsh-flow.surface'), definition);
  await second.dispose();
  assert.equal(styles.size, 0);
  assert.equal(host.factoryOf('dsh-flow.surface'), undefined);
  assert.equal(ctx.get('remote.flowDashboard'), undefined);
});
