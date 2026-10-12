import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import { projectNativeSessionUsage } from '../../packages/dsh-flow/src/core/runtime.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowQueryParams } from '../../packages/dsh-flow/src/types.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost, type FakeTurn } from './fake-host.ts';
import { fixtureParams, fixturePlan, publishFixtureResult } from './task-fixtures.ts';

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

test('transaction evidence reads exact validation-author native receipts and rejects foreign objects and sessions', async t => {
  const host = createFakeHost();
  for (const name of ['read', 'glob', 'grep']) host.registerTool({ name, description: 'native evidence fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, async execute() { return '5'; } });
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); });
  const start = runtime.start({ managementCapabilities: ['fs_read'], objective: '计算并校验2+3', acceptance_criteria: ['结果为5'], workspace: '/tmp', capabilities: [], budget: { tool_calls: 200, agents: 8 } });
  const clusterId = start.cluster.id, lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const node = runtime.store.getNode(lead.node_id)!, tx = runtime.store.listTransactions({ cluster_id: clusterId })[0]!;
  const actor: FlowAgentActor = { cluster_id: clusterId, node_id: node.id, agent_id: lead.id, session_id: lead.session_id, role: 'orchestrator' };
  runtime.command(actor, { command_id: 'prepare', action: 'dispatch', params: { transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx) } });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { answer: 5 } });
  publishFixtureResult(runtime, tx.id);
  const other = runtime.createTransactionInternal(clusterId, node, { objective: '不同任务', acceptance_criteria: ['不同交付'] }, { local: true });
  runtime.command(actor, { command_id: 'prepare-other', action: 'dispatch', params: { transaction_id: other.id, expected_transaction_revision: other.revision, plan: fixturePlan(other) } });
  runtime.store.updateTransaction(other.id, { status: 'SUBMITTED', result: { answer: 100 } });
  publishFixtureResult(runtime, other.id);
  for (const role of ['allocator'] as const) runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role })[0]!.id, { status: 'BLOCKED' });
  let failure: unknown;
  host.setScript(async turn => {
    try {
      turn.emit('turn/start', { turn: 71 });
      for (const input of turn.inputs) turn.emit('user/message', input);
      const assignment = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
      const binding = objectField(assignment.binding, 'binding');
      assert.equal(binding.transaction_id, tx.id);
      assert.deepEqual(binding.plan_ref, runtime.store.getTransaction(tx.id)!.current_plan_ref);
      await nativeCall(turn, 71, 'read', { path: '/tmp/assigned-result.txt' }, 'assigned-read');
      const published = runtime.store.getTransaction(tx.id)!;
      await nativeCall(turn, 71, 'flow_transaction', { action: 'bind_validation', params: { transaction_id: tx.id, plan_ref: published.current_plan_ref, result_ref: published.current_result_ref } }, 'bind-call');
      for (let index = 0; index < 7; index += 1) assert.equal((await nativeCall(turn, 71, 'flow_sum', { values: [2, 3] }, `sum-${index}`)).value, 5);
      const secondPublication = runtime.store.getTransaction(other.id)!;
      await nativeCall(turn, 71, 'flow_transaction', { action: 'bind_validation', params: { transaction_id: other.id, plan_ref: secondPublication.current_plan_ref, result_ref: secondPublication.current_result_ref } }, 'bind-second');
      await nativeCall(turn, 71, 'read', { path: '/tmp/second-result.txt' }, 'second-result-read');
      await nativeCall(turn, 71, 'flow_transaction', { action: 'bind_validation', params: { transaction_id: tx.id, plan_ref: published.current_plan_ref, result_ref: published.current_result_ref } }, 'bind-first-again');
      await nativeCall(turn, 71, 'flow_transaction', { action: 'validate', params: fixtureParams(runtime, actor, 'validate', { transaction_id: tx.id, accepted: true }) }, 'validation-call');
      await nativeCall(turn, 71, 'read', { path: '/tmp/unrelated.txt' }, 'later-unrelated-call');
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling(); await runtime.tick(); await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  assert.equal(runtime.store.getTransaction(tx.id)?.status, 'ACCEPTED');
  const first = tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'], limit: 3 }));
  assert.equal(first.total, 8, 'the assigned read and seven explicitly bound sums precede validation; the later call is excluded');
  assert.equal(first.next_offset, 3);
  const receipts = [...first.items as unknown[]];
  for (let offset = Number(first.next_offset);;) {
    const page = tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'], limit: 3, offset }));
    receipts.push(...page.items as unknown[]);
    if (page.next_offset === null) break;
    offset = Number(page.next_offset);
  }
  assert.equal(receipts.length, 8);
  const sums = receipts.filter(receipt => objectField(receipt, 'receipt').tool === 'flow_sum');
  assert.equal(sums.length, 7, 'the deterministic calculation tool retains every native receipt');
  assert.equal(receipts.filter(receipt => objectField(receipt, 'receipt').tool === 'read').length, 1);
  assert.ok(receipts.every(receipt => objectField(receipt, 'receipt').association === 'validation-author'));
  const read = objectField(objectField(sums[0], 'receipt').read, 'read');
  const params = objectField(read.params, 'params') as FlowQueryParams;
  const detail = objectField((tools(runtime.query(actor, 'transaction', params)).items as unknown[])[0], 'detail');
  assert.equal(objectField(detail.call, 'call').name, 'flow_sum');
  assert.equal(objectField(detail.call, 'call').arguments, '{"values":[2,3]}');
  assert.throws(() => runtime.query(actor, 'transaction', { ...params, native_session_id: 'unrelated-session' }), /not associated/);
  const secondTools = tools(runtime.query(actor, 'transaction', { id: other.id, fields: ['evidence'] }));
  assert.equal(secondTools.total, 1, 'a second task in the same turn receives only its explicitly bound call');
  assert.equal(objectField((secondTools.items as unknown[])[0], 'second receipt').association, 'current-manager');
  const { plan_ref: _plan, result_ref: _result, validation_ref: _validation, ...receiptParams } = params;
  assert.throws(() => runtime.query(actor, 'transaction', { ...receiptParams, id: other.id }), /not associated/);
  runtime.store.insertNode({ id: 'isolated-domain', cluster_id: clusterId, kind: 'management', status: 'ACTIVE', max_children: 1,
    parent_id: node.id, path: `${node.path}.99`, depth: node.depth + 1, owner_management_id: 'isolated-domain' });
  assert.throws(() => runtime.query({ ...actor, node_id: 'isolated-domain' }, 'transaction', params), /outside/);
  assert.equal(runtime.query(actor, 'effects').total, 0);
});

test('a manager can list and expand its persisted file receipt in the same turn while its input remains PENDING', async t => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'flow-same-turn-evidence-')));
  const file = join(workspace, 'answer.txt'), expected = 'The independently checked answer is 5.\n';
  writeFileSync(file, expected);
  const host = createFakeHost();
  for (const name of ['read', 'glob', 'grep']) host.registerTool({ name, description: 'native file evidence fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) { return name === 'read' ? readFileSync(String(objectField(args, 'read arguments').path), 'utf8') : ''; } });
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(workspace, { recursive: true, force: true }); });
  const start = runtime.start({ managementCapabilities: ['fs_read'], objective: '读取并验收交付文件', acceptance_criteria: ['文件内容正确'],
    workspace, capabilities: [], budget: { tool_calls: 100, agents: 8 } });
  const clusterId = start.cluster.id, lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const node = runtime.store.getNode(lead.node_id)!, tx = runtime.store.listTransactions({ cluster_id: clusterId })[0]!;
  const actor: FlowAgentActor = { cluster_id: clusterId, node_id: node.id, agent_id: lead.id, session_id: lead.session_id, role: 'orchestrator' };
  runtime.command(actor, { command_id: 'prepare-file', action: 'dispatch', params: {
    transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
  } });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { file } });
  publishFixtureResult(runtime, tx.id);
  runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role: 'allocator' })[0]!.id, { status: 'BLOCKED' });
  let failure: unknown, enteredInputId: string | undefined;
  host.setScript(async turn => {
    try {
      const nativeTurn = 81;
      turn.emit('turn/start', { turn: nativeTurn });
      const row = runtime.store.get('SELECT id FROM member_inputs WHERE agent_id=? AND native_message_id=?', lead.id, turn.inputs[0]!.id)!;
      enteredInputId = String(row.id);
      const saved = runtime.store.getMemberInput(enteredInputId)!;
      assert.equal(saved.status, 'PENDING');
      const queryEvidence = async () => {
        // Let the runtime's real incremental persistence queue finish. The test
        // never acknowledges the member input or manually projects native facts.
        await new Promise<void>(resolve => setImmediate(resolve));
        const answer = await turn.callTool('flow_query', { what: 'transaction', params: { id: tx.id, fields: ['evidence'] } });
        assert.equal(answer.isError, false);
        return tools(JSON.parse(String(answer.value)));
      };
      await nativeCall(turn, nativeTurn, 'read', { path: file }, 'queued-input-read');
      assert.equal((await queryEvidence()).total, 0, 'a queued PENDING input without persisted native admission cannot attach receipts');

      const binding = objectField(saved.binding, 'saved input binding');
      for (const mismatch of ['session', 'epoch', 'flow-turn'] as const) {
        const message = createUserMessage({ content: [{ type: 'text', text: `mismatched ${mismatch}` }], source: { kind: 'user' } });
        runtime.store.saveMemberInput({ cluster_id: clusterId, agent_id: lead.id,
          session_id: mismatch === 'session' ? 'foreign-native-session' : lead.session_id,
          delivery_key: `mismatched-${mismatch}`, kind: 'wake', author: null, plan_ref: saved.plan_ref,
          binding: { ...binding, ...(mismatch === 'epoch' ? { epoch: Number(binding.epoch) + 1 } : {}),
            ...(mismatch === 'flow-turn' ? { turn_seq: Number(binding.turn_seq) + 1 } : {}) },
          content: `mismatched ${mismatch}`, native_message_id: message.id });
        turn.emit('user/message', message);
        await nativeCall(turn, nativeTurn, 'read', { path: file }, `mismatched-${mismatch}-read`);
        assert.equal((await queryEvidence()).total, 0, `a ${mismatch} mismatch cannot borrow current manager receipts`);
      }

      for (const message of turn.inputs) turn.emit('user/message', message);
      assert.equal((await nativeCall(turn, nativeTurn, 'read', { path: file }, 'current-manager-file-read')).value, expected);
      const evidence = await queryEvidence();
      assert.equal(runtime.store.getMemberInput(enteredInputId)!.status, 'PENDING', 'the native turn has not returned to Flow yet');
      assert.equal(evidence.total, 1, 'only the call after the matching persisted native input is associated');
      const receipt = objectField((evidence.items as unknown[])[0], 'manager receipt');
      const ref = objectField(receipt.ref, 'receipt ref');
      assert.equal(receipt.association, 'current-manager');
      assert.equal(ref.agent_id, lead.id);
      assert.equal(ref.native_session_id, lead.session_id);
      assert.equal(ref.native_turn, nativeTurn);
      assert.equal(ref.call_id, 'current-manager-file-read');
      assert.equal(receipt.status, 'returned');
      const read = objectField(receipt.read, 'read contract');
      const expanded = await turn.callTool('flow_query', { what: read.what, params: read.params });
      assert.equal(expanded.isError, false);
      const detail = objectField((tools(JSON.parse(String(expanded.value))).items as unknown[])[0], 'expanded manager receipt');
      assert.equal(objectField(detail.call, 'native call').arguments, JSON.stringify({ path: file }));
      assert.deepEqual(objectField(objectField(detail.result, 'native result').message, 'native message').content, [{ type: 'text', text: expected }]);
      await nativeCall(turn, nativeTurn, 'flow_transaction', { action: 'validate', params: fixtureParams(runtime, actor, 'validate', {
        transaction_id: tx.id, accepted: true,
      }) }, 'same-turn-validate');
      assert.equal(runtime.store.getTransaction(tx.id)!.status, 'ACCEPTED');
      assert.equal(runtime.store.getMemberInput(enteredInputId)!.status, 'PENDING');
      turn.emit('turn/end', { turn: nativeTurn, reason: { kind: 'completed' } });
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling(); await runtime.tick(); await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  assert.ok(enteredInputId);
  assert.equal(runtime.store.getMemberInput(enteredInputId)!.status, 'ADMITTED', 'the normal turn completion acknowledges the input later');
});

for (const previouslyEntered of [true, false]) test(`recovery binds manager receipts to the new lease when the preserved input was ${previouslyEntered ? 'already entered' : 'only queued'}`, async t => {
  let durable = false;
  const host = createFakeHost({ flushResult: () => durable });
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'flow-recovered-evidence-')));
  const file = join(workspace, 'result.txt'); writeFileSync(file, 'RECOVERED-RESULT 5\n');
  for (const name of ['read', 'glob', 'grep']) host.registerTool({ name, description: 'recovered native file fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) { return name === 'read' ? readFileSync(String(objectField(args, 'read arguments').path), 'utf8') : ''; } });
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(workspace, { recursive: true, force: true }); });
  const start = runtime.start({ managementCapabilities: ['fs_read'], objective: '冷恢复后验收文件', acceptance_criteria: ['结果为5'],
    workspace, capabilities: [], budget: { tool_calls: 100, agents: 8 } });
  const clusterId = start.cluster.id, lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const node = runtime.store.getNode(lead.node_id)!, tx = runtime.store.listTransactions({ cluster_id: clusterId })[0]!;
  const actor: FlowAgentActor = { cluster_id: clusterId, node_id: node.id, agent_id: lead.id, session_id: lead.session_id, role: 'orchestrator' };
  runtime.command(actor, { command_id: 'prepare-recovery', action: 'dispatch', params: {
    transaction_id: tx.id, expected_transaction_revision: tx.revision, plan: fixturePlan(tx),
  } });
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: { file } }); publishFixtureResult(runtime, tx.id);
  runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role: 'allocator' })[0]!.id, { status: 'BLOCKED' });
  host.setScript(turn => {
    turn.emit('turn/start', { turn: 91 });
    if (previouslyEntered) for (const message of turn.inputs) turn.emit('user/message', message);
    turn.emit('turn/end', { turn: 91, reason: { kind: 'interrupted' } });
  });
  runtime.enableScheduling(); await runtime.tick(); await runtime.activeTurnFor(lead.id)?.promise;
  const saved = runtime.store.getMemberInput(String(runtime.store.get('SELECT id FROM member_inputs WHERE agent_id=?', lead.id)!.id))!;
  assert.equal(saved.status, 'PENDING');
  assert.equal(objectField(saved.binding, 'original binding').epoch, 1);
  durable = true;
  runtime.recover({ deferScheduling: true });
  let failure: unknown, restoredMessageId: string | undefined;
  host.setScript(async turn => {
    try {
      turn.emit('turn/start', { turn: 92 });
      restoredMessageId = turn.prompt!.id;
      assert.equal(restoredMessageId === saved.native_message_id, !previouslyEntered, 'only an undelivered business message is reused');
      const assignment = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
      const current = objectField(assignment.binding, 'current assignment binding');
      assert.equal(current.epoch, 2); assert.equal(current.turn_seq, 2);
      assert.deepEqual(current.plan_ref, saved.plan_ref);
      // Even the new execution-binding event cannot prove native admission on
      // its own. A call before the message enters must never be retroactively attached.
      await nativeCall(turn, 92, 'read', { path: file }, 'before-recovered-input');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'] })).total, 0);
      for (const message of turn.inputs) turn.emit('user/message', message);
      assert.equal((await nativeCall(turn, 92, 'read', { path: file }, 'recovered-manager-read')).value, 'RECOVERED-RESULT 5\n');
      await new Promise<void>(resolve => setImmediate(resolve));
      const response = await turn.callTool('flow_query', { what: 'transaction', params: { id: tx.id, fields: ['evidence'] } });
      const receipts = tools(JSON.parse(String(response.value)));
      assert.equal(receipts.total, 1);
      const receipt = objectField((receipts.items as unknown[])[0], 'recovered receipt');
      assert.equal(objectField(receipt.ref, 'ref').call_id, 'recovered-manager-read');
      assert.equal(objectField(receipt.captured_binding, 'binding').epoch, 2);
      assert.equal(objectField(receipt.captured_binding, 'binding').turn_seq, 2);
      if (!previouslyEntered) {
        const execution = runtime.store.get("SELECT seq,data FROM events WHERE type='member-input-execution-bound' AND json_extract(data,'$.input_id')=?", saved.id)!;
        const original = JSON.parse(String(execution.data));
        const currentMessageSeq = turn.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === restoredMessageId)!.seq;
        for (const mismatch of [
          { session_id: 'foreign-session' }, { agent_id: 'foreign-agent' }, { input_id: 'foreign-input' }, { native_message_id: 'foreign-message' },
          { after_native_seq: currentMessageSeq }, { binding: { ...original.binding, epoch: 1, turn_seq: 1 } },
        ]) {
          runtime.store.run('UPDATE events SET data=? WHERE seq=?', JSON.stringify({ ...original, ...mismatch }), execution.seq);
          assert.equal(tools(runtime.query(actor, 'transaction', { id: tx.id, fields: ['evidence'] })).total, 0,
            `a mismatched recovered execution binding cannot attach receipts: ${JSON.stringify(mismatch)}`);
        }
        runtime.store.run('UPDATE events SET data=? WHERE seq=?', execution.data, execution.seq);
      }
      const read = objectField(receipt.read, 'read');
      const expanded = await turn.callTool('flow_query', { what: read.what, params: read.params });
      const detail = objectField((tools(JSON.parse(String(expanded.value))).items as unknown[])[0], 'detail');
      assert.match(JSON.stringify(detail.result), /RECOVERED-RESULT 5/);
      turn.emit('turn/end', { turn: 92, reason: { kind: 'completed' } });
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling(); await runtime.tick(); await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  const after = runtime.store.getMemberInput(saved.id)!;
  for (const key of ['binding', 'content', 'author', 'plan_ref', 'previous_plan_ref', 'native_message_id', 'delivery_key'] as const) assert.deepEqual(after[key], saved[key], `recovery preserves original ${key}`);
  assert.equal(after.status, 'ADMITTED');
  const entries = host.lastTurn!.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === saved.native_message_id);
  assert.equal(entries.length, 1, 'original input enters exactly once across recovery');
  const resumed = runtime.store.get('SELECT binding FROM member_inputs WHERE native_message_id=?', restoredMessageId!)!;
  assert.equal(JSON.parse(String(resumed.binding)).epoch, previouslyEntered ? 2 : 1, 'new wakes use the current epoch; queued handoff records remain immutable');
});
