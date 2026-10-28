import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentCard as Card, RunSnapshot } from '../dashboard/protocol.js';
import { cleanupLabel, descendants, formatDuration, formatTime, formatTokens, statusLabel, usageTotals } from './derive.js';
import { AgentStatusBadge, Icon, ModelMark } from './icons.js';

export interface AgentCardProps {
  node: Card; snapshot: RunSnapshot; collapsed: boolean; now: number;
  onToggle(): void; onMarkers(): void;
}
const permissionNames = { 'read-only': '只读', 'workspace-write': '工作区写入', 'full-access': '完全访问' };
export function AgentCard({ node, snapshot, collapsed, now, onToggle, onMarkers }: AgentCardProps) {
  const hidden = descendants(node.id, snapshot.nodes), branch = collapsed ? [node, ...hidden] : [node], usage = usageTotals(branch);
  const directCount = snapshot.nodes.filter(item => item.parentId === node.id).length;
  const jobs = snapshot.assignments.filter(job => node.assignmentIds.includes(job.id)), pending = jobs.filter(job => job.status === 'pending').length;
  const markers = branch.flatMap(item => item.markers.map(marker => ({ ...marker, message: `${item.name}：${marker.message}` })));
  const latestTime = Math.max(0, ...node.markers.map(marker => marker.timestamp));
  const waiting = node.waiting ? Math.max(0, Math.ceil((node.waiting.deadline - now) / 1000)) : 0;
  const writes = node.status === 'terminated' ? [] : node.blackboardWrites;
  const [visibleWrites, setVisibleWrites] = useState(writes);
  const nameMeasure = useRef<HTMLSpanElement>(null), badgeMeasure = useRef<HTMLSpanElement>(null), [badgeOnModel, setBadgeOnModel] = useState(collapsed), [badgeWidth, setBadgeWidth] = useState(24);
  const displayName = `${node.name}${collapsed && hidden.length > 0 ? ` · +${hidden.length} 子代理` : ''}`;
  useLayoutEffect(() => { const measure = () => { const width = badgeMeasure.current?.offsetWidth ?? 24; setBadgeWidth(width); setBadgeOnModel(collapsed || (nameMeasure.current?.offsetWidth ?? 0) + width + 8 > 166); }; measure(); const observer = new ResizeObserver(measure); if (nameMeasure.current) observer.observe(nameMeasure.current); if (badgeMeasure.current) observer.observe(badgeMeasure.current); return () => observer.disconnect(); }, [displayName, collapsed]);
  useEffect(() => { if (writes.length) { setVisibleWrites(writes); return; } const timer = setTimeout(() => setVisibleWrites([]), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180); return () => clearTimeout(timer); }, [node.blackboardWrites, node.status]);
  return <>
    <span aria-hidden="true" className="flow-name-measure" ref={nameMeasure}>{displayName}</span>
    <div className="flow-card-identity"><ModelMark model={node.model} size={22} /><div className="flow-card-name" style={{ paddingRight: badgeOnModel ? 0 : badgeWidth + 8 }}><span title={node.name} className={collapsed ? 'flow-folded-name' : ''}>{displayName}</span></div></div>
    <div className={`flow-card-model ${badgeOnModel ? 'badge-on-model' : ''}`} title={`${node.model.provider} / ${node.model.id}`}><ModelMark model={node.model} /><span>{node.model.id}</span><span ref={badgeMeasure} className="flow-badge-anchor"><AgentStatusBadge node={node} markers={markers} onMarkers={onMarkers} /></span></div>
    <div className="flow-card-task" title={node.task}>{node.task || node.role}</div>
    {collapsed && <div className="flow-card-extra" title="分支运行与等待数量"><Icon name="running" />{branch.filter(item => item.status === 'running').length}<Icon name="waiting" />{branch.filter(item => item.status === 'waiting').length}</div>}
    {node.waiting && <div className="flow-card-extra flow-wait" title={`等待目标：${node.waiting.target}`}><Icon name="waiting" /><span>{node.waiting.target} · {waiting > 0 ? `${waiting}s` : '等待后端更新'}</span></div>}
    {jobs.length > 0 && <details className="flow-card-jobs" onClick={event => event.stopPropagation()}><summary title={`作业 ${jobs.length} 份，未结束 ${pending} 份`}><Icon name="assignment" /><span>{jobs[0]!.spec.name}{jobs.length > 1 ? ` 等 ${jobs.length} 份` : ''}</span><span>{pending}</span></summary><ul>{jobs.map(job => <li key={job.id}>{job.spec.name} · {job.status === 'pending' ? '进行中' : job.status === 'submitted' ? '已提交' : job.status === 'failed' ? '失败' : '已取消'} <span title="提交次数">↻{job.submissionCount}</span></li>)}</ul></details>}
    <div className="flow-card-extra" title={`初始权限：${permissionNames[node.permission]}`}><Icon name="permission" /><span>{permissionNames[node.permission]}</span></div>
    {node.cleanup && <div className="flow-card-extra" title={node.cleanup.reason}><Icon name="cleanup" /><span>{cleanupLabel[node.cleanup.phase]}</span></div>}
    <div className="flow-card-metrics"><span title={`输入 token：${usage.input ?? '不可用'}`} aria-label={`输入 token ${usage.input ?? '不可用'}`}>▲ {formatTokens(usage.input)}</span><span title={`输出 token：${usage.output ?? '不可用'}`} aria-label={`输出 token ${usage.output ?? '不可用'}`}>▼ {formatTokens(usage.output)}</span><span title="运行时长">{formatDuration(node.createdAt, node.terminatedAt, now)}</span></div>
    {(latestTime > 0 || directCount > 0) && <div className="flow-card-footer">{latestTime > 0 && <span title="最近事件时间"><Icon name="history" />{formatTime(latestTime)}</span>}{directCount > 0 && <button type="button" className="flow-collapse" aria-label={`${collapsed ? '展开' : '折叠'} ${node.name} 的 ${directCount} 个直接子代理`} aria-expanded={!collapsed} onClick={event => { event.stopPropagation(); onToggle(); }}>{directCount}<Icon name={collapsed ? 'right' : 'down'} /></button>}</div>}
    {visibleWrites.length > 0 && <span className={`flow-blackboard-bubble ${!writes.length ? 'is-ending' : ''}`} title={visibleWrites.map(write => `正在写入群 ${write.groupId} 的黑板`).join('；')} aria-label={visibleWrites.map(write => `正在写入群 ${write.groupId} 的黑板`).join('；')}><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="15" rx="1" fill="#976638" /><rect x="4" y="5" width="16" height="11" fill="#37754a" /><path d="M7 9h7m-7 3h10M8 18l-2 4m10-4 2 4" stroke="#fff" strokeWidth="1.3" /><path d="M8 18l-2 4m10-4 2 4" stroke="#976638" strokeWidth="2" /></svg><span className="flow-sr">{statusLabel(node)}</span></span>}
  </>;
}
