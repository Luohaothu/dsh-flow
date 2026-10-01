/**
 * dsh-flow cluster panel (browser half).
 *
 * A global panel: it belongs to the profile, not to a Session. It reads the
 * authenticated `/api/flow` host route and drives pause/resume/cancel. Nothing
 * here reaches the model: the panel never impersonates a cluster role, and it
 * never invents a number the host did not report — an unmeasured value is shown
 * as unknown.
 */
import * as React from 'react';

const NS = 'dsh-flow';
const PANEL_ID = 'flow-cluster';
// Absolute, so the route resolves the same from any panel route the host
// rewrites.
const FLOW_ROUTE = '/api/flow';
const PAGE_SIZE = 50;
const EVENT_PAGE = 200;

export const inject = ['slots', 'locale', 'layout'];

const h = React.createElement;

async function callFlow(op, id, payload, { signal } = {}) {
  const response = await fetch(FLOW_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, id, payload }),
    ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => ({ error: 'unreadable response' }));
  if (!response.ok) throw new Error(`${body?.error ?? `request failed with ${response.status}`}${body?.code ? ` (${body.code})` : ''}`);
  return body;
}

// Re-read every page the operator has expanded, not just the first page.
// The host caps each query at 500 rows, so a large expanded view uses batches.
async function queryLoaded(clusterId, what, params, loadedCount, field = 'items') {
  const target = Math.max(PAGE_SIZE, loadedCount ?? 0);
  const items = [];
  let total = 0;
  let offset = 0;
  while (items.length < target) {
    const body = await callFlow('query', clusterId, {
      what, params: { ...params, limit: Math.min(500, target - items.length), offset },
    });
    const page = field === 'items' ? body : body[field];
    items.push(...(page?.items ?? []));
    total = page?.total ?? items.length;
    if (page?.next_offset == null || page.next_offset <= offset) break;
    offset = page.next_offset;
  }
  return { items, total, next_offset: items.length < total ? items.length : null };
}

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    return () => style.remove();
  }, 'dsh-flow: panel styles');

  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ClusterPanel);
  });

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 4,
    label: () => 'Cluster',
    locale: NS,
  }, PanelIcon));
}

function PanelIcon() {
  return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
    h('circle', { cx: 12, cy: 5, r: 2.4 }),
    h('circle', { cx: 5, cy: 18, r: 2.4 }),
    h('circle', { cx: 19, cy: 18, r: 2.4 }),
    h('path', { d: 'M12 7.4 5.9 15.6M12 7.4l6.1 8.2M7.4 18h9.2' }));
}

const tabs = ['tree', 'transactions', 'communication', 'context', 'health', 'resources'];

function ClusterPanel() {
  const [clusters, setClusters] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [snapshot, setSnapshot] = React.useState(null);
  const [events, setEvents] = React.useState([]);
  const [cursor, setCursor] = React.useState({ cluster_id: null, seq: 0 });
  const [tab, setTab] = React.useState('tree');
  const [children, setChildren] = React.useState({});
  const [txPage, setTxPage] = React.useState({});
  const [tabs2, setTabs2] = React.useState(null);
  const [txDetail, setTxDetail] = React.useState(null);
  const [deliveries, setDeliveries] = React.useState(null);
  const [context, setContext] = React.useState(null);
  const [contextAgents, setContextAgents] = React.useState([]);
  const [contextAgentId, setContextAgentId] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [budgets, setBudgets] = React.useState(null);
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ objective: '', workspace: '', capabilities: 'fs_read,fs_write', budget: '' });

  const selectedRef = React.useRef(null);
  const cursorRef = React.useRef({ cluster_id: null, seq: 0 });
  const eventReadRef = React.useRef(null);
  const contextAgentRef = React.useRef(null);
  const visibleRef = React.useRef(null);
  const refreshVisibleRef = React.useRef(async () => {});
  visibleRef.current = { tab, children, txPage, tabs2, deliveries, budgets };
  selectedRef.current = selected;

  /** Every write into state is guarded by the cluster it belongs to: an older
   *  in-flight response must never overwrite a newer selection. */
  const applyFor = React.useCallback((clusterId, fn) => {
    if (selectedRef.current !== clusterId) return;
    fn();
  }, []);

  const selectCluster = id => {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    setSelected(id);
    cursorRef.current = { cluster_id: id, seq: 0 };
    setCursor({ cluster_id: id, seq: 0 });
    setEvents([]);
    setChildren({});
    setTxPage({});
    setSnapshot(null);
    setTabs2(null);
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

  const refresh = React.useCallback(async () => {
    try {
      const listed = await callFlow('list', undefined, {});
      const active = selectedRef.current ?? listed.clusters?.[0]?.id ?? null;
      setClusters(listed.clusters ?? []);
      if (!active) {
        setSelected(null);
        setSnapshot(null);
        return;
      }
      if (active !== selectedRef.current) {
        // A different cluster: start its event cursor from scratch rather than
        // carrying the previous cluster's sequence forward.
        selectedRef.current = active;
        cursorRef.current = { cluster_id: active, seq: 0 };
        setCursor({ cluster_id: active, seq: 0 });
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
        setTabs2(null);
        setReport(null);
        setSelected(active);
      }
      const data = await callFlow('read', active, { include_events: false });
      applyFor(active, () => setSnapshot(data));

      setError(null);
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  }, [applyFor]);

  /** Event ids are global database ids: gaps between this cluster's ids do not
   * mean its stream lost events. Continue from the last event we actually saw. */
  const readEvents = React.useCallback(async clusterId => {
    if (eventReadRef.current === clusterId) return;
    eventReadRef.current = clusterId;
    try {
      const position = cursorRef.current;
      const page = await callFlow('events', clusterId, {
        since: position.cluster_id === clusterId ? position.seq : 0, limit: EVENT_PAGE,
      });
      applyFor(clusterId, () => {
        const current = cursorRef.current;
        const fresh = (page.events ?? []).filter(event => event.seq > (current.cluster_id === clusterId ? current.seq : 0));
        if (!fresh.length) return;
        const next = { cluster_id: clusterId, seq: fresh.at(-1).seq };
        cursorRef.current = next;
        setCursor(next);
        setEvents(previous => [...previous, ...fresh].slice(-500));
      });
    } catch (cause) {
      applyFor(clusterId, () => setError(String(cause.message ?? cause)));
    } finally {
      eventReadRef.current = null;
    }
  }, [applyFor]);

  React.useEffect(() => {
    let polling = false;
    const poll = async () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selected]);

  // Detail is not a frozen snapshot: validation and the independent audit can
  // arrive after it was opened. Poll only while this transaction is visible,
  // and fence late responses against both the selected cluster and detail id.
  React.useEffect(() => {
    const transactionId = txDetail?.transaction?.id;
    if (!selected || tab !== 'transactions' || !transactionId) return undefined;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const body = await callFlow('query', selected, { what: 'transaction', params: { id: transactionId } });
        if (live) applyFor(selected, () => setTxDetail(current => (
          current?.transaction?.id === transactionId ? body : current
        )));
      } catch (cause) {
        if (live) setError(String(cause.message ?? cause));
      }
    }, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [selected, tab, txDetail?.transaction?.id, applyFor]);

  /**
   * The transaction list is read from the role-facing query surface, which
   * answers with `{items, total, next_offset}`. `read` returns a snapshot array
   * (a page without a total), which is not enough to tell a complete list from
   * a truncated one.
   */
  const loadTransactions = async (clusterId, offset = 0) => {
    try {
      const page = await callFlow('query', clusterId, { what: 'transactions', params: { limit: PAGE_SIZE, offset } });
      applyFor(clusterId, () => setTabs2(current => (offset === 0 || !current
        ? page
        : { ...page, items: [...(current.items ?? []), ...(page.items ?? [])] })));
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  const loadBudgets = async (clusterId, offset = 0) => {
    try {
      const page = await callFlow('query', clusterId, { what: 'budgets', params: { limit: PAGE_SIZE, offset } });
      const usage = await callFlow('query', clusterId, { what: 'usage', params: { limit: 20 } });
      applyFor(clusterId, () => setBudgets(current => ({
        ...page,
        items: offset === 0 ? page.items : [...(current?.items ?? []), ...page.items],
        usage: usage.usage,
        receipts: usage.items,
      })));
    } catch (cause) {
      applyFor(clusterId, () => setError(String(cause.message ?? cause)));
    }
  };

  const loadDeliveries = async (clusterId, offset = 0) => {
    try {
      const page = await callFlow('query', clusterId, { what: 'deliveries', params: { limit: PAGE_SIZE, offset } });
      applyFor(clusterId, () => setDeliveries(current => (offset === 0
        ? page : { ...page, items: [...(current?.items ?? []), ...page.items] })));
    } catch (cause) {
      applyFor(clusterId, () => setError(String(cause.message ?? cause)));
    }
  };
  const loadHealth = async clusterId => {
    try {
      const body = await callFlow('query', clusterId, { what: 'health', params: {} });
      applyFor(clusterId, () => setHealth(body));
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  const loadContext = async (clusterId, requestedId = contextAgentRef.current) => {
    try {
      let agentId = requestedId;
      if (!agentId) {
        const agents = await callFlow('query', clusterId, { what: 'agents', params: { limit: 500 } });
        agentId = agents.items?.[0]?.id ?? null;
        applyFor(clusterId, () => {
          setContextAgents(agents.items ?? []);
          if (agentId && !contextAgentRef.current) {
            contextAgentRef.current = agentId;
            setContextAgentId(agentId);
          }
        });
      }
      if (!agentId) return;
      const body = await callFlow('query', clusterId, { what: 'context', params: { agent_id: agentId } });
      applyFor(clusterId, () => {
        if (contextAgentRef.current === agentId) setContext(body);
      });
    } catch (cause) {
      applyFor(clusterId, () => setError(String(cause.message ?? cause)));
    }
  };

  const loadChildren = async (clusterId, parentId, offset = 0) => {
    try {
      const page = await callFlow('query', clusterId, { what: 'nodes', params: { parent_id: parentId, limit: PAGE_SIZE, offset } });
      applyFor(clusterId, () => setChildren(current => ({
        ...current,
        [parentId ?? 'root']: offset === 0 ? page : {
          ...page,
          items: [...(current[parentId ?? 'root']?.items ?? []), ...page.items],
        },
      })));
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  const loadNodeTransactions = async (clusterId, nodeId, offset = 0) => {
    try {
      const page = await callFlow('query', clusterId, { what: 'node', params: { id: nodeId, limit: PAGE_SIZE, offset } });
      applyFor(clusterId, () => setTxPage(current => ({
        ...current,
        [nodeId]: { items: offset === 0 ? page.transactions.items : [...(current[nodeId]?.items ?? []), ...page.transactions.items], total: page.transactions.total },
      })));
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  // Poll only the currently visible query-backed data. A page already expanded
  // to 100+ entries stays expanded while its durable statuses change.
  refreshVisibleRef.current = async clusterId => {
    const view = visibleRef.current;
    try {
      if (view.tab === 'tree') {
        await Promise.all(Object.entries(view.children).filter(([, page]) => page).map(async ([key, page]) => {
          const latest = await queryLoaded(clusterId, 'nodes', { parent_id: key === 'root' ? null : key }, page.items.length);
          applyFor(clusterId, () => setChildren(current => (
            current[key] && current[key].items.length <= page.items.length
              ? { ...current, [key]: latest } : current
          )));
        }));
        await Promise.all(Object.entries(view.txPage).filter(([id]) => view.children[id]).map(async ([id, page]) => {
          const latest = await queryLoaded(clusterId, 'node', { id }, page.items.length, 'transactions');
          applyFor(clusterId, () => setTxPage(current => (
            current[id] && current[id].items.length <= page.items.length
              ? { ...current, [id]: latest } : current
          )));
        }));
      } else if (view.tab === 'transactions') {
        if (!view.tabs2) return;
        const latest = await queryLoaded(clusterId, 'transactions', {}, view.tabs2.items.length);
        applyFor(clusterId, () => setTabs2(current => (
          current && current.items.length <= view.tabs2.items.length ? latest : current
        )));
      } else if (view.tab === 'communication') {
        if (!view.deliveries) return;
        const latest = await queryLoaded(clusterId, 'deliveries', {}, view.deliveries.items.length);
        applyFor(clusterId, () => setDeliveries(current => (
          current && current.items.length <= view.deliveries.items.length ? latest : current
        )));
      } else if (view.tab === 'resources') {
        if (!view.budgets) return;
        const [page, usage] = await Promise.all([
          queryLoaded(clusterId, 'budgets', {}, view.budgets.items.length),
          callFlow('query', clusterId, { what: 'usage', params: { limit: 20 } }),
        ]);
        applyFor(clusterId, () => setBudgets(current => (
          current && current.items.length <= view.budgets.items.length
            ? { ...page, usage: usage.usage, receipts: usage.items } : current
        )));
      } else if (view.tab === 'context') {
        await loadContext(clusterId);
      } else if (view.tab === 'health') {
        await loadHealth(clusterId);
      }
    } catch (cause) {
      applyFor(clusterId, () => setError(String(cause.message ?? cause)));
    }
  };

  const openTransaction = async (clusterId, transactionId) => {
    try {
      const body = await callFlow('query', clusterId, { what: 'transaction', params: { id: transactionId } });
      applyFor(clusterId, () => setTxDetail(body));
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  const control = async action => {
    if (!selected) return;
    setBusy(true);
    try {
      await callFlow('control', selected, { action });
      await refresh();
    } catch (cause) {
      setError(String(cause.message ?? cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const payload = {
        objective: form.objective,
        workspace: form.workspace,
        capabilities: form.capabilities.split(',').map(part => part.trim()).filter(Boolean),
        ...(form.budget.trim() ? { budget: JSON.parse(form.budget) } : {}),
      };
      const created = await callFlow('start', undefined, payload);
      selectCluster(created.cluster.id);
      setForm({ ...form, objective: '' });
      await refresh();
    } catch (cause) {
      setError(String(cause.message ?? cause));
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = async () => {
    if (!selected) return;
    try {
      const data = await callFlow('report', selected, {});
      setReport(data);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The file names the cluster it really came from, so a downloaded report
      // can always be matched to its run.
      anchor.download = `cluster-${data?.cluster?.id ?? selected}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };

  const cluster = snapshot?.cluster ?? null;
  const counts = snapshot?.counts ?? {};
  const failure = observedFailure(events);

  return h('div', { className: 'dsh-flow-panel' },
    h('header', { className: 'dsh-flow-head' },
      h('h2', null, 'Hierarchical agent cluster'),
      h('div', { className: 'dsh-flow-actions' },
        cluster ? h('span', { className: `dsh-flow-status dsh-flow-status-${cluster.status}` }, cluster.status) : null,
        h('button', { type: 'button', disabled: busy || !selected, onClick: () => void control('pause') }, 'Pause'),
        h('button', { type: 'button', disabled: busy || !selected, onClick: () => void control('resume') }, 'Resume'),
        h('button', { type: 'button', disabled: busy || !selected, onClick: () => void control('cancel') }, 'Cancel'),
        h('button', { type: 'button', disabled: busy || !selected, onClick: () => void downloadReport() }, 'Download report'))),

    error ? h('p', { className: 'dsh-flow-error', role: 'alert' }, error) : null,

    h('section', { className: 'dsh-flow-grid' },
      h('div', null,
        h('h3', null, 'Clusters'),
        h('ul', { className: 'dsh-flow-list' }, clusters.map(item => h('li', { key: item.id },
          h('button', {
            type: 'button',
            className: item.id === selected ? 'is-selected' : '',
            onClick: () => selectCluster(item.id),
          }, `${String(item.id).slice(0, 8)} · ${item.status} · ${item.accepted ?? 0}/${item.transactions ?? 0} accepted`)))) ),

      h('div', null,
        h('h3', null, 'Start a cluster'),
        h('form', { className: 'dsh-flow-form', onSubmit: event => { event.preventDefault(); void start(); } },
          h('label', null, 'Objective',
            h('textarea', { value: form.objective, required: true, rows: 3, onChange: e => setForm({ ...form, objective: e.target.value }) })),
          h('label', null, 'Workspace',
            h('input', { value: form.workspace, required: true, placeholder: '/absolute/path', onChange: e => setForm({ ...form, workspace: e.target.value }) })),
          h('label', null, 'Capabilities',
            h('input', { value: form.capabilities, onChange: e => setForm({ ...form, capabilities: e.target.value }) })),
          h('label', null, 'Budget override (JSON)',
            h('input', { value: form.budget, placeholder: '{"tokens":2097152,"model_requests":256}', onChange: e => setForm({ ...form, budget: e.target.value }) })),
          h('button', { type: 'submit', disabled: busy }, 'Start')))),

    !cluster ? h('p', { className: 'dsh-flow-muted' }, 'No cluster selected. Unknown values are shown as unknown; nothing is inferred.')
      : h(React.Fragment, null,
        h('section', { className: 'dsh-flow-summary' },
          stat('Cluster', String(cluster.id).slice(0, 8)), stat('Nodes', counts.nodes),
          stat('Agents (live/total)', `${counts.agents_live ?? 0}/${counts.agents ?? 0}`),
          stat('Active turns', counts.active_turns), stat('Transactions', counts.transactions),
          stat('Ready', counts.ready), stat('Accepted', counts.accepted),
          stat('Open issues', counts.open_issues), stat('Event cursor', cursor.seq),
          stat('Failure class', failure?.failureClass ?? null),
          stat('Mechanism', report?.mechanism_pass ?? null)),

        h('nav', { className: 'dsh-flow-tabs' }, tabs.map(name => h('button', {
          key: name, type: 'button', className: tab === name ? 'is-selected' : '', onClick: () => setTab(name),
        }, name))),

        cluster.status === 'BLOCKED'
          ? h('p', { className: 'dsh-flow-blocked', role: 'status' }, `Cluster blocked: ${failure?.reason ?? 'no reason recorded'}`)
          : null,

        failure
          ? h('section', { className: 'dsh-flow-failure' },
            h('h3', null, 'Failure detail'),
            h('ul', { className: 'dsh-flow-list' },
              h('li', null, `class: ${failure.failureClass ?? 'unknown'}`),
              h('li', null, `code: ${failure.code ?? 'unknown'}`),
              h('li', null, `reason: ${failure.reason ?? 'unknown'}`),
              h('li', null, `scope: ${failure.scope ?? 'unknown'} · dimension: ${failure.dimension ?? 'unknown'}`),
              h('li', null, `requested: ${failure.requested ?? 'unknown'} · available: ${failure.available ?? 'unknown'}`)))
          : null,

        tab === 'tree' ? renderTree() : null,
        tab === 'transactions' ? renderTransactions() : null,
        tab === 'communication' ? renderDeliveries() : null,
        tab === 'context' ? renderContext() : null,
        tab === 'health' ? renderHealth() : null,
        tab === 'resources' ? renderResources() : null,

        h('section', null,
          h('h3', null, `Events (${events.length} shown, cursor #${cursor.seq})`),
          h('ul', { className: 'dsh-flow-events' }, events.slice(-60).map(event => h('li', { key: event.seq },
            `#${event.seq} ${event.type} ${JSON.stringify(event.data).slice(0, 160)}`)))),

        report ? h('section', null,
          h('h3', null, `Report (${report?.cluster?.id ?? 'unknown cluster'})`),
          h('pre', { className: 'dsh-flow-report' }, JSON.stringify(report, null, 2))) : null));

  function renderTree() {
    const roots = children.root?.items ?? [];
    return h('section', null,
      h('h3', null, 'Management tree'),
      roots.length === 0
        ? h('div', null,
          h('p', { className: 'dsh-flow-muted' }, 'Expand the tree to read it one level at a time (a large cluster is never rendered whole).'),
          h('button', { type: 'button', className: 'dsh-flow-load', onClick: () => void loadChildren(selected, null) }, 'Load root'))
        : h('ul', { className: 'dsh-flow-tree' }, roots.map(node => renderNode(node, 0))),
      h('div', { className: 'dsh-flow-pager' },
        h('button', { type: 'button', disabled: children.root?.next_offset == null, onClick: () => void loadChildren(selected, null, children.root.next_offset) }, 'Load more roots')));
  }

  function renderNode(node, depth) {
    const level = children[node.id];
    const page = txPage[node.id];
    return h('li', { key: node.id },
      h('button', {
        type: 'button',
        className: 'dsh-flow-node',
        style: { marginLeft: `${depth * 16}px` },
        onClick: () => {
          if (!level) void loadChildren(selected, node.id);
          else setChildren(current => ({ ...current, [node.id]: null }));
          if (!page) void loadNodeTransactions(selected, node.id);
        },
      }, `${level ? '▾' : '▸'} ${node.kind} ${String(node.id).slice(0, 8)} · ${node.status} · ${node.path} · ${page?.total ?? '?'} tx`),
      level ? h('ul', null,
        level.items.map(child => renderNode(child, depth + 1)),
        level.next_offset !== null
          ? h('li', null, h('button', { type: 'button', onClick: () => void loadChildren(selected, node.id, level.next_offset) },
            `Load more children (${level.items.length}/${level.total})`))
          : null) : null,
      level && level.items.length === 0
        ? h('ul', null,
          h('li', { style: { marginLeft: `${(depth + 1) * 16}px` } }, 'scope: ', JSON.stringify(node.scope).slice(0, 160)),
          (page?.items ?? []).map(tx => h('li', { key: tx.id, style: { marginLeft: `${(depth + 1) * 16}px` } },
            h('button', { type: 'button', className: 'dsh-flow-node', onClick: () => void openTransaction(selected, tx.id) },
              `${tx.status} rev${tx.revision} pri${tx.priority} · ${String(tx.objective).slice(0, 70)}`))),
          page && page.items.length < page.total
            ? h('li', { style: { marginLeft: `${(depth + 1) * 16}px` } },
              h('button', { type: 'button', onClick: () => void loadNodeTransactions(selected, node.id, page.items.length) },
                `load more (${page.items.length}/${page.total})`))
            : null)
        : null);
  }

  function renderTransactions() {
    const items = tabs2?.items ?? snapshot?.transactions?.items ?? (Array.isArray(snapshot?.transactions) ? snapshot.transactions : []);
    return h('section', null,
      h('h3', null, `Transactions (${items.length} of ${tabs2?.total ?? snapshot?.transactions?.total ?? items.length})`),
      txDetail
        ? h('div', { className: 'dsh-flow-detail' },
          h('h4', null, `Transaction ${String(txDetail.transaction.id).slice(0, 8)}`),
          h('ul', { className: 'dsh-flow-list' },
            h('li', null, `status ${txDetail.transaction.status} · revision ${txDetail.transaction.revision} · result revision ${txDetail.transaction.result_revision ?? 'none'}`),
            h('li', null, `priority ${txDetail.transaction.priority} · owner ${String(txDetail.transaction.owner_management_id).slice(0, 8)} · node ${String(txDetail.transaction.node_id).slice(0, 8)}`),
            h('li', null, `objective: ${String(txDetail.transaction.objective).slice(0, 200)}`),
            h('li', null, `criteria: ${JSON.stringify(txDetail.transaction.acceptance_criteria)}`),
            h('li', null, `validation: ${txDetail.validation ? JSON.stringify(txDetail.validation).slice(0, 400) : 'none recorded'}`),
            h('li', null, `result: ${txDetail.result ? JSON.stringify(txDetail.result).slice(0, 400) : 'none recorded'}`),
            h('li', null, `result revision: ${txDetail.result_revision ?? 'none'}`),
            h('li', null, `allocation: ${txDetail.allocation ? txDetail.allocation.id : 'none active'}`),
            ...(txDetail.audits ?? []).map(audit => h('li', { key: audit.id },
              `audit ${audit.kind} rev${audit.target_revision} ${audit.decision} ${audit.auditor_agent_id ? `by ${String(audit.auditor_agent_id).slice(0, 8)}` : ''}: ${JSON.stringify(audit.evidence).slice(0, 400)}`)),
            ...(txDetail.issues ?? []).map(issue => h('li', { key: issue.id },
              `issue ${issue.severity} ${issue.status} corrections ${issue.corrections}: ${String(issue.required_change).slice(0, 120)}`))),
          h('button', { type: 'button', onClick: () => setTxDetail(null) }, 'Close'))
        : null,
      h('ul', { className: 'dsh-flow-list' }, items.map(tx => h('li', { key: tx.id },
        h('button', { type: 'button', className: 'dsh-flow-node dsh-flow-tx', onClick: () => void openTransaction(selected, tx.id) },
          `${tx.status} rev${tx.revision} · ${String(tx.objective).slice(0, 90)}`)))),
      tabs2 && tabs2.next_offset !== null
        ? h('div', { className: 'dsh-flow-pager' },
          h('button', { type: 'button', onClick: () => void loadTransactions(selected, tabs2.next_offset) },
            `load more (${items.length}/${tabs2.total})`))
        : null,
      tabs2
        ? h('p', { className: 'dsh-flow-muted' }, `${items.length} of ${tabs2.total} transactions shown.`)
        : null);
  }

  function renderDeliveries() {
    if (!deliveries) return h('p', { className: 'dsh-flow-muted' }, 'Loading deliveries…');
    return h('section', null,
      h('h3', null, `Message deliveries (${deliveries.items.length} of ${deliveries.total})`),
      h('ul', { className: 'dsh-flow-list' }, deliveries.items.map(row => h('li', { key: `${row.message_id}:${row.recipient}` },
        `${row.kind} seq ${row.delivery_seq} · ${row.status} · ${String(row.from_agent ?? 'unknown').slice(0, 8)} → ${String(row.recipient).slice(0, 8)} · acked ${row.acked ?? 'no'}`))),
      deliveries.next_offset !== null
        ? h('div', { className: 'dsh-flow-pager' },
          h('button', { type: 'button', onClick: () => void loadDeliveries(selected, deliveries.next_offset) },
            `load more (${deliveries.items.length}/${deliveries.total})`))
        : null);
  }

  function renderContext() {
    if (!context) return h('p', { className: 'dsh-flow-muted' }, 'Loading context…');
    return h('section', null,
      h('h3', null, `Context pressure (agent ${String(context.agent_id ?? '').slice(0, 8)})`),
      h('label', null, 'Agent',
        h('select', {
          'aria-label': 'Context agent', value: contextAgentId ?? '',
          onChange: event => {
            const agentId = event.target.value;
            contextAgentRef.current = agentId;
            setContextAgentId(agentId);
            setContext(null);
            void loadContext(selected, agentId);
          },
        }, contextAgents.map(agent => h('option', { key: agent.id, value: agent.id },
          `${agent.role} ${String(agent.id).slice(0, 8)} · ${String(agent.node_id).slice(0, 8)}`)))),
      context.steps.length === 0
        ? h('p', { className: 'dsh-flow-muted' }, 'No step measurements recorded for this identity.')
        : h('ul', { className: 'dsh-flow-list dsh-flow-context-steps' }, context.steps.map(step => h('li', { key: step.seq },
          `#${step.seq} step ${step.step} ${step.decision} · ${step.before} → ${step.after} (limit ${step.context_limit}, threshold ${step.threshold}) · summary ${step.summary_seq ?? 'none'} · scope ${step.charged_scope ? String(step.charged_scope).slice(0, 8) : 'none'}`))),
      h('h4', null, 'Latest summary'),
      h('pre', { className: 'dsh-flow-report' }, JSON.stringify(context.summary ?? null, null, 2)));
  }

  function renderHealth() {
    if (!health) return h('p', { className: 'dsh-flow-muted' }, 'Loading health…');
    const scores = health.health?.scores ?? {};
    return h('section', null,
      h('h3', null, 'Health (section 18)'),
      health.health
        ? h('ul', { className: 'dsh-flow-list' },
          h('li', null, `decided by ${health.health.decided_by ? String(health.health.decided_by).slice(0, 8) : 'not decided'}`),
          ...Object.entries(scores).map(([metric, score]) => h('li', { key: metric }, `${metric}: ${score}`)))
        : h('p', { className: 'dsh-flow-muted' }, 'No evaluation recorded yet.'),
      h('h4', null, 'Measured signals'),
      h('ul', { className: 'dsh-flow-list' }, health.metrics.map(metric => h('li', { key: metric },
        `${metric}: ${JSON.stringify(health.signals?.[metric] ?? null)}`))));
  }

  function renderResources() {
    if (!budgets) return h('p', { className: 'dsh-flow-muted' }, 'Loading the ledger…');
    return h('section', null,
      h('h3', null, `Budgets (${budgets.items.length} of ${budgets.total})`),
      h('ul', { className: 'dsh-flow-list' }, budgets.items.map(budget => h('li', { key: budget.id },
        `${budget.scope_kind} ${String(budget.scope_id).slice(0, 8)} · tokens ${budget.tokens.spent}/${budget.tokens.limit} (reserved ${budget.tokens.reserved}) · req ${budget.model_requests.spent}/${budget.model_requests.limit} · tools ${budget.tool_calls.spent}/${budget.tool_calls.limit} · agents ${budget.agents.reserved}/${budget.agents.limit} · active ${budget.max_active_agents.reserved}/${budget.max_active_agents.limit}`))),
      budgets.next_offset !== null
        ? h('div', { className: 'dsh-flow-pager' },
          h('button', { type: 'button', onClick: () => void loadBudgets(selected, budgets.next_offset) },
            `load more budgets (${budgets.items.length}/${budgets.total})`))
        : null,
      h('h4', null, 'Usage'),
      h('ul', { className: 'dsh-flow-list' }, Object.entries(budgets.usage ?? {}).map(([key, value]) => h('li', { key },
        `${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`))),
      h('h4', null, 'Receipts (unsettled states included)'),
      h('ul', { className: 'dsh-flow-list' }, (budgets.receipts ?? []).map(receipt => h('li', { key: receipt.request_id },
        `${receipt.kind} ${receipt.status} · ${receipt.total_tokens ?? 'unknown'} tokens · ${String(receipt.request_id).slice(0, 8)}`))));
  }
}

function observedFailure(events) {
  const blocked = events.findLast(event => event.type === 'cluster-blocked') ?? null;
  const refusal = events.findLast(event => event.type === 'budget-refused' && (!blocked || event.seq <= blocked.seq)) ?? null;
  if (!blocked && !refusal) return null;
  const code = blocked?.data.code ?? null;
  const failureClass = ['BUDGET_EXHAUSTED', 'LIMIT_REACHED', 'DEADLINE_EXCEEDED'].includes(code)
    ? 'LIMIT_REACHED'
    : ['CONTEXT_PRESSURE', 'SESSION_MISSING', 'DELIVERY_UNKNOWN', 'ACCOUNTING_UNCERTAIN', 'EFFECT_UNCERTAIN'].includes(code)
      ? 'MECHANISM' : null;
  // A refusal is a structured limit signal, not proof of a terminal failure.
  // Attribute its envelope to the stop only when that stop is a budget limit.
  const budget = failureClass === 'LIMIT_REACHED' ? refusal?.data : null;
  return {
    failureClass, code,
    reason: blocked?.data.reason ?? refusal?.data.reason ?? null,
    scope: budget?.scope ?? null, dimension: budget?.dimension ?? null,
    requested: budget?.requested ?? null, available: budget?.available ?? null,
  };
}

function stat(label, value) {
  return h('div', { className: 'dsh-flow-stat', key: label }, h('span', null, label),
    h('strong', null, value === undefined || value === null ? 'unknown' : String(value)));
}

const CSS = `
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