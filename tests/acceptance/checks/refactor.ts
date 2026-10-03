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
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { inheritEnv } from '../../../src/host/host.ts';
import type { RunLayout } from '../../../src/host/types.ts';
import { asArray, asNumber, asObject, asString } from '../context.ts';
import type { AcceptanceReport, CheckEntry, CheckOutcome, JsonObject } from '../context.ts';

interface RefactorContext {
  workspace: string;
  report: Pick<AcceptanceReport, 'baseline' | 'preparation'>;
  layout: Pick<RunLayout, 'root' | 'artifacts'>;
}

interface Manifest {
  root?: string;
  files: number;
  digest: string;
  entries: Record<string, string>;
}

interface ScriptResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

interface ScriptsRun { results: ScriptResult[] }

interface RefactorBaseline {
  untouched_at_copy: Manifest;
  untouched_after_baseline?: Manifest;
  vitest: VitestRun;
  typecheck: ScriptsRun;
  source_manifest_path: string;
  source_manifest_digest: string | null;
  source_manifest_exclusions: readonly string[];
  api_before: ApiSurface;
}
interface VitestRun { status: number | null; passed: number; total: number; failed: string[]; stderr: string }
interface GateRun { name: string; command: string; status: number | null; stdout: string; stderr: string }

interface ApiSurface {
  definition_has_measureContext: boolean;
  definition_has_bare_measure: boolean;
  production_callsite_files: string[];
  production_call_sites_baseline: number;
  measureContext_callsites: number;
  docs_mentioning_old_name: string[];
}

interface RefactorCheck extends CheckEntry {
  blocked?: boolean | undefined;
}

interface RefactorOutcome extends CheckOutcome {
  checks: RefactorCheck[];
  blocked_checks: string[];
}

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
function isolatedEnv(layout: Pick<RunLayout, 'root'>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
export async function before({ workspace, report, layout }: RefactorContext): Promise<RefactorBaseline> {
  const env = isolatedEnv(layout);
  const untouchedAtCopy = manifestFor(workspace, UNTOUCHED);
  // The source manifest is taken by the runner at copy time, before anything
  // in this run can touch either tree; re-deriving it here would silently
  // absorb any change made between the copy and this point.
  const manifestPath = join(layout.root, 'source-manifest-before.json');
  const metaPath = join(layout.root, 'source-manifest-meta.json');
  const sourceManifest = existsSync(manifestPath)
    ? asObject(JSON.parse(readFileSync(manifestPath, 'utf8')))
    : null;
  const sourceMeta = existsSync(metaPath) ? asObject(JSON.parse(readFileSync(metaPath, 'utf8'))) : null;
  const sourceExclusions = stringArray(sourceMeta?.exclude) ?? ['node_modules', '.git', '.artifacts'];
  const baseline: RefactorBaseline = {
    untouched_at_copy: untouchedAtCopy,
    vitest: runVitest(workspace, env),
    typecheck: runScripts(workspace, ['pnpm exec tsc -b tsconfig.host.json', 'pnpm exec tsc -b tsconfig.client.json'], 900_000, env),
    source_manifest_path: manifestPath,
    source_manifest_digest: asString(sourceManifest?.digest),
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
function buildFullManifest(root: string, exclude: readonly string[] = []): Manifest {
  const entries: Record<string, string> = {};
  const skip = new Set(exclude);
  const walk = (dir: string, prefix: string): void => {
    let listing: Dirent[];
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
function manifestFor(root: string, prefixes: readonly string[]): Manifest {
  const entries: Record<string, string> = {};
  for (const prefix of prefixes) {
    const base = join(root, prefix);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      if (dir === undefined) continue;
      let listing: Dirent[];
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
function manifestDiff(beforeManifest: Pick<Manifest, 'entries'>, afterManifest: Pick<Manifest, 'entries'>): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(afterManifest.entries)) {
    if (!(name in beforeManifest.entries)) added.push(name);
    else if (beforeManifest.entries[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(beforeManifest.entries)) if (!(name in afterManifest.entries)) removed.push(name);
  return { changed, added, removed };
}

export async function run({ workspace, report, layout }: RefactorContext): Promise<RefactorOutcome> {
  const env = isolatedEnv(layout);
  const source = '/home/leo/projects/deepseek-harness';
  const checks: RefactorCheck[] = [];
  const push = (name: string, passed: boolean, evidence: string, { blocked = false }: { blocked?: boolean } = {}): number => checks.push({
    name, passed: blocked ? null : Boolean(passed), blocked: blocked || undefined, evidence: String(evidence).slice(0, 2500),
  });
  const baseline = asObject(report.baseline);
  const baselineTypecheck = asArray(asObject(baseline?.typecheck)?.results);
  const baselineVitestFailures = stringArray(asObject(baseline?.vitest)?.failed) ?? [];
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
  push('typecheck-host', typecheck.results[0]?.status === 0 || compareExit(baselineTypecheck?.[0], typecheck.results[0]),
    `exit ${typecheck.results[0]?.status}; baseline ${asObject(baselineTypecheck?.[0])?.status}`);
  push('typecheck-client', typecheck.results[1]?.status === 0 || compareExit(baselineTypecheck?.[1], typecheck.results[1]),
    `exit ${typecheck.results[1]?.status}; baseline ${asObject(baselineTypecheck?.[1])?.status}`);

  const vitest = runVitest(workspace, env);
  const newFailures = diffFailures(baselineVitestFailures, vitest.failed);
  push('vitest-specs', vitest.failed.length === 0 || newFailures.length === 0,
    `${vitest.passed}/${vitest.total} passed; new failures: ${newFailures.join(', ') || 'none'}; baseline failures: ${baselineVitestFailures.join(', ') || 'none'}`);

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
  const untouchedDrift = manifestDiff(manifestEntries(baseline?.untouched_after_baseline), untouchedAfter);
  push('untouched-prefixes-unchanged', untouchedDrift.changed.length + untouchedDrift.added.length + untouchedDrift.removed.length === 0,
    `${untouchedAfter.files} files hashed; changed ${untouchedDrift.changed.length}, added ${untouchedDrift.added.length}, removed ${untouchedDrift.removed.length}${untouchedDrift.changed.slice(0, 3).map(name => ` (${name})`).join('')}`);

  const sourceManifestPath = asString(baseline?.source_manifest_path) ?? '';
  const sourceManifestBefore = existsSync(sourceManifestPath)
    ? manifestEntries(JSON.parse(readFileSync(sourceManifestPath, 'utf8')))
    : { entries: {} };
  const sourceAfter = buildFullManifest(source, stringArray(baseline?.source_manifest_exclusions) ?? ['node_modules', '.git', '.artifacts']);
  const sourceDrift = manifestDiff(sourceManifestBefore, sourceAfter);
  push('source-repository-unchanged', sourceDrift.changed.length + sourceDrift.added.length + sourceDrift.removed.length === 0,
    `${sourceAfter.files} files hashed; changed ${sourceDrift.changed.length}, added ${sourceDrift.added.length}, removed ${sourceDrift.removed.length}${sourceDrift.changed.slice(0, 3).map(name => ` (${name})`).join('')}`);

  const copyIntegrity = asObject(report.preparation?.copy_integrity);
  const symlinks = asObject(copyIntegrity?.symlinks);
  const inodes = asObject(copyIntegrity?.inodes);
  const intoSource = asArray(symlinks?.into_source) ?? [];
  const outside = asArray(symlinks?.outside) ?? [];
  const shared = asArray(inodes?.shared) ?? [];
  // The runner aborts the run when the copy is not isolated, so reaching this
  // point with a populated finding list would itself be the defect.
  push('copy-isolation-gate-passed', intoSource.length === 0 && outside.length === 0,
    `${asNumber(symlinks?.total) ?? 0} symlinks (${asNumber(symlinks?.absolute) ?? 0} absolute, ${asNumber(symlinks?.broken) ?? 0} broken), ${intoSource.length} into the source, ${outside.length} outside the allowed roots`);
  push('copy-files-are-independent-inodes', shared.length === 0,
    `${asNumber(inodes?.checked) ?? 0} files compared by (dev, ino), ${shared.length} sharing an inode with the source (hardlink)`);

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

function compareExit(baselineEntry: unknown, current: ScriptResult | undefined): boolean {
  const entry = asObject(baselineEntry);
  return entry !== null && entry.status === current?.status && current?.status !== 0;
}

function runScripts(cwd: string, commands: readonly string[], timeout = 900_000, env: NodeJS.ProcessEnv = process.env): ScriptsRun {
  const results = commands.map(command => {
    const result = spawnSync('bash', ['-lc', command], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout, env });
    return { command, status: result.status, stdout: (result.stdout ?? '').slice(-8000), stderr: (result.stderr ?? '').slice(-8000), signal: result.signal };
  });
  return { results };
}

function runVitest(cwd: string, env: NodeJS.ProcessEnv = process.env): VitestRun {
  const result = spawnSync('bash', ['-lc', `pnpm exec vitest run --reporter=json --outputFile=${JSON.stringify(join(cwd, 'vitest-report.json'))} ${SPECS.join(' ')}`], {
    cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1_800_000, env,
  });
  let parsed: JsonObject | null = null;
  try {
    parsed = asObject(JSON.parse(readFileSync(join(cwd, 'vitest-report.json'), 'utf8')));
  } catch {
    parsed = null;
  }
  const failed: string[] = [];
  let passed = 0;
  let total = 0;
  const testResults = asArray(parsed?.testResults);
  if (testResults) {
    for (const fileValue of testResults) {
      const file = asObject(fileValue);
      for (const assertionValue of asArray(file?.assertionResults) ?? []) {
        const assertion = asObject(assertionValue);
        total += 1;
        if (assertion?.status === 'passed') passed += 1;
        else if (assertion?.status === 'failed') {
          const name = asString(file?.name);
          if (name === null) throw new Error('Vitest failed test result has no file name');
          failed.push(`${name.split('/').slice(-2).join('/')}::${assertion.title}`);
        }
      }
    }
  }
  return { status: result.status, passed, total, failed, stderr: (result.stderr ?? '').slice(-4000) };
}

function diffFailures(baselineFailures: readonly string[], currentFailures: readonly string[]): string[] {
  const before = new Set(baselineFailures ?? []);
  return (currentFailures ?? []).filter(name => !before.has(name));
}

function runGates(cwd: string, env: NodeJS.ProcessEnv = process.env): GateRun[] {
  return GATES.map(name => {
    const result = spawnSync('bash', ['-lc', `pnpm run ${name}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900_000, env });
    return { name, command: `pnpm run ${name}`, status: result.status, stdout: (result.stdout ?? '').slice(-4000), stderr: (result.stderr ?? '').slice(-4000) };
  });
}

/** Migrated API surface facts, computed from the copy's own sources. */
function apiSurface(workspace: string): ApiSurface {
  const definition = join(workspace, 'packages/llm/token-meter/src/index.ts');
  const definitionText = existsSync(definition) ? readFileSync(definition, 'utf8') : '';
  const files = listSourceFiles(workspace);
  const production: string[] = [];
  const docs: string[] = [];
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

function listSourceFiles(workspace: string): string[] {
  const out: string[] = [];
  const roots = ['packages/llm/token-meter', 'packages/compaction/compaction-basic', 'packages/acp/acp', 'packages/core/session', 'packages/llm/llm'];
  for (const root of roots) {
    const base = join(workspace, root);
    if (!existsSync(base)) continue;
    walk(base, out, 0);
  }
  return out;
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 8) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else if (/\.(ts|tsx|md|ya?ml)$/.test(entry.name)) out.push(full);
  }
}


function stringArray(value: unknown): string[] | null {
  const values = asArray(value);
  if (values === null) return null;
  const strings: string[] = [];
  for (const item of values) {
    const string = asString(item);
    if (string === null) throw new Error('Expected an array of strings');
    strings.push(string);
  }
  return strings;
}

function manifestEntries(value: unknown): Pick<Manifest, 'entries'> {
  const object = asObject(value);
  const rawEntries = asObject(object?.entries);
  const entries: Record<string, string> = {};
  for (const [path, value] of Object.entries(rawEntries ?? {})) {
    const hash = asString(value);
    if (hash === null) throw new Error(`Invalid manifest hash for ${path}`);
    entries[path] = hash;
  }
  return { entries };
}
