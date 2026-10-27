import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { observeCore } from '../../../packages/dsh-flow/src/core/observation.js';
import { catalogControl } from '../../../packages/dsh-flow/src/patterns/internal.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { applyPattern, PatternApplyError } from '../../../packages/dsh-flow/src/patterns/apply.js';
import { runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { ContractPatternRoleValidator } from '../../helpers/contract-patterns.js';
import { deferred, flush } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';
import type { PatternRoleValidator } from '../../../packages/dsh-flow/src/patterns/types.js';

const document = `apiVersion: v1
id: test/team
description: two idle members
whenToUse: contract test
parameters:
  size:
    type: integer
    description: member count
    default: 2
roles:
  worker:
    instructions: inspect assigned evidence
root:
  instructions: divide the current assignment
  workers:
    role: worker
    count: "{{ size }}"
groups:
  - key: discussion
    members: [root, root/workers/*]
`;
function catalog() { return new PatternCatalog({ includeBuiltins: false, sources: [{ document }] }); }
function definition(source: PatternCatalog) { const result = source.resolve('test/team'); assert.equal(result.ok, true); if (!result.ok) throw new Error('missing definition'); return result.definition; }

test('application creates idle members and fixed groups without altering its root', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, host, context } = f.binding(run), profile = root.getProfile();
  const result = await applyPattern(root, { definition: definition(source) }, 'apply');
  assert.equal(result.agents.root, root);
  assert.equal(result.instructions, 'divide the current assignment');
  assert.deepEqual(Object.keys(result.agents), ['root', 'root/workers/0', 'root/workers/1']);
  for (const path of ['root/workers/0', 'root/workers/1']) {
    const child = result.agents[path]!;
    assert.equal(child.getParent(), root); assert.equal(child.getStatus(), 'idle');
    assert.equal(child.getProfile().role, 'inspect assigned evidence');
    assert.deepEqual(child.getProfile().model, run.defaults.model);
  }
  assert.equal(context.has(result.groups['root/discussion']!), true);
  assert.equal(root.getProfile(), profile); assert.equal(host.sent.length, 0);
});

test('concurrent identical keys share Promise/result and snapshot parameters before validation yields', async t => {
  const source = catalog(), gate = deferred(), entered = deferred(), strict = new ContractPatternRoleValidator();
  let validations = 0;
  const validator: PatternRoleValidator = { validate: async (profile, requirements) => { await strict.validate(profile, requirements); validations++; entered.resolve(); await gate.promise; } };
  t.after(() => gate.resolve());
  const f = await runFixture(t, { patternCatalog: source, patternRoleValidator: validator });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const request = { definition: definition(source), parameters: { size: 2 } };
  const first = applyPattern(root, request, 'same');
  assert.equal(applyPattern(root, request, 'same'), first);
  request.parameters.size = 7;
  await entered.promise;
  assert.equal(host.created.length, 1);
  await assert.rejects(applyPattern(root, request, 'same'), /different/);
  gate.resolve();
  const result = await first;
  assert.equal(Object.keys(result.agents).length, 3); assert.equal(validations, 2);
  assert.equal(applyPattern(root, { ...request, parameters: { size: 2 } }, 'same'), first);
  assert.equal(await first, result);
});

test('every role is preflighted before creation and failed keys replay the original error', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, host } = f.binding(run);
  const request = { definition: definition(source), overrides: { 'root/workers/1': { model: { provider: 'contract', id: 'unknown' } } } };
  const first = applyPattern(root, request, 'invalid');
  let error: unknown;
  await assert.rejects(first, value => { error = value; return value instanceof PatternApplyError && value.path === 'root/workers/1'; });
  assert.equal(applyPattern(root, request, 'invalid'), first);
  await assert.rejects(first, value => value === error);
  assert.equal(host.created.length, 1); assert.equal(root.getChildren().length, 0);
});

test('applications queue per Run and queued work rechecks root liveness before creating', async t => {
  const source = catalog(), gate = deferred(), entered = deferred(), strict = new ContractPatternRoleValidator();
  let checks = 0;
  const validator: PatternRoleValidator = { validate: async (profile, requirements) => { await strict.validate(profile, requirements); checks++; entered.resolve(); await gate.promise; } };
  t.after(() => gate.resolve());
  const f = await runFixture(t, { patternCatalog: source, patternRoleValidator: validator });
  const run = await f.createActive(), { root, host } = f.binding(run), request = { definition: definition(source) };
  const first = applyPattern(root, request, 'one'), second = applyPattern(root, request, 'two');
  const firstFailure = assert.rejects(first), secondFailure = assert.rejects(second);
  await entered.promise; await flush(); assert.equal(checks, 1);
  await root.recvSignal('SIGKILL'); gate.resolve();
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(checks, 1); assert.equal(host.created.length, 1);
});

test('late native initialization after root termination is cleaned before application rejects', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, host, context } = f.binding(run), gate = deferred(), entered = deferred();
  t.after(() => gate.resolve());
  host.createHook = async () => { entered.resolve(); await gate.promise; };
  const applying = applyPattern(root, { definition: definition(source) }, 'late');
  const failed = assert.rejects(applying, PatternApplyError);
  await entered.promise;
  const closing = root.recvSignal('SIGKILL');
  gate.resolve(); await Promise.all([failed, closing]);
  assert.equal(host.created.length, 2); assert.equal(host.releases.length, 2);
  assert.equal(context.list(value => value instanceof Agent).length, 0);
  assert.equal(host.disposeCount, 0);
});

test('creation failure releases only this application and preserves old members', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, host, context } = f.binding(run), old = await f.child(run);
  let calls = 0;
  host.createHook = async () => { if (++calls === 2) throw new Error('second native create failed'); };
  const applying = applyPattern(root, { definition: definition(source) }, 'failure');
  await assert.rejects(applying, value => value instanceof PatternApplyError && value.path === 'root/workers/1' && value.cause instanceof Error && value.cause.message.includes('second native'));
  assert.equal(context.has(old), true); assert.equal(root.getStatus(), 'idle');
  assert.deepEqual(root.getChildren(), [old]); assert.equal(host.disposeCount, 0);
});

test('commit fixes success before created observers terminate its root', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, context } = f.binding(run), request = { definition: definition(source) };
  let termination: Promise<void> | undefined;
  const remove = observeCore(context, event => { if (event.type === 'agent-created' && event.agent !== root) termination ??= root.recvSignal('SIGKILL'); });
  t.after(remove);
  const applying = applyPattern(root, request, 'observer');
  const result = await applying;
  await termination;
  assert.equal(root.getStatus(), 'terminated');
  assert.equal(applyPattern(root, request, 'observer'), applying);
  assert.equal(await applying, result);
});

test('Run snapshots isolate future catalog registration and root-scoped keys', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const one = await f.createActive(), two = await f.createActive();
  const request = { definition: definition(source), parameters: { size: 0 } };
  const a = applyPattern(f.binding(one).root, request, 'same'), b = applyPattern(f.binding(two).root, request, 'same');
  assert.notEqual(a, b); assert.notEqual(await a, await b);
  assert.notEqual(runState(one).patternCatalog, runState(two).patternCatalog);
});


test('failed construction reports established paths and each cleanup failure without claiming root ownership', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const run = await f.createActive(), { root, host } = f.binding(run);
  let calls = 0;
  host.createHook = async () => { if (++calls === 2) throw new Error('creation failed'); };
  host.releaseHook = agent => { if (agent.profile.sessionID !== root.getProfile().sessionID) throw new Error('cleanup failed'); };
  t.after(() => { delete host.releaseHook; });
  await assert.rejects(applyPattern(root, { definition: definition(source) }, 'cleanup'), error => {
    assert.ok(error instanceof PatternApplyError);
    assert.deepEqual(Object.keys(error.created.agents), ['root/workers/0']);
    assert.ok(error.cleanupErrors.length >= 1);
    for (const failure of error.cleanupErrors) {
      assert.ok(failure instanceof Error);
      assert.ok(failure.cause instanceof Error);
      const causes: unknown[] = [failure.cause];
      let originalFound = false;
      while (causes.length) {
        const cause = causes.pop();
        if (cause instanceof Error) {
          originalFound ||= cause.message === 'cleanup failed';
          if (cause.cause) causes.push(cause.cause);
          if (cause instanceof AggregateError) causes.push(...cause.errors);
        }
      }
      assert.equal(originalFound, true);
    }
    return true;
  });
  assert.equal(root.getStatus(), 'idle'); assert.equal(host.disposeCount, 0);
});

test('storage freezing during validation blocks all member creation and preserves failed replay', async t => {
  const source = catalog(), gate = deferred(), entered = deferred(), strict = new ContractPatternRoleValidator();
  t.after(() => gate.resolve());
  const f = await runFixture(t, { patternCatalog: source, patternRoleValidator: { validate: async (profile, requirements) => {
    await strict.validate(profile, requirements); entered.resolve(); await gate.promise;
  } } });
  const run = await f.createActive(), { root, host } = f.binding(run), request = { definition: definition(source) };
  const applying = applyPattern(root, request, 'frozen'), rejected = assert.rejects(applying, /storage failed/i);
  await entered.promise;
  f.failWrites('write', new Error('disk unavailable'), run.id);
  assert.throws(() => runState(run).commit(() => {}), /storage failed/i);
  gate.resolve(); await rejected;
  assert.equal(host.created.length, 1); assert.equal(root.getStatus(), 'idle');
  assert.equal(applyPattern(root, request, 'frozen'), applying);
});

test('candidate definitions are visible only in their owning Run', async t => {
  const source = catalog(), f = await runFixture(t, { patternCatalog: source });
  const one = await f.createActive(), two = await f.createActive();
  const local = runState(one).patternCatalog;
  const candidate = local.compile(document.replace('test/team', 'test/candidate'));
  assert.equal(candidate.ok, true); if (!candidate.ok) throw new Error('compile failed');
  local[catalogControl].register(candidate.definition);
  await applyPattern(one.root!, { definition: candidate.definition }, 'local');
  await assert.rejects(applyPattern(two.root!, { definition: candidate.definition }, 'foreign'), /not visible/);
  assert.equal(f.binding(two).host.created.length, 1);
});
