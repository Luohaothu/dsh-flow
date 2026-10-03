import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLiveChecks } from '../run.ts';
import type { LiveCheckReport } from '../context.ts';

test('fatal live-check errors preserve evidence and reach cleanup without waiting on a fixture barrier', async () => {
  const report: LiveCheckReport = { notes: [], failure_class: null };
  const failure = new Error('Chromium socket(): Operation not permitted');
  let settleCalled = false;
  let cleaned = false;
  await assert.rejects(async () => {
    try {
      await runLiveChecks(async () => { throw failure; }, { report });
      settleCalled = true;
    } finally {
      cleaned = true;
    }
  }, error => error === failure);
  assert.equal(settleCalled, false);
  assert.equal(cleaned, true);
  assert.deepEqual(report.live_checks, { checks: [], error: failure.message });
  assert.match(report.notes[0] ?? '', /Chromium socket/);
  assert.equal(report.failure_class, null, 'the collector does not reclassify the failed run');
});

test('explicit blocked live checks remain failed evidence and cannot wait for settle', async () => {
  const report: LiveCheckReport = { notes: [] };
  const blocked = { checks: [{ name: 'browser-available', passed: false, evidence: 'browser unavailable' }], blocked: ['browser-available'] };
  await assert.rejects(runLiveChecks(async () => blocked, { report }), /live checks blocked: browser-available/);
  assert.equal(report.live_checks, blocked);
  assert.equal(report.live_checks?.checks?.[0]?.passed, false);
});

test('completed live-check assertion failures are preserved without truncating remaining work', async () => {
  const report: LiveCheckReport = { notes: [] };
  const verdict = { checks: [{ name: 'panel-heading', passed: false, evidence: 'heading absent' }] };
  assert.equal(await runLiveChecks(async () => verdict, { report }), verdict);
  assert.equal(report.live_checks, verdict);
  assert.deepEqual(report.notes, []);
});
