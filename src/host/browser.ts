/** Explicit browser selection shared by browser-based acceptance checks. */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { BrowserType } from 'playwright';

/** The part of the Playwright module the acceptance checks drive. */
export interface PlaywrightModule {
  readonly chromium: BrowserType;
}

/**
 * The Chromium binary a check must use, from `FLOW_CHROMIUM_PATH`.
 *
 * `undefined` means "let Playwright choose its own managed installation"; an
 * explicitly set value that is not an absolute, existing, executable file is a
 * configuration error rather than a silent fallback.
 */
export function browserExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.FLOW_CHROMIUM_PATH;
  if (path === undefined) return undefined; // Playwright-managed installation.
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('FLOW_CHROMIUM_PATH must be an absolute executable path');
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`FLOW_CHROMIUM_PATH is not an executable file: ${path}`, { cause: error });
  }
  return path;
}

/**
 * The first installed Playwright module, or `null` when neither package loads.
 * The packages are optional: their absence is reported as an environment
 * limitation, never as a check failure.
 */
export async function importPlaywright(): Promise<PlaywrightModule | null> {
  for (const candidate of ['playwright', 'playwright-core']) {
    try {
      const loaded: unknown = await import(candidate);
      const api = moduleApi(loaded);
      const chromium = api && typeof api === 'object' && 'chromium' in api ? api.chromium : undefined;
      if (isBrowserType(chromium)) return { chromium };
    } catch {
      // Optional dependencies: the checker reports unavailable if neither loads.
    }
  }
  return null;
}

/** The module object, or its default export, exactly as the original probe chose. */
function moduleApi(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    if ('chromium' in value && value.chromium) return value;
    if ('default' in value) return value.default;
  }
  return undefined;
}

/** Narrow an unknown export to Playwright's own browser launcher type. */
function isBrowserType(value: unknown): value is BrowserType {
  return typeof value === 'object' && value !== null && 'launch' in value && typeof value.launch === 'function';
}