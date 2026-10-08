/** Native continuation follows recorded resource ownership and the authoritative run state. */
import type { FlowAgentSession, FlowTeamAgent, FlowTeamRun } from './types.ts';

export function projectAgentSession(run: FlowTeamRun, agent: FlowTeamAgent): FlowAgentSession {
  const reason = agent.recycled ? '该智能体已回收，不再接受消息。可在这里查看完整执行记录。'
    : ['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.raw_state) ? '团队已结束，不再接受消息。历史对话和轨迹仍可查看。' : null;
  return {run,agent,can_message:reason === null,message_block_reason:reason};
}
