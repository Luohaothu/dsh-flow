import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import { createUserMessage, ToolCallId, type ContentBlock, type ReplayEnvelope, type UserMessage } from '@deepseek-ai/dsh-llm';
import { Agent } from '../../../packages/dsh-flow/src/core/index.js';
import { input, runtime } from '../../helpers/contract-runtime.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fixture-pending-extension': { kind: 'fixture-pending-extension'; producer: { id: string; metadata: readonly unknown[] } };
  }
}

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
function metadataPath(directory: string, id: string): string { return join(directory, 'flow', `${createHash('sha256').update(id).digest('hex')}.json`); }

for (const placement of ['inbox', 'deferred'] as const) {
  test(`locked rc.2 text reasoning and every user-compatible block survive ${placement} persistence, cold resume and execution`, async t => {
    const f = await runtime(t); await f.host.plugin(AttachmentLocal, { dshHome: join(f.directory, 'attachments') });
    const agent = await f.create(`pending-${placement}`), native = f.native(agent), id = agent.getProfile().sessionID;
    const file = await f.host.attachments.saveFile({ data: Buffer.from('pending original file'), name: 'pending.txt' });
    const image = await f.host.attachments.saveImage({ data: imageBytes, mediaType: 'image/png', name: 'pending.png' });
    const content: ContentBlock[] = [{ type: 'text', text: 'PENDING VARIANT MARKER' }, { type: 'reasoning', text: '' },
      { type: 'reasoning', text: 'ACTUAL RC2 REASONING TEXT' }, { type: 'tool-call', id: ToolCallId('historical-call'), name: 'historical_tool', arguments: '{"opaque":true}' },
      { type: 'file', attachment: file }, { type: 'image', attachment: image }];
    const replay: ReplayEnvelope = { response: { providerPrivate: ['opaque', { encrypted: 'body' }] }, blocks: [null, { signature: 'opaque-signature' }] };
    const messages: UserMessage[] = [
      createUserMessage({ source: { kind: 'fixture-pending-extension', producer: { id: 'extension', metadata: [null, { private: 'preserved' }] } }, content }),
      createUserMessage({ source: { kind: 'model', provider: 'fixture', model: 'model', replayState: replay }, content: [{ type: 'reasoning', text: 'SOURCE REPLAY REMAINS OPAQUE' }] }),
    ];
    if (placement === 'deferred') {
      agent.wait(() => false, 60_000);
      for (const message of messages) { native.followup(message); await native.whenIdle(); }
      assert.equal(f.model.requests.length, 0);
      assert.equal(native.inbox.nextStep.length + native.inbox.nextTurn.length, 0, 'dequeued inputs are retained in the Adaptor deferred queue');
    } else for (const message of messages) native.inject(message);
    await f.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
    const stored = JSON.parse(await readFile(metadataPath(f.directory, id), 'utf8'));
    assert.deepEqual(stored.pending.map((entry: { message: unknown }) => entry.message), messages);
    const resumed = await Agent.resume(f.context, null, id), restored = f.native(resumed);
    for (const message of messages) assert.deepEqual([...restored.inbox.nextStep, ...restored.inbox.nextTurn].find(input => input.id === message.id), message);
    await f.adaptor.send(f.hostAgent(resumed), input('WAKE RESTORED PENDING')); await restored.whenIdle();
    const request = f.model.requests[0]; assert.ok(request);
    const restoredMessages = request.messages.filter(message => messages.some(original => original.id === message.id));
    assert.equal(restoredMessages.length, messages.length);
    assert.ok(restoredMessages.some(message => message.content.some(block => block.type === 'reasoning' && block.text === 'ACTUAL RC2 REASONING TEXT')));
    assert.ok(restoredMessages.some(message => message.content.some(block => block.type === 'image' && block.attachment.attachmentId === image.attachmentId)));
    assert.ok(restoredMessages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('pending.txt'))));
    assert.deepEqual(restoredMessages.map(message => message.source), messages.map(message => message.source));
    assert.ok(restored.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
  });
}

test('all seven rc.2 block variants reject malformed fields and user-incompatible tool changes before native resume', async t => {
  const f = await runtime(t), agent = await f.create('pending-invalid-census'), id = agent.getProfile().sessionID;
  await f.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
  const path = metadataPath(f.directory, id), saved = JSON.parse(await readFile(path, 'utf8'));
  const nativeResume = t.mock.method(f.host.agents, 'resume');
  const image = { attachmentId: 'image-id', bytes: 7, mediaType: 'image/png', width: 1, height: 1 };
  const file = { attachmentId: 'file-id', bytes: 7, name: 'file.txt' };
  const malformed: { name: string; block: unknown }[] = [
    { name: 'text missing text', block: { type: 'text' } }, { name: 'text wrong text type', block: { type: 'text', text: 7 } },
    { name: 'reasoning missing required rc2 text', block: { type: 'reasoning' } },
    { name: 'reasoning block replayState is outside rc2 shape', block: { type: 'reasoning', replayState: { response: {} } } },
    { name: 'reasoning replayState with text is outside rc2 shape', block: { type: 'reasoning', text: 'body', replayState: { response: {}, blocks: [] } } },
    { name: 'image missing reference', block: { type: 'image' } },
    { name: 'image invalid dimensions', block: { type: 'image', attachment: { ...image, width: 0 } } },
    { name: 'image unsupported media type', block: { type: 'image', attachment: { ...image, mediaType: 'image/svg+xml' } } },
    { name: 'image invalid original dimensions', block: { type: 'image', attachment: { ...image, originalDimensions: { width: 1, height: 'bad' } } } },
    { name: 'image invalid offloaded tag', block: { type: 'image', attachment: image, offloaded: false } },
    { name: 'file missing name', block: { type: 'file', attachment: { attachmentId: 'id', bytes: 1 } } },
    { name: 'file invalid bytes', block: { type: 'file', attachment: { ...file, bytes: -1 } } },
    { name: 'file unknown reference field', block: { type: 'file', attachment: { ...file, location: '/forged' } } },
    { name: 'tool-call missing id', block: { type: 'tool-call', name: 'tool', arguments: '{}' } },
    { name: 'tool-call wrong arguments type', block: { type: 'tool-call', id: 'id', name: 'tool', arguments: {} } },
    { name: 'tool-addition invalid name', block: { type: 'tool-addition', toolName: 1 } },
    { name: 'tool-addition forbidden inline schema', block: { type: 'tool-addition', toolName: 'tool', tool: {} } },
    { name: 'tool-removal missing name', block: { type: 'tool-removal' } },
    { name: 'tool-addition valid block requires developer role', block: { type: 'tool-addition', toolName: 'tool' } },
    { name: 'tool-removal valid block requires developer role', block: { type: 'tool-removal', toolName: 'tool' } },
    { name: 'unknown block tag', block: { type: 'unknown-native-block', text: 'body' } },
  ];
  for (const entry of malformed) await t.test(entry.name, async () => {
    const before = nativeResume.mock.callCount();
    await writeFile(path, JSON.stringify({ ...saved, pending: [{ target: 'next-step', message: { id: 'invalid-message', role: 'user', source: { kind: 'user' }, content: [entry.block] } }] }));
    let resumed: Agent | undefined;
    try { await assert.rejects(async () => { resumed = await Agent.resume(f.context, null, id); }, /Invalid|invalid|Unknown|Unsupported|developer role/); }
    finally { await resumed?.recvSignal('SIGKILL'); }
    assert.equal(nativeResume.mock.callCount(), before, 'invalid pending data is fully rejected before native scope creation');
    assert.equal(f.host.agents.list().length, 0); assert.equal(f.model.requests.length, 0);
  });
});
