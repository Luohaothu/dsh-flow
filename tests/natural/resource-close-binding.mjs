import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertContainerIdentity,assertContainerScope} from './container-identity.mjs';
export const RESOURCE_CASE_KEYS=Object.freeze(['caseId','candidateId','namespaceId','containerId','imageId','generationId','nativeObserverSourceSha256','accountingScope']);
const ROOT_KEYS=['namespaceId','containerId','generationId'];
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const frozen=value=>{const copy=structuredClone(value);const visit=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(visit);Object.freeze(x);}return x;};return visit(copy);};
const tuple=(value,keys)=>Object.fromEntries(keys.map(key=>{assert.ok(typeof value[key]==='string'&&value[key]);return[key,value[key]];}));
const sorted=cases=>cases.map(row=>tuple(row.scope??row,RESOURCE_CASE_KEYS)).sort((a,b)=>a.caseId.localeCompare(b.caseId));
/** The physical identity is an independent Root input; qualification scope need not embed it. */
export function bindCaseContainerIdentity(scope,identity){
 assertContainerScope(scope);assertContainerScope(identity);
 for(const key of['caseId','namespaceId','containerId','imageId'])assert.equal(identity[key],scope[key],'Physical identity '+key+' differs');
 assert.ok(typeof scope.nonce==='string'&&scope.nonce.length>=32);assert.equal(identity.nonce,scope.nonce);
 assert.ok(identity.runtimeIdentity&&identity.labelKeys,'Root-frozen physical identity fields missing');
 return frozen(identity);
}
/** Resources can be absent after a nonzero exit without receiving normal/F6 credit. */
export function assertContainerResourceState(value,identity,{kind,waitOutput}={}) {
 assertContainerIdentity(identity,{id:value.Id,image:value.Image,user:value.Config.User,network:value.HostConfig.NetworkMode,privileged:value.HostConfig.Privileged,labels:value.Config.Labels});
 assert.equal(value.State.Running,false);assert.equal(value.State.Pid,0);
 if(kind==='created'){
  assert.equal(value.State.Status,'created');assert.equal(value.RestartCount,0);
  for(const key of['Paused','Restarting','OOMKilled','Dead'])assert.equal(value.State[key],false);
  assert.equal(value.State.ExitCode,0);assert.equal(value.State.Error,'');
  for(const key of['StartedAt','FinishedAt'])assert.match(value.State[key],/^0001-01-01T00:00:00(?:\.0+)?Z$/u);
  return frozen({kind:'created',sdkNeverStarted:true,normalExit:null});
 }
 assert.equal(kind,'exited');assert.equal(value.State.Status,'exited');assert.ok(Number.isInteger(value.State.ExitCode));
 assert.ok(Buffer.isBuffer(waitOutput));assert.match(waitOutput.toString('utf8'),/^\d+\s*$/u);assert.equal(Number(waitOutput.toString().trim()),value.State.ExitCode);
 return frozen({kind:'exited',sdkNeverStarted:false,exitCode:value.State.ExitCode,normalExit:value.State.ExitCode===0&&value.State.OOMKilled===false});
}
/** A Root may close only against the exact receipt it retained after current-case replay. */
export function createResourceCloseBinding({root,cases,owner},{readReceipt,verifyCaseReceipt}) {
 assert.equal(typeof readReceipt,'function');assert.equal(typeof verifyCaseReceipt,'function');
 const expectedRoot=frozen(tuple(root,ROOT_KEYS)),expectedCases=frozen(sorted(cases));
 assert.equal(new Set(expectedCases.map(row=>row.caseId)).size,expectedCases.length);
 assert.equal(new Set(expectedCases.map(row=>row.containerId)).size,expectedCases.length);
 const sourceOwner=frozen(owner);assert.ok(Number.isInteger(sourceOwner.uid)&&Number.isInteger(sourceOwner.gid));assert.ok(sourceOwner.modes.length>0);
 let retained,retaining=false;
 async function replay(reference){
  assert.ok(path.isAbsolute(reference.file)&&path.resolve(reference.file)===reference.file);
  assert.deepEqual([reference.expectedUid,reference.expectedGid],[sourceOwner.uid,sourceOwner.gid]);assert.ok(Array.isArray(reference.allowedModes)&&reference.allowedModes.length>0&&reference.allowedModes.every(mode=>sourceOwner.modes.includes(mode)));
  const loaded=await readReceipt(reference);assert.ok(Buffer.isBuffer(loaded.raw));assert.equal(sha(loaded.raw),reference.expectedSha256);
  const record=frozen(JSON.parse(loaded.raw));assert.equal(record.schema,'root-owned-resource-close/v1');assert.deepEqual(tuple(record.root,ROOT_KEYS),expectedRoot);
  assert.deepEqual(sorted(record.cases),expectedCases,'Resource receipt omits, duplicates or substitutes an owned case');
  assert.equal(record.businessCredit,false);assert.equal(record.F6,'unknown');
  for(const row of record.cases){const outcome=await verifyCaseReceipt(row);assert.equal(outcome.schema,'root-case-resource-validation/v1');assert.deepEqual(tuple(outcome.scope,RESOURCE_CASE_KEYS),tuple(row.scope,RESOURCE_CASE_KEYS));assert.equal(outcome.resourcesClosed,true);assert.equal(outcome.businessCredit,false);assert.equal(outcome.F6,'unknown');}
  return frozen({reference,record});
 }
 return Object.freeze({
  async retain(reference){assert.equal(retained,undefined,'Resource source is retained once');assert.equal(retaining,false,'Resource retention is already in progress');retaining=true;const snapshot=frozen(reference);try{const result=await replay(snapshot);retained=snapshot;return result;}finally{retaining=false;}},
  async require(reference){const snapshot=frozen(reference);assert.ok(retained,'This Root has not retained a resource-close source');assert.deepEqual(snapshot,retained,'Close must use this exact retained resource reference');return replay(snapshot);},
  get reference(){return retained?frozen(retained):null;},
 });
}
