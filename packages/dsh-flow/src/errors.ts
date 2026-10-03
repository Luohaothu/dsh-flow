/**
 * The plugin's single failure vocabulary.
 *
 * Cluster rejections are business answers, not defects: every command path,
 * tool call, local caller and Remote endpoint fails through {@link fail}, which
 * throws the one `RemoteError` the Gateway already knows how to carry. The
 * former per-domain `StoreError` (and the `store`/`protocol` re-exports of
 * `fail`) is gone: a caller imports this module directly, and the 400/403/404/409
 * distinction lives in `details.status` instead of an ad-hoc `error.status`.
 *
 * This module is Client-safe on purpose: the browser panel validates form input
 * with the same helpers that refuse a command on the host.
 */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * A cluster command was refused. `status` preserves the four business
     * meanings the previous local error carried: 400 malformed or out-of-range
     * input, 403 an actor or domain the caller may not touch, 404 an unknown
     * identity, 409 a state conflict (a fenced turn, a terminal transition).
     */
    'flow/rejected': { readonly status: number }
  }
}

/**
 * Refuse the current operation with the plugin's business failure.
 * @param message - human diagnostic; preserved verbatim across the wire.
 * @param status - business status: 400 input, 403 authorization, 404 identity, 409 state conflict.
 * @returns never; the call always throws.
 */
export function fail(message: string, status = 400): never {
  throw new RemoteError('flow/rejected', message, { status });
}

/**
 * Read the business status of a caught cluster rejection.
 * @param error - any caught value.
 * @returns the rejection status, or undefined when the value is not a cluster refusal.
 */
export function rejectionStatus(error: unknown): number | undefined {
  const failure = remoteErrorOf(error);
  if (failure === undefined || failure.code !== 'flow/rejected') return undefined;
  return failure.details.status;
}

/**
 * Render a caught value for a log line or a runner envelope.
 * @param error - any caught value.
 * @returns the message when there is one, otherwise the stringified value.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}