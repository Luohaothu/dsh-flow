import { type Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { FlowPlugin } from '../plugin.js';
import { PROTOCOL_VERSION } from '../dashboard/protocol.js';
import { resolveConfig, type PlainConfig, type ResolvedConfig } from '../config.js';
import type { FlowConfigurationStatus, FlowConnection, FlowNativeAttachmentInput, FlowNativeAttachmentValue, FlowNativeFollowInput, FlowNativeFrame, FlowNativePageInput, FlowNativePageValue } from './protocol.js';

declare module '@deepseek-ai/cordis' { interface Context { flowDashboard: FlowDashboardRemote } }

export class NativeConfiguration {
  private revision = 0;
  private failure?: string;
  private requested?: ResolvedConfig;
  constructor(private readonly runtime: FlowPlugin, private readonly entryId?: string) {}
  apply(input: PlainConfig): void {
    this.revision++;
    let requested: ResolvedConfig | undefined;
    try { requested = resolveConfig(input); this.runtime.configure(input); delete this.failure; delete this.requested; }
    catch (error) { if (requested) this.requested = requested; this.failure = error instanceof Error ? error.message : String(error); }
  }
  status(): FlowConfigurationStatus {
    const effective = this.runtime.getConfiguration(), requested = this.requested ?? this.runtime.getRequestedConfiguration();
    const catalog = this.runtime.diagnostics();
    return { ...(this.entryId === undefined ? {} : { entryId: this.entryId }), effective: JSON.parse(JSON.stringify(effective)), requested: JSON.parse(JSON.stringify(requested)), restartRequired: (['stateDirectory', 'connection'] as const).filter(key => JSON.stringify(effective[key]) !== JSON.stringify(requested[key])),
      catalog: { patterns: catalog.ok ? catalog.patterns.map(({ id, description }) => ({ id, description })) : [], diagnostics: catalog.diagnostics.map(({ path, message }) => ({ path, message })) },
      application: { revision: this.revision, status: this.failure === undefined ? 'applied' : 'failed', ...(this.failure === undefined ? {} : { error: { message: this.failure } }) } };
  }
}

/** Real Flow discovery and instance-authorized native reads.
 * @typert service flowDashboard
 */
export class FlowDashboardRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly runtime: FlowPlugin, private readonly configuration: NativeConfiguration) { super(ctx, 'flowDashboard'); }
  /** Current listener address and runtime application status; credentials remain on /api/token. */
  @Remote
  connection(): FlowConnection { return { address: this.runtime.dashboardAddress, epoch: this.runtime.runs.epoch, version: PROTOCOL_VERSION, configuration: this.configuration.status() }; }
  /** Begin with one exact native snapshot, then follow only this instance's source generation. */
  @Remote({ mode: 'stream' })
  followNativeSession(input: FlowNativeFollowInput, signal: AbortSignal): AsyncIterable<FlowNativeFrame> { return this.runtime.nativeHistory.follow(input, signal); }
  /** Read a message-aligned prefix bounded by the opening snapshot and instance final cut. */
  @Remote
  pageNativeSession(input: FlowNativePageInput, signal: AbortSignal): Promise<FlowNativePageValue> { return this.runtime.nativeHistory.page(input, signal); }
  /** Read an image only after the selected instance's native prefix proves its reference. */
  @Remote
  readNativeAttachment(input: FlowNativeAttachmentInput, signal: AbortSignal): Promise<FlowNativeAttachmentValue> { return this.runtime.nativeHistory.attachment(input, signal); }
}
