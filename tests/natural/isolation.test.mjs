import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAgentsHome, inspectGlobalSkills } from './isolation.mjs';

test('agents home must be explicit, empty, private, and independent of the DSH home', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'b0-isolation-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, '.artifacts'), home = join(artifacts, 'home'), agents = join(artifacts, 'agents');
  await mkdir(home, { recursive: true }); await mkdir(agents);
  assert.equal(assertAgentsHome(agents, home, artifacts), agents);
  assert.throws(() => assertAgentsHome(undefined, home, artifacts), /DSH_AGENTS_HOME/);
  assert.throws(() => assertAgentsHome(home, home, artifacts), /separate/);
  const nested = join(home, 'nested'); await mkdir(nested); assert.throws(() => assertAgentsHome(nested, home, artifacts), /separate/);
  const alias = join(artifacts, 'alias'); await symlink(agents, alias, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => assertAgentsHome(alias, home, artifacts), /symlinks/);
  await writeFile(join(agents, 'unexpected'), 'fixture'); assert.throws(() => assertAgentsHome(agents, home, artifacts), /empty/);
});

test('the global gate uses SDK source metadata, allowing runtime and bundled origins rather than special names', async () => {
  const inspected = await inspectGlobalSkills({ snapshot: async () => ({ complete: true, skills: [{ name: 'ordinary-name', source: 'runtime', provider: 'fixture' }, { name: 'other-name', source: 'bundled', provider: 'filesystem' }] }) });
  assert.deepEqual(inspected.skills.map(skill => skill.source), ['runtime', 'bundled']);
  await assert.rejects(inspectGlobalSkills({ snapshot: async () => ({ complete: true, skills: [{ name: 'agent-team', source: 'user-agents', provider: 'filesystem' }] }) }), /Unexpected global skill origin/);
  await assert.rejects(inspectGlobalSkills({}), /snapshot API/);
});
