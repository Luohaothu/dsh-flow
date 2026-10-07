import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fromPartial} from '@total-typescript/shoehorn';
import type {FlowAgentSession} from '../../packages/dsh-flow/src/types.ts';
import {AgentSessionSource} from '../../packages/dsh-flow/src/client/agent-session.ts';

test('native Agent policy follows recycle, preserves identity on read failure and stops polling after leaving',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const live=fromPartial<FlowAgentSession>({can_message:true,message_block_reason:null});
  let value=live,calls=0,failure=false;
  const policy:(FlowAgentSession|null)[]=[];
  const source=new AgentSessionSource('agent',async()=>{calls++;if(failure)throw new Error('offline');return value;},value=>policy.push(value));
  const leave=source.subscribe(()=>{});await source.refresh();
  assert.equal(source.getSnapshot().value?.can_message,true);
  value={...live,can_message:false,message_block_reason:'已回收'};
  t.mock.timers.tick(1500);await source.refresh();
  assert.equal(policy.at(-1)?.message_block_reason,'已回收');
  failure=true;await source.refresh();
  assert.equal(source.getSnapshot().value,value);assert.equal(source.getSnapshot().error,'offline');
  leave();const before=calls;t.mock.timers.tick(6000);assert.equal(calls,before);
  source.dispose();
});

test('a late native policy read cannot block another Session after its source is disposed',async()=>{
  const pending=Promise.withResolvers<FlowAgentSession|null>();let publications=0;
  const source=new AgentSessionSource('old',()=>pending.promise,()=>publications++);
  const read=source.refresh();source.dispose();pending.resolve(fromPartial<FlowAgentSession>({can_message:false}));await read;
  assert.equal(publications,0);assert.equal(source.getSnapshot().value,null);
});
