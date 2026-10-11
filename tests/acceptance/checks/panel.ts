/** Native main dialogue, agent sessions, read-only inspection and display preferences. */
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {browserExecutablePath,importPlaywright} from '../../../src/host/browser.ts';
import {ClusterStore} from '../../../packages/dsh-flow/src/core/store.ts';
import {findSessionFile,readSessionEvents} from '../../../src/host/session-scan.ts';
import type {CheckEntry} from '../context.ts';
import type {RunLayout,DshHostOp} from '../../../src/host/types.ts';
interface Report {cluster_id?:string|null;web_url?:string|null;live_checks?:{checks?:CheckEntry[]}|null}
interface Host {waitForWebUrl(timeout?:number):Promise<string>;request(op:DshHostOp,id:string|undefined,payload?:unknown):Promise<unknown>}
interface Live {report:Report;layout:RunLayout;host:Host;mock?:{release(barrier:string):number}|null}
const sleep=(page:Page,ms=1700)=>page.waitForTimeout(ms);
async function submit(page:Page,line:string) {
  const editor=page.locator('[data-composer-input=true]');
  // Use the platform's real select-all shortcut; Meta+A leaves the previous
  // draft in place on Linux and corrupts the next command's launch intent.
  await editor.click();await editor.press('ControlOrMeta+A');await editor.press('Backspace');
  await page.waitForFunction(()=>document.querySelector<HTMLElement>('[data-composer-input=true]')?.innerText.trim()==='',undefined,{timeout:3000});
  await editor.pressSequentially(line);await editor.press('Escape');
  await page.waitForFunction(expected=>document.querySelector<HTMLElement>('[data-composer-input=true]')?.innerText===expected,line,{timeout:3000});
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
}
/** The native appearance control persists immediately; wait for its Host ACK. */
async function setNativeTheme(page:Page,scheme:'light'|'dark') {
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const choice=page.getByRole('button',{name:scheme==='dark'?'深色':'浅色',exact:true});
  if(await choice.getAttribute('aria-pressed')!=='true') {
    const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings/mutate'&&response.request().postData()?.includes('ui-theme')===true&&response.request().postData()?.includes(`\"${scheme}\"`)===true);
    await choice.click();
    const response=await accepted;const body=await response.json();
    if(!response.ok()||body.result?.ok!==true)throw new Error(`Native ${scheme} theme preference was refused: ${JSON.stringify(body)}`);
  }
  await page.waitForFunction(expected=>document.documentElement.style.colorScheme===expected,scheme);
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.waitForFunction(expected=>document.documentElement.style.colorScheme===expected,scheme);
}
function binding(layout:RunLayout) {const store=new ClusterStore(join(layout.data,'cluster.sqlite'));try{return store.all('SELECT * FROM team_runs ORDER BY rowid');}finally{store.close();}}
function sessionId(value:unknown):string {if(value&&typeof value==='object'&&typeof Reflect.get(value,'session_id')==='string')return Reflect.get(value,'session_id');throw new Error('Native fixture did not return a session');}
function inputFacts(layout:RunLayout,agent:{id:string;role:string;session_id:string}) {
  const file=findSessionFile(join(layout.home,'sessions'),agent.session_id);
  const log=file?readSessionEvents(file):null;
  const inputs=(log?.events??[]).filter(event=>event.type==='user/message').map(event=>{
    const data=event.data&&typeof event.data==='object'?event.data:null;
    const content=data?Reflect.get(data,'content'):null;
    return {seq:event.seq,id:data?Reflect.get(data,'id'):null,source:data?Reflect.get(data,'source'):null,text:Array.isArray(content)?content.map(block=>block&&typeof block==='object'?Reflect.get(block,'text')??'':'').join('\n'):''};
  });
  return {agent_id:agent.id,role:agent.role,session_id:agent.session_id,read:log?.state,inputs};
}
const compactText=(text:string)=>text.replace(/\s+/gu,' ').trim();
function addReader(layout:RunLayout,runId:string,id:string,nativeSession:string,title:string,parent?:string) {
  const store=new ClusterStore(join(layout.data,'cluster.sqlite'));try{const lead=store.listAgents(runId,{role:'orchestrator'})[0]!;store.insertAgent({id,cluster_id:runId,node_id:lead.node_id,role:'worker',session_id:nativeSession,status:'TERMINATED',meta:{parent_agent_id:parent??lead.id,display_name:title,responsibility:'原生持久化阅读验收记录；不代表模型执行'}});store.recordTeamEnd(store.getAgent(id)!,'COMPLETED');store.appendEvent(runId,'ux-read-fixture',{id});}finally{store.close();}
}
async function readingAnchor(reader:import('playwright').Locator) {return reader.evaluate(element=>{const row=Array.from(element.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden]):not([hidden] *)')).find(row=>row.offsetTop+row.offsetHeight>element.scrollTop);return {id:row?.dataset.chatAnchorKey,offset:row?row.offsetTop-element.scrollTop:0,top:element.scrollTop};});}
/** A declared ledger fixture exercises read projection, not simulated model execution. */
function seedNodes(layout:RunLayout,runId:string,count:number) {
  const store=new ClusterStore(join(layout.data,'cluster.sqlite'));
  try {store.tx(()=>{
    const lead=store.listAgents(runId,{role:'orchestrator'})[0]!;
    const existing=Number(store.get("SELECT COUNT(*) AS count FROM agents WHERE cluster_id=? AND id NOT LIKE 'ux-fixture-%'",runId)?.count??0);
    for(let index=0;index<count-existing;index++) {
      const id=`ux-fixture-${index.toString().padStart(4,'0')}`;
      if(store.getAgent(id))continue;
      const parent=index===0||index>=10?lead.id:`ux-fixture-${(index-1).toString().padStart(4,'0')}`;
      store.insertAgent({id,cluster_id:runId,node_id:lead.node_id,role:'worker',session_id:`ux-missing-session-${index}`,status:'TERMINATED',meta:{parent_agent_id:parent,title:'历史代理名称'.repeat(16),responsibility:'只读压力数据；不代表模型执行吞吐'}});
      store.recordTeamEnd(store.getAgent(id)!,'COMPLETED');
    }
    store.appendEvent(runId,'ux-view-fixture',{count,description:'Persisted observation fixture, not execution throughput evidence'});
  });} finally {store.close();}
}
export async function live({report,layout,host,mock}:Live) {
  const checks:CheckEntry[]=[];
  const push=(name:string,passed:boolean,evidence:unknown)=>checks.push({name,passed,evidence:typeof evidence==='string'?evidence:JSON.stringify(evidence)});
  const artifacts=join(layout.artifacts,'team-ui');mkdirSync(artifacts,{recursive:true});
  const url=report.web_url??await host.waitForWebUrl(60000);
  const unauth=await fetch(new URL('/api/flow/teamRuns',url),{method:'POST',headers:{'content-type':'application/json'},body:'{"args":{"sessionId":"unowned"}}'});
  push('authenticated-observer-route',unauth.status===401||unauth.status===403,`unauthenticated response ${unauth.status}`);
  const playwright=await importPlaywright();if(!playwright)return {checks:[...checks,{name:'native-browser',passed:false,evidence:'Playwright unavailable'}]};
  const executablePath=browserExecutablePath();
  const browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox']});
  let page:Page|undefined;
  try {
    const context=await browser.newContext({viewport:{width:1600,height:1100},reducedMotion:'reduce',locale:'zh-CN'});
    await context.addInitScript('window.__name=(value)=>value');
    page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>{errors.push(error.message);writeFileSync(join(artifacts,'client-errors.json'),JSON.stringify(errors,null,2));});
    const consoleErrors:string[]=[];page.on('console',message=>{consoleErrors.push(`${message.type()}: ${message.text()}`);writeFileSync(join(artifacts,'client-console.json'),JSON.stringify(consoleErrors,null,2));});
    const replies:unknown[]=[];page.on('response',async response=>{const path=new URL(response.url()).pathname;if(path.startsWith('/api/flow/')||path.startsWith('/api/commands/')){replies.push({path,status:response.status(),body:await response.json().catch(()=>null)});writeFileSync(join(artifacts,'observer-responses.json'),JSON.stringify(replies,null,2));}});
    const commandRequests:unknown[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/commands/execute'){commandRequests.push(request.postDataJSON());writeFileSync(join(artifacts,'native-command-requests.json'),JSON.stringify(commandRequests,null,2));}});
    const modules:unknown[]=[];page.on('response',async response=>{if(response.request().resourceType()==='script'){const body=await response.text().catch(()=>'');modules.push({path:new URL(response.url()).pathname,bytes:body.length,flow:body.includes('dsh-flow-team-ui'),presentation:body.includes('registerViewPresentation')});writeFileSync(join(artifacts,'client-modules.json'),JSON.stringify(modules,null,2));}});
    await page.goto(url,{waitUntil:'domcontentloaded'});await sleep(page,4000);
    const notice=page.getByRole('button',{name:/^continue$|我已了解|继续/i}).first();if(await notice.isVisible().catch(()=>false))await notice.click();
    // This hermetic profile has no remembered workspace. Register the real case
    // directory over the host's public API, then choose it in its native picker.
    if(await page.getByRole('button',{name:'选择工作区',exact:true}).isVisible().catch(()=>false)) {
      const registered=await page.evaluate(async path=>{
        const response=await fetch('/api/workspace/create',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'workspace/create',payload:{args:{request:{path}}}})});
        return {status:response.status,body:await response.json()};
      },layout.workspace);
      push('native-workspace-registration',registered.status===200,registered);
      await page.getByRole('button',{name:'选择工作区',exact:true}).click();
      await page.getByRole('menuitem',{name:/workspace/}).first().click();
    }
    await page.getByRole('button',{name:'发送消息',exact:true}).waitFor();
    await page.route('**/api/commands/list',async route=>{const response=await route.fetch();const body=await response.json();if(body.result?.ok&&Array.isArray(body.result.value))body.result.value=body.result.value.filter((item:{name:string})=>item.name!=='agent-team');await route.fulfill({response,json:body});});
    await page.reload({waitUntil:'domcontentloaded'});await sleep(page,3500);
    let ordinaryRequests=0;const countOrdinary=(request:import('playwright').Request)=>{if(request.url().includes('/api/session/prompt'))ordinaryRequests++;};page.on('request',countOrdinary);
    await submit(page,'/agent-team 暂未启用验收');await sleep(page);
    push('unavailable-command-refused',await page.getByRole('button',{name:'打开插件管理',exact:true}).isVisible()&&await page.locator('[data-composer-input=true]').innerText()==='/agent-team 暂未启用验收'&&ordinaryRequests===0&&binding(layout).length===0,'Native command provider refuses an absent command capability before ordinary submission, retaining the draft and plugin management action');
    await page.getByRole('button',{name:'打开插件管理',exact:true}).click();await page.getByText('dsh-flow',{exact:true}).first().waitFor();
    push('plugin-management-navigation',await page.getByText('dsh-flow',{exact:true}).first().isVisible(),'Public layout action opens the native plugin manager');
    await page.unroute('**/api/commands/list');page.off('request',countOrdinary);
    // Reload starts a fresh authoritative directory after the unavailable-catalog fixture.
    await page.reload({waitUntil:'domcontentloaded'});await sleep(page,3500);
    await page.getByRole('button',{name:'发送消息',exact:true}).waitFor();
    let staleExecutions=0;
    await page.route('**/api/commands/execute',async route=>{staleExecutions++;const request=route.request().postDataJSON();await route.fulfill({json:{type:'server-response',rpcId:request.rpcId,result:{ok:true}}});});
    await submit(page,'/agent-team 停用时目录尚未刷新');await sleep(page,300);
    push('stale-catalog-refused',staleExecutions===1&&await page.getByRole('dialog',{name:'dsh-flow 尚未启用',exact:true}).isVisible()&&await page.locator('[data-composer-input=true]').innerText()==='/agent-team 停用时目录尚未刷新'&&binding(layout).length===0,{nativeExecutions:staleExecutions,meaning:'An absent execution admission after a cached catalog still refuses and offers plugin management'});
    await page.getByRole('button',{name:'关闭启用提示',exact:true}).click();await page.unroute('**/api/commands/execute');
    await submit(page,'/agent-team');await sleep(page);
    push('empty-command-preserves-input',await page.locator('[data-composer-input=true]').innerText()==='/agent-team'&&binding(layout).length===0,await page.locator('body').innerText());
    // Drop the acknowledgment after real server execution, then retry the retained intent.
    let dropped=false;
    await page.route('**/api/commands/execute',async route=>{if(dropped){await route.continue();return;}dropped=true;await route.fetch();await route.abort('failed');});
    const objective='UX native：验证只读观察和自然语言答复';
    await submit(page,`/agent-team ${objective}`);await sleep(page);
    const pending=await page.locator('[data-composer-input=true]').innerText();const first=binding(layout);
    await page.unroute('**/api/commands/execute');await submit(page,`/agent-team ${objective}`);await sleep(page);
    const entries=binding(layout);const runId=String(entries[0]?.run_id??'');
    push('lost-ack-retry-deduplicates',dropped&&pending===`/agent-team ${objective}`&&first.length===1&&entries.length===1&&first[0]?.run_id===entries[0]?.run_id,{before:first,after:entries,inputPreserved:pending===`/agent-team ${objective}`});
    await page.locator('[data-chat-turn]').first().waitFor({timeout:30000});
    const mainText=await page.locator('[data-conversation-scroll]').innerText();
    push('default-coordinator-context',await page.getByRole('tab',{name:'对话',exact:true}).count()===1&&mainText.includes(objective)&&!mainText.includes('暂时无法读取对话')&&await page.locator('[data-composer-input=true]').isVisible(),mainText);
    // The official Chat and composer share the host's single width axis.
    const widthGeometry=async()=>({
      body:await page!.locator('[data-chat-turn]').first().boundingBox(),
      editor:await page!.locator('[data-composer-input=true]').boundingBox(),
      left:await page!.locator('[data-width-handle=left]').boundingBox(),
      right:await page!.locator('[data-width-handle=right]').boundingBox(),
    });
    const widthBefore=await widthGeometry();
    if(widthBefore.left&&widthBefore.right&&widthBefore.left.width>0&&widthBefore.right.width>0) {
      const dragWidth=async(box:NonNullable<typeof widthBefore.left>,dx:number)=>{
        await page!.mouse.move(box.x+box.width/2,box.y+120);await page!.mouse.down();
        await page!.mouse.move(box.x+box.width/2+dx,box.y+120,{steps:8});await page!.mouse.up();
      };
      await dragWidth(widthBefore.left,24);const narrow=await widthGeometry();
      if(narrow.right)await dragWidth(narrow.right,24);const restored=await widthGeometry();
      const sync=(a:typeof widthBefore,b:typeof widthBefore,direction:number)=>Boolean(a.body&&a.editor&&b.body&&b.editor&&
        (b.body.width-a.body.width)*direction>1&&Math.abs((b.body.width-a.body.width)-(b.editor.width-a.editor.width))<1);
      push('native-main-width-body-and-composer',sync(widthBefore,narrow,-1)&&sync(narrow,restored,1)&&
        Boolean(restored.body&&restored.left&&restored.right&&restored.left.x+restored.left.width<restored.body.x&&restored.right.x>restored.body.x+restored.body.width)&&
        await page.locator('[data-width-handle]').count()===2,{before:widthBefore,narrow,restored});
    } else push('native-main-width-body-and-composer',false,widthBefore);
    const header=page.getByRole('button',{name:/^智能体团队/});await header.waitFor({timeout:30000});
    push('unique-native-entry',await header.count()===1&&await page.getByRole('tab',{name:'智能体',exact:true}).count()===1,await page.locator('body').innerText());
    await header.focus();await header.press('Enter');await page.getByRole('tree',{name:'智能体派生树'}).waitFor();await page.keyboard.press('Escape');
    push('keyboard-return-focus',await header.evaluate(element=>element===document.activeElement),'Enter opened the native menu; Escape restored focus');
    await header.hover();await sleep(page,300);await page.getByRole('tree',{name:'智能体派生树'}).hover();await sleep(page,400);
    push('hover-popup-retained',await page.getByRole('tree',{name:'智能体派生树'}).isVisible(),'Trigger-to-popup pointer traversal');
    await page.getByRole('button',{name:'查看智能体',exact:true}).click();await page.locator('.flow-content').waitFor();
    await page.getByText('请确认使用当前工作区',{exact:false}).first().waitFor({timeout:30000});
    const waitingBefore=binding(layout);
    await page.getByRole('button',{name:'前往主会话答复',exact:true}).first().click();await sleep(page,200);
    push('answer-in-main-focus',await page.locator('[data-composer-input=true]').evaluate(element=>element===document.activeElement)&&binding(layout).length===waitingBefore.length,'Readonly navigation focuses ordinary composer, without sending or creating a run');
    await submit(page,'NATIVE-ORDINARY: 使用当前工作区');await sleep(page,2200);
    const answerStore=new ClusterStore(join(layout.data,'cluster.sqlite'));
    try{push('ordinary-reply-confirmed',Boolean(answerStore.get("SELECT id FROM messages WHERE cluster_id=? AND id LIKE 'main:%'",runId))&&Boolean(answerStore.get("SELECT seq FROM events WHERE cluster_id=? AND type='turn-start' AND seq>(SELECT MAX(seq) FROM events WHERE cluster_id=? AND type='team-waiting-user')",runId,runId)),'Ordinary main input entered the durable inbox and a later authoritative turn started');}finally{answerStore.close();}
    await page.getByRole('tab',{name:'智能体',exact:true}).click();await sleep(page,300);
    const nativeContent=page.locator('.flow-content');
    await nativeContent.locator('.flow-node[data-role=orchestrator]').click();
    const nativeReader = nativeContent.getByLabel('只读对话',{exact:true});
    const inputStore=new ClusterStore(join(layout.data,'cluster.sqlite'));
    try {
      const agentId=await nativeContent.locator('.flow-node[data-role=orchestrator]').getAttribute('data-agent-id');
      const agent=agentId?inputStore.getAgent(agentId):null;
      if(!agent)throw new Error('No native Orchestrator identity is selected');
      const facts=inputFacts(layout,agent);const first=facts.inputs[0];
      if(first?.text)await nativeReader.getByText(first.text.split('\n')[0]??'',{exact:false}).first().waitFor({timeout:30000});
      const visible=await nativeReader.innerText();
      writeFileSync(join(artifacts,'native-orchestrator-inputs.json'),JSON.stringify({...facts,visible_before_tool_expansion:visible},null,2));
      push('native-first-management-input-readable',facts.read==='READ'&&Boolean(first?.text)&&
        facts.inputs.every(input=>!/Current domain state|pending_actions|^Role:|STATUS:/mu.test(input.text))&&
        compactText(visible).includes(compactText(first?.text??'')),{first,visible_before_tool_expansion:visible});
      const owned=inputStore.all('SELECT id,kind,native_message_id FROM member_inputs WHERE agent_id=?',agent.id);
      const entered=owned.flatMap(row=>facts.inputs.filter(input=>input.id===row.native_message_id).map(input=>({row,input})));
      const notices=entered.filter(({row})=>row.kind!=='initial');
      const communications=facts.inputs.filter(input=>input.source&&typeof input.source==='object'&&Reflect.get(input.source,'kind')==='flow-message');
      push('native-notices-have-independent-sources',notices.length+communications.length>0&&entered.every(({row,input})=>{
        const source=input.source;if(!source||typeof source!=='object')return false;
        return row.kind==='initial'?Reflect.get(source,'kind')==='user':Reflect.get(source,'kind')==='flow'&&
          Reflect.get(source,'delivery_id')===row.id&&Reflect.get(source,'form')===row.kind;
      })&&communications.every(input=>{
        const source=input.source;if(!source||typeof source!=='object')return false;
        const messageId=String(Reflect.get(source,'message_id'));
        return Reflect.get(source,'recipient_id')===agent.id&&
          (Boolean(inputStore.get('SELECT message_id FROM recipients WHERE message_id=? AND recipient=?',messageId,agent.id))||
            Boolean(inputStore.get('SELECT id FROM inbox WHERE id=? AND recipient=?',messageId,agent.id)));
      }),{owned_notices:notices.map(({row,input})=>({kind:row.kind,id:row.id,native_message_id:input.id,source:input.source})),
        communications:communications.map(input=>({seq:input.seq,id:input.id,source:input.source}))});
      await nativeReader.locator('[data-conversation-scroll]').evaluate(element=>{element.scrollTop=0;});await sleep(page,100);
      await page.screenshot({path:join(artifacts,'native-first-management-input.png'),fullPage:true});
    } finally {inputStore.close();}
    await nativeReader.getByRole('button',{name:/用时 /}).first().click();
    await nativeReader.getByText('已调用工具',{exact:true}).first().click();
    await nativeReader.getByText(/^flow_transaction.*request_user$/).first().click();
    await page.screenshot({path:join(artifacts,'tool-arguments.png'),fullPage:true});
    writeFileSync(join(artifacts,'tool-arguments.txt'),await nativeReader.innerText());
    push('native-tool-arguments',await nativeContent.getByLabel('只读对话',{exact:true}).innerText().then(text=>text.includes('输入')&&text.includes('"action": "request_user"')&&text.includes('请确认使用当前工作区')),'The real flow_transaction request_user action exposes its original argsRaw in a native read-only disclosure');
    push('native-depth',await nativeContent.locator('.flow-information').innerText().then(text=>text.includes('第 1 层')),'Information displays the actual derivation level');
    const inspectedId=await nativeContent.locator('.flow-node[data-role=orchestrator]').getAttribute('data-agent-id');
    const usageStore=new ClusterStore(join(layout.data,'cluster.sqlite'));
    try {
      if(!inspectedId)throw new Error('The live native Orchestrator has no observed identity');
      if(usageStore.getAgent(inspectedId)?.cluster_id!==runId)throw new Error('The observed Orchestrator belongs to a different team than the acknowledged launch');
      let usage=usageStore.usageSummary(runId,{agentId:inspectedId});
      let information=await nativeContent.locator('.flow-information').innerText();
      for(let attempt=0;attempt<120&&usage.total_tokens!==null&&!information.includes(`宿主已记录 Token（当前代理自身）：${usage.total_tokens.toLocaleString('zh-CN')}`);attempt++) {
        await sleep(page,250);usage=usageStore.usageSummary(runId,{agentId:inspectedId});
        information=await nativeContent.locator('.flow-information').innerText();
      }
      const actual=usageStore.latestNativeContext(inspectedId);
      writeFileSync(join(artifacts,'native-usage-information.json'),JSON.stringify({agent_id:inspectedId,usage,actual,information},null,2));
      push('native-usage-in-live-ui',usage.requests>0&&usage.total_tokens!==null&&information.includes(`宿主已记录 Token（当前代理自身）：${usage.total_tokens.toLocaleString('zh-CN')}`)&&
        (usage.completeness!=='incomplete'||information.includes('可能不完整')),{usage,information});
      push('configured-and-actual-model-in-live-ui',actual.model!==null&&information.includes('当前配置模型：')&&information.includes(`最近实际模型：${actual.model}`),{actual,information});
      await nativeContent.locator('.flow-information').getByText('宿主已记录 Token（当前代理自身）：',{exact:false}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(artifacts,'native-usage.png'),fullPage:true});
    } finally {usageStore.close();}
    const workerNode=nativeContent.locator('.flow-node[data-role=worker]').first();
    if(await workerNode.count()) {
      await page.keyboard.press('Escape');
      await workerNode.click();await sleep(page,300);
      const workerStore=new ClusterStore(join(layout.data,'cluster.sqlite'));
      try {
        const id=await workerNode.getAttribute('data-agent-id');const worker=id?workerStore.getAgent(id):null;
        if(!worker)throw new Error('No native Worker identity is selected');
        const facts=inputFacts(layout,worker);const workerReader=nativeContent.getByLabel('只读对话',{exact:true});
        const first=facts.inputs[0];
        if(first?.text)await workerReader.getByText(first.text.split('\n')[0]??'',{exact:false}).first().waitFor({timeout:30000});
        const visible=await workerReader.innerText();
        writeFileSync(join(artifacts,'native-worker-inputs.json'),JSON.stringify({...facts,visible},null,2));
        push('native-worker-business-input-readable',facts.read==='READ'&&Boolean(first?.text)&&
          facts.inputs.every(input=>!/Current domain state|pending_actions|^Role:|STATUS:/mu.test(input.text))&&
          first?.source&&typeof first.source==='object'&&Reflect.get(first.source,'kind')==='user'&&
          compactText(visible).includes(compactText(first.text)),{first,visible});
        await workerReader.locator('[data-conversation-scroll]').evaluate(element=>{element.scrollTop=0;});await sleep(page,100);
        await page.screenshot({path:join(artifacts,'native-worker-business-input.png'),fullPage:true});
      } finally {workerStore.close();}
      await page.keyboard.press('Escape');
      await nativeContent.locator('.flow-node[data-role=orchestrator]').click();await sleep(page,300);
    } else push('native-worker-business-input-readable',false,'No real Worker is present in the observed team');
    await nativeContent.getByRole('button',{name:'打开完整会话',exact:true}).click();
    const activeComposer=page.locator('[data-composer-input=true]');await activeComposer.waitFor({state:'visible'});
    push('active-native-session-input',await nativeContent.count()===0&&await activeComposer.isEditable()&&await page.getByRole('tab',{name:'对话',exact:true}).isVisible()&&await page.getByRole('tab',{name:'轨迹',exact:true}).isVisible(),'The live Orchestrator opens its complete native Session with editable text input and conversation/trajectory tabs');
    await page.getByRole('button',{name:'主会话',exact:true}).click();await nativeContent.waitFor();await page.keyboard.press('Escape');
    const canvasBefore=await nativeContent.locator('.flow-graph').boundingBox();
    await nativeContent.locator('.flow-node[data-role=orchestrator]').click();
    const canvasAfter=await nativeContent.locator('.flow-graph').boundingBox();
    const contentBox=await nativeContent.boundingBox();
    push('canvas-fills-tab-with-floating-details',Boolean(canvasBefore&&canvasAfter&&contentBox&&Math.abs(canvasBefore.height-contentBox.height)<2&&Math.abs(canvasAfter.width-canvasBefore.width)<2&&Math.abs(canvasAfter.height-canvasBefore.height)<2),{canvasBefore,canvasAfter,contentBox});
    await page.keyboard.press('Escape');
    const graph=nativeContent.locator('.flow-graph');const graphBox=await graph.boundingBox();
    const scale=async()=>Number((await nativeContent.locator('.flow-graph-world').evaluate(element=>(element as HTMLElement).style.transform)).match(/scale\(([^)]+)\)/)?.[1]);
    const initialScale=await scale();const initialViewport=await page.evaluate(()=>window.visualViewport?.scale);
    if(graphBox){await page.mouse.move(graphBox.x+graphBox.width-100,graphBox.y+graphBox.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await sleep(page,100);const enlarged=await scale();await page.mouse.wheel(0,100);await page.keyboard.up('Control');await sleep(page,100);push('unfocused-canvas-pinch-both-directions',enlarged>initialScale&&Math.abs((await scale())-initialScale)<.001&&(await page.evaluate(()=>window.visualViewport?.scale))===initialViewport,{initialScale,enlarged,after:await scale(),viewport:initialViewport});}
    const nativeA=sessionId(await host.request('observation-fixture',undefined,{workspace:layout.workspace,count:120,prefix:'native-A'}));
    const nativeB=sessionId(await host.request('observation-fixture',undefined,{workspace:layout.workspace,count:4,prefix:'native-B'}));
    addReader(layout,runId,'ux-reader-A',nativeA,'原生记录 A');addReader(layout,runId,'ux-reader-B',nativeB,'原生记录 B','ux-reader-A');await sleep(page);
    await page.screenshot({path:join(artifacts,'topology.png'),fullPage:true});
    const content=page.locator('.flow-content');
    await page.getByRole('button',{name:/^原生记录 A，/}).click();await sleep(page);
    push('provider-readonly-inspector',await content.getByLabel('只读对话',{exact:true}).count()===1&&await content.getByRole('button',{name:/^(发送|暂停|继续执行|结束|重新派发)$/}).count()===0&&await content.getByRole('textbox').count()===0,await content.innerText());
    const unknownInformation=await content.locator('.flow-information').innerText();
    push('unrecorded-usage-stays-unknown-in-ui',unknownInformation.includes('宿主已记录 Token（当前代理自身）：—')&&unknownInformation.includes('统计完整性未知'),unknownInformation);
    push('no-composer-in-observation',await page.locator('[data-composer-input=true]').isVisible().catch(()=>false)===false,'Provider readOnly view policy hides composer; main chat restores it');
    const panels=await page.locator('.flow-dock [data-dockkit-pane]:not([data-dockkit-content])').count();
    writeFileSync(join(artifacts,'wide-layout.json'),JSON.stringify(await content.evaluate(element=>Array.from(element.querySelectorAll('[data-dockkit-pane],.flow-reader,.flow-scroll,.flow-dock')).map(row=>({tag:row.className,pane:row.getAttribute('data-dockkit-pane'),content:row.getAttribute('data-dockkit-content'),rect:row.getBoundingClientRect().toJSON(),scrollHeight:row.scrollHeight,clientHeight:row.clientHeight,display:getComputedStyle(row).display,overflow:getComputedStyle(row).overflow}))),null,2));
    await page.screenshot({path:join(artifacts,'wide-details.png'),fullPage:true});
    const dockBackground=await content.locator('.flow-dock').evaluate(element=>getComputedStyle(element).backgroundColor);
    push('floating-details-have-opaque-theme-background',dockBackground!=='rgba(0, 0, 0, 0)'&&dockBackground!=='transparent',dockBackground);
    const bounds=await content.getByLabel('只读对话',{exact:true}).boundingBox();
    push('wide-provider-panels',panels===2&&Boolean(bounds&&bounds.height>100&&bounds.y+bounds.height<=1100),{panels,conversation:bounds,width:await content.evaluate(element=>element.clientWidth)});
    const divider=await page.locator('.flow-dock [data-dockkit-divider]').first().boundingBox();
    if(divider&&bounds){await page.mouse.move(divider.x,divider.y+divider.height/2);await page.mouse.down();await page.mouse.move(divider.x+50,divider.y+divider.height/2);await page.mouse.up();await sleep(page,100);const resized=await content.getByLabel('只读对话',{exact:true}).boundingBox();push('native-dock-resize',Boolean(resized&&Math.abs(resized.width-bounds.width)>10),{before:bounds,after:resized});}
    const selected=await page.locator('.flow-node[aria-pressed=true]').getAttribute('aria-label');
    const reader=content.getByLabel('只读对话',{exact:true}).locator('[data-conversation-scroll]');await reader.evaluate(element=>{element.scrollTop=0;});
    const top=await reader.evaluate(element=>element.scrollTop);
    await page.getByRole('button',{name:'打开完整会话',exact:true}).first().click();
    await page.locator('.flow-session-record').waitFor();
    await page.getByRole('tab',{name:'对话',exact:true}).click();
    await page.locator('[data-conversation-scroll]').getByText(/native-A-/).first().waitFor();
    push('recycled-native-session-history-only',await content.count()===0&&await page.locator('.flow-session-record').isVisible()&&!await page.locator('[data-composer-input=true]').isVisible().catch(()=>false),'The recycled member retains its native conversation and terminal explanation without text input');
    await page.getByRole('tab',{name:'轨迹',exact:true}).click();push('native-trajectory',await content.count()===0&&await page.locator('.flow-session-record').isVisible(),'Native Agent Session exposes trajectory and recycled-history policy');await page.getByRole('button',{name:'主会话',exact:true}).click();await sleep(page,300);
    push('full-session-return',await page.locator('.flow-node[aria-pressed=true]').getAttribute('aria-label')===selected&&Math.abs((await reader.evaluate(element=>element.scrollTop))-top)<8,'Selection and reading anchor survive full view');
    const beforeHistory=await readingAnchor(reader);
    await content.getByRole('button',{name:'加载更早',exact:true}).click();await sleep(page,400);
    const afterHistory=await reader.evaluate((element,id)=>{const row=Array.from(element.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden]):not([hidden] *)')).find(row=>row.dataset.chatAnchorKey===id);return {id:row?.dataset.chatAnchorKey,offset:row?row.offsetTop-element.scrollTop:0,top:element.scrollTop};},beforeHistory.id);
    push('native-history-anchor',beforeHistory.id===afterHistory.id&&Math.abs(beforeHistory.offset-afterHistory.offset)<8,{beforeHistory,afterHistory,meaning:'The previously visible message stays at its original offset; newly prepended content may fill space above it'});
    await page.route('**/api/session/page',route=>route.abort('failed'));
    await content.getByRole('button',{name:'加载更早',exact:true}).click();await sleep(page,400);
    const historyFailure=await content.getByLabel('只读对话',{exact:true}).innerText();
    push('history-failure-is-local',/历史加载失败|暂时无法读取更早的消息/.test(historyFailure)&&historyFailure.includes('native-A-')&&await content.getByLabel('原生记录 A 信息').isVisible(),'The provider paging error leaves loaded messages and information available');
    await page.unroute('**/api/session/page');await content.getByRole('button',{name:'加载更早',exact:true}).click();await sleep(page,400);
    await reader.evaluate(element=>element.scrollTop=100);const olderAnchor=await readingAnchor(reader);
    await page.getByRole('button',{name:'打开完整会话',exact:true}).first().click();await page.getByRole('button',{name:'主会话',exact:true}).click();
    let returnedAnchor=await readingAnchor(reader);
    for(let attempt=0;attempt<20&&(returnedAnchor.id!==olderAnchor.id||Math.abs(returnedAnchor.offset-olderAnchor.offset)>=8);attempt++){await sleep(page,250);returnedAnchor=await readingAnchor(reader);}
    push('older-full-return',olderAnchor.id===returnedAnchor.id&&Math.abs(olderAnchor.offset-returnedAnchor.offset)<8,{before:olderAnchor,after:returnedAnchor,meaning:'loadThrough restores an anchor older than the opening page'});
    await reader.evaluate(element=>element.scrollTop=100);const reading=await readingAnchor(reader);
    await host.request('observation-fixture',undefined,{session_id:nativeA,count:1,prefix:'native-A-new'});await sleep(page,400);
    push('native-unread-reading',await content.getByRole('button',{name:'回到底部',exact:true}).isVisible()&&(await readingAnchor(reader)).id===reading.id,'Public Session live update retained the visible native message identity');
    await content.getByRole('button',{name:'回到底部',exact:true}).click();
    await page.keyboard.press('Escape');await page.getByRole('button',{name:/^原生记录 B，/}).click();await page.getByRole('button',{name:/^原生记录 A，/}).click();await page.keyboard.press('Escape');await page.getByRole('button',{name:/^原生记录 B，/}).click();await sleep(page,400);
    push('native-parent-and-selection',await content.getByLabel('只读对话',{exact:true}).innerText().then(text=>text.includes('native-B')&&!text.includes('native-A'))&&await content.getByLabel('原生记录 B 信息').innerText().then(text=>text.includes('原生记录 A')),'True parent relationship and both details belong to final selected ID');
    await page.keyboard.press('Escape');
    const cold=sessionId(await host.request('observation-fixture',undefined,{workspace:layout.workspace,cold:true,count:2,prefix:'native-cold'}));
    const coldBefore=await host.request('observation-fixture',undefined,{session_id:cold,inspect:true});
    writeFileSync(join(artifacts,'cold-history-diagnostic.json'),JSON.stringify(await host.request('observation-fixture',undefined,{session_id:cold,inspect:true,read:true}),null,2));
    addReader(layout,runId,'ux-reader-cold',cold,'冷历史记录');await sleep(page);
    await content.getByRole('button',{name:/^冷历史记录，/}).click();await content.getByLabel('只读对话',{exact:true}).getByText(/native-cold/).first().waitFor();
    const coldAfter=await host.request('observation-fixture',undefined,{session_id:cold,inspect:true});
    push('cold-history-never-promotes-agent',JSON.stringify(coldBefore)===JSON.stringify(coldAfter)&&JSON.stringify(coldAfter).includes('"agent_active":false'),{before:coldBefore,after:coldAfter});
    await context.setOffline(true);await sleep(page,2500);await context.setOffline(false);await sleep(page,3500);
    const coldReconnected=await host.request('observation-fixture',undefined,{session_id:cold,inspect:true});
    push('cold-history-reconnect-remains-observation',JSON.stringify(coldBefore)===JSON.stringify(coldReconnected)&&await content.getByLabel('只读对话',{exact:true}).innerText().then(text=>text.includes('native-cold')),{before:coldBefore,after:coldReconnected});
    await page.keyboard.press('Escape');push('details-escape',await content.getByLabel('只读对话',{exact:true}).count()===0,'Escape closes the current inspector');
    await page.getByRole('button',{name:/^原生记录 A，/}).click();await sleep(page,300);
    push('simple-view-controls',JSON.stringify(await content.locator('.flow-toolbar button').allTextContents())===JSON.stringify(['拓扑图','列表'])&&await content.getByRole('textbox').count()===0,'The toolbar offers topology and list views');
    const roleColours=await content.locator('.flow-node').evaluateAll(nodes=>nodes.map(node=>({role:node.getAttribute('data-role'),colour:getComputedStyle(node).backgroundColor})));
    push('authoritative-role-colours',new Set(roleColours.map(node=>node.role)).size===4&&new Set(roleColours.map(node=>node.colour)).size===4,roleColours);
    await context.setOffline(true);await sleep(page,2500);push('stale-indication',await content.innerText().then(text=>text.includes('上次数据')),'Offline retains last coherent snapshot');
    await context.setOffline(false);await sleep(page,3500);push('reconnect-selection',await page.locator('.flow-node[aria-pressed=true]').getAttribute('aria-label')===selected,'Reconnect retains stable selection');
    await page.setViewportSize({width:1080,height:1000});await sleep(page,400);await page.screenshot({path:join(artifacts,'compact.png'),fullPage:true});
    push('compact-provider-tabs',await page.locator('.flow-dock [data-dockkit-pane]:not([data-dockkit-content])').count()===1,'One details container carries conversation/information tabs');
    await page.setViewportSize({width:390,height:844});await sleep(page,400);await content.getByRole('button',{name:'返回团队',exact:true}).click().catch(()=>{});await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
    push('mobile-list',await page.getByRole('list',{name:'智能体层级列表'}).isVisible(),'Actual content container switches to list');
    const mobileControls=await content.locator('.flow-controls').boundingBox(),firstMobileRow=await content.getByRole('listitem').first().boundingBox();
    push('mobile-controls-do-not-cover-list',Boolean(mobileControls&&firstMobileRow&&firstMobileRow.y>=mobileControls.y+mobileControls.height&&firstMobileRow.y+firstMobileRow.height<=844),{controls:mobileControls,row:firstMobileRow});
    await page.setViewportSize({width:1600,height:1100});await sleep(page,400);
    const canvas=await content.getByLabel('拓扑画布，拖动空白处平移，使用工具栏缩放').boundingBox();
    if(canvas){await page.mouse.move(canvas.x+canvas.width-60,canvas.y+60);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width-90,canvas.y+90);await page.mouse.up();}
    const transform=await content.locator('.flow-graph-world').evaluate(element=>(element as HTMLElement).style.transform);
    // Explicit fixtures test 50/200/1000 identities through the real Remote and component tree.
    for(const count of [50,200,1000]) {
      seedNodes(layout,runId,count);await sleep(page);
      if(count===50)push('new-node-keeps-pan',await content.locator('.flow-graph-world').evaluate(element=>(element as HTMLElement).style.transform)===transform&&await content.locator('.flow-node').count()===count,'Provider snapshot adds nodes without changing the manually positioned canvas');
      await content.getByRole('button',{name:'列表',exact:true}).click();
      while(await content.getByRole('button',{name:/^显示更多代理/}).count())await content.getByRole('button',{name:/^显示更多代理/}).click();
      const hits=await page.getByRole('listitem').count();
      push(`${count}-native-projection`,hits===count,{count,visibleIdentities:hits,fixture:'durable read projection; no execution throughput claim'});
    }
    await page.screenshot({path:join(artifacts,'1000-list.png'),fullPage:true});
    // Retire only the declared pressure projection before asking the mock main
    // Agent to create more teams. Large tool-output spill handling is outside
    // this UI fixture; the 1000-identity screenshot and checks are retained.
    const pressureStore=new ClusterStore(join(layout.data,'cluster.sqlite'));
    try{pressureStore.tx(()=>{pressureStore.run("DELETE FROM team_observations WHERE run_id=? AND agent_id LIKE 'ux-fixture-%'",runId);pressureStore.run("DELETE FROM agents WHERE cluster_id=? AND id LIKE 'ux-fixture-%'",runId);pressureStore.appendEvent(runId,'ux-view-fixture-removed',{prefix:'ux-fixture-',reason:'pressure projection complete'});});}finally{pressureStore.close();}
    await page.getByRole('tab',{name:'对话',exact:true}).click();await page.locator('[data-composer-input=true]').waitFor();
    await header.click();await page.getByRole('tree',{name:'智能体派生树'}).getByRole('button',{name:'查看 原生记录 A 对话',exact:true}).click();
    await page.getByRole('button',{name:'主会话',exact:true}).click();
    push('header-origin-return',await page.locator('[data-composer-input=true]').isVisible(),'Header full-session navigation returns to its original chat view');
    for(const expected of [2,3]) {
      await submit(page,`/agent-team ${objective}`);
      for(let attempt=0;attempt<30&&binding(layout).length<expected;attempt++)await sleep(page,500);
      await page.getByRole('button',{name:'发送消息',exact:true}).waitFor();
    }
    const multiple=binding(layout);const newer=multiple.slice(1).map(row=>String(row.run_id));
    for(const id of newer)await host.request('control',id,{action:'pause'});
    await page.getByRole('tab',{name:'智能体',exact:true}).click();await sleep(page,300);
    const latestRun=newer.at(-1)!;
    push('current-run-isolated',await content.locator('.flow-node').count()===3&&!await content.innerText().then(text=>text.includes('ux-reader-A')), 'The current run never reuses a previous run selection or reader');
    await page.route('**/api/flow/teamRead',async route=>{if(JSON.stringify(route.request().postDataJSON()).includes(latestRun))await route.abort('failed');else await route.continue();});await sleep(page);
    push('unavailable-run-navigation',await page.getByRole('tab',{name:'对话',exact:true}).isVisible()&&await content.getByRole('button',{name:'重试连接',exact:true}).isVisible(),'An unavailable snapshot preserves native main navigation');
    await page.unroute('**/api/flow/teamRead');await content.getByRole('button',{name:'重试连接',exact:true}).click();await sleep(page);
    push('three-intentional-runs',multiple.length===3,'Acknowledged identical objectives create separate runs');
    await page.getByRole('tab',{name:'对话',exact:true}).click();await sleep(page);
    push('main-is-native-owner-dialog',await page.locator('[data-composer-input=true]').isVisible()&&await page.locator('[data-chat-turn]').count()>0,'Inspecting agents never substitutes background logs for human dialogue');
    await page.getByRole('tab',{name:'智能体',exact:true}).click();await sleep(page,300);
    for(const id of newer)await host.request('control',id,{action:'cancel'});
    await setNativeTheme(page,'dark');
    await page.screenshot({path:join(artifacts,'dark-team.png'),fullPage:true});
    const dark=await content.evaluate(element=>getComputedStyle(element).color);
    await setNativeTheme(page,'light');
    const light=await content.evaluate(element=>getComputedStyle(element).color);
    push('native-theme-motion',dark!==light&&await content.evaluate(element=>element.getAnimations({subtree:true}).every(animation=>animation.playState!=='running')),{dark,light,systemReducedMotion:true});
    await page.getByRole('tab',{name:'对话',exact:true}).click();
    await page.getByRole('button',{name:'插件',exact:true}).click();await sleep(page);
    await page.getByText('dsh-flow',{exact:true}).first().click();await sleep(page,600);
    await page.locator('.flow-settings').waitFor();
    const retiredControls=['团队 Token 总预算','团队模型请求上限','单次最大输出 Token','任务代理最大输出 Token','每个任务代理模型请求上限'];
    const retiredCounts:number[]=[];for(const label of retiredControls)retiredCounts.push(await page.getByLabel(label,{exact:true}).count());
    push('resource-settings-clean-contract',retiredCounts.every(count=>count===0)&&await page.getByLabel('团队工具调用上限',{exact:true}).count()===1,{retired:retiredCounts,retained:'tool-call limit'});

    const field=page.getByLabel('默认团队视图',{exact:true});await field.selectOption('list');await page.getByLabel('已结束节点',{exact:true}).selectOption('collapse');
    const displayFields=[];for(const name of ['默认团队视图','已结束节点','动态效果','用量显示','对话自动跟随'])displayFields.push(await page.getByLabel(name,{exact:true}).count());
    push('five-display-fields',displayFields.every(count=>count===1),'Five display fields remain distinct from team execution defaults');
    await page.getByRole('button',{name:'保存',exact:true}).click();await sleep(page,200);
    push('save-display-only',await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh-flow:display:v1')??'{}').view)==='list','Explicit save persisted display preferences');
    await page.getByRole('button',{name:'恢复默认',exact:true}).click();await page.getByRole('button',{name:'取消更改',exact:true}).click();
    push('defaults-cancel',await field.inputValue()==='list','Cancel restored the saved value');
    await field.selectOption('graph');await page.getByRole('button',{name:'返回会话',exact:true}).click();await page.getByRole('dialog',{name:'有未保存的更改'}).waitFor();
    push('three-leave-choices',await page.getByRole('button',{name:'保存并离开',exact:true}).count()===1&&await page.getByRole('button',{name:'放弃更改',exact:true}).count()===1&&await page.getByRole('button',{name:'继续编辑',exact:true}).count()>=1,'Provider modal guards public workspace navigation');
    await page.getByRole('button',{name:'继续编辑',exact:true}).first().click();
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Object.assign(window,{__uxStorageWrite:original});Storage.prototype.setItem=function(key,value){if(key==='dsh-flow:display:v1')throw new DOMException('Fixture quota exceeded','QuotaExceededError');original.call(this,key,value);};});
    await page.getByRole('button',{name:'保存',exact:true}).click();await sleep(page,100);
    push('save-failure-retains-draft',await field.inputValue()==='graph'&&await page.locator('.flow-settings').innerText().then(text=>text.includes('未能保存显示设置'))&&await page.getByRole('button',{name:'保存',exact:true}).isEnabled()&&await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh-flow:display:v1')??'{}').view)==='list','A real browser storage failure leaves the saved display and editable draft intact with an enabled retry action');
    await page.getByRole('button',{name:'返回会话',exact:true}).click();await page.getByRole('button',{name:'保存并离开',exact:true}).click();await sleep(page,100);
    push('failed-save-stays',await page.getByRole('dialog',{name:'有未保存的更改'}).isVisible(),'Navigation waited for the actual failed save');
    await page.getByRole('button',{name:'继续编辑',exact:true}).first().click();
    await page.evaluate(()=>{Storage.prototype.setItem=Reflect.get(window,'__uxStorageWrite');});await page.screenshot({path:join(artifacts,'settings.png'),fullPage:true});
    await page.getByRole('button',{name:'取消更改',exact:true}).click();await page.getByRole('button',{name:'返回会话',exact:true}).click();
    await header.click();const tree=page.getByRole('tree',{name:'智能体派生树'});
    await page.getByRole('dialog',{name:'智能体团队',exact:true}).getByRole('button',{name:/已结束 .* 个 · 展开/}).waitFor({state:'visible'});
    push('header-ended-preference',await tree.getByRole('button',{name:'查看 原生记录 A 对话',exact:true}).count()===0&&await page.getByRole('dialog',{name:'智能体团队',exact:true}).getByRole('button',{name:/已结束 .* 个 · 展开/}).isVisible(),'Saved collapse preference hides ended identities while preserving live ancestors and the expansion entry');
    await page.getByRole('dialog',{name:'智能体团队',exact:true}).getByRole('button',{name:/已结束 .* 个 · 展开/}).click();
    push('header-ended-expand',await tree.locator('[data-tree-id="ux-reader-A"]').isVisible(),'Header expansion reveals the original historical identity of the remaining active run');await page.keyboard.press('Escape');
    await host.request('control',runId,{action:'cancel'});await sleep(page);
    await page.getByRole('tab',{name:'智能体',exact:true}).click();await sleep(page,300);
    push('terminal-history',await header.innerText().then(text=>text.includes('已取消'))&&await page.locator('.flow-content').isVisible(),'Cancellation preserves the native team view and terminal header');
    await page.screenshot({path:join(artifacts,'terminal.png'),fullPage:true});
    push('no-client-exceptions',errors.length===0,errors);
  } catch(error) {push('native-ui-sequence',false,String(error));if(page){writeFileSync(join(artifacts,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:join(artifacts,'failure.png'),fullPage:true});}}
  finally {mock?.release('panel-hold');await browser.close();}
  writeFileSync(join(artifacts,'checks.json'),JSON.stringify(checks,null,2));return {checks};
}
export async function run({report,layout}:{report:Report;layout:RunLayout}) {
  const checks=[...(report.live_checks?.checks??[])];
  checks.push({name:'durable-ledger',passed:existsSync(join(layout.data,'cluster.sqlite')),evidence:'The execution ledger and main-conversation team runs are persisted'});
  const failed=checks.some(check=>check.passed===false);
  return {checks,scenario_status:failed?'FAILED':'PASSED',failure_class:failed?'MECHANISM':null};
}
