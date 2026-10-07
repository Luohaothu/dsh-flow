/** Stable-id tree projection, filtering, metrics and per-run local reading state. */
import type { FlowTeamAgent, FlowTeamMetric, FlowTeamState } from '../types.ts';
export const STATE_LABELS: Record<FlowTeamState, string> = { pending: '待启动', ready: '待命', running: '运行中', waiting_user: '等待用户', waiting_agent: '等待其他智能体', paused: '已暂停', blocked:'受阻', completed: '已完成', cancelled: '已取消', failed: '失败', unknown: '状态未知' };
export const ENDED = new Set<FlowTeamState>(['completed', 'cancelled', 'failed']);
export interface TreeRow { readonly agent: FlowTeamAgent; readonly depth: number; readonly children: number; readonly matched: boolean; readonly incomplete: boolean }
export const NODE_WIDTH=220,NODE_HEIGHT=124;
/** Center every parent above its visible subtree; disconnected roots remain separate. */
export function topologyLayout(rows:readonly TreeRow[]) {
  const ids=new Set(rows.map(row=>row.agent.id)),children=new Map<string,TreeRow[]>();
  const roots:TreeRow[]=[];
  for(const row of rows) {
    const parent=row.agent.parent_id;
    if(parent&&ids.has(parent)&&rows.some(item=>item.agent.id===parent&&item.depth<row.depth)) {
      const group=children.get(parent)??[];group.push(row);children.set(parent,group);
    }else roots.push(row);
  }
  const widths=new Map<string,number>(),positions=new Map<string,{x:number;y:number}>(),gap=44;
  for(const row of [...rows].sort((a,b)=>b.depth-a.depth)) {
    const group=children.get(row.agent.id)??[];
    widths.set(row.agent.id,Math.max(NODE_WIDTH,group.reduce((sum,child)=>sum+(widths.get(child.agent.id)??NODE_WIDTH),0)+gap*Math.max(0,group.length-1)));
  }
  const pending:{row:TreeRow;x:number;level:number}[]=[];let width=0;
  for(const row of roots){pending.push({row,x:width,level:0});width+=(widths.get(row.agent.id)??NODE_WIDTH)+gap;}
  while(pending.length) {
    const {row,x,level}=pending.pop()!;const subtree=widths.get(row.agent.id)??NODE_WIDTH;
    positions.set(row.agent.id,{x:x+(subtree-NODE_WIDTH)/2,y:level*(NODE_HEIGHT+64)});
    const group=children.get(row.agent.id)??[];const total=group.reduce((sum,child)=>sum+(widths.get(child.agent.id)??NODE_WIDTH),0)+gap*Math.max(0,group.length-1);
    let next=x+(subtree-total)/2;
    for(const child of group){pending.push({row:child,x:next,level:level+1});next+=(widths.get(child.agent.id)??NODE_WIDTH)+gap;}
  }
  return {positions,width:Math.max(NODE_WIDTH,width-gap),height:Math.max(NODE_HEIGHT,...[...positions.values()].map(pos=>pos.y+NODE_HEIGHT))};
}
/** Keep the ancestors of every hit; an unresolved parent is never relabeled as the lead. */
export function treeRows(agents: readonly FlowTeamAgent[], search = '', states: ReadonlySet<FlowTeamState> = new Set(), collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const children = new Map<string | null, FlowTeamAgent[]>();
  for (const agent of agents) { const entries = children.get(agent.parent_id) ?? []; entries.push(agent); children.set(agent.parent_id, entries); }
  const matches = new Set(agents.filter(agent => (!search || `${agent.name} ${agent.session_id} ${agent.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (!states.size || states.has(agent.state))).map(agent => agent.id));
  const included = new Set(matches);
  for (const id of matches) {
    let parent = byId.get(id)?.parent_id;
    const visited = new Set([id]);
    while (parent && !visited.has(parent)) { visited.add(parent); included.add(parent); parent = byId.get(parent)?.parent_id; }
  }
  const roots = agents.filter(agent => agent.parent_id === null || !byId.has(agent.parent_id));
  const result: TreeRow[] = [], visited = new Set<string>();
  const stack = roots.slice().reverse().map(agent => ({agent, depth: 0}));
  while (stack.length) {
    const item = stack.pop(); if (!item || visited.has(item.agent.id)) continue;
    visited.add(item.agent.id);
    const { agent, depth } = item;
    if (included.has(agent.id)) result.push({ agent, depth, children: children.get(agent.id)?.length ?? 0, matched: matches.has(agent.id), incomplete: agent.parent_id !== null && !byId.has(agent.parent_id) });
    if (!collapsed.has(agent.id) || search || states.size) for (const child of (children.get(agent.id) ?? []).slice().reverse()) stack.push({ agent: child, depth: depth + 1 });
  }
  // Cyclic provider data remains accessible without inventing a derivation.
  for (const agent of agents) if (!visited.has(agent.id) && included.has(agent.id)) {
    let parent = agent.parent_id; const seen = new Set<string>(); let hidden = false;
    while (parent && !seen.has(parent)) { if (visited.has(parent)) { hidden = true; break; } seen.add(parent); parent = byId.get(parent)?.parent_id ?? null; }
    if (!hidden) result.push({agent, depth: 0, children: 0, matched: matches.has(agent.id), incomplete: true});
  }
  return result;
}
/** Collapse ended-only branches; retain actual ancestors of every live identity. */
export function visibleEndedRows(rows: readonly TreeRow[], agents: readonly FlowTeamAgent[], showEnded: boolean): readonly TreeRow[] {
  if (showEnded) return rows;
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const included = new Set<string>();
  for (const agent of agents) if (!ENDED.has(agent.state)) {
    let id: string | null = agent.id;
    const seen = new Set<string>();
    while (id && !seen.has(id)) { seen.add(id); included.add(id); id = byId.get(id)?.parent_id ?? null; }
  }
  return rows.filter(row => included.has(row.agent.id));
}
export function formatMetric(metric: FlowTeamMetric, mode: 'short' | 'exact' = 'exact'): string {
  if (metric.value === null) return '—';
  const prefix = metric.estimated ? '约 ' : '';
  const number = mode === 'short' && metric.value >= 1000 ? `${(metric.value / 1000).toFixed(1).replace(/\.0$/, '')}k` : metric.value.toLocaleString('zh-CN');
  return `${prefix}${number}${metric.scope === 'descendants' ? '（含子代理）' : ''}`;
}
export function duration(start: number, end: number | null, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export interface LocalView {
  selected: string | null; inspector: boolean; search: string; states: Set<FlowTeamState>; collapsed: Set<string>;
  view: 'graph' | 'list'; communication: string | null; communicationSelection: string | null; communicationPage: number; zoom: number; x: number; y: number;
  interacted: boolean; known: Set<string>; added: string[]; positions: Map<string, { x: number; y: number }>;
  scope: 'related' | 'all' | 'hidden'; showEnded: boolean; detailsTab: 'conversation' | 'information'; page: number; manualNarrow: boolean;
}
export function createLocalView(view: 'graph' | 'list'): LocalView {
  return { selected: null, inspector: false, search: '', states: new Set(), collapsed: new Set(), view,
    communication: null, communicationSelection: null, communicationPage: 1, zoom: 1, x: 80, y: 80, interacted: false, known: new Set(), added: [], positions: new Map(), scope: 'related', showEnded: true, detailsTab: 'conversation', page: 100, manualNarrow: false };
}
