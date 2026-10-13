/** Standard DSH Agent ownership and identified input; native execution stays native. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { FlowAgentProfile } from '../types.ts';
import { mainModel } from '../main-model.ts';
import { composeMemberProfile } from './profile.ts';

export interface NativeMemberOptions extends FlowAgentProfile {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly workspace: string;
  /** Creation/resume cancellation only; the returned member owns its lifetime. */
  readonly signal?: AbortSignal;
  readonly setup: (agentCtx: Context, agent: Agent) => void | Promise<void>;
  /** Non-vetoing observation of this Session's native append stream. */
  readonly onEvent?: (event: SessionEvent) => void;
}

export interface NativeMember {
  readonly agent: Agent;
  send(message: UserMessage, mode: 'followup' | 'steer' | 'notice'): void;
  whenIdle(): Promise<void>;
  /** Abort pending/current native work and wait for the Agent to drain. */
  cancel(): Promise<void>;
  dispose(): Promise<void>;
  lastText(): string;
  running(): boolean;
  events(): readonly SessionEvent[];
  /** Native durability checkpoint at a collaboration boundary, never per tool. */
  flush(): Promise<void>;
}

/** Create once, resume only when cold, and keep the same handle across turns. */
export async function createNativeMember(ctx: Context, options: NativeMemberOptions): Promise<NativeMember> {
  const id = SessionId(options.sessionId);
  options.signal?.throwIfAborted();
  if (ctx.agents.get(id)) throw new Error(`Agent ${id} already has a live owner`);
  const presets = ctx.get('agentPresets');
  if (!presets) throw new Error('The native Agent preset service is unavailable');
  const stored = await ctx.get('sessionPersistence')?.stat(id, options.signal ? { signal: options.signal } : {});
  options.signal?.throwIfAborted();
  if (stored?.header.cwd !== undefined && stored.header.cwd !== options.workspace) {
    throw new Error(`Stored Agent ${id} belongs to a different workspace`);
  }
  const parent = options.parentSessionId ? ctx.agents.get(SessionId(options.parentSessionId)) : undefined;
  const inherited = parent ? presets.composedPreset(parent.ctx) : undefined;
  // Explicit selection wins for a fresh member. A persisted Session chooses its
  // own saved selection in setup; callers cannot silently reconfigure it.
  const requested = options.preset ?? inherited;
  const freshPreset = stored ? undefined : (await presets.resolve(requested)).id;
  const model = stored ? undefined : options.model ?? ctx.agentDefaultModel.currentSelection();
  const agentOptions: AgentOptions = {
    ...(model?.provider === undefined ? {} : { provider: model.provider }),
    ...(model?.model === undefined ? {} : { model: model.model }),
    ...(model?.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
  };
  const stopObservation = options.onEvent ? ctx.on('session/event', (session, event) => {
    if (session.id !== id) return;
    try { options.onEvent?.(event); }
    catch (error) { ctx.logger.warn(error); }
  }) : () => {};
  let handle: AgentHandle;
  try {
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      if (stored) {
        // The bare Agent factory does not install SessionController's model
        // selector. Restore its public options from native durable selection
        // before publication; later UI model changes remain native-owned.
        const hasSavedModel = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending || agent.session.requestHeader();
        const savedModel = hasSavedModel ? mainModel(ctx, agent.session) : options.model ?? ctx.agentDefaultModel.currentSelection();
        Object.assign(agent.options, {
          ...(savedModel.provider === undefined ? {} : { provider: savedModel.provider }),
          ...(savedModel.model === undefined ? {} : { model: savedModel.model }),
          ...(savedModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(savedModel.reasoningEffort) }),
        });
        const selected = agent.session.snapshotEvents().findLast(event => event.type === 'agent-preset/selected');
        const savedPreset = selected?.type === 'agent-preset/selected' ? selected.data.agentPreset : agent.session.header.agentPreset;
        await presets.mount(agentCtx, savedPreset ?? options.preset);
      } else if (parent && inherited !== undefined && options.preset === undefined) {
        // Join the same live preset revision; parentSession remains lineage,
        // while the Context that called this factory owns the member handle.
        presets.composeFrom(agentCtx, parent.ctx);
      } else {
        await presets.mount(agentCtx, freshPreset);
      }
      // The factory's setup Context exposes its own declared services. Borrow
      // our injected registry and resolve explicitly in the new Agent's scope.
      await composeMemberProfile(agentCtx, agent, options, ctx.skills, options.signal);
      await options.setup(agentCtx, agent);
    };
    handle = stored
      ? await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup, ...(options.signal ? { signal: options.signal } : {}) })
      : await ctx.agents.create({
        sessionId: id,
        meta: { cwd: options.workspace, ...(options.parentSessionId ? { parentSession: SessionId(options.parentSessionId) } : {}), ...(freshPreset ? { agentPreset: freshPreset } : {}) },
        agentOptions, setup, ...(options.signal ? { signal: options.signal } : {}),
      });
  } catch (error) {
    stopObservation();
    throw error;
  }
  const agent = handle.agent;
  let disposal: Promise<void> | undefined;
  return {
    agent,
    send(message, mode) {
      if (disposal) throw new Error(`Agent ${id} is closing`);
      if (mode === 'followup') agent.followup(message);
      else if (mode === 'steer') agent.steer(message);
      else agent.inject(message);
    },
    whenIdle: () => agent.whenIdle(),
    async cancel() {
      if (disposal) return disposal;
      agent.cancel({ kind: 'user' });
      await agent.whenIdle();
    },
    dispose() {
      disposal ??= handle.dispose().finally(stopObservation);
      return disposal;
    },
    lastText() {
      const last = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message');
      if (last?.type !== 'assistant/message') return '';
      return last.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    },
    running: () => agent.status === 'running',
    events: () => agent.session.snapshotEvents(),
    async flush() { await ctx.sessions.flush(agent.session); },
  };
}
