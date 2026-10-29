import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { markWaitCompletion, messageID, sessionID, trustedSystemMessage } from '../../../packages/dsh-flow/src/core/message.js';
import { input, runtime, until } from '../../helpers/contract-runtime.js';

const content = (message: { content: UserMessage['content'] }) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
const text = (request: GenerateOptions) => request.messages.map(content).join('\n');

test('ordinary notifications expose mailbox discovery without reading or copying the body; actual SDK tools retrieve it', async t => {
  for (const method of ['flow_read', 'flow_unread'] as const) await t.test(method, async t => {
    const f = await runtime(t), recipient = await f.create('recipient'), sender = await f.create('sender'), native = f.native(recipient);
    const payload = { body: 'PRIVATE-MESSAGE-BODY', constraints: ['preserve the original facts'], nested: { value: 42 } };
    const summary = 'Review the incoming evidence';
    if (method === 'flow_unread') recipient.getMailbox().setSourcePriority(sender, 'high');
    let id: string | undefined;
    f.model.script = (request, index) => {
      if (index !== 0) return 'DONE';
      id = text(request).match(/^\[([^\]]+)\] /m)?.[1];
      assert.ok(id);
      assert.equal(recipient.getMailbox().peak(messageID(id))?.read, false, 'notification is not a body read');
      return { tool: method, args: method === 'flow_read' ? { messageID: id } : {} };
    };
    recipient.recvMessage(method === 'flow_read' ? trustedSystemMessage(summary, payload) : { ...input(summary), source: sender, payload });
    await until(() => f.model.requests.length > 0); await native.whenIdle();
    const notification = native.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'flow' && event.data.source.purpose === 'notification');
    assert.ok(notification?.type === 'user/message');
    const notice = content(notification.data);
    assert.ok(notice.startsWith(`[${id}] ${method === 'flow_read' ? 'System' : 'sender (sender)'}：${summary}`));
    assert.ok(notice.includes('当前 Flow 邮箱') && notice.includes('flow_unread') && notice.includes('flow_read'));
    assert.ok(!notice.includes(payload.body));
    assert.deepEqual(notification.data.source, { kind: 'flow', purpose: 'notification', priority: method === 'flow_read' ? 'normal' : 'high', waitCompletion: false });
    const result = native.session.snapshotEvents().find(event => event.type === 'tool/result');
    assert.ok(result?.type === 'tool/result'); assert.equal(result.data.message.isError, false);
    const read = JSON.parse(content(result.data.message)) as { payload: unknown } | { payload: unknown }[];
    assert.deepEqual((Array.isArray(read) ? read[0] : read)?.payload, payload);
    assert.equal(recipient.getMailbox().peak(messageID(id!))?.read, true);
    assert.ok(text(f.model.requests[1]!).includes(payload.body), 'the actual SDK returns the body to the next model step');
  });
});

test('cold recovery shares mailbox discovery while invalidating old IDs and preserving idle recovery', async t => {
  const f = await runtime(t), agent = await f.create('mailbox-recovery'), native = f.native(agent);
  agent.recvMessage(trustedSystemMessage('Before recovery', 'OLD-MAILBOX-BODY'));
  await until(() => f.model.requests.length > 0); await native.whenIdle();
  const old = agent.getMailbox().query()[0]; assert.ok(old);
  const live = native.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'flow' && event.data.source.purpose === 'notification');
  assert.ok(live?.type === 'user/message');
  const before = f.model.requests.length;
  await f.context.release(agent);
  const resumed = await Agent.resume(f.context, null, sessionID('mailbox-recovery')), restored = f.native(resumed);
  assert.equal(f.model.requests.length, before); assert.equal(restored.status, 'idle');
  assert.equal(resumed.getMailbox().get(old.id), null); assert.equal(resumed.getMailbox().count(), 0);
  const recovery = [...restored.inbox.nextTurn, ...restored.inbox.nextStep].find(message => content(message).includes('Mailbox 和通信关系已重新初始化'));
  assert.ok(recovery);
  assert.match(content(recovery), /历史消息编号在当前 Mailbox 中无效/);
  const discovery = content(live.data).split('\n\n').at(-1)!;
  assert.ok(discovery.includes('当前 Flow 邮箱') && discovery.includes('flow_unread') && discovery.includes('flow_read'));
  assert.ok(content(recovery).endsWith(discovery));
  assert.ok(!content(recovery).includes(old.id));
  assert.deepEqual(recovery.source, { kind: 'flow', purpose: 'notification', priority: 'normal', waitCompletion: false });
  let issued = false;
  f.model.script = () => {
    if (issued) return 'DONE';
    issued = true; return { tool: 'flow_unread', args: {} };
  };
  resumed.recvMessage(trustedSystemMessage('After recovery', 'CURRENT-MAILBOX-BODY'));
  await until(() => f.model.requests.length > before); await restored.whenIdle();
  const current = resumed.getMailbox().query()[0]; assert.ok(current); assert.notEqual(current.id, old.id); assert.equal(current.read, true);
  const result = restored.session.snapshotEvents().findLast(event => event.type === 'tool/result');
  assert.ok(result?.type === 'tool/result');
  assert.equal(JSON.parse(content(result.data.message))[0]?.payload, 'CURRENT-MAILBOX-BODY');
});

test('wait completion keeps its complete payload and trusted source while crossing a new wait', async t => {
  const f = await runtime(t), agent = await f.create('completion'), native = f.native(agent);
  const payload = { matched: { body: 'COMPLETE-MATCHED-CONTENT', values: [1, 2] }, deferred: ['ORIGINAL-COMPLETION-DETAIL'] };
  const sending = f.adaptor.send(f.hostAgent(agent), markWaitCompletion({ ...input('completion'), payload }), 'followup', 'notification');
  agent.wait(() => false, 5000);
  await sending; await native.whenIdle();
  assert.equal(agent.hasPendingWait(), true); assert.equal(f.model.requests.length, 1);
  const completion = native.session.snapshotEvents().find(event => event.type === 'user/message');
  assert.ok(completion?.type === 'user/message');
  assert.equal(content(completion.data), JSON.stringify(payload));
  assert.deepEqual(completion.data.source, { kind: 'flow', purpose: 'notification', priority: 'normal', waitCompletion: true });
});
