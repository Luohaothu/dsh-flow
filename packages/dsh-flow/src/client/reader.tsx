/** Observe a native Session through the official scoped Chat view. */
import { useSyncExternalStore } from 'react';
import type { FactoryComponentPropsOf, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

export { createReader } from './reader-source.ts';
export type { ReaderSnapshot, ReaderSource } from './reader-source.ts';
import type { ReaderSource } from './reader-source.ts';

export interface ReaderProps {
  source: ReaderSource;
  agentId: string;
  follow: boolean;
  /** Main inherits the host width axis; inspector panels fit their own container. */
  variant: 'main' | 'embedded';
  openFull?: (() => void) | undefined;
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'dsh-flow.reader': {
      scope: 'root';
      props: ReaderProps;
      children: { 'dsh-flow.reader.session': {kind:'single';scope:'session'} };
    };
  }
  interface SlotMap {
    'dsh-flow.reader.session': {kind:'single';scope:'session';owner:{follow:boolean;variant:ReaderProps['variant']}};
  }
}

/** Native content mounted under the retained observation reference's Session scope. */
export function NativeReadOnlyTranscript({ renderFactorySlot, follow, variant }: PropsRuntime<'dsh-flow.reader.session'> & PropsRenderFactories) {
  return renderFactorySlot('conversation.content', {
    variant, phase: 'active', hero: false,
    readOnly: true, initialFollow: follow,
  });
}

/** The native view owns grouping, disclosure, locale, paging and reading position. */
export function ReadOnlyConversation({ source, agentId, follow, variant, openFull, SessionProvider, renderSlot }: FactoryComponentPropsOf<'dsh-flow.reader'>) {
  const data = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return <section className="flow-reader" aria-label="只读对话" data-agent-id={agentId}>
    {data.loading && <p role="status">正在加载对话…</p>}
    {data.error && <p role="status">{data.error} <Button onClick={() => source.retry()}>重试此区域</Button></p>}
    {data.reference && <SessionProvider session={data.reference}>
      {renderSlot('dsh-flow.reader.session', {follow,variant})}
    </SessionProvider>}
    {openFull && <div className="flow-reader-actions"><Button onClick={openFull}>打开完整会话</Button></div>}
  </section>;
}
