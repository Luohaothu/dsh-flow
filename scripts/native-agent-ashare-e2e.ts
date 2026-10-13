/** Strict prospective comparison. Preparation never invokes a model. */
import {cpSync,existsSync,mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {parse,stringify} from 'yaml';
import {object} from '../src/host/host.ts';
import {identity,installedRuntime,readJson,ROOT,sha,tree,writeJson} from './native-agent-ashare-e2e-lib.ts';
const argv=process.argv.slice(2), action=argv[0];
const arg=(n:string)=>{const i=argv.indexOf(`--${n}`);return i<0?undefined:argv[i+1];};
const required=(n:string)=>{const v=arg(n);if(!v)throw new Error(`Missing --${n}`);return v;};
if(!action||action==='help'||argv.includes('--help')){
 console.log('prepare --phase baseline|optimized --profile-dir PATH --credentials-file PATH [--settings-url-file PATH] [--timeout-ms 1800000]\nrun-stage --phase PHASE --stage 01-ordinary|02-team|03-team|04-ordinary --execute\nsummarize --phase PHASE');
}else{
 const phase=required('phase');if(!['baseline','optimized'].includes(phase))throw new Error('Invalid phase');
 const base=join(ROOT,'.artifacts/strict-agent-comparison-20261013'),campaign=join(base,phase);
 if(action==='prepare'){
  if(existsSync(campaign))throw new Error('Campaign exists: never overwrite evidence');
  mkdirSync(campaign,{recursive:true});mkdirSync(join(campaign,'.private'),{mode:0o700});
  const source=resolve(arg('package-path')??join(ROOT,'packages/dsh-flow'));
  const frozen=join(campaign,'frozen-package');mkdirSync(frozen);
  for(const name of ['lib','skills','package.json','cordis.patch.yml'])cpSync(join(source,name),join(frozen,name),{recursive:true});
  symlinkSync(join(ROOT,'packages/dsh-flow/node_modules'),join(frozen,'node_modules'),'dir');
  const old=readFileSync(join(ROOT,'tests/acceptance/native-live.ts'),'utf8');
  const promptBlock=old.match(/const prompt = \[([\s\S]*?)\]\.join\('\\n'\);/);if(!promptBlock)throw new Error('Existing common prompt unavailable');
  // Parse only the existing literal array; no source evaluation.
  const lines=[...promptBlock[1]!.matchAll(/^  '((?:[^'\\]|\\.)*)',?$/gm)].map(m=>m[1]!.replace(/\\'/g,"'").replace(/\\\\/g,'\\'));
  if(lines.length!==5)throw new Error('Unexpected common prompt shape');
  const prompt=lines.join('\n');
  const modes={ordinary:'本轮由当前单 Agent 直接完成上述任务，禁止创建 Flow 团队或委派任何子 Agent。',team:'本轮使用 Flow 团队完成上述任务，并至少委派一项实际业务工作；不规定成员人数、层级或固定评审角色。'};
  const prior=join(base,'baseline');
  if(phase==='optimized'){
   if(!existsSync(join(prior,'manifest.json')))throw new Error('Baseline must be prepared first');
   if(readFileSync(join(prior,'task.txt'),'utf8')!==prompt||Object.entries(modes).some(([mode,text])=>readFileSync(join(prior,`${mode}-mode.txt`),'utf8')!==text))throw new Error('Cross-version task/mode drift');
  }
  writeFileSync(join(campaign,'task.txt'),prompt);for(const [mode,text]of Object.entries(modes))writeFileSync(join(campaign,`${mode}-mode.txt`),text);
  const profile=resolve(required('profile-dir'));
  const parsed:unknown=parse(readFileSync(join(profile,'cordis.patch.yml'),'utf8'));if(!Array.isArray(parsed))throw new Error('Expected profile patch sequence');
  const rows=parsed.map(object).filter(r=>['llm-pi-ai','agent-default-model','agent-preset-registry','permission','sandbox-policy'].includes(String(r.id)));
  if(arg('settings-url-file')){
   const auth=readFileSync(resolve(arg('settings-url-file')!),'utf8').trim();
   const r=await fetch(auth,{redirect:'manual',signal:AbortSignal.timeout(30000)}),cookie=r.headers.getSetCookie().map(h=>h.split(';')[0]).join('; ');
   if(!cookie)throw new Error('Settings authentication failed');
   const response=await fetch(`${new URL(auth).origin}/api/settings/describe`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'settings/describe',payload:{args:{}}}),signal:AbortSignal.timeout(30000)});
   const result=object(object(await response.json()).result);if(!result.ok)throw new Error('Settings read failed');
   const namespaces=object(result.value).namespaces;if(!Array.isArray(namespaces))throw new Error('No settings namespaces');
   for(const ns of namespaces.map(object))if(['llm-pi-ai','agent-default-model'].includes(String(ns.ns))){const i=rows.findIndex(r=>r.id===ns.ns),row={id:ns.ns,config:ns.value};if(i<0)rows.push(row);else rows[i]=row;}
  }
  const provider='qwen-token-plan-cn', model='deepseek-v4.1-flash';
  const llm=rows.find(r=>r.id==='llm-pi-ai');if(!llm)throw new Error('LLM configuration missing');
  const selected=object(object(object(llm.config).providers)[provider]);
  // Same single provider configuration for every arm, no unrelated credentials.
  llm.config={...object(llm.config),providers:{[provider]:selected}};
  const key=selected.apiKeyEnv;if(typeof key!=='string')throw new Error('Expected native credential reference');
  const credentials=object(parse(readFileSync(resolve(required('credentials-file')),'utf8'))),refs=object(credentials.refs);
  if(typeof refs[key]!=='string'||!refs[key])throw new Error('Selected credential reference missing');
  writeFileSync(join(campaign,'.private/profile.patch.yml'),stringify(rows),{mode:0o600});
  writeFileSync(join(campaign,'.private/credentials.yml'),stringify({version:1,refs:{[key]:refs[key]}}),{mode:0o600});
  const timeout=Number(arg('timeout-ms')??1800000);if(!Number.isSafeInteger(timeout)||timeout<=0)throw new Error('Invalid timeout');
  const stages=[{id:'01-ordinary',mode:'ordinary',pair:1},{id:'02-team',mode:'team',pair:1},{id:'03-team',mode:'team',pair:2},{id:'04-ordinary',mode:'ordinary',pair:2}];
  writeJson(join(campaign,'runtime-dependencies.json'),installedRuntime());writeJson(join(campaign,'package-files.json'),tree(frozen));
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).stdout.trim();
  writeJson(join(campaign,'manifest.json'),{version:1,phase,prepared_at:new Date().toISOString(),source_commit:git,package_source:source,route:{provider,model,reasoningEffort:'max',preset:'standard'},date:'2026-10-12',timeout_ms:timeout,stages,common_prompt_sha256:sha(prompt),mode_prompt_sha256:Object.fromEntries(Object.entries(modes).map(([k,v])=>[k,sha(v)])),identity:identity(campaign),constraints:{model_requests_during_prepare:0,serial:true,retries:0,ordinary_no_delegation:true,team_actual_collaborator_minimum:1,fixed_team_roles:false,quality:'separate independent offline review; native execution is not quality acceptance',provider_cache:'provider cache is neither cleared nor assumed equal; record native cache usage',tool_policy:'standard preset, unchanged native permissions; mode prompt and Flow activation are the treatment'}});
  console.log(JSON.stringify({status:'PREPARED_NO_MODEL_CALLS',manifest:join(campaign,'manifest.json'),stages}));
 }else if(action==='run-stage'){
  if(!argv.includes('--execute'))throw new Error('Missing explicit --execute');
  const stage=required('stage');
  const r=spawnSync(process.execPath,['--import','tsx',join(ROOT,'scripts/native-agent-ashare-stage.ts'),'--campaign',campaign,'--stage',stage,'--execute'],{cwd:ROOT,stdio:'inherit',env:process.env});
  process.exitCode=r.status??1;
 }else if(action==='summarize'){
  const manifest=readJson(join(campaign,'manifest.json'));
  const runs=manifest.stages.map((s:{id:string;pair:number;mode:string})=>{const path=join(campaign,'runs',s.id,'report.json');return{...s,report:existsSync(path)?readJson(path):null};});
  const output={phase,generated_at:new Date().toISOString(),manifest_sha256:sha(readFileSync(join(campaign,'manifest.json'))),runs,quality_acceptance:'Separate QA files are required; failure stages remain in both the run inventory and pair denominators. No selective reruns.'};
  writeJson(join(campaign,'comparison.json'),output);console.log(JSON.stringify({report:join(campaign,'comparison.json')}));
 }else throw new Error('Unknown action');
}
