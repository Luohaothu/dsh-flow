/** Live ordinary-Agent / Flow comparison. Run after building, once source identity is frozen. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, object, PLUGIN_ROOT, PROJECT_ROOT, WEB_PROFILE_BUNDLES } from '../../src/host/host.ts';
import { readSessionEvents } from '../../src/host/session-scan.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const mode = arg('mode') ?? 'ordinary';
if (!['ordinary', 'team'].includes(mode)) throw new Error('--mode must be ordinary or team');
const profileSource = arg('profile-dir');
if (!profileSource) throw new Error('Pass --profile-dir pointing to the existing, read-only configured profile');
const provider = arg('provider') ?? 'qwen-token-plan-cn';
const model = arg('model') ?? 'deepseek-v4.1-flash';
const reasoningEffort = arg('reasoning-effort') ?? 'max';
const preset = arg('preset') ?? 'standard';
const timeoutMs = Number(arg('timeout-ms') ?? 1_200_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid runner timeout');
const deadline = AbortSignal.timeout(timeoutMs);
const networkDeadline = () => AbortSignal.any([deadline, AbortSignal.timeout(30_000)]);
const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts/native-agent-simplification'), arg('run-id') ?? `${mode}-${Date.now()}`);
writeFileSync(join(layout.root, 'report.json'), JSON.stringify({ status: 'PREPARATION_INCOMPLETE', mode, date: '2026-10-12', created_at: new Date().toISOString(), note: 'The run has an exclusive directory; preparation or execution has not produced a final report yet.' }, null, 2));
const profile = 'native-live';
const prepared = ensureProfile(layout.home, profile, { bundles: [...WEB_PROFILE_BUNDLES, 'dsh-flow'] });
const sourceText = readFileSync(join(resolve(profileSource), 'cordis.patch.yml'), 'utf8');
// Keep editable model rows exactly in the isolated profile; never log their contents.
const sourceRows: unknown = parse(sourceText);
if (!Array.isArray(sourceRows)) throw new Error('Expected a profile patch sequence');
const rows = sourceRows.map(object).filter(row => ['llm-pi-ai', 'agent-default-model', 'agent-preset-registry', 'permission', 'sandbox-policy'].includes(String(row.id)));
const settingsUrlFile = arg('settings-url-file');
if (settingsUrlFile) {
  const authenticatedUrl = readFileSync(resolve(settingsUrlFile), 'utf8').trim();
  const response = await fetch(authenticatedUrl, { redirect: 'manual', signal: networkDeadline() });
  const cookie = response.headers.getSetCookie().map(header => header.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Configured host authentication failed');
  const settings = await fetch(`${new URL(authenticatedUrl).origin}/api/settings/describe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'settings/describe', payload: { args: {} } }), signal: networkDeadline() });
  const result = object(object(await settings.json()).result);
  if (!result.ok) throw new Error('Could not read effective profile settings');
  const namespaces = object(result.value).namespaces;
  if (!Array.isArray(namespaces)) throw new Error('Effective settings response has no namespaces');
  for (const namespace of namespaces.map(object)) {
    if (!['llm-pi-ai', 'agent-default-model'].includes(String(namespace.ns))) continue;
    const existing = rows.findIndex(row => row.id === namespace.ns);
    const row = { id: namespace.ns, config: namespace.value };
    if (existing < 0) rows.push(row); else rows[existing] = row;
  }
}
const providerRow = rows.find(row => row.id === 'llm-pi-ai');
const declared = object(object(providerRow?.config).providers)[provider];
if (!declared) throw new Error('Requested provider is not declared in the source profile');
// Built-in provider catalogs can declare models outside the editable override.
// session/selectModel below is the native authority for this exact route.
const apiKeyEnv = object(declared).apiKeyEnv;
const selectedEnv: Record<string, string> = {};
if (typeof apiKeyEnv === 'string') {
  const credentialFile = resolve(arg('credentials-file') ?? join(resolve(profileSource), '../..', '.credentials.yaml'));
  const credentials = existsSync(credentialFile) ? object(parse(readFileSync(credentialFile, 'utf8'))) : {};
  const refs = object(credentials.refs ?? {});
  if (typeof refs[apiKeyEnv] === 'string' && refs[apiKeyEnv]) {
    // The official provider resolves CredentialRef through ctx.credentials before
    // environment fallback. Copy only this selected reference, never browser auth
    // or another provider record from the user's native store.
    writeFileSync(join(layout.home, '.credentials.yaml'), stringify({ version: 1, refs: { [apiKeyEnv]: refs[apiKeyEnv] } }), { mode: 0o600 });
  } else {
    const key = process.env[apiKeyEnv];
    if (!key) throw new Error(`Required native credential reference is absent: ${apiKeyEnv}`);
    selectedEnv[apiKeyEnv] = key;
  }
}
writeFileSync(join(prepared.dir, 'cordis.patch.yml'), stringify(rows), { mode: 0o600 });
const patch = join(layout.root, 'runtime.patch.yml');
writeFileSync(patch, stringify([
  { id: 'hmr', disabled: true },
  { id: 'dsh-flow', config: { dataDir: layout.data, workspace: layout.workspace, maxConcurrentAgents: 4 } },
]), { mode: 0o600 });
const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace, extra: selectedEnv });
const host = new DshWebHost({ profile, patches: [patch], cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
const started = Date.now();
const fingerprint = () => ({ source: treeHash(join(PLUGIN_ROOT, 'src')), bundle: treeHash(join(PLUGIN_ROOT, 'lib')), harness: treeHash(join(PROJECT_ROOT, 'tests/acceptance')), host: treeHash(join(PROJECT_ROOT, 'src/host')), dependency_lock: hash(readFileSync(join(PROJECT_ROOT, 'pnpm-lock.yaml'))) });
const before = fingerprint();
const report: Record<string, unknown> = { status: 'RUNNING', mode, date: '2026-10-12', started_at: new Date(started).toISOString(), route: { provider, model, reasoningEffort, preset },
  profile_model_config_sha256: hash(stringify(rows)), before, workspace: layout.workspace, timeout_ms: timeoutMs, notes: ['Runner timeout is not a Flow execution limit. No single-Agent performance comparison is claimed by an individual run.'] };
let sessionId: string | undefined;
let settled = false;
const rpc = (method: string, args: unknown) => host.rpc(method, args, deadline);
const prompt = [
  '请完成 2026-10-12 最近已收盘交易日的 A 股复盘。只在当前工作区写文件。',
  '必须实际通过 HTTP 获取公开市场材料，保存原始响应到 raw/，不能把记忆、模拟值或上一份报告当数据。',
  '至少核验上证指数、深证成指、创业板指的收盘点位和涨跌幅，解释当日市场表现；不提供个股交易建议。',
  '写 report.md 和 market-data.json。JSON 格式为 {"date":"2026-10-12","indices":[{"name":"...","close":数值,"change_percent":数值}],"sources":[{"url":"https://...","raw_path":"raw/...","http_status":200,"retrieved_at":"ISO时间","data_date":"2026-10-12"}]}。',
  'report.md 引用真实来源、说明日期和材料覆盖限制。实际打开产物重算/核对JSON，确实完成才说明完成；外部不可访问或日期不符应诚实报告受阻。',
].join('\n');
const teamInstruction = '命令已创建团队与当前主会话持有的根任务。至少委派一项输入已就绪的互补业务，并明确产物负责人；自己继续独立工作。收到成果后亲自用原生工具检查，flow_review 接受当前成员交付；最终检查后用 flow_result complete 完成根任务并正常交付。等待时自然返回，由真实结果消息继续。';
writeFileSync(join(layout.root, 'task.txt'), prompt);
if (mode === 'team') writeFileSync(join(layout.root, 'team-instructions.txt'), teamInstruction);
try {
  await host.start();
  const created = object(await rpc('session/create', { request: { cwd: layout.workspace, agentPreset: preset } }));
  if (typeof created.sessionId !== 'string') throw new Error('Native create did not return a Session identity');
  sessionId = created.sessionId;
  report.owner_session_id = sessionId;
  await rpc('session/selectModel', { request: { sessionId, provider, model, reasoningEffort } });
  if (mode === 'team') {
    await rpc('commands/execute', { agentId: sessionId, line: `/agent-team ${prompt}\n${teamInstruction}`, submittedAttachments: [], submissionId: randomUUID() });
  } else {
    await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: `${prompt}\n本轮由当前普通 Agent 直接完成，不创建 Flow 团队或其他子 Agent。` }], clientTimeZone: 'Asia/Shanghai' } });
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
    const teamTerminal = snapshot && ['completed', 'failed', 'cancelled'].includes(String(object(snapshot.run).state));
    const candidate = ownerCompletion?.settled && (mode === 'ordinary' || teamTerminal)
      ? JSON.stringify({ completion: ownerCompletion, state: snapshot && object(snapshot.run).state }) : '';
    // A terminal marker must still be the latest native Turn after a second
    // public running=false observation. Historical Turn ends are insufficient.
    if (candidate && candidate === stableCompletion) { settled = true; break; }
    stableCompletion = candidate;
    await delay(2000, undefined, { signal: deadline });
  }
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
  report.execution_complete = settled && ownerCompletion?.reason === 'completed' && (mode === 'ordinary' || teamDone && collaborators.length >= 1);
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
    return { structure_passed: data.date === '2026-10-12' && text.includes('2026-10-12') && text.trim().length > 0 && indices.length >= 3 &&
      ['上证','深证','创业板'].every(name => indices.some(index => String(index.name).includes(name) && Number.isFinite(index.close) && Number.isFinite(index.change_percent))) && checked.length > 0 && checked.every(source => source.valid),
      report: reportPath, report_sha256: hash(text), data: dataPath, data_sha256: hash(readFileSync(dataPath)), sources: checked,
      limitation: 'This mechanical check verifies only structured output and locally preserved files. HTTP status/date are model claims until checked against native receipts and raw prices. AWAITING_SOURCE_REVIEW is not task success.' };
  } catch (error) { return { structure_passed: false, reason: error instanceof Error ? error.message : String(error) }; }
}
