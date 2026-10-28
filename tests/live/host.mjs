import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, openSync, closeSync, fstatSync, ftruncateSync, constants } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
export const name = 'flow-live-acceptance';
export const inject = ['flow', 'agents', 'llm', 'tools', 'systemPrompt', 'sessionQuery', 'typertGateway'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => JSON.parse(JSON.stringify(value));
const phases = ['probe', 'resume-probe', 'herb', 'single', 'main', 'restart'];
const outputNames = ['evidence.json', 'handoff.json', 'ui-ready.json', 'restart-ui-ready.json', ...phases.map(phase => phase + '-evidence.json')];
function projectRoot() {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === 'dsh-flow-workspace') return realpathSync(directory);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Live fixture must run inside its dsh-flow workspace');
        directory = parent;
    }
}
export function createProofWriter(input) {
    const artifacts = join(projectRoot(), '.artifacts'), directory = resolve(input), path = relative(artifacts, directory);
    assert.ok(path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path), 'Live proof must stay below this project/.artifacts');
    assert.ok(constants.O_NOFOLLOW, 'Live proof writes require O_NOFOLLOW');
    const directories = () => {
        let current = artifacts;
        for (const part of ['', ...path.split(sep)]) {
            if (part) current = join(current, part);
            let state;
            try { state = lstatSync(current); }
            catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current); state = lstatSync(current); }
            assert.ok(state.isDirectory() && !state.isSymbolicLink(), 'Live proof directories cannot be symlinks');
        }
        assert.equal(realpathSync(directory), directory, 'Live proof directory escaped its private root');
    };
    const leaf = name => {
        assert.ok(outputNames.includes(name), 'Unknown live proof output');
        const target = join(directory, name);
        try { const state = lstatSync(target); assert.ok(state.isFile() && !state.isSymbolicLink(), 'Live proof files cannot be symlinks'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return target;
    };
    directories();
    for (const name of outputNames) leaf(name);
    return (name, content) => {
        directories();
        const target = leaf(name), fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
        try {
            directories();
            leaf(name);
            const opened = fstatSync(fd), current = lstatSync(target);
            assert.ok(opened.isFile() && opened.dev === current.dev && opened.ino === current.ino, 'Live proof output identity changed');
            ftruncateSync(fd, 0);
            writeFileSync(fd, content);
        } finally { closeSync(fd); }
    };
}
export function apply(ctx) {
    let createUserMessage, SessionId;
    const directory = process.env.P7_PROOF_DIR;
    if (!directory)
        throw new Error('P7_PROOF_DIR is required');
    const writeProof = createProofWriter(directory);
    const evidence = { status: 'RUNNING', phase: process.env.P7_PHASE ?? 'probe', model: process.env.P7_LIVE_MODEL ?? 'Qwen3.8-27B-4bit', provider: 'p7-local', requests: [], captures: [], scenarios: [] };
    assert.ok(phases.includes(evidence.phase), 'Unknown live phase');
    evidence.hostSourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
    const save = () => writeProof('evidence.json', JSON.stringify(evidence, null, 2));
    const progress = (stage, data = {}) => { evidence.stage = stage; evidence.updatedAt = new Date().toISOString(); Object.assign(evidence, data); save(); console.log('[P7 live]', stage); };
    const captures = new Map(), gates = new Map(), selectedTools = new Map();
    const archivedHistories = new Map();
    ctx.on('agent/disposed', ({ agent }) => { archivedHistories.set(agent.session.id, { sessionId: agent.session.id, status: 'disposed', events: agent.session.snapshotEvents() }); });
    const histories = () => [...new Map([...archivedHistories, ...ctx.agents.list().map(agent => [agent.session.id, { sessionId: agent.session.id, status: agent.status, events: agent.session.snapshotEvents() }])]).values()];
    const diagnosticTimer = setInterval(() => { evidence.histories = histories(); save(); }, 1000);
    diagnosticTimer.unref();
    ctx.on('dispose', () => clearInterval(diagnosticTimer));
    ctx.tools.register({ name: 'p7_capture', description: 'Save the requested live-test observation and end this turn. This never submits or changes any Flow assignment.', parameters: { type: 'object', properties: { stage: { type: 'string' }, value: {} }, required: ['stage', 'value'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute(args, exec) {
            const item = { stage: args.stage, value: json(args.value), sessionId: exec.agent?.session.id, callId: exec.callId, timestamp: Date.now() };
            evidence.captures.push(item);
            captures.set(args.stage, item);
            save();
            exec.concludeTurn();
            return { saved: args.stage };
        } });
    ctx.tools.register({ name: 'p7_gate', description: 'Wait at a cooperative live-test gate until the harness releases it. Do not call unless explicitly instructed.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute(args, exec) {
            await new Promise((resolve, reject) => {
                const done = () => { exec.signal.removeEventListener('abort', abort); resolve(); };
                const abort = () => { gates.delete(args.key); reject(exec.signal.reason ?? new Error('Gate cancelled')); };
                gates.set(args.key, { release: done, sessionId: exec.agent?.session.id });
                exec.signal.addEventListener('abort', abort, { once: true });
                if (exec.signal.aborted)
                    abort();
            });
            gates.delete(args.key);
            exec.concludeTurn();
            return { released: args.key };
        } });
    ctx.on('agent/created', ({ agent }) => {
        agent.ctx.tools.presentAs('native');
        agent.ctx.on('system-prompt/assemble', assembly => { const allowed = selectedTools.get(agent.session.id) ?? (assembly.tools.some(tool => tool.name === 'flow_unread') ? ['flow_unread', 'p7_capture'] : ['flow_team_assignment_read', 'p7_capture']); return { ...assembly, tools: assembly.tools.filter(tool => allowed.includes(tool.name)) }; });
        agent.ctx.tools.restrict({ allow: ['p7_capture', 'p7_gate'] });
        agent.ctx.systemPrompt.section({ name: 'p7-live-protocol', order: 30000, text: 'This is a controlled live integration run using real tools. Follow the latest explicit command literally. For an unsolicited Flow mailbox notification: call flow_unread to read it, then p7_capture with stage="received" and value="ready"; do not submit or delegate unless explicitly instructed. For a user message containing query="flow_team_assignment_read", call that tool using the runId and assignmentId in the message, then p7_capture stage="outcome-"+assignmentId, value={status:the returned status,result:the returned result or null}. Never invent a tool result. Never call file, shell, installation or model settings tools. Keep all text very short.' });
    });
    ctx.on('llm/stream', (options, next) => (async function* () {
        if (evidence.requests.length >= Number(process.env.P7_MAX_REQUESTS ?? 120))
            throw new Error('Live model request budget exceeded');
        const item = { promptSha256: createHash('sha256').update(JSON.stringify(options.messages)).digest('hex'), number: evidence.requests.length + 1, provider: options.provider, model: options.model, maxTokens: options.maxTokens, startedAt: Date.now(), messages: options.messages?.length, tools: options.tools?.map(tool => tool.name) };
        if (options.messages?.length === 1 && !options.tools?.length)
            item.auxiliaryInput = json(options.messages);
        evidence.requests.push(item);
        save();
        try {
            for await (const chunk of next()) {
                if (chunk.type === 'usage')
                    item.usage = json(chunk.usage);
                if (chunk.type === 'text-delta')
                    item.output = (item.output ?? '') + chunk.text;
                if (chunk.type === 'block-end' && chunk.block.type === 'text')
                    (item.textBlocks ??= []).push(chunk.block.text);
                if (chunk.type === 'finish')
                    item.finishReason = json(chunk.reason);
                yield chunk;
            }
            item.status = 'completed';
        }
        catch (error) {
            item.status = 'failed';
            item.error = error.message;
            throw error;
        }
        finally {
            item.endedAt = Date.now();
            save();
        }
    })());
    const wait = async (predicate, label, timeout = 90000) => {
        const end = Date.now() + timeout;
        while (!predicate()) {
            const errorEvent = ctx.agents.list().flatMap(agent => agent.session.snapshotEvents()).find(event => event.type === 'turn/end' && event.data.reason?.kind === 'error');
            if (errorEvent && errorEvent.data.reason.error?.code !== 'ABORTED')
                throw new Error(JSON.stringify(errorEvent.data.reason));
            if (Date.now() > end)
                throw new Error(`Deadline waiting for ${label}`);
            await pause(25);
        }
    };
    const send = (native, text) => native.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
    const command = async (native, tool, args, label, capture = '{ok:true}', expectedError = false) => {
        progress(label);
        selectedTools.set(native.session.id, [tool, 'p7_capture']);
        const before = native.session.snapshotEvents().length;
        send(native, `Execute exactly this tool: ${tool} with JSON arguments ${JSON.stringify(args)}. After its real result, call p7_capture with stage ${JSON.stringify(label)} and value ${capture}. Do not modify the arguments or use unrelated tools.`);
        await wait(() => captures.has(label), label);
        await native.whenIdle();
        selectedTools.delete(native.session.id);
        const events = native.session.snapshotEvents().slice(before);
        const call = events.find(event => event.type === 'tool/call' && event.data.name === tool);
        assert.ok(call, `${label}: real tool call missing`);
        const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
        assert.ok(result, `${label}: real durable tool result missing`);
        assert.equal(result.data.message.isError, expectedError, JSON.stringify(result));
        const text = result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        return { value: expectedError ? { error: text } : JSON.parse(text), call, result, capture: captures.get(label) };
    };
    void (async () => {
        const profile = createRequire(join(process.env.DSH_HOME, 'profiles/' + (process.env.P7_PROFILE_NAME ?? 'web') + '/package.json'));
        const installAnchor = ctx.get('profileContext')?.installAnchor;
        assert.equal(typeof installAnchor, 'string', 'Official app boot must expose its installation anchor');
        const installation = createRequire(installAnchor);
        const flowPackage = profile.resolve('dsh-flow/package.json');
        const flowRequire = createRequire(flowPackage);
        evidence.installAnchor = installAnchor;
        evidence.flowPackage = realpathSync(flowPackage);
        evidence.sdkOwners = {};
        evidence.ownerResolution = {};
        for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-app-boot']) {
            const fromProfile = realpathSync(profile.resolve(name + '/package.json'));
            const fromInstallation = realpathSync(installation.resolve(name + '/package.json'));
            const fromFlow = realpathSync(flowRequire.resolve(name + '/package.json'));
            assert.equal(fromProfile, fromInstallation, name + ' must have one matching SDK owner');
            assert.equal(fromFlow, fromInstallation, name + ' Flow peer must use the installation SDK owner');
            evidence.sdkOwners[name] = fromProfile;
            evidence.ownerResolution[name] = { profile: fromProfile, installation: fromInstallation, flow: fromFlow };
        }
        ({ createUserMessage } = await import(pathToFileURL(profile.resolve('@deepseek-ai/dsh-llm'))));
        ({ SessionId } = await import(pathToFileURL(profile.resolve('@deepseek-ai/dsh-session/types'))));
        const core = await import(pathToFileURL(profile.resolve('dsh-flow/core')));
        const patterns = await import(pathToFileURL(profile.resolve('dsh-flow/patterns')));
        const flow = ctx.flow;
        const resolved = await ctx.llm.resolveCallConfig({ provider: 'p7-local', model: evidence.model, reasoningEffort: 'off', maxTokens: 1024 });
        evidence.resolvedModel = resolved;
        save();
        const handoffPath = join(directory, 'handoff.json');
        const restarted = evidence.phase === 'restart';
        const prior = restarted ? JSON.parse(readFileSync(handoffPath, 'utf8')) : undefined;
        const options = { agentOptions: { provider: 'p7-local', model: evidence.model, reasoningEffort: 'off', maxTokens: 1024 } };
        const created = restarted ? await ctx.agents.resume({ ...options, resumeSessionId: SessionId(prior.mainSessionId) }) : await ctx.agents.create({ ...options, sessionId: SessionId(randomUUID()), meta: { cwd: process.env.DSH_HOME } });
        const main = created.agent;
        evidence.mainSessionId = main.session.id;
        const origin = flow.bridge.createOrigin(main);
        const sid = agent => agent.getProfile().sessionID;
        const native = agent => flow.bridge.bindings.get(agent).native;
        const snapshot = run => flow.projector.snapshot(run.id);
        const node = (run, agent) => snapshot(run).nodes.find(node => node.sessionID === sid(agent) && node.status !== 'terminated');
        const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
        const spec = (name, resultSchema) => ({ name, type: 'live acceptance', background: 'Controlled real-model runtime validation.', requirements: 'Read the assignment with flow_unread and capture ready. Wait for the next explicit harness command before dispatching or submitting.', acceptanceCriteria: 'Submit only through the real Flow tools with the supplied schema.', resultSchema });
        const active = async (run) => { await wait(() => run.status !== 'starting', 'Run active'); assert.equal(run.status, 'active'); return run; };
        const top = async (run, task, label) => { const out = await command(main, 'flow_team_assign', { runId: run.id, spec: task, requestId: label }, label); await native(run.root).whenIdle(); return out.value; };
        const delegate = async (run, parent, recipient, parentId, task, label) => { const out = await command(native(parent), 'flow_assign', { recipientSessionID: sid(recipient), parentAssignmentId: parentId, spec: task, requestId: label }, label); await native(recipient).whenIdle(); return out.value; };
        const submit = async (actor, id, result, label) => command(native(actor), 'flow_submit', { assignmentId: id, result, continuingChildren: [] }, label);
        const read = async (actor, id, label) => command(native(actor), 'flow_assignment_read', { assignmentId: id }, label, '{status:the returned status,result:the returned result or null}');
        const verifyOutcome = async (id, result) => { await main.whenIdle(); const records = main.session.snapshotEvents(); const call = records.find(event => event.type === 'tool/call' && event.data.name === 'flow_team_assignment_read' && JSON.parse(event.data.arguments).assignmentId === id); assert.ok(call, 'Main did not read the notified assignment with its real tool'); const response = records.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId); assert.ok(response && !response.data.message.isError); const actual = JSON.parse(response.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')); assert.equal(actual.status, 'submitted'); assert.deepEqual(actual.result, result); const saved = evidence.captures.find(item => item.sessionId === main.session.id && item.timestamp >= response.time && isDeepStrictEqual(item.value, { status: 'submitted', result })); assert.ok(saved, 'Main did not save the actual read result'); return saved; };
        const realGate = async (agent, key) => { selectedTools.set(agent.session.id, ['p7_gate', 'p7_capture']); send(agent, `Call p7_gate with {"key":${JSON.stringify(key)}}. The gate ends this turn; do not call another tool.`); await wait(() => gates.has(key), 'real model gate ' + key); };
        const releaseGate = key => { const gate = gates.get(key); if (gate) {
            selectedTools.delete(gate.sessionId);
            gate.release();
        } };
        const finish = async (status) => { evidence.histories = histories(); evidence.status = status; save(); writeProof(evidence.phase + '-evidence.json', JSON.stringify(evidence, null, 2)); };
        if (evidence.phase === 'probe') {
            const probe = await command(main, 'p7_capture', { stage: 'provider-probe', value: { sum: 5 } }, 'provider-probe', '{sum:5}');
            assert.deepEqual(probe.capture.value, { sum: 5 });
            await created.dispose();
            await finish('PROBE_PASS');
            progress('provider-probe-complete');
            return;
        }
        if (evidence.phase === 'resume-probe') {
            const run = await active(flow.runs.create(origin, {}, 'cold-probe'));
            const old = await core.Agent.create(run.context, { ...run.root.getProfile(), sessionID: randomUUID(), name: 'cold-probe-member' }, run.root);
            const oldId = node(run, old).id, sessionId = sid(old);
            await old.recvSignal('SIGTERM');
            await command(native(run.root), 'flow_resume', { sessionID: sessionId }, 'probe-real-cold-resume');
            const restored = run.root.getChildren().find(agent => sid(agent) === sessionId);
            assert.ok(restored);
            assert.notEqual(node(run, restored).id, oldId);
            evidence.resumeProbe = { oldInstance: oldId, newInstance: node(run, restored).id, sessionId, explicitCleanupBeforeResume: true };
            await flow.runs.release(origin, run);
            await created.dispose();
            await finish('PASS');
            return;
        }
        if (evidence.phase === 'herb') {
            progress('herb-real-source-histories');
            const run = await active(flow.runs.create(origin, {}, 'herb-semantic-team'));
            const base = { ...run.root.getProfile(), params: { ...run.root.getProfile().params, maxTokens: 1024 } };
            const a = await core.Agent.create(run.context, { ...base, sessionID: randomUUID(), name: 'SourceAlpha', role: 'SourceAlpha preserves its own facts and unresolved constraints.' }, run.root);
            const b = await core.Agent.create(run.context, { ...base, sessionID: randomUUID(), name: 'SourceBeta', role: 'SourceBeta preserves its own facts and unresolved constraints.' }, run.root);
            send(native(a), 'Preserve these actual source facts. SourceAlpha owns BUDGET_MAX_40 (budget ceiling 40 USD), OFFLINE_ONLY, KAFKA_REQUIRED. Unfinished approval PENDING_ADA. Repeat those facts in one short sentence without tools. Do not resolve any conflict with another source.');
            await native(a).whenIdle();
            send(native(b), 'Preserve these actual source facts. SourceBeta owns BUDGET_MIN_80 (budget floor 80 USD), INTERNET_REQUIRED, KAFKA_PROHIBITED. Unfinished approval PENDING_BO. Repeat those facts in one short sentence without tools. Do not resolve any conflict with another source.');
            await native(b).whenIdle();
            const beforeA = JSON.stringify(native(a).session.snapshotEvents()), beforeB = JSON.stringify(native(b).session.snapshotEvents()), requestStart = evidence.requests.length;
            progress('herb-three-real-auxiliary-calls');
            let child;
            try {
                child = await a.herb(b);
            }
            catch (error) {
                evidence.herbFailure = { message: error.message, causes: error.errors?.map(cause => ({ message: cause.message, cause: cause.cause?.message })), requests: evidence.requests.slice(requestStart), sourceHistoriesByteIdentical: JSON.stringify(native(a).session.snapshotEvents()) === beforeA && JSON.stringify(native(b).session.snapshotEvents()) === beforeB, noChildCreated: a.getChildren().length === 0 };
                throw error;
            }
            assert.equal(JSON.stringify(native(a).session.snapshotEvents()), beforeA);
            assert.equal(JSON.stringify(native(b).session.snapshotEvents()), beforeB);
            assert.equal(child.getParent(), a);
            assert.deepEqual(child.getProfile().model, a.getProfile().model);
            assert.deepEqual(child.getProfile().params, a.getProfile().params);
            assert.equal(child.getProfile().permission, a.getProfile().permission);
            const auxiliary = evidence.requests.slice(requestStart).filter(request => !request.tools?.length && request.messages === 1);
            assert.equal(auxiliary.length, 3);
            const headings = ['## 目标与约束', '## 已知事实与关键决策', '## 当前进展与已有产物', '## 关键文件、资源及定位信息', '## 未完成事项与后续步骤', '## 分歧、风险与待确认信息'];
            for (const request of auxiliary) {
                assert.ok(request.output.trim().startsWith('Flow 上下文总结 v1'));
                for (const heading of headings)
                    assert.ok(request.output.includes(heading), heading);
            }
            const merged = auxiliary.at(-1).output.trim();
            const body = merged.slice(merged.indexOf(headings[0]));
            for (const token of ['SourceAlpha', 'SourceBeta', 'BUDGET_MAX_40', 'BUDGET_MIN_80', 'OFFLINE_ONLY', 'INTERNET_REQUIRED', 'KAFKA_REQUIRED', 'KAFKA_PROHIBITED', 'PENDING_ADA', 'PENDING_BO'])
                assert.ok(body.includes(token), 'Merged summary body lost ' + token);
            const conflicts = body.slice(body.indexOf(headings[5]) + headings[5].length).trim();
            const unfinished = body.slice(body.indexOf(headings[4]) + headings[4].length, body.indexOf(headings[5]));
            for (const token of ['PENDING_ADA', 'PENDING_BO']) assert.ok(unfinished.includes(token), 'Unfinished section lost ' + token);
            assert.ok(/矛盾|冲突|分歧|待确认|无法|未解决/.test(conflicts));
            assert.ok(/KAFKA_REQUIRED|KAFKA_PROHIBITED|Kafka|40|80|OFFLINE_ONLY|INTERNET_REQUIRED/.test(conflicts));
            await native(child).whenIdle();
            const transferred = native(child).session.snapshotEvents().filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data)).join('\n');
            for (const token of ['BUDGET_MAX_40', 'BUDGET_MIN_80', 'KAFKA_REQUIRED', 'KAFKA_PROHIBITED']) assert.ok(transferred.includes(token));
            evidence.herb = { status: 'PASS', sourceA: { sessionId: sid(a), name: 'SourceAlpha' }, sourceB: { sessionId: sid(b), name: 'SourceBeta' }, threeAuxiliaryRequests: auxiliary, sourceHistoriesByteIdentical: true, child: { sessionId: sid(child), parentSessionId: sid(a), profile: child.getProfile() }, mergedRawOutput: merged, unfinishedBody: unfinished, unresolvedConflictBody: conflicts, transferredContext: transferred };
            await flow.runs.release(origin, run);
            await main.whenIdle();
            await created.dispose();
            progress('herb-semantic-complete');
            await finish('PASS');
            return;
        }
        if (evidence.phase === 'single') {
            const run = await active(flow.runs.create(origin, {}, 'single-live-team'));
            const shape = schema({ answer: { type: 'integer' }, environment: { type: 'string' } });
            const job = await top(run, spec('single-live-result', shape), 'single-top');
            await submit(run.root, job.id, { answer: 7, environment: process.env.P7_PROFILE_NAME ?? 'web' }, 'single-submit');
            const saved = await verifyOutcome(job.id, { answer: 7, environment: process.env.P7_PROFILE_NAME ?? 'web' });
            evidence.runId = run.id;
            evidence.address = flow.dashboardAddress;
            evidence.scenarios.push({ name: 'single-real-model-Flow-job', status: 'PASS', assignmentId: job.id, result: saved.value, mainReadCall: true });
            writeProof('ui-ready.json', JSON.stringify({ address: flow.dashboardAddress, mainSessionId: main.session.id, runId: run.id, assignmentIds: [job.id] }, null, 2));
            progress('single-ui-ready');
            const end = Date.now() + Number(process.env.P7_UI_HOLD_MS ?? 180000);
            while (Date.now() < end) {
                try {
                    readFileSync(join(directory, 'ui-ack'));
                    break;
                }
                catch { }
                await pause(100);
            }
            ;
            await flow.runs.release(origin, run);
            await main.whenIdle();
            await created.dispose();
            await finish('PASS');
            progress('single-live-complete');
            return;
        }
        if (!restarted) {
            progress('s1-create-idle-nested-pattern');
            const run = await active(flow.runs.create(origin, {}, 'live-idle-team'));
            const definition = flow.catalog.resolve('builtin/hierarchical');
            assert.equal(definition.ok, true);
            const applied = await patterns.applyPattern(run.root, { definition: definition.definition, parameters: { groups: 1, membersPerGroup: 1 } }, 'live-nested-pattern');
            assert.equal(evidence.requests.length, 0);
            assert.ok(snapshot(run).nodes.length >= 6);
            assert.ok(snapshot(run).groups.length >= 2);
            assert.ok(snapshot(run).nodes.every(node => node.status === 'idle'));
            const lead = run.root.getChildren().find(agent => agent.getChildren().length), worker = lead.getChildren()[0], other = run.root.getChildren().find(agent => agent !== lead);
            evidence.runId = run.id;
            evidence.address = flow.dashboardAddress;
            evidence.epoch = flow.runs.epoch;
            evidence.scenarios.push({ number: 1, status: 'PASS', nodes: snapshot(run).nodes.length, groups: snapshot(run).groups.length, llmRequests: 0 });
            save();
            const shapeA = schema({ sum: { type: 'integer' } }), shapeB = schema({ label: { type: 'string' }, count: { type: 'integer' } });
            const a = await top(run, spec('sum-A', shapeA), 'top-A');
            const a1 = await delegate(run, run.root, lead, a.id, spec('lead-A', shapeA), 'child-A');
            const a2 = await delegate(run, lead, worker, a1.id, spec('worker-A', shapeA), 'grandchild-A');
            await submit(worker, a2.id, { sum: 5 }, 'submit-worker-A');
            await native(lead).whenIdle();
            assert.deepEqual((await read(lead, a2.id, 'read-worker-A')).value.result, { sum: 5 });
            await submit(lead, a1.id, { sum: 5 }, 'submit-lead-A');
            await native(run.root).whenIdle();
            assert.deepEqual((await read(run.root, a1.id, 'read-lead-A')).value.result, { sum: 5 });
            await submit(run.root, a.id, { sum: 5 }, 'submit-top-A');
            await verifyOutcome(a.id, { sum: 5 });
            assert.equal(run.status, 'active');
            assert.ok(snapshot(run).nodes.every(node => node.status !== 'terminated'));
            const cancelled = await top(run, spec('cancel-this-subtree', shapeA), 'top-cancel');
            const cancelChild = await delegate(run, run.root, lead, cancelled.id, spec('cancel-child', shapeA), 'child-cancel');
            const b = await top(run, spec('different-schema-B', shapeB), 'top-B');
            const b1 = await delegate(run, run.root, other, b.id, spec('worker-B', shapeB), 'child-B');
            await realGate(native(lead), 'cancelled-job-still-live');
            await command(main, 'flow_team_assignment_cancel', { runId: run.id, assignmentId: cancelled.id, reason: 'Only this assignment subtree is obsolete' }, 'cancel-one-job');
            assert.equal(run.assignments.read(run, run.assignments.resolve(cancelled.id)).status, 'cancelled');
            assert.equal(run.assignments.read(run, run.assignments.resolve(cancelChild.id)).status, 'cancelled');
            assert.equal(run.assignments.read(run, run.assignments.resolve(b.id)).status, 'pending');
            assert.notEqual(lead.getStatus(), 'terminated');
            releaseGate('cancelled-job-still-live');
            await native(lead).whenIdle();
            await submit(other, b1.id, { label: 'B', count: 3 }, 'submit-worker-B');
            await native(run.root).whenIdle();
            assert.deepEqual((await read(run.root, b1.id, 'read-worker-B')).value.result, { label: 'B', count: 3 });
            await realGate(main, 'main-active-followup');
            await submit(run.root, b.id, { label: 'B', count: 3 }, 'submit-top-B');
            assert.equal(main.status, 'running');
            assert.ok(main.inbox.nextTurn.some(message => message.source.kind === 'flow-outcome' && message.source.assignmentId === b.id));
            releaseGate('main-active-followup');
            await verifyOutcome(b.id, { label: 'B', count: 3 });
            evidence.scenarios.push({ number: 2, status: 'PASS', topAssignments: [a.id, b.id], schemas: [shapeA, shapeB], hierarchicalChain: [a.id, a1.id, a2.id], sameRun: run.id });
            evidence.scenarios.push({ number: 3, status: 'PASS', cancelled: [cancelled.id, cancelChild.id], otherSubmitted: b.id, memberAlive: sid(lead) });
            const c = await top(run, spec('reuse-member', shapeA), 'top-reuse');
            const c1 = await delegate(run, run.root, lead, c.id, spec('reuse-same-lead', shapeA), 'child-reuse');
            await submit(lead, c1.id, { sum: 9 }, 'submit-reused-member');
            await native(run.root).whenIdle();
            await read(run.root, c1.id, 'read-reused-member');
            await submit(run.root, c.id, { sum: 9 }, 'submit-reuse-top');
            await verifyOutcome(c.id, { sum: 9 });
            const auth = await fetch(flow.dashboardAddress + '/api/token', { headers: { Origin: 'dsh-app://app' } }).then(response => response.json());
            const webSnapshot = await fetch(flow.dashboardAddress + '/api/runs/' + run.id, { headers: { Origin: 'dsh-app://app', Authorization: 'Bearer ' + auth.token } }).then(response => response.json());
            const nativeConnection = await ctx.typertGateway.invoke({ namespace: 'flowDashboard', method: 'connection', args: {} });
            assert.equal(nativeConnection.address, flow.dashboardAddress);
            assert.equal(nativeConnection.epoch, webSnapshot.run.epoch);
            assert.deepEqual(webSnapshot.assignments.find(value => value.id === b.id).result, { label: 'B', count: 3 });
            evidence.scenarios.push({ number: 4, status: 'PASS', activeMain: main.session.id, notificationAssignment: b.id, modelReadCapture: await verifyOutcome(b.id, { label: 'B', count: 3 }), webNativeSameAddress: true });
            const ui = { address: flow.dashboardAddress, mainSessionId: main.session.id, runId: run.id, assignmentIds: [a.id, b.id, c.id], sessionIds: snapshot(run).nodes.map(node => node.sessionID) };
            writeProof('ui-ready.json', JSON.stringify(ui, null, 2));
            progress('s4-ui-ready');
            const uiEnd = Date.now() + Number(process.env.P7_UI_HOLD_MS ?? 180000);
            while (Date.now() < uiEnd) {
                try {
                    readFileSync(join(directory, 'ui-ack'));
                    break;
                }
                catch { }
                await pause(100);
            }
            ;
            const unfinished = await top(run, spec('release-unfinished', shapeA), 'top-release');
            const pendingChild = await delegate(run, run.root, worker.getParent(), unfinished.id, spec('pending-release-child', shapeA), 'child-release');
            await realGate(native(lead), 'release-active-native');
            const operationId = randomUUID(), initialSnapshot = snapshot(run), releaseEvents = [];
            const unwatch = flow.projector.subscribeRun(run.id, initialSnapshot.seq, flow.runs.epoch, event => releaseEvents.push(json(event)));
            const accepted = await fetch(flow.dashboardAddress + '/api/runs/' + run.id + '/stop', { method: 'POST', headers: { Origin: 'dsh-app://app', Authorization: 'Bearer ' + (await fetch(flow.dashboardAddress + '/api/token', { headers: { Origin: 'dsh-app://app' } }).then(response => response.json())).token, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId, targetEpoch: flow.runs.epoch, scope: 'run' }) });
            assert.equal(accepted.status, 202);
            await wait(() => snapshot(run).operations.some(operation => operation.id === operationId && operation.status === 'completed'), 'release physical cleanup', 15000);
            const stopped = snapshot(run);
            unwatch();
            for (const current of stopped.nodes) {
                const terminated = releaseEvents.findIndex(event => event.type === 'node-terminated' && event.node.id === current.id);
                const completed = releaseEvents.findIndex(event => 'node' in event && event.node.id === current.id && event.node.cleanup?.phase === 'complete');
                assert.ok(terminated >= 0 && completed > terminated, 'Logical termination must precede physical cleanup');
            }
            assert.equal(run.status, 'stopped');
            assert.ok(stopped.nodes.every(node => node.status === 'terminated' && node.cleanup?.phase === 'complete'));
            assert.equal(stopped.assignments.find(value => value.id === unfinished.id).status, 'cancelled');
            assert.equal(stopped.assignments.find(value => value.id === pendingChild.id).status, 'cancelled');
            await main.whenIdle();
            await command(main, 'flow_team_release', { runId: run.id }, 'release-idempotent');
            const oldWorker = initialSnapshot.nodes.find(node => node.sessionID === sid(worker));
            const oldHistory = await ctx.sessionQuery.readSession(SessionId(sid(worker)));
            const handoff = { mainSessionId: main.session.id, oldRunId: run.id, oldEpoch: flow.runs.epoch, oldWorkerSessionId: sid(worker), oldWorkerInstanceId: oldWorker.id, oldTopAssignmentId: a.id, oldChildAssignmentId: a2.id, oldResult: { sum: 5 }, operationId, oldHistoryPrefix: oldHistory.events };
            writeProof('handoff.json', JSON.stringify(handoff, null, 2));
            evidence.scenarios.push({ number: 5, status: 'PASS', operationId, logicalTerminationSeen: true, allCleanupComplete: true, releaseEvents, unfinishedCancelled: [unfinished.id, pendingChild.id], oldRunId: run.id });
            await created.dispose();
            progress('phase1-complete');
            await finish('PASS');
            return;
        }
        progress('s5-restart-expired-run');
        assert.notEqual(flow.runs.epoch, prior.oldEpoch);
        assert.throws(() => flow.bridge.resolveRun(origin, prior.oldRunId), /unavailable|expired/);
        assert.equal(flow.runs.list(origin).length, 0);
        const expired = await command(main, 'flow_team_get', { runId: prior.oldRunId }, 'old-run-handle-rejected', '{rejected:true}', true);
        assert.match(expired.value.error, /unavailable|expired/);
        const archived = flow.runs.readArchive(prior.oldTopAssignmentId);
        assert.equal(archived.kind, 'found');
        assert.deepEqual(archived.assignment.result, prior.oldResult);
        const run = await active(flow.runs.create(origin, {}, 'live-successor-run'));
        assert.equal(run.assignments.list(run.root).length, 0);
        const actualArchive = await command(native(run.root), 'flow_assignment_archive_read', { assignmentId: prior.oldTopAssignmentId }, 'read-real-archived-result');
        assert.equal(actualArchive.value.kind, 'found');
        assert.deepEqual(actualArchive.value.assignment.result, prior.oldResult);
        await command(native(run.root), 'flow_resume', { sessionID: prior.oldWorkerSessionId }, 'cold-resume-native');
        const resumed = run.root.getChildren().find(agent => sid(agent) === prior.oldWorkerSessionId);
        assert.ok(resumed);
        assert.deepEqual(native(resumed).session.snapshotEvents().slice(0, prior.oldHistoryPrefix.length), prior.oldHistoryPrefix);
        const next = node(run, resumed);
        assert.notEqual(next.id, prior.oldWorkerInstanceId);
        assert.equal(next.source.kind, 'resume');
        assert.equal(resumed.getMailbox().count(), 0);
        assert.equal(run.assignments.list(resumed).length, 0);
        assert.equal(snapshot(run).groups.length, 0);
        assert.throws(() => run.assignments.resolve(prior.oldChildAssignmentId));
        const shape = schema({ resumed: { type: 'boolean' }, priorSum: { type: 'integer' } });
        const successor = await top(run, { ...spec('successor-top', shape), resumesAssignmentId: prior.oldTopAssignmentId }, 'successor-top');
        const child = await delegate(run, run.root, resumed, successor.id, { ...spec('successor-child', shape), resumesAssignmentId: prior.oldChildAssignmentId }, 'successor-child');
        await submit(resumed, child.id, { resumed: true, priorSum: 5 }, 'submit-successor-child');
        await native(run.root).whenIdle();
        await read(run.root, child.id, 'read-successor-child');
        await submit(run.root, successor.id, { resumed: true, priorSum: 5 }, 'submit-successor-top');
        await verifyOutcome(successor.id, { resumed: true, priorSum: 5 });
        const target = { runId: run.id, instanceId: next.id, sessionId: prior.oldWorkerSessionId };
        const source = ctx.typertGateway.stream({ namespace: 'flowDashboard', method: 'followNativeSession', args: { input: { target, request: { assistantStream: true } } }, signal: new AbortController().signal });
        const stream = await source, iterator = stream[Symbol.asyncIterator](), opening = (await iterator.next()).value;
        assert.equal(opening.frame.type, 'snapshot');
        assert.ok(opening.frame.records.some(record => record.event.type === 'tool/call'));
        await iterator.return?.();
        evidence.runId = run.id;
        evidence.address = flow.dashboardAddress;
        evidence.scenarios.push({ number: 5, status: 'PASS', restartEpochChanged: true, oldRunRejected: true, archiveResult: archived.assignment.result });
        evidence.scenarios.push({ number: 6, status: 'PASS', sameSessionId: prior.oldWorkerSessionId, oldInstance: prior.oldWorkerInstanceId, newInstance: next.id, newParent: next.parentId, noRestoredMailboxGroupAssignmentBindings: true, successorTop: successor.id, resumesAssignmentId: successor.spec.resumesAssignmentId, successorChild: child.id, childResumesAssignmentId: child.spec.resumesAssignmentId, nativeReaderSnapshot: true });
        writeProof('restart-ui-ready.json', JSON.stringify({ address: flow.dashboardAddress, mainSessionId: main.session.id, runId: run.id, resumedSessionId: prior.oldWorkerSessionId, instanceId: next.id }, null, 2));
        progress('s6-ui-ready');
        const uiEnd = Date.now() + Number(process.env.P7_UI_HOLD_MS ?? 180000);
        while (Date.now() < uiEnd) {
            try {
                readFileSync(join(directory, 'restart-ui-ack'));
                break;
            }
            catch { }
            await pause(100);
        }
        ;
        await flow.runs.release(origin, run);
        await main.whenIdle();
        await created.dispose();
        progress('all-six-scenarios-complete');
        await finish('PASS');
    })().catch(error => { evidence.histories = histories(); evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack }; save(); writeProof(evidence.phase + '-evidence.json', JSON.stringify(evidence, null, 2)); console.error('[P7 live] FAIL', error.message); });
}
