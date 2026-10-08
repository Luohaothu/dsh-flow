#!/usr/bin/env node
/** Real DeepSeek tutorial run. No model, route, database or observation fixtures. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from 'playwright';
import { browserExecutablePath, importPlaywright } from '../../src/host/browser.ts';
import { buildHostEnv, createRunLayout, DshHost, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';
import { openLedger, usageSummary } from '../../src/host/ledger.ts';
import type { SqlRow } from '../../src/host/ledger.ts';
import { findSessionFile, readSessionEvents } from '../../src/host/session-scan.ts';
import type { SessionEvent } from '../../src/host/session-scan.ts';
import type { RunLayout } from '../../src/host/types.ts';

export const BUDGET_REQUEST = '/agent-team 帮我核对活动预算：场地费 1500 元、物料费 680 元、茶歇费 420 元，总预算 3000 元。请在当前工作区安排执行智能体使用真实 flow_sum 工具计算总支出和剩余预算，使用 fs_write 写入 budget-report.md，再用 fs_read 读回核对。报告应包含费用明细、计算式、总支出、剩余预算及是否超预算。产物验收标准：总支出 2600 元，余额 400 元，不超预算；报告文件与真实工具返回一致。另按正式独立审计流程安排 Auditor：通过 flow_query 查询已 SETTLED 的 write 效果，检查真实文件路径、写入内容和成功结果，并在自己的会话中重新调用 flow_sum 复算 [1500,680,420] 与 [3000,-2600]。Auditor 审查的是已结算写入证据，禁止声称它直接使用 fs_read 读取文件。产物核验与独立审计都通过后，在主会话如实交付文件路径和各角色实际使用的证据，并完成团队收尾。';

interface Options { runId: string; timeoutMs: number; prepareOnly: boolean; keepHost: boolean; debugPort?: number }
interface Check { name: string; passed: boolean; evidence: unknown }
interface Report {
  status: 'PREPARED' | 'RUNNING' | 'PASSED' | 'FAILED';
  run_id: string; started_at: string; ended_at?: string;
  route: { provider: string; model: string; base_url: string; reasoning: string };
  workspace: string; host_pid?: number; main_session_id?: string; team_id?: string;
  checks: Check[]; screenshots: string[]; error?: string;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function options(argv: readonly string[]): Options | null {
  if (argv.includes('--help')) {
    console.log('Usage: node --import tsx tests/acceptance/deepseek-case.ts --run-id <fresh-id> [--timeout-ms 900000] [--prepare-only] [--keep-host] [--debug-port 9223]\nOffline review: node --import tsx tests/acceptance/deepseek-case.ts --verify-only <existing-run-directory>\nReal requests require FLOW_MODEL_API_KEY. FLOW_MODEL_ID defaults to deepseek-flash; FLOW_MODEL_BASE_URL defaults to https://api.deepseek.com. Artifacts never include the key or authenticated launch URL.');
    return null;
  }
  const value = (key: string) => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  const timeoutMs = Number(value('--timeout-ms') ?? 900000);
  const debugPort = value('--debug-port') === undefined ? undefined : Number(value('--debug-port'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be an integer >= 1000');
  if (debugPort !== undefined && (!Number.isSafeInteger(debugPort) || debugPort < 1024 || debugPort > 65535)) throw new Error('--debug-port must be an integer between 1024 and 65535');
  return {runId: value('--run-id') ?? `deepseek-budget-${new Date().toISOString().replace(/[:.]/g, '-')}`, timeoutMs,
    prepareOnly: argv.includes('--prepare-only'), keepHost: argv.includes('--keep-host'), ...(debugPort === undefined ? {} : {debugPort})};
}

/** Filter complete log lines; do not collect browser or provider request headers. */
export function redactDeepSeekLog(text: string, key: string | undefined): string {
  const clean = key ? text.replaceAll(key, '[REDACTED]') : text;
  return clean.replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try { const url = new URL(raw); if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}`; }
    catch { /* incomplete non-URL text */ }
    return raw;
  }).replace(/(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\r\n,}]+/gi, '$1[REDACTED]');
}

async function rpc(page: Page, method: string, args: Record<string, unknown>): Promise<unknown> {
  const reply = await page.evaluate(async ({method, args}) => {
    const response = await fetch(`/api/${method}`, {method:'POST', credentials:'include', headers:{'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});
    return {status:response.status, body:await response.json()};
  }, {method, args});
  const result = record(record(reply.body)?.result);
  if (reply.status !== 200 || result?.ok !== true) throw new Error(`Public ${method} refused (${reply.status})`);
  return result.value;
}
async function draft(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-composer-input=true]');
  await editor.click(); await editor.press('ControlOrMeta+A'); await editor.press('Backspace');
  await editor.pressSequentially(text, {delay:1}); await editor.press('Escape');
  await page.waitForFunction(expected => document.querySelector<HTMLElement>('[data-composer-input=true]')?.innerText === expected, text);
}
function nativeEvents(layout: RunLayout, sessionId: string): SessionEvent[] {
  const file = findSessionFile(join(layout.home, 'sessions'), sessionId);
  if (!file) return [];
  const result = readSessionEvents(file);
  return result.state === 'READ' ? result.events : [];
}
function toolCalls(events: readonly SessionEvent[], name: string): SessionEvent[] {
  return events.filter(event => event.type === 'tool/call' && record(event.data)?.name === name);
}
function toolNumber(events: readonly SessionEvent[], call: SessionEvent): number | null {
  const callId = record(call.data)?.callId;
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const message = record(record(event.data)?.message);
    if (!message || message.toolCallId !== callId || message.isError === true || !Array.isArray(message.content)) continue;
    const text = message.content.flatMap(block => { const value=record(block); return value?.type === 'text' ? [String(value.text)] : []; }).join('\n');
    if (text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  }
  return null;
}
export function acceptedValidationPassed(rows: readonly SqlRow[]): boolean {
  return rows.length > 0 && rows.every(row => {
    let validation: Record<string, unknown> | null;
    try { validation=record(JSON.parse(String(row.validation))); } catch { return false; }
    return validation?.accepted === true && Array.isArray(validation.checks) && validation.checks.length > 0
      && validation.checks.every(check => record(check)?.passed === true);
  });
}
export function deliveryMisstatesAuditorRead(text: string): boolean {
  return text.split(/[\n。]/).some(sentence => /Auditor|审计者|审核者|审计智能体|审核智能体/i.test(sentence)
    && /fs_read|直接读(?:取|回)?文件/i.test(sentence)
    && !/没有|未直接|未调用|未使用|不直接|不能|并非|而非|不是|不得|不应|did not|does not|never|not directly/i.test(sentence));
}
/** An idempotent later finalize cannot invalidate an already delivered result. */
export function finalizedDelivery(events: readonly SessionEvent[], runId: string): {text:string;seq:number|null;finalize_result_seq:number|null;finalized_at:number|null} {
  let finalized: {seq:number;at:number}|undefined;
  for(const call of toolCalls(events,'agent_team_finalize')) {
    for(const event of events) {
      const message=record(record(event.data)?.message);
      if(event.type!=='tool/result'||!message||message.toolCallId!==record(call.data)?.callId||message.isError===true||!Array.isArray(message.content)) continue;
      try {
        const text=message.content.flatMap(block=>{const value=record(block);return value?.type==='text'?[String(value.text)]:[];}).join('\n');
        const run=record(record(JSON.parse(text))?.run);
        if(run?.id===runId&&run.state==='completed'&&typeof run.finalized_at==='number'&&run.finalized_at>0) {finalized={seq:event.seq,at:run.finalized_at};break;}
      } catch { /* A failed or non-finalized tool reply is not a barrier. */ }
    }
    if(finalized) break;
  }
  const barrier=finalized;
  const replies=barrier?events.filter(event=>event.type==='assistant/message'&&event.seq>barrier.seq).flatMap(event=>{
    const message=record(record(event.data)?.message);
    const text=Array.isArray(message?.content)?message.content.flatMap(block=>{const value=record(block);return value?.type==='text'?[String(value.text)]:[];}).join('\n'):'';
    const normalized=text.replace(/[,，\s]/g,'');
    return normalized.includes('budget-report.md')&&normalized.includes('2600')&&normalized.includes('400')?[{text,seq:event.seq}]:[];
  }):[];
  const latest=replies.at(-1);
  return {text:latest?.text??'',seq:latest?.seq??null,finalize_result_seq:finalized?.seq??null,finalized_at:finalized?.at??null};
}
function settledWriteInspected(events: readonly SessionEvent[], reportFile: string, fileText: string): boolean {
  const queries=toolCalls(events,'flow_query').filter(call=>{
    try { return record(JSON.parse(String(record(call.data)?.arguments)))?.what==='effect'; } catch { return false; }
  });
  return queries.some(call=>events.some(event=>{
    const message=record(record(event.data)?.message);
    if(event.type!=='tool/result'||!message||message.toolCallId!==record(call.data)?.callId||message.isError===true||!Array.isArray(message.content)) return false;
    try {
      const text=message.content.flatMap(block=>{const value=record(block);return value?.type==='text'?[String(value.text)]:[];}).join('\n');
      const effect=record(record(JSON.parse(text))?.effect);
      const args=record(JSON.parse(String(effect?.args)));
      const outcome=record(JSON.parse(String(effect?.body)));
      return effect?.status==='SETTLED'&&effect.tool==='write'&&outcome?.isError===false
        && typeof args?.file_path==='string'&&resolve(dirname(reportFile),args.file_path)===reportFile
        && typeof args.content==='string'&&args.content.replace(/[,，]/g,'')===fileText;
    } catch { return false; }
  }));
}
function teamBinding(dbPath: string): SqlRow | undefined {
  if (!existsSync(dbPath)) return undefined;
  const ledger = openLedger(dbPath);
  try { return ledger.get('SELECT t.*,c.status FROM team_runs t JOIN clusters c ON c.id=t.run_id ORDER BY c.created DESC LIMIT 1'); }
  finally { ledger.close(); }
}
async function memberScreenshot(page: Page, role: string, path: string): Promise<boolean> {
  await page.getByRole('tab',{name:'智能体',exact:true}).click();
  const node=page.locator(`.flow-node[data-role=${role}]`).first();
  if (!await node.isVisible().catch(()=>false)) return false;
  await node.click();
  const reader=page.getByLabel('只读对话',{exact:true}); await reader.waitFor();
  await page.waitForTimeout(1800);
  const turns=reader.getByRole('button',{name:/用时 /});
  for (let i=0; i<Math.min(await turns.count(),8); i++) await turns.nth(i).click().catch(()=>{});
  const tools=reader.getByText('已调用工具',{exact:true});
  for (let i=0; i<Math.min(await tools.count(),8); i++) await tools.nth(i).click().catch(()=>{});
  const sums=reader.getByText(/^flow_sum$/);
  for (let i=0; i<Math.min(await sums.count(),4); i++) await sums.nth(i).click().catch(()=>{});
  await page.screenshot({path,fullPage:true});
  return true;
}

/** Inspect durable records only; shared by live capture and post-run review. */
export function collectDeepSeekEvidence(layout: RunLayout, teamId: string, mainSessionId: string) {
  const dbPath=join(layout.data,'cluster.sqlite');
  const ledger=openLedger(dbPath);
  try {
    const agents=ledger.all('SELECT id,role,session_id FROM agents WHERE cluster_id=?',teamId);
    const facts=agents.map(agent=>({agent,events:nativeEvents(layout,String(agent.session_id))}));
    const main=nativeEvents(layout,mainSessionId);
    const accepted=ledger.all("SELECT id,status,result,validation FROM transactions WHERE cluster_id=? AND status='ACCEPTED'",teamId);
    const audits=ledger.all("SELECT * FROM audits WHERE cluster_id=? AND kind='validation' AND decision='APPROVED' AND auditor_agent_id IN (SELECT id FROM agents WHERE cluster_id=? AND role='auditor')",teamId,teamId);
    const usage=usageSummary(ledger,teamId);
    const reportFile=join(layout.workspace,'budget-report.md');
    const fileText=existsSync(reportFile)?readFileSync(reportFile,'utf8').replace(/[,，]/g,''):'';
    const worker=facts.filter(fact=>fact.agent.role==='worker'); const auditor=facts.filter(fact=>fact.agent.role==='auditor');
    const sumFact=(group:typeof facts,total:number)=>group.some(fact=>toolCalls(fact.events,'flow_sum').some(call=>toolNumber(fact.events,call)===total));
    const actualModels=[main,...facts.map(fact=>fact.events)].flatMap(events=>events.flatMap(event=>{
      if(event.type==='request/header') {const config=record(record(record(event.data)?.header)?.config);return config?[{provider:config.provider,model:config.model}]:[];}
      if(event.type==='assistant/message') {const source=record(record(record(event.data)?.message)?.source);return source?.kind==='model'?[{provider:source.provider,model:source.model}]:[];}
      return [];
    }));
    const delivery=finalizedDelivery(main,teamId);
    const checks:Check[]=[
      {name:'native-skill-and-create',passed:JSON.stringify(main).includes('skill-invocation')&&JSON.stringify(main).includes('agent-team')&&toolCalls(main,'agent_team_create').length===1,evidence:{create_calls:toolCalls(main,'agent_team_create').length}},
      {name:'real-worker-arithmetic',passed:sumFact(worker,2600)&&sumFact(worker,400),evidence:{worker_count:worker.length}},
      {name:'independent-auditor-arithmetic',passed:sumFact(auditor,2600)&&sumFact(auditor,400),evidence:{auditor_count:auditor.length}},
      {name:'independent-auditor-settled-write-evidence',passed:auditor.some(fact=>settledWriteInspected(fact.events,reportFile,fileText)),evidence:{path:'workspace/budget-report.md',evidence_method:'flow_query effect: SETTLED write arguments and success result'}},
      {name:'file-delivered',passed:/1500/.test(fileText)&&/680/.test(fileText)&&/420/.test(fileText)&&/2600/.test(fileText)&&/400/.test(fileText)&&/不超|未超|没有超|未超过|未超出/.test(fileText),evidence:{path:'workspace/budget-report.md',bytes:Buffer.byteLength(fileText)}},
      {name:'accepted-and-independent-result-audit',passed:acceptedValidationPassed(accepted)&&audits.length>0,evidence:{accepted,audits}},
      {name:'main-delivery-and-finalize',passed:delivery.finalized_at!==null,evidence:{finalize_calls:toolCalls(main,'agent_team_finalize').length,finalize_result_seq:delivery.finalize_result_seq,finalized_at:delivery.finalized_at}},
      {name:'main-delivery-matches-auditor-evidence',passed:delivery.text.length>0&&!deliveryMisstatesAuditorRead(delivery.text),evidence:delivery},
      {name:'actual-model-route',passed:actualModels.length>0&&actualModels.every(route=>route.provider==='deepseek'&&route.model==='deepseek-flash'),evidence:{observations:actualModels.length,models:[...new Set(actualModels.map(route=>`${String(route.provider)}/${String(route.model)}`))]}},
      {name:'real-host-usage',passed:usage.requests>0&&usage.total_tokens!==null,evidence:usage},
    ];
    return {checks,main,facts};
  } finally {ledger.close();}
}

/** Rebuild derived evidence without touching business state or making requests. */
export function reviewDeepSeekRun(runRoot: string): {status:string;checks_passed:number;checks_total:number;report:string} {
  const root=resolve(runRoot);
  const layout:RunLayout={root,home:join(root,'home'),tmp:join(root,'tmp'),data:join(root,'data'),workspace:join(root,'workspace'),artifacts:join(root,'artifacts'),logs:join(root,'logs')};
  const reportPath=join(root,'report.json');
  const report=record(JSON.parse(readFileSync(reportPath,'utf8')));
  if(!report||typeof report.team_id!=='string'||typeof report.main_session_id!=='string') throw new Error('Existing run has no confirmed team and main session');
  const originalPath=join(root,'report-before-collection-review.json');
  if(!existsSync(originalPath)) copyFileSync(reportPath,originalPath);
  const originalBytes=readFileSync(originalPath);
  const original=record(JSON.parse(originalBytes.toString('utf8')));
  const ledger=openLedger(join(layout.data,'cluster.sqlite'));
  let sessionIds:string[];
  try {sessionIds=[report.main_session_id,...ledger.all('SELECT session_id FROM agents WHERE cluster_id=?',report.team_id).map(agent=>String(agent.session_id))];}
  finally {ledger.close();}
  const protectedFiles=[join(layout.data,'cluster.sqlite'),join(layout.data,'cluster.sqlite-wal'),join(layout.workspace,'budget-report.md'),...sessionIds.flatMap(id=>{const file=findSessionFile(join(layout.home,'sessions'),id);return file?[file]:[];})].filter(file=>existsSync(file));
  const hashes=()=>Object.fromEntries(protectedFiles.map(file=>[file.slice(root.length+1),createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const before=hashes();
  const evidence=collectDeepSeekEvidence(layout,report.team_id,report.main_session_id);
  const after=hashes();
  const unchanged=JSON.stringify(before)===JSON.stringify(after);
  const delivery=finalizedDelivery(evidence.main,report.team_id);
  const status=evidence.checks.every(check=>check.passed)&&unchanged?'PASSED':'FAILED';
  const review={reviewed_at:new Date().toISOString(),status,original_report_file:'report-before-collection-review.json',
    original_report_status:original?.status,original_report_sha256:createHash('sha256').update(originalBytes).digest('hex'),
    method:'Read-only inspection of persisted SQLite and native Session events; no model or public API requests.',
    correction:'Collect the latest real delivery after the first successful completed/finalized tool result. A later idempotent finalize does not erase an earlier valid delivery.',
    finalize_result_seq:delivery.finalize_result_seq,finalized_at:delivery.finalized_at,delivery_seq:delivery.seq,
    business_state_unchanged:unchanged,protected_files_sha256_before:before,protected_files_sha256_after:after};
  const sanitize=(text:string)=>redactDeepSeekLog(text,undefined);
  writeFileSync(join(layout.artifacts,'native-main-events.json'),sanitize(JSON.stringify(evidence.main,null,2))+'\n');
  writeFileSync(join(layout.artifacts,'native-team-events.json'),sanitize(JSON.stringify(evidence.facts,null,2))+'\n');
  writeFileSync(reportPath,sanitize(JSON.stringify({...report,status,checks:evidence.checks,independent_review:review},null,2))+'\n');
  return {status,checks_passed:evidence.checks.filter(check=>check.passed).length,checks_total:evidence.checks.length,report:reportPath};
}

export async function runDeepSeekCase(argv = process.argv.slice(2)): Promise<void> {
  const verifyIndex=argv.indexOf('--verify-only');
  if(verifyIndex>=0) {
    const root=argv[verifyIndex+1]; if(!root||root.startsWith('--')) throw new Error('--verify-only requires an existing run directory');
    const result=reviewDeepSeekRun(root); console.log(JSON.stringify(result)); if(result.status!=='PASSED') process.exitCode=1; return;
  }
  const args=options(argv); if (!args) return;
  const key=process.env.FLOW_MODEL_API_KEY;
  if (!args.prepareOnly && !key) throw new Error('Export FLOW_MODEL_API_KEY before a real run; no key is accepted on the command line.');
  const layout=createRunLayout(join(PROJECT_ROOT,'.artifacts'),args.runId); chmodSync(layout.root,0o700);
  const model=process.env.FLOW_MODEL_ID ?? 'deepseek-flash';
  const baseURL=process.env.FLOW_MODEL_BASE_URL ?? 'https://api.deepseek.com';
  const profile=`dsh-flow-${args.runId}`;
  ensureProfile(layout.home,profile,{bundles:[...WEB_PROFILE_BUNDLES,'dsh-flow']});
  const bridge=join(layout.root,'ipc-bridge.patch.yml');
  writeFileSync(bridge,`- insert:\n    - id: dsh-flow-ipc-bridge\n      name: ${JSON.stringify(join(PROJECT_ROOT,'src/host/ipc-bridge.ts'))}\n`);
  const screenshots=join(layout.artifacts,'steps'); mkdirSync(screenshots,{recursive:true});
  const report:Report={status:'PREPARED',run_id:args.runId,started_at:new Date().toISOString(),
    route:{provider:'deepseek',model,base_url:baseURL,reasoning:'off'},workspace:layout.workspace,checks:[],screenshots:[]};
  const sanitize=(text:string)=>redactDeepSeekLog(text,key);
  const save=()=>writeFileSync(join(layout.root,'report.json'),sanitize(JSON.stringify(report,null,2))+'\n');
  save();
  if (args.prepareOnly) { console.log(JSON.stringify({status:report.status,run_id:args.runId,workspace:layout.workspace,report:join(layout.root,'report.json')})); return; }
  const host=new DshHost({profile,patches:[join(PROJECT_ROOT,'examples/instance.patch.yml'),join(PROJECT_ROOT,'examples/deepseek.patch.yml'),bridge],
    cwd:layout.workspace,env:buildHostEnv({home:layout.home,tmpdir:layout.tmp,dataDir:layout.data,workspace:layout.workspace,
      modelRoute:{provider:'deepseek',model,baseURL},modelApiKey:key}),logPath:join(layout.logs,'host.log'),sanitizeLog:sanitize});
  let browser:Browser|undefined;
  let page:Page|undefined;
  const shot=async(name:string)=>{if(!page) return;const file=`${name}.png`;await page.screenshot({path:join(screenshots,file),fullPage:true});report.screenshots.push(`artifacts/steps/${file}`);save();};
  try {
    report.status='RUNNING'; save(); await host.start(); if(host.child?.pid) report.host_pid=host.child.pid; save();
    const playwright=await importPlaywright(); if(!playwright) throw new Error('Playwright is unavailable');
    const executablePath=browserExecutablePath();
    browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox',...(args.debugPort?[`--remote-debugging-address=127.0.0.1`,`--remote-debugging-port=${args.debugPort}`]:[])]});
    const context=await browser.newContext({viewport:{width:1600,height:1100},locale:'zh-CN',reducedMotion:'reduce'});
    await context.addInitScript('window.__name=(value)=>value'); page=await context.newPage();
    page.on('request',request=>{
      if(new URL(request.url()).pathname!=='/api/commands/execute') return;
      const body=record(request.postDataJSON()); const payload=record(body?.payload); const command=record(payload?.args);
      if(typeof command?.agentId==='string') report.main_session_id=command.agentId;
      writeFileSync(join(layout.artifacts,'native-command.json'),sanitize(JSON.stringify(body,null,2)));save();
    });
    await page.goto(await host.waitForWebUrl(),{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2500);
    const notice=page.getByRole('button',{name:/^continue$|我已了解|继续/i}).first();
    if(await notice.isVisible().catch(()=>false)) await notice.click();
    if(await page.getByRole('button',{name:'选择工作区',exact:true}).isVisible().catch(()=>false)) {
      await rpc(page,'workspace/create',{request:{path:layout.workspace}});
      await page.getByRole('button',{name:'选择工作区',exact:true}).click();
      await page.getByRole('menuitem',{name:/workspace/}).first().click();
    }
    await page.getByRole('button',{name:'发送消息',exact:true}).waitFor(); await shot('01-workspace-model');
    await draft(page,BUDGET_REQUEST); await shot('02-request');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    const deadline=Date.now()+args.timeoutMs; const dbPath=join(layout.data,'cluster.sqlite');
    let capturedTeam=false; let capturedTopology=false; let terminal=false;
    while(Date.now()<deadline) {
      if(host.exitInfo) throw new Error(`Host exited before delivery (code=${host.exitInfo.code})`);
      const binding=teamBinding(dbPath);
      if(binding) {
        report.team_id=String(binding.run_id); report.main_session_id=String(binding.main_session_id);
        if(!capturedTeam) {await shot('03-created'); capturedTeam=true; console.log(JSON.stringify({phase:'team-created',team_id:report.team_id,host_pid:report.host_pid,debug_port:args.debugPort??null}));}
        const ledger=openLedger(dbPath);
        try {
          const workers=Number(ledger.get("SELECT COUNT(*) AS n FROM agents WHERE cluster_id=? AND role='worker'",report.team_id)?.n??0);
          if(workers>0&&!capturedTopology) {
            await page.getByRole('tab',{name:'智能体',exact:true}).click();await page.locator('.flow-content').waitFor();await page.waitForTimeout(750);
            await shot('04-topology');await page.getByRole('tab',{name:'对话',exact:true}).click();capturedTopology=true;
          }
        } finally {ledger.close();}
        const snapshot=record(await rpc(page,'flow/teamRead',{sessionId:report.main_session_id,runId:report.team_id}));
        const run=record(snapshot?.run); const state=String(run?.state??'');
        if(['failed','cancelled','blocked','waiting_user','paused'].includes(state)) throw new Error(`Team ${state}: ${String(run?.reason??'Inspect retained real evidence')}`);
        if(state==='completed'&&run?.finalized_at) {
          const main=nativeEvents(layout,report.main_session_id);
          if(finalizedDelivery(main,report.team_id).text) {terminal=true;break;}
        }
      }
      save(); await delay(2000);
    }
    if(!terminal||!report.team_id||!report.main_session_id) throw new Error('Timed out waiting for completed, finalized team and main-session delivery');
    await page.getByRole('tab',{name:'对话',exact:true}).click();await page.waitForTimeout(1000); await shot('07-delivery');
    for(const [role,name] of [['worker','05-calculation'],['auditor','06-audit']] as const) {
      if(await memberScreenshot(page,role,join(screenshots,`${name}.png`))) report.screenshots.push(`artifacts/steps/${name}.png`);
    }
    await page.getByRole('tab',{name:'智能体',exact:true}).click();await page.keyboard.press('Escape');await shot('08-history');
    const evidence=collectDeepSeekEvidence(layout,report.team_id,report.main_session_id);
    writeFileSync(join(layout.artifacts,'native-main-events.json'),sanitize(JSON.stringify(evidence.main,null,2)));
    writeFileSync(join(layout.artifacts,'native-team-events.json'),sanitize(JSON.stringify(evidence.facts,null,2)));
    report.checks=evidence.checks;
    writeFileSync(join(layout.artifacts,'host-mechanism-report.json'),sanitize(JSON.stringify(await host.request('report',report.team_id),null,2)));
    report.status=report.checks.every(check=>check.passed)?'PASSED':'FAILED';report.ended_at=new Date().toISOString();save();
    console.log(JSON.stringify({status:report.status,run_id:args.runId,team_id:report.team_id,workspace:layout.workspace,report:join(layout.root,'report.json'),screenshots:report.screenshots}));
    if(report.status==='FAILED') process.exitCode=1;
  } catch(error) {
    report.status='FAILED';report.error=sanitize(error instanceof Error?error.message:String(error));report.ended_at=new Date().toISOString();
    await shot('failure').catch(()=>{});save();process.exitCode=1;console.error(JSON.stringify({status:report.status,error:report.error,report:join(layout.root,'report.json')}));
  } finally {
    if(args.keepHost&&host.child&&!host.exitInfo) {
      console.log(JSON.stringify({phase:'kept-host',host_pid:host.child.pid,debug_port:args.debugPort??null,report:join(layout.root,'report.json')}));
      await new Promise<void>(resolvePromise=>{process.once('SIGINT',resolvePromise);process.once('SIGTERM',resolvePromise);});
    }
    await browser?.close(); await host.stop();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runDeepSeekCase().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
