/** Runtime wiring: communication listeners and opaque execution jobs. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ResolvedConfig } from '../config.ts';
import type { FlowService } from '../service.ts';
import type * as T from '../types.ts';
import { fail } from '../errors.ts';
import { FlowAgent } from './agent.ts';
import { AgentQueue } from './agent-queue.ts';
import { MessageQueue } from './message-queue.ts';
import type { FlowStore } from './store.ts';
import type { FlowCollaboration } from './collaboration.ts';
import { createNativeMember, type NativeFactory } from './runtime.ts';
const terminal = (state: T.FlowTeamState) => ['completed', 'failed', 'cancelled'].includes(state);
export class FlowSystem {
  private readonly agents = new Map<string, FlowAgent>();
  private readonly bindings = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly executions: AgentQueue;
  private readonly messages: MessageQueue;
  private readonly abort = new AbortController();
  private readonly stopObservation: () => void;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private waking = false;
  private disposal: Promise<void> | undefined;
  readonly factory: NativeFactory;
  closed = false;
  constructor(readonly ctx: Context, config: ResolvedConfig, readonly store: FlowStore,
    private readonly facts: () => FlowCollaboration, private readonly facade: () => FlowService,
    options: { factory?: NativeFactory } = {}) {
    this.factory = options.factory ?? createNativeMember;
    this.executions = new AgentQueue(config.maxConcurrentAgents, error => this.warn(error));
    this.messages = new MessageQueue({
      pending: () => this.store.all('messages').filter(message => message.state === 'queued' && !this.store.events(message.team_id).some(event => event.type === 'message-received' && (event.data as { message_id?: string }).message_id === message.id)),
      acknowledge: message => { if (!this.closed) this.store.event(message.team_id, 'message-routed', { message_id: message.id }); },
      onError: error => this.warn(error),
    });
    this.stopObservation = ctx.on('session/event', (session, event) => {
      if (!this.closed) this.agents.get(session.id)?.observe(event);
    });
    ctx.effect(() => this.stopObservation, 'dsh-flow: addressed native input observation');
  }
  get collaboration() { return this.facts(); }
  get service() { return this.facade(); }
  get signal() { return this.abort.signal; }
  warn(error: unknown): void { if (!this.closed) this.ctx.logger.warn(error); }
  agent(sessionId: string): FlowAgent {
    let agent = this.agents.get(sessionId);
    if (!agent) {
      agent = new FlowAgent(sessionId, this); this.agents.set(sessionId, agent);
      this.messages.listen(sessionId, message => agent!.receive(message));
    }
    return agent;
  }
  observed(sessionId: string) { return this.agents.get(sessionId)?.observed ?? false; }
  events(sessionId: string) { return this.agents.get(sessionId)?.events() ?? []; }
  active(sessionId: string) { return this.agents.get(sessionId)?.active ?? false; }
  running(sessionId: string) { return this.agents.get(sessionId)?.running ?? false; }
  suspended(sessionId: string) { return this.agents.get(sessionId)?.suspended ?? false; }
  async submitMessage(message: T.FlowMessage): Promise<void> {
    this.agent(message.to_session_id);
    await this.messages.submit(message);
  }
  submitWork(sessionId: string, execute: () => Promise<void>): void {
    if (this.closed || this.jobs.has(sessionId)) return;
    const job = this.executions.submit({ key: sessionId, run: execute }).catch(error => {
      if (!this.closed) this.agent(sessionId).fail(error);
    }).finally(() => { this.jobs.delete(sessionId); this.wake(); });
    this.jobs.set(sessionId, job);
  }
  async ensureAgent(sessionId: string): Promise<Agent> {
    const member = this.store.getMember(sessionId) ?? fail('Unknown member', 404);
    const run = this.store.getTeam(member.team_id);
    if (this.closed || !run || terminal(run.state) || member.state === 'closed') fail('Member is closed; its native history remains readable', 409);
    const agent = this.agent(sessionId);
    if (agent.observed) return (await agent.ensureNative()).agent;
    this.bindings.add(sessionId);
    const binding = agent.waitForBinding();
    this.submitWork(sessionId, () => agent.bindExecution());
    try { return (await binding).agent; }
    finally { this.bindings.delete(sessionId); }
  }
  control(memberIds: readonly string[], request: T.FlowControlRequest): void {
    for (const memberId of memberIds) {
      this.executions.cancelPending(memberId);
      this.agent(memberId).control(request);
    }
  }
  wake(): void {
    if (this.closed || this.waking) return;
    this.waking = true;
    queueMicrotask(() => {
      this.waking = false;
      if (this.closed) return;
      for (const run of this.store.allTeams()) {
        this.agent(run.owner_session_id);
        for (const member of this.store.members(run.id)) this.agent(member.id);
      }
      for (const sessionId of this.bindings) { const agent = this.agent(sessionId); this.submitWork(sessionId, () => agent.bindExecution()); }
      for (const agent of this.agents.values()) agent.wake();
      this.messages.wake();
    });
  }
  async recover(): Promise<void> {
    for (const run of this.store.allTeams()) if (!terminal(run.state)) {
      this.agent(run.owner_session_id);
      for (const member of this.store.members(run.id)) this.agent(member.id).restore();
      for (const task of this.store.tasks(run.id)) if (task.status === 'SUBMITTED' && task.result_id) {
        const result = this.store.getResult(task.result_id);
        if (result?.ready) this.collaboration.notifyResult(result);
      }
    }
    this.wake(); this.armDeadline();
  }
  drainTeam(teamId: string): void {
    setImmediate(() => {
      if (this.closed) return;
      for (const member of this.store.members(teamId)) {
        this.executions.cancelPending(member.id);
        void this.agent(member.id).close().catch(error => this.warn(error));
      }
    });
  }
  armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.closed) return;
    const upcoming = this.store.allTeams().filter(run => !terminal(run.state) && run.deadline !== null).sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0))[0];
    if (!upcoming?.deadline) return;
    this.deadlineTimer = setTimeout(() => {
      if (this.closed) return;
      for (const run of this.store.allTeams()) if (!terminal(run.state) && run.deadline !== null && run.deadline <= Date.now()) void this.collaboration.control(run.owner_session_id, { team_id: run.id, target: 'team', id: run.id, action: 'cancel' }, `deadline:${run.id}`).catch(error => this.warn(error));
      this.armDeadline();
    }, Math.min(2147483647, Math.max(1, upcoming.deadline - Date.now())));
    this.deadlineTimer.unref();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true; this.abort.abort(); this.stopObservation();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    return this.disposal = (async () => {
      await this.messages.dispose();
      await Promise.allSettled([...this.agents.values()].map(agent => agent.dispose()));
      await this.executions.dispose();
      await Promise.allSettled([...this.jobs.values()]);
      this.store.close();
    })();
  }
}
