import assert from 'node:assert/strict';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function assertAgentsHome(input, home, artifacts) {
  assert.equal(typeof input, 'string', 'DSH_AGENTS_HOME must name a dedicated empty directory');
  const target = resolve(input), child = relative(artifacts, target);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), 'DSH_AGENTS_HOME must stay below this workspace .artifacts');
  let current = artifacts;
  for (const part of child.split(sep)) {
    current = resolve(current, part);
    const state = lstatSync(current);
    assert.ok(state.isDirectory() && !state.isSymbolicLink(), 'DSH_AGENTS_HOME cannot contain symlinks');
  }
  assert.equal(realpathSync(target), target);
  const fromHome = relative(resolve(home), target), toHome = relative(target, resolve(home));
  const outside = value => value === '..' || value.startsWith('..' + sep) || isAbsolute(value);
  assert.ok(outside(fromHome) && outside(toHome), 'DSH_AGENTS_HOME must be separate from DSH_HOME');
  assert.equal(readdirSync(target).length, 0, 'DSH_AGENTS_HOME must remain empty');
  return target;
}

export async function inspectGlobalSkills(registry) {
  assert.equal(typeof registry?.snapshot, 'function', 'The SDK skill registry snapshot API is required');
  const catalog = await registry.snapshot();
  assert.equal(catalog.complete, true, 'Global skill discovery must be complete');
  assert.ok(Array.isArray(catalog.skills), 'The SDK skill catalog must contain summaries');
  const skills = catalog.skills.map(({ name, source, provider }) => ({ name, source, provider }));
  assert.ok(skills.every(skill => ['runtime', 'bundled'].includes(skill.source)), 'Unexpected global skill origin');
  return { observedAt: Date.now(), complete: true, skills };
}
