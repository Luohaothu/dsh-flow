import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDeveloperMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { getAgentInstanceId } from '../../../packages/dsh-flow/src/core/observation.js';
import { FlowPlugin } from '../../../packages/dsh-flow/src/plugin.js';
import { NativeHistory } from '../../../packages/dsh-flow/src/native/history.js';
import type { FlowNativeFrame, FlowNativeTarget } from '../../../packages/dsh-flow/src/native/protocol.js';
import { registerJsonTool } from '../../../packages/dsh-flow/src/host/tools.js';
import { runtime, profile, until } from '../../helpers/contract-runtime.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { flowNativeMessageCount: number }
  interface SessionProjectionMap { flowNativeMessageCount: number }
}
const prompt = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
async function fixture(t: Parameters<typeof runtime>[0], cleanup?: { immediateTimeoutMs: number; gracefulTimeoutMs: number }) {
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  f.host.sessionProjections.register({ key: 'flowNativeMessageCount', stateVersion: 1, stateSchema: z.number(), init: () => 0,
    apply: (state, event) => state + Number(event.type === 'user/message'), wire: { viewSchema: z.number(), view: state => state } });
  const stateDirectory = join(f.directory, 'plugin');
  const plugin = await FlowPlugin.create(f.host, { stateDirectory, ...(cleanup ? { cleanup } : {}) });
  t.after(() => plugin.dispose().catch(() => {}));
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } });
  const origin = plugin.bridge.createOrigin(main.agent), run = plugin.runs.create(origin, {}, 'native-history');
  await until(() => run.status !== 'starting'); assert.equal(run.status, 'active');
  const child = await Agent.create(run.context!, profile(randomUUID()), run.root!);
  const native = f.host.agents.get(SessionId(child.getProfile().sessionID))!;
  const target: FlowNativeTarget = { runId: run.id, instanceId: getAgentInstanceId(child), sessionId: native.session.id };
  return { ...f, plugin, run, child, native, target, historyDirectory: join(stateDirectory, 'native-history') };
}
async function opening(history: NativeHistory, target: FlowNativeTarget, maxMessages = 50) {
  const controller = new AbortController(), iterator = history.follow({ target, request: { maxMessages, assistantStream: true } }, controller.signal)[Symbol.asyncIterator]();
  const result = await iterator.next(); assert.equal(result.done, false); const value = result.value!;
  assert.equal(value.kind, 'journal'); assert.ok(value.kind === 'journal' && value.frame.type === 'snapshot');
  return { controller, iterator, epoch: value.epoch, frame: value.frame, close: async () => { controller.abort(); await iterator.return?.(); } };
}

test('P6 Native source reads actual records, aligned pages, projections and attachments; releasing a reader leaves Agent running', async t => {
  const f = await fixture(t);
  const image = await f.host.attachments.saveImage({ data: imageBytes, mediaType: 'image/png', name: 'history.png' });
  f.native.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Image history' }, { type: 'image', attachment: image }] })); await f.native.whenIdle();
  f.native.followup(prompt('Second prompt')); await f.native.whenIdle();
  f.native.followup(prompt('Third prompt')); await f.native.whenIdle();
  const reader = await opening(f.plugin.nativeHistory, f.target, 1);
  assert.equal(reader.frame.hasMore, true); assert.equal(reader.frame.header.origin, 'subagent');
  assert.equal(reader.frame.projections.values.flowNativeMessageCount, 3);
  const page = await f.plugin.nativeHistory.page({ target: f.target, epoch: reader.epoch, request: { throughSeq: reader.frame.cursor, beforeSeq: reader.frame.records[0]!.event.seq, maxMessages: 100 } }, reader.controller.signal);
  const all = [...page.records, ...reader.frame.records];
  assert.deepEqual(all.map(record => record.event), JSON.parse(JSON.stringify(f.native.session.snapshotEvents())));
  const attachment = await f.plugin.nativeHistory.attachment({ target: f.target, epoch: reader.epoch, attachmentId: image.attachmentId }, reader.controller.signal);
  assert.equal(attachment.attachment.attachmentId, image.attachmentId); assert.deepEqual(Buffer.from(attachment.data, 'base64'), imageBytes);
  await assert.rejects(f.plugin.nativeHistory.page({ target: { ...f.target, sessionId: SessionId('forged') }, epoch: reader.epoch, request: { throughSeq: reader.frame.cursor } }, reader.controller.signal), /match|published/);
  await assert.rejects(f.plugin.nativeHistory.page({ target: { ...f.target, runId: randomUUID() }, epoch: reader.epoch, request: { throughSeq: reader.frame.cursor } }, reader.controller.signal), /trusted/);
  await assert.rejects(f.plugin.nativeHistory.page({ target: f.target, epoch: 'expired', request: { throughSeq: reader.frame.cursor } }, reader.controller.signal), /generation/);
  await reader.close();
  await assert.rejects(access(join(f.directory, 'query.sqlite')), /ENOENT/);
  assert.deepEqual(f.plugin.nativeHistory.diagnostics(), { followers: 0, leases: 0, sources: 2 });
  assert.equal(f.host.agents.get(f.target.sessionId), f.native);
  f.native.followup(prompt('Agent continues after reader closes')); await f.native.whenIdle(); assert.equal(f.child.getStatus(), 'idle');
});

test('P6 actual after-turn tail becomes durable final cut; same SID resume remains separate with old prefix projections and attachment authorization', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  registerJsonTool(f.native.ctx, 'native_history_hold', 'Hold the admitted turn', { type: 'object', properties: {} }, async () => { entered(); await gate; return { complete: true }; });
  f.model.script = (_options, index) => index === 0 ? { tool: 'native_history_hold', args: {} } : 'AFTER-LOGICAL-TERMINATION';
  f.native.followup(prompt('Admitted work')); await toolEntered;
  const stop = f.child.recvSignal('SIGTERM'); assert.equal(f.child.getStatus(), 'terminated');
  const midway = await opening(f.plugin.nativeHistory, f.target); assert.ok(midway.frame.assistantStream); await midway.close();
  release(); await stop;
  const old = await opening(f.plugin.nativeHistory, f.target, 100);
  const finalCursor = old.frame.cursor;
  assert.ok(old.frame.records.some(record => record.event.type === 'tool/result'));
  assert.match(JSON.stringify(old.frame.records), /AFTER-LOGICAL-TERMINATION/);
  assert.deepEqual(old.frame.assistantStream, { revision: 0 });
  const resumed = await Agent.resume(f.run.context!, f.run.root!, f.child.getProfile().sessionID);
  const resumedNative = f.host.agents.get(f.target.sessionId)!;
  const nextTarget: FlowNativeTarget = { ...f.target, instanceId: getAgentInstanceId(resumed) };
  assert.notEqual(nextTarget.instanceId, f.target.instanceId);
  const lateImage = await f.host.attachments.saveImage({ data: imageBytes, mediaType: 'image/png', name: 'new-instance.png' });
  resumedNative.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new instance image' }, { type: 'image', attachment: lateImage }] })); await resumedNative.whenIdle();
  const current = await opening(f.plugin.nativeHistory, nextTarget, 100);
  const oldAgain = await opening(f.plugin.nativeHistory, f.target, 100);
  assert.equal(oldAgain.frame.cursor, finalCursor); assert.ok(current.frame.cursor > finalCursor);
  assert.equal(oldAgain.frame.projections.values.flowNativeMessageCount, 1); assert.equal(current.frame.projections.values.flowNativeMessageCount, 3);
  await assert.rejects(f.plugin.nativeHistory.attachment({ target: f.target, epoch: old.epoch, attachmentId: lateImage.attachmentId }, old.controller.signal), /not referenced/);
  assert.equal((await f.plugin.nativeHistory.attachment({ target: nextTarget, epoch: current.epoch, attachmentId: lateImage.attachmentId }, current.controller.signal)).attachment.attachmentId, lateImage.attachmentId);
  const coldRuntime = await runtime(t, { directory: f.directory }); await enablePluginHost(coldRuntime.host, f.directory);
  coldRuntime.host.sessionProjections.register({ key: 'flowNativeMessageCount', stateVersion: 1, stateSchema: z.number(), init: () => 0,
    apply: (state, event) => state + Number(event.type === 'user/message'), wire: { viewSchema: z.number(), view: state => state } });
  const cold = new NativeHistory(coldRuntime.host, f.historyDirectory); t.after(() => cold.dispose());
  const creates = t.mock.method(coldRuntime.host.agents, 'create'), resumes = t.mock.method(coldRuntime.host.agents, 'resume');
  assert.equal(coldRuntime.host.agents.list().length, 0);
  const persisted = await opening(cold, f.target, 100);
  assert.equal(persisted.frame.cursor, finalCursor); assert.equal(persisted.frame.projections.values.flowNativeMessageCount, 1);
  assert.equal(creates.mock.callCount(), 0); assert.equal(resumes.mock.callCount(), 0);
  assert.equal(coldRuntime.host.agents.list().length, 0);
  await cold.dispose(); assert.equal(cold.diagnostics().leases, 0); assert.equal(cold.diagnostics().followers, 0);
  for (const reader of [old, current, oldAgain, persisted]) await reader.close();
  creates.mock.restore(); resumes.mock.restore();
});

test('P6 follow installs before immutable cut, removes opening duplicates and preserves real post-cut events/assistant baseline', async t => {
  const f = await fixture(t);
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(f.model, 'stream', async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'native reasoning' };
    start(); await gate;
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'native reasoning' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: 'tail' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'tail' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  f.native.followup(prompt('stream')); await started;
  const real = f.host.sessionQuery.observeSession.bind(f.host.sessionQuery);
  let once = true;
  const observation = t.mock.method(f.host.sessionQuery, 'observeSession', async (...args: Parameters<typeof real>) => {
    if (!once) return real(...args); once = false;
    const stamp = f.native.session.snapshotEvents().findLast(event => event.type === 'step/start'); assert.ok(stamp?.type === 'step/start');
    const { turn, step } = stamp.data;
    f.native.session.append('developer/message', { turn, step, message: createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before cut duplicate' }] }) }, { surfaceOp: 'append' });
    const cut = await real(...args);
    f.native.session.append('developer/message', { turn, step, message: createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after cut buffered' }] }) }, { surfaceOp: 'append' });
    return cut;
  });
  const reader = await opening(f.plugin.nativeHistory, f.target, 100); observation.mock.restore();
  assert.ok(reader.frame.assistantStream?.activeAttempt); assert.match(JSON.stringify(reader.frame.assistantStream), /native reasoning/);
  const received: FlowNativeFrame[] = [];
  const consume = (async () => { for await (const value of { [Symbol.asyncIterator]: () => reader.iterator }) { received.push(value); if (value.kind === 'journal' && value.frame.type === 'event' && value.frame.event.type === 'turn/end') { reader.controller.abort(); break; } } })();
  finish(); await f.native.whenIdle(); await consume; await reader.close();
  const events = received.flatMap(value => value.kind === 'journal' && value.frame.type === 'event' ? [value.frame.event] : []);
  assert.equal(events[0]!.seq, reader.frame.cursor + 1); assert.match(JSON.stringify(events[0]), /after cut buffered/);
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: events.length }, (_v, index) => reader.frame.cursor + 1 + index));
  assert.ok(received.some(value => value.kind === 'journal' && value.frame.type === 'assistant-stream'));
  assert.equal(f.plugin.nativeHistory.diagnostics().leases, 0); assert.equal(f.plugin.nativeHistory.diagnostics().followers, 0);
});

test('P6 missing cuts and abandoned cleanup report unavailable and cannot borrow a later live instance', async t => {
  const f = await fixture(t, { gracefulTimeoutMs: 100, immediateTimeoutMs: 15 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const idle = t.mock.method(f.native, 'whenIdle', () => gate);
  try {
    await assert.rejects(f.child.recvSignal('SIGKILL'), /Agent release failed/);
    await assert.rejects(opening(f.plugin.nativeHistory, f.target), /final cut|deadline/);
    await assert.rejects(Agent.resume(f.run.context!, f.run.root!, f.child.getProfile().sessionID), /unfinished/);
  } finally { release(); idle.mock.restore(); }
  await until(() => !f.host.agents.get(f.target.sessionId));
  const files = await readdir(f.historyDirectory);
  for (const filename of files) {
    const path = join(f.historyDirectory, filename), record = JSON.parse(await readFile(path, 'utf8'));
    if (record.target.instanceId === f.target.instanceId) { assert.equal(record.phase, 'abandoned'); assert.equal(record.endSeq, undefined); await rm(path); await writeFile(path, JSON.stringify({ ...record, phase: 'complete', published: true })); }
  }
  const cold = new NativeHistory(f.host, f.historyDirectory); t.after(() => cold.dispose());
  await assert.rejects(opening(cold, f.target), /trustworthy|end sequence/);
});

test('P6 a paused reader drains native state, assistant frames and the entire durable tail before completion', async t => {
  const f = await fixture(t), reader = await opening(f.plugin.nativeHistory, f.target, 100);
  try {
    assert.equal((await reader.iterator.next()).value?.kind, 'state');
    f.native.followup(prompt('All real events arrive while the reader is paused')); await f.native.whenIdle();
    await f.child.recvSignal('SIGTERM');
    const received: FlowNativeFrame[] = [];
    for (;;) { const value = await reader.iterator.next(); if (value.done) break; received.push(value.value); }
    const events = received.flatMap(value => value.kind === 'journal' && value.frame.type === 'event' ? [value.frame.event] : []);
    assert.deepEqual(events, JSON.parse(JSON.stringify(f.native.session.snapshotEvents().filter(event => event.seq > reader.frame.cursor))));
    assert.ok(received.some(value => value.kind === 'journal' && value.frame.type === 'assistant-stream' && value.frame.frame.type === 'end'));
    const finalState = received.at(-1); assert.ok(finalState?.kind === 'state'); assert.equal(finalState.summary.agentAvailable, false);
  } finally { await reader.close(); }
});

test('P6 an idle reader waits for the actual final-cut fsync, then ends without requiring a new event', async t => {
  const f = await fixture(t), reader = await opening(f.plugin.nativeHistory, f.target, 100);
  assert.equal((await reader.iterator.next()).value?.kind, 'state');
  const initialCursor = reader.frame.cursor;
  let blocked = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const openFile = fsPromises.open.bind(fsPromises);
  const openMock = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof openFile>) => {
    const file = await openFile(...args);
    if (String(args[0]).startsWith(f.historyDirectory) && String(args[0]).endsWith('.tmp')) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => { blocked = true; await gate; await sync(); });
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    const stopped = f.child.recvSignal('SIGTERM');
    await until(() => blocked, 'final source fsync began');
    assert.equal(f.host.agents.get(f.target.sessionId), undefined);
    let readSettled = false, reuseSettled = false;
    const next = reader.iterator.next().then(value => { readSettled = true; return value; });
    const reuse = f.plugin.nativeHistory.beforeReuse(f.target.sessionId).then(() => { reuseSettled = true; });
    await setImmediate(); assert.equal(readSettled, false); assert.equal(reuseSettled, false);
    release(); await stopped; await reuse;
    const final = await next; assert.ok(final.value?.kind === 'state');
    assert.equal((await reader.iterator.next()).done, true);
    assert.equal(f.native.session.seq - 1, initialCursor);
  } finally { release(); openMock.mock.restore(); syncBuiltinESMExports(); await reader.close(); }
});
