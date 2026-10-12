import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterRuntime } from '../../packages/dsh-flow/src/core/cluster.ts';
import type { FlowAgentActor } from '../../packages/dsh-flow/src/core/model.ts';
import { objectField } from '../../packages/dsh-flow/src/validation.ts';
import { createFakeHost } from './fake-host.ts';
import { fixtureParams, publishFixtureResult } from './task-fixtures.ts';

for (const accepted of [false, true]) test(`an actual manager write ${accepted ? 'after acceptance prevents finalization' : 'before explicit binding invalidates the submitted artifact'}`, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-artifact-integrity-')));
  const artifact = join(dir, 'result.txt');
  writeFileSync(artifact, 'original delivery');
  const host = createFakeHost();
  host.registerTool({ name: 'write', description: 'Write an actual fixture artifact.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, async execute(args) {
      const body = objectField(args, 'write arguments');
      writeFileSync(String(body.path), String(body.content));
      return 'written';
    } });
  host.registerTool({ name: 'edit', description: 'Unused companion required by the native write capability.', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, async execute() { assert.fail('edit is not called'); } });
  const runtime = new ClusterRuntime(host.ctx, { path: ':memory:', autoTick: false });
  t.after(async () => { await runtime.dispose(); await host.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const clusterId = runtime.start({ objective: 'Deliver the original file and preserve it through final acceptance.', workspace: dir,
    acceptance_criteria: ['result.txt contains the original delivery.'], capabilities: [], managementCapabilities: ['fs_write'],
    budget: { tool_calls: 100, agents: 8 } }).cluster.id;
  const lead = runtime.store.listAgents(clusterId, { role: 'orchestrator' })[0]!;
  const actor: FlowAgentActor = { role: 'orchestrator', cluster_id: clusterId, node_id: lead.node_id, agent_id: lead.id, session_id: lead.session_id };
  const assigned = runtime.store.rootTransactions(clusterId)[0]!;
  if (!accepted) {
    runtime.command(actor, { command_id: 'prepare-other-assignment', action: 'dispatch', params: fixtureParams(runtime, actor, 'dispatch', { transaction_id: assigned.id }) });
    runtime.store.updateTransaction(assigned.id, { status: 'SUBMITTED', result: { answer: 'independent current assignment' } });
    publishFixtureResult(runtime, assigned.id);
  }
  const tx = accepted ? assigned : runtime.createTransactionInternal(clusterId, runtime.store.getNode(lead.node_id)!,
    { objective: 'Preserve the separately published file.', acceptance_criteria: ['result.txt contains the original delivery.'] }, { local: true });
  runtime.command(actor, { command_id: 'prepare-file', action: 'dispatch', params: fixtureParams(runtime, actor, 'dispatch', { transaction_id: tx.id }) });
  // Fixture publication is explicitly authored by the fixture; the mutation below
  // runs through the manager's real admission, native execution and settlement path.
  runtime.store.updateTransaction(tx.id, { status: 'SUBMITTED', result: accepted ? { artifacts: { paths: ['result.txt'] } } : { file: 'result.txt' } });
  publishFixtureResult(runtime, tx.id);
  const publication = runtime.store.getTransaction(tx.id)!.current_result_ref!;
  const validationRequest = fixtureParams(runtime, actor, 'validate', { transaction_id: tx.id, accepted: true });
  if (accepted) runtime.command(actor, { command_id: 'initial-acceptance', action: 'validate', params: validationRequest });
  const previousValidation = runtime.store.getTransaction(tx.id)!.current_validation_ref;
  const previousSnapshot = previousValidation ? runtime.store.getValidation(previousValidation) : null;
  runtime.store.updateAgent(runtime.store.listAgents(clusterId, { role: 'allocator' })[0]!.id, { status: 'BLOCKED' });
  let failure: unknown;
  let executed = false;
  host.setScript(async turn => {
    try {
      assert.equal(runtime.store.getAgentBySession(turn.session.id)?.id, lead.id);
      assert.equal(runtime.store.all("SELECT seq FROM events WHERE cluster_id=? AND type='validation-target-bound'", clusterId).length, 0);
      if (!accepted) {
        const assignment = objectField(JSON.parse(String((await turn.callTool('flow_query', { what: 'assignment' })).value)), 'assignment');
        assert.equal(objectField(assignment.binding, 'binding').transaction_id, assigned.id, 'the write targets a publication outside the currently assigned validation');
      }
      const write = await turn.callTool('write', { path: artifact, content: 'manager changed the accepted bytes' }, { callId: 'mutate-published-file' });
      assert.equal(write.isError, false);
      executed = true;
      assert.equal(readFileSync(artifact, 'utf8'), 'manager changed the accepted bytes');
      assert.equal(runtime.store.getTransaction(tx.id)!.status, 'REJECTED', 'settling the write immediately invalidates its old publication');
      await assert.rejects(turn.callTool('flow_transaction', accepted ? { action: 'finish_cluster', params: {} }
        : { action: 'validate', params: validationRequest }), accepted ? /all root transactions must be ACCEPTED/ : /REJECTED; only SUBMITTED/,
      'the old publication cannot be accepted or finalized after its bytes change');
    } catch (error) { failure = error; throw error; }
  });
  runtime.enableScheduling();
  await runtime.tick();
  await runtime.activeTurnFor(lead.id)?.promise;
  if (failure) throw failure;
  assert.equal(executed, true, 'the native write handler actually ran');
  runtime.evaluateCompletion(clusterId);
  const current = runtime.store.getTransaction(tx.id)!;
  assert.equal(current.status, 'REJECTED');
  assert.equal(current.current_validation_ref, null);
  assert.equal(current.validation, null);
  assert.ok(runtime.store.getResult(publication), 'immutable publication evidence survives invalidation');
  if (previousValidation) assert.deepEqual(runtime.store.getValidation(previousValidation), previousSnapshot, 'previous acceptance is retained as history');
  assert.equal(runtime.store.getEffect('mutate-published-file')?.status, 'SETTLED');
  const call = runtime.store.get("SELECT data FROM events WHERE cluster_id=? AND type='manager-tool-bound' AND json_extract(data,'$.call_id')=?", clusterId, 'mutate-published-file');
  assert.equal(objectField(JSON.parse(String(call!.data)), 'call binding').transaction_id, accepted ? null : assigned.id,
    'artifact protection does not depend on binding this call to the modified publication');
  const observations = runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='manager-artifacts-observed' AND json_extract(data,'$.call_id')=? AND json_extract(data,'$.transaction_id')=?", clusterId, 'mutate-published-file', tx.id);
  assert.equal(observations.length, 1);
  const observed = objectField(JSON.parse(String(observations[0]!.data)), 'artifact observation');
  assert.deepEqual(observed.result_ref, publication);
  assert.ok(objectField(observed.artifact_hashes, 'artifact hashes')[artifact]);
  const mutations = runtime.store.all("SELECT data FROM events WHERE cluster_id=? AND type='manager-result-mutated' AND json_extract(data,'$.call_id')=?", clusterId, 'mutate-published-file');
  assert.equal(mutations.length, 1);
  assert.deepEqual(objectField(JSON.parse(String(mutations[0]!.data)), 'mutation').paths, [artifact]);
  assert.equal(objectField(runtime.store.latestSummary(clusterId, { transaction_id: tx.id })!.data, 'summary').status, 'REJECTED');
  assert.equal(runtime.store.openIssues(clusterId, { transaction_id: tx.id, status: ['OPEN'] }).length, 1);
  assert.notEqual(runtime.store.getCluster(clusterId)!.status, 'COMPLETED');
  assert.notEqual(runtime.store.getNode(lead.node_id)!.status, 'COMPLETED');
});
