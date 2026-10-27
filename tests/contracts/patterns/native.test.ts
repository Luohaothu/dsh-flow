import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { newSessionID } from '../../../packages/dsh-flow/src/core/message.js';
import { DshHostAdaptor } from '../../../packages/dsh-flow/src/host/dsh-adaptor.js';
import { NativePreparation } from '../../../packages/dsh-flow/src/host/provisioning.js';
import { agentControl } from '../../../packages/dsh-flow/src/core/internals.js';
import type { Context } from '../../../packages/dsh-flow/src/core/context.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { catalogControl } from '../../../packages/dsh-flow/src/patterns/internal.js';
import { applyPattern, PatternApplyError } from '../../../packages/dsh-flow/src/patterns/apply.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { issueHostOrigin, runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { input, profile, runtime } from '../../helpers/contract-runtime.js';
import type { JsonObject, RoleOverride } from '../../../packages/dsh-flow/src/patterns/types.js';

const builtinDirectory = fileURLToPath(new URL('../../../docs/design/public/patterns', import.meta.url));

async function nativeFixture(t: Parameters<typeof runtime>[0], source: PatternCatalog) {
  const f = await runtime(t), preparations = new WeakMap<Context, NativePreparation>();
  const defaults = profile('defaults');
  const origin = issueHostOrigin({ backend: 'native-pattern', callerSessionId: 'test' });
  const service = new RunService({
    store: new RunStore(join(f.directory, 'runs')), patternCatalog: source, patternRoleProvisioner: { prepare: async (root, profile, requirements) => {
      const preparation = preparations.get(root[agentControl].context); assert.ok(preparation);
      const plan = await preparation.prepare(profile, requirements); return { reserve: () => preparation.reserve(plan) };
    } },
    getOriginDefaults: () => ({ model: defaults.model, params: defaults.params, permission: defaults.permission }),
    initialize: async (run, effective, context) => {
      const preparation = new NativePreparation(f.host, context, { cwd: f.directory }); preparations.set(context, preparation);
      context.registerHostAdaptor(new DshHostAdaptor(f.host, context, { workspaceRoot: f.directory, stateDirectory: join(f.directory, run.id), preparation }));
      return Agent.create(context, { role: 'native root', name: 'native root', sessionID: newSessionID(), model: effective.model!, params: effective.params!, permission: effective.permission! }, null);
    },
  });
  const active = async () => { const run = service.create(origin, {}, newSessionID()); await runState(run).initialization; assert.equal(run.status, 'active'); assert.ok(run.root); return run; };
  return { ...f, service, origin, active };
}

function resolved(source: PatternCatalog, id: string) { const result = source.resolve(id); assert.equal(result.ok, true); if (!result.ok) throw new Error(id); return result.definition; }

test('all 14 reference packages create real rc.2 native idle members with no input or model execution', async t => {
  const source = new PatternCatalog({ builtinDirectory }), f = await nativeFixture(t, source);
  const listing = source.list(); assert.equal(listing.ok, true); if (!listing.ok) throw new Error('catalog unavailable');
  assert.equal(listing.patterns.length, 14);
  const send = t.mock.method(DshHostAdaptor.prototype, 'send'), nativeCreate = t.mock.method(f.host.agents, 'create');
  for (const entry of listing.patterns) await t.test(entry.id, async () => {
    const run = await f.active(), root = run.root!, original = root.getProfile();
    try {
      const parameters: JsonObject = Object.fromEntries(Object.entries(entry.parameters).map(([key, parameter]) => [key, parameter.default ?? 1]));
      if (entry.id === 'builtin/hierarchical') { parameters.groups = 2; parameters.membersPerGroup = 3; }
      const before = nativeCreate.mock.callCount();
      const result = await applyPattern(root, { definition: resolved(source, entry.id), parameters }, entry.id);
      const members = Object.values(result.agents).filter(agent => agent !== root);
      assert.equal(nativeCreate.mock.callCount() - before, members.length);
      assert.ok(members.length > 0); assert.ok(result.instructions.trim());
      if (entry.id === 'builtin/hierarchical') assert.equal(members.length, 13);
      for (const agent of members) {
        assert.equal(agent.getStatus(), 'idle'); assert.equal(f.native(agent).status, 'idle');
        assert.equal(agent.getMailbox().count(), 0);
        assert.deepEqual(agent.getProfile().model, run.defaults.model);
        assert.deepEqual(agent.getProfile().params, run.defaults.params);
        assert.equal(f.host.sandboxPolicy.resolve({ session: f.native(agent).session }).mode, agent.getProfile().permission);
        assert.ok(agent.getProfile().role.trim());
      }
      assert.equal(root.getProfile(), original); assert.equal(root.getStatus(), 'idle');
      assert.equal(send.mock.callCount(), 0); assert.equal(f.model.requests.length, 0);
    } finally { await f.service.release(f.origin, run); }
  });
});

test('design hierarchical-research example creates exactly 12 new native members', async t => {
  const source = new PatternCatalog({ builtinDirectory });
  const design = await readFile(new URL('../../../docs/design/design.md', import.meta.url), 'utf8');
  const start = design.indexOf('apiVersion: v1\nid: builtin/hierarchical-research');
  assert.ok(start > 0);
  const document = design.slice(start, design.indexOf('\n```', start));
  const compiled = source.compile(document); assert.equal(compiled.ok, true); if (!compiled.ok) throw new Error('example failed to compile');
  source[catalogControl].register(compiled.definition);
  const f = await nativeFixture(t, source), run = await f.active();
  try {
    const result = await applyPattern(run.root!, { definition: compiled.definition, parameters: { groups: 2, membersPerGroup: 3 } }, 'example');
    assert.equal(Object.keys(result.agents).length - 1, 12);
    assert.equal(Object.keys(result.groups).length, 3);
    assert.equal(result.agents['root/leads/0/contributors/0']!.getParent(), result.agents['root/leads/0']);
    assert.equal(result.agents['root/leads/0/verifier/0']!.getStatus(), 'idle');
    assert.equal(f.model.requests.length, 0);
  } finally { await f.service.release(f.origin, run); }
});

test('native preflight rejects unsupported capabilities and actual model/extras errors before creating any member', async t => {
  const source = new PatternCatalog({ builtinDirectory }), f = await nativeFixture(t, source), run = await f.active();
  const create = t.mock.method(f.host.agents, 'create'), send = t.mock.method(DshHostAdaptor.prototype, 'send');
  const cases: { override: RoleOverride; error: RegExp }[] = [
    { override: { preset: 'researcher' }, error: /agentPresets.*required/ },
    { override: { skills: ['research'] }, error: /skill research is unavailable/ },
    { override: { model: { provider: 'unregistered-native-provider', id: 'absent' } }, error: /provider|adapter/i },
    { override: { params: { version: 1, reasoningEffort: 'not-supported' } }, error: /does not support reasoning/ },
    { override: { hostExtras: { dsh: { seed: 5 } } }, error: /Unsupported DSH model parameter seed/ },
    { override: { hostExtras: { unsupported: true } }, error: /Unsupported HostExtras/ },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const applying = applyPattern(run.root!, { definition: resolved(source, 'builtin/shared-review'), parameters: { members: 2 }, overrides: { 'root/contributors/1': entry.override } }, `invalid-${index}`);
      await assert.rejects(applying, error => error instanceof PatternApplyError && error.path === 'root/contributors/1' && error.cause instanceof Error && entry.error.test(error.cause.message));
      assert.equal(create.mock.callCount(), 0); assert.equal(send.mock.callCount(), 0);
      assert.equal(run.root!.getChildren().length, 0); assert.equal(f.model.requests.length, 0);
    }
  } finally { await f.service.release(f.origin, run); }
});

test('template preset and skill overrides install real resources before the first native request; empty skills keeps strategy', async t => {
  const source = new PatternCatalog({ builtinDirectory }), f = await nativeFixture(t, source);
  await f.host.plugin(Loader); await f.host.plugin(Presets, { default: 'researcher' });
  const unregister = await f.host.agentPresets.register({ id: 'researcher', plugins: [] });
  const remove = f.host.skills.register({ name: 'research', description: 'Research', content: 'TEMPLATE RESEARCH BODY', source: 'runtime' });
  const run = await f.active();
  try {
    const result = await applyPattern(run.root!, { definition: resolved(source, 'builtin/shared-review'), parameters: { members: 2 }, overrides: {
      'root/contributors/0': { preset: 'researcher', skills: ['research'], instructions: 'TEMPLATE ROLE BODY' },
      'root/contributors/1': { skills: [] },
    } }, 'native-resources');
    const configured = result.agents['root/contributors/0']!, empty = result.agents['root/contributors/1']!;
    const native = f.native(configured), emptyNative = f.native(empty);
    assert.equal(f.host.agentPresets.composedPreset(native.ctx), 'researcher');
    assert.ok(await f.host.skills.get('team-strategy', { scope: scopeOf(emptyNative.ctx), cwd: f.directory }));
    assert.equal(configured.getStatus(), 'idle'); assert.equal(empty.getStatus(), 'idle'); assert.equal(f.model.requests.length, 0);
    const context = configured[agentControl].context;
    await context.getHostAdaptor().send(configured[agentControl].host, input('EXECUTE')); await native.whenIdle();
    const prompt = JSON.stringify(f.model.requests[0]?.messages);
    assert.match(prompt, /TEMPLATE ROLE BODY/); assert.match(prompt, /TEMPLATE RESEARCH BODY/); assert.match(prompt, /team-strategy/);
  } finally { await f.service.release(f.origin, run); remove(); await unregister(); }
});
