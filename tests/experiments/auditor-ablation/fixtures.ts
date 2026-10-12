import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Fixture, Packet, ResearchCorpus, Scenario, Variant } from './types.ts';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const VARIANTS: readonly Variant[] = ['clean', 'coverage-gap', 'stale-evidence', 'unsupported-conclusion'];
export const SCENARIOS: readonly Scenario[] = ['code', 'research', 'proof'];

// Trusted local fixture code: the model never supplies executable text.
const code = (variant: Variant): string => `function dedupeLatest(records) {
  const selected = new Map();
  for (const record of records) {
    ${variant === 'coverage-gap' ? 'if (record.version < 0) continue;' : ''}
    const prior = selected.get(record.id);
    if (!prior || ${variant === 'unsupported-conclusion' ? 'record.version > prior.version' : variant === 'stale-evidence' ? 'String(record.version) >= String(prior.version)' : 'record.version >= prior.version'}) selected.set(record.id, record);
  }
  return [...selected.values()];
}`;
const inputs = [
  [],
  [{ id: 'a', version: 1, value: 'old' }, { id: 'a', version: 2, value: 'new' }],
  [{ id: 'a', version: -2, value: 'first' }, { id: 'a', version: -1, value: 'last' }],
  [{ id: 'a', version: 9, value: 'nine' }, { id: 'a', version: 10, value: 'ten' }],
  [{ id: 'a', version: 2, value: 'old' }, { id: 'a', version: 2, value: 'new' }],
  [{ id: 'b', version: 1, value: 'b' }, { id: 'a', version: 2, value: 'a' }, { id: 'b', version: 2, value: 'b2' }],
];
const expected = [[], [inputs[1]![1]!], [inputs[2]![1]!], [inputs[3]![1]!], [inputs[4]![1]!], [inputs[5]![2]!, inputs[5]![1]!]];

export function checkCode(source: string) {
  const execute = new Function(`${source}; return dedupeLatest;`)() as (rows: unknown) => unknown;
  return inputs.map((input, index) => {
    const actual = execute(input);
    let passed = true;
    try { assert.deepEqual(actual, expected[index]); } catch { passed = false; }
    return { test: index, input, expected: expected[index], actual, passed };
  });
}
function codeFixture(variant: Variant): Fixture {
  const source = code(variant);
  const resultRef = `code:${sha256(source)}`;
  const checks = checkCode(source);
  // Freeze a limited upstream test run; the external oracle uses the entire matrix.
  const observed = variant === 'unsupported-conclusion' ? checks.filter(item => [0, 1, 4, 5].includes(item.test))
    : variant === 'clean' ? checks : checkCode(variant === 'stale-evidence' ? code('clean') : source).filter(item => [0, 1, 5].includes(item.test));
  const packet: Packet = {
    task: 'Implement dedupeLatest(records): select the greatest numeric integer version per id (negative integers included); equal versions use the last input record; retain order of each id\'s first appearance; empty input returns []. Validate this exact delivered implementation.',
    result_ref: resultRef,
    criteria: [
      { id: 'C1', description: 'All integer versions, including negative values and 9 versus 10, are compared numerically.' },
      { id: 'C2', description: 'Ties use the last record and first-id ordering is preserved.' },
      { id: 'C3', description: 'Empty input works and the acceptance evidence covers boundary behavior.' },
      { id: 'C4', description: 'The executed test evidence applies to the hash of the current delivered source; a failing check cannot support acceptance.' },
    ],
    artifact: { language: 'JavaScript', source, sha256: sha256(source), worker_summary: 'Implemented the requested utility; attached the test observations for manager validation.' },
    receipts: [{ id: 'code-test-run', result_ref: variant === 'stale-evidence' ? `code:${sha256(code('clean'))}` : resultRef,
      method: 'Trusted local fixture executed dedupeLatest against the explicitly listed inputs; these are observations, not a claim of exhaustive verification.', observation: observed }],
  };
  const failures = checks.filter(item => !item.passed).map(item => `hidden-test-${item.test}`);
  if (packet.receipts[0]!.result_ref !== resultRef) failures.push('evidence-current-result-binding');
  return { id: `code-${variant}`, scenario: 'code', variant, packet, oracle: { releasable: failures.length === 0, failures, evidence: checks } };
}
const equal = (left: unknown, right: unknown): boolean => { try { assert.deepEqual(left, right); return true; } catch { return false; } };
export function checkProof(packet: Packet) {
  const artifact = packet.artifact as { steps: string[]; certificate: Record<string, unknown> };
  const certificate = artifact.certificate;
  const failures: string[] = [];
  const multiply = (a: number[], b: number[]) => {
    const out = Array(a.length + b.length - 1).fill(0) as number[];
    a.forEach((x, i) => b.forEach((y, j) => { out[i + j]! += x * y; })); return out;
  };
  const expansion = multiply(multiply([-1, 1], [0, 1]), [1, 1]);
  const residues = Array.from({ length: 6 }, (_, n) => ({ n, remainder: ((n - 1) * n * (n + 1)) % 6 }));
  if (certificate.kind === 'finite_examples') failures.push('universal-domain-not-proved');
  else if (certificate.kind === 'product_argument') {
    const counterexample = Array.from({ length: 6 }, (_, n) => n).find(n => n * (n + 1) % 6 !== 0);
    failures.push(counterexample === undefined ? 'unsupported-proof-schema' : `false-universal-lemma-n=${counterexample}`);
  } else if (certificate.kind === 'residue_product') {
    if (!equal(certificate.identity_coefficients, expansion)) failures.push('incorrect-polynomial-certificate');
    if (!equal(certificate.mod2_residues, [0, 1]) || !equal(certificate.mod3_residues, [0, 1, 2])) failures.push('incomplete-residue-certificate');
    if (certificate.domain !== 'all-integers') failures.push('universal-domain-not-proved');
    // Only the explicitly authored proof language is supported, not arbitrary prose.
    if (!equal(artifact.steps, [
      'n^3-n=(n-1)n(n+1) for every integer n.',
      'Among three consecutive integers, one is divisible by 3 (consider n mod 3 = 0,1,2).',
      'Among n and n+1 one is even (consider n mod 2 = 0,1).',
      'The product has factors 2 and 3; because they are coprime, it is divisible by 6. These residue arguments cover negative integers and zero as well.',
    ])) failures.push('unverified-proof-steps');
  } else failures.push('unsupported-proof-schema');
  if (!residues.every(row => row.remainder === 0)) failures.push('invalid-residue-argument');
  if (packet.receipts.some(receipt => receipt.result_ref !== packet.result_ref)) failures.push('evidence-current-result-binding');
  return { releasable: failures.length === 0, failures, evidence: { expansion_coefficients: expansion, mod6_residues: residues, invalid_lemma_counterexample: { n: 1, product: 2, divisible_by_6: false } } };
}
export function checkResearch(packet: Packet, corpus: ResearchCorpus) {
  const { claims } = packet.artifact as { claims: { id: string; facts: unknown; source_ids: string[]; quotes: { source_id: string; excerpt_id: string; text: string }[] }[] };
  const sources = packet.sources ?? [];
  const failures: string[] = [];
  for (const expectation of corpus.expected_claims) {
    const claim = claims.find(item => item.id === expectation.id);
    if (!claim) { failures.push(`missing-topic-${expectation.id}`); continue; }
    if (!equal(claim.facts, expectation.required_facts)) failures.push(`incorrect-facts-${claim.id}`);
    if (!equal([...claim.source_ids].sort(), [...expectation.source_ids].sort())
      || !equal(claim.quotes.map(quote => quote.excerpt_id).sort(), [...expectation.excerpt_ids].sort())) failures.push(`citation-coverage-${claim.id}`);
    if (!claim.quotes.every(quote => claim.source_ids.includes(quote.source_id) && sources.some(source => source.id === quote.source_id && source.excerpts.some(excerpt => excerpt.id === quote.excerpt_id && excerpt.text === quote.text)))) failures.push(`unsupported-quote-${claim.id}`);
  }
  if (packet.receipts.some(receipt => receipt.result_ref !== packet.result_ref)) failures.push('evidence-current-result-binding');
  return { releasable: failures.length === 0, failures, evidence: { checked_claims: corpus.expected_claims.length, captured_sources: sources.length } };
}
function proofFixture(variant: Variant): Fixture {
  const theorem = 'For every integer n (negative, zero and positive), n^3 - n is divisible by 6.';
  const steps = variant === 'coverage-gap'
    ? ['Compute n^3-n for n=1,...,100 and observe remainder 0 modulo 6.', 'Therefore the theorem holds for every integer n.']
    : variant === 'unsupported-conclusion'
      ? ['n^3-n=(n-1)n(n+1).', 'For every integer n, n(n+1) is divisible by 6.', 'Consequently (n-1)n(n+1) is divisible by 6.']
      : ['n^3-n=(n-1)n(n+1) for every integer n.', 'Among three consecutive integers, one is divisible by 3 (consider n mod 3 = 0,1,2).', 'Among n and n+1 one is even (consider n mod 2 = 0,1).', 'The product has factors 2 and 3; because they are coprime, it is divisible by 6. These residue arguments cover negative integers and zero as well.'];
  const certificate = variant === 'coverage-gap' ? { kind: 'finite_examples', checked_domain: [1, 100] }
    : variant === 'unsupported-conclusion' ? { kind: 'product_argument', lemma: '6 divides n(n+1)' }
      : { kind: 'residue_product', identity_coefficients: [0, -1, 0, 1], mod2_residues: [0, 1], mod3_residues: [0, 1, 2], domain: 'all-integers' };
  const artifact = { theorem, steps, certificate };
  const ref = `proof:${sha256(JSON.stringify(artifact))}`;
  const numerical = Array.from({ length: 100 }, (_, index) => index + 1).every(n => (n ** 3 - n) % 6 === 0);
  const current = variant === 'stale-evidence' ? 'proof:previous-positive-only-theorem' : ref;
  const packet: Packet = { task: 'Deliver a universal mathematical proof, not an empirical conjecture. Check the proof argument, its domain and its evidence binding.', result_ref: ref,
    criteria: [
      { id: 'M1', description: 'The proof covers every integer, including n<=0; finitely many examples do not prove the quantified theorem.' },
      { id: 'M2', description: 'The polynomial factorization is exact and every universal lemma is valid.' },
      { id: 'M3', description: 'Divisibility by 2 and by 3 is logically established, and their combination justifies divisibility by 6.' },
      { id: 'M4', description: 'Validation concerns this exact proof/result reference and states the reasoning actually inspected.' },
    ], artifact, receipts: [{ id: 'proof-check-notes', result_ref: current, method: variant === 'clean' ? 'Algebraic expansion plus complete modulo-2 and modulo-3 residue inspection' : 'Finite positive sample calculation; manager must separately check the claimed universal proof',
      observation: variant === 'clean' ? { expansion: '(n-1)n(n+1)=n^3-n', parity_cases: [[0, 0], [1, 0]], triple_cases: [[0, 0], [1, 0], [2, 0]], sample_n_1_to_100: numerical }
        : { scope: variant === 'stale-evidence' ? 'previous theorem n>=1' : 'n=1..100 only', samples_passed: numerical } }] };
  // A finite certificate for this elementary proof: expansion and exhaustive
  // residues establish the universal argument; examples alone never do.
  return { id: `proof-${variant}`, scenario: 'proof', variant, packet, oracle: checkProof(packet) };
}
function researchFixture(variant: Variant, corpus: ResearchCorpus): Fixture {
  const claims = corpus.expected_claims.map(item => ({ id: item.id, facts: structuredClone(item.required_facts), source_ids: [...item.source_ids],
    quotes: item.excerpt_ids.map(id => {
      const source = corpus.sources.find(source => source.excerpts.some(excerpt => excerpt.id === id))!;
      return { source_id: source.id, excerpt_id: id, text: source.excerpts.find(excerpt => excerpt.id === id)!.text };
    }) }));
  if (variant === 'coverage-gap') claims.splice(4, 1);
  if (variant === 'unsupported-conclusion') {
    claims[2]!.quotes = [{ source_id: 'S2', excerpt_id: 'S2.E1', text: 'WAL permits multiple concurrent writers to commit without serialization.' }];
    claims[2]!.facts = { concurrent_writers: 'multiple', readers_and_writer_can_overlap: true };
  }
  const artifact = { title: 'SQLite transaction, WAL and connection isolation boundaries', claims, recommendation: 'Use the cited scope and connection conditions when designing concurrent local agents; do not extrapolate beyond the frozen official evidence.' };
  const ref = `research:${sha256(JSON.stringify(artifact))}`;
  const sources = corpus.sources;
  const packet: Packet = { task: 'Synthesize the six requested SQLite facts from the frozen official sources. Cover foreign-key activation and transaction caveats, WAL writer concurrency, snapshots, dirty-read scope and BEGIN IMMEDIATE contention. Every conclusion requires a supporting captured source and a literal quote. Preserve applicable conditions.', result_ref: ref,
    criteria: corpus.expected_claims.map(item => ({ id: item.id, description: `Cover topic ${item.id} with the correct scope, supporting source and a literal evidence quote. See the six requested topics in the task.` })).concat([{ id: 'R-binding', description: 'Source and result verification must be bound to this exact frozen evidence bundle and current result.' }]),
    artifact, sources,
    receipts: [{ id: 'research-source-check', result_ref: variant === 'stale-evidence' ? 'research:previous-source-snapshot' : ref,
      method: 'Recorded source capture and reported claim inventory; manager must check factual support and topic coverage.', observation: { source_hashes: Object.fromEntries(sources.map(source => [source.id, source.hash])), captured_source_ids: sources.map(source => source.id), claimed_ids: claims.map(claim => claim.id) } }],
  };
  return { id: `research-${variant}`, scenario: 'research', variant, packet, oracle: checkResearch(packet, corpus) };
}
export function fixtures(corpus: ResearchCorpus): Fixture[] {
  return SCENARIOS.flatMap(scenario => VARIANTS.map(variant => scenario === 'code' ? codeFixture(variant) : scenario === 'proof' ? proofFixture(variant) : researchFixture(variant, corpus)));
}
