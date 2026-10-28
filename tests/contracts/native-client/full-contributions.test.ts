import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots';
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { createNativeClientLoader, managedSessions } from '../../helpers/native-sdk.js';

const noop = () => () => {};
const observable = <T>(value: T) => ({ getSnapshot: () => value, subscribe: noop });

test('full Conversation + Chat + Trajectory contributions materialize a true readonly managed binding without editor capabilities', async t => {
  const scratch = process.env.DSH_FLOW_TEST_SDK_WORK;
  // Presentational primitives are not rendered in this source-assembly test.
  // Fail if a source unexpectedly tries to execute one; no domain source or
  // contribution resolver is replaced.
  const visuals = new Proxy({}, { get: () => () => { throw new Error('Unexpected presentational primitive during source assembly'); } });
  const load = createNativeClientLoader(scratch ? { '@deepseek-ai/dsh-client-ui-conversation': join(scratch, 'dsh-client-ui-conversation/lib/client.js') } : {}, { '@deepseek-ai/dsh-client-ui-primitives': visuals });
  const wait = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  const opening = () => ({ type: 'snapshot' as const, records: [], cursor: -1, hasMore: false, header: { version: 1, id: SessionId('readonly-full'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } });
  const f = managedSessions(load, async function* (_request, signal) { yield opening(); await wait(signal); }); t.after(() => f.ctx.fiber.dispose());
  f.ctx.reflect.provide('locale', { register: noop, subscribe: noop, bind: () => (key: string) => key }, undefined);
  f.ctx.reflect.provide('uiWorkspace', {}, undefined);
  f.ctx.reflect.provide('fileUpload', {}, undefined);
  const config = { ...observable({ value: undefined }), async set() {} };
  f.ctx.reflect.provide('configForms', { get: () => config, developerTools: { enabled: observable(false) } }, undefined);
  for (const name of ['dsh-client-ui-renderer', 'dsh-client-ui-session', 'dsh-client-ui-conversation', 'dsh-client-ui-chat', 'dsh-client-ui-trajectory']) {
    const module = load(`@deepseek-ai/${name}/client`);
    (module.apply as (ctx: typeof f.ctx) => void)(f.ctx);
  }
  const provider = f.sessions.registerReadonlySource('full-contributions', {
    async *follow(_target, _request, signal) {
      yield { epoch: 'native', kind: 'journal', frame: { type: 'snapshot', records: [], cursor: -1, hasMore: false, header: { version: 1, id: SessionId('readonly-full'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } } };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }, async page() { return { records: [], hasMore: false }; }, async attachment() { throw new Error('No attachment'); },
  });
  const ref = provider.retain({ bindingKey: 'run/member', sessionId: SessionId('readonly-full'), locator: {} }, { source: 'flowObserver' });
  await ref.ready;
  f.emitRemote('api-session/added', { sessionId: SessionId('readonly-full'), agentAvailable: true, running: false, blank: false, updatedAt: 0 });
  const ordinary = f.sessions.retain(SessionId('readonly-full'), { source: 'controllerOperation' });
  await ordinary.ready;
  assert.notEqual(ordinary.binding.session, ref.binding.session);
  assert.equal(f.sessions.binding(ref.sessionId)?.session === ordinary.binding.session, true);
  const source = f.ctx.uiSession.adapter.bindingSource(ref) as { getSnapshot(): StandardSourceBinding };
  const value = source.getSnapshot();
  assert.deepEqual(Object.keys(value.hooks).sort(), ['chat', 'conversation', 'input', 'session', 'trajectory']);
  assert.deepEqual(Object.keys(value.keyedHooks ?? {}), ['projection']);
  assert.deepEqual(Object.keys(value.props ?? {}).sort(), ['inputActions', 'sessionId']);
  assert.equal(value.key, ref.binding.scopeKey);
  assert.equal(value.hooks.input?.getSnapshot(), undefined);
  assert.ok(value.hooks.chat?.getSnapshot());
  assert.ok(value.hooks.trajectory?.getSnapshot());
  assert.ok(value.hooks.conversation?.getSnapshot());
  const actions = value.props?.inputActions as InputActions;
  assert.deepEqual(Object.keys(actions).sort(), ['addAttachments', 'captureInsertion', 'insertText', 'pruneAttachments', 'removeAttachment', 'setDraft', 'submit']);
  for (const action of Object.values(actions)) assert.throws(() => action(), /session\/read-only/);
  const conversation = ref.binding.ctx.get('conversation') as typeof f.ctx.conversation;
  assert.throws(() => conversation.input.for(ref.binding.ctx), /retained Session scope|read-only/);
  await assert.rejects(conversation.send('blocked'), /session\/read-only/);
  await assert.rejects(conversation.cancel(), /session\/read-only/);
  await assert.rejects(conversation.updateQueue('blocked' as never, { kind: 'delete' } as never), /session\/read-only/);
  assert.equal(f.writes.count, 0);
  ref.release(); provider[Symbol.dispose]();
  assert.equal(f.sessions.ownsReference(ordinary), true); ordinary.release();
  for (let attempt = 0; source.getSnapshot().key !== undefined && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(source.getSnapshot().key, undefined);
});
