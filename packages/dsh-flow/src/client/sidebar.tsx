/** Native right-Sidebar tabs retaining independent Flow sessions for observation. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-resources/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import { createReader, type ReaderSource } from './reader-source.ts';
import type { ReaderProps } from './reader.tsx';

const ID='dsh-flow-agent-chat',PREFIX='dsh-resource://flowagent/session/';
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { flowagent:{sessionId:string;source:ReaderSource} }
}
function parse(address:string):{sessionId:string;name:string}|null {
  if(!address.startsWith(PREFIX))return null;
  try {const url=new URL(address),sessionId=decodeURIComponent(url.pathname.slice('/session/'.length));return sessionId?{sessionId,name:url.searchParams.get('name')??'智能体'}:null;}catch{return null;}
}
function SidebarAgent({useResource,useTabInfo,renderFactorySlot}:{useResource:PropsRuntime<'sidebar.right.pane.tab'>['useResource'];useTabInfo:PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']} & PropsRenderFactories) {
  const {tab}=useTabInfo(),resource=useResource<'flowagent'>(tab.contentId);
  const value=resource.value;
  return <div className="flow-sidebar-chat" data-flow-sidebar-session={value?.sessionId}>{value?renderFactorySlot('dsh-flow.reader',{source:value.source,agentId:value.sessionId,variant:'embedded',follow:true} satisfies ReaderProps):<p>正在加载对话…</p>}</div>;
}
export function registerAgentSidebar(ctx:Context):void {
  ctx.effect(()=>ctx.resources.register({protocol:'flowagent',async *open(address,{signal}) {
    const value=parse(address);if(!value||signal.aborted)return;
    const source=createReader(ctx,value.sessionId);
    try {yield {ok:true as const,value:{sessionId:value.sessionId,source}};
      await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
    }finally{source.dispose();}
  }}),'dsh-flow: Sidebar session resources');
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:ID,kind:'flowagent',patterns:[`${PREFIX}**`],priority:'extension',canOpen:address=>parse(address)!==null,title:address=>parse(address)?.name??'智能体'}),'dsh-flow: Sidebar tab type');
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID},SidebarAgent));
}
export function openAgentSidebar(ctx:Context,sessionId:string,name:string):void {
  ctx.sidebarRight.openResource(`${PREFIX}${encodeURIComponent(sessionId)}?name=${encodeURIComponent(name)}`,{kind:'flowagent',preferNewPane:true});
}
