import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createUserMessage, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FlowPlugin } from '../../../packages/dsh-flow/src/plugin.js';
import * as Flow from '../../../packages/dsh-flow/src/index.js';
import { PlainConfigSchema, resolveConfig } from '../../../packages/dsh-flow/src/config.js';
import { loadAgentTeamSource, loadTeamStrategySource } from '../../../packages/dsh-flow/src/skills.js';
import { runtime, until } from '../../helpers/contract-runtime.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';

const promptText = (options: GenerateOptions) => [options.system, ...options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))].join('\n');
const request = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

async function pluginRuntime(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t);
  await enablePluginHost(f.host, f.directory);
  const plugin = await FlowPlugin.create(f.host, { stateDirectory: join(f.directory, 'plugin') });
  t.after(async () => { await plugin.dispose(); });
  return { ...f, plugin };
}

test('P4 config validates design fields, detached snapshots and loader diagnostics', async () => {
  const configuration = resolveConfig({ defaults: { model: { provider: 'fixture', id: 'model' }, params: { version: 1, temperature: 0.3 }, permission: 'read-only' },
    maxConcurrentAgents: 2, patternSources: ['/missing/p4-patterns'], cleanup: { immediateTimeoutMs: 25 }, connection: { port: 3222, allowedOrigins: ['https://example.test'] } });
  assert.equal(configuration.maxConcurrentAgents, 2);
  assert.equal(configuration.cleanup.gracefulTimeoutMs, 120_000);
  assert.throws(() => resolveConfig({ defaults: { params: { version: 1, top_p: 0.2 } } } as never), /top_p/);
  assert.throws(() => resolveConfig({ dataDir: '/tmp/legacy' } as never), /dataDir/);
  assert.throws(() => resolveConfig({ maxConcurrentAgents: 0 }));
  assert.throws(() => resolveConfig({ cleanup: { immediateTimeoutMs: Infinity } }));
  assert.throws(() => resolveConfig({ connection: { other: true } } as never), /other/);
  const strategy = await loadTeamStrategySource(), entry = await loadAgentTeamSource();
  assert.equal(strategy.name, 'team-strategy'); assert.equal(entry.invocation.modelInvocable, false);
  assert.equal(strategy.content, (await readFile(strategy.path!, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim());
  assert.match(strategy.content, /取消已无用途/); assert.match(strategy.content, /保持空闲/);
});

test('P4 actual command injects skill and task without creating any Run; Flow members reject', async t => {
  const f = await pluginRuntime(t);
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  f.model.script = () => 'MAIN-RECEIVED';
  const command = await f.host.commands.execute(main, '/agent-team Investigate an existing project.', [], new AbortController().signal);
  assert.equal(command?.result.kind, 'success');
  await main.whenIdle();
  assert.equal(f.plugin.runs.list(f.plugin.bridge.createOrigin(main)).length, 0);
  assert.equal(f.model.requests.length, 1);
  const firstPrompt = promptText(f.model.requests[0]!);
  assert.match(firstPrompt, /团队入口/); assert.match(firstPrompt, /团队协作策略/); assert.match(firstPrompt, /Investigate an existing project/);
  const member = await f.create('command-member');
  const before = f.model.requests.length;
  const denied = await f.host.commands.execute(f.native(member), '/agent-team should refuse', [], new AbortController().signal);
  assert.equal(denied?.result.kind, 'error'); assert.equal(f.model.requests.length, before);
  assert.equal(f.native(member).ctx.tools.get('flow_team_release', f.native(member)), undefined);
});

test('P4 ordinary existing, later-created and resumed sessions get local tools; unload cleans live sessions', async t => {
  const f = await runtime(t);
  await enablePluginHost(f.host, f.directory);
  const existing = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  const plugin = await FlowPlugin.create(f.host, { stateDirectory: join(f.directory, 'plugin'), patternSources: [join(f.directory, 'absent-patterns')] });
  t.after(() => plugin.dispose());
  assert.ok(existing.ctx.tools.get('flow_team_release', existing));
  assert.equal(f.host.tools.get('flow_team_release'), undefined);
  const laterHandle = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } });
  const later = laterHandle.agent;
  assert.ok(later.ctx.tools.get('flow_team_create', later));
  const id = later.session.id; await f.host.sessions.flush(later.session); await laterHandle.dispose();
  const resumed = await f.host.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'model' } }).then(handle => handle.agent);
  assert.ok(resumed.ctx.tools.get('flow_team_release', resumed));
  const diagnostics = plugin.diagnostics(); assert.ok(diagnostics.diagnostics.some(item => /absent-patterns/.test(item.message)));
  await plugin.dispose();
  for (const native of [existing, resumed]) {
    assert.equal(native.ctx.tools.get('flow_team_create', native), undefined);
    assert.equal(f.host.commands.find(native, 'agent-team'), undefined);
    assert.equal(f.host.agents.get(native.session.id), native);
  }
});

test('P4 Run source defaults freeze current native settings; later configuration affects only new runs', async t => {
  const f = await pluginRuntime(t);
  f.plugin.configure({ stateDirectory: join(f.directory, 'plugin'), defaults: { params: { version: 1, temperature: 0.2 } } });
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  const firstOrigin = f.plugin.bridge.createOrigin(main);
  const first = f.plugin.runs.create(firstOrigin, {}, 'first'); f.plugin.bridge.rememberRun(first, firstOrigin);
  assert.equal(first.status, 'starting');
  await until(() => first.status !== 'starting'); assert.equal(first.status, 'active');
  assert.equal(first.assignments?.list(first).length, 0); assert.equal(f.model.requests.length, 0);
  const firstProfile = first.root!.getProfile(); assert.equal(firstProfile.params.temperature, 0.2);
  f.plugin.configure({ stateDirectory: join(f.directory, 'plugin'), defaults: { permission: 'read-only', params: { version: 1, temperature: 0.6 } }, maxConcurrentAgents: 2 });
  const secondOrigin = f.plugin.bridge.createOrigin(main);
  const second = f.plugin.runs.create(secondOrigin, {}, 'second'); f.plugin.bridge.rememberRun(second, secondOrigin);
  await until(() => second.status !== 'starting'); assert.equal(second.status, 'active');
  assert.equal(second.root!.getProfile().permission, 'read-only'); assert.equal(second.root!.getProfile().params.temperature, 0.6);
  assert.deepEqual(first.root!.getProfile(), firstProfile);
  assert.equal(f.plugin.runs.create(f.plugin.bridge.createOrigin(main), {}, 'first'), first);
  assert.equal(f.plugin.capacity.limit, 2);
  const native = f.host.agents.get(SessionId(firstProfile.sessionID))!;
  assert.equal(native.ctx.tools.get('flow_team_release', native), undefined);
  native.followup(request('FIRST-PROMPT')); await native.whenIdle();
  assert.match(promptText(f.model.requests[0]!), /团队协作策略/); assert.match(promptText(f.model.requests[0]!), /管理团队成员/);
  await f.plugin.dispose();
  assert.equal(first.status, 'stopped'); assert.equal(second.status, 'stopped');
  assert.equal(f.host.agents.get(main.session.id), main);
});


test('P4 named Cordis plugin installs and unloads with real native SessionController services', async t => {
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  const mainHandle = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } });
  const main = mainHandle.agent;
  const fiber = await f.host.plugin(Flow, { stateDirectory: join(f.directory, 'installed-plugin') });
  assert.ok(f.host.get('flow')); const plugin = f.host.flow;
  assert.ok(main.ctx.tools.get('flow_team_create', main));
  const origin = plugin.bridge.createOrigin(main), run = plugin.runs.create(origin, {}, 'unload-run'); plugin.bridge.rememberRun(run, origin);
  await until(() => run.status !== 'starting'); assert.equal(run.status, 'active');
  await fiber.dispose();
  assert.equal(f.host.get('flow'), undefined);
  assert.equal(f.host.commands.find(main, 'agent-team'), undefined);
  assert.equal(main.ctx.tools.get('flow_team_create', main), undefined);
  assert.equal(run.status, 'stopped'); assert.equal(f.host.agents.get(main.session.id), main);
  const after = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } });
  assert.equal(after.agent.ctx.tools.get('flow_team_create', after.agent), undefined);
});


test('P4 unload reports real storage failure while still releasing native Run resources', async t => {
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  const stateDirectory = join(f.directory, 'cleanup-failure');
  const plugin = await FlowPlugin.create(f.host, { stateDirectory });
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  const origin = plugin.bridge.createOrigin(main), run = plugin.runs.create(origin, {}, 'cleanup-failure'); plugin.bridge.rememberRun(run, origin);
  await until(() => run.status !== 'starting'); assert.equal(run.status, 'active');
  const rootSessionID = SessionId(run.root!.getProfile().sessionID);
  await rm(join(stateDirectory, 'runs'), { recursive: true });
  await writeFile(join(stateDirectory, 'runs'), 'storage unavailable');
  await assert.rejects(plugin.dispose(), /Flow plugin cleanup failed/);
  assert.equal(f.host.agents.get(rootSessionID), undefined);
  assert.equal(f.host.agents.get(main.session.id), main);
  assert.equal(main.ctx.tools.get('flow_team_release', main), undefined);
  assert.equal(f.host.commands.find(main, 'agent-team'), undefined);
});


test('P4 changed pattern directories apply to new Run catalogs, retain diagnostics and preserve existing snapshots', async t => {
  const f = await pluginRuntime(t);
  const stateDirectory = join(f.directory, 'plugin'), pendingStateDirectory = join(f.directory, 'next-state');
  const oldSource = join(f.directory, 'old-patterns'), nextSource = join(f.directory, 'new-patterns');
  async function pattern(directory: string, id: string) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'pattern.yaml'), JSON.stringify({ apiVersion: 'v1', id, description: id, whenToUse: 'configuration test',
      roles: { worker: { instructions: 'configured work' } }, root: { instructions: 'configured coordination', workers: { role: 'worker' } } }));
  }
  await pattern(join(oldSource, 'healthy'), 'config/old');
  await pattern(join(nextSource, 'healthy'), 'config/new');
  await mkdir(join(nextSource, 'broken'), { recursive: true });
  await writeFile(join(nextSource, 'broken', 'pattern.yaml'), 'apiVersion: v1\nid: config/broken\n');
  assert.deepEqual(f.plugin.configure({ stateDirectory, patternSources: [oldSource] }).restartRequired, []);
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  const firstOrigin = f.plugin.bridge.createOrigin(main), first = f.plugin.runs.create(firstOrigin, {}, 'old-catalog');
  f.plugin.bridge.rememberRun(first, firstOrigin); await until(() => first.status !== 'starting'); assert.equal(first.status, 'active');
  const changed = f.plugin.configure({ stateDirectory: pendingStateDirectory, patternSources: [nextSource], connection: { port: 4222 } });
  assert.deepEqual(changed.restartRequired, ['stateDirectory', 'connection']);
  assert.equal(f.plugin.getConfiguration().stateDirectory, stateDirectory);
  assert.equal(f.plugin.getConfiguration().connection.port, undefined);
  assert.equal(f.plugin.getRequestedConfiguration().stateDirectory, pendingStateDirectory);
  assert.equal(f.plugin.getRequestedConfiguration().connection.port, 4222);
  assert.equal(f.plugin.catalog.resolve('config/new').ok, true); assert.equal(f.plugin.catalog.resolve('config/old').ok, false);
  assert.ok(f.plugin.diagnostics().diagnostics.length > 0, 'new invalid package diagnostics remain visible beside healthy definitions');
  const nextOrigin = f.plugin.bridge.createOrigin(main), second = f.plugin.runs.create(nextOrigin, {}, 'new-catalog');
  f.plugin.bridge.rememberRun(second, nextOrigin); await until(() => second.status !== 'starting'); assert.equal(second.status, 'active');
  f.model.script = (_options, index) => index % 2 === 0 ? { tool: 'flow_patterns', args: {} } : 'CATALOG-READ';
  async function nativeCatalog(run: typeof first): Promise<string> {
    const native = f.host.agents.get(SessionId(run.root!.getProfile().sessionID))!;
    native.followup(request('Read the current Run pattern catalog.')); await native.whenIdle();
    const result = native.session.snapshotEvents().find(event => event.type === 'tool/result');
    assert.ok(result?.type === 'tool/result'); assert.equal(result.data.message.isError, false);
    return JSON.stringify(result.data.message);
  }
  const oldCatalog = await nativeCatalog(first), nextCatalog = await nativeCatalog(second);
  assert.match(oldCatalog, /config\/old/); assert.doesNotMatch(oldCatalog, /config\/new/);
  assert.match(nextCatalog, /config\/new/); assert.doesNotMatch(nextCatalog, /config\/old/);
  await access(join(stateDirectory, 'runs', `${second.id}.json`));
  await assert.rejects(access(pendingStateDirectory));
  await f.plugin.dispose();
});


test('P4 cleanup timeout schema and resolver reject zero and preserve Native finite positive values', async t => {
  for (const key of ['gracefulTimeoutMs', 'immediateTimeoutMs'] as const) {
    for (const value of [0, -1, Infinity, NaN]) {
      assert.throws(() => PlainConfigSchema({ cleanup: { [key]: value } }), /positive|number|NaN/i);
      assert.throws(() => resolveConfig({ cleanup: { [key]: value } }), /positive|number|NaN/i);
    }
    for (const value of [Number.MIN_VALUE, 0.25, 1, 120_000]) {
      assert.equal(PlainConfigSchema({ cleanup: { [key]: value } }).cleanup?.[key], value);
      assert.equal(resolveConfig({ cleanup: { [key]: value } }).cleanup[key], value);
    }
  }
  const f = await pluginRuntime(t);
  f.plugin.configure({ stateDirectory: join(f.directory, 'plugin'), cleanup: { gracefulTimeoutMs: 120_000.25, immediateTimeoutMs: 10_000.5 } });
  const main = await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } }).then(handle => handle.agent);
  const origin = f.plugin.bridge.createOrigin(main), run = f.plugin.runs.create(origin, {}, 'positive-cleanup');
  f.plugin.bridge.rememberRun(run, origin); await until(() => run.status !== 'starting'); assert.equal(run.status, 'active');
  assert.equal(f.host.agents.get(SessionId(run.root!.getProfile().sessionID))?.status, 'idle');
  await f.plugin.dispose(); assert.equal(run.status, 'stopped');
});
