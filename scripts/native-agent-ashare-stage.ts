/** Live ordinary-Agent / Flow comparison. Run after building, once source identity is frozen. */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { identity, readJson, sha, writeJson } from './native-agent-ashare-e2e-lib.ts';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, object, WEB_PROFILE_BUNDLES } from '../src/host/host.ts';
import { readSessionEvents, readSessionText } from '../src/host/session-scan.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const campaign = resolve(arg('campaign') ?? '');
if (!arg('campaign') || !arg('stage') || !argv.includes('--execute')) throw new Error('Explicit --campaign, --stage and --execute required');
const manifest = readJson(join(campaign, 'manifest.json'));
const stages = manifest.stages as {id:string; mode:string; pair:number}[];
const stage = stages.find(value => value.id === arg('stage'));
if (!stage) throw new Error('Unregistered stage');
for (const previous of stages.slice(0, stages.indexOf(stage))) if (!existsSync(join(campaign, 'runs', previous.id, 'report.json')) || !readJson(join(campaign, 'runs', previous.id, 'report.json')).finished_at) throw new Error('Earlier scheduled stage has not sealed');
const pinned = identity(campaign);
if (JSON.stringify(pinned) !== JSON.stringify(manifest.identity)) throw new Error('Frozen campaign identity changed before execution');
const mode = stage.mode;
const route = object(manifest.route);
const provider = String(route.provider), model = String(route.model), reasoningEffort = String(route.reasoningEffort), preset = String(route.preset);
const timeoutMs = Number(manifest.timeout_ms);
const deadline = AbortSignal.timeout(timeoutMs);
const layout = createRunLayout(join(campaign, 'runs'), stage.id);
writeJson(join(layout.root, 'report.json'), {status:'PREPARATION_INCOMPLETE', stage, created_at:new Date().toISOString()});
const profile = 'strict-live';
const prepared = ensureProfile(layout.home, profile, {bundles:[...WEB_PROFILE_BUNDLES, 'dsh-flow'], packagePath:join(campaign,'frozen-package')});
const rowsText = readFileSync(join(campaign,'.private','profile.patch.yml'),'utf8');
const credentials = readFileSync(join(campaign,'.private','credentials.yml'));
writeFileSync(join(layout.home,'.credentials.yaml'),credentials,{mode:0o600});
writeFileSync(join(prepared.dir,'cordis.patch.yml'),rowsText,{mode:0o600});
const selectedEnv: Record<string,string> = {};
const patch = join(layout.root, 'runtime.patch.yml');
writeFileSync(patch, stringify([
  { id: 'hmr', disabled: true },
  { id: 'dsh-flow', config: { dataDir: layout.data, workspace: layout.workspace, maxConcurrentAgents: 4 } },
]), { mode: 0o600 });
const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace, extra: selectedEnv });
const host = new DshWebHost({ profile, patches: [patch], cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
const started = Date.now();
const fingerprint = () => identity(campaign);
const before = fingerprint();
const report: Record<string, unknown> = { status: 'RUNNING', mode, date: '2026-10-12', started_at: new Date(started).toISOString(), route: { provider, model, reasoningEffort, preset },
  profile_model_config_sha256: hash(rowsText), stage, common_prompt_sha256: manifest.common_prompt_sha256, mode_prompt_sha256: object(manifest.mode_prompt_sha256)[mode], before, workspace: layout.workspace, timeout_ms: timeoutMs, notes: ['Runner timeout is not a Flow execution limit. No single-Agent performance comparison is claimed by an individual run.'] };
let sessionId: string | undefined;
let settled = false;
const rpc = (method: string, args: unknown) => host.rpc(method, args, deadline);
const prompt = readFileSync(join(campaign,'task.txt'),'utf8');
const teamInstruction = readFileSync(join(campaign,`${mode}-mode.txt`),'utf8');
writeFileSync(join(layout.root,'task.txt'),prompt);
writeFileSync(join(layout.root,'mode-instructions.txt'),teamInstruction);
let dispatchedAt: number | null = null;
let completionAt: number | null = null;
try {
  await host.start();
  const created = object(await rpc('session/create', { request: { cwd: layout.workspace, agentPreset: preset } }));
  if (typeof created.sessionId !== 'string') throw new Error('Native create did not return a Session identity');
  sessionId = created.sessionId;
  report.owner_session_id = sessionId;
  await rpc('session/selectModel', { request: { sessionId, provider, model, reasoningEffort } });
  dispatchedAt = Date.now();
  writeJson(join(layout.root,'submitted-input.json'),{business:prompt,mode:teamInstruction,method:mode==='team'?'commands/execute':'session/prompt',common_prompt_sha256:sha(prompt)});
  if (mode === 'team') {
    await rpc('commands/execute', { agentId: sessionId, line: `/agent-team ${prompt}\n${teamInstruction}`, submittedAttachments: [], submissionId: randomUUID() });
  } else {
    await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: `${prompt}\n${teamInstruction}` }], clientTimeZone: 'Asia/Shanghai' } });
  }
  let snapshot: Record<string, unknown> | null = null;
  let ownerCompletion: ReturnType<typeof completionOf> | null = null;
  let stableCompletion = '';
  while (!deadline.aborted) {
    if (mode === 'team') {
      const runs = await rpc('flow/teamRuns', { sessionId });
      if (Array.isArray(runs) && runs.length) {
        const run = object(runs[0]);
        snapshot = object(await rpc('flow/teamRead', { sessionId, teamId: run.id }));
      }
    }
    const path = sessionJournal(layout.home, sessionId);
    const listing = object(await rpc('session/list', { _request: {} }));
    const owner = Array.isArray(listing.items) ? listing.items.map(object).find(row => row.sessionId === sessionId) : undefined;
    ownerCompletion = path ? completionOf(path, owner?.running) : null;
    appendFileSync(join(layout.root,'observations.jsonl'), JSON.stringify({at:Date.now(),owner:ownerCompletion,team:snapshot ? object(snapshot.run).state : null,members:snapshot?.members ?? null})+'\n');
    const teamTerminal = snapshot && ['completed', 'failed', 'cancelled'].includes(String(object(snapshot.run).state));
    const candidate = ownerCompletion?.settled && (mode === 'ordinary' || teamTerminal)
      ? JSON.stringify({ completion: ownerCompletion, state: snapshot && object(snapshot.run).state }) : '';
    // A terminal marker must still be the latest native Turn after a second
    // public running=false observation. Historical Turn ends are insufficient.
    if (candidate && candidate === stableCompletion) { settled = true; break; }
    stableCompletion = candidate;
    await delay(2000, undefined, { signal: deadline });
  }
  if (settled && completionAt === null) completionAt = Date.now();
  if (snapshot) report.team = snapshot;
  report.owner_completion = ownerCompletion;
  report.output = checkOutput(layout.workspace);
  const summaries = journalFiles(layout.home).map(path => summarizeJournal(path));
  report.sessions = summaries;
  const actual = summaries.flatMap(entry => entry.models);
  const routeMatches = actual.length > 0 && actual.every(entry => entry.provider === provider && entry.model === model);
  const teamDone = snapshot && object(snapshot.run).state === 'completed';
  const collaborators = snapshot && Array.isArray(snapshot.members) ? snapshot.members.map(object)
    .filter(member => summaries.some(entry => entry.session_id === member.id && entry.responses > 0 && entry.tool_calls > 0)) : [];
  report.actual_route_matches = routeMatches;
  report.executed_collaborator_session_ids = collaborators.map(member => member.id);
  // A team acceptance run must prove some real collaboration; it must not
  // prescribe a role hierarchy or a fixed number of reviewers/child Agents.
  report.execution_complete = settled && ownerCompletion?.reason === 'completed' && (mode === 'ordinary' ? summaries.length === 1 && summaries[0]?.control_calls === 0 : teamDone && collaborators.length >= 1);
  report.source_accuracy_verified = false;
  report.status = deadline.aborted ? 'TIMEOUT' :
    object(report.output).structure_passed && routeMatches && report.execution_complete ? 'AWAITING_SOURCE_REVIEW' : 'FAILED';
} catch (error) {
  report.status = deadline.aborted ? 'TIMEOUT' : 'ERROR';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  // Only this isolated app and its own Session are touched.
  if (!settled && sessionId && host.origin) await host.rpc('session/cancel', { request: { sessionId } }, AbortSignal.timeout(10_000)).catch(() => {});
  await host.stop();
  // Include every final persisted response, including failed/timeout attempts.
  // The journal hashes describe the closed files, not a pre-flush snapshot.
  report.sessions = journalFiles(layout.home).map(path => summarizeJournal(path));
  try {
    const evidence = sealEvidence(); report.evidence = evidence;
    report.actual_route_preset_policy_verified = evidence.protocol_matches;
    if (!evidence.protocol_matches && report.status === 'AWAITING_SOURCE_REVIEW') report.status = 'INVALID_PROTOCOL';
  } catch(error) { report.evidence_error = error instanceof Error ? error.message : String(error); report.status = 'EVIDENCE_ERROR'; }
  report.dispatched_at = dispatchedAt; report.completion_observed_at = completionAt;
  report.task_wall_ms = completionAt !== null && dispatchedAt !== null ? completionAt-dispatchedAt : null;
  report.unknown_inflight_usage = !settled;
  report.output ??= checkOutput(layout.workspace);
  report.after = fingerprint();
  report.build_drift = JSON.stringify(before) !== JSON.stringify(report.after);
  if (report.build_drift) report.status = 'INVALID_BUILD_DRIFT';
  report.finished_at = new Date().toISOString(); report.duration_ms = Date.now() - started;
  writeFileSync(join(layout.root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: join(layout.root, 'report.json'), duration_ms: report.duration_ms }));
}
// Execution success still requires separate source/price review; never call this task PASSED.
if (report.status !== 'AWAITING_SOURCE_REVIEW') process.exitCode = 1;

function hash(text: string | Buffer): string { return createHash('sha256').update(text).digest('hex'); }
function treeHash(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => { if (!existsSync(dir)) return; for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name); if (item.isDirectory()) walk(path); else if (item.isFile()) entries.push(`${relative(root,path)}:${hash(readFileSync(path))}`);
  } }; walk(root); return hash(entries.join('\n'));
}
function journalFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'profiles') continue;
    const path = join(dir, item.name); if (item.isDirectory()) walk(path);
    else if (item.isFile() && /^session\..*jsonl(?:\.zstd)?$/.test(item.name)) files.push(path);
  } }; walk(root); return files;
}
function sessionJournal(root: string, id: string): string | undefined { return journalFiles(root).find(path => path.includes(`/${id}/`)); }
function completionOf(path: string, running: unknown) {
  const parsed = readSessionEvents(path);
  const starts = parsed.events.filter(event => event.type === 'turn/start');
  const latest = starts.at(-1);
  const turn = latest ? object(latest.data).turn : undefined;
  const end = parsed.events.findLast(event => event.type === 'turn/end' && object(event.data).turn === turn && latest && event.seq > latest.seq);
  const pendingInput = !!end && parsed.events.some(event => event.seq > end.seq && event.type === 'user/message');
  return { state: parsed.state, turn, start_seq: latest?.seq, end_seq: end?.seq, running,
    reason: end ? object(object(end.data).reason).kind : null,
    settled: parsed.state === 'READ' && running === false && !!latest && !!end && !pendingInput };
}
function summarizeJournal(path: string) {
  const parsed = readSessionEvents(path);
  const result = { path, session_id: path.split('/').at(-2), state: parsed.state, sha256: hash(readFileSync(path)), turn_ends: 0, responses: 0, tool_calls: 0, control_calls: 0, tool_errors: 0, first_business_tool_ms: null as number | null, usage_responses: 0,
    first_turn_at: null as number | null, last_turn_end_at: null as number | null, native_elapsed_ms: null as number | null, tools: {} as Record<string, number>,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }, models: [] as { provider: string; model: string }[] };
  for (const event of parsed.events) {
    const data = object(event.data);
    if (event.type === 'turn/start' && event.time !== undefined && result.first_turn_at === null) result.first_turn_at = event.time;
    if (event.type === 'turn/end') { result.turn_ends++; result.last_turn_end_at = event.time ?? null; }
    if (event.type === 'tool/call') { result.tool_calls++; const name = String(data.name); result.tools[name] = (result.tools[name] ?? 0) + 1; if (/^(flow_|agent_team_)/.test(name)) result.control_calls++; else if (result.first_business_tool_ms === null && event.time !== undefined) result.first_business_tool_ms = event.time - started; }
    if (event.type === 'tool/result' && object(data.message ?? {}).isError) result.tool_errors++;
    if (event.type === 'assistant/message') {
      result.responses++; if (data.usage) result.usage_responses++;
      const message = object(data.message ?? {}), source = object(message.source ?? {}), usage = object(data.usage ?? {});
      if (typeof source.provider === 'string' && typeof source.model === 'string' && !result.models.some(value => value.provider === source.provider && value.model === source.model)) result.models.push({ provider: source.provider, model: source.model });
      result.usage.input_tokens += Number(usage.inputTokens ?? 0); result.usage.output_tokens += Number(usage.outputTokens ?? 0); result.usage.cache_read_tokens += Number(usage.cacheReadTokens ?? 0);
    }
  }
  if (result.first_turn_at !== null && result.last_turn_end_at !== null) result.native_elapsed_ms = result.last_turn_end_at - result.first_turn_at;
  return result;
}
function checkOutput(workspace: string): Record<string, unknown> {
  try {
    const reportPath = join(workspace, 'report.md'), dataPath = join(workspace, 'market-data.json');
    const text = readFileSync(reportPath, 'utf8'), data = object(JSON.parse(readFileSync(dataPath, 'utf8')));
    const indices = Array.isArray(data.indices) ? data.indices.map(object) : [], sources = Array.isArray(data.sources) ? data.sources.map(object) : [];
    const checked = sources.map(source => {
      const path = resolve(workspace, String(source.raw_path));
      const inside = path.startsWith(`${workspace}/raw/`);
      return { url: source.url, raw_path: source.raw_path, date: source.data_date, http_status: source.http_status, retrieved_at: source.retrieved_at,
        // A legitimate endpoint may return a short scalar, e.g. a stock count.
        // Nonempty preservation is structural evidence, not source accuracy.
        valid: inside && existsSync(path) && statSync(path).size > 0 && source.http_status === 200 && source.data_date === '2026-10-12' && /^https?:\/\//.test(String(source.url)),
        sha256: inside && existsSync(path) ? hash(readFileSync(path)) : null };
    });
    return { structure_passed: data.date === '2026-10-12' && text.includes('2026-10-12') && text.length > 800 && indices.length >= 3 &&
      ['上证','深证','创业板'].every(name => indices.some(index => String(index.name).includes(name) && Number.isFinite(index.close) && Number.isFinite(index.change_percent))) && checked.length > 0 && checked.every(source => source.valid),
      report: reportPath, report_sha256: hash(text), data: dataPath, data_sha256: hash(readFileSync(dataPath)), sources: checked,
      limitation: 'This mechanical check verifies only structured output and locally preserved files. HTTP status/date are model claims until checked against native receipts and raw prices. AWAITING_SOURCE_REVIEW is not task success.' };
  } catch (error) { return { structure_passed: false, reason: error instanceof Error ? error.message : String(error) }; }
}

function sealEvidence() {
  const all = journalFiles(layout.home);
  const dest = join(layout.root,'native-evidence'); mkdirSync(dest);
  const index: Record<string,unknown>[] = [];
  let protocolMatches = all.length > 0;
  for (const path of all) {
    const parsed = readSessionEvents(path), id = path.split('/').at(-2)!;
    writeJson(join(dest,`${id}.events.json`), parsed);
    const receipts = parsed.events.filter(e => /^(tool\/(call|result)|request\/header|turn\/(start|end)|user\/message)$/.test(e.type));
    writeJson(join(dest,`${id}.trace.json`), receipts);
    const request = parsed.events.find(e => e.type === 'request/header');
    const headers = parsed.events.filter(e => e.type === 'request/header').map(e=>object(object(e.data).header));
    const sessionHeader = JSON.parse(readSessionText(path)!.split('\n')[0]!);
    const policies = parsed.events.filter(e=>/^(permission\/preset|sandbox\/mode|approval\/policy)$/.test(e.type));
    const policyMatches = policies.some(e=>e.type==='sandbox/mode' && object(e.data).mode==='workspace-write') && policies.some(e=>e.type==='approval/policy' && object(e.data).policy==='ask');
    const routeMatches = headers.length > 0 && headers.every(header=>{ const config=object(header.config); return config.provider===provider && config.model===model && config.reasoningEffort===reasoningEffort; });
    const presetMatches = sessionHeader.agentPreset===preset;
    const tools=Array.isArray(object(request?.data ?? {}).header) ? [] : request ? object(object(request.data).header).tools : [];
    protocolMatches &&= parsed.state==='READ' && routeMatches && presetMatches && policyMatches;
    if(mode==='ordinary' && (all.length!==1 || parsed.events.some(e=>e.type==='tool/call' && /^(flow_|agent_team_)|subagent|^task$/.test(String(object(e.data).name)))))protocolMatches=false;
    const firstInput = parsed.events.find(e => e.type === 'user/message');
    const notices = parsed.events.filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('flow-'));
    writeJson(join(dest,`${id}.provenance.json`),{sessionHeader,request,firstInput,policies,notices,tool_catalog_sha256:sha(JSON.stringify(tools)),routeMatches,presetMatches,policyMatches});
    index.push({id,journal:path,journal_sha256:sha(readFileSync(path)),state:parsed.state,event_count:parsed.events.length,request_header_count:parsed.events.filter(e=>e.type==='request/header').length});
  }
  writeJson(join(dest,'index.json'),index);
  return {index,protocol_matches:protocolMatches,workspace_sha256:treeHash(layout.workspace),native_evidence_sha256:treeHash(dest),source_accuracy_verified:false};
}
