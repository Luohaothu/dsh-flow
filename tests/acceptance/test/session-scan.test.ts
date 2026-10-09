import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { countDeliveriesInSession } from '../../../src/host/session-scan.ts';

test('delivery scans count native recipient sources without mistaking a sender receipt or body for delivery', t => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-delivery-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  const events = [
    { seq: 1, type: 'tool/result', data: { message_id: 'message-a', recipient: 'worker' } },
    { seq: 2, type: 'user/message', data: { text: 'The sender mentioned message-a.' } },
    { seq: 3, type: 'user/message', data: { text: 'A different delivery.', source: { kind: 'flow-message', message_id: 'message-b' } } },
    { seq: 4, type: 'user/message', data: { text: 'Full recipient content.', source: { kind: 'flow-message', message_id: 'message-a' } } },
  ];
  writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n'));
  assert.deepEqual(countDeliveriesInSession(file, [{ message_id: 'message-a', delivery_seq: 9 }]), {
    state: 'FOUND', counted: { 'message-a': 1 }, events: 4, reason: null,
  });
});
