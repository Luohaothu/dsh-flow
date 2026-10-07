import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectNativeSumRoundTrip } from '../qwen-smoke.ts';
import type { RunEvent } from '../context.ts';

const call = { seq: 10, type: 'tool/call', data: { callId: 'sum-call', name: 'flow_sum', arguments: '{"values":[2,3]}' } };
const result = { seq: 11, type: 'tool/result', data: { message: {
  toolCallId: 'sum-call', isError: false, content: [{ type: 'text', text: '5' }],
} } };
const answer = { seq: 12, type: 'assistant/message', data: {
  message: { content: [{ type: 'text', text: '5' }] },
} };

test('a native sum requires a durable matching host result before the assistant answers 5', () => {
  const good = inspectNativeSumRoundTrip([call, result, answer]);
  assert.deepEqual(good, { verified: true, call_id: 'sum-call', call_seq: 10, result_seq: 11, answer_seq: 12 });
  const verdict = (...events: RunEvent[]) => inspectNativeSumRoundTrip(events).verified;
  assert.equal(verdict(call, { ...result, data: { message: { ...result.data.message, toolCallId: 'different-call' } } }, answer), false,
    'a result belonging to another tool call proves nothing');
  assert.equal(verdict(result, { ...call, seq: 12 }, { ...answer, seq: 13 }), false,
    'an earlier result is not the outcome of the later call');
  assert.equal(verdict(call, { ...result, data: { message: { ...result.data.message, isError: true } } }, answer), false,
    'a failed tool is not a completed sum');
  assert.equal(verdict(call, { ...result, data: { message: { ...result.data.message, content: [{ type: 'text', text: '4' }] } } }, answer), false,
    'an assistant saying 5 does not make a wrong tool result correct');
  assert.equal(verdict({ ...answer, seq: 9 }, call, result), false,
    'answering before the host result does not close the round trip');
  assert.equal(verdict({ ...call, data: { ...call.data, arguments: '{"values":[3,3]}' } }, result, answer), false,
    'a different sum does not prove the requested [2,3] path');
});

test('a native sum cannot substitute a submitted transaction value for the assistant reply', () => {
  const command = JSON.stringify({ action: 'submit_result', params: JSON.stringify({ transaction_id: 'tx', result: 5 }) });
  const submission = { seq: 12, type: 'assistant/message', data: { message: { content: [{
    type: 'tool-call', id: 'submission', name: 'flow_transaction', arguments: command,
  }] } } };
  const callEvent = { seq: 13, type: 'tool/call', data: { callId: 'submission', name: 'flow_transaction', arguments: command } };
  const receipt = { seq: 14, type: 'tool/result', data: { message: {
    toolCallId: 'submission', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { transaction_id: 'tx', status: 'STAGED' } }) }],
  } } };
  assert.equal(inspectNativeSumRoundTrip([call, result, submission, callEvent, receipt]).verified, false,
    'a successful submit_result records 5 in the ledger but does not prove a post-tool assistant answer of 5');
});
