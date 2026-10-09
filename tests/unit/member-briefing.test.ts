import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { ClusterStore } from '../../packages/dsh-flow/src/core/store.ts';
import { registerRoleTools } from '../../packages/dsh-flow/src/core/role-tools.ts';
import { memberBriefing, ROLE_SYSTEM_INSTRUCTIONS } from '../../packages/dsh-flow/src/core/briefing.ts';
import { savePlan } from '../../packages/dsh-flow/src/core/contracts.ts';
import type { BoundTurn } from '../../packages/dsh-flow/src/core/briefing.ts';
import type { FlowAgentActor, NodeRecord } from '../../packages/dsh-flow/src/core/model.ts';
import type { TurnOutcome } from '../../packages/dsh-flow/src/core/runtime.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost } from './fake-host.ts';
import { fixturePlan, fixtureParams, fixtureAuditEvidence } from './task-fixtures.ts';

function setup(runtime: ClusterRuntime) {
  const start = runtime.start({ objective: '计算 2+3，并校验结果及独立审核验收。', workspace: '/tmp', capabilities: [],
    acceptance_criteria: ['结果为 5'], budget: { tool_calls: 200, agents: 8, max_active_agents: 4 } });
  const clusterId = start.cluster.id;
  const lead = runtime.store.listAgents(clusterId, { role: 'orchestrator', limit: 1 })[0]!;
  const node = runtime.store.getNode(lead.node_id)!;
  const actor: FlowAgentActor = { cluster_id: clusterId, node_id: node.id, agent_id: lead.id, session_id: lead.session_id, role: 'orchestrator' };
  return { clusterId, lead, node, actor, tx: runtime.store.listTransactions({ cluster_id: clusterId, limit: 1 })[0]! };
}
function add(runtime: ClusterRuntime, clusterId: string, node: NodeRecord, objective: string) {
  return runtime.createTransactionInternal(clusterId, node, { objective, acceptance_criteria: ['交付指定结果'] }, { local: true });
}

test('all member roles share stable system rules and explicit native input kinds', () => {
  const binding = { agent_id: 'actual-agent', turn_seq: 1, object: { kind: 'transaction', id: 'actual-task' }, transaction_id: 'actual-task', allocation_id: null,
    plan_ref: { transaction_id: 'actual-task', prepared_revision: 2 }, validation_ref: null, revision: 2, read_version: 9, stale: false, current_revision: 2,
    current_plan_ref: { transaction_id: 'actual-task', prepared_revision: 2 } };
  for (const role of ['orchestrator', 'allocator', 'auditor', 'worker'] as const) {
    const turn: BoundTurn = { agent_id: 'actual-agent', role, node_id: 'actual-domain', turn_seq: 1, input_kind: 'initial', input_key: 'actual-input', author: 'actual-manager',
      binding, title: '加法', brief: '请计算 2+3，只使用纯文本。', notice: '有新的交付待校验。', previous_plan_ref: null, context: {} };
    const first = memberBriefing.prepareTurn(turn);
    assert.equal(first.systemInstructions, ROLE_SYSTEM_INSTRUCTIONS[role]);
    assert.equal(first.prompt, turn.brief);
    assert.doesNotMatch(first.prompt, /Role:|STATUS:|actual-agent|actual-domain|pending_actions|Current domain state/);
    const wake = memberBriefing.prepareTurn({ ...turn, input_kind: 'wake' });
    assert.equal(wake.prompt, turn.notice);
    assert.equal(wake.input.kind, 'wake');
  }
});

test('agenda continues an actor-bound frozen ordering while new work appears', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const { clusterId, node, actor } = setup(runtime);
  for (let index = 0; index < 70; index += 1) add(runtime, clusterId, node, `工作 ${index}`);
  const first = runtime.query(actor, 'agenda', { limit: 3 });
  assert.equal(first.total, 71, 'query coverage extends beyond the scheduler admission window');
  assert.equal(first.items[0]?.kind, 'prepare_plan');
  assert.ok(first.items.every(item => item.transaction_id && item.revision !== null));
  add(runtime, clusterId, node, '之后到达的新工作');
  const seen = first.items.map(item => item.object.id);
  let offset = first.next_offset;
  while (offset !== null) {
    const page = runtime.query(actor, 'agenda', { limit: 8, offset, snapshot_id: first.snapshot_id });
    assert.equal(page.total, 71);
    seen.push(...page.items.map(item => item.object.id));
    offset = page.next_offset;
  }
  assert.equal(new Set(seen).size, 71);
  assert.equal(runtime.query(actor, 'agenda').total, 72);
  const allocator = runtime.store.listAgents(clusterId, { role: 'allocator', limit: 1 })[0]!;
  assert.throws(() => runtime.query({ ...actor, agent_id: allocator.id, session_id: allocator.session_id, role: 'allocator' }, 'agenda', { snapshot_id: first.snapshot_id }), /another actor/);
  assert.throws(() => runtime.query(actor, 'agenda', { offset: 3 }), /requires snapshot_id/);
});

test('large contract fields are complete, immutable pages with explicit projection metadata', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const { actor, tx } = setup(runtime);
  const oldInput = '原始材料'.repeat(3_000);
  runtime.store.updateTransaction(tx.id, { inputs: { text: oldInput } });
  const answer = objectField(runtime.query(actor, 'transaction', { id: tx.id, fields: ['inputs'] }), 'answer');
  assert.equal(answer.projection, true);
  assert.equal(answer.requirements, undefined);
  const value = objectField(answer.inputs, 'inputs');
  assert.equal(value.complete, false);
  assert.equal(value.length, JSON.stringify({ text: oldInput }).length);
  const snapshotId = String(value.snapshot_id);
  runtime.store.updateTransaction(tx.id, { inputs: { text: '新材料' } });
  let offset = 0;
  let assembled = '';
  for (;;) {
    const page = objectField(runtime.query(actor, 'transaction', { id: tx.id, fields: ['inputs'], content_field: 'inputs', content_snapshot_id: snapshotId, content_offset: offset, content_limit: 1_000 }), 'page');
    const content = objectField(page.inputs, 'content');
    assembled += String(content.content);
    assert.equal(objectField(page.binding, 'binding').stale, true);
    if (content.next_offset === null) break;
    offset = Number(content.next_offset);
  }
  assert.deepEqual(JSON.parse(assembled), { text: oldInput });
  assert.throws(() => runtime.query(actor, 'transaction', { id: tx.id, fields: ['arbitrary_SQL'] }), /available fields/);
});

test('native assignment remains on its original task and reports a business revision as stale', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, tx, clusterId, node } = setup(runtime);
  let checked = false;
  host.setScript(async turn => {
    const first = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['brief', 'requirements', 'constraints'] } })).value)), 'first');
    const binding = objectField(first.binding, 'binding');
    assert.equal(binding.transaction_id, tx.id);
    const requirements = objectField(first.requirements, 'requirements');
    runtime.store.updateTransaction(tx.id, { objective: '已修订的新要求' });
    add(runtime, clusterId, node, '另一项新工作');
    const next = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['requirements'] } })).value)), 'next');
    const laterBinding = objectField(next.binding, 'binding');
    assert.equal(laterBinding.transaction_id, tx.id);
    assert.equal(laterBinding.stale, true);
    assert.deepEqual(next.requirements, requirements, 'the input contract does not silently become the newest row');
    checked = true;
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(actor.agent_id)?.promise;
  assert.equal(checked, true);
});

test('ordinary state revisions preserve current plan supervision and auditors read scheduler validation', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const { actor, tx, clusterId, node } = setup(runtime);
  runtime.command(actor, { command_id: 'prepare-direct', action: 'dispatch', params: { transaction_id: tx.id,
    expected_transaction_revision: tx.revision, plan: fixturePlan(tx) } });
  const planned = runtime.store.getTransaction(tx.id)!;
  const planRef = planned.current_plan_ref;
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED' });
  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor', limit: 1 })[0]!;
  const auditActor: FlowAgentActor = { ...actor, role: 'auditor', agent_id: auditor.id, session_id: auditor.session_id };
  const agenda = runtime.query(auditActor, 'agenda');
  assert.ok(agenda.items.some(item => item.kind === 'review_plan' && JSON.stringify(item.plan_ref) === JSON.stringify(planRef)));
  assert.equal(agenda.items.some(item => item.kind === 'review_validation'), false, 'Worker output alone creates no auditor acceptance duty');
  const planWork = agenda.items.find(item => item.kind === 'review_plan')!;
  const detail = objectField(runtime.query(auditActor, 'audit', { id: planWork.object.id }), 'audit detail');
  assert.equal(objectField(detail.plan, 'plan').ref && JSON.stringify(objectField(detail.plan, 'plan').ref), JSON.stringify(planRef));
  assert.equal(runtime.pendingFor('orchestrator', node, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(actor.agent_id)).some(item => item.action === 'validate'), true);
});

test('single worker uses a user-authored direct contract and publishes only a completed native turn', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  host.setScript(async turn => {
    const assigned = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['brief', 'requirements'] } })).value)), 'assignment');
    const binding = objectField(assigned.binding, 'binding');
    await turn.callTool('flow_transaction', { action: 'submit_result', params: { transaction_id: binding.transaction_id, result: { answer: 5, explanation: '2 加 3 得 5。' } } });
  });
  const result = await runtime.runSingleAgent({ objective: '计算 2+3，只使用纯文本。', workspace: '/tmp', capabilities: [], budget: { tool_calls: 50 }, acceptance_criteria: ['结果为 5'] });
  const tx = runtime.store.listTransactions({ cluster_id: result.cluster_id, limit: 1 })[0]!;
  const agents = runtime.store.listAgents(result.cluster_id);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.role, 'worker');
  assert.equal(runtime.store.getPlan(tx.current_plan_ref)?.author_role, 'user');
  assert.equal(runtime.store.getCluster(result.cluster_id)?.status, 'COMPLETED');
  const publication = runtime.store.getResult(tx.current_result_ref);
  assert.equal(publication?.producer_agent_id, agents[0]?.id);
  assert.equal(publication?.turn_seq, 1);
  assert.deepEqual(publication?.result, { answer: 5, explanation: '2 加 3 得 5。' });

  host.setScript(async turn => {
    const assigned = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
    await turn.callTool('flow_transaction', { action: 'submit_result', params: { transaction_id: objectField(assigned.binding, 'binding').transaction_id, result: { answer: 5 } } });
    throw new Error('native execution failed after staging its proposal');
  });
  const failed = await runtime.runSingleAgent({ objective: '计算 2+3', workspace: '/tmp', capabilities: [], budget: { tool_calls: 50 }, acceptance_criteria: ['结果为 5'] });
  const failedTx = runtime.store.listTransactions({ cluster_id: failed.cluster_id, limit: 1 })[0]!;
  assert.equal(runtime.store.getCluster(failed.cluster_id)?.status, 'FAILED');
  assert.equal(failedTx.current_result_ref, null);
  assert.equal(failedTx.result, null);
});

test('alternating plan and validation audits use unique wakes instead of replaying a revision delivery', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, tx, clusterId, node } = setup(runtime);
  const other = add(runtime, clusterId, node, '另一项结果交付');
  for (const work of [tx, other]) runtime.command(actor, { command_id: `prepare:${work.id}`, action: 'dispatch',
    params: { transaction_id: work.id, expected_transaction_revision: work.revision, plan: fixturePlan(work) } });
  for (const role of ['allocator', 'orchestrator'] as const) {
    const member = runtime.store.listAgents(clusterId, { role, limit: 1 })[0]!;
    runtime.store.updateAgent(member.id, { status: 'BLOCKED' });
  }
  let decisions = 0;
  host.setScript(async turn => {
    const assignment = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['audit'] } })).value)), 'assignment');
    const audit = objectField(assignment.audit, 'audit');
    const result = await turn.callTool('flow_audit', { action: audit.kind === 'plan' ? 'inspect_plan' : 'inspect_validation', params: {
      audit_id: audit.id, decision: 'approve', evidence: fixtureAuditEvidence(runtime, String(audit.transaction_id), audit.kind === 'plan' ? 'plan' : 'validation') } });
    assert.equal(result.isError, false);
    decisions += 1;
  });
  runtime.enableScheduling();
  const step = async () => { await runtime.tick(); await Promise.all(runtime.activeTurnIds().map(id => runtime.activeTurnFor(id)!.promise)); };
  await step();
  await step();
  assert.equal(decisions, 2);
  for (const work of [tx, other]) {
    runtime.store.updateTransaction(work.id, { status: 'SUBMITTED', result: { delivered: work.objective } });
    runtime.command(actor, { command_id: `validate:${work.id}`, action: 'validate', params: fixtureParams(runtime, actor, 'validate', {
      transaction_id: work.id, accepted: true, checks: [{ passed: true, evidence: 'The fixture output was inspected against the complete formal requirement.' }] }) });
    await step();
  }
  assert.equal(decisions, 4);
  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor', limit: 1 })[0]!;
  const inputs = runtime.store.all('SELECT kind,delivery_key FROM member_inputs WHERE agent_id=? ORDER BY created,rowid', auditor.id);
  assert.equal(inputs.filter(row => row.kind === 'initial').length, 1);
  assert.equal(inputs.filter(row => row.kind === 'revision').length, 0, 'a different work object does not mean its formal contract changed');
  assert.equal(new Set(inputs.map(row => row.delivery_key)).size, inputs.length);
});

test('a pending native delivery preserves explicit null authors and plan references when restored', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, tx, clusterId, lead } = setup(runtime);
  runtime.command(actor, { command_id: 'prepare-before-recovery', action: 'dispatch', params: {
    transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
  } });
  const prepared = runtime.store.getTransaction(tx.id)!;
  runtime.store.updateTransaction(tx.id, { status: 'DRAFT', __bump_revision: false });
  const previous = runtime.store.saveMemberInput({ cluster_id: clusterId, agent_id: lead.id, session_id: lead.session_id,
    delivery_key: 'earlier-admitted', kind: 'initial', author: { role: 'user' }, plan_ref: prepared.current_plan_ref,
    previous_plan_ref: null, binding: null, content: '此前委托', native_message_id: 'earlier-native-message' });
  runtime.store.acknowledgeMemberInput(previous.id);
  const binding = { agent_id: lead.id, turn_seq: 1, object: { kind: 'transaction', id: tx.id }, transaction_id: tx.id,
    allocation_id: null, plan_ref: null, validation_ref: null, revision: tx.revision, read_version: 1, stale: false,
    current_revision: tx.revision, current_plan_ref: null, title: tx.objective, brief: '原始恢复内容',
    context_snapshot: { requirements: { objective: tx.objective }, constraints: [], inputs: {} } };
  const pending = runtime.store.saveMemberInput({ cluster_id: clusterId, agent_id: lead.id, session_id: lead.session_id,
    delivery_key: 'restored-pending', kind: 'wake', author: null, plan_ref: null, previous_plan_ref: null,
    binding, content: '请继续原始已绑定任务。', native_message_id: 'pending-native-message' });
  let checked = false;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id !== lead.id) return;
    for (const input of turn.inputs) turn.emit('user/message', input);
    const answer = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['requirements'] } })).value)), 'assignment');
    assert.equal(objectField(answer.binding, 'binding').plan_ref, null);
    checked = true;
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(lead.id)?.promise;
  assert.equal(checked, true, 'recovery must not rewrite the pending delivery and fail admission');
  const delivered = runtime.store.getMemberInput(pending.id)!;
  assert.equal(delivered.status, 'ADMITTED');
  assert.equal(delivered.author, null);
  assert.equal(delivered.plan_ref, null);
  assert.equal(delivered.previous_plan_ref, null);
  assert.equal(delivered.native_message_id, 'pending-native-message');
});

test('Worker publication requires its current allocation, exact native turn and settled side effects', async t => {
  for (const obstruction of ['STARTED', 'UNKNOWN', 'EFFECT_UNCERTAIN', 'released-allocation', 'changed-plan', 'foreign-turn', 'expired-lease'] as const) {
    await t.test(obstruction, async child => {
      const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
      child.after(() => runtime.dispose());
      const { actor, tx, clusterId } = setup(runtime);
      runtime.command(actor, { command_id: 'prepare-worker', action: 'dispatch', params: {
        transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
      } });
      const allocator = runtime.store.listAgents(clusterId, { role: 'allocator', limit: 1 })[0]!;
      runtime.command({ ...actor, role: 'allocator', agent_id: allocator.id, session_id: allocator.session_id }, {
        command_id: 'allocate-worker', action: 'allocate_agent', params: { transaction_id: tx.id },
      });
      const allocation = runtime.store.activeAllocationForTransaction(tx.id)!;
      const worker = runtime.store.getAgent(allocation.agent_id)!;
      runtime.store.updateTransaction(tx.id, { status: 'RUNNING', result: { answer: 5 }, result_staged_agent: worker.id,
        result_staged_epoch: 7, result_staged_turn: 1, __bump_revision: false });
      const lease = runtime.store.createLease({ id: 'worker-lease', cluster_id: clusterId, agent_id: worker.id,
        node_id: worker.node_id, purpose: 'worker-turn', epoch: 7,
        expires: obstruction === 'expired-lease' ? runtime.timestamp() - 1 : runtime.timestamp() + 60_000 });
      assert.ok(lease);
      if (obstruction === 'released-allocation') runtime.store.updateAllocation(allocation.id, { status: 'RELEASED' });
      else if (obstruction === 'changed-plan') runtime.store.updateTransaction(tx.id, { current_plan_ref: null, __bump_revision: false });
      else if (['STARTED', 'UNKNOWN', 'EFFECT_UNCERTAIN'].some(value => value === obstruction)) {
        runtime.store.insertEffect({ call_id: 'unsettled-write', cluster_id: clusterId, agent_id: worker.id, node_id: worker.node_id,
          session_id: worker.session_id, lease_epoch: 7, turn_seq: 1, tool: 'write', args: { file_path: 'output.txt' },
          status: obstruction === 'STARTED' ? 'STARTED' : obstruction === 'UNKNOWN' ? 'UNKNOWN' : 'EFFECT_UNCERTAIN' });
      }
      const outcome: TurnOutcome = { native_seq: null, events: [], assistant: [], usage: [], toolCalls: [], stopReason: 'completed',
        completed: true, finalText: 'completed', missing_capability_tools: [], admitted: true, stopDetail: null };
      runtime.finishWorkerTurn(runtime.store.getCluster(clusterId)!, worker, runtime.store.getTransaction(tx.id)!, allocation, {
        outcome, error: null, before: runtime.store.latestEventSeq(clusterId), lease, admitted: true, durable: true,
        turnSeq: obstruction === 'foreign-turn' ? 2 : 1,
      });
      const withheld = runtime.store.getTransaction(tx.id)!;
      assert.equal(withheld.current_result_ref, null, 'unsafe completion creates no immutable publication');
      assert.notEqual(withheld.status, 'SUBMITTED');
      if (obstruction === 'foreign-turn' || obstruction === 'expired-lease') assert.deepEqual(withheld.result, { answer: 5 }, 'an unrelated staged proposal survives the finisher');
    });
  }
});

test('a prepared decomposition without child work offers actual decomposition instead of impossible dispatch', async t => {
  const runtime = new ClusterRuntime(new Context(), { path: ':memory:', autoTick: false });
  t.after(() => runtime.dispose());
  const { actor, tx, clusterId, node } = setup(runtime);
  const plan = memberBriefing.preparePlan(runtime.store, tx, actor, fixturePlan(tx, 'decompose'));
  savePlan(runtime.store, tx, plan);
  assert.equal(runtime.store.getTransaction(tx.id)?.status, 'DRAFT');
  assert.equal(runtime.pendingFor('orchestrator', node, runtime.store.getCluster(clusterId)!, runtime.store.getAgent(actor.agent_id))
    .find(item => item.transaction_id === tx.id)?.action, 'decompose');
  const agenda = runtime.query(actor, 'agenda');
  const work = agenda.items.find(item => item.transaction_id === tx.id)!;
  assert.equal(work.kind, 'prepare_plan');
  assert.equal(objectField(work.details, 'details').action, 'decompose');
});

test('an unbound native instance cannot borrow a scheduled instance assignment', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, tx, lead } = setup(runtime);
  let checked = false;
  let callbackFailure: unknown = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id !== lead.id) return;
    try {
    const bound = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
    assert.equal(objectField(bound.binding, 'binding').transaction_id, tx.id);
    const handle = await host.ctx.agents.create({ sessionId: SessionId(lead.session_id), setup: async scope => {
      registerRoleTools(scope, runtime, 'orchestrator');
    } });
    try {
      const unbound = host.lastTurn!;
      assert.notEqual(unbound, turn);
      await assert.rejects(() => unbound.callTool('flow_query', { what: 'assignment' }), /does not own a scheduled cluster turn/);
      const ordinary = await unbound.callTool('flow_query', { what: 'cluster' });
      assert.equal(ordinary.isError, false, 'ordinary read-only queries retain the existing identity-scoped boundary');
      checked = true;
    } finally { await handle.dispose(); }
    } catch (error) { callbackFailure = error; throw error; }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(actor.agent_id)?.promise;
  if (callbackFailure) throw callbackFailure;
  assert.equal(checked, true);
});

test('Worker and standalone publication keep the lease check and commit under one SQLite write lock', async t => {
  for (const standalone of [false, true]) {
    await t.test(standalone ? 'standalone' : 'team Worker', async child => {
      const dir = mkdtempSync(join(tmpdir(), 'flow-publication-lock-'));
      const path = join(dir, 'flow.sqlite');
      const host = createFakeHost();
      const runtime = new ClusterRuntime(host.ctx, { path, autoTick: false });
      const competitor = new ClusterStore(path);
      competitor.run('PRAGMA busy_timeout=0');
      child.after(async () => { competitor.close(); await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); });
      const originalCheck = runtime.leaseStillHeld.bind(runtime);
      let checked = 0;
      runtime.leaseStillHeld = lease => {
        checked += 1;
        assert.equal(runtime.store.inTransaction, true, 'lease ownership is read under the publication write transaction');
        assert.throws(() => competitor.tx(() => {
          competitor.deleteLease(lease.id);
          competitor.createLease({ ...lease, id: 'replacement-publication-lease', epoch: lease.epoch + 1 });
        }), /locked|busy/, 'a second database connection cannot claim replacement work in the release-to-publication interval');
        return originalCheck(lease);
      };
      if (standalone) {
        host.setScript(async turn => {
          const assigned = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
          await turn.callTool('flow_transaction', { action: 'submit_result', params: {
            transaction_id: objectField(assigned.binding, 'binding').transaction_id, result: { answer: 5 },
          } });
        });
        const result = await runtime.runSingleAgent({ objective: '计算2+3', workspace: dir, capabilities: [], acceptance_criteria: ['结果为5'], budget: { tool_calls: 50 } });
        const tx = runtime.store.listTransactions({ cluster_id: result.cluster_id, limit: 1 })[0]!;
        assert.deepEqual(runtime.store.getResult(tx.current_result_ref)?.result, { answer: 5 });
      } else {
        const { actor, tx, clusterId } = setup(runtime);
        runtime.command(actor, { command_id: 'prepare-locked-worker', action: 'dispatch', params: {
          transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
        } });
        const allocator = runtime.store.listAgents(clusterId, { role: 'allocator', limit: 1 })[0]!;
        runtime.command({ ...actor, role: 'allocator', agent_id: allocator.id, session_id: allocator.session_id }, {
          command_id: 'allocate-locked-worker', action: 'allocate_agent', params: { transaction_id: tx.id },
        });
        const allocation = runtime.store.activeAllocationForTransaction(tx.id)!;
        const worker = runtime.store.getAgent(allocation.agent_id)!;
        runtime.store.updateTransaction(tx.id, { status: 'RUNNING', result: { answer: 5 }, result_staged_agent: worker.id,
          result_staged_epoch: 7, result_staged_turn: 1, __bump_revision: false });
        const lease = runtime.store.createLease({ id: 'worker-publication-lease', cluster_id: clusterId, agent_id: worker.id,
          node_id: worker.node_id, purpose: 'worker-turn', epoch: 7, expires: runtime.timestamp() + 60_000 });
        assert.ok(lease);
        runtime.finishWorkerTurn(runtime.store.getCluster(clusterId)!, worker, runtime.store.getTransaction(tx.id)!, allocation, {
          outcome: { native_seq: null, events: [], assistant: [], usage: [], toolCalls: [], stopReason: 'completed', completed: true,
            finalText: 'done', missing_capability_tools: [], admitted: true, stopDetail: null },
          error: null, before: runtime.store.latestEventSeq(clusterId), lease, admitted: true, durable: true, turnSeq: 1,
        });
        assert.deepEqual(runtime.store.getResult(runtime.store.getTransaction(tx.id)?.current_result_ref)?.result, { answer: 5 });
      }
      assert.equal(checked, 1);
      assert.equal(competitor.getLease('replacement-publication-lease'), null);
    });
  }
});

test('standalone completion with an expired or replacement lease or unknown effect cannot publish', async t => {
  for (const obstruction of ['expired-lease', 'replacement-lease', 'UNKNOWN'] as const) {
    await t.test(obstruction, async child => {
      const host = createFakeHost();
      const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
      child.after(async () => { await runtime.dispose(); await host.dispose(); });
      host.setScript(async turn => {
        const assigned = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
        const binding = objectField(assigned.binding, 'binding');
        const transactionId = String(binding.transaction_id);
        await turn.callTool('flow_transaction', { action: 'submit_result', params: { transaction_id: transactionId, result: { answer: 5 } } });
        const worker = runtime.store.getAgent(String(binding.agent_id))!;
        const lease = runtime.store.leaseForAgent(worker.id)!;
        if (obstruction === 'expired-lease') runtime.store.touchLease(lease.id, runtime.timestamp() - 1);
        else if (obstruction === 'replacement-lease') {
          runtime.store.deleteLease(lease.id);
          runtime.store.createLease({ ...lease, id: 'replacement-single-lease', epoch: lease.epoch + 1 });
          runtime.store.updateTransaction(transactionId, { result: { answer: 'replacement' }, result_staged_epoch: lease.epoch + 1,
            result_staged_turn: 2, result_staged_agent: worker.id, __bump_revision: false });
        } else runtime.store.insertEffect({ call_id: 'unknown-single-write', cluster_id: worker.cluster_id, agent_id: worker.id,
          node_id: worker.node_id, session_id: worker.session_id, lease_epoch: lease.epoch, turn_seq: 1,
          tool: 'write', args: { file_path: 'output.txt' }, status: 'UNKNOWN' });
      });
      const result = await runtime.runSingleAgent({ objective: '计算2+3', workspace: '/tmp', capabilities: [], acceptance_criteria: ['结果为5'], budget: { tool_calls: 50 } });
      const tx = runtime.store.listTransactions({ cluster_id: result.cluster_id, limit: 1 })[0]!;
      assert.equal(tx.current_result_ref, null);
      assert.notEqual(runtime.store.getCluster(result.cluster_id)?.status, 'COMPLETED');
      if (obstruction === 'UNKNOWN') assert.equal(tx.result, null, 'uncertain work leaves no published or staged proposal');
      else assert.deepEqual(tx.result, { answer: obstruction === 'replacement-lease' ? 'replacement' : 5 }, 'a fenced finisher does not clear another execution proposal');
    });
  }
});

test('a later Auditor turn reads its old large assignment as stale without changing the validation or object', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, tx, clusterId } = setup(runtime);
  runtime.command(actor, { command_id: 'prepare-paged-audit', action: 'dispatch', params: {
    transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
  } });
  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor', limit: 1 })[0]!;
  const auditActor: FlowAgentActor = { ...actor, role: 'auditor', agent_id: auditor.id, session_id: auditor.session_id };
  runtime.command(auditActor, { command_id: 'approve-paged-plan', action: 'inspect_plan', params: fixtureParams(runtime, auditActor, 'inspect_plan', {
    transaction_id: tx.id, decision: 'approve',
  }) });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { answer: 5 } });
  const originalNotes = '原始验收观察。'.repeat(2_000);
  runtime.command(actor, { command_id: 'original-paged-validation', action: 'validate', params: fixtureParams(runtime, actor, 'validate', {
    transaction_id: tx.id, accepted: true, notes: originalNotes, checks: [{ passed: true, evidence: 'The published answer was checked against the formal result criterion.' }],
  }) });
  const originalValidation = runtime.store.getTransaction(tx.id)!.current_validation_ref;
  for (const role of ['orchestrator', 'allocator'] as const) {
    const member = runtime.store.listAgents(clusterId, { role, limit: 1 })[0]!;
    runtime.store.updateAgent(member.id, { status: 'BLOCKED' });
  }
  let snapshotId = '';
  let originalBinding: Record<string, unknown> | null = null;
  let checked = false;
  let callbackFailure: unknown = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id !== auditor.id) return;
    try {
      for (const input of turn.inputs) turn.emit('user/message', input);
      const current = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: { fields: ['validation'] } })).value)), 'assignment');
      if (!snapshotId) {
        originalBinding = objectField(current.binding, 'original binding');
        snapshotId = String(objectField(current.validation, 'validation reference').snapshot_id);
        assert.deepEqual(originalBinding.validation_ref, originalValidation);
        return;
      }
      const currentBinding = objectField(current.binding, 'current binding');
      assert.notDeepEqual(currentBinding.validation_ref, originalValidation);
      assert.notDeepEqual(currentBinding.object, originalBinding!.object, 'the native turn now owns a different audit object');
      let offset = 0;
      let assembled = '';
      for (;;) {
        const page = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: {
          fields: ['validation'], content_field: 'validation', content_snapshot_id: snapshotId, content_offset: offset, content_limit: 2_000,
        } })).value)), 'original page');
        const binding = objectField(page.binding, 'original page binding');
        assert.equal(binding.stale, true);
        assert.deepEqual(binding.validation_ref, originalValidation);
        assert.deepEqual(binding.object, originalBinding!.object);
        const content = objectField(page.validation, 'validation page');
        assembled += String(content.content);
        if (content.next_offset === null) break;
        offset = Number(content.next_offset);
      }
      const retained = objectField(JSON.parse(assembled), 'retained validation');
      assert.deepEqual(retained.ref, originalValidation);
      assert.equal(retained.notes, originalNotes);
      const live = runtime.store.getTransaction(tx.id)!;
      runtime.command(actor, { command_id: 'revoke-plan-during-paged-audit', action: 'adjust_transaction', params: {
        transaction_id: tx.id, expected_transaction_revision: live.revision, objective: '修订目标并重新准备方案',
      } });
      const withdrawn = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment', params: {
        fields: ['validation'], content_field: 'validation', content_snapshot_id: snapshotId, content_offset: 0, content_limit: 32_000,
      } })).value)), 'withdrawn-plan page');
      const withdrawnBinding = objectField(withdrawn.binding, 'withdrawn-plan binding');
      assert.equal(withdrawnBinding.stale, true);
      assert.equal(withdrawnBinding.current_plan_ref, null, 'an explicitly revoked plan does not fall back to the historical plan');
      assert.deepEqual(withdrawnBinding.plan_ref, originalBinding!.plan_ref);
      assert.equal(objectField(JSON.parse(String(objectField(withdrawn.validation, 'withdrawn-plan validation').content)), 'original validation').notes, originalNotes);
      checked = true;
    } catch (error) { callbackFailure = error; throw error; }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(auditor.id)?.promise;
  if (callbackFailure) throw callbackFailure;
  assert.ok(snapshotId);
  runtime.command(auditActor, { command_id: 'request-paged-revalidation', action: 'request_revalidation', params: {
    transaction_id: tx.id, required_change: 'Record the second actual checking attempt as a new validation.',
  } });
  runtime.command(actor, { command_id: 'new-paged-validation', action: 'validate', params: fixtureParams(runtime, actor, 'validate', {
    transaction_id: tx.id, accepted: true, notes: '新的验收记录，与原记录分开保存。',
    checks: [{ passed: true, evidence: 'The current published answer was checked again against the complete formal requirement.' }],
  }) });
  await runtime.tick();
  await runtime.activeTurnFor(auditor.id)?.promise;
  if (callbackFailure) throw callbackFailure;
  assert.equal(checked, true);
});

test('native Allocator keeps task constraints local while its agenda covers the management domain', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const { actor, clusterId, node } = setup(runtime);
  const division = runtime.createTransactionInternal(clusterId, node, {
    objective: '计算 144÷12 并提交除法局部交付', expected_output: '纯文本：结果 12 及除法依据',
    acceptance_criteria: ['结果为 12，附除法依据'], constraints: ['只处理除法部分，不涉及 17×23'], priority: 10,
  }, { local: true });
  const multiply = runtime.createTransactionInternal(clusterId, node, {
    objective: '计算 17×23 并提交乘法局部交付', expected_output: '纯文本：结果 391 及乘法依据',
    acceptance_criteria: ['结果为 391，附乘法依据'], constraints: ['只处理乘法部分'], priority: 0,
  }, { local: true });
  for (const work of [division, multiply]) runtime.command(actor, {
    command_id: `prepare-scope:${work.id}`, action: 'dispatch', params: {
      transaction_id: work.id, expected_transaction_revision: work.revision, plan: fixturePlan(work),
    },
  });
  const allocator = runtime.store.listAgents(clusterId, { node_id: node.id, role: 'allocator', limit: 1 })[0]!;
  for (const role of ['orchestrator', 'auditor'] as const) {
    const member = runtime.store.listAgents(clusterId, { node_id: node.id, role, limit: 1 })[0]!;
    runtime.store.updateAgent(member.id, { status: 'BLOCKED' });
  }
  let initialId: string | null = null;
  let checked = false;
  let callbackFailure: unknown = null;
  host.setScript(async turn => {
    if (runtime.store.getAgentBySession(turn.session.id)?.id !== allocator.id) return;
    try {
      const initial = turn.inputs.find(message => message.source.kind === 'user');
      assert.ok(initial, 'the first task is an actual native user message');
      initialId = String(initial.id);
      for (const message of turn.inputs) turn.emit('user/message', message);
      const body = initial.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.match(body, /当前资源事项的业务目标：计算 144÷12/);
      assert.match(body, /当前关联任务的交付限制（计算 144÷12[^\n]*）/);
      assert.match(body, /只处理除法部分，不涉及 17×23/);
      assert.doesNotMatch(body, /你负责为本管理域|资源安排职责仍覆盖/, 'fixed role rules belong to system');
      assert.match(ROLE_SYSTEM_INSTRUCTIONS.allocator, /本管理域内所有已准备工作/);
      assert.match(ROLE_SYSTEM_INSTRUCTIONS.allocator, /交付限制仅适用于该任务/);
      const first = objectField(JSON.parse(String((await turn.callTool('flow_query', {
        what: 'assignment', params: { fields: ['brief', 'requirements', 'constraints'] },
      })).value)), 'assignment');
      const binding = objectField(first.binding, 'binding');
      assert.equal(binding.transaction_id, division.id);
      assert.deepEqual(binding.plan_ref, runtime.store.getTransaction(division.id)?.current_plan_ref);
      assert.deepEqual(first.constraints, ['只处理除法部分，不涉及 17×23']);
      const agendaIds: unknown[] = [];
      let page = objectField(JSON.parse(String((await turn.callTool('flow_query', {
        what: 'agenda', params: { limit: 1 },
      })).value)), 'agenda');
      for (;;) {
        assert.ok(Array.isArray(page.items));
        agendaIds.push(...page.items.map(item => objectField(item, 'agenda item').transaction_id));
        if (page.next_offset === null) break;
        page = objectField(JSON.parse(String((await turn.callTool('flow_query', {
          what: 'agenda', params: { limit: 1, offset: page.next_offset, snapshot_id: page.snapshot_id },
        })).value)), 'agenda page');
      }
      assert.ok(agendaIds.includes(division.id));
      assert.ok(agendaIds.includes(multiply.id), 'another business scope is still an Allocator domain duty');
      const after = objectField(JSON.parse(String((await turn.callTool('flow_query', {
        what: 'assignment', params: { fields: ['requirements', 'constraints'] },
      })).value)), 'assignment after agenda');
      assert.deepEqual(after.binding, first.binding, 'reading another domain task never changes this actual turn binding');
      assert.deepEqual(after.requirements, first.requirements);
      assert.deepEqual(after.constraints, first.constraints);
      for (const work of [division, multiply]) {
        const response = await turn.callTool('flow_allocation', { action: 'allocate_agent', params: {
          transaction_id: work.id, plan_ref: runtime.store.getTransaction(work.id)?.current_plan_ref,
          count: 1, capabilities: [], write_scope: [],
        } });
        assert.equal(response.isError, false);
        const allocations = runtime.store.listAllocations({ cluster_id: clusterId, transaction_id: work.id });
        assert.equal(allocations.length, 1);
        assert.equal(allocations[0]?.node_id, node.id);
        assert.deepEqual(allocations[0]?.plan_ref, runtime.store.getTransaction(work.id)?.current_plan_ref);
      }
      checked = true;
    } catch (error) { callbackFailure = error; throw error; }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(allocator.id)?.promise;
  if (callbackFailure) throw callbackFailure;
  assert.equal(checked, true);
  const delivered = runtime.store.memberInputForKey(allocator.id, `initial:${allocator.id}`)!;
  assert.equal(delivered.kind, 'initial');
  assert.equal(delivered.status, 'ADMITTED');
  assert.equal(delivered.native_message_id, initialId);
  assert.equal(objectField(delivered.binding, 'durable binding').transaction_id, division.id);
  assert.deepEqual(runtime.store.getPlan(runtime.store.getTransaction(division.id)?.current_plan_ref)?.contract.constraints,
    ['只处理除法部分，不涉及 17×23'], 'the business contract keeps its original restriction');
});
