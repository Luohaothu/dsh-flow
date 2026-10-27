import { AsyncLocalStorage } from 'node:async_hooks';
import type { Agent } from '../core/agent.js';

interface TrustedCall { actor: Agent; transportKey: string }
const calls = new AsyncLocalStorage<Readonly<TrustedCall>>();
export function withTrustedCall<T>(call: TrustedCall, fn: () => T): T {
  if (!call.actor || typeof call.transportKey !== 'string' || !call.transportKey.trim()) throw new TypeError('Trusted call requires actor and transportKey');
  return calls.run(Object.freeze({ actor: call.actor, transportKey: call.transportKey }), fn);
}
export function trustedCall(actor: Agent): Readonly<TrustedCall> {
  const call = calls.getStore();
  if (!call || call.actor !== actor) throw new Error('Submission requires trusted transport call context for its caller');
  return call;
}
