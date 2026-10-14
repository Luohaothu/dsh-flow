/** A single Session owns its communication callbacks and native execution. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type * as T from '../types.ts';
import { fail } from '../errors.ts';
import type { NativeMember } from './runtime.ts';
import { registerMemberTools } from './member-tools.ts';
import type { FlowSystem } from './system.ts';
const terminal = (state: T.FlowTeamState) => ['completed', 'failed', 'cancelled'].includes(state);
export class FlowAgent {
  private handle: NativeMember | undefined;
  private creation: Promise<NativeMember> | undefined;
  private activity: Promise<void> | undefined;
  private suspension = false;
  private readonly taskInputs = new Map<string, string>();
  private readonly publishedMessages = new Set<string>();
  private readonly pendingMessages = new Map<string, UserMessage>();
  private binding: { promise: Promise<NativeMember>; resolve: (member: NativeMember) => void; reject: (error: unknown) => void } | undefined;
  private closing: Promise<void> | undefined;
  constructor(readonly sessionId: string, private readonly system: FlowSystem) {}
  private get store() { return this.system.store; }
  private get closed() { return this.system.closed; }
  get observed() { return !!this.handle; }
  get active() { return !!this.activity || !!this.creation; }
  get suspended() { return this.suspension; }
  get running() { return this.handle?.running() ?? false; }
  events() { return this.handle?.events() ?? []; }
  private member() { return this.store.getMember(this.sessionId) ?? fail('Unknown member', 404); }
  private run(id: string) { return this.store.getTeam(id) ?? fail('Unknown team', 404); }
  private taskOf(id: string) { return this.store.getTask(id) ?? fail('Unknown task', 404); }
  async send(request: T.FlowMessageRequest, operationId?: string): Promise<T.FlowMessage> {
    const message = this.system.collaboration.recordMessage(this.sessionId, request, operationId);
    await this.system.submitMessage(message);
    return this.store.getMessage(message.id) ?? message;
  }
  async receive(message: T.FlowMessage): Promise<void> {
    if (this.closed) return;
    this.store.transaction(() => {
      if (!this.store.events(message.team_id).some(event => event.type === 'message-received' && (event.data as { message_id?: string }).message_id === message.id))
        this.store.event(message.team_id, 'message-received', { message_id: message.id, session_id: this.sessionId });
    });
    // Communication stays responsive while this Session's execution job runs.
    const native = this.handle?.agent ?? this.system.ctx.agents.get(SessionId(this.sessionId));
    if (native && (native.status === 'running' || message.mode === 'notice' || !this.store.getMember(this.sessionId))) await this.deliver(message);
    else this.wake();
  }
  confirmInput(event: SessionEvent): void {
    if (this.closed || event.type !== 'user/message' || event.data.source.kind !== 'flow-message') return;
    const message = this.store.getMessage(event.data.source.message_id);
    if (message && message.to_session_id === this.sessionId && message.state === 'queued') this.store.transaction(() => {
      this.store.put('messages', { ...message, state: 'delivered', delivered_at: Date.now() });
      this.store.event(message.team_id, 'message-delivered', { message_id: message.id });
    });
  }
  recordControl(request: T.FlowControlRequest): void {
    const member = this.store.getMember(this.sessionId);
    if (!member) return;
    if (member.active_task_id) this.taskInputs.delete(member.active_task_id);
    if (request.action === 'resume') this.suspension = false;
    else if (request.target !== 'task') this.suspension = true;
    if (request.target !== 'task') this.store.put('members', { ...member,
      state: request.action === 'cancel' ? 'closed' : request.action === 'pause' ? 'paused' : 'idle', updated: Date.now() });
    if (request.action === 'cancel' && request.target !== 'task') this.binding?.reject(new Error('Member is closed; native binding cancelled'));
  }
  control(request: T.FlowControlRequest): void {
    this.recordControl(request);
    if (request.action === 'resume') { this.wake(); return; }
    setImmediate(() => {
      if (this.closed) return;
      void (request.action === 'cancel' && request.target !== 'task' ? this.close() : this.handle?.cancel())
        ?.catch(error => this.system.warn(error)).finally(() => this.system.wake());
    });
  }
  resetFailure(): void {
    const member = this.member();
    if (member.state === 'failed') this.store.put('members', { ...member, state: 'idle', error: null, updated: Date.now() });
  }
  fail(error: unknown): void {
    if (this.closed) return;
    const member = this.store.getMember(this.sessionId);
    if (!member) { this.system.warn(error); return; }
    if (member.state === 'closed' || terminal(this.run(member.team_id).state)) return;
    this.store.transaction(() => {
      this.store.put('members', { ...member, state: 'failed', error: error instanceof Error ? error.message : String(error), updated: Date.now() });
      this.system.collaboration.failed(this.sessionId, error);
    });
  }
  restore(): void {
    const member = this.store.getMember(this.sessionId);
    if (!member) return;
    this.suspension = member.state === 'paused' || this.run(member.team_id).state === 'paused';
    if (member.state === 'running') this.store.put('members', { ...member, state: 'idle', updated: Date.now() });
  }
  private eligibleTask(): T.FlowTask | undefined {
    const member = this.store.getMember(this.sessionId);
    if (!member || this.suspension || ['closed', 'failed'].includes(member.state) || this.run(member.team_id).state !== 'running') return;
    return this.store.tasks(member.team_id).find(task => task.assignee_session_id === this.sessionId && task.id !== this.run(task.team_id).root_task_id && task.status === 'OPEN' && !task.paused && this.taskInputs.get(task.id) !== `${task.version}`);
  }
  private messages(): T.FlowMessage[] {
    return this.store.all('messages').filter(message => message.to_session_id === this.sessionId && message.state === 'queued' && !this.publishedMessages.has(message.id) && this.canReceive(message));
  }
  private canReceive(message: T.FlowMessage): boolean {
    const run = this.run(message.team_id), member = this.store.getMember(this.sessionId);
    return !terminal(run.state) && (member?.team_id !== run.id || (run.state !== 'paused' && !this.suspension && member.state !== 'closed'));
  }
  wake(): void {
    if (this.closed || this.closing || this.active) return;
    const member = this.store.getMember(this.sessionId);
    if (!member && !this.system.ctx.agents.get(SessionId(this.sessionId))) return;
    const submitted = member?.active_task_id ? this.store.getTask(member.active_task_id) : undefined;
    const needsCheckpoint = submitted?.status === 'SUBMITTED' && submitted.result_id && !this.store.getResult(submitted.result_id)?.ready && !this.suspension && this.run(submitted.team_id).state === 'running';
    if (this.eligibleTask() || needsCheckpoint || this.messages().some(message => message.mode === 'request' || this.handle))
      this.system.submitWork(this.sessionId, () => this.execute());
  }
  private async execute(): Promise<void> {
    if (this.closed || this.closing) return;
    const task = this.eligibleTask();
    const member = this.store.getMember(this.sessionId);
    if (!member) { for (const message of this.messages()) await this.deliver(message); return; }
    const submitted = member.active_task_id ? this.store.getTask(member.active_task_id) : undefined;
    if (!task && !this.messages().some(message => message.mode === 'request' || this.handle) && !(submitted?.status === 'SUBMITTED' && !this.suspension)) return;
    const handle = await this.ensureNative();
    if (this.closed || this.closing) return;
    if (task) {
      const current = this.taskOf(task.id), run = this.run(task.team_id);
      if (run.state === 'running' && !this.suspension && !current.paused && current.version === task.version && current.status === 'OPEN') {
        this.store.put('members', { ...this.member(), active_task_id: task.id, state: 'running', updated: Date.now() });
        this.taskInputs.set(task.id, `${task.version}`);
        const alreadyQueued = [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].some(input => input.source.kind === 'flow-task' && input.source.task_id === task.id && input.source.task_version === task.version);
        const priorInput = handle.events().some(event => event.type === 'user/message' && event.data.source.kind === 'flow-task' && event.data.source.task_id === task.id && event.data.source.task_version === task.version);
        if (!alreadyQueued && !(priorInput && handle.running())) {
            const input = createUserMessage({ source: { kind: 'flow-task', team_id: run.id, task_id: task.id, task_version: task.version }, content: [{ type: 'text', text: `${priorInput ? 'Continue from your native Session history and completed actions.\n' : ''}Task ${task.id} (version ${task.version}), owner ${task.owner_session_id}\n${task.objective}\nWorkspace: ${run.workspace}\nUse your standard native tools. Business scripts and temporary files follow the task's output-directory restrictions. Delegate independent business work with flow_task when useful; check existing child deliverables and flow_review their results. If waiting is all that remains, return naturally; result messages resume the work. Finish with one concise final reply giving artifact paths, checks and limitations: the completed native return is published for owner review. For incomplete work, explicitly flow_result with partial or blocked. An explicit result needs only a brief final acknowledgement.` }] });
            handle.send(input, handle.running() ? 'steer' : 'followup');
        }
      }
    }
    for (const message of this.messages()) await this.deliver(message);
    do { await this.watch(handle); } while (!this.closed && handle.running());
  }
  waitForBinding(): Promise<NativeMember> {
    if (this.handle) return Promise.resolve(this.handle);
    if (!this.binding) {
      let resolve!: (member: NativeMember) => void, reject!: (error: unknown) => void;
      const promise = new Promise<NativeMember>((yes, no) => { resolve = yes; reject = no; });
      this.binding = { promise, resolve, reject };
    }
    return this.binding.promise;
  }
  async bindExecution(): Promise<void> {
    const member = this.member();
    if (this.closed || this.closing || member.state === 'closed' || terminal(this.run(member.team_id).state)) {
      this.binding?.reject(new Error('Member is closed; native binding cancelled')); return;
    }
    const native = await this.ensureNative();
    const task = member.active_task_id ? this.store.getTask(member.active_task_id) : undefined;
    if (native.running() || (task?.status === 'SUBMITTED' && task.result_id && !this.store.getResult(task.result_id)?.ready)) await this.waitForExecution();
  }
  async waitForExecution(): Promise<void> { if (this.handle) do { await this.watch(this.handle); } while (!this.closed && this.handle.running()); }
  async ensureNative(): Promise<NativeMember> {
    if (this.closed) fail('Flow is closed', 409);
    if (this.handle) return this.handle;
    if (this.creation) return this.creation;
    const member = this.member(), run = this.run(member.team_id), model = member.model ?? run.model;
    this.creation = this.system.factory(this.system.ctx, { sessionId: this.sessionId, name: member.name, role: member.role ?? 'worker', ...(member.instructions ? { instructions: member.instructions } : {}), ...(member.skills ? { skills: member.skills } : {}), ...(member.parent_id ? { parentSessionId: member.parent_id } : {}), workspace: run.workspace, ...(member.preset ? { preset: member.preset } : {}), ...(model ? { model } : {}), signal: this.system.signal, setup: agentCtx => registerMemberTools(agentCtx, this.system.service, this.sessionId), onEvent: event => this.observe(event) }).then(async handle => {
      if (this.closed) { await handle.dispose(); throw new Error('Flow disposed during Agent creation'); }
      this.handle = handle; if (!this.closing) this.binding?.resolve(handle); return handle;
    }).catch(error => { this.binding?.reject(error); this.binding = undefined; throw error; }).finally(() => { this.creation = undefined; });
    return this.creation;
  }
  observe(event: SessionEvent): void {
    this.confirmInput(event);
    if (this.closed || event.type !== 'turn/start') return;
    queueMicrotask(() => {
      if (this.closed) return;
      if (!this.handle) {
        if (!this.store.getMember(this.sessionId)) void Promise.all(this.messages().map(message => this.deliver(message))).catch(error => this.system.warn(error));
        return;
      }
      const member = this.store.getMember(this.sessionId);
      if (!member || ['closed', 'failed', 'paused'].includes(member.state)) return;
      const run = this.run(member.team_id);
      if (terminal(run.state) || run.state === 'paused' || this.suspension) return;
      this.store.put('members', { ...member, state: 'running', updated: Date.now() });
      this.watch(this.handle);
      this.system.submitWork(this.sessionId, async () => { if (this.handle) do { await this.watch(this.handle); } while (!this.closed && this.handle.running()); });
    });
  }
  private watch(handle: NativeMember): Promise<void> {
    if (this.activity) return this.activity;
    this.activity = (async () => {
      do {
        await handle.whenIdle(); await handle.flush();
        if (this.closed) return;
        if (handle.running()) continue;
        const input = handle.events().findLast(event => event.type === 'user/message' && event.data.source.kind === 'flow-task');
        const source = input?.type === 'user/message' && input.data.source.kind === 'flow-task' ? input.data.source : undefined;
        await this.system.collaboration.settle(this.sessionId, { end: handle.events().findLast(event => event.type === 'turn/end'), summary: handle.lastText(), task: source ? { id: source.task_id, version: source.task_version } : undefined });
        const member = this.member();
        if (!this.closed && !handle.running() && !['closed', 'failed'].includes(member.state) && !terminal(this.run(member.team_id).state))
          this.store.put('members', { ...member, state: this.suspension ? 'paused' : 'idle', error: null, updated: Date.now() });
      } while (handle.running());
    })().catch(error => this.fail(error)).finally(() => {
      this.activity = undefined;
      if (!this.closed && handle.running()) this.watch(handle);
      this.system.wake();
    });
    return this.activity;
  }
  private async deliver(offered: T.FlowMessage): Promise<void> {
    if (this.closed) return;
    const message = this.store.getMessage(offered.id);
    if (!message || message.state !== 'queued') return;
    const run = this.run(message.team_id); if (terminal(run.state)) return;
    const member = this.store.getMember(this.sessionId);
    if (!this.canReceive(message)) return;
    const handle = this.handle;
    const agent = handle?.agent ?? this.system.ctx.agents.get(SessionId(this.sessionId));
    if (!agent || this.closed || this.store.getMessage(message.id)?.state !== 'queued') return;
    const matches = (input: UserMessage) => input.source.kind === 'flow-message' && input.source.message_id === message.id;
    const events = agent.session.snapshotEvents();
    if (events.some(event => event.type === 'user/message' && matches(event.data))) {
      this.store.transaction(() => { this.store.put('messages', { ...message, state: 'delivered', delivered_at: Date.now() }); this.store.event(run.id, 'message-delivered', { message_id: message.id }); });
      return;
    }
    // A native claim may have consumed the Inbox before user/message appears.
    // Durable insertion acknowledges publication; only user/message proves delivery.
    const published = agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches) || events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(matches));
    if (!published) {
      let input = this.pendingMessages.get(message.id);
      if (!input) { input = createUserMessage({ source: { kind: 'flow-message', team_id: run.id, message_id: message.id, ...(message.task_id ? { task_id: message.task_id } : {}) }, content: [{ type: 'text', text: message.content }] }); this.pendingMessages.set(message.id, input); }
      if (handle) handle.send(input, message.mode === 'notice' ? 'notice' : handle.running() ? 'steer' : 'followup');
      else if (message.mode === 'notice') agent.inject(input);
      else if (agent.status === 'running') agent.steer(input);
      else agent.followup(input);
    }
    this.publishedMessages.add(message.id);
    if (handle && member && message.mode === 'request') this.watch(handle);
  }
  close(): Promise<void> {
    this.binding?.reject(new Error('Member is closed; native binding cancelled'));
    if (!this.closed) { const member = this.store.getMember(this.sessionId); if (member) this.store.put('members', { ...member, state: 'closed', updated: Date.now() }); }
    return this.closing ??= (async () => {
      const handle = this.handle ?? await this.creation;
      if (!handle) return;
      try { await handle.cancel(); await handle.flush(); }
      finally { await handle.dispose(); }
    })();
  }
  async dispose(): Promise<void> {
    this.binding?.reject(new Error('Flow is closed; native binding cancelled'));
    if (this.closing) { await this.closing; return; }
    await this.creation?.catch(() => {});
    await this.handle?.dispose();
    await this.activity;
  }
}
