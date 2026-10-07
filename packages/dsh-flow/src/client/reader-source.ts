/** Observation-only session retention for native conversation readers. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import { SessionId } from '@deepseek-ai/dsh-session/types';

export interface ReaderSnapshot { readonly reference: SessionReference | null; readonly loading: boolean; readonly older: boolean; readonly error: string | null }
export interface ReaderSource {
  getSnapshot(): ReaderSnapshot
  subscribe(listener: () => void): () => void
  retry(): void
  dispose(): void
}
/** Retention owns only observation; it never resumes, sends to, or drives the child Agent. */
export function createReader(ctx: Context, id: string): ReaderSource {
  let value: ReaderSnapshot = { reference: null, loading: true, older: false, error: null };
  const listeners = new Set<() => void>();
  let reference: SessionReference | null = null, binding: SessionBinding | null = null;
  let generation = 0, disposed = false;
  const sessionId = SessionId(id);
  const initiallyUnlisted = !ctx.sessions.list.getSnapshot().ids.includes(sessionId);
  let retriedAfterCreation = false, retryQueued = false, initialOpenFailed = false;
  const stops: (() => void)[] = [];
  const publish = (next: ReaderSnapshot) => { value = next; for (const listener of listeners) listener(); };
  const close = () => { for (const stop of stops.splice(0)) stop(); reference?.release(); reference = null; binding = null; };
  // A team can publish the preallocated id before its native Session exists.
  // Host catalog membership (not retained fallback rows) marks actual creation.
  const retryAfterCreation = () => {
    if (disposed || !initiallyUnlisted || retriedAfterCreation || retryQueued || !initialOpenFailed || !ctx.sessions.list.getSnapshot().ids.includes(sessionId)) return;
    retryQueued = true;
    queueMicrotask(() => {
      retryQueued = false;
      if (disposed || !initialOpenFailed) return;
      retriedAfterCreation = true;
      void open();
    });
  };
  const open = async () => {
    const attempt = ++generation; initialOpenFailed = false; close(); publish({ ...value, reference: null, loading: true, error: null });
    try {
      const held = ctx.sessions.retain(sessionId, { source: 'dshFlowReader', allowUnlisted:true, observationOnly:true });
      reference = held;
      const current = await held.ready;
      if (attempt !== generation || disposed) return;
      binding = current;
      const chat = ctx.uiConversation.binding(current).target('chat');
      const update = () => {
        const lifecycle=current.session.getSnapshot();
        initialOpenFailed = lifecycle.openState === 'error' && !lifecycle.removed;
        publish({reference:lifecycle.openState==='open'&&!lifecycle.removed?held:null,loading:lifecycle.openState==='loading'||lifecycle.loadingOlder,older:lifecycle.hasMore,error:lifecycle.removed?'此会话已不可用':lifecycle.openState==='error'?'暂时无法读取对话':lifecycle.historyError?'暂时无法读取更早的消息':null});
        if (lifecycle.openState === 'error' && !lifecycle.removed) retryAfterCreation();
      };
      // Activate the provider target and let native Chat own transcript updates.
      stops.push(chat.subscribe(() => {}), current.session.subscribe(update));
      update();
    } catch (error) { if (attempt === generation && !disposed) {initialOpenFailed = true;close(); publish({ ...value, loading: false, error: '暂时无法读取对话' });retryAfterCreation();} }
  };
  const stopCatalog = ctx.sessions.list.subscribe(retryAfterCreation);
  void open();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    retry() {
      if(binding?.session.getSnapshot().historyError) void binding.session.loadOlder().catch(()=>{});
      else void open();
    },
    dispose() { disposed = true; generation++; stopCatalog(); close(); value = {...value, reference:null}; listeners.clear(); },
  };
}
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { dshFlowReader: unknown } }
