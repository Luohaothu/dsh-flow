import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { AttachmentId as AttachmentIdType } from '@deepseek-ai/dsh-attachment/types';
import type { SessionAttachmentValue, SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest, SessionProjectionBaseline, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { PriceTable, ProtocolVersion } from '../dashboard/protocol.js';

export interface FlowNativeTarget { readonly runId: string; readonly instanceId: string; readonly sessionId: SessionId }
export type FlowNativeFrame =
  | { readonly epoch: string; readonly kind: 'journal'; readonly frame: SessionFollowFrame }
  | { readonly epoch: string; readonly kind: 'state'; readonly summary: SessionSummary; readonly projections: SessionProjectionBaseline };
/** Validated JSON view of the DSH configuration; host extras have the supported DSH shape. */
export interface FlowConfigurationValue {
  stateDirectory: string;
  defaults: { model?: { provider: string; id: string }; params?: { version: 1; reasoningEffort?: string; temperature?: number; maxTokens?: number }; permission?: 'read-only' | 'workspace-write' | 'full-access'; hostExtras?: { dsh?: { stop?: string[] } }; preset?: string; skills?: string[] };
  cwd?: string; rootRole?: string; patternSources: string[]; maxConcurrentAgents: number;
  cleanup: { gracefulTimeoutMs: number; immediateTimeoutMs: number };
  connection: { port?: number; staticDirectory?: string; allowedOrigins?: string[]; prices?: PriceTable };
}
export interface FlowConfigurationStatus {
  readonly entryId?: string;
  readonly effective: FlowConfigurationValue;
  readonly requested: FlowConfigurationValue;
  readonly restartRequired: readonly string[];
  readonly catalog: { readonly patterns: readonly { readonly id: string; readonly description: string }[]; readonly diagnostics: readonly { readonly path: string; readonly message: string }[] };
  readonly application: { readonly revision: number; readonly status: 'applied' | 'failed'; readonly error?: { readonly message: string } };
}
export interface FlowConnection { readonly address: string; readonly epoch: string; readonly version: ProtocolVersion; readonly configuration: FlowConfigurationStatus }
export interface FlowNativeFollowInput { readonly target: FlowNativeTarget; readonly request: Omit<SessionFollowRequest, 'address'> }
export interface FlowNativePageInput { readonly target: FlowNativeTarget; readonly epoch: string; readonly request: Omit<SessionPageRequest, 'address'> }
export interface FlowNativeAttachmentInput { readonly target: FlowNativeTarget; readonly epoch: string; readonly attachmentId: AttachmentIdType }
export interface FlowNativePageValue extends SessionPage {}
export interface FlowNativeAttachmentValue extends SessionAttachmentValue {}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'flow/native-unavailable': { readonly reason: string; readonly phase: string };
    'flow/native-epoch': { readonly epoch: string };
  }
}
