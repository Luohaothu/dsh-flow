/**
 * The host surface a page talks to: `/api/flow`'s op handler.
 *
 * A browser knows the task, not the server's filesystem or the run's envelope.
 * These contracts are what keep a prompt typed into the cluster-mode composer
 * from becoming an unusable cluster: a default workspace, and an envelope with
 * a Worker request allowance — started with `budget: {}` and the default
 * `worker_model_requests: 0`, a cluster blocks on its very first request
 * ("cannot fund 7844 tokens with 0 remaining", measured against a live start).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleHostOp, INTERACTIVE_BUDGET, INTERACTIVE_LIMITS } from '../src/index.js';

/** A runtime stub that records the spec it was asked to start. */
function recorder() {
  const started = [];
  return {
    started,
    start(spec) { started.push(spec); return { cluster: { id: 'c1' } }; },
  };
}

test('a page-started cluster gets the deployment workspace and a workable envelope', async () => {
  const runtime = recorder();
  await handleHostOp(runtime, { op: 'start', payload: { objective: '把结果写入 sum.txt' } });
  const [spec] = runtime.started;
  assert.equal(spec.objective, '把结果写入 sum.txt');
  assert.ok(spec.workspace, 'a page never has to name a server path');
  assert.deepEqual(spec.budget, INTERACTIVE_BUDGET);
  assert.deepEqual(spec.limits, INTERACTIVE_LIMITS);
  assert.ok(INTERACTIVE_LIMITS.worker_model_requests > 1,
    'a Worker needs at least two requests to read a file and submit its result');
  assert.ok(INTERACTIVE_BUDGET.tokens > 0 && INTERACTIVE_BUDGET.model_requests > 0);
  assert.deepEqual(spec.capabilities, ['fs_read', 'fs_write']);
});

test('an explicit envelope is passed through untouched', async () => {
  const runtime = recorder();
  const budget = { tokens: 1234, model_requests: 7 };
  const limits = { max_depth: 2 };
  await handleHostOp(runtime, { op: 'start', payload: { objective: 'o', workspace: '/tmp/w', budget, limits } });
  const [spec] = runtime.started;
  assert.equal(spec.workspace, '/tmp/w');
  assert.equal(spec.budget, budget, 'a caller that names its own budget keeps it, by identity');
  assert.equal(spec.limits, limits);
});

test('an empty workspace string falls back rather than failing validation', async () => {
  const runtime = recorder();
  await handleHostOp(runtime, { op: 'start', payload: { objective: 'o', workspace: '' } });
  assert.notEqual(runtime.started[0].workspace, '');
});
