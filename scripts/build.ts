import { execFileSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compiler = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
await rm(resolve(root, 'packages/dsh-flow/lib'), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [compiler, '-p', 'tsconfig.build.client.json'], { cwd: root, stdio: 'inherit' });
await build({
  entryPoints: {
    index: 'packages/dsh-flow/src/index.ts',
    'core/index': 'packages/dsh-flow/src/core/index.ts',
    'host/index': 'packages/dsh-flow/src/host/index.ts',
    'run/index': 'packages/dsh-flow/src/run/index.ts',
    'assignments/index': 'packages/dsh-flow/src/assignments/index.ts',
    'patterns/index': 'packages/dsh-flow/src/patterns/index.ts',
    'dashboard/index': 'packages/dsh-flow/src/dashboard/index.ts',
    'native/index': 'packages/dsh-flow/src/native/index.ts',
  },
  outdir: 'packages/dsh-flow/lib',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  absWorkingDir: root,
});
await build({
  entryPoints: { 'dashboard/client': 'packages/dsh-flow/src/dashboard/client.ts', 'dashboard/protocol': 'packages/dsh-flow/src/dashboard/protocol.ts',
    'native/protocol': 'packages/dsh-flow/src/native/protocol.ts', 'ui/index': 'packages/dsh-flow/src/ui/index.ts' },
  outdir: 'packages/dsh-flow/lib', bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  packages: 'external', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: true, legalComments: 'none', logLevel: 'info', absWorkingDir: root,
});
await build({
  entryPoints: { client: 'packages/dsh-flow/src/native/client.tsx' },
  outdir: 'packages/dsh-flow/lib', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-flow",factory(require){var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  minify: true, define: { 'process.env.NODE_ENV': '"production"' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'],
  sourcemap: true, legalComments: 'none', logLevel: 'info', absWorkingDir: root,
});
await rm(resolve(root, 'packages/dsh-flow/web'), { recursive: true, force: true });
await build({
  entryPoints: { app: 'packages/dsh-flow/src/ui/web.tsx' }, outdir: 'packages/dsh-flow/web',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true,
  minify: true, define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none', logLevel: 'info', absWorkingDir: root,
});
await cp(resolve(root, 'packages/dsh-flow/src/ui/index.html'), resolve(root, 'packages/dsh-flow/web/index.html'));
for (const directory of ['lib', 'web']) await cp(resolve(root, 'packages/dsh-flow/src/ui/LICENSE.deepseek-icon.txt'), resolve(root, `packages/dsh-flow/${directory}/LICENSE.deepseek-icon.txt`));
for (const name of ['typert.host', 'typert.remote-client']) {
  await cp(resolve(root, `packages/dsh-flow/src/native/${name}.d.ts`), resolve(root, `packages/dsh-flow/lib/types/native/${name}.d.ts`));
}
await rm(resolve(root, 'packages/dsh-flow/patterns'), { recursive: true, force: true });
await cp(resolve(root, 'docs/design/public/patterns'), resolve(root, 'packages/dsh-flow/patterns'), { recursive: true });
