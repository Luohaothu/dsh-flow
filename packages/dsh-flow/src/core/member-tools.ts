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
    description: 'Delegate independent work with available inputs to a new or existing Flow member, or update a task you own. The current Agent task determines the parent. Returns immediately with task and assignee_session_id; communicate through flow_message. Updates require task_id and its current version; revising queued work does not pause unrelated active work. Native tools remain available throughout.',
    parameters: {
      action: { type: 'string', enum: ['delegate', 'update'], required: true },
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      task_id: { type: 'string', description: 'Task to update; required for update.' },
      version: { type: 'integer', description: 'Current task version required for update.' },
      title: { type: 'string', description: 'Short task name.' },
      objective: { type: 'string', description: 'Self-contained instructions with necessary context, constraints and desired output; required for delegation.' },
      member_id: { type: 'string', description: 'Existing member session ID; omit to create a standard native Agent.' },
      profile: { type: 'object', description: 'Optional role configuration for a NEW member only. All roles use the same standard DSH Agent. Omitted settings inherit normal native/team defaults; reuse retains the member profile.', additionalProperties: false, properties: {
        name: { type: 'string', description: 'Stable member name, independent of the task title.' },
        role: { type: 'string', enum: ['orchestrator', 'worker'], description: 'orchestrator coordinates planning, resource selection, delegation and acceptance; worker executes tasks. Defaults to worker. Both use complete standard Agents. Specialization belongs in name, instructions and skills.' },
        instructions: { type: 'string', description: 'Standing role responsibilities composed into the native system prompt.' },
        preset: { type: 'string', description: 'An installed native DSH preset; omit to inherit.' },
        skills: { ...strings, description: 'Installed model-invocable native skill names to load as role instructions.' },
        model: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } },
      } },
    },
    output,
    async execute(args, exec) {
      const task = await controller.task(actor(exec), args, exec.callId);
      return JSON.stringify({ task_id: task.id, team_id: task.team_id, assignee_session_id: task.assignee_session_id, version: task.version, status: task.status });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_result',
    description: 'Record a structured result for your assigned task, with concise verification, artifact references and limitations. A member’s normal completed final reply is already published for its owner to review; use this tool for an explicit result, especially partial or blocked work. The main owner’s complete root result finishes the team after its child tasks are accepted or cancelled. Submission does not end the native turn.',
    parameters: {
      task_id: { type: 'string', required: true },
      summary: { type: 'string', required: true, description: 'What was achieved, verification performed, and material limitations.' },
      artifacts: { ...strings, description: 'Actual artifact paths or source references. These are collaboration references, not execution permissions.' },
      outcome: { type: 'string', enum: ['complete', 'partial', 'blocked'], description: 'Defaults to complete. Partial or blocked requires the owner’s follow-up.' },
    },
    output,
    async execute(args, exec) {
      const result = await controller.result(actor(exec), args, exec.callId);
      return JSON.stringify({ result_id: result.id, task_id: result.task_id, task_version: result.task_version, outcome: result.outcome, ready: result.ready });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_review',
    description: 'Accept or reject a current result delegated by you. Check the existing artifacts and receipts against the task requirements with native tools; collect additional evidence when something is missing or contradictory. This is for delegated results, not reviewing your own root completion.',
    parameters: {
      result_id: { type: 'string', required: true },
      accepted: { type: 'boolean', required: true },
      notes: { type: 'string', required: true, description: 'Reason for acceptance, or precise work required after rejection.' },
      evidence: { ...strings, description: 'Verification details or source/artifact references supporting the decision.' },
    },
    output,
    async execute(args, exec) {
      const review = await controller.review(actor(exec), args, exec.callId);
      return JSON.stringify({ review_id: review.id, result_id: review.result_id, task_id: review.task_id, accepted: review.accepted });
    },
  })));
  ctx.tools.register(strictTool(defineTool({
    name: 'flow_message',
    description: 'Send context or a request to a Flow member’s assignee_session_id, or the team owner session ID. Request wakes an idle Agent or steers an active one; notice adds context without waking it. Native continuable subagent IDs belong to the native messaging tools instead.',
    parameters: {
      team_id: { type: 'string', description: 'Omit to use this member’s team.' },
      to: { type: 'string', required: true, description: 'Recipient member session ID or the team owner session ID.' },
      content: { type: 'string', required: true },
      task_id: { type: 'string', description: 'Related task, if any.' },
      mode: { type: 'string', enum: ['request', 'notice'], description: 'Defaults to request.' },
    },
    output,
    async execute(args, exec) {
      const message = await controller.message(actor(exec), args, exec.callId);
      return JSON.stringify({ message_id: message.id, to_session_id: message.to_session_id, state: message.state, mode: message.mode });
    },
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
