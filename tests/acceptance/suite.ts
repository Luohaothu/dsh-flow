#!/usr/bin/env node
/**
 * Run several acceptance cases in sequence, each in its own run id, data
 * directory and workspace. Cases never share a dataDir, so a case that ends in
 * a blocked state cannot disturb the next one.
 *
 * Usage:
 *   node tests/acceptance/suite.ts [--only smoke,recovery,website] [--parallel 2]
 *                            [--timeout-scale-ms 21600000]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT } from '../../src/host/host.ts';

/** One command-line token as `parseArgs` keeps it. */
type ArgValue = string | number | true;

/** The runner this suite spawns, always as a `.ts` entry point. */
const RUNNER = join(PROJECT_ROOT, 'tests/acceptance/run.ts');

/** One job in the suite: a case, an optional mode, and its deadline. */
interface SuiteEntry {
  case: string;
  timeoutMs: number;
  modes?: readonly string[];
  label?: string;
  extra?: readonly string[];
}

/** One planned job, after the suite entries have been expanded. */
interface SuiteJob {
  case: string;
  label: string;
  mode: string | null;
  extra: readonly string[];
  runId: string;
  timeoutMs: ArgValue;
  mock: boolean;
}

/** What one spawned runner reported back. */
interface JobResult {
  case: string;
  label: string;
  mode: string | null;
  runId: string;
  exit: number | null;
  status: string;
  detail: string;
}

const DEFAULT_SUITE: readonly SuiteEntry[] = [
  { case: 'smoke', timeoutMs: 1_200_000 },
  { case: 'panel', timeoutMs: 900_000 },
  { case: 'recovery', timeoutMs: 1_200_000 },
  { case: 'recursion', timeoutMs: 1_500_000 },
  { case: 'website', modes: ['hierarchical'], timeoutMs: 2_400_000 },
  { case: 'research', modes: ['hierarchical'], timeoutMs: 2_400_000 },
  { case: 'refactor', modes: ['hierarchical'], timeoutMs: 3_600_000 },
  { case: 'scale', timeoutMs: 3_600_000 },
];

/**
 * The deterministic suite. One job per scenario, in the order the acceptance
 * plan fixes them; the two scale tiers are separate jobs because each is a
 * distinct fixture with its own denominator.
 */
const MOCK_SUITE: readonly SuiteEntry[] = [
  { case: 'smoke', timeoutMs: 900_000 },
  { case: 'recursion', timeoutMs: 1_200_000 },
  { case: 'recovery', timeoutMs: 1_200_000 },
  { case: 'context', timeoutMs: 900_000 },
  { case: 'browser', timeoutMs: 900_000 },
  { case: 'panel', timeoutMs: 900_000 },
  { case: 'scale', label: 'scale16', timeoutMs: 3_600_000, extra: ['--dataset-limit', '16'] },
  { case: 'scale', label: 'scale64', timeoutMs: 3_600_000, extra: ['--dataset-limit', '64'] },
];

/**
 * A run id names one directory that must never have existed before. It carries
 * the case, the UTC start time and six random hex digits, so two suite runs can
 * never collide on one run directory and silently reuse another run's database.
 */
export function runIdFor(caseId: string, prefix: string | null = null, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = randomBytes(3).toString('hex');
  return `${prefix ?? caseId}-${stamp}-${suffix}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Combine the scenario, mechanism and child-process verdicts for one job. */
export function suiteJobStatus(exit: number | null, scenario: string | null, mechanism: string | null): string {
  const passed = exit === 0 && scenario === 'PASSED' && (mechanism === null || mechanism === 'PASS');
  return passed ? 'PASSED' : (scenario === 'PASSED' ? 'FAILED' : (scenario ?? 'FAILED'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const only = args.only ? new Set(String(args.only).split(',').map(part => part.trim())) : null;
  const jobs: SuiteJob[] = [];
  const prefix = typeof args['run-prefix'] === 'string' ? args['run-prefix'] : null;
  const suite = args.mock ? MOCK_SUITE : DEFAULT_SUITE;
  for (const entry of suite) {
    if (only && !only.has(entry.label ?? entry.case)) continue;
    for (const mode of entry.modes ?? [null]) {
      const runId = runIdFor(entry.label ?? entry.case, prefix);
      jobs.push({
        case: entry.case,
        label: entry.label ?? entry.case,
        mode,
        extra: entry.extra ?? [],
        runId: entry.modes && entry.modes.length > 1 ? `${runId}-${mode}` : runId,
        timeoutMs: args[`timeout-${entry.case}-ms`] ?? entry.timeoutMs,
        mock: Boolean(args.mock),
      });
    }
  }
  const parallel = Math.max(1, Number(args.parallel ?? 1));
  const results: JobResult[] = [];
  for (let index = 0; index < jobs.length; index += parallel) {
    const batch = jobs.slice(index, index + parallel);
    const settled = await Promise.all(batch.map(runJob));
    results.push(...settled);
  }
  console.log('\n=== suite summary ===');
  for (const result of results) {
    console.log(`${result.label.padEnd(12)} ${String(result.mode ?? '-').padEnd(13)} ${result.status.padEnd(8)} ${result.detail ?? ''}`);
  }
  const failed = results.filter(result => result.status !== 'PASSED');
  if (failed.length) process.exitCode = 1;
}

function runJob(job: SuiteJob): Promise<JobResult> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<JobResult>();
  // The tsx preload is an absolute URL: a suite job may run from an isolated
  // cwd (a copied workspace, a temp HOME), which cannot resolve `tsx` by
  // itself, and widening NODE_OPTIONS to smuggle it in would leak into every
  // child the host spawns. The runner is addressed absolutely for the same
  // reason.
  const argv = ['--import', import.meta.resolve('tsx'), RUNNER, '--case', job.case, '--run-id', job.runId, '--timeout-ms', String(job.timeoutMs)];
  if (job.mode) argv.push('--mode', job.mode);
  if (job.mock) argv.push('--mock');
  for (const value of job.extra ?? []) argv.push(String(value));
  const child = spawn(process.execPath, argv, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer | string) => { out += chunk; });
  child.stderr.on('data', (chunk: Buffer | string) => { out += chunk; });
  child.on('exit', code => {
    const summary = /"scenario_status": "(\w+)"/.exec(out);
    const failure = /"failure_class": "(\w+)"/.exec(out);
    // A scenario can pass while the *mechanism* it exists to prove did not: the
    // child prints both, and a verdict of PASSED over a MECHANISM failure would
    // hide a real regression behind a green suite. Exit status must also agree.
    const mechanism = /"mechanism_pass": "(\w+)"/.exec(out);
    const scenario = summary?.[1] ?? null;
    const mechanismPass = mechanism?.[1] ?? null;
    resolvePromise({
      case: job.case,
      label: job.label ?? job.case,
      mode: job.mode,
      runId: job.runId,
      exit: code,
      status: suiteJobStatus(code, scenario, mechanismPass),
      detail: [
        failure ? `class=${failure[1]}` : '',
        mechanismPass !== null && mechanismPass !== 'PASS' ? `mechanism=${mechanismPass}` : '',
        code !== 0 ? `exit=${code}` : '',
      ].filter(Boolean).join(' '),
    });
  });
  return promise;
}

function parseArgs(argv: readonly string[]): Record<string, ArgValue> {
  const out: Record<string, ArgValue> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = /^-?\d+$/.test(next) ? Number(next) : next;
      index += 1;
    }
  }
  return out;
}

/** Run only when executed directly: importing this module must have no effect. */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return self === resolve(entry);
  } catch {
    // A missing import must not turn the entry point into a silent no-op.
    return self.endsWith(entry);
  }
};

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
