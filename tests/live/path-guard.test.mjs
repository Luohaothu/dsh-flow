import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, rmSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, createProofWriter } from './host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const owned = mkdtempSync(join(root, '.artifacts/live-output-guard-'));
const external = mkdtempSync(join(tmpdir(), 'flow-external-sentinel-'));
const sentinel = join(external, 'sentinel.txt');
const original = 'Owned external sentinel: this content must remain unchanged.\n';
writeFileSync(sentinel, original);
after(() => { rmSync(owned, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); });
const outputs = ['evidence.json', 'handoff.json', 'ui-ready.json', 'restart-ui-ready.json', ...['probe', 'resume-probe', 'herb', 'single', 'main', 'restart'].map(phase => phase + '-evidence.json')];
function rejectBeforeContext(directory, action = apply, phase = 'single') {
    const beforeDirectory = process.env.P7_PROOF_DIR, beforePhase = process.env.P7_PHASE;
    let contextReads = 0, modelRequests = 0;
    const ctx = new Proxy({}, { get(_target, key) {
        contextReads++;
        if (key === 'llm') return { prepareCall() { modelRequests++; throw new Error('No model call is permitted in a path guard test'); } };
        throw new Error('Path guard must reject before accessing Context');
    } });
    process.env.P7_PROOF_DIR = directory;
    process.env.P7_PHASE = phase;
    try { assert.throws(() => action(ctx), /symlink|project\/\.artifacts|Unknown live phase/); }
    finally {
        if (beforeDirectory === undefined) delete process.env.P7_PROOF_DIR; else process.env.P7_PROOF_DIR = beforeDirectory;
        if (beforePhase === undefined) delete process.env.P7_PHASE; else process.env.P7_PHASE = beforePhase;
    }
    assert.equal(contextReads, 0);
    assert.equal(modelRequests, 0);
    assert.equal(readFileSync(sentinel, 'utf8'), original);
}
for (const output of outputs) test(`direct host rejects pre-existing ${output} symlink with zero model requests`, () => {
    const directory = mkdtempSync(join(owned, 'leaf-'));
    symlinkSync(sentinel, join(directory, output));
    rejectBeforeContext(directory);
});
test('direct host rejects an output root outside project artifacts before any Context access', () => {
    rejectBeforeContext(external);
});
test('direct host rejects a symlink proof root without creating anything outside it', () => {
    const directory = join(owned, 'proof-link');
    symlinkSync(external, directory, 'dir');
    const before = readdirSync(external);
    rejectBeforeContext(directory);
    assert.deepEqual(readdirSync(external), before);
});
test('direct host rejects a symlink ancestor before creating the requested proof directory', () => {
    const parent = join(owned, 'parent-link');
    symlinkSync(external, parent, 'dir');
    const before = readdirSync(external);
    rejectBeforeContext(join(parent, 'new-proof'));
    assert.deepEqual(readdirSync(external), before);
});
test('writer rechecks a leaf replaced by a symlink after initial preflight', () => {
    const directory = mkdtempSync(join(owned, 'late-leaf-')), write = createProofWriter(directory);
    symlinkSync(sentinel, join(directory, 'handoff.json'));
    assert.throws(() => write('handoff.json', 'overwrite'), /symlink/);
    assert.equal(readFileSync(sentinel, 'utf8'), original);
});
test('writer rechecks a proof directory replaced by an escaping symlink', () => {
    const directory = mkdtempSync(join(owned, 'late-parent-')), write = createProofWriter(directory);
    renameSync(directory, directory + '-moved');
    symlinkSync(external, directory, 'dir');
    const before = readdirSync(external);
    assert.throws(() => write('evidence.json', 'overwrite'), /symlink/);
    assert.deepEqual(readdirSync(external), before);
    assert.equal(readFileSync(sentinel, 'utf8'), original);
});
test('writer replaces a regular owned output completely and refuses unknown output paths', () => {
    const directory = mkdtempSync(join(owned, 'regular-')), write = createProofWriter(directory);
    write('ui-ready.json', 'long previous output');
    write('ui-ready.json', '{}');
    assert.equal(readFileSync(join(directory, 'ui-ready.json'), 'utf8'), '{}');
    assert.throws(() => write('../escape.json', 'overwrite'), /Unknown live proof output/);
});
test('direct host rejects a phase that could alter the receipt filename before Context access', () => {
    rejectBeforeContext(mkdtempSync(join(owned, 'phase-')), apply, '../../escape');
});
test('an immutable copied host keeps the same direct-entry guard without another module or environment setting', async () => {
    const snapshot = join(owned, 'single-host.mjs');
    copyFileSync(fileURLToPath(new URL('./host.mjs', import.meta.url)), snapshot);
    const module = await import(pathToFileURL(snapshot));
    const directory = mkdtempSync(join(owned, 'snapshot-'));
    symlinkSync(sentinel, join(directory, 'restart-ui-ready.json'));
    rejectBeforeContext(directory, module.apply);
});
