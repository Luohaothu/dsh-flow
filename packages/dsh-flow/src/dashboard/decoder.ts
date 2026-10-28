import type { AssignmentSnapshot, AssignmentSpec, JsonObject, JsonSchema, JsonValue, SubmissionReceipt } from '../assignments/types.js';
import { PROTOCOL_VERSION, type AgentCard, type GroupView, type MessageSourceView, type OperationView, type RegistryEvent,
  type RegistrySnapshot, type RunEvent, type RunInfo, type RunSnapshot, type StopTarget, type TokenResponse, type UsageView } from './protocol.js';

export class IncompatibleProtocol extends Error {}
function invalid(label: string): never { throw new TypeError(`Invalid dashboard ${label}`); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object'); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== 'string') return invalid('string'); return value; }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid('finite nonnegative number'); return value; }
function count(value: unknown): number { const n = number(value); if (!Number.isSafeInteger(n)) return invalid('integer'); return n; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid('boolean'); return value; }
function list<T>(value: unknown, decode: (item: unknown) => T): T[] { if (!Array.isArray(value)) return invalid('array'); return value.map(decode); }
function nullable<T>(value: unknown, decode: (item: unknown) => T): T | null { return value === null ? null : decode(value); }
function tag<const T extends readonly string[]>(value: unknown, allowed: T): T[number] { if (typeof value !== 'string' || !allowed.includes(value)) return invalid('tag'); return value as T[number]; }
function model(value: unknown) { const v = record(value); return { provider: text(v.provider), id: text(v.id) }; }
function protocol(value: unknown) {
  const v = record(value), major = count(v.major), minor = count(v.minor);
  if (major !== PROTOCOL_VERSION.major || minor < PROTOCOL_VERSION.minor) throw new IncompatibleProtocol(
    `Incompatible dashboard protocol ${major}.${minor}; requires major ${PROTOCOL_VERSION.major} with minor >= ${PROTOCOL_VERSION.minor} (${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor})`);
  return { major, minor };
}
function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) return invalid('JSON number'); return value; }
  if (Array.isArray(value)) return value.map(json);
  const result: JsonObject = {}; for (const [key, child] of Object.entries(record(value))) Object.defineProperty(result, key, { value: json(child), enumerable: true, writable: true, configurable: true }); return result;
}
function schema(value: unknown): JsonSchema { if (typeof value === 'boolean') return value; const result: JsonObject = {}; for (const [key, child] of Object.entries(record(value))) Object.defineProperty(result, key, { value: json(child), enumerable: true }); return result; }
function child(value: unknown) { const v = record(value); return { assignmentId: text(v.assignmentId), reason: text(v.reason) }; }
function receipt(value: unknown): SubmissionReceipt {
  const v = record(value), status = tag(v.status, ['pending', 'submitted', 'failed', 'cancelled']), kind = tag(v.kind, ['accepted', 'missing-children', 'invalid-result', 'terminal']);
  if ((kind === 'accepted' && status !== 'submitted') || (kind === 'terminal' && status === 'pending')
    || (kind === 'missing-children' && (status !== 'pending' || v.missingChildren === undefined))
    || (kind === 'invalid-result' && (!['pending', 'failed'].includes(status) || v.errors === undefined))) return invalid('receipt combination');
  return { kind, assignmentId: text(v.assignmentId), status,
    ...(v.missingChildren === undefined ? {} : { missingChildren: list(v.missingChildren, text) }),
    ...(v.errors === undefined ? {} : { errors: list(v.errors, item => { const e = record(item); return { path: text(e.path), message: text(e.message) }; }) }) };
}
function spec(value: unknown): AssignmentSpec {
  const v = record(value); return { name: text(v.name), type: text(v.type), background: text(v.background), requirements: text(v.requirements), acceptanceCriteria: text(v.acceptanceCriteria), resultSchema: schema(v.resultSchema),
    ...(v.materials === undefined ? {} : { materials: list(v.materials, item => { const m = record(item); return { id: text(m.id), sourceId: text(m.sourceId), digest: text(m.digest), location: text(m.location), mediaType: text(m.mediaType) }; }) }),
    ...(v.resumesAssignmentId === undefined ? {} : { resumesAssignmentId: text(v.resumesAssignmentId) }) };
}
export function decodeAssignment(value: unknown): AssignmentSnapshot {
  const v = record(value), actor = record(v.sender), sender = actor.kind === 'run' ? { kind: 'run' as const, runId: text(actor.runId) }
    : { kind: tag(actor.kind, ['agent']), sessionID: text(actor.sessionID), instanceId: text(actor.instanceId) };
  const result: AssignmentSnapshot = { id: text(v.id), runId: text(v.runId), spec: spec(v.spec), sender, recipientSessionID: text(v.recipientSessionID), recipientInstanceId: text(v.recipientInstanceId), parentAssignmentId: nullable(v.parentAssignmentId, text), status: tag(v.status, ['pending', 'submitted', 'failed', 'cancelled']),
    submissions: list(v.submissions, item => { const a = record(item), s = record(a.submission); return { transportKey: text(a.transportKey), timestamp: number(a.timestamp), submission: { result: json(s.result), continuingChildren: list(s.continuingChildren, child) }, receipt: receipt(a.receipt) }; }),
    submissionCount: count(v.submissionCount), schemaFailures: count(v.schemaFailures), schemaDialect: text(v.schemaDialect), schemaDigest: text(v.schemaDigest), continuingChildren: list(v.continuingChildren, child),
    ...(Object.hasOwn(v, 'result') ? { result: json(v.result) } : {}), ...(v.reason === undefined ? {} : { reason: text(v.reason) }) };
  if (result.submissionCount !== result.submissions.length || result.schemaFailures > 3 || (result.status === 'submitted' && !Object.hasOwn(result, 'result'))
    || result.submissions.some(a => a.receipt.assignmentId !== result.id)) return invalid('assignment combination');
  return result;
}
export function decodeRunInfo(value: unknown): RunInfo {
  const v = record(value), entry = record(v.entry);
  const result: RunInfo = { id: text(v.id), epoch: text(v.epoch), name: text(v.name), entry: { backend: text(entry.backend), callerSessionId: text(entry.callerSessionId) },
    rootSummary: nullable(v.rootSummary, item => { const r = record(item); return { id: text(r.id), name: text(r.name), sessionID: text(r.sessionID) }; }),
    status: tag(v.status, ['starting', 'active', 'stopping', 'stopped', 'failed', 'invalid']), startedAt: number(v.startedAt), pendingAssignmentCount: count(v.pendingAssignmentCount),
    ...(v.endedAt === undefined ? {} : { endedAt: number(v.endedAt) }), ...(v.error === undefined ? {} : { error: text(v.error) }), ...(v.storageError === undefined ? {} : { storageError: text(v.storageError) }) };
  if (result.endedAt !== undefined && result.endedAt < result.startedAt) return invalid('run times'); return result;
}
function source(value: unknown): MessageSourceView {
  const v = record(value);
  if (v.kind === 'user' || v.kind === 'system') return { kind: v.kind };
  const common = { agentId: text(v.agentId), sessionID: text(v.sessionID), name: text(v.name) };
  return v.kind === 'group' ? { ...common, kind: 'group', groupId: text(v.groupId) } : { ...common, kind: tag(v.kind, ['agent']) };
}
function usage(value: unknown): UsageView {
  const v = record(value); return { callId: text(v.callId), timestamp: number(v.timestamp), model: model(v.model),
    ...(v.kind === undefined ? {} : { kind: tag(v.kind, ['main', 'auxiliary', 'compaction']) }),
    ...(v.inputTokens === undefined ? {} : { inputTokens: count(v.inputTokens) }), ...(v.outputTokens === undefined ? {} : { outputTokens: count(v.outputTokens) }),
    ...(v.cacheReadTokens === undefined ? {} : { cacheReadTokens: count(v.cacheReadTokens) }), ...(v.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: count(v.cacheWriteTokens) }),
    ...(v.totalTokens === undefined ? {} : { totalTokens: count(v.totalTokens) }), amount: nullable(v.amount, number), currency: nullable(v.currency, text) };
}
export function decodeNode(value: unknown): AgentCard {
  const v = record(value), origin = record(v.source);
  const node: AgentCard = { id: text(v.id), parentId: nullable(v.parentId, text), sessionID: text(v.sessionID), name: text(v.name), role: text(v.role), model: model(v.model), permission: tag(v.permission, ['read-only', 'workspace-write', 'full-access']), task: text(v.task), status: tag(v.status, ['running', 'waiting', 'idle', 'terminated']),
    source: { kind: tag(origin.kind, ['create', 'resume', 'fork', 'herb', 'retry']), sourceIds: list(origin.sourceIds, text), ...(origin.resumeSessionID === undefined ? {} : { resumeSessionID: text(origin.resumeSessionID) }) },
    waiting: nullable(v.waiting, item => { const w = record(item); const result = { target: text(w.target), startedAt: number(w.startedAt), deadline: number(w.deadline) }; if (result.deadline < result.startedAt) return invalid('wait deadline'); return result; }),
    outcome: nullable(v.outcome, item => tag(item, ['completed', 'failed', 'stopped'])),
    termination: nullable(v.termination, item => { const o = record(item); return { signal: tag(o.signal, ['SIGTERM', 'SIGKILL']), initiator: tag(o.initiator, ['user', 'parent', 'context', 'self']), mode: tag(o.mode, ['after-turn', 'immediate']), propagated: boolean(o.propagated) }; }),
    cleanup: nullable(v.cleanup, item => { const c = record(item); return { phase: tag(c.phase, ['pending', 'waiting', 'releasing', 'complete', 'failed', 'abandoned']), timestamp: number(c.timestamp), ...(c.reason === undefined ? {} : { reason: text(c.reason) }), ...(c.deadline === undefined ? {} : { deadline: number(c.deadline) }), ...(c.persistenceError === undefined ? {} : { persistenceError: text(c.persistenceError) }) }; }),
    markers: list(v.markers, item => { const m = record(item); return { id: text(m.id), kind: text(m.kind), timestamp: number(m.timestamp), message: text(m.message) }; }), usage: list(v.usage, usage), createdAt: number(v.createdAt), terminatedAt: nullable(v.terminatedAt, number),
    messages: list(v.messages, item => { const m = record(item); return { id: text(m.id), source: source(m.source), recipientId: text(m.recipientId), timestamp: number(m.timestamp), summary: text(m.summary), priority: tag(m.priority, ['high', 'normal', 'low']), read: boolean(m.read), readTimestamp: nullable(m.readTimestamp, number) }; }),
    blackboardWrites: list(v.blackboardWrites, item => { const w = record(item); return { id: text(w.id), groupId: text(w.groupId), startedAt: number(w.startedAt) }; }), assignmentIds: list(v.assignmentIds, text), groups: list(v.groups, text),
    outputs: list(v.outputs, item => { const o = record(item); return { timestamp: number(o.timestamp), text: text(o.text) }; }), errors: list(v.errors, item => { const e = record(item); return { timestamp: number(e.timestamp), message: text(e.message) }; }) };
  if (node.terminatedAt !== null && node.terminatedAt < node.createdAt) return invalid('node times');
  if ((node.source.kind === 'resume') !== (node.source.resumeSessionID !== undefined)) return invalid('resume source');
  return node;
}
export function decodeGroup(value: unknown): GroupView { const v = record(value); return { id: text(v.id), members: list(v.members, text), dissolved: boolean(v.dissolved), blackboard: list(v.blackboard, item => { const b = record(item); return { id: text(b.id), source: source(b.source), timestamp: number(b.timestamp), summary: text(b.summary), payload: json(b.payload) }; }) }; }
function target(value: unknown): StopTarget { const v = record(value); if (typeof v.agentId === 'string' && v.scope === undefined) return { agentId: v.agentId }; if (v.scope === 'run' && v.agentId === undefined) return { scope: 'run' }; return invalid('operation target'); }
export function decodeOperation(value: unknown): OperationView { const v = record(value); return { id: text(v.id), target: target(v.target), status: tag(v.status, ['accepted', 'completed', 'failed']), ...(v.error === undefined ? {} : { error: text(v.error) }) }; }
export function decodeToken(value: unknown): TokenResponse { const v = record(value); return { token: text(v.token), epoch: text(v.epoch), version: protocol(v.version) }; }
export function decodeRegistry(value: unknown): RegistrySnapshot {
  const v = record(value), result: RegistrySnapshot = { version: protocol(v.version), epoch: text(v.epoch), seq: count(v.seq), runs: list(v.runs, decodeRunInfo), ...(v.degraded === undefined ? {} : { degraded: boolean(v.degraded) }) };
  if (result.runs.some(run => run.epoch !== result.epoch) || new Set(result.runs.map(run => run.id)).size !== result.runs.length) return invalid('registry identity'); return result;
}
export function decodeSnapshot(value: unknown, runId: string): RunSnapshot {
  const v = record(value), result: RunSnapshot = { version: protocol(v.version), seq: count(v.seq), run: decodeRunInfo(v.run), nodes: list(v.nodes, decodeNode), groups: list(v.groups, decodeGroup), assignments: list(v.assignments, decodeAssignment), operations: list(v.operations, decodeOperation),
    prices: list(v.prices, item => { const p = record(item); return { model: model(p.model), currency: text(p.currency), input: number(p.input), output: number(p.output), ...(p.cacheRead === undefined ? {} : { cacheRead: number(p.cacheRead) }), ...(p.cacheWrite === undefined ? {} : { cacheWrite: number(p.cacheWrite) }) }; }), ...(v.degraded === undefined ? {} : { degraded: boolean(v.degraded) }) };
  if (result.run.id !== runId) return invalid('selected run'); validateReferences(result); return result;
}
function unique<T extends { id: string }>(values: T[]): Map<string, T> { const result = new Map(values.map(value => [value.id, value])); if (result.size !== values.length) return invalid('duplicate identity'); return result; }
function validateReferences(snapshot: RunSnapshot): void {
  const nodes = unique(snapshot.nodes), groups = unique(snapshot.groups), assignments = unique(snapshot.assignments); unique(snapshot.operations);
  const hasNode = (id: string) => { if (!nodes.has(id)) invalid('instance reference'); };
  const hasGroup = (id: string) => { if (!groups.has(id)) invalid('group reference'); };
  const hasAssignment = (id: string) => { if (!assignments.has(id)) invalid('assignment reference'); };
  const checkSource = (s: MessageSourceView) => { if (s.kind === 'agent' || s.kind === 'group') { hasNode(s.agentId); if (nodes.get(s.agentId)!.sessionID !== s.sessionID) invalid('source Session identity'); if (s.kind === 'group') hasGroup(s.groupId); } };
  if (snapshot.run.rootSummary) { hasNode(snapshot.run.rootSummary.id); if (nodes.get(snapshot.run.rootSummary.id)!.sessionID !== snapshot.run.rootSummary.sessionID) invalid('root Session identity'); }
  for (const n of nodes.values()) {
    if (n.parentId !== null) hasNode(n.parentId); n.source.sourceIds.forEach(hasNode); n.groups.forEach(hasGroup); n.assignmentIds.forEach(hasAssignment);
    n.blackboardWrites.forEach(w => hasGroup(w.groupId));
    const ancestry = new Set([n.id]); let parent = n.parentId; while (parent !== null) { if (ancestry.has(parent)) invalid('parent cycle'); ancestry.add(parent); parent = nodes.get(parent)!.parentId; }
    for (const message of n.messages) { if (message.recipientId !== n.id) invalid('message recipient'); checkSource(message.source); }
    unique(n.messages); unique(n.usage.map(u => ({ id: u.callId }))); unique(n.markers); unique(n.blackboardWrites);
  }
  for (const group of groups.values()) { group.members.forEach(hasNode); group.blackboard.forEach(b => checkSource(b.source)); }
  for (const a of assignments.values()) {
    if (a.runId !== snapshot.run.id) invalid('assignment run'); hasNode(a.recipientInstanceId); if (nodes.get(a.recipientInstanceId)!.sessionID !== a.recipientSessionID) invalid('recipient Session identity');
    if (a.sender.kind === 'run') { if (a.sender.runId !== snapshot.run.id || a.parentAssignmentId !== null) invalid('assignment sender'); }
    else { hasNode(a.sender.instanceId); if (nodes.get(a.sender.instanceId)!.sessionID !== a.sender.sessionID || a.parentAssignmentId === null) invalid('assignment sender'); }
    if (a.parentAssignmentId !== null) { hasAssignment(a.parentAssignmentId); const p = assignments.get(a.parentAssignmentId)!; if (a.sender.kind !== 'agent' || p.recipientInstanceId !== a.sender.instanceId) invalid('assignment parent'); }
    const ancestry = new Set([a.id]); let parent = a.parentAssignmentId; while (parent !== null) { hasAssignment(parent); if (ancestry.has(parent)) invalid('assignment cycle'); ancestry.add(parent); parent = assignments.get(parent)!.parentAssignmentId; }
    for (const c of [...a.continuingChildren, ...a.submissions.flatMap(s => s.submission.continuingChildren)]) { hasAssignment(c.assignmentId); if (assignments.get(c.assignmentId)!.parentAssignmentId !== a.id) invalid('continuing child'); }
  }
  snapshot.operations.forEach(operation => {
    // Admission and failure preserve the requested identity even when lookup failed.
    if (operation.status === 'completed' && 'agentId' in operation.target && operation.target.agentId !== undefined) hasNode(operation.target.agentId);
  });
}
export function decodeRegistryEvent(value: unknown): RegistryEvent | { epoch: string; seq: number; type: 'unknown' } {
  const v = record(value), base = { epoch: text(v.epoch), seq: count(v.seq) }, type = text(v.type);
  if (!['run-appeared', 'run-changed', 'run-ended', 'run-invalidated'].includes(type)) return { ...base, type: 'unknown' };
  return { ...base, type: tag(type, ['run-appeared', 'run-changed', 'run-ended', 'run-invalidated']), run: decodeRunInfo(v.run) };
}
export function decodeRunEvent(value: unknown): RunEvent | { runId: string; seq: number; timestamp: number; type: 'unknown' } {
  const v = record(value), base = { runId: text(v.runId), seq: count(v.seq), timestamp: number(v.timestamp) }, type = text(v.type);
  if (['node-appeared', 'node-changed', 'node-terminated', 'node-usage', 'message-received', 'message-read', 'blackboard-write', 'node-cleanup'].includes(type)) return { ...base, type: tag(type, ['node-appeared', 'node-changed', 'node-terminated', 'node-usage', 'message-received', 'message-read', 'blackboard-write', 'node-cleanup']), node: decodeNode(v.node) };
  if (type === 'group-changed') return { ...base, type, group: decodeGroup(v.group) };
  if (type === 'assignment-changed') return { ...base, type, assignment: decodeAssignment(v.assignment) };
  if (type === 'operation-result') return { ...base, type, operation: decodeOperation(v.operation) };
  if (['run-changed', 'run-ended', 'run-invalidated'].includes(type)) return { ...base, type: tag(type, ['run-changed', 'run-ended', 'run-invalidated']), run: decodeRunInfo(v.run) };
  return { ...base, type: 'unknown' };
}
