import type { Context as DshContext } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { resolveConfig, type PlainConfig, type ResolvedConfig } from './config.js';
import { registerAgentTeamCommand } from './command.js';
import { ExecutionCapacity } from './host/capacity.js';
import { DshNativeBridge, type DshNativeBridgeOptions } from './host/native-bridge.js';
import { PatternCatalog } from './patterns/catalog.js';
import { RunService } from './run/run.js';
import { RunStore } from './run/store.js';
import type { RunServiceDependencies } from './run/types.js';
import { loadAgentTeamSource, loadTeamStrategySource } from './skills.js';
import { DashboardProjector } from './dashboard/projector.js';
import { DashboardServer } from './dashboard/server.js';
import { NativeHistory } from './native/history.js';

export { PlainConfigSchema, createPlainConfigSchema, resolveConfig } from './config.js';
export type { ResolvedConfig, CleanupConfig, ConnectionConfig } from './config.js';
export const name = 'dsh-flow';
export const inject = ['agents', 'commands', 'llm', 'sessions', 'sessionProjections', 'agentDefaultModel', 'sessionController', 'sandboxPolicy', 'approval', 'tools', 'systemPrompt', 'skills', 'fs', 'attachments'];

declare module '@deepseek-ai/cordis' { interface Context { flow: FlowPlugin } }

/** Composition owns Flow resources; all native host services remain borrowed. */
export class FlowPlugin {
  private currentCatalog: PatternCatalog;
  get catalog(): PatternCatalog { return this.currentCatalog; }
  readonly capacity: ExecutionCapacity;
  readonly runs: RunService;
  readonly bridge: DshNativeBridge;
  readonly nativeHistory: NativeHistory;
  private projection?: DashboardProjector;
  get projector(): DashboardProjector { if (!this.projection) throw new Error('Dashboard is unavailable'); return this.projection; }
  private dashboard?: DashboardServer;
  get dashboardAddress(): string { if (!this.dashboard) throw new Error('Dashboard is unavailable'); return this.dashboard.address; }
  private configuration: ResolvedConfig;
  private requestedConfiguration: ResolvedConfig;
  private readonly dependencies: RunServiceDependencies;
  private readonly bridgeOptions: DshNativeBridgeOptions;
  private stopCommand: () => void = () => {};
  private stopping?: Promise<void>;
  private constructor(host: DshContext, configuration: ResolvedConfig, agentTeamSkill: Awaited<ReturnType<typeof loadAgentTeamSource>>) {
    this.configuration = configuration;
    this.requestedConfiguration = configuration;
    this.currentCatalog = new PatternCatalog({ sources: configuration.patternSources.map(directory => ({ directory })) });
    this.capacity = new ExecutionCapacity(configuration.maxConcurrentAgents);
    this.nativeHistory = new NativeHistory(host, join(configuration.stateDirectory, 'native-history'));
    this.bridgeOptions = { history: this.nativeHistory, stateDirectory: join(configuration.stateDirectory, 'agents'), capacity: this.capacity,
      catalog: this.catalog, agentTeamSkill, getConfiguration: () => this.getConfiguration() };
    this.bridge = new DshNativeBridge(host, this.bridgeOptions);
    this.dependencies = { store: new RunStore(join(configuration.stateDirectory, 'runs')), patternCatalog: this.catalog,
      patternRoleProvisioner: this.bridge,
      getOriginDefaults: origin => this.bridge.getOriginDefaults(origin),
      initialize: (run, defaults, context, origin) => this.bridge.initialize(run, defaults, context, origin),
      validateMaterials: request => this.bridge.validateMaterials(request),
      onTopLevelOutcome: (origin, run, assignment) => this.bridge.onTopLevelOutcome(origin, run, assignment),
    };
    this.runs = new RunService(this.dependencies);
  }
  static async create(host: DshContext, input: PlainConfig = {}): Promise<FlowPlugin> {
    const configuration = resolveConfig(input);
    for (const service of inject) if (!host.get(service)) throw new Error(`DSH service ${service} is required by Flow`);
    const [agentTeamSkill, strategy] = await Promise.all([loadAgentTeamSource(), loadTeamStrategySource()]);
    const runtime = new FlowPlugin(host, configuration, agentTeamSkill);
    try {
      runtime.projection = new DashboardProjector(runtime.runs, { directory: join(configuration.stateDirectory, 'events'),
        ...(configuration.connection.prices === undefined ? {} : { prices: configuration.connection.prices }) });
      runtime.dashboard = await DashboardServer.create({ projector: runtime.projector, service: runtime.runs,
        ...configuration.connection,
        staticDirectory: configuration.connection.staticDirectory ?? fileURLToPath(new URL('../web/', import.meta.url)) });
      runtime.bridge.attachRunService(runtime.runs);
      runtime.stopCommand = registerAgentTeamCommand(host, runtime.bridge, `${renderSkillContent(agentTeamSkill)}\n\n${renderSkillContent({ ...strategy, provider: strategy.provider ?? 'dsh-flow' })}`);
      return runtime;
    } catch (error) {
      try { await runtime.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Flow plugin activation and cleanup failed'); }
      throw error;
    }
  }
  getConfiguration(): ResolvedConfig { return structuredClone(this.configuration); }
  /** Requested values include fields that still require service restart to become effective. */
  getRequestedConfiguration(): ResolvedConfig { return structuredClone(this.requestedConfiguration); }
  /** New runs capture the refreshed catalog and defaults; execution admission changes now. */
  configure(input: PlainConfig): { restartRequired: string[] } {
    if (this.stopping) throw new Error('Flow plugin is stopping');
    const next = resolveConfig(input);
    const catalog = new PatternCatalog({ sources: next.patternSources.map(directory => ({ directory })) });
    const restartRequired = (['stateDirectory', 'connection'] as const)
      .filter(key => JSON.stringify(next[key]) !== JSON.stringify(this.configuration[key]));
    this.capacity.resize(next.maxConcurrentAgents);
    this.currentCatalog = catalog;
    this.dependencies.patternCatalog = catalog;
    this.bridgeOptions.catalog = catalog;
    this.requestedConfiguration = next;
    this.configuration = { ...next, stateDirectory: this.configuration.stateDirectory, connection: this.configuration.connection };
    return { restartRequired };
  }
  diagnostics() { return this.catalog.list(); }
  dispose(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try { this.stopCommand(); } catch (error) { errors.push(error); }
      try { await this.dashboard?.dispose(); } catch (error) { errors.push(error); }
      try { await this.bridge.dispose(); } catch (error) { errors.push(error); }
      try { await this.nativeHistory.dispose(); } catch (error) { errors.push(error); }
      try { this.projection?.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Flow plugin cleanup failed');
    });
    return this.stopping;
  }
}
