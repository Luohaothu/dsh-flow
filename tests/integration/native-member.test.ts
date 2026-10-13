/** Standard DSH preset baseline versus Flow's thin native Agent factory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES, object } from '../../src/host/host.ts';

test('native members inherit the standard preset and native tools, retain their Agent, cancel and cold-resume', { timeout: 150_000 }, async () => {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts/native-member'), `preset-${Date.now()}`);
  const plugin = join(layout.root, 'probe.mjs');
  await build({ entryPoints: [join(PROJECT_ROOT, 'tests/integration/fixtures/native-member-probe.ts')], outfile: plugin,
    bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/*', 'node:*'], logLevel: 'silent' });
  const profile = 'native-member';
  ensureProfile(layout.home, profile, { bundles: [...WEB_PROFILE_BUNDLES] });
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace });
  for (const phase of ['fresh', 'cold']) {
    const reportPath = join(layout.root, `${phase}.json`);
    const patch = join(layout.root, `${phase}.patch.yml`);
    writeFileSync(patch, `- id: hmr\n  disabled: true\n- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: ${JSON.stringify(layout.workspace)}\n- id: permission\n  config:\n    defaultPreset: workspace-write\n- id: agent-default-model\n  config:\n    provider: native-member-probe\n    model: scripted\n- insert:\n    - id: native-member-probe\n      name: ${JSON.stringify(plugin)}\n      config:\n        workspace: ${JSON.stringify(layout.workspace)}\n        report: ${JSON.stringify(reportPath)}\n        phase: ${phase}\n`);
    const host = new DshWebHost({ profile, patches: [patch], cwd: layout.workspace, env, logPath: join(layout.logs, `${phase}.log`) });
    try {
      await host.start();
      const deadline = Date.now() + 45_000;
      while (!existsSync(reportPath) && Date.now() < deadline) await delay(50);
      assert.ok(existsSync(reportPath), `${phase} native probe did not finish; inspect ${layout.logs}`);
      const report = object(JSON.parse(readFileSync(reportPath, 'utf8')));
      assert.equal(report.status, 'PASSED', JSON.stringify(report));
    } finally { await host.stop(); }
  }
});
