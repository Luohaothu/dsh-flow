/** Production team components rendered inside the native web Host with fixture business facts. */
import type { Context } from '@deepseek-ai/cordis';
import { createRoot } from 'react-dom/client';
import { TeamHeader, TeamView } from '../../packages/dsh-flow/src/client/team-view.tsx';
import { TeamObserver } from '../../packages/dsh-flow/src/client/observer.ts';
import { TEAM_CSS } from '../../packages/dsh-flow/src/client/styles.ts';
import type { FlowTeamSnapshot } from '../../packages/dsh-flow/src/types.ts';
declare global { interface Window { teamUiFixture: { current: FlowTeamSnapshot; historical: FlowTeamSnapshot; failing: boolean; action: string } } }
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const container = document.createElement('div'); container.id = 'flow-fixture';
    const style = document.createElement('style');
    style.textContent = TEAM_CSS + '#flow-fixture{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fafbf9);color:var(--dsw-alias-label-primary,#27302e);font-family:system-ui,sans-serif}.fixture-header{padding:14px 24px;border-bottom:1px solid #dfe4df;display:flex;align-items:center;justify-content:space-between;font-size:12px;flex-shrink:0}';
    document.head.append(style);document.body.append(container);
    const data = () => { if (window.teamUiFixture.failing) throw new Error('模拟读取连接中断'); return window.teamUiFixture; };
    const observer = new TeamObserver('owner', {
      async runs() { const value = data(); return [value.current.run,value.historical.run]; },
      async read(_owner, id) { const value = data(); return structuredClone(id === 'current' ? value.current : value.historical); },
    },100);
    const action = (value: string) => { window.teamUiFixture.action = value; };
    const ui = { observer, local:new Map(), openMember:(member:{session_id:string})=>action(`session:${member.session_id}`),sidebar:(member:{session_id:string})=>action(`sidebar:${member.session_id}`),main:()=>action('main'),openTeam:()=>action('team'),tab:(visible:boolean)=>{container.dataset.teamTab=String(visible);} };
    const root=createRoot(container);
    root.render(<><div className="fixture-header"><span>团队界面组件验证</span><TeamHeader ui={ui}/></div><TeamView ui={ui}/></>);
    return()=>{root.unmount();observer.dispose();style.remove();container.remove();};
  });
}
