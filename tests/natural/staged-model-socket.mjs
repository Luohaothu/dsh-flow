import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {assertContainerScope} from './container-identity.mjs';
const same=(a,b)=>['dev','ino','uid','gid','mode','ctimeNs'].every(key=>a[key]===b[key]);
function socketState(file){const s=fs.lstatSync(file,{bigint:true});assert.ok(s.isSocket()&&!s.isSymbolicLink());return{dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&0o777n),ctimeNs:String(s.ctimeNs)};}
function parentState(options){const {socketPath,trustedRoot,uid,parentGid,parentMode}=options;assert.ok(path.isAbsolute(socketPath)&&path.normalize(socketPath)===socketPath&&Buffer.byteLength(socketPath)<=100);assert.ok(path.isAbsolute(trustedRoot)&&socketPath.startsWith(trustedRoot+'/'));assert.equal(fs.realpathSync(trustedRoot),trustedRoot);let current=trustedRoot;const parts=path.relative(trustedRoot,path.dirname(socketPath)).split(path.sep).filter(Boolean);for(const part of ['',...parts]){if(part)current=path.join(current,part);const s=fs.lstatSync(current);assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(s.uid,uid);assert.equal(s.mode&0o022,0,'Candidate-writable model socket parent');if(current===path.dirname(socketPath)){assert.equal(s.gid,parentGid);assert.equal(s.mode&0o7777,parentMode);}}}
function errorJson(res,status,code){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code}}));}
export function createStagedModelSocket({scope,caseBearer,allowedHosts,validateAdmission,record,serverFactory=http.createServer}){
 assert.ok(typeof scope.generationId==='string'&&scope.generationId);assert.equal(scope.accountingScope,'live-case');const identity=Object.freeze({...assertContainerScope(scope),generationId:scope.generationId,accountingScope:scope.accountingScope});assert.ok(typeof caseBearer==='string'&&caseBearer.length>=16);assert.ok(Array.isArray(allowedHosts)&&allowedHosts.length>0);const hosts=Object.freeze([...allowedHosts]);assert.ok(hosts.every(h=>typeof h==='string'&&h&&h===h.toLowerCase()));assert.equal(typeof validateAdmission,'function');assert.equal(typeof record,'function');
 const id=crypto.randomUUID(),inflight=new Set();let state='created',server,options,originalSocket,handler,closeHandler,closing,healthCount=0,deniedCount=0,promoteCount=0;
 function authenticate(req){assert.ok(hosts.includes((req.headers.host??'').toLowerCase()));const wanted=Buffer.from('Bearer '+caseBearer),actual=Buffer.from(req.headers.authorization??'');assert.ok(wanted.length===actual.length&&crypto.timingSafeEqual(wanted,actual));}
 function snapshot(){return{schema:'root-staged-model-socket/v1',scope:identity,listenId:id,state,healthCount,deniedCount,promoteCount,socket:originalSocket?{...originalSocket}:null,socketPath:options?.socketPath??null,bootstrapModelCredit:false,bootstrapSdkSerializerCredit:false};}
 async function serve(req,res){
  try{authenticate(req);if(state==='closing'||state==='closed'){req.resume();errorJson(res,503,'SOCKET_CLOSING');return;}
   if(state==='bootstrap-not-admitted'){
    if(req.method==='GET'&&req.url==='/health'){healthCount++;await record({event:'authenticated-bootstrap-health',scope:identity,listenId:id});res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...snapshot(),budgetTicketsIssued:0,realModelHttpDispatches:0}));return;}
    deniedCount++;req.resume();await record({event:'bootstrap-request-denied',scope:identity,listenId:id,method:req.method,kind:['/attempts/reserve','/attempts/map','/v1/chat/completions','/v1/responses'].includes(req.url)?req.url:'other',budgetTicketsIssued:0,realModelHttpDispatches:0});errorJson(res,409,'BOOTSTRAP_NOT_ADMITTED');return;
   }
   assert.equal(state,'admitted');await handler(req,res);
  }catch(error){req.resume();if(!res.headersSent)errorJson(res,403,'STAGED_SOCKET_REQUEST_REJECTED');else res.end();}
 }
 function track(req,res){const pending=serve(req,res);inflight.add(pending);pending.finally(()=>inflight.delete(pending)).catch(()=>{});}
 async function listen(value){assert.equal(state,'created');options=Object.freeze({...value});parentState(options);assert.ok(!fs.existsSync(options.socketPath));server=serverFactory(track);server.requestTimeout=0;server.headersTimeout=0;server.listen(options.socketPath);await once(server,'listening');fs.chmodSync(options.socketPath,0o660);originalSocket=socketState(options.socketPath);assert.deepEqual([originalSocket.uid,originalSocket.gid,originalSocket.mode],[options.uid,options.socketGid,0o660]);state='bootstrap-not-admitted';await record({event:'bootstrap-listening',...snapshot()});return snapshot();}
 async function promote(capability,implementation){assert.equal(state,'bootstrap-not-admitted');assert.equal(typeof implementation.handle,'function');assert.equal(typeof implementation.close,'function');state='admission-pending';try{parentState(options);assert.ok(same(socketState(options.socketPath),originalSocket),'Model socket changed before admission');await validateAdmission(capability,{...identity,listenId:id,socketPath:options.socketPath,socket:{...originalSocket}});assert.equal(state,'admission-pending');await record({event:'formal-admission-committed',scope:identity,listenId:id});assert.equal(state,'admission-pending');handler=implementation.handle;closeHandler=implementation.close;promoteCount++;state='admitted';return snapshot();}catch(error){if(state==='admission-pending')state='bootstrap-not-admitted';throw error;}}

 function close(){return closing??=(async()=>{const previous=state;state='closing';if(closeHandler)await closeHandler();if(server){server.closeIdleConnections?.();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}await Promise.all([...inflight]);if(options&&fs.existsSync(options.socketPath)){assert.ok(same(socketState(options.socketPath),originalSocket),'Refuse replacement socket cleanup');fs.unlinkSync(options.socketPath);}state='closed';await record({event:'staged-socket-closed',scope:identity,listenId:id,previous});return snapshot();})();}
 return{listen,promote,close,snapshot};
}
