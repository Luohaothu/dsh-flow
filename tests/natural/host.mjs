import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'flow-natural-observer';
export const inject = ['flow', 'agents', 'llm', 'sessionController', 'commands'];
const copy = value => JSON.parse(JSON.stringify(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queries = /^(?:flow_(?:team_(?:list|get|read|assignment_read)|assignment_read|material_read|patterns?(?:_list|_read)?|unread|peek|query|wait)|.*(?:_list|_get|_read|_query|_status))$/;

function privateWriter(directory) {
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const artifacts = join(root, '.artifacts');
  const target = resolve(directory);
  const child = relative(artifacts, target);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), 'Proof must be below this workspace .artifacts');
  function verify() {
    let current = artifacts;
    for (const part of ['', ...child.split(sep)]) {
      if (part) current = join(current, part);
      try { const state = lstatSync(current); assert.ok(state.isDirectory() && !state.isSymbolicLink(), 'Proof directories cannot be symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current, { mode: 0o700 }); }
    }
    assert.equal(realpathSync(target), target);
  }
  verify();
  return value => {
    verify();
    const path = join(target, 'evidence.json');
    try { const state = lstatSync(path); assert.ok(state.isFile() && !state.isSymbolicLink(), 'Proof file cannot be a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      verify();
      const opened = fstatSync(fd), current = lstatSync(path);
      assert.ok(opened.isFile() && opened.ino === current.ino && opened.dev === current.dev);
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify(value, null, 2));
    } finally { closeSync(fd); }
  };
}

export function apply(ctx) {
  assert.ok(process.env.NATURAL_SCENARIO_FILE && process.env.NATURAL_PROOF_DIR, 'Scenario and proof paths are required');
  const scenario = JSON.parse(readFileSync(process.env.NATURAL_SCENARIO_FILE, 'utf8'));
  assert.equal(typeof scenario.prompt, 'string');
  assert.ok(scenario.prompt.trim());
  assert.equal(typeof scenario.workspace, 'string');
  assert.ok(scenario.plain === undefined || typeof scenario.plain === 'boolean', 'plain must be a boolean');
  assert.ok(lstatSync(scenario.workspace).isDirectory());
  for (const field of ['maxRequests', 'maxTotalTokens', 'maxDurationMs', 'noProgressMs']) assert.ok(Number.isSafeInteger(scenario[field]) && scenario[field] > 0, `${field} must be a positive integer`);
  if (!scenario.plain) assert.match(scenario.prompt, /^\/agent-team\s+\S/);
  const saveProof = privateWriter(process.env.NATURAL_PROOF_DIR);
  const evidence = { status: 'OBSERVING', observerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), startedAt: Date.now(), prompt: scenario.prompt, workspace: realpathSync(scenario.workspace), limits: { maxRequests: scenario.maxRequests, maxTotalTokens: scenario.maxTotalTokens, maxDurationMs: scenario.maxDurationMs, noProgressMs: scenario.noProgressMs }, requests: [], histories: [], snapshots: [], progress: [] };
  const archived = new Map();
  const seenProgress = new Set();
  let main, timer, stableSince, lastProgressAt = evidence.startedAt, finished = false;
  const save = () => { evidence.updatedAt = Date.now(); saveProof(evidence); };
  const finish = (status, reason, details) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    evidence.status = status;
    evidence.reason = reason;
    evidence.endedAt = Date.now();
    if (details) evidence.error = details;
    save();
    console.log('[Flow natural]', status, reason);
  };
  const totalTokens = () => evidence.requests.reduce((total, request) => total + (request.usage?.totalTokens ?? 0), 0);
  const histories = () => [...new Map([...archived, ...ctx.agents.list().map(agent => [agent.session.id, { sessionId: agent.session.id, status: agent.status, header: copy(agent.session.header), events: copy(agent.session.snapshotEvents()) }])]).values()];
  ctx.on('agent/disposed', ({ agent }) => { archived.set(agent.session.id, { sessionId: agent.session.id, status: 'disposed', header: copy(agent.session.header), events: copy(agent.session.snapshotEvents()) }); });
  ctx.on('dispose', () => { if (!finished) finish('ABORTED', 'host-disposed'); clearInterval(timer); });
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (finished || evidence.requests.length >= scenario.maxRequests || totalTokens() >= scenario.maxTotalTokens) {
      finish('ABORTED', totalTokens() >= scenario.maxTotalTokens ? 'total-token-budget' : 'request-budget');
      throw new Error('Natural observation boundary reached');
    }
    const request = { number: evidence.requests.length + 1, provider: options.provider, model: options.model, startedAt: Date.now(), promptSha256: fingerprint(options.messages), tools: options.tools?.map(tool => tool.name), maxTokens: options.maxTokens, status: 'running' };
    evidence.requests.push(request);
    save();
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') request.usage = copy(chunk.usage);
        if (chunk.type === 'finish') request.finishReason = copy(chunk.reason);
        if (chunk.type === 'text-delta') request.output = (request.output ?? '') + chunk.text;
        yield chunk;
      }
      request.status = request.finishReason?.kind === 'error' ? 'failed' : 'completed';
      if (request.finishReason?.kind === 'error') request.error = request.finishReason.failure?.message ?? 'Provider stream finished with an error';
    } catch (error) {
      request.status = 'failed';
      request.error = String(error?.message ?? error);
      throw error;
    } finally {
      request.endedAt = Date.now();
      evidence.totalReportedTokens = totalTokens();
      evidence.usageMissingRequests = evidence.requests.filter(item => item.status !== 'running' && item.usage?.totalTokens === undefined).map(item => item.number);
      if (totalTokens() >= scenario.maxTotalTokens) finish('ABORTED', 'total-token-budget');
      save();
    }
  })());
  const observe = () => {
    if (finished) return;
    try {
      evidence.histories = histories();
      evidence.registry = copy(ctx.flow.projector.registry());
      evidence.snapshots = evidence.registry.runs.filter(run => run.entry.callerSessionId === evidence.mainSessionId).map(run => copy(ctx.flow.projector.snapshot(run.id)));
      const mainEvents = evidence.histories.find(history => history.sessionId === evidence.mainSessionId)?.events ?? [];
      evidence.skillInvocations = mainEvents.filter(event => event.type === 'user/message' && event.data.source?.kind === 'skill-invocation');
      const semantic = [
        ...evidence.snapshots.flatMap(snapshot => snapshot.assignments.map(assignment => ['assignment', assignment.id, assignment.status, assignment.result, assignment.reason])),
        ...evidence.snapshots.flatMap(snapshot => snapshot.nodes.map(node => ['member', node.id, node.parentId])),
        ...evidence.snapshots.flatMap(snapshot => snapshot.groups.map(group => ['group', group.id, group.members, group.blackboard, group.dissolved])),
      ];
      for (const history of evidence.histories) for (const event of history.events) {
        if (event.type !== 'tool/result' || event.data.message?.isError) continue;
        const call = history.events.find(item => item.type === 'tool/call' && item.data.callId === event.data.message?.toolCallId);
        if (call && !queries.test(call.data.name)) semantic.push(['tool-result', history.sessionId, call.data.name, call.data.arguments, event.data.message.content]);
      }
      for (const item of semantic) {
        const key = fingerprint(item);
        if (seenProgress.has(key)) continue;
        seenProgress.add(key);
        lastProgressAt = Date.now();
        evidence.progress.push({ timestamp: lastProgressAt, kind: item[0], digest: key });
      }
      evidence.lastProgressAt = lastProgressAt;
      const now = Date.now();
      if (now - evidence.startedAt >= scenario.maxDurationMs) return finish('ABORTED', 'duration-limit');
      const runningRequests = evidence.requests.filter(request => request.status === 'running').length;
      if (!runningRequests && now - lastProgressAt >= scenario.noProgressMs) return finish('ABORTED', 'no-progress');
      const relevantIds = new Set([evidence.mainSessionId, ...evidence.snapshots.flatMap(snapshot => snapshot.nodes.map(node => node.sessionID))]);
      const idle = !!main && ctx.agents.list().filter(agent => relevantIds.has(agent.session.id)).every(agent => agent.status === 'idle') && !runningRequests;
      const ended = mainEvents.some(event => event.type === 'turn/end');
      const terminalAssignments = evidence.snapshots.flatMap(snapshot => snapshot.assignments).filter(assignment => assignment.parentAssignmentId === null && assignment.status !== 'pending');
      const readCalls = mainEvents.filter(event => event.type === 'tool/call' && event.data.name === 'flow_team_assignment_read');
      const readback = terminalAssignments.every(assignment => readCalls.some(call => {
        let args;
        try { args = JSON.parse(call.data.arguments); } catch { return false; }
        if (args.assignmentId !== assignment.id) return false;
        return mainEvents.some(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId && !event.data.message.isError && event.data.message.content?.some(part => part.type === 'text' && (() => { try { return JSON.parse(part.text).status === assignment.status; } catch { return false; } })()));
      }));
      const qualifying = idle && ended && (scenario.plain || terminalAssignments.length > 0 && readback && evidence.snapshots.every(snapshot => snapshot.assignments.every(assignment => assignment.status !== 'pending')));
      stableSince = qualifying ? stableSince ?? now : undefined;
      evidence.observation = { idle, ended, runningRequests, terminalAssignments: terminalAssignments.map(assignment => assignment.id), readback, stableSince };
      save();
      if (stableSince !== undefined && now - stableSince >= 3000) finish('SETTLED', scenario.plain ? 'plain-main-ended' : 'terminal-assignments-read-back');
    } catch (error) { finish('ERROR', 'observer-error', String(error?.stack ?? error)); }
  };
  void (async () => {
    const profile = createRequire(join(process.env.DSH_HOME, 'profiles', process.env.NATURAL_PROFILE_NAME ?? 'web', 'package.json'));
    const installAnchor = ctx.get('profileContext')?.installAnchor;
    assert.equal(typeof installAnchor, 'string', 'Official app boot must expose the install anchor');
    const installation = createRequire(installAnchor);
    const flowRequire = createRequire(profile.resolve('dsh-flow/package.json'));
    evidence.installAnchor = installAnchor;
    evidence.flowPackage = realpathSync(profile.resolve('dsh-flow/package.json'));
    evidence.sdkOwners = {};
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-app-boot']) {
      const owner = realpathSync(installation.resolve(name + '/package.json'));
      assert.equal(realpathSync(profile.resolve(name + '/package.json')), owner, `${name} profile SDK owner differs`);
      assert.equal(realpathSync(flowRequire.resolve(name + '/package.json')), owner, `${name} Flow SDK owner differs`);
      evidence.sdkOwners[name] = owner;
    }
    const created = await ctx.sessionController.create({ cwd: evidence.workspace });
    evidence.mainSessionId = created.sessionId;
    const resolved = await ctx.sessionController.resolveAgent(created.sessionId);
    if ('error' in resolved) throw resolved.error;
    main = resolved.agent;
    evidence.dashboardAddress = ctx.flow.dashboardAddress;
    evidence.startedAt = Date.now();
    lastProgressAt = evidence.startedAt;
    timer = setInterval(observe, 500);
    timer.unref();
    save();
    evidence.commandResult = scenario.plain
      ? await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: scenario.prompt }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal)
      : await ctx.commands.execute(main, scenario.prompt, [], new AbortController().signal);
    observe();
    if (!scenario.plain && evidence.commandResult?.result?.kind === 'error') finish('ERROR', 'command-rejected', evidence.commandResult.result.text);
  })().catch(error => finish('ERROR', 'initialization-error', String(error?.stack ?? error)));
}
