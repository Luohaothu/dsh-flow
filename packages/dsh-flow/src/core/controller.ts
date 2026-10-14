/** Existing collaboration entry points over the runtime and business facts. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from '../config.ts';
import type { FlowService } from '../service.ts';
import type * as T from '../types.ts';
import { fail } from '../errors.ts';
import { FlowStore } from './store.ts';
import { FlowCollaboration } from './collaboration.ts';
import { FlowSystem } from './system.ts';
import type { NativeFactory } from './runtime.ts';
export type { NativeFactory } from './runtime.ts';
export class FlowController implements FlowService {
  readonly store: FlowStore;
  private readonly system: FlowSystem;
  private readonly collaboration: FlowCollaboration;
  constructor(ctx: Context, config: ResolvedConfig, options: { factory?: NativeFactory } = {}) {
    if (existsSync(join(config.dataDir, 'cluster.sqlite'))) fail('Retired Flow data found. Start with a new dataDir; native Session history remains separate.', 409);
    this.store = new FlowStore(join(config.dataDir, 'flow.sqlite'));
    this.system = new FlowSystem(ctx, config, this.store, () => this.collaboration, () => this, options);
    this.collaboration = new FlowCollaboration(ctx, config, this.store, this.system);
  }
  get closed() { return this.system.closed; }
  createTeam(owner: string, intent: string, request: T.FlowTeamCreateRequest, model?: T.FlowModelSelection) { return this.collaboration.createTeam(owner, intent, request, model); }
  teamRuns(owner: string) { return this.collaboration.teamRuns(owner); }
  teamRead(owner: string, teamId: string) { return this.collaboration.teamRead(owner, teamId); }
  agentSession(sessionId: string) { return this.collaboration.agentSession(sessionId); }
  isTeamAgentSession(sessionId: string) { return this.collaboration.isTeamAgentSession(sessionId); }
  ensureAgent(sessionId: string) { return this.system.ensureAgent(sessionId); }
  task(actor: string, request: T.FlowTaskRequest, operationId?: string) { return this.collaboration.task(actor, request, operationId); }
  result(actor: string, request: T.FlowResultRequest, operationId?: string) { return this.collaboration.result(actor, request, operationId); }
  review(actor: string, request: T.FlowReviewRequest, operationId?: string) { return this.collaboration.review(actor, request, operationId); }
  message(actor: string, request: T.FlowMessageRequest, operationId?: string) { return this.system.agent(actor).send(request, operationId); }
  read(actor: string, request: T.FlowReadRequest) { return this.collaboration.read(actor, request); }
  control(actor: string, request: T.FlowControlRequest, operationId?: string) { return this.collaboration.control(actor, request, operationId); }
  recover() { return this.system.recover(); }
  dispose() { return this.system.dispose(); }
}
