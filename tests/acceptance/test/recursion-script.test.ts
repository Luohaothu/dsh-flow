import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import { buildScenario } from '../../../src/host/mock-scenarios.ts';
import { asRecord } from '../../../src/host/mock-model.ts';
import type { MockRequestRecord, MockScenarioReply } from '../../../src/host/mock-model.ts';

function auditRequest(item: Record<string, unknown>, answer?: unknown): MockRequestRecord {
  return fromPartial<MockRequestRecord>({ classified: {
    kind: 'role', role: 'auditor', agentId: 'auditor', nodeId: 'node', transactionId: null,
    digest_source: 'older', digest: { pending_actions: [item] },
    lastToolName: answer === undefined ? null : 'flow_audit',
    lastToolResult: answer === undefined ? null : JSON.stringify(answer),
  } });
}

function command(reply: MockScenarioReply | null) {
  const tool = reply?.toolCalls?.[0];
  assert.ok(tool);
  assert.equal(tool.name, 'flow_audit');
  const args = asRecord(JSON.parse(String(tool.arguments)));
  assert.ok(args);
  return { action: args.action, params: asRecord(args.params) ?? {} };
}

test('recursion retries failed corrections and suppresses only acknowledged unchanged evidence', async () => {
  const scenario = buildScenario({ caseId: 'recursion' });
  const item = { action: 'request_replan', transaction_id: 'tx', refusal_seqs: [199], reason: 'write refused' };
  const respond = (answer?: unknown, pending = item) => scenario.respond(auditRequest(pending, answer));
  assert.equal(command(await respond()).action, 'request_replan');
  assert.equal(command(await respond({ ok: false, action: 'request_replan', result: { transaction_id: 'tx', issue_id: 'failed' } })).action, 'request_replan');
  assert.equal(command(await respond({ ok: true, action: 'request_replan', result: { transaction_id: 'tx', evidence: { issue_id: 'nested' } } })).action, 'request_replan');
  assert.equal(command(await respond({ ok: true, action: 'request_replan', result: { transaction_id: 'foreign', issue_id: 'foreign' } })).action, 'request_replan');
  const accepted = { ok: true, action: 'request_replan', result: { transaction_id: 'tx', issue_id: 'issue-a', status: 'DRAFT' } };
  assert.equal((await respond(accepted))?.toolCalls, undefined, 'a successful tool result ends the stale correction');
  assert.equal((await respond())?.toolCalls, undefined, 'an older digest cannot reopen the same correction');
  assert.equal(command(await respond(undefined, { ...item, refusal_seqs: [205] })).action, 'request_replan', 'a new refusal is new evidence');
  assert.equal(command(await respond(undefined, { ...item, transaction_id: 'other' })).action, 'request_replan', 'another transaction remains independent');
});

test('recursion verifies every issue through successful replies before approving replacement work', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'flow-recursion-script-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const scenario = buildScenario({ caseId: 'recursion', workspace });
  const submission = (text: string) => scenario.respond(fromPartial<MockRequestRecord>({ classified: {
    kind: 'worker', transactionId: 'tx', objective: 'write deep/nested/result.txt',
    userText: 'You own these paths (do not write outside them): deep/',
    lastToolName: 'write', lastToolResult: text,
  } }));
  await submission('write refused outside scope');
  const item = { action: 'request_replan', transaction_id: 'tx', refusal_seqs: [199] };
  const first = await scenario.respond(auditRequest(item));
  assert.equal(command(first).action, 'request_replan');
  const answer = (issue: string) => ({ ok: true, action: 'request_replan', result: { transaction_id: 'tx', issue_id: issue, status: 'DRAFT' } });
  const secondItem = { ...item, refusal_seqs: [205] };
  assert.equal(command(await scenario.respond(auditRequest(secondItem, answer('issue-a')))).action, 'request_replan');
  assert.equal((await scenario.respond(auditRequest(secondItem, answer('issue-b'))))?.toolCalls, undefined);
  const validation = { action: 'inspect_validation', transaction_id: 'tx', target_revision: 3 };
  // The Worker has no replacement result yet, so an additional rejected audit
  // is also remembered by its own revision and must not repeat on a stale step.
  assert.equal(command(await scenario.respond(auditRequest(validation))).params.decision, 'reject');
  const rejected = { ok: true, action: 'inspect_validation', result: { transaction_id: 'tx', issue_id: 'issue-c', decision: 'REJECTED' } };
  assert.equal((await scenario.respond(auditRequest(validation, rejected)))?.toolCalls, undefined);
  mkdirSync(join(workspace, 'deep/nested'), { recursive: true });
  writeFileSync(join(workspace, 'deep/nested/result.txt'), '3\n');
  await submission('wrote result.txt');
  const verify = (issue: string, ok = true) => ({ ok, action: 'verify_correction', result: { issue_id: issue, status: 'CORRECTED' } });
  const pending = command(await scenario.respond(auditRequest(validation)));
  assert.equal(pending.action, 'verify_correction');
  assert.equal(pending.params.issue_id, 'issue-a');
  assert.equal(command(await scenario.respond(auditRequest(validation, verify('issue-a', false)))).params.issue_id, 'issue-a', 'failed verification can retry');
  assert.equal(command(await scenario.respond(auditRequest(validation, verify('issue-b')))).params.issue_id, 'issue-a', 'an unrelated successful reply cannot verify another issue');
  assert.equal(command(await scenario.respond(auditRequest(validation, verify('issue-a')))).params.issue_id, 'issue-b');
  assert.equal(command(await scenario.respond(auditRequest(validation, verify('issue-b')))).params.issue_id, 'issue-c');
  const approved = command(await scenario.respond(auditRequest(validation, verify('issue-c'))));
  assert.equal(approved.action, 'inspect_validation');
  assert.equal(approved.params.decision, 'approve');
});
