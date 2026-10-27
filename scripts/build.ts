import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compiler = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
await rm(resolve(root, 'packages/dsh-flow/lib'), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
await build({
  entryPoints: {
    index: 'packages/dsh-flow/src/index.ts',
    'core/index': 'packages/dsh-flow/src/core/index.ts',
    'host/index': 'packages/dsh-flow/src/host/index.ts',
    'run/index': 'packages/dsh-flow/src/run/index.ts',
    'assignments/index': 'packages/dsh-flow/src/assignments/index.ts',
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
