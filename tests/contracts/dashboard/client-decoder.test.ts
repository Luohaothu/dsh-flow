import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRegistry, decodeRunEvent, decodeSnapshot } from '../../../packages/dsh-flow/src/dashboard/decoder.js';
import { PROTOCOL_VERSION, type AgentCard, type RunSnapshot } from '../../../packages/dsh-flow/src/dashboard/protocol.js';

function fixture(): RunSnapshot {
  const node: AgentCard = { id: 'root', parentId: null, sessionID: 'root-session', name: 'root', role: 'worker', model: { provider: 'fixture', id: 'model' }, permission: 'workspace-write', task: 'task', status: 'waiting',
    source: { kind: 'create', sourceIds: [] }, waiting: { target: 'peer', startedAt: 1, deadline: 50 }, outcome: null, termination: null, cleanup: null,
    markers: [{ id: 'marker', kind: 'auto-reject', timestamp: 2, message: 'rejected' }], usage: [{ callId: 'call', kind: 'main', timestamp: 2, model: { provider: 'fixture', id: 'model' }, inputTokens: 1, outputTokens: 2, totalTokens: 3, amount: null, currency: null }],
    createdAt: 1, terminatedAt: null, messages: [{ id: 'message', source: { kind: 'group', agentId: 'root', sessionID: 'root-session', name: 'root', groupId: 'group' }, recipientId: 'root', timestamp: 1, summary: 'summary', priority: 'high', read: false, readTimestamp: null }],
    blackboardWrites: [{ id: 'write', groupId: 'group', startedAt: 1 }], assignmentIds: ['assignment'], groups: ['group'], outputs: [{ timestamp: 1, text: 'output' }], errors: [{ timestamp: 1, message: 'error' }] };
  return { version: { ...PROTOCOL_VERSION }, seq: 10, run: { id: 'run', epoch: 'epoch', name: 'run', entry: { backend: 'dsh', callerSessionId: 'origin' }, rootSummary: { id: 'root', name: 'root', sessionID: 'root-session' }, status: 'active', startedAt: 1, pendingAssignmentCount: 1 }, nodes: [node],
    groups: [{ id: 'group', members: ['root'], dissolved: false, blackboard: [{ id: 'blackboard', source: { kind: 'user' }, timestamp: 1, summary: 'posted', payload: { data: [null, false, 0, ''] } }] }],
    assignments: [{ id: 'assignment', runId: 'run', spec: { name: 'spec', type: 'test', background: '', requirements: '', acceptanceCriteria: '', resultSchema: true, materials: [{ id: 'material', sourceId: 'source', digest: 'digest', location: 'path', mediaType: 'text/plain' }] }, sender: { kind: 'run', runId: 'run' }, recipientSessionID: 'root-session', recipientInstanceId: 'root', parentAssignmentId: null, status: 'submitted', submissionCount: 1, schemaFailures: 0, schemaDialect: 'json', schemaDigest: 'digest', continuingChildren: [], result: false,
      submissions: [{ transportKey: 'transport', timestamp: 2, submission: { result: false, continuingChildren: [] }, receipt: { kind: 'accepted', assignmentId: 'assignment', status: 'submitted' } }] }],
    prices: [{ model: { provider: 'fixture', id: 'model' }, currency: 'USD', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }], operations: [{ id: 'op', target: { agentId: 'root' }, status: 'completed' }] };
}
function set(value: unknown, path: string, replacement: unknown) {
  const keys = path.split('.'); let target = value;
  for (const key of keys.slice(0, -1)) { assert.ok(target && typeof target === 'object'); target = Reflect.get(target, key); }
  assert.ok(target && typeof target === 'object'); Reflect.set(target, keys.at(-1)!, replacement);
}

test('complete wire decoder round-trips every DTO, keeps JSON falsy values, and ignores additive fields', () => {
  const original = fixture(), input = { ...original, addedField: 'future' };
  assert.deepEqual(decodeSnapshot(input, 'run'), original);
  assert.deepEqual(decodeRegistry({ version: original.version, epoch: 'epoch', seq: 1, runs: [original.run], future: 1 }).runs, [original.run]);
  assert.deepEqual(decodeRunEvent({ runId: 'run', seq: 11, timestamp: 2, type: 'future-event', node: { corrupted: true } }), { runId: 'run', seq: 11, timestamp: 2, type: 'unknown' });
});

test('known DTO tags, nested model/usage/cleanup/assignment/operation/price fields reject corruption', () => {
  const paths = ['version.major', 'version.minor', 'seq', 'run.id', 'run.epoch', 'run.entry.backend', 'run.rootSummary.id', 'run.pendingAssignmentCount', 'run.status', 'run.startedAt',
    'nodes.0.id', 'nodes.0.parentId', 'nodes.0.sessionID', 'nodes.0.name', 'nodes.0.role', 'nodes.0.model.provider', 'nodes.0.model.id', 'nodes.0.permission', 'nodes.0.task', 'nodes.0.status', 'nodes.0.source.kind', 'nodes.0.source.sourceIds',
    'nodes.0.waiting.target', 'nodes.0.waiting.deadline', 'nodes.0.outcome', 'nodes.0.termination', 'nodes.0.cleanup', 'nodes.0.markers.0.message', 'nodes.0.markers.0.timestamp', 'nodes.0.usage.0.callId', 'nodes.0.usage.0.kind', 'nodes.0.usage.0.model.provider', 'nodes.0.usage.0.inputTokens', 'nodes.0.usage.0.amount', 'nodes.0.usage.0.currency', 'nodes.0.createdAt', 'nodes.0.terminatedAt',
    'nodes.0.messages.0.source.kind', 'nodes.0.messages.0.source.agentId', 'nodes.0.messages.0.priority', 'nodes.0.messages.0.read', 'nodes.0.messages.0.readTimestamp', 'nodes.0.blackboardWrites.0.startedAt', 'nodes.0.assignmentIds', 'nodes.0.groups', 'nodes.0.outputs.0.text', 'nodes.0.errors.0.message',
    'groups.0.id', 'groups.0.members', 'groups.0.dissolved', 'groups.0.blackboard.0.source.kind', 'groups.0.blackboard.0.timestamp', 'groups.0.blackboard.0.payload',
    'assignments.0.id', 'assignments.0.runId', 'assignments.0.spec.name', 'assignments.0.spec.resultSchema', 'assignments.0.spec.materials.0.mediaType', 'assignments.0.sender.kind', 'assignments.0.recipientInstanceId', 'assignments.0.parentAssignmentId', 'assignments.0.status', 'assignments.0.submissionCount', 'assignments.0.schemaFailures', 'assignments.0.schemaDialect', 'assignments.0.continuingChildren', 'assignments.0.result', 'assignments.0.submissions.0.transportKey', 'assignments.0.submissions.0.timestamp', 'assignments.0.submissions.0.submission.result', 'assignments.0.submissions.0.receipt.kind', 'assignments.0.submissions.0.receipt.status',
    'prices.0.model.id', 'prices.0.currency', 'prices.0.input', 'prices.0.output', 'prices.0.cacheRead', 'prices.0.cacheWrite', 'operations.0.id', 'operations.0.target', 'operations.0.status'];
  for (const path of paths) { const value = fixture(); set(value, path, Symbol('corrupt')); assert.throws(() => decodeSnapshot(value, 'run'), path); }
  for (const bad of [-1, Infinity, NaN, 1.5]) { const value = fixture(); set(value, 'nodes.0.usage.0.inputTokens', bad); assert.throws(() => decodeSnapshot(value, 'run')); }
  const cleanup = fixture(); cleanup.nodes[0]!.cleanup = { phase: 'abandoned', timestamp: 1, deadline: 50, reason: 'deadline', persistenceError: 'failed' }; assert.ok(decodeSnapshot(cleanup, 'run'));
  set(cleanup, 'nodes.0.cleanup.deadline', 'not-a-time'); assert.throws(() => decodeSnapshot(cleanup, 'run'));
  const termination = fixture(); termination.nodes[0]!.termination = { signal: 'SIGKILL', initiator: 'parent', mode: 'immediate', propagated: true }; assert.ok(decodeSnapshot(termination, 'run'));
  set(termination, 'nodes.0.termination.propagated', 'false'); assert.throws(() => decodeSnapshot(termination, 'run'));
});

test('snapshot cross references reject foreign instances, sessions, groups, assignments, duplicate IDs and parent cycles', () => {
  const mutations: [string, unknown][] = [['run.rootSummary.id', 'foreign'], ['run.rootSummary.sessionID', 'foreign'], ['nodes.0.parentId', 'root'], ['nodes.0.source.sourceIds', ['foreign']], ['nodes.0.groups', ['foreign']], ['nodes.0.assignmentIds', ['foreign']], ['nodes.0.messages.0.source.agentId', 'foreign'], ['nodes.0.messages.0.source.sessionID', 'foreign'], ['nodes.0.messages.0.source.groupId', 'foreign'], ['nodes.0.messages.0.recipientId', 'foreign'], ['groups.0.members', ['foreign']], ['assignments.0.recipientInstanceId', 'foreign'], ['assignments.0.recipientSessionID', 'foreign'], ['assignments.0.sender.runId', 'foreign'], ['assignments.0.parentAssignmentId', 'assignment'], ['operations.0.target.agentId', 'foreign']];
  for (const [path, replacement] of mutations) { const value = fixture(); set(value, path, replacement); assert.throws(() => decodeSnapshot(value, 'run'), path); }
  const duplicate = fixture(); duplicate.nodes.push(structuredClone(duplicate.nodes[0]!)); assert.throws(() => decodeSnapshot(duplicate, 'run'));
  assert.throws(() => decodeRunEvent({ runId: 'run', seq: 1, timestamp: 1, type: 'node-usage', node: { id: 'partial' } }));
  assert.throws(() => decodeRunEvent({ runId: 'run', seq: 1, timestamp: 1, type: 'operation-result', operation: { id: 'op', target: { scope: 'run', agentId: 'root' }, status: 'completed' } }));
});

test('accepted and failed stop operations preserve unknown requested targets while completed targets must exist', () => {
  for (const status of ['accepted', 'failed'] as const) {
    const value = fixture(); value.operations = [{ id: 'unknown-stop', target: { agentId: 'missing-instance' }, status, ...(status === 'failed' ? { error: 'Target is not in this run' } : {}) }];
    const decoded = decodeSnapshot(value, 'run');
    assert.deepEqual(decoded.operations, value.operations);
  }
  const value = fixture(); value.operations[0]!.target = { agentId: 'missing-instance' };
  assert.throws(() => decodeSnapshot(value, 'run'), /instance reference/);
});
