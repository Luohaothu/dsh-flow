import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import { createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DshNativeBridge } from '../../../packages/dsh-flow/src/host/native-bridge.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { installFlowTools } from '../../../packages/dsh-flow/src/host/tools.js';
import { installMemberTools } from '../../../packages/dsh-flow/src/host/member-tools.js';
import PersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { rm } from 'node:fs/promises';
import { runtime, until } from '../../helpers/contract-runtime.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local';
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { newSessionID } from '../../../packages/dsh-flow/src/core/message.js';

async function fixture(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t);
  await f.host.plugin(AgentDefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  const catalog = new PatternCatalog({ includeBuiltins: false });
  const bridge = new DshNativeBridge(f.host, { stateDirectory: join(f.directory, 'bridge'), catalog });
  const service = new RunService({ store: new RunStore(join(f.directory, 'runs')), patternCatalog: catalog, patternRoleProvisioner: bridge,
    getOriginDefaults: origin => bridge.getOriginDefaults(origin), initialize: (...args) => bridge.initialize(...args),
    validateMaterials: request => bridge.validateMaterials(request) });
  t.after(() => bridge.dispose().catch(() => {}));
  const ordinary = async (name: string) => (await f.host.agents.create({ sessionId: SessionId(name), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } })).agent;
  const active = async (native: Awaited<ReturnType<typeof ordinary>>, requestId = 'run') => {
    const origin = bridge.createOrigin(native), run = service.create(origin, {}, requestId);
    await runState(run).initialization;
    assert.equal(run.status, 'active', service.read(origin, run).error);
    assert.ok(run.root); return { origin, run, root: run.root };
  };
  return { ...f, bridge, service, ordinary, active };
}

test('main definitions are exact native scope registrations, including existing and future ordinary sessions', async t => {
  const f = await fixture(t), first = await f.ordinary('existing-main');
  const standalone = await f.create('standalone-root');
  f.bridge.attachRunService(f.service);
  const future = await f.ordinary('future-main');
  const internal = (await f.host.agents.create({ sessionId: SessionId('durable-subagent'), meta: { cwd: f.directory, origin: 'subagent' } })).agent;
  const { root } = await f.active(first);
  const mainNames = ['flow_team_create', 'flow_teams', 'flow_team_get', 'flow_team_assign', 'flow_team_assignment_read', 'flow_team_assignment_cancel', 'flow_team_release'];
  for (const name of mainNames) {
    assert.equal(f.host.tools.get(name), undefined);
    assert.ok(f.host.tools.get(name, scopeOf(first.ctx)));
    assert.ok(f.host.tools.get(name, scopeOf(future.ctx)));
    assert.equal(f.host.tools.get(name, scopeOf(f.native(standalone).ctx)), undefined);
    assert.equal(f.host.tools.get(name, scopeOf(internal.ctx)), undefined);
    assert.equal(f.host.tools.get(name, scopeOf(f.native(root).ctx)), undefined);
  }
  for (const member of ['flow_patterns', 'flow_pattern_define', 'flow_pattern_apply', 'flow_assign', 'flow_assignment_read', 'flow_assignments', 'flow_submit', 'flow_assignment_cancel', 'flow_material_read', 'flow_team_read']) assert.ok(f.host.tools.get(member, scopeOf(f.native(root).ctx)), member);
  assert.equal(f.model.requests.length, 0);
  const memberScope = scopeOf(f.native(root).ctx);
  f.native(root).ctx.tools.presentAs('ptc');
  assert.equal(f.host.tools.get('flow_team_release', memberScope), undefined);
  assert.equal(f.host.tools.schemas(memberScope).some(tool => tool.name === 'flow_team_release'), false);
  const forbidden = await f.host.tools.execute({ agent: f.native(root), callId: ToolCallId('forced-release'), name: 'flow_team_release', arguments: { runId: 'anything' }, signal: new AbortController().signal });
  assert.equal(forbidden.isError, true);
  await f.bridge.dispose();
});

test('real rc.2 calls create idle runs, rejects forged contexts and model caller fields, then revoke all main definitions on dispose', async t => {
  const f = await fixture(t), main = await f.ordinary('tool-main');
  f.bridge.attachRunService(f.service);
  const scope = scopeOf(main.ctx);
  const forged = await f.host.tools.execute({ agent: main, callId: ToolCallId('invented'), name: 'flow_team_create', arguments: { requestId: 'forged' }, signal: new AbortController().signal });
  assert.equal(forged.isError, true);
  assert.equal(f.service.list(f.bridge.createOrigin(main)).length, 0);
  f.model.script = (_options, index) => index === 0 ? { tool: 'flow_team_create', args: { requestId: 'native-call' } } : 'DONE';
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'create team' }] }));
  await main.whenIdle();
  const listing = f.service.list(f.bridge.createOrigin(main)); assert.equal(listing.length, 1);
  const run = f.bridge.resolveRun(f.bridge.createOrigin(main), listing[0]!.id); await runState(run).initialization;
  assert.equal(run.status, 'active'); assert.equal(f.native(run.root!).status, 'idle'); assert.equal(run.root!.getMailbox().count(), 0);
  const nativeResult = main.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(nativeResult?.type === 'tool/result' ? nativeResult.data.message.isError : true, false);
  f.model.script = (_options, index) => index === 2 ? { tool: 'flow_team_create', args: { requestId: 'fake-caller', caller: 'other', root: 'other' } } : 'DONE';
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'try fake fields' }] })); await main.whenIdle();
  assert.equal(f.service.list(f.bridge.createOrigin(main)).length, 1);
  await f.bridge.dispose();
  assert.equal(f.host.tools.get('flow_team_release', scope), undefined);
  assert.equal(run.status, 'stopped');
});

test('origin seeds retain creation-time model/cwd/defaults while later origins capture changed request headers', async t => {
  const f = await fixture(t), main = await f.ordinary('snapshot-main');
  await enablePluginHost(f.host, f.directory);
  main.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'old', temperature: 0.3, maxTokens: 99 } } });
  const first = f.bridge.createOrigin(main), snapshot = f.bridge.getOriginDefaults(first);
  main.session.append('request/header', { reason: 'change', header: { config: { provider: 'fixture', model: 'new' } } });
  const second = f.bridge.createOrigin(main);
  assert.equal(snapshot.model!.id, 'old'); assert.equal(f.bridge.getOriginDefaults(first).model!.id, 'old');
  assert.equal(f.bridge.getOriginDefaults(second).model!.id, 'new'); assert.equal(f.bridge.getOriginDefaults(second).params!.temperature, undefined);
  snapshot.model = { provider: 'mutated', id: 'mutated' };
  assert.equal(f.bridge.getOriginDefaults(first).model!.id, 'old');
  main.session.append('request/header', { reason: 'change', header: { config: { provider: 'fixture', model: 'previous-route', maxTokens: 999, temperature: 0.7 }, adapterDefaults: { maxTokens: true } } });
  await f.host.sessionController.selectModel({ sessionId: main.session.id, provider: 'fixture', model: 'model' });
  const pending = f.bridge.getOriginDefaults(f.bridge.createOrigin(main));
  assert.equal(pending.model!.id, 'model'); assert.equal(pending.params!.maxTokens, undefined); assert.equal(pending.params!.temperature, 0.7);
  await f.bridge.dispose();
});

test('native member submission has a durable transport key and histories remain queryable', async t => {
  const f = await fixture(t), main = await f.ordinary('assignment-main'); f.bridge.attachRunService(f.service);
  const { origin, run, root } = await f.active(main);
  const spec = { name: 'task', type: 'test', background: '', requirements: 'submit', acceptanceCriteria: 'valid', resultSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
  let assignmentId = '';
  let submitted = false;
  const repeats: unknown[] = [];
  f.native(root).ctx.on('tools/execute', async (execution, next) => {
    const first = await next();
    if (execution.name !== 'flow_submit') return first;
    const replay = await next(); repeats.push(first, replay); return replay;
  });
  f.model.script = () => {
    if (submitted) return 'DONE'; submitted = true;
    return { tool: 'flow_submit', args: { assignmentId, result: { answer: 'ok' }, continuingChildren: [] } };
  };
  const prepared = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec }, 'task'); assignmentId = prepared.id;
  run.assignments!.deliver(prepared); await f.native(root).whenIdle();
  await until(() => f.service.readAssignment(origin, run, prepared).status === 'submitted');
  const record = f.service.readAssignment(origin, run, prepared);
  assert.equal(record.submissions.length, 1);
  assert.equal(repeats.length, 2); assert.deepEqual(repeats[0], repeats[1]);
  const key = JSON.parse(record.submissions[0]!.transportKey); assert.equal(key[0], root.getProfile().sessionID); assert.equal(typeof key[1], 'number');
  const fake = await f.host.tools.execute({ agent: f.native(root), callId: ToolCallId(key[2]), name: 'flow_submit', arguments: { assignmentId, result: { answer: 'ok' }, continuingChildren: [] }, signal: new AbortController().signal });
  assert.equal(fake.isError, true);
  await f.bridge.dispose();
});

test('top-level outcomes use the original native followup while idle, busy and cold; missing sessions fail explicitly', async t => {
  const f = await fixture(t); await enablePluginHost(f.host, f.directory);
  const handle = await f.host.agents.create({ sessionId: SessionId('outcome-origin'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } });
  const main = handle.agent, other = await f.ordinary('unrelated-current-session'); f.bridge.attachRunService(f.service);
  const { run, root, origin } = await f.active(main);
  const assignment = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null,
    spec: { name: 'outcome', type: 'test', background: '', requirements: '', acceptanceCriteria: '', resultSchema: true } }, 'outcome');
  const snapshot = run.assignments!.read(run, assignment);
  await f.bridge.onTopLevelOutcome(origin, run, { ...snapshot, status: 'submitted' }); await main.whenIdle();
  assert.equal(other.session.snapshotEvents().some(event => event.type === 'user/message'), false);
  assert.ok(main.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'flow-outcome'));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); let entered = false;
  f.model.script = async () => { if (!entered) { entered = true; await blocked; } return 'DONE'; };
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'busy' }] })); await until(() => entered);
  await f.bridge.onTopLevelOutcome(origin, run, { ...snapshot, status: 'failed' });
  assert.ok(main.inbox.nextTurn.some(message => message.source.kind === 'flow-outcome'));
  release(); await main.whenIdle();
  await f.host.sessions.flush(main.session); await handle.dispose();
  assert.equal(f.host.agents.get(main.session.id), undefined);
  await f.bridge.onTopLevelOutcome(origin, run, { ...snapshot, status: 'cancelled' });
  const restored = f.host.agents.get(main.session.id); assert.ok(restored); assert.notEqual(restored, main); await restored.whenIdle();
  assert.ok(restored.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'flow-outcome' && JSON.stringify(event.data).includes('cancelled')));
  const missingHandle = await f.host.agents.create({ sessionId: SessionId('deleted-origin'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model' } });
  const missingOrigin = f.bridge.createOrigin(missingHandle.agent);
  await f.host.sessions.flush(missingHandle.agent.session); await missingHandle.dispose();
  const path = await (f.host.sessionPersistence as PersistenceJsonl).resolveCurrentLog(SessionId('deleted-origin')); assert.ok(path); await rm(path);
  await assert.rejects(f.bridge.onTopLevelOutcome(missingOrigin, run, snapshot), /restore|not found|not-found/i);
  await f.bridge.dispose();
  await assert.rejects(f.bridge.onTopLevelOutcome(origin, run, snapshot), /disposed/);
});

test('the adaptor accepted turn retains assignment history and submission after SIGTERM logical termination', async t => {
  const f = await fixture(t), main = await f.ordinary('term-main'); f.bridge.attachRunService(f.service);
  const { run, root } = await f.active(main), native = f.native(root);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let entered = false;
  native.ctx.tools.register({ name: 'hold_for_term', description: 'Hold this admitted turn.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'released' }] }, async execute() { entered = true; await held; return {}; } });
  const assignment = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null,
    spec: { name: 'term task', type: 'test', background: '', requirements: '', acceptanceCriteria: '', resultSchema: true } }, 'term-task');
  let step = 0;
  f.model.script = () => {
    if (step++ === 0) return { tool: 'hold_for_term', args: {} };
    if (step === 2) return { tool: 'flow_assignment_read', args: { assignmentId: assignment.id } };
    if (step === 3) return { tool: 'flow_submit', args: { assignmentId: assignment.id, result: 'finished accepted turn', continuingChildren: [] } };
    return 'DONE';
  };
  run.assignments!.deliver(assignment); await until(() => entered);
  const closing = root.recvSignal('SIGTERM'); assert.equal(root.getStatus(), 'terminated'); release(); await closing;
  const results = native.session.snapshotEvents().filter(event => event.type === 'tool/result');
  assert.equal(results.length, 3);
  for (const event of results) if (event.type === 'tool/result') assert.equal(event.data.message.isError, false, JSON.stringify(event));
  assert.ok(results.some(event => JSON.stringify(event).includes('terminal')));
  await f.bridge.dispose();
});

test('real rc.2 Node PTC subcalls retain the enclosing SDK token and distinct own callIds for independent submissions', async t => {
  const f = await fixture(t), main = await f.ordinary('ptc-main'); f.bridge.attachRunService(f.service);
  await f.host.plugin(SubprocessLocal); await f.host.plugin(SandboxLocal); await f.host.plugin(NodePtcRuntime, { timeoutMs: 5000 });
  const { run, root } = await f.active(main), native = f.native(root);
  native.ctx.tools.presentAs('ptc');
  const spec = { name: 'ptc task', type: 'test', background: '', requirements: '', acceptanceCriteria: '', resultSchema: true };
  const one = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec }, 'one');
  const two = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec }, 'two');
  let called = false;
  f.model.script = () => {
    if (called) return 'DONE'; called = true;
    return { tool: 'run_code', args: { description: 'Submit two independent formal results', code: `return await Promise.all([tools.flow_submit({assignmentId:${JSON.stringify(one.id)}, result:'one', continuingChildren:[]}), tools.flow_submit({assignmentId:${JSON.stringify(two.id)}, result:'two', continuingChildren:[]})])` } };
  };
  run.assignments!.deliver(one); await native.whenIdle();
  const a = run.assignments!.read(run, one), b = run.assignments!.read(run, two);
  assert.equal(a.status, 'submitted', JSON.stringify(native.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'tool/ptc-dispatch')));
  assert.equal(b.status, 'submitted');
  const aKey = JSON.parse(a.submissions[0]!.transportKey), bKey = JSON.parse(b.submissions[0]!.transportKey);
  assert.equal(aKey[0], bKey[0]); assert.equal(aKey[1], bKey[1]); assert.notEqual(aKey[2], bKey[2]);
  assert.match(aKey[2], /:ptc:/); assert.match(bKey[2], /:ptc:/);
  assert.equal(native.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'flow_submit' && !event.data.isError).length, 2);
  await f.bridge.dispose();
});

test('partial ordinary scope installation rolls back only its own tools and retains a foreign name collision', async t => {
  const f = await fixture(t), first = await f.ordinary('before-collision'), ordinary = await f.ordinary('collision-main');
  const foreign = { name: 'flow_team_get', description: 'Foreign existing definition', parameters: { type: 'object' as const },
    output: { schema: { type: 'object' as const }, render: () => [] }, execute: async () => ({ foreign: true }) };
  ordinary.ctx.tools.register(foreign);
  assert.throws(() => f.bridge.attachRunService(f.service));
  for (const name of ['flow_team_create', 'flow_teams', 'flow_team_assign', 'flow_team_release']) assert.equal(f.host.tools.get(name, ordinary), undefined, name);
  assert.equal(f.host.tools.get('flow_team_get', ordinary), foreign);
  assert.equal(f.host.tools.get('flow_team_create', first), undefined);
  const later = await f.ordinary('after-failed-attachment'); assert.equal(f.host.tools.get('flow_team_create', later), undefined);
  await f.bridge.dispose();
  assert.equal(f.host.tools.get('flow_team_create', ordinary), undefined);
  assert.equal(f.host.tools.get('flow_team_get', ordinary), foreign);
});

test('Core and member tool batches unwind earlier registrations in borrowed native scopes while retaining foreign definitions', async t => {
  const f = await fixture(t), main = await f.ordinary('batch-main'); f.bridge.attachRunService(f.service);
  const { root } = await f.active(main), binding = f.bridge.bindings.get(root); assert.ok(binding);
  for (const family of ['core', 'member'] as const) {
    const native = await f.ordinary(`borrowed-${family}`), scope = native.ctx;
    const foreign = { name: family === 'core' ? 'flow_read' : 'flow_patterns', description: 'Foreign existing registration', parameters: { type: 'object' as const }, output: { schema: { type: 'object' as const }, render: () => [] }, execute: async () => ({ foreign: true }) };
    scope.tools.register(foreign);
    assert.throws(() => family === 'core' ? installFlowTools(scope, binding.plan.context, root, () => {}, () => {})
      : installMemberTools(scope, binding, f.bridge.bindings, f.bridge.materials, () => {}, () => {}));
    assert.equal(f.host.tools.get('flow_self', native), undefined); assert.equal(f.host.tools.get('flow_team_read', native), undefined);
    assert.equal(f.host.tools.get(foreign.name, native), foreign);
  }
  await f.bridge.dispose();
});

test('real native archive tools hide another ordinary session history and reject its continuation while preserving same-origin history', async t => {
  const f = await fixture(t), mainA = await f.ordinary('archive-owner-A'), mainB = await f.ordinary('archive-owner-B');
  f.bridge.attachRunService(f.service);
  const a = await f.active(mainA, 'source-A'), b = await f.active(mainB, 'target-B');
  const secret = 'only-owner-A-private-result';
  const spec = { name: 'archive task', type: 'test', background: '', requirements: '', acceptanceCriteria: '', resultSchema: true };
  const saved = await a.run.assignments!.prepare({ sender: a.run, recipient: a.root, parentAssignment: null, spec }, 'secret-task');
  let stepA = 0;
  f.model.script = () => stepA++ === 0 ? { tool: 'flow_submit', args: { assignmentId: saved.id, result: { secret }, continuingChildren: [] } } : 'DONE';
  a.run.assignments!.deliver(saved); await f.native(a.root).whenIdle();
  assert.equal(a.run.assignments!.read(a.run, saved).status, 'submitted');
  await f.service.release(a.origin, a.run);
  const childB = await Agent.create(b.run.context!, { ...b.root.getProfile(), sessionID: newSessionID(), name: 'B continuation child' }, b.root);
  const parentB = await b.run.assignments!.prepare({ sender: b.run, recipient: b.root, parentAssignment: null, spec }, 'B-parent');
  let stepB = 0;
  f.model.script = () => {
    if (stepB++ === 0) return { tool: 'flow_assignment_archive_read', args: { assignmentId: saved.id } };
    if (stepB === 2) return { tool: 'flow_assign', args: { recipientSessionID: childB.getProfile().sessionID, parentAssignmentId: parentB.id, spec: { ...spec, resumesAssignmentId: saved.id }, requestId: 'foreign-continuation' } };
    return 'DONE';
  };
  const nativeB = f.native(b.root);
  b.run.assignments!.deliver(parentB); await nativeB.whenIdle();
  const eventsB = nativeB.session.snapshotEvents();
  const archiveCall = eventsB.find(event => event.type === 'tool/call' && event.data.name === 'flow_assignment_archive_read');
  assert.equal(archiveCall?.type, 'tool/call'); if (archiveCall?.type !== 'tool/call') throw new Error('Missing native archive call');
  const archiveResult = eventsB.find(event => event.type === 'tool/result' && event.data.message.toolCallId === archiveCall.data.callId);
  assert.equal(archiveResult?.type, 'tool/result'); if (archiveResult?.type !== 'tool/result') throw new Error('Missing native archive result');
  assert.equal(archiveResult.data.message.isError, false);
  assert.deepEqual(JSON.parse(archiveResult.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')), { kind: 'not-found', id: saved.id });
  const continuationCall = eventsB.find(event => event.type === 'tool/call' && event.data.name === 'flow_assign');
  assert.equal(continuationCall?.type, 'tool/call'); if (continuationCall?.type !== 'tool/call') throw new Error('Missing native continuation call');
  const continuationResult = eventsB.find(event => event.type === 'tool/result' && event.data.message.toolCallId === continuationCall.data.callId);
  assert.equal(continuationResult?.type === 'tool/result' ? continuationResult.data.message.isError : false, true);
  assert.equal(JSON.stringify(eventsB).includes(secret), false);
  assert.equal(b.run.assignments!.list(b.run).length, 1); assert.equal(childB.getMailbox().count(), 0);
  const nextA = await f.active(mainA, 'same-origin-next-A'); let queryA = false;
  f.model.script = () => { if (queryA) return 'DONE'; queryA = true; return { tool: 'flow_assignment_archive_read', args: { assignmentId: saved.id } }; };
  const nextJob = await nextA.run.assignments!.prepare({ sender: nextA.run, recipient: nextA.root, parentAssignment: null, spec }, 'same-origin-query');
  nextA.run.assignments!.deliver(nextJob); const nativeNextA = f.native(nextA.root); await nativeNextA.whenIdle();
  const ownResult = nativeNextA.session.snapshotEvents().find(event => event.type === 'tool/result');
  assert.equal(ownResult?.type, 'tool/result'); if (ownResult?.type !== 'tool/result') throw new Error('Missing own native archive result');
  assert.equal(ownResult.data.message.isError, false);
  const history = JSON.parse(ownResult.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
  assert.equal(history.kind, 'found'); assert.deepEqual(history.assignment.result, { secret });
  await f.bridge.dispose();
});
