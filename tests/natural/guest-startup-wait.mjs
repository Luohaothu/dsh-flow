import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
const keys=['caseId','candidateId','namespaceId','containerId','imageId','generationId','accountingScope','nativeObserverSourceSha256','nonce'];
const stages=['load-sdk','set-workspace','start-model-relay','load-layered-env','run-profile','verify-app-services','publish-setup-ready','await-ui-handoff','await-root-stop','native-close','await-technical-cleanup'];
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const clone=value=>structuredClone(value);
function pinned(reference,raw){assert.ok(reference&&path.posix.isAbsolute(reference.file));assert.deepEqual([reference.expectedUid,reference.expectedGid],[0,0]);assert.deepEqual(reference.allowedModes,[0o600]);assert.match(reference.expectedSha256,/^[a-f0-9]{64}$/u);assert.equal(reference.expectedSha256,sha(raw));return clone(reference);}
function runtimeIdentity(value,expected){
 assert.ok(expected);assert.equal(value.nativePid,expected.pid);assert.equal(value.uid,expected.uid);assert.equal(value.gid,expected.gid);assert.equal(value.startTimeTicks,expected.startTimeTicks);
 const source=value.runtimeProcessSource;assert.equal(source.pid,expected.pid);assert.equal(source.observedState,'present');assert.equal(source.startTimeTicks,expected.startTimeTicks);
 for(const key of['stat','afterStat']){assert.equal(Number(source[key].slice(0,source[key].indexOf(' '))),expected.pid);assert.equal(source[key].slice(source[key].lastIndexOf(')')+2).trim().split(/\s+/u)[19],expected.startTimeTicks);}
 for(const [name,id]of[['Uid',expected.uid],['Gid',expected.gid]]){const row=source.status.split('\n').find(line=>line.startsWith(name+':'));assert.ok(row);assert.deepEqual(row.trim().split(/\s+/u).slice(1),Array(4).fill(String(id)));}
}
function captured(record,scope,kind,expected){
 assert.ok(['captured','pending-missing','pending-half-write'].includes(record.status),'Unknown startup read state');
 if(record.status!=='captured')return clone(record);
 assert.ok(Buffer.isBuffer(record.raw)&&record.raw.length>0);const raw=Buffer.from(record.raw),value=JSON.parse(raw);assert.deepEqual(value,record.value);
 for(const key of keys)assert.equal(value[key],scope[key],'Startup record '+key+' differs');
 assert.equal(value.schema,kind==='ready'?'root-wave02-assembly-setup/v1':'root-wave02-assembly-runtime-error/v2');
 runtimeIdentity(value,expected);
 if(kind==='error'){assert.ok(stages.includes(value.failureStage),'Unknown startup failure stage');assert.equal(value.recoveryRequired,true);assert.equal(value.applicationClosed,false);assert.equal(value.F6,'unknown');}
 return{...clone(record),raw,value,source:pinned(record.source,raw)};
}
function abortError(){return Object.assign(Error('Startup polling aborted'),{code:'STARTUP_POLL_ABORTED'});}
async function pause(wait,signal){
 if(signal?.aborted)throw abortError();let listener;
 try{await Promise.race([Promise.resolve().then(()=>wait(100)),new Promise((_,reject)=>{if(signal){listener=()=>reject(abortError());signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();}})]);}finally{if(listener)signal.removeEventListener('abort',listener);}
}
/** The actual setup wait: preserve originals, choose one terminal outcome, never grant qualification. */
export async function waitForGuestStartup(input,{readRecord,inspect,save,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const {scope,readyFile,errorFile,expectedRuntimeIdentity}=clone({scope:input.scope,readyFile:input.readyFile,errorFile:input.errorFile,expectedRuntimeIdentity:input.expectedRuntimeIdentity}),signal=input.signal;
 for(const key of keys)assert.ok(typeof scope[key]==='string'&&scope[key]);for(const file of[readyFile,errorFile])assert.ok(path.posix.isAbsolute(file)&&path.posix.normalize(file)===file);assert.notEqual(readyFile,errorFile);assert.equal(path.posix.dirname(readyFile),path.posix.dirname(errorFile));
 let terminalSelected=false,lastInspection;
 const persist=async(name,raw)=>pinned(await save(name,raw),raw);
 async function finish(kind,{ready,error,inspection}={}){
  assert.equal(terminalSelected,false);terminalSelected=true;inspection??=lastInspection;
  const originals={};for(const [name,record]of Object.entries({ready,error}))if(record?.status==='captured')originals[name]={inputSource:record.source,rawSource:await persist('startup-'+name+'.raw.json',record.raw),commandSources:record.rawSources??null};
  if(inspection)originals.inspection={inputSource:inspection.source,rawSource:await persist('startup-inspection.raw.json',inspection.raw)};
  const value={schema:'natural-guest-startup-outcome/v1',...Object.fromEntries(keys.map(key=>[key,scope[key]])),kind,originals,inspectionSource:inspection?.source??null,failureStage:error?.value?.failureStage??null,recoveryRequired:kind!=='ready',qualificationGranted:false,F6:'unknown'};
  const source=await persist('startup-outcome.json',Buffer.from(JSON.stringify(value)+'\n'));
  if(kind==='ready')return{...ready,startupOutcomeSource:source};
  const code={failed:'GUEST_STARTUP_FAILED',conflicting:'GUEST_STARTUP_CONFLICT',aborted:'GUEST_STARTUP_ABORTED',exited:'GUEST_STARTUP_EXITED'}[kind];
  const failure=Object.assign(Error(kind==='failed'?'Guest startup failed during '+value.failureStage:'Guest startup '+kind),{name:'GuestStartupError',code,startupOutcomeSource:source,guestErrorSource:originals.error?.rawSource??null,recoveryRequired:true});throw failure;
 }
 try{for(;;){
  if(signal?.aborted)return await finish('aborted');
  const ready=captured(await readRecord(readyFile),scope,'ready',expectedRuntimeIdentity);if(signal?.aborted)return await finish('aborted',{ready});
  const error=captured(await readRecord(errorFile),scope,'error',expectedRuntimeIdentity);if(signal?.aborted)return await finish('aborted',{ready,error});
  if(ready.status==='captured'&&error.status==='captured')return await finish('conflicting',{ready,error});
  if(error.status==='captured')return await finish('failed',{ready,error});
  if(ready.status==='captured'&&error.status==='pending-missing')return await finish('ready',{ready});
  const loadedInspection=await inspect();assert.ok(Buffer.isBuffer(loadedInspection.raw));const inspection={...clone(loadedInspection),raw:Buffer.from(loadedInspection.raw)};assert.ok(Buffer.isBuffer(inspection.raw)&&inspection.raw.length>0);assert.deepEqual(JSON.parse(inspection.raw),inspection.value,'Inspection raw/value differ');inspection.source=pinned(inspection.source,inspection.raw);assert.equal(inspection.value.Id,scope.containerId);assert.equal(inspection.value.Image,scope.imageId);assert.equal(typeof inspection.value.State.Running,'boolean');lastInspection=inspection;
  if(signal?.aborted)return await finish('aborted',{ready,error,inspection});
  if(!inspection.value.State.Running)return await finish('exited',{ready,error,inspection});
  await pause(wait,signal);
 }}catch(error){if(!terminalSelected&&error.code==='STARTUP_POLL_ABORTED')return finish('aborted');throw error;}
}
