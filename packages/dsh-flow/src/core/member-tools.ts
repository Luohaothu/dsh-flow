/** Six collaboration tools. Native tool execution and turn lifetime remain DSH-owned. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FlowService } from '../service.ts';
import { strictTool } from '../tool-arguments.ts';
import { fail } from '../errors.ts';

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
};
const strings = { type: 'array' as const, items: { type: 'string' as const } };

export function registerMemberTools(ctx: Context, controller: FlowService, memberId?: string): void {
  function actor(exec: ToolRunContext): string {
    exec.signal.throwIfAborted();
    const sessionId = exec.agent?.session.id;
    if (!sessionId) fail('Collaboration tools require a native Agent session', 403);
    if (memberId !== undefined && sessionId !== memberId) fail('This collaboration tool belongs to a different member session', 403);
    return sessionId;
  }
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_task',
    description: 'Delegate a self-contained task to a new or existing member, or update a task you own. Delegation creates work and returns its task and assignee identity; it does not wait for completion. Updates require task_id and its current version. Native tools remain available throughout.',
    parameters: {
      action: { type: 'string', enum: ['delegate', 'update'], required: true },
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      task_id: { type: 'string', description: 'Task to update; required for update.' },
      version: { type: 'integer', description: 'Current task version required for update.' },
      title: { type: 'string', description: 'Short task name.' },
      objective: { type: 'string', description: 'Self-contained instructions with necessary context, constraints and desired output; required for delegation.' },
      criteria: { ...strings, description: 'Concrete criteria used by the task owner to review the result.' },
      depends_on: { ...strings, description: 'Task IDs that must be accepted before this task is dispatched.' },
      member_id: { type: 'string', description: 'Existing member session ID; omit to create a standard native Agent.' },
      parent_task_id: { type: 'string', description: 'Parent task; omit to use the member’s active task.' },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.task(actor(exec), args, exec.callId)); },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_result',
    description: 'Submit your result for the specified assigned task. Describe what was achieved and provide artifact locations. Submission does not end this native turn; finish verification before submitting. The task owner reviews the immutable result.',
    parameters: {
      task_id: { type: 'string', required: true },
      summary: { type: 'string', required: true, description: 'What was achieved, verification performed, and material limitations.' },
      artifacts: { ...strings, description: 'Actual artifact paths or source references. These are collaboration references, not execution permissions.' },
      outcome: { type: 'string', enum: ['complete', 'partial', 'blocked'], description: 'Defaults to complete. Partial or blocked requires the owner’s follow-up.' },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.result(actor(exec), args, exec.callId)); },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_review',
    description: 'Review a result for a task you own. Use ordinary native tools to verify it, then accept or reject with a reason and evidence references. Acceptance is a business decision, never inferred from an idle Agent or tool count.',
    parameters: {
      result_id: { type: 'string', required: true },
      accepted: { type: 'boolean', required: true },
      notes: { type: 'string', required: true, description: 'Reason for acceptance, or precise work required after rejection.' },
      evidence: { ...strings, description: 'Verification details or source/artifact references supporting the decision.' },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.review(actor(exec), args, exec.callId)); },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_message',
    description: 'Send another participant context or a request. Request wakes an idle Agent or steers an active one; notice adds context without waking it. Messages do not replace task delegation, result submission or review.',
    parameters: {
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      to: { type: 'string', required: true, description: 'Recipient member session ID or the team owner session ID.' },
      content: { type: 'string', required: true },
      task_id: { type: 'string', description: 'Related task, if any.' },
      mode: { type: 'string', enum: ['request', 'notice'], description: 'Defaults to request.' },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.message(actor(exec), args, exec.callId)); },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_read',
    description: 'Read team collaboration facts, task/result detail, member identities, messages or events. Use next_offset to continue a paginated list. Native Session history remains the source for native execution details.',
    parameters: {
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      what: { type: 'string', enum: ['team', 'task', 'member', 'result', 'messages', 'events'], description: 'Defaults to team.' },
      id: { type: 'string', description: 'Task, member or result ID for a specific detail.' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.read(actor(exec), args)); },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_control',
    description: 'Pause, resume or cancel a team, member or task you control. Pause stops Flow dispatch and drains active native work; resume allows pending collaboration work to continue. Cancel does not imply success.',
    parameters: {
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      target: { type: 'string', enum: ['team', 'member', 'task'], required: true },
      id: { type: 'string', required: true },
      action: { type: 'string', enum: ['pause', 'resume', 'cancel'], required: true },
    },
    output,
    async execute(args, exec) { return JSON.stringify(await controller.control(actor(exec), args, exec.callId)); },
  })));
}
