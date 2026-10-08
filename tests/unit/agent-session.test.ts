import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fromPartial} from '@total-typescript/shoehorn';
import {projectAgentSession} from '../../packages/dsh-flow/src/agent-session.ts';
import type {FlowTeamAgent,FlowTeamRun} from '../../packages/dsh-flow/src/types.ts';

test('native continuation uses the authoritative run state rather than a display label',()=>{
  const agent=fromPartial<FlowTeamAgent>({state:'completed',raw_state:'COMPLETED',recycled:false});
  const run=fromPartial<FlowTeamRun>({state:'completed',raw_state:'RUNNING'});
  const active=projectAgentSession(run,agent);
  assert.equal(active.run,run);assert.equal(active.agent,agent);
  assert.equal(active.can_message,true);assert.equal(active.message_block_reason,null);
  for(const raw_state of ['COMPLETED','FAILED','CANCELLED']) {
    const ended=projectAgentSession({...run,state:'running',raw_state},agent);
    assert.equal(ended.can_message,false);
    assert.equal(ended.message_block_reason,'团队已结束，不再接受消息。历史对话和轨迹仍可查看。');
  }
});
