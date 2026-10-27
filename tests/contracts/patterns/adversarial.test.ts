import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { Group } from '../../../packages/dsh-flow/src/core/group.js';
import { beginConstruction } from '../../../packages/dsh-flow/src/core/construction.js';
import { createOwned } from '../../../packages/dsh-flow/src/core/internals.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { expandPattern } from '../../../packages/dsh-flow/src/patterns/expand.js';
import { applyPattern } from '../../../packages/dsh-flow/src/patterns/apply.js';
import { catalogControl } from '../../../packages/dsh-flow/src/patterns/internal.js';
import type { JsonObject, JsonValue, PatternCompileResult, PatternDefinition, PatternSource, RoleOverride } from '../../../packages/dsh-flow/src/patterns/types.js';
import { ContractPatternRoleValidator } from '../../helpers/contract-patterns.js';
import { deferred, message, profile } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

const defaults = { model: { provider: 'contract', id: 'model-a' }, params: { version: 1 as const }, permission: 'workspace-write' as const };
function document(id: string, fields: JsonObject = {}): JsonObject {
  return { apiVersion: 'v1', id, description: 'contract package', whenToUse: 'independent boundary verification', roles: { worker: { instructions: 'outer role' } }, root: { instructions: 'root guidance', workers: { role: 'worker' } }, ...fields };
}
function source(value: JsonObject): PatternSource { return { document: { kind: 'object', value } }; }
function result(compiled: PatternCompileResult): PatternDefinition {
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  if (!compiled.ok) throw new Error('Compilation failed');
  return compiled.definition;
}
function compile(value: JsonObject, assets: Record<string, string> = {}): PatternDefinition {
  return result(new PatternCatalog({ includeBuiltins: false }).compile({ kind: 'object', value }, assets));
}
function expand(definition: PatternDefinition, parameters: JsonObject = {}, overrides: Record<string, RoleOverride> = {}) {
  return expandPattern(definition, parameters, overrides, defaults, profile('root'));
}

test('damaged and duplicate packages diagnose locally while an independent dependency closure stays usable', () => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [
    source(document('test/good')), source(document('test/duplicate')), source(document('test/duplicate')),
    source(document('test/broken', { root: { workers: { role: 'unknown' } } })),
    source(document('test/orphan', { root: { workers: { role: 'worker', use: { id: 'test/broken' } } } })),
    source(document('test/healthy-user', { root: { workers: { role: 'worker', use: { id: 'test/good' } } } })),
  ] });
  const list = cat.list(); assert.equal(list.ok, true); if (!list.ok) throw new Error('List unavailable');
  assert.deepEqual(list.patterns.map(item => item.id).sort(), ['test/good', 'test/healthy-user']);
  assert.ok(list.diagnostics.length >= 3);
  for (const id of ['test/duplicate', 'test/broken', 'test/orphan']) assert.equal(cat.resolve(id).ok, false);
  assert.equal(expand(result(cat.resolve('test/healthy-user'))).nodes.length, 2);
  assert.equal(cat.compile({ kind: 'object', value: document('test/unregistered') }, { 'bad/pattern.yaml': 'not: a template' }).ok, false);
  assert.equal(cat.resolve('test/unregistered').ok, false);
  assert.deepEqual(cat.list(), list);
});

test('candidate dependency assets are frozen, private and independent of later catalog registration', () => {
  const cat = new PatternCatalog({ includeBuiltins: false });
  const assets = {
    'override.md': 'main override',
    'dep/override.md': 'dependency override',
    'dep/guidance.md': 'callee root guidance',
    'dep/role.md': 'callee member role',
    'dep/pattern.yaml': JSON.stringify(document('test/private', { roles: { worker: { instructions: { file: 'role.md' } } }, root: { instructions: { file: 'guidance.md' }, children: { role: 'worker' } } })),
  };
  const input = document('test/candidate', { root: { leads: { role: 'worker', use: { id: 'test/private' } } } });
  const candidate = result(cat.compile({ kind: 'object', value: input }, assets));
  assets['override.md'] = 'mutated'; assets['dep/guidance.md'] = 'mutated';
  (input.roles as JsonObject).worker = { instructions: 'mutated' };
  const one = cat[catalogControl].snapshot(), two = cat[catalogControl].snapshot();
  one[catalogControl].register(candidate);
  one[catalogControl].register(compile(document('test/private', { root: {} })));
  assert.equal(two.resolve(candidate.id).ok, false); assert.equal(cat.resolve('test/private').ok, false);
  const plan = expand(result(one.resolve(candidate.id)), {}, { 'root/leads/0': { instructions: { file: 'override.md' } } });
  assert.equal(plan.nodes[0]!.config.role, 'main override\n\ncallee root guidance');
  assert.equal(plan.nodes[1]!.config.role, 'callee member role');
  assert.equal(plan.nodes.length, 2); assert.equal(Object.isFrozen(plan.nodes[0]!.config), true);
});

test('three template scopes forward falsy whole values and preserve JSON data containing DSL-looking text', () => {
  const declarations: JsonObject = {
    n: { type: 'integer', description: 'number' }, z: { type: 'null', description: 'null' },
    b: { type: 'boolean', description: 'boolean' }, a: { type: 'array', description: 'array' },
    o: { type: 'object', description: 'object' }, s: { type: 'string', description: 'string' },
    f: { type: 'number', description: 'number' },
  };
  const forward = Object.fromEntries(Object.keys(declarations).map(key => [key, `{{ ${key} }}`]));
  const leaf = document('test/leaf', { parameters: declarations, root: { leaves: { role: 'worker', count: '{{ n }}' } } });
  const middle = document('test/middle', { parameters: declarations, root: { links: { role: 'worker', use: { id: 'test/leaf', with: forward } } } });
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(leaf), source(middle)] });
  const outer = result(cat.compile({ kind: 'object', value: document('test/outer', { parameters: declarations, root: { links: { role: 'worker', use: { id: 'test/middle', with: forward } } } }) }));
  const values: JsonObject = { n: 0, z: null, b: false, a: [false, null, '{{ unknown }}'], o: { count: '{{ undeclared }}', use: { id: 'not/a-template' } }, s: '{{ untouched }}', f: 0 };
  assert.equal(expand(outer, values).nodes.length, 2);
  assert.equal(expand(outer, { ...values, n: 2 }).nodes.length, 4);
  assert.throws(() => expand(outer, { ...values, b: 0 }), /boolean/);
  assert.throws(() => expand(outer, { ...values, unknown: null }), /Unknown parameter/);
});

test('each declared parameter type rejects a mismatching explicit value and a mismatching default', () => {
  const cases: [string, JsonValue, JsonValue][] = [
    ['string', '', 0], ['integer', 0, 0.5], ['number', 0.5, '0.5'],
    ['boolean', false, 0], ['array', [], {}], ['object', {}, []], ['null', null, false],
  ];
  for (const [type, valid, invalid] of cases) {
    const parameters: JsonObject = { value: { type, description: type, default: valid } };
    const def = compile(document(`test/type-${type}`, { parameters, root: {} }));
    assert.doesNotThrow(() => expand(def)); assert.doesNotThrow(() => expand(def, { value: valid }));
    assert.throws(() => expand(def, { value: invalid }), new RegExp(type));
    const cat = new PatternCatalog({ includeBuiltins: false });
    assert.equal(cat.compile({ kind: 'object', value: document(`test/bad-${type}`, { parameters: { value: { type, description: type, default: invalid } } }) }).ok, false);
  }
});

test('candidate parameter data rejects sparse arrays, extra array fields and accessors without executing them', () => {
  const cat = new PatternCatalog({ includeBuiltins: false });
  const sparse = Array(2) as unknown as JsonObject[];
  const extra = Object.assign([1], { additional: true });
  let reads = 0;
  const accessor = Object.defineProperty({}, 'dynamic', { enumerable: true, get: () => { reads++; return 'unexpected execution'; } });
  for (const [index, value] of [sparse, extra, accessor].entries()) {
    assert.equal(cat.compile({ kind: 'object', value: document(`test/json-${index}`, { parameters: { data: { type: Array.isArray(value) ? 'array' : 'object', description: 'JSON data', default: value } } }) }).ok, false);
  }
  assert.equal(reads, 0);
});

test('inline nesting and long use chains do not depend on a shallow recursion or tree-height limit', () => {
  const root: JsonObject = {}; let cursor = root;
  for (let level = 0; level < 1500; level++) { const next: JsonObject = { role: 'worker' }; cursor.next = next; cursor = next; }
  const inline = expand(compile(document('test/deep', { root })));
  assert.equal(inline.nodes.length, 1500); assert.equal(inline.nodes.at(-1)!.parent, inline.nodes.at(-2)!.path);
  const sources: PatternSource[] = [];
  for (let index = 0; index < 450; index++) sources.push(source(document(`test/chain-${index}`, { root: index === 449 ? {} : { next: { role: 'worker', use: { id: `test/chain-${index + 1}` } } } })));
  const cat = new PatternCatalog({ includeBuiltins: false, sources });
  assert.equal(expand(result(cat.resolve('test/chain-0'))).nodes.length, 449);
});

test('nested forEach selectors distinguish callee root, iteration-relative members and outer complete paths', () => {
  const inner = document('test/selector-inner', {
    root: { analysts: { role: 'worker', count: 2, assistants: { role: 'worker' } } },
    groups: [{ key: 'team', forEach: 'root/analysts/*', members: ['.', './assistants/*', 'root', '.'] }, { key: 'none', forEach: 'root/absent/*', members: ['root'] }],
  });
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(inner)] });
  const def = result(cat.compile({ kind: 'object', value: document('test/selector-outer', {
    root: { leads: { role: 'worker', count: 2, use: { id: 'test/selector-inner' } } },
    groups: [{ key: 'all', members: ['root/leads/*/analysts/*/assistants/*'] }, { key: 'empty', members: ['root/absent/*'] }],
  }) }));
  const groups = expand(def).groups;
  assert.equal(groups.length, 6);
  assert.deepEqual(groups[0]!.members, [0, 1].flatMap(lead => [0, 1].map(analyst => `root/leads/${lead}/analysts/${analyst}/assistants/0`)));
  assert.deepEqual(groups[1]!.members, []);
  assert.deepEqual(groups[2], { key: 'root/leads/0/analysts/0/team', members: ['root/leads/0/analysts/0', 'root/leads/0/analysts/0/assistants/0', 'root/leads/0'] });
  const missing = compile(document('test/exact', { root: {}, groups: [{ key: 'missing', forEach: 'root/absent/0', members: ['root/absent/*'] }] }));
  assert.throws(() => expand(missing), /Dangling exact/);
});

test('zero count prunes invalid dynamic callee count while nonrepresentable counts fail before any host or validation call', async t => {
  const inner = document('test/count-inner', { parameters: { n: { type: 'number', description: 'runtime count' } }, root: { children: { role: 'worker', count: '{{ n }}' } } });
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(inner), source(document('test/count-outer', {
    parameters: { n: { type: 'number', description: 'runtime count' }, enabled: { type: 'integer', description: 'branch count', default: 1 } },
    root: { workers: { role: 'worker', count: '{{ enabled }}', use: { id: 'test/count-inner', with: { n: '{{ n }}' } } } },
  }))] });
  const definition = result(cat.resolve('test/count-outer')); let validations = 0;
  const strict = new ContractPatternRoleValidator();
  const f = await runFixture(t, { patternCatalog: cat, patternRoleValidator: { validate: async (p, r) => { validations++; await strict.validate(p, r); } } });
  const run = await f.createActive(), { root, host } = f.binding(run), old = await f.child(run), original = root.getProfile();
  const pruned = await applyPattern(root, { definition, parameters: { enabled: 0, n: 0.5 } }, 'pruned');
  assert.deepEqual(Object.keys(pruned.agents), ['root']);
  for (const [index, n] of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 2 ** 32].entries()) {
    await assert.rejects(applyPattern(root, { definition, parameters: { n } }, `invalid-${index}`));
  }
  assert.equal(validations, 0); assert.equal(host.created.length, 2); assert.deepEqual(root.getChildren(), [old]); assert.equal(root.getProfile(), original);
});

test('whole-field configuration replacement and ancestor permissions are completely preflighted without changing the root', async t => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(document('test/config', { root: { workers: { role: 'worker', count: 2, children: { role: 'worker' } } } }))] });
  const f = await runFixture(t, { patternCatalog: cat });
  const run = await f.createActive(), { root, host } = f.binding(run), original = root.getProfile(), definition = result(cat.resolve('test/config'));
  const invalid: Record<string, RoleOverride>[] = [
    { 'root/workers/1/children/0': { params: { version: 1, reasoningEffort: 'unsupported' } } },
    { 'root/workers/1/children/0': { hostExtras: { unsupported: true } } },
    { 'root/workers/1/children/0': { preset: 'unavailable' } },
    { 'root/workers/1/children/0': { skills: ['unavailable'] } },
    { 'root/workers/0': { permission: 'read-only' }, 'root/workers/0/children/0': { permission: 'workspace-write' } },
  ];
  for (const [index, overrides] of invalid.entries()) {
    await assert.rejects(applyPattern(root, { definition, overrides }, `config-${index}`));
    assert.equal(host.created.length, 1); assert.equal(root.getProfile(), original); assert.deepEqual(root.getChildren(), []);
  }
  const successful = await applyPattern(root, { definition, overrides: { 'root/workers/0': { params: { version: 1 }, hostExtras: {} } } }, 'replacement');
  assert.deepEqual(successful.agents['root/workers/0']!.getProfile().params, { version: 1 });
  assert.deepEqual(successful.agents['root/workers/0']!.getProfile().hostExtras, {});
  assert.equal(root.getProfile(), original);
});

test('a failed application after a successful one releases only its own tree and groups', async t => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(document('test/additive', { groups: [{ key: 'team', members: ['root', 'root/workers/*'] }] }))] });
  const f = await runFixture(t, { patternCatalog: cat });
  const run = await f.createActive(), { root, context, host } = f.binding(run), request = { definition: result(cat.resolve('test/additive')) };
  const old = await applyPattern(root, request, 'first');
  host.createHook = () => { throw new Error('later creation failed'); };
  await assert.rejects(applyPattern(root, request, 'second'), /later creation failed/);
  assert.equal(context.has(old.groups['root/team']!), true); assert.equal(context.has(old.agents['root/workers/0']!), true);
  assert.deepEqual(root.getChildren(), [old.agents['root/workers/0']]); assert.equal(host.disposeCount, 0);
});

test('created observers can reenter the identical request and observe the complete committed tree and groups', async t => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(document('test/reenter', { root: { workers: { role: 'worker', count: 2 } }, groups: [{ key: 'team', members: ['root', 'root/workers/*'] }] }))] });
  const f = await runFixture(t, { patternCatalog: cat });
  const run = await f.createActive(), { root, context } = f.binding(run), request = { definition: result(cat.resolve('test/reenter')) };
  const observations: Promise<unknown>[] = []; const counts: number[] = [];
  t.after(observeCore(context, event => {
    if (event.type !== 'agent-created' || event.agent === root) return;
    observations.push(applyPattern(root, request, 'reenter'));
    counts.push(root.getChildren().length);
    assert.equal(context.list(object => object instanceof Group).length, 1);
  }));
  const first = applyPattern(root, request, 'reenter');
  const applied = await first;
  assert.equal(observations.length, 2); assert.deepEqual(counts, [2, 2]);
  for (const observed of observations) { assert.equal(observed, first); assert.equal(await observed, applied); }
  assert.equal(context.has(applied.groups['root/team']!), true);
});

test('uncommitted references cannot prepare or read Assignments, inject sources or use old Mailboxes, and become eligible only at commit', async t => {
  const f = await runFixture(t), run = await f.createActive(), { root, host, context } = f.binding(run);
  const assignments = run.assignments!;
  const top = await assignments.prepare({ sender: run, recipient: root, parentAssignment: null, spec: f.spec() }, 'top');
  const scope = beginConstruction(context, root), pending = await Agent[createOwned](scope, profile('pending'), root);
  const before = assignments.list(root).length;
  await assert.rejects(assignments.prepare({ sender: root, recipient: pending, parentAssignment: top, spec: f.spec() }, 'pending-recipient'), /uncommitted/);
  await assert.rejects(assignments.prepare({ sender: pending, recipient: root, parentAssignment: top, spec: f.spec() }, 'pending-sender'), /uncommitted/);
  assert.throws(() => assignments.read(pending, top), /uncommitted/);
  assert.throws(() => root.getMailbox().put(message('pending source', pending)), /uncommitted/);
  assert.throws(() => root.getMailbox().setSourcePriority(pending, 'high'), /uncommitted/);
  assert.throws(() => pending.getMailbox().count(), /uncommitted/);
  assert.equal(assignments.list(root).length, before); assert.equal(host.sent.length, 0); assert.equal(root.getMailbox().count(), 0);
  scope.commit()();
  const job = await assignments.prepare({ sender: root, recipient: pending, parentAssignment: top, spec: f.spec() }, 'pending-recipient');
  assert.equal(assignments.read(root, job).recipientSessionID, pending.getProfile().sessionID);
});

test('a request snapshots overrides before asynchronous validation and keeps failure replay stable after inputs mutate', async t => {
  const cat = new PatternCatalog({ includeBuiltins: false, sources: [source(document('test/snapshot'))] });
  const gate = deferred(), entered = deferred(), strict = new ContractPatternRoleValidator(); t.after(() => gate.resolve());
  const f = await runFixture(t, { patternCatalog: cat, patternRoleValidator: { validate: async (p, r) => { entered.resolve(); await gate.promise; await strict.validate(p, r); } } });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const overrides = { 'root/workers/0': { model: { provider: 'contract', id: 'unknown' } } };
  const request = { definition: result(cat.resolve('test/snapshot')), overrides };
  const first = applyPattern(root, request, 'snapshot'); const rejected = assert.rejects(first, /Unsupported contract model/);
  await entered.promise; overrides['root/workers/0'].model.id = 'model-a'; gate.resolve(); await rejected;
  await assert.rejects(applyPattern(root, request, 'snapshot'), /different/);
  const original = { ...request, overrides: { 'root/workers/0': { model: { provider: 'contract', id: 'unknown' } } } };
  assert.equal(applyPattern(root, original, 'snapshot'), first); assert.equal(host.created.length, 1);
});
