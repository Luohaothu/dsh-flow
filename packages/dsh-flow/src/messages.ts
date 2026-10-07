/** Shared communication vocabulary; safe to consume from the Host and Client. */
import type { FlowCommunicationCategory } from './types.ts';

export const COMMUNICATION_LABELS = {
  task_instruction: '任务指令',
  progress_update: '进度反馈',
  result_report: '结果反馈',
  review_feedback: '审查意见',
  collaboration_request: '协作请求',
  blocker_report: '阻塞与升级',
  resource_coordination: '资源协调',
  discussion: '普通讨论',
} as const satisfies Record<FlowCommunicationCategory, string>;

export const COMMUNICATION_CATEGORIES = Object.keys(COMMUNICATION_LABELS) as FlowCommunicationCategory[];

export function isCommunicationCategory(value: unknown): value is FlowCommunicationCategory {
  return typeof value === 'string' && Object.hasOwn(COMMUNICATION_LABELS, value);
}

/** Persisted legacy content may be an encoded object or plain text. */
export function communicationContent(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return communicationContent(JSON.parse(value)); } catch { return { text: value }; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value } : { text: String(value ?? '') };
}

export function communicationCategory(content: unknown): FlowCommunicationCategory {
  const category = communicationContent(content).category;
  return isCommunicationCategory(category) ? category : 'discussion';
}

/** A headline never consumes the message body or manufactures a verdict. */
export function communicationHeadline(content: unknown): string {
  const envelope = communicationContent(content);
  const candidate = typeof envelope.display_summary === 'string' && envelope.display_summary.trim()
    ? envelope.display_summary : typeof envelope.subject === 'string' ? envelope.subject : '';
  const line = candidate.replace(/\s+/gu, ' ').trim() || COMMUNICATION_LABELS[communicationCategory(envelope)];
  const characters = Array.from(line);
  return characters.length > 42 ? `${characters.slice(0, 41).join('')}…` : line;
}

/** Counts and verdicts come from the event envelope, not from model prose. */
export function notificationHeadline(subject: string, payload: unknown): string {
  const data = communicationContent(payload);
  if (subject === 'plan-dispatched') {
    const ids = Array.isArray(data.transaction_ids) ? data.transaction_ids.filter(id => typeof id === 'string' && id) : [];
    const count = new Set(ids).size || (typeof data.transaction_id === 'string' && data.transaction_id ? 1 : 0);
    return count ? `派发 ${count} 个任务` : '任务已派发';
  }
  return NOTIFICATION_LABELS[subject] ?? '收到系统通知';
}

export function notificationTone(subject: string): 'success' | 'warning' | 'neutral' {
  if (subject === 'plan-approved' || subject === 'child-accepted') return 'success';
  return notificationCategory(subject) === 'blocker_report' || subject === 'budget-refused' || subject === 'issue-opened'
    ? 'warning' : 'neutral';
}

/** Retain structured evidence as well as the sender's prose. */
export function communicationBody(content: unknown): string {
  const { category: _category, transaction_id: _transaction, subject: _subject, text, ...evidence } = communicationContent(content);
  if (text !== undefined && typeof text !== 'string') evidence.text = text;
  return [typeof text === 'string' ? text : '', Object.keys(evidence).length ? `\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`` : ''].filter(Boolean).join('\n\n');
}

/** Runtime events are classified from their producer, never guessed from prose. */
export function notificationCategory(subject: string): FlowCommunicationCategory {
  switch (subject) {
    case 'plan-dispatched': case 'transaction-modified': case 'goal-changed': return 'task_instruction';
    case 'load-changed': return 'progress_update';
    case 'result-submitted': case 'child-accepted': return 'result_report';
    case 'plan-audit-requested': case 'validation-audit-requested': case 'plan-approved':
    case 'issue-opened': case 'auditor-notified': case 'auditor-recommended': return 'review_feedback';
    case 'blackboard': return 'collaboration_request';
    case 'escalation': case 'child-blocked': case 'transaction-stale': case 'result-withheld':
    case 'agent-anomaly': return 'blocker_report';
    case 'budget-refused': case 'context-pressure': case 'context-pressure-notice': return 'resource_coordination';
    default: return 'discussion';
  }
}

export const NOTIFICATION_LABELS: Readonly<Record<string, string>> = {
  'plan-dispatched': '任务已派发', 'transaction-modified': '任务已调整', 'goal-changed': '任务目标已变更',
  'load-changed': '执行负载已更新', 'result-submitted': '任务结果已提交', 'child-accepted': '下级结果已接受',
  'plan-audit-requested': '请审查任务计划', 'validation-audit-requested': '请复核验收结论', 'plan-approved': '计划审查通过',
  'issue-opened': '发现需要纠正的问题', 'auditor-notified': '审核通知', 'auditor-recommended': '审核建议',
  'blackboard': '共享信息已更新', 'escalation': '请求上级处理', 'child-blocked': '下级执行受阻',
  'transaction-stale': '任务长期未推进', 'result-withheld': '任务结果暂未发布', 'agent-anomaly': '智能体执行异常',
  'budget-refused': '资源额度不足', 'context-pressure': '需要处理上下文压力', 'context-pressure-notice': '上下文压力提醒',
};

/** Stable incoming proof marker, retained when messages are delivered separately. */
export const DELIVERY_MARKER = '[[flow-delivery';

export interface FlowCommunicationSource {
  readonly kind: 'flow-message';
  /** Public Chat presentation hint: never fold this message into model process. */
  readonly presentation: 'communication';
  readonly category: FlowCommunicationCategory;
  readonly run_id: string;
  readonly message_id: string;
  readonly sender_id: string | null;
  readonly sender_name: string;
  readonly recipient_id: string;
  readonly recipient_name: string;
  readonly transaction_id: string | null;
  readonly subject: string;
  /** Compact UI caption; the full subject and evidence remain in the detail. */
  readonly display_summary: string;
  readonly tone: 'success' | 'warning' | 'neutral';
  readonly sent_at: number;
  /** Characters occupied by the model-facing framing and receipt marker. */
  readonly body_offset: number;
  readonly form: 'notice';
  readonly summary: string;
}
