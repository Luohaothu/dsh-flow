/** Browser assembly: public host slots, shared observing data, and display settings. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-attachment/client';
import type { PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import TYPERT_REMOTE from 'dsh-flow/remote';
import { TeamObserver } from './client/observer.ts';
import { PreferenceStore } from './client/preferences.ts';
import { useEffect, useSyncExternalStore } from 'react';
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { AgentSessionSource } from './client/agent-session.ts';
import { projectAgentSession } from './agent-session.ts';
import { createElement } from 'react';
import type { LocalView } from './client/tree.ts';
import { createReader, ReadOnlyConversation, NativeReadOnlyTranscript } from './client/reader.tsx';
import { PreferenceNavigation } from './client/navigation.ts';
import { ExecutionSettings, SettingsCoordinator } from './client/execution-settings.ts';
import { SettingsLeaveOverlay, SettingsPage } from './client/settings.tsx';
import { TeamHeader, TeamView } from './client/team-view.tsx';
import type { TeamUi } from './client/team-view.tsx';
import { TEAM_CSS } from './client/styles.ts';
import { registerAgentSidebar, openAgentSidebar } from './client/sidebar.tsx';
import { registerCommunicationRenderer } from './client/communication.tsx';

export const inject = ['remote'];
/** Mount the generated namespace before activating consumers. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE), 'dsh-flow: remote contribution');
  ctx.plugin(teamUiPlugin);
}
const teamUiPlugin = {
  name: 'dsh-flow-team-ui',
  inject: ['slots','remote.flow','remote.session','configForms','resources','sidebarRight','sidebarRightTabs','sessions','uiConversation','conversation','uiWorkspace','layout'],
  apply(ctx: Context): void {
    const preferences = new PreferenceStore({
      read: () => localStorage.getItem('dsh-flow:display:v1'),
      async write(value) { localStorage.setItem('dsh-flow:display:v1', value); },
    });
    const execution = new ExecutionSettings(ctx.configForms.get<Record<string,unknown>>('dsh-flow'));
    ctx.effect(()=>()=>execution.dispose(),'dsh-flow: execution settings form');
    const settings = new SettingsCoordinator(preferences,execution);
    const navigation = new PreferenceNavigation(settings);
    const catalog=async()=>{
      const result=await ctx.remote.session.modelCatalog();if(!result.ok)throw result.error;
      return result.value.groups.flatMap(group=>group.models.map(model=>({value:JSON.stringify({provider:group.id,model:model.id}),label:`${group.name} · ${model.name}`})));
    };
    const guard = (active:boolean) => active ? ctx.layout.addNavigationGuard(navigation.request) : () => {};
    const observers = new Map<string,TeamObserver>();
    const locals = new Map<string,Map<string,LocalView>>();
    const pendingViews=new Map<string,string>();
    ctx.effect(()=>{
      let previous=preferences.getSnapshot().saved;
      return preferences.subscribe(()=>{
        const saved=preferences.getSnapshot().saved;if(saved===previous)return;previous=saved;
        for(const views of locals.values())for(const view of views.values()) {
          view.view=saved.view;view.showEnded=saved.ended==='show';
        }
      });
    },'dsh-flow: apply saved display preferences');
    const observer = (id:string):TeamObserver => {
      const key=id;
      let source=observers.get(key);
      if(!source){source=new TeamObserver(id,{
        async runs(sessionId){const result=await ctx.remote.flow.teamRuns(sessionId);if(!result.ok)throw result.error;return result.value;},
        async read(sessionId,runId){const result=await ctx.remote.flow.teamRead(sessionId,runId);if(!result.ok)throw result.error;return result.value;},
      });observers.set(key,source);}
      return source;
    };
    const agentSources=new Map<string,AgentSessionSource>();
    const ownBlocks=new Map<string,string>();
    const lineageOwned=new Set<string>();let refreshLineage:(()=>void)|undefined;
    const agentSource=(id:string):AgentSessionSource=>{
      let source=agentSources.get(id);
      if(!source){source=new AgentSessionSource(id,async sessionId=>{
        const result=await ctx.remote.flow.agentSession(sessionId);if(!result.ok)throw result.error;return result.value;
      },(value,error)=>{
        if(value&&!lineageOwned.has(id)){lineageOwned.add(id);refreshLineage?.();}
        const reason=value?(error?'暂时无法确认智能体状态，请稍后重试。':value.message_block_reason):null;
        const sessionId=SessionId(id),previous=ownBlocks.get(id);
        if(reason){ownBlocks.set(id,reason);ctx.conversation.blocks.set(sessionId,{reason});}
        else if(previous){ownBlocks.delete(id);if(ctx.conversation.blocks.storeFor(sessionId).getSnapshot()?.reason===previous)ctx.conversation.blocks.set(sessionId,undefined);}
      });agentSources.set(id,source);}
      return source;
    };
    ctx.slots.inject('conversation.session.header.lineage',()=>{
      let dispose:(()=>void)|undefined;
      refreshLineage=()=>{dispose?.();dispose=ctx.slots.register({name:'conversation.session.header.lineage',priority:-20,
        select:owner=>{const source=agentSources.get(owner.lineageSessionId);return source?.getSnapshot().value?{source}:null;},
      },AgentLineageEntry);};
      refreshLineage();return()=>{refreshLineage=undefined;dispose?.();};
    });
    ctx.slots.inject('conversation.composer',()=>ctx.slots.register({name:'conversation.composer',priority:-20,
      select:owner=>{const reason=owner.sessionId&&ownBlocks.get(owner.sessionId);return reason?{reason}:null;},
    },({matched})=>createElement('section',{className:'flow-session-record',role:'status'},
      createElement('strong',null,'智能体历史记录'),createElement('span',null,matched.reason))));
    let available=new Set<string>();const availabilityListeners=new Set<()=>void>();
    const availableSessions={getSnapshot:()=>available,subscribe:(listener:()=>void)=>{availabilityListeners.add(listener);return()=>availabilityListeners.delete(listener);}};
    ctx.effect(()=>ctx.uiConversation.registerViewPresentation('dsh-flow-agents',{availableSessions,layout:'contained',readOnly:true}),'dsh-flow: view presentation');
    ctx.effect(()=>ctx.slots.registerFactory({
      name:'dsh-flow.reader',scope:'root',
      children:{'dsh-flow.reader.session':{kind:'single',scope:'session'}},
    },ReadOnlyConversation),'dsh-flow: native observation reader');
    ctx.slots.inject('dsh-flow.reader.session',()=>ctx.slots.register({name:'dsh-flow.reader.session'},NativeReadOnlyTranscript));
    registerAgentSidebar(ctx);
    registerCommunicationRenderer(ctx);
    ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'dsh-flow-agents',order:20,label:()=> '智能体',inject:(sessionId:SessionId)=>({ui:ui(sessionId)})},TeamViewEntry));
    const tab=(id:SessionId,visible:boolean):void=>{
      if(available.has(id)!==visible){available=new Set(available);visible?available.add(id):available.delete(id);for(const listener of availabilityListeners)listener();}
    };
    const ui=(id:SessionId):TeamUi=>{
      let local=locals.get(id);if(!local){local=new Map();locals.set(id,local);}
      return {
        observer:observer(id),preferences,local,reader:sessionId=>createReader(ctx,sessionId),sidebar:agent=>openAgentSidebar(ctx,agent.session_id,agent.name),
        openAgent:agent=>{
          const team=observer(id).getSnapshot().team;
          if(team)for(const member of team.agents)agentSource(member.session_id).seed(projectAgentSession(team.run,member));
          ctx.uiWorkspace.openSession(SessionId(agent.session_id),{allowUnlisted:true,observationOnly:true});
        },
        main:()=>{ctx.uiWorkspace.openSession(id);const binding=ctx.sessions.binding(id);if(binding)requestAnimationFrame(()=>ctx.conversation.input.for(binding.ctx).focus());},
        openTeam:()=>{pendingViews.set(id,'dsh-flow-agents');ctx.uiWorkspace.openSession(id);},tab:available=>tab(id,available),
      };
    };
    ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:'dsh-flow-team',order:-19,inject:(id:SessionId)=>({ui:ui(id),source:agentSource(id),ownerUi:ui,takeView:()=>{const view=pendingViews.get(id);pendingViews.delete(id);return view;}})},TeamHeaderEntry));
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-flow',inject:()=>({store:preferences,execution,settings,catalog,guard,onLeave:()=>ctx.layout.selectPanel(null)})},SettingsPage));
    ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'dsh-flow-settings-leave',inject:()=>({store:preferences,execution,navigation})},SettingsLeaveOverlay));
    ctx.effect(()=>ctx.on('connection/reset',()=>{for(const source of observers.values()){source.reset();void source.refresh();}}),'dsh-flow: reconnect');
    ctx.effect(()=>{
      const style=document.createElement('style');style.textContent=TEAM_CSS;document.head.append(style);return()=>style.remove();
    },'dsh-flow: scoped business styles');
    ctx.effect(()=>()=>{availabilityListeners.clear();pendingViews.clear();for(const source of observers.values())source.dispose();for(const source of agentSources.values())source.dispose();for(const [id,reason] of ownBlocks)if(ctx.conversation.blocks.storeFor(SessionId(id)).getSnapshot()?.reason===reason)ctx.conversation.blocks.set(SessionId(id),undefined);},'dsh-flow: observing lifecycle');
  },
};
function AgentLineageEntry(props:PropsRuntime<'conversation.session.header.lineage'> & {matched:{source:AgentSessionSource}}) {
  const {value}=useSyncExternalStore(props.matched.source.subscribe,props.matched.source.getSnapshot);
  const name=value?.agent.name??props.displayTitle;
  return props.openTitle?createElement(Button,{size:'sm',onClick:props.openTitle},name):createElement('strong',null,name);
}
function TeamHeaderEntry(props:PropsRuntime<'conversation.session.header.actions'> & {ui:TeamUi;source:AgentSessionSource;ownerUi:(id:SessionId)=>TeamUi;takeView:()=>string|undefined}) {
  const {value}=useSyncExternalStore(props.source.subscribe,props.source.getSnapshot);
  useEffect(()=>{const view=props.takeView();if(view)props.selectView(view);},[props.takeView,props.selectView]);
  const ui=value?props.ownerUi(SessionId(value.run.main_session_id)):props.ui;
  return createElement('span',{className:'flow-agent-session-header'},
    value?createElement(Button,{size:'sm',onClick:()=>ui.main()},'主会话'):null,
    value?.agent.recycled?createElement(Tag,null,'已回收'):null,
    createElement(TeamHeader,{ui:{...ui,openTeam:()=>value?ui.openTeam():props.selectView('dsh-flow-agents')}}));
}
function TeamViewEntry(props:PropsRuntime<'conversation.view'> & PropsRenderFactories & {ui:TeamUi}) {
  return TeamView({ui:{...props.ui,renderReader:options=>props.renderFactorySlot('dsh-flow.reader',options),main:()=>{props.openView('chat','');props.ui.main();}}});
}
