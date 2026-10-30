import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertContainerAllocation,assertContainerIdentity} from './container-identity.mjs';
import {bindNamedVolumeMounts} from './container-mounts.mjs';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=value=>typeof value==='string'&&value.startsWith('/')&&value!=='/'&&path.posix.normalize(value)===value&&!/[\x00-\x1f\x7f\\]/u.test(value);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
export function compilePhysicalCase(input){
 assertContainerAllocation(input);assert.equal(input.containerId,null);assert.match(input.imageId,/^sha256:[a-f0-9]{64}$/u);
 assert.ok(token(input.containerName));assert.ok(token(input.rootExecutionNamespace));assert.ok(digest(input.nonce));
 const identity=input.runtimeIdentity;assert.ok(Number.isSafeInteger(identity.uid)&&identity.uid>0&&Number.isSafeInteger(identity.gid)&&identity.gid>0);assert.equal(identity.user,identity.uid+':'+identity.gid);
 assert.deepEqual(Object.keys(input.labelKeys).sort(),['caseId','namespaceId','nonce','owner']);assert.equal(new Set(Object.values(input.labelKeys)).size,4);assert.ok(Object.values(input.labelKeys).every(token));
 assert.equal(input.mappings.length,5);assert.deepEqual(input.mappings.map(r=>r.role).sort(),['agentsHome','channel','nativeOutput','profile','workspace']);
 for(const row of input.mappings){assert.ok(token(row.volumeName)&&canonical(row.rootPath)&&canonical(row.guestPath));assert.equal(row.writable,true);assert.equal(row.rootWritable,true);}
 for(const field of ['volumeName','rootPath','guestPath'])for(let i=0;i<5;i++)for(let j=0;j<i;j++)assert.ok(field==='volumeName'?input.mappings[i][field]!==input.mappings[j][field]:!overlap(input.mappings[i][field],input.mappings[j][field]));
 assert.ok(canonical(input.runtimeGuestEntry));assert.ok(Array.isArray(input.runtimeArgs)&&input.runtimeArgs.every(x=>typeof x==='string'));
 const labels=Object.fromEntries(Object.entries({caseId:input.caseId,namespaceId:input.namespaceId,owner:'root',nonce:input.nonce}).map(([key,value])=>[input.labelKeys[key],value]));
 const args=['container','create','--name',input.containerName,'--network','none','--user',identity.user,'--pull','never'];
 for(const [key,value]of Object.entries(labels))args.push('--label',key+'='+value);
 for(const row of input.mappings)args.push('--mount','type=volume,src='+row.volumeName+',dst='+row.guestPath);
 args.push('--entrypoint','node',input.imageId,input.runtimeGuestEntry,...input.runtimeArgs);
 return Object.freeze({...structuredClone(input),schema:'root-physical-container-plan/v1',labels,commands:[{kind:'require-exact-name-absent',args:['container','inspect',input.containerName,'--format','{{json .}}']},{kind:'create-physical-container',args}],runtimeQualification:false,businessAdmission:false});
}
function rawReceipt(row,args,namespace){assert.equal(row.executionNamespace,namespace);assert.deepEqual(row.args,args);assert.ok(Buffer.isBuffer(row.stdout)&&Buffer.isBuffer(row.stderr));return row;}
function jsonReceipt(row,args,namespace){rawReceipt(row,args,namespace);assert.equal(row.code,0);const value=JSON.parse(row.stdout);if(Array.isArray(value)){assert.equal(value.length,1);return value[0];}return value;}
export function bindPhysicalCase(plan,{receipts,volumeReceipts,rootInspectReceipt,rootIdentity,forbiddenSources}){
 assert.equal(plan.schema,'root-physical-container-plan/v1');assert.equal(receipts.length,3);const ns=plan.rootExecutionNamespace;
 const absent=rawReceipt(receipts[0],plan.commands[0].args,ns);assert.equal(absent.code,1);assert.ok(/no such (container|object)/iu.test(absent.stderr.toString())&&absent.stderr.toString().includes(plan.containerName));
 const created=rawReceipt(receipts[1],plan.commands[1].args,ns);assert.equal(created.code,0);const id=created.stdout.toString().trim();assert.ok(digest(id));
 const actual=jsonReceipt(receipts[2],['container','inspect',id,'--format','{{json .}}'],ns),expected={caseId:plan.caseId,namespaceId:plan.namespaceId,containerId:id,imageId:plan.imageId,runtimeIdentity:plan.runtimeIdentity,labelKeys:plan.labelKeys,nonce:plan.nonce};
 assertContainerIdentity(expected,{id:actual.Id,image:actual.Image,user:actual.Config.User,network:actual.HostConfig.NetworkMode,privileged:actual.HostConfig.Privileged,labels:actual.Config.Labels});assert.equal(actual.Name,'/'+plan.containerName);assert.equal(actual.State.Status,'created','Physical binding requires never-started created state');for(const field of ['Running','Paused','Restarting','OOMKilled','Dead'])assert.equal(actual.State[field],false);assert.equal(actual.State.Pid,0);assert.equal(actual.State.ExitCode,0);assert.equal(actual.State.Error,'');const zero=/^0001-01-01T00:00:00(?:\.0+)?Z$/u;assert.ok(zero.test(actual.State.StartedAt)&&zero.test(actual.State.FinishedAt),'Previously started container forbidden');assert.equal(actual.RestartCount,0);assert.ok(actual.HostConfig.PortBindings===null||Object.keys(actual.HostConfig.PortBindings??{}).length===0);assert.ok(actual.HostConfig.Binds===null||actual.HostConfig.Binds?.length===0);
 const root=jsonReceipt(rootInspectReceipt,['container','inspect',rootIdentity.containerId,'--format','{{json .}}'],ns);assert.equal(root.Id,rootIdentity.containerId);assert.equal(root.Image,rootIdentity.imageId);assert.equal(root.Config.User,'0:0');assert.equal(root.HostConfig.NetworkMode,rootIdentity.networkMode);assert.equal(root.HostConfig.Privileged,false);
 assert.equal(volumeReceipts.length,5);const volumes=volumeReceipts.map(row=>jsonReceipt(row,['volume','inspect',row.args[2],'--format','{{json .}}'],ns));
 const bindings=bindNamedVolumeMounts({mappings:plan.mappings,volumes,candidateMounts:actual.Mounts,rootMounts:root.Mounts,forbiddenSources});
 const roles=Object.fromEntries(bindings.map(row=>[row.role,row]));
 return{schema:'root-physical-container-binding/v1',caseScope:{...expected,containerIdentity:expected,containerName:plan.containerName,rootExecutionNamespace:ns,guestWorkspacePath:roles.workspace.guestPath,guestProfileDirectory:roles.profile.guestPath,guestAgentsHome:roles.agentsHome.guestPath,guestNativeOutputDirectory:roles.nativeOutput.guestPath,guestChannelDirectory:roles.channel.guestPath,mountBindings:bindings},receiptPins:[...receipts,...volumeReceipts,rootInspectReceipt].map(row=>({args:row.args,code:row.code,stdoutSha256:sha(row.stdout),stderrSha256:sha(row.stderr)})),runtimeQualification:false,businessAdmission:false};
}
