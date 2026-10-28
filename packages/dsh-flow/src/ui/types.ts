import type { ReactNode } from 'react';
import type { DashboardClient } from '../dashboard/client.js';
import type { AgentCard } from '../dashboard/protocol.js';
import type { DashboardViewStore } from './view-state.js';

export type DashboardScope = { kind: 'global' } | { kind: 'session'; callerSessionId: string };
export interface ObservationTarget { runId: string; instanceId: string; sessionId: string }
export interface DashboardFocus { requestId: string; runId: string; instanceId?: string; observe?: boolean }
export interface ObserverRenderProps {
  target: ObservationTarget;
  member: AgentCard;
  members: readonly AgentCard[];
  onSelect(target: ObservationTarget): void;
  onClose(): void;
}
export interface NativeActions {
  returnToSession?(callerSessionId: string): void;
  renderObserver?(props: ObserverRenderProps): ReactNode;
}
export interface DashboardAppProps {
  client: DashboardClient;
  scope: DashboardScope;
  viewStore?: DashboardViewStore;
  focus?: DashboardFocus;
  onFocusConsumed?(requestId: string): void;
  nativeActions?: NativeActions;
  theme?: 'system' | 'light' | 'dark';
}
export interface Viewport { x: number; y: number; scale: number }
export type DetailTab = 'overview' | 'inbox' | 'usage';
export interface RunViewState {
  selectedId: string | null;
  groupId: string | null;
  detailOpen: boolean;
  collapsed: readonly string[];
  tab: DetailTab;
  viewport: Viewport;
  mode: 'tree' | 'list';
}
