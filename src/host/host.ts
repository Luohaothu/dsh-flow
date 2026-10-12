/** Isolated normal DSH web profiles for integration tests. No Flow execution driver. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const PLUGIN_ROOT = join(PROJECT_ROOT, 'packages/dsh-flow');
export const LAUNCHER = join(PROJECT_ROOT, 'src/host/dsh-launch.ts');
export interface RunLayout { root: string; home: string; tmp: string; data: string; workspace: string; artifacts: string; logs: string }
export interface HostModelRoute { baseURL: string; model: string; provider: string }
export interface HostEnvInput {
  home: string; tmpdir: string; dataDir: string; workspace: string;
  modelRoute?: HostModelRoute; modelApiKey?: string;
  /** Explicitly selected provider credential references or proxy settings, never ambient inheritance. */
  extra?: Readonly<Record<string, string>>;
}
export interface EnsureProfileOptions {
  bundles?: readonly string[]; packagePath?: string;
  providers?: ReadonlyArray<readonly [string, string]>; installPath?: string;
}
export interface EnsureProfileResult { dir: string; manifestPath: string; link: string; linked: string[] }
export const HOST_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'PNPM_HOME', 'DSH_INSTALL_PATH', 'FLOW_CHROMIUM_PATH'] as const;
export function inheritEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(HOST_ENV_ALLOWLIST.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]));
}
export function buildHostEnv(input: HostEnvInput): Record<string, string | undefined> {
  const route = input.modelRoute;
  return {
    ...inheritEnv(), ...input.extra,
    HOME: input.home, TMPDIR: input.tmpdir, DSH_HOME: input.home,
    DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1',
    FLOW_DATA_DIR: input.dataDir, FLOW_WORKSPACE: input.workspace,
    ...(route ? { FLOW_QWEN_BASE_URL: route.baseURL, FLOW_QWEN_MODEL: route.model, FLOW_MODEL_PROVIDER: route.provider } : {}),
    ...(input.modelApiKey ? { FLOW_MODEL_API_KEY: input.modelApiKey } : {}),
  };
}
export function createRunLayout(artifactsRoot: string, runId: unknown): RunLayout {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId) || runId.includes('..')) throw new Error('Invalid run id');
  const root = join(artifactsRoot, runId);
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root); // An existing run is evidence, never a reusable scratch directory.
  const layout = { root, home: join(root, 'home'), tmp: join(root, 'tmp'), data: join(root, 'data'), workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), logs: join(root, 'logs') };
  for (const dir of Object.values(layout)) mkdirSync(dir, { recursive: true });
  return layout;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object');
  return value as Record<string, unknown>;
}
export function sanitizeLog(text: string): string {
  return text.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}
export interface DshWebOptions { profile: string; patches: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string; readyTimeoutMs?: number }
/** Uses the public HTTP RPC envelope, the same native app and profile as a browser. */
export class DshWebHost {
  child: ChildProcess | null = null;
  origin: string | null = null;
  #cookie = '';
  #closed: Promise<void> = Promise.resolve();
  constructor(readonly options: DshWebOptions) {}
  async start(): Promise<this> {
    if (this.child) throw new Error('Host is already started');
    const args = ['--import', import.meta.resolve('tsx'), LAUNCHER, '--profile', this.options.profile];
    for (const patch of this.options.patches) args.push('--patch', patch);
    args.push('--host', '127.0.0.1', '--port', '0', '--no-open');
    const child = spawn(process.execPath, args, { cwd: this.options.cwd, env: this.options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.#closed = new Promise(resolve => child.once('close', () => resolve()));
    let output = '';
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native web startup timed out; inspect redacted log')), this.options.readyTimeoutMs ?? 60_000);
        const collect = (chunk: string) => {
          output += chunk; writeFileSync(this.options.logPath, sanitizeLog(output));
          const match = /dsh web: (http:\/\/\S+)/u.exec(output);
          if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
        };
        child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
        child.stdout!.on('data', collect); child.stderr!.on('data', collect);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', () => { clearTimeout(timer); reject(new Error('Native web exited before readiness')); });
      });
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      this.#cookie = response.headers.getSetCookie().map(header => header.split(';')[0]).join('; ');
      if (!this.#cookie) throw new Error('Native web authentication did not issue a cookie');
      this.origin = new URL(url).origin;
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async rpc(method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.origin) throw new Error('Host is not started');
    const response = await fetch(`${this.origin}/api/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.#cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const envelope = object(await response.json());
    const result = object(envelope.result);
    if (!result.ok) throw new Error(`Native RPC ${method} failed: ${sanitizeLog(JSON.stringify(result))}`);
    return result.value;
  }
  /** Give an isolated test browser the already authenticated Host cookie without exposing it. */
  async authenticateBrowser(context: { addCookies(cookies: {name:string;value:string;url:string}[]): Promise<void> }): Promise<void> {
    if (!this.origin) throw new Error('Host is not started');
    await context.addCookies(this.#cookie.split('; ').map(pair => {
      const split = pair.indexOf('=');
      return {name:pair.slice(0,split),value:pair.slice(split+1),url:this.origin!};
    }));
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000);
    await this.#closed;
    clearTimeout(kill); this.child = null; this.origin = null; this.#cookie = '';
  }
}
export const PROFILE_PROVIDER_PACKAGES: ReadonlyArray<readonly [name: string, path: string]> = [
  ['@deepseek-ai/dsh-browser-use', 'packages/browser-use/browser-use'],
  ['@deepseek-ai/dsh-experimental-browser-use-runtime', 'packages/experimental/browser-use-runtime'],
  ['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', 'packages/experimental/browser-use-playwright-mcp'],
];

export function ensureProfile(home: string, profile: string, {
  bundles, packagePath = PLUGIN_ROOT, providers = PROFILE_PROVIDER_PACKAGES,
  installPath = process.env.DSH_INSTALL_PATH,
}: EnsureProfileOptions = {}): EnsureProfileResult {
  const dir = join(home, 'profiles', profile);
  const manifestPath = join(dir, 'package.json');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: bundles?.includes('dsh-flow') ? {'dsh-flow':`link:${resolve(packagePath)}`} : {},
      dsh: { profile: { bundles: [...(bundles ?? [])] } },
    }, undefined, 2)}\n`);
  }
  const nodeModules = join(dir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  const link = join(nodeModules, 'dsh-flow');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(packagePath, link, 'dir');

  const harnessRoot = installPath ? dirname(dirname(resolve(installPath))) : null;
  const resolvers = [packagePath, ...(installPath ? [installPath] : [])]
    .map(root => createRequire(join(resolve(root), 'package.json')));
  const linked: string[] = [];
  for (const [name, relative] of providers ?? []) {
    // A source checkout and a published npm installation have different
    // layouts. Preserve an explicitly selected monorepo's packages, then use
    // normal Node resolution from the plugin and the chosen DSH installation.
    let target: string | null = harnessRoot ? join(harnessRoot, relative) : null;
    if (!target || !existsSync(join(target, 'package.json'))) {
      target = null;
      for (const require of resolvers) {
        try {
          target = dirname(require.resolve(`${name}/package.json`));
          break;
        } catch (error) {
          const code = errorCodeOf(error);
          if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        }
      }
    }
    if (!target) continue;
    const destination = join(nodeModules, ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(target, destination, 'dir');
    linked.push(name);
  }
  return { dir, manifestPath, link, linked };
}

/** Bundle list of the shipped `web` profile template. */
export const WEB_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

function errorCodeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
}
