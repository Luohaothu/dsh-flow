/** Detail containers are rendered and resized by the official dock kit. */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { applyOp, createIdMinter, createInitialState, DockSurface } from '@deepseek-ai/dsh-client-ui-dockkit';
import type { DockIntents, DockLabels, LayoutState, PaneId, SplitId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit';

const LABELS: DockLabels = { emptyPane: '暂无内容', splitPane: '分栏', splitPaneDisabled: '当前布局已包含详情', splitPaneNarrow: '容器空间不足', closeTab: '关闭详情', addTab: '查看', dockFloat: '返回详情', closeFloat: '关闭详情', dropZone: {center:'定位',top:'顶部',right:'右侧',bottom:'底部',left:'左侧'} };
function layout(wide: boolean, title: string): LayoutState {
  const mint = createIdMinter();
  let state = createInitialState(mint, id => ({id,kind:'conversation',contentId:'conversation',title:`对话 · ${title}`}));
  const conversation=state.activePaneId;
  const tab=state.nodes[conversation]?.kind==='pane'?state.nodes[conversation].activeTabId:undefined;
  const infoTab = mint.next('tab') as TabId;
  if (wide) {
    const info = mint.next('pane') as PaneId;
    const outer = mint.next('split') as SplitId;
    // Wrap the entire left column, so information extends to the bottom.
    state = { ...state, rootId: outer, nodes: { ...state.nodes,
      [outer]: {kind:'split',id:outer,axis:'row',children:[state.rootId, info],sizes:[.7,.3]},
      [info]: {kind:'pane',id:info,host:'dock',tabs:[],activeTabId:undefined,rect:undefined},
    }};
    state = applyOp(state, {type:'openTab',paneId:info,tab:{id:infoTab,kind:'information',contentId:'information',title:`信息 · ${title}`},index:0}).state;
  } else {
    state = applyOp(state, {type:'openTab',paneId:conversation,tab:{id:infoTab,kind:'information',contentId:'information',title:'信息'},index:1}).state;
    state = applyOp(state, {type:'focusTab',tabId:tab!}).state;
  }
  return {...state,expanded:true};
}
/** The kit owns panes, tab focus, separators and pointer resizing. */
export function ProviderPanels({wide,title,conversation,information,onClose}: {wide:boolean;title:string;conversation:ReactNode;information:ReactNode;onClose:()=>void}) {
  const [state,setState] = useState(() => layout(wide,title));
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!event.defaultPrevented&&!(event.target instanceof Element&&event.target.closest('[role=dialog]'))){event.preventDefault();onClose();}
    };
    document.addEventListener('keydown',escape);
    return()=>document.removeEventListener('keydown',escape);
  },[onClose]);
  useEffect(() => { setState(layout(wide,title)); },[wide]);
  const displayed = useMemo(() => ({...state,tabs:Object.fromEntries(Object.entries(state.tabs).map(([id,tab])=>[id,{...tab,title:tab.kind==='conversation'?`对话 · ${title}`:tab.kind==='information'?`信息 · ${title}`:tab.title}]))}),[state,title]);
  const intents: DockIntents = {
    focusTab: tabId => setState(state => applyOp(state,{type:'focusTab',tabId}).state),
    focusPane: paneId => setState(state => applyOp(state,{type:'focusPane',paneId}).state),
    resizeSplit: (splitId,sizes) => setState(state => applyOp(state,{type:'resize',splitId,sizes}).state),
    closeTab: () => onClose(),
    splitPane: () => {}, addTab: () => {}, duplicateTab: () => {},
    // P0 permits resizing and tab selection, without an arbitrary workspace editor.
    floatTab: () => {}, unfloatPane: () => {}, placeTab: tabId => intents.focusTab(tabId), dropTab: tabId => intents.focusTab(tabId), moveFloat: () => {}, resizeFloat: () => {},
  };
  return <div className="flow-dock"><DockSurface allowTabDrag={false} state={displayed} canSplit={false} hideSplitWhenBlocked canAddTab={()=>false} canCloseTab={id=>state.tabs[id]?.kind!=='structure'} intents={intents} labels={LABELS}
    renderTab={tab=>tab.kind==='conversation'?conversation:information}/></div>;
}
