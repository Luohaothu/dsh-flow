import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, chmodSync, closeSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentsHome } from './isolation.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const artifacts = join(root, '.artifacts');
const terminal = new Set(['SETTLED', 'ABORTED', 'ERROR']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function privatePath(input, kind, create = false) {
  assert.equal(typeof input, 'string', 'A private path is required');
  const target = resolve(input), child = relative(artifacts, target);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), 'Private paths must stay below this workspace .artifacts');
  let current = artifacts;
  for (const part of ['', ...child.split(sep)]) {
    if (part) current = join(current, part);
    let state;
    try { state = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      mkdirSync(current, { mode: 0o700 });
      state = lstatSync(current);
    }
    assert.ok(!state.isSymbolicLink(), 'Private paths cannot contain symlinks');
    assert.ok(current === target && kind === 'file' ? state.isFile() : state.isDirectory(), 'Private path has the wrong type');
  }
  assert.equal(realpathSync(target), target, 'Private path escaped its directory');
  return target;
}

function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function writer(directory) {
  const allowed = new Set(['cli.log', 'launch-url.txt', 'process.json']);
  return (name, content, append = false) => {
    assert.ok(allowed.has(name), 'Unknown runner output');
    privatePath(directory, 'directory');
    const path = join(directory, name);
    if (exists(path)) privatePath(path, 'file');
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0), 0o600);
    try {
      privatePath(directory, 'directory');
      const opened = fstatSync(fd), current = lstatSync(path);
      assert.ok(opened.isFile() && !current.isSymbolicLink() && opened.dev === current.dev && opened.ino === current.ino, 'Runner output identity changed');
      fchmodSync(fd, 0o600);
      if (!append) ftruncateSync(fd, 0);
      writeFileSync(fd, content);
    } finally { closeSync(fd); }
  };
}

function readEvidence(directory) {
  const path = join(directory, 'evidence.json');
  if (!exists(path)) return;
  privatePath(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), current = lstatSync(path);
    assert.ok(opened.isFile() && opened.dev === current.dev && opened.ino === current.ino, 'Observer evidence identity changed');
    try { return JSON.parse(readFileSync(fd, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
  } finally { closeSync(fd); }
}

async function run() {
  const home = privatePath(process.env.DSH_HOME, 'directory');
  const agentsHome = assertAgentsHome(process.env.DSH_AGENTS_HOME, home, artifacts);
  const scenarioFile = privatePath(process.env.NATURAL_SCENARIO_FILE, 'file');
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
  assert.ok(Number.isSafeInteger(scenario.maxDurationMs) && scenario.maxDurationMs > 0 && scenario.maxDurationMs <= 2_147_453_647, 'Scenario duration must be a positive bounded integer');
  assert.ok(!process.env.NATURAL_PROFILE_NAME || process.env.NATURAL_PROFILE_NAME === 'web', 'This runner requires the web profile');
  const port = Number(process.env.NATURAL_PORT ?? 3191);
  const holdMs = Number(process.env.NATURAL_UI_HOLD_MS ?? 0);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Port must be an integer from 1 through 65535');
  assert.ok(Number.isSafeInteger(holdMs) && holdMs >= 0, 'UI hold must be a nonnegative integer');
  const profilePath = privatePath(join(home, 'profiles/web/package.json'), 'file');
  privatePath(join(home, 'profiles/web/cordis.patch.yml'), 'file');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.ok(profile.dependencies?.['dsh-flow'] && profile.dsh?.profile?.bundles?.includes('dsh-flow'), 'Install Flow through the official plugin manager first');
  const proof = privatePath(process.env.NATURAL_PROOF_DIR, 'directory', true);
  for (const name of ['evidence.json', 'shutdown-evidence.json', 'cli.log', 'launch-url.txt', 'process.json', 'ui-ack']) assert.ok(!exists(join(proof, name)), 'Use a fresh proof directory for every run');
  chmodSync(proof, 0o700);
  const write = writer(proof);
  const startedAt = Date.now(), stopDeadline = startedAt + scenario.maxDurationMs + 19_000;
  const receipt = { startedAt, observerStatus: null, runnerReason: 'observing', runnerOwnedStop: false, forced: false };
  const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const child = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, NATURAL_PROFILE_NAME: 'web', NATURAL_SCENARIO_FILE: scenarioFile, NATURAL_PROOF_DIR: proof },
  });
  receipt.pid = child.pid;
  let exitState, closed = false, ioError, interrupted, evidence, holdUntil, launchTail = '', launchSaved = false;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { exitState = { code, signal }; });
    child.once('error', error => { exitState = { errorCode: error.code ?? 'SPAWN_ERROR' }; });
    child.once('close', () => { closed = true; resolve(); });
  });
  const signalOwnedProcess = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else if (!exitState) child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    if (closed || receipt.runnerOwnedStop) return;
    receipt.runnerOwnedStop = true;
    receipt.stopRequestedAt = Date.now();
    signalOwnedProcess('SIGINT');
  };
  const receive = chunk => {
    try {
      write('cli.log', chunk, true);
      if (launchSaved) return;
      launchTail = (launchTail + chunk.toString()).slice(-32_768);
      const launch = launchTail.match(/dsh web: (http:\/\/[^\s\u001b]+)(?=[\s\u001b])/)?.[1];
      if (launch) { write('launch-url.txt', launch); launchSaved = true; }
    } catch (error) { ioError = error; stop(); }
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  const interrupt = signal => { interrupted = signal; stop(); };
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    for (;;) {
      if (ioError) { receipt.runnerReason = 'private-output-error'; break; }
      if (interrupted) { receipt.runnerReason = 'runner-interrupted'; break; }
      if (exitState) { receipt.runnerReason = 'host-exited-before-runner-stop'; break; }
      const current = readEvidence(proof);
      if (current) evidence = current;
      if (terminal.has(evidence?.status)) {
        receipt.observerStatus = evidence.status;
        receipt.observerReason = evidence.reason;
        receipt.requests = Array.isArray(evidence.requests) ? evidence.requests.length : null;
        if (evidence.status !== 'SETTLED') { receipt.runnerReason = 'observer-ended-without-settling'; break; }
        holdUntil ??= Math.min(Date.now() + holdMs, stopDeadline);
        if (exists(join(proof, 'ui-ack'))) {
          privatePath(join(proof, 'ui-ack'), 'file');
          receipt.runnerReason = 'observer-settled-ui-ack';
          break;
        }
        if (Date.now() >= holdUntil) { receipt.runnerReason = 'observer-settled'; break; }
      }
      if (Date.now() >= stopDeadline) { receipt.runnerReason = 'runner-duration-limit'; break; }
      await pause(100);
    }
  } catch (error) {
    receipt.runnerReason = 'observation-read-error';
    receipt.errorCode = error.code ?? error.name;
  } finally {
    stop();
    const force = setTimeout(() => {
      if (!closed) { receipt.forced = true; signalOwnedProcess('SIGKILL'); }
    }, 10_000);
    let closeDeadline;
    await Promise.race([exited, new Promise(resolve => { closeDeadline = setTimeout(resolve, 10_500); })]);
    clearTimeout(force);
    clearTimeout(closeDeadline);
    if (!closed) {
      receipt.runnerReason = 'stdio-close-timeout';
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    receipt.exit = exitState;
    receipt.endedAt = Date.now();
    write('process.json', JSON.stringify(receipt, null, 2));
  }
  const stopped = exitState?.code === 0 || exitState?.code === 130 || exitState?.signal === 'SIGINT';
  const settled = receipt.runnerReason.startsWith('observer-settled') && receipt.observerStatus === 'SETTLED' && !receipt.forced && stopped;
  console.log(JSON.stringify({ status: settled ? 'SETTLED' : 'INCOMPLETE', requests: receipt.requests ?? null, exitCode: exitState?.code ?? null, forced: receipt.forced }));
  process.exitCode = settled ? 0 : 1;
}

run().catch(error => {
  console.error(JSON.stringify({ status: 'ERROR', errorCode: error.code ?? error.name }));
  process.exitCode = 1;
});
