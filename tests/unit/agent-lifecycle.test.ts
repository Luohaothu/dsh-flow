/** Native execution failures remain visible after the Agent's idle checkpoint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick } from './native-fixture.ts';

test('a native error return retains member failure and closes its active task as failed', async t => {
  const f = fixture(t), active = await f.startMember();
  active.native.finish();
  const end = active.native.session.append('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'Provider request failed' } },
  });
  active.native.options.onEvent?.(end);
  await tick(); await tick();

  const member = f.flow.store.getMember(active.member.id)!;
  assert.equal(member.state, 'failed', 'idle processing cannot overwrite the native failure');
  assert.ok(member.error);
  assert.match(member.error, /Provider request failed/);
  assert.equal(f.flow.store.getTask(active.task.id)?.status, 'FAILED');
  assert.equal(f.flow.store.getTask(active.task.id)?.result_id, null);
});
