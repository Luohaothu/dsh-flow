import { test } from 'node:test';
import assert from 'node:assert/strict';
import { communicationHeadline, notificationHeadline, notificationTone } from '../../packages/dsh-flow/src/messages.ts';

test('compact headlines preserve explicit subjects and never turn body prose into a verdict', () => {
  assert.equal(communicationHeadline({ category: 'review_feedback', text: '审核通过，派发 6 个任务' }), '审查意见');
  assert.equal(communicationHeadline({ category: 'review_feedback', subject: '待复核\n接口结果' }), '待复核 接口结果');
  assert.equal(communicationHeadline({ category: 'review_feedback', subject: '接口评审', summary: '审查意见 · 审核员 · 接口评审' }), '接口评审');
  assert.equal(communicationHeadline({ category: 'review_feedback', subject: '完整原主题', display_summary: '审核已提交' }), '审核已提交');
  assert.equal(communicationHeadline({ category: 'invented' }), '普通讨论');
  const long = communicationHeadline({ subject: '🙂'.repeat(60) });
  assert.equal(Array.from(long).length, 42);
  assert.ok(long.endsWith('…'));
});

test('system counts and visual verdicts follow recorded events, including incomplete and duplicate envelopes', () => {
  assert.equal(notificationHeadline('plan-dispatched', { transaction_id: 'one' }), '派发 1 个任务');
  assert.equal(notificationHeadline('plan-dispatched', { transaction_ids: ['a', 'b', 'a', '', null] }), '派发 2 个任务');
  assert.equal(notificationHeadline('plan-dispatched', { text: '派发 6 个任务' }), '任务已派发');
  assert.equal(notificationHeadline('unknown-event', {}), '收到系统通知');
  assert.equal(notificationTone('plan-audit-requested'), 'neutral');
  assert.equal(notificationTone('validation-audit-requested'), 'neutral');
  assert.equal(notificationTone('plan-approved'), 'success');
  assert.equal(notificationTone('issue-opened'), 'warning');
  assert.equal(notificationTone('result-withheld'), 'warning');
});
