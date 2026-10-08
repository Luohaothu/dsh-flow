import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptedValidationPassed,deliveryMisstatesAuditorRead,finalizedDelivery} from '../deepseek-case.ts';
import type {SessionEvent} from '../../../src/host/session-scan.ts';

const event=(seq:number,type:string,data:unknown):SessionEvent=>({seq,type,data});
const finalize=(seq:number,id:string)=>event(seq,'tool/call',{name:'agent_team_finalize',callId:id,arguments:'{"run_id":"team"}'});
const result=(seq:number,id:string,run:unknown,isError=false)=>event(seq,'tool/result',{message:{toolCallId:id,isError,content:[{type:'text',text:JSON.stringify({run})}]}});
const reply=(seq:number,text='budget-report.md：总支出2600，余额400。Auditor没有直接使用fs_read，审查了已结算写入证据。')=>event(seq,'assistant/message',{message:{content:[{type:'text',text}]}});

test('later idempotent finalization preserves a real delivered response',()=>{
  const events=[finalize(1,'first'),result(2,'first',{id:'team',state:'completed',finalized_at:123}),reply(3),finalize(4,'repeat'),result(5,'repeat',{id:'team',state:'completed',finalized_at:123})];
  assert.deepEqual(finalizedDelivery(events,'team'),{text:'budget-report.md：总支出2600，余额400。Auditor没有直接使用fs_read，审查了已结算写入证据。',seq:3,finalize_result_seq:2,finalized_at:123});
});
test('delivery requires a successful completed and finalized tool result for the owned run',()=>{
  const failed=[finalize(1,'failed'),result(2,'failed',{id:'team',state:'completed',finalized_at:123},true),reply(3)];
  const unfinished=[finalize(1,'early'),result(2,'early',{id:'team',state:'completed'}),reply(3)];
  const another=[finalize(1,'other'),result(2,'other',{id:'other-team',state:'completed',finalized_at:123}),reply(3)];
  for(const events of [failed,unfinished,another]) assert.equal(finalizedDelivery(events,'team').text,'');
  const retried=[...failed,finalize(4,'success'),result(5,'success',{id:'team',state:'completed',finalized_at:123}),reply(6)];
  assert.equal(finalizedDelivery(retried,'team').finalize_result_seq,5);
  assert.equal(finalizedDelivery(retried,'team').seq,6);
});
test('accepted status cannot conceal a failed business criterion or incorrect Auditor-read claim',()=>{
  assert.equal(acceptedValidationPassed([{validation:JSON.stringify({accepted:true,checks:[{passed:true},{passed:false}]})}]),false);
  assert.equal(acceptedValidationPassed([{validation:JSON.stringify({accepted:true,checks:[{passed:true}]})}]),true);
  assert.equal(deliveryMisstatesAuditorRead('独立 Auditor 使用 fs_read 读回文件核对一致。'),true);
  assert.equal(deliveryMisstatesAuditorRead('Auditor 未使用 fs_read，审查已结算写入证据。'),false);
});
