import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ReadonlySessionSource, ReadonlySessionTarget } from '@deepseek-ai/dsh-api-session-controller/client';
import { managedSessions } from '../../helpers/native-sdk.js';

function waitAbort(signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); }
const target = (instance: string): ReadonlySessionTarget => ({ bindingKey: `run/${instance}`, sessionId: SessionId('same-native-session'), locator: { runId: 'run', instanceId: instance, sessionId: 'same-native-session' } });

test('SDK managed readonly references isolate same SessionID instances, reject writes and own exact generations', async t => {
  const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
  let opened = 0, closed = 0, attachmentKey = '';
  const source: ReadonlySessionSource = {
    async *follow(_target, _request, signal) {
      opened++; try {
        yield { epoch: 'native-1', kind: 'journal', frame: { type: 'snapshot', records: [], cursor: -1, hasMore: false, header: { version: 1, id: SessionId('same-native-session'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } } };
        yield { epoch: 'native-1', kind: 'state', summary: { sessionId: SessionId('same-native-session'), agentAvailable: true, running: true, blank: false, updatedAt: 1 }, projections: { asOfSeq: -1, values: {} } };
        await waitAbort(signal);
      } finally { closed++; }
    },
    async page() { return { records: [], hasMore: false }; },
    async attachment(value) { attachmentKey = value.bindingKey; return { attachment: { attachmentId: 'image' as never, mediaType: 'image/png', kind: 'image', size: 1, width: 1, height: 1 } as never, data: btoa('x') }; },
  };
  const provider = f.sessions.registerReadonlySource('flow-test', source), old = provider.retain(target('old'), { source: 'controllerOperation' }), oldSecond = provider.retain(target('old'), { source: 'controllerOperation' }), current = provider.retain(target('new'), { source: 'controllerOperation' });
  await Promise.all([old.ready, oldSecond.ready, current.ready]);
  assert.equal(opened, 2); assert.equal(old.binding, oldSecond.binding); assert.notEqual(old.binding, current.binding);
  assert.notEqual(old.binding.scopeKey, current.binding.scopeKey); assert.equal(f.sessions.binding(old.sessionId), undefined);
  assert.equal(f.sessions.ownsReference(old), true); assert.equal(f.sessions.ownsReference({ ...old } as never), false);
  assert.equal(f.sessions.referenceInfo(old).referenceCount, 2);
  assert.equal(f.sessions.sessionOf(old.binding.ctx), old.binding.session);
  const oldBinding = old.binding, currentBinding = current.binding;
  const session = current.binding.session;
  assert.throws(() => session.beginSubmission({ text: 'no', attachments: [] } as never), /read-only/);
  for (const action of [() => session.prompt([], 'queue'), () => session.cancel(), () => session.rename('no'), () => session.command('/no'), () => session.updateQueue('queue' as never, { kind: 'delete' } as never)]) await assert.rejects(action, /read-only/);
  assert.equal(f.writes.count, 0);
  const image = await session.readAttachment('image' as never); assert.equal(image.ok, true); assert.equal(attachmentKey, 'run/new');
  old.release(); old.release(); assert.equal(f.sessions.referenceInfo(oldSecond).referenceCount, 1); assert.equal(f.sessions.ownsBinding(oldBinding), true);
  oldSecond.release(); assert.equal(f.sessions.ownsBinding(oldBinding), false); assert.equal(f.sessions.ownsBinding(currentBinding), true);
  assert.equal(f.sessions.ownsReference(oldSecond), false); assert.throws(() => oldSecond.binding, /released/);
  provider[Symbol.dispose](); assert.equal(f.sessions.ownsBinding(currentBinding), false); current.release();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, 2);
});

test('SDK abort of one acquisition releases its own reference; foreign and stale references are refused', async t => {
  const f = managedSessions(), other = managedSessions(); t.after(() => Promise.all([f.ctx.fiber.dispose(), other.ctx.fiber.dispose()]));
  let closed = 0;
  const provider = f.sessions.registerReadonlySource('slow', {
    async *follow(_target, _request, signal) { try { await waitAbort(signal); } finally { closed++; } },
    async page() { throw new Error('not opened'); }, async attachment() { throw new Error('not opened'); },
  });
  const abort = new AbortController(), ref = provider.retain(target('old'), { source: 'controllerOperation', signal: abort.signal });
  assert.equal(other.sessions.ownsReference(ref), false);
  abort.abort(new Error('closed while loading')); await assert.rejects(ref.ready, /closed while loading|released/);
  assert.equal(f.sessions.ownsReference(ref), false); provider[Symbol.dispose]();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, 1);
});

test('SDK ui-session uses true Controller ownership and distinct store keys for simultaneous same-ID observers', async t => {
  const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
  const { loadNativeClient } = await import('../../helpers/native-sdk.js');
  const renderer = loadNativeClient('@deepseek-ai/dsh-client-ui-renderer/client');
  const ui = loadNativeClient('@deepseek-ai/dsh-client-ui-session/client');
  const Registry = renderer.SlotRegistry as new (ctx: typeof f.ctx) => unknown;
  new Registry(f.ctx);
  const UiSession = ui.UiSession as new (ctx: typeof f.ctx, sessions: typeof f.sessions) => {
    bindingSource(reference: typeof old): { value: { key?: string; ctx?: typeof f.ctx } };
  };
  const surface = new UiSession(f.ctx, f.sessions);
  const provider = f.sessions.registerReadonlySource('ui-source', {
    async *follow(_target, _request, signal) {
      yield { epoch: 'epoch', kind: 'journal', frame: { type: 'snapshot', records: [], cursor: -1, hasMore: false, header: { version: 1, id: SessionId('same-native-session'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } } };
      await waitAbort(signal);
    }, async page() { return { records: [], hasMore: false }; }, async attachment() { throw new Error('No attachments'); },
  });
  const old = provider.retain(target('old'), { source: 'controllerOperation' }), current = provider.retain(target('new'), { source: 'controllerOperation' });
  await Promise.all([old.ready, current.ready]);
  const oldSource = surface.bindingSource(old), currentSource = surface.bindingSource(current);
  assert.equal(oldSource.value.key, old.binding.scopeKey); assert.equal(currentSource.value.key, current.binding.scopeKey);
  assert.notEqual(oldSource.value.key, currentSource.value.key);
  assert.throws(() => surface.bindingSource({ sessionId: old.sessionId, binding: old.binding } as never), /not active/);
  old.release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(oldSource.value.key, undefined); assert.equal(currentSource.value.key, current.binding.scopeKey);
  current.release(); provider[Symbol.dispose]();
});

test('SDK readonly journal preserves native records, contiguous live updates, deduplication and pagination', async t => {
  const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
  const entry = (seq: number) => ({ type: 'event' as const, event: { type: 'fixture/extension', ignorable: true, seq, time: seq + 1, data: { original: `native-${seq}` } } });
  let advance: (() => void) | undefined;
  const live = new Promise<void>(resolve => { advance = resolve; });
  const pages: unknown[] = [];
  const provider = f.sessions.registerReadonlySource('journal', {
    async *follow(_target, _request, signal) {
      yield { epoch: 'source-epoch', kind: 'journal', frame: { type: 'snapshot', records: [entry(1)] as never, cursor: 1, hasMore: true, header: { version: 1, id: SessionId('same-native-session'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } } };
      await live;
      if (signal.aborted) return;
      yield { epoch: 'source-epoch', kind: 'journal', frame: entry(2) as never };
      yield { epoch: 'source-epoch', kind: 'journal', frame: entry(2) as never };
      await waitAbort(signal);
    },
    async page(_target, epoch, request) { pages.push({ epoch, request }); return { records: [entry(0)] as never, hasMore: false }; },
    async attachment() { throw new Error('Not referenced'); },
  });
  const ref = provider.retain(target('journal'), { source: 'controllerOperation' }); await ref.ready;
  await ref.binding.session.loadOlder();
  assert.deepEqual(ref.binding.eventSource.getSnapshot().entries.map(value => value.event.seq), [0, 1]);
  assert.equal((pages[0] as { epoch: string }).epoch, 'source-epoch');
  assert.equal((pages[0] as { request: { beforeSeq: number; throughSeq: number } }).request.beforeSeq, 1);
  assert.equal((pages[0] as { request: { throughSeq: number } }).request.throughSeq, 1);
  advance!(); await new Promise(resolve => setTimeout(resolve, 5));
  const window = ref.binding.eventSource.getSnapshot();
  assert.deepEqual(window.entries.map(value => value.event.seq), [0, 1, 2]);
  assert.deepEqual(window.entries[2]?.event.data, { original: 'native-2' });
  ref.release(); provider[Symbol.dispose]();
});

test('SDK released readonly generation rejects late attachment responses without reviving its binding', async t => {
  const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
  let deliver: ((value: { attachment: never; data: string }) => void) | undefined;
  const response = new Promise<{ attachment: never; data: string }>(resolve => { deliver = resolve; });
  const provider = f.sessions.registerReadonlySource('late', {
    async *follow(_target, _request, signal) { yield { epoch: 'old-epoch', kind: 'journal', frame: { type: 'snapshot', records: [], cursor: -1, hasMore: false, header: { version: 1, id: SessionId('same-native-session'), createdAt: 0, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } } }; await waitAbort(signal); },
    async page() { return { records: [], hasMore: false }; }, async attachment() { return response; },
  });
  const ref = provider.retain(target('late'), { source: 'controllerOperation' }); await ref.ready;
  const binding = ref.binding, pending = binding.session.readAttachment('image' as never);
  ref.release(); deliver!({ attachment: {} as never, data: btoa('late') });
  await assert.rejects(pending, /released source epoch/);
  assert.equal(f.sessions.ownsBinding(binding), false); assert.equal(f.sessions.ownsReference(ref), false);
  provider[Symbol.dispose]();
});

for (const malformed of ['different-id', 'missing-id', 'missing-header', 'missing-epoch'] as const) {
  test(`SDK readonly opening rejects ${malformed} before ready and releases its shared generation`, async t => {
    const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
    let opened = 0, closed = 0, valid = false;
    const provider = f.sessions.registerReadonlySource('opening-identity', {
      async *follow(_target, _request, signal) {
        opened++;
        try {
          const header = { version: 1, id: valid || malformed !== 'different-id' ? SessionId('same-native-session') : SessionId('wrong-session'), createdAt: 0, isSeeded: false };
          const frame = { type: 'snapshot', records: [], cursor: -1, hasMore: false, header: valid || malformed !== 'missing-header' ? header : undefined, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } };
          if (!valid && malformed === 'missing-id') delete (header as Partial<typeof header>).id;
          yield { epoch: valid || malformed !== 'missing-epoch' ? 'identity-epoch' : '', kind: 'journal', frame } as never;
          await waitAbort(signal);
        } finally { closed++; }
      },
      async page() { throw new Error('Rejected opening must not page'); }, async attachment() { throw new Error('Rejected opening must not read attachments'); },
    });
    t.after(() => provider[Symbol.dispose]());
    const first = provider.retain(target('identity'), { source: 'controllerOperation' });
    const second = provider.retain(target('identity'), { source: 'controllerOperation' });
    const rejectedBinding = first.binding;
    assert.equal(f.sessions.referenceInfo(first).referenceCount, 2);
    await Promise.all([assert.rejects(first.ready, /snapshot|Session|epoch/), assert.rejects(second.ready, /snapshot|Session|epoch/)]);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(opened, 1); assert.equal(closed, 1);
    assert.equal(f.sessions.ownsReference(first), false); assert.equal(f.sessions.ownsReference(second), false);
    assert.equal(f.sessions.ownsBinding(rejectedBinding), false);
    assert.equal(f.sessions.bindingByScopeKey(rejectedBinding.scopeKey), undefined);
    assert.equal(rejectedBinding.eventSource.getSnapshot().entries.length, 0);
    first.release(); second.release(); assert.equal(f.writes.count, 0);
    valid = true;
    const replacement = provider.retain(target('identity'), { source: 'controllerOperation' }); await replacement.ready;
    assert.notEqual(replacement.binding, rejectedBinding); assert.equal(f.sessions.referenceInfo(replacement).referenceCount, 1);
    assert.equal(opened, 2); replacement.release();
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, 2);
  });
}

test('SDK readonly late source epoch never replaces the accepted window and its errored reference releases normally', async t => {
  const f = managedSessions(); t.after(() => f.ctx.fiber.dispose());
  let advance: (() => void) | undefined, closed = 0;
  const late = new Promise<void>(resolve => { advance = resolve; });
  const header = { version: 1, id: SessionId('same-native-session'), createdAt: 0, isSeeded: false };
  const snapshot = { type: 'snapshot' as const, records: [], cursor: -1, hasMore: false, header, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } };
  const provider = f.sessions.registerReadonlySource('late-epoch', {
    async *follow(_target, _request, signal) {
      try {
        yield { epoch: 'accepted-epoch', kind: 'journal', frame: snapshot } as never;
        await late;
        yield { epoch: 'another-epoch', kind: 'journal', frame: snapshot } as never;
        await waitAbort(signal);
      } finally { closed++; }
    }, async page() { return { records: [], hasMore: false }; }, async attachment() { throw new Error('No attachment'); },
  });
  const ref = provider.retain(target('late-epoch'), { source: 'controllerOperation' }); await ref.ready;
  const binding = ref.binding, initial = binding.eventSource.getSnapshot();
  advance!(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(binding.eventSource.getSnapshot(), initial);
  assert.equal(binding.session.getSnapshot().openState, 'error');
  assert.match(binding.session.getSnapshot().openError?.message ?? '', /epoch/);
  assert.equal(f.sessions.referenceInfo(ref).referenceCount, 1);
  ref.release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sessions.ownsBinding(binding), false); assert.equal(closed, 1); assert.equal(f.writes.count, 0);
  provider[Symbol.dispose]();
});
