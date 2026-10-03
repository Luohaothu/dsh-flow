#!/usr/bin/env node
/**
 * Launch the DSH profile app in-process.
 *
 * The shipped `apps/cli/lib/bin.js` guards its entry point with
 * `import.meta.main`, which Node v24.0.1 does not implement (verified:
 * `typeof import.meta.main === 'undefined'`), so invoking the built bin
 * directly exits silently with status 0. This wrapper imports the exported
 * `runCli` and calls it with the same argv, which is the only difference.
 *
 * Usage: node src/host/dsh-launch.mjs --profile <name> [--patch <file>] <app args>
 * Environment: DSH_INSTALL_PATH points at the harness apps/cli directory.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const installPath = process.env.DSH_INSTALL_PATH
  ? resolve(process.env.DSH_INSTALL_PATH)
  : dirname(require.resolve('@deepseek-ai/dsh/package.json'));
const bin = join(installPath, 'lib/bin.js');
if (!existsSync(bin)) {
  console.error(`dsh-launch: no built DSH launcher at ${bin}`);
  process.exit(1);
}

const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
