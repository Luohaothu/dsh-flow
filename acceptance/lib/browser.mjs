/** Explicit browser selection shared by browser-based acceptance checks. */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function browserExecutablePath(env = process.env) {
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

export async function importPlaywright() {
  for (const candidate of ['playwright', 'playwright-core']) {
    try {
      const loaded = await import(candidate);
      const api = loaded.chromium ? loaded : loaded.default;
      if (api?.chromium?.launch) return api;
    } catch {
      // Optional dependencies: the checker reports unavailable if neither loads.
    }
  }
  return null;
}
