import type { HostAdaptor, HostAgent, Usage } from './types.js';

export class AuxiliaryCallError extends Error {
  readonly usage: readonly Usage[];
  constructor(message: string, usage: readonly Usage[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuxiliaryCallError';
    this.usage = structuredClone(usage);
  }
}
const sinks = new WeakMap<HostAdaptor, (target: HostAgent, usage: readonly Usage[]) => void>();
export function registerAuxiliaryUsageSink(adaptor: HostAdaptor, sink: (target: HostAgent, usage: readonly Usage[]) => void): () => void {
  if (sinks.has(adaptor)) throw new Error('Auxiliary usage sink already registered');
  sinks.set(adaptor, sink);
  return () => { if (sinks.get(adaptor) === sink) sinks.delete(adaptor); };
}
export function settleAuxiliaryUsage(adaptor: HostAdaptor, target: HostAgent, usage: readonly Usage[]): void {
  if (!adaptor.capabilities.usage || usage.length === 0) return;
  const sink = sinks.get(adaptor);
  if (!sink) throw new Error('Usage-capable adaptor has no auxiliary usage sink');
  sink(target, structuredClone(usage));
}

type SettlementScope = { pending: number; done: Promise<void>; finish: () => void };
const scopes = new WeakMap<HostAdaptor, WeakMap<HostAgent, SettlementScope>>();
export function beginAuxiliaryUsageSettlement(adaptor: HostAdaptor, target: HostAgent): () => void {
  let byAgent = scopes.get(adaptor);
  if (!byAgent) { byAgent = new WeakMap(); scopes.set(adaptor, byAgent); }
  let scope = byAgent.get(target);
  if (!scope || scope.pending === 0) {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    scope = { pending: 0, done, finish }; byAgent.set(target, scope);
  }
  scope.pending++;
  const current = scope;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--current.pending === 0) current.finish();
  };
}
export function awaitAuxiliaryUsageSettlements(adaptor: HostAdaptor, target: HostAgent): Promise<void> {
  return scopes.get(adaptor)?.get(target)?.done ?? Promise.resolve();
}
