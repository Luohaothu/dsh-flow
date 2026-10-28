import assert from 'node:assert/strict';
import { readFile, mkdir, realpath, access, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const require = createRequire(join(root, 'package.json')), { stringify } = require('yaml');
const artifacts = await realpath(join(root, '.artifacts'));
async function privatePath(input, file = false) {
    const target = resolve(input), path = relative(artifacts, target);
    assert.ok(path && !path.startsWith('..') && !path.startsWith('/'), 'Live paths must stay below this project/.artifacts');
    let ancestor = target;
    for (;;) {
        try {
            const state = await lstat(ancestor);
            if (file && ancestor === target) assert.ok(!state.isSymbolicLink(), 'Live files cannot be symlinks');
            break;
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            ancestor = dirname(ancestor);
        }
    }
    const actual = await realpath(ancestor), realRelative = relative(artifacts, actual);
    assert.ok(!realRelative.startsWith('..') && !realRelative.startsWith('/'), 'Live path follows a symlink outside this project/.artifacts');
    return target;
}
async function privateDirectory(input) {
    const target = await privatePath(input);
    await mkdir(target, { recursive: true });
    await privatePath(target);
    return target;
}
async function privateWrite(path, content, options = {}) {
    await privatePath(path, true);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), options.mode ?? 0o644);
    try { if (options.mode) await handle.chmod(options.mode); await handle.writeFile(content); }
    finally { await handle.close(); }
}
const home = await privateDirectory(process.env.P7_LIVE_HOME ?? join(artifacts, 'p7-live/home'));
const proof = await privateDirectory(process.env.P7_PROOF_DIR ?? join(artifacts, 'p7-live/run-' + Date.now()));
const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
for (const path of ['profiles/web/package.json', 'profiles/web/cordis.patch.yml', '.credentials.yaml']) await privatePath(join(home, path), true);
try {
    await access(join(home, 'profiles/web/package.json'));
}
catch {
    execFileSync(process.execPath, [cli, 'web', '--help'], { cwd: root, env: { ...process.env, DSH_HOME: home }, stdio: 'pipe' });
}
const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
assert.ok(profile.dependencies?.['dsh-flow'] && profile.dsh?.profile?.bundles?.includes('dsh-flow'), 'Install the production Flow tgz with the official dsh plugin --profile web add command first');
const key = process.env.P7_LOCAL_LLM;
assert.ok(key, 'Provide the selected local service credential as P7_LOCAL_LLM');
await privateWrite(join(home, '.credentials.yaml'), stringify({ version: 1, refs: { P7_LOCAL_LLM: key } }), { mode: 0o600 });
const model = process.env.P7_LIVE_MODEL ?? 'Qwen3.8-27B-4bit';
const baseURL = process.env.P7_LIVE_BASE_URL ?? 'http://127.0.0.1:8000/v1';
assert.ok(['http:', 'https:'].includes(new URL(baseURL).protocol));
const port = Number(process.env.P7_LIVE_PORT ?? 3090);
assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
const route = { api: 'openai-completions', displayName: 'P7 local model', baseURL, apiKeyEnv: 'P7_LOCAL_LLM', models: [{ id: model, contextWindow: 131072, maxTokens: 1024, input: ['text'], reasoningEfforts: { off: null, low: 'low' } }], compat: { thinkingFormat: 'qwen-chat-template', supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens', chatTemplateKwargs: { enable_thinking: false } }, retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 120000, streamIdleTimeoutMs: 120000 };
const overrides = [{ id: 'hmr', disabled: true }, { id: 'session-title-llm', disabled: true }, { id: 'llm-pi-ai', config: { providers: { 'p7-local': route } } }, { id: 'agent-default-model', config: { provider: 'p7-local', model, reasoningEffort: 'off' } }, { id: 'dsh-flow', configMerge: { stateDirectory: join(proof, 'flow-state'), cwd: home, maxConcurrentAgents: 3, cleanup: { gracefulTimeoutMs: 3000, immediateTimeoutMs: 5000 }, defaults: { model: { provider: 'p7-local', id: model }, params: { version: 1, reasoningEffort: 'off', maxTokens: 1024, temperature: 0 } }, rootRole: 'Manage the persistent team. Read notifications using flow_unread and wait for explicit live-test commands. Dispatch and submit only when the latest command asks. Keep responses brief.', connection: { port: 0, allowedOrigins: ['http://127.0.0.1:3080', 'http://localhost:3080', `http://127.0.0.1:${port}`] } } }, { insert: [{ id: 'p7-live-proof', name: join(root, 'tests/live/host.mjs') }] }];
await privateWrite(join(home, 'profiles/web/cordis.patch.yml'), stringify(overrides));
const mode = process.env.P7_PHASE ?? 'all';
assert.ok(['all', 'main', 'restart', 'probe', 'single', 'herb', 'resume-probe'].includes(mode));
for (const phase of mode === 'all' ? ['main', 'restart'] : [mode]) {
    const env = { ...process.env, DSH_HOME: home, P7_PROOF_DIR: proof, P7_PHASE: phase };
    delete env.P7_LOCAL_LLM;
    const hostSnapshot = join(proof, phase + '-host.mjs');
    for (const path of ['evidence.json', phase + '-evidence.json', phase + '-cli-active.log', phase + '-cli.log', 'private-launch-url.txt']) await privatePath(join(proof, path), true);
    await privateWrite(hostSnapshot, await readFile(join(root, 'tests/live/host.mjs')));
    overrides.at(-1).insert[0].name = hostSnapshot;
    await privateWrite(join(home, 'profiles/web/cordis.patch.yml'), stringify(overrides));
    await privateWrite(join(proof, 'evidence.json'), JSON.stringify({ status: 'STARTING' }));
    const child = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: root, env });
    let exitState, spawnError, ioError;
    const exited = new Promise(resolve => {
        child.once('exit', (code, signal) => { exitState = { code, signal }; resolve(exitState); });
        child.once('error', error => { spawnError = error; exitState = { error: error.message }; resolve(exitState); });
    });
    let writes = Promise.resolve();
    let output = '', interrupted = false;
    const receive = value => {
        output += value;
        for (const line of String(value).split('\n'))
            if (line.startsWith('[P7 live]'))
                console.log(line);
        const launch = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
        writes = writes.then(async () => {
            if (launch) await privateWrite(join(proof, 'private-launch-url.txt'), launch, { mode: 0o600 });
            await privateWrite(join(proof, phase + '-cli-active.log'), output.replace(/\?token=[^\s]+/g, '?token=<ephemeral>'));
        }).catch(error => { ioError = error; });
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    const abort = () => { interrupted = true; child.kill('SIGINT'); };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    const limit = setTimeout(() => child.kill('SIGINT'), 20 * 60000);
    try {
        const end = Date.now() + 19 * 60000;
        for (;;) {
            if (spawnError) throw spawnError;
            if (ioError) throw ioError;
            if (exitState || child.exitCode !== null || child.signalCode !== null) throw new Error('CLI exited: ' + JSON.stringify(exitState ?? { code: child.exitCode, signal: child.signalCode }));
            let evidence;
            try {
                evidence = JSON.parse(await readFile(join(proof, 'evidence.json'), 'utf8'));
            }
            catch { }
            if (evidence?.status === 'FAIL')
                throw new Error(evidence.error.message);
            if (evidence?.status === 'PROBE_PASS' || evidence?.status === 'PASS') {
                console.log(JSON.stringify({ status: evidence.status, phase, proof, requests: evidence.requests.length }));
                break;
            }
            if (interrupted)
                throw new Error('Live runner interrupted');
            if (Date.now() > end)
                throw new Error('Live runner deadline exceeded');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    finally {
        child.kill('SIGINT');
        const force = setTimeout(() => child.kill('SIGKILL'), 10000);
        await exited;
        clearTimeout(force);
        clearTimeout(limit);
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        await writes;
        await privateWrite(join(proof, phase + '-cli.log'), output.replace(/\?token=[^\s]+/g, '?token=<ephemeral>'));
        await privateWrite(join(proof, phase + '-process.json'), JSON.stringify({ pid: child.pid, exit: exitState, runnerOwnedStop: true }, null, 2));
    }
}
