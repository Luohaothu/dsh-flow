import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import { createUserMessage, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { assignmentReadBack } from './readback.mjs';

const loader = register({ namespace: 'natural-readback-sdk' });
const { runtime } = await loader.import('../helpers/contract-runtime.ts', import.meta.url);
const { DshNativeBridge } = await loader.import('../../packages/dsh-flow/src/host/native-bridge.ts', import.meta.url);
const { PatternCatalog } = await loader.import('../../packages/dsh-flow/src/patterns/catalog.ts', import.meta.url);
const { RunService } = await loader.import('../../packages/dsh-flow/src/run/run.ts', import.meta.url);
const { RunStore } = await loader.import('../../packages/dsh-flow/src/run/store.ts', import.meta.url);
const { runState } = await loader.import('../../packages/dsh-flow/src/run/internal.ts', import.meta.url);
const { registerJsonTool } = await loader.import('../../packages/dsh-flow/src/host/tools.ts', import.meta.url);
test.after(() => loader.unregister());

async function nativeHistory(t, { kind, succeeds, reuse = true, splitTurns = false }) {
  const f = await runtime(t, { persistence: false });
  await f.host.plugin(AgentDefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  const catalog = new PatternCatalog({ includeBuiltins: false });
  const bridge = new DshNativeBridge(f.host, { stateDirectory: join(f.directory, 'bridge'), catalog });
  const service = new RunService({ store: new RunStore(join(f.directory, 'runs')), patternCatalog: catalog, patternRoleProvisioner: bridge,
    getOriginDefaults: origin => bridge.getOriginDefaults(origin), initialize: (...args) => bridge.initialize(...args),
    validateMaterials: request => bridge.validateMaterials(request) });
  t.after(() => bridge.dispose().catch(() => {}));
  const main = (await f.host.agents.create({ sessionId: SessionId('readback-main'), meta: { cwd: f.directory },
    agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } })).agent;
  bridge.attachRunService(service);
  const origin = bridge.createOrigin(main), run = service.create(origin, {}, 'own-run'), other = service.create(origin, {}, 'other-run');
  await Promise.all([runState(run).initialization, runState(other).initialization]);
  const assignment = await run.assignments.prepare({ sender: run, recipient: run.root, parentAssignment: null, spec: {
    name: 'fixture assignment', type: 'fixture', background: '', requirements: 'fixture', acceptanceCriteria: 'fixture', resultSchema: true,
  } }, 'fixture-assignment');
  const outcomes = await service.cancelAssignment(origin, run, assignment, 'fixture cancellation');
  await f.native(run.root).whenIdle();
  const snapshot = service.readAssignment(origin, run, assignment), material = join(f.directory, 'user-export.json');
  await writeFile(material, JSON.stringify(kind === 'cancel' ? outcomes : snapshot));
  t.after(registerJsonTool(main.ctx, 'fixture_read_json_file', 'Read a local JSON material file.', { type: 'object', properties: {}, additionalProperties: false },
    async () => JSON.parse(await readFile(material, 'utf8'))));
  let mainRequests = 0;
  f.model.stream = async function* (options) {
    this.requests.push(options);
    const index = options.sessionId === main.session.id ? mainRequests++ : -1;
    const name = index === 0 ? `flow_team_assignment_${kind}` : index === (splitTurns ? 2 : 1) ? 'fixture_read_json_file' : undefined;
    const args = index === 0 ? { runId: kind === 'read' && !succeeds ? other.id : run.id, assignmentId: assignment.id,
      ...(kind === 'cancel' ? { reason: succeeds ? 'valid fixture cancellation' : '' } : {}) } : {};
    const id = ToolCallId(index === 0 || reuse ? 'reused-call' : 'unrelated-call');
    const block = name ? { type: 'tool-call', id, name, arguments: JSON.stringify(args) } : { type: 'text', text: 'DONE' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    else yield { type: 'text-delta', index: 0, text: block.text };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } };
  };
  main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first fixture user boundary' }] }));
  await main.whenIdle();
  if (splitTurns) {
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'latest fixture user boundary' }] }));
    await main.whenIdle();
  }
  const events = main.session.snapshotEvents(), calls = events.filter(event => event.type === 'tool/call'), results = events.filter(event => event.type === 'tool/result');
  assert.equal(calls.length, 2); assert.equal(results.length, 2);
  assert.equal(results[0].data.message.isError, !succeeds); assert.equal(results[1].data.message.isError, false);
  assert.equal(calls[0].data.step, 1); assert.equal(calls[1].data.step, splitTurns ? 1 : 2);
  assert.equal(calls[1].data.turn, splitTurns ? 2 : 1);
  assert.deepEqual(results.map(event => event.sourceEventSeqs), calls.map(event => [event.seq]));
  assert.equal(f.model.requests.every(request => request.provider === 'fixture'), true);
  return { assignment: snapshot, events, calls, results, latestUserSeq: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').at(-1).seq };
}

for (const kind of ['read', 'cancel']) {
  for (const reuse of [false, true]) test(`actual SDK failed ${kind} cannot borrow a file result with ${reuse ? 'reused' : 'distinct'} call ID`, async t => {
    const f = await nativeHistory(t, { kind, succeeds: false, reuse });
    assert.equal(assignmentReadBack(f.assignment, f.events), false);
  });
  test(`actual SDK successful ${kind} remains eligible when another step reuses its call ID`, async t => {
    const f = await nativeHistory(t, { kind, succeeds: true });
    assert.equal(assignmentReadBack(f.assignment, f.events), true);
  });
  test(`actual SDK ${kind} before the latest user input cannot count as a new formal acknowledgement`, async t => {
    const f = await nativeHistory(t, { kind, succeeds: true, splitTurns: true });
    assert.equal(f.calls[0].seq < f.latestUserSeq && f.calls[1].seq > f.latestUserSeq, true);
    assert.equal(assignmentReadBack(f.assignment, f.events), true);
    assert.equal(assignmentReadBack(f.assignment, f.events, f.latestUserSeq), false);
  });
}

test('actual SDK readback fails closed when native result identity is missing or conflicting', async t => {
  const f = await nativeHistory(t, { kind: 'read', succeeds: true });
  for (const [name, corrupt] of [
    ['call turn missing', call => { delete call.data.turn; }],
    ['call step missing', call => { delete call.data.step; }],
    ['result turn missing', (_call, result) => { delete result.data.turn; }],
    ['result step changed', (_call, result) => { result.data.step++; }],
    ['result turn changed', (_call, result) => { result.data.turn++; }],
    ['result source missing', (_call, result) => { delete result.sourceEventSeqs; }],
    ['result source changed', (_call, result, calls) => { result.sourceEventSeqs = [calls[1].seq]; }],
    ['result sources ambiguous', (call, result, calls) => { result.sourceEventSeqs = [call.seq, calls[1].seq]; }],
    ['result source is not an array', (call, result) => { result.sourceEventSeqs = { 0: call.seq, length: 1 }; }],
    ['surface operation missing', (_call, result) => { delete result.surfaceOp; }],
    ['surface replacement', (_call, result) => { result.surfaceOp = 'replace'; }],
    ['message source missing', (_call, result) => { delete result.data.message.source; }],
    ['message source changed', (_call, result) => { result.data.message.source.callId = 'other-call'; }],
    ['message role missing', (_call, result) => { delete result.data.message.role; }],
    ['message identity missing', (_call, result) => { delete result.data.message.id; }],
    ['error on a success result', (_call, result) => { result.data.error = { message: 'conflicting error' }; }],
  ]) {
    const events = structuredClone(f.events), calls = events.filter(event => event.type === 'tool/call'), result = events.find(event => event.type === 'tool/result');
    corrupt(calls[0], result, calls);
    assert.equal(assignmentReadBack(f.assignment, events), false, name);
  }
});
