/** Compact rows with inline disclosure, contributed through the public Chat seat. */
import { useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import { IconChevronDownOutlineRegular, IconCheckCircleFillRegular, IconWarningTriangleOutlineRegular,
  IconPaperPlaneOutlineRegular, IconLoadingOutlineRegular, IconContextInjectionOutlineRegular,
  IconUsersOutlineRegular, IconLinkOutlineRegular, IconNewChatOutlineRegular, MarkdownText, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { COMMUNICATION_LABELS, communicationContent, communicationHeadline, isCommunicationCategory } from '../messages.ts';

const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' };
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function CommunicationCard({ node }: Pick<PropsRuntime<'conversation.chat.node', 'communication'>, 'node'>) {
  const [expanded, setExpanded] = useState(false);
  const source = communicationContent(node.data.source);
  const category = isCommunicationCategory(source.category) ? source.category : 'discussion';
  const text = node.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const offset = typeof source.body_offset === 'number' && Number.isInteger(source.body_offset)
    && source.body_offset >= 0 && source.body_offset <= text.length ? source.body_offset : 0;
  const body = text.slice(offset);
  const sender = string(source.sender_name) || '未标注发送方';
  const recipient = string(source.recipient_name);
  const transaction = string(source.transaction_id);
  const headline = communicationHeadline(source);
  const subject = string(source.subject);
  const tone = source.tone === 'success' || source.tone === 'warning' ? source.tone : category === 'blocker_report' ? 'warning' : 'neutral';
  const Icon = tone === 'success' ? IconCheckCircleFillRegular : tone === 'warning' ? IconWarningTriangleOutlineRegular
    : category === 'task_instruction' ? IconPaperPlaneOutlineRegular
    : category === 'progress_update' ? IconLoadingOutlineRegular
    : category === 'resource_coordination' ? IconUsersOutlineRegular
    : category === 'collaboration_request' ? IconLinkOutlineRegular
    : category === 'discussion' ? IconNewChatOutlineRegular : IconContextInjectionOutlineRegular;
  const at = typeof source.sent_at === 'number' && Number.isFinite(source.sent_at) ? source.sent_at : node.data.time;
  return <details className="flow-communication" data-flow-category={category} data-flow-tone={tone} data-flow-message-id={string(source.message_id)}
    open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="flow-communication-header">
      <Icon className="flow-communication-icon" size={16}/>
      <span className="flow-communication-subject">{headline}</span>
      <IconChevronDownOutlineRegular className="flow-communication-chevron" size={14}/>
    </summary>
    <div className="flow-communication-detail">
    <div className="flow-communication-meta">
      <Tag>{COMMUNICATION_LABELS[category]}</Tag>
      <span title={string(source.sender_id)}>{sender}</span>{recipient && <><span aria-label="发送给">→</span><span title={string(source.recipient_id)}>{recipient}</span></>}
      <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    {subject && subject !== headline && <p className="flow-communication-full-subject">{subject}</p>}
    {transaction && <p className="flow-communication-task" title={transaction}>关联任务 · {transaction}</p>}
    <div className="flow-communication-body"><MarkdownText text={body} labels={MARKDOWN_LABELS} variant="compact"/></div>
    </div>
  </details>;
}

export function registerCommunicationRenderer(ctx: Context): void {
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'communication',
  }, CommunicationCard));
}
