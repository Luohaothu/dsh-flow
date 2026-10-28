import test from 'node:test';
import assert from 'node:assert/strict';
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client';
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';
import { SettingsDraft, foldNamespace, pathValue, type SettingsPort } from '../../../packages/dsh-flow/src/native/settings.js';
import { decodeFocus, encodeFocus } from '../../../packages/dsh-flow/src/native/client.js';
import { nativeTarget } from '../../../packages/dsh-flow/src/native/observer.js';

const view = (revision: number, value = 4): SettingsNamespaceView => ({ ns: 'real-loader-entry', revision, value: { maxConcurrentAgents: value }, base: { maxConcurrentAgents: 4 }, user: { maxConcurrentAgents: value }, schema: {}, autoGenerate: false, applies: 'live', secrets: [] });
function fixture() {
  let current = view(1), calls = 0;
  const snapshot = (): SettingsMirrorSnapshot => ({ status: 'ready', view: { namespaces: [current], writable: true, hasDocument: true }, error: null });
  const mirror: SettingsDescribeFace = { getSnapshot: snapshot, subscribe: () => () => {}, async ensure() {}, acceptView(value) { current = value; } };
  let result: Awaited<ReturnType<SettingsPort['mutate']>> = { ok: true, value: view(2, 6) };
  let captured: unknown[] = [];
  let settle: (() => void) | undefined;
  const port: SettingsPort = {
    mirror,
    async describe() { return { ok: true, value: { namespaces: [current], writable: true, hasDocument: true } }; },
    async mutate(...args) { calls++; captured = args; if (settle) await new Promise<void>(resolve => { settle = resolve; }); return result; },
    async configuration() { return { entryId: 'real-loader-entry', effective: { maxConcurrentAgents: 4 }, requested: { maxConcurrentAgents: 6 }, restartRequired: ['connection.port'], application: { revision: 2, status: 'applied' } } as never; },
  };
  const editor = new SettingsDraft('real-loader-entry', port); editor.accept(current);
  return { editor, mirror, port, calls: () => calls, captured: () => captured, setCurrent(next: SettingsNamespaceView) { current = next; }, result(value: typeof result) { result = value; }, block() { settle = () => {}; }, release() { settle?.(); } };
}

test('Native settings fences the original edit revision, serializes save and preserves real inheritance presence', async () => {
  const f = fixture();
  f.editor.edit(['maxConcurrentAgents'], 6);
  f.setCurrent(view(8, 9)); f.editor.accept(view(8, 9));
  assert.equal(f.editor.getSnapshot().base?.revision, 1);
  f.block(); const saving = f.editor.save(); await f.editor.save(); assert.equal(f.calls(), 1);
  assert.equal(f.editor.getSnapshot().pending, true); assert.deepEqual(f.captured(), ['real-loader-entry', [{ op: 'set', path: ['maxConcurrentAgents'], value: 6 }], 1]);
  f.release(); await saving;
  assert.equal(f.editor.getSnapshot().base?.revision, 8); assert.equal(f.editor.getSnapshot().configuration?.restartRequired[0], 'connection.port');
  assert.equal(f.editor.getSnapshot().ops.length, 0);
  f.editor.edit(['maxConcurrentAgents']);
  assert.deepEqual(f.editor.getSnapshot().ops, [{ op: 'unset', path: ['maxConcurrentAgents'] }]);
  assert.equal(pathValue({ maxConcurrentAgents: 4 }, ['maxConcurrentAgents']), 4);
  assert.equal(foldNamespace(f.mirror, view(7)), false); assert.equal(f.mirror.getSnapshot().view?.namespaces[0]?.revision, 8);
});

test('Native settings retains draft and exact Host conflict/rejection reasons and compares before retry', async () => {
  const f = fixture(); f.editor.edit(['maxConcurrentAgents'], 8); f.setCurrent(view(3, 7));
  f.result({ ok: false, error: { code: 'settings/conflict', message: 'revision changed on disk', details: { ns: 'real-loader-entry' } } as never });
  await f.editor.save();
  assert.equal(f.editor.getSnapshot().conflict, true); assert.match(f.editor.getSnapshot().message!, /revision changed on disk/);
  assert.equal(f.editor.getSnapshot().base?.revision, 1); assert.equal(f.editor.getSnapshot().latest?.revision, 3); assert.equal(f.editor.getSnapshot().ops.length, 1);
  f.editor.compareAndKeepDraft(); assert.equal(f.editor.getSnapshot().base?.revision, 3);
  f.result({ ok: false, error: { code: 'settings/rejected', message: 'disk is read only', details: {} } as never });
  await f.editor.save(); assert.match(f.editor.getSnapshot().message!, /disk is read only/); assert.equal(f.editor.getSnapshot().ops.length, 1); assert.equal(f.editor.getSnapshot().saved, false);
});

test('Native settings invalid drafts do not submit, transport errors retain edits, disposed editor ignores late completion', async () => {
  const f = fixture(); f.editor.edit(['maxConcurrentAgents'], 5); f.editor.invalid(['connection', 'prices'], 'invalid JSON');
  await f.editor.save(); assert.equal(f.calls(), 0);
  f.editor.edit(['connection', 'prices'], {}); f.port.mutate = async () => { throw new Error('connection closed'); };
  await f.editor.save(); assert.match(f.editor.getSnapshot().message!, /connection closed/); assert.equal(f.editor.getSnapshot().ops.length, 2);
  f.editor.discard(); assert.equal(f.editor.getSnapshot().ops.length, 0);
  const previous = f.editor.getSnapshot(); f.editor.dispose(); f.editor.edit(['rootRole'], 'unused'); assert.equal(f.editor.getSnapshot(), previous);
});

test('Native header focus is opaque validated identity; readonly target binds Run and exact instance', () => {
  const focus = { requestId: 'request', runId: 'run', instanceId: 'member' };
  assert.deepEqual(decodeFocus(encodeFocus(focus)), focus);
  for (const bad of ['null', '{}', '{"runId":"r","requestId":1}', '{"runId":"r","requestId":"a","observe":"yes"}']) assert.equal(decodeFocus(bad), undefined);
  const target = { bindingKey: 'run/member', sessionId: 'session' as never, locator: { runId: 'run', instanceId: 'member', sessionId: 'session' } };
  assert.equal(nativeTarget(target).instanceId, 'member');
  assert.throws(() => nativeTarget({ ...target, bindingKey: 'run/other' }), /身份/);
  assert.throws(() => nativeTarget({ ...target, locator: { ...target.locator, sessionId: 'other' } }), /身份/);
});
