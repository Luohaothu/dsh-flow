import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type { SessionBinding, SessionReference, SessionRetainOptions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { createReader } from '../../packages/dsh-flow/src/client/reader-source.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(failure: 'retain' | 'open', nativeExists = false) {
  const id = SessionId('new-coordinator');
  let exists = nativeExists, catalogued = false, historyError = false, removed = false, attempts = 0, releases = 0, pages = 0;
  const references: SessionReference[] = [];
  const catalogListeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const chatListeners = new Set<() => void>();
  const session = fromPartial<SessionBinding['session']>({
    async loadOlder() { pages++; historyError = false; for (const listener of sessionListeners) listener(); },
    getSnapshot: () => fromPartial<ReturnType<SessionBinding['session']['getSnapshot']>>({openState: exists ? 'open' : 'error', hasMore: false, loadingOlder: false, historyError: historyError ? {message: 'paging failed'} : null, removed}),
    subscribe: (listener: () => void) => {sessionListeners.add(listener); return () => sessionListeners.delete(listener);},
  });
  const binding = fromPartial<SessionBinding>({sessionId: id, session});
  const ctx = fromPartial<Context>({
    sessions: fromPartial<Context['sessions']>({
      list: {
        getSnapshot: () => fromPartial<ReturnType<Context['sessions']['list']['getSnapshot']>>({
          ids: catalogued ? [id] : [],
          // Retaining creates a fallback row even before Host catalog arrival.
          byId: {[id]: fromPartial<ReturnType<Context['sessions']['list']['getSnapshot']>['byId'][typeof id]>({id})},
        }),
        subscribe: (listener: () => void) => {catalogListeners.add(listener); return () => catalogListeners.delete(listener);},
      },
      retain(target: SessionTarget, options: SessionRetainOptions) {
        attempts++;
        assert.equal(target, id);
        assert.equal(options.observationOnly, true);
        assert.equal(options.allowUnlisted, true);
        const reference = fromPartial<SessionReference>({
          sessionId: id,
          binding,
          ready: !exists && failure === 'retain' ? Promise.reject(new Error('unknown session')) : Promise.resolve(binding),
          release: () => {releases++;},
        });
        references.push(reference);
        return reference;
      },
    }),
    uiConversation: fromPartial<Context['uiConversation']>({
      binding: () => fromPartial<ReturnType<Context['uiConversation']['binding']>>({
        target: () => fromPartial<ReturnType<ReturnType<Context['uiConversation']['binding']>['target']>>({
          getSnapshot: () => fromPartial<ReturnType<ReturnType<ReturnType<Context['uiConversation']['binding']>['target']>['getSnapshot']>>({order: [], nodes: new Map()}),
          subscribe: (listener: () => void) => {chatListeners.add(listener); return () => chatListeners.delete(listener);},
        }),
      }),
    }),
  });
  return {
    ctx, id, references, catalogListeners, sessionListeners, chatListeners,
    counts: () => ({attempts, releases, pages}),
    arrive() {exists = true; catalogued = true; for (const listener of catalogListeners) listener();},
    historyFails() {historyError = true; for (const listener of sessionListeners) listener();},
    remove() {removed = true; for (const listener of sessionListeners) listener();},
    repeatCatalog() {for (const listener of catalogListeners) listener();},
  };
}

test('native rendering receives the ready observation reference and never a failed or released reference', async () => {
  const host = fixture('retain');
  const reader = createReader(host.ctx, host.id);
  assert.equal(reader.getSnapshot().reference, null);
  await flush();
  assert.equal(reader.getSnapshot().reference, null);
  host.arrive();
  await flush();
  assert.equal(reader.getSnapshot().reference, host.references[1]);
  assert.equal(reader.getSnapshot().reference?.sessionId, host.id);
  const snapshot = reader.getSnapshot();
  for (const listener of host.chatListeners) listener();
  assert.equal(reader.getSnapshot(), snapshot, 'native Chat owns transcript updates without projecting another message list');
  host.historyFails();
  assert.equal(reader.getSnapshot().reference, host.references[1], 'paging failure preserves readable native content');
  reader.dispose();
  assert.equal(reader.getSnapshot().reference, null);
});

test('retrying native history pagination preserves the observation reference', async () => {
  const host = fixture('retain', true);
  const reader = createReader(host.ctx, host.id);
  await flush();
  const reference = reader.getSnapshot().reference;
  host.historyFails();
  assert.ok(reader.getSnapshot().error);
  reader.retry();
  await flush();
  assert.deepEqual(host.counts(), {attempts: 1, releases: 0, pages: 1});
  assert.equal(reader.getSnapshot().reference, reference);
  assert.equal(reader.getSnapshot().error, null);
  reader.dispose();
});

for (const failure of ['retain', 'open'] as const) {
  test(`a coordinator created after its reader opens recovers from ${failure} without a manual retry`, async () => {
    const host = fixture(failure);
    const reader = createReader(host.ctx, host.id);
    await flush();
    assert.ok(reader.getSnapshot().error);
    host.arrive();
    await flush();
    assert.equal(reader.getSnapshot().error, null);
    assert.equal(reader.getSnapshot().loading, false);
    assert.equal(host.counts().attempts, 2);
    host.repeatCatalog();
    await flush();
    assert.equal(host.counts().attempts, 2, 'unrelated catalog updates do not reopen history');
    reader.dispose();
    assert.equal(host.catalogListeners.size, 0);
    assert.equal(host.sessionListeners.size, 0);
    assert.equal(host.chatListeners.size, 0);
    assert.equal(host.counts().releases, 2);
  });
}

test('disposing a pending reader prevents a later catalog arrival from retaining it', async () => {
  const host = fixture('retain');
  const reader = createReader(host.ctx, host.id);
  await flush();
  reader.dispose();
  host.arrive();
  await flush();
  assert.equal(host.counts().attempts, 1);
});

test('catalog arrival before an initial retain failure settles still recovers', async () => {
  const host = fixture('retain');
  const reader = createReader(host.ctx, host.id);
  host.arrive();
  await flush();
  assert.equal(reader.getSnapshot().error, null);
  assert.equal(host.counts().attempts, 2);
  reader.dispose();
});

for (const change of ['historyFails', 'remove'] as const) {
  test(`catalog arrival does not reopen successfully read history after ${change}`, async () => {
    const host = fixture('retain', true);
    const reader = createReader(host.ctx, host.id);
    await flush();
    assert.equal(reader.getSnapshot().error, null);
    host[change]();
    assert.ok(reader.getSnapshot().error);
    host.arrive();
    await flush();
    assert.equal(host.counts().attempts, 1);
    reader.dispose();
  });
}
