/**
 * The panel's data operations.
 *
 * Every call goes straight to a generated `ctx.remote.flow.*` method: there is
 * no op-string dispatcher, no hand-written client signature and no fetch. The
 * failure branch of every `RemoteResult` is turned into a thrown error at this
 * one seam, so the components above it only ever see values or exceptions.
 *
 * A query is narrowed by the tag the *answer* carries, never by the tag the
 * caller asked for — and without a cast: the answer is destructured once from
 * its discriminated union, so checking `what` narrows `data` to that branch.
 * A mismatched tag is a defect in the assembly, so it throws.
 */
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type {} from 'dsh-flow/remote';

import type {
  FlowClusterAgentsQueryData,
  FlowClusterBudgetsQueryData,
  FlowClusterContextQueryData,
  FlowClusterDeliveriesQueryData,
  FlowClusterHealthQueryData,
  FlowClusterNodeQueryData,
  FlowClusterNodesQueryData,
  FlowClusterTransactionQueryData,
  FlowClusterTransactionsQueryData,
  FlowClusterUsageQueryData,
  FlowControlAction,
  FlowEventQuery,
  FlowEventsResult,
  FlowListQuery,
  FlowListResult,
  FlowPage,
  FlowQueryParams,
  FlowReadQuery,
  FlowReport,
  FlowSnapshot,
  FlowStartRequest,
} from '../types.ts';

/** The generated client namespace for this plugin. */
export type FlowRemoteNamespace = TypertRemoteNamespaceMap['flow'];

/** The default page size of an expanded list view. */
export const PAGE_SIZE = 50;

/** The largest page a single query may ask for. */
export const MAX_QUERY_LIMIT = 500;

/** One page for a list view that has already been expanded to `loadedCount` rows. */
export type FetchPage<T> = (limit: number, offset: number) => Promise<FlowPage<T>>;

/** Everything the panel calls. */
export interface PanelOperations {
  /** Start one cluster. */
  start(request: FlowStartRequest): Promise<FlowSnapshot>
  /** List clusters. */
  list(request: FlowListQuery): Promise<FlowListResult>
  /** Read one cluster snapshot. */
  read(id: string, request: FlowReadQuery): Promise<FlowSnapshot>
  /** Read one page of events. */
  events(id: string, request: FlowEventQuery): Promise<FlowEventsResult>
  /** Pause, resume or cancel one cluster. */
  control(id: string, action: FlowControlAction): Promise<FlowSnapshot>
  /** Produce one cluster's mechanism report. */
  report(id: string): Promise<FlowReport>
  /** Management-tree nodes. */
  nodes(id: string, params: FlowQueryParams): Promise<FlowClusterNodesQueryData>
  /** One node's topology, transactions and agents. */
  node(id: string, params: FlowQueryParams): Promise<FlowClusterNodeQueryData>
  /** Transactions in the operator's domain. */
  transactions(id: string, params: FlowQueryParams): Promise<FlowClusterTransactionsQueryData>
  /** One transaction with its gates and saved result. */
  transaction(id: string, params: FlowQueryParams): Promise<FlowClusterTransactionQueryData>
  /** Budget rows. */
  budgets(id: string, params: FlowQueryParams): Promise<FlowClusterBudgetsQueryData>
  /** Model-request receipts and the usage they roll up to. */
  usage(id: string, params: FlowQueryParams): Promise<FlowClusterUsageQueryData>
  /** Message deliveries. */
  deliveries(id: string, params: FlowQueryParams): Promise<FlowClusterDeliveriesQueryData>
  /** The latest health evaluation and its signals. */
  health(id: string, params: FlowQueryParams): Promise<FlowClusterHealthQueryData>
  /** Cluster agents. */
  agents(id: string, params: FlowQueryParams): Promise<FlowClusterAgentsQueryData>
  /** One identity's context steps and latest summary. */
  context(id: string, params: FlowQueryParams): Promise<FlowClusterContextQueryData>
}

/**
 * Build the panel's operations over one mounted Remote namespace.
 *
 * `flow` is read from the live Context when the panel registers, so an
 * unmounted or replaced contribution cannot leave a stale client object here.
 * @param flow - the generated `remote.flow` namespace.
 * @returns the operations the panel components receive.
 */
export function createPanelOperations(flow: FlowRemoteNamespace): PanelOperations {
  return {
    // One unary call: take the value, or rethrow the typed failure.
    async start(request) {
      const result = await flow.start(request);
      if (!result.ok) throw result.error;
      return result.value;
    },
    async list(request) {
      const result = await flow.list(request);
      if (!result.ok) throw result.error;
      return result.value;
    },
    async read(id, request) {
      const result = await flow.read(id, request);
      if (!result.ok) throw result.error;
      return result.value;
    },
    async events(id, request) {
      const result = await flow.events(id, request);
      if (!result.ok) throw result.error;
      return result.value;
    },
    async control(id, action) {
      const result = await flow.control(id, action);
      if (!result.ok) throw result.error;
      return result.value;
    },
    async report(id) {
      const result = await flow.report(id);
      if (!result.ok) throw result.error;
      return result.value;
    },

    // One tagged query: destructure the answer, then prove the tag before the
    // payload is used. The check narrows `data` to this branch.
    async nodes(id, params) {
      const result = await flow.query(id, 'nodes', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'nodes') throw queryKindMismatch('nodes', what);
      return data;
    },
    async node(id, params) {
      const result = await flow.query(id, 'node', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'node') throw queryKindMismatch('node', what);
      return data;
    },
    async transactions(id, params) {
      const result = await flow.query(id, 'transactions', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'transactions') throw queryKindMismatch('transactions', what);
      return data;
    },
    async transaction(id, params) {
      const result = await flow.query(id, 'transaction', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'transaction') throw queryKindMismatch('transaction', what);
      return data;
    },
    async budgets(id, params) {
      const result = await flow.query(id, 'budgets', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'budgets') throw queryKindMismatch('budgets', what);
      return data;
    },
    async usage(id, params) {
      const result = await flow.query(id, 'usage', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'usage') throw queryKindMismatch('usage', what);
      return data;
    },
    async deliveries(id, params) {
      const result = await flow.query(id, 'deliveries', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'deliveries') throw queryKindMismatch('deliveries', what);
      return data;
    },
    async health(id, params) {
      const result = await flow.query(id, 'health', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'health') throw queryKindMismatch('health', what);
      return data;
    },
    async agents(id, params) {
      const result = await flow.query(id, 'agents', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'agents') throw queryKindMismatch('agents', what);
      return data;
    },
    async context(id, params) {
      const result = await flow.query(id, 'context', params);
      if (!result.ok) throw result.error;
      const { what, data } = result.value;
      if (what !== 'context') throw queryKindMismatch('context', what);
      return data;
    },
  };
}

/**
 * Re-read every page an operator has expanded, not just the first one.
 * @param fetchPage - the caller's concrete page reader.
 * @param loadedCount - how many rows the view already shows.
 * @param pageSize - minimum page size.
 * @param maxPage - the largest page one request may ask for.
 * @returns the combined page, with `next_offset` describing what is still unread.
 */
export async function queryLoaded<T>(
  fetchPage: FetchPage<T>,
  loadedCount: number,
  pageSize = PAGE_SIZE,
  maxPage = MAX_QUERY_LIMIT,
): Promise<FlowPage<T>> {
  const target = Math.max(pageSize, loadedCount);
  const items: T[] = [];
  let total = 0;
  let offset = 0;
  while (items.length < target) {
    // eslint-disable-next-line no-await-in-loop -- page reads are sequential by construction.
    const page = await fetchPage(Math.min(maxPage, target - items.length), offset);
    items.push(...page.items);
    total = page.total;
    if (page.next_offset === null || page.next_offset <= offset) break;
    offset = page.next_offset;
  }
  return {
    items,
    total,
    offset: 0,
    limit: target,
    next_offset: items.length < total ? items.length : null,
  };
}

function queryKindMismatch(requested: string, received: string): Error {
  return new Error(`flow/query-kind-mismatch: asked ${requested}, received ${received}`);
}