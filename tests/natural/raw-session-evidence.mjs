import assert from 'node:assert/strict';

const clone=value=>structuredClone(value);
const id=value=>{assert.ok(typeof value==='string'&&value);return value;};
const unique=values=>{values.forEach(id);assert.equal(new Set(values).size,values.length);return values;};
const sameIds=(left,right)=>assert.deepEqual([...unique(left)].sort(),[...unique(right)].sort());
const identity=header=>{
  assert.ok(header&&typeof header==='object'&&!Array.isArray(header));assert.ok([Object.prototype,null].includes(Object.getPrototypeOf(header)));
  const keys=['version','id','createdAt','cwd','parentSession','isSeeded','origin','delegationDepth','agentPreset'];for(const key of Reflect.ownKeys(header))assert.ok(keys.includes(key),'Unknown rc.2 SessionHeader field');
  assert.equal(header.version,4);id(header.id);assert.ok(Number.isSafeInteger(header.createdAt)&&header.createdAt>=0);assert.equal(typeof header.isSeeded,'boolean');
  if(header.cwd!==undefined)assert.ok(typeof header.cwd==='string'&&header.cwd.startsWith('/'));
  if(header.parentSession!==undefined)assert.equal(typeof header.parentSession,'string');
  if(header.origin!==undefined)assert.equal(header.origin,'subagent');
  if(header.delegationDepth!==undefined)assert.ok(Number.isSafeInteger(header.delegationDepth)&&header.delegationDepth>=0);
  if(header.agentPreset!==undefined)assert.equal(typeof header.agentPreset,'string');
  // SDK validates missing/undefined optional properties alike; only depth has a
  // documented zero default. Null and empty strings are never used as defaults.
  return{version:header.version,id:header.id,createdAt:header.createdAt,cwd:header.cwd,parentSession:header.parentSession,isSeeded:header.isSeeded,origin:header.origin,delegationDepth:header.delegationDepth===undefined?0:header.delegationDepth,agentPreset:header.agentPreset};
};
const headers=(left,right)=>assert.deepEqual(identity(left),identity(right),'Session source identity changed');
function events(value){assert.ok(Array.isArray(value));value.forEach((event,index)=>{assert.equal(event.seq,index,'Complete contiguous log required');assert.ok(typeof event.type==='string'&&event.type);});return value;}
function liveBody(session){
  assert.equal(session.id,session.header.id);const nextSeq=session.seq;assert.ok(Number.isSafeInteger(nextSeq)&&nextSeq>=0);const snapshot=clone(session.snapshotEvents(0,nextSeq));assert.equal(session.seq,nextSeq,'Live source changed during snapshot');
  return{header:clone(session.header),firstLiveSeq:session.firstLiveSeq,inheritedEventCount:session.inheritedEventCount,nextSeq,readRange:{from:0,toExclusive:nextSeq},events:snapshot};
}
const errorRecord=(source,error,sessionId)=>({source,...(sessionId?{sessionId}:{}),name:error?.name??'Error',message:error?.message??String(error)});

// Select every source, including the persisted body for an already-live ID.
// Counts describe source observations; the same request in two logs is not two
// physical model attempts. Missing/failed sources never become an empty corpus.
export function selectRawSessionEvidence(input){
  let result;try{assert.ok(input&&typeof input==='object'&&!Array.isArray(input));result=clone(input);}catch(error){return{schema:'natural-raw-session-evidence/v1',status:'unknown',summary:null,sources:null,errors:[errorRecord('collector',error)]};}
  result.schema='natural-raw-session-evidence/v1';result.status='unknown';result.summary=null;
  if(!Array.isArray(result.errors))result.errors=[{source:'collector',name:'Error',message:'Missing source errors'}];
  try{
    assert.equal(input.schema,'natural-raw-session-evidence/v1');assert.equal(input.adapterSdkVersion,'0.2.0-rc.2','Unsupported same-instance read adapter');assert.deepEqual(result.errors,[]);
    const sources=result.sources;assert.ok(sources);
    for(const name of ['agents','sessions','query','persisted']){
      const source=sources[name];assert.ok(source&&Array.isArray(source.before)&&Array.isArray(source.after),`Missing ${name} source`);
      const a=source.before.map(row=>row.header),b=source.after.map(row=>row.header);sameIds(a.map(row=>row.id),b.map(row=>row.id));
      for(const header of a){const later=b.find(row=>row.id===header.id);headers(header,later);}
      if(name==='agents'||name==='sessions')for(const row of source.before){
        events(row.events);assert.equal(row.nextSeq,row.events.length);assert.deepEqual(row.readRange,{from:0,toExclusive:row.nextSeq});
        assert.ok(Number.isSafeInteger(row.firstLiveSeq)&&row.firstLiveSeq>=0&&row.firstLiveSeq<=row.nextSeq);assert.ok(Number.isSafeInteger(row.inheritedEventCount)&&row.inheritedEventCount>=0&&row.inheritedEventCount<=row.firstLiveSeq);
        if(row.header.isSeeded===false)assert.equal(row.inheritedEventCount,0);
        assert.deepEqual(source.after.find(item=>item.header.id===row.header.id),row,'Live source changed during collection');
      }
      if(name==='persisted')for(const row of source.before)assert.deepEqual(source.after.find(item=>item.header.id===row.header.id),row,'Persisted listing changed during read');
      if(name==='query')for(const row of source.before){assert.equal(typeof row.live,'boolean');assert.equal(typeof row.persisted,'boolean');const later=source.after.find(item=>item.header.id===row.header.id);assert.equal(row.live,later.live);assert.equal(row.persisted,later.persisted);}
    }
    const allHeaders=['agents','sessions','query','persisted'].flatMap(name=>sources[name].before.map(row=>row.header));
    const sessionIds=[...new Set(allHeaders.map(row=>row.id))];
    for(const header of allHeaders)headers(header,allHeaders.find(row=>row.id===header.id));
    assert.ok(Array.isArray(sources.query.logs)&&Array.isArray(sources.persisted.logs));
    sameIds(sources.query.logs.map(row=>row.sessionId),sessionIds);
    sameIds(sources.persisted.logs.map(row=>row.sessionId),sources.persisted.before.map(row=>row.header.id));
    for(const row of sources.query.logs){assert.equal(row.log.session.id,row.sessionId);headers(row.log.session,allHeaders.find(header=>header.id===row.sessionId));events(row.log.events);assert.ok(Number.isSafeInteger(row.log.inheritedEventCount)&&row.log.inheritedEventCount>=0&&row.log.inheritedEventCount<=row.log.events.length);}
    for(const row of sources.persisted.logs){
      assert.equal(row.header.id,row.sessionId);headers(row.header,allHeaders.find(header=>header.id===row.sessionId));assert.equal(row.access,'read');assert.equal(row.readOffset,0);assert.equal(row.closeSucceeded,true);assert.equal(row.syntheticClosersApplied,false);
      assert.ok(['detached','shared-frozen'].includes(row.eventState));events(row.events);assert.ok(Number.isSafeInteger(row.inheritedEventCount)&&row.inheritedEventCount>=0&&row.inheritedEventCount<=row.events.length);
    }
    const count=rows=>({requestHeaders:rows.filter(row=>row.type==='request/header').length,businessEvents:rows.filter(row=>/^(user|assistant|tool|turn|step)\//u.test(row.type)).length});
    const agents=count(sources.agents.before.flatMap(row=>row.events)),sessions=count(sources.sessions.before.flatMap(row=>row.events)),query=count(sources.query.logs.flatMap(row=>row.log.events)),persisted=count(sources.persisted.logs.flatMap(row=>row.events));
    result.summary={sessionIds,agents,sessions,query,persisted,requestHeaderObservations:agents.requestHeaders+sessions.requestHeaders+query.requestHeaders+persisted.requestHeaders,businessEventObservations:agents.businessEvents+sessions.businessEvents+query.businessEvents+persisted.businessEvents,logBoundary:'SDK-valid-contiguous-prefix',physicalAttemptCount:null};result.status='complete';
  }catch(error){if(!result.errors.length)result.errors.push(errorRecord('source-validation',error));}
  return result;
}

export function assertRawSessionZero(input){
  const result=selectRawSessionEvidence(input);assert.equal(result.status,'complete','Complete SDK source evidence unavailable');assert.equal(result.summary.requestHeaderObservations,0,'Request header exists in SDK source');assert.equal(result.summary.businessEventObservations,0,'Business event exists in SDK source');return result;
}

// The facade is the actual SDK's read-only services. Live bodies use this locked
// SDK's snapshotEvents(0, seq), including inherited events. That synchronous API
// is deprecated; it is used explicitly for this isolated source audit, not as a
// replacement for the normal async query path or as a new product integration.
// There is no restoration, write handle, flush, create or prompt operation.
export async function collectRawSessionEvidence({agents,sessions,sessionQuery,sessionPersistence,sdkVersion,now=Date.now}){
  const result={schema:'natural-raw-session-evidence/v1',adapterSdkVersion:sdkVersion,startedAt:now(),sources:{agents:{},sessions:{},query:{logs:[]},persisted:{logs:[]}},errors:[]};
  if(sdkVersion!=='0.2.0-rc.2'){result.errors.push({source:'same-instance-adapter',name:'Error',message:'SDK version must be bound to 0.2.0-rc.2'});return selectRawSessionEvidence(result);}
  try{
  const capture=async(source,operation,sessionId)=>{try{return await operation();}catch(error){result.errors.push(errorRecord(source,error,sessionId));return undefined;}};
  const listAgents=()=>{const rows=agents.list();assert.ok(Array.isArray(rows));return rows.map(agent=>liveBody(agent.session));};
  const listSessions=()=>{const rows=sessions.list();assert.ok(Array.isArray(rows));return rows.map(liveBody);};
  const listQuery=async()=>{const rows=await sessionQuery.listSessions();assert.ok(Array.isArray(rows));return rows;};
  const listPersisted=async()=>{const rows=await sessionPersistence.list();assert.ok(Array.isArray(rows));return rows;};
  const listing=[['agents',listAgents],['sessions',listSessions],['query',listQuery],['persisted',listPersisted]];
  for(const[name,list]of listing)result.sources[name].before=await capture(name+'-list-before',async()=>clone(await list()));
  const validHeaders=Object.values(result.sources).flatMap(source=>Array.isArray(source.before)?source.before.map(row=>row?.header):[]);
  const ids=[...new Set(validHeaders.map(header=>header?.id).filter(value=>typeof value==='string'&&value))];
  for(const sessionId of ids){const log=await capture('query-read',async()=>clone(await sessionQuery.readSession(sessionId)),sessionId);if(log!==undefined)result.sources.query.logs.push({sessionId,log});}
  for(const listed of Array.isArray(result.sources.persisted.before)?result.sources.persisted.before:[]){
    const sessionId=listed?.header?.id;if(typeof sessionId!=='string'||!sessionId)continue;
    await capture('persisted-read',async()=>{
      const handle=await sessionPersistence.open(sessionId,'read');let row,readError;
      try{
        assert.equal(handle.id,sessionId);assert.equal(handle.access,'read');headers(handle.header,listed.header);
        const read=await handle.read(0);
        row={sessionId,header:clone(handle.header),inheritedEventCount:handle.inheritedEventCount,access:handle.access,readOffset:0,eventState:read.eventState,events:clone(read.events),syntheticClosersApplied:false,closeSucceeded:false};
        result.sources.persisted.logs.push(row);
      }catch(error){readError=error;throw error;}
      finally{try{await handle.close();if(row)row.closeSucceeded=true;}catch(error){if(readError)result.errors.push(errorRecord('persisted-close',error,sessionId));else throw error;}}
    },sessionId);
  }
  for(const[name,list]of listing)result.sources[name].after=await capture(name+'-list-after',async()=>clone(await list()));
  }catch(error){result.errors.push(errorRecord('collector-shape',error));}
  result.endedAt=now();return selectRawSessionEvidence(result);
}
