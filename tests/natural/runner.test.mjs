import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const source = fileURLToPath(new URL('./run.mjs', import.meta.url));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

async function fixture(t, body, preexisting = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flow-runner-')));
  const runner = join(root, 'tests/natural/run.mjs');
  const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const home = join(root, '.artifacts/home');
  const proof = join(root, '.artifacts/proof');
  const scenario = join(root, '.artifacts/scenario.json');
  for (const path of [dirname(runner), dirname(cli), join(home, 'profiles/web'), proof]) await mkdir(path, { recursive: true });
  await copyFile(source, runner);
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: { 'dsh-flow': '0.1.0' }, dsh: { profile: { bundles: ['dsh-flow'] } } }));
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '[]\n');
  await writeFile(scenario, JSON.stringify({ maxDurationMs: 1000 }));
  await writeFile(cli, `const fs = require('node:fs');\nconst { join } = require('node:path');\nconst proof = process.env.NATURAL_PROOF_DIR;\nfs.writeFileSync(join(proof, 'host.json'), JSON.stringify({ pid: process.pid }));\n${body}\n`);
  for (const [name, content] of Object.entries(preexisting)) await writeFile(join(proof, name), content);
  const child = spawn(process.execPath, [runner], { cwd: root, env: { ...process.env, DSH_HOME: home, NATURAL_SCENARIO_FILE: scenario, NATURAL_PROOF_DIR: proof, NATURAL_PROFILE_NAME: 'web', NATURAL_UI_HOLD_MS: '0' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => {
    for (const name of ['host.json', 'descendant.json']) {
      try {
        const { pid } = JSON.parse(await readFile(join(proof, name), 'utf8'));
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
    await rm(root, { recursive: true, force: true });
  });
  return { child, ended, proof, output: () => output };
}

async function completed(fixture) {
  let timer;
  try {
    return await Promise.race([fixture.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runner did not close its owned process pipes')), 4000); })]);
  } finally { clearTimeout(timer); }
}

async function stopped(pid) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await pause(20);
  assert.equal(alive(pid), false, `Owned process ${pid} must no longer exist`);
}

test('runner closes inherited stdio and terminates a descendant after the CLI exits', { skip: process.platform === 'win32', timeout: 7000 }, async t => {
  const f = await fixture(t, `
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(process.env.NATURAL_PROOF_DIR,'descendant.json'),JSON.stringify({pid:process.pid}));console.log('descendant ready');setInterval(()=>{},1000)"], { stdio: 'inherit' });
descendant.unref();
const ready = setInterval(() => { if (fs.existsSync(join(proof, 'descendant.json'))) { clearInterval(ready); process.exit(0); } }, 10);
`);
  const code = await completed(f);
  assert.equal(code, 1, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(receipt.runnerReason, 'host-exited-before-runner-stop');
  assert.equal(receipt.runnerOwnedStop, true);
  assert.equal(receipt.forced, false);
  const descendant = JSON.parse(await readFile(join(f.proof, 'descendant.json'), 'utf8'));
  await stopped(descendant.pid);
  await stopped(receipt.pid);
});

test('runner settles and stops its live CLI without forcing termination', { timeout: 7000 }, async t => {
  const f = await fixture(t, `
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(join(proof, 'evidence.json'), JSON.stringify({ status: 'SETTLED', reason: 'plain-main-ended', requests: [] }));
setInterval(() => {}, 1000);
`);
  const code = await completed(f);
  assert.equal(code, 0, f.output());
  const receipt = JSON.parse(await readFile(join(f.proof, 'process.json'), 'utf8'));
  assert.equal(receipt.observerStatus, 'SETTLED');
  assert.equal(receipt.runnerReason, 'observer-settled');
  assert.equal(receipt.runnerOwnedStop, true);
  assert.equal(receipt.forced, false);
  await stopped(receipt.pid);
});


test('runner rejects a stale operator finish request before launching the host', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);', { 'finish-request.json': JSON.stringify({ sessionId: 'old-main', afterUserSeq: 1 }) });
  assert.equal(await completed(f), 1, f.output());
  assert.equal(JSON.parse(f.output().trim()).errorCode, 'ERR_ASSERTION');
  await assert.rejects(readFile(join(f.proof, 'host.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.proof, 'process.json')), { code: 'ENOENT' });
});
