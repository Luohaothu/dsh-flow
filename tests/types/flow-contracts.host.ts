/** Host-only service contract; keep Client Cordis declarations in the other program. */
import type { FlowService } from '../../packages/dsh-flow/src/service.ts';
import type { FlowTask, FlowResult, FlowReview } from '../../packages/dsh-flow/src/types.ts';
export async function collaborationContract(service: FlowService, session: string, task: FlowTask): Promise<FlowReview> {
  const result: FlowResult = await service.result(session, { task_id: task.id, summary: 'Actual delivery', artifacts: ['report.md'] }, 'result-call');
  return service.review(task.owner_session_id, { result_id: result.id, accepted: true, notes: 'Inspected the delivered report' }, 'review-call');
}
