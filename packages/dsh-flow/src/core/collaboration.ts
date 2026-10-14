/** Collaboration facts and authorization; execution belongs to the addressed Agent. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ResolvedConfig } from '../config.ts';
import type * as T from '../types.ts';
import { fail, messageOf } from '../errors.ts';
import { FlowStore } from './store.ts';
import { agentProfile } from './profile.ts';
import type { FlowSystem } from './system.ts';
const terminal = (state: T.FlowTeamState) => ['completed', 'failed', 'cancelled'].includes(state);
const json = (value: unknown): T.FlowJsonValue => JSON.parse(JSON.stringify(value)) as T.FlowJsonValue;
const text = (value: string | undefined, label: string): string => typeof value === 'string' && value.trim() ? value.trim() : fail(`${label} must be a nonempty string`);
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export class FlowCollaboration {
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig, readonly store: FlowStore, private readonly system: FlowSystem) {}
  private run(teamId: string) { return this.store.getTeam(teamId) ?? fail('Unknown team', 404); }
  private member(memberId: string) { return this.store.getMember(memberId) ?? fail('Unknown member', 404); }
  private taskOf(taskId: string) { return this.store.getTask(taskId) ?? fail('Unknown task', 404); }
  private assertOpen(run: T.FlowTeamRun, actor?: string) {
    if (this.system.closed || terminal(run.state)) fail('Team is closed', 409);
    const member = actor ? this.store.getMember(actor) : undefined;
    if (member?.team_id === run.id && ['closed', 'failed', 'paused'].includes(member.state)) fail('Member execution is closed or paused', 409);
  }
  private access(actor: string, teamId?: string): T.FlowTeamRun {
    if (this.system.closed) fail('Flow is closed', 409);
    const member = this.store.getMember(actor);
    const run = teamId ? this.run(teamId) : member ? this.run(member.team_id) : this.teamRuns(actor)[0] ?? fail('No team for this session', 404);
    if (actor !== run.owner_session_id && member?.team_id !== run.id) fail('Session does not own or belong to this team', 403);
    return run;
  }
  private changed(run: T.FlowTeamRun) { this.store.put('teams', { ...run, version: run.version + 1, updated: Date.now() }); }
  private mutate<R>(actor: string, operationId: string | undefined, kind: string, input: unknown, fn: () => R): R {
    if (this.system.closed) fail('Flow is closed', 409);
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
    this.system.armDeadline();
    return this.snapshot(team.id);
  }
  teamRuns(ownerSessionId: string): T.FlowTeamRun[] { return this.store.allTeams().filter(run => run.owner_session_id === ownerSessionId).reverse(); }
  teamRead(ownerSessionId: string, teamId: string) { this.access(ownerSessionId, teamId); return this.snapshot(teamId); }
  private snapshot(teamId: string): T.FlowTeamSnapshot {
    const members = this.store.members(teamId);
    const observed = members.every(member => this.system.observed(member.id));
    const responses = members.flatMap(member => (this.system.events(member.id) ?? []).filter(event => event.type === 'assistant/message'));
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
    const run = this.run(member.team_id), can = !this.system.closed && !terminal(run.state) && member.state !== 'closed';
    return { session_id: sessionId, team_id: run.id, owner_session_id: run.owner_session_id, member_id: member.id, parent_session_id: member.parent_id, name: member.name, role: member.role ?? 'worker', state: member.state, can_message: can, message_block_reason: can ? null : '团队已结束，成员历史保留只读' };
  }
  isTeamAgentSession(sessionId: string) { return !this.system.closed && !!this.store.getMember(sessionId); }
  async task(actor: string, request: T.FlowTaskRequest, operationId?: string): Promise<T.FlowTask> {
    const task = this.mutate(actor, operationId, 'task', request, () => {
      const run = this.access(actor, request.team_id); this.assertOpen(run, actor);
      if (request.action === 'update') {
        if (request.member_id !== undefined || request.profile !== undefined) fail('Task updates change title and objective. Assignment and profile belong to new-member delegation.');
        const old = this.taskOf(text(request.task_id, 'task_id'));
        if (old.team_id !== run.id || old.owner_session_id !== actor) fail('Only the task owner may update it', 403);
        if (request.version !== old.version || old.status === 'ACCEPTED' || old.status === 'CANCELLED') fail('Task version or state changed', 409);
        if (this.system.active(old.assignee_session_id) && this.store.getMember(old.assignee_session_id)?.active_task_id === old.id) fail('Pause the task before changing its active work', 409);
        const updated: T.FlowTask = { ...old, title: request.title ?? old.title, objective: request.objective === undefined ? old.objective : text(request.objective, 'objective'), status: 'OPEN', version: old.version + 1, result_id: null, updated: Date.now() };
        this.store.put('tasks', updated);
        const assignee = this.store.getMember(old.assignee_session_id);
        if (assignee?.state === 'failed') this.system.agent(assignee.id).resetFailure();
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
    this.system.wake(); return task;
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
      const result: T.FlowResult = { id: id('result'), team_id: run.id, task_id: task.id, task_version: task.version, author_session_id: actor, summary: text(request.summary, 'summary'), artifacts: request.artifacts ?? [], outcome, ready: !this.system.running(actor), created: Date.now() };
      this.store.put('results', result); this.store.put('tasks', { ...task, status: completesRoot ? 'ACCEPTED' : 'SUBMITTED', result_id: result.id, updated: Date.now() });
      this.store.event(run.id, completesRoot ? 'root-completed' : 'result-submitted', { task_id: task.id, result_id: result.id });
      this.changed(completesRoot ? { ...run, state: 'completed' } : run); completesTeam = completesRoot; return result;
    });
    if (completesTeam) this.system.drainTeam(result.team_id);
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
    this.system.wake();
    return review;
  }
  recordMessage(actor: string, request: T.FlowMessageRequest, operationId?: string): T.FlowMessage {
    const message = this.mutate(actor, operationId, 'message', request, () => {
      const run = this.access(actor, request.team_id); this.assertOpen(run, actor);
      const recipient = this.store.getMember(request.to);
      if (request.to !== run.owner_session_id && (recipient?.team_id !== run.id || recipient.state === 'closed')) fail('Recipient does not belong to this team', 403);
      if (request.task_id && this.taskOf(request.task_id).team_id !== run.id) fail('Message task belongs to another team', 403);
      const message: T.FlowMessage = { id: id('message'), team_id: run.id, from_session_id: actor, to_session_id: request.to, task_id: request.task_id ?? null, content: text(request.content, 'content'), mode: request.mode ?? 'request', state: 'queued', created: Date.now(), delivered_at: null };
      this.store.put('messages', message); this.store.event(run.id, 'message-queued', { message_id: message.id }); return message;
    });
    return message;
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
        this.system.agent(member.id).recordControl(request);
      }
      if (request.action === 'cancel') {
        for (const task of tasks) if ((request.target === 'team' || (request.target === 'task' ? affectedTasks.has(task.id) : memberIds.includes(task.assignee_session_id))) && !['ACCEPTED', 'CANCELLED'].includes(task.status)) this.store.put('tasks', { ...task, status: 'CANCELLED', version: task.version + 1, updated: Date.now() });
        if (request.target !== 'task') for (const member of members) this.system.agent(member.id).recordControl(request);
        for (const message of this.store.messages(run.id)) if (message.state === 'queued' && (request.target === 'task' ? !!message.task_id && affectedTasks.has(message.task_id) : memberIds.includes(message.to_session_id))) this.store.put('messages', { ...message, state: 'cancelled' });
      }
      if (request.target === 'task' && request.id === run.root_task_id && request.action === 'cancel') this.changed({ ...run, state: 'cancelled' });
      applied = true;
      this.store.event(run.id, `control-${request.action}`, json(request));
      return { teamId: run.id, members: memberIds };
    });
    if (!applied) return this.snapshot(controlled.teamId);
    this.system.control(controlled.members, request);
    if (terminal(this.run(controlled.teamId).state)) this.system.drainTeam(controlled.teamId);
    else this.system.wake();
    this.system.armDeadline(); return this.snapshot(controlled.teamId);
  }
  message(actor: string, request: T.FlowMessageRequest, operationId?: string): Promise<T.FlowMessage> {
    return this.system.agent(actor).send(request, operationId);
  }
  async settle(memberId: string, checkpoint: { end: SessionEvent | undefined; summary: string; task: { id: string; version: number } | undefined }): Promise<void> {
    if (this.system.closed || this.system.running(memberId)) return;
    const member = this.member(memberId), run = this.run(member.team_id);
    if (terminal(run.state) || member.state === 'closed') return;
    const lastEnd = checkpoint.end;
    if (lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'error') {
      this.system.agent(memberId).fail(new Error(JSON.stringify(lastEnd.data.reason))); return;
    }
    const task = member.active_task_id ? this.store.getTask(member.active_task_id) : undefined;
    if (task && checkpoint.task?.id === task.id && checkpoint.task.version === task.version && task.status === 'OPEN' && !this.system.suspended(memberId) && run.state === 'running' && lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'completed') {
      const children = this.store.tasks(run.id).filter(child => child.parent_id === task.id);
      const summary = checkpoint.summary;
      // A natural return can publish a leaf deliverable; it never accepts one,
      // and a parent waiting for child work has no deliverable yet.
      if (summary.trim() && children.every(child => ['ACCEPTED', 'CANCELLED'].includes(child.status))) await this.result(memberId, { task_id: task.id, summary }, `native-return:${task.id}:${task.version}`);
    }
    if (this.system.closed || this.system.running(memberId)) return;
    if (task && checkpoint.task?.id === task.id && checkpoint.task.version === task.version && task.status === 'OPEN' && !task.paused && !this.system.suspended(memberId) && run.state === 'running' && lastEnd?.type === 'turn/end' && ['blocked', 'max-tokens', 'interrupted'].includes(lastEnd.data.reason.kind)) {
      await this.result(memberId, { task_id: task.id, summary: `Native execution needs follow-up: ${lastEnd.data.reason.kind}. Inspect this Session's actual journal before continuing.`, outcome: 'blocked' }, `native-blocked:${task.id}:${task.version}`);
    }
    const currentTask = task ? this.store.getTask(task.id) : undefined;
    let ready: T.FlowResult | undefined;
    this.store.transaction(() => {
      if (currentTask?.result_id && currentTask.status === 'SUBMITTED') {
        const result = this.store.getResult(currentTask.result_id);
        if (result && !result.ready) { ready = { ...result, ready: true }; this.store.put('results', ready); this.store.event(run.id, 'result-ready', { result_id: ready.id, task_id: currentTask.id }); }
      }
    });
    if (ready) this.notifyResult(ready);
  }
  failed(memberId: string, error: unknown): void {
    if (this.system.closed) return;
    const member = this.member(memberId), run = this.run(member.team_id); if (terminal(run.state) || member.state === 'closed') return;
    this.store.transaction(() => {
      if (member.active_task_id) { const task = this.taskOf(member.active_task_id); if (!['CANCELLED', 'ACCEPTED'].includes(task.status)) this.store.put('tasks', { ...task, status: 'FAILED', updated: Date.now() }); }
      this.store.event(run.id, 'member-failed', { member_id: memberId, error: messageOf(error) });
      if (member.active_task_id === run.root_task_id) this.changed({ ...run, state: 'failed' });
    });
  }
  notifyResult(result: T.FlowResult): void {
    if (this.system.closed) return;
    const task = this.taskOf(result.task_id), run = this.run(task.team_id);
    if (task.owner_session_id === result.author_session_id) return;
    if (terminal(run.state) || task.result_id !== result.id || task.version !== result.task_version) return;
    void this.message(result.author_session_id, { team_id: run.id, to: task.owner_session_id, task_id: task.id, mode: 'request', content: `Result ready: ${result.id}\nTask: ${task.title} (${task.id})\n${result.summary}\nArtifacts: ${JSON.stringify(result.artifacts)}\nCheck the existing deliverables against this task, then flow_review this result_id. The result is ready; read additional facts only as needed.` }, `result-ready:${result.id}`).catch(error => { if (!this.system.closed) this.ctx.logger.warn(error); });
  }
}
