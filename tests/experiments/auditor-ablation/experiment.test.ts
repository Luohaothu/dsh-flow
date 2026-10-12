import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProof, checkResearch, fixtures, sha256 } from './fixtures.ts';
import { release, summarize } from './score.ts';
import { snapshotRecipe } from './settings.ts';
import type { ResearchCorpus, Trial, TrialTurn } from './types.ts';

const corpus = JSON.parse(readFileSync(new URL('./research-sources.json', import.meta.url), 'utf8')) as ResearchCorpus;
test('recipe uses the current nested schema and never accepts an empty snapshot or copies auth', () => {
  const server = { memory: { ceiling: 50 }, scheduler: { concurrency: 16 }, auth: { api_key: 'do-not-copy' } };
  const before = snapshotRecipe({ version: 1, models: { fixture: { temperature: 1 } } }, server, 'fixture');
  assert.equal(before.settings.temperature, 1);
  assert.ok(!JSON.stringify(before).includes('do-not-copy'));
  assert.throws(() => snapshotRecipe({ version: 1, models: {} }, server, 'fixture'));
  assert.throws(() => snapshotRecipe({ fixture: { temperature: 1 } }, server, 'fixture'));
  const after = snapshotRecipe({ version: 1, models: { fixture: { temperature: 0.5 } } }, server, 'fixture');
  assert.notDeepEqual(before, after, 'sampling drift must be observable');
});
test('frozen oracle distinguishes working code/proof/citations from each injected defect', () => {
  const rows = fixtures(corpus);
  assert.equal(rows.length, 12);
  for (const row of rows) {
    assert.equal(row.oracle.releasable, row.variant === 'clean', JSON.stringify(row));
    assert.equal(row.oracle.failures.length === 0, row.variant === 'clean');
    assert.ok(!JSON.stringify(row.packet).includes('expected_claims'));
  }
  const code = rows.find(row => row.id === 'code-unsupported-conclusion')!;
  assert.ok(code.oracle.failures.includes('hidden-test-4'), 'the tie boundary must detect strict > instead of >=');
  const proof = rows.find(row => row.id === 'proof-unsupported-conclusion')!;
  assert.ok(proof.oracle.failures.includes('false-universal-lemma-n=1'));
  const finite = rows.find(row => row.id === 'proof-coverage-gap')!;
  assert.ok(finite.oracle.failures.includes('universal-domain-not-proved'), 'a true theorem and passing finite examples do not validate the supplied proof');
});
test('frozen source excerpts remain bound to exact captured text', () => {
  for (const source of corpus.sources) {
    assert.equal(sha256(source.text), source.hash);
    for (const excerpt of source.excerpts) assert.ok(source.text.includes(excerpt.text));
  }
});
const turn = (accepted: boolean): TrialTurn => ({ session_id: 'fixture', role: 'orchestrator', decision: { accepted, checks: [], issues: [], notes: '' }, error: null,
  duration_ms: 1, model_requests: 1, input_tokens: 2, uncached_input_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, native_completed: true, native_stop: { kind: 'completed' }, output_tokens: 3, tool_calls: 2, native_file: null, read_packet_call_ids: [] });
test('proof oracle rejects misleading certificate contents and unsupported steps', () => {
  const original = fixtures(corpus).find(row => row.id === 'proof-clean')!.packet;
  for (const [field, value] of Object.entries({ identity_coefficients: [0, 1, 0, 1], mod3_residues: [0, 1], domain: 'positive-integers' })) {
    const packet = structuredClone(original);
    const artifact = packet.artifact as { certificate: Record<string, unknown> };
    artifact.certificate[field] = value;
    assert.equal(checkProof(packet).releasable, false, field);
  }
  const packet = structuredClone(original);
  (packet.artifact as { steps: string[] }).steps[1] = '6 divides n(n+1)';
  assert.equal(checkProof(packet).releasable, false);
});
test('research oracle requires complete, relevant, literally supported citations', () => {
  const original = fixtures(corpus).find(row => row.id === 'research-clean')!.packet;
  const packet = structuredClone(original);
  const claims = (packet.artifact as { claims: { facts: Record<string, unknown>; quotes: { source_id: string; excerpt_id: string; text: string }[] }[] }).claims;
  claims[0]!.facts = Object.fromEntries(Object.entries(claims[0]!.facts).reverse());
  assert.equal(checkResearch(packet, corpus).releasable, true, 'object ordering is not a semantic difference');
  claims[0]!.quotes = [];
  assert.equal(checkResearch(packet, corpus).releasable, false, 'empty quotes are not evidence');
  const irrelevant = structuredClone(original);
  const unrelated = corpus.sources.find(row => row.id === 'S3')!.excerpts.find(row => row.id === 'S3.E3')!;
  (irrelevant.artifact as { claims: { quotes: unknown[] }[] }).claims[3]!.quotes = [{ source_id: 'S3', excerpt_id: unrelated.id, text: unrelated.text }];
  assert.equal(checkResearch(irrelevant, corpus).releasable, false, 'a literal but unrelated excerpt cannot replace the required support');
});
test('auditor approval cannot turn an Orchestrator rejection into acceptance', () => {
  const trial: Trial = { fixture_id: 'example', scenario: 'proof', variant: 'clean', repetition: 1, packet_sha256: '', oracle: { releasable: true, failures: [], evidence: null },
    baseline: turn(false), self_review: turn(true), auditor: turn(true), order: [] };
  assert.equal(release(trial, 'auditor'), false);
  assert.equal(release(trial, 'self_review'), true);
  assert.equal(summarize([trial]).complete_pairs, 1);
  trial.auditor.native_completed = false;
  assert.equal(summarize([trial]).complete_pairs, 0, 'a captured decision followed by a native abort is not completion');
  trial.auditor.native_completed = true;
  trial.auditor.error = 'failed model request'; trial.auditor.decision = null;
  assert.equal(summarize([trial]).complete_pairs, 0, 'model/fixture errors cannot be counted as successful detection');
});
