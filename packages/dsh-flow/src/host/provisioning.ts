import { getTraceable, symbols, type Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-agent-preset-registry';
import '@deepseek-ai/dsh-fs';
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope';
import { isModelInvocable, isSkillName, renderSkillContent, type SkillDefinition, type SkillRegistry } from '@deepseek-ai/dsh-skill';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Agent, AgentProfile, Context, SessionID } from '../core/index.js';
import { agentControl, contextControl } from '../core/internals.js';
import { snapshotProfile } from '../core/profile.js';
import { freezeData } from '../core/snapshot-data.js';
import type { PatternRoleRequirements } from '../patterns/types.js';
import { loadTeamStrategySource } from '../skills.js';
import { DshConfigurationResolver } from './configuration.js';
import type { NativePlan, NativePlanLease, NativeRecipe, NativeRunSeed, NativeSkillIdentity } from './native-types.js';

export function nativeDigest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function skillIdentity(skill: SkillDefinition): NativeSkillIdentity {
  if (!skill.content.trim()) throw new Error(`Skill ${skill.name} has no instruction body`);
  if (!isModelInvocable(skill)) throw new Error(`Skill ${skill.name} is not model invocable`);
  return { name: skill.name, identity: canonical({ provider: skill.provider, path: skill.path ?? null, resourceBase: skill.resourceBase ?? null }), digest: nativeDigest(skill.content) };
}
function originalService(value: object): object {
  let current = value;
  for (;;) { const original: unknown = Reflect.get(current, symbols.original); if (!original || typeof original !== 'object' || original === current) return current; current = original; }
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`Unknown ${label} field`);
}
function text(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid ${label}`); }
function digest(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid resource digest'); }

/** Decode every persisted recipe field before the recipe is trusted by a cold resume. */
export function decodeNativeRecipe(value: unknown): NativeRecipe {
  record(value, 'native recipe'); keys(value, ['version', 'preset', 'skills', 'strategy'], 'native recipe');
  if (value.version !== 1 || !Array.isArray(value.skills)) throw new TypeError('Unsupported native recipe');
  let preset: NativeRecipe['preset'];
  if (value.preset !== undefined) {
    record(value.preset, 'preset recipe'); keys(value.preset, ['id', 'digest'], 'preset recipe');
    text(value.preset.id, 'preset id'); digest(value.preset.digest);
    preset = { id: value.preset.id, digest: value.preset.digest };
  }
  const names = new Set<string>();
  const skills = value.skills.map((item: unknown): NativeSkillIdentity => {
    record(item, 'skill recipe'); keys(item, ['name', 'identity', 'digest'], 'skill recipe');
    text(item.name, 'skill name'); text(item.identity, 'skill identity'); digest(item.digest);
    if (!isSkillName(item.name) || item.name === 'team-strategy' || names.has(item.name)) throw new TypeError('Invalid or repeated recipe skill');
    names.add(item.name); return { name: item.name, identity: item.identity, digest: item.digest };
  });
  record(value.strategy, 'strategy recipe'); keys(value.strategy, ['version', 'digest'], 'strategy recipe');
  if (value.strategy.version !== 1) throw new TypeError('Unsupported team strategy version');
  digest(value.strategy.digest);
  return freezeData({ version: 1, ...(preset === undefined ? {} : { preset }), skills, strategy: { version: 1, digest: value.strategy.digest } });
}

/** Select the service in the joined preset, falling back only to explicitly shared host services. */
export function nativeService<K extends string & keyof DshContext>(host: DshContext, scope: DshContext, name: K): DshContext[K] {
  const service = host.get('agentPresets')?.serviceFor({ ctx: scope }, name) ?? scope.get(name);
  if (!service) throw new Error(`DSH service ${name} is required in the native composition`);
  return getTraceable(scope, service);
}

const registryReservations = new WeakMap<object, Map<SessionID, object>>();
export class NativePreparation {
  private readonly plans = new WeakSet<NativePlan>();
  private readonly consumed = new WeakSet<NativePlan>();
  private readonly claimedSessions = new Map<SessionID, Agent>();
  private readonly claims = new WeakMap<NativePlan, { actual: Agent; token: object }>();
  private readonly hostReservations: Map<SessionID, object>;
  private readonly reservations = new Map<SessionID, { plan: NativePlan; token: object }>();
  readonly seed: Readonly<NativeRunSeed>;
  constructor(readonly host: DshContext, readonly context: Context, seed: NativeRunSeed) {
    if (!isAbsolute(seed.cwd)) throw new TypeError('Native cwd must be absolute');
    const registry = originalService(nativeService(host, host, 'agents'));
    let reservations = registryReservations.get(registry);
    if (!reservations) { reservations = new Map(); registryReservations.set(registry, reservations); }
    this.hostReservations = reservations;
    this.seed = freezeData(structuredClone({ ...seed, cwd: resolve(seed.cwd), ...(seed.recipe === undefined ? {} : { recipe: decodeNativeRecipe(seed.recipe) }) }));
  }
  async prepare(profile: Readonly<AgentProfile>, requirements: PatternRoleRequirements): Promise<NativePlan> {
    const p = snapshotProfile(profile);
    const base = this.seed.recipe;
    const preset = requirements.preset ?? base?.preset?.id ?? this.seed.preset;
    const skills = requirements.skills ?? base?.skills.map(skill => skill.name) ?? this.seed.skills ?? [];
    const plan = await this.prepareNative(p, preset, skills, this.seed.cwd);
    if (base && ((!same(plan.recipe.strategy, base.strategy))
      || (requirements.preset === undefined && !same(plan.recipe.preset, base.preset))
      || (requirements.preset === undefined && requirements.skills === undefined && !same(plan.recipe.skills, base.skills)))) throw new Error('Run default resources changed since the origin snapshot');
    return plan;
  }
  async prepareSaved(profile: Readonly<AgentProfile>, saved: LlmCallConfig, cwd: string, recipe: NativeRecipe): Promise<NativePlan> {
    const decoded = decodeNativeRecipe(recipe);
    const plan = await this.prepareNative(snapshotProfile(profile), decoded.preset?.id, decoded.skills.map(skill => skill.name), cwd, saved);
    if (!same(plan.recipe, decoded)) throw new Error('Persisted native resources are missing or changed');
    return plan;
  }
  private async prepareNative(profile: Readonly<AgentProfile>, preset: string | undefined, skills: readonly string[], cwd: string, saved?: LlmCallConfig): Promise<NativePlan> {
    this.context[contextControl].assertOpen();
    if (!isAbsolute(cwd)) throw new TypeError('Native cwd must be absolute');
    if (preset !== undefined && (typeof preset !== 'string' || !preset.trim())) throw new TypeError('preset must be a nonempty string');
    if (!Array.isArray(skills) || skills.some(name => typeof name !== 'string' || !isSkillName(name))) throw new TypeError('skills must contain valid skill names');
    const registry = this.host.get('agentPresets');
    if (preset !== undefined && !registry) throw new Error('DSH agentPresets service is required for preset installation');
    const declaredPreset = preset === undefined ? undefined : await this.presetRecipe(preset);
    const lease = preset === undefined ? undefined : await registry!.acquireScope(preset);
    const key = {};
    let probe: Scope | undefined;
    try {
      probe = createScope(this.host, key, lease === undefined ? {} : { parent: lease.key });
      const config = await new DshConfigurationResolver(nativeService(this.host, probe.ctx, 'llm')).configuration(profile, saved);
      this.assertLoopServices(probe.ctx);
      await this.assertExecutableConfiguration(profile, config);
      const fs = nativeService(this.host, probe.ctx, 'fs');
      const target = await fs.resolve(cwd, { cwd });
      const info = await fs.stat(target);
      if (info?.type !== 'directory') throw new Error('Native cwd is not a readable directory');
      const skillRegistry = nativeService(this.host, probe.ctx, 'skills');
      const strategy = await loadTeamStrategySource();
      skillRegistry.register(strategy);
      const actualStrategy = await this.skill(skillRegistry, 'team-strategy', key, cwd);
      if (nativeDigest(actualStrategy.content) !== nativeDigest(strategy.content)) throw new Error('Conflicting team-strategy skill body');
      const identities: NativeSkillIdentity[] = [];
      for (const name of [...new Set(skills)].filter(name => name !== 'team-strategy')) identities.push(skillIdentity(await this.skill(skillRegistry, name, key, cwd)));
      if (preset !== undefined && !same(await this.presetRecipe(preset), declaredPreset)) throw new Error('Preset declaration changed during preflight');
      this.context[contextControl].assertOpen();
      const recipe: NativeRecipe = freezeData({ version: 1, ...(declaredPreset === undefined ? {} : { preset: declaredPreset }), skills: identities, strategy: { version: 1, digest: nativeDigest(strategy.content) } });
      const plan: NativePlan = Object.freeze({ context: this.context, profile, config: freezeData(structuredClone(config)), cwd: resolve(cwd), recipe });
      this.plans.add(plan); return plan;
    } finally {
      try { await probe?.dispose(); } finally { await lease?.[Symbol.asyncDispose](); }
    }
  }
  reserve(plan: NativePlan): NativePlanLease {
    this.assertPlan(plan);
    const sessionID = plan.profile.sessionID;
    if (this.hostReservations.has(sessionID) || this.host.agents.get(SessionId(sessionID))) throw new Error('Native session already reserved or active');
    const token = {}; this.reservations.set(sessionID, { plan, token }); this.hostReservations.set(sessionID, token);
    return Object.freeze({ sessionID, dispose: () => {
      if (this.reservations.get(sessionID)?.token !== token) return;
      this.reservations.delete(sessionID);
      if (this.hostReservations.get(sessionID) === token) this.hostReservations.delete(sessionID);
    } });
  }
  consume(id: SessionID, actual: Agent, profile: Readonly<AgentProfile>): NativePlan | undefined {
    this.context[contextControl].assertOpen();
    if (actual[agentControl].context !== this.context) throw new Error('Native preparation belongs to another Context');
    const reservation = this.reservations.get(id);
    if (!reservation) {
      if (this.claimedSessions.get(id) === actual) throw new Error('Native reservation has already been consumed');
      return undefined;
    }
    const plan = reservation.plan; this.assertPlan(plan);
    if (profile.sessionID !== id || !same(profile, plan.profile)) throw new Error('Native reservation Profile differs from actual Agent');
    if (this.hostReservations.get(id) !== reservation.token) throw new Error('Native reservation is no longer exclusive');
    this.reservations.delete(id); this.consumed.add(plan); this.claimedSessions.set(id, actual);
    this.claims.set(plan, { actual, token: reservation.token }); return plan;
  }
  /** Creation failure or the exact native scope releases a consumed identity. */
  release(plan: NativePlan, actual: Agent): void {
    const claim = this.claims.get(plan);
    if (!claim || claim.actual !== actual) return;
    this.claims.delete(plan);
    if (this.hostReservations.get(plan.profile.sessionID) === claim.token) this.hostReservations.delete(plan.profile.sessionID);
  }
  private assertPlan(plan: NativePlan): void {
    this.context[contextControl].assertOpen();
    if (!this.plans.has(plan) || plan.context !== this.context) throw new Error('Native plan belongs to another preparation or Context');
    if (this.consumed.has(plan)) throw new Error('Native plan has already been consumed');
  }
  /** Mount into the exact unpublished native scope and re-read mutable capabilities. */
  async install(scope: DshContext, native: NativeAgent, plan: NativePlan): Promise<{ commit(): void }> {
    if (plan.context !== this.context || String(native.session.id) !== plan.profile.sessionID) throw new Error('Native installation identity mismatch');
    if (plan.recipe.preset) {
      if (!same(await this.presetRecipe(plan.recipe.preset.id), plan.recipe.preset)) throw new Error('Preset declaration changed after preflight');
      const registry = this.host.get('agentPresets');
      if (!registry) throw new Error('DSH agentPresets service is required for preset installation');
      await registry.mount(scope, plan.recipe.preset.id);
      if (!same(await this.presetRecipe(plan.recipe.preset.id), plan.recipe.preset)) throw new Error('Preset declaration changed while mounting');
    }
    this.assertLoopServices(scope);
    let modelChanged = false, skillsChanged = false;
    const stopModel = scope.on('llm/adapters-updated', () => { modelChanged = true; });
    const stopSkills = scope.on('skills/change', () => { skillsChanged = true; });
    const names = ['llm', 'fs', 'skills', 'systemPrompt', 'tools', 'sandboxPolicy', 'approval'] as const;
    const identities = names.map(name => originalService(nativeService(this.host, scope, name)));
    const config = await new DshConfigurationResolver(nativeService(this.host, scope, 'llm')).configuration(plan.profile, structuredClone(plan.config));
    if (!same(config, plan.config)) throw new Error('Model capability changed after preflight');
    await this.assertExecutableConfiguration(plan.profile, config);
    const fs = nativeService(this.host, scope, 'fs');
    if ((await fs.stat(await fs.resolve(plan.cwd, { cwd: plan.cwd })))?.type !== 'directory') throw new Error('Native cwd is no longer accessible');
    const skills = nativeService(this.host, scope, 'skills'), strategy = await loadTeamStrategySource();
    if (nativeDigest(strategy.content) !== plan.recipe.strategy.digest) throw new Error('Team strategy changed after preflight');
    skills.register(strategy);
    skillsChanged = false;
    const key = scopeOf(scope);
    const selected = await this.skill(skills, 'team-strategy', key, plan.cwd);
    if (nativeDigest(selected.content) !== plan.recipe.strategy.digest) throw new Error('Conflicting team-strategy skill body');
    const prompt = nativeService(this.host, scope, 'systemPrompt');
    prompt.section({ name: 'flow-team-strategy', order: 0, text: renderSkillContent(selected), interpolate: false });
    for (const expected of plan.recipe.skills) {
      const actual = await this.skill(skills, expected.name, key, plan.cwd);
      if (!same(skillIdentity(actual), expected)) throw new Error(`Skill ${expected.name} changed after preflight`);
      prompt.section({ name: `flow-skill-${expected.name}`, order: 0, text: renderSkillContent(actual), interpolate: false });
    }
    return { commit: () => {
      this.context[contextControl].assertOpen();
      scope.fiber.assertActive();
      const changed = names.filter((name, index) => originalService(nativeService(this.host, scope, name)) !== identities[index]);
      if (modelChanged || skillsChanged || changed.length) throw new Error(`Native capabilities changed during setup: ${[...(modelChanged ? ['model'] : []), ...(skillsChanged ? ['skills'] : []), ...changed].join(', ')}`);
      if (!nativeService(this.host, scope, 'llm').listProviders().some(provider => provider.id === plan.config.provider)) throw new Error('Native model provider was revoked during setup');
      if (plan.recipe.preset && this.host.get('agentPresets')?.composedPreset(scope) !== plan.recipe.preset.id) throw new Error('Native preset binding changed during setup');
      stopModel(); stopSkills();
    } };
  }
  private async presetRecipe(id: string): Promise<{ id: string; digest: string }> {
    const registry = this.host.get('agentPresets');
    if (!registry) throw new Error('DSH agentPresets service is required for preset installation');
    const resolved = await registry.resolve(id);
    if (resolved.broken) throw new Error(`Preset ${id} is broken: ${resolved.broken}`);
    const document = await registry.readDocument(id);
    return { id, digest: nativeDigest(document.content) };
  }
  private assertLoopServices(scope: DshContext): void {
    // rc.2 AgentLoop dispatches through its stable runtime's services, not the
    // preset's isolated llm/tools/prompt registries. Fail before publication.
    for (const name of ['llm', 'tools', 'systemPrompt'] as const) {
      if (originalService(nativeService(this.host, scope, name)) !== originalService(nativeService(this.host, this.host, name))) {
        throw new Error(`DSH rc.2 stable AgentLoop cannot execute preset-isolated ${name} service`);
      }
    }
  }
  private async assertExecutableConfiguration(profile: Readonly<AgentProfile>, config: LlmCallConfig): Promise<void> {
    const executable = await new DshConfigurationResolver(nativeService(this.host, this.host, 'llm')).configuration(profile, config);
    if (!same(executable, config)) throw new Error('Stable AgentLoop cannot honor the preset-scoped model configuration');
  }
  private async skill(registry: SkillRegistry, name: string, scope: object | undefined, cwd: string): Promise<SkillDefinition> {
    const skill = await registry.get(name, { scope, cwd });
    if (!skill) throw new Error(`Required skill ${name} is unavailable`);
    skillIdentity(skill); return skill;
  }
}
