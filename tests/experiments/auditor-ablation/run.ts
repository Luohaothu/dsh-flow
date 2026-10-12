// Historical schema-4 driver. Excluded from current production compilation; run only in the frozen baseline.
/** Run three paired local-model ablations; never changes the user's live host. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DshHost, buildHostEnv, createRunLayout, ensureProfile, WEB_PROFILE_BUNDLES, PROJECT_ROOT } from '../../../src/host/host.ts';
import { ipcBridgePatchText, startAcceptanceHost } from '../../../tests/acceptance/run.ts';
import { computeBuildHashes, buildDrift } from '../../../tests/acceptance/build-fingerprint.ts';
import { fixtures, sha256, SCENARIOS } from './fixtures.ts';
import { summarize } from './score.ts';
import { snapshotRecipe } from './settings.ts';
import type { ResearchCorpus, Trial, TrialTurn } from './types.ts';

delete process.env.DSH_INSTALL_PATH;
const serverSettings = process.env.FLOW_OMLX_SETTINGS ?? '/Users/luohao/.omlx/settings.json';
const key = process.env.FLOW_MODEL_API_KEY ?? JSON.parse(readFileSync(serverSettings, 'utf8')).auth.api_key;
assert(typeof key === 'string' && key.length > 0, 'Configure the local model credential');
const model = process.env.FLOW_MODEL_ID ?? 'Qwen3.8-27B-4bit';
const modelSettings = process.env.FLOW_OMLX_MODEL_SETTINGS ?? '/Users/luohao/.omlx/model_settings.json';
const readRecipe = () => snapshotRecipe(JSON.parse(readFileSync(modelSettings, 'utf8')), JSON.parse(readFileSync(serverSettings, 'utf8')), model);
const recipe = readRecipe();
const baseURL = process.env.FLOW_MODEL_BASE_URL ?? 'http://127.0.0.1:8000/v1';
const pilot = process.argv.includes('--pilot');
const runId = `auditor-ablation-${pilot ? 'pilot-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}`;
const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts'), runId);
chmodSync(layout.root, 0o700);
const sourceRoot = resolve('tests/experiments/auditor-ablation');
const corpus = JSON.parse(readFileSync(join(sourceRoot, 'research-sources.json'), 'utf8')) as ResearchCorpus;
const allFixtures = fixtures(corpus);
assert(allFixtures.filter(item => item.oracle.releasable).length === 3, 'Each scenario must have exactly one clean control');
const manifest = (pilot ? allFixtures.filter(item => item.id === 'proof-clean') : allFixtures).flatMap(fixture =>
  Array.from({ length: pilot ? 1 : 2 }, (_, index) => ({ fixture, repetition: index + 1, order: index % 2 ? ['self_review', 'auditor'] as const : ['auditor', 'self_review'] as const })));
// Interleave fixture types and domains instead of exhausting one arm first.
manifest.sort((a, b) => a.repetition - b.repetition || a.fixture.variant.localeCompare(b.fixture.variant) || a.fixture.scenario.localeCompare(b.fixture.scenario));
const experimentFiles = ['types.ts', 'fixtures.ts', 'host.ts', 'score.ts', 'run.ts', 'settings.ts', 'research-sources.json'];
const experimentHashes = () => Object.fromEntries(experimentFiles.map(name => [name, sha256(readFileSync(join(sourceRoot, name), 'utf8'))]));
const codeBefore = experimentHashes();
let pilotEvidence: { path: string; sha256: string } | null = null;
if (!pilot) {
  for (const name of readdirSync(join(PROJECT_ROOT, '.artifacts')).filter(name => name.startsWith('auditor-ablation-pilot-')).sort().reverse()) {
    const path = join(PROJECT_ROOT, '.artifacts', name, 'report.json');
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.status !== 'COMPLETED' || !value.pilot || value.model !== model || value.summary.complete_pairs !== 1) continue;
    const manifest = JSON.parse(readFileSync(join(dirname(path), 'frozen-manifest.json'), 'utf8'));
    const pilotRecipe = JSON.parse(readFileSync(join(dirname(path), 'model-recipe-before.json'), 'utf8'));
    if (JSON.stringify(recipe) !== JSON.stringify(pilotRecipe)) continue;
    if (JSON.stringify(manifest.code_sha256) !== JSON.stringify(codeBefore) || manifest.protocol_sha256 !== sha256(readFileSync('docs/experiments/auditor-ablation-protocol.md', 'utf8'))) continue;
    pilotEvidence = { path, sha256: sha256(readFileSync(path, 'utf8')) }; break;
  }
  assert(pilotEvidence, 'First complete a --pilot with all three native stages; failed or outdated pilots cannot enable the formal comparison.');
}
const profile = 'auditor-ablation';
ensureProfile(layout.home, profile, { bundles: [...WEB_PROFILE_BUNDLES, 'dsh-flow'], packagePath: resolve('.artifacts/local-rc2/package') });
const patch = join(layout.root, 'experiment.patch.yml');
writeFileSync(patch, `${ipcBridgePatchText()}\n- insert:\n    - id: auditor-ablation\n      name: ${JSON.stringify(join(sourceRoot, 'host.ts'))}\n      config:\n        workspace: ${JSON.stringify(layout.workspace)}\n        home: ${JSON.stringify(layout.home)}\n        database: ${JSON.stringify(join(layout.data, 'fixture-runtime.sqlite'))}\n        requestsPath: ${JSON.stringify(join(layout.logs, 'model-requests.jsonl'))}\n        provider: omlx\n        model: ${JSON.stringify(model)}\n`);
const patches = [resolve('examples/instance.patch.yml'), resolve('examples/omlx.patch.yml'), patch];
const before = computeBuildHashes({ id: '' }, patches);
const runtimeIdentity = JSON.parse(readFileSync('.artifacts/local-rc2/runtime-identity.json', 'utf8')) as { commit: string; archive_sha256: string; entries: Record<string, string> };
for (const [name, digest] of Object.entries(runtimeIdentity.entries)) assert.equal(sha256(readFileSync(`.artifacts/local-rc2/package/lib/${name}`, 'utf8')), digest);
const frozen = { protocol: 'docs/experiments/auditor-ablation-protocol.md', protocol_sha256: sha256(readFileSync('docs/experiments/auditor-ablation-protocol.md', 'utf8')),
  run_id: runId, pilot, pilot_evidence: pilotEvidence, created_at: new Date().toISOString(), source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runtime_identity: runtimeIdentity, code_sha256: codeBefore, model, baseURL, manifest: manifest.map(item => ({ fixture_id: item.fixture.id, repetition: item.repetition, order: item.order, packet_sha256: sha256(JSON.stringify(item.fixture.packet)), oracle: item.fixture.oracle })) };
writeFileSync(join(layout.root, 'frozen-manifest.json'), JSON.stringify(frozen, null, 2) + '\n');
writeFileSync(join(layout.root, 'frozen-fixtures.json'), JSON.stringify(allFixtures, null, 2) + '\n');
writeFileSync(join(layout.root, 'model-recipe-before.json'), JSON.stringify(recipe, null, 2) + '\n');
const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace,
  modelRoute: { provider: 'omlx', model, baseURL }, modelApiKey: key });
env.FLOW_CONTEXT_MODEL = '262144';
env.FLOW_MAX_TOKENS = '2048';
const host = new DshHost({ profile, patches, cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log'), sanitizeLog: text => text.replaceAll(key, '[redacted]') });
const request = <T>(payload: Record<string, unknown>): Promise<T> => {
  const child = host.child; assert(child?.connected);
  const requestId = randomUUID();
  return new Promise((resolveReply, rejectReply) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); };
    const timer = setTimeout(() => { cleanup(); rejectReply(new Error('Experiment IPC timed out')); }, 145_000);
    const exited = () => { cleanup(); rejectReply(new Error('Experimental host exited')); };
    const receive = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('ablation' in value) || value.ablation !== true || !('requestId' in value) || value.requestId !== requestId) return;
      const reply = value as unknown as { ok: boolean; value: T; error: string }; cleanup();
      reply.ok ? resolveReply(reply.value) : rejectReply(new Error(reply.error));
    };
    child.on('message', receive); child.once('exit', exited); child.send({ ablation: true, requestId, ...payload });
  });
};
const trials: Trial[] = [];
let failure: string | null = null;
console.log(JSON.stringify({ run_id: runId, planned_pairs: manifest.length, report: join(layout.root, 'report.json'), pilot }));
try {
  const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert((await response.json()).data.some((entry: { id: string }) => entry.id === model));
  const statusURL = new URL('/api/status', baseURL).toString();
  const status = await fetch(statusURL, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(status.status, 200, 'Need the local oMLX status endpoint to establish service availability.');
  const service = await status.json() as { active_requests: number; waiting_requests: number };
  writeFileSync(join(layout.root, 'service-status-before.json'), JSON.stringify(service, null, 2) + '\n');
  assert.equal(service.active_requests, 0, 'oMLX has another active request; finish it before running paired experiments.');
  assert.equal(service.waiting_requests, 0, 'oMLX has waiting requests; finish them before running paired experiments.');
  await startAcceptanceHost(host); chmodSync(join(layout.logs, 'host.log'), 0o600);
  for (const item of manifest) {
    const { pair_id: pairId } = await request<{ pair_id: string }>({ operation: 'create', packet: item.fixture.packet });
    const baseline = await request<TrialTurn>({ operation: 'stage', pairId, mode: 'baseline' });
    console.log(JSON.stringify({ fixture: item.fixture.id, repetition: item.repetition, stage: 'baseline', accepted: baseline.decision?.accepted, error: baseline.error }));
    const following: Partial<Record<'self_review' | 'auditor', TrialTurn>> = {};
    for (const mode of item.order) {
      following[mode] = await request<TrialTurn>({ operation: 'stage', pairId, mode });
      console.log(JSON.stringify({ fixture: item.fixture.id, repetition: item.repetition, stage: mode, accepted: following[mode]!.decision?.accepted, error: following[mode]!.error }));
    }
    const trial: Trial = { fixture_id: item.fixture.id, scenario: item.fixture.scenario, variant: item.fixture.variant, repetition: item.repetition,
      packet_sha256: sha256(JSON.stringify(item.fixture.packet)), oracle: item.fixture.oracle, baseline, self_review: following.self_review!, auditor: following.auditor!, order: item.order };
    trials.push(trial); appendFileSync(join(layout.root, 'trials.jsonl'), JSON.stringify(trial) + '\n');
    writeFileSync(join(layout.root, 'progress.json'), JSON.stringify({ completed: trials.length, planned: manifest.length, last_fixture: trial.fixture_id, summary: summarize(trials) }, null, 2) + '\n');
  }
} catch (caught) { failure = (caught instanceof Error ? caught.stack ?? caught.message : String(caught)).replaceAll(key, '[redacted]'); process.exitCode = 1; }
finally { await host.stop(); }
const drift = buildDrift(before, computeBuildHashes({ id: '' }, patches));
const experimentDrift = JSON.stringify(codeBefore) !== JSON.stringify(experimentHashes());
const protocolDrift = frozen.protocol_sha256 !== sha256(readFileSync(frozen.protocol, 'utf8'));
const summary = summarize(trials);
const recipeAfter = readRecipe();
writeFileSync(join(layout.root, 'model-recipe-after.json'), JSON.stringify(recipeAfter, null, 2) + '\n');
const recipeDrift = JSON.stringify(recipe) !== JSON.stringify(recipeAfter);
const completeRun = trials.length === manifest.length && !failure && !drift && !experimentDrift && !protocolDrift && !recipeDrift;
const report = { status: completeRun ? summary.complete_pairs === manifest.length ? 'COMPLETED' : 'COMPLETED_WITH_STAGE_ERRORS' : 'INCOMPLETE', run_id: runId, pilot, model, baseURL, source_commit: frozen.source_commit,
  runtime_identity: runtimeIdentity, frozen_manifest_sha256: sha256(readFileSync(join(layout.root, 'frozen-manifest.json'), 'utf8')),
  build_before: before, build_drift: drift, experiment_code_drift: experimentDrift, model_recipe_drift: recipeDrift, protocol_drift: protocolDrift,
  output_token_ceiling: 2048, failure, summary,
  scenarios: Object.fromEntries(SCENARIOS.map(scenario => [scenario, summarize(trials.filter(trial => trial.scenario === scenario))])), trials,
  scope: 'Local paired acceptance-stage ablation on frozen submissions. Decisions use native DSH/Flow runTurn and experimental tools; no production transaction is auto-accepted, no production audit gate is bypassed, no Worker repair or end-to-end task completion is measured.' };
writeFileSync(join(layout.root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
if (!completeRun || summary.complete_pairs !== manifest.length) process.exitCode = 1;
console.log(JSON.stringify({ run_id: runId, status: report.status, report: join(layout.root, 'report.json'), complete_pairs: report.summary.complete_pairs, failure }));
