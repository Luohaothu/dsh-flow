/** Real command registration + real FlowController/Session, without model requests.
 * The controlled native edge records admission timing; it does not implement Flow.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import { CommandId, type CommandDefinition, type CommandInvocation } from '@deepseek-ai/dsh-commands';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { FileBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { apply, teamIntents } from '../../packages/dsh-flow/src/command.ts';
import { registerMemberTools } from '../../packages/dsh-flow/src/core/member-tools.ts';
import { rejectionStatus } from '../../packages/dsh-flow/src/errors.ts';
import { ControlledNative, fixture, until } from './native-fixture.ts';

type Section = Parameters<Context['systemPrompt']['section']>[0];
const objective = '完成 2026-10-12 A 股复盘，保存 report.md 与 market-data.json。';

function commandFixture(t: TestContext) {
  const f = fixture(t);
  const initial = Session.create(SessionId('owner'));
  let session = Session.create(initial.id, [], { ...initial.header, cwd: f.dir, agentPreset: 'standard' });
  let native: ControlledNative;
  let definition: CommandDefinition | undefined;
  let sections: Section[] = [];
  let tools: string[] = [];
  const admissions: { teamIds: string[]; rootIds: string[]; coordinator: string; message: UserMessage }[] = [];
  let commandSeq = 0;
  // A deterministic Session checkpoint seam, not the native journal writer or
  // a claim about process-kill/fsync behavior. Flow's SQLite is real in fixture().
  const checkpointPath = join(f.dir, 'command-session-checkpoint.json');
  const checkpoint = () => writeFileSync(checkpointPath, JSON.stringify({ header: session.header, events: session.snapshotEvents() }));
  const coordinator = () => sections.map(section => typeof section.text === 'string'
    ? section.text : section.text({ agent: native.agent })).join('\n');
  const bindNative = () => {
    native = new ControlledNative({ sessionId: 'owner', workspace: f.dir, setup() {}, onEvent: event => f.emit(session, event) }, session);
    const send = native.send.bind(native);
    native.send = (message, mode) => {
      const runs = f.flow.teamRuns('owner');
      admissions.push({ teamIds: runs.map(run => run.id), rootIds: runs.map(run => run.root_task_id), coordinator: coordinator(), message });
      send(message, mode);
    };
    f.agents.set('owner', native.agent);
  };
  const register = () => {
    definition = undefined; sections = []; tools = [];
    const ctx = Object.assign(fromPartial<Context>({}), {
      get flow() { return f.flow; },
      commands: { register(value: CommandDefinition) { definition = value; return () => {}; } },
      tools: { register(value: { name: string }) { tools.push(value.name); return () => {}; } },
      systemPrompt: { section(value: Section) { sections.push(value); return () => {}; }, getSectionOrder() { return 600; } },
      skills: { register() { return () => {}; } },
      sessions: { async flush() { checkpoint(); } },
      sessionController: { async inspect() { return { events: session.snapshotEvents() }; } },
      sessionProjections: { stateOf() { return undefined; } },
      agentDefaultModel: { currentSelection() { return { provider: 'test-provider', model: 'test-model', reasoningEffort: 'max' }; } },
      agents: { get: (id: string) => f.agents.get(id) },
      on() { return () => {}; },
      effect(effect: () => void | (() => void)) { return effect(); },
    });
    apply(ctx);
    assert.ok(definition, 'the actual command plugin registered a native command handler');
  };
  bindNative(); register();
  const invoke = (submissionId = 'submit-once', rawInput = objective, attachments: CommandInvocation['attachments'] = []) => {
    assert.ok(definition);
    return Promise.resolve(definition.handler({ submissionId, commandId: CommandId(`command-${++commandSeq}`),
      agent: native.agent, rawInput, attachments, signal: new AbortController().signal }));
  };
  return {
    f, invoke, admissions, coordinator, checkpoint,
    get session() { return session; }, get native() { return native; },
    get definition() { assert.ok(definition); return definition; }, get tools() { return tools; },
    async cold(fromCheckpoint = false) {
      if (!fromCheckpoint) checkpoint();
      const { events, header }: { events: ReturnType<Session['snapshotEvents']>; header: Session['header'] } = JSON.parse(readFileSync(checkpointPath, 'utf8'));
      await f.reopen();
      session = Session.create(SessionId('owner'), events, header);
      bindNative(); register();
    },
  };
}

function oneTeam(h: ReturnType<typeof commandFixture>) {
  const runs = h.f.flow.teamRuns('owner');
  assert.equal(runs.length, 1, 'the human command itself creates exactly one durable team');
  const snapshot = h.f.flow.teamRead('owner', runs[0]!.id);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0]!.id, snapshot.run.root_task_id);
  assert.equal(snapshot.tasks[0]!.owner_session_id, 'owner');
  assert.equal(snapshot.tasks[0]!.assignee_session_id, 'owner');
  assert.equal(snapshot.members.length, 0, 'creation must not start a redundant root/background member');
  assert.equal(h.f.created.length, 0);
  return snapshot;
}

test('/agent-team directly creates one main-owned root before exactly one native followup', async t => {
  const h = commandFixture(t);
  const reply = await h.invoke();
  assert.equal(reply.kind, 'success');
  const snapshot = oneTeam(h);
  assert.equal(snapshot.run.objective, objective);
  assert.equal(snapshot.run.workspace, h.f.dir);
  assert.deepEqual(snapshot.run.model, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'max' });
  assert.equal(h.admissions.length, 1);
  assert.deepEqual(h.admissions[0]!.teamIds, [snapshot.run.id], 'team exists before native execution can begin');
  assert.deepEqual(h.admissions[0]!.rootIds, [snapshot.run.root_task_id]);
});

test('the command advertises native attachment admission', t => {
  const h = commandFixture(t);
  assert.equal(h.definition.input?.attachments, true, 'native command admission rejects attachments unless this descriptor opts in');
});

test('main-only collaboration aliases are absent from the actual command registration', t => {
  const h = commandFixture(t);
  assert.equal(h.tools.includes('agent_team_create'), false, 'creation is deterministic command work, not another model tool call');
  for (const name of ['agent_team_read', 'agent_team_message', 'agent_team_control']) assert.equal(h.tools.includes(name), false);
});

test('concurrent and sequential repeats keep one team, one intent and one native input', async t => {
  const h = commandFixture(t);
  await Promise.all([h.invoke(), h.invoke(), h.invoke()]);
  await h.invoke();
  assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
  assert.equal(h.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1);
  assert.equal(h.admissions.length, 1);
  oneTeam(h);
});

test('cold controller and command reload replay the same submission without a second input', async t => {
  const h = commandFixture(t);
  await h.invoke();
  const firstIds = h.f.flow.teamRuns('owner').map(run => run.id);
  await h.cold();
  await h.invoke();
  assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
  assert.equal(h.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1);
  assert.equal(h.admissions.length, 1);
  oneTeam(h);
  assert.deepEqual(h.f.flow.teamRuns('owner').map(run => run.id), firstIds);
});

test('admitted file and image blocks survive the command and durable native input unchanged', async t => {
  const h = commandFixture(t);
  // These are already admitted native references; no upload/provider path is mocked here.
  const file = fromPartial<FileBlock>({ type: 'file', attachment: { name: 'market.csv', bytes: 17 } });
  const image = fromPartial<ImageBlock>({ type: 'image', attachment: { mediaType: 'image/png', bytes: 68, width: 1, height: 1 } });
  Object.assign(file.attachment, { attachmentId: 'a'.repeat(64) });
  Object.assign(image.attachment, { attachmentId: 'b'.repeat(64) });
  await h.invoke('attachments', objective, [file, image]);
  const entry = h.session.snapshotEvents().find(event => event.type === 'user/message');
  assert.ok(entry?.type === 'user/message');
  assert.deepEqual(entry.data.content.filter(block => block.type === 'file' || block.type === 'image'), [file, image]);
  const intent = teamIntents(h.session.snapshotEvents())[0];
  assert.ok(intent);
  assert.deepEqual(intent.request.content.filter(block => block.type === 'file' || block.type === 'image'), [file, image]);
  assert.equal(h.admissions.length, 1);
});

test('same submission with changed objective or attachment is a conflict even after cold reload', async t => {
  const h = commandFixture(t);
  const file = fromPartial<FileBlock>({ type: 'file', attachment: { name: 'source.csv', bytes: 17 } });
  Object.assign(file.attachment, { attachmentId: 'c'.repeat(64) });
  await h.invoke('conflict', objective, [file]);
  await assert.rejects(h.invoke('conflict', objective + ' changed', [file]), error => rejectionStatus(error) === 409);
  await h.cold();
  const changed = { ...file, attachment: { ...file.attachment, name: 'different.csv' } };
  await assert.rejects(h.invoke('conflict', objective, [changed]), error => rejectionStatus(error) === 409);
  assert.equal(h.admissions.length, 1);
  assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
});

test('the first native step receives coordination guidance with the current team and root IDs', async t => {
  const h = commandFixture(t);
  assert.equal(h.coordinator(), '', 'ordinary sessions do not receive team-specific guidance before activation');
  await h.invoke();
  const first = h.admissions[0];
  assert.ok(first);
  assert.notEqual(first.coordinator, '', 'coordination guidance is available at the first native admission, not a later model-created team');
  const snapshot = oneTeam(h);
  assert.ok(first.coordinator.includes(snapshot.run.id));
  assert.ok(first.coordinator.includes(snapshot.run.root_task_id));
  assert.match(first.coordinator, /flow_task/);
  assert.match(first.coordinator, /flow_result/);
  assert.match(first.coordinator, /flow_review/);
});

// Each injected exception is a controlled API boundary. These tests reopen a
// real Flow SQLite database and reconstruct a real Session from the checkpoint
// above; they do not kill an OS process or exercise the native journal fsync.
for (const cut of ['after-intent', 'after-team-commit', 'after-inbox-splice'] as const) {
  test(`command retry survives ${cut} without another intent, team or admitted input`, async t => {
    const h = commandFixture(t);
    const file = fromPartial<FileBlock>({ type: 'file', attachment: { name: 'input.txt', bytes: 7 } });
    Object.assign(file.attachment, { attachmentId: 'd'.repeat(64) });
    const submission = `fault-${cut}`;
    const fault = new Error(`controlled command boundary: ${cut}`);
    let nativeSpliceCalls = 0;
    if (cut === 'after-inbox-splice') {
      h.native.send = (message, mode) => {
        assert.equal(mode, 'followup');
        nativeSpliceCalls++;
        assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
        oneTeam(h);
        // Real native followup synchronously appends this durable ingress event
        // before the user/message is consumed. Only that seam is controlled here.
        h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
        h.checkpoint();
        throw fault;
      };
    } else {
      const createTeam = h.f.flow.createTeam.bind(h.f.flow);
      h.f.flow.createTeam = async (...args) => {
        assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
        if (cut === 'after-team-commit') await createTeam(...args);
        else assert.equal(h.f.flow.teamRuns('owner').length, 0);
        assert.equal(h.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
        throw fault;
      };
    }
    await assert.rejects(h.invoke(submission, objective, [file]), error => error === fault);
    assert.equal(h.admissions.length, 0, 'the injected failure precedes normal native input consumption');
    assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
    assert.equal(h.f.flow.teamRuns('owner').length, cut === 'after-intent' ? 0 : 1);
    const committedIds = h.f.flow.teamRuns('owner').map(run => run.id);
    const originalRequest = teamIntents(h.session.snapshotEvents())[0]!.request;
    t.diagnostic(JSON.stringify({ cut, checkpoint: 'controlled Session snapshot after flush/ingress', request_id: originalRequest.id,
      intent_count: 1, committed_team_ids: committedIds, user_input_count: 0,
      inserted_input_count: h.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').reduce((n, event) => n + event.data.inserted.length, 0) }));

    // Conflict rejection must work while the failed handler's in-flight cache
    // is gone, and must not be mistaken for authorization to start new work.
    await assert.rejects(h.invoke(submission, objective + ' changed', [file]), error => rejectionStatus(error) === 409);
    await h.cold(true);
    await assert.rejects(h.invoke(submission, objective, []), error => rejectionStatus(error) === 409);
    const replies = await Promise.all([h.invoke(submission, objective, [file]), h.invoke(submission, objective, [file])]);
    replies.push(await h.invoke(submission, objective, [file]));
    assert.ok(replies.every(reply => reply.kind === 'success'));
    const snapshot = oneTeam(h);
    if (committedIds.length) assert.deepEqual([snapshot.run.id], committedIds, 'committed team identity survives controller reconstruction');
    assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
    assert.equal(teamIntents(h.session.snapshotEvents())[0]!.request.id, originalRequest.id);
    assert.deepEqual(teamIntents(h.session.snapshotEvents())[0]!.request.content, originalRequest.content);

    if (cut === 'after-inbox-splice') {
      assert.equal(nativeSpliceCalls, 1);
      assert.equal(h.admissions.length, 0, 'committed inbox ingress prevents followup despite no user/message yet');
      assert.equal(h.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
      const ingress = h.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced');
      assert.equal(ingress.length, 1);
      assert.equal(ingress[0]!.data.inserted[0]?.id, originalRequest.id);
      // Controlled native consumption, not command re-delivery. The actual
      // native Inbox lifecycle is independently covered by team-command.test.
      h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      h.session.append('user/message', originalRequest, { surfaceOp: 'append' });
    } else {
      assert.equal(h.admissions.length, 1);
    }
    const userInputs = h.session.snapshotEvents().filter(event => event.type === 'user/message');
    assert.equal(userInputs.length, 1);
    assert.equal(userInputs[0]!.data.id, originalRequest.id);
    assert.deepEqual(userInputs[0]!.data.content, originalRequest.content);
    h.checkpoint();
    await h.cold(true);
    await h.invoke(submission, objective, [file]);
    await assert.rejects(h.invoke(submission, objective + ' changed', [file]), error => rejectionStatus(error) === 409);
    await assert.rejects(h.invoke(submission, objective, []), error => rejectionStatus(error) === 409);
    assert.equal(h.f.flow.teamRuns('owner').length, 1);
    assert.equal(h.f.flow.teamRuns('owner')[0]!.id, snapshot.run.id);
    assert.equal(teamIntents(h.session.snapshotEvents()).length, 1);
    assert.equal(h.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1);
    assert.equal(h.admissions.length, cut === 'after-inbox-splice' ? 0 : 1);
    t.diagnostic(`${cut}: real SQLite reopen; controlled Session checkpoint/native seam; no OS process crash or native journal fsync claim`);
  });
}

test('one delegated natural return completes through exactly three Flow tool calls without create, leaf result or root self-review', async t => {
  const h = commandFixture(t);
  await h.invoke();
  const initial = oneTeam(h);
  const tools = new Map<string, ToolDefinition>();
  registerMemberTools(fromPartial<Context>({ tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {}; } } }), h.f.flow);
  const calls: string[] = [];
  const execute = async (name: string, args: unknown) => {
    const tool = tools.get(name); assert.ok(tool);
    calls.push(name);
    const execution = Object.assign(fromPartial<ToolRunContext>({ callId: ToolCallId(`minimal-${calls.length}`), signal: new AbortController().signal }), { agent: h.native.agent });
    return tool.execute(args, execution);
  };
  await execute('flow_task', { action: 'delegate', team_id: initial.run.id, objective: 'Produce one independent contribution' });
  const child = h.f.flow.teamRead('owner', initial.run.id).tasks.find(task => task.parent_id === initial.run.root_task_id)!;
  await until(() => h.f.handles.get(child.assignee_session_id)?.running() === true);
  const member = h.f.handles.get(child.assignee_session_id)!;
  member.finish('Contribution ready for its requester.');
  await until(() => !!h.f.flow.store.getTask(child.id)?.result_id);
  const resultId = h.f.flow.store.getTask(child.id)!.result_id!;
  await until(() => h.f.flow.store.getResult(resultId)?.ready === true);
  await execute('flow_review', { result_id: resultId, accepted: true, notes: 'Requester accepts this contribution' });
  await execute('flow_result', { task_id: initial.run.root_task_id, summary: 'Root completed with the accepted contribution' });
  const done = h.f.flow.teamRead('owner', initial.run.id);
  assert.deepEqual(calls, ['flow_task', 'flow_review', 'flow_result']);
  assert.equal(done.run.state, 'completed');
  assert.equal(done.results.length, 2);
  assert.equal(done.reviews.length, 1);
  assert.equal(done.reviews[0]!.task_id, child.id);
  assert.equal(done.results.filter(result => result.task_id === initial.run.root_task_id).length, 1);
  assert.equal(h.native.cancelled, 0);
  assert.equal(h.native.disposed, 0);
  assert.equal(h.native.running(), true, 'root completion leaves the original native main Agent free to deliver its final reply');
  await until(() => member.disposed === 1);
  // This is the minimum normal protocol path, not a bound on arbitrary tasks or
  // native business tools. Real HTTP RPC + native write/read/final return uses
  // the identical three Flow calls in tests/integration/team-command.test.ts.
  t.diagnostic('Flow protocol minimum for one accepted child = delegate + requester review + root result (3); native business calls are not counted or limited');
});
