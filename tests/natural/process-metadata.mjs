import assert from 'node:assert/strict';

export const normalizeBirth = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : null;
export function parseProcessMetadata(raw, {includeUid = false} = {}) {
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0, 'Complete PS metadata is required');
  const text = raw.toString('utf8');
  assert.equal(Buffer.from(text).compare(raw), 0, 'PS metadata is not UTF-8');
  assert.ok(text.endsWith('\n'), 'PS metadata ended with an incomplete row');
  const rows = [];
  for (const line of text.split('\n').filter(x => x.trim())) {
    const numeric = includeUid ? '(-?\\d+)\\s+' : '';
    const match = new RegExp('^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+' + numeric + '([A-Za-z]{3}\\s+[A-Za-z]{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s*$').exec(line);
    assert.ok(match, 'Unrecognized PS metadata row; command text is not accepted');
    const [pid, ppid, pgid] = match.slice(1, 4).map(Number), uid = includeUid ? Number(match[4]) : null;
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && Number.isSafeInteger(pgid) && pgid >= 0);
    if (uid !== null) assert.ok(Number.isSafeInteger(uid), 'BSD signed UID must remain an exact integer');
    assert.ok(!rows.some(x => x.pid === pid), 'Duplicate PID in PS metadata');
    rows.push({pid, ppid, pgid, uid, osBirth: normalizeBirth(match[includeUid ? 5 : 4])});
  }
  assert.ok(rows.length > 0, 'Empty Host metadata is not a complete census');
  return rows;
}
export function assertRecordedScopeAbsent(rows, identities, groups = []) {
  const pids = new Set(identities.map(x => x.pid));
  assert.ok(pids.size > 0);
  assert.ok(!rows.some(x => pids.has(x.pid)), 'Raw PS still contains a recorded owner PID');
  assert.ok(!rows.some(x => pids.has(x.ppid)), 'Raw PS still contains a direct owned child');
  assert.ok(!rows.some(x => groups.includes(x.pgid)), 'Raw PS still contains an owned group');
}
