/** Native Agent topology and observation, projected from current collaboration facts. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, MenuSurface, SegmentedTabs, StateDot, Tag, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import type { FlowMember, FlowTask, FlowTeamSnapshot, FlowTeamState, FlowTaskState } from '../types.ts';
import type { TeamObserver } from './observer.ts';
import type { ReaderSource } from './reader-source.ts';
import type { ReaderProps } from './reader.tsx';
import { ProviderPanels } from './surfaces.tsx';
import { agentEmoji, ROLE_LABELS, agentNodes, createLocalView, ENDED, NODE_HEIGHT, NODE_WIDTH, STATE_LABELS, topologyLayout, treeRows, visibleRows } from './tree.ts';
import type { AgentNode, LocalView, TreeRow } from './tree.ts';

export interface TeamUi {
  observer: TeamObserver;
  local: Map<string, LocalView>;
  reader?(sessionId: string): ReaderSource;
  renderReader?: (props: ReaderProps) => ReactNode;
  openMember(member: FlowMember): void;
  sidebar(agent: {session_id: string; name: string}): void;
  main(): void;
  openTeam(): void;
  tab(visible: boolean): void;
}
const TEAM_STATES: Record<FlowTeamState, string> = {running:'进行中',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已取消'};
const TASK_STATES: Record<FlowTaskState, string> = {OPEN:'待完成',SUBMITTED:'待接受',ACCEPTED:'已接受',FAILED:'失败',CANCELLED:'已取消'};
const when = (time: number) => new Date(time).toLocaleString('zh-CN');
const count = (value: number | null) => value === null ? '未提供' : value.toLocaleString('zh-CN');
function person(team: FlowTeamSnapshot, id: string): string {
  return id === team.run.owner_session_id ? '主会话' : team.members.find(member => member.session_id === id)?.name ?? id;
}
function useLocal(ui: TeamUi, runId: string | undefined) {
  const key=runId ?? 'loading';
  let local=ui.local.get(key);
  if (!local) {local=createLocalView();ui.local.set(key,local);}
  const [,render]=useState(0);
  return {local,update:(operation:()=>void)=>{operation();render(value=>value+1);}};
}
function openFull(ui: TeamUi, agent: AgentNode) {agent.member ? ui.openMember(agent.member) : ui.main();}
function openAside(ui: TeamUi, agent: AgentNode) {ui.sidebar({session_id:agent.id,name:agent.name});}
function Status({agent}: {agent: AgentNode}) {
  const dot=agent.state==='failed'?'error':agent.state==='running'?'ongoing':agent.state==='paused'?'warning':ENDED.has(agent.state)?'done':'idle';
  return <span className="flow-status"><StateDot state={dot}/>{agent.member ? STATE_LABELS[agent.state] : TEAM_STATES[agent.state as FlowTeamState]}</span>;
}
function TreeToggle({row,local,change}: {row: TreeRow; local: LocalView; change:()=>void}) {
  return row.children ? <Button size="sm" className="flow-tree-toggle" aria-label={`${local.collapsed.has(row.agent.id)?'展开':'折叠'} ${row.agent.name} 的子代理`} aria-expanded={!local.collapsed.has(row.agent.id)} onClick={()=>{local.collapsed.has(row.agent.id)?local.collapsed.delete(row.agent.id):local.collapsed.add(row.agent.id);change();}}><IconChevronRightOutlineRegular size={14}/></Button> : <span className="flow-tree-leaf" aria-hidden="true"/>;
}
/** Disclosure changes the tree only; conversation and sidebar have separate actions. */
function AgentTree({rows,local,ui,change,select,close}: {rows:readonly TreeRow[];local:LocalView;ui:TeamUi;change:()=>void;select?:(id:string)=>void;close?:()=>void}) {
  const root=useRef<HTMLDivElement>(null),[focus,setFocus]=useState<string|null>(null);
  const move=(id:string)=>{setFocus(id);root.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();};
  const activate=(agent:AgentNode)=>{if(select)select(agent.id);else{openFull(ui,agent);close?.();}};
  return <div ref={root} role="tree" aria-label="智能体派生树" className="flow-tree">
    {rows.map((row,index)=><div key={row.agent.id} role="treeitem" data-tree-id={row.agent.id} aria-level={row.depth+1} aria-expanded={row.children?!local.collapsed.has(row.agent.id):undefined} aria-selected={local.selected===row.agent.id} tabIndex={(focus??rows[0]?.agent.id)===row.agent.id?0:-1} style={{paddingInlineStart:`${row.depth*1.2}em`}} className="flow-tree-row" aria-label={`${row.agent.name}，${STATE_LABELS[row.agent.state]}，${row.incomplete?'关系待补全':`第 ${row.depth+1} 层`}`} onFocus={()=>setFocus(row.agent.id)} onKeyDown={event=>{
      if(event.target!==event.currentTarget)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=rows[index+(event.key==='ArrowDown'?1:-1)];if(next)move(next.agent.id);}
      if(event.key==='ArrowRight'){event.preventDefault();local.collapsed.delete(row.agent.id);change();}
      if(event.key==='ArrowLeft'){event.preventDefault();if(row.children&&!local.collapsed.has(row.agent.id)){local.collapsed.add(row.agent.id);change();}else if(row.agent.parent_id)move(row.agent.parent_id);}
      if(event.key==='Home'||event.key==='End'){event.preventDefault();const next=event.key==='Home'?rows[0]:rows.at(-1);if(next)move(next.agent.id);}
      if(event.key==='Enter'||event.key===' '){event.preventDefault();activate(row.agent);}
    }}>
      <TreeToggle row={row} local={local} change={change}/>
      <Button size="sm" className="flow-tree-open" aria-label={`${select?'查看':'打开'} ${row.agent.name} ${select?'详情':'对话'}`} onClick={()=>activate(row.agent)}><span className="flow-tree-copy"><span className="flow-tree-name">{row.agent.name}<span className="flow-tree-role" title={ROLE_LABELS[row.agent.role]}>{ROLE_LABELS[row.agent.role]}</span></span><Status agent={row.agent}/><span className="flow-tree-task">{row.agent.task}</span>{row.incomplete&&<small>关系待补全</small>}</span></Button>
      <Tooltip label="在侧边栏打开" side="bottom" align="end"><Button size="sm" className="flow-tree-aside" aria-label={`在侧边栏打开 ${row.agent.name}`} onClick={()=>{openAside(ui,row.agent);close?.();}}><IconChevronRightOutlineRegular size={14}/></Button></Tooltip>
    </div>)}
  </div>;
}
export function TeamHeader({ui}: {ui: TeamUi}) {
  const data=useSyncExternalStore(ui.observer.subscribe,ui.observer.getSnapshot);
  const {local,update}=useLocal(ui,data.team?.run.id);
  const [open,setOpen]=useState(false),[fixed,setFixed]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null);
  const openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const position=useAnchoredPosition({open,anchorRef:trigger,panelRef:popup,margin:16,side:'bottom',align:'start',gap:8});
  const close=()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);setOpen(false);setFixed(false);};
  useDismissOnOutsidePointer(trigger,open,close,popup);
  useEffect(()=>{ui.tab(data.runs.length>0);},[data.runs.length,ui]);
  useEffect(()=>()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);},[]);
  useEffect(()=>{if(!open)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();close();trigger.current?.focus();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[open]);
  const enter=()=>{clearTimeout(closeTimer.current);clearTimeout(openTimer.current);if(!open)openTimer.current=setTimeout(()=>setOpen(true),200);};
  const leave=()=>{clearTimeout(openTimer.current);if(!fixed)closeTimer.current=setTimeout(()=>setOpen(false),250);};
  if(!data.runs.length)return null;
  const team=data.team,nodes=team?agentNodes(team):[];
  const rows=visibleRows(treeRows(nodes,local.collapsed),nodes,local.showEnded);
  return <span className="flow-header" onPointerEnter={enter} onPointerLeave={leave}>
    <Button ref={trigger} size="sm" className="flow-team-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);if(open&&fixed)close();else{setOpen(true);setFixed(true);requestAnimationFrame(()=>popup.current?.querySelector<HTMLElement>('[role=treeitem]')?.focus());}}}>智能体团队 {nodes.length}<span className="flow-trigger-state">· {team?TEAM_STATES[team.run.state]:'加载中'}</span><IconChevronDownOutlineRegular className="flow-trigger-chevron" size={14}/></Button>
    {open&&<MenuSurface ref={popup} style={position??undefined} className="flow-team-popup" role="dialog" aria-label="智能体团队" onPointerEnter={enter} onPointerLeave={leave}>
      {data.loading&&<p role="status">正在加载团队…</p>}{data.error&&<p role="status">{team?'连接中断，显示上次数据。':'暂时无法读取团队。'}<Button onClick={()=>void ui.observer.refresh()}>重试连接</Button></p>}
      {team&&<><label className="flow-ended"><input type="checkbox" checked={local.showEnded} onChange={event=>update(()=>local.showEnded=event.currentTarget.checked)}/>显示已结束成员</label><AgentTree rows={rows} local={local} ui={ui} close={close} change={()=>update(()=>{})}/>{!team.members.length&&<p className="flow-muted">尚未派生子代理</p>}</>}
      <div className="flow-team-footer"><Button size="sm" onClick={()=>{ui.openTeam();close();}}>查看智能体</Button></div>
    </MenuSurface>}
  </span>;
}
function TaskDetails({team, task}: {team: FlowTeamSnapshot; task: FlowTask}) {
  const results = team.results.filter(result => result.task_id === task.id).sort((a,b) => b.created - a.created);
  return <section className="flow-task-details" aria-label="任务详情">
    <div className="flow-row"><h3>{task.title}</h3><Tag>{task.paused ? '暂停调度' : TASK_STATES[task.status]}</Tag></div>
    <p className="flow-prose">{task.objective}</p>
    <dl className="flow-facts"><div><dt>负责</dt><dd>{person(team, task.owner_session_id)}</dd></div><div><dt>执行</dt><dd>{person(team, task.assignee_session_id)}</dd></div><div><dt>版本</dt><dd>{task.version}</dd></div></dl>
    {task.parent_id && <p>上级任务 · {team.tasks.find(parent => parent.id === task.parent_id)?.title ?? task.parent_id}</p>}
    <h4>结果与接受记录</h4>
    {!results.length && <p className="flow-muted">尚未提交结果。</p>}
    {results.map(result => <article className="flow-result" key={result.id} data-result-id={result.id}>
      <div className="flow-row"><strong>{result.id === task.result_id ? '当前结果' : '历史结果'}</strong><Tag>{result.outcome === 'complete' ? '完成' : result.outcome === 'partial' ? '部分完成' : '受阻'}</Tag><span>任务版本 {result.task_version}</span></div>
      <p className="flow-prose">{result.summary}</p>
      <p className="flow-muted">{person(team, result.author_session_id)} · {when(result.created)}{!result.ready ? ' · 尚未就绪' : ''}</p>
      {result.artifacts.length > 0 && <ul aria-label="产物">{result.artifacts.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
      {team.reviews.filter(review => review.result_id === result.id).map(review => <div className="flow-review" key={review.id} data-review-id={review.id}>
        <div className="flow-row"><Tag>{review.accepted ? '接受' : '需修改'}</Tag><span>{person(team, review.reviewer_session_id)} · {when(review.created)}</span></div>
        <p className="flow-prose">{review.notes}</p>
        {review.evidence.length > 0 && <ul aria-label="接受依据">{review.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
      </div>)}
    </article>)}
  </section>;
}
function Information({agent,team,select}: {agent:AgentNode;team:FlowTeamSnapshot;select:(id:string)=>void}) {
  const [copied,setCopied]=useState(''),[taskId,setTaskId]=useState<string|null>(null);
  useEffect(()=>{setCopied('');setTaskId(null);},[agent.id]);
  const nodes=agentNodes(team),parent=nodes.find(node=>node.id===agent.parent_id),children=nodes.filter(node=>node.parent_id===agent.id);
  const tasks=team.tasks.filter(task=>task.assignee_session_id===agent.id);
  const task=tasks.find(task=>task.id===taskId)??tasks.find(task=>task.id===agent.member?.active_task_id)??tasks.at(-1);
  const messages=team.messages.filter(message=>message.from_session_id===agent.id||message.to_session_id===agent.id);
  return <section className="flow-information flow-scroll" aria-label={`${agent.name} 信息`}>
    <h3>{agent.name}</h3><Status agent={agent}/>{agent.member?.error&&<p className="flow-error">{agent.member.error}</p>}
    <p className="flow-id">{agent.id}</p><Button size="sm" onClick={()=>void writeClipboard(agent.id).then(ok=>setCopied(ok?'ID 已复制':'未能复制 ID'))}>复制 ID</Button>{copied&&<span role="status">{copied}</span>}
    <h4>关系</h4><p>父会话：{parent?<Button size="sm" onClick={()=>select(parent.id)}>{parent.name}</Button>:agent.parent_id?'关系待补全':'无（主会话）'}</p>{children.map(child=><Button size="sm" key={child.id} onClick={()=>select(child.id)}>{child.name}</Button>)}
    <p>创建：{when(agent.created)}</p>
    <h4>角色与配置</h4><p>角色：{ROLE_LABELS[agent.role]}</p>
    <p className="flow-prose">{agent.member?.instructions??(agent.member?'执行受派任务，交付结果；按需要协调子任务。':'负责分工、验收、汇总和最终交付。')}</p>
    <details className="flow-profile"><summary>Agent 配置</summary>
      <p>执行基础：标准 DSH Agent</p>
      <p>创建 preset：{agent.member?(agent.member.preset??'继承原生配置'):'沿用主会话配置'}</p>
      <p>角色 skills：{agent.member?(agent.member.skills?.join('、')||'未额外指定'):'沿用主会话技能'}</p>
      <p>创建模型配置：{agent.member?JSON.stringify(agent.member.model??team.run.model??'跟随宿主'):'沿用主会话配置'}</p>
      <p className="flow-muted">这里记录创建配置；实际模型、工具及后续设置以原生会话为准。</p>
    </details>
    {agent.state==='closed'&&<p>运行资源已释放，历史记录仍可查看。</p>}
    {!agent.member&&<><h4>团队目标</h4><p className="flow-prose">{team.run.objective}</p><p>工作目录：{team.run.workspace}</p>{team.run.deadline&&<p>截止：{when(team.run.deadline)}</p>}<p>成员模型响应 {count(team.usage.responses)} 次 · 成员 Token {count(team.usage.total_tokens)}</p></>}
    <h4>任务与结果</h4><nav className="flow-task-list" aria-label="任务列表">{tasks.map(item=><Button size="sm" key={item.id} aria-pressed={task?.id===item.id} onClick={()=>setTaskId(item.id)}>{item.title} · {TASK_STATES[item.status]}</Button>)}</nav>
    {task?<TaskDetails team={team} task={task}/>:<p>暂无分配任务。</p>}
    <h4>消息</h4>{!messages.length&&<p className="flow-muted">暂无成员消息。</p>}{messages.map(message=><article className="flow-message" key={message.id}><strong>{person(team,message.from_session_id)} → {person(team,message.to_session_id)}</strong><p className="flow-prose">{message.content}</p><small>{message.mode==='request'?'请求':'通知'} · {message.state==='delivered'?'已送达':message.state==='queued'?'待送达':'已取消'} · {when(message.created)}</small></article>)}
    {!agent.member&&<details className="flow-events"><summary>运行事件 · {team.events.length}</summary>{team.events.map(event=><details key={event.seq}><summary>{event.type} · {when(event.at)}</summary><pre>{JSON.stringify(event.data,null,2)}</pre></details>)}</details>}
  </section>;
}
function Graph({rows,local,select,change}: {rows:readonly TreeRow[];local:LocalView;select:(id:string)=>void;change:()=>void}) {
  const surface=useRef<HTMLDivElement>(null),wheelChange=useRef(change);wheelChange.current=change;
  useEffect(()=>{
    const element=surface.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();const rect=element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
      const factor=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;
      const zoom=Math.max(.25,Math.min(2.5,local.zoom*Math.exp(-event.deltaY*factor*.002))),ratio=zoom/local.zoom;
      local.x=x-(x-local.x)*ratio;local.y=y-(y-local.y)*ratio;local.zoom=zoom;local.interacted=true;wheelChange.current();
    };
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[local]);
  const drag=useRef<{x:number;y:number;ox:number;oy:number}|null>(null);
  const signature=rows.map(row=>`${row.agent.id}:${row.agent.parent_id}:${row.depth}`).join('|');
  const {positions,parents,width,height}=useMemo(()=>topologyLayout(rows),[signature]);
  const fit=(manual=true)=>{const box=surface.current;if(!box)return;
    local.zoom=Math.max(.25,Math.min(1,(box.clientWidth-48)/width,(box.clientHeight-148)/height));
    local.x=(box.clientWidth-width*local.zoom)/2;local.y=68+Math.max(12,(box.clientHeight-132-height*local.zoom)/2);local.interacted=manual;change();};
  const autoFit=useRef(()=>{});autoFit.current=()=>{if(!local.interacted)fit(false);};
  useLayoutEffect(()=>{const box=surface.current;if(!box)return;autoFit.current();const observer=new ResizeObserver(()=>autoFit.current());observer.observe(box);return()=>observer.disconnect();},[signature]);
  return <section className="flow-graph-area" aria-label="团队拓扑">
    <div className="flow-actions flow-zoom"><Button size="sm" onClick={()=>{local.zoom=Math.min(2.5,local.zoom+.1);local.interacted=true;change();}}>放大</Button><span aria-label="缩放比例">{Math.round(local.zoom*100)}%</span><Button size="sm" onClick={()=>{local.zoom=Math.max(.25,local.zoom-.1);local.interacted=true;change();}}>缩小</Button><Button size="sm" onClick={()=>fit()}>适应视口</Button><Button size="sm" onClick={()=>{const root=rows.find(row=>!row.agent.member);if(root){const position=positions.get(root.agent.id);local.x=(surface.current?.clientWidth??0)/2-((position?.x??0)+NODE_WIDTH/2)*local.zoom;local.y=80;local.interacted=true;select(root.agent.id);}}}>定位主会话</Button></div>
    <div ref={surface} className="flow-graph" tabIndex={0} aria-label="拓扑画布，拖动空白处平移，使用工具栏缩放" onPointerDown={event=>{if((event.target as Element).closest('button'))return;event.currentTarget.focus();drag.current={x:event.clientX,y:event.clientY,ox:local.x,oy:local.y};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!drag.current)return;local.x=drag.current.ox+event.clientX-drag.current.x;local.y=drag.current.oy+event.clientY-drag.current.y;local.interacted=true;change();}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null} onLostPointerCapture={()=>drag.current=null}>
      <div className="flow-graph-world" style={{width,height,transform:`translate(${local.x}px,${local.y}px) scale(${local.zoom})`}}>
        <svg width={width} height={height} className="flow-lines" aria-label="智能体派生关系">{rows.map(row=>{const parentId=parents.get(row.agent.id),parent=parentId?positions.get(parentId):undefined,here=positions.get(row.agent.id)!;return parent?<path key={row.agent.id} d={`M${parent.x+NODE_WIDTH/2} ${parent.y+NODE_HEIGHT} V${(parent.y+NODE_HEIGHT+here.y)/2} H${here.x+NODE_WIDTH/2} V${here.y}`} fill="none" stroke="currentColor"/>:null;})}</svg>
        {rows.map(row=>{const position=positions.get(row.agent.id)!;return <div key={row.agent.id} className="flow-node-group" style={{left:position.x,top:position.y}}>
          <button type="button" className="flow-node" data-agent-id={row.agent.id} data-kind={row.agent.member?'member':'main'} data-role={row.agent.role} aria-pressed={local.selected===row.agent.id} aria-label={`${row.agent.name}，${ROLE_LABELS[row.agent.role]}，${STATE_LABELS[row.agent.state]}`} title={`${row.agent.name}\n${ROLE_LABELS[row.agent.role]}\n${row.agent.task}`} onClick={()=>select(row.agent.id)}><span className="flow-node-meta"><span className="flow-node-role" title={ROLE_LABELS[row.agent.role]}>{ROLE_LABELS[row.agent.role]}</span><Status agent={row.agent}/></span><span className="flow-node-person"><span className="flow-avatar" aria-hidden="true">{agentEmoji(row.agent)}</span><strong>{row.agent.name}</strong></span><small className="flow-node-task">{row.agent.task}</small><small>{row.incomplete?'关系待补全':`创建 ${when(row.agent.created)}`}</small></button>
          {row.children>0&&<div className="flow-node-toggle"><TreeToggle row={row} local={local} change={change}/></div>}
        </div>;})}
      </div>
    </div>
  </section>;
}
export function TeamView({ui}: {ui:TeamUi}) {
  const data=useSyncExternalStore(ui.observer.subscribe,ui.observer.getSnapshot),team=data.team;
  const {local,update}=useLocal(ui,team?.run.id);
  const container=useRef<HTMLDivElement>(null),controls=useRef<HTMLElement>(null),[width,setWidth]=useState(0),[controlsHeight,setControlsHeight]=useState(100);
  useLayoutEffect(()=>{const element=container.current;if(!element)return;const measure=()=>setWidth(element.clientWidth);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  const narrow=width>0&&width<600,wide=width>=1080;
  const nodes=team?agentNodes(team):[],selected=nodes.find(node=>node.id===local.selected)??null;
  const showInspector=local.inspector&&selected!==null;
  useLayoutEffect(()=>{const element=controls.current;if(!element)return;const measure=()=>setControlsHeight(element.getBoundingClientRect().height);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[narrow&&showInspector]);
  const reader=useMemo(()=>showInspector&&selected&&ui.reader?ui.reader(selected.id):null,[showInspector,selected?.id,team?.run.id]);
  useEffect(()=>()=>reader?.dispose(),[reader]);
  const select=(id:string)=>update(()=>{
    local.selected=id;local.inspector=true;
    let parent=nodes.find(node=>node.id===id)?.parent_id;const seen=new Set<string>();
    while(parent&&!seen.has(parent)){seen.add(parent);local.collapsed.delete(parent);parent=nodes.find(node=>node.id===parent)?.parent_id??null;}
    if(ENDED.has(nodes.find(node=>node.id===id)?.state??'idle'))local.showEnded=true;
  });
  const rows=visibleRows(treeRows(nodes,local.collapsed),nodes,local.showEnded);
  const view=narrow&&!local.manualNarrow?'list':local.view;
  const conversation=selected&&reader&&ui.renderReader?<div className="flow-conversation-detail">{ui.renderReader({source:reader,agentId:selected.id,variant:'embedded',follow:true})}</div>:<p className="flow-muted">通过完整会话查看原生对话与轨迹。</p>;
  const information=selected&&team?<Information key={`${team.run.id}:${selected.id}`} agent={selected} team={team} select={select}/>:null;
  const close=()=>update(()=>local.inspector=false);
  const detailsHeading=selected?<div className="flow-detail-heading"><strong>{selected.name}</strong><Status agent={selected}/><Button size="sm" onClick={()=>openFull(ui,selected)}>打开完整会话</Button><Button size="sm" onClick={()=>openAside(ui,selected)}>侧栏查看</Button><Button size="sm" onClick={close}>{narrow?'返回团队':'关闭详情'}</Button></div>:null;
  return <main ref={container} className="flow-content" style={{'--flow-controls-height':`${controlsHeight}px`} as CSSProperties} aria-label="团队协作" data-full-details={narrow&&showInspector}>
    {!(narrow&&showInspector)&&<header ref={controls} className="flow-controls"><div className="flow-toolbar"><div className="flow-team-heading"><h1>{team?.run.title??'智能体团队'}</h1>{team&&<Tag>{TEAM_STATES[team.run.state]}</Tag>}</div><div className="flow-actions"><Button size="sm" aria-pressed={view==='graph'} onClick={()=>update(()=>{local.manualNarrow=true;local.view='graph';})}>拓扑图</Button><Button size="sm" aria-pressed={view==='list'} onClick={()=>update(()=>{local.manualNarrow=true;local.view='list';})}>列表</Button><label className="flow-ended"><input type="checkbox" checked={local.showEnded} onChange={event=>update(()=>local.showEnded=event.currentTarget.checked)}/>显示已结束成员</label><Button size="sm" onClick={()=>void ui.observer.refresh()}>刷新</Button>{data.runs.length>1&&<label className="flow-run-select">团队记录 <select value={team?.run.id??''} onChange={event=>ui.observer.select(event.currentTarget.value)}>{data.runs.map(run=><option key={run.id} value={run.id}>{run.title} · {TEAM_STATES[run.state]}</option>)}</select></label>}</div></div></header>}
    {data.error&&<div className="flow-notices flow-error" role="alert">读取失败：{data.error}。{team?'保留上次成功读取的内容。':''}<Button size="sm" onClick={()=>void ui.observer.refresh()}>重试连接</Button></div>}
    {data.loading&&<p className="flow-empty" role="status">正在加载团队…</p>}
    {!data.loading&&!team&&!data.error&&<p className="flow-empty">在主会话输入 /agent-team 和任务描述，按需委派成员一起完成工作。</p>}
    {team&&<>{narrow&&showInspector?<>{detailsHeading}<SegmentedTabs label="代理详情" value={local.detailsTab} onChange={value=>update(()=>local.detailsTab=value)} items={[{value:'conversation',label:'对话',id:'flow-conversation-tab',panelId:'flow-detail-panel'},{value:'information',label:'信息',id:'flow-information-tab',panelId:'flow-detail-panel'}]}/><div role="tabpanel" id="flow-detail-panel" aria-labelledby={`flow-${local.detailsTab}-tab`} className="flow-mobile-detail">{local.detailsTab==='conversation'?conversation:information}</div></>:<>
      <div className="flow-structure">{!team.members.length&&<p className="flow-no-children">尚未派生子代理</p>}{view==='graph'?<Graph rows={rows} local={local} select={select} change={()=>update(()=>{})}/>:<div className="flow-list flow-scroll" aria-label="智能体层级列表"><AgentTree rows={rows} local={local} ui={ui} select={select} change={()=>update(()=>{})}/></div>}</div>
      {showInspector&&selected&&<ProviderPanels wide={wide} title={selected.name} conversation={<>{detailsHeading}{conversation}</>} information={information} onClose={close}/>}
    </>}</>}
  </main>;
}
