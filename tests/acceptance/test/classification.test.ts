/**
 * The runner's final classification, tested directly: these are the rules that
 * decide whether a run is reported as a mechanism failure, a model outcome or
 * an exhausted budget.
 *
 * The contract is asymmetric on purpose. A class derived by a case's own checks
 * is final — the budget branch may only supply a default — and
 * `blockedOnBudget` is derived exclusively from structured, persisted evidence,
 * never from free text or from proximity to a ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyOutcome } from '../run.ts';
import { deriveFailureClass, run as checkScale, scaleValidation } from '../checks/scale.ts';
import { correctionWitness, deriveRunClass } from '../checks/recursion.ts';

const budget = { tokens: 1000, model_requests: 10, wall_time_ms: 10_000 };
const refusal = { scope: 'node abc', dimension: 'model_requests', agent_id: 'a1' };

test('a check-level mechanism failure is never relabelled by a spent budget', () => {
  const outcome = classifyOutcome({
    failureClass: 'MECHANISM', scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 1000, requests: 10 }, wallTimeMs: 10_000,
  });
  assert.equal(outcome.failure_class, 'MECHANISM');
  assert.equal(outcome.limit_reached?.exhausted.tokens, true, 'the exhaustion is still recorded');
});

test('an unclassified scenario failure defaults from the structured facts', () => {
  const nothing = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 5, requests: 1 }, wallTimeMs: 500,
  });
  assert.equal(nothing.failure_class, 'MODEL_OUTPUT');
  assert.equal(nothing.limit_reached, null);

  // 999 of 1000 tokens is proximity, not a denial: without a recorded refusal
  // the cause is unchanged and the proximity is reported separately.
  const spent = classifyOutcome({
    failureClass: 'MODEL_OUTPUT', scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 999, requests: 3 }, wallTimeMs: 1_000,
  });
  assert.equal(spent.failure_class, 'MODEL_OUTPUT', '99.9% usage alone does not change the cause');
  assert.equal(spent.budget_proximity.tokens, 0.999);

  const refused = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 999, requests: 3 }, wallTimeMs: 1_000, refusals: [refusal],
  });
  assert.equal(refused.failure_class, 'LIMIT_REACHED', 'a structured refusal is the evidence');
  assert.equal(refused.limit_reached?.blockedOnBudget, true);
  assert.deepEqual(refused.limit_reached?.refusals, [refusal]);

  // The same facts do not relabel a class a check already derived.
  const derived = classifyOutcome({
    failureClass: 'MODEL_OUTPUT', scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 999, requests: 3 }, wallTimeMs: 1_000, refusals: [refusal],
  });
  assert.equal(derived.failure_class, 'MODEL_OUTPUT', 'the derived class is final');
  assert.equal(derived.limit_reached?.blockedOnBudget, true, 'the refusal is still recorded');

  // A refusal with no scope or dimension is not a structured record.
  const unstructured = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 5, requests: 1 }, wallTimeMs: 500,
    refusals: [{ agent_id: 'a1' }, { scope: '', dimension: '' }],
  });
  assert.equal(unstructured.limit_reached, null, 'an unnamed refusal is not a denial');
});

test('wall time is judged against the measured clock, never against zero', () => {
  const wall = classifyOutcome({
    failureClass: 'MODEL_OUTPUT', scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 1, requests: 1 }, wallTimeMs: 9_900,
  });
  assert.equal(wall.failure_class, 'MODEL_OUTPUT', 'approaching the deadline is not passing it');
  const pastDeadline = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 1, requests: 1 }, wallTimeMs: 10_000,
  });
  assert.equal(pastDeadline.failure_class, 'LIMIT_REACHED');
  assert.equal(pastDeadline.limit_reached?.hitWall, true);

  const passed = classifyOutcome({
    failureClass: null, scenarioStatus: 'PASSED', budget,
    usage: { total_tokens: 1_000, requests: 10 }, wallTimeMs: 10_000,
  });
  assert.equal(passed.failure_class, null, 'a passed scenario keeps no failure class even when it spent everything');
  assert.equal(passed.limit_reached?.exhausted.requests, true);
});

test('a cluster stop reason is only budget evidence in its coded form', () => {
  const coded = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED',
    budget: { tokens: 1048576, model_requests: 192, wall_time_ms: 21600000 },
    usage: { total_tokens: 420000, requests: 40 }, wallTimeMs: 118000,
    clusterReason: 'BUDGET: allocator scope has no model_requests left',
  });
  assert.equal(coded.failure_class, 'LIMIT_REACHED');
  assert.equal(coded.limit_reached?.blockedOnBudget, true);

  // Model prose about "exhausting max_attempts" is not a budget denial.
  const prose = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED',
    budget: { tokens: 1048576, model_requests: 192, wall_time_ms: 21600000 },
    usage: { total_tokens: 500000, requests: 48 }, wallTimeMs: 118000,
    clusterReason: 'orchestrator has been exhausting max_attempts=2 while retrying',
  });
  assert.equal(prose.failure_class, 'MODEL_OUTPUT', 'free text about exhaustion is not evidence');
  assert.equal(prose.limit_reached, null, 'no structured denial was recorded');
  assert.equal(prose.budget_proximity.tokens, 0.4768, 'proximity is still reported');
});

test('the scale tier derives its own class from structured blockers', () => {
  const mechanism = deriveFailureClass({
    ledger: { blockers: [{ code: 'CONTEXT_PRESSURE', reason: 'auditor holds 11340 tokens and compaction did not reduce it' }] },
    report: { limit_reached: { hitWall: false, refusals: [] } },
    failed: [{ name: 'real-llm-workers', passed: false }],
  });
  assert.equal(mechanism, 'MECHANISM', 'context pressure is a mechanism failure, not a budget one');

  const limit = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: null },
    report: { limit_reached: { hitWall: true, refusals: [] } },
    failed: [{ name: 'every-transaction-terminal', passed: false }],
  });
  assert.equal(limit, 'LIMIT_REACHED');

  const model = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: 'orchestrator made no state change across 3 turns' },
    report: { limit_reached: null, wall_time_ms: 1000 },
    failed: [{ name: 'symbols-exist-in-the-files', passed: false }],
  });
  assert.equal(model, 'MODEL_OUTPUT');

  // The persisted pair is what decides: a *coded* budget block is a budget stop
  // even when the sentence that explains it begins with the context pathology
  // that made the session unaffordable, and even when the block was recorded on
  // a child node (the root kept running, so there is no cluster-level reason).
  const nodeBudget = deriveFailureClass({
    ledger: { blockers: [{ code: 'BUDGET_EXHAUSTED', reason: 'BUDGET: the session could not be compacted — {"before":124579}' }], blocked_reason: null },
    report: { limit_reached: { hitWall: false, refusals: [] } },
    failed: [{ name: 'every-transaction-terminal', passed: false }],
  });
  assert.equal(nodeBudget, 'LIMIT_REACHED', 'a node-level budget block outranks the missing cluster reason');

  // Textual evidence uses the leading code as the cause. A mechanism prefix
  // outranks a budget token that appears later in the message.
  const wrapped = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: 'CONTEXT_PRESSURE: BUDGET: the session could not be compacted because the cluster budget is exhausted' },
    report: { limit_reached: null, wall_time_ms: 1000 },
    failed: [{ name: 'every-transaction-terminal', passed: false }],
  });
  assert.equal(wrapped, 'MECHANISM', 'the leading code decides, not a token later in the sentence');

  // Prose that merely mentions a budget is not a limit.
  const proseInside = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: 'the orchestrator stopped after noting that BUDGET: might become a problem' },
    report: { limit_reached: null, wall_time_ms: 1000 },
    failed: [{ name: 'every-transaction-terminal', passed: false }],
  });
  assert.equal(proseInside, 'MODEL_OUTPUT', 'a budget token inside a sentence is prose');

  // A mechanism code beside a budget code is a mechanism failure: the fence is
  // the defect, the budget is only what it ran out of.
  const mixed = deriveFailureClass({
    ledger: { blockers: [{ code: 'FENCE', reason: 'an old epoch tried to publish' }, { code: 'BUDGET_EXHAUSTED', reason: 'BUDGET: nothing left' }] },
    report: { limit_reached: { hitWall: false, refusals: [{ dimension: 'tokens' }] }, wall_time_ms: 1000 },
    failed: [{ name: 'every-transaction-terminal', passed: false }],
  });
  assert.equal(mixed, 'MECHANISM', 'mechanism outranks limit');

  // A persisted deadline outranks the environment: the run hit its own cap, and
  // an unreachable browser in the same run does not change why it stopped.
  const environmentAndDeadline = deriveFailureClass({
    ledger: { blockers: [{ code: 'DEADLINE_PASSED', reason: 'LIMIT_REACHED: cluster wall-time deadline passed' }], blocked_reason: null },
    report: { environment_failure: 'the browser never launched', limit_reached: { hitWall: true, refusals: [] }, wall_time_ms: 1000 },
    failed: [{ name: 'browser-available', passed: false }, { name: 'corpus-materialized', passed: false }],
  });
  assert.equal(environmentAndDeadline, 'LIMIT_REACHED', 'a persisted limit outranks the environment');

  // …and with no limit evidence at all, the environment is the class.
  const environmentOnly = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: null },
    report: { limit_reached: null, wall_time_ms: 1000 },
    failed: [{ name: 'browser-available', passed: false }],
  });
  assert.equal(environmentOnly, 'ENVIRONMENT');

  const deadlined = deriveFailureClass({
    ledger: { blockers: [{ code: 'DEADLINE_PASSED', reason: 'LIMIT_REACHED: cluster wall-time deadline passed' }] },
    report: { limit_reached: { hitWall: false, refusals: [] } },
    failed: [{ name: 'workers-actually-ran', passed: false }],
  });
  assert.equal(deadlined, 'LIMIT_REACHED', 'a wall-deadline block is a limit stop');

  const environment = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: null },
    report: { environment_failure: true, limit_reached: null },
    failed: [{ name: 'corpus-materialized', passed: false }],
  });
  assert.equal(environment, 'ENVIRONMENT');

  const none = deriveFailureClass({
    ledger: { blockers: [], blocked_reason: null },
    report: { limit_reached: null },
    failed: [],
  });
  assert.equal(none, null, 'a tier with no failed check has no failure class');
});
test('a case that fails while a coded limit is beaconed derives the limit, not the model', () => {
  // Mechanism first: a duplicate charge outranks a budget stop.
  assert.equal(deriveRunClass({ failed: ['no-duplicate-accounting', 'deep-artifact-written'], limitCoded: true }), 'MECHANISM');
  // Then the coded limit: the artifacts are missing *and* the run stopped on a
  // budget code — the stop is why they are missing.
  assert.equal(deriveRunClass({ failed: ['deep-artifact-written'], limitCoded: true }), 'LIMIT_REACHED');
  // With no coded limit, an unmet artifact requirement is the model's.
  assert.equal(deriveRunClass({ failed: ['deep-artifact-written'], limitCoded: false }), 'MODEL_OUTPUT');
  assert.equal(deriveRunClass({ failed: ['every-transaction-terminal'], mechanismCoded: true }),
    'MECHANISM', 'a durable CONTEXT_PRESSURE node stop is not a model-output failure');
  assert.equal(deriveRunClass({ failed: ['every-transaction-terminal'], mechanismCoded: true, limitCoded: true }),
    'MECHANISM', 'a structural context stop outranks a coincident budget code');
  // Nothing failed: no class at all.
  assert.equal(deriveRunClass({ failed: [], limitCoded: true }), null);
});

test('the correction witness counts a re-validation, not only a plan edit', async () => {
  const issues = [
    { id: 'plan-issue', transaction_id: 't1', target_revision: 2, corrections: 0 },
    { id: 'revalidate-issue', transaction_id: 't2', target_revision: 3, corrections: 0 },
    { id: 'unanswered', transaction_id: 't3', target_revision: 1, corrections: 0 },
    { id: 'failed-only', transaction_id: 't4', target_revision: 1, corrections: 2 },
  ];
  const adjustments = [{ transaction_id: 't1', revision: 3 }, { transaction_id: 't4', revision: 1 }];
  const revalidations = [{ transaction_id: 't2', result_revision: 4 }];
  const answered = correctionWitness(issues, adjustments, revalidations).map(issue => issue.id);
  assert.deepEqual(answered, ['plan-issue', 'revalidate-issue'],
    `a plan edit and a re-validation are both corrections: ${JSON.stringify(answered)}`);
  // A failed counter with nothing changed is still not a correction.
  assert.ok(!answered.includes('failed-only'));
  // Same revision, no progress: not answered either.
  assert.equal(correctionWitness([{ id: 'same', transaction_id: 't1', target_revision: 3, corrections: 0 }], adjustments, revalidations).length, 0);
});

test('a scale run without its database records the missing evidence instead of crashing the report', async () => {
  const layout = { data: join(tmpdir(), `missing-scale-${randomUUID()}`) };
  const workspace = layout.data;
  const outcome = await checkScale({
    caseDef: { id: '' }, layout, report: { cluster_id: null }, workspace, events: [],
  });
  assert.deepEqual(outcome.checks.map(({ name, passed }) => [name, passed]), [
    ['cluster-database-present', false],
    ['cluster-id-resolved', false],
  ]);
  assert.equal(outcome.scenario_status, 'FAILED');
  assert.equal(outcome.scale_validation, 'INCOMPLETE');
});

test('a scale run cannot call itself VERIFIED when a tier transaction is still pending', async () => {
  assert.equal(scaleValidation(16, 16, 14, 17, 15, 1), 'INCOMPLETE',
    '17 model-backed workers cannot hide two nonterminal transactions');
  assert.equal(scaleValidation(16, 15, 15, 15, 15, 0), 'INCOMPLETE',
    'a missing fixture is not a completed tier');
  assert.equal(scaleValidation(16, 16, 16, 14, 15, 0), 'INCOMPLETE',
    'created identities without provider requests do not count as activation');
  assert.equal(scaleValidation(16, 16, 16, 16, 15, 1), 'INCOMPLETE',
    'a failed scale quality check cannot be overridden by activation alone');
  assert.equal(scaleValidation(16, 16, 16, 16, 15, 0), 'VERIFIED');
});
