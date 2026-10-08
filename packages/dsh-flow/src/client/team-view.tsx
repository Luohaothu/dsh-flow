/** Team business content contributed to the host's Conversation view and header. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, MenuSurface, SegmentedTabs, StateDot, Tag, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import type { FlowTeamAgent, FlowTeamSnapshot } from '../types.ts';
import type { TeamObserver } from './observer.ts';
import type { DisplayPreferences, PreferenceStore } from './preferences.ts';
import type { ReaderSource } from './reader.tsx';
import type { ReaderProps } from './reader.tsx';
import { ENDED, NODE_HEIGHT, NODE_WIDTH, STATE_LABELS, createLocalView, duration, formatMetric, topologyLayout, treeRows, visibleEndedRows } from './tree.ts';
import { agentEmoji, reasoningLabel, ROLE_LABELS } from '../identity.ts';
import { ModelLogo } from './model-logo.tsx';
import type { LocalView, TreeRow } from './tree.ts';
import { ProviderPanels } from './surfaces.tsx';

export interface TeamUi {
  observer: TeamObserver
  preferences: PreferenceStore
  local: Map<string, LocalView>
  reader(sessionId: string): ReaderSource
  sidebar(agent:FlowTeamAgent):void
  renderReader?: ((props:ReaderProps)=>ReactNode) | undefined
  openAgent(agent:FlowTeamAgent):void
  main(): void
  openTeam(): void
  tab(available: boolean): void
}
function Status({agent,compact=false}: {agent:Pick<FlowTeamAgent,'state'|'raw_state'|'recycled'>;compact?:boolean}) {
  const dot = agent.state==='failed'?'error':agent.state==='running'?'ongoing':agent.state.startsWith('waiting')||agent.state==='paused'||agent.state==='blocked'?'warning':agent.state==='completed'?'done':'idle';
  return <span className="flow-status"><StateDot state={dot}/>{STATE_LABELS[agent.state]}{agent.recycled&&!compact&&<Tag>已回收</Tag>}</span>;
}
function RowStatus({agent,compact=false}: {agent:FlowTeamAgent;compact?:boolean}) {
  const effort=reasoningLabel(agent.reasoning_effort);
  return <span className="flow-row-state"><Status agent={agent} compact={compact}/>{agent.model&&<span className="flow-agent-model" title={`最近实际模型：${agent.model}${effort?` · 推理${effort}`:''}`}><span className="flow-model-divider" aria-hidden="true">·</span><ModelLogo model={agent.model}/><span className="flow-model-name">{agent.model}</span>{effort&&<span className="flow-model-effort">{effort}</span>}</span>}</span>;
}
function TreeToggle({name,hasChildren,collapsed,toggle}: {name:string;hasChildren:boolean;collapsed:boolean;toggle:()=>void}) {
  return hasChildren?<Button size="sm" className="flow-tree-toggle" aria-label={`${collapsed?'展开':'折叠'} ${name} 的子代理`} aria-expanded={!collapsed} onClick={toggle}><IconChevronRightOutlineRegular size={14}/></Button>:<span className="flow-tree-leaf" aria-hidden="true"/>;
}
function useLocal(ui: TeamUi, team: FlowTeamSnapshot | null, defaults: DisplayPreferences) {
  const key=team?.run.id??'loading';
  let local=ui.local.get(key);
  if (!local) {local=createLocalView(defaults.view);local.showEnded=defaults.ended==='show';ui.local.set(key,local);}
  const [,render]=useState(0);
  const update=(operation:()=>void)=>{operation();render(value=>value+1);};
  return {local,update};
}
/** A tree row's expand affordance never opens its full session. */
function AgentTree({rows,local,settings,full,aside,change}: {rows:readonly TreeRow[];local:LocalView;settings:DisplayPreferences;full:(id:string)=>void;aside:(agent:FlowTeamAgent)=>void;change:()=>void}) {
  const root=useRef<HTMLDivElement>(null);
  const [focus,setFocus]=useState<string|null>(null);
  const move=(id:string)=>{setFocus(id);root.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();};
  return <div ref={root} role="tree" aria-label="智能体派生树" className="flow-tree">
    {rows.map((row,index)=><div key={row.agent.id} role="treeitem" data-tree-id={row.agent.id} aria-level={row.depth+1} aria-expanded={row.children? !local.collapsed.has(row.agent.id):undefined} aria-selected={local.selected===row.agent.id}
      aria-label={`${row.agent.name}，${STATE_LABELS[row.agent.state]}，${row.incomplete?'正在补全关系':`第 ${row.depth+1} 层`}`} tabIndex={(focus??rows[0]?.agent.id)===row.agent.id?0:-1} style={{paddingInlineStart:`${row.depth*1.2}em`}} className="flow-tree-row"
      onFocus={()=>setFocus(row.agent.id)} onKeyDown={event=>{
        if(event.target!==event.currentTarget)return;
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const target=rows[index+(event.key==='ArrowDown'?1:-1)];if(target)move(target.agent.id);}
        if(event.key==='ArrowRight'){event.preventDefault();local.collapsed.delete(row.agent.id);change();}
        if(event.key==='ArrowLeft'){event.preventDefault();if(row.children&&!local.collapsed.has(row.agent.id)){local.collapsed.add(row.agent.id);change();}else if(row.agent.parent_id)move(row.agent.parent_id);}
        if(event.key==='Home'||event.key==='End'){event.preventDefault();const target=event.key==='Home'?rows[0]:rows.at(-1);if(target)move(target.agent.id);}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();full(row.agent.id);}
      }}>
      <TreeToggle name={row.agent.name} hasChildren={!!row.children} collapsed={local.collapsed.has(row.agent.id)} toggle={()=>{local.collapsed.has(row.agent.id)?local.collapsed.delete(row.agent.id):local.collapsed.add(row.agent.id);change();}}/>
      <Button size="sm" className="flow-tree-open" aria-label={`查看 ${row.agent.name} 对话`} onClick={()=>full(row.agent.id)}><span className="flow-tree-copy"><span className="flow-tree-name">{row.agent.name}<span className="flow-tree-role">{ROLE_LABELS[row.agent.role]}</span></span><span className="flow-tree-usage">{formatMetric(row.agent.tokens,settings.tokens)} tok</span><RowStatus agent={row.agent} compact/><span className="flow-tree-time">{duration(row.agent.created,row.agent.ended)}{row.incomplete&&' · 关系待补全'}</span></span></Button>
      <Tooltip label="在侧边栏打开" side="bottom" align="end"><Button size="sm" className="flow-tree-aside" aria-label={`在侧边栏打开 ${row.agent.name}`} onClick={()=>aside(row.agent)}><IconChevronRightOutlineRegular size={14} className="flow-tree-chevron"/></Button></Tooltip>
    </div>)}
  </div>;
}
/** The provider places the popover; its trigger and popup share a hover lifetime. */
export function TeamHeader({ui}: {ui:TeamUi}) {
  const data=useSyncExternalStore(ui.observer.subscribe,ui.observer.getSnapshot);
  const preferences=useSyncExternalStore(ui.preferences.subscribe,ui.preferences.getSnapshot).saved;
  const {local,update}=useLocal(ui,data.team,preferences);
  const [open,setOpen]=useState(false);
  const [fixed,setFixed]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null), popup=useRef<HTMLDivElement>(null);
  const closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const position=useAnchoredPosition({open,anchorRef:trigger,panelRef:popup,margin:16,side:'bottom',align:'start',gap:8});
  const close=()=>{setOpen(false);setFixed(false);trigger.current?.focus();};
  useDismissOnOutsidePointer(trigger,open,close,popup);
  useEffect(()=>ui.tab(data.runs.length>0),[data.runs.length>0]);
  useEffect(()=>()=>{clearTimeout(closeTimer.current);clearTimeout(openTimer.current);},[]);
  useEffect(()=>{if(!open)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();close();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[open]);
  const enter=()=>{clearTimeout(closeTimer.current);if(!open)openTimer.current=setTimeout(()=>setOpen(true),200);};
  const leave=()=>{clearTimeout(openTimer.current);if(!fixed)closeTimer.current=setTimeout(()=>setOpen(false),250);};
  if(!data.runs.length)return null;
  const team=data.team;
  const headerRows=team?treeRows(team.agents,local.collapsed):[];
  const headerEnded=team?.agents.filter(agent=>ENDED.has(agent.state)).length??0;
  const headerVisible=visibleEndedRows(headerRows,team?.agents??[],local.showEnded);
  const full=(id:string)=>{const agent=team?.agents.find(agent=>agent.id===id);if(agent)ui.openAgent(agent);close();};
  return <span className="flow-header" data-reduce-motion={preferences.motion==='reduce'} onPointerEnter={enter} onPointerLeave={leave}>
    <Button ref={trigger} size="sm" className="flow-team-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={()=>{if(open&&fixed)close();else{setOpen(true);setFixed(true);requestAnimationFrame(()=>popup.current?.querySelector<HTMLElement>('[role=treeitem]')?.focus());}}}>智能体团队 {team&&team.agents.length}<span className="flow-trigger-state">· {team?STATE_LABELS[team.run.state]:'正在加载'}</span><IconChevronDownOutlineRegular className="flow-trigger-chevron" size={14}/></Button>
    {open&&<MenuSurface ref={popup} style={position??undefined} className="flow-team-popup" role="dialog" aria-label="智能体团队" onPointerEnter={enter} onPointerLeave={leave}>
      {data.loading&&<p role="status">正在加载团队…</p>}{data.error&&<p role="status">{team?'连接中断，显示的是上次数据。':'暂时无法读取团队。'}{data.error}<Button onClick={()=>void ui.observer.refresh()}>重试连接</Button></p>}
      {team&&<>{!local.showEnded&&headerEnded>0&&<Button onClick={()=>update(()=>local.showEnded=true)}>已结束 {headerEnded} 个 · 展开</Button>}<AgentTree rows={headerVisible} local={local} settings={preferences} full={full} aside={agent=>{ui.sidebar(agent);close();}} change={()=>update(()=>{})}/>{team.agents.length===1&&<p>尚未派生子代理</p>}</>}
      <div className="flow-team-footer">{team&&<small>宿主已记录：{formatMetric(team.tokens,preferences.tokens)} Token</small>}<Button size="sm" onClick={()=>{ui.openTeam();close();}}>查看智能体</Button></div>
    </MenuSurface>}
  </span>;
}
function Information({agent,team,select,main}: {agent:FlowTeamAgent;team:FlowTeamSnapshot;select:(id:string)=>void;main:()=>void}) {
  const [copied,setCopied]=useState<string|null>(null);
  useEffect(()=>setCopied(null),[agent.id]);
  const parent=team.agents.find(item=>item.id===agent.parent_id);
  const row=treeRows(team.agents).find(row=>row.agent.id===agent.id);
  const children=team.agents.filter(item=>item.parent_id===agent.id);
  const absent=(value:number|null)=>value===null?'尚未提供':value.toLocaleString('zh-CN');
  return <section className="flow-information flow-scroll" aria-label={`${agent.name} 信息`}><h3>{agent.name}</h3><p className="flow-id">{agent.id}</p><Button size="sm" onClick={()=>void writeClipboard(agent.id).then(ok=>setCopied(ok?'ID 已复制':'未能复制 ID'))}>复制 ID</Button>{copied&&<span role="status">{copied}</span>}
    <h4>基本信息</h4><Status agent={agent}/><p>当前配置模型：{agent.configured_model??'跟随宿主'}{agent.configured_reasoning_effort&&` · 推理 ${agent.configured_reasoning_effort}`}</p><p>最近实际模型：{agent.model??'未知'}{agent.reasoning_effort&&` · 推理 ${agent.reasoning_effort}`}</p><p>{agent.reason??(agent.state.startsWith('waiting')?'等待原因尚未提供':'状态原因尚未提供')}</p><p>{agent.responsibility}</p><p>启动：{new Date(agent.created).toLocaleString()} · 持续 {duration(agent.created,agent.ended)}</p>
    {agent.waiting_since!==null&&<p>等待时长：{duration(agent.waiting_since,agent.ended)}</p>}{agent.state==='waiting_user'&&agent.reason&&<Button onClick={main}>前往主会话答复</Button>}{agent.waiting_for&&<Button onClick={()=>select(agent.waiting_for!)}>查看等待的智能体</Button>}
    {agent.recycled&&<p>运行资源已释放，历史记录仍可查看。</p>}
    <h4>关系</h4><p>层级：{row&&!row.incomplete?`第 ${row.depth+1} 层`:"正在补全关系"}</p><p>父代理：{parent?<Button onClick={()=>select(parent.id)}>{parent.name}</Button>:agent.parent_id?'正在补全关系':'无（总协调）'}</p>{children.map(child=><Button key={child.id} onClick={()=>select(child.id)}>{child.name}</Button>)}
    <h4>用量与预算</h4><p>宿主已记录 Token（当前代理自身）：{formatMetric(agent.tokens)}{agent.tokens.completeness==='unknown'&&' · 统计完整性未知'}</p>
    {!agent.allowances.length&&<p>预算尚未提供</p>}{agent.allowances.map(budget=><article key={budget.id}><strong>{budget.name}</strong><p>{budget.shared?`共享额度 · 作用域 ${budget.scope_id} · 团队 ${team.run.id}`:'当前代理独立额度'}</p><p>总额 {absent(budget.total)} · 已用 {absent(budget.used)} · 剩余 {absent(budget.remaining)} {budget.unit}</p></article>)}
    <h4>上下文</h4><p>已用 {absent(agent.context_used)} · 上限 {absent(agent.context_limit)} Token{agent.context_used!==null&&agent.context_limit!==null&&agent.context_limit>0&&` · ${Math.round(agent.context_used/agent.context_limit*100)}%`}</p>{agent.compacted_at!==null&&<p>上下文已压缩 · {new Date(agent.compacted_at).toLocaleString()}</p>}
    <h4>会话记录</h4><p className="flow-id">{agent.session_id}</p><p>所属主会话：{team.run.main_session_id}</p>
  </section>;
}
function Graph({rows,local,select,change,settings}: {rows:readonly TreeRow[];local:LocalView;select:(id:string)=>void;change:()=>void;settings:DisplayPreferences}) {
  const surface=useRef<HTMLDivElement>(null);
  const wheelChange=useRef(change);wheelChange.current=change;
  useEffect(()=>{
    const element=surface.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();
      const rect=element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
      const factor=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;
      const zoom=Math.max(.25,Math.min(2.5,local.zoom*Math.exp(-event.deltaY*factor*.002)));
      const ratio=zoom/local.zoom;local.x=x-(x-local.x)*ratio;local.y=y-(y-local.y)*ratio;
      local.zoom=zoom;local.interacted=true;wheelChange.current();
    };
    element.addEventListener('wheel',wheel,{passive:false});
    return()=>element.removeEventListener('wheel',wheel);
  },[local]);
  const drag=useRef<{x:number;y:number;ox:number;oy:number}|null>(null);
  const signature=rows.map(row=>`${row.agent.id}:${row.agent.parent_id}`).join('|');
  const geometry=useMemo(()=>topologyLayout(rows),[signature]);
  const ids=new Set(rows.map(row=>row.agent.id));
  const {positions,width,height}=geometry;
  const fit=(manual=true)=>{const box=surface.current;if(!box)return;const top=68,bottom=64;
    local.zoom=Math.max(.25,Math.min(1,(box.clientWidth-48)/width,(box.clientHeight-top-bottom-24)/height));
    local.x=(box.clientWidth-width*local.zoom)/2;local.y=top+Math.max(12,(box.clientHeight-top-bottom-height*local.zoom)/2);local.interacted=manual;change();};
  const autoFit=useRef(()=>{});autoFit.current=()=>{if(!local.interacted)fit(false);};
  useLayoutEffect(()=>{const box=surface.current;if(!box)return;autoFit.current();const observer=new ResizeObserver(()=>autoFit.current());observer.observe(box);return()=>observer.disconnect();},[signature]);
  return <section className="flow-graph-area" aria-label="团队拓扑"><div className="flow-actions flow-zoom"><Button onClick={()=>{local.zoom=Math.min(2.5,local.zoom+.1);local.interacted=true;change();}}>放大</Button><span>{Math.round(local.zoom*100)}%</span><Button onClick={()=>{local.zoom=Math.max(.25,local.zoom-.1);local.interacted=true;change();}}>缩小</Button><Button onClick={()=>fit()}>适应视口</Button><Button onClick={()=>{const root=rows.find(row=>row.agent.parent_id===null);if(root){const position=positions.get(root.agent.id);local.x=(surface.current?.clientWidth??0)/2-((position?.x??0)+NODE_WIDTH/2)*local.zoom;local.y=80;local.interacted=true;select(root.agent.id);}}}>定位总协调</Button></div>
    <div ref={surface} className="flow-graph" tabIndex={0} aria-label="拓扑画布，拖动空白处平移，使用工具栏缩放" onPointerDown={event=>{if((event.target as Element).closest('button,[role=button]'))return;event.currentTarget.focus();drag.current={x:event.clientX,y:event.clientY,ox:local.x,oy:local.y};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!drag.current)return;local.x=drag.current.ox+event.clientX-drag.current.x;local.y=drag.current.oy+event.clientY-drag.current.y;local.interacted=true;change();}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null}>
      <div className="flow-graph-world" style={{width,height,transform:`translate(${local.x}px,${local.y}px) scale(${local.zoom})`}}>
        <svg width={width} height={height} className="flow-lines" aria-label="智能体派生关系">
          {rows.map(row=>{const parent=row.agent.parent_id?positions.get(row.agent.parent_id):undefined;const here=positions.get(row.agent.id)!;return parent&&ids.has(row.agent.parent_id!)?<path key={row.agent.id} d={`M${parent.x+NODE_WIDTH/2} ${parent.y+NODE_HEIGHT} V${(parent.y+NODE_HEIGHT+here.y)/2} H${here.x+NODE_WIDTH/2} V${here.y}`} fill="none" stroke="currentColor"/>:null;})}
        </svg>
        {rows.map(row=>{const position=positions.get(row.agent.id)!;return <button type="button" key={row.agent.id} className="flow-node" data-role={row.agent.role} data-agent-id={row.agent.id} style={{left:position.x,top:position.y}} aria-pressed={local.selected===row.agent.id} aria-label={`${row.agent.name}，${ROLE_LABELS[row.agent.role]}，${STATE_LABELS[row.agent.state]}`} title={`${row.agent.name} · ${ROLE_LABELS[row.agent.role]}\n${row.agent.responsibility}`} onClick={()=>select(row.agent.id)}><span className="flow-node-meta"><span>{ROLE_LABELS[row.agent.role]}</span><RowStatus agent={row.agent} compact/></span><span className="flow-node-person"><span className="flow-avatar" aria-hidden="true">{agentEmoji(row.agent.id,row.agent.role)}</span><strong>{row.agent.name}</strong></span><small className="flow-node-task">{row.agent.responsibility}</small><small className="flow-node-usage">{formatMetric(row.agent.tokens,settings.tokens)} Token · {duration(row.agent.created,row.agent.ended)}</small>{row.incomplete&&<small>正在补全关系</small>}</button>;})}
      </div>
    </div>
  </section>;
}
/** The selected stable id drives every detail region in one React commit. */
export function TeamView({ui}: {ui:TeamUi}) {
  const data=useSyncExternalStore(ui.observer.subscribe,ui.observer.getSnapshot);
  const preferences=useSyncExternalStore(ui.preferences.subscribe,ui.preferences.getSnapshot).saved;
  const {local,update}=useLocal(ui,data.team,preferences);
  const container=useRef<HTMLDivElement>(null),controlsRef=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(0),[controlsHeight,setControlsHeight]=useState(48);
  const {detailsTab,page}=local;
  const setDetailsTab=(value:'conversation'|'information')=>update(()=>local.detailsTab=value);
  const setPage=(value:number|((old:number)=>number))=>update(()=>local.page=typeof value==='function'?value(local.page):value);

  useLayoutEffect(()=>{const element=container.current;if(!element)return;const measure=()=>setWidth(element.clientWidth);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>{const element=controlsRef.current;if(!element)return;const measure=()=>setControlsHeight(element.getBoundingClientRect().height);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  const contentStyle:CSSProperties & {'--flow-controls-height':string}={'--flow-controls-height':`${controlsHeight}px`};
  const narrow=width>0&&width<600,wide=width>=1080;
  const manualNarrow=local.manualNarrow;const setManualNarrow=(value:boolean)=>update(()=>local.manualNarrow=value);
  const view=narrow&&!manualNarrow?'list':local.view;
  const team=data.team;
  const selected=team?.agents.find(agent=>agent.id===local.selected)??null;
  const reader=useMemo(()=>selected?ui.reader(selected.session_id):null,[selected?.id,selected?.session_id,team?.run.id]);
  useEffect(()=>()=>reader?.dispose(),[reader]);
  const select=(id:string)=>update(()=>{
    local.selected=id;local.inspector=true;
    let parent=team?.agents.find(agent=>agent.id===id)?.parent_id;
    const seen=new Set<string>();
    while(parent&&!seen.has(parent)){seen.add(parent);local.collapsed.delete(parent);parent=team?.agents.find(agent=>agent.id===parent)?.parent_id;}
  });
  const full=(id:string)=>{const agent=team?.agents.find(agent=>agent.id===id);if(agent)ui.openAgent(agent);};
  const rows=team?treeRows(team.agents,local.collapsed):[];
  const conversations:ReactNode=selected&&reader&&ui.renderReader?<div className="flow-conversation-detail"><div className="flow-detail-heading"><strong>{selected.name}</strong><span className="flow-id">{selected.id}</span></div>{ui.renderReader({source:reader,agentId:selected.id,follow:preferences.follow,variant:'embedded',openFull:()=>full(selected.id)})}</div>:null;
  const information:ReactNode=selected&&team?<Information agent={selected} team={team} select={select} main={ui.main}/>:null;
  const structure:ReactNode=<div className="flow-structure">

    {!rows.length&&<p>暂无智能体</p>}
    {team?.agents.length===1&&<p>尚未派生子代理</p>}
    {view==='graph'?<Graph rows={rows} local={local} select={select} change={()=>update(()=>{})} settings={preferences}/>:<div className="flow-scroll" role="list" aria-label="智能体层级列表">{rows.slice(0,page).map(row=><div role="listitem" key={row.agent.id} className="flow-list-row" data-role={row.agent.role} style={{paddingInlineStart:`${row.depth*1.2}em`}}><TreeToggle name={row.agent.name} hasChildren={!!row.children} collapsed={local.collapsed.has(row.agent.id)} toggle={()=>update(()=>{local.collapsed.has(row.agent.id)?local.collapsed.delete(row.agent.id):local.collapsed.add(row.agent.id);})}/><Button className="flow-title" onClick={()=>select(row.agent.id)} title={row.agent.name} aria-pressed={local.selected===row.agent.id}>{row.agent.name}</Button><RowStatus agent={row.agent}/><small>{formatMetric(row.agent.tokens,preferences.tokens)} Token{row.incomplete&&' · 正在补全关系'}</small></div>)}{rows.length>page&&<Button onClick={()=>setPage(value=>value+100)}>显示更多代理（{rows.length-page} 个）</Button>}</div>}
  </div>;
  const notices=team?<div className="flow-notices">{team.run.reason&&<p className="flow-run-reason" role="status">{team.run.reason}</p>}
      {ENDED.has(team.run.state)&&<div className="flow-result"><p>结束：{team.run.ended?new Date(team.run.ended).toLocaleString():'尚未提供'}</p>{team.run.result&&<details><summary>团队结果</summary><pre>{JSON.stringify(team.run.result,null,2)}</pre></details>}</div>}
      {team.agents.some(agent=>agent.state==='waiting_user')&&<div role="status">{team.agents.filter(agent=>agent.state==='waiting_user').map(agent=><p key={agent.id}><Button onClick={()=>select(agent.id)}>{agent.name}</Button>：{agent.reason??'等待原因尚未提供'}{agent.reason&&<Button onClick={ui.main}>前往主会话答复</Button>}</p>)}</div>}
      </div>:null;
  const controls=<div ref={controlsRef} className="flow-controls">{team&&!(narrow&&local.inspector)&&<div className="flow-toolbar" role="group" aria-label="智能体视图"><Button aria-pressed={view==='graph'} onClick={()=>{setManualNarrow(true);update(()=>local.view='graph');}}>拓扑图</Button><Button aria-pressed={view==='list'} onClick={()=>{setManualNarrow(true);update(()=>local.view='list');}}>列表</Button></div>}</div>;
  return <div ref={container} className="flow-content" style={contentStyle} data-full-details={narrow&&local.inspector} data-reduce-motion={preferences.motion==='reduce'}>
    {controls}{notices}{data.loading&&<p role="status">正在加载团队…</p>}{data.error&&<div role="status">{team?'连接中断，显示的是上次数据。':'暂时无法读取团队。'}最后更新：{data.updated?new Date(data.updated).toLocaleString():'尚未获取'}。{data.error}<Button onClick={()=>void ui.observer.refresh()}>重试连接</Button></div>}
    {!data.loading&&!team&&!data.error&&<p>尚未启动团队，请在主会话输入 /agent-team 和需求。</p>}

    {team&&<>
{(narrow&&local.inspector)&&selected?<><div className="flow-detail-heading"><Button onClick={()=>update(()=>local.inspector=false)}>返回团队</Button><h3>{selected.name}</h3><Status agent={selected}/><Button onClick={ui.main}>主对话</Button></div><SegmentedTabs label="代理详情" value={detailsTab} onChange={setDetailsTab} items={[{value:'conversation',label:'对话',id:'flow-conversation-tab',panelId:'flow-detail-panel'},{value:'information',label:'信息',id:'flow-information-tab',panelId:'flow-detail-panel'}]}/><div role="tabpanel" id="flow-detail-panel" aria-labelledby={`flow-${detailsTab}-tab`} className="flow-mobile-detail">{detailsTab==='conversation'?conversations:information}</div></>:<>

        {structure}{selected&&local.inspector&&<ProviderPanels wide={wide} title={selected.name} conversation={conversations} information={information} onClose={()=>update(()=>local.inspector=false)}/>}
      </>}
    </>}
  </div>;
}
