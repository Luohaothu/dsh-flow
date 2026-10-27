import type { AgentCard, GroupView, MessageSourceView, MessageView, RunInfo, UsageView } from '../dashboard/protocol.js';
import type { DashboardScope } from './types.js';

export function scopedRuns(runs: readonly RunInfo[], scope: DashboardScope): RunInfo[] {
  return runs.filter(run => scope.kind === 'global' || run.entry.callerSessionId === scope.callerSessionId).sort((a, b) => b.startedAt - a.startedAt);
}
export function defaultRun(runs: readonly RunInfo[]): RunInfo | undefined { return runs.find(run => run.status === 'active') ?? runs.find(run => run.status !== 'invalid') ?? runs[0]; }
export function orderedNodes(nodes: readonly AgentCard[], order: Map<string, number>): AgentCard[] {
  for (const node of nodes) if (!order.has(node.id)) order.set(node.id, order.size);
  return [...nodes].sort((a, b) => a.createdAt - b.createdAt || order.get(a.id)! - order.get(b.id)!);
}
export function treeIndex(nodes: readonly AgentCard[]): { byId: Map<string, AgentCard>; children: Map<string | null, AgentCard[]> } {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string | null, AgentCard[]>();
  for (const node of nodes) { const parent = node.parentId !== null && byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null; const list = children.get(parent) ?? []; list.push(node); children.set(parent, list); }
  return { byId, children };
}
export function descendants(id: string, nodes: readonly AgentCard[]): AgentCard[] {
  const { children } = treeIndex(nodes), result: AgentCard[] = [], seen = new Set([id]);
  const visit = (parent: string) => { for (const child of children.get(parent) ?? []) { if (seen.has(child.id)) continue; seen.add(child.id); result.push(child); visit(child.id); } }; visit(id); return result;
}
export function ancestors(id: string, nodes: readonly AgentCard[]): string[] {
  const byId = new Map(nodes.map(node => [node.id, node])), result: string[] = [], seen = new Set([id]); let node = byId.get(id);
  while (node?.parentId && byId.has(node.parentId) && !seen.has(node.parentId)) { seen.add(node.parentId); result.push(node.parentId); node = byId.get(node.parentId); } return result;
}
export interface VisibleNode { node: AgentCard; depth: number; parentId: string | null; branchId: string }
export function visibleTree(nodes: readonly AgentCard[], collapsed: ReadonlySet<string>): VisibleNode[] {
  const { children } = treeIndex(nodes), result: VisibleNode[] = [], seen = new Set<string>();
  const visit = (node: AgentCard, depth: number, parentId: string | null, branchId: string) => {
    if (seen.has(node.id)) return; seen.add(node.id); result.push({ node, depth, parentId, branchId });
    if (!collapsed.has(node.id)) for (const child of children.get(node.id) ?? []) visit(child, depth + 1, node.id, depth === 0 ? child.id : branchId);
  };
  for (const root of children.get(null) ?? []) visit(root, 0, null, root.id);
  for (const node of nodes) if (!seen.has(node.id) && !ancestors(node.id, nodes).some(id => collapsed.has(id))) visit(node, 0, null, node.id);
  return result;
}
export function visibleAncestor(id: string, visible: ReadonlySet<string>, nodes: readonly AgentCard[]): string | undefined { return [id, ...ancestors(id, nodes)].find(candidate => visible.has(candidate)); }
export function sourceName(source: MessageSourceView): string { return source.kind === 'agent' || source.kind === 'group' ? source.name : source.kind === 'user' ? 'User' : 'System'; }
export function sortMailbox(messages: readonly MessageView[]): MessageView[] { return messages.map((message, index) => ({ message, index })).sort((a, b) => b.message.timestamp - a.message.timestamp || a.index - b.index).map(item => item.message); }
export const runStatus: Record<RunInfo['status'], string> = { starting: '创建中', active: '活跃', stopping: '解散中', stopped: '已解散', failed: '失败', invalid: '已失效' };
export function statusLabel(node: AgentCard): string {
  if (node.status !== 'terminated') return ({ running: '运行中', waiting: '等待中', idle: '空闲' })[node.status];
  return node.outcome === 'completed' ? '完成' : node.outcome === 'failed' ? '失败' : '已停止';
}
export function statusKind(node: AgentCard): string { return node.status === 'terminated' ? node.outcome ?? 'stopped' : node.status; }
export const cleanupLabel: Record<NonNullable<AgentCard['cleanup']>['phase'], string> = { pending: '收尾中', waiting: '收尾中', releasing: '强制清理', complete: '清理完成', failed: '清理失败', abandoned: '已放弃清理' };
export interface UsageTotals { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; total: number | null; amounts: { currency: string; amount: number }[]; amountAvailable: boolean; calls: UsageView[] }
export function usageTotals(nodes: readonly AgentCard[]): UsageTotals {
  const calls: UsageView[] = [];
  for (const node of nodes) { const latest = new Map<string, UsageView>(); for (const call of node.usage) latest.set(call.callId, call); calls.push(...latest.values()); }
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens'): number | null => !calls.length || calls.some(call => call[key] === undefined) ? null : calls.reduce((value, call) => value + call[key]!, 0);
  const amounts = new Map<string, number>();
  for (const call of calls) if (call.amount !== null && call.currency !== null) amounts.set(call.currency, (amounts.get(call.currency) ?? 0) + call.amount);
  return { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadTokens'), cacheWrite: sum('cacheWriteTokens'), total: sum('totalTokens'), amounts: [...amounts].map(([currency, amount]) => ({ currency, amount })), amountAvailable: calls.length > 0 && calls.every(call => call.amount !== null && call.currency !== null), calls };
}
export function formatTokens(value: number | null): string { return value === null ? '—' : value >= 1000 ? `${Number((value / 1000).toFixed(2))}k` : value.toLocaleString('zh-CN'); }
export function formatDuration(createdAt: number, terminatedAt: number | null, now: number): string { const value = Math.max(0, Math.floor(((terminatedAt ?? now) - createdAt) / 1000)); return value < 60 ? `${value}s` : value < 3600 ? `${Math.floor(value / 60)}m${String(value % 60).padStart(2, '0')}s` : `${Math.floor(value / 3600)}h${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}m${String(value % 60).padStart(2, '0')}s`; }
export function formatTime(value: number): string { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
export function groupMembers(group: GroupView, nodes: readonly AgentCard[]): AgentCard[] { const ids = new Set(group.members); return nodes.filter(node => ids.has(node.id)); }
