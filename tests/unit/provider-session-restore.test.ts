/** rc2 retains the released V4 protected-system-head validation. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session,SessionId,KNOWN_SESSION_EVENT_TYPES} from '@deepseek-ai/dsh-session';
import {MessageId} from '@deepseek-ai/dsh-llm';
import {restoreReleasedV4Artifact} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import type {SessionFormatArtifact} from '@deepseek-ai/dsh-session-format';

function history(noticeFirst:boolean):Session {
  const session=Session.create(SessionId('notification-first'));
  const notice=()=>session.append('user/message',{id:MessageId('notice'),role:'user',source:{kind:'user'},content:[{type:'text',text:'团队已启动'}]},{surfaceOp:'append'});
  if(noticeFirst)notice();
  session.append('turn/start',{turn:1});
  session.append('step/start',{turn:1,step:1});
  session.append('system/message',{turn:1,step:1,message:{id:MessageId('policy'),role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'与用户交流执行结果'}]}},{surfaceOp:'append'});
  if(!noticeFirst)notice();
  session.append('step/end',{turn:1,step:1});
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  return session;
}

function artifact(session:Session):SessionFormatArtifact {
  // The JSON image is the official persistence boundary. Session supplies
  // canonical source, sequence and surface metadata rather than handwritten rows.
  return JSON.parse(JSON.stringify({header:{...session.header,delegationDepth:0},inheritedEventCount:0,events:session.snapshotEvents()}));
}

test('official rc2 V4 restoration retains a system-first history unchanged',()=>{
  const session=history(false);
  const image=artifact(session);
  const before=JSON.stringify(image);
  assert.equal(restoreReleasedV4Artifact(image,KNOWN_SESSION_EVENT_TYPES),image);
  assert.equal(JSON.stringify(image),before,'reading must not rewrite or reorder historical events');
  const replay=Session.create(session.id,session.snapshotEvents(),session.header);
  assert.deepEqual(replay.surface.nodes,session.surface.nodes);
  assert.deepEqual(replay.snapshotEvents().slice(0,session.seq),session.snapshotEvents());
});

test('official rc2 V4 restoration rejects notification-first legacy or malformed histories',()=>{
  assert.throws(()=>restoreReleasedV4Artifact(artifact(history(true)),KNOWN_SESSION_EVENT_TYPES),/protected first surface head/);
});

test('official V4 restoration still protects an existing system head against a non-system replacement',()=>{
  const image=artifact(history(false));
  const head=image.events.find(event=>event.type==='system/message')!.seq;
  const invalid:SessionFormatArtifact={...image,events:[...image.events,{type:'user/message',seq:image.events.length,time:Date.now(),surfaceOp:{op:'replace',startSeq:head,endSeq:head},sourceEventSeqs:[head],data:{id:'overwrite',role:'user',source:{kind:'user'},content:[{type:'text',text:'replacement'}]}}]};
  assert.throws(()=>restoreReleasedV4Artifact(invalid,KNOWN_SESSION_EVENT_TYPES),/protected system head/);
});
