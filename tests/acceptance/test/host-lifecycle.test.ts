import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshHost } from '../../../src/host/host.ts';

test('failed host spawn rejects readiness and shutdown settles without an exit event', { timeout: 5_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-host-failure-'));
  const executablePath = process.execPath;
  const host = new DshHost({ profile: 'failed-spawn', cwd: directory, env: {}, logPath: join(directory, 'host.log'), readyTimeoutMs: 1_000 });
  try {
    // start() spawns synchronously before awaiting readiness. Restore the
    // process value immediately; only this child sees the missing executable.
    process.execPath = join(directory, 'missing-node');
    const started = host.start();
    process.execPath = executablePath;
    await assert.rejects(started, { code: 'ENOENT' });
    await host.stop({ graceMs: 100 });
    assert.notEqual(host.exitInfo, undefined);
  } finally {
    process.execPath = executablePath;
    await host.stop({ graceMs: 100 });
    rmSync(directory, { recursive: true, force: true });
  }
});
