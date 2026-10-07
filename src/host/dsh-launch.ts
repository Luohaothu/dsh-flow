#!/usr/bin/env node
/**
 * Launch the DSH profile app in-process.
 *
 * Invoke the installed CLI's exported `runCli` with the process argv. This
 * supports Node runtimes that do not provide `import.meta.main`.
 *
 * Usage: node --import tsx src/host/dsh-launch.ts --profile <name> [--patch <file>] <app args>
 * Environment: DSH_INSTALL_PATH optionally identifies the installed CLI package.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The one export this launcher calls from the installed CLI bundle. */
interface DshCliModule {
  runCli(): unknown;
}

const require = createRequire(import.meta.url);
const installPath = process.env.DSH_INSTALL_PATH
  ? resolve(process.env.DSH_INSTALL_PATH)
  : dirname(require.resolve('@deepseek-ai/dsh/package.json'));
const bin = join(installPath, 'lib/bin.js');
if (!existsSync(bin)) {
  console.error(`dsh-launch: no built DSH launcher at ${bin}`);
  process.exit(1);
}

// The module specifier is the installed CLI's own build output, so it can only
// be resolved at run time; the imported value is `unknown` until checked.
const loaded: unknown = await import(pathToFileURL(bin).href);
await runCliOf(loaded)();

/** The installed bundle's `runCli`, checked before it is called. */
function runCliOf(loadedModule: unknown): DshCliModule['runCli'] {
  if (typeof loadedModule === 'object' && loadedModule !== null && 'runCli' in loadedModule) {
    const runCli = loadedModule.runCli;
    if (typeof runCli === 'function') return runCli as DshCliModule['runCli'];
  }
  throw new TypeError(`dsh-launch: ${bin} does not export runCli()`);
}