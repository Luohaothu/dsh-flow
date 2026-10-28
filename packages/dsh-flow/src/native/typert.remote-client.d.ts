import type {
  RemoteResult,
  RemoteStreamHandle,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { FlowConnection, FlowNativeAttachmentInput, FlowNativeAttachmentValue, FlowNativeFollowInput, FlowNativeFrame, FlowNativePageInput, FlowNativePageValue } from 'dsh-flow/native/protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$666c6f7744617368626f617264 {
    connection: () => Promise<RemoteResult<FlowConnection>>
    followNativeSession: (input: FlowNativeFollowInput, signal?: AbortSignal) => RemoteStreamHandle<FlowNativeFrame, never>
    pageNativeSession: (input: FlowNativePageInput, signal?: AbortSignal) => Promise<RemoteResult<FlowNativePageValue>>
    readNativeAttachment: (input: FlowNativeAttachmentInput, signal?: AbortSignal) => Promise<RemoteResult<FlowNativeAttachmentValue>>
  }
  interface TypertRemoteMap {
    'flowDashboard/connection': () => Promise<RemoteResult<FlowConnection>>
    'flowDashboard/followNativeSession': (input: FlowNativeFollowInput, signal?: AbortSignal) => RemoteStreamHandle<FlowNativeFrame, never>
    'flowDashboard/pageNativeSession': (input: FlowNativePageInput, signal?: AbortSignal) => Promise<RemoteResult<FlowNativePageValue>>
    'flowDashboard/readNativeAttachment': (input: FlowNativeAttachmentInput, signal?: AbortSignal) => Promise<RemoteResult<FlowNativeAttachmentValue>>
  }
  interface TypertRemoteNamespaceMap {
    'flowDashboard': TypertRemoteNamespace$666c6f7744617368626f617264
  }
}

export declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
