import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { registerMemberTools } from '../../packages/dsh-flow/src/core/member-tools.ts';
import type { FlowService } from '../../packages/dsh-flow/src/service.ts';

function fixture(memberId?: string) {
  const tools = new Map<string, ToolDefinition>();
  const calls: unknown[][] = [];
  const ctx = fromPartial<Context>({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {}; } } });
  const controller = fromPartial<FlowService>({
    task: async (...args: Parameters<FlowService['task']>) => { calls.push(['task', ...args]); return fromPartial<Awaited<ReturnType<FlowService['task']>>>({ id: 'task-1' }); },
    result: async (...args: Parameters<FlowService['result']>) => { calls.push(['result', ...args]); return fromPartial<Awaited<ReturnType<FlowService['result']>>>({ id: 'result-1' }); },
    review: async (...args: Parameters<FlowService['review']>) => { calls.push(['review', ...args]); return fromPartial<Awaited<ReturnType<FlowService['review']>>>({ id: 'review-1' }); },
    message: async (...args: Parameters<FlowService['message']>) => { calls.push(['message', ...args]); return fromPartial<Awaited<ReturnType<FlowService['message']>>>({ id: 'message-1' }); },
    read: (...args: Parameters<FlowService['read']>) => { calls.push(['read', ...args]); return { what: 'team', value: {}, total: 0, offset: 0, next_offset: null }; },
    control: async (...args: Parameters<FlowService['control']>) => { calls.push(['control', ...args]); return fromPartial<Awaited<ReturnType<FlowService['control']>>>({}); },
  });
  registerMemberTools(ctx, controller, memberId);
  const execution = (id: string, signal = new AbortController().signal) => fromPartial<ToolRunContext>({
    agent: { session: { id: SessionId(id) } }, callId: ToolCallId('native-call-1'), signal,
  });
  const execute = (name: string, args: unknown, id = 'session-member') => {
    const tool = tools.get(name); assert.ok(tool); return tool.execute(args, execution(id));
  };
  return { tools, calls, execution, execute };
}

test('six concrete tools use the native actor and stable call identity without ending its turn', async () => {
  const { tools, calls, execute } = fixture('session-member');
  assert.deepEqual([...tools.keys()], ['flow_task', 'flow_result', 'flow_review', 'flow_message', 'flow_read', 'flow_control']);
  await execute('flow_task', { action: 'delegate', objective: 'Check the data' });
  await execute('flow_result', { task_id: 'task-1', summary: 'Done' });
  await execute('flow_review', { result_id: 'result-1', accepted: true, notes: 'Checked' });
  await execute('flow_message', { to: 'session-other', content: 'Context', mode: 'notice' });
  await execute('flow_read', { what: 'result', id: 'result-1' });
  await execute('flow_control', { target: 'task', id: 'task-1', action: 'pause' });
  assert.equal(calls.length, 6);
  for (const [kind, actor, , operationId] of calls) {
    assert.equal(actor, 'session-member');
    assert.equal(operationId, kind === 'read' ? undefined : 'native-call-1');
  }
  // The minimal real execution surface intentionally has no concludeTurn method.
  assert.equal(calls[1]?.[0], 'result');
});

test('strict member inputs reject unknown fields, nulls and invalid enums before controller mutation', async () => {
  const { execute, calls } = fixture('session-member');
  for (const [name, args] of [
    ['flow_task', { action: 'delegate', objective: 'x', actor_session_id: 'forged' }],
    ['flow_task', { action: 'allocate', objective: 'x' }],
    ['flow_task', { action: 'delegate', objective: 'x', criteria: ['Invented extra acceptance gate'] }],
    ['flow_task', { action: 'delegate', objective: 'x', profile: { capabilities: ['read'] } }],
    ['flow_task', { action: 'delegate', objective: 'x', profile: { role: 7 } }],
    ['flow_task', { action: 'delegate', objective: 'x', profile: { role: 'allocator' } }],
    ['flow_message', { to: 'someone', content: 'x', task_id: null }],
    ['flow_review', { result_id: 'r', accepted: 'true', notes: 'x' }],
    ['flow_read', { what: 'transactions' }],
    ['flow_control', { target: 'agent', id: 'x', action: 'resume' }],
  ] as const) await assert.rejects(async () => execute(name, args));
  assert.equal(calls.length, 0);
});

test('one delegation carries a role profile through the public tool interface', async () => {
  const {execute,calls}=fixture();
  const profile={name:'资源统筹',role:'orchestrator',instructions:'统筹工作',preset:'standard',skills:['analysis'],model:{provider:'configured',model:'local'}};
  await execute('flow_task',{action:'delegate',objective:'安排独立工作',profile});
  assert.deepEqual(calls[0]?.[2],{action:'delegate',objective:'安排独立工作',profile});
});

for (const [field, value] of [
  ['depends_on', ['task-prior']],
  ['parent_task_id', 'task-forged-parent'],
] as const) {
  test(`flow_task rejects retired ${field} before controller mutation`, async () => {
    const { execute, calls } = fixture('session-member');
    await assert.rejects(async () => execute('flow_task', { action: 'delegate', objective: 'x', [field]: value }));
    assert.equal(calls.length, 0);
  });
}

test('scoped tools reject a different native actor, while the owner surface delegates authorization to the controller', async () => {
  const scoped = fixture('session-member');
  await assert.rejects(async () => scoped.execute('flow_read', {}, 'session-other'), /different member session/u);
  assert.equal(scoped.calls.length, 0);
  const global = fixture();
  await global.execute('flow_read', { team_id: 'team-1' }, 'session-owner');
  assert.equal(global.calls[0]?.[1], 'session-owner');
  const read = global.tools.get('flow_read'); assert.ok(read);
  await assert.rejects(async () => read.execute({}, fromPartial<ToolRunContext>({ signal: new AbortController().signal })), /native Agent session/u);
});

test('an already cancelled native invocation cannot mutate Flow state', async () => {
  const { tools, calls, execution } = fixture('session-member');
  const signal = AbortSignal.abort(new Error('cancelled before admission'));
  const result = tools.get('flow_result'); assert.ok(result);
  await assert.rejects(async () => result.execute({ task_id: 'task-1', summary: 'Done' }, execution('session-member', signal)), /cancelled before admission/u);
  assert.equal(calls.length, 0);
});
