import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Document } from 'yaml';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { expandPattern } from '../../../packages/dsh-flow/src/patterns/expand.js';
import { catalogControl, definitionDigest } from '../../../packages/dsh-flow/src/patterns/internal.js';
import type { JsonObject, PatternDefinition, PatternCompileResult, PatternDocument } from '../../../packages/dsh-flow/src/patterns/types.js';
import type { AgentProfile } from '../../../packages/dsh-flow/src/core/types.js';
import { sessionID } from '../../../packages/dsh-flow/src/core/message.js';

const defaults = { model: { provider: 'test', id: 'model' }, params: { version: 1 as const, temperature: 0.5 }, permission: 'workspace-write' as const };
const rootProfile: AgentProfile = { ...defaults, sessionID: sessionID('root'), role: 'root', name: 'root' };
function catalog(): PatternCatalog { return new PatternCatalog({ includeBuiltins: false }); }
function value(extra: JsonObject = {}): JsonObject { return { apiVersion: 'v1', id: 'test/base', description: 'description', whenToUse: 'when', roles: { worker: { instructions: 'work', permission: 'read-only' } }, root: { instructions: 'manage', workers: { role: 'worker' } }, ...extra }; }
function definition(result: PatternCompileResult): PatternDefinition { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('compilation failed'); return result.definition; }
function compile(doc: JsonObject): PatternDefinition { return definition(catalog().compile({ kind: 'object', value: doc }, {})); }
function expand(def: PatternDefinition, parameters: JsonObject = {}) { return expandPattern(def, parameters, {}, defaults, rootProfile); }

test('public compilation rejects malformed document envelopes with field diagnostics', () => {
  const invalid: [unknown, string][] = [
    [null, 'document'], [[], 'document'], [42, 'document'], [new Date(), 'document'],
    [{}, 'document.kind'], [{ kind: 'other', text: '' }, 'document.kind'],
    [{ kind: 'yaml' }, 'document.text'], [{ kind: 'yaml', text: 42 }, 'document.text'],
    [{ kind: 'object' }, 'document.value'], [{ kind: 'object', value: [] }, 'document.value'],
    [{ kind: 'object', value: new Date() }, 'document.value'],
    [{ kind: 'object', value: value(), path: 42 }, 'document.path'],
    [{ kind: 'yaml', text: '', path: null }, 'document.path'],
    [{ kind: 'object', value: value(), extra: true }, 'document.extra'],
  ];
  for (const [document, path] of invalid) {
    const result = catalog().compile(document as PatternDocument);
    assert.equal(result.ok, false, String(document));
    if (result.ok) throw new Error('Malformed document compiled');
    assert.equal(result.diagnostics[0]!.path, path);
    assert.doesNotMatch(result.diagnostics[0]!.message, /Cannot read|undefined/);
  }
});

test('count is a nonnegative integer and zero prunes descendants and their dynamic inputs', () => {
  const def = compile(value({ parameters: { count: { type: 'integer', description: 'count' } }, root: { instructions: 'root', workers: { role: 'worker', count: '{{ count }}', child: { role: 'worker', count: 999 } } } }));
  assert.equal(expand(def, { count: 0 }).nodes.length, 0);
  assert.throws(() => expand(def, { count: -1 }), /nonnegative/);
  assert.throws(() => expand(def, { count: 1.5 }), /integer/);
  assert.equal(catalog().compile({ kind: 'object', value: value({ root: { workers: { role: 'worker', count: null } } }) }, {}).ok, false);
});

test('all seven parameter types, defaults, missing and unknown parameters are enforced', () => {
  const def = compile(value({ parameters: { s: { type: 'string', description: 's', default: 's' }, i: { type: 'integer', description: 'i', default: 1 }, n: { type: 'number', description: 'n', default: 1.5 }, b: { type: 'boolean', description: 'b', default: false }, a: { type: 'array', description: 'a', default: [] }, o: { type: 'object', description: 'o', default: {} }, z: { type: 'null', description: 'z' } } }));
  assert.throws(() => expand(def), /Missing required/); assert.throws(() => expand(def, { z: null, extra: 1 }), /Unknown parameter/);
  assert.equal(expand(def, { z: null }).nodes.length, 1);
  assert.throws(() => expand(def, { z: null, i: '1' }), /integer/);
  assert.equal(catalog().compile({ kind: 'object', value: value({ parameters: { c: { type: 'integer', description: 'c', default: 1.1 } } }) }).ok, false);
});

test('references bind private parameter scopes, append root guidance and expose complete paths', () => {
  const inner = value({ id: 'test/inner', parameters: { n: { type: 'integer', description: 'n' } }, root: { instructions: 'inner root', members: { role: 'worker', count: '{{ n }}' } }, groups: [{ key: 'discussion', members: ['root', 'root/members/*'] }] });
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [{ document: { kind: 'object', value: inner } }] });
  const outer = definition(cat.compile({ kind: 'object', value: value({ parameters: { n: { type: 'integer', description: 'n', default: 2 } }, root: { instructions: 'outer', leads: { role: 'worker', count: 2, use: { id: 'test/inner', with: { n: '{{ n }}' } } } }, groups: [{ key: 'coordination', members: ['root', 'root/leads/*/members/*'] }] }) }));
  const result = expand(outer); assert.equal(result.nodes.length, 6); assert.equal(result.nodes[0]!.config.role, 'work\n\ninner root');
  assert.deepEqual(result.nodes.slice(0, 3).map(n => n.path), ['root/leads/0', 'root/leads/0/members/0', 'root/leads/0/members/1']);
  assert.equal(result.instructions, 'outer'); assert.deepEqual(result.groups.map(g => g.key), ['root/coordination', 'root/leads/0/discussion', 'root/leads/1/discussion']);
});

test('forEach uses relative members and wildcard matches only one ordinal', () => {
  const def = compile(value({ root: { leaders: { role: 'worker', count: 2, children: { role: 'worker', count: 2 } } }, groups: [{ key: 'team', forEach: 'root/leaders/*', members: ['.', './children/*'] }, { key: 'empty', members: ['root/missing/*'] }] }));
  const result = expand(def); assert.equal(result.groups.length, 3);
  assert.deepEqual(result.groups[0]!.members, ['root/leaders/0', 'root/leaders/0/children/0', 'root/leaders/0/children/1']);
  assert.deepEqual(result.groups[2]!.members, []);
  const dangling = compile(value({ groups: [{ key: 'bad', members: ['root/missing/0'] }] })); assert.throws(() => expand(dangling), /Dangling exact/);
});

test('run, role and full path overrides replace complete fields without merging', () => {
  const def = compile(value({ roles: { worker: { instructions: 'work', permission: 'read-only', params: { version: 1 }, hostExtras: { role: 1 }, skills: ['role-skill'] } } }));
  const result = expandPattern(def, {}, { 'root/workers/0': { params: { version: 1, maxTokens: 10 }, hostExtras: { override: true }, skills: ['override'] } }, { ...defaults, hostExtras: { run: 1 }, skills: ['run'] }, rootProfile);
  assert.deepEqual(result.nodes[0]!.config.params, { version: 1, maxTokens: 10 }); assert.deepEqual(result.nodes[0]!.config.hostExtras, { override: true }); assert.deepEqual(result.nodes[0]!.requirements.skills, ['override']);
  assert.throws(() => expandPattern(def, {}, { root: { instructions: 'replace root' } }, defaults, rootProfile), /root cannot be overridden/);
  assert.throws(() => expandPattern(def, {}, { 'root/workers/1': {} }, defaults, rootProfile), /does not name/);
  assert.throws(() => expandPattern(def, {}, { 'root/workers/0': { permission: 'full-access' } }, defaults, rootProfile), /permission exceeds/);
});

test('compile has no registration effect and run catalogs preserve visible identity with candidate isolation', () => {
  const base = catalog(); const candidate = definition(base.compile({ kind: 'object', value: value() })); const digest = definitionDigest(candidate);
  assert.equal(base.resolve(candidate.id).ok, false); const first = base[catalogControl].snapshot(); const second = base[catalogControl].snapshot();
  first[catalogControl].register(candidate); first[catalogControl].assertVisible(candidate); assert.equal(second.resolve(candidate.id).ok, false);
  assert.throws(() => second[catalogControl].assertVisible(candidate), /not visible/); assert.throws(() => first[catalogControl].register(candidate), /Duplicate/);
  const inherited = first[catalogControl].snapshot(); inherited[catalogControl].assertVisible(candidate); assert.equal(definitionDigest(candidate), digest);
  assert.throws(() => expand({ ...candidate } as PatternDefinition), /authentic/); assert.equal(Object.isFrozen(candidate), true);
});

test('candidate assets compile dependencies and remain immutable after source mutation', () => {
  const assets = { 'guidance.md': 'frozen guidance', 'deps/inner/pattern.yaml': 'apiVersion: v1\nid: test/inner\ndescription: inner\nwhenToUse: inner\nroles: {}\nroot:\n  instructions: inner' };
  const doc = value({ roles: { worker: { instructions: { file: 'guidance.md' } } }, root: { workers: { role: 'worker', use: { id: 'test/inner' } } } });
  const def = definition(catalog().compile({ kind: 'object', value: doc }, assets)); assets['guidance.md'] = 'changed';
  assert.equal(expand(def).nodes[0]!.config.role, 'frozen guidance\n\ninner');
  assert.equal(catalog().compile({ kind: 'object', value: value({ root: { workers: { role: 'worker', use: { id: 'test/inner' }, nested: { role: 'worker' } } } }) }, assets).ok, false);
});

test('static validation rejects unknown roles, fields, missing assets, reference cycles and duplicate ids', () => {
  for (const doc of [value({ wrong: true }), value({ root: { workers: { role: 'missing' } } }), value({ roles: { worker: { instructions: { file: '../outside' } } } }), value({ roles: { worker: { bogus: true } } }), value({ root: { workers: { role: 'worker', use: { id: 'test/base' } } } })]) assert.equal(catalog().compile({ kind: 'object', value: doc }).ok, false);
  const duplicates = new PatternCatalog({ includeBuiltins: false, sources: [{ document: { kind: 'object', value: value() } }, { document: { kind: 'object', value: value() } }] }); const listed = duplicates.list(); assert.ok(listed.ok); if (!listed.ok) throw new Error('list failed'); assert.equal(listed.patterns.length, 0); assert.equal(listed.diagnostics.length, 2); assert.equal(duplicates.resolve('test/base').ok, false);
});

test('YAML duplicate keys, non JSON values and cyclic aliases are rejected', () => {
  const cat = catalog(); assert.equal(cat.compile('apiVersion: v1\nid: test/a\nid: test/b').ok, false);
  const cyclic = cat.compile('apiVersion: v1\nid: test/a\ndescription: d\nwhenToUse: w\nroles: {}\nroot: &root\n  children: *root');
  assert.equal(cyclic.ok, false); if (!cyclic.ok) assert.match(cyclic.diagnostics[0]!.message, /YAML aliases are not supported/);
  assert.equal(cat.compile({ kind: 'object', value: value({ parameters: { n: { type: 'number', description: 'n', default: Infinity } } }) }).ok, false);
  assert.equal(cat.compile('apiVersion: v1\nid: test/a\ndescription: !unsupported text\nwhenToUse: w\nroles: {}\nroot: {}').ok, false);
  assert.equal(cat.compile('apiVersion: v1\nid: test/a\ndescription: d\nwhenToUse: w\nparameters:\n  number:\n    type: number\n    description: n\n    default: .inf\nroles: {}\nroot: {}').ok, false);
});

test('finite YAML aliases are explicitly rejected while unused anchors remain valid', () => {
  const prefix = 'apiVersion: v1\nid: test/alias\ndescription: &description description\n';
  const alias = catalog().compile(`${prefix}whenToUse: *description\nroles: {}\nroot: {}`);
  assert.equal(alias.ok, false); if (!alias.ok) assert.match(alias.diagnostics[0]!.message, /YAML aliases are not supported/);
  assert.equal(catalog().compile(`${prefix}whenToUse: when\nroles: {}\nroot: {}`).ok, true);
});

test('YAML alias chains fail before any toJS conversion', t => {
  const lines = ['apiVersion: v1', 'id: test/alias-chain', 'description: d', 'whenToUse: w', 'roles: {}', 'root: {}', 'parameters:', '  payload:', '    type: object', '    description: payload', '    default:', '      level0: &level0 [leaf]'];
  for (let depth = 1; depth <= 20; depth++) lines.push(`      level${depth}: &level${depth} [*level${depth - 1}, *level${depth - 1}]`);
  const conversion = t.mock.method(Document.prototype, 'toJS', () => { throw new Error('Alias-chain conversion must never run'); });
  const result = catalog().compile(lines.join('\n'));
  assert.equal(conversion.mock.callCount(), 0);
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.diagnostics[0]!.message, /YAML aliases are not supported/);
});

test('deep YAML without aliases still compiles and expands', () => {
  const lines = ['apiVersion: v1', 'id: test/deep-yaml', 'description: d', 'whenToUse: w', 'roles:', '  worker:', '    instructions: work', '    permission: read-only', 'root:'];
  for (let depth = 0; depth < 300; depth++) { const indent = '  '.repeat(depth + 1); lines.push(`${indent}level${depth}:`, `${indent}  role: worker`); }
  assert.equal(expand(definition(catalog().compile(lines.join('\n')))).nodes.length, 300);
});

test('Unicode node names are supported and structural names fail', () => {
  assert.equal(expand(compile(value({ root: { 研究者: { role: 'worker' } } }))).nodes[0]!.path, 'root/研究者/0');
  for (const key of ['a/b', '*', '..', 'count']) assert.equal(catalog().compile({ kind: 'object', value: value({ root: { [key]: { role: 'worker' } } }) }).ok, false);
});

test('count overflow fails during precomputation, and templates have no fixed depth limit', () => {
  const overflowing = compile(value({ root: { nodes: { role: 'worker', count: Number.MAX_SAFE_INTEGER, children: { role: 'worker', count: 2 } } } })); assert.throws(() => expand(overflowing), /representability/);
  const arrayOverflow = compile(value({ root: { nodes: { role: 'worker', count: 2 ** 32 } } })); assert.throws(() => expand(arrayOverflow), /array length representability/);
  const root: JsonObject = {}; let at = root;
  for (let i = 0; i < 300; i++) { const node: JsonObject = { role: 'worker' }; at[`level${i}`] = node; at = node; }
  assert.equal(expand(compile(value({ root }))).nodes.length, 300);
});

test('filesystem loader uses package assets and rejects escaping symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pattern-loader-'));
  try {
    const pkg = join(directory, 'pkg'); mkdirSync(pkg); writeFileSync(join(pkg, 'pattern.yaml'), JSON.stringify(value({ roles: { worker: { instructions: { file: 'guidance.md' } } } }))); writeFileSync(join(pkg, 'guidance.md'), 'file guidance');
    const cat = new PatternCatalog({ includeBuiltins: false, sources: [{ directory }] }); const resolved = cat.resolve('test/base'); assert.equal(expand(definition(resolved)).nodes[0]!.config.role, 'file guidance');
    writeFileSync(join(directory, 'outside.md'), 'outside'); symlinkSync(join(directory, 'outside.md'), join(pkg, 'escape.md'));
    const broken = new PatternCatalog({ includeBuiltins: false, sources: [{ directory: pkg }] }).list(); assert.ok(broken.ok); if (!broken.ok) throw new Error('list failed'); assert.equal(broken.patterns.length, 0); assert.match(broken.diagnostics[0]!.message, /escapes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('bad user packages and dependent closures expose diagnostics alongside healthy builtins', () => {
  const cat = new PatternCatalog({ builtinDirectory: resolve('docs/design/public/patterns'), sources: [{ document: 'apiVersion: v1\nid: broken/user' }, { document: { kind: 'object', value: value({ id: 'user/dependent', root: { workers: { role: 'worker', use: { id: 'broken/user' } } } }) } }] });
  const listed = cat.list(); assert.ok(listed.ok); if (!listed.ok) throw new Error('list failed'); assert.equal(listed.patterns.length, 14); assert.ok(listed.diagnostics.length >= 2); assert.ok(cat.resolve('builtin/shared-review').ok); assert.equal(cat.resolve('user/dependent').ok, false);
});

test('all 14 canonical packages compile and expand, hierarchical creates 13 new nodes', () => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [{ directory: resolve('docs/design/public/patterns') }] }); const listed = cat.list(); assert.equal(listed.ok, true); if (!listed.ok) throw new Error('list failed'); assert.equal(listed.patterns.length, 14);
  for (const summary of listed.patterns) {
    const parameters: JsonObject = Object.fromEntries(Object.keys(summary.parameters).map(key => [key, key === 'groups' ? 2 : 3]));
    const expanded = expand(definition(cat.resolve(summary.id)), parameters); assert.ok(expanded.nodes.length > 0); assert.equal(Object.isFrozen(expanded), true);
    if (summary.id === 'builtin/hierarchical') assert.equal(expanded.nodes.length, 13);
  }
});
