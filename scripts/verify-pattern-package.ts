import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs/design/public/patterns');
const scratch = mkdtempSync(join(tmpdir(), 'flow-pattern-package-'));
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && !entry.name.startsWith('.') ? [path] : [];
  }).sort();
}
try {
  execFileSync('pnpm', ['--config.ignore-scripts=true', '--dir', join(root, 'packages/dsh-flow'), 'pack', '--pack-destination', scratch], { stdio: 'pipe' });
  const archives = readdirSync(scratch).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const archive = join(scratch, archives[0]!);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')));
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  const assets = files(source);
  for (const path of assets) assert.deepEqual(readFileSync(join(scratch, 'package/patterns', relative(source, path))), readFileSync(path), relative(source, path));
  const expectedIds = assets.filter(path => path.endsWith('/pattern.yaml')).map(path => {
    const value: unknown = parse(readFileSync(path, 'utf8'));
    assert.ok(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string');
    return value.id;
  }).sort();
  assert.equal(expectedIds.length, 14);
  const runner = join(scratch, 'consumer');
  mkdirSync(runner);
  writeFileSync(join(runner, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-flow': `file:${archive}` } }));
  execFileSync('pnpm', ['--dir', runner, 'install', '--ignore-scripts', '--config.auto-install-peers=false', '--config.strict-peer-dependencies=false', '--no-frozen-lockfile'], { stdio: 'pipe', timeout: 180_000 });
  const probe = `
import assert from 'node:assert/strict';
import { PatternCatalog } from 'dsh-flow/patterns';
const catalog = new PatternCatalog();
const listed = catalog.list();
assert.equal(listed.ok, true, JSON.stringify(listed));
assert.deepEqual(listed.patterns.map(pattern => pattern.id).sort(), ${JSON.stringify(expectedIds)});
for (const pattern of listed.patterns) {
  const result = catalog.resolve(pattern.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Object.isFrozen(result.definition));
}
console.log(JSON.stringify({ packages: listed.patterns.length, installed: true }));
`;
  writeFileSync(join(runner, 'probe.mjs'), probe);
  const result: unknown = JSON.parse(execFileSync(process.execPath, ['probe.mjs'], { cwd: runner, encoding: 'utf8' }));
  console.log(JSON.stringify({ result, matchingAssetFiles: assets.length, runtimeDependencyOnly: true }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
