import { agentControl } from '../core/internals.js';
import type { RunService } from '../run/run.js';
import { runServiceControl } from '../run/internal.js';
import type { DashboardProjector } from './projector.js';
import type { OperationAccepted, OperationView, StopRequest, StopTarget } from './protocol.js';

export class OperationRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function decodeStopRequest(value: unknown): StopRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationRequestError(400, 'invalid-request', 'Expected stop request');
  const record = value as Record<string, unknown>;
  const validString = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256;
  if (!validString(record.operationId) || !validString(record.targetEpoch)) throw new OperationRequestError(400, 'invalid-request', 'operationId and targetEpoch are required');
  if (Object.keys(record).some(key => !['operationId', 'targetEpoch', 'scope', 'agentId'].includes(key))) throw new OperationRequestError(400, 'invalid-request', 'Unknown stop request field');
  if (validString(record.agentId) && !Object.hasOwn(record, 'scope')) return { operationId: record.operationId, targetEpoch: record.targetEpoch, agentId: record.agentId };
  if (record.scope === 'run' && !Object.hasOwn(record, 'agentId')) return { operationId: record.operationId, targetEpoch: record.targetEpoch, scope: 'run' };
  throw new OperationRequestError(400, 'invalid-request', 'Specify exactly one stop target');
}
interface Slot { normalized: string; accepted: OperationAccepted; result: Promise<void> }
export class DashboardOperations {
  private readonly slots = new Map<string, Slot>();
  constructor(private readonly projector: DashboardProjector, private readonly service: RunService) {}
  stop(runId: string, request: StopRequest): OperationAccepted {
    const key = JSON.stringify([request.targetEpoch, runId, request.operationId]);
    const target: StopTarget = 'agentId' in request && request.agentId !== undefined ? { agentId: request.agentId } : { scope: 'run' };
    const normalized = JSON.stringify(target);
    const previous = this.slots.get(key);
    if (previous) {
      if (previous.normalized !== normalized) throw new OperationRequestError(409, 'operation-conflict', 'Operation ID was reused with a different target');
      return { ...previous.accepted };
    }
    if (request.targetEpoch !== this.service.epoch) throw new OperationRequestError(409, 'reset-required', 'Run epoch expired');
    try { this.service[runServiceControl].snapshot(runId); }
    catch { throw new OperationRequestError(404, 'run-unavailable', 'Run is unavailable'); }
    let resolve!: () => void;
    const result = new Promise<void>(yes => { resolve = yes; });
    const accepted: OperationAccepted = { operationId: request.operationId, status: 'accepted' };
    this.slots.set(key, { normalized, accepted, result });
    const operation: OperationView = { id: request.operationId, target, status: 'accepted' };
    this.projector.operation(runId, operation);
    void Promise.resolve().then(async () => {
      if ('agentId' in target && target.agentId !== undefined) {
        const agent = this.projector.lookupAgent(runId, target.agentId);
        if (!agent) throw new Error('Agent instance is unavailable');
        const parent = agent.getParent();
        if (parent) await parent[agentControl].kill(agent, 'user');
        else {
          const view = this.service[runServiceControl].snapshot(runId);
          if (view.root !== agent) throw new Error('Target is not the current Run root');
          await this.service[runServiceControl].release(runId, request.targetEpoch);
        }
      } else await this.service[runServiceControl].release(runId, request.targetEpoch);
    }).then(
      () => { this.projector.operation(runId, { ...operation, status: 'completed' }); resolve(); },
      error => { this.projector.operation(runId, { ...operation, status: 'failed', error: error instanceof Error ? error.message : String(error) }); resolve(); },
    );
    return { ...accepted };
  }
  async settled(): Promise<void> { await Promise.all([...this.slots.values()].map(slot => slot.result)); }
}
