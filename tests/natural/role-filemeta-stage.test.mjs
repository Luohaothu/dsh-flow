import fs from'node:fs';import os from'node:os';import path from'node:path';
import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import {captureRoleFilemeta,verifyRoleFilemeta,readRoleStderr} from './role-filemeta-stage.mjs';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
function stat(){const values=Array(25).fill('0');values[0]='S';values[19]='42';return'1 (node) '+values.join(' ');}
function fixture(mode='pre-sdk'){
 const scope={caseId:'example',candidateId:'example',namespaceId:'example-ns',containerId:'a'.repeat(64),imageId:'sha256:'+'b'.repeat(64),generationId:'example-generation',accountingScope:'qualification-offline',nativeObserverSourceSha256:'c'.repeat(64),nonce:'d'.repeat(64)},inspect='e'.repeat(64),sdkTarget={pid:1,role:mode==='pre-sdk'?'pre-sdk-pid1':'sdk',expectedStartTimeTicks:'42'},rootScope={schema:mode==='pre-sdk'?'root-wave02-pre-sdk-filemeta-scope/v1':'root-wave02-filemeta-scope/v1',...scope,containerInspectionSourceSha256:inspect},input={mode,scope,rootScope,controlDirectory:'/root-control/runtime',fileName:'filemeta-1',rootEntry:'/fixed/root-sampler.mjs',sdkEntry:'/fixed/sdk-probe.mjs',sdkTarget,executor:{executable:'/fixed/docker',argsPrefix:['--host','unix:///fixed/daemon.sock']}},values=new Map(),calls=[];
 const sdk={schema:'root-sdk-process-probe/v1',...scope,capturedAt:2,containerInspectionSourceSha256:inspect,actor:{pid:9,uid:1000,gid:1000,kind:'Root-fixed-Node-only-same-uid-probe'},processes:[{pid:1,role:sdkTarget.role,observedState:'present',stat:stat(),afterStat:stat(),startTimeTicks:'42',status:'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n',cmdline:['node','/fixed/barrier.mjs'],fds:[{fd:'0',link:'pipe:[1]'}]}],actualSdkQualified:false},root={schema:mode==='pre-sdk'?'root-wave02-actual-pre-sdk-filemeta/v1':'root-wave02-filemeta-process-source/v1',...scope,actor:{pid:8,uid:0,gid:0},containerInspectionSourceSha256:inspect,sdkPid:1,sdkStartTimeTicks:'42',files:[],rootControlChain:[],processes:mode==='pre-sdk'?undefined:[{role:'technicalBridge',pid:7,observedState:'absent'}],actualSdkQualified:false};
 function save(name,value){const raw=Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(JSON.stringify(value)+'\n'),file='/root-private/'+name;values.set(file,raw);return{file,expectedUid:0,expectedGid:0,allowedModes:[0o600],expectedSha256:sha(raw)};}
 const f={input,root,sdk,values,calls,save,readSource:ref=>({raw:values.get(ref.file),receipt:{path:ref.file}})};
 f.readStderr=({joinedSource,role})=>{const joined=JSON.parse(values.get(joinedSource.file));return f.readSource(joined.roleSources[role+'Stderr']);};
 f.ports={save,publishScopedRecord:async row=>{calls.push(['publish',row.fileName]);return save(row.fileName,row.value);},command:async(label,args)=>{calls.push(['command',label,args]);const value=args[3]==='0:0'?root:sdk;if(args[3]!=='0:0'&&f.sdkFailure)return{code:1,stdout:Buffer.alloc(0),refs:{stdout:save(label+'.stdout',Buffer.alloc(0))}};const raw=Buffer.from(JSON.stringify(value)+'\n'),actualInvocation={executable:input.executor.executable,args:[...input.executor.argsPrefix,...args]};return{code:0,stdout:raw,actualInvocation,refs:{stdout:save(label+'.stdout',raw),stderr:save(label+'.stderr',Buffer.alloc(0)),command:save(label+'.command.json',{scope:{...scope},args}),invocation:save(label+'.invocation.json',{code:0,actualInvocation})}};}};return f;
}
for(const mode of['pre-sdk','native-peers'])test(mode+' default stage runs Root0 and SDK1000 separately and replays original component bytes',async()=>{
 const f=fixture(mode),out=await captureRoleFilemeta(f.input,f.ports),commands=f.calls.filter(row=>row[0]==='command');assert.deepEqual(commands.map(row=>row[2][3]),['0:0','1000:1000']);assert.ok(commands.every(row=>row[2][4]===f.input.scope.containerId));const checked=verifyRoleFilemeta(out.value,{scope:f.input.scope,mode,expected:f.input,joinedSource:out.source,readStderr:f.readStderr,readSource:f.readSource});assert.equal(checked.sourceKind,'role-split-Root0-filesystem-and-SDK1000-process');const sdk=mode==='pre-sdk'?checked.sdkProcessSource:checked.processes.find(row=>row.role==='sdk');assert.equal(sdk.fds[0].link,'pipe:[1]');assert.equal(out.value.actualSdkQualified,false);
});
test('SDK command permission failure remains a failure, never empty FD or joined success',async()=>{const f=fixture();f.sdkFailure=true;await assert.rejects(captureRoleFilemeta(f.input,f.ports));assert.ok(![...f.values.keys()].some(name=>name.endsWith('-joined.json')));});
test('wrong actor, UID, birth, namespace and missing FD reject the join',async()=>{for(const edit of[v=>v.actor.uid=0,v=>v.processes[0].status=v.processes[0].status.replaceAll('1000','0'),v=>v.processes[0].startTimeTicks='43',v=>v.namespaceId='foreign',v=>delete v.processes[0].fds]){const f=fixture();edit(f.sdk);await assert.rejects(captureRoleFilemeta(f.input,f.ports));}});
test('Root0 native sampler cannot smuggle the SDK role into its own process inventory',async()=>{const f=fixture('native-peers');f.root.processes.push({...f.sdk.processes[0],role:'sdk'});await assert.rejects(captureRoleFilemeta(f.input,f.ports));});
test('later replay rejects source-byte drift or a joined FD substitution',async()=>{const f=fixture(),out=await captureRoleFilemeta(f.input,f.ports);const altered=structuredClone(out.value);altered.sdkProcessSource.fds=[];assert.throws(()=>verifyRoleFilemeta(altered,{scope:f.input.scope,mode:'pre-sdk',expected:f.input,joinedSource:out.source,readStderr:f.readStderr,readSource:f.readSource}));f.values.set(out.value.roleSources.sdkSample.file,Buffer.from('{}'));assert.throws(()=>verifyRoleFilemeta(out.value,{scope:f.input.scope,mode:'pre-sdk',expected:f.input,joinedSource:out.source,readStderr:f.readStderr,readSource:f.readSource}));});

test('role provenance replays exact executor argv, fixed entries and raw stderr',async()=>{
 for(const edit of [
  f=>{const ref=f.out.value.roleSources.sdkInvocation,value=JSON.parse(f.values.get(ref.file));value.actualInvocation.args[5]='0:0';f.values.set(ref.file,Buffer.from(JSON.stringify(value)+'\n'));ref.expectedSha256=sha(f.values.get(ref.file));},
  f=>{const ref=f.out.value.roleSources.rootInvocation,value=JSON.parse(f.values.get(ref.file));value.actualInvocation.executable='/foreign/docker';f.values.set(ref.file,Buffer.from(JSON.stringify(value)+'\n'));ref.expectedSha256=sha(f.values.get(ref.file));},
  f=>{f.out.value.roleSources.sdkEntry='/foreign/probe.mjs';},
  f=>{f.values.set(f.out.value.roleSources.sdkStderr.file,Buffer.from('unrecorded stderr'));}
 ]){const f=fixture();f.out=await captureRoleFilemeta(f.input,f.ports);edit(f);assert.throws(()=>verifyRoleFilemeta(f.out.value,{scope:f.input.scope,mode:'pre-sdk',expected:f.input,joinedSource:f.out.source,readStderr:f.readStderr,readSource:f.readSource}));}
});

test('default filesystem stderr reader permits only the two exact empty raw logs',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'role-stderr-'));fs.chmodSync(root,0o700);const owner={uid:process.getuid(),gid:process.getgid()};
 const pin=(name,raw)=>{const file=path.join(root,name);fs.writeFileSync(file,raw,{mode:0o600});return{file,trustedRoot:root,expectedUid:owner.uid,expectedGid:owner.gid,allowedModes:[0o600],ownerOnlyAncestors:true,forbiddenRoots:[],forbiddenFiles:[],expectedSha256:sha(raw)};};
 try{const a=pin('root.stderr',Buffer.alloc(0)),b=pin('sdk.stderr',Buffer.alloc(0)),joinedSource=pin('joined.json',Buffer.from(JSON.stringify({schema:'root-wave02-actual-pre-sdk-filemeta/v1',roleSources:{rootStderr:a,sdkStderr:b}})+'\n'));
 for(const role of['root','sdk'])assert.equal(readRoleStderr({joinedSource,role},{expectedOwner:owner}).raw.length,0);
 assert.throws(()=>readRoleStderr({joinedSource,role:'stdout'},{expectedOwner:owner}));fs.chmodSync(a.file,0o644);assert.throws(()=>readRoleStderr({joinedSource,role:'root'},{expectedOwner:owner}));fs.chmodSync(a.file,0o600);fs.writeFileSync(a.file,'changed');assert.throws(()=>readRoleStderr({joinedSource,role:'root'},{expectedOwner:owner}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('another valid joined record cannot substitute a different stderr path with the same empty SHA',async()=>{
 const f=fixture(),out=await captureRoleFilemeta(f.input,f.ports),other=structuredClone(out.value);
 other.roleSources.sdkStderr=f.save('another-sdk.stderr',Buffer.alloc(0));assert.equal(other.roleSources.sdkStderr.expectedSha256,out.value.roleSources.sdkStderr.expectedSha256);
 const joinedSource=f.save('another-joined.json',Buffer.from(JSON.stringify(other)+'\n'));
 assert.throws(()=>verifyRoleFilemeta(out.value,{scope:f.input.scope,mode:'pre-sdk',expected:f.input,joinedSource,readStderr:f.readStderr,readSource:f.readSource}),/Joined record differs/);
});
