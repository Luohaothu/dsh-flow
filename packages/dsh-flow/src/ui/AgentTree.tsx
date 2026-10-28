import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { AgentCard as Card, GroupView, RunSnapshot } from '../dashboard/protocol.js';
import type { Delivery } from './client-store.js';
import { ancestors, descendants, orderedNodes, statusLabel, treeIndex, visibleTree } from './derive.js';
import { deliveryPath, fitViewport, groupSegments, layoutTree, relationPath, relations, union, type Rect, type TreeGeometry } from './geometry.js';
import { AgentCard } from './AgentCard.js';
import { Icon } from './icons.js';
import type { RunViewState } from './types.js';

export interface AgentTreeProps {
  snapshot: RunSnapshot; view: RunViewState; now: number; deliveries: readonly Delivery[]; joined: ReadonlyMap<string, number>;
  locateKey?: string | undefined;
  onChange(update: Partial<RunViewState>): void;
  onSelect(id: string): void;
  onGroup(group: GroupView): void;
  onMarkers(id: string): void;
}
export function AgentTree({ snapshot, view, now, deliveries, joined, locateKey, onChange, onSelect, onGroup, onMarkers }: AgentTreeProps) {
  const prefix = useId(), viewportRef = useRef<HTMLDivElement>(null), surfaceRef = useRef<HTMLDivElement>(null);
  const order = useRef(new Map<string, number>()), cardRefs = useRef(new Map<string, HTMLDivElement>()), itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [size, setSize] = useState({ width: 800, height: 600 }), [heights, setHeights] = useState(new Map<string, number>()), [focusedId, setFocusedId] = useState<string | null>(null);
  const [actual, setActual] = useState<TreeGeometry | null>(null), [layoutReady, setLayoutReady] = useState(false);
  const [exiting, setExiting] = useState<{ node: Card; rect: Rect; depth: number; parent: Rect | null; firstLevel: boolean; batch: number; delay: number; duration: number }[]>([]);
  const nodes = useMemo(() => orderedNodes(snapshot.nodes, order.current), [snapshot.nodes]);
  const collapsed = useMemo(() => new Set(view.collapsed), [view.collapsed]), visible = useMemo(() => visibleTree(nodes, collapsed), [nodes, collapsed]);
  const tree = useMemo(() => treeIndex(nodes), [nodes]), wide = size.width >= 560 && view.mode === 'tree';
  const layout = useMemo(() => layoutTree(visible, heights, size.width, snapshot.groups, view.mode === 'list'), [visible, heights, size.width, snapshot.groups, view.mode]);
  const previousLayout = useRef({ visible, layout });
  const exitTimers = useRef(new Set<ReturnType<typeof setTimeout>>()), exitBatch = useRef(0);
  useLayoutEffect(() => {
    const previous = previousLayout.current, visibleIds = new Set(visible.map(item => item.node.id));
    const removed = previous.visible.filter(item => !visibleIds.has(item.node.id)).flatMap(item => { const rect = previous.layout.cards.get(item.node.id); return rect ? [{ node: item.node, depth: item.depth, rect, parent: item.parentId ? previous.layout.cards.get(item.parentId) ?? null : null, firstLevel: size.width >= 560 && view.mode === 'tree' && item.depth === 1 }] : []; });
    previousLayout.current = { visible, layout };
    if (!removed.length) {
      if (exiting.some(item => visibleIds.has(item.node.id))) setExiting(current => current.some(item => visibleIds.has(item.node.id)) ? current.filter(item => !visibleIds.has(item.node.id)) : current);
      return;
    }
    const batch = ++exitBatch.current, depth = Math.max(...removed.map(item => item.depth)), removedIds = new Set(removed.map(item => item.node.id));
    const next = removed.map(item => { const delay = Math.max(0, depth - item.depth) * Math.min(20, 240 / (depth + 1)); return { ...item, batch, delay, duration: 280 - delay }; });
    setExiting(current => [...current.filter(item => !visibleIds.has(item.node.id) && !removedIds.has(item.node.id)), ...next]);
    const timer = setTimeout(() => { exitTimers.current.delete(timer); setExiting(current => current.some(item => item.batch === batch) ? current.filter(item => item.batch !== batch) : current); }, 280);
    exitTimers.current.add(timer);
  }, [visible, layout, exiting]);
  useEffect(() => () => { for (const timer of exitTimers.current) clearTimeout(timer); exitTimers.current.clear(); }, []);
  const geometry = actual && actual.cards.size === layout.cards.size && [...layout.cards.keys()].every(id => actual.cards.has(id)) ? actual : layout;
  const edges = useMemo(() => relations(visible, geometry.cards, wide), [visible, geometry, wide]);
  const segments = useMemo(() => groupSegments(snapshot.groups, visible, geometry.cards, nodes, wide), [snapshot.groups, visible, geometry, nodes, wide]);
  const viewport = view.viewport;
  const viewportLatest = useRef(viewport); viewportLatest.current = viewport;
  const onChangeLatest = useRef(onChange); onChangeLatest.current = onChange;
  const nodeDomId = (id: string) => `${prefix}-${encodeURIComponent(id)}`;
  useLayoutEffect(() => {
    const element = viewportRef.current; if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight }); update();
    const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      const measured = [...cardRefs.current].map(([id, element]) => [id, element.offsetHeight] as const);
      setHeights(previous => { const next = new Map(previous); let changed = false; for (const [id, height] of measured) { if (height > 0 && next.get(id) !== height) { next.set(id, height); changed = true; } } return changed ? next : previous; });
    };
    measure(); const observer = new ResizeObserver(measure); for (const element of cardRefs.current.values()) observer.observe(element); return () => observer.disconnect();
  }, [visible]);
  useLayoutEffect(() => { if (layoutReady || size.width !== viewportRef.current?.clientWidth || !visible.every(item => heights.has(item.node.id))) return; const frame = requestAnimationFrame(() => setLayoutReady(true)); return () => cancelAnimationFrame(frame); }, [layoutReady, size.width, visible, heights]);
  useLayoutEffect(() => {
    let frame = 0, stopped = false; const until = performance.now() + 500 + joined.size * 80;
    const measure = () => { const surface = surfaceRef.current; if (!surface || stopped) return; const base = surface.getBoundingClientRect(), scale = viewportLatest.current.scale, cards = new Map<string, Rect>(); for (const [id, element] of cardRefs.current) { const rect = element.getBoundingClientRect(); cards.set(id, { x: (rect.left - base.left) / scale, y: (rect.top - base.top) / scale, width: rect.width / scale, height: rect.height / scale }); } setActual({ cards, width: layout.width, height: layout.height }); if (performance.now() < until) frame = requestAnimationFrame(measure); };
    frame = requestAnimationFrame(measure); return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [layout, joined]);
  const panPointers = useRef(new Map<number, { x: number; y: number }>()), dragged = useRef(false);
  const focusNode = useCallback((id: string) => { setFocusedId(id); itemRefs.current.get(id)?.focus({ preventScroll: true }); }, []);
  const bringIntoView = useCallback((id: string) => { const rect = layout.cards.get(id); if (!rect) return; const current = viewportLatest.current, left = rect.x * current.scale + current.x, top = rect.y * current.scale + current.y, right = left + rect.width * current.scale, bottom = top + rect.height * current.scale; if (left < 24 || right > size.width - 24 || top < 24 || bottom > size.height - 24) onChangeLatest.current({ viewport: { ...current, x: size.width / 2 - (rect.x + rect.width / 2) * current.scale, y: size.height / 2 - (rect.y + rect.height / 2) * current.scale } }); }, [layout, size]);
  const bringLatest = useRef(bringIntoView); bringLatest.current = bringIntoView;
  useEffect(() => { if (view.selectedId) bringLatest.current(view.selectedId); }, [view.selectedId, locateKey]);
  useEffect(() => { if (focusedId && !visible.some(item => item.node.id === focusedId)) { const parent = ancestors(focusedId, nodes).find(id => visible.some(item => item.node.id === id)); if (parent) focusNode(parent); } }, [visible, focusedId, nodes, focusNode]);
  const toggle = (node: Card) => {
    const next = new Set(collapsed); if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
    const hiddenIds = descendants(node.id, nodes).map(item => item.id), hidingSelection = next.has(node.id) && view.selectedId !== null && hiddenIds.includes(view.selectedId);
    onChange({ collapsed: [...next], ...(hidingSelection ? { selectedId: node.id, groupId: null } : {}) });
    if (next.has(node.id) && (hidingSelection || focusedId !== null && hiddenIds.includes(focusedId))) focusNode(node.id);
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>, node: Card) => {
    if (event.target !== event.currentTarget) return;
    const index = visible.findIndex(item => item.node.id === node.id), children = tree.children.get(node.id) ?? [];
    let target: string | undefined;
    if (event.key === 'ArrowDown') target = visible[Math.min(visible.length - 1, index + 1)]?.node.id;
    else if (event.key === 'ArrowUp') target = visible[Math.max(0, index - 1)]?.node.id;
    else if (event.key === 'Home') target = visible[0]?.node.id;
    else if (event.key === 'End') target = visible.at(-1)?.node.id;
    else if (event.key === 'ArrowRight') { if (children.length && collapsed.has(node.id)) toggle(node); else target = children[0]?.id; }
    else if (event.key === 'ArrowLeft') { if (children.length && !collapsed.has(node.id)) toggle(node); else target = node.parentId ?? undefined; }
    else if (event.key === 'Enter') onSelect(node.id);
    else return;
    event.preventDefault(); event.stopPropagation(); if (target) { focusNode(target); bringIntoView(target); }
  };
  const zoom = (factor: number, origin = { x: size.width / 2, y: size.height / 2 }) => { const current = viewportLatest.current, scale = Math.max(.2, Math.min(2, current.scale * factor)), ratio = scale / current.scale; onChange({ viewport: { scale, x: origin.x - (origin.x - current.x) * ratio, y: origin.y - (origin.y - current.y) * ratio } }); };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[role="treeitem"],button,a,input,select')) return;
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId); panPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); dragged.current = false;
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = panPointers.current.get(event.pointerId); if (!previous) return;
    const before = [...panPointers.current.values()], oldDistance = before.length === 2 ? Math.hypot(before[0]!.x - before[1]!.x, before[0]!.y - before[1]!.y) : 0;
    panPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); const after = [...panPointers.current.values()];
    if (after.length === 2 && oldDistance > 0) { const rect = viewportRef.current!.getBoundingClientRect(), distance = Math.hypot(after[0]!.x - after[1]!.x, after[0]!.y - after[1]!.y); zoom(distance / oldDistance, { x: (after[0]!.x + after[1]!.x) / 2 - rect.left, y: (after[0]!.y + after[1]!.y) / 2 - rect.top }); }
    else { const dx = event.clientX - previous.x, dy = event.clientY - previous.y; if (Math.abs(dx) + Math.abs(dy) > 1) dragged.current = true; onChange({ viewport: { ...viewportLatest.current, x: viewportLatest.current.x + dx, y: viewportLatest.current.y + dy } }); }
  };
  useEffect(() => { const element = viewportRef.current; if (!element) return; const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = element.getBoundingClientRect(), current = viewportLatest.current; if (event.ctrlKey || event.metaKey) { const scale = Math.max(.2, Math.min(2, current.scale * Math.exp(-event.deltaY * .002))), x = event.clientX - rect.left, y = event.clientY - rect.top; onChangeLatest.current({ viewport: { scale, x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale } }); } else onChangeLatest.current({ viewport: { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY } }); }; element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel); }, []);
  const selectedGroup = snapshot.groups.find(group => group.id === view.groupId);
  const focusId = focusedId && visible.some(item => item.node.id === focusedId) ? focusedId : view.selectedId && visible.some(item => item.node.id === view.selectedId) ? view.selectedId : visible[0]?.node.id;
  const activeDeliveries = deliveries.filter(delivery => now - delivery.receivedAt < 2200);
  return <div className="flow-tree-shell" data-layout={wide ? 'wide' : 'narrow'}>
    <div ref={viewportRef} className="flow-canvas" aria-label="团队树形画布，空白区域拖动平移，滚轮浏览，按住 Control 滚轮缩放" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => { panPointers.current.delete(event.pointerId); }} onPointerCancel={event => { panPointers.current.delete(event.pointerId); }}>
      <div className="flow-tree-surface" ref={surfaceRef} data-layout-ready={layoutReady} style={{ width: Math.max(layout.width, size.width), height: Math.max(layout.height, size.height), transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})` }}>
        <div className="flow-run-label">{snapshot.run.name} <span>{snapshot.run.id}</span></div>
        <svg className="flow-geometry" width={layout.width} height={layout.height} aria-hidden="true" overflow="visible">
          {segments.map(segment => <g key={segment.key} className={`flow-group ${view.groupId === segment.group.id ? 'is-selected' : ''}`}><rect {...segment.rect} rx="12" /></g>)}
          {edges.map(edge => <g key={edge.id} className={`flow-relation ${edge.from === view.selectedId || edge.to === view.selectedId ? 'is-related' : ''} ${tree.byId.get(edge.to)?.status === 'terminated' ? 'is-terminated' : ''} ${joined.has(edge.to) ? 'is-new' : ''}`}><path d={edge.path} pathLength="1" /><circle cx={geometry.cards.get(edge.from)!.x + (wide && visible.find(item => item.node.id === edge.to)?.depth === 1 ? geometry.cards.get(edge.from)!.width / 2 : 16)} cy={geometry.cards.get(edge.from)!.y + geometry.cards.get(edge.from)!.height} r="2.5" /><circle cx={geometry.cards.get(edge.to)!.x + (edge.firstLevel ? geometry.cards.get(edge.to)!.width / 2 : 0)} cy={geometry.cards.get(edge.to)!.y + (edge.firstLevel ? 0 : 24)} r="2.5" /></g>)}
          {exiting.map(item => item.parent && <path key={`exit/${item.batch}/${item.node.id}`} className="flow-exiting-relation" pathLength="1" d={relationPath(item.parent, item.rect, item.firstLevel)} />)}
          {activeDeliveries.map(delivery => { const source = delivery.message.source; if (source.kind !== 'agent' && source.kind !== 'group') return null; const route = deliveryPath(source.agentId, delivery.message.recipientId, nodes, geometry, edges); if (!route) return null; return <DeliveryGlyph key={delivery.key} path={route.path} direct={route.direct} label={`${source.name} → ${tree.byId.get(delivery.message.recipientId)?.name ?? delivery.message.recipientId}`} />; })}
        </svg>
        {segments.map(segment => <button key={segment.key} type="button" className="flow-group-label" style={{ left: segment.rect.x + 12, top: segment.rect.y - 10 }} aria-label={`群 ${segment.group.id}，${segment.group.members.length} 个成员${segment.hidden ? `，${segment.hidden} 个隐藏成员` : ''}`} onClick={() => onGroup(segment.group)}><Icon name="group" />{segment.group.id} · {segment.group.members.length}{segment.hidden > 0 ? ` · 隐藏 ${segment.hidden}` : ''}</button>)}
        <div role="tree" aria-label={`${snapshot.run.name} 的 Agent 实例`} className="flow-tree">
          {visible.map(item => { const node = item.node, rect = layout.cards.get(node.id)!, children = tree.children.get(node.id) ?? [], siblings = tree.children.get(item.parentId) ?? [node], childIds = collapsed.has(node.id) ? [] : children.filter(child => layout.cards.has(child.id)).map(child => nodeDomId(child.id)), childBounds = union(descendants(node.id, nodes).flatMap(child => { const bounds = layout.cards.get(child.id); return bounds ? [bounds] : []; }));
            return <div key={node.id} id={nodeDomId(node.id)} ref={element => { if (element) itemRefs.current.set(node.id, element); else itemRefs.current.delete(node.id); }} role="treeitem" aria-label={`${node.name}，${statusLabel(node)}`} aria-level={item.depth + 1} aria-posinset={siblings.findIndex(sibling => sibling.id === node.id) + 1} aria-setsize={siblings.length} aria-expanded={children.length ? !collapsed.has(node.id) : undefined} aria-selected={view.selectedId === node.id} tabIndex={focusId === node.id ? 0 : -1} className={`flow-treeitem ${view.selectedId === node.id ? 'is-selected' : ''} ${selectedGroup?.members.includes(node.id) ? 'is-group-member' : ''} ${joined.has(node.id) && now - joined.get(node.id)! < 500 + joined.size * 80 ? 'is-new' : ''}`} style={{ left: rect.x, top: rect.y, width: rect.width, '--flow-join-delay': `${Math.max(0, [...joined.keys()].indexOf(node.id)) * 80}ms` } as CSSProperties} onFocus={() => setFocusedId(node.id)} onKeyDown={event => handleKey(event, node)} onClick={event => { if ((event.target as Element).closest('button,summary,details')) return; dragged.current = false; focusNode(node.id); onSelect(node.id); }}>
              <div ref={element => { if (element) cardRefs.current.set(node.id, element); else cardRefs.current.delete(node.id); }} className="flow-card-surface"><AgentCard node={node} snapshot={snapshot} collapsed={collapsed.has(node.id)} now={now} onToggle={() => toggle(node)} onMarkers={() => onMarkers(node.id)} /></div>
              {childIds.length > 0 && <div role="group" className="flow-tree-group" style={{ left: childBounds.x - rect.x, top: childBounds.y - rect.y, width: childBounds.width, height: childBounds.height }} aria-label={`${node.name} 的子代理`} aria-owns={childIds.join(' ')} />}
            </div>;
          })}
        </div>
        <div className="flow-exiting-layer" aria-hidden="true" ref={element => { if (element) element.inert = true; }}>{exiting.map(item => <div key={`${item.batch}/${item.node.id}`} className="flow-exiting-card" style={{ left: item.rect.x, top: item.rect.y, width: item.rect.width, animationDelay: `${item.delay}ms`, animationDuration: `${item.duration}ms` }}><div className="flow-card-surface"><AgentCard node={item.node} snapshot={snapshot} collapsed={false} now={now} onToggle={() => {}} onMarkers={() => {}} /></div></div>)}</div>
      </div>
      {!nodes.length && <div className="flow-canvas-empty"><Icon name="branch" size={28} />等待团队根实例发布</div>}
    </div>
    <div className="flow-viewport-controls" aria-label="画布视口操作"><button type="button" title="缩小" aria-label="缩小" onClick={() => zoom(1 / 1.2)}><Icon name="minus" /></button><button type="button" title="恢复 100% 比例" aria-label={`当前比例 ${Math.round(viewport.scale * 100)}%，恢复 100%`} onClick={() => zoom(1 / viewport.scale)}>{Math.round(viewport.scale * 100)}%</button><button type="button" title="放大" aria-label="放大" onClick={() => zoom(1.2)}><Icon name="plus" /></button><button type="button" title="适应视口" aria-label="适应视口" onClick={() => onChange({ viewport: fitViewport(union([...layout.cards.values(), ...segments.map(segment => segment.rect)]), size.width, size.height) })}><Icon name="fit" /></button><button type="button" title="展开全部" aria-label="展开全部" onClick={() => onChange({ collapsed: [] })}><Icon name="expand" /></button><button type="button" title={view.mode === 'tree' ? '切换列表' : '切换树形'} aria-label={view.mode === 'tree' ? '切换列表' : '切换树形'} onClick={() => onChange({ mode: view.mode === 'tree' ? 'list' : 'tree' })}><Icon name={view.mode === 'tree' ? 'list' : 'branch'} /></button></div>
  </div>;
}

function DeliveryGlyph({ path, direct, label }: { path: string; direct: boolean; label: string }) {
  const id = useId().replaceAll(':', '');
  return <g className={`flow-delivery ${direct ? 'is-direct' : 'is-temporary'}`} aria-label={label}><title>{label}</title>{!direct && <><defs><mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><path className="flow-delivery-mask" d={path} pathLength="1" stroke="white" strokeWidth="8" fill="none" /></mask><marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 8 4 0 8Z" fill="var(--flow-blue)" /></marker></defs><path className="flow-temporary-path" d={path} mask={`url(#${id}-mask)`} markerEnd={`url(#${id}-arrow)`} /></>}<circle r="3" className="flow-delivery-dot" style={{ offsetPath: `path("${path}")` }} /></g>;
}
