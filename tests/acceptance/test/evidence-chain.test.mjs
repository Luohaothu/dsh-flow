/**
 * The acceptance chain's own contracts, tested directly.
 *
 * These are the mechanisms that make a report trustworthy: a run directory that
 * cannot be reused, an environment a case cannot hijack, fixture ids that cannot
 * collide across runs, a tier denominator that has one source, and a build
 * fingerprint that notices when the code moved under it. Every one of them was
 * previously only exercised by running a case, which is how a report could look
 * authoritative while describing a mixture of two builds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunLayout, buildHostEnv, inheritEnv, HOST_ENV_ALLOWLIST, RUNNER_ENV_KEYS } from '../../../src/host/host.mjs';
import { namespaceFixtures, assertTierBudget, validateCaseEnv, modelRouteFromEnv, computeBuildHashes, buildDrift, hashTree, CASE_ENV_KEYS, readStoneLedger, mechanismVerdict } from '../run.mjs';

test('context gate judges the request after compaction, including its pending prompt', async () => {
  const { requestBudgetOverruns } = await import('../checks/context.mjs');
  const compacted = { before: 8487, after: 4435, pending: 0, context_limit: 8192, decision: 'compact' };
  assert.deepEqual(requestBudgetOverruns([compacted]), [],
    'a send below the limit is valid even though compaction began above it');
  const oversized = { ...compacted, after: 8100, pending: 100 };
  assert.deepEqual(requestBudgetOverruns([oversized]), [oversized],
    'pending input counts against the send-time limit after compaction');
  assert.deepEqual(requestBudgetOverruns([{ ...oversized, decision: 'reject' }]), [],
    'a rejected step did not send an over-budget request');
});

test('browser gate rejects launch failures and dashboards without an opened cluster panel', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const { run: checkBrowser } = await import('../checks/browser.mjs');
  const root = scratch(t);
  const data = join(root, 'data');
  mkdirSync(data);
  const db = new DatabaseSync(join(data, 'cluster.sqlite'));
  db.exec('CREATE TABLE effects (cluster_id TEXT, tool TEXT, status TEXT, call_id TEXT, args TEXT, body TEXT);'
    + 'CREATE TABLE transactions (cluster_id TEXT, result TEXT);');
  const url = 'http://127.0.0.1:40100/?token=valid';
  const insert = db.prepare('INSERT INTO effects VALUES (?, ?, ?, ?, ?, ?)');
  for (const [tool, args] of [
    ['mcp__playwright-mcp__browser_navigate', { url }],
    ['mcp__playwright-mcp__browser_snapshot', {}],
  ]) insert.run('browser-cluster', tool, 'SETTLED', tool, JSON.stringify(args),
    JSON.stringify({ isError: true, text: 'Error: Target page, context or browser has been closed' }));
  db.prepare('INSERT INTO transactions VALUES (?, ?)').run('browser-cluster',
    JSON.stringify({ page_title: 'Hierarchical agent cluster', status: 'blocked' }));
  db.close();
  const verdict = await checkBrowser({
    report: { cluster_id: 'browser-cluster', web_url: url }, layout: { data },
    events: [{ type: 'turn-end', data: { role: 'worker', stop_reason: 'completed' } }],
  });
  assert.equal(verdict.scenario_status, 'FAILED', 'a browser that never loaded a page cannot pass the browser scenario');
  for (const name of ['browser-navigate-called', 'browser-snapshot-called',
    'result-names-the-page', 'snapshot-recorded-as-evidence']) {
    assert.equal(verdict.checks.find(check => check.name === name).passed, false, name);
  }
  assert.equal(verdict.checks.find(check => check.name === 'browser-effects-settled').passed, true,
    'a failed tool still has a durable SETTLED receipt; its payload records the error separately');
  assert.match(verdict.checks.find(check => check.name === 'browser-effects-settled').evidence, /"isError":true/);

  const dashboard = new DatabaseSync(join(data, 'cluster.sqlite'));
  dashboard.prepare("UPDATE effects SET body=? WHERE tool=?").run(
    JSON.stringify({ isError: false, text: '### Page\n- Page Title: DSH Local Build' }),
    'mcp__playwright-mcp__browser_navigate');
  dashboard.prepare("UPDATE effects SET body=? WHERE tool=?").run(
    JSON.stringify({ isError: false, text: '### Page\n- Page Title: DSH Local Build\n### Snapshot\n- button \"Cluster\"' }),
    'mcp__playwright-mcp__browser_snapshot');
  dashboard.prepare('UPDATE transactions SET result=?').run(JSON.stringify({ page_title: 'DSH Local Build' }));
  dashboard.close();
  const dashboardOnly = await checkBrowser({
    report: { cluster_id: 'browser-cluster', web_url: url }, layout: { data },
    events: [{ type: 'turn-end', data: { role: 'worker', stop_reason: 'completed' } }],
  });
  assert.equal(dashboardOnly.scenario_status, 'FAILED',
    'a navigation that only displays the Cluster button has not opened the cluster panel');
  assert.equal(dashboardOnly.checks.find(check => check.name === 'cluster-panel-visible').passed, false);

  const panel = new DatabaseSync(join(data, 'cluster.sqlite'));
  const addEffect = panel.prepare('INSERT INTO effects VALUES (?, ?, ?, ?, ?, ?)');
  addEffect.run('browser-cluster', 'mcp__playwright-mcp__browser_click', 'SETTLED', 'click-timeout',
    JSON.stringify({ element: 'Cluster', ref: 'e30' }),
    JSON.stringify({ isError: true, text: 'Timeout waiting for a modal overlay to clear' }));
  addEffect.run('browser-cluster', 'mcp__playwright-mcp__browser_click', 'SETTLED', 'click',
    JSON.stringify({ element: 'Cluster', ref: 'e30' }), JSON.stringify({ isError: false, text: 'Clicked Cluster' }));
  addEffect.run('browser-cluster', 'mcp__playwright-mcp__browser_snapshot', 'SETTLED', 'panel-snapshot',
    '{}', JSON.stringify({ isError: false,
      text: '### Page\n- Page Title: DSH Local Build\n### Snapshot\n- heading "Hierarchical agent cluster" [level=2]' }));
  panel.prepare('UPDATE transactions SET result=?').run(JSON.stringify({
    page_title: 'DSH Local Build', panel_heading: 'Hierarchical agent cluster',
  }));
  panel.close();
  const opened = await checkBrowser({
    report: { cluster_id: 'browser-cluster', web_url: url }, layout: { data },
    events: [{ type: 'turn-end', data: { role: 'worker', stop_reason: 'completed' } }],
  });
  assert.equal(opened.scenario_status, 'PASSED', 'the clicked panel has a native post-click heading and corroborated page title');
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function countFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .reduce((n, entry) => n + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1), 0);
}

test('a run directory is exclusive, and an invalid run id never reaches the filesystem', t => {
  const root = scratch(t);
  const layout = createRunLayout(root, 'case-20260928T000000Z-abcdef');
  assert.ok(existsSync(layout.data) && existsSync(layout.workspace));

  // The same run id twice is a hard error: the report of the second run would
  // otherwise be written over the evidence of the first.
  assert.throws(() => createRunLayout(root, 'case-20260928T000000Z-abcdef'), /run directory already exists/);
  assert.ok(existsSync(layout.data), 'the refused call did not delete the existing run');

  for (const bad of ['../escape', 'a/b', '', 'a b', 'ünïcode', '.hidden/..']) {
    assert.throws(() => createRunLayout(root, bad), /invalid run id/, `run id ${JSON.stringify(bad)} must be refused`);
  }
  // A refused layout writes nothing.
  assert.ok(!existsSync(join(root, '..', 'escape')), 'a traversal attempt created nothing');
});

test('a case cannot hijack the runner-owned environment', t => {
  const root = scratch(t);
  const layout = createRunLayout(root, 'env-case');
  const env = buildHostEnv({
    home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: { baseURL: 'http://127.0.0.1:8000/v1', model: 'Qwen3.8-27B-FP8', provider: 'local-sglang' },
    extra: {
      HOME: '/home/someone-else', TMPDIR: '/tmp/elsewhere', DSH_HOME: '/nope',
      FLOW_QWEN_BASE_URL: 'https://api.example.com/v1', FLOW_QWEN_MODEL: 'some-cloud-model',
      FLOW_MODEL_PROVIDER: 'untrusted', FLOW_MODEL_API_KEY: 'untrusted-secret',
      ANTHROPIC_AUTH_TOKEN: 'untrusted-anthropic-secret',
      FLOW_DATA_DIR: '/tmp/other-data', FLOW_CONTEXT_ROLE: '1',
    },
  });
  for (const key of RUNNER_ENV_KEYS) {
    if (key === 'DSH_TELEMETRY_DISABLED' || key === 'NODE_NO_WARNINGS' || key === 'FLOW_IPC') continue;
    assert.notEqual(env[key], `/home/someone-else`, `${key} must not come from the case`);
  }
  assert.equal(env.HOME, layout.home);
  assert.equal(env.TMPDIR, layout.tmp);
  assert.equal(env.FLOW_DATA_DIR, layout.data);
  assert.equal(env.FLOW_QWEN_BASE_URL, 'http://127.0.0.1:8000/v1');
  assert.equal(env.FLOW_QWEN_MODEL, 'Qwen3.8-27B-FP8');
  assert.equal(env.FLOW_MODEL_PROVIDER, 'local-sglang');
  assert.equal(env.FLOW_MODEL_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  // The case's own keys still arrive.
  assert.equal(env.FLOW_CONTEXT_ROLE, '1');

  // Only the allowlist is inherited from the operator's environment.
  const inherited = inheritEnv({ PATH: '/usr/bin', SECRET_TOKEN: 'leak', HOME: '/home/operator',
    ANTHROPIC_AUTH_TOKEN: 'not-for-an-openai-provider' });
  assert.deepEqual(Object.keys(inherited), ['PATH']);
  assert.ok(HOST_ENV_ALLOWLIST.includes('DSH_INSTALL_PATH'));

  // And a case may only set the keys that describe its context.
  assert.deepEqual(validateCaseEnv({ id: 'c', env: { FLOW_CONTEXT_TRIGGER: '0.8' } }), { FLOW_CONTEXT_TRIGGER: '0.8' });
  assert.throws(() => validateCaseEnv({ id: 'c', env: { HOME: '/tmp' } }), /may only set/);
  assert.throws(() => validateCaseEnv({ id: 'c', env: { FLOW_CONTEXT_ROLE: '' } }), /non-empty string/);
  assert.deepEqual(CASE_ENV_KEYS.length, 5);
});

test('a DSH OpenAI-compatible route receives only its explicit credential, never Anthropic ambient state', t => {
  const root = scratch(t);
  const layout = createRunLayout(root, 'openai-env-case');
  const opts = {
    home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
    modelRoute: {
      provider: 'openai-compatible', model: 'deepseek-v4.1-flash',
      baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    },
    extra: { ANTHROPIC_AUTH_TOKEN: 'case-injection', FLOW_MODEL_API_KEY: 'case-injection' },
  };
  const env = buildHostEnv({ ...opts, modelApiKey: 'explicit-coding-plan-key' });
  assert.equal(env.FLOW_MODEL_API_KEY, 'explicit-coding-plan-key');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.FLOW_MODEL_PROVIDER, 'openai-compatible');
  assert.equal(env.FLOW_QWEN_BASE_URL, 'https://ark.cn-beijing.volces.com/api/coding/v3');
  assert.equal(env.FLOW_QWEN_MODEL, 'deepseek-v4.1-flash');
  const absent = buildHostEnv(opts);
  assert.equal(absent.FLOW_MODEL_API_KEY, undefined);
});

test('model-route settings come from explicit generic OpenAI-compatible configuration, not Anthropic ambient state', () => {
  const env = {
    FLOW_MODEL_PROVIDER: 'openai-compatible',
    FLOW_MODEL_ID: 'deepseek-v4.1-flash',
    FLOW_MODEL_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding',
    ANTHROPIC_MODEL: 'glm-5.3[1m]',
  };
  assert.deepEqual(modelRouteFromEnv(env), {
    baseURL: env.FLOW_MODEL_BASE_URL,
    model: env.FLOW_MODEL_ID,
    provider: env.FLOW_MODEL_PROVIDER,
  });
  assert.deepEqual(modelRouteFromEnv({}), {
    baseURL: 'http://127.0.0.1:8000/v1',
    model: 'Qwen3.8-27B-FP8',
    provider: 'local-sglang',
  });
});

test('fixture ids are namespaced per run, and a broken fixture is refused before start', () => {
  const spec = {
    initial_transactions: [
      { id: 'rec-deep', objective: 'deep', needs: ['rec-flat'], parent_transaction_id: null },
      { id: 'rec-flat', objective: 'flat' },
    ],
    message_fixture: [{ from: 'rec-deep', to: 'rec-flat', body: 'x' }],
  };
  const first = namespaceFixtures(spec, 'run-a');
  assert.deepEqual(first.ids, ['run-a-rec-deep', 'run-a-rec-flat']);
  assert.equal(first.spec.initial_transactions[0].needs[0], 'run-a-rec-flat');
  assert.equal(first.spec.message_fixture[0].from, 'run-a-rec-deep');
  assert.equal(first.map['rec-deep'], 'run-a-rec-deep');

  // Two runs never collide, which is the collision that used to abort `start`.
  const second = namespaceFixtures(spec, 'run-b');
  assert.notDeepEqual(first.ids, second.ids);
  // Namespacing is idempotent for ids that already carry the run prefix.
  assert.deepEqual(namespaceFixtures(first.spec, 'run-a').ids, first.ids);
  // The original spec is not mutated.
  assert.equal(spec.initial_transactions[0].id, 'rec-deep');

  assert.throws(() => namespaceFixtures({
    initial_transactions: [{ id: 'a' }, { id: 'a' }],
  }, 'r'), /not unique after namespacing/);
  assert.throws(() => namespaceFixtures({
    initial_transactions: [{ id: 'a', needs: ['ghost'] }],
  }, 'r'), /references unknown transaction/);
  assert.throws(() => namespaceFixtures({ initial_transactions: [{ objective: 'no id' }] }, 'r'), /without an id/);
});
test('message fixture endpoints resolve to namespaced initial transactions before start', () => {
  const spec = {
    initial_transactions: [{ id: 'rec-deep' }, { id: 'rec-flat' }],
    message_fixture: [{ from: 'rec-deep', to: 'rec-flat', body: 'x' }],
  };
  assert.deepEqual(namespaceFixtures(spec, 'run-a').spec.message_fixture, [
    { from: 'run-a-rec-deep', to: 'run-a-rec-flat', body: 'x' },
  ]);
  for (const fixture of [
    { from: 'rec-deep', to: 'typo' },
    { from: 'typo', to: 'rec-flat' },
    { to: 'rec-flat' },
    { from: 'rec-deep' },
  ]) {
    const missing = fixture.from === undefined ? 'from' : fixture.to === undefined ? 'to' : fixture.from === 'typo' ? 'from' : 'to';
    const badRef = fixture[missing] ?? 'undefined';
    assert.throws(() => namespaceFixtures({
      ...spec, message_fixture: [{ ...fixture, body: 'x' }],
    }, 'run-a'), error => error.message.includes(`message fixture ${missing}`)
      && error.message.includes(badRef), `bad ${missing}=${badRef} must be rejected before start`);
  }
  assert.throws(() => namespaceFixtures({
    ...spec, message_fixture: [{ from: 'run-a-rec-deep', to: 'run-a-missing', body: 'x' }],
  }, 'run-a'), /message fixture to references unknown transaction run-a-missing/);
});

test('persisted nested write grants fail the mechanism verdict without confusing sibling path prefixes', async t => {
  const { data, workspace } = createRunLayout(scratch(t), 'nested-grants');
  const { ClusterStore } = await import('../../../src/adapter/store.js');
  const store = new ClusterStore(join(data, 'cluster.sqlite'));
  t.after(() => store.close());
  const clusterId = 'nested-cluster';
  store.createCluster({ id: clusterId, objective: 'scope audit', workspace, capabilities: [], limits: {} }, {});
  for (const [id, path] of [
    ['parent', 'foo'], ['nested', 'foo/deep'], ['prefix-sibling', 'foobar'], ['separate', 'elsewhere'],
  ]) {
    store.insertAllocation({
      id, cluster_id: clusterId, node_id: 'node', agent_id: id,
      write_scope: [path], write_scope_canonical: [join(workspace, path)], status: 'ACTIVE',
    });
  }
  const ledger = readStoneLedger({ data, workspace }, clusterId);
  assert.equal(ledger.available, true);
  assert.equal(ledger.granted_scope_overlaps, 1, 'only foo and foo/deep overlap; foobar does not');
  const report = {};
  assert.equal(mechanismVerdict(report, ledger), 'FAIL');
  assert.deepEqual(report.mechanism_notes.filter(note => note.startsWith('overlapping granted write scopes')), [
    'overlapping granted write scopes: 1',
  ]);
  store.run("UPDATE allocations SET status='RELEASED' WHERE id='nested'");
  const disjoint = readStoneLedger({ data, workspace }, clusterId);
  assert.equal(disjoint.granted_scope_overlaps, 0);
  const cleanReport = {};
  assert.notEqual(mechanismVerdict(cleanReport, disjoint), 'FAIL');
  assert.ok(!cleanReport.mechanism_notes.some(note => note.startsWith('overlapping granted write scopes')));
});

test('the tier denominator has exactly one source, and a mismatched budget is refused', () => {
  const planned = Array.from({ length: 64 }, (_, index) => ({ id: `t-${index}`, objective: 'x' }));
  const spec = {
    generated_tier: true,
    initial_transactions: planned,
    budget: { tokens: 65_536 * 64, model_requests: 12 * 64, tool_calls: 16 * 64, wall_time_ms: 21_600_000, agents: 4096, max_active_agents: 9 },
  };
  assert.equal(assertTierBudget(spec), undefined, 'a conforming tier passes the guard');
  // The 64 tier carrying a 1024 tier's budget is the defect this refuses.
  for (const wrong of [
    { tokens: 65_536 * 1024 }, { model_requests: 12 * 1024 }, { tool_calls: 16 * 1024 },
  ]) {
    assert.throws(() => assertTierBudget({ ...spec, budget: { ...spec.budget, ...wrong } }), /tier budget mismatch: \w+ is \d+, expected \d+ for 64 planned transactions/);
  }
  // A fixture that planned nothing is a mismatch too, not a silent zero budget.
  assert.throws(() => assertTierBudget({ ...spec, initial_transactions: [] }), /tier budget mismatch/);
  // And a hand-written case (not a generated tier) is not subject to the rule.
  assert.equal(assertTierBudget({ initial_transactions: planned, budget: { tokens: 1 } }), undefined);
});

test('the acceptance fingerprint covers the host modules under their own prefix', t => {
  const dir = scratch(t);
  const acceptance = join(dir, 'acceptance');
  const host = join(dir, 'host');
  mkdirSync(acceptance);
  mkdirSync(host);
  writeFileSync(join(acceptance, 'run.mjs'), 'export const runner = 1;\n');
  writeFileSync(join(acceptance, 'mock-scenarios.mjs'), 'export const scenario = 1;\n');
  writeFileSync(join(host, 'mock-scenarios.mjs'), 'export const scenario = 1;\n');
  const extra = [{ prefix: 'lib', root: host }];

  const before = hashTree(acceptance, extra);
  assert.match(before.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(before.files, 3, 'every file of both trees is counted');
  assert.notEqual(before.digest, hashTree(acceptance).digest,
    'the host tree is inside the digest, not merely alongside it');
  assert.notEqual(before.digest, hashTree(host).digest);

  // A mock scenario or a ledger rule changed under a live run is the same
  // defect as a changed checker: the report would describe two experiments.
  writeFileSync(join(host, 'mock-scenarios.mjs'), 'export const scenario = 2;\n');
  const afterHost = hashTree(acceptance, extra);
  assert.notEqual(afterHost.digest, before.digest, 'a host-module change moves the fingerprint');

  // An acceptance file still moves it, and the two trees stay one namespace
  // under their prefixes (`lib/mock-scenarios.mjs` is its own entry).
  writeFileSync(join(acceptance, 'run.mjs'), 'export const runner = 2;\n');
  assert.notEqual(hashTree(acceptance, extra).digest, afterHost.digest, 'an acceptance change moves the fingerprint');

  // A tree that is not there is unknown, never an empty-but-valid digest.
  assert.deepEqual(hashTree(join(dir, 'missing')), { digest: null, files: 0 });
  assert.deepEqual(hashTree(acceptance, [{ prefix: 'lib', root: join(dir, 'missing') }]), { digest: null, files: 0 });
});

test('a report notices when the build moved under it', t => {
  const dir = scratch(t);
  const source = join(dir, 'plugin.js');
  writeFileSync(source, 'export const a = 1;\n');
  const before = computeBuildHashes({ id: 'smoke', __source: source }, []);
  assert.match(before.plugin_source.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(before.plugin_source.files > 0, 'the tree digest counts its files');
  assert.equal(buildDrift(before, before), null, 'an unchanged fingerprint is one build');

  // Same call, same digest: the fingerprint is content, not a timestamp.
  assert.equal(computeBuildHashes({ id: 'smoke' }, []).plugin_source.digest, computeBuildHashes({ id: 'smoke' }, []).plugin_source.digest);

  // The runner's own fingerprint covers the host modules it drives, not only
  // the tree the runner itself lives in: a mock scenario, a ledger rule or the
  // host driver changing mid-run is the same defect as a changed checker.
  const { acceptance_source } = computeBuildHashes({ id: 'smoke' }, []);
  assert.match(acceptance_source.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(acceptance_source.files,
    countFiles(join('tests', 'acceptance')) + countFiles(join('src', 'host')),
    'the acceptance fingerprint covers tests/acceptance and src/host');

  const after = JSON.parse(JSON.stringify(before));
  after.lib_index = { digest: 'sha256:different', files: 1 };
  assert.equal(buildDrift(before, after), 'lib_index');
  assert.equal(buildDrift(before, null), 'the fingerprint was never taken');
  const patched = JSON.parse(JSON.stringify(before));
  patched.patches = [{ path: '/tmp/x.patch', digest: 'sha256:other' }];
  assert.equal(buildDrift(before, patched), 'patches');
  assert.match(readFileSync(source, 'utf8'), /export const a = 1/);
});
test('a refused out-of-scope write is enforcement, and only a settled escape is a defect', async () => {
  const { writeScopeAnalysis } = await import('../../../src/host/ledger.mjs');
  const workspace = '/tmp/ws';
  const allocations = [{ agent_id: 'a1', write_scope_canonical: [`${workspace}/flat`] }];

  // No settled write-capable effect: there is no execution evidence at all, so
  // the answer is unmeasured — never zero escapes.
  assert.equal(writeScopeAnalysis({ allocations, effects: [], workspace }).unmeasured, 'no write-capable tool call settled');

  // The write that *did* run inside its grant is not an escape, whether the
  // host recorded an absolute or a workspace-relative path.
  const inside = writeScopeAnalysis({
    allocations, workspace,
    effects: [
      { agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: `${workspace}/flat/result.txt` }), status: 'SETTLED' },
      { agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: 'flat/result.txt' }), status: 'SETTLED' },
    ],
  });
  assert.equal(inside.unmeasured, null);
  assert.deepEqual(inside.escapes, [], 'both writes are covered by the grant');
  assert.equal(inside.checked, 2);

  // A settled write outside the grant is an escape, and it names the scope it
  // violated.
  const escaped = writeScopeAnalysis({
    allocations, workspace,
    effects: [{ agent_id: 'a1', tool: 'edit', args: JSON.stringify({ file_path: `${workspace}/deep/result.txt` }), status: 'SETTLED' }],
  });
  assert.equal(escaped.escapes.length, 1);
  assert.match(escaped.escapes[0].path, /deep\/result\.txt$/);
  assert.deepEqual(escaped.escapes[0].scopes, [`${workspace}/flat`]);

  // A refused attempt is not an effect at all: the plugin never dispatches it, so
  // it cannot appear here. The runner reads those refusals as their own fact
  // (`write_scope_refusals`), which is why the mechanism verdict no longer fails
  // a run for having enforced its sandbox.
});

test('the recovery case measures the blackboard key its own instructions name', async () => {
  const { requiredBlackboardKeys, blackboardVerdict } = await import('../checks/recovery.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const caseDef = JSON.parse(readFileSync(join(process.cwd(), 'tests/acceptance/cases/recovery.json'), 'utf8'));

  const required = requiredBlackboardKeys(caseDef, 'g3-run');
  assert.deepEqual(required, ['g3-run/total'], `the objective names exactly this key: ${JSON.stringify(required)}`);

  // Absent: the run was told to publish it and did not.
  const absent = blackboardVerdict([], required);
  assert.equal(absent.ok, false);
  assert.deepEqual(absent.missing, ['g3-run/total']);
  // Wrong key: a key was published, just not the one the case asks for.
  const wrong = blackboardVerdict([{ key: 'something/else', revision: 1 }], required);
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.found, []);
  // Present: the key, at any revision.
  const present = blackboardVerdict([{ key: 'something/else', revision: 1 }, { key: 'g3-run/total', revision: 4 }], required);
  assert.equal(present.ok, true);
  assert.deepEqual(present.found, ['g3-run/total']);

  // A case that names no key is not asserted on: the runner reports what it sees.
  assert.deepEqual(requiredBlackboardKeys({ objective: 'do the work', acceptance_criteria: ['no keys here'] }, 'r'), []);
});

test('the clock and the limit evidence are measured before the case checks run', async () => {
  const { measureRun, classifyOutcome } = await import('../run.mjs');
  const budget = { tokens: 1000, model_requests: 10, wall_time_ms: 60_000 };

  // A run that spent its wall budget: the checks that derive their own class
  // read `limit_reached` and the clock, so both must exist before they run.
  const report = { failure_class: null, scenario_status: null, spec: { budget } };
  const started = 1_000_000;
  measureRun(report, {
    startedAt: started,
    clock: started + 61_000,
    budget,
    usage: { total_tokens: 100, requests: 2 },
    clusterReason: null,
    refusals: [],
  });
  assert.equal(report.wall_time_ms, 61_000, 'the measured clock is on the report');
  assert.ok(report.finished_at, 'and so is the finish time');
  assert.equal(report.limit_reached.hitWall, true, 'the wall limit is visible to the checks');
  assert.equal(report.limit_reached.exhausted.wall, true);

  // The derived class of a case that fails for another reason is still built
  // from those facts, which is why measuring first matters.
  const derived = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 100, requests: 2 }, wallTimeMs: report.wall_time_ms,
    clusterReason: null, refusals: [],
  });
  assert.equal(derived.failure_class, 'LIMIT_REACHED', 'a spent wall budget is a limit, not a model failure');

  // The measurement is idempotent: running it again with the same clock does not
  // move the numbers the checks already read.
  measureRun(report, { startedAt: started, clock: started + 61_000, budget, usage: { total_tokens: 100, requests: 2 } });
  assert.equal(report.wall_time_ms, 61_000);

  // Structured refusals reach the checks too — they are what makes a budget stop
  // visible before the classifier runs.
  const withRefusal = { failure_class: null, scenario_status: null, spec: { budget } };
  measureRun(withRefusal, {
    startedAt: started, clock: started + 100, budget,
    usage: { total_tokens: 10, requests: 1 },
    refusals: [{ scope: 'node x', dimension: 'tokens' }],
  });
  assert.equal(withRefusal.limit_reached.refusals.length, 1);
  assert.equal(withRefusal.limit_reached.blockedOnBudget, true);

  // Build drift is measured *before* the checks too, not only at the end: a check
  // that asserts "this report describes one build" runs before the final
  // comparison, and reading a flag that is set later made it vacuous.
  const drifting = { failure_class: null, scenario_status: null, spec: { budget }, build_hashes: { plugin_source: { digest: 'sha256:a', files: 1 } } };
  measureRun(drifting, {
    startedAt: started, clock: started + 100, budget,
    usage: { total_tokens: 10, requests: 1 },
    buildHashes: { plugin_source: { digest: 'sha256:b', files: 1 } },
  });
  assert.equal(drifting.build_drift, 'plugin_source', 'the drift is named before the checks run');
  assert.equal(drifting.not_comparable, true);

  // No drift: the flag stays absent and the checks see a single build.
  const stable = { failure_class: null, scenario_status: null, spec: { budget }, build_hashes: { plugin_source: { digest: 'sha256:a', files: 1 } } };
  measureRun(stable, {
    startedAt: started, clock: started + 100, budget,
    usage: { total_tokens: 10, requests: 1 },
    buildHashes: { plugin_source: { digest: 'sha256:a', files: 1 } },
  });
  assert.equal(stable.build_drift, null);
  assert.equal(stable.not_comparable, undefined);
});

test('the write-scope analysis reports UNKNOWN when it could not check every write', async () => {
  const { writeScopeAnalysis } = await import('../../../src/host/ledger.mjs');
  const workspace = '/work';

  // Mixed: one write checked and inside its grant, one whose identity has no
  // granted scope at all. The coverage is incomplete, so the answer is not zero.
  const mixed = writeScopeAnalysis({
    workspace,
    allocations: [{ agent_id: 'a1', write_scope_canonical: [`${workspace}/allowed`] }],
    effects: [
      { agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: `${workspace}/allowed/ok.txt` }), status: 'SETTLED' },
      { agent_id: 'a2', tool: 'write', args: JSON.stringify({ file_path: `${workspace}/elsewhere.txt` }), status: 'SETTLED' },
    ],
  });
  assert.equal(mixed.escapes.length, 0);
  assert.equal(mixed.checked, 1);
  assert.ok(mixed.unmeasured, `an unchecked write is not a verified zero: ${JSON.stringify(mixed)}`);

  // An unparsable target is unchecked too.
  const unparsable = writeScopeAnalysis({
    workspace,
    allocations: [{ agent_id: 'a1', write_scope_canonical: [`${workspace}/allowed`] }],
    effects: [{ agent_id: 'a1', tool: 'edit', args: 'not json', status: 'SETTLED' }],
  });
  assert.equal(unparsable.checked, 0);
  assert.ok(unparsable.unmeasured);

  // A traversal out of the granted prefix is proven, not skipped: prefix string
  // matching alone would call this one covered.
  const traversal = writeScopeAnalysis({
    workspace,
    allocations: [{ agent_id: 'a1', write_scope_canonical: [`${workspace}/allowed`] }],
    effects: [{ agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: `${workspace}/allowed/../outside.txt` }), status: 'SETTLED' }],
  });
  assert.equal(traversal.unmeasured, null, 'this one was checkable');
  assert.equal(traversal.escapes.length, 1, 'and it escaped');
  assert.equal(traversal.escapes[0].path, `${workspace}/outside.txt`, 'the path is normalised, not compared as a string');

  // Complete coverage with nothing outside the grant is the only verified zero.
  const clean = writeScopeAnalysis({
    workspace,
    allocations: [{ agent_id: 'a1', write_scope_canonical: [`${workspace}/allowed`] }],
    effects: [
      { agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: 'allowed/ok.txt' }), status: 'SETTLED' },
      { agent_id: 'a1', tool: 'write', args: JSON.stringify({ file_path: `${workspace}/allowed/sub/ok.txt` }), status: 'SETTLED' },
    ],
  });
  assert.equal(clean.escapes.length, 0);
  assert.equal(clean.checked, 2);
  assert.equal(clean.unmeasured, null);
});

test('a scenario failure with structured limit evidence is a limit, not a model failure', async () => {
  const { classifyOutcome } = await import('../run.mjs');
  const budget = { tokens: 1000, model_requests: 10, wall_time_ms: 60_000 };

  // Nothing the checks derived, but the ledger holds a structured refusal: the
  // class must be the limit the run really hit.
  const refusals = [{ scope: 'node a', dimension: 'tokens', requested: 10, available: 0 }];
  const limited = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 100, requests: 2 }, wallTimeMs: 5_000, clusterReason: null, refusals,
  });
  assert.equal(limited.failure_class, 'LIMIT_REACHED');
  assert.equal(limited.limit_reached.blockedOnBudget, true);

  // A class a check derived is still final — the budget branch may only supply a
  // default.
  const derived = classifyOutcome({
    failureClass: 'MECHANISM', scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 100, requests: 2 }, wallTimeMs: 5_000, clusterReason: null, refusals,
  });
  assert.equal(derived.failure_class, 'MECHANISM');
  assert.ok(derived.limit_reached, 'and the limit evidence is still recorded');

  // With no evidence at all, an unclassified failure is the model's.
  const model = classifyOutcome({
    failureClass: null, scenarioStatus: 'FAILED', budget,
    usage: { total_tokens: 10, requests: 1 }, wallTimeMs: 1_000, clusterReason: null, refusals: [],
  });
  assert.equal(model.failure_class, 'MODEL_OUTPUT');
  assert.equal(model.limit_reached, null);
});

test('a Worker over its provider-request allowance is caught through every kind it sends', async () => {
  const { run } = await import('../checks/smoke.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-smoke-allowance-'));
  try {
    const report = {
      cluster_id: 'c1', build_hashes: { plugin_source: { digest: 'a', files: 1 }, lib_index: { digest: 'b', files: 1 }, lib_client: { digest: 'c', files: 1 }, case_file: { digest: 'd', files: 1 }, patches: [{ path: 'p', digest: 'e' }] },
      build_drift: null,
      ledger: {
        usage_by_agent: [
          // Two ordinary sends plus one compaction: three provider requests for
          // the same Worker, which is over the allowance.
          { agent_id: 'w1', role: 'worker', kind: 'worker', c: 2, sent: 2 },
          { agent_id: 'w1', role: 'worker', kind: 'compaction', c: 1, sent: 1 },
          { agent_id: 'w2', role: 'worker', kind: 'worker', c: 2, sent: 2 },
        ],
        audits: [],
      },
      spec: {},
    };
    const out = await run({ workspace: dir, report, snapshot: { cluster: { status: 'COMPLETED' }, transactions: [], agents: [] }, events: [], single: null });
    const allowance = out.checks.find(entry => entry.name === 'worker-request-allowance');
    assert.equal(allowance.passed, false, `the compaction counts: ${allowance.evidence}`);
    assert.match(String(allowance.evidence), /"sent":3/);
    // Two ordinary sends and nothing else stays inside it.
    const within = await run({
      workspace: dir,
      report: { ...report, ledger: { ...report.ledger, usage_by_agent: [{ agent_id: 'w2', role: 'worker', kind: 'worker', c: 2, sent: 2 }] } },
      snapshot: { cluster: { status: 'COMPLETED' }, transactions: [], agents: [] }, events: [], single: null,
    });
    assert.equal(within.checks.find(entry => entry.name === 'worker-request-allowance').passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fingerprint check keeps failure, unknown and pass apart', async () => {
  const { run } = await import('../checks/smoke.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-smoke-hashes-'));
  const complete = {
    plugin_source: { digest: 'sha256:a', files: 9 }, lib_index: 'sha256:b', lib_client: 'sha256:c',
    case_file: 'sha256:d', patches: [{ path: 'p', digest: 'sha256:e' }],
  };
  const base = {
    cluster_id: 'c1', spec: {},
    ledger: { usage_by_agent: [], audits: [] },
  };
  const evaluate = async report => {
    const out = await run({ workspace: dir, report, snapshot: { cluster: { status: 'COMPLETED' }, transactions: [], agents: [] }, events: [], single: null });
    return out.checks.find(entry => entry.name === 'build-hashes-recorded');
  };
  try {
    // Measured and equal: a pass.
    assert.equal((await evaluate({ ...base, build_hashes: complete, build_drift: null })).passed, true);
    // Measured and different: a failure, not "unknown".
    const drifted = await evaluate({ ...base, build_hashes: complete, build_drift: 'plugin_source' });
    assert.equal(drifted.passed, false, String(drifted.evidence));
    assert.match(String(drifted.evidence), /drift="plugin_source"/);
    // Not measured at all (a report from before the field existed): unknown.
    assert.equal((await evaluate({ ...base, build_hashes: complete })).passed, null);
    // An incomplete fingerprint is a failure whatever the drift says.
    assert.equal((await evaluate({ ...base, build_hashes: { ...complete, patches: [] }, build_drift: null })).passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery records live lease rows at the crash and verifies their fence', async t => {
  const { ClusterStore } = await import('../../../src/adapter/store.js');
  const { readStoneLedger } = await import('../run.mjs');
  const { run } = await import('../checks/recovery.mjs');
  const root = mkdtempSync(join(tmpdir(), 'dsh-crash-leases-'));
  const data = join(root, 'data');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(data);
  const layout = { data, home: root, workspace: root };
  const store = new ClusterStore(join(data, 'cluster.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const clusterId = 'crash-cluster';
  store.createCluster({
    id: clusterId, objective: 'recover', workspace: root,
    capabilities: [], limits: {},
  }, {});
  store.run(
    `INSERT INTO leases(id, cluster_id, agent_id, node_id, purpose, epoch, expires, event_upper_bound, created)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    'lease-1', clusterId, 'worker-1', 'node-1', 'worker', 4, 2000, 42, 1000,
  );

  const atCrash = readStoneLedger(layout, clusterId);
  assert.deepEqual(atCrash.leases, { c: 1 }, 'the existing ledger count is unchanged');
  assert.equal(atCrash.lease_rows.length, 1);
  assert.equal(atCrash.lease_rows[0].agent_id, 'worker-1');
  assert.equal(atCrash.lease_rows[0].epoch, 4);

  store.deleteLease('lease-1');
  const checked = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, leases_at_crash: atCrash.lease_rows } },
    events: [{ type: 'recovered', data: { fenced_leases: 1 } }],
  });
  const fenced = checked.checks.find(entry => entry.name === 'stale-leases-fenced');
  assert.equal(fenced.passed, true, fenced.evidence);
  assert.match(fenced.evidence, /1 live at the crash/);
  const unfenced = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, leases_at_crash: atCrash.lease_rows } },
    events: [{ type: 'recovered', data: { fenced_leases: 0 } }],
  });
  assert.equal(unfenced.checks.find(entry => entry.name === 'stale-leases-fenced').passed, false,
    'a recorded live lease without a recovered fence is a failure');

  const missingClock = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, kill_at_ms: null, leases_at_crash: atCrash.lease_rows } },
    events: [
      { type: 'recovered', data: { fenced_leases: 1 } },
      { type: 'fixture-message-sent', data: { message_id: 'crash-msg', recipient: 'missing-agent' } },
    ],
  });
  const crashWindow = missingClock.checks.find(entry => entry.name === 'crash-window-exercised');
  assert.equal(crashWindow.passed, null, 'a missing crash clock cannot prove injection preceded the crash');
  assert.match(crashWindow.evidence, /kill timestamp was not recorded/);

  const ackBeforeCrash = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, kill_at_ms: 500, event_seq_at_kill: 10, leases_at_crash: atCrash.lease_rows } },
    events: [
      { type: 'recovered', data: { fenced_leases: 1 } },
      { seq: 2, type: 'fixture-message-sent', data: { message_id: 'crash-msg', recipient: 'missing-agent' } },
      { seq: 8, at: 600, type: 'delivery-flushed', data: { agent_id: 'missing-agent', message_ids: ['crash-msg'] } },
      { seq: 9, at: 1000, type: 'messages-acked', data: { agent_id: 'missing-agent', message_ids: ['crash-msg'] } },
    ],
  });
  assert.equal(ackBeforeCrash.checks.find(entry => entry.name === 'crash-window-exercised').passed, null,
    'a durable ack before the crash is not an exercised injection window, even if its timestamp appears later');

  const ackAfterCrash = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, kill_at_ms: 500, event_seq_at_kill: 10, leases_at_crash: atCrash.lease_rows } },
    events: [
      { type: 'recovered', data: { fenced_leases: 1 } },
      { seq: 2, type: 'fixture-message-sent', data: { message_id: 'crash-msg', recipient: 'missing-agent' } },
      { seq: 8, at: 600, type: 'delivery-flushed', data: { agent_id: 'missing-agent', message_ids: ['crash-msg'] } },
      { seq: 11, at: 100, type: 'messages-acked', data: { agent_id: 'missing-agent', message_ids: ['crash-msg'] } },
    ],
  });
  assert.equal(ackAfterCrash.checks.find(entry => entry.name === 'crash-window-exercised').passed, true,
    'a flushed delivery with no pre-kill ack exercised the crash window, regardless of skewed event clocks');

  const flushAfterCrash = await run({
    caseDef: { objective: 'recover' }, layout,
    report: { cluster_id: clusterId, restart: { restarted: true, kill_at_ms: 500, event_seq_at_kill: 10, leases_at_crash: atCrash.lease_rows } },
    events: [
      { type: 'recovered', data: { fenced_leases: 1 } },
      { seq: 2, type: 'fixture-message-sent', data: { message_id: 'crash-msg', recipient: 'missing-agent' } },
      { seq: 11, type: 'delivery-flushed', data: { agent_id: 'missing-agent', message_ids: ['crash-msg'] } },
    ],
  });
  assert.equal(flushAfterCrash.checks.find(entry => entry.name === 'crash-window-exercised').passed, null,
    'delivery flushed only after recovery cannot establish the pre-kill injection window');
});

test('event-triggered recovery discovers a flush after the first 500 events', async () => {
  const { waitForKillEvent } = await import('../run.mjs');
  const events = Array.from({ length: 500 }, (_, index) => ({
    seq: index + 1, type: 'turn-start',
  }));
  events.push({ seq: 501, type: 'delivery-flushed' });
  const requests = [];
  const host = {
    async request(op, clusterId, query) {
      assert.equal(op, 'events');
      assert.equal(clusterId, 'crash-cluster');
      requests.push(query.since);
      return { events: events.filter(event => event.seq > query.since).slice(0, query.limit) };
    },
  };
  let clock = 1000;
  const triggered = await waitForKillEvent(host, 'crash-cluster', 'delivery-flushed', 250, {
    now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  assert.deepEqual(requests, [0, 500], 'the runner drains the backlog without polling the same page again');
  assert.equal(triggered.observed, 1);
  assert.equal(triggered.observed_seq, 501);
  assert.equal(triggered.observed_at_ms, 0, 'the flush was seen before the fallback clock');
  assert.equal(triggered.note, undefined);

  events.pop();
  requests.length = 0;
  clock = 1000;
  const fallback = await waitForKillEvent(host, 'crash-cluster', 'delivery-flushed', 250, {
    now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  assert.deepEqual(requests, [0, 500]);
  assert.equal(fallback.observed, 0);
  assert.match(fallback.note, /killed on the clock instead/);
});

test('a closed correction needs a completed replacement, not a blocked or unknown one', async () => {
  const { answeredByReplacementWork, completedReplacementSubmissions } = await import('../checks/recursion.mjs');
  const issue = { id: 'i1', transaction_id: 'tx1', target_revision: 2 };
  // The ledger writes `result_completed` as a JSON boolean: `false` for a
  // blocked Worker result and `null` when the result carried no verdict. A
  // predicate of the form `!== 0` accepted both, so an issue could read as
  // answered by a replacement that reported itself blocked in the same breath.
  const events = [
    { seq: 10, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 2, result_completed: false } },
    { seq: 20, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 3, result_completed: false } },
    { seq: 21, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 3, result_completed: null } },
  ];
  assert.deepEqual(completedReplacementSubmissions(events, issue), [],
    'neither a blocked nor an unstated result is a completed replacement');
  assert.equal(answeredByReplacementWork({ events, issue, closedSeq: 30 }), false,
    'a closure standing on a blocked replacement proves no correction round');

  // A completed later revision, published before the verdict, is the answer.
  const answered = [...events, { seq: 25, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 4, result_completed: true } }];
  assert.equal(answeredByReplacementWork({ events: answered, issue, closedSeq: 30 }), true);
  assert.equal(answeredByReplacementWork({ events: answered, issue, closedSeq: 24 }), false,
    'a verdict recorded before the replacement was published certifies nothing');
  assert.equal(answeredByReplacementWork({ events: answered, issue, closedSeq: null }), false,
    'an issue with no closing event has no correction to claim');

  // Wrong transaction, and a revision no later than the issue's own.
  const wrong = [
    { seq: 5, type: 'result-submitted', data: { transaction_id: 'tx2', revision: 9, result_completed: true } },
    { seq: 6, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 2, result_completed: true } },
    { seq: 7, type: 'result-submitted', data: { transaction_id: 'tx1', revision: 1, result_completed: true } },
  ];
  assert.deepEqual(completedReplacementSubmissions(wrong, issue), [],
    'another transaction, the issue revision itself, and an older revision are not replacements');
});

test('a correction closed by acceptance alone is not an Auditor verification', async () => {
  const { auditorVerifiedIssue } = await import('../checks/recursion.mjs');
  const issue = { id: 'i1', transaction_id: 'tx1', target_revision: 2 };
  // The ledger stores one tool result as `{isError, text}`, and `text` is the
  // tool's own JSON — the shape every receipt below uses, taken from a real run.
  const receipt = (inner, extra = {}) => ({
    result_body: JSON.stringify({ isError: false, text: JSON.stringify(inner) }),
    error: null,
    dispatch_status: 'SETTLED',
    ...extra,
  });
  const verified = { ok: true, action: 'verify_correction', deduped: false, revision: 1, result: { revision: 1, issue_id: 'i1', status: 'CORRECTED' } };

  // The route the plan forbids: acceptance closed the issue on its way past.
  assert.deepEqual(
    auditorVerifiedIssue({ issue, receipts: [], closedEvent: { issue_id: 'i1', reason: 'accepted-result-after-issue' } }),
    { ok: false, closings: 0, reason: 'accepted-result-after-issue' },
  );
  // The Auditor's own verdict is what counts.
  assert.deepEqual(
    auditorVerifiedIssue({ issue, receipts: [receipt(verified)], closedEvent: { issue_id: 'i1' } }),
    { ok: true, closings: 1, reason: null },
  );
  // A deduped answer is the plugin saying "already closed", not a verification.
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt({ ...verified, deduped: true })], closedEvent: { issue_id: 'i1' } }).ok, false);
  // Another action's answer is not a correction verdict, even if it names the issue.
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt({ ok: true, action: 'inspect_validation', result: { issue_id: 'i1', status: 'CORRECTED' } })], closedEvent: { issue_id: 'i1' } }).ok, false);
  // A failed, unsettled, or unreadable call is not a verdict.
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt(verified, { error: 'X' })], closedEvent: { issue_id: 'i1' } }).ok, false);
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt(verified, { dispatch_status: 'DISPATCHED' })], closedEvent: { issue_id: 'i1' } }).ok, false);
  assert.equal(auditorVerifiedIssue({ issue, receipts: [{ result_body: 'not json', error: null, dispatch_status: 'SETTLED' }], closedEvent: { issue_id: 'i1' } }).ok, false);
  assert.equal(auditorVerifiedIssue({ issue, receipts: [{ result_body: JSON.stringify({ isError: true, text: JSON.stringify(verified) }), error: null, dispatch_status: 'SETTLED' }], closedEvent: { issue_id: 'i1' } }).ok, false);
  // A verdict about another issue, or one that only charged a correction round.
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt({ ...verified, result: { issue_id: 'other', status: 'CORRECTED' } })], closedEvent: { issue_id: 'i1' } }).ok, false);
  assert.equal(auditorVerifiedIssue({ issue, receipts: [receipt({ ok: true, action: 'verify_correction', result: { issue_id: 'i1', status: 'REJECTED', corrections: 1 } })], closedEvent: { issue_id: 'i1' } }).ok, false);
});
