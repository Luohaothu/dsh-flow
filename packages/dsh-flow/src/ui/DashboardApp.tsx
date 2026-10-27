import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentCard, MessageView } from '../dashboard/protocol.js';
import { DashboardStore, type Delivery } from './client-store.js';
import { ancestors, defaultRun, formatTime, formatTokens, runStatus, scopedRuns, usageTotals } from './derive.js';
import { AgentDetails } from './AgentDetails.js';
import { AgentTree } from './AgentTree.js';
import { Icon } from './icons.js';
import { createDashboardViewStore, initialRunView } from './view-state.js';
import { DashboardStyles } from './styles.js';
import type { DashboardAppProps, ObservationTarget, RunViewState } from './types.js';

export function DashboardApp({ client, scope, viewStore: providedStore, focus, onFocusConsumed, nativeActions, theme = 'system' }: DashboardAppProps) {
  const store = useMemo(() => providedStore ?? createDashboardViewStore(), [providedStore]);
  const adapter = useMemo(() => new DashboardStore(client), [client]);
  const current = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot), state = current.state;
  const runs = useMemo(() => scopedRuns(state.registry?.runs ?? [], scope), [state.registry, scope.kind, scope.kind === 'session' ? scope.callerSessionId : '']);
  const epoch = state.epoch ?? '', runId = state.selectedRunId ?? '', empty = useRef(initialRunView());
  const getView = useCallback(() => runId ? store.get(epoch, scope, runId) : empty.current, [store, epoch, scope.kind, scope.kind === 'session' ? scope.callerSessionId : '', runId]);
  const view = useSyncExternalStore(store.subscribe, getView, getView);
  const [now, setNow] = useState(Date.now), [localError, setLocalError] = useState<string | null>(null), [observer, setObserver] = useState<ObservationTarget | null>(null), [replays, setReplays] = useState<Delivery[]>([]);
  const [bodyWidth, setBodyWidth] = useState(1000), body = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null), restoreFocus = useRef<HTMLElement | null>(null), observationOpener = useRef<HTMLElement | null>(null);
  const focusConsumed = useRef(new Set<string>()), selecting = useRef<string | null>(null);
  useEffect(() => { void client.connect().catch(() => {}); }, [client]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useLayoutEffect(() => { const element = body.current; if (!element) return; const update = () => setBodyWidth(element.clientWidth); update(); const resize = new ResizeObserver(update); resize.observe(element); return () => resize.disconnect(); }, []);
  const chooseRun = useCallback((id: string) => {
    if (selecting.current === id || client.getState().selectedRunId === id && client.getState().runConnection !== 'error') return;
    selecting.current = id; store.selectRun(epoch, scope, id); setObserver(null); setLocalError(null);
    void client.selectRun(id).catch(error => setLocalError(error instanceof Error ? error.message : String(error))).finally(() => { if (selecting.current === id) selecting.current = null; });
  }, [client, store, epoch, scope.kind, scope.kind === 'session' ? scope.callerSessionId : '']);
  useEffect(() => {
    if (!state.registry || !runs.length) return;
    const requested = focus && !focusConsumed.current.has(focus.requestId) ? runs.find(run => run.id === focus.runId) : undefined;
    if (requested) { chooseRun(requested.id); return; }
    const saved = store.selectedRun(epoch, scope), selected = runs.find(run => run.id === state.selectedRunId), preferred = runs.find(run => run.id === saved);
    if (!selected || saved && selected.id !== saved) { const next = preferred ?? defaultRun(runs); if (next) chooseRun(next.id); }
  }, [runs, state.registry, state.selectedRunId, store, epoch, chooseRun, focus]);
  const snapshot = state.snapshot && runs.some(run => run.id === state.snapshot?.run.id) ? state.snapshot : null, node = snapshot?.nodes.find(item => item.id === view.selectedId) ?? null, group = snapshot?.groups.find(item => item.id === view.groupId) ?? null;
  const updateView = useCallback((update: Partial<RunViewState>) => { if (runId) store.update(epoch, scope, runId, update); }, [store, epoch, scope.kind, scope.kind === 'session' ? scope.callerSessionId : '', runId]);
  const selectNode = (id: string) => {
    if (!snapshot?.nodes.some(item => item.id === id)) { setLocalError(`实例 ${id} 不在当前运行中`); return; }
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const parents = new Set(ancestors(id, snapshot.nodes)); updateView({ selectedId: id, groupId: null, detailOpen: true, collapsed: view.collapsed.filter(candidate => !parents.has(candidate)) }); setObserver(null); setLocalError(null);
  };
  useEffect(() => {
    if (!focus || focusConsumed.current.has(focus.requestId) || !state.registry) return;
    const candidate = runs.find(run => run.id === focus.runId);
    const consume = () => { focusConsumed.current.add(focus.requestId); onFocusConsumed?.(focus.requestId); };
    if (!candidate) { setLocalError('请求定位的运行不属于当前视图或已不可用'); consume(); return; }
    if (!snapshot || snapshot.run.id !== focus.runId) return;
    const member = focus.instanceId ? snapshot.nodes.find(item => item.id === focus.instanceId) : undefined;
    if (focus.instanceId && !member) { setLocalError('请求定位的成员实例不可用'); consume(); return; }
    if (member) {
      const parents = new Set(ancestors(member.id, snapshot.nodes)); store.update(snapshot.run.epoch, scope, snapshot.run.id, { selectedId: member.id, groupId: null, detailOpen: true, collapsed: store.get(snapshot.run.epoch, scope, snapshot.run.id).collapsed.filter(id => !parents.has(id)) });
      if (focus.observe && nativeActions?.renderObserver) setObserver({ runId: snapshot.run.id, instanceId: member.id, sessionId: member.sessionID });
    }
    consume();
  }, [focus, state.registry, runs, snapshot, onFocusConsumed, store, nativeActions, scope.kind, scope.kind === 'session' ? scope.callerSessionId : '']);
  useEffect(() => { setObserver(null); setReplays([]); }, [runId, epoch]);
  const openObserver = (member: AgentCard) => { if (!snapshot || !nativeActions?.renderObserver) return; observationOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setObserver({ runId: snapshot.run.id, instanceId: member.id, sessionId: member.sessionID }); };
  const closeObserver = () => { setObserver(null); requestAnimationFrame(() => { if (observationOpener.current?.isConnected) observationOpener.current.focus(); else root.current?.querySelector<HTMLButtonElement>('.flow-observe-opener')?.focus(); }); };
  const closeDetails = () => { updateView({ detailOpen: false }); requestAnimationFrame(() => { if (restoreFocus.current?.isConnected && !restoreFocus.current.closest('.flow-details')) restoreFocus.current.focus({ preventScroll: true }); else { const treeItem = [...(root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(element => element.getAttribute('aria-selected') === 'true'); treeItem?.focus({ preventScroll: true }); } }); };
  const replayMessage = (message: MessageView) => { const receivedAt = Date.now(); setReplays(previous => [...previous.filter(item => receivedAt - item.receivedAt < 2200), { key: `replay/${message.id}/${crypto.randomUUID()}`, message, receivedAt, replay: true }]); };
  const observedMember = observer && snapshot?.nodes.find(item => item.id === observer.instanceId && item.sessionID === observer.sessionId);
  const showDetails = Boolean(view.detailOpen && (node || group)), showRight = Boolean(observedMember && nativeActions?.renderObserver || showDetails), overlay = showRight && bodyWidth - 360 < 560;
  useLayoutEffect(() => { const canvas = root.current?.querySelector<HTMLElement>('.flow-tree-shell'), panel = root.current?.querySelector<HTMLElement>('.flow-right-pane'); if (canvas) canvas.inert = overlay; if (overlay && panel && !panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('button:not(:disabled),[tabindex="0"],summary')?.focus({ preventScroll: true }); return () => { if (canvas) canvas.inert = false; }; }, [overlay, showRight, node?.id, group?.id, observer?.instanceId]);
  const connected = state.connection === 'connected' && state.runConnection === 'connected' && state.registryConnection === 'connected' && snapshot?.run.status !== 'invalid';
  const totals = snapshot ? usageTotals(snapshot.nodes) : null;
  const currentRun = runs.find(run => run.id === runId), reconnecting = state.connection === 'reconnecting' || state.runConnection === 'reconnecting', invalid = currentRun?.status === 'invalid' || snapshot?.run.status === 'invalid';
  return <div className="flow-dashboard" data-theme={theme} ref={root} data-detail-layout={overlay ? 'overlay' : 'parallel'} onKeyDown={event => { if (event.key === 'Escape' && overlay) { event.stopPropagation(); if (observer) closeObserver(); else closeDetails(); } if (event.key === 'Tab' && overlay) { const controls = [...(root.current?.querySelectorAll<HTMLElement>('.flow-right-pane button:not(:disabled),.flow-right-pane [tabindex="0"],.flow-right-pane summary,.flow-right-pane select,.flow-right-pane a[href]') ?? [])].filter(element => element.getClientRects().length); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}>
    <DashboardStyles />
    <header className="flow-toolbar"><div className="flow-toolbar-title"><Icon name="branch" size={20} /><h1>智能体团队</h1></div><label className="flow-run-picker"><span className="flow-sr">选择团队运行</span><select aria-label="选择团队运行" value={currentRun?.id ?? ''} onChange={event => { store.selectRun(epoch, scope, event.currentTarget.value); chooseRun(event.currentTarget.value); }}>{!currentRun && <option value="" disabled>选择团队运行</option>}{runs.map(run => <option key={run.id} value={run.id}>{run.name} · {runStatus[run.status]} · {run.entry.callerSessionId} · {run.pendingAssignmentCount} 份未结束作业</option>)}</select></label>
      {currentRun && <><span className={`flow-run-state state-${currentRun.status}`}>{runStatus[currentRun.status]}</span><span className="flow-muted">{currentRun.pendingAssignmentCount} 份未结束作业</span>{nativeActions?.returnToSession && <button className="flow-return" type="button" aria-label="返回发起会话" title={`返回发起会话 ${currentRun.entry.callerSessionId}`} onClick={() => nativeActions.returnToSession?.(currentRun.entry.callerSessionId)}><Icon name="return" />{currentRun.entry.callerSessionId}</button>}</>}
    </header>
    <div className="flow-statistics" aria-label="整次运行统计">{snapshot && totals && <><span title="全部 Agent 数，含折叠和已终止实例" aria-label={`全部 Agent ${snapshot.nodes.length}`}><Icon name="branch" />{snapshot.nodes.length}</span><span title="运行中" aria-label={`运行中 ${snapshot.nodes.filter(item => item.status === 'running').length}`}><Icon name="running" className="flow-spin flow-blue" />{snapshot.nodes.filter(item => item.status === 'running').length}</span><span title="等待中" aria-label={`等待中 ${snapshot.nodes.filter(item => item.status === 'waiting').length}`}><Icon name="waiting" className="flow-amber" />{snapshot.nodes.filter(item => item.status === 'waiting').length}</span><span title={`宿主报告的总 token：${totals.total ?? '不可用'}`}><Icon name="usage" />{totals.total === null ? '不可用' : formatTokens(totals.total)} token</span><span className="flow-muted" title="金额按币种分别合计">{totals.amountAvailable ? totals.amounts.map(item => `${item.currency} ${item.amount.toFixed(4)}`).join(' + ') : '金额不可用'}</span></>}<span className="flow-connection" role="status" aria-live="polite">{invalid ? '该运行已随重启失效' : reconnecting ? `连接中断，正在重连${current.runDataTime ? ` · 数据时间 ${formatTime(current.runDataTime)}` : ''}` : state.connection === 'connecting' || state.runConnection === 'connecting' ? '正在加载…' : state.connection === 'error' || state.runConnection === 'error' ? `连接错误：${state.error}` : state.connection === 'connected' ? '已连接' : '正在连接…'}</span></div>
    {(localError || state.error && state.connection === 'error') && <div className="flow-error-banner" role="alert">{localError ?? state.error}<button type="button" aria-label="关闭提示" onClick={() => setLocalError(null)}><Icon name="close" /></button></div>}
    {snapshot?.degraded && <div className="flow-error-banner">持久化暂不可用，当前显示最后可信数据</div>}
    <div className="flow-dashboard-body" ref={body}>
      {snapshot ? <AgentTree key={`${snapshot.run.epoch}/${snapshot.run.id}`} snapshot={snapshot} view={view} now={now} deliveries={[...current.deliveries, ...replays]} joined={current.joined} locateKey={focus?.requestId} onChange={updateView} onSelect={selectNode} onGroup={selected => { restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; updateView({ groupId: selected.id, detailOpen: true }); setObserver(null); }} onMarkers={id => { selectNode(id); updateView({ tab: 'overview' }); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.flow-marker-events')?.scrollIntoView({ block: 'start' })); }} /> : <div className="flow-empty flow-main-empty"><Icon name="branch" size={36} />{!state.registry ? <p>正在加载团队运行…</p> : !runs.length ? <><h2>暂无团队运行</h2><p>在主会话中使用 <code>/agent-team</code> 派发任务，例如：</p><p>“请组建团队分析项目，分别检查架构、测试和文档。”</p></> : <p>正在加载运行快照…</p>}</div>}
      {snapshot && showRight && <aside className={`flow-right-pane ${overlay ? 'is-overlay' : ''}`} role={overlay ? 'dialog' : undefined} aria-modal={overlay ? true : undefined} aria-label={observer ? '成员原生会话观察' : '节点详情'}>{observedMember && observer && nativeActions?.renderObserver ? nativeActions.renderObserver({ target: observer, member: observedMember, members: snapshot.nodes, onSelect: target => { const member = snapshot.nodes.find(item => item.id === target.instanceId && item.sessionID === target.sessionId); if (target.runId !== snapshot.run.id || !member) { setLocalError('观察成员不属于当前运行'); return; } updateView({ selectedId: member.id, groupId: null }); setObserver(target); }, onClose: closeObserver }) : <AgentDetails node={group ? null : node} group={group} snapshot={snapshot} tab={view.tab} connected={connected} onTab={tab => updateView({ tab })} onClose={closeDetails} onSelect={selectNode} onGroup={groupId => updateView({ groupId, detailOpen: true })} onObserve={node && nativeActions?.renderObserver ? () => openObserver(node) : undefined} onReplay={replayMessage} onStop={request => client.stop(snapshot.run.id, request)} />}</aside>}
    </div>
    <footer className="flow-legend"><span><Icon name="running" />运行</span><span><Icon name="waiting" />等待</span><span><Icon name="idle" />空闲</span><span><Icon name="completed" />完成</span><span><Icon name="failed" />失败</span><span><Icon name="stopped" />停止</span><span>空白拖动平移 · 滚轮浏览 · Ctrl/双指缩放</span></footer>
  </div>;
}
