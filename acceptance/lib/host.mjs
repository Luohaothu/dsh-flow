/**
 * Real DSH host process driver for the acceptance runner.
 *
 * Boots the plugin under a real, isolated DSH profile (the same base + cluster
 * patch layers a user would load), then talks to `ctx.flow` over the host's own
 * IPC channel. The runner never guesses control commands from model text and
 * never runs a second scheduler.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LAUNCHER = join(PROJECT_ROOT, 'acceptance/lib/dsh-launch.mjs');

/**
 * The only ambient variables an acceptance host inherits. Everything else —
 * including every provider credential, the operator's `FLOW_*` routing and any
 * proxy variable — is dropped rather than blacklisted, so a new credential name
 * cannot silently leak into an isolated run.
 */
export const HOST_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'PNPM_HOME', 'DSH_INSTALL_PATH'];

/** Runner-owned keys a case may never override. */
export const RUNNER_ENV_KEYS = [
  'HOME', 'TMPDIR', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'NODE_NO_WARNINGS',
  'FLOW_IPC', 'FLOW_DATA_DIR', 'FLOW_WORKSPACE', 'FLOW_QWEN_BASE_URL',
  'FLOW_QWEN_MODEL', 'FLOW_MODEL_PROVIDER', 'FLOW_MODEL_API_KEY',
];

export const CASE_ENV_KEYS = [
  'FLOW_CONTEXT_ROLE', 'FLOW_CONTEXT_WORKER', 'FLOW_CONTEXT_MODEL',
  'FLOW_CONTEXT_TRIGGER', 'FLOW_CONTEXT_SERVER_INPUT',
];

export function inheritEnv(source = process.env) {
  const env = {};
  for (const key of HOST_ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export function buildHostEnv({ home, tmpdir, dataDir, workspace, modelRoute, modelApiKey, extra = {} }) {
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
  #logStream = null;

  constructor({ profile, patch, patches, cwd, env, logPath, readyTimeoutMs = 120_000 }) {
    const patchList = patches ?? (patch ? [patch] : []);
    Object.assign(this, { profile, patches: patchList, cwd, env, logPath, readyTimeoutMs });
    this.pending = new Map();
    this.stdout = '';
    this.stderr = '';
    this.ready = false;
    this.webUrl = null;
    this.child = null;
    this.stdoutWaiters = [];
  }

  async start({ fromDefaultProfile } = {}) {
    mkdirSync(this.cwd, { recursive: true });
    const args = [LAUNCHER, '--profile', this.profile];
    if (fromDefaultProfile) args.push('--from-default-profile', fromDefaultProfile);
    for (const patch of this.patches) args.push('--patch', patch);
    args.push('--host', '127.0.0.1', '--port', '0', '--no-open');
    this.child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.#logStream = createWriteStream(this.logPath, { flags: 'a' });
    this.child.stdout.on('data', chunk => {
      this.stdout += chunk;
      this.#logStream?.write(chunk);
      const match = /dsh web: (http:\/\/\S+)/u.exec(this.stdout);
      if (match) this.webUrl = match[1];
      this.#flush();
    });
    this.child.stderr.on('data', chunk => { this.stderr += chunk; this.#logStream?.write(chunk); });
    this.child.on('message', message => {
      if (!message || message.flow !== true) return;
      if (message.ready === true) {
        this.ready = true;
        this.#flush();
        return;
      }
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      this.pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(Object.assign(new Error(message.error?.message ?? 'flow op failed'), { status: message.error?.status, code: message.error?.code }));
    });
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.#logStream?.end();
      for (const [, entry] of this.pending) entry.reject(new Error(`host exited (code=${code} signal=${signal}) before answering`));
      this.pending.clear();
      this.#flush();
    });
    await this.waitFor(() => this.ready, this.readyTimeoutMs, 'dsh-flow plugin readiness');
    return this;
  }

  async waitForWebUrl(timeoutMs = 120_000) {
    await this.waitFor(() => this.webUrl, timeoutMs, 'web URL');
    return this.webUrl;
  }

  waitFor(predicate, timeoutMs, label) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const index = this.stdoutWaiters.indexOf(waiter);
        if (index >= 0) this.stdoutWaiters.splice(index, 1);
        rejectPromise(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = () => {
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

  #flush() {
    for (const waiter of [...this.stdoutWaiters]) waiter();
  }

  request(op, id, payload, timeoutMs = 3_600_000) {
    if (!this.child?.connected) return Promise.reject(new Error('host is not running'));
    const deadlineMs = Number(timeoutMs);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError(`invalid timeoutMs: ${String(timeoutMs)}`);
    const requestId = randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectPromise(new Error(`flow op ${op} timed out after ${deadlineMs}ms`));
      }, deadlineMs);
      this.pending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolvePromise(value); },
        reject: error => { clearTimeout(timer); rejectPromise(error); },
      });
      // `requestId` is the envelope correlation id; the cluster id travels
      // separately, or it would overwrite the correlation id and the reply
      // would never match this request.
      this.child.send({
        flow: true,
        requestId,
        op,
        ...(id === undefined ? {} : { cluster: id }),
        ...(payload === undefined ? {} : { payload }),
      });
    });
  }

  async stop({ signal = 'SIGTERM', graceMs = 15_000 } = {}) {
    if (!this.child || this.exitInfo) return this.exitInfo ?? null;
    const exited = new Promise(resolvePromise => this.child.once('exit', resolvePromise));
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
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
export function createRunLayout(artifactsRoot, runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId) || runId.includes('..')) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
  const root = join(artifactsRoot, runId);
  const layout = {
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
    if (error?.code === 'EEXIST') throw new Error(`run directory already exists: ${root}`);
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
export const PROFILE_PROVIDER_PACKAGES = [
  ['@deepseek-ai/dsh-browser-use', 'packages/browser-use/browser-use'],
  ['@deepseek-ai/dsh-experimental-browser-use-runtime', 'packages/experimental/browser-use-runtime'],
  ['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', 'packages/experimental/browser-use-playwright-mcp'],
];

export function ensureProfile(home, profile, { bundles, packagePath = PROJECT_ROOT, providers = PROFILE_PROVIDER_PACKAGES } = {}) {
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

  const harnessRoot = dirname(dirname(resolve(process.env.DSH_INSTALL_PATH ?? '/home/leo/projects/deepseek-harness/apps/cli')));
  const linked = [];
  for (const [name, relative] of providers ?? []) {
    const target = join(harnessRoot, relative);
    if (!existsSync(join(target, 'package.json'))) continue;
    const destination = join(nodeModules, ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(target, destination, 'dir');
    linked.push(name);
  }
  return { dir, manifestPath, link, linked };
}

/** Bundle list of the shipped `web` profile template. */
export const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

export { PROJECT_ROOT, LAUNCHER };