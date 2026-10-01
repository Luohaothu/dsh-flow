#!/usr/bin/env node
/**
 * Link this project to an installed DeepSeek Harness so that the plugin, the
 * unit tests and the bundler resolve the *same* harness module instances as the
 * host does (single React, single Cordis, single tool runtime).
 *
 * The harness installation is located with DSH_INSTALL_PATH (default
 * /home/leo/projects/deepseek-harness/apps/cli) — a project convention, since
 * DSH itself anchors resolution on the running launcher, not on an env var.
 */
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installPath = resolve(process.env.DSH_INSTALL_PATH ?? '/home/leo/projects/deepseek-harness/apps/cli');
const harnessRoot = dirname(dirname(installPath));

if (!existsSync(join(installPath, 'package.json'))) {
  console.error(`link-dsh: no DSH installation at ${installPath} (set DSH_INSTALL_PATH to apps/cli)`);
  process.exit(1);
}

const packageLinks = [
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
  ['@deepseek-ai/dsh-session', 'packages/core/session'],
  ['@deepseek-ai/dsh-token-meter', 'packages/llm/token-meter'],
  ['@deepseek-ai/dsh-compaction', 'packages/compaction/compaction'],
  ['@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
  // Capability tool packages a cluster agent mounts into its own scope.
  ['@deepseek-ai/dsh-tool-fs', 'packages/fs/tool-fs'],
  ['@deepseek-ai/dsh-tool-fs-search', 'packages/fs/tool-fs-search'],
  ['@deepseek-ai/dsh-tool-bash', 'packages/shell/tool-bash'],
  ['@deepseek-ai/dsh-tool-jobs', 'packages/jobs/tool-jobs'],
  ['@deepseek-ai/dsh-tool-web', 'packages/web/tool-web'],
];

const pnpmModules = join(harnessRoot, 'node_modules/.pnpm');
const esbuildCandidates = existsSync(pnpmModules)
  ? ['esbuild@0.25.12', 'esbuild@0.28.1', 'esbuild@0.21.5']
    .map(name => join(pnpmModules, name, 'node_modules/esbuild'))
    .filter(existsSync)
  : [];

const playwrightCandidates = existsSync(pnpmModules)
  ? ['playwright@1.61.1', 'playwright@1.63.0-alpha-2026-08-31']
    .map(name => join(pnpmModules, name, 'node_modules/playwright'))
    .filter(existsSync)
  : [];
const extraLinks = [
  ...(esbuildCandidates.length ? [['esbuild', esbuildCandidates[0], true]] : []),
  ...(playwrightCandidates.length ? [['playwright-core', join(pnpmModules, 'playwright-core@1.61.1/node_modules/playwright-core'), true], ['playwright', playwrightCandidates[0], true]].filter(([, target]) => existsSync(join(target, 'package.json'))) : []),
];

const linked = [];
for (const [name, relative, absolute] of [...packageLinks.map(entry => [...entry, false]), ...extraLinks]) {
  const target = absolute ? relative : join(harnessRoot, relative);
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`link-dsh: missing ${name} target ${target}`);
    process.exit(1);
  }
  const linkPath = join(projectRoot, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath) || isDangling(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, 'dir');
  linked.push(`${name} -> ${target}`);
}

console.log(`link-dsh: ${linked.length} links from ${harnessRoot}`);
for (const line of linked) console.log(`  ${line}`);

function isDangling(path) {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}