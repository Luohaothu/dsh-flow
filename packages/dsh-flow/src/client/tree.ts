/** Presentation of recorded native Session relationships; no scheduling state. */
import type { FlowAgentRole, FlowMember, FlowMemberState, FlowTeamSnapshot, FlowTeamState } from '../types.ts';

export interface AgentNode {
  id: string;
  parent_id: string | null;
  name: string;
  role: FlowAgentRole;
  state: FlowMemberState | FlowTeamState;
  member: FlowMember | null;
  task: string;
  created: number;
}
export interface TreeRow { agent: AgentNode; depth: number; children: number; incomplete: boolean }
export const ROLE_LABELS: Record<FlowAgentRole, string> = {orchestrator:'协调者',worker:'执行者'};
export const NODE_WIDTH = 220, NODE_HEIGHT = 124;
export const STATE_LABELS: Record<AgentNode['state'], string> = {
  queued:'等待执行', idle:'空闲', running:'执行中', paused:'已暂停', closed:'已结束',
  completed:'已完成', failed:'失败', cancelled:'已取消',
};
export const ENDED = new Set<AgentNode['state']>(['closed', 'completed', 'failed', 'cancelled']);
/** Role presentation only; workers retain stable individual decoration. */
export function agentEmoji(agent: AgentNode): string {
  if (agent.role === 'orchestrator') return '🧭';
  const choices=['🛠️','🐝','🐻','🐱','🐰','🐨'];
  let seed=2166136261;
  for (const char of agent.id) seed=Math.imul(seed^char.charCodeAt(0),16777619);
  return choices[(seed>>>0)%choices.length]!;
}

/** The main node is the existing owner Session, never an extra member. */
export function agentNodes(team: FlowTeamSnapshot): AgentNode[] {
  const root = team.tasks.find(task => task.id === team.run.root_task_id);
  const nodes: AgentNode[] = [{id:team.run.owner_session_id, parent_id:null, name:'主会话', role:'orchestrator', state:team.run.state,
    member:null, task:root?.title ?? team.run.title, created:team.run.created}];
  const seen = new Set(nodes.map(node => node.id));
  for (const member of team.members) {
    if (seen.has(member.session_id)) continue;
    seen.add(member.session_id);
    nodes.push({id:member.session_id, parent_id:member.parent_id, name:member.name, role:member.role ?? 'worker', state:member.state, member,
      task:team.tasks.find(task => task.id === member.active_task_id)?.title ?? '暂无当前任务', created:member.created});
  }
  return nodes;
}

/** Collapsed descendants stay hidden; missing parents and cycles remain readable. */
export function treeRows(agents: readonly AgentNode[], collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const children = new Map<string | null, AgentNode[]>();
  for (const agent of agents) { const group=children.get(agent.parent_id) ?? []; group.push(agent); children.set(agent.parent_id,group); }
  const roots = agents.filter(agent => agent.parent_id === null || !byId.has(agent.parent_id));
  const result: TreeRow[] = [], visited = new Set<string>();
  const stack = roots.slice().reverse().map(agent => ({agent, depth:0}));
  while (stack.length) {
    const item=stack.pop()!;
    if (visited.has(item.agent.id)) continue;
    visited.add(item.agent.id);
    result.push({...item, children:children.get(item.agent.id)?.length ?? 0,
      incomplete:item.agent.parent_id !== null && !byId.has(item.agent.parent_id)});
    if (!collapsed.has(item.agent.id)) for (const child of (children.get(item.agent.id) ?? []).slice().reverse()) stack.push({agent:child,depth:item.depth+1});
  }
  for (const agent of agents) if (!visited.has(agent.id)) {
    let parent=agent.parent_id; const seen=new Set<string>(); let hidden=false;
    while (parent && !seen.has(parent)) {
      if (visited.has(parent)) {hidden=true;break;}
      seen.add(parent); parent=byId.get(parent)?.parent_id ?? null;
    }
    if (!hidden) result.push({agent,depth:0,children:0,incomplete:true});
  }
  return result;
}

/** Hiding closed members retains the owner and real ancestors of every live member. */
export function visibleRows(rows: readonly TreeRow[], agents: readonly AgentNode[], showEnded: boolean): readonly TreeRow[] {
  if (showEnded) return rows;
  const byId=new Map(agents.map(agent => [agent.id,agent])), included=new Set<string>();
  for (const agent of agents) if (!agent.member || !ENDED.has(agent.state)) {
    let id: string | null=agent.id; const seen=new Set<string>();
    while (id && !seen.has(id)) {seen.add(id);included.add(id);id=byId.get(id)?.parent_id ?? null;}
  }
  return rows.filter(row => included.has(row.agent.id));
}

/** Parents sit above their visible subtrees; unresolved roots do not get fake edges. */
export function topologyLayout(rows: readonly TreeRow[]) {
  const byId=new Map(rows.map(row => [row.agent.id,row])), children=new Map<string,TreeRow[]>(), roots:TreeRow[]=[];
  const parents=new Map<string,string>();
  for (const row of rows) {
    const parent=row.agent.parent_id ? byId.get(row.agent.parent_id) : undefined;
    if (parent && parent.depth < row.depth) {
      const group=children.get(parent.agent.id) ?? [];group.push(row);children.set(parent.agent.id,group);parents.set(row.agent.id,parent.agent.id);
    } else roots.push(row);
  }
  const widths=new Map<string,number>(), positions=new Map<string,{x:number;y:number}>(), gap=44;
  for (const row of [...rows].sort((a,b) => b.depth-a.depth)) {
    const group=children.get(row.agent.id) ?? [];
    widths.set(row.agent.id,Math.max(NODE_WIDTH,group.reduce((sum,child) => sum+(widths.get(child.agent.id) ?? NODE_WIDTH),0)+gap*Math.max(0,group.length-1)));
  }
  const pending:{row:TreeRow;x:number;level:number}[]=[];let width=0;
  for (const row of roots) {pending.push({row,x:width,level:0});width+=(widths.get(row.agent.id) ?? NODE_WIDTH)+gap;}
  while (pending.length) {
    const {row,x,level}=pending.pop()!, subtree=widths.get(row.agent.id) ?? NODE_WIDTH;
    positions.set(row.agent.id,{x:x+(subtree-NODE_WIDTH)/2,y:level*(NODE_HEIGHT+64)});
    const group=children.get(row.agent.id) ?? [];
    const total=group.reduce((sum,child) => sum+(widths.get(child.agent.id) ?? NODE_WIDTH),0)+gap*Math.max(0,group.length-1);
    let next=x+(subtree-total)/2;
    for (const child of group) {pending.push({row:child,x:next,level:level+1});next+=(widths.get(child.agent.id) ?? NODE_WIDTH)+gap;}
  }
  return {positions,parents,width:Math.max(NODE_WIDTH,width-gap),height:Math.max(NODE_HEIGHT,...[...positions.values()].map(pos => pos.y+NODE_HEIGHT))};
}

export interface LocalView {
  selected: string | null; inspector: boolean; collapsed: Set<string>; showEnded: boolean;
  view: 'graph' | 'list'; zoom: number; x: number; y: number; interacted: boolean;
  detailsTab: 'conversation' | 'information'; manualNarrow: boolean;
}
export function createLocalView(): LocalView {
  return {selected:null,inspector:false,collapsed:new Set(),showEnded:true,view:'graph',zoom:1,x:80,y:80,
    interacted:false,detailsTab:'conversation',manualNarrow:false};
}
