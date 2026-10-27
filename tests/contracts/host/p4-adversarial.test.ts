import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import Skills from '@deepseek-ai/dsh-skill';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { Agent } from '../../../packages/dsh-flow/src/core/index.js';
import { newSessionID } from '../../../packages/dsh-flow/src/core/message.js';
import type { AssignmentSpec, JsonValue, MaterialRef } from '../../../packages/dsh-flow/src/assignments/types.js';
import { DshNativeBridge, type NativeBridgeConfiguration } from '../../../packages/dsh-flow/src/host/native-bridge.js';
import { registerJsonTool } from '../../../packages/dsh-flow/src/host/tools.js';
import { applyPattern } from '../../../packages/dsh-flow/src/patterns/apply.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { profile, runtime } from '../../helpers/contract-runtime.js';

const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const spec = (materials: MaterialRef[] = []): AssignmentSpec => ({ name: 'boundary task', type: 'test', background: '', requirements: 'preserve the formal contract', acceptanceCriteria: 'exact value and caller', resultSchema: true, materials });
const promptText = (options: GenerateOptions) => [options.system, ...options.messages.flatMap(item => item.content.flatMap(block => block.type === 'text' ? [block.text] : []))].join('\n');

async function fixture(t: Parameters<typeof runtime>[0], pattern?: string) {
  const f = await runtime(t);
  await f.host.plugin(AgentDefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  let configuration: NativeBridgeConfiguration = {};
  const catalog = new PatternCatalog({ includeBuiltins: false, ...(pattern === undefined ? {} : { sources: [{ document: pattern }] }) });
  const bridge = new DshNativeBridge(f.host, { stateDirectory: join(f.directory, 'bridge'), catalog, getConfiguration: () => configuration });
  const service = new RunService({ store: new RunStore(join(f.directory, 'runs')), patternCatalog: catalog, patternRoleProvisioner: bridge,
    getOriginDefaults: origin => bridge.getOriginDefaults(origin), initialize: (...args) => bridge.initialize(...args), validateMaterials: request => bridge.validateMaterials(request) });
  bridge.attachRunService(service);
  t.after(() => bridge.dispose().catch(() => {}));
  const ordinary = async (name: string, cwd = f.directory) => (await f.host.agents.create({ sessionId: SessionId(name), meta: { cwd }, agentOptions: { provider: 'fixture', model: 'model' } })).agent;
  const active = async (main: NativeAgent, requestId: string) => {
    const origin = bridge.createOrigin(main), run = service.create(origin, {}, requestId);
    await runState(run).initialization;
    assert.equal(run.status, 'active', service.read(origin, run).error); assert.ok(run.root);
    return { origin, run, root: run.root };
  };
  const call = async (native: NativeAgent, name: string, args: Record<string, unknown>) => {
    let called = false;
    f.model.script = () => { if (called) return 'DONE'; called = true; return { tool: name, args }; };
    const before = native.session.snapshotEvents().length;
    native.followup(message(`invoke ${name}`)); await native.whenIdle();
    const results = native.session.snapshotEvents().slice(before).filter(event => event.type === 'tool/result');
    assert.equal(results.length, 1, JSON.stringify(results));
    const result = results[0]!; assert.equal(result.type, 'tool/result');
    if (result.type !== 'tool/result') throw new Error('Missing real SDK tool result');
    return { error: result.data.message.isError, content: result.data.message.content,
      text: result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') };
  };
  return { ...f, bridge, catalog, service, ordinary, active, call, configure: (value: NativeBridgeConfiguration) => { configuration = value; } };
}

test('real native flow_submit delivers all six JSON kinds, including every JSON falsy value, to the persisted Domain submission', async t => {
  const f = await fixture(t), main = await f.ordinary('json-main'), { run, root } = await f.active(main, 'json-run');
  const values: JsonValue[] = [null, false, 0, '', [], {}];
  for (const [index, value] of values.entries()) {
    const assignment = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec: spec() }, `json-${index}`);
    const result = await f.call(f.native(root), 'flow_submit', { assignmentId: assignment.id, result: value, continuingChildren: [] });
    assert.equal(result.error, false, result.text);
    const record = run.assignments!.read(run, assignment);
    assert.equal(record.status, 'submitted', result.text); assert.equal(record.submissions.length, 1);
    assert.deepEqual(record.submissions[0]!.submission.result, value);
    assert.deepEqual(record.result, value);
    assert.equal(typeof record.submissions[0]!.transportKey, 'string');
    const archived = f.service.readArchive(assignment.id); assert.equal(archived.kind, 'found');
    if (archived.kind !== 'found') throw new Error('Submitted result was not persisted');
    assert.deepEqual(archived.assignment.result, value);
    assert.deepEqual(archived.assignment.submissions[0]!.submission.result, value);
  }
});

test('two ordinary main tools isolate Run listings, assignment queries and admitted material origins', async t => {
  const f = await fixture(t), mainA = await f.ordinary('isolation-main-a'), mainB = await f.ordinary('isolation-main-b');
  const a = await f.active(mainA, 'same-request'), b = await f.active(mainB, 'same-request');
  mainA.followup(message('CONFIDENTIAL MATERIAL A')); await mainA.whenIdle();
  mainB.followup(message('CONFIDENTIAL MATERIAL B')); await mainB.whenIdle();
  const refsA = await f.bridge.materials.admitSession(mainA), refsB = await f.bridge.materials.admitSession(mainB);
  const taskA = await a.run.assignments!.prepare({ sender: a.run, recipient: a.root, parentAssignment: null, spec: spec(refsA) }, 'same-task');
  const taskB = await b.run.assignments!.prepare({ sender: b.run, recipient: b.root, parentAssignment: null, spec: spec(refsB) }, 'same-task');
  for (const [main, own, other, ownTask, otherTask] of [[mainA, a, b, taskA, taskB], [mainB, b, a, taskB, taskA]] as const) {
    const listing = await f.call(main, 'flow_teams', {}); assert.equal(listing.error, false, listing.text);
    assert.deepEqual(JSON.parse(listing.text).map((entry: { id: string }) => entry.id), [own.run.id]);
    const ownRead = await f.call(main, 'flow_team_assignment_read', { runId: own.run.id, assignmentId: ownTask.id });
    assert.equal(ownRead.error, false, ownRead.text); assert.equal(JSON.parse(ownRead.text).id, ownTask.id);
    for (const args of [{ runId: other.run.id, assignmentId: otherTask.id }, { runId: own.run.id, assignmentId: otherTask.id }]) {
      const forbidden = await f.call(main, 'flow_team_assignment_read', args); assert.equal(forbidden.error, true, forbidden.text);
    }
    const foreignRun = await f.call(main, 'flow_team_get', { runId: other.run.id }); assert.equal(foreignRun.error, true, foreignRun.text);
    const stolen = await f.call(main, 'flow_team_assign', { runId: own.run.id, spec: spec(own === a ? refsB : refsA), requestId: 'stolen-source' });
    assert.equal(stolen.error, true, stolen.text);
    const dispatch = await f.call(main, 'flow_team_assign', { runId: own.run.id, spec: spec(own === a ? refsA : refsB), requestId: 'own-source' });
    assert.equal(dispatch.error, false, dispatch.text); await f.native(own.root).whenIdle();
    const assigned = JSON.parse(dispatch.text);
    assert.deepEqual(assigned.sender, { kind: 'run', runId: own.run.id });
    assert.equal(assigned.recipientSessionID, own.root.getProfile().sessionID); assert.equal(assigned.parentAssignmentId, null);
    const memberQuery = await f.call(f.native(own.root), 'flow_assignments', {}); assert.equal(memberQuery.error, false, memberQuery.text);
    assert.deepEqual(JSON.parse(memberQuery.text).map((entry: { id: string }) => entry.id).sort(), [ownTask.id, assigned.id].sort());
  }
  assert.equal(a.run.assignments!.list(a.run).length, 2); assert.equal(b.run.assignments!.list(b.run).length, 2);
  assert.deepEqual((await f.bridge.materials.read(a.root, refsA[0]!.id)).content, [{ type: 'text', text: 'CONFIDENTIAL MATERIAL A' }]);
  await assert.rejects(f.bridge.materials.read(a.root, refsB[0]!.id), /not received/);
  await assert.rejects(f.bridge.materials.read(b.root, refsA[0]!.id), /not received/);
});

test('an actual SDK-admitted token cannot cross native instances, impersonate the same Session object, or outlive its execution', async t => {
  const f = await fixture(t), mainA = await f.ordinary('authority-a'), mainB = await f.ordinary('authority-b');
  const foreign = f.host.tools.get('flow_teams', mainB); assert.ok(foreign);
  let accepted: ToolRunContext | undefined;
  registerJsonTool(mainA.ctx, 'authority_probe', 'Check exact native execution ownership.', { type: 'object', properties: {}, additionalProperties: false }, async (_args, execution) => {
    accepted = execution;
    assert.equal(f.bridge.createOrigin(mainA, execution).callerSessionId, mainA.session.id);
    await assert.rejects(foreign.execute({}, execution), /bound live native Agent/);
    await assert.rejects(foreign.execute({}, { ...execution, agent: mainB }), /admitted native tool execution/);
    const sameSessionImpostor = Object.create(mainA) as NativeAgent;
    assert.equal(sameSessionImpostor.session.id, mainA.session.id);
    assert.throws(() => f.bridge.createOrigin(sameSessionImpostor, { ...execution, agent: sameSessionImpostor }), /ordinary live native root/);
    return { checked: true };
  });
  const result = await f.call(mainA, 'authority_probe', {}); assert.equal(result.error, false, result.text);
  assert.ok(accepted); assert.throws(() => f.bridge.createOrigin(mainA, accepted), /admitted native tool execution/);
  assert.equal(f.service.list(f.bridge.createOrigin(mainA)).length, 0); assert.equal(f.service.list(f.bridge.createOrigin(mainB)).length, 0);
});

test('reading an assignment Mailbox preserves material access and forwarding while an ordinary message grants neither', async t => {
  const f = await fixture(t), main = await f.ordinary('mailbox-material-main'), { run, root } = await f.active(main, 'mailbox-material-run');
  main.followup(message('MATERIAL WITH ASSIGNMENT AUTHORITY')); await main.whenIdle();
  const refs = await f.bridge.materials.admitSession(main), material = refs[0]!;
  const child = await Agent.create(run.context!, { ...root.getProfile(), sessionID: newSessionID(), name: 'authorized child' }, root);
  const stranger = await Agent.create(run.context!, { ...root.getProfile(), sessionID: newSessionID(), name: 'unassigned sibling' }, root);
  const top = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec: spec(refs) }, 'parent');
  const unrelated = await run.assignments!.prepare({ sender: run, recipient: root, parentAssignment: null, spec: spec() }, 'unrelated-parent');
  run.assignments!.deliver(top); await f.native(root).whenIdle();
  assert.ok(root.getMailbox().query(undefined, 'get').length > 0);
  assert.equal(root.getMailbox().count(item => !item.read), 0);
  const read = await f.call(f.native(root), 'flow_material_read', { materialId: material.id }); assert.equal(read.error, false, read.text);
  assert.match(read.text, /MATERIAL WITH ASSIGNMENT AUTHORITY/);
  stranger.recvMessage({ source: root, timestamp: Date.now(), summary: 'Copied material reference', payload: JSON.stringify(material), read: false, read_timestamp: null });
  await f.native(stranger).whenIdle();
  stranger.getMailbox().query(undefined, 'get');
  const denied = await f.call(f.native(stranger), 'flow_material_read', { materialId: material.id }); assert.equal(denied.error, true, denied.text);
  await assert.rejects(run.assignments!.prepare({ sender: root, recipient: child, parentAssignment: unrelated, spec: spec(refs) }, 'wrong-parent'), /not received or produced/);
  const forwarded = await f.call(f.native(root), 'flow_assign', { recipientSessionID: child.getProfile().sessionID, parentAssignmentId: top.id, spec: spec(refs), requestId: 'authorized-forward' });
  assert.equal(forwarded.error, false, forwarded.text); await f.native(child).whenIdle();
  child.getMailbox().query(undefined, 'get'); assert.equal(child.getMailbox().count(item => !item.read), 0);
  assert.deepEqual((await f.bridge.materials.read(child, material.id)).content, [{ type: 'text', text: 'MATERIAL WITH ASSIGNMENT AUTHORITY' }]);
});

test('cold recovery decodes every required SavedAgent and recipe field before native recovery or publication', async t => {
  const f = await runtime(t);
  await f.host.plugin(Loader); await f.host.plugin(Presets, { default: 'saved-preset' });
  const removePreset = await f.host.agentPresets.register({ id: 'saved-preset', plugins: [] });
  const removeSkill = f.host.skills.register({ name: 'saved-skill', description: 'Saved', content: 'SAVED RECIPE SKILL', source: 'runtime' });
  const originalContext = f.createContext({ cwd: f.directory, preset: 'saved-preset', skills: ['saved-skill'] });
  const p = profile('complete-saved-shape'), agent = await originalContext.create(p);
  const native = f.native(agent);
  await originalContext.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
  const path = join(f.directory, 'flow', `${createHash('sha256').update(p.sessionID).digest('hex')}.json`);
  const original: Record<string, unknown> = JSON.parse(await readFile(path, 'utf8'));
  const before = native.session.snapshotEvents();
  const required = ['format', 'version', 'profile', 'config', 'workspaceRoot', 'recipe', 'pending',
    'profile.role', 'profile.sessionID', 'profile.permission', 'profile.name', 'profile.model', 'profile.model.provider', 'profile.model.id', 'profile.params', 'profile.params.version',
    'config.provider', 'config.model', 'recipe.version', 'recipe.skills', 'recipe.strategy', 'recipe.strategy.version', 'recipe.strategy.digest',
    'recipe.preset.id', 'recipe.preset.digest', 'recipe.skills.0.name', 'recipe.skills.0.identity', 'recipe.skills.0.digest'];
  const replace = (value: Record<string, unknown>, field: string, replacement: unknown, remove: boolean) => {
    const parts = field.split('.'), key = parts.pop()!;
    let target: Record<string, unknown> = value;
    for (const part of parts) target = target[part] as Record<string, unknown>;
    if (remove) delete target[key]; else target[key] = replacement;
  };
  const mutations: { name: string; mutate(value: Record<string, unknown>): void }[] = required.flatMap(field => [
    { name: `missing ${field}`, mutate: value => replace(value, field, undefined, true) },
    { name: `wrong type ${field}`, mutate: value => replace(value, field, null, false) },
  ]);
  for (const field of ['profile.params.reasoningEffort', 'profile.params.temperature', 'profile.params.maxTokens', 'profile.hostExtras',
    'config.reasoningEffort', 'config.temperature', 'config.maxTokens', 'config.stop', 'recipe.preset']) {
    mutations.push({ name: `wrong optional ${field}`, mutate: value => replace(value, field, false, false) });
  }
  for (const mutation of mutations) {
    const corrupted = structuredClone(original); mutation.mutate(corrupted);
    await writeFile(path, JSON.stringify(corrupted));
    const restored = f.createContext({ cwd: f.directory });
    await assert.rejects(Agent.resume(restored.context, null, p.sessionID), mutation.name);
    assert.equal(f.host.agents.list().length, 0, mutation.name);
    assert.equal(restored.context.list(value => value instanceof Agent).length, 0, mutation.name);
    assert.deepEqual(native.session.snapshotEvents(), before, mutation.name);
  }
  await writeFile(path, JSON.stringify(original));
  const valid = f.createContext({ cwd: f.directory }), resumed = await Agent.resume(valid.context, null, p.sessionID);
  assert.deepEqual(resumed.getProfile(), p); assert.equal(f.host.agentPresets.composedPreset(f.native(resumed).ctx), 'saved-preset');
  assert.equal(f.model.requests.length, 0);
  await valid.context.dispose(); await originalContext.context.dispose(); removeSkill(); await removePreset();
});

test('two Run Native plans keep same-named preset skills, tools, cwd and first model requests in their own Context', async t => {
  const f = await fixture(t, JSON.stringify({ apiVersion: 'v1', id: 'test/context-isolation', description: 'Context isolation', whenToUse: 'test',
    roles: { worker: { instructions: 'ROLE SPECIFIC MEMBER' } }, root: { instructions: 'coordinate', workers: { role: 'worker' } } }));
  await f.host.plugin(Loader); await f.host.plugin(Presets, { default: 'alpha' });
  f.host.loader.builtins.skills = Skills;
  for (const id of ['alpha', 'beta']) {
    f.host.loader.builtins[`resources_${id}`] = (scope: DshContext) => {
      scope.skills.register({ name: 'shared-skill', description: `Shared ${id}`, content: `ONLY ${id.toUpperCase()} SKILL BODY`, source: 'runtime', provider: id });
      registerJsonTool(scope, `probe_${id}`, `Real ${id} preset tool.`, { type: 'object', properties: {}, additionalProperties: false }, () => ({ world: id }));
    };
    await f.host.agentPresets.register({ id, plugins: [
      { name: 'cordis:skills', isolate: { skills: id } },
      { name: `cordis:resources_${id}`, inject: ['skills', 'tools'], isolate: { skills: id } },
    ] });
  }
  const cwdA = join(f.directory, 'alpha'), cwdB = join(f.directory, 'beta'); await mkdir(cwdA); await mkdir(cwdB);
  f.configure({ defaults: { preset: 'alpha', skills: ['shared-skill'], params: { version: 1, temperature: 0.1 } }, rootRole: 'ALPHA ROOT ROLE' });
  const a = await f.active(await f.ordinary('alpha-origin', cwdA), 'alpha');
  f.configure({ defaults: { preset: 'beta', skills: ['shared-skill'], params: { version: 1, temperature: 0.9 } }, rootRole: 'BETA ROOT ROLE' });
  const b = await f.active(await f.ordinary('beta-origin', cwdB), 'beta');
  const compiled = f.catalog.resolve('test/context-isolation');
  assert.equal(compiled.ok, true); if (!compiled.ok) throw new Error(JSON.stringify(compiled));
  const members = await Promise.all([applyPattern(a.root, { definition: compiled.definition }, 'same-pattern'), applyPattern(b.root, { definition: compiled.definition }, 'same-pattern')]);
  const memberA = members[0]!.agents['root/workers/0']!, memberB = members[1]!.agents['root/workers/0']!;
  const bindingA = f.bridge.bindings.get(memberA), bindingB = f.bridge.bindings.get(memberB); assert.ok(bindingA); assert.ok(bindingB);
  assert.equal(bindingA.plan.context, a.run.context); assert.equal(bindingB.plan.context, b.run.context); assert.notEqual(bindingA.plan.context, bindingB.plan.context);
  assert.equal(bindingA.plan.cwd, cwdA); assert.equal(bindingB.plan.cwd, cwdB);
  assert.notEqual(bindingA.plan.recipe.skills[0]!.digest, bindingB.plan.recipe.skills[0]!.digest);
  assert.equal(f.model.requests.length, 0);
  for (const [member, id, other, cwd, temperature] of [[memberA, 'alpha', 'beta', cwdA, 0.1], [memberB, 'beta', 'alpha', cwdB, 0.9]] as const) {
    const native = f.native(member);
    assert.equal(native.session.header.cwd, cwd); assert.equal(f.host.agentPresets.composedPreset(native.ctx), id);
    assert.ok(f.host.tools.get(`probe_${id}`, native)); assert.equal(f.host.tools.get(`probe_${other}`, native), undefined);
    const before: number = f.model.requests.length;
    const result = await f.call(native, `probe_${id}`, {});
    assert.equal(result.error, false, result.text); assert.equal(JSON.parse(result.text).world, id);
    const request: GenerateOptions = f.model.requests[before]!;
    assert.equal(request.temperature, temperature);
    assert.match(promptText(request), new RegExp(`ONLY ${id.toUpperCase()} SKILL BODY`));
    assert.doesNotMatch(promptText(request), new RegExp(`ONLY ${other.toUpperCase()} SKILL BODY`));
    assert.match(promptText(request), /ROLE SPECIFIC MEMBER/);
  }
});
