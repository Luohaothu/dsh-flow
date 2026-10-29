import { getTraceable, type Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SkillDefinition } from '@deepseek-ai/dsh-skill';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { join, resolve } from 'node:path';
import { Agent } from '../core/agent.js';
import { agentControl } from '../core/internals.js';
import type { Context, AgentProfile } from '../core/index.js';
import { newSessionID } from '../core/message.js';
import { freezeData } from '../core/snapshot-data.js';
import { checkPermission } from '../core/profile.js';
import { issueHostOrigin } from '../run/internal.js';
import type { Run, RunService } from '../run/run.js';
import type { AssignmentMaterialRequest, HostOrigin, RunDefaults } from '../run/types.js';
import type { PatternCatalog } from '../patterns/catalog.js';
import type { PatternRoleRequirements } from '../patterns/types.js';
import type { AssignmentExecutionFault, AssignmentSnapshot } from '../assignments/types.js';
import { DshHostAdaptor } from './dsh-adaptor.js';
import { ExecutionCapacity } from './capacity.js';
import { NativePreparation } from './provisioning.js';
import type { NativeRunSeed } from './native-types.js';
import { NativeCallAuthority, NativeFlowBindings, isFlowNative } from './native-bindings.js';
import { NativeMaterials } from './materials.js';
import type { NativeHistory } from '../native/history.js';
import { installMainTools } from './main-tools.js';
import { installMemberTools } from './member-tools.js';

declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap {
  'flow-outcome': { kind: 'flow-outcome'; runId: string; assignmentId: string };
  'flow-execution-fault': { kind: 'flow-execution-fault'; runId: string; recipientInstanceId: string };
} }
export interface NativeBridgeConfiguration { defaults?: RunDefaults; cwd?: string; rootRole?: string; cleanup?: { gracefulTimeoutMs: number; immediateTimeoutMs: number } }
export interface DshNativeBridgeOptions {
  history?: NativeHistory;
  stateDirectory: string;
  catalog: PatternCatalog;
  capacity?: ExecutionCapacity;
  getConfiguration?(): NativeBridgeConfiguration;
  agentTeamSkill?: SkillDefinition;
}
interface OriginSeed { defaults: RunDefaults; native: NativeRunSeed; permissionCeiling: AgentProfile['permission']; rootRole: string; cleanup?: NativeBridgeConfiguration['cleanup'] }
interface MainBinding { authority: NativeCallAuthority; dispose: (() => void)[] }
const permissionRanks = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
export class DshNativeBridge {
  readonly bindings: NativeFlowBindings;
  readonly materials: NativeMaterials;
  private readonly seeds = new WeakMap<HostOrigin, OriginSeed>();
  private readonly preparations = new WeakMap<Context, NativePreparation>();
  private readonly runs = new Map<string, Run>();
  private readonly runOrigins = new Map<Run, HostOrigin>();
  private readonly mains = new Map<NativeAgent, MainBinding>();
  private readonly disposers: (() => void)[] = [];
  private readonly controller = new AbortController();
  private readonly capacity: ExecutionCapacity;
  private service?: RunService;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(readonly host: DshContext, private readonly options: DshNativeBridgeOptions) {
    this.capacity = options.capacity ?? new ExecutionCapacity();
    this.bindings = new NativeFlowBindings(host, { installMember: (scope, binding, guard, yieldCapacity) => installMemberTools(scope, binding, this.bindings, this.materials, guard, yieldCapacity) });
    this.materials = new NativeMaterials(host, this.bindings, join(options.stateDirectory, 'materials'));
  }
  isOrdinary(native: NativeAgent): boolean {
    return !this.disposed && this.host.agents.get(native.session.id) === native && !isFlowNative(native)
      && native.session.header.origin !== 'subagent' && this.host.agents.roots().includes(native);
  }
  createOrigin(native: NativeAgent, execution?: ToolRunContext): HostOrigin {
    if (!this.isOrdinary(native)) throw new Error('Flow entry requires an ordinary live native root');
    if (execution) this.mains.get(native)?.authority.assert(execution) ?? (() => { throw new Error('Native entry tools are not installed'); })();
    const configured = structuredClone(this.options.getConfiguration?.() ?? {});
    const pending = this.host.get('sessionProjections')?.stateOf(native.session, 'modelSelection')?.pending;
    const header = native.session.requestHeader();
    const selected = pending ?? header?.config ?? this.host.get('agentDefaultModel')?.currentSelection();
    if (!selected) throw new Error('Current native model selection is unavailable');
    const model = { provider: selected.provider, id: selected.model };
    const params: AgentProfile['params'] = { version: 1 };
    if (selected.reasoningEffort !== undefined && (pending || !header || header.adapterDefaults?.reasoningEffort !== true)) params.reasoningEffort = selected.reasoningEffort;
    if (header?.config.temperature !== undefined) params.temperature = header.config.temperature;
    if (header?.config.maxTokens !== undefined && (!pending || header.adapterDefaults?.maxTokens !== true)) params.maxTokens = header.config.maxTokens;
    const policy = this.host.sandboxPolicy.resolve({ session: native.session });
    const preset = this.host.get('agentPresets')?.composedPreset(native.ctx);
    const nativePermission = policy.mode === 'danger-full-access' ? 'full-access' : policy.mode;
    const configuredPermission = configured.defaults?.permission;
    const permissionCeiling = configuredPermission && permissionRanks[configuredPermission] > permissionRanks[nativePermission] ? configuredPermission : nativePermission;
    const defaults: RunDefaults = { model, params, permission: nativePermission,
      ...(header?.config.stop ? { hostExtras: { dsh: { stop: [...header.config.stop] } } } : {}),
      ...(preset === undefined ? {} : { preset }), ...configured.defaults };
    const cwd = configured.cwd ?? native.session.header.cwd;
    if (!cwd) throw new Error('Originating native Session has no cwd');
    const origin = issueHostOrigin({ backend: 'dsh', callerSessionId: native.session.id });
    const seed: OriginSeed = { defaults, permissionCeiling, native: { cwd: resolve(cwd),
      ...(defaults.preset === undefined ? {} : { preset: defaults.preset }), ...(defaults.skills === undefined ? {} : { skills: defaults.skills }) },
      rootRole: configured.rootRole ?? '管理团队成员、正式作业与交付。按需读取 team-strategy，保持空闲直到收到作业。',
      ...(configured.cleanup === undefined ? {} : { cleanup: configured.cleanup }) };
    this.seeds.set(origin, freezeData(structuredClone(seed))); return origin;
  }
  getOriginDefaults(origin: HostOrigin): RunDefaults { return structuredClone(this.seed(origin).defaults); }
  async initialize(run: Run, defaults: RunDefaults, context: Context, origin: HostOrigin): Promise<Agent> {
    const seed = this.seed(origin);
    this.rememberRun(run, origin);
    if (!defaults.model || !defaults.permission) throw new Error('Run model and permission must resolve before initialization');
    const profile: AgentProfile = { sessionID: newSessionID(), name: '团队根', role: seed.rootRole, model: defaults.model,
      permission: defaults.permission, params: defaults.params ?? { version: 1 }, ...(defaults.hostExtras === undefined ? {} : { hostExtras: defaults.hostExtras }) };
    try { checkPermission(profile, { ...profile, permission: seed.permissionCeiling }); }
    catch (error) { throw new Error('Run initial permission exceeds trusted native authority ceiling', { cause: error }); }
    const preparation = new NativePreparation(this.host, context, { ...seed.native,
      ...(defaults.preset === undefined ? {} : { preset: defaults.preset }), ...(defaults.skills === undefined ? {} : { skills: defaults.skills }) });
    this.preparations.set(context, preparation);
    const plan = await preparation.prepare(profile, {});
    const runPreparation = new NativePreparation(this.host, context, { ...seed.native, recipe: plan.recipe });
    this.preparations.set(context, runPreparation);
    const adaptor = new DshHostAdaptor(this.host, context, { workspaceRoot: seed.native.cwd, stateDirectory: join(this.options.stateDirectory, 'agents'),
      capacity: this.capacity, preparation: runPreparation, bindings: this.bindings,
      ...(this.options.history ? { history: this.options.history, runId: run.id } : {}),
      ...(seed.cleanup ? { afterTurnTimeoutMs: seed.cleanup.gracefulTimeoutMs, immediateTimeoutMs: seed.cleanup.immediateTimeoutMs } : {}) });
    context.registerHostAdaptor(adaptor);
    return Agent.create(context, profile, null);
  }
  async prepare(root: Agent, profile: Readonly<AgentProfile>, requirements: PatternRoleRequirements) {
    const preparation = this.preparations.get(root[agentControl].context);
    if (!preparation) throw new Error('Pattern root has no native Run preparation');
    const plan = await preparation.prepare(profile, requirements);
    return Object.freeze({ reserve: () => preparation.reserve(plan) });
  }
  validateMaterials(request: AssignmentMaterialRequest): Promise<void> { return this.materials.validate(request, this.controller.signal); }
  admitCommand(invocation: Pick<CommandInvocation, 'agent' | 'commandId' | 'attachments'>) {
    if (!this.isOrdinary(invocation.agent)) throw new Error('Team command requires an ordinary native session');
    return this.materials.admitCommand(invocation);
  }
  rememberRun(run: Run, origin?: HostOrigin): void { this.runs.set(run.id, run); if (origin && !this.runOrigins.has(run)) this.runOrigins.set(run, origin); }
  resolveRun(origin: HostOrigin, id: string): Run {
    const run = this.runs.get(id);
    if (!run || !this.service) throw new Error('Run is unavailable or expired after restart');
    this.service.read(origin, run); return run;
  }
  attachRunService(service: RunService): void {
    if (this.disposed || this.service) throw new Error('Native RunService may only be attached once');
    this.service = service;
    try {
      this.disposers.push(this.host.on('agent/created', ({ agent }) => { this.installMain(agent); }));
      this.disposers.push(this.host.on('agent/disposed', ({ agent }) => { this.releaseMain(agent); }));
      for (const native of this.host.agents.list()) this.installMain(native);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const native of [...this.mains.keys()]) try { this.releaseMain(native); } catch (cleanup) { failures.push(cleanup); }
      for (const dispose of this.disposers.splice(0).reverse()) try { dispose(); } catch (cleanup) { failures.push(cleanup); }
      delete this.service;
      if (failures.length > 1) throw new AggregateError(failures, 'Native RunService attachment and rollback failed');
      throw error;
    }
  }
  private installMain(native: NativeAgent): void {
    if (!this.isOrdinary(native) || this.mains.has(native)) return;
    const authority = new NativeCallAuthority(this.host, native);
    const record: MainBinding = { authority, dispose: [] }; this.mains.set(native, record);
    try {
      if (this.options.agentTeamSkill) {
        const skills = this.host.get('agentPresets')?.serviceFor(native, 'skills') ?? native.ctx.get('skills');
        if (!skills) throw new Error('Ordinary Agent skill registry is unavailable');
        record.dispose.push(getTraceable(native.ctx, skills).register(this.options.agentTeamSkill));
      }
      record.dispose.push(...installMainTools(native, this, this.service!, execution => {
        if (!this.isOrdinary(native)) throw new Error('Native main Agent is no longer live'); authority.assert(execution);
      }));
    } catch (error) { this.releaseMain(native); throw error; }
  }
  private releaseMain(native: NativeAgent): void {
    const record = this.mains.get(native); if (!record) return;
    this.mains.delete(native);
    const failures: unknown[] = [];
    for (const dispose of record.dispose.reverse()) try { dispose(); } catch (error) { failures.push(error); }
    try { record.authority.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Native main bindings failed to release');
  }
  async onTopLevelOutcome(origin: HostOrigin, run: Run, assignment: AssignmentSnapshot): Promise<void> {
    const main = await this.originatingMain(origin);
    main.followup(createUserMessage({ source: { kind: 'flow-outcome', runId: run.id, assignmentId: assignment.id }, content: [{ type: 'text', text: JSON.stringify({ runId: run.id, assignmentId: assignment.id, status: assignment.status, query: 'flow_team_assignment_read' }) }] }));
  }
  async onTopLevelExecutionFault(origin: HostOrigin, run: Run, fault: AssignmentExecutionFault): Promise<void> {
    const owner = this.runOrigins.get(run);
    if (!owner || owner.backend !== origin.backend || owner.callerSessionId !== origin.callerSessionId || fault.runId !== run.id) throw new Error('Execution fault origin does not own this Run');
    if (run.status !== 'active') return;
    const main = await this.originatingMain(origin);
    if (run.status !== 'active') return;
    main.followup(createUserMessage({ source: { kind: 'flow-execution-fault', runId: run.id, recipientInstanceId: fault.recipientInstanceId },
      content: [{ type: 'text', text: JSON.stringify({ ...fault, query: 'flow_team_assignment_read', instruction: '接收者的执行轮次失败；所列作业在失败时尚未结束。读取当前状态后决定继续、取消或重派。' }) }] }));
  }
  private async originatingMain(origin: HostOrigin): Promise<NativeAgent> {
    this.controller.signal.throwIfAborted();
    if (!this.host.get('sessionController')) throw new Error('Native SessionController is required for outcome delivery');
    const resolved = await this.host.sessionController.resolveAgent(SessionId(origin.callerSessionId));
    this.controller.signal.throwIfAborted();
    if ('error' in resolved) throw new Error(`Could not restore originating session: ${resolved.error.message}`);
    if (!this.isOrdinary(resolved.agent) || resolved.agent.session.id !== origin.callerSessionId) throw new Error('Originating native Session is not live');
    return resolved.agent;
  }
  private seed(origin: HostOrigin): OriginSeed { const seed = this.seeds.get(origin); if (!seed) throw new Error('Origin was not issued by this NativeBridge'); return seed; }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.controller.abort(new Error('Flow native bridge disposed'));
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const native of [...this.mains.keys()]) this.releaseMain(native);
    this.disposal = (async () => {
      const outcomes = await Promise.allSettled([...this.runOrigins].map(([run, origin]) => this.service!.release(origin, run)));
      this.bindings.dispose(); this.runs.clear(); this.runOrigins.clear();
      const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Native Flow Run release failed');
    })();
    return this.disposal;
  }
}
