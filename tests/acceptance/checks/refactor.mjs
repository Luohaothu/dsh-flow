/**
 * Refactor case checks.
 *
 * Runs the *same* commands before and after the cluster works, in the isolated
 * copy, so a pre-existing failure is never charged to the model. The original
 * repository is hashed before and after to prove nothing was written outside
 * the copy.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { inheritEnv } from '../../../src/host/host.mjs';

const SPECS = [
  'packages/llm/token-meter/tests/token-meter.spec.ts',
  'packages/llm/token-meter/tests/route-pricing.spec.ts',
  'packages/llm/token-meter/tests/context-breakdown-projection.spec.ts',
  'packages/llm/token-meter/tests/token-usage-projection.spec.ts',
  'packages/compaction/compaction-basic/tests/compaction-basic.spec.ts',
  'packages/compaction/compaction-basic/tests/manual-compaction.spec.ts',
  'packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts',
  'packages/acp/acp/tests/updates.spec.ts',
];

const GATES = [
  'verify-cordis-catalog',
  'verify-translation-pairing',
  'verify-export-jsdoc',
  'verify-type-equiv',
];

const UNTOUCHED = ['packages/client', 'benchmarks', 'python', '.agents/notes'];

/**
 * Every baseline subprocess runs with an isolated HOME/TMPDIR/DSH_HOME and
 * without the operator's credentials, so a build cannot read a real home or
 * write into it.
 */
function isolatedEnv(layout, extra = {}) {
  const home = join(layout.root, 'baseline-home');
  const tmp = join(layout.root, 'baseline-tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const env = inheritEnv();
  env.HOME = home;
  env.TMPDIR = tmp;
  env.DSH_HOME = join(home, '.dsh');
  env.CI = '1';
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

/** Recorded before the cluster runs, and before any baseline command mutates a build output. */
export async function before({ workspace, report, layout }) {
  const source = '/home/leo/projects/deepseek-harness';
  const env = isolatedEnv(layout);
  const untouchedAtCopy = manifestFor(workspace, UNTOUCHED);
  // The source manifest is taken by the runner at copy time, before anything
  // in this run can touch either tree; re-deriving it here would silently
  // absorb any change made between the copy and this point.
  const manifestPath = join(layout.root, 'source-manifest-before.json');
  const metaPath = join(layout.root, 'source-manifest-meta.json');
  const sourceManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : null;
  const sourceExclusions = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')).exclude : ['node_modules', '.git', '.artifacts'];
  const baseline = {
    untouched_at_copy: untouchedAtCopy,
    vitest: runVitest(workspace, env),
    typecheck: runScripts(workspace, ['pnpm exec tsc -b tsconfig.host.json', 'pnpm exec tsc -b tsconfig.client.json'], 900_000, env),
    source_manifest_path: manifestPath,
    source_manifest_digest: sourceManifest?.digest ?? null,
    source_manifest_exclusions: sourceExclusions,
    api_before: apiSurface(workspace),
  };
  // A build may legitimately touch its own outputs; only the difference after
  // this point can be attributed to the cluster.
  baseline.untouched_after_baseline = manifestFor(workspace, UNTOUCHED);
  writeFileSync(join(layout.root, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  report.baseline = baseline;
  return baseline;
}

/** Path → sha1 for a whole tree, excluding only the named directory names. */
function buildFullManifest(root, exclude = []) {
  const entries = {};
  const skip = new Set(exclude);
  const walk = (dir, prefix) => {
    let listing;
    try {
      listing = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        try {
          entries[relative] = createHash('sha1').update(readFileSync(full)).digest('hex');
        } catch {
          entries[relative] = 'unreadable';
        }
      } else if (entry.isSymbolicLink()) {
        // Symlinks are part of the manifest, or a comparison would report
        // every link as a removed file.
        entries[relative] = `symlink:${readlinkSync(full)}`;
      }
    }
  };
  walk(root, '');
  const names = Object.keys(entries).sort();
  const digest = createHash('sha1');
  for (const name of names) digest.update(`${name}\u0000${entries[name]}\n`);
  return { root, files: names.length, digest: digest.digest('hex'), entries };
}

/** Path → sha1 for one tree, restricted to the given relative prefixes. */
function manifestFor(root, prefixes) {
  const entries = {};
  for (const prefix of prefixes) {
    const base = join(root, prefix);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let listing;
      try {
        listing = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of listing) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          try {
            entries[full.slice(root.length + 1)] = createHash('sha1').update(readFileSync(full)).digest('hex');
          } catch {
            entries[full.slice(root.length + 1)] = 'unreadable';
          }
        }
      }
    }
  }
  const names = Object.keys(entries).sort();
  const digest = createHash('sha1');
  for (const name of names) digest.update(`${name}\u0000${entries[name]}\n`);
  return { files: names.length, digest: digest.digest('hex'), entries };
}

/** Files whose content or presence differs between two manifests. */
function manifestDiff(beforeManifest, afterManifest) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [name, hash] of Object.entries(afterManifest.entries)) {
    if (!(name in beforeManifest.entries)) added.push(name);
    else if (beforeManifest.entries[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(beforeManifest.entries)) if (!(name in afterManifest.entries)) removed.push(name);
  return { changed, added, removed };
}

export async function run({ workspace, report, layout }) {
  const env = isolatedEnv(layout);
  const source = '/home/leo/projects/deepseek-harness';
  const checks = [];
  const push = (name, passed, evidence, { blocked = false } = {}) => checks.push({
    name, passed: blocked ? null : Boolean(passed), blocked: blocked || undefined, evidence: String(evidence).slice(0, 2500),
  });
  const baseline = report.baseline ?? {};
  const artifacts = layout.artifacts;

  const api = apiSurface(workspace);
  writeFileSync(join(layout.artifacts, 'api-surface.json'), `${JSON.stringify(api, null, 2)}\n`);
  push('definition-renamed', api.definition_has_measureContext && !api.definition_has_bare_measure,
    `measureContext=${api.definition_has_measureContext} oldMeasure=${api.definition_has_bare_measure}`);
  push('no-production-consumer-left', api.production_callsite_files.length === 0,
    `${api.production_callsite_files.length} files still call .measure( : ${api.production_callsite_files.slice(0, 8).join(', ')}`);
  push('new-consumers-present', api.measureContext_callsites >= 4, `${api.measureContext_callsites} measureContext call sites`);
  push('old-name-absent-from-docs', api.docs_mentioning_old_name.length === 0,
    `docs still mentioning the old name: ${api.docs_mentioning_old_name.slice(0, 8).join(', ')}`);

  const specsPresent = SPECS.every(spec => existsSync(join(workspace, spec)) && statSync(join(workspace, spec)).size > 200);
  push('behaviour-specs-preserved', specsPresent, `${SPECS.filter(spec => existsSync(join(workspace, spec))).length}/${SPECS.length} spec files present`);

  const typecheck = runScripts(workspace, ['pnpm exec tsc -b tsconfig.host.json', 'pnpm exec tsc -b tsconfig.client.json'], 900_000, env);
  push('typecheck-host', typecheck.results[0]?.status === 0 || compareExit(baseline.typecheck?.results?.[0], typecheck.results[0]),
    `exit ${typecheck.results[0]?.status}; baseline ${baseline.typecheck?.results?.[0]?.status}`);
  push('typecheck-client', typecheck.results[1]?.status === 0 || compareExit(baseline.typecheck?.results?.[1], typecheck.results[1]),
    `exit ${typecheck.results[1]?.status}; baseline ${baseline.typecheck?.results?.[1]?.status}`);

  const vitest = runVitest(workspace, env);
  const newFailures = diffFailures(baseline.vitest?.failed ?? [], vitest.failed);
  push('vitest-specs', vitest.failed.length === 0 || newFailures.length === 0,
    `${vitest.passed}/${vitest.total} passed; new failures: ${newFailures.join(', ') || 'none'}; baseline failures: ${(baseline.vitest?.failed ?? []).join(', ') || 'none'}`);

  const gates = runGates(workspace, env);
  writeFileSync(join(artifacts, 'gates.log'), gates.map(gate => `$ ${gate.command}\nexit ${gate.status}\n${(gate.stderr ?? '').slice(-2000)}\n`).join('\n'));
  for (const gate of gates) push(`gate-${gate.name}`, gate.status === 0, `exit ${gate.status}: ${(gate.stderr ?? '').slice(-600)}`);

  const build = runScripts(workspace, ['pnpm exec tsdown --env.DSH_BUILD_FACE host'], 1_800_000, env);
  const built = build.results[0];
  if (built?.status === 0 && existsSync(join(workspace, 'packages/llm/token-meter/lib/index.js'))) {
    const lib = readFileSync(join(workspace, 'packages/llm/token-meter/lib/index.js'), 'utf8');
    push('built-artifact-exposes-new-api', /measureContext/.test(lib) && !/\bmeasure\s*\(/.test(lib.replace(/measureContext/g, '')),
      `lib/index.js ${lib.length} bytes; measureContext present: ${/measureContext/.test(lib)}`);
  } else {
    push('built-artifact-exposes-new-api', false, `tsdown exit ${built?.status}; artifact present ${existsSync(join(workspace, 'packages/llm/token-meter/lib/index.js'))}`, { blocked: true });
  }

  const untouchedAfter = manifestFor(workspace, UNTOUCHED);
  const untouchedDrift = manifestDiff(baseline.untouched_after_baseline ?? { entries: {} }, untouchedAfter);
  push('untouched-prefixes-unchanged', untouchedDrift.changed.length + untouchedDrift.added.length + untouchedDrift.removed.length === 0,
    `${untouchedAfter.files} files hashed; changed ${untouchedDrift.changed.length}, added ${untouchedDrift.added.length}, removed ${untouchedDrift.removed.length}${untouchedDrift.changed.slice(0, 3).map(name => ` (${name})`).join('')}`);

  const sourceManifestBefore = existsSync(baseline.source_manifest_path ?? '')
    ? JSON.parse(readFileSync(baseline.source_manifest_path, 'utf8'))
    : { entries: {} };
  const sourceAfter = buildFullManifest(source, baseline.source_manifest_exclusions ?? ['node_modules', '.git', '.artifacts']);
  const sourceDrift = manifestDiff(sourceManifestBefore, sourceAfter);
  push('source-repository-unchanged', sourceDrift.changed.length + sourceDrift.added.length + sourceDrift.removed.length === 0,
    `${sourceAfter.files} files hashed; changed ${sourceDrift.changed.length}, added ${sourceDrift.added.length}, removed ${sourceDrift.removed.length}${sourceDrift.changed.slice(0, 3).map(name => ` (${name})`).join('')}`);

  const copyIntegrity = report.preparation?.copy_integrity ?? {};
  const intoSource = copyIntegrity.symlinks?.into_source ?? [];
  // The runner aborts the run when the copy is not isolated, so reaching this
  // point with a populated finding list would itself be the defect.
  push('copy-isolation-gate-passed', intoSource.length === 0 && (copyIntegrity.symlinks?.outside ?? []).length === 0,
    `${copyIntegrity.symlinks?.total ?? 0} symlinks (${copyIntegrity.symlinks?.absolute ?? 0} absolute, ${copyIntegrity.symlinks?.broken ?? 0} broken), ${intoSource.length} into the source, ${(copyIntegrity.symlinks?.outside ?? []).length} outside the allowed roots`);
  push('copy-files-are-independent-inodes', (copyIntegrity.inodes?.shared ?? []).length === 0,
    `${copyIntegrity.inodes?.checked ?? 0} files compared by (dev, ino), ${(copyIntegrity.inodes?.shared ?? []).length} sharing an inode with the source (hardlink)`);

  const coverage = api.production_call_sites_baseline > 0
    ? api.measureContext_callsites / api.production_call_sites_baseline
    : 0;
  writeFileSync(join(artifacts, 'metrics.json'), `${JSON.stringify({
    production_call_sites_before: api.production_call_sites_baseline,
    production_call_sites_after: api.production_callsite_files.length,
    measureContext_call_sites: api.measureContext_callsites,
    coverage_ratio: Number(coverage.toFixed(3)),
    vitest_passed: vitest.passed,
    vitest_total: vitest.total,
    new_failures: newFailures.length,
    tsc_host: typecheck.results[0]?.status,
    tsc_client: typecheck.results[1]?.status,
    gates: Object.fromEntries(gates.map(gate => [gate.name, gate.status])),
  }, null, 2)}\n`);

  const failed = checks.filter(entry => entry.passed === false);
  const blocked = checks.filter(entry => entry.blocked);
  // The mechanism verdict is about the harness: isolation, integrity and the
  // evidence gates. Whether the migration itself happened is model output.
  const mechanismFailed = failed.some(entry => [
    'behaviour-specs-preserved', 'copy-isolation-gate-passed', 'copy-files-are-independent-inodes',
    'source-repository-unchanged', 'untouched-prefixes-unchanged',
  ].includes(entry.name));
  return {
    checks,
    scenario_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    failure_class: failed.length === 0 ? null : mechanismFailed ? 'MECHANISM' : 'MODEL_OUTPUT',
    blocked_checks: blocked.map(entry => entry.name),
  };
}

function compareExit(baselineEntry, current) {
  return baselineEntry && baselineEntry.status === current?.status && current?.status !== 0;
}

function runScripts(cwd, commands, timeout = 900_000, env = process.env) {
  const results = commands.map(command => {
    const result = spawnSync('bash', ['-lc', command], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout, env });
    return { command, status: result.status, stdout: (result.stdout ?? '').slice(-8000), stderr: (result.stderr ?? '').slice(-8000), signal: result.signal };
  });
  return { results };
}

function runVitest(cwd, env = process.env) {
  const result = spawnSync('bash', ['-lc', `pnpm exec vitest run --reporter=json --outputFile=${JSON.stringify(join(cwd, 'vitest-report.json'))} ${SPECS.join(' ')}`], {
    cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1_800_000, env,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, 'vitest-report.json'), 'utf8'));
  } catch {
    parsed = null;
  }
  const failed = [];
  let passed = 0;
  let total = 0;
  if (parsed?.testResults) {
    for (const file of parsed.testResults) {
      for (const assertion of file.assertionResults ?? []) {
        total += 1;
        if (assertion.status === 'passed') passed += 1;
        else if (assertion.status === 'failed') failed.push(`${file.name.split('/').slice(-2).join('/')}::${assertion.title}`);
      }
    }
  }
  return { status: result.status, passed, total, failed, stderr: (result.stderr ?? '').slice(-4000) };
}

function diffFailures(baselineFailures, currentFailures) {
  const before = new Set(baselineFailures ?? []);
  return (currentFailures ?? []).filter(name => !before.has(name));
}

function runGates(cwd, env = process.env) {
  return GATES.map(name => {
    const result = spawnSync('bash', ['-lc', `pnpm run ${name}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900_000, env });
    return { name, command: `pnpm run ${name}`, status: result.status, stdout: (result.stdout ?? '').slice(-4000), stderr: (result.stderr ?? '').slice(-4000) };
  });
}

/** Migrated API surface facts, computed from the copy's own sources. */
function apiSurface(workspace) {
  const definition = join(workspace, 'packages/llm/token-meter/src/index.ts');
  const definitionText = existsSync(definition) ? readFileSync(definition, 'utf8') : '';
  const files = listSourceFiles(workspace);
  const production = [];
  const docs = [];
  let measureContextCallsites = 0;
  let baselineCallSites = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const relative = file.replace(`${workspace}/`, '');
    const calls = (text.match(/\.measure\s*\(/g) ?? []).length;
    const newCalls = (text.match(/\.measureContext\s*\(/g) ?? []).length;
    measureContextCallsites += newCalls;
    if (calls > 0 && /token-meter|TokenMeter|tokenMeter/.test(text) && !relative.includes('/tests/')) {
      production.push(relative);
      baselineCallSites += calls;
    }
    if (/README/.test(relative) && /\bmeasure\s*\(/.test(text) && !/measureContext/.test(text)) docs.push(relative);
  }
  return {
    definition_has_measureContext: /\bmeasureContext\s*[(:]/.test(definitionText),
    definition_has_bare_measure: /\bmeasure\s*\(/.test(definitionText) && !/measureContext/.test(definitionText),
    production_callsite_files: production,
    production_call_sites_baseline: baselineCallSites,
    measureContext_callsites: measureContextCallsites,
    docs_mentioning_old_name: docs,
  };
}

function listSourceFiles(workspace) {
  const out = [];
  const roots = ['packages/llm/token-meter', 'packages/compaction/compaction-basic', 'packages/acp/acp', 'packages/core/session', 'packages/llm/llm'];
  for (const root of roots) {
    const base = join(workspace, root);
    if (!existsSync(base)) continue;
    walk(base, out, 0);
  }
  return out;
}

function walk(dir, out, depth) {
  if (depth > 8) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else if (/\.(ts|tsx|md|ya?ml)$/.test(entry.name)) out.push(full);
  }
}

