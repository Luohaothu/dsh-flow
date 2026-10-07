/**
 * The plugin's single failure vocabulary.
 *
 * Command paths, tools, local callers and Remote endpoints reject operations
 * through {@link fail}. The Gateway carries the shared `RemoteError` and its
 * business status in `details.status`. This module is safe for Client imports.
 */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * A refused cluster command: 400 malformed or out-of-range input,
     * 403 unauthorized actor or domain, 404 unknown identity, or 409 state conflict.
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