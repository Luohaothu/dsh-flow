/** Actual installed MCP browser provider, ordinary standard Agent versus Flow member. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { buildHostEnv, createRunLayout, DshWebHost, ensureProfile, PROJECT_ROOT, WEB_PROFILE_BUNDLES, object } from '../../src/host/host.ts';
import { browserExecutablePath } from '../../src/host/browser.ts';

test('ordinary and Flow native Agents actually navigate and read with the same MCP browser provider', { timeout: 120_000 }, async () => {
  const layout = createRunLayout(join(PROJECT_ROOT, '.artifacts/native-browser'), `preset-${Date.now()}`);
  const socketDir = mkdtempSync('/private/tmp/dsh-mcp-');
  const executable = browserExecutablePath();
  const requests: string[] = [];
  const page = createServer((request, response) => {
    const label = request.url === '/ordinary' ? 'ORDINARY' : request.url === '/member' ? 'MEMBER' : null;
    if (!label) { response.writeHead(404); response.end('Not found'); return; }
    requests.push(request.url!);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Native browser ${label}</title><main><h1>Native MCP page</h1><p>NATIVE-BROWSER-${label}-VISIBLE</p></main>`);
  });
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
  const address = page.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const plugin = join(layout.root, 'probe.mjs'), reportPath = join(layout.root, 'report.json');
  await build({ entryPoints: [join(PROJECT_ROOT, 'tests/integration/fixtures/native-browser-probe.ts')], outfile: plugin,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  ensureProfile(layout.home, 'native-browser', { bundles: [...WEB_PROFILE_BUNDLES] });
  const env = buildHostEnv({ home: layout.home, tmpdir: layout.tmp, dataDir: layout.data, workspace: layout.workspace, extra: { PWTEST_SOCKETS_DIR: socketDir } });
  const patch = join(layout.root, 'probe.patch.yml');
  writeFileSync(patch, `- id: hmr\n  disabled: true\n- id: sandbox-policy\n  config:\n    mode: workspace-write\n    workspaceRoot: ${JSON.stringify(layout.workspace)}\n- id: permission\n  config:\n    defaultPreset: workspace-write\n- id: agent-default-model\n  config:\n    provider: native-browser-probe\n    model: scripted-browser\n- insert:\n    - id: browser-use\n      name: '@deepseek-ai/dsh-browser-use'\n    - id: browser-use-playwright-mcp\n      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'\n      config:\n        mode: launch\n        headless: true\n${executable ? `        executablePath: ${JSON.stringify(executable)}\n` : ''}    - id: native-browser-probe\n      name: ${JSON.stringify(plugin)}\n      config:\n        workspace: ${JSON.stringify(layout.workspace)}\n        report: ${JSON.stringify(reportPath)}\n        evidence: ${JSON.stringify(join(layout.root, 'native-browser-events.json'))}\n        origin: ${JSON.stringify(origin)}\n`);
  const host = new DshWebHost({ profile: 'native-browser', patches: [patch], cwd: layout.workspace, env, logPath: join(layout.logs, 'host.log') });
  try {
    await host.start();
    const deadline = Date.now() + 75_000;
    while (!existsSync(reportPath) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(reportPath), `Native browser probe did not finish; inspect ${layout.root}`);
    const report = object(JSON.parse(readFileSync(reportPath, 'utf8')));
    assert.equal(report.status, 'PASSED', JSON.stringify(report));
    assert.ok(requests.includes('/ordinary'));
    assert.ok(requests.includes('/member'));
  } finally {
    writeFileSync(join(layout.root, 'page-requests.json'), JSON.stringify({ origin, paths: requests }, null, 2));
    await host.stop();
    await new Promise<void>((resolve, reject) => page.close(error => error ? reject(error) : resolve()));
    rmSync(socketDir, { recursive: true, force: true });
  }
});
