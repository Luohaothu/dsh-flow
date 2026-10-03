import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { asObject, requiredString, messageOf } from '../context.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'native-test': { kind: 'native-test' };
  }
}

export interface Config {
  evidencePath: string;
  workspace: string;
  provider: string;
  model: string;
}

export const name = 'flow-native-observer';
export const inject = ['flow', 'agents', 'agentLoop', 'tools', 'llm', 'compaction', 'agentPresets'];

/** Observes the real request waterfall and drives only fixture-owned Agents. */
export function apply(ctx: Context, config: Config): void {
  const pending = new Set<Promise<void>>();
  const handles = new Set<AgentHandle>();
  let closed = false;
  ctx.on('llm/stream', async function* (options, next) {
    const before = JSON.stringify(options);
    try {
      yield* next();
    } finally {
      if (!closed) appendFileSync(config.evidencePath, `${JSON.stringify({
        session_id: options.sessionId ?? null,
        provider: options.provider,
        model: options.model,
        before,
        after: JSON.stringify(options),
        purpose: options.purpose ?? null,
      })}\n`);
    }
  });

  const receive = (value: unknown): void => {
    const message = asObject(value);
    if (!message || message.nativeObserver !== true) return;
    const requestId = requiredString(message.requestId, 'native observer request id');
    const operation = message.operation;
    const task = (async () => {
      try {
        if (closed) throw new Error('native observer disposed');
        if (operation !== 'scopes' && operation !== 'ordinary') throw new Error('unknown native observer operation');
        const ordinary = await ctx.agents.create({
          sessionId: SessionId(randomUUID()),
          meta: { cwd: config.workspace },
          agentOptions: { provider: config.provider, model: config.model, maxTokens: 512 },
        });
        handles.add(ordinary);
        try {
          if (closed) throw new Error('native observer disposed during creation');
          const ordinaryTools = ordinary.agent.ctx.tools.schemas(scopeOf(ordinary.agent.ctx)).map(tool => tool.name);
          if (operation === 'ordinary') {
            ordinary.agent.followup(createUserMessage({
              content: [{ type: 'text', text: 'NATIVE-ORDINARY: answer with OK; do not call a tool.' }],
              source: { kind: 'native-test' },
            }));
            await ordinary.agent.whenIdle();
            process.send?.({ nativeObserver: true, requestId, ok: true, value: { session_id: ordinary.agent.id, ordinary_tools: ordinaryTools } });
          } else {
            const preset = await ctx.agents.create({
              sessionId: SessionId(randomUUID()),
              meta: { cwd: config.workspace },
              agentOptions: { provider: config.provider, model: config.model },
              setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'cluster'); },
            });
            handles.add(preset);
            try {
              if (closed) throw new Error('native observer disposed during preset creation');
              process.send?.({ nativeObserver: true, requestId, ok: true, value: {
                ordinary_tools: ordinaryTools,
                preset_tools: preset.agent.ctx.tools.schemas(scopeOf(preset.agent.ctx)).map(tool => tool.name),
              } });
            } finally {
              await preset.dispose();
              handles.delete(preset);
            }
          }
        } finally {
          await ordinary.dispose();
          handles.delete(ordinary);
        }
      } catch (error) {
        process.send?.({ nativeObserver: true, requestId, ok: false, error: messageOf(error) });
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  };
  process.on('message', receive);
  ctx.effect(() => async () => {
    closed = true;
    process.off('message', receive);
    for (const handle of handles) handle.agent.cancel({ kind: 'hook', reason: 'native observer disposed' });
    await Promise.all(pending);
  });
}
