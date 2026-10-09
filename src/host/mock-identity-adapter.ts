/** Development-only transport attribution for the deterministic model endpoint. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import { fromAny } from '@total-typescript/shoehorn';
import type { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { MockTrustedIdentity } from './mock-model.ts';

export interface Config { baseURL: string; identityKey: string }
export const name = 'flow-mock-identity';
export const inject = ['flow', 'llm'];

/** Attribute concurrent native requests without adding anything to model messages. */
export function apply(ctx: Context, config: Config): void {
  const attribution = new AsyncLocalStorage<MockTrustedIdentity>();
  const originalFetch = globalThis.fetch;
  const attributedFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const identity = attribution.getStore();
    if (!identity || !url.startsWith(`${config.baseURL}/chat/completions`)) return originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('x-flow-fixture-key', config.identityKey);
    headers.set('x-flow-fixture-identity', Buffer.from(JSON.stringify(identity)).toString('base64url'));
    return originalFetch(input, { ...init, headers });
  };
  globalThis.fetch = attributedFetch;
  ctx.on('llm/stream', async function* (options, next) {
    const runtime = fromAny<ClusterRuntime, typeof ctx.flow>(ctx.flow);
    const agent = options.sessionId ? runtime.store.getAgentBySession(String(options.sessionId)) : undefined;
    const node = agent ? runtime.store.getNode(agent.node_id) : undefined;
    const identity: MockTrustedIdentity = {
      sessionId: options.sessionId ? String(options.sessionId) : null,
      role: agent?.role ?? null,
      nodeId: agent?.node_id ?? null,
      depth: node?.depth ?? null,
      agentId: agent?.id ?? null,
      epoch: agent?.epoch,
      turnSeq: agent ? agent.turns + 1 : undefined,
      purpose: options.purpose ?? null,
    };
    const iterator = next()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await attribution.run(identity, () => iterator.next());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      if (iterator.return) await attribution.run(identity, () => iterator.return!());
    }
  });
  ctx.effect(() => () => {
    if (globalThis.fetch === attributedFetch) globalThis.fetch = originalFetch;
    attribution.disable();
  });
}
