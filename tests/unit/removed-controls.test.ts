/** Public entry points reject the retired model controls before writing state. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { fromAny } from '@total-typescript/shoehorn';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowRuntimeConfig, FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import type { FlowStartRequest } from '../../packages/dsh-flow/src/types.ts';

test('runtime and startup reject removed windows, output caps and model budgets', async t => {
  for (const input of [{context:{}}, {maxTokens:128}, {model:{provider:'fixture',model:'fixture',maxTokens:128}}]) {
    assert.throws(() => new ClusterRuntime(new Context(), fromAny<FlowRuntimeConfig, object>(input)), /field/i);
  }
  const runtime = new ClusterRuntime(new Context(), {autoTick:false});
  t.after(() => runtime.dispose());
  for (const input of [
    {maxTokens:128}, {context:{}}, {budget:{tokens:1}}, {budget:{model_requests:1}}, {budget:{requests:1}},
    {limits:{worker_max_tokens:128}}, {limits:{worker_model_requests:1}},
  ]) {
    assert.throws(() => runtime.start(fromAny<FlowStartRequest, object>({objective:'reject retired controls',workspace:'/tmp',...input})), /field|dimension|unsupported|unknown/i);
  }
  assert.equal(runtime.store.listClusters({}).length, 0);
});

test('Allocator actions reject removed dimensions and nested output settings without mutating state', async t => {
  const runtime = new ClusterRuntime(new Context(), {autoTick:false,model:{provider:'fixture',model:'fixture'}});
  t.after(() => runtime.dispose());
  const snapshot = runtime.start({objective:'clean action contract',workspace:'/tmp',budget:{tool_calls:100,agents:16,max_active_agents:4}});
  const allocator = runtime.store.listAgents(snapshot.cluster.id,{role:'allocator'})[0]!;
  const actor:FlowAgentActor = {cluster_id:snapshot.cluster.id,node_id:allocator.node_id,agent_id:allocator.id,
    role:allocator.role,session_id:allocator.session_id};
  let commandId = 0;
  const send = (action:string, params:Record<string,unknown>) => runtime.command(actor,{command_id:`removed-${++commandId}`,action,params});
  const budgets = runtime.store.listBudgets(snapshot.cluster.id);
  const seq = runtime.store.latestEventSeq(snapshot.cluster.id);
  for (const key of ['tokens','model_requests','requests']) {
    assert.throws(() => send('allocate_budget',{scope:{kind:'agent',id:allocator.id},amounts:{[key]:1}}), /budget dimension/i);
    assert.throws(() => send('rebalance_budget',{from:{kind:'node',id:allocator.node_id},to:{kind:'agent',id:allocator.id},amounts:{[key]:1}}), /budget dimension/i);
  }
  for (const params of [
    {provider:'fixture',model:'fixture',max_tokens:128},
    {provider:'fixture',model:'fixture',maxTokens:128},
    {model:{provider:'fixture',model:'fixture',maxTokens:128}},
    {model:{provider:'fixture',model:'fixture',output:{maxTokens:128}}},
    {provider:'fixture',model:'fixture',options:{maxTokens:128}},
  ]) assert.throws(() => send('select_model',params), /field/i);
  assert.throws(() => send('set_context_budget',{agent_id:allocator.id,limit:8192}), /unknown|not allowed|may not perform|unauthorized/i);
  assert.deepEqual(runtime.store.listBudgets(snapshot.cluster.id),budgets);
  assert.equal(runtime.store.latestEventSeq(snapshot.cluster.id),seq);
});
