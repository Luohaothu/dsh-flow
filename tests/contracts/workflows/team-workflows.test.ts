import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent, Context, Group } from '../../../packages/dsh-flow/src/core/index.js';
import { applyPattern } from '../../../packages/dsh-flow/src/patterns/apply.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { ContractHost, flush, message, profile } from '../../helpers/contract-host.js';
import { runFixture } from '../../helpers/contract-run.js';

const builtinDirectory = fileURLToPath(new URL('../../../docs/design/public/patterns/', import.meta.url));

const unit = `apiVersion: v1
id: test/evidence-unit
description: evidence team
whenToUse: scoped evidence work
parameters:
  count:
    type: integer
    description: contributor count
    default: 2
roles:
  contributor:
    instructions: inspect assigned evidence
    permission: read-only
root:
  instructions: divide work and collect results
  contributors:
    role: contributor
    count: "{{ count }}"
groups:
  - key: peers
    members: [root, root/contributors/*]
`;

const program = `apiVersion: v1
id: test/evidence-program
description: two research branches
whenToUse: independent directions with internal evidence work
parameters:
  squads:
    type: integer
    description: branches
    default: 2
  members:
    type: integer
    description: contributors per branch
    default: 2
roles:
  lead:
    instructions: coordinate this direction
    permission: read-only
root:
  instructions: coordinate separate directions
  leads:
    role: lead
    count: "{{ squads }}"
    use:
      id: test/evidence-unit
      with: {count: "{{ members }}"}
groups:
  - key: coordination
    members: [root, root/leads/*]
`;

function definition(catalog: PatternCatalog, id: string) {
  const result = catalog.resolve(id);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(`Missing pattern: ${id}`);
  return result.definition;
}

function summary(source: string) {
  return `Flow 上下文总结 v1\n来源：${source}\n\n${[
    '目标与约束',
    '已知事实与关键决策',
    '当前进展与已有产物',
    '关键文件、资源及定位信息',
    '未完成事项与后续步骤',
    '分歧、风险与待确认信息',
  ].map(section => `## ${section}\n无`).join('\n\n')}`;
}

test('a long-lived team accepts followup work and expands a subtree without changing prior groups', async t => {
  const catalog = new PatternCatalog({
    includeBuiltins: false,
    sources: [{ document: unit }, { document: program }],
  });
  const f = await runFixture(t, { patternCatalog: catalog });
  const owner = f.origin();
  const run = await f.createActive({}, 'research-team', owner);
  const { root, context, host } = f.binding(run);
  const rootProfile = root.getProfile();
  const tree = await applyPattern(root, {
    definition: definition(catalog, 'test/evidence-program'),
  }, 'initial-tree');

  assert.equal(Object.keys(tree.agents).length, 7);
  assert.equal(Object.keys(tree.groups).length, 3);
  assert.equal(tree.agents.root, root);
  assert.equal(root.getProfile(), rootProfile);

  const lead = tree.agents['root/leads/0']!;
  const contributor = tree.agents['root/leads/0/contributors/0']!;
  const group = tree.groups['root/leads/0/peers']!;
  assert.equal(lead.getParent(), root);
  assert.equal(contributor.getParent(), lead);
  assert.equal(contributor.getProfile().permission, 'read-only');

  const top = await f.service.assign(owner, run, f.spec({ name: 'first evidence task' }), 'first-top');
  const assignments = run.assignments;
  assert.ok(assignments);
  const topHandle = assignments.resolve(top.id);
  const branch = await assignments.prepare({
    sender: root,
    recipient: lead,
    parentAssignment: topHandle,
    spec: f.spec({ name: 'branch result' }),
  }, 'branch');
  await assignments.deliver(branch);
  const leaf = await assignments.prepare({
    sender: lead,
    recipient: contributor,
    parentAssignment: branch,
    spec: f.spec({ name: 'source evidence' }),
  }, 'leaf');
  await assignments.deliver(leaf);

  group.postMessage(contributor, message('source ready'));
  group.postToBlackboard(contributor, message('source index'));
  assert.equal((await f.submit(run, contributor, leaf, { answer: 'source checked' })).kind, 'accepted');
  assert.equal((await f.submit(run, lead, branch, { answer: 'branch checked' })).kind, 'accepted');
  assert.equal((await f.submit(run, root, topHandle, { answer: 'first task done' })).kind, 'accepted');
  await flush();

  assert.equal(run.status, 'active');
  assert.equal(host.releases.length, 0);
  assert.equal(host.disposeCount, 0);
  assert.equal(context.has(group), true);
  assert.equal(context.has(contributor), true);
  assert.equal(group.readBlackboard().length, 1);

  const later = await f.service.assign(owner, run, f.spec({ name: 'followup evidence task' }), 'second-top');
  assert.equal(later.recipientSessionID, rootProfile.sessionID);
  assert.equal(later.status, 'pending');

  const expanded = await applyPattern(lead, {
    definition: definition(catalog, 'test/evidence-unit'),
    parameters: { count: 1 },
  }, 'extra-subtree');
  const newContributor = expanded.agents['root/contributors/0']!;
  const newGroup = expanded.groups['root/peers']!;
  assert.equal(expanded.agents.root, lead);
  assert.equal(newContributor.getParent(), lead);
  assert.equal(context.list(resource => resource instanceof Agent).length, 8);
  assert.equal(context.has(group), true);
  assert.notEqual(newGroup, group);
  assert.throws(() => group.postMessage(newContributor, message('outside the old group')));
  newGroup.postMessage(newContributor, message('new group exchange'));

  const receipt = await f.submit(run, root, assignments.resolve(later.id), { answer: 'second task done' });
  assert.equal(receipt.kind, 'accepted');
  assert.equal(run.status, 'active');
  await f.service.release(owner, run);
  assert.equal(run.status, 'stopped');
  assert.equal(context.has(group), false);
  assert.equal(host.disposeCount, 1);
});

test('permission and derived profiles survive transfer while subtree termination follows the current parent', async t => {
  const context = new Context();
  const host = new ContractHost();
  context.registerHostAdaptor(host);
  t.after(() => context.dispose());
  host.summaryHook = async agent => ({ summary: summary(agent.profile.sessionID), usage: [] });
  host.mergeHook = async () => ({ summary: summary('merged'), usage: [] });

  const parent = await Agent.create(context, profile('writer', { permission: 'workspace-write' }), null);
  const mother = await Agent.create(context, profile('reader', {
    permission: 'read-only',
    model: { provider: 'contract', id: 'model-a' },
    params: { version: 1, maxTokens: 123 },
    hostExtras: { nested: { identity: 'retained' } },
  }), parent);
  const other = await Agent.create(context, profile('other', { permission: 'workspace-write' }), null);

  const before = host.created.length;
  await assert.rejects(Agent.create(context, profile('elevated', { permission: 'workspace-write' }), mother));
  assert.equal(host.created.length, before);

  const fork = await mother.fork();
  const native = host.native(fork);
  const forkProfile = fork.getProfile();
  assert.equal(fork.getParent(), mother);
  assert.deepEqual(forkProfile, { ...mother.getProfile(), sessionID: forkProfile.sessionID });
  assert.notEqual(forkProfile.sessionID, mother.getProfile().sessionID);
  assert.equal(host.created.find(record => record.flow === fork)!.history, 'contract-history-v1: recorded dialogue');

  const merged = await mother.herb(other);
  assert.equal(merged.getParent(), mother);
  assert.equal(merged.getProfile().permission, 'read-only');
  assert.deepEqual(merged.getProfile().model, mother.getProfile().model);
  assert.equal(host.summaries.length, 2);
  assert.equal(host.merges.length, 1);

  fork.recvMessage(message('retained mail'));
  mother.transfer(fork, other);
  assert.equal(fork.getParent(), other);
  assert.equal(host.native(fork), native);
  assert.equal(fork.getProfile(), forkProfile);
  assert.equal(fork.getMailbox().count(), 1);

  await mother.recvSignal('SIGTERM');
  assert.equal(merged.getStatus(), 'terminated');
  assert.notEqual(fork.getStatus(), 'terminated');
  assert.equal(context.has(fork), true);
  assert.equal(fork.getParent(), other);
});

test('cross-branch groups retain history when a subtree terminates and other members continue', async t => {
  const context = new Context();
  const host = new ContractHost();
  context.registerHostAdaptor(host);
  t.after(() => context.dispose());
  const root = await Agent.create(context, profile('root'), null);
  const lead = await Agent.create(context, profile('lead'), root);
  const leaf = await Agent.create(context, profile('leaf'), lead);
  const auditor = await Agent.create(context, profile('auditor'), root);
  const group = new Group(context, [lead, leaf, auditor]);

  group.postMessage(leaf, message('cross-branch evidence'));
  assert.equal(root.getMailbox().count(), 0);
  assert.equal(lead.getMailbox().count(), 1);
  assert.equal(auditor.getMailbox().count(), 1);
  const historical = auditor.getMailbox().query()[0]!;
  assert.deepEqual(historical.source, { agent: leaf, g: group });

  group.postToBlackboard(leaf, message('source one'));
  group.postToBlackboard(auditor, message('review one'));
  assert.equal(auditor.getMailbox().count(), 1);
  const rows = group.readBlackboard();
  assert.equal(rows.length, 2);
  assert.ok(rows[1]!.timestamp > rows[0]!.timestamp);

  await lead.recvSignal('SIGTERM');
  assert.equal(lead.getStatus(), 'terminated');
  assert.equal(leaf.getStatus(), 'terminated');
  assert.equal(context.has(root), true);
  assert.equal(context.has(auditor), true);
  assert.equal(context.has(group), true);
  assert.throws(() => group.postMessage(leaf, message('removed sender')));

  group.postToBlackboard(auditor, message('surviving review'));
  assert.equal(group.readBlackboard().length, 3);
  await context.release(group);
  assert.equal(context.has(auditor), true);
  assert.ok(auditor.getMailbox().get(historical.id));
  assert.throws(() => group.readBlackboard());
});

test('the hierarchical builtin creates idle nested members and groups before any model input', async t => {
  const catalog = new PatternCatalog({ builtinDirectory });
  const f = await runFixture(t, { patternCatalog: catalog });
  const run = await f.createActive();
  const { root, host, context } = f.binding(run);
  const result = await applyPattern(root, {
    definition: definition(catalog, 'builtin/hierarchical'),
    parameters: { groups: 2, membersPerGroup: 3 },
  }, 'builtin-tree');

  assert.equal(Object.keys(result.agents).length, 14);
  assert.equal(Object.keys(result.groups).length, 3);
  assert.equal(host.created.length, 14);
  assert.equal(host.sent.length, 0);
  assert.equal(result.agents.root, root);
  assert.equal(context.list(resource => resource instanceof Agent).length, 14);

  for (const [path, agent] of Object.entries(result.agents)) {
    if (path === 'root') continue;
    assert.equal(agent.getStatus(), 'idle');
    assert.equal(agent.getProfile().permission, 'read-only');
    const parentPath = path.slice(0, path.lastIndexOf('/'));
    const collectionParent = parentPath.slice(0, parentPath.lastIndexOf('/'));
    assert.equal(agent.getParent(), result.agents[collectionParent]);
  }
  assert.equal(result.agents['root/leads/0/contributors/2']!.getParent(), result.agents['root/leads/0']);
  assert.equal(context.has(result.groups['root/leads/1/discussion']!), true);
});
