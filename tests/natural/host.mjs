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

function nativeQuestionHistory(events) {
  const questions = [], boundaries = [], seen = new Set();
  let timed = false;
  const payload = content => {
    for (const block of content ?? []) {
      if (block.type !== 'text') continue;
      try { const value = JSON.parse(block.text); if (value && typeof value === 'object') return value; } catch {}
    }
  };
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (event.type === 'request/header') timed = event.data.header.tools?.some(tool => tool.name === 'ask_user_question' && Object.hasOwn(tool.parameters?.properties ?? {}, 'timeout')) ?? false;
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') questions.push({ seq: event.seq, time: event.time, callId: event.data.callId, call: copy(event.data), mode: timed ? 'timed' : 'legacy', state: 'pending' });
    if (event.type === 'tool/result') {
      const message = event.data.message;
      const question = questions.findLast(item => item.callId === message?.toolCallId && item.seq < event.seq && item.resultSeq === undefined && (!event.sourceEventSeqs?.length || event.sourceEventSeqs.includes(item.seq)));
      if (!question) continue;
      question.resultSeq = event.seq;
      question.result = copy(event.data);
      const value = payload(message.content);
      const failed = message.isError === true || event.data.error !== undefined;
      const continued = !failed && value?.pending === true || question.mode === 'timed' && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN';
      question.state = continued ? 'pending' : failed ? 'failed' : Array.isArray(value?.answers) ? 'answered' : 'returned';
      boundaries.push({ kind: 'question-result', seq: event.seq, time: event.time, callId: question.callId, callSeq: question.seq, outcome: question.state, result: copy(event.data) });
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'user-question-reply') {
      const question = questions.findLast(item => item.callId === event.data.source.callId && item.seq < event.seq && item.state === 'pending');
      if (!question) continue;
      question.replySeq = event.seq;
      question.reply = copy(event.data);
      question.state = event.data.source.outcome === 'answered' ? 'answered' : 'returned';
      boundaries.push({ kind: 'question-reply', seq: event.seq, time: event.time, callId: question.callId, callSeq: question.seq, outcome: question.state, reply: copy(event.data) });
    }
  }
  return { questions, boundaries };
}

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
  const write = value => {
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
  const readFinishRequest = () => {
    verify();
    const path = join(target, 'finish-request.json');
    try { const state = lstatSync(path); assert.ok(state.isFile() && !state.isSymbolicLink(), 'Finish request must be a regular file'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      verify();
      const opened = fstatSync(fd), current = lstatSync(path);
      assert.ok(opened.isFile());
      if (opened.ino !== current.ino || opened.dev !== current.dev) return;
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.deepEqual(Object.keys(value).sort(), ['afterUserSeq', 'sessionId']);
      assert.ok(typeof value.sessionId === 'string' && value.sessionId && Number.isSafeInteger(value.afterUserSeq) && value.afterUserSeq > 0, 'Finish request needs a session and input boundary sequence');
      return value;
    } finally { closeSync(fd); }
  };
  return { write, readFinishRequest };
}

export function apply(ctx) {
  assert.ok(process.env.NATURAL_SCENARIO_FILE && process.env.NATURAL_PROOF_DIR, 'Scenario and proof paths are required');
  const scenario = JSON.parse(readFileSync(process.env.NATURAL_SCENARIO_FILE, 'utf8'));
  assert.ok(scenario.plain === undefined || typeof scenario.plain === 'boolean', 'plain must be a boolean');
  assert.ok(scenario.completion === undefined || ['auto', 'operator'].includes(scenario.completion), 'Unknown completion boundary');
  const operator = scenario.completion === 'operator';
  const inputs = scenario.mains ?? [scenario];
  assert.ok(Array.isArray(inputs) && inputs.length > 0, 'mains must be a nonempty array');
  const mains = inputs.map((input, index) => {
    assert.ok(input && typeof input === 'object');
    assert.ok(typeof input.prompt === 'string' && input.prompt.trim(), 'A natural prompt is required');
    assert.equal(typeof input.workspace, 'string');
    assert.ok(lstatSync(input.workspace).isDirectory());
    if (!scenario.plain) assert.match(input.prompt, /^\/agent-team\s+\S/);
    const userPrompts = input.userPrompts ?? [input.prompt];
    assert.ok(Array.isArray(userPrompts) && userPrompts.length > 0 && userPrompts.every(prompt => typeof prompt === 'string' && prompt.trim()), 'userPrompts must contain nonempty inputs');
    assert.equal(userPrompts[0], input.prompt, 'The first user prompt must equal prompt');
    const userTurnBoundary = input.userTurnBoundary ?? scenario.userTurnBoundary ?? (scenario.plain ? 'main-idle' : 'task-complete');
    assert.ok(['main-idle', 'task-complete'].includes(userTurnBoundary), 'Unknown user turn boundary');
    const requireNewTerminalAfterUserWait = input.requireNewTerminalAfterUserWait ?? scenario.requireNewTerminalAfterUserWait ?? false;
    assert.equal(typeof requireNewTerminalAfterUserWait, 'boolean');
    return { record: { index, workspace: realpathSync(input.workspace), prompt: input.prompt, userPrompts, userTurnBoundary, requireNewTerminalAfterUserWait, userTimeline: [], actualUserTimeline: [], questionTimeline: [], inputBoundaryTimeline: [], checkpoints: [], awaitingUser: false }, agent: undefined, inputBoundaryCount: 0 };
  });
  for (const field of ['maxRequests', 'maxTotalTokens', 'maxDurationMs', 'noProgressMs']) assert.ok(Number.isSafeInteger(scenario[field]) && scenario[field] > 0, `${field} must be a positive integer`);
  const proof = privateWriter(process.env.NATURAL_PROOF_DIR);
  const first = mains[0].record;
  const evidence = { status: 'OBSERVING', observerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), startedAt: Date.now(), prompt: first.prompt, userPrompts: first.userPrompts, userTimeline: [], checkpoints: [], awaitingUser: false, workspace: first.workspace, completion: operator ? 'operator' : 'auto', mains: mains.map(main => main.record), operatorRequests: [], limits: { maxRequests: scenario.maxRequests, maxTotalTokens: scenario.maxTotalTokens, maxDurationMs: scenario.maxDurationMs, noProgressMs: scenario.noProgressMs }, requests: [], histories: [], snapshots: [], progress: [] };
  const archived = new Map(), operatorRequests = new Map(), seenProgress = new Set();
  let timer, stableSince, lastProgressAt = evidence.startedAt, finished = false;
  const save = () => { evidence.updatedAt = Date.now(); proof.write(evidence); };
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
    const request = { number: evidence.requests.length + 1, sessionId: options.sessionId, provider: options.provider, model: options.model, startedAt: Date.now(), promptSha256: fingerprint(options.messages), tools: options.tools?.map(tool => tool.name), maxTokens: options.maxTokens, status: 'running' };
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
  const readBack = (assignment, events, afterUserSeq = -1) => events.some(call => {
    if (call.type !== 'tool/call' || call.data.name !== 'flow_team_assignment_read' || call.seq <= afterUserSeq) return false;
    let args;
    try { args = JSON.parse(call.data.arguments); } catch { return false; }
    if (args.assignmentId !== assignment.id) return false;
    return events.some(event => event.type === 'tool/result' && event.seq > call.seq && event.data.message?.toolCallId === call.data.callId && !event.data.message.isError && event.data.message.content?.some(part => {
      if (part.type !== 'text') return false;
      try { const value = JSON.parse(part.text); return value.id === assignment.id && value.runId === assignment.runId && value.status === assignment.status; }
      catch { return false; }
    }));
  });
  const observe = () => {
    if (finished) return;
    try {
      evidence.histories = histories();
      evidence.registry = copy(ctx.flow.projector.registry());
      const mainIds = new Set(mains.map(main => main.record.sessionId));
      const ownedRuns = evidence.registry.runs.filter(run => mainIds.has(run.entry.callerSessionId));
      const projections = ownedRuns.map(run => ({ owner: run.entry.callerSessionId, id: run.id, snapshot: copy(ctx.flow.projector.snapshot(run.id)) }));
      evidence.snapshots = projections.map(projection => projection.snapshot);
      const now = Date.now();
      if (now - evidence.startedAt >= scenario.maxDurationMs) return finish('ABORTED', 'duration-limit');
      const runningRequests = evidence.requests.filter(request => request.status === 'running').length;
      const activeAgents = ctx.agents.list();
      for (const main of mains) {
        const record = main.record;
        const events = evidence.histories.find(history => history.sessionId === record.sessionId)?.events ?? [];
        const seen = new Set();
        const users = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user' && !seen.has(event.seq) && seen.add(event.seq));
        const matched = [];
        for (const event of users) {
          const prompt = record.userPrompts[matched.length];
          if (prompt !== undefined && event.data.content?.some(block => block.type === 'text' && block.text === prompt)) matched.push({ index: matched.length, seq: event.seq, time: event.time, prompt });
        }
        record.actualUserTimeline = users.map((event, index) => ({ index, seq: event.seq, time: event.time, content: copy(event.data.content), prompt: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }));
        const questionHistory = nativeQuestionHistory(events);
        record.questionTimeline = questionHistory.questions;
        record.inputBoundaryTimeline = [...record.actualUserTimeline.map(user => ({ kind: 'user-message', ...user })), ...questionHistory.boundaries].sort((a, b) => a.seq - b.seq);
        record.userTimeline = operator ? record.actualUserTimeline : matched;
        record.skillInvocations = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'skill-invocation');
        const owned = projections.filter(projection => projection.owner === record.sessionId);
        const snapshots = owned.map(projection => projection.snapshot);
        record.runIds = owned.map(projection => projection.id);
        const relevantIds = new Set([record.sessionId, ...snapshots.flatMap(snapshot => snapshot.nodes.map(node => node.sessionID))]);
        const idle = !!main.agent && activeAgents.filter(agent => relevantIds.has(agent.session.id)).every(agent => agent.status === 'idle') && !runningRequests;
        const lastActualUserSeq = record.actualUserTimeline.at(-1)?.seq;
        const lastUserSeq = record.userTimeline.at(-1)?.seq;
        const lastInputSeq = operator ? record.inputBoundaryTimeline.at(-1)?.seq : lastActualUserSeq;
        const pendingQuestions = operator ? record.questionTimeline.filter(question => question.state === 'pending').map(question => question.callId) : [];
        const ended = lastInputSeq !== undefined && events.some(event => event.type === 'turn/end' && event.seq > lastInputSeq);
        const terminalAssignments = snapshots.flatMap(snapshot => snapshot.assignments).filter(assignment => assignment.parentAssignmentId === null && assignment.status !== 'pending');
        const readback = terminalAssignments.every(assignment => readBack(assignment, events));
        const taskComplete = terminalAssignments.length > 0 && readback && snapshots.every(snapshot => snapshot.assignments.every(assignment => assignment.status !== 'pending'));
        const previousUserSeq = record.userTimeline.at(-2)?.seq;
        const checkpoint = record.checkpoints.findLast(value => value.userEventSeq === previousUserSeq && value.taskComplete && value.sequential);
        const sequential = !record.requireNewTerminalAfterUserWait || previousUserSeq === undefined || !!checkpoint && terminalAssignments.some(assignment => !checkpoint.terminalAssignmentIds.includes(assignment.id) && readBack(assignment, events, lastUserSeq));
        record.observation = { idle, ended, runningRequests, lastInputSeq, pendingQuestions, matchedUserPrompts: matched.length, expectedUserPrompts: record.userPrompts.length, terminalAssignments: terminalAssignments.map(assignment => assignment.id), readback, taskComplete, sequential, sequentialBaselineMissing: record.requireNewTerminalAfterUserWait && previousUserSeq !== undefined && !checkpoint };
        const inputBoundaryCount = operator ? record.inputBoundaryTimeline.length : users.length;
        if (inputBoundaryCount !== main.inputBoundaryCount || record.awaitingUser && !(pendingQuestions.length || idle && ended)) lastProgressAt = now;
        main.inputBoundaryCount = inputBoundaryCount;
      }
      if (operator) {
        const request = proof.readFinishRequest();
        if (request) {
          const owner = mains.find(main => main.record.sessionId === request.sessionId)?.record;
          assert.ok(owner?.inputBoundaryTimeline.some(input => input.seq === request.afterUserSeq), 'Finish request must reference an observed input boundary');
          const key = `${request.sessionId}:${request.afterUserSeq}`;
          if (!evidence.operatorRequests.some(item => item.key === key)) evidence.operatorRequests.push({ key, ...request, observedAt: now });
          operatorRequests.set(request.sessionId, request);
        }
      }
      for (const main of mains) {
        const record = main.record, observation = record.observation;
        const lastUserSeq = record.userTimeline.at(-1)?.seq;
        const request = operatorRequests.get(record.sessionId);
        const operatorFinished = !!request && request.afterUserSeq === observation.lastInputSeq && observation.pendingQuestions.length === 0;
        const inputsReceived = operator ? observation.matchedUserPrompts > 0 && operatorFinished : observation.matchedUserPrompts === record.userPrompts.length;
        const previouslyAwaiting = record.awaitingUser;
        record.awaitingUser = !inputsReceived && record.userTimeline.length > 0 && (observation.pendingQuestions.length > 0 || observation.idle && observation.ended && (record.userTurnBoundary === 'main-idle' || observation.taskComplete && observation.sequential));
        if (previouslyAwaiting && !record.awaitingUser) lastProgressAt = now;
        if (record.awaitingUser && observation.pendingQuestions.length === 0 && !record.checkpoints.some(checkpoint => checkpoint.lastInputSeq === observation.lastInputSeq)) record.checkpoints.push({ afterPromptCount: record.userTimeline.length, userEventSeq: lastUserSeq, lastInputSeq: observation.lastInputSeq, lastActualUserSeq: record.actualUserTimeline.at(-1)?.seq, observedAt: now, taskComplete: observation.taskComplete, sequential: observation.sequential, terminalAssignmentIds: [...observation.terminalAssignments] });
        observation.awaitingUser = record.awaitingUser;
        observation.operatorFinished = operator ? operatorFinished : undefined;
        observation.qualifying = inputsReceived && observation.idle && observation.ended && observation.sequential && (scenario.plain || observation.taskComplete);
      }
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
        lastProgressAt = now;
        evidence.progress.push({ timestamp: now, kind: item[0], digest: key });
      }
      evidence.userTimeline = first.userTimeline;
      evidence.actualUserTimeline = first.actualUserTimeline;
      evidence.questionTimeline = first.questionTimeline;
      evidence.inputBoundaryTimeline = first.inputBoundaryTimeline;
      evidence.skillInvocations = first.skillInvocations;
      evidence.checkpoints = mains.flatMap(main => main.record.checkpoints.map(checkpoint => ({ sessionId: main.record.sessionId, ...checkpoint })));
      evidence.awaitingUser = mains.some(main => main.record.awaitingUser) && mains.every(main => main.record.awaitingUser || main.record.observation.qualifying);
      evidence.lastProgressAt = lastProgressAt;
      if (!evidence.awaitingUser && !runningRequests && now - lastProgressAt >= scenario.noProgressMs) return finish('ABORTED', 'no-progress');
      const qualifying = mains.every(main => main.record.observation.qualifying);
      stableSince = qualifying ? stableSince ?? now : undefined;
      evidence.observation = mains.length === 1 ? { ...first.observation, stableSince } : { idle: mains.every(main => main.record.observation.idle), ended: mains.every(main => main.record.observation.ended), runningRequests, awaitingUser: evidence.awaitingUser, stableSince };
      save();
      if (stableSince !== undefined && now - stableSince >= 3000) finish('SETTLED', operator ? 'operator-finish-after-terminal-readback' : scenario.plain ? 'plain-main-ended' : 'terminal-assignments-read-back');
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
    for (const main of mains) {
      const created = await ctx.sessionController.create({ cwd: main.record.workspace });
      const resolved = await ctx.sessionController.resolveAgent(created.sessionId);
      if ('error' in resolved) throw resolved.error;
      assert.equal(realpathSync(resolved.agent.session.header.cwd), main.record.workspace, 'Main session working directory differs');
      main.agent = resolved.agent;
      main.record.sessionId = created.sessionId;
    }
    assert.equal(new Set(mains.map(main => main.record.sessionId)).size, mains.length, 'Main sessions must have distinct identities');
    evidence.mainSessionId = first.sessionId;
    evidence.dashboardAddress = ctx.flow.dashboardAddress;
    evidence.startedAt = Date.now();
    lastProgressAt = evidence.startedAt;
    timer = setInterval(observe, 500);
    timer.unref();
    save();
    await Promise.all(mains.map(async main => {
      const record = main.record;
      record.commandResult = scenario.plain
        ? await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: record.sessionId, mode: 'queue', content: [{ type: 'text', text: record.prompt }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal)
        : await ctx.commands.execute(main.agent, record.prompt, [], new AbortController().signal);
      if (!scenario.plain && (!record.commandResult || record.commandResult.result?.kind === 'error')) throw new Error(record.commandResult?.result?.text ?? 'Natural skill entry was not recognized');
    }));
    evidence.commandResult = first.commandResult;
    observe();
  })().catch(error => finish('ERROR', 'initialization-error', String(error?.stack ?? error)));
}
