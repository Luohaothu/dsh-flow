import test from 'node:test';import assert from 'node:assert/strict';
import {captureRoleProcessProbe, captureScopedProcess} from './role-process-probe.mjs';
function stat(tick='42') {const fields=Array(25).fill('0');fields[0]='S';fields[19]=tick;return '1 (node) '+fields.join(' ');}
const scope=()=>({schema:'root-sdk-process-probe-scope/v1',caseId:'example',candidateId:'example',namespaceId:'example-ns',containerId:'a'.repeat(64),imageId:'sha256:'+'b'.repeat(64),generationId:'example-generation',accountingScope:'qualification-offline',nativeObserverSourceSha256:'c'.repeat(64),nonce:'d'.repeat(64),containerInspectionSourceSha256:'e'.repeat(64),processes:[{pid:1,role:'sdk',expectedStartTimeTicks:'42'}]});
const processValue=()=>({pid:1,role:'sdk',observedState:'present',stat:stat(),afterStat:stat(),startTimeTicks:'42',status:'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n',cmdline:['node','/fixed/barrier.mjs'],fds:[{fd:'0',link:'pipe:[1]'}]});
const options={platform:'linux',uid:1000,gid:1000,pid:9,captureProcess:()=>processValue(),now:()=>1};
test('SDK1000 actor captures the complete process source without Root0 credit',()=>{const value=captureRoleProcessProbe(scope(),options);assert.equal(value.actor.uid,1000);assert.equal(value.processes[0].fds[0].link,'pipe:[1]');assert.equal(value.actualSdkQualified,false);});
test('Root0 actor cannot claim SDK process-probe scope',()=>{assert.throws(()=>captureRoleProcessProbe(scope(),{...options,uid:0,gid:0}));});
test('birth, uid, missing FD and changed-process evidence remain failures',()=>{for(const edit of [v=>v.startTimeTicks='43',v=>v.status=v.status.replaceAll('1000','0'),v=>delete v.fds,v=>v.observedState='changed-during-capture',v=>v.afterStat=stat('43')]){const value=processValue();edit(value);assert.throws(()=>captureRoleProcessProbe(scope(),{...options,captureProcess:()=>value}));}});
test('the real proc reader propagates EACCES instead of returning an empty FD list',()=>{
 const filesystem={readFileSync:(file)=>file.endsWith('/stat')?stat():file.endsWith('/status')?processValue().status:Buffer.from('node\0/fixed/barrier.mjs\0'),readdirSync:()=>['0'],readlinkSync:()=>{throw Object.assign(Error('permission denied'),{code:'EACCES'});}};
 assert.throws(()=>captureScopedProcess({pid:1,role:'sdk'},{filesystem}),error=>error.code==='EACCES');
});
