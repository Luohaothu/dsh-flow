/**
 * Research case checks.
 *
 * Two independent evidence sources are compared: the runtime's own captured
 * `web_fetch` receipts (recorded by the plugin, not by the model) and the
 * model's `sources.json` / `claims.json`. A claim whose quote cannot be
 * located in a captured page is a mechanism-relevant citation failure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openLedger } from '../../../src/host/ledger.mjs';

const PROJECT_HOSTS = [
  { name: 'sglang', patterns: [/sglang/i] },
  { name: 'vllm', patterns: [/vllm/i] },
  { name: 'llama.cpp', patterns: [/llama\.cpp|ggml/i] },
];

export async function run({ workspace, report, layout }) {
  const checks = [];
  const push = (name, passed, evidence) => checks.push({ name, passed: Boolean(passed), evidence: String(evidence).slice(0, 2500) });

  const sourcesPath = join(workspace, 'sources.json');
  const claimsPath = join(workspace, 'claims.json');
  const reportPath = join(workspace, 'report.md');
  const ledgerPath = join(layout.data, 'cluster.sqlite');
  const dbPresent = existsSync(ledgerPath);
  push('cluster-database-present', dbPresent, `${ledgerPath} ${dbPresent ? 'exists' : 'does not exist'}`);
  push('cluster-id-resolved', Boolean(report.cluster_id),
    report.cluster_id ? `report.cluster_id = ${report.cluster_id}` : `report.cluster_id is null${report.failure ? `; start failed: ${report.failure.message}` : ''}`);

  push('deliverables-present', existsSync(sourcesPath) && existsSync(claimsPath) && existsSync(reportPath),
    `sources.json=${existsSync(sourcesPath)} claims.json=${existsSync(claimsPath)} report.md=${existsSync(reportPath)}`);
  if (!existsSync(sourcesPath) || !existsSync(claimsPath)) {
    return { checks, scenario_status: 'FAILED', failure_class: report.cluster_id ? 'MODEL_OUTPUT' : 'MECHANISM' };
  }

  const modelSources = safeJson(sourcesPath, []);
  const claims = safeJson(claimsPath, []);

  const ledger = dbPresent && report.cluster_id ? openLedger(ledgerPath) : null;
  const captured = ledger ? ledger.all('SELECT * FROM sources WHERE cluster_id=?', report.cluster_id) : [];
  if (ledger) ledger.close();
  push('runtime-receipts-readable', Boolean(ledger),
    ledger ? `${captured.length} capture receipts read from ${ledgerPath}` : `${ledgerPath} could not be read against a resolved cluster id`);

  const distinctCaptured = new Map();
  for (const row of captured) distinctCaptured.set(row.final_url, row);
  push('runtime-captured-sources', distinctCaptured.size >= 12, `${distinctCaptured.size} distinct pages captured by the runtime`);

  const hosts = [...distinctCaptured.keys()];
  const perProject = PROJECT_HOSTS.map(project => ({
    name: project.name,
    count: hosts.filter(url => project.patterns.some(pattern => pattern.test(url))).length,
  }));
  push('per-project-coverage', perProject.every(project => project.count >= 4), JSON.stringify(perProject));
  push('three-projects-covered', perProject.every(project => project.count > 0), JSON.stringify(perProject));

  const capturedTextByUrl = new Map(captured.map(row => [row.final_url, normalize(row.text)]));
  const capturedById = new Map(captured.map(row => [row.id, row]));

  const referenced = new Set();
  let located = 0;
  let missing = 0;
  for (const claim of claims) {
    for (const id of claim.source_ids ?? []) {
      referenced.add(id);
      const row = capturedById.get(id) ?? [...captured].find(candidate => candidate.final_url === id);
      if (!row) {
        missing += 1;
        continue;
      }
      const haystack = capturedTextByUrl.get(row.final_url) ?? '';
      const quotes = (claim.quotes ?? []).map(normalize).filter(Boolean);
      if (!quotes.length) continue;
      if (quotes.some(quote => haystack.includes(quote))) located += 1;
    }
  }
  const uncaptured = [...referenced].filter(id => !capturedById.has(id) && ![...capturedTextByUrl.keys()].includes(id));
  push('claims-reference-captured-sources', uncaptured.length === 0,
    `${referenced.size} referenced ids, ${uncaptured.length} not present in the runtime receipts: ${uncaptured.slice(0, 5).join(', ')}`);
  push('quotes-locatable-in-captured-text', claims.length > 0 && located >= Math.min(10, claims.length),
    `${located} claims with a locatable quote out of ${claims.length}`);

  const dimensions = ['concurren', 'queu', 'kv', 'prefix', 'tool', 'structured', 'cancel', 'usage', 'limit'];
  const text = [readFileSync(reportPath, 'utf8'), JSON.stringify(claims)].join('\n').toLowerCase();
  const missingDimensions = dimensions.filter(token => !text.includes(token));
  push('dimensions-covered', missingDimensions.length === 0, missingDimensions.length ? `missing tokens: ${missingDimensions.join(', ')}` : 'all dimension tokens present');

  const hasConflicts = /conflict|contradict|不一致|矛盾/i.test(readFileSync(reportPath, 'utf8'));
  const hasOpenQuestions = /open question|unresolved|仍需|待实验|experiment/i.test(readFileSync(reportPath, 'utf8'));
  push('conflicts-preserved', hasConflicts, 'report mentions conflicting official statements');
  push('open-questions-listed', hasOpenQuestions, 'report lists questions that still need a local experiment');

  const unverified = claims.filter(claim => claim.unverified === true).length;
  writeFileSync(join(layout.root, 'research-summary.json'), `${JSON.stringify({ captured: distinctCaptured.size, perProject, referenced: referenced.size, located, unverified }, null, 2)}\n`);

  // `null` is "not measured": it is not a failure, and it must not make the case
  // look failed either.
  const failed = checks.filter(entry => entry.passed === false);
  const mechanismFailed = failed.some(entry => ['runtime-captured-sources', 'claims-reference-captured-sources'].includes(entry.name));
  const environmentFailed = distinctCaptured.size === 0;
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : environmentFailed ? 'ENVIRONMENT' : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
  };
}

function safeJson(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.sources ?? parsed.claims ?? fallback);
  } catch {
    return fallback;
  }
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}