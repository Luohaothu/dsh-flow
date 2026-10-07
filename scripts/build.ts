#!/usr/bin/env tsx
/**
 * Build the plugin's published halves and check the whole type graph.
 *
 * Order, and why:
 *   1. `tsc -b tsconfig.host.json`   — Host program: types + JavaScript for the
 *      package leaf, plus every dev/acceptance caller.
 *   2. esbuild Host entries          — `lib/types/{index,command,web}.js` become
 *      the stable runtime entry points; `@deepseek-ai/*` and `node:*` stay
 *      external so the plugin and the host share one service registry.
 *   3. Typert generation             — the Host `ts.Program` is the only seed
 *      for the strict Remote descriptors and codecs; the Client consumes the
 *      result, so this must finish before the Client program runs.
 *   4. `tsc -b tsconfig.client.json` — Client program, including the generated
 *      `/remote` declarations.
 *   5. seed `tsc --noEmit`           — the acceptance website is an independent
 *      project that must check without this repository's tsconfigs.
 *   6. esbuild Client entry          — browser bundle inside the DSH module
 *      loader factory, with the generated Remote contribution inlined.
 *
 * `--typecheck-only` runs 1, 2, 3, 4 and 5 and skips only the final Client
 * bundle, so a clean tree (no `lib/`) still type-checks without a prior build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(PROJECT_ROOT, 'packages', 'dsh-flow');
const PLUGIN_LIB = join(PLUGIN_ROOT, 'lib');
const SEED_CONFIG = join(PROJECT_ROOT, 'tests', 'acceptance', 'seeds', 'website', 'tsconfig.json');
const HOST_ENTRIES = ['index', 'web', 'command'];

const typecheckOnly = process.argv.includes('--typecheck-only');
const TSC = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

/** Run one child command, inheriting stdio; a non-zero status fails the build. */
function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

/** Run the workspace TypeScript compiler. */
function tsc(...args: string[]): void {
  run(process.execPath, [TSC, ...args]);
}

/** Bundle the plugin's Host entry points from the emitted JavaScript. */
async function buildHost(): Promise<void> {
  mkdirSync(PLUGIN_LIB, { recursive: true });
  await esbuild.build({
    bundle: true,
    logLevel: 'info',
    sourcemap: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: HOST_ENTRIES.map(name => join(PLUGIN_LIB, 'types', `${name}.js`)),
    outdir: PLUGIN_LIB,
    entryNames: '[name]',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@deepseek-ai/*', 'node:*'],
  });
}

/** Emit the strict descriptor and codec artifacts for this package's Host face. */
function generateTypert(): void {
  const generator = new WorkspaceTypertGenerator(PROJECT_ROOT);
  const artifacts = generator.generate(['dsh-flow'], ['host']);
  if (artifacts.length === 0) throw new Error('build: typert generated no artifact for dsh-flow');
  for (const artifact of artifacts) {
    const output = join(PROJECT_ROOT, artifact.packageRoot, 'lib');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'typert.host.js'), artifact.js);
    writeFileSync(join(output, 'typert.host.d.ts'), artifact.dts);
    if (artifact.remote === undefined) {
      throw new Error('build: dsh-flow declares a ./remote export but generated no Remote artifact');
    }
    writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js);
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts);
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap);
  }
}

/** Bundle the browser entry inside the DSH module-loader factory. */
async function buildClient(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')) as { name: string };
  await esbuild.build({
    loader: { '.svg': 'dataurl' },
    bundle: true,
    logLevel: 'info',
    sourcemap: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [join(PLUGIN_LIB, 'types', 'client.js')],
    outfile: join(PLUGIN_LIB, 'client.js'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    // The generated Remote contribution and its zod codec are inlined: the
    // browser has no resolver for `dsh-flow/remote`. Everything the host client
    // runtime already provides stays external and is served by the loader.
    // This list is an allowlist, not a census: it names the host client modules
    // this plugin may rely on, so that adding an import of one can never
    // silently bundle a second copy of a service the page already has.
    external: [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-api-gateway/client',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-connection/client',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-conversation/client',
      '@deepseek-ai/dsh-client-ui-chat/client',
    ],
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\n`
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  });
}

/** Keep incremental output aligned with the current source tree and bundle entries. */
function pruneOutputs(): void {
  const typesRoot = join(PLUGIN_LIB, 'types');
  if (existsSync(typesRoot)) {
    for (const entry of readdirSync(typesRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/(?:\.d\.ts|\.js)(?:\.map)?$/.test(entry.name)) continue;
      const output = join(entry.parentPath, entry.name);
      const source = output.slice(typesRoot.length + 1).replace(/(?:\.d\.ts|\.js)(?:\.map)?$/, '');
      if (['.ts', '.tsx', '.d.ts'].some(extension => existsSync(join(PLUGIN_ROOT, 'src', source + extension)))) continue;
      rmSync(output);
    }
  }
  if (existsSync(PLUGIN_LIB)) {
    const bundleFiles = new Set([...HOST_ENTRIES, 'client'].flatMap(name => [`${name}.js`, `${name}.js.map`]));
    for (const entry of readdirSync(PLUGIN_LIB, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.js(?:\.map)?$/.test(entry.name) || entry.name.startsWith('typert.')) continue;
      if (!bundleFiles.has(entry.name)) rmSync(join(PLUGIN_LIB, entry.name));
    }
  }
}
pruneOutputs();
tsc('-b', 'tsconfig.host.json');
await buildHost();
generateTypert();
tsc('-b', 'tsconfig.client.json');
tsc('-p', SEED_CONFIG, '--noEmit');
if (!typecheckOnly) await buildClient();

console.log(typecheckOnly
  ? 'build: typecheck complete (Host, Remote generation, Client, website seed)'
  : `build: wrote ${join(PLUGIN_LIB, 'index.js')}, ${join(PLUGIN_LIB, 'client.js')} and the Typert artifacts`);
