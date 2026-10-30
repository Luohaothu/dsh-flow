import assert from 'node:assert/strict';

// Return the original string when no pattern is supplied. The owning reader
// continues to decide whether to trim its final value.
export function captureUiReadback(value, {pattern} = {}) {
  assert.equal(typeof value, 'string', 'UI readback must be a string');
  assert.ok(value.trim().length > 0, 'UI readback must not be empty');
  if (pattern === undefined) return value;
  assert.equal(typeof pattern, 'string', 'UI capture pattern must be a string');
  assert.ok(pattern.length > 0, 'UI capture pattern must not be empty');
  const match = new RegExp(pattern, 'u').exec(value);
  assert.ok(match, 'UI capture pattern did not match');
  assert.ok(typeof match[1] === 'string' && match[1].trim().length > 0,
    'UI capture requires a nonempty first capture group');
  return match[1];
}
