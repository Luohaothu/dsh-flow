import { asObject } from './context.ts';

type Row = Readonly<Record<string, unknown>>;

function ref(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return asObject(JSON.parse(value)); } catch { return null; }
  }
  return asObject(value);
}

function samePlan(left: unknown, right: unknown): boolean {
  const a = ref(left), b = ref(right);
  return a !== null && b !== null && Object.keys(a).length === 2 && Object.keys(b).length === 2
    && typeof a.transaction_id === 'string' && Number.isSafeInteger(a.prepared_revision)
    && a.transaction_id === b.transaction_id && a.prepared_revision === b.prepared_revision;
}

/** Worker residence and task ownership are connected by a persisted allocation. */
export function isCurrentWorkerProducer(
  tx: Row, publication: Row | undefined, agents: readonly Row[], nodes: readonly Row[], allocations: readonly Row[],
): boolean {
  if (!publication || publication.producer_role !== 'worker' || publication.cluster_id !== tx.cluster_id
    || ref(publication.ref)?.transaction_id !== tx.id || !samePlan(publication.plan_ref, tx.current_plan_ref)) return false;
  const agent = agents.find(row => row.id === publication.producer_agent_id && row.role === 'worker' && row.cluster_id === tx.cluster_id);
  if (!agent || !nodes.some(node => node.id === agent.node_id && node.kind === 'worker'
    && node.cluster_id === tx.cluster_id && node.parent_id === tx.node_id)) return false;
  return allocations.some(allocation => allocation.cluster_id === tx.cluster_id && allocation.agent_id === agent.id
    && allocation.transaction_id === tx.id && allocation.node_id === tx.node_id
    && samePlan(allocation.plan_ref, tx.current_plan_ref));
}
