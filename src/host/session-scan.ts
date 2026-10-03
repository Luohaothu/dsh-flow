/**
 * Count delivery markers inside a *native* DSH Session log. This is the only
 * evidence for "the recipient saw this message exactly once": the recipients
 * table enforces its own uniqueness and proves nothing about injection.
 *
 * Sessions are appended as a sequence of checksummed Zstandard frames, so the
 * scan decompresses every frame (the `zstd` CLI handles concatenated frames)
 * and then reads the decoded log as exact native events. A scan that cannot
 * read or parse the log returns UNKNOWN: "I could not look" is never the same
 * answer as "it is not there".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The exact marker a delivery carries into the recipient's session. */
export const DELIVERY_MARKER = '[[flow-delivery';

/** One native session event, narrowed from the log's JSON line. */
export interface SessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

/** The decoded log's events, or why it could not be decoded. */
export type SessionReadResult =
  | { state: 'READ'; events: SessionEvent[]; reason: null }
  | { state: 'UNKNOWN'; events: SessionEvent[]; reason: string };

/** One delivery whose marker is counted inside a session log. */
export interface DeliveryCountRef {
  readonly message_id: string;
  readonly delivery_seq: number;
}

/**
 * How many delivery markers the log carries, or why the log could not be read.
 *
 * `FOUND` means the log was read and `counted` holds one entry per requested
 * message; `ABSENT` is reserved for a scan that read the log and proved a
 * delivery is nowhere in it, and `UNKNOWN` means the scan itself failed.
 */
export type DeliveryScanResult =
  | { state: 'FOUND'; counted: Record<string, number>; events: number; reason: null }
  | { state: 'ABSENT'; counted: Record<string, number>; events: number; reason: string | null }
  | { state: 'UNKNOWN'; counted: Record<string, number>; events: number; reason: string };

/** The complete marker string one delivery injects into the recipient's session. */
export function markerFor(messageId: string, deliverySeq: number): string {
  return `${DELIVERY_MARKER} ${messageId} seq ${deliverySeq}]]`;
}

/** The session log for one session id, or null when no log exists yet. */
export function findSessionFile(sessionsRoot: string, sessionId: string): string | null {
  if (!existsSync(sessionsRoot)) return null;
  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = join(sessionsRoot, project.name, sessionId);
    if (!existsSync(candidate)) continue;
    for (const file of readdirSync(candidate)) {
      if (file.startsWith('session.') && (file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))) return join(candidate, file);
    }
  }
  return null;
}

/**
 * The decoded session log, or `null` when it cannot be decoded. A zstd frame
 * that will not decompress must never be counted as if it were plain text: the
 * mismatched bytes would answer a different question.
 */
export function readSessionText(file: string): string | null {
  const raw = readFileSync(file);
  if (!file.endsWith('.zstd')) return raw.toString('utf8');
  const decoded = spawnSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 30 });
  if (decoded.status !== 0 || !decoded.stdout?.length) return null;
  return decoded.stdout.toString('utf8');
}

/**
 * The parsed native events of one session log, or UNKNOWN when it cannot be read
 * or parsed. Callers analyse the events themselves: the log is the host's own
 * record of what happened in a session, and a check that reads it is reading
 * evidence rather than an inference.
 */
export function readSessionEvents(file: string): SessionReadResult {
  let text: string | null;
  try {
    text = readSessionText(file);
  } catch (error) {
    return { state: 'UNKNOWN', events: [], reason: `read failed: ${messageOf(error)}` };
  }
  if (text === null) return { state: 'UNKNOWN', events: [], reason: 'the session log could not be decompressed' };
  const events: SessionEvent[] = [];
  let index = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return { state: 'UNKNOWN', events, reason: `line ${index + 1} is not a native session event: ${messageOf(error)}` };
    }
    index += 1;
    const event = asRecord(parsed);
    events.push({ seq: typeof event?.seq === 'number' ? event.seq : index, type: String(event?.type ?? ''), data: event?.data ?? {} });
  }
  return { state: 'READ', events, reason: null };
}

/**
 * How many incoming conversation messages carry each delivery's own marker.
 *
 * Only a `user/message` event whose payload contains the *complete* marker
 * (`[[flow-delivery <id> seq <n>]]`) proves receipt: a sender's own tool result
 * also contains the message id it just sent, so an id-substring count would
 * treat "I sent it" as "I received it".
 */
export function countDeliveriesInSession(file: string, deliveries: readonly DeliveryCountRef[]): DeliveryScanResult {
  let text: string | null;
  try {
    text = readSessionText(file);
  } catch (error) {
    return { state: 'UNKNOWN', counted: {}, events: 0, reason: `read failed: ${messageOf(error)}` };
  }
  if (text === null) return { state: 'UNKNOWN', counted: {}, events: 0, reason: 'the session log could not be decompressed' };
  const counted: Record<string, number> = Object.fromEntries(deliveries.map(entry => [entry.message_id, 0]));
  let events = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return { state: 'UNKNOWN', counted, events, reason: `line ${events + 1} is not a native session event: ${messageOf(error)}` };
    }
    events += 1;
    const event = asRecord(parsed);
    if (!/user\/message|user_message/i.test(String(event?.type ?? ''))) continue;
    const serialized = JSON.stringify(event?.data ?? event);
    for (const entry of deliveries) {
      if (serialized.includes(markerFor(entry.message_id, entry.delivery_seq))) {
        counted[entry.message_id] = (counted[entry.message_id] ?? 0) + 1;
      }
    }
  }
  return { state: 'FOUND', counted, events, reason: null };
}

/** A non-null, non-array object view of an unknown JSON value. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The message of a thrown unknown, or its string form when it carries none. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    return message === undefined || message === null ? String(error) : String(message);
  }
  return String(error);
}