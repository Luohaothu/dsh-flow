import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ReadonlySourceRegistration } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-theme/client';
import { DashboardClient, type DashboardClientState } from '../dashboard/client.js';
import type { RegistrySnapshot, RunInfo } from '../dashboard/protocol.js';
import { HeaderMembers, type HeaderMembersState, type HeaderRunMembers } from './header-members.js';
import { DashboardApp } from '../ui/DashboardApp.js';
import { DashboardStyles } from '../ui/styles.js';
import { AgentStatusBadge, Icon, ModelMark } from '../ui/icons.js';
import { createDashboardViewStore } from '../ui/view-state.js';
import type { DashboardFocus, DashboardScope, ObservationTarget } from '../ui/types.js';
import { FlowObserver, observationError, registerObserverSource, type ObserverHost } from './observer.js';
import { FlowSettings } from './settings.js';
import type { FlowConnection } from './protocol.js';
import { TYPERT_REMOTE } from './typert.remote-client.js';

interface SurfaceInput { mode: 'dashboard' | 'header'; callerSessionId?: string; focus?: DashboardFocus; onFocusConsumed?(requestId: string): void; openView?(view: string, focus: string): void }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap { 'dsh-flow.surface': { scope: 'root'; props: SurfaceInput; children: { 'dsh-flow.transcript': { kind: 'single'; scope: 'session' } } } }
  interface SlotMap { 'dsh-flow.transcript': { kind: 'single'; scope: 'session' } }
}
type SurfaceProps = SurfaceInput & PropsRenderSlots<'dsh-flow.transcript'> & PropsRenderFactories;

export function encodeFocus(value: DashboardFocus): string { return JSON.stringify(value); }
export function decodeFocus(value: string): DashboardFocus | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('requestId' in parsed) || typeof parsed.requestId !== 'string' || !('runId' in parsed) || typeof parsed.runId !== 'string') return;
    if ('instanceId' in parsed && typeof parsed.instanceId !== 'string') return;
    if ('observe' in parsed && typeof parsed.observe !== 'boolean') return;
    return { requestId: parsed.requestId, runId: parsed.runId, ...'instanceId' in parsed ? { instanceId: parsed.instanceId as string } : {}, ...'observe' in parsed ? { observe: parsed.observe as boolean } : {} };
  } catch { return undefined; }
}
function useConnection(ctx: Context) {
  const [value, setValue] = useState<FlowConnection>(), [error, setError] = useState<string>();
  useEffect(() => { let active = true; void ctx.remote.flowDashboard.connection().then(result => {
    if (!active) return; if (result.ok) { setValue(result.value); setError(undefined); } else setError(observationError(result.error));
  }, reason => { if (active) setError(observationError(reason)); }); return () => { active = false; }; }, [ctx]);
  return { value, error };
}
function useHostTheme(ctx: Context) {
  const [theme, setTheme] = useState(() => ctx.theme.getTheme().active.colorScheme);
  useEffect(() => { const dispose = ctx.on('theme/change', snapshot => setTheme(snapshot.active.colorScheme)); return () => { dispose(); }; }, [ctx]);
  return theme;
}
export function useDashboard(address: string, runId?: string) {
  const client = useMemo(() => new DashboardClient({ baseUrl: address }), [address]);
  const [owned, setOwned] = useState(() => ({ client, state: client.getState() }));
  const [failure, setFailure] = useState<{ client: DashboardClient; runId: string | undefined; message: string } | null>(null);
  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribe(state => { if (active) setOwned({ client, state }); });
    void client.connect().then(() => {
      if (active) setFailure(previous => previous?.client === client && previous.runId === undefined ? null : previous);
    }, error => { if (active) setFailure({ client, runId: undefined, message: observationError(error) }); });
    return () => { active = false; unsubscribe(); client.dispose(); };
  }, [client]);
  useEffect(() => {
    if (runId === undefined) return;
    let active = true;
    setFailure(null);
    void client.selectRun(runId).then(() => {
      if (active) setFailure(previous => previous?.client === client && previous.runId === runId ? null : previous);
    }, error => { if (active) setFailure({ client, runId, message: observationError(error) }); });
    return () => { active = false; };
  }, [client, runId]);
  const current = owned.client === client ? owned.state : client.getState();
  const pendingRun = runId !== undefined && (current.selectedRunId !== runId || (current.snapshot !== null && current.snapshot.run.id !== runId));
  const visible: DashboardClientState = pendingRun ? { ...current, selectedRunId: runId, snapshot: null, runConnection: 'connecting', error: null } : current;
  const error = failure?.client === client && (failure.runId === undefined || failure.runId === runId) ? failure.message : visible.error;
  const state: DashboardClientState = error === visible.error ? visible : { ...visible, error };
  return { client, state };
}
function NativeDashboard({ address, scope, host, focus, onFocusConsumed, ctx, viewStore, theme }: { address: string; scope: DashboardScope; host: ObserverHost; ctx: Context; viewStore: ReturnType<typeof createDashboardViewStore>; focus?: DashboardFocus; onFocusConsumed?(id: string): void; theme: 'light' | 'dark' }) {
  const { client } = useDashboard(address);
  return <DashboardApp client={client} scope={scope} viewStore={viewStore} theme={theme} {...focus ? { focus } : {}} {...onFocusConsumed ? { onFocusConsumed } : {}}
    nativeActions={{ returnToSession: callerSessionId => ctx.uiWorkspace.openSession(callerSessionId as SessionId),
      renderObserver: props => <FlowObserver {...props} {...host} /> }} />;
}
function HeaderRun({ run, state = {}, openView, observe }: { run: RunInfo; state?: HeaderRunMembers; openView(view: string, focus: string): void; observe(target: ObservationTarget, opener: HTMLButtonElement): void }) {
  return <div role="group" aria-label={run.name}><div className="flow-native-run-label">{run.name}</div>
    {state.error && <p role="status">{state.error}</p>}
    {state.snapshot?.nodes.map(node => <div className="flow-native-member" key={node.id}>
      <button type="button" role="menuitem" onClick={() => openView('dsh-flow', encodeFocus({ requestId: crypto.randomUUID(), runId: run.id, instanceId: node.id }))}><ModelMark model={node.model} /><span>{node.name}</span><AgentStatusBadge node={node} /></button>
      <button type="button" role="menuitem" className="flow-native-observe-arrow" aria-label={`观察 ${node.name} 原生会话`} onClick={event => { event.stopPropagation(); observe({ runId: run.id, instanceId: node.id, sessionId: node.sessionID }, event.currentTarget); }}><Icon name="right" size={16} /></button>
    </div>)}
    {!state.snapshot && !state.error && <p role="status">正在读取成员…</p>}</div>;
}
function HeaderObserver({ address, target, host, close, theme }: { address: string; target: ObservationTarget; host: ObserverHost; close(): void; theme: 'light' | 'dark' }) {
  const { state } = useDashboard(address, target.runId);
  const targetKey = JSON.stringify([target.runId, target.instanceId, target.sessionId]);
  const [selection, setSelection] = useState({ key: targetKey, target });
  const selected = selection.key === targetKey ? selection.target : target;
  useEffect(() => setSelection({ key: targetKey, target }), [targetKey, target]);
  const member = state.snapshot?.run.id === selected.runId ? state.snapshot.nodes.find(node => node.id === selected.instanceId && node.sessionID === selected.sessionId) : undefined;
  if (!member) return <aside className="flow-native-header-observer"><button type="button" onClick={close}>关闭观察</button><p role="status">{state.error ?? (state.snapshot ? '该成员已不可用' : '正在读取成员…')}</p></aside>;
  return <div className="flow-native-header-observer flow-dashboard" data-theme={theme}><FlowObserver target={selected} member={member} members={state.snapshot!.nodes} onSelect={next => setSelection({ key: targetKey, target: next })} onClose={close} {...host} /></div>;
}
function useHeaderMembers(client: DashboardClient, registry: RegistrySnapshot | null, caller: string, enabled: boolean): HeaderMembersState {
  const pool = useMemo(() => enabled ? new HeaderMembers(client, caller) : undefined, [client, caller, enabled, registry?.epoch]);
  const [owned, setOwned] = useState<{ pool: HeaderMembers | undefined; state: HeaderMembersState }>({ pool, state: {} });
  useEffect(() => {
    if (!pool) return;
    const unsubscribe = pool.subscribe(state => setOwned({ pool, state }));
    return () => { unsubscribe(); pool.dispose(); };
  }, [pool]);
  useEffect(() => { pool?.update(registry); }, [pool, registry?.epoch, registry?.seq]);
  return owned.pool === pool ? owned.state : pool?.getState() ?? {};
}
export function TeamHeader({ address, callerSessionId, openView, host, theme }: { address: string; callerSessionId: string; openView(view: string, focus: string): void; host: ObserverHost; theme: 'light' | 'dark' }) {
  const { client, state } = useDashboard(address), [expandedCaller, setExpandedCaller] = useState<string | null>(null), [target, setTarget] = useState<ObservationTarget>();
  const expanded = expandedCaller === callerSessionId;
  const members = useHeaderMembers(client, state.registry, callerSessionId, expanded && state.registry?.epoch === state.epoch);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), opener = useRef<HTMLButtonElement | null>(null);
  const runs = state.registry?.runs.filter(run => run.entry.callerSessionId === callerSessionId) ?? [];
  const closeMenu = () => { setExpandedCaller(null); trigger.current?.focus(); };
  const closeObserver = () => { setTarget(undefined); (opener.current?.isConnected ? opener.current : trigger.current)?.focus(); };
  useEffect(() => { setExpandedCaller(null); setTarget(undefined); }, [callerSessionId]);
  useEffect(() => {
    if (!expanded) return;
    const pointer = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setExpandedCaller(null); };
    document.addEventListener('pointerdown', pointer); return () => document.removeEventListener('pointerdown', pointer);
  }, [expanded]);
  return <div className="flow-native-team-header" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (target) closeObserver(); else closeMenu(); }
    if (expanded && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement), delta = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + delta + buttons.length) % buttons.length]?.focus();
    }
  }}><button ref={trigger} type="button" className="flow-native-team-trigger" aria-label={`当前会话 ${runs.length} 个团队运行`} aria-haspopup="menu" aria-expanded={expanded} onClick={() => setExpandedCaller(value => value === callerSessionId ? null : callerSessionId)}><Icon name="group" size={15} />{runs.length}<Icon name="down" /></button>
    {expanded && <div className="flow-native-team-menu flow-dashboard" data-theme={theme} ref={menu} role="menu" aria-label="当前会话团队">{state.error && <p role="status">{state.error}</p>}{runs.length ? runs.map(run => <HeaderRun key={run.id} run={run} state={members[run.id] ?? {}} openView={(view, focus) => { openView(view, focus); closeMenu(); }} observe={(next, element) => { opener.current = element; setTarget(next); setExpandedCaller(null); }} />) : <p>使用 /agent-team 创建团队</p>}</div>}
    {target && <HeaderObserver address={address} target={target} host={host} close={closeObserver} theme={theme} />}
  </div>;
}

function NativeSurface({ ctx, source, viewStores, ...props }: SurfaceProps & { ctx: Context; source: ReadonlySourceRegistration; viewStores: Map<string, ReturnType<typeof createDashboardViewStore>> }) {
  const connection = useConnection(ctx);
  const theme = useHostTheme(ctx);
  const key = props.callerSessionId ?? 'global';
  let viewStore = viewStores.get(key); if (!viewStore) { viewStore = createDashboardViewStore(); viewStores.set(key, viewStore); }
  const host: ObserverHost = { source, SessionProvider: props.SessionProvider, renderTranscript: () => props.renderSlot('dsh-flow.transcript', {}) };
  if (!connection.value) return <span role="status">{connection.error ?? '正在连接智能体服务…'}</span>;
  const scope: DashboardScope = props.callerSessionId ? { kind: 'session', callerSessionId: props.callerSessionId } : { kind: 'global' };
  return <div className={`flow-native-surface ${props.mode === 'header' ? 'is-header' : ''}`} data-theme={theme}><DashboardStyles />{props.mode === 'header' && props.callerSessionId && props.openView
    ? <TeamHeader address={connection.value.address} callerSessionId={props.callerSessionId} openView={props.openView} host={host} theme={theme} />
    : <NativeDashboard key={key} address={connection.value.address} scope={scope} host={host} ctx={ctx} viewStore={viewStore} theme={theme} {...props.focus ? { focus: props.focus } : {}} {...props.onFocusConsumed ? { onFocusConsumed: props.onFocusConsumed } : {}} />}</div>;
}
function SessionView(props: PropsRuntime<'conversation.view'> & PropsRenderFactories) {
  const focus = props.viewRequest ? decodeFocus(props.viewRequest.focus) : undefined;
  useEffect(() => { if (props.viewRequest && !focus) props.completeViewRequest(); }, [props.viewRequest, focus, props.completeViewRequest]);
  return props.renderFactorySlot('dsh-flow.surface', { mode: 'dashboard', callerSessionId: props.sessionId,
    ...focus ? { focus, onFocusConsumed: () => props.completeViewRequest() } : {} });
}
function NativeSettings({ ctx }: { ctx: Context }) {
  const { value, error } = useConnection(ctx);
  const theme = useHostTheme(ctx);
  const configuration = value?.configuration;
  const entryId = configuration && 'entryId' in configuration && typeof configuration.entryId === 'string' ? configuration.entryId : undefined;
  return <div className="flow-dashboard flow-native-settings-surface" data-theme={theme}><DashboardStyles />{entryId ? <FlowSettings ctx={ctx} entryId={entryId} /> : <p role="status">{error ?? '宿主尚未提供可编辑配置入口'}</p>}</div>;
}

export const inject = ['slots', 'sessions', 'uiSession', 'uiConversation', 'remote', 'configForms', 'uiWorkspace', 'typert', 'theme'];
export async function apply(ctx: Context): Promise<void> {
  // The generated namespace is created by this mount, so making it an
  // outer dependency would prevent apply from ever mounting its own service.
  // Cordis authorizes Remote namespaces separately from their parent service;
  // every UI/source callback must capture this injected child context.
  await ctx.remote.$mount(TYPERT_REMOTE);
  await ctx.inject(['remote.flowDashboard', 'remote.settings', 'remote.session'], registerNativeSurfaces);
}
function registerNativeSurfaces(ctx: Context): void {
  const source = registerObserverSource(ctx), viewStores = new Map<string, ReturnType<typeof createDashboardViewStore>>();
  const style = document.createElement('style'); style.dataset.dshFlowNative = ''; style.textContent = nativeStyles; document.head.append(style);
  ctx.effect(() => () => { style.remove(); viewStores.clear(); }, 'dsh-flow: native styles');
  ctx.slots.registerFactory({ name: 'dsh-flow.surface', scope: 'root', children: { 'dsh-flow.transcript': { kind: 'single', scope: 'session' } } }, props => <NativeSurface {...props} ctx={ctx} source={source} viewStores={viewStores} />);
  ctx.slots.inject('dsh-flow.transcript', () => ctx.slots.register({ name: 'dsh-flow.transcript' }, props => props.renderFactorySlot('chat.transcript', { readOnly: true })));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-flow' }, props => props.renderFactorySlot('dsh-flow.surface', { mode: 'dashboard' })));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-flow', label: '智能体', order: 35 }, () => <Icon name="group" size={20} />));
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'dsh-flow', label: '智能体', order: 35 }, SessionView));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dsh-flow', order: 35 }, props => props.renderFactorySlot('dsh-flow.surface', { mode: 'header', callerSessionId: props.sessionId, openView: props.openView })));
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-flow#dsh-flow' }, props => props.view === 'summary' ? '长期智能体团队、执行容量与服务连接' : <NativeSettings ctx={ctx} />));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-flow' }, () => <NativeSettings ctx={ctx} />));
}

export const nativeStyles = `
.flow-native-surface{height:100%;min-height:0}.flow-native-surface.is-header{height:auto}.flow-native-surface[data-theme=dark]{--background-color:#1c1c1f;--flow-bg:#1c1c1f;color:#d2d5dc}.flow-native-surface[data-theme=dark] .flow-native-team-trigger{background:#30333a;color:#d2d5dc}.flow-native-surface[data-theme=dark] .flow-native-team-menu,.flow-native-surface[data-theme=dark] .flow-native-header-observer{border-color:#393d45}.flow-native-surface[data-theme=dark] button{color:inherit}
.flow-native-header-observer.flow-dashboard{position:fixed;height:auto;min-height:0;width:min(520px,calc(100vw - 24px))}.flow-native-team-menu.flow-dashboard{position:absolute;display:block;width:300px;height:auto;min-height:0;overflow:auto}.flow-native-settings-surface.flow-dashboard{display:block;height:auto;min-height:0;overflow:visible;background:transparent}.flow-native-observer{background:var(--flow-surface,#fff)}
.flow-settings-models{margin:16px 0}.flow-settings-models>label{display:flex;justify-content:space-between;font-size:12px}.flow-settings-models details{position:relative;border:1px solid var(--flow-border,#dde1e8);border-radius:6px;padding:7px;margin:6px 0}.flow-settings-models summary{cursor:pointer;min-height:20px}.flow-settings-models [role=listbox]{max-height:280px;overflow:auto;margin-top:8px}.flow-settings-models [role=group]>strong{display:block;padding:5px;font-size:11px;color:var(--flow-muted,#747c88)}.flow-settings-models [role=option]{display:flex;width:100%;justify-content:flex-start;gap:8px;text-align:left}.flow-settings-models [role=option] small{margin-left:auto;color:var(--flow-muted,#747c88)}.flow-settings-models [aria-selected=true]{background:var(--flow-hover,#eaf2ff)}
.flow-native-team-header{position:relative;font-size:13px}.flow-native-team-trigger{display:flex;align-items:center;gap:6px;height:28px;border:0;border-radius:6px;background:#f0f1f3;color:#515966;padding:0 8px}.flow-native-team-trigger[aria-expanded=true]>svg:last-child{transform:rotate(180deg);transition:transform 120ms}.flow-native-team-menu{position:absolute;right:0;top:32px;z-index:60;width:300px;max-height:480px;overflow:auto;background:var(--background-color,#fff);border:1px solid #e1e4e8;border-radius:10px;box-shadow:0 8px 30px #0002;padding:6px;animation:flow-native-menu 120ms ease}.flow-native-run-label{font-size:11px;color:#747e8c;padding:7px}.flow-native-member{display:flex;align-items:center}.flow-native-member>button:first-child{flex:1;display:flex;align-items:center;gap:8px;min-width:0;text-align:left;padding:5px;border:0;background:transparent}.flow-native-member>button:first-child>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;flex:1}.flow-native-observe-arrow{height:32px;width:32px;border:0;background:transparent;border-radius:5px}.flow-native-member button:hover,.flow-native-member button:focus-visible{background:#eaf2ff;outline:2px solid #4d8bef}.flow-native-header-observer{position:fixed;right:0;top:58px;bottom:0;z-index:55;width:min(520px,calc(100vw - 24px));background:var(--background-color,#fff);border-left:1px solid #dfe3e9;box-shadow:-10px 0 24px #0001;animation:flow-native-sidebar 220ms ease}.flow-native-observer{display:flex;flex-direction:column;min-width:0;height:100%;font-size:13px;background:var(--flow-surface,var(--background-color,#fff))}.flow-native-observer>header{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid #e6e9ed}.flow-native-observer>header select{min-width:0;flex:1;background:transparent;border:1px solid #d8dde5;border-radius:5px;height:32px}.flow-native-observer>.flow-member-identity{padding:12px 16px}.flow-native-transcript{flex:1;min-height:0;overflow:hidden;position:relative}.flow-native-transcript>div[role=status],.flow-native-transcript>div[role=alert]{padding:20px}.flow-native-transcript>div{height:100%}.flow-native-settings{display:flex;font-size:13px;gap:24px;min-height:520px}.flow-native-settings>nav{display:flex;flex-direction:column;gap:6px;min-width:140px}.flow-native-settings>nav button{text-align:left;border:0;padding:8px;background:transparent;border-radius:6px}.flow-native-settings>nav button[aria-current]{background:#eaf2ff;color:#2769ce}.flow-native-settings>div{flex:1;min-width:0}.flow-native-settings h2{font-size:16px}.flow-native-settings fieldset{border:0;margin:0;padding:0}.flow-settings-field{margin:15px 0}.flow-settings-field>label{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px}.flow-settings-field label span{color:#7d8795;font-size:11px}.flow-settings-field>div{display:flex;gap:6px}.flow-settings-field input,.flow-settings-field select,.flow-settings-field textarea{flex:1;min-width:0;border:1px solid #d9dee7;border-radius:5px;font:inherit;padding:6px 8px;height:34px;background:transparent}.flow-settings-field textarea{height:90px}.flow-settings-field.dirty input,.flow-settings-field.dirty textarea,.flow-settings-field.dirty select{border-color:#4d8bef}.flow-settings-field small{display:block;color:#7d8795;margin-top:3px}.flow-settings-field [aria-invalid=true]{border-color:#cc4545}.flow-native-settings footer{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;background:var(--background-color,#fff);border-top:1px solid #e4e8ed;padding:12px 0;margin-top:22px}.flow-native-settings footer>span{flex:1}.flow-native-settings button{min-height:32px}.flow-native-settings .flow-primary{background:#3578e5;color:#fff;border:0;border-radius:5px;padding:0 14px}.flow-native-settings button:disabled{opacity:.45}.flow-native-settings button:focus-visible,.flow-native-team-trigger:focus-visible{outline:2px solid #4d8bef;outline-offset:2px}@keyframes flow-native-menu{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}@keyframes flow-native-sidebar{from{transform:translateX(100%)}to{transform:translateX(0)}}@media(prefers-reduced-motion:reduce){.flow-native-team-menu,.flow-native-header-observer{animation:none}.flow-native-team-trigger>svg{transition:none}}`;
