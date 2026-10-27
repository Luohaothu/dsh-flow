import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context as DshContext } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import Skills from '@deepseek-ai/dsh-skill';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Agent, Context } from '../../../packages/dsh-flow/src/core/index.js';
import { NativePreparation, nativeService } from '../../../packages/dsh-flow/src/host/provisioning.js';
import { NativeFlowBindings } from '../../../packages/dsh-flow/src/host/native-bindings.js';
import { agentControl } from '../../../packages/dsh-flow/src/core/internals.js';
import { installFlowTools, registerJsonTool } from '../../../packages/dsh-flow/src/host/tools.js';
import { FixtureModel, input, profile, runtime, validSummary } from '../../helpers/contract-runtime.js';

async function researchPreset(host: DshContext, id = 'research') {
  await host.plugin(Loader);
  await host.plugin(Presets, { default: id });
  host.loader.builtins.skills = Skills;
  host.loader.builtins.fs = SandboxedFileSystem;
  host.loader.builtins.research = (scope: DshContext) => {
    scope.skills.register({ name: 'research', description: 'Research', content: 'PRESET RESEARCH INSTRUCTIONS', source: 'runtime', provider: 'fixture-research' });
    scope.skills.register({ name: 'alternate', description: 'Alternate', content: 'ALTERNATE BODY', source: 'runtime', provider: 'fixture-research' });
    registerJsonTool(scope, 'preset_probe', 'Preset probe', { type: 'object', properties: {}, additionalProperties: false }, () => ({ installed: true }));
  };
  return host.agentPresets.register({ id, plugins: [
    { name: 'cordis:skills', isolate: { skills: id } },
    { name: 'cordis:fs', config: {}, isolate: { fs: id } },
    { name: 'cordis:research', inject: ['skills', 'tools'], isolate: { skills: id } },
  ] });
}

test('native preparation is pure and reserves an immutable explicit plan', async t => {
  const f = await runtime(t);
  const preparation = new NativePreparation(f.host, f.context, { cwd: f.directory });
  const p = profile('prepared');
  const plan = await preparation.prepare(p, {});
  assert.equal(f.host.agents.list().length, 0);
  assert.equal(f.model.requests.length, 0);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.recipe.skills));
  assert.equal(await f.host.skills.get('team-strategy'), undefined);
  const lease = preparation.reserve(plan);
  assert.throws(() => preparation.reserve(plan), /reserved|reservation/i);
  lease.dispose(); lease.dispose();
  preparation.reserve(plan).dispose();
});

test('plan ownership, Profile matching and single consumption survive lease disposal', async t => {
  const f = await runtime(t), p = profile('leased');
  const plan = await f.preparation.prepare(p, {});
  const other = new NativePreparation(f.host, new Context(), { cwd: f.directory });
  assert.throws(() => other.reserve(plan), /another preparation|Context/);
  const lease = f.preparation.reserve(plan);
  const competing = await other.prepare(p, {});
  assert.throws(() => other.reserve(competing), /reserved or active/);
  const existing = await f.create('existing');
  assert.throws(() => f.preparation.consume(p.sessionID, existing, { ...p, role: 'changed' }), /Profile differs/);
  const foreign = f.createContext({ cwd: f.directory }), foreignAgent = await foreign.create(profile('foreign'));
  assert.throws(() => f.preparation.consume(p.sessionID, foreignAgent, p), /another Context/);
  const agent = await Agent.create(f.context, p, null);
  lease.dispose(); lease.dispose();
  assert.equal(f.host.agents.get(f.native(agent).session.id), f.native(agent));
  assert.throws(() => f.preparation.consume(p.sessionID, agent, p), /already been consumed/);
  assert.throws(() => f.preparation.reserve(plan), /already been consumed/);
  const available = profile('released-lease'), reserved = await f.preparation.prepare(available, {});
  f.preparation.reserve(reserved).dispose();
  const otherAvailable = await other.prepare(available, {}); other.reserve(otherAvailable).dispose();
});

test('preset-scoped skills, actual tools and role/strategy enter the first request while creation stays idle', async t => {
  const f = await runtime(t), unregister = await researchPreset(f.host);
  const c = f.createContext({ cwd: f.directory, preset: 'research', skills: ['research'] });
  const p = { ...profile('preset-member', 'read-only'), role: 'EXACT ROLE BODY' };
  const plan = await c.preparation.prepare(p, {});
  assert.ok(plan.recipe.preset?.digest); assert.equal(plan.recipe.skills[0]?.name, 'research');
  assert.equal(await f.host.skills.get('research', { cwd: f.directory }), undefined);
  const lease = c.preparation.reserve(plan);
  const agent = await c.create(p); lease.dispose();
  const native = f.native(agent);
  assert.equal(agent.getStatus(), 'idle'); assert.equal(native.status, 'idle'); assert.equal(f.model.requests.length, 0);
  assert.equal(f.host.agentPresets.composedPreset(native.ctx), 'research');
  assert.ok(f.host.tools.get('preset_probe', native)); assert.ok(f.host.tools.get('flow_read', native));
  const skills = f.host.agentPresets.serviceFor(native, 'skills'); assert.ok(skills);
  assert.equal((await skills.get('research', { cwd: f.directory, scope: scopeOf(native.ctx) }))?.content, 'PRESET RESEARCH INSTRUCTIONS');
  assert.ok(await skills.get('team-strategy', { cwd: f.directory, scope: scopeOf(native.ctx) }));
  const fs = f.host.agentPresets.serviceFor(native, 'fs'); assert.ok(fs instanceof SandboxedFileSystem);
  const policy = f.host.sandboxPolicy.resolve({ session: native.session });
  assert.equal(policy.mode, 'read-only'); assert.ok(native.session.snapshotEvents().some(event => event.type === 'approval/policy' && event.data.policy === 'never'));
  await assert.rejects(fs.writeText(await fs.resolve(join(f.directory, 'blocked.txt')), 'blocked', undefined, undefined, policy), /read.only|denied/i);
  f.model.script = (_options, index) => index === 0 ? { tool: 'preset_probe', args: {} } : 'DONE';
  await c.adaptor.send(f.hostAgent(agent), input('FIRST REQUEST')); await native.whenIdle();
  const first = f.model.requests[0]!;
  const prompt = first.messages.filter(message => message.role === 'system').flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  assert.match(prompt, /EXACT ROLE BODY/); assert.match(prompt, /PRESET RESEARCH INSTRUCTIONS/); assert.match(prompt, /skill_content name="team-strategy"/);
  const events = native.session.snapshotEvents(), call = events.find(event => event.type === 'tool/call' && event.data.name === 'preset_probe');
  assert.ok(call?.type === 'tool/call');
  assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.source.callId === call.data.callId && !event.data.message.isError && JSON.stringify(event.data.message.content).includes('installed')));
  await c.context.dispose(); await unregister();
});

test('removed or changed skills fail unpublished setup and return all reservation/scope resources', async t => {
  const f = await runtime(t), p = profile('revoked-skill');
  const remove = f.host.skills.register({ name: 'research', description: 'Research', content: 'BODY A', source: 'runtime' });
  const plan = await f.preparation.prepare(p, { skills: ['research'] });
  const lease = f.preparation.reserve(plan); remove();
  await assert.rejects(Agent.create(f.context, p, null), /skill research is unavailable/); lease.dispose();
  assert.equal(f.host.agents.list().length, 0); assert.equal(f.context.list(object => object instanceof Agent).length, 0);
  assert.equal(await f.host.skills.get('team-strategy'), undefined);
  const removeB = f.host.skills.register({ name: 'research', description: 'Research', content: 'BODY B', source: 'runtime' });
  const next = await f.preparation.prepare(p, { skills: ['research'] });
  const nextLease = f.preparation.reserve(next);
  const agent = await Agent.create(f.context, p, null); nextLease.dispose();
  assert.equal(f.native(agent).status, 'idle'); removeB();
});

test('rc.2 rejects a preset-isolated LLM that its stable AgentLoop cannot dispatch before creating sessions', async t => {
  const f = await runtime(t); await f.host.plugin(Loader); await f.host.plugin(Presets, { default: 'isolated' });
  const isolated = new FixtureModel(); f.host.loader.builtins.llm = LlmRuntime;
  f.host.loader.builtins.adapter = (scope: DshContext) => scope.llm.registerAdapter(['preset-only'], isolated);
  const unregister = await f.host.agentPresets.register({ id: 'isolated', plugins: [
    { name: 'cordis:llm', isolate: { llm: 'isolated' } },
    { name: 'cordis:adapter', inject: ['llm'], isolate: { llm: 'isolated' } },
  ] });
  const c = f.createContext({ cwd: f.directory, preset: 'isolated' }), p = profile('isolated-llm'); p.model = { provider: 'preset-only', id: 'model' };
  await assert.rejects(c.create(p), /stable AgentLoop cannot execute preset-isolated llm/);
  assert.equal(f.host.agents.list().length, 0); assert.equal(isolated.requests.length, 0); assert.equal(f.model.requests.length, 0);
  await unregister();
});

test('a required skill body changed after prepare fails setup instead of installing different instructions', async t => {
  const f = await runtime(t), p = profile('changed-skill');
  const removeA = f.host.skills.register({ name: 'research', description: 'Research', content: 'BODY A', source: 'runtime' });
  const plan = await f.preparation.prepare(p, { skills: ['research'] }), lease = f.preparation.reserve(plan);
  removeA(); const removeB = f.host.skills.register({ name: 'research', description: 'Research', content: 'BODY B', source: 'runtime' });
  await assert.rejects(Agent.create(f.context, p, null), /Skill research changed after preflight/); lease.dispose(); removeB();
  assert.equal(f.host.agents.list().length, 0); assert.equal(f.model.requests.length, 0);
  assert.equal(await f.host.skills.get('team-strategy'), undefined);
});

test('an actual same-layer strategy registration conflict is rejected before publication', async t => {
  const f = await runtime(t);
  class ConflictingBindings extends NativeFlowBindings {
    override bind(...args: Parameters<NativeFlowBindings['bind']>) {
      const binding = super.bind(...args);
      nativeService(f.host, args[0].ctx, 'skills').register({ name: 'team-strategy', description: 'Conflict', content: 'WRONG STRATEGY', source: 'runtime' });
      return binding;
    }
  }
  const c = f.createContext({ cwd: f.directory }, { bindings: new ConflictingBindings(f.host) });
  await assert.rejects(c.create(profile('strategy-conflict')), /Conflicting team-strategy skill body/);
  assert.equal(f.host.agents.list().length, 0); assert.equal(f.model.requests.length, 0);
  assert.equal(await f.host.skills.get('team-strategy'), undefined);
});

test('preset disappearance or changed declarations fail cold recovery without publishing an Agent', async t => {
  const f = await runtime(t), unregister = await researchPreset(f.host), p = profile('changed-preset');
  const original = f.createContext({ cwd: f.directory, preset: 'research', skills: ['research'] });
  const agent = await original.create(p); await original.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
  await unregister();
  const missing = f.createContext({ cwd: f.directory });
  await assert.rejects(Agent.resume(missing.context, null, p.sessionID), /Unknown agent preset/);
  const unregisterChanged = await f.host.agentPresets.register({ id: 'research', plugins: [] });
  const changed = f.createContext({ cwd: f.directory });
  await assert.rejects(Agent.resume(changed.context, null, p.sessionID), /skill research is unavailable|resources.*changed/);
  assert.equal(f.host.agents.list().length, 0); assert.equal(f.model.requests.length, 0);
  await unregisterChanged();
});

test('ordinary create, fork and herb use the Run fixed recipe after a member received a role-specific recipe', async t => {
  const f = await runtime(t), unregister = await researchPreset(f.host);
  const defaults = await f.preparation.prepare(profile('default-plan'), { preset: 'research', skills: ['research'] });
  const bindings = new NativeFlowBindings(f.host);
  const c = f.createContext({ cwd: f.directory, recipe: defaults.recipe }, { bindings });
  const parent = await c.create(profile('fixed-default-parent'));
  const p = profile('special-member'), special = await c.preparation.prepare(p, { skills: ['alternate'] });
  const lease = c.preparation.reserve(special); const member = await Agent.create(c.context, p, parent); lease.dispose();
  assert.deepEqual(bindings.get(member)?.plan.recipe.skills.map(skill => skill.name), ['alternate']);
  const fork = await member.fork();
  const ordinary = await Agent.create(c.context, profile('ordinary-child'), member);
  assert.deepEqual(bindings.get(fork)?.plan.recipe.skills.map(skill => skill.name), ['research']);
  assert.deepEqual(bindings.get(ordinary)?.plan.recipe.skills.map(skill => skill.name), ['research']);
  assert.equal(f.model.requests.length, 0);
  f.model.script = () => validSummary;
  const herb = await member.herb(parent); await f.native(herb).whenIdle();
  assert.deepEqual(bindings.get(herb)?.plan.recipe.skills.map(skill => skill.name), ['research']);
  f.host.loader.builtins.alternative = (scope: DshContext) => {
    scope.skills.register({ name: 'research', description: 'Alternative research', content: 'OTHER PRESET RESEARCH BODY', provider: 'alternative-preset', source: 'runtime' });
  };
  const unregisterAlternative = await f.host.agentPresets.register({ id: 'alternative', plugins: [
    { name: 'cordis:skills', isolate: { skills: 'alternative' } },
    { name: 'cordis:alternative', inject: ['skills'], isolate: { skills: 'alternative' } },
  ] });
  const alternateProfile = profile('alternate-preset-member');
  const alternate = await c.preparation.prepare(alternateProfile, { preset: 'alternative' });
  assert.equal(alternate.recipe.skills[0]?.name, 'research');
  assert.notEqual(alternate.recipe.skills[0]?.digest, defaults.recipe.skills[0]?.digest);
  const alternateLease = c.preparation.reserve(alternate);
  const alternateMember = await Agent.create(c.context, alternateProfile, parent); alternateLease.dispose();
  assert.equal(bindings.get(alternateMember)?.plan.recipe.preset?.id, 'alternative');
  await c.context.dispose(); await unregisterAlternative(); await unregister();
});

test('real adapter revocation between setup and publication aborts the native commit', async t => {
  const f = await runtime(t);
  const bindings = new NativeFlowBindings(f.host, { installMember: (scope, binding, guard, yieldCapacity) => {
    const disposers = installFlowTools(scope, binding.flow[agentControl].context, binding.flow, guard, yieldCapacity);
    f.modelRegistration(); return disposers;
  } });
  const c = f.createContext({ cwd: f.directory }, { bindings });
  await assert.rejects(c.create(profile('revoked-model')), /capabilities changed during setup|revoked/);
  assert.equal(f.host.agents.list().length, 0); assert.equal(f.model.requests.length, 0);
  assert.equal(await f.host.skills.get('team-strategy'), undefined);
});

test('cold resume restores its own cwd/config/preset/skills instead of new Run defaults', async t => {
  const f = await runtime(t), unregister = await researchPreset(f.host);
  const ownCwd = join(f.directory, 'original'); await mkdir(ownCwd);
  const c = f.createContext({ cwd: ownCwd, preset: 'research', skills: ['research'] });
  const p = profile('cold-resources', 'read-only'), agent = await c.create(p);
  await c.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
  const restored = f.createContext({ cwd: f.directory });
  const resumed = await Agent.resume(restored.context, null, p.sessionID), native = f.native(resumed);
  assert.equal(native.session.header.cwd, ownCwd); assert.equal(f.host.agentPresets.composedPreset(native.ctx), 'research');
  assert.equal(f.host.sandboxPolicy.resolve({ session: native.session }).mode, 'read-only');
  assert.deepEqual(resumed.getProfile(), p); assert.equal(f.model.requests.length, 0);
  await restored.adaptor.send(f.hostAgent(resumed), input('RESTORED')); await native.whenIdle();
  const prompt = JSON.stringify(f.model.requests[0]?.messages);
  assert.match(prompt, /PRESET RESEARCH INSTRUCTIONS/); assert.match(prompt, /team-strategy/);
  await restored.context.dispose(); await c.context.dispose(); await unregister();
});

test('cold resume fully decodes recipe and pending content rather than trusting a partial envelope', async t => {
  const f = await runtime(t), p = profile('invalid-metadata'), agent = await f.create(p.sessionID);
  await f.adaptor.persist(f.hostAgent(agent)); await agent.recvSignal('SIGKILL');
  const file = join(f.directory, 'flow', `${createHash('sha256').update(p.sessionID).digest('hex')}.json`);
  const original: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
  const failures = [
    { ...original, recipe: { version: 1, skills: [], strategy: { version: 1 } } },
    { ...original, config: { provider: 'fixture', model: 7 } },
    { ...original, profile: { ...p, params: { version: 1, temperature: 'bad' } } },
    { ...original, pending: [{ target: 'next-turn', message: { id: 'id', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 7 }] } }] },
    { ...original, recipe: { version: 1, skills: [], strategy: { version: 1, digest: '0'.repeat(64) } } },
  ];
  for (const value of failures) {
    await writeFile(file, JSON.stringify(value));
    const c = f.createContext({ cwd: f.directory });
    await assert.rejects(Agent.resume(c.context, null, p.sessionID), /Invalid|invalid|resources.*changed|missing/);
    assert.equal(f.host.agents.list().length, 0);
  }
});
