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

export function markerFor(messageId, deliverySeq) {
  return `${DELIVERY_MARKER} ${messageId} seq ${deliverySeq}]]`;
}

export function findSessionFile(sessionsRoot, sessionId) {
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
export function readSessionText(file) {
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
 *
 * @returns {{state:'READ'|'UNKNOWN', events:Array<{seq:number,type:string,data:object}>, reason?:string}}
 */
export function readSessionEvents(file) {
  let text;
  try {
    text = readSessionText(file);
  } catch (error) {
    return { state: 'UNKNOWN', events: [], reason: `read failed: ${error?.message ?? error}` };
  }
  if (text === null) return { state: 'UNKNOWN', events: [], reason: 'the session log could not be decompressed' };
  const events = [];
  let index = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      return { state: 'UNKNOWN', events, reason: `line ${index + 1} is not a native session event: ${error.message}` };
    }
    index += 1;
    events.push({ seq: typeof event.seq === 'number' ? event.seq : index, type: String(event.type ?? ''), data: event.data ?? {} });
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
 *
 * @returns {{state:'FOUND'|'UNKNOWN', counted:object, events:number, reason?:string}}
 */
export function countDeliveriesInSession(file, deliveries) {
  let text;
  try {
    text = readSessionText(file);
  } catch (error) {
    return { state: 'UNKNOWN', counted: {}, events: 0, reason: `read failed: ${error?.message ?? error}` };
  }
  if (text === null) return { state: 'UNKNOWN', counted: {}, events: 0, reason: 'the session log could not be decompressed' };
  const counted = Object.fromEntries(deliveries.map(entry => [entry.message_id, 0]));
  let events = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      return { state: 'UNKNOWN', counted, events, reason: `line ${events + 1} is not a native session event: ${error.message}` };
    }
    events += 1;
    if (!/user\/message|user_message/i.test(String(event?.type ?? ''))) continue;
    const serialized = JSON.stringify(event.data ?? event);
    for (const entry of deliveries) {
      if (serialized.includes(markerFor(entry.message_id, entry.delivery_seq))) counted[entry.message_id] += 1;
    }
  }
  return { state: 'FOUND', counted, events, reason: null };
}