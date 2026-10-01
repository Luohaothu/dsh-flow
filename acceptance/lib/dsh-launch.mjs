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
 * Usage: node acceptance/lib/dsh-launch.mjs --profile <name> [--patch <file>] <app args>
 * Environment: DSH_INSTALL_PATH points at the harness apps/cli directory.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const installPath = resolve(process.env.DSH_INSTALL_PATH ?? '/home/leo/projects/deepseek-harness/apps/cli');
const bin = join(installPath, 'lib/bin.js');
if (!existsSync(bin)) {
  console.error(`dsh-launch: no built DSH launcher at ${bin}`);
  process.exit(1);
}

const { runCli } = await import(bin);
await runCli();