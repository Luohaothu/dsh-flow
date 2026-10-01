#!/usr/bin/env node
/**
 * Build the two published halves of the plugin:
 *   lib/index.js   Host-plane ESM bundle (harness packages stay external).
 *   lib/client.js  Browser bundle wrapped in the DSH module-loader factory
 *                  (`window.__ModuleLoader__.load({id, factory})`, CJS shape).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'dsh-flow';
const outDir = resolve(projectRoot, 'lib');
mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  logLevel: 'info',
  sourcemap: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const host = await esbuild.build({
  ...shared,
  entryPoints: [resolve(projectRoot, 'adapter/src/index.js')],
  outfile: resolve(outDir, 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*', 'node:*'],
});

const client = await esbuild.build({
  ...shared,
  entryPoints: [resolve(projectRoot, 'ui/src/client.jsx')],
  outfile: resolve(outDir, 'client.js'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
});

if (host.errors.length || client.errors.length) process.exit(1);
console.log(`build: wrote ${resolve(outDir, 'index.js')} and ${resolve(outDir, 'client.js')}`);