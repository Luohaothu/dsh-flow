import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { projectNativeSessionUsage } from '../../packages/dsh-flow/src/core/runtime.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowQueryParams } from '../../packages/dsh-flow/src/types.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost, type FakeTurn } from './fake-host.ts';
import { fixtureAuditEvidence, fixtureParams, fixturePlan, publishFixtureResult } from './task-fixtures.ts';

async function nativeCall(turn: FakeTurn, nativeTurn: number, name: string, args: unknown, id: string) {
  const callId = ToolCallId(id);
  turn.emit('tool/call', { turn: nativeTurn, step: 1, callId, name, arguments: JSON.stringify(args) });
  const outcome = await turn.callTool(name, args, { callId: id });
  turn.emit('tool/result', { turn: nativeTurn, step: 1,
    message: createToolResultMessage({ callId, content: outcome.content, isError: outcome.isError }) });
  return outcome;
}
function tools(answer: unknown) { return objectField(objectField(objectField(answer, 'projection').evidence, 'evidence').native_tools, 'native tools'); }

for (const dispatched of [false,true]) test(`rc2 recovery preserves ${dispatched ? 'unknown dispatched' : 'unstarted'} tool evidence without another execution or charge`,async t=>{
  const host=createFakeHost();
  const runtime=new ClusterRuntime(host.ctx,{path:':memory:',autoTick:false});
  t.after(async()=>{await runtime.dispose();await host.dispose();});
  let scriptFailure:unknown;
  host.setScript(async turn=>{
    try {
    turn.emit('turn/start',{turn:51});
    for(const input of turn.inputs)turn.emit('user/message',input);
    const callId=ToolCallId('recovered-sum');
    turn.emit('assistant/message',{turn:51,step:1,stream:[],message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'tool-call',id:callId,name:'flow_sum',arguments:'{"values":[2,3]}'}]})});
    if(dispatched){
      turn.emit('tool/call',{turn:51,step:1,callId,name:'flow_sum',arguments:'{"values":[2,3]}'});
      // The effect completed, but no native success was committed before the
      // crash. Recovery must retain UNKNOWN rather than infer its result.
      assert.equal((await turn.callTool('flow_sum',{values:[2,3]},{callId})).value,5);
    }
    const recovery=new ToolCallRecovery();
    for(const event of turn.session.snapshotEvents())recovery.observe(event);
    const results=recovery.results();assert.equal(results.length,1);
    const result=results[0]!;
    assert.equal(result.data.error?.code,dispatched?TOOL_OUTCOME_UNKNOWN:TOOL_NOT_STARTED);
    assert.equal(result.data.message.isError,true);
    turn.emit('tool/result',result.data);
    recovery.observe(result);
    assert.deepEqual(recovery.results(),[],'a committed recovery result does not create a second compensation');
    const assignment=objectField(JSON.parse(String((await turn.callTool('flow_query',{what:'assignment'})).value)),'assignment');
    await turn.callTool('flow_transaction',{action:'submit_result',params:{transaction_id:objectField(assignment.binding,'binding').transaction_id,result:{answer:5}}});
    } catch(error){scriptFailure=error;throw error;}
  });
  const run=await runtime.runSingleAgent({objective:'计算2+3',acceptance_criteria:['结果为5'],workspace:'/tmp',capabilities:[],budget:{tool_calls:50}});
  if(scriptFailure)throw scriptFailure;
  const tx=runtime.store.listTransactions({cluster_id:run.cluster_id})[0]!;
  const worker=runtime.store.listAgents(run.cluster_id)[0]!;
  const evidence=tools(runtime.query({role:'user',cluster_id:run.cluster_id},'transaction',{id:tx.id,fields:['evidence']}));
  assert.equal(evidence.total,dispatched?1:0,'an assistant request alone is not a dispatched call');
  if(dispatched)assert.equal(objectField((evidence.items as unknown[])[0],'receipt').status,'error','the synthetic result never proves success');
  const usage=runtime.store.usageSummary(run.cluster_id);
  projectNativeSessionUsage(runtime.store,worker,host.turns[0]!.session.snapshotEvents(),tx.id);
  projectNativeSessionUsage(runtime.store,worker,host.turns[0]!.session.snapshotEvents(),tx.id);
  assert.deepEqual(runtime.store.usageSummary(run.cluster_id),usage);
  assert.equal(runtime.query({role:'user',cluster_id:run.cluster_id},'effects').total,0);
});

test('native Worker sum receipts are tied to the published epoch and Flow turn, rather than effects', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  let actualSum: unknown;
  host.setScript(async turn => {
    turn.emit('turn/start', { turn: 41 });
    for (const input of turn.inputs) turn.emit('user/message', input);
    turn.emit('tool/call', { turn: 41, step: 1, callId: ToolCallId('ambiguous-provider-call'), name: 'flow_sum', arguments: '{"values":[999]}' });
    await nativeCall(turn, 41, 'flow_sum', { values: [7, 8] }, 'ambiguous-provider-call');
    turn.emit('tool/result', { turn: 41, step: 1, message: createToolResultMessage({ callId: ToolCallId('ambiguous-provider-call'), content: [{ type: 'text', text: '999' }], isError: false }) });
    actualSum = (await nativeCall(turn, 41, 'flow_sum', { values: [2, 3] }, 'same-provider-call')).value;
    const assignment = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
    await turn.callTool('flow_transaction', { action: 'submit_result', params: {
      transaction_id: objectField(assignment.binding, 'binding').transaction_id, result: { answer: actualSum },
    } });
  });
  const run = await runtime.runSingleAgent({ objective: '计算 2+3', acceptance_criteria: ['结果为5'], workspace: '/tmp', capabilities: [], budget: { tool_calls: 50 } });
  assert.equal(actualSum, 5, 'the registered deterministic tool actually computed the returned number');
  const tx = runtime.store.listTransactions({ cluster_id: run.cluster_id })[0]!;
  const worker = runtime.store.listAgents(run.cluster_id)[0]!;
  const actor = { role: 'user' as const, cluster_id: run.cluster_id };
  assert.equal(runtime.query(actor, 'effects').total, 0, 'pure calls do not create a side-effect receipt');
  const evidence = tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'] }));
  for (const value of (evidence.items as unknown[]).slice(0, 2)) {
    const ambiguous = objectField(value, 'ambiguous duplicate');
    assert.equal(ambiguous.status, 'pending', 'same-step duplicate calls cannot distinguish parallel returns');
    assert.equal(objectField(ambiguous.ref, 'ref').result_seq, null);
  }
  const receipt = objectField((evidence.items as unknown[])[2], 'receipt');
  assert.equal(receipt.tool, 'flow_sum');
  assert.equal(objectField(receipt.ref, 'ref').native_turn, 41, 'native turn ordinals are not inferred from Flow turn_seq');
  assert.equal(objectField(receipt.captured_binding, 'binding').epoch, runtime.store.getResult(tx.current_result_ref)?.epoch);
  const read = objectField(receipt.read, 'read');
  const details = tools(runtime.query(actor, String(read.what), objectField(read.params, 'params') as FlowQueryParams));
  const detail = objectField((details.items as unknown[])[0], 'detail');
  assert.equal(objectField(detail.call, 'call').arguments, '{"values":[2,3]}');
  assert.equal(objectField(objectField(detail.result, 'result').message, 'message').content &&
    JSON.stringify(objectField(objectField(detail.result, 'result').message, 'message').content).includes('5'), true);
  const turn = host.turns[0]!;
  turn.emit('turn/start', { turn: 42 });
  turn.emit('tool/call', { turn: 42, step: 1, callId: ToolCallId('same-provider-call'), name: 'flow_sum', arguments: '{"values":[99]}' });
  turn.emit('tool/result', { turn: 42, step: 1, message: createToolResultMessage({ callId: ToolCallId('same-provider-call'), content: [{ type: 'text', text: '99' }], isError: false }) });
  projectNativeSessionUsage(runtime.store, worker, turn.session.snapshotEvents(), tx.id);
  const old = tools(runtime.query(actor, String(read.what), objectField(read.params, 'params') as FlowQueryParams));
  assert.equal(objectField(objectField((old.items as unknown[])[0], 'old').call, 'call').arguments, '{"values":[2,3]}');
  const ref = objectField(receipt.ref, 'ref');
  assert.throws(() => runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'], native_call_id: String(ref.call_id), native_session_id: worker.session_id,
    native_call_seq: turn.session.snapshotEvents().find(event => event.type === 'tool/call' && event.data.turn === 42)!.seq }), /not associated/);
  const saved = runtime.store.getResult(tx.current_result_ref)!;
  runtime.store.run('UPDATE result_snapshots SET data=? WHERE transaction_id=? AND publication_event_seq=?', JSON.stringify({ ...saved, epoch: saved.epoch! + 1 }), tx.id, saved.ref.publication_event_seq);
  assert.equal(tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'] })).total, 0, 'a different lease epoch cannot borrow the same native sum');
});

test('audit reads exact validation-author native tool receipts in pages and rejects foreign objects and sessions', async t => {
  const host = createFakeHost();
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const start = runtime.start({ objective: '计算并校验2+3', acceptance_criteria: ['结果为5'], workspace: '/tmp', capabilities: [], budget: { tool_calls: 200, agents: 8 } });
  const clusterId = start.cluster.id, lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const node = runtime.store.getNode(lead.node_id)!, tx = runtime.store.listTransactions({ cluster_id: clusterId })[0]!;
  const actor: FlowAgentActor = { cluster_id: clusterId, node_id: node.id, agent_id: lead.id, session_id: lead.session_id, role: 'orchestrator' };
  runtime.command(actor, { command_id: 'prepare', action: 'dispatch', params: { transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx) } });
  const auditor = runtime.store.listAgents(clusterId, { role: 'auditor' })[0]!;
  const auditActor: FlowAgentActor = { ...actor, role: 'auditor', agent_id: auditor.id, session_id: auditor.session_id };
  const planAudit = runtime.store.auditsForTransaction(clusterId, tx.id).find(row => row.kind === 'plan')!;
  runtime.command(auditActor, { command_id: 'approve-plan', action: 'inspect_plan', params: { audit_id: planAudit.id, decision: 'approve', evidence: fixtureAuditEvidence(runtime, tx.id, 'plan') } });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { answer: 5 } });
  publishFixtureResult(runtime, tx.id);
  for (const role of ['allocator', 'auditor'] as const) runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role })[0]!.id, { status: 'BLOCKED' });
  let failure: unknown;
  host.setScript(async turn => {
    try {
      turn.emit('turn/start', { turn: 71 });
      for (const input of turn.inputs) turn.emit('user/message', input);
      for (let index = 0; index < 7; index += 1) assert.equal((await nativeCall(turn, 71, 'flow_sum', { values: [2, 3] }, `sum-${index}`)).value, 5);
      await nativeCall(turn, 71, 'flow_transaction', { action: 'validate', params: fixtureParams(runtime, actor, 'validate', { transaction_id: tx.id, accepted: true }) }, 'validation-call');
      await nativeCall(turn, 71, 'flow_sum', { values: [100] }, 'later-unrelated-call');
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling(); await runtime.tick(); await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  const audit = runtime.store.auditsForTransaction(clusterId, tx.id).find(row => row.kind === 'validation')!;
  assert.ok(audit);
  const first = tools(runtime.query(auditActor, 'audit', { id: audit.id, fields: ['evidence'], limit: 3 }));
  assert.equal(first.total, 8, 'seven actual computations and the successful validate command are associated');
  assert.equal(first.next_offset, 3);
  const receipts = [...first.items as unknown[]];
  for (let offset = Number(first.next_offset);;) {
    const page = tools(runtime.query(auditActor, 'audit', { id: audit.id, fields: ['evidence'], limit: 3, offset }));
    receipts.push(...page.items as unknown[]);
    if (page.next_offset === null) break;
    offset = Number(page.next_offset);
  }
  assert.equal(receipts.length, 8);
  assert.equal(receipts.filter(receipt => objectField(receipt, 'receipt').tool === 'flow_sum').length, 7);
  assert.ok(receipts.every(receipt => objectField(receipt, 'receipt').association === 'validation-author'));
  const read = objectField(objectField(receipts[0], 'receipt').read, 'read');
  const params = objectField(read.params, 'params') as FlowQueryParams;
  assert.equal(objectField(objectField((tools(runtime.query(auditActor, 'audit', params)).items as unknown[])[0], 'detail').call, 'call').name, 'flow_sum');
  assert.throws(() => runtime.query(auditActor, 'audit', { ...params, native_session_id: auditor.session_id }), /not associated/);
  const other = runtime.createTransactionInternal(clusterId, node, { objective: '不同任务', acceptance_criteria: ['不同交付'] }, { local: true });
  const { plan_ref: _plan, result_ref: _result, validation_ref: _validation, ...receiptParams } = params;
  assert.throws(() => runtime.query(auditActor, 'transaction', { ...receiptParams, id: other.id }), /not associated/);
  runtime.store.insertNode({ id: 'isolated-domain', cluster_id: clusterId, kind: 'management', status: 'ACTIVE', max_children: 1,
    parent_id: node.id, path: `${node.path}.99`, depth: node.depth + 1, owner_management_id: 'isolated-domain' });
  assert.throws(() => runtime.query({ ...auditActor, node_id: 'isolated-domain' }, 'audit', params), /outside/);
  assert.equal(runtime.query(auditActor, 'effects').total, 0);
});
