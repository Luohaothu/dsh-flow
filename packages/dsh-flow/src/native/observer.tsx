import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ReadonlySessionTarget, ReadonlySourceRegistration, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import { AgentStatusBadge, Icon, MemberIdentity } from '../ui/icons.js';
import type { ObservationTarget, ObserverRenderProps } from '../ui/types.js';
import type { FlowNativeTarget } from './protocol.js';
import './typert.remote-client.js';

declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { flowObserver: unknown } }

export function nativeTarget(target: ReadonlySessionTarget): FlowNativeTarget {
  const value = target.locator;
  if (!value || typeof value !== 'object' || !('runId' in value) || !('instanceId' in value) || !('sessionId' in value)
    || typeof value.runId !== 'string' || typeof value.instanceId !== 'string' || value.sessionId !== target.sessionId
    || target.bindingKey !== `${value.runId}/${value.instanceId}`) throw new Error('观察目标身份不完整');
  return { runId: value.runId, instanceId: value.instanceId, sessionId: target.sessionId };
}

export function registerObserverSource(ctx: Context): ReadonlySourceRegistration {
  const registration = ctx.sessions.registerReadonlySource('dsh-flow', {
    async *follow(target, request, signal) {
      const stream = ctx.remote.flowDashboard.followNativeSession({ target: nativeTarget(target), request }, signal);
      try { for await (const frame of stream) { signal.throwIfAborted(); yield frame; } }
      finally { stream.dispose(); }
    },
    async page(target, epoch, request, signal) {
      const result = await ctx.remote.flowDashboard.pageNativeSession({ target: nativeTarget(target), epoch, request }, signal);
      signal.throwIfAborted(); if (!result.ok) throw result.error; return result.value;
    },
    async attachment(target, epoch, attachmentId, signal) {
      const result = await ctx.remote.flowDashboard.readNativeAttachment({ target: nativeTarget(target), epoch, attachmentId }, signal);
      signal.throwIfAborted(); if (!result.ok) throw result.error; return result.value;
    },
  });
  ctx.effect(() => () => registration[Symbol.dispose](), 'dsh-flow: readonly source');
  return registration;
}

export function retainObserver(source: ReadonlySourceRegistration, target: ObservationTarget, signal: AbortSignal): SessionReference {
  return source.retain({ bindingKey: `${target.runId}/${target.instanceId}`, sessionId: target.sessionId as SessionId,
    locator: { ...target } }, { source: 'flowObserver', signal });
}

export interface ObserverHost { source: ReadonlySourceRegistration; SessionProvider: SessionProviderComponent; renderTranscript(): ReactNode }
type ReaderState = { kind: 'loading' } | { kind: 'ready'; reference: SessionReference; identity: string } | { kind: 'failed'; reason: string };
export function observationError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const code = 'code' in error && typeof error.code === 'string' ? `${error.code}：` : '';
    return code + error.message;
  }
  return String(error);
}

export function FlowObserver({ target, member, members, onSelect, onClose, source, SessionProvider, renderTranscript }: ObserverRenderProps & ObserverHost) {
  const [state, setState] = useState<ReaderState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const attempt = ++generation.current, controller = new AbortController();
    let reference: SessionReference | undefined;
    setState({ kind: 'loading' });
    try {
      reference = retainObserver(source, target, controller.signal);
      const current = reference;
      void current.ready.then(() => {
        if (controller.signal.aborted || generation.current !== attempt) { current.release(); return; }
        setState({ kind: 'ready', reference: current, identity: `${target.runId}/${target.instanceId}` });
      }, error => {
        current.release();
        if (!controller.signal.aborted && generation.current === attempt) setState({ kind: 'failed', reason: observationError(error) });
      });
    } catch (error) { setState({ kind: 'failed', reason: observationError(error) }); }
    return () => { generation.current++; controller.abort(); reference?.release(); };
  }, [source, target.runId, target.instanceId, target.sessionId, retry]);
  const exact = state.kind === 'ready' && state.reference.sessionId === target.sessionId && state.identity === `${target.runId}/${target.instanceId}`;
  return <aside className="flow-native-observer" aria-label={`${member.name} 原生会话观察`} data-flow-observer={target.instanceId}>
    <header><select aria-label="切换观察成员" value={target.instanceId} onChange={event => {
      const node = members.find(candidate => candidate.id === event.target.value);
      if (node) onSelect({ runId: target.runId, instanceId: node.id, sessionId: node.sessionID });
    }}>{members.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
      <AgentStatusBadge node={member} /><button type="button" className="flow-icon-button" aria-label="关闭成员观察" onClick={onClose}><Icon name="close" size={16} /></button></header>
    <MemberIdentity node={member} />
    <div className="flow-native-transcript" role="region" aria-label="只读完整原生会话">
      {state.kind === 'failed' ? <div role="alert"><p>{state.reason}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试读取</button></div>
        : state.kind !== 'ready' || !exact ? <div role="status" aria-live="polite">正在加载成员记录…</div>
          : <SessionProvider session={state.reference}>{renderTranscript()}</SessionProvider>}
    </div>
  </aside>;
}
