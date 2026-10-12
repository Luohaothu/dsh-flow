/** Read-only evidence from the host's persisted native journal, never the effect ledger. */
import type { ClusterStore } from './store.ts';
import { canonical, decodeJson } from './store.ts';
import type { FlowActor, ResultRecord, ValidationRecord } from './model.ts';
import type { FlowPlanRef, FlowQueryParams } from '../types.ts';
import type { NativeSessionFact } from './native-usage.ts';
import { fail } from '../errors.ts';
import { normalizeLimit } from '../validation.ts';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function nativeResult(facts: readonly NativeSessionFact[], call: NativeSessionFact): NativeSessionFact | undefined {
  const data = object(call.data);
  // Parallel duplicates have no further native correlation identity. Neither
  // return can safely be attributed to either call in this ambiguous group.
  if (facts.filter(candidate => candidate.type === 'tool/call' && object(candidate.data)?.turn === data?.turn
    && object(candidate.data)?.step === data?.step && object(candidate.data)?.callId === data?.callId).length !== 1) return undefined;
  return facts.find(candidate => candidate.type === 'tool/result' && candidate.native_seq > call.native_seq
    && object(candidate.data)?.turn === data?.turn
    && object(candidate.data)?.step === data?.step && object(object(candidate.data)?.message)?.toolCallId === data?.callId);
}

/** The caller has already checked the selected object's domain and immutable refs. */
export function nativeToolEvidence(store: ClusterStore, actor: FlowActor, domain: ReadonlySet<string>, input: {
  transactionId: string; planRef: FlowPlanRef | null; result: ResultRecord | null; validation: ValidationRecord | null;
  params: FlowQueryParams; what: 'transaction' | 'assignment'; id?: string;
}): Record<string, unknown> {
  const sources = new Map<string, { facts: NativeSessionFact[]; turns: Map<number, { association: string; binding: Record<string, unknown> | null; lastCallSeq: number | null }> }>();
  const includeAgent = (agentId: string | null | undefined) => {
    if (!agentId) return null;
    const agent = store.getAgent(agentId);
    if (!agent || agent.cluster_id !== actor.cluster_id || actor.role !== 'user' && !domain.has(agent.node_id) && agent.id !== actor.agent_id) return null;
    const existing = sources.get(agent.id);
    if (existing) return existing;
    const facts = store.nativeEventsForAgent(agent.id).filter(fact => fact.cluster_id === actor.cluster_id
      && fact.node_id === agent.node_id && fact.native_session_id === agent.session_id && fact.role === agent.role);
    const source = { facts, turns: new Map<number, { association: string; binding: Record<string, unknown> | null; lastCallSeq: number | null }>() };
    sources.set(agent.id, source);
    return source;
  };
  const bindings = (agentId: string, facts: readonly NativeSessionFact[]) => {
    const byTurn = new Map<number, Record<string, unknown>>();
    const owner = store.getAgent(agentId);
    if (!owner) return byTurn;
    // ADMITTED is acknowledged after the turn drains. During that same turn,
    // the already-persisted native user/message is the precise admission proof;
    // a merely queued PENDING input has no matching native fact and stays out.
    const inputs = store.all('SELECT id,binding,native_message_id FROM member_inputs WHERE agent_id=? AND session_id=? AND cluster_id=?', agentId, owner.session_id, actor.cluster_id);
    const byMessage = new Map(inputs.map(row => [String(row.native_message_id), { id: String(row.id), binding: object(decodeJson(String(row.binding))) }]));
    const executions = store.all("SELECT data FROM events WHERE cluster_id=? AND type='member-input-execution-bound' AND json_extract(data,'$.agent_id')=? ORDER BY seq", actor.cluster_id, agentId)
      .map(row => object(decodeJson(String(row.data)))).filter(row => row?.session_id === owner.session_id);
    let turn: number | null = null;
    for (const fact of facts) {
      const data = object(fact.data);
      if (fact.type === 'turn/start' && typeof data?.turn === 'number') turn = data.turn;
      if (fact.type === 'turn/end') turn = null;
      if (fact.type === 'user/message' && turn !== null && typeof data?.id === 'string') {
        const saved = byMessage.get(data.id);
        if (!saved) continue;
        const execution = executions.findLast(row => row?.input_id === saved.id && row?.native_message_id === data.id
          && typeof row.after_native_seq === 'number' && fact.native_seq > row.after_native_seq);
        const binding = execution ? object(execution.binding) : saved?.binding;
        if (binding?.agent_id === agentId && Number.isInteger(binding.epoch) && Number.isInteger(binding.turn_seq)) {
          byTurn.set(turn, { ...binding, native_input_seq: fact.native_seq });
        }
      }
    }
    return byTurn;
  };
  const result = input.result;
  if (result?.producer_agent_id && result.turn_seq !== null) {
    const source = includeAgent(result.producer_agent_id);
    if (source) for (const [nativeTurn, binding] of bindings(result.producer_agent_id, source.facts)) {
      if (binding.transaction_id === input.transactionId && binding.turn_seq === result.turn_seq && binding.epoch === result.epoch && same(binding.plan_ref, result.plan_ref)) {
        source.turns.set(nativeTurn, { association: 'result-producer', binding, lastCallSeq: null });
      }
    }
  }
  const validation = input.validation;
  const managerCalls = new Map<string, { association: string; binding: Record<string, unknown>; lastCallSeq: null }>();
  const boundCalls = store.all("SELECT data,at FROM events WHERE cluster_id=? AND type='manager-tool-bound' AND json_extract(data,'$.transaction_id')=? ORDER BY seq", actor.cluster_id, input.transactionId);
  for (const row of boundCalls) {
    const bound = object(decodeJson(String(row.data)));
    if (!bound || typeof bound.agent_id !== 'string' || typeof bound.call_id !== 'string'
      || !same(bound.plan_ref, input.planRef) || !same(bound.result_ref, result?.ref ?? null)
      || validation && (bound.agent_id !== validation.author_agent_id || Number(row.at) > validation.created)) continue;
    const manager = store.getAgent(bound.agent_id);
    if (manager?.role !== 'orchestrator') continue;
    const source = includeAgent(manager.id);
    if (!source) continue;
    // The native input establishes the epoch/turn identity; the per-call
    // binding establishes which immutable result that particular call checked.
    for (const [nativeTurn, turnBinding] of bindings(manager.id, source.facts)) {
      if (turnBinding.epoch !== bound.epoch || turnBinding.turn_seq !== bound.turn_seq) continue;
      managerCalls.set(`${manager.id}:${nativeTurn}:${bound.call_id}`, { association: validation ? 'validation-author' : 'current-manager', binding: { ...bound, native_input_seq: turnBinding.native_input_seq }, lastCallSeq: null });
    }
  }
  const refs = { ...(input.planRef ? { plan_ref: input.planRef } : {}), ...(result ? { result_ref: result.ref } : {}),
    ...(validation ? { validation_ref: validation.ref } : {}) };
  const readWhat = input.what === 'assignment' ? 'transaction' : input.what;
  const readParams = { id: input.id ?? input.transactionId, ...refs, fields: ['evidence'] };
  const receipts: Record<string, unknown>[] = [];
  for (const [agentId, source] of sources) for (const fact of source.facts) {
    const call = object(fact.data), turn = typeof call?.turn === 'number'
      ? managerCalls.get(`${agentId}:${call.turn}:${String(call.callId)}`) ?? source.turns.get(call.turn) : null;
    if (fact.type !== 'tool/call' || !turn
      || typeof turn.binding?.native_input_seq === 'number' && fact.native_seq <= turn.binding.native_input_seq
      || typeof call?.callId !== 'string' || typeof call.name !== 'string'
      || turn.lastCallSeq !== null && fact.native_seq > turn.lastCallSeq) continue;
    const returned = nativeResult(source.facts, fact);
    const ref = { agent_id: agentId, native_session_id: fact.native_session_id, native_turn: call.turn,
      call_id: call.callId, call_seq: fact.native_seq, result_seq: returned?.native_seq ?? null };
    const detail = input.params.native_call_id === call.callId && input.params.native_session_id === fact.native_session_id
      && input.params.native_call_seq === fact.native_seq;
    receipts.push({ ref, tool: call.name, status: returned ? object(object(returned.data)?.message)?.isError === true ? 'error' : 'returned' : 'pending',
      association: turn.association, captured_binding: turn.binding ? { agent_id: turn.binding.agent_id, turn_seq: turn.binding.turn_seq,
        epoch: turn.binding.epoch ?? null, transaction_id: turn.binding.transaction_id, object: turn.binding.object, plan_ref: turn.binding.plan_ref, result_ref: turn.binding.result_ref ?? null, validation_ref: turn.binding.validation_ref } : null,
      read: { what: readWhat, params: { ...readParams, native_call_id: call.callId, native_session_id: fact.native_session_id, native_call_seq: fact.native_seq } },
      ...(detail ? { call: fact.data, result: returned?.data ?? null } : {}) });
  }
  const selected = input.params.native_call_id ? receipts.filter(receipt => object(receipt.ref)?.call_id === input.params.native_call_id
    && object(receipt.ref)?.native_session_id === input.params.native_session_id && object(receipt.ref)?.call_seq === input.params.native_call_seq) : receipts;
  if (input.params.native_call_id && selected.length === 0) fail('Native tool receipt is not associated with this object or is outside this actor domain', 404);
  const limit = Math.min(normalizeLimit(input.params.limit, 6), 8);
  const offset = typeof input.params.offset === 'number' && Number.isInteger(input.params.offset) && input.params.offset >= 0 ? input.params.offset : 0;
  return { items: selected.slice(offset, offset + limit), total: selected.length, offset, limit,
    next_offset: offset + limit < selected.length ? offset + limit : null,
    read: { what: readWhat, params: { ...readParams, limit, offset: offset + limit } },
    coverage: 'persisted-native-events',
    meaning: 'These receipts prove the listed native tool calls and returned content. Captured input binding is not a claim that every call checks this business criterion. Empty or pending receipts do not prove that no tool ran; effects only records external side effects.' };
}
