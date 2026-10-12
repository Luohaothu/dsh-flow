/** Minimal native boundary shared by controller behavior tests; no model calls. */
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { FlowController, type NativeFactory } from '../../packages/dsh-flow/src/core/controller.ts';
import type { NativeMember, NativeMemberOptions } from '../../packages/dsh-flow/src/core/runtime.ts';

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function until(condition: () => boolean): Promise<void> {
  for (let i=0; i<100; i++) { if (condition()) return; await tick(); }
  assert.ok(condition(), 'expected the collaboration boundary to settle');
}
export class ControlledNative implements NativeMember {
  readonly agent: Agent;
  readonly inputs: { message: UserMessage; mode: string }[] = [];
  readonly session: Session;
  readonly nextTurn: UserMessage[] = [];
  readonly nextStep: UserMessage[] = [];
  cancelled = 0;
  disposed = 0;
  private busy = false;
  private wait: Promise<void> = Promise.resolve();
  private resolve: (() => void) | undefined;
  private text = '';
  constructor(readonly options: NativeMemberOptions, session?: Session) {
    this.session = session ?? Session.create(SessionId(options.sessionId));
    this.agent = fromPartial<Agent>({ session: this.session, inbox: { nextTurn: this.nextTurn, nextStep: this.nextStep },
      followup: (message: UserMessage) => this.send(message, 'followup'), steer: (message: UserMessage) => this.send(message, 'steer'), inject: (message: UserMessage) => this.send(message, 'notice') });
    Object.defineProperty(this.agent, 'status', { get: () => this.busy ? 'running' : 'idle' });
  }
  send(message: UserMessage, mode: 'followup' | 'steer' | 'notice'): void {
    this.inputs.push({ message, mode });
    const event = this.session.append('user/message', message, { surfaceOp: 'append' });
    this.options.onEvent?.(event);
    if (mode !== 'notice') this.hold();
  }
  hold(): void { if (!this.busy) { this.busy = true; this.wait = new Promise(resolve => { this.resolve = resolve; }); } }
  finish(text = '', kind: 'completed' | 'aborted' = 'completed'): void {
    this.text = text;
    const event = this.session.append('turn/end', { turn: 1, reason: kind === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } } });
    this.options.onEvent?.(event);
    this.busy = false; this.resolve?.(); this.resolve = undefined;
  }
  whenIdle() { return this.wait; }
  async cancel() { this.cancelled++; this.finish('', 'aborted'); await this.wait; }
  async dispose() { this.disposed++; if (this.busy) this.finish('', 'aborted'); }
  running() { return this.busy; }
  lastText() { return this.text; }
  events(): readonly SessionEvent[] { return this.session.snapshotEvents(); }
  async flush() {}
}
export function fixture(t: TestContext, capacity = 4, onCreate?: (native: ControlledNative) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-facts-'));
  const handles = new Map<string, ControlledNative>();
  const sessions = new Map<string, Session>();
  const created: string[] = [];
  const factory: NativeFactory = async (_ctx, options) => {
    const handle = new ControlledNative(options, sessions.get(options.sessionId));
    await onCreate?.(handle);
    handles.set(options.sessionId, handle); sessions.set(options.sessionId, handle.session); created.push(options.sessionId); return handle;
  };
  const agents = new Map<string, Agent>();
  const listeners = new Set<(session: Session, event: SessionEvent) => void>();
  const emit = (session: Session, event: SessionEvent) => { for (const listener of listeners) listener(session, event); };
  const ctx = Object.assign(fromPartial<Context>({}), {
    on: (name: string, listener: (session: Session, event: SessionEvent) => void) => { if (name === 'session/event') listeners.add(listener); return () => listeners.delete(listener); },
    effect: () => () => {}, agents: { get: (id: string) => agents.get(id) }, logger: { warn() {}, error() {} },
  });
  const config = { dataDir: dir, workspace: dir, preset: 'standard', maxConcurrentAgents: capacity };
  let controller = new FlowController(ctx, config, { factory });
  t.after(async () => { await controller.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const startTeam = async (intent = 'start') => {
    const snapshot = await controller.createTeam('owner', intent, { objective: 'Deliver a checked report' });
    return { team: snapshot.run.id, rootTask: snapshot.tasks.find(task => task.id === snapshot.run.root_task_id)! };
  };
  return { dir, handles, created, agents, emit, get flow() { return controller; },
    async reopen() { await controller.dispose(); controller = new FlowController(ctx, config, { factory }); await controller.recover(); return controller; },
    startTeam,
    async startMember(intent = 'start') {
      const root = await startTeam(intent);
      const task = await controller.task('owner', { team_id: root.team, action: 'delegate', objective: 'Deliver a checked report' }, `delegate:${intent}`);
      await until(() => handles.get(task.assignee_session_id)?.running() === true);
      return { ...root, task, member: controller.store.getMember(task.assignee_session_id)!, native: handles.get(task.assignee_session_id)! };
    },
  };
}
