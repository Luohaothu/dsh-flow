/**
 * Real DSH host process driver for the acceptance runner.
 *
 * Boots the plugin under a real, isolated DSH profile (the same base + cluster
 * patch layers a user would load), then talks to `ctx.flow` over the host's own
 * IPC channel. The runner never guesses control commands from model text and
 * never runs a second scheduler.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, Serializable } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DshHostOp,
  DshIpcFailure,
  DshIpcReady,
  DshIpcReply,
  DshIpcRequest,
  RunLayout,
} from './types.ts';

export type {
  DshHostOp,
  DshIpcFailure,
  DshIpcOutbound,
  DshIpcReady,
  DshIpcReply,
  DshIpcRequest,
  RunLayout,
} from './types.ts';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * The installable plugin package inside this workspace.
 *
 * A profile row named `dsh-flow` resolves through the profile's own
 * `node_modules`, so the link has to point at the *package* (`packages/dsh-flow`)
 * and not at the private workspace root — a link to the root resolves a package
 * that has no `main`/`exports` for that name and the row fails to import.
 */
export const PLUGIN_ROOT = join(PROJECT_ROOT, 'packages', 'dsh-flow');
const LAUNCHER = join(PROJECT_ROOT, 'src/host/dsh-launch.ts');

/**
 * The only ambient variables an acceptance host inherits. Everything else —
 * including every provider credential, the operator's `FLOW_*` routing and any
 * proxy variable — is dropped rather than blacklisted, so a new credential name
 * cannot silently leak into an isolated run.
 */
export const HOST_ENV_ALLOWLIST: readonly string[] = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'PNPM_HOME', 'DSH_INSTALL_PATH', 'FLOW_CHROMIUM_PATH'];

/** Runner-owned keys a case may never override. */
export const RUNNER_ENV_KEYS: readonly string[] = [
  'HOME', 'TMPDIR', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'NODE_NO_WARNINGS',
  'FLOW_IPC', 'FLOW_DATA_DIR', 'FLOW_WORKSPACE', 'FLOW_QWEN_BASE_URL',
  'FLOW_QWEN_MODEL', 'FLOW_MODEL_PROVIDER', 'FLOW_MODEL_API_KEY',
];

export const CASE_ENV_KEYS: readonly string[] = [
  'FLOW_CONTEXT_ROLE', 'FLOW_CONTEXT_WORKER', 'FLOW_CONTEXT_MODEL',
  'FLOW_CONTEXT_TRIGGER', 'FLOW_CONTEXT_SERVER_INPUT',
];

/** Where an acceptance host runs and what it points at. */
export interface DshHostOptions {
  readonly profile: string;
  readonly patch?: string | undefined;
  readonly patches?: readonly string[] | undefined;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly logPath: string;
  readonly readyTimeoutMs?: number | undefined;
}

/** How to boot the host process. */
export interface DshHostStartOptions {
  readonly fromDefaultProfile?: string | undefined;
}

/** How to stop the host process. */
export interface DshHostStopOptions {
  readonly signal?: NodeJS.Signals;
  readonly graceMs?: number;
}

/** How the host process ended, when it has. */
export interface DshExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One in-flight IPC request awaiting its reply. */
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** The explicit model route a run's environment describes. */
export interface HostModelRoute {
  readonly baseURL: string;
  readonly model: string;
  readonly provider: string;
}

/** The inputs of one isolated host environment. */
export interface HostEnvInput {
  readonly home: string;
  readonly tmpdir: string;
  readonly dataDir: string;
  readonly workspace: string;
  readonly modelRoute: HostModelRoute;
  readonly modelApiKey?: string | undefined;
  readonly extra?: Readonly<Record<string, string>>;
}

/** How one isolated profile is created. */
export interface EnsureProfileOptions {
  readonly bundles?: readonly string[];
  readonly packagePath?: string;
  readonly providers?: ReadonlyArray<readonly [string, string]>;
  readonly installPath?: string | undefined;
}

/** What one isolated profile creation produced. */
export interface EnsureProfileResult {
  readonly dir: string;
  readonly manifestPath: string;
  readonly link: string;
  readonly linked: string[];
}

/** The allowlisted slice of the operator's environment. */
export function inheritEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildHostEnv({ home, tmpdir, dataDir, workspace, modelRoute, modelApiKey, extra = {} }: HostEnvInput): Record<string, string | undefined> {
  return {
    ...inheritEnv(),
    // Case values are restricted twice: validateCaseEnv checks the fixture
    // before the run, and this host boundary ignores any unexpected key.
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => CASE_ENV_KEYS.includes(key))),
    HOME: home,
    TMPDIR: tmpdir,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    FLOW_IPC: '1',
    FLOW_DATA_DIR: dataDir,
    FLOW_WORKSPACE: workspace,
    FLOW_QWEN_BASE_URL: modelRoute.baseURL,
    FLOW_QWEN_MODEL: modelRoute.model,
    FLOW_MODEL_PROVIDER: modelRoute.provider,
    ...(modelApiKey ? { FLOW_MODEL_API_KEY: modelApiKey } : {}),
  };
}

export class DshHost {
  readonly profile: string;
  readonly patches: string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly logPath: string;
  readonly readyTimeoutMs: number;
  readonly pending = new Map<string, PendingRequest>();
  readonly stdoutWaiters: Array<() => boolean> = [];
  stdout = '';
  stderr = '';
  ready = false;
  webUrl: string | null = null;
  exitInfo: DshExitInfo | undefined;
  child: ChildProcess | null = null;
  #logStream: WriteStream | null = null;

  constructor(options: DshHostOptions) {
    const patchList = options.patches ?? (options.patch ? [options.patch] : []);
    this.profile = options.profile;
    this.patches = [...patchList];
    this.cwd = options.cwd;
    this.env = options.env;
    this.logPath = options.logPath;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  }

  async start(options: DshHostStartOptions = {}): Promise<this> {
    mkdirSync(this.cwd, { recursive: true });
    // The launcher is TypeScript, and the dev chain runs under tsx rather than
    // Node's strip-types mode (which cannot handle decorators or JSX and is not
    // the delivery mechanism this migration chose). The preload is an absolute
    // URL: the child starts in an isolated cwd with a whitelisted environment,
    // so it cannot resolve `tsx` by itself.
    const args = ['--import', import.meta.resolve('tsx'), LAUNCHER, '--profile', this.profile];
    if (options.fromDefaultProfile) args.push('--from-default-profile', options.fromDefaultProfile);
    for (const patch of this.patches) args.push('--patch', patch);
    args.push('--host', '127.0.0.1', '--port', '0', '--no-open');
    const child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    const { stdout, stderr } = child;
    if (!stdout || !stderr) throw new Error('dsh host child was spawned without stdio pipes');
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    this.#logStream = createWriteStream(this.logPath, { flags: 'a' });
    stdout.on('data', (chunk: string) => {
      this.stdout += chunk;
      this.#logStream?.write(chunk);
      const match = /dsh web: (http:\/\/\S+)/u.exec(this.stdout);
      const url = match?.[1];
      if (url) this.webUrl = url;
      this.#flush();
    });
    stderr.on('data', (chunk: string) => { this.stderr += chunk; this.#logStream?.write(chunk); });
    child.on('message', (raw: unknown) => {
      const message = asInbound(raw);
      if (!message) return;
      if ('ready' in message) {
        this.ready = true;
        this.#flush();
        return;
      }
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      this.pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(Object.assign(new Error(message.error.message ?? 'flow op failed'), { status: message.error.status, code: message.error.code }));
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.#logStream?.end();
      for (const [, entry] of this.pending) entry.reject(new Error(`host exited (code=${code} signal=${signal}) before answering`));
      this.pending.clear();
      this.#flush();
    });
    await this.waitFor(() => this.ready, this.readyTimeoutMs, 'dsh-flow plugin readiness');
    return this;
  }

  async waitForWebUrl(timeoutMs = 120_000): Promise<string> {
    await this.waitFor(() => this.webUrl !== null, timeoutMs, 'web URL');
    const webUrl = this.webUrl;
    if (webUrl === null) throw new Error('web URL became unavailable while waiting');
    return webUrl;
  }

  waitFor(predicate: () => unknown, timeoutMs: number, label: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const index = this.stdoutWaiters.indexOf(waiter);
        if (index >= 0) this.stdoutWaiters.splice(index, 1);
        rejectPromise(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (): boolean => {
        if (!predicate()) return false;
        clearTimeout(timer);
        const index = this.stdoutWaiters.indexOf(waiter);
        if (index >= 0) this.stdoutWaiters.splice(index, 1);
        resolvePromise();
        return true;
      };
      this.stdoutWaiters.push(waiter);
      this.#flush();
    });
  }

  #flush(): void {
    for (const waiter of [...this.stdoutWaiters]) waiter();
  }

  request(op: DshHostOp, id: string | undefined, payload?: unknown, timeoutMs = 3_600_000): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('host is not running'));
    const deadlineMs = Number(timeoutMs);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError(`invalid timeoutMs: ${String(timeoutMs)}`);
    const requestId = randomUUID();
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectPromise(new Error(`flow op ${op} timed out after ${deadlineMs}ms`));
      }, deadlineMs);
      this.pending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolvePromise(value); },
        reject: error => { clearTimeout(timer); rejectPromise(error); },
      });
      // The payload is built by this runner out of JSON request shapes; the
      // child-process channel performs the actual structured-clone serialization,
      // which is the runtime check on it.
      const envelope: DshIpcRequest = {
        flow: true,
        requestId,
        op,
        ...(id === undefined ? {} : { cluster: id }),
        ...(payload === undefined ? {} : { payload: payload as Serializable }),
      };
      child.send(envelope);
    });
  }

  async stop(options: DshHostStopOptions = {}): Promise<DshExitInfo | null> {
    const { signal = 'SIGTERM', graceMs = 15_000 } = options;
    const child = this.child;
    if (!child || this.exitInfo) return this.exitInfo ?? null;
    const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, graceMs);
    await exited;
    clearTimeout(timer);
    return this.exitInfo ?? null;
  }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Create one run's directories, exclusively. A run id is either brand new or
 * the call fails: reusing a run directory would let a previous run's SQLite
 * database and reports masquerade as this run's evidence.
 */
export function createRunLayout(artifactsRoot: string, runId: unknown): RunLayout {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId) || runId.includes('..')) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
  const root = join(artifactsRoot, runId);
  const layout: RunLayout = {
    root,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    data: join(root, 'data'),
    workspace: join(root, 'workspace'),
    artifacts: join(root, 'artifacts'),
    logs: join(root, 'logs'),
  };
  mkdirSync(dirname(root), { recursive: true });
  try {
    mkdirSync(root, { recursive: false });
  } catch (error) {
    if (errorCodeOf(error) === 'EEXIST') throw new Error(`run directory already exists: ${root}`);
    throw error;
  }
  for (const dir of Object.values(layout)) mkdirSync(dir, { recursive: true });
  return layout;
}

/**
 * Create one isolated custom profile deterministically: the shipped template's
 * bundle list plus a link to this project, so the plugin resolves exactly like
 * a profile-installed bundle without touching the user's own profiles.
 */
/**
 * Provider packages a case's patch names by bare specifier. DSH resolves a
 * profile row through the installation and then the profile's own
 * `node_modules`, so a provider the installation does not depend on has to be
 * linked where the profile row can see it.
 */
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
      dependencies: {},
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

/** Narrow one inbound channel message to the envelopes this driver understands. */
function asInbound(value: unknown): DshIpcReady | DshIpcReply | DshIpcFailure | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('flow' in value) || value.flow !== true) return null;
  if ('ready' in value && value.ready === true) return { flow: true, ready: true };
  if (!('requestId' in value) || typeof value.requestId !== 'string') return null;
  if (!('ok' in value) || typeof value.ok !== 'boolean') return null;
  if (value.ok) {
    return { flow: true, requestId: value.requestId, ok: true, result: 'result' in value ? value.result : undefined };
  }
  return { flow: true, requestId: value.requestId, ok: false, error: errorFields('error' in value ? value.error : undefined) };
}

/** The `{message,status,code}` fields of a failure envelope, as far as they are present. */
function errorFields(value: unknown): { message?: string; status?: number; code?: string } {
  const fields: { message?: string; status?: number; code?: string } = {};
  if (typeof value === 'object' && value !== null) {
    if ('message' in value && typeof value.message === 'string') fields.message = value.message;
    if ('status' in value && typeof value.status === 'number') fields.status = value.status;
    if ('code' in value && typeof value.code === 'string') fields.code = value.code;
  }
  return fields;
}

/** The `code` of a thrown unknown, when it carries a string one. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return null;
}

export { PROJECT_ROOT, LAUNCHER };