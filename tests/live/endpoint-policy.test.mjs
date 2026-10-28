import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = join(root, 'tests/live/runner.mjs');
const owned = mkdtempSync(join(tmpdir(), 'flow-endpoint-policy-'));
const outsideHome = join(owned, 'uncreated-home');
const sentinel = join(owned, 'sentinel.txt');
const original = 'External self-owned sentinel must remain unchanged.\n';
const credential = 'test-only-credential-never-written';
writeFileSync(sentinel, original);
after(() => rmSync(owned, { recursive: true, force: true }));
const policyError = /requires HTTPS except for literal 127\.0\.0\.1 or \[::1\] HTTP loopback/;
const pathError = /Live paths must stay below this project\/\.artifacts/;
function invoke(url, entry = runner, options = {}) {
    const env = { ...process.env, P7_LIVE_BASE_URL: url, P7_LIVE_HOME: outsideHome, P7_PROOF_DIR: join(owned, 'uncreated-proof'), P7_LOCAL_LLM: credential };
    if (options.defaultPaths) { delete env.P7_LIVE_HOME; delete env.P7_PROOF_DIR; }
    const result = spawnSync(process.execPath, [entry], { cwd: options.cwd ?? root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(credential));
    assert.equal(readFileSync(sentinel, 'utf8'), original);
    assert.equal(existsSync(outsideHome), false);
    assert.equal(existsSync(join(owned, 'uncreated-proof')), false);
    return result.stderr;
}
const cases = [
    ['remote HTTP', 'http://example.com/v1', false],
    ['private-network HTTP', 'http://192.168.1.2/v1', false],
    ['remote HTTPS', 'https://example.com/v1', true],
    ['literal IPv4 HTTP', 'http://127.0.0.1:8000/v1', true],
    ['literal IPv6 HTTP', 'http://[::1]:8000/v1', true],
    ['HTTPS loopback', 'https://127.0.0.1:8000/v1', true],
    ['unsupported scheme', 'ftp://127.0.0.1/v1', false],
    ['DNS localhost HTTP', 'http://localhost:8000/v1', false],
    ['other 127/8 address', 'http://127.0.0.2:8000/v1', false],
    ['hostname suffix lookalike', 'http://127.0.0.1.example.com/v1', false],
    ['short IPv4 spelling', 'http://127.1:8000/v1', false],
    ['integer IPv4 spelling', 'http://2130706433:8000/v1', false],
    ['hexadecimal IPv4 spelling', 'http://0x7f000001:8000/v1', false],
    ['authority userinfo confusion', 'http://127.0.0.1@example.com/v1', false],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]:8000/v1', false],
];
for (const [name, url, accepted] of cases) test(`actual runner ${accepted ? 'accepts' : 'rejects'} ${name} before profile or model startup`, () => {
    const before = readdirSync(owned);
    const error = invoke(url);
    assert.match(error, accepted ? pathError : policyError);
    if (!accepted) assert.doesNotMatch(error, pathError);
    assert.deepEqual(readdirSync(owned), before);
});
test('actual runner rejects malformed endpoint without profile or credential side effects', () => {
    assert.match(invoke('not a URL'), /must be a valid HTTP or HTTPS URL/);
});
function workspace(name) {
    const directory = join(owned, name);
    mkdirSync(join(directory, 'tests/live'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-flow-workspace', type: 'module' }));
    for (const file of ['runner.mjs', 'host.mjs']) copyFileSync(join(root, 'tests/live', file), join(directory, 'tests/live', file));
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    return directory;
}
test('actual runner rejects remote HTTP before even creating artifacts in a fresh workspace', () => {
    const directory = workspace('invalid-fresh');
    assert.match(invoke('http://example.com/v1', join(directory, 'tests/live/runner.mjs'), { cwd: directory }), policyError);
    assert.equal(existsSync(join(directory, '.artifacts')), false);
});
test('actual runner initializes absent artifacts then reaches the private-home guard in a fresh workspace', () => {
    const directory = workspace('valid-fresh');
    const error = invoke('http://127.0.0.1:8000/v1', join(directory, 'tests/live/runner.mjs'), { cwd: directory });
    assert.match(error, pathError);
    assert.ok(lstatSync(join(directory, '.artifacts')).isDirectory());
    assert.deepEqual(readdirSync(join(directory, '.artifacts')), []);
});
test('actual runner rejects an existing artifact-root symlink without creating an external home or proof', () => {
    const directory = workspace('artifact-symlink'), external = join(owned, 'artifact-target');
    mkdirSync(external);
    writeFileSync(join(external, 'sentinel.txt'), original);
    symlinkSync(external, join(directory, '.artifacts'), 'dir');
    const before = readdirSync(external);
    assert.match(invoke('http://[::1]:8000/v1', join(directory, 'tests/live/runner.mjs'), { cwd: directory, defaultPaths: true }), /Live artifact root cannot be a symlink/);
    assert.deepEqual(readdirSync(external), before);
    assert.equal(readFileSync(join(external, 'sentinel.txt'), 'utf8'), original);
});
