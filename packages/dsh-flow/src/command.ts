import type { Context } from '@deepseek-ai/cordis';
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { DshNativeBridge } from './host/native-bridge.js';

/** Human entry: inject the selected skill and task into the ordinary main session. */
export function registerAgentTeamCommand(ctx: Context, bridge: DshNativeBridge, instructions: string): () => void {
  const delivered = new Map<string, { digest: string; promise: Promise<CommandResult> }>();
  async function invoke(invocation: CommandInvocation): Promise<CommandResult> {
    // The command is globally discoverable, so classify before reading its input.
    if (!bridge.isOrdinary(invocation.agent)) return { kind: 'error', text: '请在普通主会话中使用 /agent-team。' };
    invocation.signal.throwIfAborted();
    const task = invocation.rawInput.trim();
    if (!task) return { kind: 'error', text: '请描述希望团队完成的任务。' };
    const key = JSON.stringify([invocation.agent.session.id, invocation.commandId]);
    const digest = JSON.stringify([task, invocation.attachments]);
    const previous = delivered.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error('Command identity was reused with different input');
      return previous.promise;
    }
    const promise = (async (): Promise<CommandResult> => {
      const materials = await bridge.admitCommand(invocation);
      invocation.signal.throwIfAborted();
      if (!bridge.isOrdinary(invocation.agent)) throw new Error('Main session is no longer available');
      invocation.agent.inject(createUserMessage({ source: { kind: 'skill-invocation', name: 'agent-team', form: 'instructions' }, content: [{ type: 'text', text: instructions }] }));
      invocation.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
        { type: 'text', text: `/agent-team ${task}` }, ...invocation.attachments,
        ...(materials.length ? [{ type: 'text' as const, text: `已接纳的作业材料引用：${JSON.stringify(materials)}` }] : []),
      ] }));
      return { kind: 'success', text: '团队技能与任务已交给主会话，由其选择团队并派发作业。' };
    })();
    delivered.set(key, { digest, promise });
    try { return await promise; } catch (error) { delivered.delete(key); throw error; }
  }
  const unregister = ctx.commands.register({ definitionId: CommandDefinitionId('dsh-flow/agent-team'), name: 'agent-team',
    description: '选择、复用或创建长期团队，并独立派发作业', input: { hint: '请描述希望团队完成的任务', attachments: true }, handler: invoke });
  return () => { unregister(); delivered.clear(); };
}
