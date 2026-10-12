/** Historical model experiments run only from the explicitly restored old checkout. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const index = args.indexOf('--baseline');
assert(index >= 0 && args[index + 1], 'Historical experiment: restore the frozen baseline, then use --baseline <archive-directory>. See docs/experiments/auditor-ablation-reproduction.md.');
const baseline = realpathSync(resolve(args[index + 1]!));
args.splice(index, 2);
assert(args.every(arg => arg === '--pilot'), 'Only --pilot is supported in addition to --baseline');
const source = realpathSync(join(baseline, 'source'));
const current = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
assert.notEqual(source, current, 'The historical driver must not use the current production checkout');
const manifest = JSON.parse(readFileSync(join(baseline, 'manifest.json'), 'utf8')) as { commit: string; files: Record<string, string> };
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(join(source, name)), expected, `Frozen source changed: ${name}`);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), manifest.commit, 'Restore the original source commit before applying the frozen overlay');
const runtime = JSON.parse(readFileSync(join(source, '.artifacts/local-rc2/runtime-identity.json'), 'utf8')) as { archive_sha256: string; entries: Record<string, string> };
assert.equal(hash(join(baseline, 'runtime/dsh-flow-0.1.0.tgz')), runtime.archive_sha256);
for (const [name, expected] of Object.entries(runtime.entries)) assert.equal(hash(join(source, '.artifacts/local-rc2/package/lib', name)), expected, `Frozen runtime changed: ${name}`);
const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/experiments/auditor-ablation/run.ts', ...args], { cwd: source, stdio: 'inherit', env: process.env });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
