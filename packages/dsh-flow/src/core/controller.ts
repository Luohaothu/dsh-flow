/** One durable collaboration owner over ordinary persistent DSH Agents. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ResolvedConfig } from '../config.ts';
import type { FlowService } from '../service.ts';
import type * as T from '../types.ts';
import { fail, messageOf } from '../errors.ts';
import { FlowStore } from './store.ts';
import { createNativeMember, type NativeMember, type NativeMemberOptions } from './runtime.ts';
import { registerMemberTools } from './member-tools.ts';
import { agentProfile } from './profile.ts';
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'flow-task': { kind: 'flow-task'; team_id: string; task_id: string; task_version: number };
    'flow-message': { kind: 'flow-message'; team_id: string; message_id: string; task_id?: string };
  }
}
export type NativeFactory = (ctx: Context, options: NativeMemberOptions) => Promise<NativeMember>;
const terminal = (state: T.FlowTeamState) => ['completed', 'failed', 'cancelled'].includes(state);
const json = (value: unknown): T.FlowJsonValue => JSON.parse(JSON.stringify(value)) as T.FlowJsonValue;
const text = (value: string | undefined, label: string): string => typeof value === 'string' && value.trim() ? value.trim() : fail(`${label} must be a nonempty string`);
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export class FlowController implements FlowService {
  readonly store: FlowStore;
  private readonly handles = new Map<string, NativeMember>();
  private readonly creating = new Map<string, Promise<NativeMember>>();
  private readonly activities = new Map<string, Promise<void>>();
  private readonly suspensions = new Set<string>();
  private readonly taskInputs = new Map<string, string>();
  private readonly pendingMessages = new Map<string, UserMessage>();
  private pumping = false;
  private pumpQueued = false;
  private pumpAgain = false;
  private disposal: Promise<void> | undefined;
  private readonly factory: NativeFactory;
  private readonly abort = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig, options: { factory?: NativeFactory } = {}) {
    this.factory = options.factory ?? createNativeMember;
    if (existsSync(join(config.dataDir, 'cluster.sqlite'))) fail('Retired Flow data found. Start with a new dataDir; native Session history remains separate.', 409);
    this.store = new FlowStore(join(config.dataDir, 'flow.sqlite'));
    const stop = ctx.on('session/event', (_session, event) => {
      if (this.closed || event.type !== 'user/message' || event.data.source.kind !== 'flow-message') return;
      const message = this.store.getMessage(event.data.source.message_id);
      if (message && message.to_session_id === _session.id && message.state === 'queued') this.store.transaction(() => {
        this.store.put('messages', { ...message, state: 'delivered', delivered_at: Date.now() });
        this.store.event(message.team_id, 'message-delivered', { message_id: message.id });
      });
    });
    ctx.effect(() => stop, 'dsh-flow: native message ingress observation');
  }
  private run(teamId: string) { return this.store.getTeam(teamId) ?? fail('Unknown team', 404); }
  private member(memberId: string) { return this.store.getMember(memberId) ?? fail('Unknown member', 404); }
  private taskOf(taskId: string) { return this.store.getTask(taskId) ?? fail('Unknown task', 404); }
  private assertOpen(run: T.FlowTeamRun, actor?: string) {
    if (this.closed || terminal(run.state)) fail('Team is closed', 409);
    const member = actor ? this.store.getMember(actor) : undefined;
    if (member?.team_id === run.id && ['closed', 'failed', 'paused'].includes(member.state)) fail('Member execution is closed or paused', 409);
  }
  private access(actor: string, teamId?: string): T.FlowTeamRun {
    if (this.closed) fail('Flow is closed', 409);
    const member = this.store.getMember(actor);
    const run = teamId ? this.run(teamId) : member ? this.run(member.team_id) : this.teamRuns(actor)[0] ?? fail('No team for this session', 404);
    if (actor !== run.owner_session_id && member?.team_id !== run.id) fail('Session does not own or belong to this team', 403);
    return run;
  }
  private changed(run: T.FlowTeamRun) { this.store.put('teams', { ...run, version: run.version + 1, updated: Date.now() }); }
  private mutate<R>(actor: string, operationId: string | undefined, kind: string, input: unknown, fn: () => R): R {
    if (this.closed) fail('Flow is closed', 409);
    return this.store.command(actor, operationId ?? id('operation'), kind, input, fn);
  }
  async createTeam(ownerSessionId: string, intentId: string, request: T.FlowTeamCreateRequest, model?: T.FlowModelSelection): Promise<T.FlowTeamSnapshot> {
    const team = this.mutate(ownerSessionId, `intent:${text(intentId, 'intent_id')}`, 'create', { request, model }, () => {
      const now = Date.now(), teamId = id('team'), taskId = id('task');
      if (request.deadline_ms !== undefined && (!Number.isSafeInteger(request.deadline_ms) || request.deadline_ms <= 0)) fail('deadline_ms must be a positive integer');
      const objective = text(request.objective, 'objective');
      const run: T.FlowTeamRun = { id: teamId, owner_session_id: ownerSessionId, intent_id: intentId, title: request.title?.trim() || objective.slice(0, 80), objective, workspace: resolve(request.workspace ?? this.config.workspace), preset: request.preset ?? this.config.preset, model: request.model ?? model ?? null, state: 'running', version: 1, root_task_id: taskId, deadline: request.deadline_ms === undefined ? null : now + request.deadline_ms, created: now, updated: now };
      this.store.put('teams', run);
      this.store.put('tasks', { id: taskId, team_id: teamId, parent_id: null, owner_session_id: ownerSessionId, assignee_session_id: ownerSessionId, title: run.title, objective, paused: false, status: 'OPEN', version: 1, result_id: null, created: now, updated: now });
      this.store.event(teamId, 'team-created', { task_id: taskId, assignee: ownerSessionId });
      return run;
    });
    this.armDeadline();
    return this.snapshot(team.id);
  }
  teamRuns(ownerSessionId: string): T.FlowTeamRun[] { return this.store.allTeams().filter(run => run.owner_session_id === ownerSessionId).reverse(); }
  teamRead(ownerSessionId: string, teamId: string) { this.access(ownerSessionId, teamId); return this.snapshot(teamId); }
  private snapshot(teamId: string): T.FlowTeamSnapshot {
    const members = this.store.members(teamId);
    const observed = members.every(member => this.handles.has(member.id));
    const responses = members.flatMap(member => (this.handles.get(member.id)?.events() ?? []).filter(event => event.type === 'assistant/message'));
    const total = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'totalTokens'): number | null => {
      if (!observed || !responses.length) return null;
      let sum = 0;
      for (const event of responses) {
        if (event.type !== 'assistant/message') continue;
        const value = event.data.usage?.[key];
        if (value === undefined) return null;
        sum += value;
      }
      return sum;
    };
    const usage: T.FlowUsageSummary = { responses: observed ? responses.length : null, input_tokens: total('inputTokens'), output_tokens: total('outputTokens'), cache_read_tokens: total('cacheReadTokens'), total_tokens: total('totalTokens') };
    return { run: this.run(teamId), members, tasks: this.store.tasks(teamId), results: this.store.results(teamId), reviews: this.store.reviews(teamId), messages: this.store.messages(teamId), events: this.store.events(teamId), usage };
  }
  agentSession(sessionId: string): T.FlowAgentSession | null {
    const member = this.store.getMember(sessionId);
    if (!member) return null;
    const run = this.run(member.team_id), can = !this.closed && !terminal(run.state) && member.state !== 'closed';
    return { session_id: sessionId, team_id: run.id, owner_session_id: run.owner_session_id, member_id: member.id, parent_session_id: member.parent_id, name: member.name, role: member.role ?? 'worker', state: member.state, can_message: can, message_block_reason: can ? null : '团队已结束，成员历史保留只读' };
  }
  isTeamAgentSession(sessionId: string) { return !this.closed && !!this.store.getMember(sessionId); }
  /** Used only by the generic SessionDriver to reuse this member's one live owner. */
  async ensureAgent(sessionId: string) {
    const member = this.member(sessionId); this.assertOpen(this.run(member.team_id));
    if (member.state === 'closed') fail('Member is closed; its native history remains readable', 409);
    return (await this.ensureMember(sessionId)).agent;
  }
  async task(actor: string, request: T.FlowTaskRequest, operationId?: string): Promise<T.FlowTask> {
    const task = this.mutate(actor, operationId, 'task', request, () => {
      const run = this.access(actor, request.team_id); this.assertOpen(run, actor);
      if (request.action === 'update') {
        if (request.member_id !== undefined || request.profile !== undefined) fail('Task updates change title and objective. Assignment and profile belong to new-member delegation.');
        const old = this.taskOf(text(request.task_id, 'task_id'));
        if (old.team_id !== run.id || old.owner_session_id !== actor) fail('Only the task owner may update it', 403);
        if (request.version !== old.version || old.status === 'ACCEPTED' || old.status === 'CANCELLED') fail('Task version or state changed', 409);
        if (this.activities.has(old.assignee_session_id) && this.store.getMember(old.assignee_session_id)?.active_task_id === old.id) fail('Pause the task before changing its active work', 409);
        const updated: T.FlowTask = { ...old, title: request.title ?? old.title, objective: request.objective === undefined ? old.objective : text(request.objective, 'objective'), status: 'OPEN', version: old.version + 1, result_id: null, updated: Date.now() };
        this.store.put('tasks', updated);
        const assignee = this.store.getMember(old.assignee_session_id);
        if (assignee?.state === 'failed') this.store.put('members', { ...assignee, state: 'idle', error: null, updated: Date.now() });
        this.store.event(run.id, 'task-updated', { task_id: old.id, version: updated.version }); this.changed(run); return updated;
      }
      if (request.action !== 'delegate') fail('Unknown task action');
      const objective = text(request.objective, 'objective'), now = Date.now();
      const parentId = actor === run.owner_session_id ? run.root_task_id : this.store.getMember(actor)?.active_task_id ?? run.root_task_id;
      const parent = this.taskOf(parentId);
      if (parent.team_id !== run.id || parent.assignee_session_id !== actor) fail('The parent task does not belong to this actor', 403);
      if (parent.paused || ['ACCEPTED', 'CANCELLED', 'FAILED'].includes(parent.status)) fail('Cannot delegate from a closed parent task', 409);
      let memberId = request.member_id;
      if (memberId) {
        if (request.profile !== undefined) fail('Reusing a member retains its profile. Omit profile or delegate to a new member.');
        const member = this.member(memberId);
        if (member.team_id !== run.id || member.state === 'closed' || memberId === actor) fail('Invalid task assignee', 403);
        let ancestor: T.FlowTask | undefined = parent;
        while (ancestor) {
          if (ancestor.assignee_session_id === member.id && !['ACCEPTED', 'CANCELLED'].includes(ancestor.status)) fail('Delegate descendants of unfinished work to another member; reusing this assignee would block its own acceptance', 409);
          ancestor = ancestor.parent_id ? this.store.getTask(ancestor.parent_id) : undefined;
        }
      } else {
        const profile = agentProfile(request.profile);
        memberId = id('session');
        this.store.put('members', { ...profile, id: memberId, team_id: run.id, session_id: memberId, parent_id: actor, name: profile.name ?? (request.title?.trim() || objective.slice(0, 60)), role: profile.role ?? 'worker', preset: profile.preset ?? run.preset, ...(profile.model ? { model: { ...run.model, ...profile.model } } : {}), state: 'queued', active_task_id: null, error: null, created: now, updated: now });
      }
      const task: T.FlowTask = { id: id('task'), team_id: run.id, parent_id: parentId, owner_session_id: actor, assignee_session_id: memberId, title: request.title?.trim() || objective.slice(0, 80), objective, paused: false, status: 'OPEN', version: 1, result_id: null, created: now, updated: now };
      this.store.put('tasks', task); this.store.event(run.id, 'task-delegated', { task_id: task.id, owner: actor, assignee: memberId }); this.changed(run); return task;
    });
    this.wake(); return task;
  }
  async result(actor: string, request: T.FlowResultRequest, operationId?: string): Promise<T.FlowResult> {
    let completesTeam = false;
    const result = this.mutate(actor, operationId, 'result', request, () => {
      const task = this.taskOf(request.task_id), run = this.access(actor, task.team_id); this.assertOpen(run, actor);
      if (task.assignee_session_id !== actor) fail('Only the assignee may submit a result', 403);
      if (task.paused || task.status === 'CANCELLED' || task.status === 'ACCEPTED' || task.status === 'FAILED') fail('Task is closed', 409);
      const outcome = request.outcome ?? 'complete';
      const completesRoot = task.id === run.root_task_id && task.owner_session_id === actor && outcome === 'complete';
      if (completesRoot && this.store.tasks(run.id).some(child => child.parent_id === task.id && !['ACCEPTED', 'CANCELLED'].includes(child.status))) fail('Review unfinished child tasks before completing the root', 409);
      const result: T.FlowResult = { id: id('result'), team_id: run.id, task_id: task.id, task_version: task.version, author_session_id: actor, summary: text(request.summary, 'summary'), artifacts: request.artifacts ?? [], outcome, ready: !this.handles.get(actor)?.running(), created: Date.now() };
      this.store.put('results', result); this.store.put('tasks', { ...task, status: completesRoot ? 'ACCEPTED' : 'SUBMITTED', result_id: result.id, updated: Date.now() });
      this.store.event(run.id, completesRoot ? 'root-completed' : 'result-submitted', { task_id: task.id, result_id: result.id });
      this.changed(completesRoot ? { ...run, state: 'completed' } : run); completesTeam = completesRoot; return result;
    });
    if (completesTeam) this.drainTeam(result.team_id);
    else if (result.ready) this.notifyResult(result);
    return result;
  }
  async review(actor: string, request: T.FlowReviewRequest, operationId?: string): Promise<T.FlowReview> {
    const review = this.mutate(actor, operationId, 'review', request, () => {
      const result = this.store.getResult(request.result_id) ?? fail('Unknown result', 404), task = this.taskOf(result.task_id), run = this.access(actor, task.team_id); this.assertOpen(run, actor);
      if (task.owner_session_id !== actor) fail('Only the task owner may review its result', 403);
      if (task.owner_session_id === task.assignee_session_id) fail('Complete your own root with flow_result; review is for delegated results', 409);
      if (task.paused || !result.ready || task.result_id !== result.id || result.task_version !== task.version || task.status !== 'SUBMITTED') fail('Result is not current and ready for review', 409);
      if (request.accepted && result.outcome !== 'complete') fail('A partial or blocked result requires follow-up', 409);
      if (request.accepted && this.store.tasks(run.id).some(child => child.parent_id === task.id && !['ACCEPTED', 'CANCELLED'].includes(child.status))) fail('Review unfinished child tasks before accepting this result', 409);
      const review: T.FlowReview = { id: id('review'), team_id: run.id, task_id: task.id, result_id: result.id, reviewer_session_id: actor, accepted: request.accepted, notes: text(request.notes, 'notes'), evidence: request.evidence ?? [], created: Date.now() };
      this.store.put('reviews', review);
      this.store.put('tasks', { ...task, status: request.accepted ? 'ACCEPTED' : 'OPEN', version: request.accepted ? task.version : task.version + 1, result_id: request.accepted ? result.id : null, objective: request.accepted ? task.objective : `${task.objective}\n\nOwner follow-up: ${review.notes}`, updated: Date.now() });
      this.store.event(run.id, request.accepted ? 'result-accepted' : 'result-rejected', { task_id: task.id, result_id: result.id, review_id: review.id });
      this.changed(run);
      return review;
    });
    this.wake();
    return review;
  }
  async message(actor: string, request: T.FlowMessageRequest, operationId?: string): Promise<T.FlowMessage> {
    const message = this.mutate(actor, operationId, 'message', request, () => {
      const run = this.access(actor, request.team_id); this.assertOpen(run, actor);
      const recipient = this.store.getMember(request.to);
      if (request.to !== run.owner_session_id && (recipient?.team_id !== run.id || recipient.state === 'closed')) fail('Recipient does not belong to this team', 403);
      if (request.task_id && this.taskOf(request.task_id).team_id !== run.id) fail('Message task belongs to another team', 403);
      const message: T.FlowMessage = { id: id('message'), team_id: run.id, from_session_id: actor, to_session_id: request.to, task_id: request.task_id ?? null, content: text(request.content, 'content'), mode: request.mode ?? 'request', state: 'queued', created: Date.now(), delivered_at: null };
      this.store.put('messages', message); this.store.event(run.id, 'message-queued', { message_id: message.id }); return message;
    });
    await this.deliver(message); return this.store.getMessage(message.id) ?? message;
  }
  read(actor: string, request: T.FlowReadRequest): T.FlowReadResult {
    const run = this.access(actor, request.team_id), what = request.what ?? 'team';
    if (what === 'team') return { what, value: json(this.snapshot(run.id)), total: 1, offset: 0, next_offset: null };
    let items: unknown[];
    if (what === 'task') items = this.store.tasks(run.id);
    else if (what === 'member') items = this.store.members(run.id);
    else if (what === 'result') items = this.store.results(run.id);
    else if (what === 'messages') items = this.store.messages(run.id);
    else if (what === 'events') items = this.store.events(run.id);
    else fail('Unknown read target');
    if (request.id) items = items.filter(item => typeof item === 'object' && item !== null && 'id' in item && item.id === request.id);
    const offset = request.offset ?? 0, limit = request.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('Invalid pagination');
    const next = offset + limit < items.length ? offset + limit : null;
    return { what, value: json(items.slice(offset, offset + limit)), total: items.length, offset, next_offset: next };
  }
  async control(actor: string, request: T.FlowControlRequest, operationId?: string): Promise<T.FlowTeamSnapshot> {
    let applied = false;
    const controlled = this.mutate(actor, operationId, 'control', request, () => {
      const run = this.access(actor, request.team_id); this.assertOpen(run, actor);
      let members: T.FlowMember[];
      const tasks = this.store.tasks(run.id);
      const affectedTasks = new Set<string>();
      if (request.target === 'team') {
        if (request.id !== run.id || actor !== run.owner_session_id) fail('Only the team owner controls the team', 403);
        members = this.store.members(run.id);
        this.changed({ ...run, state: request.action === 'cancel' ? 'cancelled' : request.action === 'pause' ? 'paused' : 'running' });
      } else if (request.target === 'member') {
        const member = this.member(request.id);
        if (member.team_id !== run.id || (actor !== run.owner_session_id && actor !== member.parent_id)) fail('Only the member owner controls it', 403);
        const ids = new Set([member.id]);
        let size = 0;
        while (size !== ids.size) { size = ids.size; for (const child of this.store.members(run.id)) if (child.parent_id && ids.has(child.parent_id)) ids.add(child.id); }
        members = this.store.members(run.id).filter(child => ids.has(child.id));
      } else if (request.target === 'task') {
        const task = this.taskOf(request.id);
        if (task.team_id !== run.id || task.owner_session_id !== actor) fail('Only the task owner controls it', 403);
        affectedTasks.add(task.id);
        let size = 0;
        while (size !== affectedTasks.size) { size = affectedTasks.size; for (const child of tasks) if (child.parent_id && affectedTasks.has(child.parent_id)) affectedTasks.add(child.id); }
        for (const affected of tasks) if (affectedTasks.has(affected.id) && request.action !== 'cancel') this.store.put('tasks', { ...affected, paused: request.action === 'pause', updated: Date.now() });
        // Cancelling a queued task must not interrupt another task on the same member.
        members = this.store.members(run.id).filter(member => member.active_task_id && affectedTasks.has(member.active_task_id));
      } else fail('Unknown control target');
      const memberIds = members.map(member => member.id);
      if (request.action !== 'cancel' && request.target !== 'task') for (const member of members) {
        this.store.put('members', { ...member, state: request.action === 'pause' ? 'paused' : 'idle', updated: Date.now() });
      }
      if (request.action === 'cancel') {
        for (const task of tasks) if ((request.target === 'team' || (request.target === 'task' ? affectedTasks.has(task.id) : memberIds.includes(task.assignee_session_id))) && !['ACCEPTED', 'CANCELLED'].includes(task.status)) this.store.put('tasks', { ...task, status: 'CANCELLED', version: task.version + 1, updated: Date.now() });
        if (request.target !== 'task') for (const member of members) this.store.put('members', { ...member, state: 'closed', updated: Date.now() });
        for (const message of this.store.messages(run.id)) if (message.state === 'queued' && (request.target === 'task' ? !!message.task_id && affectedTasks.has(message.task_id) : memberIds.includes(message.to_session_id))) this.store.put('messages', { ...message, state: 'cancelled' });
      }
      if (request.target === 'task' && request.id === run.root_task_id && request.action === 'cancel') this.changed({ ...run, state: 'cancelled' });
      applied = true;
      this.store.event(run.id, `control-${request.action}`, json(request));
      return { teamId: run.id, members: memberIds };
    });
    if (!applied) return this.snapshot(controlled.teamId);
    for (const memberId of controlled.members) {
      const member = this.member(memberId);
      if (member.active_task_id) this.taskInputs.delete(member.active_task_id);
      if (request.action === 'resume') this.suspensions.delete(memberId); else if (request.target !== 'task') this.suspensions.add(memberId);
    }
    if (terminal(this.run(controlled.teamId).state)) this.drainTeam(controlled.teamId);
    else if (request.action !== 'resume') {
      // Return before cancelling a caller's own native tool step; cancellation
      // and draining are asynchronous, and all late callbacks check durable state.
      setImmediate(() => {
        const closing = request.action === 'cancel' && request.target !== 'task';
        void (closing
          ? this.closeOwnedMembers(controlled.members)
          : Promise.allSettled(controlled.members.map(memberId => this.handles.get(memberId)?.cancel())))
          .then(() => this.wake());
      });
    } else this.wake();
    this.armDeadline(); return this.snapshot(controlled.teamId);
  }
  private async ensureMember(memberId: string): Promise<NativeMember> {
    if (this.closed) fail('Flow is closed', 409);
    const live = this.handles.get(memberId); if (live) return live;
    const waiting = this.creating.get(memberId); if (waiting) return waiting;
    const member = this.member(memberId), run = this.run(member.team_id), model = member.model ?? run.model;
    const creation = this.factory(this.ctx, { sessionId: memberId, name: member.name, role: member.role ?? 'worker', ...(member.instructions ? { instructions: member.instructions } : {}), ...(member.skills ? { skills: member.skills } : {}), ...(member.parent_id ? { parentSessionId: member.parent_id } : {}), workspace: run.workspace, ...(member.preset ? { preset: member.preset } : {}), ...(model ? { model } : {}), signal: this.abort.signal, setup: agentCtx => registerMemberTools(agentCtx, this, memberId), onEvent: event => this.observe(memberId, event) }).then(async handle => {
      if (this.closed) { await handle.dispose(); throw new Error('Flow disposed during Agent creation'); }
      this.handles.set(memberId, handle); return handle;
    }).finally(() => this.creating.delete(memberId));
    this.creating.set(memberId, creation); return creation;
  }
  private observe(memberId: string, event: SessionEvent): void {
    if (this.closed) return;
    if (event.type === 'turn/start') queueMicrotask(() => {
      if (this.closed) return;
      const handle = this.handles.get(memberId), member = this.store.getMember(memberId);
      // The append notification can precede the native running-state flip.
      // A cold factory may also emit before publishing its owned handle; its
      // caller attaches the initial watcher after ensureMember returns.
      if (!handle || !member || ['closed', 'failed', 'paused'].includes(member.state)) return;
      const run = this.run(member.team_id);
      if (terminal(run.state) || run.state === 'paused' || this.suspensions.has(memberId)) return;
      this.store.put('members', { ...member, state: 'running', updated: Date.now() });
      this.watch(memberId, handle);
    });
    if (event.type === 'user/message' && event.data.source.kind === 'flow-message') {
      const message = this.store.getMessage(event.data.source.message_id);
      if (message && message.to_session_id === memberId && message.state === 'queued') this.store.transaction(() => { this.store.put('messages', { ...message, state: 'delivered', delivered_at: Date.now() }); this.store.event(message.team_id, 'message-delivered', { message_id: message.id }); });
    }
  }
  private watch(memberId: string, handle: NativeMember): void {
    if (this.activities.has(memberId)) return;
    const activity = (async () => {
      do {
        await handle.whenIdle();
        await handle.flush();
        if (this.closed) return;
        // A message may wake the same persistent Agent while its prior idle
        // checkpoint is flushing. Keep observing its native lifetime; that
        // checkpoint cannot declare a still-running result ready.
        if (handle.running()) continue;
        await this.settle(memberId, handle);
      } while (handle.running());
    })().catch(error => this.failed(memberId, error)).finally(() => {
      this.activities.delete(memberId);
      // Input can arrive between the last idle check and Promise finalization.
      if (!this.closed && handle.running()) this.watch(memberId, handle);
      this.wake();
    });
    this.activities.set(memberId, activity);
  }
  private async settle(memberId: string, handle: NativeMember): Promise<void> {
    if (this.closed || handle.running()) return;
    const member = this.member(memberId), run = this.run(member.team_id);
    if (terminal(run.state) || member.state === 'closed') return;
    const lastEnd = handle.events().findLast(event => event.type === 'turn/end');
    if (lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'error') {
      this.failed(memberId, new Error(JSON.stringify(lastEnd.data.reason))); return;
    }
    const task = member.active_task_id ? this.store.getTask(member.active_task_id) : undefined;
    if (task && task.status === 'OPEN' && !this.suspensions.has(memberId) && run.state === 'running' && lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'completed') {
      const children = this.store.tasks(run.id).filter(child => child.parent_id === task.id);
      const summary = handle.lastText();
      // A natural return can publish a leaf deliverable; it never accepts one,
      // and a parent waiting for child work has no deliverable yet.
      if (summary.trim() && children.every(child => ['ACCEPTED', 'CANCELLED'].includes(child.status))) await this.result(memberId, { task_id: task.id, summary }, `native-return:${task.id}:${task.version}`);
    }
    if (this.closed || handle.running()) return;
    if (task && task.status === 'OPEN' && !task.paused && !this.suspensions.has(memberId) && run.state === 'running' && lastEnd?.type === 'turn/end' && ['blocked', 'max-tokens', 'interrupted'].includes(lastEnd.data.reason.kind)) {
      await this.result(memberId, { task_id: task.id, summary: `Native execution needs follow-up: ${lastEnd.data.reason.kind}. Inspect this Session's actual journal before continuing.`, outcome: 'blocked' }, `native-blocked:${task.id}:${task.version}`);
    }
    const currentTask = task ? this.store.getTask(task.id) : undefined;
    let ready: T.FlowResult | undefined;
    this.store.transaction(() => {
      if (currentTask?.result_id && currentTask.status === 'SUBMITTED') {
        const result = this.store.getResult(currentTask.result_id);
        if (result && !result.ready) { ready = { ...result, ready: true }; this.store.put('results', ready); this.store.event(run.id, 'result-ready', { result_id: ready.id, task_id: currentTask.id }); }
      }
      this.store.put('members', { ...this.member(memberId), state: this.suspensions.has(memberId) ? 'paused' : 'idle', error: null, updated: Date.now() });
    });
    if (ready) this.notifyResult(ready);
  }
  private failed(memberId: string, error: unknown): void {
    if (this.closed) return;
    const member = this.member(memberId), run = this.run(member.team_id); if (terminal(run.state) || member.state === 'closed') return;
    this.store.transaction(() => {
      this.store.put('members', { ...member, state: 'failed', error: messageOf(error), updated: Date.now() });
      if (member.active_task_id) { const task = this.taskOf(member.active_task_id); if (!['CANCELLED', 'ACCEPTED'].includes(task.status)) this.store.put('tasks', { ...task, status: 'FAILED', updated: Date.now() }); }
      this.store.event(run.id, 'member-failed', { member_id: memberId, error: messageOf(error) });
      if (member.active_task_id === run.root_task_id) this.changed({ ...run, state: 'failed' });
    });
  }
  private notifyResult(result: T.FlowResult): void {
    if (this.closed) return;
    const task = this.taskOf(result.task_id), run = this.run(task.team_id);
    if (task.owner_session_id === result.author_session_id) return;
    if (terminal(run.state) || task.result_id !== result.id || task.version !== result.task_version) return;
    void this.message(result.author_session_id, { team_id: run.id, to: task.owner_session_id, task_id: task.id, mode: 'request', content: `Result ready: ${result.id}\nTask: ${task.title} (${task.id})\n${result.summary}\nArtifacts: ${JSON.stringify(result.artifacts)}\nCheck the existing deliverables against this task, then flow_review this result_id. The result is ready; read additional facts only as needed.` }, `result-ready:${result.id}`).catch(error => { if (!this.closed) this.ctx.logger.warn(error); });
  }
  private async deliver(offered: T.FlowMessage): Promise<void> {
    if (this.closed) return;
    const message = this.store.getMessage(offered.id);
    if (!message || message.state !== 'queued') return;
    const run = this.run(message.team_id); if (terminal(run.state)) return;
    const member = this.store.getMember(message.to_session_id);
    if (member && (run.state === 'paused' || this.suspensions.has(member.id))) return;
    if (member && message.mode === 'request' && !this.handles.get(member.id)?.running() && new Set([...this.activities.keys(), ...this.creating.keys()]).size >= this.config.maxConcurrentAgents) return;
    const handle = member ? await this.ensureMember(member.id) : undefined;
    const agent = handle?.agent ?? this.ctx.agents.get(SessionId(message.to_session_id));
    if (!agent || this.closed || this.store.getMessage(message.id)?.state !== 'queued' || terminal(this.run(run.id).state) || (member && this.suspensions.has(member.id))) return;
    if (handle && member && message.mode === 'request' && !handle.running() && !this.activities.has(member.id) && this.activities.size >= this.config.maxConcurrentAgents) return;
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
    if (handle && member && message.mode === 'request') this.watch(member.id, handle);
  }
  private wake(): void {
    if (this.closed) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => { this.pumpQueued = false; void this.pump().catch(error => { if (!this.closed) this.ctx.logger.error(error); }); });
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return; this.pumping = true;
    try {
      for (const run of this.store.allTeams()) {
        if (this.closed) return;
        if (run.state !== 'running') continue;
        const orderedTasks = this.store.tasks(run.id);
        for (const task of orderedTasks) {
          // A standard Agent may also be another team's member. Every root is
          // still driven by its existing native conversation, never this pump.
          if (task.id === run.root_task_id) continue;
          if (this.closed || this.activities.size + this.creating.size >= this.config.maxConcurrentAgents) break;
          if (task.status !== 'OPEN' || task.paused || this.suspensions.has(task.assignee_session_id) || this.activities.has(task.assignee_session_id)) continue;
          const member = this.store.getMember(task.assignee_session_id);
          // The root belongs to the existing native main Agent. Flow neither
          // creates nor schedules a second Agent for it.
          if (!member) continue;
          if (member.state === 'closed' || member.state === 'failed') continue;
          if (this.taskInputs.get(task.id) === `${task.version}`) continue;
          try {
            const handle = await this.ensureMember(member.id);
            if (this.closed || this.run(run.id).state !== 'running' || this.suspensions.has(member.id) || this.taskOf(task.id).paused || this.taskOf(task.id).version !== task.version || this.taskOf(task.id).status !== 'OPEN') continue;
            this.store.put('members', { ...member, active_task_id: task.id, state: 'running', updated: Date.now() });
            this.taskInputs.set(task.id, `${task.version}`);
            const alreadyQueued = [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].some(input => input.source.kind === 'flow-task' && input.source.task_id === task.id && input.source.task_version === task.version);
            const priorInput = handle.events().some(event => event.type === 'user/message' && event.data.source.kind === 'flow-task' && event.data.source.task_id === task.id && event.data.source.task_version === task.version);
            // Resume restores the native Inbox and may already have started it.
            // Observe that input instead of issuing a second task/continue prompt.
            if (alreadyQueued || (priorInput && handle.running())) { this.watch(member.id, handle); continue; }
            const input = createUserMessage({ source: { kind: 'flow-task', team_id: run.id, task_id: task.id, task_version: task.version }, content: [{ type: 'text', text: `${priorInput ? 'Continue from your native Session history and completed actions.\n' : ''}Task ${task.id} (version ${task.version}), owner ${task.owner_session_id}\n${task.objective}\nWorkspace: ${run.workspace}\nUse your standard native tools. Business scripts and temporary files follow the task's output-directory restrictions. Delegate independent business work with flow_task when useful; check existing child deliverables and flow_review their results. If waiting is all that remains, return naturally; result messages resume the work. Finish with one concise final reply giving artifact paths, checks and limitations: the completed native return is published for owner review. For incomplete work, explicitly flow_result with partial or blocked. An explicit result needs only a brief final acknowledgement.` }] });
            handle.send(input, handle.running() ? 'steer' : 'followup'); this.watch(member.id, handle);
          } catch (error) { this.failed(member.id, error); }
        }
        for (const message of this.store.messages(run.id)) if (message.state === 'queued') await this.deliver(message);
      }
    } finally { this.pumping = false; if (this.pumpAgain) { this.pumpAgain = false; this.wake(); } }
  }
  async recover(): Promise<void> {
    for (const run of this.store.allTeams()) if (!terminal(run.state)) {
      for (const member of this.store.members(run.id)) {
        if (member.state === 'paused' || run.state === 'paused') this.suspensions.add(member.id);
        if (member.state === 'running') this.store.put('members', { ...member, state: 'idle', updated: Date.now() });
      }
      for (const task of this.store.tasks(run.id)) if (task.status === 'SUBMITTED' && task.result_id) {
        const result = this.store.getResult(task.result_id);
        if (!result) continue;
        if (result.ready) this.notifyResult(result);
        else if (run.state === 'running' && !this.suspensions.has(task.assignee_session_id)) {
          const handle = await this.ensureMember(task.assignee_session_id);
          // A cold resume restores the native journal/Inbox. Settling that
          // activity makes the existing immutable result reviewable.
          this.watch(task.assignee_session_id, handle);
        }
      }
    }
    this.wake(); this.armDeadline();
  }
  private drainTeam(teamId: string): void {
    setImmediate(() => {
      if (this.closed) return;
      const members = this.store.members(teamId);
      for (const member of members) { this.suspensions.add(member.id); this.store.put('members', { ...member, state: 'closed', updated: Date.now() }); }
      void this.closeOwnedMembers(members.map(member => member.id));
    });
  }
  /** Release only owned members, including a factory already in flight. */
  private async closeOwnedMembers(memberIds: readonly string[]): Promise<void> {
    await Promise.allSettled(memberIds.map(async memberId => {
      const handle = this.handles.get(memberId) ?? await this.creating.get(memberId);
      if (!handle) return;
      try { await handle.cancel(); await handle.flush(); }
      finally { await handle.dispose(); }
    }));
  }
  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.closed) return;
    const upcoming = this.store.allTeams().filter(run => !terminal(run.state) && run.deadline !== null).sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0))[0];
    if (!upcoming?.deadline) return;
    this.deadlineTimer = setTimeout(() => {
      if (this.closed) return;
      for (const run of this.store.allTeams()) if (!terminal(run.state) && run.deadline !== null && run.deadline <= Date.now()) void this.control(run.owner_session_id, { team_id: run.id, target: 'team', id: run.id, action: 'cancel' }, `deadline:${run.id}`).catch(error => this.ctx.logger.warn(error));
      this.armDeadline();
    }, Math.min(2147483647, Math.max(1, upcoming.deadline - Date.now())));
    this.deadlineTimer.unref();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true; this.abort.abort(); if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.disposal = (async () => {
      await Promise.allSettled([...this.creating.values()]);
      await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
      await Promise.allSettled([...this.activities.values()]);
      this.store.close();
    })();
    return this.disposal;
  }
}
