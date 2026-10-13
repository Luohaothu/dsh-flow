/** Real HTTP command admission, native Agents/tools and cold replay; no external model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES, object } from '../../src/host/host.ts';
import type { FlowTeamSnapshot } from '../../packages/dsh-flow/src/types.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

interface NativeState { id: string; live: boolean; running: boolean; events: SessionEvent[]; images: {reference: unknown; stored: boolean}[] }
interface State { status: string; teams: FlowTeamSnapshot[]; sessions: NativeState[]; ordinary_teams: unknown[]; request_count: number }
interface Request {session_id: string; purpose: string; provider: string; model: string; tools: string[]; messages: unknown[]}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const flowTools = ['flow_control', 'flow_message', 'flow_read', 'flow_result', 'flow_review', 'flow_task'];
const aliases = ['agent_team_create', 'agent_team_read', 'agent_team_message', 'agent_team_control'];
const userInputs = (session: NativeState) => session.events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.startsWith('/agent-team PROBE-OWNER')));
const finalText = (session: NativeState, marker: string) => session.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes(marker)));

test('native command RPC creates once, admits real attachments and finishes through native member delivery and owner review', {timeout: 120_000}, async () => {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts/team-command'), `rpc-${Date.now()}`);
  const plugin = join(layout.root, 'probe.mjs');
  await build({entryPoints:[join(PROJECT_ROOT,'tests/integration/fixtures/team-command-probe.ts')],outfile:plugin,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const packageHash = () => createHash('sha256').update(readFileSync(join(PROJECT_ROOT,'packages/dsh-flow/lib/index.js'))).update(readFileSync(join(PROJECT_ROOT,'packages/dsh-flow/lib/command.js'))).digest('hex');
  const before = packageHash();
  ensureProfile(layout.home, 'team-command', {bundles:[...WEB_PROFILE_BUNDLES,'dsh-flow']});
  const env = buildHostEnv({home:layout.home,tmpdir:layout.tmp,dataDir:layout.data,workspace:layout.workspace});
  const start = async (phase: string) => {
    const patch = join(layout.root, `${phase}.patch.yml`);
    writeFileSync(patch, `- id: hmr\n  disabled: true\n- id: dsh-flow\n  config:\n    dataDir: ${JSON.stringify(layout.data)}\n    workspace: ${JSON.stringify(layout.workspace)}\n- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: ${JSON.stringify(layout.workspace)}\n- id: permission\n  config:\n    defaultPreset: workspace-write\n- id: agent-default-model\n  config:\n    provider: team-command-probe\n    model: scripted\n- insert:\n    - id: team-command-probe\n      name: ${JSON.stringify(plugin)}\n      config:\n        root: ${JSON.stringify(layout.root)}\n        phase: ${phase}\n`);
    return new DshWebHost({profile:'team-command',patches:[patch],cwd:layout.workspace,env,logPath:join(layout.logs,`${phase}.log`)}).start();
  };
  const state = (phase: string): State | null => {
    const path=join(layout.root,`${phase}-state.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : null;
  };
  const waitFor = async (phase: string, predicate: (value: State) => boolean): Promise<State> => {
    const deadline=Date.now()+25_000;
    while(Date.now()<deadline) { const value=state(phase); if(value?.status==='OBSERVED' && predicate(value))return value; await delay(25); }
    assert.fail(`Native ${phase} condition not reached; inspect ${layout.root}: ${JSON.stringify(state(phase))}`);
  };
  let host = await start('fresh');
  try {
    const owner=String(object(await host.rpc('session/create',{request:{cwd:layout.workspace,agentPreset:'standard'}})).sessionId);
    const ordinary=String(object(await host.rpc('session/create',{request:{cwd:layout.workspace,agentPreset:'standard'}})).sessionId);
    writeFileSync(join(layout.root,'control.json'),JSON.stringify({owner,ordinary,release:false}));
    const descriptors=await host.rpc('commands/list',{agentId:owner});
    assert.ok(Array.isArray(descriptors));
    const descriptor=descriptors.map(object).find(command=>command.name==='agent-team');
    assert.equal(object(descriptor?.input).attachments,true,'the actual native descriptor opts into attachment admission');
    const submissionId=randomUUID();
    const invocation={agentId:owner,line:'/agent-team PROBE-OWNER: Delegate one file, verify it with read and finish the root task.',
      submittedAttachments:[{type:'image',mediaType:'image/png',data:png,name:'probe.png'}],submissionId};
    const replies=await Promise.all([host.rpc('commands/execute',invocation),host.rpc('commands/execute',invocation),host.rpc('commands/execute',invocation)]);
    replies.push(await host.rpc('commands/execute',invocation));
    writeFileSync(join(layout.root,'command-replies.json'),JSON.stringify(replies,null,2));
    for(const reply of replies)assert.equal(object(object(reply).result).kind,'success',JSON.stringify(reply));
    const initial=await waitFor('fresh',value=>value.teams.length===1&&value.request_count>0&&value.sessions.some(session=>session.id===owner&&userInputs(session).length===1));
    assert.equal(initial.teams[0]!.tasks.length,1); assert.equal(initial.teams[0]!.members.length,0);
    const root=initial.teams[0]!.tasks[0]!;
    assert.equal(root.owner_session_id,owner);assert.equal(root.assignee_session_id,owner);
    const original=initial.sessions.find(session=>session.id===owner)!;
    assert.equal(original.events.filter(event=>event.type==='flow/team-intent').length,1);
    assert.equal(original.images.length,1);assert.equal(original.images[0]!.stored,true,'native attachment storage can read the admitted reference');
    const requests: Request[]=JSON.parse(readFileSync(join(layout.root,'fresh-requests.json'),'utf8'));
    const first=requests.find(request=>request.session_id===owner&&request.purpose==='agent');assert.ok(first);
    assert.deepEqual(first.tools.filter(name=>name.startsWith('flow_')).sort(),flowTools);
    assert.equal(first.tools.some(name=>aliases.includes(name)),false);
    assert.ok(JSON.stringify(first.messages).includes(root.id));assert.ok(JSON.stringify(first.messages).includes(initial.teams[0]!.run.id));
    writeFileSync(join(layout.root,'initial-admission.json'),JSON.stringify({descriptor,state:initial,first_request:first,replies},null,2));
    for(const changed of [{...invocation,line:invocation.line+' changed'},{...invocation,submittedAttachments:[]}]) {
      await assert.rejects(host.rpc('commands/execute',changed), /同一提交标识不能用于不同需求.*409/u);
    }
    writeFileSync(join(layout.root,'control.json'),JSON.stringify({owner,ordinary,release:true}));
    const complete=await waitFor('fresh',value=>value.teams[0]?.run.state==='completed'&&value.sessions.some(session=>session.id===owner&&!session.running&&finalText(session,'OWNER-DONE'))&&value.teams[0]?.members.every(member=>member.state==='closed')===true);
    const team=complete.teams[0]!;assert.equal(team.members.length,1);assert.equal(team.tasks.length,2);assert.equal(team.reviews.length,1);
    const child=complete.sessions.find(session=>session.id===team.members[0]!.id)!;
    const main=complete.sessions.find(session=>session.id===owner)!;
    const callNames=(session:NativeState)=>session.events.flatMap(event=>event.type==='tool/call'?[event.data.name]:[]);
    assert.deepEqual(callNames(child),['write'],'member publishes via natural native return, with no explicit flow_result');
    assert.deepEqual(callNames(main),['flow_task','read','flow_review','flow_result']);
    assert.equal(child.live,false,'Flow releases its owned member after completion');assert.equal(main.live,true,'the main native Agent survives team completion');
    assert.ok(finalText(child,'MEMBER-DONE'));assert.equal(team.results.length,2);
    assert.equal(team.results.filter(result=>result.task_id===root.id).length,1);
    assert.ok(team.results.every(result=>result.ready));assert.ok(team.reviews[0]!.accepted);
    for(const session of [main,child])for(const event of session.events)if(event.type==='tool/result')assert.notEqual(event.data.message.isError,true);
    for(const session of [main,child]) {
      const ended=session.events.filter(event=>event.type==='turn/end');assert.ok(ended.length>0);
      for(const event of ended)assert.equal(event.data.reason.kind,'completed','natural completion, not cancellation, owns the final delivery');
    }
    assert.equal(readFileSync(join(layout.workspace,'command-member.txt'),'utf8'),'NATIVE-COMMAND-ARTIFACT\n');
    await host.rpc('session/prompt',{request:{sessionId:ordinary,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'PROBE-ORDINARY: return ORDINARY-DONE without collaboration.'}]}});
    const fresh=await waitFor('fresh',value=>value.sessions.some(session=>session.id===ordinary&&!session.running&&finalText(session,'ORDINARY-DONE')));
    assert.deepEqual(fresh.ordinary_teams,[]);
    assert.equal(userInputs(fresh.sessions.find(session=>session.id===owner)!).length,1);
    writeFileSync(join(layout.root,'fresh-final.json'),JSON.stringify(fresh,null,2));
    await host.stop();host=await start('cold');
    const coldReply=object(await host.rpc('commands/execute',invocation));assert.equal(object(coldReply.result).kind,'success');
    const cold=await waitFor('cold',value=>value.teams[0]?.run.state==='completed'&&value.sessions.some(session=>session.id===owner&&session.events.filter(event=>event.type==='command/done').length>=7));
    assert.equal(cold.teams.length,1);assert.equal(cold.teams[0]!.run.id,team.run.id);assert.equal(cold.teams[0]!.members.length,1);
    const restored=cold.sessions.find(session=>session.id===owner)!;
    assert.equal(userInputs(restored).length,1);assert.equal(restored.events.filter(event=>event.type==='flow/team-intent').length,1);
    await delay(200);assert.equal(state('cold')!.request_count,0,'cold duplicate starts neither an Agent turn nor a title model request');
    assert.equal(packageHash(),before,'the loaded production bundle did not drift during the probe');
    writeFileSync(join(layout.root,'report.json'),JSON.stringify({status:'PASSED',kind:'real-native-http-rpc-and-production-flow-with-scripted-model',
      external_model_requests:0,package_sha256:before,owner_session:owner,member_session:child.id,ordinary_session:ordinary,
      automatic_root_before_model:true,initial_members:0,concurrent_sequential_cold_dedup:true,attachment_admission:'real encoded PNG to durable native image reference; storage read verified',
      upload_file_receipt_path:'not exercised',first_catalog:flowTools,legacy_aliases:[],natural_member_return:true,owner_native_read_review_complete:true,
      main_final_reply_survives:true,member_released:true,ordinary_no_team:true,cold_replay_model_requests:0},null,2));
  } catch(error) {
    writeFileSync(join(layout.root,'failure.json'),JSON.stringify({status:'FAILED',error:String(error),stack:error instanceof Error?error.stack:null},null,2));throw error;
  } finally {await host.stop();}
});
