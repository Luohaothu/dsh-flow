/**
 * dsh-flow cluster panel (browser half).
 *
 * A global panel: it belongs to the profile, not to a Session. Every host read
 * goes through the `PanelOperations` object the assembly hands it (the generated
 * `remote.flow` methods, wrapped once). Nothing here reaches the model: the
 * panel never impersonates a cluster role, and it never invents a number the
 * host did not report — an unmeasured value is shown as unknown.
 *
 * The panel renders exactly what the previous implementation rendered: the one
 * field it once read that no producer writes (a report's `mechanism_pass`) is
 * the fixed `unknown` stat, and the dead `snapshot.transactions.items` access
 * is gone.
 */
import * as React from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

import { messageOf, rejectionStatus } from '../errors.ts';
import { validateBudget, validateCapabilities } from '../validation.ts';
import type {
  FlowAgentReference,
  FlowBudgetInput,
  FlowClusterBudgetsQueryData,
  FlowClusterContextQueryData,
  FlowClusterDeliveriesQueryData,
  FlowClusterHealthQueryData,
  FlowClusterListItem,
  FlowClusterNodesQueryData,
  FlowClusterTransactionQueryData,
  FlowClusterTransactionsQueryData,
  FlowControlAction,
  FlowEventRecord,
  FlowJsonValue,
  FlowNodeReference,
  FlowPage,
  FlowReport,
  FlowSnapshot,
  FlowStartRequest,
  FlowTransactionRecord,
  FlowTransactionReference,
  FlowUsageReceipt,
  FlowUsageSummary,
} from '../types.ts';
import { PAGE_SIZE, queryLoaded, type PanelOperations } from './operations.ts';

export const PANEL_ID = 'flow-cluster';
const EVENT_PAGE = 200;

const tabs = ['tree', 'transactions', 'communication', 'context', 'health', 'resources'] as const;
type Tab = (typeof tabs)[number];

/** A start-form refusal: the operator's own input is wrong, so it belongs in the form's error line. */
class FormRefusal extends Error {}

/** Props of the `main` keyed slot occupant. */
export type ClusterPanelProps = PropsRuntime<'main'> & {
  readonly flow: PanelOperations
  readonly subscribeReset: (listener: () => void) => () => void
};

/** The budget ledger the Resources tab shows: a budget page plus the usage roll-up. */
interface BudgetsView extends FlowClusterBudgetsQueryData {
  readonly usage: FlowUsageSummary
  readonly receipts: readonly FlowUsageReceipt[]
}

/** The panel's shared visibility snapshot for the polling refresh. */
interface VisibleState {
  readonly tab: Tab
  readonly children: Record<string, FlowClusterNodesQueryData | null>
  readonly txPage: Record<string, FlowPage<FlowTransactionReference>>
  readonly txList: FlowClusterTransactionsQueryData | null
  readonly deliveries: FlowClusterDeliveriesQueryData | null
  readonly budgets: BudgetsView | null
}

/** The observed failure envelope the Events list implies. */
interface ObservedFailure {
  readonly failureClass: 'LIMIT_REACHED' | 'MECHANISM' | null
  readonly code: string | null
  readonly reason: string | null
  readonly scope: string | null
  readonly dimension: string | null
  readonly requested: string | null
  readonly available: string | null
}

const LIMIT_FAILURE_CODES: readonly string[] = ['BUDGET_EXHAUSTED', 'LIMIT_REACHED', 'DEADLINE_EXCEEDED'];
const MECHANISM_FAILURE_CODES: readonly string[] = [
  'CONTEXT_PRESSURE', 'SESSION_MISSING', 'DELIVERY_UNKNOWN', 'ACCOUNTING_UNCERTAIN', 'EFFECT_UNCERTAIN',
];

/** Render one possibly-absent JValue for a text line. */
function scalarText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

/** Narrow a JValue to a JSON object, or null when it is any other JSON shape. */
function jsonRecord(value: FlowJsonValue): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The sidebar icon for the global panel row. */
export function PanelIcon(_props: PropsRuntime<'sidebar.panellist'>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6}>
      <circle cx={12} cy={5} r={2.4} />
      <circle cx={5} cy={18} r={2.4} />
      <circle cx={19} cy={18} r={2.4} />
      <path d="M12 7.4 5.9 15.6M12 7.4l6.1 8.2M7.4 18h9.2" />
    </svg>
  );
}

/** The global cluster panel. */
export function ClusterPanel({ flow, subscribeReset }: ClusterPanelProps): React.JSX.Element {
  const [clusters, setClusters] = React.useState<readonly FlowClusterListItem[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<FlowSnapshot | null>(null);
  const [events, setEvents] = React.useState<readonly FlowEventRecord[]>([]);
  const [cursor, setCursor] = React.useState<{ cluster_id: string | null; seq: number }>({ cluster_id: null, seq: 0 });
  const [tab, setTab] = React.useState<Tab>('tree');
  const [children, setChildren] = React.useState<Record<string, FlowClusterNodesQueryData | null>>({});
  const [txPage, setTxPage] = React.useState<Record<string, FlowPage<FlowTransactionReference>>>({});
  const [txList, setTxList] = React.useState<FlowClusterTransactionsQueryData | null>(null);
  const [txDetail, setTxDetail] = React.useState<FlowClusterTransactionQueryData | null>(null);
  const [deliveries, setDeliveries] = React.useState<FlowClusterDeliveriesQueryData | null>(null);
  const [context, setContext] = React.useState<FlowClusterContextQueryData | null>(null);
  const [contextAgents, setContextAgents] = React.useState<readonly FlowAgentReference[]>([]);
  const [contextAgentId, setContextAgentId] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<FlowClusterHealthQueryData | null>(null);
  const [budgets, setBudgets] = React.useState<BudgetsView | null>(null);
  const [report, setReport] = React.useState<FlowReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ objective: '', workspace: '', capabilities: 'fs_read,fs_write', budget: '' });

  const selectedRef = React.useRef<string | null>(null);
  const cursorRef = React.useRef<{ cluster_id: string | null; seq: number }>({ cluster_id: null, seq: 0 });
  const eventReadRef = React.useRef<string | null>(null);
  const contextAgentRef = React.useRef<string | null>(null);
  /** Every write into state is fenced to the cluster and to the connection generation it was read under. */
  const generationRef = React.useRef(0);
  const visibleRef = React.useRef<VisibleState>({ tab: 'tree', children: {}, txPage: {}, txList: null, deliveries: null, budgets: null });
  const refreshVisibleRef = React.useRef<(clusterId: string) => Promise<void>>(async () => {});
  visibleRef.current = { tab, children, txPage, txList, deliveries, budgets };
  selectedRef.current = selected;

  /** Every write into state is guarded by the cluster it belongs to: an older
   *  in-flight response must never overwrite a newer selection, and a response
   *  from a discarded connection generation must never be applied at all. */
  const applyFor = React.useCallback((clusterId: string, generation: number, fn: () => void) => {
    if (selectedRef.current !== clusterId || generation !== generationRef.current) return;
    fn();
  }, []);

  const selectCluster = (id: string): void => {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    setSelected(id);
    const position = { cluster_id: id, seq: 0 };
    cursorRef.current = position;
    setCursor(position);
    setEvents([]);
    setChildren({});
    setTxPage({});
    setSnapshot(null);
    setTxList(null);
    setTxDetail(null);
    setDeliveries(null);
    setContext(null);
    contextAgentRef.current = null;
    setContextAgentId(null);
    setContextAgents([]);
    setHealth(null);
    setBudgets(null);
    setReport(null);
  };

  const refresh = React.useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    try {
      const listed = await flow.list({});
      const active = selectedRef.current ?? listed.clusters[0]?.id ?? null;
      setClusters(listed.clusters);
      if (!active) {
        setSelected(null);
        setSnapshot(null);
        return;
      }
      if (active !== selectedRef.current) {
        // A different cluster: start its event cursor from scratch rather than
        // carrying the previous cluster's sequence forward.
        selectedRef.current = active;
        const position = { cluster_id: active, seq: 0 };
        cursorRef.current = position;
        setCursor(position);
        setEvents([]);
        setTxPage({});
        setChildren({});
        setSnapshot(null);
        setTxDetail(null);
        setDeliveries(null);
        setContext(null);
        contextAgentRef.current = null;
        setContextAgentId(null);
        setContextAgents([]);
        setHealth(null);
        setBudgets(null);
        setTxList(null);
        setReport(null);
        setSelected(active);
      }
      const data = await flow.read(active, { include_events: false });
      applyFor(active, generation, () => setSnapshot(data));

      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [applyFor]);

  /** Event ids are global database ids: gaps between this cluster's ids do not
   *  mean its stream lost events. Continue from the last event we actually saw. */
  const readEvents = React.useCallback(async (clusterId: string): Promise<void> => {
    if (eventReadRef.current === clusterId) return;
    eventReadRef.current = clusterId;
    const generation = generationRef.current;
    try {
      const position = cursorRef.current;
      const page = await flow.events(clusterId, {
        since: position.cluster_id === clusterId ? position.seq : 0, limit: EVENT_PAGE,
      });
      applyFor(clusterId, generation, () => {
        const current = cursorRef.current;
        const fresh = page.events.filter(event => event.seq > (current.cluster_id === clusterId ? current.seq : 0));
        if (!fresh.length) return;
        const last = fresh[fresh.length - 1];
        if (!last) return;
        const next = { cluster_id: clusterId, seq: last.seq };
        cursorRef.current = next;
        setCursor(next);
        setEvents(previous => [...previous, ...fresh].slice(-500));
      });
    } catch (cause) {
      applyFor(clusterId, generation, () => setError(messageOf(cause)));
    } finally {
      eventReadRef.current = null;
    }
  }, [applyFor]);

  /**
   * The transaction list is read from the role-facing query surface, which
   * answers with `{items, total, next_offset}`. `read` returns a snapshot array
   * (a page without a total), which is not enough to tell a complete list from
   * a truncated one.
   */
  const loadTransactions = async (clusterId: string, offset = 0): Promise<void> => {
    const generation = generationRef.current;
    try {
      const page = await flow.transactions(clusterId, { limit: PAGE_SIZE, offset });
      applyFor(clusterId, generation, () => setTxList(current => (offset === 0 || !current
        ? page
        : { ...page, items: [...current.items, ...page.items] })));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const loadBudgets = async (clusterId: string, offset = 0): Promise<void> => {
    const generation = generationRef.current;
    try {
      const page = await flow.budgets(clusterId, { limit: PAGE_SIZE, offset });
      const usage = await flow.usage(clusterId, { limit: 20 });
      applyFor(clusterId, generation, () => setBudgets(current => ({
        ...page,
        items: offset === 0 ? page.items : [...(current?.items ?? []), ...page.items],
        usage: usage.usage,
        receipts: usage.items,
      })));
    } catch (cause) {
      applyFor(clusterId, generation, () => setError(messageOf(cause)));
    }
  };

  const loadDeliveries = async (clusterId: string, offset = 0): Promise<void> => {
    const generation = generationRef.current;
    try {
      const page = await flow.deliveries(clusterId, { limit: PAGE_SIZE, offset });
      applyFor(clusterId, generation, () => setDeliveries(current => (offset === 0
        ? page : { ...page, items: [...(current?.items ?? []), ...page.items] })));
    } catch (cause) {
      applyFor(clusterId, generation, () => setError(messageOf(cause)));
    }
  };

  const loadHealth = async (clusterId: string): Promise<void> => {
    const generation = generationRef.current;
    try {
      const body = await flow.health(clusterId, {});
      applyFor(clusterId, generation, () => setHealth(body));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const loadContext = async (clusterId: string, requestedId: string | null = contextAgentRef.current): Promise<void> => {
    const generation = generationRef.current;
    try {
      let agentId = requestedId;
      if (!agentId) {
        const agents = await flow.agents(clusterId, { limit: 500 });
        agentId = agents.items[0]?.id ?? null;
        const selectedAgent = agentId;
        applyFor(clusterId, generation, () => {
          setContextAgents(agents.items);
          if (selectedAgent && !contextAgentRef.current) {
            contextAgentRef.current = selectedAgent;
            setContextAgentId(selectedAgent);
          }
        });
      }
      if (!agentId) return;
      const boundAgent = agentId;
      const body = await flow.context(clusterId, { agent_id: boundAgent });
      applyFor(clusterId, generation, () => {
        if (contextAgentRef.current === boundAgent) setContext(body);
      });
    } catch (cause) {
      applyFor(clusterId, generation, () => setError(messageOf(cause)));
    }
  };

  const loadChildren = async (clusterId: string, parentId: string | null, offset = 0): Promise<void> => {
    const generation = generationRef.current;
    try {
      const page = await flow.nodes(clusterId, { parent_id: parentId, limit: PAGE_SIZE, offset });
      const key = parentId ?? 'root';
      applyFor(clusterId, generation, () => setChildren(current => {
        const existing = current[key];
        return {
          ...current,
          [key]: offset === 0 ? page : { ...page, items: [...(existing?.items ?? []), ...page.items] },
        };
      }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const loadNodeTransactions = async (clusterId: string, nodeId: string, offset = 0): Promise<void> => {
    const generation = generationRef.current;
    try {
      const page = await flow.node(clusterId, { id: nodeId, limit: PAGE_SIZE, offset });
      const incoming = page.transactions;
      applyFor(clusterId, generation, () => setTxPage(current => {
        const existing = current[nodeId];
        const merged = offset === 0 ? incoming : { ...incoming, items: [...(existing?.items ?? []), ...incoming.items] };
        return { ...current, [nodeId]: merged };
      }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const openTransaction = async (clusterId: string, transactionId: string): Promise<void> => {
    const generation = generationRef.current;
    try {
      const body = await flow.transaction(clusterId, { id: transactionId });
      applyFor(clusterId, generation, () => setTxDetail(body));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const control = async (action: FlowControlAction): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await flow.control(selected, action);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      let budget: FlowBudgetInput | undefined;
      if (form.budget.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(form.budget);
        } catch {
          // A syntax error is the operator's input, not a defect in the panel.
          throw new FormRefusal('budget override is not valid JSON');
        }
        budget = validateBudget(parsed);
      }
      const capabilities = validateCapabilities(
        form.capabilities.split(',').map(part => part.trim()).filter(Boolean),
      );
      const request: FlowStartRequest = {
        objective: form.objective,
        workspace: form.workspace,
        capabilities,
        ...(budget ? { budget } : {}),
      };
      const created = await flow.start(request);
      selectCluster(created.cluster.id);
      setForm({ ...form, objective: '' });
      await refresh();
    } catch (cause) {
      if (cause instanceof FormRefusal || rejectionStatus(cause) !== undefined) {
        setError(messageOf(cause));
        return;
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = async (): Promise<void> => {
    if (!selected) return;
    try {
      const data = await flow.report(selected);
      setReport(data);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The file names the cluster it really came from, so a downloaded report
      // can always be matched to its run.
      anchor.download = `cluster-${data.cluster?.id ?? selected}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  // Poll only the currently visible query-backed data. A page already expanded
  // to 100+ entries stays expanded while its durable statuses change.
  refreshVisibleRef.current = async (clusterId: string): Promise<void> => {
    const view = visibleRef.current;
    const generation = generationRef.current;
    try {
      if (view.tab === 'tree') {
        await Promise.all(Object.entries(view.children)
          .filter((entry): entry is [string, FlowClusterNodesQueryData] => entry[1] !== null)
          .map(async ([key, page]) => {
            const latest = await queryLoaded(
              (limit, offset) => flow.nodes(clusterId, { parent_id: key === 'root' ? null : key, limit, offset }),
              page.items.length,
            );
            applyFor(clusterId, generation, () => setChildren(current => {
              const existing = current[key];
              return existing && existing.items.length <= page.items.length
                ? { ...current, [key]: latest } : current;
            }));
          }));
        await Promise.all(Object.entries(view.txPage)
          .filter(([id]) => view.children[id])
          .map(async ([id, page]) => {
            const latest = await queryLoaded(
              async (limit, offset) => (await flow.node(clusterId, { id, limit, offset })).transactions,
              page.items.length,
            );
            applyFor(clusterId, generation, () => setTxPage(current => {
              const existing = current[id];
              return existing && existing.items.length <= page.items.length
                ? { ...current, [id]: latest } : current;
            }));
          }));
      } else if (view.tab === 'transactions') {
        const loaded = view.txList;
        if (!loaded) return;
        const latest = await queryLoaded(
          (limit, offset) => flow.transactions(clusterId, { limit, offset }),
          loaded.items.length,
        );
        applyFor(clusterId, generation, () => setTxList(current => (
          current && current.items.length <= loaded.items.length ? latest : current
        )));
      } else if (view.tab === 'communication') {
        const loaded = view.deliveries;
        if (!loaded) return;
        const latest = await queryLoaded(
          (limit, offset) => flow.deliveries(clusterId, { limit, offset }),
          loaded.items.length,
        );
        applyFor(clusterId, generation, () => setDeliveries(current => (
          current && current.items.length <= loaded.items.length ? latest : current
        )));
      } else if (view.tab === 'resources') {
        const loaded = view.budgets;
        if (!loaded) return;
        const [page, usage] = await Promise.all([
          queryLoaded((limit, offset) => flow.budgets(clusterId, { limit, offset }), loaded.items.length),
          flow.usage(clusterId, { limit: 20 }),
        ]);
        applyFor(clusterId, generation, () => setBudgets(current => (
          current && current.items.length <= loaded.items.length
            ? { ...page, usage: usage.usage, receipts: usage.items } : current
        )));
      } else if (view.tab === 'context') {
        await loadContext(clusterId);
      } else if (view.tab === 'health') {
        await loadHealth(clusterId);
      }
    } catch (cause) {
      applyFor(clusterId, generation, () => setError(messageOf(cause)));
    }
  };

  // A connection reset discards the current generation: every in-flight read
  // belongs to the lost carrier, so clear the derived state and the cursor and
  // pull a fresh one.
  React.useEffect(() => subscribeReset(() => {
    generationRef.current += 1;
    const active = selectedRef.current;
    const position = { cluster_id: active, seq: 0 };
    cursorRef.current = position;
    setCursor(position);
    setEvents([]);
    setChildren({});
    setTxPage({});
    setSnapshot(null);
    setTxList(null);
    setTxDetail(null);
    setDeliveries(null);
    setContext(null);
    contextAgentRef.current = null;
    setContextAgentId(null);
    setContextAgents([]);
    setHealth(null);
    setBudgets(null);
    setReport(null);
    setError(null);
    eventReadRef.current = null;
    if (active) {
      void refresh();
      void readEvents(active);
    }
  }), [subscribeReset, refresh, readEvents]);

  React.useEffect(() => {
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        await refresh();
        const active = selectedRef.current;
        if (active) {
          await readEvents(active);
          if (selectedRef.current === active) await refreshVisibleRef.current(active);
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => clearInterval(timer);
  }, [refresh, readEvents]);

  React.useEffect(() => {
    if (!selected) return;
    if (tab === 'transactions') void loadTransactions(selected);
    if (tab === 'resources') void loadBudgets(selected);
    if (tab === 'communication') void loadDeliveries(selected);
    if (tab === 'health') void loadHealth(selected);
    if (tab === 'context') void loadContext(selected);
    // The loaders are recreated per render; re-running them on that identity
    // change would poll in a loop. Their inputs are `tab` and `selected`.
  }, [tab, selected]);

  // Detail is not a frozen snapshot: validation and the independent audit can
  // arrive after it was opened. Poll only while this transaction is visible,
  // and fence late responses against both the selected cluster and detail id.
  React.useEffect(() => {
    const clusterId = selected;
    const transactionId = txDetail?.transaction.id;
    if (!clusterId || tab !== 'transactions' || !transactionId) return undefined;
    let live = true;
    const timer = setInterval(() => {
      void (async () => {
        const generation = generationRef.current;
        try {
          const body = await flow.transaction(clusterId, { id: transactionId });
          if (live) applyFor(clusterId, generation, () => setTxDetail(current => (
            current?.transaction.id === transactionId ? body : current
          )));
        } catch (cause) {
          if (live) setError(messageOf(cause));
        }
      })();
    }, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [selected, tab, txDetail?.transaction.id, applyFor]);

  const cluster = snapshot?.cluster ?? null;
  const counts = snapshot?.counts ?? null;
  const failure = observedFailure(events);

  function renderTree(clusterId: string): React.JSX.Element {
    const roots = children.root?.items ?? [];
    const nextRoots = children.root?.next_offset ?? null;
    return (
      <section>
        <h3>Management tree</h3>
        {roots.length === 0 ? (
          <div>
            <p className="dsh-flow-muted">Expand the tree to read it one level at a time (a large cluster is never rendered whole).</p>
            <button type="button" className="dsh-flow-load" onClick={() => void loadChildren(clusterId, null)}>Load root</button>
          </div>
        ) : (
          <ul className="dsh-flow-tree">{roots.map(node => renderNode(clusterId, node, 0))}</ul>
        )}
        <div className="dsh-flow-pager">
          <button
            type="button"
            disabled={nextRoots === null}
            onClick={() => { if (nextRoots !== null) void loadChildren(clusterId, null, nextRoots); }}
          >
            Load more roots
          </button>
        </div>
      </section>
    );
  }

  function renderNode(clusterId: string, node: FlowNodeReference, depth: number): React.JSX.Element {
    const level = children[node.id];
    const page = txPage[node.id];
    const nextChildren = level?.next_offset ?? null;
    return (
      <li key={node.id}>
        <button
          type="button"
          className="dsh-flow-node"
          style={{ marginLeft: `${depth * 16}px` }}
          onClick={() => {
            if (!level) void loadChildren(clusterId, node.id);
            else setChildren(current => ({ ...current, [node.id]: null }));
            if (!page) void loadNodeTransactions(clusterId, node.id);
          }}
        >
          {`${level ? '▾' : '▸'} ${node.kind} ${String(node.id).slice(0, 8)} · ${node.status} · ${node.path} · ${page?.total ?? '?'} tx`}
        </button>
        {level ? (
          <ul>
            {level.items.map(child => renderNode(clusterId, child, depth + 1))}
            {level.next_offset !== null ? (
              <li>
                <button
                  type="button"
                  onClick={() => { if (nextChildren !== null) void loadChildren(clusterId, node.id, nextChildren); }}
                >
                  {`Load more children (${level.items.length}/${level.total})`}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {level && level.items.length === 0 ? (
          <ul>
            <li style={{ marginLeft: `${(depth + 1) * 16}px` }}>scope: {JSON.stringify(node.scope).slice(0, 160)}</li>
            {(page?.items ?? []).map(tx => (
              <li key={tx.id} style={{ marginLeft: `${(depth + 1) * 16}px` }}>
                <button type="button" className="dsh-flow-node" onClick={() => void openTransaction(clusterId, tx.id)}>
                  {`${tx.status} rev${tx.revision} pri${tx.priority} · ${String(tx.objective).slice(0, 70)}`}
                </button>
              </li>
            ))}
            {page && page.items.length < page.total ? (
              <li style={{ marginLeft: `${(depth + 1) * 16}px` }}>
                <button type="button" onClick={() => void loadNodeTransactions(clusterId, node.id, page.items.length)}>
                  {`load more (${page.items.length}/${page.total})`}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }

  function renderTransactions(clusterId: string): React.JSX.Element {
    const items: readonly (FlowTransactionReference | FlowTransactionRecord)[] =
      txList?.items ?? snapshot?.transactions ?? [];
    const total = txList?.total ?? items.length;
    const nextOffset = txList?.next_offset ?? null;
    return (
      <section>
        <h3>{`Transactions (${items.length} of ${total})`}</h3>
        {txDetail ? (
          <div className="dsh-flow-detail">
            <h4>{`Transaction ${String(txDetail.transaction.id).slice(0, 8)}`}</h4>
            <ul className="dsh-flow-list">
              <li>{`status ${txDetail.transaction.status} · revision ${txDetail.transaction.revision} · result revision ${txDetail.transaction.result_revision ?? 'none'}`}</li>
              <li>{`priority ${txDetail.transaction.priority} · owner ${String(txDetail.transaction.owner_management_id).slice(0, 8)} · node ${String(txDetail.transaction.node_id).slice(0, 8)}`}</li>
              <li>{`objective: ${String(txDetail.transaction.objective).slice(0, 200)}`}</li>
              <li>{`criteria: ${JSON.stringify('acceptance_criteria' in txDetail.transaction ? txDetail.transaction.acceptance_criteria : null)}`}</li>
              <li>{`validation: ${txDetail.validation ? JSON.stringify(txDetail.validation).slice(0, 400) : 'none recorded'}`}</li>
              <li>{`result: ${txDetail.result ? JSON.stringify(txDetail.result).slice(0, 400) : 'none recorded'}`}</li>
              <li>{`result revision: ${txDetail.result_revision ?? 'none'}`}</li>
              <li>{`allocation: ${txDetail.allocation ? txDetail.allocation.id : 'none active'}`}</li>
              {txDetail.audits.map(audit => (
                <li key={audit.id}>
                  {`audit ${audit.kind} rev${audit.target_revision} ${audit.decision} ${audit.auditor_agent_id ? `by ${String(audit.auditor_agent_id).slice(0, 8)}` : ''}: ${JSON.stringify(audit.evidence).slice(0, 400)}`}
                </li>
              ))}
              {txDetail.issues.map(issue => (
                <li key={issue.id}>
                  {`issue ${issue.severity} ${issue.status} corrections ${issue.corrections}: ${String(issue.required_change).slice(0, 120)}`}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setTxDetail(null)}>Close</button>
          </div>
        ) : null}
        <ul className="dsh-flow-list">
          {items.map(tx => (
            <li key={tx.id}>
              <button type="button" className="dsh-flow-node dsh-flow-tx" onClick={() => void openTransaction(clusterId, tx.id)}>
                {`${tx.status} rev${tx.revision} · ${String(tx.objective).slice(0, 90)}`}
              </button>
            </li>
          ))}
        </ul>
        {txList && nextOffset !== null ? (
          <div className="dsh-flow-pager">
            <button type="button" onClick={() => { if (nextOffset !== null) void loadTransactions(clusterId, nextOffset); }}>
              {`load more (${items.length}/${txList.total})`}
            </button>
          </div>
        ) : null}
        {txList ? (
          <p className="dsh-flow-muted">{`${items.length} of ${txList.total} transactions shown.`}</p>
        ) : null}
      </section>
    );
  }

  function renderDeliveries(clusterId: string): React.JSX.Element {
    if (!deliveries) return <p className="dsh-flow-muted">Loading deliveries…</p>;
    const nextOffset = deliveries.next_offset;
    return (
      <section>
        <h3>{`Message deliveries (${deliveries.items.length} of ${deliveries.total})`}</h3>
        <ul className="dsh-flow-list">
          {deliveries.items.map(row => (
            <li key={`${row.message_id}:${row.recipient}`}>
              {`${row.kind} seq ${row.delivery_seq} · ${row.status} · ${String(row.from_agent ?? 'unknown').slice(0, 8)} → ${String(row.recipient).slice(0, 8)} · acked ${row.acked ?? 'no'}`}
            </li>
          ))}
        </ul>
        {nextOffset !== null ? (
          <div className="dsh-flow-pager">
            <button type="button" onClick={() => { if (nextOffset !== null) void loadDeliveries(clusterId, nextOffset); }}>
              {`load more (${deliveries.items.length}/${deliveries.total})`}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  function renderContext(clusterId: string): React.JSX.Element {
    if (!context) return <p className="dsh-flow-muted">Loading context…</p>;
    return (
      <section>
        <h3>{`Context pressure (agent ${String(context.agent_id).slice(0, 8)})`}</h3>
        <label>
          Agent
          <select
            aria-label="Context agent"
            value={contextAgentId ?? ''}
            onChange={event => {
              const agentId = event.target.value;
              contextAgentRef.current = agentId;
              setContextAgentId(agentId);
              setContext(null);
              void loadContext(clusterId, agentId);
            }}
          >
            {contextAgents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {`${agent.role} ${String(agent.id).slice(0, 8)} · ${String(agent.node_id).slice(0, 8)}`}
              </option>
            ))}
          </select>
        </label>
        {context.steps.length === 0 ? (
          <p className="dsh-flow-muted">No step measurements recorded for this identity.</p>
        ) : (
          <ul className="dsh-flow-list dsh-flow-context-steps">
            {context.steps.map(step => (
              <li key={step.seq}>
                {`#${step.seq} step ${step.step} ${step.decision} · ${step.before} → ${step.after} (limit ${step.context_limit}, threshold ${step.threshold}) · summary ${step.summary_seq ?? 'none'} · scope ${step.charged_scope ? String(step.charged_scope).slice(0, 8) : 'none'}`}
              </li>
            ))}
          </ul>
        )}
        <h4>Latest summary</h4>
        <pre className="dsh-flow-report">{JSON.stringify(context.summary ?? null, null, 2)}</pre>
      </section>
    );
  }

  function renderHealth(): React.JSX.Element {
    if (!health) return <p className="dsh-flow-muted">Loading health…</p>;
    const evaluation = health.health;
    const scores = evaluation ? jsonRecord(evaluation.scores) ?? {} : {};
    return (
      <section>
        <h3>Health (section 18)</h3>
        {evaluation ? (
          <ul className="dsh-flow-list">
            <li>{`decided by ${evaluation.decided_by ? String(evaluation.decided_by).slice(0, 8) : 'not decided'}`}</li>
            {Object.entries(scores).map(([metric, score]) => (
              <li key={metric}>{`${metric}: ${String(score)}`}</li>
            ))}
          </ul>
        ) : (
          <p className="dsh-flow-muted">No evaluation recorded yet.</p>
        )}
        <h4>Measured signals</h4>
        <ul className="dsh-flow-list">
          {health.metrics.map(metric => (
            <li key={metric}>{`${metric}: ${JSON.stringify(health.signals[metric] ?? null)}`}</li>
          ))}
        </ul>
      </section>
    );
  }

  function renderResources(clusterId: string): React.JSX.Element {
    if (!budgets) return <p className="dsh-flow-muted">Loading the ledger…</p>;
    const nextOffset = budgets.next_offset;
    return (
      <section>
        <h3>{`Budgets (${budgets.items.length} of ${budgets.total})`}</h3>
        <ul className="dsh-flow-list">
          {budgets.items.map(budget => (
            <li key={budget.id}>
              {`${budget.scope_kind} ${String(budget.scope_id).slice(0, 8)} · tokens ${budget.tokens.spent}/${budget.tokens.limit} (reserved ${budget.tokens.reserved}) · req ${budget.model_requests.spent}/${budget.model_requests.limit} · tools ${budget.tool_calls.spent}/${budget.tool_calls.limit} · agents ${budget.agents.reserved}/${budget.agents.limit} · active ${budget.max_active_agents.reserved}/${budget.max_active_agents.limit}`}
            </li>
          ))}
        </ul>
        {nextOffset !== null ? (
          <div className="dsh-flow-pager">
            <button type="button" onClick={() => { if (nextOffset !== null) void loadBudgets(clusterId, nextOffset); }}>
              {`load more budgets (${budgets.items.length}/${budgets.total})`}
            </button>
          </div>
        ) : null}
        <h4>Usage</h4>
        <ul className="dsh-flow-list">
          {Object.entries(budgets.usage).map(([key, value]) => (
            <li key={key}>
              {`${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`}
            </li>
          ))}
        </ul>
        <h4>Receipts (unsettled states included)</h4>
        <ul className="dsh-flow-list">
          {budgets.receipts.map(receipt => (
            <li key={receipt.request_id}>
              {`${receipt.kind} ${receipt.status} · ${receipt.total_tokens ?? 'unknown'} tokens · ${String(receipt.request_id).slice(0, 8)}`}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div className="dsh-flow-panel">
      <header className="dsh-flow-head">
        <h2>Hierarchical agent cluster</h2>
        <div className="dsh-flow-actions">
          {cluster ? <span className={`dsh-flow-status dsh-flow-status-${cluster.status}`}>{cluster.status}</span> : null}
          <button type="button" disabled={busy || !selected} onClick={() => void control('pause')}>Pause</button>
          <button type="button" disabled={busy || !selected} onClick={() => void control('resume')}>Resume</button>
          <button type="button" disabled={busy || !selected} onClick={() => void control('cancel')}>Cancel</button>
          <button type="button" disabled={busy || !selected} onClick={() => void downloadReport()}>Download report</button>
        </div>
      </header>

      {error ? <p className="dsh-flow-error" role="alert">{error}</p> : null}

      <section className="dsh-flow-grid">
        <div>
          <h3>Clusters</h3>
          <ul className="dsh-flow-list">
            {clusters.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selected ? 'is-selected' : ''}
                  onClick={() => selectCluster(item.id)}
                >
                  {`${String(item.id).slice(0, 8)} · ${item.status} · ${item.accepted ?? 0}/${item.transactions ?? 0} accepted`}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>Start a cluster</h3>
          <form className="dsh-flow-form" onSubmit={event => { event.preventDefault(); void start(); }}>
            <label>
              Objective
              <textarea
                value={form.objective}
                required
                rows={3}
                onChange={event => setForm({ ...form, objective: event.target.value })}
              />
            </label>
            <label>
              Workspace
              <input
                value={form.workspace}
                required
                placeholder="/absolute/path"
                onChange={event => setForm({ ...form, workspace: event.target.value })}
              />
            </label>
            <label>
              Capabilities
              <input value={form.capabilities} onChange={event => setForm({ ...form, capabilities: event.target.value })} />
            </label>
            <label>
              Budget override (JSON)
              <input
                value={form.budget}
                placeholder={'{"tokens":2097152,"model_requests":256}'}
                onChange={event => setForm({ ...form, budget: event.target.value })}
              />
            </label>
            <button type="submit" disabled={busy}>Start</button>
          </form>
        </div>
      </section>

      {!cluster ? (
        <p className="dsh-flow-muted">No cluster selected. Unknown values are shown as unknown; nothing is inferred.</p>
      ) : (
        <React.Fragment>
          <section className="dsh-flow-summary">
            {stat('Cluster', String(cluster.id).slice(0, 8))}
            {stat('Nodes', counts?.nodes)}
            {stat('Agents (live/total)', `${counts?.agents_live ?? 0}/${counts?.agents ?? 0}`)}
            {stat('Active turns', counts?.active_turns)}
            {stat('Transactions', counts?.transactions)}
            {stat('Ready', counts?.ready)}
            {stat('Accepted', counts?.accepted)}
            {stat('Open issues', counts?.open_issues)}
            {stat('Event cursor', cursor.seq)}
            {stat('Failure class', failure?.failureClass ?? null)}
            {/* No producer writes a mechanism-pass flag, so this stat has always been the fixed 'unknown'. */}
            {stat('Mechanism', null)}
          </section>

          <nav className="dsh-flow-tabs">
            {tabs.map(name => (
              <button
                key={name}
                type="button"
                className={tab === name ? 'is-selected' : ''}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </nav>

          {cluster.status === 'BLOCKED' ? (
            <p className="dsh-flow-blocked" role="status">{`Cluster blocked: ${failure?.reason ?? 'no reason recorded'}`}</p>
          ) : null}

          {failure ? (
            <section className="dsh-flow-failure">
              <h3>Failure detail</h3>
              <ul className="dsh-flow-list">
                <li>{`class: ${failure.failureClass ?? 'unknown'}`}</li>
                <li>{`code: ${failure.code ?? 'unknown'}`}</li>
                <li>{`reason: ${failure.reason ?? 'unknown'}`}</li>
                <li>{`scope: ${failure.scope ?? 'unknown'} · dimension: ${failure.dimension ?? 'unknown'}`}</li>
                <li>{`requested: ${failure.requested ?? 'unknown'} · available: ${failure.available ?? 'unknown'}`}</li>
              </ul>
            </section>
          ) : null}

          {tab === 'tree' ? renderTree(cluster.id) : null}
          {tab === 'transactions' ? renderTransactions(cluster.id) : null}
          {tab === 'communication' ? renderDeliveries(cluster.id) : null}
          {tab === 'context' ? renderContext(cluster.id) : null}
          {tab === 'health' ? renderHealth() : null}
          {tab === 'resources' ? renderResources(cluster.id) : null}

          <section>
            <h3>{`Events (${events.length} shown, cursor #${cursor.seq})`}</h3>
            <ul className="dsh-flow-events">
              {events.slice(-60).map(event => (
                <li key={event.seq}>{`#${event.seq} ${event.type} ${JSON.stringify(event.data).slice(0, 160)}`}</li>
              ))}
            </ul>
          </section>

          {report ? (
            <section>
              <h3>{`Report (${report.cluster?.id ?? 'unknown cluster'})`}</h3>
              <pre className="dsh-flow-report">{JSON.stringify(report, null, 2)}</pre>
            </section>
          ) : null}
        </React.Fragment>
      )}
    </div>
  );
}

function observedFailure(events: readonly FlowEventRecord[]): ObservedFailure | null {
  const blocked = events.findLast(event => event.type === 'cluster-blocked') ?? null;
  const refusal = events.findLast(event => event.type === 'budget-refused' && (!blocked || event.seq <= blocked.seq)) ?? null;
  if (!blocked && !refusal) return null;
  const blockedData = blocked ? jsonRecord(blocked.data) : null;
  const refusalData = refusal ? jsonRecord(refusal.data) : null;
  const code = scalarText(blockedData?.code);
  const failureClass: ObservedFailure['failureClass'] = code !== null && LIMIT_FAILURE_CODES.includes(code)
    ? 'LIMIT_REACHED'
    : code !== null && MECHANISM_FAILURE_CODES.includes(code)
      ? 'MECHANISM' : null;
  // A refusal is a structured limit signal, not proof of a terminal failure.
  // Attribute its envelope to the stop only when that stop is a budget limit.
  const budget = failureClass === 'LIMIT_REACHED' ? refusalData : null;
  return {
    failureClass,
    code,
    reason: scalarText(blockedData?.reason) ?? scalarText(refusalData?.reason),
    scope: scalarText(budget?.scope),
    dimension: scalarText(budget?.dimension),
    requested: scalarText(budget?.requested),
    available: scalarText(budget?.available),
  };
}

function stat(label: string, value: unknown): React.JSX.Element {
  return (
    <div className="dsh-flow-stat" key={label}>
      <span>{label}</span>
      <strong>{value === undefined || value === null ? 'unknown' : String(value)}</strong>
    </div>
  );
}

export const CSS = `
.dsh-flow-panel { padding: 16px 20px 48px; font-size: 13px; line-height: 1.5; overflow: auto; height: 100%; }
.dsh-flow-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.dsh-flow-head h2 { font-size: 15px; margin: 0; font-weight: 600; }
.dsh-flow-actions { display: flex; align-items: center; gap: 8px; }
.dsh-flow-actions button, .dsh-flow-form button, .dsh-flow-tabs button, .dsh-flow-load, .dsh-flow-pager button, .dsh-flow-detail button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsh-border, #4444); background: transparent; color: inherit; cursor: pointer; }
.dsh-flow-actions button:disabled, .dsh-flow-form button:disabled { opacity: .5; cursor: default; }
.dsh-flow-status { font-weight: 600; letter-spacing: .04em; }
.dsh-flow-status-COMPLETED { color: #22c55e; }
.dsh-flow-status-BLOCKED, .dsh-flow-status-FAILED { color: #ef4444; }
.dsh-flow-status-PAUSED { color: #f59e0b; }
.dsh-flow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin: 16px 0; }
.dsh-flow-summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.dsh-flow-stat { border: 1px solid var(--dsh-border, #4444); border-radius: 8px; padding: 6px 10px; display: flex; flex-direction: column; min-width: 120px; }
.dsh-flow-stat span { opacity: .7; font-size: 11px; }
.dsh-flow-tabs { display: flex; gap: 6px; margin: 12px 0; flex-wrap: wrap; }
.dsh-flow-tabs button.is-selected { border-color: currentColor; font-weight: 600; }
.dsh-flow-list, .dsh-flow-tree, .dsh-flow-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-flow-list li, .dsh-flow-tree li, .dsh-flow-events li { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
.dsh-flow-list button, .dsh-flow-node { border: 1px solid var(--dsh-border, #4444); border-radius: 6px; background: transparent; color: inherit; text-align: left; padding: 4px 8px; cursor: pointer; width: 100%; }
.dsh-flow-list button.is-selected { border-color: currentColor; font-weight: 600; }
.dsh-flow-form { display: flex; flex-direction: column; gap: 8px; }
.dsh-flow-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dsh-flow-form input, .dsh-flow-form textarea { background: transparent; border: 1px solid var(--dsh-border, #4444); border-radius: 6px; color: inherit; padding: 4px 8px; font: inherit; }
.dsh-flow-error { color: #ef4444; }
.dsh-flow-blocked { color: #f59e0b; }
.dsh-flow-muted { opacity: .6; }
.dsh-flow-detail { border: 1px solid var(--dsh-border, #4444); border-radius: 8px; padding: 8px; margin: 8px 0; }
.dsh-flow-detail h4 { margin: 0 0 6px; font-size: 13px; }
.dsh-flow-report { max-height: 320px; overflow: auto; font-size: 11px; border: 1px solid var(--dsh-border, #4444); border-radius: 8px; padding: 8px; }
.dsh-flow-pager { margin-top: 6px; }
`;