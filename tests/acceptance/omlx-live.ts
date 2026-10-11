/** Real local-model lifecycle acceptance against the packed rc2 plugin. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DshHost,buildHostEnv,createRunLayout,ensureProfile,WEB_PROFILE_BUNDLES,PROJECT_ROOT,PLUGIN_ROOT} from '../../src/host/host.ts';
import {ipcBridgePatchText,startAcceptanceHost} from './run.ts';
import {computeBuildHashes,buildDrift} from './build-fingerprint.ts';
import {asArray,asObject,requiredString} from './context.ts';

const key=process.env.FLOW_MODEL_API_KEY;
assert(key,'FLOW_MODEL_API_KEY must be configured in the process environment');
const model=process.env.FLOW_MODEL_ID ?? 'Qwen3.8-27B-4bit';
const timeout=Number(process.env.FLOW_LIVE_TIMEOUT_MS ?? 900000);
const layout=createRunLayout(join(PROJECT_ROOT,'.artifacts'),`omlx-lifecycle-${new Date().toISOString().replace(/[:.]/g,'-')}`);
chmodSync(layout.root,0o700);
const redact=(text:string)=>text.replaceAll(key,'[redacted]');
const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--cache',join(layout.tmp,'npm-cache'),'--pack-destination',layout.root],{cwd:PLUGIN_ROOT,encoding:'utf8'})) as {filename:string}[];
const archive=packed[0]!.filename;
execFileSync('tar',['-xzf',join(layout.root,archive),'-C',layout.root]);
const packagePath=join(layout.root,'package');
for(const file of ['index.js','command.js','web.js','client.js','typert.host.js','typert.remote-client.js'])assert.deepEqual(readFileSync(join(packagePath,'lib',file)),readFileSync(join(PLUGIN_ROOT,'lib',file)));
symlinkSync(join(PLUGIN_ROOT,'node_modules'),join(packagePath,'node_modules'),'dir');
const profile='flow-omlx-lifecycle';
ensureProfile(layout.home,profile,{bundles:WEB_PROFILE_BUNDLES,packagePath});
const observerPatch=join(layout.root,'observer.patch.yml');
writeFileSync(observerPatch,`${ipcBridgePatchText()}
- insert:
    - id: native-observer
      name: ${JSON.stringify(join(PROJECT_ROOT,'tests/acceptance/native/host-observer.ts'))}
      config:
        evidencePath: ${JSON.stringify(join(layout.logs,'requests.jsonl'))}
        workspace: ${JSON.stringify(layout.workspace)}
        provider: omlx
        model: ${JSON.stringify(model)}
        timeoutMs: ${timeout}
`);
const patches=[join(PROJECT_ROOT,'examples/cluster.patch.yml'),join(PROJECT_ROOT,'examples/omlx.patch.yml'),observerPatch];
const before=computeBuildHashes({id:''},patches);
const env=buildHostEnv({home:layout.home,tmpdir:layout.tmp,dataDir:layout.data,workspace:layout.workspace,modelRoute:{provider:'omlx',model,baseURL:process.env.FLOW_MODEL_BASE_URL ?? 'http://127.0.0.1:8000/v1'},modelApiKey:key});
const makeHost=(suffix='')=>new DshHost({profile,patches,cwd:layout.workspace,env,logPath:join(layout.logs,`host${suffix}.log`),sanitizeLog:redact});
let host=makeHost();

async function observe(operation:string):Promise<Record<string,unknown>> {
  const child=host.child;assert(child?.connected);
  const requestId=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error(`observer ${operation} timed out`));},timeout+120000);
    const cleanup=()=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exited);};
    const exited=()=>{cleanup();reject(new Error('host exited during real observation'));};
    const receive=(value:unknown)=>{
      const reply=asObject(value);if(reply?.nativeObserver!==true||reply.requestId!==requestId)return;
      cleanup();if(reply.ok!==true)reject(new Error(requiredString(reply.error,'observer error')));
      else {const result=asObject(reply.value);if(result)resolve(result);else reject(new Error('invalid observer result'));}
    };
    child.on('message',receive);child.once('exit',exited);child.send({nativeObserver:true,requestId,operation});
  });
}

let error:string|undefined;
const evidence:Record<string,unknown>={};
try {
  await startAcceptanceHost(host);
  const webUrl=await host.waitForWebUrl();
  const unauth=await fetch(new URL('/',webUrl));assert.equal(unauth.status,401);
  const admission=await fetch(webUrl,{redirect:'manual'});
  const cookie=admission.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const authenticated=admission.status===200 ? admission : await fetch(new URL('/',webUrl),{headers:{cookie}});assert.equal(authenticated.status,200);
  assert.match(await authenticated.text(),/DeepSeek Harness/);
  evidence.http={unauthenticated_status:unauth.status,authenticated_status:authenticated.status};
  evidence.ownership=await observe('ownership');
  const lifecycle=await observe('agent-session');evidence.lifecycle=lifecycle;
  assert.equal(asObject(lifecycle.accepted)?.accepted,true);assert.equal(lifecycle.owned,true);assert.equal(lifecycle.refused,true);
  assert.equal(asObject(lifecycle.run)?.state,'completed');
  const sessionId=requiredString(lifecycle.session_id,'member session');
  const events=asArray(lifecycle.events) ?? [];
  const text=JSON.stringify(events);
  assert.match(text,/NATIVE-AGENT-CONTINUATION/);assert.match(text,/NATIVE-ACTIVE-CONTINUATION/);
  const runId=requiredString(asObject(lifecycle.run)?.id,'run id');
  const db=new DatabaseSync(join(layout.data,'cluster.sqlite'),{readOnly:true});
  try {
    const recipients=db.prepare("SELECT r.* FROM recipients r JOIN messages m ON m.id=r.message_id WHERE m.cluster_id=? AND m.id LIKE 'human:%'").all(runId);
    assert.equal(recipients.length,2,'same RPC intent has one durable delivery');
    assert(recipients.every(row=>row.status==='ACKED'));
    const transactions=db.prepare('SELECT * FROM transactions WHERE cluster_id=?').all(runId);
    assert(transactions.length>0&&transactions.every(row=>row.status==='ACCEPTED'));
    evidence.governance={transactions,validations:db.prepare('SELECT * FROM validation_records WHERE cluster_id=?').all(runId),audits:db.prepare('SELECT * FROM audits WHERE cluster_id=?').all(runId),recipients};
  } finally {db.close();}
  await host.stop();
  host=makeHost('-restarted');
  await startAcceptanceHost(host);
  const requestsBefore=readFileSync(join(layout.logs,'requests.jsonl'),'utf8');
  const cold=[];
  for(let retry=0;retry<2;retry++) {
    const inspected=asObject(await host.request('observation-fixture',undefined,{session_id:sessionId,inspect:true,read:true}));
    assert(inspected);assert.equal(inspected.agent_active,false);assert.equal(inspected.session_live,false);
    assert.equal(asObject(inspected.snapshot)?.type,'snapshot');
    assert.equal(asObject(asObject(inspected.snapshot)?.header)?.agentPreset,'dsh-flow/member');
    cold.push(inspected);
  }
  assert.equal(readFileSync(join(layout.logs,'requests.jsonl'),'utf8'),requestsBefore,'cold reading after restart does not make model requests');
  evidence.cold_after_restart=cold;
  const requests=requestsBefore.trim().split('\n').map(line=>asObject(JSON.parse(line))).filter(row=>row?.purpose!=='session-title');
  assert(requests.length>0&&requests.every(row=>row?.provider==='omlx'&&row.model===model));
  evidence.actual_requests=requests;
  assert.equal(buildDrift(before,computeBuildHashes({id:''},patches)),null);
} catch(caught){error=redact(caught instanceof Error?caught.stack ?? caught.message:String(caught));process.exitCode=1;}
finally {await host.stop();}
const report={status:error?'FAILED':'PASSED',provider:'omlx',model,archive,archive_sha256:createHash('sha256').update(readFileSync(join(layout.root,archive))).digest('hex'),build_before:before,build_after:computeBuildHashes({id:''},patches),evidence,...(error?{error}:{})};
const path=join(layout.root,'report.json');writeFileSync(path,redact(JSON.stringify(report,null,2))+'\n');
console.log(JSON.stringify({status:report.status,report:path,error}));
