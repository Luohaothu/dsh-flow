import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

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
  execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/build.ts')], { cwd: root, stdio: 'pipe' });
  execFileSync('pnpm', ['--config.ignore-scripts=true', '--dir', join(root, 'packages/dsh-flow'), 'pack', '--pack-destination', scratch], { stdio: 'pipe' });
  const archives = readdirSync(scratch).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const archive = join(scratch, archives[0]!);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')));
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  const packaged = join(scratch, 'package');
  const metadata = JSON.parse(readFileSync(join(packaged, 'package.json'), 'utf8'));
  assert.equal(metadata.dsh.client.platform, 'web');
  assert.ok(metadata.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'));
  assert.ok(metadata.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-theme'));
  assert.equal(metadata.exports['./client'].default, './lib/client.js');
  for (const entry of ['./native', './native/protocol', './ui', './client']) {
    for (const path of Object.values(metadata.exports[entry]) as string[]) assert.ok(readFileSync(join(packaged, path)).length > 0);
  }
  const patch = parse(readFileSync(join(packaged, metadata.dsh.bundle.patch), 'utf8'));
  assert.equal(patch[0].insert[0].id, 'dsh-flow');
  const nativeScript = readFileSync(join(packaged, metadata.exports['./client'].default), 'utf8');
  const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']);
  const localRequire = createRequire(import.meta.url), external = new Set<string>();
  let registration: { id: string; factory(require: (name: string) => unknown): { apply: unknown; inject: unknown } } | undefined;
  runInNewContext(nativeScript, { window: { __ModuleLoader__: { load(value: typeof registration) { registration = value; } } },
    AbortController, TextEncoder, TextDecoder, URL, queueMicrotask, setTimeout, clearTimeout, crypto: globalThis.crypto }, { timeout: 5_000 });
  assert.equal(registration?.id, 'dsh-flow');
  const native = registration!.factory(name => { assert.ok(allowed.has(name), `Unexpected Native external: ${name}`); external.add(name); return localRequire(name); });
  assert.equal(typeof native.apply, 'function');
  assert.ok(Array.isArray(native.inject));
  const webHtml = readFileSync(join(packaged, 'web/index.html'), 'utf8');
  assert.match(webHtml, /src="\.\/app\.js"/);
  assert.ok(readFileSync(join(packaged, 'web/app.js')).length > 0);
  for (const path of ['lib', 'web']) assert.deepEqual(readFileSync(join(packaged, path, 'LICENSE.deepseek-icon.txt')),
    readFileSync(join(root, 'packages/dsh-flow/src/ui/LICENSE.deepseek-icon.txt')));
  const assets = files(source);
  for (const path of assets) assert.deepEqual(readFileSync(join(scratch, 'package/patterns', relative(source, path))), readFileSync(path), relative(source, path));
  const skills = files(join(root, 'packages/dsh-flow/skills'));
  for (const path of skills) assert.deepEqual(readFileSync(join(scratch, 'package/skills', relative(join(root, 'packages/dsh-flow/skills'), path))), readFileSync(path), relative(root, path));
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
import { DashboardClient } from 'dsh-flow/dashboard/client';
import { PROTOCOL_VERSION } from 'dsh-flow/dashboard/protocol';
const client = new DashboardClient({ baseUrl: 'http://127.0.0.1:1' });
assert.equal(client.getState().connection, 'idle');
assert.equal(PROTOCOL_VERSION.major, 1);
client.dispose();
const catalog = new PatternCatalog();
const listed = catalog.list();
assert.equal(listed.ok, true, JSON.stringify(listed));
assert.deepEqual(listed.patterns.map(pattern => pattern.id).sort(), ${JSON.stringify(expectedIds)});
for (const pattern of listed.patterns) {
  const result = catalog.resolve(pattern.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Object.isFrozen(result.definition));
}
console.log(JSON.stringify({ packages: listed.patterns.length, installed: true, browserClient: true }));
`;
  writeFileSync(join(runner, 'probe.mjs'), probe);
  const result: unknown = JSON.parse(execFileSync(process.execPath, ['probe.mjs'], { cwd: runner, encoding: 'utf8' }));
  console.log(JSON.stringify({ result, matchingAssetFiles: assets.length, matchingSkillFiles: skills.length, runtimeDependencyOnly: true,
    builtFromSource: true, nativeModulePackaging: true, nativeExternals: [...external], standaloneWeb: true, iconLicense: true }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
